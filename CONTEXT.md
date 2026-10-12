# FinAgent Investment Research

This glossary defines the active product language for FinAgent's investment-research model. It separates durable Worldview reasoning and durable Claims from report-quality/citation terms and from future portfolio-action authority.

## Worldview and Claims

**Report Library**:
The durable collection of admitted immutable ReportVersions. Every admitted ReportVersion has a private Report Overview and a Worldview Processing Status.

**Report Admission**:
The boundary that stages a report candidate, produces and validates its private Report Overview, and then admits both together to the Report Library. A failed admission remains retryable without blocking other reports.

**Daily Report Batch**:
A producer-owned collection of reports admitted together on the daily ingestion cadence. Closing it publishes a durable trigger for one bounded Worldview Run; Reports admitted after run selection remain Pending for later work.

**Claim Library**:
The single active indexed product authority for current Claims and their immutable version, action, rejection, and publication history.

**Claim**:
One durable, falsifiable investment judgment issued and maintained by the Core Worldview Agent. Its core `assertion` is one concise sentence. A Claim also records its subject, optional tickers, causal rationale, verification point or window, metric, acceptance and invalidation conditions, exact ReportVersion evidence, stable identity, positive immutable versions, timestamps, and originating run/publication lineage. It is not direct authority to trade or rebalance.
_Avoid_: report claim, citation claim, material claim

**Worldview**:
A coherent body of current investment reasoning, evidence, counter-evidence, causal relationships, and investment implications. A Worldview is not a container or semantic parent for Claims.

**Canonical Worldview**:
The sole continuing Worldview product, published as complete self-contained versions. Retained historical files from retired products have no active semantics.

**Worldview and Claim separation**:
Canonical Worldview and Claim Library are semantically separate outputs. A Claim has no Worldview Version or KEEP Evaluation foreign key. The records are linked only by the same Worldview Run and completed publication audit.

**Worldview Agent Run**:
One durable evaluation over the oldest selected group of at most 100 Pending ReportVersions. The Core Worldview Agent considers every frozen Report Overview, selectively reads exact ReportVersions, decides `KEEP` or `UPDATE` first, and then emits zero or more independent `ADD`, `UPDATE`, or `NOOP` Claim actions. Issue #41 processes one group per trigger; consecutive backlog draining and exhausted-run recovery belong to Issue #42.

**Worldview Run Workspace**:
The durable immutable input space persisted before the first complete Agent attempt. It freezes the ordered ReportVersion manifest and Overview bytes/digests, the complete current Canonical Worldview or bootstrap state, complete current Claim records, the compact `claimId/version/assertion` table, effective route/reasoning/Prompt identity, both retry policies, resource/tool bounds, approved capabilities, stable identities, and a workspace digest. Every complete Agent retry uses the same workspace bytes.

**Complete Agent Attempt**:
A fresh Core Worldview Agent conversation over the frozen workspace. One Worldview Run permits at most three complete Agent attempts. Inside each complete attempt, the model API/transport layer independently permits at most five retryable attempts. Both layers are recorded in the run audit.

**Worldview Processing Status**:
The two-state public ReportVersion status `Pending` or `Processed`. A ReportVersion becomes Processed only when an exact committed Processed Receipt matches its ID, admission sequence, content digest, and fingerprint. Interrupted, invalid, or exhausted Runs leave it Pending; selective full-report reads do not create another lifecycle state.
_Avoid_: unread, read, overview-ready

**Processed Receipt**:
An immutable per-ReportVersion record committed by a successful Worldview Run. It is the exact business authority for the ReportVersion's Processed status.

**Run Publication Marker**:
The single authoritative completed marker for one Worldview Run. It binds the staged Worldview outcome, Claim publication digest, accepted and rejected Claim action audit, complete Agent/model-API attempt audit, exact Processed Receipts, and workspace lineage. Before the marker, none of those staged objects is active; after it, projections can recover without another Agent call.

**Worldview Evaluation Record**:
The append-only record created by a valid `KEEP`. It records considered material and rationale without creating a redundant Worldview Version. The same run may still publish valid Claim changes.

**Worldview Update Record**:
The append-only explanation of retained, changed, added, and removed causal understanding associated with one complete Canonical Worldview `UPDATE`.

**Claim Action**:
One explicit Agent decision with a stable `actionId` and rationale. `ADD` creates a stable replay-derived Claim identity and v1 body. `UPDATE` targets an exact frozen `{claimId, expectedVersion}` and creates the next immutable version. `NOOP` targets the same exact identity/version and creates action audit without a new Claim version. Unmentioned Claims remain unchanged.

**Partial Claim rejection**:
Claim items cross an independent deterministic validation seam after the Worldview is mechanically valid. Each valid action is admitted. Each invalid item is discarded with a durable safe reason, while unrelated valid items continue. The first valid action accepted for an `actionId` or existing Claim target wins; later conflicts are rejected. Claim-item invalidity does not trigger a complete Agent retry or invalidate the Worldview. Storage, integrity, locking, or publication failure still aborts the whole publication.

**Report Overview**:
A private, bounded, digest-bound discovery projection created as part of admitting one immutable ReportVersion to the Report Library. Only a frozen Core Worldview capability may read it. It is not an independent product or direct evidence authority; direct evidence must come from the exact digest-verified ReportVersion.

**Future Claim Verification**:
A separate future system that may collect evidence when a Claim reaches its verification time and record whether the judgment is supported, refuted, or inconclusive. Issue #41 stores the required time, metric, and conditions but does not schedule or perform that verification.
