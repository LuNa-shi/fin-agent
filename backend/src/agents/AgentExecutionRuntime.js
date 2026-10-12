import { assertAgentBackend } from '../core/agent-backend/AgentBackend.js';
import { agentResultExecutionProvenance } from '../core/agent-backend/IdempotentAgentBackend.js';
import { canonicalSha256 } from '../core/contracts/ArtifactRef.js';
import { createDirectExecutionScope } from '../core/contracts/AgentExecutionScope.js';
import { createAgentRunRequest } from '../core/contracts/agentContracts.js';
import { matchesAnyPathPattern } from '../core/policy/pathPolicy.js';
import { currentWorkflowNodeContext } from '../core/workflow/WorkflowRunContext.js';
import { getDefaultAgentBackend } from './defaultAgentBackend.js';
import { getEffectiveAgentDefinition } from './AgentRuntimeService.js';

const CONTROL_OPTIONS = new Set([
  'backend',
  'callId',
  'expectedEffectiveConfigDigest',
  'scope',
  'throwOnFailure',
]);
const FORBIDDEN_REQUEST_OPTIONS = new Set([
  'runId',
  'workflowId',
  'nodeId',
  'projectId',
  'agentContractId',
  'contractVersion',
  'asOf',
  'input',
  'inputArtifactRefs',
  'workspaceSnapshotId',
  'priorReviewIssues',
  'effectiveConfigRevision',
  'effectiveConfigDigest',
  'idempotencyKey',
  'idempotencyKeyMode',
  'artifactCommitOwner',
  'costKnown',
  'contractOverride',
  'demo',
  'live',
  'signal',
  'workflowAttempt',
  'workspaceMode',
]);

function runtimeOverrides(options) {
  const forbidden = Object.keys(options).filter((key) => FORBIDDEN_REQUEST_OPTIONS.has(key));
  if (forbidden.length) {
    throw new TypeError(`Agent request identity must be supplied by an execution scope: ${forbidden.join(', ')}`);
  }
  return Object.fromEntries(
    Object.entries(options).filter(([key]) => !CONTROL_OPTIONS.has(key)),
  );
}

function workflowArtifactRefs(definition, references) {
  return references.filter((reference) => (
    typeof reference?.path === 'string'
    && matchesAnyPathPattern(reference.path, definition.contextPolicy.artifactSelectors)
  ));
}

function requestedCallId(options) {
  if (!Object.prototype.hasOwnProperty.call(options, 'callId')) return null;
  if (typeof options.callId !== 'string' || !options.callId.trim()) {
    throw new TypeError('Agent execution callId must be a non-empty string');
  }
  return options.callId;
}

function assertExpectedEffectiveConfigDigest(options, definition) {
  if (!Object.prototype.hasOwnProperty.call(options, 'expectedEffectiveConfigDigest')) return;
  const expected = options.expectedEffectiveConfigDigest;
  if (typeof expected !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(expected)) {
    throw new TypeError('expectedEffectiveConfigDigest must be a canonical sha256 digest');
  }
  if (definition.effectiveConfig?.digest !== expected) {
    const error = new TypeError(
      `Agent ${definition.id} effective configuration changed after command capture`,
    );
    error.code = 'EFFECTIVE_AGENT_CONFIG_MISMATCH';
    throw error;
  }
}

function workflowCallIdentity(context, definition, input, callId) {
  const logicalCallDigest = canonicalSha256(callId == null
    ? {
      agentContractId: definition.id,
      effectiveConfigDigest: definition.effectiveConfig.digest,
      input,
    }
    : {
      agentContractId: definition.id,
      effectiveConfigDigest: definition.effectiveConfig.digest,
      callId,
    });
  return [
    context.run.runId,
    context.node.nodeId,
    definition.id,
    logicalCallDigest.slice('sha256:'.length),
  ].join(':');
}

function directCallIdentity(scope, definition, input, callId) {
  const logicalCallDigest = canonicalSha256({
    executionScope: {
      runId: scope.runId,
      workflowId: scope.workflowId,
      nodeId: scope.nodeId,
      projectId: scope.projectId,
      asOf: scope.asOf,
      workspaceMode: scope.workspaceMode,
      workspaceSnapshotId: scope.workspaceSnapshotId,
    },
    agentContractId: definition.id,
    effectiveConfigDigest: definition.effectiveConfig.digest,
    logicalCall: callId === null ? { input } : { callId },
  });
  const suffix = `${definition.id}:${logicalCallDigest.slice('sha256:'.length)}`;
  return {
    runId: `${scope.runId}:${suffix}`,
    idempotencyKey: `${scope.idempotencyKey}:${suffix}`,
  };
}

function assertWorkspaceIntent({
  workspaceMode,
  inputArtifactRefs = [],
  priorReviewIssues = [],
}, definition) {
  const mounts = definition.contextPolicy.mounts || [];
  const tools = definition.toolPolicy?.allow || [];
  const writeScopes = definition.toolPolicy?.writeScopes || [];
  const requiresProjectTools = tools.some((toolId) => (
    typeof toolId === 'string'
    && (toolId.startsWith('ws_') || toolId.startsWith('project_'))
  ));
  if (workspaceMode === 'none') {
    const acceptsRunOwnedInputs = mounts.length === 0 && !requiresProjectTools && writeScopes.length === 0;
    if (
      (!acceptsRunOwnedInputs && inputArtifactRefs.length)
      || priorReviewIssues.length
      || requiresProjectTools
      || writeScopes.length
    ) {
      throw new TypeError(
        `Agent ${definition.id} requires workspace inputs but direct scope mode is none`,
      );
    }
  }
  if (
    workspaceMode === 'idea-run'
    && (
      mounts.some((mount) => (
        typeof mount === 'string'
        && (mount === '/project' || mount.startsWith('/project/'))
      ))
      || requiresProjectTools
      || writeScopes.length
    )
  ) {
    throw new TypeError(
      `Agent ${definition.id} requires Project workspace access and cannot use idea-run mode`,
    );
  }
}

function failedResultError(agentId, result) {
  const error = result?.error instanceof Error
    ? result.error
    : new Error(`${agentId} failed: ${result?.stopReason || 'unknown error'}`);
  error.stopReason = result?.stopReason || 'error';
  error.agentRunResult = result;
  return error;
}

export function withAgentResultObserver(agentBackend, onResult) {
  const observedBackend = assertAgentBackend(agentBackend);
  if (typeof onResult !== 'function') throw new TypeError('Agent result observer must be a function');
  return {
    async run(request, runtime = {}) {
      const result = await observedBackend.run(request, runtime);
      await onResult({
        request,
        result,
        runtime,
        provenance: agentResultExecutionProvenance(runtime),
      });
      return result;
    },
    async cancel(runId, nodeId) {
      return typeof observedBackend.cancel === 'function'
        ? observedBackend.cancel(runId, nodeId)
        : false;
    },
  };
}

export class AgentExecutionRuntime {
  constructor({
    definitionResolver = getEffectiveAgentDefinition,
    backendResolver = getDefaultAgentBackend,
  } = {}) {
    if (typeof definitionResolver !== 'function') {
      throw new TypeError('AgentExecutionRuntime definitionResolver must be a function');
    }
    if (typeof backendResolver !== 'function') {
      throw new TypeError('AgentExecutionRuntime backendResolver must be a function');
    }
    this.definitionResolver = definitionResolver;
    this.backendResolver = backendResolver;
  }

  resolveBackend(backend = null) {
    if (arguments.length === 0) return assertAgentBackend(this.backendResolver());
    return assertAgentBackend(backend);
  }

  async run(agentId, input = {}, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Agent execution options must be an object');
    }
    const definition = this.definitionResolver(agentId);
    assertExpectedEffectiveConfigDigest(options, definition);
    const workflowContext = currentWorkflowNodeContext();
    const runtime = runtimeOverrides(options);
    const callId = requestedCallId(options);
    let backend;
    let requestIdentity;
    let signal = null;

    if (workflowContext) {
      const workflowBackend = workflowContext.services.agentBackend;
      if (workflowContext.services.agentRuntime !== this) {
        throw new TypeError('Workflow Agent runtime does not match the injected node service');
      }
      if (Object.prototype.hasOwnProperty.call(options, 'backend')) {
        throw new TypeError('Workflow Agent backend cannot be replaced by handler options');
      }
      if (Object.prototype.hasOwnProperty.call(options, 'scope')) {
        throw new TypeError('Workflow Agent direct scope cannot be supplied by handler options');
      }
      if (!workflowBackend) {
        throw new TypeError('Workflow Agent backend must be injected by the executor');
      }
      assertWorkspaceIntent({
        workspaceMode: workflowContext.run.workspaceMode,
        inputArtifactRefs: workflowContext.inputs.artifactRefs,
        priorReviewIssues: workflowContext.inputs.priorReviewIssues,
      }, definition);
      backend = this.resolveBackend(workflowBackend);
      const callIdentity = workflowCallIdentity(
        workflowContext,
        definition,
        input,
        callId,
      );
      requestIdentity = {
        runId: callIdentity,
        workflowId: workflowContext.workflow.id,
        nodeId: workflowContext.node.nodeId,
        projectId: workflowContext.run.projectId,
        asOf: workflowContext.run.asOf,
        inputArtifactRefs: workflowArtifactRefs(
          definition,
          workflowContext.inputs.artifactRefs,
        ),
        workspaceSnapshotId: workflowContext.inputs.workspaceSnapshotId,
        priorReviewIssues: definition.contextPolicy.allowPriorReview
          ? workflowContext.inputs.priorReviewIssues
          : [],
        idempotencyKey: callIdentity,
      };
      runtime.artifactCommitOwner = 'workflow';
      runtime.workflowAttempt = workflowContext.node.attempt;
      runtime.workspaceMode = workflowContext.run.workspaceMode;
      signal = workflowContext.signal;
    } else {
      const scope = createDirectExecutionScope(options.scope);
      assertWorkspaceIntent(scope, definition);
      backend = Object.prototype.hasOwnProperty.call(options, 'backend')
        ? this.resolveBackend(options.backend)
        : this.resolveBackend();
      const callIdentity = directCallIdentity(scope, definition, input, callId);
      requestIdentity = {
        runId: callIdentity.runId,
        workflowId: scope.workflowId,
        nodeId: scope.nodeId,
        projectId: scope.projectId,
        asOf: scope.asOf,
        inputArtifactRefs: workflowArtifactRefs(
          definition,
          scope.inputArtifactRefs,
        ),
        workspaceSnapshotId: scope.workspaceSnapshotId,
        priorReviewIssues: definition.contextPolicy.allowPriorReview
          ? scope.priorReviewIssues
          : [],
        idempotencyKey: callIdentity.idempotencyKey,
      };
      runtime.artifactCommitOwner = 'agent';
      runtime.workspaceMode = scope.workspaceMode;
      signal = scope.signal;
    }

    const request = createAgentRunRequest({
      ...requestIdentity,
      agentContractId: definition.id,
      contractVersion: definition.version,
      input,
      effectiveConfigRevision: definition.effectiveConfig.revision,
      effectiveConfigDigest: definition.effectiveConfig.digest,
      idempotencyKeyMode: 'explicit',
    });
    runtime.projectId = request.projectId;
    runtime.contractOverride = definition;
    if (signal !== null && signal !== undefined) runtime.signal = signal;

    const result = await backend.run(request, runtime);
    if (result?.status === 'failed' && options.throwOnFailure !== false) {
      throw failedResultError(agentId, result);
    }
    return result;
  }
}

export const agentExecutionRuntime = new AgentExecutionRuntime();
