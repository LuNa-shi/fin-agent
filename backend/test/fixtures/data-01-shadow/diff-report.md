# DATA-01 Data Orchestrator Legacy/Pi Shadow Diff

Generated from 2 deterministic shadow runs over two Golden cases. Both backends execute the same frozen Data request through Context, the canonical output projection, central schema, and completion enforcement. The Data LLM receives zero tools, performs zero writes, and publishes no Agent-owned artifacts; the deterministic evidence pipeline owns the six declared Data artifacts. Raw provider payloads are not stored.

| Metric | Actual | Gate | Result |
|---|---:|---:|:---:|
| Legacy schema pass rate | 100.00% | baseline | PASS |
| Pi schema pass rate | 100.00% | >= Legacy | PASS |
| Output shape agreement | 100.00% | >=95% | PASS |
| Required key-path pass rate | 100.00% | 100% | PASS |
| Artifact path match rate | 100.00% | 100% | PASS |
| Stop reason match rate | 100.00% | 100% | PASS |
| Zero tool exposure and calls | 2/2 | 2/2 | PASS |
| Zero Agent artifact writes | 2/2 | 2/2 | PASS |
| Unauthorized writes | 0 | 0 | PASS |

| Case | Backend | Turns | Tool calls | Tokens | Cost USD | Agent artifact paths |
|---|---|---:|---:|---:|---:|---|
| ai-infra-chemicals | legacy | 1 | 0 | 0 | 0.0000 |  |
| ai-infra-chemicals | pi | 1 | 0 | 200 | 0.0022 |  |
| googl | legacy | 1 | 0 | 0 | 0.0000 |  |
| googl | pi | 1 | 0 | 200 | 0.0022 |  |
