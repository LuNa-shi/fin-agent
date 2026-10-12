#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REQUIRED_NODE_VERSION = '22.19.0';

export const CLEAN_INSTALL_STEPS = Object.freeze([
  Object.freeze({ cwd: 'backend', command: 'npm', args: Object.freeze(['ci']) }),
  Object.freeze({ cwd: 'backend', command: 'npm', args: Object.freeze(['test']) }),
  Object.freeze({ cwd: 'backend', command: 'node', args: Object.freeze(['scripts/generateAgentAssetGolden.mjs', '--check']) }),
  Object.freeze({ cwd: 'backend', command: 'npm', args: Object.freeze(['run', 'lint', '--', '--max-warnings=0']) }),
  Object.freeze({ cwd: 'backend', command: 'npm', args: Object.freeze(['run', 'smoke:demo']) }),
  Object.freeze({ cwd: 'frontend', command: 'npm', args: Object.freeze(['ci']) }),
  Object.freeze({ cwd: 'frontend', command: 'npm', args: Object.freeze(['test']) }),
  Object.freeze({ cwd: 'frontend', command: 'npm', args: Object.freeze(['run', 'build']) }),
]);

export function compareNodeVersions(actual, required = REQUIRED_NODE_VERSION) {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(String(value));
    if (!match) throw new TypeError(`Expected a valid Node semantic version, got: ${value}`);
    return match.slice(1).map(Number);
  };
  const a = parse(actual);
  const r = parse(required);
  for (let i = 0; i < 3; i++) {
    const av = Number.isFinite(a[i]) ? a[i] : 0;
    const rv = Number.isFinite(r[i]) ? r[i] : 0;
    if (av !== rv) return av > rv ? 1 : -1;
  }
  return 0;
}

export function assertNodeFloor(nodeVersion = process.versions.node) {
  if (compareNodeVersions(nodeVersion, REQUIRED_NODE_VERSION) < 0) {
    throw new Error(`FinAgent clean-install gate requires Node >=${REQUIRED_NODE_VERSION}; current ${nodeVersion}`);
  }
}

function spawnStep(step, { spawnImpl, rootDir, stdio }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const child = spawnImpl(step.command, [...step.args], {
        cwd: path.join(rootDir, step.cwd),
        stdio,
        shell: false,
      });
      child.once('error', (error) => finish({ status: 1, error }));
      child.once('close', (code, signal) => finish({ status: code ?? 1, signal }));
    } catch (error) {
      finish({ status: 1, error });
    }
  });
}

export async function runCleanInstallGate({
  rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  nodeVersion = process.versions.node,
  spawnImpl = spawn,
  stdio = 'inherit',
  log = console.log,
  errorLog = console.error,
} = {}) {
  try {
    assertNodeFloor(nodeVersion);
  } catch (error) {
    errorLog(error.message);
    return 1;
  }

  for (const step of CLEAN_INSTALL_STEPS) {
    log(`[clean-install] ${step.cwd}$ ${step.command} ${step.args.join(' ')}`);
    const result = await spawnStep(step, { spawnImpl, rootDir, stdio });
    if (result.status !== 0) {
      if (result.error) errorLog(`[clean-install] failed to start: ${result.error.message}`);
      if (result.signal) errorLog(`[clean-install] terminated by signal ${result.signal}`);
      errorLog(`[clean-install] failed at ${step.cwd}$ ${step.command} ${step.args.join(' ')}`);
      return result.status;
    }
  }

  log('[clean-install] OK');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const status = await runCleanInstallGate();
  process.exitCode = status;
}
