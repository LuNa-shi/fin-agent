import test from 'node:test';
import assert from 'node:assert/strict';

import { agentPromptCacheSessionId } from '../src/core/models/agentPromptCache.js';

const baseRequest = Object.freeze({
  workflowId: 'run-analysis.v1',
  runId: 'run-private-identity',
  nodeId: 'evaluate-report',
  agentContractId: 'evidence-reviewer',
  idempotencyKey: 'project-private-input',
  effectiveConfigDigest: `sha256:${'a'.repeat(64)}`,
});

test('prompt cache identity is stable, opaque, and changes with every logical Agent identity field', () => {
  const expected = 'finagent-pc-v1-069ac257bfaffc34031841ba7fd48a0477b7b16258823cfb';
  assert.equal(agentPromptCacheSessionId(baseRequest), expected);
  assert.equal(agentPromptCacheSessionId({ ...baseRequest }), expected);
  assert.equal(expected.includes(baseRequest.runId), false);
  assert.equal(expected.includes(baseRequest.idempotencyKey), false);
  assert.ok(expected.length <= 64);

  for (const field of [
    'workflowId',
    'runId',
    'nodeId',
    'agentContractId',
    'idempotencyKey',
    'effectiveConfigDigest',
  ]) {
    assert.notEqual(
      agentPromptCacheSessionId({ ...baseRequest, [field]: `${baseRequest[field]}:changed` }),
      expected,
      `${field} must participate in cache identity`,
    );
  }
});

test('prompt cache identity fails closed when a required logical identity is absent', () => {
  for (const field of ['workflowId', 'runId', 'nodeId', 'agentContractId', 'idempotencyKey']) {
    assert.throws(
      () => agentPromptCacheSessionId({ ...baseRequest, [field]: '' }),
      new RegExp(`requires ${field}`, 'u'),
    );
  }
});
