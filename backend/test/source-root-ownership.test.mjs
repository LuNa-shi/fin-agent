import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';

const srcUrl = new URL('../src/', import.meta.url);

async function emptyDirectories(root, relative = '') {
  const entries = await readdir(root, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  const nested = await Promise.all(directories.map(async (entry) => {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childUrl = new URL(`${entry.name}/`, root);
    const children = await readdir(childUrl, { withFileTypes: true });
    const descendants = await emptyDirectories(childUrl, childRelative);
    return children.length ? descendants : [childRelative, ...descendants];
  }));
  return nested.flat();
}

test('backend source root exposes only the seven approved responsibility directories', async () => {
  const entries = await readdir(srcUrl, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();

  assert.deepEqual(directories, [
    'agents',
    'core',
    'domains',
    'lib',
    'project-space',
    'tools',
    'workflows',
  ]);
  assert.deepEqual(files, ['config.js', 'server.js']);
});

test('backend source tree contains no empty compatibility directory', async () => {
  assert.deepEqual(await emptyDirectories(srcUrl), []);
});
