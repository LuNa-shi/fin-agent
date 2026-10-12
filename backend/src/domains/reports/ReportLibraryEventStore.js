import fs from 'node:fs';
import path from 'node:path';

import { canonicalSha256, canonicalStringify, deepFreeze } from '../../core/contracts/ArtifactRef.js';
import {
  assertOwnedStorageFile,
  ensureOwnedStorageDirectory,
  assertStorageLockBoundary,
} from '../../lib/storageBoundary.js';
import { atomicCreateFileSync, withFileLockSync } from '../../lib/fileLock.js';

export const REPORT_LIBRARY_EVENT_SCHEMA_VERSION = 'report-library-event.v1';
export const REPORT_LIBRARY_EVENT_TYPES = Object.freeze({
  REPORT_VERSION_ADMITTED: 'report-library.report-version.admitted',
  INGESTION_FAILED: 'report-library.ingestion.failed',
  DAILY_REPORT_BATCH_CREATED: 'report-library.daily-report-batch.created',
  DAILY_REPORT_BATCH_ITEM_COMPLETED: 'report-library.daily-report-batch.item-completed',
  DAILY_REPORT_BATCH_CLOSED: 'report-library.daily-report-batch.closed',
  WORLDVIEW_PROCESSING_TRIGGERED: 'report-library.worldview-processing.triggered',
  BACKFILL_STARTED: 'report-library.backfill.started',
  BACKFILL_ITEM_SUCCEEDED: 'report-library.backfill.item-succeeded',
  BACKFILL_ITEM_FAILED: 'report-library.backfill.item-failed',
  BACKFILL_RESUMED: 'report-library.backfill.resumed',
  BACKFILL_COMPLETED: 'report-library.backfill.completed',
});
const EVENT_TYPES = new Set(Object.values(REPORT_LIBRARY_EVENT_TYPES));
const EVENT_FILE_RE = /^(\d{12})\.json$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;

function fail(message, code = 'REPORT_LIBRARY_EVENT_ERROR', statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

function assertSafeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) fail(`${field} is unsafe`, 'INVALID_REPORT_EVENT_IDENTITY', 400);
}

function ensureDirectoryChain(rootDir, segments, { create = true } = {}) {
  const root = path.resolve(rootDir);
  let current = root;
  ensureOwnedStorageDirectory(current, 'Report Library root', { create });
  for (const segment of segments) {
    current = path.join(current, segment);
    ensureOwnedStorageDirectory(current, `Report Library directory ${segment}`, { create });
  }
  return current;
}

function eventFile(rootDir, sequence) {
  return path.join(rootDir, `${String(sequence).padStart(12, '0')}.json`);
}

function normalizeEvent(input, payload = input?.payload) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('event must be an object', 'INVALID_REPORT_EVENT', 400);
  const required = ['eventId', 'eventType', 'correlationId', 'causationId', 'runId', 'payload'];
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) fail(`event requires ${field}`, 'INVALID_REPORT_EVENT', 400);
  }
  assertSafeId(input.eventId, 'eventId');
  if (!EVENT_TYPES.has(input.eventType)) fail(`unsupported report library event type: ${input.eventType}`, 'UNKNOWN_REPORT_EVENT', 400);
  assertSafeId(input.correlationId, 'correlationId');
  assertSafeId(input.runId, 'runId');
  if (input.causationId !== null) assertSafeId(input.causationId, 'causationId');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('event payload must be an object', 'INVALID_REPORT_EVENT', 400);
  }
  return {
    eventId: input.eventId,
    eventType: input.eventType,
    schemaVersion: REPORT_LIBRARY_EVENT_SCHEMA_VERSION,
    scope: 'report-library',
    correlationId: input.correlationId,
    causationId: input.causationId,
    runId: input.runId,
    payload: structuredClone(payload),
  };
}

function readEvents(outboxDir) {
  if (!fs.existsSync(outboxDir)) return [];
  const names = fs.readdirSync(outboxDir).sort();
  const events = [];
  names.forEach((name, index) => {
    const match = EVENT_FILE_RE.exec(name);
    if (!match || Number(match[1]) !== index + 1) fail('Report Library event outbox is corrupt or gapped', 'CORRUPT_REPORT_EVENT_OUTBOX');
    const file = path.join(outboxDir, name);
    assertOwnedStorageFile(file, `Report Library event ${name}`, { allowMissing: false });
    let event;
    try { event = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`Report Library event ${name} is invalid`, 'CORRUPT_REPORT_EVENT_OUTBOX'); }
    events.push(event);
  });
  return events;
}

export function reportLibraryEventId(eventType, identity) {
  if (!EVENT_TYPES.has(eventType)) fail(`unsupported report library event type: ${eventType}`, 'UNKNOWN_REPORT_EVENT', 400);
  return `rle_${canonicalSha256({ eventType, identity }).slice('sha256:'.length)}`;
}

export class ReportLibraryEventStore {
  static scope = 'report-library';

  constructor({ rootDir, now = () => new Date().toISOString() } = {}) {
    if (typeof rootDir !== 'string' || !rootDir.trim()) throw new TypeError('Report Library event root is required');
    if (typeof now !== 'function') throw new TypeError('Report Library event clock is required');
    this.rootDir = path.resolve(rootDir);
    this.outboxDir = path.join(this.rootDir, 'events', 'outbox');
    this.lockPath = path.join(this.rootDir, 'events', '.locks', 'outbox.lock');
    this.now = now;
  }

  publish(input) {
    const payloadFactory = typeof input?.payload === 'function' ? input.payload : null;
    if (payloadFactory === null) normalizeEvent(input);
    else normalizeEvent(input, {});
    ensureDirectoryChain(this.rootDir, ['events', 'outbox'], { create: true });
    ensureDirectoryChain(this.rootDir, ['events', '.locks'], { create: true });
    assertStorageLockBoundary(this.lockPath, 'Report Library event lock');
    return withFileLockSync(this.lockPath, () => {
      const events = readEvents(this.outboxDir);
      const existing = events.find((event) => event.eventId === input.eventId);
      if (existing) {
        const payload = payloadFactory
          ? payloadFactory({ sequence: existing.sequence, timestamp: existing.timestamp })
          : input.payload;
        const candidate = normalizeEvent(input, payload);
        const replayComparable = ({ timestamp: _timestamp, sequence: _sequence, schemaVersion: _schemaVersion, ...event }) => event;
        if (canonicalStringify(replayComparable(existing)) !== canonicalStringify(replayComparable(candidate))) {
          fail(`Report Library event idempotency conflict: ${candidate.eventId}`, 'REPORT_EVENT_IDEMPOTENCY_CONFLICT', 409);
        }
        return deepFreeze(existing);
      }
      const sequence = events.length + 1;
      const timestamp = this.now();
      const payload = payloadFactory ? payloadFactory({ sequence, timestamp }) : input.payload;
      const candidate = normalizeEvent(input, payload);
      if (candidate.causationId !== null && !events.some((event) => event.eventId === candidate.causationId)) {
        fail(`Report Library event causation is missing: ${candidate.causationId}`, 'REPORT_EVENT_CAUSATION_MISSING', 409);
      }
      const event = {
        ...candidate,
        timestamp,
        sequence,
      };
      atomicCreateFileSync(eventFile(this.outboxDir, sequence), `${canonicalStringify(event)}\n`);
      return deepFreeze(event);
    });
  }

  list() {
    ensureDirectoryChain(this.rootDir, ['events', 'outbox'], { create: true });
    return deepFreeze(readEvents(this.outboxDir));
  }

  get(eventId) {
    assertSafeId(eventId, 'eventId');
    return this.list().find((event) => event.eventId === eventId) || null;
  }
}
