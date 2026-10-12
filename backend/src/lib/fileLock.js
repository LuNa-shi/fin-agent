import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const heldLocks = new Map();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const TEMP_OPEN_FLAGS = (
  fs.constants.O_WRONLY
  | fs.constants.O_CREAT
  | fs.constants.O_EXCL
  | (fs.constants.O_NOFOLLOW || 0)
);

function wait(ms) {
  Atomics.wait(sleeper, 0, 0, ms);
}

let linuxBootId;
let currentProcessDetails;

function processIdentityDigest(value) {
  return `linux:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function currentLinuxBootId() {
  if (linuxBootId !== undefined) return linuxBootId;
  try {
    linuxBootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    linuxBootId = null;
  }
  return linuxBootId;
}

export function parseLinuxProcessStat(stat, bootId = currentLinuxBootId()) {
  const commandEnd = typeof stat === 'string' ? stat.lastIndexOf(')') : -1;
  if (commandEnd < 0) return null;
  const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/u);
  const state = fieldsAfterCommand[0] || null;
  const startTicks = fieldsAfterCommand[19];
  if (!/^\d+$/u.test(startTicks || '')) return null;
  return {
    state,
    startIdentity: processIdentityDigest(bootId ? `${bootId}:${startTicks}` : startTicks),
  };
}

function linuxProcessDetails(pid) {
  if (process.platform !== 'linux') return null;
  try {
    return parseLinuxProcessStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

function processDetails(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid && currentProcessDetails !== undefined) return currentProcessDetails;
  const details = linuxProcessDetails(pid);
  if (pid === process.pid) currentProcessDetails = details;
  return details;
}

export function processStartIdentity(pid = process.pid) {
  return processDetails(pid)?.startIdentity || null;
}

export function processOwnerStatus(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return 'unknown';
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    if (error?.code !== 'EPERM') return 'unknown';
  }
  const details = processDetails(owner.pid);
  if (/^[ZX]/u.test(details?.state || '')) return 'dead';
  const expectedStart = owner.processStartIdentity || null;
  if (expectedStart && details?.startIdentity && expectedStart !== details.startIdentity) return 'dead';
  return 'alive';
}

function readFileSnapshot(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    let value = null;
    try { value = JSON.parse(text); } catch {}
    return { text, value };
  } catch {
    return null;
  }
}

function claimIdentity() {
  return {
    pid: process.pid,
    processStartIdentity: processStartIdentity(),
    nonce: crypto.randomUUID(),
  };
}

function claimIdentityToken(identity = claimIdentity()) {
  const startIdentity = encodeURIComponent(identity.processStartIdentity || 'none');
  return `${identity.pid}--${startIdentity}--${identity.nonce}`;
}

function claimIdentityFromToken(token) {
  const [pid, startIdentity, nonce, ...extra] = String(token || '').split('--');
  if (extra.length || !/^\d+$/u.test(pid) || !nonce) return null;
  try {
    const decodedStart = decodeURIComponent(startIdentity);
    return {
      pid: Number(pid),
      processStartIdentity: decodedStart === 'none' ? null : decodedStart,
      nonce,
    };
  } catch {
    return null;
  }
}

function recordAgeMs(value, file) {
  const timestamp = Date.parse(value?.acquiredAt || '');
  if (Number.isFinite(timestamp)) return Date.now() - timestamp;
  try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return 0; }
}

function recordIsReclaimable(value, file, staleMs) {
  const status = processOwnerStatus(value);
  return status === 'dead' || (status === 'unknown' && recordAgeMs(value, file) > staleMs);
}

function sameRegularFile(left, right) {
  try {
    const leftStat = fs.lstatSync(left);
    const rightStat = fs.lstatSync(right);
    return leftStat.isFile()
      && !leftStat.isSymbolicLink()
      && rightStat.isFile()
      && !rightStat.isSymbolicLink()
      && leftStat.dev === rightStat.dev
      && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function lockAuxiliaryPrefix(lockPath) {
  const lockIdentity = crypto.createHash('sha256').update(path.resolve(lockPath)).digest('hex').slice(0, 24);
  return `.file-lock-${lockIdentity}`;
}

function ownerFilePath(lockPath, lockToken) {
  return path.join(path.dirname(lockPath), `${lockAuxiliaryPrefix(lockPath)}.owner-${lockToken}.json`);
}

function claimFilePrefix(lockPath, lockToken) {
  return `${lockAuxiliaryPrefix(lockPath)}.claim-${lockToken}-`;
}

function claimFilePath(lockPath, lockToken, identity = claimIdentity()) {
  return path.join(
    path.dirname(lockPath),
    `${claimFilePrefix(lockPath, lockToken)}${claimIdentityToken(identity)}.json`,
  );
}

function claimIdentityFromFile(lockPath, lockToken, file) {
  const name = path.basename(file);
  const prefix = claimFilePrefix(lockPath, lockToken);
  if (!name.startsWith(prefix) || !name.endsWith('.json')) return null;
  return claimIdentityFromToken(name.slice(prefix.length, -'.json'.length));
}

function claimFiles(lockPath, lockToken) {
  const parent = path.dirname(lockPath);
  const prefix = claimFilePrefix(lockPath, lockToken);
  try {
    return fs.readdirSync(parent)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort()
      .map((name) => path.join(parent, name));
  } catch {
    return [];
  }
}

function restoreClaimedFile(claimFile, ownerFile) {
  try {
    if (!fs.existsSync(ownerFile)) fs.renameSync(claimFile, ownerFile);
  } catch {}
}

function finishActiveFileClaim(lockPath, ownerFile, claimFile, staleMs, expectedText = null) {
  const claimed = readFileSnapshot(claimFile);
  if (!claimed) return false;
  if (expectedText !== null && claimed.text !== expectedText) {
    restoreClaimedFile(claimFile, ownerFile);
    return false;
  }
  if (!recordIsReclaimable(claimed.value, claimFile, staleMs)
    || !sameRegularFile(lockPath, claimFile)) {
    restoreClaimedFile(claimFile, ownerFile);
    return false;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    restoreClaimedFile(claimFile, ownerFile);
    return false;
  }
  try { fs.unlinkSync(claimFile); } catch {}
  return true;
}

function recoverActiveFileClaim(lockPath, lockToken, ownerFile, staleMs) {
  const claims = claimFiles(lockPath, lockToken);
  if (claims.length !== 1) return false;
  const oldClaim = claims[0];
  const reclaimer = claimIdentityFromFile(lockPath, lockToken, oldClaim);
  if (!recordIsReclaimable(reclaimer, oldClaim, staleMs)) return false;
  const nextClaim = claimFilePath(lockPath, lockToken);
  try { fs.renameSync(oldClaim, nextClaim); } catch { return false; }
  return finishActiveFileClaim(lockPath, ownerFile, nextClaim, staleMs);
}

function tryReclaimActiveFile(lockPath, staleMs) {
  const active = readFileSnapshot(lockPath);
  const lockToken = active?.value?.lockToken;
  if (!active || typeof lockToken !== 'string' || !lockToken) return false;
  const ownerFile = ownerFilePath(lockPath, lockToken);
  const owner = readFileSnapshot(ownerFile);
  if (!owner) return recoverActiveFileClaim(lockPath, lockToken, ownerFile, staleMs);
  if (owner.text !== active.text || !sameRegularFile(lockPath, ownerFile)
    || !recordIsReclaimable(owner.value, ownerFile, staleMs)) return false;
  const claimFile = claimFilePath(lockPath, lockToken);
  try { fs.renameSync(ownerFile, claimFile); } catch { return false; }
  return finishActiveFileClaim(lockPath, ownerFile, claimFile, staleMs, active.text);
}

function legacyOwnerFileName(lockToken) {
  return lockToken ? `owner-${lockToken}.json` : 'owner.json';
}

const LEGACY_CLAIM_PREFIX = '.owner-claim-';

function legacyLockState(lockDir) {
  try {
    const entries = fs.readdirSync(lockDir).sort();
    return {
      entries,
      owners: entries.filter((name) => name === 'owner.json' || /^owner-[A-Za-z0-9-]+\.json$/u.test(name)),
      claims: entries.filter((name) => name.startsWith(LEGACY_CLAIM_PREFIX) && name.endsWith('.json')),
    };
  } catch {
    return null;
  }
}

function legacyClaimFileName(identity = claimIdentity()) {
  return `${LEGACY_CLAIM_PREFIX}${claimIdentityToken(identity)}.json`;
}

function legacyClaimIdentity(name) {
  if (!name.startsWith(LEGACY_CLAIM_PREFIX) || !name.endsWith('.json')) return null;
  return claimIdentityFromToken(name.slice(LEGACY_CLAIM_PREFIX.length, -'.json'.length));
}

function restoreLegacyOwner(claimFile, lockDir, owner) {
  restoreClaimedFile(claimFile, path.join(lockDir, legacyOwnerFileName(owner?.lockToken || null)));
}

function claimLegacyOwner(lockDir, ownerName, staleMs) {
  const ownerFile = path.join(lockDir, ownerName);
  const observed = readFileSnapshot(ownerFile);
  if (!observed || !recordIsReclaimable(observed.value, ownerFile, staleMs)) return false;
  const claimFile = path.join(lockDir, legacyClaimFileName());
  try { fs.renameSync(ownerFile, claimFile); } catch { return false; }
  const claimed = readFileSnapshot(claimFile);
  if (!claimed || claimed.text !== observed.text
    || !recordIsReclaimable(claimed.value, claimFile, staleMs)) {
    restoreLegacyOwner(claimFile, lockDir, claimed?.value || observed.value);
    return false;
  }
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
  return true;
}

function recoverLegacyClaim(lockDir, claimName, staleMs) {
  const oldClaim = path.join(lockDir, claimName);
  if (!recordIsReclaimable(legacyClaimIdentity(claimName), oldClaim, staleMs)) return false;
  const nextClaim = path.join(lockDir, legacyClaimFileName());
  try { fs.renameSync(oldClaim, nextClaim); } catch { return false; }
  const owner = readFileSnapshot(nextClaim);
  if (!owner || !recordIsReclaimable(owner.value, nextClaim, staleMs)) {
    restoreLegacyOwner(nextClaim, lockDir, owner?.value);
    return false;
  }
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
  return true;
}

function tryReclaimLegacyDirectory(lockDir, staleMs) {
  const state = legacyLockState(lockDir);
  if (!state) return false;
  if (state.owners.length === 1 && state.claims.length === 0) {
    return claimLegacyOwner(lockDir, state.owners[0], staleMs);
  }
  if (state.owners.length === 0 && state.claims.length === 1) {
    return recoverLegacyClaim(lockDir, state.claims[0], staleMs);
  }
  // An empty pre-token directory has no owner identity. Reclaiming it could
  // supersede a live process paused between mkdir and owner publication.
  return false;
}

function tryReclaimLock(lockPath, staleMs) {
  let stat;
  try { stat = fs.lstatSync(lockPath); } catch { return false; }
  if (stat.isSymbolicLink()) return false;
  if (stat.isFile()) return tryReclaimActiveFile(lockPath, staleMs);
  if (stat.isDirectory()) return tryReclaimLegacyDirectory(lockPath, staleMs);
  return false;
}

function releaseOwnedFileLock(lockPath, ownerFile, lockToken) {
  const owner = readFileSnapshot(ownerFile);
  if (owner?.value?.lockToken !== lockToken || !sameRegularFile(lockPath, ownerFile)) return;
  const claimFile = claimFilePath(lockPath, lockToken);
  try { fs.renameSync(ownerFile, claimFile); } catch { return; }
  if (!sameRegularFile(lockPath, claimFile)) {
    restoreClaimedFile(claimFile, ownerFile);
    return;
  }
  try { fs.unlinkSync(lockPath); } catch { return; }
  try { fs.unlinkSync(claimFile); } catch {}
}

export function acquireFileLockSync(lockPath, {
  timeoutMs = 10_000,
  staleMs = 30_000,
  retryMs = 10,
} = {}) {
  if (typeof lockPath !== 'string' || !lockPath) throw new TypeError('lockDir is required');
  const absolute = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let lockToken;
  let ownerFile;
  while (true) {
    lockToken = crypto.randomUUID();
    ownerFile = ownerFilePath(absolute, lockToken);
    const ownerRecord = JSON.stringify({
      pid: process.pid,
      processStartIdentity: processStartIdentity(),
      lockToken,
      acquiredAt: new Date().toISOString(),
    });
    fs.writeFileSync(ownerFile, ownerRecord, { flag: 'wx' });
    try {
      // Hard-link creation is the atomic no-replace acquisition boundary. The
      // stable lock path and tokenized owner path refer to the same inode.
      fs.linkSync(ownerFile, absolute);
      break;
    } catch (error) {
      try { fs.unlinkSync(ownerFile); } catch {}
      if (error?.code !== 'EEXIST') throw error;
      if (tryReclaimLock(absolute, staleMs)) continue;
      if (Date.now() >= deadline) {
        const timeout = new Error(`file lock timeout: ${absolute}`);
        timeout.code = 'FILE_LOCK_TIMEOUT';
        throw timeout;
      }
      wait(retryMs);
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseOwnedFileLock(absolute, ownerFile, lockToken);
  };
}

export function withFileLockSync(lockPath, fn, options = {}) {
  if (typeof lockPath !== 'string' || !lockPath) throw new TypeError('lockDir is required');
  if (typeof fn !== 'function') throw new TypeError('file lock callback is required');
  const absolute = path.resolve(lockPath);
  const held = heldLocks.get(absolute);
  if (held) {
    held.count += 1;
    try { return fn(); } finally { held.count -= 1; }
  }

  const release = acquireFileLockSync(absolute, options);
  heldLocks.set(absolute, { count: 1 });
  try {
    return fn();
  } finally {
    heldLocks.delete(absolute);
    release();
  }
}

function writeExclusiveTempFileSync(file, content) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, TEMP_OPEN_FLAGS, 0o666);
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ELOOP') continue;
      throw error;
    }
    let descriptorStat;
    try {
      fs.writeFileSync(fd, content);
      descriptorStat = fs.fstatSync(fd);
      fs.closeSync(fd);
      fd = null;
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
    let pathStat;
    try {
      pathStat = fs.lstatSync(temp);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
    if (
      pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || pathStat.dev !== descriptorStat.dev
      || pathStat.ino !== descriptorStat.ino
    ) {
      try { fs.unlinkSync(temp); } catch {}
      const error = new Error(`exclusive atomic temp file was replaced for ${file}`);
      error.code = 'ATOMIC_TEMP_REPLACED';
      throw error;
    }
    return temp;
  }
  const error = new Error(`unable to allocate an exclusive atomic temp file for ${file}`);
  error.code = 'ATOMIC_TEMP_EXHAUSTED';
  throw error;
}

export function atomicWriteFileSync(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = writeExclusiveTempFileSync(file, content);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

export function atomicCreateFileSync(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = writeExclusiveTempFileSync(file, content);
  try {
    fs.linkSync(temp, file);
    fs.unlinkSync(temp);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}
