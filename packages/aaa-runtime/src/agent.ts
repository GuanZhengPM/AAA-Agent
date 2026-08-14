import type { z } from "zod/v4";
import { activeTokenCount, addUsageMetrics, createEmptyUsageMetrics } from "./metrics";
import type { AgentTurnProvider } from "./provider";
import type { AgentRunDiagnostics, Effort, Model, ServiceTier, UsageMetrics } from "./types";

export interface ToolResultContent {
	type: "text";
	text: string;
}

export interface ToolResult {
	content: ToolResultContent[];
	details?: Record<string, unknown>;
	isError?: boolean;
}

export interface AgentTool {
	name: string;
	label: string;
	description: string;
	parameters: z.ZodType;
	sideEffect?: "none" | "workspace" | "unrestricted";
	execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<ToolResult>;
}

export interface AgentConversationMessage {
	role: "user" | "assistant";
	text: string;
}

export type AgentSessionEvent =
	| { type: "turn_started"; turn: number }
	| { type: "text_delta"; delta: string }
	| { type: "policy_escalated"; reason: string; toolCount: number }
	| { type: "context_compacted"; removedCharacters: number; retainedCharacters: number }
	| { type: "tool_started"; callId: string; name: string; arguments: unknown }
	| {
			type: "tool_completed";
			callId: string;
			name: string;
			success: boolean;
			durationMs: number;
			details?: Record<string, unknown>;
			error?: string;
	  };

export interface AgentSessionOptions {
	model: Model;
	provider: AgentTurnProvider;
	cwd: string;
	systemPrompt: string;
	userPrompt: string;
	tools: AgentTool[];
	escalationTools?: AgentTool[];
	policy: {
		reasoningEffort: Effort;
		disableReasoning?: boolean;
		toolBudget: number;
		maxTurns: number;
		maxToolCalls?: number;
		maxTotalTokens?: number;
		maxRepeatedToolCalls?: number;
		maxConsecutiveToolFailures?: number;
	};
	serviceTier?: ServiceTier;
	signal: AbortSignal;
	history?: readonly AgentConversationMessage[];
	onEvent?: (event: AgentSessionEvent) => void;
}

export interface AgentSessionResult {
	success: boolean;
	output: string;
	usage: UsageMetrics;
	diagnostics: AgentRunDiagnostics;
	workspaceMutated: boolean;
	unknownShellEffects: boolean;
	error?: string;
}

function toolResultText(result: ToolResult): string {
	return result.content.map(block => block.text).join("\n");
}

function replayableOutput(items: readonly Record<string, unknown>[]): Record<string, unknown>[] {
	return items.map(item => {
		const { id: _id, status: _status, ...rest } = item;
		return rest;
	});
}

function parseToolArguments(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`Tool arguments are not valid JSON: ${raw.slice(0, 500)}`, { cause: error });
	}
}

function conversationInput(message: AgentConversationMessage): Record<string, unknown> {
	return {
		type: "message",
		role: message.role,
		content: [{ type: message.role === "user" ? "input_text" : "output_text", text: message.text }],
	};
}

const CONTEXT_INPUT_CHARACTERS_PER_TOKEN = 1.5;
const NEWEST_TOOL_OUTPUT_SHARE = 0.6;
const MIN_TOOL_OUTPUT_CHARACTERS = 256;

function inputCharacters(input: readonly Record<string, unknown>[]): number {
	return input.reduce((total, item) => total + JSON.stringify(item).length, 0);
}

function compactExcerpt(text: string, maximum: number): string {
	if (text.length <= maximum) return text;
	const marker = `\n… ${text.length - maximum} earlier characters compacted …\n`;
	const available = Math.max(0, maximum - marker.length);
	const head = Math.ceil(available * 0.7);
	return `${text.slice(0, head)}${marker}${text.slice(text.length - (available - head))}`;
}

function compactAgentInput(
	input: Record<string, unknown>[],
	currentTaskInput: Record<string, unknown>,
	targetCharacters: number,
): { removedCharacters: number; retainedCharacters: number } {
	const before = inputCharacters(input);
	if (before <= targetCharacters) return { removedCharacters: 0, retainedCharacters: before };

	while (inputCharacters(input) > targetCharacters) {
		const currentTaskIndex = input.indexOf(currentTaskInput);
		if (currentTaskIndex < 2 || input[0]?.type !== "message" || input[1]?.type !== "message") break;
		input.splice(0, 2);
	}
	if (inputCharacters(input) <= targetCharacters) {
		const retainedCharacters = inputCharacters(input);
		return { removedCharacters: before - retainedCharacters, retainedCharacters };
	}

	const toolOutputs = input.filter(
		(item): item is Record<string, unknown> & { output: string } =>
			item.type === "function_call_output" && typeof item.output === "string",
	);
	if (toolOutputs.length > 0) {
		const originals = toolOutputs.map(item => item.output);
		const newestOriginal = originals.at(-1) ?? "";
		const currentCharacters = inputCharacters(input);
		const rawOutputCharacters = originals.reduce((total, output) => total + output.length, 0);
		const availableOutputCharacters = Math.max(
			MIN_TOOL_OUTPUT_CHARACTERS,
			targetCharacters - (currentCharacters - rawOutputCharacters),
		);
		let newestLimit =
			toolOutputs.length === 1
				? availableOutputCharacters
				: Math.floor(availableOutputCharacters * NEWEST_TOOL_OUTPUT_SHARE);
		let olderLimit =
			toolOutputs.length === 1
				? newestLimit
				: Math.floor((availableOutputCharacters - newestLimit) / (toolOutputs.length - 1));
		newestLimit = Math.max(MIN_TOOL_OUTPUT_CHARACTERS, newestLimit);
		olderLimit = Math.max(MIN_TOOL_OUTPUT_CHARACTERS, olderLimit);

		for (let attempt = 0; attempt < 3; attempt += 1) {
			for (const [index, item] of toolOutputs.entries()) {
				const maximum = index === toolOutputs.length - 1 ? newestLimit : olderLimit;
				item.output = compactExcerpt(originals[index] ?? "", maximum);
			}
			const excess = inputCharacters(input) - targetCharacters;
			if (excess <= 0) break;
			if (toolOutputs.length > 1) {
				if (olderLimit <= MIN_TOOL_OUTPUT_CHARACTERS) break;
				olderLimit = Math.max(
					MIN_TOOL_OUTPUT_CHARACTERS,
					olderLimit - Math.ceil(excess / (toolOutputs.length - 1)),
				);
			} else {
				newestLimit = Math.max(MIN_TOOL_OUTPUT_CHARACTERS, newestLimit - excess);
			}
		}

		while (inputCharacters(input) > targetCharacters && toolOutputs.length > 1) {
			const oldestOutput = toolOutputs.shift();
			if (!oldestOutput) break;
			const outputIndex = input.indexOf(oldestOutput);
			const callId = oldestOutput.call_id;
			const callIndex = input.findIndex(item => item.type === "function_call" && item.call_id === callId);
			for (const index of [outputIndex, callIndex].sort((left, right) => right - left)) {
				if (index >= 0) input.splice(index, 1);
			}
		}
		const newestOutput = toolOutputs.at(-1);
		if (newestOutput && inputCharacters(input) > targetCharacters) {
			const excess = inputCharacters(input) - targetCharacters;
			newestOutput.output = compactExcerpt(
				newestOriginal,
				Math.max(MIN_TOOL_OUTPUT_CHARACTERS, newestOutput.output.length - excess),
			);
		}
	}

	const retainedCharacters = inputCharacters(input);
	return { removedCharacters: Math.max(0, before - retainedCharacters), retainedCharacters };
}

function contextCharacterTarget(options: AgentSessionOptions): number {
	return Math.max(
		1,
		Math.floor(options.model.contextWindow * CONTEXT_INPUT_CHARACTERS_PER_TOKEN) - options.systemPrompt.length,
	);
}

function assertInputFits(input: readonly Record<string, unknown>[], targetCharacters: number): void {
	const characters = inputCharacters(input);
	if (characters > targetCharacters) {
		throw new Error(
			`Task input exceeds model context after deterministic compaction (${characters} > ${targetCharacters} characters).`,
		);
	}
}

function remainingOutputTokens(
	options: AgentSessionOptions,
	input: readonly Record<string, unknown>[],
	usage: UsageMetrics,
	phase: string,
): number | undefined {
	if (options.policy.maxTotalTokens === undefined) return undefined;
	const estimatedInputTokens = options.systemPrompt.length + inputCharacters(input);
	const remaining = options.policy.maxTotalTokens - activeTokenCount(usage) - estimatedInputTokens;
	if (remaining <= 0) {
		throw new Error(`Token limit ${options.policy.maxTotalTokens} exhausted before ${phase}.`);
	}
	return remaining;
}

export async function runAgentSession(options: AgentSessionOptions): Promise<AgentSessionResult> {
	const sessionId = crypto.randomUUID();
	const currentTaskInput = conversationInput({ role: "user", text: options.userPrompt });
	const input: Record<string, unknown>[] = [...(options.history ?? []).map(conversationInput), currentTaskInput];
	const usage = createEmptyUsageMetrics();
	const diagnostics: AgentRunDiagnostics = {
		toolArgumentFailures: 0,
		unknownToolCalls: 0,
		toolExecutionFailures: 0,
		repeatedToolCalls: 0,
		successfulToolCalls: 0,
		recoveredToolFailures: 0,
		policyEscalations: 0,
		turns: 0,
		tools: {},
	};
	const maxRepeatedToolCalls = Math.max(1, options.policy.maxRepeatedToolCalls ?? 2);
	const maxConsecutiveToolFailures = Math.max(1, options.policy.maxConsecutiveToolFailures ?? 2);
	const maxToolCalls = Math.max(
		options.policy.toolBudget,
		options.policy.maxToolCalls ?? options.policy.toolBudget * 2,
	);
	const fullTools = options.escalationTools ?? options.tools;
	const callCounts = new Map<string, number>();
	let currentTools = options.tools;
	let consecutiveFailures = 0;
	let pendingRecovery = false;
	let toolCalls = 0;
	let lastText = "";
	let toolTargetExceeded = false;
	let workspaceMutated = false;
	let unknownShellEffects = false;

	try {
		for (let turn = 1; turn <= options.policy.maxTurns; turn += 1) {
			diagnostics.turns = turn;
			options.onEvent?.({ type: "turn_started", turn });
			const compaction = compactAgentInput(input, currentTaskInput, contextCharacterTarget(options));
			if (compaction.removedCharacters > 0) {
				options.onEvent?.({ type: "context_compacted", ...compaction });
			}
			assertInputFits(input, contextCharacterTarget(options));
			const maxOutputTokens = remainingOutputTokens(options, input, usage, `turn ${turn}`);
			const result = await options.provider.runTurn({
				model: options.model,
				systemPrompt: options.systemPrompt,
				input,
				tools: currentTools,
				effort: options.policy.reasoningEffort,
				...(options.policy.disableReasoning ? { disableReasoning: true } : {}),
				...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
				sessionId,
				...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
				signal: options.signal,
				onTextDelta(delta: string) {
					options.onEvent?.({ type: "text_delta", delta });
				},
			});
			addUsageMetrics(usage, result.usage);
			if (options.policy.maxTotalTokens !== undefined && activeTokenCount(usage) > options.policy.maxTotalTokens) {
				throw new Error(`Token limit ${options.policy.maxTotalTokens} exceeded by provider usage.`);
			}
			lastText = result.text;
			input.push(...replayableOutput(result.output));
			if (result.toolCalls.length === 0) {
				if (!lastText.trim()) throw new Error("Agent returned no final text");
				return {
					success: true,
					output: lastText,
					usage: { ...usage, toolCalls },
					diagnostics,
					workspaceMutated,
					unknownShellEffects,
				};
			}

			for (const call of result.toolCalls) {
				toolCalls += 1;
				const startedAt = performance.now();
				let rawArguments: unknown = call.arguments;
				try {
					rawArguments = parseToolArguments(call.arguments);
				} catch {}
				options.onEvent?.({
					type: "tool_started",
					callId: call.callId,
					name: call.name,
					arguments: rawArguments,
				});
				let output: string;
				let details: Record<string, unknown> | undefined;
				let success = false;
				diagnostics.tools[call.name] ??= { successes: 0, failures: 0 };
				const toolDiagnostics = diagnostics.tools[call.name];
				const signature = `${call.name}:${call.arguments}`;
				const repeated = (callCounts.get(signature) ?? 0) + 1;
				callCounts.set(signature, repeated);
				if (toolCalls > options.policy.toolBudget && !toolTargetExceeded) {
					toolTargetExceeded = true;
					diagnostics.policyEscalations += 1;
					options.onEvent?.({
						type: "policy_escalated",
						reason: `tool-call target ${options.policy.toolBudget} exceeded`,
						toolCount: currentTools.length,
					});
				}
				if (toolCalls > maxToolCalls) {
					output = `Error: maximum tool-call count ${maxToolCalls} exhausted. Return the best supported final result.`;
				} else if (repeated > maxRepeatedToolCalls) {
					diagnostics.repeatedToolCalls += 1;
					output = `Error: repeated identical tool call blocked after ${maxRepeatedToolCalls} attempts. Change the hypothesis or return the best supported final result.`;
				} else {
					let tool = currentTools.find(candidate => candidate.name === call.name);
					if (!tool) {
						const escalationTool = fullTools.find(candidate => candidate.name === call.name);
						if (escalationTool && currentTools.length < fullTools.length) {
							currentTools = fullTools;
							tool = escalationTool;
							diagnostics.policyEscalations += 1;
							options.onEvent?.({
								type: "policy_escalated",
								reason: `model requested gated tool '${call.name}'`,
								toolCount: currentTools.length,
							});
						}
					}
					if (!tool) {
						diagnostics.unknownToolCalls += 1;
						output = `Error: unknown tool '${call.name}'.`;
					} else {
						try {
							let decoded: unknown;
							try {
								decoded = parseToolArguments(call.arguments);
							} catch (error) {
								diagnostics.toolArgumentFailures += 1;
								throw error;
							}
							let parsed: unknown;
							try {
								parsed = tool.parameters.parse(decoded);
							} catch (error) {
								diagnostics.toolArgumentFailures += 1;
								throw error;
							}
							const toolResult = await tool.execute(call.callId, parsed, options.signal);
							output = toolResultText(toolResult);
							details = toolResult.details;
							success = toolResult.isError !== true;
							if (success && tool.sideEffect === "workspace") workspaceMutated = true;
							if (success && tool.sideEffect === "unrestricted") unknownShellEffects = true;
						} catch (error) {
							output = `Error: ${error instanceof Error ? error.message : String(error)}`;
						}
					}
				}
				if (success) {
					toolDiagnostics.successes += 1;
					diagnostics.successfulToolCalls += 1;
					if (pendingRecovery) diagnostics.recoveredToolFailures += 1;
					pendingRecovery = false;
					consecutiveFailures = 0;
				} else {
					toolDiagnostics.failures += 1;
					if (!output.includes("unknown tool") && !output.includes("arguments")) {
						diagnostics.toolExecutionFailures += 1;
					}
					pendingRecovery = true;
					consecutiveFailures += 1;
					if (consecutiveFailures >= maxConsecutiveToolFailures && currentTools.length < fullTools.length) {
						currentTools = fullTools;
						diagnostics.policyEscalations += 1;
						options.onEvent?.({
							type: "policy_escalated",
							reason: `${consecutiveFailures} consecutive tool failures`,
							toolCount: currentTools.length,
						});
					}
				}
				options.onEvent?.({
					type: "tool_completed",
					callId: call.callId,
					name: call.name,
					success,
					durationMs: performance.now() - startedAt,
					...(details ? { details } : {}),
					...(success ? {} : { error: output.startsWith("Error: ") ? output.slice("Error: ".length) : output }),
				});
				input.push({ type: "function_call_output", call_id: call.callId, output });
			}
			if (consecutiveFailures >= maxConsecutiveToolFailures * 2) {
				throw new Error(
					`Stopped after ${consecutiveFailures} consecutive tool failures; no useful progress was observed`,
				);
			}
		}
		const finalTurn = options.policy.maxTurns + 1;
		diagnostics.turns = finalTurn;
		options.onEvent?.({ type: "turn_started", turn: finalTurn });
		const compaction = compactAgentInput(input, currentTaskInput, contextCharacterTarget(options));
		if (compaction.removedCharacters > 0) {
			options.onEvent?.({ type: "context_compacted", ...compaction });
		}
		assertInputFits(input, contextCharacterTarget(options));
		const maxOutputTokens = remainingOutputTokens(options, input, usage, "finalization");
		const result = await options.provider.runTurn({
			model: options.model,
			systemPrompt: options.systemPrompt,
			input,
			tools: [],
			effort: options.policy.reasoningEffort,
			...(options.policy.disableReasoning ? { disableReasoning: true } : {}),
			...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
			sessionId,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			signal: options.signal,
			onTextDelta(delta: string) {
				options.onEvent?.({ type: "text_delta", delta });
			},
		});
		addUsageMetrics(usage, result.usage);
		if (options.policy.maxTotalTokens !== undefined && activeTokenCount(usage) > options.policy.maxTotalTokens) {
			throw new Error(`Token limit ${options.policy.maxTotalTokens} exceeded by provider usage.`);
		}
		lastText = result.text;
		if (!lastText.trim()) throw new Error(`Maximum execution turn count ${options.policy.maxTurns} exhausted`);
		return {
			success: true,
			output: lastText,
			usage: { ...usage, toolCalls },
			diagnostics,
			workspaceMutated,
			unknownShellEffects,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			output: lastText,
			usage: { ...usage, toolCalls },
			diagnostics,
			workspaceMutated,
			unknownShellEffects,
			error: message,
		};
	}
}
