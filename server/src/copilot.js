'use strict';

/**
 * 9F GitHub Copilot 楼层模块 —— 把「数据源读取」与「台账同步器」合并到这一个文件
 * （原 sessions.js 里的 Copilot 读取函数 + copilotTasks.js 的同步器）。
 *
 * 9F 没有 hook、也没有 reporter，任务只能靠服务端轮询它自己的落盘：
 *   · session-store.db（GitHub Copilot 的 SQLite 会话库，见 readCopilotTurns / readCopilotFiles）
 *   · VS Code 的 state.vscdb 聊天索引（readCopilotChatIndex，唯一能看见「轮进行中」的旁证）
 *   · VS Code 的 chatSessions/<会话>.jsonl 会话日志（readCopilotLiveRequest，取用户原话/起止/在飞）
 *
 * sessions.js 的共享分发器（listSessions / readSqliteSessionRows）仍在这里调用本文件的
 * 读取函数（通过 C.readCopilotX），本文件则延迟取用 sessions.js（sess()），避免循环加载拿到半成品。
 *
 * 统一接口（见 floors.js 的 FLOOR_CONTRACT）：
 *   id / client   楼层身份
 *   syncTasks     = syncCopilotTasks
 *   readPhase     = readCopilotPhaseFromSqlite
 *   readDone      = readCopilotDone
 *   modelOf       = copilotCurrentModel
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { clientBase, clientOf } = require('@workgremlin/shared');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

// 原本定义在 products.js（findDataPath 的 copilot 分支 + 本楼层 pluginRe 都要它）。
// 为了"新增楼层不碰中央文件"且不引入循环 require，把它挪到本文件（9F 专属）。
const RE_GITHUB_COPILOT = [/^github\.copilot/i, /^github-copilot/i, /^github\.copilot-chat/i, /^copilot/i];

// sessions.js 与 copilot.js 互相 require：延迟取用，避免循环加载时拿到半成品 exports。
function sess() { return require('./sessions'); }

// 三个极小的通用文件工具（与 sessions.js 同款；本文件读取函数用到）
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function readDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}
/* ───────────── 原 sessions.js 的 Copilot 读取函数 ───────────── */

/**
 * 读 Copilot `turns` 表：每个会话的 turn 数 + 最后一条 user_message。
 * 表不存在 / 列名变了对上层透明（回空 Map，调用方照常工作）。
 */
function readCopilotTurns(db) {
  const out = new Map();
  try {
    const cols = db.prepare('PRAGMA table_info(turns)').all().map((c) => String(c.name || '').trim());
    if (!cols.length) return out;
    const sidCol = cols.includes('session_id') ? 'session_id' : cols.includes('sid') ? 'sid' : '';
    const msgCol = cols.includes('user_message') ? 'user_message' : '';
    const respCol = cols.includes('assistant_response') ? 'assistant_response' : cols.includes('response') ? 'response' : '';
    const tsCol = cols.includes('timestamp') ? 'timestamp' : '';
    if (!sidCol) return out;
    // 每个 session_id 取 turn 数 + 按 timestamp 倒序的第一条 user_message
    const countRows = db.prepare(`SELECT ${sidCol} as sid, COUNT(*) as cnt FROM turns GROUP BY ${sidCol}`).all();
    for (const r of countRows) {
      const sid = String(r.sid || '').trim();
      if (sid) out.set(sid, { turnCount: r.cnt, lastUserMessage: '', hasPendingTurn: false });
    }
    // 有空 assistant_response 的 turn = AI 还没写完回复 → 这条会话正在跑
    // （Copilot 是批次写入：只在用户发消息时写 turn 行，AI 回复完了才更新 assistant_response。
    //  所以"空回复的 turn"是"正在生成"的硬证据，比看 updated_at 新鲜度准得多。）
    if (respCol) {
      const pendingRows = db.prepare(`SELECT ${sidCol} as sid FROM turns WHERE ${respCol} IS NULL OR TRIM(${respCol}) = ''`).all();
      for (const r of pendingRows) {
        const sid = String(r.sid || '').trim();
        if (sid) {
          const existing = out.get(sid) || { turnCount: 0, lastUserMessage: '', hasPendingTurn: false };
          existing.hasPendingTurn = true;
          out.set(sid, existing);
        }
      }
    }
    // 逐轮清单：任务台账按「每一轮一条」记账要用（轮序号 + 用户原话 + 时间 + 有没有回复）。
    // 列缺失（老版本）就跳过 —— 上层照常工作，只是没有逐轮台账。
    const idxCol = cols.includes('turn_index') ? 'turn_index' : '';
    if (idxCol && msgCol) {
      const tsSel = tsCol ? `, ${tsCol} as ts` : '';
      const pendSel = respCol ? `, (${respCol} IS NULL OR TRIM(${respCol}) = '') as pend` : ', 0 as pend';
      for (const r of db.prepare(`SELECT ${sidCol} as sid, ${idxCol} as idx, ${msgCol} as msg${pendSel}${tsSel} FROM turns`).all()) {
        const sid = String(r.sid || '').trim();
        if (!sid) continue;
        const existing = out.get(sid) || { turnCount: 0, lastUserMessage: '', hasPendingTurn: false };
        if (!Array.isArray(existing.turns)) existing.turns = [];
        existing.turns.push({
          index: Number(r.idx) || 0,
          userMessage: String(r.msg || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          at: r.ts ? Number(new Date(String(r.ts)).getTime()) || 0 : 0,
          pending: Boolean(r.pend),
        });
        out.set(sid, existing);
      }
      for (const v of out.values()) if (Array.isArray(v.turns)) v.turns.sort((a, b) => a.index - b.index);
    }
    if (msgCol && tsCol) {
      const lastRows = db.prepare(`SELECT ${sidCol} as sid, ${msgCol} as msg FROM turns ORDER BY datetime(${tsCol}) DESC`).all();
      for (const r of lastRows) {
        const sid = String(r.sid || '').trim();
        const msg = String(r.msg || '').trim();
        if (sid && msg) {
          const existing = out.get(sid) || { turnCount: 0, lastUserMessage: '', hasPendingTurn: false };
          if (!existing.lastUserMessage) {
            existing.lastUserMessage = msg.slice(0, 200);
            out.set(sid, existing);
          }
        }
      }
    } else if (msgCol) {
      // 没 timestamp 列就取最后一条（靠默认 rowid 顺序）
      const lastRows = db.prepare(`SELECT ${sidCol} as sid, ${msgCol} as msg FROM turns`).all();
      const seen = new Set();
      for (let i = lastRows.length - 1; i >= 0; i--) {
        const sid = String(lastRows[i].sid || '').trim();
        const msg = String(lastRows[i].msg || '').trim();
        if (sid && msg && !seen.has(sid)) {
          seen.add(sid);
          const existing = out.get(sid) || { turnCount: 0, lastUserMessage: '', hasPendingTurn: false };
          existing.lastUserMessage = msg.slice(0, 200);
          out.set(sid, existing);
        }
      }
    }
  } catch {
    /* Copilot 版本变了 turns 表名/列名 → 回空 */
  }
  return out;
}

/* ───────────── */

/**
 * 读 Copilot `session_files` 表：每个会话碰过的文件路径 + 工具名。
 * 表不存在 / 列名变了同样回空 Map。
 */
function readCopilotFiles(db) {
  const out = new Map();
  try {
    const cols = db.prepare('PRAGMA table_info(session_files)').all().map((c) => String(c.name || '').trim());
    if (!cols.length) return out;
    const sidCol = cols.includes('session_id') ? 'session_id' : cols.includes('sid') ? 'sid' : '';
    const pathCol = cols.includes('file_path') ? 'file_path' : cols.includes('path') ? 'path' : '';
    const toolCol = cols.includes('tool_name') ? 'tool_name' : cols.includes('tool') ? 'tool' : '';
    if (!sidCol || !pathCol) return out;
    const turnCol = cols.includes('turn_index') ? 'turn_index' : '';
    const orderCol = cols.includes('first_seen_at') ? 'first_seen_at' : cols.includes('created_at') ? 'created_at' : '';
    const rows = db
      .prepare(
        `SELECT ${sidCol} as sid, ${pathCol} as fp${toolCol ? `, ${toolCol} as tn` : ''}${turnCol ? `, ${turnCol} as ti` : ''} FROM session_files${orderCol ? ` ORDER BY datetime(${orderCol}) DESC` : ''}`
      )
      .all();
    for (const r of rows) {
      const sid = String(r.sid || '').trim();
      const fp = String(r.fp || '').trim();
      if (!sid || !fp) continue;
      // 只要**读**过的文件不算"改动文件"：Copilot 0.65.0 的 session_files 整表都是
      // read_file（实测），拿它当"这一轮改了什么"会把一堆没动过的文件报上去。
      const tool = toolCol ? String(r.tn || '').trim() : '';
      if (tool && !COPILOT_WRITE_TOOL_RE.test(tool)) continue;
      // Copilot 把**它自己的**临时文件也记进 session_files（工具调用的附件、
      // chat-session-resources/.../content.txt 之类，全在 VS Code 的 workspaceStorage /
      // globalStorage 下）。那些不是"这一轮改动的文件"，混进任务记录的文件清单只会误导
      // （实测 9F 的记录里近一半是这种内部文件）。这里按"在编辑器存储目录下"精确剔除，
      // 工程外的真实文件（比如另一个仓库）照旧保留。
      if (/[\\/]User[\\/](?:workspace|global)Storage[\\/]/i.test(fp)) continue;
      const arr = out.get(sid) || [];
      // 去重（同一个文件可能被多轮碰）
      if (!arr.some((f) => f.path === fp)) {
        // turn：这个文件是哪一轮碰的（台账按轮切分时用它）。
        // 拿不准就留 null —— Copilot 0.65.0 实测 turn_index 整列是 NULL（那整张表其实是
        // "这个会话见过的文件"），把它当成 0 会张冠李戴挂到第一轮上，宁可说不知道。
        arr.push({
          path: fp,
          tool: toolCol ? String(r.tn || '').trim() : '',
          turn: turnCol && r.ti != null && r.ti !== '' ? Number(r.ti) : null,
        });
        out.set(sid, arr);
      }
    }
  } catch {
    /* Copilot 版本变了 session_files 表名/列名 → 回空 */
  }
  return out;
}

/* ───────────── */

function readCopilotChatIndex() {
  const now = Date.now();
  const next = new Map();
  const out = new Map();
  let Database = null;
  try {
    Database = require('better-sqlite3');
  } catch {
    /* 没装原生依赖就退回时间窗推断 */
  }
  for (const root of sess().workspaceStorageRoots()) {
    for (const name of readDir(root)) {
      const dbFile = path.join(root, name, 'state.vscdb');
      if (!isFile(dbFile)) continue;
      let st = null;
      try {
        st = fs.statSync(dbFile);
      } catch {
        continue;
      }
      // 文件没动过、且上次读还在 TTL 内 → 直接用上次的结果（避免每 1.5s 开一次 SQLite）
      const prev = copilotIndexCache.get(dbFile);
      const unchanged = prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && now - prev.at < COPILOT_INDEX_TTL;
      let entries = prev ? prev.entries : null;
      if (Database && !unchanged) {
        let db = null;
        try {
          db = new Database(dbFile, { readonly: true, fileMustExist: true });
          const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'").get();
          const parsed = row && row.value ? JSON.parse(String(row.value)).entries : null;
          entries = parsed ? Object.entries(parsed) : null;
        } catch {
          /* 这个工作区的库读不到（被占用 / 版本变了）→ 换下一个 */
          entries = prev ? prev.entries : null;
        } finally {
          if (db) {
            try {
              db.close();
            } catch {
              /* 关不掉不影响读取 */
            }
          }
        }
      }
      next.set(dbFile, { mtimeMs: st.mtimeMs, size: st.size, at: now, entries: entries || null });
      for (const [sid, e] of entries || []) {
        const t = (e && e.timing) || {};
        out.set(String(sid), {
          lastRequestStarted: Number(t.lastRequestStarted) || 0,
          lastRequestEnded: Number(t.lastRequestEnded) || 0,
          hasPendingEdits: Boolean(e && e.hasPendingEdits),
          title: String((e && e.title) || ''),
          stats: (e && e.stats) || null,
        });
      }
    }
  }
  copilotIndexCache = next;
  return out;
}

/* ───────────── */

/**
 * 会话行上的"在飞"标记：true 在飞 / false 已收工 / null 没有旁证（退回时间窗推断）。
 *
 * 两份旁证（VS Code 的 chat 索引 / 会话日志）**谁知道的那一轮更新，就听谁**：
 * 索引常滞后（请求开始了它还没写），日志在请求开始就落；反过来日志的完成补丁又会晚一点到，
 * 所以不能简单地"谁说不忙就信谁"。另外 DB 里已经有这一轮的 turn 行 = 铁定收工
 * （Copilot 的 turn 行是整轮写完才落的）。
 */
function copilotInFlight(row) {
  if (!row) return null;
  const c = row.chat || null;
  const live = row.live || null;
  const turns = Array.isArray(row.turns) ? row.turns : [];
  const lastTurnIdx = turns.length ? Number(turns[turns.length - 1].index) : -1;
  // 日志**不早于**索引知道的那一轮就以日志为准。不能要求"严格更新"：实测这个 VS Code
  // 版本把索引的 lastRequestEnded 写成和 lastRequestStarted 一样（永远判不出在飞），
  // 平票时让索引压过日志，就会出现"日志明明说刚开跑、索引说已收工"→ 相位一直待命。
  const logKnowsNewer = Boolean(live && live.startedAt && (!c || live.startedAt >= (c.lastRequestStarted || 0)));
  if (logKnowsNewer) {
    if (live.index != null && lastTurnIdx >= Number(live.index)) return false; // 这一轮的 turn 行已经落了
    if (Date.now() - live.startedAt > 60 * 60_000) return false; // 太旧的"未完成"多半是残留，不算在飞
    return !live.completed;
  }
  if (c) return Boolean(c.lastRequestStarted && c.lastRequestStarted > c.lastRequestEnded);
  return null;
}

/* ───────────── */

/**
 * Copilot 会话"算不算正在跑"：有在途旁证就听它，没有才退回 updated_at 的 2 分钟窗口。
 * @param {{chat?: any, lastUpdated?: number}} row
 * @param {number} now
 */
function copilotInWindow(row, now) {
  const inFlight = copilotInFlight(row);
  if (inFlight !== null) return inFlight;
  return Boolean(row.lastUpdated && now - row.lastUpdated < COPILOT_PHASE_MS);
}

/* ───────────── */

/**
 * 9F 的「任务完成」时刻：会话日志里最新那一轮 request 的 completedAt（超 sess().DONE_TTL_MS 不算）。
 * Copilot 没有 hook 状态文件，完成标记只能从这份日志取 —— 与 kilo.js/opencode.js 的
 * read*Done 同一个口径（不靠"相位回落到空闲"来猜，避免中途误弹）。
 * @param {{live?: any}} row
 * @param {number} now
 * @returns {number} 0 = 没有（或已过期）
 */
function copilotDoneAt(row, now) {
  const live = row && row.live;
  const at = Number((live && live.completed && live.completedAt) || 0);
  if (!at || now - at > sess().DONE_TTL_MS) return 0;
  return at;
}

/* ───────────── */

/**
 * **别的产品**的结构化落盘里认领的会话 id（genie-history / todos / message-queue / file-changes）。
 *
 * 用途只有一个：9F 的台账同步器清理"张冠李戴"的历史行（见 copilotTasks.js 的
 * pruneForeignRunningRuns）。2026-09-30 实测的坑 —— 那个同步器原来用共享的 PLUGIN_RE 去要
 * 会话清单，`/^tencent/` 与 `/coding-copilot/` 会命中别的产品的插件目录（Tencent CodeBuddy 的
 * `tencent-cloud.coding-copilot`、Trae 的 coding-copilot），于是别的楼层正在跑的会话在 9F 被
 * 写成一条「(Copilot 会话)」在飞行 —— 用户根本没在 Copilot Chat 里输入，打开 VS Code 就冒一条。
 *
 * **只做归属判定，不改任何落盘**：把这个 id 交给调用方，由它决定"能证明是别人的"才收行。
 * @returns {Set<string>}
 */
function nonCopilotSessionIds() {
  const ids = new Set();
  for (const root of sess().globalStorageRoots()) {
    for (const name of readDir(root)) {
      if (COPILOT_STORAGE_RE.test(name)) continue; // Copilot 自己的目录不算"别的产品"
      const dir = path.join(root, name);
      const gh = path.join(dir, 'genie-history');
      for (const proj of readDir(gh)) {
        const pdir = path.join(gh, proj);
        for (const sid of readDir(path.join(pdir, 'conversations'))) ids.add(sid);
        // 工程级 current.json 也记着一条会话 id（会话目录可能已经不在，但这只会话还在跑）
        const cur = readJson(path.join(pdir, 'current.json'));
        const cid = cur && cur.conversationId ? String(cur.conversationId) : '';
        if (cid) ids.add(cid);
      }
      for (const f of readDir(path.join(dir, 'todos'))) {
        if (/\.json$/i.test(f)) ids.add(f.replace(/\.json$/i, ''));
      }
      for (const sid of readDir(path.join(dir, 'file-changes'))) ids.add(sid);
      for (const f of readDir(path.join(dir, 'message-queue'))) {
        if (!/\.json$/i.test(f)) continue;
        const j = readJson(path.join(dir, f));
        for (const sid of Object.keys((j && j.conversations) || {})) ids.add(sid);
      }
    }
  }
  return ids;
}

/* ───────────── */

/** 某条 Copilot 会话的 VS Code 会话日志（chatSessions/<会话>.jsonl） */
function copilotChatLogPath(sessionId) {
  const name = `${sessionId}.jsonl`;
  for (const root of sess().workspaceStorageRoots()) {
    for (const dir of readDir(root)) {
      const p = path.join(root, dir, 'chatSessions', name);
      if (isFile(p)) return p;
    }
  }
  return '';
}

/* ───────────── */

/**
 * 读 Copilot 会话日志的**尾部**，取最新那一轮请求。
 *
 * 这份日志（`workspaceStorage/<hash>/chatSessions/<会话>.jsonl`）是 VS Code 自己的会话状态
 * 补丁流：`{"kind":1,"k":["requests",<n>,"…"],"v":…}` 一条条追加。关键在**时机** ——
 * 最新一轮的 `requests` 数组（含用户原话 message.text 与起始 timestamp）在这一轮**开始**时
 * 就追加进去了（实测那一行里的 modelState 还是 {value:0}，完成时间稍后才以
 * `requests.<n>.modelState.completedAt` 补上）。所以它一次给出三样 Copilot 自己的 sqlite
 * 库给不了的东西：这一轮在不在飞、用户原话、起止时间。
 *
 * @param {string} sessionId
 * @returns {{index: number|null, prompt: string, startedAt: number, completed: boolean,
 *            completedAt: number, reqs: Array<{index: number, startedAt: number, endedAt: number}>,
 *            changed: Array<{index: number, files: string[]}>}|null}
 */
function readCopilotLiveRequest(sessionId) {
  const file = copilotChatLogPath(sessionId);
  if (!file) return null;
  let st = null;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${st.mtimeMs}@@${st.size}`;
  const hit = copilotLiveCache.get(sessionId);
  if (hit && hit.key === key) return hit.value;

  const TAIL = 4 * 1024 * 1024; // 最新那一轮那行可能很大（带整段 response），往上多读一点
  let txt = '';
  try {
    const start = Math.max(0, st.size - TAIL);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      txt = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) txt = txt.slice(txt.indexOf('\n') + 1); // 丢掉可能被截断的首行
  } catch {
    return null;
  }

  let req = null;
  const modelStateByIndex = new Map(); // 轮序号 -> {value, completedAt}
  const elapsedByIndex = new Map(); // 轮序号 -> elapsedMs（起止时间 = completedAt - elapsedMs）
  const changedByIndex = new Map(); // 轮序号 -> Set(写工具碰过的文件：绝对路径)
  let maxIndex = -1;
  for (const line of txt.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let j = null;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const k = j && j.k;
    if (!Array.isArray(k) || k[0] !== 'requests') continue;
    if (k.length === 1) {
      // 整份 requests（滚动窗口）：最后一条就是最新那一轮
      const arr = Array.isArray(j.v) ? j.v : [];
      const last = arr[arr.length - 1];
      if (last && typeof last === 'object') {
        const startedAt = Number(last.timestamp) || 0;
        const prompt = String((last.message || {}).text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (startedAt) req = { index: null, prompt, startedAt, completed: false, completedAt: 0 };
      }
    } else {
      const idx = Number(k[1]);
      if (Number.isFinite(idx)) {
        maxIndex = Math.max(maxIndex, idx);
        if (k[2] === 'modelState' && j.v && typeof j.v === 'object') {
          modelStateByIndex.set(idx, { value: Number(j.v.value) || 0, completedAt: Number(j.v.completedAt) || 0 });
        } else if (k[2] === 'elapsedMs') {
          elapsedByIndex.set(idx, Number(j.v) || 0);
        } else if (k[2] === 'response') {
          // 这一轮的回复流里，**写文件**的工具调用 = 这一轮改动的文件。
          // 路径整个对象里找（invocationMessage / pastTenseMessage / toolSpecificData 都可能带），
          // 只认 file:// URI，去掉 #Lx-y 行号后缀。
          for (const it of Array.isArray(j.v) ? j.v : []) {
            if (!it || typeof it !== 'object' || it.kind !== 'toolInvocationSerialized') continue;
            if (!COPILOT_WRITE_TOOL_RE.test(String(it.toolId || ''))) continue;
            const blob = JSON.stringify(it);
            const files = [...blob.matchAll(/file:\/\/([^\s)\]\\"']+)/g)]
              .map((m) => decodeURIComponent(m[1]).replace(/#.*$/, ''))
              .filter(Boolean);
            if (!files.length) continue;
            if (!changedByIndex.has(idx)) changedByIndex.set(idx, new Set());
            for (const f of files) changedByIndex.get(idx).add(f);
          }
        }
      }
    }
  }
  if (!req) return null;
  /*
   * 完成判定**不能**拿"补丁里的最大轮号"当这一轮的轮号：最新一轮在开始时落的是一整份
   * requests（此时还没有它的 requests.<n>.* 补丁），那一轮号还是上一轮的 —— 拿上一轮的
   * modelState.completedAt 去判定，就会把"刚开始跑"判成"已经收工"（2026-09-28 实测的坑：
   * 用户跑任务时 9F 连"思考中"都没有）。
   * 轮次是顺序的，所以正确判据是：**有没有出现"不早于这一轮起始时间"的完成标记**。
   * 没有（最大的 completedAt 还是上一轮的，必然早于本轮 startedAt）→ 这一轮还在飞。
   */
  let maxCompletedAt = 0;
  let maxCompletedIndex = -1;
  for (const [idx, st] of modelStateByIndex) {
    if (st.completedAt > maxCompletedAt) {
      maxCompletedAt = st.completedAt;
      maxCompletedIndex = idx;
    }
  }
  req.completed = maxCompletedAt >= req.startedAt;
  req.completedAt = req.completed ? maxCompletedAt : 0;
  req.index = req.completed ? maxCompletedIndex : maxCompletedIndex >= 0 ? maxCompletedIndex + 1 : null;
  // 顺带回一份"最近几轮各自的起止时间"（顶部窗口里带 elapsedMs 的都能算出来），
  // 台账按轮记账时用它把每一轮的 started_at 填准（Copilot 自己的库只有完成时刻）。
  req.reqs = [];
  for (const [idx, st] of modelStateByIndex) {
    if (!st.completedAt) continue;
    const el = elapsedByIndex.get(idx) || 0;
    req.reqs.push({ index: idx, startedAt: Math.max(0, st.completedAt - el), endedAt: st.completedAt });
  }
  req.reqs.sort((a, b) => a.index - b.index);
  // 最近几轮各自改动的文件（写工具碰过的），按轮序号给出去
  req.changed = [...changedByIndex]
    .map(([index, set]) => ({ index, files: [...set] }))
    .sort((a, b) => a.index - b.index);
  copilotLiveCache.set(sessionId, { key, value: req });
  return req;
}

/* ───────────── */

/**
 * reporter hook 的"主控制台相位"：每次事件都会把当前相位（thinking/tool/await）写进
 * ~/.workgremlin/hooks/<工位>.json 的 `sessionPhase` 字段（见 packages/reporter/src/hook.js）。
 * 这是上报真值，优先级高于从 genie-history 推断出来的相位，UI 按真值展示（不标"推断"）。
 * 超过新鲜期（5 分钟）视为作废，避免 IDE 关掉后残留相位一直挂着。
 * 顺带返回同一份状态文件里的 pending（PreToolUse 写、PostToolUse 清），专供"等授权"兜底推断。
 * @returns {{phase: string, tool: string, file: string, cmd: string, prompt: string, model: string, client: string, pending: {tool: string, file: string, cmd: string, at: number}|null}|null}
 */
function readCopilotPhaseFromSqlite(workspacePath, client = '', session = '') {
  if (clientBase(client) !== 'copilot') return null;
  const storage = sess().findPluginStorage();
  if (!storage) return null;
  const rowList = sess().readSqliteSessionRows(storage)
    .filter((r) => (!session || String(r.id || '') === String(session)))
    .filter((r) => (!workspacePath || !r.projectPath || path.resolve(r.projectPath) === path.resolve(workspacePath)));
  if (!rowList.length) return null;
  rowList.sort((a, b) => Number(b.lastUpdated || 0) - Number(a.lastUpdated || 0));
  const row = rowList[0];
  // 相位：优先听 VS Code chat 索引的"这一轮在不在飞"，没有旁证才退回 2 分钟新鲜度窗口。
  // 和 listSessions 同一口径（copilotInWindow）—— 不要让旧会话永远显示 thinking，
  // 更不要在轮正跑着的时候报待命。
  const now = Date.now();
  const fresh = copilotInWindow(row, now);
  // 屏上那句"用户说的话"：正在飞的那一轮用会话日志里的原话（Copilot 自己的库要等整轮写完才有）
  const prompt = String(
    (fresh && row.live && row.live.prompt) || row.lastUserMessage || row.summary || ''
  ).trim();
  return {
    client: String(client || 'copilot-plugin').toLowerCase(),
    phase: fresh ? 'thinking' : 'idle',
    tool: '',
    file: '',
    cmd: '',
    prompt,
    model: '',
    pending: null,
    action: '',
    target: '',
    context: [],
  };
}

/* ───────────── */

function copilotCurrentModel() {
  const now = Date.now();
  if (copilotModelCache.value && now - copilotModelCache.at < COPILOT_MODEL_CACHE_TTL) {
    return copilotModelCache.value;
  }
  const storage = sess().findPluginStorage([/github\.copilot/i, /github-copilot/i, /^copilot/i]);
  if (!storage) {
    copilotModelCache = { at: now, value: '' };
    return '';
  }
  // state.vscdb 在 globalStorage 根下（Copilot 的 plugin storage 是它的子目录）
  const dbFile = path.join(path.dirname(storage), 'state.vscdb');
  let db = null;
  try {
    if (!fs.existsSync(dbFile)) {
      copilotModelCache = { at: now, value: '' };
      return '';
    }
    const Database = require('better-sqlite3');
    db = new Database(dbFile, { readonly: true, fileMustExist: true });
    // 当前选中的模型标识（如 "copilot/gpt-5-mini"）
    const row = db.prepare("select value from ItemTable where key = 'chat.currentLanguageModel.editor'").get();
    const identifier = row ? String(row.value || '').trim() : '';
    if (!identifier) {
      copilotModelCache = { at: now, value: '' };
      return '';
    }
    // 从 cachedLanguageModels 查展示名（如 "GPT-5 mini"）
    const cached = db.prepare("select value from ItemTable where key = 'chat.cachedLanguageModels'").get();
    if (cached && cached.value) {
      const models = JSON.parse(String(cached.value));
      if (Array.isArray(models)) {
        const match = models.find((m) => m && m.identifier === identifier);
        if (match && match.metadata && match.metadata.name) {
          const name = String(match.metadata.name);
          copilotModelCache = { at: now, value: name };
          return name;
        }
      }
    }
    // 查不到展示名就用标识符去掉 vendor 前缀（"copilot/gpt-5-mini" → "gpt-5-mini"）
    const fallback = identifier.replace(/^[^/]+\//, '');
    copilotModelCache = { at: now, value: fallback };
    return fallback;
  } catch {
    copilotModelCache = { at: now, value: '' };
    return '';
  } finally {
    if (db) {
      try { db.close(); } catch { /* 关不掉不影响读取 */ }
    }
  }
}

/* ───────────── */

/**
 * 9F 的完成标记（会话表形状 `{doneAt,doneTitle,doneCount,doneFiles}`，与各产品的 read*Done 同形）。
 * 取会话日志里最新那一轮的 completedAt；超 sess().DONE_TTL_MS 或那一轮还没收工都没有。
 * @param {string} sessionId
 */
function readCopilotDone(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const at = copilotDoneAt({ live: readCopilotLiveRequest(id) }, Date.now());
  if (!at) return null;
  return { doneAt: at, doneTitle: '', doneCount: 0, doneFiles: [] };
}

/* ───────────── */

/** Copilot 的相位新鲜窗口：2 分钟内有活动 = thinking，超了 = idle。
 *  比 IDLE_MS 短得多 —— IDLE_MS 管"活不活"（10 分钟内都算活跃会话），
 *  这个管"正在不在想"（2 分钟没动静就是待命了）。和 Kilo 的 PHASE_FRESH_MS 同量级。 */
const COPILOT_PHASE_MS = 2 * 60_000;

/* ───────────── */

/**
 * GitHub Copilot 自己的插件落盘目录名。`/copilot/i` 会把 Tencent 的
 * `tencent-cloud.coding-copilot` 一起命中，所以必须锚在开头。
 */
const COPILOT_STORAGE_RE = /^(?:github[.\-]?copilot|copilot)/i;

/* ───────────── */

/**
 * 会**写文件**的 Copilot 工具（toolId）。只有这些工具碰过的文件才算"这一轮改动的文件"。
 * 实测（0.65.0）toolId 长这样：copilot_readFile / copilot_findTextInFiles / run_in_terminal /
 * copilot_replaceString / copilot_multiReplaceString / manage_todo_list…
 * —— session_files 那张表里**只有 read_file**，拿它当"改动文件"是错的（用户实测抓出来的）。
 */
const COPILOT_WRITE_TOOL_RE =
  /replace|patch|create[_.]?file|write[_.]?file|edit[_.]?file|insert[_.]?edit|apply[_.]?edit|multi[_.]?replace|delete[_.]?file|move[_.]?file/i;

/* ───────────── */

/**
 * Copilot「这一轮在不在飞」的旁证。
 *
 * Copilot 自己的 session-store.db 是**整轮写完**才落的：turns 行带着 assistant_response
 * 一起出现，sessions.updated_at 也是那一刻才动 —— 「正在生成」在那张库里根本看不见。
 * 只看 updated_at 的 2 分钟窗口，就会出现最难看的那种错：**跑着的时候显示待命，
 * 跑完了反倒显示思考中**（实测 2026-09-28）。
 *
 * VS Code 自己有一份更细的索引：`workspaceStorage/<hash>/state.vscdb` 的
 * `chat.ChatSessionStore.index`，每个会话带 `timing.lastRequestStarted / lastRequestEnded`
 * （外加 lastResponseState / hasPendingEdits）。started 晚于 ended（或压根没有 ended）
 * = 这一轮还在飞。这里只读它、不写；读不到就回空 Map，上层退回原来的时间窗推断。
 */
const COPILOT_INDEX_TTL = 2_000;

/* ───────────── */

/** dbFile -> { mtimeMs, size, at, entries }：文件没变就不重复开库（相位 1.5s 一poll） */
let copilotIndexCache = new Map();

/* ───────────── */

/** sessionId -> { key, value }：日志是 append-only 的，mtime+size 没变就没必要重读 */
const copilotLiveCache = new Map();

/* ───────────── */

/**
 * Copilot 当前选中的模型。从 VS Code 的 state.vscdb 里读 `chat.currentLanguageModel.editor`，
 * 值形如 `copilot/gpt-5-mini`；再用 `chat.cachedLanguageModels` 查展示名（如 "GPT-5 mini"）。
 * 取不到返回空串 —— 不猜。
 *
 * 和 TraeCode 的 traeModels.selectedModelOf 同理：模型存在 globalStorage 的 state.vscdb 里，
 * Copilot 自己的 session-store.db 不记模型。
 */
const COPILOT_MODEL_CACHE_TTL = 15_000;

/* ───────────── */

let copilotModelCache = { at: 0, value: '' };

/* ───────────── 原 copilotTasks.js 的同步器 ───────────── */

'use strict';

/**
 * 9F GitHub Copilot 的任务同步器。
 *
 * Copilot 没有 reporter hook，不会往 WorkGremlin 的 tasks 表写东西 → 任务列表（TaskRecordsView，
 * 走 /api/v1/task-runs）永远看不到 9F 的任务。这个同步器周期性轮询 Copilot 自己的
 * session-store.db（已在 sessions.readSqliteSessionRows 里读好：sessions + turns + session_files），
 * 加上 VS Code 的会话日志（chatSessions/<会话>.jsonl，见 sessions.readCopilotLiveRequest），
 * 把**每一轮用户任务**写成一条 task + task_run，让任务列表能显示 9F。
 *
 * 设计：
 * - 幂等：task id = `copilot:<session_id>:<轮序号>`，每次重跑是 upsert，不会重复插。
 * - 安静：不广播 WS 事件（2s 会话扫盘 loop 会自然拾取变化并推给前端）。
 * - 只写 task_runs 有的列（client/session_id/file_count/files_json/title/started_at/ended_at），
 *   不编造 model/result（Copilot 的库里没有模型字段）。
 * - 状态：这一轮还在飞 → state=running、ended_at=null；收工 → state=done、ended_at=收工时刻。
 *   "在飞"听 VS Code 的两份旁证（state.vscdb 的 chat 索引 / 会话日志的完成标记），
 *   都不认识才退回时间窗 —— Copilot 自己的库整轮写完才落盘，只看时间窗必然判反。
 */




const IDLE_MS = 10 * 60_000;
/** Copilot 相位新鲜窗口：2 分钟内有活动 = running，超了 = done。
 *  和 sessions.js 的 COPILOT_PHASE_MS 一致，比 IDLE_MS 短 —— IDLE_MS 管"活不活"，
 *  这个管"正在不在跑"。 */
const PHASE_MS = 2 * 60_000;
const SYNC_INTERVAL_MS = 5_000;

/** task id 前缀，避免跟 reporter hook 写的 task 撞 id */
const TASK_ID_PREFIX = 'copilot:';

/**
 * 这一层写进台账 / 成员表的**上报身份**。
 *
 * 必须用 'copilot-plugin'，不能想当然写 'copilot'：9F 的 clients 由 products.js 的
 * sources 反推（9F 只有插件一个形态），只有 ['copilot-plugin']；而任务列表是按楼层
 * clients **精确**过滤的（query.js 的 `instr(@client, ',' || COALESCE(tr.client, m.client) || ',')`）。
 * 写成 'copilot' 的记录会被静默挡在 9F 的筛选之外 —— 库里有行、页面上一条都看不到。
 */
const CLIENT = 'copilot-plugin';

/**
 * @param {{bus: any, repo: any, now?: () => number}} ctx
 * @returns {number} 本次同步写/改了几条任务
 */
/** 这个工程名（工程 id）—— 成员 / 台账都按它归组 */
function projectIdOf(s) {
  const projectPath = s.projectPath || '';
  return s.project || (projectPath ? path.basename(projectPath) : 'GitHub Copilot');
}

/**
 * 这条会话现在算不算"正在跑"。
 *
 * 优先听会话行上的 `inFlight`（VS Code chat 索引给的"这一轮在不在飞"，见 sessions.js 的
 * readCopilotChatIndex）—— Copilot 自己的库整轮写完才落盘，只看时间窗会出现
 * "跑着显示待命、跑完显示思考中"。拿不到旁证（老版本 / 库被占用，inFlight === null）
 * 才退回 PHASE_MS(2 分钟) 新鲜度窗口。
 *
 * 用 2 分钟而不是 IDLE_MS(10 分钟)：10 分钟太长，任务跑完后还显示 running 10 分钟。
 */
function isSessionActive(s, now) {
  if (typeof s.inFlight === 'boolean') return s.inFlight;
  return Boolean(s.lastUpdated && now - s.lastUpdated < PHASE_MS);
}

/**
 * 写一条台账（tasks + task_runs 两行）。9F 是**每一轮一条**，见 syncCopilotTasks 的说明。
 * @returns {string|null} 这条记录的 files_json（心跳里的 current_files 直接复用）
 */
function writeTurnRun(repo, { id, projectId, memberId, sessionId, model, title, startedAt, endedAt, files }) {
  const running = !endedAt;
  repo.insertTask.run({
    id,
    projectId,
    memberId,
    parentTaskId: null,
    title,
    state: running ? 'running' : 'done',
    progress: running ? null : 1,
    startedAt,
    endedAt: endedAt || null,
  });
  repo.upsertTaskRun.run({
    id,
    projectId,
    memberId,
    client: CLIENT,
    sessionId,
    form: null,
    model: model || null,
    title,
    startedAt,
    baselineCommit: null,
  });
  const filesJson = files && files.length ? JSON.stringify(files) : null;
  // 补 file_count / files_json / ended_at / duration_ms（upsertTaskRun 不写这些列）
  repo.endTaskRun.run({
    id,
    title,
    model: model || null,
    form: null,
    result: null,
    fileCount: files ? files.length : 0,
    filesJson,
    endedAt: endedAt || null,
    durationMs: endedAt && startedAt ? endedAt - startedAt : null,
  });
  return filesJson;
}

/**
 * 收掉"张冠李戴"的在飞行。
 *
 * 9F 的台账只有这个同步器写（`copilot:` 前缀 + client=copilot-plugin），所以这个前缀的行归它自己管。
 * 历史版本给 listSessions 用的是共享的 PLUGIN_RE，它会命中别的产品的插件目录
 * （Tencent CodeBuddy 的 tencent-cloud.coding-copilot、Trae 的 coding-copilot）—— 那些楼层正在跑的
 * 会话就被写成了 Copilot 任务，标题只能退回占位符「(Copilot 会话)」。而且这种行**永远不会收工**：
 * 收工靠 Copilot 自己的 turns 表，别的产品的会话在它那张表里根本没有 → 任务记录页永远挂着一条「进行中」。
 * （用户实测 2026-09-30：打开 VS Code、没在 Copilot Chat 里输入，9F 就冒一条。）
 *
 * 分寸：**只删"能证明是别人的"行** —— 这个 session id 出现在别的产品的结构化落盘里
 * （sessions.js 的 nonCopilotSessionIds）。Copilot 自己的历史（哪怕早过了清单窗口、现在不在
 * sessions 里）一律不碰；没有归属证据的行也留着 —— 宁可留错，也不误删真记录。
 *
 * @param {any} repo
 * @param {Set<string>} copilotIds 本次清单里认得的所有 Copilot 会话 id
 * @returns {number} 收掉几条
 */
function pruneForeignRunningRuns(repo, copilotIds) {
  const orphans = repo.liveTaskRunsOfClient
    .all(CLIENT)
    .filter((r) => r.session_id && !copilotIds.has(String(r.session_id)));
  if (!orphans.length) return 0;
  const foreign = nonCopilotSessionIds();
  let removed = 0;
  for (const r of orphans) {
    if (!foreign.has(String(r.session_id))) continue;
    repo.deleteTaskRun(r.id);
    removed += 1;
  }
  return removed;
}

/**
 * 收工：把这一轮**没有会话**的 9F 成员状态落回「空闲」。
 *
 * agent_status 是一行一成员、由这个同步器独占写（GitHub Copilot 没有 hook，也没有插件上报）。
 * 一旦会话消失（会话库清了 / 那条会话其实属于别的楼层被收掉 / Copilot 根本没在用），
 * 最后那次「思考中」就永远挂在库里 —— 卡片上就是**一直显示忙碌、却没有任务**
 * （用户 2026-09-30 实测：9F GitHub Copilot 一直忙碌，而它那条占位任务早被收掉了）。
 * 与 7F/8F 的同步器同一口径：非活跃时补一条 idle，让状态跟着会话走，不让旧值烂在那里。
 *
 * 分寸：
 *   · 只碰 client=CLIENT 的成员 —— 9F 这一层没有别的写入方，不会跟谁抢；
 *   · 这一轮已经按会话写过状态（`touched`）的一律不动，用户级真值优先；
 *   · 已经是 idle / offline 的不重复写；
 *   · 没有状态行的成员不管（不凭空造一条"空闲"出来）。
 *
 * @param {any} repo
 * @param {number} now
 * @param {Set<string>} touched 这一轮已经写过状态的成员 id
 * @returns {number} 落回了几条
 */
function settleIdleMembers(repo, now, touched) {
  let settled = 0;
  for (const m of repo.listMembersByClient.all(CLIENT)) {
    if (touched.has(m.id)) continue;
    const s = repo.getStatus.get(m.id);
    if (!s || s.state === 'idle' || s.state === 'offline') continue;
    repo.upsertStatus.run({
      memberId: m.id,
      state: 'idle',
      stateSince: now,
      // 顺手清掉悬空的 task_id：指向的那条任务可能已经不在了（误差来源于上面说的错行清理）
      taskId: null,
      progress: null,
      currentFiles: null,
      lastHeartbeatAt: now,
      degraded: 0,
      source: 'report',
      updatedAt: now,
    });
    // upsertStatus 的 task_id 是 COALESCE（传 null 清不掉），悬空槽位要单独清
    repo.clearStatusTask.run(m.id);
    settled += 1;
  }
  return settled;
}

function syncCopilotTasks({ bus, repo, now: nowFn = Date.now }) {
  const now = nowFn();
  /*
   * 会话清单必须锁在 **GitHub Copilot 自己的落盘** 上，不能吃 listSessions 的默认 PLUGIN_RE：
   * 那串里含 `/^tencent/` 与 `/coding-copilot/i`，本机上会命中 Tencent CodeBuddy 的
   * `tencent-cloud.coding-copilot` —— 别的楼层正在跑的会话就被当成 Copilot 会话写进 9F
   * （用户实测：打开 VS Code 什么都没问，任务记录里就多一条「(Copilot 会话)」在飞行）。
   * `copilot === true` 是第二道闸：只有 Copilot 自己 session-store.db 里读出来的才算。
   */
  const snap = sess().listSessions({ force: true, client: 'copilot-plugin', pluginRe: RE_GITHUB_COPILOT });
  const sessions = ((snap && snap.sessions) || []).filter((s) => s.copilot === true);
  // 一条 Copilot 会话都没有时也要跑：上面那条错行正是在这种机器上冒出来的（只有别的产品的落盘）。
  pruneForeignRunningRuns(repo, new Set(sessions.map((s) => String(s.id || '')).filter(Boolean)));
  if (!sessions.length) {
    // 一条会话都没有 —— 也要把上一轮留下的「思考中」落回空闲，否则卡片一直显示忙碌
    settleIdleMembers(repo, now, new Set());
    return 0;
  }

  // Copilot 的模型存在 VS Code 的 state.vscdb（chat.currentLanguageModel.editor），
  // 不是 per-session 的 —— 全局一份，所有会话共用。取不到留空，不拿默认模型冒充。
  const model = copilotCurrentModel();
  let count = 0;
  /** 这一轮按会话写过状态的成员（心跳只由 owner 写）—— 收工那一步要跳过他们 */
  const statusWritten = new Set();

  /**
   * 一个工程只写**一条**成员状态（agent_status 主键就是 member_id）。
   * 同工程开了多条会话时，谁最后写谁赢 —— 结果是"正在跑的那条任务在 agent_status 里
   * 找不到对应心跳"，任务列表按 query.js 的 CASE 把它算成「已取消」，运行中的任务就不显示了。
   * 所以先选出这个工程该报的那条：活跃里最新的；都不活跃就报最新那条（卡片挂住最后一条任务）。
   */
  const activeByProject = new Map();
  const newestByProject = new Map();
  for (const s of sessions) {
    const pid = projectIdOf(s);
    const prevNew = newestByProject.get(pid);
    if (!prevNew || Number(s.lastUpdated || 0) > Number(prevNew.lastUpdated || 0)) newestByProject.set(pid, s);
    if (!isSessionActive(s, now)) continue;
    const prevAct = activeByProject.get(pid);
    if (!prevAct || Number(s.lastUpdated || 0) > Number(prevAct.lastUpdated || 0)) activeByProject.set(pid, s);
  }

  for (const s of sessions) {
    const projectPath = s.projectPath || '';
    const projectName = s.project || (projectPath ? path.basename(projectPath) : 'GitHub Copilot');
    const projectId = projectName;

    // 确保工程 & 成员存在（安静写入，不广播）
    bus.ensureProject(projectId, projectPath, null, 'report');
    const memberId = `copilot@${projectId}`;
    const existing = repo.getMember.get(memberId);
    repo.upsertMember.run({
      id: memberId,
      projectId,
      name: 'GitHub Copilot',
      role: 'agent',
      sessionId: s.id || null,
      reported: existing ? existing.reported : 1,
      createdAt: existing ? existing.created_at : now,
      lastSeenAt: now,
      ephemeral: 0,
      projectLabel: null,
      client: CLIENT,
    });

    /*
     * 台账口径：**每一轮用户任务一条**（和其它楼层一样），不是"一条会话一条"。
     * 标题 = 那一轮用户说的话；起止 = 那一轮的起止（会话日志里能算准的轮就用准的，
     * 算不出来（老轮，日志已滚出尾部）就用 Copilot 自己落这条 turn 的时刻，不编造）。
     * 正在飞的那一轮同样先落一条 running —— Copilot 的库要等整轮写完才写 turns 行，
     * 只等它的话，用户跑任务时列表里会一直没有"运行中"这条。
     */
    const isActive = isSessionActive(s, now);
    const turns = Array.isArray(s.copilotTurns) ? s.copilotTurns : [];
    const changedByIndex = new Map(
      (Array.isArray(s.liveChanged) ? s.liveChanged : []).map((c) => [Number(c.index), c.files || []])
    );
    /**
     * 这一条记录该挂哪些文件：**只认会话日志里"写"工具碰过的**（copilot_replaceString /
     * copilot_multiReplaceString …），read_file / findTextInFiles 不算改动。
     * 为什么不用 session_files 那张表：实测它整张表都是 read_file（Copilot 只记"读过"），
     * 拿它当改动文件，用户没让它改文件也会报出几十个（用户实测抓出来的就是这个）。
     * 日志窗口已经滚出去的轮就留空，不拿"读过的文件"顶替。
     */
    const filesFor = (idx) => {
      const own = changedByIndex.get(idx) || [];
      const rel = own
        .map((abs) => {
          const p = String(abs || '');
          if (!p || !projectPath) return p;
          const r = path.relative(projectPath, p);
          return r && !r.startsWith('..') ? r : ''; // 工程外的文件不进这一栏
        })
        .filter(Boolean);
      return rel.length ? [...new Set(rel)] : null;
    };
    const liveReqByIndex = new Map(
      (Array.isArray(s.liveReqs) ? s.liveReqs : []).map((r) => [r.index, r])
    );

    let hbId = '';
    let hbFilesJson = null;

    // ① 每一轮已收工的：一条记录（标题就是那一轮用户原话）
    for (const t of turns) {
      const id = `${TASK_ID_PREFIX}${s.id}:${t.index}`;
      const title = t.userMessage || s.doneTitle || s.prompt || '(Copilot 会话)';
      const known = liveReqByIndex.get(t.index);
      const startedAt = (known && known.startedAt) || t.at || s.lastUpdated || now;
      const endedAt = (known && known.endedAt) || t.at || startedAt;
      // 先说"不知道起点"、后来从会话日志里算准了 → 把这条派生记录重建一次。
      // 不然 tasks.started_at 会被 insertTask 的 COALESCE 留住旧值，而 duration 按新值算，
      // 出现"started_at 比 ended_at 还晚"的怪值（实测 17:17:45 → 17:17:44）。
      const prev = repo.getTask.get(id);
      if (prev && known && known.startedAt && prev.started_at !== startedAt) repo.deleteTaskRun(id);
      hbFilesJson = writeTurnRun(repo, {
        id,
        projectId,
        memberId,
        sessionId: s.id || null,
        model,
        title,
        startedAt,
        endedAt,
        files: filesFor(t.index),
      });
      hbId = id;
      count += 1;
    }

    // ② 正在飞的那一轮：一条 running（用户原话来自 VS Code 会话日志 —— Copilot 的库此时还没有）
    let runningId = '';
    if (isActive) {
      // 轮序号 = 会话日志里的那一轮；日志还没写全时按"上一轮 + 1"兜底。
      // 一定要大于已收工的最大轮序号 —— 否则会把上一轮那条 done 记录改回 running。
      const lastDone = turns.length ? turns[turns.length - 1].index : -1;
      const logIdx = Number.isFinite(Number(s.liveIndex)) && s.liveIndex != null ? Number(s.liveIndex) : -1;
      const idx = Math.max(logIdx, lastDone + 1);
      runningId = `${TASK_ID_PREFIX}${s.id}:${idx}`;
      const title = s.livePrompt || s.prompt || s.doneTitle || '(Copilot 会话)';
      hbFilesJson = writeTurnRun(repo, {
        id: runningId,
        projectId,
        memberId,
        sessionId: s.id || null,
        model,
        title,
        startedAt: s.liveStartedAt || now,
        endedAt: null,
        files: filesFor(idx),
      });
      hbId = runningId;
      count += 1;
    }

    // ③ 收掉过渡期那条"一条会话一条"的旧记录（id 不带轮序号；只删自己前缀的）
    const legacyId = `${TASK_ID_PREFIX}${s.id}`;
    if (repo.getTaskRun.get(legacyId)) repo.deleteTaskRun(legacyId);

    // 心跳：活跃 → thinking，停下 → idle。
    // **不活跃时也必须写**：只写 thinking 的话，会话停下来之后这条 agent_status 就一直
    // 挂在库里，成员卡永远显示「思考中」（实测 9F 就是这个症状：会话早停了，工位上还在思考中）。
    // 如实回落成 idle，而不是让旧值烂在那里。
    // 心跳只由这个工程选中的那条会话写（见上面 activeByProject 的说明）
    const owner = activeByProject.get(projectId) || newestByProject.get(projectId);
    if (owner === s && hbId) {
      repo.upsertStatus.run({
        memberId,
        state: isActive ? 'thinking' : 'idle',
        stateSince: isActive ? (s.liveStartedAt || now) : now,
        taskId: hbId,
        progress: null,
        currentFiles: hbFilesJson,
        lastHeartbeatAt: now,
        degraded: 0,
        source: 'report',
        updatedAt: now,
      });
      statusWritten.add(memberId);
    }
    bus.setSessionStatus({
      project: projectId,
      memberId: 'copilot',
      sessionId: s.id,
      state: isActive ? 'thinking' : 'idle',
      taskId: isActive ? runningId : null,
      ts: now,
    });
  }

  // 收工：这一轮没轮到写状态的成员（工程里连会话都没有）同样落回空闲 —— 别让「思考中」烂在库里
  settleIdleMembers(repo, now, statusWritten);

  return count;
}

/** 适合 setInterval 的包装：吞异常、不阻断主循环 */
function startCopilotTaskSyncer(ctx) {
  const tick = () => {
    try {
      syncCopilotTasks(ctx);
    } catch {
      /* Copilot 没装 / 库被占 → 这轮跳过 */
    }
  };
  tick();
  const timer = setInterval(tick, SYNC_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}


/* ── 统一接口别名 + 导出（用 mutation，保证 sessions.js 循环加载时拿到的 C 引用稳定）── */
module.exports.id = '9F';
module.exports.client = 'copilot';
module.exports.RE_GITHUB_COPILOT = RE_GITHUB_COPILOT;
// 产品探测元数据（原 products.js 的 9F 条目）：9F 只有插件这一形态。
const meta = {
  id: '9F',
  name: 'GitHub Copilot',
  kind: 'plugin',
  cmd: 'copilot',
  agent: 'copilot',
  plugin: true,
  pluginRe: RE_GITHUB_COPILOT,
  // 仅展示 GitHub Copilot VS Code 插件这一层（无独立 CLI 形态）。
  sources: ['plugin'],
  dataKind: clientOf('copilot', true),
  // 落盘探测（findDataPath 用）：插件形态在 VS Code 的 globalStorage 下找
  matchRe: RE_GITHUB_COPILOT,
  homeDirs: [path.join(HOME, '.config', 'Code', 'User', 'globalStorage')],
};
module.exports.meta = meta;
module.exports.syncCopilotTasks = syncCopilotTasks;
module.exports.startCopilotTaskSyncer = startCopilotTaskSyncer;
module.exports.SYNC_INTERVAL_MS = SYNC_INTERVAL_MS;
module.exports.syncTasks = syncCopilotTasks;
module.exports.readPhase = readCopilotPhaseFromSqlite;
module.exports.readDone = readCopilotDone;
module.exports.modelOf = copilotCurrentModel;
/* 读取函数（原 sessions.js） */
module.exports.readCopilotTurns = readCopilotTurns;
module.exports.readCopilotFiles = readCopilotFiles;
module.exports.readCopilotChatIndex = readCopilotChatIndex;
module.exports.copilotInFlight = copilotInFlight;
module.exports.copilotInWindow = copilotInWindow;
module.exports.copilotDoneAt = copilotDoneAt;
module.exports.nonCopilotSessionIds = nonCopilotSessionIds;
module.exports.copilotChatLogPath = copilotChatLogPath;
module.exports.readCopilotLiveRequest = readCopilotLiveRequest;
module.exports.readCopilotPhaseFromSqlite = readCopilotPhaseFromSqlite;
module.exports.copilotCurrentModel = copilotCurrentModel;
module.exports.readCopilotDone = readCopilotDone;
module.exports.COPILOT_PHASE_MS = COPILOT_PHASE_MS;
module.exports.COPILOT_STORAGE_RE = COPILOT_STORAGE_RE;
module.exports.COPILOT_WRITE_TOOL_RE = COPILOT_WRITE_TOOL_RE;
module.exports.COPILOT_INDEX_TTL = COPILOT_INDEX_TTL;
