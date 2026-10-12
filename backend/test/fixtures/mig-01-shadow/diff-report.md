# MIG-01 Industry/Company Legacy/Pi Shadow Diff

Generated from 4 deterministic shadow runs over two Golden cases and the two MIG-01 contracts. Both backends execute the same frozen request through Context, ToolGateway, output projection, schema, and artifact enforcement. Isolated tool executors perform no filesystem or provider writes, and raw model payloads are not stored.

| Metric | Actual | Gate | Result |
|---|---:|---:|:---:|
| Legacy schema pass rate | 100.00% | baseline | PASS |
| Pi schema pass rate | 100.00% | >= Legacy | PASS |
| Output shape agreement | 100.00% | >=95% | PASS |
| Required key-path pass rate | 100.00% | 100% | PASS |
| Artifact path match rate | 100.00% | 100% | PASS |
| Stop reason match rate | 100.00% | 100% | PASS |
| Unauthorized writes | 0 | 0 | PASS |
| DriverBridge present | 2/2 | 2/2 company runs | PASS |
| AssumptionConflict -> company ReviewIssue | 2/2 | 2/2 company runs | PASS |

| Case | Contract | Backend | Turns | Tool calls | Tokens | Cost USD | Artifact paths |
|---|---|---|---:|---:|---:|---:|---|
| ai-infra-chemicals | industry-analyst | legacy | 1 | 2 | 0 | 0.0000 | analysis/industry.json |
| ai-infra-chemicals | industry-analyst | pi | 1 | 2 | 150 | 0.0015 | analysis/industry.json |
| ai-infra-chemicals | company-analyst | legacy | 1 | 2 | 0 | 0.0000 | analysis/company.json |
| ai-infra-chemicals | company-analyst | pi | 1 | 2 | 150 | 0.0015 | analysis/company.json |
| googl | industry-analyst | legacy | 1 | 2 | 0 | 0.0000 | analysis/industry.json |
| googl | industry-analyst | pi | 1 | 2 | 150 | 0.0015 | analysis/industry.json |
| googl | company-analyst | legacy | 1 | 2 | 0 | 0.0000 | analysis/company.json |
| googl | company-analyst | pi | 1 | 2 | 150 | 0.0015 | analysis/company.json |
