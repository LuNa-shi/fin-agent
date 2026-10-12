#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BACKEND_ROOT = path.join(REPO_ROOT, 'backend');
const BACKEND_ENV_FILE = path.join(BACKEND_ROOT, '.env');
const USER_SYSTEMD_DIR = path.join(os.homedir(), '.config/systemd/user');

function usage() {
  return [
    'Usage: node scripts/install-daily-report-services.mjs [options]',
    '',
    'Options:',
    '  --calendar <spec>      systemd OnCalendar value (default: *-*-* 06:30:00)',
    '  --ideas <n>            Daily report idea/project count (default: 100)',
    '  --batch-size <n>       Daily report analysis concurrency (default: 20)',
    '  --intensity <value>    quick | standard | deep (default: quick)',
    '  --mode <demo|live>     Scheduled daily mode (default: live)',
    '  --no-start             Write units without enabling/starting them',
    '  --help                 Print this help',
  ].join('\n');
}

function readValue(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function positiveInteger(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function parseArgs(argv = process.argv.slice(2)) {
  const config = {
    calendar: process.env.DAILY_REPORT_ON_CALENDAR || '*-*-* 06:30:00',
    ideas: positiveInteger(process.env.DAILY_REPORT_IDEAS || 100, 'DAILY_REPORT_IDEAS'),
    batchSize: positiveInteger(process.env.DAILY_REPORT_BATCH_SIZE || 20, 'DAILY_REPORT_BATCH_SIZE'),
    intensity: process.env.DAILY_REPORT_INTENSITY || 'quick',
    mode: process.env.DAILY_REPORT_MODE || 'live',
    start: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--calendar':
        config.calendar = readValue(argv, i, arg);
        i += 1;
        break;
      case '--ideas':
        config.ideas = positiveInteger(readValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--batch-size':
        config.batchSize = positiveInteger(readValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--intensity':
        config.intensity = readValue(argv, i, arg);
        i += 1;
        break;
      case '--mode':
        config.mode = readValue(argv, i, arg);
        i += 1;
        break;
      case '--no-start':
        config.start = false;
        break;
      case '--help':
      case '-h':
        config.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  config.intensity = String(config.intensity).trim().toLowerCase();
  config.mode = String(config.mode).trim().toLowerCase();
  if (!['quick', 'standard', 'deep'].includes(config.intensity)) {
    throw new Error('--intensity must be quick, standard, or deep');
  }
  if (!['demo', 'live'].includes(config.mode)) {
    throw new Error('--mode must be demo or live');
  }
  return config;
}

function unitPath(name) {
  return path.join(USER_SYSTEMD_DIR, name);
}

function writeUnit(name, content) {
  fs.mkdirSync(USER_SYSTEMD_DIR, { recursive: true, mode: 0o700 });
  const file = unitPath(name);
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  return file;
}

function runSystemctl(args) {
  execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
}

function serviceUnits(config) {
  const nodeBin = process.execPath;
  const webService = `[Unit]
Description=FinAgent backend and frontend
After=network-online.target cliproxyapi.service
Wants=network-online.target cliproxyapi.service

[Service]
Type=simple
WorkingDirectory=${BACKEND_ROOT}
EnvironmentFile=${BACKEND_ENV_FILE}
Environment=NODE_ENV=production
Environment=AUTO_RESUME=true
ExecStart=${nodeBin} src/server.js
Restart=always
RestartSec=10
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;

  const dailyService = `[Unit]
Description=FinAgent daily report generation
After=network-online.target cliproxyapi.service
Wants=network-online.target cliproxyapi.service

[Service]
Type=oneshot
WorkingDirectory=${BACKEND_ROOT}
EnvironmentFile=${BACKEND_ENV_FILE}
Environment=NODE_ENV=production
Environment=AUTO_RESUME=false
Environment=DAILY_REPORT_ENABLE_LIVE=true
Environment=DAILY_REPORT_MODE=${config.mode}
Environment=DAILY_REPORT_IDEAS=${config.ideas}
Environment=DAILY_REPORT_BATCH_SIZE=${config.batchSize}
Environment=DAILY_REPORT_INTENSITY=${config.intensity}
Environment=DAILY_REPORT_POLL_MS=60000
Environment=DAILY_REPORT_TIMEOUT_MS=43200000
ExecStart=${nodeBin} scripts/runScheduledDailyReportGate.mjs
TimeoutStartSec=14h

[Install]
WantedBy=default.target
`;

  const dailyTimer = `[Unit]
Description=Run FinAgent daily report generation

[Timer]
OnCalendar=${config.calendar}
Persistent=true
Unit=finagent-daily-report.service

[Install]
WantedBy=timers.target
`;

  return {
    'finagent.service': webService,
    'finagent-daily-report.service': dailyService,
    'finagent-daily-report.timer': dailyTimer,
  };
}

function main() {
  const config = parseArgs();
  if (config.help) {
    console.log(usage());
    return;
  }
  if (!fs.existsSync(BACKEND_ENV_FILE)) {
    throw new Error(`missing backend environment file: ${BACKEND_ENV_FILE}`);
  }
  const written = Object.entries(serviceUnits(config)).map(([name, content]) => ({
    name,
    path: writeUnit(name, content),
  }));
  if (config.start) {
    runSystemctl(['daemon-reload']);
    runSystemctl(['enable', '--now', 'finagent.service']);
    runSystemctl(['enable', '--now', 'finagent-daily-report.timer']);
  }
  console.log(JSON.stringify({
    ok: true,
    mode: config.mode,
    calendar: config.calendar,
    ideas: config.ideas,
    batchSize: config.batchSize,
    intensity: config.intensity,
    started: config.start,
    units: written,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`[install-daily-report-services] ${error.message || error}`);
  process.exitCode = 1;
}
