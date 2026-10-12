import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createDefaultAgentBackend,
} from '../src/agents/defaultAgentBackend.js';
import { listAgentDefinitions } from '../src/agents/registry.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(testDir, '../src');
const activeRoots = ['agents', 'domains', 'workflows'];
async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.js') ? [absolute] : [];
  }));
  return nested.flat();
}

const oldLoopCall = /(^|[^\w.])(runAgent|chatJSON|chatTools|chat)\s*\(/mu;
const oldLoopImport = /import\s*\{[^}]*\b(runAgent|chatJSON|chatTools|chat)\b[^}]*\}\s*from\s*['"][^'"]*(?:agents\/runtime|core\/models\/legacy\/client)\.js['"]/mu;

test('active product and workflow modules have no direct handwritten-loop or model-client call site', async () => {
  const files = [
    path.join(srcDir, 'server.js'),
    ...(await Promise.all(activeRoots.map((root) => sourceFiles(path.join(srcDir, root))))).flat(),
  ];

  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (oldLoopImport.test(source) || oldLoopCall.test(source)) {
      violations.push(path.relative(srcDir, file));
    }
  }
  assert.deepEqual(violations, []);
});

test('the default backend routes every active Agent through Pi', async () => {
  const calls = [];
  const piBackend = { async run(request) { calls.push(`pi:${request.agentContractId}`); return {}; } };
  const backend = createDefaultAgentBackend({ piBackend, concurrent: false });
  for (const definition of listAgentDefinitions()) {
    await backend.run({ agentContractId: definition.id });
  }
  assert.deepEqual(calls, listAgentDefinitions().map((definition) => `pi:${definition.id}`));
});

test('production backend composition has no Legacy, Hybrid, or automatic fallback dependency', async () => {
  const source = await readFile(path.join(srcDir, 'agents/defaultAgentBackend.js'), 'utf8');
  assert.doesNotMatch(source, /LegacyAgentBackend|HybridAgentBackend|fallbackBackend|RESEARCH_AGENT_BACKEND|pi-week3|pi-analysis/u);
  await assert.rejects(access(path.join(srcDir, 'domains/ideas/runIdeaAgent.js')));
  await assert.rejects(access(path.join(srcDir, 'domains/research/runInvestmentAgent.js')));
});

test('AgentExecutionRuntime is the sole semantic AgentRunRequest constructor', async () => {
  const [runtime, piBackend, idempotentBackend, delegate, researchIndex] = await Promise.all([
    readFile(path.join(srcDir, 'agents/AgentExecutionRuntime.js'), 'utf8'),
    readFile(path.join(srcDir, 'core/agent-backend/PiAgentBackend.js'), 'utf8'),
    readFile(path.join(srcDir, 'core/agent-backend/IdempotentAgentBackend.js'), 'utf8'),
    readFile(path.join(srcDir, 'agents/runDefinedAgent.js'), 'utf8'),
    readFile(path.join(srcDir, 'domains/research/index.js'), 'utf8'),
  ]);

  assert.match(runtime, /createAgentRunRequest\s*\(\s*\{\s*\.\.\.requestIdentity/su);
  assert.match(piBackend, /createAgentRunRequest\s*\(\s*value\s*\)/u);
  assert.match(idempotentBackend, /createAgentRunRequest\s*\(\s*value\s*\)/u);
  assert.doesNotMatch(delegate, /createAgentRunRequest/u);
  assert.doesNotMatch(researchIndex, /createAgentRunRequest/u);
});
