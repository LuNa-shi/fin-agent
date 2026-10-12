import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const viteConfigUrl = new URL('../vite.config.js', import.meta.url);
const launchConfigUrl = new URL('../../.claude/launch.json', import.meta.url);

test('frontend dev server uses the test port without proxying to deployment', async () => {
  const source = await readFile(viteConfigUrl, 'utf8');
  const launch = JSON.parse(await readFile(launchConfigUrl, 'utf8'));

  assert.equal((source.match(/port:\s*8878/gu) || []).length, 2);
  assert.equal((source.match(/strictPort:\s*true/gu) || []).length, 2);
  assert.doesNotMatch(source, /proxy\s*:/u);
  assert.doesNotMatch(source, /localhost:8787/u);
  assert.equal(launch.configurations[0].port, 8878);
});
