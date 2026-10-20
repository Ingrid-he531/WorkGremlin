'use strict';

/**
 * 9F GitHub Copilot floor module — merges "data-source reading" and "ledger syncer" into this one file
 * (the Copilot readers from the old sessions.js + the syncer from copilotTasks.js).
 *
 * 9F has neither a hook nor a reporter, so tasks can only come from the server polling its own on-disk state:
 *   · session-store.db (GitHub Copilot's SQLite session store — see readCopilotTurns / readCopilotFiles)
 *   · VS Code's state.vscdb chat index (readCopilotChatIndex, the only side evidence of "a turn is in flight")
 *   · VS Code's chatSessions/<session>.jsonl session log (readCopilotLiveRequest: user prompt / start-end / in-flight)
 *
 * This file depends only on generic modules (roots.js for findPluginStorage / globalStorageRoots /
 * workspaceStorageRoots and tolerant file reads) to read its own on-disk state; it no longer requires
 * sessions.js back (kills the sessions ↔ copilot cycle). The readers (readCopilotX) are called by
 * sessions.js's listSessions.
 *
 * Unified contract (see FLOOR_CONTRACT in floors.js):
 *   id / client   floor identity
 *   syncTasks     = syncCopilotTasks
 *   readPhase     = readCopilotPhaseFromSqlite
 *   readDone      = readCopilotDone
 *   modelOf       = copilotCurrentModel
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// Generic plugin on-disk resolution (findPluginStorage / globalStorageRoots / workspaceStorageRoots) and
// tolerant file reads (readJson / readDir) all come from roots.js; this file depends only on generic
// modules and never requires floors.js/sessions.js back (kills the sessions ↔ copilot cycle).
const { findPluginStorage, globalStorageRoots, workspaceStorageRoots, readJson, readDir, isFile, isDir } = require('./roots');
const { resolveProjectName } = require('./project');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

// 9F's own on-disk windows (same order as the CLI floors; 7F/8F define their own too)
const IDLE_MS = 10 * 60_000; // how long without activity counts as "inactive" (no heartbeat, so only file times)
const LISTED_MS = 60 * 60_000; // window in which a session is "still in the dropdown"
const DONE_TTL_MS = 10 * 60_000; // "freshness" window of the done marker

// 9F-only: this floor's pluginRe (products.js's findDataPath copilot branch needs it too); kept here to avoid a cycle.
const RE_GITHUB_COPILOT = [/^github\.copilot/i, /^github-copilot/i, /^github\.copilot-chat/i, /^copilot/i];
// Marker for this floor's plugin storage root: the dir must hold a session store to count
// (filters out the same-prefixed `github.copilot` base extension dir)
const RE_GITHUB_COPILOT_MARKS = ['session-store.db'];

// Generic file checks (isFile / isDir) come from roots so they are not redefined everywhere
/* ───────────── Copilot readers from the old sessions.js ───────────── */

/**
 * Read Copilot's `turns` table: turn count per session + the last user_message.
 * A missing table / renamed column is transparent to callers (returns an empty Map; callers carry on).
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
    // Per session_id: turn count + the first user_message in reverse timestamp order
    const countRows = db.prepare(`SELECT ${sidCol} as sid, COUNT(*) as cnt FROM turns GROUP BY ${sidCol}`).all();
    for (const r of countRows) {
      const sid = String(r.sid || '').trim();
      if (sid) out.set(sid, { turnCount: r.cnt, lastUserMessage: '', hasPendingTurn: false });
    }
    // A turn with an empty assistant_response = the AI has not finished replying → this session is running
    // (Copilot writes in batches: the turn row lands when the user sends a message, assistant_response is
    //  only updated once the AI is done. So "a turn with an empty reply" is hard evidence of "generating",
    //  far more reliable than the freshness of updated_at.)
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
    // Per-turn listing: the ledger books "one row per turn" (turn index + user text + time + whether it has a reply).
    // Missing columns (old versions) → skip; the upper layer still works, just without a per-turn ledger.
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
      // No timestamp column → take the last row (relying on the default rowid order)
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
    /* Copilot changed the turns table / column names → return empty */
  }
  return out;
}

/* ───────────── */

/**
 * Read Copilot's `session_files` table: file paths each session touched + tool names.
 * A missing table / renamed column likewise returns an empty Map.
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
      // A file that was merely **read** is not a "changed file": in Copilot 0.65.0 the whole session_files
      // table is read_file (measured), so treating it as "what this turn changed" reports a pile of untouched files.
      const tool = toolCol ? String(r.tn || '').trim() : '';
      if (tool && !COPILOT_WRITE_TOOL_RE.test(tool)) continue;
      // Copilot also records **its own** temp files in session_files (tool-call attachments,
      // chat-session-resources/.../content.txt and the like, all under VS Code's workspaceStorage /
      // globalStorage). Those are not "this turn's changed files"; mixing them into a task's file list
      // only misleads (measured: nearly half of 9F's records were such internal files). Here they are
      // filtered precisely by "lives under an editor storage dir"; real files outside the project
      // (e.g. another repo) are kept.
      if (/[\\/]User[\\/](?:workspace|global)Storage[\\/]/i.test(fp)) continue;
      const arr = out.get(sid) || [];
      // Dedupe (the same file may be touched by several turns)
      if (!arr.some((f) => f.path === fp)) {
        // turn: which turn touched this file (used when the ledger splits by turn).
        // Leave null when unknown — in Copilot 0.65.0 the whole turn_index column is NULL (that table is
        // really "files this session has seen"); treating it as 0 would wrongly pin it to the first turn,
        // so better to say "unknown".
        arr.push({
          path: fp,
          tool: toolCol ? String(r.tn || '').trim() : '',
          turn: turnCol && r.ti != null && r.ti !== '' ? Number(r.ti) : null,
        });
        out.set(sid, arr);
      }
    }
  } catch {
    /* Copilot changed the session_files table / column names → return empty */
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
    /* Native dep missing → fall back to the time-window inference */
  }
  for (const root of workspaceStorageRoots()) {
    for (const name of readDir(root)) {
      const dbFile = path.join(root, name, 'state.vscdb');
      if (!isFile(dbFile)) continue;
      let st = null;
      try {
        st = fs.statSync(dbFile);
      } catch {
        continue;
      }
      // File untouched and the last read still within TTL → reuse the previous result
      // (avoids opening SQLite every 1.5s)
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
          /* This workspace's db is unreadable (locked / version changed) → try the next one */
          entries = prev ? prev.entries : null;
        } finally {
          if (db) {
            try {
              db.close();
            } catch {
              /* Failing to close does not affect the read */
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
 * The "in flight" flag on a session row: true in flight / false done / null no side evidence
 * (falls back to the time-window inference).
 *
 * Between the two pieces of evidence (VS Code's chat index / the session log), **whoever knows the
 * newest turn wins**: the index often lags (the request started before it was written) while the log
 * lands at request start; conversely the log's completion patch arrives a bit later, so we cannot simply
 * "believe whoever says it is idle". Also, a turn row for this turn already in the DB = definitely done
 * (Copilot only writes the turn row once the whole turn is finished).
 */
function copilotInFlight(row) {
  if (!row) return null;
  const c = row.chat || null;
  const live = row.live || null;
  const turns = Array.isArray(row.turns) ? row.turns : [];
  const lastTurnIdx = turns.length ? Number(turns[turns.length - 1].index) : -1;
  // Follow the log when it is **not older** than the turn the index knows about. Do not demand "strictly
  // newer": in the measured VS Code build the index writes lastRequestEnded equal to lastRequestStarted
  // (so in-flight can never be detected), and letting the index win ties produces "the log says it just
  // started, the index says it is done" → the phase stays idle forever.
  const logKnowsNewer = Boolean(live && live.startedAt && (!c || live.startedAt >= (c.lastRequestStarted || 0)));
  if (logKnowsNewer) {
    if (live.index != null && lastTurnIdx >= Number(live.index)) return false; // this turn's turn row already landed
    if (Date.now() - live.startedAt > 60 * 60_000) return false; // a very old "unfinished" is likely residue, not in flight
    return !live.completed;
  }
  if (c) return Boolean(c.lastRequestStarted && c.lastRequestStarted > c.lastRequestEnded);
  return null;
}

/* ───────────── */

/**
 * Whether a Copilot session "counts as running": trust in-flight evidence when present, otherwise fall
 * back to the 2-minute window on updated_at.
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
 * 9F's "task done" moment: completedAt of the newest request in the session log (ignored past DONE_TTL_MS).
 * Copilot has no hook state file, so the done marker can only come from this log — same rule as
 * kilo.js/opencode.js's read*Done (does not guess from "the phase fell back to idle", avoiding false pops).
 * @param {{live?: any}} row
 * @param {number} now
 * @returns {number} 0 = none (or expired)
 */
function copilotDoneAt(row, now) {
  const live = row && row.live;
  const at = Number((live && live.completed && live.completedAt) || 0);
  if (!at || now - at > DONE_TTL_MS) return 0;
  return at;
}

/* ───────────── */

/**
 * Session ids claimed by **other products**' structured on-disk state
 * (genie-history / todos / message-queue / file-changes).
 *
 * Only one purpose: 9F's ledger syncer cleans up misattributed history rows (see pruneForeignRunningRuns
 * in copilotTasks.js). Measured pitfall on 2026-09-30 — that syncer used to ask for the session list with
 * the shared PLUGIN_RE, and `/^tencent/` plus `/coding-copilot/` match other products' plugin dirs
 * (Tencent CodeBuddy's `tencent-cloud.coding-copilot`, Trae's coding-copilot), so a session running on
 * another floor was written into 9F as an in-flight "(Copilot 会话)" — a row appeared as soon as VS Code
 * opened, even though the user never typed into Copilot Chat.
 *
 * **Attribution only, no disk writes**: the id is handed to the caller, which retracts a row only when it
 * can prove the session belongs to someone else.
 * @returns {Set<string>}
 */
function nonCopilotSessionIds() {
  const ids = new Set();
  for (const root of globalStorageRoots()) {
    for (const name of readDir(root)) {
      if (COPILOT_STORAGE_RE.test(name)) continue; // Copilot's own dir is not "another product"
      const dir = path.join(root, name);
      const gh = path.join(dir, 'genie-history');
      for (const proj of readDir(gh)) {
        const pdir = path.join(gh, proj);
        for (const sid of readDir(path.join(pdir, 'conversations'))) ids.add(sid);
        // The project-level current.json also records one session id (the session dir may be gone but this
        // session is still running)
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

/** The VS Code session log (chatSessions/<session>.jsonl) of one Copilot session */
function copilotChatLogPath(sessionId) {
  const name = `${sessionId}.jsonl`;
  for (const root of workspaceStorageRoots()) {
    for (const dir of readDir(root)) {
      const p = path.join(root, dir, 'chatSessions', name);
      if (isFile(p)) return p;
    }
  }
  return '';
}

/* ───────────── */

/**
 * Read the **tail** of a Copilot session log and take the newest request.
 *
 * This log (`workspaceStorage/<hash>/chatSessions/<session>.jsonl`) is VS Code's own session-state patch
 * stream, appended line by line as `{"kind":1,"k":["requests",<n>,"…"],"v":…}`. What matters is the
 * **timing** — the newest turn's `requests` array (with the user's message.text and the start timestamp)
 * is appended when that turn **starts** (measured: modelState on that line is still {value:0}, and the
 * completion time is patched in later as `requests.<n>.modelState.completedAt`). So it delivers at once
 * three things Copilot's own sqlite store cannot: whether this turn is in flight, the user's exact words,
 * and the start/end times.
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

  const TAIL = 4 * 1024 * 1024; // The line for the newest turn can be large (carries the whole response) → read extra
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
    if (start > 0) txt = txt.slice(txt.indexOf('\n') + 1); // Drop the first line, which may be truncated
  } catch {
    return null;
  }

  let req = null;
  const modelStateByIndex = new Map(); // turn index -> {value, completedAt}
  const elapsedByIndex = new Map(); // turn index -> elapsedMs (start = completedAt - elapsedMs)
  const changedByIndex = new Map(); // turn index -> Set(files touched by write tools: absolute paths)
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
      // The whole requests array (rolling window): the last entry is the newest turn
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
          // Inside this turn's response stream, **file-writing** tool calls = this turn's changed files.
          // Search the whole object for paths (invocationMessage / pastTenseMessage / toolSpecificData may
          // carry them), accept only file:// URIs and strip the #Lx-y line suffix.
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
   * Completion **cannot** use "the largest turn index in the patches" as this turn's index: when the newest
   * turn starts it appends a whole requests array (its own requests.<n>.* patches do not exist yet), so
   * that index is still the previous turn's — judging with the previous turn's modelState.completedAt
   * turns "just started" into "already done" (measured pitfall on 2026-09-28: while the user ran a task,
   * 9F did not even show "thinking").
   * Turns are sequential, so the correct test is: **has a completion marker no earlier than this turn's
   * start appeared**? If not (the largest completedAt is still the previous turn's and is necessarily
   * earlier than this turn's startedAt) → this turn is still in flight.
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
  // Also return the start/end times of the last few turns (any turn with elapsedMs in the tail window can
  // be computed); the ledger uses it to fill each turn's started_at accurately (Copilot's own store only
  // has the completion moment).
  req.reqs = [];
  for (const [idx, st] of modelStateByIndex) {
    if (!st.completedAt) continue;
    const el = elapsedByIndex.get(idx) || 0;
    req.reqs.push({ index: idx, startedAt: Math.max(0, st.completedAt - el), endedAt: st.completedAt });
  }
  req.reqs.sort((a, b) => a.index - b.index);
  // Files changed by each of the last few turns (touched by write tools), keyed by turn index
  req.changed = [...changedByIndex]
    .map(([index, set]) => ({ index, files: [...set] }))
    .sort((a, b) => a.index - b.index);
  copilotLiveCache.set(sessionId, { key, value: req });
  return req;
}

/* ───────────── */

/**
 * The reporter hook's "main console phase": every event writes the current phase (thinking/tool/await)
 * into `sessionPhase` in ~/.workgremlin/hooks/<station>.json (see packages/reporter/src/hook.js).
 * That is reported truth and outranks a phase inferred from genie-history; the UI shows it as truth
 * (not marked "inferred"). Past the freshness window (5 minutes) it is void, so a phase left behind by a
 * closed IDE does not hang around. Also returns `pending` from the same state file (written by PreToolUse,
 * cleared by PostToolUse), used only as the "awaiting authorization" fallback inference.
 * @returns {{phase: string, tool: string, file: string, cmd: string, prompt: string, model: string, client: string, pending: {tool: string, file: string, cmd: string, at: number}|null}|null}
 */
/** GitHub Copilot's real session store is the SQLite `session-store.db`, not a genie-history dir. */
function readSqliteSessionRows(storage) {
  const dbFile = path.join(storage, 'session-store.db');
  if (!isFile(dbFile)) return [];
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => String(c.name || '').trim());
      if (!cols.length) return [];
      const idCol = cols.includes('id') ? 'id' : cols[0];
      const cwdCol = cols.includes('cwd') ? 'cwd' : cols.includes('current_directory') ? 'current_directory' : '';
      const repoCol = cols.includes('repository') ? 'repository' : cols.includes('repo') ? 'repo' : '';
      const updatedCol = ['updated_at', 'last_updated', 'created_at', 'modified_at'].find((name) => cols.includes(name)) || '';
      const summaryCol = cols.includes('summary') ? 'summary' : '';
      const selectCols = [idCol, cwdCol, repoCol, updatedCol, summaryCol].filter(Boolean);
      if (!selectCols.length) return [];
      const query = `SELECT ${selectCols.join(', ')} FROM sessions WHERE ${idCol} IS NOT NULL AND TRIM(${idCol}) <> '' ${updatedCol ? `ORDER BY datetime(${updatedCol}) DESC` : ''}`;
      const rows = db.prepare(query).all();

      // turns table: turn count per session + last user_message (fallback task title / prompt).
      // session_files table: file paths each session touched + tool names (the file-change list).
      // Neither table is guaranteed (Copilot versions may change); missing → empty, no exception surfaced.
      const turnsBySid = readCopilotTurns(db);
      const filesBySid = readCopilotFiles(db);
      // Side evidence for "is this turn in flight" (VS Code's chat index — see readCopilotChatIndex)
      const chatBySid = readCopilotChatIndex();

      return rows
        .map((row) => {
          const id = String(row[idCol] || '').trim();
          if (!id) return null;
          const cwd = cwdCol ? String(row[cwdCol] || '').trim() : '';
          const projectPath = cwd || '';
          const project = resolveProjectName(projectPath) || (projectPath ? path.basename(projectPath) : 'GitHub Copilot');
          const ts = updatedCol ? row[updatedCol] : null;
          // No real timestamp → lastUpdated=0 so the downstream freshness check correctly marks it stale
          // (idle); never fake it with Date.now() — that would stay "fresh" forever and pin the phase to thinking.
          const lastUpdated = ts ? Number(new Date(ts).getTime()) || 0 : 0;
          const summary = summaryCol ? String(row[summaryCol] || '').trim() : '';
          const t = turnsBySid.get(id) || {};
          const rawFiles = filesBySid.get(id) || [];
          // session_files stores absolute paths while other agents use relative ones — normalize to relative
          const files = rawFiles.map((f) => ({
            ...f,
            path: projectPath && f.path ? path.relative(projectPath, f.path) || f.path : f.path,
          }));
          return {
            id,
            project,
            projectPath,
            lastUpdated,
            summary,
            turnCount: t.turnCount || 0,
            lastUserMessage: t.lastUserMessage || '',
            hasPendingTurn: t.hasPendingTurn || false,
            files,
            turns: Array.isArray(t.turns) ? t.turns : [],
            chat: chatBySid.get(id) || null,
            // The newest request (VS Code session log): in flight or not + user text + start/end times
            live: readCopilotLiveRequest(id),
          };
        })
        .filter(Boolean);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Read GitHub Copilot's own SQLite session store (session-store.db) → full session rows.
 * These are 9F's real sessions; without them 9F gets swallowed by other products' plugin dirs in the
 * same directory. Returns an array; each row already carries copilot:true and the enriched fields
 * (phase / inFlight / doneAt / the live* family), merged by id by the caller
 * (sessions.listSessions / syncCopilotTasks).
 * @param {string} storage plugin storage root (the result of findPluginStorage)
 * @param {{ws?: string, now?: number}} o ws = current project (decides `current`), now = current time
 */
function readCopilotSessions(storage, { ws = '', now = Date.now() } = {}) {
  if (!storage) return [];
  const raw = readSqliteSessionRows(storage);
  const out = [];
  for (const row of raw) {
    if (!row || !row.id) continue;
    const inWindow = copilotInWindow(row, now);
    const inFlight = copilotInFlight(row);
    out.push({
      id: row.id,
      // Carry project ownership: sessions.listSessions writes row.project / row.projectPath into meta and
      // decides `current` from them.
      project: row.project,
      projectPath: row.projectPath,
      copilot: true,
      current: Boolean(row.projectPath && row.projectPath === ws),
      active: Boolean(row.lastUpdated && now - row.lastUpdated < IDLE_MS),
      listed: Boolean(row.lastUpdated && now - row.lastUpdated < LISTED_MS),
      live: true,
      lastUpdated: row.lastUpdated || 0,
      runtime: { activated: true, paused: false, awaitingSessionIdle: false },
      pending: 0,
      todos: { total: 0, done: 0, doing: '', items: [] },
      // Copilot's session_files table gives this turn's file paths + tool names; include them when present,
      // otherwise an empty list (older Copilot may lack that table — readCopilotFiles already returns empty).
      files: { count: (row.files || []).length, recent: row.files || [], lastAt: row.lastUpdated || null },
      phase: inWindow ? 'thinking' : 'idle',
      action: '',
      target: '',
      tool: '',
      context: [],
      // The line on the "thinking" screen: while a turn is in flight use the user's exact words from the VS
      // Code session log (newest), otherwise fall back to the last user_message in Copilot's turns table;
      // summary (sessions table) is Copilot's own session title — ship all of them and let the render layer
      // pick by its own rule.
      prompt: (inFlight && row.live && row.live.prompt) || row.lastUserMessage || '',
      // The "task done" marker: 9F has no hook, so the done moment can only come from the session log
      // (completedAt of the newest request) — same rule as 7F/8F's read*Done; past DONE_TTL_MS it is expired
      // (no popup).
      doneAt: copilotDoneAt(row, now),
      doneTitle: row.summary || '',
      doneCount: row.turnCount || 0,
      doneFiles: [],
      // 9F has no hook and cannot see an "interrupted" signal → always show a normal completion, never guess a cancel
      doneCancelled: false,
      inferred: true,
      hasPendingTurn: row.hasPendingTurn || false,
      // "Is this turn in flight": true / false / null (no evidence). The ledger syncer (syncCopilotTasks)
      // uses it to decide whether this session's task is "running" or "done" — more accurate than a time window.
      inFlight,
      /** The turn in flight: user text + start time + turn index (the ledger books per turn) */
      livePrompt: (row.live && row.live.prompt) || '',
      liveStartedAt: (row.live && row.live.startedAt) || 0,
      liveIndex: row.live ? row.live.index : null,
      /** Start/end times of the last few turns (completedAt - elapsedMs from the session log) */
      liveReqs: (row.live && row.live.reqs) || [],
      /** Files **changed** by each of the last few turns (touched by write tools in the log; read_file does not count) */
      liveChanged: (row.live && row.live.changed) || [],
      /** Per-turn listing (turns table): used by the ledger's "one row per turn" */
      copilotTurns: row.turns || [],
    });
  }
  return out;
}

function readCopilotPhaseFromSqlite(workspacePath, client = '', session = '') {
  // copilot-only: `client` now describes the form only (cli / vscode); the floor is guaranteed by the caller
  const storage = findPluginStorage(RE_GITHUB_COPILOT, RE_GITHUB_COPILOT_MARKS);
  if (!storage) return null;
  const rowList = readSqliteSessionRows(storage)
    .filter((r) => (!session || String(r.id || '') === String(session)))
    .filter((r) => (!workspacePath || !r.projectPath || path.resolve(r.projectPath) === path.resolve(workspacePath)));
  if (!rowList.length) return null;
  rowList.sort((a, b) => Number(b.lastUpdated || 0) - Number(a.lastUpdated || 0));
  const row = rowList[0];
  // Phase: trust VS Code's chat index on "is this turn in flight" first; only with no evidence fall back to the
  // 2-minute freshness window. Same rule as listSessions (copilotInWindow) — do not let old sessions show
  // thinking forever, and do not report idle while a turn is actually running.
  const now = Date.now();
  const fresh = copilotInWindow(row, now);
  // The "what the user said" line: while in flight use the exact words from the session log (Copilot's own
  // store only has them once the whole turn is written)
  const prompt = String(
    (fresh && row.live && row.live.prompt) || row.lastUserMessage || row.summary || ''
  ).trim();
  return {
    client: String(client || 'copilot').toLowerCase(),
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
  const storage = findPluginStorage([/github\.copilot/i, /github-copilot/i, /^copilot/i], RE_GITHUB_COPILOT_MARKS);
  if (!storage) {
    copilotModelCache = { at: now, value: '' };
    return '';
  }
  // state.vscdb sits under the globalStorage root (Copilot's plugin storage is a subdir of it)
  const dbFile = path.join(path.dirname(storage), 'state.vscdb');
  let db = null;
  try {
    if (!fs.existsSync(dbFile)) {
      copilotModelCache = { at: now, value: '' };
      return '';
    }
    const Database = require('better-sqlite3');
    db = new Database(dbFile, { readonly: true, fileMustExist: true });
    // The currently selected model identifier (e.g. "copilot/gpt-5-mini")
    const row = db.prepare("select value from ItemTable where key = 'chat.currentLanguageModel.editor'").get();
    const identifier = row ? String(row.value || '').trim() : '';
    if (!identifier) {
      copilotModelCache = { at: now, value: '' };
      return '';
    }
    // Look up the display name in cachedLanguageModels (e.g. "GPT-5 mini")
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
    // No display name → use the identifier minus the vendor prefix ("copilot/gpt-5-mini" → "gpt-5-mini")
    const fallback = identifier.replace(/^[^/]+\//, '');
    copilotModelCache = { at: now, value: fallback };
    return fallback;
  } catch {
    copilotModelCache = { at: now, value: '' };
    return '';
  } finally {
    if (db) {
      try { db.close(); } catch { /* Failing to close does not affect the read */ }
    }
  }
}

/* ───────────── */

/**
 * 9F's done marker (session-table shape `{doneAt,doneTitle,doneCount,doneFiles}`, same shape as every
 * product's read*Done). Takes completedAt of the newest turn in the session log; none when past
 * DONE_TTL_MS or when that turn has not finished.
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

/** Copilot's phase freshness window: activity within 2 minutes = thinking, beyond that = idle.
 *  Much shorter than IDLE_MS — IDLE_MS governs "alive or not" (active within 10 minutes), this governs
 *  "thinking right now" (2 minutes of silence = idle). Same order as Kilo's PHASE_FRESH_MS. */
const COPILOT_PHASE_MS = 2 * 60_000;

/* ───────────── */

/**
 * GitHub Copilot's own plugin storage dir name. `/copilot/i` would also match Tencent's
 * `tencent-cloud.coding-copilot`, so it must be anchored at the start.
 */
const COPILOT_STORAGE_RE = /^(?:github[.\-]?copilot|copilot)/i;

/* ───────────── */

/**
 * Copilot tools that **write files** (toolId). Only files touched by these count as "this turn's changed files".
 * Measured (0.65.0) toolIds look like: copilot_readFile / copilot_findTextInFiles / run_in_terminal /
 * copilot_replaceString / copilot_multiReplaceString / manage_todo_list…
 * — the session_files table holds **only read_file**, so using it as "changed files" is wrong (caught by
 * the user in practice).
 */
const COPILOT_WRITE_TOOL_RE =
  /replace|patch|create[_.]?file|write[_.]?file|edit[_.]?file|insert[_.]?edit|apply[_.]?edit|multi[_.]?replace|delete[_.]?file|move[_.]?file/i;

/* ───────────── */

/**
 * Side evidence for "is this Copilot turn in flight".
 *
 * Copilot's own session-store.db is written **only when the whole turn finishes**: the turns row appears
 * together with assistant_response, and sessions.updated_at moves at that same moment — "generating" is
 * simply invisible in that store. Watching only updated_at's 2-minute window produces the ugliest kind of
 * error: **idle while it is running, thinking right after it finished** (measured 2026-09-28).
 *
 * VS Code keeps a finer index of its own: `chat.ChatSessionStore.index` in
 * `workspaceStorage/<hash>/state.vscdb`, where each session carries `timing.lastRequestStarted /
 * lastRequestEnded` (plus lastResponseState / hasPendingEdits). started later than ended (or no ended at
 * all) = this turn is still in flight. Read-only here; unreadable → empty Map and the upper layer falls
 * back to the original time-window inference.
 */
const COPILOT_INDEX_TTL = 2_000;

/* ───────────── */

/** dbFile -> { mtimeMs, size, at, entries }: unchanged file → do not reopen the db (the phase polls every 1.5s) */
let copilotIndexCache = new Map();

/* ───────────── */

/** sessionId -> { key, value }: the log is append-only, so unchanged mtime+size means no need to reread */
const copilotLiveCache = new Map();

/* ───────────── */

/**
 * The model Copilot currently has selected. Read `chat.currentLanguageModel.editor` from VS Code's
 * state.vscdb; the value looks like `copilot/gpt-5-mini`, then `chat.cachedLanguageModels` gives the
 * display name (e.g. "GPT-5 mini"). Returns an empty string when unavailable — no guessing.
 *
 * Same idea as TraeCode's traeModels.selectedModelOf: the model lives in globalStorage's state.vscdb,
 * Copilot's own session-store.db does not record models.
 */
const COPILOT_MODEL_CACHE_TTL = 15_000;

/* ───────────── */

let copilotModelCache = { at: 0, value: '' };

/* ───────────── Syncer from the old copilotTasks.js ───────────── */

'use strict';

/**
 * 9F GitHub Copilot's task syncer.
 *
 * Copilot has no reporter hook and never writes into WorkGremlin's tasks table → the task list
 * (TaskRecordsView, served by /api/v1/task-runs) would never show 9F's tasks. This syncer periodically
 * polls Copilot's own session-store.db (already read by sessions.readSqliteSessionRows: sessions + turns
 * + session_files) plus VS Code's session log (chatSessions/<session>.jsonl, see
 * sessions.readCopilotLiveRequest), and writes **each turn of user work** as one task + task_run so the
 * task list can show 9F.
 *
 * Design:
 * - Idempotent: task id = `copilot:<session_id>:<turn index>`; each pass upserts, never duplicates.
 * - Quiet: no WS broadcast (the 2s session scan loop picks changes up and pushes them naturally).
 * - Writes only columns task_runs actually has (client/session_id/file_count/files_json/title/started_at/
 *   ended_at); does not invent model/result (Copilot's store has no model column).
 * - State: turn still in flight → state=running, ended_at=null; finished → state=done, ended_at=finish time.
 *   "In flight" trusts VS Code's two pieces of evidence (state.vscdb's chat index / the session log's
 *   completion marker); only when neither knows does it fall back to the time window — Copilot's own store
 *   lands only after the whole turn, so a time window alone judges backwards.
 */




/** Copilot phase freshness window: activity within 2 minutes = running, beyond that = done.
 *  Shorter than IDLE_MS (10 minutes, "alive or not"); this governs "running right now". */
const PHASE_MS = 2 * 60_000;
const SYNC_INTERVAL_MS = 5_000;

/** Task id prefix, so ids never collide with tasks written by the reporter hook */
const TASK_ID_PREFIX = 'copilot:';

/**
 * The **reported identity** this layer writes into the ledger / member table.
 *
 * client is always the **floor base name** `copilot` (the form travels as `form`); 9F's clients are derived
 * from sources and are now ['copilot'] too, so both sides agree when the task list filters by floor clients.
 * (Legacy rows carrying a `-plugin` suffix are erased by the DB's client normalization migration; the ingest
 * side's bus.normClient strips it as well.)
 */
const CLIENT = 'copilot';

/**
 * @param {{bus: any, repo: any, now?: () => number}} ctx
 * @returns {number} how many tasks this sync wrote/changed
 */
/** This project's name (project id) — members / the ledger are grouped by it */
function projectIdOf(s) {
  const projectPath = s.projectPath || '';
  return s.project || (projectPath ? path.basename(projectPath) : 'GitHub Copilot');
}

/**
 * Whether this session counts as "running" right now.
 *
 * Trusts the session row's `inFlight` first ("is this turn in flight", from VS Code's chat index — see
 * readCopilotChatIndex in sessions.js) — Copilot's own store lands only after the whole turn, so a time
 * window alone shows "idle while running, thinking after it is done". Only when there is no evidence
 * (old version / db locked, inFlight === null) does it fall back to the PHASE_MS (2 minutes) freshness window.
 *
 * 2 minutes instead of IDLE_MS (10 minutes): 10 is too long, a finished task stays "running" for 10 minutes.
 */
function isSessionActive(s, now) {
  if (typeof s.inFlight === 'boolean') return s.inFlight;
  return Boolean(s.lastUpdated && now - s.lastUpdated < PHASE_MS);
}

/**
 * Write one ledger row (a line in both tasks and task_runs). 9F is **one row per turn**, see
 * syncCopilotTasks' notes.
 * @returns {string|null} this record's files_json, reused directly by the workstation card
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
  // Fill file_count / files_json / ended_at / duration_ms (upsertTaskRun does not write those columns)
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
 * Retract misattributed in-flight rows.
 *
 * Only this syncer writes 9F's ledger (`copilot:` prefix + client=copilot-plugin), so those rows are its own
 * to manage. The historical version asked listSessions with the shared PLUGIN_RE, which matches other
 * products' plugin dirs (Tencent CodeBuddy's tencent-cloud.coding-copilot, Trae's coding-copilot) — sessions
 * running on those floors were written as Copilot tasks whose title could only fall back to the placeholder
 * "(Copilot 会话)". Worse, such rows **never finish**: completion depends on Copilot's own turns table, and
 * another product's session simply is not in it → the task records page hangs on one "in progress" row
 * forever. (Measured by the user on 2026-09-30: open VS Code, type nothing into Copilot Chat, and 9F pops one.)
 *
 * Restraint: **delete only rows proven to belong to someone else** — the session id appears in another
 * product's structured on-disk state (nonCopilotSessionIds in sessions.js). Copilot's own history is never
 * touched (even rows long past the listing window and absent from sessions now), and rows without ownership
 * evidence are kept — better to keep a wrong row than to delete a real record.
 *
 * @param {any} repo
 * @param {Set<string>} copilotIds every Copilot session id recognized in this listing
 * @returns {number} how many were retracted
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

function syncCopilotTasks({ bus, repo, now: nowFn = Date.now }) {
  const now = nowFn();
  /*
   * The session listing must be locked to **GitHub Copilot's own on-disk state**; it must not consume
   * listSessions' default PLUGIN_RE: that list contains `/^tencent/` and `/coding-copilot/i`, which on this
   * machine match Tencent CodeBuddy's `tencent-cloud.coding-copilot` — a session running on another floor
   * would then be written into 9F as a Copilot session (measured by the user: open VS Code, ask nothing, and
   * a "(Copilot 会话)" row appears in flight in the task records).
   * `copilot === true` is the second gate: only rows read out of Copilot's own session-store.db count.
   */
  // Go through the generic listSessions' copilot branch: internally it locks onto GitHub Copilot's own
  // session-store.db with RE_GITHUB_COPILOT, then reads the disk into ledger-shaped rows carrying
  // `copilot: true` (see sessions.listSessions → readCopilotSessions). sessions.js only dispatches "generic
  // plugin on-disk state" and hides no copilot fallback logic.
  // Deferred require: copilot.js must not depend back on sessions.js at module top level (load-time cycle).
  // ws is not passed (task syncing reconciles the full session set and does not depend on "the current
  // project"): current is always false and syncCopilotTasks never consumes it anyway.
  const sessions = (require('./sessions').listSessions({
    force: true,
    client: 'copilot',
    pluginRe: RE_GITHUB_COPILOT,
  }).sessions || []).filter((s) => s.copilot === true);
  const liveByProject = new Map();
  for (const s of sessions) {
    const projectId = s.project || (s.projectPath ? path.basename(s.projectPath) : 'GitHub Copilot');
    if (!liveByProject.has(projectId)) liveByProject.set(projectId, []);
    if (s.id) liveByProject.get(projectId).push(s.id);
  }
  const reconcileSessionStatuses = () => {
    if (typeof bus.pruneSessionStatuses === 'function' && repo.listMembersByClient) {
      for (const member of repo.listMembersByClient.all(CLIENT)) {
        bus.pruneSessionStatuses({
          project: member.project_id,
          memberId: member.id,
          sessionIds: liveByProject.get(member.project_id) || [],
          ts: now,
        });
      }
    }
  };
  // Run even when there is not a single Copilot session: the misattributed row above appeared on exactly
  // such a machine (only other products' on-disk state present).
  pruneForeignRunningRuns(repo, new Set(sessions.map((s) => String(s.id || '')).filter(Boolean)));
  if (!sessions.length) {
    reconcileSessionStatuses();
    return 0;
  }

  // Copilot's model lives in VS Code's state.vscdb (chat.currentLanguageModel.editor), not per session —
  // one global value shared by all sessions. Leave it empty when unavailable; do not fake a default model.
  // Resolved through module.exports so tests can swap copilotCurrentModel for a stub (see taskSync.test.js)
  // without changing behavior.
  const model = module.exports.copilotCurrentModel();
  let count = 0;
  for (const s of sessions) {
    const projectPath = s.projectPath || '';
    const projectName = s.project || (projectPath ? path.basename(projectPath) : 'GitHub Copilot');
    const projectId = projectName;

    // Make sure the project & member exist (quiet write, no broadcast)
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
      ephemeral: 0,
      projectLabel: null,
      client: CLIENT,
    });

    /*
     * Ledger rule: **one row per turn of user work** (same as other floors), not "one row per session".
     * Title = what the user said in that turn; start/end = that turn's start/end (use the accurate values
     * when the session log can compute them; for old turns already scrolled out of the log tail use the
     * moment Copilot itself landed that turn — never invent).
     * The in-flight turn also lands a running row first — Copilot's store writes turns rows only after the
     * whole turn finishes, so waiting for it alone means the list never shows a "running" row while the
     * user is running a task.
     */
    const isActive = isSessionActive(s, now);
    const turns = Array.isArray(s.copilotTurns) ? s.copilotTurns : [];
    const changedByIndex = new Map(
      (Array.isArray(s.liveChanged) ? s.liveChanged : []).map((c) => [Number(c.index), c.files || []])
    );
    /**
     * Which files this record should carry: **only those touched by "write" tools in the session log**
     * (copilot_replaceString / copilot_multiReplaceString …); read_file / findTextInFiles are not changes.
     * Why not the session_files table: measured, that whole table is read_file (Copilot only records "read"),
     * so using it as changed files reports dozens of files even when the user asked for no edits (exactly
     * what the user caught in practice). Turns already scrolled out of the log window stay empty — never
     * substitute "files that were read".
     */
    const filesFor = (idx) => {
      const own = changedByIndex.get(idx) || [];
      const rel = own
        .map((abs) => {
          const p = String(abs || '');
          if (!p || !projectPath) return p;
          const r = path.relative(projectPath, p);
          return r && !r.startsWith('..') ? r : ''; // Files outside the project do not enter this column
        })
        .filter(Boolean);
      return rel.length ? [...new Set(rel)] : null;
    };
    const liveReqByIndex = new Map(
      (Array.isArray(s.liveReqs) ? s.liveReqs : []).map((r) => [r.index, r])
    );

    // ① Every finished turn: one record (the title is that turn's exact user text)
    for (const t of turns) {
      const id = `${TASK_ID_PREFIX}${s.id}:${t.index}`;
      const title = t.userMessage || s.doneTitle || s.prompt || '(Copilot 会话)';
      const known = liveReqByIndex.get(t.index);
      const startedAt = (known && known.startedAt) || t.at || s.lastUpdated || now;
      const endedAt = (known && known.endedAt) || t.at || startedAt;
      // If we first said "start unknown" and later computed it exactly from the session log → rebuild this
      // derived record once. Otherwise insertTask's COALESCE keeps the old tasks.started_at while duration
      // is computed from the new value, producing the odd "started_at later than ended_at" (measured
      // 17:17:45 → 17:17:44).
      const prev = repo.getTask.get(id);
      if (prev && known && known.startedAt && prev.started_at !== startedAt) repo.deleteTaskRun(id);
      writeTurnRun(repo, {
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
      count += 1;
    }

    // ② The in-flight turn: one running row (the user's text comes from the VS Code session log — Copilot's
    //    store does not have it yet)
    let runningId = '';
    if (isActive) {
      // Turn index = the one from the session log; before the log is complete fall back to "last turn + 1".
      // It must be greater than the largest finished turn index — otherwise the previous turn's done record
      // gets flipped back to running.
      const lastDone = turns.length ? turns[turns.length - 1].index : -1;
      const logIdx = Number.isFinite(Number(s.liveIndex)) && s.liveIndex != null ? Number(s.liveIndex) : -1;
      const idx = Math.max(logIdx, lastDone + 1);
      runningId = `${TASK_ID_PREFIX}${s.id}:${idx}`;
      const title = s.livePrompt || s.prompt || s.doneTitle || '(Copilot 会话)';
      writeTurnRun(repo, {
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
      count += 1;
    }

    // ③ Retract the transitional "one row per session" legacy record (id without a turn index; own prefix only)
    const legacyId = `${TASK_ID_PREFIX}${s.id}`;
    if (repo.getTaskRun.get(legacyId)) repo.deleteTaskRun(legacyId);

  }

  reconcileSessionStatuses();
  return count;
}

/* ── Unified contract aliases + exports (via mutation, so the C reference held while sessions.js cycles stays stable) ── */
module.exports.client = 'copilot';
module.exports.RE_GITHUB_COPILOT = RE_GITHUB_COPILOT;
// Product detection metadata (the old products.js 9F entry): 9F has only the plugin form.
const meta = {
  id: '9F',
  name: 'GitHub Copilot',
  kind: 'plugin',
  cmd: 'copilot',
  agent: 'copilot',
  plugin: true,
  pluginRe: RE_GITHUB_COPILOT,
  // This floor's plugin storage root marker: the same-prefixed `github.copilot` (base extension) has no
  // session store, so session-store.db filters it out
  pluginStorageMarks: ['session-store.db'],
  // Show only the GitHub Copilot VS Code plugin layer (no standalone CLI form).
  sources: ['plugin'],
  dataKind: 'copilot',
  // On-disk detection (used by findDataPath): the plugin form lives under VS Code's globalStorage
  matchRe: RE_GITHUB_COPILOT,
  homeDirs: [path.join(HOME, '.config', 'Code', 'User', 'globalStorage')],
};
module.exports.meta = meta;
/**
 * 9F's static subagent definition dirs. GitHub Copilot has no "user-level / project-level agent definition
 * file" mechanism (its globalStorage is not an agent definition dir), so this returns [] and scans nothing.
 * @returns {Array<{dir:string, level:'project'|'user'}>}
 */
module.exports.agentDirs = function agentDirs() {
  return [];
};
module.exports.syncCopilotTasks = syncCopilotTasks;
module.exports.syncTasks = syncCopilotTasks;
// Unified poll contract: the server calls syncTasks on this floor's pollMs (floors hold no timers — see poller.js)
module.exports.pollMs = SYNC_INTERVAL_MS;
module.exports.readPhase = readCopilotPhaseFromSqlite;
module.exports.readDone = readCopilotDone;
module.exports.modelOf = copilotCurrentModel;
/* Readers (from the old sessions.js) */
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
/* Readers (from the old sessions.js) + 9F-only SQLite session assembly */
module.exports.readSqliteSessionRows = readSqliteSessionRows;
module.exports.readCopilotSessions = readCopilotSessions;
module.exports.copilotCurrentModel = copilotCurrentModel;
module.exports.readCopilotDone = readCopilotDone;
module.exports.COPILOT_PHASE_MS = COPILOT_PHASE_MS;
module.exports.COPILOT_STORAGE_RE = COPILOT_STORAGE_RE;
module.exports.COPILOT_WRITE_TOOL_RE = COPILOT_WRITE_TOOL_RE;
module.exports.COPILOT_INDEX_TTL = COPILOT_INDEX_TTL;
