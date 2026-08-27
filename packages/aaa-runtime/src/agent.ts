import { z } from "zod/v4";
import { resolveWorkingContextCharacters } from "./context-budget";
import { isRecord } from "./guards";
import { activeTokenCount, addUsageMetrics, createEmptyUsageMetrics } from "./metrics";
import type { AgentTurnProvider } from "./provider";
import { withProviderPermit, withTransientRetry } from "./provider-retry";
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
	| { type: "provider_retry"; attempt: number; delayMs: number; error: string }
	| { type: "completion_rejected"; feedback: string }
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

export interface AgentFinalizationCandidate {
	text: string;
	turn: number;
	workspaceMutated: boolean;
	unknownShellEffects: boolean;
}

export interface AgentFinalizationGateResult {
	accepted: boolean;
	feedback?: string;
}

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
	/** Stable logical session id enables provider affinity/cache reuse across turns. */
	sessionId?: string;
	signal: AbortSignal;
	history?: readonly AgentConversationMessage[];
	/** Deterministic host gate; rejection is fed back into the same tool loop. */
	beforeFinalize?: (candidate: AgentFinalizationCandidate) => Promise<AgentFinalizationGateResult>;
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

function isDigestAnchor(item: Record<string, unknown> | undefined): boolean {
	if (item?.type !== "message" || !Array.isArray(item.content)) return false;
	return item.content.some(
		part => isRecord(part) && typeof part.text === "string" && part.text.includes("<session-digest>"),
	);
}

function compactAgentInput(
	input: Record<string, unknown>[],
	currentTaskInput: Record<string, unknown>,
	targetCharacters: number,
): { removedCharacters: number; retainedCharacters: number } {
	const before = inputCharacters(input);
	if (before <= targetCharacters) return { removedCharacters: 0, retainedCharacters: before };

	const pinnedPrefix = isDigestAnchor(input[0]) && input[1]?.type === "message" ? 2 : 0;
	while (inputCharacters(input) > targetCharacters) {
		const currentTaskIndex = input.indexOf(currentTaskInput);
		if (
			currentTaskIndex - pinnedPrefix < 2 ||
			input[pinnedPrefix]?.type !== "message" ||
			input[pinnedPrefix + 1]?.type !== "message"
		)
			break;
		input.splice(pinnedPrefix, 2);
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

function contextCharacterTarget(
	options: AgentSessionOptions,
	charactersPerToken = CONTEXT_INPUT_CHARACTERS_PER_TOKEN,
): number {
	const hardTarget = Math.floor(options.model.contextWindow * charactersPerToken) - options.systemPrompt.length;
	const economicTarget =
		resolveWorkingContextCharacters(options.model.contextWindow, options.userPrompt.length, charactersPerToken) -
		options.systemPrompt.length;
	return Math.max(1, Math.min(hardTarget, economicTarget));
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
	charactersPerToken = CONTEXT_INPUT_CHARACTERS_PER_TOKEN,
): number | undefined {
	if (options.policy.maxTotalTokens === undefined) return undefined;
	// maxTotalTokens is a token budget; do not subtract raw characters from it.
	const estimatedInputTokens = Math.ceil((options.systemPrompt.length + inputCharacters(input)) / charactersPerToken);
	const remaining = options.policy.maxTotalTokens - activeTokenCount(usage) - estimatedInputTokens;
	if (remaining <= 0) {
		throw new Error(`Token limit ${options.policy.maxTotalTokens} exhausted before ${phase}.`);
	}
	return remaining;
}

function providerConcurrencyLimit(options: AgentSessionOptions): number {
	if (options.model.maxConcurrentRequests !== undefined) return options.model.maxConcurrentRequests;
	const identity = `${options.model.provider} ${options.model.family ?? ""} ${options.model.id}`;
	if (/\b(?:glm|z-?ai|zai)\b/i.test(identity)) return 1;
	if (options.model.authChannel === "local") return 8;
	return 4;
}

export async function runAgentSession(options: AgentSessionOptions): Promise<AgentSessionResult> {
	const sessionId = options.sessionId ?? crypto.randomUUID();
	const currentTaskInput = conversationInput({ role: "user", text: options.userPrompt });
	const input: Record<string, unknown>[] = [...(options.history ?? []).map(conversationInput), currentTaskInput];
	const usage = createEmptyUsageMetrics();
	const diagnostics: AgentRunDiagnostics = {
		startedAt: Date.now(),
		providerRequests: 0,
		providerRetries: 0,
		providerLatencyMs: 0,
		providerWaitMs: 0,
		toolLatencyMs: 0,
		contextCompactions: 0,
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
	const outputCache = new Map<string, string>();
	const outputReadSchema = z.object({
		callId: z.string(),
		offset: z.number().int().nonnegative().optional(),
		limit: z.number().int().positive().max(8_000).optional(),
	});
	const outputReadTool: AgentTool = {
		name: "tool_output_read",
		label: "Read tool output",
		description:
			"Read an exact character range from a previously compacted tool result. Use the callId shown in the compaction marker.",
		parameters: outputReadSchema,
		sideEffect: "none",
		async execute(_toolCallId, rawParams) {
			const { callId, offset = 0, limit = 4_000 } = outputReadSchema.parse(rawParams);
			const original = outputCache.get(callId);
			if (original === undefined) {
				return {
					content: [{ type: "text", text: `No cached tool output for callId '${callId}'.` }],
					isError: true,
				};
			}
			const end = Math.min(original.length, offset + limit);
			return {
				content: [
					{
						type: "text",
						text: `[tool-output ${callId} chars ${offset}-${end}/${original.length}]\n${original.slice(offset, end)}`,
					},
				],
				details: { callId, offset, end, totalCharacters: original.length },
			};
		},
	};
	let fullTools = [...(options.escalationTools ?? options.tools)];
	let currentTools = [...options.tools];
	const ensureOutputReadTool = (): void => {
		if (!fullTools.some(tool => tool.name === outputReadTool.name)) fullTools = [...fullTools, outputReadTool];
		if (!currentTools.some(tool => tool.name === outputReadTool.name))
			currentTools = [...currentTools, outputReadTool];
	};
	const compactToolOutputForReplay = (callId: string, toolName: string, output: string): string => {
		if (toolName === outputReadTool.name) return output;
		const maximum = Math.max(
			8_000,
			Math.min(60_000, Math.floor(contextCharacterTarget(options, estimatedCharactersPerToken) * 0.25)),
		);
		if (output.length <= maximum) return output;
		outputCache.set(callId, output);
		ensureOutputReadTool();
		const retrieval = `[full tool output cached: call tool_output_read with callId=${JSON.stringify(callId)}; totalCharacters=${output.length}]\n`;
		const omitted = `\n… middle characters cached …\n`;
		const available = Math.max(0, maximum - retrieval.length - omitted.length);
		const head = Math.ceil(available * 0.7);
		return `${retrieval}${output.slice(0, head)}${omitted}${output.slice(output.length - (available - head))}`;
	};
	const callCounts = new Map<string, number>();
	let consecutiveFailures = 0;
	let pendingRecovery = false;
	let toolCalls = 0;
	let lastText = "";
	let toolTargetExceeded = false;
	let workspaceMutated = false;
	let unknownShellEffects = false;
	let estimatedCharactersPerToken = CONTEXT_INPUT_CHARACTERS_PER_TOKEN;
	let gateRecoveryTurns = 0;
	const MAX_GATE_RECOVERY_TURNS = 2;
	const providerGateKey = [
		options.provider.provider,
		options.provider.identity ?? "default",
		options.model.baseUrl,
	].join("\u0000");
	const runProviderTurn = async (tools: AgentTool[], maxOutputTokens: number | undefined) =>
		await withTransientRetry(
			options.signal,
			async () => {
				diagnostics.providerRequests = (diagnostics.providerRequests ?? 0) + 1;
				const startedAt = performance.now();
				try {
					const result = await withProviderPermit(
						providerGateKey,
						providerConcurrencyLimit(options),
						options.signal,
						() =>
							options.provider.runTurn({
								model: options.model,
								systemPrompt: options.systemPrompt,
								input,
								tools,
								effort: options.policy.reasoningEffort,
								...(options.policy.disableReasoning ? { disableReasoning: true } : {}),
								...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
								sessionId,
								...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
								signal: options.signal,
								onTextDelta(delta: string) {
									diagnostics.firstTokenAt ??= Date.now();
									options.onEvent?.({ type: "text_delta", delta });
								},
							}),
						waitMs => {
							diagnostics.providerWaitMs = (diagnostics.providerWaitMs ?? 0) + waitMs;
						},
					);
					const observedInputTokens =
						result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens;
					if (observedInputTokens > 0) {
						const toolCharacters = tools.reduce(
							(total, tool) => total + tool.name.length + tool.description.length + 400,
							0,
						);
						const observed =
							(options.systemPrompt.length + inputCharacters(input) + toolCharacters) / observedInputTokens;
						if (observed >= 0.5 && observed <= 8) {
							estimatedCharactersPerToken = Math.max(
								0.75,
								Math.min(6, estimatedCharactersPerToken * 0.75 + observed * 0.25),
							);
							diagnostics.estimatedCharactersPerToken = estimatedCharactersPerToken;
						}
					}
					return result;
				} finally {
					diagnostics.providerLatencyMs = (diagnostics.providerLatencyMs ?? 0) + (performance.now() - startedAt);
				}
			},
			(attempt, delayMs, error) => {
				diagnostics.providerRetries = (diagnostics.providerRetries ?? 0) + 1;
				options.onEvent?.({
					type: "provider_retry",
					attempt,
					delayMs,
					error: error instanceof Error ? error.message : String(error),
				});
			},
		);

	try {
		for (let turn = 1; turn <= options.policy.maxTurns + gateRecoveryTurns; turn += 1) {
			diagnostics.turns = turn;
			options.onEvent?.({ type: "turn_started", turn });
			const targetCharacters = contextCharacterTarget(options, estimatedCharactersPerToken);
			const compaction = compactAgentInput(input, currentTaskInput, targetCharacters);
			if (compaction.removedCharacters > 0) {
				diagnostics.contextCompactions = (diagnostics.contextCompactions ?? 0) + 1;
				options.onEvent?.({ type: "context_compacted", ...compaction });
			}
			assertInputFits(input, targetCharacters);
			const maxOutputTokens = remainingOutputTokens(
				options,
				input,
				usage,
				`turn ${turn}`,
				estimatedCharactersPerToken,
			);
			const result = await runProviderTurn(currentTools, maxOutputTokens);
			addUsageMetrics(usage, result.usage);
			if (options.policy.maxTotalTokens !== undefined && activeTokenCount(usage) > options.policy.maxTotalTokens) {
				throw new Error(`Token limit ${options.policy.maxTotalTokens} exceeded by provider usage.`);
			}
			lastText = result.text;
			input.push(...replayableOutput(result.output));
			if (result.toolCalls.length === 0) {
				if (!lastText.trim()) throw new Error("Agent returned no final text");
				const gate = await options.beforeFinalize?.({
					text: lastText,
					turn,
					workspaceMutated,
					unknownShellEffects,
				});
				if (gate && !gate.accepted) {
					const feedback = gate.feedback?.trim() || "Host completion checks rejected this result.";
					if (gateRecoveryTurns >= MAX_GATE_RECOVERY_TURNS) {
						throw new Error(`Host completion gate remained unsatisfied: ${feedback}`);
					}
					gateRecoveryTurns += 1;
					pendingRecovery = true;
					options.onEvent?.({ type: "completion_rejected", feedback });
					input.push(
						conversationInput({
							role: "user",
							text: `<host-completion-gate>\n${feedback}\n</host-completion-gate>\nContinue using tools until every host check passes; do not merely restate the claim.`,
						}),
					);
					continue;
				}
				return {
					success: true,
					output: lastText,
					usage: { ...usage, toolCalls },
					diagnostics,
					workspaceMutated,
					unknownShellEffects,
				};
			}

			type PrefetchedTool = {
				startedAt: number;
				settled: Promise<{ result: ToolResult } | { error: unknown }>;
			};
			const prefetched = new Map<string, PrefetchedTool>();
			if (result.toolCalls.length > 1 && toolCalls + result.toolCalls.length <= maxToolCalls) {
				const candidates = result.toolCalls.map(call => {
					try {
						const tool = currentTools.find(candidate => candidate.name === call.name);
						if (tool?.sideEffect !== "none") return undefined;
						const decoded = parseToolArguments(call.arguments);
						const parsed = tool.parameters.parse(decoded);
						const signature = `${call.name}:${call.arguments}`;
						if ((callCounts.get(signature) ?? 0) + 1 > maxRepeatedToolCalls) return undefined;
						return { call, tool, parsed, decoded };
					} catch {
						return undefined;
					}
				});
				if (candidates.every((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))) {
					diagnostics.firstActionAt ??= Date.now();
					for (const candidate of candidates) {
						options.onEvent?.({
							type: "tool_started",
							callId: candidate.call.callId,
							name: candidate.call.name,
							arguments: candidate.decoded,
						});
						const startedAt = performance.now();
						prefetched.set(candidate.call.callId, {
							startedAt,
							settled: Promise.resolve(
								candidate.tool.execute(candidate.call.callId, candidate.parsed, options.signal),
							).then(
								result => ({ result }),
								error => ({ error }),
							),
						});
					}
				}
			}

			for (const call of result.toolCalls) {
				toolCalls += 1;
				const prepared = prefetched.get(call.callId);
				const startedAt = prepared?.startedAt ?? performance.now();
				diagnostics.firstActionAt ??= Date.now();
				let rawArguments: unknown = call.arguments;
				try {
					rawArguments = parseToolArguments(call.arguments);
				} catch {}
				if (!prepared) {
					options.onEvent?.({
						type: "tool_started",
						callId: call.callId,
						name: call.name,
						arguments: rawArguments,
					});
				}
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
				} else if (prepared) {
					const settled = await prepared.settled;
					if ("result" in settled) {
						output = toolResultText(settled.result);
						details = settled.result.details;
						success = settled.result.isError !== true;
					} else {
						output = `Error: ${settled.error instanceof Error ? settled.error.message : String(settled.error)}`;
					}
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
							// A shell can mutate before returning a non-zero exit code; risk is
							// therefore independent of the tool's terminal success bit.
							if (tool.sideEffect === "unrestricted" && details?.workspaceMutationRisk !== "none") {
								unknownShellEffects = true;
								workspaceMutated = true;
							}
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
				output = compactToolOutputForReplay(call.callId, call.name, output);
				diagnostics.toolLatencyMs = (diagnostics.toolLatencyMs ?? 0) + (performance.now() - startedAt);
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
		const targetCharacters = contextCharacterTarget(options, estimatedCharactersPerToken);
		const compaction = compactAgentInput(input, currentTaskInput, targetCharacters);
		if (compaction.removedCharacters > 0) {
			diagnostics.contextCompactions = (diagnostics.contextCompactions ?? 0) + 1;
			options.onEvent?.({ type: "context_compacted", ...compaction });
		}
		assertInputFits(input, targetCharacters);
		const maxOutputTokens = remainingOutputTokens(options, input, usage, "finalization", estimatedCharactersPerToken);
		const result = await runProviderTurn([], maxOutputTokens);
		addUsageMetrics(usage, result.usage);
		if (options.policy.maxTotalTokens !== undefined && activeTokenCount(usage) > options.policy.maxTotalTokens) {
			throw new Error(`Token limit ${options.policy.maxTotalTokens} exceeded by provider usage.`);
		}
		lastText = result.text;
		if (!lastText.trim()) throw new Error(`Maximum execution turn count ${options.policy.maxTurns} exhausted`);
		const finalGate = await options.beforeFinalize?.({
			text: lastText,
			turn: finalTurn,
			workspaceMutated,
			unknownShellEffects,
		});
		if (finalGate && !finalGate.accepted) {
			throw new Error(
				`Host completion gate remained unsatisfied at finalization: ${finalGate.feedback ?? "unknown requirement"}`,
			);
		}
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
