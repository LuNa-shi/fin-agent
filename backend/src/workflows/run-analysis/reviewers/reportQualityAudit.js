import { canonicalSha256, deepFreeze } from '../../../core/contracts/ArtifactRef.js';

export const REPORT_QUALITY_AUDIT_SCHEMA_VERSION = 'report-quality-audit.v1';

const DEFAULT_THRESHOLDS = Object.freeze({
  citationCoverage: 0.95,
  traceabilityCoverage: 1,
  requiredSectionPassRate: 1,
  unresolvedCriticalContradictions: 0,
});

const METADATA_HEADINGS = new Set([
  'table of contents', 'contents', 'metadata', 'document metadata', 'appendix metadata',
  '目录', '元数据', '文档信息',
]);
const MATERIAL_TERM_RE = /\b(?:valuation|value|price|target|dcf|multiple|p\/?e|ev\/?ebitda|upside|downside|return|revenue|sales|growth|grow|grew|margin|profit|earnings|eps|ebitda|fcf|free cash flow|cash flow|roe|roic|capex|capital expenditure|demand|supply|backlog|market share|pricing|cost|dilution|risk|invalidate|invalidation|falsif(?:y|ier|ication)|uncertainty|scenario|probability|rating|recommendation|recommend|buy|hold|sell|avoid|overweight|underweight|thesis|conviction|confidence|customer concentration)\b|(?:估值|价值|价格|目标价|合理价|市盈率|市销率|倍数|上行|下行|收益率|预期收益|收入|营收|销售额|增长|增速|毛利|利润率|净利润|盈利|每股收益|自由现金流|现金流|资本开支|需求|供给|供需|积压订单|市占率|市场份额|定价|成本|摊薄|稀释|风险|失效|证伪|不确定性|情景|概率|评级|推荐|买入|持有|卖出|回避|增持|减持|投资逻辑|投资论点|置信度|客户集中度)/iu;
const STRONG_RECOMMENDATION_RE = /\b(?:rating|recommendation|buy|hold|sell|avoid|overweight|underweight)\b|(?:评级|推荐|买入|持有|卖出|回避|增持|减持)/iu;
const NUMBER_RE = /[+-]?(?:[$€£¥￥]\s*)?\d[\d,]*(?:\.\d+)?(?:\s*(?:%|x|倍|bps?|bp|bn|mn|mm|billion|million|亿元|万元|港元|美元|元))?/giu;
const MARKER_RE_SOURCE = '\\[(?:src|est|open-issue)\\s*(?::\\s*[^\\]]*?)?\\]';

const BASE_SECTIONS = [
  {
    id: 'investment-thesis',
    label: 'Investment thesis',
    aliases: [
      'Investment thesis', 'Core thesis', 'Thesis',
      '投资逻辑', '投资论点', '核心论点', '核心投资逻辑', '投资主线',
    ],
  },
  {
    id: 'industry-external-drivers',
    label: 'Industry / external drivers',
    aliases: [
      'Industry analysis', 'Industry and external drivers', 'Industry & external drivers',
      'External drivers', 'Market and industry drivers',
      '行业分析', '行业与外部驱动', '外部驱动', '行业驱动', '宏观与行业驱动',
    ],
  },
  {
    id: 'company-analysis',
    label: 'Company analysis',
    aliases: [
      'Company analysis', 'Company fundamentals', 'Company analysis and fundamentals',
      '公司分析', '公司基本面', '企业分析',
    ],
  },
  {
    id: 'demand-supply-value-chain',
    label: 'Demand / supply / value chain',
    aliases: [
      'Demand supply and value chain', 'Demand / supply / value chain', 'Demand and supply',
      'Supply and demand', 'Value chain', 'Demand drivers', 'Supply analysis',
      '供需与价值链', '需求供给与价值链', '供需分析', '需求分析', '供给分析', '产业链', '价值链',
    ],
  },
  {
    id: 'valuation',
    label: 'Valuation',
    aliases: [
      'Valuation', 'Valuation-implied expectations', 'Valuation and scenarios',
      '估值', '估值隐含预期', '估值与情景',
    ],
  },
  {
    id: 'risks-invalidation',
    label: 'Risks / invalidation',
    aliases: [
      'Risks and invalidation', 'Risks', 'Risk factors', 'Key risk', 'Key risks', 'Risks / falsifiers',
      'Bear case and invalidation',
      '风险与失效条件', '风险因素', '风险', '关键风险', '主要风险', '失效条件', '证伪条件',
    ],
  },
  {
    id: 'reflection-open-questions-summary',
    label: 'Reflection / open questions / summary',
    aliases: [
      'Reflection', 'Open questions', 'Summary', 'Conclusion', 'Reflection and open questions',
      'Open questions and summary', 'Key takeaways', 'Executive summary', 'Investment conclusion',
      'Conclusion and recommendation',
      '反思', '开放问题', '待解决问题', '总结', '结论', '执行摘要', '投资结论', '反思与开放问题',
    ],
  },
];

export const BASE_REPORT_SECTION_PROFILE = deepFreeze({
  id: 'qa-01-seven-section-base.v1',
  sections: BASE_SECTIONS.map((section) => ({ ...section, required: true })),
});

const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function string(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(value) {
  return [...new Set(array(value).map(string).filter(Boolean))];
}

function ratio(numerator, denominator) {
  return denominator > 0 ? +(numerator / denominator).toFixed(4) : 0;
}

function boundedRatio(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 ? numeric : fallback;
}

function markdownOf(report) {
  if (typeof report === 'string') return report;
  if (typeof report?.markdown === 'string') return report.markdown;
  return '';
}

function normalizeLabel(value) {
  return string(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^[`'"‘’“”]+|[`'"‘’“”]+$/gu, '')
    .replace(/\\/gu, '/')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeHeading(value) {
  return normalizeLabel(value)
    .replace(/^(?:(?:\d+(?:\.\d+)*|[一二三四五六七八九十]+)[.)、:：-]?|第(?:\d+|[一二三四五六七八九十]+)[章节部分][.)、:：-]?)\s*/u, '')
    .replace(/[*_`]/gu, '')
    .replace(/[—–:：|/\\()[\]{}-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function headingMatches(heading, alias) {
  const normalizedHeading = normalizeHeading(heading);
  const normalizedAlias = normalizeHeading(alias);
  return normalizedHeading === normalizedAlias || normalizedHeading.startsWith(`${normalizedAlias} `);
}

function normalizeSection(section, index) {
  const value = object(section);
  const id = string(value.id) || `section-${index + 1}`;
  const label = string(value.label) || id;
  const aliases = uniqueStrings([label, ...array(value.aliases)]);
  if (aliases.length === 0) throw new TypeError(`Report section ${id} requires at least one alias`);
  return { id, label, required: value.required !== false, aliases };
}

export function createReportSectionProfile({ id = 'case-specific-report-profile', sections = BASE_REPORT_SECTION_PROFILE.sections } = {}) {
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new TypeError('Report section profile requires a non-empty sections array');
  }
  const normalized = sections.map(normalizeSection);
  const ids = normalized.map((section) => section.id);
  if (new Set(ids).size !== ids.length) throw new TypeError('Report section profile contains duplicate section ids');
  if (!normalized.some((section) => section.required)) {
    throw new TypeError('Report section profile requires at least one required section');
  }
  return deepFreeze({ id: string(id) || 'case-specific-report-profile', sections: normalized });
}

function profileOf(sectionProfile) {
  if (sectionProfile === undefined || sectionProfile === null) return BASE_REPORT_SECTION_PROFILE;
  if (Array.isArray(sectionProfile)) return createReportSectionProfile({ sections: sectionProfile });
  return createReportSectionProfile(sectionProfile);
}

function markdownLines(markdown) {
  const rawLines = String(markdown || '').split('\n');
  const lines = [];
  let offset = 0;
  let fence = null;
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index];
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const fenceMatch = text.match(/^\s{0,3}(`{3,}|~{3,})/u);
    let inFence = Boolean(fence);
    if (!fence && fenceMatch) {
      fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
      inFence = true;
    } else if (fence && fenceMatch && fenceMatch[1][0] === fence.character && fenceMatch[1].length >= fence.length) {
      inFence = true;
      fence = null;
    }
    lines.push({ number: index + 1, start: offset, end: offset + text.length, text, inFence });
    offset += raw.length + (index < rawLines.length - 1 ? 1 : 0);
  }
  return lines;
}

function markerParts(content) {
  const value = String(content || '');
  const starts = [...value.matchAll(/(?:^|;\s*)(src|est|open-issue)\b\s*(?::\s*)?/giu)];
  return starts.map((match, index) => {
    const kind = match[1].toLowerCase();
    const labelStart = match.index + match[0].length;
    const labelEnd = starts[index + 1]?.index ?? value.length;
    const label = string(value.slice(labelStart, labelEnd).replace(/;\s*$/u, '')) || null;
    return {
      kind,
      label,
      raw: `[${kind}${label ? `: ${label}` : ''}]`,
      offset: match.index,
      valid: kind !== 'src' || Boolean(label),
    };
  });
}

function parseMarkdown(markdown) {
  const lines = markdownLines(markdown);
  const headings = [];
  const markers = [];
  const blocks = [];
  let activeHeading = null;
  let headingPath = [];
  let activeBlock = null;

  const closeBlock = () => {
    if (!activeBlock) return;
    activeBlock.text = activeBlock.lineRecords.map((line) => line.text).join('\n').trim();
    blocks.push(activeBlock);
    activeBlock = null;
  };

  for (const line of lines) {
    if (line.inFence) {
      closeBlock();
      continue;
    }
    const headingMatch = line.text.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (headingMatch) {
      closeBlock();
      activeHeading = {
        level: headingMatch[1].length,
        raw: headingMatch[2].trim(),
        normalized: normalizeHeading(headingMatch[2]),
        line: line.number,
        index: line.start,
      };
      headingPath = headingPath.filter((heading) => heading.level < activeHeading.level);
      headingPath.push(activeHeading);
      headings.push(activeHeading);
      continue;
    }
    if (!line.text.trim()) {
      closeBlock();
      continue;
    }
    if (!activeBlock) {
      activeBlock = {
        start: line.start,
        end: line.end,
        startLine: line.number,
        endLine: line.number,
        heading: activeHeading,
        headingPath: [...headingPath],
        lineRecords: [],
      };
    }
    activeBlock.end = line.end;
    activeBlock.endLine = line.number;
    activeBlock.lineRecords.push(line);
    for (const group of line.text.matchAll(/\[([^\]\n]+)\]/gu)) {
      for (const marker of markerParts(group[1])) {
        markers.push({
          kind: marker.kind,
          label: marker.label,
          raw: marker.raw,
          index: line.start + group.index + marker.offset,
          line: line.number,
          column: group.index + marker.offset + 1,
          valid: marker.valid,
        });
      }
    }
  }
  closeBlock();
  return { lines, headings, markers, blocks };
}

export function parseReportMarkers(report) {
  return deepFreeze(parseMarkdown(markdownOf(report)).markers);
}

function blockSectionIds(block, profile) {
  for (const heading of [...array(block?.headingPath)].reverse()) {
    const ids = claimSectionIds(heading, profile);
    if (ids.length) return ids;
  }
  return claimSectionIds(block?.heading, profile);
}

function blockSectionHeading(block, profile) {
  for (const heading of [...array(block?.headingPath)].reverse()) {
    if (claimSectionIds(heading, profile).length) return heading;
  }
  return null;
}

function metadataSection(block) {
  return array(block?.headingPath).some((heading) => METADATA_HEADINGS.has(heading.normalized));
}

function isTableRow(value) {
  const text = string(value);
  return text.includes('|') && (text.match(/\|/gu) || []).length >= 2;
}

function isTableSeparator(value) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(String(value || ''));
}

function sentenceCandidates(value) {
  const text = String(value || '');
  const candidates = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1] || '';
    const previous = text[index - 1] || '';
    const hardBoundary = /[。！？!?]/u.test(character);
    const periodBoundary = character === '.'
      && !(/\d/u.test(previous) && /\d/u.test(next))
      && (!next || /\s/u.test(next));
    if (!hardBoundary && !periodBoundary) continue;
    const candidate = text.slice(start, index + 1).trim();
    if (candidate) candidates.push(candidate);
    start = index + 1;
  }
  const remainder = text.slice(start).trim();
  if (remainder) candidates.push(remainder);
  return candidates;
}

function stripStructuralPrefix(value, { table = false } = {}) {
  let text = String(value || '').trim();
  if (table) {
    if (text.startsWith('|')) text = text.slice(1).trimStart();
    if (text.endsWith('|')) text = text.slice(0, -1).trimEnd();
  } else {
    text = text
      .replace(/^(?:>\s*)+/u, '')
      .replace(/^(?:[-+*]\s+|\d+[.)]\s+|[（(]?[一二三四五六七八九十]+[）)、.]\s*)/u, '');
  }
  const trailingMarkers = new RegExp(`\\s*(?:${MARKER_RE_SOURCE}\\s*)+[.!?。！？]*$`, 'iu');
  const markerSuffix = text.match(trailingMarkers);
  if (markerSuffix?.index > 0) text = text.slice(0, markerSuffix.index).trimEnd();
  return text.trim();
}

function plainCandidate(value) {
  return string(value)
    .replace(new RegExp(MARKER_RE_SOURCE, 'giu'), ' ')
    .replace(/\[[^\]]+\]\(#[^)]+\)/gu, ' ')
    .replace(/[*_`~]/gu, '')
    .replace(/^\|+|\|+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function metadataCandidate(value) {
  const plain = plainCandidate(value);
  if (!plain) return true;
  if (/^(?:generated(?: at| on)?|date|as of|ticker(?:s)?|author|language|model|run id|project id|provider|source(?:s)?)\s*[:：]/iu.test(plain)) return true;
  if (/^(?:生成时间|生成于|日期|截至日期|股票代码|作者|语言|模型|运行编号|项目编号|提供方|来源)\s*[:：]/u.test(plain)) return true;
  if (/^(?:role boundar(?:y|ies)|scope boundar(?:y|ies)|角色边界|职责边界)\s*[:：]/iu.test(plain)) return true;
  if (/^(?:outside role|out[- ]of[- ]scope|职责外|范围外)\s*(?:[:：]|\|)/iu.test(plain)) return true;
  if (/^(?:[-+*]\s+|\d+[.)]\s+)?\[[^\]]+\]\(#[^)]+\)$/u.test(string(value))) return true;
  if (/\.{3,}\s*\d+\s*$/u.test(plain)) return true;
  if (/^(?:https?:\/\/|qa-frozen:\/\/|source:|evidence:)[^\s]+$/iu.test(plain)) return true;
  return false;
}

function materialCandidate(value) {
  const plain = plainCandidate(value);
  if (metadataCandidate(value)) return false;
  const numbers = plain.match(NUMBER_RE) || [];
  const hasMaterialTerm = MATERIAL_TERM_RE.test(plain);
  if (!hasMaterialTerm && numbers.length < 2) return false;
  const semanticLength = (plain.match(/[\p{L}\p{N}]/gu) || []).length;
  if (semanticLength < (numbers.length >= 2 ? 2 : 8)) return false;
  const cjkLength = (plain.match(/[\p{Script=Han}]/gu) || []).length;
  const wordCount = (plain.match(/[\p{L}\p{N}]+/gu) || []).length;
  if (cjkLength < 6 && wordCount < 3 && numbers.length === 0 && !STRONG_RECOMMENDATION_RE.test(plain)) return false;
  if (/^(?:metric|value|source|base case|bull case|bear case|指标|数值|来源|基准情景|乐观情景|悲观情景)\s*[:：]?$/iu.test(plain)) return false;
  return true;
}

function candidateRecords(block) {
  const records = array(block?.lineRecords);
  const tableLike = records.some((line) => isTableRow(line.text));
  if (tableLike) {
    return records.flatMap((line, index) => {
      if (!isTableRow(line.text) || isTableSeparator(line.text) || isTableSeparator(records[index + 1]?.text)) return [];
      const assertion = stripStructuralPrefix(line.text, { table: true });
      return assertion ? [{ assertion, reportLine: line.number, sourceKind: 'table-row', table: true }] : [];
    });
  }
  return records.flatMap((line) => {
    const base = stripStructuralPrefix(line.text);
    return sentenceCandidates(base).map((assertion) => ({
      assertion: stripStructuralPrefix(assertion),
      reportLine: line.number,
      sourceKind: 'body',
      table: false,
    }));
  });
}

export function deriveMaterialClaimsFromReport(report, { sectionProfile } = {}) {
  const markdown = markdownOf(report);
  const profile = profileOf(sectionProfile);
  const parsed = parseMarkdown(markdown);
  const seen = new Set();
  const claims = [];
  for (const block of parsed.blocks) {
    if (metadataSection(block)) continue;
    const sectionIds = blockSectionIds(block, profile);
    const sectionHeading = blockSectionHeading(block, profile);
    for (const candidate of candidateRecords(block)) {
      const assertion = string(candidate.assertion);
      if (!assertion || !materialCandidate(assertion)) continue;
      const key = normalizeLabel(plainCandidate(assertion));
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const location = block.heading?.raw || sectionHeading?.raw || null;
      const sectionId = sectionIds[0] || 'additional-section';
      claims.push({
        claimId: `report-claim:${canonicalSha256({ assertion, location, reportLine: candidate.reportLine, sectionId }).slice('sha256:'.length)}`,
        assertion,
        material: true,
        location,
        sectionId,
        reportLine: candidate.reportLine,
        sourceKind: candidate.sourceKind,
      });
    }
  }
  return deepFreeze(claims);
}

function pathAliases(value) {
  const normalized = string(value).replace(/\\/gu, '/');
  if (!normalized) return [];
  const basename = normalized.split('/').filter(Boolean).at(-1) || normalized;
  const withoutExtension = basename.replace(/\.[^.]+$/u, '');
  return uniqueStrings([normalized, basename, withoutExtension]);
}

function metadataAliases(metadata) {
  const value = object(metadata);
  return uniqueStrings([
    value.label, value.citationLabel, value.name,
    ...array(value.labels), ...array(value.citationLabels), ...array(value.aliases),
  ]);
}

function createSourceIndex({ sourceDocuments, evidenceItems, citationLedger, manifest } = {}) {
  const aliases = new Map();
  const targets = new Map();
  const ledgerActive = citationLedger !== null && citationLedger !== undefined;
  const navigationAliases = new Set(array(citationLedger?.navigationOnlyArtifacts)
    .flatMap((entry) => array(entry?.labels))
    .map(normalizeLabel)
    .filter(Boolean));
  const ledgerAliases = new Map(array(citationLedger?.aliases).map((entry) => [
    normalizeLabel(entry?.alias),
    string(entry?.sourceId),
  ]).filter(([alias, sourceId]) => alias && sourceId && !navigationAliases.has(alias)));

  const add = (target, rawAliases) => {
    const id = string(target.id);
    if (!id) return;
    const key = `${target.kind}:${id}`;
    if (!targets.has(key)) targets.set(key, deepFreeze({ ...target, id }));
    for (const rawAlias of uniqueStrings(rawAliases)) {
      const alias = normalizeLabel(rawAlias);
      if (!alias) continue;
      if (!aliases.has(alias)) aliases.set(alias, new Set());
      aliases.get(alias).add(key);
    }
  };

  for (const source of array(sourceDocuments)) {
    const value = object(source);
    const id = string(value.sourceId || value.id);
    const semanticAliases = uniqueStrings([value.title, ...metadataAliases(value.metadata)]);
    const approvedSemanticAliases = ledgerActive
      ? semanticAliases.filter((alias) => ledgerAliases.get(normalizeLabel(alias)) === id)
      : semanticAliases;
    add({ kind: 'source-document', id, sourceId: id }, [
      id,
      ...(ledgerActive ? [] : [value.contentHash, value.uri, value.url, ...pathAliases(value.uri || value.url)]),
      ...approvedSemanticAliases,
    ]);
  }

  for (const evidence of array(evidenceItems)) {
    const value = object(evidence);
    const id = string(value.evidenceId || value.id);
    add({ kind: 'evidence-item', id, evidenceId: id, sourceId: string(value.sourceId) || null }, [
      id,
      ...(ledgerActive ? [] : [value.sourceId, value.label, value.title, ...array(value.labels), ...array(value.aliases)]),
    ]);
  }

  for (const entry of array(citationLedger?.sources)) {
    const sourceId = string(entry?.sourceId);
    add({ kind: 'source-document', id: sourceId, sourceId }, [sourceId]);
  }
  for (const entry of array(citationLedger?.aliases)) {
    if (navigationAliases.has(normalizeLabel(entry?.alias))) continue;
    const sourceId = string(entry?.sourceId);
    add({ kind: 'source-document', id: sourceId, sourceId }, [entry?.alias]);
  }
  for (const entry of array(citationLedger?.ambiguousAliases)) {
    if (navigationAliases.has(normalizeLabel(entry?.alias))) continue;
    for (const sourceId of array(entry?.sourceIds)) {
      add({ kind: 'source-document', id: string(sourceId), sourceId: string(sourceId) }, [entry?.alias]);
    }
  }
  for (const entry of array(citationLedger?.evidenceItems)) {
    const evidenceId = string(entry?.evidenceId);
    add({ kind: 'evidence-item', id: evidenceId, evidenceId, sourceId: string(entry?.sourceId) || null }, [evidenceId]);
  }

  const visited = new Set();
  const visitManifest = (input) => {
    if (input === null || input === undefined) return;
    if (Array.isArray(input)) {
      for (const item of input) visitManifest(item);
      return;
    }
    if (typeof input === 'string') {
      add({ kind: 'manifest-ref', id: input }, [input, ...pathAliases(input)]);
      return;
    }
    if (typeof input !== 'object' || visited.has(input)) return;
    visited.add(input);
    const value = object(input);
    if (value.ref && typeof value.ref === 'object') visitManifest(value.ref);
    const artifactId = string(value.artifactId);
    const evidenceId = string(value.evidenceId);
    const sourceId = string(value.sourceId);
    const genericId = string(value.id);
    const path = string(value.path);
    const uri = string(value.uri || value.url);
    const id = evidenceId || sourceId || (artifactId ? `${artifactId}${value.version ? `@${value.version}` : ''}` : '') || genericId || path || uri;
    if (id) {
      const kind = evidenceId ? 'manifest-evidence' : (sourceId ? 'manifest-source' : (artifactId ? 'artifact' : 'manifest-entry'));
      add({ kind, id, evidenceId: evidenceId || null, sourceId: sourceId || null, artifactId: artifactId || null }, [
        evidenceId, sourceId, artifactId, genericId, path, uri,
        value.title, ...metadataAliases(value),
        value.contentDigest, ...pathAliases(path), ...pathAliases(uri),
        ...metadataAliases(value.metadata),
      ]);
    }
    for (const key of [
      'versions', 'rounds', 'sources', 'sourceRefs', 'evidenceRefs', 'artifacts', 'entries',
      'items', 'refs', 'documents', 'evidenceItems', 'manifest', 'manifests', 'sourceManifest', 'artifactManifest',
    ]) {
      if (value[key] !== undefined) visitManifest(value[key]);
    }
  };
  visitManifest(manifest);

  return {
    resolve(label) {
      const keys = aliases.get(normalizeLabel(label));
      return keys ? [...keys].map((key) => targets.get(key)).filter(Boolean) : [];
    },
  };
}

function markerResolutions(markers, sourceIndex) {
  return markers.map((marker) => {
    if (marker.kind !== 'src') return {
      ...marker,
      resolved: marker.valid,
      traceable: marker.valid,
      targets: [],
      traceableTargets: [],
    };
    const targets = marker.valid ? sourceIndex.resolve(marker.label) : [];
    const traceableTargets = targets.filter((target) => (
      target.kind === 'source-document' || target.kind === 'evidence-item'
    ));
    // Generic manifest/artifact entries can legitimately repeat the identifier of an
    // atomic SourceDocument or EvidenceItem. Once an atomic target exists, use only
    // those targets to decide provenance ambiguity so navigation metadata cannot
    // shadow an otherwise unique, traceable source.
    const provenanceTargets = traceableTargets.length ? traceableTargets : targets;
    const provenanceRoots = new Set(provenanceTargets.map((target) => {
      if (target.sourceId) return `source:${target.sourceId}`;
      if (target.evidenceId) return `evidence:${target.evidenceId}`;
      if (target.artifactId) return `artifact:${target.artifactId}`;
      return `${target.kind}:${target.id}`;
    }));
    const resolved = provenanceRoots.size === 1;
    return {
      ...marker,
      resolved,
      traceable: resolved && traceableTargets.length > 0,
      ambiguous: targets.length > 0 && !resolved,
      targets,
      traceableTargets: resolved ? traceableTargets : [],
    };
  });
}

function claimAssertion(claim) {
  const value = object(claim);
  return string(value.assertion || value.claim || value.text || value.statement || value.fact);
}

function claimSectionIds(heading, profile) {
  if (!heading) return [];
  return profile.sections
    .filter((section) => section.aliases.some((alias) => headingMatches(heading.raw, alias)))
    .map((section) => section.id);
}

function findClaimBlock(claim, parsed, profile) {
  const assertion = claimAssertion(claim);
  if (!assertion) return { status: 'missing-assertion', assertion, block: null };
  const normalizedAssertion = normalizeLabel(assertion);
  const requestedLocation = string(claim?.location);
  const requestedSectionId = string(claim?.sectionId);
  const requestedKnownSection = requestedSectionId
    && profile.sections.some((section) => section.id === requestedSectionId);
  const requestedLine = Number.isInteger(claim?.reportLine) ? claim.reportLine : null;
  const candidates = parsed.blocks.filter((block) => {
    if (!normalizeLabel(block.text).includes(normalizedAssertion)) return false;
    if (requestedLine !== null && (requestedLine < block.startLine || requestedLine > block.endLine)) return false;
    if (requestedLocation && (!block.heading || !headingMatches(block.heading.raw, requestedLocation))) return false;
    if (requestedKnownSection && !blockSectionIds(block, profile).includes(requestedSectionId)) return false;
    return true;
  });
  if (candidates.length === 0) return { status: 'not-found', assertion, block: null };
  if (candidates.length > 1) return { status: 'ambiguous', assertion, block: null };
  return { status: 'located', assertion, block: candidates[0] };
}

function auditClaims(claims, parsed, resolvedMarkers, profile) {
  const materialClaims = array(claims).filter((claim) => claim?.material !== false);
  const audits = materialClaims.map((claim, index) => {
    const located = findClaimBlock(claim, parsed, profile);
    const reportLine = Number.isInteger(claim?.reportLine) ? claim.reportLine : null;
    const restrictMarkersToReportLine = reportLine !== null && claim?.sourceKind === 'table-row';
    const markers = located.block
      ? resolvedMarkers.filter((marker) => (
        marker.index >= located.block.start
        && marker.index <= located.block.end
        && (!restrictMarkersToReportLine || marker.line === reportLine)
      ))
      : [];
    const sourceMarkers = markers.filter((marker) => marker.kind === 'src');
    const resolvedSources = sourceMarkers.filter((marker) => marker.resolved);
    const traceableSources = sourceMarkers.filter((marker) => marker.traceable);
    const unresolvedSources = sourceMarkers.filter((marker) => !marker.resolved);
    const estimateMarkers = markers.filter((marker) => marker.kind === 'est' && marker.resolved);
    const openIssueMarkers = markers.filter((marker) => marker.kind === 'open-issue' && marker.resolved);
    // Citation coverage measures factual-source discipline. Claims explicitly classified only as
    // estimates/open issues are audited by traceability, while any claim carrying a source marker
    // (including an unresolved one) remains citation-eligible and must resolve.
    const citationRequired = sourceMarkers.length > 0
      || (estimateMarkers.length === 0 && openIssueMarkers.length === 0);
    const cited = located.status === 'located' && resolvedSources.length > 0;
    const traceable = located.status === 'located' && (
      traceableSources.length > 0 || estimateMarkers.length > 0 || openIssueMarkers.length > 0
    );
    return {
      claimId: string(claim?.claimId || claim?.id) || `claim-${index + 1}`,
      assertion: located.assertion,
      reportLine: reportLine ?? located.block?.startLine ?? null,
      locationStatus: located.status,
      heading: located.block?.heading?.raw || null,
      sectionIds: blockSectionIds(located.block, profile),
      markerCount: markers.length,
      sourceMarkerCount: sourceMarkers.length,
      resolvedSourceMarkerCount: resolvedSources.length,
      traceableSourceMarkerCount: traceableSources.length,
      unresolvedSourceLabels: uniqueStrings(unresolvedSources.map((marker) => marker.label || marker.raw)),
      estimateMarkerCount: estimateMarkers.length,
      openIssueMarkerCount: openIssueMarkers.length,
      citationRequired,
      resolvedTargets: resolvedSources.flatMap((marker) => marker.targets),
      traceableTargets: traceableSources.flatMap((marker) => marker.traceableTargets),
      cited,
      traceable,
    };
  });
  const cited = audits.filter((claim) => claim.cited).length;
  const citationEligible = audits.filter((claim) => claim.citationRequired).length;
  const traceable = audits.filter((claim) => claim.traceable).length;
  const located = audits.filter((claim) => claim.locationStatus === 'located').length;
  return {
    materialClaims: audits.length,
    citationEligibleMaterialClaims: citationEligible,
    locatedMaterialClaims: located,
    citedMaterialClaims: cited,
    traceableMaterialClaims: traceable,
    citationCoverage: ratio(cited, citationEligible),
    traceabilityCoverage: ratio(traceable, audits.length),
    locationCoverage: ratio(located, audits.length),
    audits,
  };
}

function isResolved(record) {
  if (record?.resolved === true) return true;
  return ['resolved', 'adjudicated', 'dismissed', 'superseded', 'closed']
    .includes(string(record?.status || record?.resolution).toLowerCase());
}

function isStandardDataContradiction(record) {
  return Boolean(
    string(record?.topic)
    && Object.prototype.hasOwnProperty.call(object(record), 'conflicting')
    && Object.prototype.hasOwnProperty.call(object(record), 'hypothesis')
    && Object.prototype.hasOwnProperty.call(object(record), 'resolveBy')
  );
}

function contradictedClaims(claims, contradictions) {
  const candidates = [
    ...array(contradictions).map((record) => ({ ...object(record), _contradictionRecord: true })),
    ...array(claims).filter((claim) => (
      claim?.contradicted === true
      || ['contradicted', 'conflicted'].includes(string(claim?.status || claim?.verdict).toLowerCase())
    )),
  ];
  const seen = new Set();
  const unresolved = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const record = candidates[index];
    const isContradiction = record._contradictionRecord === true
      || record.contradicted === true
      || ['contradicted', 'conflicted'].includes(string(record.status || record.verdict).toLowerCase());
    if (!isContradiction || record.material === false || isResolved(record)) continue;
    if (!(
      record.critical === true
      || string(record.severity).toLowerCase() === 'critical'
      || isStandardDataContradiction(record)
    )) continue;
    const id = string(record.claimId || record.id || record.issueId || record.topic) || `contradiction-${index + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const { _contradictionRecord: _, ...publicRecord } = record;
    unresolved.push({ id, ...publicRecord });
  }
  return unresolved;
}

function blockHasSubstantiveContent(block) {
  return candidateRecords(block).some((candidate) => {
    const content = plainCandidate(candidate.assertion);
    if (!content || metadataCandidate(candidate.assertion)) return false;
    if (/^(?:n\/?a|none|nil|tbd|todo|pending|待补充|暂无|无)$/iu.test(content)) return false;
    if (/^[\p{L}\p{N}\s/_-]+[:：]$/u.test(content)) return false;
    return (content.match(/[\p{L}\p{N}]/gu) || []).length >= 4;
  });
}

function headingOwnsBlock(heading, block) {
  return array(block?.headingPath).some((candidate) => (
    candidate.index === heading.index && candidate.level === heading.level
  ));
}

function sectionAudit(profile, headings, blocks) {
  const sections = profile.sections.map((section) => {
    const matches = headings.filter((heading) => (
      section.aliases.some((alias) => headingMatches(heading.raw, alias))
    ));
    const substantiveMatches = matches.filter((heading) => (
      blocks.some((block) => headingOwnsBlock(heading, block) && blockHasSubstantiveContent(block))
    ));
    return {
      id: section.id,
      label: section.label,
      required: section.required,
      present: matches.length > 0,
      substantive: substantiveMatches.length > 0,
      matchedHeadings: matches.map((heading) => heading.raw),
      substantiveHeadings: substantiveMatches.map((heading) => heading.raw),
    };
  });
  const required = sections.filter((section) => section.required);
  const passed = required.filter((section) => section.present && section.substantive).length;
  return {
    profileId: profile.id,
    headingCount: headings.length,
    requiredSectionCount: required.length,
    passedRequiredSections: passed,
    requiredSectionPassRate: ratio(passed, required.length),
    sections,
  };
}

function thresholdsOf(value) {
  const input = object(value);
  const contradictionLimit = Number(input.unresolvedCriticalContradictions);
  return {
    citationCoverage: boundedRatio(input.citationCoverage, DEFAULT_THRESHOLDS.citationCoverage),
    traceabilityCoverage: boundedRatio(input.traceabilityCoverage, DEFAULT_THRESHOLDS.traceabilityCoverage),
    requiredSectionPassRate: boundedRatio(input.requiredSectionPassRate, DEFAULT_THRESHOLDS.requiredSectionPassRate),
    unresolvedCriticalContradictions: Number.isInteger(contradictionLimit) && contradictionLimit >= 0
      ? contradictionLimit
      : DEFAULT_THRESHOLDS.unresolvedCriticalContradictions,
  };
}

export function auditReportQuality({
  report,
  sectionProfile,
  materialClaims = [],
  sourceDocuments = [],
  evidenceItems = [],
  citationLedger = null,
  manifest = null,
  manifests = [],
  contradictions = [],
  thresholds,
} = {}) {
  const markdown = markdownOf(report);
  const profile = profileOf(sectionProfile);
  const parsed = parseMarkdown(markdown);
  const sourceIndex = createSourceIndex({ sourceDocuments, evidenceItems, citationLedger, manifest: [manifest, ...array(manifests)] });
  const resolvedMarkers = markerResolutions(parsed.markers, sourceIndex);
  const structure = sectionAudit(profile, parsed.headings, parsed.blocks);
  const claims = auditClaims(materialClaims, parsed, resolvedMarkers, profile);
  const unresolvedContradictions = contradictedClaims(materialClaims, contradictions);
  const limits = thresholdsOf(thresholds);
  const sourceMarkers = resolvedMarkers.filter((marker) => marker.kind === 'src');
  const unresolvedSourceMarkers = sourceMarkers.filter((marker) => !marker.resolved);
  const markers = {
    total: resolvedMarkers.length,
    source: sourceMarkers.length,
    estimate: resolvedMarkers.filter((marker) => marker.kind === 'est').length,
    openIssue: resolvedMarkers.filter((marker) => marker.kind === 'open-issue').length,
    resolvedSourceMarkers: sourceMarkers.length - unresolvedSourceMarkers.length,
    unresolvedSourceMarkers: unresolvedSourceMarkers.length,
    unresolvedSourceLabels: uniqueStrings(unresolvedSourceMarkers.map((marker) => marker.label || marker.raw)),
    items: resolvedMarkers,
  };
  const contradictionsResult = {
    unresolvedCriticalContradictedMaterialClaims: unresolvedContradictions.length,
    items: unresolvedContradictions,
  };
  const checks = {
    nonEmptyReport: markdown.trim().length > 0,
    requiredSections: structure.requiredSectionPassRate >= limits.requiredSectionPassRate,
    materialClaimPopulation: claims.materialClaims > 0,
    materialClaimsLocated: claims.materialClaims > 0 && claims.locationCoverage === 1,
    sourceLabelsResolved: unresolvedSourceMarkers.length === 0,
    citationCoverage: claims.materialClaims > 0 && claims.citationCoverage >= limits.citationCoverage,
    traceabilityCoverage: claims.materialClaims > 0 && claims.traceabilityCoverage >= limits.traceabilityCoverage,
    criticalContradictions: unresolvedContradictions.length <= limits.unresolvedCriticalContradictions,
  };
  return deepFreeze({
    schemaVersion: REPORT_QUALITY_AUDIT_SCHEMA_VERSION,
    thresholds: limits,
    markdownChars: markdown.length,
    structure,
    markers,
    claims,
    contradictions: contradictionsResult,
    checks,
    passed: Object.values(checks).every(Boolean),
  });
}
