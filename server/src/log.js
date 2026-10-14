'use strict';

/**
 * log.js —— 服务端统一日志 + 落盘保留策略。
 *
 * 为什么要它：以前排查问题靠临时 `console.error` / 往源码目录写 `*.log`，用完就删、下次又靠猜。
 * 现在固定成一份**分级**日志：
 *   · 级别：`error` < `warn` < `info` < `debug`；默认 `info` —— 平常输出 info / warn / error。
 *   · 想更细：`WORKGREMLIN_LOG=debug`（也认 `WORKGREMLIN_LOG_LEVEL`，`1`/`true`/`on` 同义）；
 *     只想看问题：`WORKGREMLIN_LOG=error`。启动参数 `--log=debug` 也认（cli.js 会写回来）。
 *   · 输出：屏幕一份（info/debug → stdout，warn/error → stderr），文件一份。
 *   · 落盘：`~/.workgremlin/logs/workgremlin-<YYYY-MM-DD>.log`（按天一个文件，只落 info 及以上）。
 *     关掉文件日志：`WORKGREMLIN_LOG_FILE=0`。
 *
 * **保留 7 天**（`WORKGREMLIN_LOG_KEEP_DAYS` 可改）：`~/.workgremlin` 下的日志自动清理 ——
 *   · `logs/workgremlin-*.log`：只留最近 N 天（含今天），更早的按天文件删掉；
 *   · `hooks/events.log`（reporter 的事件时间线）：按行上的 ISO 时间戳，删掉 N 天以前的行；
 *   · 历史遗留的单文件日志（`cb-cancel-debug.log` / 老的 `workgremlin.log`）：直接清掉（已无写入方）。
 * 清理在服务启动时跑一次，之后跨天（写日志时发现日期变了）再跑。
 *
 * 用法：`log.info('server listening on', url)` / `log.debug('hook', ev)` / `log.error(err)`。
 * 每条长这样：`2026-10-13T10:00:00.000Z INFO  [workgremlin] server listening on http://…`
 */

const fs = require('node:fs');
const path = require('node:path');
const { home } = require('@workgremlin/shared');
// Storage locations come from shared/paths.js (single source of truth).
const { logsDir, eventsLogPath } = require('@workgremlin/shared/paths');

/** 级别序：数值越小越"重要"（默认阈值 info，只放行 ≤ info 的） */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_LEVEL = 'info';
const DAY_MS = 24 * 60 * 60_000;

function normalizeLevel(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s in LEVELS) return s;
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return 'debug'; // "把 debug 打开"
  if (s === '0' || s === 'false' || s === 'off') return 'error';
  return DEFAULT_LEVEL;
}

let level = normalizeLevel(process.env.WORKGREMLIN_LOG || process.env.WORKGREMLIN_LOG_LEVEL);
let fileEnabled = process.env.WORKGREMLIN_LOG_FILE !== '0';
const keepDays = Math.max(1, Math.floor(Number(process.env.WORKGREMLIN_LOG_KEEP_DAYS)) || 7);

/** 日期戳（UTC，与日志行的时间戳同一把尺子） */
function dateStamp(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function logFilePath() {
  return path.join(logsDir(), `workgremlin-${dateStamp()}.log`);
}

/** 保留窗口内的那些日期（含今天） */
function keepDates() {
  const out = new Set();
  for (let i = 0; i < keepDays; i += 1) out.add(dateStamp(new Date(Date.now() - i * DAY_MS)));
  return out;
}

/** 按行上的首段 ISO 时间戳，删掉 cutoff 以前的行；没删就原样不动（也就不会跟 hook 的并发追加打架）。 */
function trimLinesByAge(file, cutoff) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const lines = text.split('\n');
  const kept = lines.filter((ln) => {
    if (!ln) return true; // 末尾空行留着
    const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(ln);
    if (!m) return true; // 认不出时间戳的行不动（不误删）
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
 * 清一遍 `~/.workgremlin` 下的日志（保留 keepDays 天）。启动时跑一次，之后跨天再跑。
 * 只碰日志文件：按天文件 / events.log / 已废弃的单文件日志 —— 不碰数据库、状态文件、会话落盘。
 * @returns {{files:number, lines:number}} 删了几个文件 / 删了几行
 */
function pruneOldLogs() {
  const now = Date.now();
  const cutoff = now - keepDays * DAY_MS;
  let files = 0;
  let lines = 0;

  // ① 我自己的按天文件：不在保留窗口里的删掉
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
      /* 删不掉就算了 */
    }
  }

  // ② reporter 的事件时间线：按行时间戳留最近 N 天
  lines += trimLinesByAge(eventsLogPath(), cutoff);

  // ③ 已废弃的单文件日志（写入方早没了）：直接清
  for (const n of ['cb-cancel-debug.log', 'debug-taskstate.log', 'workgremlin.log', 'workgremlin.log.1']) {
    const f = path.join(home(), n);
    try {
      fs.unlinkSync(f);
      files += 1;
    } catch {
      /* 不在就没有 */
    }
  }
  return { files, lines };
}

/** 落盘一份（best-effort：写不进去也绝不影响主流程） */
let lastPrunedDay = null;
function appendFile(line) {
  if (!fileEnabled) return;
  try {
    const f = logFilePath();
    fs.mkdirSync(logsDir(), { recursive: true });
    // 跨天（或首次）：顺手清一遍过期日志，不用额外定时器
    const day = dateStamp();
    if (day !== lastPrunedDay) {
      lastPrunedDay = day;
      pruneOldLogs();
    }
    fs.appendFileSync(f, `${line}\n`);
  } catch {
    /* 落盘失败不影响主流程 */
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
  // warn / error 走 stderr（别跟正常输出混在一条流上），info / debug 走 stdout
  const stream = LEVELS[lvl] <= LEVELS.warn ? process.stderr : process.stdout;
  try {
    stream.write(`${line}\n`);
  } catch {
    /* 终端关了也别抛 */
  }
  if (LEVELS[lvl] <= LEVELS.info) appendFile(line); // 文件里只留 info 及以上
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

// 启动时先清一遍（模块被 require 即执行；失败不影响启动）
try {
  pruneOldLogs();
} catch {
  /* ignore */
}
