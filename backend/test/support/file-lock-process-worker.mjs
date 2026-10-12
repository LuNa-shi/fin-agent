import fs from 'node:fs';

import { withFileLockSync } from '../../src/lib/fileLock.js';

const [lockDir, logFile, workerId, holdMsInput, gateFile] = process.argv.slice(2);
const holdMs = Number(holdMsInput) || 50;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

if (gateFile) {
  fs.writeFileSync(`${gateFile}.${workerId}.ready`, 'ready\n');
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(gateFile)) {
    if (Date.now() >= deadline) throw new Error('file lock worker gate timed out');
    Atomics.wait(sleeper, 0, 0, 1);
  }
}

try {
  withFileLockSync(lockDir, () => {
    fs.appendFileSync(logFile, `${JSON.stringify({ event: 'enter', workerId })}\n`);
    Atomics.wait(sleeper, 0, 0, holdMs);
    fs.appendFileSync(logFile, `${JSON.stringify({ event: 'exit', workerId })}\n`);
  }, { timeoutMs: 10_000, staleMs: 1, retryMs: 1 });
  process.exitCode = 0;
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
