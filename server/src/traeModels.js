'use strict';

/**
 * TraeCode 的「会话 → 当前选中模型」补全。
 *
 * 为什么单独成文件：这段是 sessions.js 里唯一一个打开第三方 SQLite（better-sqlite3）、
 * 持有句柄、带自己 TTL 缓存的逻辑，跟该文件其余"读 json + mtime"的均质性冲突；
 * 而且 Trae 家族的"根在哪"已经放在 products.js 的 traeGlobalStorageRoots()，
 * 这里只负责"根下的 state.vscdb 怎么读"，成对，避免同一个产品的知识被劈成两半。
 *
 * hook payload 不带模型字段（TraeCode 六个事件都不带），只能从它自己的 globalStorage
 * state.vscdb 里捞：key `<uid>:AI.agent.model.session_selected_model`，
 * 值 `{ sessionId: { agentType: { modelId } } }`。
 *
 * 取不到（没装 / 库被占 / 没这条 key）一律返回空串 —— 不拿默认模型冒充（绝不编造）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { traeGlobalStorageRoots } = require('./products');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

/** TraeCode 记"每个会话选了哪个模型"的那条 ItemTable key（前缀是用户 id，只认后缀） */
const TRAE_MODEL_KEY_SUFFIX = ':AI.agent.model.session_selected_model';
/** vscdb 是 TraeCode 自己在写的库：开一次留一小会儿，别在 1.5s 快轮询里反复开 */
const TRAE_MODEL_TTL_MS = 15_000;
let traeModelCache = { at: 0, map: null };

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
 * TraeCode 的「会话 → 当前选中模型」表。
 * @returns {Object|null} 读不到（没装 / 库被占 / 没这条 key）就是 null
 */
function traeSelectedModels() {
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

module.exports = { selectedModelOf, traeModelName, traeSelectedModels };
