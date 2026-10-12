import { deepFreeze } from '../../../core/contracts/ArtifactRef.js';

export const SCORECARD_RUBRIC_VERSION = 'v3.1-en';
export const SCORECARD_LENSES = Object.freeze(['data', 'industry', 'company']);
export const SCORE_BPS_MAX = 10000;
export const SCORE_POINT_BPS = 100;

const QUALITY_BANDS = [
  { id: 'A', label: 'bench-quality', minimumScoreBps: 9000 },
  { id: 'B', label: 'professional', minimumScoreBps: 8000 },
  { id: 'C', label: 'usable with rework', minimumScoreBps: 7000 },
  { id: 'D', label: 'weak', minimumScoreBps: 6000 },
  { id: 'F', label: 'failed', minimumScoreBps: 0 },
];

const DATA_RUBRICS = [
  ['D-COV-01', 4, 'Prospectus, follow-on offering, or secondary-listing materials', 'Coverage of required materials'],
  ['D-COV-02', 5, 'Most recent four earnings-call transcripts', 'Coverage of required materials'],
  ['D-COV-03', 5, 'Five years of annual financial statements', 'Coverage of required materials'],
  ['D-COV-04', 4, 'Three years of quarterly income statements', 'Coverage of required materials'],
  ['D-COV-05', 4, 'Next-quarter and three-year forecasts', 'Coverage of required materials'],
  ['D-COV-06', 3, 'Five years of monthly share prices and major turning points', 'Coverage of required materials'],
  ['D-COV-07', 3, 'Sell-side and investment-bank research', 'Coverage of required materials'],
  ['D-COV-08', 2, 'Authoritative industry sources', 'Coverage of required materials'],
  ['D-COV-09', 2, 'Internal historical analogues', 'Coverage of required materials'],
  ['D-ACC-01', 5, 'Source hierarchy and credibility assessment', 'Accuracy, source quality, and fidelity of synthesis'],
  ['D-ACC-02', 8, 'Accuracy of numbers, dates, units, and conventions', 'Accuracy, source quality, and fidelity of synthesis'],
  ['D-ACC-03', 6, 'Completeness of material synthesis', 'Accuracy, source quality, and fidelity of synthesis'],
  ['D-ACC-04', 4, 'Cross-validation of material data', 'Accuracy, source quality, and fidelity of synthesis'],
  ['D-ACC-05', 5, 'Treatment of conflicts, revisions, and uncertainty', 'Accuracy, source quality, and fidelity of synthesis'],
  ['D-ORG-01', 4, 'Complete source index', 'File organization, indexing, and traceability'],
  ['D-ORG-02', 6, 'Source localization for material claims', 'File organization, indexing, and traceability'],
  ['D-ORG-03', 4, 'Source and confidence labels', 'File organization, indexing, and traceability'],
  ['D-ORG-04', 3, 'Separation of company, industry, and market views', 'File organization, indexing, and traceability'],
  ['D-ORG-05', 5, 'Compression and retrievability of the data summary', 'File organization, indexing, and traceability'],
  ['D-DEP-01', 5, 'Question-driven alternative evidence', 'Active research and information gain'],
  ['D-DEP-02', 4, 'Multi-source triangulation and proprietary datasets', 'Active research and information gain'],
  ['D-DEP-03', 3, 'Gap discovery and next-step search plan', 'Active research and information gain'],
  ['D-HOF-01', 4, 'Structure, conventions, and reusability', 'Downstream usability'],
  ['D-HOF-02', 2, 'Handoff summary and prioritization', 'Downstream usability'],
];

const INDUSTRY_RUBRICS = [
  ['I-DEF-01', 5, 'Industry boundary and statistical convention', 'Industry definition, concepts, and structure'],
  ['I-DEF-02', 4, 'Core concepts, products, and technical principles', 'Industry definition, concepts, and structure'],
  ['I-DEF-03', 4, 'Participants, subindustries, geographies, and value chain', 'Industry definition, concepts, and structure'],
  ['I-DEF-04', 2, 'Mapping to the target company', 'Industry definition, concepts, and structure'],
  ['I-DYN-01', 5, 'Historical development and industry “nature”', 'Historical development, industry dynamics, and key questions'],
  ['I-DYN-02', 5, 'Long-term and short-term drivers', 'Historical development, industry dynamics, and key questions'],
  ['I-DYN-03', 6, 'Constraints and genuinely key questions', 'Historical development, industry dynamics, and key questions'],
  ['I-DYN-04', 4, 'Industry dynamics and predictability', 'Historical development, industry dynamics, and key questions'],
  ['I-DYN-05', 5, 'Decomposition of key questions by 2–3 levels', 'Historical development, industry dynamics, and key questions'],
  ['I-NAR-01', 4, 'Mainstream narrative, provenance, and representativeness', 'Market-narrative validation and variant view'],
  ['I-NAR-02', 4, 'Narrative vulnerabilities, variables, and disconfirming evidence', 'Market-narrative validation and variant view'],
  ['I-NAR-03', 4, 'Agreement and disagreement with the market', 'Market-narrative validation and variant view'],
  ['I-COM-01', 5, 'Market-share definition, current structure, and estimation', 'Industry structure, share, and profit pool'],
  ['I-COM-02', 4, 'Historical share shifts and future migration', 'Industry structure, share, and profit pool'],
  ['I-COM-03', 5, 'Competitive intensity, supply-demand, and margin evolution', 'Industry structure, share, and profit pool'],
  ['I-ANA-01', 4, 'Analogue selection and comparability', 'Historical experience and cross-industry analogues'],
  ['I-ANA-02', 4, 'Generalization and limits of transfer', 'Historical experience and cross-industry analogues'],
  ['I-QNT-01', 4, 'Market size, segmentation, and convention bridge', 'Industry quantification and calculation workpapers'],
  ['I-QNT-02', 5, 'Workpaper reproducibility and calculation accuracy', 'Industry quantification and calculation workpapers'],
  ['I-QNT-03', 4, 'Scenarios, probabilities, and key-variable mapping', 'Industry quantification and calculation workpapers'],
  ['I-QNT-04', 5, 'Long-term ceiling, sensitivities, and cross-checks', 'Industry quantification and calculation workpapers'],
  ['I-REP-01', 3, 'Facts, inferences, hypotheses, and confidence', 'Industry-summary communication and epistemic calibration'],
  ['I-REP-02', 3, 'Report structure and conclusion closure', 'Industry-summary communication and epistemic calibration'],
  ['I-REP-03', 2, 'Clarity, plain language, and auditability', 'Industry-summary communication and epistemic calibration'],
];

const COMPANY_RUBRICS = [
  ['C-HIS-01', 4, 'Business and strategic history', 'Company history, strategy, and share-price evolution'],
  ['C-HIS-02', 2, 'Major historical share-price inflections', 'Company history, strategy, and share-price evolution'],
  ['C-HIS-03', 2, 'Parallel history of competitors', 'Company history, strategy, and share-price evolution'],
  ['C-MGT-01', 3, 'Core-team background and historical contribution', 'Management, governance, and capital allocation'],
  ['C-MGT-02', 3, 'Governance, incentives, and capital allocation', 'Management, governance, and capital allocation'],
  ['C-MGT-03', 2, 'Management style, credibility, and peer comparison', 'Management, governance, and capital allocation'],
  ['C-BIZ-01', 4, 'Products/services, customers, and use cases', 'Core products, competitive position, and business model'],
  ['C-BIZ-02', 5, 'Evidence for differentiation, strengths, and weaknesses', 'Core products, competitive position, and business model'],
  ['C-BIZ-03', 4, 'Business model and unit economics', 'Core products, competitive position, and business model'],
  ['C-BIZ-04', 2, 'Substitution, weaknesses, and competitive response', 'Core products, competitive position, and business model'],
  ['C-KEY-01', 5, 'Questions that genuinely determine value', 'Company key questions and original research'],
  ['C-KEY-02', 5, 'Logical development, iteration, and decomposition', 'Company key questions and original research'],
  ['C-KEY-03', 5, 'New research methods and incremental insight', 'Company key questions and original research'],
  ['C-MKT-01', 4, 'Accurate summary of different market constituencies', 'Market views, expectations, and variant view'],
  ['C-MKT-02', 3, 'Current financial-expectations and pricing baseline', 'Market views, expectations, and variant view'],
  ['C-MKT-03', 3, 'Variant view, catalysts, and falsifiers', 'Market views, expectations, and variant view'],
  ['C-MOD-01', 4, 'Historical financials and three-statement foundation', 'Financial model, operating drivers, and key-question linkage'],
  ['C-MOD-02', 5, 'Revenue-driver model', 'Financial model, operating drivers, and key-question linkage'],
  ['C-MOD-03', 4, 'Earnings, balance sheet, and cash flow', 'Financial model, operating drivers, and key-question linkage'],
  ['C-MOD-04', 4, 'Transmission from key questions to financial outcomes', 'Financial model, operating drivers, and key-question linkage'],
  ['C-MOD-05', 3, 'Scenarios, sensitivities, probabilities, and reproducibility', 'Financial model, operating drivers, and key-question linkage'],
  ['C-VAL-01', 4, 'Historical valuation and method selection', 'Valuation, trading price, and expectations gap'],
  ['C-VAL-02', 4, 'Forward quarterly forecasts and earnings bridge', 'Valuation, trading price, and expectations gap'],
  ['C-VAL-03', 4, 'Implied expectations, fair value, and expectations gap', 'Valuation, trading price, and expectations gap'],
  ['C-VAL-04', 4, 'Trading sentiment, time path, and price range', 'Valuation, trading price, and expectations gap'],
  ['C-REP-01', 3, 'Facts, inferences, hypotheses, and confidence', 'Company-summary communication, evidence, and epistemic calibration'],
  ['C-REP-02', 3, 'Report–evidence–model consistency', 'Company-summary communication, evidence, and epistemic calibration'],
  ['C-REP-03', 2, 'Clarity, plain language, risks, and unknowns', 'Company-summary communication, evidence, and epistemic calibration'],
];

const DATA_CAPS = [
  ['D-CAP-FABRICATION', 2000, 'Confirmed fabrication of files, sources, or material data', 'critical'],
  ['D-CAP-NO-SUMMARY', 4000, 'No final data-agent summary', 'major'],
  ['D-CAP-NO-INDEX-OR-WORKPAPERS', 5900, 'No source index and no usable structured workpapers', 'major'],
  ['D-CAP-TRANSCRIPTS-AND-FINANCIALS-MISSING', 4900, 'Latest four-quarter transcripts and five-year annual financials are materially missing', 'major'],
  ['D-CAP-TRACEABILITY-BELOW-60', 5900, 'Material-claim traceability is clearly below 60%', 'major'],
  ['D-CAP-MATERIAL-CONTRADICTION', 5900, 'A material summary–workpaper contradiction could change a major research judgment', 'critical'],
  ['D-CAP-COVERAGE-BELOW-70', 6900, 'Required-material coverage is clearly below 70%', 'major'],
];

const INDUSTRY_CAPS = [
  ['I-CAP-FABRICATION', 2000, 'Confirmed fabrication of sources, historical cases, or material data', 'critical'],
  ['I-CAP-BOUNDARY-WRONG', 3900, 'A fundamentally wrong industry boundary distorts market size or the competitive set', 'critical'],
  ['I-CAP-CORE-MECHANISM-WRONG', 4900, 'A wrong core technical or commercial mechanism could reverse the principal conclusion', 'critical'],
  ['I-CAP-NO-SUMMARY', 4900, 'No final industry summary', 'major'],
  ['I-CAP-MATERIAL-CONTRADICTIONS', 5900, 'At least two material summary–workpaper contradictions', 'major'],
  ['I-CAP-WORKPAPER-NOT-REPRODUCIBLE', 5900, 'Principal calculation workpapers cannot be reproduced', 'major'],
  ['I-CAP-NO-KEY-QUESTION', 6900, 'No genuinely key question; the work is primarily an industry introduction', 'major'],
  ['I-CAP-NO-QUANT-WORKPAPER', 6900, 'Quantification is appropriate but no valid workpaper or scenario analysis exists', 'major'],
];

const INDUSTRY_PROJECT_CAPS = [
  ['I-PROJECT-CAP-MISSING-GTE-25', 5900, 'Missing industries account for at least 25% of materiality weight', 'major'],
  ['I-PROJECT-CAP-MISSING-GTE-10', 6900, 'Missing industries account for 10% to 24.99% of materiality weight', 'major'],
  ['I-PROJECT-CAP-OPAQUE-WEIGHTS', 7900, 'Weights are opaque and no auditable equal-weight method is used', 'major'],
];

const COMPANY_CAPS = [
  ['C-CAP-FABRICATION', 2000, 'Confirmed fabrication of sources, market views, or historical model data', 'critical'],
  ['C-CAP-HISTORICALS-WRONG', 3900, 'Core historical financials are systematically wrong and could reverse conclusions', 'critical'],
  ['C-CAP-BUSINESS-MISUNDERSTOOD', 4900, 'The actual business or business model is fundamentally misunderstood', 'critical'],
  ['C-CAP-NO-SUMMARY', 4000, 'No final company summary', 'major'],
  ['C-CAP-NO-VALID-MODEL', 5900, 'No valid financial model or principal outputs cannot be reproduced', 'major'],
  ['C-CAP-MATERIAL-CONTRADICTIONS', 5900, 'At least two material report–model contradictions', 'major'],
  ['C-CAP-NO-KEY-QUESTIONS', 6900, 'No key questions; the work is primarily a company introduction', 'major'],
  ['C-CAP-NO-REVENUE-DRIVERS', 6900, 'Revenue is forecast only through uniform growth with no operating drivers', 'major'],
  ['C-CAP-NO-VALUATION', 6900, 'No valuation or the target price cannot be reproduced', 'major'],
  ['C-CAP-MATERIAL-INDUSTRY-OMITTED', 6900, 'The effect of a material industry on the company is omitted', 'major'],
];

const DATA_ERROR_TAGS = [
  'MISSING_REQUIRED_SOURCE', 'MISSING_PERIOD', 'SOURCE_UNVERIFIABLE', 'WRONG_NUMBER',
  'WRONG_PERIOD', 'WRONG_UNIT_OR_CURRENCY', 'GAAP_NON_GAAP_MIX', 'QUARTER_YTD_MIX',
  'EXTRACTION_OMISSION', 'CONFLICT_UNRESOLVED', 'ESTIMATE_PRESENTED_AS_FACT',
  'CONSENSUS_SNAPSHOT_MISSING', 'INDEX_INCOMPLETE', 'SUMMARY_WORKPAPER_MISMATCH',
  'NO_ACTIVE_DISCOVERY', 'FABRICATED_EVIDENCE',
];

const INDUSTRY_ERROR_TAGS = [
  'MATERIAL_INDUSTRY_MISSING', 'MATERIALITY_WEIGHT_UNCERTAIN', 'INDUSTRY_BOUNDARY_WRONG',
  'TAM_COMPANY_MARKET_CONFUSED', 'TECHNICAL_CONCEPT_WRONG', 'DRIVER_CAUSALITY_WEAK',
  'KEY_QUESTION_NOT_IDENTIFIED', 'KEY_QUESTION_NOT_DECOMPOSED', 'CONSENSUS_UNSOURCED',
  'VARIANT_VIEW_UNPROVEN', 'MARKET_SHARE_DEFINITION_WRONG', 'PROFIT_POOL_NOT_ANALYZED',
  'ANALOGY_INVALID', 'MODEL_INPUT_UNSOURCED', 'WORKPAPER_NOT_REPRODUCIBLE',
  'SCENARIO_MECHANICAL', 'SUMMARY_WORKPAPER_MISMATCH', 'FACT_INFERENCE_MIXED',
  'FABRICATED_EVIDENCE',
];

const COMPANY_ERROR_TAGS = [
  'COMPANY_HISTORY_INACCURATE', 'MANAGEMENT_EVIDENCE_WEAK', 'CAPITAL_ALLOCATION_NOT_TESTED',
  'PRODUCT_DEFINITION_WRONG', 'COMPETITIVE_ADVANTAGE_UNPROVEN', 'BUSINESS_MODEL_MISCLASSIFIED',
  'KEY_QUESTION_NOT_IDENTIFIED', 'KEY_QUESTION_NOT_DECOMPOSED', 'NO_ORIGINAL_RESEARCH',
  'MARKET_VIEW_UNSOURCED', 'SIMULATED_VIEW_AS_EMPIRICAL', 'CONSENSUS_SNAPSHOT_MISSING',
  'VARIANT_VIEW_UNPROVEN', 'HISTORICAL_ACTUAL_WRONG', 'REVENUE_DRIVER_MISSING',
  'MODEL_NOT_BALANCED', 'KEY_QUESTION_MODEL_DISCONNECTED', 'WORKPAPER_NOT_REPRODUCIBLE',
  'VALUATION_NOT_REPRODUCIBLE', 'PRICE_PATH_NOT_TIME_BOUND', 'INDUSTRY_COMPANY_MISMATCH',
  'SUMMARY_MODEL_MISMATCH', 'FACT_INFERENCE_MIXED', 'FABRICATED_EVIDENCE',
];

function rubrics(entries) {
  return entries.map(([id, weight, criterion, section]) => ({ id, weight, criterion, section }));
}

function caps(entries) {
  return entries.map(([id, maximumScoreBps, condition, defaultSeverity]) => ({
    id,
    maximumScoreBps,
    condition,
    defaultSeverity,
  }));
}

function spec(input) {
  const rubricIds = new Set(input.rubrics.map((item) => item.id));
  const weight = input.rubrics.reduce((sum, item) => sum + item.weight, 0);
  if (rubricIds.size !== input.rubrics.length || weight !== 100) {
    throw new TypeError(`Invalid ${input.lens} Scorecard inventory`);
  }
  return deepFreeze({
    rubricVersion: SCORECARD_RUBRIC_VERSION,
    qualityBands: QUALITY_BANDS,
    ...input,
  });
}

export const SCORECARD_SPECS = deepFreeze({
  data: spec({
    lens: 'data',
    unitKind: 'project',
    rubrics: rubrics(DATA_RUBRICS),
    caps: caps(DATA_CAPS),
    projectCaps: [],
    errorTags: DATA_ERROR_TAGS,
    requiredPassRubricIds: ['D-ACC-02', 'D-ORG-02', 'D-ORG-05'],
    nonZeroPassRubricIds: ['D-COV-02', 'D-COV-03', 'D-COV-04', 'D-COV-05'],
    allowNotApplicable: true,
  }),
  industry: spec({
    lens: 'industry',
    unitKind: 'industry',
    rubrics: rubrics(INDUSTRY_RUBRICS),
    caps: caps(INDUSTRY_CAPS),
    projectCaps: caps(INDUSTRY_PROJECT_CAPS),
    errorTags: INDUSTRY_ERROR_TAGS,
    requiredPassRubricIds: ['I-DEF-01', 'I-DYN-03', 'I-DYN-05', 'I-QNT-02'],
    nonZeroPassRubricIds: [],
    allowNotApplicable: false,
  }),
  company: spec({
    lens: 'company',
    unitKind: 'ticker',
    rubrics: rubrics(COMPANY_RUBRICS),
    caps: caps(COMPANY_CAPS),
    projectCaps: [],
    errorTags: COMPANY_ERROR_TAGS,
    requiredPassRubricIds: ['C-BIZ-02', 'C-KEY-01', 'C-KEY-02', 'C-MOD-02', 'C-MOD-04', 'C-VAL-03'],
    nonZeroPassRubricIds: [],
    allowNotApplicable: false,
  }),
});

const CAP_EVIDENCE_RULES = Object.freeze({
  'D-CAP-FABRICATION': { rubricIds: ['D-ACC-01', 'D-ACC-02', 'D-ACC-03'], tags: ['FABRICATED_EVIDENCE'] },
  'D-CAP-NO-SUMMARY': { rubricIds: ['D-HOF-02'], tags: ['MISSING_REQUIRED_SOURCE'] },
  'D-CAP-NO-INDEX-OR-WORKPAPERS': { rubricIds: ['D-ORG-01', 'D-ORG-02', 'D-HOF-01'], tags: ['INDEX_INCOMPLETE'] },
  'D-CAP-TRANSCRIPTS-AND-FINANCIALS-MISSING': { rubricIds: ['D-COV-02', 'D-COV-03', 'D-COV-04'], tags: ['MISSING_REQUIRED_SOURCE'] },
  'D-CAP-TRACEABILITY-BELOW-60': { rubricIds: ['D-ORG-02'], tags: ['SOURCE_UNVERIFIABLE'] },
  'D-CAP-MATERIAL-CONTRADICTION': { rubricIds: ['D-ACC-05', 'D-ORG-05'], tags: ['SUMMARY_WORKPAPER_MISMATCH', 'CONFLICT_UNRESOLVED'] },
  'D-CAP-COVERAGE-BELOW-70': { rubricIds: ['D-COV-01', 'D-COV-02', 'D-COV-03'], tags: ['MISSING_REQUIRED_SOURCE'] },
  'I-CAP-FABRICATION': { rubricIds: ['I-REP-01', 'I-QNT-02'], tags: ['FABRICATED_EVIDENCE'] },
  'I-CAP-BOUNDARY-WRONG': { rubricIds: ['I-DEF-01', 'I-COM-01'], tags: ['INDUSTRY_BOUNDARY_WRONG'] },
  'I-CAP-CORE-MECHANISM-WRONG': { rubricIds: ['I-DEF-02', 'I-DYN-03'], tags: ['TECHNICAL_CONCEPT_WRONG'] },
  'I-CAP-NO-SUMMARY': { rubricIds: ['I-REP-02'], tags: ['MATERIAL_INDUSTRY_MISSING'] },
  'I-CAP-MATERIAL-CONTRADICTIONS': { rubricIds: ['I-REP-01', 'I-QNT-02'], tags: ['SUMMARY_WORKPAPER_MISMATCH'] },
  'I-CAP-WORKPAPER-NOT-REPRODUCIBLE': { rubricIds: ['I-QNT-02'], tags: ['WORKPAPER_NOT_REPRODUCIBLE'] },
  'I-CAP-NO-KEY-QUESTION': { rubricIds: ['I-DYN-03', 'I-DYN-05'], tags: ['KEY_QUESTION_NOT_IDENTIFIED'] },
  'I-CAP-NO-QUANT-WORKPAPER': { rubricIds: ['I-QNT-01', 'I-QNT-02'], tags: ['WORKPAPER_NOT_REPRODUCIBLE'] },
  'I-PROJECT-CAP-MISSING-GTE-25': { rubricIds: ['I-REP-02'], tags: ['MATERIAL_INDUSTRY_MISSING'] },
  'I-PROJECT-CAP-MISSING-GTE-10': { rubricIds: ['I-REP-02'], tags: ['MATERIAL_INDUSTRY_MISSING'] },
  'I-PROJECT-CAP-OPAQUE-WEIGHTS': { rubricIds: ['I-QNT-02'], tags: ['MATERIALITY_WEIGHT_UNCERTAIN'] },
  'C-CAP-FABRICATION': { rubricIds: ['C-REP-01', 'C-MOD-03'], tags: ['FABRICATED_EVIDENCE'] },
  'C-CAP-HISTORICALS-WRONG': { rubricIds: ['C-MOD-01', 'C-MOD-03'], tags: ['HISTORICAL_ACTUAL_WRONG'] },
  'C-CAP-BUSINESS-MISUNDERSTOOD': { rubricIds: ['C-BIZ-01', 'C-BIZ-03'], tags: ['PRODUCT_DEFINITION_WRONG', 'BUSINESS_MODEL_MISCLASSIFIED'] },
  'C-CAP-NO-SUMMARY': { rubricIds: ['C-REP-01'], tags: ['SUMMARY_MODEL_MISMATCH'] },
  'C-CAP-NO-VALID-MODEL': { rubricIds: ['C-MOD-02', 'C-MOD-03'], tags: ['MODEL_NOT_BALANCED', 'WORKPAPER_NOT_REPRODUCIBLE'] },
  'C-CAP-MATERIAL-CONTRADICTIONS': { rubricIds: ['C-REP-02', 'C-MOD-04'], tags: ['SUMMARY_MODEL_MISMATCH'] },
  'C-CAP-NO-KEY-QUESTIONS': { rubricIds: ['C-KEY-01', 'C-KEY-02'], tags: ['KEY_QUESTION_NOT_IDENTIFIED'] },
  'C-CAP-NO-REVENUE-DRIVERS': { rubricIds: ['C-MOD-02'], tags: ['REVENUE_DRIVER_MISSING'] },
  'C-CAP-NO-VALUATION': { rubricIds: ['C-VAL-03'], tags: ['VALUATION_NOT_REPRODUCIBLE'] },
  'C-CAP-MATERIAL-INDUSTRY-OMITTED': { rubricIds: ['C-REP-02'], tags: ['INDUSTRY_COMPANY_MISMATCH'] },
});

export function capEvidenceRuleFor(lens, capId) {
  const specValue = getScorecardSpec(lens);
  const allowed = [...specValue.caps, ...specValue.projectCaps].some((cap) => cap.id === capId);
  if (!allowed) return null;
  return CAP_EVIDENCE_RULES[capId] || null;
}

export function getScorecardSpec(lens) {
  const specValue = SCORECARD_SPECS[String(lens || '')];
  if (!specValue) throw new TypeError(`Unknown Scorecard lens: ${lens || '(missing)'}`);
  return specValue;
}
