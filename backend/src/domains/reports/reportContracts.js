import { createHash } from 'node:crypto';

import {
  ARTIFACT_REF_LOCATION_FIELDS,
  ARTIFACT_REF_REQUIRED_FIELDS,
  canonicalSha256,
  createArtifactRef,
  deepFreeze,
  validateArtifactRef,
} from '../../core/contracts/ArtifactRef.js';

export const INTERNAL_REPORT_PACKAGE_CONTRACT = 'internal-run-analysis-report-package.v1';
export const REPORT_VERSION_CONTRACT = 'report-version.v1';
export const REPORT_OVERVIEW_CONTRACT = 'report-overview.v1';
export const DAILY_REPORT_BATCH_CONTRACT = 'daily-report-batch.v1';
export const WORLDVIEW_PROCESSING_TRIGGER_CONTRACT = 'worldview-processing-trigger.v1';
export const BACKFILL_MANIFEST_CONTRACT = 'report-library-backfill-manifest.v1';
export const REPORT_LIBRARY_SCOPE = 'report-library';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const SAFE_TICKER_RE = /^[A-Z0-9][A-Z0-9._:-]{0,31}$/u;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PRODUCTION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const REPORT_REF_FIELDS = new Set([...ARTIFACT_REF_REQUIRED_FIELDS, ...ARTIFACT_REF_LOCATION_FIELDS]);

function reportError(message, code = 'INVALID_REPORT_PACKAGE', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertObject(value, label) {
  if (!isPlainObject(value)) throw reportError(`${label} must be an object`);
  return value;
}

function assertExactKeys(value, required, optional, label) {
  assertObject(value, label);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw reportError(`${label} contains unsupported fields: ${unknown.join(', ')}`);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) throw reportError(`${label} requires ${missing.join(', ')}`);
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value) || value === '.' || value === '..') {
    throw reportError(`${label} is unsafe`, 'INVALID_REPORT_ID');
  }
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    throw reportError(`${label} must be a sha256 digest`, 'INVALID_REPORT_DIGEST');
  }
  return value;
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw reportError(`${label} must be a canonical ISO timestamp`, 'INVALID_REPORT_TIMESTAMP');
  }
  return value;
}

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')}`;
}

function normalizeTicker(value) {
  if (typeof value !== 'string') throw reportError('ticker must be a string', 'INVALID_REPORT_TICKER');
  const ticker = value.trim().toUpperCase();
  if (!SAFE_TICKER_RE.test(ticker)) throw reportError(`ticker is invalid: ${value}`, 'INVALID_REPORT_TICKER');
  return ticker;
}

function normalizeStringArray(value, label, { max = 64 } = {}) {
  if (!Array.isArray(value) || value.length > max) throw reportError(`${label} must be an array`, 'INVALID_REPORT_METADATA');
  const values = value.map((item) => {
    if (typeof item !== 'string' || !item.trim() || item.includes('\u0000')) {
      throw reportError(`${label} contains an invalid value`, 'INVALID_REPORT_METADATA');
    }
    return item.trim();
  });
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function validateReportRef(ref) {
  const result = validateArtifactRef(ref);
  if (!result.valid) {
    throw reportError(`producer reportRef is invalid: ${result.errors.join('; ')}`, 'INVALID_REPORT_LINEAGE');
  }
  if (Object.keys(ref).some((field) => !REPORT_REF_FIELDS.has(field))) {
    throw reportError('producer reportRef contains unsupported fields', 'INVALID_REPORT_LINEAGE');
  }
  if (
    typeof ref.path !== 'string'
    || !ref.path
    || ref.path.includes('\\')
    || ref.path.includes('\u0000')
    || ref.path.startsWith('/')
    || ref.path.split('/').some((part) => !part || part === '..' || part === '.')
  ) {
    throw reportError('producer reportRef path is unsafe', 'INVALID_REPORT_LINEAGE');
  }
  return createArtifactRef(ref);
}

function normalizeWorkflow(workflow) {
  assertExactKeys(workflow, ['id', 'version', 'hash'], [], 'producer.workflow');
  assertSafeId(workflow.id, 'producer.workflow.id');
  if (typeof workflow.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(workflow.version)) {
    throw reportError('producer.workflow.version is invalid', 'INVALID_REPORT_PROVENANCE');
  }
  assertDigest(workflow.hash, 'producer.workflow.hash');
  return { id: workflow.id, version: workflow.version, hash: workflow.hash };
}

function normalizePackageShape(input) {
  assertExactKeys(
    input,
    ['contract', 'origin', 'producer', 'lineage', 'dailyReport', 'report', 'metadata'],
    [],
    'report package',
  );
  if (input.contract !== INTERNAL_REPORT_PACKAGE_CONTRACT) {
    throw reportError(`unsupported report package contract: ${input.contract}`, 'UNSUPPORTED_REPORT_CONTRACT');
  }
  if (input.origin !== 'internal') throw reportError('only internal report origin is supported', 'UNSUPPORTED_REPORT_ORIGIN');

  assertExactKeys(input.producer, ['type', 'workflow', 'reportRef'], [], 'producer');
  if (input.producer.type !== 'run-analysis') {
    throw reportError('report producer type must be run-analysis', 'INVALID_REPORT_PROVENANCE');
  }
  const producer = {
    type: input.producer.type,
    workflow: normalizeWorkflow(input.producer.workflow),
    reportRef: validateReportRef(input.producer.reportRef),
  };

  assertExactKeys(input.lineage, ['projectId', 'analysisRunId'], [], 'lineage');
  const lineage = {
    projectId: assertSafeId(input.lineage.projectId, 'lineage.projectId'),
    analysisRunId: assertSafeId(input.lineage.analysisRunId, 'lineage.analysisRunId'),
  };

  let dailyReport = null;
  if (input.dailyReport !== null) {
    assertExactKeys(input.dailyReport, ['runId'], [], 'dailyReport');
    dailyReport = { runId: assertSafeId(input.dailyReport.runId, 'dailyReport.runId') };
  }

  assertExactKeys(input.report, ['mediaType', 'charset', 'markdown', 'contentDigest'], [], 'report');
  if (input.report.mediaType !== 'text/markdown' || input.report.charset !== 'utf-8') {
    throw reportError('report must be UTF-8 Markdown', 'UNSUPPORTED_REPORT_FORMAT');
  }
  if (typeof input.report.markdown !== 'string' || !input.report.markdown.trim() || input.report.markdown.includes('\u0000')) {
    throw reportError('report Markdown must be non-empty text', 'INVALID_REPORT_CONTENT');
  }
  const contentDigest = assertDigest(input.report.contentDigest, 'report.contentDigest');
  if (digestBytes(input.report.markdown) !== contentDigest) {
    throw reportError('report content digest does not match exact Markdown bytes', 'REPORT_CONTENT_DIGEST_MISMATCH');
  }
  const report = {
    mediaType: input.report.mediaType,
    charset: input.report.charset,
    markdown: input.report.markdown,
    contentDigest,
  };

  assertExactKeys(input.metadata, ['tickers', 'theme', 'searchTags', 'title', 'asOf', 'generatedAt'], [], 'metadata');
  const tickers = normalizeStringArray(input.metadata.tickers, 'metadata.tickers', { max: 64 }).map(normalizeTicker);
  if (!tickers.length) throw reportError('metadata.tickers must contain at least one ticker', 'INVALID_REPORT_TICKER');
  const normalizedTickers = [...new Set(tickers)].sort();
  if (typeof input.metadata.theme !== 'string' || input.metadata.theme.length > 240 || input.metadata.theme.includes('\u0000')) {
    throw reportError('metadata.theme is invalid', 'INVALID_REPORT_METADATA');
  }
  if (typeof input.metadata.title !== 'string' || input.metadata.title.length > 240 || input.metadata.title.includes('\u0000')) {
    throw reportError('metadata.title is invalid', 'INVALID_REPORT_METADATA');
  }
  const metadata = {
    tickers: normalizedTickers,
    theme: input.metadata.theme.trim(),
    searchTags: normalizeStringArray(input.metadata.searchTags, 'metadata.searchTags'),
    title: input.metadata.title.trim(),
    asOf: assertIsoTimestamp(input.metadata.asOf, 'metadata.asOf'),
    generatedAt: assertIsoTimestamp(input.metadata.generatedAt, 'metadata.generatedAt'),
  };

  return {
    contract: INTERNAL_REPORT_PACKAGE_CONTRACT,
    origin: 'internal',
    producer,
    lineage,
    dailyReport,
    report,
    metadata,
  };
}

export function normalizeInternalReportPackage(input) {
  const normalized = normalizePackageShape(input);
  return deepFreeze(normalized);
}

export function reportContentDigest(markdown) {
  if (typeof markdown !== 'string') throw reportError('Markdown must be a string', 'INVALID_REPORT_CONTENT');
  return digestBytes(markdown);
}

export function reportLogicalIdentity(packageInput) {
  const input = normalizeInternalReportPackage(packageInput);
  return canonicalSha256({
    origin: input.origin,
    producerType: input.producer.type,
    workflow: input.producer.workflow,
    projectId: input.lineage.projectId,
    analysisRunId: input.lineage.analysisRunId,
  });
}

export function reportVersionId(packageInput) {
  return `report_${reportLogicalIdentity(packageInput).slice('sha256:'.length)}`;
}

export function reportIngestionId(packageInput) {
  return `ingest_${reportLogicalIdentity(packageInput).slice('sha256:'.length)}`;
}

export function reportVersionFingerprint(packageInput) {
  const input = normalizeInternalReportPackage(packageInput);
  return canonicalSha256(input);
}

function normalizeProductionDate(value) {
  if (typeof value !== 'string' || !PRODUCTION_DATE_RE.test(value)) {
    throw reportError('productionDate must be YYYY-MM-DD', 'INVALID_DAILY_REPORT_BATCH_DATE');
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw reportError('productionDate is invalid', 'INVALID_DAILY_REPORT_BATCH_DATE');
  }
  return value;
}

function normalizeDailyReportBatchItem(item, index) {
  assertExactKeys(item, ['itemId', 'projectId', 'sourceIdeaId'], [], `daily report batch items[${index}]`);
  return {
    itemId: assertSafeId(item.itemId, `daily report batch items[${index}].itemId`),
    projectId: assertSafeId(item.projectId, `daily report batch items[${index}].projectId`),
    sourceIdeaId: assertSafeId(item.sourceIdeaId, `daily report batch items[${index}].sourceIdeaId`),
  };
}

export function normalizeDailyReportBatchPlan(input) {
  assertExactKeys(
    input,
    ['contract', 'productionDate', 'producer', 'productionRunId', 'items'],
    [],
    'daily report batch',
  );
  if (input.contract !== DAILY_REPORT_BATCH_CONTRACT) {
    throw reportError(`unsupported daily report batch contract: ${input.contract}`, 'UNSUPPORTED_DAILY_REPORT_BATCH_CONTRACT');
  }
  assertExactKeys(input.producer, ['id'], [], 'daily report batch producer');
  const productionDate = normalizeProductionDate(input.productionDate);
  const producer = { id: assertSafeId(input.producer.id, 'daily report batch producer.id') };
  const productionRunId = assertSafeId(input.productionRunId, 'daily report batch productionRunId');
  if (!Array.isArray(input.items) || input.items.length > 100) {
    throw reportError('daily report batch items must be an array of at most 100 candidates', 'INVALID_DAILY_REPORT_BATCH_ITEMS');
  }
  const items = input.items.map(normalizeDailyReportBatchItem);
  if (new Set(items.map((item) => item.itemId)).size !== items.length) {
    throw reportError('daily report batch itemId values must be unique', 'INVALID_DAILY_REPORT_BATCH_ITEMS');
  }
  if (new Set(items.map((item) => item.projectId)).size !== items.length) {
    throw reportError('daily report batch projectId values must be unique', 'INVALID_DAILY_REPORT_BATCH_ITEMS');
  }
  return deepFreeze({
    contract: DAILY_REPORT_BATCH_CONTRACT,
    productionDate,
    producer,
    productionRunId,
    items,
  });
}

export function dailyReportBatchId({ productionDate, producerId } = {}) {
  const date = normalizeProductionDate(productionDate);
  const producer = assertSafeId(producerId, 'daily report batch producerId');
  const digest = canonicalSha256({
    contract: DAILY_REPORT_BATCH_CONTRACT,
    productionDate: date,
    producerId: producer,
  }).slice('sha256:'.length, 'sha256:'.length + 16);
  return `daily_batch_${date.replaceAll('-', '')}_${digest}`;
}

export function dailyReportBatchPlanFingerprint(input) {
  const plan = normalizeDailyReportBatchPlan(input);
  return canonicalSha256({
    contract: plan.contract,
    productionDate: plan.productionDate,
    producer: plan.producer,
    items: plan.items,
  });
}

function boundedText(value, label, { max = 4000 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000') || value.length > max) {
    throw reportError(`${label} is invalid`, 'INVALID_REPORT_OVERVIEW');
  }
  return value.trim();
}

function boundedTextArray(value, label, { maxItems = 32, maxText = 500 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw reportError(`${label} must be a bounded array`, 'INVALID_REPORT_OVERVIEW');
  }
  return value.map((item, index) => boundedText(item, `${label}[${index}]`, { max: maxText }));
}

export function normalizeReportOverviewContent(input) {
  assertExactKeys(
    input,
    ['reportVersionId', 'contentDigest', 'summary', 'keyThemes', 'entities', 'materialDevelopments', 'uncertainties'],
    [],
    'report overview',
  );
  if (!Array.isArray(input.entities) || input.entities.length > 64) {
    throw reportError('report overview entities must be a bounded array', 'INVALID_REPORT_OVERVIEW');
  }
  const entities = input.entities.map((entity, index) => {
    assertExactKeys(entity, ['name', 'type', 'tickers'], [], `report overview entities[${index}]`);
    return {
      name: boundedText(entity.name, `report overview entities[${index}].name`, { max: 240 }),
      type: boundedText(entity.type, `report overview entities[${index}].type`, { max: 80 }),
      tickers: boundedTextArray(entity.tickers, `report overview entities[${index}].tickers`, { maxItems: 32, maxText: 32 })
        .map(normalizeTicker),
    };
  });
  return deepFreeze({
    reportVersionId: assertSafeId(input.reportVersionId, 'report overview reportVersionId'),
    contentDigest: assertDigest(input.contentDigest, 'report overview contentDigest'),
    summary: boundedText(input.summary, 'report overview summary'),
    keyThemes: boundedTextArray(input.keyThemes, 'report overview keyThemes'),
    entities,
    materialDevelopments: boundedTextArray(input.materialDevelopments, 'report overview materialDevelopments'),
    uncertainties: boundedTextArray(input.uncertainties, 'report overview uncertainties'),
  });
}

export function reportOverviewId({ reportVersionId, contentDigest } = {}) {
  const id = assertSafeId(reportVersionId, 'report overview reportVersionId');
  const digest = assertDigest(contentDigest, 'report overview contentDigest');
  return `overview_${canonicalSha256({ contract: REPORT_OVERVIEW_CONTRACT, reportVersionId: id, contentDigest: digest }).slice('sha256:'.length)}`;
}

export function reportOverviewContentDigest(contentInput) {
  return canonicalSha256(normalizeReportOverviewContent(contentInput));
}

export function normalizeBackfillManifest(input) {
  assertExactKeys(input, ['contract', 'manifestId', 'asOf', 'items'], [], 'backfill manifest');
  if (input.contract !== BACKFILL_MANIFEST_CONTRACT) {
    throw reportError(`unsupported backfill manifest contract: ${input.contract}`, 'UNSUPPORTED_BACKFILL_CONTRACT');
  }
  const manifestId = assertSafeId(input.manifestId, 'backfill manifestId');
  const asOf = assertIsoTimestamp(input.asOf, 'backfill asOf');
  if (!Array.isArray(input.items) || input.items.length > 100_000) {
    throw reportError('backfill items must be a bounded array', 'INVALID_BACKFILL_MANIFEST');
  }
  const itemIds = new Set();
  const items = input.items.map((item, index) => {
    assertExactKeys(item, ['itemId', 'package', 'source'], [], `backfill items[${index}]`);
    const itemId = assertSafeId(item.itemId, `backfill items[${index}].itemId`);
    if (itemIds.has(itemId)) throw reportError(`duplicate backfill itemId: ${itemId}`, 'INVALID_BACKFILL_MANIFEST');
    itemIds.add(itemId);
    assertObject(item.package, `backfill items[${index}].package`);
    let source = null;
    if (item.source !== null) {
      assertExactKeys(item.source, ['relativePath', 'contentDigest'], [], `backfill items[${index}].source`);
      if (
        typeof item.source.relativePath !== 'string'
        || !item.source.relativePath
        || item.source.relativePath.includes('\\')
        || item.source.relativePath.includes('\u0000')
        || item.source.relativePath.startsWith('/')
        || item.source.relativePath.split('/').some((part) => !part || part === '..' || part === '.')
      ) {
        throw reportError(`backfill source path is unsafe: ${itemId}`, 'UNSAFE_BACKFILL_PATH');
      }
      source = {
        relativePath: item.source.relativePath,
        contentDigest: assertDigest(item.source.contentDigest, `backfill items[${index}].source.contentDigest`),
      };
    }
    return { itemId, package: structuredClone(item.package), source };
  });
  return deepFreeze({
    contract: BACKFILL_MANIFEST_CONTRACT,
    manifestId,
    asOf,
    items,
  });
}

export function backfillManifestDigest(manifestInput) {
  return canonicalSha256(normalizeBackfillManifest(manifestInput));
}

export const REPORT_CONTRACTS = Object.freeze({
  internalReportPackage: INTERNAL_REPORT_PACKAGE_CONTRACT,
  reportVersion: REPORT_VERSION_CONTRACT,
  reportOverview: REPORT_OVERVIEW_CONTRACT,
  dailyReportBatch: DAILY_REPORT_BATCH_CONTRACT,
  worldviewProcessingTrigger: WORLDVIEW_PROCESSING_TRIGGER_CONTRACT,
  backfillManifest: BACKFILL_MANIFEST_CONTRACT,
});
