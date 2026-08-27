import { deriveCapabilityObservation } from "./capability-observation";
import { createDefaultCapabilityProfile, ModelCapabilityRegistry } from "./capability-registry";
import { AdaptiveGoalStore } from "./goals";
import {
	collectCheckpointArtifacts,
	createAuditReport,
	createLongRunCheckpoint,
	mergeVerifiedFacts,
	resumeLongRunCheckpoint,
} from "./long-run";
import { calculateHarnessTax, createEmptyUsageMetrics, HarnessMetricsCollector } from "./metrics";
import { AdaptiveOverlayRegistry } from "./overlay-registry";
import { inferTaskFeatures, inferTaskSlice, routeTask } from "./router";
import { BoundedSubagentScheduler, type SubagentRunner } from "./subagents";
import type {
	AdaptiveHarnessEvent,
	AdaptiveHarnessExecutor,
	AdaptiveHarnessRequest,
	AdaptiveHarnessResult,
	EvidenceRef,
	GoalEvidenceSubmission,
	LongRunCheckpoint,
	PrimaryExecutionResult,
	SubagentResult,
	VerificationResult,
} from "./types";

function createInterruptionError(label: string, signal: AbortSignal): Error {
	const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
	const error = new Error(`${label} ${timedOut ? "timed out" : "cancelled"}`, { cause: signal.reason });
	error.name = timedOut ? "TimeoutError" : "AbortError";
	return error;
}

function throwIfAborted(label: string, signal: AbortSignal): void {
	if (signal.aborted) throw createInterruptionError(label, signal);
}

async function runWithAbort<T>(label: string, signal: AbortSignal, start: () => Promise<T>): Promise<T> {
	throwIfAborted(label, signal);
	const aborted = Promise.withResolvers<T>();
	const onAbort = (): void => aborted.reject(createInterruptionError(label, signal));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([start(), aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

interface RunDeadline {
	signal: AbortSignal;
	cancel(): void;
}

function createRunDeadline(milliseconds: number): RunDeadline {
	const controller = new AbortController();
	const timeoutReason = new Error("Harness deadline exceeded");
	timeoutReason.name = "TimeoutError";
	const timer = setTimeout(() => controller.abort(timeoutReason), milliseconds);
	timer.unref();
	return {
		signal: controller.signal,
		cancel() {
			clearTimeout(timer);
		},
	};
}

function attachGoalEvidence(goals: AdaptiveGoalStore, submissions: readonly GoalEvidenceSubmission[]): void {
	for (const submission of submissions) {
		goals.attachEvidence(submission.goalId, submission.criterionId, submission.evidence);
	}
}

function attachDefaultGoalEvidence(
	goals: AdaptiveGoalStore,
	goalIds: ReadonlySet<string>,
	evidence: readonly EvidenceRef[],
): void {
	for (const goal of goals.snapshot()) {
		if (!goalIds.has(goal.id)) continue;
		for (const criterion of goal.criteria) {
			if (criterion.evidence.length > 0) continue;
			for (const item of evidence) goals.attachEvidence(goal.id, criterion.id, item);
		}
	}
}

function commitGoalsWithSatisfiedCriteria(goals: AdaptiveGoalStore, completedGoalIds: ReadonlySet<string>): void {
	const eligible = goals
		.snapshot()
		.filter(
			goal =>
				completedGoalIds.has(goal.id) &&
				goal.criteria.every(criterion => !criterion.required || criterion.evidence.length > 0),
		)
		.map(goal => goal.id);
	if (eligible.length > 0) commitCompletedGoals(goals, eligible);
}

function commitCompletedGoals(goals: AdaptiveGoalStore, completedGoalIds: readonly string[]): void {
	const pending = new Set(completedGoalIds);
	while (pending.size > 0) {
		const snapshot = goals.snapshot();
		let advanced = false;
		for (const goalId of pending) {
			const goal = snapshot.find(candidate => candidate.id === goalId);
			if (!goal) throw new Error(`Auditor completed unknown goal ${goalId}`);
			if (!goal.dependencies.every(id => snapshot.find(candidate => candidate.id === id)?.status === "done"))
				continue;
			goals.setStatus(goalId, "done");
			pending.delete(goalId);
			advanced = true;
		}
		if (!advanced) {
			throw new Error(`Auditor completed goals before their dependencies: ${[...pending].join(", ")}`);
		}
	}
}

function cloneCheckpoint(checkpoint: LongRunCheckpoint): LongRunCheckpoint {
	return structuredClone(checkpoint);
}

export interface AdaptiveHarnessOptions {
	executor: AdaptiveHarnessExecutor;
	capabilities?: ModelCapabilityRegistry;
	overlays?: AdaptiveOverlayRegistry;
	subagentRunner?: SubagentRunner;
	onEvent?: (event: AdaptiveHarnessEvent) => void;
}

/**
 * Zero-background-call orchestration kernel. A frozen policy drives an
 * execute-audit-checkpoint recovery loop; learning affects only later tasks.
 */
export class AdaptiveHarness {
	readonly capabilities: ModelCapabilityRegistry;
	readonly overlays: AdaptiveOverlayRegistry;
	#executor: AdaptiveHarnessExecutor;
	#scheduler?: BoundedSubagentScheduler;
	#onEvent?: (event: AdaptiveHarnessEvent) => void;

	constructor(options: AdaptiveHarnessOptions) {
		this.#executor = options.executor;
		this.capabilities = options.capabilities ?? new ModelCapabilityRegistry();
		this.overlays = options.overlays ?? new AdaptiveOverlayRegistry();
		this.#scheduler = options.subagentRunner ? new BoundedSubagentScheduler(options.subagentRunner) : undefined;
		this.#onEvent = options.onEvent;
	}

	async run(request: AdaptiveHarnessRequest): Promise<AdaptiveHarnessResult> {
		this.#onEvent?.({ type: "run_started", task: request.task, model: request.model });
		const metrics = new HarnessMetricsCollector();
		const features = inferTaskFeatures(request.task, request.featureHints);
		const adaptive = request.adaptive !== false;
		const requestedSubagents = request.subagentTasks ?? [];
		if (requestedSubagents.length > 0) features.independentBranches = Math.max(2, features.independentBranches);
		if (request.goals?.some(goal => goal.dependencies.length > 0)) features.requiresGoalDag = true;
		const taskSlice = inferTaskSlice(request.task, features);

		const resumed = request.checkpoint
			? resumeLongRunCheckpoint(request.checkpoint, request.task, request.model.key)
			: undefined;
		const profile = resumed
			? structuredClone(resumed.policySnapshot.profile)
			: adaptive
				? this.capabilities.resolve(request.model, taskSlice)
				: createDefaultCapabilityProfile(request.model, {}, taskSlice);
		const route = resumed
			? structuredClone(resumed.policySnapshot.route)
			: (() => {
					const overlay = adaptive ? this.overlays.resolve(request.model, profile) : { ids: [], policy: {} };
					return routeTask(features, profile, overlay.policy, overlay.ids, request.model);
				})();
		this.#onEvent?.({ type: "routed", decision: route });
		if (requestedSubagents.length > 0 && !this.#scheduler) {
			throw new Error("Subagent tasks require a configured subagentRunner");
		}

		const deadline = createRunDeadline(Math.max(1, route.policy.budget.deadlineMs));
		const signal = request.signal ? AbortSignal.any([request.signal, deadline.signal]) : deadline.signal;
		try {
			const hasCustomGoals = Boolean(
				request.goals?.length || resumed?.requirements.some(goal => goal.id !== "root"),
			);
			const goals = new AdaptiveGoalStore(
				route.policy.goalLevel,
				request.task,
				resumed?.requirements ?? request.goals,
			);
			const checkpoint =
				resumed ??
				createLongRunCheckpoint({
					task: request.task,
					variantKey: request.model.key,
					requirements: goals.snapshot(),
					policySnapshot: { createdAt: Date.now(), taskSlice, profile, route },
				});
			const persistCheckpoint = async (): Promise<void> => {
				checkpoint.requirements = goals.snapshot();
				checkpoint.updatedAt = Date.now();
				await request.onCheckpoint?.(cloneCheckpoint(checkpoint));
			};
			await persistCheckpoint();

			let subagentResults: SubagentResult[] = [];
			if (
				checkpoint.currentRound === 0 &&
				route.policy.lane === "orchestrated" &&
				route.policy.autoSubagents !== "off" &&
				requestedSubagents.length > 0 &&
				this.#scheduler
			) {
				const batch = await this.#scheduler.run(requestedSubagents, request.model, profile, route.policy, signal);
				subagentResults = batch.results;
				metrics.recordSubagents(
					batch.spawns,
					batch.usage,
					batch.results.map(result => result.diagnostics),
				);
				this.#onEvent?.({ type: "subagents_completed", results: subagentResults });
			}

			let primary: PrimaryExecutionResult = {
				success: false,
				output: "",
				usage: createEmptyUsageMetrics(),
			};
			let verification: VerificationResult | undefined;
			let audit = checkpoint.lastAudit;
			let success = false;
			let falseCompletionObserved = checkpoint.audits.some(previous => previous.outcome === "incomplete");
			try {
				while (checkpoint.currentRound < checkpoint.maxRounds) {
					const round = checkpoint.inFlightRound ?? checkpoint.currentRound + 1;
					checkpoint.inFlightRound = round;
					this.#onEvent?.({
						type: "round_started",
						round,
						maxRounds: checkpoint.maxRounds,
						...(checkpoint.recoveryGuidance ? { recovery: checkpoint.recoveryGuidance } : {}),
					});
					checkpoint.status = "running";
					await persistCheckpoint();
					throwIfAborted("Harness run", signal);
					const context = {
						task: request.task,
						model: request.model,
						profile,
						policy: route.policy,
						goals: goals.snapshot(),
						goalFrontier: goals.frontier(),
						subagentResults,
						round,
						maxRounds: checkpoint.maxRounds,
						...(checkpoint.recoveryGuidance ? { recoveryGuidance: checkpoint.recoveryGuidance } : {}),
						verifiedFacts: structuredClone(checkpoint.facts),
						artifacts: structuredClone(checkpoint.artifacts),
						...(request.contextState ? { contextState: structuredClone(request.contextState) } : {}),
						signal,
					};
					primary = await runWithAbort("Primary execution", signal, () => this.#executor.execute(context));
					throwIfAborted("Harness run", signal);
					if (primary.diagnostics?.firstActionAt !== undefined) {
						metrics.recordFirstAction(primary.diagnostics.firstActionAt);
					}
					metrics.recordUsage(primary.usage);
					metrics.recordDiagnostics(primary.diagnostics);
					if (primary.output.trim()) metrics.recordUsefulResult();
					this.#onEvent?.({ type: "primary_completed", result: primary });
					if (primary.workspaceMutated && route.policy.verification === "none") {
						route.policy.verification = "targeted";
						checkpoint.policySnapshot.route.policy.verification = "targeted";
					} else if (
						primary.workspaceMutated === false &&
						route.policy.verification === "targeted" &&
						// Host-gate hardening: a RECOVERY round (one that follows a failed
						// verification) may not drop verification just because the model
						// avoided mutations this time — otherwise claims alone complete tasks.
						checkpoint.currentRound <= 0
					) {
						route.policy.verification = "none";
						checkpoint.policySnapshot.route.policy.verification = "none";
					}
					const claimedGoalIds = primary.completedGoalIds ?? (hasCustomGoals ? [] : ["root"]);

					if (route.policy.verification === "none") {
						throwIfAborted("Harness run", signal);
						const accepted = new Set(claimedGoalIds);
						attachGoalEvidence(goals, primary.goalEvidence ?? []);
						if (!hasCustomGoals) {
							attachDefaultGoalEvidence(
								goals,
								accepted,
								primary.evidence?.length
									? primary.evidence
									: primary.output.trim()
										? [{ kind: "output", ref: "primary-output", summary: primary.output.slice(0, 240) }]
										: [],
							);
						}
						if (primary.success) commitGoalsWithSatisfiedCriteria(goals, accepted);
					} else {
						const verifier = this.#executor.verify;
						verification = verifier
							? await runWithAbort("Verification", signal, () =>
									verifier({ ...context, goals: goals.snapshot(), goalFrontier: goals.frontier() }, primary),
								)
							: {
									passed: false,
									blocked: true,
									failureKind: "configuration",
									summary: `Policy requires ${route.policy.verification} verification, but no verifier is configured`,
									usage: createEmptyUsageMetrics(),
									recommendedRecovery: "Configure an independent verifier before resuming.",
								};
						audit = createAuditReport(verification, primary, claimedGoalIds);
						if (verifier) metrics.recordVerification(verification.usage, verification.diagnostics);
						this.#onEvent?.({ type: "verification_completed", result: verification });
						throwIfAborted("Harness run", signal);
						checkpoint.lastAudit = audit;
						checkpoint.audits.push(structuredClone(audit));
						if (primary.success && audit.outcome !== "complete") falseCompletionObserved = true;
						const accepted = new Set(audit.integrity === "clean" ? audit.completedGoalIds : []);
						if (accepted.size > 0) {
							const acceptedEvidence = audit.goalEvidence.filter(item => accepted.has(item.goalId));
							attachGoalEvidence(goals, acceptedEvidence);
							if (!hasCustomGoals) attachDefaultGoalEvidence(goals, accepted, audit.evidence);
							commitGoalsWithSatisfiedCriteria(goals, accepted);
						}
						checkpoint.artifacts = collectCheckpointArtifacts(checkpoint.artifacts, audit);
						checkpoint.facts = mergeVerifiedFacts(checkpoint.facts, audit);
					}
					checkpoint.currentRound = round;
					delete checkpoint.inFlightRound;

					const goalReport = goals.completionReport();
					success =
						primary.success &&
						goalReport.complete &&
						(route.policy.verification === "none" || audit?.outcome === "complete");
					if (success) {
						checkpoint.completedOutput = primary.output;
						checkpoint.status = "completed";
						delete checkpoint.recoveryGuidance;
						await persistCheckpoint();
						throwIfAborted("Harness run", signal);
						break;
					}
					if (audit?.outcome === "blocked") {
						checkpoint.status = "blocked";
						checkpoint.recoveryGuidance = audit.recommendedRecovery ?? audit.summary;
						await persistCheckpoint();
						throwIfAborted("Harness run", signal);
						break;
					}
					checkpoint.recoveryGuidance =
						audit?.recommendedRecovery ??
						(audit
							? `${audit.summary} Unmet: ${audit.unmetCriteria.join("; ") || goals.completionReport().missingCriteria.join("; ")}`
							: primary.output || "Execution did not complete the current goal frontier.");
					await persistCheckpoint();
					throwIfAborted("Harness run", signal);
				}
				if (!success && checkpoint.status === "running") {
					checkpoint.status = "blocked";
					checkpoint.recoveryGuidance ??= `Recovery budget exhausted after ${checkpoint.maxRounds} rounds.`;
					await persistCheckpoint();
					throwIfAborted("Harness run", signal);
				}
			} catch (error) {
				if (checkpoint.inFlightRound === undefined && checkpoint.currentRound > 0) {
					checkpoint.inFlightRound = checkpoint.currentRound;
					checkpoint.currentRound -= 1;
				}
				checkpoint.status = "interrupted";
				await persistCheckpoint();
				throw error;
			}

			const goalReport = goals.completionReport();
			const falseCompletion = falseCompletionObserved || (primary.success && !success);
			const finalMetrics = metrics.finish(success, falseCompletion);
			finalMetrics.recoveryRounds = Math.max(0, checkpoint.currentRound - 1);
			const result: AdaptiveHarnessResult = {
				output: primary.output,
				success,
				lane: route.policy.lane,
				route,
				verification,
				audit,
				checkpoint: cloneCheckpoint(checkpoint),
				goalReport,
				subagentResults,
				metrics: finalMetrics,
				...(primary.diagnostics ? { diagnostics: primary.diagnostics } : {}),
				tax: request.baselineMetrics ? calculateHarnessTax(finalMetrics, request.baselineMetrics) : undefined,
			};
			if (adaptive) {
				const capabilityObservation = deriveCapabilityObservation({
					primary,
					result,
					audit,
					audits: checkpoint.audits,
					rounds: checkpoint.currentRound,
					taskSlice,
					subagents: subagentResults,
				});
				result.capabilityObservation = capabilityObservation;
				this.capabilities.observe(request.model, capabilityObservation);
			}
			this.#onEvent?.({ type: "run_completed", result });
			return result;
		} finally {
			deadline.cancel();
		}
	}
}
