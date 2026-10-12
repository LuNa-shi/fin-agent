import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureDirectAgentAssets,
  captureResearchAgentAssets,
  captureWorldviewAgentAssets,
} from './agentAssetSnapshot.mjs';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = resolve(backendRoot, 'test/fixtures/agent-assets/v1');
const writeMode = process.argv.includes('--write');

const outputs = [
  ['research-agents.json', await captureResearchAgentAssets()],
  ['direct-agents.json', await captureDirectAgentAssets()],
  ['worldview-agents.json', await captureWorldviewAgentAssets()],
];

let drift = false;
for (const [name, value] of outputs) {
  const filename = resolve(fixtureDir, name);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (writeMode) {
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(filename, serialized, 'utf8');
    process.stdout.write(`wrote ${name}\n`);
    continue;
  }
  let expected = null;
  try {
    expected = await readFile(filename, 'utf8');
  } catch {
    // Missing fixture is drift and should fail without mutating the tree.
  }
  if (expected !== serialized) {
    drift = true;
    process.stderr.write(`agent asset Golden drift: ${name}\n`);
  }
}

if (drift) process.exitCode = 1;
