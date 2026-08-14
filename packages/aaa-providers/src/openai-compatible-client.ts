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
import { runResponsesTransport, toolJsonSchema } from "./responses-transport";

const MAX_ERROR_BODY = 2_000;

function apiKeyFor(model: Model): string | undefined {
	if (model.authChannel === "local") return undefined;
	const envName = model.apiKeyEnv ?? "OPENAI_API_KEY";
	const apiKey = process.env[envName]?.trim();
	if (!apiKey)
		throw new Error(`Model '${model.provider}/${model.id}' requires API key environment variable ${envName}.`);
	return apiKey;
}

function compatibleHeaders(apiKey: string | undefined): Headers {
	const headers = new Headers({
		accept: "application/json",
		"content-type": "application/json",
		"User-Agent": "aaa-agent/0.4.0",
	});
	if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
	return headers;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap(part => (isRecord(part) && typeof part.text === "string" ? [part.text] : [])).join("");
}

function chatMessages(options: AgentTurnOptions): Record<string, unknown>[] {
	const messages: Record<string, unknown>[] = [{ role: "system", content: options.systemPrompt }];
	for (const item of options.input) {
		if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
			const text = textFromContent(item.content);
			messages.push({
				role: item.role,
				content: text || (item.role === "assistant" ? null : ""),
				...(typeof item.reasoning_content === "string" ? { reasoning_content: item.reasoning_content } : {}),
			});
			continue;
		}
		if (
			item.type === "function_call" &&
			typeof item.call_id === "string" &&
			typeof item.name === "string" &&
			typeof item.arguments === "string"
		) {
			const toolCall = {
				id: item.call_id,
				type: "function",
				function: { name: item.name, arguments: item.arguments },
			};
			const previous = messages.at(-1);
			if (previous?.role === "assistant") {
				const calls = Array.isArray(previous.tool_calls) ? previous.tool_calls : [];
				previous.tool_calls = [...calls, toolCall];
			} else {
				messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
			}
			continue;
		}
		if (item.type === "function_call_output" && typeof item.call_id === "string") {
			messages.push({ role: "tool", tool_call_id: item.call_id, content: String(item.output ?? "") });
		}
	}
	return messages;
}

function chatUsage(model: Model, raw: unknown): UsageMetrics {
	const usage = isRecord(raw) ? raw : {};
	const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
	const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
	const result = createEmptyUsageMetrics();
	result.inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
	result.outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
	result.cacheReadTokens = typeof promptDetails.cached_tokens === "number" ? promptDetails.cached_tokens : 0;
	result.reasoningTokens =
		typeof completionDetails.reasoning_tokens === "number" ? completionDetails.reasoning_tokens : 0;
	result.costUsd = calculateModelUsageCost(model, result);
	return result;
}

async function runChatCompletions(options: AgentTurnOptions, apiKey: string | undefined): Promise<AgentTurnResult> {
	const body: Record<string, unknown> = {
		model: options.model.id,
		messages: chatMessages(options),
		tools: options.tools.map(tool => ({
			type: "function",
			function: { name: tool.name, description: tool.description, parameters: toolJsonSchema(tool) },
		})),
		tool_choice: "auto",
		...(options.maxOutputTokens !== undefined
			? { max_tokens: Math.min(options.maxOutputTokens, options.model.maxOutputTokens ?? Number.POSITIVE_INFINITY) }
			: {}),
	};
	const effortFormat =
		options.model.effortFormat ??
		(options.model.efforts.length === 1 && options.model.efforts[0] === "minimal" ? "none" : "reasoning_effort");
	if (effortFormat === "reasoning_effort") {
		body.reasoning_effort = options.disableReasoning ? "none" : options.effort;
	}
	if (effortFormat === "thinking_toggle") {
		body.thinking = { type: options.disableReasoning ? "disabled" : "enabled" };
	}
	if (effortFormat === "thinking_toggle_with_effort") {
		body.thinking = { type: options.disableReasoning ? "disabled" : "enabled" };
		if (!options.disableReasoning) body.reasoning_effort = options.effort;
	}
	if (options.serviceTier) body.service_tier = options.serviceTier;
	const url = `${resolveModelBaseUrl(options.model)}/chat/completions`;
	let response = await fetch(url, {
		method: "POST",
		headers: compatibleHeaders(apiKey),
		body: JSON.stringify(body),
		signal: options.signal,
	});
	for (let attempt = 0; attempt < 2 && (response.status === 429 || response.status >= 500); attempt += 1) {
		await response.body?.cancel();
		await Bun.sleep(500 * 2 ** attempt);
		response = await fetch(url, {
			method: "POST",
			headers: compatibleHeaders(apiKey),
			body: JSON.stringify(body),
			signal: options.signal,
		});
	}
	if (!response.ok) {
		const text = (await response.text()).slice(0, MAX_ERROR_BODY);
		throw new Error(`OpenAI-compatible request failed (${response.status} ${response.statusText}): ${text}`);
	}
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
		throw new Error("OpenAI-compatible response did not contain a choice");
	}
	const choice = payload.choices[0];
	if (!isRecord(choice.message)) throw new Error("OpenAI-compatible response did not contain an assistant message");
	const message = choice.message;
	const text = textFromContent(message.content);
	const reasoningContent = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
	if (text) options.onTextDelta?.(text);
	const toolCalls: AgentFunctionCall[] = [];
	const output: Record<string, unknown>[] = [];
	if (text || reasoningContent) {
		output.push({
			type: "message",
			role: "assistant",
			content: text ? [{ type: "output_text", text }] : [],
			...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
		});
	}
	if (Array.isArray(message.tool_calls)) {
		for (const rawCall of message.tool_calls) {
			if (!isRecord(rawCall) || !isRecord(rawCall.function)) continue;
			const callId = typeof rawCall.id === "string" ? rawCall.id : crypto.randomUUID();
			const name = rawCall.function.name;
			const argumentsValue = rawCall.function.arguments;
			if (typeof name !== "string" || typeof argumentsValue !== "string") continue;
			toolCalls.push({ callId, name, arguments: argumentsValue });
			output.push({ type: "function_call", call_id: callId, name, arguments: argumentsValue });
		}
	}
	return { output, text, toolCalls, usage: chatUsage(options.model, payload.usage) };
}

export function createOpenAICompatibleProvider(model: Model): AgentTurnProvider {
	const apiKey = apiKeyFor(model);
	return {
		provider: model.provider,
		identity: model.authChannel === "local" ? "local endpoint" : (model.apiKeyEnv ?? "OPENAI_API_KEY"),
		runTurn: options => {
			if (options.model.api === "openai-chat-completions") return runChatCompletions(options, apiKey);
			return runResponsesTransport({
				label: "OpenAI-compatible",
				url: `${resolveModelBaseUrl(options.model)}/responses`,
				headers: compatibleHeaders(apiKey),
				turn: options,
			});
		},
	};
}
