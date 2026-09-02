import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, ToolResult } from "@aaa-agent/runtime";
import { z } from "zod/v4";
import checkDescription from "./prompts/tools/check.md" with { type: "text" };
import editDescription from "./prompts/tools/edit.md" with { type: "text" };
import globDescription from "./prompts/tools/glob.md" with { type: "text" };
import readDescription from "./prompts/tools/read.md" with { type: "text" };
import searchDescription from "./prompts/tools/search.md" with { type: "text" };
import shellDescription from "./prompts/tools/shell.md" with { type: "text" };
import writeDescription from "./prompts/tools/write.md" with { type: "text" };

// Keep replay cheap; callers can issue narrower read/search commands for more.
// Shell still preserves head+tail and exact omitted-byte metadata.
const MAX_TOOL_OUTPUT = 16_000;
const MAX_LINE_LENGTH = 2_000;
const MAX_SHELL_STREAM_CAPTURE = 7_500;
const MAX_SEARCH_FILE_BYTES = 1_048_576;
const MAX_SEARCH_PATTERN_LENGTH = 512;
const IGNORED_SEARCH_SEGMENTS: Record<string, true> = {
	".git": true,
	node_modules: true,
	dist: true,
	build: true,
	".next": true,
	target: true,
	vendor: true,
	coverage: true,
};

function isIgnoredSearchPath(file: string): boolean {
	return file.split(/[\\/]/).some(segment => IGNORED_SEARCH_SEGMENTS[segment] === true);
}

function normalizeToolPath(file: string): string {
	return file.replaceAll("\\", "/");
}

interface RegexGroupState {
	hasAlternation: boolean;
	hasQuantifier: boolean;
}

function quantifierLength(pattern: string, index: number): number {
	const character = pattern[index];
	if (character === "*" || character === "+" || character === "?") return 1;
	if (character !== "{") return 0;
	const close = pattern.indexOf("}", index + 1);
	if (close < 0) return 0;
	return /^\{\d+(?:,\d*)?\}$/.test(pattern.slice(index, close + 1)) ? close - index + 1 : 0;
}

/**
 * JavaScript RegExp has no execution timeout. Reject constructs with common
 * exponential-backtracking shapes before they ever see workspace content.
 * This is intentionally conservative: callers can split a complex expression
 * into multiple safe searches instead of risking an uninterruptible tool call.
 */
function assertSafeSearchPattern(pattern: string): void {
	if (pattern.length > MAX_SEARCH_PATTERN_LENGTH) {
		throw new Error(`Search pattern exceeds ${MAX_SEARCH_PATTERN_LENGTH} characters.`);
	}
	const groups: RegexGroupState[] = [{ hasAlternation: false, hasQuantifier: false }];
	let escaped = false;
	let inCharacterClass = false;
	let unboundedWildcards = 0;
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index] ?? "";
		if (escaped) {
			if (!inCharacterClass && /[1-9]/.test(character)) {
				throw new Error("Unsafe search pattern: backreferences are not allowed.");
			}
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "[" && !inCharacterClass) {
			inCharacterClass = true;
			continue;
		}
		if (character === "]" && inCharacterClass) {
			inCharacterClass = false;
			continue;
		}
		if (inCharacterClass) continue;
		if (character === "(") {
			groups.push({ hasAlternation: false, hasQuantifier: false });
			continue;
		}
		if (character === "|") {
			groups.at(-1)!.hasAlternation = true;
			continue;
		}
		if (character === ")" && groups.length > 1) {
			const group = groups.pop()!;
			const quantified = quantifierLength(pattern, index + 1) > 0;
			if (quantified && (group.hasQuantifier || group.hasAlternation)) {
				throw new Error("Unsafe search pattern: nested or ambiguous repetition is not allowed.");
			}
			if (quantified) groups.at(-1)!.hasQuantifier = true;
			continue;
		}
		const length = quantifierLength(pattern, index);
		if (length > 0) {
			// `?` immediately after `(` starts a lookaround/non-capturing group.
			if (!(character === "?" && pattern[index - 1] === "(")) groups.at(-1)!.hasQuantifier = true;
			if ((character === "*" || character === "+") && pattern[index - 1] === ".") unboundedWildcards += 1;
			index += length - 1;
		}
	}
	if (unboundedWildcards > 1) {
		throw new Error("Unsafe search pattern: multiple unbounded wildcards are not allowed.");
	}
}

async function isSearchableFile(root: string, file: string): Promise<boolean> {
	if (isIgnoredSearchPath(file)) return false;
	try {
		const handle = await fs.open(path.join(root, file), "r");
		try {
			const stat = await handle.stat();
			if (stat.size > MAX_SEARCH_FILE_BYTES) return false;
			const sample = Buffer.alloc(Math.min(8_192, stat.size));
			const { bytesRead } = await handle.read(sample, 0, sample.byteLength, 0);
			return !sample.subarray(0, bytesRead).includes(0);
		} finally {
			await handle.close();
		}
	} catch {
		return false;
	}
}

const SAFE_ENVIRONMENT_KEYS = new Set([
	"APPDATA",
	"BUN_INSTALL",
	"CI",
	"COLORTERM",
	"COMSPEC",
	"ComSpec",
	"FORCE_COLOR",
	"HOME",
	"LANG",
	"LANGUAGE",
	"LOCALAPPDATA",
	"LOGNAME",
	"NO_COLOR",
	"PATH",
	"PATHEXT",
	"Path",
	"SHELL",
	"SYSTEMROOT",
	"SystemRoot",
	"TEMP",
	"TERM",
	"TMP",
	"TMPDIR",
	"USER",
	"USERPROFILE",
	"WINDIR",
]);

function childProcessEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && (SAFE_ENVIRONMENT_KEYS.has(key) || key.startsWith("LC_"))) environment[key] = value;
	}
	return environment;
}

export interface VerificationCheck {
	id: string;
	command: string;
	argv: string[];
	discoveredRound?: number;
	primaryExitCode?: number;
	current?: boolean;
	mutationEpoch?: number;
}

class BoundedStreamCapture {
	readonly #head: Uint8Array;
	readonly #tail: Uint8Array;
	#headLength = 0;
	#tailLength = 0;
	#tailOffset = 0;
	totalBytes = 0;

	constructor(maxBytes: number) {
		const headBytes = Math.ceil(maxBytes / 2);
		this.#head = new Uint8Array(headBytes);
		this.#tail = new Uint8Array(maxBytes - headBytes);
	}

	get omittedBytes(): number {
		return this.totalBytes - this.#headLength - this.#tailLength;
	}

	append(chunk: Uint8Array): void {
		this.totalBytes += chunk.byteLength;
		let offset = 0;
		if (this.#headLength < this.#head.byteLength) {
			const length = Math.min(chunk.byteLength, this.#head.byteLength - this.#headLength);
			this.#head.set(chunk.subarray(0, length), this.#headLength);
			this.#headLength += length;
			offset = length;
		}

		const remaining = chunk.subarray(offset);
		if (remaining.byteLength === 0 || this.#tail.byteLength === 0) return;
		if (remaining.byteLength >= this.#tail.byteLength) {
			this.#tail.set(remaining.subarray(remaining.byteLength - this.#tail.byteLength));
			this.#tailLength = this.#tail.byteLength;
			this.#tailOffset = 0;
			return;
		}

		const firstLength = Math.min(remaining.byteLength, this.#tail.byteLength - this.#tailOffset);
		this.#tail.set(remaining.subarray(0, firstLength), this.#tailOffset);
		if (firstLength < remaining.byteLength) this.#tail.set(remaining.subarray(firstLength), 0);
		this.#tailOffset = (this.#tailOffset + remaining.byteLength) % this.#tail.byteLength;
		this.#tailLength = Math.min(this.#tail.byteLength, this.#tailLength + remaining.byteLength);
	}

	render(): string {
		const head = this.#head.subarray(0, this.#headLength);
		let tail = this.#tail.subarray(0, this.#tailLength);
		if (this.#tailLength === this.#tail.byteLength && this.#tailOffset !== 0) {
			tail = new Uint8Array(this.#tailLength);
			tail.set(this.#tail.subarray(this.#tailOffset));
			tail.set(this.#tail.subarray(0, this.#tailOffset), this.#tailLength - this.#tailOffset);
		}
		if (this.omittedBytes === 0) {
			const bytes = new Uint8Array(head.byteLength + tail.byteLength);
			bytes.set(head);
			bytes.set(tail, head.byteLength);
			return new TextDecoder().decode(bytes);
		}
		return `${new TextDecoder().decode(head)}\n… ${this.omittedBytes} bytes omitted …\n${new TextDecoder().decode(tail)}`;
	}
}

async function drainStream(stream: ReadableStream<Uint8Array>, capture: BoundedStreamCapture): Promise<void> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			capture.append(value);
		}
	} finally {
		reader.releaseLock();
	}
}

function textResult(text: string, details?: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text }], ...(details ? { details } : {}) };
}

async function runCapturedProcess(
	argv: string[],
	cwd: string,
	signal: AbortSignal,
	extraDetails: Record<string, unknown> = {},
): Promise<ToolResult> {
	const detached = process.platform !== "win32";
	const environment = childProcessEnvironment();
	const privateTemporaryDirectory =
		process.platform === "darwin" ? await fs.mkdtemp(path.join(os.tmpdir(), "aaa-shell-")) : undefined;
	if (privateTemporaryDirectory) {
		environment.TMPDIR = `${privateTemporaryDirectory}${path.sep}`;
		environment.TMP = privateTemporaryDirectory;
		environment.TEMP = privateTemporaryDirectory;
		environment.TMPPREFIX = path.join(privateTemporaryDirectory, "zsh");
	}
	const child = Bun.spawn(argv, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached,
		env: environment,
	});
	let windowsTermination: Promise<void> | undefined;
	const killProcessTree = (force: boolean): void => {
		try {
			const signalName = force ? "SIGKILL" : "SIGTERM";
			if (detached) process.kill(-child.pid, signalName);
			else child.kill(signalName);
		} catch {
			// The process group has already exited.
		}
	};
	const onAbort = (): void => {
		if (process.platform === "win32") {
			// Killing cmd.exe alone orphans the command it launched and leaves its
			// pipes and working directory open. taskkill /T terminates that full tree.
			windowsTermination ??= (async () => {
				try {
					const killer = Bun.spawn(["taskkill.exe", "/pid", String(child.pid), "/t", "/f"], {
						stdin: "ignore",
						stdout: "ignore",
						stderr: "ignore",
					});
					await killer.exited;
				} catch {
					killProcessTree(true);
				}
			})();
			return;
		}
		killProcessTree(false);
		void (async () => {
			await Bun.sleep(250);
			killProcessTree(true);
		})();
	};
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();

	const stdout = new BoundedStreamCapture(MAX_SHELL_STREAM_CAPTURE);
	const stderr = new BoundedStreamCapture(MAX_SHELL_STREAM_CAPTURE);
	try {
		const [, , exitCode] = await Promise.all([
			drainStream(child.stdout, stdout),
			drainStream(child.stderr, stderr),
			child.exited,
		]);
		const stdoutText = stdout.render();
		const stderrText = stderr.render();
		const output = `${stdoutText}${stderrText ? `${stdoutText ? "\n" : ""}${stderrText}` : ""}\nExit code: ${exitCode}`;
		return {
			...textResult(clampOutput(output), {
				exitCode,
				stdoutBytes: stdout.totalBytes,
				stderrBytes: stderr.totalBytes,
				stdoutOmittedBytes: stdout.omittedBytes,
				stderrOmittedBytes: stderr.omittedBytes,
				...extraDetails,
			}),
			isError: exitCode !== 0,
		};
	} finally {
		signal.removeEventListener("abort", onAbort);
		await windowsTermination;
		if (privateTemporaryDirectory) {
			await fs.rm(privateTemporaryDirectory, { recursive: true, force: true });
		}
	}
}

const CHECK_NAME_PATTERN = /(?:^|[-_:])(test|check|lint|build|typecheck)(?:$|[-_:])/i;
const SHELL_MUTATION_PATTERN =
	/(?:^|\s)(?:rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|install|truncate|dd|patch)(?:\s|$)|\bsed\s+-[^\s]*i\b|\bperl\s+-[^\s]*i\b|\bgit\s+(?:apply|checkout|restore|reset|clean|commit|merge|rebase)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update)\b|(?:^|[^<])>{1,2}(?!&)/i;
const READ_ONLY_SHELL_COMMANDS = new Set([
	"[",
	"cat",
	"echo",
	"env",
	"false",
	"find",
	"git",
	"grep",
	"head",
	"ls",
	"od",
	"printf",
	"pwd",
	"rg",
	"stat",
	"tail",
	"test",
	"true",
	"wc",
	"which",
	"xxd",
]);

function shellWorkspaceMutationRisk(command: string): "none" | "possible" {
	if (SHELL_MUTATION_PATTERN.test(command)) return "possible";
	if (defineVerificationCheck("probe", command)) return "none";
	const segments = command.split(/&&|\|\||[;|]/);
	for (const segment of segments) {
		const executable = segment
			.trim()
			.replace(/^(?:if|then|else|elif|while|until|do)\s+/, "")
			.match(/^([^\s]+)/)?.[1];
		if (!executable || ["fi", "done"].includes(executable)) continue;
		if (READ_ONLY_SHELL_COMMANDS.has(path.basename(executable))) continue;
		return "possible";
	}
	return "none";
}

export function defineVerificationCheck(id: string, command: string): VerificationCheck | undefined {
	const tokens = command.trim().split(/\s+/);
	if (tokens.length === 0 || tokens.some(token => !/^[\w@%+=:,./-]+$/.test(token))) return undefined;
	const executable = path.basename(tokens[0] ?? "");
	const args = tokens.slice(1);
	const first = args[0] ?? "";
	const second = args[1] ?? "";
	const pythonExecutable = /^(?:python(?:3(?:\.\d+)*)?|py)$/.test(executable);
	const pythonCheck =
		pythonExecutable &&
		((first === "-m" && ["pytest", "unittest"].includes(second)) ||
			(/\.py$/i.test(first) && /(?:test|check|lint)/i.test(path.basename(first))));
	const allowed =
		pythonCheck ||
		(executable === "bun" && (first === "test" || (first === "run" && CHECK_NAME_PATTERN.test(second)))) ||
		(["npm", "pnpm", "yarn"].includes(executable) &&
			(first === "test" || (first === "run" && CHECK_NAME_PATTERN.test(second)))) ||
		(executable === "cargo" && ["test", "check", "clippy", "build"].includes(first)) ||
		(executable === "go" && first === "test") ||
		["pytest", "py.test"].includes(executable);
	return allowed ? { id, command, argv: tokens } : undefined;
}

export function createVerificationCheckTool(cwd: string, checks: readonly VerificationCheck[]): AgentTool {
	const root = path.resolve(cwd);
	const byId = new Map(checks.map(check => [check.id, check]));
	const schema = z.object({ id: z.string() });
	return {
		name: "check",
		label: "Check",
		description: checkDescription,
		parameters: schema,
		sideEffect: "none",
		async execute(_toolCallId, rawParams, signal) {
			const { id } = schema.parse(rawParams);
			const check = byId.get(id);
			if (!check) throw new Error(`Unknown verification check '${id}'.`);
			const timeout = AbortSignal.timeout(300_000);
			const launch = await createSandboxedInvocation(check.argv, root);
			if (!launch.sandboxed) {
				throw new Error(
					"Verification check requires a supported OS sandbox and will not run on the host directly.",
				);
			}
			return runCapturedProcess(launch.argv, root, signal ? AbortSignal.any([signal, timeout]) : timeout, {
				sandboxed: launch.sandboxed,
			});
		},
	};
}

function clampOutput(text: string): string {
	if (text.length <= MAX_TOOL_OUTPUT) return text;
	const marker = "\n… output truncated …\n";
	const retainedCharacters = MAX_TOOL_OUTPUT - marker.length;
	const headCharacters = Math.ceil(retainedCharacters / 2);
	const tailCharacters = retainedCharacters - headCharacters;
	return `${text.slice(0, headCharacters)}${marker}${text.slice(-tailCharacters)}`;
}

function computeFileHash(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 12).toUpperCase();
}

class WorkspaceFilesystem {
	#root: string;
	#realRoot: Promise<string>;

	constructor(root: string) {
		this.#root = path.resolve(root);
		this.#realRoot = fs.realpath(this.#root);
	}

	resolve(input: string): string {
		const absolute = path.resolve(this.#root, input);
		const relative = path.relative(this.#root, absolute);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`Path is outside the workspace: ${input}`);
		}
		return absolute;
	}

	async #assertContained(absolute: string, input: string): Promise<void> {
		const realRoot = await this.#realRoot;
		const real = await fs.realpath(absolute);
		const relative = path.relative(realRoot, real);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`Path resolves outside the workspace through a symbolic link: ${input}`);
		}
	}

	async #assertWritable(absolute: string, input: string): Promise<void> {
		let existing = absolute;
		while (true) {
			try {
				await fs.lstat(existing);
				break;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				const parent = path.dirname(existing);
				if (parent === existing) throw error;
				existing = parent;
			}
		}
		await this.#assertContained(existing, input);
	}

	async canonical(input: string): Promise<string> {
		const absolute = this.resolve(input);
		await this.#assertContained(absolute, input);
		return absolute;
	}

	async readText(input: string): Promise<string> {
		return Bun.file(await this.canonical(input)).text();
	}

	async writeText(input: string, content: string): Promise<void> {
		const absolute = this.resolve(input);
		await this.#assertWritable(absolute, input);
		await Bun.write(absolute, content);
	}

	async exists(input: string): Promise<boolean> {
		const absolute = this.resolve(input);
		try {
			await fs.lstat(absolute);
			await this.#assertContained(absolute, input);
			return true;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
			throw error;
		}
	}
}

interface Snapshot {
	hash: string;
	seenLines: Set<number>;
}

export interface AdaptiveToolset {
	minimalTools: AgentTool[];
	readonlyTools: AgentTool[];
	verificationTools: AgentTool[];
	allTools: AgentTool[];
}

export interface ShellApprovalRequest {
	command: string;
	cwd: string;
	reason: "host-read" | "unsandboxed";
	sandboxed: boolean;
}

export interface AdaptiveToolsetOptions {
	approveShell?: (request: ShellApprovalRequest) => boolean | Promise<boolean>;
}

export interface ShellInvocationOptions {
	platform?: NodeJS.Platform;
	shell?: string;
	comspec?: string;
}

export function createShellInvocation(command: string, options: ShellInvocationOptions = {}): string[] {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") {
		return [options.comspec ?? process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", "/d", "/s", "/c", command];
	}
	return [options.shell ?? process.env.SHELL ?? "/bin/sh", "-c", command];
}

interface SandboxedInvocation {
	argv: string[];
	sandboxed: boolean;
}

const SENSITIVE_HOME_DIRECTORIES = [
	".ssh",
	".aws",
	".azure",
	".kube",
	".docker",
	".aaa-agent",
	".config/gcloud",
	".config/google-chrome",
	".config/chromium",
	".mozilla",
	"Library/Application Support/Google/Chrome",
	"Library/Safari",
] as const;
const SENSITIVE_HOME_FILES = [".netrc", ".npmrc", ".pypirc"] as const;

function pathsOverlap(left: string, right: string): boolean {
	const leftToRight = path.relative(left, right);
	const rightToLeft = path.relative(right, left);
	return (
		(!leftToRight.startsWith(`..${path.sep}`) && leftToRight !== ".." && !path.isAbsolute(leftToRight)) ||
		(!rightToLeft.startsWith(`..${path.sep}`) && rightToLeft !== ".." && !path.isAbsolute(rightToLeft))
	);
}

function sensitiveHostPaths(root: string): { directories: string[]; files: string[] } {
	const home = os.homedir();
	return {
		directories: SENSITIVE_HOME_DIRECTORIES.map(relative => path.join(home, relative)).filter(
			candidate => !pathsOverlap(candidate, root),
		),
		files: SENSITIVE_HOME_FILES.map(relative => path.join(home, relative)).filter(
			candidate => !pathsOverlap(candidate, root),
		),
	};
}

async function linuxSecretMasks(directories: readonly string[], files: readonly string[]): Promise<string[]> {
	const masks: string[] = [];
	for (const candidate of directories) {
		try {
			if ((await fs.lstat(candidate)).isDirectory()) masks.push("--tmpfs", candidate);
		} catch {}
	}
	for (const candidate of files) {
		try {
			if ((await fs.lstat(candidate)).isFile()) masks.push("--ro-bind", "/dev/null", candidate);
		} catch {}
	}
	return masks;
}

async function createSandboxedInvocation(argv: string[], root: string): Promise<SandboxedInvocation> {
	const realRoot = await fs.realpath(root);
	const sensitive = sensitiveHostPaths(realRoot);
	if (process.platform === "darwin") {
		const realTemporaryDirectory = await fs.realpath(os.tmpdir());
		const profile = [
			"(version 1)",
			"(allow default)",
			"(deny network*)",
			"(deny file-write*)",
			...sensitive.directories.map(candidate => `(deny file-read* (subpath ${JSON.stringify(candidate)}))`),
			...sensitive.files.map(candidate => `(deny file-read* (literal ${JSON.stringify(candidate)}))`),
			`(allow file-write* (subpath ${JSON.stringify(realRoot)}) (subpath ${JSON.stringify(realTemporaryDirectory)}) (literal "/dev/null"))`,
		].join("\n");
		return { argv: ["/usr/bin/sandbox-exec", "-p", profile, ...argv], sandboxed: true };
	}
	if (process.platform === "linux") {
		const bwrap = Bun.which("bwrap");
		if (bwrap) {
			const secretMasks = await linuxSecretMasks(sensitive.directories, sensitive.files);
			return {
				argv: [
					bwrap,
					"--die-with-parent",
					"--unshare-net",
					"--ro-bind",
					"/",
					"/",
					"--bind",
					realRoot,
					realRoot,
					"--dev",
					"/dev",
					"--proc",
					"/proc",
					"--tmpfs",
					"/tmp",
					...secretMasks,
					"--",
					...argv,
				],
				sandboxed: true,
			};
		}
	}
	return { argv, sandboxed: false };
}

function lineSpan(text: string, start: number, length: number): number[] {
	const first = text.slice(0, start).split("\n").length;
	const count = text.slice(start, start + length).split("\n").length;
	return Array.from({ length: count }, (_, index) => first + index);
}

export function createAdaptiveToolset(cwd: string, options: AdaptiveToolsetOptions = {}): AdaptiveToolset {
	const root = path.resolve(cwd);
	const filesystem = new WorkspaceFilesystem(root);
	const snapshots = new Map<string, Snapshot>();

	const readSchema = z.object({
		path: z.string(),
		offset: z.number().int().positive().optional(),
		limit: z.number().int().positive().max(1000).optional(),
	});
	const readTool: AgentTool = {
		name: "read",
		label: "Read",
		description: readDescription,
		sideEffect: "none",
		parameters: readSchema,
		execute: async (_toolCallId, rawParams) => {
			const params = readSchema.parse(rawParams);
			const text = await filesystem.readText(params.path);
			const lines = text.split("\n");
			const offset = params.offset ?? 1;
			const limit = params.limit ?? 200;
			const start = Math.min(lines.length, offset - 1);
			const end = Math.min(lines.length, start + limit);
			const canonical = await filesystem.canonical(params.path);
			const hash = computeFileHash(text);
			const prior = snapshots.get(canonical);
			const seenLines = prior?.hash === hash ? prior.seenLines : new Set<number>();
			for (let index = start; index < end; index += 1) seenLines.add(index + 1);
			snapshots.set(canonical, { hash, seenLines });
			const relative = path.relative(root, canonical) || path.basename(canonical);
			const body = lines
				.slice(start, end)
				.map((line, index) => `${start + index + 1}:${line.slice(0, MAX_LINE_LENGTH)}`)
				.join("\n");
			return textResult(clampOutput(`[${relative}#${hash}]\n${body}`), { path: relative, hash, offset, limit });
		},
	};

	const globSchema = z.object({
		pattern: z.string(),
		limit: z.number().int().positive().max(2000).optional(),
	});
	const globTool: AgentTool = {
		name: "glob",
		label: "Glob",
		description: globDescription,
		sideEffect: "none",
		parameters: globSchema,
		execute: async (_toolCallId, rawParams) => {
			const params = globSchema.parse(rawParams);
			const matches: string[] = [];
			for await (const match of new Bun.Glob(params.pattern).scan({ cwd: root, dot: true, onlyFiles: true })) {
				if (isIgnoredSearchPath(match)) continue;
				matches.push(normalizeToolPath(match));
				if (matches.length >= (params.limit ?? 200)) break;
			}
			matches.sort();
			return textResult(clampOutput(matches.length > 0 ? matches.join("\n") : "No matches."), {
				count: matches.length,
			});
		},
	};

	const searchSchema = z.object({
		pattern: z.string(),
		files: z.string().optional(),
		caseSensitive: z.boolean().optional(),
		limit: z.number().int().positive().max(2000).optional(),
	});
	const searchTool: AgentTool = {
		name: "search",
		label: "Search",
		description: searchDescription,
		sideEffect: "none",
		parameters: searchSchema,
		execute: async (_toolCallId, rawParams) => {
			const params = searchSchema.parse(rawParams);
			assertSafeSearchPattern(params.pattern);
			let expression: RegExp;
			try {
				expression = new RegExp(params.pattern, params.caseSensitive === false ? "i" : "");
			} catch (error) {
				throw new Error(`Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`);
			}
			const matches: string[] = [];
			const limit = params.limit ?? 200;
			for await (const file of new Bun.Glob(params.files ?? "**/*").scan({
				cwd: root,
				dot: true,
				onlyFiles: true,
			})) {
				if (!(await isSearchableFile(root, file))) continue;
				let text: string;
				try {
					text = await filesystem.readText(file);
				} catch {
					continue;
				}
				const lines = text.split("\n");
				for (let index = 0; index < lines.length; index += 1) {
					const line = lines[index] ?? "";
					if (!expression.test(line)) continue;
					matches.push(`${normalizeToolPath(file)}:${index + 1}:${line.slice(0, MAX_LINE_LENGTH)}`);
					if (matches.length >= limit) break;
				}
				if (matches.length >= limit) break;
			}
			return textResult(clampOutput(matches.length > 0 ? matches.join("\n") : "No matches."), {
				count: matches.length,
			});
		},
	};

	const writeSchema = z.object({
		path: z.string(),
		content: z.string(),
		overwrite: z.boolean().optional(),
	});
	const writeTool: AgentTool = {
		name: "write",
		label: "Write",
		description: writeDescription,
		sideEffect: "workspace",
		parameters: writeSchema,
		execute: async (_toolCallId, rawParams) => {
			const params = writeSchema.parse(rawParams);
			const exists = await filesystem.exists(params.path);
			if (exists && !params.overwrite) throw new Error("Target exists; use edit or set overwrite=true explicitly.");
			await filesystem.writeText(params.path, params.content);
			const canonical = await filesystem.canonical(params.path);
			const hash = computeFileHash(params.content);
			snapshots.set(canonical, { hash, seenLines: new Set() });
			return textResult(`Wrote ${params.content.length} characters to ${params.path}.\n[${params.path}#${hash}]`, {
				path: params.path,
				hash,
			});
		},
	};

	const editSchema = z.object({
		path: z.string(),
		hash: z.string().min(8),
		edits: z
			.array(
				z.object({
					oldText: z.string().min(1),
					newText: z.string(),
				}),
			)
			.min(1),
	});
	const editTool: AgentTool = {
		name: "edit",
		label: "Edit",
		description: editDescription,
		sideEffect: "workspace",
		parameters: editSchema,
		execute: async (_toolCallId, rawParams) => {
			const params = editSchema.parse(rawParams);
			const canonical = await filesystem.canonical(params.path);
			const before = await filesystem.readText(params.path);
			const currentHash = computeFileHash(before);
			if (currentHash !== params.hash) throw new Error(`Snapshot mismatch for ${params.path}; re-read and retry.`);
			const snapshot = snapshots.get(canonical);
			if (!snapshot || snapshot.hash !== params.hash)
				throw new Error(`Unknown snapshot for ${params.path}; read it first.`);
			const replacements = params.edits.map(edit => {
				const start = before.indexOf(edit.oldText);
				if (start === -1) throw new Error(`oldText not found in ${params.path}: ${edit.oldText.slice(0, 200)}`);
				if (before.indexOf(edit.oldText, start + 1) !== -1) {
					throw new Error(`oldText is not unique in ${params.path}; include more surrounding text.`);
				}
				const unseen = lineSpan(before, start, edit.oldText.length).filter(line => !snapshot.seenLines.has(line));
				if (unseen.length > 0) throw new Error(`Edit touches lines not shown by read: ${unseen.join(", ")}`);
				return { start, end: start + edit.oldText.length, newText: edit.newText };
			});
			replacements.sort((left, right) => right.start - left.start);
			for (let index = 1; index < replacements.length; index += 1) {
				const previous = replacements[index - 1];
				const current = replacements[index];
				if (previous && current && current.end > previous.start) throw new Error("Edit ranges overlap.");
			}
			let after = before;
			for (const replacement of replacements) {
				after = `${after.slice(0, replacement.start)}${replacement.newText}${after.slice(replacement.end)}`;
			}
			await filesystem.writeText(params.path, after);
			const hash = computeFileHash(after);
			snapshots.set(canonical, { hash, seenLines: new Set() });
			return textResult(`Updated ${params.path}.\n[${params.path}#${hash}]`, { path: params.path, hash });
		},
	};

	const shellSchema = z.object({
		command: z.string(),
		timeoutSeconds: z.number().positive().max(3600).optional(),
	});
	const shellTool: AgentTool = {
		name: "shell",
		label: "Shell",
		description: shellDescription,
		sideEffect: "unrestricted",
		parameters: shellSchema,
		execute: async (_toolCallId, rawParams, signal) => {
			const params = shellSchema.parse(rawParams);
			const baseInvocation = createShellInvocation(params.command);
			const launch = await createSandboxedInvocation(baseInvocation, root);
			const reason = launch.sandboxed ? "host-read" : "unsandboxed";
			if (
				!(await options.approveShell?.({
					command: params.command,
					cwd: root,
					reason,
					sandboxed: launch.sandboxed,
				}))
			) {
				throw new Error(
					launch.sandboxed
						? "Shell command requires explicit approval because arbitrary shell can read host files outside the workspace."
						: "Shell command requires explicit approval because no supported OS sandbox limits host file or network access.",
				);
			}
			const timeout = AbortSignal.timeout(Math.round((params.timeoutSeconds ?? 120) * 1000));
			const commandSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
			return runCapturedProcess(launch.argv, root, commandSignal, {
				sandboxed: launch.sandboxed,
				workspaceMutationRisk: shellWorkspaceMutationRisk(params.command),
			});
		},
	};

	const readonlyTools = [readTool, globTool, searchTool];
	return {
		minimalTools: [readTool, searchTool, writeTool, editTool, shellTool],
		readonlyTools,
		verificationTools: readonlyTools,
		allTools: [...readonlyTools, writeTool, editTool, shellTool],
	};
}
