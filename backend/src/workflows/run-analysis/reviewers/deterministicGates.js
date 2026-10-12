// Deterministic workflow gate: it evaluates report structure without owning Agent policy.
const REQUIRED_SECTIONS = [
  { name: 'Investment Thesis', aliases: ['Investment Thesis', '投资逻辑', '投资论点', '投资主线'] },
  { name: 'Industry Analysis', aliases: ['Industry Analysis', '行业分析'] },
  { name: 'Company Analysis', aliases: ['Company Analysis', '公司分析'] },
  { name: 'Valuation', aliases: ['Valuation', '估值'] },
  { name: 'Risks', aliases: ['Risks', '风险', '风险因素'] },
];

function gateIssue(id, message, remediation) {
  return Object.freeze({
    id,
    severity: 'critical',
    owner: 'report',
    message,
    location: 'report',
    claim: '',
    evidenceRefs: [],
    remediation,
  });
}

function markdownOf(draftReport) {
  if (typeof draftReport === 'string') return draftReport;
  if (typeof draftReport?.markdown === 'string') return draftReport.markdown;
  return '';
}

function normalizeHeading(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^[\s]*(?:(?:\d+(?:\.\d+)*|[一二三四五六七八九十]+)[.)、:：-]?|第(?:\d+|[一二三四五六七八九十]+)[章节部分][.)、:：-]?)\s*/u, '')
    .replace(/[*_`]/gu, '')
    .replace(/[—–:：|/\\()[\]{}-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function markdownHeadings(markdown) {
  return [...String(markdown || '').matchAll(/^#{1,3}\s+(.+?)\s*#*\s*$/gmu)].map((match) => ({
    raw: match[1].trim(),
    normalized: normalizeHeading(match[1]),
  }));
}

function headingMatchesAlias(heading, alias) {
  const normalizedAlias = normalizeHeading(alias);
  return heading.normalized === normalizedAlias || heading.normalized.startsWith(`${normalizedAlias} `);
}

export function evaluateDeterministicReportQuality({ draftReport } = {}) {
  const markdown = markdownOf(draftReport);
  const headings = markdownHeadings(markdown);
  const requiredSections = REQUIRED_SECTIONS.map((section) => {
    const matched = headings.find((heading) => section.aliases.some((alias) => headingMatchesAlias(heading, alias)));
    return {
      name: section.name,
      present: Boolean(matched),
      matchedHeading: matched?.raw || null,
    };
  });
  const passedSections = requiredSections.filter((section) => section.present).length;
  const citationMarkerCount = (markdown.match(/\[src:\s*[^\]]+\]/giu) || []).length;
  return Object.freeze({
    markdownChars: markdown.length,
    headingCount: headings.length,
    requiredSections: Object.freeze(requiredSections.map(Object.freeze)),
    requiredSectionPassRate: requiredSections.length ? passedSections / requiredSections.length : 1,
    citationMarkerCount,
    hasAuditableCitation: citationMarkerCount > 0,
  });
}

export function runDeterministicReportGates({ draftReport } = {}) {
  const markdown = markdownOf(draftReport);
  const issues = [];
  if (!markdown.trim()) {
    issues.push(gateIssue('gate-empty-report', 'Report content is empty.', 'Generate a non-empty report from the existing artifacts.'));
    return issues;
  }
  const quality = evaluateDeterministicReportQuality({ draftReport: markdown });
  const missing = quality.requiredSections.filter((section) => !section.present).map((section) => section.name);
  if (missing.length) {
    issues.push(gateIssue('gate-required-sections', `Required section(s) missing: ${missing.join(', ')}.`, `Add the missing section(s): ${missing.join(', ')}.`));
  }
  if (!quality.hasAuditableCitation) {
    issues.push(gateIssue('gate-citations', 'No auditable [src: ...] citation marker was found.', 'Attach source markers to material claims or label them as estimates.'));
  }
  return issues;
}
