'use strict';

/**
 * log.js —— unified server-side logging + on-disk retention policy.
 *
 * Why it exists: troubleshooting used to rely on ad-hoc `console.error` or writing `*.log`
 * into the source directory, deleted after use and guessed at again next time. Now it is
 * fixed as a single **leveled** logger:
 *   · Levels: `error` < `warn` < `info` < `debug`; default `info` —— normally emitting
 *     info / warn / error.
 *   · Want more detail: `WORKGREMLIN_LOG=debug` (`WORKGREMLIN_LOG_LEVEL` is also accepted, with
 *     `1`/`true`/`on` meaning the same); only want problems: `WORKGREMLIN_LOG=error`. The start
 *     parameter `--log=debug` works too (cli.js writes it back).
 *   · Output: one copy on screen (info/debug → stdout, warn/error → stderr), one copy on disk.
 *   · On disk: `~/.workgremlin/logs/workgremlin-<YYYY-MM-DD>.log` (one file per day, keeping
 *     info and above only). Disable file logging with `WORKGREMLIN_LOG_FILE=0`.
 *
 * **Keep 7 days** (`WORKGREMLIN_LOG_KEEP_DAYS` can change it): logs under `~/.workgremlin` are
 * cleaned up automatically ——
 *   · `logs/workgremlin-*.log`: keep only the last N days (today included); older per-day files
 *     are deleted;
 *   · `hooks/events.log` (the reporter's event timeline): lines older than N days are dropped,
 *     based on the ISO timestamp on each line;
 *   · Legacy single-file logs (`cb-cancel-debug.log` / the old `workgremlin.log`): deleted
 *     outright (nobody writes to them anymore).
 * Cleanup runs once at server start, and again when the day changes (detected while writing a
 * log line).
 *
 * Usage: `log.info('server listening on', url)` / `log.debug('hook', ev)` / `log.error(err)`.
 * Each line looks like: `2026-10-13T10:00:00.000Z INFO  [workgremlin] server listening on http://…`
 */

const fs = require('node:fs');
const path = require('node:path');
const { home } = require('@workgremlin/shared');
// Storage locations come from shared/paths.js (single source of truth).
const { logsDir, eventsLogPath } = require('@workgremlin/shared/paths');

/** Level order: the smaller the number, the more "important" (default threshold info, only levels ≤ info pass) */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_LEVEL = 'info';
const DAY_MS = 24 * 60 * 60_000;

function normalizeLevel(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s in LEVELS) return s;
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return 'debug'; // "turn debug on"
  if (s === '0' || s === 'false' || s === 'off') return 'error';
  return DEFAULT_LEVEL;
}

let level = normalizeLevel(process.env.WORKGREMLIN_LOG || process.env.WORKGREMLIN_LOG_LEVEL);
let fileEnabled = process.env.WORKGREMLIN_LOG_FILE !== '0';
const keepDays = Math.max(1, Math.floor(Number(process.env.WORKGREMLIN_LOG_KEEP_DAYS)) || 7);

/** Date stamp (UTC, the same yardstick as the timestamp on log lines) */
function dateStamp(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function logFilePath() {
  return path.join(logsDir(), `workgremlin-${dateStamp()}.log`);
}

/** The dates inside the retention window (today included) */
function keepDates() {
  const out = new Set();
  for (let i = 0; i < keepDays; i += 1) out.add(dateStamp(new Date(Date.now() - i * DAY_MS)));
  return out;
}

/** Drop lines older than cutoff by their leading ISO timestamp; when nothing is dropped the file is left untouched (so it never fights the hook's concurrent appends). */
function trimLinesByAge(file, cutoff) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const lines = text.split('\n');
  const kept = lines.filter((ln) => {
    if (!ln) return true; // keep the trailing empty line
    const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(ln);
    if (!m) return true; // leave lines without a recognizable timestamp alone (never delete by mistake)
    const at = Date.parse(m[1]);
    return !Number.isFinite(at) || at >= cutoff;
  });
  if (kept.length === lines.length) return 0;
  try {
    fs.writeFileSync(file, kept.join('\n'));
  } catch {
    return 0;
  }
  return lines.length - kept.length;
}

/**
 * Clean the logs under `~/.workgremlin` once (keeping keepDays days). Runs once at start, then
 * again whenever the day changes.
 * Touches log files only: per-day files / events.log / obsolete single-file logs —— never the
 * database, state files, or session data on disk.
 * @returns {{files:number, lines:number}} how many files / lines were deleted
 */
function pruneOldLogs() {
  const now = Date.now();
  const cutoff = now - keepDays * DAY_MS;
  let files = 0;
  let lines = 0;

  // ① My own per-day files: delete those outside the retention window
  const keep = keepDates();
  let names = [];
  try {
    names = fs.readdirSync(logsDir());
  } catch {
    names = [];
  }
  for (const n of names) {
    const m = /^workgremlin-(\d{4}-\d{2}-\d{2})\.log/.exec(n);
    if (!m || keep.has(m[1])) continue;
    try {
      fs.unlinkSync(path.join(logsDir(), n));
      files += 1;
    } catch {
      /* fine if it cannot be deleted */
    }
  }

  // ② The reporter's event timeline: keep the last N days by line timestamp
  lines += trimLinesByAge(eventsLogPath(), cutoff);

  // ③ Obsolete single-file logs (their writers are long gone): delete outright
  for (const n of ['cb-cancel-debug.log', 'debug-taskstate.log', 'workgremlin.log', 'workgremlin.log.1']) {
    const f = path.join(home(), n);
    try {
      fs.unlinkSync(f);
      files += 1;
    } catch {
      /* not there, nothing to do */
    }
  }
  return { files, lines };
}

/** Persist one copy (best-effort: failing to write must never affect the main flow) */
let lastPrunedDay = null;
function appendFile(line) {
  if (!fileEnabled) return;
  try {
    const f = logFilePath();
    fs.mkdirSync(logsDir(), { recursive: true });
    // Day change (or the first time): sweep expired logs on the way, no extra timer needed
    const day = dateStamp();
    if (day !== lastPrunedDay) {
      lastPrunedDay = day;
      pruneOldLogs();
    }
    fs.appendFileSync(f, `${line}\n`);
  } catch {
    /* failing to persist does not affect the main flow */
  }
}

function fmt(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message || String(v);
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function write(lvl, args) {
  if (LEVELS[lvl] > LEVELS[level]) return;
  const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [workgremlin] ${args.map(fmt).join(' ')}`;
  // warn / error go to stderr (do not mix them onto the normal output stream), info / debug to stdout
  const stream = LEVELS[lvl] <= LEVELS.warn ? process.stderr : process.stdout;
  try {
    stream.write(`${line}\n`);
  } catch {
    /* never throw even if the terminal is gone */
  }
  if (LEVELS[lvl] <= LEVELS.info) appendFile(line); // keep only info and above on disk
}

module.exports = {
  LEVELS,
  keepDays,
  getLevel: () => level,
  setLevel: (v) => {
    level = normalizeLevel(v);
    return level;
  },
  isEnabled: (lvl) => LEVELS[lvl] <= LEVELS[level],
  logsDir,
  path: logFilePath,
  fileEnabled: () => fileEnabled,
  setFileEnabled: (v) => {
    fileEnabled = Boolean(v);
    return fileEnabled;
  },
  pruneOldLogs,
  error: (...a) => write('error', a),
  warn: (...a) => write('warn', a),
  info: (...a) => write('info', a),
  debug: (...a) => write('debug', a),
};

// Sweep once at start (runs on require; a failure must not break startup)
try {
  pruneOldLogs();
} catch {
  /* ignore */
}
