import * as os from "node:os";
import { type AdaptiveHarnessEvent, type AdaptiveHarnessResult, isRecord } from "@aaa-agent/runtime";
import type { AdaptiveRuntimeAgentEvent } from "./runtime";

interface WritableOutput {
	write(chunk: string): unknown;
	isTTY?: boolean;
}

export interface TaskTerminalReporterOptions {
	output: WritableOutput;
	statusOutput?: WritableOutput;
	interactive: boolean;
	showTools?: boolean;
	verbose?: boolean;
}

interface ToolDisplay {
	label: string;
	target: string;
}

interface ActiveToolDisplay extends ToolDisplay {
	phaseLabel: string;
}

const ANSI = {
	bold: "\u001b[1m",
	dim: "\u001b[2m",
	green: "\u001b[32m",
	red: "\u001b[31m",
	cyan: "\u001b[36m",
	reset: "\u001b[0m",
};

function shortenPath(value: string): string {
	const home = os.homedir();
	return value === home ? "~" : value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
}

function clamp(value: string, length = 96): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= length ? normalized : `${normalized.slice(0, length - 1)}…`;
}

function argumentString(argumentsValue: unknown, key: string): string | undefined {
	if (!isRecord(argumentsValue)) return undefined;
	const value = argumentsValue[key];
	return typeof value === "string" ? value : undefined;
}

function formatTool(callId: string, name: string, argumentsValue: unknown): [string, ToolDisplay] {
	const label = name.charAt(0).toUpperCase() + name.slice(1);
	let target = "";
	if (name === "read" || name === "write" || name === "edit") {
		target = argumentString(argumentsValue, "path") ?? "";
	} else if (name === "glob") {
		target = argumentString(argumentsValue, "pattern") ?? "";
	} else if (name === "search") {
		const pattern = argumentString(argumentsValue, "pattern") ?? "";
		const files = argumentString(argumentsValue, "files");
		target = files ? `${pattern} in ${files}` : pattern;
	} else if (name === "shell") {
		target = argumentString(argumentsValue, "command") ?? "";
	}
	return [callId, { label, target: shortenPath(clamp(target)) }];
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
	return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function formatTokens(tokens: number): string {
	return tokens < 1_000 ? `${tokens}` : `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

export class TaskTerminalReporter {
	#output: WritableOutput;
	#statusOutput: WritableOutput;
	#interactive: boolean;
	#showTools: boolean;
	#verbose: boolean;
	#color: boolean;
	#assistantSegment = false;
	#textSeen = false;
	#verificationStarted = false;
	#tools = new Map<string, ActiveToolDisplay>();

	constructor(options: TaskTerminalReporterOptions) {
		this.#output = options.output;
		this.#statusOutput = options.statusOutput ?? options.output;
		this.#interactive = options.interactive;
		this.#showTools = options.showTools ?? true;
		this.#verbose = options.verbose ?? false;
		this.#color = Boolean(options.output.isTTY && !process.env.NO_COLOR);
	}

	#style(value: string, code: string): string {
		return this.#color ? `${code}${value}${ANSI.reset}` : value;
	}

	#status(value: string): void {
		this.#endAssistantSegment();
		this.#statusOutput.write(`${this.#style(value, ANSI.dim)}\n`);
	}

	#endAssistantSegment(): void {
		if (!this.#assistantSegment) return;
		this.#output.write("\n");
		this.#assistantSegment = false;
	}

	onHarnessEvent(event: AdaptiveHarnessEvent): void {
		if (event.type === "routed") {
			const policy = event.decision.policy;
			const thinkingMode = policy.disableReasoning ? "off" : policy.reasoningEffort;
			this.#status(`route › ${policy.lane} · ${thinkingMode} · verification ${policy.verification}`);
			if (this.#verbose) {
				for (const reason of event.decision.reasons) this.#status(`  ${reason}`);
			}
			return;
		}
		if (event.type === "round_started") {
			this.#verificationStarted = false;
			if (event.maxRounds > 1) this.#status(`round › ${event.round}/${event.maxRounds}`);
			if (event.recovery) this.#status(`recovery › ${clamp(event.recovery, 140)}`);
			return;
		}
		if (event.type === "subagents_completed") {
			const succeeded = event.results.filter(result => result.status === "succeeded").length;
			this.#status(`subagents › ${succeeded}/${event.results.length} completed`);
			return;
		}
		if (event.type === "verification_completed") {
			this.#endAssistantSegment();
			const marker = event.result.passed ? "✓" : "✗";
			this.#status(`${marker} verification › ${clamp(event.result.summary, 140)}`);
		}
	}

	onAgentEvent(runtimeEvent: AdaptiveRuntimeAgentEvent): void {
		const { phase, event } = runtimeEvent;
		if (event.type === "turn_started") {
			if (phase === "verifier" && !this.#verificationStarted) {
				this.#endAssistantSegment();
				this.#status("verification › checking workspace evidence");
				this.#verificationStarted = true;
			} else if (phase === "subagent" && event.turn === 1) {
				this.#status(`subagent › ${runtimeEvent.subagentId ?? "research"}`);
			}
			return;
		}
		if (event.type === "text_delta") {
			if (phase !== "primary") return;
			if (!this.#assistantSegment) {
				this.#output.write(this.#interactive ? `${this.#style("assistant ›", ANSI.cyan)} ` : "");
				this.#assistantSegment = true;
			}
			this.#output.write(event.delta);
			if (event.delta.trim()) this.#textSeen = true;
			return;
		}
		if (event.type === "policy_escalated") {
			this.#endAssistantSegment();
			this.#status(`policy › ${event.reason} · ${event.toolCount} tools available`);
			return;
		}
		if (event.type === "context_compacted") {
			this.#endAssistantSegment();
			this.#status(
				`context › compacted ${event.removedCharacters.toLocaleString()} chars · ${event.retainedCharacters.toLocaleString()} retained`,
			);
			return;
		}
		if (event.type === "tool_started") {
			if (!this.#showTools) return;
			this.#endAssistantSegment();
			const [callId, display] = formatTool(event.callId, event.name, event.arguments);
			const phaseLabel = phase === "verifier" ? "verify" : phase === "subagent" ? "research" : "tool";
			this.#tools.set(callId, { ...display, phaseLabel });
			this.#status(`${phaseLabel} › ${display.label}${display.target ? ` ${display.target}` : ""} …`);
			return;
		}
		if (event.type === "tool_completed") {
			if (!this.#showTools) return;
			this.#endAssistantSegment();
			const display = this.#tools.get(event.callId) ?? {
				label: event.name,
				target: "",
				phaseLabel: phase === "verifier" ? "verify" : phase === "subagent" ? "research" : "tool",
			};
			this.#tools.delete(event.callId);
			const marker = event.success ? this.#style("✓", ANSI.green) : this.#style("✗", ANSI.red);
			const error = event.error ? ` — ${clamp(event.error, 120)}` : "";
			this.#statusOutput.write(
				`${this.#style(`${display.phaseLabel} ›`, ANSI.dim)} ${display.label}${display.target ? ` ${display.target}` : ""} ${marker} ${formatDuration(event.durationMs)}${error}\n`,
			);
			if (this.#verbose && event.success && event.details) {
				this.#status(`  ${display.label}: ${JSON.stringify(event.details)}`);
			}
		}
	}

	interrupt(): void {
		this.#endAssistantSegment();
		this.#tools.clear();
	}

	finish(result: AdaptiveHarnessResult): void {
		this.#endAssistantSegment();
		if (!this.#textSeen && result.output.trim()) {
			const prefix = this.#interactive ? `${this.#style("assistant ›", ANSI.cyan)} ` : "";
			this.#output.write(`${prefix}${result.output.trim()}\n`);
		}
		const elapsed = formatDuration(result.metrics.completedAt - result.metrics.startedAt);
		const tokens = result.metrics.inputTokens + result.metrics.outputTokens;
		const verification = result.verification
			? ` · ${result.verification.passed ? "verified" : "verification failed"}`
			: "";
		const recovery = result.metrics.recoveryRounds ? ` · ${result.metrics.recoveryRounds} recovery` : "";
		const summary = `${result.success ? "✓ completed" : "✗ failed"} · ${result.lane}${verification}${recovery} · ${result.metrics.toolCalls} tools · ${elapsed} · ${formatTokens(tokens)} tokens`;
		this.#statusOutput.write(`${this.#style(summary, result.success ? ANSI.green : ANSI.red)}\n`);
	}
}
