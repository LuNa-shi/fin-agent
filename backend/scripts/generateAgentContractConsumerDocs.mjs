import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_CONTRACT_CONSUMER_AUDIT_HASH,
  renderAgentContractConsumerAuditMarkdown,
} from '../src/agents/contractConsumerAudit.js';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.resolve(backendDir, '../documents/generated/agent-contract-consumers.md');
const expected = renderAgentContractConsumerAuditMarkdown();

if (process.argv.includes('--check')) {
  const actual = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (actual !== expected) {
    console.error(`Agent Contract consumer documentation drift: ${outputPath}`);
    process.exitCode = 1;
  } else {
    console.log(`Agent Contract consumer documentation is current (${AGENT_CONTRACT_CONSUMER_AUDIT_HASH})`);
  }
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, expected);
  console.log(`Generated ${outputPath} (${AGENT_CONTRACT_CONSUMER_AUDIT_HASH})`);
}
