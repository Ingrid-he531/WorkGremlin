'use strict';

/**
 * 7F Kilo Code's data source — reads Kilo's own SQLite on-disk state; no hook involved.
 *
 * **Kilo Code has no hook subsystem** (measured on 7.8.1): `kilo --help` only offers acp / mcp / session /
 * serve / plugin and so on — no `hooks.json` config file, and no event point where a command could be
 * attached. So 7F is **structurally different** from the hook-reporting path of 1F~4F / 6F: no reporting,
 * no heartbeat, only the server **polling** its on-disk state.
 *
 * Fortunately Kilo's on-disk state is far richer than Qoder's (6F) — it is an **event-sourced SQLite**
 * (`~/.local/share/kilo/kilo.db`, WAL mode), not a jsonl of "file mtimes only":
 *
 *   session        id / project_id / directory (project path) / title / agent / model
 *                  / time_updated / summary_additions|deletions|files / cost / tokens_*
 *   event          append-only event stream, aggregate_id = session id, seq monotonically increasing,
 *                  data holds JSON: part.type ∈ tool|text|reasoning|step-start|step-finish|patch,
 *                  part.tool, part.state.status ∈ running|pending|completed|error, part.time.start|end
 *   message        role ∈ user|assistant, data JSON carries path.cwd (project path),
 *                  time.created|completed, finish ∈ stop|tool-calls|length|content-filter
 *   project        id / worktree (project path); project_directory additionally records worktree subdirs
 *   todo           session_id / content / status / priority / position
 *
 * So 7F's phase is **inferred truth**, not a blind guess from file times like 5F TraeCode:
 *   newest event part.type=tool and state.status=running  → calling a tool (with part.tool)
 *   newest event part.type=tool and state.status=pending  → awaiting authorization (tool not released yet)
 *   newest event part.type=tool and state.status=error    → error
 *   newest event part.type=reasoning                     → thinking
 *   newest event part.type=patch                         → calling a tool (flushing changes to disk)
 *   newest event part.type=text                           → idle (just emitted a chunk of text)
 *   step-start / step-finish / a completed tool          → **not a phase**: skip and keep looking backwards
 *
 * Why step-* is not mapped to "planning / summarizing": one measured session had step-start 363 times and
 * step-finish 361 times (against tool 2677, text 463) — basically one of each around every assistant
 * output. Those are **bookkeeping markers** for the boundary of "a step", not the agent planning or
 * wrapping up. Hard-mapping them means: every time a tool has just finished and the newest event happens
 * to be a step-finish, the console sticks on "summarizing" — which is exactly the moment "this step is
 * done, about to enter the next". If it cannot be inferred, do not infer it (see the step branch below).
 *
 * **Discipline (aligned with requirements.md §P0-6 "never fabricate")**: every phase carries
 * `inferred: true`. We **poll** its store; it does not report to us, so "what the last event looked like"
 * can only suggest "roughly what it is doing now", and a new turn may have started inside the poll
 * interval. The UI greys it out as "inferred", the same treatment as 5F / the CLI disk floors.
 *
 * Three rules on how to read:
 *   1) **Always open read-only** (readonly + fileMustExist). Kilo's daemon is writing this db; a read-only
 *      connection does not block it under WAL and cannot be corrupted by it; unreadable means "no data",
 *      never write.
 *   2) **Short timeout** (3s). If Kilo's checkpoint / migration holds it, give up at once — better to lose
 *      a phase this round than to stall the whole session table (the render layer polls every 1.5s).
 *   3) **A failed scan must never bubble.** This db is another product's private store; Kilo renaming tables
 *      is only a matter of time; unreadable → return empty and let 7F show "not connected", rather than
 *      turning /api/v1/sessions into a 500.
 *
 * Caching: session table 5s (same order as sessions.js / sessionRegistry's TTL).
 * Phase and done markers are **not cached** — the render layer pulls every 1.5s, so rather read the db once
 * more each time.
 */

const os = require('node:os');
const path = require('node:path');
const { resolveProjectName } = require('./project');
const { DEFAULTS, formToSource } = require('@workgremlin/shared');
const { openReadonly, readOne } = require('./dbReadonly');
const { isFile } = require('./roots');
// Static subagent dirs (project level / user level): private knowledge of this floor, kept here rather than
// in the central agentLevel
const { genericAgentDirs } = require('./ingest/agentLevel');

/**
 * 7F's static subagent definition dirs. Kilo Code currently has no "user-level / project-level agent
 * definition file" mechanism (its agent config lives elsewhere, not under <dot dir>/agents), so this
 * returns [] and scans nothing. If Kilo ever puts agent definitions in a directory, just name that dir
 * here (same interface as CodeBuddy / Codex / Claude).
 * @returns {Array<{dir:string, level:'project'|'user'}>}
 */
function agentDirs() {
  return [];
}

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const IS_WIN = process.platform === 'win32';

/**
 * 7F Kilo Code floor metadata (the old products.js 7F entry). CLI and IDE extension share one floor.
 */
const meta = {
  id: '7F',
  name: 'Kilo Code',
  kind: 'cli',
  cmd: 'kilo',
  agent: 'kilo',
  plugin: false,
  // Same as 3F/4F: the VS Code extension kilocode.kilo-code-* is install evidence for this floor too.
  altPluginRe: /^kilocode\./i,
  sources: [
    {
      kind: 'kilo',
      label: 'CLI/Plugin',
      client: 'kilo',
      dirs: [kiloHome()],
    },
    // The hook path: the truth path when the WorkGremlin plugin is installed (client is always the floor
    // base name kilo, form=vscode)
    { kind: 'hook', form: 'vscode' },
  ],
  hookSource: true,
  dataKind: 'kilo',
  // Kilo CLI's own install dir (fallback when PATH lookup fails)
  cliBinDirs: [path.join(HOME, '.kilo', 'bin')],
};

/** Timeout for opening a read-only connection; if Kilo holds the db, skip this round */
const OPEN_TIMEOUT_MS = 3_000;
/** Session table cache (sessions change slower than phases, 5s is enough; same order as sessionRegistry's TTL) */
const TTL = 5_000;

let cache = { at: 0, key: '', value: null };

/* ------------------------------ Locating the on-disk state ------------------------------ */

/**
 * Kilo's data root (XDG convention — Kilo uses the platform standard dir, not a hidden ~/.kilo).
 *
 * Three sources, highest priority first:
 *   1. `WORKGREMLIN_KILO_HOME` — explicit override (tests / non-standard installs / user moved the data)
 *   2. `XDG_DATA_HOME/kilo`   — the XDG standard location
 *   3. Platform default (see below)
 * `~/.kilo` is **not** the data root: measured, that dir only holds `bin/` left by the installer (often
 * empty); sessions, logs, snapshots and the SQLite all live under the data root. Treating it as the disk
 * source shows "installed but 0 sessions".
 */
function kiloHome() {
  const env = String(process.env.WORKGREMLIN_KILO_HOME || '').trim();
  if (env) return path.resolve(env);
  const xdg = String(process.env.XDG_DATA_HOME || '').trim();
  if (xdg) return path.join(path.resolve(xdg), 'kilo');
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'kilo');
  }
  if (IS_WIN) {
    return path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'kilo');
  }
  return path.join(HOME, '.local', 'share', 'kilo');
}

/** Absolute path of the event db; empty string when the file is missing (Kilo not installed / never run) */
function kiloDbPath() {
  const explicit = String(process.env.WORKGREMLIN_KILO_DB || '').trim();
  const p = explicit ? path.resolve(explicit) : path.join(kiloHome(), 'kilo.db');
  return isFile(p) ? p : '';
}

/**
 * Session title (7F Kilo Code): SQLite session.title.
 * Moved here from the old sessionTitle.js's kiloTitleOf — debugging 7F titles no longer touches a central file.
 * @param {string|null|undefined} sessionId
 * @returns {string}
 */
function sessionTitle(sessionId) {
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

/** Shorten an absolute path to start with ~ (easier to read in the UI) */
function shorten(p) {
  if (!p) return '';
  if (HOME && p.startsWith(HOME)) return `~${p.slice(HOME.length)}`;
  return p;
}

/* ------------------------------ Read-only connection ------------------------------ */

/**
 * Open a **read-only** connection; anything that fails (Kilo never ran / db locked / schema changed)
 * returns null.
 *
 * Read-only is a hard requirement, not a convenience: Kilo's daemon is writing this db, and a monitoring
 * side must never lock it nor corrupt it. Under WAL a read-only connection does not block the writer; both
 * can coexist.
 */
function openDb() {
  const file = kiloDbPath();
  if (!file) return null;
  let Database;
  try {
    // better-sqlite3 is an existing server dependency (see server/src/db/index.js); use the workspace copy
    // rather than compiling another native module inside the adapter.
    Database = require('better-sqlite3');
  } catch {
    return null; // Native module not built: 7F cannot read, the other floors carry on
  }
  try {
    return new Database(file, { readonly: true, fileMustExist: true, timeout: OPEN_TIMEOUT_MS });
  } catch {
    return null;
  }
}

/**
 * Run one query on a read-only connection; a missing table / bad SQL (Kilo renamed tables) returns null.
 * @param {(db: any) => any} fn
 * @returns {any|null}
 */
function query(fn) {
  const db = openDb();
  if (!db) return null;
  try {
    return fn(db);
  } catch {
    return null; // Unreadable means "no data"; never bubble (see file-header rule 3)
  } finally {
    try {
      db.close();
    } catch {
      /* Failing to close is fine, the result is already in hand */
    }
  }
}

/**
 * Whether these tables actually exist in the db — used to give the frontend one line saying
 * "this path cannot read sessions" */
function hasCoreTables() {
  return query((db) => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session','event','message')")
      .all()
      .map((r) => r.name);
    return names.length === 3;
  }) === true;
}

/**
 * Unwrapping part.text: measured, Kilo stores the value with an extra layer of JSON quoting (`'"…"'`);
 * strip one JSON layer, and fall back to the raw text when that fails.
 *
 * Whitespace collapsing and truncation are left to the caller — limits differ (80 chars for the on-screen
 * line, 4000 for the ledger's closing summary).
 * @param {string} raw
 * @returns {string}
 */
function unquoteText(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const un = JSON.parse(s);
    if (typeof un === 'string') return un.trim();
  } catch {
    /* Not JSON-wrapped → use as is */
  }
  return s;
}

/**
 * What **the user said** this turn (the line on the main console's "thinking" screen).
 *
 * How: the event's text part with role=user, newest first by seq — the user's exact words sit in
 * `part.text` (measured value carries an extra JSON quote layer, strip it). This is the same signal as the
 * plugin path (the role==='user' branch in plugin/index.js), just read from the db instead of received from
 * the event stream.
 *
 * Why the polling path needs it too: `readKiloPhase` used to hardcode `prompt: ''` in every branch, so 7F's
 * "thinking" screen showed **nothing at all**. Other floors are non-empty because their hook writes the
 * user's words into the state file as `taskTitle` and the server's `readReporterPhase` reads it back as
 * prompt (see winPrompt in sessions.js). With no plugin installed, 7F has no state file, so it must read
 * from the db itself — and what it reads is the user's own words, not an invention.
 *
 * Unavailable (missing table / no user message / broken JSON) → empty string: better a blank screen than
 * substituting the session title.
 * @param {string} sessionId
 * @returns {string}
 */
function readRoundPrompt(sessionId) {
  const rows = query((db) =>
    db
      .prepare(
        `SELECT e.data AS data
           FROM event e
           JOIN message m ON m.id = JSON_extract(e.data,'$.part.messageID')
                              AND m.session_id = e.aggregate_id
          WHERE e.aggregate_id = ?
            AND JSON_extract(e.data,'$.part.type') = 'text'
            AND JSON_extract(m.data,'$.role') = 'user'
          ORDER BY e.seq DESC LIMIT 1`
      )
      .all(String(sessionId))
  );
  if (!Array.isArray(rows) || !rows.length) return '';
  try {
    const d = JSON.parse(String(rows[0].data || ''));
    const said = unquoteText((d && d.part && d.part.text) || '');
    if (!said) return '';
    return said.replace(/\s+/g, ' ').trim().slice(0, 80);
  } catch {
    return '';
  }
}

/* ------------------------------ Per-turn listing (for 7F's ledger) ------------------------------ */

/**
 * The window after which a turn "counts as finished".
 *
 * **Do not confuse it with `PHASE_FRESH_MS` (2 minutes)**: that governs "what phase to show on screen now",
 * this governs "is this turn over". Measured, one turn of this session had a **780-second** generation gap
 * (a slow free model: one assistant message ran 06:17:37 → 06:30:37), so using 2 minutes as the finish
 * window would judge a running turn as "dropped before finishing".
 * A short window flips state (running ↔ cancelled), a long one keeps interrupted turns hanging a bit
 * longer — 10 minutes it is.
 */
const ROUND_IDLE_MS = 10 * 60_000;

/** part.data.files is a JSON array (Kilo's own record of changed files, absolute paths measured);
 *  a wrong shape counts as none */
function filesOf(raw) {
  if (!raw) return [];
  let arr = null;
  try {
    arr = JSON.parse(String(raw));
  } catch {
    return []; // Truncated / not JSON: do not guess
  }
  if (typeof arr === 'string') arr = [arr];
  if (!Array.isArray(arr)) return [];
  return arr.map((f) => String(f || '').trim()).filter(Boolean);
}

/**
 * The per-turn list of user tasks for this session (7F's ledger books "one row per turn"; same rule as 8F's
 * `readOpencodeTurns`).
 *
 * Turn boundary: a `role='user'` message in the `message` table starts a turn; `startedAt` is its
 * `time_created` — that value is **immutable**, so 7F does not need 9F Copilot's patch ("the start got pinned
 * by insertTask's COALESCE, so delete and rebuild the row").
 *
 * Turn close: reuse `turnIsOver` (the same rule `readKiloDone` uses to judge completion and the plugin uses
 * to judge closing). A terminal finish maps by finish (stop → done, length / content-filter → cancelled);
 * a turn with **no terminal state that is not the last one** is booked as cancelled — either the user hit
 * ESC (only the plugin path can write a cancel marker, see NO_DONE) or the process is gone; both are
 * "did not finish".
 *
 * Note that **`session_message` is empty in Kilo** (measured 0 rows) — 8F OpenCode reads turns from that
 * table, 7F can only assemble them from `message` + `part`; do not copy blindly.
 *
 * Unreadable (db missing / tables renamed / broken JSON) → empty array; never bubble (file-header rule 3).
 * A missing `message` table means there truly are no turns; a missing `part` table only empties prompt /
 * files / result while the turns remain.
 * @param {string} sessionId
 * @returns {Array<{index:number, prompt:string, startedAt:number, endedAt:number|null,
 *   outcome:'running'|'done'|'cancelled', files:string[], result:string}>}
 */
/**
 * Fold one assistant message's `data.tokens` into this turn's running total.
 *
 * That field's shape in the db is `{total, input, output, reasoning, cache:{read,write}}`, with **the same
 * semantics as Claude** (`input` excludes cache, `reasoning` is separate): across the whole db,
 * `input+output+reasoning+read+write == total` (exact in 589 of 590 rows, one off by 26 — Kilo wrote that,
 * not us).
 *
 * Only one folding choice: **reasoning goes into output**. The counterpart on the other side of the
 * reconciliation, Claude's `output_tokens`, already includes thinking (`output_tokens_details.thinking_tokens`
 * is its breakdown), and Codex's `output_tokens` likewise (`reasoning_output_tokens` is inside it). Keeping it
 * separate would silently shorten that one column on 7F/8F.
 * @param {{input:number,output:number,cacheRead:number,cacheWrite:number}} acc this turn's total (mutated in place)
 * @param {any} t one message's data.tokens (a wrong shape counts as none)
 */
function foldKiloTokens(acc, t) {
  if (!t || typeof t !== 'object') return acc;
  const cache = t.cache && typeof t.cache === 'object' ? t.cache : {};
  acc.input += posNum(t.input);
  acc.output += posNum(t.output) + posNum(t.reasoning);
  acc.cacheRead += posNum(cache.read);
  acc.cacheWrite += posNum(cache.write);
  return acc;
}

/** Only non-negative numbers count (same rule as num in reporter/src/usage.js: a missing field means none,
 *  never substitute something else) */
function posNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Does this total hold real numbers — all four zero means "not read", not "consumed nothing"
 *  (see the return at the call site) */
function hasTokens(t) {
  return Boolean(t) && t.input + t.output + t.cacheRead + t.cacheWrite > 0;
}

function readKiloRounds(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return [];
  // Both statements run inside **one** query() (one read-only connection is enough; the part table has no
  // index on session_id and a full scan costs ~5ms, so do not open a second connection and scan again).
  const data = query((db) => {
    const out = { msgs: [], parts: [] };
    // Separate try/catch: without the part table turns still exist; without the message table there truly
    // are none
    try {
      out.msgs = db
        .prepare(
          `SELECT id, time_created AS createdAt, time_updated AS updatedAt, data AS data
             FROM message WHERE session_id = ? ORDER BY time_created, id`
        )
        .all(id);
    } catch {
      out.msgs = [];
    }
    try {
      // Only json_extract, never parse the whole row: a tool part's data holds several KB of tool output
      out.parts = db
        .prepare(
          `SELECT p.message_id AS messageId,
                  JSON_extract(p.data,'$.type')  AS type,
                  JSON_extract(p.data,'$.text')  AS text,
                  JSON_extract(p.data,'$.files') AS files,
                  MAX(p.time_updated,
                      COALESCE(JSON_extract(p.data,'$.time.end'), 0),
                      COALESCE(JSON_extract(p.data,'$.time.start'), 0)) AS at
             FROM part p WHERE p.session_id = ?`
        )
        .all(id);
    } catch {
      out.parts = [];
    }
    return out;
  });
  const msgs = Array.isArray(data && data.msgs) ? data.msgs : [];
  if (!msgs.length) return [];

  const partsByMsg = new Map();
  for (const p of Array.isArray(data && data.parts) ? data.parts : []) {
    const k = String(p.messageId || '');
    if (!k) continue;
    if (!partsByMsg.has(k)) partsByMsg.set(k, []);
    partsByMsg.get(k).push(p);
  }

  /** Each part's time in this turn must also fold into lastAt (when a tool finished hugs reality closer
   *  than the message's time_updated) */
  const foldAt = (round, own) => {
    for (const p of own) round.lastAt = Math.max(round.lastAt, Number(p.at) || 0);
  };

  const rounds = [];
  let cur = null;
  for (const m of msgs) {
    let md = null;
    try {
      md = JSON.parse(String(m.data || ''));
    } catch {
      md = null; // Broken JSON: this message's role/finish is unreadable, but its parts still count for time
    }
    if (!md || typeof md !== 'object') md = {};
    const own = partsByMsg.get(String(m.id)) || [];
    const at = Number(m.updatedAt) || Number(m.createdAt) || 0;

    if (String(md.role || '') === 'user') {
      // What the user said this turn: its text part (Kilo may split it into several; take the first non-empty)
      let prompt = '';
      for (const p of own) {
        if (String(p.type || '') !== 'text') continue;
        const said = unquoteText(p.text);
        if (said) {
          prompt = said.replace(/\s+/g, ' ').trim().slice(0, 80);
          break;
        }
      }
      // A user message **without a text part is not a new task** — it is Kilo's own compaction injection
      // (measured: exactly one in the whole db, right after an interrupted turn) → fold into the current
      // turn, do not start a new index. Only when no turn has started yet (it sits at the head of the
      // session) treat it as one, so those messages have somewhere to go.
      if (!prompt && cur) {
        cur.lastAt = Math.max(cur.lastAt, at);
        foldAt(cur, own);
        continue;
      }
      if (cur) rounds.push(cur);
      cur = {
        index: rounds.length,
        prompt,
        startedAt: Number(m.createdAt) || at,
        lastAt: at,
        finish: '',
        over: false,
        files: new Set(),
        result: '',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      foldAt(cur, own);
      continue;
    }

    if (!cur) continue; // A session not starting with a user message → do not invent a turn
    cur.lastAt = Math.max(cur.lastAt, at);
    foldAt(cur, own);
    // This turn's token usage: accumulate data.tokens from assistant messages (user messages lack it)
    foldKiloTokens(cur.tokens, md.tokens);
    if (turnIsOver(m.data)) cur.over = true;
    const fin = String(md.finish || '');
    if (fin) cur.finish = fin;
    for (const p of own) {
      const t = String(p.type || '');
      if (t === 'text') {
        // This turn's closing summary: later messages overwrite earlier ones, so what remains is "what the
        // last message said" (same rule as 8F:opencode.js and the plugin path)
        const said = unquoteText(p.text);
        if (said) cur.result = said.replace(/\s+/g, ' ').trim().slice(0, 4_000);
      } else if (t === 'patch') {
        // Changed files come only from patch parts — **not from tool input**: read / grep and other read-only
        // tools also carry filePath, so treating them as "changes" would count merely-read files as
        // "changed this turn"
        for (const f of filesOf(p.files)) cur.files.add(f);
      }
    }
  }
  if (cur) rounds.push(cur);

  const now = Date.now();
  return rounds.map((r, i) => {
    const next = rounds[i + 1];
    const isLast = i === rounds.length - 1;
    // "Still in flight" = it is the last turn + no terminal finish + there was movement inside the window.
    // A non-last turn is necessarily finished (a new turn has already started), so no window check.
    const running = isLast && !r.over && now - r.lastAt < ROUND_IDLE_MS;
    const outcome = running ? 'running' : r.over ? (r.finish === 'stop' ? 'done' : 'cancelled') : 'cancelled';
    // Clamp the finish moment: a streaming assistant message's time_updated may be later than the next
    // user message
    const endedAt =
      outcome === 'running'
        ? null
        : Math.max(r.startedAt, Math.min(r.lastAt || r.startedAt, next ? next.startedAt : Infinity));
    return {
      index: r.index,
      prompt: r.prompt,
      startedAt: r.startedAt,
      endedAt,
      outcome,
      files: [...r.files],
      result: r.result,
      // This turn's token usage (semantics in foldKiloTokens). All four zero = the db has no tokens for this
      // turn at all (old Kilo versions do not write it, or this turn has not completed a request yet) →
      // **null**, leaving the ledger blank instead of writing four zeros that fake "consumed nothing".
      tokens: hasTokens(r.tokens) ? r.tokens : null,
    };
  });
}

/* ------------------------------ Session listing ------------------------------ */

/** The model column in the db is a JSON string; extract the id for humans (empty when unreadable, no guessing) */
function modelIdOf(raw) {
  try {
    const j = JSON.parse(String(raw || ''));
    return String(j && (j.id || j.modelID) || '');
  } catch {
    return '';
  }
}

/**
 * All of Kilo's sessions (not archived), newest update first.
 *
 * Filter rule: `time_archived IS NULL` — archived sessions do not count as "running" (Kilo stamps this
 * after the user runs `kilo session delete`). The archive column only exists since 7.8.1; on older versions
 * the SQL errors and the whole query returns null (→ 7F shows "not connected") rather than silently
 * releasing "all sessions".
 *
 * Field mapping (→ sessionRegistry session row):
 *   id → session id (axis 2; Kilo's ses_xxx is the hook sense of session_id)
 *   directory → project path (Kilo records each session's own working dir, more accurate than
 *               project.worktree — when a worktree sub-session runs elsewhere, directory is the real one)
 *   time_updated → last activity (Kilo advances it on every message/event, more accurate than file times)
 *
 * **Council participants do not enter this table** (rows with `title = COUNCIL_SESSION_TITLE` are skipped
 * outright): in project mode a participant's cwd is the user's project, so its session lands in this db
 * carrying a real project path — unblocked, it instantly becomes an extra "session" on the office's 7F,
 * while requirements.md §15.2 states in black and white that "once a meeting ends, the office page shows no
 * trace of it". The filter's **basis is the title** (participants are spawned by us and the title is set by
 * council/agents.js); it does not modify the db and needs no knowledge of the council's state, so this
 * filter holds regardless of "whether that meeting is still running".
 *
 * @returns {Array<{id,title,directory,project,projectPath,lastEventAt,agent,model,fileCount}>}
 */
function listKiloSessions() {
  const now = Date.now();
  const file = kiloDbPath();
  // Cache is keyed by **db file path**: switching KILO_HOME / db never serves the previous location's sessions.
  // When unreadable (not installed / locked / schema changed) cache the empty list, so the 1.5s poll does not
  // hit the lock every time.
  if (cache.value && cache.key === file && now - cache.at < TTL) return cache.value;
  const rows = query((db) =>
    db
      .prepare(
        `SELECT id, title, directory, agent, model, time_updated,
                summary_files, summary_additions, summary_deletions
           FROM session
          WHERE time_archived IS NULL
            AND (title IS NULL OR title <> ?)
          ORDER BY time_updated DESC`
      )
      .all(DEFAULTS.COUNCIL_SESSION_TITLE)
  );
  const value = (Array.isArray(rows) ? rows : []).map((r) => {
    const dir = String(r.directory || '');
    return {
      id: String(r.id || ''),
      title: String(r.title || ''),
      directory: dir,
      project: dir ? resolveProjectName(dir) || path.basename(dir) : '',
      projectPath: dir,
      lastEventAt: Number(r.time_updated) || 0,
      agent: String(r.agent || ''),
      model: modelIdOf(r.model),
      fileCount: Number(r.summary_files) || 0,
      additions: Number(r.summary_additions) || 0,
      deletions: Number(r.summary_deletions) || 0,
    };
  });
  cache = { at: now, key: file, value };
  return value;
}

/* ------------------------------ Phase inference ------------------------------ */

/**
 * A session's **current phase**.
 *
 * Take the session's last few events (the `event` table has a unique index on (aggregate_id, seq), so the
 * tail is cheap), walk backwards to the **first one carrying a part**, and map part.type /
 * part.state.status to a phase:
 *
 *   tool + running   → calling a tool (Kilo is running it; tool name / command taken from the part)
 *   tool + pending   → awaiting authorization (the tool is queued, not released — Kilo's approval lands here)
 *   tool + error     → called a tool but it errored (show the tool name; the UI greys it as failed)
 *   reasoning        → thinking
 *   patch            → calling a tool (flushing changes to disk)
 *   text             → **depends on which message this text belongs to** (see the block below; changed twice)
 *   step-finish/step-start/text all miss → idle
 *
 * **Only "fresh" evidence counts**: after `session.turn` ends, that text event stays in the db forever;
 * without a freshness check a reply from three days ago would forever show as "just spoke". So the event time
 * must fall inside `PHASE_FRESH_MS` (2 minutes, same order as sessions.js's FRESH_MS); past that it is idle.
 * This is the inherent gap between polling and hooks: polling can only use a time window to guess whether
 * this turn is still going, so **every phase carries inferred: true** and the UI greys it as inferred.
 *
 * @param {string} sessionId
 * @returns {{phase:string,action:string,target:string,tool:string,context:string[],prompt:string,model:string,inferred:boolean}|null}
 */
const PHASE_FRESH_MS = 2 * 60_000;
/** How many events to look back (a turn's tail is at most tool→reasoning→text; 64 is very generous) */
const PHASE_LOOKBACK = 64;

function readKiloPhase(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  // What the user said this turn (the second/third layer on the "thinking" screen is exactly this).
  // One read is enough: every return branch inside readKiloPhase shares the same value.
  const prompt = readRoundPrompt(id);
  // Also pull the message this part belongs to (LEFT JOIN): deciding whether text is "this turn's closing
  // line" needs that message's finish, and querying the message table again would be a redundant round trip
  // (see the text branch below).
  const events = query((db) =>
    db
      .prepare(
        `SELECT e.data AS data, m.data AS mdata
           FROM event e
           LEFT JOIN message m ON m.id = JSON_extract(e.data,'$.part.messageID')
          WHERE e.aggregate_id = ? AND JSON_extract(e.data,'$.part.type') IS NOT NULL
          ORDER BY e.seq DESC LIMIT ?`
      )
      .all(id, PHASE_LOOKBACK)
  );
  if (!Array.isArray(events) || !events.length) return null;

  const now = Date.now();
  for (const ev of events) {
    let part = null;
    let envTime = 0;
    try {
      const d = JSON.parse(String(ev.data || ''));
      part = d && typeof d === 'object' ? d.part || null : null;
      // The envelope's `time` (**present on every row**; measured, it is a number — see below)
      envTime = Number(d && d.time) || 0;
    } catch {
      part = null; // Truncated / not JSON: skip this row, do not guess
    }
    if (!part || typeof part !== 'object') continue;

    // The event's own time. **All three sources are needed** (measured stats in the comment below):
    //   part.time.end | part.time.start — present on reasoning / completed text
    //   envelope time (number)          — **present on every row**
    // We used to read only part.time, so tool / patch / step-start / still-streaming text (part.time
    // undefined) computed at=0 and `if (at && ...)` skipped the freshness check entirely — a session that
    // finished hours ago still got a phase from "the newest row". This **hole existed all along**; it was
    // simply hidden because `text → idle` happened to cover it: polling showed such sessions as idle, which
    // "looked right". After changing to "mid-turn text → thinking", the hole surfaced: a session that
    // finished 50 minutes ago whose last row is a text without part.time would show "thinking" forever.
    // Measured stats from a real machine (the last 400 part events of a real session):
    //   text 26 / reasoning 38 / step-finish 30 have part.time;
    //   tool 270 / step-start 30 / patch 5 / streaming text 1 **do not**.
    // So the envelope time is the reliable fallback.
    const tm = part.time && typeof part.time === 'object' ? part.time : {};
    const at = Number(tm.end) || Number(tm.start) || envTime;
    if (at && now - at > PHASE_FRESH_MS) break; // Newest to oldest: the first expired one means this turn long finished

    const type = String(part.type || '');
    const tool = String(part.tool || '');
    const status = String(part.state && part.state.status || '');
    const input = part.state && part.state.input && typeof part.state.input === 'object' ? part.state.input : {};

    if (type === 'tool') {
      if (status === 'running') {
        return {
          phase: 'tool',
          action: commandOf(input) || `调用 ${tool || '工具'}`,
          target: fileOf(input),
          tool,
          context: tool ? [`工具：${tool}`] : [],
          prompt,
          model: '',
          inferred: true,
        };
      }
      if (status === 'pending') {
        return {
          phase: 'await',
          action: tool ? `申请执行 ${tool}` : '等待用户授权',
          target: fileOf(input),
          tool,
          context: ['等待用户授权后继续', tool && `工具：${tool}`].filter(Boolean),
          prompt,
          model: '',
          inferred: true,
        };
      }
      if (status === 'error') {
        return {
          phase: 'tool',
          action: tool ? `调用 ${tool} 报错` : '调用工具报错',
          target: fileOf(input),
          tool,
          context: ['上一支工具执行失败'],
          prompt,
          model: '',
          inferred: true,
        };
      }
      continue; // completed: this one finished, look at the previous event (the next tool may be coming)
    }
    if (type === 'patch') {
      const f = String(part.file || input.file || input.filePath || '');
      return {
        phase: 'tool',
        action: f ? `改 ${f}` : '落盘改动',
        target: f,
        tool: 'patch',
        context: f ? [`目标：${f}`] : [],
        prompt,
        model: '',
        inferred: true,
      };
    }
    if (type === 'reasoning') {
      return { phase: 'thinking', action: '', target: '', tool: '', context: [], prompt, model: '', inferred: true };
    }
    // step-start / step-finish are **not a phase** — skip and keep looking at older events.
    //
    // They are the boundary markers of "a step": one measured session had step-start 363 times /
    // step-finish 361 times (against tool 2677, text 463) — basically one of each around every assistant
    // output. This used to map step-start to "planning" and step-finish to "summarizing", with this result:
    // every time a tool had just finished and the newest event happened to be a step-finish, the console
    // stuck on "summarizing" (exactly the moment "this step is done, about to enter the next"). In the phase
    // vocabulary, "planning / summarizing" mean the agent is genuinely planning or genuinely wrapping up,
    // and **neither can be inferred** from these two bookkeeping markers — hard-mapping them is fabricating
    // a phase (see requirements.md §P0-6).
    //
    // What we land on after skipping is the real phase: the next row is mostly reasoning (thinking) or text
    // (idle); a completed tool also takes the `continue` above and likewise keeps looking backwards.
    if (type === 'step-start' || type === 'step-finish') {
      continue;
    }
    if (type === 'text') {
      // **text does not mean "idle"** — this changed once; the measured pitfall is recorded below.
      //
      // It used to be `text → idle` unconditionally, on the grounds that "just emitted a chunk of text =
      // this turn's output stage". But Kilo emits text **several times within one turn** (a chunk may come
      // before and after each tool call), and polling only sees "the newest part": while the model speaks
      // between two tool calls the newest part is a text, so the console flashed back to "idle" **while the
      // task was still running**, only to be pushed back to "calling a tool" seconds later by the next tool
      // event. What the user saw was "the main agent's state bouncing between idle and calling a tool".
      //
      // The test uses **the finish of the message this text belongs to** (message table, matched by
      // part.messageID):
      //   finish='stop' (and time.completed) → this turn really finished speaking → idle
      //   finish='tool-calls'                → it broke off at a tool call, **the whole turn is not over** → thinking
      //   no finish yet (still streaming)     → the whole turn is not over → thinking
      // Measured distribution (real Kilo 7.8.1 session on this machine): among assistant text parts,
      // finish=stop appeared 2 times, finish=tool-calls 14 times, still streaming 2 — the vast majority are
      // "mid-turn".
      //
      // Same rule as readKiloDone judging "done" (there too, finish!=='tool-calls' is what counts as
      // finished), and the same origin as the plugin path (plugin/index.js's message.updated branches on
      // finish too).
      if (turnIsOver(ev.mdata)) {
        return { phase: 'idle', action: '', target: '', tool: '', context: [], prompt, model: '', inferred: true };
      }
      return { phase: 'thinking', action: '', target: '', tool: '', context: [], prompt, model: '', inferred: true };
    }
  }
  return { phase: 'idle', action: '', target: '', tool: '', context: [], prompt, model: '', inferred: true };
}

/** The readable command in a tool's input (bash's command / other tools' description) */
function commandOf(input) {
  const c = String(input.command || '');
  if (c) return c.replace(/\s+/g, ' ').trim().slice(0, 120);
  const d = String(input.description || '');
  return d.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** The target file in a tool's input (write/edit/apply_patch each name it differently; accept them all) */
function fileOf(input) {
  const p = input.file || input.filePath || input.file_path || input.path || input.target_file || '';
  return typeof p === 'string' ? p : '';
}

/**
 * Whether this message "finished the whole turn" (the `mdata` column carried out by the LEFT JOIN to
 * message when reading events).
 *
 * Exactly the same rule as readKiloDone judging completion and the plugin's message.updated branch judging
 * closing: `finish` present, `time.completed` present, and `finish !== 'tool-calls'`.
 * `tool-calls` only means "this message broke off at a tool call"; the whole turn continues.
 *
 * Returns false when the message row is unavailable (LEFT JOIN missed / broken JSON) — i.e. **leans towards
 * "still thinking"**: rather show "thinking" than call a running task "idle" (that would report in-progress
 * as free).
 * @param {any} mdata the message.data column (raw JSON string)
 * @returns {boolean}
 */
function turnIsOver(mdata) {
  if (!mdata) return false;
  let m = null;
  try {
    m = JSON.parse(String(mdata));
  } catch {
    return false;
  }
  if (!m || typeof m !== 'object') return false;
  const finish = String(m.finish || '');
  if (!finish || finish === 'tool-calls') return false;
  return Boolean(m.time && m.time.completed);
}

/* ------------------------------ Done marker ------------------------------ */

/** Freshness window of the done marker: only a finish inside this window counts as "just happened",
 *  otherwise opening the page replays the previous turn */
const DONE_TTL_MS = 10 * 60_000;
/** Returned uniformly when there is no done marker (none means none, never invented).
 *  doneCancelled: this turn was cut short by the user (ESC / stop) → the main console lights up red with
 *  "task cancelled". Kilo's **polling** path cannot read "interrupted" (`message.finish` only offers
 *  stop / tool-calls / length / content-filter, no interrupted), so this is always false — no invented
 *  cancels. With the WorkGremlin plugin installed, the plugin's `session.idle` path reports the cancel
 *  marker (see packages/reporter/src/plugin). */
const NO_DONE = { doneAt: 0, doneTitle: '', doneCount: 0, doneFiles: [], doneCancelled: false };

/**
 * This session's "done" marker — the counterpart of the `done` that a Stop event leaves behind on the hook
 * side.
 *
 * Kilo has no Stop event, but the `message` table holds the equivalent: a `role='assistant'` message whose
 * `finish` is not `tool-calls` (measured values: stop / tool-calls / length / content-filter).
 * Semantic mapping (Kilo's finish follows the OpenAI style):
 *   finish=stop           → spoke to completion, **this is "task done"**
 *   finish=tool-calls     → more tool calls coming, **not** done (skip)
 *   finish=length         → truncated by the length cap (it is an end, but semantically "did not finish
 *                           speaking" — counting it as done would mislead)
 *   finish=content-filter → blocked by content filtering (same; not done)
 *   finish empty          → still streaming, not done
 *
 * Only rows whose `time.completed` landed and that are inside DONE_TTL_MS count; one without completed
 * (the row currently being output) is explicitly not done. The title comes from the session title (Kilo's
 * own), the file count from session.summary_files.
 * @param {string} sessionId
 * @param {{title?:string,fileCount?:number}} meta the session's own static info
 */
function readKiloDone(sessionId, meta = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return NO_DONE;
  const row = query((db) =>
    db
      .prepare(
        `SELECT time_updated, data FROM message
          WHERE session_id = ? AND JSON_extract(data,'$.role')='assistant'
            AND JSON_extract(data,'$.finish') IS NOT NULL
            AND JSON_extract(data,'$.finish') != 'tool-calls'
            AND JSON_extract(data,'$.finish') != ''
            AND JSON_extract(data,'$.time.completed') IS NOT NULL
          ORDER BY time_updated DESC LIMIT 1`
      )
      .get(id)
  );
  if (!row) return NO_DONE;
  let data = {};
  try {
    data = JSON.parse(String(row.data || ''));
  } catch {
    data = {};
  }
  const finish = String((data && data.finish) || '');
  // Length cap / content filter: this message ended, but "task done" should not light up → empty marker
  if (finish === 'length' || finish === 'content-filter') return NO_DONE;
  const at = Number(data && data.time && data.time.completed) || 0;
  if (!at || Date.now() - at > DONE_TTL_MS) return NO_DONE;
  return {
    doneAt: at,
    doneTitle: String(meta.title || ''),
    doneCount: Number(meta.fileCount) || 0,
    doneFiles: [],
    doneCancelled: false,
  };
}

/* ------------------------------ Public surface ------------------------------ */

/**
 * Whether this session is "connected" (it really exists in Kilo's db).
 * The render layer uses it to tell "this product is not running at all" from "running but idle right now"
 * (same as reporter-phase's instrumented).
 */
function kiloInstrumented(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  return query((db) => Boolean(db.prepare('SELECT 1 FROM session WHERE id = ?').get(id)));
}

/**
 * 7F's "reported phase" — same shape as reporterMainPhase, used by /api/v1/reporter-phase when the client
 * is kilo.
 *
 * With no client/session argument, take "the most recently updated session" (aligned with the hook side's
 * old behavior of "whoever is newest among the same client is shown"); with a session given, only that one
 * counts.
 * @param {string} workspacePath
 * @param {string} session
 * @returns {{sessionId:string,phase:string,action:string,target:string,context:string[],tool:string,prompt:string,model:string}|null}
 */
function kiloMainPhase(workspacePath, session = '') {
  // A phase must be tied to a session: without naming one there is no phase (no more falling back to
  // "the newest session in the same project" — that would make the main console show another session's
  // phase on the same floor; unified rule with the reporter path).
  if (!session) return null;
  const list = listKiloSessions();
  if (!list.length) return null;
  const row = list.find((s) => s.id === session) || '';
  if (!row) return null;
  const ph = readKiloPhase(row.id);
  if (!ph) return null;
  return {
    /** Which session this phase belongs to (the render layer uses it to confirm "the session I am looking at
     *  is this one") */
    sessionId: row.id,
    phase: ph.phase,
    action: ph.action,
    target: ph.target,
    context: ph.context,
    tool: ph.tool,
    prompt: ph.prompt,
    // Model comes from the session table (real value; empty when unreadable, no guessing)
    model: row.model || '',
  };
}

/* ===================== Task syncer (from the old kiloTasks.js, merged into this floor file) ===================== */
const SYNC_INTERVAL_MS = 5_000;

/**
 * The two timing parameters for "the plugin path is still alive" (see yieldsOf / coveredBy below).
 *
 * PLUGIN_GRACE_MS — do not grab the first few seconds of a turn: the plugin writes to the ledger as soon as
 *   it receives the user's message (local loopback, measured 30~90ms to land), so "this turn has been
 *   running a few seconds and the plugin has not written a row for it" basically means it went mute.
 *   This value **must be short**, because it measures the window in which "the plugin has not written yet",
 *   and during that window polling **does not write** — however long the window is, the user's turn stays
 *   missing from the list that long. Measured (2026-09-30 13:42): an 8-second task (13:42:44 → 13:42:52)
 *   fell entirely inside the grace period when it was 60 seconds; the user watched it run and then waited
 *   another 52 seconds before seeing the row (the report was "typed a prompt, saw no task, saw it a while
 *   after the task ended"). 3 seconds is a generous margin for local loopback while squeezing the
 *   disappearance window below one poll (5s).
 * PLUGIN_COVER_MS — how far apart the plugin row's started_at and the turn's start may be when judging
 *   "has the plugin reported this turn". Both record two ends of the same event: the plugin records when it
 *   **saw the message**, the turn table when the message **landed in the db**; measured differences are
 *   within ±90ms and go both ways (+34 / -87 / -14ms in three cases). Judging a miss writes an extra row
 *   next to the plugin's (twin rows, and it cannot heal itself); judging an overlap treats "two turns
 *   started within two seconds" as one turn.
 */
const PLUGIN_GRACE_MS = 3_000;
const PLUGIN_COVER_MS = 2_000;

/** Task id prefix, so ids never collide with tasks written by the reporter hook */
const TASK_ID_PREFIX = 'kilo:';

/** This layer's reported identity = the floor base name (7F's clients are now ["kilo"]; the form travels as form) */
const CLIENT = 'kilo';

/** This project's name (project id) — members / the ledger are grouped by it */
function projectIdOf(s) {
  const projectPath = s.projectPath || '';
  return s.project || (projectPath ? path.basename(projectPath) : 'Kilo Code');
}

/**
 * Write one ledger row (a line in both tasks and task_runs). 7F is **one row per turn**; copies the rule of
 * the same-named function in opencodeTasks.js (it accepts an explicit state and result — Kilo needs both: to
 * tell done from cancelled, and this turn's closing summary).
 * @returns {string|null} this record's files_json, reused directly by the workstation card
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
    form: null,
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
    form: null,
    // Output summary: the last thing the assistant said this turn (see readKiloRounds in kilo.js);
    // an unfinished turn writes nothing yet (half a sentence is not output), it is filled in on close.
    result: result || null,
    fileCount: files ? files.length : 0,
    filesJson,
    endedAt: endedAt || null,
    durationMs: endedAt && startedAt ? endedAt - startedAt : null,
  });
  /* This turn's token usage (readKiloRounds folds it out of message.data.tokens; semantics in kilo.js).
     This statement **overwrites** rather than COALESCEs: while the turn is running every poll recomputes it
     and the numbers grow, so COALESCE would pin the first (too small) value forever. When tokens is null,
     write NULL honestly. */
  repo.setTaskRunTokens.run({
    id,
    inputTokens: tokens ? tokens.input : null,
    outputTokens: tokens ? tokens.output : null,
    cacheReadTokens: tokens ? tokens.cacheRead : null,
    cacheWriteTokens: tokens ? tokens.cacheWrite : null,
  });
  return filesJson;
}

/** The turn index inside a ledger id (`kilo:<session id>:<index>`); null when the shape does not match */
function roundIndexOf(taskId, prefix) {
  const id = String(taskId || '');
  if (!id.startsWith(`${prefix}:`)) return null;
  const n = Number(id.slice(prefix.length + 1));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * @param {{bus: any, repo: any, now?: () => number}} ctx
 * @returns {number} how many tasks this sync wrote/changed
 */
function syncKiloTasks({ bus, repo, now: nowFn = Date.now }) {
  // Resolve the data source through module.exports: tests swap listKiloSessions / readKiloRounds for
  // in-memory stubs and this syncer still self-checks end to end (see test/taskSync.test.js). In production
  // module.exports points at the real functions reading Kilo's own disk state; behavior unchanged.
  const sessions = module.exports.listKiloSessions();
  const now = nowFn();
  const reconcileSessionStatuses = () => {
    if (typeof bus.pruneSessionStatuses !== 'function' || !repo.listMembersByClient) return;
    const liveByProject = new Map();
    for (const s of sessions) {
      const projectId = projectIdOf(s);
      if (!liveByProject.has(projectId)) liveByProject.set(projectId, []);
      if (s.id) liveByProject.get(projectId).push(s.id);
    }
    for (const member of repo.listMembersByClient.all(CLIENT)) {
      bus.pruneSessionStatuses({
        project: member.project_id,
        memberId: member.id,
        sessionIds: liveByProject.get(member.project_id) || [],
        ts: now,
      });
    }
  };
  if (!sessions.length) {
    reconcileSessionStatuses();
    return 0;
  }
  let count = 0;

  // Each session's per-turn list **and** its existing ledger rows are each read once: the yield decision,
  // owner selection and ledger writing all reuse them (the per-turn list scans message/part; do not read
  // twice).
  // "Is this floor running right now" is derived from it too (is there a turn with outcome==='running') —
  // the finish window lives only in kilo.js (ROUND_IDLE_MS); no time window is computed here.
  const roundsOf = new Map();
  const runsOf = new Map();
  for (const s of sessions) {
    roundsOf.set(s.id, module.exports.readKiloRounds(s.id));
    runsOf.set(s.id, repo.taskRunsOfSession.all(s.id || ''));
  }
  const isActiveOf = (s) => (roundsOf.get(s.id) || []).some((r) => r.outcome === 'running');

  /** The turn starts reported by the plugin's rows for this session (server-issued `k_*`); none written → [] */
  const pluginStartsOf = (s) =>
    runsOf.get(s.id).filter((r) => !String(r.id).startsWith(TASK_ID_PREFIX)).map((r) => Number(r.started_at || 0));

  /** Whether the plugin **has written a row for this turn**: align by turn start (tolerating PLUGIN_COVER_MS,
   *  see the constant) */
  const coveredBy = (starts, at) => starts.some((p) => Math.abs(p - Number(at || 0)) <= PLUGIN_COVER_MS);

  /**
   * Does this session already have **plugin-written** rows (the plugin writes server-issued `k_*`, polling
   * writes `kilo:*`) — if so, yield the whole session. The test is the id prefix, not the client, because
   * what is asked here is "did I write this row" (see the loop below).
   *
   * **Yielding only holds while the plugin is still reporting** (fixed 2026-09-30: measured, a turn
   * vanished from the list). "This session has plugin rows" only proves it **once** reported — the plugin
   * lives and dies with the agent process, and when the channel breaks it neither knows nor can send
   * anything. That measured case: the Kilo CLI process started at 11:00 (the plugin inside it predated the
   * "re-read server.json" version), WorkGremlin restarted at 11:29 with a new random token (server/src/
   * config.js generates one per start) → from then on every report from that process got a 401, and
   * **completely silently**: the state file was still written (so phase/state displayed fine) while not a
   * single ledger row arrived. So the two turns the user ran at 12:46 and 12:48 had no plugin write and
   * polling yielded the whole session → **neither task was findable** (the report was "state shows, but no
   * task visible").
   *
   * So the yield test became "did the plugin write **this turn** too": if its newest row lands after the
   * newest turn's start in the source (tolerating PLUGIN_COVER_MS) → yield; otherwise wait PLUGIN_GRACE_MS
   * from the turn's start (local loopback, normally lands within 1s), and if its row still has not appeared
   * → the channel is considered dead and the session is taken back (backfill in ②b).
   * While the plugin is alive it writes a row as soon as each turn starts, so this branch should never hit;
   * if it is merely slow (retrying registration), yielding holds again the moment it writes — the rows
   * polling wrote get retracted (see the yield branch in the loop below), self-healing.
   * The grace period is measured **from this turn's start** (not "how long the plugin has been silent"):
   * the plugin writes nothing between turns anyway, so silence is normal.
   */
  const yieldsOf = (s) => {
    const starts = pluginStartsOf(s);
    if (!starts.length) return false;
    const rounds = roundsOf.get(s.id) || [];
    const last = rounds[rounds.length - 1];
    const roundStart = last ? Number(last.startedAt || 0) : 0;
    // The comparison is "does the newest row land after this turn's start": the plugin's row may be tens of
    // milliseconds earlier than the turn start (measured -87ms) or later (it takes its own Date.now(), and
    // lags when the agent is busy) — both must be tolerated, hence minus one COVER.
    const newestTheirs = starts.reduce((m, p) => Math.max(m, p), 0);
    if (newestTheirs >= roundStart - PLUGIN_COVER_MS) return true;
    return now - roundStart <= PLUGIN_GRACE_MS;
  };

  /**
   * For a session yielded to the plugin: is the plugin **impersonating our identity and running right now**?
   * client is always the floor base name (see resolveClient in plugin/index.js): the CLI-form plugin
   * (`kilo run`, no VS Code env vars) reports the bare `kilo`, the same member `kilo@<project>` as the one
   * the VS Code extension raises; the form is told apart by `form` (cli / vscode).
   * If so, this project's member state belongs to the plugin: the polling path leaves task status to it;
   * otherwise the 5s poll could overwrite the plugin's newer view with older polling data.
   * Yield only while that turn has not finished (isActiveOf). Once the plugin's turn stops, the session
   * returns to polling.
   */
  const pluginOwnsMember = new Set();
  for (const s of sessions) {
    if (!yieldsOf(s) || !isActiveOf(s)) continue;
    if (runsOf.get(s.id).some((r) => String(r.client) === CLIENT)) pluginOwnsMember.add(projectIdOf(s));
  }

  for (const s of sessions) {
    const projectPath = s.projectPath || '';
    const projectId = projectIdOf(s);
    const prefix = `${TASK_ID_PREFIX}${s.id}`;

    // With the WorkGremlin plugin installed, the plugin path reports **truth**: one row per turn of user
    // work, carrying taskTitle (the user's sentence), form, result (closing summary) and the finish time.
    // The polling path is only the fallback for "no plugin installed" and must not fight the plugin over the
    // same session — fighting shows two rows for one session in the task list (polling's session-level +
    // the plugin's task-level), and worse, polling would overwrite the phase/member state the plugin wrote
    // back to thinking every 5s ("thinking" even after the turn finished).
    // So: a session that already has plugin rows → skip entirely; a fallback row this path wrote before the
    // plugin did → retract it (delete only our own prefix; do not touch a single hair of the plugin's rows).
    // The test is "this session already has plugin-written rows", not "is there a row with client ===
    // kilo-plugin". The plugin writes ids `k_*` while polling writes `kilo:*` — recognizing by id prefix is
    // steadier than by identity: identity is what the plugin **reports**, while what is asked here is "did
    // I write this row". It used to judge by client, but before the fix the plugin's identity was not
    // kilo-plugin at all (it resolved to kilo) → never yielded → polling and the plugin each wrote their own
    // rows and one turn appeared twice in the task list (measured 2026-09-30).
    // runsOf was read above (before this turn was written), so ③'s finalization below cannot hurt lastId
    const sessionRuns = runsOf.get(s.id);
    if (yieldsOf(s)) {
      for (const r of sessionRuns) if (String(r.id).startsWith(TASK_ID_PREFIX)) repo.deleteTaskRun(r.id);
      continue;
    }

    // ① Transitional cleanup: it used to be "one row per session" with id `kilo:<session id>` (no turn index).
    // The yield path above deletes such rows itself (they carry the `kilo:` prefix too); what reaches here
    // are sessions that did not yield, so this step must happen here — otherwise those sessions with no user
    // turns (Kilo lands one empty session right at startup) keep their old ledger row in the list forever.
    if (repo.getTaskRun.get(prefix)) repo.deleteTaskRun(prefix);

    const rounds = roundsOf.get(s.id) || [];
    if (!rounds.length) continue; // A session with no user turn (not a word spoken) is not a task; no ledger row
    // Turn index → that turn. **Use index, not the array subscript**: the index in the id is the `r.index`
    // kilo.js wrote; the two are normally equal, but asking "does the source still have this turn" by index
    // is the accurate way (see ③b below).
    const byIndex = new Map(rounds.map((r) => [r.index, r]));

    // Make sure the project & member exist (quiet write, no broadcast)
    bus.ensureProject(projectId, projectPath, null, 'report');
    const memberId = `kilo@${projectId}`;
    const existing = repo.getMember.get(memberId);
    repo.upsertMember.run({
      id: memberId,
      projectId,
      name: 'Kilo Code',
      role: 'agent',
      sessionId: s.id || null,
      reported: existing ? existing.reported : 1,
      createdAt: existing ? existing.created_at : now,
      ephemeral: 0,
      projectLabel: null,
      client: CLIENT,
    });

    // Changed files: Kilo stores absolute paths; normalize to project-relative; files outside the project
    // (`..`) do not enter this column
    const relFiles = (list) =>
      (list || [])
        .map((abs) => {
          const p = String(abs || '');
          if (!p || !projectPath) return p;
          const r = path.relative(projectPath, p);
          return r && !r.startsWith('..') ? r : '';
        })
        .filter(Boolean);

    // ② Write **only the last turn**: the one in flight (state=running, ended_at=null), or the one left
    // behind once it finishes. The title prefers **what the user said this turn** (same rule as other
    // floors: "title = the user's sentence"); only when unavailable fall back to the session title — Kilo
    // sets the session title once at the start of a turn and never changes it, so using it as the title
    // makes users think "the new task was not recorded".
    const last = rounds[rounds.length - 1];
    const lastId = `${prefix}:${last.index}`;
    writeTurnRun(repo, {
      id: lastId,
      projectId,
      memberId,
      sessionId: s.id || null,
      model: s.model || '',
      title: last.prompt || s.title || '(Kilo 会话)',
      startedAt: last.startedAt || now,
      endedAt: last.endedAt || null,
      state: last.outcome,
      files: relFiles(last.files),
      result: last.endedAt ? last.result || '' : '',
      tokens: last.tokens,
    });
    count += 1;

    // ②b When taking the session back from the plugin (its channel died — see yieldsOf), backfill the turns
    // it missed while disconnected: the test is "the plugin never reported this turn" (aligned by turn start,
    // see coveredBy) — turns it did report are never backfilled by polling (see the file header's "only the
    // current turn is recorded"); only here, because these are the turns that "should have had a row and
    // never got one".
    // Rows already written (including the last turn written just above, and the rows the plugin wrote itself)
    // are left untouched.
    const starts = pluginStartsOf(s);
    if (starts.length) {
      for (const r of rounds.slice(0, -1)) {
        if (coveredBy(starts, r.startedAt)) continue;
        const rid = `${prefix}:${r.index}`;
        if (sessionRuns.some((x) => String(x.id) === rid)) continue;
        writeTurnRun(repo, {
          id: rid,
          projectId,
          memberId,
          sessionId: s.id || null,
          model: s.model || '',
          title: r.prompt || s.title || '(Kilo 会话)',
          startedAt: r.startedAt || now,
          endedAt: r.endedAt || null,
          state: r.outcome,
          files: relFiles(r.files),
          result: r.endedAt ? r.result || '' : '',
          tokens: r.tokens,
        });
        count += 1;
      }
    }

    // ③ Finalize the previous turn: it is running on our side while a new turn has already started behind it
    // — fill that row in as done / cancelled with its real finish time and result.
    // Without this step it stays 'running' forever and query.js' CASE judges it "cancelled".
    // sessionRuns was read **before** writing the last row above, so it does not contain lastId and cannot
    // misfire.
    for (const r of sessionRuns) {
      const idx = roundIndexOf(r.id, prefix);
      if (idx === null || idx >= last.index) continue;
      const old = byIndex.get(idx);
      if (!old) continue;
      writeTurnRun(repo, {
        id: r.id,
        projectId,
        memberId,
        sessionId: s.id || null,
        model: s.model || '',
        title: old.prompt || s.title || '(Kilo 会话)',
        startedAt: old.startedAt || now,
        endedAt: old.endedAt || null,
        state: old.outcome,
        files: relFiles(old.files),
        result: old.endedAt ? old.result || '' : '',
        tokens: old.tokens,
      });
      count += 1;
    }

    // ③b Retract turns "no longer in the source": when the turn table shrinks (Kilo cleared messages /
    // compacted context), those rows never meet their turn again — they hang on 'running', get judged
    // "cancelled" by query.js' CASE, and lie in the list as a phantom task (the old "one row per session"
    // rule overwrote itself, so this did not happen until the change to one row per turn).
    // The test is **is this turn still in the source** (byIndex), not "is the index smaller than the last
    // turn" — when middle turns are deleted the indices still line up; only asking by index is accurate.
    // `rounds` reading completely empty already `continue`d above (nothing is deleted here): when a db
    // change makes it unreadable (see kiloFloor's D1 case), rather keep old rows than treat "unreadable" as
    // "not in the source" and delete history.
    for (const r of sessionRuns) {
      const idx = roundIndexOf(r.id, prefix);
      if (idx === null || byIndex.has(idx)) continue;
      repo.deleteTaskRun(r.id);
    }

  }

  reconcileSessionStatuses();
  return count;
}

/**
 * The kilo source branch (7F): polls Kilo's own event-sourced SQLite (kilo.db).
 * The whole kilo branch of the old sessionRegistry.js moved here — debugging 7F no longer touches a central file.
 * @param {object} p floor metadata
 * @param {object} src source spec (kind === 'kilo')
 * @param {object} ctx shared utilities provided by the framework
 */
function kiloHandler(p, src, ctx) {
  const { claimSession, upsert, now, workspacePath, TIMEOUT_MS, reporterMainPhase, readReporterDone, doneFieldsFromReporter } = ctx;
  for (const s of listKiloSessions()) {
    // Freshness before claiming: the separate hook source (plugin) owns the same session id, and claiming a
    // stale DB row here would shadow the fresher hook row —— see the same note in opencodeHandler.
    if (now - (Number(s.lastEventAt) || 0) >= TIMEOUT_MS) continue;
    if (!claimSession(p.id, s.id)) continue;
    const ph = readKiloPhase(s.id) || null;
    const wsOfSession = s.projectPath || workspacePath;
    const truth =
      reporterMainPhase(wsOfSession, 'kilo', s.id) ||
      null;
    const doneTruth =
      readReporterDone(wsOfSession, 'kilo', s.id);
    const donePoll = readKiloDone(s.id, s);
    upsert({
      floor: p.id,
      id: s.id,
      sessionId: s.id,
      // source = form→source (plugin / cli / ide); whether this row is the plugin form is decided by truth
      // (the plugin wrote a state file)
      source: formToSource(truth ? 'vscode' : 'cli'),
      form: truth ? 'vscode' : 'cli',
      sourceKind: 'kilo',
      project: s.project,
      projectPath: s.projectPath,
      mine: Boolean(workspacePath && s.projectPath && path.resolve(s.projectPath) === path.resolve(workspacePath)),
      current: false,
      live: true,
      phase: truth ? truth.phase : ph ? ph.phase : 'unreported',
      action: truth ? truth.action || '' : ph ? ph.action : '',
      target: truth ? truth.target || '' : ph ? ph.target : '',
      tool: truth ? truth.tool || '' : ph ? ph.tool : '',
      context: truth ? truth.context || [] : ph ? ph.context : [],
      prompt: truth ? truth.prompt || '' : ph ? ph.prompt || '' : '',
      inferred: !truth,
      ...(doneTruth && doneTruth.at ? doneFieldsFromReporter(doneTruth) : donePoll),
      lastEventAt: s.lastEventAt,
    });
  }
}

const kindHandlers = { kilo: kiloHandler };

module.exports = {
  kiloHome,
  kiloDbPath,
  shorten,
  hasCoreTables,
  listKiloSessions,
  readKiloPhase,
  readKiloDone,
  readKiloRounds, // Per-turn listing (7F's ledger books "one row per turn"; see this file's task syncer)
  readRoundPrompt, // What the user said this turn (the line on the "thinking" screen; much cheaper than readKiloRounds)
  kiloInstrumented,
  kiloMainPhase,
  NO_DONE,
  // ---- 7F task syncer (from the old kiloTasks.js) ----
  syncKiloTasks,
  // Unified poll contract: the server calls syncTasks on this floor's pollMs (floors hold no timers — see poller.js)
  syncTasks: syncKiloTasks,
  pollMs: SYNC_INTERVAL_MS,
  meta,
  kindHandlers,
  sessionTitle,
  // Static subagent dirs (project level / user level): aggregated by floors.js
  agentDirs,
};
