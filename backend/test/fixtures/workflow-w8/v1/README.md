# Workflow W8 deterministic fixture

`scenario.json` is the frozen, non-live input for the W8 deterministic
current-model acceptance runner. It preserves every field required by the M1
W3–W5 production-composition worker while using a distinct Idea run identity,
fixed `asOf`, and W8-only Project, analysis, review, crash, and legacy inputs.

The parent runner writes `w8.mutableInputs` verbatim to the isolated worker
control directory as `{ "positions": [...], "mandate": {...} }`. The M1 worker
reads that file only from the initial `getPortfolio()` and `getMandate()` input
capture calls. The runner may mutate or delete the file after snapshot `S1` is
captured; resume/replay must use the durable snapshot and must not read this
live source again.

The success case uses `Grid equipment backlog reacceleration`. The
review-required case uses `Power semiconductor inventory normalization`. The
legacy Idea intentionally has no Idea-run or input-snapshot fields so its
Project linkage must remain explicitly null rather than being reconstructed.

`w8.analysisFrozenData` is the complete provider-shaped research tuple used
for every allowed Run Analysis round. The worker supplies it through
`frozenDataByRound`, so deterministic Planner/Collector/Normalizer/Auditor and
the production Workflow still run while all external acquisition paths remain
unreachable. Each current-model Project also owns a fixed analysis-run suffix;
the Project id plus that suffix produce the same R1 identity on clean reruns.

All model-facing behavior is supplied by deterministic injected backends.
External network/provider access is denied. The fixture and runner prove
deterministic structural behavior only; they do not evaluate live investment
quality or release-quality certification.
