# Changelog

## [Unreleased]

### Breaking Changes

- Renamed the product to **AAA Agent (3A Agent)**, the package to `aaa-agent`, the CLI to `aaa`, and the local configuration root to `~/.aaa-agent`.

### Added

- Split AAA Agent into publishable `runtime`, `providers`, `workspace`, and `app` packages behind the stable `aaa-agent` SDK and `aaa` command, with an enforced inward-only dependency graph.
- Added the standalone `aaa` CLI with direct ChatGPT/OpenAI Codex OAuth login, a local model catalog, workspace tools, and streamed Agent execution.
- Added exact model-variant capability profiles, deterministic direct/guided/orchestrated routing, bounded read-only subagents, evidence-backed goals, verification gates, runtime metrics, and persisted online capability observations.
- Added a persistent interactive terminal session with bounded multi-turn context, in-session model/effort selection, workspace navigation, multiline paste, shell escapes, task cancellation, and context reset.
- Added streamed assistant output with compact route, tool, Subagent, verification, latency, token, and completion status.
- Added versioned policy overlays plus held-in, held-out, cross-model, token, latency, and cost gates for controlled offline evolution.
- Added a provider execution contract with OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages adapters; API-key and unauthenticated local endpoints; provider-qualified model selection; and persisted `models.json` or `AAA_AGENT_MODELS` configuration.
- Added built-in GLM 5.2, Kimi K3, Claude Opus/Sonnet 5, Grok 4.6, Xiaomi MiMo V2.5 Pro, and OpenRouter GPT-5.2 presets with provider-specific endpoints, credentials, reasoning controls, context limits, and pricing where officially published.
- Added cross-provider contract coverage for authentication headers, request paths, tool-call round trips, preserved Claude thinking blocks, usage normalization, and provider-specific effort encoding.
- Added built-in DeepSeek V4 Flash/Pro and MiniMax M3 services, plus Z.AI and Kimi Coding Plan and MiniMax and Xiaomi MiMo Token Plan presets with isolated credentials and regional endpoint overrides.
- Added versioned, atomically durable interactive sessions with automatic workspace-local resume, exact session selection, live-process ownership, stale-run recovery, bounded history migration, and terminal-close interruption state.
- Added durable external long-task checkpoints and a bounded execute-audit-recover loop with fresh executor contexts, Auditor-only goal commits, verified facts, artifact tracking, and automatic interrupted-session continuation.
- Added task-sliced capability profiles with confidence, positive/negative evidence counts, global/family fallback, frozen per-run policy snapshots, and `adaptive status|on|off|reset` controls.
- Added current-workspace conversation search through `/search <query>`, `aaa sessions <query>`, and the read-only `history_search` Agent tool.
- Added explicit `auto` and `off` thinking modes plus native service-tier and Anthropic fast-mode controls across one-shot and interactive sessions.
- Added the ANSI terminal wordmark used by the interactive CLI.
- Added optional `--verifier-model` isolation, host-bound evidence ledgers, and verification assurance labels so model prose cannot fabricate completion evidence or silently train outcome capability scores.
- Added bounded structured session context for durable goals, evidence-backed facts and artifacts, open risks, and recovery guidance beyond raw conversation retention.
- Added explicit one-shot Shell policies (`deny`, `ask`, `sandbox`, and `allow`), with `deny` as the non-interactive default.
- Added host-enforced `read-only` and `write` task permissions, automatic read-only intent detection, `--read-only` / `--allow-write` overrides, and interactive `/mode` control.
- Added explicit `--lane` and `--verification` overrides for `aaa run` and `aaa route`; user-selected overrides take precedence over inferred and adaptive policy.
- Added cold-start markers and observed sample counts to model capability profiles and `aaa models` output.
- Added an AAA-owned, versioned multi-provider credential store with hidden API-key input, environment overrides, per-provider status/logout, and migration from the legacy Codex-only credential file.
- Added direct official OAuth flows for Kimi Code, GLM Coding Plan, and Claude Code alongside Codex OAuth; browser flows return to AAA's localhost callback and never route through a pi URL.
- Added bundled Claude Code subscription variants and persistent API-key login for DeepSeek, Z.AI, Moonshot/Kimi, Anthropic, OpenRouter, xAI, MiniMax, MiMo, and custom providers.

### Changed

- Replaced the Unix-only `bash` tool with a cross-platform `shell` tool that uses `cmd.exe` on Windows and the configured POSIX shell on macOS/Linux.
- Added macOS and Windows installation, PATH, OAuth callback, and command examples.
- Removed all framework-specific runtime dependencies. OAuth, token refresh, Responses SSE transport, the Agent loop, model types, snapshots, and exact-text editing now live in this package.
- Made bare `aaa` launch the interactive product while preserving `run`, piped stdin, `route`, `models`, `use`, and authentication commands for automation.
- Persisted the preferred thinking mode and service tier alongside the default model, with migration from legacy effort-only state and sessions.
- Requests now use the standalone `aaa_agent` originator and `aaa-agent` user agent.
- Routing now combines observed model capabilities with task shape to select tool surface, retry limits, planning horizon, parallelism, verification, token budget, and a model-supported reasoning effort.
- Capability learning now derives per-dimension weighted observations from tool arguments, edits, recovery, verification, Subagents, long-context success, latency, and cost.
- Capability learning now accepts completion and long-context success only from audited evidence; unverified runs update only directly observed behavior, and learned state affects the next task rather than an in-flight run.
- Quota-backed routes now direct models to batch independent work while retaining full turn limits and additional tool and recovery headroom.
- Model capability scores now add scaffolding, retries, and verification support without withholding tools, reducing token capacity, disabling reasoning, or stopping useful tool calls at a soft budget target.
- Tool-call context now compacts older large outputs before replay, and cumulative token budgets act as visible completion targets instead of terminating an otherwise productive run.
- Context compaction now preserves the newest tool result preferentially while retaining bounded head/tail evidence from older oversized outputs.
- Made turn, tool-call, output-token, and total-token limits hard runtime ceilings while keeping large Shell output bounded.
- Made token ceilings task-wide across Primary, Verifier, and Subagent sessions, capped each Verifier at 20% of the total, and limited automatic recovery to one repair before checkpointing.
- Targeted verification now accepts a fresh deterministic check after the latest workspace mutation without starting another model session.
- Workspace discovery now skips common dependency and build directories; text search also skips binary and oversized files and validates bounded regular expressions.
- Provider clients now resolve credentials per request, refresh expiring Kimi/Claude/Codex OAuth grants, retry one OAuth 401 after refresh, and emit the provider-specific bearer, beta, and Kimi device headers.


### Fixed

- Interactive model selection now supports arrow-key navigation, numeric choices with optional punctuation, full menu labels, model names, bare IDs, and provider-qualified IDs without leaking picker input into chat.
- Progressively exposes gated tools when requested or after repeated failures, blocks identical tool-call loops, and stops after sustained no-progress failures.
- Preserved explicit thinking-off and native effort choices across adaptive routing instead of treating minimum effort as disabled reasoning.
- Forwarded native reasoning-disable and service-tier controls through OpenAI Responses, OpenAI-compatible Chat Completions, Anthropic Messages, primary, Subagent, and verifier requests.
- Interactive terminal input is paused on close so completed sessions exit immediately instead of remaining alive on a PTY.
- Bound custom-goal completion evidence to individual required criteria instead of copying general audit evidence across a goal.
- Kept unverified executor artifacts out of recovery checkpoints and verified-fact prompts.
- Restricted Auditors to read-only file discovery and inspection tools, excluding file mutation and shell execution.
- Replayed interrupted in-flight rounds, including the final recovery round, without consuming an uncompleted attempt.
- Added exclusive per-session leases to prevent concurrent processes from overwriting one session.
- Excluded configuration and verification-infrastructure failures from behavioral capability penalties.
- Kept AAA Agent product questions scoped to the standalone package instead of substituting the host workspace.
- Preserved a completed final answer when cumulative provider usage crosses the route token budget on that final turn.
- Session history search tolerates sessions that disappear or become unreadable during a concurrent scan.
- Session leases now use atomically installed, fully initialized lock directories and safely quarantine stale locks without admitting concurrent owners.
- Runtime verifier and Subagent results are validated at the boundary so malformed provider output fails closed instead of corrupting checkpoints or aborting unrelated work.
- Concurrent workspace shell output is drained without stdout/stderr deadlock, retained in bounded head/tail captures, and reported with preserved exit status.
- Interactive cancellation, EOF, and termination persist recoverable interrupted state and always release the session lease.
- Recovered tasks interrupted before their first checkpoint and imported durable completed-checkpoint output without rerunning side effects.
- Required host approval for every Agent-requested Shell command, so whitespace and alternate command forms cannot bypass review.
- Restricted verifier command execution to host-registered checks with fixed arguments and current-round metadata.
- Distinguished known `write`/`edit` mutations from unknown Shell effects, invalidated successful checks after later edits, and stopped read-only Shell commands from triggering model verification.
- Restricted workspace subprocess environments to an allowlist and made automatic verification checks fail closed when no supported OS sandbox is available.
- Routed parallel work only from explicit imperative intent, respected negated parallel requests, and exposed parsed task features in `aaa route` output.
- Persisted only explicit facts backed by independent verification or deterministic host evidence instead of promoting generic evidence summaries.
- Forwarded interactive `/mode` selections into the runtime permission override so the displayed mode is enforced for subsequent tasks.
