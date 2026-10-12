// Current file-backed Project / Project Space compatibility boundary.
// This object preserves the pre-Framework-1.1 ProjectFS behavior and artifact layout;
// immutable ArtifactStore, durable RunStore, and WorkspaceService are separate
// project-space services exposed through this compatibility object.
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, PROJECTS_DIR } from '../config.js';
import { normalizeSafeRelativePath } from '../core/policy/pathPolicy.js';
import { globalContentIndex } from '../core/persistence/GlobalContentIndex.js';
import { atomicWriteFileSync, withFileLockSync } from '../lib/fileLock.js';
import { FileArtifactStore } from './ArtifactStore.js';
import { FileEventBus } from './EventBus.js';
import { FileHumanReviewStore } from './HumanReviewStore.js';
import { FileRunStore } from './RunStore.js';
import { FileWorkspaceService, WorkspacePermissionError } from './WorkspaceService.js';
import { renderForecastReport } from './forecastReport.js';

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, value) {
  atomicWriteFileSync(file, JSON.stringify(value, null, 2));
}
function timestampForFile(ts = Date.now()) {
  const date = new Date(ts);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
const REPORT_LANGUAGE_TOKEN_RE = /^[a-z][a-z0-9-]{1,15}$/u;
const TIMESTAMPED_REPORT_NAME_RE = /^report_\d{8}_\d{6}(?:\.([a-z][a-z0-9-]{1,15}))?\.md$/u;
export function isTimestampedReportPath(value) {
  return typeof value === 'string'
    && value.startsWith('report/')
    && TIMESTAMPED_REPORT_NAME_RE.test(value.slice('report/'.length));
}
function normalizeReportLanguage(language) {
  const normalized = String(language || 'en').trim().toLowerCase();
  if (normalized === 'en') return normalized;
  if (!REPORT_LANGUAGE_TOKEN_RE.test(normalized)) {
    failProjectBoundary(`unsafe report language: ${String(language)}`, 'UNSAFE_PROJECT_PATH');
  }
  return normalized;
}
function failProjectBoundary(message, code = 'UNSAFE_PROJECT_ID') {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}
function assertSafeProjectId(id) {
  if (
    typeof id !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)
    || id === '.'
    || id === '..'
  ) {
    failProjectBoundary(`unsafe project id: ${id}`);
  }
  return id;
}
function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function assertDirectoryBoundary(directory, label, { create = false } = {}) {
  const resolved = path.resolve(directory);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!create) return false;
    fs.mkdirSync(resolved, { recursive: true });
    stat = fs.lstatSync(resolved);
  }
  if (stat.isSymbolicLink()) {
    failProjectBoundary(`${label} must not be a symlink: ${resolved}`, 'PROJECT_SYMLINK_DENIED');
  }
  if (!stat.isDirectory()) {
    failProjectBoundary(`${label} must be a directory: ${resolved}`, 'UNSAFE_PROJECT_PATH');
  }
  return true;
}
function assertProjectRoots({ create = false } = {}) {
  const dataExists = assertDirectoryBoundary(DATA_DIR, 'data root', { create });
  if (!dataExists) return false;
  return assertDirectoryBoundary(PROJECTS_DIR, 'projects root', { create });
}
function projectDir(id) {
  const safeId = assertSafeProjectId(id);
  assertProjectRoots();
  const root = path.resolve(PROJECTS_DIR);
  const target = path.resolve(root, safeId);
  if (path.dirname(target) !== root || !isInside(root, target)) {
    failProjectBoundary(`project path escapes configured root: ${id}`);
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    failProjectBoundary(`project folder must not be a symlink: ${id}`, 'PROJECT_SYMLINK_DENIED');
  }
  return target;
}
function allocateProjectDirectory() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = `proj_${Math.random().toString(36).slice(2, 9)}`;
    const directory = projectDir(id);
    try {
      fs.mkdirSync(directory);
      return { id, directory };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  failProjectBoundary(
    'unable to allocate a unique project id',
    'PROJECT_ID_ALLOCATION_FAILED',
  );
}
function resolveProjectPath(id, relativeName, { createParents = false } = {}) {
  const relative = normalizeSafeRelativePath(relativeName);
  if (!relative) {
    failProjectBoundary(`unsafe project content path: ${String(relativeName)}`, 'UNSAFE_PROJECT_PATH');
  }
  const root = projectDir(id);
  const target = path.resolve(root, relative);
  if (!isInside(root, target) || target === root) {
    failProjectBoundary(`project content path escapes project root: ${relative}`, 'UNSAFE_PROJECT_PATH');
  }

  const assertComponents = () => {
    let cursor = root;
    for (const segment of relative.split('/')) {
      cursor = path.join(cursor, segment);
      let stat;
      try {
        stat = fs.lstatSync(cursor);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        failProjectBoundary(
          `project content must not contain symlinks: ${relative}`,
          'PROJECT_SYMLINK_DENIED',
        );
      }
      if (cursor !== target && !stat.isDirectory()) {
        failProjectBoundary(
          `project content parent must be a directory: ${relative}`,
          'UNSAFE_PROJECT_PATH',
        );
      }
    }
  };

  assertComponents();
  if (createParents) {
    ensureDir(path.dirname(target));
    assertComponents();
  }
  return target;
}
function assertRegularProjectFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    failProjectBoundary(`project content must not be a symlink: ${label}`, 'PROJECT_SYMLINK_DENIED');
  }
  if (!stat.isFile()) {
    failProjectBoundary(`project content must be a regular file: ${label}`, 'UNSAFE_PROJECT_PATH');
  }
  return true;
}
function readProjectJSON(id, relativeName, fallback) {
  const file = resolveProjectPath(id, relativeName);
  if (!assertRegularProjectFile(file, relativeName)) return fallback;
  return readJSON(file, fallback);
}
function readProjectText(id, relativeName, fallback = '') {
  const file = resolveProjectPath(id, relativeName);
  if (!assertRegularProjectFile(file, relativeName)) return fallback;
  return fs.readFileSync(file, 'utf8');
}
function writeProjectJSON(id, relativeName, value) {
  const file = resolveProjectPath(id, relativeName, { createParents: true });
  writeJSON(file, value);
}
function writeProjectText(id, relativeName, value) {
  const file = resolveProjectPath(id, relativeName, { createParents: true });
  atomicWriteFileSync(file, value);
}
function assertProjectRecordIdentity(record, id) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.id !== id) {
    failProjectBoundary(`project metadata identity mismatch: ${id}`, 'PROJECT_IDENTITY_MISMATCH');
  }
  return record;
}
function refreshGlobalContentIndex() {
  try {
    return globalContentIndex.rebuild();
  } catch {
    // Project folders remain authoritative. A later index read deterministically repairs projection.
    return null;
  }
}
function safeProjectRel(name) {
  const rel = normalizeSafeRelativePath(String(name).replace(/\\/g, '/'));
  if (
    !rel
    || ['.artifacts', '.runs', '.workspace', '.events', '.human-review'].some((internal) => rel === internal || rel.startsWith(`${internal}/`))
  ) return null;
  return rel;
}
function normalizeContentName(name) {
  const relative = normalizeSafeRelativePath(name);
  if (!relative) {
    failProjectBoundary(`unsafe project content path: ${String(name)}`, 'UNSAFE_PROJECT_PATH');
  }
  return relative;
}

assertProjectRoots({ create: true });

const SUBDIRS = ['data', 'analysis', 'report'];

export const ProjectSpace = {
  dir(id) { return projectDir(id); },
  withCreationLock(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Project creation callback must be a function');
    }
    assertProjectRoots({ create: true });
    return withFileLockSync(path.join(DATA_DIR, '.project-creation.lock'), callback);
  },
  sub(id, name) {
    if (!SUBDIRS.includes(name)) {
      failProjectBoundary(`unknown project content root: ${name}`, 'UNSAFE_PROJECT_PATH');
    }
    return path.join(this.dir(id), name);
  },
  artifactStore(id) { projectDir(id); return new FileArtifactStore({ projectId: id, projectsDir: PROJECTS_DIR }); },
  eventBus(id) { projectDir(id); return new FileEventBus({ projectId: id, projectsDir: PROJECTS_DIR }); },
  humanReviewStore(id) { projectDir(id); return new FileHumanReviewStore({ projectId: id, projectsDir: PROJECTS_DIR }); },
  runStore(id) { projectDir(id); return new FileRunStore({ projectId: id, projectsDir: PROJECTS_DIR }); },
  workspace(id) { projectDir(id); return new FileWorkspaceService({ projectId: id, projectsDir: PROJECTS_DIR }); },
  activeRun(id) { return this.runStore(id).resumable(); },
  durableEvents(id, options) { return this.eventBus(id).list(options); },
  replayEvents(id, options) { return this.eventBus(id).replay(options); },

  list() {
    assertProjectRoots();
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((entry) => {
        if (entry.isSymbolicLink()) {
          failProjectBoundary(
            `project folder must not be a symlink: ${entry.name}`,
            'PROJECT_SYMLINK_DENIED',
          );
        }
        return entry.isDirectory();
      })
      .map((entry) => {
        const id = assertSafeProjectId(entry.name);
        const metaFile = path.join(projectDir(id), 'meta.json');
        if (!fs.existsSync(metaFile)) return null;
        if (fs.lstatSync(metaFile).isSymbolicLink()) {
          failProjectBoundary(
            `project metadata must not be a symlink: ${id}`,
            'PROJECT_SYMLINK_DENIED',
          );
        }
        const record = readJSON(metaFile, null);
        return record ? assertProjectRecordIdentity(record, id) : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  create(meta, { refreshIndex = true } = {}) {
    assertProjectRoots({ create: true });
    const { id, directory: dir } = allocateProjectDirectory();
    const createdAt = Date.now();
    for (const sd of SUBDIRS) fs.mkdirSync(path.join(dir, sd));
    const m = {
      tracking: false,
      intensity: meta.intensity || 'standard',
      // 分析模式：指定了标的=定向(targeted)，否则=发现型(discovery，先宽扫描再收敛到≤3深度分析)。
      mode: (Array.isArray(meta.tickers) && meta.tickers.filter(Boolean).length) ? 'targeted' : 'discovery',
      ...meta,
      id,
      status: 'created',
      createdAt,
      updatedAt: createdAt,
    };
    // 子目录初始占位
    writeProjectJSON(id, 'data/quotes.json', { quotes: [] });
    writeProjectJSON(id, 'analysis/plan.json', {});
    writeProjectText(id, 'report/report.md', `# ${m.title}\n\n_尚未分析。点击「运行分析」开始 agent loop。_\n`);
    writeProjectText(id, 'events.jsonl', '');
    writeProjectText(id, 'chat.jsonl', '');
    // meta.json is the authoritative Project anchor and is committed last.
    writeProjectJSON(id, 'meta.json', m);
    if (refreshIndex) refreshGlobalContentIndex();
    return m;
  },

  meta(id) {
    const record = readProjectJSON(id, 'meta.json', null);
    return record ? assertProjectRecordIdentity(record, id) : null;
  },
  updateMeta(id, patch) {
    const file = resolveProjectPath(id, 'meta.json');
    assertRegularProjectFile(file, 'meta.json');
    if (patch?.id !== undefined && patch.id !== id) {
      failProjectBoundary(`project metadata id is immutable: ${id}`, 'PROJECT_IDENTITY_MISMATCH');
    }
    const next = withFileLockSync(`${file}.lock`, () => {
      assertRegularProjectFile(file, 'meta.json');
      const current = readJSON(file, null); if (!current) return null;
      assertProjectRecordIdentity(current, id);
      const next = {
        ...current,
        ...patch,
        id,
        createdAt: current.createdAt,
        updatedAt: Date.now(),
      };
      writeJSON(file, next);
      return next;
    });
    if (next) refreshGlobalContentIndex();
    return next;
  },
  // 删除整个项目文件夹（含 data/analysis/report/events/chat）
  delete(id) {
    const dir = this.dir(id);
    if (!isInside(path.resolve(PROJECTS_DIR), dir) || dir === path.resolve(PROJECTS_DIR)) return false;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      refreshGlobalContentIndex();
      return true;
    } catch {
      return false;
    }
  },

  // ---- data 子目录 ----
  setDataFile(id, name, obj) { writeProjectJSON(id, `data/${normalizeContentName(name)}`, obj); },
  setDataText(id, name, text) {
    writeProjectText(id, `data/${normalizeContentName(name)}`, text);
  },
  // 累积式数据报告（data/data_report.md）：同轮重跑覆盖该轮章节，不同轮追加
  appendDataReport(id, sectionMd, round) {
    const p = resolveProjectPath(id, 'data/data_report.md', { createParents: true });
    assertRegularProjectFile(p, 'data/data_report.md');
    withFileLockSync(`${p}.lock`, () => {
      let cur = '';
      if (assertRegularProjectFile(p, 'data/data_report.md')) cur = fs.readFileSync(p, 'utf8');
      const marker = `## Round ${round} Data Report`;
      const idx = cur.indexOf(marker);
      const next = idx >= 0 ? cur.slice(0, idx) + sectionMd : (cur ? cur + '\n\n' + sectionMd : `# Data Report (for downstream analysis agents & human reading)\n\n${sectionMd}`);
      atomicWriteFileSync(p, next);
    });
  },
  dataReport(id) {
    return readProjectText(id, 'data/data_report.md');
  },
  // 兼容旧 API：data() 读取 quotes.json
  data(id) { return readProjectJSON(id, 'data/quotes.json', {}); },
  setData(id, d) { writeProjectJSON(id, 'data/quotes.json', d); },

  // ---- analysis 子目录（含子 agent 产物） ----
  setAnalysisFile(id, name, obj) { writeProjectJSON(id, `analysis/${normalizeContentName(name)}`, obj); },
  setAnalysisText(id, name, text) {
    writeProjectText(id, `analysis/${normalizeContentName(name)}`, text);
  },
  analysisFile(id, name) {
    return readProjectJSON(id, `analysis/${normalizeContentName(name)}`, null);
  },

  // ---- 断点续跑 checkpoint（analysis/checkpoint.json）----
  checkpoint(id) { return readProjectJSON(id, 'analysis/checkpoint.json', null); },
  setCheckpoint(id, cp) { writeProjectJSON(id, 'analysis/checkpoint.json', cp); },
  clearCheckpoint(id) {
    const file = resolveProjectPath(id, 'analysis/checkpoint.json');
    try {
      if (assertRegularProjectFile(file, 'analysis/checkpoint.json')) fs.unlinkSync(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  },

  // ---- report 子目录 ----
  reportVersions(id) {
    const dir = resolveProjectPath(id, 'report');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((file) => TIMESTAMPED_REPORT_NAME_RE.test(file) || file === 'report.md')
      .map((f) => {
        const p = resolveProjectPath(id, `report/${f}`);
        assertRegularProjectFile(p, `report/${f}`);
        const st = fs.lstatSync(p);
        const lang = TIMESTAMPED_REPORT_NAME_RE.exec(f)?.[1] || 'default';
        return { path: `report/${f}`, name: f, language: lang, generatedAt: st.mtimeMs, size: st.size, legacy: f === 'report.md' };
      })
      .sort((a, b) => b.generatedAt - a.generatedAt);
  },
  latestReportPath(id) {
    const m = this.meta(id);
    if (m?.latestReport) {
      const rel = normalizeSafeRelativePath(m.latestReport);
      if (!rel || !rel.startsWith('report/')) {
        failProjectBoundary(`unsafe latest report path: ${String(m.latestReport)}`, 'UNSAFE_PROJECT_PATH');
      }
      const file = resolveProjectPath(id, rel);
      if (assertRegularProjectFile(file, rel)) return rel;
    }
    return this.reportVersions(id)[0]?.path || 'report/report.md';
  },
  report(id) {
    return readProjectText(id, this.latestReportPath(id));
  },
  draftReport(id) {
    return readProjectText(id, 'report/report.md');
  },
  setReport(id, md) { writeProjectText(id, 'report/report.md', md); },
  setReportText(id, name, text) {
    writeProjectText(id, `report/${normalizeContentName(name)}`, text);
  },
  setTimestampedReport(id, md, { language = 'en', ts = Date.now(), translatedFrom = null } = {}) {
    const normalizedLanguage = normalizeReportLanguage(language);
    const suffix = normalizedLanguage !== 'en' ? `.${normalizedLanguage}` : '';
    const rel = `report/report_${timestampForFile(ts)}${suffix}.md`;
    writeProjectText(id, rel, md);
    const m = this.meta(id) || {};
    const reports = Array.isArray(m.reports) ? m.reports : this.reportVersions(id);
    const rec = {
      path: rel,
      language: normalizedLanguage,
      generatedAt: ts,
      translatedFrom,
    };
    const nextReports = [rec, ...reports.filter((r) => r.path !== rel)];
    this.updateMeta(id, { latestReport: translatedFrom ? m.latestReport : rel, reports: nextReports, reportGeneratedAt: ts });
    return rec;
  },

  // ---- forecast / round-quality inspection artifacts ----
  forecast(id) { return readProjectJSON(id, 'analysis/forecast.json', null); },
  setForecast(id, obj) {
    writeProjectJSON(id, 'analysis/forecast.json', obj);
    writeProjectText(id, 'report/forecast_report.md', renderForecastReport(obj));
    return obj;
  },
  commitArtifactFile(id, name, metadata = {}) {
    return this.commitArtifactFiles(id, [{ path: name, metadata }])[0];
  },
  commitArtifactFiles(id, items = []) {
    if (!Array.isArray(items)) throw new TypeError('artifact file batch must be an array');
    const inputs = items.map(({ path: name, metadata = {} }) => {
      const rel = safeProjectRel(name);
      if (!rel) throw new Error(`unsafe artifact path: ${name}`);
      const p = resolveProjectPath(id, rel);
      if (!assertRegularProjectFile(p, rel)) {
        const error = new Error(`artifact file missing: ${rel}`);
        error.code = 'ARTIFACT_FILE_MISSING';
        throw error;
      }
      return {
        ...metadata,
        artifactId: `${id}:${rel}`,
        path: rel,
        content: fs.readFileSync(p, 'utf8'),
      };
    });
    return this.artifactStore(id).commitMany(inputs);
  },
  artifactManifest(id) { return this.artifactStore(id).manifest(); },
  artifactHistory(id, artifactId) { return this.artifactStore(id).history(artifactId); },
  readArtifact(id, ref) { return this.artifactStore(id).read(ref); },
  artifactLineage(id, runId) { return this.artifactStore(id).lineageForRun(runId); },
  sourceManifest(id) { return readProjectJSON(id, 'data/source_manifest.json', null); },
  setSourceManifest(id, obj) { writeProjectJSON(id, 'data/source_manifest.json', obj); return obj; },
  toolCoverage(id) { return readProjectJSON(id, 'analysis/tool_coverage.json', null); },
  setToolCoverage(id, obj) { writeProjectJSON(id, 'analysis/tool_coverage.json', obj); return obj; },
  adaptorState(id) {
    const reviewFiles = (prefixDir, pattern) => {
      const dir = resolveProjectPath(id, prefixDir);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => pattern.test(f)).sort().map((f) => ({
        name: `${prefixDir}/${f}`,
        data: readProjectJSON(id, `${prefixDir}/${f}`, null),
      }));
    };
    return {
      data: {
        summary: this.fileContent(id, 'data/data_summary.md') || this.dataReport(id),
        reviews: reviewFiles('data', /^data_adaptor_review_round_\d+\.json$/),
      },
      industry: {
        summary: this.fileContent(id, 'analysis/industry_summary.md') || this.fileContent(id, 'analysis/industry_report.md'),
        reviews: reviewFiles('analysis', /^industry_adaptor_review_round_\d+\.json$/),
      },
      company: {
        summary: this.fileContent(id, 'analysis/company_summary.md') || this.fileContent(id, 'analysis/company_report.md'),
        reviews: reviewFiles('analysis', /^company_adaptor_review_round_\d+\.json$/),
      },
    };
  },

  // 事件流（agent 思考/工具调用过程）— append only
  appendEvent(id, ev) {
    const e = { ts: Date.now(), ...ev };
    const file = resolveProjectPath(id, 'events.jsonl');
    assertRegularProjectFile(file, 'events.jsonl');
    withFileLockSync(`${file}.lock`, () => fs.appendFileSync(file, JSON.stringify(e) + '\n'));
    return e;
  },
  events(id) {
    const p = resolveProjectPath(id, 'events.jsonl');
    if (!assertRegularProjectFile(p, 'events.jsonl')) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  },
  clearEvents(id) {
    const file = resolveProjectPath(id, 'events.jsonl');
    assertRegularProjectFile(file, 'events.jsonl');
    withFileLockSync(`${file}.lock`, () => atomicWriteFileSync(file, ''));
  },

  // 对话记录
  appendChat(id, msg) {
    const m = { ts: Date.now(), ...msg };
    const file = resolveProjectPath(id, 'chat.jsonl');
    assertRegularProjectFile(file, 'chat.jsonl');
    withFileLockSync(`${file}.lock`, () => fs.appendFileSync(file, JSON.stringify(m) + '\n'));
    return m;
  },
  chat(id) {
    const p = resolveProjectPath(id, 'chat.jsonl');
    if (!assertRegularProjectFile(p, 'chat.jsonl')) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  },

  // 递归列出项目文件夹内的「文件」用于前端展示（含子目录，相对路径）。
  // internal=true 的是内部产物（agent 工作痕迹/历史轮次/溢出缓存），前端默认折叠，不打扰用户；
  // 用户视角的交付物 = 最终报告、结论/推演/claims、数据报告、最新行业/公司报告。
  files(id) {
    const root = this.dir(id);
    if (!fs.existsSync(root)) return [];
    const INTERNAL = [
      /^analysis\/(spill|traces|adaptors|report)\//,          // 溢出全文/agent履历/记忆快照/agent中间笔记
      /^analysis\/checkpoint\.json$/,
      /^(events|chat)\.jsonl$/,
      /_r\d+\.(json|md)$/,                                     // 历史轮次产物（最新版另有无后缀文件）
      /adaptor_review_round_\d+\.json$/,
      /^data\/(organized|competitor_dossier)_r\d+\.json$/,
      /^analysis\/data_notes\.md$/,
      /^data\/(quotes|detail|highfreq|industry|source_manifest)\.json$/,
      /^analysis\/(tool_coverage|plan)\.json$/,
    ];
    const isInternal = (rel) => INTERNAL.some((re) => re.test(rel));
    const out = [];
    const walk = (abs, rel) => {
      for (const f of fs.readdirSync(abs)) {
        if (!rel && (f === '.artifacts' || f === '.runs' || f === '.workspace' || f === '.events' || f === '.human-review')) continue;
        const p = path.join(abs, f);
        const st = fs.lstatSync(p);
        const relPath = rel ? `${rel}/${f}` : f;
        if (st.isSymbolicLink()) {
          failProjectBoundary(
            `project content must not contain symlinks: ${relPath}`,
            'PROJECT_SYMLINK_DENIED',
          );
        }
        if (st.isDirectory()) { out.push({ name: relPath, dir: true, internal: isInternal(`${relPath}/`) }); walk(p, relPath); }
        else out.push({ name: relPath, size: st.size, mtime: st.mtimeMs, internal: isInternal(relPath) });
      }
    };
    walk(root, '');
    return out;
  },
  fileContent(id, name) {
    const rel = safeProjectRel(name);
    if (!rel) return null;
    try {
      return this.workspace(id).readText(`/project/${rel}`, { allowedMounts: ['/project'] });
    } catch (error) {
      if (error instanceof WorkspacePermissionError) return null;
      throw error;
    }
  },
};

// Compatibility name retained while callers move to the Project Space boundary.
export const ProjectFS = ProjectSpace;
