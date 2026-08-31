import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ConversationHistory,
	formatRunReport,
	parseInteractiveInput,
	runAdaptiveTask,
	summarizeRuns,
} from "@aaa-agent/app";
import {
	buildAuthorizationUrl,
	CodexAuthSession,
	createAdaptiveModelVariant,
	createAgentTurnProvider,
	createCodexHeaders,
	createCodexProvider,
	createOpenAICompatibleProvider,
	createResponsesRequestBody,
	listBuiltInModels,
	resolveModel,
} from "@aaa-agent/providers";
import {
	type AdaptiveGoalNode,
	AdaptiveGoalStore,
	AdaptiveHarness,
	AdaptiveOverlayRegistry,
	type AgentSessionEvent,
	type AgentTool,
	type AgentTurnProvider,
	BoundedSubagentScheduler,
	calculateHarnessTax,
	createAuditReport,
	createDefaultCapabilityProfile,
	createEmptyUsageMetrics,
	createLongRunCheckpoint,
	createModelVariant,
	deriveCapabilityObservation,
	Effort,
	evaluateHarnessCandidate,
	type HarnessCandidate,
	type HarnessRunMetrics,
	type HarnessRunRecord,
	indexCapabilityProfilesByModel,
	inferTaskFeatures,
	inferTaskSlice,
	type LongRunCheckpoint,
	type Model,
	ModelCapabilityRegistry,
	mergeVerifiedFacts,
	parseModelVariantKey,
	resetProviderConcurrencyGates,
	routeTask,
	runAgentSession,
	type SubagentResult,
	updateStructuredContextState,
} from "@aaa-agent/runtime";
import { createAdaptiveToolset, createShellInvocation } from "@aaa-agent/workspace";
import { z } from "zod/v4";
import { TaskTerminalReporter } from "../src/terminal";

const variant = createModelVariant(
	{
		provider: "openai-codex",
		id: "gpt-5.6-sol",
		api: "codex-responses",
		baseUrl: "https://chatgpt.com/backend-api/",
		efforts: [Effort.High],
	},
	{ authChannel: "subscription", reasoningConfig: "high", toolSchemaVersion: "1" },
);

const tempDirectories: string[] = [];
const testServers: Bun.Server<unknown>[] = [];

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
	for (const server of testServers.splice(0)) server.stop(true);
});

function toolNamed(tools: readonly AgentTool[], name: string): AgentTool {
	const tool = tools.find(candidate => candidate.name === name);
	if (!tool) throw new Error(`Missing tool ${name}`);
	return tool;
}

describe("independent Codex identity", () => {
	it("builds an OpenAI OAuth URL under the harness identity", () => {
		const url = new URL(buildAuthorizationUrl({ state: "state", codeChallenge: "challenge" }));
		expect(url.origin).toBe("https://auth.openai.com");
		expect(url.pathname).toBe("/oauth/authorize");
		expect(url.searchParams.get("originator")).toBe("aaa_agent");
		expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	});

	it("sends standalone request identity headers", () => {
		const headers = createCodexHeaders("token", "account", "session");
		expect(headers.get("originator")).toBe("aaa_agent");
		expect(headers.get("user-agent")).toBe("aaa-agent/0.4.0");
		expect(headers.get("chatgpt-account-id")).toBe("account");
		expect(headers.get("authorization")).toBe("Bearer token");
	});

	it("runs a complete function-call turn through its own HTTP loop", async () => {
		const requests: Array<{ body: unknown; originator: string | null }> = [];
		let requestCount = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				requestCount += 1;
				requests.push({ body: await request.json(), originator: request.headers.get("originator") });
				const output =
					requestCount === 1
						? [{ type: "function_call", call_id: "call-1", name: "echo", arguments: '{"value":"hello"}' }]
						: [
								{
									type: "message",
									role: "assistant",
									content: [{ type: "output_text", text: "completed" }],
								},
							];
				const itemDone = {
					type: "response.output_item.done",
					item: output[0],
				};
				const completed = {
					type: "response.completed",
					response: {
						output: [],
						usage: { input_tokens: 10, output_tokens: 2, output_tokens_details: { reasoning_tokens: 1 } },
					},
				};
				return new Response(`data: ${JSON.stringify(itemDone)}\n\ndata: ${JSON.stringify(completed)}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		testServers.push(server);
		const model: Model = {
			provider: "openai-codex",
			id: "gpt-5.6-sol",
			name: "test",
			api: "codex-responses",
			baseUrl: server.url.toString().replace(/\/$/, ""),
			contextWindow: 10_000,
			efforts: [Effort.Low],
		};
		let toolExecutions = 0;
		const echoSchema = z.object({ value: z.string() });
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo a value.",
			parameters: echoSchema,
			async execute(_id, rawParams) {
				toolExecutions += 1;
				const params = echoSchema.parse(rawParams);
				return { content: [{ type: "text", text: `echo:${params.value}` }] };
			},
		};
		const events: AgentSessionEvent[] = [];
		const session = await runAgentSession({
			model,
			provider: createCodexProvider(
				new CodexAuthSession({
					accessToken: "token",
					refreshToken: "refresh",
					expiresAt: Date.now() + 120_000,
					accountId: "account",
				}),
			),
			cwd: process.cwd(),
			systemPrompt: "system",
			userPrompt: "use echo",
			history: [
				{ role: "user", text: "remember alpha" },
				{ role: "assistant", text: "alpha remembered" },
			],
			tools: [echo],
			policy: { reasoningEffort: Effort.Low, toolBudget: 2, maxTurns: 3 },
			signal: AbortSignal.timeout(5_000),
			onEvent: event => events.push(event),
		});
		expect(session.success).toBe(true);
		expect(session.output).toBe("completed");
		expect(session.usage.toolCalls).toBe(1);
		expect(session.usage.outputTokens).toBe(2);
		expect(session.usage.reasoningTokens).toBe(2);
		expect(toolExecutions).toBe(1);
		expect(requests.map(request => request.originator)).toEqual(["aaa_agent", "aaa_agent"]);
		const firstBody = requests[0]?.body as {
			input?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
		};
		expect(firstBody.input?.map(item => item.role)).toEqual(["user", "assistant", "user"]);
		expect(firstBody.input?.[1]?.content?.[0]).toEqual({ type: "output_text", text: "alpha remembered" });
		expect(events.some(event => event.type === "tool_started" && event.name === "echo")).toBe(true);
		expect(events.some(event => event.type === "tool_completed" && event.success)).toBe(true);
		const secondBody = requests[1]?.body as { input?: Array<{ type?: string; output?: string }> };
		expect(secondBody.input?.find(item => item.type === "function_call_output")?.output).toBe("echo:hello");
	});

	it("serializes provider requests globally for rate-sensitive GLM sessions", async () => {
		resetProviderConcurrencyGates();
		let active = 0;
		let peak = 0;
		const provider: AgentTurnProvider = {
			provider: "z-ai-test",
			identity: "shared-account",
			async runTurn() {
				active += 1;
				peak = Math.max(peak, active);
				await Bun.sleep(25);
				active -= 1;
				return { output: [], text: "done", toolCalls: [], usage: createEmptyUsageMetrics() };
			},
		};
		const model: Model = {
			provider: "z-ai",
			id: "glm-test",
			name: "GLM Test",
			api: "openai-chat-completions",
			baseUrl: "http://127.0.0.1",
			contextWindow: 8_000,
			efforts: [Effort.Low],
			family: "glm",
		};
		const results = await Promise.all(
			Array.from({ length: 3 }, (_, index) =>
				runAgentSession({
					model,
					provider,
					cwd: process.cwd(),
					systemPrompt: "system",
					userPrompt: `task ${index}`,
					tools: [],
					policy: { reasoningEffort: Effort.Low, toolBudget: 0, maxTurns: 1 },
					signal: AbortSignal.timeout(5_000),
				}),
			),
		);
		expect(results.every(result => result.success)).toBe(true);
		expect(peak).toBe(1);
		expect(results.some(result => (result.diagnostics.providerWaitMs ?? 0) > 10)).toBe(true);
		resetProviderConcurrencyGates();
	});

	it("runs independent read-only tool calls concurrently and preserves result order", async () => {
		let turn = 0;
		let active = 0;
		let peak = 0;
		const provider: AgentTurnProvider = {
			provider: "parallel-tools-test",
			async runTurn(options) {
				turn += 1;
				if (turn === 1) {
					const toolCalls = ["a", "b"].map(id => ({
						callId: id,
						name: "inspect",
						arguments: JSON.stringify({ id }),
					}));
					return {
						output: toolCalls.map(call => ({
							type: "function_call",
							call_id: call.callId,
							name: call.name,
							arguments: call.arguments,
						})),
						text: "",
						toolCalls,
						usage: createEmptyUsageMetrics(),
					};
				}
				const outputs = options.input
					.filter(item => item.type === "function_call_output")
					.map(item => String(item.output));
				expect(outputs).toEqual(["result-a", "result-b"]);
				return { output: [], text: "done", toolCalls: [], usage: createEmptyUsageMetrics() };
			},
		};
		const started = performance.now();
		const session = await runAgentSession({
			model: {
				provider: "test",
				id: "parallel-tools",
				name: "Parallel Tools",
				api: "openai-chat-completions",
				baseUrl: "http://127.0.0.1",
				contextWindow: 8_000,
				efforts: [Effort.Low],
			},
			provider,
			cwd: process.cwd(),
			systemPrompt: "system",
			userPrompt: "inspect both",
			tools: [
				{
					name: "inspect",
					label: "Inspect",
					description: "Read one independent item.",
					parameters: z.object({ id: z.string() }),
					sideEffect: "none",
					async execute(_callId, raw) {
						const id = z.object({ id: z.string() }).parse(raw).id;
						active += 1;
						peak = Math.max(peak, active);
						await Bun.sleep(80);
						active -= 1;
						return { content: [{ type: "text", text: `result-${id}` }] };
					},
				},
			],
			policy: { reasoningEffort: Effort.Low, toolBudget: 2, maxTurns: 2 },
			signal: AbortSignal.timeout(5_000),
		});
		expect(session.success).toBe(true);
		expect(peak).toBe(2);
		expect(performance.now() - started).toBeLessThan(145);
	});

	it("feeds a rejected host completion back into the same tool loop", async () => {
		let turn = 0;
		let gateCalls = 0;
		const seenInputs: string[] = [];
		const provider: AgentTurnProvider = {
			provider: "gate-test",
			async runTurn(options) {
				turn += 1;
				seenInputs.push(JSON.stringify(options.input));
				if (turn === 1) return { output: [], text: "finished", toolCalls: [], usage: createEmptyUsageMetrics() };
				if (turn === 2) {
					const call = { callId: "repair", name: "repair", arguments: "{}" };
					return {
						output: [{ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments }],
						text: "",
						toolCalls: [call],
						usage: createEmptyUsageMetrics(),
					};
				}
				return { output: [], text: "verified finish", toolCalls: [], usage: createEmptyUsageMetrics() };
			},
		};
		let repaired = false;
		const session = await runAgentSession({
			model: {
				provider: "test",
				id: "gate",
				name: "Gate",
				api: "openai-chat-completions",
				baseUrl: "http://127.0.0.1",
				contextWindow: 8_000,
				efforts: [Effort.Low],
			},
			provider,
			cwd: process.cwd(),
			systemPrompt: "system",
			userPrompt: "repair",
			tools: [
				{
					name: "repair",
					label: "Repair",
					description: "Repair.",
					parameters: z.object({}),
					sideEffect: "workspace",
					async execute() {
						repaired = true;
						return { content: [{ type: "text", text: "repaired" }] };
					},
				},
			],
			policy: { reasoningEffort: Effort.Low, toolBudget: 1, maxTurns: 2 },
			beforeFinalize: async () => {
				gateCalls += 1;
				return repaired
					? { accepted: true }
					: { accepted: false, feedback: "acceptance failed: expected repaired state" };
			},
			signal: AbortSignal.timeout(5_000),
		});
		expect(session.success).toBe(true);
		expect(turn).toBe(3);
		expect(gateCalls).toBe(2);
		expect(seenInputs[1]).toContain("host-completion-gate");
		expect(session.diagnostics.turns).toBe(3);
	});

	it("continues to a final answer despite high cumulative billed usage", async () => {
		let turn = 0;
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn() {
				turn += 1;
				const output =
					turn === 1
						? [{ type: "function_call", call_id: "inspect-1", name: "inspect", arguments: "{}" }]
						: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "final answer" }] }];
				return {
					output,
					text: turn === 1 ? "" : "final answer",
					toolCalls: turn === 1 ? [{ callId: "inspect-1", name: "inspect", arguments: "{}" }] : [],
					usage: { ...createEmptyUsageMetrics(), inputTokens: turn === 1 ? 40_000 : 80_000 },
				};
			},
		};
		const model: Model = {
			provider: "test",
			id: "budget-test",
			name: "Budget Test",
			api: "openai-chat-completions",
			baseUrl: "http://127.0.0.1",
			contextWindow: 8_000,
			efforts: [Effort.Low],
		};
		const inspect: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Inspect the fixture.",
			parameters: z.object({}),
			async execute() {
				return { content: [{ type: "text", text: "evidence" }] };
			},
		};
		const events: AgentSessionEvent[] = [];
		const session = await runAgentSession({
			model,
			provider,
			cwd: process.cwd(),
			systemPrompt: "system",
			userPrompt: "inspect then answer",
			tools: [inspect],
			policy: { reasoningEffort: Effort.Low, toolBudget: 1, maxTurns: 2 },
			signal: AbortSignal.timeout(5_000),
			onEvent: event => events.push(event),
		});
		expect(session.success).toBe(true);
		expect(session.output).toBe("final answer");
		expect(session.usage.inputTokens).toBe(120_000);
		expect(session.diagnostics.policyEscalations).toBe(0);
		expect(events.some(event => event.type === "policy_escalated")).toBe(false);
	});

	it("reserves a tool-free finalization turn after the execution limit", async () => {
		let turn = 0;
		let executions = 0;
		const availableToolCounts: number[] = [];
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn(options) {
				turn += 1;
				availableToolCounts.push(options.tools.length);
				if (turn === 1) {
					return {
						output: [{ type: "function_call", call_id: "last-tool", name: "inspect", arguments: "{}" }],
						text: "",
						toolCalls: [{ callId: "last-tool", name: "inspect", arguments: "{}" }],
						usage: createEmptyUsageMetrics(),
					};
				}
				return {
					output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "finalized" }] }],
					text: "finalized",
					toolCalls: [],
					usage: createEmptyUsageMetrics(),
				};
			},
		};
		const inspect: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Inspect.",
			parameters: z.object({}),
			async execute() {
				executions += 1;
				return { content: [{ type: "text", text: "last evidence" }] };
			},
		};
		const session = await runAgentSession({
			model: {
				provider: "test",
				id: "finalization-turn",
				name: "Finalization Turn",
				api: "openai-chat-completions",
				baseUrl: "http://127.0.0.1",
				contextWindow: 8_000,
				efforts: [Effort.Low],
			},
			provider,
			cwd: process.cwd(),
			systemPrompt: "system",
			userPrompt: "inspect then answer",
			tools: [inspect],
			policy: { reasoningEffort: Effort.Low, toolBudget: 1, maxTurns: 1 },
			signal: AbortSignal.timeout(5_000),
		});
		expect(session.success).toBe(true);
		expect(session.output).toBe("finalized");
		expect(executions).toBe(1);
		expect(availableToolCounts).toEqual([1, 0]);
	});

	it("compacts oversized evidence for a small-context model and favors the newest result", async () => {
		let turn = 0;
		let executions = 0;
		const inputSizes: number[] = [];
		const toolOutputSizes: number[][] = [];
		const events: AgentSessionEvent[] = [];
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn(options) {
				turn += 1;
				inputSizes.push(JSON.stringify(options.input).length);
				toolOutputSizes.push(
					options.input
						.filter(
							(item): item is Record<string, unknown> & { output: string } =>
								item.type === "function_call_output" && typeof item.output === "string",
						)
						.map(item => item.output.length),
				);
				if (turn <= 8) {
					const callId = `read-${turn}`;
					const argumentsValue = JSON.stringify({ chunk: turn });
					return {
						output: [{ type: "function_call", call_id: callId, name: "read_large", arguments: argumentsValue }],
						text: "",
						toolCalls: [{ callId, name: "read_large", arguments: argumentsValue }],
						usage: { ...createEmptyUsageMetrics(), inputTokens: 40 },
					};
				}
				return {
					output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "summary" }] }],
					text: "summary",
					toolCalls: [],
					usage: { ...createEmptyUsageMetrics(), inputTokens: 10 },
				};
			},
		};
		const readLarge: AgentTool = {
			name: "read_large",
			label: "Read large",
			description: "Return a large document excerpt.",
			parameters: z.object({}),
			async execute() {
				executions += 1;
				return { content: [{ type: "text", text: `${String(executions)}${"x".repeat(30_000)}` }] };
			},
		};
		const session = await runAgentSession({
			model: {
				provider: "test",
				id: "context-management",
				name: "Context Management",
				api: "openai-chat-completions",
				baseUrl: "http://127.0.0.1",
				contextWindow: 8_000,
				efforts: [Effort.Low],
			},
			provider,
			cwd: process.cwd(),
			systemPrompt: "system",
			userPrompt: "summarize the document",
			tools: [readLarge],
			policy: { reasoningEffort: Effort.Low, toolBudget: 8, maxTurns: 9 },
			signal: AbortSignal.timeout(5_000),
			onEvent: event => events.push(event),
		});
		expect(session.success).toBe(true);
		expect(session.output).toBe("summary");
		expect(executions).toBe(8);
		expect(Math.max(...inputSizes.slice(1))).toBeLessThan(21_000);
		expect(events.some(event => event.type === "context_compacted")).toBe(true);
		const finalToolOutputs = toolOutputSizes.at(-1) ?? [];
		expect(finalToolOutputs).toHaveLength(8);
		expect(finalToolOutputs.at(-1)).toBeGreaterThan(
			Math.max(...finalToolOutputs.slice(0, -1), Number.NEGATIVE_INFINITY),
		);
		expect(events.some(event => event.type === "policy_escalated")).toBe(false);
	});

	it("compacts large evidence economically while keeping exact range retrieval", async () => {
		let turn = 0;
		let replayedOutput = "";
		let availableTools: string[] = [];
		const events: AgentSessionEvent[] = [];
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn(options) {
				turn += 1;
				if (turn === 1) {
					return {
						output: [{ type: "function_call", call_id: "read-1", name: "read_large", arguments: "{}" }],
						text: "",
						toolCalls: [{ callId: "read-1", name: "read_large", arguments: "{}" }],
						usage: createEmptyUsageMetrics(),
					};
				}
				replayedOutput =
					(options.input.find(item => item.type === "function_call_output")?.output as string | undefined) ?? "";
				availableTools = options.tools.map(tool => tool.name);
				return {
					output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "summary" }] }],
					text: "summary",
					toolCalls: [],
					usage: createEmptyUsageMetrics(),
				};
			},
		};
		const readLarge: AgentTool = {
			name: "read_large",
			label: "Read large",
			description: "Return a large document excerpt.",
			parameters: z.object({}),
			async execute() {
				return { content: [{ type: "text", text: `evidence:${"x".repeat(120_000)}` }] };
			},
		};
		const session = await runAgentSession({
			model: {
				provider: "test",
				id: "large-context-management",
				name: "Large Context Management",
				api: "openai-chat-completions",
				baseUrl: "http://127.0.0.1",
				contextWindow: 258_000,
				efforts: [Effort.Low],
			},
			provider,
			cwd: process.cwd(),
			systemPrompt: "system",
			userPrompt: "summarize the document",
			tools: [readLarge],
			policy: { reasoningEffort: Effort.Low, toolBudget: 1, maxTurns: 2 },
			signal: AbortSignal.timeout(5_000),
			onEvent: event => events.push(event),
		});
		expect(session.success).toBe(true);
		expect(replayedOutput.length).toBeGreaterThan(8_000);
		expect(replayedOutput.length).toBeLessThan(60_000);
		expect(replayedOutput).toContain("full tool output cached");
		expect(availableTools).toContain("tool_output_read");
		expect(events.some(event => event.type === "context_compacted")).toBe(false);
	});

	it("retrieves exact ranges from compacted tool outputs", async () => {
		let turn = 0;
		let recovered = "";
		const original = `${"a".repeat(50_000)}EXACT-NEEDLE${"b".repeat(50_000)}`;
		const provider: AgentTurnProvider = {
			provider: "tool-output-cache-test",
			async runTurn(options) {
				turn += 1;
				if (turn === 1) {
					const call = { callId: "large-call", name: "large", arguments: "{}" };
					return {
						output: [{ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments }],
						text: "",
						toolCalls: [call],
						usage: createEmptyUsageMetrics(),
					};
				}
				if (turn === 2) {
					const compacted = String(options.input.find(item => item.type === "function_call_output")?.output ?? "");
					expect(compacted).toContain("full tool output cached");
					expect(options.tools.map(tool => tool.name)).toContain("tool_output_read");
					const call = {
						callId: "range-call",
						name: "tool_output_read",
						arguments: JSON.stringify({ callId: "large-call", offset: 49_990, limit: 40 }),
					};
					return {
						output: [{ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments }],
						text: "",
						toolCalls: [call],
						usage: createEmptyUsageMetrics(),
					};
				}
				recovered = String(options.input.filter(item => item.type === "function_call_output").at(-1)?.output ?? "");
				return { output: [], text: "done", toolCalls: [], usage: createEmptyUsageMetrics() };
			},
		};
		const session = await runAgentSession({
			model: {
				provider: "test",
				id: "output-cache",
				name: "Output Cache",
				api: "openai-chat-completions",
				baseUrl: "http://127.0.0.1",
				contextWindow: 8_000,
				efforts: [Effort.Low],
			},
			provider,
			cwd: process.cwd(),
			systemPrompt: "system",
			userPrompt: "find the exact needle",
			tools: [
				{
					name: "large",
					label: "Large",
					description: "Large output.",
					parameters: z.object({}),
					sideEffect: "none",
					async execute() {
						return { content: [{ type: "text", text: original }] };
					},
				},
			],
			policy: { reasoningEffort: Effort.Low, toolBudget: 2, maxTurns: 3 },
			signal: AbortSignal.timeout(5_000),
		});
		expect(session.success).toBe(true);
		expect(recovered).toContain("EXACT-NEEDLE");
	});

	it("treats the tool budget as a target without blocking useful calls", async () => {
		let turn = 0;
		let executions = 0;
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn() {
				turn += 1;
				if (turn <= 2) {
					const callId = `inspect-${turn}`;
					return {
						output: [{ type: "function_call", call_id: callId, name: "inspect", arguments: "{}" }],
						text: "",
						toolCalls: [{ callId, name: "inspect", arguments: "{}" }],
						usage: { ...createEmptyUsageMetrics(), inputTokens: 5 },
					};
				}
				return {
					output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
					text: "done",
					toolCalls: [],
					usage: { ...createEmptyUsageMetrics(), inputTokens: 5 },
				};
			},
		};
		const events: AgentSessionEvent[] = [];
		const inspect: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Inspect.",
			parameters: z.object({}),
			async execute() {
				executions += 1;
				return { content: [{ type: "text", text: `evidence-${executions}` }] };
			},
		};
		const session = await runAgentSession({
			model: {
				provider: "test",
				id: "tool-target",
				name: "Tool Target",
				api: "openai-chat-completions",
				baseUrl: "http://127.0.0.1",
				contextWindow: 8_000,
				efforts: [Effort.Low],
			},
			provider,
			cwd: process.cwd(),
			systemPrompt: "system",
			userPrompt: "inspect twice",
			tools: [inspect],
			policy: { reasoningEffort: Effort.Low, toolBudget: 1, maxTurns: 3 },
			signal: AbortSignal.timeout(5_000),
			onEvent: event => events.push(event),
		});
		expect(session.success).toBe(true);
		expect(executions).toBe(2);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "policy_escalated", reason: "tool-call target 1 exceeded" }),
		);
	});

	it("never executes tools beyond the hard tool-call ceiling", async () => {
		let turn = 0;
		let executions = 0;
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn() {
				turn += 1;
				if (turn === 1) {
					const toolCalls = Array.from({ length: 3 }, (_, index) => ({
						callId: `inspect-${index}`,
						name: "inspect",
						arguments: "{}",
					}));
					return {
						output: toolCalls.map(call => ({ type: "function_call" as const, call_id: call.callId, ...call })),
						text: "",
						toolCalls,
						usage: createEmptyUsageMetrics(),
					};
				}
				return {
					output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
					text: "done",
					toolCalls: [],
					usage: createEmptyUsageMetrics(),
				};
			},
		};
		const inspect: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Inspect.",
			parameters: z.object({}),
			async execute() {
				executions += 1;
				return { content: [{ type: "text", text: "evidence" }] };
			},
		};
		const session = await runAgentSession({
			model: {
				provider: "test",
				id: "hard-tool-limit",
				name: "Hard Tool Limit",
				api: "openai-chat-completions",
				baseUrl: "http://127.0.0.1",
				contextWindow: 8_000,
				efforts: [Effort.Low],
			},
			provider,
			cwd: process.cwd(),
			systemPrompt: "system",
			userPrompt: "inspect three times",
			tools: [inspect],
			policy: { reasoningEffort: Effort.Low, toolBudget: 1, maxToolCalls: 2, maxTurns: 2 },
			signal: AbortSignal.timeout(5_000),
		});
		expect(session.success).toBe(true);
		expect(executions).toBe(2);
		expect(session.diagnostics.successfulToolCalls).toBe(2);
		expect(session.diagnostics.toolExecutionFailures).toBe(1);
	});

	it("bounds provider output and fails closed when reported token usage exceeds the hard ceiling", async () => {
		const outputLimits: Array<number | undefined> = [];
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn(options) {
				outputLimits.push(options.maxOutputTokens);
				return {
					output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
					text: "done",
					toolCalls: [],
					usage: { ...createEmptyUsageMetrics(), inputTokens: 101 },
				};
			},
		};
		const session = await runAgentSession({
			model: {
				provider: "test",
				id: "hard-token-limit",
				name: "Hard Token Limit",
				api: "openai-chat-completions",
				baseUrl: "http://127.0.0.1",
				contextWindow: 8_000,
				efforts: [Effort.Low],
			},
			provider,
			cwd: process.cwd(),
			systemPrompt: "system",
			userPrompt: "answer",
			tools: [],
			policy: { reasoningEffort: Effort.Low, toolBudget: 0, maxTotalTokens: 100, maxTurns: 1 },
			signal: AbortSignal.timeout(5_000),
		});
		expect(outputLimits).toHaveLength(1);
		expect(session.success).toBe(false);
		expect(outputLimits[0]).toBeGreaterThan(0);
		expect(outputLimits[0]).toBeLessThan(100);
		expect(session.error).toBe("Token limit 100 exceeded by provider usage.");
	});

	it("tracks possible shell mutation even when the command exits nonzero", async () => {
		let turn = 0;
		const provider: AgentTurnProvider = {
			provider: "failed-shell-mutation",
			async runTurn() {
				turn += 1;
				if (turn === 1) {
					const call = { callId: "partial-write", name: "shell", arguments: "{}" };
					return {
						output: [{ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments }],
						text: "",
						toolCalls: [call],
						usage: createEmptyUsageMetrics(),
					};
				}
				return { output: [], text: "done", toolCalls: [], usage: createEmptyUsageMetrics() };
			},
		};
		const session = await runAgentSession({
			model: {
				provider: "test",
				id: "partial-shell",
				name: "Partial Shell",
				api: "openai-chat-completions",
				baseUrl: "http://127.0.0.1",
				contextWindow: 8_000,
				efforts: [Effort.Low],
			},
			provider,
			cwd: process.cwd(),
			systemPrompt: "system",
			userPrompt: "write",
			tools: [
				{
					name: "shell",
					label: "Shell",
					description: "Shell.",
					parameters: z.object({}),
					sideEffect: "unrestricted",
					async execute() {
						return {
							content: [{ type: "text", text: "wrote then failed" }],
							details: { workspaceMutationRisk: "possible" },
							isError: true,
						};
					},
				},
			],
			policy: { reasoningEffort: Effort.Low, toolBudget: 1, maxTurns: 2 },
			signal: AbortSignal.timeout(5_000),
		});
		expect(session.success).toBe(true);
		expect(session.workspaceMutated).toBe(true);
		expect(session.unknownShellEffects).toBe(true);
	});

	it("identifies AAA Agent separately from the host workspace", async () => {
		let systemPrompt = "";
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn(options) {
				systemPrompt = options.systemPrompt;
				return {
					output: [],
					text: "AAA Agent is the standalone product.",
					toolCalls: [],
					usage: createEmptyUsageMetrics(),
				};
			},
		};
		const model: Model = {
			provider: "test",
			id: "identity-test",
			name: "Identity Test",
			api: "openai-chat-completions",
			baseUrl: "http://127.0.0.1",
			contextWindow: 8_000,
			efforts: [Effort.Low],
			authChannel: "local",
		};
		const result = await runAdaptiveTask({
			task: "What is 3A Agent?",
			model,
			provider,
			cwd: process.cwd(),
			reasoningConfig: Effort.Low,
			capabilities: new ModelCapabilityRegistry(),
			overlays: new AdaptiveOverlayRegistry(),
		});
		expect(result.success).toBe(true);
		expect(systemPrompt).toContain("You are AAA Agent (3A Agent)");
		expect(systemPrompt).toContain("NEVER substitute the current workspace or its parent project for AAA Agent.");
		expect(systemPrompt).toContain("General product question? Answer from this identity without tools.");
		expect(systemPrompt).toContain("NEVER inspect unrelated host documentation.");
	});

	it("does not treat a successful read-only shell check as a workspace mutation", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-shell-readonly-"));
		tempDirectories.push(directory);
		await Bun.write(
			path.join(directory, "smoke.test.ts"),
			'import { expect, test } from "bun:test"; test("smoke", () => expect(1).toBe(1));',
		);
		let primaryTurn = 0;
		let verifierCalls = 0;
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn(options) {
				if (options.systemPrompt.includes("independent read-only verifier")) {
					verifierCalls += 1;
					return { output: [], text: "unexpected verifier call", toolCalls: [], usage: createEmptyUsageMetrics() };
				}
				primaryTurn += 1;
				if (primaryTurn === 1) {
					const call = { callId: "check-1", name: "shell", arguments: '{"command":"bun test smoke.test.ts"}' };
					return {
						output: [
							{
								type: "function_call",
								call_id: call.callId,
								name: call.name,
								arguments: call.arguments,
							},
						],
						text: "",
						toolCalls: [call],
						usage: createEmptyUsageMetrics(),
					};
				}
				return { output: [], text: "The smoke check passes.", toolCalls: [], usage: createEmptyUsageMetrics() };
			},
		};
		const model: Model = {
			provider: "test",
			id: "shell-readonly",
			name: "Shell Readonly",
			api: "openai-chat-completions",
			baseUrl: "http://127.0.0.1",
			contextWindow: 8_000,
			efforts: [Effort.Low],
			authChannel: "local",
		};
		const result = await runAdaptiveTask({
			task: "Run and verify the smoke test",
			model,
			provider,
			cwd: directory,
			reasoningConfig: Effort.Low,
			approveShell: () => true,
			verifier: {
				model: { ...model, id: "independent-verifier", name: "Independent Verifier" },
				provider,
				reasoningConfig: Effort.Low,
			},
			capabilities: new ModelCapabilityRegistry(),
			overlays: new AdaptiveOverlayRegistry(),
		});
		expect(result.success).toBe(true);
		expect(verifierCalls).toBe(0);
		expect(result.route.policy.verification).toBe("none");
	});

	it("accepts a fresh post-mutation check without a model verifier session", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-verifier-evidence-"));
		tempDirectories.push(directory);
		await fs.mkdir(path.join(directory, "tests"));
		await Bun.write(
			path.join(directory, "tests", "test_smoke.py"),
			"import unittest\nclass Smoke(unittest.TestCase):\n    def test_smoke(self): self.assertEqual(1, 1)\n",
		);
		let primaryTurn = 0;
		let verifierCalls = 0;
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn(options) {
				if (options.systemPrompt.includes("independent read-only verifier")) {
					verifierCalls += 1;
					return { output: [], text: "unexpected verifier call", toolCalls: [], usage: createEmptyUsageMetrics() };
				}
				primaryTurn += 1;
				const call =
					primaryTurn === 1
						? { callId: "write-1", name: "write", arguments: '{"path":"smoke.py","content":"fixed"}' }
						: primaryTurn === 2
							? {
									callId: "check-1",
									name: "shell",
									arguments: JSON.stringify({
										command:
											"python3 -m unittest tests/test_smoke.py -v && python3 - <<'PY'\nprint('COMPOUND_OK')\nPY",
									}),
								}
							: undefined;
				if (call) {
					return {
						output: [
							{
								type: "function_call",
								call_id: call.callId,
								name: call.name,
								arguments: call.arguments,
							},
						],
						text: "",
						toolCalls: [call],
						usage: createEmptyUsageMetrics(),
					};
				}
				return {
					output: [],
					text: "Implemented the requested fix and the smoke test passes.",
					toolCalls: [],
					usage: createEmptyUsageMetrics(),
				};
			},
		};
		const model: Model = {
			provider: "test",
			id: "verifier-evidence",
			name: "Verifier Evidence",
			api: "openai-chat-completions",
			baseUrl: "http://127.0.0.1",
			contextWindow: 8_000,
			efforts: [Effort.Low],
			authChannel: "local",
		};
		const result = await runAdaptiveTask({
			task: "Fix the fixture and run its smoke test",
			model,
			provider,
			cwd: directory,
			reasoningConfig: Effort.Low,
			approveShell: () => true,
			verifier: {
				model: { ...model, id: "independent-verifier", name: "Independent Verifier" },
				provider,
				reasoningConfig: Effort.Low,
			},
			capabilities: new ModelCapabilityRegistry(),
			overlays: new AdaptiveOverlayRegistry(),
		});
		expect(result.success).toBe(true);
		expect(verifierCalls).toBe(0);
		expect(result.audit?.assurance).toBe("deterministic");
		expect(result.audit?.evidence[0]?.summary).toContain(
			"python3 -m unittest tests/test_smoke.py -v && python3 - <<'PY'",
		);
		expect(result.audit?.evidence[0]?.summary).toContain("exitCode=0");
	});

	it("re-runs a stale successful check in-loop after a later edit", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-stale-check-"));
		tempDirectories.push(directory);
		await Bun.write(
			path.join(directory, "smoke.test.ts"),
			'import { expect, test } from "bun:test"; test("smoke", () => expect(1).toBe(1));',
		);
		let primaryTurn = 0;
		let verifierCalls = 0;
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn(options) {
				if (options.systemPrompt.includes("independent read-only verifier")) {
					verifierCalls += 1;
					const text = JSON.stringify({
						passed: false,
						summary: "The recorded check predates the final edit.",
						integrity: "clean",
						failureKind: "task",
						blocked: false,
						completedGoalIds: [],
						unmetCriteria: ["Run a current check."],
						findings: [],
						evidence: [],
						goalEvidence: [],
					});
					return { output: [], text, toolCalls: [], usage: createEmptyUsageMetrics() };
				}
				primaryTurn += 1;
				const call =
					primaryTurn === 1
						? { callId: "check-1", name: "shell", arguments: '{"command":"bun test smoke.test.ts"}' }
						: primaryTurn === 2
							? { callId: "write-1", name: "write", arguments: '{"path":"result.txt","content":"changed"}' }
							: undefined;
				if (call) {
					return {
						output: [
							{
								type: "function_call",
								call_id: call.callId,
								name: call.name,
								arguments: call.arguments,
							},
						],
						text: "",
						toolCalls: [call],
						usage: createEmptyUsageMetrics(),
					};
				}
				return { output: [], text: "Changed after the check.", toolCalls: [], usage: createEmptyUsageMetrics() };
			},
		};
		const model: Model = {
			provider: "test",
			id: "stale-check",
			name: "Stale Check",
			api: "openai-chat-completions",
			baseUrl: "http://127.0.0.1",
			contextWindow: 8_000,
			efforts: [Effort.Low],
			authChannel: "local",
		};
		const result = await runAdaptiveTask({
			task: "Fix the fixture and run its smoke test",
			model,
			provider,
			cwd: directory,
			reasoningConfig: Effort.Low,
			approveShell: () => true,
			verifier: {
				model: { ...model, id: "independent-verifier", name: "Independent Verifier" },
				provider,
				reasoningConfig: Effort.Low,
			},
			capabilities: new ModelCapabilityRegistry(),
			overlays: new AdaptiveOverlayRegistry(),
		});
		// The host now refreshes the stale check before accepting completion, so
		// no separate verifier/recovery round is spent when it still passes.
		expect(result.success).toBe(true);
		expect(verifierCalls).toBe(0);
		expect(result.audit?.summary).toContain("deterministic host check");
	});

	it("does not short-circuit on an unrelated passing test", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-unrelated-check-"));
		tempDirectories.push(directory);
		// 一个与 billing 需求毫无关系、但必定通过的测试。此前的版本从未真正执行
		// 任何检查命令，因此测的其实是"没有证据"而非"证据无关"。
		await fs.writeFile(
			path.join(directory, "unrelated.test.ts"),
			'import { expect, test } from "bun:test";\ntest("unrelated sanity", () => { expect(1 + 1).toBe(2); });\n',
			"utf8",
		);
		let verifierCalls = 0;
		let primaryTurn = 0;
		const model: Model = {
			provider: "test",
			id: "unrelated-check",
			name: "Unrelated Check",
			api: "openai-chat-completions",
			baseUrl: "http://127.0.0.1",
			contextWindow: 8_000,
			efforts: [Effort.Low],
			authChannel: "local",
		};
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn(options) {
				if (options.systemPrompt.includes("independent read-only verifier")) {
					verifierCalls += 1;
					return {
						output: [],
						text: JSON.stringify({
							passed: false,
							summary: "The check does not cover the requested billing change.",
							completedGoalIds: [],
							unmetCriteria: ["Relevant evidence required"],
							evidence: [],
							goalEvidence: [],
						}),
						toolCalls: [],
						usage: createEmptyUsageMetrics(),
					};
				}
				primaryTurn += 1;
				if (primaryTurn === 1) {
					const args = '{"path":"billing.ts","content":"changed"}';
					return {
						output: [
							{
								type: "function_call",
								call_id: "write",
								name: "write",
								arguments: args,
							},
						],
						text: "",
						toolCalls: [{ callId: "write", name: "write", arguments: args }],
						usage: createEmptyUsageMetrics(),
					};
				}
				if (primaryTurn === 2) {
					const args = JSON.stringify({ command: "bun test unrelated.test.ts" });
					return {
						output: [
							{
								type: "function_call",
								call_id: "run-check",
								name: "shell",
								arguments: args,
							},
						],
						text: "",
						toolCalls: [{ callId: "run-check", name: "shell", arguments: args }],
						usage: createEmptyUsageMetrics(),
					};
				}
				return { output: [], text: "done", toolCalls: [], usage: createEmptyUsageMetrics() };
			},
		};
		const result = await runAdaptiveTask({
			task: "Fix the billing calculation and run its tests",
			model,
			provider,
			cwd: directory,
			reasoningConfig: Effort.Low,
			approveShell: () => true,
			capabilities: new ModelCapabilityRegistry(),
			overlays: new AdaptiveOverlayRegistry(),
		});
		expect(verifierCalls).toBeGreaterThan(0);
		expect(result.success).toBe(false);
	});

	it("short-circuits when a passing check is bound to the changed file", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-bound-check-"));
		tempDirectories.push(directory);
		// 与改动文件同名的测试：这次检查确实覆盖了改动，应当被接受。
		await fs.writeFile(
			path.join(directory, "billing.test.ts"),
			'import { expect, test } from "bun:test";\ntest("billing", () => { expect(1 + 1).toBe(2); });\n',
			"utf8",
		);
		let verifierCalls = 0;
		let primaryTurn = 0;
		const model: Model = {
			provider: "test",
			id: "bound-check",
			name: "Bound Check",
			api: "openai-chat-completions",
			baseUrl: "http://127.0.0.1",
			contextWindow: 8_000,
			efforts: [Effort.Low],
			authChannel: "local",
		};
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn(options) {
				if (options.systemPrompt.includes("independent read-only verifier")) {
					verifierCalls += 1;
					return {
						output: [],
						text: JSON.stringify({
							passed: true,
							summary: "Verifier reached, which should not happen for a bound check.",
							completedGoalIds: [],
							unmetCriteria: [],
							evidence: [],
							goalEvidence: [],
						}),
						toolCalls: [],
						usage: createEmptyUsageMetrics(),
					};
				}
				primaryTurn += 1;
				if (primaryTurn === 1) {
					const args = '{"path":"billing.ts","content":"changed"}';
					return {
						output: [
							{
								type: "function_call",
								call_id: "write",
								name: "write",
								arguments: args,
							},
						],
						text: "",
						toolCalls: [{ callId: "write", name: "write", arguments: args }],
						usage: createEmptyUsageMetrics(),
					};
				}
				if (primaryTurn === 2) {
					const args = JSON.stringify({ command: "bun test billing.test.ts" });
					return {
						output: [
							{
								type: "function_call",
								call_id: "run-check",
								name: "shell",
								arguments: args,
							},
						],
						text: "",
						toolCalls: [{ callId: "run-check", name: "shell", arguments: args }],
						usage: createEmptyUsageMetrics(),
					};
				}
				return { output: [], text: "done", toolCalls: [], usage: createEmptyUsageMetrics() };
			},
		};
		const result = await runAdaptiveTask({
			task: "Fix the billing calculation and run its tests",
			model,
			provider,
			cwd: directory,
			reasoningConfig: Effort.Low,
			approveShell: () => true,
			capabilities: new ModelCapabilityRegistry(),
			overlays: new AdaptiveOverlayRegistry(),
		});
		expect(verifierCalls).toBe(0);
		expect(result.success).toBe(true);
		expect(result.audit?.assurance).toBe("deterministic");
	});

	it("shares one token ceiling across primary and verifier sessions", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-global-budget-"));
		tempDirectories.push(directory);
		let primaryTurn = 0;
		let verifierOutputLimit: number | undefined;
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn(options) {
				if (options.systemPrompt.includes("independent read-only verifier")) {
					verifierOutputLimit = options.maxOutputTokens;
					return {
						output: [],
						text: "over budget",
						toolCalls: [],
						usage: { ...createEmptyUsageMetrics(), inputTokens: 25_000 },
					};
				}
				primaryTurn += 1;
				if (primaryTurn === 1) {
					const call = {
						callId: "write-1",
						name: "write",
						arguments: '{"path":"result.txt","content":"changed"}',
					};
					return {
						output: [
							{
								type: "function_call",
								call_id: call.callId,
								name: call.name,
								arguments: call.arguments,
							},
						],
						text: "",
						toolCalls: [call],
						usage: { ...createEmptyUsageMetrics(), inputTokens: 90_000 },
					};
				}
				return {
					output: [],
					text: "Implemented.",
					toolCalls: [],
					usage: { ...createEmptyUsageMetrics(), inputTokens: 5_000 },
				};
			},
		};
		const model: Model = {
			provider: "test",
			id: "global-budget",
			name: "Global Budget",
			api: "openai-chat-completions",
			baseUrl: "http://127.0.0.1",
			contextWindow: 1_000_000,
			efforts: [Effort.Low],
			authChannel: "local",
		};
		const result = await runAdaptiveTask({
			task: "Implement the requested fix",
			model,
			provider,
			cwd: directory,
			reasoningConfig: Effort.Low,
			verifier: {
				model: { ...model, id: "independent-verifier", name: "Independent Verifier" },
				provider,
				reasoningConfig: Effort.Low,
			},
			capabilities: new ModelCapabilityRegistry(),
			overlays: new AdaptiveOverlayRegistry(),
		});
		expect(result.success).toBe(false);
		expect(verifierOutputLimit).toBeLessThan(24_000);
		// Policy change: verified direct tasks now have a repair round, so the
		// shared ceiling may be tripped by the inner reservation (before turn 1)
		// instead of by the provider-usage check — enforce either formulation.
		expect(result.verification?.summary).toMatch(/Token limit \d+ (?:exceeded|exhausted)/);
	});
});

describe("interactive terminal contracts", () => {
	it("distinguishes tasks, shell escapes, and session commands", () => {
		expect(parseInteractiveInput("fix the parser")).toEqual({ type: "task", task: "fix the parser" });
		expect(parseInteractiveInput("!bun test")).toEqual({ type: "shell", command: "bun test" });
		expect(parseInteractiveInput("/model gpt-5.6-sol")).toEqual({ type: "model", value: "gpt-5.6-sol" });
		expect(parseInteractiveInput("/new")).toEqual({ type: "new" });
		expect(parseInteractiveInput("/resume")).toEqual({ type: "sessions" });
		expect(parseInteractiveInput("/search token target")).toEqual({ type: "search", value: "token target" });
		expect(parseInteractiveInput("/adaptive reset")).toEqual({ type: "adaptive", value: "reset" });
		expect(parseInteractiveInput("/effort off")).toEqual({ type: "effort", value: "off" });
		expect(parseInteractiveInput("/tier flex")).toEqual({ type: "tier", value: "flex" });
		expect(parseInteractiveInput("/fast on")).toEqual({ type: "fast", value: "on" });
		expect(parseInteractiveInput("/wat")).toEqual({ type: "unknown", command: "wat" });
	});

	it("owns its multi-turn messages while external model-aware digesting handles bounds", () => {
		const history = new ConversationHistory();
		history.addExchange("first", "answer");
		const snapshot = history.snapshot();
		snapshot[0] = { role: "user", text: "mutated" };
		expect(history.snapshot()).toEqual([
			{ role: "user", text: "first" },
			{ role: "assistant", text: "answer" },
		]);
		for (let index = 0; index < 30; index += 1) history.addExchange(`question ${index}`, `answer ${index}`);
		// No hidden fixed 40-message truncation: the REPL's model-derived digest
		// owns compaction so evicted turns are preserved and traceable.
		expect(history.turns).toBe(31);
		history.clear();
		expect(history.snapshot()).toEqual([]);
	});

	it("renders route, tool progress, and completion without exposing tool payloads", () => {
		const chunks: string[] = [];
		const output = {
			write(chunk: string) {
				chunks.push(chunk);
			},
		};
		const reporter = new TaskTerminalReporter({ output, interactive: true });
		reporter.onHarnessEvent({
			type: "routed",
			decision: {
				policy: {
					lane: "direct",
					goalLevel: "implicit",
					autoSubagents: "off",
					verification: "none",
					toolSurface: "minimal",
					permissions: "write",
					toolBudget: 6,
					maxToolCalls: 12,
					reasoningEffort: Effort.Low,
					disableReasoning: true,
					maxRepeatedToolCalls: 2,
					maxConsecutiveToolFailures: 2,
					budget: {
						maxTurns: 10,
						deadlineMs: 60_000,
						subagentMaxParallel: 0,
						subagentMaxDepth: 0,
						subagentMaxTurns: 0,
						subagentTotalTokens: 0,
						subagentMaxTokens: 0,
					},
					maxTotalTokens: 120_000,
				},
				reasons: ["test"],
				appliedOverlays: [],
			},
		});
		reporter.onHarnessEvent({
			type: "round_started",
			round: 2,
			maxRounds: 3,
			recovery: "Repair the failing smoke path.",
		});
		reporter.onAgentEvent({
			phase: "primary",
			event: { type: "tool_started", callId: "read-1", name: "read", arguments: { path: "src/file.ts" } },
		});
		reporter.onAgentEvent({
			phase: "primary",
			event: { type: "tool_completed", callId: "read-1", name: "read", success: true, durationMs: 12 },
		});
		const outputText = chunks.join("");
		expect(outputText).toContain("route › direct · off · verification none");
		expect(outputText).toContain("round › 2/3");
		expect(outputText).toContain("recovery › Repair the failing smoke path.");
		expect(outputText).toContain("tool › Read src/file.ts");
		expect(outputText).toContain("✓ 12ms");
		expect(outputText).not.toContain("file contents");
	});
});

describe("adaptive model routing", () => {
	it("keys behavioral profiles by auth, endpoint, protocol, effort, and schema", () => {
		const apiVariant = createModelVariant(
			{
				provider: "openai",
				id: "gpt-5.6-sol",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
				efforts: [Effort.High],
			},
			{ authChannel: "api_key", reasoningConfig: "high", toolSchemaVersion: "1" },
		);
		expect(apiVariant.key).not.toBe(variant.key);
		expect(variant.endpoint).toBe("https://chatgpt.com/backend-api");
	});

	it("restores model identity from a variant key and selects a stable display profile", () => {
		const encoded = createModelVariant(
			{
				provider: "provider with spaces",
				id: "model/name",
				api: "openai-responses",
				baseUrl: "https://example.com/v1",
				efforts: [Effort.Low],
			},
			{ authChannel: "api_key", reasoningConfig: Effort.Low },
		);
		expect(parseModelVariantKey(encoded.key)).toEqual({ provider: "provider with spaces", modelId: "model/name" });
		const coding = createDefaultCapabilityProfile(encoded, {}, "coding");
		coding.samples = 9;
		coding.coldStart = false;
		const global = createDefaultCapabilityProfile(encoded, {}, "global");
		global.samples = 2;
		global.coldStart = false;
		const indexed = indexCapabilityProfilesByModel([coding, global]);
		expect(indexed.get("provider with spaces/model/name")).toBe(global);
	});

	it("updates exact capability profiles with weighted observations", () => {
		const registry = new ModelCapabilityRegistry();
		registry.registerFamilyPrior("openai", { toolSchemaReliability: 0.8 });
		registry.observe(variant, {
			taskSlice: "coding",
			values: { toolSchemaReliability: 0.4 },
			quality: "audited",
			weight: 2,
		});
		registry.observe(variant, {
			taskSlice: "coding",
			values: { toolSchemaReliability: 1 },
			quality: "audited",
			weight: 1,
		});
		expect(registry.list().find(profile => profile.taskSlice === "global")?.toolSchemaReliability).toBeCloseTo(0.6);
		expect(registry.resolve(variant).toolSchemaReliability).toBeCloseTo(0.725);
		expect(registry.resolve(variant).samples).toBe(3);
		const restored = new ModelCapabilityRegistry();
		const saved = registry.list()[0];
		expect(saved).toBeDefined();
		if (!saved) throw new Error("Expected a persisted capability profile");
		restored.register(saved);
		restored.observe(variant, {
			taskSlice: "coding",
			values: { toolSchemaReliability: 0 },
			quality: "audited",
			weight: 1,
		});
		expect(restored.list().find(profile => profile.taskSlice === "global")?.toolSchemaReliability).toBeCloseTo(0.45);
		expect(restored.resolve(variant).toolSchemaReliability).toBeGreaterThan(0.45);
	});

	it("marks unobserved model profiles as cold start and clears it after evidence", () => {
		const registry = new ModelCapabilityRegistry();
		const cold = registry.resolve(variant, "coding");
		expect(cold.coldStart).toBe(true);
		expect(cold.samples).toBe(0);
		registry.observe(variant, {
			taskSlice: "coding",
			quality: "deterministic",
			values: { toolSchemaReliability: 1 },
		});
		expect(registry.resolve(variant, "coding").coldStart).toBe(false);
	});

	it("keeps local work direct and escalates risk or parallelism", () => {
		const profile = createDefaultCapabilityProfile(variant);
		expect(routeTask(inferTaskFeatures("Explain this function"), profile).policy.lane).toBe("direct");
		expect(routeTask(inferTaskFeatures("Implement a multi-file refactor"), profile).policy.lane).toBe("guided");
		expect(routeTask(inferTaskFeatures("Perform a multi-step migration"), profile).policy.lane).toBe("guided");
		const parallel = routeTask(inferTaskFeatures("Investigate auth and storage in parallel"), profile).policy;
		expect(parallel.lane).toBe("orchestrated");
		expect(parallel.verification).toBe("strict");
		const chineseReadOnly = inferTaskFeatures("只读审计三个仓库的恢复链路，不得修改任何文件");
		expect(chineseReadOnly.writesWorkspace).toBe(false);
		expect(routeTask(chineseReadOnly, profile).policy.lane).toBe("guided");
		expect(routeTask(inferTaskFeatures("检查多个文件的接口一致性"), profile).policy.lane).toBe("guided");
		const explanatory = inferTaskFeatures("Explain how parallel processing is implemented");
		expect(explanatory.userRequestedParallel).toBe(false);
		expect(routeTask(explanatory, profile).policy.lane).toBe("direct");
		const negatedParallel = inferTaskFeatures("不要并行，不要用子代理，检查这两个文件");
		expect(negatedParallel.userRequestedParallel).toBe(false);
		expect(routeTask(negatedParallel, profile).policy.lane).toBe("guided");
		expect(routeTask(inferTaskFeatures("修改三个文件"), profile).policy.lane).toBe("guided");
		const destructive = routeTask(inferTaskFeatures("Delete production data"), profile, {
			reasoningEffort: Effort.Low,
		}).policy;
		expect(destructive.reasoningEffort).toBe(Effort.High);
	});

	it("classifies analysis questions as read-only and exposes permission as an orthogonal policy", () => {
		const profile = createDefaultCapabilityProfile(variant);
		for (const task of [
			"为什么删除用户失败？请分析原因，不要修改代码",
			"分析删除失败",
			"解释如何修复登录错误，不要改任何文件",
			"Explain how to fix login without changing code",
		]) {
			const analysis = inferTaskFeatures(task);
			expect(analysis.readOnly).toBe(true);
			expect(analysis.writesWorkspace).toBe(false);
			const route = routeTask(analysis, profile);
			expect(route.policy.permissions).toBe("read-only");
			expect(analysis.destructiveRisk).toBe(0.1);
		}
		const implementation = inferTaskFeatures("修复登录错误并运行测试");
		expect(implementation.readOnly).toBe(false);
		expect(routeTask(implementation, profile).policy.permissions).toBe("write");
		for (const task of ["分析后修复登录错误", "Review the issue and fix it", "Delete production data"]) {
			expect(inferTaskFeatures(task).readOnly).toBe(false);
		}
	});

	it("defaults ambiguous mutation mentions to read-only unless the host supplies write evidence", () => {
		const ambiguous = inferTaskFeatures("This function deletes users when authentication fails");
		expect(ambiguous.readOnly).toBe(true);
		expect(ambiguous.writesWorkspace).toBe(false);
		const hintedWrite = inferTaskFeatures("Investigate the authentication failure", { writesWorkspace: true });
		expect(hintedWrite.readOnly).toBe(false);
		expect(hintedWrite.writesWorkspace).toBe(true);
	});

	it("exposes execution tools for explicit checks without treating analysis of test failures as execution", () => {
		const profile = createDefaultCapabilityProfile(variant);
		for (const task of ["Run the tests and report the result", "运行测试并报告结果"]) {
			const features = inferTaskFeatures(task);
			expect(features.readOnly).toBe(false);
			expect(features.writesWorkspace).toBe(false);
			expect(features.requiresVerification).toBe(true);
			expect(routeTask(features, profile).policy.permissions).toBe("write");
		}
		for (const task of ["Analyze why the test failed", "分析测试失败原因", "检查代码并列出风险"]) {
			const features = inferTaskFeatures(task);
			expect(features.readOnly).toBe(true);
			expect(features.requiresVerification).toBe(false);
			expect(routeTask(features, profile).policy.permissions).toBe("read-only");
		}
	});

	it("lets explicit route overrides win over inferred policy", () => {
		const profile = createDefaultCapabilityProfile(variant);
		const decision = routeTask(inferTaskFeatures("Explain this function"), profile, {}, [], variant, {
			lane: "guided",
			verification: "strict",
			permissions: "write",
		});
		expect(decision.policy.lane).toBe("guided");
		expect(decision.policy.verification).toBe("strict");
		expect(decision.policy.permissions).toBe("write");
		expect(decision.reasons).toEqual(
			expect.arrayContaining([
				"explicit lane override: guided",
				"explicit verification override: strict",
				"explicit permission override: write",
			]),
		);
	});
});

describe("completion gates", () => {
	it("accepts completed goals only after an independent verifier passes", async () => {
		const harness = new AdaptiveHarness({
			executor: {
				async execute(context) {
					return {
						success: true,
						output: "implemented",
						usage: createEmptyUsageMetrics(),
						completedGoalIds: context.goals.map(goal => goal.id),
					};
				},
				async verify() {
					return {
						passed: true,
						summary: "behavior checked",
						usage: createEmptyUsageMetrics(),
						evidence: [{ kind: "test", ref: "smoke", summary: "passed" }],
						hostEvidence: [{ kind: "test", ref: "smoke", summary: "passed" }],
					};
				},
			},
		});
		const result = await harness.run({
			task: "Implement and verify the fix",
			model: variant,
			featureHints: { writesWorkspace: true, requiresVerification: true },
		});
		expect(result.success).toBe(true);
		expect(result.goalReport.complete).toBe(true);
		expect(result.metrics.verificationAttempts).toBe(1);
	});

	it("blocks false completion when routed verification has no verifier", async () => {
		const harness = new AdaptiveHarness({
			executor: {
				async execute(context) {
					return {
						success: true,
						output: "claimed done",
						usage: createEmptyUsageMetrics(),
						completedGoalIds: context.goals.map(goal => goal.id),
					};
				},
			},
		});
		const result = await harness.run({
			task: "Implement the fix",
			model: variant,
			featureHints: { writesWorkspace: true },
		});
		expect(result.success).toBe(false);
		expect(result.metrics.falseCompletion).toBe(true);
		expect(result.verification?.summary).toContain("no verifier");
	});

	it("requires criterion-bound evidence before completing custom goals", async () => {
		const harness = new AdaptiveHarness({
			executor: {
				async execute() {
					return {
						success: true,
						output: "claimed done",
						completedGoalIds: ["feature"],
						usage: createEmptyUsageMetrics(),
					};
				},
				async verify() {
					return {
						passed: true,
						summary: "only criterion A checked",
						completedGoalIds: ["feature"],
						goalEvidence: [
							{
								goalId: "feature",
								criterionId: "a",
								evidence: { kind: "test", ref: "criterion-a", summary: "criterion A passed" },
							},
						],
						hostEvidence: [{ kind: "test", ref: "criterion-a", summary: "criterion A passed" }],
						usage: createEmptyUsageMetrics(),
					};
				},
			},
		});
		const result = await harness.run({
			task: "Implement a multi-file feature",
			model: variant,
			featureHints: { estimatedFiles: 2, writesWorkspace: true },
			goals: [
				{
					id: "feature",
					objective: "Deliver both contracts",
					status: "active",
					dependencies: [],
					owner: "primary",
					criteria: [
						{ id: "a", description: "Criterion A", required: true, evidence: [] },
						{ id: "b", description: "Criterion B", required: true, evidence: [] },
					],
				},
			],
		});
		expect(result.success).toBe(false);
		expect(result.goalReport.missingCriteria).toContain("feature:b");
		expect(result.checkpoint.requirements[0]?.criteria[1]?.evidence).toEqual([]);
	});

	it("does not promote suspect primary artifacts into recovery context", async () => {
		const roundArtifacts: string[][] = [];
		const harness = new AdaptiveHarness({
			executor: {
				async execute(context) {
					roundArtifacts.push(context.artifacts.map(item => item.ref));
					return {
						success: true,
						output: "claimed done",
						evidence: [{ kind: "file", ref: "unverified-change" }],
						usage: createEmptyUsageMetrics(),
					};
				},
				async verify() {
					return {
						passed: false,
						integrity: "suspect",
						summary: "not verified",
						evidence: [{ kind: "test", ref: "untrusted", summary: "unverified claim" }],
						usage: createEmptyUsageMetrics(),
					};
				},
			},
		});
		const result = await harness.run({
			task: "Implement a multi-file feature",
			model: variant,
			featureHints: { estimatedFiles: 2, writesWorkspace: true },
		});
		expect(roundArtifacts).toEqual([[], [], []]);
		expect(result.checkpoint.artifacts).toEqual([]);
		expect(result.checkpoint.facts).toEqual([]);
	});

	it("interrupts rather than accepting a malformed verifier success", async () => {
		let checkpoint: LongRunCheckpoint | undefined;
		const harness = new AdaptiveHarness({
			executor: {
				async execute() {
					return {
						success: true,
						output: "claimed done",
						completedGoalIds: ["root"],
						usage: createEmptyUsageMetrics(),
					};
				},
				async verify() {
					return {
						passed: 1 as never,
						summary: "not a valid verifier payload",
						usage: createEmptyUsageMetrics(),
					};
				},
			},
		});
		await expect(
			harness.run({
				task: "Implement a multi-file feature",
				model: variant,
				featureHints: { estimatedFiles: 2, writesWorkspace: true },
				onCheckpoint(value) {
					checkpoint = value;
				},
			}),
		).rejects.toThrow("passed must be a boolean");
		expect(checkpoint?.status).toBe("interrupted");
		expect(checkpoint?.currentRound).toBe(0);
		expect(checkpoint?.inFlightRound).toBe(1);
		expect(checkpoint?.facts).toEqual([]);
		expect(checkpoint?.requirements.every(goal => goal.status !== "done")).toBe(true);
	});

	it("does not penalize behavioral capability scores for verifier configuration failure", async () => {
		const harness = new AdaptiveHarness({
			executor: {
				async execute() {
					return { success: true, output: "claimed done", usage: createEmptyUsageMetrics() };
				},
			},
		});
		const result = await harness.run({
			task: "Implement a multi-file feature",
			model: variant,
			featureHints: { estimatedFiles: 2, writesWorkspace: true },
		});
		expect(result.audit?.kind).toBe("configuration");
		expect(result.capabilityObservation?.quality).toBe("behavioral");
		expect(result.capabilityObservation?.values.planningHorizon).toBeUndefined();
		expect(result.capabilityObservation?.values.instructionRetention).toBeUndefined();
		expect(result.capabilityObservation?.values.verificationReliability).toBeUndefined();
	});

	it("rejects verifier evidence that is absent from the host ledger", () => {
		const audit = createAuditReport(
			{
				passed: true,
				summary: "claimed verified",
				completedGoalIds: ["root"],
				evidence: [{ kind: "test", ref: "invented-check", summary: "claimed pass" }],
				assurance: "independent",
				usage: createEmptyUsageMetrics(),
			},
			{
				success: true,
				output: "claimed done",
				evidence: [{ kind: "file", ref: "src/result.ts", summary: "host-observed file" }],
				usage: createEmptyUsageMetrics(),
			},
			["root"],
		);
		expect(audit).toMatchObject({
			kind: "integrity",
			outcome: "incomplete",
			integrity: "suspect",
			completedGoalIds: [],
			evidence: [],
		});
		expect(audit.findings).toContainEqual(
			expect.objectContaining({ summary: "Verifier cited 1 evidence reference(s) absent from the host ledger." }),
		);
	});

	it("binds verifier claims to the exact host-recorded evidence", () => {
		const observed = {
			kind: "test" as const,
			ref: "shell:check-1",
			summary: "Host observed exitCode=0",
		};
		const audit = createAuditReport(
			{
				passed: true,
				summary: "verified",
				completedGoalIds: ["root"],
				evidence: [{ ...observed, summary: "model-supplied summary" }],
				hostEvidence: [observed],
				verifiedFacts: [
					{ statement: "The smoke check passes.", evidence: [{ ...observed, summary: "model-supplied summary" }] },
				],
				assurance: "independent",
				usage: createEmptyUsageMetrics(),
			},
			{ success: true, output: "done", usage: createEmptyUsageMetrics() },
			["root"],
		);
		expect(audit.outcome).toBe("complete");
		expect(audit.completedGoalIds).toEqual(["root"]);
		expect(audit.evidence).toEqual([observed]);
		expect(audit.verifiedFacts).toMatchObject([
			{ statement: "The smoke check passes.", evidence: [observed], verifiedAt: expect.any(Number) },
		]);
		expect(audit.assurance).toBe("independent");
	});
});

describe("structured context compression", () => {
	it("retains bounded goals, verified facts, artifacts, and open risks outside raw history", () => {
		const features = inferTaskFeatures("Implement a multi-file feature");
		const profile = createDefaultCapabilityProfile(variant, {}, "coding");
		const route = routeTask(features, profile, {}, [], variant);
		const requirements: AdaptiveGoalNode[] = Array.from({ length: 30 }, (_, index) => ({
			id: `goal-${index}`,
			objective: `Goal ${index}`,
			status: index < 5 ? "done" : "active",
			dependencies: [],
			owner: "primary",
			criteria: [],
		}));
		const checkpoint = createLongRunCheckpoint({
			task: "Build feature",
			variantKey: variant.key,
			requirements,
			policySnapshot: { createdAt: 1, taskSlice: "coding", profile, route },
		});
		checkpoint.status = "blocked";
		checkpoint.updatedAt = 123;
		checkpoint.facts = Array.from({ length: 40 }, (_, index) => ({
			statement: `Fact ${index}`,
			evidence: [{ kind: "test", ref: `test-${index}` }],
			verifiedAt: index,
		}));
		checkpoint.artifacts = Array.from({ length: 40 }, (_, index) => ({
			kind: "file",
			ref: `artifact-${index}`,
		}));
		checkpoint.lastAudit = {
			kind: "task",
			outcome: "blocked",
			integrity: "clean",
			summary: "work remains",
			completedGoalIds: requirements.slice(0, 5).map(goal => goal.id),
			findings: Array.from({ length: 20 }, (_, index) => ({
				severity: "warning",
				summary: `Risk ${index}`,
				evidence: [],
			})),
			unmetCriteria: ["criterion-a"],
			evidence: [],
			goalEvidence: [],
			assurance: "independent",
			usage: createEmptyUsageMetrics(),
		};
		checkpoint.recoveryGuidance = "  Repair\n the remaining path.  ";

		const state = updateStructuredContextState(undefined, "  Build\n feature  ", checkpoint);
		expect(state.userGoals).toEqual([{ objective: "Build feature", status: "blocked", updatedAt: 123 }]);
		expect(state.completedGoals).toEqual(["Goal 0", "Goal 1", "Goal 2", "Goal 3", "Goal 4"]);
		expect(state.remainingGoals).toHaveLength(24);
		expect(state.remainingGoals.at(-1)).toBe("Goal 29");
		expect(state.verifiedFacts).toHaveLength(32);
		expect(state.verifiedFacts[0]?.statement).toBe("Fact 8");
		expect(state.artifacts).toHaveLength(32);
		expect(state.artifacts[0]?.ref).toBe("artifact-8");
		expect(state.openRisks).toHaveLength(16);
		expect(state.openRisks.at(-1)).toBe("Risk 19");
		expect(state.recoveryGuidance).toBe("Repair the remaining path.");
	});
});

describe("standalone workspace tools", () => {
	it("withholds mutation tools and mutation escalation for read-only tasks", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-read-only-"));
		tempDirectories.push(directory);
		let requestedTools: string[] = [];
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn(options) {
				requestedTools = options.tools.map(tool => tool.name);
				return {
					output: [],
					text: "Analysis complete.",
					toolCalls: [],
					usage: createEmptyUsageMetrics(),
				};
			},
		};
		const model: Model = {
			provider: "test",
			id: "read-only",
			name: "Read Only",
			api: "openai-chat-completions",
			baseUrl: "http://127.0.0.1",
			contextWindow: 8_000,
			efforts: [Effort.Low],
			authChannel: "local",
		};
		const result = await runAdaptiveTask({
			task: "分析这个目录，不要修改任何文件",
			model,
			provider,
			cwd: directory,
			reasoningConfig: Effort.Low,
			capabilities: new ModelCapabilityRegistry(),
			overlays: new AdaptiveOverlayRegistry(),
		});
		expect(result.route.policy.permissions).toBe("read-only");
		expect(requestedTools).toEqual(["read", "glob", "search"]);
	});
	it("creates, reads, snapshot-edits, searches, and executes in the selected workspace", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-agent-"));
		tempDirectories.push(directory);
		const tools = createAdaptiveToolset(directory, { approveShell: () => true });

		await toolNamed(tools.allTools, "write").execute("write", { path: "sample.txt", content: "before\n" });
		const readResult = await toolNamed(tools.allTools, "read").execute("read", { path: "sample.txt" });
		const readText = readResult.content[0]?.type === "text" ? readResult.content[0].text : "";
		const hash = readText.match(/\[sample\.txt#([0-9A-F]{12})\]/)?.[1];
		expect(hash).toBeDefined();
		await toolNamed(tools.allTools, "edit").execute("edit", {
			path: "sample.txt",
			hash,
			edits: [{ oldText: "before", newText: "after" }],
		});
		expect(await Bun.file(path.join(directory, "sample.txt")).text()).toBe("after\n");
		const searchResult = await toolNamed(tools.allTools, "search").execute("search", {
			pattern: "after",
			files: "**/*.txt",
		});
		expect(searchResult.content[0]?.type === "text" ? searchResult.content[0].text : "").toContain(
			"sample.txt:1:after",
		);
		const shellResult = await toolNamed(tools.allTools, "shell").execute("shell", {
			command: "printf checked > shell-output.txt",
		});
		expect(shellResult.details?.exitCode).toBe(0);
		expect(await Bun.file(path.join(directory, "shell-output.txt")).text()).toBe("checked");
	});

	it("restricts verifier tools to read-only workspace inspection", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-agent-"));
		tempDirectories.push(directory);
		const tools = createAdaptiveToolset(directory);
		expect(tools.verificationTools.map(tool => tool.name)).toEqual(["read", "glob", "search"]);
	});

	it("rejects lexical paths outside the selected workspace", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-agent-"));
		tempDirectories.push(directory);
		const tools = createAdaptiveToolset(directory);
		await expect(toolNamed(tools.allTools, "read").execute("read", { path: "../outside.txt" })).rejects.toThrow(
			"outside the workspace",
		);
	});

	it("rejects edits to lines omitted from the snapshot read", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-agent-"));
		tempDirectories.push(directory);
		await Bun.write(path.join(directory, "sample.txt"), "visible\nhidden\n");
		const tools = createAdaptiveToolset(directory);
		const result = await toolNamed(tools.allTools, "read").execute("read", {
			path: "sample.txt",
			offset: 1,
			limit: 1,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		const hash = text.match(/\[sample\.txt#([0-9A-F]{12})\]/)?.[1];
		expect(hash).toBeDefined();
		await expect(
			toolNamed(tools.allTools, "edit").execute("edit", {
				path: "sample.txt",
				hash,
				edits: [{ oldText: "hidden", newText: "changed" }],
			}),
		).rejects.toThrow("not shown by read");
	});
	it("bounds search scope and rejects unsafe patterns", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-search-guards-"));
		tempDirectories.push(directory);
		await fs.mkdir(path.join(directory, "node_modules"), { recursive: true });
		await fs.mkdir(path.join(directory, "src"), { recursive: true });
		await Bun.write(path.join(directory, "node_modules", "ignored.ts"), "needle");
		await Bun.write(path.join(directory, "src", "kept.ts"), "needle");
		const tools = createAdaptiveToolset(directory);
		const result = await toolNamed(tools.allTools, "search").execute("search", { pattern: "needle" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("src/kept.ts:1:needle");
		expect(text).not.toContain("node_modules/ignored.ts");
		await expect(toolNamed(tools.allTools, "search").execute("search", { pattern: "x".repeat(513) })).rejects.toThrow(
			"exceeds 512",
		);
		for (const pattern of ["(a+)+$", "(a|aa)+$", ".*prefix.*suffix", "(x{1,3})+"]) {
			await expect(toolNamed(tools.allTools, "search").execute("search", { pattern })).rejects.toThrow(
				"Unsafe search pattern",
			);
		}
		await expect(
			toolNamed(tools.allTools, "search").execute("search", { pattern: String.raw`(a)\1` }),
		).rejects.toThrow("backreferences");
		const safe = await toolNamed(tools.allTools, "search").execute("search", { pattern: "need(?:le|les)" });
		expect(safe.isError).not.toBe(true);
	});

	it("rejects a stale snapshot after an external write", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-agent-"));
		tempDirectories.push(directory);
		await Bun.write(path.join(directory, "sample.txt"), "before\n");
		const tools = createAdaptiveToolset(directory);
		const result = await toolNamed(tools.allTools, "read").execute("read", { path: "sample.txt" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		const hash = text.match(/\[sample\.txt#([0-9A-F]{12})\]/)?.[1];
		expect(hash).toBeDefined();
		await Bun.write(path.join(directory, "sample.txt"), "external\n");
		await expect(
			toolNamed(tools.allTools, "edit").execute("edit", {
				path: "sample.txt",
				hash,
				edits: [{ oldText: "before", newText: "after" }],
			}),
		).rejects.toThrow("Snapshot mismatch");
	});

	it("rejects reads and writes that escape through workspace symbolic links", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-agent-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-agent-outside-"));
		tempDirectories.push(directory, outside);
		await Bun.write(path.join(outside, "secret.txt"), "secret");
		await fs.symlink(outside, path.join(directory, "escape"));
		const tools = createAdaptiveToolset(directory);
		await expect(toolNamed(tools.allTools, "read").execute("read", { path: "escape/secret.txt" })).rejects.toThrow(
			"symbolic link",
		);
		await expect(
			toolNamed(tools.allTools, "write").execute("write", { path: "escape/owned.txt", content: "escaped" }),
		).rejects.toThrow("symbolic link");
		expect(await Bun.file(path.join(outside, "owned.txt")).exists()).toBe(false);
	});

	it("uses native command interpreters on Windows and macOS", () => {
		expect(
			createShellInvocation("bun test", {
				platform: "win32",
				comspec: "C:\\Windows\\System32\\cmd.exe",
			}),
		).toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", "bun test"]);
		expect(createShellInvocation("bun test", { platform: "darwin", shell: "/bin/zsh" })).toEqual([
			"/bin/zsh",
			"-c",
			"bun test",
		]);
	});
});

describe("goal, subagent, and overlay control", () => {
	it("enforces DAG dependencies and evidence-backed completion", () => {
		const nodes: AdaptiveGoalNode[] = [
			{
				id: "inspect",
				objective: "Inspect the failure",
				status: "active",
				dependencies: [],
				owner: "primary",
				criteria: [{ id: "evidence", description: "Failure identified", required: true, evidence: [] }],
			},
			{
				id: "fix",
				objective: "Fix the failure",
				status: "pending",
				dependencies: ["inspect"],
				owner: "primary",
				criteria: [{ id: "test", description: "Fix verified", required: true, evidence: [] }],
			},
		];
		const goals = new AdaptiveGoalStore("dag", "Repair the failure", nodes);
		expect(goals.frontier().map(goal => goal.id)).toEqual(["inspect"]);
		expect(() => goals.setStatus("fix", "done")).toThrow("before its dependencies");
		goals.attachEvidence("inspect", "evidence", { kind: "file", ref: "src/failure.ts" });
		goals.setStatus("inspect", "done");
		expect(goals.frontier().map(goal => goal.id)).toEqual(["fix"]);
		goals.attachEvidence("fix", "test", { kind: "test", ref: "bun test" });
		goals.setStatus("fix", "done");
		expect(goals.completionReport()).toEqual({ complete: true, openGoals: [], missingCriteria: [] });
		expect(
			() =>
				new AdaptiveGoalStore("dag", "cycle", [
					{ ...nodes[0]!, dependencies: ["fix"] },
					{ ...nodes[1]!, dependencies: ["inspect"] },
				]),
		).toThrow("cycle");
	});

	it("bounds subagents, passes dependency findings, and rejects automatic writers", async () => {
		const started: string[] = [];
		let dependentPrompt = "";
		const runner = async (task: { id: string; prompt: string }): Promise<SubagentResult> => {
			started.push(task.id);
			if (task.id === "c") dependentPrompt = task.prompt;
			await Bun.sleep(5);
			return {
				taskId: task.id,
				status: "succeeded",
				findings: task.id === "a" ? [{ summary: "A uses src/a.ts:12", evidence: [], confidence: 0.9 }] : [],
				unresolved: [],
				usage: { ...createEmptyUsageMetrics(), inputTokens: 10 },
			};
		};
		const scheduler = new BoundedSubagentScheduler(runner);
		const profile = createDefaultCapabilityProfile(variant, { parallelToolReliability: 0.8 });
		const policy = routeTask(inferTaskFeatures("Inspect branches in parallel"), profile).policy;
		const result = await scheduler.run(
			[
				{ id: "a", prompt: "Inspect A", mode: "read", origin: "router", estimatedTokens: 100 },
				{ id: "b", prompt: "Inspect B", mode: "read", origin: "router", estimatedTokens: 100 },
				{ id: "c", prompt: "Compare", mode: "read", origin: "router", dependencies: ["a"], estimatedTokens: 100 },
				{ id: "writer", prompt: "Write", mode: "write", origin: "router", estimatedTokens: 100 },
			],
			variant,
			profile,
			policy,
		);
		expect(result.spawns).toBe(3);
		expect(result.results.map(item => item.status)).toEqual(["succeeded", "succeeded", "succeeded", "skipped"]);
		expect(started.indexOf("c")).toBeGreaterThan(started.indexOf("a"));
		expect(dependentPrompt).toContain("A uses src/a.ts:12");
		expect(result.results[3]?.error).toContain("isolation");
		expect(result.usage.inputTokens).toBe(30);
	});

	it("contains thrown and malformed subagent failures without rejecting the batch", async () => {
		const scheduler = new BoundedSubagentScheduler(async task => {
			if (task.id === "throws") throw new Error("subagent crashed");
			if (task.id === "malformed") {
				return {
					taskId: task.id,
					status: "succeeded",
					findings: [],
					unresolved: [],
					usage: undefined as never,
				};
			}
			return {
				taskId: task.id,
				status: "succeeded",
				findings: [],
				unresolved: [],
				usage: createEmptyUsageMetrics(),
			};
		});
		const profile = createDefaultCapabilityProfile(variant, { parallelToolReliability: 0.8 });
		const policy = routeTask(inferTaskFeatures("Inspect branches in parallel"), profile).policy;
		const result = await scheduler.run(
			[
				{ id: "throws", prompt: "Throw", mode: "read", origin: "user" },
				{ id: "malformed", prompt: "Malformed", mode: "read", origin: "user" },
				{ id: "independent", prompt: "Continue", mode: "read", origin: "user" },
				{ id: "dependent", prompt: "Use failed result", mode: "read", origin: "user", dependencies: ["throws"] },
			],
			variant,
			profile,
			policy,
		);
		expect(result.results.map(item => item.status)).toEqual(["failed", "failed", "succeeded", "skipped"]);
		expect(result.results[0]?.error).toBe("subagent crashed");
		expect(result.results[1]?.error).toContain("invalid result");
		expect(result.results[3]?.error).toContain("dependency");
	});

	it("layers versioned overlays from universal through exact model scope", () => {
		const registry = new AdaptiveOverlayRegistry();
		registry.register({
			id: "universal-budget",
			scope: "universal",
			priority: 1,
			selector: {},
			policy: { toolBudget: 5, budget: { maxTurns: 20 } },
			version: 1,
		});
		registry.register({
			id: "family-reasoning",
			scope: "family",
			priority: 1,
			selector: { families: ["openai"] },
			policy: { reasoningEffort: Effort.Medium },
			version: 1,
		});
		registry.register({
			id: "exact-budget",
			scope: "model",
			priority: 1,
			selector: { variantKeys: [variant.key] },
			policy: { toolBudget: 9, budget: { subagentMaxParallel: 2 } },
			version: 1,
		});
		const resolved = registry.resolve(variant, createDefaultCapabilityProfile(variant));
		expect(resolved.ids).toEqual(["universal-budget", "family-reasoning", "exact-budget"]);
		expect(resolved.policy.toolBudget).toBe(9);
		expect(resolved.policy.reasoningEffort).toBe(Effort.Medium);
		expect(resolved.policy.budget).toEqual({ maxTurns: 20, subagentMaxParallel: 2 });
		expect(() =>
			registry.register({
				id: "exact-budget",
				scope: "model",
				priority: 1,
				selector: { variantKeys: [variant.key] },
				policy: {},
				version: 1,
			}),
		).toThrow("not newer");
	});
});

describe("controlled evolution and metrics", () => {
	it("promotes transferable candidates and rejects held-out regressions", () => {
		const point = (modelKey: string, modelFamily: string, candidateScore: number) => ({
			modelKey,
			modelFamily,
			taskSlice: "coding",
			baselineScore: 0.5,
			candidateScore,
			baselineTokens: 100,
			candidateTokens: 110,
			baselineLatencyMs: 100,
			candidateLatencyMs: 110,
			baselineCostUsd: 1,
			candidateCostUsd: 1.1,
		});
		const candidate: HarnessCandidate = {
			id: "candidate-1",
			overlay: {
				id: "candidate-overlay",
				scope: "model",
				priority: 1,
				selector: { variantKeys: [variant.key] },
				policy: { toolBudget: 8 },
				version: 1,
			},
			prediction: "Improve reliable completion",
			heldIn: [point("openai-a", "openai", 0.55)],
			heldOut: [point("openai-a", "openai", 0.5)],
			crossModel: [
				point("openai-b", "openai", 0.52),
				point("anthropic-a", "anthropic", 0.52),
				point("google-a", "google", 0.52),
			],
			createdAt: Date.now(),
		};
		const accepted = evaluateHarnessCandidate(candidate);
		expect(accepted.accepted).toBe(true);
		expect(accepted.scope).toBe("universal");
		expect(accepted.promotedOverlay?.version).toBe(2);
		const rejected = evaluateHarnessCandidate({
			...candidate,
			id: "candidate-2",
			heldOut: [point("openai-a", "openai", 0.45)],
		});
		expect(rejected.accepted).toBe(false);
		expect(rejected.reasons.join(" ")).toContain("held-out regression");
	});

	it("reports adaptive token, latency, cost, and tool-call tax", () => {
		const metric = (tokens: number, latency: number, costUsd: number, toolCalls: number): HarnessRunMetrics => ({
			...createEmptyUsageMetrics(),
			inputTokens: tokens,
			costUsd,
			toolCalls,
			startedAt: 1_000,
			completedAt: 1_000 + latency,
			subagentSpawns: 0,
			subagentTokens: 0,
			verificationAttempts: 0,
			falseCompletion: false,
			success: true,
		});
		const tax = calculateHarnessTax(metric(120, 150, 1.2, 6), metric(100, 100, 1, 4));
		expect(tax.tokenRatio).toBeCloseTo(0.2);
		expect(tax.latencyMs).toBe(50);
		expect(tax.costRatio).toBeCloseTo(0.2);
		expect(tax.toolCallRatio).toBeCloseTo(0.5);
	});
});

describe("cross-provider adaptive runtime", () => {
	it("runs an OpenAI-compatible chat-completions tool loop without subscription auth", async () => {
		const requestBodies: string[] = [];
		const authorizationHeaders: Array<string | null> = [];
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				requests += 1;
				authorizationHeaders.push(request.headers.get("authorization"));
				const payload: unknown = await request.json();
				requestBodies.push(JSON.stringify(payload));
				if (requests === 1) {
					return Response.json({
						choices: [
							{
								message: {
									role: "assistant",
									content: null,
									tool_calls: [
										{
											id: "call-1",
											type: "function",
											function: { name: "echo", arguments: '{"value":"hi"}' },
										},
									],
								},
							},
						],
						usage: { prompt_tokens: 20, completion_tokens: 4 },
					});
				}
				return Response.json({
					choices: [{ message: { role: "assistant", content: "done" } }],
					usage: { prompt_tokens: 30, completion_tokens: 2 },
				});
			},
		});
		testServers.push(server);
		const model: Model = {
			provider: "local-test",
			id: "tool-model",
			name: "Tool Model",
			api: "openai-chat-completions",
			baseUrl: server.url.toString().replace(/\/$/, ""),
			contextWindow: 32_000,
			efforts: [Effort.Minimal],
			authChannel: "local",
			family: "local",
		};
		const schema = z.object({ value: z.string() });
		const session = await runAgentSession({
			model,
			provider: createOpenAICompatibleProvider(model),
			cwd: process.cwd(),
			systemPrompt: "system",
			userPrompt: "echo",
			tools: [
				{
					name: "echo",
					label: "Echo",
					description: "Echo a value.",
					parameters: schema,
					async execute(_id, raw) {
						return { content: [{ type: "text", text: schema.parse(raw).value }] };
					},
				},
			],
			policy: { reasoningEffort: Effort.Minimal, toolBudget: 2, maxTurns: 3 },
			signal: AbortSignal.timeout(5_000),
		});
		expect(session.success).toBe(true);
		expect(session.output).toBe("done");
		expect(session.usage.inputTokens).toBe(50);
		expect(requestBodies[1]).toContain('"role":"tool"');
		expect(requestBodies[1]).toContain('"content":"hi"');
		expect(authorizationHeaders).toEqual([null, null]);
	});

	it("streams OpenAI-compatible text and fragmented tool-call arguments", async () => {
		let requestedStreaming = false;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const body = z.record(z.string(), z.unknown()).parse(await request.json());
				requestedStreaming = body.stream === true;
				const chunks = [
					{
						choices: [
							{
								delta: {
									content: "hel",
									tool_calls: [
										{ index: 0, id: "call-stream", function: { name: "ec", arguments: '{"value":' } },
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {
									content: "lo",
									tool_calls: [{ index: 0, function: { name: "ho", arguments: '"x"}' } }],
								},
							},
						],
					},
					{ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
				];
				return new Response(
					`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
			},
		});
		testServers.push(server);
		const model: Model = {
			provider: "stream-test",
			id: "stream-model",
			name: "Stream Model",
			api: "openai-chat-completions",
			baseUrl: server.url.toString().replace(/\/$/, ""),
			contextWindow: 8_000,
			efforts: [Effort.Low],
			authChannel: "local",
		};
		const deltas: string[] = [];
		const result = await createOpenAICompatibleProvider(model).runTurn({
			model,
			systemPrompt: "system",
			input: [],
			tools: [],
			effort: Effort.Low,
			sessionId: "stream-session",
			signal: AbortSignal.timeout(5_000),
			onTextDelta: delta => deltas.push(delta),
		});
		expect(requestedStreaming).toBe(true);
		expect(deltas).toEqual(["hel", "lo"]);
		expect(result.text).toBe("hello");
		expect(result.toolCalls).toEqual([{ callId: "call-stream", name: "echo", arguments: '{"value":"x"}' }]);
		expect(result.usage.inputTokens).toBe(12);
	});

	it("leaves retry ownership to the agent loop instead of multiplying transport attempts", async () => {
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch() {
				requests += 1;
				return Response.json(
					{ error: { code: "1302", message: "rate limited" } },
					{ status: 429, headers: { "retry-after": "0" } },
				);
			},
		});
		testServers.push(server);
		const model: Model = {
			provider: "retry-test",
			id: "retry-model",
			name: "Retry Model",
			api: "openai-chat-completions",
			baseUrl: server.url.toString().replace(/\/$/, ""),
			contextWindow: 8_000,
			efforts: [Effort.Low],
			authChannel: "local",
		};
		await expect(
			createOpenAICompatibleProvider(model).runTurn({
				model,
				systemPrompt: "system",
				input: [],
				tools: [],
				effort: Effort.Low,
				sessionId: "retry-session",
				signal: AbortSignal.timeout(5_000),
			}),
		).rejects.toThrow("429");
		expect(requests).toBe(1);
	});

	it("resolves provider-qualified models and preserves variant isolation", () => {
		const models: Model[] = [
			{
				provider: "provider-a",
				id: "shared",
				name: "A",
				api: "openai-responses",
				baseUrl: "https://a.example/v1",
				contextWindow: 8_000,
				efforts: [Effort.Low],
				authChannel: "api_key",
				family: "family-a",
			},
			{
				provider: "provider-b",
				id: "shared",
				name: "B",
				api: "openai-chat-completions",
				baseUrl: "https://b.example/v1",
				contextWindow: 8_000,
				efforts: [Effort.Minimal],
				authChannel: "local",
				family: "family-b",
			},
		];
		expect(() => resolveModel("shared", models)).toThrow("Ambiguous");
		const selected = resolveModel("provider-b/shared", models);
		const selectedVariant = createAdaptiveModelVariant(selected, Effort.Minimal);
		expect(selected.api).toBe("openai-chat-completions");
		expect(selectedVariant.family).toBe("family-b");
		expect(selectedVariant.authChannel).toBe("local");
		expect(selectedVariant.key).toContain("provider-b");
		expect(
			routeTask(
				inferTaskFeatures("Fix one file"),
				createDefaultCapabilityProfile(selectedVariant),
				{},
				[],
				selectedVariant,
			).policy.reasoningEffort,
		).toBe(Effort.Minimal);
	});

	it("ships provider-qualified pay-as-you-go and quota-plan contracts", () => {
		const models = listBuiltInModels();
		const byKey = (key: string): Model => {
			const model = models.find(candidate => `${candidate.provider}/${candidate.id}` === key);
			if (!model) throw new Error(`Missing built-in model ${key}`);
			return model;
		};
		expect(byKey("z-ai/glm-5.2")).toMatchObject({
			baseUrl: "https://api.z.ai/api/paas/v4",
			servicePlan: "payg",
			apiKeyEnv: "ZAI_API_KEY",
		});
		expect(byKey("kimi/kimi-k3")).toMatchObject({
			baseUrl: "https://api.moonshot.ai/v1",
			servicePlan: "payg",
			apiKeyEnv: "MOONSHOT_API_KEY",
		});
		expect(byKey("deepseek/deepseek-v4-pro")).toMatchObject({
			baseUrl: "https://api.deepseek.com",
			contextWindow: 1_000_000,
			maxOutputTokens: 384_000,
			effortFormat: "thinking_toggle_with_effort",
			apiKeyEnv: "DEEPSEEK_API_KEY",
		});
		expect(byKey("minimax/MiniMax-M3")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.minimax.io/anthropic",
			servicePlan: "payg",
			effortFormat: "anthropic_thinking_toggle",
			apiKeyEnv: "MINIMAX_API_KEY",
		});
		expect(byKey("z-ai-coding/glm-5.2")).toMatchObject({
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
			servicePlan: "coding-plan",
			apiKeyEnv: "ZAI_CODING_PLAN_API_KEY",
		});
		expect(byKey("kimi-code/k3-256k")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.kimi.com/coding",
			contextWindow: 262_144,
			servicePlan: "coding-plan",
			apiKeyEnv: "KIMI_CODE_API_KEY",
		});
		expect(byKey("minimax-token/MiniMax-M3")).toMatchObject({
			baseUrl: "https://api.minimax.io/anthropic",
			servicePlan: "token-plan",
			apiKeyEnv: "MINIMAX_TOKEN_PLAN_API_KEY",
			apiKeyHeader: "bearer",
		});
		expect(byKey("xiaomi-mimo-token/mimo-v2.5-pro")).toMatchObject({
			baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
			baseUrlEnv: "MIMO_TOKEN_PLAN_BASE_URL",
			servicePlan: "token-plan",
			apiKeyEnv: "MIMO_TOKEN_PLAN_API_KEY",
		});
	});

	it("maps thinking and service-tier controls to OpenAI-compatible request contracts", async () => {
		const requestBodies: Record<string, unknown>[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				requestBodies.push(z.record(z.string(), z.unknown()).parse(await request.json()));
				return Response.json({
					choices: [{ message: { role: "assistant", content: "done" } }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				});
			},
		});
		testServers.push(server);
		const baseUrl = server.url.toString().replace(/\/$/, "");
		const run = async (
			effortFormat: Model["effortFormat"],
			effort: Effort,
			options: { disableReasoning?: boolean; serviceTier?: "priority" } = {},
		): Promise<void> => {
			const model: Model = {
				provider: "contract-test",
				id: "model",
				name: "Contract Test",
				api: "openai-chat-completions",
				baseUrl,
				contextWindow: 8_000,
				efforts: [effort],
				authChannel: "local",
				effortFormat,
			};
			await createOpenAICompatibleProvider(model).runTurn({
				model,
				systemPrompt: "system",
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
				tools: [],
				effort,
				...options,
				sessionId: "session",
				signal: AbortSignal.timeout(5_000),
			});
		};
		await run("reasoning_effort", Effort.Minimal);
		await run("thinking_toggle", Effort.High);
		await run("thinking_toggle_with_effort", Effort.High);
		await run("thinking_toggle_with_effort", Effort.Minimal);
		await run("thinking_toggle_with_effort", Effort.High, { disableReasoning: true });
		await run("none", Effort.Minimal, { serviceTier: "priority" });
		expect(requestBodies[0]).toMatchObject({ reasoning_effort: "minimal" });
		expect(requestBodies[0]?.thinking).toBeUndefined();
		expect(requestBodies[1]?.reasoning_effort).toBeUndefined();
		expect(requestBodies[1]?.thinking).toEqual({ type: "enabled" });
		expect(requestBodies[2]).toMatchObject({
			reasoning_effort: "high",
			thinking: { type: "enabled" },
		});
		expect(requestBodies[3]).toMatchObject({
			reasoning_effort: "minimal",
			thinking: { type: "enabled" },
		});
		expect(requestBodies[4]?.reasoning_effort).toBeUndefined();
		expect(requestBodies[4]?.thinking).toEqual({ type: "disabled" });
		expect(requestBodies[5]?.reasoning_effort).toBeUndefined();
		expect(requestBodies[5]?.thinking).toBeUndefined();
		expect(requestBodies[5]?.service_tier).toBe("priority");
	});

	it("maps native thinking-off and priority controls to Responses request fields", () => {
		const model: Model = {
			provider: "responses-test",
			id: "gpt-test",
			name: "Responses Test",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			contextWindow: 8_000,
			efforts: [Effort.High],
			supportsThinkingOff: true,
			serviceTiers: ["priority"],
			authChannel: "local",
		};
		const body = createResponsesRequestBody({
			model,
			systemPrompt: "system",
			input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
			tools: [],
			effort: Effort.High,
			disableReasoning: true,
			serviceTier: "priority",
			sessionId: "session",
			signal: AbortSignal.timeout(5_000),
		});
		expect(body.reasoning).toEqual({ effort: "none" });
		expect(body.service_tier).toBe("priority");
		expect(body.prompt_cache_key).toBe("session");
	});

	it("keeps output caps local for Codex while forwarding them to standard Responses", () => {
		const base: Model = {
			provider: "responses-test",
			id: "gpt-test",
			name: "Responses Test",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			contextWindow: 8_000,
			maxOutputTokens: 4_000,
			efforts: [Effort.Medium],
			authChannel: "local",
		};
		const request = (model: Model) =>
			createResponsesRequestBody({
				model,
				systemPrompt: "system",
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
				tools: [],
				effort: Effort.Medium,
				maxOutputTokens: 3_000,
				sessionId: "session",
				signal: AbortSignal.timeout(5_000),
			});
		expect(request(base).max_output_tokens).toBe(3_000);
		expect(request({ ...base, provider: "openai-codex", api: "codex-responses" }).max_output_tokens).toBeUndefined();
	});

	it("runs a Claude Messages tool loop and preserves thinking blocks", async () => {
		const bodies: Record<string, unknown>[] = [];
		const paths: string[] = [];
		const apiKeys: Array<string | null> = [];
		const versions: Array<string | null> = [];
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				requests += 1;
				paths.push(new URL(request.url).pathname);
				apiKeys.push(request.headers.get("x-api-key"));
				versions.push(request.headers.get("anthropic-version"));
				bodies.push(z.record(z.string(), z.unknown()).parse(await request.json()));
				if (requests === 1) {
					return Response.json({
						content: [
							{ type: "thinking", thinking: "inspect the value", signature: "signed-thinking" },
							{ type: "tool_use", id: "toolu-1", name: "echo", input: { value: "hi" } },
						],
						usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 3 },
					});
				}
				return Response.json({
					content: [{ type: "text", text: "done" }],
					usage: { input_tokens: 30, output_tokens: 2 },
				});
			},
		});
		testServers.push(server);
		const envName = "AAA_AGENT_TEST_ANTHROPIC_KEY";
		const previousKey = process.env[envName];
		process.env[envName] = "secret";
		try {
			const model: Model = {
				provider: "anthropic-test",
				id: "claude-test",
				name: "Claude Test",
				api: "anthropic-messages",
				baseUrl: server.url.toString().replace(/\/$/, ""),
				contextWindow: 1_000_000,
				efforts: [Effort.High],
				authChannel: "api_key",
				effortFormat: "anthropic_output_config",
				maxOutputTokens: 128_000,
				apiKeyEnv: envName,
				family: "anthropic",
			};
			const schema = z.object({ value: z.string() });
			const session = await runAgentSession({
				model,
				provider: createAgentTurnProvider(model),
				cwd: process.cwd(),
				systemPrompt: "system",
				userPrompt: "echo",
				tools: [
					{
						name: "echo",
						label: "Echo",
						description: "Echo a value.",
						parameters: schema,
						async execute(_id, raw) {
							return { content: [{ type: "text", text: schema.parse(raw).value }] };
						},
					},
				],
				policy: { reasoningEffort: Effort.High, toolBudget: 2, maxTurns: 3 },
				signal: AbortSignal.timeout(5_000),
			});
			expect(session.success).toBe(true);
			expect(session.output).toBe("done");
			expect(session.usage.inputTokens).toBe(50);
			expect(session.usage.outputTokens).toBe(6);
			expect(paths).toEqual(["/v1/messages", "/v1/messages"]);
			expect(apiKeys).toEqual(["secret", "secret"]);
			expect(versions).toEqual(["2023-06-01", "2023-06-01"]);
			expect(bodies[0]?.system).toEqual([{ type: "text", text: "system", cache_control: { type: "ephemeral" } }]);
			expect(JSON.stringify(bodies[0]?.tools)).toContain("cache_control");
			expect(bodies[0]?.thinking).toEqual({ type: "adaptive" });
			expect(bodies[0]?.output_config).toEqual({ effort: "high" });
			expect(bodies[0]?.max_tokens).toBe(128_000);
			const secondBody = JSON.stringify(bodies[1]);
			expect(secondBody).toContain('"signature":"signed-thinking"');
			expect(secondBody).toContain('"type":"tool_result"');
			expect(secondBody).toContain('"content":"hi"');
		} finally {
			if (previousKey === undefined) delete process.env[envName];
			else process.env[envName] = previousKey;
		}
	});

	it("maps thinking-off and fast mode to Anthropic-native request controls", async () => {
		const bodies: Record<string, unknown>[] = [];
		const paths: string[] = [];
		const authorizationHeaders: Array<string | null> = [];
		const apiKeyHeaders: Array<string | null> = [];
		const betaHeaders: Array<string | null> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				paths.push(new URL(request.url).pathname);
				authorizationHeaders.push(request.headers.get("authorization"));
				apiKeyHeaders.push(request.headers.get("x-api-key"));
				betaHeaders.push(request.headers.get("anthropic-beta"));
				bodies.push(z.record(z.string(), z.unknown()).parse(await request.json()));
				return Response.json({
					content: [{ type: "text", text: "done" }],
					usage: { input_tokens: 2, output_tokens: 1 },
				});
			},
		});
		testServers.push(server);
		const apiKeyEnv = "AAA_AGENT_TEST_MINIMAX_KEY";
		const baseUrlEnv = "AAA_AGENT_TEST_MINIMAX_URL";
		const previousKey = process.env[apiKeyEnv];
		const previousUrl = process.env[baseUrlEnv];
		process.env[apiKeyEnv] = "token-plan-key";
		process.env[baseUrlEnv] = `${server.url.toString().replace(/\/$/, "")}/anthropic/`;
		try {
			const model: Model = {
				provider: "minimax-token-test",
				id: "MiniMax-M3",
				name: "MiniMax M3",
				api: "anthropic-messages",
				baseUrl: "https://invalid.example/anthropic",
				baseUrlEnv,
				contextWindow: 1_000_000,
				efforts: [Effort.High],
				servicePlan: "token-plan",
				authChannel: "api_key",
				effortFormat: "anthropic_thinking_toggle",
				supportsThinkingOff: true,
				serviceTiers: ["priority"],
				apiKeyEnv,
				apiKeyHeader: "bearer",
			};
			await createAgentTurnProvider(model).runTurn({
				model,
				systemPrompt: "system",
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
				tools: [],
				effort: Effort.High,
				disableReasoning: true,
				serviceTier: "priority",
				sessionId: "session",
				signal: AbortSignal.timeout(5_000),
			});
			expect(paths).toEqual(["/anthropic/v1/messages"]);
			expect(authorizationHeaders).toEqual(["Bearer token-plan-key"]);
			expect(apiKeyHeaders).toEqual([null]);
			expect(betaHeaders[0]).toContain("fast-mode-2026-02-01");
			expect(bodies[0]?.thinking).toEqual({ type: "disabled" });
			expect(bodies[0]?.speed).toBe("fast");
			expect(bodies[0]?.output_config).toBeUndefined();
			const planVariant = createAdaptiveModelVariant(model, Effort.High);
			expect(planVariant.servicePlan).toBe("token-plan");
			expect(planVariant.endpoint).toBe(`${server.url.toString().replace(/\/$/, "")}/anthropic`);
		} finally {
			if (previousKey === undefined) delete process.env[apiKeyEnv];
			else process.env[apiKeyEnv] = previousKey;
			if (previousUrl === undefined) delete process.env[baseUrlEnv];
			else process.env[baseUrlEnv] = previousUrl;
		}
	});
});

describe("model-aware efficiency control", () => {
	it("compensates for weak profiles without reducing model capability", () => {
		const features = inferTaskFeatures("Update multiple files with a checklist");
		const weak = createDefaultCapabilityProfile(variant, {
			toolSchemaReliability: 0.3,
			planningHorizon: 0.3,
			parallelToolReliability: 0.2,
			latencyClass: 0.3,
			costClass: 0.3,
		});
		const weakRoute = routeTask(features, weak);
		expect(weakRoute.policy.toolSurface).toBe("standard");
		expect(weakRoute.policy.toolBudget).toBeGreaterThan(10);
		expect(weakRoute.policy.budget.maxTurns).toBeGreaterThan(30);
		expect(weakRoute.policy.budget).not.toHaveProperty("maxTokens");
		expect(weakRoute.policy.maxRepeatedToolCalls).toBe(3);
		expect(weakRoute.reasons.join(" ")).toContain("compensate");

		const strong = createDefaultCapabilityProfile(variant, {
			toolSchemaReliability: 0.9,
			planningHorizon: 0.9,
			parallelToolReliability: 0.9,
		});
		const strongRoute = routeTask(features, strong);
		expect(strongRoute.policy.toolSurface).toBe("full");
		expect(strongRoute.policy.toolBudget).toBe(10);
		const directRoute = routeTask(inferTaskFeatures("Explain this value"), strong);
		expect(directRoute.policy.lane).toBe("direct");
		expect(directRoute.policy.budget).not.toHaveProperty("maxTokens");
	});

	it("preserves explicit thinking choices across risk floors and overlays", () => {
		const model = {
			provider: "thinking-test",
			id: "thinking-model",
			api: "openai-responses" as const,
			baseUrl: "https://api.example.test/v1",
			efforts: [Effort.Low, Effort.High],
			supportsThinkingOff: true,
		};
		const destructive = inferTaskFeatures("Delete and rewrite the authentication implementation");
		const offVariant = createModelVariant(model, {
			authChannel: "api_key",
			reasoningConfig: "off",
			toolSchemaVersion: "4",
		});
		const offRoute = routeTask(
			destructive,
			createDefaultCapabilityProfile(offVariant),
			{ reasoningEffort: Effort.High },
			[],
			offVariant,
		);
		expect(offRoute.policy.disableReasoning).toBe(true);

		const lowVariant = createModelVariant(model, {
			authChannel: "api_key",
			reasoningConfig: Effort.Low,
			toolSchemaVersion: "4",
		});
		const lowRoute = routeTask(
			destructive,
			createDefaultCapabilityProfile(lowVariant),
			{ reasoningEffort: Effort.High },
			[],
			lowVariant,
		);
		expect(lowRoute.policy.reasoningEffort).toBe(Effort.Low);
		expect(lowRoute.policy.disableReasoning).toBeUndefined();
	});

	it("keeps extra recovery headroom for quota-backed models", () => {
		const planVariant = createModelVariant(
			{
				provider: "minimax-token",
				id: "MiniMax-M3",
				api: "anthropic-messages",
				baseUrl: "https://api.minimax.io/anthropic",
				efforts: [Effort.High],
				servicePlan: "token-plan",
			},
			{ authChannel: "api_key", reasoningConfig: "high", toolSchemaVersion: "3" },
		);
		const profile = createDefaultCapabilityProfile(planVariant);
		const route = routeTask(
			inferTaskFeatures("Update multiple files with a checklist"),
			profile,
			{},
			[],
			planVariant,
		);
		expect(route.policy.lane).toBe("guided");
		expect(route.policy.toolBudget).toBe(14);
		expect(route.policy.maxConsecutiveToolFailures).toBe(3);
		expect(route.policy.budget.maxTurns).toBe(30);
		expect(route.reasons.join(" ")).toContain("preserves completion headroom");
	});

	it("progressively exposes a gated tool and records the escalation", async () => {
		let turns = 0;
		const provider: AgentTurnProvider = {
			provider: "test",
			async runTurn() {
				turns += 1;
				if (turns === 1) {
					return {
						output: [{ type: "function_call", call_id: "gated-1", name: "gated", arguments: "{}" }],
						text: "",
						toolCalls: [{ callId: "gated-1", name: "gated", arguments: "{}" }],
						usage: { ...createEmptyUsageMetrics(), inputTokens: 5 },
					};
				}
				return {
					output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "complete" }] }],
					text: "complete",
					toolCalls: [],
					usage: { ...createEmptyUsageMetrics(), outputTokens: 2 },
				};
			},
		};
		const emptySchema = z.object({});
		const baseTool: AgentTool = {
			name: "base",
			label: "Base",
			description: "Base tool.",
			parameters: emptySchema,
			async execute() {
				return { content: [{ type: "text", text: "base" }] };
			},
		};
		const gatedTool: AgentTool = {
			name: "gated",
			label: "Gated",
			description: "Gated tool.",
			parameters: emptySchema,
			async execute() {
				return { content: [{ type: "text", text: "gated" }] };
			},
		};
		const events: AgentSessionEvent[] = [];
		const model: Model = {
			provider: "test",
			id: "test",
			name: "Test",
			api: "openai-responses",
			baseUrl: "https://example.test/v1",
			contextWindow: 8_000,
			efforts: [Effort.Low],
			authChannel: "local",
		};
		const session = await runAgentSession({
			model,
			provider,
			cwd: process.cwd(),
			systemPrompt: "system",
			userPrompt: "task",
			tools: [baseTool],
			escalationTools: [baseTool, gatedTool],
			policy: {
				reasoningEffort: Effort.Low,
				toolBudget: 3,
				maxTurns: 3,
				maxRepeatedToolCalls: 2,
				maxConsecutiveToolFailures: 2,
			},
			signal: AbortSignal.timeout(5_000),
			onEvent: event => events.push(event),
		});
		expect(session.success).toBe(true);
		expect(session.diagnostics.policyEscalations).toBe(1);
		expect(session.diagnostics.tools.gated?.successes).toBe(1);
		expect(events.some(event => event.type === "policy_escalated")).toBe(true);
	});

	it("derives capability evidence and reports quality, token, latency, and cost together", () => {
		const metrics: HarnessRunMetrics = {
			...createEmptyUsageMetrics(),
			inputTokens: 30_000,
			outputTokens: 2_000,
			costUsd: 0.5,
			toolCalls: 4,
			startedAt: 1_000,
			completedAt: 61_000,
			subagentSpawns: 0,
			subagentTokens: 0,
			verificationAttempts: 1,
			falseCompletion: false,
			success: true,
		};
		const observation = deriveCapabilityObservation({
			primary: {
				success: true,
				output: "done",
				usage: metrics,
				diagnostics: {
					toolArgumentFailures: 1,
					unknownToolCalls: 0,
					toolExecutionFailures: 1,
					repeatedToolCalls: 0,
					successfulToolCalls: 3,
					recoveredToolFailures: 1,
					policyEscalations: 0,
					turns: 3,
					tools: { edit: { successes: 1, failures: 0 } },
				},
			},
			result: { success: true, metrics },
			audit: {
				kind: "task",
				outcome: "complete",
				integrity: "clean",
				summary: "pass",
				completedGoalIds: ["root"],
				findings: [],
				unmetCriteria: [],
				evidence: [],
				goalEvidence: [],
				assurance: "correlated",
				usage: createEmptyUsageMetrics(),
			},
			taskSlice: "coding",
			subagents: [],
		});
		expect(observation.values.toolSchemaReliability).toBeCloseTo(0.75);
		expect(observation.values.editReliability).toBe(1);
		expect(observation.values.recoveryReliability).toBeCloseTo(0.5);
		expect(observation.values.longContextUtilization).toBeUndefined();

		const records: HarnessRunRecord[] = [
			{ variantKey: "model-a", provider: "a", modelId: "a", lane: "direct", recordedAt: 1, metrics },
			{
				variantKey: "model-a",
				provider: "a",
				modelId: "a",
				lane: "guided",
				recordedAt: 2,
				metrics: { ...metrics, success: false, falseCompletion: true, inputTokens: 10_000 },
			},
		];
		const summary = summarizeRuns(records)[0];
		expect(summary?.verifiedSuccessRate).toBe(0.5);
		expect(summary?.falseCompletionRate).toBe(0.5);
		expect(summary?.averageActiveTokens).toBe(22_000);
		expect(formatRunReport(records)).toContain("success");
		expect(formatRunReport(records)).toContain("model-a");
	});

	it("learns outcome reliability only from independent or deterministic verification", () => {
		const metrics: HarnessRunMetrics = {
			...createEmptyUsageMetrics(),
			startedAt: 1,
			completedAt: 2,
			subagentSpawns: 0,
			subagentTokens: 0,
			verificationAttempts: 1,
			falseCompletion: false,
			success: true,
		};
		const correlatedAudit = {
			kind: "task" as const,
			outcome: "complete" as const,
			integrity: "clean" as const,
			summary: "correlated pass",
			completedGoalIds: ["root"],
			findings: [],
			unmetCriteria: [],
			evidence: [{ kind: "file" as const, ref: "src/result.ts", summary: "result passed" }],
			goalEvidence: [],
			assurance: "correlated" as const,
			usage: createEmptyUsageMetrics(),
		};
		const primary = { success: true, output: "done", usage: metrics };
		const correlated = deriveCapabilityObservation({
			primary,
			result: { success: true, metrics },
			audit: correlatedAudit,
			taskSlice: "coding",
			subagents: [],
		});
		const independent = deriveCapabilityObservation({
			primary,
			result: { success: true, metrics },
			audit: { ...correlatedAudit, assurance: "independent" },
			taskSlice: "coding",
			subagents: [],
		});
		expect(correlated.quality).toBe("behavioral");
		expect(correlated.values.verificationReliability).toBeUndefined();
		expect(independent.quality).toBe("audited");
		expect(independent.values.verificationReliability).toBe(1);
		expect(mergeVerifiedFacts([], correlatedAudit)).toEqual([]);
		expect(mergeVerifiedFacts([], { ...correlatedAudit, assurance: "independent" })).toEqual([]);
		expect(
			mergeVerifiedFacts([], {
				...correlatedAudit,
				assurance: "independent",
				verifiedFacts: [
					{
						verifiedAt: 1,
						statement: "The result satisfies its contract.",
						evidence: [{ kind: "file", ref: "src/result.ts", summary: "result passed" }],
					},
				],
			}),
		).toMatchObject([
			{ statement: "The result satisfies its contract.", evidence: [{ kind: "file", ref: "src/result.ts" }] },
		]);
	});
});

describe("long-horizon task control", () => {
	it("retries from audited recovery guidance and commits only verified completion", async () => {
		const rounds: number[] = [];
		const recovery: Array<string | undefined> = [];
		let audits = 0;
		const checkpoints: LongRunCheckpoint[] = [];
		const capabilities = new ModelCapabilityRegistry();
		const harness = new AdaptiveHarness({
			capabilities,
			executor: {
				async execute(context) {
					rounds.push(context.round);
					recovery.push(context.recoveryGuidance);
					return {
						success: true,
						output: `attempt ${context.round}`,
						usage: createEmptyUsageMetrics(),
						completedGoalIds: ["root"],
					};
				},
				async verify() {
					audits += 1;
					if (audits === 1) {
						return {
							passed: false,
							summary: "smoke check failed",
							recommendedRecovery: "Repair the failing smoke path.",
							usage: createEmptyUsageMetrics(),
						};
					}
					return {
						passed: true,
						summary: "smoke check passed",
						evidence: [{ kind: "test", ref: "bun test smoke", summary: "smoke passed" }],
						hostEvidence: [{ kind: "test", ref: "bun test smoke", summary: "smoke passed" }],
						verifiedFacts: [
							{
								statement: "smoke passed",
								evidence: [{ kind: "test", ref: "bun test smoke", summary: "smoke passed" }],
							},
						],
						assurance: "independent",
						usage: createEmptyUsageMetrics(),
					};
				},
			},
		});
		const result = await harness.run({
			task: "Implement a multi-file change",
			model: variant,
			featureHints: { estimatedFiles: 2, writesWorkspace: true },
			onCheckpoint(checkpoint) {
				checkpoints.push(checkpoint);
			},
		});
		expect(result.success).toBe(true);
		expect(rounds).toEqual([1, 2]);
		expect(recovery).toEqual([undefined, "Repair the failing smoke path."]);
		expect(result.audit?.outcome).toBe("complete");
		expect(result.goalReport.complete).toBe(true);
		expect(result.checkpoint.status).toBe("completed");
		expect(result.checkpoint.facts[0]?.statement).toBe("smoke passed");
		expect(result.checkpoint.audits).toHaveLength(2);
		expect(result.metrics.falseCompletion).toBe(true);
		expect(result.metrics.recoveryRounds).toBe(1);
		expect(checkpoints.map(checkpoint => checkpoint.status)).toContain("running");
		expect(checkpoints.at(-1)?.status).toBe("completed");
		expect(
			capabilities
				.list()
				.map(profile => profile.taskSlice)
				.sort(),
		).toEqual(["coding", "global"]);
		expect(result.capabilityObservation?.quality).toBe("deterministic");
		expect(result.capabilityObservation?.values.verificationReliability).toBe(1);
		expect(result.capabilityObservation?.values.recoveryReliability).toBeUndefined();
	});

	it("resumes an interrupted checkpoint with its original policy snapshot", async () => {
		let checkpoint: LongRunCheckpoint | undefined;
		const capabilities = new ModelCapabilityRegistry();
		const interruptedHarness = new AdaptiveHarness({
			capabilities,
			executor: {
				async execute() {
					throw new Error("provider disconnected");
				},
			},
		});
		await expect(
			interruptedHarness.run({
				task: "Implement a multi-file change",
				model: variant,
				featureHints: { estimatedFiles: 2, writesWorkspace: true },
				onCheckpoint(value) {
					checkpoint = value;
				},
			}),
		).rejects.toThrow("provider disconnected");
		expect(checkpoint?.status).toBe("interrupted");
		expect(checkpoint?.currentRound).toBe(0);
		expect(checkpoint?.inFlightRound).toBe(1);
		if (!checkpoint) throw new Error("Expected an interrupted checkpoint");
		const frozenPlanningHorizon = checkpoint.policySnapshot.profile.planningHorizon;
		capabilities.observe(variant, {
			taskSlice: "coding",
			values: { planningHorizon: 0 },
			quality: "deterministic",
			weight: 100,
		});
		const resumedRounds: number[] = [];
		const resumedProfiles: number[] = [];
		const resumedHarness = new AdaptiveHarness({
			capabilities,
			executor: {
				async execute(context) {
					resumedRounds.push(context.round);
					resumedProfiles.push(context.profile.planningHorizon);
					return {
						success: true,
						output: "recovered",
						usage: createEmptyUsageMetrics(),
						completedGoalIds: ["root"],
					};
				},
				async verify() {
					return {
						passed: true,
						summary: "verified after resume",
						evidence: [{ kind: "test", ref: "resume-smoke", summary: "resume passed" }],
						hostEvidence: [{ kind: "test", ref: "resume-smoke", summary: "resume passed" }],
						usage: createEmptyUsageMetrics(),
					};
				},
			},
		});
		const result = await resumedHarness.run({
			task: checkpoint.task,
			model: variant,
			checkpoint,
		});
		expect(result.success).toBe(true);
		expect(resumedRounds).toEqual([1]);
		expect(resumedProfiles).toEqual([frozenPlanningHorizon]);
		expect(result.route).toEqual(checkpoint.policySnapshot.route);
	});

	it("replays an interrupted final round instead of exhausting recovery", async () => {
		let checkpoint: LongRunCheckpoint | undefined;
		const interruptedHarness = new AdaptiveHarness({
			executor: {
				async execute() {
					throw new Error("provider disconnected");
				},
			},
		});
		await expect(
			interruptedHarness.run({
				task: "Implement a multi-file change",
				model: variant,
				featureHints: { estimatedFiles: 2, writesWorkspace: true },
				onCheckpoint(value) {
					checkpoint = value;
				},
			}),
		).rejects.toThrow("provider disconnected");
		if (!checkpoint) throw new Error("Expected interrupted checkpoint");
		checkpoint.currentRound = checkpoint.maxRounds - 1;
		checkpoint.inFlightRound = checkpoint.maxRounds;
		const rounds: number[] = [];
		const resumedHarness = new AdaptiveHarness({
			executor: {
				async execute(context) {
					rounds.push(context.round);
					return {
						success: true,
						output: "recovered",
						completedGoalIds: ["root"],
						usage: createEmptyUsageMetrics(),
					};
				},
				async verify() {
					return {
						passed: true,
						summary: "verified",
						evidence: [{ kind: "test", ref: "resume-final", summary: "passed" }],
						hostEvidence: [{ kind: "test", ref: "resume-final", summary: "passed" }],
						usage: createEmptyUsageMetrics(),
					};
				},
			},
		});
		const result = await resumedHarness.run({ task: checkpoint.task, model: variant, checkpoint });
		expect(rounds).toEqual([checkpoint.maxRounds]);
		expect(result.success).toBe(true);
		expect(result.checkpoint.inFlightRound).toBeUndefined();
	});

	it("persists a resumable interruption when cancellation lands on final completion", async () => {
		const controller = new AbortController();
		let checkpoint: LongRunCheckpoint | undefined;
		const harness = new AdaptiveHarness({
			executor: {
				async execute() {
					return {
						success: true,
						output: "implemented",
						completedGoalIds: ["root"],
						usage: createEmptyUsageMetrics(),
					};
				},
				async verify() {
					return {
						passed: true,
						summary: "verified before cancellation",
						evidence: [{ kind: "test", ref: "final-round", summary: "final round verified" }],
						hostEvidence: [{ kind: "test", ref: "final-round", summary: "final round verified" }],
						verifiedFacts: [
							{
								statement: "final round verified",
								evidence: [{ kind: "test", ref: "final-round", summary: "final round verified" }],
							},
						],
						assurance: "independent",
						usage: createEmptyUsageMetrics(),
					};
				},
			},
		});
		const interruption = await harness
			.run({
				task: "Implement a multi-file change",
				model: variant,
				featureHints: { estimatedFiles: 2, writesWorkspace: true },
				signal: controller.signal,
				onCheckpoint(value) {
					checkpoint = value;
					if (value.status === "completed") controller.abort("cancel after completion checkpoint");
				},
			})
			.then(
				() => undefined,
				error => error as Error,
			);
		expect(interruption?.name).toBe("AbortError");
		expect(checkpoint?.status).toBe("interrupted");
		expect(checkpoint?.currentRound).toBe(0);
		expect(checkpoint?.inFlightRound).toBe(1);
		expect(checkpoint?.facts.map(fact => fact.statement)).toEqual(["final round verified"]);
		if (!checkpoint) throw new Error("Expected interrupted checkpoint");

		const resumed = await new AdaptiveHarness({
			executor: {
				async execute() {
					return {
						success: true,
						output: "replayed",
						completedGoalIds: ["root"],
						usage: createEmptyUsageMetrics(),
					};
				},
				async verify() {
					return {
						passed: true,
						summary: "replay verified",
						evidence: [{ kind: "test", ref: "final-replay", summary: "replay passed" }],
						hostEvidence: [{ kind: "test", ref: "final-replay", summary: "replay passed" }],
						usage: createEmptyUsageMetrics(),
					};
				},
			},
		}).run({ task: checkpoint.task, model: variant, checkpoint });
		expect(resumed.success).toBe(true);
		expect(resumed.checkpoint.status).toBe("completed");
		expect(resumed.checkpoint.inFlightRound).toBeUndefined();
	});

	it("distinguishes a harness deadline from execution failure and checkpoints the interruption", async () => {
		const overlays = new AdaptiveOverlayRegistry();
		overlays.register({
			id: "short-deadline",
			scope: "universal",
			priority: 1,
			selector: {},
			policy: { budget: { deadlineMs: 10 } },
			version: 1,
		});
		let checkpoint: LongRunCheckpoint | undefined;
		const harness = new AdaptiveHarness({
			overlays,
			executor: {
				async execute() {
					return await new Promise<never>(() => {});
				},
			},
		});
		const interruption = await harness
			.run({
				task: "Explain this function",
				model: variant,
				onCheckpoint(value) {
					checkpoint = value;
				},
			})
			.then(
				() => undefined,
				error => error as Error,
			);
		expect(interruption?.name).toBe("TimeoutError");
		expect(checkpoint?.status).toBe("interrupted");
		expect(checkpoint?.currentRound).toBe(0);
		expect(checkpoint?.inFlightRound).toBe(1);
	});

	it("keeps unverified success signals out of capability success scores", async () => {
		const capabilities = new ModelCapabilityRegistry();
		const harness = new AdaptiveHarness({
			capabilities,
			executor: {
				async execute() {
					return {
						success: true,
						output: "answer",
						usage: createEmptyUsageMetrics(),
						completedGoalIds: ["root"],
					};
				},
			},
		});
		const result = await harness.run({ task: "Explain this function", model: variant });
		expect(result.success).toBe(true);
		expect(result.audit).toBeUndefined();
		expect(result.capabilityObservation?.quality).toBe("behavioral");
		expect(result.capabilityObservation?.values.instructionRetention).toBeUndefined();
	});
});

describe("task-sliced capability learning", () => {
	it("separates task slices and exposes confidence without trusting sparse samples as universal", () => {
		const registry = new ModelCapabilityRegistry();
		registry.observe(variant, {
			taskSlice: "coding",
			values: { planningHorizon: 0.1 },
			quality: "audited",
			weight: 2,
		});
		registry.observe(variant, {
			taskSlice: "debugging",
			values: { planningHorizon: 0.9 },
			quality: "audited",
			weight: 2,
		});
		const coding = registry.resolve(variant, "coding");
		const debugging = registry.resolve(variant, "debugging");
		expect(coding.planningHorizon).toBeLessThan(debugging.planningHorizon);
		expect(coding.confidence.planningHorizon).toBeGreaterThan(0);
		expect(coding.negativeEvidence.planningHorizon).toBeGreaterThan(0);
		expect(debugging.positiveEvidence.planningHorizon).toBeGreaterThan(0);
		expect(registry.resolve(variant, "research").planningHorizon).toBe(registry.resolve(variant).planningHorizon);
	});

	it("classifies stable coarse task slices", () => {
		const debugging = inferTaskFeatures("Debug the failing authentication test");
		const research = inferTaskFeatures("Research and compare three sources");
		const longRun = inferTaskFeatures("Implement a migration", { estimatedFiles: 5, estimatedSteps: 6 });
		expect(inferTaskSlice("Debug the failing authentication test", debugging)).toBe("debugging");
		expect(inferTaskSlice("Research and compare three sources", research)).toBe("research");
		expect(inferTaskSlice("Implement a migration", longRun)).toBe("long-horizon");
	});
});

describe("adaptive controls", () => {
	it("uses static priors and records no observation while adaptation is off", async () => {
		const capabilities = new ModelCapabilityRegistry();
		capabilities.observe(variant, {
			taskSlice: "coding",
			values: { planningHorizon: 0 },
			quality: "deterministic",
			weight: 100,
		});
		let routedPlanningHorizon: number | undefined;
		const harness = new AdaptiveHarness({
			capabilities,
			executor: {
				async execute(context) {
					routedPlanningHorizon = context.profile.planningHorizon;
					return {
						success: true,
						output: "answer",
						usage: createEmptyUsageMetrics(),
						completedGoalIds: ["root"],
					};
				},
			},
		});
		const storedBefore = capabilities.list();
		const result = await harness.run({
			task: "Explain this function",
			model: variant,
			adaptive: false,
		});
		expect(routedPlanningHorizon).toBe(0.55);
		expect(result.capabilityObservation).toBeUndefined();
		expect(capabilities.list()).toEqual(storedBefore);
	});
});
