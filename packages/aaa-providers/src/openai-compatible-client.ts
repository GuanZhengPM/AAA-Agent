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
	resolveModelBaseUrl,
	retryAfterMilliseconds,
	type UsageMetrics,
} from "@aaa-agent/runtime";
import type { ProviderCredentialResolver } from "./credential-store";
import { runResponsesTransport, toolJsonSchema } from "./responses-transport";

const MAX_ERROR_BODY = 2_000;

async function apiKeyFor(
	model: Model,
	resolver?: ProviderCredentialResolver,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (model.authChannel === "local") return undefined;
	const credential = await resolver?.resolveCredential(model, signal);
	if (credential) return credential.secret;
	const envName = model.apiKeyEnv ?? "OPENAI_API_KEY";
	const apiKey = process.env[envName]?.trim();
	if (!apiKey) {
		throw new Error(
			`Model '${model.provider}/${model.id}' requires authentication. Run 'aaa auth login ${model.provider}' or set ${envName}.`,
		);
	}
	return apiKey;
}

function compatibleHeaders(apiKey: string | undefined, sessionId?: string): Headers {
	const headers = new Headers({
		accept: "application/json",
		"content-type": "application/json",
		"User-Agent": "aaa-agent/0.4.0",
		...(sessionId ? { "x-session-id": sessionId, "x-client-request-id": sessionId } : {}),
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
	const totalInput = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
	result.cacheReadTokens = typeof promptDetails.cached_tokens === "number" ? promptDetails.cached_tokens : 0;
	result.inputTokens = Math.max(0, totalInput - result.cacheReadTokens);
	const totalOutput = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
	result.reasoningTokens =
		typeof completionDetails.reasoning_tokens === "number" ? completionDetails.reasoning_tokens : 0;
	result.outputTokens = Math.max(0, totalOutput - result.reasoningTokens);
	result.costUsd = calculateModelUsageCost(model, result);
	return result;
}

interface StreamingToolCall {
	id: string;
	name: string;
	arguments: string;
}

async function readChatCompletionStream(response: Response, options: AgentTurnOptions): Promise<AgentTurnResult> {
	if (!response.body) throw new Error("OpenAI-compatible streaming response had no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let reasoningContent = "";
	let usage: unknown;
	const calls = new Map<number, StreamingToolCall>();
	const processBlock = (block: string): void => {
		const data = block
			.split("\n")
			.filter(line => line.startsWith("data:"))
			.map(line => line.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") return;
		let payload: unknown;
		try {
			payload = JSON.parse(data);
		} catch (error) {
			throw new Error(`OpenAI-compatible stream returned malformed JSON: ${data.slice(0, 300)}`, {
				cause: error,
			});
		}
		if (!isRecord(payload)) return;
		if (payload.usage !== undefined) usage = payload.usage;
		if (!Array.isArray(payload.choices)) return;
		for (const rawChoice of payload.choices) {
			if (!isRecord(rawChoice) || !isRecord(rawChoice.delta)) continue;
			const delta = rawChoice.delta;
			const content = textFromContent(delta.content);
			if (content) {
				text += content;
				options.onTextDelta?.(content);
			}
			if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
			if (!Array.isArray(delta.tool_calls)) continue;
			for (const rawCall of delta.tool_calls) {
				if (!isRecord(rawCall)) continue;
				const index = typeof rawCall.index === "number" ? rawCall.index : calls.size;
				const existing = calls.get(index) ?? { id: "", name: "", arguments: "" };
				if (typeof rawCall.id === "string") existing.id = rawCall.id;
				if (isRecord(rawCall.function)) {
					if (typeof rawCall.function.name === "string") existing.name += rawCall.function.name;
					if (typeof rawCall.function.arguments === "string") existing.arguments += rawCall.function.arguments;
				}
				calls.set(index, existing);
			}
		}
	};
	try {
		while (true) {
			if (options.signal.aborted) throw options.signal.reason ?? new Error("Request aborted");
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				processBlock(buffer.slice(0, boundary));
				buffer = buffer.slice(boundary + 2);
				boundary = buffer.indexOf("\n\n");
			}
			if (done) break;
		}
		if (buffer.trim()) processBlock(buffer);
	} finally {
		reader.releaseLock();
	}
	const toolCalls: AgentFunctionCall[] = [...calls.entries()]
		.sort(([left], [right]) => left - right)
		.flatMap(([_index, call]) => {
			if (!call.name) return [];
			return [{ callId: call.id || crypto.randomUUID(), name: call.name, arguments: call.arguments }];
		});
	const output: Record<string, unknown>[] = [];
	if (text || reasoningContent) {
		output.push({
			type: "message",
			role: "assistant",
			content: text ? [{ type: "output_text", text }] : [],
			...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
		});
	}
	for (const call of toolCalls) {
		output.push({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments });
	}
	return { output, text, toolCalls, usage: chatUsage(options.model, usage) };
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
		stream: true,
		...(/openai/i.test(options.model.provider) ? { stream_options: { include_usage: true } } : {}),
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
	const requestSignal = createProviderAttemptSignal(options.signal);
	const response = await fetch(url, {
		method: "POST",
		headers: compatibleHeaders(apiKey, options.sessionId),
		body: JSON.stringify(body),
		signal: requestSignal,
	});
	if (!response.ok) {
		const retryAfterMs = retryAfterMilliseconds(response);
		const text = (await response.text()).slice(0, MAX_ERROR_BODY);
		const providerCode = providerErrorCode(text);
		const message = `OpenAI-compatible request failed (${response.status} ${response.statusText}): ${text}`;
		throw new ProviderHttpError(message, {
			status: response.status,
			...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
			...(providerCode ? { providerCode } : {}),
			hardQuota: isHardQuotaFailure(message, providerCode),
		});
	}
	if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
		return await readChatCompletionStream(response, { ...options, signal: requestSignal });
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

export function createOpenAICompatibleProvider(model: Model, resolver?: ProviderCredentialResolver): AgentTurnProvider {
	return {
		provider: model.provider,
		identity:
			model.authChannel === "local"
				? "local endpoint"
				: (resolver?.authenticationLabel(model) ?? model.apiKeyEnv ?? "OPENAI_API_KEY"),
		async runTurn(options) {
			const apiKey = await apiKeyFor(options.model, resolver, options.signal);
			if (options.model.api === "openai-chat-completions") return runChatCompletions(options, apiKey);
			return runResponsesTransport({
				label: "OpenAI-compatible",
				url: `${resolveModelBaseUrl(options.model)}/responses`,
				headers: compatibleHeaders(apiKey, options.sessionId),
				turn: options,
			});
		},
	};
}
