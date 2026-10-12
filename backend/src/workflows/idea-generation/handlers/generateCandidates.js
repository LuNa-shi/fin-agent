import {
  getEffectiveAgentDefinition,
} from '../../../agents/AgentRuntimeService.js';
import { runDefinedAgent } from '../../../agents/runDefinedAgent.js';
import { canonicalSha256 } from '../../../core/contracts/ArtifactRef.js';
import { backfillDemoIdeas } from '../nodes/candidateSelection.js';
import {
  capturedIdeaRoutes,
  effectiveConfigByAgent,
} from '../runtime/inputSnapshot.js';
import { hydrate, jsonSnapshot, safeAgentResult } from './shared.js';

function assertCapturedConfiguration(context) {
  const captured = effectiveConfigByAgent(context.snapshot).get('idea-generator');
  const definition = (
    context.services.getEffectiveAgentDefinition || getEffectiveAgentDefinition
  )('idea-generator');
  if (definition.effectiveConfig.digest !== captured.digest) {
    const error = new TypeError(
      'idea-generator effective configuration changed after snapshot capture',
    );
    error.code = 'EFFECTIVE_AGENT_CONFIG_MISMATCH';
    throw error;
  }
  return { captured, definition };
}

function assertUsableGeneratorResult(result) {
  if (result?.status === 'succeeded' && result.valid !== false) return result;
  const schemaInvalid = (
    (result?.status === 'succeeded' && result.valid === false)
    || result?.stopReason === 'schema-invalid'
  );
  const error = new Error(
    `idea-generator failed: ${result?.stopReason || 'invalid result'}`,
    result?.error instanceof Error ? { cause: result.error } : undefined,
  );
  error.stopReason = schemaInvalid
    ? 'schema-invalid'
    : (result?.stopReason || 'error');
  if (schemaInvalid) {
    error.code = 'CONTRACT_COMPLETION_REJECTED';
  }
  error.agentRunResult = result;
  throw error;
}

export async function execute(context) {
  const collected = context.nodeResults['collect-market-context'];
  const constraints = context.nodeResults['build-diversification-constraints'];
  const { snapshot } = context;
  const generatorInput = {
    poolTarget: snapshot.inputs.command.poolTarget,
    market: collected.market,
    sourceCandidates: collected.sourceCandidates,
    heldThemes: constraints.heldThemes,
    heavyThemes: constraints.heavyThemes,
    existingTitles: constraints.existingTitles,
  };
  const { captured, definition } = assertCapturedConfiguration(context);
  const prompt = definition.prompt(generatorInput);

  if (snapshot.inputs.settings.DEMO_MODE === true) {
    const rawCandidates = backfillDemoIdeas(
      [],
      snapshot.inputs.command.count,
      constraints.existingTitles,
    ).map((idea, index) => ({
      ...idea,
      heat: Math.max(45, 75 - (index % 10) * 3),
      qualityScore: 50,
      sourceAgents: ['demo-idea-agent', ...(idea.sourceAgents || [])],
    }));
    return {
      generatorInputDigest: canonicalSha256(generatorInput),
      rawCandidates,
      agent: {
        status: 'succeeded',
        valid: true,
        provider: 'demo',
        model: 'deterministic-demo',
        live: false,
        stopReason: 'final',
        traceRef: `demo:${snapshot.runId}:generate-candidates`,
        metrics: { turns: 0, toolCalls: 0 },
      },
      prompt: {
        system: 'DEMO_MODE local idea generation',
        user: 'Generate deterministic demo ideas without external data access.',
      },
    };
  }

  const result = await runDefinedAgent('idea-generator', generatorInput, {
    callId: 'generate-candidates',
    expectedEffectiveConfigDigest: captured.digest,
    ...capturedIdeaRoutes(snapshot).generator,
    kind: 'idea',
    count: snapshot.inputs.command.poolTarget,
    temperature: 0.9,
    throwOnFailure: false,
  });
  assertUsableGeneratorResult(result);
  const rawCandidates = result.output?.ideas;
  return {
    generatorInputDigest: canonicalSha256(generatorInput),
    rawCandidates: Array.isArray(rawCandidates) ? jsonSnapshot(rawCandidates, []) : [],
    agent: safeAgentResult(result),
    prompt: {
      system: prompt.system,
      user: prompt.user,
    },
  };
}

export { hydrate };
