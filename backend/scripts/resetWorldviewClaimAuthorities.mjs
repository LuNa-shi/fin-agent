#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acquireCanonicalWorldviewActiveSequenceGuard,
  canonicalWorldviewActiveSequenceGuardPath,
} from '../src/workflows/worldview/worldviewActiveSequenceGuard.js';

const ACKNOWLEDGEMENT = 'RESET_LEGACY_CLAIM_AND_CANONICAL_WORLDVIEW_AUTHORITIES';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const PROTECTED_FIN_DATA_SIBLINGS = Object.freeze([
  'report-library',
  'projects',
  'idea-generation',
  'global',
  'portfolio',
  'traces',
]);
const ACTIVE_ISSUE_41_CONTRACTS = new Set([
  'claim-publication.v1',
  'processed-report-version-receipt.v1',
  'worldview-agent-run.v1',
  'worldview-run-publication-marker.v1',
  'worldview-run-publication.v1',
  'worldview-run-workspace.v1',
]);
const ACTIVE_AUTHORITY_PATHS = Object.freeze({
  claims: Object.freeze([]),
  claimLibrary: Object.freeze([
    Object.freeze(['publications']),
    Object.freeze(['.publication-staging']),
  ]),
  canonicalWorldview: Object.freeze([
    Object.freeze(['run-publications', 'staged']),
    Object.freeze(['run-publications', 'completed']),
    Object.freeze(['run-workspaces', 'workspaces']),
    Object.freeze(['processing-runs']),
  ]),
});

function fail(message) {
  const error = new Error(message);
  error.code = 'RESET_ARGUMENTS_INVALID';
  throw error;
}

function parseArgs(argv) {
  const options = { dryRun: false };
  const valueOptions = new Map([
    ['--claims-root', 'claimsRoot'],
    ['--canonical-worldview-root', 'canonicalWorldviewRoot'],
    ['--acknowledge-owner-authorized-reset', 'acknowledgement'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      if (options.dryRun) fail('each option may be provided only once');
      options.dryRun = true;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key) fail('unknown option');
    if (options[key] !== undefined) fail('each option may be provided only once');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail('an option value is missing');
    options[key] = value;
    index += 1;
  }
  if (!options.claimsRoot || !options.canonicalWorldviewRoot) {
    fail('--claims-root and --canonical-worldview-root are required');
  }
  if (options.acknowledgement !== ACKNOWLEDGEMENT) {
    fail('the exact owner-authorized reset acknowledgement is required');
  }
  return options;
}

function configuredFinDataDir() {
  if (Object.hasOwn(process.env, 'FIN_DATA_DIR')) return process.env.FIN_DATA_DIR;
  let envText;
  try {
    envText = fs.readFileSync(path.join(BACKEND_ROOT, '.env'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
  for (const line of envText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const name = trimmed.slice(0, separator).trim();
    if (name === 'FIN_DATA_DIR') return trimmed.slice(separator + 1).trim();
  }
  return '';
}

function effectiveFinDataRoot() {
  const configured = configuredFinDataDir();
  return configured ? path.resolve(configured) : path.join(BACKEND_ROOT, 'data');
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function assertNoSymlinkComponents(root) {
  const parsed = path.parse(root);
  let current = parsed.root;
  for (const component of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        fail('authority roots and their existing ancestors must not be symbolic links');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

function validateRoot(root, expectedBasename, finDataRoot) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root) {
    fail('authority roots must be exact absolute paths');
  }
  const expectedRoot = path.join(finDataRoot, expectedBasename);
  if (!samePath(root, expectedRoot)) {
    fail(`authority root must be exactly FIN_DATA_DIR/${expectedBasename}`);
  }
  const filesystemRoot = path.parse(root).root;
  if (samePath(root, filesystemRoot)) fail('the filesystem root is prohibited');
  const backendRuntimeDataRoot = path.join(BACKEND_ROOT, 'data');
  const finDataUsesBackendRuntimeRoot = samePath(finDataRoot, backendRuntimeDataRoot)
    || isWithin(backendRuntimeDataRoot, finDataRoot);
  if (
    samePath(root, REPO_ROOT)
    || isWithin(root, REPO_ROOT)
    || (isWithin(REPO_ROOT, root) && !finDataUsesBackendRuntimeRoot)
  ) {
    fail('tracked/source repository paths and repository ancestors are prohibited');
  }
  if (samePath(root, finDataRoot) || isWithin(root, finDataRoot)) {
    fail('the FIN_DATA_DIR root and its ancestors are prohibited');
  }
  for (const sibling of PROTECTED_FIN_DATA_SIBLINGS) {
    const protectedRoot = path.join(finDataRoot, sibling);
    if (
      samePath(root, protectedRoot)
      || isWithin(protectedRoot, root)
      || isWithin(root, protectedRoot)
    ) {
      fail('protected FIN_DATA_DIR content is prohibited');
    }
  }
  if (path.basename(root) !== expectedBasename) {
    fail(`authority root basename must be exactly ${expectedBasename}`);
  }
  assertNoSymlinkComponents(root);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function containsRecognizedIssue41Contract(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, child] of Object.entries(current)) {
      if ((key === 'contract' || key === 'schemaVersion') && ACTIVE_ISSUE_41_CONTRACTS.has(child)) {
        return true;
      }
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return false;
}

function jsonContainsRecognizedIssue41Contract(file) {
  try {
    return containsRecognizedIssue41Contract(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return false;
  }
}

function activePathContainsContent(root, components) {
  const target = path.join(root, ...components);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink()) fail('authority roots must not contain symbolic links');
  if (stat.isFile()) return true;
  if (!stat.isDirectory()) fail('authority roots must contain only regular files and directories');
  return fs.readdirSync(target).length > 0;
}

function scanRoot(root, authority) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { existed: false, entryCount: 0, identity: null, hasActiveIssue41Content: false };
    }
    throw error;
  }
  if (rootStat.isSymbolicLink()) fail('authority roots must not be symbolic links');
  if (!rootStat.isDirectory()) fail('authority roots must be directories when they exist');

  let entryCount = 0;
  let hasRecognizedContract = false;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) fail('authority roots must not contain symbolic links');
      if (!stat.isDirectory() && !stat.isFile()) {
        fail('authority roots must contain only regular files and directories');
      }
      entryCount += 1;
      if (stat.isDirectory()) pending.push(entryPath);
      else if (entry.name.endsWith('.json') && jsonContainsRecognizedIssue41Contract(entryPath)) {
        hasRecognizedContract = true;
      }
    }
  }
  const hasActivePath = ACTIVE_AUTHORITY_PATHS[authority]
    .some((components) => activePathContainsContent(root, components));
  return {
    existed: true,
    entryCount,
    identity: { dev: rootStat.dev, ino: rootStat.ino },
    hasActiveIssue41Content: hasActivePath || hasRecognizedContract,
  };
}

function assertNoActiveIssue41Content(...scans) {
  if (scans.some((scan) => scan.hasActiveIssue41Content)) {
    fail('active Issue #41 authority content was found; reset is permitted only before cutover');
  }
}

function sameIdentity(stat, identity) {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

function withAnchoredParent(parent, action) {
  const previousCwd = process.cwd();
  try {
    process.chdir(parent);
    if (fs.realpathSync('.') !== parent) {
      fail('authority root parent changed during reset');
    }
    return action();
  } finally {
    process.chdir(previousCwd);
  }
}

function quarantineRoot(root, scan) {
  if (!scan.existed) return null;
  const parent = path.dirname(root);
  const basename = path.basename(root);
  if (fs.realpathSync(parent) !== parent) {
    fail('authority root parent must be an exact non-symlink path');
  }
  return withAnchoredParent(parent, () => {
    const current = fs.lstatSync(basename);
    if (
      current.isSymbolicLink()
      || !current.isDirectory()
      || !sameIdentity(current, scan.identity)
    ) {
      fail('authority root changed during reset');
    }
    const quarantineBasename = `.${basename}.owner-authorized-reset.${process.pid}.${crypto.randomUUID()}`;
    fs.renameSync(basename, quarantineBasename);
    const quarantined = fs.lstatSync(quarantineBasename);
    if (!sameIdentity(quarantined, scan.identity)) {
      fail('authority root changed during reset');
    }
    return { parent, basename, quarantineBasename, identity: scan.identity };
  });
}

function rollbackQuarantine(quarantine) {
  if (!quarantine) return;
  withAnchoredParent(quarantine.parent, () => {
    if (fs.existsSync(quarantine.basename)) return;
    const current = fs.lstatSync(quarantine.quarantineBasename);
    if (!sameIdentity(current, quarantine.identity)) return;
    fs.renameSync(quarantine.quarantineBasename, quarantine.basename);
  });
}

function removeQuarantine(quarantine) {
  if (!quarantine) return;
  withAnchoredParent(quarantine.parent, () => {
    const current = fs.lstatSync(quarantine.quarantineBasename);
    if (!sameIdentity(current, quarantine.identity)) {
      fail('authority root changed during reset');
    }
    fs.rmSync(quarantine.quarantineBasename, { recursive: true, force: true });
  });
}

function removeCreatedFenceScaffolding(root, guardPath, {
  rootExisted,
  locksExisted,
}) {
  const parent = path.dirname(root);
  const basename = path.basename(root);
  withAnchoredParent(parent, () => {
    if (!locksExisted) {
      try { fs.rmdirSync(path.relative(parent, path.dirname(guardPath))); } catch (error) {
        if (error?.code !== 'ENOTEMPTY' && error?.code !== 'ENOENT') throw error;
      }
    }
    if (!rootExisted) {
      try { fs.rmdirSync(basename); } catch (error) {
        if (error?.code !== 'ENOTEMPTY' && error?.code !== 'ENOENT') throw error;
      }
    }
  });
}

function run(argv) {
  const options = parseArgs(argv);
  const finDataRoot = effectiveFinDataRoot();
  assertNoSymlinkComponents(finDataRoot);
  validateRoot(options.claimsRoot, 'claims', finDataRoot);
  validateRoot(options.canonicalWorldviewRoot, 'canonical-worldview', finDataRoot);
  if (
    isWithin(options.claimsRoot, options.canonicalWorldviewRoot)
    || isWithin(options.canonicalWorldviewRoot, options.claimsRoot)
  ) {
    fail('authority roots must not overlap');
  }

  const claimLibraryRoot = path.join(finDataRoot, 'claim-library');
  assertNoSymlinkComponents(claimLibraryRoot);
  const claims = scanRoot(options.claimsRoot, 'claims');
  const canonicalWorldview = scanRoot(options.canonicalWorldviewRoot, 'canonicalWorldview');
  const claimLibrary = scanRoot(claimLibraryRoot, 'claimLibrary');
  if (options.dryRun) {
    assertNoActiveIssue41Content(claims, canonicalWorldview, claimLibrary);
  } else {
    const guardPath = canonicalWorldviewActiveSequenceGuardPath(
      options.canonicalWorldviewRoot,
    );
    const fenceScaffolding = {
      rootExisted: canonicalWorldview.existed,
      locksExisted: fs.existsSync(path.dirname(guardPath)),
    };
    let releaseActiveSequence;
    try {
      releaseActiveSequence = acquireCanonicalWorldviewActiveSequenceGuard({
        worldviewRoot: options.canonicalWorldviewRoot,
        ownerKind: 'owner-authorized-reset',
        ownerId: `reset-${process.pid}`,
      });
    } catch (error) {
      if (error?.code === 'WORLDVIEW_SEQUENCE_BUSY') {
        fail('an active canonical Worldview processing sequence owns the reset fence');
      }
      throw error;
    }
    let resetCompleted = false;
    try {
      assertNoSymlinkComponents(options.claimsRoot);
      assertNoSymlinkComponents(options.canonicalWorldviewRoot);
      const fencedClaims = scanRoot(options.claimsRoot, 'claims');
      const fencedCanonicalWorldview = scanRoot(
        options.canonicalWorldviewRoot,
        'canonicalWorldview',
      );
      const fencedClaimLibrary = scanRoot(claimLibraryRoot, 'claimLibrary');
      assertNoActiveIssue41Content(
        fencedClaims,
        fencedCanonicalWorldview,
        fencedClaimLibrary,
      );
      const quarantines = [];
      try {
        quarantines.push(quarantineRoot(options.claimsRoot, fencedClaims));
        quarantines.push(quarantineRoot(
          options.canonicalWorldviewRoot,
          fencedCanonicalWorldview,
        ));
      } catch (error) {
        for (const quarantine of quarantines.reverse()) rollbackQuarantine(quarantine);
        throw error;
      }
      for (const quarantine of quarantines) removeQuarantine(quarantine);
      resetCompleted = true;
    } finally {
      releaseActiveSequence();
      if (!resetCompleted) {
        removeCreatedFenceScaffolding(
          options.canonicalWorldviewRoot,
          guardPath,
          fenceScaffolding,
        );
      }
    }
  }

  const result = {
    ok: true,
    mode: options.dryRun ? 'dry-run' : 'reset',
    roots: {
      claims: {
        root: options.claimsRoot,
        existed: claims.existed,
        entryCount: claims.entryCount,
      },
      canonicalWorldview: {
        root: options.canonicalWorldviewRoot,
        existed: canonicalWorldview.existed,
        entryCount: canonicalWorldview.entryCount,
      },
    },
    totalEntryCount: claims.entryCount + canonicalWorldview.entryCount,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  run(process.argv.slice(2));
} catch (error) {
  const argumentError = error?.code === 'RESET_ARGUMENTS_INVALID';
  const safeMessage = argumentError ? error.message : 'reset failed';
  process.stderr.write(`resetWorldviewClaimAuthorities: ${safeMessage}\n`);
  process.exitCode = argumentError ? 2 : 1;
}
