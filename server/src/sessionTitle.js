'use strict';

/**
 * 会话标题：给"这一轮属于哪条会话"一个**会话级**的名字 ——
 * 同一 session_id 的所有任务拿到同一个值，凭它把同一会话的多轮任务认出来
 * （一轮 = 一行任务，一条会话通常有多轮；各轮自己的标题互不相同，只有会话标题是共同的）。
 *
 * 两条来源，按顺序取：
 *   1. 各楼层自己的会话标题（agent 起的摘要，与用户原话不同）：
 *        7F Kilo Code → SQLite session.title
 *        8F OpenCode  → SQLite session.title
 *        6F Qoder     → SQLite chat_session.session_title
 *   2. **兜底（所有楼层）**：这条会话第一轮的用户原话。
 *      会话开始时的标题就是用户原话 —— 1F/2F/3F/4F/5F/9F 没有第 1 条那种摘要列，
 *      但它们每一轮的 prompt 都在 tasks.title 里，取同一 session_id 里**最早那一轮**的即可，
 *      见 sessionFirstPrompts()。
 *
 * 纪律：任何一层查不到（库没装 / 表结构变了 / session_id 为空 / 兜底也没那一轮）
 * 一律回空串，绝不冒泡、绝不编造。每个 query(fn) 内部已经 try/catch + close。
 */

const os = require('node:os');
const path = require('node:path');
// better-sqlite3 把构造函数挂在 module.exports 上（没有 .Database 具名导出）——
// 写成 `const { Database } = require(...)` 拿到的是 undefined，`new Database()` 抛 TypeError，
// 被 openReadonly 的 try/catch 一吞就成了"库打不开"，会话标题永远查成空串。
// 项目里其它文件（db/index.js、kilo.js、lingma.js…）都是直接 require 拿构造函数。
const Database = require('better-sqlite3');

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
 * 占位标题：Kilo 起会话时默认写的是 "New session - <ISO 时间戳>"（它自己占的位，
 * 不是摘要）。把它当"有标题"列出来，详情里就多一行时间戳，纯噪声 —— 一律当没有。
 */
const PLACEHOLDER_TITLE = /^new session\b/i;

/**
 * 根据 client 分发到对应楼层查 title。找不到、库没装、表结构变了、查出来是占位名
 * 一律回空串。
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
    if (!r.match.test(c)) continue;
    const title = r.fn(sid);
    return title && !PLACEHOLDER_TITLE.test(title) ? title : '';
  }
  return '';
}

/* ------------------------------ 兜底：会话第一轮的用户原话 ------------------------------ */

/**
 * 老数据（hook 修掉之前）把 IDE 注入的那段上下文整段当标题存了下来 ——
 * `# Context from my IDE setup: ## Active file: …`。规则与前端 promptOf()、
 * hook 侧 userRequestText 保持一致：只在真出现那段上下文时才按「My request:」切开取后面。
 */
const IDE_INJECTED = [/^[ \t]*#{0,6}[ \t]*Context from my IDE setup\b/im, /^[ \t]*#{1,6}[ \t]*(?:Active file|Open tabs)\b/im];
const REQUEST_SPLIT = /^[ \t]*#{0,6}[ \t]*(?:My request|User request|Request|我的请求|用户请求)[ \t]*[:：][ \t]*$/im;

/** 一条 tasks.title → 用户原话（首行，够当标题用；过长截断，免得详情那一行撑爆） */
function userRequestOf(raw) {
  const s = String(raw || '').replace(/\r\n?/g, '\n');
  if (!s.trim()) return '';
  const text = IDE_INJECTED.some((re) => re.test(s)) ? (s.split(REQUEST_SPLIT).slice(1).join('\n') || '') : s;
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
  return first.length > 120 ? `${first.slice(0, 120)}…` : first;
}

/**
 * 一批会话各自"第一轮说了什么"（用户原话）。
 *
 * 只查一次：按 session_id 分组取 started_at 最小的那一轮 —— SQLite 的规矩是
 * `MIN()` 与裸列同用时，裸列取自 MIN 命中的那一行，所以 t.title 就是最早那轮的标题。
 *
 * @param {import('better-sqlite3').Database|null} raw 主库（只读用）
 * @param {string[]} sessionIds
 * @returns {Map<string, string>} 查不到的会话不在表里（调用方当"没有"）
 */
function sessionFirstPrompts(raw, sessionIds) {
  const out = new Map();
  const ids = [...new Set(sessionIds.map((s) => String(s || '').trim()).filter(Boolean))];
  if (!raw || !ids.length) return out;
  // 占位符别一次塞太多（SQLite 默认上限 999）：分批查
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const holes = chunk.map(() => '?').join(',');
    try {
      const rows = /** @type {Array<{ sid: string, title: string }>} */ (
        raw
          .prepare(
            `SELECT tr.session_id AS sid, t.title AS title, MIN(t.started_at) AS started_at
               FROM tasks t
               JOIN task_runs tr ON tr.id = t.id
              WHERE tr.session_id IN (${holes})
              GROUP BY tr.session_id`
          )
          .all(...chunk)
      );
      for (const r of rows) {
        const title = userRequestOf(r.title);
        if (title) out.set(String(r.sid), title);
      }
    } catch {
      /* 表结构变了 / 库被锁：这一批没有，调用方按"没有会话标题"走，不编造 */
    }
  }
  return out;
}

module.exports = {
  resolveSessionTitle,
  sessionFirstPrompts,
  userRequestOf,
};