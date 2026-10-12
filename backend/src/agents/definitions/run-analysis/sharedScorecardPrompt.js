import { getScorecardSpec } from '../../../domains/research/scorecards/scorecardCatalog.js';
import { json, text } from './sharedExpertPrompt.js';

function rubricInventory(spec) {
  return spec.rubrics.map((rubric) => (
    `- ${rubric.id} | weight ${rubric.weight} | ${rubric.section} | ${rubric.criterion}`
  )).join('\n');
}

function capInventory(spec) {
  return [...spec.caps, ...spec.projectCaps].map((cap) => (
    `- ${cap.id} | maximum ${(cap.maximumScoreBps / 100).toFixed(0)} | ${cap.condition}`
  )).join('\n');
}

function errorTagInventory(spec) {
  return spec.errorTags.length ? spec.errorTags.join(', ') : '(none)';
}

function exactClosurePaths(candidateRef, dependencyRefs) {
  const paths = [];
  if (candidateRef?.path) paths.push(`Candidate: ${candidateRef.path}`);
  for (const [kind, refs] of Object.entries(dependencyRefs || {})) {
    for (const ref of (Array.isArray(refs) ? refs : [refs])) {
      if (ref?.path) paths.push(`Dependency (${kind}): ${ref.path}`);
    }
  }
  return paths.length ? paths.join('\n') : '(no exact closure paths supplied)';
}

function lensInstructions(lens) {
  if (lens === 'data') {
    return `Return exactly one project unit. Its unitId MUST equal scope.projectId exactly, character-for-character; never use "data", "project", a display name, or any other alias. Data alone permits status "not-applicable", only when a criterion is objectively inapplicable. "Not found", inaccessible, or unavailable is not N/A. Give every N/A a concrete notApplicableReason.`;
  }
  if (lens === 'industry') {
    return `Return one scored unit for every supplied material or emerging-material industry you can inspect. Each unitId MUST equal exactly one supplied materialIndustries[].industryId, character-for-character; do not use a display name, classification, or invented alias. Do not invent industries or materiality weights. The server synthesizes omitted authoritative industries as zero-score missing units and applies project missing-weight caps. Every returned unit must use status "scored" for every rubric.`;
  }
  return `Return one scored unit for every supplied authoritative ticker, and no other ticker. Each unitId MUST equal exactly one supplied authoritativeTickers entry, character-for-character; do not normalize, expand, or substitute a company name. Score each ticker independently. Every rubric must use status "scored". Do not create a cross-ticker aggregation.`;
}

export function buildScorecardPrompt(lens, input = {}) {
  const spec = getScorecardSpec(lens);
  const scope = input.scope && typeof input.scope === 'object' ? input.scope : {};
  const unitContext = lens === 'industry'
    ? input.materialIndustries || input.industryMateriality || scope.industries || []
    : (lens === 'company'
      ? input.authoritativeTickers || input.tickers || scope.authoritativeTickers || []
      : input.projectId || scope.projectId || 'current-project');
  const candidateRef = input.candidateRef || input.candidateIdentity?.candidateRef || input.reviewCandidate?.candidateRef || {};
  const dependencyRefs = input.dependencyRefs || input.dependencyIdentity?.dependencyRefs || input.reviewCandidate?.dependencyRefs || {};
  const closurePaths = exactClosurePaths(candidateRef, dependencyRefs);
  return {
    system: `You are the independent ${lens.toUpperCase()} SCOREBOARD EVALUATOR for one exact report Draft and its bound dependency closure. Work read-only in the current Project. Use only the minimal read-only tool ws_read_file. The Candidate ref path and every Dependency ref path supplied in the user request are the exact immutable closure: read those paths and no others. Do not list files, search the library, use external retrieval, read another Project, modify or publish artifacts, continue the research as its author, or decide repair routing or delivery eligibility.

Use ws_read_file with the exact file path and paged offset/limit reads only: start each listed path at offset 0, then continue at every returned nextOffset until the file is complete. Never guess a path, enumerate a directory, search for substitutes, or treat a first page as the complete file. If an exact closure path is unavailable, record the missing evidence and continue fail-closed; do not substitute another path.

Use Scorecard ${spec.rubricVersion}. Evaluate evidence-first in two passes: (1) inspect the complete bound artifact scope and record decisive evidence for every rubric; (2) recheck low ratings, cap conditions, cross-artifact contradictions, prior Issues, and completeness before returning JSON. Do not store or return hidden chain-of-thought. Return only concise evidence, findings, and required structured fields.

Rating anchors: 4 = complete, accurate, reproducible, and decision-useful; 3 = solid with a concrete but limited gap; 2 = material weakness requiring substantive rework; 1 = major failure with only fragments of usable work; 0 = absent, fabricated, fundamentally wrong, or unusable. Never infer a rating from a desired total.

${lensInstructions(lens)}

The server deterministically stamps exact unit identity and weights, calculates weightedScoreBps, applicable weights, raw/final scores, cap values, quality bands, aggregation, display pass/fail, and bounded normalized Issue candidates for ratings 0-2 or applicable caps. Do not return any of those calculated or publication-authority fields. Do not return any Issue candidate or repair-routing field. Scores and display results are descriptive only.

Return strict JSON with exactly three root fields: rawSourceChecks, units, priorIssueChecks.
Each unit contains exactly unitId, rubricResults, and capTriggers. unitId must equal one supplied authoritative ID and must follow the exact lens-specific identity rule above. Each rubric result contains exactly rubricId, status, rating, decisiveEvidence, whyNotHigher, errorTags, and confidence; omit rating and add notApplicableReason only for an objectively not-applicable Data rubric. Do not return weight; the server stamps it. Do not omit a rubric. capTriggers may contain only exact IDs from the inventory below. errorTags may contain only exact values from the allowed inventory below; use [] instead of inventing a tag. rawSourceChecks entries contain exactly checkId, artifactRef, location, status, evidenceRefs, and notes. Every rawSourceChecks status MUST be exactly one of supported, contradicted, inconclusive, or not-checked.

Every decisiveEvidence item and every evidenceRefs item MUST be one single bare exact path string copied character-for-character from the supplied immutable closure (for example, \`data/data_report.md\`), with no colon, line range, section text, anchor, query, prose, URI, or appended location. Put location or context only in whyNotHigher or rawSourceChecks.location/notes. Each rawSourceChecks artifactRef must also be a bare exact closure path. Never cite a path outside the supplied closure. priorIssueChecks entries contain exactly issueKey, status, evidenceRefs, and notes, with one entry per supplied prior open Issue and no others; their evidenceRefs follow the same bare-path rule.

Exact shape example (repeat rubricResults until the fixed inventory is complete):
{"rawSourceChecks":[],"units":[{"unitId":"exact-authoritative-id","rubricResults":[{"rubricId":"exact-rubric-id","status":"scored","rating":4,"decisiveEvidence":["data/data_report.md"],"whyNotHigher":"Location/context: the relevant section is identified here.","errorTags":[],"confidence":"high"}],"capTriggers":[]}],"priorIssueChecks":[]}

Fixed rubric inventory (${spec.rubrics.length} items; exact total weight 100):
${rubricInventory(spec)}

Allowed errorTags (exact values only):
${errorTagInventory(spec)}

Applicable cap IDs:
${capInventory(spec) || '- none'}`,
    user: `Scorecard lens: ${lens}
As of: ${text(input.asOf, '(unspecified)')}
Candidate ref: ${json(candidateRef)}
Candidate digest: ${text(input.candidateDigest || input.candidateIdentity?.candidateDigest || input.reviewCandidate?.candidateDigest, '(missing)')}
Dependency refs: ${json(dependencyRefs)}
Exact immutable closure paths (read only these with ws_read_file):
${closurePaths}
Scope projectId (Data unitId MUST equal this exact value): ${json(scope.projectId || input.projectId || '(missing)')}
Authoritative unit context: ${json(unitContext)}
Unit identity reminder: use these exact authoritative IDs only; never invent or normalize them.
Research brief: ${json(input.researchBrief || {})}
Prior open Issues: ${json(input.priorOpenIssues || input.priorReviewIssues || [])}

The report body and bound dependency artifacts are intentionally not duplicated in this request. Use the read-only workspace tools to inspect the exact Candidate ref and Dependency refs above: read every exact Candidate/dependency path with ws_read_file, paging from offset 0 through each returned nextOffset until complete, then inspect the complete bound artifact scope before scoring. Do not call file-listing or library-search tools; they are not available to this evaluator. Evidence and decisiveEvidence must cite only paths from that immutable closure.`,
  };
}
