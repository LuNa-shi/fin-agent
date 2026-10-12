import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('./fixtures/mig-01-shadow/', import.meta.url);
const readJSON = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'));

test('MIG-01 shadow evidence covers both Golden cases and both migrated contracts', async () => {
  const summary = await readJSON('summary.json');
  assert.deepEqual(summary.caseIds, ['ai-infra-chemicals', 'googl']);
  assert.deepEqual(summary.contractIds, ['industry-analyst', 'company-analyst']);
  assert.equal(summary.runs.length, 4);
  assert.equal(summary.gates.legacySchemaPassRate, 1);
  assert.equal(summary.gates.piSchemaPassRate, 1);
  assert.equal(summary.gates.piSchemaNotBelowLegacy, true);
  assert.equal(summary.gates.meanOutputShapeAgreementPct, 100);
  assert.equal(summary.gates.outputShapeAgreementPassed, true);
  assert.equal(summary.gates.requiredKeyPathPassRate, 1);
  assert.equal(summary.gates.artifactPathMatchRate, 1);
  assert.equal(summary.gates.stopReasonMatchRate, 1);
  assert.equal(summary.gates.unauthorizedWriteCount, 0);
  assert.equal(summary.gates.companyDriverBridgePassed, true);
  assert.equal(summary.gates.assumptionConflictPassed, true);
  assert.equal(summary.gates.allPassed, true);
  assert.ok(summary.runs.every((run) => run.legacy.status === 'succeeded' && run.pi.status === 'succeeded'));
  assert.ok(summary.runs.every((run) => run.diff.outputDigestMatch && run.diff.artifactPathsMatch));
  assert.ok(summary.runs.every((run) => run.legacy.permissionDenials.length === 0 && run.pi.permissionDenials.length === 0));
  assert.ok(summary.runs.every((run) => !Object.hasOwn(run.legacy, 'output') && !Object.hasOwn(run.pi, 'output')));
  assert.ok(summary.runs.every((run) => run.legacy.metrics.toolCalls === 2 && run.pi.metrics.toolCalls === 2));
});

test('MIG-01 evidence requires DriverBridge and converts each assumption conflict to a company ReviewIssue', async () => {
  const summary = await readJSON('summary.json');
  const companyRuns = summary.runs.filter((run) => run.contractId === 'company-analyst');
  assert.equal(companyRuns.length, 2);
  for (const run of companyRuns) {
    assert.equal(run.semantic.driverBridgeCount, 1);
    assert.equal(run.semantic.assumptionConflictCount, 1);
    assert.equal(run.semantic.reviewIssueCount, 1);
    assert.deepEqual(run.semantic.reviewIssueOwners, ['company']);
    assert.deepEqual(run.semantic.legacyMissingKeyPaths, []);
    assert.deepEqual(run.semantic.piMissingKeyPaths, []);
  }
});

test('MIG-01 Pi event evidence is ordered, correlated, and includes isolated authorized writes', async () => {
  const lines = (await readFile(new URL('events.jsonl', root), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 28);
  for (const runId of new Set(lines.map((event) => event.runId))) {
    const events = lines.filter((event) => event.runId === runId);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(events.map((event) => event.eventType), [
      'agent.started', 'tool.started', 'tool.completed', 'tool.started', 'tool.completed', 'agent.turn.completed', 'agent.stopped',
    ]);
    assert.equal(events[3].payload.tool, 'ws_write_file');
    assert.equal(events[4].payload.tool, 'ws_write_file');
  }
});

test('MIG-01 diff report publishes gates and per-backend resource metrics', async () => {
  const report = await readFile(new URL('diff-report.md', root), 'utf8');
  assert.match(report, /Output shape agreement \| 100\.00% \| >=95% \| PASS/);
  assert.match(report, /Required key-path pass rate \| 100\.00% \| 100% \| PASS/);
  assert.match(report, /Artifact path match rate \| 100\.00% \| 100% \| PASS/);
  assert.match(report, /Unauthorized writes \| 0 \| 0 \| PASS/);
  assert.match(report, /DriverBridge present \| 2\/2/);
  assert.match(report, /AssumptionConflict -> company ReviewIssue \| 2\/2/);
  assert.match(report, /Cost USD \| Artifact paths/);
});
