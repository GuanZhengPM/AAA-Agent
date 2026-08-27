/**
 * Deterministic conversation-ledger extraction.
 *
 * Long-horizon sessions lose nuance because raw conversational history is the
 * only carrier of conventions ("tax stays 1300"), corrections ("cap should be
 * 2500, not 3000") and requested deliverables ("create AUDIT.md"). This module
 * extracts those obligations from every user message with pure heuristics —
 * no model in the loop — so they can be persisted durably and injected into
 * every subsequent round regardless of history eviction.
 */

export type LedgerEntryKind = "correction" | "invariant" | "deliverable";

export interface LedgerEntry {
	kind: LedgerEntryKind;
	/** Normalized subject: parameter name, file path, or short noun phrase. */
	subject: string;
	oldValue?: string;
	newValue?: string;
	/** User-turn ordinal the entry was observed at (0 = unknown). */
	turn: number;
}

export const MAX_LEDGER_ENTRIES = 48;

const BACKTICK = "`";
const CODE_TOKEN = "[A-Za-z_][A-Za-z0-9_]*(?:[.-][A-Za-z0-9_]+)*";
const FILE_PATH = "[\\w@][\\w\\-./@]*\\.(?:md|py|txt|json|csv|tsv|yaml|yml|sh|toml|ini|log)";
const OPTIONAL_TICKS = "[" + BACKTICK + "\"'“”*]{0,2}";

function clean(value: string): string {
	return value
		.replace(/[*`'"“”‘’]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeNumberish(value: string): string {
	const raw = clean(value);
	const match = raw.match(/-?\d[\d_,.]*(?:\.\d+)?/);
	if (!match) return raw;
	return match[0].replace(/,/g, "");
}

/**
 * Extracts durable facts from a single user message.
 * Language coverage: Chinese + English common phrasing. Best effort by design:
 * false negatives only reduce durability, false positives remain readable.
 */
export function extractLedgerEntries(message: string, turn = 0): LedgerEntry[] {
	const entries: LedgerEntry[] = [];
	const push = (entry: Omit<LedgerEntry, "turn">) => {
		if (!entry.subject || entry.subject === "unresolved-subject") return;
		if (
			entries.some(
				existing => existing.kind === entry.kind && existing.subject.toLowerCase() === entry.subject.toLowerCase(),
			)
		)
			return;
		entries.push({ ...entry, turn });
	};

	// --- deliverables -------------------------------------------------------
	const deliverablePatterns: RegExp[] = [
		new RegExp(
			"(?:创建|新建|建立|建|生成|落成|写一?[个份]|补[充上个])[^。；;\\n]{0,14}?" +
				OPTIONAL_TICKS +
				"(" +
				FILE_PATH +
				")" +
				OPTIONAL_TICKS,
			"gi",
		),
		new RegExp(
			"\\b(?:create|add|write|generate)\\b[^.;\\n]{0,24}?" + OPTIONAL_TICKS + "(" + FILE_PATH + ")" + OPTIONAL_TICKS,
			"gi",
		),
	];
	for (const pattern of deliverablePatterns) {
		for (const match of message.matchAll(pattern)) {
			push({ kind: "deliverable", subject: clean(match[1]) });
		}
	}

	// --- corrections with explicit old→new (Shape A) -------------------------
	const shapeA = new RegExp(
		OPTIONAL_TICKS +
			"(" +
			CODE_TOKEN +
			")" +
			OPTIONAL_TICKS +
			"[^。；;\\n]{0,20}?从\\s*([+-]?\\d[\\d_,.]*)\\s*(?:分|bps|%|％|bp)?\\s*" +
			"(?:上调到|下调到|更正为|改为|调整到|提升为|降到|升到|改成|修正为)\\s*" +
			OPTIONAL_TICKS +
			"([+-]?\\d[\\d_,.]*)" +
			OPTIONAL_TICKS,
		"g",
	);
	for (const match of message.matchAll(shapeA)) {
		push({
			kind: "correction",
			subject: clean(match[1]),
			oldValue: normalizeNumberish(match[2]),
			newValue: normalizeNumberish(match[3]),
		});
	}

	// --- corrections implied by negation (Shape B) ---------------------------
	// e.g. "……COUPON25 抵扣上限不对，应该是 **2500 分**，不是 3000"
	const shapeB = new RegExp(
		"(?:应该是|应当是|应为|应该改成|改成|更正为)\\s*" +
			OPTIONAL_TICKS +
			"([+-]?\\d[\\d_,.]*)" +
			OPTIONAL_TICKS +
			"[^。；;\\n]{0,16}?(?:不是|而非|原来的?是?|之前说的?)\\s*" +
			OPTIONAL_TICKS +
			"([+-]?\\d[\\d_,.]*)" +
			OPTIONAL_TICKS,
		"g",
	);
	for (const match of message.matchAll(shapeB)) {
		const start = Math.max(0, (match.index ?? 0) - 90);
		const window = message.slice(start, match.index ?? 0);
		const beforeTick = new RegExp(
			BACKTICK + "?(" + CODE_TOKEN + ")" + BACKTICK + "?[^" + BACKTICK + "。；;\\n]{0,30}$",
		);
		const subjectMatch = window.match(beforeTick);
		let subject = "";
		if (subjectMatch?.[1]) subject = clean(subjectMatch[1]);
		else {
			const all = [...window.matchAll(new RegExp(CODE_TOKEN, "g"))].map(m => m[0]);
			subject = clean(all.at(-1) ?? "");
		}
		push({
			kind: "correction",
			subject,
			newValue: normalizeNumberish(match[1]),
			oldValue: normalizeNumberish(match[2]),
		});
	}

	// --- invariants -----------------------------------------------------------
	const invariantWords =
		"(?:保持|恒定|锁定|(?:不要|不许|不能|请勿)(?:再)?(?:动|改|变更)|(?:永|远)?不变|(?:永|远)?不动|stays|remains|never change)";
	const invariantHead = new RegExp(
		OPTIONAL_TICKS + "(" + CODE_TOKEN + ")" + OPTIONAL_TICKS + "[^。；;\\n]{0,30}?" + invariantWords,
		"g",
	);
	for (const head of message.matchAll(invariantHead)) {
		const tailStart = (head.index ?? 0) + head[0].length;
		const tail = message.slice(tailStart, tailStart + 26);
		const numMatch = tail.match(/-?\d[\d_,.]*/);
		push({
			kind: "invariant",
			subject: clean(head[1]),
			...(numMatch ? { newValue: normalizeNumberish(numMatch[0]) } : {}),
		});
	}

	return entries;
}

/** Newest value wins per (kind, subject); insertion order otherwise preserved. */
export function mergeLedger(previous: readonly LedgerEntry[], incoming: readonly LedgerEntry[]): LedgerEntry[] {
	const merged: LedgerEntry[] = [];
	const keyOf = (entry: LedgerEntry) => `${entry.kind}\u0000${entry.subject.toLowerCase()}`;
	const index = new Map<string, number>();
	for (const entry of [...previous, ...incoming]) {
		const key = keyOf(entry);
		const existingAt = index.get(key);
		if (existingAt === undefined) {
			index.set(key, merged.length);
			merged.push({ ...entry });
			continue;
		}
		const existing = merged[existingAt];
		merged[existingAt] = {
			...existing,
			oldValue:
				entry.newValue !== undefined
					? (existing.newValue ?? existing.oldValue)
					: (entry.oldValue ?? existing.oldValue),
			newValue: entry.newValue ?? existing.newValue,
			turn: Math.max(existing.turn, entry.turn),
		};
	}
	return merged.slice(-MAX_LEDGER_ENTRIES);
}

export function renderLedger(entries: readonly LedgerEntry[]): string {
	return entries
		.map(entry => {
			const changes: string[] = [];
			if (entry.oldValue !== undefined) changes.push(`was ${entry.oldValue}`);
			if (entry.newValue !== undefined) changes.push(`now ${entry.newValue}`);
			const tail = changes.length > 0 ? ` (${changes.join(", ")})` : "";
			return `- [${entry.kind}] ${entry.subject}${tail}`;
		})
		.join("\n");
}

export interface DeliverableProbe {
	subject: string;
	exists: boolean;
}

export function pendingDeliverables(
	entries: readonly LedgerEntry[],
	exists: (path: string) => boolean,
): DeliverableProbe[] {
	return entries
		.filter(entry => entry.kind === "deliverable")
		.map(entry => ({ subject: entry.subject, exists: exists(entry.subject) }))
		.filter(probe => !probe.exists);
}

/**
 * Like trimConversation, but a leading synthetic `<session-digest>` pair is
 * always preserved verbatim — it carries the distilled memory of everything
 * evicted earlier, which is exactly what must survive context pressure.
 */
export function trimConversationKeepingPrefix<T extends { role: string; text: string }>(
	messages: readonly T[],
	maxCharacters: number,
): T[] {
	if (messages.length >= 2 && messages[0].text.includes("<session-digest>")) {
		const prefix = messages.slice(0, 2);
		const rest = trimConversation(messages.slice(2), maxCharacters);
		return [...prefix, ...rest];
	}
	return trimConversation(messages, maxCharacters);
}

/** Keeps recent exchanges within a character budget, dropping oldest pairs first. */
export function trimConversation<T extends { role: string; text: string }>(
	messages: readonly T[],
	maxCharacters: number,
): T[] {
	const kept: T[] = [];
	let total = 0;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (total + message.text.length > maxCharacters && kept.length >= 2) break;
		kept.unshift(message);
		total += message.text.length;
	}
	return kept;
}
