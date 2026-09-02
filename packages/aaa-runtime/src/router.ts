import type {
	AdaptivePolicyPatch,
	ExecutionLane,
	ExecutionPolicy,
	ModelCapabilityProfile,
	ModelVariant,
	RouteDecision,
	RouteOverrides,
	TaskFeatureHints,
	TaskFeatures,
	TaskSlice,
} from "./types";
import { Effort, THINKING_EFFORTS } from "./types";

const PATH_PATTERN = /(?:^|\s)(?:\.?\/?[\w.-]+\/)+[\w.-]+/g;
const PLAN_PATTERN = /\b(plan|todo|checklist|milestone)\b|计划|规划|步骤|清单/i;
const PARALLEL_PATTERN =
	/\b(?:parallelize|delegate)\b|\b(?:use|run|spawn|launch)\b.{0,48}\b(?:parallel|concurrent|subagents?)\b|\b(?:inspect|investigate|analyze|review|check|implement|fix|edit|research)\b.{0,80}\b(?:in parallel|concurrently)\b|(?:请|使用|启用|启动|安排|分配).{0,24}(?:并行|子代理|多代理)|并行(?:执行|处理|修改|检查|分析|调研)/i;
const NEGATED_PARALLEL_PATTERN =
	/\b(?:do not|don't|must not|never|without)\b.{0,32}\b(?:parallel|concurrent|subagents?)\b|(?:不得|不要|禁止|不准|无需|不用).{0,16}(?:并行|子代理|多代理)/gi;
const MULTI_FILE_PATTERN =
	/\b(multi[- ]file|multiple files|across files|multiple (?:repositories|repos|packages|projects))\b|多文件|多个文件|跨文件|多(?:个)?(?:仓库|项目|包)|跨(?:仓库|项目)|(?:两|二|三|四|五|六|七|八|九|十|\d+)\s*个?(?:文件|仓库|项目|包)/i;
const MULTI_STEP_PATTERN =
	/\b(multi[- ]step|multiple steps|end[- ]to[- ]end)\b|多步骤|多个步骤|端到端|全链路|一路追踪|逐个|分别|至少\s*[2-9]/i;
// Mutation permission must come from an affirmative action request, not merely
// from mentioning a mutation verb (for example, "analyze why delete failed").
const WRITE_REQUEST_PATTERN =
	/(?:^|[.!?;\n]\s*|\b(?:please|then|and|can you|could you|need to|must|should)\s+)(?:implement|fix|repair|resolve|add|create|build|update|edit|change|refactor|migrate|delete|remove|write|debug)\b|(?:^|[，。；;！!？?\n]\s*|(?:请|帮我|需要|必须|务必|直接|并|然后|再|接着|随后|分析后)\s*)(?:实现|修复|新增|创建|搭建|修改|改一下|改掉|改成|重构|迁移|删除|移除|编写|调试|排查并处理)/im;
const EXECUTABLE_VERIFICATION_PATTERN =
	/(?:^|[.!?;\n]\s*|\b(?:please|then|and|can you|could you|need to|must|should)\s+)(?:(?:run|execute)\s+(?:the\s+)?(?:tests?|checks?|lint|typecheck|build|smoke(?:\s+tests?)?)|test|verify|validate)\b|(?:^|[，。；;！!？?\n]\s*|(?:请|帮我|需要|必须|务必|直接|并|然后|再|接着|随后)\s*)(?:(?:运行|执行|跑)[^。；;\n]{0,12}(?:测试|检查|校验|构建)|(?:测试|验证|验收)(?:一下)?)/im;
const DESTRUCTIVE_PATTERN = /\b(drop|delete|remove|destroy|reset|rewrite|migrate)\b|删除|销毁|重置|重写|迁移/i;
const DEBUG_PATTERN = /\b(debug|bug|failure|error|crash|regression|broken)\b|调试|故障|错误|崩溃|回归|修复/i;
const RESEARCH_PATTERN = /\b(research|compare|survey|investigate|evidence|sources?)\b|研究|调研|比较|证据|来源/i;
const GUI_PATTERN = /\b(gui|browser|desktop|screenshot|visual|ui|ux)\b|界面|浏览器|桌面|截图|视觉/i;
const DOCUMENT_PATTERN = /\b(document|pdf|slides?|spreadsheet|translate)\b|文档|论文|报告|幻灯片|表格|翻译/i;

const EXPLICIT_READ_ONLY_PATTERN =
	/\b(?:read[- ]only|analysis only|inspect(?:ation)? only|for review only)\b|\b(?:do not|don't|must not|never|without)\b.{0,32}\b(?:modify|modifying|change|changing|edit|editing|write|writing|delete|deleting|remove|removing)\b|只(?:读|分析|看)|仅(?:分析|阅读|查看|了解)|(?:不要|不得|不能|别|请勿)\s*(?:再)?\s*(?:修改|编辑|写入|改动|改变|改|动)(?:任何)?(?:代码|文件|内容)?/i;
const QUESTION_TROUBLE_PATTERN =
	/(?:为什么|为何|什么原因|怎么回事|how come|why (?:is|are|does|did|do|can't|cannot))[^。.!?\n]{0,48}(?:失败|错误|报错|异常|崩(?:溃|了)|挂了|不(?:工作|生效|行|起作用)|bug|broken|fail(?:s|ed|ure)?)/i;
const NEGATED_WRITE_PATTERN =
	/\b(?:do not|don't|must not|never|without)\b.{0,32}\b(?:implement(?:ing)?|modify(?:ing)?|edit(?:ing)?|writ(?:e|ing)|chang(?:e|ing)|delet(?:e|ing)|remov(?:e|ing))\b|(?:不得|不要|禁止|不准|无需|请勿)\s*(?:再)?\s*(?:修改|编辑|写入|改动|改变|改|删除|移除|动)(?:任何)?(?:代码|文件|内容)?|只读/gi;

const MIN_ADAPTATION_CONFIDENCE = 0.5;
const BASE_POLICY: Record<ExecutionLane, ExecutionPolicy> = {
	direct: {
		lane: "direct",
		goalLevel: "implicit",
		autoSubagents: "off",
		verification: "none",
		toolSurface: "minimal",
		permissions: "write",
		toolBudget: 6,
		maxToolCalls: 12,
		reasoningEffort: Effort.Low,
		maxRepeatedToolCalls: 2,
		maxConsecutiveToolFailures: 2,
		budget: {
			maxTurns: 12,
			deadlineMs: 5 * 60_000,
			subagentMaxParallel: 0,
			subagentMaxDepth: 0,
			subagentMaxTurns: 0,
			subagentTotalTokens: 0,
			subagentMaxTokens: 0,
		},
		maxTotalTokens: 120_000,
	},
	guided: {
		lane: "guided",
		goalLevel: "checklist",
		autoSubagents: "off",
		verification: "targeted",
		toolSurface: "standard",
		permissions: "write",
		toolBudget: 10,
		maxToolCalls: 20,
		reasoningEffort: Effort.Medium,
		maxRepeatedToolCalls: 2,
		maxConsecutiveToolFailures: 2,
		budget: {
			maxTurns: 30,
			deadlineMs: 15 * 60_000,
			subagentMaxParallel: 0,
			subagentMaxDepth: 0,
			subagentMaxTurns: 0,
			subagentTotalTokens: 0,
			subagentMaxTokens: 0,
		},
		maxTotalTokens: 300_000,
	},
	orchestrated: {
		lane: "orchestrated",
		goalLevel: "dag",
		autoSubagents: "read-only",
		verification: "strict",
		toolSurface: "full",
		permissions: "write",
		toolBudget: 16,
		maxToolCalls: 32,
		reasoningEffort: Effort.High,
		maxRepeatedToolCalls: 2,
		maxConsecutiveToolFailures: 3,
		budget: {
			maxTurns: 60,
			deadlineMs: 30 * 60_000,
			subagentMaxParallel: 3,
			subagentMaxDepth: 1,
			subagentMaxTurns: 15,
			subagentTotalTokens: 60_000,
			subagentMaxTokens: 30_000,
		},
		maxTotalTokens: 600_000,
	},
};

/** Cheap task analysis used on the zero-extra-model-call routing path. */
export function inferTaskFeatures(task: string, hints: TaskFeatureHints = {}): TaskFeatures {
	const numberedSteps = task.match(/(?:^|\n)\s*(?:\d+[.)]|[-*])\s+/g)?.length ?? 0;
	const mentionedPaths = new Set(task.match(PATH_PATTERN) ?? []);
	const multiStep = MULTI_STEP_PATTERN.test(task);
	const multiFile = MULTI_FILE_PATTERN.test(task);
	const negationStripped = task.replace(NEGATED_WRITE_PATTERN, "");
	const writeRequest = WRITE_REQUEST_PATTERN.test(negationStripped);
	const verificationRequest = EXECUTABLE_VERIFICATION_PATTERN.test(negationStripped);
	const executableRequest = writeRequest || verificationRequest;
	const parallelIntent = PARALLEL_PATTERN.test(task.replace(NEGATED_PARALLEL_PATTERN, ""));
	const estimatedSteps =
		hints.estimatedSteps ?? Math.max(1, numberedSteps || (multiStep || task.length > 600 ? 3 : 1));
	const estimatedFiles = hints.estimatedFiles ?? Math.max(1, mentionedPaths.size, multiFile ? 2 : 1);
	// Read-only is a permission decision, not a difficulty signal: strong markers
	// (explicit read-only phrasing, negated writes) or the absence of any mutation
	// verb make the task read-only. A question about a symptom (why does delete
	// fail?) is analysis even though it names a destructive verb, unless the user
	// also asks for the repair.
	const readOnly =
		hints.readOnly ??
		(hints.writesWorkspace === true
			? false
			: EXPLICIT_READ_ONLY_PATTERN.test(task) ||
				!executableRequest ||
				(QUESTION_TROUBLE_PATTERN.test(task) && !writeRequest && !verificationRequest));
	return {
		estimatedSteps,
		estimatedFiles,
		independentBranches: hints.independentBranches ?? (parallelIntent ? 2 : 1),
		contextTokens: hints.contextTokens ?? 0,
		writesWorkspace: hints.writesWorkspace ?? (writeRequest && !readOnly),
		readOnly,
		destructiveRisk:
			hints.destructiveRisk ?? (writeRequest && !readOnly && DESTRUCTIVE_PATTERN.test(task) ? 0.75 : 0.1),
		requiresVerification: hints.requiresVerification ?? verificationRequest,
		requiresGoalDag: hints.requiresGoalDag ?? false,
		userRequestedPlan: hints.userRequestedPlan ?? PLAN_PATTERN.test(task),
		userRequestedParallel: hints.userRequestedParallel ?? parallelIntent,
	};
}

/** Stable coarse slice for sparse per-task capability learning. */
export function inferTaskSlice(task: string, features: TaskFeatures): TaskSlice {
	if (GUI_PATTERN.test(task)) return "gui";
	if (DOCUMENT_PATTERN.test(task)) return "document";
	if (DEBUG_PATTERN.test(task)) return "debugging";
	if (RESEARCH_PATTERN.test(task) && !features.writesWorkspace) return "research";
	if (
		features.requiresGoalDag ||
		features.estimatedSteps > 4 ||
		features.estimatedFiles > 3 ||
		features.contextTokens > 24_000
	) {
		return "long-horizon";
	}
	if (features.writesWorkspace || features.estimatedFiles > 1) return "coding";
	return "general";
}

function closestSupportedEffort(model: ModelVariant | undefined, desired: Effort): Effort {
	if (!model || model.efforts.includes(desired)) return desired;
	const desiredIndex = THINKING_EFFORTS.indexOf(desired);
	let closest = model.efforts[0];
	if (!closest) return desired;
	let distance = Math.abs(THINKING_EFFORTS.indexOf(closest) - desiredIndex);
	for (const effort of model.efforts.slice(1)) {
		const candidateDistance = Math.abs(THINKING_EFFORTS.indexOf(effort) - desiredIndex);
		if (candidateDistance < distance) {
			closest = effort;
			distance = candidateDistance;
		}
	}
	return closest;
}

export function routeTask(
	features: TaskFeatures,
	profile: ModelCapabilityProfile,
	overlay: AdaptivePolicyPatch = {},
	appliedOverlays: string[] = [],
	model?: ModelVariant,
	overrides: RouteOverrides = {},
): RouteDecision {
	const reasons: string[] = [];
	let lane: ExecutionLane;
	if (overrides.lane) {
		lane = overrides.lane;
		reasons.push(`explicit lane override: ${overrides.lane}`);
	} else if (features.userRequestedParallel || features.independentBranches >= 2 || features.requiresGoalDag) {
		lane = "orchestrated";
		reasons.push(
			features.requiresGoalDag
				? "task supplies a dependency goal graph"
				: features.userRequestedParallel
					? "user requested parallel work"
					: "task has independent branches",
		);
	} else if (
		features.userRequestedPlan ||
		features.estimatedSteps > 2 ||
		features.estimatedFiles > 1 ||
		features.destructiveRisk >= 0.5 ||
		features.contextTokens > 24_000
	) {
		lane = "guided";
		reasons.push("task needs explicit progress state");
	} else {
		lane = "direct";
		reasons.push("localized task qualifies for the zero-overhead path");
	}

	const base = structuredClone(BASE_POLICY[lane]);
	const configuredEffort = model ? THINKING_EFFORTS.find(effort => effort === model.reasoningConfig) : undefined;
	const thinkingOff = model?.reasoningConfig === "off";
	if (configuredEffort) base.reasoningEffort = closestSupportedEffort(model, configuredEffort);
	if (profile.toolSchemaReliability < 0.5) {
		base.maxRepeatedToolCalls = Math.max(base.maxRepeatedToolCalls, 3);
		base.maxConsecutiveToolFailures = Math.max(base.maxConsecutiveToolFailures, 4);
		reasons.push("extra schema-recovery attempts compensate for unreliable tool calls");
	}
	if (profile.planningHorizon < 0.5) {
		if (lane !== "direct") base.goalLevel = "checklist";
		base.budget.maxTurns += lane === "direct" ? 4 : 8;
		base.toolBudget += lane === "direct" ? 2 : 4;
		reasons.push("explicit checkpoints and extra turns compensate for limited planning horizon");
	}
	const hasParallelEvidence = (profile.confidence.parallelToolReliability ?? 0) >= MIN_ADAPTATION_CONFIDENCE;
	if (
		!features.userRequestedParallel &&
		hasParallelEvidence &&
		profile.parallelToolReliability < 0.55 &&
		base.autoSubagents !== "off"
	) {
		base.autoSubagents = "off";
		base.budget.subagentMaxParallel = 0;
		base.budget.subagentTotalTokens = 0;
		reasons.push("serial execution compensates for reliably observed low parallel reliability");
	}
	if (profile.latencyClass < 0.4 || profile.costClass < 0.4) {
		reasons.push("observed efficiency retained for reporting without limiting task completion");
	}
	if (profile.toolSchemaReliability >= 0.8 && profile.planningHorizon >= 0.75 && lane === "guided") {
		base.toolSurface = "full";
		reasons.push("full tool surface enabled for a reliable long-horizon model");
	}
	if (features.writesWorkspace && base.verification === "none") {
		base.verification = "targeted";
		reasons.push("workspace writes require external verification");
	}
	if (features.readOnly) {
		base.permissions = "read-only";
		reasons.push("read-only task: mutation tools are withheld by the host");
	}
	if (profile.verificationReliability < 0.6 && features.writesWorkspace) {
		base.verification = lane === "orchestrated" ? "strict" : "targeted";
		reasons.push("external verification required for low verification reliability");
	} else if (features.requiresVerification && base.verification === "none") {
		base.verification = "targeted";
	}
	const quotaBacked = model?.servicePlan === "coding-plan" || model?.servicePlan === "token-plan";
	if (quotaBacked && profile.toolSchemaReliability >= 0.5) {
		base.toolBudget += lane === "direct" ? 2 : 4;
		base.maxConsecutiveToolFailures = Math.max(base.maxConsecutiveToolFailures, 3);
		reasons.push("quota-backed plan preserves completion headroom while batching model turns");
	}
	if (!configuredEffort && !thinkingOff && features.destructiveRisk >= 0.7) base.reasoningEffort = Effort.High;

	const policy: ExecutionPolicy = {
		...base,
		...overlay,
		lane,
		budget: { ...base.budget, ...overlay.budget },
	};
	policy.maxToolCalls = Math.max(policy.toolBudget, policy.maxToolCalls);
	policy.maxTotalTokens = Math.max(1, policy.maxTotalTokens);
	if (features.userRequestedParallel) {
		policy.autoSubagents = policy.autoSubagents === "off" ? "read-only" : policy.autoSubagents;
		policy.budget.subagentMaxParallel = Math.max(2, policy.budget.subagentMaxParallel);
		policy.budget.subagentMaxDepth = Math.max(1, policy.budget.subagentMaxDepth);
		policy.budget.subagentMaxTurns = Math.max(8, policy.budget.subagentMaxTurns);
		policy.budget.subagentMaxTokens = Math.max(8_000, policy.budget.subagentMaxTokens);
		policy.budget.subagentTotalTokens = Math.max(16_000, policy.budget.subagentTotalTokens);
	}
	if (features.requiresGoalDag && policy.goalLevel !== "dag") {
		policy.goalLevel = "dag";
		reasons.push("overlay cannot disable DAG state for dependency goals");
	}
	if ((features.writesWorkspace || features.requiresVerification) && policy.verification === "none") {
		policy.verification = "targeted";
		reasons.push("overlay cannot disable task-required verification");
	}
	if (features.readOnly && policy.permissions === "write") {
		policy.permissions = "read-only";
		reasons.push("overlay cannot grant mutation for a read-only task");
	}
	// Explicit human overrides land last: the user's own flags outrank both
	// keyword inference and learned overlays. Allowing a user to downgrade
	// verification or re-enable mutation is a deliberate, visible choice.
	if (overrides.verification && policy.verification !== overrides.verification) {
		policy.verification = overrides.verification;
		reasons.push(`explicit verification override: ${overrides.verification}`);
	}
	if (overrides.permissions && policy.permissions !== overrides.permissions) {
		policy.permissions = overrides.permissions;
		reasons.push(`explicit permission override: ${overrides.permissions}`);
	}
	if (
		!configuredEffort &&
		!thinkingOff &&
		features.destructiveRisk >= 0.7 &&
		THINKING_EFFORTS.indexOf(policy.reasoningEffort) < THINKING_EFFORTS.indexOf(Effort.High)
	) {
		policy.reasoningEffort = Effort.High;
		reasons.push("overlay cannot reduce reasoning below the destructive-task floor");
	}
	if (thinkingOff) {
		policy.disableReasoning = true;
		reasons.push("explicit thinking-off mode preserved");
	} else {
		delete policy.disableReasoning;
		policy.reasoningEffort = configuredEffort
			? closestSupportedEffort(model, configuredEffort)
			: closestSupportedEffort(model, policy.reasoningEffort);
		if (configuredEffort) reasons.push("explicit reasoning effort preserved");
	}
	return {
		policy,
		reasons,
		appliedOverlays: [...appliedOverlays],
	};
}
