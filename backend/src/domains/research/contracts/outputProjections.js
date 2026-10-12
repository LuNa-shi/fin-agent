import { canonicalSha256 } from '../../../core/contracts/ArtifactRef.js';

const EXPOSURES = new Set(['positive', 'negative', 'mixed', 'none']);
const SEVERITIES = new Set(['info', 'warning', 'critical']);

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];
const strings = (value) => array(value).map((item) => String(item || '').trim()).filter(Boolean);
const dataStrings = (value, preferredFields = []) => array(value).map((item) => {
  if (typeof item === 'string') return item.trim();
  const entry = object(item);
  for (const field of preferredFields) {
    if (entry[field] !== undefined && entry[field] !== null) return text(entry[field]).trim();
  }
  return text(item).trim();
}).filter(Boolean);
const text = (value, fallback = '') => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value !== undefined && value !== null && typeof value !== 'object') return String(value);
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value); } catch {}
  }
  return fallback;
};
const structured = (value, fallback = {}) => object(value) === value ? value : fallback;
const clamp01 = (value, fallback = 0.5) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : fallback;
};

function provenance(request, producer, raw) {
  return {
    schemaVersion: '1.0.0',
    asOf: request.asOf,
    producer,
    contractVersion: request.contractVersion,
    inputDigest: canonicalSha256(request.input),
    createdAt: request.asOf,
    evidenceRefs: strings(raw.evidenceRefs),
  };
}

function normalizeDriverBridge(value) {
  return array(value).map((entry, index) => {
    const item = object(entry);
    return {
      industryDriverId: text(item.industryDriverId || item.driverId || item.driver, `industry-driver-${index + 1}`),
      companyExposure: EXPOSURES.has(item.companyExposure) ? item.companyExposure : 'mixed',
      mechanism: text(item.mechanism, 'Mechanism requires explicit verification.'),
      companyKpis: strings(item.companyKpis || item.kpis),
      financialLineItems: strings(item.financialLineItems || item.lineItems),
      valuationImpact: text(item.valuationImpact, 'Valuation impact requires explicit verification.'),
      evidenceRefs: strings(item.evidenceRefs || item.evidence),
      confidence: clamp01(item.confidence),
    };
  });
}

function normalizeAssumptionConflicts(value, ticker) {
  const entries = Array.isArray(value) ? value : (value ? [value] : []);
  return entries.map((entry, index) => {
    const item = typeof entry === 'string' ? { message: entry } : object(entry);
    return {
      id: text(item.id, `${ticker || 'company'}-assumption-conflict-${index + 1}`),
      message: text(item.message || item.conflict, 'Industry and company assumptions conflict.'),
      industryAssumption: text(item.industryAssumption),
      companyAssumption: text(item.companyAssumption),
      evidenceRefs: strings(item.evidenceRefs || item.evidence),
      severity: SEVERITIES.has(item.severity) ? item.severity : 'critical',
    };
  });
}

function reviewerTypeFor(contract) {
  const reviewerType = ({
    'evidence-reviewer': 'evidence',
    'requirement-reviewer': 'requirements',
    'logic-reviewer': 'logic',
  })[contract?.id];
  if (!reviewerType) throw new TypeError(`Unsupported ReviewResult producer: ${contract?.id || 'missing'}`);
  return reviewerType;
}

function normalizedReviewVerdict(verdict, issues) {
  if (verdict !== 'human-review') return verdict;
  const severities = array(issues).map((issue) => object(issue).severity);
  if (severities.includes('critical')) return 'human-review';
  if (severities.includes('warning')) return 'remediate';
  return 'pass';
}

export function projectReviewResultOutput(rawOutput, { request, contract } = {}) {
  if (!request) throw new TypeError('ReviewResult output projection requires AgentRunRequest');
  if (!contract?.id) throw new TypeError('ReviewResult output projection requires AgentContract');
  const raw = object(rawOutput);
  return {
    ...provenance(request, contract.id, raw),
    inputDigest: typeof request.input?.inputDigest === 'string'
      ? request.input.inputDigest
      : canonicalSha256(request.input),
    reviewerType: reviewerTypeFor(contract),
    score: raw.score,
    issues: raw.issues,
    verdict: normalizedReviewVerdict(raw.verdict, raw.issues),
  };
}

export function projectDataOrchestratorOutput(rawOutput, { request } = {}) {
  if (!request) throw new TypeError('Data Orchestrator output projection requires AgentRunRequest');
  const raw = object(rawOutput);
  return {
    ...provenance(request, 'data-orchestrator', raw),
    organized: array(raw.organized).map((entry, index) => {
      const group = object(entry);
      return {
        ...group,
        dimension: text(group.dimension, `dimension-${index + 1}`),
        points: array(group.points).map((point) => object(point)),
      };
    }),
    sourceQuality: array(raw.sourceQuality).map((entry) => object(entry)),
    contradictions: array(raw.contradictions).map((entry) => object(entry)),
    gaps: dataStrings(raw.gaps, ['message', 'gap', 'description', 'question', 'requestedAction']),
    nextDataFocus: {
      questions: dataStrings(object(raw.nextDataFocus).questions, ['question', 'message', 'gap', 'description']),
      tickers: strings(object(raw.nextDataFocus).tickers).map((ticker) => ticker.toUpperCase()),
      tools: strings(object(raw.nextDataFocus).tools),
    },
    competitorDossier: {
      competitors: dataStrings(object(raw.competitorDossier).competitors, ['name', 'ticker', 'symbol', 'company', 'competitor']),
      items: array(object(raw.competitorDossier).items).map((entry) => object(entry)),
    },
  };
}

export function projectIndustryAnalysisOutput(rawOutput, { request } = {}) {
  if (!request) throw new TypeError('IndustryAnalysis output projection requires AgentRunRequest');
  const raw = object(rawOutput);
  const drivers = array(raw.industryDrivers).length ? array(raw.industryDrivers) : array(raw.drivers);
  const evidenceGaps = strings(raw.evidenceGaps || raw.openQuestions);
  const industryMainline = text(raw.industryMainline || raw.consensusView, 'Consensus view is not yet established.');
  const variantPerception = text(raw.variantPerception || raw.variantView, 'No defensible variant view is established.');
  const keyExternalDrivers = text(raw.keyExternalDrivers, drivers.map((item) => text(object(item).driver || object(item).name)).filter(Boolean).join('; ') || 'Key external drivers require verification.');
  const demandSupplyMap = raw.demandSupplyMap ?? raw.valueChain ?? 'Demand, supply, and value-chain ownership require verification.';
  const competition = raw.competition ?? object(raw.peerEconomics).competition ?? '';
  const valuationExpectationMatrix = raw.valuationExpectationMatrix ?? object(raw.peerEconomics).valuationExpectationMatrix ?? 'Market-implied expectations require verification.';
  return {
    ...provenance(request, 'industry-analyst', raw),
    structuralView: text(raw.structuralView, 'Industry structure requires additional evidence.'),
    industryDrivers: drivers,
    valueChain: structured(raw.valueChain, { demandSupplyMap, competition, crossIndustry: raw.crossIndustry ?? '' }),
    peerEconomics: structured(raw.peerEconomics, { competition, valuationExpectationMatrix, segments: array(raw.segments) }),
    consensusView: text(raw.consensusView, industryMainline),
    variantView: text(raw.variantView, variantPerception),
    risks: array(raw.risks),
    openQuestions: strings(raw.openQuestions || raw.evidenceGaps),
    marketSize: text(raw.marketSize, 'Market size requires verification.'),
    industryMainline,
    keyExternalDrivers,
    demandSupplyMap,
    drivers,
    competition,
    crossIndustry: raw.crossIndustry ?? '',
    valuationExpectationMatrix,
    evidenceGaps,
    inflection: raw.inflection ?? '',
    surprises: array(raw.surprises),
    variantPerception,
    segments: array(raw.segments),
  };
}

export function projectCompanyAnalysisOutput(rawOutput, { request } = {}) {
  if (!request) throw new TypeError('CompanyAnalysis output projection requires AgentRunRequest');
  const raw = object(rawOutput);
  const ticker = text(raw.ticker || request.input?.ticker, 'UNKNOWN').toUpperCase();
  const risks = array(raw.risks);
  const evidenceGaps = strings(raw.evidenceGaps || raw.openQuestions);
  const positioning = text(raw.positioning, text(object(raw.businessModel).core, 'Positioning requires verification.'));
  const quality = text(raw.quality, text(object(raw.financialQuality).summary, 'Financial quality requires verification.'));
  const valuation = structured(raw.valuation, {
    summary: text(raw.valuation, 'Valuation requires verification.'),
    impliedExpectations: text(raw.impliedExpectations, 'Market-implied expectations require verification.'),
    sotp: raw.sotp ?? null,
  });
  const projectedInvalidation = dataStrings(raw.invalidation);
  const invalidation = projectedInvalidation.length ? projectedInvalidation : dataStrings(risks);
  return {
    ...provenance(request, 'company-analyst', raw),
    ticker,
    businessModel: structured(raw.businessModel, {
      positioning,
      growth: text(raw.growth),
      customerMap: text(raw.customerMap),
      orderSwitching: text(raw.orderSwitching),
      moatThreat: text(raw.moatThreat),
    }),
    driverBridge: normalizeDriverBridge(raw.driverBridge),
    financialQuality: structured(raw.financialQuality, {
      summary: quality,
      management: text(raw.management),
      marketPerformance: text(raw.marketPerformance),
    }),
    valuation,
    catalysts: array(raw.catalysts),
    risks,
    invalidation,
    assumptionConflicts: normalizeAssumptionConflicts(raw.assumptionConflicts || raw.assumptionConflict, ticker),
    positioning,
    growth: text(raw.growth),
    quality,
    impliedExpectations: text(raw.impliedExpectations, text(valuation.impliedExpectations, 'Market-implied expectations require verification.')),
    customerMap: text(raw.customerMap, 'Customer and value-chain attribution require verification.'),
    orderSwitching: text(raw.orderSwitching, 'Switching and substitution risk require verification.'),
    moatThreat: text(raw.moatThreat),
    management: text(raw.management),
    marketPerformance: text(raw.marketPerformance),
    evidenceGaps,
    surprises: array(raw.surprises),
    variantPerception: text(raw.variantPerception),
    sotp: raw.sotp ?? null,
    verdict: text(raw.verdict, 'Data insufficient; company judgment is inconclusive.'),
    conviction: clamp01(raw.conviction),
  };
}

export function companyAssumptionConflictIssues(companies = []) {
  return array(companies).flatMap((company) => array(company?.assumptionConflicts).map((conflict, index) => ({
    id: text(conflict?.id, `${company?.ticker || 'company'}-assumption-conflict-${index + 1}`),
    severity: SEVERITIES.has(conflict?.severity) ? conflict.severity : 'critical',
    owner: 'company',
    location: `analysis/company.json:${company?.ticker || 'UNKNOWN'}`,
    message: text(conflict?.message, 'Industry and company assumptions conflict.'),
    evidenceRefs: strings(conflict?.evidenceRefs),
    remediation: `Resolve the Industry/Company assumption conflict for ${company?.ticker || 'the company'} and update DriverBridge evidence.`,
  })));
}
