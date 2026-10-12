import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectSpace as ProjectFS } from '../src/project-space/index.js';

test('ProjectFS: timestamped reports, forecast, source manifest and tool coverage helpers', () => {
  const p = ProjectFS.create({ title: 'Unit Test ProjectFS Artifacts', theme: 'test', rationale: 'test', tickers: ['AAPL'] });
  try {
    const forecast = { version: '1.0', scenarios: [{ name: 'Base', probability: 1 }] };
    ProjectFS.setForecast(p.id, forecast);
    assert.equal(ProjectFS.forecast(p.id).version, '1.0');

    ProjectFS.setSourceManifest(p.id, { rounds: [{ round: 1, sources: [{ id: 's1' }] }] });
    assert.equal(ProjectFS.sourceManifest(p.id).rounds[0].sources[0].id, 's1');

    ProjectFS.setToolCoverage(p.id, { latest: { coverageScore: 0.8 } });
    assert.equal(ProjectFS.toolCoverage(p.id).latest.coverageScore, 0.8);

    ProjectFS.setReport(p.id, '# Working draft');
    const rec = ProjectFS.setTimestampedReport(p.id, '# Final', { language: 'en' });
    assert.ok(rec.path.startsWith('report/report_'));
    assert.equal(ProjectFS.report(p.id), '# Final');
    assert.equal(ProjectFS.draftReport(p.id), '# Working draft');
    assert.ok(ProjectFS.reportVersions(p.id).some((r) => r.path === rec.path));
  } finally {
    ProjectFS.delete(p.id);
  }
});
