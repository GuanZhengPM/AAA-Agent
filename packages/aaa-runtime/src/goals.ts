import { extractLedgerEntries } from "./conversation-ledger";
import type {
	AdaptiveGoalNode,
	EvidenceRef,
	GoalCompletionReport,
	GoalLevel,
	GoalNodeStatus,
	GoalSuccessCriterion,
} from "./types";

export const DEFAULT_RESULT_CRITERION_ID = "result";
export const DEFAULT_VERIFICATION_CRITERION_ID = "verification";
const DELIVERABLE_CRITERION_PREFIX = "deliverable:";

function normalizeDeliverablePath(value: string): string {
	return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function deliverableCriterionId(path: string): string {
	return `${DELIVERABLE_CRITERION_PREFIX}${encodeURIComponent(normalizeDeliverablePath(path))}`;
}

export function deliverablePathFromCriterionId(id: string): string | undefined {
	if (!id.startsWith(DELIVERABLE_CRITERION_PREFIX)) return undefined;
	try {
		return normalizeDeliverablePath(decodeURIComponent(id.slice(DELIVERABLE_CRITERION_PREFIX.length)));
	} catch {
		return undefined;
	}
}

function requestsExecutableVerification(objective: string): boolean {
	return [
		/\b(?:run|execute)\s+(?:the\s+)?(?:tests?|checks?|lint|typecheck|build|smoke(?:\s+tests?)?)\b/i,
		/\b(?:tests?|checks?|lint|typecheck|build)\s+(?:must|should|need(?:s)?\s+to)\s+pass\b/i,
		/(?:运行|执行)[^。；;\n]{0,12}(?:测试|检查|校验|构建)/,
		/确保[^。；;\n]{0,16}(?:测试|检查|校验|构建)[^。；;\n]{0,8}通过/,
	].some(pattern => pattern.test(objective));
}

/** Derives only obligations that can be checked deterministically by the host. */
export function deriveDefaultGoalCriteria(objective: string): GoalSuccessCriterion[] {
	const criteria: GoalSuccessCriterion[] = [
		{
			id: DEFAULT_RESULT_CRITERION_ID,
			description: "Requested outcome is delivered",
			required: true,
			evidence: [],
		},
	];
	for (const entry of extractLedgerEntries(objective).filter(entry => entry.kind === "deliverable")) {
		criteria.push({
			id: deliverableCriterionId(entry.subject),
			description: `Requested deliverable exists: ${entry.subject}`,
			required: true,
			evidence: [],
		});
	}
	if (requestsExecutableVerification(objective)) {
		criteria.push({
			id: DEFAULT_VERIFICATION_CRITERION_ID,
			description: "Explicitly requested verification passes",
			required: true,
			evidence: [],
		});
	}
	return criteria;
}

/** Stateful objective/checklist/DAG store. Full state stays outside model context. */
export class AdaptiveGoalStore {
	readonly level: GoalLevel;
	#nodes = new Map<string, AdaptiveGoalNode>();

	constructor(level: GoalLevel, objective: string, nodes: AdaptiveGoalNode[] = []) {
		this.level = level;
		if (nodes.length === 0) {
			this.#nodes.set("root", {
				id: "root",
				objective,
				status: "active",
				dependencies: [],
				owner: "primary",
				criteria: deriveDefaultGoalCriteria(objective),
			});
			return;
		}
		for (const node of nodes) {
			if (this.level !== "dag" && node.dependencies.length > 0) {
				throw new Error(`${this.level} goals cannot declare dependencies`);
			}
			if (this.#nodes.has(node.id)) throw new Error(`Duplicate goal id: ${node.id}`);
			if (node.dependencies.includes(node.id)) throw new Error(`Goal ${node.id} cannot depend on itself`);
			this.#nodes.set(node.id, structuredClone(node));
		}
		this.#validateDependencies();
	}

	add(node: AdaptiveGoalNode): void {
		if (this.level !== "dag" && node.dependencies.length > 0) {
			throw new Error(`${this.level} goals cannot declare dependencies`);
		}
		if (this.#nodes.has(node.id)) throw new Error(`Duplicate goal id: ${node.id}`);
		if (node.dependencies.includes(node.id)) throw new Error(`Goal ${node.id} cannot depend on itself`);
		this.#nodes.set(node.id, structuredClone(node));
		try {
			this.#validateDependencies();
		} catch (error) {
			this.#nodes.delete(node.id);
			throw error;
		}
	}

	setStatus(id: string, status: GoalNodeStatus, blocker?: string): void {
		const node = this.#nodes.get(id);
		if (!node) throw new Error(`Unknown goal: ${id}`);
		if ((status === "active" || status === "done") && !this.#dependenciesDone(node)) {
			throw new Error(`Goal ${id} cannot become ${status} before its dependencies complete`);
		}
		node.status = status;
		node.blocker = status === "blocked" ? blocker || "Blocked" : undefined;
	}

	attachEvidence(goalId: string, criterionId: string, evidence: EvidenceRef): void {
		const node = this.#nodes.get(goalId);
		if (!node) throw new Error(`Unknown goal: ${goalId}`);
		const criterion = node.criteria.find(candidate => candidate.id === criterionId);
		if (!criterion) throw new Error(`Unknown criterion ${criterionId} for goal ${goalId}`);
		criterion.evidence.push(structuredClone(evidence));
	}

	frontier(): AdaptiveGoalNode[] {
		return [...this.#nodes.values()]
			.filter(node => this.#dependenciesDone(node) && (node.status === "active" || node.status === "pending"))
			.map(node => structuredClone(node));
	}

	snapshot(): AdaptiveGoalNode[] {
		return [...this.#nodes.values()].map(node => structuredClone(node));
	}

	completionReport(): GoalCompletionReport {
		const openGoals: string[] = [];
		const missingCriteria: string[] = [];
		for (const node of this.#nodes.values()) {
			if (node.status !== "done" && node.status !== "dropped") openGoals.push(node.id);
			if (node.status === "dropped") continue;
			for (const criterion of node.criteria) {
				if (criterion.required && criterion.evidence.length === 0) {
					missingCriteria.push(`${node.id}:${criterion.id}`);
				}
			}
		}
		return { complete: openGoals.length === 0 && missingCriteria.length === 0, openGoals, missingCriteria };
	}

	#dependenciesDone(node: AdaptiveGoalNode): boolean {
		return node.dependencies.every(dependency => this.#nodes.get(dependency)?.status === "done");
	}

	#validateDependencies(): void {
		for (const node of this.#nodes.values()) {
			for (const dependency of node.dependencies) {
				if (!this.#nodes.has(dependency)) throw new Error(`Goal ${node.id} depends on unknown goal ${dependency}`);
			}
		}
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (id: string): void => {
			if (visiting.has(id)) throw new Error(`Goal dependency cycle includes ${id}`);
			if (visited.has(id)) return;
			visiting.add(id);
			for (const dependency of this.#nodes.get(id)?.dependencies ?? []) visit(dependency);
			visiting.delete(id);
			visited.add(id);
		};
		for (const id of this.#nodes.keys()) visit(id);
	}
}
