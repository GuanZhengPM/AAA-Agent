import type { AgentTurnProvider, Model } from "@aaa-agent/runtime";
import { createAnthropicProvider } from "./anthropic-client";
import type { CodexAuthSession } from "./auth";
import { createCodexProvider } from "./codex-client";
import { createOpenAICompatibleProvider } from "./openai-compatible-client";

export function modelAuthenticationReady(model: Model, codexAuth?: CodexAuthSession): boolean {
	if ((model.authChannel ?? (model.api === "codex-responses" ? "subscription" : "api_key")) === "subscription") {
		return codexAuth?.hasAuth() ?? false;
	}
	if ((model.authChannel ?? "api_key") === "local") return true;
	return Boolean(process.env[model.apiKeyEnv ?? "OPENAI_API_KEY"]?.trim());
}

export function createAgentTurnProvider(model: Model, codexAuth?: CodexAuthSession): AgentTurnProvider {
	if (model.api === "codex-responses") {
		if (!codexAuth?.hasAuth()) {
			throw new Error("Codex OAuth is not configured. Run 'aaa auth login' first.");
		}
		return createCodexProvider(codexAuth);
	}
	if (model.api === "anthropic-messages") return createAnthropicProvider(model);
	return createOpenAICompatibleProvider(model);
}
