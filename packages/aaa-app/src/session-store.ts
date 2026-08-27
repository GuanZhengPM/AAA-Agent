import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AgentConversationMessage,
	atomicWriteJson,
	getAdaptiveHarnessDir,
	type LongRunCheckpoint,
	type Model,
	SERVICE_TIERS,
	type ServiceTier,
	type StructuredContextState,
	THINKING_EFFORTS,
	THINKING_MODES,
	type ThinkingMode,
} from "@aaa-agent/runtime";
import { z } from "zod/v4";

export const CURRENT_SESSION_VERSION = 6;
const MAX_SESSION_MESSAGES = 40;
const MAX_SESSION_CHARACTERS = 120_000;
const MAX_SESSION_FILES = 100;
const LOCK_INITIALIZATION_GRACE_MS = 1_000;
const LOCK_RETRY_LIMIT = 16;
const lockSchema = z.object({
	pid: z.number().int().positive(),
	acquiredAt: z.number().int().nonnegative(),
	token: z.string().min(1),
});
type SessionLock = z.infer<typeof lockSchema>;
interface LockSnapshot {
	exists: boolean;
	identity?: string;
	modifiedAt?: number;
	owner?: SessionLock;
}

const messageSchema = z.object({
	role: z.enum(["user", "assistant"]),
	text: z.string(),
});

const evidenceRefSchema = z.object({
	kind: z.enum(["output", "tool", "file", "test", "browser", "user", "subagent"]),
	ref: z.string(),
	summary: z.string().optional(),
});

const structuredContextStateSchema = z.object({
	version: z.literal(1),
	userGoals: z.array(
		z.object({
			objective: z.string(),
			status: z.enum(["completed", "blocked", "incomplete"]),
			updatedAt: z.number().int().nonnegative(),
		}),
	),
	completedGoals: z.array(z.string()),
	remainingGoals: z.array(z.string()),
	verifiedFacts: z.array(
		z.object({
			statement: z.string(),
			evidence: z.array(evidenceRefSchema),
			verifiedAt: z.number().int().nonnegative(),
		}),
	),
	artifacts: z.array(evidenceRefSchema),
	openRisks: z.array(z.string()),
	ledger: z
		.array(
			z.object({
				kind: z.enum(["correction", "invariant", "deliverable"]),
				subject: z.string().min(1),
				oldValue: z.string().optional(),
				newValue: z.string().optional(),
				turn: z.number().int().nonnegative(),
			}),
		)
		.optional(),
	recoveryGuidance: z.string().optional(),
	updatedAt: z.number().int().nonnegative(),
});

const sessionSchema = z.object({
	version: z.number().int().positive(),
	id: z.string().min(1),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
	cwd: z.string().min(1),
	modelId: z.string().min(1),
	thinkingMode: z.enum(THINKING_MODES).optional(),
	effort: z.enum(THINKING_EFFORTS).optional(),
	serviceTier: z.enum(SERVICE_TIERS).optional(),
	messages: z.array(messageSchema),
	/** v6 append-only transcript sidecar; metadata JSON keeps messages empty. */
	transcriptFile: z.string().min(1).optional(),
	transcriptMessages: z.number().int().nonnegative().optional(),
	contextState: structuredContextStateSchema.optional(),
	digest: z
		.object({
			text: z.string(),
			updatedAt: z.number().int().nonnegative(),
			/** Number of transcript messages already represented by the digest. */
			coveredMessages: z.number().int().nonnegative().optional(),
		})
		.optional(),
	status: z.enum(["idle", "active", "running", "interrupted", "closed"]),
	ownerPid: z.number().int().positive().optional(),
	pendingTask: z.string().min(1).optional(),
	longRun: z
		.custom<LongRunCheckpoint>(value =>
			Boolean(
				value &&
					typeof value === "object" &&
					"version" in value &&
					value.version === 1 &&
					"id" in value &&
					typeof value.id === "string" &&
					"task" in value &&
					typeof value.task === "string" &&
					"policySnapshot" in value,
			),
		)
		.optional(),
});

export interface InteractiveSession {
	version: number;
	id: string;
	createdAt: number;
	updatedAt: number;
	cwd: string;
	modelId: string;
	thinkingMode: ThinkingMode;
	serviceTier?: ServiceTier;
	messages: AgentConversationMessage[];
	/** Relative append-only sidecar name and committed message count. */
	transcriptFile?: string;
	transcriptMessages?: number;
	contextState?: StructuredContextState;
	/** Rolling distilled memory of exchanges evicted from the live window. */
	digest?: SessionDigest;
	status: "active" | "running" | "interrupted" | "closed";
	ownerPid?: number;
	pendingTask?: string;
	longRun?: LongRunCheckpoint;
}

export interface SessionSummary {
	id: string;
	cwd: string;
	modelId: string;
	updatedAt: number;
	status: InteractiveSession["status"];
	turns: number;
	preview: string;
}

export interface SessionHistoryMatch {
	session: SessionSummary;
	role: AgentConversationMessage["role"];
	excerpt: string;
	score: number;
}

function createSessionId(): string {
	return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

export function getSessionsDir(): string {
	return path.join(getAdaptiveHarnessDir(), "sessions");
}

export function getSessionPath(id: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`Invalid session id '${id}'.`);
	return path.join(getSessionsDir(), `${id}.json`);
}

export function getSessionTranscriptPath(id: string): string {
	// getSessionPath performs the shared traversal-safe id validation.
	void getSessionPath(id);
	return path.join(getSessionsDir(), `${id}.transcript.jsonl`);
}

function getSessionLockPath(id: string): string {
	return `${getSessionPath(id)}.lock`;
}

export function compactSessionMessages(messages: readonly AgentConversationMessage[]): AgentConversationMessage[] {
	const compacted = messages.map(message => ({ ...message }));
	let characters = compacted.reduce((total, message) => total + message.text.length, 0);
	while (compacted.length > MAX_SESSION_MESSAGES || characters > MAX_SESSION_CHARACTERS) {
		const removed = compacted.splice(0, Math.min(2, compacted.length));
		for (const message of removed) characters -= message.text.length;
	}
	return compacted;
}

export interface SessionDigest {
	text: string;
	updatedAt: number;
	/** Number of leading transcript messages represented by this digest. */
	coveredMessages?: number;
}

/**
 * Characters-per-token heuristic — must match the agent-loop compaction
 * constant (agent.ts) so this rolls BEFORE blunt in-loop truncation fires.
 */
const CHARS_PER_TOKEN = 1.5;

export interface DigestBudget {
	/** Roll when the live window exceeds this many characters. */
	trigger: number;
	/** Newest exchanges kept verbatim inside the live window. */
	keepRecent: number;
	/** Hard cap of the rolling digest text itself. */
	maxDigest: number;
}

const BUDGET_FLOORS: Record<keyof DigestBudget, number> = {
	// Only guard pathological/tiny model metadata. Normal models scale linearly
	// with contextWindow and never collapse to a shared absolute cap.
	trigger: 1_500,
	keepRecent: 750,
	maxDigest: 750,
};
const DEFAULT_BUDGET: DigestBudget = { trigger: 96_000, keepRecent: 40_000, maxDigest: 24_000 };

function modelDerivedBudget(contextWindowTokens: number): DigestBudget {
	const capacity = Math.max(1_000, Math.floor(contextWindowTokens)) * CHARS_PER_TOKEN;
	return {
		trigger: Math.floor(capacity * 0.5), // roll at half capacity
		keepRecent: Math.floor(capacity * 0.2), // newest fifth verbatim
		maxDigest: Math.floor(capacity * 0.15), // distilled past ~15%
	};
}

function envOrDerived(envKey: string, key: keyof DigestBudget, derived: DigestBudget): number {
	const raw = Number(process.env[envKey]);
	if (Number.isFinite(raw) && raw > 0) return raw;
	return Math.max(derived[key], BUDGET_FLOORS[key]);
}

/**
 * Resolve the digest budget for a session. Scales with the CURRENT model's
 * context window (models may switch mid-session); explicit env overrides win
 * for power users and deterministic tests; floors protect tiny local models.
 */
export function resolveDigestBudget(contextWindowTokens?: number): DigestBudget {
	const derived = contextWindowTokens ? modelDerivedBudget(contextWindowTokens) : DEFAULT_BUDGET;
	const trigger = envOrDerived("AAA_DIGEST_TRIGGER_CHARACTERS", "trigger", derived);
	const requestedKeep = envOrDerived("AAA_DIGEST_KEEP_RECENT_CHARACTERS", "keepRecent", derived);
	return {
		trigger,
		// Keep must remain below the trigger or compaction could never evict.
		keepRecent: Math.min(requestedKeep, Math.max(1, Math.floor(trigger * 0.8))),
		maxDigest: envOrDerived("AAA_DIGEST_MAX_CHARACTERS", "maxDigest", derived),
	};
}

const MAX_DIGEST_ENTRY_CHARS = 1_200;

function clipForDigest(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= MAX_DIGEST_ENTRY_CHARS) return compact;
	const head = Math.ceil(MAX_DIGEST_ENTRY_CHARS * 0.65);
	const tail = Math.max(80, MAX_DIGEST_ENTRY_CHARS - head - 24);
	return `${compact.slice(0, head)}\n… [${compact.length - head - tail} chars condensed] …\n${compact.slice(compact.length - tail)}`;
}

/**
 * Split a conversation snapshot into (keep, evict): `keep` is the newest pair-
 * aligned suffix within DIGEST_KEEP_RECENT_CHARACTERS; `evict` rolls into the
 * digest. Pair alignment keeps user/assistant exchanges intact.
 */
export function partitionForDigest(
	messages: readonly AgentConversationMessage[],
	keepRecentCharacters: number = resolveDigestBudget().keepRecent,
): {
	keep: AgentConversationMessage[];
	evict: AgentConversationMessage[];
} {
	if (messages.length === 0) return { keep: [], evict: [] };
	let suffixCharacters = 0;
	let cut = messages.length;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		suffixCharacters += messages[index].text.length;
		if (suffixCharacters > keepRecentCharacters) {
			cut = index % 2 === 0 ? index : index + 1;
			break;
		}
	}
	return { keep: messages.slice(cut), evict: messages.slice(0, cut) };
}

/**
 * Recursively fold evicted exchanges into a bounded rolling digest. User turns
 * carry requirements so they are preserved nearly whole; assistant turns are
 * reduced to lead excerpts because their durable outcomes live in artifacts.
 * Over budget, OLDEST digest blocks drop from the head — key obligations
 * survive independently through contextState.ledger.
 */
export function rollDigest(
	previousDigestText: string | undefined,
	evicted: readonly AgentConversationMessage[],
	maxDigestCharacters: number = resolveDigestBudget().maxDigest,
): string {
	const blocks: string[] = [];
	for (let index = 0; index < evicted.length; index += 2) {
		const user = evicted[index];
		if (user?.role !== "user") continue;
		blocks.push(`USER: ${clipForDigest(user.text)}`);
		const assistant = evicted[index + 1];
		if (assistant && assistant.role === "assistant") {
			blocks.push(`AGENT: ${clipForDigest(assistant.text).slice(0, 240)}`);
		}
	}
	let merged = previousDigestText?.trim()
		? `${previousDigestText.trim()}\n\n${blocks.join("\n\n")}`
		: blocks.join("\n\n");
	while (merged.length > maxDigestCharacters) {
		const cutAt = merged.indexOf("\n\n", 240);
		if (cutAt < 0) break;
		merged = merged.slice(cutAt + 2);
	}
	return merged;
}

function processIsAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

export interface SessionLease {
	sessionId: string;
	release(): Promise<void>;
}

async function readLockSnapshot(lockPath: string): Promise<LockSnapshot> {
	let lockStat: Stats;
	try {
		lockStat = await fs.lstat(lockPath);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { exists: false };
		throw error;
	}
	const identity = `${lockStat.dev}-${lockStat.ino}-${lockStat.birthtimeMs}`;
	try {
		const ownerPath = lockStat.isDirectory() ? path.join(lockPath, "owner.json") : lockPath;
		return {
			exists: true,
			identity,
			modifiedAt: lockStat.mtimeMs,
			owner: lockSchema.parse(await Bun.file(ownerPath).json()),
		};
	} catch {
		return { exists: true, identity, modifiedAt: lockStat.mtimeMs };
	}
}

async function installSessionLock(lockPath: string, owner: SessionLock): Promise<boolean> {
	const tempPath = `${lockPath}.${process.pid}.${owner.token}.tmp`;
	await fs.mkdir(tempPath, { mode: 0o700 });
	try {
		await atomicWriteJson(path.join(tempPath, "owner.json"), owner);
		try {
			await fs.rename(tempPath, lockPath);
			return true;
		} catch (error) {
			const snapshot = await readLockSnapshot(lockPath);
			if (
				snapshot.exists ||
				(error instanceof Error &&
					"code" in error &&
					(error.code === "EEXIST" ||
						error.code === "ENOTEMPTY" ||
						error.code === "EISDIR" ||
						error.code === "ENOTDIR"))
			) {
				return false;
			}
			throw error;
		}
	} finally {
		await fs.rm(tempPath, { recursive: true, force: true });
	}
}

async function reclaimStaleSessionLock(lockPath: string, snapshot: LockSnapshot): Promise<boolean> {
	if (!snapshot.identity) return false;
	const quarantinePath = `${lockPath}.stale-${snapshot.identity}`;
	try {
		await fs.rename(lockPath, quarantinePath);
		return true;
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" ||
				error.code === "EEXIST" ||
				error.code === "ENOTEMPTY" ||
				error.code === "EISDIR" ||
				error.code === "ENOTDIR")
		) {
			return false;
		}
		throw error;
	}
}

async function releaseSessionLock(lockPath: string): Promise<void> {
	const releasedPath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.released`;
	try {
		await fs.rename(lockPath, releasedPath);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	await fs.rm(releasedPath, { recursive: true, force: true });
}

export async function acquireSessionLease(id: string): Promise<SessionLease> {
	const lockPath = getSessionLockPath(id);
	await fs.mkdir(getSessionsDir(), { recursive: true });
	for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
		const token = crypto.randomUUID();
		const owner = { pid: process.pid, acquiredAt: Date.now(), token };
		if (await installSessionLock(lockPath, owner)) {
			let released = false;
			return {
				sessionId: id,
				async release() {
					if (released) return;
					const snapshot = await readLockSnapshot(lockPath);
					if (!snapshot.exists || snapshot.owner?.token !== token) {
						released = true;
						return;
					}
					await releaseSessionLock(lockPath);
					released = true;
				},
			};
		}
		const snapshot = await readLockSnapshot(lockPath);
		if (!snapshot.exists) {
			await Bun.sleep(1);
			continue;
		}
		if (
			!snapshot.owner &&
			snapshot.modifiedAt !== undefined &&
			Date.now() - snapshot.modifiedAt < LOCK_INITIALIZATION_GRACE_MS
		) {
			await Bun.sleep(1);
			continue;
		}
		if (snapshot.owner && processIsAlive(snapshot.owner.pid)) {
			throw new Error(`Session ${id} is already active in process ${snapshot.owner.pid}.`);
		}
		if (!(await reclaimStaleSessionLock(lockPath, snapshot))) await Bun.sleep(1);
	}
	throw new Error(`Cannot acquire session ${id}.`);
}

function normalizeSession(value: unknown, recoverStale = false): InteractiveSession {
	const parsed = sessionSchema.parse(value);
	if (parsed.version > CURRENT_SESSION_VERSION) {
		throw new Error(`Session version ${parsed.version} is newer than supported version ${CURRENT_SESSION_VERSION}.`);
	}
	const thinkingMode = parsed.thinkingMode ?? parsed.effort;
	if (!thinkingMode) throw new Error(`Session ${parsed.id} has no thinking mode.`);
	let status: InteractiveSession["status"] = parsed.status === "idle" ? "closed" : parsed.status;
	let ownerPid = parsed.ownerPid;
	if (recoverStale && (status === "active" || status === "running") && !processIsAlive(ownerPid)) {
		status = "interrupted";
		ownerPid = undefined;
	}
	const { effort: _effort, ...current } = parsed;
	return {
		...current,
		version: CURRENT_SESSION_VERSION,
		thinkingMode,
		// Full transcript is kept on disk verbatim: cross-session search and the
		// in-process lean index cover the performance needs; capping here destroyed
		// historical traceability beyond 20 exchanges.
		messages: parsed.messages,
		status,
		...(ownerPid ? { ownerPid } : {}),
	};
}

export function createInteractiveSession(
	cwd: string,
	model: Model,
	thinkingMode: ThinkingMode,
	serviceTier?: ServiceTier,
): InteractiveSession {
	const now = Date.now();
	return {
		version: CURRENT_SESSION_VERSION,
		id: createSessionId(),
		createdAt: now,
		updatedAt: now,
		cwd: path.resolve(cwd),
		modelId: `${model.provider}/${model.id}`,
		thinkingMode,
		...(serviceTier ? { serviceTier } : {}),
		messages: [],
		status: "closed",
	};
}

async function readTranscriptMessages(id: string, committed?: number): Promise<AgentConversationMessage[]> {
	let text: string;
	try {
		text = await fs.readFile(getSessionTranscriptPath(id), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const lines = text.split("\n");
	const messages: AgentConversationMessage[] = [];
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		try {
			messages.push(messageSchema.parse(JSON.parse(line)));
		} catch (error) {
			// A process crash can leave only the final append partially written. The
			// metadata count is the commit marker, so ignore an uncommitted tail.
			const hasLaterContent = lines.slice(index + 1).some(candidate => candidate.trim());
			if (hasLaterContent || (committed !== undefined && messages.length < committed)) throw error;
			break;
		}
	}
	return committed === undefined ? messages : messages.slice(0, committed);
}

function sameMessage(left: AgentConversationMessage, right: AgentConversationMessage): boolean {
	return left.role === right.role && left.text === right.text;
}

async function atomicWriteTranscript(id: string, messages: readonly AgentConversationMessage[]): Promise<void> {
	const target = getSessionTranscriptPath(id);
	await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
	const body = messages.length > 0 ? `${messages.map(message => JSON.stringify(message)).join("\n")}\n` : "";
	try {
		await fs.writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
		await fs.rename(temporary, target);
	} finally {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
	}
}

interface TranscriptWriteState {
	count: number;
	last?: AgentConversationMessage;
	size: number;
	mtimeMs: number;
}

const transcriptWriteStates = new Map<string, TranscriptWriteState>();

async function rememberTranscriptState(id: string, messages: readonly AgentConversationMessage[]): Promise<void> {
	const target = getSessionTranscriptPath(id);
	try {
		const stats = await fs.stat(target);
		transcriptWriteStates.set(target, {
			count: messages.length,
			...(messages.at(-1) ? { last: { ...messages.at(-1)! } } : {}),
			size: stats.size,
			mtimeMs: stats.mtimeMs,
		});
	} catch {
		transcriptWriteStates.delete(target);
	}
}

async function persistTranscript(id: string, messages: readonly AgentConversationMessage[]): Promise<void> {
	const target = getSessionTranscriptPath(id);
	const cached = transcriptWriteStates.get(target);
	let unchangedOnDisk = false;
	if (cached) {
		try {
			const stats = await fs.stat(target);
			unchangedOnDisk = stats.size === cached.size && stats.mtimeMs === cached.mtimeMs;
		} catch {}
	}
	const cachedPrefixMatches =
		cached !== undefined &&
		unchangedOnDisk &&
		cached.count <= messages.length &&
		(cached.count === 0 || (cached.last !== undefined && sameMessage(cached.last, messages[cached.count - 1]!)));
	if (cachedPrefixMatches) {
		const appended = messages.slice(cached.count);
		if (appended.length > 0) {
			await fs.appendFile(target, `${appended.map(message => JSON.stringify(message)).join("\n")}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			await rememberTranscriptState(id, messages);
		}
		return;
	}

	const existing = await readTranscriptMessages(id);
	const appendOnly =
		existing.length <= messages.length && existing.every((message, index) => sameMessage(message, messages[index]!));
	if (!appendOnly) {
		await atomicWriteTranscript(id, messages);
		await rememberTranscriptState(id, messages);
		return;
	}
	const appended = messages.slice(existing.length);
	if (appended.length > 0) {
		await fs.mkdir(getSessionsDir(), { recursive: true, mode: 0o700 });
		await fs.appendFile(target, `${appended.map(message => JSON.stringify(message)).join("\n")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	}
	await rememberTranscriptState(id, messages);
}

export async function saveInteractiveSession(session: InteractiveSession): Promise<void> {
	const normalized = normalizeSession({ ...session, updatedAt: Date.now() });
	await persistTranscript(normalized.id, normalized.messages);
	const transcriptFile = path.basename(getSessionTranscriptPath(normalized.id));
	const committed: InteractiveSession = {
		...normalized,
		transcriptFile,
		transcriptMessages: normalized.messages.length,
	};
	Object.assign(session, committed);
	await atomicWriteJson(getSessionPath(normalized.id), {
		...committed,
		// Checkpoints update metadata without rewriting an unbounded archive.
		messages: [],
	});
	// Same-process searches see fresh appends immediately without polling stats.
	markSessionSearchDirectoryDirty();
}

export async function loadInteractiveSession(id: string): Promise<InteractiveSession> {
	try {
		const normalized = normalizeSession(await Bun.file(getSessionPath(id)).json(), true);
		if (!normalized.transcriptFile) return normalized;
		const messages = await readTranscriptMessages(id, normalized.transcriptMessages);
		await rememberTranscriptState(id, messages);
		return { ...normalized, messages };
	} catch (error) {
		if (error instanceof SyntaxError || error instanceof z.ZodError) {
			throw new Error(`Invalid session file ${getSessionPath(id)}`, { cause: error });
		}
		throw error;
	}
}

function toSummary(session: InteractiveSession): SessionSummary {
	const firstUser = session.messages.find(message => message.role === "user")?.text ?? session.pendingTask ?? "";
	return {
		id: session.id,
		cwd: session.cwd,
		modelId: session.modelId,
		updatedAt: session.updatedAt,
		status: session.status,
		turns: Math.floor(session.messages.length / 2),
		preview: firstUser.replace(/\s+/g, " ").slice(0, 100),
	};
}

export async function listInteractiveSessions(cwd?: string): Promise<SessionSummary[]> {
	const directory = getSessionsDir();
	let entries: string[];
	try {
		entries = await fs.readdir(directory);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const resolvedCwd = cwd ? path.resolve(cwd) : undefined;
	const sessions = await Promise.all(
		entries
			.filter(name => name.endsWith(".json"))
			.map(async name => {
				try {
					const session = await loadInteractiveSession(name.slice(0, -5));
					return !resolvedCwd || session.cwd === resolvedCwd ? toSummary(session) : undefined;
				} catch {
					return undefined;
				}
			}),
	);
	return sessions
		.filter((session): session is SessionSummary => Boolean(session))
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.slice(0, MAX_SESSION_FILES);
}

function normalizeForSearch(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Lean per-process search cache.
 *
 * Every earlier search re-parsed (JSON.parse + zod normalization) every session
 * file TWICE: once inside listInteractiveSessions() and once more per summary
 * in the scan loop — O(total-session-bytes) parsing per query regardless of
 * repeat traffic. Sessions are append-mostly, so we fingerprint each file by
 * `${size}:${mtimeMs}` and reuse a normalized in-memory copy until the stat
 * changes. First search pays one lean parse (no zod) per file; subsequent
 * searches only touch files whose fingerprint changed plus O(index) scoring.
 */
interface CachedSessionIndex {
	fingerprint: string;
	metadataFingerprint: string;
	transcriptFingerprint: string;
	id: string;
	cwd: string;
	modelId: string;
	status: InteractiveSession["status"];
	updatedAt: number;
	messages: ReadonlyArray<{
		role: AgentConversationMessage["role"];
		normalizedLower: string;
		compactOriginal: string;
	}>;
	/** Token/CJK-bigram → candidate message ordinals. */
	postings: ReadonlyMap<string, readonly number[]>;
	/** Oversized messages are always scanned to guarantee zero false negatives. */
	fallbackMessageIndices: readonly number[];
}

const SESSION_CACHE_MAX_MESSAGES = 50_000;
const SESSION_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const sessionSearchCache = new Map<string, CachedSessionIndex>();
const sessionSearchManifest = new Map<
	string,
	{ filePath: string; fingerprint: string; metadataFingerprint: string; transcriptFingerprint: string }
>();
let cachedMessageCount = 0;
let cachedCharacterCount = 0;
let cachedDirectoryPath: string | undefined;
let cachedDirectoryMtimeMs = -1;
let lastDirectoryScanAt = 0;
let searchDirectoryDirty = true;
const SEARCH_DIRECTORY_RESCAN_INTERVAL_MS = 500;

function markSessionSearchDirectoryDirty(): void {
	searchDirectoryDirty = true;
}

export function resetSessionSearchCache(): void {
	sessionSearchCache.clear();
	sessionSearchManifest.clear();
	cachedMessageCount = 0;
	cachedCharacterCount = 0;
	cachedDirectoryPath = undefined;
	cachedDirectoryMtimeMs = -1;
	lastDirectoryScanAt = 0;
	searchDirectoryDirty = true;
}

function removeCachedSession(id: string): void {
	const cached = sessionSearchCache.get(id);
	if (!cached) return;
	sessionSearchCache.delete(id);
	cachedMessageCount -= cached.messages.length;
	for (const message of cached.messages) cachedCharacterCount -= message.compactOriginal.length;
}

function evictOverflow(): void {
	while (cachedMessageCount > SESSION_CACHE_MAX_MESSAGES || cachedCharacterCount > SESSION_CACHE_MAX_BYTES) {
		const oldestKey = sessionSearchCache.keys().next().value;
		if (oldestKey === undefined) break;
		removeCachedSession(oldestKey);
	}
}

const MAX_GRAM_INDEXED_MESSAGE_CHARACTERS = 12_000;

/** Latin/code tokens + Chinese bigrams: language-neutral enough for CLI memory. */
function searchIndexKeys(normalized: string): Set<string> {
	const keys = new Set<string>();
	for (const match of normalized.matchAll(/[a-z0-9_./-]{2,}/g)) keys.add(match[0]);
	for (const match of normalized.matchAll(/[\u3400-\u9fff]+/g)) {
		const run = match[0];
		if (run.length === 1) keys.add(run);
		else for (let index = 0; index < run.length - 1; index += 1) keys.add(run.slice(index, index + 2));
	}
	return keys;
}

function cacheSessionIndex(
	id: string,
	fingerprint: string,
	metadataFingerprint: string,
	transcriptFingerprint: string,
	raw: { cwd?: unknown; modelId?: unknown; status?: unknown; updatedAt?: unknown; messages?: unknown },
): CachedSessionIndex {
	removeCachedSession(id);
	const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
	const messages: CachedSessionIndex["messages"] = rawMessages.flatMap(entry => {
		if (!entry || typeof entry !== "object") return [];
		const role = (entry as { role?: unknown }).role === "assistant" ? "assistant" : "user";
		const text = (entry as { text?: unknown }).text;
		if (typeof text !== "string" || text.length === 0) return [];
		const compactOriginal = normalizeForSearch(text);
		return [{ role, normalizedLower: compactOriginal.toLocaleLowerCase(), compactOriginal }];
	});
	const mutablePostings = new Map<string, number[]>();
	const fallbackMessageIndices: number[] = [];
	for (const [messageIndex, message] of messages.entries()) {
		if (message.normalizedLower.length > MAX_GRAM_INDEXED_MESSAGE_CHARACTERS) {
			fallbackMessageIndices.push(messageIndex);
			continue;
		}
		for (const key of searchIndexKeys(message.normalizedLower)) {
			const posting = mutablePostings.get(key) ?? [];
			posting.push(messageIndex);
			mutablePostings.set(key, posting);
		}
	}
	const status =
		typeof raw.status === "string" && ["idle", "active", "running", "interrupted", "closed"].includes(raw.status)
			? (raw.status as InteractiveSession["status"])
			: "closed";
	const cached: CachedSessionIndex = {
		fingerprint,
		metadataFingerprint,
		transcriptFingerprint,
		id,
		cwd: typeof raw.cwd === "string" ? raw.cwd : "",
		modelId: typeof raw.modelId === "string" ? raw.modelId : "unknown-model",
		status,
		updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
		messages,
		postings: mutablePostings,
		fallbackMessageIndices,
	};
	sessionSearchCache.set(id, cached);
	cachedMessageCount += messages.length;
	for (const message of messages) cachedCharacterCount += message.compactOriginal.length;
	evictOverflow();
	return cached;
}

async function ensureSessionIndexed(
	id: string,
	filePath: string,
	fingerprint: string,
	metadataFingerprint: string,
	transcriptFingerprint: string,
): Promise<CachedSessionIndex | undefined> {
	const cached = sessionSearchCache.get(id);
	if (cached && cached.fingerprint === fingerprint) {
		// Refresh LRU position without reparsing.
		sessionSearchCache.delete(id);
		sessionSearchCache.set(id, cached);
		return cached;
	}
	try {
		const text = await fs.readFile(filePath, "utf8");
		const raw = JSON.parse(text) as Record<string, unknown>;
		if (cached && typeof raw.transcriptFile === "string" && cached.transcriptFingerprint === transcriptFingerprint) {
			const refreshed: CachedSessionIndex = {
				...cached,
				fingerprint,
				metadataFingerprint,
				cwd: typeof raw.cwd === "string" ? raw.cwd : cached.cwd,
				modelId: typeof raw.modelId === "string" ? raw.modelId : cached.modelId,
				status:
					typeof raw.status === "string" &&
					["idle", "active", "running", "interrupted", "closed"].includes(raw.status)
						? raw.status === "idle"
							? "closed"
							: (raw.status as InteractiveSession["status"])
						: cached.status,
				updatedAt:
					typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : cached.updatedAt,
			};
			sessionSearchCache.delete(id);
			sessionSearchCache.set(id, refreshed);
			return refreshed;
		}
		if (typeof raw.transcriptFile === "string") {
			raw.messages = await readTranscriptMessages(
				id,
				typeof raw.transcriptMessages === "number" ? raw.transcriptMessages : undefined,
			);
		}
		return cacheSessionIndex(id, fingerprint, metadataFingerprint, transcriptFingerprint, raw);
	} catch {
		return undefined;
	}
}

/**
 * Directory-level generation check avoids N sequential stat calls on every hot
 * query. Atomic session saves update directory mtime and mark this process
 * dirty immediately. External/non-atomic writers are observed after the short
 * rescan interval. Changed-file stats/parses run in parallel.
 */
async function loadManifestSessions(): Promise<CachedSessionIndex[]> {
	const indexed = await Promise.all(
		[...sessionSearchManifest.entries()].map(([id, entry]) =>
			ensureSessionIndexed(
				id,
				entry.filePath,
				entry.fingerprint,
				entry.metadataFingerprint,
				entry.transcriptFingerprint,
			),
		),
	);
	return indexed.filter((entry): entry is CachedSessionIndex => Boolean(entry));
}

async function indexedSessionsInDirectory(directory: string): Promise<CachedSessionIndex[]> {
	if (cachedDirectoryPath !== directory) {
		resetSessionSearchCache();
		cachedDirectoryPath = directory;
	}
	const now = Date.now();
	if (!searchDirectoryDirty && now - lastDirectoryScanAt < SEARCH_DIRECTORY_RESCAN_INTERVAL_MS) {
		return await loadManifestSessions();
	}
	let directoryStats: Awaited<ReturnType<typeof fs.stat>>;
	try {
		directoryStats = await fs.stat(directory);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	if (!searchDirectoryDirty && directoryStats.mtimeMs === cachedDirectoryMtimeMs) {
		lastDirectoryScanAt = now;
		return await loadManifestSessions();
	}

	const entries = (await fs.readdir(directory)).filter(name => name.endsWith(".json"));
	const liveIds = new Set(entries.map(name => name.slice(0, -5)));
	for (const id of [...sessionSearchManifest.keys()]) {
		if (liveIds.has(id)) continue;
		sessionSearchManifest.delete(id);
		removeCachedSession(id);
	}
	const indexed = await Promise.all(
		entries.map(async name => {
			const id = name.slice(0, -5);
			const filePath = path.join(directory, name);
			try {
				const stats = await fs.stat(filePath);
				const metadataFingerprint = `${stats.size}:${stats.mtimeMs}`;
				let transcriptFingerprint = "legacy";
				try {
					const transcriptStats = await fs.stat(getSessionTranscriptPath(id));
					transcriptFingerprint = `${transcriptStats.size}:${transcriptStats.mtimeMs}`;
				} catch {}
				const fingerprint = `${metadataFingerprint}:${transcriptFingerprint}`;
				sessionSearchManifest.set(id, {
					filePath,
					fingerprint,
					metadataFingerprint,
					transcriptFingerprint,
				});
				return await ensureSessionIndexed(id, filePath, fingerprint, metadataFingerprint, transcriptFingerprint);
			} catch {
				return undefined;
			}
		}),
	);
	cachedDirectoryMtimeMs = directoryStats.mtimeMs;
	lastDirectoryScanAt = now;
	searchDirectoryDirty = false;
	return indexed.filter((entry): entry is CachedSessionIndex => Boolean(entry));
}

function summarizeCached(cached: CachedSessionIndex): SessionSummary {
	const firstUser = cached.messages.find(message => message.role === "user");
	return {
		id: cached.id,
		cwd: cached.cwd,
		modelId: cached.modelId,
		updatedAt: cached.updatedAt,
		status: cached.status,
		turns: Math.floor(cached.messages.length / 2),
		preview: firstUser ? firstUser.compactOriginal.slice(0, 120) : "",
	};
}

function candidateMessageIndices(cached: CachedSessionIndex, queryLower: string): number[] {
	const keys = searchIndexKeys(queryLower);
	if (keys.size === 0) return cached.messages.map((_message, index) => index);
	const candidates = new Set<number>(cached.fallbackMessageIndices);
	for (const key of keys) {
		for (const index of cached.postings.get(key) ?? []) candidates.add(index);
	}
	return [...candidates];
}

function matchMessageCached(
	message: CachedSessionIndex["messages"][number],
	queryLower: string,
	terms: readonly string[],
): { excerpt: string; score: number } | undefined {
	const normalized = message.normalizedLower;
	const exactIndex = normalized.indexOf(queryLower);
	let matchedTerms = 0;
	let firstIndex = exactIndex;
	if (firstIndex < 0) {
		for (const term of terms) {
			const at = normalized.indexOf(term);
			if (at < 0) continue;
			matchedTerms += 1;
			if (firstIndex < 0 || at < firstIndex) firstIndex = at;
		}
	} else {
		matchedTerms = terms.length > 0 ? terms.length : 1;
	}
	if (exactIndex < 0 && matchedTerms === 0) return undefined;
	// Same scoring contract as the previous matcher: phrase hit dominates.
	const score = (exactIndex >= 0 ? 100 : 0) + matchedTerms * 10;
	const compact = message.compactOriginal;
	const queryLength = Math.max(1, queryLower.length);
	const start = Math.max(0, firstIndex - 70);
	const end = Math.min(compact.length, firstIndex + queryLength + 130);
	const excerpt = `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
	return { excerpt, score };
}

export async function searchInteractiveSessions(
	query: string,
	cwd?: string,
	limit = 10,
): Promise<SessionHistoryMatch[]> {
	const normalizedQuery = query.trim();
	if (!normalizedQuery) return [];
	const directory = getSessionsDir();
	const indexedSessions = await indexedSessionsInDirectory(directory);
	const resolvedCwd = cwd ? path.resolve(cwd) : undefined;
	const queryLower = normalizedQuery.toLocaleLowerCase();
	const terms = queryLower.split(/\s+/).filter(Boolean);

	interface Hit {
		cached: CachedSessionIndex;
		role: AgentConversationMessage["role"];
		excerpt: string;
		score: number;
	}
	const hits: Hit[] = [];

	for (const cached of indexedSessions) {
		if (resolvedCwd && cached.cwd !== resolvedCwd) continue;
		for (const messageIndex of candidateMessageIndices(cached, queryLower)) {
			const message = cached.messages[messageIndex];
			if (!message) continue;
			const match = matchMessageCached(message, queryLower, terms);
			if (match) hits.push({ cached, role: message.role, excerpt: match.excerpt, score: match.score });
		}
	}

	return hits
		.sort((left, right) => right.score - left.score || right.cached.updatedAt - left.cached.updatedAt)
		.slice(0, Math.max(1, Math.min(50, limit)))
		.map(hit => ({ session: summarizeCached(hit.cached), role: hit.role, excerpt: hit.excerpt, score: hit.score }));
}

export async function findRecentInteractiveSession(cwd: string): Promise<InteractiveSession | undefined> {
	const sessions = await listInteractiveSessions(cwd);
	const recent = sessions.find(session => session.status === "closed" || session.status === "interrupted");
	return recent ? loadInteractiveSession(recent.id) : undefined;
}

export async function removeInteractiveSession(id: string): Promise<void> {
	await fs.rm(getSessionPath(id), { force: true });
}
