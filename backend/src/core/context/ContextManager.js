import { estimateTokens } from '../../lib/context.js';
import { matchesAnyPathPattern, normalizeSafeRelativePath } from '../policy/pathPolicy.js';

export const CONTEXT_DENIAL_REASONS = Object.freeze({
  INVALID_REFERENCE: 'invalid-context-reference',
  UNSAFE_PATH: 'unsafe-context-path',
  MOUNT: 'mount-not-allowed',
  SELECTOR: 'artifact-selector-mismatch',
  CROSS_PROJECT: 'cross-project-read-denied',
  PRIOR_REVIEW: 'prior-review-not-allowed',
  INLINE_BUDGET: 'inline-token-budget-exceeded',
});

export class ContextPermissionError extends Error {
  constructor(reason, details = {}) {
    super(`Context permission denied: ${reason}`);
    this.name = 'ContextPermissionError';
    this.code = 'CONTEXT_PERMISSION_DENIED';
    this.reason = reason;
    this.details = Object.freeze({ ...details });
  }
}

function stableSerialize(value, ancestors = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'bigint') return JSON.stringify(String(value));
  if (value === undefined) return '';
  if (typeof value !== 'object') return JSON.stringify(String(value));
  if (ancestors.has(value)) throw new TypeError('inline context payload must be acyclic');
  ancestors.add(value);
  let serialized;
  if (Array.isArray(value)) {
    serialized = `[${value.map((item) => stableSerialize(item, ancestors)).join(',')}]`;
  } else {
    serialized = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], ancestors)}`).join(',')}}`;
  }
  ancestors.delete(value);
  return serialized;
}

function mountedProjectPath(rawPath, policy) {
  const mounts = Array.isArray(policy.mounts) ? policy.mounts : [];
  let relativePath = rawPath;
  if (rawPath.startsWith('/')) {
    const mount = [...mounts]
      .filter((candidate) => typeof candidate === 'string' && (rawPath === candidate || rawPath.startsWith(`${candidate}/`)))
      .sort((left, right) => right.length - left.length)[0];
    if (!mount) throw new ContextPermissionError(CONTEXT_DENIAL_REASONS.MOUNT, { path: rawPath });
    relativePath = rawPath.slice(mount.length).replace(/^\/+/, '');
  } else if (!mounts.includes('/project')) {
    throw new ContextPermissionError(CONTEXT_DENIAL_REASONS.MOUNT, { path: rawPath, requiredMount: '/project' });
  }

  const safePath = normalizeSafeRelativePath(relativePath);
  if (!safePath) throw new ContextPermissionError(CONTEXT_DENIAL_REASONS.UNSAFE_PATH, { path: rawPath });
  if (!matchesAnyPathPattern(safePath, policy.artifactSelectors)) {
    throw new ContextPermissionError(CONTEXT_DENIAL_REASONS.SELECTOR, { path: safePath });
  }
  return safePath;
}

function assertProjectOwnership(projectId, request, policy, details) {
  const owner = projectId === undefined ? request.projectId : projectId;
  if (typeof owner !== 'string' || !owner.trim()) {
    throw new ContextPermissionError(CONTEXT_DENIAL_REASONS.INVALID_REFERENCE, details);
  }
  if (owner !== request.projectId && policy.allowCrossProjectRead !== true) {
    throw new ContextPermissionError(CONTEXT_DENIAL_REASONS.CROSS_PROJECT, { ...details, referencedProjectId: owner });
  }
}

function artifactPayload(reference, index, request, policy) {
  if (typeof reference === 'string') {
    if (!reference) throw new ContextPermissionError(CONTEXT_DENIAL_REASONS.INVALID_REFERENCE, { field: 'inputArtifactRefs', index });
    mountedProjectPath(reference, policy);
    return '';
  }
  if (!reference || typeof reference !== 'object' || Array.isArray(reference) || typeof reference.path !== 'string' || !reference.path) {
    throw new ContextPermissionError(CONTEXT_DENIAL_REASONS.INVALID_REFERENCE, { field: 'inputArtifactRefs', index });
  }
  assertProjectOwnership(reference.projectId, request, policy, { field: 'inputArtifactRefs', index, path: reference.path });
  mountedProjectPath(reference.path, policy);
  return Object.hasOwn(reference, 'content') ? stableSerialize(reference.content) : '';
}

function reviewPayload(issue, index, request, policy) {
  if (issue === null || issue === undefined || Array.isArray(issue) || (typeof issue !== 'string' && typeof issue !== 'object')) {
    throw new ContextPermissionError(CONTEXT_DENIAL_REASONS.INVALID_REFERENCE, { field: 'priorReviewIssues', index });
  }
  if (typeof issue === 'object') {
    assertProjectOwnership(issue.projectId, request, policy, { field: 'priorReviewIssues', index, path: issue.path });
    if (Object.hasOwn(issue, 'path')) {
      if (typeof issue.path !== 'string' || !issue.path) {
        throw new ContextPermissionError(CONTEXT_DENIAL_REASONS.INVALID_REFERENCE, { field: 'priorReviewIssues', index });
      }
      mountedProjectPath(issue.path, policy);
    }
  }
  return stableSerialize(issue);
}

export class ContextManager {
  constructor({ tokenEstimator = estimateTokens } = {}) {
    if (typeof tokenEstimator !== 'function') throw new TypeError('ContextManager tokenEstimator must be a function');
    this.tokenEstimator = tokenEstimator;
  }

  preflight(request, contract) {
    if (!request || typeof request !== 'object') throw new TypeError('ContextManager requires an AgentRunRequest');
    const policy = contract?.contextPolicy;
    if (!policy || typeof policy !== 'object') throw new TypeError('ContextManager requires a resolved contract contextPolicy');
    const artifacts = Array.isArray(request.inputArtifactRefs) ? request.inputArtifactRefs : [];
    const reviews = Array.isArray(request.priorReviewIssues) ? request.priorReviewIssues : [];
    if (reviews.length && policy.allowPriorReview !== true) {
      throw new ContextPermissionError(CONTEXT_DENIAL_REASONS.PRIOR_REVIEW, { count: reviews.length });
    }

    let inlineTokens = 0;
    try {
      for (let index = 0; index < artifacts.length; index += 1) {
        const payload = artifactPayload(artifacts[index], index, request, policy);
        if (payload) inlineTokens += this.tokenEstimator(payload);
      }
      for (let index = 0; index < reviews.length; index += 1) {
        inlineTokens += this.tokenEstimator(reviewPayload(reviews[index], index, request, policy));
      }
    } catch (error) {
      if (error instanceof ContextPermissionError) throw error;
      throw new ContextPermissionError(CONTEXT_DENIAL_REASONS.INVALID_REFERENCE, { message: error?.message || String(error) });
    }

    const maxInlineTokens = Number(policy.maxInlineTokens);
    if (!Number.isFinite(maxInlineTokens) || maxInlineTokens < 0) {
      throw new TypeError('contextPolicy.maxInlineTokens must be a non-negative finite number');
    }
    if (inlineTokens > maxInlineTokens) {
      throw new ContextPermissionError(CONTEXT_DENIAL_REASONS.INLINE_BUDGET, { inlineTokens, maxInlineTokens });
    }
    return Object.freeze({ artifactCount: artifacts.length, priorReviewCount: reviews.length, inlineTokens });
  }
}
