import fs from 'node:fs';
import path from 'node:path';

import { MEMORY_DIR } from '../../config.js';

const TOOL_LEDGER = path.join(MEMORY_DIR, 'tool-ledger.jsonl');

export function recordToolFailure(rec) {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.appendFileSync(TOOL_LEDGER, `${JSON.stringify({ ts: Date.now(), ...rec })}\n`);
  } catch {}
}

export function toolFailureStats({ sinceMs = 0 } = {}) {
  let lines = [];
  try {
    lines = fs.readFileSync(TOOL_LEDGER, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { total: 0, byTool: {} };
  }
  const byTool = {};
  let total = 0;
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.ts >= sinceMs) {
        total++;
        byTool[record.tool] = (byTool[record.tool] || 0) + 1;
      }
    } catch {}
  }
  return { total, byTool };
}
