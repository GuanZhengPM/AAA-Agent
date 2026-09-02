/**
 * 验收证据绑定。
 *
 * 背景：一条"通过"的检查命令本身并不能证明任务完成——它只证明那条命令退出码为 0。
 * 如果 Agent 改动了 A，却运行了一个与 A 无关的测试，宿主此前会把它当作确定性证据
 * 直接短路通过验收。这个模块回答一个更严格的问题：
 *
 *   这条命令，是否真的覆盖了本次被改动的东西？
 *
 * 判定是保守的：无法建立关联时返回 false，把决定权交回独立 verifier，
 * 而不是替 Agent 背书。
 */

/** 命令中"看起来像路径"的 token 必须含分隔符或扩展名，否则视为命令词。 */
const PATH_TOKEN_PATTERN = /[\w@./\\-]+/g;
/** 纯命令词，永远不当作路径目标。 */
const NON_TARGET_TOKENS = new Set([
	"bun",
	"npm",
	"pnpm",
	"yarn",
	"npx",
	"node",
	"deno",
	"pytest",
	"python",
	"python3",
	"poetry",
	"cargo",
	"go",
	"mvn",
	"gradle",
	"make",
	"just",
	"run",
	"test",
	"tests",
	"check",
	"lint",
	"build",
	"verify",
	"ci",
]);

function normalizePathSeparators(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function basename(value: string): string {
	const normalized = normalizePathSeparators(value);
	const segments = normalized.split("/").filter(Boolean);
	return segments.at(-1) ?? normalized;
}

/** `billing.test.ts` → `billing.test` 与 `billing`，便于跨扩展名匹配。 */
function stemCandidates(value: string): Set<string> {
	const base = basename(value);
	const lastDot = base.lastIndexOf(".");
	const full = lastDot > 0 ? base.slice(0, lastDot) : base;
	const stems = new Set<string>([base, full]);
	const firstDot = full.indexOf(".");
	if (firstDot > 0) stems.add(full.slice(0, firstDot));
	for (const stem of [...stems]) {
		const withoutTestPrefix = stem.replace(/^(?:test|spec)[_-]/i, "");
		const withoutTestSuffix = stem.replace(/[_-](?:test|spec)$/i, "");
		if (withoutTestPrefix !== stem) stems.add(withoutTestPrefix);
		if (withoutTestSuffix !== stem) stems.add(withoutTestSuffix);
	}
	return stems;
}

function looksLikePath(token: string): boolean {
	return token.includes("/") || token.includes(".");
}

function normalizeCommand(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function taskNamesCommand(task: string | undefined, command: string): boolean {
	if (!task) return false;
	const normalizedCommand = normalizeCommand(command);
	if (!normalizedCommand) return false;
	return normalizeCommand(task).includes(normalizedCommand);
}

/**
 * 提取命令里指向的具体文件或目录。空数组仅代表命令没有显式目标；
 * 不能据此推断它覆盖了当前需求。
 */
export function extractCommandTargets(command: string): string[] {
	const targets: string[] = [];
	for (const match of command.match(PATH_TOKEN_PATTERN) ?? []) {
		const token = match.replace(/^['"]+|['"]+$/g, "");
		if (!token) continue;
		if (!looksLikePath(token)) continue;
		if (NON_TARGET_TOKENS.has(token.toLowerCase())) continue;
		targets.push(normalizePathSeparators(token));
	}
	return targets;
}

function directoryOf(value: string): string {
	const normalized = normalizePathSeparators(value);
	const index = normalized.lastIndexOf("/");
	return index > 0 ? normalized.slice(0, index) : "";
}

/**
 * 判断一条检查命令是否覆盖了本次改动。
 *
 * - 用户在任务里点名的完整检查命令，或点名命令指向的目标，视为相关：
 *   那是使用者自己声明的验收方式，不是 Agent 自选的证据；
 * - 指向具体文件时，必须与某个被改动文件同名（忽略扩展名与目录）或同目录；
 * - 裸 `bun test` / `npm run check` 只证明现有测试或静态检查通过，不能证明
 *   用户要求的行为已经实现，因此默认交给独立 verifier；
 * - 其余情况一律视为未覆盖。
 */
export function isAcceptanceBound(command: string, changedFiles: readonly string[], task?: string): boolean {
	if (changedFiles.length === 0) return false;
	if (taskNamesCommand(task, command)) return true;
	const targets = extractCommandTargets(command);
	if (targets.length === 0) return false;
	if (task) {
		const haystack = task.toLowerCase();
		for (const target of targets) {
			for (const stem of stemCandidates(target)) {
				if (stem.length > 2 && haystack.includes(stem.toLowerCase())) return true;
			}
		}
	}

	const changedStems = new Set<string>();
	const changedDirectories = new Set<string>();
	for (const file of changedFiles) {
		for (const stem of stemCandidates(file)) changedStems.add(stem.toLowerCase());
		const directory = directoryOf(file);
		if (directory) changedDirectories.add(directory.toLowerCase());
	}

	for (const target of targets) {
		if (changedDirectories.has(target.toLowerCase())) return true;
		for (const stem of stemCandidates(target)) {
			const candidate = stem.toLowerCase();
			if (!candidate) continue;
			if (changedStems.has(candidate)) return true;
			// 允许 `billing` 覆盖 `billing.test.ts`，反之亦然。
			for (const changed of changedStems) {
				if (changed.startsWith(`${candidate}.`) || candidate.startsWith(`${changed}.`)) return true;
			}
		}
		const targetDirectory = directoryOf(target);
		if (targetDirectory && changedDirectories.has(targetDirectory.toLowerCase())) return true;
	}
	return false;
}

/** 给验收报告用的可解释说明。 */
export function describeAcceptanceBinding(command: string, changedFiles: readonly string[], task?: string): string {
	if (isAcceptanceBound(command, changedFiles, task)) {
		return `host bound \`${command}\` to changed file(s): ${changedFiles.join(", ")}`;
	}
	return (
		`host could not bind \`${command}\` to the changed file(s) ` +
		`(${changedFiles.join(", ") || "none recorded"}); independent verification required`
	);
}
