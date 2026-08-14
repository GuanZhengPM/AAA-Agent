import * as fs from "node:fs/promises";
import { ensureAdaptiveHarnessDir, getCredentialPath } from "@aaa-agent/runtime";

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

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
	if (!token) return undefined;
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const decoded = Buffer.from(payload, "base64url").toString("utf8");
		const parsed = JSON.parse(decoded);
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
	const random = crypto.getRandomValues(new Uint8Array(32));
	const verifier = base64Url(random);
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

async function requestTokens(parameters: URLSearchParams, signal?: AbortSignal): Promise<OAuthTokenResponse> {
	const timeout = AbortSignal.timeout(15_000);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: parameters,
		signal: requestSignal,
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`OpenAI token exchange failed (${response.status}): ${text.slice(0, 500)}`);
	try {
		return JSON.parse(text) as OAuthTokenResponse;
	} catch (error) {
		throw new Error("OpenAI token exchange returned invalid JSON", { cause: error });
	}
}

function credentialsFromResponse(response: OAuthTokenResponse, previous?: CodexCredentials): CodexCredentials {
	if (typeof response.access_token !== "string" || response.access_token.length === 0) {
		throw new Error("OpenAI token response did not include an access token");
	}
	const refreshToken =
		typeof response.refresh_token === "string" && response.refresh_token.length > 0
			? response.refresh_token
			: previous?.refreshToken;
	if (!refreshToken) throw new Error("OpenAI token response did not include a refresh token");
	const idToken = typeof response.id_token === "string" ? response.id_token : previous?.idToken;
	const expiresIn = typeof response.expires_in === "number" && response.expires_in > 0 ? response.expires_in : 3600;
	return {
		accessToken: response.access_token,
		refreshToken,
		...(idToken ? { idToken } : {}),
		expiresAt: Date.now() + expiresIn * 1000,
		...extractIdentity(response.access_token, idToken),
	};
}

async function saveCredentials(credentials: CodexCredentials): Promise<void> {
	await ensureAdaptiveHarnessDir();
	const path = getCredentialPath();
	await Bun.write(path, `${JSON.stringify(credentials, null, 2)}\n`);
	if (process.platform !== "win32") await fs.chmod(path, 0o600);
}

async function loadCredentials(): Promise<CodexCredentials | undefined> {
	try {
		const value = await Bun.file(getCredentialPath()).json();
		if (!value || typeof value !== "object") return undefined;
		const candidate = value as Partial<CodexCredentials>;
		if (
			typeof candidate.accessToken !== "string" ||
			typeof candidate.refreshToken !== "string" ||
			typeof candidate.expiresAt !== "number"
		) {
			throw new Error(`Invalid credentials file: ${getCredentialPath()}`);
		}
		return candidate as CodexCredentials;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function launchBrowser(url: string): void {
	let command: string[];
	if (process.platform === "darwin") command = ["open", url];
	else if (process.platform === "win32") command = ["rundll32", "url.dll,FileProtocolHandler", url];
	else command = ["xdg-open", url];
	try {
		Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
	} catch {
		// The URL is always printed, so browser launch is best-effort.
	}
}

async function waitForAuthorizationCode(state: string, authUrl: string): Promise<string> {
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
				const returnedState = url.searchParams.get("state");
				const error = url.searchParams.get("error");
				const code = url.searchParams.get("code");
				if (returnedState !== state) {
					if (!settled) completion.reject(new Error("OAuth state mismatch"));
					settled = true;
					return new Response("Authorization failed: state mismatch.", { status: 400 });
				}
				if (error) {
					if (!settled) completion.reject(new Error(`OpenAI authorization failed: ${error}`));
					settled = true;
					return new Response(`Authorization failed: ${error}`, { status: 400 });
				}
				if (!code) return new Response("Missing authorization code.", { status: 400 });
				if (!settled) completion.resolve(code);
				settled = true;
				return new Response("AAA Agent is authenticated. You can close this tab.", {
					headers: { "content-type": "text/plain; charset=utf-8" },
				});
			},
		});
	} catch (error) {
		throw new Error(`Cannot listen on localhost:${CALLBACK_PORT}; stop the process using that port and retry`, {
			cause: error,
		});
	}
	process.stdout.write(`\nOpen this OpenAI URL in your browser:\n${authUrl}\n\n`);
	launchBrowser(authUrl);
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

export class CodexAuthSession {
	#credentials: CodexCredentials | undefined;

	constructor(credentials: CodexCredentials | undefined) {
		this.#credentials = credentials;
	}

	hasAuth(): boolean {
		return this.#credentials !== undefined;
	}

	identity(): Pick<CodexCredentials, "accountId" | "email" | "expiresAt"> | undefined {
		if (!this.#credentials) return undefined;
		const { accountId, email, expiresAt } = this.#credentials;
		return { ...(accountId ? { accountId } : {}), ...(email ? { email } : {}), expiresAt };
	}

	async getAccessToken(signal?: AbortSignal, forceRefresh = false): Promise<string> {
		const current = this.#credentials;
		if (!current) throw new Error("Codex OAuth is not configured. Run 'aaa auth login' first.");
		if (!forceRefresh && current.expiresAt - REFRESH_MARGIN_MS > Date.now()) return current.accessToken;
		const response = await requestTokens(
			new URLSearchParams({
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: current.refreshToken,
			}),
			signal,
		);
		this.#credentials = credentialsFromResponse(response, current);
		await saveCredentials(this.#credentials);
		return this.#credentials.accessToken;
	}

	close(): void {}
}

export async function openAdaptiveAuthSession(): Promise<CodexAuthSession> {
	return new CodexAuthSession(await loadCredentials());
}

export async function loginOpenAICodex(): Promise<void> {
	const pkce = await createPkce();
	const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
	const authUrl = buildAuthorizationUrl({ state, codeChallenge: pkce.challenge });
	const code = await waitForAuthorizationCode(state, authUrl);
	const response = await requestTokens(
		new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			redirect_uri: REDIRECT_URI,
			code_verifier: pkce.verifier,
		}),
	);
	const credentials = credentialsFromResponse(response);
	await saveCredentials(credentials);
	process.stdout.write(`Authenticated${credentials.email ? ` as ${credentials.email}` : ""}.\n`);
}

export async function describeOpenAICodexAuth(): Promise<string> {
	const credentials = await loadCredentials();
	if (!credentials) return "not logged in";
	const identity = credentials.email ?? credentials.accountId ?? "OpenAI account";
	return `logged in as ${identity}; token expires ${new Date(credentials.expiresAt).toISOString()}`;
}

export async function logoutOpenAICodex(): Promise<void> {
	try {
		await fs.rm(getCredentialPath());
		process.stdout.write("Removed AAA Agent OAuth credentials.\n");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			process.stdout.write("No AAA Agent OAuth credentials were stored.\n");
			return;
		}
		throw error;
	}
}
