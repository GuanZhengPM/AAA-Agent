import type { AgentTool } from "./agent";
import type { Effort, Model, ServiceTier, UsageMetrics } from "./types";

export interface AgentFunctionCall {
	callId: string;
	name: string;
	arguments: string;
}

export interface AgentTurnResult {
	output: Record<string, unknown>[];
	text: string;
	toolCalls: AgentFunctionCall[];
	usage: UsageMetrics;
}

export interface AgentTurnOptions {
	model: Model;
	systemPrompt: string;
	input: Record<string, unknown>[];
	tools: AgentTool[];
	effort: Effort;
	disableReasoning?: boolean;
	serviceTier?: ServiceTier;
	maxOutputTokens?: number;
	sessionId: string;
	signal: AbortSignal;
	onTextDelta?: (delta: string) => void;
}

export interface AgentTurnProvider {
	readonly provider: string;
	readonly identity?: string;
	runTurn(options: AgentTurnOptions): Promise<AgentTurnResult>;
}
