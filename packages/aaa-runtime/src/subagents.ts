import { mapWithConcurrencyLimit } from "./concurrency";
import { activeTokenCount, addUsageMetrics, createEmptyUsageMetrics } from "./metrics";
import type {
	ExecutionPolicy,
	ModelCapabilityProfile,
	ModelVariant,
	SubagentBatchResult,
	SubagentResult,
	SubagentRunContext,
	SubagentTask,
} from "./types";

export type SubagentRunner = (task: SubagentTask, context: SubagentRunContext) => Promise<SubagentResult>;
const subagentStatuses: Record<string, true> = {
	succeeded: true,
	partial: true,
	failed: true,
	skipped: true,
};
const usageKeys = [
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"reasoningTokens",
	"costUsd",
	"toolCalls",
] as const;

function isSubagentResult(value: unknown): value is SubagentResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const result = value as Partial<SubagentResult>;
	const usage = result.usage;
	if (typeof usage !== "object" || usage === null) return false;
	if (
		usageKeys.some(key => {
			const metric = usage[key];
			return typeof metric !== "number" || !Number.isFinite(metric) || metric < 0;
		})
	)
		return false;
	return (
		typeof result.taskId === "string" &&
		typeof result.status === "string" &&
		subagentStatuses[result.status] === true &&
		Array.isArray(result.findings) &&
		Array.isArray(result.unresolved) &&
		result.unresolved.every(item => typeof item === "string") &&
		(result.sufficient === undefined || typeof result.sufficient === "boolean") &&
		(result.error === undefined || typeof result.error === "string")
	);
}

/** Executes isolated subagent tasks in dependency waves under hard breadth, depth, time, and token budgets. */
export class BoundedSubagentScheduler {
	#runner: SubagentRunner;

	constructor(runner: SubagentRunner) {
		this.#runner = runner;
	}

	async run(
		tasks: SubagentTask[],
		model: ModelVariant,
		profile: ModelCapabilityProfile,
		policy: ExecutionPolicy,
		externalSignal?: AbortSignal,
	): Promise<SubagentBatchResult> {
		const startedAt = Date.now();
		const byId = new Map<string, SubagentTask>();
		for (const task of tasks) {
			if (byId.has(task.id)) throw new Error(`Duplicate subagent task id: ${task.id}`);
			byId.set(task.id, task);
		}
		for (const task of tasks) {
			for (const dependency of task.dependencies ?? []) {
				if (!byId.has(dependency))
					throw new Error(`Subagent task ${task.id} depends on unknown task ${dependency}`);
			}
		}

		const controller = new AbortController();
		const timeoutSignal = AbortSignal.timeout(Math.max(1, policy.budget.deadlineMs));
		const signal = externalSignal
			? AbortSignal.any([externalSignal, timeoutSignal, controller.signal])
			: AbortSignal.any([timeoutSignal, controller.signal]);
		const pending = new Map(byId);
		const completed = new Map<string, SubagentResult>();
		let remainingTokens = policy.budget.subagentTotalTokens;
		let spawns = 0;

		while (pending.size > 0 && !signal.aborted) {
			const dependencyFailed: SubagentTask[] = [];
			const ready: SubagentTask[] = [];
			for (const task of pending.values()) {
				const dependencies = task.dependencies ?? [];
				if (dependencies.some(id => completed.has(id) && completed.get(id)?.status !== "succeeded")) {
					dependencyFailed.push(task);
				} else if (dependencies.every(id => completed.has(id))) {
					ready.push(task);
				}
			}
			for (const task of dependencyFailed) {
				completed.set(task.id, this.#skipped(task.id, "dependency did not succeed"));
				pending.delete(task.id);
			}
			if (ready.length === 0) {
				if (pending.size > 0) {
					for (const task of pending.values()) completed.set(task.id, this.#skipped(task.id, "dependency cycle"));
					pending.clear();
				}
				break;
			}

			const runnable: SubagentTask[] = [];
			for (const task of ready) {
				const rejection = this.#rejectionReason(task, policy);
				if (rejection) completed.set(task.id, this.#skipped(task.id, rejection));
				else runnable.push(task);
				pending.delete(task.id);
			}
			const width = Math.max(1, policy.budget.subagentMaxParallel);
			const fairTokenLimit = Math.max(1, Math.ceil(policy.budget.subagentTotalTokens / width));
			const batchRun = await mapWithConcurrencyLimit(
				runnable,
				width,
				async (task, _index, workerSignal) => {
					const requestedTokens = Math.max(
						1,
						Math.min(task.estimatedTokens ?? policy.budget.subagentMaxTokens, policy.budget.subagentMaxTokens),
					);
					const tokenLimit = Math.min(requestedTokens, fairTokenLimit, Math.max(0, remainingTokens));
					if (tokenLimit <= 0) return this.#skipped(task.id, "subagent token budget exhausted");
					remainingTokens -= tokenLimit;
					spawns += 1;
					const result = await this.#runTask(
						task,
						model,
						profile,
						policy.budget.subagentMaxTurns,
						tokenLimit,
						policy.maxTotalTokens,
						workerSignal,
					);
					remainingTokens += tokenLimit - activeTokenCount(result.usage);
					if (result.status === "succeeded" && result.sufficient) {
						controller.abort("sufficient subagent result received");
					}
					return result;
				},
				signal,
			);
			for (let index = 0; index < runnable.length; index += 1) {
				const task = runnable[index];
				if (!task) continue;
				const reason = signal.aborted ? "scheduler deadline or cancellation" : "not run";
				completed.set(task.id, batchRun.results[index] ?? this.#skipped(task.id, reason));
			}
		}

		for (const task of pending.values()) {
			completed.set(
				task.id,
				this.#skipped(task.id, signal.aborted ? "scheduler deadline or cancellation" : "not run"),
			);
		}
		const ordered = tasks.map(task => completed.get(task.id) ?? this.#skipped(task.id, "not run"));
		const usage = createEmptyUsageMetrics();
		for (const result of ordered) addUsageMetrics(usage, result.usage);
		return { results: ordered, usage, wallTimeMs: Date.now() - startedAt, spawns };
	}

	#rejectionReason(task: SubagentTask, policy: ExecutionPolicy): string | undefined {
		if (policy.budget.subagentMaxParallel <= 0 || policy.budget.subagentMaxTokens <= 0) {
			return "subagents are disabled by the execution budget";
		}
		if (policy.autoSubagents === "off" && task.origin !== "user") return "automatic subagents are disabled";
		if ((task.depth ?? 1) > policy.budget.subagentMaxDepth) return "subagent recursion depth exceeded";
		if (task.mode === "write" && !task.isolated) return "write subagents require isolation";
		if (task.mode === "write" && policy.autoSubagents === "read-only" && task.origin !== "user") {
			return "automatic write subagents are disabled";
		}
		return undefined;
	}

	async #runTask(
		task: SubagentTask,
		model: ModelVariant,
		profile: ModelCapabilityProfile,
		subagentMaxTurns: number,
		subagentMaxTokens: number,
		totalMaxTokens: number,
		signal: AbortSignal,
	): Promise<SubagentResult> {
		if (signal.aborted) return this.#skipped(task.id, "scheduler deadline or cancellation");
		const aborted = Promise.withResolvers<SubagentResult>();
		const onAbort = (): void => {
			const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "cancelled");
			aborted.resolve(this.#skipped(task.id, `scheduler deadline or cancellation: ${reason}`));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			const result = await Promise.race([
				this.#runner(task, {
					model,
					profile,
					budget: { subagentMaxTurns, subagentMaxTokens, totalMaxTokens },
					signal,
				}),
				aborted.promise,
			]);
			if (!isSubagentResult(result)) return this.#failed(task, "runner returned an invalid result");
			if (result.taskId !== task.id) {
				return this.#failed(task, `runner returned task id ${result.taskId} for ${task.id}`);
			}
			return result;
		} catch (error) {
			return this.#failed(task, error instanceof Error ? error.message : String(error));
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#failed(task: SubagentTask, error: string): SubagentResult {
		return {
			taskId: task.id,
			status: "failed",
			findings: [],
			unresolved: [task.prompt],
			usage: createEmptyUsageMetrics(),
			error,
		};
	}

	#skipped(taskId: string, error: string): SubagentResult {
		return {
			taskId,
			status: "skipped",
			findings: [],
			unresolved: [],
			usage: createEmptyUsageMetrics(),
			error,
		};
	}
}
