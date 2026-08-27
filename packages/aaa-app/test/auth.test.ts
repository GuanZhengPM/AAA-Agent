import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AdaptiveAuthSession,
	createAgentTurnProvider,
	describeStoredAuthentication,
	listModels,
	loadCredentialStore,
	normalizeAuthProvider,
	openAdaptiveAuthSession,
	setProviderApiKey,
	setStoredCredential,
} from "@aaa-agent/providers";
import { getCredentialPath, type Model } from "@aaa-agent/runtime";

const originalHome = process.env.AAA_AGENT_HOME;
const tempDirectories: string[] = [];

beforeEach(async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aaa-auth-"));
	tempDirectories.push(directory);
	process.env.AAA_AGENT_HOME = directory;
});

afterEach(async () => {
	if (originalHome === undefined) delete process.env.AAA_AGENT_HOME;
	else process.env.AAA_AGENT_HOME = originalHome;
	delete process.env.DEEPSEEK_TEST_KEY;
	await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function turn(model: Model) {
	return {
		model,
		systemPrompt: "Be concise.",
		input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
		tools: [],
		effort: "low" as const,
		sessionId: "auth-test-session",
		signal: new AbortController().signal,
	};
}

describe("multi-provider authentication", () => {
	it("migrates legacy Codex credentials into the versioned provider store", async () => {
		await Bun.write(
			getCredentialPath(),
			JSON.stringify({
				accessToken: "legacy-access",
				refreshToken: "legacy-refresh",
				expiresAt: Date.now() + 60_000,
				email: "legacy@example.com",
			}),
		);
		const store = await loadCredentialStore();
		expect(store.version).toBe(2);
		expect(store.providers["openai-codex"]).toMatchObject({
			type: "oauth",
			accessToken: "legacy-access",
			refreshToken: "legacy-refresh",
			email: "legacy@example.com",
		});
	});

	it("stores API keys outside models.json and never prints their value", async () => {
		await setProviderApiKey("deepseek", "secret-deepseek-key");
		const store = await loadCredentialStore();
		expect(store.providers.deepseek).toMatchObject({ type: "api_key", apiKey: "secret-deepseek-key" });
		const status = await describeStoredAuthentication("deepseek");
		expect(status).toContain("stored API key");
		expect(status).not.toContain("secret-deepseek-key");
		if (process.platform !== "win32") expect((await fs.stat(getCredentialPath())).mode & 0o777).toBe(0o600);
	});

	it("uses a stored API key for OpenAI-compatible providers and lets an explicit environment key win", async () => {
		let authorization = "";
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				authorization = request.headers.get("authorization") ?? "";
				return Response.json({
					choices: [{ message: { role: "assistant", content: "ok" } }],
					usage: { prompt_tokens: 2, completion_tokens: 1 },
				});
			},
		});
		try {
			await setProviderApiKey("deepseek", "stored-key");
			const model: Model = {
				provider: "deepseek",
				id: "test",
				name: "DeepSeek Test",
				api: "openai-chat-completions",
				baseUrl: server.url.toString().replace(/\/$/, ""),
				contextWindow: 8_000,
				efforts: ["low"],
				authChannel: "api_key",
				apiKeyEnv: "DEEPSEEK_TEST_KEY",
			};
			let session = await openAdaptiveAuthSession();
			await createAgentTurnProvider(model, session).runTurn(turn(model));
			expect(authorization).toBe("Bearer stored-key");
			process.env.DEEPSEEK_TEST_KEY = "environment-key";
			session = await openAdaptiveAuthSession();
			await createAgentTurnProvider(model, session).runTurn(turn(model));
			expect(authorization).toBe("Bearer environment-key");
		} finally {
			server.stop(true);
		}
	});

	it("uses bearer auth and AAA-owned device headers for Kimi Code", async () => {
		let headers = new Headers();
		let pathname = "";
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				headers = request.headers;
				pathname = new URL(request.url).pathname;
				return Response.json({
					content: [{ type: "text", text: "ok" }],
					usage: { input_tokens: 1, output_tokens: 1 },
				});
			},
		});
		try {
			await setProviderApiKey("kimi-code", "kimi-code-key");
			const model: Model = {
				provider: "kimi-code",
				id: "k3",
				name: "Kimi Code",
				api: "anthropic-messages",
				baseUrl: `${server.url.toString().replace(/\/$/, "")}/coding`,
				contextWindow: 8_000,
				efforts: ["low"],
				authChannel: "subscription",
				apiKeyHeader: "bearer",
			};
			const session = await openAdaptiveAuthSession();
			await createAgentTurnProvider(model, session).runTurn(turn(model));
			expect(pathname).toBe("/coding/v1/messages");
			expect(headers.get("authorization")).toBe("Bearer kimi-code-key");
			expect(headers.get("x-api-key")).toBeNull();
			expect(headers.get("x-msh-platform")).toBe("kimi_cli");
			expect(headers.get("user-agent")).toStartWith("AAA-Agent/");
		} finally {
			server.stop(true);
		}
	});

	it("uses Claude Code OAuth headers without exposing the token as x-api-key", async () => {
		let headers = new Headers();
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				headers = request.headers;
				return Response.json({
					content: [{ type: "text", text: "ok" }],
					usage: { input_tokens: 1, output_tokens: 1 },
				});
			},
		});
		try {
			await setStoredCredential("claude-code", {
				type: "oauth",
				accessToken: "claude-oauth-token",
				refreshToken: "refresh-token",
				expiresAt: Date.now() + 3_600_000,
			});
			const model: Model = {
				provider: "claude-code",
				id: "claude-test",
				name: "Claude Code",
				api: "anthropic-messages",
				baseUrl: server.url.toString().replace(/\/$/, ""),
				contextWindow: 8_000,
				efforts: ["low"],
				authChannel: "subscription",
				effortFormat: "anthropic_output_config",
				apiKeyHeader: "bearer",
			};
			const session = await openAdaptiveAuthSession();
			await createAgentTurnProvider(model, session).runTurn(turn(model));
			expect(headers.get("authorization")).toBe("Bearer claude-oauth-token");
			expect(headers.get("x-api-key")).toBeNull();
			expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
			expect(headers.get("anthropic-beta")).toContain("claude-code-20250219");
			expect(headers.get("x-app")).toBe("cli");
		} finally {
			server.stop(true);
		}
	});

	it("ships subscription models and stable aliases for the requested providers", async () => {
		const models = await listModels();
		expect(models.find(model => `${model.provider}/${model.id}` === "kimi-code/k3")).toMatchObject({
			authChannel: "subscription",
			apiKeyHeader: "bearer",
		});
		expect(models.find(model => `${model.provider}/${model.id}` === "z-ai-coding/glm-5.2")).toMatchObject({
			authChannel: "subscription",
		});
		expect(models.find(model => `${model.provider}/${model.id}` === "claude-code/claude-sonnet-5")).toMatchObject({
			authChannel: "subscription",
			api: "anthropic-messages",
		});
		expect(normalizeAuthProvider("glm-coding-plan")).toBe("z-ai-coding");
		expect(normalizeAuthProvider("claude")).toBe("claude-code");
		expect(normalizeAuthProvider("moonshot")).toBe("kimi");
	});

	it("can build an isolated in-memory auth session for SDK callers", async () => {
		const session = new AdaptiveAuthSession({
			version: 2,
			providers: {
				deepseek: { type: "api_key", apiKey: "sdk-key", createdAt: Date.now() },
			},
		});
		const model: Model = {
			provider: "deepseek",
			id: "sdk",
			name: "SDK",
			api: "openai-chat-completions",
			baseUrl: "https://example.invalid",
			contextWindow: 1,
			efforts: ["minimal"],
			authChannel: "api_key",
		};
		expect(session.hasAuth(model)).toBe(true);
		expect((await session.resolveCredential(model))?.secret).toBe("sdk-key");
	});
});
