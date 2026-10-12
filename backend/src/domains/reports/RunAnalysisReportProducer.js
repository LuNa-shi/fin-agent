import { ProjectSpace } from '../../project-space/ProjectSpace.js';
import { verifiedRunAnalysisReportPackage } from '../../project-space/runApiProjection.js';
import { reportContentDigest, normalizeInternalReportPackage } from './reportContracts.js';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function producerError(message, code = 'RUN_ANALYSIS_REPORT_PRODUCER_ERROR', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value) || value === '.' || value === '..') {
    throw producerError(`${label} is unsafe`, 'INVALID_REPORT_PRODUCER_ID');
  }
  return value;
}

function assertIso(value, label) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw producerError(`${label} must be a canonical ISO timestamp`, 'INVALID_REPORT_PRODUCER_TIMESTAMP');
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) {
    throw producerError(`${label} is required`, 'INVALID_REPORT_PRODUCER_METADATA');
  }
  return value.trim();
}

function latestDurableRun(projectSpace, projectId) {
  const runs = projectSpace.runStore(projectId).list();
  return runs.at(-1) || null;
}

function resolveDurableRun(projectSpace, projectId, runId) {
  if (runId !== null && runId !== undefined) {
    const id = assertSafeId(runId, 'analysis run id');
    const record = projectSpace.runStore(projectId).load(id);
    if (!record) throw producerError(`analysis run not found: ${id}`, 'REPORT_PRODUCER_RUN_NOT_FOUND', 404);
    return record;
  }
  const record = latestDurableRun(projectSpace, projectId);
  if (!record) throw producerError(`analysis run not found for project: ${projectId}`, 'REPORT_PRODUCER_RUN_NOT_FOUND', 404);
  return record;
}

function projectMetadata(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw producerError('project metadata is unavailable', 'REPORT_PRODUCER_PROJECT_METADATA_MISSING', 404);
  }
  if (!Array.isArray(meta.tickers) || meta.tickers.length === 0) {
    throw producerError('project metadata tickers are required', 'REPORT_PRODUCER_TICKERS_MISSING');
  }
  const theme = nonEmptyString(meta.theme, 'project metadata theme');
  const title = nonEmptyString(meta.title || meta.titleZh, 'project metadata title');
  const searchTags = Array.isArray(meta.searchTags) ? meta.searchTags : [];
  return { tickers: [...meta.tickers], theme, title, searchTags };
}

function workflowIdentity(record) {
  const workflow = record?.workflowSpec;
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw producerError('durable run workflow identity is unavailable', 'REPORT_PRODUCER_WORKFLOW_MISSING');
  }
  return {
    id: assertSafeId(workflow.id, 'workflow id'),
    version: nonEmptyString(workflow.version, 'workflow version'),
    hash: nonEmptyString(workflow.hash, 'workflow hash'),
  };
}

function verifiedPackageError(projectId, runId) {
  return producerError(
    `durable run does not have a verified published report: ${projectId}/${runId}`,
    'REPORT_PRODUCER_REPORT_NOT_VERIFIED',
    409,
  );
}

/**
 * Build the internal report handoff from the canonical, verified Run Analysis
 * publication gate. The ArtifactRef is provenance only; report bytes are read
 * from the content-addressed ArtifactStore object, never from reportRef.path.
 */
export function createVerifiedInternalReportPackage({
  projectId,
  runId = null,
  dailyReportRunId = null,
  projectSpace = ProjectSpace,
  requirePublishedMeta = true,
} = {}) {
  const id = assertSafeId(projectId, 'project id');
  if (!projectSpace || typeof projectSpace !== 'object') throw new TypeError('projectSpace is required');
  const meta = projectSpace.meta(id);
  if (!meta) throw producerError(`project not found: ${id}`, 'REPORT_PRODUCER_PROJECT_NOT_FOUND', 404);
  const record = resolveDurableRun(projectSpace, id, runId);
  if (record.status !== 'SUCCEEDED') {
    throw producerError(
      `analysis run is not successful: ${record.runId}`,
      'REPORT_PRODUCER_RUN_NOT_SUCCEEDED',
      409,
    );
  }

  const verified = verifiedRunAnalysisReportPackage(id, record, {
    projectSpace,
    requirePublishedMeta,
  });
  if (!verified) throw verifiedPackageError(id, record.runId);

  // Do not use verified.reportPath or any project filesystem path as authority.
  // ArtifactStore.read validates the complete ref against its durable manifest
  // and content-addressed object before returning the exact UTF-8 bytes.
  let markdown;
  try {
    markdown = projectSpace.artifactStore(id).read(verified.reportRef);
  } catch (cause) {
    const error = verifiedPackageError(id, record.runId);
    error.cause = cause;
    throw error;
  }
  if (typeof markdown !== 'string' || !markdown.trim()) {
    throw producerError('verified report content is empty', 'REPORT_PRODUCER_REPORT_CONTENT_INVALID');
  }
  if (reportContentDigest(markdown) !== verified.reportRef.contentDigest) {
    throw producerError('verified report content digest does not match ArtifactRef', 'REPORT_PRODUCER_DIGEST_MISMATCH', 409);
  }
  if (record.asOf !== verified.reportRef.asOf) {
    throw producerError('durable run asOf does not match report ArtifactRef asOf', 'REPORT_PRODUCER_PROVENANCE_MISMATCH', 409);
  }

  const metadata = projectMetadata(meta);
  const workflow = workflowIdentity(record);
  const packageInput = {
    contract: 'internal-run-analysis-report-package.v1',
    origin: 'internal',
    producer: {
      type: 'run-analysis',
      workflow,
      reportRef: verified.reportRef,
    },
    lineage: {
      projectId: id,
      analysisRunId: record.runId,
    },
    dailyReport: dailyReportRunId === null || dailyReportRunId === undefined
      ? null
      : { runId: assertSafeId(dailyReportRunId, 'daily report run id') },
    report: {
      mediaType: 'text/markdown',
      charset: 'utf-8',
      markdown,
      contentDigest: reportContentDigest(markdown),
    },
    metadata: {
      ...metadata,
      asOf: assertIso(record.asOf, 'durable run asOf'),
      generatedAt: assertIso(verified.reportRef.createdAt, 'report ArtifactRef createdAt'),
    },
  };
  return normalizeInternalReportPackage(packageInput);
}

export const produceRunAnalysisReportPackage = createVerifiedInternalReportPackage;
export const produceRunAnalysisReport = createVerifiedInternalReportPackage;

export class RunAnalysisReportProducer {
  constructor({ projectSpace = ProjectSpace, requirePublishedMeta = true } = {}) {
    if (!projectSpace || typeof projectSpace !== 'object') throw new TypeError('projectSpace is required');
    this.projectSpace = projectSpace;
    this.requirePublishedMeta = requirePublishedMeta;
  }

  produce({ projectId, runId = null, dailyReportRunId = null } = {}) {
    return createVerifiedInternalReportPackage({
      projectId,
      runId,
      dailyReportRunId,
      projectSpace: this.projectSpace,
      requirePublishedMeta: this.requirePublishedMeta,
    });
  }
}

export const createRunAnalysisReportProducer = (options = {}) => new RunAnalysisReportProducer(options);
