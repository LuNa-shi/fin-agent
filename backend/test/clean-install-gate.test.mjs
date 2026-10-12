import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLEAN_INSTALL_STEPS,
  REQUIRED_NODE_VERSION,
  assertNodeFloor,
  runCleanInstallGate,
} from '../../scripts/clean-install-gate.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function mockSpawn({ failAt = -1, failCode = 1 } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    setTimeout(() => child.emit('close', calls.length - 1 === failAt ? failCode : 0, null), 0);
    return child;
  };
  return { calls, spawnImpl };
}

test('canonical clean-install gate runs the required commands in order with fixed cwd and argv', async () => {
  const { calls, spawnImpl } = mockSpawn();
  const status = await runCleanInstallGate({
    rootDir: repoRoot,
    nodeVersion: REQUIRED_NODE_VERSION,
    spawnImpl,
    stdio: 'ignore',
    log() {},
    errorLog() {},
  });

  assert.equal(status, 0);
  assert.deepEqual(CLEAN_INSTALL_STEPS.map((step) => [step.cwd, step.command, [...step.args]]), [
    ['backend', 'npm', ['ci']],
    ['backend', 'npm', ['test']],
    ['backend', 'node', ['scripts/generateAgentAssetGolden.mjs', '--check']],
    ['backend', 'npm', ['run', 'lint', '--', '--max-warnings=0']],
    ['backend', 'npm', ['run', 'smoke:demo']],
    ['frontend', 'npm', ['ci']],
    ['frontend', 'npm', ['test']],
    ['frontend', 'npm', ['run', 'build']],
  ]);
  assert.deepEqual(calls.map((call) => [path.relative(repoRoot, call.options.cwd), call.command, call.args]), [
    ['backend', 'npm', ['ci']],
    ['backend', 'npm', ['test']],
    ['backend', 'node', ['scripts/generateAgentAssetGolden.mjs', '--check']],
    ['backend', 'npm', ['run', 'lint', '--', '--max-warnings=0']],
    ['backend', 'npm', ['run', 'smoke:demo']],
    ['frontend', 'npm', ['ci']],
    ['frontend', 'npm', ['test']],
    ['frontend', 'npm', ['run', 'build']],
  ]);
  assert.ok(calls.every((call) => call.options.shell === false));
});

test('canonical clean-install gate rejects Node below 22.19.0 before spawning', async () => {
  assert.throws(() => assertNodeFloor('22.18.9'), /requires Node >=22\.19\.0/u);
  assert.throws(() => assertNodeFloor('22.19'), /valid Node semantic version/u);
  assert.throws(() => assertNodeFloor('22.19.beta'), /valid Node semantic version/u);
  assert.throws(() => assertNodeFloor('not-a-version'), /valid Node semantic version/u);
  assert.doesNotThrow(() => assertNodeFloor('22.19.0'));
  assert.doesNotThrow(() => assertNodeFloor('v22.19.0'));
  assert.doesNotThrow(() => assertNodeFloor('23.0.0'));

  const { calls, spawnImpl } = mockSpawn();
  const status = await runCleanInstallGate({
    rootDir: repoRoot,
    nodeVersion: '22.18.9',
    spawnImpl,
    stdio: 'ignore',
    log() {},
    errorLog() {},
  });
  assert.equal(status, 1);
  assert.equal(calls.length, 0);
});

test('canonical clean-install gate stops on first failure and propagates exit status', async () => {
  const { calls, spawnImpl } = mockSpawn({ failAt: 2, failCode: 17 });
  const status = await runCleanInstallGate({
    rootDir: repoRoot,
    nodeVersion: REQUIRED_NODE_VERSION,
    spawnImpl,
    stdio: 'ignore',
    log() {},
    errorLog() {},
  });

  assert.equal(status, 17);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].args, ['scripts/generateAgentAssetGolden.mjs', '--check']);

  const thrownStatus = await runCleanInstallGate({
    rootDir: repoRoot,
    nodeVersion: REQUIRED_NODE_VERSION,
    spawnImpl() { throw new Error('spawn failed synchronously'); },
    stdio: 'ignore',
    log() {},
    errorLog() {},
  });
  assert.equal(thrownStatus, 1);
});

test('GitHub Actions verification delegates to the canonical clean-install gate only', async () => {
  const workflowDir = path.join(repoRoot, '.github/workflows');
  const workflows = (await readdir(workflowDir)).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'));
  assert.deepEqual(workflows, ['clean-install.yml']);

  const source = await readFile(path.join(workflowDir, 'clean-install.yml'), 'utf8');
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/u);
  assert.match(source, /node-version:\s*['"]22\.19\.0['"]/u);
  assert.doesNotMatch(source, /^\s+branches:/mu, 'clean-install CI must run on pushes to every branch');
  const runLines = source.split('\n')
    .map((line) => line.trim().replace(/^-\s*/u, ''))
    .filter((line) => line.startsWith('run:'));
  assert.deepEqual(runLines, ['run: node scripts/clean-install-gate.mjs']);
});

test('clean-install gate remains lockfile-backed and cannot update Agent Golden fixtures', async () => {
  const [backendLock, frontendLock] = await Promise.all([
    readFile(path.join(repoRoot, 'backend/package-lock.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repoRoot, 'frontend/package-lock.json'), 'utf8').then(JSON.parse),
  ]);
  assert.equal(backendLock.lockfileVersion, 3);
  assert.equal(frontendLock.lockfileVersion, 3);
  assert.equal(backendLock.packages[''].engines.node, '>=22.19.0');
  assert.equal(frontendLock.packages[''].engines.node, '>=22.19.0');

  const goldenStep = CLEAN_INSTALL_STEPS.find((step) => step.command === 'node' && step.args[0] === 'scripts/generateAgentAssetGolden.mjs');
  assert.deepEqual(goldenStep.args, ['scripts/generateAgentAssetGolden.mjs', '--check']);
  assert.equal(CLEAN_INSTALL_STEPS.some((step) => step.args.includes('--write')), false);
  assert.ok(CLEAN_INSTALL_STEPS.some((step) => step.args.includes('--max-warnings=0')));

  const [gateSource, hookSource] = await Promise.all([
    readFile(path.join(repoRoot, 'scripts/clean-install-gate.mjs'), 'utf8'),
    readFile(path.join(repoRoot, '.githooks/pre-push'), 'utf8'),
  ]);
  assert.match(gateSource, /pathToFileURL/u, 'direct invocation must use URL-safe path comparison');
  assert.match(hookSource, /node scripts\/clean-install-gate\.mjs/u);
  assert.doesNotMatch(hookSource, /npm test|smoke:demo/u, 'pre-push must not own a second verification sequence');
});
