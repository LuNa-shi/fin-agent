import assert from 'node:assert/strict';
import test from 'node:test';

import { ProjectSpace } from '../src/project-space/ProjectSpace.js';
import { chatModify } from '../src/workflows/run-analysis/reportEditing.js';

test('report feedback rejects an unverified report before chat, report, or Agent mutation', async (t) => {
  const project = ProjectSpace.create({
    title: 'Unverified report feedback fixture',
    tickers: ['AAPL'],
  });
  t.after(() => ProjectSpace.delete(project.id));

  ProjectSpace.setTimestampedReport(
    project.id,
    '# Draft report\n\nThis file is not a verified publication.',
  );
  const beforeChat = ProjectSpace.chat(project.id);
  const beforeReports = ProjectSpace.reportVersions(project.id);
  let agentAttempts = 0;
  const backend = {
    async run() {
      agentAttempts += 1;
      throw new Error('Agent backend must not be reached');
    },
  };

  await assert.rejects(
    chatModify(project.id, 'Please revise the rating.', { backend }),
    (error) => (
      error?.code === 'REPORT_FEEDBACK_NOT_READY'
      && error?.statusCode === 409
    ),
  );

  assert.deepEqual(ProjectSpace.chat(project.id), beforeChat);
  assert.deepEqual(ProjectSpace.reportVersions(project.id), beforeReports);
  assert.equal(agentAttempts, 0);
});
