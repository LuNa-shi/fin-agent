import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR, runtime } from '../config.js';

const HEALTH_FILE = path.join(MEMORY_DIR, 'tool-health.json');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJSON(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function providerConnected(provider) {
  if (provider === 'fmp') return !!runtime.FMP_API_KEY;
  if (provider === 'perplexity') return !!runtime.PERPLEXITY_API_KEY;
  if (provider === 'tavily') return !!runtime.TAVILY_API_KEY;
  if (provider === 'fred') return !!runtime.FRED_API_KEY;
  if (provider === 'research' || provider === 'edgar') return true;
  return true;
}

export function loadToolHealth() {
  return readJSON(HEALTH_FILE, { tools: {}, providers: {}, updatedAt: null });
}

function summarizeTool(prev = {}, patch = {}) {
  const calls = (prev.calls || 0) + (patch.calls || 0);
  const errors = (prev.errors || 0) + (patch.errors || 0);
  const latencies = [...(prev.latencies || []), ...(patch.latencyMs != null ? [patch.latencyMs] : [])].slice(-30);
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : null;
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null;
  return {
    ...prev,
    ...patch,
    calls,
    errors,
    latencies,
    latencyMs: patch.latencyMs ?? prev.latencyMs ?? null,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    errorRate: calls ? +(errors / calls).toFixed(3) : 0,
    lastSuccessAt: patch.ok ? patch.ts : prev.lastSuccessAt,
    lastFailureAt: patch.ok === false ? patch.ts : prev.lastFailureAt,
    lastError: patch.ok === false ? patch.error : prev.lastError,
  };
}

export function recordToolHealth(name, meta, rec) {
  const state = loadToolHealth();
  const ts = rec.ts || Date.now();
  const provider = meta?.provider || 'unknown';
  const current = state.tools[name] || {};
  state.tools[name] = summarizeTool(current, {
    provider,
    connected: providerConnected(provider),
    reachable: rec.ok !== false,
    authOk: rec.authOk ?? (rec.ok !== false),
    rateLimited: !!rec.rateLimited,
    freshnessOk: rec.freshnessOk ?? null,
    coverageScore: rec.coverageScore ?? current.coverageScore ?? null,
    latencyMs: rec.durationMs,
    calls: 1,
    errors: rec.ok === false ? 1 : 0,
    ok: rec.ok !== false,
    error: rec.error,
    ts,
  });
  state.updatedAt = ts;

  const providers = {};
  for (const t of Object.values(state.tools)) {
    const p = t.provider || 'unknown';
    const cur = providers[p] || { provider: p, tools: 0, connected: providerConnected(p), healthy: 0, degraded: 0, errors: 0 };
    cur.tools += 1;
    if (t.ok && !t.rateLimited) cur.healthy += 1;
    else cur.degraded += 1;
    cur.errors += t.errors || 0;
    providers[p] = cur;
  }
  state.providers = providers;
  writeJSON(HEALTH_FILE, state);
  return state.tools[name];
}

export function toolHealthStatus(name, meta = {}) {
  const state = loadToolHealth();
  const rec = state.tools[name] || {};
  const connected = providerConnected(meta.provider);
  let status = 'unknown';
  if (!connected) status = 'missing-key';
  else if (rec.rateLimited) status = 'rate-limited';
  else if (rec.ok === false || (rec.errorRate ?? 0) > 0.25) status = 'degraded';
  else if (rec.lastSuccessAt) status = 'healthy';
  else status = 'untested';
  return { ...rec, connected, status };
}

export function allToolHealth(registry = {}) {
  const state = loadToolHealth();
  const tools = Object.fromEntries(Object.entries(registry).map(([name, t]) => [name, toolHealthStatus(name, t)]));
  return { ...state, tools };
}

export function classifyToolError(error) {
  const s = String(error?.message || error || '');
  return {
    error: s.slice(0, 240),
    authOk: !/(401|403|unauthori[sz]ed|forbidden|invalid api key)/i.test(s),
    rateLimited: /(429|rate.?limit|too many requests)/i.test(s),
  };
}
