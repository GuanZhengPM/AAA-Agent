import { describe, expect, test } from "bun:test";
import { createDefaultCapabilityProfile } from "../src/capability-registry";
import {
	AdaptiveGoalStore,
	DEFAULT_VERIFICATION_CRITERION_ID,
	deliverablePathFromCriterionId,
	deriveDefaultGoalCriteria,
} from "../src/goals";
import { AdaptiveHarness } from "../src/harness";
import { maxLongRunRounds } from "../src/long-run";
import { createEmptyUsageMetrics } from "../src/metrics";
import type { AdaptivePolicySnapshot, EvidenceRef, ExecutionLane, ModelVariant } from "../src/types";

const variant: ModelVariant = {
	key: "test:model",
	provider: "test",
	modelId: "model",
	api: "openai-chat-completions",
	endpoint: "https://example.invalid",
	authChannel: "api_key",
	servicePlan: "payg",
	family: "test",
	reasoningConfig: "low",
	efforts: ["low"],
	toolSchemaVersion: "v1",
};

describe("default goal criteria", () => {
	test("derives explicit deliverables and executable verification requests", () => {
		const criteria = deriveDefaultGoalCriteria("创建 `reports/AUDIT.md`，然后运行测试");
		expect(criteria.map(criterion => criterion.id)).toContain(DEFAULT_VERIFICATION_CRITERION_ID);
		const deliverable = criteria.find(criterion => deliverablePathFromCriterionId(criterion.id));
		expect(deliverablePathFromCriterionId(deliverable?.id ?? "")).toBe("reports/AUDIT.md");
	});

	test("does not mistake analysis wording for an executable verification request", () => {
		const criteria = deriveDefaultGoalCriteria("检查代码为什么删除失败，不要修改任何文件");
		expect(criteria.map(criterion => criterion.id)).toEqual(["result"]);
	});

	test("requires evidence for every derived criterion", () => {
		const goals = new AdaptiveGoalStore("checklist", "Write REPORT.md and run tests");
		const root = goals.snapshot()[0];
		expect(root?.criteria).toHaveLength(3);
		goals.setStatus("root", "done");
		expect(goals.completionReport()).toMatchObject({
			complete: false,
			missingCriteria: expect.arrayContaining(["root:result", "root:verification"]),
		});
	});

	test("does not let generic output or unrelated evidence satisfy typed criteria", async () => {
		const evidence: EvidenceRef[] = [
			{ kind: "file", ref: "read:1", summary: "Host completed read successfully; target=OTHER.md" },
			{ kind: "test", ref: "shell:2", summary: "Host observed shell failure; target=bun test; exitCode=1" },
		];
		const result = await new AdaptiveHarness({
			executor: {
				async execute() {
					return {
						success: true,
						output: "done",
						completedGoalIds: ["root"],
						usage: createEmptyUsageMetrics(),
					};
				},
				async verify() {
					return {
						passed: true,
						summary: "claims accepted",
						evidence,
						hostEvidence: evidence,
						usage: createEmptyUsageMetrics(),
					};
				},
			},
		}).run({ task: "Write REPORT.md and run tests", model: variant });
		expect(result.success).toBe(false);
		expect(result.goalReport.missingCriteria).toEqual(
			expect.arrayContaining(["root:verification", expect.stringMatching(/^root:deliverable:/)]),
		);
	});

	test("binds file and passing-check evidence to their matching criteria", async () => {
		const evidence: EvidenceRef[] = [
			{
				kind: "file",
				ref: "read:1",
				summary: "Host completed read successfully; target=/workspace/REPORT.md",
			},
			{
				kind: "test",
				ref: "shell:2",
				summary: "Host completed shell successfully; target=bun test; exitCode=0",
			},
		];
		const result = await new AdaptiveHarness({
			executor: {
				async execute() {
					return {
						success: true,
						output: "done",
						completedGoalIds: ["root"],
						usage: createEmptyUsageMetrics(),
					};
				},
				async verify() {
					return {
						passed: true,
						summary: "verified",
						evidence,
						hostEvidence: evidence,
						usage: createEmptyUsageMetrics(),
					};
				},
			},
		}).run({ task: "Write REPORT.md and run tests", model: variant });
		expect(result.success).toBe(true);
		expect(result.goalReport.complete).toBe(true);
		const criteria = result.checkpoint.requirements[0]?.criteria ?? [];
		expect(criteria.find(item => item.id === DEFAULT_VERIFICATION_CRITERION_ID)?.evidence).toEqual([evidence[1]]);
		const deliverable = criteria.find(item => deliverablePathFromCriterionId(item.id));
		expect(deliverable?.evidence).toEqual([evidence[0]]);
	});
});

describe("long-run recovery budget", () => {
	const snapshot = (lane: ExecutionLane, verification: "none" | "targeted"): AdaptivePolicySnapshot => ({
		createdAt: 1,
		taskSlice: "coding",
		profile: createDefaultCapabilityProfile(variant),
		route: {
			reasons: [],
			appliedOverlays: [],
			policy: {
				lane,
				goalLevel: lane === "orchestrated" ? "dag" : lane === "guided" ? "checklist" : "implicit",
				autoSubagents: lane === "orchestrated" ? "read-only" : "off",
				verification,
				toolSurface: "standard",
				permissions: "write",
				toolBudget: 8,
				maxToolCalls: 16,
				reasoningEffort: "low",
				maxRepeatedToolCalls: 2,
				maxConsecutiveToolFailures: 2,
				budget: {
					maxTurns: 20,
					deadlineMs: 60_000,
					subagentMaxParallel: 0,
					subagentMaxDepth: 0,
					subagentMaxTurns: 0,
					subagentTotalTokens: 0,
					subagentMaxTokens: 0,
				},
				maxTotalTokens: 100_000,
			},
		},
	});

	test("scales recovery rounds with orchestration complexity", () => {
		expect(maxLongRunRounds(snapshot("direct", "none"))).toBe(1);
		expect(maxLongRunRounds(snapshot("direct", "targeted"))).toBe(2);
		expect(maxLongRunRounds(snapshot("guided", "targeted"))).toBe(3);
		expect(maxLongRunRounds(snapshot("orchestrated", "targeted"))).toBe(4);
	});
});
