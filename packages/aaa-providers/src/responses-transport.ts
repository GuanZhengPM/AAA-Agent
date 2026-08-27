import {
	type AgentFunctionCall,
	type AgentTool,
	type AgentTurnOptions,
	type AgentTurnResult,
	calculateModelUsageCost,
	createEmptyUsageMetrics,
	createProviderAttemptSignal,
	isHardQuotaFailure,
	isRecord,
	type Model,
	ProviderHttpError,
	providerErrorCode,
	retryAfterMilliseconds,
	type UsageMetrics,
} from "@aaa-agent/runtime";
import { z } from "zod/v4";

const MAX_ERROR_BODY = 2_000;

interface SseEvent {
	event?: string;
	data: Record<string, unknown>;
}

export function toolJsonSchema(tool: AgentTool): Record<string, unknown> {
	const schema = z.toJSONSchema(tool.parameters, { target: "draft-7" });
	if (!isRecord(schema)) throw new Error(`Tool '${tool.name}' produced an invalid JSON schema`);
	const { $schema: _schema, ...parameters } = schema;
	return parameters;
}

function reasoningConfig(model: Model, options: AgentTurnOptions): Record<string, unknown> | undefined {
	if (options.disableReasoning) return model.supportsThinkingOff ? { effort: "none" } : undefined;
	if (model.efforts.length === 1 && model.efforts[0] === "minimal") return undefined;
	const reasoning: Record<string, unknown> = { effort: options.effort };
	if (model.api === "codex-responses" && !model.id.startsWith("gpt-5.3")) {
		reasoning.summary = "auto";
		reasoning.context = "all_turns";
	}
	return reasoning;
}

export function createResponsesRequestBody(options: AgentTurnOptions): Record<string, unknown> {
	const reasoning = reasoningConfig(options.model, options);
	return {
		model: options.model.id,
		instructions: options.systemPrompt,
		input: options.input,
		stream: true,
		store: false,
		// Stable across an interactive session. Providers that implement OpenAI
		// prompt caching can reuse the long system/history/tool prefix.
		...(options.model.api === "openai-responses" ? { prompt_cache_key: options.sessionId } : {}),
		...(reasoning ? { reasoning } : {}),
		...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
		...(options.maxOutputTokens !== undefined && options.model.api !== "codex-responses"
			? {
					max_output_tokens: Math.min(
						options.maxOutputTokens,
						options.model.maxOutputTokens ?? Number.POSITIVE_INFINITY,
					),
				}
			: {}),
		...(options.model.api === "codex-responses" ? { include: ["reasoning.encrypted_content"] } : {}),
		tools: options.tools.map(tool => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: toolJsonSchema(tool),
			strict: false,
		})),
		tool_choice: "auto",
	};
}

async function* readSseJson(stream: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SseEvent> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			if (signal.aborted) throw signal.reason ?? new Error("Request aborted");
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			buffer = buffer.replaceAll("\r\n", "\n");
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const block = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				let event: string | undefined;
				const dataLines: string[] = [];
				for (const line of block.split("\n")) {
					if (line.startsWith("event:")) event = line.slice(6).trim();
					else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
				}
				const raw = dataLines.join("\n");
				if (raw && raw !== "[DONE]") {
					let parsed: unknown;
					try {
						parsed = JSON.parse(raw);
					} catch (error) {
						throw new Error(`Responses API returned malformed SSE JSON: ${raw.slice(0, 300)}`, { cause: error });
					}
					if (isRecord(parsed)) yield { ...(event ? { event } : {}), data: parsed };
				}
				boundary = buffer.indexOf("\n\n");
			}
			if (done) break;
		}
	} finally {
		reader.releaseLock();
	}
}

function outputText(output: readonly Record<string, unknown>[]): string {
	const chunks: string[] = [];
	for (const item of output) {
		if (item.type !== "message" || !Array.isArray(item.content)) continue;
		for (const part of item.content) {
			if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") chunks.push(part.text);
		}
	}
	return chunks.join("");
}

function extractToolCalls(output: readonly Record<string, unknown>[]): AgentFunctionCall[] {
	return output.flatMap(item => {
		if (
			item.type !== "function_call" ||
			typeof item.call_id !== "string" ||
			typeof item.name !== "string" ||
			typeof item.arguments !== "string"
		) {
			return [];
		}
		return [{ callId: item.call_id, name: item.name, arguments: item.arguments }];
	});
}

function usageFromResponse(model: Model, response: Record<string, unknown>): UsageMetrics {
	const usage = isRecord(response.usage) ? response.usage : {};
	const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
	const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
	const result = createEmptyUsageMetrics();
	const totalInput = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
	result.cacheReadTokens = typeof inputDetails.cached_tokens === "number" ? inputDetails.cached_tokens : 0;
	result.inputTokens = Math.max(0, totalInput - result.cacheReadTokens);
	const totalOutput = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
	result.reasoningTokens = typeof outputDetails.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : 0;
	result.outputTokens = Math.max(0, totalOutput - result.reasoningTokens);
	result.costUsd = calculateModelUsageCost(model, result);
	return result;
}

async function responseError(label: string, response: Response): Promise<Error> {
	const retryAfterMs = retryAfterMilliseconds(response);
	const text = (await response.text()).slice(0, MAX_ERROR_BODY);
	const providerCode = providerErrorCode(text);
	const message = `${label} request failed (${response.status} ${response.statusText}): ${text}`;
	return new ProviderHttpError(message, {
		status: response.status,
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
		...(providerCode ? { providerCode } : {}),
		hardQuota: isHardQuotaFailure(message, providerCode),
	});
}

export interface ResponsesTransportOptions {
	label: string;
	url: string;
	headers: Headers;
	turn: AgentTurnOptions;
	refresh?: () => Promise<Headers>;
}

interface ResponsesAttempt {
	response: Response;
	signal: AbortSignal;
}

async function sendRequest(options: ResponsesTransportOptions, headers: Headers): Promise<ResponsesAttempt> {
	const signal = createProviderAttemptSignal(options.turn.signal);
	const response = await fetch(options.url, {
		method: "POST",
		headers,
		body: JSON.stringify(createResponsesRequestBody(options.turn)),
		signal,
	});
	return { response, signal };
}

export async function runResponsesTransport(options: ResponsesTransportOptions): Promise<AgentTurnResult> {
	let headers = options.headers;
	let attempt = await sendRequest(options, headers);
	if (attempt.response.status === 401 && options.refresh) {
		await attempt.response.body?.cancel();
		headers = await options.refresh();
		attempt = await sendRequest(options, headers);
	}
	const { response, signal } = attempt;
	if (!response.ok) throw await responseError(options.label, response);
	if (!response.body) throw new Error(`${options.label} response had no event stream`);

	const completedItems: Record<string, unknown>[] = [];
	let completedResponse: Record<string, unknown> | undefined;
	for await (const event of readSseJson(response.body, signal)) {
		const type = typeof event.data.type === "string" ? event.data.type : event.event;
		if (type === "response.output_text.delta" && typeof event.data.delta === "string") {
			options.turn.onTextDelta?.(event.data.delta);
		}
		if (type === "response.output_item.done" && isRecord(event.data.item)) completedItems.push(event.data.item);
		if (type === "response.completed" && isRecord(event.data.response)) completedResponse = event.data.response;
		if (type === "response.failed" || type === "error") {
			const error = isRecord(event.data.error) ? event.data.error : event.data;
			throw new Error(`${options.label} stream failed: ${JSON.stringify(error).slice(0, MAX_ERROR_BODY)}`);
		}
	}
	if (!completedResponse) throw new Error(`${options.label} stream ended before response.completed`);
	const responseItems = Array.isArray(completedResponse.output) ? completedResponse.output.filter(isRecord) : [];
	const output = responseItems.length > 0 ? responseItems : completedItems;
	return {
		output,
		text: outputText(output),
		toolCalls: extractToolCalls(output),
		usage: usageFromResponse(options.turn.model, completedResponse),
	};
}
