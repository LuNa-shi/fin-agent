import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.FIN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-authority-issue41-api-'));
process.env.CLAIM_LIBRARY_DIR = path.join(process.env.FIN_DATA_DIR, 'claim-library');
process.env.CANONICAL_WORLDVIEW_DIR = path.join(process.env.FIN_DATA_DIR, 'canonical-worldview');
process.env.AUTO_RESUME = 'false';
process.env.DEMO_MODE = 'true';

const { app } = await import('../src/server.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('Claim API preserves safe 4xx errors and hides storage paths from 5xx responses', async () => {
  const server = http.createServer(app);
  await listen(server);
  const publicationsRoot = path.join(process.env.CLAIM_LIBRARY_DIR, 'publications');
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  try {
    const port = server.address().port;
    const invalid = await fetch(`http://127.0.0.1:${port}/api/claims?limit=0`);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), {
      error: 'limit must be an integer between 1 and 10000',
      code: 'CLAIM_INVALID_LIMIT',
    });

    fs.chmodSync(publicationsRoot, 0o000);
    const failed = await fetch(`http://127.0.0.1:${port}/api/claims`);
    assert.equal(failed.status, 500);
    const publicBody = await failed.text();
    assert.deepEqual(JSON.parse(publicBody), {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
    assert.doesNotMatch(publicBody, /scandir|EACCES|permission denied|claim-library|publications/iu);
    assert.equal(publicBody.includes(process.env.CLAIM_LIBRARY_DIR), false);
    assert.match(logs.join('\n'), /EACCES.*scandir/iu);
    assert.equal(logs.join('\n').includes(process.env.CLAIM_LIBRARY_DIR), true);
  } finally {
    console.error = originalConsoleError;
    fs.chmodSync(publicationsRoot, 0o700);
    await close(server);
  }
});
