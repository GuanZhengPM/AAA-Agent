import type {
	EvidenceRef,
	LongRunCheckpoint,
	StructuredContextGoal,
	StructuredContextState,
	VerifiedFact,
} from "./types";

const MAX_USER_GOALS = 8;
const MAX_COMPLETED_GOALS = 24;
const MAX_REMAINING_GOALS = 24;
const MAX_VERIFIED_FACTS = 32;
const MAX_ARTIFACTS = 32;
const MAX_OPEN_RISKS = 16;
const MAX_TEXT_CHARACTERS = 2_000;
const MAX_REFERENCE_CHARACTERS = 512;
const MAX_FACT_EVIDENCE = 3;
const MAX_STRUCTURED_CONTEXT_CHARACTERS = 8_000;

function compactText(value: string): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length <= MAX_TEXT_CHARACTERS ? compact : `${compact.slice(0, MAX_TEXT_CHARACTERS - 1)}…`;
}

function compactReference(value: string): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length <= MAX_REFERENCE_CHARACTERS ? compact : `${compact.slice(0, MAX_REFERENCE_CHARACTERS - 1)}…`;
}

function uniqueStrings(values: readonly string[], limit: number): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const raw of values) {
		const value = compactText(raw);
		if (!value || seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result.slice(-limit);
}

function evidenceKey(evidence: EvidenceRef): string {
	return `${evidence.kind}\u0000${evidence.ref}`;
}

function uniqueEvidence(values: readonly EvidenceRef[], limit: number): EvidenceRef[] {
	const seen = new Set<string>();
	const result: EvidenceRef[] = [];
	for (const evidence of values) {
		const key = evidenceKey(evidence);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push({
			kind: evidence.kind,
			ref: compactReference(evidence.ref),
			...(evidence.summary ? { summary: compactText(evidence.summary) } : {}),
		});
	}
	return result.slice(-limit);
}

function uniqueFacts(values: readonly VerifiedFact[]): VerifiedFact[] {
	const seen = new Set<string>();
	const result: VerifiedFact[] = [];
	for (const fact of values) {
		const statement = compactText(fact.statement);
		if (!statement || seen.has(statement)) continue;
		seen.add(statement);
		result.push({
			statement,
			evidence: uniqueEvidence(fact.evidence, MAX_FACT_EVIDENCE),
			verifiedAt: fact.verifiedAt,
		});
	}
	return result.slice(-MAX_VERIFIED_FACTS);
}

function serializedCharacters(state: StructuredContextState): number {
	return JSON.stringify(state).length;
}

function removeOldest<T>(items: T[], minimum = 0): boolean {
	if (items.length <= minimum) return false;
	items.shift();
	return true;
}

function enforceContextBudget(state: StructuredContextState): StructuredContextState {
	while (serializedCharacters(state) > MAX_STRUCTURED_CONTEXT_CHARACTERS) {
		if (removeOldest(state.completedGoals)) continue;
		if (removeOldest(state.userGoals, 1)) continue;
		if (removeOldest(state.artifacts)) continue;
		if (removeOldest(state.verifiedFacts)) continue;
		if (removeOldest(state.remainingGoals)) continue;
		if (removeOldest(state.openRisks)) continue;
		break;
	}
	return state;
}

function taskStatus(checkpoint: LongRunCheckpoint): StructuredContextGoal["status"] {
	if (checkpoint.status === "completed") return "completed";
	if (checkpoint.status === "blocked") return "blocked";
	return "incomplete";
}

/**
 * Preserve bounded, evidence-backed task state when raw conversation turns are
 * evicted. The state is deterministic and never asks a model to summarize its
 * own work.
 */
export function updateStructuredContextState(
	previous: StructuredContextState | undefined,
	task: string,
	checkpoint: LongRunCheckpoint,
): StructuredContextState {
	const objective = compactText(task);
	const priorGoals = previous?.userGoals.filter(goal => goal.objective !== objective) ?? [];
	const userGoals = [
		...priorGoals,
		{ objective, status: taskStatus(checkpoint), updatedAt: checkpoint.updatedAt } satisfies StructuredContextGoal,
	].slice(-MAX_USER_GOALS);
	const completedGoals = checkpoint.requirements.filter(goal => goal.status === "done").map(goal => goal.objective);
	const remainingGoals = checkpoint.requirements
		.filter(goal => goal.status !== "done" && goal.status !== "dropped")
		.map(goal => goal.objective);
	const audit = checkpoint.lastAudit;
	const currentRisks = [
		...(audit?.unmetCriteria ?? []),
		...(audit?.findings.filter(finding => finding.severity !== "info").map(finding => finding.summary) ?? []),
	];
	const resolvedCurrentTask =
		checkpoint.status === "completed" && audit?.outcome === "complete" && audit.integrity === "clean";
	const openRisks = [...(resolvedCurrentTask ? [] : (previous?.openRisks ?? [])), ...currentRisks];
	return enforceContextBudget({
		version: 1,
		userGoals,
		completedGoals: uniqueStrings([...(previous?.completedGoals ?? []), ...completedGoals], MAX_COMPLETED_GOALS),
		remainingGoals: uniqueStrings(remainingGoals, MAX_REMAINING_GOALS),
		verifiedFacts: uniqueFacts([...(previous?.verifiedFacts ?? []), ...checkpoint.facts]),
		artifacts: uniqueEvidence([...(previous?.artifacts ?? []), ...checkpoint.artifacts], MAX_ARTIFACTS),
		openRisks: uniqueStrings(openRisks, MAX_OPEN_RISKS),
		...(checkpoint.recoveryGuidance ? { recoveryGuidance: compactText(checkpoint.recoveryGuidance) } : {}),
		updatedAt: checkpoint.updatedAt,
	});
}
