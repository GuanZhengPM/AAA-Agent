import type { StoredApiKeyCredential } from "./credential-store";
import { authorizeWithLocalCallback } from "./oauth-callback";

const CLIENT_ID = process.env.ZAI_OAUTH_CLIENT_ID?.trim() || "client_P8X5CMWmlaRO9gyO-KSqtg";
const AUTHORIZE_URL = process.env.ZAI_OAUTH_AUTHORIZE_URL?.trim() || "https://chat.z.ai/api/oauth/authorize";
const TOKEN_URL = process.env.ZAI_OAUTH_TOKEN_URL?.trim() || "https://zcode.z.ai/api/v1/oauth/token";
const BIZ_BASE = process.env.ZAI_BIZ_BASE?.trim() || "https://api.z.ai";
const BUSINESS_LOGIN_URL = process.env.ZAI_BUSINESS_LOGIN_URL?.trim() || "https://api.z.ai/api/auth/z/login";
const KEY_NAME = "aaa-agent";

interface ZaiOAuthOptions {
	signal?: AbortSignal;
	onAuthorization?(url: string, instructions: string): void;
	onProgress?(message: string): void;
}

interface ZaiProject {
	projectId?: unknown;
	isDefault?: unknown;
}

interface ZaiOrganization {
	organizationId?: unknown;
	isDefault?: unknown;
	projects?: ZaiProject[];
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function successCode(code: unknown): boolean {
	return code === undefined || code === null || code === 0 || code === 200 || code === "0" || code === "200";
}

function unwrapEnvelope(value: unknown, operation: string): unknown {
	if (!value || typeof value !== "object") return value;
	const envelope = value as { code?: unknown; success?: unknown; msg?: unknown; data?: unknown };
	if (!("code" in envelope) && !("success" in envelope)) return value;
	if (envelope.success === false || !successCode(envelope.code)) {
		throw new Error(`Z.AI ${operation} failed: ${text(envelope.msg) ?? String(envelope.code)}`);
	}
	return "data" in envelope ? envelope.data : envelope;
}

async function requestJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
	const timeout = AbortSignal.timeout(30_000);
	const response = await fetch(url, {
		...init,
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	const responseText = await response.text();
	if (!response.ok) throw new Error(`Z.AI request failed (${response.status}): ${responseText.slice(0, 500)}`);
	if (!responseText) return undefined;
	try {
		return JSON.parse(responseText);
	} catch (error) {
		throw new Error(`Z.AI returned invalid JSON from ${new URL(url).pathname}.`, { cause: error });
	}
}

function postJson(
	url: string,
	body: Record<string, string | number>,
	headers: Record<string, string> = {},
	signal?: AbortSignal,
): Promise<unknown> {
	return requestJson(
		url,
		{ method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) },
		signal,
	);
}

function getJson(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
	return requestJson(url, { method: "GET", headers }, signal);
}

function keyRecords(value: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(value))
		return value.filter(item => item && typeof item === "object") as Array<Record<string, unknown>>;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of ["list", "keys", "apiKeys", "records"]) {
			if (Array.isArray(record[key])) return keyRecords(record[key]);
		}
	}
	return [];
}

async function mintCodingPlanKey(oauthAccessToken: string, signal?: AbortSignal): Promise<string> {
	const login = unwrapEnvelope(
		await postJson(BUSINESS_LOGIN_URL, { token: oauthAccessToken }, {}, signal),
		"business login",
	) as { access_token?: unknown; accessToken?: unknown } | undefined;
	const businessToken = text(login?.access_token) ?? text(login?.accessToken);
	if (!businessToken) throw new Error("Z.AI business login returned no access token.");
	const headers = { Authorization: `Bearer ${businessToken}` };
	const customer = unwrapEnvelope(
		await getJson(`${BIZ_BASE}/api/biz/customer/getCustomerInfo`, headers, signal),
		"customer lookup",
	) as { organizations?: ZaiOrganization[] } | undefined;
	const organizations = Array.isArray(customer?.organizations) ? customer.organizations : [];
	const organization = organizations.find(item => item.isDefault) ?? organizations[0];
	const projects = Array.isArray(organization?.projects) ? organization.projects : [];
	const project = projects.find(item => item.isDefault) ?? projects[0];
	const organizationId = text(organization?.organizationId);
	const projectId = text(project?.projectId);
	if (!organizationId || !projectId) throw new Error("Z.AI account has no default organization/project.");
	const keysUrl = `${BIZ_BASE}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;
	const existing = keyRecords(unwrapEnvelope(await getJson(keysUrl, headers, signal), "API key list")).find(
		item => item.name === KEY_NAME,
	);
	const keyRecord =
		existing ??
		(unwrapEnvelope(await postJson(keysUrl, { name: KEY_NAME }, headers, signal), "API key creation") as
			| Record<string, unknown>
			| undefined);
	const apiKey = text(keyRecord?.apiKey);
	if (!apiKey) throw new Error("Z.AI key provisioning returned no API key id.");
	const copied = unwrapEnvelope(
		await getJson(`${keysUrl}/copy/${encodeURIComponent(apiKey)}`, headers, signal),
		"API key copy",
	) as { secretKey?: unknown } | undefined;
	const secret = text(copied?.secretKey);
	if (!secret) throw new Error("Z.AI key provisioning returned no API key secret.");
	return `${apiKey}.${secret}`;
}

export async function loginZaiCodingPlan(options: ZaiOAuthOptions = {}): Promise<StoredApiKeyCredential> {
	const authorization = await authorizeWithLocalCallback(
		{
			provider: "Z.AI Coding Plan",
			preferredPort: 54548,
			buildAuthorizationUrl(state, redirectUri) {
				const parameters = new URLSearchParams({
					redirect_uri: redirectUri,
					response_type: "code",
					client_id: CLIENT_ID,
					state,
				});
				return {
					url: `${AUTHORIZE_URL}?${parameters}`,
					instructions:
						"Complete GLM Coding Plan login in your browser. The callback returns directly to AAA Agent.",
				};
			},
			onAuthorization(info) {
				options.onAuthorization?.(info.url, info.instructions ?? "Complete Z.AI login in your browser.");
			},
		},
		options.signal,
	);
	options.onProgress?.("Provisioning an AAA Agent API key for the GLM Coding Plan...");
	const token = unwrapEnvelope(
		await postJson(
			TOKEN_URL,
			{
				provider: "zai",
				code: authorization.code,
				redirect_uri: authorization.redirectUri,
				state: authorization.state,
			},
			{},
			options.signal,
		),
		"token exchange",
	) as { zai?: { access_token?: unknown } } | undefined;
	const accessToken = text(token?.zai?.access_token);
	if (!accessToken) throw new Error("Z.AI token exchange returned no access token.");
	const apiKey = await mintCodingPlanKey(accessToken, options.signal);
	return { type: "api_key", apiKey, createdAt: Date.now(), label: "Z.AI Coding Plan sign-in" };
}
