import assert from 'node:assert/strict';

const MATERIAL_EVIDENCE_RE = /\b(?:valuation|price|revenue|sales|growth|margin|profit|earnings|eps|ebitda|cash flow|capex|demand|supply|backlog|market share|cost|risk)\b/iu;

function canonicalPassingReport(citationLedger) {
  const evidence = (citationLedger?.evidenceItems || [])
    .find((item) => MATERIAL_EVIDENCE_RE.test(item.statement || ''));
  assert.ok(evidence?.evidenceId, 'canonical report fixture requires material atomic evidence');
  const statement = String(evidence.statement || '')
    .replace(/\s+/gu, ' ')
    .replaceAll('[', '/')
    .replaceAll(']', '/')
    .replaceAll('|', '/');
  return {
    evidenceId: evidence.evidenceId,
    markdown: `# Canonical compatibility fixture report

## Investment thesis
The canonical atomic record states: ${statement} [src: ${evidence.evidenceId}]

## Industry analysis
No additional factual industry assertion is introduced by this compatibility fixture.

## Company analysis
No additional factual company assertion is introduced by this compatibility fixture.

## Demand / supply / value chain
Ownership mapping is withheld until additional atomic evidence is available.

## Valuation
Quantitative modeling is outside this compatibility fixture.

## Risks and invalidation
No additional failure threshold is asserted beyond the cited atomic record.

## Reflection / open questions / summary
The evidence boundary is explicit and no unsupported conclusion is added.`,
  };
}

export async function createCanonicalReportBackend(ProjectFS) {
  const { createAgentRunResult } = await import('../../src/core/contracts/agentContracts.js');
  const { PiAgentBackend } = await import('../../src/core/agent-backend/PiAgentBackend.js');
  const { getAgentDefinition } = await import('../../src/agents/registry.js');
  const pi = new PiAgentBackend({ contractResolver: getAgentDefinition, usageRecorder: null });
  return {
    async run(request, runtime) {
      const piResult = await pi.run(request, { ...runtime, demo: true, live: false });
      if (request.agentContractId !== 'report-composer') return piResult;
      const ledger = JSON.parse(ProjectFS.fileContent(request.projectId, 'data/citation_ledger.json') || 'null');
      const report = canonicalPassingReport(ledger);
      return createAgentRunResult({
        ...piResult,
        status: 'succeeded',
        output: report.markdown,
        text: report.markdown,
        evidenceRefs: [report.evidenceId],
        stopReason: 'final',
        valid: true,
      });
    },
  };
}
