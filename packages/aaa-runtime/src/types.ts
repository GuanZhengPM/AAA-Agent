import type { LedgerEntry } from "./conversation-ledger";

export const THINKING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof THINKING_EFFORTS)[number];
export const Effort = {
	Minimal: "minimal",
	Low: "low",
	Medium: "medium",
	High: "high",
	XHigh: "xhigh",
	Max: "max",
} as const satisfies Record<string, Effort>;

export const THINKING_MODES = ["auto", "off", ...THINKING_EFFORTS] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];
export const SERVICE_TIERS = ["auto", "default", "flex", "scale", "priority"] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

export type Api = "codex-responses" | "openai-responses" | "openai-chat-completions" | "anthropic-messages";
export type AuthChannel = "subscription" | "api_key" | "local";
export type ServicePlan = "subscription" | "payg" | "coding-plan" | "token-plan" | "local";
export type ApiKeyHeader = "bearer" | "x-api-key";
export type EffortFormat =
	| "none"
	| "reasoning_effort"
	| "thinking_toggle"
	| "thinking_toggle_with_effort"
	| "anthropic_thinking_toggle"
	| "anthropic_output_config";

export interface ModelPricing {
	inputPerMillion: number;
	outputPerMillion: number;
	cacheReadPerMillion?: number;
	cacheWritePerMillion?: number;
}

export interface Model {
	provider: string;
	id: string;
	name: string;
	api: Api;
	baseUrl: string;
	contextWindow: number;
	efforts: readonly Effort[];
	supportsThinkingOff?: boolean;
	serviceTiers?: readonly ServiceTier[];
	servicePlan?: ServicePlan;
	baseUrlEnv?: string;
	authChannel?: AuthChannel;
	effortFormat?: EffortFormat;
	apiKeyHeader?: ApiKeyHeader;
	maxOutputTokens?: number;
	/** Per-account request concurrency; rate-sensitive providers such as GLM use 1. */
	maxConcurrentRequests?: number;
	apiKeyEnv?: string;
	family?: string;
	pricing?: ModelPricing;
}

export type ExecutionLane = "direct" | "guided" | "orchestrated";
export type GoalLevel = "implicit" | "checklist" | "dag";
export type GoalNodeStatus = "pending" | "active" | "blocked" | "done" | "dropped";
export type OverlayScope = "universal" | "family" | "model";
export type VerificationStrength = "none" | "targeted" | "strict";
export type AutoSubagentMode = "off" | "read-only" | "all";
export type ToolSurface = "minimal" | "standard" | "full";

export interface ModelVariant {
	key: string;
	provider: string;
	modelId: string;
	api: Api;
	endpoint: string;
	authChannel: AuthChannel;
	servicePlan: ServicePlan;
	family: string;
	reasoningConfig: string;
	serviceTier?: ServiceTier;
	efforts: readonly Effort[];
	toolSchemaVersion: string;
}

export interface ModelVariantOptions {
	authChannel: ModelVariant["authChannel"];
	family?: string;
	reasoningConfig?: string;
	serviceTier?: ServiceTier;
	toolSchemaVersion?: string;
}

export type ModelVariantSource = Pick<
	Model,
	"provider" | "id" | "api" | "baseUrl" | "baseUrlEnv" | "efforts" | "servicePlan"
>;

export type TaskSlice = "general" | "coding" | "debugging" | "long-horizon" | "research" | "gui" | "document";
export type CapabilityProfileSlice = TaskSlice | "global";
export type EvidenceQuality = "behavioral" | "audited" | "deterministic";
export type VerificationAssurance = "correlated" | "independent" | "deterministic";

export interface CapabilityScores {
	toolSchemaReliability: number;
	parallelToolReliability: number;
	longContextUtilization: number;
	instructionRetention: number;
	planningHorizon: number;
	skillActivationRecall: number;
	editReliability: number;
	recoveryReliability: number;
	verificationReliability: number;
	latencyClass: number;
	costClass: number;
}

export interface ModelCapabilityProfile extends CapabilityScores {
	variantKey: string;
	family: string;
	taskSlice: CapabilityProfileSlice;
	observationWeights: Partial<Record<keyof CapabilityScores, number>>;
	confidence: Partial<Record<keyof CapabilityScores, number>>;
	positiveEvidence: Partial<Record<keyof CapabilityScores, number>>;
	negativeEvidence: Partial<Record<keyof CapabilityScores, number>>;
	samples: number;
	updatedAt: number;
}

export interface CapabilityObservation {
	taskSlice: TaskSlice;
	values: Partial<CapabilityScores>;
	quality: EvidenceQuality;
	weight?: number;
	observedAt?: number;
}

export interface TaskFeatures {
	estimatedSteps: number;
	estimatedFiles: number;
	independentBranches: number;
	contextTokens: number;
	writesWorkspace: boolean;
	destructiveRisk: number;
	requiresVerification: boolean;
	requiresGoalDag: boolean;
	userRequestedPlan: boolean;
	userRequestedParallel: boolean;
}

export interface AdaptivePolicySnapshot {
	createdAt: number;
	taskSlice: TaskSlice;
	profile: ModelCapabilityProfile;
	route: RouteDecision;
}

export type TaskFeatureHints = Partial<TaskFeatures>;

export interface HarnessBudget {
	maxTurns: number;
	deadlineMs: number;
	subagentMaxParallel: number;
	subagentMaxDepth: number;
	subagentMaxTurns: number;
	subagentTotalTokens: number;
	subagentMaxTokens: number;
}

export interface ExecutionPolicy {
	lane: ExecutionLane;
	goalLevel: GoalLevel;
	autoSubagents: AutoSubagentMode;
	verification: VerificationStrength;
	toolSurface: ToolSurface;
	toolBudget: number;
	maxToolCalls: number;
	reasoningEffort: Effort;
	disableReasoning?: boolean;
	maxRepeatedToolCalls: number;
	maxConsecutiveToolFailures: number;
	budget: HarnessBudget;
	maxTotalTokens: number;
}

export interface AdaptiveOverlaySelector {
	providers?: string[];
	families?: string[];
	variantKeys?: string[];
	maxToolSchemaReliability?: number;
	maxPlanningHorizon?: number;
	minInstructionRetention?: number;
}

export interface AdaptivePolicyPatch {
	goalLevel?: GoalLevel;
	autoSubagents?: AutoSubagentMode;
	verification?: VerificationStrength;
	toolSurface?: ToolSurface;
	toolBudget?: number;
	reasoningEffort?: Effort;
	maxRepeatedToolCalls?: number;
	maxConsecutiveToolFailures?: number;
	budget?: Partial<HarnessBudget>;
}

export interface AdaptiveOverlay {
	id: string;
	scope: OverlayScope;
	priority: number;
	selector: AdaptiveOverlaySelector;
	policy: AdaptivePolicyPatch;
	version: number;
	description?: string;
}

export interface RouteDecision {
	policy: ExecutionPolicy;
	reasons: string[];
	appliedOverlays: string[];
}

export interface EvidenceRef {
	kind: "output" | "tool" | "file" | "test" | "browser" | "user" | "subagent";
	ref: string;
	summary?: string;
}

export interface GoalEvidenceSubmission {
	goalId: string;
	criterionId: string;
	evidence: EvidenceRef;
}

export interface GoalSuccessCriterion {
	id: string;
	description: string;
	required: boolean;
	evidence: EvidenceRef[];
}

export interface AdaptiveGoalNode {
	id: string;
	objective: string;
	status: GoalNodeStatus;
	dependencies: string[];
	owner: "primary" | `subagent:${string}` | "harness";
	criteria: GoalSuccessCriterion[];
	blocker?: string;
}

export interface GoalCompletionReport {
	complete: boolean;
	openGoals: string[];
	missingCriteria: string[];
}

export interface VerifiedFact {
	statement: string;
	evidence: EvidenceRef[];
	verifiedAt: number;
}

export interface VerifiedFactSubmission {
	statement: string;
	evidence: EvidenceRef[];
}

export interface StructuredContextGoal {
	objective: string;
	status: "completed" | "blocked" | "incomplete";
	updatedAt: number;
}

export interface StructuredContextState {
	version: 1;
	userGoals: StructuredContextGoal[];
	completedGoals: string[];
	remainingGoals: string[];
	verifiedFacts: VerifiedFact[];
	artifacts: EvidenceRef[];
	openRisks: string[];
	/** Host-extracted durable conventions, corrections and requested deliverables. */
	ledger?: LedgerEntry[];
	recoveryGuidance?: string;
	updatedAt: number;
}

export interface AuditFinding {
	severity: "info" | "warning" | "error";
	summary: string;
	evidence: EvidenceRef[];
}

export type AuditKind = "task" | "integrity" | "infrastructure" | "configuration";

export interface AuditReport {
	kind: AuditKind;
	outcome: "complete" | "incomplete" | "blocked";
	integrity: "clean" | "suspect" | "violation";
	summary: string;
	completedGoalIds: string[];
	findings: AuditFinding[];
	unmetCriteria: string[];
	recommendedRecovery?: string;
	evidence: EvidenceRef[];
	goalEvidence: GoalEvidenceSubmission[];
	assurance: VerificationAssurance;
	verifiedFacts?: VerifiedFact[];
	usage: UsageMetrics;
}

export interface LongRunCheckpoint {
	version: 1;
	id: string;
	task: string;
	variantKey: string;
	status: "running" | "blocked" | "completed" | "interrupted";
	requirements: AdaptiveGoalNode[];
	artifacts: EvidenceRef[];
	facts: VerifiedFact[];
	currentRound: number;
	inFlightRound?: number;
	maxRounds: number;
	policySnapshot: AdaptivePolicySnapshot;
	lastAudit?: AuditReport;
	completedOutput?: string;
	audits: AuditReport[];
	recoveryGuidance?: string;
	createdAt: number;
	updatedAt: number;
}

export interface SubagentTask {
	id: string;
	prompt: string;
	mode: "read" | "write";
	origin?: "user" | "router" | "primary";
	dependencies?: string[];
	depth?: number;
	isolated?: boolean;
	estimatedTokens?: number;
}

export interface SubagentFinding {
	summary: string;
	evidence: EvidenceRef[];
	confidence: number;
}

export interface SubagentResult {
	taskId: string;
	status: "succeeded" | "partial" | "failed" | "skipped";
	findings: SubagentFinding[];
	unresolved: string[];
	recommendedNextAction?: string;
	usage: UsageMetrics;
	diagnostics?: AgentRunDiagnostics;
	sufficient?: boolean;
	error?: string;
}

export interface SubagentRunContext {
	model: ModelVariant;
	profile: ModelCapabilityProfile;
	budget: Pick<HarnessBudget, "subagentMaxTurns" | "subagentMaxTokens"> & { totalMaxTokens: number };
	signal: AbortSignal;
}

export interface SubagentBatchResult {
	results: SubagentResult[];
	usage: UsageMetrics;
	wallTimeMs: number;
	spawns: number;
}

export interface UsageMetrics {
	/** Uncached input tokens; cache reads/writes are always separate fields. */
	inputTokens: number;
	/** Visible/non-reasoning output tokens; reasoning tokens are separate. */
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	costUsd: number;
	toolCalls: number;
}
export interface ToolRunDiagnostics {
	successes: number;
	failures: number;
}

export interface AgentRunDiagnostics {
	/** Epoch timestamps and phase timings for latency attribution. */
	startedAt?: number;
	firstTokenAt?: number;
	firstActionAt?: number;
	providerRequests?: number;
	providerRetries?: number;
	providerLatencyMs?: number;
	providerWaitMs?: number;
	toolLatencyMs?: number;
	contextCompactions?: number;
	estimatedCharactersPerToken?: number;
	toolArgumentFailures: number;
	unknownToolCalls: number;
	toolExecutionFailures: number;
	repeatedToolCalls: number;
	successfulToolCalls: number;
	recoveredToolFailures: number;
	policyEscalations: number;
	turns: number;
	tools: Record<string, ToolRunDiagnostics>;
}

export interface HarnessRunMetrics extends UsageMetrics {
	startedAt: number;
	providerRequests?: number;
	providerRetries?: number;
	providerLatencyMs?: number;
	providerWaitMs?: number;
	toolLatencyMs?: number;
	contextCompactions?: number;
	completedAt: number;
	timeToFirstActionMs?: number;
	timeToFirstUsefulResultMs?: number;
	subagentSpawns: number;
	subagentTokens: number;
	verificationAttempts: number;
	falseCompletion: boolean;
	success: boolean;
	recoveryRounds?: number;
}
export interface HarnessRunRecord {
	variantKey: string;
	provider: string;
	modelId: string;
	lane: ExecutionLane;
	recordedAt: number;
	metrics: HarnessRunMetrics;
}

export interface HarnessTax {
	tokenRatio: number;
	latencyMs: number;
	costRatio: number;
	toolCallRatio: number;
}

export interface PrimaryExecutionContext {
	task: string;
	model: ModelVariant;
	profile: ModelCapabilityProfile;
	policy: ExecutionPolicy;
	goals: AdaptiveGoalNode[];
	goalFrontier: AdaptiveGoalNode[];
	subagentResults: SubagentResult[];
	round: number;
	maxRounds: number;
	recoveryGuidance?: string;
	verifiedFacts: VerifiedFact[];
	artifacts: EvidenceRef[];
	contextState?: StructuredContextState;
	signal: AbortSignal;
}

export interface PrimaryExecutionResult {
	success: boolean;
	output: string;
	usage: UsageMetrics;
	diagnostics?: AgentRunDiagnostics;
	workspaceMutated?: boolean;
	unknownShellEffects?: boolean;
	completedGoalIds?: string[];
	evidence?: EvidenceRef[];
	goalEvidence?: GoalEvidenceSubmission[];
}

export interface VerificationResult {
	passed: boolean;
	summary: string;
	usage: UsageMetrics;
	diagnostics?: AgentRunDiagnostics;
	assurance?: VerificationAssurance;
	/** Evidence captured by the host while verifier tools execute. Model output cannot populate this field. */
	hostEvidence?: EvidenceRef[];
	evidence?: EvidenceRef[];
	goalEvidence?: GoalEvidenceSubmission[];
	verifiedFacts?: VerifiedFactSubmission[];
	completedGoalIds?: string[];
	findings?: AuditFinding[];
	unmetCriteria?: string[];
	recommendedRecovery?: string;
	blocked?: boolean;
	integrity?: AuditReport["integrity"];
	failureKind?: AuditKind;
}

export interface AdaptiveHarnessExecutor {
	execute(context: PrimaryExecutionContext): Promise<PrimaryExecutionResult>;
	verify?(context: PrimaryExecutionContext, result: PrimaryExecutionResult): Promise<VerificationResult>;
}

export interface AdaptiveHarnessRequest {
	task: string;
	model: ModelVariant;
	featureHints?: TaskFeatureHints;
	goals?: AdaptiveGoalNode[];
	subagentTasks?: SubagentTask[];
	contextState?: StructuredContextState;
	baselineMetrics?: HarnessRunMetrics;
	checkpoint?: LongRunCheckpoint;
	onCheckpoint?: (checkpoint: LongRunCheckpoint) => void | Promise<void>;
	adaptive?: boolean;
	signal?: AbortSignal;
}

export interface AdaptiveHarnessResult {
	output: string;
	success: boolean;
	lane: ExecutionLane;
	route: RouteDecision;
	verification?: VerificationResult;
	audit?: AuditReport;
	checkpoint: LongRunCheckpoint;
	goalReport: GoalCompletionReport;
	subagentResults: SubagentResult[];
	metrics: HarnessRunMetrics;
	diagnostics?: AgentRunDiagnostics;
	capabilityObservation?: CapabilityObservation;
	tax?: HarnessTax;
}

export type AdaptiveHarnessEvent =
	| { type: "run_started"; task: string; model: ModelVariant }
	| { type: "round_started"; round: number; maxRounds: number; recovery?: string }
	| { type: "routed"; decision: RouteDecision }
	| { type: "subagents_completed"; results: SubagentResult[] }
	| { type: "primary_completed"; result: PrimaryExecutionResult }
	| { type: "verification_completed"; result: VerificationResult }
	| { type: "run_completed"; result: AdaptiveHarnessResult };
