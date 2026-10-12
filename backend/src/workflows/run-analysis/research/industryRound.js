import { industryAnalysisAgent } from './analysisSubAgents.js';

export async function runIndustryRound({ projectId, round = 1, dataRound = round, theme, brief = '', dataContext, guidance, relatedFindings, depth = null }) {
  return { industry: await industryAnalysisAgent({ theme, brief, dataContext, guidance, relatedFindings, projectId, round, dataRound, depth }) };
}
