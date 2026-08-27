import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireSessionLease,
	CURRENT_SESSION_VERSION,
	compactSessionMessages,
	createInteractiveSession,
	findRecentInteractiveSession,
	getSessionPath,
	getSessionsDir,
	getSessionTranscriptPath,
	listInteractiveSessions,
	loadInteractiveSession,
	saveInteractiveSession,
	searchInteractiveSessions,
} from "@aaa-agent/app";
import {
	createDefaultCapabilityProfile,
	createLongRunCheckpoint,
	createModelVariant,
	Effort,
	type Model,
	routeTask,
} from "@aaa-agent/runtime";

const tempDirectories: string[] = [];

const model: Model = {
	provider: "test",
	id: "session-model",
	name: "Session Model",
	api: "openai-chat-completions",
	baseUrl: "http://localhost/v1",
	contextWindow: 8_000,
	efforts: [Effort.Low],
	supportsThinkingOff: true,
	serviceTiers: ["priority"],
	authChannel: "local",
};

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function withSessionHome<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-agent-session-"));
	tempDirectories.push(directory);
	const previous = process.env.AAA_AGENT_HOME;
	process.env.AAA_AGENT_HOME = directory;
	try {
		return await run(directory);
	} finally {
		if (previous === undefined) delete process.env.AAA_AGENT_HOME;
		else process.env.AAA_AGENT_HOME = previous;
	}
}

describe("interactive session persistence", () => {
	it("atomically saves and lists resumable workspace sessions", async () => {
		await withSessionHome(async directory => {
			const workspace = path.join(directory, "workspace");
			const session = createInteractiveSession(workspace, model, "off", "priority");
			session.messages = [
				{ role: "user", text: "repair the lifecycle" },
				{ role: "assistant", text: "completed" },
			];
			session.contextState = {
				version: 1,
				userGoals: [{ objective: "repair the lifecycle", status: "completed", updatedAt: 10 }],
				completedGoals: ["repair the lifecycle"],
				remainingGoals: [],
				verifiedFacts: [
					{
						statement: "Lifecycle smoke check passed",
						evidence: [{ kind: "test", ref: "shell:check-1", summary: "exitCode=0" }],
						verifiedAt: 10,
					},
				],
				artifacts: [{ kind: "file", ref: "src/lifecycle.ts" }],
				openRisks: [],
				updatedAt: 10,
			};
			await saveInteractiveSession(session);

			const loaded = await loadInteractiveSession(session.id);
			expect(loaded).toMatchObject({
				id: session.id,
				cwd: path.resolve(workspace),
				modelId: "test/session-model",
				status: "closed",
				thinkingMode: "off",
				serviceTier: "priority",
			});
			expect(loaded.messages).toEqual(session.messages);
			expect(loaded.contextState).toEqual(session.contextState);
			expect(await listInteractiveSessions(workspace)).toEqual([
				expect.objectContaining({ id: session.id, turns: 1, preview: "repair the lifecycle" }),
			]);
			expect((await fs.readdir(getSessionsDir())).sort()).toEqual(
				[`${session.id}.json`, `${session.id}.transcript.jsonl`].sort(),
			);
			const metadata = await Bun.file(getSessionPath(session.id)).json();
			expect(metadata.messages).toEqual([]);
			expect((await Bun.file(getSessionTranscriptPath(session.id)).text()).trim().split("\n")).toHaveLength(2);
		});
	});

	it("searches message excerpts across sessions within one workspace", async () => {
		await withSessionHome(async directory => {
			const workspace = path.join(directory, "workspace");
			const first = createInteractiveSession(workspace, model, Effort.Low);
			first.messages = [
				{ role: "user", text: "How should token targets behave?" },
				{ role: "assistant", text: "Token targets remain soft while context is compacted." },
			];
			await saveInteractiveSession(first);
			const otherWorkspace = createInteractiveSession(path.join(directory, "other"), model, Effort.Low);
			otherWorkspace.messages = [
				{ role: "user", text: "token targets" },
				{ role: "assistant", text: "unrelated workspace" },
			];
			await saveInteractiveSession(otherWorkspace);

			const matches = await searchInteractiveSessions("token targets", workspace);
			expect(matches.map(match => match.session.id)).toEqual([first.id, first.id]);
			const assistantMatch = matches.find(match => match.role === "assistant");
			expect(assistantMatch).toMatchObject({
				session: { id: first.id, cwd: path.resolve(workspace) },
			});
			expect(assistantMatch?.excerpt).toContain("Token targets remain soft");
		});
	});

	it("recovers an unfinished persisted turn as interrupted without inventing output", async () => {
		await withSessionHome(async directory => {
			const session = createInteractiveSession(directory, model, Effort.Low);
			session.status = "running";
			session.pendingTask = "finish the interrupted change";
			session.messages = [
				{ role: "user", text: "previous task" },
				{ role: "assistant", text: "previous result" },
			];
			await saveInteractiveSession(session);

			const recovered = await loadInteractiveSession(session.id);
			expect(recovered.status).toBe("interrupted");
			expect(recovered.pendingTask).toBe("finish the interrupted change");
			expect(recovered.messages).toEqual(session.messages);
		});
	});

	it("compacts history by complete exchanges and returns defensive copies", () => {
		const messages = Array.from({ length: 42 }, (_, index) => ({
			role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
			text: `message-${index}`,
		}));
		const compacted = compactSessionMessages(messages);
		expect(compacted).toHaveLength(40);
		expect(compacted[0]?.text).toBe("message-2");
		compacted[0]!.text = "mutated";
		expect(messages[2]?.text).toBe("message-2");
	});

	it("does not auto-resume a session owned by a live process", async () => {
		await withSessionHome(async directory => {
			const session = createInteractiveSession(directory, model, Effort.Low);
			session.status = "active";
			session.ownerPid = process.pid;
			await saveInteractiveSession(session);

			expect((await loadInteractiveSession(session.id)).status).toBe("active");
			expect(await findRecentInteractiveSession(directory)).toBeUndefined();
		});
	});

	it("grants exactly one exclusive process lease per session", async () => {
		await withSessionHome(async directory => {
			const session = createInteractiveSession(directory, model, Effort.Low);
			const first = await acquireSessionLease(session.id);
			await expect(acquireSessionLease(session.id)).rejects.toThrow(`Session ${session.id} is already active`);
			await first.release();
			const second = await acquireSessionLease(session.id);
			await second.release();
		});
	});

	it("grants one lease when two processes race for the same session", async () => {
		await withSessionHome(async directory => {
			const session = createInteractiveSession(directory, model, Effort.Low);
			const sessionStoreUrl = new URL("../src/session-store.ts", import.meta.url).href;
			const contenders = Array.from({ length: 2 }, () => {
				const source = `
						import { acquireSessionLease } from ${JSON.stringify(sessionStoreUrl)};
						const input = Bun.stdin.stream().getReader();
						await input.read();
						try {
							const lease = await acquireSessionLease(${JSON.stringify(session.id)});
							console.log("acquired");
							await input.read();
							await lease.release();
						} catch (error) {
							console.log(\`rejected:\${error instanceof Error ? error.message : String(error)}\`);
						}
					`;
				return Bun.spawn([process.execPath, "-e", source], {
					cwd: process.cwd(),
					env: { ...process.env, AAA_AGENT_HOME: directory },
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				});
			});
			const outputs = contenders.map(async contender => {
				const { value } = await contender.stdout.getReader().read();
				if (!value) throw new Error("Lease contender exited without reporting a result.");
				return new TextDecoder().decode(value).trim();
			});
			try {
				for (const contender of contenders) {
					contender.stdin.write("start\n");
					await contender.stdin.flush();
				}
				const results = await Promise.all(outputs);
				expect(results.filter(result => result === "acquired")).toHaveLength(1);
				expect(results.filter(result => result.includes("already active"))).toHaveLength(1);
			} finally {
				for (const contender of contenders) {
					contender.stdin.end();
				}
				await Promise.all(contenders.map(contender => contender.exited));
			}
		});
	});

	it("recovers one stale lease without allowing concurrent reclaimers to become owners", async () => {
		await withSessionHome(async directory => {
			const session = createInteractiveSession(directory, model, Effort.Low);
			const lockPath = `${getSessionPath(session.id)}.lock`;
			await fs.mkdir(getSessionsDir(), { recursive: true });
			await Bun.write(
				lockPath,
				JSON.stringify({ pid: 2_147_483_647, acquiredAt: Date.now() - 60_000, token: "stale-owner" }),
			);

			const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => acquireSessionLease(session.id)));
			const owners = attempts.flatMap(attempt => (attempt.status === "fulfilled" ? [attempt.value] : []));
			expect(owners).toHaveLength(1);
			expect(
				attempts.filter(
					attempt => attempt.status === "rejected" && String(attempt.reason).includes("already active"),
				),
			).toHaveLength(11);
			await owners[0]!.release();
		});
	});

	it("saves independent sessions while search ignores corrupt files and observes only complete JSON", async () => {
		await withSessionHome(async directory => {
			const workspace = path.join(directory, "workspace");
			const otherWorkspace = path.join(directory, "other-workspace");
			const sessions = Array.from({ length: 125 }, (_, index) => {
				const session = createInteractiveSession(index % 5 === 0 ? otherWorkspace : workspace, model, Effort.Low);
				session.messages = [
					{ role: "user", text: `concurrent persistence needle ${index}` },
					{ role: "assistant", text: `saved response ${index}` },
				];
				return session;
			});
			await fs.mkdir(getSessionsDir(), { recursive: true });
			await Bun.write(path.join(getSessionsDir(), "truncated.json"), '{"version":4,"id":');
			await Bun.write(path.join(getSessionsDir(), "malformed.json"), "not json");

			const saves = sessions.map(session => saveInteractiveSession(session));
			const searches = Array.from({ length: 20 }, () =>
				searchInteractiveSessions("concurrent persistence needle", workspace, 50),
			);
			const observedSearches = await Promise.all(searches);
			await Promise.all(saves);

			for (const matches of observedSearches) {
				expect(matches.every(match => match.session.cwd === path.resolve(workspace))).toBe(true);
			}
			const listed = await listInteractiveSessions(workspace);
			expect(listed).toHaveLength(100);
			expect(listed.every(summary => summary.cwd === path.resolve(workspace))).toBe(true);
			const matches = await searchInteractiveSessions("concurrent persistence needle", workspace, 50);
			expect(matches).toHaveLength(50);
			expect(matches.every(match => match.session.cwd === path.resolve(workspace))).toBe(true);
		});
	});

	it("never exposes partial JSON while a session is repeatedly replaced", async () => {
		await withSessionHome(async directory => {
			const session = createInteractiveSession(directory, model, Effort.Low);
			session.messages = [{ role: "user", text: "initial" }];
			await saveInteractiveSession(session);

			let writing = true;
			const observations: unknown[] = [];
			const reader = (async () => {
				while (writing) {
					observations.push(await Bun.file(getSessionPath(session.id)).json());
				}
			})();
			for (let index = 0; index < 30; index += 1) {
				session.messages = [{ role: "user", text: `${index}:`.padEnd(40_000, String(index % 10)) }];
				await saveInteractiveSession(session);
			}
			writing = false;
			await reader;

			expect(observations.length).toBeGreaterThan(0);
			expect(
				observations.every(
					value =>
						typeof value === "object" &&
						value !== null &&
						"id" in value &&
						value.id === session.id &&
						"messages" in value &&
						Array.isArray(value.messages),
				),
			).toBe(true);
		});
	});

	it("migrates version-one idle sessions to the closed resumable state", async () => {
		await withSessionHome(async directory => {
			const session = createInteractiveSession(directory, model, Effort.Low);
			await fs.mkdir(getSessionsDir(), { recursive: true });
			await Bun.write(getSessionPath(session.id), JSON.stringify({ ...session, version: 1, status: "idle" }));

			const migrated = await loadInteractiveSession(session.id);
			expect(migrated.version).toBe(CURRENT_SESSION_VERSION);
			expect(migrated.status).toBe("closed");
		});
	});

	it("migrates legacy effort fields without losing the selected mode", async () => {
		await withSessionHome(async directory => {
			const session = createInteractiveSession(directory, model, Effort.Low);
			await fs.mkdir(getSessionsDir(), { recursive: true });
			await Bun.write(
				getSessionPath(session.id),
				JSON.stringify({ ...session, version: 3, thinkingMode: undefined, effort: Effort.Low }),
			);

			const migrated = await loadInteractiveSession(session.id);
			expect(migrated.version).toBe(CURRENT_SESSION_VERSION);
			expect(migrated.thinkingMode).toBe(Effort.Low);
		});
	});
});

it("persists the external long-run checkpoint with the interactive session", async () => {
	await withSessionHome(async directory => {
		const session = createInteractiveSession(directory, model, Effort.Low);
		const variant = createModelVariant(model, {
			authChannel: "local",
			reasoningConfig: Effort.Low,
			toolSchemaVersion: "1",
		});
		const profile = createDefaultCapabilityProfile(variant, {}, "coding");
		const route = routeTask(
			{
				estimatedSteps: 3,
				estimatedFiles: 2,
				independentBranches: 1,
				contextTokens: 0,
				writesWorkspace: true,
				destructiveRisk: 0.1,
				requiresVerification: true,
				requiresGoalDag: false,
				userRequestedPlan: false,
				userRequestedParallel: false,
			},
			profile,
			{},
			[],
			variant,
		);
		session.pendingTask = "Implement the persisted change";
		session.longRun = createLongRunCheckpoint({
			task: session.pendingTask,
			variantKey: variant.key,
			requirements: [
				{
					id: "root",
					objective: session.pendingTask,
					status: "active",
					dependencies: [],
					owner: "primary",
					criteria: [{ id: "result", description: "Delivered", required: true, evidence: [] }],
				},
			],
			policySnapshot: { createdAt: Date.now(), taskSlice: "coding", profile, route },
		});
		session.longRun.currentRound = 1;
		session.longRun.status = "interrupted";
		await saveInteractiveSession(session);
		const loaded = await loadInteractiveSession(session.id);
		expect(loaded.longRun).toEqual(session.longRun);
		expect(loaded.pendingTask).toBe(session.pendingTask);
	});
});
