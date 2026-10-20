'use strict';

/**
 * 2F Cline — reads Cline 4.x's own on-disk store; no WorkGremlin hook involved.
 *
 * Cline 4.x (the VS Code extension `saoudrizwan.claude-dev` and the standalone CLI share one core)
 * resolves its data root as `$CLINE_DATA_DIR` → `$CLINE_DIR/data` → `~/.cline/data`, and keeps
 * everything there:
 *
 *   db/sessions.db                  SQLite; the `sessions` table is the session index
 *   sessions/<id>/<id>.json         session metadata (title / tokens / cost / model / checkpoint / git)
 *   sessions/<id>/<id>.messages.json
 *                                   the conversation: `{ messages: [{ role, content:[…], ts }] }`,
 *                                   where a content item is one of text | thinking | tool_use | tool_result
 *   globalState.json, settings/*    settings (not read here)
 *
 * The older VS Code layout (`globalStorage/saoudrizwan.claude-dev/tasks/<id>/api_conversation_history.json`
 * + `ui_messages.json`) is the migration-era format the bundle itself labels `LegacyStateReader`; 4.x moves
 * it into `~/.cline/data`, so only the current store is read here.
 *
 * Cline **does** have a hook system (preToolUse / postToolUse / userPromptSubmit / taskStart / taskResume /
 * taskCancel / taskComplete / preCompact / notification), but it is opt-in and WorkGremlin does not install
 * into it yet — so 2F is a **poll floor** like 7F Kilo / 8F OpenCode: every phase is inferred.
 *
 * Reading rules (same discipline as floorKilo.js):
 *   1) always open the SQLite **readonly** (Cline writes it; a monitoring side must never lock it);
 *   2) a failed scan never bubbles — unreadable means "no data", not a 500;
 *   3) every phase carries `inferred: true`.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { resolveProjectName } = require('./project');
const { formToSource, DEFAULTS } = require('@workgremlin/shared');
const { openReadonly } = require('./dbReadonly');
const { isFile } = require('./roots');
const { genericAgentDirs, makeAgentSync } = require('./ingest/agentLevel');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

/**
 * 2F Cline floor metadata. The VS Code extension (`saoudrizwan.claude-dev`) and the CLI share one store,
 * so a single source covers both forms — the `source` column (vscode / cli) tells them apart.
 */
const meta = {
  id: '2F',
  name: 'Cline',
  kind: 'cli',
  cmd: 'cline',
  agent: 'cline',
  plugin: false,
  // The VS Code extension is install evidence for this floor too.
  altPluginRe: /^saoudrizwan\.claude-dev/i,
  // On-disk detection (used by findDataPath): the install dir is `~/.cline` (data lives in `~/.cline/data`).
  matchRe: [/^\.?cline$/i, /^saoudrizwan\.claude-dev/i],
  homeDirs: [path.join(HOME, '.cline')],
  sources: [
    {
      kind: 'cline',
      label: 'CLI/Plugin',
      client: 'cline',
      dirs: [clineDataDir()],
    },
  ],
  dataKind: 'cline',
  // Cline CLI's own install dir (fallback when PATH lookup fails)
  cliBinDirs: [path.join(HOME, '.local', 'bin'), path.join(HOME, '.cline', 'bin')],
};

/** Session table cache (sessions change slower than phases; 5s matches sessionRegistry's TTL) */
const TTL = 5_000;
let cache = { at: 0, key: '', value: null };

/* ------------------------------ Locating the on-disk state ------------------------------ */

/**
 * Cline's install dir (`~/.cline`). `WORKGREMLIN_CLINE_HOME` is an explicit override for tests /
 * non-standard installs; otherwise honor `CLINE_DIR` (Cline's own variable) and fall back to `~/.cline`.
 */
function clineDir() {
  const env = String(process.env.WORKGREMLIN_CLINE_HOME || '').trim();
  if (env) return path.resolve(env);
  const dir = String(process.env.CLINE_DIR || '').trim();
  if (dir) return path.resolve(dir);
  return path.join(HOME, '.cline');
}

/**
 * Cline's data root (`~/.cline/data`). `CLINE_DATA_DIR` wins over `CLINE_DIR` — exactly the precedence
 * Cline itself uses (`dataDir = $CLINE_DATA_DIR || $CLINE_DIR/data`).
 */
function clineDataDir() {
  const env = String(process.env.CLINE_DATA_DIR || '').trim();
  if (env) return path.resolve(env);
  return path.join(clineDir(), 'data');
}

/** Absolute path of the session index db; empty string when missing (Cline not installed / never run). */
function clineDbPath() {
  const explicit = String(process.env.WORKGREMLIN_CLINE_DB || '').trim();
  const p = explicit ? path.resolve(explicit) : path.join(clineDataDir(), 'db', 'sessions.db');
  return isFile(p) ? p : '';
}

/** Directory holding one folder per session (`<data>/sessions/<id>/`). */
function clineSessionsDir() {
  const explicit = String(process.env.CLINE_SESSION_DATA_DIR || '').trim();
  return explicit ? path.resolve(explicit) : path.join(clineDataDir(), 'sessions');
}

/** Shorten an absolute path to start with ~ (easier to read in the UI) */
function shorten(p) {
  if (!p) return '';
  if (HOME && p.startsWith(HOME)) return `~${p.slice(HOME.length)}`;
  return p;
}

/* ------------------------------ Read-only connection ------------------------------ */

/**
 * Run one query on a readonly connection; a missing table / bad SQL returns null.
 * Readonly is a hard requirement: Cline's runtime is writing this db, and under WAL a readonly connection
 * does not block the writer.
 * @param {(db: any) => any} fn
 * @returns {any|null}
 */
function query(fn) {
  const db = openReadonly(clineDbPath());
  if (!db) return null;
  try {
    return fn(db);
  } catch {
    return null; // Unreadable means "no data"; never bubble
  } finally {
    try {
      db.close();
    } catch {
      /* Failing to close is fine, the result is already in hand */
    }
  }
}

/** Parse a JSON string without throwing; null on anything unreadable. */
function parseJson(raw) {
  try {
    return JSON.parse(String(raw || ''));
  } catch {
    return null;
  }
}

/** Parse a JSON file without throwing; null on anything unreadable. */
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Parse an ISO timestamp into ms; 0 when unreadable. */
function timeOf(raw) {
  const t = Date.parse(String(raw || ''));
  return Number.isFinite(t) ? t : 0;
}

/* ------------------------------ Session listing ------------------------------ */

/** Token totals out of the session metadata (Cline stores them; 0/absent → null, no invented zeros). */
function tokenOf(md) {
  const u = (md && (md.aggregateUsage || md.usage)) || {};
  const input = Number(u.inputTokens != null ? u.inputTokens : md && md.tokensIn) || 0;
  const output = Number(u.outputTokens != null ? u.outputTokens : md && md.tokensOut) || 0;
  const cacheRead = Number(u.cacheReadTokens != null ? u.cacheReadTokens : md && md.cacheReads) || 0;
  const cacheWrite = Number(u.cacheWriteTokens != null ? u.cacheWriteTokens : md && md.cacheWrites) || 0;
  if (!input && !output && !cacheRead && !cacheWrite) return null;
  return { input, output, cacheRead, cacheWrite };
}

/** The conversation file for a session row (falls back to the conventional path when the db omits it). */
function messagesPathOf(row) {
  const fromDb = String((row && row.messages_path) || '').trim();
  if (fromDb) return fromDb;
  const id = String((row && row.session_id) || '');
  return id ? path.join(clineSessionsDir(), id, `${id}.messages.json`) : '';
}

/**
 * All of Cline's top-level sessions, newest update first.
 *
 * Subagent rows (`is_subagent = 1`) are **not** listed as sessions of their own — they are an internal
 * fan-out of a parent session; only the top level appears in the dropdown.
 *
 * Field mapping (→ sessionRegistry session row):
 *   session_id    → session id (axis 2)
 *   workspace_root / cwd → project path
 *   source        → form (vscode / cli)
 *   updated_at    → last activity
 *   status / ended_at → **terminal state of the session**, the only source that says "the last turn was
 *                       cut short" (see readClineRounds): a cancelled turn leaves the conversation ending on
 *                       a user prompt with no closing assistant text, so the transcript alone cannot tell
 *                       "still working" from "user pressed stop".
 *
 * **Council participants do not enter this table** (sessions whose title contains COUNCIL_PROMPT_MARKER are
 * skipped outright): Cline has no `--no-session-persistence` (1F/4F) and no `--title` (7F/8F), and stores
 * the **prompt itself** as the session title. In workspace mode the cwd is the user's project, so an
 * unguarded participant would instantly become an extra "session" on the office's 2F, while
 * requirements.md §15.2 states "once a meeting ends, the office page shows no trace of it". The marker
 * rides on the council prompt's own opening sentence (see council/prompt.js roleBlock), so the filter needs
 * no knowledge of the council's state and holds regardless of whether the meeting is still running.
 *
 * @returns {Array<{id,parentSessionId,title,project,projectPath,model,form,status,startedAt,endedAt,lastEventAt,messagesPath,tokens}>}
 */
function sessionFromRow(r) {
  const md = parseJson(r.metadata_json) || {};
  const dir = String(r.workspace_root || r.cwd || '');
  return {
    id: String(r.session_id || ''),
    parentSessionId: String(r.parent_session_id || ''),
    isSubagent: Boolean(Number(r.is_subagent)),
    title: String(md.title || r.prompt || ''),
    prompt: String(r.prompt || ''),
    directory: dir,
    project: dir ? resolveProjectName(dir) || path.basename(dir) : '',
    projectPath: dir,
    model: String(r.model || md.modelId || ''),
    form: String(r.source || '').toLowerCase() === 'vscode' ? 'vscode' : 'cli',
    status: String(r.status || ''),
    startedAt: timeOf(r.started_at) || 0,
    endedAt: timeOf(r.ended_at) || 0,
    lastEventAt: timeOf(r.updated_at) || 0,
    messagesPath: messagesPathOf(r),
    tokens: tokenOf(md),
  };
}

function listClineSessions() {
  const now = Date.now();
  const file = clineDbPath();
  // Cache keyed by db file path: switching homes never serves the previous location's sessions.
  if (cache.value && cache.key === file && now - cache.at < TTL) return cache.value;
  const rows = query((db) =>
    db
      .prepare(
        `SELECT session_id, source, status, provider, model, cwd, workspace_root, prompt,
                started_at, updated_at, ended_at, messages_path, metadata_json, is_subagent,
                parent_session_id
           FROM sessions
          WHERE is_subagent IS NULL OR is_subagent = 0
          ORDER BY updated_at DESC`
      )
      .all()
  );
  const value = (Array.isArray(rows) ? rows : [])
    .map(sessionFromRow)
    .filter((s) => s.id)
    // Council participants: Cline stamps the prompt as the session title, and the council prompt always
    // opens with COUNCIL_PROMPT_MARKER (see the note above).
    .filter((s) => !String(s.title || '').includes(DEFAULTS.COUNCIL_PROMPT_MARKER));
  cache = { at: now, key: file, value };
  return value;
}

/** One session row by id, including subagent rows (parent lookups for ghost attribution). */
function clineSessionById(id) {
  const sid = String(id || '').trim();
  if (!sid) return null;
  const row = query((db) =>
    db
      .prepare(
        `SELECT session_id, source, status, provider, model, cwd, workspace_root, prompt,
                started_at, updated_at, ended_at, messages_path, metadata_json, is_subagent,
                parent_session_id
           FROM sessions
          WHERE session_id = ?`
      )
      .get(sid)
  );
  return row ? sessionFromRow(row) : null;
}

/**
 * Cline child sessions (`is_subagent = 1`), oldest first. They are not sessions of their own, but
 * each one is a spawned subagent, so the poll floor turns them into ghosts. Unreadable data means
 * an empty list, never an exception.
 */
function listClineSubagents() {
  const rows = query((db) =>
    db
      .prepare(
        `SELECT session_id, source, status, provider, model, cwd, workspace_root, prompt,
                started_at, updated_at, ended_at, messages_path, metadata_json, is_subagent,
                parent_session_id
           FROM sessions
          WHERE is_subagent = 1
            AND parent_session_id IS NOT NULL
            AND parent_session_id <> ''
          ORDER BY started_at ASC, updated_at ASC`
      )
      .all()
  );
  return (Array.isArray(rows) ? rows : [])
    .map(sessionFromRow)
    .filter((s) => s.id && s.parentSessionId);
}

/* ------------------------------ Message reading ------------------------------ */

const PHASE_FRESH_MS = 2 * 60_000;
const DONE_TTL_MS = 10 * 60_000;
const NO_DONE = { doneAt: 0, doneTitle: '', doneCount: 0, doneFiles: [], doneCancelled: false, doneSaid: '' };

/** Cline tool names that actually write/modify a file. Read-only tools (read_files, grep, glob, run_commands …) never count. */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'insert', 'apply_diff']);

/** File paths this assistant message actually wrote/edited, normalized to project-relative when possible. */
function toolFilePaths(m, projectPath) {
  const content = Array.isArray(m.content) ? m.content : [];
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!p) return;
    let rel = p;
    if (projectPath) {
      try { rel = path.relative(projectPath, p); } catch { /* keep absolute */ }
      if (rel.startsWith('..') || path.isAbsolute(rel)) rel = p; // outside the project: keep as-is
    }
    if (rel && !seen.has(rel)) { seen.add(rel); out.push(rel); }
  };
  for (const c of content) {
    if (!c || c.type !== 'tool_use') continue;
    if (!WRITE_TOOLS.has(String(c.name || ''))) continue;
    const input = c.input && typeof c.input === 'object' ? c.input : {};
    const arr = Array.isArray(input.files) ? input.files : [];
    for (const f of arr) add(String((f && f.path) || ''));
    for (const key of ['file_path', 'path', 'filePath', 'target_file']) add(String(input[key] || ''));
  }
  return out;
}

/** The parsed conversation for a session, or null when unreadable. */
function readConversation(session) {
  const p = (session && session.messagesPath) || '';
  if (!p || !isFile(p)) return null;
  const j = readJsonFile(p);
  return j && Array.isArray(j.messages) ? j : null;
}

/** The child's final visible reply (the ghost's close-out result). */
function lastAssistantText(convo) {
  const messages = convo && Array.isArray(convo.messages) ? convo.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const text = m.content
      .filter((c) => c && c.type === 'text')
      .map((c) => String(c.text || ''))
      .join('\n')
      .trim();
    if (text) return text.slice(0, 500);
  }
  return '';
}

/** Extract the visible text of a `<user_input …>…</user_input>` wrapper (fallback: the raw text). */
function stripUserInput(t) {
  const m = String(t || '').match(/<user_input[^>]*>([\s\S]*?)<\/user_input>/i);
  return (m ? m[1] : String(t || '')).replace(/\s+/g, ' ').trim();
}

/** The newest user prompt (what the user said this turn) inside a conversation. */
function currentPrompt(convo) {
  if (!convo) return '';
  for (let i = convo.messages.length - 1; i >= 0; i -= 1) {
    const m = convo.messages[i];
    if (!m || m.role !== 'user') continue;
    const t = (Array.isArray(m.content) ? m.content : []).find((c) => c && c.type === 'text' && /<user_input/i.test(String(c.text || '')));
    if (t) return stripUserInput(t.text).slice(0, 300);
  }
  return '';
}

/** A readable action for a `tool_use` item (command / files / path / tool name). */
function toolAction(session, tu) {
  const input = tu && tu.input && typeof tu.input === 'object' ? tu.input : {};
  const cmd = String(input.command || input.cmd || '');
  if (cmd) return cmd.replace(/\s+/g, ' ').trim().slice(0, 120);
  const files = Array.isArray(input.files) ? input.files : [];
  if (files.length) {
    const first = String((files[0] && files[0].path) || '');
    return first && files.length === 1 ? `读取 ${first}` : `读取 ${files.length} 个文件`;
  }
  const p = String(input.path || input.file_path || input.filePath || input.target_file || '');
  if (p) return `${String((tu && tu.name) || '工具')} ${p}`;
  return tu && tu.name ? `调用 ${tu.name}` : '调用工具';
}

/** The file target of a `tool_use` item (empty when the tool does not touch a named file). */
function toolTarget(tu) {
  const input = tu && tu.input && typeof tu.input === 'object' ? tu.input : {};
  const files = Array.isArray(input.files) ? input.files : [];
  if (files.length === 1) return String((files[0] && files[0].path) || '');
  return String(input.path || input.file_path || input.filePath || input.target_file || '');
}

/**
 * A session's **current phase**, inferred from the tail of its conversation.
 *
 * Cline's message stream is `assistant(content: thinking / text / tool_use…)` interleaved with
 * `user(text=<user_input…> | tool_result)`; the last content item of the last message therefore tells
 * which end of the loop the session is on:
 *   assistant + tool_use   → calling a tool (the tool name / command is carried up)
 *   assistant + thinking   → thinking
 *   assistant + text       → idle (the turn finished speaking)
 *   user + tool_result     → thinking (a tool just returned, the model is about to continue)
 *   user + text            → thinking (the prompt just landed)
 *
 * **Only fresh evidence counts**: a turn's tail stays on disk forever, so past `PHASE_FRESH_MS` the phase
 * is idle — otherwise an old reply would show as "just spoke". Polling can only use a time window, so every
 * phase carries `inferred: true`.
 *
 * @param {string} sessionId
 * @returns {{phase,action,target,tool,context,prompt,model,inferred}|null}
 */
function readClinePhase(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const s = listClineSessions().find((x) => x.id === id);
  if (!s) return null;
  const convo = readConversation(s);
  if (!convo || !convo.messages.length) return null;
  const prompt = currentPrompt(convo);
  const base = { action: '', target: '', tool: '', context: [], prompt, model: s.model || '', inferred: true };
  const last = convo.messages[convo.messages.length - 1];
  const content = Array.isArray(last.content) ? last.content : [];
  const tail = content[content.length - 1];
  const at = Number(last.ts) || 0;
  if (!tail || !at || Date.now() - at > PHASE_FRESH_MS) return { phase: 'idle', ...base };
  if (last.role === 'assistant') {
    if (tail.type === 'tool_use') {
      return { phase: 'tool', ...base, action: toolAction(s, tail), target: toolTarget(tail), tool: String(tail.name || ''), context: tail.name ? [`工具：${tail.name}`] : [] };
    }
    if (tail.type === 'thinking') return { phase: 'thinking', ...base };
    return { phase: 'idle', ...base }; // assistant text tail: the turn finished speaking
  }
  // user: tool_result (a tool just returned) or the raw prompt → the model is working on the next step
  return { phase: 'thinking', ...base };
}

/**
 * This session's "done" marker (the counterpart of the hook side's Stop event): the conversation's last
 * message is an assistant reply that **ends with text** (not a tool call) and landed inside `DONE_TTL_MS`.
 */
function readClineDone(sessionId, meta = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return NO_DONE;
  const s = listClineSessions().find((x) => x.id === id);
  if (!s) return NO_DONE;
  const convo = readConversation(s);
  if (!convo || !convo.messages.length) return NO_DONE;
  const last = convo.messages[convo.messages.length - 1];
  const content = Array.isArray(last && last.content) ? last.content : [];
  const tail = content[content.length - 1];
  const at = Number(last && last.ts) || 0;
  if (last && last.role === 'assistant' && tail && tail.type === 'text' && at && Date.now() - at <= DONE_TTL_MS) {
    return {
      doneAt: at,
      doneTitle: String(meta.title || s.title || ''),
      doneCount: 0,
      doneFiles: [],
      doneCancelled: false,
      doneSaid: String(tail.text || '').slice(0, 500),
    };
  }
  /**
   * A round cut short by the user (ESC / stop) has no closing assistant text, so the check above cannot see
   * it. Take the newest round from the per-round list: cancelled and just ended (within TTL) → drop a cancel
   * marker, so the main console lights the red "task cancelled" and still carries whatever text the round
   * emitted. Same criterion as the ledger synchronizer below: never treat a cancelled round as finished,
   * never fabricate a cancel that did not happen.
   */
  const rounds = readClineRounds(id);
  const r = rounds[rounds.length - 1];
  if (r && r.endedAt && r.outcome === 'cancelled' && Date.now() - Number(r.endedAt) <= DONE_TTL_MS) {
    return {
      doneAt: Number(r.endedAt) || 0,
      doneTitle: String(meta.title || s.title || ''),
      doneCount: 0,
      doneFiles: [],
      doneCancelled: true,
      doneSaid: String(r.result || '').slice(0, 500),
    };
  }
  return NO_DONE;
}

/** Whether this session really exists in Cline's store (tells "not running" from "running but idle"). */
function clineInstrumented(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  return query((db) => Boolean(db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(id)));
}

/**
 * 2F's reported phase, same shape as reporterMainPhase; used by /api/v1/reporter-phase when the client
 * is cline. Without a session there is no phase (no falling back to "the newest session").
 * @param {string} workspacePath
 * @param {string} session
 */
function clineMainPhase(workspacePath, session = '') {
  if (!session) return null;
  const s = listClineSessions().find((x) => x.id === session);
  if (!s) return null;
  const ph = readClinePhase(s.id);
  if (!ph) return null;
  return {
    sessionId: s.id,
    phase: ph.phase,
    action: ph.action,
    target: ph.target,
    context: ph.context,
    tool: ph.tool,
    prompt: ph.prompt,
    model: s.model || '',
  };
}

/**
 * Per-turn listing: one entry per user turn (`<user_input …>` boundary) in a session, carrying the turn's
 * prompt, start / end and outcome. The last turn gets the session's token totals (Cline only stores
 * session-level usage).
 *
 * There is deliberately no `files` here: Cline's transcript records **tool calls**, not which files they
 * changed — reading a path (`read_files`, `search_codebase`) is not an edit, so counting tool targets would
 * show files the turn never touched. The changed-file list is therefore left unknown (see writeTurnRun).
 * @returns {Array<{index,prompt,startedAt,endedAt,outcome,result,tokens}>}
 */
function readClineRounds(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return [];
  const s = listClineSessions().find((x) => x.id === id);
  if (!s) return [];
  const convo = readConversation(s);
  if (!convo) return [];
  const projectPath = s.projectPath || '';
  const rounds = [];
  let cur = null;
  /**
   * Close a turn that never produced a closing assistant text: it was **cut short** (the user pressed stop,
   * or a new prompt opened the next turn while it was still open). Its end time is the last activity it had,
   * and its outcome is `cancelled` —— never left `running`, or the ledger keeps it "running" forever.
   */
  const closeOpen = (at) => {
    if (!cur || cur.endedAt) return;
    cur.endedAt = Number(at || cur.lastAt || 0) || cur.startedAt;
    cur.outcome = 'cancelled';
  };
  for (const m of convo.messages) {
    if (!m) continue;
    const content = Array.isArray(m.content) ? m.content : [];
    const ts = Number(m.ts) || 0;
    if (m.role === 'user') {
      const promptItem = content.find((c) => c && c.type === 'text' && /<user_input/i.test(String(c.text || '')));
      if (promptItem) {
        // A new prompt while the previous turn is still open means that turn was interrupted (Cline never
        // opened a new turn until the running one stopped).
        closeOpen(ts);
        cur = { index: rounds.length, prompt: stripUserInput(promptItem.text), startedAt: ts, endedAt: 0, outcome: 'running', result: '', tokens: null, files: [], lastAt: ts };
        rounds.push(cur);
      } else if (cur) {
        cur.lastAt = Math.max(cur.lastAt || 0, ts);
      }
      continue;
    }
    if (m.role !== 'assistant' || !cur) continue;
    cur.lastAt = Math.max(cur.lastAt || 0, ts);
    // Collect files this turn actually wrote/edited; read-only tools never count as changes.
    const written = toolFilePaths(m, projectPath);
    for (const f of written) if (!cur.files.includes(f)) cur.files.push(f);
    const tail = content[content.length - 1];
    if (tail && tail.type === 'text') {
      // The turn's closing reply = the task detail's "output". A turn can emit assistant text a few times;
      // what remains is the last (the wrap-up), so later messages overwrite earlier ones. Markdown is kept
      // as-is (headings / tables / code), capped like 7F/8F's ledger summary.
      const said = content
        .filter((c) => c && c.type === 'text')
        .map((c) => String(c.text || ''))
        .join('\n')
        .trim();
      if (said) cur.result = said.slice(0, 4_000);
      cur.endedAt = ts || cur.endedAt;
      cur.outcome = 'done';
    } else {
      cur.endedAt = 0;
      cur.outcome = 'running';
    }
  }
  // The trailing turn is still open. While the session itself is running that is genuine; once Cline marks
  // the session terminal (status completed/cancelled/failed/error, or an ended_at stamp), an open turn was
  // cancelled —— the transcript ends on a user prompt with no closing assistant text.
  if (cur && !cur.endedAt && sessionTerminal(s)) closeOpen(s.endedAt || cur.lastAt);
  if (rounds.length && s.tokens) rounds[rounds.length - 1].tokens = s.tokens;
  return rounds;
}

/** Cline's own terminal session statuses (from @cline/core): the session is over, no further turn will run. */
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed', 'error']);

/** Whether Cline has marked this session terminal (an ended_at stamp, or a terminal status). */
function sessionTerminal(s) {
  if (!s) return false;
  if (Number(s.endedAt) > 0) return true;
  return TERMINAL_STATUSES.has(String(s.status || '').toLowerCase());
}

const SUBAGENT_TOOL_PREFIX = 'subagent_';

/** Normalize a prompt for matching the child row against the parent's tool-call input. */
function normTask(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

/**
 * The parent conversation's subagent tool calls, in order. Named agents use `subagent_<sanitized-name>`;
 * the generic spawn tool is `spawn_agent` and its task lives in `task`.
 */
function subagentToolCalls(convo) {
  const out = [];
  const messages = convo && Array.isArray(convo.messages) ? convo.messages : [];
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (!c || c.type !== 'tool_use') continue;
      const tool = String(c.name || '');
      let name = '';
      if (tool.startsWith(SUBAGENT_TOOL_PREFIX)) name = tool.slice(SUBAGENT_TOOL_PREFIX.length);
      else if (tool === 'spawn_agent') name = 'subagent';
      else continue;
      const input = c.input && typeof c.input === 'object' ? c.input : {};
      out.push({
        name: name || 'subagent',
        task: String(input.prompt || input.task || '').trim(),
        used: false,
      });
    }
  }
  return out;
}

/**
 * Match each child row to the parent's tool call that spawned it. The child's `agent_id` is a runtime
 * UUID, so the tool name is the only stable display name; the prompt disambiguates concurrent calls.
 */
function resolveSubagentNames(subs) {
  const names = new Map();
  const byParent = new Map();
  for (const s of subs) {
    if (!byParent.has(s.parentSessionId)) byParent.set(s.parentSessionId, []);
    byParent.get(s.parentSessionId).push(s);
  }
  for (const [parentId, children] of byParent) {
    const parent = clineSessionById(parentId);
    if (!parent) continue;
    const calls = subagentToolCalls(readConversation(parent));
    const ordered = children
      .slice()
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || String(a.id).localeCompare(String(b.id)));
    for (const child of ordered) {
      const task = normTask(child.prompt);
      let hit = calls.find((c) => !c.used && task && normTask(c.task) === task);
      // A compacted or rewritten parent transcript may no longer hold the exact prompt. Preserve the
      // spawn order fallback so the ghost still appears, with the tool call's name when available.
      if (!hit) hit = calls.find((c) => !c.used);
      if (!hit) continue;
      hit.used = true;
      names.set(child.id, hit.name);
    }
  }
  return names;
}

/**
 * Turn Cline child sessions into ghosts (2F has no hook, so the db is the only signal).
 * Active children keep their ghost alive; terminal children close it with the child's final text.
 * @param {{bus: any}} ctx
 * @returns {number} child rows considered
 */
function syncClineSubagents({ bus } = {}) {
  if (!bus || typeof bus.ghostSpawn !== 'function' || typeof bus.ghostRetire !== 'function') return 0;
  let subs = [];
  try {
    subs = module.exports.listClineSubagents();
  } catch {
    return 0;
  }
  if (!subs.length) return 0;
  const names = resolveSubagentNames(subs);
  let count = 0;
  for (const s of subs) {
    const parent = clineSessionById(s.parentSessionId);
    // Council participants must leave no trace on 2F, including their subagents.
    if (parent && String(parent.title || '').includes(DEFAULTS.COUNCIL_PROMPT_MARKER)) continue;
    const dir = s.projectPath || (parent && parent.projectPath) || '';
    const project = dir ? resolveProjectName(dir) || path.basename(dir) : 'Cline';
    const name = names.get(s.id) || 'subagent';
    if (sessionTerminal(s)) {
      bus.ghostRetire({
        project,
        client: CLIENT,
        sessionId: s.parentSessionId,
        name,
        id: s.id,
        result: lastAssistantText(readConversation(s)),
        model: s.model || '',
      });
    } else {
      bus.ghostSpawn({
        project,
        client: CLIENT,
        sessionId: s.parentSessionId,
        name,
        id: s.id,
        task: s.prompt || '',
        model: s.model || '',
        startedAt: s.startedAt || 0,
        workspacePath: s.projectPath || (parent && parent.projectPath) || '',
      });
    }
    count += 1;
  }
  return count;
}

/* ===================== Task syncer (one ledger row per turn) ===================== */
const SYNC_INTERVAL_MS = 5_000;
const TASK_ID_PREFIX = 'cline:';
const CLIENT = 'cline';

/** This project's name (project id) — members / the ledger are grouped by it. */
function projectIdOf(s) {
  const p = s.projectPath || '';
  return s.project || (p ? path.basename(p) : 'Cline');
}

/** Write one ledger row (a line in both tasks and task_runs); one row per turn. */
function writeTurnRun(repo, { id, projectId, memberId, sessionId, model, form, title, startedAt, endedAt, state, result, tokens, files }) {
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
    form: form || null,
    model: model || null,
    title,
    startedAt,
    baselineCommit: null,
  });
  const fileCount = files == null ? null : files.length;
  const filesJson = files && files.length ? JSON.stringify(files) : null;
  repo.endTaskRun.run({
    id,
    title,
    model: model || null,
    form: form || null,
    result: result || null,
    fileCount: fileCount,
    filesJson: filesJson,
    endedAt: endedAt || null,
    durationMs: endedAt && startedAt ? endedAt - startedAt : null,
  });
  // Only explicitly clear when we genuinely don't know the files (files == null). When files is []
  // (no changes) or a real list, keep what endTaskRun wrote — clearTaskRunFiles would otherwise wipe
  // it right back to NULL on every poll.
  if (files == null) repo.clearTaskRunFiles.run(id);
  repo.setTaskRunTokens.run({
    id,
    inputTokens: tokens ? tokens.input : null,
    outputTokens: tokens ? tokens.output : null,
    cacheReadTokens: tokens ? tokens.cacheRead : null,
    cacheWriteTokens: tokens ? tokens.cacheWrite : null,
  });
}

/** The turn index inside a ledger id (`cline:<session id>:<index>`); null when the shape does not match. */
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
function syncClineTasks({ bus, repo, now: nowFn = Date.now }) {
  // Resolved through module.exports so tests can swap listClineSessions / readClineRounds for stubs.
  const sessions = module.exports.listClineSessions();
  // Child rows never appear in the top-level session list. Sync them before the early return so a
  // directory containing only subagent rows (or a filtered parent) still gets its ghosts.
  module.exports.syncClineSubagents({ bus });

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
  const roundsOf = new Map();
  const runsOf = new Map();
  for (const s of sessions) {
    roundsOf.set(s.id, module.exports.readClineRounds(s.id));
    runsOf.set(s.id, repo.taskRunsOfSession.all(s.id || ''));
  }
  for (const s of sessions) {
    const projectPath = s.projectPath || '';
    const projectId = projectIdOf(s);
    const prefix = `${TASK_ID_PREFIX}${s.id}`;
    const sessionRuns = runsOf.get(s.id) || [];

    // Transitional cleanup: an older build wrote one row per session with id `cline:<session id>`.
    if (repo.getTaskRun.get(prefix)) repo.deleteTaskRun(prefix);

    const rounds = roundsOf.get(s.id) || [];
    if (!rounds.length) continue;
    bus.ensureProject(projectId, projectPath, null, 'report');
    const memberId = `cline@${projectId}`;
    const existing = repo.getMember.get(memberId);
    repo.upsertMember.run({
      id: memberId,
      projectId,
      name: 'Cline',
      role: 'agent',
      sessionId: s.id || null,
      reported: existing ? existing.reported : 1,
      createdAt: existing ? existing.created_at : now,
      ephemeral: 0,
      projectLabel: null,
      client: CLIENT,
    });

    // One ledger row per turn: the conversation carries the full history, so every user turn is written.
    // `running` records whether this session's latest turn is still running.
    for (const r of rounds) {
      const id = `${prefix}:${r.index}`;
      // The round's own outcome is authoritative: running | done | cancelled. A cancelled round has an
      // endedAt but must be written as 'cancelled', not 'done' —— otherwise the ticker lights "task
      // completed" on a stop, and the list hides that it was cut short.
      const state = r.outcome || (r.endedAt ? 'done' : 'running');
      writeTurnRun(repo, {
        id,
        projectId,
        memberId,
        sessionId: s.id || null,
        model: s.model || '',
        // The form of this session (vscode extension → plugin, CLI → cli): the task list labels the
        // client "Cline Plugin" / "Cline CLI" from it (see clientLabel in shared/index.js).
        form: s.form || '',
        title: r.prompt || s.title || '(Cline 会话)',
        startedAt: r.startedAt || now,
        endedAt: r.endedAt || null,
        state,
        result: r.endedAt ? r.result || '' : '',
        tokens: r.tokens,
        files: r.files,
      });
      count += 1;
    }

    // Retract turns no longer in the source (Cline cleared / compacted the conversation): those rows
    // never meet their turn again, hang on 'running', and get judged "cancelled" by query.js' CASE.
    const byIndex = new Set(rounds.map((r) => r.index));
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
 * The cline source branch (2F): polls Cline's own SQLite + session JSON.
 * @param {object} p floor metadata
 * @param {object} src source spec (kind === 'cline')
 * @param {object} ctx shared utilities provided by the framework
 */
function clineHandler(p, src, ctx) {
  const { claimSession, upsert, now, workspacePath, TIMEOUT_MS, reporterMainPhase, readReporterDone, doneFieldsFromReporter, table } = ctx;
  for (const s of listClineSessions()) {
    // A **terminal** session (Cline stamped ended_at, or wrote a terminal status) is over: drop its
    // registry row right away instead of keeping it for the whole 60-minute window. The dropdown lists
    // "sessions you can watch"; a finished one is no longer watchable, and the time window meant a
    // finished — or since deleted — session still showed as active. `sessionTerminal` is the same yardstick
    // the cancel detection uses (never invent a second one).
    //
    // The task ledger is untouched: syncTasks still walks listClineSessions (not this registry path) and
    // writes every round, so "task cancelled" stays visible in the task records. Only 2F has this signal;
    // 7F/8F have no terminal concept in their store and keep the time window.
    if (sessionTerminal(s)) {
      table.delete(`${p.id}:${s.id}`);
      continue;
    }
    if (!claimSession(p.id, s.id)) continue;
    if (now - (Number(s.lastEventAt) || 0) >= TIMEOUT_MS) continue;
    const ph = readClinePhase(s.id) || null;
    const wsOfSession = s.projectPath || workspacePath;
    const truth = reporterMainPhase(wsOfSession, CLIENT, s.id) || null;
    const doneTruth = readReporterDone(wsOfSession, CLIENT, s.id);
    const donePoll = readClineDone(s.id, s);
    const form = truth ? 'vscode' : s.form;
    upsert({
      floor: p.id,
      id: s.id,
      sessionId: s.id,
      source: formToSource(form),
      form,
      sourceKind: 'cline',
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

/**
 * Session title (2F Cline): the session's title from Cline's own metadata.
 * @param {string|null|undefined} sessionId
 * @returns {string}
 */
function sessionTitle(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const s = listClineSessions().find((x) => x.id === id);
  return s ? String(s.title || '') : '';
}

/**
 * 2F's static subagent definition dirs: project-level <workspacePath>/.cline/agents and user-level
 * <clineDir>/agents. Project level wins over user level.
 * @returns {Array<{dir:string, level:'project'|'user'}>}
 */
function agentDirs(workspacePath) {
  return genericAgentDirs([clineDir()], workspacePath);
}

const kindHandlers = { cline: clineHandler };

module.exports = {
  // Floor base name — lets sessions.js' resolveSessionTitle dispatch to `sessionTitle` below
  // (same as 6F Qoder; the task list's `session_title` then uses Cline's own stored title).
  client: 'cline',
  clineDir,
  clineDataDir,
  clineDbPath,
  clineSessionsDir,
  shorten,
  listClineSessions,
  listClineSubagents,
  readClinePhase,
  readClineDone,
  readClineRounds,
  syncClineSubagents,
  clineInstrumented,
  clineMainPhase,
  NO_DONE,
  // ---- 2F task syncer ----
  syncClineTasks,
  // Unified poll contract: the server calls syncTasks on this floor's pollMs (floors hold no timers).
  syncTasks: syncClineTasks,
  pollMs: SYNC_INTERVAL_MS,
  meta,
  kindHandlers,
  sessionTitle,
  agentDirs,
  syncAgents: makeAgentSync(agentDirs, meta.agent),
};
