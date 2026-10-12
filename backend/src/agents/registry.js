// Explicit imports only: definition discovery must never depend on filesystem scanning or import side effects.
import { dealLadderRankingAgent } from './definitions/decision/deal-ladder-ranking.agent.js';
import { ideaRankingAgent } from './definitions/decision/idea-ranking.agent.js';
import { ideaGeneratorAgent } from './definitions/idea-generation/idea-generator.agent.js';
import { ideaQualityReviewerAgent } from './definitions/idea-generation/idea-quality-reviewer.agent.js';
import { projectClassifierAgent } from './definitions/idea-generation/project-classifier.agent.js';
import { reportOverviewAgent } from './definitions/report-library/report-overview.agent.js';
import { coreWorldviewAgent } from './definitions/worldview/core-worldview.agent.js';
import { analysisPlanAgent } from './definitions/run-analysis/analysis-plan.agent.js';
import { companyAnalystAgent } from './definitions/run-analysis/company-analyst.agent.js';
import { companyScoreboardEvaluatorAgent } from './definitions/run-analysis/company-scoreboard-evaluator.agent.js';
import { conclusionSynthesizerAgent } from './definitions/run-analysis/conclusion-synthesizer.agent.js';
import { dataOrchestratorAgent } from './definitions/run-analysis/data-orchestrator.agent.js';
import { dataScoreboardEvaluatorAgent } from './definitions/run-analysis/data-scoreboard-evaluator.agent.js';
import { evidenceReviewerAgent } from './definitions/run-analysis/evidence-reviewer.agent.js';
import { industryAnalystAgent } from './definitions/run-analysis/industry-analyst.agent.js';
import { industryScoreboardEvaluatorAgent } from './definitions/run-analysis/industry-scoreboard-evaluator.agent.js';
import { logicReviewerAgent } from './definitions/run-analysis/logic-reviewer.agent.js';
import { reportComposerAgent } from './definitions/run-analysis/report-composer.agent.js';
import { reportEditorAgent } from './definitions/run-analysis/report-editor.agent.js';
import { reportTranslatorAgent } from './definitions/run-analysis/report-translator.agent.js';
import { requirementReviewerAgent } from './definitions/run-analysis/requirement-reviewer.agent.js';
import { scanScoreAgent } from './definitions/run-analysis/scan-score.agent.js';
import { assertAgentDefinition } from './defineAgent.js';

export class AgentDefinitionRegistry {
  #definitions = new Map();

  constructor(definitions = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition) {
    if (!definition || typeof definition !== 'object' || !definition.id) {
      throw new TypeError('Agent definition with id is required');
    }
    assertAgentDefinition(definition);
    if (!Object.isFrozen(definition)) throw new TypeError(`Agent definition must be frozen: ${definition.id}`);
    if (this.#definitions.has(definition.id)) throw new Error(`duplicate Agent definition: ${definition.id}`);
    this.#definitions.set(definition.id, definition);
    return definition;
  }

  get(id) {
    const definition = this.#definitions.get(id);
    if (!definition) throw new Error(`unknown Agent definition: ${id}`);
    return definition;
  }

  ids() {
    return [...this.#definitions.keys()];
  }

  list() {
    return [...this.#definitions.values()];
  }
}

const runAnalysisDefinitions = Object.freeze([
  analysisPlanAgent,
  scanScoreAgent,
  dataOrchestratorAgent,
  dataScoreboardEvaluatorAgent,
  industryAnalystAgent,
  industryScoreboardEvaluatorAgent,
  companyAnalystAgent,
  companyScoreboardEvaluatorAgent,
  reportComposerAgent,
  evidenceReviewerAgent,
  requirementReviewerAgent,
  logicReviewerAgent,
  conclusionSynthesizerAgent,
]);

export const RUN_ANALYSIS_AGENT_IDS = Object.freeze(
  runAnalysisDefinitions.map((definition) => definition.id),
);

export function listRunAnalysisAgentDefinitions() {
  return [...runAnalysisDefinitions];
}

const reportLibraryDefinitions = Object.freeze([
  reportOverviewAgent,
]);

export const REPORT_LIBRARY_AGENT_IDS = Object.freeze(
  reportLibraryDefinitions.map((definition) => definition.id),
);

export function listReportLibraryAgentDefinitions() {
  return [...reportLibraryDefinitions];
}

const canonicalWorldviewDefinitions = Object.freeze([coreWorldviewAgent]);
const worldviewDefinitions = canonicalWorldviewDefinitions;

export const CANONICAL_WORLDVIEW_AGENT_IDS = Object.freeze(
  canonicalWorldviewDefinitions.map((definition) => definition.id),
);
export const WORLDVIEW_AGENT_IDS = Object.freeze(
  worldviewDefinitions.map((definition) => definition.id),
);

export function listCanonicalWorldviewAgentDefinitions() {
  return [...canonicalWorldviewDefinitions];
}
export function listWorldviewAgentDefinitions() {
  return [...worldviewDefinitions];
}

const orderedDefinitions = [
  ...runAnalysisDefinitions,
  ...reportLibraryDefinitions,
  ...worldviewDefinitions,
  reportEditorAgent,
  reportTranslatorAgent,
  ideaRankingAgent,
  dealLadderRankingAgent,
  ideaGeneratorAgent,
  ideaQualityReviewerAgent,
  projectClassifierAgent,
];

export const agentRegistry = new AgentDefinitionRegistry(orderedDefinitions);

export function getAgentDefinition(id) {
  return agentRegistry.get(id);
}

export function listAgentDefinitions() {
  return agentRegistry.list();
}
