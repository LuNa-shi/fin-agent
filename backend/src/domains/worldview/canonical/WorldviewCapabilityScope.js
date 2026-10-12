import fs from 'node:fs';
import path from 'node:path';

import { canonicalStringify, deepFreeze } from '../../../core/contracts/ArtifactRef.js';
import { ensureOwnedStorageDirectory } from '../../../lib/storageBoundary.js';
import {
  canonicalDocumentDigest,
  canonicalWorldviewSafeId,
  canonicalWorldviewTimestamp,
} from './canonicalWorldviewContracts.js';

export const WORLDVIEW_CAPABILITY_TOOLS = Object.freeze([
  'worldview_read_current',
  'worldview_enumerate_overviews',
  'worldview_read_report_version',
  'worldview_search_claims',
]);

const activeScopes = new Map();

function fail(message, code = 'WORLDVIEW_CAPABILITY_DENIED', statusCode = 403) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

function clone(value) {
  return structuredClone(value);
}

function publicOverview(item) {
  return {
    ordinal: item.ordinal,
    admissionSequence: item.admissionSequence,
    reportVersionId: item.reportVersionId,
    contentDigest: item.contentDigest,
    fingerprint: item.fingerprint,
    overviewId: item.overviewId,
    overviewDigest: item.overviewDigest,
    overviewContentDigest: item.overviewContentDigest,
    overview: clone(item.overview),
  };
}

export class WorldviewCapabilityScope {
  constructor({ scopeId, runId, manifest, frozenCurrent, reportLibrary, tracePath, now = () => new Date().toISOString(), claimReader = null } = {}) {
    this.scopeId = canonicalWorldviewSafeId(scopeId, 'scopeId');
    this.runId = canonicalWorldviewSafeId(runId, 'runId');
    if (!manifest || !Array.isArray(manifest.items)) throw new TypeError('WorldviewCapabilityScope manifest is required');
    if (!reportLibrary || typeof reportLibrary.get !== 'function' || typeof reportLibrary.readContent !== 'function') {
      throw new TypeError('WorldviewCapabilityScope reportLibrary is required');
    }
    if (typeof tracePath !== 'string' || !tracePath.trim()) throw new TypeError('WorldviewCapabilityScope tracePath is required');
    this.manifest = manifest;
    this.frozenCurrent = frozenCurrent ? clone(frozenCurrent) : null;
    this.reportLibrary = reportLibrary;
    this.tracePath = path.resolve(tracePath);
    this.now = now;
    this.claimReader = typeof claimReader === 'function' ? claimReader : () => [];
    ensureOwnedStorageDirectory(path.dirname(this.tracePath), 'Worldview capability trace directory', { create: true, recursive: true });
    this.events = fs.existsSync(this.tracePath)
      ? fs.readFileSync(this.tracePath, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
      : [];
    if (this.events.some((event) => event.runId !== this.runId || event.scopeId !== this.scopeId)) {
      fail('Worldview capability trace belongs to a different frozen run', 'WORLDVIEW_CAPABILITY_TRACE_CONFLICT', 409);
    }
    this.reportItems = new Map(manifest.items.map((item) => [item.reportVersionId, item]));
  }

  activate() {
    const existing = activeScopes.get(this.scopeId);
    if (existing && existing !== this) fail('Worldview capability scope identity conflict', 'WORLDVIEW_CAPABILITY_SCOPE_CONFLICT', 409);
    activeScopes.set(this.scopeId, this);
    return () => {
      if (activeScopes.get(this.scopeId) === this) activeScopes.delete(this.scopeId);
    };
  }

  authorizeTool({ toolName, args } = {}) {
    if (!WORLDVIEW_CAPABILITY_TOOLS.includes(toolName)) fail(`Capability ${toolName} is not approved for this run`);
    if (args?.scopeId !== this.scopeId) fail('Worldview capability scopeId does not match the frozen run');
    if (toolName === 'worldview_read_report_version' && !this.reportItems.has(args?.reportVersionId)) {
      fail(`ReportVersion ${args?.reportVersionId || '(missing)'} is outside the frozen Report Library range`);
    }
    return true;
  }

  enumerateOverviews() {
    const values = this.manifest.items.map(publicOverview);
    this.#trace('worldview_enumerate_overviews', {
      overviewCount: values.length,
      overviewIds: values.map((item) => item.overviewId),
      reportVersionIds: values.map((item) => item.reportVersionId),
    });
    return deepFreeze(values);
  }

  readCurrentWorldview() {
    if (!this.frozenCurrent) fail('No frozen current Worldview exists for this bootstrap run', 'WORLDVIEW_CURRENT_NOT_FOUND', 404);
    this.#trace('worldview_read_current', {
      versionId: this.frozenCurrent.versionId,
      packageDigest: this.frozenCurrent.packageDigest,
    });
    return deepFreeze(clone(this.frozenCurrent));
  }

  readReportVersion(reportVersionId) {
    const id = canonicalWorldviewSafeId(reportVersionId, 'reportVersionId');
    const item = this.reportItems.get(id);
    if (!item) fail(`ReportVersion ${id} is outside the frozen Report Library range`);
    const report = this.reportLibrary.get(id);
    if (!report || report.contentDigest !== item.contentDigest || report.fingerprint !== item.fingerprint) {
      fail(`ReportVersion ${id} identity changed after freeze`, 'WORLDVIEW_REPORT_IDENTITY_MISMATCH', 409);
    }
    const markdown = this.reportLibrary.readContent(id);
    if (markdown === null || canonicalDocumentDigest(Buffer.from(markdown, 'utf8')) !== item.contentDigest) {
      fail(`ReportVersion ${id} content digest verification failed`, 'WORLDVIEW_REPORT_CONTENT_MISMATCH', 409);
    }
    this.#trace('worldview_read_report_version', {
      reportVersionId: id,
      contentDigest: item.contentDigest,
      byteLength: Buffer.byteLength(markdown, 'utf8'),
      verified: true,
    });
    return deepFreeze({
      reportVersionId: id,
      contentDigest: item.contentDigest,
      fingerprint: item.fingerprint,
      admissionSequence: item.admissionSequence,
      metadata: {
        title: report.title,
        tickers: clone(report.tickers),
        theme: report.theme,
        asOf: report.asOf,
        generatedAt: report.generatedAt,
        lineage: clone(report.lineage),
      },
      markdown,
      verified: true,
    });
  }

  searchClaims(query = '') {
    const result = this.claimReader({ query: String(query || ''), runId: this.runId });
    const claims = Array.isArray(result) ? result : [];
    this.#trace('worldview_search_claims', { queryLength: String(query || '').length, resultCount: claims.length });
    return deepFreeze({ schemaVersion: 'approved-claim-surface.v1', claims: clone(claims) });
  }

  trace() {
    return deepFreeze(this.events.map(clone));
  }

  selectedFullReads() {
    const unique = new Map();
    for (const event of this.events) {
      if (event.capability !== 'worldview_read_report_version') continue;
      unique.set(event.reportVersionId, {
        reportVersionId: event.reportVersionId,
        contentDigest: event.contentDigest,
        byteLength: event.byteLength,
        verified: true,
      });
    }
    return deepFreeze([...unique.values()]);
  }

  overviewEnumerationComplete() {
    const event = this.events.find((item) => item.capability === 'worldview_enumerate_overviews');
    if (!event) return false;
    return canonicalStringify(event.overviewIds) === canonicalStringify(this.manifest.items.map((item) => item.overviewId));
  }

  currentWorldviewRead() {
    return this.events.some((item) => item.capability === 'worldview_read_current');
  }

  #trace(capability, payload) {
    const event = {
      contract: 'worldview-capability-trace.v1',
      sequence: this.events.length + 1,
      runId: this.runId,
      scopeId: this.scopeId,
      capability,
      at: canonicalWorldviewTimestamp(this.now(), 'capability trace timestamp'),
      ...clone(payload),
    };
    this.events.push(event);
    fs.appendFileSync(this.tracePath, `${canonicalStringify(event)}\n`, 'utf8');
    return event;
  }
}

export function runWorldviewCapabilityTool(toolName, args = {}) {
  const scopeId = canonicalWorldviewSafeId(args.scopeId, 'scopeId');
  const scope = activeScopes.get(scopeId);
  if (!scope) fail('Worldview capability scope is not active');
  scope.authorizeTool({ toolName, args });
  if (toolName === 'worldview_enumerate_overviews') return scope.enumerateOverviews();
  if (toolName === 'worldview_read_current') return scope.readCurrentWorldview();
  if (toolName === 'worldview_read_report_version') return scope.readReportVersion(args.reportVersionId);
  if (toolName === 'worldview_search_claims') return scope.searchClaims(args.query || '');
  fail(`Unknown Worldview capability: ${toolName}`);
}
