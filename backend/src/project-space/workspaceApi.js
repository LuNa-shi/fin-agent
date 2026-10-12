import path from 'node:path';

import { normalizeSafeRelativePath } from '../core/policy/pathPolicy.js';
import { listProjectFiles, readProjectFilePaged } from './projectTools.js';

export const WORKSPACE_CONTENT_SCHEMA_VERSION = 'workspace-content.v1';
export const WORKSPACE_TREE_SCHEMA_VERSION = 'workspace-tree.v1';
export const WORKSPACE_VISIBLE_ROOTS = Object.freeze(['data', 'analysis', 'report']);

const VISIBLE_ROOT_SET = new Set(WORKSPACE_VISIBLE_ROOTS);
const RUNTIME_OWNED_PATHS = Object.freeze([
  /^analysis\/checkpoint\.json$/u,
  /^analysis\/human-reviews(?:\/|$)/u,
]);

function isRuntimeOwnedWorkspacePath(file) {
  return RUNTIME_OWNED_PATHS.some((pattern) => pattern.test(file));
}

function isVisibleWorkspaceFile(file) {
  const [root, ...rest] = String(file || '').split('/');
  return VISIBLE_ROOT_SET.has(root)
    && rest.some(Boolean)
    && !isRuntimeOwnedWorkspacePath(file);
}

function workspaceError(message, code = 'WORKSPACE_PATH_DENIED', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export function normalizeWorkspaceContentPath(value) {
  const normalized = normalizeSafeRelativePath(String(value || '').replace(/\\/gu, '/'));
  if (!normalized || !isVisibleWorkspaceFile(normalized)) {
    throw workspaceError(
      'workspace content path must be a public file under data/, analysis/, or report/',
    );
  }
  return normalized;
}

export function listWorkspaceFiles({ projectId } = {}) {
  const listed = listProjectFiles({ projectId });
  const files = listed.files
    .filter((entry) => isVisibleWorkspaceFile(entry.file))
    .map((entry) => ({
      ...entry,
      area: entry.file.split('/')[0],
      extension: path.extname(entry.file).slice(1).toLowerCase() || null,
    }));
  return {
    schemaVersion: WORKSPACE_TREE_SCHEMA_VERSION,
    projectId,
    roots: [...WORKSPACE_VISIBLE_ROOTS],
    count: files.length,
    files,
  };
}

export function readWorkspaceContentPaged({ projectId, file, offset = 0, limit } = {}) {
  const normalized = normalizeWorkspaceContentPath(file);
  const page = readProjectFilePaged({ projectId, file: normalized, offset, limit });
  return {
    schemaVersion: WORKSPACE_CONTENT_SCHEMA_VERSION,
    ...page,
  };
}
