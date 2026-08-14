import { activeTokenCount } from "./metrics";
import type {
	AdaptiveHarnessResult,
	AgentRunDiagnostics,
	AuditReport,
	CapabilityObservation,
	CapabilityScores,
	PrimaryExecutionResult,
	SubagentResult,
	TaskSlice,
} from "./types";

export interface CapabilityObservationInput {
	primary: PrimaryExecutionResult;
	result: Pick<AdaptiveHarnessResult, "success" | "metrics">;
	audit?: AuditReport;
	audits?: readonly AuditReport[];
	rounds?: number;
	taskSlice: TaskSlice;
	subagents: readonly SubagentResult[];
}

function toolReliability(diagnostics: AgentRunDiagnostics): number | undefined {
	const failures = diagnostics.toolArgumentFailures + diagnostics.unknownToolCalls;
	const attempts = diagnostics.successfulToolCalls + failures;
	return attempts > 0 ? diagnostics.successfulToolCalls / attempts : undefined;
}

function namedToolReliability(diagnostics: AgentRunDiagnostics, names: readonly string[]): number | undefined {
	let successes = 0;
	let failures = 0;
	for (const name of names) {
		const observed = diagnostics.tools[name];
		if (!observed) continue;
		successes += observed.successes;
		failures += observed.failures;
	}
	return successes + failures > 0 ? successes / (successes + failures) : undefined;
}

function hasDeterministicEvidence(audit: AuditReport): boolean {
	return [...audit.evidence, ...audit.goalEvidence.map(item => item.evidence)].some(
		evidence => evidence.kind === "test" || evidence.kind === "browser",
	);
}

function supportsOutcomeLearning(audit: AuditReport): boolean {
	return audit.assurance === "independent" || hasDeterministicEvidence(audit);
}
/** Derive bounded behavioral evidence from an actual run instead of model-name assumptions. */
export function deriveCapabilityObservation(input: CapabilityObservationInput): CapabilityObservation {
	const diagnostics = input.primary.diagnostics;
	const values: Partial<CapabilityScores> = {};
	if (diagnostics) {
		const schemaReliability = toolReliability(diagnostics);
		if (schemaReliability !== undefined) values.toolSchemaReliability = schemaReliability;
		const editReliability = namedToolReliability(diagnostics, ["write", "edit"]);
		if (editReliability !== undefined) values.editReliability = editReliability;
		const failures =
			diagnostics.toolArgumentFailures + diagnostics.unknownToolCalls + diagnostics.toolExecutionFailures;
		if (failures > 0) values.recoveryReliability = Math.min(1, diagnostics.recoveredToolFailures / failures);
	}
	const audits = input.audits ?? (input.audit ? [input.audit] : []);
	const behavioralAudit =
		input.audit &&
		(input.audit.kind === "task" || input.audit.kind === "integrity") &&
		supportsOutcomeLearning(input.audit)
			? input.audit
			: undefined;
	const behavioralAudits = audits.filter(
		audit => (audit.kind === "task" || audit.kind === "integrity") && supportsOutcomeLearning(audit),
	);
	if (behavioralAudit) {
		const totalCalls = Math.max(1, input.result.metrics.toolCalls);
		const rounds = Math.max(1, input.rounds ?? 1);
		const recoveryPenalty = Math.max(0, rounds - 1) / rounds;
		values.planningHorizon = input.result.success
			? Math.max(
					0,
					1 -
						((diagnostics?.repeatedToolCalls ?? 0) + (diagnostics?.policyEscalations ?? 0) * 0.5) / totalCalls -
						recoveryPenalty,
				)
			: 0;
		values.instructionRetention = behavioralAudit.outcome === "complete" ? 1 - recoveryPenalty : 0;
		values.verificationReliability =
			behavioralAudits.filter(audit => audit.outcome === "complete" && audit.integrity === "clean").length /
			Math.max(1, behavioralAudits.length);
		if (behavioralAudits.length > 1) values.recoveryReliability = input.result.success ? 1 : 0;
	}
	if (input.subagents.length > 0) {
		values.parallelToolReliability =
			input.subagents.filter(result => result.status === "succeeded").length / input.subagents.length;
	}
	const elapsedMs = Math.max(0, input.result.metrics.completedAt - input.result.metrics.startedAt);
	values.latencyClass = 1 / (1 + elapsedMs / 120_000);
	if (input.result.metrics.costUsd > 0) values.costClass = 1 / (1 + input.result.metrics.costUsd);
	const activeTokens = activeTokenCount(input.result.metrics);
	if (activeTokens >= 24_000 && behavioralAudit) values.longContextUtilization = input.result.success ? 1 : 0;
	const deterministic = behavioralAudit ? hasDeterministicEvidence(behavioralAudit) : false;
	const quality = deterministic ? "deterministic" : behavioralAudit ? "audited" : "behavioral";
	return {
		taskSlice: input.taskSlice,
		values,
		quality,
		weight: quality === "deterministic" ? 0.3 : quality === "audited" ? 0.2 : 0.1,
		observedAt: input.result.metrics.completedAt,
	};
}
