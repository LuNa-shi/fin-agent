import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('all configured persistence roots, including settings, derive from FIN_DATA_DIR', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-config-roots-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const configUrl = pathToFileURL(path.resolve('src/config.js')).href;
  const source = [
    `const config = await import(${JSON.stringify(configUrl)});`,
    'const names = [',
    "  'DATA_DIR',",
    "  'SETTINGS_FILE',",
    "  'GLOBAL_DIR',",
    "  'IDEA_GENERATION_DIR',",
    "  'IDEAS_DIR',",
    "  'IDEA_RUNS_DIR',",
    "  'PROJECTS_DIR',",
    "  'MEMORY_DIR',",
    "  'CANONICAL_WORLDVIEW_DIR',",
    "  'CLAIM_LIBRARY_DIR',",
    '];',
    'console.log(JSON.stringify(Object.fromEntries(names.map((name) => [name, config[name]]))));',
  ].join('\n');

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        FIN_DATA_DIR: dataDir,
      },
    },
  );

  assert.deepEqual(JSON.parse(output), {
    DATA_DIR: dataDir,
    SETTINGS_FILE: path.join(dataDir, 'settings.json'),
    GLOBAL_DIR: path.join(dataDir, 'global'),
    IDEA_GENERATION_DIR: path.join(dataDir, 'idea-generation'),
    IDEAS_DIR: path.join(dataDir, 'idea-generation', 'ideas'),
    IDEA_RUNS_DIR: path.join(dataDir, 'idea-generation', 'runs'),
    PROJECTS_DIR: path.join(dataDir, 'projects'),
    MEMORY_DIR: path.join(dataDir, 'memory'),
    CANONICAL_WORLDVIEW_DIR: path.join(dataDir, 'canonical-worldview'),
    CLAIM_LIBRARY_DIR: path.join(dataDir, 'claim-library'),
  });
});
