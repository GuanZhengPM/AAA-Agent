#!/usr/bin/env bun

import * as readline from "node:readline/promises";

import {
	assertModelSupportsServiceTier,
	assertModelSupportsThinkingMode,
	type CodexAuthSession,
	createAdaptiveModelVariant,
	createAgentTurnProvider,
	describeOpenAICodexAuth,
	listModels,
	loginOpenAICodex,
	logoutOpenAICodex,
	modelAuthenticationReady,
	openAdaptiveAuthSession,
	resolveDefaultThinkingMode,
	resolveSelectedModel,
	resolveServiceTier,
	setDefaultModel,
	supportedThinkingModes,
} from "@aaa-agent/providers";
import {
	type AdaptiveHarnessResult,
	type AdaptiveHarnessState,
	AdaptiveOverlayRegistry,
	appendRunRecord,
	createDefaultCapabilityProfile,
	inferTaskFeatures,
	inferTaskSlice,
	loadAdaptiveHarnessState,
	type Model,
	ModelCapabilityRegistry,
	routeTask,
	SERVICE_TIERS,
	type ServiceTier,
	saveAdaptiveHarnessState,
	THINKING_MODES,
	type ThinkingMode,
} from "@aaa-agent/runtime";
import type { ShellApprovalRequest } from "@aaa-agent/workspace";
import { createHistorySearchTool } from "./history-tool";
import { runInteractiveTerminal } from "./interactive";
import { formatRunReport, summarizeRuns } from "./run-report";
import { type AdaptiveSubagentOptions, type AdaptiveVerifierOptions, runAdaptiveTask } from "./runtime";
import {
	findRecentInteractiveSession,
	listInteractiveSessions,
	loadInteractiveSession,
	saveInteractiveSession,
	searchInteractiveSessions,
} from "./session-store";

import { TaskTerminalReporter } from "./terminal";

const HELP = `AAA Agent (3A Agent) — interactive, model-aware coding agent

Usage:
  aaa
  aaa chat [--resume [id] | --new] [--model <id>] [--verifier-model <id>] [--subagent-model <id>] [--effort <mode>] [--tier <tier> | --fast] [--cwd <path>]
  aaa run [--model <id>] [--verifier-model <id>] [--subagent-model <id>] [--effort <mode>] [--tier <tier> | --fast] [--shell-policy <deny|ask|sandbox|allow>] [--cwd <path>] [--verbose] <task>
  aaa sessions [query]
  aaa models
  aaa providers
  aaa use <provider/model-id>
  aaa route [--model <id>] [--effort <mode>] [--tier <tier> | --fast] <task>
  aaa metrics [--json]
  aaa adaptive [status|on|off|reset]
  aaa auth <login|status|logout>

No arguments starts a persistent interactive session. The run command remains
available for scripts and reads the task from stdin when omitted.
Shell policy defaults to deny for one-shot runs; interactive sessions always ask.
Thinking modes: ${THINKING_MODES.join(", ")}
Service tiers: ${SERVICE_TIERS.join(", ")}
`;

const SHELL_POLICIES = ["deny", "ask", "sandbox", "allow"] as const;
type ShellPolicy = (typeof SHELL_POLICIES)[number];

interface RunArguments {
	modelId?: string;
	verifierModelId?: string;
	subagentModelId?: string;
	thinkingMode?: ThinkingMode;
	serviceTier?: ServiceTier;
	cwd: string;
	task: string;
	verbose: boolean;
	shellPolicy: ShellPolicy;
}

interface SessionArguments extends Omit<RunArguments, "task" | "verbose" | "shellPolicy"> {
	resume?: string | true;
	fresh: boolean;
}

function parseThinkingMode(value: string): ThinkingMode {
	const mode = THINKING_MODES.find(candidate => candidate === value);
	if (!mode) throw new Error(`Unknown thinking mode '${value}'. Expected one of: ${THINKING_MODES.join(", ")}`);
	return mode;
}

function parseServiceTier(value: string): ServiceTier {
	const tier = SERVICE_TIERS.find(candidate => candidate === value);
	if (!tier) throw new Error(`Unknown service tier '${value}'. Expected one of: ${SERVICE_TIERS.join(", ")}`);
	return tier;
}

function parseShellPolicy(value: string): ShellPolicy {
	const policy = SHELL_POLICIES.find(candidate => candidate === value);
	if (!policy) throw new Error(`Unknown shell policy '${value}'. Expected one of: ${SHELL_POLICIES.join(", ")}`);
	return policy;
}

async function parseRunArguments(args: string[], allowStdin: boolean): Promise<RunArguments> {
	let modelId: string | undefined;
	let verifierModelId: string | undefined;
	let subagentModelId: string | undefined;
	let thinkingMode: ThinkingMode | undefined;
	let serviceTier: ServiceTier | undefined;
	let cwd = process.cwd();
	let verbose = false;
	let shellPolicy: ShellPolicy = "deny";
	const taskParts: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--model") {
			const value = args[++index];
			if (!value) throw new Error("--model requires a value");
			modelId = value;
			continue;
		}
		if (arg === "--verifier-model") {
			const value = args[++index];
			if (!value) throw new Error("--verifier-model requires a value");
			verifierModelId = value;
			continue;
		}
		if (arg === "--subagent-model") {
			const value = args[++index];
			if (!value) throw new Error("--subagent-model requires a value");
			subagentModelId = value;
			continue;
		}
		if (arg === "--effort") {
			const value = args[++index];
			if (!value) throw new Error("--effort requires a value");
			thinkingMode = parseThinkingMode(value);
			continue;
		}
		if (arg === "--tier") {
			const value = args[++index];
			if (!value) throw new Error("--tier requires a value");
			serviceTier = parseServiceTier(value);
			continue;
		}
		if (arg === "--fast") {
			serviceTier = "priority";
			continue;
		}
		if (arg === "--cwd") {
			const value = args[++index];
			if (!value) throw new Error("--cwd requires a value");
			cwd = value;
			continue;
		}
		if (arg === "--shell-policy") {
			const value = args[++index];
			if (!value) throw new Error("--shell-policy requires a value");
			shellPolicy = parseShellPolicy(value);
			continue;
		}
		if (arg === "--verbose") {
			verbose = true;
			continue;
		}
		if (arg?.startsWith("--")) throw new Error(`Unknown option '${arg}'`);
		if (arg) taskParts.push(arg);
	}
	let task = taskParts.join(" ").trim();
	if (!task && allowStdin && !process.stdin.isTTY) task = (await Bun.stdin.text()).trim();
	if (!task) throw new Error("A task is required. Pass it as arguments or pipe it on stdin.");
	return {
		...(modelId ? { modelId } : {}),
		...(verifierModelId ? { verifierModelId } : {}),
		...(subagentModelId ? { subagentModelId } : {}),
		...(thinkingMode ? { thinkingMode } : {}),
		...(serviceTier ? { serviceTier } : {}),
		cwd,
		task,
		verbose,
		shellPolicy,
	};
}

async function parseSessionArguments(args: string[]): Promise<SessionArguments> {
	let modelId: string | undefined;
	let verifierModelId: string | undefined;
	let subagentModelId: string | undefined;
	let thinkingMode: ThinkingMode | undefined;
	let serviceTier: ServiceTier | undefined;
	let cwd = process.cwd();
	let resume: string | true | undefined;
	let fresh = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--model") {
			const value = args[++index];
			if (!value) throw new Error("--model requires a value");
			modelId = value;
		} else if (arg === "--verifier-model") {
			const value = args[++index];
			if (!value) throw new Error("--verifier-model requires a value");
			verifierModelId = value;
		} else if (arg === "--subagent-model") {
			const value = args[++index];
			if (!value) throw new Error("--subagent-model requires a value");
			subagentModelId = value;
		} else if (arg === "--effort") {
			const value = args[++index];
			if (!value) throw new Error("--effort requires a value");
			thinkingMode = parseThinkingMode(value);
		} else if (arg === "--tier") {
			const value = args[++index];
			if (!value) throw new Error("--tier requires a value");
			serviceTier = parseServiceTier(value);
		} else if (arg === "--fast") {
			serviceTier = "priority";
		} else if (arg === "--cwd") {
			const value = args[++index];
			if (!value) throw new Error("--cwd requires a value");
			cwd = value;
		} else if (arg === "--resume") {
			const value = args[index + 1];
			if (value && !value.startsWith("--")) {
				resume = value;
				index += 1;
			} else {
				resume = true;
			}
		} else if (arg === "--new") {
			fresh = true;
		} else {
			throw new Error(`Unknown interactive option '${arg}'.`);
		}
	}
	if (fresh && resume) throw new Error("--new and --resume cannot be used together.");
	return {
		...(modelId ? { modelId } : {}),
		...(verifierModelId ? { verifierModelId } : {}),
		...(subagentModelId ? { subagentModelId } : {}),
		...(thinkingMode ? { thinkingMode } : {}),
		...(serviceTier ? { serviceTier } : {}),
		...(resume ? { resume } : {}),
		fresh,
		cwd,
	};
}

function resolveRunThinkingMode(
	model: Model,
	requested: ThinkingMode | undefined,
	fallback: ThinkingMode | undefined,
): ThinkingMode {
	if (requested) {
		assertModelSupportsThinkingMode(model, requested);
		return requested;
	}
	return resolveDefaultThinkingMode(model, fallback);
}

function resolveRunServiceTier(
	model: Model,
	requested: ServiceTier | undefined,
	fallback: ServiceTier | undefined,
): ServiceTier | undefined {
	if (requested) {
		assertModelSupportsServiceTier(model, requested);
		return requested;
	}
	return resolveServiceTier(model, fallback);
}

async function resolveVerifierOptions(
	modelId: string | undefined,
	authSession: CodexAuthSession,
): Promise<AdaptiveVerifierOptions | undefined> {
	if (!modelId) return undefined;
	const model = await resolveSelectedModel(modelId);
	if (!modelAuthenticationReady(model, authSession)) {
		throw new Error(`Verifier model ${model.provider}/${model.id} is not authenticated.`);
	}
	return {
		model,
		provider: createAgentTurnProvider(model, authSession),
		reasoningConfig: resolveDefaultThinkingMode(model),
	};
}

async function resolveSubagentOptions(
	modelId: string | undefined,
	authSession: CodexAuthSession,
): Promise<AdaptiveSubagentOptions | undefined> {
	if (!modelId) return undefined;
	const model = await resolveSelectedModel(modelId);
	if (!modelAuthenticationReady(model, authSession)) {
		throw new Error(`Subagent model ${model.provider}/${model.id} is not authenticated.`);
	}
	return {
		model,
		provider: createAgentTurnProvider(model, authSession),
		reasoningConfig: resolveDefaultThinkingMode(model),
	};
}

async function createRegistries() {
	const state = await loadAdaptiveHarnessState();
	const capabilities = new ModelCapabilityRegistry();
	for (const profile of state.profiles) capabilities.register(profile);
	const overlays = new AdaptiveOverlayRegistry();
	for (const overlay of state.overlays) overlays.register(overlay);
	return { state, capabilities, overlays };
}

function authenticationLabel(model: Model, authSession: CodexAuthSession): string {
	const channel = model.authChannel ?? (model.api === "codex-responses" ? "subscription" : "api_key");
	if (channel === "subscription") {
		const identity = authSession.identity();
		return identity?.email ?? identity?.accountId ?? "Codex OAuth missing";
	}
	if (channel === "local") return "local endpoint";
	const envName = model.apiKeyEnv ?? "OPENAI_API_KEY";
	return process.env[envName]?.trim() ? `API key ${envName}` : `missing ${envName}`;
}

async function persistRun(
	state: AdaptiveHarnessState,
	capabilities: ModelCapabilityRegistry,
	overlays: AdaptiveOverlayRegistry,
	model: Model,
	thinkingMode: ThinkingMode,
	serviceTier: ServiceTier | undefined,
	result: AdaptiveHarnessResult,
): Promise<void> {
	const variant = createAdaptiveModelVariant(model, thinkingMode, serviceTier);
	state.profiles = capabilities.list();
	state.overlays = overlays.list();
	appendRunRecord(state, {
		variantKey: variant.key,
		provider: model.provider,
		modelId: model.id,
		lane: result.lane,
		recordedAt: result.metrics.completedAt,
		metrics: result.metrics,
	});
	await saveAdaptiveHarnessState(state);
}

async function printModels(): Promise<void> {
	const [selected, models] = await Promise.all([resolveSelectedModel(), listModels()]);
	for (const model of models) {
		const modes = supportedThinkingModes(model).join(",");
		const tiers = model.serviceTiers?.join(",") || "standard";
		const key = `${model.provider}/${model.id}`;
		const marker = key === `${selected.provider}/${selected.id}` ? "*" : " ";
		const plan = model.servicePlan ?? (model.authChannel === "subscription" ? "subscription" : "payg");
		process.stdout.write(
			`${marker} ${key.padEnd(40)} ${model.name}  plan=${plan}  api=${model.api}  context=${model.contextWindow}  thinking=${modes}  tiers=${tiers}\n`,
		);
	}
}

async function printProviders(): Promise<void> {
	const authSession = await openAdaptiveAuthSession();
	try {
		const models = await listModels();
		for (const model of models) {
			const key = `${model.provider}/${model.id}`;
			const ready = modelAuthenticationReady(model, authSession) ? "ready" : "missing auth";
			process.stdout.write(
				`${key.padEnd(40)} ${ready.padEnd(12)} ${(model.servicePlan ?? "payg").padEnd(12)} ${authenticationLabel(model, authSession)}\n`,
			);
		}
	} finally {
		authSession.close();
	}
}

async function previewRoute(args: string[]): Promise<void> {
	const parsed = await parseRunArguments(args, true);
	const model = await resolveSelectedModel(parsed.modelId);
	const { state, capabilities, overlays } = await createRegistries();
	const thinkingMode = resolveRunThinkingMode(model, parsed.thinkingMode, state.defaultThinkingMode);
	const serviceTier = resolveRunServiceTier(model, parsed.serviceTier, state.defaultServiceTier);
	const variant = createAdaptiveModelVariant(model, thinkingMode, serviceTier);
	const features = inferTaskFeatures(parsed.task);
	const profile = state.adaptiveEnabled
		? capabilities.resolve(variant, inferTaskSlice(parsed.task, features))
		: createDefaultCapabilityProfile(variant, {}, inferTaskSlice(parsed.task, features));
	const resolved = state.adaptiveEnabled ? overlays.resolve(variant, profile) : { ids: [], policy: {} };
	const decision = routeTask(features, profile, resolved.policy, resolved.ids, variant);
	process.stdout.write(
		`${JSON.stringify({ model: `${model.provider}/${model.id}`, features, profile, decision }, null, 2)}\n`,
	);
}

async function runTask(args: string[]): Promise<void> {
	const parsed = await parseRunArguments(args, true);
	if (parsed.shellPolicy === "ask" && (!process.stdin.isTTY || !process.stderr.isTTY)) {
		throw new Error("--shell-policy ask requires an interactive terminal.");
	}
	const approvalPrompt =
		parsed.shellPolicy === "ask"
			? readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
			: undefined;
	const approveShell = async (request: ShellApprovalRequest): Promise<boolean> => {
		if (parsed.shellPolicy === "allow") return true;
		if (parsed.shellPolicy === "sandbox") return request.sandboxed;
		if (parsed.shellPolicy !== "ask" || !approvalPrompt) return false;
		process.stderr.write(
			`\nShell approval required (${request.reason}):\n  ${request.command}\n  workspace: ${request.cwd}\n  This command can read files outside the workspace.\n`,
		);
		const answer = await approvalPrompt.question("Approve this command? [y/N] ");
		return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
	};
	const model = await resolveSelectedModel(parsed.modelId);
	const authSession = await openAdaptiveAuthSession();
	const { state, capabilities, overlays } = await createRegistries();
	const thinkingMode = resolveRunThinkingMode(model, parsed.thinkingMode, state.defaultThinkingMode);
	const serviceTier = resolveRunServiceTier(model, parsed.serviceTier, state.defaultServiceTier);
	const controller = new AbortController();
	const onInterrupt = (): void => controller.abort("Interrupted");
	const reporter = new TaskTerminalReporter({
		output: process.stdout,
		statusOutput: process.stderr,
		interactive: false,
		showTools: true,
		verbose: parsed.verbose,
	});
	process.once("SIGINT", onInterrupt);
	try {
		const provider = createAgentTurnProvider(model, authSession);
		const verifier = await resolveVerifierOptions(parsed.verifierModelId, authSession);
		const subagent = await resolveSubagentOptions(parsed.subagentModelId, authSession);
		const result = await runAdaptiveTask({
			task: parsed.task,
			model,
			provider,
			cwd: parsed.cwd,
			reasoningConfig: thinkingMode,
			approveShell,
			...(serviceTier ? { serviceTier } : {}),
			...(verifier ? { verifier } : {}),
			...(subagent ? { subagent } : {}),
			capabilities,
			overlays,
			additionalTools: [createHistorySearchTool(parsed.cwd)],
			adaptive: state.adaptiveEnabled,
			signal: controller.signal,
			onEvent: event => reporter.onHarnessEvent(event),
			onAgentEvent: event => reporter.onAgentEvent(event),
		});
		await persistRun(state, capabilities, overlays, model, thinkingMode, serviceTier, result);
		reporter.finish(result);
		if (!result.success) process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", onInterrupt);
		approvalPrompt?.close();
		authSession.close();
	}
}

async function startInteractive(args: string[]): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("Interactive mode requires a terminal. Use 'aaa run' for scripts.");
	}
	const parsed = await parseSessionArguments(args);
	const session = parsed.fresh
		? undefined
		: typeof parsed.resume === "string"
			? await loadInteractiveSession(parsed.resume)
			: await findRecentInteractiveSession(parsed.cwd);
	const models = await listModels();
	const model = await resolveSelectedModel(parsed.modelId ?? session?.modelId);
	const authSession = await openAdaptiveAuthSession();
	const { state, capabilities, overlays } = await createRegistries();
	const thinkingMode = resolveRunThinkingMode(
		model,
		parsed.thinkingMode,
		session?.thinkingMode ?? state.defaultThinkingMode,
	);
	const serviceTier = resolveRunServiceTier(
		model,
		parsed.serviceTier,
		session ? session.serviceTier : state.defaultServiceTier,
	);
	try {
		const verifier = await resolveVerifierOptions(parsed.verifierModelId, authSession);
		const subagent = await resolveSubagentOptions(parsed.subagentModelId, authSession);
		await runInteractiveTerminal({
			model,
			models,
			thinkingMode,
			...(serviceTier ? { serviceTier } : {}),
			cwd: parsed.cwd,
			adaptive: state.adaptiveEnabled,
			async setAdaptive(enabled, reset) {
				state.adaptiveEnabled = enabled;
				if (reset) {
					capabilities.reset();
					state.profiles = [];
					delete state.defaultModelId;
					delete state.defaultThinkingMode;
					delete state.defaultServiceTier;
				}
				await saveAdaptiveHarnessState(state);
			},
			authentication: selectedModel => authenticationLabel(selectedModel, authSession),
			async savePreferences(selectedModel, selectedThinkingMode, selectedServiceTier) {
				state.defaultModelId = `${selectedModel.provider}/${selectedModel.id}`;
				state.defaultThinkingMode = selectedThinkingMode;
				if (selectedServiceTier) state.defaultServiceTier = selectedServiceTier;
				else delete state.defaultServiceTier;
				await saveAdaptiveHarnessState(state);
			},
			...(session ? { session } : {}),
			listSessions: () => listInteractiveSessions(),
			searchSessions: searchInteractiveSessions,
			loadSession: loadInteractiveSession,
			saveSession: saveInteractiveSession,
			async runTask(request) {
				const provider = createAgentTurnProvider(request.model, authSession);
				const result = await runAdaptiveTask({
					task: request.task,
					model: request.model,
					provider,
					sessionId: request.sessionId,
					cwd: request.cwd,
					reasoningConfig: request.thinkingMode,
					...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
					approveShell: request.approveShell,
					...(verifier ? { verifier } : {}),
					...(subagent ? { subagent } : {}),
					capabilities,
					overlays,
					additionalTools: [createHistorySearchTool(request.cwd)],
					conversation: request.conversation,
					...(request.contextState ? { contextState: request.contextState } : {}),
					signal: request.signal,
					onEvent: request.onEvent,
					onAgentEvent: request.onAgentEvent,
					checkpoint: request.checkpoint,
					onCheckpoint: request.onCheckpoint,
					adaptive: request.adaptive,
				});
				await persistRun(
					state,
					capabilities,
					overlays,
					request.model,
					request.thinkingMode,
					request.serviceTier,
					result,
				);
				return result;
			},
		});
	} finally {
		authSession.close();
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.length === 0) {
		if (process.stdin.isTTY && process.stdout.isTTY) await startInteractive([]);
		else await runTask([]);
		return;
	}
	const [command = "", ...args] = argv;
	if (command === "help" || command === "--help" || command === "-h") {
		process.stdout.write(HELP);
		return;
	}
	if (command === "chat") {
		await startInteractive(args);
		return;
	}
	if (command.startsWith("--")) {
		await startInteractive(argv);
		return;
	}
	if (command === "auth") {
		const [action] = args;
		if (action === "login") await loginOpenAICodex();
		else if (action === "status") process.stdout.write(`${await describeOpenAICodexAuth()}\n`);
		else if (action === "logout") await logoutOpenAICodex();
		else throw new Error("Usage: aaa auth <login|status|logout>");
		return;
	}
	if (command === "models") {
		await printModels();
		return;
	}
	if (command === "providers") {
		await printProviders();
		return;
	}
	if (command === "sessions") {
		if (args.length > 0) {
			const matches = await searchInteractiveSessions(args.join(" "), process.cwd());
			if (matches.length === 0) {
				process.stdout.write("No matching conversations.\n");
			} else {
				for (const match of matches) {
					process.stdout.write(
						`${match.session.id}  ${new Date(match.session.updatedAt).toISOString()}  ${match.role}  ${match.session.cwd}\n  ${match.excerpt}\n`,
					);
				}
			}
			return;
		}
		const sessions = await listInteractiveSessions();
		if (sessions.length === 0) {
			process.stdout.write("No resumable sessions.\n");
		} else {
			for (const session of sessions) {
				process.stdout.write(
					`${session.id}  ${new Date(session.updatedAt).toISOString()}  ${session.status.padEnd(11)}  ${String(session.turns).padStart(2)} turns  ${session.modelId}  ${session.cwd}\n`,
				);
			}
		}
		return;
	}
	if (command === "use") {
		const modelId = args[0];
		if (!modelId || args.length !== 1) throw new Error("Usage: aaa use <model-id>");
		const model = await setDefaultModel(modelId);
		process.stdout.write(`Default model: ${model.provider}/${model.id}\n`);
		return;
	}
	if (command === "route") {
		await previewRoute(args);
		return;
	}
	if (command === "metrics") {
		if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
			throw new Error("Usage: aaa metrics [--json]");
		}
		const runs = (await loadAdaptiveHarnessState()).runs;
		const output = args[0] === "--json" ? JSON.stringify(summarizeRuns(runs), null, 2) : formatRunReport(runs);
		process.stdout.write(`${output}\n`);
		return;
	}
	if (command === "adaptive") {
		const action = args[0] ?? "status";
		if (args.length > 1 || !["status", "on", "off", "reset"].includes(action)) {
			throw new Error("Usage: aaa adaptive [status|on|off|reset]");
		}
		const state = await loadAdaptiveHarnessState();
		if (action === "on" || action === "off") state.adaptiveEnabled = action === "on";
		if (action === "reset") {
			state.adaptiveEnabled = true;
			state.profiles = [];
			delete state.defaultModelId;
			delete state.defaultThinkingMode;
			delete state.defaultServiceTier;
		}
		if (action !== "status") await saveAdaptiveHarnessState(state);
		process.stdout.write(
			action === "reset"
				? "Adaptive profiles and saved preferences reset; learning is on.\n"
				: `Adaptive learning ${state.adaptiveEnabled ? "on" : "off"}. ${state.profiles.length} stored profiles.\n`,
		);
		return;
	}
	if (command === "run") {
		await runTask(args);
		return;
	}
	throw new Error(`Unknown command '${command}'.\n\n${HELP}`);
}

main().catch(error => {
	process.stderr.write(`aaa: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
