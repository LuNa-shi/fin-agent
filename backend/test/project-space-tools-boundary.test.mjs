import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  appendCurrentProjectFile,
  editCurrentProjectFile,
  listProjectFiles,
  readProjectFile,
  readProjectFilePaged,
  searchProjectLibrary,
  writeCurrentProjectFile,
} from '../src/project-space/projectTools.js';

test('Project Space exposes the complete existing workspace tool implementation', () => {
  for (const fn of [
    searchProjectLibrary,
    readProjectFile,
    writeCurrentProjectFile,
    appendCurrentProjectFile,
    listProjectFiles,
    readProjectFilePaged,
    editCurrentProjectFile,
  ]) assert.equal(typeof fn, 'function');
});

test('Tool Catalog imports project tools from Project Space, not agents', async () => {
  const [catalog, tools] = await Promise.all([
    readFile(new URL('../src/tools/toolCatalog.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/project-space/projectTools.js', import.meta.url), 'utf8'),
  ]);

  assert.match(catalog, /from ['"]\.\.\/project-space\/projectTools\.js['"]/u);
  assert.doesNotMatch(catalog, /agents\/projectWorkspace\.js/u);
  assert.doesNotMatch(tools, /defineAgent|runDefinedAgent|systemPrompt\s*:|toolAllowlist\s*:/u);
  await assert.rejects(access(new URL('../src/agents/projectWorkspace.js', import.meta.url)));
});
