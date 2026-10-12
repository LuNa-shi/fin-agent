import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_WORLDVIEW_AGENT_IDS,
  WORLDVIEW_AGENT_IDS,
  listAgentDefinitions,
} from '../src/agents/registry.js';
import { ReportLibraryStore } from '../src/domains/reports/ReportLibraryStore.js';
import { listWorldviewSchemas } from '../src/domains/worldview/contracts/schemaRegistry.js';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.dirname(backendDir);

const removedActiveFiles = [
  'src/agents/definitions/worldview/sharedWorldviewPrompt.js',
  'src/agents/definitions/worldview/worldview-contribution-analyst.agent.js',
  'src/agents/definitions/worldview/worldview-quality-reviewer.agent.js',
  'src/agents/definitions/worldview/worldview-synthesizer.agent.js',
  'src/domains/worldview/WorldviewStore.js',
  'src/domains/worldview/worldviewContracts.js',
  'src/domains/worldview/contracts/schemas/worldview-contribution.output.schema.json',
  'src/domains/worldview/contracts/schemas/worldview-quality-review.output.schema.json',
  'src/domains/worldview/contracts/schemas/worldview-synthesis.output.schema.json',
  'src/workflows/worldview/bindings.js',
  'src/workflows/worldview/workflowSpec.js',
  'src/workflows/worldview/worldviewWorkflow.js',
];

test('Issue #40 removes exactly the legacy Daily Worldview active assets', () => {
  const definitions = listAgentDefinitions();
  assert.equal(definitions.length, 22);
  assert.deepEqual(CANONICAL_WORLDVIEW_AGENT_IDS, ['core-worldview']);
  assert.deepEqual(WORLDVIEW_AGENT_IDS, ['core-worldview']);

  for (const agentId of [
    'worldview-contribution-analyst',
    'worldview-synthesizer',
    'worldview-quality-reviewer',
  ]) {
    assert.equal(definitions.some((definition) => definition.id === agentId), false, agentId);
  }

  assert.deepEqual(
    listWorldviewSchemas().map((schema) => schema.$id).sort(),
    ['core-worldview.input.v1', 'worldview-agent-result.v1'],
  );

  for (const relativePath of removedActiveFiles) {
    assert.equal(fs.existsSync(path.join(backendDir, relativePath)), false, relativePath);
  }
  assert.equal(
    fs.existsSync(path.join(repoDir, 'documents/generated/worldview-daily-synthesis-workflow.md')),
    false,
  );
});

test('Issue #40 leaves no active Daily Worldview composition, route, or generator', () => {
  const activeFiles = [
    'src/server.js',
    'src/agents/registry.js',
    'src/domains/worldview/index.js',
    'src/workflows/worldview/index.js',
    'scripts/generateWorkflowDocs.mjs',
    'scripts/support/expertAssetCases.js',
  ];
  const forbidden = /worldview-(?:contribution-analyst|synthesizer|quality-reviewer)|WORLDVIEW_DAILY_SYNTHESIS|DailyWorldview|createDailyWorldview|\/api\/worldview\/daily/u;

  for (const relativePath of activeFiles) {
    const source = fs.readFileSync(path.join(backendDir, relativePath), 'utf8');
    assert.doesNotMatch(source, forbidden, relativePath);
  }

  const serverSource = fs.readFileSync(path.join(backendDir, 'src/server.js'), 'utf8');
  assert.doesNotMatch(serverSource, /reportAdmissionService\s*\.\s*recover\s*\(/u);
  assert.doesNotMatch(serverSource, /reports\/:reportVersionId\/overview/u);
});

test('Issue #40 active producers and backfill retain one standard admission seam', () => {
  const dailyAdmission = fs.readFileSync(path.join(backendDir, 'src/domains/reports/DailyReportBatchAdmission.js'), 'utf8');
  const backfill = fs.readFileSync(path.join(backendDir, 'src/domains/reports/ReportLibraryBackfill.js'), 'utf8');
  const runAnalysis = fs.readFileSync(path.join(backendDir, 'src/workflows/run-analysis/RunAnalysisService.js'), 'utf8');
  const dailyProducer = fs.readFileSync(path.join(backendDir, 'scripts/runDaily100ReportGate.mjs'), 'utf8');

  assert.match(dailyAdmission, /this\.admissionService\.admit\(/u);
  assert.match(backfill, /this\.admissionService\.admit\(/u);
  assert.match(runAnalysis, /new ReportAdmissionService\(\{ reportLibrary \}\)/u);
  assert.match(dailyProducer, /createReportAdmissionService\(\{ reportLibrary \}\)/u);
  assert.match(dailyProducer, /await reportAdmissionService\.recover\(\)/u);
  for (const source of [dailyAdmission, backfill, runAnalysis, dailyProducer]) {
    assert.doesNotMatch(source, /reportLibrary\.(?:admit|ingest|commitOverview)\(/u);
  }

  for (const removedMethod of ['ingest', 'admit', 'commitOverview', 'recordOverviewFailure']) {
    assert.equal(ReportLibraryStore.prototype[removedMethod], undefined, removedMethod);
  }
});

test('Issue #40 Canonical Worldview consumes admitted Pending reports without a readiness branch', () => {
  const dailyAdmission = fs.readFileSync(path.join(backendDir, 'src/domains/reports/DailyReportBatchAdmission.js'), 'utf8');
  const reportLibrary = fs.readFileSync(path.join(backendDir, 'src/domains/reports/ReportLibraryStore.js'), 'utf8');
  const coordinator = fs.readFileSync(path.join(backendDir, 'src/workflows/worldview/canonicalWorldviewCoordinator.js'), 'utf8');

  assert.match(dailyAdmission, /listPendingReports\(\)/u);
  assert.doesNotMatch(dailyAdmission, /listPendingOverviewReady/u);
  assert.doesNotMatch(reportLibrary, /listPendingOverviewReady/u);
  assert.doesNotMatch(coordinator, /WORLDVIEW_REPORT_NOT_READY|overview\?\.status\s*!==\s*['"]ready['"]/u);
});
