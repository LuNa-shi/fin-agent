#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import {
  ReportAdmissionService,
  ReportLibraryBackfill,
  ReportLibraryStore,
} from '../src/domains/reports/index.js';

function usage(message = null) {
  if (message) console.error(`backfillReportLibrary: ${message}\n`);
  console.error([
    'Usage: node scripts/backfillReportLibrary.mjs --manifest <file> --source-root <dir>',
    '',
    'The manifest must be the frozen report-library-backfill.v1 JSON contract.',
    'This command only reads internal Markdown files under --source-root and uses the',
    'same ReportLibraryBackfill -> ReportAdmissionService seam as producer handoff.',
  ].join('\n'));
  process.exitCode = 2;
}

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--manifest' || value === '--source-root' || value === '--max-attempts') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) return usage(`${value} requires a value`);
      result[value.slice(2).replaceAll('-', '')] = next;
      index += 1;
    } else if (value === '--retry-failed') {
      result.retryFailed = true;
    } else if (value === '--help' || value === '-h') {
      usage();
      return null;
    } else {
      return usage(`unknown option: ${value}`);
    }
  }
  return result;
}

const options = args(process.argv.slice(2));
if (!options) process.exit(0);
if (!options.manifest || !options.sourceroot) {
  usage('--manifest and --source-root are required');
  process.exit(2);
}

const manifestPath = path.resolve(options.manifest);
let manifest;
try {
  if (fs.lstatSync(manifestPath).isSymbolicLink() || !fs.statSync(manifestPath).isFile()) {
    throw new Error('manifest must be a regular file');
  }
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`backfillReportLibrary: unable to read manifest: ${error.message}`);
  process.exit(1);
}

const store = new ReportLibraryStore();
const admissionService = new ReportAdmissionService({ reportLibrary: store });
const backfill = new ReportLibraryBackfill({
  store,
  admissionService,
  sourceRoot: path.resolve(options.sourceroot),
  ...(options.maxattempts ? { maxAttempts: Number(options.maxattempts) } : {}),
});
const result = await backfill.start(manifest, {
  ...(options.retryFailed ? { retryFailed: true } : {}),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status === 'succeeded') process.exitCode = 0;
else process.exitCode = 1;
