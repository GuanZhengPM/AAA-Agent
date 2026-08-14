import { activeTokenCount, type HarnessRunRecord } from "@aaa-agent/runtime";

export interface ModelRunSummary {
	variantKey: string;
	runs: number;
	verifiedSuccessRate: number;
	falseCompletionRate: number;
	averageActiveTokens: number;
	averageLatencyMs: number;
	averageCostUsd: number;
	averageToolCalls: number;
}

export function summarizeRuns(records: readonly HarnessRunRecord[]): ModelRunSummary[] {
	const grouped = new Map<string, HarnessRunRecord[]>();
	for (const record of records) {
		const group = grouped.get(record.variantKey);
		if (group) group.push(record);
		else grouped.set(record.variantKey, [record]);
	}
	return [...grouped.entries()]
		.map(([variantKey, runs]) => {
			const count = runs.length;
			const total = runs.reduce(
				(accumulator, run) => {
					accumulator.successes += run.metrics.success ? 1 : 0;
					accumulator.falseCompletions += run.metrics.falseCompletion ? 1 : 0;
					accumulator.tokens += activeTokenCount(run.metrics);
					accumulator.latency += Math.max(0, run.metrics.completedAt - run.metrics.startedAt);
					accumulator.cost += run.metrics.costUsd;
					accumulator.tools += run.metrics.toolCalls;
					return accumulator;
				},
				{ successes: 0, falseCompletions: 0, tokens: 0, latency: 0, cost: 0, tools: 0 },
			);
			return {
				variantKey,
				runs: count,
				verifiedSuccessRate: total.successes / count,
				falseCompletionRate: total.falseCompletions / count,
				averageActiveTokens: total.tokens / count,
				averageLatencyMs: total.latency / count,
				averageCostUsd: total.cost / count,
				averageToolCalls: total.tools / count,
			};
		})
		.sort(
			(left, right) =>
				right.verifiedSuccessRate - left.verifiedSuccessRate ||
				left.averageActiveTokens - right.averageActiveTokens,
		);
}

export function formatRunReport(records: readonly HarnessRunRecord[]): string {
	const summaries = summarizeRuns(records);
	if (summaries.length === 0) return "No recorded AAA Agent runs.";
	const lines = [
		"model variant                                      runs  success  false   tokens    latency   cost      tools",
	];
	for (const summary of summaries) {
		lines.push(
			`${summary.variantKey.slice(0, 50).padEnd(50)} ${String(summary.runs).padStart(4)}  ${`${(summary.verifiedSuccessRate * 100).toFixed(1)}%`.padStart(7)}  ${`${(summary.falseCompletionRate * 100).toFixed(1)}%`.padStart(6)}  ${Math.round(summary.averageActiveTokens).toLocaleString().padStart(8)}  ${(summary.averageLatencyMs / 1_000).toFixed(1).padStart(7)}s  $${summary.averageCostUsd.toFixed(4).padStart(7)}  ${summary.averageToolCalls.toFixed(1).padStart(5)}`,
		);
	}
	return lines.join("\n");
}
