// Authoritative tool catalog: registration metadata and executors only.
// Agent-specific permission policies stay in Agent definitions.
import * as fmp from './fmp.js';
import { pplxSearch, pplxFinance, pplxAskPage, pplxSec, pplxReason, pplxDeepResearch } from './perplexity.js';
import { tavilySearch, tavilyExtract } from './tavily.js';
import * as research from './research.js';
import * as edgar from './edgar.js';
import { fredSeries } from './fred.js';
import * as workspace from '../project-space/projectTools.js';
import { runWorldviewCapabilityTool } from '../domains/worldview/canonical/WorldviewCapabilityScope.js';
import { ToolRegistry } from '../core/tools/ToolRegistry.js';

const NUMBER_PARAMS = new Set(['days', 'limit', 'marketCapMoreThan', 'maxResults', 'offset', 'quarter', 'year']);
const BOOLEAN_PARAMS = new Set(['includeX', 'replaceAll']);
const ENUM_PARAMS = {
  interval: ['5min', '15min', '30min', '1hour'],
  kind: ['gainers', 'losers', 'actives'],
  section: ['risk', 'mdna', 'legal'],
};
const MODEL_REQUIRED_BY_TOOL = {
  edgar_section: ['url'],
  ws_edit_file: ['oldText'],
  worldview_read_current: ['scopeId'],
  worldview_enumerate_overviews: ['scopeId'],
  worldview_read_report_version: ['scopeId', 'reportVersionId'],
  worldview_search_claims: ['scopeId'],
};
const WRITE_TOOLS = new Set(['project_write_current_file', 'project_append_current_file', 'ws_write_file', 'ws_append_file', 'ws_edit_file']);
const FILE_PATH_TOOLS = new Set(['project_read_file', 'project_write_current_file', 'project_append_current_file', 'ws_read_file', 'ws_write_file', 'ws_append_file', 'ws_edit_file']);
const CURRENT_PROJECT_TOOLS = new Set(['project_write_current_file', 'project_append_current_file', 'ws_write_file', 'ws_append_file', 'ws_edit_file']);
const EXPLICIT_PROJECT_READ_TOOLS = new Set(['project_read_file', 'ws_list_files', 'ws_read_file']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function paramType(param) {
  if (BOOLEAN_PARAMS.has(param.name)) return 'boolean';
  if (NUMBER_PARAMS.has(param.name)) return 'number';
  return 'string';
}

function typedDefault(param, type) {
  if (param.default === undefined) return undefined;
  if (type === 'number') return Number(param.default);
  if (type === 'boolean') return String(param.default).toLowerCase() === 'true';
  return String(param.default);
}

function inputSchemaForParams(params = [], requiredParams = []) {
  const required = new Set(requiredParams);
  const properties = {};
  for (const param of params) {
    const type = paramType(param);
    const property = { type };
    if (param.label) property.description = param.label;
    const defaultValue = typedDefault(param, type);
    if (defaultValue !== undefined) property.default = defaultValue;
    if (ENUM_PARAMS[param.name]) property.enum = [...ENUM_PARAMS[param.name]];
    if (type === 'string' && required.has(param.name)) property.minLength = 1;
    properties[param.name] = property;
  }
  return { type: 'object', additionalProperties: false, required: [...requiredParams], properties };
}

function effectFor(name, definition) {
  const writes = WRITE_TOOLS.has(name);
  const workspaceTool = definition.provider === 'workspace';
  const internalTool = workspaceTool || definition.provider === 'worldview';
  const projectScope = !workspaceTool ? 'none' : (CURRENT_PROJECT_TOOLS.has(name) ? 'current' : 'cross-project');
  const projectAccess = !workspaceTool
    ? 'none'
    : (writes ? 'current-project-write' : (EXPLICIT_PROJECT_READ_TOOLS.has(name) ? 'project-file-read' : 'project-library-read'));
  return {
    type: writes ? 'write' : 'read',
    retrieval: { external: !internalTool, provider: definition.provider },
    project: {
      scope: projectScope,
      access: projectAccess,
      identityParams: (definition.params || [])
        .map((param) => param.name)
        .filter((param) => param === 'currentProjectId' || param === 'projectId'),
    },
    path: FILE_PATH_TOOLS.has(name)
      ? { param: 'file', kind: 'project-file', writablePrefixes: writes ? ['data/', 'analysis/', 'report/'] : [] }
      : { param: null, kind: null },
  };
}

function withContract([name, definition]) {
  return [name, {
    ...definition,
    inputSchema: inputSchemaForParams(definition.params || [], MODEL_REQUIRED_BY_TOOL[name] || []),
    effect: effectFor(name, definition),
  }];
}

export class ToolInputError extends Error {
  constructor(toolName, issues) {
    super(`Invalid tool input for ${toolName}: ${issues.map((issue) => `${issue.path}:${issue.code}`).join(', ')}`);
    this.name = 'ToolInputError';
    this.code = 'TOOL_INPUT_INVALID';
    this.toolName = toolName;
    this.issues = issues.map((issue) => Object.freeze({ ...issue }));
  }
}

function issue(path, code, message, extra = {}) {
  return { path, code, message, ...extra };
}

function coerceValue(path, spec, value, issues) {
  if (spec.type === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    issues.push(issue(path, 'type', `${path} must be a number`, { expected: 'number' }));
    return undefined;
  }
  if (spec.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
    if (value === 1 || value === 0) return value === 1;
    issues.push(issue(path, 'type', `${path} must be a boolean`, { expected: 'boolean' }));
    return undefined;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  issues.push(issue(path, 'type', `${path} must be a string`, { expected: 'string' }));
  return undefined;
}

function runtimeIdentityParamsForTool(tool) {
  return tool.effect?.project?.identityParams || [];
}

function validateStringConstraints(path, spec, value, issues) {
  if (spec.type !== 'string' || typeof value !== 'string') return true;
  if (spec.minLength != null && value.length < spec.minLength) {
    issues.push(issue(path, 'minLength', `${path} must be at least ${spec.minLength} character(s)`, { minLength: spec.minLength }));
    return false;
  }
  if (spec.maxLength != null && value.length > spec.maxLength) {
    issues.push(issue(path, 'maxLength', `${path} must be at most ${spec.maxLength} character(s)`, { maxLength: spec.maxLength }));
    return false;
  }
  return true;
}

export function coerceToolInputForTool(toolName, tool, args = {}, options = {}) {
  const schema = tool.inputSchema || inputSchemaForParams(tool.params || []);
  const issues = [];
  const input = args;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ToolInputError(toolName, [issue('', 'type', 'tool input must be an object', { expected: 'object' })]);
  }
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  const requiredForCall = new Set(schema.required || []);
  if (options.requireRuntimeIdentity) {
    for (const key of runtimeIdentityParamsForTool(tool)) requiredForCall.add(key);
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(properties, key)) issues.push(issue(key, 'unknown', `${key} is not allowed`));
  }

  const output = {};
  for (const [key, spec] of Object.entries(properties)) {
    const hasValue = Object.hasOwn(input, key);
    const raw = input[key];
    if (!hasValue || raw == null) {
      if (requiredForCall.has(key)) issues.push(issue(key, 'required', `${key} is required`));
      else if (Object.hasOwn(spec, 'default')) output[key] = clone(spec.default);
      continue;
    }
    if (requiredForCall.has(key) && typeof raw === 'string' && raw.trim() === '') {
      issues.push(issue(key, 'required', `${key} is required`));
      continue;
    }
    if (raw === '' && !required.has(key)) {
      if (Object.hasOwn(spec, 'default')) output[key] = clone(spec.default);
      continue;
    }
    const value = coerceValue(key, spec, raw, issues);
    if (value === undefined) continue;
    if (!validateStringConstraints(key, spec, value, issues)) continue;
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      issues.push(issue(key, 'enum', `${key} must be one of: ${spec.enum.join(', ')}`, { allowed: [...spec.enum] }));
      continue;
    }
    output[key] = value;
  }

  if (issues.length) throw new ToolInputError(toolName, issues);
  return output;
}

export function validateRunToolInput(name, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolInputError(name, [issue('', 'type', 'tool input must be an object', { expected: 'object' })]);
  }
  const { forceRefresh, ...toolArgs } = args;
  let shouldForceRefresh = false;
  if (Object.hasOwn(args, 'forceRefresh')) {
    if (typeof forceRefresh === 'boolean') shouldForceRefresh = forceRefresh;
    else if (typeof forceRefresh === 'string' && /^(true|false)$/i.test(forceRefresh.trim())) shouldForceRefresh = forceRefresh.trim().toLowerCase() === 'true';
    else throw new ToolInputError(name, [issue('forceRefresh', 'type', 'forceRefresh must be a boolean', { expected: 'boolean' })]);
  }
  return { args: coerceToolInputForTool(name, toolRegistry.get(name), toolArgs, { requireRuntimeIdentity: true }), forceRefresh: shouldForceRefresh };
}

// Each registration contains display metadata, test-form parameters, and its raw executor.
const TOOL_REGISTRATIONS = [
  // ---- FMP ----
  ['fmp_quote', { provider: 'fmp', group: '行情/基本面', desc: '实时行情（价格/涨跌/市值/PE）', params: [{ name: 'symbol', label: '标的', default: 'NVDA' }], run: (a) => fmp.getQuote(a.symbol) }],
  ['fmp_profile', { provider: 'fmp', group: '行情/基本面', desc: '公司基本面画像（行业/简介）', params: [{ name: 'symbol', label: '标的', default: 'NVDA' }], run: (a) => fmp.getProfile(a.symbol) }],
  ['fmp_transcript', { provider: 'fmp', group: '财报', desc: '财报电话会议纪要全文', params: [{ name: 'symbol', default: 'AAPL' }, { name: 'quarter', label: '季度', default: '1' }, { name: 'year', label: '年份', default: '2025' }], run: (a) => fmp.getTranscript(a.symbol, { quarter: a.quarter, year: a.year }) }],
  ['fmp_peers', { provider: 'fmp', group: '可比公司', desc: '可比公司列表（comps）', params: [{ name: 'symbol', default: 'AAPL' }], run: (a) => fmp.getPeers(a.symbol) }],
  ['fmp_comps', { provider: 'fmp', group: '可比公司', desc: '同业对比表（peers 各自估值/增速/利润率）', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getComps(a.symbol) }],
  ['fmp_valuation_history', { provider: 'fmp', group: '估值', desc: '历史估值分位（近 5 年季度 PE/PS 区间）', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getValuationHistory(a.symbol) }],
  ['fmp_news', { provider: 'fmp', group: '新闻', desc: '标的相关新闻流', params: [{ name: 'tickers', label: '标的(逗号)', default: 'NVDA,AMD' }, { name: 'limit', default: '6' }], run: (a) => fmp.getNews((a.tickers || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean), Number(a.limit) || 6) }],
  ['fmp_ratios', { provider: 'fmp', group: '估值', desc: '财务比率 TTM', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getRatios(a.symbol) }],
  ['fmp_key_metrics', { provider: 'fmp', group: '估值', desc: '关键指标 TTM', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getKeyMetrics(a.symbol) }],
  ['fmp_price_target', { provider: 'fmp', group: '分析师', desc: '分析师目标价汇总', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getPriceTarget(a.symbol) }],
  ['fmp_estimates', { provider: 'fmp', group: '分析师', desc: '分析师营收/利润预期', params: [{ name: 'symbol', default: 'NVDA' }, { name: 'limit', default: '4' }], run: (a) => fmp.getAnalystEstimates(a.symbol, Number(a.limit) || 4) }],
  ['fmp_forward_estimates', { provider: 'fmp', group: '分析师', desc: '前瞻共识预期 FY1/FY2 + 前瞻估值倍数', params: [{ name: 'symbol', default: 'NVDA' }], run: async (a) => { const [q, est] = await Promise.all([fmp.getQuote(a.symbol), fmp.getForwardEstimates(a.symbol)]); return { ...est, multiples: fmp.forwardMultiples(q, est) }; } }],
  ['fmp_income', { provider: 'fmp', group: '财报', desc: '利润表（最近若干期）', params: [{ name: 'symbol', default: 'NVDA' }, { name: 'limit', default: '3' }], run: (a) => fmp.getIncomeStatement(a.symbol, { limit: Number(a.limit) || 3 }) }],
  ['fmp_balance_sheet', { provider: 'fmp', group: '财报', desc: '资产负债表（杠杆/现金/营运资本）', params: [{ name: 'symbol', default: 'NVDA' }, { name: 'limit', default: '3' }], run: (a) => fmp.getBalanceSheet(a.symbol, { limit: Number(a.limit) || 3 }) }],
  ['fmp_cash_flow', { provider: 'fmp', group: '财报', desc: '现金流量表（FCF/资本开支/经营现金流）', params: [{ name: 'symbol', default: 'NVDA' }, { name: 'limit', default: '3' }], run: (a) => fmp.getCashFlow(a.symbol, { limit: Number(a.limit) || 3 }) }],
  ['fmp_growth', { provider: 'fmp', group: '估值', desc: '财务成长性（营收/利润/FCF 增速）', params: [{ name: 'symbol', default: 'NVDA' }, { name: 'limit', default: '4' }], run: (a) => fmp.getFinancialGrowth(a.symbol, { limit: Number(a.limit) || 4 }) }],
  ['fmp_historical', { provider: 'fmp', group: '行情/基本面', desc: '历史行情 + 动量（1M/3M 区间收益）', params: [{ name: 'symbol', default: 'NVDA' }, { name: 'days', default: '120' }], run: (a) => fmp.getHistoricalPrice(a.symbol, { days: Number(a.days) || 120 }) }],
  ['fmp_intraday', { provider: 'fmp', group: '行情/基本面', desc: '日内行情（5min/15min/30min/1hour）', params: [{ name: 'symbol', default: 'NVDA' }, { name: 'interval', default: '5min' }, { name: 'limit', default: '78' }], run: (a) => fmp.getIntradayPrice(a.symbol, { interval: a.interval || '5min', limit: Number(a.limit) || 78 }) }],
  ['fmp_market_cap_history', { provider: 'fmp', group: '行情/基本面', desc: '历史市值序列', params: [{ name: 'symbol', default: 'NVDA' }, { name: 'limit', default: '120' }], run: (a) => fmp.getMarketCapHistory(a.symbol, { limit: Number(a.limit) || 120 }) }],
  ['fmp_insider', { provider: 'fmp', group: '信号', desc: '内部人交易（高管增减持信号）', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getInsiderTrading(a.symbol) }],
  ['fmp_earnings_surprise', { provider: 'fmp', group: '财报', desc: '业绩超预期历史（beat/miss）', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getEarningsSurprises(a.symbol) }],
  ['fmp_dcf', { provider: 'fmp', group: '估值', desc: 'FMP 内置 DCF 估值（交叉验证）', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getDCF(a.symbol) }],
  ['fmp_rating', { provider: 'fmp', group: '分析师', desc: '分析师评级共识', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getRating(a.symbol) }],
  ['fmp_sector', { provider: 'fmp', group: '宏观', desc: '板块表现（轮动视角）', params: [], run: () => fmp.getSectorPerformance() }],
  ['fmp_screener', { provider: 'fmp', group: '筛选', desc: '股票筛选器（行业/市值/beta 发现标的）', params: [{ name: 'sector', label: '行业', default: 'Technology' }, { name: 'marketCapMoreThan', label: '市值下限', default: '10000000000' }, { name: 'limit', default: '15' }], run: (a) => fmp.screenStocks({ sector: a.sector, marketCapMoreThan: Number(a.marketCapMoreThan) || undefined, limit: Number(a.limit) || 15 }) }],
  // —— FMP 明细数据（主要暴露给数据 sub-agent）——
  ['fmp_institutional', { provider: 'fmp', group: '持仓/信号', desc: '机构持仓（13F 主力持有人）', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getInstitutionalOwnership(a.symbol) }],
  ['fmp_grade_changes', { provider: 'fmp', group: '分析师', desc: '分析师评级变动（上调/下调）', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getUpgradesDowngrades(a.symbol) }],
  ['fmp_sec_filings', { provider: 'fmp', group: '财报', desc: 'SEC 备案（10-K/10-Q/8-K）', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getSecFilings(a.symbol) }],
  ['fmp_revenue_product', { provider: 'fmp', group: '财报', desc: '收入结构（按产品线）', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getRevenueByProduct(a.symbol) }],
  ['fmp_revenue_geo', { provider: 'fmp', group: '财报', desc: '收入结构（按地区）', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getRevenueByGeo(a.symbol) }],
  ['fmp_enterprise_values', { provider: 'fmp', group: '估值', desc: '企业价值 EV（含 EV 倍数）', params: [{ name: 'symbol', default: 'NVDA' }, { name: 'limit', default: '3' }], run: (a) => fmp.getEnterpriseValues(a.symbol, { limit: Number(a.limit) || 3 }) }],
  ['fmp_financial_score', { provider: 'fmp', group: '估值', desc: '财务健康度（Piotroski/Altman Z）', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getFinancialScore(a.symbol) }],
  ['fmp_shares_float', { provider: 'fmp', group: '行情/基本面', desc: '流通股本与内部人/机构持股比', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getSharesFloat(a.symbol) }],
  ['fmp_short_interest', { provider: 'fmp', group: '持仓/信号', desc: '空头兴趣 / days-to-cover', params: [{ name: 'symbol', default: 'NVDA' }, { name: 'limit', default: '12' }], run: (a) => fmp.getShortInterest(a.symbol, { limit: Number(a.limit) || 12 }) }],
  ['fmp_etf_holders', { provider: 'fmp', group: '持仓/信号', desc: 'ETF 持有该标的的暴露', params: [{ name: 'symbol', default: 'NVDA' }, { name: 'limit', default: '20' }], run: (a) => fmp.getEtfHolders(a.symbol, { limit: Number(a.limit) || 20 }) }],
  ['fmp_dividends', { provider: 'fmp', group: '财报', desc: '分红历史（金额/股息率）', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getDividends(a.symbol) }],
  ['fmp_treasury', { provider: 'fmp', group: '宏观', desc: '美债收益率曲线', params: [], run: () => fmp.getTreasuryRates() }],
  ['fmp_economic', { provider: 'fmp', group: '宏观', desc: '宏观经济指标（realGDP/CPI/失业率…）', params: [{ name: 'name', label: '指标', default: 'realGDP' }], run: (a) => fmp.getEconomicIndicator(a.name) }],
  ['fmp_market_movers', { provider: 'fmp', group: '宏观', desc: '市场异动榜（gainers/losers/actives）', params: [{ name: 'kind', label: '类型', default: 'gainers' }], run: (a) => fmp.getMarketMovers(a.kind) }],
  ['fmp_fx_quotes', { provider: 'fmp', group: '宏观', desc: '外汇报价（汇率外部驱动）', params: [{ name: 'pairs', label: '货币对(逗号)', default: 'EURUSD,USDJPY,USDCNH' }, { name: 'limit', default: '20' }], run: (a) => fmp.getFxQuotes({ pairs: (a.pairs || '').split(/[,，\s]+/).filter(Boolean), limit: Number(a.limit) || 20 }) }],
  ['fmp_commodity_quotes', { provider: 'fmp', group: '宏观', desc: '商品报价（能源/金属/农产品外部驱动）', params: [{ name: 'symbols', label: '代码(逗号)', default: 'CLUSD,NGUSD,GCUSD,SIUSD,HGUSD' }, { name: 'limit', default: '20' }], run: (a) => fmp.getCommodityQuotes({ symbols: (a.symbols || '').split(/[,，\s]+/).filter(Boolean), limit: Number(a.limit) || 20 }) }],
  ['fmp_macro_asset_history', { provider: 'fmp', group: '宏观', desc: 'FX/商品等宏观资产历史价格', params: [{ name: 'symbol', default: 'CLUSD' }, { name: 'days', default: '120' }], run: (a) => fmp.getMacroAssetHistory(a.symbol, { days: Number(a.days) || 120 }) }],
  ['fmp_ipo_calendar', { provider: 'fmp', group: '日历', desc: 'IPO 日历', params: [{ name: 'limit', default: '50' }], run: (a) => fmp.getIpoCalendar({ limit: Number(a.limit) || 50 }) }],
  ['fmp_news_search', { provider: 'fmp', group: '新闻', desc: '按主题/标的过滤新闻', params: [{ name: 'query', default: 'AI capex' }, { name: 'tickers', default: 'NVDA,AVGO' }, { name: 'limit', default: '20' }], run: (a) => fmp.searchStockNews({ query: a.query, tickers: (a.tickers || '').split(/[,，\s]+/).filter(Boolean), limit: Number(a.limit) || 20 }) }],
  ['fmp_earnings_calendar', { provider: 'fmp', group: '日历', desc: '财报日历（下次财报日期 + 共识 EPS/营收预估）', params: [{ name: 'symbol', default: 'NVDA' }], run: (a) => fmp.getEarningsCalendar(a.symbol) }],
  ['fmp_upcoming_earnings', { provider: 'fmp', group: '日历', desc: '未来 N 天全市场财报日历', params: [{ name: 'days', default: '7' }, { name: 'limit', default: '120' }], run: (a) => fmp.getUpcomingEarnings({ days: Number(a.days) || 7, limit: Number(a.limit) || 120 }) }],
  ['fmp_economic_calendar', { provider: 'fmp', group: '日历', desc: '宏观事件日历（未来 N 天高影响事件：FOMC/CPI/非农）', params: [{ name: 'days', default: '14' }], run: (a) => fmp.getEconomicCalendar({ days: Number(a.days) || 14 }) }],

  // ---- SEC/EDGAR（一手材料，无需 key）----
  ['edgar_filings', { provider: 'edgar', group: '一手材料', desc: 'SEC 备案清单（10-K/10-Q/8-K，含链接与 8-K 事件项）', params: [{ name: 'symbol', default: 'NVDA' }, { name: 'forms', label: '类型(逗号)', default: '10-K,10-Q,8-K' }, { name: 'limit', default: '12' }], run: (a) => edgar.edgarFilings(a.symbol, { forms: a.forms, limit: Number(a.limit) || 12 }) }],
  ['edgar_fulltext', { provider: 'edgar', group: '一手材料', desc: 'EDGAR 全文检索（在备案文件全文中搜关键词）', params: [{ name: 'query', label: '关键词', default: 'HBM capacity' }, { name: 'forms', label: '类型', default: '8-K' }], run: (a) => edgar.edgarFullText(a.query, { forms: a.forms }) }],
  ['edgar_section', { provider: 'edgar', group: '一手材料', desc: '抓取备案文档并抽取章节（risk=风险因素 / mdna=MD&A / legal=法律诉讼）', params: [{ name: 'url', label: '文档URL', default: '' }, { name: 'section', label: 'risk|mdna|legal', default: 'risk' }], run: (a) => edgar.edgarSection(a.url, { section: a.section }) }],

  // ---- FRED（行业高频/宏观序列，可选 key）----
  ['fred_series', { provider: 'fred', group: '宏观', desc: 'FRED 序列（IPG3344S 半导体产出/DCOILWTICO 油价/DGS10 利率…）', params: [{ name: 'series', label: '序列ID', default: 'DGS10' }, { name: 'limit', default: '12' }], run: (a) => fredSeries(a.series, { limit: Number(a.limit) || 12 }) }],

  // ---- Perplexity ----
  ['pplx_search', { provider: 'perplexity', group: '联网检索', desc: '联网检索问答（sonar），带引用；可限时间窗（验证判断用）', params: [{ name: 'query', label: '问题', default: '英伟达最新业绩与指引' }, { name: 'afterDate', label: '发布晚于(M/D/YYYY)', default: '' }, { name: 'beforeDate', label: '发布早于(M/D/YYYY)', default: '' }], run: (a) => pplxSearch(a.query, { afterDate: a.afterDate || undefined, beforeDate: a.beforeDate || undefined }) }],
  ['pplx_finance', { provider: 'perplexity', group: '联网检索', desc: '金融专向检索（sonar-pro，高检索上下文）：业绩/估值/分析师/催化/风险', params: [{ name: 'query', label: '主题/标的', default: 'NVDA 估值与分析师目标价' }, { name: 'afterDate', label: '发布晚于(M/D/YYYY)', default: '' }, { name: 'beforeDate', label: '发布早于(M/D/YYYY)', default: '' }], run: (a) => pplxFinance(a.query, { afterDate: a.afterDate || undefined, beforeDate: a.beforeDate || undefined }) }],
  ['pplx_ask_page', { provider: 'perplexity', group: '联网检索', desc: '针对网页链接的内容问答', params: [{ name: 'url', default: 'https://www.cnbc.com/quotes/NVDA' }, { name: 'question', label: '问题', default: '该公司最新动态是什么？' }], run: (a) => pplxAskPage(a.url, a.question) }],
  ['pplx_sec', { provider: 'perplexity', group: '一手材料', desc: 'SEC 备案语料检索问答（只查 filings：披露/风险因素/分部口径/MD&A）', params: [{ name: 'query', label: '问题', default: 'NVDA data center segment risk factors' }, { name: 'afterDate', label: '发布晚于(M/D/YYYY)', default: '' }], run: (a) => pplxSec(a.query, { afterDate: a.afterDate || undefined }) }],
  ['pplx_reasoning', { provider: 'perplexity', group: '联网检索', desc: '多步推理检索（sonar-reasoning-pro）：跨来源综合+论证链，适合传导路径/因果类复杂问题', params: [{ name: 'query', label: '问题', default: 'HBM 产能爬坡对 AI 服务器出货的约束路径' }], run: (a) => pplxReason(a.query) }],
  ['pplx_deep_research', { provider: 'perplexity', group: '联网检索', desc: '深度研究报告（sonar-deep-research）：穷尽式多来源研究。慢(数分钟)且贵，一次分析限用 1-2 次，用于行业历程/产业链全景级问题', params: [{ name: 'query', label: '研究主题', default: 'AI datacenter cooling supply chain bottlenecks 2025-2026' }], run: (a) => pplxDeepResearch(a.query) }],

  // ---- Tavily ----
  ['tavily_search', { provider: 'tavily', group: '网页', desc: '网页搜索（含 AI 摘要与来源）', params: [{ name: 'query', label: '搜索词', default: 'AI server liquid cooling supply chain' }, { name: 'maxResults', default: '5' }], run: (a) => tavilySearch(a.query, { maxResults: Number(a.maxResults) || 5 }) }],
  ['tavily_extract', { provider: 'tavily', group: '网页', desc: '网页正文抓取（清洗正文）', params: [{ name: 'urls', label: 'URL(逗号)', default: 'https://www.cnbc.com/quotes/NVDA' }], run: (a) => tavilyExtract((a.urls || '').split(/[,，\s]+/).filter(Boolean)) }],

  // ---- Research（分析师/博主观点流，多数无需 key）----
  ['sa_symbol', { provider: 'research', group: '观点流', desc: 'Seeking Alpha 某标的分析师文章/多空论点', params: [{ name: 'symbol', default: 'NVDA' }, { name: 'limit', default: '12' }], run: (a) => research.saSymbol(a.symbol, { limit: Number(a.limit) || 12 }) }],
  ['sa_latest', { provider: 'research', group: '观点流', desc: 'Seeking Alpha 全站最新 ideas/文章流', params: [{ name: 'limit', default: '20' }], run: (a) => research.saLatest({ limit: Number(a.limit) || 20 }) }],
  ['substack_feed', { provider: 'research', group: '观点流', desc: '行业博客/Substack RSS（来源 id 或 url）', params: [{ name: 'source', label: '来源id/url', default: 'thechipletter' }, { name: 'limit', default: '12' }], run: (a) => research.substackFeed(a.source, { limit: Number(a.limit) || 12 }) }],
  ['social_sentiment', { provider: 'research', group: '观点流', desc: 'StockTwits 标的社交情绪（多空票数+热门消息，免费）', params: [{ name: 'symbol', default: 'NVDA' }, { name: 'limit', default: '20' }], run: (a) => research.socialSentiment(a.symbol, { limit: Number(a.limit) || 20 }) }],
  ['x_search', { provider: 'research', group: '观点流', desc: 'X/Twitter 社交观点（需 X key，否则回退 Perplexity）', params: [{ name: 'query', label: '主题/标的', default: 'NVDA AI capex' }, { name: 'limit', default: '12' }], run: (a) => research.xSearch(a.query, { limit: Number(a.limit) || 12 }) }],
  ['research_digest', { provider: 'research', group: '观点流', desc: '多来源观点聚合摘要（SA+博客+可选X，去重排序）', params: [{ name: 'tickers', label: '标的(逗号)', default: 'NVDA,AVGO' }, { name: 'theme', label: '主题', default: 'AI 算力' }, { name: 'includeX', label: '含X(true/false)', default: 'false' }], run: (a) => research.researchDigest({ tickers: (a.tickers || '').split(/[,，\s]+/).filter(Boolean), theme: a.theme, includeX: String(a.includeX) === 'true' }) }],

  // ---- Canonical Worldview（run-scoped, read-only capabilities）----
  ['worldview_read_current', { provider: 'worldview', group: 'Canonical Worldview', desc: 'Read the complete frozen current Canonical Worldview package for one governed run.', params: [{ name: 'scopeId', default: '' }], run: (a) => runWorldviewCapabilityTool('worldview_read_current', a) }],
  ['worldview_enumerate_overviews', { provider: 'worldview', group: 'Canonical Worldview', desc: 'Enumerate every ordered Report Overview in the frozen admission range.', params: [{ name: 'scopeId', default: '' }], run: (a) => runWorldviewCapabilityTool('worldview_enumerate_overviews', a) }],
  ['worldview_read_report_version', { provider: 'worldview', group: 'Canonical Worldview', desc: 'Read one exact digest-verified ReportVersion inside the frozen range.', params: [{ name: 'scopeId', default: '' }, { name: 'reportVersionId', default: '' }], run: (a) => runWorldviewCapabilityTool('worldview_read_report_version', a) }],
  ['worldview_search_claims', { provider: 'worldview', group: 'Canonical Worldview', desc: 'Query the approved Claim surface without filesystem access.', params: [{ name: 'scopeId', default: '' }, { name: 'query', default: '' }], run: (a) => runWorldviewCapabilityTool('worldview_search_claims', a) }],

  // ---- Project workspace（受限项目文件工具）----
  ['project_search', { provider: 'workspace', group: '项目库', desc: '跨项目只读检索相关项目/报告摘要', params: [{ name: 'currentProjectId', default: '' }, { name: 'query', default: 'AI capex' }, { name: 'limit', default: '8' }], run: (a) => workspace.searchProjectLibrary({ currentProjectId: a.currentProjectId, query: a.query, limit: Number(a.limit) || 8 }) }],
  ['project_read_file', { provider: 'workspace', group: '项目库', desc: '读取任一项目文件（只读，用于跨项目复用）', params: [{ name: 'projectId', default: '' }, { name: 'file', default: 'report/report.md' }], run: (a) => workspace.readProjectFile(a) }],
  ['project_write_current_file', { provider: 'workspace', group: '项目库', desc: '写入当前项目 data/analysis/report 文件（禁止写其他项目）', params: [{ name: 'currentProjectId', default: '' }, { name: 'projectId', default: '' }, { name: 'file', default: 'analysis/company_report.md' }, { name: 'content', default: '' }], run: (a) => workspace.writeCurrentProjectFile(a) }],
  ['project_append_current_file', { provider: 'workspace', group: '项目库', desc: '追加当前项目 data/analysis/report 文件（禁止写其他项目）', params: [{ name: 'currentProjectId', default: '' }, { name: 'projectId', default: '' }, { name: 'file', default: 'analysis/company_report.md' }, { name: 'content', default: '' }], run: (a) => workspace.appendCurrentProjectFile(a) }],

  // ---- M2 workspace 工具：agent 像读代码库一样按需读项目产物（分页无上限，预算兜底）----
  ['ws_list_files', { provider: 'workspace', group: '项目库', desc: '当前项目文件树（路径+大小），先看树再决定读什么', params: [{ name: 'projectId', default: '' }], run: (a) => workspace.listProjectFiles(a) }],
  ['ws_read_file', { provider: 'workspace', group: '项目库', desc: '分页读项目文件（offset/limit 字符，单页≤24k字符；返回 nextOffset 继续翻页；可读其他项目=跨项目复用）', params: [{ name: 'projectId', default: '' }, { name: 'file', default: 'data/data_report.md' }, { name: 'offset', default: '0' }, { name: 'limit', default: '24000' }], run: (a) => workspace.readProjectFilePaged({ projectId: a.projectId, file: a.file, offset: Number(a.offset) || 0, limit: Number(a.limit) || undefined }) }],
  ['ws_search_library', { provider: 'workspace', group: '项目库', desc: '跨项目检索已分析项目的结论/报告摘要（找到后用 ws_read_file 读全文）', params: [{ name: 'currentProjectId', default: '' }, { name: 'query', default: '' }, { name: 'limit', default: '8' }], run: (a) => workspace.searchProjectLibrary({ currentProjectId: a.currentProjectId, query: a.query, limit: Number(a.limit) || 8 }) }],
  ['ws_write_file', { provider: 'workspace', group: '项目库', desc: '写当前项目 data/analysis/report 下的文件（整文件覆盖）', params: [{ name: 'currentProjectId', default: '' }, { name: 'projectId', default: '' }, { name: 'file', default: 'analysis/notes.md' }, { name: 'content', default: '' }], run: (a) => workspace.writeCurrentProjectFile(a) }],
  ['ws_append_file', { provider: 'workspace', group: '项目库', desc: '追加当前项目 data/analysis/report 下的文件', params: [{ name: 'currentProjectId', default: '' }, { name: 'projectId', default: '' }, { name: 'file', default: 'analysis/notes.md' }, { name: 'content', default: '' }], run: (a) => workspace.appendCurrentProjectFile(a) }],
  ['ws_edit_file', { provider: 'workspace', group: '项目库', desc: '精确字符串替换当前项目文件（oldText 必须与原文完全一致；多处匹配需 replaceAll=true）——报告局部修改用这个而非整篇重写', params: [{ name: 'currentProjectId', default: '' }, { name: 'projectId', default: '' }, { name: 'file', default: 'report/report.md' }, { name: 'oldText', default: '' }, { name: 'newText', default: '' }, { name: 'replaceAll', default: 'false' }], run: (a) => workspace.editCurrentProjectFile({ ...a, replaceAll: String(a.replaceAll) === 'true' }) }],
];

export const toolRegistry = new ToolRegistry(TOOL_REGISTRATIONS.map(withContract));
export function validateToolInput(name, args = {}) {
  return coerceToolInputForTool(name, toolRegistry.get(name), args, { requireRuntimeIdentity: true });
}
