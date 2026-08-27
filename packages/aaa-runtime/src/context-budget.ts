const ESTIMATED_CHARACTERS_PER_TOKEN = 1.5;

/**
 * Economic working set, distinct from the model's hard safety window.
 *
 * Large context is useful capacity, but replaying half of a 1M-token window on
 * every tool turn is rarely economical. Fractions decrease as windows grow;
 * the current task can raise the target, and the result always remains model-
 * relative rather than collapsing every model onto one global hard cap.
 */
export function resolveWorkingContextCharacters(
	contextWindowTokens: number,
	currentTaskCharacters = 0,
	charactersPerToken = ESTIMATED_CHARACTERS_PER_TOKEN,
): number {
	const tokens = Math.max(1_000, Math.floor(contextWindowTokens));
	const calibratedRatio = Math.max(0.75, Math.min(6, charactersPerToken));
	const capacity = tokens * calibratedRatio;
	const fraction = tokens <= 32_000 ? 0.5 : tokens <= 256_000 ? 0.35 : tokens <= 512_000 ? 0.22 : 0.12;
	const baseline = capacity * fraction;
	const taskMinimum = Math.max(1_500, currentTaskCharacters * 1.25 + 4_000);
	// A single current task may use up to 75% (the app-level admission limit),
	// while ordinary replay remains at the economic baseline.
	return Math.max(1_500, Math.floor(Math.min(capacity * 0.75, Math.max(baseline, taskMinimum))));
}

export function resolveHistoryWorkingBudget(
	contextWindowTokens: number,
	currentTaskCharacters = 0,
): { trigger: number; keepRecent: number; maxDigest: number } {
	const working = resolveWorkingContextCharacters(contextWindowTokens, currentTaskCharacters);
	const trigger = Math.max(1_500, Math.floor(working * 0.7));
	return {
		trigger,
		keepRecent: Math.max(750, Math.floor(trigger * 0.45)),
		maxDigest: Math.max(750, Math.floor(working * 0.2)),
	};
}
