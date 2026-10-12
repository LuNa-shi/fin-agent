import { runDefinedAgent } from '../../agents/runDefinedAgent.js';
import {
  assertDirectExecutionScopeBinding,
  beginDirectAgentCommand,
} from '../../core/contracts/AgentExecutionScope.js';
import { TemplateSystem } from '../../domains/research/templates/templateSystem.js';

export async function classifyProjectSeed(text, {
  agentBackend,
  executionScope,
} = {}) {
  const scope = assertDirectExecutionScopeBinding(executionScope === undefined
    ? beginDirectAgentCommand({
      workflowId: 'quick-project.v1',
      nodeId: 'classify-project-seed',
      projectId: 'global',
      asOf: new Date().toISOString(),
      workspaceMode: 'none',
    })
    : executionScope, {
    workflowId: 'quick-project.v1',
    nodeId: 'classify-project-seed',
    projectId: 'global',
    workspaceMode: 'none',
  });
  const industryTemplates = TemplateSystem.industryTemplates()
    .map((template) => ({ id: template.id, name: template.name, scope: template.scope }));
  const companyTemplates = TemplateSystem.companyTemplates()
    .map((template) => ({ id: template.id, name: template.name, scope: template.scope }));
  const result = await runDefinedAgent(
    'project-classifier',
    { text, industryTemplates, companyTemplates },
    {
      scope,
      callId: 'classify-project-seed',
      ...(agentBackend === undefined ? {} : { backend: agentBackend }),
      kind: 'classify',
      userText: text,
      temperature: 0.4,
      throwOnFailure: false,
    },
  );
  const parsed = (
    result.status === 'succeeded'
    && result.valid !== false
    && result.output
    && typeof result.output === 'object'
  ) ? result.output : null;
  const industryMatched = TemplateSystem.matchIndustryTemplate(text);
  const companyMatched = TemplateSystem.matchCompanyTemplate(text);
  const seed = parsed || {
    title: text.length > 6 ? text.slice(0, 40) : `Preliminary screen: ${text}`,
    theme: industryMatched.template?.name?.replace(/行业模板$/u, '') || 'general',
    industryTemplate: industryMatched.template?.id || 'industry_generic',
    companyTemplate: companyMatched.template?.id || 'company_generic',
    rationale: `Potential structural expectation gap around "${text}" (supply/demand and industry trend).`,
    tickers: [],
  };
  if (!TemplateSystem.get(seed.industryTemplate)) {
    seed.industryTemplate = industryMatched.template?.id || 'industry_generic';
  }
  if (!TemplateSystem.get(seed.companyTemplate)) {
    seed.companyTemplate = companyMatched.template?.id || 'company_generic';
  }
  return {
    ...seed,
    provider: result.provider,
    live: result.live,
    matchedScore: Math.max(industryMatched.score || 0, companyMatched.score || 0),
  };
}
