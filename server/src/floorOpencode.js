'use strict';

/**
 * 8F OpenCode's data source —— reads its own on-disk SQLite (the polling path).
 *
 * **Why 8F cannot copy 7F**: Kilo and OpenCode share an origin (Kilo Code CLI is a fork of OpenCode),
 * but **their V2 schemas have diverged**. Measured 2026-09-26 (Kilo Code 7.8.1 / OpenCode 2.0.18):
 *
 *                        Kilo 7.8.1            OpenCode 2.0.18
 *   event stream table    2288 rows (on disk)  **0 rows** (streamed in memory only, not persisted)
 *   messages              message(135)+part(650) session_message(119), no part table
 *   session table         session              session_v2 (+time_idle/idle_outcome/time_suspended)
 *   unique tables         todo / kilo_board / … session_inbox / session_pending / instruction_* / permission
 *
 * So 7F's "derive the phase from the `event` table's parts" (see readKiloPhase in kilo.js) has **no data
 * to read on OpenCode at all** —— its `event` table is empty (event_sequence has counts, but the events
 * themselves are not persisted).
 * 8F instead takes parts from `session_message`'s `content[]`, whose shape is **isomorphic** to Kilo's
 * parts:
 *
 *   session_message(id, session_id, type, seq, time_created, time_updated, data)
 *     type  ∈ assistant | user | idle | synthetic
 *     data  = { time:{created,streamed,completed}, agent, model, content:[part], finish, cost, tokens, snapshot }
 *     part  ∈ { type:'tool',     name, state:{ status, input } }
 *            { type:'reasoning', text }
 *            { type:'text',      text }          ← measured across the whole DB: only these three, no patch
 *     tool's state.status ∈ **completed | error | running** (measured across all 114 assistant messages)
 *
 * **One measured conclusion that must be written down**: Kilo's `state.status` has `pending` (= awaiting
 * permission), **OpenCode does not** —— only completed / error / running ever appear in the whole DB. So
 * **pure polling can never derive "awaiting permission"**: OpenCode makes authorization a separate event
 * (measured in the event stream: `permission.asked` / `permission.replied`, payload
 * `{ id, sessionID, action, resources[], source:{type,messageID,id} }`), and that signal only lives in the
 * in-memory event stream, never reaching the DB. That is the hard reason 8F hangs an extra **plugin** path
 * (see packages/reporter/src/plugin/): with the plugin installed the phase is **reported truth** (not
 * flagged inferred, not grayed out in the UI) and can show "awaiting permission"; without it, it falls
 * back to the polling derivation below, at the cost of a grayed-out inferred phase and no "awaiting
 * permission".
 *
 * **Do not be misled by OpenCode's `permission` table** (checked in the shipped binary, 2026-10-18): its
 * shape is `permission(id, project_id, action, resource, time_created, time_updated)` with a UNIQUE index on
 * `(project_id, action, resource)`, and it backs the `permission.saved.list` / `/api/permission/saved` API ——
 * i.e. it stores the **allow rules the user has already granted** (measured: the 3 rows matched exactly the
 * 3 paths the user approved), not pending requests. A pending request is an in-memory `Map` entry published
 * as `permission.asked` and listed by `permission.request.list` / `/api/permission/request`; it has no row
 * anywhere (the persisted `event` table is empty —— only `event_sequence` counters exist). So this table is
 * **not** a way to derive "awaiting permission" by polling.
 *
 * Phase derivation (look back from the newest message's content[] for the first part carrying a signal):
 *   tool + running   → calling a tool (tool name / command from part.state.input)
 *   tool + error     → called a tool but it errored
 *   reasoning        → thinking
 *   text             → standby (just finished emitting text)
 *   finish=stop      → standby (done talking this round)
 *   type=idle row    → standby (**explicit** idle marker, data.outcome ∈ succeeded | interrupted)
 *   nothing matches / events too old → standby
 *
 * **Discipline (aligned with requirements.md §P0-6 "never fabricate")**: every phase on the polling path
 * carries `inferred: true`.
 * We **poll** its DB, it does not report to us, so "what the last message looked like" can only infer
 * "roughly what it is doing now".
 * The UI grays out "inferred", same treatment as 5F / the CLI on-disk floors.
 *
 * Three reading disciplines (same as kilo.js):
 *   1) **Always open read-only** (readonly + fileMustExist). OpenCode is writing this DB (WAL mode;
 *      measured, reading while it runs is fine), and a read-only connection neither blocks it nor gets
 *      corrupted by it; unreadable means "no data", never write.
 *   2) **Short timeout** (3s). Give up at once when its checkpoint / migration holds it —— better to have
 *      no phase this round than to drag /api/v1/sessions down (the render layer polls every 1.5s).
 *   3) **A failed table scan must not bubble up**. This is another product's private storage, and OpenCode
 *      renaming tables on some update is only a matter of time (Kilo → OpenCode already did it once:
 *      session → session_v2); unreadable means empty, so 8F shows "not connected" instead of turning the
 *      endpoint into a 500.
 *
 * Caching: the session table 5s (same order of magnitude as sessions.js / sessionRegistry's TTL).
 * Phases and done markers are **not cached** —— the render layer pulls every 1.5s, better to read the DB
 * one more time.
 */

const os = require('node:os');
const path = require('node:path');
const { DEFAULTS, formToSource } = require('@workgremlin/shared');
const { openReadonly, readOne } = require('./dbReadonly');
const { isFile } = require('./roots');
const { resolveProjectName } = require('./project');
// Static subagent directories (project-level / user-level): private knowledge of this floor, kept here
// rather than in the central agentLevel
const { genericAgentDirs, makeAgentSync } = require('./ingest/agentLevel');

/**
 * 8F's static subagent definition directories. OpenCode has no "user-level / project-level agent
 * definition file" mechanism yet, so this goes through the generic derivation (meta.homeDirs is empty →
 * returns [], no disk scan). If OpenCode ever puts agent definitions in some directory, just give the
 * explicit directories here (same interface as CodeBuddy / Codex / Claude).
 * @returns {Array<{dir:string, level:'project'|'user'}>}
 */
function agentDirs(workspacePath) {
  return genericAgentDirs((meta && meta.homeDirs) || [], workspacePath);
}

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';

/**
 * 8F OpenCode floor metadata (formerly the 8F entry in products.js). CLI and desktop/web merged floor.
 */
const meta = {
  id: '8F',
  name: 'OpenCode',
  kind: 'cli',
  cmd: 'opencode',
  agent: 'opencode',
  plugin: false,
  sources: [
    {
      kind: 'opencode',
      label: 'CLI/Desktop',
      client: 'opencode',
      dirs: [opencodeHome()],
    },
    // The hook path: the true-phase path once the WorkGremlin plugin is installed. The client is
    // always the floor base name opencode, and there is no separate "plugin form": OpenCode's VS
    // Code extension only drives the same opencode binary against the same data root, so OpenCode
    // stays cli (see packages/reporter/src/plugin/index.js's VSCODE_ENV).
    { kind: 'hook' },
  ],
  hookSource: true,
  dataKind: 'opencode',
  // OpenCode CLI's own install directory (fallback when PATH lookup fails)
  cliBinDirs: [path.join(HOME, '.opencode', 'bin')],
};

/** Timeout for opening a read-only connection; give up on this round when OpenCode holds it */
const OPEN_TIMEOUT_MS = 3_000;
/** Session table cache (sessions change slower than phases, 5s is enough; same order as sessionRegistry's TTL) */
const TTL = 5_000;

let cache = { at: 0, key: '', value: null };

/* ------------------------------ Locating the on-disk data ------------------------------ */

/**
 * OpenCode's data root (XDG convention, platform standard directories, not a hidden dir like ~/.opencode).
 *
 * Three sources, highest priority first:
 *   1. `WORKGREMLIN_OPENCODE_HOME` —— explicit (tests / non-standard installs / the user moved it)
 *   2. `XDG_DATA_HOME/opencode`   —— the XDG standard location
 *   3. platform default (see below)
 *
 * `~/.opencode` is **not** the data root: measured, that directory only holds `bin/opencode` (the
 * executable itself), while sessions, logs, snapshots and SQLite all live under the data root. Treating it
 * as the on-disk location shows "installed but 0 sessions".
 */
function opencodeHome() {
  const env = String(process.env.WORKGREMLIN_OPENCODE_HOME || '').trim();
  if (env) return path.resolve(env);
  const xdg = String(process.env.XDG_DATA_HOME || '').trim();
  if (xdg) return path.join(path.resolve(xdg), 'opencode');
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'opencode');
  }
  if (IS_WIN) {
    return path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'opencode');
  }
  return path.join(HOME, '.local', 'share', 'opencode');
}

/** Absolute path of the session DB; empty string when the file does not exist (OpenCode not installed / never run) */
function opencodeDbPath() {
  const explicit = String(process.env.WORKGREMLIN_OPENCODE_DB || '').trim();
  const p = explicit ? path.resolve(explicit) : path.join(opencodeHome(), 'opencode.db');
  return isFile(p) ? p : '';
}

/**
 * Session title (8F OpenCode): the SQLite session's title column (OpenCode's column name differs by
 * version, so it adapts). opencodeTitleOf from the old sessionTitle.js moved here —— debugging 8F titles
 * no longer touches a central file.
 * @param {string|null|undefined} sessionId
 * @returns {string}
 */
function sessionTitle(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const db = openReadonly(opencodeDbPath());
  if (!db) return '';
  try {
    let titleCol = '"title"';
    const cols = readOne(db, "PRAGMA table_info('session')");
    const hasTitle = Array.isArray(cols) ? cols.some((c) => String(c.name || '').toLowerCase() === 'title') : false;
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

/** Shrink an absolute path to a ~ prefix (easier to read in the UI) */
function shorten(p) {
  if (!p) return '';
  if (HOME && p.startsWith(HOME)) return `~${p.slice(HOME.length)}`;
  return p;
}

/* ------------------------------ Read-only connection ------------------------------ */

/**
 * Open a **read-only** connection; return null whenever it cannot be had (not installed / never run / DB
 * locked / table shape changed).
 *
 * Read-only is a hard requirement, not a shortcut: OpenCode is writing this DB, and we must neither lock
 * it nor corrupt it just to monitor. In WAL mode a read-only connection does not block the writer and both
 * can coexist (measured, reading while it runs is fine).
 */
function openDb() {
  const file = opencodeDbPath();
  if (!file) return null;
  let Database;
  try {
    // better-sqlite3 is an existing server dependency (see server/src/db/index.js), use the workspace copy
    // rather than compiling another native module inside the adapter.
    Database = require('better-sqlite3');
  } catch {
    return null; // the native module was not built: 8F cannot read, the other floors carry on
  }
  try {
    return new Database(file, { readonly: true, fileMustExist: true, timeout: OPEN_TIMEOUT_MS });
  } catch {
    return null;
  }
}

/**
 * Run a callback on the read-only connection; a missing table / bad SQL (a version renamed tables) return
 * null.
 * @param {(db: any) => any} fn
 * @returns {any|null}
 */
function query(fn) {
  const db = openDb();
  if (!db) return null;
  try {
    return fn(db);
  } catch {
    return null; // unreadable means "no data", it does not bubble up (discipline 3 in the file header)
  } finally {
    try {
      db.close();
    } catch {
      /* fine if it cannot be closed, the result is already in hand */
    }
  }
}

/**
 * The session table is called `session_v2` (measured on 2.0.18), but old versions call it `session`, and
 * Kilo still calls it `session` to this day —— recognize both, probe by priority, use whichever exists.
 * Hardcoding one name ties 8F to one version.
 * @param {any} db
 * @returns {string} table name; empty string when neither exists
 */
function sessionTable(db) {
  let names = [];
  try {
    names = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => String(r.name || ''))
    );
  } catch {
    return '';
  }
  for (const t of ['session_v2', 'session']) if (names.has(t)) return t;
  return '';
}

/** Whether these tables are really in the DB —— gives the frontend a line explaining "this path reads no sessions" */
function hasCoreTables() {
  return (
    query((db) => {
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_v2','session','session_message')")
        .all()
        .map((r) => String(r.name || ''));
      const hasSession = names.includes('session_v2') || names.includes('session');
      return hasSession && names.includes('session_message');
    }) === true
  );
}

/* ------------------------------ Session list ------------------------------ */

/** The model field in the DB is a JSON string; take the id for display (leave empty when it cannot be had, do not guess) */
function modelIdOf(raw) {
  try {
    const j = JSON.parse(String(raw || ''));
    return String((j && (j.id || j.modelID)) || '');
  } catch {
    return '';
  }
}

/**
 * All of OpenCode's sessions (not archived, not suspended), newest update first.
 *
 * Filter criteria:
 *   `time_archived IS NULL` —— an archived session is not "running" (that timestamp is stamped when the
 *                            user archives it manually).
 *   `parent_id IS NULL`    —— subagent sessions are not independent sessions: their parent_id points at
 *                            the parent session and they belong to the same "workstation". Taking them in
 *                            means one main session plus N subagents produces N extra sessions, all noise
 *                            (same reasoning as sessionRegistry's scanCliSessions skipping
 *                            `<session id>/subagents/`).
 *
 * **`time_suspended` is deliberately not filtered** (measured: this column does get values, stamped when a
 * session is suspended/resumed): suspension is a **temporary** state, and after resuming time_updated keeps
 * advancing, so this session is supposed to reappear in the office. Using it as a filter would hide a real
 * session permanently —— better to let it show as "standby" than to pretend it does not exist.
 * (7F's kilo.js likewise only filters time_archived; both layers keep the same criterion.)
 *
 * Field mapping (→ sessionRegistry's session rows):
 *   id → session id (axis 2, `ses_xxx` is the session_id in the hook sense)
 *   directory → project path (each session records its own working directory, more accurate than
 *               project.worktree —— when a worktree sub-session runs elsewhere, directory is the truth)
 *   max(time_updated, newest session_message time) → last activity time. Measured 2026-10-18:
 *   `time_updated` alone is unreliable (it is NOT bumped on every message and freezes while the session
 *   waits on a permission prompt), see the note on `hasMsgTime` below.
 *
 * Columns are assembled by **probing** (pickSessionColumns below): a missing column must neither fail the
 * whole query nor turn the whole floor into a 500.
 *
 * **Council participants do not enter this table** (rows with `title = COUNCIL_SESSION_TITLE` are skipped
 * outright): the reasoning is word for word the same as 7F's, see the note above the filter of the same
 * name in kilo.js. One extra point here: the title column is also used by probing, so when an old DB has no
 * title column **no filtering happens** (better to list one real session extra than to empty the whole
 * floor over a missing column).
 *
 * @returns {Array<{id,title,directory,project,projectPath,lastEventAt,agent,model,fileCount,additions,deletions}>}
 */
function listOpencodeSessions() {
  const now = Date.now();
  const file = opencodeDbPath();
  // The cache is keyed by **DB file path**: swapping OPENCODE_HOME / the DB will not serve the other
  // location's sessions.
  // When it cannot be read (not installed / locked / table shape changed) an empty list is cached, so the
  // 1.5s polling does not hit the lock every time.
  if (cache.value && cache.key === file && now - cache.at < TTL) return cache.value;
  const value = listOpencodeSessionsUncached();
  cache = { at: now, key: file, value };
  return value;
}

function listOpencodeSessionsUncached() {
  const rows = query((db) => {
    const table = sessionTable(db);
    if (!table) return null;
    const cols = pickSessionColumns(db, table);
    if (!cols.has('id')) return null;

    const want = ['id', 'title', 'directory', 'agent', 'model', 'time_updated', 'summary_files', 'summary_additions', 'summary_deletions'];
    const sel = want.filter((c) => cols.has(c)).map((c) => `"${c}"`).join(', ');

    /**
     * Last activity must not rely on `session_v2.time_updated` alone.
     * Measured 2026-10-18: `time_updated` is **not** bumped on every message —— during an active turn
     * it lagged the newest `session_message` by minutes, and while the session sat on a permission
     * prompt it stopped moving entirely. A long "awaiting authorization" wait therefore crossed the
     * registry's 60-minute TIMEOUT_MS and the session dropped out of the dropdown ("No project open").
     * `session_message.time_updated` advances with every message / streaming update and is the real
     * "this session is still alive" signal, so take whichever is newer.
     */
    const hasMsgTime =
      tableExists(db, 'session_message') && pickSessionColumns(db, 'session_message').has('time_updated');
    const lastMsgCol = hasMsgTime
      ? `, (SELECT MAX("time_updated") FROM "session_message" m WHERE m."session_id" = "${table}"."id") AS "last_message_at"`
      : '';

    const where = [];
    if (cols.has('time_archived')) where.push('"time_archived" IS NULL');
    if (cols.has('parent_id')) where.push('"parent_id" IS NULL');
    // Council participants: when an old DB has no title column, this filter is skipped (better one extra
    // row than an emptied floor).
    // It goes last, so the parameter array below holds only this one value.
    const skipCouncil = cols.has('title');
    if (skipCouncil) where.push('("title" IS NULL OR "title" <> ?)');
    const params = skipCouncil ? [DEFAULTS.COUNCIL_SESSION_TITLE] : [];
    const order = cols.has('time_updated') ? '"time_updated" DESC' : 'rowid DESC';

    return db
      .prepare(`SELECT ${sel}${lastMsgCol} FROM "${table}"${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`)
      .all(...params);
  });

  return (Array.isArray(rows) ? rows : []).map((r) => {
    const dir = String(r.directory || '');
    return {
      id: String(r.id || ''),
      title: String(r.title || ''),
      directory: dir,
      project: dir ? resolveProjectName(dir) || path.basename(dir) : '',
      projectPath: dir,
      lastEventAt: Math.max(Number(r.time_updated) || 0, Number(r.last_message_at) || 0),
      agent: String(r.agent || ''),
      model: modelIdOf(r.model),
      fileCount: Number(r.summary_files) || 0,
      additions: Number(r.summary_additions) || 0,
      deletions: Number(r.summary_deletions) || 0,
    };
  });
}

/** Whether a table exists —— probing columns must not fail the whole query when a table is absent (old DBs) */
function tableExists(db, name) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(String(name)));
  } catch {
    return false;
  }
}

/** Which columns this session table really has (a missing column must not turn the whole floor into a 500, see the function note) */
function pickSessionColumns(db, table) {
  try {
    return new Set(
      db
        .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
        .all()
        .map((r) => String(r.name || ''))
    );
  } catch {
    return new Set();
  }
}

/* ------------------------------ Phase derivation ------------------------------ */

/**
 * A session's **current phase** (derived by polling, carries inferred).
 *
 * Take the last few messages of this session (session_message has a unique index on (session_id, seq), so
 * taking the tail is cheap), and look from new to old for **the first one carrying a signal**:
 *
 *   tool + running → calling a tool (tool name / actual command from part.state.input)
 *   tool + error   → called a tool but it errored
 *   reasoning      → thinking
 *   text           → standby (just finished emitting text)
 *   finish=stop    → standby (done talking this round)
 *   type=idle row  → standby (**explicit** idle marker; data.outcome ∈ succeeded | interrupted)
 *   nothing matches / too old → standby
 *
 * **There is no "awaiting permission"**: OpenCode's tool states measured are only completed / error /
 * running, and authorization is a separate `permission.asked` event that only lives in the in-memory event
 * stream. The polling path cannot produce "awaiting permission" —— that phase is filled in by the plugin
 * (see the file header). Better to lack one phase than to pass tool+running off as "awaiting permission".
 *
 * **Only "fresh" evidence counts**: once a round ends, its last message keeps lying in the DB, and ignoring
 * freshness would display a reply finished three days ago as "speaking just now" forever. The time must fall
 * within `PHASE_FRESH_MS` (2 minutes, same order as sessions.js's FRESH_MS); beyond that it is standby.
 *
 * @param {string} sessionId
 * @returns {{phase:string,action:string,target:string,tool:string,context:string[],prompt:string,model:string,inferred:boolean}|null}
 */
const PHASE_FRESH_MS = 2 * 60_000;
/** How many messages to look back at (a round's tail holds at most a few tool→reasoning→text, 64 is very generous) */
const PHASE_LOOKBACK = 64;
/**
 * OpenCode tool names that **write files**. Measured (2.0.18): its tools are read / grep / glob / shell /
 * edit / subagent —— the one writing files is called `edit` (parameter `state.input.path`). Only these
 * count; read-type ones are not changes.
 */
const OPENCODE_WRITE_TOOL_RE = /edit|write|patch|create|apply|insert|replace/i;

function readOpencodePhase(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  // The user's sentence on the "thinking" screen: OpenCode keeps the original text in the user message's
  // data.text (**not** in content[], which only holds the assistant's reasoning/text/tool). It used to
  // always return an empty string, so the main console showed only "thinking" and not one word
  // (measured 2026-09-28).
  const prompt = lastUserText(id);
  const out = (r) => (r && !r.prompt ? { ...r, prompt } : r);
  const rows = query((db) =>
    db
      .prepare(
        `SELECT type, time_created, data FROM session_message
          WHERE session_id = ?
          ORDER BY seq DESC LIMIT ?`
      )
      .all(id, PHASE_LOOKBACK)
  );
  if (!Array.isArray(rows) || !rows.length) return null;

  const now = Date.now();
  for (const row of rows) {
    // **Explicit idle marker**: OpenCode writes a type='idle' row at the end of every round
    // (data = {time, outcome}).
    // It is more direct than "guessing from parts": with it, it is standby, no need to look at older rows.
    if (String(row.type || '') === 'idle') {
      const at = idleAt(row);
      if (at && now - at > PHASE_FRESH_MS) break;
      return out(idle());
    }
    // A round just started: the newest row is a **user** message (the assistant row has not been written
    // yet), or the assistant row has no content written yet —— both mean "the model is thinking", not
    // standby. Measured 2026-09-28: without this, the dozen seconds after the user sends a message show
    // "standby" on the main console and "thinking" is never seen for the whole round (the sampling window
    // only ever catches tool → idle alternating).
    // Note the scan goes new → old: a really finished round hits the newer idle row first and never gets here.
    if (String(row.type || '') === 'user') return out(thinking());

    let data = {};
    try {
      data = JSON.parse(String(row.data || ''));
    } catch {
      data = {}; // half-written / not JSON: skip this one, do not guess
    }
    if (!data || typeof data !== 'object') continue;

    // This message's time: prefer completed (finished speaking), then streamed (streaming), then created.
    // A row whose tool is still running only has created/streamed, no completed —— do not treat a missing
    // completed as stale.
    const tm = data.time && typeof data.time === 'object' ? data.time : {};
    const at = Number(tm.completed) || Number(tm.streamed) || Number(tm.created) || Number(row.time_created) || 0;
    // New to old: the first expired one means this round finished long ago (older ones matter even less)
    if (at && now - at > PHASE_FRESH_MS) break;

    const parts = Array.isArray(data.content) ? data.content : [];
    // Whether this assistant message **finished writing** (only counts when time.completed is stamped).
    // It decides what a text part means, see the text branch below.
    const completed = Boolean(tm.completed);
    const finish = String(data.finish || '');
    // Look back for the first part carrying a signal (when one message holds both reasoning and tool, the
    // later one is "what is being done now")
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = parts[i];
      if (!part || typeof part !== 'object') continue;
      const type = String(part.type || '');
      if (type === 'text') {
        // Not finished writing yet (no completed) = it is emitting text → **thinking**, not standby.
        // Measured 2026-09-28: treating a streaming text as standby leaves the main console parked on
        // "task finished" and "thinking" is never seen for the whole round (this round's parts are
        // [reasoning, text], and scanning backwards hits text first).
        // Same trap as 7F's (see readKiloPhase in kilo.js).
        if (!completed) return out(thinking());
        // Finished writing but more tools follow (finish=tool-calls) → this one does not close the round,
        // keep looking at earlier parts / rows
        if (finish === 'tool-calls') continue;
        return out(idle());
      }
      if (type === 'reasoning') return out(thinking());
      if (type !== 'tool') continue;

      // OpenCode's tool block: the tool name is in part.name (not Kilo's part.tool), parameters in state.input
      const tool = String(part.name || '');
      const status = String((part.state && part.state.status) || '');
      const input = part.state && part.state.input && typeof part.state.input === 'object' ? part.state.input : {};
      /**
       * Whether this counts as "using a tool right now":
       *   · status=running          → no doubt (the tool is still running)
       *   · status=completed and this step's finish=tool-calls → **also counts**
       *     OpenCode is one assistant message per step: the model closes this step with "want to call a
       *     tool" (finish=tool-calls), then runs the tool and opens the next step. And the tool block is
       *     often already finished by the time it lands on disk (`read` takes milliseconds), so
       *     recognizing only running means "calling a tool" is almost never visible (measured 2026-09-28:
       *     one round with 10 tool calls, 1.5s sampling caught only 1 frame). "This step closed by calling
       *     a tool, next step has not appeared" = it is using a tool.
       */
      const stepCallsTool = finish === 'tool-calls' && status !== 'error';
      if (status === 'running' || (status === 'completed' && stepCallsTool)) {
        return out({
          phase: 'tool',
          action: commandOf(input) || `调用 ${tool || '工具'}`,
          target: fileOf(input),
          tool,
          context: tool ? [`工具：${tool}`] : [],
          prompt: '',
          model: '',
          inferred: true,
        });
      }
      if (status === 'error') {
        return out({
          phase: 'tool',
          action: tool ? `调用 ${tool} 报错` : '调用工具报错',
          target: fileOf(input),
          tool,
          context: ['上一支工具执行失败'],
          prompt: '',
          model: '',
          inferred: true,
        });
      }
      // completed: this one finished, look at earlier parts in the same message (there may be another tool)
    }

    // Nothing in this message's parts matched → see whether it "finished speaking" (finish=stop is a normal
    // close)
    if (finish && finish !== 'tool-calls') return out(idle());
  }
  return out(idle());
}

/** The polling-derived "standby" (one exit point, so future copy changes touch only one place) */
function idle() {
  return { phase: 'idle', action: '', target: '', tool: '', context: [], prompt: '', model: '', inferred: true };
}

/** The polling-derived "thinking" */
function thinking() {
  return { phase: 'thinking', action: '', target: '', tool: '', context: [], prompt: '', model: '', inferred: true };
}

/** The time of the type='idle' row (data.time.created) */
function idleAt(row) {
  try {
    const d = JSON.parse(String(row.data || ''));
    return Number(d && d.time && d.time.created) || Number(row.time_created) || 0;
  } catch {
    return Number(row.time_created) || 0;
  }
}

/**
 * This session's **last user message's original text** (`type='user'`'s `data.text`).
 * Returns an empty string when it cannot be had —— better an empty screen than substituting the session
 * title.
 * @param {string} sessionId
 */
function lastUserText(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const row = query((db) =>
    db
      .prepare(`SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq DESC LIMIT 1`)
      .get(id)
  );
  if (!row) return '';
  try {
    const d = JSON.parse(String(row.data || ''));
    return String((d && d.text) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  } catch {
    return '';
  }
}

/**
 * This session's **per-round** task list (8F's ledger records "one per round").
 *
 * OpenCode's `session_message` is a sequential message stream: one round = one `type='user'` (data.text is
 * the user's original words, time.created is when the round started) → several `type='assistant'`
 * (time.completed is when it finished speaking, content[].state.input.path holds the files it edited) →
 * one `type='idle'` (this round explicitly finished). So:
 *   · an idle row exists = finished (endedAt = that round's last activity moment)
 *   · no idle, but the last activity is beyond PHASE_FRESH_MS = also finished (avoids "running forever")
 *   · otherwise = still in flight (endedAt = null) —— same criterion as the other floors, running is
 *     written by the ledger synchronizer
 *
 * `read_file`/`grep`/`glob`/`shell` **do not count as changing files**, only write tools do (on OpenCode
 * that is measured to be called `edit`).
 *
 * @param {string} sessionId
 * `outcome`: how this round ended —— OpenCode's idle row writes `succeeded` / `interrupted`;
 * a round with no idle row that is already stale is judged by the last assistant's `finish` (`stop` = a
 * normal close, anything else = interrupted/abandoned). The ledger distinguishes "finished" from
 * "cancelled" by this —— measured 2026-09-28: the user terminated a round (idle.outcome = interrupted) yet
 * the ledger reported "finished".
 *
 * `result`: this round's **wrap-up self-report** (the text in this round's last assistant message,
 * whitespace-collapsed and truncated) —— that is what the "output summary" in task records uses (same
 * criterion as the hook path, capped at 4000).
 *
 * @returns {Array<{index:number, prompt:string, startedAt:number, endedAt:number|null,
 *                  outcome:string, files:string[], result:string}>}
 */
/** Only non-negative numbers count (same criterion as num in reporter/src/usage.js: a missing field means none, do not substitute something else) */
function posNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Does this total really hold numbers —— all four being 0 means "nothing read", not "consumption was zero" (see the return at the call site) */
function hasTokens(t) {
  return Boolean(t) && t.input + t.output + t.cacheRead + t.cacheWrite > 0;
}

/**
 * Fold one assistant message's `data.tokens` into this round's running total.
 *
 * Shape and semantics are **the same as 7F Kilo** (`{input, output, reasoning, cache:{read,write}}`,
 * `input` excludes cache, `reasoning` is separate) —— the two share an origin, OpenCode just lacks the
 * `total` entry (measured across 314 messages, none of them have it, so it cannot self-validate here
 * either). The session table's `session_v2.tokens_*` is the sum of these messages
 * (measured 277,421 vs the message sum 277,410, a difference of 11: the last one is not merged into the
 * session counter yet).
 *
 * `reasoning` is folded into `output`, keeping the same column criterion as 7F and Claude / Codex (reasoning
 * in the function of the same name in kilo.js).
 * @param {{input:number,output:number,cacheRead:number,cacheWrite:number}} acc this round's running total (mutated in place)
 * @param {any} t one message's data.tokens (a wrong shape counts as none)
 */
function foldOpencodeTokens(acc, t) {
  if (!t || typeof t !== 'object') return acc;
  const cache = t.cache && typeof t.cache === 'object' ? t.cache : {};
  acc.input += posNum(t.input);
  acc.output += posNum(t.output) + posNum(t.reasoning);
  acc.cacheRead += posNum(cache.read);
  acc.cacheWrite += posNum(cache.write);
  return acc;
}

function readOpencodeTurns(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return [];
  const rows = query((db) =>
    db
      .prepare(`SELECT type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq ASC`)
      .all(id)
  );
  if (!Array.isArray(rows) || !rows.length) return [];

  const turns = [];
  let cur = null;
  for (const row of rows) {
    let d = {};
    try {
      d = JSON.parse(String(row.data || ''));
    } catch {
      d = {};
    }
    if (!d || typeof d !== 'object') d = {};
    const type = String(row.type || '');
    const tm = d.time && typeof d.time === 'object' ? d.time : {};
    const at = Number(tm.completed) || Number(tm.streamed) || Number(tm.created) || Number(row.time_created) || 0;

    if (type === 'user') {
      if (cur) turns.push(cur);
      cur = {
        index: turns.length,
        prompt: String(d.text || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        startedAt: Number(tm.created) || at,
        lastAt: at,
        files: new Set(),
        closed: false,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      continue;
    }
    if (!cur) continue; // a session that does not start with a user row gets no fabricated round
    // This round already finished (the idle row arrived): the assistant / synthetic rows after it are
    // **not part of it**,
    // otherwise the finish time gets pushed onto the next round's head by the following synthetic row (a
    // system reminder) (measured: a round that finished at 14:19 was computed as 17:14, conjuring 3 extra
    // hours).
    if (cur.closed) continue;
    if (at) cur.lastAt = Math.max(cur.lastAt, at);
    if (type === 'idle') {
      cur.closed = true;
      cur.outcome = String(d.outcome || 'succeeded');
      continue;
    }
    if (type === 'assistant') {
      const fin = String(d.finish || '');
      if (fin) cur.finish = fin;
      // This round's token consumption: accumulate each assistant message's data.tokens (user / idle rows
      // have no such entry)
      foldOpencodeTokens(cur.tokens, d.tokens);
      // This round's wrap-up self-report: take the text in the assistant messages (later messages
      // overwrite earlier ones,
      // so what remains is "what the last message said"). Whitespace-collapsed + capped at 4000, same
      // criterion as the hook path.
      const said = (Array.isArray(d.content) ? d.content : [])
        .filter((p) => p && p.type === 'text' && p.text)
        .map((p) => String(p.text))
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim();
      if (said) cur.result = said.slice(0, 4_000);
      for (const part of Array.isArray(d.content) ? d.content : []) {
        if (!part || typeof part !== 'object' || String(part.type || '') !== 'tool') continue;
        if (!OPENCODE_WRITE_TOOL_RE.test(String(part.name || ''))) continue;
        const input = (part.state && part.state.input) || {};
        const fp = String(input.path || input.filePath || input.file_path || '').trim();
        if (fp) cur.files.add(fp);
      }
    }
  }
  if (cur) turns.push(cur);

  const now = Date.now();
  return turns.map((t) => {
    const stale = now - t.lastAt > PHASE_FRESH_MS;
    const ended = t.closed || stale;
    // How it finished: the idle row decides; with no idle row (stale close) look at the last assistant's
    // finish
    const outcome = !ended ? 'running' : t.closed ? t.outcome || 'succeeded' : t.finish === 'stop' ? 'succeeded' : 'interrupted';
    return {
      index: t.index,
      prompt: t.prompt,
      startedAt: t.startedAt || t.lastAt,
      endedAt: ended ? t.lastAt || null : null,
      outcome,
      files: [...t.files],
      result: t.result || '',
      // Tokens consumed this round (semantics in foldOpencodeTokens). All four being 0 = nothing read →
      // null, the ledger stays empty
      tokens: hasTokens(t.tokens) ? t.tokens : null,
    };
  });
}

/** The readable command in a tool's input (OpenCode's shell tool is called `shell`, its parameter is command) */
function commandOf(input) {
  const c = String(input.command || '');
  if (c) return c.replace(/\s+/g, ' ').trim().slice(0, 120);
  const d = String(input.description || '');
  return d.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** The target file in a tool's input (measured: OpenCode's read tool uses `path`; field names are not unified across products, so all are recognized) */
function fileOf(input) {
  const p = input.file || input.filePath || input.file_path || input.path || input.target_file || '';
  return typeof p === 'string' ? p : '';
}

/* ------------------------------ Done marker ------------------------------ */

/** Freshness window of the done marker: only something that ended within this long counts as "just happened", otherwise opening the page replays the previous round */
const DONE_TTL_MS = 10 * 60_000;
/** The uniform return value when a done marker is missing (none means none, no fabrication).
 *  doneCancelled: this round was cut short by the user (ESC / stop) → the main console lights a red "task cancelled". */
const NO_DONE = { doneAt: 0, doneTitle: '', doneCount: 0, doneFiles: [], doneCancelled: false };

/**
 * This session's "done" marker —— the counterpart of the done the hook path drops on Stop.
 *
 * OpenCode has no Stop event, but `session_message` holds something equivalent: a `type='assistant'`
 * message with `finish='stop'` whose `time.completed` is stamped. Semantic mapping (consistent with the
 * OpenAI style, measured across the whole DB: finish is only ever stop / tool-calls / error):
 *   finish=stop        → finished speaking normally, **this is "task finished"**
 *   finish=tool-calls  → more tools follow, **not** finished (skip)
 *   finish=error       → ended in error, not a finish
 *   finish empty       → still streaming, not a finish
 *
 * Only ones whose `time.completed` is stamped and within DONE_TTL_MS count; one without completed (the row
 * currently streaming) explicitly does not count as finished. The title is the session title (OpenCode's
 * own), the file count is session.summary_files.
 * The **list** of changed files cannot be given on the polling path (the DB only has the summary_files
 * count) —— that item is filled in by the plugin (measured: the `data.files` of the `session.step.ended`
 * event is exactly this round's changed file path array).
 *
 * @param {string} sessionId
 * @param {{title?:string,fileCount?:number}} meta the session's own static info
 */
function readOpencodeDone(sessionId, meta = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return NO_DONE;
  const row = query((db) =>
    db
      .prepare(
        `SELECT data FROM session_message
          WHERE session_id = ? AND type = 'assistant'
            AND JSON_extract(data,'$.finish') IS NOT NULL
            AND JSON_extract(data,'$.finish') != ''
            AND JSON_extract(data,'$.finish') != 'tool-calls'
            AND JSON_extract(data,'$.finish') != 'error'
            AND JSON_extract(data,'$.time.completed') IS NOT NULL
          ORDER BY seq DESC LIMIT 1`
      )
      .get(id)
  );
  if (row) {
    let data = {};
    try {
      data = JSON.parse(String(row.data || ''));
    } catch {
      data = {};
    }
    const finish = String((data && data.finish) || '');
    if (finish === 'stop') {
      const at = Number(data && data.time && data.time.completed) || 0;
      if (at && Date.now() - at <= DONE_TTL_MS) {
        return {
          doneAt: at,
          doneTitle: String(meta.title || ''),
          doneCount: Number(meta.fileCount) || 0,
          doneFiles: [],
          doneCancelled: false,
        };
      }
    }
  }
  /**
   * An interrupted round has no `finish=stop` assistant message (OpenCode writes a `type='idle'` row at the
   * end of every round, with `data.outcome` = `succeeded` / `interrupted`) —— the path above cannot get it,
   * but the main console still needs to know "this round was cut short" to light the red "task cancelled".
   * Take the newest round from the per-round list: `interrupted` and just ended (within TTL) → drop a
   * cancel marker.
   * Same criterion as the ledger synchronizer (below in this file): never treat an interrupted round as
   * finished, and never fabricate a cancel that did not happen.
   */
  const turns = readOpencodeTurns(id);
  const last = turns[turns.length - 1];
  if (last && last.endedAt && last.outcome === 'interrupted' && Date.now() - Number(last.endedAt) <= DONE_TTL_MS) {
    return {
      doneAt: Number(last.endedAt) || 0,
      doneTitle: String(meta.title || ''),
      doneCount: Array.isArray(last.files) ? last.files.length : 0,
      doneFiles: [],
      doneCancelled: true,
      // Whatever text this round already emitted is carried along as usual (same path as "task finished"):
      // cancelling means it did not finish, not that it produced nothing
      doneSaid: String(last.result || ''),
    };
  }
  return NO_DONE;
}

/* ------------------------------ Externally exposed ------------------------------ */

/**
 * Whether this session is "connected" (it really is in the DB).
 * The render layer uses it to tell "this product is not running at all" from "running but idle right now"
 * (same as reporter-phase's instrumented).
 */
function opencodeInstrumented(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  return query((db) => {
    const table = sessionTable(db);
    if (!table) return false;
    return Boolean(db.prepare(`SELECT 1 FROM "${table}" WHERE id = ?`).get(id));
  }) === true;
}

/**
 * 8F's "reported phase" —— the same shape as reporterMainPhase,
 * for /api/v1/reporter-phase to take this path when the client is opencode.
 *
 * With no client/session parameter it takes "the most recently updated session" (aligned with the hook
 * side's old behavior of "whoever is newest under the same client"); passing a session recognizes only
 * that one.
 * @param {string} workspacePath
 * @param {string} session
 * @returns {{sessionId:string,phase:string,action:string,target:string,context:string[],tool:string,prompt:string,model:string}|null}
 */
function opencodeMainPhase(workspacePath, session = '') {
  // The phase must be bound to a session: naming no session means no phase (same criterion as reporter /
  // kilo)
  if (!session) return null;
  const list = listOpencodeSessions();
  if (!list.length) return null;
  const row = list.find((s) => s.id === session) || '';
  if (!row) return null;
  const ph = readOpencodePhase(row.id);
  if (!ph) return null;
  return {
    /** Which session this phase belongs to (the render layer uses it to confirm "is the session I am looking at this one") */
    sessionId: row.id,
    phase: ph.phase,
    action: ph.action,
    target: ph.target,
    context: ph.context,
    tool: ph.tool,
    prompt: ph.prompt,
    // The model comes from the session table (a real value; empty when it cannot be had, do not guess)
    model: row.model || '',
  };
}

/* ===================== Task synchronizer (formerly opencodeTasks.js, merged into this floor file) ===================== */
const SYNC_INTERVAL_MS = 5_000;

/**
 * The two timing parameters for "the plugin path is still alive" (same names and values as kilo.js, reasoning
 * in the constant comments there).
 *
 * PLUGIN_GRACE_MS —— do not grab the first few seconds after a round starts (the plugin's local loopback
 *   normally lands in the DB within 1 second).
 *   Short is mandatory: it measures the window where "the plugin has not written yet", and however long
 *   that window is, the user's round is missing from the list that long (measured at 60 seconds: an
 *   8-second task was invisible for the whole round).
 * PLUGIN_COVER_MS —— when judging "did the plugin report this round", the allowed difference between the
 *   plugin row's started_at and the round's start point
 *   (measured within ±90ms, direction varies; judging too strictly writes an extra twin row, too loosely
 *   treats two rounds opened within two seconds as one).
 */
const PLUGIN_GRACE_MS = 3_000;
const PLUGIN_COVER_MS = 2_000;

/** Task id prefix, to avoid id collisions with the tasks the reporter hook writes */
const TASK_ID_PREFIX = 'opencode:';
/** This floor's reporting identity = the floor base name (8F's clients are now ["opencode"], the form goes through form separately) */
const CLIENT = 'opencode';

/** This project's name (project id) —— members / the ledger are grouped by it */
function projectIdOf(s) {
  const projectPath = s.projectPath || '';
  return s.project || (projectPath ? path.basename(projectPath) : 'OpenCode');
}

/**
 * Write one ledger entry (tasks + task_runs, two rows). 8F is **one per round**.
 * @returns {string|null} this record's files_json (reused directly by current_files in the heartbeat)
 */
function writeTurnRun(repo, { id, projectId, memberId, sessionId, model, title, startedAt, endedAt, state, files, result, tokens }) {
  const st = state || (endedAt ? 'done' : 'running');
  const running = st === 'running';
  repo.insertTask.run({
    id,
    projectId,
    memberId,
    parentTaskId: null,
    title,
    state: st,
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
    // Form of the polling path = CLI/Desktop (same as opencodeHandler's `form: 'cli').
    // Leaving it null made the task detail show just "OpenCode"; it must read "OpenCode CLI".
    form: 'cli',
    model: model || null,
    title,
    startedAt,
    baselineCommit: null,
  });
  const filesJson = files && files.length ? JSON.stringify(files) : null;
  repo.endTaskRun.run({
    id,
    title,
    model: model || null,
    form: 'cli',
    // Output summary: what OpenCode last said that round (see readOpencodeTurns in opencode.js);
    // a round that has not finished writes nothing yet (half a sentence is not output), it is filled in at
    // wrap-up.
    result: result || null,
    fileCount: files ? files.length : 0,
    filesJson,
    endedAt: endedAt || null,
    durationMs: endedAt && startedAt ? endedAt - startedAt : null,
  });
  /* Tokens consumed this round (readOpencodeTurns folds them out of session_message.data.tokens, see
     opencode.js).
     Same as 7F: **overwrite** rather than COALESCE —— while this round is still running every poll
     recomputes, and the numbers grow.
     When tokens is null (nothing read) NULL is written honestly rather than carrying the previous value. */
  repo.setTaskRunTokens.run({
    id,
    inputTokens: tokens ? tokens.input : null,
    outputTokens: tokens ? tokens.output : null,
    cacheReadTokens: tokens ? tokens.cacheRead : null,
    cacheWriteTokens: tokens ? tokens.cacheWrite : null,
  });
  return filesJson;
}

/** The round sequence number in the ledger id (`opencode:<session id>:<seq>`); null when it is not this shape (same as kilo.js) */
function turnIndexOf(taskId, prefix) {
  const id = String(taskId || '');
  if (!id.startsWith(`${prefix}:`)) return null;
  const n = Number(id.slice(prefix.length + 1));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * @param {{bus: any, repo: any, now?: () => number}} ctx
 * @returns {number} how many tasks this sync wrote / changed
 */
function syncOpencodeTasks({ bus, repo, now: nowFn = Date.now }) {
  // Resolve the data source through module.exports: tests swap listOpencodeSessions / readOpencodeTurns for
  // cooked-data stubs,
  // and this synchronizer still self-checks end to end (see test/taskSync.test.js). In production it points
  // at the real functions reading OpenCode's on-disk data, behavior unchanged.
  const sessions = module.exports.listOpencodeSessions();
  if (!sessions.length) return 0;

  const now = nowFn();
  let count = 0;

  // Each session's per-round list **and** its existing ledger rows are each read once: the yield judgment,
  // owner selection and ledger writing all reuse them
  const turnsOf = new Map();
  const runsOf = new Map();
  for (const s of sessions) {
    turnsOf.set(s.id, module.exports.readOpencodeTurns(s.id));
    runsOf.set(s.id, repo.taskRunsOfSession.all(s.id || ''));
  }
  /** Whether this session counts as running right now (a round has not finished) */
  const isActiveOf = (s) => (turnsOf.get(s.id) || []).some((t) => !t.endedAt);

  /** The round start points reported by the rows the plugin wrote for this session (`k_*` sent by the
   *  server); never written → [] */
  const pluginStartsOf = (s) =>
    runsOf.get(s.id).filter((r) => !String(r.id).startsWith(TASK_ID_PREFIX)).map((r) => Number(r.started_at || 0));

  /** Whether the plugin **wrote a row for this round**: aligned by round start point (tolerating
   *  PLUGIN_COVER_MS, reasoning under the constants) */
  const coveredBy = (starts, at) => starts.some((p) => Math.abs(p - Number(at || 0)) <= PLUGIN_COVER_MS);

  /**
   * Whether this session already has **plugin-written** rows (the plugin writes server-issued `k_*`, polling
   * writes `opencode:*`) —— if so the whole session yields. The criterion is the id prefix, not the client
   * (reasoning in the function of the same name in kilo.js).
   *
   * **Yielding only holds while the plugin is still reporting** (since 2026-09-30, same criterion as
   * kilo.js): a plugin-written row only proves it **used** to report —— it lives and dies with the agent
   * process, and when the channel breaks (the server restarted with a new random token, so in the old
   * process that plugin's every report is a silent 401) neither path writes, and the rounds the user runs
   * vanish into thin air.
   * Hence the criterion is "did the plugin write **this round** too": its newest row landing after the
   * newest round's start point in the source (tolerating PLUGIN_COVER_MS) → yield; if the round just
   * started, wait PLUGIN_GRACE_MS more, and if its row still does not appear → take the session back.
   * While the plugin is alive it writes one row within a second of every round starting, so this never hits
   * normally; if it is merely slow (retrying registration) yielding continues as usual until it writes, and
   * polling's own rows get collected (self-healing).
   * The grace period counts **from this round's start point** (not "how long the plugin has been silent"):
   * the plugin writes nothing between two rounds anyway, so silence is the norm.
   */
  const yieldsOf = (s) => {
    const starts = pluginStartsOf(s);
    if (!starts.length) return false;
    const turns = turnsOf.get(s.id) || [];
    const last = turns[turns.length - 1];
    const turnStart = last ? Number(last.startedAt || 0) : 0;
    const newestTheirs = starts.reduce((m, p) => Math.max(m, p), 0);
    if (newestTheirs >= turnStart - PLUGIN_COVER_MS) return true;
    return now - turnStart <= PLUGIN_GRACE_MS;
  };

  /**
   * For a session that yielded to the plugin: is the plugin **impersonating our identity and running right
   * now**?
   * A plugin (OpenCode has no separate plugin form — it always reports cli) reports a bare `opencode`
   * —— the same member `opencode@<project>`, see resolveClient in plugin/index.js. If so, this project's
   * member status is written by the plugin first: the polling path does not even touch the heartbeat,
   * otherwise a 5s poll would overwrite the phase the plugin just wrote with the polling view's older
   * state (in agent_status, last writer wins). Hand it back to polling once finished (same as kilo.js).
   */
  const pluginOwnsMember = new Set();
  for (const s of sessions) {
    if (!yieldsOf(s) || !isActiveOf(s)) continue;
    if (runsOf.get(s.id).some((r) => String(r.client) === CLIENT)) pluginOwnsMember.add(projectIdOf(s));
  }

  /**
   * One project writes only **one** member status row (agent_status's primary key is member_id).
   * With several sessions in one project, whoever writes last wins —— which leaves "the task that is
   * running" without a heartbeat in agent_status,
   * and the task list's CASE in query.js computes it as "cancelled". So first pick which session this
   * project should report: the newest among the active ones; if none are active, report the newest one (the
   * card holds the last task) —— same as kilo.js.
   */
  const activeByProject = new Map();
  const newestByProject = new Map();
  for (const s of sessions) {
    // A yielded session does **not** take part in owner selection: this path writes no heartbeat at all,
    // and counting it in would keep another session in the same project that really is running from ever
    // being picked as owner —— that task finds no heartbeat in agent_status and gets judged "cancelled".
    if (yieldsOf(s)) continue;
    const pid = projectIdOf(s);
    const prevNew = newestByProject.get(pid);
    if (!prevNew || Number(s.lastEventAt || 0) > Number(prevNew.lastEventAt || 0)) newestByProject.set(pid, s);
    if (!isActiveOf(s)) continue;
    const prevAct = activeByProject.get(pid);
    if (!prevAct || Number(s.lastEventAt || 0) > Number(prevAct.lastEventAt || 0)) activeByProject.set(pid, s);
  }

  for (const s of sessions) {
    const projectPath = s.projectPath || '';
    const projectId = projectIdOf(s);
    const prefix = `${TASK_ID_PREFIX}${s.id}`;

    // With the plugin installed, yield (same criterion as kilo.js): the plugin path reports the truth of
    // every round, and the judgment is "does this session have plugin-written rows" (the plugin writes `k_*`
    // ids, recognized by id rather than by client ——
    // 7F's judgment of the same kind never hit when it went by client, see the notes in kilo.js).
    // But yielding only holds while the plugin is **still reporting** (yieldsOf): when the channel breaks,
    // take the session back,
    // and also collect the fallback rows polling itself grabbed earlier (only ids with our own prefix are
    // deleted; not one hair on the plugin's rows).
    const sessionRuns = runsOf.get(s.id);
    if (yieldsOf(s)) {
      for (const r of sessionRuns) if (String(r.id).startsWith(TASK_ID_PREFIX)) repo.deleteTaskRun(r.id);
      continue;
    }
    const turns = turnsOf.get(s.id) || [];
    if (!turns.length) continue;
    // A session taken back from a disconnected plugin: **the rounds the plugin reported are its own
    // business** (those rows are `k_*`),
    // only backfill the ones after it disconnected (criterion "the plugin did not report this round", same
    // as kilo.js's ②b).
    const starts = pluginStartsOf(s);

    // Make sure the project & member exist (quiet write, no broadcast)
    bus.ensureProject(projectId, projectPath, null, 'report');
    const memberId = `opencode@${projectId}`;
    const existing = repo.getMember.get(memberId);
    repo.upsertMember.run({
      id: memberId,
      projectId,
      name: 'OpenCode',
      role: 'agent',
      sessionId: s.id || null,
      reported: existing ? existing.reported : 1,
      createdAt: existing ? existing.created_at : now,
      lastSeenAt: now,
      ephemeral: 0,
      projectLabel: null,
      client: CLIENT,
    });

    let hbId = '';
    let hbFilesJson = null;
    let running = false;
    for (const t of turns) {
      if (coveredBy(starts, t.startedAt)) continue; // rounds the plugin reported are not written twice
      const id = `${prefix}:${t.index}`;
      // Changed files: only ones a write tool (edit) touched; OpenCode's input is absolute, convert
      // uniformly to project-relative
      const files = (t.files || [])
        .map((abs) => {
          const p = String(abs || '');
          if (!p || !projectPath) return p;
          const r = path.relative(projectPath, p);
          return r && !r.startsWith('..') ? r : '';
        })
        .filter(Boolean);
      const title = t.prompt || s.title || '(OpenCode 会话)';
      // How it finished: OpenCode's idle row writes succeeded / interrupted —— a round that was
      // interrupted is recorded as "cancelled", not "finished" (measured 2026-09-28: the user terminated a
      // round yet the ledger reported finished).
      const state = t.endedAt ? (t.outcome === 'interrupted' ? 'cancelled' : 'done') : 'running';
      hbFilesJson = writeTurnRun(repo, {
        id,
        projectId,
        memberId,
        sessionId: s.id || null,
        model: s.model || '',
        title,
        startedAt: t.startedAt || now,
        endedAt: t.endedAt || null,
        state,
        files,
        result: t.endedAt ? t.result || '' : '',
        tokens: t.tokens,
      });
      hbId = id;
      running = !t.endedAt;
      count += 1;
    }

    // Retire the rounds "no longer in the source" (same criterion as kilo.js's ③b): when the round table
    // shrinks (OpenCode cleared messages / compressed context), those rows never get their own round ——
    // they hang on 'running' forever,
    // get judged "cancelled" by the CASE in query.js and lie in the list as a phantom task.
    // The criterion is "is this round still in the source" (byIndex), not the array index. When turns reads
    // empty the code above already continued (no deletion here): unreadable ≠ absent from the source.
    const byIndex = new Set(turns.map((t) => t.index));
    for (const r of sessionRuns) {
      const idx = turnIndexOf(r.id, prefix);
      if (idx === null || byIndex.has(idx)) continue;
      repo.deleteTaskRun(r.id);
    }

    // Heartbeat: running = thinking, finished = idle; points at the running one (or the newest when there is
    // none).
    // **Only the session selected for this project writes it** (see activeByProject above);
    // if the plugin is reporting while impersonating our identity and that round has not finished → this
    // slot yields to it entirely (see pluginOwnsMember).
    const owner = pluginOwnsMember.has(projectId)
      ? null
      : activeByProject.get(projectId) || newestByProject.get(projectId);
    bus.setSessionStatus({
      project: projectId,
      memberId: 'opencode',
      sessionId: s.id,
      state: running ? 'busy' : 'idle',
      taskId: running ? hbId : null,
      ts: now,
    });
    if (owner === s && hbId) {
      const last = turns[turns.length - 1] || {};
      repo.upsertStatus.run({
        memberId,
        state: running ? 'busy' : 'idle',
        stateSince: running ? last.startedAt || now : now,
        taskId: hbId,
        progress: null,
        currentFiles: hbFilesJson,
        lastHeartbeatAt: now,
        degraded: 0,
        source: 'report',
        updatedAt: now,
      });
    }
  }

  return count;
}

/**
 * The opencode source branch (8F): poll OpenCode's own SQLite (session_message in opencode.db).
 * The whole opencode branch from the old sessionRegistry.js moved here, so debugging 8F no longer touches a
 * central file.
 * @param {object} p floor metadata
 * @param {object} src source spec (kind === 'opencode')
 * @param {object} ctx shared utilities provided by the framework
 */
function opencodeHandler(p, src, ctx) {
  const { claim, upsert, now, workspacePath, TIMEOUT_MS, readReporterDone, doneFieldsFromReporter } = ctx;
  for (const s of listOpencodeSessions()) {
    // Freshness is checked **before claiming**: this poll path and the plugin hook path describe the same
    // session id, and `claim` is first-come-first-served. Claiming a stale DB row here would block the
    // fresher hook row (the plugin keeps handwriting heartbeats while the DB's time_updated is frozen on a
    // permission prompt), dropping a live session out of the registry.
    if (now - (Number(s.lastEventAt) || 0) >= TIMEOUT_MS) continue;
    if (!claim(p.id, s.id)) continue;
    const ph = readOpencodePhase(s.id) || null;
    const doneTruth =
      readReporterDone(s.projectPath || workspacePath, 'opencode', s.id);
    upsert({
      floor: p.id,
      id: s.id,
      sessionId: s.id,
      // source = form→source (this path reads opencode.db, the CLI/Desktop form)
      source: formToSource('cli'),
      form: 'cli',
      sourceKind: 'opencode',
      project: s.project,
      projectPath: s.projectPath,
      mine: Boolean(workspacePath && s.projectPath && path.resolve(s.projectPath) === path.resolve(workspacePath)),
      current: false,
      live: true,
      phase: ph ? ph.phase : 'unreported',
      action: ph ? ph.action : '',
      target: ph ? ph.target : '',
      tool: ph ? ph.tool : '',
      context: ph ? ph.context : [],
      prompt: (ph && ph.prompt) || '',
      model: s.model || '',
      inferred: true,
      ...(doneTruth && doneTruth.at ? doneFieldsFromReporter(doneTruth) : readOpencodeDone(s.id, s)),
      lastEventAt: s.lastEventAt,
    });
  }
}

const kindHandlers = { opencode: opencodeHandler };

module.exports = {
  opencodeHome,
  meta,
  kindHandlers,
  sessionTitle,
  opencodeDbPath,
  shorten,
  hasCoreTables,
  listOpencodeSessions,
  readOpencodePhase,
  readOpencodeDone,
  readOpencodeTurns, // per-round task list (8F's ledger records "one per round", see the task synchronizer in this file)
  opencodeInstrumented,
  opencodeMainPhase,
  NO_DONE,
  // ---- 8F task synchronizer (formerly opencodeTasks.js) ----
  syncOpencodeTasks,
  // Unified poll contract: the server calls syncTasks on this floor's pollMs (floors hold no timers — see poller.js)
  syncTasks: syncOpencodeTasks,
  pollMs: SYNC_INTERVAL_MS,
  // Static subagent dirs (project / user level): read by this floor's own syncAgents
  agentDirs,
  // Register this floor's user / project subagents with the roster (see agentLevel.makeAgentSync)
  syncAgents: makeAgentSync(agentDirs, meta.agent),
};
