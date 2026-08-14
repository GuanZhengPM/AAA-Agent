import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteJson } from "./persistence";
import {
	type AdaptiveOverlay,
	type HarnessRunRecord,
	type ModelCapabilityProfile,
	SERVICE_TIERS,
	type ServiceTier,
	THINKING_MODES,
	type ThinkingMode,
} from "./types";

export interface AdaptiveHarnessState {
	defaultModelId?: string;
	defaultThinkingMode?: ThinkingMode;
	defaultServiceTier?: ServiceTier;
	adaptiveEnabled: boolean;
	profiles: ModelCapabilityProfile[];
	overlays: AdaptiveOverlay[];
	runs: HarnessRunRecord[];
}

const MAX_RUN_RECORDS = 500;
const EMPTY_STATE: AdaptiveHarnessState = { adaptiveEnabled: true, profiles: [], overlays: [], runs: [] };

export function getAdaptiveHarnessDir(): string {
	return process.env.AAA_AGENT_HOME ?? path.join(os.homedir(), ".aaa-agent");
}

export function getStatePath(): string {
	return path.join(getAdaptiveHarnessDir(), "state.json");
}

export function getCredentialPath(): string {
	return path.join(getAdaptiveHarnessDir(), "credentials.json");
}

export async function ensureAdaptiveHarnessDir(): Promise<void> {
	await fs.mkdir(getAdaptiveHarnessDir(), { recursive: true });
}

export async function loadAdaptiveHarnessState(): Promise<AdaptiveHarnessState> {
	try {
		const parsed = await Bun.file(getStatePath()).json();
		if (!parsed || typeof parsed !== "object") return structuredClone(EMPTY_STATE);
		const candidate = parsed as Partial<AdaptiveHarnessState> & { defaultEffort?: unknown };
		const configuredThinkingMode = candidate.defaultThinkingMode ?? candidate.defaultEffort;
		return {
			...(typeof candidate.defaultModelId === "string" ? { defaultModelId: candidate.defaultModelId } : {}),
			...(typeof configuredThinkingMode === "string" && THINKING_MODES.some(mode => mode === configuredThinkingMode)
				? { defaultThinkingMode: configuredThinkingMode as ThinkingMode }
				: {}),
			...(typeof candidate.defaultServiceTier === "string" &&
			SERVICE_TIERS.some(tier => tier === candidate.defaultServiceTier)
				? { defaultServiceTier: candidate.defaultServiceTier as ServiceTier }
				: {}),
			adaptiveEnabled: candidate.adaptiveEnabled !== false,
			profiles: Array.isArray(candidate.profiles) ? candidate.profiles : [],
			overlays: Array.isArray(candidate.overlays) ? candidate.overlays : [],
			runs: Array.isArray(candidate.runs) ? candidate.runs.slice(-MAX_RUN_RECORDS) : [],
		};
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${getStatePath()}`, { cause: error });
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return structuredClone(EMPTY_STATE);
		throw error;
	}
}
export function appendRunRecord(state: AdaptiveHarnessState, record: HarnessRunRecord): void {
	state.runs.push(structuredClone(record));
	if (state.runs.length > MAX_RUN_RECORDS) state.runs.splice(0, state.runs.length - MAX_RUN_RECORDS);
}

export async function saveAdaptiveHarnessState(state: AdaptiveHarnessState): Promise<void> {
	await atomicWriteJson(getStatePath(), state);
}
