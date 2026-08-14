import type { ModelVariant, ModelVariantOptions, ModelVariantSource } from "./types";

/**
 * Builds the exact behavioral identity used by capability profiles and overlays.
 * Auth channel, transport protocol, endpoint, reasoning configuration, and tool
 * schema are deliberately part of the key: identical model ids can behave
 * differently across subscription and API surfaces.
 */
function inferModelFamily(modelId: string): string {
	if (/^(?:gpt-|o\d)/i.test(modelId)) return "openai";
	return modelId.split(/[-/:]/, 1)[0]?.toLowerCase() || "unknown";
}
export function resolveModelBaseUrl(source: Pick<ModelVariantSource, "baseUrl" | "baseUrlEnv">): string {
	const configured = source.baseUrlEnv ? process.env[source.baseUrlEnv]?.trim() : undefined;
	return (configured || source.baseUrl).replace(/\/+$/, "");
}
export function createModelVariant(source: ModelVariantSource, options: ModelVariantOptions): ModelVariant {
	const endpoint = resolveModelBaseUrl(source);
	const family = options.family ?? inferModelFamily(source.id);
	const reasoningConfig = options.reasoningConfig ?? "default";
	const toolSchemaVersion = options.toolSchemaVersion ?? "default";
	const servicePlan =
		source.servicePlan ??
		(options.authChannel === "subscription" ? "subscription" : options.authChannel === "local" ? "local" : "payg");
	const keyParts = [
		source.provider,
		options.authChannel,
		servicePlan,
		source.api,
		endpoint,
		source.id,
		family,
		reasoningConfig,
		options.serviceTier ?? "standard",
		toolSchemaVersion,
	];
	return {
		key: keyParts.map(part => encodeURIComponent(part)).join("|"),
		provider: source.provider,
		modelId: source.id,
		api: source.api,
		endpoint,
		authChannel: options.authChannel,
		servicePlan,
		family,
		reasoningConfig,
		...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
		efforts: [...source.efforts],
		toolSchemaVersion,
	};
}
