import * as fs from "node:fs/promises";
import { atomicWriteJson, ensureAdaptiveHarnessDir, getCredentialPath, type Model } from "@aaa-agent/runtime";

export interface StoredApiKeyCredential {
	type: "api_key";
	apiKey: string;
	createdAt: number;
	label?: string;
}

export interface StoredOAuthCredential {
	type: "oauth";
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	authorizedAt?: number;
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
}

export type StoredProviderCredential = StoredApiKeyCredential | StoredOAuthCredential;

export interface CredentialStoreFile {
	version: 2;
	providers: Record<string, StoredProviderCredential>;
}

export interface ResolvedProviderCredential {
	provider: string;
	kind: "api_key" | "oauth";
	secret: string;
	source: string;
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
	expiresAt?: number;
}

export interface ProviderCredentialResolver {
	hasAuth(model: Model): boolean;
	resolveCredential(
		model: Model,
		signal?: AbortSignal,
		forceRefresh?: boolean,
	): Promise<ResolvedProviderCredential | undefined>;
	authenticationLabel(model: Model): string;
}

const EMPTY_STORE: CredentialStoreFile = { version: 2, providers: {} };

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function parseStoredCredential(provider: string, raw: unknown): StoredProviderCredential {
	if (!raw || typeof raw !== "object") throw new Error(`Invalid credential for provider '${provider}'.`);
	const value = raw as Record<string, unknown>;
	if (value.type === "api_key") {
		const apiKey = nonEmptyString(value.apiKey);
		if (!apiKey) throw new Error(`Invalid API key credential for provider '${provider}'.`);
		return {
			type: "api_key",
			apiKey,
			createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
			...(optionalString(value.label) ? { label: optionalString(value.label) } : {}),
		};
	}
	if (value.type === "oauth") {
		const accessToken = nonEmptyString(value.accessToken);
		if (!accessToken || typeof value.expiresAt !== "number") {
			throw new Error(`Invalid OAuth credential for provider '${provider}'.`);
		}
		return {
			type: "oauth",
			accessToken,
			refreshToken: typeof value.refreshToken === "string" ? value.refreshToken : "",
			expiresAt: value.expiresAt,
			...(typeof value.authorizedAt === "number" ? { authorizedAt: value.authorizedAt } : {}),
			...(optionalString(value.email) ? { email: optionalString(value.email) } : {}),
			...(optionalString(value.accountId) ? { accountId: optionalString(value.accountId) } : {}),
			...(optionalString(value.orgId) ? { orgId: optionalString(value.orgId) } : {}),
			...(optionalString(value.orgName) ? { orgName: optionalString(value.orgName) } : {}),
		};
	}
	throw new Error(`Unknown credential type for provider '${provider}'.`);
}

function migrateLegacyCodexCredential(raw: Record<string, unknown>): CredentialStoreFile | undefined {
	const accessToken = nonEmptyString(raw.accessToken);
	const refreshToken = nonEmptyString(raw.refreshToken);
	if (!accessToken || !refreshToken || typeof raw.expiresAt !== "number") return undefined;
	return {
		version: 2,
		providers: {
			"openai-codex": {
				type: "oauth",
				accessToken,
				refreshToken,
				expiresAt: raw.expiresAt,
				...(optionalString(raw.email) ? { email: optionalString(raw.email) } : {}),
				...(optionalString(raw.accountId) ? { accountId: optionalString(raw.accountId) } : {}),
			},
		},
	};
}

export async function loadCredentialStore(): Promise<CredentialStoreFile> {
	try {
		const raw: unknown = await Bun.file(getCredentialPath()).json();
		if (!raw || typeof raw !== "object") throw new Error(`Invalid credentials file: ${getCredentialPath()}`);
		const record = raw as Record<string, unknown>;
		const legacy = migrateLegacyCodexCredential(record);
		if (legacy) {
			await saveCredentialStore(legacy);
			return legacy;
		}
		if (record.version !== 2 || !record.providers || typeof record.providers !== "object") {
			throw new Error(`Invalid credentials file: ${getCredentialPath()}`);
		}
		const providers: Record<string, StoredProviderCredential> = {};
		for (const [provider, credential] of Object.entries(record.providers as Record<string, unknown>)) {
			providers[provider] = parseStoredCredential(provider, credential);
		}
		return { version: 2, providers };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return structuredClone(EMPTY_STORE);
		if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${getCredentialPath()}`, { cause: error });
		throw error;
	}
}

export async function saveCredentialStore(store: CredentialStoreFile): Promise<void> {
	await ensureAdaptiveHarnessDir();
	await atomicWriteJson(getCredentialPath(), store);
	if (process.platform !== "win32") await fs.chmod(getCredentialPath(), 0o600);
}

export async function setStoredCredential(provider: string, credential: StoredProviderCredential): Promise<void> {
	const store = await loadCredentialStore();
	store.providers[provider] = structuredClone(credential);
	await saveCredentialStore(store);
}

export async function removeStoredCredential(provider: string): Promise<boolean> {
	const store = await loadCredentialStore();
	if (!(provider in store.providers)) return false;
	delete store.providers[provider];
	await saveCredentialStore(store);
	return true;
}

export async function clearStoredCredentials(): Promise<number> {
	const store = await loadCredentialStore();
	const count = Object.keys(store.providers).length;
	if (count > 0) await saveCredentialStore(structuredClone(EMPTY_STORE));
	return count;
}
