import { normalizeSafeRelativePath } from '../core/policy/pathPolicy.js';
import { ProjectSpace } from './ProjectSpace.js';

const WRITABLE_PREFIX = /^(data|analysis|report)\//;

function safeRel(name = '') {
  return normalizeSafeRelativePath(String(name)) || '';
}

export function searchProjectLibrary({ currentProjectId, query = '', limit = 8 } = {}) {
  const q = String(query || '').toLowerCase();
  const rows = [];
  for (const p of ProjectSpace.list()) {
    if (!q || `${p.title} ${p.theme || ''} ${p.industryView || ''} ${p.conclusion?.summary || ''}`.toLowerCase().includes(q)) {
      rows.push({
        id: p.id,
        current: p.id === currentProjectId,
        title: p.title,
        status: p.status,
        analyzedAt: p.analyzedAt || null,
        summary: p.conclusion?.summary || p.industryView || '',
        latestReport: p.latestReport || null,
      });
    }
    if (rows.length >= limit) break;
  }
  return { rows };
}

export function readProjectFile({ projectId, file } = {}) {
  if (!projectId || !file) throw new Error('projectId and file required');
  return { projectId, file: safeRel(file), content: ProjectSpace.fileContent(projectId, file) };
}

export function writeCurrentProjectFile({ currentProjectId, projectId, file, content = '' } = {}) {
  if (!currentProjectId || !projectId || currentProjectId !== projectId) throw new Error('write denied: subagents may only write the current project');
  const rel = safeRel(file);
  if (!WRITABLE_PREFIX.test(rel)) throw new Error('write denied: file must be under data/, analysis/, or report/');
  ProjectSpace.workspace(projectId).writeText(`/project/${rel}`, String(content), { allowedMounts: ['/project'] });
  return { ok: true, projectId, file: rel };
}

export function appendCurrentProjectFile({ currentProjectId, projectId, file, content = '' } = {}) {
  if (!currentProjectId || !projectId || currentProjectId !== projectId) throw new Error('write denied: subagents may only write the current project');
  const rel = safeRel(file);
  if (!WRITABLE_PREFIX.test(rel)) throw new Error('write denied: file must be under data/, analysis/, or report/');
  ProjectSpace.workspace(projectId).appendText(`/project/${rel}`, String(content), {
    allowedMounts: ['/project'],
    separator: '\n\n',
  });
  return { ok: true, projectId, file: rel };
}

// ---- M2 workspace 工具：像 coding agent 读代码库一样读项目库 ----
// 「接近无上限」的机制：不是把所有内容塞进一个 prompt，而是 agent 用 ws_read_file 分页多次翻阅，
// 由预算系统兜底总量。单页上限 ~24k 字符（≈8k token）。
const READ_PAGE_CHARS = 24000;

// 项目文件树（含大小），相当于 repo map。dirs 省略，只列文件。
export function listProjectFiles({ projectId } = {}) {
  if (!projectId) throw new Error('projectId required');
  const files = ProjectSpace.files(projectId)
    .filter((f) => !f.dir)
    .map((f) => ({ file: f.name, bytes: f.size, modified: f.mtime ? new Date(f.mtime).toISOString().slice(0, 16) : null }));
  return { projectId, count: files.length, files };
}

// 分页读文件：offset/limit 以字符计。返回 nextOffset 供继续翻页；截断显式标注。
export function readProjectFilePaged({ projectId, file, offset = 0, limit = READ_PAGE_CHARS } = {}) {
  if (!projectId || !file) throw new Error('projectId and file required');
  const content = ProjectSpace.fileContent(projectId, file);
  if (content == null) return { projectId, file: safeRel(file), error: 'file not found' };
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.min(Math.max(1, Number(limit) || READ_PAGE_CHARS), READ_PAGE_CHARS);
  const chunk = content.slice(off, off + lim);
  const nextOffset = off + chunk.length;
  return {
    projectId, file: safeRel(file),
    offset: off, totalChars: content.length,
    content: chunk,
    truncated: nextOffset < content.length,
    nextOffset: nextOffset < content.length ? nextOffset : null,
  };
}

// 精确字符串替换（coding agent 的 Edit 语义）：报告/产物局部修改，不再整文件重写。
export function editCurrentProjectFile({ currentProjectId, projectId, file, oldText = '', newText = '', replaceAll = false } = {}) {
  if (!currentProjectId || !projectId || currentProjectId !== projectId) throw new Error('edit denied: subagents may only edit the current project');
  const rel = safeRel(file);
  if (!WRITABLE_PREFIX.test(rel)) throw new Error('edit denied: file must be under data/, analysis/, or report/');
  ProjectSpace.workspace(projectId).editText(`/project/${rel}`, {
    oldText,
    newText,
    replaceAll,
  }, { allowedMounts: ['/project'] });
  return { ok: true, projectId, file: rel };
}
