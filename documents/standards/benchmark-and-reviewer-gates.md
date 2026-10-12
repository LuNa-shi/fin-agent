# Benchmark and Reviewer Gate standard

## Purpose

Keep one reproducible benchmark baseline for each currently approved scenario. Keep routine reviewer-gate output local and disposable. Retired scenario inputs remain recoverable from their exact historical commit and evidence; they do not stay in the active test tree solely for archival purposes.

## Retention model

1. **Canonical Benchmark** — versioned inputs, expected structural invariants, and a manifest under `backend/test/fixtures/`. The manifest identifies the case, fixture version, allowed nondeterminism, and assertions.
2. **Reviewed Gate record** — one reviewed, machine-readable result under `artifacts/gates/` when a benchmark result is approved for long-term retention. It records the commit, benchmark manifest hash, commands, summary metrics, and caveats.
3. **Routine Reviewer Gate output** — local-only material under `artifacts/local/reviewer-gates/<run-id>/`, including `summary.json`, `report.md`, logs, and traces. Do not commit it.

## Required routine output

Every reviewer-gate run records:

- Git commit and benchmark manifest hash;
- command and execution time;
- deterministic/demo or provider-backed mode;
- test, Golden, lint, and build results that apply to the case;
- failed nodes and artifact references;
- reviewer decision and caveats.

## Safety and history

- Routine Reviewer Gate runs are non-live by default. Provider-backed mode needs an explicit manual live opt-in. CI and API startup do not create provider-backed test work.
- Provider-backed reviewer runs follow the scope and manual opt-in policy in [`AGENTS.md`](../../AGENTS.md#provider-backed-test-policy).
- `/models` discovery and health checks that perform no inference are configuration checks, not provider-backed model tests.
- Historical evidence is immutable. A later result may supersede a conclusion only through a new record; never rewrite the original evidence.
