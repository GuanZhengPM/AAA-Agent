import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { emitKeypressEvents } from "node:readline";
import * as readline from "node:readline/promises";
import {
	assertModelSupportsServiceTier,
	assertModelSupportsThinkingMode,
	resolveDefaultThinkingMode,
	resolveModel,
	resolveServiceTier,
	supportedThinkingModes,
} from "@aaa-agent/providers";
import type {
	AdaptiveHarnessEvent,
	AdaptiveHarnessResult,
	AgentConversationMessage,
	LedgerEntry,
	LongRunCheckpoint,
	Model,
	ServiceTier,
	StructuredContextState,
	ThinkingMode,
} from "@aaa-agent/runtime";
import {
	extractLedgerEntries,
	mergeLedger,
	resolveHistoryWorkingBudget,
	updateStructuredContextState,
} from "@aaa-agent/runtime";
import { createShellInvocation, type ShellApprovalRequest } from "@aaa-agent/workspace";
import type { AdaptiveRuntimeAgentEvent } from "./runtime";
import {
	acquireSessionLease,
	createInteractiveSession,
	type InteractiveSession,
	partitionForDigest,
	resolveDigestBudget,
	rollDigest,
	type SessionHistoryMatch,
	type SessionLease,
	type SessionSummary,
} from "./session-store";
import { TaskTerminalReporter } from "./terminal";

const TERMINAL_LOGO = [
	" █████╗  █████╗  █████╗ ",
	"██╔══██╗██╔══██╗██╔══██╗",
	"███████║███████║███████║",
	"██╔══██║██╔══██║██╔══██║",
	"██║  ██║██║  ██║██║  ██║",
	"╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝",
	"          3A AGENT",
].join("\n");

const HELP = `Session commands:
  /help                 Show this help
  /model [number|name]  Select with ↑/↓, number, name, id, or provider/id
  /effort               Select auto, off, or a native reasoning effort
  /tier                  Select a native service tier
  /fast <on|off>         Toggle priority/fast serving
  /adaptive [status|on|off|reset]
                         Inspect or control local adaptation
  /status               Show model, workspace, context, and session
  /sessions             List resumable sessions
  /search <query>       Search conversation history in this workspace
  /new                  Start a new persisted session
  /cd <path>            Change workspace and start a new session
  /paste                Enter a multiline task; finish with a single .
  /clear                Clear conversation context
  /tools <on|off>       Show or hide tool activity
  /verbose <on|off>     Show or hide routing details
  !<command>            Run a local shell command
  /exit                 Save and exit`;

export type InteractiveAction =
	| { type: "empty" }
	| { type: "task"; task: string }
	| { type: "shell"; command: string }
	| { type: "help" }
	| { type: "model"; value?: string }
	| { type: "effort"; value?: string }
	| { type: "tier"; value?: string }
	| { type: "fast"; value?: string }
	| { type: "adaptive"; value?: string }
	| { type: "status" }
	| { type: "sessions" }
	| { type: "search"; value?: string }
	| { type: "new" }
	| { type: "cd"; path?: string }
	| { type: "paste" }
	| { type: "clear" }
	| { type: "tools"; value?: string }
	| { type: "verbose"; value?: string }
	| { type: "exit" }
	| { type: "unknown"; command: string };

export interface InteractiveTaskRequest {
	task: string;
	/** Stable persisted session id used for provider cache affinity. */
	sessionId: string;
	model: Model;
	thinkingMode: ThinkingMode;
	serviceTier?: ServiceTier;
	cwd: string;
	conversation: readonly AgentConversationMessage[];
	contextState?: StructuredContextState;
	checkpoint?: LongRunCheckpoint;
	approveShell(request: ShellApprovalRequest): Promise<boolean>;
	onCheckpoint(checkpoint: LongRunCheckpoint): void | Promise<void>;
	adaptive: boolean;
	signal: AbortSignal;
	onEvent(event: AdaptiveHarnessEvent): void;
	onAgentEvent(event: AdaptiveRuntimeAgentEvent): void;
}

export interface InteractiveTerminalOptions {
	model: Model;
	models: readonly Model[];
	thinkingMode: ThinkingMode;
	serviceTier?: ServiceTier;
	cwd: string;
	adaptive: boolean;
	authentication?: (model: Model) => string | undefined;
	runTask(request: InteractiveTaskRequest): Promise<AdaptiveHarnessResult>;
	savePreferences(model: Model, thinkingMode: ThinkingMode, serviceTier: ServiceTier | undefined): Promise<void>;
	setAdaptive(enabled: boolean, reset: boolean): Promise<void>;
	session?: InteractiveSession;
	listSessions?(): Promise<SessionSummary[]>;
	searchSessions?(query: string, cwd?: string): Promise<SessionHistoryMatch[]>;
	loadSession?(id: string): Promise<InteractiveSession>;
	saveSession(session: InteractiveSession): Promise<void>;
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
}

function optionalValue(value: string): { value?: string } {
	return value ? { value } : {};
}

export function parseInteractiveInput(input: string): InteractiveAction {
	const trimmed = input
		.trim()
		.replace(/^(?:you\s*›\s*)+/i, "")
		.trim();
	if (!trimmed) return { type: "empty" };
	const modelPrompt = trimmed.match(/^model\s*›\s*(.+)$/i);
	if (modelPrompt?.[1]) return { type: "model", value: modelPrompt[1].trim() };
	if (trimmed.startsWith("!")) {
		const command = trimmed.slice(1).trim();
		return command ? { type: "shell", command } : { type: "empty" };
	}
	if (!trimmed.startsWith("/")) return { type: "task", task: trimmed };
	const separator = trimmed.search(/\s/);
	const command = (separator === -1 ? trimmed.slice(1) : trimmed.slice(1, separator)).toLowerCase();
	const value = separator === -1 ? "" : trimmed.slice(separator).trim();
	switch (command) {
		case "help":
		case "?":
			return { type: "help" };
		case "model":
		case "models":
			return { type: "model", ...optionalValue(value) };
		case "effort":
			return { type: "effort", ...optionalValue(value) };
		case "tier":
			return { type: "tier", ...optionalValue(value) };
		case "fast":
			return { type: "fast", ...optionalValue(value) };
		case "status":
		case "context":
			return { type: "status" };
		case "adaptive":
			return { type: "adaptive", ...optionalValue(value) };
		case "cd":
			return { type: "cd", ...(value ? { path: value } : {}) };
		case "paste":
			return { type: "paste" };
		case "clear":
			return { type: "clear" };
		case "new":
			return { type: "new" };
		case "sessions":
		case "resume":
			return { type: "sessions" };
		case "search":
			return { type: "search", ...optionalValue(value) };
		case "tools":
			return { type: "tools", ...optionalValue(value) };
		case "verbose":
			return { type: "verbose", ...optionalValue(value) };
		case "exit":
		case "quit":
		case "q":
			return { type: "exit" };
		default:
			return { type: "unknown", command };
	}
}

export class ConversationHistory {
	#messages: AgentConversationMessage[] = [];
	#characters = 0;
	constructor(messages: readonly AgentConversationMessage[] = []) {
		this.replace(messages);
	}

	replace(messages: readonly AgentConversationMessage[]): void {
		this.#messages = [];
		this.#characters = 0;
		for (const message of messages) {
			this.#messages.push({ ...message });
			this.#characters += message.text.length;
		}
	}

	addExchange(user: string, assistant: string): void {
		const messages: AgentConversationMessage[] = [
			{ role: "user", text: user },
			{ role: "assistant", text: assistant },
		];
		for (const message of messages) {
			this.#messages.push(message);
			this.#characters += message.text.length;
		}
	}

	clear(): void {
		this.#messages = [];
		this.#characters = 0;
	}

	snapshot(): AgentConversationMessage[] {
		return this.#messages.map(message => ({ ...message }));
	}

	get turns(): number {
		return Math.floor(this.#messages.length / 2);
	}

	get characters(): number {
		return this.#characters;
	}
}

function shortenedPath(value: string): string {
	const home = os.homedir();
	return value === home ? "~" : value.startsWith(`${home}${path.sep}`) ? `~${value.slice(home.length)}` : value;
}

function terminalSupportsColor(output: NodeJS.WritableStream): boolean {
	return "isTTY" in output && output.isTTY === true && !process.env.NO_COLOR;
}

function styled(value: string, code: string, enabled: boolean): string {
	return enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function parseToggle(value: string | undefined, current: boolean): boolean {
	if (!value) return !current;
	if (value === "on") return true;
	if (value === "off") return false;
	throw new Error("Expected 'on' or 'off'.");
}

function modelReference(model: Model): string {
	return `${model.provider}/${model.id}`;
}

export function resolveModelSelection(value: string, models: readonly Model[]): Model {
	const normalized = value
		.trim()
		.replace(/^model\s*›\s*/i, "")
		.trim();
	const indexed = normalized.match(/^[*›>]*\s*(\d+)(?:\s*[.)](?:\s+.*)?)?\s*$/);
	if (indexed?.[1]) {
		const index = Number(indexed[1]) - 1;
		const model = models[index];
		if (!model) throw new Error(`Model selection must be between 1 and ${models.length}.`);
		return model;
	}
	const labeledReference = normalized.match(/\(([^()]+)\)\s*$/)?.[1]?.trim();
	if (labeledReference) {
		try {
			return resolveModel(labeledReference, models);
		} catch {}
	}
	const byName = models.filter(candidate => candidate.name.toLowerCase() === normalized.toLowerCase());
	if (byName.length === 1 && byName[0]) return byName[0];
	if (byName.length > 1) {
		throw new Error(`Ambiguous model name '${value}'. Use provider/model-id.`);
	}
	return resolveModel(normalized, models);
}

interface RawTerminalInput extends NodeJS.ReadableStream {
	isTTY?: boolean;
	isRaw?: boolean;
	setRawMode(mode: boolean): unknown;
}

interface TerminalKey {
	name?: string;
	sequence?: string;
	ctrl?: boolean;
	meta?: boolean;
}

function supportsKeyboardSelection(
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
): input is RawTerminalInput {
	return (
		"isTTY" in input &&
		input.isTTY === true &&
		"isTTY" in output &&
		output.isTTY === true &&
		"setRawMode" in input &&
		typeof input.setRawMode === "function"
	);
}

async function selectModelWithKeyboard(
	input: RawTerminalInput,
	output: NodeJS.WritableStream,
	rl: readline.Interface,
	models: readonly Model[],
	current: Model,
): Promise<string | undefined> {
	if (models.length === 0) return undefined;
	emitKeypressEvents(input);
	const suspendedKeypressListeners = input.listeners("keypress");
	for (const listener of suspendedKeypressListeners) input.removeListener("keypress", listener);
	const wasRaw = input.isRaw === true;
	let selected = Math.max(
		0,
		models.findIndex(candidate => modelReference(candidate) === modelReference(current)),
	);
	let typed = "";
	let settled = false;
	rl.pause();
	input.setRawMode(true);
	input.resume();

	return new Promise<string | undefined>(resolve => {
		const redraw = (): void => {
			const candidate = models[selected]!;
			const value = typed || `${selected + 1}. ${candidate.name} (${modelReference(candidate)})`;
			output.write(`\r\u001b[2Kmodel › ${value}  [↑/↓ · Enter · Esc]`);
		};
		const cleanup = (resume: boolean): void => {
			input.removeListener("keypress", onKeypress);
			rl.removeListener("close", onClose);
			try {
				input.setRawMode(wasRaw);
			} catch {
				// A closing terminal may already have detached the underlying TTY.
			}
			for (const listener of suspendedKeypressListeners) input.on("keypress", listener);
			if (resume) rl.resume();
			output.write("\n");
		};
		const finish = (value: string | undefined, resume = true): void => {
			if (settled) return;
			settled = true;
			cleanup(resume);
			resolve(value);
		};
		const onClose = (): void => finish(undefined, false);
		const onKeypress = (character: string, key: TerminalKey = {}): void => {
			if (key.name === "up" || key.name === "down") {
				selected =
					key.name === "up" ? (selected - 1 + models.length) % models.length : (selected + 1) % models.length;
				typed = "";
				redraw();
				return;
			}
			if (key.name === "return" || key.name === "enter") {
				finish(typed.trim() || String(selected + 1));
				return;
			}
			if (key.name === "escape" || (key.ctrl && (key.name === "c" || key.name === "d"))) {
				finish(undefined);
				return;
			}
			if (key.name === "backspace") {
				typed = typed.slice(0, -1);
				redraw();
				return;
			}
			const text = character || key.sequence || "";
			if (!key.ctrl && !key.meta && text && !text.startsWith("\u001b") && [...text].every(char => char >= " ")) {
				typed += text;
				redraw();
			}
		};
		input.on("keypress", onKeypress);
		rl.once("close", onClose);
		redraw();
	});
}

async function runLocalShell(command: string, cwd: string): Promise<number> {
	const child = Bun.spawn(createShellInvocation(command), {
		cwd,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return child.exited;
}

function recoverCompletedExchange(
	session: InteractiveSession,
	history: ConversationHistory,
	record?: (user: string, assistant: string) => void,
): string | undefined {
	const output = session.longRun?.completedOutput;
	if (
		!session.pendingTask ||
		session.longRun?.status !== "completed" ||
		typeof output !== "string" ||
		!output.trim()
	) {
		return undefined;
	}
	record?.(session.pendingTask, output);
	history.addExchange(session.pendingTask, output);
	session.pendingTask = undefined;
	delete session.longRun;
	return output;
}

export async function runInteractiveTerminal(options: InteractiveTerminalOptions): Promise<void> {
	const input = options.input ?? process.stdin;
	const inputEvents = input as NodeJS.ReadableStream;
	const output = options.output ?? process.stdout;
	const color = terminalSupportsColor(output);
	let session =
		options.session ??
		createInteractiveSession(options.cwd, options.model, options.thinkingMode, options.serviceTier);
	if (
		(session.status === "active" || session.status === "running") &&
		session.ownerPid !== undefined &&
		session.ownerPid !== process.pid
	) {
		throw new Error(`Session ${session.id} is already active in process ${session.ownerPid}.`);
	}
	let sessionLease: SessionLease | undefined = await acquireSessionLease(session.id);
	const recoveredSession = session.status === "interrupted";
	const rl = readline.createInterface({ input, output, terminal: "isTTY" in output && output.isTTY === true });
	let inputClosed = false;
	let interfaceClosed = false;
	let activeQuestion: AbortController | undefined;
	const closeInput = (): void => {
		if (interfaceClosed) return;
		interfaceClosed = true;
		activeQuestion?.abort("Terminal closed");
		rl.close();
		input.pause();
	};
	let model = options.model;
	let thinkingMode = resolveDefaultThinkingMode(model, session.thinkingMode);
	let serviceTier = resolveServiceTier(model, session.serviceTier);
	let cwd = path.resolve(session.cwd);
	/** Full verbatim transcript — independent of the compacted live window. */
	let transcript: AgentConversationMessage[] = [...session.messages];
	const initialCovered = Math.min(session.digest?.coveredMessages ?? 0, transcript.length);
	const history = new ConversationHistory(transcript.slice(initialCovered));
	const recordExchange = (user: string, assistant: string): void => {
		transcript.push({ role: "user", text: user }, { role: "assistant", text: assistant });
	};
	const compactLiveHistory = (currentTask = ""): void => {
		const safetyBudget = resolveDigestBudget(model.contextWindow);
		const workingBudget = resolveHistoryWorkingBudget(model.contextWindow, currentTask.length);
		const digestBudget = {
			trigger: Math.min(safetyBudget.trigger, workingBudget.trigger),
			keepRecent: Math.min(safetyBudget.keepRecent, workingBudget.keepRecent),
			maxDigest: Math.min(safetyBudget.maxDigest, workingBudget.maxDigest),
		};
		if (history.characters <= digestBudget.trigger) return;
		const { keep, evict } = partitionForDigest(history.snapshot(), digestBudget.keepRecent);
		if (evict.length === 0) return;
		const coveredBefore = Math.min(session.digest?.coveredMessages ?? 0, transcript.length);
		session.digest = {
			text: rollDigest(session.digest?.text, evict, digestBudget.maxDigest),
			updatedAt: Date.now(),
			coveredMessages: Math.min(transcript.length, coveredBefore + evict.length),
		};
		history.replace(keep);
	};
	const recoveredOutput = recoveredSession ? recoverCompletedExchange(session, history, recordExchange) : undefined;
	compactLiveHistory();
	let showTools = true;
	let verbose = false;
	const sessionApprovedShellCommands = new Set<string>();
	let adaptive = options.adaptive;
	let pendingResume =
		recoveredSession && session.pendingTask && (!session.longRun || session.longRun.status === "interrupted")
			? session.pendingTask
			: undefined;
	let runningTask = false;
	let activeController: AbortController | undefined;
	let terminating = false;
	const onInputClose = (): void => {
		inputClosed = true;
		interfaceClosed = true;
		activeQuestion?.abort("Terminal input closed");
		if (runningTask && !terminating) activeController?.abort("Terminal input closed");
	};
	rl.once("close", onInputClose);
	const onReadlineInterrupt = (): void => {
		if (runningTask) activeController?.abort("Interrupted by user");
	};
	const onRawInput = (chunk: unknown): void => {
		if (!runningTask) return;
		const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
		if (text.includes("\u0003")) activeController?.abort("Interrupted by user");
	};
	rl.on("SIGINT", onReadlineInterrupt);
	inputEvents.on("data", onRawInput);
	const write = (value = ""): void => {
		output.write(`${value}\n`);
	};
	const persist = async (status: InteractiveSession["status"] = session.status): Promise<void> => {
		session.cwd = cwd;
		session.modelId = `${model.provider}/${model.id}`;
		session.thinkingMode = thinkingMode;
		if (serviceTier) session.serviceTier = serviceTier;
		else delete session.serviceTier;
		// Persist the full transcript; the live (compacted) window is rebuild-time
		// derived from digest + recent messages instead of replacing history.
		session.messages = [...transcript];
		if (status === "active" || status === "running") session.ownerPid = process.pid;
		else delete session.ownerPid;
		session.status = status;
		await options.saveSession(session);
	};
	const selectSession = async (selected: InteractiveSession): Promise<void> => {
		if (
			(selected.status === "active" || selected.status === "running") &&
			selected.ownerPid !== undefined &&
			selected.ownerPid !== process.pid
		) {
			throw new Error(`Session ${selected.id} is already active in process ${selected.ownerPid}.`);
		}
		const nextLease = await acquireSessionLease(selected.id);
		try {
			const nextModel = resolveModel(selected.modelId, options.models);
			await sessionLease?.release();
			sessionLease = nextLease;
			session = selected;
			model = nextModel;
			thinkingMode = resolveDefaultThinkingMode(nextModel, selected.thinkingMode);
			serviceTier = resolveServiceTier(nextModel, selected.serviceTier);
			cwd = path.resolve(selected.cwd);
			transcript = [...selected.messages];
			const covered = Math.min(selected.digest?.coveredMessages ?? 0, transcript.length);
			history.replace(transcript.slice(covered));
			const selectedRecoveredOutput = recoverCompletedExchange(selected, history, recordExchange);
			compactLiveHistory();
			pendingResume =
				selected.pendingTask && (!selected.longRun || selected.longRun.status === "interrupted")
					? selected.pendingTask
					: undefined;
			if (selectedRecoveredOutput) {
				write("recovered result ›");
				write(selectedRecoveredOutput);
				write();
			}
		} catch (error) {
			await nextLease.release();
			throw error;
		}
	};
	const question = async (prompt: string): Promise<string | undefined> => {
		if (interfaceClosed) return undefined;
		const controller = new AbortController();
		activeQuestion = controller;
		try {
			return await rl.question(prompt, { signal: controller.signal });
		} catch {
			return undefined;
		} finally {
			if (activeQuestion === controller) activeQuestion = undefined;
		}
	};
	const printStatus = (): void => {
		write(`model      ${model.id}`);
		write(`thinking   ${thinkingMode}`);
		write(`tier       ${serviceTier ?? "standard"}`);
		write(`workspace  ${shortenedPath(cwd)}`);
		write(`context    ${history.turns} turns · ${history.characters.toLocaleString()} chars`);
		if (session.contextState) {
			write(
				`durable    ${session.contextState.userGoals.length} goals · ${session.contextState.verifiedFacts.length} facts · ${session.contextState.artifacts.length} artifacts · ${(session.contextState.ledger ?? []).length} ledger`,
			);
		}
		write(`session    ${session.id} · ${session.status}`);
		if (session.pendingTask) write(`pending    ${session.pendingTask.replace(/\s+/g, " ").slice(0, 100)}`);
		const authentication = options.authentication?.(model);
		if (authentication) write(`auth       ${authentication}`);
		write(`adaptive   ${adaptive ? "on" : "off"}`);
		if (session.longRun) {
			write(
				`long-run   ${session.longRun.status} · round ${session.longRun.currentRound}/${session.longRun.maxRounds}`,
			);
		}
	};

	const onTermination = (): void => {
		if (terminating) return;
		terminating = true;
		activeController?.abort("Terminal closed");
		closeInput();
	};
	process.once("SIGTERM", onTermination);
	process.once("SIGHUP", onTermination);

	try {
		await persist("active");
		write(styled(TERMINAL_LOGO, "1;36", color));
		write(`${model.name} · ${thinkingMode} · ${serviceTier ?? "standard"} · ${shortenedPath(cwd)}`);
		write(`Session ${session.id}${recoveredSession ? " recovered after interruption" : ""}.`);
		write("Lightweight runtime; full interactive workflow. /help for commands.");
		write();
		if (recoveredOutput) {
			write("recovered result ›");
			write(recoveredOutput);
			write();
		}
		while (true) {
			const line = pendingResume ?? (await question(styled("you › ", "1;32", color)));
			if (pendingResume) write(`resuming › ${pendingResume.replace(/\s+/g, " ").slice(0, 100)}`);
			pendingResume = undefined;
			if (line === undefined) break;
			let action = parseInteractiveInput(line);
			if (action.type === "empty") continue;
			if (action.type === "exit") break;
			if (action.type === "help") {
				write(HELP);
				continue;
			}
			if (action.type === "unknown") {
				write(`Unknown command '/${action.command}'. Use /help.`);
				continue;
			}
			if (action.type === "status") {
				printStatus();
				continue;
			}
			if (action.type === "search") {
				if (!options.searchSessions) {
					write("Conversation search is unavailable.");
					continue;
				}
				const query = action.value ?? (await question("search › "))?.trim();
				if (!query) continue;
				const matches = await options.searchSessions(query, cwd);
				if (matches.length === 0) {
					write("No matching conversations in this workspace.");
					continue;
				}
				for (const match of matches) {
					write(
						`${match.session.id} · ${new Date(match.session.updatedAt).toLocaleString()} · ${match.role} · ${shortenedPath(match.session.cwd)}`,
					);
					write(`  ${match.excerpt}`);
				}
				continue;
			}
			if (action.type === "adaptive") {
				const value = action.value?.toLowerCase() ?? "status";
				if (value === "status") {
					write(`Adaptive learning ${adaptive ? "on" : "off"}.`);
					continue;
				}
				if (value !== "on" && value !== "off" && value !== "reset") {
					write("Expected /adaptive status, on, off, or reset.");
					continue;
				}
				const reset = value === "reset";
				adaptive = reset ? true : value === "on";
				await options.setAdaptive(adaptive, reset);
				write(
					reset
						? "Adaptive profiles and saved preferences reset; learning is on."
						: `Adaptive learning ${adaptive ? "on" : "off"}.`,
				);
				continue;
			}
			if (action.type === "clear") {
				history.clear();
				transcript = [];
				delete session.digest;
				delete session.contextState;
				session.pendingTask = undefined;
				delete session.longRun;
				await persist("active");
				write("Conversation context cleared.");
				continue;
			}
			if (action.type === "new") {
				await persist("closed");
				const nextSession = createInteractiveSession(cwd, model, thinkingMode, serviceTier);
				const nextLease = await acquireSessionLease(nextSession.id);
				await sessionLease?.release();
				sessionLease = nextLease;
				session = nextSession;
				history.clear();
				transcript = [];
				await persist("active");
				write(`Started session ${session.id}.`);
				continue;
			}
			if (action.type === "sessions") {
				if (!options.listSessions || !options.loadSession) {
					write("Session selection is unavailable.");
					continue;
				}
				const sessions = await options.listSessions();
				if (sessions.length === 0) {
					write("No resumable sessions.");
					continue;
				}
				for (const [index, candidate] of sessions.entries()) {
					const marker = candidate.id === session.id ? "*" : " ";
					write(
						`${marker} ${index + 1}. ${new Date(candidate.updatedAt).toLocaleString()} · ${candidate.status} · ${candidate.turns} turns · ${shortenedPath(candidate.cwd)}`,
					);
					if (candidate.preview) write(`     ${candidate.preview}`);
				}
				const selection = (await question("session › "))?.trim();
				if (!selection) continue;
				const selectedSummary = /^\d+$/.test(selection)
					? sessions[Number(selection) - 1]
					: sessions.find(candidate => candidate.id === selection);
				if (!selectedSummary) {
					write("Unknown session selection.");
					continue;
				}
				try {
					await persist(runningTask ? "interrupted" : "closed");
					await selectSession(await options.loadSession(selectedSummary.id));
					await persist("active");
					write(`Resumed session ${session.id} · ${model.name} · ${shortenedPath(cwd)}.`);
				} catch (error) {
					await persist("active");
					write(`Cannot resume session: ${error instanceof Error ? error.message : String(error)}`);
				}
				continue;
			}
			if (action.type === "tools") {
				try {
					showTools = parseToggle(action.value, showTools);
					write(`Tool activity ${showTools ? "shown" : "hidden"}.`);
				} catch (error) {
					write(error instanceof Error ? error.message : String(error));
				}
				continue;
			}
			if (action.type === "verbose") {
				try {
					verbose = parseToggle(action.value, verbose);
					write(`Verbose routing ${verbose ? "enabled" : "disabled"}.`);
				} catch (error) {
					write(error instanceof Error ? error.message : String(error));
				}
				continue;
			}
			if (action.type === "model") {
				const models = options.models;
				let selection = action.value;
				if (!selection) {
					for (const [index, candidate] of models.entries()) {
						const marker = modelReference(candidate) === modelReference(model) ? "*" : " ";
						write(`${marker} ${index + 1}. ${candidate.name} (${modelReference(candidate)})`);
					}
					selection = supportsKeyboardSelection(input, output)
						? await selectModelWithKeyboard(input, output, rl, models, model)
						: (await question("model › "))?.trim();
				}
				if (!selection) continue;
				try {
					const nextModel = resolveModelSelection(selection, models);
					const nextThinkingMode = resolveDefaultThinkingMode(nextModel, thinkingMode);
					const nextServiceTier = resolveServiceTier(nextModel, serviceTier);
					model = nextModel;
					thinkingMode = nextThinkingMode;
					serviceTier = nextServiceTier;
					await options.savePreferences(model, thinkingMode, serviceTier);
					await persist(session.status);
					write(
						`Using ${model.name} · ${thinkingMode} · ${serviceTier ?? "standard"}. Conversation context retained.`,
					);
				} catch (error) {
					write(error instanceof Error ? error.message : String(error));
				}
				continue;
			}
			if (action.type === "effort") {
				const available = supportedThinkingModes(model);
				let selection = action.value;
				if (!selection) {
					write(`Available: ${available.join(", ")}`);
					selection = (await question("effort › "))?.trim();
				}
				if (!selection) continue;
				try {
					const selected = selection as ThinkingMode;
					assertModelSupportsThinkingMode(model, selected);
					thinkingMode = selected;
					await options.savePreferences(model, thinkingMode, serviceTier);
					await persist(session.status);
					write(`Thinking mode: ${thinkingMode}.`);
				} catch (error) {
					write(error instanceof Error ? error.message : String(error));
				}
				continue;
			}
			if (action.type === "tier") {
				let selection = action.value;
				if (!selection) {
					write(`Available: none${model.serviceTiers?.length ? `, ${model.serviceTiers.join(", ")}` : ""}`);
					selection = (await question("tier › "))?.trim();
				}
				if (!selection) continue;
				try {
					if (selection === "none") serviceTier = undefined;
					else {
						const selected = selection as ServiceTier;
						assertModelSupportsServiceTier(model, selected);
						serviceTier = selected;
					}
					await options.savePreferences(model, thinkingMode, serviceTier);
					await persist(session.status);
					write(`Service tier: ${serviceTier ?? "standard"}.`);
				} catch (error) {
					write(error instanceof Error ? error.message : String(error));
				}
				continue;
			}
			if (action.type === "fast") {
				try {
					const enabled = parseToggle(action.value, serviceTier === "priority");
					if (enabled) assertModelSupportsServiceTier(model, "priority");
					serviceTier = enabled ? "priority" : undefined;
					await options.savePreferences(model, thinkingMode, serviceTier);
					await persist(session.status);
					write(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				} catch (error) {
					write(error instanceof Error ? error.message : String(error));
				}
				continue;
			}
			if (action.type === "cd") {
				if (!action.path) {
					write(shortenedPath(cwd));
					continue;
				}
				const next = path.resolve(cwd, action.path);
				try {
					const stat = await fs.stat(next);
					if (!stat.isDirectory()) throw new Error("Not a directory.");
					await persist("closed");
					const nextSession = createInteractiveSession(next, model, thinkingMode, serviceTier);
					const nextLease = await acquireSessionLease(nextSession.id);
					await sessionLease?.release();
					sessionLease = nextLease;
					cwd = next;
					history.clear();
					transcript = [];
					session = nextSession;
					await persist("active");
					write(`Workspace: ${shortenedPath(cwd)}. Started session ${session.id}.`);
				} catch (error) {
					write(`Cannot use workspace: ${error instanceof Error ? error.message : String(error)}`);
				}
				continue;
			}
			if (action.type === "shell") {
				const exitCode = await runLocalShell(action.command, cwd);
				write(`exit ${exitCode}`);
				continue;
			}
			if (action.type === "paste") {
				write("Paste the task. Finish with a single '.' line.");
				const lines: string[] = [];
				while (true) {
					const pasted = await question("│ ");
					if (pasted === undefined || pasted === ".") break;
					lines.push(pasted);
				}
				const task = lines.join("\n").trim();
				if (!task) continue;
				action = { type: "task", task };
			}
			if (action.type !== "task") continue;

			// Economic working-set compaction happens before request construction, so
			// the agent loop never has to bluntly hide undigested history.
			compactLiveHistory(action.task);
			const controller = new AbortController();
			activeController = controller;
			if (inputClosed || terminating) {
				controller.abort(inputClosed ? "Terminal input closed" : "Terminal closed");
			}
			const onInterrupt = (): void => controller.abort("Interrupted by user");
			process.once("SIGINT", onInterrupt);
			const reporter = new TaskTerminalReporter({ output, interactive: true, showTools, verbose });
			runningTask = true;
			const resumableCheckpoint =
				session.pendingTask === action.task && session.longRun?.status === "interrupted"
					? session.longRun
					: undefined;
			session.pendingTask = action.task;
			if (!resumableCheckpoint) delete session.longRun;
			await persist("running");
			try {
				const result = await options.runTask({
					task: action.task,
					sessionId: session.id,
					model,
					thinkingMode,
					...(serviceTier ? { serviceTier } : {}),
					cwd,
					conversation: session.digest?.text
						? [
								{
									role: "user" as const,
									text: `<session-digest>\n${session.digest.text}\n</session-digest>\n(Distilled memory of earlier exchanges in this session. The raw transcript stays fully searchable.)`,
								},
								{
									role: "assistant" as const,
									text: "Digest acknowledged. Earlier-session context retained.",
								},
								...history.snapshot(),
							]
						: history.snapshot(),
					...(session.contextState ? { contextState: structuredClone(session.contextState) } : {}),
					...(resumableCheckpoint ? { checkpoint: resumableCheckpoint } : {}),
					onCheckpoint: async checkpoint => {
						session.longRun = checkpoint;
						session.contextState = updateStructuredContextState(session.contextState, action.task, checkpoint);
						// Durable conversation ledger: host-extracted corrections, invariants
						// and deliverables survive even when raw history is evicted.
						const turnOrdinal = history.turns + 1;
						const extracted: LedgerEntry[] = extractLedgerEntries(action.task, turnOrdinal);
						if (extracted.length > 0) {
							session.contextState = {
								...session.contextState,
								ledger: mergeLedger(session.contextState?.ledger ?? [], extracted),
							};
						}
						await persist("running");
					},
					approveShell: async request => {
						const approvalKey = `${path.resolve(request.cwd)}\u0000${request.command}`;
						if (sessionApprovedShellCommands.has(approvalKey)) return true;
						write(
							`Shell approval required (${request.reason}):\n  ${request.command}\n  workspace: ${shortenedPath(request.cwd)}\n  This command can read files outside the workspace.`,
						);
						const answer = (await question("Approve this command? [y/N] (a = always this exact command): "))
							?.trim()
							.toLowerCase();
						if (answer === "a" || answer === "always") {
							sessionApprovedShellCommands.add(approvalKey);
							return true;
						}
						return answer === "y" || answer === "yes";
					},
					adaptive,
					signal: controller.signal,
					onEvent: event => reporter.onHarnessEvent(event),
					onAgentEvent: event => reporter.onAgentEvent(event),
				});
				if (controller.signal.aborted) {
					throw new Error(
						typeof controller.signal.reason === "string" ? controller.signal.reason : "Interrupted by user",
					);
				}
				reporter.finish(result);
				if (result.output.trim()) {
					recordExchange(action.task, result.output);
					history.addExchange(action.task, result.output);
				}
				compactLiveHistory();
				if (result.success) {
					session.pendingTask = undefined;
					delete session.longRun;
				}
				await persist("active");
			} catch (error) {
				reporter.interrupt();
				await persist("interrupted");
				write(
					controller.signal.aborted
						? "Current task cancelled; session remains recoverable."
						: `Task failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				runningTask = false;
				process.removeListener("SIGINT", onInterrupt);
				activeController = undefined;
			}
			write();
		}
	} finally {
		process.removeListener("SIGTERM", onTermination);
		process.removeListener("SIGHUP", onTermination);
		rl.removeListener("close", onInputClose);
		rl.removeListener("SIGINT", onReadlineInterrupt);
		inputEvents.removeListener("data", onRawInput);
		try {
			if (terminating) {
				await persist(session.status === "interrupted" ? "interrupted" : "closed");
			} else if (!runningTask && session.status !== "interrupted") {
				await persist("closed");
			}
		} finally {
			closeInput();
			await sessionLease?.release();
		}
	}
}
