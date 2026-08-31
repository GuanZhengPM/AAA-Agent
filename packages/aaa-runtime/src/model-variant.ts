import type { ModelCapabilityProfile, ModelVariant, ModelVariantOptions, ModelVariantSource } from "./types";

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

function decodeVariantPart(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

/**
 * 画像记录只保存复合 variantKey（含认证通道、端点、推理档位等维度），但
 * `aaa models` 这类界面需要按用户看到的 `provider/modelId` 反查画像。
 * 用复合 key 直接和 `provider/modelId` 比较永远不相等，这里还原出这一对标识。
 *
 * 依赖 `createModelVariant` 的字段顺序（provider 在第 1 位、modelId 在第 6 位）；
 * 顺序若变更，`aaa models` 会退回显示冷启动，而不是报错，因此下方保留长度校验。
 */
export function parseModelVariantKey(key: string): { provider: string; modelId: string } | undefined {
	const parts = key.split("|");
	if (parts.length < 6) return undefined;
	const provider = decodeVariantPart(parts[0]);
	const modelId = decodeVariantPart(parts[5]);
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

/** Select one honest, stable summary profile for each provider/model pair. */
export function indexCapabilityProfilesByModel(
	profiles: readonly ModelCapabilityProfile[],
): Map<string, ModelCapabilityProfile> {
	const result = new Map<string, ModelCapabilityProfile>();
	for (const profile of profiles) {
		const parsed = parseModelVariantKey(profile.variantKey);
		if (!parsed) continue;
		const identity = `${parsed.provider}/${parsed.modelId}`;
		const existing = result.get(identity);
		if (!existing) {
			result.set(identity, profile);
			continue;
		}
		const profilePriority = profile.taskSlice === "global" ? 1 : 0;
		const existingPriority = existing.taskSlice === "global" ? 1 : 0;
		if (
			profilePriority > existingPriority ||
			(profilePriority === existingPriority && profile.samples > existing.samples)
		) {
			result.set(identity, profile);
		}
	}
	return result;
}
