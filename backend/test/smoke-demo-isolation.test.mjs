import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const smokeFile = fileURLToPath(new URL('../scripts/smokeDemoE2E.mjs', import.meta.url));

test('demo smoke isolates FIN_DATA_DIR before config load and cleans it after boot failure', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'demo-smoke-isolation-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const probeFile = path.join(temp, 'config-load-probe.cjs');
  const markerFile = path.join(temp, 'config-load.json');
  const inheritedDataDir = path.join(temp, 'must-not-be-used');
  const inheritedSentinel = path.join(inheritedDataDir, 'sentinel.txt');
  await mkdir(inheritedDataDir);
  await writeFile(inheritedSentinel, 'preserve\n');
  await writeFile(probeFile, [
    "const { writeFileSync } = require('node:fs');",
    "const { registerHooks } = require('node:module');",
    "const { fileURLToPath } = require('node:url');",
    'registerHooks({',
    '  load(url, context, nextLoad) {',
    "    if (url.startsWith('file:') && fileURLToPath(url).endsWith(process.env.SMOKE_CONFIG_FILE_SUFFIX)) {",
    "      const dataDir = process.env.FIN_DATA_DIR || '';",
    '      writeFileSync(process.env.SMOKE_CONFIG_LOAD_MARKER, JSON.stringify({ dataDir }));',
    "      throw new Error(dataDir ? 'SMOKE_CONFIG_LOAD_PROBE' : 'SMOKE_CONFIG_LOADED_WITHOUT_FIN_DATA_DIR');",
    '    }',
    '    return nextLoad(url, context);',
    '  },',
    '});',
  ].join('\n'));

  await assert.rejects(execFileAsync(process.execPath, [
    '--require', probeFile,
    smokeFile,
  ], {
    env: {
      ...process.env,
      FIN_DATA_DIR: inheritedDataDir,
      SMOKE_CONFIG_FILE_SUFFIX: path.join('backend', 'src', 'config.js'),
      SMOKE_CONFIG_LOAD_MARKER: markerFile,
    },
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /SMOKE_CONFIG_LOAD_PROBE/u);
    return true;
  });

  const marker = JSON.parse(await readFile(markerFile, 'utf8'));
  assert.notEqual(marker.dataDir, inheritedDataDir);
  assert.equal(path.dirname(marker.dataDir), os.tmpdir());
  assert.match(path.basename(marker.dataDir), /^finagent-demo-smoke-/u);
  await assert.rejects(access(marker.dataDir), /ENOENT/u);
  assert.equal(await readFile(inheritedSentinel, 'utf8'), 'preserve\n');
});
