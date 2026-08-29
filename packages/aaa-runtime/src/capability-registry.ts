import type {
	CapabilityObservation,
	CapabilityProfileSlice,
	CapabilityScores,
	ModelCapabilityProfile,
	ModelVariant,
} from "./types";

const SCORE_KEYS = [
	"toolSchemaReliability",
	"parallelToolReliability",
	"longContextUtilization",
	"instructionRetention",
	"planningHorizon",
	"skillActivationRecall",
	"editReliability",
	"recoveryReliability",
	"verificationReliability",
	"latencyClass",
	"costClass",
] as const satisfies readonly (keyof CapabilityScores)[];

const DEFAULT_SCORES: CapabilityScores = {
	toolSchemaReliability: 0.65,
	parallelToolReliability: 0.5,
	longContextUtilization: 0.6,
	instructionRetention: 0.65,
	planningHorizon: 0.55,
	skillActivationRecall: 0.5,
	editReliability: 0.6,
	recoveryReliability: 0.55,
	verificationReliability: 0.5,
	latencyClass: 0.5,
	costClass: 0.5,
};

const CONFIDENCE_WEIGHT = 5;
const GLOBAL_PRIOR_WEIGHT = 5;
const SLICE_PRIOR_WEIGHT = 2;

function profileKey(variantKey: string, taskSlice: CapabilityProfileSlice): string {
	return `${variantKey}\u0000${taskSlice}`;
}

function confidenceFor(weight: number): number {
	return clampCapabilityScore(1 - Math.exp(-weight / CONFIDENCE_WEIGHT));
}

/** Clamp externally observed capability scores to the normalized profile range. */
export function clampCapabilityScore(value: number): number {
	if (!Number.isFinite(value)) throw new Error(`Capability score must be finite, received ${value}`);
	return Math.max(0, Math.min(1, value));
}

export function createDefaultCapabilityProfile(
	variant: ModelVariant,
	overrides: Partial<CapabilityScores> = {},
	taskSlice: CapabilityProfileSlice = "global",
): ModelCapabilityProfile {
	const scores = { ...DEFAULT_SCORES, ...overrides };
	const observationWeights: Partial<Record<keyof CapabilityScores, number>> = {};
	const confidence: Partial<Record<keyof CapabilityScores, number>> = {};
	const positiveEvidence: Partial<Record<keyof CapabilityScores, number>> = {};
	const negativeEvidence: Partial<Record<keyof CapabilityScores, number>> = {};
	for (const key of SCORE_KEYS) {
		scores[key] = clampCapabilityScore(scores[key]);
		observationWeights[key] = 0;
		confidence[key] = 0;
		positiveEvidence[key] = 0;
		negativeEvidence[key] = 0;
	}
	return {
		variantKey: variant.key,
		family: variant.family,
		taskSlice,
		...scores,
		observationWeights,
		confidence,
		positiveEvidence,
		negativeEvidence,
		coldStart: true,
		samples: 0,
		updatedAt: Date.now(),
	};
}

/**
 * Stores global and task-slice evidence for exact model variants. Sparse task
 * slices shrink toward the exact global profile, then the family prior.
 */
export class ModelCapabilityRegistry {
	#familyPriors = new Map<string, Partial<CapabilityScores>>();
	#profiles = new Map<string, ModelCapabilityProfile>();

	registerFamilyPrior(family: string, scores: Partial<CapabilityScores>): void {
		const normalized: Partial<CapabilityScores> = {};
		for (const key of SCORE_KEYS) {
			const value = scores[key];
			if (value !== undefined) normalized[key] = clampCapabilityScore(value);
		}
		this.#familyPriors.set(family, normalized);
	}

	register(profile: ModelCapabilityProfile): void {
		const normalized = structuredClone(profile);
		normalized.taskSlice ??= "global";
		normalized.samples = Math.max(0, normalized.samples);
		normalized.coldStart = normalized.samples === 0;
		normalized.observationWeights ??= {};
		normalized.confidence ??= {};
		normalized.positiveEvidence ??= {};
		normalized.negativeEvidence ??= {};
		for (const key of SCORE_KEYS) {
			normalized[key] = clampCapabilityScore(normalized[key]);
			const scoreWeight = Math.max(0, normalized.observationWeights[key] ?? normalized.samples);
			normalized.observationWeights[key] = scoreWeight;
			normalized.confidence[key] = confidenceFor(scoreWeight);
			normalized.positiveEvidence[key] = Math.max(0, normalized.positiveEvidence[key] ?? 0);
			normalized.negativeEvidence[key] = Math.max(0, normalized.negativeEvidence[key] ?? 0);
		}
		this.#profiles.set(profileKey(normalized.variantKey, normalized.taskSlice), normalized);
	}

	resolve(variant: ModelVariant, taskSlice: CapabilityProfileSlice = "global"): ModelCapabilityProfile {
		const prior = createDefaultCapabilityProfile(variant, this.#familyPriors.get(variant.family), "global");
		const observedGlobal = this.#profiles.get(profileKey(variant.key, "global"));
		const global = observedGlobal ? structuredClone(observedGlobal) : prior;
		if (observedGlobal) {
			for (const key of SCORE_KEYS) {
				const weight = observedGlobal.observationWeights[key] ?? 0;
				global[key] = clampCapabilityScore(
					(observedGlobal[key] * weight + prior[key] * GLOBAL_PRIOR_WEIGHT) / (weight + GLOBAL_PRIOR_WEIGHT),
				);
			}
		}
		if (taskSlice === "global") return global;
		const exact = this.#profiles.get(profileKey(variant.key, taskSlice));
		if (!exact) return { ...structuredClone(global), taskSlice };
		const resolved = structuredClone(exact);
		for (const key of SCORE_KEYS) {
			const weight = exact.observationWeights[key] ?? 0;
			resolved[key] = clampCapabilityScore(
				(exact[key] * weight + global[key] * SLICE_PRIOR_WEIGHT) / (weight + SLICE_PRIOR_WEIGHT),
			);
			resolved.confidence[key] = confidenceFor(weight);
		}
		return resolved;
	}

	observe(variant: ModelVariant, observation: CapabilityObservation): ModelCapabilityProfile {
		this.#observeSlice(variant, "global", observation);
		return this.#observeSlice(variant, observation.taskSlice, observation);
	}

	#observeSlice(
		variant: ModelVariant,
		taskSlice: CapabilityProfileSlice,
		observation: CapabilityObservation,
	): ModelCapabilityProfile {
		const key = profileKey(variant.key, taskSlice);
		const current =
			this.#profiles.get(key) ??
			createDefaultCapabilityProfile(variant, this.#familyPriors.get(variant.family), taskSlice);
		const qualityMultiplier =
			observation.quality === "deterministic" ? 1.5 : observation.quality === "audited" ? 1 : 0.5;
		const weight = Math.max(0.01, (observation.weight ?? 1) * qualityMultiplier);
		for (const scoreKey of SCORE_KEYS) {
			const observed = observation.values[scoreKey];
			if (observed === undefined) continue;
			const bounded = clampCapabilityScore(observed);
			const priorWeight = current.observationWeights[scoreKey] ?? 0;
			current[scoreKey] = clampCapabilityScore(
				(current[scoreKey] * priorWeight + bounded * weight) / (priorWeight + weight),
			);
			const nextWeight = priorWeight + weight;
			current.observationWeights[scoreKey] = nextWeight;
			current.confidence[scoreKey] = confidenceFor(nextWeight);
			if (bounded >= 0.5) {
				current.positiveEvidence[scoreKey] = (current.positiveEvidence[scoreKey] ?? 0) + weight;
			} else {
				current.negativeEvidence[scoreKey] = (current.negativeEvidence[scoreKey] ?? 0) + weight;
			}
		}
		current.samples += weight;
		current.coldStart = current.samples === 0;
		current.updatedAt = observation.observedAt ?? Date.now();
		this.#profiles.set(key, structuredClone(current));
		return this.resolve(variant, taskSlice);
	}

	list(): ModelCapabilityProfile[] {
		return [...this.#profiles.values()].map(profile => structuredClone(profile));
	}

	reset(): void {
		this.#profiles.clear();
	}
}
