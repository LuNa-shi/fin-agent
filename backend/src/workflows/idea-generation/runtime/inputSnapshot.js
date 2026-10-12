import crypto from 'node:crypto';

import { agentRuntimeService } from '../../../agents/AgentRuntimeService.js';
import { runtime } from '../../../config.js';
import { canonicalSha256 } from '../../../core/contracts/ArtifactRef.js';
import { Mandate, Store } from '../../../core/persistence/globalState.js';
import {
  IDEA_RUN_EFFECTIVE_CONFIG_AGENTS,
  IdeaStore,
  ideaRunInputSnapshotStore,
} from '../../../domains/ideas/index.js';
import {
  IDEA_GENERATION_WORKFLOW_SPEC,
  IDEA_GENERATION_WORKFLOW_SPEC_HASH,
} from '../workflowSpec.js';

const SNAPSHOT_SETTING_FIELDS = Object.freeze([
  'DEFAULT_PROVIDER',
  'OPENAI_COMPATIBLE_MODEL',
  'OPENAI_COMPATIBLE_REASONING_LEVEL',
  'DEEPSEEK_MODEL',
  'SMALL_PROVIDER',
  'SMALL_MODEL',
  'MAIN_PROVIDER',
  'MAIN_MODEL',
  'REFLECTION_PROVIDER',
  'REFLECTION_MODEL',
  'UI_LANGUAGE',
  'ANALYSIS_LANGUAGE',
  'REPORT_LANGUAGE',
  'DEMO_MODE',
]);
const SNAPSHOT_POSITION_FIELDS = Object.freeze([
  'id',
  'ticker',
  'name',
  'theme',
  'reason',
  'weight',
  'rank',
  'confidence',
  'status',
  'addedAt',
]);

function ownDefined(source, fields) {
  return Object.fromEntries(fields
    .filter((field) => Object.prototype.hasOwnProperty.call(source || {}, field))
    .filter((field) => source[field] !== undefined)
    .map((field) => [field, source[field]]));
}

function captureExistingIdeas(ideas = []) {
  return ideas.map((idea) => {
    const captured = {
      id: idea.id,
      type: 'idea',
      status: idea.status,
      title: idea.title,
      theme: idea.theme,
      tickers: idea.tickers,
      createdAt: idea.createdAt,
      updatedAt: idea.updatedAt,
    };
    if (idea.contentRef !== undefined && idea.contentDigest !== undefined) {
      captured.contentRef = idea.contentRef;
      captured.contentDigest = idea.contentDigest;
    }
    return ownDefined(captured, [
      'id',
      'type',
      'status',
      'title',
      'theme',
      'tickers',
      'contentRef',
      'contentDigest',
      'createdAt',
      'updatedAt',
    ]);
  });
}

function capturePositions(positions = []) {
  return positions.map((position) => ownDefined(position, SNAPSHOT_POSITION_FIELDS));
}

function captureSettings(settings = runtime) {
  return ownDefined(settings, SNAPSHOT_SETTING_FIELDS);
}

function captureEffectiveConfig(catalog = agentRuntimeService) {
  const agents = new Map(catalog.listAgents().map((agent) => [agent.id, agent]));
  return {
    agents: IDEA_RUN_EFFECTIVE_CONFIG_AGENTS.map((agentId) => {
      const projected = agents.get(agentId);
      if (!projected?.effectiveConfig?.digest || !projected.effectiveConfig.revision) {
        throw new TypeError(`effective Agent configuration unavailable: ${agentId}`);
      }
      return {
        agentId,
        revision: projected.effectiveConfig.revision,
        digest: projected.effectiveConfig.digest,
      };
    }),
  };
}

function assertSnapshot(snapshot, { count, runId }) {
  const mismatches = [];
  if (snapshot.runId !== runId) mismatches.push('runId');
  if (snapshot.workflow.id !== IDEA_GENERATION_WORKFLOW_SPEC.id) mismatches.push('workflowId');
  if (snapshot.workflow.version !== IDEA_GENERATION_WORKFLOW_SPEC.version) mismatches.push('workflowVersion');
  if (snapshot.workflow.hash !== IDEA_GENERATION_WORKFLOW_SPEC_HASH) mismatches.push('workflowHash');
  if (snapshot.inputs.command.count !== count) mismatches.push('command.count');
  if (mismatches.length) {
    const error = new TypeError(`Idea run snapshot mismatch: ${mismatches.join(', ')}`);
    error.code = 'IDEA_RUN_SNAPSHOT_BINDING_MISMATCH';
    throw error;
  }
  return snapshot;
}

export function openIdeaRunInputSnapshot(count, { services = {} } = {}) {
  if (!Number.isInteger(count) || count <= 0) {
    throw new TypeError('Idea Generation count must be a positive integer');
  }
  const snapshotStore = services.snapshotStore || ideaRunInputSnapshotStore;
  const runId = services.runId || `idea_run_${crypto.randomUUID()}`;
  const existing = snapshotStore.load(runId);
  if (existing) return assertSnapshot(existing, { count, runId });

  const asOf = services.asOf || new Date().toISOString();
  const poolTarget = count > 20
    ? count
    : Math.min(20, Math.max(count * 2 + 2, count + 6));
  const targetPerNode = 8;
  const ideaStore = services.ideaStore || IdeaStore;
  const mandate = (services.getMandate || (() => Mandate.get()))();
  const snapshot = snapshotStore.create({
    runId,
    workflow: {
      id: IDEA_GENERATION_WORKFLOW_SPEC.id,
      version: IDEA_GENERATION_WORKFLOW_SPEC.version,
      hash: IDEA_GENERATION_WORKFLOW_SPEC_HASH,
    },
    asOf,
    inputs: {
      existingIdeas: captureExistingIdeas(ideaStore.getIdeas()),
      positions: capturePositions(
        (services.getPortfolio || (() => Store.getPortfolio()))(),
      ),
      mandate: ownDefined(mandate, Object.keys(mandate)),
      settings: captureSettings(services.runtimeSettings || runtime),
      command: { count, poolTarget, targetPerNode },
    },
    effectiveConfig: captureEffectiveConfig(
      services.agentCatalog || agentRuntimeService,
    ),
  });
  return assertSnapshot(snapshot, { count, runId });
}

function activeProvider(provider) {
  return provider === 'gpt-gateway' ? 'openai-compatible' : provider;
}

function modelForProvider(settings, provider) {
  if (provider === 'openai-compatible' || provider === 'gpt-gateway') {
    return settings.OPENAI_COMPATIBLE_MODEL || settings.GPT_GATEWAY_MODEL;
  }
  if (provider === 'deepseek') return settings.DEEPSEEK_MODEL;
  throw new TypeError(`captured Idea route has unsupported provider: ${provider || '(empty)'}`);
}

export function capturedIdeaRoutes(snapshot) {
  const settings = snapshot.inputs.settings;
  const capturedMainProvider = settings.MAIN_PROVIDER || settings.DEFAULT_PROVIDER;
  const main = {
    provider: activeProvider(capturedMainProvider),
    model: settings.MAIN_MODEL || modelForProvider(settings, capturedMainProvider),
  };
  const smallConfigured = !!(settings.SMALL_PROVIDER || settings.SMALL_MODEL);
  const capturedSmallProvider = settings.SMALL_PROVIDER || capturedMainProvider;
  const small = smallConfigured
    ? {
        provider: activeProvider(capturedSmallProvider),
        model: settings.SMALL_MODEL || modelForProvider(settings, capturedSmallProvider),
      }
    : { ...main };
  return { generator: main, reviewer: small };
}

export function effectiveConfigByAgent(snapshot) {
  return new Map(snapshot.effectiveConfig.agents.map((agent) => [agent.agentId, agent]));
}

export function ideaRunInputDigest(snapshot, scope) {
  return canonicalSha256({
    workflowSpecHash: IDEA_GENERATION_WORKFLOW_SPEC_HASH,
    runId: snapshot.runId,
    snapshotId: snapshot.snapshotId,
    snapshotContentDigest: snapshot.contentDigest,
    configDigest: snapshot.configDigest,
    asOf: snapshot.asOf,
    scope,
  });
}
