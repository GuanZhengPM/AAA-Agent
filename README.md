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

<p align="center"><strong>Adaptive Terminal Coding Agent: Route by Task, Adapt by Model Capability.</strong><br>自适应终端 Coding Agent：按任务自适应路由，按模型能力动态施策。</p>

<p align="center">
  <a href="#中文">中文</a> · <a href="#english">English</a>
</p>

---

<a id="中文"></a>

## 中文

### 项目简介

AAA Agent（`aaa`）是一个基于 Bun 与 TypeScript 构建的终端编程 Agent。它针对两类核心工程挑战进行设计：

1. **任务复杂度的动态适配**：单行修改或代码答疑不需要沉重的多轮编排；多模块重构则必须有明确的子任务拆解与验证。AAA Agent 会根据任务特征在 `direct`（直接修改）、`guided`（分步引导）和 `orchestrated`（多子任务编排）三条路线上动态路由。
2. **异构模型的能力感知**：不同模型的代码理解与长上下文稳定性差异显著。AAA Agent 维护每个模型的实际表现样本，对能力相对受限的模型引入更多的步骤检查、故障恢复与显式验证；对强推理模型则放宽执行预算，提供原生的思考档位与完整的上下文操作空间。

### 核心能力

- **自适应任务路由**：按任务范围自动选择执行路线（`direct` / `guided` / `orchestrated`），支持显式参数覆盖。
- **模型感知执行策略**：依据所选模型能力自动调节推理深度（Reasoning Effort）、工具调用预算、重试上限与验证强度。
- **宿主级权限隔离**：自动识别只读查询任务并在运行时裁剪写入与 Shell 工具；在多 Agent 并行场景下，由主 Agent 统一管控写入，子 Agent 维持只读。
- **证据驱动的验收机制**：任务标记完成必须绑定宿主环境的实际测试或执行证据，拒绝仅凭模型自述即退出任务。
- **断点续跑与持久会话**：长任务具备原子 Checkpoint 保存能力，支持中断后恢复；Transcript 采用 append-only 存储并按模型上下文窗口动态维护工作集。
- **原生多 Provider 认证**：独立实现 OpenAI Codex、Kimi Code、GLM Coding Plan、Claude Code 等官方 OAuth 协议，本地 `0600` 权限安全存储，不依赖第三方跳转。

### 快速开始

#### 环境要求
* Bun `1.3.14+`
* 支持系统：macOS、Linux、Windows

#### 安装与启动

从源码启动：

```sh
git clone git@github.com:GuanZhengPM/AAA-Agent.git
cd AAA-Agent
bun install
bun run aaa
```

在具体项目目录中运行：

```sh
cd /path/to/your/project
bun /path/to/AAA-Agent/packages/aaa-app/src/cli.ts
```

全局链接命令：

```sh
cd /path/to/AAA-Agent/packages/aaa-agent
bun link
aaa --help
```

### 认证与模型管理

认证逻辑由 AAA Agent 独立实现，OAuth 均直接对接各厂商官方认证中心，凭据保存在本地 `~/.aaa-agent/credentials.json`。

| Provider | 登录方式 | 常用模型配置 |
| :--- | :--- | :--- |
| **ChatGPT / Codex** | 浏览器 OAuth | `openai-codex/gpt-5.6-sol` |
| **Kimi Code** | Device OAuth / Console API Key | `kimi-code/k3` |
| **GLM Coding Plan** | 浏览器 OAuth / 独立 Coding Plan Key | `z-ai-coding/glm-5.2` |
| **Claude Code** | Claude Pro/Max 浏览器 OAuth | `claude-code/claude-sonnet-5` |
| **其他模型** | 环境变量 / API Key（DeepSeek, OpenRouter, MiniMax 等） | 运行 `aaa models` 查看 |

常用命令：

```sh
# 登录指定 Provider
aaa auth login kimi-code
aaa auth login z-ai-coding
aaa auth login claude-code

# 设置 API Key（安全输入，不写入命令历史）
aaa auth set-key deepseek

# 查看凭据状态
aaa auth status

# 查看可用模型及观测样本数
aaa models

# 切换当前模型
aaa use openai-codex/gpt-5.6-sol
```

### 常用运行模式

#### 1. 交互式终端

```sh
aaa
```

#### 2. 非交互式单次任务

```sh
# 只读分析任务（自动移除写入与危险命令工具）
aaa run --read-only "梳理认证请求从 CLI 到 Provider 的完整调用链路"

# 针对复杂重构显式指定路线与验证强度
aaa run --lane guided --verification strict "修复 parser 的边界回退问题并补充测试"

# 指定子 Agent 模型进行模块并行检查
aaa run --subagent-model openai-codex/gpt-5.4-mini "并发排查三大核心模块的潜在异常"
```

#### 3. 任务路由预览

无需发起模型请求，预先查看任务推断的路线与权限级别：

```sh
aaa route "检查认证与存储实现，列出潜在风险点"
```

### 架构设计

项目采用 Bun Workspace 多包架构，零外部数据库依赖：

* `packages/aaa-core`：核心状态机、自适应路由算法、执行路线策略引擎；
* `packages/aaa-agent`：主 Agent 循环、权限控制器、工具集管理；
* `packages/aaa-auth`：各厂商原生 OAuth 实现与安全凭据仓；
* `packages/aaa-models`：模型能力档案库、动态上下文窗口管理与退避调度；
* `packages/aaa-app`：终端 CLI 交互入口与 TUI 渲染。

---

<a id="english"></a>

## English

### Overview

AAA Agent (`aaa`) is a terminal-based coding assistant built with Bun and TypeScript. It is designed to tackle two key engineering challenges:

1. **Dynamic Task Routing**: Trivial edits and exploratory questions require minimal control overhead, while multi-file refactoring requires structured task decomposition. AAA Agent dynamically routes tasks across `direct`, `guided`, and `orchestrated` lanes.
2. **Model-Aware Adaptation**: Coding capabilities and context reliability vary significantly across models. AAA Agent maintains empirical performance profiles, applying tighter verification, step-by-step guidance, and retries for constrained models, while providing full context budgets and native reasoning efforts for frontier models.

### Key Capabilities

- **Adaptive Task Routing**: Automatically selects the execution lane (`direct`, `guided`, or `orchestrated`) based on task scope, with explicit CLI overrides.
- **Model-Aware Execution Policy**: Dynamically adjusts reasoning effort, tool call budgets, retry thresholds, and verification policies based on empirical model capability profiles.
- **Host-Level Permission Isolation**: Automatically identifies read-only queries and strips write/shell tools at runtime; enforces write-isolation where the primary agent controls modifications while subagents remain read-only.
- **Evidence-Bound Verification**: Requires execution output from actual tests or host commands before marking tasks complete, eliminating false-positive self-reports.
- **Checkpoints & Resumable Sessions**: Atomic checkpointing for interrupted tasks; append-only transcript logging with active context window compaction.
- **Native Multi-Provider Auth**: Built-in OAuth for OpenAI Codex, Kimi Code, GLM Coding Plan, and Claude Code, storing credentials locally under secure `0600` permissions.

### Quick Start

#### Requirements
* Bun `1.3.14+`
* Supported OS: macOS, Linux, Windows

#### Setup

Run from repository source:

```sh
git clone git@github.com:GuanZhengPM/AAA-Agent.git
cd AAA-Agent
bun install
bun run aaa
```

Run inside a specific target project:

```sh
cd /path/to/your/project
bun /path/to/AAA-Agent/packages/aaa-app/src/cli.ts
```

Link globally:

```sh
cd /path/to/AAA-Agent/packages/aaa-agent
bun link
aaa --help
```

### Authentication & Model Management

Authentication is implemented natively within AAA Agent. OAuth flows directly connect to official provider endpoints with local callbacks, saving credentials to `~/.aaa-agent/credentials.json`.

| Provider | Login Method | Example Models |
| :--- | :--- | :--- |
| **ChatGPT / Codex** | Browser OAuth | `openai-codex/gpt-5.6-sol` |
| **Kimi Code** | Device OAuth / Console API Key | `kimi-code/k3` |
| **GLM Coding Plan** | Browser OAuth / Dedicated Coding Key | `z-ai-coding/glm-5.2` |
| **Claude Code** | Claude Pro/Max Browser OAuth | `claude-code/claude-sonnet-5` |
| **Other Providers** | Environment Variables / API Key (DeepSeek, OpenRouter, etc.) | Run `aaa models` |

Common commands:

```sh
# Login to a specific provider
aaa auth login kimi-code
aaa auth login z-ai-coding
aaa auth login claude-code

# Securely set API key without shell history leaks
aaa auth set-key deepseek

# Check credential status
aaa auth status

# View registered models and empirical observation sample counts
aaa models

# Switch active model
aaa use openai-codex/gpt-5.6-sol
```

### Common Execution Modes

#### 1. Interactive Session

```sh
aaa
```

#### 2. Non-Interactive Single Tasks

```sh
# Read-only exploration (write & dangerous shell tools are stripped)
aaa run --read-only "Analyze authentication flow from CLI to provider"

# Explicit lane and strict verification for complex refactors
aaa run --lane guided --verification strict "Fix parser edge cases and add regression tests"

# Parallel subagent inspection with designated lightweight model
aaa run --subagent-model openai-codex/gpt-5.4-mini "Audit three core modules concurrently"
```

#### 3. Route Inspection

Inspect task classification, execution lane, and permission scope without dispatching model requests:

```sh
aaa route "Review authentication and storage implementations for security risks"
```

### Architecture

AAA Agent is organized as a multi-package Bun workspace with zero external database dependencies:

* `packages/aaa-core`: Core state machine, adaptive routing algorithm, and policy engine.
* `packages/aaa-agent`: Main agent loop, permission manager, and tool registry.
* `packages/aaa-auth`: Native OAuth implementations and secure credential store.
* `packages/aaa-models`: Model capability profiles, dynamic context window compaction, and backoff dispatchers.
* `packages/aaa-app`: CLI entry points and terminal TUI rendering.

### License

[MIT](LICENSE)
