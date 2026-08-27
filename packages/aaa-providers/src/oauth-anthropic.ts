import type { StoredOAuthCredential } from "./credential-store";
import { authorizeWithLocalCallback } from "./oauth-callback";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const EXPIRY_MARGIN_MS = 5 * 60_000;

interface ClaudeOAuthOptions {
	signal?: AbortSignal;
	onAuthorization?(url: string, instructions: string): void;
	onProgress?(message: string): void;
}

interface AnthropicTokenResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	account?: { uuid?: unknown; email_address?: unknown };
	organization?: { uuid?: unknown; name?: unknown };
}

function base64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

async function createPkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

async function exchangeToken(body: Record<string, string>, signal?: AbortSignal): Promise<AnthropicTokenResponse> {
	const timeout = AbortSignal.timeout(30_000);
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Claude Code token exchange failed (${response.status}): ${text.slice(0, 500)}`);
	}
	try {
		return JSON.parse(text) as AnthropicTokenResponse;
	} catch (error) {
		throw new Error("Claude Code token exchange returned invalid JSON.", { cause: error });
	}
}

function parseCredential(body: AnthropicTokenResponse, previous?: StoredOAuthCredential): StoredOAuthCredential {
	const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
	const refreshToken =
		typeof body.refresh_token === "string" && body.refresh_token.trim()
			? body.refresh_token.trim()
			: previous?.refreshToken;
	if (!accessToken || !refreshToken || typeof body.expires_in !== "number") {
		throw new Error("Claude Code token response did not include valid access, refresh, and expiry fields.");
	}
	const email = typeof body.account?.email_address === "string" ? body.account.email_address : previous?.email;
	const accountId = typeof body.account?.uuid === "string" ? body.account.uuid : previous?.accountId;
	const orgId = typeof body.organization?.uuid === "string" ? body.organization.uuid : previous?.orgId;
	const orgName = typeof body.organization?.name === "string" ? body.organization.name : previous?.orgName;
	return {
		type: "oauth",
		accessToken,
		refreshToken,
		expiresAt: Date.now() + body.expires_in * 1000 - EXPIRY_MARGIN_MS,
		authorizedAt: previous?.authorizedAt ?? Date.now(),
		...(email ? { email } : {}),
		...(accountId ? { accountId } : {}),
		...(orgId ? { orgId } : {}),
		...(orgName ? { orgName } : {}),
	};
}

export async function loginClaudeCodeOAuth(options: ClaudeOAuthOptions = {}): Promise<StoredOAuthCredential> {
	const pkce = await createPkce();
	const authorization = await authorizeWithLocalCallback(
		{
			provider: "Claude Code",
			preferredPort: 54545,
			buildAuthorizationUrl(state, redirectUri) {
				const parameters = new URLSearchParams({
					code: "true",
					client_id: CLIENT_ID,
					response_type: "code",
					redirect_uri: redirectUri,
					scope: SCOPES,
					code_challenge: pkce.challenge,
					code_challenge_method: "S256",
					state,
				});
				return {
					url: `${AUTHORIZE_URL}?${parameters}`,
					instructions:
						"Complete Claude login in your browser. The callback returns directly to AAA Agent on localhost.",
				};
			},
			onAuthorization(info) {
				options.onAuthorization?.(info.url, info.instructions ?? "Complete Claude login in your browser.");
			},
		},
		options.signal,
	);
	options.onProgress?.("Exchanging Claude Code authorization code...");
	let code = authorization.code;
	let state = authorization.state;
	const fragment = code.indexOf("#");
	if (fragment >= 0) {
		state = code.slice(fragment + 1) || state;
		code = code.slice(0, fragment);
	}
	const token = await exchangeToken(
		{
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			state,
			redirect_uri: authorization.redirectUri,
			code_verifier: pkce.verifier,
		},
		options.signal,
	);
	return parseCredential(token);
}

export async function refreshClaudeCodeOAuth(
	credential: StoredOAuthCredential,
	signal?: AbortSignal,
): Promise<StoredOAuthCredential> {
	if (!credential.refreshToken) throw new Error("Claude Code credential has no refresh token; log in again.");
	const token = await exchangeToken(
		{
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: credential.refreshToken,
		},
		signal,
	);
	return parseCredential(token, credential);
}
