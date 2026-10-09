'use strict';

/**
 * TraeCode（Trae / Trae CN）任务取消检测 —— 从 renderer.log 里挖取消信号。
 *
 * 为什么单独成文件：TraeCode **取消时不发 Stop hook 事件**（实测 2026-10-09：
 * 用户按停止 → renderer.log 里 DoneHandler 报告 status:"canceled"、StreamDomainService
 * 写 cancelReason:"stop_button"、NotificationPort 写 stopType:"cancel"，但
 * execCommandHook 再也没被调过一次 —— hooks.json 里明明配了 Stop，就是不触发）。
 * 所以 hook 状态文件里 taskId 永远占着、sessionPhase 冻在取消前那一口 thinking/tool，
 * 服务端只读 hook 的话 inWindow 一直 true、相位一直亮着，直到 2 分钟 TASK_RUN_MS 过期
 * 才慢慢回落 —— 用户看到的就是"取消了但控制台还在思考"。
 *
 * 唯一权威信号在 renderer.log（与 traeModels.js 读模型变更事件同一份文件、同一条路径）。
 * 取消信号链（实测 13:35:43 那次停止）：
 *   [DoneHandler] Stream done event received {"sessionId":"…","status":"canceled"}
 *   [StreamDomainService] requestStop … {"sessionId":"…","cancelReason":"stop_button"}
 *   [NotificationPort] Stream stopped … {"sessionId":"…","stopType":"cancel"}
 *   [stream-diagnostics][done] done finalized stream {"transformedStatus":"canceled","stopType":"cancel"}
 * 四种标记**都带 sessionId**，按会话精确匹配；取四种里最靠后的那条时间戳当取消时刻。
 *
 * 读法：只读文件**最后 256KB**（取消信号永远追加在末尾，长会话不必整份读），
 * 按 mtime+size 缓存增量解析（traeModels.js 同口径）。
 *
 * 与 services 的集成点：
 *   · sessions.js 的 readReporterDones：base==='trae' 时调 traeCancelOf，认到就合成取消标记
 *   · sessions.js 的 readReporterPhase：base==='trae' 时取消时刻比这口 stale 相位新 → 作废
 *   · sessions.js 的 readReporterActiveTask：base==='trae' 时取消时刻比 taskStartedAt 新 → 作废
 */

const fs = require('node:fs');
const path = require('node:path');
const { traeLogRoots } = require('./products');

/** 取消标记判定的四条规则：每条是 [log 标签片段, JSON 里检查的 key-value 对] */
const CANCEL_RULES = [
  // DoneHandler: status:"canceled"（整条行尾 JSON 含这个字段）
  ['DoneHandler', { status: (v) => String(v).toLowerCase() === 'canceled' || String(v).toLowerCase() === 'cancelled' }],
  // StreamDomainService: cancelReason:"stop_button"（stop / esc 都是这个）
  ['StreamDomainService', { cancelReason: (v) => !!v }],
  // NotificationPort: stopType:"cancel"
  ['NotificationPort', { stopType: (v) => String(v).toLowerCase() === 'cancel' || String(v).toLowerCase() === 'abort' }],
  // stream-diagnostics done: transformedStatus:"canceled" 或 stopType:"cancel"
  ['stream-diagnostics', null], // 特殊处理：行内同时有 canceled 且含 "done" 关键字
];

/**
 * 一行 renderer.log 里是不是 TraeCode 的取消信号。
 * 行尾跟一段 JSON（与 traeModels.js 解析 model-store 事件同形状），
 * 只认四种带 sessionId 的结构化标记。
 * @returns {{sessionId:string, at:number}|null} at = 这一行的时间戳（ms），0 = 解析不到
 */
function parseCancelLine(line) {
  if (!line || !/cancel|canceled|cancelled|stop_button/.test(line)) return null;
  // 提取 sessionId（任意一种取消标记都带）
  const sidMatch = line.match(/"sessionId"\s*:\s*"([^"]+)"/) || line.match(/"chat_session_id"\s*:\s*"([^"]+)"/);
  const sid = sidMatch ? sidMatch[1] : '';
  if (!sid) return null;

  // 行尾 JSON（第一个 { 之后）
  const brace = line.indexOf('{');
  let j = null;
  if (brace >= 0) {
    try { j = JSON.parse(line.slice(brace)); } catch { j = null; }
  }

  let hit = false;
  if (j) {
    const s = JSON.stringify(j).toLowerCase();
    // ① DoneHandler: status:"canceled"
    if (j.status && /^cancel(ed|led)$/i.test(String(j.status))) hit = true;
    // ② StreamDomainService: cancelReason 非空
    else if (j.cancelReason && typeof j.cancelReason === 'string') hit = true;
    // ③ NotificationPort: stopType:"cancel"
    else if (j.stopType && /^(cancel|abort|interrupt)/i.test(String(j.stopType))) hit = true;
    // ④ stream-diagnostics done: transformedStatus:"canceled"
    else if (j.transformedStatus && /^cancel(ed|led)$/i.test(String(j.transformedStatus))) hit = true;
  } else {
    // JSON 解析失败 —— 退而求其次，在行里直接搜 sessionId + cancel 关键词
    hit = /cancel(ed|led)|stop_button|stopType.*cancel/i.test(line);
  }

  if (!hit) return null;

  // 时间戳：行首 ISO 格式 2026-10-09T13:35:43.609+08:00
  const tsMatch = line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+/);
  let at = 0;
  if (tsMatch) {
    const at2 = Date.parse(tsMatch[0]);
    if (Number.isFinite(at2)) at = at2;
  }
  return { sessionId: sid, at };
}

/**
 * 整份读 renderer.log（UTF-8）。Trae 的 renderer.log 一般 1-5MB，不会太大；
 * 而且按 mtime+size 缓存（traeModels.js 同口径），文件没动就不重读，所以每次扫全盘只在
 * 少数正在写的那个文件上真正消耗 IO。
 *
 * 曾经尝试只读末尾 256KB（取消信号"应该"在末尾追加），但实测 renderer.log 里同一窗口
 * 会连续跑多轮会话（一轮取消 → 新一轮开始），老一轮的取消信号被推到文件中间，
 * 只读末尾会把历史取消都丢掉。整份扫更稳妥。
 */
function readLog(f) {
  try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
}

/** 文件级缓存：path -> { mtimeMs, size, cancels: { [sessionId]: at } } */
const _fileCache = new Map();
/** 全局 TTL 缓存（避免每次扫全盘） */
const TTL_MS = 15_000;
let _cache = { at: 0, map: null };

/**
 * 扫所有 Trae renderer.log，汇总取消信号 → `{ [sessionId]: 最靠后的取消时刻 }`
 * 按 mtime+size 增量（traeModels.js 同口径）。
 */
function allCancels() {
  const now = Date.now();
  if (_cache.map && now - _cache.at < TTL_MS) return _cache.map;

  const files = [];
  for (const logsRoot of traeLogRoots()) {
    for (const launch of safeReadDir(logsRoot)) {
      const launchDir = path.join(logsRoot, launch);
      if (!isDirSafe(launchDir)) continue;
      for (const win of safeReadDir(launchDir)) {
        if (!/^window/.test(win)) continue;
        const f = path.join(launchDir, win, 'renderer.log');
        try {
          const st = fs.statSync(f);
          if (st.isFile()) files.push({ f, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* skip */
        }
      }
    }
  }
  // mtime 升序 → 后处理的覆盖先处理的（同一会话多次取消取最后一次）
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.f < b.f ? -1 : 1));
  const seen = new Set(files.map((x) => x.f));
  for (const k of [..._fileCache.keys()]) if (!seen.has(k)) _fileCache.delete(k);

  const merged = {};
  for (const { f, mtimeMs, size } of files) {
    const hit = _fileCache.get(f);
    let fileMap;
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      fileMap = hit.map;
    } else {
      fileMap = parseFileCancels(f);
      _fileCache.set(f, { mtimeMs, size, map: fileMap });
    }
    for (const [sid, at] of Object.entries(fileMap)) {
      if (!merged[sid] || at > merged[sid]) merged[sid] = at;
    }
  }
  _cache = { at: now, map: merged };
  return merged;
}

/** 单个 renderer.log → `{ [sessionId]: at }` */
function parseFileCancels(f) {
  const content = readLog(f);
  const out = {};
  for (const line of String(content || '').split('\n')) {
    const hit = parseCancelLine(line);
    if (!hit) continue;
    if (!out[hit.sessionId] || hit.at > out[hit.sessionId]) out[hit.sessionId] = hit.at;
  }
  return out;
}

/**
 * 这条 TraeCode 会话有没有被用户取消、取消时刻是什么。
 * @param {string} sessionId
 * @param {number} sinceTs 只认这一刻之后的取消（0 = 不过滤）
 * @returns {number} 取消时刻（0 = 没取消 / 没识别出来）
 */
function traeCancelAt(sessionId, sinceTs = 0) {
  const sid = String(sessionId || '').trim();
  if (!sid) return 0;
  const map = allCancels();
  const at = Number(map[sid]) || 0;
  if (!at) return 0;
  if (sinceTs && at < sinceTs) return 0; // 老取消不算到新一轮头上
  return at;
}

/* ─────────────────────────────────────────────────────────────────────
 * Trae DoneHandler 扫描 —— renderer.log 里每轮结束的权威状态信号。
 *
 * 格式：
 *   [DoneHandler] Stream done event received {"sessionId":"…","status":"completed|canceled","agentMessageId":"…"}
 *
 * 与 allCancels()（扫更早的 stop_button / NotificationPort cancel 信号）的分工：
 *   · readReporterPhase / readReporterActiveTask 用 traeCancelAt —— 越早戳破相位越好
 *   · flushTraeDone 用 allDoneHandlers —— DoneHandler 是最终状态真相
 *   · readReporterDones 合成标记用 DoneHandler —— completed/canceled 不会错
 *
 * 缓存复用 allCancels 的 mtime+size + TTL 15s 口径，扫同样的文件集。
 * ───────────────────────────────────────────────────────────────────── */

/** 一行是不是 DoneHandler 的 Stream done event —— 带 sessionId + status(completed|canceled) + agentMessageId */
function parseDoneHandlerLine(line) {
  if (!line || !/DoneHandler.*Stream done event received/.test(line)) return null;
  const brace = line.indexOf('{');
  let j = null;
  if (brace >= 0) {
    try { j = JSON.parse(line.slice(brace)); } catch { /* 不是合法 JSON */ }
  }
  if (!j || !j.sessionId || !j.status) return null;
  const s = String(j.status).toLowerCase();
  if (s !== 'completed' && s !== 'canceled' && s !== 'cancelled') return null;
  const sid = String(j.sessionId);
  const agentMsg = j.agentMessageId ? String(j.agentMessageId) : '';
  // 时间戳：行首 ISO 格式
  const tsMatch = line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+/);
  let at = 0;
  if (tsMatch) {
    const at2 = Date.parse(tsMatch[0]);
    if (Number.isFinite(at2)) at = at2;
  }
  return { sessionId: sid, agentMessageId: agentMsg, status: s === 'completed' ? 'completed' : 'canceled', at };
}

/** 单个 renderer.log → DoneHandler 事件数组（每轮一个，按 at 升序，不去重 sessionId） */
function parseFileDoneHandlers(f) {
  const content = readLog(f);
  const out = [];
  const seen = new Set(); // 同一行可能被重复扫 → 用 agentMessageId + at 去重
  for (const line of String(content || '').split('\n')) {
    const hit = parseDoneHandlerLine(line);
    if (!hit) continue;
    const dedup = `${hit.sessionId}|${hit.agentMessageId}|${hit.at}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push(hit);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 文件级缓存：path → { mtimeMs, size, handlers } */
const _doneFileCache = new Map();
/** 全局 TTL 缓存（避免每次扫全盘）—— 跟 _cache（cancels）同 TTL */
let _doneCache = { at: 0, list: null };

/**
 * 扫所有 Trae renderer.log，汇总 DoneHandler 信号 → 事件数组
 * `[{sessionId, agentMessageId, status:'completed'|'canceled', at}, ...]`
 * 按 at 升序排列（每轮结束一条，不会被 sessionId 覆盖）。
 *
 * 跟 allCancels() 同文件集、同 mtime+size 增量、同 TTL 15s。
 */
function allDoneHandlers() {
  const now = Date.now();
  if (_doneCache.list && now - _doneCache.at < TTL_MS) return _doneCache.list;

  const files = [];
  for (const logsRoot of traeLogRoots()) {
    for (const launch of safeReadDir(logsRoot)) {
      const launchDir = path.join(logsRoot, launch);
      if (!isDirSafe(launchDir)) continue;
      for (const win of safeReadDir(launchDir)) {
        if (!/^window/.test(win)) continue;
        const f = path.join(launchDir, win, 'renderer.log');
        try {
          const st = fs.statSync(f);
          if (st.isFile()) files.push({ f, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* skip */ }
      }
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.f < b.f ? -1 : 1));
  const seen = new Set(files.map((x) => x.f));
  for (const k of [..._doneFileCache.keys()]) if (!seen.has(k)) _doneFileCache.delete(k);

  const merged = [];
  const globalSeen = new Set();
  for (const { f, mtimeMs, size } of files) {
    const hit = _doneFileCache.get(f);
    let arr;
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      arr = hit.handlers;
    } else {
      arr = parseFileDoneHandlers(f);
      _doneFileCache.set(f, { mtimeMs, size, handlers: arr });
    }
    for (const h of arr) {
      const dedup = `${h.sessionId}|${h.agentMessageId}|${h.at}`;
      if (globalSeen.has(dedup)) continue;
      globalSeen.add(dedup);
      merged.push(h);
    }
  }
  merged.sort((a, b) => a.at - b.at);
  _doneCache = { at: now, list: merged };
  return merged;
}

/**
 * 这条 TraeCode 会话最新一轮 DoneHandler 状态是什么。
 * @param {string} sessionId
 * @returns {{status:'completed'|'canceled', at:number, agentMessageId:string}|null} null = 没扫到 DoneHandler（还在跑 / 没被识别）
 */
function traeDoneStatus(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  const list = allDoneHandlers();
  let latest = null;
  for (const h of list) {
    if (h.sessionId === sid && (!latest || h.at > latest.at)) latest = h;
  }
  return latest;
}

function safeReadDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}
function isDirSafe(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

module.exports = { traeCancelAt, allCancels, allDoneHandlers, traeDoneStatus };
