import {
	type AgentFunctionCall,
	type AgentTurnOptions,
	type AgentTurnProvider,
	type AgentTurnResult,
	calculateModelUsageCost,
	createEmptyUsageMetrics,
	isRecord,
	type Model,
	resolveModelBaseUrl,
	type UsageMetrics,
} from "@aaa-agent/runtime";
import { toolJsonSchema } from "./responses-transport";

const MAX_ERROR_BODY = 2_000;
const ANTHROPIC_VERSION = "2023-06-01";
const EFFORT_BETA = "effort-2025-11-24";
const FAST_MODE_BETA = "fast-mode-2026-02-01";

function apiKeyFor(model: Model): string {
	const envName = model.apiKeyEnv ?? "ANTHROPIC_API_KEY";
	const apiKey = process.env[envName]?.trim();
	if (!apiKey)
		throw new Error(`Model '${model.provider}/${model.id}' requires API key environment variable ${envName}.`);
	return apiKey;
}

function anthropicHeaders(model: Model, apiKey: string, fastMode: boolean): Headers {
	const headers = new Headers({
		accept: "application/json",
		"anthropic-version": ANTHROPIC_VERSION,
		"content-type": "application/json",
		"User-Agent": "aaa-agent/0.4.0",
	});
	const betas: string[] = [];
	if (model.effortFormat === "anthropic_output_config") betas.push(EFFORT_BETA);
	if (fastMode) betas.push(FAST_MODE_BETA);
	if (betas.length > 0) headers.set("anthropic-beta", betas.join(","));
	if (model.apiKeyHeader === "bearer") headers.set("Authorization", `Bearer ${apiKey}`);
	else headers.set("x-api-key", apiKey);
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
	const body: Record<string, unknown> = {
		model: options.model.id,
		max_tokens: Math.min(
			options.model.maxOutputTokens ?? 16_000,
			options.maxOutputTokens ?? Number.POSITIVE_INFINITY,
		),
		system: options.systemPrompt,
		messages: anthropicMessages(options),
		tools: options.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			input_schema: toolJsonSchema(tool),
		})),
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

async function runAnthropicTurn(options: AgentTurnOptions, apiKey: string): Promise<AgentTurnResult> {
	const url = `${resolveModelBaseUrl(options.model)}/v1/messages`;
	const request = requestBody(options);
	let fastMode = options.serviceTier === "priority";
	const send = (): Promise<Response> =>
		fetch(url, {
			method: "POST",
			headers: anthropicHeaders(options.model, apiKey, fastMode),
			body: JSON.stringify(request),
			signal: options.signal,
		});
	let response = await send();
	if (fastMode && (response.status === 400 || response.status === 429)) {
		const errorBody = await response.clone().text();
		if (isFastModeUnsupported(response, errorBody)) {
			await response.body?.cancel();
			fastMode = false;
			delete request.speed;
			response = await send();
		}
	}
	for (let attempt = 0; attempt < 2 && (response.status === 429 || response.status >= 500); attempt += 1) {
		await response.body?.cancel();
		await Bun.sleep(500 * 2 ** attempt);
		response = await send();
	}
	if (!response.ok) {
		const text = (await response.text()).slice(0, MAX_ERROR_BODY);
		throw new Error(`Anthropic Messages request failed (${response.status} ${response.statusText}): ${text}`);
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
}

export function createAnthropicProvider(model: Model): AgentTurnProvider {
	const apiKey = apiKeyFor(model);
	return {
		provider: model.provider,
		identity: model.apiKeyEnv ?? "ANTHROPIC_API_KEY",
		runTurn: options => runAnthropicTurn(options, apiKey),
	};
}
