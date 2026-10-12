import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseLinuxProcessStat,
  processStartIdentity,
  withFileLockSync,
} from '../src/lib/fileLock.js';

const PROCESS_WORKER = fileURLToPath(new URL('support/file-lock-process-worker.mjs', import.meta.url));

function waitForProcess(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}


async function waitFor(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('file locks reclaim a fresh lock owned by a terminated process', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-dead-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDir = path.join(root, 'manifest.lock');
  const exited = spawnSync(process.execPath, ['--eval', '']);
  assert.equal(exited.status, 0);
  assert.ok(Number.isInteger(exited.pid) && exited.pid > 0);
  fs.mkdirSync(lockDir);
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: exited.pid, acquiredAt: new Date().toISOString() }),
  );

  const result = withFileLockSync(lockDir, () => 'recovered', {
    timeoutMs: 50,
    staleMs: 60_000,
    retryMs: 1,
  });

  assert.equal(result, 'recovered');
  assert.equal(fs.existsSync(lockDir), false);
});

test('file locks do not reclaim an aged lock owned by a live process', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-live-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDir = path.join(root, 'manifest.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({
      pid: process.pid,
      processStartIdentity: processStartIdentity(),
      acquiredAt: new Date().toISOString(),
    }),
  );
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, old, old);

  assert.throws(
    () => withFileLockSync(lockDir, () => 'must-not-run', {
      timeoutMs: 5,
      staleMs: 1,
      retryMs: 1,
    }),
    (error) => error?.code === 'FILE_LOCK_TIMEOUT',
  );
});


test('file locks reclaim an aged orphan after its PID is reused by another process', (t) => {
  if (!processStartIdentity()) {
    t.skip('process start identity is unavailable on this platform');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-reused-pid-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDir = path.join(root, 'manifest.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({
      pid: process.pid,
      processStartIdentity: 'linux:old-boot:old-process-start',
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    }),
  );
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, old, old);

  const result = withFileLockSync(lockDir, () => 'recovered', {
    timeoutMs: 50,
    staleMs: 1,
    retryMs: 1,
  });

  assert.equal(result, 'recovered');
  assert.equal(fs.existsSync(lockDir), false);
});


test('Linux process stat parsing preserves zombie state for owner recovery', () => {
  const fields = ['Z', ...Array(18).fill('0'), '12345'];
  const parsed = parseLinuxProcessStat(`123 (worker process) ${fields.join(' ')}`, 'test-boot');
  assert.equal(parsed.state, 'Z');
  assert.match(parsed.startIdentity, /^linux:[a-f0-9]{64}$/u);
});

test('concurrent stale-lock reclaimers never overlap protected callbacks', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-concurrent-reclaim-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDir = path.join(root, 'manifest.lock');
  const logFile = path.join(root, 'events.jsonl');
  const gateFile = path.join(root, 'start-gate');
  const exited = spawnSync(process.execPath, ['--eval', '']);
  assert.equal(exited.status, 0);
  fs.mkdirSync(lockDir);
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({
      pid: exited.pid,
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    }),
  );

  const workers = Array.from({ length: 12 }, (_, index) => {
    const workerId = `worker-${index + 1}`;
    return spawn(process.execPath, [
      PROCESS_WORKER,
      lockDir,
      logFile,
      workerId,
      '40',
      gateFile,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  });
  await waitFor(
    () => workers.every((_, index) => fs.existsSync(`${gateFile}.worker-${index + 1}.ready`)),
    'file lock workers did not reach the shared start gate',
  );
  fs.writeFileSync(gateFile, 'start\n');
  const exits = await Promise.all(workers.map(waitForProcess));
  assert.deepEqual(exits.map((result) => result.code), Array(workers.length).fill(0), exits.map((result) => result.stderr).join('\n'));
  await waitFor(() => fs.existsSync(logFile), 'file lock workers produced no events');

  const events = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  let active = 0;
  let maxActive = 0;
  for (const event of events) {
    if (event.event === 'enter') {
      active += 1;
      maxActive = Math.max(maxActive, active);
    } else if (event.event === 'exit') {
      active -= 1;
    }
    assert.ok(active >= 0, 'a lock callback exited without entering');
  }
  assert.equal(events.filter((event) => event.event === 'enter').length, workers.length);
  assert.equal(active, 0);
  assert.equal(maxActive, 1);
});


test('file locks recover when a stale reclaimer dies after claiming the owner record', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-stale-reclaimer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDir = path.join(root, 'manifest.lock');
  const exited = spawnSync(process.execPath, ['--eval', '']);
  assert.equal(exited.status, 0);
  fs.mkdirSync(lockDir);
  const claimName = `.owner-claim-${exited.pid}--none--stale-reclaimer.json`;
  fs.writeFileSync(
    path.join(lockDir, claimName),
    JSON.stringify({
      pid: exited.pid,
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    }),
  );

  const result = withFileLockSync(lockDir, () => 'recovered', {
    timeoutMs: 100,
    staleMs: 1,
    retryMs: 1,
  });

  assert.equal(result, 'recovered');
  assert.equal(fs.existsSync(lockDir), false);
});


test('file locks do not replace a fresh empty directory before its stale timeout', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-fresh-empty-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDir = path.join(root, 'manifest.lock');
  fs.mkdirSync(lockDir);

  assert.throws(
    () => withFileLockSync(lockDir, () => 'must-not-run', {
      timeoutMs: 5,
      staleMs: 60_000,
      retryMs: 1,
    }),
    (error) => error?.code === 'FILE_LOCK_TIMEOUT',
  );
  assert.equal(fs.existsSync(lockDir), true);
});

test('file locks publish one regular-file ownership marker before entering', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-published-file-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'manifest.lock');

  const result = withFileLockSync(lockPath, () => {
    const stat = fs.lstatSync(lockPath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    return 'owned';
  });

  assert.equal(result, 'owned');
  assert.equal(fs.existsSync(lockPath), false);
});
