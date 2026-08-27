import type { AgentTurnProvider, Model } from "@aaa-agent/runtime";
import { createAnthropicProvider } from "./anthropic-client";
import type { AdaptiveAuthSession } from "./auth";
import { createCodexProvider } from "./codex-client";
import { createOpenAICompatibleProvider } from "./openai-compatible-client";

export function modelAuthenticationReady(model: Model, auth?: AdaptiveAuthSession): boolean {
	if (model.authChannel === "local") return true;
	if (auth?.hasAuth(model)) return true;
	if (model.api === "codex-responses") return false;
	const envName = model.apiKeyEnv ?? (model.api === "anthropic-messages" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
	return Boolean(process.env[envName]?.trim());
}

export function createAgentTurnProvider(model: Model, auth?: AdaptiveAuthSession): AgentTurnProvider {
	if (model.api === "codex-responses") {
		if (!auth?.hasAuth(model)) {
			throw new Error("Codex OAuth is not configured. Run 'aaa auth login openai-codex' first.");
		}
		return createCodexProvider(auth);
	}
	if (model.api === "anthropic-messages") return createAnthropicProvider(model, auth);
	return createOpenAICompatibleProvider(model, auth);
}
