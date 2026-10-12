# Week 3 Legacy/Pi Shadow Diff Report

Generated from 6 deterministic shadow runs over two Golden cases and three migrated contracts. Inputs are key-free fixtures; raw provider payloads are not stored.

| Metric | Actual | Gate | Result |
|---|---:|---:|:---:|
| Legacy schema pass rate | 100.00% | baseline | PASS |
| Pi schema pass rate | 100.00% | >= Legacy | PASS |
| Output shape agreement | 100.00% | >=95% | PASS |
| Stop reason match rate | 100.00% | 100% | PASS |
| Artifact path match rate | 100.00% | 100% | PASS |
| Permission denials | 0 | 0 | PASS |
| Pi typed events | 42 | 7/run | PASS |
| Structured adjudication | 2/2 report-routed | critical → remediation | PASS |

Every Pi run records two tool starts, out-of-order completion (b then a), source-order tool trace (a then b), one turn completion, and a canonical final stop.
