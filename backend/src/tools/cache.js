import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, runtime } from '../config.js';

const CACHE_DIR = path.join(DATA_DIR, 'cache', 'tools');
// 缓存目录容量上限：超过后按 mtime 从旧到新淘汰（惰性触发，写入时低频检查）
const CACHE_MAX_BYTES = 500 * 1024 * 1024;
const EVICT_CHECK_EVERY = 200; // 每写入 N 次检查一次容量，避免频繁全目录扫描
let writesSinceCheck = 0;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function stable(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stable);
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
}
function cachePath(name, args) {
  const hash = crypto.createHash('sha1').update(JSON.stringify(stable(args || {}))).digest('hex');
  // demo 与 live 的数据不得互串：模拟数据一旦进入 live 缓存会污染分析与校准的 ground truth
  const mode = runtime.DEMO_MODE ? 'demo' : 'live';
  return path.join(CACHE_DIR, mode, name, `${hash}.json`);
}

// maxAgeHours 语义：
//   null/undefined → 该工具不使用缓存（读写都跳过）。永不过期必须显式传 Infinity。
//   数字           → 超龄失效。
export function readToolCache(name, args, { maxAgeHours = null } = {}) {
  if (maxAgeHours == null) return null;
  if (args?.forceRefresh) return null;
  const p = cachePath(name, args);
  try {
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Number.isFinite(maxAgeHours) && Date.now() - rec.ts > maxAgeHours * 3600000) return null;
    return { ...rec, cacheHit: true };
  } catch { return null; }
}

export function writeToolCache(name, args, result, { maxAgeHours = null } = {}) {
  if (maxAgeHours == null) return null; // 无 freshness 定义的工具不落缓存
  const p = cachePath(name, args);
  ensureDir(path.dirname(p));
  const rec = { ts: Date.now(), result };
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, p);
  if (++writesSinceCheck >= EVICT_CHECK_EVERY) { writesSinceCheck = 0; try { evictToBudget(); } catch { /* 淘汰失败不影响主链路 */ } }
  return rec;
}

// 按 mtime 从旧到新淘汰，直到目录总量低于预算
function evictToBudget(maxBytes = CACHE_MAX_BYTES) {
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { const st = fs.statSync(p); files.push({ p, size: st.size, mtime: st.mtimeMs }); } catch {} }
    }
  };
  walk(CACHE_DIR);
  let total = files.reduce((a, f) => a + f.size, 0);
  if (total <= maxBytes) return;
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (total <= maxBytes) break;
    try { fs.unlinkSync(f.p); total -= f.size; } catch {}
  }
}
