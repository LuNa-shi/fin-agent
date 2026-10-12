import fs from 'node:fs';
import path from 'node:path';

function storageError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function lstatOrNull(pathname) {
  try {
    return fs.lstatSync(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function ensureOwnedStorageDirectory(pathname, label, {
  create = false,
  recursive = false,
} = {}) {
  const stat = lstatOrNull(pathname);
  if (stat) {
    if (stat.isSymbolicLink()) {
      throw storageError(`${label} must not be a symlink`, 'STORAGE_DIRECTORY_SYMLINK');
    }
    if (!stat.isDirectory()) {
      throw storageError(`${label} must be a directory`, 'STORAGE_DIRECTORY_INVALID');
    }
    return true;
  }
  if (!create) return false;
  try {
    fs.mkdirSync(pathname, { recursive });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const created = lstatOrNull(pathname);
  if (created?.isSymbolicLink()) {
    throw storageError(`${label} must not be a symlink`, 'STORAGE_DIRECTORY_SYMLINK');
  }
  if (!created?.isDirectory()) {
    throw storageError(`${label} must be a directory`, 'STORAGE_DIRECTORY_INVALID');
  }
  return true;
}

export function resolveDirectStorageDirectory(storageDir, label) {
  if (typeof storageDir !== 'string' || !storageDir.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  const resolved = path.resolve(storageDir);
  if (!ensureOwnedStorageDirectory(resolved, label)) {
    throw storageError(`${label} does not exist`, 'STORAGE_DIRECTORY_NOT_FOUND');
  }
  return resolved;
}

export function assertStorageLockBoundary(lockDir, label) {
  const stat = lstatOrNull(lockDir);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw storageError(`${label} must not be a symlink`, 'STORAGE_LOCK_SYMLINK');
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    throw storageError(`${label} must be a file or directory`, 'STORAGE_LOCK_INVALID');
  }
}

export function assertOwnedStorageFile(pathname, label, { allowMissing = true } = {}) {
  const stat = lstatOrNull(pathname);
  if (!stat) {
    if (allowMissing) return false;
    throw storageError(`${label} does not exist`, 'STORAGE_FILE_NOT_FOUND');
  }
  if (stat.isSymbolicLink()) {
    throw storageError(`${label} must not be a symlink`, 'STORAGE_FILE_SYMLINK');
  }
  if (!stat.isFile()) {
    throw storageError(`${label} must be a regular file`, 'STORAGE_FILE_INVALID');
  }
  return true;
}
