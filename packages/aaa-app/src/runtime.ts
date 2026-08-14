import { createAdaptiveModelVariant } from "@aaa-agent/providers";
import {
	AdaptiveHarness,
	type AdaptiveHarnessEvent,
	type AdaptiveHarnessResult,
	type AdaptiveOverlayRegistry,
	type AgentConversationMessage,
	type AgentSessionEvent,
	type AgentTool,
	type AgentTurnProvider,
	activeTokenCount,
	createEmptyUsageMetrics,
	Effort,
	type Effort as EffortType,
	type EvidenceRef,
	inferTaskFeatures,
	isRecord,
	type LongRunCheckpoint,
	type Model,
	type ModelCapabilityRegistry,
	type PrimaryExecutionContext,
	runAgentSession,
	type ServiceTier,
	type StructuredContextState,
	type SubagentResult,
	type SubagentTask,
	type ThinkingMode,
	type UsageMetrics,
	type VerificationAssurance,
	type VerificationResult,
} from "@aaa-agent/runtime";
import {
	createAdaptiveToolset,
	createVerificationCheckTool,
	defineVerificationCheck,
	type ShellApprovalRequest,
	type VerificationCheck,
} from "@aaa-agent/workspace";
import Handlebars from "handlebars";
import agentSystemTemplate from "./prompts/agent-system.md" with { type: "text" };
import primaryRequestTemplate from "./prompts/primary-request.md" with { type: "text" };
import subagentDiscoveryTemplate from "./prompts/subagent-discovery.md" with { type: "text" };
import subagentRiskTemplate from "./prompts/subagent-risk.md" with { type: "text" };
import subagentSliceTemplate from "./prompts/subagent-slice.md" with { type: "text" };
import subagentSystemPrompt from "./prompts/subagent-system.md" with { type: "text" };
import verifierRequestTemplate from "./prompts/verifier-request.md" with { type: "text" };
import verifierSystemTemplate from "./prompts/verifier-system.md" with { type: "text" };

export interface AdaptiveRuntimeAgentEvent {
	phase: "primary" | "subagent" | "verifier";
	subagentId?: string;
	event: AgentSessionEvent;
}

export interface AdaptiveVerifierOptions {
	model: Model;
	provider: AgentTurnProvider;
	reasoningConfig: ThinkingMode;
	serviceTier?: ServiceTier;
}

export interface RunAdaptiveTaskOptions {
	task: string;
	model: Model;
	provider: AgentTurnProvider;
	cwd: string;
	reasoningConfig: ThinkingMode;
	serviceTier?: ServiceTier;
	approveShell?: (request: ShellApprovalRequest) => boolean | Promise<boolean>;
	capabilities: ModelCapabilityRegistry;
	overlays: AdaptiveOverlayRegistry;
	conversation?: readonly AgentConversationMessage[];
	contextState?: StructuredContextState;
	verifier?: AdaptiveVerifierOptions;
	additionalTools?: readonly AgentTool[];
	checkpoint?: LongRunCheckpoint;
	onCheckpoint?: (checkpoint: LongRunCheckpoint) => void | Promise<void>;
	adaptive?: boolean;
	signal?: AbortSignal;
	onEvent?: (event: AdaptiveHarnessEvent) => void;
	onAgentEvent?: (event: AdaptiveRuntimeAgentEvent) => void;
}

function render(template: string, values: object): string {
	return Handlebars.compile(template, { noEscape: true })(values);
}

interface StartedToolObservation {
	name: string;
	arguments: unknown;
}

const MAX_PRIMARY_RUNTIME_EVIDENCE = 32;
const CHECK_COMMAND_PATTERN = /\b(?:test|check|lint|build|pytest)\b/i;

interface TokenReservation {
	limit: number;
	settled: boolean;
}

class SharedTokenBudget {
	readonly total: number;
	#available: number;

	constructor(total: number) {
		this.total = Math.max(1, Math.floor(total));
		this.#available = this.total;
	}

	reserve(requested: number, label: string): TokenReservation {
		const limit = Math.min(this.#available, Math.max(1, Math.floor(requested)));
		if (limit <= 0) throw new Error(`Global token budget exhausted before ${label}.`);
		this.#available -= limit;
		return { limit, settled: false };
	}

	settle(reservation: TokenReservation, usage: UsageMetrics): void {
		if (reservation.settled) throw new Error("Token reservation was already settled.");
		reservation.settled = true;
		const unused = Math.max(0, reservation.limit - activeTokenCount(usage));
		this.#available = Math.min(this.total, this.#available + unused);
	}
}

function createRuntimeToolEvidence(
	event: Extract<AgentSessionEvent, { type: "tool_completed" }>,
	started: StartedToolObservation | undefined,
): EvidenceRef | undefined {
	if (!event.success || !started) return undefined;
	const argumentsValue = isRecord(started.arguments) ? started.arguments : {};
	const targetKeys =
		started.name === "shell"
			? ["command"]
			: started.name === "check"
				? ["id"]
				: ["path", "pattern", "query", "files"];
	const target = targetKeys
		.map(key => argumentsValue[key])
		.find((value): value is string => typeof value === "string");
	const exitCode = event.details?.exitCode;
	const summary = [
		`Host completed ${started.name} successfully`,
		target ? `target=${target.slice(0, 1_200)}` : undefined,
		typeof exitCode === "number" ? `exitCode=${exitCode}` : undefined,
	]
		.filter((value): value is string => value !== undefined)
		.join("; ");
	return {
		kind:
			started.name === "check" || (started.name === "shell" && target && CHECK_COMMAND_PATTERN.test(target))
				? "test"
				: started.name === "read" || started.name === "write" || started.name === "edit"
					? "file"
					: "tool",
		ref: `${started.name}:${event.callId}`,
		summary,
	};
}

function createPrimarySystemPrompt(context: PrimaryExecutionContext): string {
	return render(agentSystemTemplate, {
		lane: context.policy.lane,
		goalLevel: context.policy.goalLevel,
		verification: context.policy.verification,
		thinkingMode: context.policy.disableReasoning ? "off" : context.policy.reasoningEffort,
		toolBudget: context.policy.toolBudget,
		maxTurns: context.policy.budget.maxTurns,
		servicePlan: context.model.servicePlan,
		quotaBacked: context.model.servicePlan === "coding-plan" || context.model.servicePlan === "token-plan",
		platform: process.platform,

		round: context.round,
		maxRounds: context.maxRounds,
	});
}

function parseEvidenceRef(value: unknown, allowedKinds: ReadonlySet<EvidenceRef["kind"]>): EvidenceRef | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as { kind?: unknown; ref?: unknown; summary?: unknown };
	if (typeof record.kind !== "string" || !allowedKinds.has(record.kind as EvidenceRef["kind"])) return undefined;
	if (typeof record.ref !== "string") return undefined;
	return {
		kind: record.kind as EvidenceRef["kind"],
		ref: record.ref,
		...(typeof record.summary === "string" ? { summary: record.summary } : {}),
	};
}

function parseVerifierResult(
	output: string,
	usage: UsageMetrics,
	assurance: VerificationAssurance,
	hostEvidence: readonly EvidenceRef[],
): VerificationResult {
	const normalized = output
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	try {
		const value = JSON.parse(normalized) as {
			passed?: unknown;
			summary?: unknown;
			evidence?: unknown;
			goalEvidence?: unknown;
			verifiedFacts?: unknown;
			completedGoalIds?: unknown;
			findings?: unknown;
			unmetCriteria?: unknown;
			recommendedRecovery?: unknown;
			blocked?: unknown;
			integrity?: unknown;
			failureKind?: unknown;
		};
		if (typeof value.passed !== "boolean" || typeof value.summary !== "string") {
			throw new Error("Verifier response lacks passed/summary fields");
		}
		const allowedKinds = new Set<EvidenceRef["kind"]>(["output", "tool", "file", "test", "browser"]);
		const evidence = Array.isArray(value.evidence)
			? value.evidence.flatMap(item => {
					const parsed = parseEvidenceRef(item, allowedKinds);
					return parsed ? [parsed] : [];
				})
			: [];
		const goalEvidence = Array.isArray(value.goalEvidence)
			? value.goalEvidence.flatMap(item => {
					if (!item || typeof item !== "object") return [];
					const record = item as { goalId?: unknown; criterionId?: unknown; evidence?: unknown };
					const parsed = parseEvidenceRef(record.evidence, allowedKinds);
					return typeof record.goalId === "string" && typeof record.criterionId === "string" && parsed
						? [{ goalId: record.goalId, criterionId: record.criterionId, evidence: parsed }]
						: [];
				})
			: [];
		const verifiedFacts = Array.isArray(value.verifiedFacts)
			? value.verifiedFacts.flatMap(item => {
					if (!item || typeof item !== "object") return [];
					const record = item as { statement?: unknown; evidence?: unknown };
					if (typeof record.statement !== "string" || !Array.isArray(record.evidence)) return [];
					const factEvidence = record.evidence.flatMap(candidate => {
						const parsed = parseEvidenceRef(candidate, allowedKinds);
						return parsed ? [parsed] : [];
					});
					return factEvidence.length > 0 ? [{ statement: record.statement, evidence: factEvidence }] : [];
				})
			: [];
		const completedGoalIds = Array.isArray(value.completedGoalIds)
			? value.completedGoalIds.filter((item): item is string => typeof item === "string")
			: undefined;
		const findings = Array.isArray(value.findings)
			? value.findings.flatMap(item => {
					if (!item || typeof item !== "object") return [];
					const record = item as { severity?: unknown; summary?: unknown; evidence?: unknown };
					if (!["info", "warning", "error"].includes(String(record.severity))) return [];
					if (typeof record.summary !== "string") return [];
					return [
						{
							severity: record.severity as "info" | "warning" | "error",
							summary: record.summary,
							evidence: Array.isArray(record.evidence)
								? record.evidence.flatMap(candidate => {
										const parsed = parseEvidenceRef(candidate, allowedKinds);
										return parsed ? [parsed] : [];
									})
								: [],
						},
					];
				})
			: undefined;
		return {
			passed: value.passed,
			summary: value.summary,
			usage,
			assurance,
			hostEvidence: hostEvidence.map(item => structuredClone(item)),
			evidence,
			goalEvidence,
			verifiedFacts,
			...(completedGoalIds ? { completedGoalIds } : {}),
			...(findings ? { findings } : {}),
			...(Array.isArray(value.unmetCriteria)
				? { unmetCriteria: value.unmetCriteria.filter((item): item is string => typeof item === "string") }
				: {}),
			...(typeof value.recommendedRecovery === "string" ? { recommendedRecovery: value.recommendedRecovery } : {}),
			...(typeof value.blocked === "boolean" ? { blocked: value.blocked } : {}),
			...(value.integrity === "clean" || value.integrity === "suspect" || value.integrity === "violation"
				? { integrity: value.integrity }
				: {}),
			...(value.failureKind === "task" ||
			value.failureKind === "integrity" ||
			value.failureKind === "infrastructure" ||
			value.failureKind === "configuration"
				? { failureKind: value.failureKind }
				: {}),
		};
	} catch (error) {
		return {
			passed: false,
			summary: `Verifier returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			usage,
			assurance,
			hostEvidence: hostEvidence.map(item => structuredClone(item)),
			failureKind: "infrastructure",
		};
	}
}

function deriveSubagentTasks(task: string): SubagentTask[] {
	const slices = task
		.split("\n")
		.map(line => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/)?.[1]?.trim())
		.filter((value): value is string => Boolean(value));
	if (slices.length >= 2) {
		return slices.slice(0, 4).map((slice, index) => ({
			id: `slice-${index + 1}`,
			prompt: render(subagentSliceTemplate, { task, slice }),
			mode: "read",
			origin: "user",
			estimatedTokens: 4_000,
		}));
	}
	return [
		{
			id: "discovery",
			prompt: render(subagentDiscoveryTemplate, { task }),
			mode: "read",
			origin: "user",
			estimatedTokens: 5_000,
		},
		{
			id: "risk-review",
			prompt: render(subagentRiskTemplate, { task }),
			mode: "read",
			origin: "user",
			estimatedTokens: 5_000,
		},
	];
}
function resolveSubagentEffort(context: Pick<PrimaryExecutionContext, "model" | "profile">): EffortType {
	const preferred = context.profile.planningHorizon < 0.5 ? Effort.Medium : Effort.Low;
	if (context.model.efforts.includes(preferred)) return preferred;
	return context.model.efforts[0] ?? Effort.Minimal;
}

function resolveVerifierEffort(model: Model, mode: ThinkingMode, fallback: EffortType): EffortType {
	if (mode !== "auto" && mode !== "off" && model.efforts.includes(mode)) return mode;
	if (model.efforts.includes(fallback)) return fallback;
	return model.efforts[0] ?? Effort.Minimal;
}

function verificationAssuranceFor(primary: Model, verifier: Model): VerificationAssurance {
	return primary.provider === verifier.provider && primary.id === verifier.id ? "correlated" : "independent";
}

export async function runAdaptiveTask(options: RunAdaptiveTaskOptions): Promise<AdaptiveHarnessResult> {
	const taskCharacterLimit = Math.max(1, Math.floor(options.model.contextWindow * 1.5 * 0.75));
	if (options.task.length > taskCharacterLimit) {
		throw new Error(
			`Task input exceeds model context (${options.task.length} > ${taskCharacterLimit} characters). Use a file or split the task.`,
		);
	}
	const variant = createAdaptiveModelVariant(options.model, options.reasoningConfig, options.serviceTier);
	const verifier = options.verifier ?? {
		model: options.model,
		provider: options.provider,
		reasoningConfig: options.reasoningConfig,
		...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
	};
	const verificationAssurance = verificationAssuranceFor(options.model, verifier.model);
	const toolset = createAdaptiveToolset(options.cwd, {
		...(options.approveShell ? { approveShell: options.approveShell } : {}),
	});
	const additionalTools = [...(options.additionalTools ?? [])];
	const primaryMinimalTools = [...toolset.minimalTools, ...additionalTools];
	const primaryAllTools = [...toolset.allTools, ...additionalTools];
	const signal = options.signal ?? new AbortController().signal;
	const verificationChecks = new Map<string, VerificationCheck>();
	let nextVerificationCheckId = 1;
	let tokenBudget: SharedTokenBudget | undefined;
	const resolveTokenBudget = (total: number): SharedTokenBudget => {
		tokenBudget ??= new SharedTokenBudget(total);
		return tokenBudget;
	};
	const harness = new AdaptiveHarness({
		capabilities: options.capabilities,
		overlays: options.overlays,
		onEvent: options.onEvent,
		subagentRunner: async (task, context): Promise<SubagentResult> => {
			const budget = resolveTokenBudget(context.budget.totalMaxTokens);
			const reservation = budget.reserve(context.budget.subagentMaxTokens, `Subagent ${task.id}`);
			const session = await runAgentSession({
				model: options.model,
				provider: options.provider,
				cwd: options.cwd,
				systemPrompt: subagentSystemPrompt,
				userPrompt: task.prompt,
				tools: toolset.readonlyTools,
				policy: {
					...(options.reasoningConfig === "off" ? { disableReasoning: true } : {}),
					reasoningEffort: resolveSubagentEffort(context),
					toolBudget: 8,
					maxTurns: context.budget.subagentMaxTurns,
					maxToolCalls: Math.max(8, context.budget.subagentMaxTurns * 2),
					maxTotalTokens: reservation.limit,
					maxRepeatedToolCalls: 2,
					maxConsecutiveToolFailures: 2,
				},
				...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
				signal: context.signal,
				onEvent: event => options.onAgentEvent?.({ phase: "subagent", subagentId: task.id, event }),
			});
			budget.settle(reservation, session.usage);
			return {
				taskId: task.id,
				status: session.success ? "succeeded" : "failed",
				findings: session.output
					? [
							{
								summary: session.output,
								evidence: [{ kind: "subagent", ref: task.id, summary: session.output.slice(0, 500) }],
								confidence: session.success ? 0.75 : 0.25,
							},
						]
					: [],
				unresolved: session.success ? [] : [session.error ?? task.prompt],
				usage: session.usage,
			};
		},
		executor: {
			execute: async context => {
				for (const [command, check] of verificationChecks) {
					verificationChecks.set(command, { ...check, current: false });
				}
				const startedTools = new Map<string, StartedToolObservation>();
				const runtimeEvidence: EvidenceRef[] = [];
				let mutationEpoch = 0;
				const budget = resolveTokenBudget(context.policy.maxTotalTokens);
				const primarySessionLimit =
					context.policy.verification === "none"
						? context.policy.maxTotalTokens
						: Math.floor(context.policy.maxTotalTokens * 0.8);
				const reservation = budget.reserve(primarySessionLimit, `Primary round ${context.round}`);
				const session = await runAgentSession({
					model: options.model,
					provider: options.provider,
					cwd: options.cwd,
					systemPrompt: createPrimarySystemPrompt(context),
					userPrompt: render(primaryRequestTemplate, {
						task: context.task,
						goals: context.goalFrontier,
						subagents: context.subagentResults,
						round: context.round,
						maxRounds: context.maxRounds,
						recoveryGuidance: context.recoveryGuidance,
						facts: context.verifiedFacts,
						artifacts: context.artifacts,
						contextState: context.contextState,
					}),
					tools: context.policy.toolSurface === "minimal" ? primaryMinimalTools : primaryAllTools,
					escalationTools: primaryAllTools,
					policy: {
						reasoningEffort: context.policy.reasoningEffort,
						...(context.policy.disableReasoning ? { disableReasoning: true } : {}),
						toolBudget: context.policy.toolBudget,
						maxTurns: context.policy.budget.maxTurns,
						maxToolCalls: context.policy.maxToolCalls,
						maxTotalTokens: reservation.limit,
						maxRepeatedToolCalls: context.policy.maxRepeatedToolCalls,
						maxConsecutiveToolFailures: context.policy.maxConsecutiveToolFailures,
					},
					...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
					signal: context.signal,
					history: context.round === 1 && !options.checkpoint ? options.conversation : undefined,
					onEvent: event => {
						if (event.type === "tool_started") {
							startedTools.set(event.callId, { name: event.name, arguments: event.arguments });
						} else if (event.type === "tool_completed") {
							const started = startedTools.get(event.callId);
							if (event.success && (started?.name === "write" || started?.name === "edit")) {
								mutationEpoch += 1;
								for (const [command, check] of verificationChecks) {
									verificationChecks.set(command, { ...check, current: false });
								}
							}
							if (
								event.success &&
								started?.name === "shell" &&
								isRecord(started.arguments) &&
								typeof started.arguments.command === "string"
							) {
								const command = started.arguments.command;
								const existing = verificationChecks.get(command);
								const check = defineVerificationCheck(
									existing?.id ?? `primary-check-${nextVerificationCheckId}`,
									command,
								);
								const exitCode = event.details?.exitCode;
								if (check && exitCode === 0) {
									verificationChecks.set(command, {
										...check,
										discoveredRound: context.round,
										primaryExitCode: exitCode,
										current: true,
										mutationEpoch,
									});
									if (!existing) nextVerificationCheckId += 1;
								}
							}
							const evidence = createRuntimeToolEvidence(event, startedTools.get(event.callId));
							if (evidence) runtimeEvidence.push(evidence);
							startedTools.delete(event.callId);
						}
						options.onAgentEvent?.({ phase: "primary", event });
					},
				});
				budget.settle(reservation, session.usage);
				return {
					success: session.success,
					output: session.output || session.error || "Agent produced no final output.",
					usage: session.usage,
					diagnostics: session.diagnostics,
					workspaceMutated: session.workspaceMutated,
					unknownShellEffects: session.unknownShellEffects,
					completedGoalIds: session.success ? context.goalFrontier.map(goal => goal.id) : [],
					evidence: runtimeEvidence.slice(-MAX_PRIMARY_RUNTIME_EVIDENCE),
				};
			},
			verify: async (context, result) => {
				const checks = [...verificationChecks.values()];
				const currentChecks = checks.filter(check => check.current && check.primaryExitCode === 0);
				const deterministicEvidence = (result.evidence ?? []).filter(
					evidence =>
						evidence.kind === "test" &&
						currentChecks.some(check => evidence.summary?.includes(`target=${check.command}`)),
				);
				if (context.policy.verification === "targeted" && deterministicEvidence.length > 0) {
					return {
						passed: true,
						summary: "Accepted current deterministic host check.",
						usage: createEmptyUsageMetrics(),
						assurance: "deterministic",
						hostEvidence: deterministicEvidence,
						evidence: deterministicEvidence,
					};
				}
				const startedTools = new Map<string, StartedToolObservation>();
				const hostEvidence: EvidenceRef[] = [];
				const budget = resolveTokenBudget(context.policy.maxTotalTokens);
				const reservation = budget.reserve(
					Math.ceil(context.policy.maxTotalTokens * 0.2),
					`Verifier round ${context.round}`,
				);
				const session = await runAgentSession({
					model: verifier.model,
					provider: verifier.provider,
					cwd: options.cwd,
					systemPrompt: render(verifierSystemTemplate, { platform: process.platform }),
					userPrompt: render(verifierRequestTemplate, {
						task: context.task,
						output: result.output,
						goals: context.goals,
						round: context.round,
						evidence: result.evidence ?? [],
						checks,
					}),
					tools: [
						...toolset.verificationTools,
						...(checks.length > 0 ? [createVerificationCheckTool(options.cwd, checks)] : []),
					],
					policy: {
						reasoningEffort: resolveVerifierEffort(
							verifier.model,
							verifier.reasoningConfig,
							context.policy.reasoningEffort,
						),
						...(verifier.reasoningConfig === "off" ? { disableReasoning: true } : {}),
						toolBudget: Math.max(4, Math.ceil(context.policy.toolBudget / 2)),
						maxTurns: Math.max(6, Math.ceil(context.policy.budget.maxTurns / 2)),
						maxToolCalls: Math.max(8, context.policy.maxToolCalls),
						maxTotalTokens: reservation.limit,
						maxRepeatedToolCalls: context.policy.maxRepeatedToolCalls,
						maxConsecutiveToolFailures: context.policy.maxConsecutiveToolFailures,
					},
					...(verifier.serviceTier ? { serviceTier: verifier.serviceTier } : {}),
					signal: context.signal,
					onEvent: event => {
						if (event.type === "tool_started") {
							startedTools.set(event.callId, { name: event.name, arguments: event.arguments });
						} else if (event.type === "tool_completed") {
							const evidence = createRuntimeToolEvidence(event, startedTools.get(event.callId));
							if (evidence) hostEvidence.push(evidence);
							startedTools.delete(event.callId);
						}
						options.onAgentEvent?.({ phase: "verifier", event });
					},
				});
				budget.settle(reservation, session.usage);
				if (!session.success) {
					return {
						passed: false,
						failureKind: "infrastructure",
						summary: session.error ?? "Verifier failed to complete.",
						usage: session.usage,
						assurance: verificationAssurance,
						hostEvidence,
					};
				}
				return parseVerifierResult(session.output, session.usage, verificationAssurance, hostEvidence);
			},
		},
	});

	const features = inferTaskFeatures(options.task);
	const subagentTasks = features.userRequestedParallel ? deriveSubagentTasks(options.task) : undefined;
	const result = await harness.run({
		task: options.task,
		model: variant,
		subagentTasks,
		contextState: options.contextState,
		checkpoint: options.checkpoint,
		onCheckpoint: options.onCheckpoint,
		adaptive: options.adaptive,
		signal,
	});
	return result;
}
