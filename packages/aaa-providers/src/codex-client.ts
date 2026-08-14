import type { AgentFunctionCall, AgentTurnOptions, AgentTurnProvider, AgentTurnResult } from "@aaa-agent/runtime";
import type { CodexAuthSession } from "./auth";
import { createResponsesRequestBody, runResponsesTransport } from "./responses-transport";

const ORIGINATOR = "aaa_agent";
const CLIENT_VERSION = "0.144.1";
const PACKAGE_VERSION = "0.4.0";

export type CodexFunctionCall = AgentFunctionCall;
export type CodexTurnResult = AgentTurnResult;

export interface CodexTurnOptions extends AgentTurnOptions {
	auth: CodexAuthSession;
}

export function createCodexHeaders(accessToken: string, accountId: string | undefined, sessionId: string): Headers {
	const headers = new Headers({
		accept: "text/event-stream",
		"content-type": "application/json",
		Authorization: `Bearer ${accessToken}`,
		"OpenAI-Beta": "responses=experimental",
		originator: ORIGINATOR,
		version: CLIENT_VERSION,
		"User-Agent": `aaa-agent/${PACKAGE_VERSION}`,
		session_id: sessionId,
		conversation_id: sessionId,
		"x-client-request-id": sessionId,
	});
	if (accountId) headers.set("chatgpt-account-id", accountId);
	return headers;
}

export function createCodexRequestBody(
	options: Pick<CodexTurnOptions, "model" | "systemPrompt" | "input" | "tools" | "effort">,
): Record<string, unknown> {
	return createResponsesRequestBody({
		...options,
		sessionId: "request-preview",
		signal: new AbortController().signal,
	});
}

export async function runCodexTurn(options: CodexTurnOptions): Promise<CodexTurnResult> {
	const token = await options.auth.getAccessToken(options.signal, false);
	const identity = options.auth.identity();
	const headers = createCodexHeaders(token, identity?.accountId, options.sessionId);
	return runResponsesTransport({
		label: "Codex",
		url: `${options.model.baseUrl.replace(/\/+$/, "")}/codex/responses`,
		headers,
		turn: options,
		refresh: async () => {
			const refreshed = await options.auth.getAccessToken(options.signal, true);
			return createCodexHeaders(refreshed, options.auth.identity()?.accountId, options.sessionId);
		},
	});
}

export function createCodexProvider(auth: CodexAuthSession): AgentTurnProvider {
	const identity = auth.identity();
	return {
		provider: "openai-codex",
		...(identity?.email || identity?.accountId ? { identity: identity.email ?? identity.accountId } : {}),
		runTurn: options => runCodexTurn({ ...options, auth }),
	};
}
