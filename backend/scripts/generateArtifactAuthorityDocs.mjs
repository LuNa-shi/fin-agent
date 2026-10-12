import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARTIFACT_AUTHORITY_AUDIT_HASH,
  renderArtifactAuthorityMarkdown,
} from './support/artifactAuthorityDocs.js';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.resolve(backendDir, '../documents/generated/artifact-authority.md');
const expected = renderArtifactAuthorityMarkdown();

if (process.argv.includes('--check')) {
  const actual = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (actual !== expected) {
    console.error(`Artifact Authority documentation drift: ${outputPath}`);
    process.exitCode = 1;
  } else {
    console.log(`Artifact Authority documentation is current (${ARTIFACT_AUTHORITY_AUDIT_HASH})`);
  }
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, expected);
  console.log(`Generated ${outputPath} (${ARTIFACT_AUTHORITY_AUDIT_HASH})`);
}
