import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { CLAIMS_DIR } from '../../config.js';
import {
  atomicCreateFileSync,
  withFileLockSync,
} from '../../lib/fileLock.js';
import {
  assertOwnedStorageFile,
  assertStorageLockBoundary,
  ensureOwnedStorageDirectory,
} from '../../lib/storageBoundary.js';
import {
  canonicalSha256,
  canonicalStringify,
  deepFreeze,
} from '../../core/contracts/ArtifactRef.js';
import {
  CLAIM_ACTION_CONTRACT,
  CLAIM_ACTION_REJECTION_CONTRACT,
  CLAIM_CONTRACT,
  CLAIM_LIBRARY_SCHEMA_VERSION,
  CLAIM_PUBLICATION_CONTRACT,
  ClaimContractError,
  claimDigest,
  claimTimestamp,
  deriveClaimId,
  normalizeClaimAction,
  normalizeClaimActionRecord,
  normalizeClaimEvidenceReference,
  normalizeClaimRecord,
  normalizeClaimRejectionRecord,
  safeClaimId,
} from './claimContracts.js';

const PUBLICATION_LIST_CONTRACT = 'claim-publication-list.v1';
const CLAIM_LIST_CONTRACT = 'claim-library-list.v1';
const CLAIM_HISTORY_CONTRACT = 'claim-history.v1';
const CLAIM_ACTION_LIST_CONTRACT = 'claim-action-list.v1';
const CLAIM_REJECTION_LIST_CONTRACT = 'claim-rejection-list.v1';
const CLAIM_TABLE_CONTRACT = 'claim-table.v1';

const ITEM_REASON = Object.freeze({
  CLAIM_ACTION_DUPLICATE_ID: 'A previous item already used this actionId.',
  CLAIM_ACTION_ADD_ID_CONFLICT: 'The ADD identity already belongs to an existing Claim.',
  CLAIM_ACTION_TARGET_NOT_FOUND: 'The target Claim does not exist in the frozen current Claim Library.',
  CLAIM_ACTION_STALE_TARGET: 'The target Claim version does not match expectedVersion.',
  CLAIM_ACTION_TARGET_CONFLICT: 'A previous valid action already targeted this Claim.',
  CLAIM_ACTION_EVIDENCE_INELIGIBLE: 'The action cites evidence that is not eligible exact ReportVersion evidence for this run.',
  CLAIM_ACTION_NEW_EVIDENCE_REQUIRED: 'The action requires at least one exact ReportVersion newly read in this run.',
});

function fail(code, message, statusCode = 500, options = {}) {
  const error = new Error(message, options);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

function clone(value) {
  return structuredClone(value);
}

function nowIso(now) {
  const value = now();
  try {
    return claimTimestamp(value, 'Claim Library clock');
  } catch (error) {
    fail('CLAIM_INVALID_CLOCK', 'Claim Library clock must return a canonical ISO timestamp', 500, { cause: error });
  }
}

function compareText(left, right) {
  return String(left).localeCompare(String(right));
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CLAIM_CORRUPT_STORAGE', `${label} must be an object`);
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail('CLAIM_CORRUPT_STORAGE', `${label} contains an unexpected field`);
  }
}

function assertSafeRelativePath(value) {
  if (
    typeof value !== 'string'
    || !value
    || value.includes('\\')
    || value.includes('\u0000')
    || path.posix.isAbsolute(value)
  ) fail('CLAIM_CORRUPT_STORAGE', 'Claim publication object path is unsafe');
  const normalized = path.posix.normalize(value);
  if (
    normalized === '.'
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) fail('CLAIM_CORRUPT_STORAGE', 'Claim publication object path is unsafe');
  return normalized;
}

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('CLAIM_STORAGE_PATH_ESCAPE', 'Claim Library path escapes its configured root');
  }
}

function readCanonicalJson(file, label) {
  assertOwnedStorageFile(file, label, { allowMissing: false });
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail('CLAIM_CORRUPT_STORAGE', `${label} is corrupt`, 500, { cause: error });
  }
  const expectedBytes = `${canonicalStringify(value)}\n`;
  if (fs.readFileSync(file, 'utf8') !== expectedBytes) {
    fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', `${label} bytes are not canonical`);
  }
  return value;
}

function writeCanonicalJson(file, value) {
  atomicCreateFileSync(file, `${canonicalStringify(value)}\n`);
}

function paginate(items, {
  limit = 100,
  cursor = null,
  maxLimit = 10_000,
  limitField = 'limit',
  cursorField = 'cursor',
} = {}) {
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > maxLimit) {
    fail('CLAIM_INVALID_LIMIT', `${limitField} must be an integer between 1 and ${maxLimit}`, 400);
  }
  const offset = cursor === null || cursor === undefined || cursor === '' ? 0 : Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    fail('CLAIM_INVALID_CURSOR', `${cursorField} must be a non-negative integer`, 400);
  }
  const page = items.slice(offset, offset + parsedLimit);
  return {
    items: page,
    nextCursor: offset + page.length < items.length ? String(offset + page.length) : null,
  };
}

function paginateAfterIdentity(items, identityOf, {
  limit,
  cursor = null,
  maxLimit = 100,
  limitField,
  cursorField,
}) {
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > maxLimit) {
    fail('CLAIM_INVALID_LIMIT', `${limitField} must be an integer between 1 and ${maxLimit}`, 400);
  }
  let start = 0;
  if (cursor !== null && cursor !== undefined && cursor !== '') {
    if (typeof cursor !== 'string' || cursor.length > 256) {
      fail('CLAIM_INVALID_CURSOR', `${cursorField} is invalid`, 400);
    }
    const cursorIndex = items.findIndex((item) => identityOf(item) === cursor);
    if (cursorIndex < 0) fail('CLAIM_INVALID_CURSOR', `${cursorField} is invalid`, 400);
    start = cursorIndex + 1;
  }
  const page = items.slice(start, start + parsedLimit);
  return {
    items: page,
    nextCursor: start + page.length < items.length && page.length
      ? identityOf(page.at(-1))
      : null,
  };
}

function evidenceKey(reference) {
  return canonicalStringify(reference);
}

function normalizeEligibleEvidence(value) {
  if (!Array.isArray(value) || value.length > 100) {
    fail('CLAIM_INVALID_ELIGIBLE_EVIDENCE', 'eligibleEvidence must be an array of at most 100 exact ReportVersion references', 400);
  }
  const normalized = value.map((item, index) => normalizeClaimEvidenceReference(item, `eligibleEvidence[${index}]`));
  const byReport = new Map();
  for (const reference of normalized) {
    const existing = byReport.get(reference.reportVersionId);
    if (existing && evidenceKey(existing) !== evidenceKey(reference)) {
      fail('CLAIM_ELIGIBLE_EVIDENCE_CONFLICT', 'eligibleEvidence contains conflicting ReportVersion identities', 400);
    }
    byReport.set(reference.reportVersionId, reference);
  }
  return [...byReport.values()];
}

function publicClaim(record) {
  return deepFreeze(clone(record));
}

function actionRecordId(publicationId, actionIndex, actionId) {
  return `action_${canonicalSha256({ publicationId, actionIndex, actionId }).slice('sha256:'.length)}`;
}

function rejectionId(publicationId, actionIndex) {
  return `rejection_${canonicalSha256({ publicationId, actionIndex }).slice('sha256:'.length)}`;
}

function makeClaimRecord(body, {
  claimId,
  version,
  originatingRunId,
  publicationId,
  createdAt,
  updatedAt,
}) {
  return normalizeClaimRecord({
    contract: CLAIM_CONTRACT,
    claimId,
    version,
    ...body,
    originatingRunId,
    publicationId,
    createdAt,
    updatedAt,
    previousVersion: version === 1 ? null : version - 1,
  }, { allowMissingIntegrityDigest: true });
}

function makeActionRecord(action, {
  publicationId,
  originatingRunId,
  actionIndex,
  resultClaim,
  evidence,
  recordedAt,
}) {
  return normalizeClaimActionRecord({
    contract: CLAIM_ACTION_CONTRACT,
    actionRecordId: actionRecordId(publicationId, actionIndex, action.actionId),
    publicationId,
    originatingRunId,
    actionIndex,
    actionId: action.actionId,
    action: action.action,
    rationale: action.rationale,
    target: action.target || null,
    resultClaim,
    evidence,
    recordedAt,
  }, { allowMissingIntegrityDigest: true });
}

function rejectionMetadata(raw) {
  let actionId = null;
  let action = null;
  let target = null;
  try { actionId = safeClaimId(raw?.actionId, 'actionId'); } catch {}
  if (['ADD', 'UPDATE', 'NOOP'].includes(raw?.action)) action = raw.action;
  try {
    if (raw?.target && Number.isInteger(raw.target.expectedVersion) && raw.target.expectedVersion > 0) {
      target = {
        claimId: safeClaimId(raw.target.claimId, 'target.claimId'),
        expectedVersion: raw.target.expectedVersion,
      };
    }
  } catch {}
  return { actionId, action, target };
}

function safeReason(error) {
  const code = typeof error?.code === 'string' && error.code.startsWith('CLAIM_')
    ? error.code
    : 'CLAIM_ACTION_INVALID';
  return {
    code,
    reason: ITEM_REASON[code] || 'The Claim action failed Claim Library v1 validation.',
  };
}

function makeRejection(raw, error, {
  publicationId,
  originatingRunId,
  actionIndex,
  rejectedAt,
}) {
  const metadata = rejectionMetadata(raw);
  const reason = safeReason(error);
  return normalizeClaimRejectionRecord({
    contract: CLAIM_ACTION_REJECTION_CONTRACT,
    rejectionId: rejectionId(publicationId, actionIndex),
    publicationId,
    originatingRunId,
    actionIndex,
    ...metadata,
    ...reason,
    rejectedAt,
  }, { allowMissingIntegrityDigest: true });
}

function itemFailure(code) {
  throw new ClaimContractError(code, ITEM_REASON[code] || 'Claim action is invalid');
}

function assertEvidenceEligible(references, eligibleById, priorById = new Map()) {
  const newlyRead = [];
  for (const reference of references) {
    const eligible = eligibleById.get(reference.reportVersionId);
    const prior = priorById.get(reference.reportVersionId);
    if (eligible && evidenceKey(eligible) === evidenceKey(reference)) {
      newlyRead.push(reference);
      continue;
    }
    if (prior && evidenceKey(prior) === evidenceKey(reference)) continue;
    itemFailure('CLAIM_ACTION_EVIDENCE_INELIGIBLE');
  }
  if (newlyRead.length < 1) itemFailure('CLAIM_ACTION_NEW_EVIDENCE_REQUIRED');
  return newlyRead;
}

function objectEntry(kind, relativePath, record) {
  return {
    kind,
    relativePath,
    objectDigest: record.integrityDigest,
  };
}

function walkFiles(root) {
  const files = [];
  const visit = (directory, prefix = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) fail('CLAIM_CORRUPT_STORAGE', 'Claim publication must not contain symlinks');
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, relative);
      else if (entry.isFile()) files.push(relative);
      else fail('CLAIM_CORRUPT_STORAGE', 'Claim publication contains an invalid entry');
    }
  };
  visit(root);
  return files.sort(compareText);
}

export class ClaimStore {
  static scope = 'claim-library';

  constructor({
    rootDir = null,
    now = () => new Date().toISOString(),
    publicationReader = null,
  } = {}) {
    if (typeof now !== 'function') throw new TypeError('ClaimStore now must be a function');
    if (publicationReader !== null && typeof publicationReader !== 'function') {
      throw new TypeError('ClaimStore publication reader must be a function');
    }
    this.rootDir = path.resolve(rootDir || CLAIMS_DIR);
    this.publicationsDir = path.join(this.rootDir, 'publications');
    this.stagingDir = path.join(this.rootDir, '.publication-staging');
    this.locksDir = path.join(this.rootDir, '.locks');
    this.lockPath = path.join(this.locksDir, 'store.lock');
    this.now = now;
    this.publicationReader = publicationReader;
    this.#ensureTree();
  }

  bindPublicationReader(reader) {
    if (typeof reader !== 'function') throw new TypeError('ClaimStore publication reader must be a function');
    this.publicationReader = reader;
    return this;
  }

  #ensureTree() {
    for (const directory of [this.rootDir, this.publicationsDir, this.stagingDir, this.locksDir]) {
      ensureOwnedStorageDirectory(directory, 'Claim Library storage directory', { create: true, recursive: true });
    }
    assertStorageLockBoundary(this.lockPath, 'Claim Library store lock');
  }

  #publicationDir(publicationId) {
    return path.join(this.publicationsDir, safeClaimId(publicationId, 'publicationId'));
  }

  #publicationFile(publicationId) {
    return path.join(this.#publicationDir(publicationId), 'publication.json');
  }

  #readPublicationDocument(publicationId) {
    const publicationDir = this.#publicationDir(publicationId);
    const stat = fs.lstatSync(publicationDir, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('CLAIM_CORRUPT_STORAGE', 'Claim publication must be a regular directory');
    const document = readCanonicalJson(this.#publicationFile(publicationId), `Claim publication ${publicationId}`);
    exactKeys(document, [
      'contract', 'publicationId', 'originatingRunId', 'requestDigest', 'baseClaimSnapshotDigest', 'createdAt',
      'acceptedActionCount', 'rejectedActionCount', 'claimVersionCount', 'objects', 'publicationDigest',
    ], 'Claim publication');
    if (document.contract !== CLAIM_PUBLICATION_CONTRACT || document.publicationId !== publicationId) {
      fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim publication identity is invalid');
    }
    safeClaimId(document.originatingRunId, 'originatingRunId');
    try {
      claimDigest(document.requestDigest, 'requestDigest');
      claimDigest(document.baseClaimSnapshotDigest, 'baseClaimSnapshotDigest');
      claimDigest(document.publicationDigest, 'publicationDigest');
    } catch (error) {
      fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim publication digest field is invalid', 500, { cause: error });
    }
    claimTimestamp(document.createdAt, 'createdAt');
    for (const field of ['acceptedActionCount', 'rejectedActionCount', 'claimVersionCount']) {
      if (!Number.isInteger(document[field]) || document[field] < 0) fail('CLAIM_CORRUPT_STORAGE', `Claim publication ${field} is invalid`);
    }
    if (!Array.isArray(document.objects)) fail('CLAIM_CORRUPT_STORAGE', 'Claim publication objects must be an array');
    const expectedDigest = canonicalSha256({
      contract: document.contract,
      publicationId: document.publicationId,
      originatingRunId: document.originatingRunId,
      requestDigest: document.requestDigest,
      baseClaimSnapshotDigest: document.baseClaimSnapshotDigest,
      createdAt: document.createdAt,
      acceptedActionCount: document.acceptedActionCount,
      rejectedActionCount: document.rejectedActionCount,
      claimVersionCount: document.claimVersionCount,
      objects: document.objects,
    });
    if (document.publicationDigest !== expectedDigest) {
      fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim publication digest is invalid');
    }
    return document;
  }

  #loadPublication(publicationId) {
    const document = this.#readPublicationDocument(publicationId);
    if (!document) return null;
    const publicationDir = this.#publicationDir(publicationId);
    const claims = [];
    const actions = [];
    const rejections = [];
    const declared = new Set(['publication.json']);
    for (const [index, entry] of document.objects.entries()) {
      exactKeys(entry, ['kind', 'relativePath', 'objectDigest'], `Claim publication object ${index}`);
      if (!['claim', 'action', 'rejection'].includes(entry.kind)) fail('CLAIM_CORRUPT_STORAGE', 'Claim publication object kind is invalid');
      try { claimDigest(entry.objectDigest, 'objectDigest'); } catch (error) {
        fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim publication object digest is invalid', 500, { cause: error });
      }
      const relativePath = assertSafeRelativePath(entry.relativePath);
      if (declared.has(relativePath)) fail('CLAIM_CORRUPT_STORAGE', 'Claim publication contains duplicate object paths');
      declared.add(relativePath);
      const file = path.join(publicationDir, ...relativePath.split('/'));
      assertInside(publicationDir, file);
      const raw = readCanonicalJson(file, `Claim publication object ${relativePath}`);
      let record;
      try {
        if (entry.kind === 'claim') record = normalizeClaimRecord(raw);
        if (entry.kind === 'action') record = normalizeClaimActionRecord(raw);
        if (entry.kind === 'rejection') record = normalizeClaimRejectionRecord(raw);
      } catch (error) {
        fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim publication object is invalid', 500, { cause: error });
      }
      if (record.integrityDigest !== entry.objectDigest) {
        fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim publication object digest does not match its manifest');
      }
      if (record.publicationId !== publicationId || record.originatingRunId !== document.originatingRunId) {
        fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim publication object lineage is invalid');
      }
      if (entry.kind === 'claim') claims.push(record);
      if (entry.kind === 'action') actions.push(record);
      if (entry.kind === 'rejection') rejections.push(record);
    }
    const actualFiles = walkFiles(publicationDir);
    if (canonicalStringify(actualFiles) !== canonicalStringify([...declared].sort(compareText))) {
      fail('CLAIM_CORRUPT_STORAGE', 'Claim publication contains undeclared or missing objects');
    }
    if (
      claims.length !== document.claimVersionCount
      || actions.length !== document.acceptedActionCount
      || rejections.length !== document.rejectedActionCount
    ) fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim publication counts do not match its objects');
    claims.sort((left, right) => compareText(left.claimId, right.claimId) || left.version - right.version);
    actions.sort((left, right) => left.actionIndex - right.actionIndex);
    rejections.sort((left, right) => left.actionIndex - right.actionIndex);
    const ordinals = [...actions, ...rejections].map((record) => record.actionIndex).sort((left, right) => left - right);
    if (ordinals.some((ordinal, index) => ordinal !== index)) {
      fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim publication action ordinals are incomplete or duplicated');
    }
    const acceptedActionIds = new Set();
    const acceptedTargets = new Set();
    const claimKeys = new Set(claims.map((claim) => `${claim.claimId}:v${claim.version}`));
    if (claimKeys.size !== claims.length) {
      fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim publication contains duplicate Claim versions');
    }
    const matchedClaimKeys = new Set();
    for (const action of actions) {
      if (action.actionRecordId !== actionRecordId(publicationId, action.actionIndex, action.actionId)) {
        fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim action record identity is invalid');
      }
      if (acceptedActionIds.has(action.actionId)) {
        fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim publication contains duplicate accepted action IDs');
      }
      acceptedActionIds.add(action.actionId);
      if (action.action === 'ADD') {
        const expectedClaimId = deriveClaimId(document.originatingRunId, action.actionId);
        if (
          action.target !== null
          || action.resultClaim?.claimId !== expectedClaimId
          || action.resultClaim?.version !== 1
        ) fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'ADD action record does not create its run/action-derived Claim v1');
      } else {
        if (!action.target || !action.resultClaim) {
          fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', `${action.action} action record is missing its target`);
        }
        if (acceptedTargets.has(action.target.claimId)) {
          fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim publication contains duplicate accepted targets');
        }
        acceptedTargets.add(action.target.claimId);
        const expectedVersion = action.action === 'UPDATE'
          ? action.target.expectedVersion + 1
          : action.target.expectedVersion;
        if (
          action.resultClaim.claimId !== action.target.claimId
          || action.resultClaim.version !== expectedVersion
        ) fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', `${action.action} action result does not match its explicit target`);
      }
      if (action.action !== 'NOOP') {
        const resultKey = `${action.resultClaim.claimId}:v${action.resultClaim.version}`;
        if (!claimKeys.has(resultKey) || matchedClaimKeys.has(resultKey)) {
          fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim action result does not bind exactly one staged Claim version');
        }
        matchedClaimKeys.add(resultKey);
      }
    }
    if (matchedClaimKeys.size !== claims.length) {
      fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim publication contains a Claim version without one accepted ADD or UPDATE');
    }
    for (const rejection of rejections) {
      if (rejection.rejectionId !== rejectionId(publicationId, rejection.actionIndex)) {
        fail('CLAIM_STORAGE_INTEGRITY_MISMATCH', 'Claim rejection record identity is invalid');
      }
    }
    return deepFreeze({ ...clone(document), claims, actions, rejections });
  }

  #completion(publication) {
    if (!this.publicationReader) return false;
    const result = this.publicationReader(publication.publicationId, {
      publicationId: publication.publicationId,
      originatingRunId: publication.originatingRunId,
      claimPublicationDigest: publication.publicationDigest,
    });
    if (!result) return false;
    if (typeof result !== 'object' || Array.isArray(result)) {
      fail('CLAIM_PUBLICATION_MARKER_MISMATCH', 'Completed publication reader returned an invalid marker');
    }
    if (result.publicationId !== publication.publicationId) {
      fail('CLAIM_PUBLICATION_MARKER_MISMATCH', 'Completed publication reader returned the wrong publication');
    }
    if (result.claimPublicationDigest !== publication.publicationDigest) {
      fail('CLAIM_PUBLICATION_MARKER_MISMATCH', 'Completed publication marker does not bind the staged Claim publication');
    }
    return true;
  }

  #publicationIds() {
    const rootStat = fs.lstatSync(this.publicationsDir, { throwIfNoEntry: false });
    if (!rootStat) return [];
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('CLAIM_CORRUPT_STORAGE', 'Claim publications root is invalid');
    return fs.readdirSync(this.publicationsDir, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name)).map((entry) => {
      if (entry.isSymbolicLink() || !entry.isDirectory()) fail('CLAIM_CORRUPT_STORAGE', 'Claim publications root contains an invalid entry');
      return safeClaimId(entry.name, 'publicationId');
    });
  }

  #visibleState() {
    const publications = [];
    for (const publicationId of this.#publicationIds()) {
      const document = this.#readPublicationDocument(publicationId);
      if (!this.#completion(document)) continue;
      publications.push(this.#loadPublication(publicationId));
    }
    publications.sort((left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.publicationId, right.publicationId));
    const claims = publications.flatMap((publication) => publication.claims);
    const byClaim = new Map();
    for (const claim of claims) {
      const versions = byClaim.get(claim.claimId) || [];
      versions.push(claim);
      byClaim.set(claim.claimId, versions);
    }
    for (const [claimId, versions] of byClaim) {
      versions.sort((left, right) => left.version - right.version);
      for (let index = 0; index < versions.length; index += 1) {
        const version = versions[index];
        if (version.version !== index + 1 || version.previousVersion !== (index === 0 ? null : index)) {
          fail('CLAIM_PUBLICATION_HISTORY_CONFLICT', `Completed Claim history is inconsistent for ${claimId}`);
        }
        if (index > 0 && version.createdAt !== versions[0].createdAt) {
          fail('CLAIM_PUBLICATION_HISTORY_CONFLICT', `Completed Claim createdAt changed for ${claimId}`);
        }
      }
    }
    return { publications, claims, byClaim };
  }

  #stageResult(publication, replayed) {
    return deepFreeze({
      status: 'staged',
      replayed,
      publicationId: publication.publicationId,
      originatingRunId: publication.originatingRunId,
      publicationDigest: publication.publicationDigest,
      manifestDigest: publication.publicationDigest,
      baseClaimSnapshotDigest: publication.baseClaimSnapshotDigest,
      claimPublicationRef: {
        publicationId: publication.publicationId,
        manifestDigest: publication.publicationDigest,
      },
      claimVersionCount: publication.claims.length,
      acceptedActions: publication.actions.map(clone),
      rejectedActions: publication.rejections.map(clone),
      claims: publication.claims.map(clone),
    });
  }

  stageActions({
    originatingRunId: originatingRunIdInput,
    publicationId: publicationIdInput,
    actions,
    eligibleEvidence = [],
    publishedAt = null,
    expectedClaimSnapshotDigest = null,
  } = {}) {
    const originatingRunId = safeClaimId(originatingRunIdInput, 'originatingRunId');
    const publicationId = safeClaimId(publicationIdInput, 'publicationId');
    if (!Array.isArray(actions) || actions.length > 100) {
      fail('CLAIM_ACTION_LIST_INVALID', 'actions must be an array of at most 100 items', 400);
    }
    const normalizedEligibleEvidence = normalizeEligibleEvidence(eligibleEvidence);
    if (expectedClaimSnapshotDigest !== null && !/^sha256:[a-f0-9]{64}$/u.test(expectedClaimSnapshotDigest)) {
      fail('CLAIM_INVALID_SNAPSHOT_DIGEST', 'expectedClaimSnapshotDigest must be a sha256 digest', 400);
    }
    let requestDigest;
    try {
      requestDigest = canonicalSha256({
        originatingRunId,
        publicationId,
        actions,
        eligibleEvidence: normalizedEligibleEvidence,
        publishedAt,
        expectedClaimSnapshotDigest,
      });
    } catch (error) {
      fail('CLAIM_ACTION_LIST_INVALID', 'actions must be bounded JSON values', 400, { cause: error });
    }
    this.#ensureTree();
    return withFileLockSync(this.lockPath, () => {
      const existing = this.#loadPublication(publicationId);
      if (existing) {
        if (existing.requestDigest !== requestDigest || existing.originatingRunId !== originatingRunId) {
          fail('CLAIM_PUBLICATION_IDEMPOTENCY_CONFLICT', 'Claim publication identity conflicts with existing staged bytes', 409);
        }
        return this.#stageResult(existing, true);
      }
      const visible = this.#visibleState();
      const currentClaims = [...visible.byClaim.values()]
        .map((versions) => versions.at(-1))
        .sort((left, right) => compareText(left.claimId, right.claimId));
      const baseClaimSnapshotDigest = canonicalSha256(currentClaims);
      if (expectedClaimSnapshotDigest !== null && expectedClaimSnapshotDigest !== baseClaimSnapshotDigest) {
        fail('CLAIM_FROZEN_STATE_MISMATCH', 'Current Claim Library does not match the frozen Claim snapshot', 409);
      }
      const currentByClaim = new Map(currentClaims.map((claim) => [claim.claimId, claim]));
      const eligibleById = new Map(normalizedEligibleEvidence.map((reference) => [reference.reportVersionId, reference]));
      const acceptedActionIds = new Set();
      const acceptedTargets = new Set();
      const claimRecords = [];
      const actionRecords = [];
      const rejectionRecords = [];
      const timestamp = publishedAt === null
        ? nowIso(this.now)
        : claimTimestamp(publishedAt, 'publishedAt');
      if (currentClaims.some((claim) => Date.parse(timestamp) < Date.parse(claim.updatedAt))) {
        fail('CLAIM_PUBLICATION_TIME_CONFLICT', 'Claim publication time precedes the current Claim Library', 409);
      }

      for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
        const raw = actions[actionIndex];
        try {
          const shallow = rejectionMetadata(raw);
          if (shallow.actionId && acceptedActionIds.has(shallow.actionId)) itemFailure('CLAIM_ACTION_DUPLICATE_ID');
          if (shallow.target && acceptedTargets.has(shallow.target.claimId)) itemFailure('CLAIM_ACTION_TARGET_CONFLICT');
          const action = normalizeClaimAction(raw);

          if (action.action === 'ADD') {
            const claimId = deriveClaimId(originatingRunId, action.actionId);
            if (currentByClaim.has(claimId)) itemFailure('CLAIM_ACTION_ADD_ID_CONFLICT');
            const newEvidence = assertEvidenceEligible(action.claim.evidence, eligibleById);
            const claim = makeClaimRecord(action.claim, {
              claimId,
              version: 1,
              originatingRunId,
              publicationId,
              createdAt: timestamp,
              updatedAt: timestamp,
            });
            const audit = makeActionRecord(action, {
              publicationId,
              originatingRunId,
              actionIndex,
              resultClaim: { claimId, version: 1 },
              evidence: newEvidence,
              recordedAt: timestamp,
            });
            acceptedActionIds.add(action.actionId);
            claimRecords.push(claim);
            actionRecords.push(audit);
            continue;
          }

          const current = currentByClaim.get(action.target.claimId);
          if (!current) itemFailure('CLAIM_ACTION_TARGET_NOT_FOUND');
          if (acceptedTargets.has(action.target.claimId)) itemFailure('CLAIM_ACTION_TARGET_CONFLICT');
          if (current.version !== action.target.expectedVersion) itemFailure('CLAIM_ACTION_STALE_TARGET');

          if (action.action === 'UPDATE') {
            const priorEvidence = new Map(current.evidence.map((reference) => [reference.reportVersionId, reference]));
            const newEvidence = assertEvidenceEligible(action.claim.evidence, eligibleById, priorEvidence);
            const claim = makeClaimRecord(action.claim, {
              claimId: current.claimId,
              version: current.version + 1,
              originatingRunId,
              publicationId,
              createdAt: current.createdAt,
              updatedAt: timestamp,
            });
            const audit = makeActionRecord(action, {
              publicationId,
              originatingRunId,
              actionIndex,
              resultClaim: { claimId: current.claimId, version: claim.version },
              evidence: newEvidence,
              recordedAt: timestamp,
            });
            acceptedActionIds.add(action.actionId);
            claimRecords.push(claim);
            actionRecords.push(audit);
            acceptedTargets.add(action.target.claimId);
            continue;
          }

          assertEvidenceEligible(action.evidence, eligibleById);
          acceptedActionIds.add(action.actionId);
          actionRecords.push(makeActionRecord(action, {
            publicationId,
            originatingRunId,
            actionIndex,
            resultClaim: { claimId: current.claimId, version: current.version },
            evidence: action.evidence,
            recordedAt: timestamp,
          }));
          acceptedTargets.add(action.target.claimId);
        } catch (error) {
          if (!(error instanceof ClaimContractError)) throw error;
          rejectionRecords.push(makeRejection(raw, error, {
            publicationId,
            originatingRunId,
            actionIndex,
            rejectedAt: timestamp,
          }));
        }
      }

      const tempDir = path.join(this.stagingDir, `.${publicationId}.${process.pid}.${crypto.randomUUID()}`);
      const finalDir = this.#publicationDir(publicationId);
      ensureOwnedStorageDirectory(tempDir, 'Claim publication staging directory', { create: true });
      for (const subdirectory of ['claims', 'actions', 'rejections']) {
        ensureOwnedStorageDirectory(path.join(tempDir, subdirectory), 'Claim publication object directory', { create: true });
      }
      const objects = [];
      let renamed = false;
      try {
        for (const claim of claimRecords) {
          const relativePath = `claims/${claim.claimId}.v${claim.version}.json`;
          writeCanonicalJson(path.join(tempDir, ...relativePath.split('/')), claim);
          objects.push(objectEntry('claim', relativePath, claim));
        }
        for (const action of actionRecords) {
          const relativePath = `actions/${String(action.actionIndex).padStart(3, '0')}-${action.actionRecordId}.json`;
          writeCanonicalJson(path.join(tempDir, ...relativePath.split('/')), action);
          objects.push(objectEntry('action', relativePath, action));
        }
        for (const rejection of rejectionRecords) {
          const relativePath = `rejections/${String(rejection.actionIndex).padStart(3, '0')}-${rejection.rejectionId}.json`;
          writeCanonicalJson(path.join(tempDir, ...relativePath.split('/')), rejection);
          objects.push(objectEntry('rejection', relativePath, rejection));
        }
        objects.sort((left, right) => compareText(left.relativePath, right.relativePath));
        const base = {
          contract: CLAIM_PUBLICATION_CONTRACT,
          publicationId,
          originatingRunId,
          requestDigest,
          baseClaimSnapshotDigest,
          createdAt: timestamp,
          acceptedActionCount: actionRecords.length,
          rejectedActionCount: rejectionRecords.length,
          claimVersionCount: claimRecords.length,
          objects,
        };
        const publication = { ...base, publicationDigest: canonicalSha256(base) };
        writeCanonicalJson(path.join(tempDir, 'publication.json'), publication);
        fs.renameSync(tempDir, finalDir);
        renamed = true;
      } finally {
        if (!renamed) fs.rmSync(tempDir, { recursive: true, force: true });
      }
      return this.#stageResult(this.#loadPublication(publicationId), false);
    });
  }

  stagePublication(input = {}) {
    let eligibleEvidence = input.eligibleEvidence;
    if (eligibleEvidence === undefined) {
      const manifestItems = input.frozenReportManifest?.items ?? input.manifest?.items ?? [];
      const manifestByReport = new Map(manifestItems.map((item) => [item.reportVersionId, item]));
      eligibleEvidence = (input.selectedFullReads ?? []).map((read) => {
        const manifest = manifestByReport.get(read.reportVersionId);
        if (!manifest || read.verified !== true) {
          fail('CLAIM_ELIGIBLE_EVIDENCE_CONFLICT', 'Eligible evidence must be a verified full read from the frozen ReportVersion manifest', 409);
        }
        const reference = {
          reportVersionId: read.reportVersionId,
          contentDigest: read.contentDigest,
          fingerprint: read.fingerprint ?? manifest.fingerprint,
        };
        if (manifest.contentDigest !== reference.contentDigest || manifest.fingerprint !== reference.fingerprint) {
          fail('CLAIM_ELIGIBLE_EVIDENCE_CONFLICT', 'Selected full read conflicts with the frozen ReportVersion manifest', 409);
        }
        return reference;
      });
    }
    return this.stageActions({
      originatingRunId: input.originatingRunId ?? input.runId,
      publicationId: input.publicationId,
      actions: input.actions ?? input.rawClaimActions,
      eligibleEvidence,
      publishedAt: input.publishedAt ?? input.asOf ?? null,
      expectedClaimSnapshotDigest: input.expectedClaimSnapshotDigest ?? input.frozenClaims?.snapshotDigest ?? null,
    });
  }

  getStagedPublication(publicationIdInput) {
    const publicationId = safeClaimId(publicationIdInput, 'publicationId');
    const publication = this.#loadPublication(publicationId);
    return publication ? deepFreeze(clone(publication)) : null;
  }

  publication(publicationIdInput) {
    const publicationId = safeClaimId(publicationIdInput, 'publicationId');
    const document = this.#readPublicationDocument(publicationId);
    if (!document || !this.#completion(document)) return null;
    return deepFreeze(clone(this.#loadPublication(publicationId)));
  }

  publications({ limit = 100, cursor = null } = {}) {
    const state = this.#visibleState();
    const page = paginate(state.publications, { limit, cursor });
    return deepFreeze({
      schemaVersion: PUBLICATION_LIST_CONTRACT,
      publications: page.items.map(clone),
      nextCursor: page.nextCursor,
    });
  }

  list({ ticker = null, limit = 100, cursor = null } = {}) {
    const state = this.#visibleState();
    let claims = [...state.byClaim.values()].map((versions) => versions.at(-1));
    if (ticker !== null) {
      const normalizedTicker = String(ticker).trim().toUpperCase();
      claims = claims.filter((claim) => claim.tickers.includes(normalizedTicker));
    }
    claims.sort((left, right) => compareText(left.claimId, right.claimId));
    const page = paginate(claims, { limit, cursor });
    return deepFreeze({
      schemaVersion: CLAIM_LIST_CONTRACT,
      claims: page.items.map(publicClaim),
      nextCursor: page.nextCursor,
    });
  }

  get(claimIdInput, { version = null } = {}) {
    const claimId = safeClaimId(claimIdInput, 'claimId');
    const versions = this.#visibleState().byClaim.get(claimId) || [];
    if (!versions.length) return null;
    if (version === null) return publicClaim(versions.at(-1));
    const parsedVersion = Number(version);
    if (!Number.isInteger(parsedVersion) || parsedVersion < 1) fail('CLAIM_INVALID_VERSION', 'version must be a positive integer', 400);
    const selected = versions.find((claim) => claim.version === parsedVersion);
    return selected ? publicClaim(selected) : null;
  }

  history(claimIdInput, {
    versionsLimit = 50,
    versionsCursor = null,
    actionsLimit = 50,
    actionsCursor = null,
    rejectionsLimit = 50,
    rejectionsCursor = null,
  } = {}) {
    const claimId = safeClaimId(claimIdInput, 'claimId');
    const state = this.#visibleState();
    const versions = [...(state.byClaim.get(claimId) || [])].reverse();
    const actions = state.publications.flatMap((publication) => publication.actions).filter((action) => (
      action.target?.claimId === claimId || action.resultClaim?.claimId === claimId
    )).sort((left, right) => (
      compareText(right.recordedAt, left.recordedAt)
      || right.actionIndex - left.actionIndex
      || compareText(right.actionRecordId, left.actionRecordId)
    ));
    const rejections = state.publications.flatMap((publication) => publication.rejections).filter((rejection) => (
      rejection.target?.claimId === claimId
    )).sort((left, right) => (
      compareText(right.rejectedAt, left.rejectedAt)
      || right.actionIndex - left.actionIndex
      || compareText(right.rejectionId, left.rejectionId)
    ));
    const versionsPage = paginateAfterIdentity(versions, (claim) => String(claim.version), {
      limit: versionsLimit,
      cursor: versionsCursor,
      limitField: 'versionsLimit',
      cursorField: 'versionsCursor',
    });
    const actionsPage = paginateAfterIdentity(actions, (action) => action.actionRecordId, {
      limit: actionsLimit,
      cursor: actionsCursor,
      limitField: 'actionsLimit',
      cursorField: 'actionsCursor',
    });
    const rejectionsPage = paginateAfterIdentity(rejections, (rejection) => rejection.rejectionId, {
      limit: rejectionsLimit,
      cursor: rejectionsCursor,
      limitField: 'rejectionsLimit',
      cursorField: 'rejectionsCursor',
    });
    return deepFreeze({
      schemaVersion: CLAIM_HISTORY_CONTRACT,
      claimId,
      totalCounts: {
        versions: versions.length,
        actions: actions.length,
        rejections: rejections.length,
      },
      versions: versionsPage.items.map(publicClaim),
      actions: actionsPage.items.map(clone),
      rejections: rejectionsPage.items.map(clone),
      nextCursors: {
        versions: versionsPage.nextCursor,
        actions: actionsPage.nextCursor,
        rejections: rejectionsPage.nextCursor,
      },
    });
  }

  actions({ claimId: claimIdInput = null, publicationId: publicationIdInput = null, action = null, limit = 100, cursor = null } = {}) {
    const state = this.#visibleState();
    let records = state.publications.flatMap((publication) => publication.actions);
    if (claimIdInput !== null) {
      const claimId = safeClaimId(claimIdInput, 'claimId');
      records = records.filter((record) => record.target?.claimId === claimId || record.resultClaim?.claimId === claimId);
    }
    if (publicationIdInput !== null) {
      const publicationId = safeClaimId(publicationIdInput, 'publicationId');
      records = records.filter((record) => record.publicationId === publicationId);
    }
    if (action !== null) records = records.filter((record) => record.action === String(action).toUpperCase());
    records.sort((left, right) => compareText(left.recordedAt, right.recordedAt) || left.actionIndex - right.actionIndex);
    const page = paginate(records, { limit, cursor });
    return deepFreeze({ schemaVersion: CLAIM_ACTION_LIST_CONTRACT, actions: page.items.map(clone), nextCursor: page.nextCursor });
  }

  rejections({ publicationId: publicationIdInput = null, code = null, limit = 100, cursor = null } = {}) {
    const state = this.#visibleState();
    let records = state.publications.flatMap((publication) => publication.rejections);
    if (publicationIdInput !== null) {
      const publicationId = safeClaimId(publicationIdInput, 'publicationId');
      records = records.filter((record) => record.publicationId === publicationId);
    }
    if (code !== null) records = records.filter((record) => record.code === String(code));
    records.sort((left, right) => compareText(left.rejectedAt, right.rejectedAt) || left.actionIndex - right.actionIndex);
    const page = paginate(records, { limit, cursor });
    return deepFreeze({ schemaVersion: CLAIM_REJECTION_LIST_CONTRACT, rejections: page.items.map(clone), nextCursor: page.nextCursor });
  }

  currentTable() {
    const claims = [...this.#visibleState().byClaim.values()]
      .map((versions) => versions.at(-1))
      .sort((left, right) => compareText(left.claimId, right.claimId))
      .map(({ claimId, version, assertion }) => ({ claimId, version, assertion }));
    return deepFreeze({ schemaVersion: CLAIM_TABLE_CONTRACT, claims });
  }

  snapshot() {
    const current = [...this.#visibleState().byClaim.values()]
      .map((versions) => versions.at(-1))
      .sort((left, right) => compareText(left.claimId, right.claimId));
    const claims = current.map(publicClaim);
    return deepFreeze({
      schemaVersion: 'claim-library-snapshot.v1',
      claims,
      table: current.map(({ claimId, version, assertion }) => ({ claimId, version, assertion })),
      snapshotDigest: canonicalSha256(claims),
    });
  }

  status() {
    const state = this.#visibleState();
    return deepFreeze({
      schemaVersion: CLAIM_LIBRARY_SCHEMA_VERSION,
      publicationCount: state.publications.length,
      claimCount: state.byClaim.size,
      versionCount: state.claims.length,
      actionCount: state.publications.reduce((count, publication) => count + publication.actions.length, 0),
      rejectionCount: state.publications.reduce((count, publication) => count + publication.rejections.length, 0),
    });
  }
}

export function createClaimStore(options = {}) { return new ClaimStore(options); }
