import type { AdaptiveOverlay, AdaptivePolicyPatch, ModelCapabilityProfile, ModelVariant } from "./types";

export interface ResolvedAdaptiveOverlays {
	policy: AdaptivePolicyPatch;
	ids: string[];
}

/** Versioned, behavior-based overlays layered universal → family → exact model. */
export class AdaptiveOverlayRegistry {
	#overlays = new Map<string, AdaptiveOverlay>();

	register(overlay: AdaptiveOverlay): void {
		if (!overlay.id.trim()) throw new Error("Adaptive overlay id is required");
		if (overlay.version < 1) throw new Error(`Adaptive overlay ${overlay.id} must have a positive version`);
		const existing = this.#overlays.get(overlay.id);
		if (existing && existing.version >= overlay.version) {
			throw new Error(
				`Adaptive overlay ${overlay.id} version ${overlay.version} is not newer than ${existing.version}`,
			);
		}
		this.#overlays.set(overlay.id, structuredClone(overlay));
	}

	resolve(variant: ModelVariant, profile: ModelCapabilityProfile): ResolvedAdaptiveOverlays {
		const scopeOrder: Record<AdaptiveOverlay["scope"], number> = { universal: 0, family: 1, model: 2 };
		const matches = [...this.#overlays.values()]
			.filter(overlay => {
				const selector = overlay.selector;
				if (selector.providers && !selector.providers.includes(variant.provider)) return false;
				if (selector.families && !selector.families.includes(variant.family)) return false;
				if (selector.variantKeys && !selector.variantKeys.includes(variant.key)) return false;
				if (
					selector.maxToolSchemaReliability !== undefined &&
					profile.toolSchemaReliability > selector.maxToolSchemaReliability
				) {
					return false;
				}
				if (selector.maxPlanningHorizon !== undefined && profile.planningHorizon > selector.maxPlanningHorizon) {
					return false;
				}
				if (
					selector.minInstructionRetention !== undefined &&
					profile.instructionRetention < selector.minInstructionRetention
				) {
					return false;
				}
				return true;
			})
			.sort((left, right) => scopeOrder[left.scope] - scopeOrder[right.scope] || left.priority - right.priority);

		const policy: AdaptivePolicyPatch = {};
		for (const overlay of matches) {
			const priorBudget = policy.budget;
			Object.assign(policy, overlay.policy);
			if (overlay.policy.budget) policy.budget = { ...priorBudget, ...overlay.policy.budget };
		}
		return { policy, ids: matches.map(overlay => overlay.id) };
	}

	list(): AdaptiveOverlay[] {
		return [...this.#overlays.values()].map(overlay => structuredClone(overlay));
	}
}
