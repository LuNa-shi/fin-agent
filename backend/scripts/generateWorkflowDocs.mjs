import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
  renderRunAnalysisWorkflowMarkdown,
} from '../src/workflows/run-analysis/workflowSpec.js';
import {
  IDEA_GENERATION_WORKFLOW_SPEC,
  IDEA_GENERATION_WORKFLOW_SPEC_HASH,
  renderIdeaGenerationWorkflowMarkdown,
} from '../src/workflows/idea-generation/workflowSpec.js';
import {
  CANONICAL_WORLDVIEW_WORKFLOW_SPEC,
  CANONICAL_WORLDVIEW_WORKFLOW_SPEC_HASH,
  renderCanonicalWorldviewWorkflowMarkdown,
} from '../src/workflows/worldview/canonicalWorkflowSpec.js';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const documents = [
  {
    label: 'Workflow',
    outputPath: path.resolve(backendDir, '../documents/generated/run-analysis-workflow.md'),
    expected: renderRunAnalysisWorkflowMarkdown(RUN_ANALYSIS_WORKFLOW_SPEC),
    hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
  },
  {
    label: 'Canonical Worldview Processing workflow',
    outputPath: path.resolve(backendDir, '../documents/generated/worldview-canonical-processing-workflow.md'),
    expected: renderCanonicalWorldviewWorkflowMarkdown(CANONICAL_WORLDVIEW_WORKFLOW_SPEC),
    hash: CANONICAL_WORLDVIEW_WORKFLOW_SPEC_HASH,
  },
  {
    label: 'Idea Generation workflow',
    outputPath: path.resolve(backendDir, '../documents/generated/idea-generation-workflow.md'),
    expected: renderIdeaGenerationWorkflowMarkdown(IDEA_GENERATION_WORKFLOW_SPEC),
    hash: IDEA_GENERATION_WORKFLOW_SPEC_HASH,
  },
];

if (process.argv.includes('--check')) {
  for (const document of documents) {
    const actual = fs.existsSync(document.outputPath)
      ? fs.readFileSync(document.outputPath, 'utf8')
      : '';
    if (actual !== document.expected) {
      console.error(`${document.label} documentation drift: ${document.outputPath}`);
      process.exitCode = 1;
    } else {
      console.log(`${document.label} documentation is current (${document.hash})`);
    }
  }
} else {
  for (const document of documents) {
    fs.mkdirSync(path.dirname(document.outputPath), { recursive: true });
    fs.writeFileSync(document.outputPath, document.expected);
    console.log(`Generated ${document.outputPath} (${document.hash})`);
  }
}
