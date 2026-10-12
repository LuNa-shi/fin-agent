import crypto from 'node:crypto';

import { getAgentSchema } from '../core/validation/agentSchemaRegistry.js';
import { AGENT_DEFINITION_REQUIRED_FIELDS } from './defineAgent.js';
import { listAgentDefinitions } from './registry.js';

const CATEGORIES = new Set(['runtime', 'workflow', 'documentationOnly']);

function entry(field, category, consumer, extra = {}) {
  return Object.freeze({ field, category, consumer, ...extra });
}

export const AGENT_CONTRACT_FIELD_CATALOG = Object.freeze([
  entry('id', 'runtime', 'AgentDefinitionRegistry, AgentExecutionRuntime request construction, backend contractResolver, ToolGateway audit events.'),
  entry('version', 'runtime', 'AgentExecutionRuntime writes contractVersion; PiAgentBackend rejects contract-version mismatches.'),
  entry('domain', 'workflow', 'Workflow/spec tests and registry projections group active contracts by domain.'),
  entry('inRunAnalysis', 'workflow', 'Agent Registry and workflowSpec select the active Run Analysis definition set from this flag.'),
  entry('source', 'documentationOnly', 'Migration provenance for maintainers and registry boundary tests.', {
    justification: 'Source identifies the pre-definition call-site lineage; production execution does not branch on it.',
  }),
  entry('purpose', 'documentationOnly', 'Catalog description for humans; no backend currently branches on purpose.', {
    justification: 'Purpose is expert-facing documentation metadata, not an execution control.',
  }),
  entry('visibility', 'documentationOnly', 'Catalog and Workflow association metadata exposed through Agent definition projections.', {
    justification: 'Execution workflow identity comes only from a validated Workflow/direct execution scope; visibility does not route a request.',
  }),
  entry('visibility.catalog', 'documentationOnly', 'Catalog display metadata only.', {
    justification: 'No runtime policy currently varies by public/internal catalog visibility.',
  }),
  entry('visibility.workflows', 'documentationOnly', 'Declared Workflow association metadata for catalogs and architecture review.', {
    justification: 'AgentExecutionRuntime never defaults workflowId from this list; canonical or direct execution scope is authoritative.',
  }),
  entry('executionMode', 'runtime', 'PiAgentBackend selects json/text/tool-loop execution behavior.'),
  entry('prompt', 'runtime', 'PiAgentBackend renders prompt(input) before model invocation.'),
  entry('inputSchema', 'documentationOnly', 'Declared input schema id; not currently runtime-consumed.', {
    justification: 'No central input schema resolver or preflight validator exists for Agent inputs yet.',
    knownGap: true,
  }),
  entry('outputAdapter', 'runtime', 'PiAgentBackend applies the deterministic output projection before ContractEnforcer/OutputGate schema validation.'),
  entry('outputSchema', 'runtime', 'ContractEnforcer/OutputGate consume outputSchema only when completionPolicy.hardChecks includes output-schema and the central resolver resolves the id; non-central cases are audited below.'),
  entry('contextPolicy', 'runtime', 'ContextManager preflight and ToolGateway project authorization consume context policy.'),
  entry('contextPolicy.mounts', 'runtime', 'ContextManager and ToolGateway require allowed mounts before project artifact/tool access.'),
  entry('contextPolicy.artifactSelectors', 'runtime', 'AgentExecutionRuntime filters scoped inputArtifactRefs and ContextManager enforces their paths against artifact selectors.'),
  entry('contextPolicy.maxInlineTokens', 'runtime', 'ContextManager rejects inline artifact/prior-review context above the token budget.'),
  entry('contextPolicy.allowPriorReview', 'runtime', 'AgentExecutionRuntime gates scoped priorReviewIssues and ContextManager rejects unauthorized review context.'),
  entry('contextPolicy.allowCrossProjectRead', 'runtime', 'ContextManager and ToolGateway reject cross-project reads unless enabled.'),
  entry('toolPolicy', 'runtime', 'ToolGateway authorizes all tool execution from the resolved contract policy.'),
  entry('toolPolicy.allow', 'runtime', 'defineAgent verifies registered tools; ToolGateway and the Pi tool adapter expose/authorize only allowed tools.'),
  entry('toolPolicy.deny', 'runtime', 'ToolGateway rejects explicitly denied tools.'),
  entry('toolPolicy.externalRetrieval', 'runtime', 'ToolGateway rejects external retrieval tools unless policy allows targeted/full retrieval.'),
  entry('toolPolicy.writeScopes', 'runtime', 'ToolGateway rejects write tools outside contract write scopes.'),
  entry('modelPolicy', 'runtime', 'PiAgentBackend passes modelPolicy to ModelRouter; there is no alternate backend or automatic provider replay.'),
  entry('modelPolicy.tier', 'runtime', 'ModelRouter consumes tier during Pi model selection.'),
  entry('modelPolicy.preferredProviders', 'runtime', 'ModelRouter resolves the single preferred provider unless runtime supplies one explicit provider.'),
  entry('modelPolicy.reasoningLevel', 'runtime', 'PiAgentBackend maps reasoningLevel to Pi thinkingLevel.'),
  entry('runPolicy', 'runtime', 'PiAgentBackend, RunPolicyController, and ToolGateway consume run budgets.'),
  entry('runPolicy.maxTurns', 'runtime', 'Pi RunPolicyController enforces the high-water anomaly turn fuse.'),
  entry('runPolicy.deadlineMs', 'runtime', 'PiAgentBackend deadline timer consumes deadlineMs as the normal runtime boundary.'),
  entry('runPolicy.tokenBudget', 'runtime', 'Pi RunPolicyController enforces token budget.'),
  entry('runPolicy.toolCallBudget', 'runtime', 'Pi RunPolicyController owns the effective anomaly safety fuse and ToolGateway enforces its reservation.'),
  entry('runPolicy.retry', 'workflow', 'Canonical Run Analysis and Idea Generation executors consume retry policy through the Core single node retry owner; ReportAdmissionService is the sole direct retry owner for the report-overview admission candidate.'),
  entry('runPolicy.retry.maxAttempts', 'workflow', 'Canonical Agent nodes derive bounded node attempts from their bound contracts, while deterministic nodes default to one attempt; ReportAdmissionService bounds immediate report-overview physical calls from the effective definition.'),
  entry('runPolicy.retry.retryOn', 'workflow', 'Core FailurePolicy matches canonical node classifications; ReportAdmissionService matches report-overview transient/provider and repairable-output classifications before retrying.'),
  entry('completionPolicy', 'runtime', 'ContractEnforcer consumes completion policy after model execution.'),
  entry('completionPolicy.requiredArtifacts', 'runtime', 'ContractEnforcer rejects missing required artifacts and assertArtifactsCommitted verifies committed artifacts.'),
  entry('completionPolicy.hardChecks', 'runtime', 'ContractEnforcer dispatches registered hard checks and enables central output schema validation.'),
  entry('completionPolicy.gracefulFinalize', 'runtime', 'PiAgentBackend uses gracefulFinalize to decide whether to attempt one schema repair turn.'),
  entry('artifactAuthority', 'runtime', 'ContractEnforcer validates return/artifact authority against outputs and artifacts.'),
  entry('outputPaths', 'runtime', 'ContractEnforcer constrains returned artifact paths and validates required artifact path patterns.'),
]);

const nonCentralOutputSchemaBasis = Object.freeze({
  'analysis-plan': {
    alternateEnforcement: 'ContractEnforcer hard check plan-shape plus required artifact analysis/plan.json.',
    justification: 'No central JSON Schema exists for analysis-plan.output.v1; current production relies on hard check and artifact gating.',
  },
  'scan-score': {
    alternateEnforcement: 'ContractEnforcer hard checks bounded-pool and screen-shape plus required artifact analysis/scan.json.',
    justification: 'No central JSON Schema exists for scan-score.output.v1; current production relies on hard checks and artifact gating.',
  },




  'report-composer': {
    alternateEnforcement: 'ContractEnforcer non-empty-report hard check plus required report/report.md artifact.',
    justification: 'Report Composer returns Markdown text; no central JSON Schema exists for report-composer.output.v1.',
  },


  'conclusion-synthesizer': {
    alternateEnforcement: 'ContractEnforcer hard checks conclusion-schema and expected-return-score-clamp plus required conclusion artifact.',
    justification: 'No central JSON Schema exists for conclusion-synthesizer.output.v1.',
  },
  'report-editor': {
    alternateEnforcement: 'ToolGateway writeScopes restrict edits to report/** and ContractEnforcer validates declared artifactAuthority/outputPaths when artifacts are returned.',
    justification: 'No central JSON Schema or required artifact exists for report-editor.output.v1; this is a known output-shape gap for the edit reply.',
    knownGap: true,
  },
  'report-translator': {
    alternateEnforcement: 'ContractEnforcer non-empty-report hard check for translated Markdown text.',
    justification: 'Report Translator returns Markdown text; no central JSON Schema exists for report-translator.output.v1.',
  },
});

function buildOutputSchemaAudit() {
  return Object.freeze(listAgentDefinitions().map((definition) => {
    const centralResolver = !!getAgentSchema(definition.outputSchema);
    const basis = centralResolver ? {} : nonCentralOutputSchemaBasis[definition.id];
    return Object.freeze({
      agentId: definition.id,
      outputSchema: definition.outputSchema,
      centralResolver,
      category: centralResolver ? 'runtime' : 'documentationOnly',
      centralConsumer: centralResolver ? 'OutputGate via ContractEnforcer when hardChecks includes output-schema.' : null,
      alternateEnforcement: basis?.alternateEnforcement || null,
      justification: basis?.justification || null,
      knownGap: basis?.knownGap === true,
    });
  }));
}

export const OUTPUT_SCHEMA_AUDIT = buildOutputSchemaAudit();

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

export const AGENT_CONTRACT_CONSUMER_AUDIT_HASH = sha256({
  fields: AGENT_CONTRACT_FIELD_CATALOG,
  outputSchemas: OUTPUT_SCHEMA_AUDIT,
});

export const ACTIVE_AGENT_DEFINITION_TOP_LEVEL_FIELDS = Object.freeze([
  ...new Set(listAgentDefinitions().flatMap((definition) => Object.keys(definition))),
].sort());

const expectedFields = Object.freeze([
  ...AGENT_DEFINITION_REQUIRED_FIELDS,
  ...ACTIVE_AGENT_DEFINITION_TOP_LEVEL_FIELDS,
  'visibility.catalog',
  'visibility.workflows',
  'contextPolicy.mounts',
  'contextPolicy.artifactSelectors',
  'contextPolicy.maxInlineTokens',
  'contextPolicy.allowPriorReview',
  'contextPolicy.allowCrossProjectRead',
  'toolPolicy.allow',
  'toolPolicy.deny',
  'toolPolicy.externalRetrieval',
  'toolPolicy.writeScopes',
  'modelPolicy.tier',
  'modelPolicy.preferredProviders',
  'modelPolicy.reasoningLevel',
  'runPolicy.maxTurns',
  'runPolicy.deadlineMs',
  'runPolicy.tokenBudget',
  'runPolicy.toolCallBudget',
  'runPolicy.retry',
  'runPolicy.retry.maxAttempts',
  'runPolicy.retry.retryOn',
  'completionPolicy.requiredArtifacts',
  'completionPolicy.hardChecks',
  'completionPolicy.gracefulFinalize',
]);

export function validateAgentContractConsumerAudit() {
  const fields = AGENT_CONTRACT_FIELD_CATALOG.map((item) => item.field);
  const expected = [...new Set(expectedFields)].sort();
  const actual = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Agent Contract consumer catalog field drift: expected ${expected.join(', ')} got ${actual.join(', ')}`);
  }
  if (new Set(fields).size !== fields.length) throw new Error('Agent Contract consumer catalog contains duplicate fields');

  for (const item of AGENT_CONTRACT_FIELD_CATALOG) {
    if (!CATEGORIES.has(item.category)) throw new Error(`Invalid consumer category for ${item.field}: ${item.category}`);
    if (!item.consumer) throw new Error(`Missing consumer for ${item.field}`);
    if (item.category === 'documentationOnly' && !item.justification) {
      throw new Error(`documentationOnly field lacks justification: ${item.field}`);
    }
  }

  const definitions = listAgentDefinitions();
  const auditById = new Map(OUTPUT_SCHEMA_AUDIT.map((item) => [item.agentId, item]));
  if (auditById.size !== OUTPUT_SCHEMA_AUDIT.length) throw new Error('Output schema audit contains duplicate agent ids');
  for (const definition of definitions) {
    const item = auditById.get(definition.id);
    if (!item) throw new Error(`Missing outputSchema audit entry for ${definition.id}`);
    if (item.outputSchema !== definition.outputSchema) throw new Error(`outputSchema audit drift for ${definition.id}`);
    const resolves = !!getAgentSchema(definition.outputSchema);
    if (item.centralResolver !== resolves) throw new Error(`central resolver audit drift for ${definition.id}`);
    if (!resolves && (!item.alternateEnforcement || !item.justification)) {
      throw new Error(`non-central outputSchema entry lacks enforcement/justification: ${definition.id}`);
    }
  }

  for (const id of Object.keys(nonCentralOutputSchemaBasis)) {
    if (!auditById.has(id)) throw new Error(`non-central outputSchema basis references inactive agent: ${id}`);
  }
  return true;
}

function esc(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/gu, ' ').trim();
}

export function renderAgentContractConsumerAuditMarkdown() {
  validateAgentContractConsumerAudit();
  const centralCount = OUTPUT_SCHEMA_AUDIT.filter((item) => item.centralResolver).length;
  const nonCentralCount = OUTPUT_SCHEMA_AUDIT.length - centralCount;
  const lines = [
    '# Agent Contract Consumer Audit',
    '',
    '- Generated by: `backend/scripts/generateAgentContractConsumerDocs.mjs`',
    `- Audit hash: \`${AGENT_CONTRACT_CONSUMER_AUDIT_HASH}\``,
    `- Active Agents: ${OUTPUT_SCHEMA_AUDIT.length}`,
    `- Output schemas resolved by central resolver: ${centralCount}/${OUTPUT_SCHEMA_AUDIT.length}`,
    `- Output schemas explicitly classified as non-central/documentationOnly: ${nonCentralCount}/${OUTPUT_SCHEMA_AUDIT.length}`,
    '',
    '## Contract Field Consumers',
    '',
    '| Field | Category | Consumer | Justification |',
    '|---|---|---|---|',
    ...AGENT_CONTRACT_FIELD_CATALOG.map((item) => [
      `\`${item.field}\``,
      item.category,
      esc(item.consumer),
      esc(item.justification || (item.knownGap ? 'Known gap.' : '')),
    ].join(' | ')).map((row) => `| ${row} |`),
    '',
    '## Known Runtime Gaps',
    '',
    '- `inputSchema` is declared on every active Agent Contract but is not currently runtime-consumed by a central input validator.',
    '- `runPolicy.retry` is consumed by the Core node executor for canonical Run Analysis and Idea Generation Agent nodes. Deterministic nodes default to one attempt. Direct Agent calls generally add no retry loop; the explicit exception is Report Library admission, whose single candidate-level owner consumes the `report-overview` policy and gives each durable logical attempt one stable idempotency identity.',
    '- Non-central output schema ids below are not central `OutputGate` schema enforcement. Their current alternate enforcement is listed honestly per Agent.',
    '',
    '## Output Schema Audit',
    '',
    '| Agent | outputSchema | Central resolver | Category | Current enforcement / known gap |',
    '|---|---|---:|---|---|',
    ...OUTPUT_SCHEMA_AUDIT.map((item) => [
      `\`${item.agentId}\``,
      `\`${item.outputSchema}\``,
      item.centralResolver ? 'yes' : 'no',
      item.category,
      esc(item.centralResolver ? item.centralConsumer : `${item.alternateEnforcement} ${item.justification}`),
    ].join(' | ')).map((row) => `| ${row} |`),
    '',
  ];
  return `${lines.join('\n')}`;
}
