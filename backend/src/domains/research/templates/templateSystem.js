// 分析模板系统：为不同类型的题目提供「分析思路逻辑」模板，供 agent 参考。
// 模板可在设置页编辑（先由内置/LLM 生成，再人工改）。持久化到 data/templates.json。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../config.js';

const FILE = path.join(DATA_DIR, 'templates.json');

const BUILTIN_INDUSTRY = [
  {
    id: 'industry_supply_bottleneck',
    name: '产业链供给瓶颈行业模板',
    kind: 'industry',
    scope: '供给受限、产能/产能利用率错配类主题',
    guidance: `行业分析模板：
1. 定义收入池：瓶颈环节服务的下游需求、当前市场规模、未来 1-5 年扩容路径。
2. 量化供需缺口：现有产能、可用产能、扩产周期、交付瓶颈和需求增速，形成熊/基/牛缺口区间。
3. 价格与利润池：判断瓶颈价格能否传导、谁捕获超额毛利、利润池在产业链中的迁移。
4. 竞争与替代：新增供给、客户自建、技术替代、政策绕行路径及时间表。
5. 行业 signposts：订单/排产、价格、交期、库存、产能利用率、capex 等可观察指标。
6. 行业估值锚：同类周期/瓶颈资产在不同景气阶段的倍数和利润池占比。`,
  },
  {
    id: 'industry_semiconductor',
    name: '半导体行业模板',
    kind: 'industry',
    scope: '半导体产业链、AI 算力链、芯片周期',
    guidance: `行业分析模板：
1. 拆产业链收入池：设计、IP、晶圆制造、先进封装、HBM/存储、设备、材料、服务器/网络。
2. 订单归属矩阵：谁付 capex、买 GPU/TPU/ASIC/服务器/网络中的哪一类、谁设计、谁代工/封装、谁确认收入。
3. 周期位置：库存、价格、产能利用率、交期、capex 计划与历史周期对比。
4. 竞争与替代：GPU vs ASIC/TPU、不同代工/封装/HBM 供应商的份额转移。
5. 估值隐含预期：当前板块倍数隐含的收入增速、利润率、capex intensity 与终端倍数。
6. 观察指标：hyperscaler capex、先进封装产能、HBM 合同价格、设备订单、渠道库存。`,
  },
  {
    id: 'industry_new_material',
    name: '新材料产业化行业模板',
    kind: 'industry',
    scope: '新材料/新工艺从导入到放量',
    guidance: `行业分析模板：
1. 性能/成本替代曲线：相对现有材料的性能提升、单位成本、良率和可靠性。
2. 产业化阶段：实验室、小批量、客户验证、量产爬坡、渗透率曲线位置。
3. 需求触发场景：哪些终端场景最先采用，采用约束是什么。
4. 供给格局：专利、设备、工艺 know-how、关键原料与潜在进入者。
5. 利润池变化：新材料放量后替代谁、谁获得新增利润池。
6. 拐点与证伪：客户认证、量产良率、成本下降、价格临界点和替代技术。`,
  },
  {
    id: 'industry_demand_resurgence',
    name: '需求重估/景气反转行业模板',
    kind: 'industry',
    scope: '需求被低估或景气拐点临近的主题',
    guidance: `行业分析模板：
1. 需求来源拆解：终端需求、补库存、政策/技术触发、价格下降带来的弹性。
2. 周期位置：当前库存、订单、开工率、价格和领先指标相对历史周期的位置。
3. 供给响应：产能是否过剩、供给弹性和价格/毛利率传导。
4. 受益链条：直接受益、卖铲子、间接受益与滞后环节。
5. 景气 signposts：订单、排产、价格、开工率、渠道库存、终端销量。
6. 估值框架：景气反转初期/中期/尾声的利润上修和倍数变化。`,
  },
  {
    id: 'industry_generic',
    name: '通用行业模板',
    kind: 'industry',
    scope: '一般行业/主题分析',
    guidance: `围绕行业结构性变化展开：市场规模与增速、供需/技术/政策驱动、竞争格局、跨行业传导、估值隐含预期、关键分歧和证伪信号。`,
  },
];

const BUILTIN_COMPANY = [
  {
    id: 'company_supply_bottleneck',
    name: '产业链供给瓶颈公司模板',
    kind: 'company',
    scope: '供给瓶颈主题中的具体公司',
    guidance: `公司分析模板：
1. 公司在瓶颈链条中的位置：是否真正控制稀缺产能、技术、客户认证或关键设备。
2. 收入兑现路径：在手订单、产能、ASP、利用率和交付节奏如何转成收入。
3. 利润率弹性：涨价传导、成本结构、规模效应和毛利率上限。
4. 客户与合同质量：客户集中度、长协/短单、价格重定价机制和切换成本。
5. 估值隐含预期：当前市值隐含的产能、ASP、毛利率和终端倍数。
6. 证伪条件：新增供给、客户自建/转单、替代技术、订单取消或价格松动。`,
  },
  {
    id: 'company_semiconductor',
    name: '半导体公司模板',
    kind: 'company',
    scope: '半导体公司基本面与估值',
    guidance: `公司分析模板：
1. 环节定位：设计/制造/封测/设备/材料/IP/服务器网络中的位置和壁垒。
2. 产品与客户：主力产品、制程/代际、客户集中度、终端买方和订单归属。
3. 财务质量：营收增速、毛利率、ROIC、FCF、库存、capex 和 SBC/稀释。
4. 竞争与替代：客户从 GPU 到 ASIC/TPU、代工/封装/HBM 供应商切换对公司收入的影响。
5. 估值：fwd PE/PS/PEG、历史分位、同业 comps、反向 DCF 隐含增长与利润率。
6. 证伪条件：订单下修、库存恶化、价格下跌、客户转单、技术路线落后。`,
  },
  {
    id: 'company_new_material',
    name: '新材料公司模板',
    kind: 'company',
    scope: '新材料/新工艺公司的产业化兑现',
    guidance: `公司分析模板：
1. 技术真实性：性能、成本、良率、可靠性和客户验证状态。
2. 产能与量产：产线建设、良率爬坡、单位成本下降和交付瓶颈。
3. 客户与订单：认证客户、订单金额、价格条款、导入节奏和替代对象。
4. 竞争壁垒：专利、工艺 know-how、设备/原料、客户粘性和潜在进入者。
5. 估值：订单/产能/峰值利润情景，早期项目用 EV/远期收入或 rNPV，不硬套 PE。
6. 证伪条件：良率不达标、客户验证失败、成本降不下来、替代材料出现。`,
  },
  {
    id: 'company_demand_resurgence',
    name: '需求重估公司模板',
    kind: 'company',
    scope: '景气反转中的具体公司',
    guidance: `公司分析模板：
1. 需求弹性：公司收入对终端需求、价格、库存周期和政策变量的敏感度。
2. 经营杠杆：销量回升对毛利率、费用率、现金流和 ROIC 的传导。
3. 订单/渠道证据：订单、排产、库存、渠道价格和客户预算。
4. 竞争位置：需求复苏时份额是否提升，是否有价格战或替代风险。
5. 估值：盈利上修幅度、历史周期倍数、反向估值隐含的复苏强度。
6. 证伪条件：需求脉冲不可持续、库存再积压、价格回落、供给快速过剩。`,
  },
  {
    id: 'company_generic',
    name: '通用公司模板',
    kind: 'company',
    scope: '一般公司基本面与估值分析',
    guidance: `围绕公司基本面展开：业务与产业链位置、成长性、盈利质量、估值隐含预期、客户/订单归属、竞争威胁、催化与风险、结论和风险收益比。`,
  },
];

// 数据获取模板（kind:'data'）：不同行业/股票类型，「数据在哪、准备多少、重点看什么」不同。
// 通用模板始终生效；专有模板按 keywords 命中后叠加。可在设置页查看/修改。
const BUILTIN_DATA = [
  {
    id: 'data_general', name: '通用数据获取', kind: 'data', keywords: [],
    scope: '所有主题的通用数据采集基线',
    autoTools: [{ tool: 'fmp_economic_calendar', args: { days: 14 } }],
    guidance: `数据源与优先级（通用）：
1. 行情/估值：FMP quote/ratios/key-metrics/前瞻分析师预期（fwd PE/PS/PEG）。
2. 财务：income/balance/cash-flow（近 3 期）、growth、earnings-surprise、DCF、price-target。
3. 一手材料：最新一期财报电话会 transcript（管理层 guidance/口径）。
4. 联网研究：Perplexity 金融检索 + FMP 新闻 + Tavily。
5. 观点流：Seeking Alpha 分析师 + 行业博客 + StockTwits 情绪。
6. 估值隐含预期：前瞻倍数、历史分位、同业 comps、DCF/反向 DCF、市场隐含增长率 vs 共识。
准备量：核心标的 3-5 个，每个覆盖上述 1-3；行业级至少 1 组板块/可比数据。
质量要求：标注每源的覆盖度/时效/可靠度，显式列出数据缺口。`,
  },
  {
    id: 'data_semiconductor', name: '半导体数据', kind: 'data',
    keywords: ['半导体', '芯片', '晶圆', '封装', 'HBM', 'CoWoS', 'GPU', '存储', 'DRAM', 'NAND', 'semiconductor', 'foundry'],
    scope: '半导体（设计/制造/封测/设备/材料）',
    autoTools: [{ tool: 'fred_series', args: { series: 'IPG3344S' }, label: '半导体及元件工业产出(FRED)' }],
    guidance: `半导体专有数据重点：
- 需重点获取：产能利用率/扩产资本开支、制程节点与代差、大客户集中度、库存周期(BB值/DIO)、ASP 与毛利率趋势、设备交期。
- AI 算力链必须补充：hyperscaler/大模型公司 capex 预算与增速、GPU/TPU/ASIC/服务器/网络采购结构、订单归属（买方→芯片设计→晶圆制造→先进封装/HBM→收入确认公司）、客户从 GPU 到 TPU/ASIC 或不同代工/封装供应商切换的证据。
- 估值必须补充：当前价格/前瞻倍数/反向 DCF 隐含的收入/EPS/FCF 增速、毛利率/营业利润率、capex intensity 与终端倍数，并与共识及熊/基/牛情景比较。
- 数据源补充：财报会中的产能/良率/资本开支口径（transcript 必取）、SemiAnalysis/The Chip Letter/Chipstrat 等行业博客、可比公司 peers。
- 准备量：候选 4-5 个覆盖产业链上中下游；至少取 2 家的 transcript。`,
  },
  {
    id: 'data_biotech', name: '生物医药数据', kind: 'data',
    keywords: ['生物', '医药', '制药', '疗法', 'FDA', '临床', 'biotech', 'pharma', '药'],
    scope: '生物科技/制药（管线驱动、事件驱动）',
    guidance: `生物医药专有数据重点：
- 需重点获取：在研管线阶段(I/II/III)、关键催化日期(FDA/AdCom/PDUFA/数据读出)、现金跑道(cash runway=现金/季度烧钱)、专利悬崖、合作/授权。
- 估值口径：多用 EV/管线峰值销售、rNPV，而非 PE（多数未盈利）；关注稀释风险。
- 数据源补充：临床催化日历、Perplexity 检索最新监管进展；财务侧看现金与经营性现金流。
- 准备量：聚焦 1-3 个事件驱动标的，把催化时间线与二元结果概率查清。`,
  },
  {
    id: 'data_reit', name: 'REIT/地产数据', kind: 'data',
    keywords: ['REIT', '地产', '铁塔', '仓储', '数据中心地产', '租', 'real estate', 'tower'],
    scope: '房地产信托/租赁现金流资产',
    autoTools: [{ tool: 'fred_series', args: { series: 'DGS10' }, label: '10Y 美债收益率(FRED)' }],
    guidance: `REIT 专有数据重点：
- 需重点获取：FFO/AFFO 与派息覆盖、出租率/续租价差、加权租约久期、债务久期与加权利率、净负债/EBITDA、Cap Rate 与 NAV。
- 估值口径：P/FFO、股息率与利率利差，而非 PE。对利率高度敏感——需取利率/久期敏感度。
- 准备量：核心 REIT 2-3 个，取 FFO 指引与债务到期结构。`,
  },
  {
    id: 'data_financials', name: '金融/银行数据', kind: 'data',
    keywords: ['银行', '保险', '券商', '金融', 'BDC', 'bank', 'insurance', 'financial'],
    scope: '银行/保险/资管等金融机构',
    autoTools: [{ tool: 'fred_series', args: { series: 'T10Y2Y' }, label: '10Y-2Y 利差(FRED)' }],
    guidance: `金融机构专有数据重点：
- 需重点获取：净息差(NIM)、拨备与不良率(NPL)、资本充足率(CET1)、ROE/ROA、账面价值与 P/B、贷款/存款结构。
- 估值口径：P/B 与 ROE 联动、股息率，而非单纯 PE。对利率与信用周期敏感。
- 准备量：核心标的 2-3 个，取资产质量与资本指标。`,
  },
  {
    id: 'data_energy', name: '能源/大宗数据', kind: 'data',
    keywords: ['能源', '石油', '天然气', '电力', '铜', '锂', '矿', '大宗', 'energy', 'oil', 'commodity', 'utility', 'power'],
    scope: '能源/公用事业/大宗商品',
    autoTools: [{ tool: 'fred_series', args: { series: 'DCOILWTICO' }, label: 'WTI 油价(FRED)' }],
    guidance: `能源/大宗专有数据重点：
- 需重点获取：商品价格与远期曲线、产量/储量/产能、盈亏平衡成本、资本开支与自由现金流、对标的商品价格敏感度。
- 估值口径：EV/EBITDA、FCF 收益率、股息，商品价格情景下的盈利弹性。
- 数据源补充：商品价格与库存高频数据、板块表现。
- 准备量：核心标的 2-3 个 + 关键商品价格与成本曲线。`,
  },
  {
    id: 'data_software', name: '软件/SaaS 数据', kind: 'data',
    keywords: ['软件', 'SaaS', '云', '互联网', '平台', 'software', 'cloud', 'internet', 'AI应用'],
    scope: '软件/SaaS/互联网平台（高成长）',
    guidance: `软件/SaaS 专有数据重点：
- 需重点获取：营收增速与 NRR/净留存、毛利率、Rule of 40、经营杠杆与自由现金流利润率、SBC 稀释、客户/ARPU。
- 估值口径：EV/S 与增速匹配(增长调整后)、FCF 倍数，而非 PE。
- 准备量：核心标的 3-4 个，取前瞻营收预期与利润率路径。`,
  },
];

// 扫描/筛选模板（kind:'scan'）：发现型项目（没指定标的、找受益股、行业变化谁受益）先宽扫描出一批候选，
// 再按「打分规则」收敛到最多 3 个进深度分析。模板给的是 LLM 打分收敛的方法论，而非固定名单。
const BUILTIN_SCAN = [
  {
    id: 'scan_beneficiary',
    name: '受益股发现扫描模板',
    kind: 'scan',
    scope: '找某主题/事件/技术变化的受益股（未指定具体标的）',
    // sectorHint 供 fmp_screener 宽召回用；命中不到就退化为纯 plan 候选。
    sectorHint: 'Technology',
    guidance: `扫描/筛选方法（先宽后窄，最终进深度分析的公司不超过 3 个）：
一、宽发现（10-30 个候选）：沿价值链穷举可能受益者——直接受益（收入直接来自该主题）、卖铲子（提供关键环节/设备/材料）、间接受益（下游需求外溢）、平台/整合者。避免只列最知名的几个大票，主动纳入中小盘与被忽视的卡位环节。
二、打分规则（每个候选按下列维度 0-100 打分，give take 一句话理由）：
1. 受益强度与纯度：该主题对其收入/利润的边际贡献占比有多高；是纯受益还是被稀释。
2. 收入归属确定性：钱从哪来、谁付、在价值链哪个环节确认收入，链条是否清晰可证。
3. 预期差：市场是否已充分定价该受益（拥挤/已涨透 vs 被忽视）。
4. 数据可得性：有无公开财务与前瞻数据支撑深度分析（无数据 OTC/杜撰代码直接淘汰）。
5. 卡位与壁垒：是否处于难替代的关键环节，还是易被绕过。
6. 可证伪性：受益逻辑是否有清晰的证实/证伪信号。
三、收敛：按综合分排序，取前 3 名进入深度分析；其余保留为「行业上下文候选」不做逐公司深挖。用户已指定的标的必须保留并计入这 3 个名额。`,
  },
  {
    id: 'scan_industry_change',
    name: '行业变化受益/受损扫描模板',
    kind: 'scan',
    scope: '某行业/产业发生结构性变化，扫描谁受益、谁受损',
    sectorHint: 'Technology',
    guidance: `扫描/筛选方法（围绕「行业结构性变化」的价值链重分配，最终深度分析不超过 3 个）：
一、先刻画变化：这轮行业变化的本质是什么（需求迁移/供给重构/技术替代/政策/成本曲线移动），利润池从哪里迁到哪里。
二、宽发现（10-30 个候选）：沿新旧价值链两侧穷举——新范式受益方（承接新增利润池）、被替代/受损方（利润池流出，可做空/回避）、卖铲子与使能环节、以及在变化中重新卡位的整合者。
三、打分规则（每个候选 0-100 打分 + 一句 take）：
1. 相对变化的方向与弹性：受益还是受损，对其盈利的弹性有多大。
2. 利润池归属：变化后新增/流失的利润池是否落到它头上，收入确认环节是否清晰。
3. 时点：变化对它的兑现是当期、1-2 年还是更远。
4. 数据可得性：能否用公开数据支撑深度分析（无数据者淘汰）。
5. 卡位强度与被替代风险。
6. 预期差与可证伪信号。
四、收敛：按综合分排序取前 3 进深度分析（受益方优先，必要时纳入 1 个最典型受损方做对照）；其余作为行业上下文。用户指定标的必须保留并计入名额。`,
  },
  {
    id: 'scan_generic',
    name: '通用扫描模板',
    kind: 'scan',
    scope: '一般的发现型/筛选型项目',
    sectorHint: '',
    guidance: `扫描/筛选方法（先宽后窄，最终进深度分析不超过 3 个）：
一、宽发现：围绕主题穷举 10-30 个有公开财务数据的相关标的，覆盖直接/间接/卖铲子等不同卡位，避免只列最知名的。
二、打分（每个候选 0-100 + 一句 take）：受益/相关强度、收入归属确定性、预期差、数据可得性、卡位与壁垒、可证伪性。
三、收敛：按综合分排序取前 3 进深度分析，其余作为上下文候选。用户指定标的必须保留并计入这 3 个名额。`,
  },
];

function ensureBuiltins(data, builtins) {
  let patched = false;
  for (const bt of builtins) {
    const found = data.templates.find((t) => t.id === bt.id);
    if (!found) {
      data.templates.push({ ...bt, builtin: true, updatedAt: Date.now() });
      patched = true;
    }
  }
  return patched;
}

function load() {
  let data;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.templates) && parsed.templates.length) data = parsed;
  } catch { /* seed below */ }
  let patched = false;
  if (!data) {
    data = {
      templates: [...BUILTIN_INDUSTRY, ...BUILTIN_COMPANY, ...BUILTIN_DATA, ...BUILTIN_SCAN]
        .map((t) => ({ ...t, builtin: true, updatedAt: Date.now() })),
    };
    patched = true;
  } else {
    const before = data.templates.length;
    data.templates = data.templates.filter((t) => ['industry', 'company', 'data', 'scan'].includes(t.kind));
    if (data.templates.length !== before) patched = true;
  }
  patched = ensureBuiltins(data, BUILTIN_INDUSTRY) || patched;
  patched = ensureBuiltins(data, BUILTIN_COMPANY) || patched;
  patched = ensureBuiltins(data, BUILTIN_DATA) || patched;
  patched = ensureBuiltins(data, BUILTIN_SCAN) || patched;

  // 内置数据模板补 autoTools（行业高频数据挂载；老落盘模板没有该字段）
  for (const bt of BUILTIN_DATA) {
    const t = data.templates.find((x) => x.id === bt.id);
    if (t && bt.autoTools && !t.autoTools) { t.autoTools = bt.autoTools; patched = true; }
  }
  // 老模板补齐行业/公司分析指引。
  for (const t of data.templates) {
    if ((t.kind === 'industry' || t.kind === 'company') && !t.guidance) {
      t.guidance = t.kind === 'industry' ? DEFAULT_INDUSTRY_GUIDANCE : DEFAULT_COMPANY_GUIDANCE;
      patched = true;
    }
  }
  if (patched) save(data);
  return data;
}
function save(obj) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(obj, null, 2)); }

// 行业/公司专有模板的关键词表（数据模板自带 keywords；行业/公司模板在此集中定义）
const TEMPLATE_KEYWORDS = {
  industry: [
    { id: 'industry_semiconductor', words: ['半导体', '芯片', '晶圆', '封装', '封测', 'HBM', 'CoWoS', 'GPU', 'TPU', 'ASIC', '存储', 'DRAM', 'NAND', 'semiconductor', 'foundry', '制程', '光刻'] },
    { id: 'industry_supply_bottleneck', words: ['瓶颈', '短缺', '产能紧张', '供给受限', '供不应求', 'bottleneck', 'shortage', '交期', '涨价', '产能错配'] },
    { id: 'industry_new_material', words: ['新材料', '材料', '衬底', '散热', '金刚石', '碳化硅', 'SiC', 'GaN', '产业化', '量产爬坡', '良率'] },
    { id: 'industry_demand_resurgence', words: ['需求重估', '景气反转', '拐点', '复苏', '低估', '重估', '反转', 'resurgence', '库存周期', '补库'] },
  ],
  company: [
    { id: 'company_semiconductor', words: ['半导体', '芯片', '晶圆', '封装', 'HBM', 'GPU', 'TPU', 'ASIC', '存储', 'semiconductor', 'foundry', '台积电', '英伟达', 'TSM', 'NVDA'] },
    { id: 'company_supply_bottleneck', words: ['瓶颈', '短缺', '产能紧张', '供给受限', 'bottleneck', 'shortage', '交期', '涨价'] },
    { id: 'company_new_material', words: ['新材料', '材料', '衬底', '散热', '金刚石', '碳化硅', 'SiC', 'GaN', '产业化', '良率'] },
    { id: 'company_demand_resurgence', words: ['需求重估', '景气反转', '拐点', '复苏', '低估', '重估', '反转', '库存周期'] },
  ],
};
function matchByKeywords(text = '', rows = []) {
  const t = String(text).toLowerCase();
  if (!t.trim()) return null;
  let best = null;
  for (const row of rows) {
    const score = row.words.reduce((a, w) => a + (t.includes(String(w).toLowerCase()) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { id: row.id, score };
  }
  return best;
}

export const TemplateSystem = {
  list() { return load().templates.filter((t) => ['industry', 'company', 'data', 'scan'].includes(t.kind)); },
  get(id) { return load().templates.find((t) => t.id === id) || null; },

  // 关键词路由（恢复：曾被 stub 成永远返回 generic，5 个专有模板成死代码）。
  // classify 的 LLM 路由是首选；这里是 classify 失败/未指定时的确定性兜底。
  matchIndustryTemplate(text = '') {
    const ts = this.industryTemplates();
    const hit = matchByKeywords(text, TEMPLATE_KEYWORDS.industry);
    const template = (hit && ts.find((t) => t.id === hit.id)) || ts.find((t) => t.id === 'industry_generic') || ts[0];
    return { template, score: hit ? hit.score : 0 };
  },
  matchCompanyTemplate(text = '') {
    const ts = this.companyTemplates();
    const hit = matchByKeywords(text, TEMPLATE_KEYWORDS.company);
    const template = (hit && ts.find((t) => t.id === hit.id)) || ts.find((t) => t.id === 'company_generic') || ts[0];
    return { template, score: hit ? hit.score : 0 };
  },
  upsert(tpl) {
    const data = load();
    if (!tpl.id) tpl.id = 'tpl_' + Math.random().toString(36).slice(2, 8);
    const idx = data.templates.findIndex((t) => t.id === tpl.id);
    const kind = ['industry', 'company', 'data', 'scan'].includes(tpl.kind) ? tpl.kind : 'company';
    const next = {
      ...tpl,
      kind,
      guidance: tpl.guidance || '',
      updatedAt: Date.now(),
    };
    if (idx >= 0) data.templates[idx] = { ...data.templates[idx], ...next };
    else data.templates.push({ builtin: false, ...next });
    save(data);
    return this.list();
  },

  remove(id) {
    const data = load();
    data.templates = data.templates.filter((t) => t.id !== id);
    save(data);
    return this.list();
  },

  // 把两个独立模板渲染成可注入 planning agent 的总览提示。
  toPrompt({ industryTpl, companyTpl } = {}) {
    return `【行业分析模板：${industryTpl?.name || '自动/通用'}】
适用场景：${industryTpl?.scope || '一般行业/主题分析'}
${industryTpl?.guidance || DEFAULT_INDUSTRY_GUIDANCE}

【公司分析模板：${companyTpl?.name || '自动/通用'}】
适用场景：${companyTpl?.scope || '一般公司基本面与估值分析'}
${companyTpl?.guidance || DEFAULT_COMPANY_GUIDANCE}`;
  },

  // —— 模板分类访问 ——
  industryTemplates() { return this.list().filter((t) => t.kind === 'industry'); },
  companyTemplates() { return this.list().filter((t) => t.kind === 'company'); },
  dataTemplates() { return this.list().filter((t) => t.kind === 'data'); },
  scanTemplates() { return this.list().filter((t) => t.kind === 'scan'); },

  // 发现型项目按主题命中扫描模板：行业变化类优先 scan_industry_change，否则受益股发现，兜底通用。
  matchScanTemplate(theme = '') {
    const ts = this.scanTemplates();
    const t = String(theme).toLowerCase();
    const changeHit = /变化|变革|转型|重构|替代|拐点|洗牌|change|shift|transition|disrupt/.test(t);
    const pick = (id) => ts.find((x) => x.id === id);
    const template = (changeHit && pick('scan_industry_change'))
      || pick('scan_beneficiary')
      || pick('scan_generic')
      || ts[0]
      || null;
    return { template, score: changeHit ? 1 : 0 };
  },

  // 扫描/筛选引导：注入给「宽发现 + 打分收敛」的 scan agent。
  scanPrompt(tpl) {
    return `【扫描/筛选模板${tpl ? '·' + tpl.name : ''}】\n${tpl?.guidance || DEFAULT_SCAN_GUIDANCE}`;
  },

  // 按主题命中的专有数据模板（keywords 命中；无则 null，将只用通用）
  matchDataTemplate(theme = '') {
    const t = String(theme).toLowerCase();
    return this.dataTemplates().find((dt) => dt.id !== 'data_general' && (dt.keywords || []).some((k) => t.includes(String(k).toLowerCase()))) || null;
  },

  // 高频数据挂载 = 通用模板 autoTools +（命中的）专有模板 autoTools，数据 sub-agent 逐个执行。
  autoToolsFor(theme = '') {
    const dts = this.dataTemplates();
    const general = dts.find((d) => d.id === 'data_general');
    const spec = this.matchDataTemplate(theme);
    return [...(general?.autoTools || []), ...(spec?.autoTools || [])].slice(0, 4);
  },

  dataTemplatesFor(theme = '') {
    const dts = this.dataTemplates();
    const general = dts.find((d) => d.id === 'data_general');
    const spec = this.matchDataTemplate(theme);
    return [general, spec].filter(Boolean);
  },

  // 数据获取引导 = 通用数据模板 +（命中的）专有数据模板，供数据 sub-agent 使用。
  dataGuidelineFor(theme = '') {
    const dts = this.dataTemplates();
    const general = dts.find((d) => d.id === 'data_general');
    const spec = this.matchDataTemplate(theme);
    return `【数据获取模板·通用】\n${general?.guidance || DEFAULT_DATA_GUIDELINE}`
      + (spec ? `\n\n【数据获取模板·专有：${spec.name}】\n${spec.guidance}` : '');
  },

  // —— 分层引导：行业分析 / 公司分析（数据获取见上）。模板可各自定义，缺省用通用引导 ——
  industryPrompt(tpl) {
    return `【行业分析模板${tpl ? '·' + tpl.name : ''}】\n${tpl?.guidance || DEFAULT_INDUSTRY_GUIDANCE}`;
  },
  companyPrompt(tpl) {
    return `【公司分析模板${tpl ? '·' + tpl.name : ''}】\n${tpl?.guidance || DEFAULT_COMPANY_GUIDANCE}`;
  },
};

// 通用分层引导（模板未定义对应块时的兜底）——底层引擎级别的「数据/行业/公司」三块方法论。
const DEFAULT_DATA_GUIDELINE = `目标：为本主题系统性收集"行业级 + 公司级"资料，并评估每个信息源的质量。
行业级：市场规模与增速、产业链结构、政策/技术/需求驱动、竞争格局与集中度、上下游与跨行业关联、景气高频指标。
公司级：业务与收入结构（多分部公司必须取分部数据）、财务(增长/利润率/现金流/资产负债)、前瞻共识与估值倍数、管理层财报会口径、内部人/机构动向、分析师观点与社交情绪。
竞争视角（每轮必备）：独立于公司自身口径的竞争对手/替代者资料——对手产品进展与相对竞争力、份额变化、替代技术、未上市竞争者的融资估值。管理层说"业务强劲"不构成竞争信息。
AI/算力链视角（命中 AI/半导体/HPC/GPU/TPU/ASIC/HBM/CoWoS 时必备）：全行业 capex 预算与订单流向，按买方→采购产品→芯片设计→晶圆制造→先进封装/HBM→收入确认公司整理，并标出客户切换和不确定性。
估值预期视角（每轮必备）：用当前价格/市值/前瞻倍数/反向 DCF 还原市场隐含的收入、EPS/FCF、利润率、capex intensity 或终端倍数，并与共识及熊/基/牛情景比较。
产出：整理后的源清单 + 关键数据摘录(按主题归类) + 每个来源的信息质量评估(覆盖度/时效/可靠度/是否一手)。标注数据缺口。`;
const DEFAULT_INDUSTRY_GUIDANCE = `围绕行业结构性变化展开：
1. 市场规模与增速：当前规模、增速、渗透率曲线位置、TAM 空间。
2. 市场推动力(drivers)：需求侧(新场景/政策/成本下降)与供给侧(产能/技术)的关键驱动变量及方向。
3. 竞争格局：集中度、龙头份额与壁垒、定价权、潜在进入者与替代威胁。
4. 跨行业影响：上下游传导、对相邻行业的外溢、宏观/利率/汇率敏感度。
5. AI/半导体/算力链必须建立 capex 与订单归属矩阵：谁付预算、买 GPU/TPU/ASIC/服务器/网络中的哪一类、谁设计、谁代工/封装/HBM、谁确认收入。
6. 估值隐含预期矩阵：当前价格/倍数隐含的增长、利润率、FCF 与 capex intensity 是否已反映行业乐观情景。
7. 结构性拐点与证伪信号：什么会加速/终结这轮结构性变化。
8. 多分部公司必须按收入分部拆开逐一分析（各分部所处市场的规模/周期位置、变现效率与单位经济、
   该收入池被谁争夺与替代技术进展、分部可比资产估值锚——含未上市可比的融资估值），禁止用单一行业视角概括多业务公司。`;
const DEFAULT_SCAN_GUIDANCE = `扫描/筛选方法（先宽后窄，最终进深度分析不超过 3 个）：
一、宽发现：围绕主题穷举 10-30 个有公开财务数据的相关标的，覆盖直接/间接/卖铲子等不同卡位。
二、打分（每个候选 0-100 + 一句 take）：受益强度、收入归属确定性、预期差、数据可得性、卡位与壁垒、可证伪性。
三、收敛：按综合分排序取前 3 进深度分析，其余作为上下文候选。用户指定标的必须保留并计入名额。`;
const DEFAULT_COMPANY_GUIDANCE = `从多维度评估公司：
1. 业务与卡位：主营与收入结构、在产业链中的位置与壁垒(护城河)。
2. 成长性：营收/利润/FCF 增速、驱动来源、可持续性与前瞻共识。
3. 盈利质量：毛利/净利率趋势、ROE/ROIC、现金流质量、资产负债健康度。
4. 估值：前瞻 PE/PS/PEG 与 DCF/目标价交叉校验，相对历史与同业分位；多分部公司加做分部估值加总(SOTP)交叉验证。
5. 估值隐含预期矩阵：当前价格/市值/前瞻倍数要求的收入、EPS/FCF、利润率、capex intensity 或终端倍数，与共识和熊/基/牛情景比较。
6. 客户/订单归属与切换：直接客户、终端买方、采购产品、谁设计/制造/封装/确认收入；客户从旧供应链切到新供应链对收入与利润率的影响。
7. 护城河威胁：谁/什么技术在争夺其核心收入池，替代进度与公司应对——用独立于公司口径的竞争视角资料判断。
8. 催化与风险：未来 1-3 季度催化剂、证伪条件、管理层与治理、内部人/机构信号。
9. 结论：该公司相对本主题的受益确定性与风险收益比。`;
