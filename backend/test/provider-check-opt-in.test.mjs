import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const backendRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptFile = fileURLToPath(new URL('../scripts/checkOpenAICompatible.mjs', import.meta.url));

test('OpenAI-compatible inference check requires an explicit live mode before provider setup', async () => {
  await assert.rejects(execFileAsync(process.execPath, [scriptFile], {
    cwd: backendRoot,
    env: {
      ...process.env,
      OPENAI_COMPATIBLE_API_KEY: '',
      OPENAI_COMPATIBLE_BASE_URL: '',
      OPENAI_COMPATIBLE_MODEL: '',
    },
  }), (error) => {
    assert.match(error.stderr, /requires the explicit --live mode/u);
    assert.doesNotMatch(error.stderr, /requires OPENAI_COMPATIBLE_API_KEY/u);
    return true;
  });
});

test('package exposes the provider inference check as an explicit live command', async () => {
  const packageJson = JSON.parse(await readFile(path.join(backendRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['check:openai-compatible'], undefined);
  assert.equal(
    packageJson.scripts['check:openai-compatible:live'],
    'node scripts/checkOpenAICompatible.mjs --live',
  );
});
