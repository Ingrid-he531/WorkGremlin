'use strict';

/**
 * TraeCode（Trae / Trae CN）token 消耗（金额）解析 —— 从 renderer.log 的
 * `cn_session_usage_tail` 事件里挖出来。
 *
 * 为什么单独成文件、而不是并进 traeCancel.js / traeModels.js：
 *   · 取消 / 模型 / 金额 三条信号互不依赖、各自独立更新频率（取消是 stop 触发一次，
 *     模型是切换触发一次，金额是每轮结束显示一次）。分开写各自的去重 / 缓存更简单。
 *   · 但**读法完全同口径**：traeLogRoots() → 遍历所有 renderer.log → mtime+size 增量缓存。
 *
 * Trae 的 cn_session_usage_tail 事件（renderer.log 行尾 JSON）：
 *   {"action":"show","session_id":"…","user_message_id":"…","agent_message_id":"…","usage_summary":"12.50"}
 *   usage_summary 是**人民币金额**（不是 token 数！），同一 agent_message_id 可能被发 2-3 次，
 *   按 session_id + agent_message_id 去重取最新 ts。
 *
 * 为什么只有金额、没有 token 分项（input_tokens / output_tokens）：
 *   · Trae 的 ai-agent/database.db 是加密的（SQLCipher），renderer.log 里也搜不到 token 分项。
 *   · 我们只能拿到金额 → 单独存 task_runs.usage_yuan REAL 列，不硬塞进 token 列。
 *
 * 与 sessionRegistry 的集成点：
 *   · sessionRegistry.refresh() 末尾扫 allTokenUsages()，按 sessionId + 时间窗
 *     匹配 task_runs 里 usage_yuan IS NULL 的行，补上金额（见 flushTraeYuan）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { traeLogRoots } = require('./products');

const TTL_MS = 15_000;
let _cache = { at: 0, list: null };

function safeReadDir(p) { try { return fs.readdirSync(p); } catch { return []; } }
function isDirSafe(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

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
  if (_cache.list && now - _cache.at < TTL_MS) return _cache.list;

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

  _cache = { at: now, list };
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

module.exports = { allTokenUsages, traeTokenOf };
