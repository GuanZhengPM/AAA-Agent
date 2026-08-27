import type { Model } from "@aaa-agent/runtime";
import {
	type CredentialStoreFile,
	clearStoredCredentials,
	loadCredentialStore,
	type ProviderCredentialResolver,
	type ResolvedProviderCredential,
	removeStoredCredential,
	type StoredOAuthCredential,
	type StoredProviderCredential,
	saveCredentialStore,
	setStoredCredential,
} from "./credential-store";
import { loginClaudeCodeOAuth, refreshClaudeCodeOAuth } from "./oauth-anthropic";
import { launchExternalUrl } from "./oauth-callback";
import { loginKimiCodeOAuth, refreshKimiCodeOAuth } from "./oauth-kimi";
import { loginZaiCodingPlan } from "./oauth-zai";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const ORIGINATOR = "aaa_agent";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const REFRESH_MARGIN_MS = 60_000;

export interface CodexCredentials {
	accessToken: string;
	refreshToken: string;
	idToken?: string;
	expiresAt: number;
	accountId?: string;
	email?: string;
}

export interface AuthorizationUrlOptions {
	state: string;
	codeChallenge: string;
	redirectUri?: string;
}

interface OAuthTokenResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	id_token?: unknown;
	expires_in?: unknown;
}

export interface AuthProviderDefinition {
	id: string;
	name: string;
	mode: "oauth" | "api_key";
	apiKeyEnv?: string;
}

const AUTH_PROVIDERS: readonly AuthProviderDefinition[] = [
	{ id: "openai-codex", name: "ChatGPT / OpenAI Codex", mode: "oauth" },
	{ id: "kimi-code", name: "Kimi Code", mode: "oauth", apiKeyEnv: "KIMI_CODE_API_KEY" },
	{ id: "z-ai-coding", name: "GLM Coding Plan", mode: "oauth", apiKeyEnv: "ZAI_CODING_PLAN_API_KEY" },
	{ id: "claude-code", name: "Claude Code (Claude Pro/Max)", mode: "oauth", apiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN" },
	{ id: "deepseek", name: "DeepSeek API", mode: "api_key", apiKeyEnv: "DEEPSEEK_API_KEY" },
	{ id: "z-ai", name: "Z.AI API", mode: "api_key", apiKeyEnv: "ZAI_API_KEY" },
	{ id: "kimi", name: "Moonshot / Kimi API", mode: "api_key", apiKeyEnv: "MOONSHOT_API_KEY" },
	{ id: "anthropic", name: "Anthropic API", mode: "api_key", apiKeyEnv: "ANTHROPIC_API_KEY" },
	{ id: "openrouter", name: "OpenRouter", mode: "api_key", apiKeyEnv: "OPENROUTER_API_KEY" },
	{ id: "xai", name: "xAI", mode: "api_key", apiKeyEnv: "XAI_API_KEY" },
	{ id: "minimax", name: "MiniMax API", mode: "api_key", apiKeyEnv: "MINIMAX_API_KEY" },
	{ id: "minimax-token", name: "MiniMax Token Plan", mode: "api_key", apiKeyEnv: "MINIMAX_TOKEN_PLAN_API_KEY" },
	{ id: "xiaomi-mimo", name: "Xiaomi MiMo API", mode: "api_key", apiKeyEnv: "MIMO_API_KEY" },
	{ id: "xiaomi-mimo-token", name: "Xiaomi MiMo Token Plan", mode: "api_key", apiKeyEnv: "MIMO_TOKEN_PLAN_API_KEY" },
];

const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
	codex: "openai-codex",
	"chatgpt-codex": "openai-codex",
	kimi: "kimi",
	moonshot: "kimi",
	"kimi-coding": "kimi-code",
	glm: "z-ai",
	zai: "z-ai",
	"z.ai": "z-ai",
	"glm-coding": "z-ai-coding",
	"glm-coding-plan": "z-ai-coding",
	"zai-coding": "z-ai-coding",
	"zai-coding-plan": "z-ai-coding",
	claude: "claude-code",
	"anthropic-oauth": "claude-code",
};

export function listAuthProviders(): AuthProviderDefinition[] {
	return AUTH_PROVIDERS.map(provider => ({ ...provider }));
}

export function normalizeAuthProvider(provider: string): string {
	const normalized = provider.trim().toLowerCase();
	return PROVIDER_ALIASES[normalized] ?? normalized;
}

export function authProviderDefinition(provider: string): AuthProviderDefinition | undefined {
	const id = normalizeAuthProvider(provider);
	return AUTH_PROVIDERS.find(candidate => candidate.id === id);
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
	if (!token) return undefined;
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function extractIdentity(accessToken: string, idToken?: string): Pick<CodexCredentials, "accountId" | "email"> {
	const accessPayload = decodeJwtPayload(accessToken);
	const idPayload = decodeJwtPayload(idToken);
	const auth = accessPayload?.[JWT_AUTH_CLAIM];
	const accountId =
		auth && typeof auth === "object" && "chatgpt_account_id" in auth && typeof auth.chatgpt_account_id === "string"
			? auth.chatgpt_account_id
			: undefined;
	const email = typeof idPayload?.email === "string" ? idPayload.email : undefined;
	return { ...(accountId ? { accountId } : {}), ...(email ? { email } : {}) };
}

function base64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

async function createPkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function buildAuthorizationUrl(options: AuthorizationUrlOptions): string {
	const parameters = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: options.redirectUri ?? REDIRECT_URI,
		scope: SCOPE,
		code_challenge: options.codeChallenge,
		code_challenge_method: "S256",
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		state: options.state,
		originator: ORIGINATOR,
	});
	return `${AUTHORIZE_URL}?${parameters}`;
}

async function requestOpenAITokens(parameters: URLSearchParams, signal?: AbortSignal): Promise<OAuthTokenResponse> {
	const timeout = AbortSignal.timeout(15_000);
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: parameters,
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`OpenAI token exchange failed (${response.status}): ${text.slice(0, 500)}`);
	try {
		return JSON.parse(text) as OAuthTokenResponse;
	} catch (error) {
		throw new Error("OpenAI token exchange returned invalid JSON", { cause: error });
	}
}

function openAICredentialFromResponse(
	response: OAuthTokenResponse,
	previous?: StoredOAuthCredential,
): StoredOAuthCredential {
	if (typeof response.access_token !== "string" || !response.access_token) {
		throw new Error("OpenAI token response did not include an access token");
	}
	const refreshToken =
		typeof response.refresh_token === "string" && response.refresh_token
			? response.refresh_token
			: previous?.refreshToken;
	if (!refreshToken) throw new Error("OpenAI token response did not include a refresh token");
	const idToken = typeof response.id_token === "string" ? response.id_token : undefined;
	const expiresIn = typeof response.expires_in === "number" && response.expires_in > 0 ? response.expires_in : 3600;
	const identity = extractIdentity(response.access_token, idToken);
	return {
		type: "oauth",
		accessToken: response.access_token,
		refreshToken,
		expiresAt: Date.now() + expiresIn * 1000,
		authorizedAt: previous?.authorizedAt ?? Date.now(),
		...((identity.accountId ?? previous?.accountId) ? { accountId: identity.accountId ?? previous?.accountId } : {}),
		...((identity.email ?? previous?.email) ? { email: identity.email ?? previous?.email } : {}),
	};
}

async function waitForOpenAIAuthorizationCode(state: string, authUrl: string): Promise<string> {
	const completion = Promise.withResolvers<string>();
	let settled = false;
	let server: Bun.Server<unknown>;
	try {
		server = Bun.serve({
			port: CALLBACK_PORT,
			hostname: "127.0.0.1",
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname !== CALLBACK_PATH) return new Response("Not found", { status: 404 });
				if (url.searchParams.get("state") !== state) return new Response("State mismatch.", { status: 400 });
				const providerError = url.searchParams.get("error");
				if (providerError) {
					if (!settled) completion.reject(new Error(`OpenAI authorization failed: ${providerError}`));
					settled = true;
					return new Response(`Authorization failed: ${providerError}`, { status: 400 });
				}
				const code = url.searchParams.get("code");
				if (!code) return new Response("Missing authorization code.", { status: 400 });
				if (!settled) completion.resolve(code);
				settled = true;
				return new Response("AAA Agent is authenticated. You can close this tab.");
			},
		});
	} catch (error) {
		throw new Error(`Cannot listen on localhost:${CALLBACK_PORT}; stop the process using that port and retry`, {
			cause: error,
		});
	}
	process.stdout.write(`\nOpen this official OpenAI URL in your browser:\n${authUrl}\n\n`);
	launchExternalUrl(authUrl);
	try {
		return await Promise.race([
			completion.promise,
			Bun.sleep(300_000).then(() => {
				throw new Error("OpenAI authorization timed out after 5 minutes");
			}),
		]);
	} finally {
		server.stop(true);
	}
}

function environmentCredential(model: Model): ResolvedProviderCredential | undefined {
	if (model.authChannel === "local" || model.api === "codex-responses") return undefined;
	const envName = model.apiKeyEnv ?? (model.api === "anthropic-messages" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
	const secret = process.env[envName]?.trim();
	if (!secret) return undefined;
	return {
		provider: model.provider,
		kind: model.provider === "claude-code" ? "oauth" : "api_key",
		secret,
		source: `environment ${envName}`,
	};
}

function resolvedStoredCredential(provider: string, credential: StoredProviderCredential): ResolvedProviderCredential {
	if (credential.type === "api_key") {
		return { provider, kind: "api_key", secret: credential.apiKey, source: "AAA credential store" };
	}
	return {
		provider,
		kind: "oauth",
		secret: credential.accessToken,
		source: "AAA OAuth",
		expiresAt: credential.expiresAt,
		...(credential.email ? { email: credential.email } : {}),
		...(credential.accountId ? { accountId: credential.accountId } : {}),
		...(credential.orgId ? { orgId: credential.orgId } : {}),
		...(credential.orgName ? { orgName: credential.orgName } : {}),
	};
}

export class AdaptiveAuthSession implements ProviderCredentialResolver {
	#store: CredentialStoreFile;
	#refreshing = new Map<string, Promise<StoredOAuthCredential>>();

	constructor(store: CredentialStoreFile) {
		this.#store = structuredClone(store);
	}

	hasAuth(model: Model): boolean {
		if (model.authChannel === "local") return true;
		if (environmentCredential(model)) return true;
		return this.#store.providers[model.provider] !== undefined;
	}

	authenticationLabel(model: Model): string {
		if (model.authChannel === "local") return "local endpoint";
		const environment = environmentCredential(model);
		if (environment) return environment.source;
		const credential = this.#store.providers[model.provider];
		if (!credential) {
			const envName =
				model.apiKeyEnv ?? (model.api === "anthropic-messages" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
			return `missing auth; run aaa auth login ${model.provider} or set ${envName}`;
		}
		if (credential.type === "api_key") return credential.label ?? "stored API key";
		const identity = credential.email ?? credential.accountId ?? credential.orgName;
		return `${identity ? `${identity} · ` : ""}OAuth${credential.expiresAt <= Date.now() ? " (refresh on use)" : ""}`;
	}

	identity(provider = "openai-codex"): Pick<StoredOAuthCredential, "accountId" | "email" | "expiresAt"> | undefined {
		const credential = this.#store.providers[normalizeAuthProvider(provider)];
		if (credential?.type !== "oauth") return undefined;
		return {
			...(credential.accountId ? { accountId: credential.accountId } : {}),
			...(credential.email ? { email: credential.email } : {}),
			expiresAt: credential.expiresAt,
		};
	}

	async #refresh(
		provider: string,
		credential: StoredOAuthCredential,
		signal?: AbortSignal,
	): Promise<StoredOAuthCredential> {
		const active = this.#refreshing.get(provider);
		if (active) return active;
		const refresh = (async (): Promise<StoredOAuthCredential> => {
			let next: StoredOAuthCredential;
			if (provider === "openai-codex") {
				if (!credential.refreshToken) throw new Error("OpenAI credential has no refresh token; log in again.");
				const response = await requestOpenAITokens(
					new URLSearchParams({
						grant_type: "refresh_token",
						client_id: CLIENT_ID,
						refresh_token: credential.refreshToken,
					}),
					signal,
				);
				next = openAICredentialFromResponse(response, credential);
			} else if (provider === "kimi-code") {
				next = await refreshKimiCodeOAuth(credential, signal);
			} else if (provider === "claude-code") {
				next = await refreshClaudeCodeOAuth(credential, signal);
			} else {
				throw new Error(`OAuth refresh is not implemented for provider '${provider}'. Log in again.`);
			}
			this.#store.providers[provider] = next;
			await saveCredentialStore(this.#store);
			return next;
		})();
		this.#refreshing.set(provider, refresh);
		try {
			return await refresh;
		} finally {
			this.#refreshing.delete(provider);
		}
	}

	async resolveCredential(
		model: Model,
		signal?: AbortSignal,
		forceRefresh = false,
	): Promise<ResolvedProviderCredential | undefined> {
		if (model.authChannel === "local") return undefined;
		const environment = environmentCredential(model);
		if (environment) return environment;
		const provider = model.provider;
		let credential = this.#store.providers[provider];
		if (!credential) return undefined;
		if (credential.type === "oauth" && (forceRefresh || credential.expiresAt - REFRESH_MARGIN_MS <= Date.now())) {
			credential = await this.#refresh(provider, credential, signal);
		}
		return resolvedStoredCredential(provider, credential);
	}

	async getAccessToken(signal?: AbortSignal, forceRefresh = false): Promise<string> {
		const model: Model = {
			provider: "openai-codex",
			id: "oauth",
			name: "OpenAI Codex",
			api: "codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
			contextWindow: 1,
			efforts: ["minimal"],
			authChannel: "subscription",
		};
		const credential = await this.resolveCredential(model, signal, forceRefresh);
		if (!credential) throw new Error("Codex OAuth is not configured. Run 'aaa auth login openai-codex' first.");
		return credential.secret;
	}

	close(): void {}
}

/** Backwards-compatible constructor used by the public Codex adapter tests/SDK. */
export class CodexAuthSession extends AdaptiveAuthSession {
	constructor(credentials: CodexCredentials | undefined) {
		const providers: CredentialStoreFile["providers"] = {};
		if (credentials) {
			providers["openai-codex"] = {
				type: "oauth",
				accessToken: credentials.accessToken,
				refreshToken: credentials.refreshToken,
				expiresAt: credentials.expiresAt,
				...(credentials.accountId ? { accountId: credentials.accountId } : {}),
				...(credentials.email ? { email: credentials.email } : {}),
			};
		}
		super({ version: 2, providers });
	}
}

export async function openAdaptiveAuthSession(): Promise<AdaptiveAuthSession> {
	return new AdaptiveAuthSession(await loadCredentialStore());
}

export async function loginOpenAICodex(): Promise<void> {
	const pkce = await createPkce();
	const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
	const authUrl = buildAuthorizationUrl({ state, codeChallenge: pkce.challenge });
	const code = await waitForOpenAIAuthorizationCode(state, authUrl);
	const response = await requestOpenAITokens(
		new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			redirect_uri: REDIRECT_URI,
			code_verifier: pkce.verifier,
		}),
	);
	const credential = openAICredentialFromResponse(response);
	await setStoredCredential("openai-codex", credential);
	process.stdout.write(`Authenticated${credential.email ? ` as ${credential.email}` : ""}.\n`);
}

function printOAuthUrl(provider: string, url: string, instructions: string): void {
	process.stdout.write(`\nOpen this official ${provider} URL in your browser:\n${url}\n${instructions}\n\n`);
}

export async function loginProviderOAuth(providerInput: string, signal?: AbortSignal): Promise<void> {
	const provider = normalizeAuthProvider(providerInput);
	if (provider === "openai-codex") return loginOpenAICodex();
	let credential: StoredProviderCredential;
	if (provider === "kimi-code") {
		credential = await loginKimiCodeOAuth({
			signal,
			onAuthorization: (url, instructions) => printOAuthUrl("Kimi Code", url, instructions),
			onProgress: message => process.stdout.write(`${message}\n`),
		});
	} else if (provider === "z-ai-coding") {
		credential = await loginZaiCodingPlan({
			signal,
			onAuthorization: (url, instructions) => printOAuthUrl("Z.AI", url, instructions),
			onProgress: message => process.stdout.write(`${message}\n`),
		});
	} else if (provider === "claude-code") {
		credential = await loginClaudeCodeOAuth({
			signal,
			onAuthorization: (url, instructions) => printOAuthUrl("Claude", url, instructions),
			onProgress: message => process.stdout.write(`${message}\n`),
		});
	} else {
		throw new Error(`Provider '${providerInput}' does not support OAuth login; use 'aaa auth set-key ${provider}'.`);
	}
	await setStoredCredential(provider, credential);
	process.stdout.write(`Authenticated ${provider}.\n`);
}

export async function setProviderApiKey(providerInput: string, apiKey: string): Promise<void> {
	const provider = normalizeAuthProvider(providerInput);
	const value = apiKey.trim();
	if (!value) throw new Error("API key cannot be empty.");
	await setStoredCredential(provider, { type: "api_key", apiKey: value, createdAt: Date.now() });
}

export async function describeStoredAuthentication(providerInput?: string): Promise<string> {
	const store = await loadCredentialStore();
	const providers = providerInput
		? [normalizeAuthProvider(providerInput)]
		: [...new Set([...AUTH_PROVIDERS.map(provider => provider.id), ...Object.keys(store.providers)])];
	return providers
		.map(provider => {
			const definition = authProviderDefinition(provider);
			const credential = store.providers[provider];
			const envName = definition?.apiKeyEnv;
			const envReady = envName ? Boolean(process.env[envName]?.trim()) : false;
			let status = "not configured";
			if (envReady) status = `environment ${envName}`;
			else if (credential?.type === "api_key") status = credential.label ?? "stored API key";
			else if (credential?.type === "oauth") {
				const identity = credential.email ?? credential.accountId ?? credential.orgName;
				status = `${identity ? `${identity}; ` : ""}OAuth expires ${new Date(credential.expiresAt).toISOString()}`;
			}
			return `${provider.padEnd(20)} ${status}`;
		})
		.join("\n");
}

export async function describeOpenAICodexAuth(): Promise<string> {
	return describeStoredAuthentication("openai-codex");
}

export async function logoutProvider(providerInput: string): Promise<boolean> {
	return removeStoredCredential(normalizeAuthProvider(providerInput));
}

export async function logoutAllProviders(): Promise<number> {
	return clearStoredCredentials();
}

export async function logoutOpenAICodex(): Promise<void> {
	const removed = await logoutProvider("openai-codex");
	process.stdout.write(
		removed ? "Removed OpenAI Codex OAuth credentials.\n" : "No OpenAI Codex credentials were stored.\n",
	);
}
