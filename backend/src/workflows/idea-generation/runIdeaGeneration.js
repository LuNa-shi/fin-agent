import { agentExecutionRuntime } from '../../agents/AgentExecutionRuntime.js';
import { withAgentExecutionObserver } from '../../core/agent-backend/AgentExecutionObserver.js';
import { canonicalSha256 } from '../../core/contracts/ArtifactRef.js';
import { assertDirectExecutionScopeBinding } from '../../core/contracts/AgentExecutionScope.js';
import { executeWorkflowSpec } from '../../core/workflow/WorkflowExecutor.js';
import { NODE_STATES } from '../../core/workflow/NodeState.js';
import { globalContentIndex } from '../../core/persistence/GlobalContentIndex.js';
import { IdeaStore, ideaRunInputSnapshotStore } from '../../domains/ideas/index.js';
import { RUN_STATUSES } from '../../project-space/RunStore.js';
import { createDurableAgentExecutionObserver } from '../../project-space/agentRunTraceProjection.js';
import {
  IDEA_GENERATION_CONDITION_BINDINGS,
  IDEA_GENERATION_HANDLER_BINDINGS,
  IDEA_GENERATION_HYDRATION_BINDINGS,
} from './bindings.js';
import {
  commitIdeaNodeOutput,
  reconcileCommittedIdeaNodeOutputs,
} from './completion/nodeArtifacts.js';
import {
  IDEA_GENERATION_SCOPE,
  IdeaGenerationRunStorage,
  ideaGenerationRunStorage,
} from './runtime/IdeaGenerationRunStorage.js';
import {
  ideaRunInputDigest,
  openIdeaRunInputSnapshot,
} from './runtime/inputSnapshot.js';
import {
  ideaGenerationNodeInputDigest,
  ideaGenerationRetryPolicyForNode,
  ideaGenerationWorkspaceSnapshot,
} from './runtime/runPolicy.js';
import {
  assertIdeaGenerationRunInvocable,
  exhaustedInterruptedIdeaGenerationNode,
  IdeaRunNotResumableError,
  recoverIdeaGenerationCandidates,
} from './recovery.js';
import {
  IDEA_GENERATION_WORKFLOW_SPEC,
  IDEA_GENERATION_WORKFLOW_SPEC_HASH,
} from './workflowSpec.js';

function workflowIdentity() {
  return {
    id: IDEA_GENERATION_WORKFLOW_SPEC.id,
    version: IDEA_GENERATION_WORKFLOW_SPEC.version,
    hash: IDEA_GENERATION_WORKFLOW_SPEC_HASH,
  };
}

function assertSameSnapshot(expected, actual) {
  if (
    actual.runId !== expected.runId
    || actual.snapshotId !== expected.snapshotId
    || actual.contentDigest !== expected.contentDigest
    || actual.asOf !== expected.asOf
  ) {
    const error = new Error('Idea run storage resolved a conflicting input snapshot');
    error.code = 'IDEA_RUN_SNAPSHOT_BINDING_MISMATCH';
    throw error;
  }
}

function resolveRunStorage(services, snapshotStore) {
  if (services.runStorage) return services.runStorage;
  if (snapshotStore === ideaRunInputSnapshotStore) return ideaGenerationRunStorage;
  return new IdeaGenerationRunStorage({
    runsDir: services.runsDir || snapshotStore.runsDir,
    snapshotStore,
    scope: services.scope || IDEA_GENERATION_SCOPE,
    ...(services.runNow ? { now: services.runNow } : {}),
  });
}

function instrumentBindings(bindings, completedIds) {
  return Object.fromEntries(Object.entries(bindings).map(([handlerId, binding]) => [
    handlerId,
    async (...args) => {
      const result = await binding(...args);
      completedIds.push(args[1].id);
      return result;
    },
  ]));
}

function withCapturedDemoMode(agentBackend, demo) {
  if (!agentBackend) return null;
  return {
    run(request, runtime = {}) {
      return agentBackend.run(request, { ...runtime, demo });
    },
    cancel(runId, nodeId) {
      return typeof agentBackend.cancel === 'function'
        ? agentBackend.cancel(runId, nodeId)
        : false;
    },
  };
}

export function withIdeaGenerationAgentExecutionTrace(agentBackend, {
  demo,
  workflowRunId,
  observer,
} = {}) {
  if (!agentBackend) return null;
  return withCapturedDemoMode(
    withAgentExecutionObserver(agentBackend, {
      workflowRunId,
      observer,
    }),
    demo,
  );
}

function resultProjection({
  context,
  execution,
  runRecord,
  executedNodeIds,
  hydratedNodeIds,
}) {
  const generator = execution.nodeResults['generate-candidates'] || null;
  const reviewer = execution.nodeResults['review-quality'] || null;
  const persisted = execution.nodeResults['persist-ideas'] || null;
  const currentIdeas = context.services.ideaStore.getIdeas();
  const agentResults = [generator?.agent, reviewer?.agent].filter(Boolean);
  return {
    workflowId: IDEA_GENERATION_WORKFLOW_SPEC.id,
    runId: context.runId,
    snapshotId: context.snapshot.snapshotId,
    asOf: context.snapshot.asOf,
    status: runRecord.status,
    stopReason: runRecord.stopReason,
    ideas: currentIdeas,
    generated: persisted?.committed || [],
    rejected: persisted?.rejected || execution.nodeResults['verify-candidates']?.rejected || [],
    provider: generator?.agent?.provider || (
      context.snapshot.inputs.settings.DEMO_MODE === true ? 'demo' : null
    ),
    live: agentResults.some((result) => result.live === true),
    traceId: context.runId,
    nodeExecutions: execution.nodeExecutions,
    execution: {
      executedNodeIds,
      hydratedNodeIds,
      stoppedAt: execution.stoppedAt || null,
    },
  };
}

function assertRunStorage(storage) {
  if (
    !storage
    || typeof storage.services !== 'function'
    || typeof storage.singleFlight !== 'function'
  ) {
    throw new TypeError('Idea Generation run storage is invalid');
  }
  return storage;
}

function compatibilityExecutionScope(value, services) {
  if (value === undefined) return null;
  const scope = assertDirectExecutionScopeBinding(value, {
    workflowId: IDEA_GENERATION_WORKFLOW_SPEC.id,
    nodeId: 'generate-ideas',
    projectId: IDEA_GENERATION_SCOPE.id,
    workspaceMode: 'idea-run',
  });
  if (scope.inputArtifactRefs.length || scope.priorReviewIssues.length) {
    throw new TypeError('Idea Generation command scope cannot inject artifact or review inputs');
  }
  if (services.runId !== undefined && services.runId !== scope.runId) {
    throw new TypeError('Idea Generation command scope conflicts with services.runId');
  }
  return scope;
}

export async function runIdeaGenerationWorkflow(count = 20, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Idea Generation options must be an object');
  }
  const {
    agentBackend: requestedAgentBackend,
    executionScope,
    services = {},
    signal = null,
    stopAfterNodeId = null,
  } = options;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw new TypeError('Idea Generation services must be an object');
  }
  const commandScope = compatibilityExecutionScope(executionScope, services);
  const executionSignal = signal || commandScope?.signal || null;
  const snapshotStore = services.snapshotStore || ideaRunInputSnapshotStore;
  const snapshot = openIdeaRunInputSnapshot(count, {
    services: {
      ...services,
      snapshotStore,
      ...(commandScope ? { runId: commandScope.runId } : {}),
    },
  });
  if (
    commandScope
    && (
      commandScope.workspaceSnapshotId !== snapshot.snapshotId
      || commandScope.asOf !== snapshot.asOf
    )
  ) {
    const error = new TypeError('Idea execution scope conflicts with its durable input snapshot');
    error.code = 'IDEA_RUN_SNAPSHOT_BINDING_MISMATCH';
    throw error;
  }
  const runStorage = assertRunStorage(resolveRunStorage(services, snapshotStore));

  return runStorage.singleFlight(snapshot.runId, async () => {
    const durable = runStorage.services(snapshot.runId, { initialize: true });
    assertSameSnapshot(snapshot, durable.snapshot);
    const ideaStore = services.ideaStore || IdeaStore;
    const index = services.globalContentIndex || ideaStore.index || globalContentIndex;
    const existed = durable.runStore.load(snapshot.runId);
    assertIdeaGenerationRunInvocable(existed);
    let record = durable.runStore.begin({
      runId: snapshot.runId,
      workflowSpec: workflowIdentity(),
      inputDigest: ideaRunInputDigest(snapshot, durable.scope),
      asOf: snapshot.asOf,
      nodeIds: IDEA_GENERATION_WORKFLOW_SPEC.nodes.map((node) => node.id),
      scope: durable.scope,
      workspaceMode: 'idea-run',
      workspaceSnapshotId: snapshot.snapshotId,
    });
    const context = {
      spec: IDEA_GENERATION_WORKFLOW_SPEC,
      specHash: IDEA_GENERATION_WORKFLOW_SPEC_HASH,
      scope: durable.scope,
      runId: snapshot.runId,
      snapshot,
      runStore: durable.runStore,
      eventBus: durable.eventBus,
      artifactStore: durable.artifactStore,
      services: {
        ...services,
        ideaStore,
        globalContentIndex: index,
      },
    };

    record = reconcileCommittedIdeaNodeOutputs(context);
    if (existed?.status === RUN_STATUSES.RUNNING) {
      const exhausted = exhaustedInterruptedIdeaGenerationNode({
        record,
        nodes: IDEA_GENERATION_WORKFLOW_SPEC.nodes,
        retryPolicyForNode: ideaGenerationRetryPolicyForNode,
      });
      if (exhausted) {
        record = durable.runStore.failNode(
          snapshot.runId,
          exhausted.node.id,
          {
            state: NODE_STATES.FAILED_TRANSIENT,
            category: 'transient',
            reason: 'process-interrupted-retry-budget-exhausted',
            retryKey: null,
          },
          Object.assign(
            new Error('process-interrupted-retry-budget-exhausted'),
            { code: 'PROCESS_TERMINATED' },
          ),
        );
        throw new IdeaRunNotResumableError(record);
      }
      record = durable.runStore.prepareResume(snapshot.runId);
    }

    const demo = snapshot.inputs.settings.DEMO_MODE === true;
    const hasRequestedBackend = Object.prototype.hasOwnProperty.call(
      options,
      'agentBackend',
    );
    const resolvedAgentBackend = demo && !hasRequestedBackend
      ? null
      : (
          hasRequestedBackend
            ? agentExecutionRuntime.resolveBackend(requestedAgentBackend)
            : agentExecutionRuntime.resolveBackend()
        );
    const agentBackend = withIdeaGenerationAgentExecutionTrace(resolvedAgentBackend, {
      demo,
      workflowRunId: snapshot.runId,
      observer: createDurableAgentExecutionObserver({
        eventBus: durable.eventBus,
        workflowRunId: snapshot.runId,
      }),
    });
    const executedNodeIds = [];
    const hydratedNodeIds = [];
    const execution = await executeWorkflowSpec({
      spec: IDEA_GENERATION_WORKFLOW_SPEC,
      handlers: IDEA_GENERATION_HANDLER_BINDINGS,
      hydrators: instrumentBindings(
        IDEA_GENERATION_HYDRATION_BINDINGS,
        hydratedNodeIds,
      ),
      conditions: IDEA_GENERATION_CONDITION_BINDINGS,
      context,
      runStore: durable.runStore,
      runId: snapshot.runId,
      nodeInputDigest: ideaGenerationNodeInputDigest,
      retryPolicyForNode: ideaGenerationRetryPolicyForNode,
      workspaceSnapshotForNode: ideaGenerationWorkspaceSnapshot,
      onNodeComplete: (completion) => {
        const committed = commitIdeaNodeOutput(completion);
        executedNodeIds.push(completion.node.id);
        return committed;
      },
      agentRuntime: agentExecutionRuntime,
      agentBackend,
      signal: executionSignal,
      stopAfterNodeId,
    });
    record = execution.stoppedAt
      ? durable.runStore.load(snapshot.runId)
      : durable.runStore.completeRun(snapshot.runId);
    return resultProjection({
      context,
      execution,
      runRecord: record,
      executedNodeIds,
      hydratedNodeIds,
    });
  });
}

export async function resumeIdeaGenerationWorkflow(runId, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Idea Generation resume options must be an object');
  }
  const services = options.services || {};
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw new TypeError('Idea Generation resume services must be an object');
  }
  if (services.runId !== undefined && services.runId !== runId) {
    throw new TypeError('Idea Generation resume run id conflicts with services.runId');
  }
  const requestedSnapshotStore = services.snapshotStore || ideaRunInputSnapshotStore;
  const runStorage = assertRunStorage(resolveRunStorage(
    services,
    requestedSnapshotStore,
  ));
  const durable = runStorage.services(runId);
  const snapshotStore = services.snapshotStore
    || runStorage.snapshotStore
    || requestedSnapshotStore;
  return runIdeaGenerationWorkflow(
    durable.snapshot.inputs.command.count,
    {
      ...options,
      services: {
        ...services,
        runId,
        runStorage,
        snapshotStore,
      },
    },
  );
}

export async function recoverInterruptedIdeaGenerationRuns({
  runStorage = ideaGenerationRunStorage,
  options = {},
} = {}) {
  const storage = assertRunStorage(runStorage);
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Idea Generation recovery options must be an object');
  }
  const optionServices = options.services || {};
  return recoverIdeaGenerationCandidates({
    storage,
    resume: ({ runId }) => resumeIdeaGenerationWorkflow(runId, {
      ...options,
      services: {
        ...optionServices,
        runStorage: storage,
        snapshotStore: storage.snapshotStore,
      },
    }),
  });
}

export function ideaGenerationRunIdentityDigest(result) {
  return canonicalSha256({
    workflowId: result.workflowId,
    runId: result.runId,
    snapshotId: result.snapshotId,
    asOf: result.asOf,
  });
}
