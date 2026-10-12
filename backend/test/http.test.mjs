import test from 'node:test';
import assert from 'node:assert/strict';

import { pLimit } from '../src/lib/http.js';

test('pLimit drops an aborted queued task before it starts', async () => {
  const limit = pLimit(1);
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  let secondStarted = false;
  const first = limit(() => new Promise((resolve) => {
    releaseFirst = resolve;
    markFirstStarted();
  }));
  const abortController = new AbortController();
  const second = limit(async () => { secondStarted = true; }, { signal: abortController.signal });

  await firstStarted;
  abortController.abort('deadline');
  releaseFirst();
  await first;
  await assert.rejects(second, (error) => error?.name === 'AbortError' && error?.code === 'RUN_ABORTED');
  assert.equal(secondStarted, false);
});
