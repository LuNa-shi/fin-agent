import crypto from 'node:crypto';
import path from 'node:path';

import { acquireFileLockSync } from '../../lib/fileLock.js';

const ACTIVE_SEQUENCE_GUARD_NAME = 'active-sequence.guard';

function sequenceBusyError() {
  const error = new Error('Another global Worldview processing sequence is active');
  error.code = 'WORLDVIEW_SEQUENCE_BUSY';
  error.statusCode = 409;
  return error;
}

export function canonicalWorldviewActiveSequenceGuardPath(worldviewRoot) {
  if (typeof worldviewRoot !== 'string' || !worldviewRoot.trim()) {
    throw new TypeError('Canonical Worldview root is required');
  }
  const resolvedRoot = path.resolve(worldviewRoot);
  const rootIdentity = crypto.createHash('sha256')
    .update(resolvedRoot)
    .digest('hex')
    .slice(0, 24);
  return path.join(
    path.dirname(resolvedRoot),
    '.locks',
    `${ACTIVE_SEQUENCE_GUARD_NAME}.${rootIdentity}`,
  );
}

export function acquireCanonicalWorldviewActiveSequenceGuard({
  worldviewRoot,
  ownerId,
  ownerKind = 'worldview-trigger',
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof ownerId !== 'string' || !ownerId.trim()) {
    throw new TypeError('Canonical Worldview active sequence ownerId is required');
  }
  if (typeof ownerKind !== 'string' || !ownerKind.trim()) {
    throw new TypeError('Canonical Worldview active sequence ownerKind is required');
  }
  if (typeof now !== 'function') {
    throw new TypeError('Canonical Worldview active sequence now must be a function');
  }
  try {
    return acquireFileLockSync(
      canonicalWorldviewActiveSequenceGuardPath(worldviewRoot),
      { timeoutMs: 0 },
    );
  } catch (error) {
    if (error?.code === 'FILE_LOCK_TIMEOUT') throw sequenceBusyError();
    throw error;
  }
}
