import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function moveIfExists(src, archiveRoot, rel) {
  if (!exists(src)) return false;
  const dest = path.join(archiveRoot, rel);
  ensureDir(path.dirname(dest));
  fs.renameSync(src, dest);
  return true;
}

function writeJSON(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

ensureDir(DATA_DIR);
ensureDir(MEMORY_DIR);

const archiveRoot = path.join(DATA_DIR, 'archive', stamp());
ensureDir(archiveRoot);

const moved = [];
const move = (src, rel) => {
  if (moveIfExists(src, archiveRoot, rel)) moved.push(rel);
};

move(PROJECTS_DIR, 'projects');
move(path.join(DATA_DIR, 'state.json'), 'state.json');
move(path.join(MEMORY_DIR, 'idea-traces.jsonl'), 'memory/idea-traces.jsonl');
move(path.join(MEMORY_DIR, 'world-traces.jsonl'), 'memory/world-traces.jsonl');
move(path.join(MEMORY_DIR, 'world-engine.json'), 'memory/world-engine.json');
move(path.join(MEMORY_DIR, 'llm-ledger.jsonl'), 'memory/llm-ledger.jsonl');
move(path.join(MEMORY_DIR, 'llm-ledger.jsonl.1'), 'memory/llm-ledger.jsonl.1');
move(path.join(MEMORY_DIR, 'tool-health.json'), 'memory/tool-health.json');

ensureDir(PROJECTS_DIR);
ensureDir(MEMORY_DIR);
writeJSON(path.join(DATA_DIR, 'state.json'), { ideas: [], portfolio: [], reflections: [] });
writeJSON(path.join(MEMORY_DIR, 'world-engine.json'), { lessons: [], simulations: 0, deliberations: 0, hitRate: null });
fs.writeFileSync(path.join(MEMORY_DIR, 'idea-traces.jsonl'), '');
fs.writeFileSync(path.join(MEMORY_DIR, 'world-traces.jsonl'), '');
fs.writeFileSync(path.join(MEMORY_DIR, 'llm-ledger.jsonl'), '');
writeJSON(path.join(MEMORY_DIR, 'tool-health.json'), { tools: {}, providers: {}, updatedAt: Date.now() });

console.log(JSON.stringify({
  ok: true,
  archive: archiveRoot,
  moved,
  preserved: [
    'data/settings.json',
    'data/templates.json',
    'data/research-sources.json',
    'data/memory/edgar-ciks.json',
  ],
}, null, 2));
