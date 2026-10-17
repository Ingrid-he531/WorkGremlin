'use strict';

/**
 * 6F Qoder (CLI and plugin merged single floor) floor module —— merges the plugin form's **data
 * source** and **task synchronizer** (formerly lingma.js / qoderPluginTasks.js) into this one file.
 *
 * 6F has only one reporting identity, qoder (the CLI and the plugin cannot be told apart, they share
 * the same client), and three sources:
 *   · cli    —— scan ~/.qoder/projects transcripts to produce sessions (same as 4F Claude)
 *   · lingma —— poll Qoder CN's own SQLite (local.db), plugin form only
 *   · hook   —— real-time phase fallback
 *
 * This file only owns the "plugin form" path: lingma.js reads the disk, qoderPluginTasks.js writes the
 * ledger. Detailed discipline (read-only opening / short timeouts / caching / phase is inferred not
 * reported) is documented above each function.
 *
 * Unified interface (see FLOOR_CONTRACT in floors.js):
 *   id / client   floor identity
 *   listSessions  this plugin path's sessions (= listLingmaSessions)
 *   readRounds    = readLingmaRounds
 *   readPhase     = readLingmaPhase
 *   readDone      = readLingmaDone
 *   syncTasks     = syncQoderPluginTasks
 */

const os = require('node:os');
const path = require('node:path');
const { formToSource } = require('@workgremlin/shared');
const { openReadonly, readOne } = require('./dbReadonly');
const { resolveProjectName } = require('./project');
const { isFile } = require('./roots');
// Static subagent directories (project-level / user-level): private knowledge of this floor, kept here
// rather than in the central agentLevel
const { genericAgentDirs, makeAgentSync } = require('./ingest/agentLevel');

/**
 * 6F's static subagent definition directories. Qoder has no such thing as "user-level / project-level
 * agent definition files" yet, so this goes through the generic derivation (meta.homeDirs is empty →
 * returns [], no disk scan). If Qoder ever puts agent definitions in some directory, just give the
 * explicit directories here (same interface as CodeBuddy / Codex / Claude).
 * @returns {Array<{dir:string, level:'project'|'user'}>}
 */
function agentDirs(workspacePath) {
  return genericAgentDirs((meta && meta.homeDirs) || [], workspacePath);
}

const HOME = os.homedir();

/**
 * 6F Qoder floor metadata (formerly the 6F entry in products.js). CLI and plugin merged floor.
 */
const meta = {
  id: '6F',
  name: 'Qoder',
  kind: 'cli',
  cmd: 'qoder',
  altCmd: 'qoder-cn',
  agent: 'qoder',
  plugin: false,
  altPluginRe: /tongyi-lingma/i,
  sources: [
    { kind: 'cli', label: 'CLI', client: 'qoder', dirs: [path.join(HOME, '.qoder'), path.join(HOME, '.qoder-cn')] },
    {
      kind: 'lingma',
      label: 'Plugin',
      client: 'qoder',
      // Give the data dir like 7F/8F's SQLite source does: sourceDirs returns [] for kind 'lingma', so
      // without this the floor tooltip's storage row has no path and reads "no data directory found",
      // even though this route does read the extension's local.db (see lingmaDataDir).
      dirs: [lingmaDataDir()],
      note: '这一路读的是 Qoder CN 编辑器插件自己的 local.db（SQLite，chat_session / chat_record）：扩展没有 hook 子系统、也不写 ~/.qoder 的 transcript，所以会话与相位只能由服务端轮询它这份落盘（相位是推断值）',
    },
    { kind: 'hook' },
  ],
  hookSource: true,
  dataKind: 'qoder',
  // Qoder CLI's own install directory (fallback when PATH lookup fails; both entry points are tried)
  cliBinDirs: [path.join(HOME, '.qoder', 'entry'), path.join(HOME, '.qoder-cn', 'entry')],
  // CLI session files (Claude Code's same format) land under <dataRoot>/projects/<project>/, named
  // after session_id
  sessionSubtree: 'projects',
  sessionIdOfFile: (name) => String(name).replace(/\.jsonl$/i, ''),
};

/* ───────────── formerly lingma.js ───────────── */



/** Timeout for opening a read-only connection: give up immediately when the extension's write transaction holds it (discipline 2 in the file header) */
const OPEN_TIMEOUT_MS = 3_000;
/** Session table cache duration */
const TTL = 5_000;
/** How many sessions to bring out at most (newest first, descending; the rest falls back to the "recent" criterion) */
const SESSION_LIMIT = 50;

/**
 * The directory that holds the extension's local.db —— the on-disk data this source reads. It is published
 * to the floor tooltip (the source's `dirs`) so 6F's "Plugin" row shows the real path + stats instead of
 * "no data directory found": sourceDirs returns [] for kind 'lingma' (same as kilo/opencode), so without
 * this the storage row has nothing to display even though the DB is really there.
 * Honors WORKGREMLIN_LINGMA_DB the same way lingmaDbPath() does (self-tests point it at a temp db).
 */
function lingmaDataDir() {
  const explicit = String(process.env.WORKGREMLIN_LINGMA_DB || '').trim();
  return explicit
    ? path.dirname(path.resolve(explicit))
    : path.join(HOME, '.lingma', 'vscode', 'sharedClientCache', 'cache', 'db');
}

/** The extension's DB file; WORKGREMLIN_LINGMA_DB is for self-tests (pointing at a DB built in a temp directory) */
function lingmaDbPath() {
  const explicit = String(process.env.WORKGREMLIN_LINGMA_DB || '').trim();
  const p = explicit ? path.resolve(explicit) : path.join(lingmaDataDir(), 'local.db');
  return isFile(p) ? p : '';
}

/**
 * Session title (6F Qoder / Lingma): SQLite chat_session.session_title.
 * lingmaTitleOf from the old sessionTitle.js moved here —— debugging 6F titles no longer touches a
 * central file.
 * @param {string|null|undefined} sessionId
 * @returns {string}
 */
function sessionTitle(sessionId) {
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

let Database = null;
let DatabaseTried = false;
/** Open a read-only connection; return null whenever it cannot be had (not installed / locked / native module not built) */
function openDb() {
  const file = lingmaDbPath();
  if (!file) return null;
  if (!DatabaseTried) {
    DatabaseTried = true;
    try {
      // better-sqlite3 is an existing server dependency (see server/src/db/index.js), use the workspace copy
      Database = require('better-sqlite3');
    } catch {
      Database = null;
    }
  }
  if (!Database) return null;
  try {
    return new Database(file, { readonly: true, fileMustExist: true, timeout: OPEN_TIMEOUT_MS });
  } catch {
    return null;
  }
}

/** Run a query on the read-only connection; a missing table / bad SQL (extension changed shape) both return null, never bubble */
function query(fn) {
  const db = openDb();
  if (!db) return null;
  try {
    return fn(db);
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* fine if it cannot be closed, the result is already in hand */
    }
  }
}

const cache = { at: 0, key: '', value: null };

/**
 * Sessions chatted in the plugin (**conversation sessions only**).
 *
 * Only `session_type = 'assistant'` counts: measured, conversation sessions carry exactly this value
 * and `mode = 'agent'`; inline completions (code completion) are not tasks and must not enter the
 * ledger. Sessions with no project path are skipped too (they belong to no project).
 *
 * @returns {Array<{id: string, title: string, project: string, projectPath: string,
 *                  lastEventAt: number, createdAt: number, mode: string, rounds: number}>}
 */
function listLingmaSessions() {
  const now = Date.now();
  const file = lingmaDbPath();
  if (cache.value && cache.key === file && now - cache.at < TTL) return cache.value;
  const rows = query((db) =>
    db
      .prepare(
        `SELECT s.session_id, s.session_title, s.project_uri, s.session_type, s.mode,
                s.gmt_create, s.gmt_modified,
                (SELECT COUNT(1) FROM chat_record r WHERE r.session_id = s.session_id) AS rounds
           FROM chat_session s
          WHERE s.session_type = 'assistant'
          ORDER BY s.gmt_modified DESC
          LIMIT ${SESSION_LIMIT}`
      )
      .all()
  );
  const value = (Array.isArray(rows) ? rows : [])
    .map((r) => {
      const projectPath = String(r.project_uri || '').trim();
      return {
        id: String(r.session_id || ''),
        title: String(r.session_title || ''),
        projectPath,
        project: projectPath ? resolveProjectName(projectPath) || path.basename(projectPath) : '',
        lastEventAt: Number(r.gmt_modified) || 0,
        createdAt: Number(r.gmt_create) || 0,
        mode: String(r.mode || ''),
        rounds: Number(r.rounds) || 0,
      };
    })
    .filter((s) => s.id && s.projectPath);
  cache.at = now;
  cache.key = file;
  cache.value = value;
  return value;
}

/** extra is JSON: `originalContent` is the sentence the user typed (plaintext). Return empty when unrecognized, do not guess */
function promptOf(extra) {
  try {
    const j = JSON.parse(String(extra || '') || '{}');
    return String((j && j.originalContent) || '').trim();
  } catch {
    return '';
  }
}

/**
 * The model used this round: extra.modelConfig.key (the model the user picked).
 *
 * `'auto'` does not count —— that means "let the plugin pick", not a model name; leaving it honestly
 * empty is far more useful than printing "auto" on the card. A missing / unrecognized key returns empty
 * too (same discipline as promptOf: unrecognized means no guessing).
 */
function modelOf(extra) {
  try {
    const j = JSON.parse(String(extra || '') || '{}');
    const key = String((j && j.modelConfig && j.modelConfig.key) || '').trim();
    return !key || key === 'auto' ? '' : key;
  } catch {
    return '';
  }
}

/**
 * The criterion for "this round is still running": it is this session's last round and there are still
 * on-disk writes within LIVE_MS.
 *
 * Why freshness can be used: the plugin writes chat_message every time it emits a message or runs a
 * tool within a round (measured: 8 writes in a 2-minute round), so "no movement for a minute and a
 * half" basically equals done. Setting it too short (say 30s) conversely judges a round where "the
 * model is thinking for a long time and nothing has landed on disk yet" as finished.
 * 90 seconds: the longest measured silence (the generation of one answer) was under 30 seconds, so this
 * leaves three times the margin.
 *
 * The ledger (qoderPluginTasks.js) and the session table (the lingma branch of sessionRegistry.js) share
 * this one yardstick —— they must give the same answer to "is this round still running", otherwise the
 * main console and the task records fight each other.
 */
const LIVE_MS = 90_000;

/**
 * What the plugin wrote to disk in **each round** of this session (ascending gmt_create = real order).
 *
 * ⚠️ The source has **no** truth for "did this round finish": `finish_status` stays 0 (measured, even
 * for finished rounds), and the verbatim `answer` is ciphertext. So only "the last update"
 * (updatedAt) is given here; whether it is still running or finished is left to the caller to judge by
 * freshness (see LIVE_MS in qoderPluginTasks.js), and it must be honestly flagged as inferred.
 *
 * @param {string} sessionId
 * @returns {Array<{index: number, requestId: string, prompt: string, summary: string,
 *                  model: string, startedAt: number, updatedAt: number, files: string[]}>}
 */
function readLingmaRounds(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return [];
  const rows = query((db) =>
    db
      .prepare(
        `SELECT request_id, extra, summary, gmt_create, gmt_modified
           FROM chat_record
          WHERE session_id = ?
          ORDER BY gmt_create`
      )
      .all(id)
  );
  if (!Array.isArray(rows)) return [];
  const filesOf = filesByRecord(id);
  return rows.map((r, i) => {
    const requestId = String(r.request_id || '');
    return {
      index: i,
      requestId,
      prompt: promptOf(r.extra),
      summary: String(r.summary || '').trim(),
      model: modelOf(r.extra),
      startedAt: Number(r.gmt_create) || 0,
      updatedAt: Number(r.gmt_modified) || 0,
      files: filesOf.get(requestId) || [],
    };
  });
}

/**
 * Which files each round changed: the snapshot table hangs snapshots off rounds (chat_record_id), and
 * the file table hangs off snapshots.
 *
 * Snapshots with no round attribution (`chat_record_id` empty, measured to be the one the session is
 * **currently writing**) are skipped entirely —— attributing to the wrong round is far worse than
 * missing a few files (same reasoning as 7F's session.diff lesson).
 *
 * @returns {Map<string, string[]>} request_id → list of absolute paths (deduped, order preserved)
 */
function filesByRecord(sessionId) {
  const out = new Map();
  const snaps = query((db) =>
    db.prepare('SELECT snapshot_id, chat_record_id FROM chat_snapshot WHERE session_id = ?').all(sessionId)
  );
  for (const s of Array.isArray(snaps) ? snaps : []) {
    const recordId = String(s.chat_record_id || '');
    const snapshotId = String(s.snapshot_id || '');
    if (!recordId || !snapshotId) continue;
    const files = query((db) =>
      db.prepare('SELECT file_id FROM chat_working_space_file WHERE snapshot_id = ?').all(snapshotId)
    );
    const list = out.get(recordId) || [];
    for (const f of Array.isArray(files) ? files : []) {
      const p = String((f && f.file_id) || '').trim();
      if (p && !list.includes(p)) list.push(p);
    }
    out.set(recordId, list);
  }
  return out;
}

/* ------------------------------ Phase / done marker (for the session table) ------------------------------ */

/**
 * Is the last round "still running" (criterion and reasoning under LIVE_MS).
 *
 * The same expression as qoderPluginTasks.js's isLive: **this session's last round** + disk writes
 * within 90 seconds. The session's own gmt_modified (meta.lastEventAt) is taken into the max as well
 * —— the extension does not necessarily reflect every message write onto chat_record.gmt_modified, and
 * that timestamp on the session row is also written by it.
 */
function lastRoundLive(rounds, meta = {}, now = Date.now()) {
  const last = rounds[rounds.length - 1];
  if (!last) return false;
  return now - Math.max(Number(last.updatedAt) || 0, Number((meta && meta.lastEventAt) || 0)) <= LIVE_MS;
}

/**
 * This plugin session's phase **right now** (**inferred**, not reported by it).
 *
 * The source has no truth for "did this round finish" (finish_status stays 0, answer is ciphertext),
 * only "when it last wrote to disk", so there is a binary choice: last round still fresh → thinking,
 * otherwise idle. Nothing finer can be had (which tool it is calling, whether it waits for permission),
 * and **not one word is filled in** —— better to give just "thinking / standby" than to fabricate
 * "calling tool xxx" from a time window.
 *
 * @param {string} sessionId
 * @param {Array|null} rounds pass in what the caller already read (avoids querying the DB twice in one round)
 * @param {{lastEventAt?: number}} meta the session row's own last-update time
 * @returns {{phase:string,action:string,target:string,tool:string,context:string[],prompt:string,model:string,inferred:boolean}|null}
 */
function readLingmaPhase(sessionId, rounds = null, meta = {}, now = Date.now()) {
  const rs = Array.isArray(rounds) ? rounds : readLingmaRounds(sessionId);
  if (!rs.length) return null;
  const last = rs[rs.length - 1];
  return {
    phase: lastRoundLive(rs, meta, now) ? 'thinking' : 'idle',
    // Tool / target: not in the source, do not guess (see "not one word is filled in" above)
    action: '',
    target: '',
    tool: '',
    context: [],
    // The user's own words on the "thinking" screen (extra.originalContent is plaintext)
    prompt: String(last.prompt || ''),
    model: String(last.model || ''),
    inferred: true,
  };
}

/** Freshness window of the done marker: only wrapping up within this long counts as "just happened", otherwise opening the page replays the previous round (same criterion as kilo.js) */
const DONE_TTL_MS = 10 * 60_000;
/**
 * Default value of the done marker (none means none, no fabrication).
 * doneCancelled is always false: the extension's on-disk data has **no** "the user pressed stop" signal
 * (even the verbatim body is ciphertext, let alone an interrupt trace), so the red "task cancelled" is
 * not lit —— same criterion as 9F Copilot.
 */
const NO_DONE = { doneAt: 0, doneTitle: '', doneCount: 0, doneFiles: [], doneCancelled: false, doneSaid: '' };

/**
 * This plugin session's "done" marker —— the counterpart of the `done` that the hook path drops on Stop.
 *
 * There is exactly one criterion: **the last round has finished**, evidenced by the `summary` the
 * extension wrote itself (a plaintext conversation summary, written only once a round completes). Still
 * in flight (disk writes within 90s) does not count; no summary written does not count either (that
 * means "not finished or the extension has not summarized yet", not "done"). The finish time is that
 * round's last disk write —— the source has nothing more precise.
 *
 * @param {string} sessionId
 * @param {Array|null} rounds
 * @param {{lastEventAt?: number, projectPath?: string}} meta
 * @returns {{doneAt:number,doneTitle:string,doneCount:number,doneFiles:Array,doneCancelled:boolean,doneSaid:string}}
 */
function readLingmaDone(sessionId, rounds = null, meta = {}, now = Date.now()) {
  const rs = Array.isArray(rounds) ? rounds : readLingmaRounds(sessionId);
  if (!rs.length) return NO_DONE;
  const last = rs[rs.length - 1];
  if (lastRoundLive(rs, meta, now)) return NO_DONE;
  const summary = String(last.summary || '').trim();
  if (!summary) return NO_DONE;
  const at = Number(last.updatedAt) || 0;
  if (!at || now - at > DONE_TTL_MS) return NO_DONE;
  const projectPath = String((meta && meta.projectPath) || '');
  // Changed files: the extension records absolute paths, convert to project-relative (same criterion as
  // the ledger path); ones outside the project keep their absolute path
  const files = (Array.isArray(last.files) ? last.files : []).slice(0, 6).map((abs) => {
    if (!projectPath) return String(abs || '');
    const rel = path.relative(projectPath, String(abs || ''));
    return rel && !rel.startsWith('..') ? rel : String(abs || '');
  });
  return {
    doneAt: at,
    doneTitle: String(last.prompt || ''),
    doneCount: Array.isArray(last.files) ? last.files.length : 0,
    doneFiles: files.map((name) => ({ name })),
    doneCancelled: false,
    // Wrap-up self-report: the conversation summary the extension wrote itself (plaintext) —— that is
    // the "what it said" line on the main console
    doneSaid: summary.replace(/\s+/g, ' ').trim().slice(0, 200),
  };
}

/** Are these tables actually in the DB —— gives the frontend a line explaining "this path reads no sessions" (same as kilo.js's hasCoreTables) */
function hasCoreTables() {
  return (
    query((db) => {
      const names = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chat_session','chat_record','chat_snapshot','chat_working_space_file')"
        )
        .all()
        .map((r) => r.name);
      return names.length;
    }) === 4
  );
}

/** For self-tests / debugging: clear the cache (the DB was swapped, or the self-test just wrote new rows) */
function resetLingmaCache() {
  cache.at = 0;
  cache.key = '';
  cache.value = null;
}


/* ───────────── formerly qoderPluginTasks.js ───────────── */

// LIVE_MS (the criterion for "this round is still running") is shared with the session-table branch and
// defined in lingma.js —— both must give the same answer to "is this round still running", otherwise the
// main console and the task records fight each other.


const SYNC_INTERVAL_MS = 5_000;

/** task id prefix: for identification (every row **we** write carries this prefix, the hook path uses `t_*`), and it avoids id collisions.
 *  The identity is always the base name —— no more `-plugin` (the old `qoder-plugin:` packed the form into the id). */
const TASK_ID_PREFIX = 'qoder:';
/** This path's client: the same one as 6F's CLI (products.js: CLI and plugin merged into a single floor) */
const CLIENT = 'qoder';
/** The form column: it stores the **form** (vscode), not the source (plugin) —— task lists show "Qoder Plugin" from it.
 *  It used to be 'plugin', while isPluginClient only recognizes 'vscode' → the label fell back to "Qoder" and the source was computed as cli. */
const FORM = 'vscode';
/** Cap on the length of the output summary (same order of magnitude as RESULT_MAX in hook.js) */
const RESULT_MAX = 4_000;
/** How fresh a heartbeat has to be for the hook (CLI) path to count as "alive" —— while it is alive it takes precedence and the status bar is left alone */
const HOOK_FRESH_MS = 60_000;

/** Project name (project id): resolved the same way as the CLI path (the hook reports the name from package.json, measured as `qoder@workgremlin`), otherwise the plugin and the CLI each create their own member and this floor ends up with two workstations */
function projectIdOf(s) {
  const projectPath = s.projectPath || '';
  if (!projectPath) return '';
  return resolveProjectName(projectPath) || path.basename(projectPath);
}

/**
 * Write one ledger entry (two rows, tasks + task_runs). 6F's plugin path is **one entry per round**.
 * @returns {string|null} this record's files_json (reused directly by current_files in the heartbeat)
 */
function writeTurnRun(repo, { id, projectId, memberId, sessionId, model, title, startedAt, endedAt, state, files, result }) {
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
    form: FORM,
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
    form: FORM,
    // Output summary: the summary the extension wrote itself (plaintext). A round still in flight is
    // left empty for now (half a sentence is not output), and filled in at wrap-up by the next sync ——
    // same as 7F/8F.
    result: result || null,
    fileCount: files ? files.length : 0,
    filesJson,
    endedAt: endedAt || null,
    durationMs: endedAt && startedAt ? endedAt - startedAt : null,
  });
  return filesJson;
}

/** The round sequence number in the ledger id (`<prefix><session id>:<seq>`); null when it is not this shape */
function turnIndexOf(taskId, prefix) {
  const id = String(taskId || '');
  if (!id.startsWith(`${prefix}:`)) return null;
  const n = Number(id.slice(prefix.length + 1));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Is the hook (CLI) path currently occupying this member: the status bar hangs off a task **we did not write**, with a fresh heartbeat */
function hookOwnsMember(repo, memberId, now) {
  try {
    const st = repo.getStatus.get(memberId);
    if (!st || !st.task_id) return false;
    if (String(st.task_id).startsWith(TASK_ID_PREFIX)) return false;
    return now - Number(st.last_heartbeat_at || 0) <= HOOK_FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * @param {{bus: any, repo: any, now?: () => number}} ctx
 * @returns {number} how many tasks this sync wrote / changed
 */
function syncQoderPluginTasks({ bus, repo, now: nowFn = Date.now }) {
  const sessions = listLingmaSessions();
  if (!sessions.length) return 0;

  const now = nowFn();
  let count = 0;

  const roundsOf = new Map();
  const runsOf = new Map();
  for (const s of sessions) {
    roundsOf.set(s.id, readLingmaRounds(s.id));
    runsOf.set(s.id, repo.taskRunsOfSession.all(s.id || ''));
  }

  /** Is this round "still running" (this session's last round + disk writes within 90s; criterion and reasoning under LIVE_MS) */
  const isLive = (s, round) => {
    const rounds = roundsOf.get(s.id) || [];
    if (!rounds.length || rounds[rounds.length - 1] !== round) return false;
    return now - Math.max(Number(round.updatedAt || 0), Number(s.lastEventAt || 0)) <= LIVE_MS;
  };

  /**
   * One project writes **one** member status row (agent_status's primary key is member_id).
   * With several plugin sessions in one project, whoever writes last wins, so first choose "which
   * session should represent this project": the newest among the active ones; if none are active, report
   * the newest one (the card hangs off the last task). Same as 7F/8F.
   */
  const activeByProject = new Map();
  const newestByProject = new Map();
  for (const s of sessions) {
    if (!(roundsOf.get(s.id) || []).length) continue;
    const pid = projectIdOf(s);
    if (!pid) continue;
    const prevNew = newestByProject.get(pid);
    if (!prevNew || Number(s.lastEventAt || 0) > Number(prevNew.lastEventAt || 0)) newestByProject.set(pid, s);
    const live = (roundsOf.get(s.id) || []).some((r) => isLive(s, r));
    if (!live) continue;
    const prevAct = activeByProject.get(pid);
    if (!prevAct || Number(s.lastEventAt || 0) > Number(prevAct.lastEventAt || 0)) activeByProject.set(pid, s);
  }

  for (const s of sessions) {
    const projectPath = s.projectPath || '';
    const projectId = projectIdOf(s);
    if (!projectId) continue;
    const rounds = roundsOf.get(s.id) || [];
    const prefix = `${TASK_ID_PREFIX}${s.id}`;
    // No writable rounds in this project (opened a session in the plugin and said not one word): create
    // neither the project nor the member, so 6F's floor does not sprout an empty workstation
    if (!rounds.length) continue;

    // Make sure the project & member exist (quiet write, no broadcast; the project name resolves the
    // same way as the CLI path)
    bus.ensureProject(projectId, projectPath, null, 'report');
    const memberId = `${CLIENT}@${projectId}`;
    const existing = repo.getMember.get(memberId);
    repo.upsertMember.run({
      id: memberId,
      projectId,
      // The name only takes effect when the member is **newly created** (repo.upsertMember's
      // ON CONFLICT does not update name, see that line "the name is set by whichever path lands it
      // first" in db/index.js). If the CLI path came first it is called 'qoder' (the hook report carried
      // no name, the bus used the memberId prefix), and this does not rename it.
      name: 'Qoder',
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
    for (const t of rounds) {
      const id = `${prefix}:${t.index}`;
      // Changed files: the extension records absolute paths, uniformly converted to project-relative
      // (same as 7F/8F)
      const files = (t.files || [])
        .map((abs) => {
          const p = String(abs || '');
          if (!p) return '';
          if (!projectPath) return p;
          const rel = path.relative(projectPath, p);
          return rel && !rel.startsWith('..') ? rel : '';
        })
        .filter(Boolean);
      const live = isLive(s, t);
      const title = t.prompt.replace(/\s+/g, ' ').trim() || s.title || '(Qoder 插件会话)';
      hbFilesJson = writeTurnRun(repo, {
        id,
        projectId,
        memberId,
        sessionId: s.id || null,
        model: t.model || '',
        title,
        startedAt: t.startedAt || now,
        // Finish time = when this round last wrote to disk (the source has no more precise finish signal, see the file header)
        endedAt: live ? null : t.updatedAt || t.startedAt || now,
        state: live ? 'running' : 'done',
        files,
        // A round still in flight writes no output (it is already finalized in the source by the time
        // the next round starts, then it gets filled in)
        result: live ? '' : String(t.summary || '').slice(0, RESULT_MAX),
      });
      hbId = id;
      running = live;
      count += 1;
    }

    // Retire rounds "no longer in the source" (the session was deleted in the plugin / records were
    // cleared): those rows never get their own round again and hang on 'running' forever, judged
    // "cancelled" by query.js. The criterion is "is this round still in the source" (byIndex).
    const byIndex = new Set(rounds.map((t) => t.index));
    for (const r of runsOf.get(s.id)) {
      const idx = turnIndexOf(r.id, prefix);
      if (idx === null || byIndex.has(idx)) continue;
      repo.deleteTaskRun(r.id);
    }

    // Status bar: written only when "this project should be reported by this session" and the CLI path
    // is not holding it. Running = thinking (inferred), finished = idle; the slot points at the running
    // one (or the newest when there is none).
    const owner = activeByProject.get(projectId) || newestByProject.get(projectId);
    bus.setSessionStatus({
      project: projectId,
      memberId: CLIENT,
      sessionId: s.id,
      state: running ? 'busy' : 'idle',
      taskId: running ? hbId : null,
      ts: now,
    });
    if (owner === s && hbId && !hookOwnsMember(repo, memberId, now)) {
      repo.upsertStatus.run({
        memberId,
        state: running ? 'busy' : 'idle',
        stateSince: running ? rounds[rounds.length - 1].startedAt || now : now,
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
 * The lingma source branch (6F plugin form): polls Qoder CN's own local.db.
 * The whole lingma branch from the old sessionRegistry.js moved here, so debugging 6F no longer touches
 * a central file.
 * @param {object} p floor metadata
 * @param {object} src source spec (kind === 'lingma')
 * @param {object} ctx shared utilities provided by the framework (claim / upsert / now / workspacePath / TIMEOUT_MS …)
 */
function lingmaHandler(p, src, ctx) {
  const { claim, upsert, now, workspacePath, TIMEOUT_MS } = ctx;
  for (const s of listLingmaSessions()) {
    if (!claim(p.id, s.id)) continue;
    if (now - (Number(s.lastEventAt) || 0) >= TIMEOUT_MS) continue;
    const rounds = readLingmaRounds(s.id);
    if (!rounds.length) continue;
    const ph = readLingmaPhase(s.id, rounds, s, now);
    upsert({
      floor: p.id,
      id: s.id,
      sessionId: s.id,
      // source = form→source (Lingma is a VS Code-family extension → plugin form)
      source: formToSource('vscode'),
      form: 'vscode',
      sourceKind: 'lingma',
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
      model: (ph && ph.model) || '',
      inferred: true,
      ...readLingmaDone(s.id, rounds, s, now),
      lastEventAt: s.lastEventAt,
    });
  }
}

const kindHandlers = { lingma: lingmaHandler };

const { runHookEvent, sharedHookImpl, jsonlReplies, indexJsonReplies, turnInterrupted, headJsonLines } = require('./ingest/hookCommon');

/** Qoder form (cli / plugin): the entrypoint of the first user line of the transcript.
 * Moved from hookCommon to this floor ("the floor's own interface"); fields not overridden fall back to sharedHookImpl. */
function qoderForm(transcriptPath) {
  for (const obj of headJsonLines(transcriptPath)) {
    const ep = obj && typeof obj.entrypoint === 'string' ? obj.entrypoint.trim().toLowerCase() : '';
    if (!ep) continue;
    if (ep.includes('vscode') || ep.includes('plugin')) return 'vscode';
    return ep === 'cli' ? 'cli' : '';
  }
  return '';
}

/** Qoder's on-disk differences: event gating and the common file/token/ghost logic all live in hookCommon.runHookEvent */
const qoderImpl = {
  ...sharedHookImpl,
  awaitingPermission: () => true, // any non-idle Notification counts as "awaiting permission"
  repliesOf: (tp) => (/index\.json$/i.test(tp) ? indexJsonReplies(tp) : jsonlReplies(tp)),
  interruptedSince: (tp, since) => turnInterrupted(tp, since),
  formOf: (tp) => qoderForm(tp),
};

async function handleHookEvent(ev, ctx) {
  return runHookEvent(ev, ctx, qoderImpl);
}

module.exports = {
  // 6F Qoder
  client: 'qoder',
  meta,
  kindHandlers,
  sessionTitle,
  // Plugin-form data source (formerly lingma.js)
  lingmaDbPath,
  listLingmaSessions,
  readLingmaRounds,
  readLingmaPhase,
  readLingmaDone,
  hasCoreTables,
  resetLingmaCache,
  // Static subagent dirs (project / user level): read by this floor's own syncAgents
  agentDirs,
  // Register this floor's user / project subagents with the roster (see agentLevel.makeAgentSync)
  syncAgents: makeAgentSync(agentDirs, meta.agent),
  LIVE_MS,
  TTL,
  SESSION_LIMIT,
  // Plugin-form task synchronizer (formerly qoderPluginTasks.js)
  syncQoderPluginTasks,
  // Unified poll contract: the server calls syncTasks on this floor's pollMs (floors hold no timers — see poller.js)
  pollMs: SYNC_INTERVAL_MS,
  TASK_ID_PREFIX,
  // Unified interface aliases
  listSessions: listLingmaSessions,
  readRounds: readLingmaRounds,
  readPhase: readLingmaPhase,
  readDone: readLingmaDone,
  syncTasks: syncQoderPluginTasks,
  // Server-side hook event handling (disk parsing belongs to the server)
  handleHookEvent,
  qoderForm,
};
