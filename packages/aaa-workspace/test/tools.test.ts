import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, ToolResult } from "@aaa-agent/runtime";
import { createAdaptiveToolset, createVerificationCheckTool, defineVerificationCheck } from "../src/tools";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function createWorkspaceTool(name: string): Promise<{ directory: string; tool: AgentTool }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-workspace-tools-"));
	temporaryDirectories.push(directory);
	const tool = createAdaptiveToolset(directory, { approveShell: () => true }).allTools.find(
		candidate => candidate.name === name,
	);
	if (!tool) throw new Error(`Missing ${name} tool`);
	return { directory, tool };
}

function resultText(result: ToolResult): string {
	const content = result.content[0];
	return content?.type === "text" ? content.text : "";
}

describe("workspace shell approval", () => {
	it("requires approval for arbitrary shell even when whitespace hides a destructive executable", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-workspace-tools-"));
		temporaryDirectories.push(directory);
		await Bun.write(path.join(directory, "victim.txt"), "keep");
		const approvals: string[] = [];
		const shell = createAdaptiveToolset(directory, {
			approveShell(request) {
				approvals.push(request.command);
				return false;
			},
		}).allTools.find(tool => tool.name === "shell");
		if (!shell) throw new Error("Missing shell tool");

		await expect(shell.execute("denied-shell", { command: " rm victim.txt" })).rejects.toThrow(
			"Shell command requires explicit approval",
		);
		expect(approvals).toEqual([" rm victim.txt"]);
		expect(await Bun.file(path.join(directory, "victim.txt")).text()).toBe("keep");
	});
});

describe("workspace shell mutation classification", () => {
	it("distinguishes read-only shell probes from workspace-mutating commands", async () => {
		const { directory, tool } = await createWorkspaceTool("shell");
		await Bun.write(path.join(directory, "input.txt"), "value");
		const read = await tool.execute("read-shell", { command: "cat input.txt && wc -c input.txt" });
		expect(read.details?.workspaceMutationRisk).toBe("none");
		const write = await tool.execute("write-shell", { command: "printf changed > output.txt" });
		expect(write.details?.workspaceMutationRisk).toBe("possible");
	});
});

describe("workspace verification command recognition", () => {
	it("recognizes safe Python test runners and check scripts", () => {
		expect(defineVerificationCheck("pytest", "python3 -m pytest tests/ -q")?.argv).toEqual([
			"python3",
			"-m",
			"pytest",
			"tests/",
			"-q",
		]);
		expect(defineVerificationCheck("unittest", "python3 -m unittest discover -s tests -v")).toBeDefined();
		expect(defineVerificationCheck("selfcheck", "python3 tools/selfcheck.py")).toBeDefined();
		expect(defineVerificationCheck("unsafe", "python3 tools/migrate.py")).toBeUndefined();
		expect(defineVerificationCheck("code", "python3 -c print(1)")).toBeUndefined();
	});
});

describe("workspace shell temporary files", () => {
	it("supports heredocs inside the macOS sandbox without leaking temporary files", async () => {
		if (process.platform !== "darwin") return;
		const { tool } = await createWorkspaceTool("shell");
		const result = await tool.execute("heredoc", {
			command: "python3 - <<'PY'\nprint('HEREDOC_OK')\nPY",
		});
		expect(result.isError).not.toBe(true);
		expect(resultText(result)).toContain("HEREDOC_OK");
	});
});

describe("workspace process isolation", () => {
	it("does not pass unrelated host secrets to workspace shell commands", async () => {
		const { directory, tool } = await createWorkspaceTool("shell");
		await Bun.write(
			path.join(directory, "print-env.ts"),
			'process.stdout.write(process.env.AAA_TEST_SECRET ?? "redacted");',
		);
		const previous = process.env.AAA_TEST_SECRET;
		process.env.AAA_TEST_SECRET = "must-not-leak";
		try {
			const result = await tool.execute("sanitized-env", { command: "bun print-env.ts" });
			expect(resultText(result)).toContain("redacted");
			expect(resultText(result)).not.toContain("must-not-leak");
		} finally {
			if (previous === undefined) delete process.env.AAA_TEST_SECRET;
			else process.env.AAA_TEST_SECRET = previous;
		}
	});

	it("never runs an automatic verification check without an OS sandbox", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-verification-check-"));
		temporaryDirectories.push(directory);
		await Bun.write(
			path.join(directory, "smoke.test.ts"),
			'import { expect, test } from "bun:test"; test("smoke", () => expect(1).toBe(1));',
		);
		const check = defineVerificationCheck("smoke", "bun test smoke.test.ts");
		if (!check) throw new Error("Expected supported verification check");
		const tool = createVerificationCheckTool(directory, [check]);
		expect(tool.sideEffect).toBe("none");
		const sandboxAvailable = process.platform === "darwin" || (process.platform === "linux" && Bun.which("bwrap"));
		if (!sandboxAvailable) {
			await expect(tool.execute("check", { id: "smoke" })).rejects.toThrow("requires a supported OS sandbox");
			return;
		}
		const result = await tool.execute("check", { id: "smoke" });
		expect(result.isError).not.toBe(true);
		expect(result.details?.sandboxed).toBe(true);
	});
});
describe("workspace shell output streaming", () => {
	it("continuously drains huge stdout and stderr while retaining bounded head and tail evidence", async () => {
		const { directory, tool } = await createWorkspaceTool("shell");
		await Bun.write(
			path.join(directory, "emit.ts"),
			`const stdoutChunk = Buffer.alloc(1024 * 1024, "o");
const stderrChunk = Buffer.alloc(1024 * 1024, "e");
process.stdout.write("STDOUT_HEAD");
process.stderr.write("STDERR_HEAD");
for (let index = 0; index < 24; index += 1) {
  process.stdout.write(stdoutChunk);
  process.stderr.write(stderrChunk);
}
process.stdout.write("STDOUT_TAIL");
process.stderr.write("STDERR_TAIL");
process.exitCode = 23;
`,
		);

		const result = await tool.execute("huge-output", { command: "bun emit.ts" });
		const text = resultText(result);
		expect(text.length).toBeLessThanOrEqual(30_000);
		expect(text).toContain("STDOUT_HEAD");
		expect(text).toContain("STDOUT_TAIL");
		expect(text).toContain("STDERR_HEAD");
		expect(text).toContain("STDERR_TAIL");
		expect(text).toContain("bytes omitted");
		expect(text).toEndWith("Exit code: 23");
		expect(result.details).toMatchObject({
			exitCode: 23,
			stdoutBytes: 24 * 1024 * 1024 + 22,
			stderrBytes: 24 * 1024 * 1024 + 22,
		});
		expect((result.details?.stdoutOmittedBytes as number) > 24_000_000).toBe(true);
		expect((result.details?.stderrOmittedBytes as number) > 24_000_000).toBe(true);
	});

	it("decodes binary-ish bytes and keeps the end of an unterminated long line", async () => {
		const { directory, tool } = await createWorkspaceTool("shell");
		await Bun.write(
			path.join(directory, "binary.ts"),
			`process.stdout.write(Buffer.from([0, 255, 1, 254]));
process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 120));
process.stdout.write("BINARY_TAIL");
`,
		);

		const result = await tool.execute("binary-output", { command: "bun binary.ts" });
		const text = resultText(result);
		expect(text.length).toBeLessThanOrEqual(30_000);
		expect(text).toContain("bytes omitted");
		expect(text).toContain("BINARY_TAIL");
		expect(text).toEndWith("Exit code: 0");
	});

	it("drains output through nonzero exit and timeout termination without losing the exit status", async () => {
		const { directory, tool } = await createWorkspaceTool("shell");
		await Bun.write(
			path.join(directory, "timeout.ts"),
			`process.stdout.write(Buffer.alloc(8 * 1024 * 1024, 116));
process.stdout.write("BEFORE_TIMEOUT");
await Promise.withResolvers<void>().promise;
`,
		);

		const started = performance.now();
		const result = await tool.execute("timeout-output", { command: "bun timeout.ts", timeoutSeconds: 0.2 });
		const text = resultText(result);
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(text.length).toBeLessThanOrEqual(30_000);
		expect(text).toContain("BEFORE_TIMEOUT");
		expect(text).toMatch(/Exit code: (?!0\b)\d+$/);
		expect(result.details?.exitCode).not.toBe(0);
	});

	it("terminates and drains a noisy command when the caller cancels", async () => {
		const { directory, tool } = await createWorkspaceTool("shell");
		await Bun.write(
			path.join(directory, "cancel.ts"),
			`const chunk = Buffer.alloc(64 * 1024, 99);
for (let index = 0; index < 256; index += 1) {
  process.stdout.write(chunk);
  process.stderr.write(chunk);
}
await Bun.write("ready", "ready");
await Promise.withResolvers<void>().promise;
`,
		);
		const watcher = fs.watch(directory);
		const ready = (async () => {
			for await (const event of watcher) {
				if (event.filename === "ready") return;
			}
		})();
		const controller = new AbortController();
		const pending = tool.execute("cancel-output", { command: "bun cancel.ts" }, controller.signal);
		await ready;
		controller.abort();

		const started = performance.now();
		const result = await pending;
		const text = resultText(result);
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(text.length).toBeLessThanOrEqual(30_000);
		expect(text).toContain("bytes omitted");
		expect(text).toMatch(/Exit code: (?!0\b)\d+$/);
		expect(result.details?.exitCode).not.toBe(0);
	});
});

describe("workspace inspection output bounds", () => {
	it("bounds read and search results for a very long line and caps large glob listings", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-workspace-tools-"));
		temporaryDirectories.push(directory);
		await Bun.write(path.join(directory, "huge.txt"), `needle-${"x".repeat(8 * 1024 * 1024)}-tail`);
		await Promise.all(
			Array.from({ length: 250 }, (_, index) =>
				Bun.write(path.join(directory, `match-${index}-${"n".repeat(180)}.txt`), `needle-${"s".repeat(4_000)}`),
			),
		);
		const tools = createAdaptiveToolset(directory).allTools;
		const read = tools.find(tool => tool.name === "read");
		const search = tools.find(tool => tool.name === "search");
		const glob = tools.find(tool => tool.name === "glob");
		if (!read || !search || !glob) throw new Error("Missing workspace inspection tools");

		const readResult = await read.execute("read-long", { path: "huge.txt" });
		const searchResult = await search.execute("search-long", {
			pattern: "needle",
			files: "match-*.txt",
			limit: 250,
		});
		const globResult = await glob.execute("glob-large", { pattern: "match-*.txt", limit: 250 });
		expect(resultText(readResult).length).toBeLessThanOrEqual(30_000);
		expect(resultText(searchResult).length).toBeLessThanOrEqual(30_000);
		expect(resultText(searchResult)).toContain("output truncated");
		expect(resultText(globResult).length).toBeLessThanOrEqual(30_000);
		expect(resultText(globResult)).toContain("output truncated");
		expect(globResult.details).toMatchObject({ count: 250 });
	});
});
