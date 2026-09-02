import type { AgentTool } from "@aaa-agent/runtime";
import { z } from "zod/v4";
import historySearchDescription from "./prompts/history-search.md" with { type: "text" };
import { searchInteractiveSessions } from "./session-store";

const historySearchSchema = z.object({
	query: z.string().min(1),
	limit: z.number().int().min(1).max(10).optional(),
});

export function createHistorySearchTool(cwd: string): AgentTool {
	return {
		name: "history_search",
		label: "Search history",
		description: historySearchDescription,
		sideEffect: "none",
		parameters: historySearchSchema,
		async execute(_toolCallId, rawParams) {
			const params = historySearchSchema.parse(rawParams);
			const matches = await searchInteractiveSessions(params.query, cwd, params.limit ?? 5);
			const text =
				matches.length > 0
					? matches
							.map(
								match =>
									`${match.session.id} · ${new Date(match.session.updatedAt).toISOString()} · ${match.role}\n${match.excerpt}`,
							)
							.join("\n\n")
					: "No matching conversations in the current workspace.";
			return {
				content: [{ type: "text", text }],
				details: { matches: matches.length },
			};
		},
	};
}
