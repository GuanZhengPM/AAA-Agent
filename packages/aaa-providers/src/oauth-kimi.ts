import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { ensureAdaptiveHarnessDir, getAdaptiveHarnessDir } from "@aaa-agent/runtime";
import type { StoredOAuthCredential } from "./credential-store";
import { launchExternalUrl } from "./oauth-callback";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEVICE_ID_FILE = "kimi-device-id";
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_EXPIRES_MS = 15 * 60_000;
const EXPIRY_MARGIN_MS = 5 * 60_000;

interface KimiOAuthOptions {
	signal?: AbortSignal;
	onAuthorization?(url: string, instructions: string): void;
	onProgress?(message: string): void;
}

interface DeviceAuthorizationResponse {
	user_code?: unknown;
	device_code?: unknown;
	verification_uri?: unknown;
	verification_uri_complete?: unknown;
	expires_in?: unknown;
	interval?: unknown;
}

interface TokenResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	error?: unknown;
	error_description?: unknown;
	interval?: unknown;
}

function oauthHost(): string {
	return process.env.KIMI_CODE_OAUTH_HOST?.trim() || process.env.KIMI_OAUTH_HOST?.trim() || DEFAULT_OAUTH_HOST;
}

let cachedDeviceId: string | undefined;
function deviceId(): string {
	if (cachedDeviceId) return cachedDeviceId;
	const file = path.join(getAdaptiveHarnessDir(), DEVICE_ID_FILE);
	try {
		const existing = fs.readFileSync(file, "utf8").trim();
		if (existing) {
			cachedDeviceId = existing;
			return existing;
		}
	} catch {}
	cachedDeviceId = crypto.randomUUID().replaceAll("-", "");
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${cachedDeviceId}\n`, { mode: 0o600 });
	} catch {}
	return cachedDeviceId;
}

function safeHeader(value: string, fallback = "unknown"): string {
	return value.replace(/[^\x20-\x7e]/g, "").trim() || fallback;
}

export function kimiCodeHeaders(): Record<string, string> {
	return {
		"User-Agent": "AAA-Agent/0.4.0",
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Version": "0.4.0",
		"X-Msh-Device-Name": safeHeader(os.hostname()),
		"X-Msh-Device-Model": safeHeader(`${os.platform()} ${os.release()} ${os.arch()}`),
		"X-Msh-Os-Version": safeHeader(os.version()),
		"X-Msh-Device-Id": safeHeader(deviceId()),
	};
}

async function postToken(
	parameters: URLSearchParams,
	signal?: AbortSignal,
): Promise<{ response: Response; body: TokenResponse }> {
	const timeout = AbortSignal.timeout(30_000);
	const response = await fetch(`${oauthHost()}/api/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", ...kimiCodeHeaders() },
		body: parameters,
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	const body = (await response.json().catch(() => ({}))) as TokenResponse;
	return { response, body };
}

function parseCredential(body: TokenResponse, previousRefreshToken = ""): StoredOAuthCredential {
	const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
	const refreshToken =
		typeof body.refresh_token === "string" && body.refresh_token.trim()
			? body.refresh_token.trim()
			: previousRefreshToken;
	if (!accessToken || !refreshToken || typeof body.expires_in !== "number") {
		throw new Error("Kimi Code token response did not include valid access, refresh, and expiry fields.");
	}
	return {
		type: "oauth",
		accessToken,
		refreshToken,
		expiresAt: Date.now() + body.expires_in * 1000 - EXPIRY_MARGIN_MS,
	};
}

export async function loginKimiCodeOAuth(options: KimiOAuthOptions = {}): Promise<StoredOAuthCredential> {
	await ensureAdaptiveHarnessDir();
	const timeout = AbortSignal.timeout(30_000);
	const response = await fetch(`${oauthHost()}/api/oauth/device_authorization`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", ...kimiCodeHeaders() },
		body: new URLSearchParams({ client_id: CLIENT_ID }),
		signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
	});
	const body = (await response.json().catch(() => ({}))) as DeviceAuthorizationResponse;
	if (!response.ok) throw new Error(`Kimi Code device authorization failed (${response.status}).`);
	const userCode = typeof body.user_code === "string" ? body.user_code : "";
	const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
	const verificationUri = typeof body.verification_uri === "string" ? body.verification_uri : "";
	const verificationUriComplete =
		typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : verificationUri;
	if (!userCode || !deviceCode || !verificationUri) {
		throw new Error("Kimi Code device authorization response was incomplete.");
	}
	const instructions = `Enter code: ${userCode}`;
	options.onAuthorization?.(verificationUriComplete, instructions);
	launchExternalUrl(verificationUriComplete);
	options.onProgress?.("Waiting for Kimi Code authorization...");
	const deadline = Date.now() + (typeof body.expires_in === "number" ? body.expires_in * 1000 : DEFAULT_EXPIRES_MS);
	let interval = typeof body.interval === "number" && body.interval > 0 ? body.interval * 1000 : DEFAULT_INTERVAL_MS;
	while (Date.now() < deadline) {
		if (options.signal?.aborted) throw new Error("Kimi Code authorization cancelled.");
		const token = await postToken(
			new URLSearchParams({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
			options.signal,
		);
		if (token.response.ok && token.body.access_token) return parseCredential(token.body);
		const error = typeof token.body.error === "string" ? token.body.error : "";
		if (error === "authorization_pending") {
			await scheduler.wait(interval, { signal: options.signal });
			continue;
		}
		if (error === "slow_down") {
			interval = Math.max(
				interval + 5_000,
				typeof token.body.interval === "number" ? token.body.interval * 1000 : 0,
			);
			await scheduler.wait(interval, { signal: options.signal });
			continue;
		}
		const detail = typeof token.body.error_description === "string" ? `: ${token.body.error_description}` : "";
		throw new Error(`Kimi Code authorization failed (${error || token.response.status})${detail}`);
	}
	throw new Error("Kimi Code authorization timed out.");
}

export async function refreshKimiCodeOAuth(
	credential: StoredOAuthCredential,
	signal?: AbortSignal,
): Promise<StoredOAuthCredential> {
	if (!credential.refreshToken) throw new Error("Kimi Code credential has no refresh token; log in again.");
	const token = await postToken(
		new URLSearchParams({
			client_id: CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: credential.refreshToken,
		}),
		signal,
	);
	if (!token.response.ok) throw new Error(`Kimi Code token refresh failed (${token.response.status}).`);
	return { ...credential, ...parseCredential(token.body, credential.refreshToken) };
}
