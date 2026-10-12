import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  INTENSITY,
  RUN_ANALYSIS_WORKFLOW,
  runAnalysisWorkflow,
} from '../src/workflows/run-analysis/runAnalysis.workflow.js';

const source = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('Run Analysis workflow declares its stable controller sequence', () => {
  assert.equal(RUN_ANALYSIS_WORKFLOW.id, 'run-analysis.v2');
  assert.equal(RUN_ANALYSIS_WORKFLOW.version, '2.0.0');
  assert.deepEqual(RUN_ANALYSIS_WORKFLOW.nodes.map((node) => node.id), [
    'initialize-checkpoint',
    'plan-research',
    'select-candidates',
    'run-research-rounds',
    'compose-report',
    'review-report',
    'synthesize-conclusion',
    'finalize-project',
  ]);
  assert.equal(Object.isFrozen(RUN_ANALYSIS_WORKFLOW), true);
  assert.equal(Object.isFrozen(RUN_ANALYSIS_WORKFLOW.nodes), true);
  assert.equal(typeof runAnalysisWorkflow, 'function');
  assert.deepEqual(Object.keys(INTENSITY), ['quick', 'standard', 'deep']);
});

test('Run Analysis controller and report editing have direct workflow-owned entry points', async () => {
  const [reportEditing, facade, composition, checkpointContext, remediation, finalize, ...handlers] = await Promise.all([
    source('src/workflows/run-analysis/reportEditing.js'),
    source('src/workflows/run-analysis/runAnalysis.workflow.js'),
    source('src/workflows/run-analysis/runAnalysis.js'),
    source('src/workflows/run-analysis/runtime/checkpointContext.js'),
    source('src/workflows/run-analysis/policies/remediation.js'),
    source('src/workflows/run-analysis/handlers/finalizeProject.js'),
    ...['planResearch', 'selectCandidates', 'composeReport', 'reviewReport', 'synthesizeConclusion']
      .map((name) => source(`src/workflows/run-analysis/handlers/${name}.js`)),
  ]);
  const handlerSource = handlers.join('\n');
  const runtimeProjection = `${checkpointContext}\n${remediation}\n${finalize}`;

  await assert.rejects(access(new URL('../src/agents/analysisAgent.js', import.meta.url)));
  assert.match(reportEditing, /runDefinedAgent\s*\(\s*['"]report-editor['"]/u);
  assert.doesNotMatch(reportEditing, /runDataRound|runIndustryRound|runCompanyRound|runReviewerGroup|runInvestmentAgent|ReasoningEngine/u);
  assert.doesNotMatch(reportEditing, /checkpoint|PHASE 1|PHASE 2/u);

  for (const contractId of ['analysis-plan', 'scan-score', 'report-composer', 'conclusion-synthesizer']) {
    assert.match(handlerSource, new RegExp(`runDefinedAgent\\(\\s*['"]${contractId}['"]`), `${contractId} is not workflow-owned`);
  }
  assert.doesNotMatch(handlerSource, /runInvestmentAgent|currentWorkflowNodeContext/u);
  assert.match(handlerSource, /runReviewerGroup\s*\(/u);
  assert.match(composition, /executeWorkflowWithRemediation\s*\(/u);
  assert.match(composition, /RUN_ANALYSIS_HANDLER_BINDINGS/u);
  assert.match(runtimeProjection, /cp\.runtimeMetrics\s*=\s*context\.runtimeMetrics\.snapshot\(\)/u);
  assert.match(runtimeProjection, /runtimeMetrics:\s*context\.runtimeMetrics\.snapshot\(\)/u);
  assert.match(facade, /export \{ runAnalysisWorkflow \} from ['"]\.\/runAnalysis\.js['"]/u);
  assert.doesNotMatch(facade, /runInvestmentAgent|runReviewerGroup|executeWorkflowWithRemediation/u);
  assert.doesNotMatch(composition, /nodes:\s*Object\.freeze\s*\(\s*\[/u);
  assert.doesNotMatch(`${facade}\n${composition}\n${handlerSource}`, /\brunAgent\s*\(|\bchatJSON\s*\(|\bchat\s*\(/u);
  assert.doesNotMatch(`${facade}\n${composition}\n${handlerSource}`, /defineAgent|toolAllowlist\s*:/u);
});

test('Run Analysis exposes one execute/hydrate module per canonical node and keeps legacy research paths thin', async () => {
  const handlers = [
    ['initializeCheckpoint', 'hydrateInitializeCheckpoint'],
    ['planResearch', 'hydratePlanResearch'],
    ['selectCandidates', 'hydrateSelectCandidates'],
    ['runResearchRounds', 'hydrateResearchRounds'],
    ['composeReport', 'hydrateComposeReport'],
    ['reviewReport', 'hydrateReviewReport'],
    ['synthesizeConclusion', 'hydrateSynthesizeConclusion'],
    ['finalizeProject', 'hydrateFinalizeProject'],
  ];
  for (const [handlerId, hydratorId] of handlers) {
    const text = await source(`src/workflows/run-analysis/handlers/${handlerId}.js`);
    assert.match(text, new RegExp(`export \\{ ${handlerId} as execute, ${hydratorId} as hydrate \\}`), handlerId);
  }

  for (const name of [
    'analysisSubAgents',
    'companyRound',
    'dataAgent',
    'dataRound',
    'industryRound',
    'selectiveResearchRemediation',
    'tickerScope',
  ]) {
    const legacy = await source(`src/workflows/run-analysis/nodes/${name}.js`);
    assert.equal(legacy, `export * from '../research/${name}.js';\n`, name);
    const [legacyModule, researchModule] = await Promise.all([
      import(new URL(`../src/workflows/run-analysis/nodes/${name}.js`, import.meta.url)),
      import(new URL(`../src/workflows/run-analysis/research/${name}.js`, import.meta.url)),
    ]);
    assert.deepEqual(Object.keys(legacyModule), Object.keys(researchModule), `${name} exports`);
    for (const exportName of Object.keys(researchModule)) {
      assert.equal(legacyModule[exportName], researchModule[exportName], `${name}.${exportName}`);
    }
  }

  const facade = await source('src/workflows/run-analysis/runAnalysis.workflow.js');
  const composition = await source('src/workflows/run-analysis/runAnalysis.js');
  assert.ok(facade.split('\n').length < 25, 'compatibility facade is no longer thin');
  assert.match(composition, /executeWorkflowWithRemediation\s*\(\{/u);
  assert.match(composition, /handlers:\s*RUN_ANALYSIS_HANDLER_BINDINGS/u);
  assert.match(composition, /hydrators:\s*RUN_ANALYSIS_HYDRATION_BINDINGS/u);
  assert.match(composition, /conditions:\s*RUN_ANALYSIS_CONDITION_BINDINGS/u);
  assert.doesNotMatch(composition, /from ['"]\.\/(?:handlers|research)\//u);
});

test('round orchestration and report review mechanics live under the workflow boundary', async () => {
  const nodeFiles = [
    'src/workflows/run-analysis/research/dataAgent.js',
    'src/workflows/run-analysis/research/analysisSubAgents.js',
    'src/workflows/run-analysis/research/dataRound.js',
    'src/workflows/run-analysis/research/industryRound.js',
    'src/workflows/run-analysis/research/companyRound.js',
    'src/workflows/run-analysis/research/selectiveResearchRemediation.js',
  ];
  const reviewerFiles = [
    'src/workflows/run-analysis/reviewers/reviewerGroup.js',
    'src/workflows/run-analysis/reviewers/deterministicGates.js',
    'src/workflows/run-analysis/reviewers/adjudicator.js',
    'src/workflows/run-analysis/reviewers/reviewerContracts.js',
  ];
  const artifactFiles = [
  ];

  for (const filename of [...nodeFiles, ...reviewerFiles, ...artifactFiles]) {
    const text = await source(filename);
    assert.doesNotMatch(text, /defineAgent|systemPrompt\s*:|toolAllowlist\s*:/u, filename);
  }

  for (const filename of [
    'src/workflows/run-analysis/runAnalysis.workflow.js',
    ...nodeFiles,
  ]) {
    const text = await source(filename);
    assert.doesNotMatch(
      text,
      /\bmaxSteps\b|\bbudgetForIntensity\b|\bmergeBudgetReports\b|\bbudgetReport\b|\bbudget\s*(?:=|,|:)/u,
      `${filename} retains a Workflow-owned legacy budget path`,
    );
  }
  for (const filename of [
    'src/agents/dataAgent.js',
    'src/agents/analysisSubAgents.js',
    'src/agents/adaptors/dataAdaptor.js',
    'src/agents/adaptors/industryAdaptor.js',
    'src/agents/adaptors/companyAdaptor.js',
    'src/agents/adaptors/critiqueAgent.js',
    'src/agents/orchestrators/dataOrchestrator.js',
    'src/agents/orchestrators/industryOrchestrator.js',
    'src/agents/orchestrators/companyOrchestrator.js',
    'src/domains/research/reviewers/reviewerGroup.js',
  ]) await assert.rejects(access(new URL(`../${filename}`, import.meta.url)), undefined, filename);
});

test('Run Analysis uses the canonical Agent execution runtime without a Research facade', async () => {
  const runtime = await source('src/agents/AgentExecutionRuntime.js');
  await assert.rejects(access(new URL('../src/domains/research/runInvestmentAgent.js', import.meta.url)));
  assert.match(runtime, /class AgentExecutionRuntime/u);
  assert.match(runtime, /currentWorkflowNodeContext\s*\(/u);
  assert.doesNotMatch(runtime, /PI_MIGRATED_CONTRACT_IDS|RESEARCH_AGENT_BACKEND|pi-analysis|pi-week3/u);
});
