# M1 W3–W5 deterministic fixture

This fixture is consumed only by `backend/scripts/runM1W3W5Composition.mjs`.
It is not a live/provider evaluation and is intentionally outside the
`test/*.test.mjs` execution pattern so the one-shot M1 scenario is not repeated
inside the canonical clean-install gate.

The fixture drives the production `idea-generation.v2` composition with
`DEMO_MODE=false` and an injected deterministic, non-live Agent backend. It
contains more valid generated candidates than requested, reviewer-selected and
unselected valid candidates, a low-ranked selected candidate, duplicate and
malformed outputs, an invalid-ticker output, and source-only material that must
not be published as an Idea.

Before returning fixture output, the injected backend validates the exact
Workflow/node/scope/idempotency/snapshot/config identity and the semantic
generator/reviewer inputs produced by the production W3 runtime. The parent
runner claims the exact commit before phase one, denies all network-capable
transports, and writes only a redacted ignored summary.
