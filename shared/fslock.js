'use strict';

/**
 * Cross-process helper: locked read-modify-write + atomic write (Node only, not in the browser bundle;
 * import it explicitly via require('@workgremlin/shared/fslock')).
 *
 * Why it is needed (measured 2026-09-27): the CLI can trigger the hook several times in parallel **within
 * the same millisecond** — one conversation emitted three PreToolUse(Agent) in a row, timestamps 5~11ms apart
 * (see ~/.workgremlin/hooks/events.log at 05:29:45.178/.184/.189). Each hook is a **separate process** doing
 * its own readFile → edit in memory → writeFileSync, so they overwrite each other:
 *   · three ghost+ only land two (the third is clobbered by the first's write-back);
 *   · the state file's taskId / roundFiles / done get cut by "writing back an older version", losing the whole round's output;
 *   · worse, a **half-written JSON** is read: readState/readFeedFile fall back to {} / an empty manifest for a
 *     corrupt file, and the very next patch wipes the whole state.
 *
 * Two things are provided here:
 *   1. atomicWriteJson: write a temp file in the same dir, then rename — a reader never sees a half-written file;
 *   2. withLock / updateJson: O_EXCL lock + short spin, serializing the whole "read-modify-write" and removing lost updates.
 *
 * Two disciplines:
 *   · The lock is **advisory** — if it can't be taken (timeout), fall back to running without the lock this
 *     time; never wedge the caller. The hook's first discipline is "never block the agent", and a wedged lock
 *     is far worse than occasionally losing one update.
 *   · Lock file = <target file>.lock; a stale lock left by a crashed holder is taken over automatically once
 *     its mtime is old enough (default 10s).
 */

const fs = require('node:fs');
const path = require('node:path');

/** How long to wait for the lock at most (ms) — one read-modify-write takes a few ms, so 1.5s is enough to clear a burst of hooks */
const DEFAULT_TIMEOUT_MS = 1500;
/** A lock file not released for longer than this is treated as a crashed holder; take it over */
const DEFAULT_STALE_MS = 10_000;

/** Synchronous sleep: the lock spin needs to wait (Atomics.wait does not burn CPU and does not depend on the event loop) */
function sleepSync(ms) {
  const wait = Math.max(0, Math.round(ms));
  if (!wait) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  } catch {
    const end = Date.now() + wait; // no Atomics in a restricted env → degrade to a busy wait
    while (Date.now() < end) {
      /* busy */
    }
  }
}

function lockPathOf(file) {
  return `${file}.lock`;
}

/**
 * Acquire the lock. Returns the lock file path on success; null on timeout / error (**does not throw**; the caller decides how to yield).
 * @param {string} file the **target file** being protected (the lock file is it plus .lock)
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
      // 'wx' = O_CREAT | O_EXCL | O_WRONLY: only the process that wins can create it
      const fd = fs.openSync(lock, 'wx');
      try {
        fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return lock;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return null;
      // Stale-lock takeover: the holder crashed → the lock file stays. If the mtime is old enough, treat it as gone, delete it, and retry.
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // just deleted by someone else → retry immediately
      }
      if (Date.now() >= deadline) return null;
      sleepSync(3 + Math.floor(Math.random() * 12)); // jitter, so two processes don't lock-step
    }
  }
}

/** Release the lock; fine if it is already gone (stale takeover / someone already deleted it) */
function releaseLock(lock) {
  try {
    fs.unlinkSync(lock);
  } catch {
    /* ignore */
  }
}

/**
 * Run fn inside the lock. **Runs even if the lock is not taken** (it just loses mutual exclusion this time) — see the "advisory" note in the header.
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
 * Atomic file write: a temp file in the same dir + rename (rename within one filesystem is atomic).
 * A reader sees either the old content or the new content, **never a half-written one**.
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
 * Atomic JSON write.
 * @param {string} file
 * @param {any} data
 * @param {{pretty?: boolean}} [opts] pretty defaults to true (2-space indent, how manifest files have always been written);
 *   state files pass pretty:false to keep the original compact single-line format.
 */
function atomicWriteJson(file, data, opts = {}) {
  const space = opts.pretty === false ? 0 : 2;
  atomicWriteFile(file, `${JSON.stringify(data, null, space)}\n`);
}

/** Lenient JSON read: missing / corrupt / non-object all return fallback (same as readState/readFeedFile) */
function readJson(file, fallback = null) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data == null ? fallback : data;
  } catch {
    return fallback;
  }
}

/**
 * Locked read-modify-write: mutate receives the current value (fallback if unreadable) and its return value is written back.
 * mutate returning undefined means **abandon this update** (no write; for short-circuiting "condition already met / no match").
 * @param {string} file
 * @param {(cur: any) => any} mutate
 * @param {{fallback?: any, pretty?: boolean, timeoutMs?: number, staleMs?: number}} [opts]
 * @returns {any} the value after writing (the read value when the update is abandoned)
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
