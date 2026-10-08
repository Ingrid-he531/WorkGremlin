'use strict';

/**
 * 根据 session_id + client 查会话标题。
 *
 * 哪些楼层有独立的会话标题（agent 自动生成、与用户原话不同）：
 *   7F Kilo Code   → SQLite session.title（agent 起的摘要，如 "feat: add login"）
 *   8F OpenCode    → SQLite session.title（同上）
 *   6F Qoder       → SQLite chat_session.session_title（同上）
 *
 * 其他楼层（1F CodeBuddy / 2F WorkBuddy / 3F Codex / 4F Claude / 5F Trae / 9F Copilot）
 * 没有独立的会话标题 —— 它们的任务标题就是用户原话（已经在 tasks.title 里了），
 * 所以这里找不到就如实回空，调用方会退回 promptOf(t)。
 *
 * 纪律：任何一层查不到（库没装 / 表结构变了 / session_id 为空）一律回空串，
 * 绝不冒泡、绝不编造。每个 query(fn) 内部已经 try/catch + close。
 */

const os = require('node:os');
const path = require('node:path');
const { Database } = require('better-sqlite3');

const OPEN_TIMEOUT_MS = 3_000;
const HOME = os.homedir();

function openReadonly(file) {
  if (!file) return null;
  try {
    return new Database(file, { readonly: true, fileMustExist: true, timeout: OPEN_TIMEOUT_MS });
  } catch {
    return null;
  }
}

function readOne(db, sql, ...params) {
  if (!db) return null;
  try {
    return db.prepare(sql).get(...params);
  } catch {
    return null;
  }
}

/* ------------------------------ 7F Kilo Code ------------------------------ */

function kiloDbPath() {
  const kiloHome = process.env.KILO_HOME || path.join(HOME, '.local', 'share', 'kilo');
  return path.join(kiloHome, 'kilo.db');
}

function kiloTitleOf(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const db = openReadonly(kiloDbPath());
  if (!db) return '';
  try {
    const row = readOne(db, 'SELECT title FROM session WHERE id = ?', id);
    return String((row && row.title) || '').trim();
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------ 8F OpenCode ------------------------------ */

function opencodeDbPath() {
  const home = process.env.OPENCODE_HOME || path.join(HOME, '.local', 'share', 'opencode');
  return path.join(home, 'opencode.db');
}

function opencodeTitleOf(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const db = openReadonly(opencodeDbPath());
  if (!db) return '';
  try {
    let titleCol = '"title"';
    const cols = readOne(db, "PRAGMA table_info('session')");
    const hasTitle = Array.isArray(cols)
      ? cols.some((c) => String(c.name || '').toLowerCase() === 'title')
      : false;
    if (!hasTitle) {
      const row = readOne(db, 'SELECT * FROM session WHERE id = ? LIMIT 1', id);
      if (row && typeof row === 'object') {
        const keys = Object.keys(row).filter((k) => /title/i.test(k));
        if (keys.length) titleCol = `"${keys[0]}"`;
      }
    }
    const row = readOne(db, `SELECT ${titleCol} AS t FROM session WHERE id = ?`, id);
    return String((row && row.t) || '').trim();
  } catch {
    return '';
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------ 6F Qoder / Lingma ------------------------------ */

function lingmaDbPath() {
  const home = process.env.LINGMA_HOME || path.join(HOME, '.lingma');
  return path.join(home, 'vscode', 'sharedClientCache', 'cache', 'db', 'local.db');
}

function lingmaTitleOf(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const db = openReadonly(lingmaDbPath());
  if (!db) return '';
  try {
    const row = readOne(db, 'SELECT session_title FROM chat_session WHERE session_id = ?', id);
    return String((row && row.session_title) || '').trim();
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------ 分发 ------------------------------ */

const ROUTERS = [
  { match: /^kilo(?:-plugin)?$/i, fn: kiloTitleOf },
  { match: /^opencode(?:-plugin)?$/i, fn: opencodeTitleOf },
  { match: /^qoder(?:-plugin)?$/i, fn: lingmaTitleOf },
];

/**
 * 根据 client 分发到对应楼层查 title。找不到、库没装、表结构变了一律回空串。
 * @param {string|null|undefined} sessionId
 * @param {string|null|undefined} client
 * @returns {string}
 */
function resolveSessionTitle(sessionId, client) {
  const sid = String(sessionId || '').trim();
  if (!sid) return '';
  const c = String(client || '').trim();
  if (!c) return '';
  for (const r of ROUTERS) {
    if (r.match.test(c)) return r.fn(sid);
  }
  return '';
}

module.exports = {
  resolveSessionTitle,
};