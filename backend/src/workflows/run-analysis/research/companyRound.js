import { companyAnalysisAgent } from './analysisSubAgents.js';

export async function runCompanyRound({ projectId, round = 1, dataRound = round, tickers = [], comparisonTickers = [], theme, brief = '', dataContext, guidance, depth = null }) {
  const compSet = new Set(comparisonTickers.map((ticker) => String(ticker).toUpperCase()));
  const companies = await Promise.all(tickers.map((ticker) => companyAnalysisAgent({
    ticker,
    theme,
    brief,
    dataContext,
    guidance,
    projectId,
    round,
    dataRound,
    depth,
    role: compSet.has(String(ticker).toUpperCase()) ? 'comparison' : 'primary',
    promoted: compSet.has(String(ticker).toUpperCase()),
  })));
  return { companies };
}
