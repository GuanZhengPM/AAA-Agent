import { describe, expect, it } from "bun:test";
import { extractCommandTargets, isAcceptanceBound } from "../src/acceptance-binding";

describe("acceptance evidence binding", () => {
	it("does not treat generic project checks as proof of task completion", () => {
		expect(isAcceptanceBound("bun test", ["src/billing.ts"], "Fix the billing calculation")).toBe(false);
		expect(isAcceptanceBound("bun run check", ["src/billing.ts"], "Fix the billing calculation")).toBe(false);
	});

	it("accepts a project check only when the user explicitly requires that command", () => {
		expect(isAcceptanceBound("bun run check", ["src/billing.ts"], "Fix billing, then run bun run check")).toBe(true);
	});

	it("binds targeted tests to the changed file stem", () => {
		expect(isAcceptanceBound("bun test test/billing.test.ts", ["src/billing.ts"], "Fix billing")).toBe(true);
		expect(isAcceptanceBound("bun test test/profile.test.ts", ["src/billing.ts"], "Fix billing")).toBe(false);
	});

	it("does not trust a broad test directory without a file or user requirement", () => {
		expect(isAcceptanceBound("bun test test", ["src/billing.ts"], "Fix billing")).toBe(false);
	});

	it("extracts only path-like command targets", () => {
		expect(extractCommandTargets("bun test ./test/billing.test.ts --watch")).toEqual(["test/billing.test.ts"]);
	});
});
