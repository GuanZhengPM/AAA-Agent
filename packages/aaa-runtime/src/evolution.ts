import type { AdaptiveOverlay, OverlayScope } from "./types";

export interface CandidateEvaluationPoint {
	modelKey: string;
	modelFamily: string;
	taskSlice: string;
	baselineScore: number;
	candidateScore: number;
	baselineTokens: number;
	candidateTokens: number;
	baselineLatencyMs: number;
	candidateLatencyMs: number;
	baselineCostUsd: number;
	candidateCostUsd: number;
}

export interface HarnessCandidate {
	id: string;
	parentId?: string;
	overlay: AdaptiveOverlay;
	prediction: string;
	heldIn: CandidateEvaluationPoint[];
	heldOut: CandidateEvaluationPoint[];
	crossModel: CandidateEvaluationPoint[];
	createdAt: number;
}

export interface EvolutionThresholds {
	minHeldInGain: number;
	maxHeldOutRegression: number;
	maxTokenOverheadRatio: number;
	maxLatencyOverheadRatio: number;
	maxCostOverheadRatio: number;
	minTransferGain: number;
	minUniversalFamilies: number;
}

export interface CandidateDecision {
	candidateId: string;
	accepted: boolean;
	scope?: OverlayScope;
	reasons: string[];
	promotedOverlay?: AdaptiveOverlay;
}

const DEFAULT_THRESHOLDS: EvolutionThresholds = {
	minHeldInGain: 0.02,
	maxHeldOutRegression: 0.01,
	maxTokenOverheadRatio: 0.25,
	maxLatencyOverheadRatio: 0.25,
	maxCostOverheadRatio: 0.25,
	minTransferGain: 0.01,
	minUniversalFamilies: 3,
};

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function gain(point: CandidateEvaluationPoint): number {
	return point.candidateScore - point.baselineScore;
}

function overhead(candidate: number, baseline: number): number {
	if (baseline === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY;
	return candidate / baseline - 1;
}

/** Pure acceptance gate for offline propose → evaluate → promote workflows. */
export function evaluateHarnessCandidate(
	candidate: HarnessCandidate,
	thresholds: EvolutionThresholds = DEFAULT_THRESHOLDS,
): CandidateDecision {
	const reasons: string[] = [];
	if (candidate.heldIn.length === 0 || candidate.heldOut.length === 0 || candidate.crossModel.length === 0) {
		return {
			candidateId: candidate.id,
			accepted: false,
			reasons: ["held-in, held-out, and cross-model evidence are required"],
		};
	}
	const heldInGain = mean(candidate.heldIn.map(gain));
	const worstHeldOutGain = Math.min(...candidate.heldOut.map(gain));
	const allPoints = [...candidate.heldIn, ...candidate.heldOut, ...candidate.crossModel];
	const tokenOverhead = Math.max(...allPoints.map(point => overhead(point.candidateTokens, point.baselineTokens)));
	const latencyOverhead = Math.max(
		...allPoints.map(point => overhead(point.candidateLatencyMs, point.baselineLatencyMs)),
	);
	const costOverhead = Math.max(...allPoints.map(point => overhead(point.candidateCostUsd, point.baselineCostUsd)));
	if (heldInGain < thresholds.minHeldInGain) reasons.push(`held-in gain ${heldInGain.toFixed(4)} is too small`);
	if (worstHeldOutGain < -thresholds.maxHeldOutRegression) {
		reasons.push(`held-out regression ${worstHeldOutGain.toFixed(4)} exceeds the limit`);
	}
	if (tokenOverhead > thresholds.maxTokenOverheadRatio) {
		reasons.push(`token overhead ${tokenOverhead.toFixed(4)} exceeds the limit`);
	}
	if (latencyOverhead > thresholds.maxLatencyOverheadRatio) {
		reasons.push(`latency overhead ${latencyOverhead.toFixed(4)} exceeds the limit`);
	}
	if (costOverhead > thresholds.maxCostOverheadRatio) {
		reasons.push(`cost overhead ${costOverhead.toFixed(4)} exceeds the limit`);
	}
	if (reasons.length > 0) return { candidateId: candidate.id, accepted: false, reasons };

	const transferSafeForKey = (modelKey: string): boolean =>
		candidate.crossModel
			.filter(point => point.modelKey === modelKey)
			.every(point => gain(point) >= -thresholds.maxHeldOutRegression);
	const beneficiaries = candidate.crossModel.filter(
		point => gain(point) >= thresholds.minTransferGain && transferSafeForKey(point.modelKey),
	);
	const families = new Set(beneficiaries.map(point => point.modelFamily));
	const beneficiaryModelKeys = new Set(beneficiaries.map(point => point.modelKey));
	const modelKeys = new Set(beneficiaryModelKeys);
	for (const point of candidate.heldIn) {
		if (gain(point) >= thresholds.minHeldInGain && transferSafeForKey(point.modelKey)) modelKeys.add(point.modelKey);
	}
	if (beneficiaries.length === 0) {
		return {
			candidateId: candidate.id,
			accepted: false,
			reasons: [`no safely transferable model gain reaches ${thresholds.minTransferGain.toFixed(4)}`],
		};
	}
	const allTransferSafe = candidate.crossModel.every(point => gain(point) >= -thresholds.maxHeldOutRegression);
	const onlyFamily = families.size === 1 ? beneficiaries[0]?.modelFamily : undefined;
	const familyTransferSafe =
		onlyFamily !== undefined &&
		candidate.crossModel
			.filter(point => point.modelFamily === onlyFamily)
			.every(point => gain(point) >= -thresholds.maxHeldOutRegression);
	let scope: OverlayScope;
	if (families.size >= thresholds.minUniversalFamilies && allTransferSafe) scope = "universal";
	else if (onlyFamily !== undefined && beneficiaryModelKeys.size > 1 && familyTransferSafe) scope = "family";
	else scope = "model";

	const promotedOverlay = structuredClone(candidate.overlay);
	promotedOverlay.scope = scope;
	promotedOverlay.version += 1;
	if (scope === "universal") {
		promotedOverlay.selector.providers = undefined;
		promotedOverlay.selector.families = undefined;
		promotedOverlay.selector.variantKeys = undefined;
	} else if (scope === "family") {
		promotedOverlay.selector.providers = undefined;
		promotedOverlay.selector.families = [...families];
		promotedOverlay.selector.variantKeys = undefined;
	} else {
		promotedOverlay.selector.providers = undefined;
		promotedOverlay.selector.families = undefined;
		promotedOverlay.selector.variantKeys = [...modelKeys];
	}
	return {
		candidateId: candidate.id,
		accepted: true,
		scope,
		reasons: [
			`held-in gain ${heldInGain.toFixed(4)}`,
			`worst held-out gain ${worstHeldOutGain.toFixed(4)}`,
			`token overhead ${tokenOverhead.toFixed(4)}`,
			`latency overhead ${latencyOverhead.toFixed(4)}`,
			`cost overhead ${costOverhead.toFixed(4)}`,
		],
		promotedOverlay,
	};
}

/** Keeps accepted and negative results so the evolver does not repeat failed proposals. */
export class EvolutionArchive {
	#candidates = new Map<string, { candidate: HarnessCandidate; decision: CandidateDecision }>();

	record(candidate: HarnessCandidate, decision: CandidateDecision): void {
		if (candidate.id !== decision.candidateId) throw new Error("Candidate and decision ids must match");
		if (this.#candidates.has(candidate.id)) throw new Error(`Candidate ${candidate.id} is already archived`);
		this.#candidates.set(candidate.id, {
			candidate: structuredClone(candidate),
			decision: structuredClone(decision),
		});
	}

	get(candidateId: string): { candidate: HarnessCandidate; decision: CandidateDecision } | undefined {
		const record = this.#candidates.get(candidateId);
		return record ? structuredClone(record) : undefined;
	}

	list(): { candidate: HarnessCandidate; decision: CandidateDecision }[] {
		return [...this.#candidates.values()].map(record => structuredClone(record));
	}
}
