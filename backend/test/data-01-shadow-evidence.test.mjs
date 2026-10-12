import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('./fixtures/data-01-shadow/', import.meta.url);
const readJSON = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'));

test('DATA-01 shadow evidence covers both Golden cases with zero Data LLM tools and writes', async () => {
  const summary = await readJSON('summary.json');
  assert.equal(summary.generator, 'scripts/generateData01ShadowEvidence.mjs');
  assert.deepEqual(summary.caseIds, ['ai-infra-chemicals', 'googl']);
  assert.deepEqual(summary.contractIds, ['data-orchestrator']);
  assert.equal(summary.runs.length, 2);
  assert.equal(summary.gates.allPassed, true);
  assert.equal(summary.gates.legacySchemaPassRate, 1);
  assert.equal(summary.gates.piSchemaPassRate, 1);
  assert.equal(summary.gates.piSchemaNotBelowLegacy, true);
  assert.ok(summary.gates.meanOutputShapeAgreementPct >= 95);
  assert.equal(summary.gates.requiredKeyPathPassRate, 1);
  assert.equal(summary.gates.artifactPathMatchRate, 1);
  assert.equal(summary.gates.stopReasonMatchRate, 1);
  assert.equal(summary.gates.zeroToolExposure, true);
  assert.equal(summary.gates.zeroAgentArtifactWrites, true);
  assert.equal(summary.gates.unauthorizedWriteCount, 0);

  for (const run of summary.runs) {
    assert.equal(Object.hasOwn(run.legacy, 'output'), false);
    assert.equal(Object.hasOwn(run.pi, 'output'), false);
    assert.deepEqual(run.semantic.legacyExposedTools, []);
    assert.deepEqual(run.semantic.piExposedTools, []);
    assert.equal(run.legacy.metrics.toolCalls, 0);
    assert.equal(run.pi.metrics.toolCalls, 0);
    assert.deepEqual(run.legacy.artifactPaths, []);
    assert.deepEqual(run.pi.artifactPaths, []);
    assert.equal(run.semantic.deterministicArtifactPaths.length, 6);
    assert.ok(run.semantic.organizedPointCount > 0);
  }
});

test('DATA-01 Pi event evidence is ordered and contains no tool execution', async () => {
  const rows = (await readFile(new URL('events.jsonl', root), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(rows.length > 0);
  const byRun = Map.groupBy(rows, (row) => row.runId);
  assert.equal(byRun.size, 2);
  for (const events of byRun.values()) {
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
    assert.equal(events.some((event) => event.eventType.startsWith('tool.')), false);
    assert.equal(events[0].eventType, 'agent.started');
    assert.equal(events.at(-1).eventType, 'agent.stopped');
  }
});

test('DATA-01 diff report publishes the frozen quantitative gates', async () => {
  const report = await readFile(new URL('diff-report.md', root), 'utf8');
  assert.match(report, /2 deterministic shadow runs/u);
  assert.match(report, /Zero tool exposure and calls \| 2\/2 \| 2\/2 \| PASS/u);
  assert.match(report, /Zero Agent artifact writes \| 2\/2 \| 2\/2 \| PASS/u);
  assert.match(report, /Unauthorized writes \| 0 \| 0 \| PASS/u);
});
