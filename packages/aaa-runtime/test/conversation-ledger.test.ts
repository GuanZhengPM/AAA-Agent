import { describe, expect, test } from "bun:test";
import { extractLedgerEntries, mergeLedger, pendingDeliverables } from "../src/conversation-ledger";

describe("extractLedgerEntries", () => {
	test("T5 r3 corrections", () => {
		const msg =
			"第 3 轮，两处修正，别的都不动：1) 上一轮我说的 COUPON25 抵扣上限不对，应该是 **2500 分**，不是 3000，请改过来。2) 退款准入阈值 `REFUND_THRESHOLD_CENTS` 从 10000 下调到 **7500**。";
		const es = extractLedgerEntries(msg, 3);
		console.log(JSON.stringify(es, null, 1));
		const corr = es.filter(e => e.kind === "correction");
		expect(corr.length).toBeGreaterThanOrEqual(1);
		const refund = corr.find(e => e.subject.includes("REFUND_THRESHOLD_CENTS"));
		expect(refund?.oldValue).toBe("10000");
		expect(refund?.newValue).toBe("7500");
	});

	test("T5 r2 invariant", () => {
		const msg =
			"我特别强调一点希望全程保持的约定：**税率常量 TAX_RATE_BPS 保持 1300 不变**，后面无论怎么折腾优惠券、运费都不要动税率。";
		const es = extractLedgerEntries(msg, 2);
		const inv = es.find(e => e.kind === "invariant");
		console.log(JSON.stringify(es));
		expect(inv?.subject).toBe("TAX_RATE_BPS");
		expect(inv?.newValue).toBe("1300");
	});

	test("r9 deliverable", () => {
		const msg = "第 9 轮审计：建 `AUDIT.md`，专记『后来被推翻过的约定』。";
		const es = extractLedgerEntries(msg, 9);
		expect(es.some(e => e.kind === "deliverable" && e.subject === "AUDIT.md")).toBe(true);
		const missing = pendingDeliverables(es, p => p === "CHANGELOG.md");
		expect(missing.map(m => m.subject)).toEqual(["AUDIT.md"]);
	});
});

test("mergeLedger newest wins", () => {
	const a = [{ kind: "correction" as const, subject: "CAP", oldValue: "3000", newValue: "2500", turn: 3 }];
	const b = [{ kind: "correction" as const, subject: "CAP", oldValue: "2500", newValue: "2000", turn: 5 }];
	const m = mergeLedger(a, b);
	expect(m[0].newValue).toBe("2000");
});
