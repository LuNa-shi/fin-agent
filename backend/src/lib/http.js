// 统一 HTTP 层：超时 + 重试 + 并发限流。
// 所有外部请求（LLM Provider / FMP / Perplexity / Tavily）都应走这里，
// 避免「裸 fetch 无超时」导致同步深度分析被某个 provider 卡死。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

// curl POST 传输：Perplexity 在部分网络/代理环境会阻断 node undici，但放行 curl。
// 本地单用户工具，curl 在 macOS/Linux 必备，作为这类源的可靠备用传输。
// 与 fetchWithRetry 对齐的重试：curl 执行失败/非 JSON/429/5xx 各重试（此前零重试，
// 瞬时抖动直接把调用打进 provider 降级，DeepSeek 通道却有 2 次重试——韧性不对称）。
export async function curlPostJSON(url, { headers = {}, body = '', timeoutMs = 120000, proxy = '', connectTimeoutSec = 8, retries = 2 } = {}) {
  const args = ['-sS', '-L', '--compressed', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-X', 'POST'];
  if (connectTimeoutSec > 0) args.push('--connect-timeout', String(connectTimeoutSec)); // 被墙域名黑洞连接快速失败，不吃满 max-time
  if (proxy) args.push('--proxy', proxy); // 域名被网络层阻断时经本地代理出去（如 PPLX_PROXY）
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push('--data-binary', body, url);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { stdout } = await execFileP('curl', args, { maxBuffer: 24 * 1024 * 1024 });
      let data;
      try { data = JSON.parse(stdout); } catch { throw new RetryableError(`curl 返回非 JSON: ${stdout.slice(0, 200)}`); }
      if (data?.error) {
        const code = String(data.error.code || '');
        const err = new Error(`${code} ${data.error.message || JSON.stringify(data.error)}`);
        if (code === '429' || /^5\d\d$/.test(code)) throw Object.assign(err, { retryable: true });
        throw err; // 4xx 业务错误不重试
      }
      return data;
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof RetryableError || e.retryable || e.code !== undefined; // execFile 失败带 code
      if (attempt < retries && retryable) { await backoff(attempt); continue; }
      throw e;
    }
  }
  throw lastErr;
}
class RetryableError extends Error {}

/**
 * 带超时与指数退避重试的 fetch。
 * @param {string} url
 * @param {object} opts  fetch 选项 + { timeoutMs, retries, retryOn }
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, opts = {}) {
  const {
    timeoutMs = 30000,
    retries = 2,
    retryOn = (res) => res.status === 429 || res.status >= 500,
    ...rest
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...rest, signal: ctrl.signal });
      clearTimeout(timer);
      if (attempt < retries && retryOn(res)) {
        await backoff(attempt);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      // AbortError（超时）/ 网络错误：重试
      if (attempt < retries) { await backoff(attempt); continue; }
      throw new Error(e?.name === 'AbortError' ? `请求超时(${timeoutMs}ms): ${url}` : String(e?.message || e));
    }
  }
  throw lastErr || new Error('fetch failed');
}

// 便捷封装：发 JSON 请求并解析 JSON 响应（非 2xx 抛错，带响应片段）。
export async function fetchJSON(url, opts = {}) {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${url.split('?')[0]}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function backoff(attempt) {
  // 200ms, 600ms, 1800ms… + 抖动
  const base = 200 * Math.pow(3, attempt);
  const jitter = Math.floor(Math.random() * 150);
  return new Promise((r) => setTimeout(r, base + jitter));
}

/**
 * 简单并发限流器：限制同时在途的异步任务数，避免对单一数据源打爆限流。
 * 用法：const limit = pLimit(4); await Promise.all(items.map(x => limit(() => work(x))));
 */
export function pLimit(concurrency = 4) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    const task = queue.shift();
    if (task.signal?.aborted) {
      task.cleanup?.();
      task.reject(Object.assign(new Error('queued task aborted'), { name: 'AbortError', code: 'RUN_ABORTED' }));
      next();
      return;
    }
    active++;
    task.cleanup?.();
    Promise.resolve().then(task.fn).then(task.resolve, task.reject).finally(() => { active--; next(); });
  };
  return (fn, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('queued task aborted'), { name: 'AbortError', code: 'RUN_ABORTED' }));
      return;
    }
    const task = { fn, resolve, reject, signal, cleanup: null };
    if (signal) {
      const onAbort = () => next();
      signal.addEventListener('abort', onAbort, { once: true });
      task.cleanup = () => signal.removeEventListener('abort', onAbort);
    }
    queue.push(task);
    next();
  });
}

/**
 * 公平限流器（LLM 全局槽专用）：
 * - priority 任务插队（短关键调用：finalize/json-fix/结论/天梯比对，不被 12 个长工具循环饿死）
 * - 普通任务按 lane（projectId）轮转出队——并发多项目时后启动的项目不再排在先启动项目的
 *   全部调用之后（此前 3 项目同跑就把第 3 个挤垮）
 * 用法：const limit = pLimitFair(40); limit(fn, { lane: projectId, priority: true })
 */
export function pLimitFair(concurrency = 8) {
  let active = 0;
  const prioQueue = [];
  const lanes = new Map();      // lane -> [{fn,resolve,reject}]
  const laneOrder = [];         // 轮转顺序
  let rrIndex = 0;
  const stats = { active: () => active, depth: () => prioQueue.length + [...lanes.values()].reduce((a, q) => a + q.length, 0) };
  const dequeue = () => {
    if (prioQueue.length) return prioQueue.shift();
    for (let i = 0; i < laneOrder.length; i++) {
      const lane = laneOrder[(rrIndex + i) % laneOrder.length];
      const q = lanes.get(lane);
      if (q?.length) {
        rrIndex = (rrIndex + i + 1) % laneOrder.length;
        const task = q.shift();
        if (!q.length) { lanes.delete(lane); laneOrder.splice(laneOrder.indexOf(lane), 1); if (rrIndex >= laneOrder.length) rrIndex = 0; }
        return task;
      }
    }
    return null;
  };
  const next = () => {
    if (active >= concurrency) return;
    const task = dequeue();
    if (!task) return;
    active++;
    Promise.resolve().then(task.fn).then(task.resolve, task.reject).finally(() => { active--; next(); });
  };
  const limit = (fn, { lane = 'default', priority = false } = {}) => new Promise((resolve, reject) => {
    if (priority) prioQueue.push({ fn, resolve, reject });
    else {
      if (!lanes.has(lane)) { lanes.set(lane, []); laneOrder.push(lane); }
      lanes.get(lane).push({ fn, resolve, reject });
    }
    next();
  });
  limit.stats = stats;
  return limit;
}
