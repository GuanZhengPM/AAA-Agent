import * as path from "node:path";

interface PackageRule {
	allowed: ReadonlySet<string>;
	entrypoints?: ReadonlySet<string>;
}

const packagesRoot = path.resolve(import.meta.dir, "../..");
const rules: Readonly<Record<string, PackageRule>> = {
	"aaa-runtime": { allowed: new Set() },
	"aaa-providers": { allowed: new Set(["@aaa-agent/runtime"]) },
	"aaa-workspace": { allowed: new Set(["@aaa-agent/runtime"]) },
	"aaa-app": {
		allowed: new Set(["@aaa-agent/runtime", "@aaa-agent/providers", "@aaa-agent/workspace"]),
	},
	"aaa-agent": {
		allowed: new Set(["@aaa-agent/runtime", "@aaa-agent/providers", "@aaa-agent/workspace", "@aaa-agent/app"]),
		entrypoints: new Set(["index.ts", "cli.ts"]),
	},
};
const importPattern = /(?:from\s+|import\s*)["'](@aaa-agent\/[a-z-]+)(?:\/[^"']*)?["']/g;
const failures: string[] = [];

for (const [packageDirectory, rule] of Object.entries(rules)) {
	const sourceRoot = path.join(packagesRoot, packageDirectory, "src");
	for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, absolute: true, onlyFiles: true })) {
		const relativeFile = path.relative(packagesRoot, file);
		if (rule.entrypoints && !rule.entrypoints.has(path.basename(file))) {
			failures.push(`${relativeFile}: compatibility package contains a non-entrypoint source file`);
		}
		const source = await Bun.file(file).text();
		if (
			packageDirectory === "aaa-providers" &&
			/(?:@oh-my-pi|@mariozechner\/pi-|https?:\/\/[^\s"']*\bpi(?:\.|\/))/i.test(source)
		) {
			failures.push(`${relativeFile}: provider/auth code must not depend on or redirect through pi`);
		}
		for (const match of source.matchAll(importPattern)) {
			const dependency = match[1];
			if (dependency && !rule.allowed.has(dependency)) {
				failures.push(`${relativeFile}: ${dependency} violates the package dependency direction`);
			}
		}
	}
}

if (failures.length > 0) throw new Error(`AAA package boundary check failed:\n${failures.join("\n")}`);
process.stdout.write("AAA package boundaries valid.\n");
