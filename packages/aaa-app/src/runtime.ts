import { existsSync } from "node:fs";
import * as path from "node:path";
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
	type ExecutionLane,
	extractLedgerEntries,
	inferTaskFeatures,
	isRecord,
	type LongRunCheckpoint,
	type Model,
	type ModelCapabilityRegistry,
	mergeLedger,
	type PermissionMode,
	type PrimaryExecutionContext,
	pendingDeliverables,
	resolveHistoryWorkingBudget,
	runAgentSession,
	type ServiceTier,
	type StructuredContextState,
	type SubagentResult,
	type SubagentTask,
	type TaskFeatureHints,
	type ThinkingMode,
	trimConversationKeepingPrefix,
	type UsageMetrics,
	type VerificationAssurance,
	type VerificationResult,
	type VerificationStrength,
} from "@aaa-agent/runtime";
import {
	createAdaptiveToolset,
	createVerificationCheckTool,
	defineVerificationCheck,
	type ShellApprovalRequest,
	type VerificationCheck,
} from "@aaa-agent/workspace";
import Handlebars from "handlebars";
import { describeAcceptanceBinding, isAcceptanceBound } from "./acceptance-binding";
import agentSystemTemplate from "./prompts/agent-system.md" with { type: "text" };
import primaryRequestTemplate from "./prompts/primary-request.md" with { type: "text" };
import subagentDiscoveryTemplate from "./prompts/subagent-discovery.md" with { type: "text" };
import subagentRiskTemplate from "./prompts/subagent-risk.md" with { type: "text" };
import subagentSliceTemplate from "./prompts/subagent-slice.md" with { type: "text" };
import subagentSystemPrompt from "./prompts/subagent-system.md" with { type: "text" };
import verifierRequestTemplate from "./prompts/verifier-request.md" with { type: "text" };
import verifierSystemTemplate from "./prompts/verifier-system.md" with { type: "text" };
import { resolveDigestBudget } from "./session-store";

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

export interface AdaptiveSubagentOptions {
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
	/** Stable parent session id for provider cache affinity. */
	sessionId?: string;
	approveShell?: (request: ShellApprovalRequest) => boolean | Promise<boolean>;
	capabilities: ModelCapabilityRegistry;
	overlays: AdaptiveOverlayRegistry;
	conversation?: readonly AgentConversationMessage[];
	contextState?: StructuredContextState;
	verifier?: AdaptiveVerifierOptions;
	/** Optional cheaper/faster model for read-only delegated work. */
	subagent?: AdaptiveSubagentOptions;
	permissionOverride?: PermissionMode;
	laneOverride?: ExecutionLane;
	verificationOverride?: VerificationStrength;
	additionalTools?: readonly AgentTool[];
	checkpoint?: LongRunCheckpoint;
	onCheckpoint?: (checkpoint: LongRunCheckpoint) => void | Promise<void>;
	adaptive?: boolean;
	signal?: AbortSignal;
	onEvent?: (event: AdaptiveHarnessEvent) => void;
	onAgentEvent?: (event: AdaptiveRuntimeAgentEvent) => void;
}

const compiledTemplates = new Map<string, Handlebars.TemplateDelegate>();

function render(template: string, values: object): string {
	let compiled = compiledTemplates.get(template);
	if (!compiled) {
		compiled = Handlebars.compile(template, { noEscape: true });
		compiledTemplates.set(template, compiled);
	}
	return compiled(values);
}

interface StartedToolObservation {
	name: string;
	arguments: unknown;
}

interface ObservedAcceptance {
	command: string;
	evidence: EvidenceRef;
	mutationEpoch: number;
}

const MAX_PRIMARY_RUNTIME_EVIDENCE = 32;
const CHECK_COMMAND_PATTERN = /\b(?:test|check|lint|build|pytest)\b/i;

function shellSyntaxWithoutHeredocBodies(command: string): string {
	let syntax = "";
	let cursor = 0;
	const start = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n/g;
	for (let match = start.exec(command); match; match = start.exec(command)) {
		syntax += command.slice(cursor, start.lastIndex);
		const delimiter = match[2];
		if (!delimiter) break;
		const end = new RegExp(`^\\s*${delimiter}\\s*$`, "m");
		const tail = command.slice(start.lastIndex);
		const terminator = end.exec(tail);
		if (!terminator || terminator.index === undefined) {
			cursor = command.length;
			break;
		}
		cursor = start.lastIndex + terminator.index + terminator[0].length;
		start.lastIndex = cursor;
	}
	return `${syntax}${command.slice(cursor)}`;
}

function isObservedAcceptanceChain(command: string): boolean {
	// Overall rc=0 proves every command in a pure && chain passed. Ignore Python
	// heredoc bodies when inspecting shell control operators, but retain syntax
	// after the delimiter so `pytest || true` and later masking still fail shut.
	const shellSyntax = shellSyntaxWithoutHeredocBodies(command);
	if (/[|;&]/.test(shellSyntax.replaceAll("&&", ""))) return false;
	return shellSyntax
		.split("&&")
		.some(segment => defineVerificationCheck("observed-check", segment.trim()) !== undefined);
}

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
	if (!started) return undefined;
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
	const isTestObservation =
		started.name === "check" || (started.name === "shell" && Boolean(target && CHECK_COMMAND_PATTERN.test(target)));
	// A failed deterministic check can be exactly the expected outcome. Keep
	// its host-observed rc/output as evidence, but never mark it as a passing
	// acceptance check. Other failed tools remain non-evidence.
	if (!event.success && !isTestObservation) return undefined;
	const exitCode = event.details?.exitCode;
	const summary = [
		event.success ? `Host completed ${started.name} successfully` : `Host observed ${started.name} failure`,
		target ? `target=${target.slice(0, 1_200)}` : undefined,
		typeof exitCode === "number" ? `exitCode=${exitCode}` : undefined,
		!event.success && event.error ? `output=${event.error.slice(0, 1_000)}` : undefined,
	]
		.filter((value): value is string => value !== undefined)
		.join("; ");
	return {
		kind: isTestObservation
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
		permissions: context.policy.permissions,
		thinkingMode: context.policy.disableReasoning ? "off" : context.policy.reasoningEffort,
		toolBudget: context.policy.toolBudget,
		maxTurns: context.policy.budget.maxTurns,
		servicePlan: context.model.servicePlan,
		quotaBacked: context.model.servicePlan === "coding-plan" || context.model.servicePlan === "token-plan",
		platform: process.platform,
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

interface CapturedCommandResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
}

function bindVerifierClaimsToHost(
	verdict: VerificationResult,
	trustedEvidence: readonly EvidenceRef[],
): VerificationResult {
	if (trustedEvidence.length === 0) return verdict;
	const trusted = trustedEvidence.map(item => structuredClone(item));
	const bind = (claim: EvidenceRef): EvidenceRef | undefined =>
		trusted.find(item => item.kind === claim.kind && item.ref === claim.ref) ??
		trusted.find(
			item =>
				item.kind === claim.kind &&
				(Boolean(item.summary?.includes(claim.ref)) || Boolean(claim.summary?.includes(item.ref))),
		) ??
		trusted.find(item => item.kind === claim.kind);
	return {
		...verdict,
		// A passing semantic verdict is supported by every successful host action
		// the verifier actually performed; opaque/path refs from model JSON never
		// cross the trust boundary unchanged.
		evidence: verdict.passed ? trusted : (verdict.evidence ?? []).flatMap(item => bind(item) ?? []),
		goalEvidence: verdict.goalEvidence?.flatMap(item => {
			const evidence = bind(item.evidence);
			return evidence ? [{ ...item, evidence }] : [];
		}),
		verifiedFacts: verdict.verifiedFacts?.flatMap(item => {
			const evidence = item.evidence.flatMap(claim => bind(claim) ?? []);
			return evidence.length > 0 ? [{ ...item, evidence }] : [];
		}),
		findings: verdict.findings?.map(item => ({
			...item,
			evidence: item.evidence.flatMap(claim => bind(claim) ?? []),
		})),
	};
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>, maximum = 12_000): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const headLimit = Math.ceil(maximum * 0.6);
	const tailLimit = maximum - headLimit;
	let head = "";
	let tail = "";
	let complete: string | undefined = "";
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			total += text.length;
			if (complete !== undefined) {
				complete += text;
				if (complete.length > maximum) complete = undefined;
			}
			if (head.length < headLimit) head += text.slice(0, headLimit - head.length);
			tail = `${tail}${text}`.slice(-tailLimit);
		}
		const flush = decoder.decode();
		if (flush) {
			total += flush.length;
			if (complete !== undefined) {
				complete += flush;
				if (complete.length > maximum) complete = undefined;
			}
			if (head.length < headLimit) head += flush.slice(0, headLimit - head.length);
			tail = `${tail}${flush}`.slice(-tailLimit);
		}
	} finally {
		reader.releaseLock();
	}
	if (complete !== undefined) return complete;
	return `${head}\n… ${total - head.length - tail.length} characters omitted …\n${tail}`;
}

async function execCapture(command: string, cwd: string, timeoutMs = 180_000): Promise<CapturedCommandResult> {
	// Re-runs a command the PRIMARY already executed in this session. Drain both
	// pipes concurrently (avoids child-process backpressure deadlocks) and retain
	// bounded failure output so recovery does not need to execute it again.
	try {
		const child = Bun.spawn(["/bin/bash", "-c", command], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill(9);
			} catch {}
		}, timeoutMs);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			readBoundedStream(child.stdout),
			readBoundedStream(child.stderr),
		]);
		clearTimeout(timer);
		return {
			exitCode: timedOut ? null : typeof code === "number" ? code : null,
			output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
			timedOut,
		};
	} catch (error) {
		return {
			exitCode: null,
			output: error instanceof Error ? error.message : String(error),
			timedOut: false,
		};
	}
}

const ACCEPTANCE_HINT_PATTERN = /(selfcheck|unittest|pytest|\btest\b|check|verify)/i;
const MAX_SUBAGENT_FINDING_CHARACTERS = 6_000;

function compactFinding(text: string, maximum = MAX_SUBAGENT_FINDING_CHARACTERS): string {
	if (text.length <= maximum) return text;
	const marker = `\n… ${text.length - maximum} characters omitted from delegated finding …\n`;
	const available = Math.max(0, maximum - marker.length);
	const head = Math.ceil(available * 0.7);
	return `${text.slice(0, head)}${marker}${text.slice(text.length - (available - head))}`;
}

function deriveSubagentTasks(task: string): SubagentTask[] {
	const slices = task
		.split("\n")
		.map(line => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/)?.[1]?.trim())
		.filter((value): value is string => Boolean(value));
	const delegatedContext = compactFinding(task, 12_000);
	if (slices.length >= 2) {
		return slices.slice(0, 4).map((slice, index) => ({
			id: `slice-${index + 1}`,
			prompt: render(subagentSliceTemplate, { task: delegatedContext, slice }),
			mode: "read",
			origin: "user",
			estimatedTokens: 4_000,
		}));
	}
	return [
		{
			id: "discovery",
			prompt: render(subagentDiscoveryTemplate, { task: delegatedContext }),
			mode: "read",
			origin: "user",
			estimatedTokens: 5_000,
		},
		{
			id: "risk-review",
			prompt: render(subagentRiskTemplate, { task: delegatedContext }),
			mode: "read",
			origin: "user",
			estimatedTokens: 5_000,
		},
	];
}
function resolveSubagentEffort(
	context: Pick<PrimaryExecutionContext, "profile">,
	model: Model,
	mode: ThinkingMode,
): EffortType {
	if (mode !== "auto" && mode !== "off" && model.efforts.includes(mode)) return mode;
	const preferred = context.profile.planningHorizon < 0.5 ? Effort.Medium : Effort.Low;
	if (model.efforts.includes(preferred)) return preferred;
	return model.efforts[0] ?? Effort.Minimal;
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
	const priorLedger = options.contextState?.ledger ?? [];
	const taskTurn = Math.max(0, ...priorLedger.map(entry => entry.turn)) + 1;
	const effectiveLedger = mergeLedger(priorLedger, extractLedgerEntries(options.task, taskTurn));
	const effectiveContextState: StructuredContextState | undefined = options.contextState
		? { ...structuredClone(options.contextState), ledger: effectiveLedger }
		: effectiveLedger.length > 0
			? {
					version: 1,
					userGoals: [],
					completedGoals: [],
					remainingGoals: [],
					verifiedFacts: [],
					artifacts: [],
					openRisks: [],
					ledger: effectiveLedger,
					updatedAt: Date.now(),
				}
			: undefined;
	const subagent = options.subagent ?? {
		model: options.model,
		provider: options.provider,
		reasoningConfig: options.reasoningConfig,
		...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
	};
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
	const primaryReadonlyTools = [
		...toolset.readonlyTools,
		...additionalTools.filter(tool => tool.sideEffect === "none"),
	];
	const signal = options.signal ?? new AbortController().signal;
	const verificationChecks = new Map<string, VerificationCheck>();
	const observedAcceptances: ObservedAcceptance[] = [];
	// 宿主观察到被改动的文件。验收证据必须能绑定到这些文件，否则不承认"通过"。
	const changedFiles = new Set<string>();
	const affinityRoot = options.sessionId ?? crypto.randomUUID();
	let globalMutationEpoch = 0;
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
				model: subagent.model,
				provider: subagent.provider,
				cwd: options.cwd,
				systemPrompt: subagentSystemPrompt,
				userPrompt: task.prompt,
				tools: toolset.readonlyTools,
				policy: {
					...(subagent.reasoningConfig === "off" ? { disableReasoning: true } : {}),
					reasoningEffort: resolveSubagentEffort(context, subagent.model, subagent.reasoningConfig),
					toolBudget: 8,
					maxTurns: context.budget.subagentMaxTurns,
					maxToolCalls: Math.max(8, context.budget.subagentMaxTurns * 2),
					maxTotalTokens: reservation.limit,
					maxRepeatedToolCalls: 2,
					maxConsecutiveToolFailures: 2,
				},
				...(subagent.serviceTier ? { serviceTier: subagent.serviceTier } : {}),
				sessionId: `${affinityRoot}:subagent:${task.id}`,
				signal: context.signal,
				onEvent: event => options.onAgentEvent?.({ phase: "subagent", subagentId: task.id, event }),
			});
			budget.settle(reservation, session.usage);
			const finding = compactFinding(session.output);
			return {
				taskId: task.id,
				status: session.success ? "succeeded" : "failed",
				findings: finding
					? [
							{
								summary: finding,
								evidence: [{ kind: "subagent", ref: task.id, summary: finding.slice(0, 500) }],
								confidence: session.success ? 0.75 : 0.25,
							},
						]
					: [],
				unresolved: session.success ? [] : [compactFinding(session.error ?? task.prompt, 2_000)],
				usage: session.usage,
				diagnostics: session.diagnostics,
			};
		},
		executor: {
			execute: async context => {
				for (const [command, check] of verificationChecks) {
					verificationChecks.set(command, { ...check, current: false });
				}
				const startedTools = new Map<string, StartedToolObservation>();
				const runtimeEvidence: EvidenceRef[] = [];
				const budget = resolveTokenBudget(context.policy.maxTotalTokens);
				const primarySessionLimit =
					context.policy.verification === "none"
						? context.policy.maxTotalTokens
						: Math.floor(context.policy.maxTotalTokens * 0.85);
				const reservation = budget.reserve(primarySessionLimit, `Primary round ${context.round}`);
				let cachedGateFailure: { mutationEpoch: number; command: string; feedback: string } | undefined;
				const beforeFinalize = async (candidate: {
					workspaceMutated: boolean;
				}): Promise<{ accepted: boolean; feedback?: string }> => {
					const notes: string[] = [];
					const missing = pendingDeliverables(effectiveLedger, subject =>
						existsSync(path.join(options.cwd, subject)),
					);
					if (missing.length > 0) {
						notes.push(`Missing requested deliverable(s): ${missing.map(item => item.subject).join(", ")}.`);
					}
					const acceptanceCommands = [...verificationChecks.keys()].filter(
						command => CHECK_COMMAND_PATTERN.test(command) || ACCEPTANCE_HINT_PATTERN.test(command),
					);
					const hasFreshPass = [...verificationChecks.values()].some(
						check => check.current && check.primaryExitCode === 0 && check.mutationEpoch === globalMutationEpoch,
					);
					if (candidate.workspaceMutated && acceptanceCommands.length > 0 && !hasFreshPass) {
						const command =
							acceptanceCommands.find(item => ACCEPTANCE_HINT_PATTERN.test(item)) ?? acceptanceCommands[0];
						if (
							cachedGateFailure?.mutationEpoch === globalMutationEpoch &&
							cachedGateFailure.command === command
						) {
							notes.push(cachedGateFailure.feedback);
						} else {
							const capture = await execCapture(command, options.cwd);
							const existing = verificationChecks.get(command);
							if (capture.exitCode === 0 && existing) {
								verificationChecks.set(command, {
									...existing,
									primaryExitCode: 0,
									current: true,
									mutationEpoch: globalMutationEpoch,
								});
								runtimeEvidence.push({
									kind: "test",
									ref: `host-finalize:${existing.id}:${globalMutationEpoch}`,
									summary: `Host re-ran current acceptance; target=${command}; exitCode=0`,
								});
								cachedGateFailure = undefined;
							} else {
								const feedback = [
									`Acceptance command failed: ${command}`,
									`exitCode=${capture.exitCode ?? (capture.timedOut ? "timeout" : "unknown")}`,
									capture.output ? `Output:\n${capture.output}` : undefined,
								]
									.filter((item): item is string => Boolean(item))
									.join("\n");
								cachedGateFailure = { mutationEpoch: globalMutationEpoch, command, feedback };
								notes.push(feedback);
							}
						}
					}
					return notes.length > 0 ? { accepted: false, feedback: notes.join("\n\n") } : { accepted: true };
				};
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
					tools:
						context.policy.permissions === "read-only"
							? primaryReadonlyTools
							: context.policy.toolSurface === "minimal"
								? primaryMinimalTools
								: primaryAllTools,
					escalationTools: context.policy.permissions === "read-only" ? primaryReadonlyTools : primaryAllTools,
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
					sessionId: `${affinityRoot}:primary`,
					signal: context.signal,
					beforeFinalize,
					history:
						context.round === 1
							? trimConversationKeepingPrefix(
									options.conversation ?? [],
									Math.min(
										resolveDigestBudget(options.model.contextWindow).trigger,
										resolveHistoryWorkingBudget(options.model.contextWindow, context.task.length).trigger,
									),
								)
							: undefined,
					onEvent: event => {
						if (event.type === "tool_started") {
							startedTools.set(event.callId, { name: event.name, arguments: event.arguments });
						} else if (event.type === "tool_completed") {
							const started = startedTools.get(event.callId);
							const mutatedWorkspace =
								(event.success && (started?.name === "write" || started?.name === "edit")) ||
								(started?.name === "shell" && event.details?.workspaceMutationRisk !== "none");
							if (event.success && (started?.name === "write" || started?.name === "edit")) {
								const target = isRecord(started?.arguments) ? started?.arguments.path : undefined;
								if (typeof target === "string" && target.length > 0) changedFiles.add(target);
							}
							if (mutatedWorkspace) {
								globalMutationEpoch += 1;
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
								if (check && typeof exitCode === "number") {
									verificationChecks.set(command, {
										...check,
										discoveredRound: context.round,
										primaryExitCode: exitCode,
										current: exitCode === 0,
										mutationEpoch: globalMutationEpoch,
									});
									if (!existing) nextVerificationCheckId += 1;
								}
							}
							const evidence = createRuntimeToolEvidence(event, startedTools.get(event.callId));
							if (evidence) {
								runtimeEvidence.push(evidence);
								if (
									event.success &&
									started?.name === "shell" &&
									isRecord(started.arguments) &&
									typeof started.arguments.command === "string" &&
									isObservedAcceptanceChain(started.arguments.command)
								) {
									observedAcceptances.push({
										command: started.arguments.command,
										evidence,
										mutationEpoch: globalMutationEpoch,
									});
									if (observedAcceptances.length > MAX_PRIMARY_RUNTIME_EVIDENCE) observedAcceptances.shift();
								}
							}
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
				const currentObserved = observedAcceptances.filter(item => item.mutationEpoch === globalMutationEpoch);
				// 一条"通过"的检查只证明它自己退出码为 0。要作为确定性证据短路验收，
				// 它还必须能绑定到本次真正改动过的文件，否则交由独立 verifier 判断。
				const changedFileList = [...changedFiles];
				const boundChecks = currentChecks.filter(check =>
					isAcceptanceBound(check.command, changedFileList, context.task),
				);
				const boundObserved = currentObserved.filter(item =>
					isAcceptanceBound(item.command, changedFileList, context.task),
				);
				const unboundCommands = [
					...currentChecks.map(check => check.command),
					...currentObserved.map(item => item.command),
				].filter(command => !isAcceptanceBound(command, changedFileList, context.task));
				const unboundEvidence: EvidenceRef[] = unboundCommands.map((command, index) => ({
					kind: "test",
					ref: `unbound-acceptance-${index}`,
					summary: describeAcceptanceBinding(command, changedFileList, context.task),
				}));
				const deterministicEvidence = [
					...(result.evidence ?? []).filter(
						evidence =>
							evidence.kind === "test" &&
							boundChecks.some(check => evidence.summary?.includes(`target=${check.command}`)),
					),
					...boundObserved.map(item => item.evidence),
				].filter((evidence, index, all) => all.findIndex(item => item.ref === evidence.ref) === index);
				const recordedAcceptance = checks
					.map(check => check.command)
					.filter(command => CHECK_COMMAND_PATTERN.test(command) || ACCEPTANCE_HINT_PATTERN.test(command));
				let acceptanceRerunNote: string | undefined;
				let acceptanceRerunFresh = false;
				const staleWithoutProbe =
					result.workspaceMutated &&
					recordedAcceptance.length > 0 &&
					!checks.some(
						check => check.current && check.primaryExitCode === 0 && check.mutationEpoch === globalMutationEpoch,
					);
				if (staleWithoutProbe) {
					const probeTarget =
						recordedAcceptance.find(command => ACCEPTANCE_HINT_PATTERN.test(command)) ?? recordedAcceptance[0];
					const rerun = await execCapture(probeTarget, options.cwd);
					if (rerun.exitCode === 0) {
						acceptanceRerunFresh = true;
						acceptanceRerunNote = `host re-ran \`${probeTarget}\` after final mutation: exit 0`;
					} else {
						acceptanceRerunNote = [
							`host re-ran \`${probeTarget}\` after final mutation: exit ${rerun.exitCode ?? (rerun.timedOut ? "timeout" : "unknown")}`,
							rerun.output ? `output: ${rerun.output}` : undefined,
						]
							.filter((item): item is string => Boolean(item))
							.join("; ");
					}
				}
				const staleAcceptanceRisk = staleWithoutProbe && !acceptanceRerunFresh;
				const missingDeliverableList = pendingDeliverables(effectiveLedger, subject =>
					existsSync(`${options.cwd}/${subject}`),
				);
				const gateVerdict = async <T extends { passed: boolean; summary: string; unmetCriteria?: string[] }>(
					verdict: T,
				): Promise<T> => {
					if (
						!verdict.passed ||
						(missingDeliverableList.length === 0 && !staleAcceptanceRisk && !acceptanceRerunNote)
					)
						return verdict;
					const notes: string[] = [];
					if (acceptanceRerunNote) notes.push(acceptanceRerunNote);
					if (staleAcceptanceRisk) {
						notes.push("workspace was mutated after the last successful acceptance command");
					}
					if (missingDeliverableList.length > 0) {
						notes.push(
							`requested deliverable(s) not on disk: ${missingDeliverableList.map(d => d.subject).join(", ")}`,
						);
					}
					return {
						...verdict,
						passed: false,
						summary: `${verdict.summary}; host gate: ${notes.join("; ")}`,
						unmetCriteria: [...(verdict.unmetCriteria ?? []), ...notes],
					};
				};
				if (context.policy.verification === "targeted" && deterministicEvidence.length > 0) {
					const shortCircuit: VerificationResult = {
						passed: true,
						summary: "Accepted current deterministic host check.",
						usage: createEmptyUsageMetrics(),
						assurance: "deterministic",
						hostEvidence: deterministicEvidence,
						evidence: deterministicEvidence,
					};
					return await gateVerdict(shortCircuit);
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
						task: compactFinding(context.task, 32_000),
						output: compactFinding(result.output, 8_000),
						goals: context.goals,
						round: context.round,
						evidence: [...(result.evidence ?? []), ...unboundEvidence],
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
					sessionId: `${affinityRoot}:verifier`,
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
						diagnostics: session.diagnostics,
						assurance: verificationAssurance,
						hostEvidence,
					};
				}
				const parsed = parseVerifierResult(session.output, session.usage, verificationAssurance, hostEvidence);
				const bound = bindVerifierClaimsToHost(parsed, [...(result.evidence ?? []), ...hostEvidence]);
				return await gateVerdict({ ...bound, diagnostics: session.diagnostics });
			},
		},
	});

	const featureHints: TaskFeatureHints = {
		contextTokens: Math.ceil(options.task.length / 1.5),
		...(options.permissionOverride === "read-only" ? { readOnly: true, writesWorkspace: false } : {}),
		...(options.permissionOverride === "write" ? { readOnly: false } : {}),
	};
	const features = inferTaskFeatures(options.task, featureHints);
	const subagentTasks = features.userRequestedParallel ? deriveSubagentTasks(options.task) : undefined;
	const result = await harness.run({
		task: options.task,
		model: variant,
		featureHints: features,
		routeOverrides: {
			...(options.laneOverride ? { lane: options.laneOverride } : {}),
			...(options.verificationOverride ? { verification: options.verificationOverride } : {}),
			...(options.permissionOverride ? { permissions: options.permissionOverride } : {}),
		},
		subagentTasks,
		contextState: effectiveContextState,
		checkpoint: options.checkpoint,
		onCheckpoint: options.onCheckpoint,
		adaptive: options.adaptive,
		signal,
	});
	return result;
}
