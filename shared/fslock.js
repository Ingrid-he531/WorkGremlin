'use strict';

/**
 * 进程间小工具：加锁的读-改-写 + 原子写（仅 Node，不进浏览器包；用
 * require('@workgremlin/shared/fslock') 单独引入）。
 *
 * 为什么需要（2026-09-27 实测）：hook 会被 CLI 在**同一毫秒**并行触发多次 ——
 * 同一次对话里连发三条 PreToolUse(Agent)，时间戳只差 5~11ms（见
 * ~/.workgremlin/hooks/events.log 的 05:29:45.178/.184/.189）。每个 hook 都是**独立进程**，
 * 各自 readFile → 改内存 → writeFileSync，于是互相覆盖：
 *   · 三条 ghost+ 只落两条（第三只被前一只的回写冲掉）；
 *   · 状态文件里的 taskId / roundFiles / done 被"回写旧版本"削掉，整轮产出全丢；
 *   · 更糟的是读到**半截 JSON**：readState/readFeedFile 对坏文件一律退回 {} / 空清单，
 *     紧接着的一次 patch 就把整份状态写没。
 *
 * 这里给两件东西：
 *   1. atomicWriteJson：先写同目录临时文件再 rename —— 读者永远看不到半截文件；
 *   2. withLock / updateJson：O_EXCL 抢锁 + 短自旋，把"读-改-写"整段串起来，消掉 lost update。
 *
 * 两条纪律：
 *   · 锁是**顾问式**的 —— 拿不到（超时）就退化成本次不加锁直接跑，绝不把调用方卡死。
 *     hook 的第一纪律是"绝不阻塞 agent"，一个卡死的锁比偶发丢一次更新严重得多。
 *   · 锁文件 = <目标文件>.lock；持锁进程崩溃留下的陈锁按 mtime 过期（默认 10s）自动接管。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 抢锁最多等多久（毫秒）—— 一次读改写只有几毫秒，1.5s 足够排掉一串并发 hook */
const DEFAULT_TIMEOUT_MS = 1500;
/** 锁文件超过这么久没被释放，就当持锁进程已经崩了，接管它 */
const DEFAULT_STALE_MS = 10_000;

/** 同步 sleep：锁自旋需要等一下（Atomics.wait 不烧 CPU，且不依赖 event loop） */
function sleepSync(ms) {
  const wait = Math.max(0, Math.round(ms));
  if (!wait) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  } catch {
    const end = Date.now() + wait; // 受限环境没有 Atomics → 退化成忙等
    while (Date.now() < end) {
      /* busy */
    }
  }
}

function lockPathOf(file) {
  return `${file}.lock`;
}

/**
 * 抢锁。拿到返回锁文件路径；超时 / 出错返回 null（**不抛**，调用方自行决定退让）。
 * @param {string} file 被保护的**目标文件**（锁文件是它加 .lock）
 * @param {{timeoutMs?: number, staleMs?: number}} [opts]
 * @returns {string|null}
 */
function acquireLock(file, opts = {}) {
  const lock = lockPathOf(file);
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
  } catch {
    return null;
  }
  for (;;) {
    try {
      // 'wx' = O_CREAT | O_EXCL | O_WRONLY：只有抢到的那个进程能建成功
      const fd = fs.openSync(lock, 'wx');
      try {
        fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return lock;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return null;
      // 陈锁接管：持锁进程崩了 → 锁文件留在这。mtime 够老就当它已经没了，删掉重抢。
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // 刚被别人删掉 → 立刻重抢
      }
      if (Date.now() >= deadline) return null;
      sleepSync(3 + Math.floor(Math.random() * 12)); // 抖动，避免两进程同拍死磕
    }
  }
}

/** 释放锁；本来就不在了也无所谓（陈锁接管 / 别人已经删掉） */
function releaseLock(lock) {
  try {
    fs.unlinkSync(lock);
  } catch {
    /* ignore */
  }
}

/**
 * 在锁里跑 fn。**拿不到锁也照跑**（只是这次失去互斥）—— 见文件头"顾问式"那条。
 * @template T
 * @param {string} file
 * @param {() => T} fn
 * @param {{timeoutMs?: number, staleMs?: number}} [opts]
 * @returns {T}
 */
function withLock(file, fn, opts) {
  const lock = acquireLock(file, opts);
  try {
    return fn();
  } finally {
    if (lock) releaseLock(lock);
  }
}

/**
 * 原子写文件：同目录临时文件 + rename（同一文件系统内 rename 是原子的）。
 * 读者要么看到旧内容、要么看到新内容，**永远看不到半截**。
 */
function atomicWriteFile(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * 原子写 JSON。
 * @param {string} file
 * @param {any} data
 * @param {{pretty?: boolean}} [opts] pretty 默认 true（2 空格缩进，清单文件一直这么写）；
 *   状态文件传 pretty:false 保持原来的紧凑单行格式。
 */
function atomicWriteJson(file, data, opts = {}) {
  const space = opts.pretty === false ? 0 : 2;
  atomicWriteFile(file, `${JSON.stringify(data, null, space)}\n`);
}

/** 宽容读 JSON：文件不存在 / 坏掉 / 非对象都回 fallback（与 readState/readFeedFile 同口径） */
function readJson(file, fallback = null) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data == null ? fallback : data;
  } catch {
    return fallback;
  }
}

/**
 * 加锁的读-改-写：mutate 收到当前值（读不到给 fallback），返回值写回。
 * mutate 返回 undefined 表示**放弃这次更新**（不写盘，用于"已满足条件 / 无匹配"的短路）。
 * @param {string} file
 * @param {(cur: any) => any} mutate
 * @param {{fallback?: any, pretty?: boolean, timeoutMs?: number, staleMs?: number}} [opts]
 * @returns {any} 写完后的值（放弃更新时是读到的原值）
 */
function updateJson(file, mutate, opts = {}) {
  const { fallback = {}, pretty = true, ...lockOpts } = opts;
  return withLock(
    file,
    () => {
      const cur = readJson(file, fallback);
      const next = mutate(cur);
      if (next === undefined) return cur;
      atomicWriteJson(file, next, { pretty });
      return next;
    },
    lockOpts
  );
}

module.exports = {
  acquireLock,
  releaseLock,
  withLock,
  atomicWriteFile,
  atomicWriteJson,
  readJson,
  updateJson,
  sleepSync,
  lockPathOf,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_STALE_MS,
};
