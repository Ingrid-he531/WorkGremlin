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
const { formToSource } = require('@workgremlin/shared');
const { openReadonly } = require('./dbReadonly');
const { isFile } = require('./roots');

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
 *
 * @returns {Array<{id,title,project,projectPath,model,form,status,lastEventAt,messagesPath,tokens}>}
 */
function listClineSessions() {
  const now = Date.now();
  const file = clineDbPath();
  // Cache keyed by db file path: switching homes never serves the previous location's sessions.
  if (cache.value && cache.key === file && now - cache.at < TTL) return cache.value;
  const rows = query((db) =>
    db
      .prepare(
        `SELECT session_id, source, status, provider, model, cwd, workspace_root, prompt,
                started_at, updated_at, messages_path, metadata_json, is_subagent
           FROM sessions
          WHERE is_subagent IS NULL OR is_subagent = 0
          ORDER BY updated_at DESC`
      )
      .all()
  );
  const value = (Array.isArray(rows) ? rows : [])
    .map((r) => {
      const md = parseJson(r.metadata_json) || {};
      const dir = String(r.workspace_root || r.cwd || '');
      return {
        id: String(r.session_id || ''),
        title: String(md.title || r.prompt || ''),
        directory: dir,
        project: dir ? resolveProjectName(dir) || path.basename(dir) : '',
        projectPath: dir,
        model: String(r.model || md.modelId || ''),
        form: String(r.source || '').toLowerCase() === 'vscode' ? 'vscode' : 'cli',
        status: String(r.status || ''),
        lastEventAt: timeOf(r.updated_at) || 0,
        messagesPath: messagesPathOf(r),
        tokens: tokenOf(md),
      };
    })
    .filter((s) => s.id);
  cache = { at: now, key: file, value };
  return value;
}

/* ------------------------------ Message reading ------------------------------ */

const PHASE_FRESH_MS = 2 * 60_000;
const DONE_TTL_MS = 10 * 60_000;
const NO_DONE = { doneAt: 0, doneTitle: '', doneCount: 0, doneFiles: [], doneCancelled: false, doneSaid: '' };

/** The parsed conversation for a session, or null when unreadable. */
function readConversation(session) {
  const p = (session && session.messagesPath) || '';
  if (!p || !isFile(p)) return null;
  const j = readJsonFile(p);
  return j && Array.isArray(j.messages) ? j : null;
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
  if (!last || last.role !== 'assistant') return NO_DONE;
  const content = Array.isArray(last.content) ? last.content : [];
  const tail = content[content.length - 1];
  if (!tail || tail.type !== 'text') return NO_DONE;
  const at = Number(last.ts) || 0;
  if (!at || Date.now() - at > DONE_TTL_MS) return NO_DONE;
  return {
    doneAt: at,
    doneTitle: String(meta.title || s.title || ''),
    doneCount: 0,
    doneFiles: [],
    doneCancelled: false,
    doneSaid: String(tail.text || '').slice(0, 500),
  };
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
 * prompt, start / end, outcome and the files its tool calls touched. The last turn gets the session's token
 * totals (Cline only stores session-level usage).
 * @returns {Array<{index,prompt,startedAt,endedAt,outcome,files,tokens}>}
 */
function readClineRounds(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return [];
  const s = listClineSessions().find((x) => x.id === id);
  if (!s) return [];
  const convo = readConversation(s);
  if (!convo) return [];
  const rounds = [];
  let cur = null;
  const addFile = (p) => {
    const v = String(p || '');
    if (v && cur && !cur.files.includes(v)) cur.files.push(v);
  };
  for (const m of convo.messages) {
    if (!m) continue;
    const content = Array.isArray(m.content) ? m.content : [];
    const ts = Number(m.ts) || 0;
    if (m.role === 'user') {
      const promptItem = content.find((c) => c && c.type === 'text' && /<user_input/i.test(String(c.text || '')));
      if (promptItem) {
        cur = { index: rounds.length, prompt: stripUserInput(promptItem.text), startedAt: ts, endedAt: 0, outcome: 'running', files: [], tokens: null };
        rounds.push(cur);
      }
      continue;
    }
    if (m.role !== 'assistant' || !cur) continue;
    for (const c of content) {
      if (!c || c.type !== 'tool_use') continue;
      addFile(toolTarget(c));
      const input = c.input && typeof c.input === 'object' ? c.input : {};
      if (Array.isArray(input.files)) for (const f of input.files) addFile(f && f.path);
    }
    const tail = content[content.length - 1];
    if (tail && tail.type === 'text') {
      cur.endedAt = ts || cur.endedAt;
      cur.outcome = 'done';
    } else {
      cur.endedAt = 0;
      cur.outcome = 'running';
    }
  }
  if (rounds.length && s.tokens) rounds[rounds.length - 1].tokens = s.tokens;
  return rounds;
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
    result: result || null,
    fileCount: files ? files.length : 0,
    filesJson,
    endedAt: endedAt || null,
    durationMs: endedAt && startedAt ? endedAt - startedAt : null,
  });
  repo.setTaskRunTokens.run({
    id,
    inputTokens: tokens ? tokens.input : null,
    outputTokens: tokens ? tokens.output : null,
    cacheReadTokens: tokens ? tokens.cacheRead : null,
    cacheWriteTokens: tokens ? tokens.cacheWrite : null,
  });
  return filesJson;
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
  if (!sessions.length) return 0;

  const now = nowFn();
  let count = 0;
  const roundsOf = new Map();
  const runsOf = new Map();
  for (const s of sessions) {
    roundsOf.set(s.id, module.exports.readClineRounds(s.id));
    runsOf.set(s.id, repo.taskRunsOfSession.all(s.id || ''));
  }
  const isActiveOf = (s) => (roundsOf.get(s.id) || []).some((r) => r.outcome === 'running');

  // One project writes one member status: pick the newest active session; otherwise the newest one.
  const activeByProject = new Map();
  const newestByProject = new Map();
  for (const s of sessions) {
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
    const sessionRuns = runsOf.get(s.id) || [];

    // Transitional cleanup: an older build wrote one row per session with id `cline:<session id>`.
    if (repo.getTaskRun.get(prefix)) repo.deleteTaskRun(prefix);

    const rounds = roundsOf.get(s.id) || [];
    if (!rounds.length) {
      // A session with no user turn is not a task, but a stale heartbeat must not linger.
      bus.setSessionStatus({ project: projectId, memberId: CLIENT, sessionId: s.id, state: 'idle', taskId: null, ts: now });
      continue;
    }
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
      lastSeenAt: now,
      ephemeral: 0,
      projectLabel: null,
      client: CLIENT,
    });

    const relFiles = (list) =>
      (list || [])
        .map((abs) => {
          const p = String(abs || '');
          if (!p || !projectPath) return p;
          const r = path.relative(projectPath, p);
          return r && !r.startsWith('..') ? r : '';
        })
        .filter(Boolean);

    // One ledger row per turn (same rule as 8F OpenCode / 9F Copilot): the conversation carries the full
    // history, so every user turn is written, not only the current one. `hbId` / `running` / `filesJson`
    // keep the last turn's row, which the heartbeat hangs on.
    let hbId = '';
    let filesJson = null;
    let running = false;
    for (const r of rounds) {
      const id = `${prefix}:${r.index}`;
      const state = r.endedAt ? 'done' : 'running';
      filesJson = writeTurnRun(repo, {
        id,
        projectId,
        memberId,
        sessionId: s.id || null,
        model: s.model || '',
        title: r.prompt || s.title || '(Cline 会话)',
        startedAt: r.startedAt || now,
        endedAt: r.endedAt || null,
        state,
        files: relFiles(r.files),
        result: r.endedAt ? r.result || '' : '',
        tokens: r.tokens,
      });
      hbId = id;
      running = !r.endedAt;
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

    // Heartbeat: only the project's owner session writes it, pointing at the last turn's row.
    const owner = activeByProject.get(projectId) || newestByProject.get(projectId);
    bus.setSessionStatus({
      project: projectId,
      memberId: CLIENT,
      sessionId: s.id,
      state: running ? 'busy' : 'idle',
      taskId: running ? hbId : null,
      ts: now,
    });
    if (owner === s) {
      repo.upsertStatus.run({
        memberId,
        state: running ? 'busy' : 'idle',
        stateSince: running ? rounds[rounds.length - 1].startedAt || now : now,
        taskId: hbId,
        progress: null,
        currentFiles: filesJson,
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
 * The cline source branch (2F): polls Cline's own SQLite + session JSON.
 * @param {object} p floor metadata
 * @param {object} src source spec (kind === 'cline')
 * @param {object} ctx shared utilities provided by the framework
 */
function clineHandler(p, src, ctx) {
  const { claim, upsert, now, workspacePath, TIMEOUT_MS, reporterMainPhase, readReporterDone, doneFieldsFromReporter } = ctx;
  for (const s of listClineSessions()) {
    if (!claim(p.id, s.id)) continue;
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
 * 2F's static subagent definition dirs. Cline has no project-level / user-level agent definition
 * directory, so this returns [] and scans nothing (same interface as the other floors).
 * @returns {Array<{dir:string, level:'project'|'user'}>}
 */
function agentDirs() {
  return [];
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
  readClinePhase,
  readClineDone,
  readClineRounds,
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
};
