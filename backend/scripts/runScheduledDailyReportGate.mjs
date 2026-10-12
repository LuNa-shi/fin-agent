#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDailyReportGate } from './runDaily100ReportGate.mjs';

const BACKEND_ROOT = fileURLToPath(new URL('../', import.meta.url));

function envText(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envPositiveInteger(name, fallback) {
  const raw = envText(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function envBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function envEnum(name, allowed, fallback) {
  const value = envText(name, fallback).trim().toLowerCase();
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function scheduledConfigFromEnv() {
  const mode = envEnum('DAILY_REPORT_MODE', ['demo', 'live'], 'live');
  const ideas = envPositiveInteger('DAILY_REPORT_IDEAS', 100);
  const batchSize = envPositiveInteger('DAILY_REPORT_BATCH_SIZE', 20);
  const intensity = envEnum('DAILY_REPORT_INTENSITY', ['quick', 'standard', 'deep'], 'quick');
  if (mode === 'live' && !envBoolean('DAILY_REPORT_ENABLE_LIVE', false)) {
    const error = new Error('scheduled live daily report requires DAILY_REPORT_ENABLE_LIVE=true');
    error.code = 'SCHEDULED_LIVE_REPORT_NOT_ENABLED';
    throw error;
  }
  return {
    ideas,
    batchSize,
    intensity,
    analysisLanguage: envEnum('DAILY_REPORT_ANALYSIS_LANGUAGE', ['en', 'zh', 'auto'], 'en'),
    reportLanguage: envEnum('DAILY_REPORT_REPORT_LANGUAGE', ['en', 'zh', 'auto'], 'en'),
    companyLocale: envText('DAILY_REPORT_COMPANY_LOCALE', 'global'),
    fixedIdeasPath: envText('DAILY_REPORT_FIXED_IDEAS', ''),
    mode,
    outputDir: envText('DAILY_REPORT_OUTPUT_DIR', ''),
    dataDir: envText('DAILY_REPORT_DATA_DIR', ''),
    // Keep temporary Idea/Project production isolated while admitting exact
    // ReportVersions into the resident product's shared Report Library.
    reportLibraryDir: envText(
      'DAILY_REPORT_LIBRARY_DIR',
      envText('REPORT_LIBRARY_DIR', path.join(BACKEND_ROOT, 'data', 'report-library')),
    ),
    canonicalWorldviewDir: envText(
      'DAILY_CANONICAL_WORLDVIEW_DIR',
      envText('CANONICAL_WORLDVIEW_DIR', path.join(BACKEND_ROOT, 'data', 'canonical-worldview')),
    ),
    claimLibraryDir: envText(
      'DAILY_CLAIM_LIBRARY_DIR',
      envText('CLAIM_LIBRARY_DIR', path.join(BACKEND_ROOT, 'data', 'claim-library')),
    ),
    timeoutMs: envPositiveInteger('DAILY_REPORT_TIMEOUT_MS', 12 * 60 * 60 * 1000),
    pollMs: envPositiveInteger('DAILY_REPORT_POLL_MS', 60_000),
    quiet: envBoolean('DAILY_REPORT_QUIET', false),
  };
}

async function main() {
  try {
    const summary = await runDailyReportGate(scheduledConfigFromEnv());
    console.log(JSON.stringify({
      ok: summary.ok,
      mode: summary.mode,
      live: summary.live,
      ideas: summary.verification?.ideas,
      projects: summary.verification?.projects,
      reports: summary.verification?.reports,
      batchSize: summary.configuration?.batchSize,
      evidencePath: summary.evidencePath,
    }, null, 2));
  } catch (error) {
    console.error(`[scheduled-daily-report] ${error?.code || 'ERROR'}: ${error?.message || error}`);
    if (error?.evidencePath) {
      console.error(`[scheduled-daily-report] evidence: ${error.evidencePath}`);
    }
    process.exitCode = 1;
  }
}

await main();
