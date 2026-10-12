import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SMOKE_DATA_PREFIX = 'finagent-demo-smoke-';
const previousEnvironment = {
  FIN_DATA_DIR: process.env.FIN_DATA_DIR,
  DEMO_MODE: process.env.DEMO_MODE,
  AUTO_RESUME: process.env.AUTO_RESUME,
};
const smokeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), SMOKE_DATA_PREFIX));

process.env.FIN_DATA_DIR = smokeDataDir;
process.env.DEMO_MODE = 'true';
process.env.AUTO_RESUME = 'false';

function restoreEnvironment() {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function removeSmokeDataDir() {
  const expectedParent = path.resolve(os.tmpdir());
  const resolved = path.resolve(smokeDataDir);
  if (
    path.dirname(resolved) !== expectedParent
    || !path.basename(resolved).startsWith(SMOKE_DATA_PREFIX)
  ) {
    throw new Error(`refusing to remove unsafe demo smoke data directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function waitForAnalysis(service, projectId, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = service.status(projectId);
    if (!['queued', 'analyzing'].includes(status.projectStatus)) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`analysis service timed out: ${projectId}`);
}

try {
  const { ProjectSpace: ProjectFS } = await import('../src/project-space/index.js');
  const { RunAnalysisService } = await import('../src/workflows/run-analysis/RunAnalysisService.js');
  const { IdeaSystem } = await import('../src/workflows/idea-generation/ideaSystem.js');

  const project = ProjectFS.create({
    title: 'Demo Smoke: adaptor architecture',
    theme: 'AI infrastructure capex verification',
    rationale: 'Smoke test for adaptor/orchestrator pipeline, forecast artifact, timestamped report, and idea generation.',
    tickers: ['NVDA'],
    intensity: 'quick',
    analysisLanguage: 'en',
    reportLanguage: 'en',
    companyLocale: 'global',
  });
  const projectId = project.id;
  const analysisService = new RunAnalysisService();
  const started = analysisService.start(projectId, {
    intensity: 'quick',
    resume: false,
  });
  if (!started.started) throw new Error(`analysis service did not start: ${started.reason}`);
  const analyzed = await waitForAnalysis(analysisService, projectId);
  if (analyzed.status !== 'analyzed') throw new Error(`project status is ${analyzed.status}`);

  const detail = {
    meta: ProjectFS.meta(projectId),
    reports: ProjectFS.reportVersions(projectId),
    adaptors: ProjectFS.adaptorState(projectId),
    events: ProjectFS.events(projectId),
  };
  const latestReport = detail.reports.find((r) => /^report_\d{8}_\d{6}/.test(r.name));
  const structuredEvents = detail.events.filter((e) => e.stage && e.agent && Object.prototype.hasOwnProperty.call(e, 'round') && Object.prototype.hasOwnProperty.call(e, 'artifact'));
  if (!latestReport) throw new Error('missing timestamped report');
  if (structuredEvents.length !== detail.events.length) throw new Error('some events are missing structured fields');

  const ideasRes = await IdeaSystem.generate(20);
  if ((ideasRes.generated || []).length < 20) throw new Error(`expected 20 generated ideas, got ${(ideasRes.generated || []).length}`);
  const oneSentence = ideasRes.generated.every((idea) => idea.sentence && idea.sourceAgents?.length);
  if (!oneSentence) throw new Error('generated ideas are missing sentence/sourceAgents');

  console.log(JSON.stringify({
    ok: true,
    projectId,
    status: analyzed.status,
    events: detail.events.length,
    structuredEvents: structuredEvents.length,
    timestampedReport: latestReport.path,
    generatedIdeas: ideasRes.generated.length,
    provider: ideasRes.provider,
    live: ideasRes.live,
  }, null, 2));
} finally {
  try {
    removeSmokeDataDir();
  } finally {
    restoreEnvironment();
  }
}
