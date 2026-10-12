import fs from 'node:fs';
import path from 'node:path';

import { IDEA_RUNS_DIR } from '../../config.js';
import {
  canonicalSha256,
  canonicalStringify,
  deepFreeze,
} from '../../core/contracts/ArtifactRef.js';
import {
  atomicCreateFileSync,
  withFileLockSync,
} from '../../lib/fileLock.js';

export const IDEA_RUN_INPUT_SNAPSHOT_SCHEMA_VERSION = 'idea-run-input-snapshot.v2';
export const LEGACY_IDEA_RUN_INPUT_SNAPSHOT_SCHEMA_VERSION = 'idea-run-input-snapshot.v1';
const IDEA_RUN_INPUT_SNAPSHOT_SCHEMA_VERSIONS = new Set([
  LEGACY_IDEA_RUN_INPUT_SNAPSHOT_SCHEMA_VERSION,
  IDEA_RUN_INPUT_SNAPSHOT_SCHEMA_VERSION,
]);
export const IDEA_RUN_INPUT_SNAPSHOT_ID_PREFIX = 'idea-run-input-snapshot:';
export const IDEA_RUN_EFFECTIVE_CONFIG_AGENTS = Object.freeze([
  'idea-generator',
  'idea-quality-reviewer',
]);

const SAFE_DIRECT_CHILD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SEMVER = /^\d+\.\d+\.\d+$/u;
const SNAPSHOT_FIELDS = new Set([
  'schemaVersion',
  'runId',
  'workflow',
  'asOf',
  'inputs',
  'effectiveConfig',
  'inputDigests',
  'policyDigest',
  'configDigest',
  'contentDigest',
  'snapshotId',
]);
const CREATE_FIELDS = new Set([
  'runId',
  'workflow',
  'asOf',
  'inputs',
  'effectiveConfig',
]);
const WORKFLOW_FIELDS = new Set(['id', 'version', 'hash']);
const INPUT_FIELDS = new Set([
  'existingIdeas',
  'positions',
  'mandate',
  'settings',
  'command',
]);
const IDEA_FIELDS = new Set([
  'id',
  'type',
  'status',
  'title',
  'theme',
  'tickers',
  'contentRef',
  'contentDigest',
  'createdAt',
  'updatedAt',
]);
const POSITION_FIELDS = new Set([
  'id',
  'ticker',
  'name',
  'theme',
  'reason',
  'weight',
  'rank',
  'confidence',
  'status',
  'addedAt',
]);
const MANDATE_FIELD_TYPES = Object.freeze({
  style: 'string',
  minMarketCap: 'number',
  maxLeverage: 'number',
  minCandidates: 'number',
  maxCandidates: 'number',
  maxHoldings: 'number',
  convexityBonus: 'number',
  horizonPref: 'string',
  allowDataGap: 'boolean',
  maxProjectAgeDays: 'number',
});
const MANDATE_FIELDS = new Set(Object.keys(MANDATE_FIELD_TYPES));
const SHARED_SETTING_FIELD_TYPES = Object.freeze({
  DEFAULT_PROVIDER: 'string',
  DEEPSEEK_MODEL: 'string',
  SMALL_PROVIDER: 'string',
  SMALL_MODEL: 'string',
  MAIN_PROVIDER: 'string',
  MAIN_MODEL: 'string',
  REFLECTION_PROVIDER: 'string',
  REFLECTION_MODEL: 'string',
  UI_LANGUAGE: 'string',
  ANALYSIS_LANGUAGE: 'string',
  REPORT_LANGUAGE: 'string',
  DEMO_MODE: 'boolean',
});
const SETTING_FIELD_TYPES_BY_SCHEMA = Object.freeze({
  [LEGACY_IDEA_RUN_INPUT_SNAPSHOT_SCHEMA_VERSION]: Object.freeze({
    ...SHARED_SETTING_FIELD_TYPES,
    GPT_GATEWAY_MODEL: 'string',
    GPT_GATEWAY_REASONING_LEVEL: 'string',
  }),
  [IDEA_RUN_INPUT_SNAPSHOT_SCHEMA_VERSION]: Object.freeze({
    ...SHARED_SETTING_FIELD_TYPES,
    OPENAI_COMPATIBLE_MODEL: 'string',
    OPENAI_COMPATIBLE_REASONING_LEVEL: 'string',
  }),
});
const COMMAND_FIELD_TYPES = Object.freeze({
  count: 'positive-integer',
  poolTarget: 'positive-integer',
  targetPerNode: 'positive-integer',
  tokenBudget: 'positive-integer',
});
const COMMAND_FIELDS = new Set(Object.keys(COMMAND_FIELD_TYPES));
const EFFECTIVE_CONFIG_FIELDS = new Set(['agents']);
const EFFECTIVE_AGENT_FIELDS = new Set(['agentId', 'revision', 'digest']);
const INPUT_DIGEST_FIELDS = new Set(INPUT_FIELDS);
const FORBIDDEN_FIELD_PARTS = Object.freeze([
  'apikey',
  'authorization',
  'bearer',
  'cookie',
  'credential',
  'endpoint',
  'password',
  'project',
  'secret',
]);
const FORBIDDEN_EXACT_FIELDS = new Set([
  'accesstoken',
  'env',
  'idtoken',
  'messages',
  'path',
  'providermessages',
  'providerpayload',
  'providerrequest',
  'providerresponse',
  'rawpayload',
  'refreshtoken',
  'sessiontoken',
  'token',
]);
const SAFE_SENSITIVE_SUBSTRING_FIELDS = new Set([
  'maxprojectagedays',
  'tokenbudget',
]);

function snapshotError(message, code = 'IDEA_RUN_INPUT_SNAPSHOT_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fail(message, code) {
  throw snapshotError(message, code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, location) {
  if (!isPlainObject(value)) fail(`${location} must be an object`);
}

function assertKnownFields(value, fields, location) {
  assertObject(value, location);
  const unknown = Object.keys(value).filter((field) => !fields.has(field));
  if (unknown.length) fail(`${location} contains unknown fields: ${unknown.join(', ')}`);
}

function requireOwn(value, field, location) {
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    fail(`${location}.${field} is required`);
  }
  return value[field];
}

function assertNonEmptyString(value, location, { allowEmpty = false } = {}) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || (!allowEmpty && !value)
  ) {
    fail(`${location} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  return value;
}

function assertSafeDirectChildId(value, location) {
  if (
    typeof value !== 'string'
    || !SAFE_DIRECT_CHILD_ID.test(value)
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
    || path.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    fail(`${location} is not a safe direct-child id`, 'IDEA_RUN_INPUT_SNAPSHOT_UNSAFE_ID');
  }
  return value;
}

function assertIsoTimestamp(value, location) {
  if (typeof value !== 'string') fail(`${location} must be an ISO timestamp`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    fail(`${location} must be an ISO timestamp`);
  }
  return value;
}

function assertDigest(value, location) {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    fail(`${location} must be a sha256 digest`);
  }
  return value;
}

function normalizedFieldName(field) {
  return String(field).toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function assertSafeFieldName(field, location) {
  const normalized = normalizedFieldName(field);
  if (SAFE_SENSITIVE_SUBSTRING_FIELDS.has(normalized)) return;
  if (
    FORBIDDEN_EXACT_FIELDS.has(normalized)
    || FORBIDDEN_FIELD_PARTS.some((part) => normalized.includes(part))
    || normalized.includes('path')
  ) {
    fail(`${location} contains forbidden input field ${field}`, 'IDEA_RUN_INPUT_SNAPSHOT_FORBIDDEN_INPUT');
  }
}

function assertSafeStringValue(value, location, { contentRef = false } = {}) {
  if (value.includes('\0') || value.includes('\\')) {
    fail(`${location} contains an unsafe path value`, 'IDEA_RUN_INPUT_SNAPSHOT_FORBIDDEN_INPUT');
  }
  if (contentRef) return;
  if (
    value === '.env'
    || value.endsWith('/.env')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /(^|\/)\.\.?($|\/)/u.test(value)
    || /^(?:file|project|workspace):\/\//iu.test(value)
    || /^projects?\//iu.test(value)
    || /^https?:\/\//iu.test(value)
    || /^\s*(?:Bearer|Basic)\s+\S+/iu.test(value)
    || /^sk-[A-Za-z0-9_-]{8,}$/u.test(value)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value)
    || /"(?:apiKey|authorization|choices|cookie|credentials|messages|password|providerPayload|secret)"\s*:/iu.test(value)
  ) {
    fail(`${location} contains forbidden path or sensitive input`, 'IDEA_RUN_INPUT_SNAPSHOT_FORBIDDEN_INPUT');
  }
}

function assertNoForbiddenInput(value, location = 'IdeaRunInputSnapshot create input', parentField = '') {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    assertSafeStringValue(value, location, { contentRef: parentField === 'contentRef' });
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        fail(`${location} must not contain sparse arrays`);
      }
      assertNoForbiddenInput(value[index], `${location}[${index}]`, parentField);
    }
    return;
  }
  assertObject(value, location);
  for (const [field, child] of Object.entries(value)) {
    if (field !== 'contentRef') assertSafeFieldName(field, location);
    assertNoForbiddenInput(child, `${location}.${field}`, field);
  }
}

function optionalTimestamp(value, location) {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return assertIsoTimestamp(value, location);
}

function optionalString(value, location) {
  if (value === null) return null;
  return assertNonEmptyString(value, location);
}

function optionalFiniteNumber(value, location) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${location} must be a finite number or null`);
  }
  return value;
}

function normalizeWorkflow(value) {
  const location = 'IdeaRunInputSnapshot.workflow';
  assertKnownFields(value, WORKFLOW_FIELDS, location);
  const id = assertNonEmptyString(requireOwn(value, 'id', location), `${location}.id`);
  const version = assertNonEmptyString(
    requireOwn(value, 'version', location),
    `${location}.version`,
  );
  if (!SEMVER.test(version)) fail(`${location}.version must be a semantic version`);
  const hash = assertDigest(requireOwn(value, 'hash', location), `${location}.hash`);
  return { id, version, hash };
}

function normalizeExistingIdea(value, index) {
  const location = `IdeaRunInputSnapshot.inputs.existingIdeas[${index}]`;
  assertKnownFields(value, IDEA_FIELDS, location);
  const id = assertSafeDirectChildId(requireOwn(value, 'id', location), `${location}.id`);
  const title = assertNonEmptyString(requireOwn(value, 'title', location), `${location}.title`);
  const normalized = { id };
  if (Object.prototype.hasOwnProperty.call(value, 'type')) {
    if (value.type !== 'idea') fail(`${location}.type must be idea`);
    normalized.type = 'idea';
  }
  if (Object.prototype.hasOwnProperty.call(value, 'status')) {
    normalized.status = optionalString(value.status, `${location}.status`);
  }
  normalized.title = title;
  if (Object.prototype.hasOwnProperty.call(value, 'theme')) {
    normalized.theme = optionalString(value.theme, `${location}.theme`);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'tickers')) {
    if (!Array.isArray(value.tickers)) fail(`${location}.tickers must be an array`);
    normalized.tickers = value.tickers.map((ticker, tickerIndex) => assertNonEmptyString(
      ticker,
      `${location}.tickers[${tickerIndex}]`,
    ));
  }
  const hasContentRef = Object.prototype.hasOwnProperty.call(value, 'contentRef');
  const hasContentDigest = Object.prototype.hasOwnProperty.call(value, 'contentDigest');
  if (hasContentRef !== hasContentDigest) {
    fail(`${location}.contentRef and contentDigest must be supplied together`);
  }
  if (hasContentRef) {
    const expectedRef = `idea-generation/ideas/${id}`;
    if (value.contentRef !== expectedRef) {
      fail(
        `${location}.contentRef must be ${expectedRef}`,
        'IDEA_RUN_INPUT_SNAPSHOT_FORBIDDEN_INPUT',
      );
    }
    normalized.contentRef = value.contentRef;
    normalized.contentDigest = assertDigest(
      value.contentDigest,
      `${location}.contentDigest`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, 'createdAt')) {
    normalized.createdAt = optionalTimestamp(value.createdAt, `${location}.createdAt`);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'updatedAt')) {
    normalized.updatedAt = optionalTimestamp(value.updatedAt, `${location}.updatedAt`);
  }
  return normalized;
}

function normalizePosition(value, index) {
  const location = `IdeaRunInputSnapshot.inputs.positions[${index}]`;
  assertKnownFields(value, POSITION_FIELDS, location);
  const ticker = assertNonEmptyString(
    requireOwn(value, 'ticker', location),
    `${location}.ticker`,
  );
  const normalized = {};
  if (Object.prototype.hasOwnProperty.call(value, 'id')) {
    normalized.id = optionalString(value.id, `${location}.id`);
  }
  normalized.ticker = ticker;
  for (const field of ['name', 'theme', 'reason', 'status']) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      normalized[field] = optionalString(value[field], `${location}.${field}`);
    }
  }
  for (const field of ['weight', 'rank', 'confidence']) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      normalized[field] = optionalFiniteNumber(value[field], `${location}.${field}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'addedAt')) {
    normalized.addedAt = optionalTimestamp(value.addedAt, `${location}.addedAt`);
  }
  return normalized;
}

function normalizeTypedObject(value, fields, types, location) {
  assertKnownFields(value, fields, location);
  const normalized = {};
  for (const field of Object.keys(types)) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const expected = types[field];
    const child = value[field];
    if (expected === 'string') {
      normalized[field] = assertNonEmptyString(child, `${location}.${field}`, {
        allowEmpty: location.endsWith('.settings'),
      });
    } else if (expected === 'boolean') {
      if (typeof child !== 'boolean') fail(`${location}.${field} must be a boolean`);
      normalized[field] = child;
    } else if (expected === 'number') {
      if (typeof child !== 'number' || !Number.isFinite(child)) {
        fail(`${location}.${field} must be a finite number`);
      }
      normalized[field] = child;
    } else if (expected === 'positive-integer') {
      if (!Number.isInteger(child) || child <= 0) {
        fail(`${location}.${field} must be a positive integer`);
      }
      normalized[field] = child;
    }
  }
  return normalized;
}

function normalizeInputs(value, schemaVersion) {
  const location = 'IdeaRunInputSnapshot.inputs';
  assertKnownFields(value, INPUT_FIELDS, location);
  const existingIdeas = requireOwn(value, 'existingIdeas', location);
  const positions = requireOwn(value, 'positions', location);
  if (!Array.isArray(existingIdeas)) fail(`${location}.existingIdeas must be an array`);
  if (!Array.isArray(positions)) fail(`${location}.positions must be an array`);
  const mandate = requireOwn(value, 'mandate', location);
  const settings = requireOwn(value, 'settings', location);
  const command = requireOwn(value, 'command', location);
  return {
    existingIdeas: existingIdeas.map(normalizeExistingIdea),
    positions: positions.map(normalizePosition),
    mandate: normalizeTypedObject(
      mandate,
      MANDATE_FIELDS,
      MANDATE_FIELD_TYPES,
      `${location}.mandate`,
    ),
    settings: (() => {
      const settingTypes = SETTING_FIELD_TYPES_BY_SCHEMA[schemaVersion];
      if (!settingTypes) fail('IdeaRunInputSnapshot has an unsupported schema version');
      return normalizeTypedObject(
        settings,
        new Set(Object.keys(settingTypes)),
        settingTypes,
        `${location}.settings`,
      );
    })(),
    command: normalizeTypedObject(
      command,
      COMMAND_FIELDS,
      COMMAND_FIELD_TYPES,
      `${location}.command`,
    ),
  };
}

function normalizeEffectiveConfig(value) {
  const location = 'IdeaRunInputSnapshot.effectiveConfig';
  assertKnownFields(value, EFFECTIVE_CONFIG_FIELDS, location);
  const agents = requireOwn(value, 'agents', location);
  if (!Array.isArray(agents)) fail(`${location}.agents must be an array`);
  const byId = new Map();
  for (let index = 0; index < agents.length; index += 1) {
    const agentLocation = `${location}.agents[${index}]`;
    const agent = agents[index];
    assertKnownFields(agent, EFFECTIVE_AGENT_FIELDS, agentLocation);
    const agentId = assertNonEmptyString(
      requireOwn(agent, 'agentId', agentLocation),
      `${agentLocation}.agentId`,
    );
    if (!IDEA_RUN_EFFECTIVE_CONFIG_AGENTS.includes(agentId)) {
      fail(`${agentLocation}.agentId is not an Idea Generation Agent`);
    }
    if (byId.has(agentId)) fail(`${location}.agents contains duplicate ${agentId}`);
    byId.set(agentId, {
      agentId,
      revision: assertNonEmptyString(
        requireOwn(agent, 'revision', agentLocation),
        `${agentLocation}.revision`,
      ),
      digest: assertDigest(
        requireOwn(agent, 'digest', agentLocation),
        `${agentLocation}.digest`,
      ),
    });
  }
  const missing = IDEA_RUN_EFFECTIVE_CONFIG_AGENTS.filter((agentId) => !byId.has(agentId));
  if (missing.length || byId.size !== IDEA_RUN_EFFECTIVE_CONFIG_AGENTS.length) {
    fail(`${location}.agents must contain exactly: ${IDEA_RUN_EFFECTIVE_CONFIG_AGENTS.join(', ')}`);
  }
  return {
    agents: IDEA_RUN_EFFECTIVE_CONFIG_AGENTS.map((agentId) => byId.get(agentId)),
  };
}

function createInputDigests(inputs) {
  return Object.freeze(Object.fromEntries(
    [...INPUT_FIELDS].map((field) => [field, canonicalSha256(inputs[field])]),
  ));
}

function buildSnapshot(input, { schemaVersion = IDEA_RUN_INPUT_SNAPSHOT_SCHEMA_VERSION } = {}) {
  assertKnownFields(input, CREATE_FIELDS, 'IdeaRunInputSnapshot create input');
  if (!IDEA_RUN_INPUT_SNAPSHOT_SCHEMA_VERSIONS.has(schemaVersion)) {
    fail('IdeaRunInputSnapshot has an unsupported schema version');
  }
  assertNoForbiddenInput(input);
  const runId = assertSafeDirectChildId(
    requireOwn(input, 'runId', 'IdeaRunInputSnapshot create input'),
    'IdeaRunInputSnapshot.runId',
  );
  const workflow = normalizeWorkflow(
    requireOwn(input, 'workflow', 'IdeaRunInputSnapshot create input'),
  );
  const asOf = assertIsoTimestamp(
    requireOwn(input, 'asOf', 'IdeaRunInputSnapshot create input'),
    'IdeaRunInputSnapshot.asOf',
  );
  const inputs = normalizeInputs(
    requireOwn(input, 'inputs', 'IdeaRunInputSnapshot create input'),
    schemaVersion,
  );
  const effectiveConfig = normalizeEffectiveConfig(
    requireOwn(input, 'effectiveConfig', 'IdeaRunInputSnapshot create input'),
  );
  const inputDigests = createInputDigests(inputs);
  const policyDigest = canonicalSha256({
    workflow,
    commandDigest: inputDigests.command,
  });
  const configDigest = canonicalSha256(effectiveConfig);
  const logicalRecord = {
    schemaVersion,
    runId,
    workflow,
    asOf,
    inputs,
    effectiveConfig,
    inputDigests,
    policyDigest,
    configDigest,
  };
  const contentDigest = canonicalSha256(logicalRecord);
  const snapshotId = `${IDEA_RUN_INPUT_SNAPSHOT_ID_PREFIX}${contentDigest.slice('sha256:'.length)}`;
  return deepFreeze({
    ...logicalRecord,
    contentDigest,
    snapshotId,
  });
}

function validateStoredSnapshot(value, expectedRunId) {
  const location = 'stored IdeaRunInputSnapshot';
  assertKnownFields(value, SNAPSHOT_FIELDS, location);
  if (!IDEA_RUN_INPUT_SNAPSHOT_SCHEMA_VERSIONS.has(value.schemaVersion)) {
    fail('stored IdeaRunInputSnapshot has an unsupported schema version');
  }
  const expected = buildSnapshot({
    runId: value.runId,
    workflow: value.workflow,
    asOf: value.asOf,
    inputs: value.inputs,
    effectiveConfig: value.effectiveConfig,
  }, { schemaVersion: value.schemaVersion });
  if (expected.runId !== expectedRunId) {
    fail(
      'stored IdeaRunInputSnapshot run identity does not match its folder',
      'IDEA_RUN_INPUT_SNAPSHOT_CORRUPT',
    );
  }
  assertKnownFields(value.inputDigests, INPUT_DIGEST_FIELDS, `${location}.inputDigests`);
  if (canonicalStringify(value) !== canonicalStringify(expected)) {
    fail(
      'stored IdeaRunInputSnapshot digest or identity mismatch',
      'IDEA_RUN_INPUT_SNAPSHOT_CORRUPT',
    );
  }
  return expected;
}

function lstatOrNull(pathname) {
  try {
    return fs.lstatSync(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertDirectory(pathname, location) {
  const stat = lstatOrNull(pathname);
  if (stat === null) return false;
  if (stat.isSymbolicLink()) {
    fail(`${location} must not be a symlink`, 'IDEA_RUN_INPUT_SNAPSHOT_SYMLINK');
  }
  if (!stat.isDirectory()) {
    fail(`${location} must be a directory`, 'IDEA_RUN_INPUT_SNAPSHOT_INVALID_ROOT');
  }
  return true;
}

function ensureDirectory(pathname, location, {
  create = false,
  recursive = false,
} = {}) {
  if (assertDirectory(pathname, location)) return true;
  if (!create) return false;
  try {
    fs.mkdirSync(pathname, { recursive });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  return assertDirectory(pathname, location);
}

function assertRegularFile(pathname, location) {
  const stat = lstatOrNull(pathname);
  if (stat === null) return false;
  if (stat.isSymbolicLink()) {
    fail(`${location} must not be a symlink`, 'IDEA_RUN_INPUT_SNAPSHOT_SYMLINK');
  }
  if (!stat.isFile()) {
    fail(`${location} must be a regular file`, 'IDEA_RUN_INPUT_SNAPSHOT_CORRUPT');
  }
  return true;
}

export class FileIdeaRunInputSnapshotStore {
  constructor({ runsDir = IDEA_RUNS_DIR } = {}) {
    if (typeof runsDir !== 'string' || !runsDir) {
      throw new TypeError('FileIdeaRunInputSnapshotStore runsDir is required');
    }
    this.runsDir = path.resolve(runsDir);
    this.ideaGenerationDir = path.dirname(this.runsDir);
    this.dataDir = path.dirname(this.ideaGenerationDir);
  }

  create(input) {
    const candidate = buildSnapshot(input);
    const runDir = this.#runDir(candidate.runId, { create: true });
    const snapshotPath = path.join(runDir, 'input-snapshot.json');
    const lockPath = path.join(runDir, '.input-snapshot.lock');
    const lockStat = lstatOrNull(lockPath);
    if (lockStat?.isSymbolicLink()) {
      fail('IdeaRunInputSnapshot lock must not be a symlink', 'IDEA_RUN_INPUT_SNAPSHOT_SYMLINK');
    }
    if (lockStat && !lockStat.isDirectory() && !lockStat.isFile()) {
      fail('IdeaRunInputSnapshot lock must be a file or directory', 'IDEA_RUN_INPUT_SNAPSHOT_CORRUPT');
    }
    return withFileLockSync(lockPath, () => {
      this.#runDir(candidate.runId, { create: false });
      if (lstatOrNull(snapshotPath) !== null) {
        const current = this.load(candidate.runId);
        if (current.contentDigest !== candidate.contentDigest) {
          fail(
            `IdeaRunInputSnapshot already exists for ${candidate.runId} with different logical content`,
            'IDEA_RUN_INPUT_SNAPSHOT_CONFLICT',
          );
        }
        return current;
      }
      atomicCreateFileSync(snapshotPath, `${JSON.stringify(candidate, null, 2)}\n`);
      return this.load(candidate.runId);
    });
  }

  load(runId) {
    const safeRunId = assertSafeDirectChildId(runId, 'IdeaRunInputSnapshot.runId');
    const runDir = this.#runDir(safeRunId, { create: false });
    if (runDir === null) return null;
    const snapshotPath = path.join(runDir, 'input-snapshot.json');
    if (!assertRegularFile(snapshotPath, 'IdeaRunInputSnapshot file')) return null;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    } catch {
      fail('stored IdeaRunInputSnapshot is unreadable', 'IDEA_RUN_INPUT_SNAPSHOT_CORRUPT');
    }
    try {
      return validateStoredSnapshot(parsed, safeRunId);
    } catch (error) {
      if (error?.code === 'IDEA_RUN_INPUT_SNAPSHOT_SYMLINK') throw error;
      if (error?.code === 'IDEA_RUN_INPUT_SNAPSHOT_CORRUPT') throw error;
      throw snapshotError(
        `stored IdeaRunInputSnapshot is invalid: ${error?.message || error}`,
        'IDEA_RUN_INPUT_SNAPSHOT_CORRUPT',
      );
    }
  }

  list() {
    if (!this.#assertRootChain({ create: false })) return [];
    const snapshots = [];
    const directory = fs.opendirSync(this.runsDir);
    try {
      for (
        let entry = directory.readSync();
        entry !== null;
        entry = directory.readSync()
      ) {
        if (entry.isSymbolicLink()) {
          fail(
            `IdeaRunInputSnapshot runs root contains a symlink: ${entry.name}`,
            'IDEA_RUN_INPUT_SNAPSHOT_SYMLINK',
          );
        }
        if (!entry.isDirectory()) continue;
        const runId = assertSafeDirectChildId(
          entry.name,
          'IdeaRunInputSnapshot.runId',
        );
        const snapshot = this.load(runId);
        if (snapshot) snapshots.push(snapshot);
      }
    } finally {
      directory.closeSync();
    }
    return snapshots.sort((left, right) => (
      Date.parse(left.asOf) - Date.parse(right.asOf)
      || left.runId.localeCompare(right.runId)
    ));
  }

  resolve(runId, snapshotId) {
    assertNonEmptyString(snapshotId, 'IdeaRunInputSnapshot.snapshotId');
    const snapshot = this.load(runId);
    if (!snapshot) {
      fail(
        `IdeaRunInputSnapshot not found for ${runId}`,
        'IDEA_RUN_INPUT_SNAPSHOT_NOT_FOUND',
      );
    }
    if (snapshot.snapshotId !== snapshotId) {
      fail(
        `IdeaRunInputSnapshot identity mismatch for ${runId}`,
        'IDEA_RUN_INPUT_SNAPSHOT_IDENTITY_MISMATCH',
      );
    }
    return snapshot;
  }

  directory(runId, { create = false } = {}) {
    if (typeof create !== 'boolean') {
      throw new TypeError('IdeaRunInputSnapshot directory create must be boolean');
    }
    return this.#runDir(
      assertSafeDirectChildId(runId, 'IdeaRunInputSnapshot.runId'),
      { create },
    );
  }

  #runDir(runId, { create }) {
    assertSafeDirectChildId(runId, 'IdeaRunInputSnapshot.runId');
    if (!this.#assertRootChain({ create })) return null;
    const runDir = path.join(this.runsDir, runId);
    const relative = path.relative(this.runsDir, runDir);
    if (relative !== runId || relative.startsWith('..') || path.isAbsolute(relative)) {
      fail('IdeaRunInputSnapshot run path escaped its root', 'IDEA_RUN_INPUT_SNAPSHOT_UNSAFE_ID');
    }
    if (!assertDirectory(runDir, 'IdeaRunInputSnapshot run directory')) {
      if (!create) return null;
      fs.mkdirSync(runDir);
      assertDirectory(runDir, 'IdeaRunInputSnapshot run directory');
    }
    return runDir;
  }

  #assertRootChain({ create }) {
    if (!ensureDirectory(this.dataDir, 'IdeaRunInputSnapshot data root', {
      create,
      recursive: true,
    })) return false;
    if (!ensureDirectory(
      this.ideaGenerationDir,
      'IdeaRunInputSnapshot idea-generation root',
      { create },
    )) return false;
    return ensureDirectory(
      this.runsDir,
      'IdeaRunInputSnapshot runs root',
      { create },
    );
  }
}

export const ideaRunInputSnapshotStore = new FileIdeaRunInputSnapshotStore();
