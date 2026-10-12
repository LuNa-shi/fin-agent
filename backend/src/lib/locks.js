// 进程内 keyed 互斥锁 + 原子 JSON 落盘。
// 背景：MAX_ANALYSES>1 时多个分析并发触碰共享 JSON 存储，read-modify-write 跨 await
// 边界交错会互相覆盖（丢更新）。
// 用法：所有共享存储的「读→改→写」整体包进 withLock(key, fn)，key 用文件路径；
// 落盘统一走 safeWriteJSON（唯一 tmp 名 + rename 原子替换）。
import fs from 'node:fs';
import path from 'node:path';

const locks = new Map(); // key -> Promise 链尾
let tmpSeq = 0;

/** 同 key 串行执行 fn（不同 key 互不阻塞）。fn 可为 async。 */
export function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  // 无论前者成败都继续排队；本次的结果单独向调用方传播
  const run = prev.catch(() => {}).then(fn);
  // 链尾吞掉错误，避免 unhandled rejection 污染后续排队者；链尾仍是自己时清理，防 Map 增长
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.finally(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/** 原子写 JSON：唯一 tmp 名（pid+seq）+ rename。并发写者各用各的 tmp，最后写赢。 */
export function safeWriteJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${++tmpSeq}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

/** 锁内「读→改→写」：mutate 收到最新读出的对象，返回新对象（或原对象改后返回）即落盘。 */
export function mutateJSON(p, fallback, mutate) {
  return withLock(p, () => {
    let cur = fallback;
    try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* 不存在/损坏用 fallback */ }
    const next = mutate(cur) ?? cur;
    safeWriteJSON(p, next);
    return next;
  });
}
