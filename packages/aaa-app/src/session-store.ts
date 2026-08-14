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

export const CURRENT_SESSION_VERSION = 5;
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
	contextState: structuredContextStateSchema.optional(),
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
	contextState?: StructuredContextState;
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
		messages: compactSessionMessages(parsed.messages),
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

export async function saveInteractiveSession(session: InteractiveSession): Promise<void> {
	const normalized = normalizeSession({ ...session, updatedAt: Date.now() });
	Object.assign(session, normalized);
	await atomicWriteJson(getSessionPath(normalized.id), normalized);
}

export async function loadInteractiveSession(id: string): Promise<InteractiveSession> {
	try {
		return normalizeSession(await Bun.file(getSessionPath(id)).json(), true);
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
	const sessions: SessionSummary[] = [];
	for (const name of entries) {
		if (!name.endsWith(".json")) continue;
		try {
			const session = await loadInteractiveSession(name.slice(0, -5));
			if (!resolvedCwd || session.cwd === resolvedCwd) sessions.push(toSummary(session));
		} catch {}
	}
	return sessions.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_SESSION_FILES);
}

function matchMessage(text: string, query: string): { excerpt: string; score: number } | undefined {
	const compact = text.replace(/\s+/g, " ").trim();
	const normalized = compact.toLocaleLowerCase();
	const normalizedQuery = query.toLocaleLowerCase();
	const exactIndex = normalized.indexOf(normalizedQuery);
	const terms = normalizedQuery.split(/\s+/).filter(Boolean);
	const matchedTerms = terms.filter(term => normalized.includes(term));
	if (exactIndex < 0 && matchedTerms.length === 0) return undefined;
	const firstIndex =
		exactIndex >= 0
			? exactIndex
			: Math.min(...matchedTerms.map(term => normalized.indexOf(term)).filter(index => index >= 0));
	const start = Math.max(0, firstIndex - 70);
	const end = Math.min(compact.length, firstIndex + normalizedQuery.length + 130);
	const excerpt = `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
	return {
		excerpt,
		score: (exactIndex >= 0 ? 100 : 0) + matchedTerms.length * 10,
	};
}

export async function searchInteractiveSessions(
	query: string,
	cwd?: string,
	limit = 10,
): Promise<SessionHistoryMatch[]> {
	const normalizedQuery = query.trim();
	if (!normalizedQuery) return [];
	const sessions = await listInteractiveSessions(cwd);
	const matches: SessionHistoryMatch[] = [];
	for (const summary of sessions) {
		let session: InteractiveSession;
		try {
			session = await loadInteractiveSession(summary.id);
		} catch {
			continue;
		}
		for (const message of session.messages) {
			const match = matchMessage(message.text, normalizedQuery);
			if (match) matches.push({ session: summary, role: message.role, ...match });
		}
	}
	return matches
		.sort((left, right) => right.score - left.score || right.session.updatedAt - left.session.updatedAt)
		.slice(0, Math.max(1, Math.min(50, limit)));
}

export async function findRecentInteractiveSession(cwd: string): Promise<InteractiveSession | undefined> {
	const sessions = await listInteractiveSessions(cwd);
	const recent = sessions.find(session => session.status === "closed" || session.status === "interrupted");
	return recent ? loadInteractiveSession(recent.id) : undefined;
}

export async function removeInteractiveSession(id: string): Promise<void> {
	await fs.rm(getSessionPath(id), { force: true });
}
