'use strict';

/**
 * sessionRegistry.js —— the global active session table.
 *
 * One table manages the sessions every agent (floor) has open in every project, regardless of which
 * project is currently open. Each record = one session, grouped by **floor** (monitored product), and
 * removed on timeout:
 *
 *   1F CodeBuddy —— **merged floor**: the CLI and Plugin are two forms of the same product, merged into
 *                        one floor. The plugin path is structured on-disk data (genie-history / todos /
 *                        message-queue / file-changes), from which runtime state, todo lists and changed
 *                        files can be had (see sessions.js);
 *                        the CLI path is ~/.codebuddy's session jsonl + reporter state file.
 *                        Sessions on both paths at once = two sessions in this floor (distinguished by
 *                        session_id), not two floors.
 *   2F WorkBuddy,
 *   3F Codex CLI,
 *   4F Claude Code CLI —— *.jsonl session files in the on-disk directory, only file times are reliable;
 *                        the project name comes from finding cwd in the file's **first few lines** (see
 *                        cwdOfHead);
 *                        when it is not there yet (the first conversation has not landed on disk) it
 *                        falls back to the cwd registered in sessions/<pid>.json (see liveSessionCwds);
 *                        only when neither can be read does it stay empty (no guessing).
 *                        Note it is not "the first line": Claude's first line is a meta record like mode
 *                        / queue-operation with no cwd at all, and cwd only appears from line 3's user
 *                        record on (see cwdOfHead)
 *                        (Codex's cwd hides in payload.cwd, likewise covered by cwdOfHead)
 *   7F Kilo Code —— **polling route**: Kilo has no hook and no session jsonl; sessions / phases / done
 *                   markers are all derived by server/src/kilo.js reading its own event-sourced SQLite
 *                   (kilo.db).
 *                   The phase carries inferred:true yet has a true phase source (derived from the event
 *                   stream).
 *
 * Timeout: a session with no events for 60 minutes (its last update time has not moved forward) is
 * removed from the table.
 * Being removed only means "no longer active"; when it stirs again it is registered anew as a new
 * session.
 *
 * Discipline (docs/requirements.md §P0-6 "never fabricate"): a session that carries no role / progress
 * / duration gets not one line filled in; phases are always inferred values, carrying inferred: true.
 */

const fs = require('node:fs');
const path = require('node:path');
const log = require('./log');
const { listSessions, listReporterSessions, readReporterDones, readReporterDone, reporterMainPhase, reporterSnapshotPhase, freshestReporterWs } = require('./sessions');
const { detectProducts } = require('./floors');
const { floorOf, floorByAgent } = require('./floors');
const { formToSource } = require('@workgremlin/shared');

/**
 * The floor's id ("1F" / "8F" …). The single source is the floor module's `meta.id` — reading a
 * top-level `.id` instead made the floors that only expose `meta.id` (7F Kilo / 8F OpenCode) invisible
 * to the session table (taskState stayed null, so the main console showed "standby" between events).
 */
const floorIdOf = (f) => (f && f.meta && f.meta.id) || '';

// Process start moment: "end states" like doneAt only count when they happened **after this process
// started**, so old end states do not resurrect after a restart.
const SINCE_BOOT = Date.now();

/**
 * agent name → floor meta. Single source: floors.js's `floorByAgent` (agent → module) already indexes
 * every floor by its base name, so read `meta` off that module instead of building a second agent→meta
 * map here. Each floor's "which subtree session files land in / how to get the sessionId out of a file
 * name" lives in meta.sessionSubtree / meta.sessionIdOfFile; this file only dispatches by meta and keeps
 * no product-specific parsing rules (see each <product>.js).
 */
const metaOfAgent = (agent) => (floorByAgent[String(agent || '').toLowerCase()] || {}).meta || null;
const { resolveProjectName } = require('./project');

/** No events for longer than this → removed from the table */
const TIMEOUT_MS = 60 * 60_000;
/** Disk-scan cache (one scan reads a dozen small files + walks the directory tree) */
const TTL = 5_000;

/** @type {Map<string, any>} key (`<floor>:<session id>`) -> session */
const table = new Map();

let lastScanAt = 0;
let lastSnapshot = null;
/** This scan's (project|client) -> readReporterDones result; rebuilt on every refresh.
 *  A CLI floor can scan out hundreds of historical session files, and walking the hooks directory for
 *  each one is too wasteful, so the disk is read once per client. */
let doneScans = new Map();

/**
 * Ledger write side (bus + repo), injected by index.js at assembly time —— see flushSynthesizedCancels.
 * Why it must be injected: this module is required by the route layer, while the bus instance is created
 * by createIngestBus() inside index.js; require('./ingest/bus') in a module only gets that **factory**
 * `{ createIngestBus, projectIdOf, memberIdOf }`, and `bus.endTask` does not exist at all.
 * Tests (the ones that only call snapshot) inject nothing → this step does nothing, as before.
 * @type {{bus: any, repo: any}|null}
 */
let backend = null;
function setBackend(next) {
  backend = next && next.bus ? { bus: next.bus, repo: next.repo || null } : null;
}

const SKIP = new Set(['node_modules', '.git', '.svn', 'cache', 'Cache', 'logs']);

function mtime(p) {
  try {
    return Math.round(fs.statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

/** File size in bytes; unreadable counts as 0 (0 = empty file, not a session, see scanCliSessions) */
function sizeOf(p) {
  try {
    return fs.statSync(p).size || 0;
  } catch {
    return 0;
  }
}

/**
 * Get the project path out of one line. The CodeBuddy family has cwd at the top level; Codex hides it in
 * payload.
 * If this line cannot be parsed (truncated / not JSON at all) → empty, and the caller decides whether to
 * fall back to a regex.
 */
function cwdOfLine(line) {
  if (!line) return '';
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return '';
  }
  // CodeBuddy family: cwd at the top level
  if (j && typeof j.cwd === 'string') return j.cwd;
  // Codex: {"type":"session_meta","payload":{"cwd":...}} —— cwd hidden in payload
  if (j && j.payload && typeof j.payload.cwd === 'string') return j.payload.cwd;
  return '';
}

/**
 * Get the project path from the session file's **first few lines**; leave it empty when unreadable, do
 * not guess.
 *
 * Why looking at the first line only is not enough: **Claude Code's first line is not conversation
 * content**. Measured, its transcript starts with `{"type":"queue-operation",...}` (new versions) or
 * `{"type":"mode",...}` (old versions), neither of which carries `cwd`; `cwd` only appears from line 3's
 * `user` / `attachment` record on (a top-level field).
 * The old implementation read only the first line, so **every** 4F session's project was empty —— one
 * empty value causing three symptoms at once: the dropdown shows "unknown project", `mine` is always
 * false, and even the live phase cannot be overlaid (the render layer requires a non-empty `projectPath`
 * before using fast polling, see canUseFast in IsoOfficeView) → the main console hangs on "unreported".
 *
 * Read and try as you go, stop on a hit: this function is called once per session file every few seconds,
 * and it must not walk a whole tree just for one line of cwd.
 * The cap is generous (512KB / 60 lines): Codex's session_meta line carries the entire base_instructions,
 * and 8KB would truncate it into broken JSON from which cwd cannot be read.
 * @param {string} p session jsonl path
 * @returns {string} absolute project path; empty string when unreadable
 */
function cwdOfHead(p, { cap = 524_288, maxLines = 60 } = {}) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
  } catch {
    return '';
  }
  try {
    const CHUNK = 8192;
    // buf only keeps the fragment that has not yet formed a complete line (complete lines are cut away and
    // tried on the spot), so cap really limits a single line's length
    let buf = Buffer.alloc(0);
    let lines = 0;
    while (buf.length < cap && lines < maxLines) {
      const next = Buffer.alloc(CHUNK);
      const n = fs.readSync(fd, next, 0, CHUNK, buf.length);
      if (n <= 0) break;
      buf = Buffer.concat([buf, next.subarray(0, n)]);
      let nl = buf.indexOf(0x0a);
      while (lines < maxLines && nl >= 0) {
        const c = cwdOfLine(buf.subarray(0, nl).toString('utf8'));
        buf = buf.subarray(nl + 1);
        lines += 1;
        if (c) return c;
        nl = buf.indexOf(0x0a);
      }
      if (n < CHUNK) break;
    }
    // Getting here means buf has no newline terminator: either the file simply ends here (no trailing
    // newline), or this very long line hit cap.
    // Both cases first parse the whole line, and only fall back to a regex fishing out the **first** cwd
    // —— which is still this session's own (later events have not been read at all), same criterion as the
    // old implementation.
    if (lines >= maxLines || !buf.length) return '';
    const tail = buf.toString('utf8');
    const direct = cwdOfLine(tail);
    if (direct) return direct;
    const m = tail.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return '';
    try {
      const s = JSON.parse(`"${m[1]}"`);
      return typeof s === 'string' ? s : '';
    } catch {
      return '';
    }
  } catch {
    return '';
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* failing to close does not matter */
    }
  }
}

/**
 * The **session state file** a running CLI process writes itself: `<product home>/sessions/<pid>.json`,
 * one per process. Measured shape (CodeBuddy CLI 2.162.0, this machine, 2026-10-09):
 *   { pid, sessionId, cwd, startedAt, kind:'interactive', url, endpoint, mode, updatedAt }
 * Claude Code 2.1.283's file of the same name carries cwd too (claudeSessionStatus in sessions.js has
 * been reading it for a while).
 *
 * It exists **earlier** than the transcript: it is written as soon as the process is up, when
 * projects/<project>/<session>.jsonl does not yet hold a single conversation —— exactly the window where
 * cwdOfHead returns empty and the dropdown shows "unknown project" (which the user asked about on
 * 2026-10-09).
 *
 * Why the directory name is not used as a fallback: that directory layer under projects really does encode
 * the project path (`<cwd with separators removed>`), but the separators are gone, and turning
 * `home-yinghui-work-WorkGremlin` back into `/home/yinghui/work/WorkGremlin` can only be guessed (is
 * "work-gremlin" one directory or two?). projectPath feeds both the `mine` judgment and the main
 * console's fast polling, so the cost of guessing wrong is much larger than showing "unknown project" ——
 * hence no fallback.
 *
 * Matching is **exact** by sessionId only; a missing directory / parse failure / absent cwd all count as
 * "none", no guessing.
 * It is asked once per session file, and with hundreds of session files that is hundreds of times, so both
 * directory listing and contents are cached for 2s.
 * @param {string} dataPath product on-disk root (e.g. ~/.codebuddy)
 * @returns {Map<string, string>} sessionId -> cwd
 */
const _liveState = { dir: '', at: 0, cwds: new Map() };
function liveSessionCwds(dataPath) {
  const dir = dataPath ? path.join(dataPath, 'sessions') : '';
  const now = Date.now();
  if (dir === _liveState.dir && now - _liveState.at < 2_000) return _liveState.cwds;
  _liveState.dir = dir;
  _liveState.at = now;
  _liveState.cwds = new Map();
  if (!dir || !isDir(dir)) return _liveState.cwds;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.json$/i.test(n));
  } catch {
    return _liveState.cwds;
  }
  /** @type {Map<string, {cwd: string, updatedAt: number}>} */
  const best = new Map();
  for (const name of names.slice(0, 200)) {
    let j = null;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue; // the process may be mid-write / killed halfway → fragmentary. A fragment counts as not read, do not guess
    }
    const sid = j && typeof j.sessionId === 'string' ? j.sessionId.trim() : '';
    const cwd = j && typeof j.cwd === 'string' ? j.cwd.trim() : '';
    if (!sid || !cwd) continue;
    // The same session may keep several copies (old pids not cleaned up) → take the newest, same
    // criterion as claudeSessionStatus
    const prev = best.get(sid);
    const at = Number(j.updatedAt || 0);
    if (prev && Number(prev.updatedAt || 0) >= at) continue;
    best.set(sid, { cwd, updatedAt: at });
  }
  for (const [sid, v] of best) _liveState.cwds.set(sid, v.cwd);
  return _liveState.cwds;
}

/** Human-readable relative time (only for copy like "how long ago the session file was touched") */
function formatAge(ms) {
  const n = Number(ms) || 0;
  if (n < 60_000) return '刚刚有更新';
  if (n < 60 * 60_000) return `${Math.round(n / 60_000)} 分钟前有更新`;
  return `${Math.round(n / (60 * 60_000))} 小时前有更新`;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Get the session id out of the session file name (empty when it cannot be had —— no guessing).
 *
 *   - Claude Code: the transcript is called `<session_id>.jsonl`, stripping the extension gives it
 *     (the hook payload's session_id; measured 100% consistent across three places).
 *   - Codex: `rollout-<YYYY-MM-DDTHH-MM-SS>-<session_id>.jsonl` —— the id is **the segment after the
 *     timestamp**. What used to be written here was "different shape, do not guess, leave empty", but it
 *     is really **a different way of taking it**: stripping the extension yields the whole
 *     `rollout-…-<id>` string. Measured 3/3 on this machine, the trailing uuid matches the session_id in
 *     the hooks state file character for character (rollout-2026-09-26T11-15-56-01a0dbb6-…  ==  codex__…
 *     _01a0dbb6-….json).
 *     The gain from getting the id is making 3F's "done" go from "newest in this project" to per-session
 *     exact (see doneFieldsOf), and the render layer's fast polling starts carrying ?session= too (the
 *     phase benefits likewise).
 *     Failure is safe: a shape mismatch returns empty → falls back to the old behavior, no mix-ups.
 *   - Other products (WorkBuddy CLI): the file name carries no session id, leave empty.
 * @param {string} name file name (with extension)
 * @param {string} kind product base name (products' agent: claude / codex / codebuddy …)
 * @returns {string} session id; empty string when it cannot be had
 */
/**
 * File name → session id. The rule comes with each floor's meta.sessionIdOfFile (see each <product>.js);
 * this file only looks up meta by agent and does generic dispatch; no meta / no such floor → empty string
 * (falls back to the old behavior, never misattributes).
 * @param {string} name file name (with extension)
 * @param {string} kind product base name (floor meta.agent: claude / codex / codebuddy …)
 * @returns {string} session id; empty string when it cannot be had
 */
function sessionIdOfFile(name, kind) {
  const m = metaOfAgent(kind);
  return m && typeof m.sessionIdOfFile === 'function' ? m.sessionIdOfFile(name) : '';
}

/**
 * Session files in the CLI's on-disk data (*.jsonl): one file counts as one session.
 * Only file times are reliable; fields that cannot be read are left empty.
 *
 * By kind, only the subtree that really holds sessions is scanned: Codex writes under
 * sessions/YYYY/MM/DD/, Claude Code and CodeBuddy under projects/<project dir>/; all three roots also
 * hold non-session files like history.jsonl and settings.json, which would be pure noise if scanned in
 * (and it avoids walking those big cache / plugins directories as a bonus).
 */
function scanCliSessions(dataPath, { limit = 200, kind = '' } = {}) {
  if (!dataPath) return [];
  // Only scan the subtree that really holds session files —— which one is decided by this floor's
  // meta.sessionSubtree (see each <product>.js): Codex under sessions/, Claude / Qoder / CodeBuddy under
  // projects/. The root also holds non-session files like history.jsonl / settings.json, which would be
  // pure noise if scanned in (and it avoids walking those big cache / plugins directories as a bonus).
  // When the directory does not exist it falls back to the whole tree (the isDir check below), so old
  // installs behave unchanged.
  const meta = metaOfAgent(kind) || {};
  const sub = meta.sessionSubtree ? path.join(dataPath, meta.sessionSubtree) : '';
  const root = sub && isDir(sub) ? sub : dataPath;
  // When the transcript has no first conversation yet (the session just started), cwd can only be found in
  // this product's own session state file —— sessionId -> cwd (see liveSessionCwds). One copy is shared
  // across the whole scan; do not re-read the directory for every session file.
  const liveCwds = liveSessionCwds(dataPath);
  const out = [];
  const walk = (d, depth) => {
    if (depth > 4 || out.length >= limit) return;
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (out.length >= limit) return;
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        // A subagent's transcript is not an independent session: they live in
        // `<session id>/subagents/agent-<agentId>.jsonl` and share the same sessionId as the parent
        // session (their first line carries cwd too, so "read the first line to judge the project" would
        // treat it as a session).
        // The consequence of taking them in: one session plus as many extra "sessions" as it has
        // subagents, all noise.
        if (e.name === 'subagents') continue;
        walk(p, depth + 1);
        continue;
      }
      if (!/\.jsonl$/i.test(e.name)) continue;
      // An empty file is not a session: a session that just started and was interrupted before writing
      // leaves behind a 0-byte jsonl placeholder
      // (measured: ~/.codebuddy/projects/home-yinghui/<session>.jsonl is exactly that).
      // It still has an mtime and still falls into the 60-minute active window, so the dropdown grows a
      // phantom "unknown project" entry.
      if (!sizeOf(p)) continue;
      const at = mtime(p);
      const sid = typeof meta.sessionIdOfFile === 'function' ? meta.sessionIdOfFile(e.name) : sessionIdOfFile(e.name, kind);
      // Project path: first look at cwd in the transcript head (parsing rules under cwdOfHead); when the
      // first conversation has not landed on disk it is not there, so fall back to the session state file
      // the running CLI wrote (matched exactly by sessionId, see liveSessionCwds)
      const cwd = cwdOfHead(p) || liveCwds.get(sid) || '';
      out.push({
        id: path.relative(root, p),
        // Axis 2: which session this on-disk data belongs to (parsing rules and measured evidence under
        // sessionIdOfFile)
        sessionId: sid,
        project: cwd ? resolveProjectName(cwd) || path.basename(cwd) : '',
        projectPath: cwd,
        lastEventAt: at || Date.now(),
      });
    }
  };
  walk(root, 0);
  return out;
}

/** Register / update one session */
function upsert(entry) {
  const key = `${entry.floor}:${entry.id}`;
  const prev = table.get(key);
  const now = Date.now();
  // When no event time can be had (the plugin gave no last update) keep the previously registered time;
  // impersonating the event with "now" would make such a session never time out and hang in the table
  // forever.
  const lastEventAt = Number(entry.lastEventAt) || (prev ? prev.lastEventAt : now);
  table.set(key, {
    ...entry,
    key,
    lastEventAt,
    firstSeenAt: prev ? prev.firstSeenAt : now,
    active: now - lastEventAt < TIMEOUT_MS,
  });
}

/** Remove sessions that timed out (no events for 60 minutes) from the table */
function prune(now = Date.now()) {
  let removed = 0;
  for (const [key, s] of table) {
    if (now - s.lastEventAt >= TIMEOUT_MS) {
      table.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/** The uniform return value when a done marker is missing (none means none, no fabrication)
 *  doneCancelled: that round was interrupted by the user (ESC / stop); the render layer lights a red
 *  "task cancelled" instead of "task finished" based on it. */
const NO_DONE = { doneAt: 0, doneTitle: '', doneCount: 0, doneFiles: [], doneCancelled: false };

/**
 * The **raw** done in the reporter state file (`{at,title,files,fileCount,cancelled,workspacePath}`) →
 * the session row shape (`{doneAt,doneTitle,doneCount,doneFiles,doneCancelled}`).
 *
 * Why this step: 7F/8F session rows used to spread the raw done in directly (`...doneTruth`), and the
 * field names (`at` / `files`) do not line up with the session row's convention (`doneAt` / `doneFiles`)
 * —— the render layer reading `sel.doneAt` gets nothing, so installing the plugin ends up with less
 * information than the polling copy. Converting once here also passes `cancelled` through as
 * `doneCancelled` (the main console lights a red "task cancelled" based on it).
 * @param {{at?:number,title?:string,files?:Array,fileCount?:number,cancelled?:boolean}} done
 */
function doneFieldsFromReporter(done) {
  const files = Array.isArray(done.files) ? done.files : [];
  const count = Number(done.fileCount);
  return {
    doneAt: Number(done.at) || 0,
    doneTitle: done.title || '',
    doneCount: Number.isFinite(count) ? count : files.length,
    // Keep size where it exists (the plugin path has it); entries with only a path fall back to name
    // (same shape as doneFieldsOf)
    doneFiles: files.slice(0, 6).map((f) =>
      typeof f === 'string'
        ? { name: f }
        : { name: (f && (f.path || f.name)) || '', ...(f && Number.isFinite(f.size) ? { size: f.size } : {}) }
    ),
    doneCancelled: Boolean(done.cancelled),
  };
}

/**
 * The "done marker" of CLI / hookSource floors, with field names exactly matching the plugin branch.
 *
 * Previously only plugin floors carried doneAt in the session table (computed on the plugin on-disk path),
 * while CLI floors could only wait for the render layer's 1.5s fast polling to bring the done marker back
 * —— so "finished" had two sources in the UI, and switching floors even popped a false "task finished"
 * once (the render layer could not get doneAt from the session snapshot and had to treat the first thing
 * the fast polling saw as a new event).
 * The timestamp source is now unified: CLI / hookSource floors go through this function (reading the done
 * the reporter drops at Stop), no longer depending on "the render layer's fast polling seeing it for the
 * first time counts as a new event", so the render layer no longer needs to branch by floor.
 * But "same source" only aligned the timestamp source, not the attribution: **those with a session id hit
 * exactly via bySession, those without one can only fall back to (project+client)'s latest** —— with
 * several sessions running on the same floor, the latter may still credit "someone else just finished" to
 * the current one. That is known residue, not a regression this time.
 * Those for which an id can now be had: Claude CLI (file name), Codex (rollout file name, see
 * sessionIdOfFile), 5F TraeCode (listReporterSessions could only ever list ones with a sessionId), and
 * 1F CodeBuddy's hook path. The remaining 1F (CLI jsonl) / 2F CLI floors have file names without an id,
 * so they fall back to the latest within that project; the plugin path's session rows carry a sessionId
 * too now, but their doneAt goes through sessionInfo in sessions.js, not this function.
 *
 * The file list has paths only: the hook does no diff, so there are no +/- line counts (that is something
 * only the plugin's on-disk file-changes has).
 * @param {string} projectPath the project this session belongs to (used to filter when reading the state
 *   file); **may be empty**, see the guard below
 * @param {string} client client identity (the client of **this path**, e.g. codex / trae / codebuddy)
 * @param {string} sessionId session id; **required** —— without a session id there is no such thing as
 *   "this round finished"
 */
function doneFieldsOf(projectPath, client, sessionId = '') {
  // Take it exactly by session: no session id → no done marker (no longer falling back to "the newest of
  // this client").
  if (!sessionId) return NO_DONE;
  // projectPath is only used as the cache key (readReporterDones scans everything once); the exact hit is
  // uniquely bound to the session id.
  const key = `${projectPath || ''}|${client || ''}`;
  if (!doneScans.has(key)) doneScans.set(key, readReporterDones(projectPath, client));
  const { bySession } = doneScans.get(key);
  const done = bySession.get(String(sessionId)) || null;
  if (!done) return NO_DONE;
  const files = Array.isArray(done.files) ? done.files : [];
  const count = Number(done.fileCount);
  return {
    doneAt: Number(done.at) || 0,
    doneTitle: done.title || '',
    doneCount: Number.isFinite(count) ? count : files.length,
    doneFiles: files.slice(0, 6).map((f) => ({ name: typeof f === 'string' ? f : (f && f.path) || '' })),
    // The reporter's done.cancelled (the one Interrupt drops): passed through as-is, no guessing, no filling in
    doneCancelled: Boolean(done.cancelled),
  };
}

/**
 * Scan every data source once and update the table.
 * @param {{workspacePath?: string, force?: boolean}} o
 */
function refresh({ workspacePath = '', force = false } = {}) {
  const now = Date.now();
  if (!force && lastScanAt && now - lastScanAt < TTL) return;
  doneScans = new Map();

  /**
   * Session sources: each floor fetches per its own sources —— one path for ordinary floors, several for
   * merged ones (1F CodeBuddy = CLI on-disk + plugin structured on-disk + reporter state file, see
   * sources in products.js).
   *
   * Every path's client is the **floor base name** (same for the plugin / CLI / hook paths), and the form
   * is expressed by that path's form / kind.
   * Sessions are attributed by sessionId: when the same product has both CLI and Plugin open, the two
   * sessions each read their own on-disk data and do not bleed into each other.
   *
   * The CLI's JSONL and the hook state file may describe the same session. When both paths provide a
   * sessionId, dedup only happens for the same id; the SessionEnd reporter marker excludes both the old
   * hook row and the corresponding JSONL. A brand-new CLI session is still listed by the SessionStart hook
   * state even without a transcript, and is not masked by another recent JSONL on the same floor.
   */
  const products = detectProducts({});
  const seen = new Set();
  const cliLandingSessions = new Map();
  const claim = (floor, sessionId) => {
    if (!sessionId) return true;
    const k = `${floor}:${sessionId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  // The framework packs the shared utilities into ctx and hands them to each floor's source branch (the
  // standard handlers are DEFAULT_KIND_HANDLERS below, floor-specific ones in each file's
  // modules/kindHandlers) —— debugging one floor cannot touch another's.
  const ctx = {
    now, workspacePath, force,
    table, backend, TIMEOUT_MS,
    seen, claim, cliLandingSessions, doneScans,
    resolveProjectName, formatAge,
    upsert, doneFieldsOf, doneFieldsFromReporter,
    scanCliSessions, liveSessionCwds, listReporterSessions,
    listSessions, reporterMainPhase, readReporterDone,
  };

  for (const p of products) {
    const mod = floorOf(p.id);
    ctx.product = p;
    for (const src of p.sources) {
      // The paths that exist only for on-disk display (kind 'dir', like 5F's ~/.trae-cn and ~/.marscode)
      // produce no sessions: there is stuff in the directory but no session index to read —— they only
      // enter the floor tooltip, not the session table.
      if (src.sessions === false) continue;

      // ---- the kilo / opencode / lingma paths (7F / 8F / 6F-plugin) ----
      // These are not "scan files" but polling each product's own on-disk store (kilo.db / opencode.db /
      // Lingma local.db), with a shape different from cli/hook (they carry a true phase and a model).
      // Their implementations have moved into each floor's file (kindHandlers in kilo.js / opencode.js /
      // qoder.js), called by the generic dispatch below via src.kind, so debugging 6F/7F/8F no longer
      // requires touching this file.

      // Generic dispatch: a floor's own source branch (kilo / opencode / lingma) takes precedence over the
      // framework's built-in standard handler (plugin / cli / hook). This line is "each floor's stuff is
      // confined to its own file" landed —— adding / adjusting a floor touches only its file + floors.js,
      // this file stays unchanged.
      const handler = (mod && mod.kindHandlers && mod.kindHandlers[src.kind]) || DEFAULT_KIND_HANDLERS[src.kind];
      if (handler) handler(p, src, ctx);
    }
    // The floor's own background flush (e.g. 5F Trae's endTask / amount re-emission): it must run before
    // the generic flush, otherwise superseded would first turn Trae's normally finished running tasks into
    // cancelled.
    if (mod && typeof mod.flushBackend === 'function') mod.flushBackend(ctx);
  }

  // Generic flush (floor-agnostic, operates on doneScans): the synthesized cancels for "the user really
  // pressed stop" / wrapping up the previous round that got pushed out.
  // (Trae's own endTask / amount re-emission already ran via trae.js's flushBackend in the floor loop above.)
  flushSynthesizedCancels(doneScans, now);
  // The previous round pushed out by a new one (the row whose session never got an end event): give it a
  // cancelled too.
  // Note: Trae's flushBackend has already turned tasks with a DoneHandler into done/cancelled, so
  // superseded only touches running tasks that "do not even have a DoneHandler" (a rare extreme case).
  flushSupersededTasks(doneScans);

  prune(now);
  lastScanAt = now;
  lastSnapshot = null;
}

/* ------------------------------ Standard source branches (built into the framework, shared by all floors) ------------------------------ */

// The plugin path: the editor's globalStorage structured on-disk data (genie-history / todos / …).
// 1F/9F's plugin sources go through here; the logic is preserved as-is, just pulled out of refresh's giant
// switch.
function handlePlugin(p, src, ctx) {
  const { workspacePath, force, table, claim, upsert, listSessions, listReporterSessions, doneFieldsOf, doneScans } = ctx;
  /**
   * This path needs a doneScan too: some floors' plugins **emit not a single hook event when cancelling**,
   * so only the floor's own synthMarks can recognize it from the on-disk data and synthesize a cancel /
   * done marker through readReporterDones (floor-private logic, not mixed in here).
   * And flush* only scans doneScans, while handlePlugin does not go through doneFieldsOf (the done* fields
   * are computed separately via listSessions) —— without this, plugin cancels would never be scanned,
   * task_runs would stay running forever, and the ticker / task list would never receive "cancelled".
   * One is built per (project | client) here (the same cache key as doneFieldsOf) so flush can add its
   * task/end(cancelled) stroke.
   */
  const scanKey = `${workspacePath || ''}|${src.client || ''}`;
  if (!doneScans.has(scanKey)) doneScans.set(scanKey, readReporterDones(workspacePath, src.client));

  // A floor's optional **plugin session policy** (who counts as the current session / who has ended / who
  // should not be listed in the dropdown): the framework knows no product, it only dispatches by interface
  // (see FLOOR_CONTRACT: pluginPolicy in floors.js; 1F's implementation is in floorCodebuddy.js).
  // A floor implementing no policy gets "list everything + only exclude those already SessionEnd'd in the
  // reporter" (the default behavior when policy is empty).
  const mod = floorOf(p.id);
  const policy = mod && typeof mod.pluginPolicy === 'function' ? mod.pluginPolicy(ctx) || {} : {};
  const reporterSessions = listReporterSessions(src.client, { includeEnded: true });
  const endedSessionIds = new Set([
    ...reporterSessions.filter((s) => s.endedAt).map((s) => s.sessionId),
    ...(policy.ended || []).map((s) => s.sessionId),
  ]);
  const st = listSessions({
    workspacePath,
    force,
    client: src.client,
    pluginRe: p.pluginRe,
    currentOnly: Boolean(policy.currentOnly),
    activeSessions: policy.active || [],
  });
  if (endedSessionIds.size) {
    for (const [key, session] of table) {
      if (session.floor === p.id && endedSessionIds.has(session.sessionId)) table.delete(key);
    }
  }
  const pluginSessions = (st.sessions || []).filter(
    (s) => !endedSessionIds.has(s.id) && !(typeof policy.exclude === 'function' && policy.exclude(s))
  );
  const pluginSessionIds = new Set(pluginSessions.map((s) => s.id));
  for (const [key, session] of table) {
    // Recognize "a row from the plugin structured on-disk path" by **sourceKind** —— not by source
    // (form→source; sessions scanned on the CLI path can be of plugin form too, e.g. 3F Codex shares its
    // on-disk data), otherwise they would be trimmed together.
    if (session.floor === p.id && session.sourceKind === 'plugin' && !pluginSessionIds.has(session.sessionId)) table.delete(key);
  }
  if (!pluginSessions.length) return;
  for (const s of pluginSessions) {
    if (!claim(p.id, s.id)) continue;
    upsert({
      floor: p.id,
      id: s.id,
      sessionId: s.id,
      // source = form→source (this path is the plugin's structured on-disk data, form vscode)
      source: formToSource(src.form),
      // sourceKind = which path read this row (plugin structured on-disk data): trimming / yielding rules
      // recognize it by this, do not use source
      sourceKind: 'plugin',
      form: src.form || '',
      project: s.project || '',
      projectPath: s.projectPath || '',
      mine: Boolean(s.mine),
      current: Boolean(s.current),
      // The one session on this floor that is globally "really active" (the current session of the project
      // the freshest reporter is in);
      // only it is allowed to overlay the live phase; the other current=true project current sessions only
      // use their own project's reports.
      fresh: s.id === st.current,
      live: Boolean(s.live),
      runtime: s.runtime,
      pending: s.pending || 0,
      todos: s.todos,
      files: s.files,
      phase: s.phase,
      action: s.action,
      target: s.target || '',
      tool: s.tool || '',
      context: s.context || [],
      prompt: s.prompt || '',
      // The "done" marker the reporter drops at Stop: the only true source, never guessed from the phase
      // falling back to idle.
      doneAt: s.doneAt || 0,
      doneTitle: s.doneTitle || '',
      doneCount: s.doneCount || 0,
      doneFiles: s.doneFiles || [],
      doneCancelled: Boolean(s.doneCancelled),
      inferred: Boolean(s.inferred),
      lastEventAt: s.lastUpdated || 0,
    });
  }
}

// Shared by the cli / hook paths: scan jsonl or read the reporter state file, distinguished by src.kind.
// The cli/hook sources of 1F~5F and 9F all go through here (standard shape: only file times / heartbeat
// times, no runtime state).
function handleCliHook(p, src, ctx) {
  const {
    workspacePath, table, claim, upsert, now, TIMEOUT_MS,
    scanCliSessions, listReporterSessions, doneFieldsOf, formatAge, resolveProjectName, cliLandingSessions,
  } = ctx;
  const reporterSessions = src.kind === 'cli' ? listReporterSessions(src.client, { includeEnded: true }) : [];
  const endedSessionIds = new Set(reporterSessions.filter((s) => s.endedAt).map((s) => s.sessionId));
  // The session form (cli / vscode) **is only recorded in the reporter state file**: the CLI path scans
  // jsonl and cannot tell the form (the CLI and the IDE share the same on-disk tree, e.g. 3F Codex). The
  // form is fetched back by session id for source=formToSource(form) to judge the form.
  const formBySession = new Map(reporterSessions.filter((s) => s.form).map((s) => [s.sessionId, s.form]));
  for (const [key, session] of table) {
    if (session.floor === p.id && endedSessionIds.has(session.sessionId) && ['cli', 'hook'].includes(session.sourceKind)) {
      table.delete(key);
    }
  }
  const rows =
    src.kind === 'cli'
      ? scanCliSessions(src.dataPath, { kind: p.agent }).filter((s) => !s.sessionId || !endedSessionIds.has(s.sessionId))
      : listReporterSessions(src.client).map((s) => ({
          id: s.sessionId,
          sessionId: s.sessionId,
          project: s.workspacePath ? resolveProjectName(s.workspacePath) || path.basename(s.workspacePath) : '',
          projectPath: s.workspacePath,
          form: s.form || '',
          lastEventAt: s.lastEventAt,
        }));
  // The criterion has to be "this path scanned a session that is **still alive**", not "scanned any row"
  // (same TIMEOUT_MS yardstick as prune / snapshot).
  // It also needs a **session id** to be listed: phases / done markers / ledger attribution all go by
  // session, and a row without an id cannot participate in any of those chains
  // (listing it used to rely only on the "take the newest by client" fallback, which is exactly what messed
  // the state up).
  const live = rows
    .filter((r) => now - (Number(r.lastEventAt) || 0) < TIMEOUT_MS)
    .filter((r) => r.sessionId);
  // The CLI JSONL and the hook may describe the same session: dedup by real sessionId only; when the cli
  // path scans a live session, withdraw the old hook row.
  if (src.kind === 'cli' && live.length) {
    const ids = new Set(live.map((s) => s.sessionId).filter(Boolean));
    cliLandingSessions.set(p.id, ids);
    for (const sessionId of ids) {
      const oldHookKey = `${p.id}:${sessionId}`;
      const oldHook = table.get(oldHookKey);
      if (oldHook && oldHook.sourceKind === 'hook') table.delete(oldHookKey);
    }
  }
  for (const s of live) {
    const sessionId = s.sessionId || '';
    if (src.kind === 'hook' && sessionId && cliLandingSessions.get(p.id)?.has(sessionId)) continue;
    if (!claim(p.id, sessionId)) continue;
    const lastEventAt = s.lastEventAt;
    const form = s.form || formBySession.get(sessionId) || '';
    upsert({
      floor: p.id,
      id: s.id,
      sessionId,
      // source derived from form: the three shapes plugin/CLI/IDE, empty form counts as CLI
      source: formToSource(form),
      /** which path exactly read this row (cli / hook): lets the "jsonl first" rule withdraw old hook rows */
      sourceKind: src.kind,
      form,
      project: s.project,
      projectPath: s.projectPath,
      mine: Boolean(workspacePath && s.projectPath && path.resolve(s.projectPath) === path.resolve(workspacePath)),
      current: false,
      live: true,
      // The phase is not fabricated here (project iron rule: never fabricate) —— the live phase is pulled
      // separately by the /reporter-phase fast polling.
      phase: 'unreported',
      action: '',
      context: src.kind === 'cli' ? [`会话文件${formatAge(now - lastEventAt)}（本层未接 hook，不推断动作）`] : [],
      inferred: true,
      // The done marker only recognizes **this path's own client** (see the notes in refresh).
      ...doneFieldsOf(s.projectPath, src.client, sessionId),
      lastEventAt,
    });
  }
}

/**
 * Table of standard source branches: the key is the source kind. A floor file may override any of them
 * with its own kindHandlers (see kilo.js / opencode.js / qoder.js). 'dir' produces no sessions and is
 * already skipped early in refresh.
 */
const DEFAULT_KIND_HANDLERS = {
  plugin: handlePlugin,
  cli: handleCliHook,
  hook: handleCliHook,
};

/**
 * The dedup key includes taskStartedAt (at), so one round is only re-emitted once; a new round (at changed)
 * is emitted again as usual.
 * @param {Map<string, {cancels?: Array}>} doneScans
 * @param {number} now
 */
const postedCancels = new Map(); // key -> expiry timestamp (avoids repeated re-emission while the process lives)
function flushSynthesizedCancels(doneScans, now) {
  const { bus, repo } = backend || {};
  if (!bus || typeof bus.endTask !== 'function') return;
  for (const scan of doneScans.values()) {
    for (const c of scan.cancels || []) {
      // taskId may be empty (Trae: the cancel signal comes from renderer.log, while the hook state file's
      // taskId is always the new round's).
      // cancelAt participates in the dedup key so the same cancel is not re-emitted repeatedly.
      const key = `${c.sessionId}|${c.taskId || ''}|${c.workspacePath}|${c.at}`;
      if (postedCancels.get(key) > now) continue;
      let task = null;
      if (c.taskId) {
        // Claude / Qoder / CodeBuddy plugin: taskId is directly available (the hook state file stores the
        // cancelled round's)
        task = repo && repo.getTask ? repo.getTask.get(c.taskId) : null;
      }
      if (!task && repo && repo.listStaleRunningBySession && c.sessionId) {
        // Trae: taskId is empty, so find in task_runs the one in this session that started before cancelAt
        // and is still hanging on running (that is the cancelled previous round; the new round's startedAt
        // > cancelAt, so it is never taken by mistake). Take the newest by started_at DESC.
        const proj = repo.getProjectByWorkspace ? repo.getProjectByWorkspace.get(path.resolve(c.workspacePath || '')) : null;
        if (proj) {
          const all = repo.listStaleRunningBySession.all(proj.id, c.sessionId);
          const atC = Number(c.at) || 0;
          // The most recently started one <= cancelAt —— that is the cancelled one
          const match = all
            .filter((r) => Number(r.startedAt) && (!atC || Number(r.startedAt) <= atC))
            .sort((a, b) => Number(b.startedAt) - Number(a.startedAt))[0];
          if (match) task = repo.getTask ? repo.getTask.get(match.id) : null;
        }
      }
      if (!task) continue;
      postedCancels.set(key, now + 10 * 60_000);
      try {
        bus.endTask({
          project: task.project_id,
          memberId: task.member_id,
          taskId: task.id,
          state: 'cancelled',
          model: '',
          result: String(c.result || ''),
          files: Array.isArray(c.files) ? c.files : [],
          fileCount: Number.isFinite(Number(c.fileCount)) ? Number(c.fileCount) : (Array.isArray(c.files) ? c.files.length : 0),
          form: c.form || '',
          sessionId: c.sessionId,
          ts: c.at,
        });
      } catch {
        /* a failed re-emission does not affect the session table */
      }
    }
  }
  for (const [k, v] of postedCancels) if (v <= now) postedCancels.delete(k);
}

/**
 * Retire **the previous round pushed out by the new one**: tasks in the same session that started earlier
 * than "the current round" yet are still hanging on running.
 *
 * The criterion is hard: one session cannot run two rounds at once. The reason it is still hanging is that
 * this round's end event will never arrive —— the CodeBuddy plugin emits not one hook event when stopping,
 * and the hook's state file is one per **session**, so the new round's /task/start overwrites taskId /
 * taskStartedAt wholesale, and the previous round cannot even be reached by the fallback scan (cancels
 * above, which only recognize the "current" taskId in the state file), so it stays "in progress" forever.
 * What the user sees: cancelled the task → the screen still says "in progress" while the main console is
 * already "standby".
 *
 * Division of labor with flushSynthesizedCancels: that one relies on the on-disk signal of "the user
 * really pressed stop" (the earlier the better, it lights up right at the cancel); this one is a hard
 * fallback that **depends on no product signal** —— a previous round that got pushed out has to be wrapped
 * up whether it was cut short or its event was lost.
 * @param {Map<string, {rounds?: Array}>} doneScans key is `${project path}|${client}`
 */
function flushSupersededTasks(doneScans) {
  const { bus, repo } = backend || {};
  if (!bus || typeof bus.endStaleTasksOfSession !== 'function' || !repo) return;
  for (const [key, scan] of doneScans) {
    const ws = String(key || '').split('|')[0];
    if (!ws || !scan.rounds || !scan.rounds.length) continue;
    // The project id can only be swapped from the path: bus takes a project id (`<name>@<project id>`),
    // passing a path would compute a member that does not exist
    const proj = repo.getProjectByWorkspace ? repo.getProjectByWorkspace.get(path.resolve(ws)) : null;
    if (!proj) continue;
    for (const r of scan.rounds) {
      if (!r.sessionId || !Number(r.taskStartedAt)) continue;
      try {
        // excludeTaskId = the current round's own taskId: the sweep only retires "the previous round that
        // got pushed out",
        // it must never retire the current round the state file points at (a double safeguard alongside the
        // startedAt >= ts boundary).
        bus.endStaleTasksOfSession({ project: proj.id, sessionId: r.sessionId, ts: Number(r.taskStartedAt), excludeTaskId: r.taskId || '', client: r.client });
      } catch {
        /* a failed ledger re-emission does not affect the session table */
      }
    }
  }
}

function snapshot({ workspacePath = '', force = false } = {}) {
  refresh({ workspacePath, force });
  const now = Date.now();

  const products = detectProducts({});
  const repo = backend && backend.repo;
  // The title comes from the ledger's tasks.title (the user's own sentence, the render layer does not lose
  // it) —— taken for all running tasks, with a wide window, used as copy only and not affecting the judgment.
  // It also picks up tasks.started_at along the way (when the task really started); the ticker's time uses
  // that rather than "now".
  const runningTitleBySession = new Map();
  const runningStartedBySession = new Map();
  // Detection uses "living" floors: state='running' in the ledger and **heartbeat/agent_status alive**
  // (non-sticky judgment).
  // Key point: @fresh is set into the future here, turning off the started_at fallback window in the query
  // entirely ——
  // that window is the root of "hangs for 3h / resurrects on restart" (a stopped plugin task stays running
  // in the ledger, and started_at being recent gets it claimed again).
  // With it off only the heartbeat-alive judgment remains, so stopped tasks (no heartbeat) drop out at once
  // and do not resurrect on restart.
  // Plugin tasks write no heartbeat → claimed as a fallback by the "live phase is fresh" signal below; the
  // two are unioned so neither misses.
  const ledgerAliveSessions = new Set();
  if (repo && repo.activeRunningByProject) {
    const cutoff = now - 10 * 60 * 1000;
    const grace = now - 30 * 60 * 1000;
    let titleRows = [];
    let detectRows = [];
    try {
      // Title / start time: taken for all running tasks (wide window, copy and timestamp only, not part of
      // the "running" judgment)
      titleRows = repo.activeRunningByProject.all({ projectId: 0, fresh: now - 3 * 60 * 60 * 1000, cutoff, grace }) || [];
      // Detection: @fresh into the future → the started_at clause is always false, leaving only the
      // non-sticky "heartbeat/agent_status alive" judgment
      detectRows = repo.activeRunningByProject.all({ projectId: 0, fresh: now + 1e15, cutoff, grace }) || [];
    } catch (e) {
      // A ledger query exception does not affect building the session table, but it must leave a trace ——
      // otherwise "no data in the task table / ticker" can only be guessed at
      log.debug('账本查询异常（不影响会话表构建）：', e);
    }
    for (const r of titleRows) {
      const f = floorByAgent[String(r.client || '').toLowerCase()];
      const sessionId = String(r.sessionId || '');
      const fid = floorIdOf(f);
      if (!fid || !sessionId) continue;
      const key = `${fid}:${sessionId}`;
      if (r.title && !runningTitleBySession.has(key)) runningTitleBySession.set(key, r.title);
      if (r.startedAt && !runningStartedBySession.has(key)) runningStartedBySession.set(key, Number(r.startedAt));
    }
    for (const r of detectRows) {
      const f = floorByAgent[String(r.client || '').toLowerCase()];
      const sessionId = String(r.sessionId || '');
      const fid = floorIdOf(f);
      if (fid && sessionId) ledgerAliveSessions.add(`${fid}:${sessionId}`);
    }
  } else {
    /* skip the ledger signal when repo/activeRunningByProject is missing (old behavior) */
  }
  // "Running" only recognizes the ledger's ALIVE (the same yardstick as the task table's taskAliveSql:
  // state='running' with a recent heartbeat / active state).
  // "Session live phase is fresh" was once counted as a running signal too, but measured behavior shows the
  // plugin replays the previous task's phase as thinking on reconnect/restart and refreshes its timestamp,
  // so an already cancelled old task was misjudged as running and fought with the task table (which judges
  // by ALIVE). Removing it aligns both criteria —— whatever the task table shows as "cancelled", the
  // ticker / main console will never show as "in progress" again.
  const floors = products.map((p) => {
    const sessions = [...table.values()]
      .filter((s) => s.floor === p.id && s.active)
      .sort((a, b) => {
        if (a.mine !== b.mine) return a.mine ? -1 : 1;
        return b.lastEventAt - a.lastEventAt;
      })
      .map((s) => {
        // taskState must follow the selected session's attribution: the same floor can have several CLI /
        // Plugin sessions at once,
        // and one of them having a running task must not mark every session on the floor as running.
        const sessionKey = `${s.floor}:${String(s.sessionId || '')}`;
        let taskState;
        if (s.sessionId && ledgerAliveSessions.has(sessionKey)) taskState = 'running';
        // End state: the doneAt the reporter dropped, and (1) it must have happened **after this process
        // started** (after a restart an old doneAt is not recognized, otherwise the previous round's "task
        // cancelled/finished" resurrects); (2) this session has had no new activity recently (within 10s)
        // —— when a new round is just starting the old doneAt is still hanging and the phase has no time to
        // refresh, so recognizing it directly would flash "task cancelled" and then jump back to
        // "thinking"; hence any recent movement in the session (a new task is already running) suppresses
        // the old end state.
        else if (s.doneAt && s.doneAt > SINCE_BOOT && now - (Number(s.lastEventAt) || 0) > 10_000) taskState = s.doneCancelled ? 'cancelled' : 'done';
        else taskState = null;
        // A running task uses the ledger title (tasks.title = the user's sentence) as its copy —— it does
        // not depend on the session's often-empty prompt;
        // it also carries when the task really started (tasks.started_at), and the ticker time uses that
        // rather than "now".
        const taskTitle = taskState === 'running' ? runningTitleBySession.get(sessionKey) || '' : '';
        const taskStartedAt = taskState === 'running' ? Number(runningStartedBySession.get(sessionKey) || 0) : 0;
        const row = { ...s, taskState, taskTitle, taskStartedAt };
        // Snapshot backfill (see sessions.reporterSnapshotPhase): a CLI / Hook row is listed with
        // phase 'unreported' — that path never fabricates a phase — but the reporter state file does hold
        // this session's live phase. Fill it here so a **non-selected** session shows the truth too; the
        // rolling ticker resolves its phase suffix from this snapshot (TaskTicker's phaseOfTask), and
        // without this it could only ever fall back to "thinking" for hook floors (never "awaiting
        // authorization"). Unresolvable (no hook installed / stale phase / no session id) stays
        // 'unreported' — never fabricate.
        if (row.phase === 'unreported' && row.sessionId) {
          const client = String((p.clients && p.clients[0]) || p.dataKind || '');
          const ws = freshestReporterWs(row.projectPath || workspacePath || '', client, row.sessionId);
          const rp = reporterSnapshotPhase(ws, client, row.sessionId);
          if (rp && rp.phase) {
            row.phase = rp.phase;
            row.action = rp.action || '';
            row.target = rp.target || '';
            row.context = Array.isArray(rp.context) ? rp.context : [];
            row.tool = rp.tool || '';
            row.prompt = rp.prompt || '';
            row.inferred = false; // the reporter hook / plugin wrote it: reported truth, not an inference
          }
        }
        return row;
      });
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      // Which client this floor monitors (codebuddy / workbuddy / codex / claude) ——
      // the office filters members by it, so switching to 3F should not show CodeBuddy's gremlins anymore
      // (member filtering recognizes by **agent base name**, see floorAcceptsClient in
      // renderer/src/lib/clientMatch.js)
      client: p.dataKind || '',
      // The clients this floor accepts (= the floor base name, e.g. 1F's ['codebuddy']):
      // the frontend filters the live phase (/reporter-phase?client=codebuddy) and the floor attribution in
      // task records by it
      clients: p.clients && p.clients.length ? p.clients : p.dataKind ? [p.dataKind] : [],
      installed: Boolean(p.installed),
      installPathLabel: p.installPathLabel || '',
      // Per-form install location list (one each for CLI / plugin, see detectOne in products.js):
      // the floor capsule tooltip shows "installed CLI / installed plugin" line by line from it.
      // **It must be passed through explicitly** ——
      // only selected fields are sent here, and missing it means the frontend cannot get it and falls back
      // to the single-line fallback, swallowing the merged floor's (1F CodeBuddy) plugin extension directory.
      installPaths: Array.isArray(p.installPaths) ? p.installPaths : [],
      dataPathLabel: p.dataPathLabel || '',
      stats: p.stats || null,
      // On-disk sources (several for merged floors, including each path's on-disk directory and stats) ——
      // the floor tooltip shows them path by path
      sources: (p.sources || []).map((s) => ({
        kind: s.kind,
        // Display name ('IDE' / 'plugin' …): two paths can share a kind (5F's IDE and plugin are both 'dir')
        label: s.label || '',
        // Whether this path produces sessions: false = on-disk display only (the tooltip explains "no
        // sessions can be read")
        sessions: s.sessions !== false,
        client: s.client,
        dataPathLabel: s.dataPathLabel || '',
        stats: s.stats || null,
        // Explanation when this path cannot read sessions (e.g. TraeCode's plugin on-disk data has no
        // session index) ——
        // the frontend tooltip shows it so "no data" and "cannot read" stay distinguishable
        note: s.note || '',
      })),
      /** How many active sessions this floor has —— the left status dot's green/gray follows it */
      activeCount: sessions.length,
      sessions,
    };
  });

  const sessions = floors.flatMap((f) => f.sessions);
  // Default floor: prefer a floor with active sessions; if none, fall back to an installed one; if none
  // again, the first floor
  const hot = floors.find((f) => f.activeCount > 0);
  const on = floors.find((f) => f.installed);
  const pick = hot || on || floors[0];
  const defaultFloor = pick ? pick.id : '1F';

  return {
    ok: true,
    floors,
    sessions,
    /** A fallback floor when there are no active sessions: the office still shows, only the dropdown is empty */
    defaultFloor,
    workspacePath,
    timeoutMs: TIMEOUT_MS,
    updatedAt: now,
    ...(sessions.length ? {} : { reason: 'no-open-project' }),
  };
}

module.exports = { snapshot, refresh, prune, TIMEOUT_MS, table, setBackend, scanCliSessions, liveSessionCwds };
