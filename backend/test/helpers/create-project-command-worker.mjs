import process from 'node:process';

process.env.FIN_DATA_DIR = process.argv[2];

const [
  { globalContentIndex },
  { createProjectFromIdea },
  { ProjectSpace },
] = await Promise.all([
  import('../../src/core/persistence/GlobalContentIndex.js'),
  import('../../src/domains/ideas/createProjectFromIdea.js'),
  import('../../src/project-space/ProjectSpace.js'),
]);

const project = createProjectFromIdea({
  title: process.argv[3],
  theme: 'concurrency',
  rationale: 'same deterministic command',
  tickers: [],
  industryTemplate: 'industry_generic',
  companyTemplate: 'company_generic',
}, {
  projectStore: ProjectSpace,
  ideaStore: {},
  index: globalContentIndex,
  templateSystem: {
    get(id) { return id ? { id } : null; },
    matchIndustryTemplate() { return { template: { id: 'industry_generic' } }; },
    matchCompanyTemplate() { return { template: { id: 'company_generic' } }; },
  },
  defaults: { ANALYSIS_LANGUAGE: 'en', REPORT_LANGUAGE: 'en' },
});

process.stdout.write(JSON.stringify({
  id: project.id,
  projectCreationKey: project.projectCreationKey,
}));
