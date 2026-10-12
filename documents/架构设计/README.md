# FinAgent architecture document index

> Last checked against source: 2026-09-04, commit `29074ec`.

This directory contains current references and point-in-time design records. A file is current architecture authority only when the table below says so.

## Current truth

| Entry | Authority |
|---|---|
| Root [`README.md`](../../README.md) | Current product surfaces, API families, composition, and startup |
| Root [`AGENTS.md`](../../AGENTS.md) | Repository operation, safety, and validation policy |
| [`../current-agent-io.md`](../current-agent-io.md) | Current handwritten Agent, Report admission, Worldview, and Claim runtime boundaries |
| [`../generated/`](../generated/) | Source-generated Workflow, contract-consumer, and artifact-authority projections; do not hand-edit |
| Backend and frontend source | Final authority when prose conflicts with code |

The three `investment-research-*-scorecard-en.md` files are reviewer reference copies. Runtime scorecard bytes and manifest live under `backend/src/workflows/run-analysis/reviewers/scorecards/`.

## Design and history snapshots

| Document | Status |
|---|---|
| [`report-worldview-claims-product-requirements.md`](report-worldview-claims-product-requirements.md) | 2026-08-09 product-design snapshot. Parts are implemented, parts remain unimplemented, and its current-state section is not runtime authority. |
| [`report-worldview-claims-product-requirements-v0.md`](report-worldview-claims-product-requirements-v0.md) | Superseded visual draft of the product-design snapshot. |
| [`worldview-daily-synthesis-v1-design.md`](worldview-daily-synthesis-v1-design.md) | Retired Legacy Daily Worldview design. The described active runtime was deleted; retained disk data is historical only. |
| [`report-quality-closure-contribution.md`](report-quality-closure-contribution.md) | Point-in-time branch contribution and validation report. Counts, branch state, and workflow descriptions are historical. |
| [`FinAgent_未完成任务清单与需求评估.md`](FinAgent_未完成任务清单与需求评估.md) | 2026-07-24 planning snapshot. It is not the current backlog or execution authorization. |

Meeting minutes, archived documents, and evaluation evidence preserve their original time context. Use them for history, not current implementation decisions.
