import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NODE_STATES,
  canTransitionNodeState,
  isFailureNodeState,
  transitionNodeState,
} from '../src/core/workflow/NodeState.js';
import {
  classifyWorkflowFailure,
  shouldRetryWorkflowFailure,
} from '../src/core/workflow/FailurePolicy.js';
import {
  canonicalAgentStatus,
  canonicalAgentStopReason,
} from '../src/core/agent-backend/agentOutcome.js';

test('node state machine permits only explicit durable lifecycle transitions', () => {
  assert.equal(canTransitionNodeState(NODE_STATES.PENDING, NODE_STATES.READY), true);
  assert.equal(canTransitionNodeState(NODE_STATES.READY, NODE_STATES.RUNNING), true);
  assert.equal(canTransitionNodeState(NODE_STATES.RUNNING, NODE_STATES.SUCCEEDED), true);
  assert.equal(canTransitionNodeState(NODE_STATES.SUCCEEDED, NODE_STATES.READY), false);
  assert.equal(isFailureNodeState(NODE_STATES.FAILED_SCHEMA), true);
  const running = transitionNodeState({ status: NODE_STATES.READY, attempt: 0 }, NODE_STATES.RUNNING, { attempt: 1 });
  assert.deepEqual(running, { status: NODE_STATES.RUNNING, attempt: 1 });
  assert.throws(
    () => transitionNodeState({ status: NODE_STATES.SUCCEEDED }, NODE_STATES.RUNNING),
    /invalid node state transition: SUCCEEDED -> RUNNING/u,
  );
});

test('failure policy separates transient, schema, permission, business, and cancellation outcomes', () => {
  assert.deepEqual(classifyWorkflowFailure(Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' })), {
    state: NODE_STATES.FAILED_TRANSIENT,
    category: 'transient',
    reason: 'ETIMEDOUT',
    retryKey: 'transient',
  });
  assert.equal(
    classifyWorkflowFailure(new Error('Provider request failed: 503 service unavailable')).state,
    NODE_STATES.FAILED_TRANSIENT,
  );
  assert.deepEqual(classifyWorkflowFailure(Object.assign(
    new Error('stream error: stream ID 1; INTERNAL_ERROR; received from peer'),
    { code: 'MODEL_TRANSPORT_TRANSIENT' },
  )), {
    state: NODE_STATES.FAILED_TRANSIENT,
    category: 'transient',
    reason: 'MODEL_TRANSPORT_TRANSIENT',
    retryKey: 'transient',
  });
  assert.equal(classifyWorkflowFailure(Object.assign(new Error('bad output'), { code: 'CONTRACT_COMPLETION_REJECTED' })).state, NODE_STATES.FAILED_SCHEMA);
  assert.equal(classifyWorkflowFailure(Object.assign(new Error('denied'), { code: 'TOOL_PERMISSION_DENIED' })).state, NODE_STATES.FAILED_PERMISSION);
  assert.equal(classifyWorkflowFailure(new Error('valuation assumption is invalid')).state, NODE_STATES.FAILED_BUSINESS);
  assert.equal(classifyWorkflowFailure(new Error('analysis paused or cancelled')).state, NODE_STATES.CANCELLED);
});

test('only declared transient classes consume Agent contract retry attempts', () => {
  const transient = classifyWorkflowFailure(Object.assign(new Error('provider unavailable'), { code: 'PI_MODEL_UNAVAILABLE' }));
  assert.equal(shouldRetryWorkflowFailure(transient, { maxAttempts: 2, retryOn: ['provider-unavailable'] }, 1), true);
  assert.equal(shouldRetryWorkflowFailure(transient, { maxAttempts: 2, retryOn: ['transient'] }, 1), false);
  assert.equal(shouldRetryWorkflowFailure(transient, { maxAttempts: 2, retryOn: ['provider-unavailable'] }, 2), false);
  assert.equal(shouldRetryWorkflowFailure(classifyWorkflowFailure(new Error('business')), { maxAttempts: 3, retryOn: ['transient'] }, 1), false);
});

test('Pi stop reasons share one canonical status vocabulary', () => {
  assert.equal(canonicalAgentStopReason('stop'), 'final');
  assert.equal(canonicalAgentStopReason('length'), 'model-length');
  assert.equal(canonicalAgentStopReason('aborted'), 'cancelled');
  assert.equal(canonicalAgentStatus({ stopReason: 'final', valid: true, outputPresent: true }), 'succeeded');
  assert.equal(canonicalAgentStatus({ stopReason: 'deadline', valid: true, outputPresent: true }), 'partial');
  assert.equal(canonicalAgentStatus({ stopReason: 'error', valid: true, outputPresent: true }), 'failed');
  assert.equal(canonicalAgentStatus({ stopReason: 'final', valid: false, outputPresent: true }), 'partial');
});
