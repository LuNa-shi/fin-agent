import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalReportQualityIssues,
  selectReportMarkdown,
} from '../src/workflows/run-analysis/runAnalysis.workflow.js';

function fullReport(label = 'current') {
  return `# ${label} research report

## Investment thesis
${'Evidence-grounded investment thesis. '.repeat(12)}

## Industry analysis
Industry drivers and external variables are assessed.

## Demand / supply / value chain
The value-chain ownership and cost bearers are explicit.

## Company analysis
Company quality, growth, moat, and substitution risks are assessed.

## Valuation
Valuation-implied expectations and scenarios are reconciled.

## Risks and invalidation
Observable invalidation thresholds are explicit.

## Reflection and open questions
Open evidence gaps remain visible.

## Summary
The evidence-weighted conclusion is conditional.
`;
}

test('a substantive report written through Workspace wins over the model acknowledgement text', () => {
  const writtenReport = fullReport('workspace');
  const selected = selectReportMarkdown({
    returnedText: 'Completed the memo and saved it to `report/report.md`.',
    writtenReport,
    priorReport: '',
    live: true,
  });
  assert.equal(selected, writtenReport.trim());
});

test('a substantive direct Markdown return is accepted when no Workspace write occurred', () => {
  const returnedText = fullReport('returned');
  assert.equal(selectReportMarkdown({
    returnedText,
    writtenReport: '',
    priorReport: '',
    live: true,
  }), returnedText.trim());
});

test('live acknowledgement-only output cannot overwrite an unchanged prior report', () => {
  const priorReport = fullReport('prior');
  assert.throws(() => selectReportMarkdown({
    returnedText: 'Done. The report was saved.',
    writtenReport: priorReport,
    priorReport,
    live: true,
  }), /未产出实质性 Markdown/u);
});

test('citation remediation examples exclude estimate-only claims and retain report line numbers', () => {
  const issues = canonicalReportQualityIssues({
    checks: {
      sourceLabelsResolved: true,
      citationCoverage: false,
      traceabilityCoverage: true,
      requiredSections: true,
      materialClaimPopulation: true,
      materialClaimsLocated: true,
      criticalContradictions: true,
    },
    claims: {
      citationCoverage: 0.5,
      audits: [
        { assertion: 'Scenario upside is an estimate.', reportLine: 12, citationRequired: false, cited: false },
        { assertion: 'Revenue grew 20%.', reportLine: 24, citationRequired: true, cited: false },
      ],
    },
    markers: { unresolvedSourceLabels: [] },
    structure: { requiredSectionPassRate: 1 },
    contradictions: { unresolvedCriticalContradictedMaterialClaims: 0 },
  });

  assert.equal(issues.length, 1);
  assert.match(issues[0].remediation, /line 24: Revenue grew 20%/u);
  assert.doesNotMatch(issues[0].remediation, /Scenario upside/u);
});
