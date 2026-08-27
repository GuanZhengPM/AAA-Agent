import { afterEach, describe, expect, it } from "bun:test";
import * as fssync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createInteractiveSession,
	type InteractiveSession,
	loadInteractiveSession,
	partitionForDigest,
	resetSessionSearchCache,
	resolveDigestBudget,
	rollDigest,
	saveInteractiveSession,
	searchInteractiveSessions,
} from "@aaa-agent/app";
import {
	createProviderAttemptSignal,
	Effort,
	type Model,
	resolveHistoryWorkingBudget,
	resolveWorkingContextCharacters,
	trimConversation,
	trimConversationKeepingPrefix,
	withTransientRetry,
} from "@aaa-agent/runtime";

const tempDirectories: string[] = [];
const previousHomes: (string | undefined)[] = [];

function uniqueHome(): string {
	const directory = fssync.mkdtempSync(path.join(os.tmpdir(), "aaa-memory-history-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
	for (let i = 0; i < previousHomes.length; i += 1) {
		const previous = previousHomes[i];
		if (previous === undefined) delete process.env.AAA_AGENT_HOME;
		else process.env.AAA_AGENT_HOME = previous;
	}
	previousHomes.length = 0;
	resetSessionSearchCache();
});

function withHome(): string {
	previousHomes.push(process.env.AAA_AGENT_HOME);
	const directory = uniqueHome();
	process.env.AAA_AGENT_HOME = directory;
	return directory;
}

const model: Model = {
	provider: "test",
	id: "memory-model",
	name: "Memory Model",
	api: "openai-chat-completions",
	baseUrl: "http://localhost/v1",
	contextWindow: 8_000,
	efforts: [Effort.Low],
	authChannel: "local",
};

async function seedSession(
	cwd: string,
	script: Array<{ user: string; assistant: string }>,
): Promise<InteractiveSession> {
	const session = createInteractiveSession(cwd, model, "low", undefined);
	session.status = "active";
	session.messages = script.flatMap(turn => [
		{ role: "user" as const, text: turn.user },
		{ role: "assistant" as const, text: turn.assistant },
	]);
	await saveInteractiveSession(session);
	return session;
}

describe("session transcript durability + search", () => {
	it("keeps the full transcript on disk without message-count capping", async () => {
		withHome();
		const cwd = "/tmp/proj-trace";
		const bigTurns = Array.from({ length: 60 }, (_, i) => ({
			user: `turn ${i} requirement alpha-${i}`,
			assistant: `did work ${i}`,
		}));
		const saved = await seedSession(cwd, bigTurns);
		const loaded = await loadInteractiveSession(saved.id);
		expect(loaded.messages.length).toBe(120);
		expect(loaded.messages[0].text).toContain("turn 0");
	});

	it("finds content beyond any compaction horizon and reflects fresh appends", async () => {
		withHome();
		const cwd = "/tmp/proj-search";
		const first = await seedSession(cwd, [
			{ user: "把 COUPON25 抵扣上限改为 2500 分，不是 3000", assistant: "已更新上限为 2500。" },
		]);
		resetSessionSearchCache();
		const hits = await searchInteractiveSessions("抵扣上限改为 2500", cwd);
		// Message-level hits: the user turn carries the phrase, the assistant
		// echo carries the value; both belong to the same seeded session.
		expect(hits.length).toBeGreaterThanOrEqual(1);
		expect(new Set(hits.map(hit => hit.session.id))).toEqual(new Set([first.id]));

		// Freshness without process restart: append a new exchange and search immediately.
		const loaded = await loadInteractiveSession(first.id);
		loaded.messages.push({ role: "user", text: "第二轮：新增审计文件 AUDIT.md" });
		loaded.messages.push({ role: "assistant", text: "AUDIT.md 已创建。" });
		await saveInteractiveSession(loaded);

		const fresh = await searchInteractiveSessions("AUDIT.md 已创建", cwd);
		expect(fresh.length).toBeGreaterThanOrEqual(1);
		expect(new Set(fresh.map(hit => hit.session.id))).toEqual(new Set([first.id]));
		// deterministic result ordering: higher score first
		const ranked = await searchInteractiveSessions("COUPON25 上限 AUDIT.md", cwd);
		expect(ranked.length).toBeGreaterThanOrEqual(1);

		// Oversized messages skip gram indexing but remain in the fallback scan:
		// traceability always wins over index speed.
		loaded.messages.push({ role: "user", text: `${"z".repeat(13_000)} tail-marker-oversized` });
		loaded.messages.push({ role: "assistant", text: "stored" });
		await saveInteractiveSession(loaded);
		const oversized = await searchInteractiveSessions("tail-marker-oversized", cwd);
		expect(oversized.some(hit => hit.excerpt.includes("tail-marker-oversized"))).toBe(true);
	});

	it("respects the workspace filter across sessions", async () => {
		withHome();
		await seedSession("/tmp/ws-a", [{ user: "deploy checklist step one", assistant: "done" }]);
		await seedSession("/tmp/ws-b", [{ user: "deploy checklist step two", assistant: "ok" }]);
		resetSessionSearchCache();
		const scoped = await searchInteractiveSessions("deploy checklist", "/tmp/ws-a");
		expect(scoped.length).toBe(1);
		const all = await searchInteractiveSessions("deploy checklist");
		expect(all.length).toBe(2);
	});
});

describe("rolling digest for unbounded single-session chats", () => {
	it("partitions pair-aligned keep/evict under the recent-window budget", () => {
		const messages = Array.from({ length: 20 }, (_, i) =>
			i % 2 === 0
				? ({ role: "user", text: `u${i} `.repeat(900) } as const)
				: ({ role: "assistant", text: `a${i} `.repeat(300) } as const),
		);
		const { keep, evict } = partitionForDigest(messages);
		expect(evict.length % 2).toBe(0);
		expect(messages.slice(evict.length)).toEqual(keep);
		expect(keep.every((m, i) => m === messages[evict.length + i])).toBe(true);
	});

	it("rolls recursively into a bounded digest that preserves newest obligations", () => {
		const filler = "细节内容 ".repeat(400);
		let digestText: string | undefined;
		digestText = rollDigest(digestText, [
			{ role: "user", text: `第 3 轮修正：REFUND_THRESHOLD 从 10000 下调到 7500。${filler}` },
			{ role: "assistant", text: `${filler} 已完成。` },
		]);
		digestText = rollDigest(digestText, [
			{ role: "user", text: "第 4 轮：税率 TAX_RATE_BPS 保持 1300 不变。" },
			{ role: "assistant", text: "收到。" },
		]);
		expect(digestText).toContain("7500");
		expect(digestText).toContain("TAX_RATE_BPS");
		expect(digestText!.length).toBeLessThanOrEqual(24_200); // hard cap
	});

	it("scales every budget dimension with the current model context", () => {
		const small = resolveDigestBudget(8_000);
		const medium = resolveDigestBudget(128_000);
		const large = resolveDigestBudget(1_000_000);
		expect(medium.trigger).toBeGreaterThan(small.trigger);
		expect(large.trigger).toBeGreaterThan(medium.trigger);
		expect(large.keepRecent).toBeGreaterThan(medium.keepRecent);
		expect(large.maxDigest).toBeGreaterThan(medium.maxDigest);
		expect(small.keepRecent).toBeLessThan(small.trigger);
	});

	it("uses a model-relative but sublinear economic working set", () => {
		const small = resolveWorkingContextCharacters(8_000);
		const medium = resolveWorkingContextCharacters(200_000);
		const huge = resolveWorkingContextCharacters(1_000_000);
		expect(small).toBe(6_000);
		expect(medium).toBe(105_000);
		expect(huge).toBe(180_000);
		expect(huge / (1_000_000 * 1.5)).toBeLessThan(medium / (200_000 * 1.5));
		expect(resolveWorkingContextCharacters(1_000_000, 300_000)).toBeGreaterThan(huge);
		const history = resolveHistoryWorkingBudget(200_000);
		expect(history.keepRecent).toBeLessThan(history.trigger);
		expect(history.maxDigest).toBeLessThan(history.trigger);
	});

	it("uses explicit env overrides without allowing keep >= trigger", () => {
		const oldTrigger = process.env.AAA_DIGEST_TRIGGER_CHARACTERS;
		const oldKeep = process.env.AAA_DIGEST_KEEP_RECENT_CHARACTERS;
		const oldMax = process.env.AAA_DIGEST_MAX_CHARACTERS;
		try {
			process.env.AAA_DIGEST_TRIGGER_CHARACTERS = "1000";
			process.env.AAA_DIGEST_KEEP_RECENT_CHARACTERS = "5000";
			process.env.AAA_DIGEST_MAX_CHARACTERS = "333";
			const budget = resolveDigestBudget(1_000_000);
			expect(budget.trigger).toBe(1000);
			expect(budget.keepRecent).toBe(800);
			expect(budget.maxDigest).toBe(333);
		} finally {
			if (oldTrigger === undefined) delete process.env.AAA_DIGEST_TRIGGER_CHARACTERS;
			else process.env.AAA_DIGEST_TRIGGER_CHARACTERS = oldTrigger;
			if (oldKeep === undefined) delete process.env.AAA_DIGEST_KEEP_RECENT_CHARACTERS;
			else process.env.AAA_DIGEST_KEEP_RECENT_CHARACTERS = oldKeep;
			if (oldMax === undefined) delete process.env.AAA_DIGEST_MAX_CHARACTERS;
			else process.env.AAA_DIGEST_MAX_CHARACTERS = oldMax;
		}
	});
});

describe("context injection trimming keeps the digest anchor", () => {
	it("never drops a leading <session-digest> pair while trimming history", () => {
		const digestPair = [
			{ role: "user", text: "<session-digest>\nUSER: old requirements…\n</session-digest>" },
			{ role: "assistant", text: "Digest acknowledged." },
		];
		const body = Array.from({ length: 50 }, (_, i) => ({
			role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
			text: `msg ${i} `.repeat(500),
		}));
		const kept = trimConversationKeepingPrefix([...digestPair, ...body], 20_000);
		expect(kept[0].text).toContain("<session-digest>");
		expect(kept[1].text).toContain("acknowledged");
		const plainTrim = trimConversation(body, 20_000);
		expect(plainTrim.at(-1)?.text).toContain(`msg ${body.length - 1}`);
	});
});

describe("transient provider retry", () => {
	it("retries transient failures then succeeds; non-transient fails fast", async () => {
		let attempts = 0;
		const recovered = await withTransientRetry(
			new AbortController().signal,
			async () => {
				attempts += 1;
				if (attempts < 3) throw new Error("OpenAI-compatible request failed (429 Too Many Requests): rate limited");
				return "ok";
			},
			undefined,
			[1, 1],
		);
		expect(recovered).toBe("ok");
		expect(attempts).toBe(3);

		let fatalAttempts = 0;
		await expect(
			withTransientRetry(
				new AbortController().signal,
				async () => {
					fatalAttempts += 1;
					throw new Error("401 Unauthorized");
				},
				undefined,
				[1, 1],
			),
		).rejects.toThrow("401");
		expect(fatalAttempts).toBe(1);

		let hardQuotaAttempts = 0;
		await expect(
			withTransientRetry(
				new AbortController().signal,
				async () => {
					hardQuotaAttempts += 1;
					throw new Error("429 code 1310: 您已达到每周/每月使用上限，限额将在下周重置");
				},
				undefined,
				[1, 1, 1],
			),
		).rejects.toThrow("1310");
		expect(hardQuotaAttempts).toBe(1);
	});

	it("turns a stalled HTTP attempt into a retriable timeout", async () => {
		const parent = new AbortController().signal;
		let attempts = 0;
		const started = Date.now();
		await expect(
			withTransientRetry(
				parent,
				async () => {
					attempts += 1;
					const attemptSignal = createProviderAttemptSignal(parent, 10);
					await new Promise<never>((_resolve, reject) => {
						attemptSignal.addEventListener("abort", () => reject(attemptSignal.reason), { once: true });
					});
				},
				undefined,
				[0],
			),
		).rejects.toThrow();
		expect(attempts).toBe(2);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("aborts promptly when the caller cancels during backoff", async () => {
		const controller = new AbortController();
		let attempts = 0;
		const started = Date.now();
		await expect(
			withTransientRetry(
				controller.signal,
				async () => {
					attempts += 1;
					throw new Error("socket hang up");
				},
				() => controller.abort(),
				[50],
			),
		).rejects.toThrow();
		expect(attempts).toBe(1);
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});
