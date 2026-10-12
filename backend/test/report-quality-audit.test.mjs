import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEvidenceItem,
  createSourceDocument,
} from '../src/domains/research/evidence/evidenceContracts.js';
import {
  auditReportQuality,
  BASE_REPORT_SECTION_PROFILE,
  createReportSectionProfile,
  deriveMaterialClaimsFromReport,
  parseReportMarkers,
  REPORT_QUALITY_AUDIT_SCHEMA_VERSION,
} from '../src/workflows/run-analysis/reviewers/reportQualityAudit.js';

const asOf = '2026-07-16T00:00:00.000Z';

function evidenceFixture() {
  const filingCitationLabel = 'acme-10q-2026q2';
  const transcriptCitationLabel = 'acme-transcript-2026q2';
  const filing = createSourceDocument({
    provider: 'edgar',
    uri: 'edgar://ACME/10-Q/2026Q2',
    title: 'ACME 2026 Q2 10-Q',
    content: 'Revenue increased 20% and gross margin reached 60%.',
    publishedAt: asOf,
    observedAt: asOf,
    fetchedAt: asOf,
    entityIds: ['ticker:ACME'],
    asOfSafe: true,
    metadata: { citationLabels: [filingCitationLabel] },
  });
  const transcript = createSourceDocument({
    provider: 'fmp',
    uri: 'fmp://transcript/ACME/2026Q2',
    title: "ACME transcript Q2'26",
    content: 'Management expects capacity additions next quarter.',
    publishedAt: asOf,
    observedAt: asOf,
    fetchedAt: asOf,
    entityIds: ['ticker:ACME'],
    asOfSafe: true,
    metadata: { citationLabels: [transcriptCitationLabel] },
  });
  const revenue = createEvidenceItem({
    sourceId: filing.sourceId,
    entityIds: ['ticker:ACME'],
    statement: 'Revenue increased 20%.',
    publishedAt: asOf,
    observedAt: asOf,
    locator: { section: 'Income statement' },
    evidenceType: 'fact',
    confidence: 1,
  });
  const capacity = createEvidenceItem({
    sourceId: transcript.sourceId,
    entityIds: ['ticker:ACME'],
    statement: 'Management expects capacity additions next quarter.',
    publishedAt: asOf,
    observedAt: asOf,
    locator: { section: 'Capacity outlook' },
    evidenceType: 'management_statement',
    confidence: 0.9,
  });
  return {
    sourceDocuments: [filing, transcript],
    evidenceItems: [revenue, capacity],
    filing,
    transcript,
    revenue,
    capacity,
    filingCitationLabel,
    transcriptCitationLabel,
  };
}

const englishHeadings = `# ACME research

## 1. Investment thesis
## 2. Industry analysis and external drivers
## 3. Company analysis
## 4. Demand / supply / value chain
## 5. Valuation-implied expectations
## 6. Risks and invalidation
## 7. Reflection and open questions`;

function completeEnglishReport(fixture) {
  return `# ACME research

## 1. Investment thesis
Revenue increased 20%. [src: ${fixture.revenue.evidenceId}]

## 2. Industry analysis and external drivers
Industry multiples provide the external anchor. [src: ${fixture.transcriptCitationLabel}]

## 3. Company analysis
The filing supports the company analysis. [src: ${fixture.filingCitationLabel}]

## 4. Demand / supply / value chain
Capacity additions are expected next quarter. [src: ${fixture.capacity.evidenceId}]

## 5. Valuation-implied expectations
The valuation bridge is reproducible from the filing data. [src: ${fixture.filing.sourceId}]

## 6. Risks and invalidation
Gross-margin deterioration would invalidate the thesis. [src: ${fixture.filingCitationLabel}]

## 7. Reflection and open questions
The remaining uncertainty is explicitly summarized. [src: ${fixture.capacity.sourceId}]
`;
}

test('English audit resolves explicit EvidenceItem and SourceDocument citation labels', () => {
  const fixture = evidenceFixture();
  const report = completeEnglishReport(fixture);
  const assertions = [
    'Revenue increased 20%.',
    'Industry multiples provide the external anchor.',
    'The filing supports the company analysis.',
    'Capacity additions are expected next quarter.',
    'The valuation bridge is reproducible from the filing data.',
    'Gross-margin deterioration would invalidate the thesis.',
    'The remaining uncertainty is explicitly summarized.',
  ];
  const result = auditReportQuality({
    report,
    materialClaims: assertions.map((assertion, index) => ({ claimId: `claim-${index + 1}`, assertion })),
    sourceDocuments: fixture.sourceDocuments,
    evidenceItems: fixture.evidenceItems,
  });

  assert.equal(result.schemaVersion, REPORT_QUALITY_AUDIT_SCHEMA_VERSION);
  assert.equal(result.structure.requiredSectionCount, 7);
  assert.equal(result.structure.requiredSectionPassRate, 1);
  assert.equal(result.markers.source, 7);
  assert.equal(result.markers.unresolvedSourceMarkers, 0);
  assert.equal(result.claims.materialClaims, 7);
  assert.equal(result.claims.citationCoverage, 1);
  assert.equal(result.claims.traceabilityCoverage, 1);
  assert.equal(result.claims.locationCoverage, 1);
  assert.equal(result.passed, true);
  assert.ok(result.markers.items.some((marker) => (
    marker.label === fixture.filingCitationLabel
    && marker.traceableTargets.some((target) => target.kind === 'source-document')
  )));
  assert.ok(result.markers.items.some((marker) => (
    marker.label === fixture.revenue.evidenceId
    && marker.traceableTargets.some((target) => target.kind === 'evidence-item')
  )));
});

test('compound source, estimate, and open-issue marker groups are audited independently', () => {
  const fixture = evidenceFixture();
  const markers = parseReportMarkers([
    `[src: ${fixture.filingCitationLabel}; src: ${fixture.transcriptCitationLabel}]`,
    `[src: ${fixture.filingCitationLabel}; est monitoring threshold]`,
    '[est; src: unresolved-source; open-issue missing unit economics]',
  ].join('\n'));

  assert.deepEqual(markers.map(({ kind, label, valid }) => ({ kind, label, valid })), [
    { kind: 'src', label: fixture.filingCitationLabel, valid: true },
    { kind: 'src', label: fixture.transcriptCitationLabel, valid: true },
    { kind: 'src', label: fixture.filingCitationLabel, valid: true },
    { kind: 'est', label: 'monitoring threshold', valid: true },
    { kind: 'est', label: null, valid: true },
    { kind: 'src', label: 'unresolved-source', valid: true },
    { kind: 'open-issue', label: 'missing unit economics', valid: true },
  ]);

  const profile = createReportSectionProfile({
    id: 'compound-markers.v1',
    sections: BASE_REPORT_SECTION_PROFILE.sections.map((section) => ({
      ...section,
      required: section.id === 'investment-thesis',
    })),
  });
  const report = `# ACME research

## Investment thesis
Revenue increased 20%. [src: ${fixture.filingCitationLabel}; src: ${fixture.transcriptCitationLabel}]

Valuation upside is 15%. [src: ${fixture.filingCitationLabel}; est monitoring threshold]
`;
  const audit = auditReportQuality({
    report,
    sectionProfile: profile,
    materialClaims: [
      { assertion: 'Revenue increased 20%.' },
      { assertion: 'Valuation upside is 15%.' },
    ],
    sourceDocuments: fixture.sourceDocuments,
    evidenceItems: fixture.evidenceItems,
  });

  assert.equal(audit.markers.source, 3);
  assert.equal(audit.markers.estimate, 1);
  assert.equal(audit.markers.unresolvedSourceMarkers, 0);
  assert.equal(audit.claims.citationCoverage, 1);
  assert.equal(audit.claims.traceabilityCoverage, 1);
  assert.equal(audit.passed, true);
});

test('a semantic citation label shared by multiple atomic sources fails closed as ambiguous', () => {
  const left = createSourceDocument({
    provider: 'fmp',
    uri: 'fmp://fundamentals/LEFT',
    title: 'LEFT fundamentals',
    content: 'LEFT revenue grew 10%.',
    publishedAt: asOf,
    observedAt: asOf,
    fetchedAt: asOf,
    entityIds: ['ticker:LEFT'],
    asOfSafe: true,
    metadata: { citationLabels: ['fmp_fundamentals'] },
  });
  const right = createSourceDocument({
    provider: 'fmp',
    uri: 'fmp://fundamentals/RIGHT',
    title: 'RIGHT fundamentals',
    content: 'RIGHT revenue grew 20%.',
    publishedAt: asOf,
    observedAt: asOf,
    fetchedAt: asOf,
    entityIds: ['ticker:RIGHT'],
    asOfSafe: true,
    metadata: { citationLabels: ['fmp_fundamentals'] },
  });
  const profile = createReportSectionProfile({
    id: 'ambiguous-source-label.v1',
    sections: BASE_REPORT_SECTION_PROFILE.sections.map((section) => ({
      ...section,
      required: section.id === 'investment-thesis',
    })),
  });
  const result = auditReportQuality({
    report: '# Pair research\n\n## Investment thesis\nRevenue growth reached 20%. [src: fmp_fundamentals]\n',
    sectionProfile: profile,
    materialClaims: [{ assertion: 'Revenue growth reached 20%.' }],
    sourceDocuments: [left, right],
  });

  assert.equal(result.markers.unresolvedSourceMarkers, 1);
  assert.equal(result.markers.items[0].ambiguous, true);
  assert.equal(result.markers.items[0].resolved, false);
  assert.equal(result.claims.citationCoverage, 0);
  assert.equal(result.claims.traceabilityCoverage, 0);
  assert.equal(result.passed, false);
});

test('a unique atomic source remains traceable when a generic manifest reference repeats its id', () => {
  const fixture = evidenceFixture();
  const profile = createReportSectionProfile({
    id: 'atomic-source-with-manifest-shadow.v1',
    sections: BASE_REPORT_SECTION_PROFILE.sections.map((section) => ({
      ...section,
      required: section.id === 'investment-thesis',
    })),
  });
  const result = auditReportQuality({
    report: `# ACME research\n\n## Investment thesis\nRevenue increased 20%. [src: ${fixture.filing.sourceId}]\n`,
    sectionProfile: profile,
    materialClaims: [{ assertion: 'Revenue increased 20%.' }],
    sourceDocuments: [fixture.filing],
    manifests: [{ sourceRefs: [fixture.filing.sourceId] }],
  });

  assert.equal(result.markers.unresolvedSourceMarkers, 0);
  assert.equal(result.markers.items[0].resolved, true);
  assert.equal(result.markers.items[0].ambiguous, false);
  assert.equal(result.markers.items[0].traceable, true);
  assert.ok(result.markers.items[0].targets.some((target) => target.kind === 'manifest-ref'));
  assert.ok(result.markers.items[0].traceableTargets.some((target) => target.kind === 'source-document'));
  assert.equal(result.claims.citationCoverage, 1);
  assert.equal(result.claims.traceabilityCoverage, 1);
  assert.equal(result.passed, true);
});

test('manifest and artifact labels resolve but do not count as SourceDocument or EvidenceItem traceability', () => {
  const profile = createReportSectionProfile({
    id: 'manifest-only.v1',
    sections: BASE_REPORT_SECTION_PROFILE.sections.map((section) => ({
      ...section,
      required: section.id === 'investment-thesis',
    })),
  });
  const report = `# ACME research

## Investment thesis
Revenue growth reached 20%. [src: frozen-source-entry]

Valuation upside is 15%. [src: frozen-report-artifact]
`;
  const result = auditReportQuality({
    report,
    sectionProfile: profile,
    materialClaims: [
      { assertion: 'Revenue growth reached 20%.' },
      { assertion: 'Valuation upside is 15%.' },
    ],
    manifests: [{
      entries: [{ id: 'source-entry-r1', citationLabel: 'frozen-source-entry' }],
      versions: [{
        ref: {
          artifactId: 'acme:report/report.md',
          version: 1,
          path: 'report/report.md',
          metadata: { citationLabel: 'frozen-report-artifact' },
        },
      }],
    }],
  });

  assert.equal(result.markers.unresolvedSourceMarkers, 0);
  assert.equal(result.claims.citationCoverage, 1);
  assert.equal(result.claims.traceabilityCoverage, 0);
  assert.ok(result.claims.audits.every((claim) => claim.traceableTargets.length === 0));
  assert.equal(result.checks.traceabilityCoverage, false);
  assert.equal(result.passed, false);
});

test('canonical transcript and industry-context aliases resolve to SourceDocuments without weakening artifact traceability', () => {
  const report = `# Memo

## 1. Investment thesis
Cloud growth was 28%. [src: transcript Q1'26]

## 2. Industry analysis and external drivers
Peer margins differ. [src: fmp_industry_context]

## 3. Demand / supply / value chain
Capacity remains constrained. [src: transcript 2026 Q1]

## 4. Company analysis
Management did not disclose AI ROIC. [src: GOOGL transcript 2026Q1]

## 5. Valuation
Valuation remains conditional. [est]

## 6. Risks and invalidation
Margin conversion may fail. [open-issue]

## 7. Summary
The thesis remains conditional. [src: industry context]
`;
  const sourceDocuments = [{
    schemaVersion: '1.0.0',
    sourceId: `source:${'1'.repeat(64)}`,
    contentHash: `sha256:${'2'.repeat(64)}`,
    provider: 'fmp',
    uri: 'fmp://transcript/GOOGL/2026Q1',
    title: 'GOOGL earnings transcript',
    content: 'Cloud growth was 28%.',
    publishedAt: asOf,
    observedAt: asOf,
    fetchedAt: asOf,
    mimeType: 'text/plain',
    entityIds: ['ticker:GOOGL'],
    asOfSafe: true,
    metadata: { citationLabels: ["transcript Q1'26", 'transcript 2026 Q1', 'GOOGL transcript 2026Q1'] },
  }, {
    schemaVersion: '1.0.0',
    sourceId: `source:${'3'.repeat(64)}`,
    contentHash: `sha256:${'4'.repeat(64)}`,
    provider: 'fmp',
    uri: 'fmp://industry/context',
    title: 'Industry and peer context',
    content: 'Peer margins differ.',
    publishedAt: asOf,
    observedAt: asOf,
    fetchedAt: asOf,
    mimeType: 'application/json',
    entityIds: ['ticker:GOOGL'],
    asOfSafe: true,
    metadata: { citationLabels: ['fmp_industry_context', 'industry context'] },
  }];
  const result = auditReportQuality({
    report,
    materialClaims: deriveMaterialClaimsFromReport(report),
    sourceDocuments,
    evidenceItems: [],
  });
  assert.deepEqual(result.markers.unresolvedSourceLabels, []);
  assert.ok(result.markers.items.filter((marker) => marker.kind === 'src').every((marker) => marker.traceable));
});

test('Chinese case-specific profile accepts localized headings and classifies estimate/open-issue markers', () => {
  const fixture = evidenceFixture();
  const sections = BASE_REPORT_SECTION_PROFILE.sections.map((section) => (
    section.id === 'demand-supply-value-chain'
      ? { ...section, aliases: [...section.aliases, '供需格局与产业链'] }
      : section
  ));
  const profile = createReportSectionProfile({ id: 'zh-company-case.v1', sections });
  const report = `# ACME 研究

## 一、投资逻辑
收入增长有一手证据。 [src: ${fixture.revenue.evidenceId}]

## 二、行业与外部驱动
行业驱动仍需持续跟踪。 [open-issue: 宏观传导时滞尚未验证]

## 三、公司基本面
公司利润率来自正式披露。 [src: ${fixture.filingCitationLabel}]

## 四、供需格局与产业链
下季度供给增量来自管理层表述。 [src: ${fixture.transcriptCitationLabel}]

## 五、估值隐含预期
合理估值为 120 至 140。 [est: 折现率与终值倍数敏感性]

## 六、风险与失效条件
客户集中度仍缺少完整披露。 [open-issue: 等待客户结构披露]

## 七、总结
当前结论同时保留估计和待验证事项。 [est: 综合判断]
`;
  const claims = [
    { assertion: '收入增长有一手证据。' },
    { assertion: '行业驱动仍需持续跟踪。' },
    { assertion: '公司利润率来自正式披露。' },
    { assertion: '下季度供给增量来自管理层表述。' },
    { assertion: '合理估值为 120 至 140。' },
    { assertion: '客户集中度仍缺少完整披露。' },
    { assertion: '当前结论同时保留估计和待验证事项。' },
  ];
  const result = auditReportQuality({
    report,
    sectionProfile: profile,
    materialClaims: claims,
    sourceDocuments: fixture.sourceDocuments,
    evidenceItems: fixture.evidenceItems,
  });

  assert.equal(result.structure.profileId, 'zh-company-case.v1');
  assert.equal(result.structure.requiredSectionPassRate, 1);
  assert.equal(result.markers.source, 3);
  assert.equal(result.markers.estimate, 2);
  assert.equal(result.markers.openIssue, 2);
  assert.equal(result.claims.citationEligibleMaterialClaims, 3);
  assert.equal(result.claims.citationCoverage, 1);
  assert.equal(result.claims.traceabilityCoverage, 1);
  assert.equal(result.passed, true);
});

test('unresolved source labels fail closed even when another report citation resolves', () => {
  const fixture = evidenceFixture();
  const report = `${englishHeadings}

Verified revenue claim. [src: ${fixture.revenue.evidenceId}]

Unsupported market claim. [src: source-that-is-not-frozen]
`;
  const result = auditReportQuality({
    report,
    materialClaims: [{ assertion: 'Verified revenue claim.' }, { assertion: 'Unsupported market claim.' }],
    sourceDocuments: fixture.sourceDocuments,
    evidenceItems: fixture.evidenceItems,
  });

  assert.equal(result.markers.unresolvedSourceMarkers, 1);
  assert.deepEqual(result.markers.unresolvedSourceLabels, ['source-that-is-not-frozen']);
  assert.equal(result.claims.citationCoverage, 0.5);
  assert.equal(result.claims.traceabilityCoverage, 0.5);
  assert.equal(result.checks.sourceLabelsResolved, false);
  assert.equal(result.passed, false);
});

test('zero material claims produce zero coverage and cannot pass a structurally complete report', () => {
  const markers = parseReportMarkers(`${englishHeadings}\n\n\`\`\`json\n"fake": "[src: hidden]"\n\`\`\`\n[est: visible estimate]`);
  assert.equal(markers.some((marker) => marker.label === 'hidden'), false);
  assert.equal(markers.some((marker) => marker.label === 'visible estimate'), true);

  const result = auditReportQuality({ report: englishHeadings, materialClaims: [] });
  assert.equal(result.structure.requiredSectionPassRate, 0);
  assert.ok(result.structure.sections.every((section) => section.present && !section.substantive));
  assert.equal(result.claims.materialClaims, 0);
  assert.equal(result.claims.citationCoverage, 0);
  assert.equal(result.claims.traceabilityCoverage, 0);
  assert.equal(result.checks.materialClaimPopulation, false);
  assert.equal(result.passed, false);
});

test('only unresolved critical contradicted material claims are counted, including claim verdicts', () => {
  const fixture = evidenceFixture();
  const report = completeEnglishReport(fixture);
  const materialClaims = [
    { claimId: 'revenue', assertion: 'Revenue increased 20%.', status: 'contradicted', severity: 'critical' },
    { claimId: 'industry', assertion: 'Industry multiples provide the external anchor.' },
    { claimId: 'filing', assertion: 'The filing supports the company analysis.' },
    { claimId: 'capacity', assertion: 'Capacity additions are expected next quarter.' },
    { claimId: 'valuation', assertion: 'The valuation bridge is reproducible from the filing data.' },
    { claimId: 'risk', assertion: 'Gross-margin deterioration would invalidate the thesis.' },
    { claimId: 'summary', assertion: 'The remaining uncertainty is explicitly summarized.' },
  ];
  const result = auditReportQuality({
    report,
    materialClaims,
    sourceDocuments: fixture.sourceDocuments,
    evidenceItems: fixture.evidenceItems,
    contradictions: [
      { id: 'revenue', severity: 'critical', material: true, resolved: false },
      { id: 'unresolved-critical', severity: 'critical', material: true, resolved: false },
      { id: 'resolved-critical', severity: 'critical', material: true, resolved: true },
      { id: 'warning-conflict', severity: 'warning', material: true, resolved: false },
      { id: 'non-material-conflict', severity: 'critical', material: false, resolved: false },
      {
        topic: 'Bookings growth versus customer inventory',
        conflicting: ['Bookings accelerated.', 'Customer inventory remains elevated.'],
        hypothesis: 'The divergence is a timing lag.',
        resolveBy: 'Reconcile sell-through and channel inventory.',
      },
    ],
  });

  assert.equal(result.contradictions.unresolvedCriticalContradictedMaterialClaims, 3);
  assert.deepEqual(result.contradictions.items.map((item) => item.id).sort(), [
    'Bookings growth versus customer inventory',
    'revenue',
    'unresolved-critical',
  ]);
  assert.equal(result.checks.criticalContradictions, false);
  assert.equal(result.passed, false);
});

test('material claim derivation conservatively extracts English judgments and ignores TOC, metadata, labels, and code', () => {
  const fixture = evidenceFixture();
  const report = `# ACME report

## Table of contents
- [Investment thesis](#investment-thesis)
- [Risks](#risks-and-invalidation)

## Investment thesis
Ticker: ACME
**Role boundary:** Final portfolio allocation is owned by a separate decision workflow.
**Role boundaries:** Legal probability, portfolio sizing, and benchmark construction are owned by separate workflows.
Revenue grew 20% while gross margin expanded to 60%. [src: ${fixture.revenue.evidenceId}]
Recommendation: Hold because valuation upside is only 8%. [src: ${fixture.filingCitationLabel}]

\`\`\`text
Revenue growth is 999% and the rating is Strong Buy. [src: fabricated]
\`\`\`

### Key risk
Risk:
Customer concentration could invalidate the thesis. [open-issue: customer disclosure]

## Reflection and open questions
Generated at: 2026-07-16T00:00:00.000Z
The remaining valuation uncertainty is material. [est: terminal multiple]
`;
  const claims = deriveMaterialClaimsFromReport(report);

  assert.deepEqual(claims.map((claim) => claim.assertion), [
    'Revenue grew 20% while gross margin expanded to 60%.',
    'Recommendation: Hold because valuation upside is only 8%.',
    'Customer concentration could invalidate the thesis.',
    'The remaining valuation uncertainty is material.',
  ]);
  assert.deepEqual(claims.map((claim) => claim.sectionId), [
    'investment-thesis',
    'investment-thesis',
    'risks-invalidation',
    'reflection-open-questions-summary',
  ]);
  assert.equal(claims[2].location, 'Key risk');
  assert.ok(claims.every((claim) => claim.claimId.startsWith('report-claim:') && claim.material));
  assert.equal(claims.some((claim) => /999%|Generated at|Ticker:|^Risk:|Role boundar/u.test(claim.assertion)), false);

  const audit = auditReportQuality({
    report,
    materialClaims: claims,
    sourceDocuments: fixture.sourceDocuments,
    evidenceItems: fixture.evidenceItems,
    thresholds: { citationCoverage: 0.5 },
  });
  assert.equal(audit.claims.locationCoverage, 1);
  assert.equal(audit.claims.traceabilityCoverage, 1);
  assert.ok(audit.claims.audits.every((claim) => claim.locationStatus === 'located'));
  assert.ok(audit.claims.audits.every((claim) => Number.isInteger(claim.reportLine)));
});

test('material claim derivation excludes explicit outside-role table rows without hiding substantive investment questions', () => {
  const report = `# ACME report

## Reflection and open questions
| Status | Question | Required evidence | Owner |
|---|---|---|---|
| Outside role | What portfolio weight and benchmark should be used? | Risk budget, factor exposure, benchmark, correlation | Portfolio workflow |
| Open issue | Can Search economics absorb higher inference cost? | Revenue per query and Search margin | [open-issue: Search unit economics] |
`;
  const claims = deriveMaterialClaimsFromReport(report);

  assert.equal(claims.some((claim) => /^Outside role\s*\|/iu.test(claim.assertion)), false);
  assert.equal(claims.some((claim) => /Search economics absorb higher inference cost/iu.test(claim.assertion)), true);
});

test('material claim derivation keeps causal analysis in the traceability denominator until it is marked', () => {
  const unmarked = `# ACME report

## Investment thesis
Demand evidence is positive; the evidence that AI revenue growth outpaces depreciation and capex pressure is absent.
For Search, value is query to commercial intent to advertiser value minus inference and distribution cost.
For Cloud, value is deployed capacity to utilized workload to recurring revenue and contribution profit minus depreciation and operating cost.
`;
  const unmarkedClaims = deriveMaterialClaimsFromReport(unmarked);
  const unmarkedAudit = auditReportQuality({
    report: unmarked,
    materialClaims: unmarkedClaims,
    thresholds: { citationCoverage: 0, traceabilityCoverage: 1 },
  });

  assert.equal(unmarkedClaims.length, 3);
  assert.equal(unmarkedAudit.claims.traceabilityCoverage, 0);
  assert.equal(unmarkedAudit.checks.traceabilityCoverage, false);

  const marked = `# ACME report

## Investment thesis
Demand evidence is positive; whether AI revenue growth outpaces depreciation and capex pressure remains unresolved. [open-issue: AI return conversion]
For Search, value is query to commercial intent to advertiser value minus inference and distribution cost. [est: analytical value-chain framework]
For Cloud, value is deployed capacity to utilized workload to recurring revenue and contribution profit minus depreciation and operating cost. [est: analytical value-chain framework]
`;
  const markedClaims = deriveMaterialClaimsFromReport(marked);
  const markedAudit = auditReportQuality({
    report: marked,
    materialClaims: markedClaims,
    thresholds: { citationCoverage: 0, traceabilityCoverage: 1 },
  });

  assert.equal(markedClaims.length, 3);
  assert.equal(markedAudit.claims.traceabilityCoverage, 1);
  assert.equal(markedAudit.checks.traceabilityCoverage, true);
});

test('material claim derivation supports Chinese prose and keeps estimate/open-issue assertions locatable', () => {
  const report = `# 中文报告

## 一、投资逻辑
截至日期：2026-06-30
预计收入增速为 15%，毛利率维持在 42%。 [est: 管理层指引外推]

## 二、风险与失效条件
若客户集中度继续上升，投资逻辑将失效。 [open-issue: 等待客户结构披露]
风险：高

## 三、总结
建议持有，当前目标价隐含的上行空间不足。 [est: 综合判断]
`;
  const profile = createReportSectionProfile({
    id: 'compact-zh.v1',
    sections: BASE_REPORT_SECTION_PROFILE.sections.map((section) => ({
      ...section,
      required: ['investment-thesis', 'risks-invalidation', 'reflection-open-questions-summary'].includes(section.id),
    })),
  });
  const claims = deriveMaterialClaimsFromReport(report, { sectionProfile: profile });

  assert.deepEqual(claims.map((claim) => claim.assertion), [
    '预计收入增速为 15%，毛利率维持在 42%。',
    '若客户集中度继续上升，投资逻辑将失效。',
    '建议持有，当前目标价隐含的上行空间不足。',
  ]);
  const audit = auditReportQuality({
    report,
    sectionProfile: profile,
    materialClaims: claims,
    thresholds: { citationCoverage: 0 },
  });
  assert.equal(audit.claims.materialClaims, 3);
  assert.equal(audit.claims.locationCoverage, 1);
  assert.equal(audit.claims.traceabilityCoverage, 1);
});

test('material claim derivation extracts Markdown table data rows, excludes headers, and preserves colocated markers', () => {
  const fixture = evidenceFixture();
  const report = `# ACME report

## Valuation
| Metric | Base case | Judgment | Evidence |
|---|---:|---|---|
| Revenue growth | 18% | Above consensus | [src: ${fixture.revenue.evidenceId}] |
| Target price | $140 | Recommendation: Buy | [est: scenario DCF] |

## Risks and invalidation
| Risk factor | Threshold | Consequence |
|---|---:|---|
| Gross margin | below 50% | Invalidate the thesis | [open-issue: quarterly disclosure] |
`;
  const profile = createReportSectionProfile({
    id: 'table-case.v1',
    sections: BASE_REPORT_SECTION_PROFILE.sections.map((section) => ({
      ...section,
      required: ['valuation', 'risks-invalidation'].includes(section.id),
    })),
  });
  const claims = deriveMaterialClaimsFromReport(report, { sectionProfile: profile });

  assert.equal(claims.length, 3);
  assert.ok(claims.every((claim) => claim.sourceKind === 'table-row'));
  assert.deepEqual(claims.map((claim) => claim.assertion), [
    'Revenue growth | 18% | Above consensus |',
    'Target price | $140 | Recommendation: Buy |',
    'Gross margin | below 50% | Invalidate the thesis |',
  ]);
  const audit = auditReportQuality({
    report,
    sectionProfile: profile,
    materialClaims: claims,
    sourceDocuments: fixture.sourceDocuments,
    evidenceItems: fixture.evidenceItems,
  });
  assert.equal(audit.claims.locationCoverage, 1);
  assert.equal(audit.claims.citationEligibleMaterialClaims, 1);
  assert.equal(audit.claims.citationCoverage, 1);
  assert.equal(audit.claims.traceabilityCoverage, 1);
});

test('additional sections, numeric-only assertions, and cross-line citations stay in the coverage denominator', () => {
  const fixture = evidenceFixture();
  const profile = createReportSectionProfile({
    id: 'numeric-cross-line.v1',
    sections: BASE_REPORT_SECTION_PROFILE.sections.map((section) => ({
      ...section,
      required: section.id === 'valuation',
    })),
  });
  const report = `# ACME report

## Valuation
18% / 12%.
[src: ${fixture.revenue.evidenceId}]

## Catalysts
Bookings growth could reach 18% next year.
`;
  const claims = deriveMaterialClaimsFromReport(report, { sectionProfile: profile });

  assert.deepEqual(claims.map((claim) => claim.assertion), [
    '18% / 12%.',
    'Bookings growth could reach 18% next year.',
  ]);
  assert.deepEqual(claims.map((claim) => claim.sectionId), ['valuation', 'additional-section']);
  const result = auditReportQuality({
    report,
    sectionProfile: profile,
    materialClaims: claims,
    sourceDocuments: fixture.sourceDocuments,
    evidenceItems: fixture.evidenceItems,
    thresholds: { citationCoverage: 0.5, traceabilityCoverage: 0.5 },
  });

  assert.equal(result.claims.materialClaims, 2);
  assert.equal(result.claims.citationCoverage, 0.5);
  assert.equal(result.claims.traceabilityCoverage, 0.5);
  assert.equal(result.claims.audits[0].cited, true);
  assert.equal(result.claims.audits[1].cited, false);
  assert.equal(result.structure.requiredSectionPassRate, 1);
  assert.equal(result.passed, true);
});

test('material claim derivation returns zero for metadata-only content so audit remains fail closed', () => {
  const report = `# Metadata-only report

## Investment thesis
Ticker: ACME
Date: 2026-06-30
Risk:

\`\`\`json
{"revenueGrowth": 99, "recommendation": "buy"}
\`\`\`
`;
  const claims = deriveMaterialClaimsFromReport(report);
  assert.deepEqual(claims, []);
  const audit = auditReportQuality({ report, materialClaims: claims });
  assert.equal(audit.claims.materialClaims, 0);
  assert.equal(audit.checks.materialClaimPopulation, false);
  assert.equal(audit.passed, false);
});
