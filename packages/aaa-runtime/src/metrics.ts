import type { HarnessRunMetrics, HarnessTax, Model, UsageMetrics } from "./types";

export function createEmptyUsageMetrics(): UsageMetrics {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		costUsd: 0,
		toolCalls: 0,
	};
}

export function addUsageMetrics(target: UsageMetrics, source: UsageMetrics): void {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	target.reasoningTokens += source.reasoningTokens;
	target.costUsd += source.costUsd;
	target.toolCalls += source.toolCalls;
}

/** Provider-billed work used for cross-run tax comparisons. Cache reads stay separate. */
export function activeTokenCount(metrics: UsageMetrics): number {
	return metrics.inputTokens + metrics.outputTokens + metrics.reasoningTokens + metrics.cacheWriteTokens;
}
/** Apply optional catalog pricing to normalized provider usage. */
export function calculateModelUsageCost(model: Model, usage: UsageMetrics): number {
	if (!model.pricing) return 0;
	const uncachedInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
	return (
		(uncachedInput * model.pricing.inputPerMillion +
			usage.outputTokens * model.pricing.outputPerMillion +
			usage.cacheReadTokens * (model.pricing.cacheReadPerMillion ?? model.pricing.inputPerMillion) +
			usage.cacheWriteTokens * (model.pricing.cacheWritePerMillion ?? model.pricing.inputPerMillion)) /
		1_000_000
	);
}

export function calculateHarnessTax(adaptive: HarnessRunMetrics, baseline: HarnessRunMetrics): HarnessTax {
	const baselineTokens = activeTokenCount(baseline);
	const adaptiveTokens = activeTokenCount(adaptive);
	const baselineLatency = Math.max(0, baseline.completedAt - baseline.startedAt);
	const adaptiveLatency = Math.max(0, adaptive.completedAt - adaptive.startedAt);
	return {
		tokenRatio:
			baselineTokens === 0
				? adaptiveTokens === 0
					? 0
					: Number.POSITIVE_INFINITY
				: adaptiveTokens / baselineTokens - 1,
		latencyMs: adaptiveLatency - baselineLatency,
		costRatio:
			baseline.costUsd === 0
				? adaptive.costUsd === 0
					? 0
					: Number.POSITIVE_INFINITY
				: adaptive.costUsd / baseline.costUsd - 1,
		toolCallRatio:
			baseline.toolCalls === 0
				? adaptive.toolCalls === 0
					? 0
					: Number.POSITIVE_INFINITY
				: adaptive.toolCalls / baseline.toolCalls - 1,
	};
}

export class HarnessMetricsCollector {
	readonly startedAt = Date.now();
	#usage = createEmptyUsageMetrics();
	#firstActionAt?: number;
	#firstUsefulResultAt?: number;
	#subagentSpawns = 0;
	#subagentTokens = 0;
	#verificationAttempts = 0;

	recordUsage(usage: UsageMetrics): void {
		addUsageMetrics(this.#usage, usage);
	}

	recordFirstAction(at = Date.now()): void {
		this.#firstActionAt ??= at;
	}

	recordUsefulResult(at = Date.now()): void {
		this.#firstUsefulResultAt ??= at;
	}

	recordSubagents(count: number, usage: UsageMetrics): void {
		this.#subagentSpawns += count;
		this.#subagentTokens += activeTokenCount(usage);
		this.recordUsage(usage);
	}

	recordVerification(usage: UsageMetrics): void {
		this.#verificationAttempts += 1;
		this.recordUsage(usage);
	}

	finish(success: boolean, falseCompletion: boolean, completedAt = Date.now()): HarnessRunMetrics {
		return {
			...this.#usage,
			startedAt: this.startedAt,
			completedAt,
			timeToFirstActionMs: this.#firstActionAt === undefined ? undefined : this.#firstActionAt - this.startedAt,
			timeToFirstUsefulResultMs:
				this.#firstUsefulResultAt === undefined ? undefined : this.#firstUsefulResultAt - this.startedAt,
			subagentSpawns: this.#subagentSpawns,
			subagentTokens: this.#subagentTokens,
			verificationAttempts: this.#verificationAttempts,
			falseCompletion,
			success,
		};
	}
}
