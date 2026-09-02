import {
	type AgentFunctionCall,
	type AgentTurnOptions,
	type AgentTurnProvider,
	type AgentTurnResult,
	calculateModelUsageCost,
	createEmptyUsageMetrics,
	createProviderAttemptSignal,
	isHardQuotaFailure,
	isRecord,
	type Model,
	ProviderHttpError,
	providerErrorCode,
	releaseProviderAttemptSignal,
	resolveModelBaseUrl,
	retryAfterMilliseconds,
	type UsageMetrics,
} from "@aaa-agent/runtime";
import type { ProviderCredentialResolver, ResolvedProviderCredential } from "./credential-store";
import { kimiCodeHeaders } from "./oauth-kimi";
import { toolJsonSchema } from "./responses-transport";

const MAX_ERROR_BODY = 2_000;
const ANTHROPIC_VERSION = "2023-06-01";
const EFFORT_BETA = "effort-2025-11-24";
const FAST_MODE_BETA = "fast-mode-2026-02-01";
const CLAUDE_CODE_BETAS = ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14"];

async function credentialFor(
	model: Model,
	resolver?: ProviderCredentialResolver,
	signal?: AbortSignal,
	forceRefresh = false,
): Promise<ResolvedProviderCredential> {
	const credential = await resolver?.resolveCredential(model, signal, forceRefresh);
	if (credential) return credential;
	const envName = model.apiKeyEnv ?? "ANTHROPIC_API_KEY";
	const secret = process.env[envName]?.trim();
	if (!secret) {
		throw new Error(
			`Model '${model.provider}/${model.id}' requires authentication. Run 'aaa auth login ${model.provider}' or set ${envName}.`,
		);
	}
	return {
		provider: model.provider,
		kind: model.provider === "claude-code" ? "oauth" : "api_key",
		secret,
		source: `environment ${envName}`,
	};
}

function anthropicHeaders(
	model: Model,
	credential: ResolvedProviderCredential,
	fastMode: boolean,
	sessionId?: string,
): Headers {
	const oauth = credential.kind === "oauth";
	const headers = new Headers({
		accept: "application/json",
		"anthropic-version": ANTHROPIC_VERSION,
		"content-type": "application/json",
		"User-Agent": "AAA-Agent/0.4.0",
		...(sessionId ? { "x-client-request-id": sessionId } : {}),
		...(model.provider === "kimi-code" ? kimiCodeHeaders() : {}),
	});
	const betas: string[] = oauth && model.provider === "claude-code" ? [...CLAUDE_CODE_BETAS] : [];
	if (model.effortFormat === "anthropic_output_config") betas.push(EFFORT_BETA);
	if (fastMode) betas.push(FAST_MODE_BETA);
	if (betas.length > 0) headers.set("anthropic-beta", [...new Set(betas)].join(","));
	if (oauth && model.provider === "claude-code") {
		headers.set("User-Agent", "claude-cli/2.1.220 (external, aaa-agent)");
		headers.set("anthropic-dangerous-direct-browser-access", "true");
		headers.set("x-app", "cli");
		headers.set("X-Stainless-Arch", process.arch === "arm64" ? "arm64" : "x64");
		headers.set("X-Stainless-Lang", "js");
		headers.set("X-Stainless-OS", process.platform);
		headers.set("X-Stainless-Package-Version", "0.94.0");
		headers.set("X-Stainless-Retry-Count", "0");
		headers.set("X-Stainless-Runtime", "bun");
		headers.set("X-Stainless-Runtime-Version", Bun.version);
		headers.set("X-Stainless-Timeout", "600");
		if (sessionId) headers.set("X-Claude-Code-Session-Id", sessionId);
	}
	if (oauth || model.apiKeyHeader === "bearer") headers.set("Authorization", `Bearer ${credential.secret}`);
	else headers.set("x-api-key", credential.secret);
	return headers;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap(part => (isRecord(part) && typeof part.text === "string" ? [part.text] : [])).join("");
}

function appendBlocks(
	messages: Record<string, unknown>[],
	role: "user" | "assistant",
	blocks: readonly Record<string, unknown>[],
): void {
	if (blocks.length === 0) return;
	const previous = messages.at(-1);
	if (previous?.role === role && Array.isArray(previous.content)) {
		previous.content.push(...blocks);
		return;
	}
	messages.push({ role, content: [...blocks] });
}

function anthropicMessages(options: AgentTurnOptions): Record<string, unknown>[] {
	const messages: Record<string, unknown>[] = [];
	for (const item of options.input) {
		if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
			const preserved = Array.isArray(item.anthropic_content) ? item.anthropic_content.filter(isRecord) : [];
			if (preserved.length > 0) {
				appendBlocks(messages, item.role, preserved);
			} else {
				const text = textFromContent(item.content);
				if (text) appendBlocks(messages, item.role, [{ type: "text", text }]);
			}
			continue;
		}
		if (
			item.type === "function_call" &&
			typeof item.call_id === "string" &&
			typeof item.name === "string" &&
			typeof item.arguments === "string"
		) {
			let input: unknown;
			try {
				input = JSON.parse(item.arguments);
			} catch {
				input = {};
			}
			appendBlocks(messages, "assistant", [{ type: "tool_use", id: item.call_id, name: item.name, input }]);
			continue;
		}
		if (item.type === "function_call_output" && typeof item.call_id === "string") {
			appendBlocks(messages, "user", [
				{ type: "tool_result", tool_use_id: item.call_id, content: String(item.output ?? "") },
			]);
		}
	}
	return messages;
}

function anthropicUsage(model: Model, raw: unknown): UsageMetrics {
	const usage = isRecord(raw) ? raw : {};
	const result = createEmptyUsageMetrics();
	result.inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
	result.outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
	result.cacheReadTokens = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
	result.cacheWriteTokens =
		typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
	result.costUsd = calculateModelUsageCost(model, result);
	return result;
}

function requestBody(options: AgentTurnOptions): Record<string, unknown> {
	const cacheable = options.model.family === "anthropic";
	const tools: Record<string, unknown>[] = options.tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		input_schema: toolJsonSchema(tool),
	}));
	if (cacheable && tools.length > 0) tools[tools.length - 1]!.cache_control = { type: "ephemeral" };
	const body: Record<string, unknown> = {
		model: options.model.id,
		max_tokens: Math.min(
			options.model.maxOutputTokens ?? 16_000,
			options.maxOutputTokens ?? Number.POSITIVE_INFINITY,
		),
		system: cacheable
			? [{ type: "text", text: options.systemPrompt, cache_control: { type: "ephemeral" } }]
			: options.systemPrompt,
		messages: anthropicMessages(options),
		tools,
		tool_choice: { type: "auto" },
	};
	if (options.model.effortFormat === "anthropic_thinking_toggle") {
		body.thinking = { type: options.disableReasoning ? "disabled" : "adaptive" };
	}
	if (options.model.effortFormat === "anthropic_output_config") {
		body.thinking = { type: options.disableReasoning ? "disabled" : "adaptive" };
		if (!options.disableReasoning) body.output_config = { effort: options.effort };
	}
	if (options.serviceTier === "priority") body.speed = "fast";
	return body;
}

function isFastModeUnsupported(response: Response, body: string): boolean {
	if (response.status === 400) return /\bspeed\b/i.test(body) && /not support|unsupported|invalid/i.test(body);
	return response.status === 429 && /fast mode/i.test(body);
}

async function runAnthropicTurn(
	options: AgentTurnOptions,
	credential: ResolvedProviderCredential,
): Promise<AgentTurnResult> {
	const url = `${resolveModelBaseUrl(options.model)}/v1/messages`;
	const request = requestBody(options);
	let fastMode = options.serviceTier === "priority";
	const send = async (): Promise<{ response: Response; signal: AbortSignal }> => {
		const signal = createProviderAttemptSignal(options.signal);
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: anthropicHeaders(options.model, credential, fastMode, options.sessionId),
				body: JSON.stringify(request),
				signal,
			});
			return { response, signal };
		} catch (error) {
			releaseProviderAttemptSignal(signal);
			throw error;
		}
	};
	let attempt = await send();
	try {
		let response = attempt.response;
		if (fastMode && (response.status === 400 || response.status === 429)) {
			const errorBody = await response.clone().text();
			if (isFastModeUnsupported(response, errorBody)) {
				await response.body?.cancel();
				fastMode = false;
				delete request.speed;
				releaseProviderAttemptSignal(attempt.signal);
				attempt = await send();
				response = attempt.response;
			}
		}
		if (!response.ok) {
			const retryAfterMs = retryAfterMilliseconds(response);
			const text = (await response.text()).slice(0, MAX_ERROR_BODY);
			const providerCode = providerErrorCode(text);
			const message = `Anthropic Messages request failed (${response.status} ${response.statusText}): ${text}`;
			throw new ProviderHttpError(message, {
				status: response.status,
				...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
				...(providerCode ? { providerCode } : {}),
				hardQuota: isHardQuotaFailure(message, providerCode),
			});
		}
		const payload: unknown = await response.json();
		if (!isRecord(payload) || !Array.isArray(payload.content)) {
			throw new Error("Anthropic Messages response did not contain content blocks");
		}
		const content = payload.content.filter(isRecord);
		const text = content
			.flatMap(block => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
			.join("");
		if (text) options.onTextDelta?.(text);
		const toolCalls: AgentFunctionCall[] = content.flatMap(block => {
			if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") return [];
			return [{ callId: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }];
		});
		const output: Record<string, unknown>[] = [
			{
				type: "message",
				role: "assistant",
				content: text ? [{ type: "output_text", text }] : [],
				anthropic_content: content,
			},
		];
		return { output, text, toolCalls, usage: anthropicUsage(options.model, payload.usage) };
	} finally {
		releaseProviderAttemptSignal(attempt.signal);
	}
}

export function createAnthropicProvider(model: Model, resolver?: ProviderCredentialResolver): AgentTurnProvider {
	return {
		provider: model.provider,
		identity: resolver?.authenticationLabel(model) ?? model.apiKeyEnv ?? "ANTHROPIC_API_KEY",
		async runTurn(options) {
			let credential = await credentialFor(options.model, resolver, options.signal);
			try {
				return await runAnthropicTurn(options, credential);
			} catch (error) {
				if (
					!(error instanceof ProviderHttpError) ||
					error.status !== 401 ||
					credential.kind !== "oauth" ||
					!resolver
				) {
					throw error;
				}
				credential = await credentialFor(options.model, resolver, options.signal, true);
				return runAnthropicTurn(options, credential);
			}
		},
	};
}
