import type {
	AdaptiveGoalNode,
	AdaptivePolicySnapshot,
	AuditReport,
	EvidenceRef,
	LongRunCheckpoint,
	PrimaryExecutionResult,
	VerificationResult,
	VerifiedFact,
} from "./types";

export function maxLongRunRounds(snapshot: AdaptivePolicySnapshot): number {
	if (snapshot.route.policy.lane !== "direct") return 2;
	// Verified tasks need one extra round so an honest host-gate downgrade can
	// be repaired within the same user turn instead of failing terminally.
	const verification = snapshot.route.policy.verification;
	return verification && verification !== "none" ? 2 : 1;
}

export function createLongRunCheckpoint(options: {
	task: string;
	variantKey: string;
	requirements: AdaptiveGoalNode[];
	policySnapshot: AdaptivePolicySnapshot;
}): LongRunCheckpoint {
	const now = Date.now();
	return {
		version: 1,
		id: crypto.randomUUID(),
		task: options.task,
		variantKey: options.variantKey,
		status: "running",
		requirements: structuredClone(options.requirements),
		artifacts: [],
		facts: [],
		audits: [],
		currentRound: 0,
		maxRounds: maxLongRunRounds(options.policySnapshot),
		policySnapshot: structuredClone(options.policySnapshot),
		createdAt: now,
		updatedAt: now,
	};
}

export function resumeLongRunCheckpoint(
	checkpoint: LongRunCheckpoint,
	task: string,
	variantKey: string,
): LongRunCheckpoint {
	if (checkpoint.version !== 1) throw new Error(`Unsupported long-run checkpoint version ${checkpoint.version}`);
	if (checkpoint.task !== task) throw new Error("Checkpoint task does not match the requested task");
	if (checkpoint.variantKey !== variantKey)
		throw new Error("Checkpoint model variant does not match the requested model");
	if (checkpoint.status === "completed") throw new Error("Completed checkpoint cannot be resumed");
	const resumed = structuredClone(checkpoint);
	resumed.audits ??= resumed.lastAudit ? [resumed.lastAudit] : [];
	return {
		...resumed,
		status: "running",
		updatedAt: Date.now(),
	};
}

function uniqueEvidence(items: readonly EvidenceRef[]): EvidenceRef[] {
	const seen = new Set<string>();
	return items.flatMap(item => {
		const key = `${item.kind}\u0000${item.ref}\u0000${item.summary ?? ""}`;
		if (seen.has(key)) return [];
		seen.add(key);
		return [structuredClone(item)];
	});
}
const evidenceKinds: Record<string, true> = {
	output: true,
	tool: true,
	file: true,
	test: true,
	browser: true,
	user: true,
	subagent: true,
};
const auditKinds: Record<string, true> = {
	task: true,
	integrity: true,
	infrastructure: true,
	configuration: true,
};
const integrityKinds: Record<string, true> = { clean: true, suspect: true, violation: true };
const assuranceKinds: Record<string, true> = { correlated: true, independent: true, deterministic: true };
const findingSeverities: Record<string, true> = { info: true, warning: true, error: true };
const usageKeys = [
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"reasoningTokens",
	"costUsd",
	"toolCalls",
] as const;

function isEvidenceRef(value: unknown): value is EvidenceRef {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Partial<EvidenceRef>;
	return (
		typeof candidate.kind === "string" &&
		evidenceKinds[candidate.kind] === true &&
		typeof candidate.ref === "string" &&
		(candidate.summary === undefined || typeof candidate.summary === "string")
	);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function evidenceIdentity(evidence: EvidenceRef): string {
	return `${evidence.kind}\u0000${evidence.ref}`;
}

function bindEvidence(
	claimed: readonly EvidenceRef[],
	trusted: ReadonlyMap<string, EvidenceRef>,
): { accepted: EvidenceRef[]; rejected: number } {
	let rejected = 0;
	const accepted = claimed.flatMap(evidence => {
		const observed = trusted.get(evidenceIdentity(evidence));
		if (!observed) {
			rejected += 1;
			return [];
		}
		return [observed];
	});
	return { accepted: uniqueEvidence(accepted), rejected };
}

/**
 * Verifier responses cross a model/provider boundary despite the executor's
 * static type. Reject malformed payloads before they can affect goals or facts.
 */
function assertValidVerificationResult(value: unknown): asserts value is VerificationResult {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError("Verifier returned an invalid result: expected an object");
	const result = value as Partial<VerificationResult>;
	if (typeof result.passed !== "boolean")
		throw new TypeError("Verifier returned an invalid result: passed must be a boolean");
	if (typeof result.summary !== "string")
		throw new TypeError("Verifier returned an invalid result: summary must be a string");
	if (
		typeof result.usage !== "object" ||
		result.usage === null ||
		usageKeys.some(key => {
			const metric = result.usage?.[key];
			return typeof metric !== "number" || !Number.isFinite(metric) || metric < 0;
		})
	)
		throw new TypeError("Verifier returned an invalid result: usage metrics must be finite non-negative numbers");
	if (result.blocked !== undefined && typeof result.blocked !== "boolean")
		throw new TypeError("Verifier returned an invalid result: blocked must be a boolean");
	if (result.passed && result.blocked)
		throw new TypeError("Verifier returned an invalid result: passed and blocked cannot both be true");
	if (
		result.integrity !== undefined &&
		(typeof result.integrity !== "string" || integrityKinds[result.integrity] !== true)
	)
		throw new TypeError("Verifier returned an invalid result: integrity is invalid");
	if (
		result.failureKind !== undefined &&
		(typeof result.failureKind !== "string" || auditKinds[result.failureKind] !== true)
	)
		throw new TypeError("Verifier returned an invalid result: failureKind is invalid");
	if (
		result.assurance !== undefined &&
		(typeof result.assurance !== "string" || assuranceKinds[result.assurance] !== true)
	)
		throw new TypeError("Verifier returned an invalid result: assurance is invalid");
	for (const key of ["completedGoalIds", "unmetCriteria"] as const) {
		if (result[key] !== undefined && !isStringArray(result[key]))
			throw new TypeError(`Verifier returned an invalid result: ${key} must contain only strings`);
	}
	if (result.recommendedRecovery !== undefined && typeof result.recommendedRecovery !== "string")
		throw new TypeError("Verifier returned an invalid result: recommendedRecovery must be a string");
	if (result.evidence !== undefined && (!Array.isArray(result.evidence) || !result.evidence.every(isEvidenceRef)))
		throw new TypeError("Verifier returned an invalid result: evidence is invalid");
	if (
		result.hostEvidence !== undefined &&
		(!Array.isArray(result.hostEvidence) || !result.hostEvidence.every(isEvidenceRef))
	)
		throw new TypeError("Verifier returned an invalid result: hostEvidence is invalid");
	if (
		result.goalEvidence !== undefined &&
		(!Array.isArray(result.goalEvidence) ||
			!result.goalEvidence.every(item => {
				if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
				const submission = item as unknown as Record<string, unknown>;
				return (
					typeof submission.goalId === "string" &&
					typeof submission.criterionId === "string" &&
					isEvidenceRef(submission.evidence)
				);
			}))
	)
		throw new TypeError("Verifier returned an invalid result: goalEvidence is invalid");
	if (
		result.verifiedFacts !== undefined &&
		(!Array.isArray(result.verifiedFacts) ||
			!result.verifiedFacts.every(fact => {
				if (typeof fact !== "object" || fact === null || Array.isArray(fact)) return false;
				const candidate = fact as unknown as Record<string, unknown>;
				return (
					typeof candidate.statement === "string" &&
					Array.isArray(candidate.evidence) &&
					candidate.evidence.length > 0 &&
					candidate.evidence.every(isEvidenceRef)
				);
			}))
	)
		throw new TypeError("Verifier returned an invalid result: verifiedFacts is invalid");
	if (
		result.findings !== undefined &&
		(!Array.isArray(result.findings) ||
			!result.findings.every(finding => {
				if (typeof finding !== "object" || finding === null || Array.isArray(finding)) return false;
				const candidate = finding as unknown as Record<string, unknown>;
				return (
					typeof candidate.severity === "string" &&
					findingSeverities[candidate.severity] === true &&
					typeof candidate.summary === "string" &&
					Array.isArray(candidate.evidence) &&
					candidate.evidence.every(isEvidenceRef)
				);
			}))
	)
		throw new TypeError("Verifier returned an invalid result: findings are invalid");
}

export function createAuditReport(
	verification: VerificationResult,
	primary: PrimaryExecutionResult,
	defaultCompletedGoalIds: readonly string[],
): AuditReport {
	assertValidVerificationResult(verification);
	const trusted = new Map<string, EvidenceRef>();
	for (const evidence of [...(primary.evidence ?? []), ...(verification.hostEvidence ?? [])]) {
		trusted.set(evidenceIdentity(evidence), structuredClone(evidence));
	}
	const boundEvidence = bindEvidence(verification.evidence ?? [], trusted);
	let rejectedEvidence = boundEvidence.rejected;
	const goalEvidence = (verification.goalEvidence ?? []).flatMap(submission => {
		const bound = bindEvidence([submission.evidence], trusted);
		rejectedEvidence += bound.rejected;
		const evidence = bound.accepted[0];
		return evidence ? [{ ...structuredClone(submission), evidence }] : [];
	});
	const verifiedFacts = (verification.verifiedFacts ?? []).flatMap(submission => {
		const bound = bindEvidence(submission.evidence, trusted);
		rejectedEvidence += bound.rejected;
		const statement = submission.statement.trim();
		return statement && bound.accepted.length > 0
			? [{ statement, evidence: bound.accepted, verifiedAt: Date.now() }]
			: [];
	});
	const findings = (verification.findings ?? []).map(finding => {
		const bound = bindEvidence(finding.evidence, trusted);
		rejectedEvidence += bound.rejected;
		return { ...structuredClone(finding), evidence: bound.accepted };
	});
	const acceptedEvidenceCount =
		boundEvidence.accepted.length +
		goalEvidence.length +
		verifiedFacts.reduce((total, fact) => total + fact.evidence.length, 0);
	const unsupportedPass = verification.passed && acceptedEvidenceCount === 0;
	const evidenceViolation = rejectedEvidence > 0 || unsupportedPass;
	if (evidenceViolation) {
		findings.push({
			severity: "error",
			summary:
				rejectedEvidence > 0
					? `Verifier cited ${rejectedEvidence} evidence reference(s) absent from the host ledger.`
					: "Verifier passed without host-observed evidence.",
			evidence: [],
		});
	}
	const passed = verification.passed && !evidenceViolation;
	const completedGoalIds = verification.completedGoalIds ?? (passed ? [...defaultCompletedGoalIds] : []);
	const outcome = verification.blocked ? "blocked" : passed ? "complete" : "incomplete";
	const integrity = evidenceViolation
		? "suspect"
		: (verification.integrity ?? (primary.success && !passed ? "suspect" : "clean"));
	return {
		kind: evidenceViolation
			? "integrity"
			: (verification.failureKind ?? (integrity === "clean" ? "task" : "integrity")),
		outcome,
		integrity,
		summary: verification.summary,
		completedGoalIds: passed ? [...completedGoalIds] : [],
		findings,
		unmetCriteria: [...(verification.unmetCriteria ?? [])],
		...(verification.recommendedRecovery ? { recommendedRecovery: verification.recommendedRecovery } : {}),
		evidence: boundEvidence.accepted,
		goalEvidence,
		verifiedFacts,
		assurance: verification.assurance ?? "correlated",
		usage: structuredClone(verification.usage),
	};
}

export function collectCheckpointArtifacts(current: readonly EvidenceRef[], audit?: AuditReport): EvidenceRef[] {
	if (audit?.integrity !== "clean") return uniqueEvidence(current);
	return uniqueEvidence([...current, ...audit.evidence, ...audit.goalEvidence.map(submission => submission.evidence)]);
}

export function mergeVerifiedFacts(current: readonly VerifiedFact[], audit?: AuditReport): VerifiedFact[] {
	if (audit?.integrity !== "clean" || (audit.assurance !== "independent" && audit.assurance !== "deterministic")) {
		return current.map(fact => structuredClone(fact));
	}
	const merged = current.map(fact => structuredClone(fact));
	for (const fact of audit.verifiedFacts ?? []) {
		const statement = fact.statement.trim();
		if (!statement || merged.some(currentFact => currentFact.statement === statement)) continue;
		merged.push(structuredClone(fact));
	}
	return merged;
}
