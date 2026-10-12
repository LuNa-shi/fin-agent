# Daily Worldview Synthesis v1 实现设计

> Issue #15 · Phase 1
> 状态：实现中

## 1. 范围

本阶段不是跨日期 Bootstrap，也不是长期 Worldview current authority。输入限定为 Issue #14 已 admitted 的 `origin=internal` ReportVersion，按指定 UTC 日期冻结一批报告，产出一个或多个 Daily Worldview Synthesis package。

本期暂不实现 `Opportunity`、Investment Claim、Recommendation Claim、Claim Observation、Reflection、scheduler、BasicCompanySnapshot、StockFit、Deal Ladder 和前端页面。后续 Bootstrap 单独消费多个 Daily package。

## 2. 一对一与多对一边界

```text
one ReportVersion -> one Contribution Agent call -> one immutable Contribution
N Contributions (N <= 100) -> one Synthesis Agent call -> one batch synthesis package
```

`N` 是每次 synthesis 的硬上限，不是建议值。指定日期超过 100 份报告时，按冻结 manifest 的稳定序号分成多个 batch；不会把 1000 份报告放入一个 context。

## 3. Durable workflow

```text
capture-batch-inputs
  -> freeze-report-manifest
  -> partition-report-batches
  -> process-contributions
  -> assemble-batch-context
  -> synthesize-batch
  -> validate-daily-synthesis
  -> review-daily-synthesis
  -> publish-daily-synthesis
```

Workflow 通过 Core `WorkflowExecutor`、`FileRunStore`、`FileArtifactStore` 和 `FileEventBus` 执行。Scope 为：

```json
{
  "kind": "worldview-universe",
  "id": "worldview-universe:report-library"
}
```

运行上下文使用 `workspaceMode=none`，物理 run 根位于 `FIN_DATA_DIR/worldview/runs/<runId>/`；不会伪造 Project、Idea run 或写 `global/index.json`。

## 4. 输入身份与冻结

manifest item 至少保存：

- `reportVersionId`；
- `contentDigest`；
- `reportVersionFingerprint`（对于旧 projection 缺失时仅允许等同 contentDigest 的兼容值）；
- `asOf`、title、tickers、ordinal、batch membership。

每次 Contribution 前重新通过 ReportLibrary authority 读取 anchor/content，并对 exact Markdown bytes 计算 digest。digest、origin 或 fingerprint 冲突 fail closed。

## 5. Agent 资产

新增三个独立 definition，并全部通过 `AgentExecutionRuntime`：

- `worldview-contribution-analyst`：单报告 Contribution；无工具、无写权限、无外部 retrieval；
- `worldview-synthesizer`：单 batch synthesis；输入 Contribution 集合，最多 100；
- `worldview-quality-reviewer`：单 batch 只读质量审查；无发布权。

Deterministic test 用 Scripted Backend 替换 Agent backend seam，不调用 provider/network/live model。Prompt/Tool Use 与 schema 均有独立定义和 Golden/contract projection 责任。

## 6. Package 与存储

Worldview domain 独占 `FIN_DATA_DIR/worldview/`：

```text
worldview/
  runs/<runId>/
    manifest.json
    contributions/<contributionId>.json
    .runs/
    .artifacts/
    .events/
  packages/<packageId>/
    package.json
    worldview.md
  current.json
```

Contribution 与 package 不写入 Project、Idea 或 GlobalContentIndex。Contribution/package 写入采用 immutable/idempotent identity；Markdown 以 exact UTF-8 bytes 保存并验证 digest。`current.json` 只是可重建的只读投影，不是跨日 Bootstrap authority。

## 7. Acceptance

Deterministic acceptance 必须证明：

- 100 上限和 >100 多 batch；
- Contribution 一份报告一次调用；Synthesis 一 batch 一次调用；
- frozen manifest、digest/fingerprint lineage；
- durable run/node/artifact/event；
- replay/idempotency；
- package 原子可读与 current projection；
- malformed output、tampered report、review failure fail closed；
- provider/network/live attempts 为 0。

Live light test 是独立质量证据，待用户指定日期/样本与运行边界后执行；quota 不硬编码到本 Issue，也不能用 deterministic pass 代替 live quality pass。
