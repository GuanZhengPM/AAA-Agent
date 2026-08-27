<pre align="center">
 █████╗  █████╗  █████╗
██╔══██╗██╔══██╗██╔══██╗
███████║███████║███████║
██╔══██║██╔══██║██╔══██║
██║  ██║██║  ██║██║  ██║
╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝
          3A AGENT
</pre>

<h1 align="center">AAA Agent</h1>

<p align="center"><strong>Less control overhead. Full coding capability.</strong><br>轻量控制，完整 coding 体验。</p>

<p align="center">
  <a href="#中文">中文</a> · <a href="#english">English</a>
</p>

---

<a id="中文"></a>

## 中文

### 项目简介

AAA Agent（`aaa`）是一个使用 Bun 和 TypeScript 开发的终端编程 Agent，支持代码检索与修改、命令执行、多模型接入、任务验证和中断恢复。

运行时会根据任务特征和所选模型调整执行路线、推理强度、工具预算与验证策略。能力相对有限的模型会获得更多步骤引导、失败恢复和结果检查；能力较强的模型继续使用完整工具、原生推理档位和与模型上下文匹配的执行预算。

主要功能：

- **自适应路由**：按任务范围选择 `direct`、`guided` 或 `orchestrated`；
- **模型感知策略**：按模型能力调整推理、工具、重试和验证配置；
- **受控并行**：主 Agent 负责写入，Subagent 只读；
- **审计与验证**：完成状态必须绑定运行时证据；
- **任务恢复**：长任务保存 checkpoint，可在中断后继续；
- **持久会话**：append-only 保存完整 transcript，并按模型/成本动态压缩实时工作集；
- **Provider 效率**：稳定会话缓存、统一退避重试、流式响应和 Provider 级并发限制；
- **独立多 Provider 认证**：AAA 自己完成 Codex、Kimi Code、GLM Coding Plan、Claude Code OAuth，并支持安全保存 API Key。

项目由五个 Bun workspace 包组成，不依赖服务端或数据库。

### 当前状态

- 版本：`0.4.0`
- 运行时：Bun `1.3.14+`
- 主要界面：终端 CLI
- 系统：macOS、Linux、Windows
- 仓库目前以源码运行和开发为主

### 快速开始

```sh
git clone git@github.com:GuanZhengPM/AAA-Agent.git
cd AAA-Agent
bun install
bun run aaa --help
bun run aaa
```

从某个项目目录启动时，AAA Agent 会把该目录作为工作区：

```sh
cd /path/to/your/project
bun /path/to/AAA-Agent/packages/aaa-app/src/cli.ts
```

如果希望直接使用 `aaa` 命令，可以链接聚合包：

```sh
cd /path/to/AAA-Agent/packages/aaa-agent
bun link
aaa --help
```

### 登录与模型

认证由 AAA Agent 自己实现，不依赖 pi 的认证内核，也不会跳转到 pi 的 URL。OAuth 只会打开对应厂商的官方地址（`auth.openai.com`、`auth.kimi.com`、`chat.z.ai`、`claude.ai`）并回调本机 `localhost`。

| Provider | 登录方式 | 内置模型示例 |
| --- | --- | --- |
| ChatGPT / Codex | 浏览器 OAuth | `openai-codex/gpt-5.6-sol` |
| Kimi Code | Device OAuth；也可使用 Console Key | `kimi-code/k3` |
| GLM Coding Plan | 浏览器登录并为 AAA 创建独立 Coding Plan Key；也可直接填 Key | `z-ai-coding/glm-5.2` |
| Claude Code | Claude Pro/Max 浏览器 OAuth | `claude-code/claude-sonnet-5` |
| DeepSeek、Z.AI、Moonshot/Kimi、Anthropic、OpenRouter、xAI、MiniMax、MiMo | API Key 或环境变量 | 运行 `aaa models` 查看 |

常用认证命令：

```sh
aaa auth providers                         # 查看支持的登录方式
aaa auth login                             # 向后兼容：登录 Codex
aaa auth login kimi-code                   # Kimi Device OAuth
aaa auth login z-ai-coding                 # GLM Coding Plan 浏览器登录
aaa auth login claude-code                 # Claude Pro/Max OAuth
aaa auth set-key deepseek                  # 隐藏输入，不回显 key
printf '%s' "$DEEPSEEK_API_KEY" | aaa auth set-key deepseek --stdin
aaa auth login kimi-code --api-key         # 不使用 OAuth，改存 Console Key
aaa auth status [provider]
aaa auth logout [provider]
aaa auth logout --all
```

不要把 key 直接放在命令参数中，以免进入 shell history。显式环境变量优先于 `~/.aaa-agent/credentials.json` 中保存的凭据；内置变量包括 `DEEPSEEK_API_KEY`、`ZAI_API_KEY`、`ZAI_CODING_PLAN_API_KEY`、`MOONSHOT_API_KEY`、`KIMI_CODE_API_KEY`、`ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN` 等。凭据文件使用 `0600` 权限，状态输出永不打印 secret；旧版单一 Codex 凭据会自动迁移。

查看和切换模型：

```sh
aaa providers
aaa models
aaa use openai-codex/gpt-5.6-sol
```

也可以在 `~/.aaa-agent/models.json` 中添加 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 或本地 OpenAI-compatible 模型。自定义 Provider 可以通过模型配置中的 `apiKeyEnv` 读取环境变量，也可以运行 `aaa auth set-key <provider>` 写入独立凭据仓。

一个最小的本地模型配置：

```json
[
  {
    "provider": "local",
    "id": "coding-model",
    "name": "Local Coding Model",
    "api": "openai-chat-completions",
    "baseUrl": "http://127.0.0.1:8000/v1",
    "contextWindow": 32768,
    "efforts": ["minimal"],
    "authChannel": "local"
  }
]
```

### 常用方式

交互会话：

```sh
aaa
```

一次性任务：

```sh
aaa run "解释认证请求从 CLI 到 provider 的调用路径"
aaa run --effort high "修复 parser 回归并运行相关测试"
aaa run --subagent-model openai-codex/gpt-5.4-mini "并行检查三个独立模块"
cat task.txt | aaa run --cwd /path/to/project
```

只看路由结果，不发模型请求：

```sh
aaa route "检查认证和存储实现，并列出风险"
```

会话命令：

| 命令 | 用途 |
| --- | --- |
| `/model` | 切换模型 |
| `/effort` | 选择推理强度或 `auto` |
| `/tier`、`/fast` | 选择模型支持的服务层级 |
| `/status` | 查看模型、工作区、上下文和任务状态 |
| `/sessions`、`/resume` | 查看或恢复会话 |
| `/search <query>` | 搜索当前工作区的历史会话 |
| `/new` | 新建会话 |
| `/cd <path>` | 切换工作区 |
| `/paste` | 输入多行任务，单独一行 `.` 结束 |
| `/clear` | 清除当前会话的原始和结构化上下文 |
| `/tools on\|off` | 显示或隐藏工具过程 |
| `!<command>` | 明确地在当前工作区运行本地命令 |
| `/exit` | 保存并退出 |

### Shell 安全

文件工具会拒绝工作区外的路径和越界符号链接。Shell 不同：它使用当前用户权限，理论上可以读取工作区外的文件。

因此：

- 交互会话中，Agent 发起的 Shell 命令需要确认；输入 `a` 可仅对当前 session 中“同 cwd + 完全相同命令”复用授权；
- `aaa run` 默认使用 `--shell-policy deny`；
- 自动化场景必须显式选择策略：

```sh
aaa run --shell-policy deny "..."     # 禁止 Shell，默认值
aaa run --shell-policy ask "..."      # 每次询问，只适合交互终端
aaa run --shell-policy sandbox "..."  # 只允许宿主标记为已沙箱化的命令
aaa run --shell-policy allow "..."    # 全部允许，请谨慎使用
```

macOS 的 sandbox 会限制写入和网络，但不是保密边界；不要把它当成“命令看不到工作区外文件”的保证。

### 它怎么工作

```text
aaa-agent                  对外 SDK 和 `aaa` 命令
└── @aaa-agent/app          CLI、会话、提示词、终端输出
    ├── @aaa-agent/providers   模型目录、独立 OAuth/API Key 凭据仓、Provider 协议
    │   └── @aaa-agent/runtime
    ├── @aaa-agent/workspace   文件、搜索和 Shell 工具
    │   └── @aaa-agent/runtime
    └── @aaa-agent/runtime     Agent loop、路由、验证、恢复和能力记录
```

依赖只向内。`runtime` 不知道终端、具体 Provider 或文件系统实现；`app` 负责把各层组装起来。

任务会被分到三条路线：

| 路线 | 适合的任务 | 执行方式 |
| --- | --- | --- |
| `direct` | 范围小、步骤少 | 较短预算，按需验证 |
| `guided` | 多步骤、多文件、长上下文或高风险 | 保存目标状态，执行后审计 |
| `orchestrated` | 用户明确要求并行，或任务带依赖图 | 只读 Subagent、DAG 调度、严格验证 |

Guided 和 Orchestrated 任务使用有界的 `execute → audit → checkpoint → recover` 循环。确定性 completion gate 失败会先把真实 rc/stdout/stderr 回灌同一个 Agent loop，只有仍未解决时才使用外层恢复轮。Primary、Verifier 和 Subagent 共享同一任务 token 余额，单次 Verifier 最多使用总额的 20%。写入后的最新确定性检查可以直接完成 targeted 验证；后续修改会立即使旧检查失效。执行器可以提出“已完成”，但只有绑定到宿主证据的审计结果才能提交目标。长期保存的 verified facts 必须由独立验证或确定性宿主证据明确给出，不会从普通日志里自动拼出来。

### 本地数据

默认目录是 `~/.aaa-agent/`：

```text
~/.aaa-agent/
├── credentials.json   多 Provider OAuth/API Key 凭据（0600）
├── models.json        自定义模型，可选
├── state.json         默认模型和本地能力记录
└── sessions/          小型 metadata JSON + append-only transcript JSONL
```

可以通过 `AAA_AGENT_HOME=/path/to/dir` 改到其他位置。`credentials.json` 是受 `0600` 权限保护的本地 JSON，并非系统钥匙串或加密保险库；不希望 key 落盘时请只使用环境变量。凭据和会话可能包含敏感信息，不要提交到仓库。

### 开发

```sh
bun install
bun run check
bun test
```

只运行 CLI：

```sh
bun run aaa --help
bun run aaa route "检查这个任务会走哪条路线"
```

代码边界由 `packages/aaa-agent/scripts/check-package-boundaries.ts` 检查。测试主要在 `packages/aaa-app/test` 和 `packages/aaa-workspace/test`。

### 致谢与许可证

项目包含按 MIT 许可证使用的上游代码；必须保留的版权声明见 [LICENSE](./LICENSE)。

项目使用 MIT License。

---

<a id="english"></a>

## English

### Overview

AAA Agent (`aaa`) is a terminal coding agent built with Bun and TypeScript. It supports code search and editing, command execution, multiple model providers, task verification, and recovery after interruption.

The runtime adjusts routing, reasoning effort, tool budgets, and verification policy to the task and selected model. Less capable models receive more execution guidance, failure recovery, and result checking. Stronger models retain the full toolset, native reasoning levels, and execution budgets sized to their context capacity.

Key features:

- **Adaptive routing**: selects `direct`, `guided`, or `orchestrated` from the task scope;
- **Model-aware policy**: adjusts reasoning, tools, retries, and verification to the model;
- **Controlled parallelism**: the primary Agent writes; Subagents are read-only;
- **Audit and verification**: completion must be backed by runtime evidence;
- **Task recovery**: long-running tasks persist checkpoints and resume after interruption;
- **Persistent sessions**: append-only full transcripts with a model/cost-aware live working set;
- **Provider efficiency**: stable cache affinity, unified retries, streaming, and provider-level concurrency limits;
- **Independent multi-provider auth**: AAA owns Codex, Kimi Code, GLM Coding Plan, and Claude Code OAuth flows plus secure API-key storage.

The project is organized as five Bun workspace packages and requires no server or database.

### Status

- Version: `0.4.0`
- Runtime: Bun `1.3.14+`
- Main interface: terminal CLI
- Platforms: macOS, Linux, and Windows
- The repository is currently intended for source-based use and development

### Quick start

```sh
git clone git@github.com:GuanZhengPM/AAA-Agent.git
cd AAA-Agent
bun install
bun run aaa --help
bun run aaa
```

To use a project directory as the workspace:

```sh
cd /path/to/your/project
bun /path/to/AAA-Agent/packages/aaa-app/src/cli.ts
```

To expose the `aaa` command locally, link the aggregate package:

```sh
cd /path/to/AAA-Agent/packages/aaa-agent
bun link
aaa --help
```

### Authentication and models

Authentication is implemented by AAA Agent itself: it does not invoke pi's auth core or redirect through a pi URL. OAuth opens only the provider's official host (`auth.openai.com`, `auth.kimi.com`, `chat.z.ai`, or `claude.ai`) and returns to a localhost callback owned by AAA.

| Provider | Authentication | Bundled model example |
| --- | --- | --- |
| ChatGPT / Codex | Browser OAuth | `openai-codex/gpt-5.6-sol` |
| Kimi Code | Device OAuth or a Console key | `kimi-code/k3` |
| GLM Coding Plan | Browser sign-in that provisions an AAA-specific plan key, or a pasted key | `z-ai-coding/glm-5.2` |
| Claude Code | Claude Pro/Max browser OAuth | `claude-code/claude-sonnet-5` |
| DeepSeek, Z.AI, Moonshot/Kimi, Anthropic, OpenRouter, xAI, MiniMax, MiMo | API key or environment variable | Run `aaa models` |

Common authentication commands:

```sh
aaa auth providers
aaa auth login                             # backward-compatible Codex login
aaa auth login kimi-code
aaa auth login z-ai-coding
aaa auth login claude-code
aaa auth set-key deepseek                  # hidden TTY input
printf '%s' "$DEEPSEEK_API_KEY" | aaa auth set-key deepseek --stdin
aaa auth login kimi-code --api-key         # use a Console key instead of OAuth
aaa auth status [provider]
aaa auth logout [provider]
aaa auth logout --all
```

Do not pass a secret as a command argument because it can enter shell history. An explicit environment variable takes precedence over the credential saved in `~/.aaa-agent/credentials.json`. Bundled variables include `DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `ZAI_CODING_PLAN_API_KEY`, `MOONSHOT_API_KEY`, `KIMI_CODE_API_KEY`, `ANTHROPIC_API_KEY`, and `CLAUDE_CODE_OAUTH_TOKEN`. The store is mode `0600`, status output never prints secrets, and legacy single-Codex credentials migrate automatically.

Inspect and select models:

```sh
aaa providers
aaa models
aaa use openai-codex/gpt-5.6-sol
```

Additional OpenAI Responses, OpenAI Chat Completions, Anthropic Messages, and local OpenAI-compatible models can be added in `~/.aaa-agent/models.json`. A custom provider may read `apiKeyEnv` or use a credential saved with `aaa auth set-key <provider>`.

A minimal local model entry:

```json
[
  {
    "provider": "local",
    "id": "coding-model",
    "name": "Local Coding Model",
    "api": "openai-chat-completions",
    "baseUrl": "http://127.0.0.1:8000/v1",
    "contextWindow": 32768,
    "efforts": ["minimal"],
    "authChannel": "local"
  }
]
```

### Everyday use

Interactive session:

```sh
aaa
```

One-shot tasks:

```sh
aaa run "Explain how authentication reaches the provider client"
aaa run --effort high "Fix the parser regression and run the relevant test"
aaa run --subagent-model openai-codex/gpt-5.4-mini "Inspect three independent modules in parallel"
cat task.txt | aaa run --cwd /path/to/project
```

Preview routing without making a model request:

```sh
aaa route "Inspect authentication and storage, then list the risks"
```

Session commands:

| Command | Purpose |
| --- | --- |
| `/model` | Select a model |
| `/effort` | Select a reasoning effort or `auto` |
| `/tier`, `/fast` | Select a supported service tier |
| `/status` | Show model, workspace, context, and task state |
| `/sessions`, `/resume` | List or resume sessions |
| `/search <query>` | Search session history for the current workspace |
| `/new` | Start a new session |
| `/cd <path>` | Change workspace |
| `/paste` | Enter a multiline task; finish with a single `.` line |
| `/clear` | Clear raw and structured context for the session |
| `/tools on\|off` | Show or hide tool activity |
| `!<command>` | Explicitly run a local command in the workspace |
| `/exit` | Save and exit |

### Shell safety

File tools reject paths and symlinks that escape the workspace. Shell is different: it runs with the current user's permissions and may be able to read files outside the workspace.

For that reason:

- Agent-requested Shell commands require confirmation in interactive sessions; entering `a` reuses approval only for the exact same command and cwd in that session;
- `aaa run` defaults to `--shell-policy deny`;
- automation must opt into another policy explicitly:

```sh
aaa run --shell-policy deny "..."     # no Shell; the default
aaa run --shell-policy ask "..."      # ask every time; interactive terminals only
aaa run --shell-policy sandbox "..."  # allow only commands marked sandboxed by the host
aaa run --shell-policy allow "..."    # allow all commands; use with care
```

The macOS sandbox limits writes and network access, but it is not a confidentiality boundary. Do not assume a sandboxed command is unable to read outside the workspace.

### How it is organized

```text
aaa-agent                  Public SDK and `aaa` command
└── @aaa-agent/app          CLI, sessions, prompts, terminal reporting
    ├── @aaa-agent/providers   Model catalog, independent OAuth/API-key store, provider transports
    │   └── @aaa-agent/runtime
    ├── @aaa-agent/workspace   File, search, and Shell tools
    │   └── @aaa-agent/runtime
    └── @aaa-agent/runtime     Agent loop, routing, audit/recovery, observations
```

Dependencies point inward. `runtime` has no knowledge of the terminal, concrete providers, or a workspace implementation; `app` is the composition root.

Tasks use one of three routes:

| Route | Typical task | Runtime behavior |
| --- | --- | --- |
| `direct` | Small, local change | Shorter budget; verification when needed |
| `guided` | Multi-step, multi-file, long-context, or risky work | Durable goals and an audit after execution |
| `orchestrated` | Explicit parallel work or a supplied dependency graph | Read-only Subagents, DAG scheduling, strict verification |

Guided and Orchestrated tasks run a bounded `execute → audit → checkpoint → recover` loop. A deterministic completion-gate failure first feeds real rc/stdout/stderr back into the same Agent loop; an outer recovery round is used only if that remains unresolved. Primary, Verifier, and Subagent sessions share one task-wide token balance, and each Verifier session is capped at 20% of the total. A current deterministic check after the latest write can satisfy targeted verification without another model session; any later write invalidates that check. The executor may claim completion, but goals are committed only when the audit cites evidence recorded by the host. Durable verified facts must come from independent verification or deterministic host evidence, never from generic logs.

### Local data

AAA Agent stores local data under `~/.aaa-agent/` by default:

```text
~/.aaa-agent/
├── credentials.json   Multi-provider OAuth/API keys (mode 0600)
├── models.json        Optional custom models
├── state.json         Defaults and local capability observations
└── sessions/          Small metadata JSON + append-only transcript JSONL
```

Set `AAA_AGENT_HOME=/path/to/dir` to move it elsewhere. `credentials.json` is local JSON protected by mode `0600`, not an OS keychain or encrypted vault; use environment variables only if secrets must not be written to disk. Credentials and sessions may contain sensitive data and should not be committed.

### Development

```sh
bun install
bun run check
bun test
```

Run the CLI directly:

```sh
bun run aaa --help
bun run aaa route "Show the route for this task"
```

Package boundaries are checked by `packages/aaa-agent/scripts/check-package-boundaries.ts`. Most tests live in `packages/aaa-app/test` and `packages/aaa-workspace/test`.

### Credits and license

The project includes upstream code used under the MIT License; required copyright notices are retained in [LICENSE](./LICENSE).

Released under the MIT License.
