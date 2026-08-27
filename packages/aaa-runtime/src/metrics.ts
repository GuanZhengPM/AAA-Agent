import type { AgentRunDiagnostics, HarnessRunMetrics, HarnessTax, Model, UsageMetrics } from "./types";

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
	return (
		(usage.inputTokens * model.pricing.inputPerMillion +
			(usage.outputTokens + usage.reasoningTokens) * model.pricing.outputPerMillion +
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
	#providerRequests = 0;
	#providerRetries = 0;
	#providerLatencyMs = 0;
	#providerWaitMs = 0;
	#toolLatencyMs = 0;
	#contextCompactions = 0;

	recordUsage(usage: UsageMetrics): void {
		addUsageMetrics(this.#usage, usage);
	}

	recordFirstAction(at = Date.now()): void {
		this.#firstActionAt ??= at;
	}

	recordUsefulResult(at = Date.now()): void {
		this.#firstUsefulResultAt ??= at;
	}

	recordDiagnostics(diagnostics: AgentRunDiagnostics | undefined): void {
		if (!diagnostics) return;
		this.#providerRequests += diagnostics.providerRequests ?? 0;
		this.#providerRetries += diagnostics.providerRetries ?? 0;
		this.#providerLatencyMs += diagnostics.providerLatencyMs ?? 0;
		this.#providerWaitMs += diagnostics.providerWaitMs ?? 0;
		this.#toolLatencyMs += diagnostics.toolLatencyMs ?? 0;
		this.#contextCompactions += diagnostics.contextCompactions ?? 0;
	}

	recordSubagents(
		count: number,
		usage: UsageMetrics,
		diagnostics: readonly (AgentRunDiagnostics | undefined)[] = [],
	): void {
		this.#subagentSpawns += count;
		this.#subagentTokens += activeTokenCount(usage);
		this.recordUsage(usage);
		for (const item of diagnostics) this.recordDiagnostics(item);
	}

	recordVerification(usage: UsageMetrics, diagnostics?: AgentRunDiagnostics): void {
		this.#verificationAttempts += 1;
		this.recordUsage(usage);
		this.recordDiagnostics(diagnostics);
	}

	finish(success: boolean, falseCompletion: boolean, completedAt = Date.now()): HarnessRunMetrics {
		return {
			...this.#usage,
			startedAt: this.startedAt,
			providerRequests: this.#providerRequests,
			providerRetries: this.#providerRetries,
			providerLatencyMs: this.#providerLatencyMs,
			providerWaitMs: this.#providerWaitMs,
			toolLatencyMs: this.#toolLatencyMs,
			contextCompactions: this.#contextCompactions,
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
