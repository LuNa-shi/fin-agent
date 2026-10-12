# 贡献与代码规范

本文件定义合入规则。仓库操作、端口、provider-backed test policy 和数据安全边界以 [AGENTS.md](AGENTS.md) 为准；产品入口和当前 composition 见 [README.md](README.md)。

## 环境

- Node.js `>=22.19.0`。
- Backend 使用 ESM、Express 和 `node --test`；frontend 使用 React 18 与 Vite。
- `@earendil-works/pi-ai` 和 `@earendil-works/pi-agent-core` 精确固定为 `0.80.6`。
- 新生产依赖需要说明必要性、替代方案和版本锁定方式。

## 开发与合入检查

开发时先运行覆盖改动面的 focused checks。合入前运行唯一完整 clean-install gate：

```bash
node scripts/clean-install-gate.mjs
```

该入口按 repository script 定义执行 backend `npm ci`、tests、Agent asset Golden、零 warning lint、deterministic demo smoke，以及 frontend `npm ci`、tests 和 production build。CI 和 pre-push hook 只应委托给该入口，避免维护第二套合入标准。

Provider-backed validation 必须遵守 [AGENTS.md 的 live policy](AGENTS.md#provider-backed-test-policy)。普通测试和 CI 保持 non-live；模型推理使用显式 manual/live opt-in。`/models` discovery 和不执行推理的 health check 不属于 live model test。

合入前还要：

```bash
git diff --check
git status --short
```

检查 diff 中没有密钥、runtime 数据、build output、手改 generated projection 或无关用户文件。报告实际运行的检查，也要明确没有运行的检查。

## Expert Prompt 与 Tool policy baseline

Checked-in Agent System Prompt 和 ordered Tool Use policy 是投资专家 baseline。Coding agent 只有在任务确实需要或用户明确表达变更意图时才修改它们。任何相关改动都运行：

```bash
cd backend
node scripts/generateAgentAssetGolden.mjs --check
```

若 Golden 意外变化，停止并确认意图。不要用 `--write` 掩盖漂移。

产品中的 `AgentRuntimeService` overlays 和 runtime Skills 是独立、data-backed 的运行时能力。它们可以替换 runtime System Prompt、追加 Skill instructions，并且只能缩小 checked-in tool allow-list。它们按源码形成 effective Agent config，但不会改写 checked-in baseline，也不构成随手修改 baseline 的授权。

## 架构纪律

- Agent definitions 放在 `backend/src/agents/definitions/`，由 `backend/src/agents/registry.js` 显式注册。
- 工具只在 `backend/src/tools/toolCatalog.js` 注册。Agent tool authority 来自 effective definition 的 tool policy；未知 Agent fail closed。
- Workflow 和 direct command 通过 `AgentExecutionRuntime` 执行 Agent。不要在 handler 中重拼 System Prompt、工具白名单或第二套 provider/backend loop。
- Canonical Run Analysis 拥有八个 Workflow nodes。产品启动、状态、恢复和排队通过 `RunAnalysisService`，Project creation 不绕过该边界触发分析。
- Report producer 和 backfill 通过 `ReportAdmissionService`。ReportVersion 与 private Overview 必须遵守 admission marker 的原子可见性。
- Public ReportVersion 的 Worldview processing status 只投影 `Pending` / `Processed`；batch 与 ingestion 保留各自状态。Public API 不暴露 Overview、filesystem path、credential 或 raw provider payload。
- Canonical Worldview 与 Claim Library 是语义独立的 authority，只通过同一 run/publication audit 关联。Core Worldview 输出有序 Claim actions；逐项 invalid actions 独立拒绝。`/api/claims*` 保持只读。
- Human Review 源码目前未由 server composition 激活。不要新增 API/UI 假装它是 active flow，也不要删除兼容存储和历史数据，除非任务明确要求。
- Legacy Daily Worldview、旧 report-generation façade、第二 Agent backend 和 Self-evolving feedback paths 已删除。不要把它们恢复为临时兼容方案。
- 不新增静默硬截断。需要裁剪 context 时使裁剪可观察，并优先用索引和 workspace tools 按需读取。
- 金额、概率、report publication 和关键结构化输出继续经过 schema 或 deterministic checks。解析失败返回真实错误，不伪造占位结果。

精确 Workflow、contract consumer 和 artifact authority 以 [`documents/generated/`](documents/generated/) 的 source-derived projection 为准。架构变化应更新源码生成器或 source-owned documentation，再运行对应 `--check`；不要手改 generated files。

## 代码与测试

- 遵循 `.editorconfig`：2 spaces、LF、UTF-8、文件末尾换行。
- 避免与任务无关的全量格式化。
- 文件和函数使用 camelCase；Agent id 使用 kebab-case。
- 注释记录代码无法表达的约束、风险和决策。
- 新逻辑优先提取为可测试的纯函数。修复 bug 时先加入能复现问题的 test。
- Tests、smoke 和 local server 使用临时或 task-specific `FIN_DATA_DIR`，不得污染 `backend/data/`。
- 外部 HTTP 调用经过统一封装；execution scope 和 Project boundary 由 runtime 校验，不信任模型生成的占位 identity。

## 文档与 evidence

- `README.md` 说明产品和启动；`AGENTS.md` 说明 repository operation；本文件说明 contribution checks。
- `documents/` 保存 reviewed long-lived references；`documents/generated/` 保存 source-derived projections。
- `docs/` 保存 local draft、过程记录和历史 working notes。
- `artifacts/` 保存 machine-readable evaluation 与 reviewer-gate evidence。
- Historical archive 和 point-in-time evidence 保持不可变。新的结果写入新的 record，不回写旧记录来制造“最新状态”。

## 提交与安全

- 使用小步、可独立回滚的英文 conventional commit：`feat|fix|docs|chore|eval(scope): summary`。
- 结构变更按独立边界提交；不要把可单独回滚的改动 squash 成一个大提交。
- `.env`、`backend/data/`、`node_modules/`、`frontend/dist/`、`.DS_Store` 和本地过程状态不得入库。
- 发现 tracked credential 或用户 runtime data 时按 P0 处理：停止，保留证据，清理泄漏，且不要把真实值复制到日志、fixture 或文档。
