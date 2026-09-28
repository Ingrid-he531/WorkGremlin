'use strict';

/**
 * TraeCode 的「会话 → 当前选中模型」补全。
 *
 * 为什么单独成文件：这段是 sessions.js 里唯一一个打开第三方 SQLite（better-sqlite3）、
 * 持有句柄、带自己 TTL 缓存的逻辑，跟该文件其余"读 json + mtime"的均质性冲突；
 * 而且 Trae 家族的"根在哪"已经放在 products.js 的 traeGlobalStorageRoots()/traeLogRoots()，
 * 这里只负责"根下的 state.vscdb / renderer.log 怎么读"，成对，避免同一个产品的知识被劈成两半。
 *
 * hook payload 不带模型字段（TraeCode 六个事件都不带），只能从它自己的落盘里捞。两路来源：
 *
 * 1. 老版 Trae 的 globalStorage state.vscdb：key `<uid>:AI.agent.model.session_selected_model`，
 *    值 `{ sessionId: { agentType: { modelId } } }`。
 * 2. 新版 Trae（2026-09 起的版本）把这条 key 彻底废弃 —— 选择搬进内存态 core store，
 *    落盘走加密库（ModularData/ai-agent/database.db），读不了；唯一明文来源是它自己的
 *    renderer.log：每次模型变更都记一条
 *    `[model-store] session selected model changed {"sessionId":…,"agentLabel":…,"nextSelection":{"modelId":…}}`。
 *    故 vscdb 取不到时按日志事件兜底（session 一多也只重读 mtime 变了的文件）。
 *
 * 取不到（没装 / 库被占 / 没这条 key / 日志里没这条会话）一律返回空串 —— 不拿默认模型冒充（绝不编造）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { traeGlobalStorageRoots, traeLogRoots } = require('./products');

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

function readDirSafe(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
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
    for (const launch of readDirSafe(logsRoot)) {
      const launchDir = path.join(logsRoot, launch);
      if (!isDirSafe(launchDir)) continue;
      for (const win of readDirSafe(launchDir)) {
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

function isDirSafe(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
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

module.exports = { selectedModelOf, traeModelName, traeSelectedModels, parseTraeLogEvents };
