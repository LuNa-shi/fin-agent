# FinAgent 未完成任务清单与需求评估

> 最后核对：2026-07-24
> 文档性质：后续规划输入，不是 Goal、实施计划、执行授权或 Gate 通过证明。

## 1. 文档目的

本文把此前架构设计中提出、截至当前仍未完成的事项收敛到一处，并依据当前代码、保存的真实运行结果和最新产品判断，逐项评估是否仍有必要。

本文只整理已有提议，不提出新的产品方向。旧设计中的重复事项按同一任务族合并；已经完成的 W0–W8、统一 Pi runtime、canonical Workflow、Artifact/Run/Event 基础和 Human Review 底座不再重复列出。

判断分为四档：

| 判断 | 含义 |
|---|---|
| **需要执行** | 当前已有明确用户价值或真实产品缺口，建议进入近期规划 |
| **有条件执行** | 需求成立，但应由 CIO 实施、运行规模或部署形态等明确条件触发 |
| **暂缓观察** | 旧设计提出过，但当前证据不足以支持投入 |
| **不建议继续** | 当前产品目标下不再合理，保留任务和理由，但不建议排期 |

## 2. 当前事实与总体判断

### 2.1 自动报告已经生成，问题是没有交付给用户

当前 Run Analysis 顺序是：

```text
compose-report
  → review-report
  → synthesize-conclusion
  → finalize-project
```

也就是说，`compose-report` 成功后初稿已经存在；reviewer 和 publication gate 位于其后。当前 API 只有在 `reportReady=true` 时才返回报告，前端也只在该状态显示正文并开放反馈，因此一次进入 `review-required` 的运行会把已经生成的初稿一并隐藏。

相关实现：

- [`workflowSpec.js`](../../backend/src/workflows/run-analysis/workflowSpec.js)
- [`server.js`](../../backend/src/server.js)
- [`ProjectDetail.jsx`](../../frontend/src/views/ProjectDetail.jsx)
- [`reportEditing.js`](../../backend/src/workflows/run-analysis/reportEditing.js)

保存的 [`rerun9` 报告](../../artifacts/evals/qa-01-smoke-single-company-en-luna-medium-rerun9-20260716/report.md) 已经是一份完整、有实际阅读价值的初版投资报告。它没有满足严格 verified publication 标准，但“不适合自动进入投资决策”不等于“不适合交付用户阅读和修改”。

### 2.2 应把初稿交付和自动决策分开

后续产品边界应区分：

- `DRAFT_READY`：初稿可见，明确标记“未验证”，附带 reviewer findings，允许用户继续交互和生成新版本。
- `VERIFIED_FINAL`：只有通过严格校验的报告才能进入 Decision、Portfolio 或其他自动下游。

这不是取消质量控制，而是把质量控制放回正确的消费边界。当前 Decision/Portfolio 已只读取 verified report package，这条安全边界应保留。

### 2.3 QA-01 与 Gate E 不再是当前阶段的必要关闭条件

正式 QA-01 原本试图证明一份报告在 citation、traceability、估值、推荐和人工审阅上全部收敛；Gate E 又把该结果作为整体 release gate。它们适合“自动发布并进入投资决策”的严格认证，却不适合定义“自动 Workflow 是否已经完成初版报告”。

因此：

- 自动 Workflow 阶段应以“完成可读初稿并交付用户”为完成边界；
- reviewer 继续输出诊断和风险提示，但不应阻止初稿展示；
- 当前阶段不需要为了关闭而继续追求 QA-01 或 Gate E 通过；
- verified publication 继续保护自动 Decision/Portfolio，不因阶段关闭而放宽。

### 2.4 CIO Agent 是独立且真实的下一阶段需求

用户拿到初稿后的修改，可能只是改写，也可能需要重新查数据、补公司研究或补行业研究。当前 `report-editor` 只能在已有报告上编辑，不能主动发起新的 Data、Industry 或 Company 研究；但三类研究能力和 owner-routed remediation 已经存在，可以作为 CIO 的受控能力复用。

CIO 因此不应被塞回自动生成初稿的 Workflow，而应成为初稿之后的独立交互阶段：

```text
自动 Workflow 生成初稿
  → 用户阅读并提出问题
  → CIO 判断需要哪类研究
  → 调用 Data / Industry / Company / Report Revision
  → 生成带来源和版本的新报告
```

## 3. 近期真实需求

| ID | 此前提出但未完成的任务 | 当前判断 | 判断理由 | 建议边界 |
|---|---|---|---|---|
| N1 | 初版报告交付与阶段关闭语义 | **需要执行** | 当前 `compose-report` 已产出初稿，但 API/UI 把 `reportReady=false` 等同于“没有报告”，与用户希望“先拿报告再交互”的流程冲突 | 成功生成初稿后即可结束自动 Workflow 阶段；明确显示“草稿 / 未验证”，不能冒充正式结论 |
| N2 | reviewer findings 的用户可见摘要 | **需要执行** | `rerun9` 有 24 条 open issues，其中 1 条 critical、23 条 warning；这些是有价值的诊断，但不应作为隐藏整份初稿的统一开关 | 在草稿旁显示去重后的关键问题、严重度和建议动作；保留原始审计记录 |
| N3 | 草稿状态下的版本化交互修改 | **需要执行** | `ProjectSpace` 已有 draft/report version，`chatModify()` 也已有版本化编辑能力，但当前只接受 verified package，导致最需要修改时反而不能交互 | 允许对当前 run 的草稿进行受控 chat/edit；每次修改产生新版本，保留原稿、来源和修改记录 |
| N4 | CIO Agent 的最小交互研究循环 | **需要执行** | 单纯 report editor 无法判断何时应补数据、公司或行业研究；这正是用户交互后的真实需求 | CIO 负责选择和编排研究动作，不直接获得任意文件、工具或 Agent 权限 |
| N5 | CIO 对 Data / Industry / Company / Report Revision 的受控调用 | **需要执行** | `runDataRound()`、`runIndustryRound()`、`runCompanyRound()` 和 selective remediation 已存在，可复用而无需重建研究系统 | 由确定性 controller 校验 project、scope、预算、允许动作、artifact commit 和 report version；CIO 只做选择 |
| N6 | CIO 交互任务、运行与版本审计 | **需要执行** | 多轮用户问答若没有 task/run/version 身份，会失去可恢复性，也无法解释某一版报告用了哪些新增研究 | 只建立最小 `interaction run / research task / report version / artifact refs / stop reason`，不先实现完整 v0.3 Ledger 平台 |

## 4. 真实但应由条件触发的任务

| ID | 此前提出但未完成的任务 | 当前判断 | 触发条件与理由 | 当前建议 |
|---|---|---|---|---|
| C1 | CIO 的最小 Context read-set / manifest | **有条件执行** | CIO 开始跨多轮读取既有报告和新研究后，需要回答“看了什么、遗漏什么、基于哪个版本” | 与 N4–N6 同期只做最小 read-set、digest 和 token/budget 记录；不先建设完整 ContextAssembler 平台 |
| C2 | 完整 `ContextAssembler / ContextManifest` 与 WorkspaceSnapshot v2 | **有条件执行** | 长链、多 Agent、多来源重放出现实际 context 漂移后，完整组件才有明确收益 | 先观察 CIO 最小循环；只有最小 read-set 不足以保证重放时再扩展 |
| C3 | Artifact-first Project View 与 ProjectSpace 双权威收口 | **有条件执行** | 这是存在的技术债，但当前 verified package 已保护关键自动下游，不是下一阶段用户价值的前置条件 | 在 CIO 版本读写暴露实际 lineage/兼容读问题时推进，避免单独发起大规模存储重构 |
| C4 | input schema 与剩余 output schema enforcement | **有条件执行** | Contract coverage 确有缺口；新增 CIO command/task contract 时尤其需要 fail closed | 先补 CIO 新边界和受影响核心 contract，其他 schema 随触达模块逐步完成 |
| C5 | 统一 ToolExecution provenance | **有条件执行** | 旧设计希望 deterministic source 与 Agent tool 共用执行权威；当前尚无证据表明必须先做全局迁移 | CIO 若需要混合程序调用和 Agent 调用，再统一最小 execution record；不改变 Agent Tool Use |
| C6 | Artifact lineage/version/diff、Event/Usage、Workspace capability 前端 | **有条件执行** | CIO 多轮修改后，版本差异和新增证据会直接影响用户理解；其他平台视图暂非必要 | 优先做报告版本和新增研究来源；完整 Event/Usage/Workspace 控制面后置 |
| C7 | durable multi-resource queue、ResourceManager 和批量项目控制 | **有条件执行** | 当前进程内队列适合单用户本地运行；只有并行项目、重启队列顺序或 provider 配额成为问题时才需要升级 | 以实际并发量、queue loss/recovery 或资源争抢为触发证据 |
| C8 | 最小 auth、origin allowlist、操作身份、RBAC、retention/GC | **有条件执行** | 当前是单用户本地/内网产品；公网或多人协作前才是强制需求 | 部署边界变化时作为上线前置，不进入当前单用户下一阶段 |
| C9 | Shared KnowledgeStore / KnowledgeSnapshot | **暂缓观察** | CIO 可能带来跨项目复用需求，但目前没有反复采集、跨项目冲突或 point-in-time 查询的真实负担数据 | 等 CIO 运行暴露重复研究和共享知识需求后再决定，不先建新数据库 |
| C10 | Company/Industry Wiki、Timeline、Claims/outcome evaluator | **暂缓观察** | Evidence pipeline 已存在，但长期知识投影不是初稿交互或最小 CIO 的必要条件 | 只有稳定的跨期研究/回测使用场景成立后再规划 |
| C11 | 小批量 5-run 与 10×2 / 20-run 稳定性评测 | **暂缓观察** | 不再需要用它关闭当前阶段；live 成本高，且在 2026-07 当时的授权边界下延后 | 未来若由正常 Issue 纳入验收，先在该 Issue 声明样本、模型、资源与停止边界后执行 |
| C12 | 跨项目 review 队列、历史检索、完整 catalog 治理 | **暂缓观察** | 当前有单项目 Human Review 和只读运行投影，尚无多人 reviewer 或治理负担 | 出现多项目积压、配置发布或审计角色后再做 |

## 5. 不建议作为后续任务继续推进的旧项

| ID | 此前提出但未完成的任务 | 当前判断 | 理由 |
|---|---|---|---|
| X1 | 以正式 QA-01 通过作为当前阶段关闭条件 | **不建议继续** | 它把“初稿是否有用”与“能否自动进入投资决策”混成一个问题；真实报告证明初稿有用，而当前产品目标是先交付再交互 |
| X2 | 以 Gate E 作为 Framework 1.1 或当前报告阶段的全有或全无 release gate | **不建议继续** | Framework 1.1 已按产品范围 Close；继续维持该门只会重新绑定已分开的结构完成度与报告认证 |
| X3 | 把所有 reviewer issue 都作为报告不可见、不可编辑的硬阻断 | **不建议继续** | warning 和 critical 的消费风险不同；保留 findings 更重要，统一隐藏报告反而阻断用户纠偏 |
| X4 | 把 `ValuationBridge / RecommendationBridge` 作为阶段关闭前的独立必做工程 | **不建议继续** | 它们来自特定 QA 路径，对自动认证有价值，但不是交付初稿的前置条件；若 CIO 多次遇到不可复算估值或推荐过强，可在具体研究任务中重新评估 |
| X5 | 把完整 v0.3 `ResearchState/Ledger/Thesis Freeze/Restricted Writer` 一次性作为 CIO 前置 | **不建议继续** | 用户当前需要的是“根据问题主动调用研究能力并修改报告”；一次性实现全套平台会扩大范围，且尚无实证说明每个对象都必要 |
| X6 | 恢复 belief、experience、adaptor memory 或其他 self-evolving 主链 | **不建议继续** | 该能力已从当前产品删除，仍缺稳定 benchmark、污染控制和明确用户价值；与当前初稿交互/CIO 目标无关 |
| X7 | 为当前单用户阶段预先建设数据库、分布式 scheduler、Kafka/Kubernetes 或 150-Agent swarm | **不建议继续** | 当前没有相应部署和吞吐需求，投入会早于问题出现 |

## 6. 对下一阶段规划的建议顺序

这不是实施计划，只是依据任务依赖给出的规划顺序：

1. **先完成当前阶段的窄收口**：N1–N3。目标是让已有初稿可见、问题可见、修改可追踪；不再追求 QA-01 / Gate E 通过。
2. **再单独规划 CIO 最小阶段**：N4–N6，并只带入确实需要的 C1 和局部 C4。
3. **用 CIO 的实际运行决定平台扩展**：若出现 context 漂移、版本冲突、重复研究、并发或多人部署问题，再从 C2–C12 中选择对应任务。

不建议把 C 类平台项一次性合并成“大架构升级”。每项都应由明确的失败案例、规模数据或部署条件触发。

## 7. 新计划形成前需要确认的边界

后续制定下一阶段 Goal/Plan 时，只需确认：

1. N1–N3 是否作为当前阶段最后的产品收口。
2. CIO 最小阶段是否只包含 N4–N6，以及是否同期加入 C1 和局部 C4。
3. `DRAFT_READY` 报告允许哪些交互操作，哪些操作仍必须保持禁用。
4. CIO 单次交互的研究范围、预算和停止条件。

QA-01、Gate E、完整 v0.3、Workspace/Knowledge 平台、规模化队列和 live 稳定性运行不应被默认带入。

## 8. 来源与文档清理说明

本清单合并了以下已过时设计中的未完成事项；原文件在本清单完成后从当前树删除，历史内容仍可通过 Git 恢复：

- `FinAgent_Workflow专项重构设计_v0.1.md`
- `FinAgent_报告优化阶段实施方案与系统架构设计_v0.2.md`
- `FinAgent_报告优化阶段实施方案与系统架构设计_v0.3.md`
- `FinAgent_未来架构设计.md`
- `FinAgent_现有架构及问题.md`
- `FinAgent_知识资产与运行时边界专项设计_v0.1.md`

当前实现真相继续由根目录 [`README.md`](../../README.md)、[`AGENTS.md`](../../AGENTS.md)、源码、[`documents/generated/`](../generated/) 和正式 evidence 共同提供；本文只负责未完成任务及其需求判断。
