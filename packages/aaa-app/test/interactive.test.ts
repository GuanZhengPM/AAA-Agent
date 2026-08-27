import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import {
	createInteractiveSession,
	type InteractiveSession,
	type InteractiveTerminalOptions,
	parseInteractiveInput,
	resolveModelSelection,
	runInteractiveTerminal,
	TaskTerminalReporter,
} from "@aaa-agent/app";
import {
	type AdaptiveHarnessResult,
	createDefaultCapabilityProfile,
	createLongRunCheckpoint,
	createModelVariant,
	Effort,
	inferTaskFeatures,
	type Model,
	routeTask,
} from "@aaa-agent/runtime";

const tempDirectories: string[] = [];

const model: Model = {
	provider: "test",
	id: "terminal-model",
	name: "Terminal Model",
	api: "openai-chat-completions",
	baseUrl: "http://localhost/v1",
	contextWindow: 8_000,
	efforts: [Effort.Low],
	supportsThinkingOff: true,
	authChannel: "local",
};

const terraModel: Model = {
	...model,
	provider: "test-terra",
	id: "terminal-terra",
	name: "Terminal Terra",
};

const modelVariant = createModelVariant(model, {
	authChannel: "local",
	reasoningConfig: Effort.Low,
	toolSchemaVersion: "test",
});

function completedCheckpoint(task: string) {
	const profile = createDefaultCapabilityProfile(modelVariant);
	return createLongRunCheckpoint({
		task,
		variantKey: modelVariant.key,
		requirements: [],
		policySnapshot: {
			createdAt: Date.now(),
			taskSlice: "general",
			profile,
			route: routeTask(inferTaskFeatures(task), profile, {}, [], modelVariant),
		},
	});
}

function stripTerminalControls(text: string): string {
	return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function outputStream(): { stream: PassThrough; text(): string } {
	const stream = new PassThrough();
	Object.assign(stream, { isTTY: true, columns: 120 });
	let text = "";
	stream.on("data", chunk => {
		text += chunk.toString();
	});
	return { stream, text: () => text };
}

function rawInputStream(): PassThrough & { isTTY: true; isRaw: boolean; setRawMode(mode: boolean): void } {
	const stream = new PassThrough() as PassThrough & {
		isTTY: true;
		isRaw: boolean;
		setRawMode(mode: boolean): void;
	};
	stream.isTTY = true;
	stream.isRaw = false;
	stream.setRawMode = mode => {
		stream.isRaw = mode;
	};
	return stream;
}

async function waitForOutput(
	output: { stream: PassThrough; text(): string },
	predicate: (text: string) => boolean,
): Promise<void> {
	if (predicate(output.text())) return;
	await new Promise<void>(resolve => {
		const onData = () => {
			if (!predicate(output.text())) return;
			output.stream.removeListener("data", onData);
			resolve();
		};
		output.stream.on("data", onData);
	});
}

function interruptedResult(): AdaptiveHarnessResult {
	return {
		output: "ignored cancellation",
		success: false,
		lane: "direct",
		metrics: {
			startedAt: Date.now() - 1,
			completedAt: Date.now(),
			inputTokens: 1,
			outputTokens: 1,
			toolCalls: 0,
			recoveryRounds: 0,
		},
	} as AdaptiveHarnessResult;
}

function completedResult(output: string): AdaptiveHarnessResult {
	return { ...interruptedResult(), output, success: true };
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("interactive model selection", () => {
	it("accepts menu numbers, dotted numbers, full labels, names, ids, and provider-qualified ids", () => {
		const models = [model, terraModel];
		for (const selection of [
			"2",
			"2.",
			"2. Terminal Terra (test-terra/terminal-terra)",
			"model › 2. Terminal Terra (test-terra/terminal-terra)",
			"Terminal Terra",
			"terminal-terra",
			"test-terra/terminal-terra",
		]) {
			const selected = resolveModelSelection(selection, models);
			expect(`${selected.provider}/${selected.id}`).toBe("test-terra/terminal-terra");
		}
		expect(parseInteractiveInput("you › model › 2. Terminal Terra (test-terra/terminal-terra)")).toEqual({
			type: "model",
			value: "2. Terminal Terra (test-terra/terminal-terra)",
		});
	});
});

describe("interactive terminal lifecycle", () => {
	it("renders concurrent tool lifecycles as complete independent lines", () => {
		const chunks: string[] = [];
		const output = { write: (chunk: string) => chunks.push(chunk) };
		const reporter = new TaskTerminalReporter({ output, interactive: true });

		reporter.onAgentEvent({ phase: "primary", event: { type: "text_delta", delta: "partial" } });
		reporter.onAgentEvent({
			phase: "primary",
			event: { type: "tool_started", callId: "read", name: "read", arguments: { path: "a.ts" } },
		});
		reporter.onAgentEvent({
			phase: "primary",
			event: { type: "tool_started", callId: "shell", name: "shell", arguments: { command: "echo b" } },
		});
		reporter.onAgentEvent({
			phase: "primary",
			event: { type: "tool_completed", callId: "shell", name: "shell", success: true, durationMs: 2 },
		});
		reporter.onAgentEvent({
			phase: "primary",
			event: { type: "tool_completed", callId: "read", name: "read", success: true, durationMs: 3 },
		});

		expect(chunks.join("").split("\n").filter(Boolean)).toEqual([
			"assistant › partial",
			"tool › Read a.ts …",
			"tool › Shell echo b …",
			"tool › Shell echo b ✓ 2ms",
			"tool › Read a.ts ✓ 3ms",
		]);
	});

	it("selects a provider-qualified model with arrow keys and leaves no input behind", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-model-picker-"));
		tempDirectories.push(home);
		const previousHome = process.env.AAA_AGENT_HOME;
		process.env.AAA_AGENT_HOME = home;
		try {
			const input = rawInputStream();
			const output = outputStream();
			const preferences: string[] = [];
			const running = runInteractiveTerminal({
				model,
				models: [model, terraModel],
				thinkingMode: Effort.Low,
				cwd: home,
				adaptive: false,
				input,
				output: output.stream,
				runTask: async () => completedResult("unexpected task"),
				savePreferences: async selected => {
					preferences.push(`${selected.provider}/${selected.id}`);
				},
				setAdaptive: async () => {},
				saveSession: async () => {},
			});
			await waitForOutput(output, text => text.includes("you ›"));
			input.write("/model\n");
			await waitForOutput(output, text => text.includes("[↑/↓ · Enter · Esc]"));
			input.write("\u001b[B");
			await waitForOutput(output, text => text.includes("model › 2. Terminal Terra"));
			input.write("\r");
			await waitForOutput(output, text => text.includes("Using Terminal Terra"));
			input.write("/exit\n");
			await running;
			expect(preferences).toEqual(["test-terra/terminal-terra"]);
			expect(stripTerminalControls(output.text())).not.toContain("unexpected task");
			expect(input.isRaw).toBe(false);
		} finally {
			if (previousHome === undefined) delete process.env.AAA_AGENT_HOME;
			else process.env.AAA_AGENT_HOME = previousHome;
		}
	});

	it("keeps Ctrl-C recoverable and persists a task when terminal input closes", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-interactive-lifecycle-"));
		tempDirectories.push(home);
		const previousHome = process.env.AAA_AGENT_HOME;
		const previousNoColor = process.env.NO_COLOR;
		process.env.AAA_AGENT_HOME = home;
		process.env.NO_COLOR = "1";
		try {
			const runLifecycle = async (closeWithEof: boolean) => {
				const input = new PassThrough();
				Object.assign(input, { isTTY: true });
				const output = outputStream();
				const saves: InteractiveSession[] = [];
				let markStarted: (() => void) | undefined;
				const started = new Promise<void>(resolve => {
					markStarted = resolve;
				});
				const options: InteractiveTerminalOptions = {
					model,
					models: [model],
					thinkingMode: Effort.Low,
					cwd: home,
					adaptive: false,
					savePreferences: async () => {},
					setAdaptive: async () => {},
					saveSession: async session => {
						saves.push(structuredClone(session));
					},
					input,
					output: output.stream,
					runTask: async request => {
						markStarted?.();
						await new Promise<void>(resolve =>
							request.signal.addEventListener("abort", () => resolve(), { once: true }),
						);
						return interruptedResult();
					},
				};
				const running = runInteractiveTerminal(options);
				input.write("slow\n");
				await started;
				if (closeWithEof) {
					input.end();
				} else {
					input.write("\u0003");
					await waitForOutput(output, text => {
						const prompts = text.match(/you ›/g)?.length ?? 0;
						return text.includes("Current task cancelled; session remains recoverable.") && prompts === 2;
					});
					input.write("/exit\n");
				}
				await running;
				expect(saves.at(-1)).toMatchObject({ status: "interrupted", pendingTask: "slow" });
				return output.text();
			};

			const cancelledOutput = stripTerminalControls(await runLifecycle(false));
			expect(cancelledOutput).toContain("Current task cancelled; session remains recoverable.\n\nyou ›");
			await runLifecycle(true);
		} finally {
			if (previousHome === undefined) delete process.env.AAA_AGENT_HOME;
			else process.env.AAA_AGENT_HOME = previousHome;
			if (previousNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previousNoColor;
		}
	});

	it("restarts a pending task interrupted before its first checkpoint", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-interactive-early-interruption-"));
		tempDirectories.push(home);
		const previousHome = process.env.AAA_AGENT_HOME;
		process.env.AAA_AGENT_HOME = home;
		try {
			const session = createInteractiveSession(home, model, Effort.Low);
			session.status = "interrupted";
			session.pendingTask = "resume before checkpoint";
			const input = new PassThrough();
			const output = outputStream();
			const saves: InteractiveSession[] = [];
			let runTaskCalls = 0;
			const running = runInteractiveTerminal({
				model,
				models: [model],
				thinkingMode: Effort.Low,
				cwd: home,
				adaptive: false,
				session,
				input,
				output: output.stream,
				runTask: async request => {
					runTaskCalls += 1;
					expect(request.checkpoint).toBeUndefined();
					return completedResult("recovered early result");
				},
				savePreferences: async () => {},
				setAdaptive: async () => {},
				saveSession: async value => {
					saves.push(structuredClone(value));
				},
			});
			await waitForOutput(output, text => text.includes("you ›"));
			input.write("/exit\n");
			await running;
			expect(runTaskCalls).toBe(1);
			expect(output.text()).toContain("resuming › resume before checkpoint");
			expect(saves.at(-1)?.messages).toContainEqual({
				role: "assistant",
				text: "recovered early result",
			});
		} finally {
			if (previousHome === undefined) delete process.env.AAA_AGENT_HOME;
			else process.env.AAA_AGENT_HOME = previousHome;
		}
	});

	it("recovers a completed checkpoint output without rerunning side effects", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-interactive-completed-recovery-"));
		tempDirectories.push(home);
		const previousHome = process.env.AAA_AGENT_HOME;
		process.env.AAA_AGENT_HOME = home;
		try {
			const session = createInteractiveSession(home, model, Effort.Low);
			session.status = "interrupted";
			session.pendingTask = "completed before history save";
			session.longRun = completedCheckpoint(session.pendingTask);
			session.longRun.status = "completed";
			session.longRun.completedOutput = "durable completed result";
			const input = new PassThrough();
			input.write("/exit\n");
			const output = outputStream();
			const saves: InteractiveSession[] = [];
			let runTaskCalls = 0;
			await runInteractiveTerminal({
				model,
				models: [model],
				thinkingMode: Effort.Low,
				cwd: home,
				adaptive: false,
				session,
				input,
				output: output.stream,
				runTask: async () => {
					runTaskCalls += 1;
					return completedResult("duplicate side effect");
				},
				savePreferences: async () => {},
				setAdaptive: async () => {},
				saveSession: async value => {
					saves.push(structuredClone(value));
				},
			});
			expect(runTaskCalls).toBe(0);
			expect(output.text()).toContain("recovered result ›\ndurable completed result");
			expect(saves.at(-1)).toMatchObject({ status: "closed", pendingTask: undefined });
			expect(saves.at(-1)?.messages).toContainEqual({
				role: "assistant",
				text: "durable completed result",
			});
		} finally {
			if (previousHome === undefined) delete process.env.AAA_AGENT_HOME;
			else process.env.AAA_AGENT_HOME = previousHome;
		}
	});

	it("keeps independent sessions live while rejecting a second owner", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-interactive-contention-"));
		tempDirectories.push(home);
		const previousHome = process.env.AAA_AGENT_HOME;
		process.env.AAA_AGENT_HOME = home;
		try {
			const session = createInteractiveSession(home, model, Effort.Low);
			const input = new PassThrough();
			const output = outputStream();
			const baseOptions: InteractiveTerminalOptions = {
				model,
				models: [model],
				thinkingMode: Effort.Low,
				cwd: home,
				adaptive: false,
				session,
				input,
				output: output.stream,
				runTask: async () => interruptedResult(),
				savePreferences: async () => {},
				setAdaptive: async () => {},
				saveSession: async () => {},
			};
			const owner = runInteractiveTerminal(baseOptions);
			await waitForOutput(output, text => text.includes("you ›"));
			const independentSession = createInteractiveSession(path.join(home, "other"), model, Effort.Low);
			const independentInput = new PassThrough();
			const independentOutput = outputStream();
			const independentOwner = runInteractiveTerminal({
				...baseOptions,
				cwd: independentSession.cwd,
				session: independentSession,
				input: independentInput,
				output: independentOutput.stream,
			});
			await waitForOutput(independentOutput, text => text.includes("you ›"));

			await expect(
				runInteractiveTerminal({
					...baseOptions,
					session: structuredClone(session),
					input: new PassThrough(),
					output: outputStream().stream,
				}),
			).rejects.toThrow(`Session ${session.id} is already active`);

			input.write("/status\n");
			independentInput.write("/status\n");
			await Promise.all([
				waitForOutput(output, text => text.includes(`session    ${session.id} · active`)),
				waitForOutput(independentOutput, text => text.includes(`session    ${independentSession.id} · active`)),
			]);
			input.write("/exit\n");
			independentInput.write("/exit\n");
			await Promise.all([owner, independentOwner]);
		} finally {
			if (previousHome === undefined) delete process.env.AAA_AGENT_HOME;
			else process.env.AAA_AGENT_HOME = previousHome;
		}
	});
});
