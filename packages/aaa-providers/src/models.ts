import * as path from "node:path";
import {
	createModelVariant,
	type Effort,
	getAdaptiveHarnessDir,
	loadAdaptiveHarnessState,
	type Model,
	type ModelVariant,
	SERVICE_TIERS,
	type ServiceTier,
	saveAdaptiveHarnessState,
	THINKING_MODES,
	type ThinkingMode,
} from "@aaa-agent/runtime";
import { z } from "zod/v4";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_PROVIDER = "openai-codex";
const PREFERRED_DEFAULTS = ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.5", "openai-codex/gpt-5.4"];
const STANDARD_EFFORTS = ["low", "medium", "high", "xhigh"] as const satisfies readonly Effort[];
const EXTENDED_EFFORTS = [...STANDARD_EFFORTS, "max"] as const satisfies readonly Effort[];
const OPENAI_SERVICE_TIERS = [...SERVICE_TIERS] as const;
const ANTHROPIC_SERVICE_TIERS = ["priority"] as const satisfies readonly ServiceTier[];

const CODEX_MODELS: readonly Model[] = [
	{
		provider: CODEX_PROVIDER,
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "codex-responses",
		baseUrl: CODEX_BASE_URL,
		contextWindow: 128_000,
		efforts: STANDARD_EFFORTS,
		serviceTiers: OPENAI_SERVICE_TIERS,
		authChannel: "subscription",
		family: "openai",
	},
	{
		provider: CODEX_PROVIDER,
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "codex-responses",
		baseUrl: CODEX_BASE_URL,
		contextWindow: 272_000,
		efforts: STANDARD_EFFORTS,
		serviceTiers: OPENAI_SERVICE_TIERS,
		authChannel: "subscription",
		family: "openai",
	},
	{
		provider: CODEX_PROVIDER,
		id: "gpt-5.4-mini",
		name: "GPT-5.4 mini",
		api: "codex-responses",
		baseUrl: CODEX_BASE_URL,
		contextWindow: 272_000,
		efforts: STANDARD_EFFORTS,
		serviceTiers: OPENAI_SERVICE_TIERS,
		authChannel: "subscription",
		family: "openai",
	},
	{
		provider: CODEX_PROVIDER,
		id: "gpt-5.5",
		name: "GPT-5.5",
		api: "codex-responses",
		baseUrl: CODEX_BASE_URL,
		contextWindow: 272_000,
		efforts: STANDARD_EFFORTS,
		serviceTiers: OPENAI_SERVICE_TIERS,
		authChannel: "subscription",
		family: "openai",
	},
	{
		provider: CODEX_PROVIDER,
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		api: "codex-responses",
		baseUrl: CODEX_BASE_URL,
		contextWindow: 372_000,
		efforts: EXTENDED_EFFORTS,
		serviceTiers: OPENAI_SERVICE_TIERS,
		authChannel: "subscription",
		family: "openai",
	},
	{
		provider: CODEX_PROVIDER,
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "codex-responses",
		baseUrl: CODEX_BASE_URL,
		contextWindow: 372_000,
		efforts: EXTENDED_EFFORTS,
		serviceTiers: OPENAI_SERVICE_TIERS,
		authChannel: "subscription",
		family: "openai",
	},
	{
		provider: CODEX_PROVIDER,
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		api: "codex-responses",
		baseUrl: CODEX_BASE_URL,
		contextWindow: 372_000,
		efforts: EXTENDED_EFFORTS,
		serviceTiers: OPENAI_SERVICE_TIERS,
		authChannel: "subscription",
		family: "openai",
	},
];

const API_MODELS: readonly Model[] = [
	{
		provider: "z-ai",
		id: "glm-5.2",
		name: "GLM-5.2",
		api: "openai-chat-completions",
		baseUrl: "https://api.z.ai/api/paas/v4",
		contextWindow: 200_000,
		efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
		servicePlan: "payg",
		authChannel: "api_key",
		effortFormat: "reasoning_effort",
		apiKeyEnv: "ZAI_API_KEY",
		family: "glm",
	},
	{
		provider: "kimi",
		id: "kimi-k3",
		name: "Kimi K3",
		api: "openai-chat-completions",
		baseUrl: "https://api.moonshot.ai/v1",
		contextWindow: 1_000_000,
		efforts: ["low", "high", "max"],
		servicePlan: "payg",
		authChannel: "api_key",
		effortFormat: "reasoning_effort",
		apiKeyEnv: "MOONSHOT_API_KEY",
		family: "kimi",
		pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
	},
	{
		provider: "deepseek",
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "openai-chat-completions",
		baseUrl: "https://api.deepseek.com",
		contextWindow: 1_000_000,
		efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
		supportsThinkingOff: true,
		servicePlan: "payg",
		authChannel: "api_key",
		effortFormat: "thinking_toggle_with_effort",
		maxOutputTokens: 384_000,
		apiKeyEnv: "DEEPSEEK_API_KEY",
		family: "deepseek",
		pricing: { inputPerMillion: 0.14, outputPerMillion: 0.28, cacheReadPerMillion: 0.0028 },
	},
	{
		provider: "deepseek",
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "openai-chat-completions",
		baseUrl: "https://api.deepseek.com",
		contextWindow: 1_000_000,
		efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
		supportsThinkingOff: true,
		servicePlan: "payg",
		authChannel: "api_key",
		effortFormat: "thinking_toggle_with_effort",
		maxOutputTokens: 384_000,
		apiKeyEnv: "DEEPSEEK_API_KEY",
		family: "deepseek",
		pricing: { inputPerMillion: 0.435, outputPerMillion: 0.87, cacheReadPerMillion: 0.003625 },
	},
	{
		provider: "anthropic",
		id: "claude-opus-5",
		name: "Claude Opus 5",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		contextWindow: 1_000_000,
		efforts: ["low", "medium", "high", "xhigh", "max"],
		supportsThinkingOff: true,
		serviceTiers: ANTHROPIC_SERVICE_TIERS,
		servicePlan: "payg",
		authChannel: "api_key",
		effortFormat: "anthropic_output_config",
		maxOutputTokens: 128_000,
		apiKeyEnv: "ANTHROPIC_API_KEY",
		family: "anthropic",
		pricing: { inputPerMillion: 5, outputPerMillion: 25 },
	},
	{
		provider: "anthropic",
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		contextWindow: 1_000_000,
		efforts: ["low", "medium", "high", "xhigh", "max"],
		supportsThinkingOff: true,
		serviceTiers: ANTHROPIC_SERVICE_TIERS,
		servicePlan: "payg",
		authChannel: "api_key",
		effortFormat: "anthropic_output_config",
		maxOutputTokens: 128_000,
		apiKeyEnv: "ANTHROPIC_API_KEY",
		family: "anthropic",
		pricing: { inputPerMillion: 2, outputPerMillion: 10 },
	},
	{
		provider: "xai",
		id: "grok-4.6",
		name: "Grok 4.6",
		api: "openai-chat-completions",
		baseUrl: "https://api.x.ai/v1",
		contextWindow: 500_000,
		efforts: ["minimal"],
		servicePlan: "payg",
		authChannel: "api_key",
		effortFormat: "none",
		maxOutputTokens: 128_000,
		apiKeyEnv: "XAI_API_KEY",
		family: "grok",
		pricing: { inputPerMillion: 2, outputPerMillion: 6, cacheReadPerMillion: 0.5 },
	},
	{
		provider: "xiaomi-mimo",
		id: "mimo-v2.5-pro",
		name: "MiMo V2.5 Pro",
		api: "openai-chat-completions",
		baseUrl: "https://api.xiaomimimo.com/v1",
		contextWindow: 1_000_000,
		efforts: ["high"],
		supportsThinkingOff: true,
		servicePlan: "payg",
		authChannel: "api_key",
		effortFormat: "thinking_toggle",
		apiKeyEnv: "MIMO_API_KEY",
		family: "mimo",
		pricing: { inputPerMillion: 0.435, outputPerMillion: 0.87, cacheReadPerMillion: 0.0036 },
	},
	{
		provider: "minimax",
		id: "MiniMax-M3",
		name: "MiniMax M3",
		api: "anthropic-messages",
		baseUrl: "https://api.minimax.io/anthropic",
		contextWindow: 1_000_000,
		efforts: ["high"],
		supportsThinkingOff: true,
		servicePlan: "payg",
		authChannel: "api_key",
		effortFormat: "anthropic_thinking_toggle",
		apiKeyEnv: "MINIMAX_API_KEY",
		family: "minimax",
	},
	{
		provider: "openrouter",
		id: "openai/gpt-5.2",
		name: "GPT-5.2 via OpenRouter",
		api: "openai-chat-completions",
		baseUrl: "https://openrouter.ai/api/v1",
		contextWindow: 400_000,
		efforts: STANDARD_EFFORTS,
		serviceTiers: OPENAI_SERVICE_TIERS,
		servicePlan: "payg",
		authChannel: "api_key",
		effortFormat: "reasoning_effort",
		apiKeyEnv: "OPENROUTER_API_KEY",
		family: "openai",
	},
];

const PLAN_MODELS: readonly Model[] = [
	{
		provider: "z-ai-coding",
		id: "glm-5.2",
		name: "GLM-5.2 Coding Plan",
		api: "openai-chat-completions",
		baseUrl: "https://api.z.ai/api/coding/paas/v4",
		contextWindow: 200_000,
		efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
		servicePlan: "coding-plan",
		authChannel: "subscription",
		effortFormat: "reasoning_effort",
		apiKeyEnv: "ZAI_CODING_PLAN_API_KEY",
		family: "glm",
	},
	{
		provider: "claude-code",
		id: "claude-opus-5",
		name: "Claude Opus 5 via Claude Code",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		contextWindow: 1_000_000,
		efforts: ["low", "medium", "high", "xhigh", "max"],
		supportsThinkingOff: true,
		servicePlan: "subscription",
		authChannel: "subscription",
		effortFormat: "anthropic_output_config",
		maxOutputTokens: 64_000,
		apiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN",
		apiKeyHeader: "bearer",
		family: "anthropic",
	},
	{
		provider: "claude-code",
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5 via Claude Code",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		contextWindow: 1_000_000,
		efforts: ["low", "medium", "high", "xhigh", "max"],
		supportsThinkingOff: true,
		servicePlan: "subscription",
		authChannel: "subscription",
		effortFormat: "anthropic_output_config",
		maxOutputTokens: 64_000,
		apiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN",
		apiKeyHeader: "bearer",
		family: "anthropic",
	},
	{
		provider: "kimi-code",
		id: "k3-256k",
		name: "Kimi K3 256K Coding Plan",
		api: "anthropic-messages",
		baseUrl: "https://api.kimi.com/coding",
		contextWindow: 262_144,
		efforts: ["low", "high", "max"],
		servicePlan: "coding-plan",
		authChannel: "subscription",
		effortFormat: "anthropic_output_config",
		apiKeyEnv: "KIMI_CODE_API_KEY",
		apiKeyHeader: "bearer",
		family: "kimi",
	},
	{
		provider: "kimi-code",
		id: "k3",
		name: "Kimi K3 1M Coding Plan",
		api: "anthropic-messages",
		baseUrl: "https://api.kimi.com/coding",
		contextWindow: 1_048_576,
		efforts: ["low", "high", "max"],
		servicePlan: "coding-plan",
		authChannel: "subscription",
		effortFormat: "anthropic_output_config",
		apiKeyEnv: "KIMI_CODE_API_KEY",
		apiKeyHeader: "bearer",
		family: "kimi",
	},
	{
		provider: "minimax-token",
		id: "MiniMax-M3",
		name: "MiniMax M3 Token Plan",
		api: "anthropic-messages",
		baseUrl: "https://api.minimax.io/anthropic",
		contextWindow: 1_000_000,
		efforts: ["high"],
		supportsThinkingOff: true,
		servicePlan: "token-plan",
		authChannel: "api_key",
		effortFormat: "anthropic_thinking_toggle",
		apiKeyEnv: "MINIMAX_TOKEN_PLAN_API_KEY",
		apiKeyHeader: "bearer",
		family: "minimax",
	},
	{
		provider: "xiaomi-mimo-token",
		id: "mimo-v2.5-pro",
		name: "MiMo V2.5 Pro Token Plan",
		api: "openai-chat-completions",
		baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
		baseUrlEnv: "MIMO_TOKEN_PLAN_BASE_URL",
		contextWindow: 1_000_000,
		efforts: ["high"],
		supportsThinkingOff: true,
		servicePlan: "token-plan",
		authChannel: "api_key",
		effortFormat: "thinking_toggle",
		apiKeyEnv: "MIMO_TOKEN_PLAN_API_KEY",
		family: "mimo",
	},
];

const configuredModelSchema = z.object({
	provider: z.string().min(1),
	id: z.string().min(1),
	name: z.string().min(1).optional(),
	api: z.enum(["openai-responses", "openai-chat-completions", "anthropic-messages"]),
	baseUrl: z.string().url(),
	servicePlan: z.enum(["subscription", "payg", "coding-plan", "token-plan", "local"]).optional(),
	baseUrlEnv: z.string().min(1).optional(),
	contextWindow: z.number().int().positive(),
	efforts: z.array(z.enum(["minimal", "low", "medium", "high", "xhigh", "max"])).min(1),
	supportsThinkingOff: z.boolean().optional(),
	serviceTiers: z.array(z.enum(SERVICE_TIERS)).optional(),
	authChannel: z.enum(["subscription", "api_key", "local"]).optional(),
	effortFormat: z
		.enum([
			"none",
			"reasoning_effort",
			"thinking_toggle",
			"thinking_toggle_with_effort",
			"anthropic_thinking_toggle",
			"anthropic_output_config",
		])
		.optional(),
	apiKeyHeader: z.enum(["bearer", "x-api-key"]).optional(),
	maxOutputTokens: z.number().int().positive().optional(),
	maxConcurrentRequests: z.number().int().positive().optional(),
	apiKeyEnv: z.string().min(1).optional(),
	family: z.string().min(1).optional(),
	pricing: z
		.object({
			inputPerMillion: z.number().nonnegative(),
			outputPerMillion: z.number().nonnegative(),
			cacheReadPerMillion: z.number().nonnegative().optional(),
			cacheWritePerMillion: z.number().nonnegative().optional(),
		})
		.optional(),
});

const configuredModelsSchema = z.array(configuredModelSchema);

function cloneModel(model: Model): Model {
	return {
		...model,
		efforts: [...model.efforts],
		...(model.serviceTiers ? { serviceTiers: [...model.serviceTiers] } : {}),
		servicePlan:
			model.servicePlan ??
			(model.authChannel === "subscription" ? "subscription" : model.authChannel === "local" ? "local" : "payg"),
		...(model.pricing ? { pricing: { ...model.pricing } } : {}),
	};
}

async function loadConfiguredModels(): Promise<Model[]> {
	const sources: unknown[] = [];
	const envModels = process.env.AAA_AGENT_MODELS?.trim();
	if (envModels) {
		try {
			sources.push(...configuredModelsSchema.parse(JSON.parse(envModels)));
		} catch (error) {
			throw new Error("AAA_AGENT_MODELS must be a valid configured-model JSON array", { cause: error });
		}
	}
	const configPath = path.join(getAdaptiveHarnessDir(), "models.json");
	try {
		const parsed: unknown = await Bun.file(configPath).json();
		sources.push(...configuredModelsSchema.parse(parsed));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			if (error instanceof SyntaxError || error instanceof z.ZodError) {
				throw new Error(`Invalid model catalog ${configPath}`, { cause: error });
			}
			throw error;
		}
	}
	return sources.map(raw => {
		const model = configuredModelSchema.parse(raw);
		return {
			provider: model.provider,
			id: model.id,
			name: model.name ?? model.id,
			api: model.api,
			baseUrl: model.baseUrl.replace(/\/+$/, ""),
			contextWindow: model.contextWindow,
			efforts: model.efforts,
			...(model.supportsThinkingOff ? { supportsThinkingOff: true } : {}),
			...(model.serviceTiers ? { serviceTiers: [...model.serviceTiers] } : {}),
			authChannel: model.authChannel ?? "api_key",
			...(model.effortFormat ? { effortFormat: model.effortFormat } : {}),
			...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
			...(model.maxConcurrentRequests ? { maxConcurrentRequests: model.maxConcurrentRequests } : {}),
			servicePlan: model.servicePlan ?? (model.authChannel === "local" ? "local" : "payg"),
			...(model.baseUrlEnv ? { baseUrlEnv: model.baseUrlEnv } : {}),
			...(model.apiKeyEnv ? { apiKeyEnv: model.apiKeyEnv } : {}),
			...(model.family ? { family: model.family } : {}),
			...(model.apiKeyHeader ? { apiKeyHeader: model.apiKeyHeader } : {}),
			...(model.pricing ? { pricing: model.pricing } : {}),
		};
	});
}

export function listBuiltInModels(): Model[] {
	return [...CODEX_MODELS, ...API_MODELS, ...PLAN_MODELS].map(cloneModel);
}

export async function listModels(): Promise<Model[]> {
	const models = [...listBuiltInModels(), ...(await loadConfiguredModels())];
	const seen = new Set<string>();
	for (const model of models) {
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) throw new Error(`Duplicate configured model '${key}'`);
		seen.add(key);
	}
	return models;
}

export function resolveModel(input: string, models: readonly Model[]): Model {
	const normalized = input.toLowerCase();
	const exact = models.find(model => `${model.provider}/${model.id}`.toLowerCase() === normalized);
	if (exact) return cloneModel(exact);
	const byId = models.filter(model => model.id.toLowerCase() === normalized);
	if (byId.length === 1 && byId[0]) return cloneModel(byId[0]);
	if (byId.length > 1) throw new Error(`Ambiguous model '${input}'. Use provider/model-id.`);
	throw new Error(`Unknown model '${input}'. Run 'aaa models' to list available models.`);
}

export async function resolveSelectedModel(override?: string): Promise<Model> {
	const models = await listModels();
	if (override) return resolveModel(override, models);
	const state = await loadAdaptiveHarnessState();
	if (state.defaultModelId) {
		try {
			return resolveModel(state.defaultModelId, models);
		} catch {}
	}
	for (const id of PREFERRED_DEFAULTS) {
		const preferred = models.find(model => `${model.provider}/${model.id}` === id);
		if (preferred) return cloneModel(preferred);
	}
	const first = models[0];
	if (!first) throw new Error("The model catalog is empty.");
	return cloneModel(first);
}

export async function setDefaultModel(input: string): Promise<Model> {
	const model = resolveModel(input, await listModels());
	const state = await loadAdaptiveHarnessState();
	state.defaultModelId = `${model.provider}/${model.id}`;
	await saveAdaptiveHarnessState(state);
	return model;
}

export function supportedThinkingModes(model: Model): ThinkingMode[] {
	return THINKING_MODES.filter(
		mode => mode === "auto" || (mode === "off" ? model.supportsThinkingOff === true : model.efforts.includes(mode)),
	);
}

export function assertModelSupportsThinkingMode(model: Model, mode: ThinkingMode): void {
	if (!supportedThinkingModes(model).includes(mode)) {
		throw new Error(
			`Model '${model.id}' does not support thinking mode '${mode}'. Supported: ${supportedThinkingModes(model).join(", ")}`,
		);
	}
}

export function resolveDefaultThinkingMode(model: Model, preferred?: ThinkingMode): ThinkingMode {
	if (preferred && supportedThinkingModes(model).includes(preferred)) return preferred;
	if (model.efforts.includes("medium")) return "medium";
	const first = model.efforts[0];
	if (!first) throw new Error(`Model '${model.id}' does not expose a reasoning effort.`);
	return first;
}

export function assertModelSupportsServiceTier(model: Model, tier: ServiceTier): void {
	if (!model.serviceTiers?.includes(tier)) {
		throw new Error(
			`Model '${model.id}' does not support service tier '${tier}'. Supported: ${model.serviceTiers?.join(", ") || "none"}`,
		);
	}
}

export function resolveServiceTier(model: Model, preferred?: ServiceTier): ServiceTier | undefined {
	return preferred && model.serviceTiers?.includes(preferred) ? preferred : undefined;
}

export function createAdaptiveModelVariant(
	model: Model,
	reasoningConfig: ThinkingMode,
	serviceTier?: ServiceTier,
): ModelVariant {
	return createModelVariant(model, {
		authChannel: model.authChannel ?? (model.api === "codex-responses" ? "subscription" : "api_key"),
		family: model.family,
		reasoningConfig,
		serviceTier,
		toolSchemaVersion: "4",
	});
}
