# Fin agent 金融分析智能体 · AGENTS 指南

本文件只保存仓库操作规则。产品行为与启动入口见 [`README.md`](README.md)，合入检查见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。[`documents/generated/`](documents/generated/) 是源码生成的架构投影，不得手工修改。

## 每项任务开始前

1. 阅读 governing issue 和用户最新 comments。
2. 写入前运行 `git status --short`、`git log -1 --oneline` 和 `git worktree list`。
3. 确认任务 worktree、分支、允许修改的文件和验证范围。
4. 保留所有既有 tracked、untracked、ignored 用户数据。

## Worktree 与 Git 安全

- 稳定目录 `<repository>` 始终检出 `main`。
- 分支任务在 `<repository>/.worktrees/<task>/` 中执行，并从明确基线创建 worktree。
- 并发 Agent 必须收到 worktree 绝对路径和 `PLAN_ID`。
- 未经用户明确授权，不得切换稳定目录分支、删除 worktree 或分支、merge、push 或改写历史。
- 需要提交时使用小步英文 conventional commits：`feat|fix|docs|chore|eval(scope): summary`。

## 目录职责

| 路径 | 职责 |
|---|---|
| `backend/`、`frontend/` | 产品 runtime、测试、依赖和构建 |
| `backend/src/agents/definitions/` | checked-in Agent definitions 与专家 Prompt/Tool baseline |
| `backend/src/tools/toolCatalog.js` | 工具注册权威 |
| `backend/src/workflows/` | canonical Idea Generation、Run Analysis 与 Canonical Worldview workflows |
| `backend/src/project-space/` | Project 文件、runs、artifacts、events、workspace 与 dormant Human Review storage |
| `backend/src/domains/` | Idea、Report、Worldview、Claim、Research 与 Decision authorities |
| `scripts/` | 仓库自动化 |
| `documents/` | 经 review 的长期文档和源码生成投影 |
| `docs/` | 本地草稿、过程记录和历史工作资料 |
| `artifacts/` | 机器可读 evaluation 与 reviewer-gate evidence |
| `backend/data/` | 本地 runtime 数据；不得存测试 fixture 或 tracked 内容 |

仓库根目录只保留稳定入口和基础设施。每条规则或设计事实只保留一个权威版本。

## 当前源码边界

- 显式 Agent Registry 是 active definitions 的权威来源。生产 Agent 调用通过 `AgentExecutionRuntime` 解析 effective definition，并使用幂等、并发受控的 Pi backend composition。
- `toolCatalog.js` 是工具注册权威。每个 effective Agent definition 提供允许使用的工具；未知 Agent fail closed。
- Idea Generation 是 durable 六节点 Workflow。Run Analysis 是 canonical 八节点 `run-analysis.v2` Workflow，并统一由 `RunAnalysisService` 启动。
- Project 创建是确定性命令，不会启动分析。`POST /api/projects/:id/analyze` 是显式分析入口。
- Report admission 原子发布 immutable ReportVersion 和 private Report Overview。公开 ReportVersion 的 Worldview processing status 只有 `Pending` 与 `Processed`；batch 和 ingestion 使用各自的生命周期状态。
- Canonical Worldview 与 Claim Library 是 active、语义独立的产品 authority，只通过同一 `runId` / `publicationId` 审计关联。每个 trigger 只处理一个最老 bounded Pending group，Report 数硬上限 100。
- Core Worldview 返回 `KEEP`/`UPDATE` 与有序 `ADD`/`UPDATE`/`NOOP` Claim actions。逐项 Claim 错误独立拒绝；Worldview、storage、integrity、locking 或 publication 错误使整个 run fail closed。
- 一个 completed `worldview-run-publication-marker.v1` 同时公开 Worldview outcome、Claim publication、attempt audit 与 exact Processed receipts。Claim Library 和 Worldview API/UI 均只读。
- Legacy Daily Worldview runtime 和旧 display-only report workflow 已删除。保留的历史磁盘文件没有 active runtime 语义。
- Human Review contracts、store、controller 和 resume 源码仍保留，但 server 没有组合 controller，也没有暴露 Human Review API。默认 composition 记录 bypass，frontend 将 `review-required` 视为退役历史状态。不得把 Human Review 描述成 active 产品流程。
- Self-evolving belief、scheduler、adaptor-memory、verifier 与 learning paths 保持删除状态。

精确 Workflow nodes、contract consumers 和 artifact permissions 以对应 generated projection 为准，不要在手写文档重复完整清单。

## Prompt 与 runtime 配置

Checked-in System Prompt 和 ordered Tool Use 是专家 baseline。只有任务确实需要或用户明确表达变更意图时才修改。相关改动必须执行 [`CONTRIBUTING.md`](CONTRIBUTING.md) 中的 Golden 检查。

产品同时通过 `AgentRuntimeService`、`/api/agents*` 与 `/api/skills*` 支持 data-backed Agent overlays 和 runtime Skills。这些 runtime 能力不构成随手修改 checked-in baseline 的授权。

## Provider-backed test policy

开始 provider-backed 测试前先确定实际 Project 范围。

- 一个 Project 或更小的范围可以直接测试，无需询问。重复测试同一个 Project 仍属于单 Project 范围。
- 一项任务覆盖两个或更多不同 Projects 时属于 batch，即使逐个顺序执行也是 batch。开始前先检查 governing issue 和用户最新 comments：其中已要求该 batch 时可以执行；没有要求但 Agent 认为有必要时，必须暂停并询问用户。
- 使用命令的 `--live` 或其他已记录开关显式进入真实模型模式。CI、普通测试、deploy 和普通 startup 不得创建新的 provider-backed 测试任务。
- 产品重启可以恢复此前已授权的 durable Idea 或 Run Analysis 工作。测试 server 默认设置 `AUTO_RESUME=false`，除非正在验证 recovery。
- 不执行推理的 `/models` discovery 和 health check 属于配置检查，不是 live model test。
- 已选择的 provider/model 不可用时 fail closed，不得跨 provider replay 或静默进入 demo。
- 正式 provider id 只有 `openai-compatible` 与 `deepseek`。仓库默认路由为 `openai-compatible/gpt-5.6-sol/high`；未显式覆盖的 small/main/reflection tier 跟随默认路由。
- Deterministic demo 只通过显式 `DEMO_MODE` 或明确 runtime demo route 启用。

Provider-backed 验证使用隔离的 data/evidence roots。凭据只放在 ignored `backend/.env`；不得打印 endpoint、key 或敏感 provider payload。

## Ports

| 端口 | 用途 |
|---:|---|
| `8787` | 部署/公网服务；只有用户要求部署或检查时才操作 |
| `8878` | Agent 操作的本地 server、frontend dev/preview、smoke 与浏览器验证；必须使用隔离 `FIN_DATA_DIR` |

不得选择第三个人工服务端口。`8878` 被占用时先识别、复用或停止现有测试进程。Vite 与测试 backend 不能同时占用 `8878`。自动测试内部由 OS 分配的瞬时端口不受此限制。

## 数据与兼容安全

- Test、smoke 和本地验证使用临时或任务专属 `FIN_DATA_DIR`、Report Library 与 Worldview roots。
- Idea/Project folders 是内容权威；global index 只是可重建 projection。
- 保留 immutable artifacts、event evidence 和历史 runtime 文件。任何获批 reset 前先使用文档化命令归档数据。
- 旧 resident `claims` 与 `canonical-worldview` authority 只能通过独立 `npm run reset:worldview-claim-authorities -- ...` 命令清理；先 dry-run，必须提供 exact roots 与 exact owner acknowledgement。该命令不得接入 server startup。
- 不得以兼容为由恢复已删除的 execution backend、自动 provider fallback、Legacy Daily Worldview 或 Self-evolving feedback。
- Public API 不得暴露本地路径、凭据、raw provider payload、private Report Overview 或 Human Review runtime 文件。

## 验证与完成

开发中运行 focused checks，合入前执行 [`CONTRIBUTING.md`](CONTRIBUTING.md) 规定的完整门禁。报告完成前：

1. 运行适用的 generated-document 和 Agent Golden checks。
2. 运行覆盖改动行为的 focused tests。
3. 运行 `git diff --check`，检查 `git diff --stat` 和 `git status --short`。
4. 确认 diff 没有 runtime data、凭据、build output 或无关用户文件。
5. 明确报告已运行、未运行的验证及剩余风险。测试通过不代表真实投资报告质量通过。

历史阶段记录和 point-in-time evaluation evidence 位于 [`documents/archive/`](documents/archive/) 与 [`artifacts/`](artifacts/)。它们只用于追溯，不是当前操作指令。
