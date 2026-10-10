'use strict';

/**
 * 5F TraeCode（Trae / Trae CN）楼层模块 —— 把取消检测、token 金额、模型补全三件套
 * （原 traeCancel.js / traeTokens.js / traeModels.js）合并到这一个文件。
 *
 * 三条信号都从 Trae 自己的落盘挖（renderer.log / globalStorage 的 state.vscdb），
 * 互不依赖、各自带 mtime+size 增量 + TTL 缓存。详细语义见各函数上方注释。
 *
 * 统一接口（见 floors.js 的 FLOOR_CONTRACT）：
 *   id / client   楼层身份
 *   cancelAt      取消时刻检测（= traeCancelAt）
 *   allCancels    全量取消扫描（flush 写回 DB 用）
 *   modelOf       取会话当前模型（= selectedModelOf）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clientOf } = require('@workgremlin/shared');
// Trae 家族的 globalStorage / logs 根目录：本楼层私有，放在本文件（不再污染 floors.js）。
const { isDir, dataRoots } = require('./roots');

/**
 * TraeCode 家族的 globalStorage（模型选择就记在它的 state.vscdb 里）。单列一份、不并进
 * globalStorageRoots：那份是**插件楼层的落盘位置**，一改就会把 5F 的落盘从 ~/.marscode 带偏。
 */
function traeGlobalStorageRoots() {
  const out = [];
  for (const r of dataRoots()) {
    for (const ed of ['Trae', 'Trae CN']) {
      const p = path.join(r, ed, 'User', 'globalStorage');
      if (isDir(p)) out.push(p);
    }
  }
  return out;
}

/**
 * TraeCode 家族的 logs 根。新版 Trae 把「会话 → 当前选中模型」搬进了内存态 store + 加密库，
 * state.vscdb 里那条不再写 —— renderer.log 的 model-store 事件成了唯一明文来源。
 */
function traeLogRoots() {
  const out = [];
  for (const r of dataRoots()) {
    for (const ed of ['Trae', 'Trae CN']) {
      const p = path.join(r, ed, 'logs');
      if (isDir(p)) out.push(p);
    }
  }
  return out;
}

/**
 * 5F TraeCode 楼层元数据（原 products.js 的 5F 条目）。IDE 与 Plugin 合并楼层：
 * 两路 dir 只作落盘展示（读不出会话），会话来源是 hook 状态文件。
 */
const meta = {
  id: '5F',
  name: 'TraeCode',
  kind: 'cli',
  cmd: 'trae',
  altCmd: 'trae-cn',
  agent: 'trae',
  plugin: false,
  pluginRe: /trae|coding-copilot/i,
  sources: [
    { kind: 'dir', label: 'IDE', client: clientOf('trae', false), dirs: [path.join(os.homedir(), '.trae-cn'), path.join(os.homedir(), '.trae')] },
    { kind: 'dir', label: 'plugin', client: clientOf('trae', true), dirs: [path.join(os.homedir(), '.marscode')] },
    { kind: 'hook' },
  ],
  hookSource: true,
  dataKind: clientOf('trae', false),
};

const TTL_MS = 15_000;
function safeReadDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}
function isDirSafe(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/* ───────────── 原 traeCancel.js ───────────── */



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





/* ───────────── 原 traeTokens.js ───────────── */




let _usagesCache = { at: 0, list: null };




/**
 * 一行 renderer.log → token usage 事件（只认 action="show" 的那条，request_success 是前置、
 * request_fail 是取消场景，不拿它们当金额）。
 * @returns {{sessionId:string, agentMessageId:string, userMessageId:string, usageYuan:number, ts:number}|null}
 */
function parseUsageLine(line) {
  if (!line || !line.includes('cn_session_usage_tail')) return null;
  const m = line.match(/params:\s*(\{.+?\})$/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[1]); } catch { return null; }
  if (j.action !== 'show') return null;

  const tsMatch = line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+/);
  let ts = 0;
  if (tsMatch) {
    const t = Date.parse(tsMatch[0]);
    if (Number.isFinite(t)) ts = t;
  }

  const yuan = Number(j.usage_summary);
  if (!Number.isFinite(yuan)) return null;

  return {
    sessionId: String(j.session_id || ''),
    agentMessageId: String(j.agent_message_id || ''),
    userMessageId: String(j.user_message_id || ''),
    usageYuan: yuan,
    ts,
  };
}

/** 单个 renderer.log → 这一份文件里的 usage 事件数组 */
function parseFileUsages(f) {
  const content = (() => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } })();
  const out = [];
  const seen = new Set();
  for (const line of String(content || '').split('\n')) {
    const hit = parseUsageLine(line);
    if (!hit || !hit.sessionId || !hit.agentMessageId) continue;
    const key = hit.sessionId + '|' + hit.agentMessageId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/**
 * 扫所有 Trae renderer.log，汇总所有 cn_session_usage_tail 事件。
 * 按 mtime+size 增量缓存（traeCancel.js 同口径）。
 * @returns {Array<{sessionId:string, agentMessageId:string, userMessageId:string, usageYuan:number, ts:number}>}
 */
function allTokenUsages() {
  const now = Date.now();
  if (_usagesCache.list && now - _usagesCache.at < TTL_MS) return _usagesCache.list;

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

  // 文件级缓存：每个文件按 mtime+size 去重解析
  const _fileCache = new Map();
  const results = [];
  for (const { f, mtimeMs, size } of files) {
    const hit = _fileCache.get(f);
    let arr;
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      arr = hit.list;
    } else {
      arr = parseFileUsages(f);
      _fileCache.set(f, { mtimeMs, size, list: arr });
    }
    results.push(...arr);
  }

  // 全局去重：同 sessionId + agentMessageId 可能跨文件（老文件留存），
  // 按 ts 最大的那个覆盖
  const global = new Map();
  for (const r of results) {
    const key = r.sessionId + '|' + r.agentMessageId;
    const old = global.get(key);
    if (!old || r.ts > old.ts) global.set(key, r);
  }
  const list = [...global.values()].sort((a, b) => b.ts - a.ts);

  _usagesCache = { at: now, list };
  return list;
}

/**
 * 只取某条会话的 token 消耗事件。
 * @param {string} sessionId
 */
function traeTokenOf(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return [];
  return allTokenUsages().filter((r) => r.sessionId === sid);
}


/* ───────────── 原 traeModels.js ───────────── */




const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

/** TraeCode 记"每个会话选了哪个模型"的那条 ItemTable key（前缀是用户 id，只认后缀） */
const TRAE_MODEL_KEY_SUFFIX = ':AI.agent.model.session_selected_model';
/** vscdb 是 TraeCode 自己在写的库：开一次留一小会儿，别在 1.5s 快轮询里反复开 */
const TRAE_MODEL_TTL_MS = 15_000;
let traeModelCache = { at: 0, map: null };

/** renderer.log 里模型变更事件的标记（行尾跟一段 JSON，逐行追加、只追加） */
const TRAE_LOG_EVENT = 'session selected model changed';
/** 日志扫描同样带 TTL + 按 mtime/size 增量：文件没变就不重读 */
let traeLogCache = { at: 0, map: null };
const traeLogFileCache = new Map(); // renderer.log 绝对路径 → { mtimeMs, size, map }

/**
 * 从 TraeCode 的 modelId 里解出模型名：`solo_agent_1__deepseek-v4.1-flash_null` → `deepseek-v4.1-flash`。
 * 这个格式和 TraeCode 自己的 renderer.log 交叉核对过（`agent_1__Doubao-Seed-Code_null` ↔ `Doubao-Seed-Code`）。
 * 解不出来返回空串 —— 不猜。
 */
function traeModelName(modelId) {
  const s = String(modelId || '');
  const i = s.indexOf('__');
  if (i < 0) return '';
  return s.slice(i + 2).replace(/_null$/, '');
}

/**
 * 老版 Trae 的「会话 → 当前选中模型」表（globalStorage state.vscdb）。
 * @returns {Object|null} 读不到（没装 / 库被占 / 没这条 key）就是 null
 */
function traeSelectedModelsFromDb() {
  const now = Date.now();
  if (traeModelCache.map && now - traeModelCache.at < TRAE_MODEL_TTL_MS) return traeModelCache.map;
  for (const root of traeGlobalStorageRoots()) {
    const dbFile = path.join(root, 'state.vscdb');
    let db = null;
    try {
      if (!fs.existsSync(dbFile)) continue;
      const Database = require('better-sqlite3');
      db = new Database(dbFile, { readonly: true, fileMustExist: true });
      const rows = db.prepare('select value from ItemTable where key like ?').all(`%${TRAE_MODEL_KEY_SUFFIX}`);
      for (const r of rows) {
        const map = JSON.parse(String(r.value || '{}'));
        if (map && typeof map === 'object' && Object.keys(map).length) {
          traeModelCache = { at: now, map };
          return map;
        }
      }
    } catch {
      // 库被 TraeCode 占着 / 表结构不是预期的：这轮取不到就当没有，上层留空
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          /* 关不掉不影响读取结果 */
        }
      }
    }
  }
  traeModelCache = { at: now, map: null };
  return null;
}

/**
 * 解析一段 renderer.log 文本里的模型变更事件 → `{ sessionId: { agentLabel: { modelId } } }`。
 * 形状故意对齐 vscdb 那张表（只是键从 agentType 换成日志里的 agentLabel —— 值域一致，
 * selectedModelOf 的兜底链两头通用）。行尾 JSON 解析失败（半截行）就跳过这条。
 */
function parseTraeLogEvents(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(TRAE_LOG_EVENT);
    if (i < 0) continue;
    const brace = line.indexOf('{', i);
    if (brace < 0) continue;
    try {
      const j = JSON.parse(line.slice(brace));
      const sid = String(j.sessionId || '').trim();
      const modelId = j.nextSelection && j.nextSelection.modelId ? String(j.nextSelection.modelId) : '';
      const label = String(j.agentLabel || j.agentType || '').trim();
      if (!sid || !modelId || !label) continue;
      (out[sid] = out[sid] || {})[label] = { modelId };
    } catch {
      /* 半截行 / 非 JSON：跳过 */
    }
  }
  return out;
}



/**
 * 新版 Trae 的兜底表：从 logs/<启动>/windowN/renderer.log 的事件流里汇总。
 * 按 mtime 增量：文件没变（mtime+size 都没动）直接复用上次的解析结果，
 * 只有正在写的那个文件会重读。目录按 mtime 升序处理，后处理的覆盖先处理的 —— 同一会话
 * 以最新一次事件为准。
 * @returns {Object|null} 一条事件都没有就是 null
 */
function traeSelectedModelsFromLogs() {
  const now = Date.now();
  if (traeLogCache.map && now - traeLogCache.at < TRAE_MODEL_TTL_MS) return traeLogCache.map;
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
          /* 没有 renderer.log 的窗口：跳过 */
        }
      }
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.f < b.f ? -1 : 1));
  const seen = new Set(files.map((x) => x.f));
  for (const k of [...traeLogFileCache.keys()]) if (!seen.has(k)) traeLogFileCache.delete(k);
  let merged = null;
  for (const { f, mtimeMs, size } of files) {
    const hit = traeLogFileCache.get(f);
    let map;
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      map = hit.map;
    } else {
      try {
        map = parseTraeLogEvents(fs.readFileSync(f, 'utf8'));
      } catch {
        map = {};
      }
      traeLogFileCache.set(f, { mtimeMs, size, map });
    }
    if (map && Object.keys(map).length) merged = { ...(merged || {}), ...map };
  }
  traeLogCache = { at: now, map: merged };
  return merged;
}

/**
 * TraeCode 的「会话 → 当前选中模型」表：老版走 vscdb，新版走日志事件，按会话 id 合并
 * （同一会话 id 只会存在于其中一路；万一两路都有，结构化落盘的 vscdb 优先）。
 * @returns {Object|null} 两路都取不到就是 null
 */
function traeSelectedModels() {
  const db = traeSelectedModelsFromDb();
  const logs = traeSelectedModelsFromLogs();
  if (!db) return logs;
  if (!logs) return db;
  return { ...logs, ...db };
}

/**
 * 这条 TraeCode 会话在用什么模型。
 * @param {string} sessionId hook payload 的 session_id
 * @param {string} agentType hook payload 的 agent_type（已落盘），决定取 agent / solo_agent 哪一项
 * @returns {string} 取不到返回空串
 */
function selectedModelOf(sessionId, agentType = '') {
  const sid = String(sessionId || '').trim();
  if (!sid) return '';
  const sel = (traeSelectedModels() || {})[sid];
  if (!sel) return '';
  const prefer = String(agentType || '').trim();
  for (const k of [prefer, 'solo_agent', 'agent', 'solo_coder']) {
    if (k && sel[k] && sel[k].modelId) {
      const name = traeModelName(sel[k].modelId);
      if (name) return name;
    }
  }
  return '';
}



/**
 * Trae 的后台 flush：把"结束状态的唯一真相"补进台账。由 sessionRegistry 的楼层循环调用
 * （在通用 flush 之前跑，否则 superseded 会把 Trae 正常完成的 running 任务先改成 cancelled）。
 * 两个动作：① DoneHandler status → bus.endTask（最终状态真相）；② usage_tail → 只补金额。
 *
 * 这里集中了 5F 与台账交互的全部逻辑，调试 Trae 不必碰 sessionRegistry。
 * @param {object} ctx 框架提供的共享上下文（now / backend）
 */
const postedDoneHandler = new Map(); // key → 过期时间戳
const postedYuan = new Map(); // key → 过期时间戳

function flushTraeDone(now, backend) {
  const { bus, repo } = backend || {};
  if (!bus || typeof bus.endTask !== 'function' || !repo) return;
  const handlers = allDoneHandlers();
  if (!Object.keys(handlers).length) return;

  // sessionId → { projectId, workspacePath }，从 hook 状态文件反查（同 flushTraeYuan）
  const hookDir = path.join(os.homedir(), '.workgremlin', 'hooks');
  const sidProject = new Map();
  try {
    for (const f of fs.readdirSync(hookDir)) {
      if (!/\.json$/i.test(f)) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(hookDir, f), 'utf8')); } catch { continue; }
      if (!j || !j.sessionId) continue;
      const ws = j.taskWorkspacePath || j.sessionWorkspacePath || '';
      if (!ws) continue;
      const proj = repo.getProjectByWorkspace ? repo.getProjectByWorkspace.get(path.resolve(ws)) : null;
      if (proj) sidProject.set(j.sessionId, { projectId: proj.id, workspacePath: ws });
    }
  } catch { /* no hook dir */ }

  // 按 at 升序处理——最早的 DoneHandler 先匹配最早结束的 running 任务
  const sorted = [...handlers].sort((a, b) => a.at - b.at);
  for (const h of sorted) {
    const sid = h.sessionId;
    if (!sid || !h.at) continue;
    const info = sidProject.get(sid);
    if (!info) continue;
    const key = `${sid}|${h.agentMessageId}|${h.status}|${h.at}`;
    if (postedDoneHandler.get(key) > now) continue;
    const proj = repo.getProjectByWorkspace ? repo.getProjectByWorkspace.get(info.workspacePath) : null;
    if (!proj) continue;
    const all = repo.listStaleRunningBySession ? repo.listStaleRunningBySession.all(proj.id, sid) : [];
    const atH = Number(h.at) || 0;
    const match = all
      .filter((r) => Number(r.startedAt) && (!atH || Number(r.startedAt) <= atH))
      .sort((a, b) => Number(b.startedAt) - Number(a.startAt))[0];
    if (!match) continue;
    const state = h.status === 'completed' ? 'done' : 'cancelled';
    const task = repo.getTask ? repo.getTask.get(match.id) : null;
    if (!task) continue;
    postedDoneHandler.set(key, now + 10 * 60_000);
    try {
      bus.endTask({
        project: proj.id,
        memberId: task.member_id,
        taskId: match.id,
        state,
        model: task.model || '',
        result: String(task.result || ''),
        form: task.form || '',
        sessionId: sid,
        ts: h.at, // DoneHandler 写入时刻 = 这轮真实结束时刻
      });
    } catch { /* 补发失败不影响台账 */ }
  }
  for (const [k, v] of postedDoneHandler) if (v <= now) postedDoneHandler.delete(k);
}

function flushTraeYuan(now, backend) {
  const { repo } = backend || {};
  if (!repo) return;
  const usages = allTokenUsages();
  if (!usages.length) return;

  const hookDir = path.join(os.homedir(), '.workgremlin', 'hooks');
  const sidProject = new Map();
  try {
    for (const f of fs.readdirSync(hookDir)) {
      if (!/\.json$/i.test(f)) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(hookDir, f), 'utf8')); } catch { continue; }
      if (!j || !j.sessionId) continue;
      const ws = j.taskWorkspacePath || j.sessionWorkspacePath || '';
      if (!ws) continue;
      const proj = repo.getProjectByWorkspace ? repo.getProjectByWorkspace.get(path.resolve(ws)) : null;
      if (proj) sidProject.set(j.sessionId, { projectId: proj.id, workspacePath: ws });
    }
  } catch { /* no hook dir */ }

  for (const u of usages) {
    const sid = u.sessionId;
    if (!sid) continue;
    const info = sidProject.get(sid);
    if (!info) continue;
    const key = `${sid}|${u.agentMessageId}|${u.usageYuan}`;
    if (postedYuan.get(key) > now) continue;
    const row = repo.runAwaitingYuan.get(info.projectId, sid, u.ts);
    if (!row) continue;
    repo.setTaskRunYuan.run({ id: row.id, usageYuan: u.usageYuan });
    postedYuan.set(key, now + 10 * 60_000);
  }
  for (const [k, v] of postedYuan) if (v <= now) postedYuan.delete(k);
}

function flushBackend(ctx) {
  const now = ctx.now;
  const backend = ctx.backend;
  flushTraeDone(now, backend);
  flushTraeYuan(now, backend);
}

module.exports = {
  // 5F TraeCode
  id: '5F',
  client: 'trae',
  meta,
  flushBackend,
  // 取消检测（原 traeCancel.js）
  allCancels,
  allDoneHandlers,
  traeDoneStatus,
  // token 金额（原 traeTokens.js）
  allTokenUsages,
  traeTokenOf,
  // 模型补全（原 traeModels.js）
  selectedModelOf,
  traeModelName,
  traeSelectedModels,
  parseTraeLogEvents,
  // 统一接口别名
  cancelAt: traeCancelAt,
  modelOf: selectedModelOf,
  // 完成/取消标记合成：交给 readReporterDones 统一派发（sessions.js 公共代码不掺 Trae 专属逻辑）
  synthMarks,
};

/**
 * 楼层特有的"完成/取消"标记合成，由 sessions.js 的 readReporterDones 统一派发。
 * 公共代码里不写任何 TraeCode 专属逻辑：这里只认 Trae 自己的 renderer.log（DoneHandler / allCancels）。
 *
 * 为什么独立扫、不绑在 hook 状态文件的 `if (j.taskId)` 上：
 *   · Trae 取消时 Stop hook 不触发，唯一权威信号是 renderer.log。
 *   · hook 状态文件"一份会话一份"，新一轮一开就覆盖旧的 taskId / taskStartedAt；
 *     绑在 startedAt 上会让"上一轮取消 → 新一轮启动"窗口一过的旧取消信号被过滤掉。
 *   · 渲染层用 "phase.ts vs done.at 谁更新" 决定显示，done.at 旧但 phase.ts 新 → 新一轮覆盖 cancelled，
 *     不会误亮红灯，所以无需 smart 过滤。
 *
 * @param {object} ctx
 *   { workspacePath, client, hookBySid, clientHit, roundFilesOf, synthCancel, synthDone, bySession }
 */
function synthMarks(ctx) {
  const { workspacePath, client, hookBySid, clientHit, roundFilesOf, synthCancel, synthDone, bySession } = ctx;
  // ── 先扫 DoneHandler（最终状态真相）──
  // completed → 合成正常完成标记（cancelled:false，覆盖可能存在的 cancelled:true）
  // canceled  → 合成取消标记（同 synthCancel）
  const handlers = allDoneHandlers();
  for (const h of handlers) {
    const sid = h.sessionId;
    if (!sid || !h.at) continue;
    const hook = hookBySid.get(sid);
    const j = hook ? hook.j : null;
    const hookWs = j ? ((j.done && j.done.workspacePath) || j.taskWorkspacePath || '') : '';
    if (workspacePath && hookWs && path.resolve(hookWs) !== path.resolve(workspacePath)) continue;
    if (j && client && !clientHit(client, j.client)) continue;
    if (h.status === 'completed') {
      // DoneHandler completed → 正常完成标记（cancelled:false），覆盖 bySession 里已有的 cancelled:true；
      // 只在 DoneHandler at 更大时覆盖 —— completed 信号本应比取消信号晚到。
      synthDone({
        id: sid,
        ws: hookWs || workspacePath || '',
        at: h.at,
        title: (j && j.taskTitle) || '',
        files: [],
      });
    } else {
      // DoneHandler canceled → 同 synthCancel；已有同取消（±5s 容差）则跳过，避免重复合成
      const existing = bySession.get(sid);
      if (existing && existing.cancelled && Math.abs(Number(existing.at) - h.at) < 5_000) continue;
      synthCancel({
        id: sid,
        j: j ? { taskTitle: j.taskTitle || '', client: j.client } : { taskTitle: '', client: 'trae' },
        ws: hookWs || workspacePath || '',
        at: h.at,
        files: j ? roundFilesOf(j) : [],
      });
    }
  }

  // ── 再扫 allCancels（更早的取消信号，作补充）──
  // DoneHandler 已给该会话写 mark → 跳过（DoneHandler 更权威）
  const traeCancels = allCancels();
  const traeSids = Object.keys(traeCancels || {});
  if (traeSids.length) {
    for (const sid of traeSids) {
      const atC = Number(traeCancels[sid]) || 0;
      if (!atC) continue;
      if (bySession.has(sid)) continue;
      const hook = hookBySid.get(sid);
      const j = hook ? hook.j : null;
      const hookWs = j ? ((j.done && j.done.workspacePath) || j.taskWorkspacePath || '') : '';
      if (workspacePath && hookWs && path.resolve(hookWs) !== path.resolve(workspacePath)) continue;
      if (j && client && !clientHit(client, j.client)) continue;
      synthCancel({
        id: sid,
        j: j ? { taskTitle: j.taskTitle || '', client: j.client } : { taskTitle: '', client: 'trae' },
        ws: hookWs || workspacePath || '',
        at: atC,
        files: j ? roundFilesOf(j) : [],
      });
    }
  }
}
