import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CANONICAL_WORLDVIEW_WORKFLOW_SPEC,
  renderCanonicalWorldviewWorkflowMarkdown,
} from '../src/workflows/worldview/canonicalWorkflowSpec.js';

test('Canonical Worldview workflow wording describes one logical Core execution with bounded complete attempts', async () => {
  const rendered = renderCanonicalWorldviewWorkflowMarkdown(CANONICAL_WORLDVIEW_WORKFLOW_SPEC);
  const checkedIn = await readFile(
    new URL('../../documents/generated/worldview-canonical-processing-workflow.md', import.meta.url),
    'utf8',
  );

  for (const text of [rendered, checkedIn]) {
    assert.match(text, /one logical Core Worldview Agent execution/iu);
    assert.match(text, /up to 3 complete Agent attempts/iu);
    assert.doesNotMatch(text, /exactly one Core Worldview Agent execution/iu);
  }
  assert.equal(checkedIn, rendered);
});
