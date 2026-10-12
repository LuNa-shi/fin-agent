# Contributing to Fin Agent

Thank you for helping improve Fin Agent. The project is a local-first investment research system with durable workflows, evidence lineage, and provider-backed Agent execution. Contributions should preserve those boundaries while making the product easier to understand and operate.

## Before you start

- Read [`README.md`](README.md) for the product and startup model.
- Read [`AGENTS.md`](AGENTS.md) for repository operation, worktree, port, data, and provider-backed test rules.
- Check existing issues and pull requests before starting a larger change.
- Keep unrelated user files, ignored runtime data, and existing local work untouched.

For changes that affect product behavior, first describe the user-visible problem, the intended behavior, and the authority that owns the resulting data. For changes that affect prompts, tools, workflows, or publication, include the relevant contract and recovery implications.

## Development environment

- Node.js `>=22.19.0`
- Backend: ESM, Express, and Node's built-in test runner
- Frontend: React 18 and Vite
- Pi dependencies pinned to `0.80.6`

Install dependencies separately:

```bash
cd backend && npm ci
cd ../frontend && npm ci
```

Use a temporary or task-specific `FIN_DATA_DIR` for tests, smoke runs, and local server validation. Never use `backend/data/` for fixtures or test output.

## Architecture rules

- Active Agent definitions live in `backend/src/agents/definitions/` and are registered explicitly by `backend/src/agents/registry.js`.
- Tools are registered only in `backend/src/tools/toolCatalog.js`.
- Workflow and direct Agent calls go through `AgentExecutionRuntime`; do not create a second prompt, tool-policy, provider, or backend loop in a handler.
- Project creation and analysis are separate commands. Analysis starts through `RunAnalysisService`.
- Report producers and backfills enter the Report Library through `ReportAdmissionService`.
- ReportVersion and private Overview publication uses the admission marker boundary.
- Canonical Worldview and Claim Library are separate authorities connected by run/publication audit, not by semantic ownership.
- Public Worldview and Claim APIs are read-only projections.
- Human Review source code is retained for compatibility, but it is not an active server flow. Do not add a new API or UI that presents it as active without an explicit product decision.
- Legacy Daily Worldview and self-evolving feedback paths are retired. Do not restore them as compatibility shortcuts.
- Do not introduce silent context truncation, fake placeholder outputs, automatic provider fallback, or unbounded filesystem access.

Generated workflow, contract-consumer, and artifact-authority documents are source projections. Update their generators or source-owned documentation and run the relevant generator check; do not edit generated Markdown by hand.

## Testing and validation

Run the checks that cover the changed behavior. Typical focused checks are:

```bash
cd backend
npm test
npm run lint

cd ../frontend
npm test
npm run build
```

The repository-wide clean-install gate is:

```bash
node scripts/clean-install-gate.mjs
```

It runs clean installs, backend tests, Agent asset Golden validation, lint, deterministic demo smoke, frontend tests, and the production build. Before opening a pull request, run:

```bash
git diff --check
git status --short
```

Report which checks you ran and which you did not run. Explain any remaining risk or environment limitation.

## Agent prompts and tool policy

Checked-in Agent system prompts and ordered Tool Use are expert baselines. Change them only when the task explicitly requires a behavior change. After such a change, run:

```bash
cd backend
node scripts/generateAgentAssetGolden.mjs --check
```

If the Golden output changes unexpectedly, stop and investigate the intended change. Do not use `--write` to hide drift.

Runtime Agent overlays and Skills are separate data-backed capabilities. They may narrow the effective tool set and adjust runtime instructions within the supported boundary; they do not authorize casual edits to checked-in expert baselines.

## Provider-backed validation

Provider-backed tests require an explicit live opt-in. Before starting one, determine the Project scope and follow the policy in [`AGENTS.md`](AGENTS.md):

- one Project or a smaller scope may be tested directly;
- two or more Projects are a batch and require prior batch authorization;
- live model work must use an explicit `--live` or equivalent switch and isolated data/evidence roots;
- an unavailable provider/model must fail closed;
- do not print credentials, endpoints, or raw provider payloads.

Ordinary tests, CI, deployment, and startup must remain non-live.

## Pull requests

Use a small, focused branch and an English conventional commit when committing:

```text
feat|fix|docs|chore|eval(scope): summary
```

A pull request should explain:

1. the user-visible problem;
2. the resulting behavior;
3. the authority and data boundary involved;
4. the validation that was run;
5. any migration, compatibility, or operational risk.

Avoid unrelated formatting, dependency upgrades, generated-output edits, runtime data, build output, credentials, and large drive-by refactors.

## Data and security

Keep secrets in the ignored `backend/.env` file. Do not commit `.env`, `backend/data/`, `node_modules/`, `frontend/dist/`, logs, credentials, raw provider payloads, or user runtime data.

If you discover a security issue, follow [`SECURITY.md`](SECURITY.md) and avoid publishing sensitive details in a public issue.
