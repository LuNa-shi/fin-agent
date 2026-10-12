import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('./fixtures/week3-shadow/', import.meta.url);
const readJSON = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'));

test('checked-in Week 3 shadow evidence covers both Golden cases and all migrated contracts', async () => {
  const summary = await readJSON('summary.json');
  assert.deepEqual(summary.caseIds, ['ai-infra-chemicals', 'googl']);
  assert.deepEqual(summary.contractIds, ['logic-reviewer', 'report-composer', 'requirement-reviewer']);
  assert.equal(summary.runs.length, 6);
  assert.equal(summary.gates.legacySchemaPassRate, 1);
  assert.equal(summary.gates.piSchemaPassRate, 1);
  assert.equal(summary.gates.piSchemaNotBelowLegacy, true);
  assert.equal(summary.gates.meanOutputShapeAgreementPct, 100);
  assert.equal(summary.gates.outputShapeAgreementPassed, true);
  assert.equal(summary.gates.stopReasonMatchRate, 1);
  assert.equal(summary.gates.artifactPathMatchRate, 1);
  assert.equal(summary.gates.totalPermissionDenials, 0);
  assert.ok(summary.runs.every((run) => run.diff.outputDigestMatch));
  assert.ok(summary.runs.every((run) => !Object.hasOwn(run.legacy, 'output') && !Object.hasOwn(run.pi, 'output')));
  assert.deepEqual(summary.adjudications.map((item) => ({ caseId: item.caseId, route: item.route, remediationCount: item.remediationCount })), [
    { caseId: 'ai-infra-chemicals', route: 'report', remediationCount: 2 },
    { caseId: 'googl', route: 'report', remediationCount: 2 },
  ]);
  assert.ok(summary.adjudications.every((item) => item.criticalIssueCount === 2 && item.owners.every((owner) => owner === 'report')));
});

test('checked-in Pi event evidence is ordered, correlated, and records parallel completion separately from result order', async () => {
  const lines = (await readFile(new URL('events.jsonl', root), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 42);
  for (const runId of new Set(lines.map((event) => event.runId))) {
    const events = lines.filter((event) => event.runId === runId);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(events.map((event) => event.eventType), [
      'agent.started', 'tool.started', 'tool.started', 'tool.completed', 'tool.completed', 'agent.turn.completed', 'agent.stopped',
    ]);
    assert.equal(events[3].payload.toolCallId, 'b');
    assert.equal(events[4].payload.toolCallId, 'a');
  }
});

test('Week 3 diff report publishes the quantitative gate table', async () => {
  const report = await readFile(new URL('diff-report.md', root), 'utf8');
  assert.match(report, /Pi schema pass rate \| 100\.00%/);
  assert.match(report, /Output shape agreement \| 100\.00% \| >=95% \| PASS/);
  assert.match(report, /Artifact path match rate \| 100\.00% \| 100% \| PASS/);
  assert.match(report, /Permission denials \| 0 \| 0 \| PASS/);
  assert.match(report, /6 deterministic shadow runs/);
  assert.match(report, /Structured adjudication \| 2\/2 report-routed/);
});
