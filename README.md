# Fin agent · 金融分析智能体

Fin agent 是一个本地全栈投资研究系统。产品主链为：

```text
Idea Generation
  -> IdeaArtifact / ProjectSeed
  -> Project Space
  -> explicit analyze trigger
  -> Run Analysis
  -> Report / Conclusion
  -> Decision / Portfolio
```

开发或操作仓库前先读 [AGENTS.md](AGENTS.md)。贡献与验证规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。本开源版本不包含原私有仓库的会议纪要、内部参考资料、历史档案及运行评测数据。

## 当前产品

### Idea、Project 与研究报告

- Idea Generation 使用 durable 六节点 Workflow。每次运行冻结输入，确定性采集来源，由 Agent 生成和评分，并持久化所有通过结构校验、ticker 规范化和去重的 Idea。
- Idea→Project 是确定性命令。创建 Project 不会自动调用模型或启动分析。
- `POST /api/projects/:id/analyze` 通过 `RunAnalysisService` 启动分析。Service 负责 durable run id、队列、同 Project 去重、暂停、状态和重启恢复。
- Run Analysis 使用八节点 `run-analysis.v2` Workflow：初始化、规划、候选筛选、研究轮次、报告撰写、并行审核、结论和最终发布。
- Decision / Portfolio 只消费通过当前 run、ArtifactRef、lineage、对象 digest 和发布元数据校验的报告包。

### Report Library 与 Canonical Worldview

- Run Analysis 报告和受控 backfill 通过 `ReportAdmissionService` 进入共享 Report Library。
- Admission 先持久化候选，再生成私有、digest-bound Report Overview。ReportVersion 与 Overview 作为隐藏 pair 准备，并由最后写入的 admission marker 原子公开。
- 公开 ReportVersion 的 Worldview processing status 只有 `Pending` 和 `Processed`；batch 与 ingestion 使用各自的生命周期状态。Overview 不是公共产品面，只能由冻结的 Canonical Worldview capability 读取。
- Scheduled daily producer 以最多 100 个预注册 item 形成 durable Daily Report Batch。显式关闭 batch 后发布一次 Canonical Worldview processing trigger。
- 每个 Canonical Worldview trigger 只选择 admission order 中最老的一个 bounded `Pending` group；Report 数硬上限是 100，配置不能提高。之后到达或超出本组预算的 Reports 保持 Pending。
- Run workspace 在首次模型调用前持久化并做 digest 校验。它冻结 ordered Reports/Overviews、完整 current Worldview、完整 current Claims 与 compact Claim table、route/Prompt/retry policies、bounds、capabilities 和 manifest。
- 一个 run 最多 3 个 fresh complete Agent attempts；每个 attempt 最多 5 个 model API attempts。耗尽后记录 `FAILED_EXHAUSTED`，后续 Pending work 不得越过该 frozen workspace。
- Core Agent 先决定 Worldview `KEEP`/`UPDATE`，再输出零个或多个独立 Claim `ADD`/`UPDATE`/`NOOP` actions。Claim Library v1 保存 falsifiable Claims、immutable versions、actions、rejections、exact evidence 和 run/publication lineage；同 target conflict 采用 first-valid-wins。
- 一次成功 run 先 stage Worldview outcome、Claim records、attempt audit 与 exact Processed receipts，最后只提交一个 authoritative `worldview-run-publication-marker.v1`。marker 前 staged objects 不可见，marker 后 recovery 不再调用 Agent。Report processing status 只由 exact committed receipt 决定。
- `/api/worldview*` 与 `/api/claims*` 只读。前端把 Worldview Processing Log、Worldview Versions 与 Claim Library 保持为独立产品面。

Legacy Daily Worldview 的 Agent、Workflow、Store、Schema、composition、API 和 UI 已从 active runtime 删除。历史磁盘文件原地保留，但不再定义产品语义。Self-evolving belief、scheduler、adaptor memory、verifier 和 learning UI 也已删除。

### Agent catalog 与 runtime overlays

- [`backend/src/agents/registry.js`](backend/src/agents/registry.js) 是 active Agent definitions 的显式注册来源。
- [`backend/src/tools/toolCatalog.js`](backend/src/tools/toolCatalog.js) 是工具注册的唯一来源。
- `AgentExecutionRuntime` 为 Workflow 和 direct command 构造统一请求；默认 backend 为 `IdempotentAgentBackend -> ConcurrentAgentBackend -> PiAgentBackend`。
- checked-in System Prompt 和 ordered Tool Use 是专家 baseline。产品可通过 `AgentRuntimeService`、`/api/agents*` 和 `/api/skills*` 保存 runtime overlays 与 Skills，并在执行时解析 effective definition。

Human Review 的 contracts、store、controller 和 resume 实现仍保留在源码中，但当前 server composition 没有注入 controller，也没有公开 Human Review API。默认 composition 遇到 Human Review route 时记录 bypass 并继续，而不是打开交互任务；前端把 `review-required` 当作退役的历史状态。

## 主要 API

当前 Express composition 提供以下 route families：

- 系统与配置：`/api/status`、`/api/settings`、`/api/providers/openai-compatible/models`、`/api/keys`、`/api/llm/usage`
- Agent、Skill 与工具：`/api/agents*`、`/api/skills*`、`/api/tools*`
- Workflow projection：`/api/workflows/run-analysis`、`/api/workflows/idea-generation`
- Daily evidence 与 Report Library：`/api/daily-reports*`、`/api/report-library*`
- Canonical Worldview 与 Claims：`/api/worldview*`、只读 `/api/claims*`
- Idea 与 Project：`/api/ideas*`、`/api/classify`、`/api/projects*`
- Research 与 template：`/api/research/sources*`、`/api/templates*`
- Decision 与 Portfolio：`/api/portfolio*`、ranking、ledger、contract、mandate 和 calibration routes

Project create/quick 不启动分析。Analyze 公开输入只接受 `intensity`、`industryTemplate`、`companyTemplate` 和 `resume`；run identity、backend、demo/live 和内部 execution scope 不能由 HTTP 覆盖。

## 架构入口

```text
backend/src/
  agents/          definitions、registry、runtime overlays、execution request boundary
  core/            Pi backend、models、contracts、workflow kernel、context、tools、validation
  domains/         ideas、reports、worldview、claims、research、decision
  project-space/   Project files、RunStore、ArtifactStore、EventBus、Workspace
  tools/           tool catalog 与 executor composition
  workflows/       idea-generation、run-analysis、Canonical Worldview processing
  lib/             无领域归属的纯函数和基础设施 helper
  config.js        runtime configuration composition root
  server.js        Express/API composition root
frontend/          React + Vite product UI
documents/         reviewed references and generated source projections
artifacts/         evaluation and reviewer-gate evidence
```

精确 Workflow node、Agent contract consumer 和 artifact authority 请直接读取 [`documents/generated/`](documents/generated/) 中的 source-derived projections。当前手写边界说明见 [`documents/current-agent-io.md`](documents/current-agent-io.md)。

## 环境与启动

要求 Node.js `>=22.19.0`。正式 provider id 只有 `openai-compatible` 和 `deepseek`。Pi 依赖固定为：

- `@earendil-works/pi-ai@0.80.6`
- `@earendil-works/pi-agent-core@0.80.6`

安装并运行：

```bash
cd backend && npm install
cd ../frontend && npm install && npm run build
cd ../backend && npm start
```

默认服务地址为 `http://localhost:8787`，backend 直接托管 `frontend/dist`。前端改动后重新 build，backend 改动后重启进程。

前端 UI-only 开发：

```bash
cd frontend && npm run dev
```

Vite 固定使用 `8878`，且不代理到部署服务。需要完整 API 的前端验证时，先 build frontend，再由使用隔离 `FIN_DATA_DIR` 的测试 backend 在 `8878` 托管 `frontend/dist`。

正式 provider id 只有 `openai-compatible` 与 `deepseek`。仓库默认路由为 `openai-compatible/gpt-5.6-sol/high`，未显式覆盖的 small/main/reflection tier 跟随该路由。OpenAI-compatible model id 从服务端 `/models` 原样使用。选中的 provider/model 不可用时 fail closed，不做跨 provider replay或自动 demo fallback。真实模型测试必须显式 opt in。

Agent 操作部署与测试服务时必须遵守 [端口规则](AGENTS.md#ports)和 [provider-backed test policy](AGENTS.md#provider-backed-test-policy)。测试 backend 通常设置 `AUTO_RESUME=false`。确定性 demo 只有显式 `DEMO_MODE` 或明确 runtime demo route 才启用；provider/model 不可用时不会自动回退到 demo 或其他 provider。

## 验证

唯一完整 clean-install 合入门禁：

```bash
node scripts/clean-install-gate.mjs
```

该入口执行 backend clean install、tests、Agent asset Golden、零 warning lint、deterministic demo smoke，以及 frontend clean install、tests 和 production build。开发时可先运行 focused checks。详细规则和 Prompt/Tool policy 变更流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 运行数据

运行数据位于 ignored `backend/data/`。测试不得写入该目录。需要重置真实运行数据时，先获得用户授权并优先归档：

```bash
cd backend && npm run archive:runtime
```

Owner-authorized 旧 authority cutover 使用独立 guarded 命令。必须先 dry-run，并提供 exact `.../claims`、exact `.../canonical-worldview` roots 和 acknowledgement `RESET_LEGACY_CLAIM_AND_CANONICAL_WORLDVIEW_AUTHORITIES`：

```bash
npm run reset:worldview-claim-authorities -- --dry-run \
  --claims-root /absolute/path/to/claims \
  --canonical-worldview-root /absolute/path/to/canonical-worldview \
  --acknowledge-owner-authorized-reset RESET_LEGACY_CLAIM_AND_CANONICAL_WORLDVIEW_AUTHORITIES
```

Active Claim Library 默认位于 `FIN_DATA_DIR/claim-library/`。该命令不接入 server startup，并拒绝 repository、filesystem、`FIN_DATA_DIR`、protected sibling、overlap 与 symlink roots。

真实密钥只放在 ignored `backend/.env`。不要把 endpoint、key、用户数据、原始 provider payload 或私有 Report Overview 写入日志、fixture 或文档。

## 许可证与来源

本项目采用 [MIT License](LICENSE)，由 LuNa-shi 维护。经授权基于 Kenzeq/Adaptors 的代码快照独立发布；保留源码中已有的版权和第三方许可声明。
