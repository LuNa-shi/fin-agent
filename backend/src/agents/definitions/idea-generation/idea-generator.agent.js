import { defineAgent } from '../../defineAgent.js';

const array = (value) => Array.isArray(value) ? value : [];

const prompt = (input = {}) => {
  const poolTarget = input.poolTarget;
  const market = input.market || {};
  const research = array(market.research);
  const saIdeas = array(market.saIdeas);
  const sourceCandidates = array(input.sourceCandidates);
  const heldThemes = array(input.heldThemes);
  const heavyThemes = array(input.heavyThemes);
  const existingTitles = array(input.existingTitles);
  const top = array(market.top);
  const bottom = array(market.bottom);
  const sectorTable = array(market.sectorTable);
  const headlines = array(market.headlines);
  const domainsUsed = array(market.domainsUsed);
  const researchBlock = research.slice(0, 16)
    .map((r, i) => `${i + 1}. [${r.source}] ${r.title}${r.tickers?.length ? ` ($${r.tickers.join(',$')})` : ''}${r.summary ? ` — ${r.summary}` : ''}`)
    .join('\n');
  const saBlock = saIdeas.slice(0, 30)
    .map((s) => `$${s.ticker} ${s.title}`).join('\n');

  return {
    system: `You are the investment-idea generation agent. From live market signals, industry trends, and past decisions, generate ${poolTarget} DIFFERENTIATED candidate investment ideas (over-generate; a QC pass will select the best later).

<output_format>
Output STRICTLY JSON: {ideas:[{title, theme, heat(0-100), rationale, tickers:[], catalyst, edge, titleZh, rationaleZh, catalystZh, edgeZh}]}.
title/theme/rationale/catalyst/edge MUST be in ENGLISH — these are the canonical fields that seed downstream research projects whose primary sources (filings, transcripts, sell-side research) are English; English keeps the whole pipeline faithful.
titleZh/rationaleZh/catalystZh/edgeZh are Chinese translations of the same content, used ONLY for UI display — faithful, natural Chinese, same substance.
</output_format>

<rules>
- title: specific and actionable, one sentence. theme: a concise industry/theme word (e.g. "semiconductors", "power", "healthcare", "financials", "industrials", "commodities", "software").
- catalyst: the near-term event that would make this idea pay off. edge: the variant perception vs market consensus (MUST be substantive — vague edges are culled by QC).
- tickers MUST be valid symbols resolvable on FMP (US-listed focus): NYSE/NASDAQ symbols or liquid US ADRs (e.g. TSM, ASML, SONY). NEVER output "CompanyName_localcode" concatenations (e.g. MediaTek_2454), bare company names, or invented symbols. If a key player is only listed overseas with no US ADR, note that in rationale instead of forcing a ticker (the system validates and drops unresolvable symbols).
- Coverage (IMPORTANT): span multiple distinct industries/themes; do NOT cluster in one lane. Include at least 1 contrarian/overlooked idea.
- The research flow and the SA wide idea pool are seeds: refine differentiated angles from them, or propose an expectation gap against their consensus. If an idea derives directly from a source, append "(ref: source name)" at the end of rationale.
- Avoid duplicating existing holdings/ideas, especially the "over-concentrated themes" listed below; apply past reflection lessons to avoid repeating the same biases.
</rules>`,
    user: `# Decision context
## Live market signals
Leading sectors: ${top.join(', ') || '(n/a)'}
Lagging sectors: ${bottom.join(', ') || '(n/a)'}
Full sector rotation: ${sectorTable.join(' | ') || '(n/a)'}
Recent market headlines: ${headlines.slice(0, 8).map((h) => `"${h}"`).join('; ') || '(n/a)'}

## Analyst / industry-blogger research flow (stratified cross-domain sample: ${domainsUsed.join('/') || '—'})
${researchBlock || '(no research flow available)'}

## Seeking Alpha wide idea pool (what experts are writing about lately — use to widen the ticker universe and as contrarian reference)
${saBlock || '(n/a)'}

## Candidates already surfaced by multi-source agents (absorb, dedupe, rewrite into clearer one-sentence opportunities)
${sourceCandidates.slice(0, 24).map((i, idx) => `${idx + 1}. [${array(i.sourceAgents).join('+')}] ${i.sentence || i.title}${i.tickers?.length ? ` ($${i.tickers.join(',$')})` : ''} | catalyst: ${i.catalyst || '—'} | edge: ${i.edge || '—'}`).join('\n') || '(no source-agent candidates)'}

## History & holdings
Current holding themes: ${heldThemes.join(', ') || 'none'}
⚠️ Over-concentrated themes (do NOT add more; diversify elsewhere): ${heavyThemes.join(', ') || 'none'}
Recently generated ideas (do NOT duplicate): ${existingTitles.slice(0, 15).join(' / ') || 'none'}

Generate ${poolTarget} candidate investment ideas — multi-industry, differentiated, actionable, with resolvable tickers. ALL free-text in ENGLISH.`,
  };
};

export const ideaGeneratorAgent = defineAgent({
  id: 'idea-generator',
  version: '1.0.1',
  domain: 'idea-generation',
  purpose: 'Generate a differentiated over-complete investment idea candidate pool from gathered context.',
  visibility: { catalog: 'internal', workflows: ['idea-generation.v1', 'idea-generation.v2'] },
  executionMode: 'json',
  prompt,
  inputSchema: 'idea-generator.input.v1',
  outputSchema: 'ideaArtifact.v1',
  contextPolicy: { mounts: [], artifactSelectors: [], maxInlineTokens: 24000, allowPriorReview: false, allowCrossProjectRead: false },
  toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
  modelPolicy: { tier: 'main', preferredProviders: ['openai-compatible'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 3, deadlineMs: 900000, tokenBudget: 180000, toolCallBudget: 0, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: [], hardChecks: ['output-schema'], gracefulFinalize: true },
  artifactAuthority: 'return',
  outputPaths: [],
  source: 'workflows/idea-generation/ideaSystem.js#generate',
  inRunAnalysis: false,
});
