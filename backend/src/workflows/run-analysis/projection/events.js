import { ProjectSpace as ProjectFS } from '../../../project-space/index.js';

function eventStage(type, payload = {}) {
  if (payload.stage) return payload.stage;
  if (type === 'initial-plan') return 'initial-plan';
  if (type === 'main-orchestrator') return 'main-orchestrator';
  if (type === 'adaptor') return payload.agent?.replace('-adaptor', '') || 'adaptor';
  if (type === 'final-report') return 'final-report';
  if (payload.agent?.startsWith('data')) return 'data';
  if (payload.agent?.startsWith('industry')) return 'industry';
  if (payload.agent?.startsWith('company')) return 'company';
  if (payload.agent === 'reflection') return 'reflection';
  if (payload.step === 1 || type === 'plan') return 'plan';
  if (payload.step === 3 || type === 'report') return 'report';
  if (payload.step === 4) return payload.artifact?.includes('forecast') ? 'forecast' : 'conclusion';
  if (type === 'round' || payload.step === 2) return 'analysis';
  return 'system';
}

function eventAgent(type, payload = {}) {
  if (payload.agent) return payload.agent;
  if (type === 'initial-plan') return 'initial-plan';
  if (type === 'main-orchestrator') return 'main-orchestrator';
  if (type === 'final-report') return 'report-composer';
  if (type === 'plan' || type === 'think') return 'analysis-coordinator';
  if (type === 'retry') return 'analysis-coordinator';
  if (type === 'done' && payload.step === 4) return 'report-composer';
  return 'analysis-coordinator';
}

function eventArtifact(type, payload = {}) {
  if (payload.artifact) return payload.artifact;
  if (payload.step === 1 && type === 'observe') return 'analysis/plan.json';
  if (payload.step === 3 || type === 'report') return 'report/report.md';
  if (payload.step === 4 && type === 'done') return 'analysis/forecast.json';
  return null;
}

export function emitRunAnalysisEvent(id, type, payload = {}) {
  const event = {
    type,
    stage: eventStage(type, payload),
    agent: eventAgent(type, payload),
    round: payload.round ?? null,
    artifact: eventArtifact(type, payload),
    ...payload,
  };
  return ProjectFS.appendEvent(id, event);
}

export const emit = emitRunAnalysisEvent;
