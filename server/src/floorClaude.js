'use strict';

/**
 * 4F Claude Code (CLI and IDE merged floor).
 *
 * The CLI and the IDE plugin share the same ~/.claude config, the same set of hooks and the same
 * on-disk directory, and cannot be told apart, so they are merged into a single floor (see the header
 * of server/src/products.js). There is only one cli source (both the CLI and Plugin forms are
 * represented by it). Standard sources are handled by the sessionRegistry default handler; this file
 * only declares metadata.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const {} = require('@workgremlin/shared');
// Generic fault-tolerant file reads (readJson / readDir) all come from roots, avoiding duplicate
// definitions everywhere
const { readJson, readDir, isFile } = require('./roots');
// Static subagent directories (project-level / user-level): private knowledge of this floor, kept here
// rather than in the central agentLevel
const { genericAgentDirs, makeAgentSync } = require('./ingest/agentLevel');

const HOME = os.homedir();

/**
 * Claude Code's config root —— config, hooks (settings.json) and session data (projects/) all live
 * under it. Honors CLAUDE_CONFIG_DIR (the hook-installing side already did; the data-locating side
 * has to as well, otherwise hardcoding ~/.claude skews results).
 * This is 4F's own private directory knowledge, kept in this file rather than a central module.
 */
function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
}

/**
 * 4F static subagent definition directories: project-level <ws>/.claude/agents and user-level
 * <claudeHome()>/agents.
 * Returns [{ dir, level }], project level before user level.
 */
function agentDirs(workspacePath) {
  return genericAgentDirs([claudeHome()], workspacePath);
}

/* ------------------------------ Interrupt detection ------------------------------ */

/** Transcript tail read window: interrupt markers are always written at the end, so long sessions need not be read in full */
const TRANSCRIPT_TAIL_BYTES = 128 * 1024;

/**
 * Transcript file cache: path -> {m, size, sinceTs, res}
 * Incremented by mtime+size+sinceTs; an unchanged file is never re-read.
 */
const _claudeTailCache = new Map();

/**
 * The **tail window** of a Claude / Qoder style transcript: whether this round was interrupted by the
 * user, and what it last said before the interrupt.
 *
 * Why the server has to judge this: after the user presses "stop", these two products (measured
 * 2026-09-29 on 4F Claude Code's VS Code extension form) emit **not a single hook event** —— Stop /
 * SessionEnd / Notification are all absent from events.log, the event stream stops at the last
 * PostToolUse, so the hook side's `turnInterrupted` (which runs in the Stop branch) never gets a
 * chance to execute. The only authoritative trace is that trailing user message in the transcript
 * `[Request interrupted by user]` (a mid-tool interrupt carries the ` for tool use` suffix).
 *
 * How it reads: only the **last 128KB** of the file (markers are always written at the end, so long
 * sessions need not be read in full), cached by mtime+size+sinceTs, so once the marker lands each file
 * is parsed only once. Judgment is structural via line-by-line `JSON.parse` (`type:'user'` with body
 * text hitting the marker); the same string inside tool results or thinking never counts.
 *
 * @param {string} transcriptPath
 * @param {number} sinceTs start time of this round (0 = no filtering): only markers from this round
 *   count, ones from earlier rounds do not
 * @returns {{interrupted:boolean, said:string, at:number}}
 */
function claudeInterruptTail(transcriptPath, sinceTs = 0) {
  const miss = { interrupted: false, said: '', at: 0 };
  if (!transcriptPath || !isFile(transcriptPath)) return miss;
  let stat = null;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return miss;
  }
  const cached = _claudeTailCache.get(transcriptPath);
  if (cached && cached.m === stat.mtimeMs && cached.size === stat.size && cached.sinceTs === sinceTs) {
    return cached.res;
  }
  let raw = '';
  try {
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
    const len = stat.size - start;
    if (len <= 0) return miss;
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      raw = buf.toString('utf8');
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* failing to close does not affect this read */
      }
    }
  } catch {
    return miss;
  }
  let interrupted = false;
  let said = '';
  let at = 0;
  for (const line of raw.split(/\r?\n/)) {
    // Cheap check first: skip lines with neither the keyword nor a candidate assistant body (the first
    // line of the tail is usually truncated and fails to parse)
    if (!line || !/interrupted|"role"\s*:\s*"assistant"/.test(line)) continue;
    let o = null;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    const ts = Date.parse(String(o.timestamp || '')) || 0;
    if (sinceTs && ts && ts < sinceTs) continue;
    const msg = o.message && typeof o.message === 'object' ? o.message : null;
    const content = msg ? msg.content : o.content;
    const texts =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
          ? content
              .filter((x) => x && (x.type === 'text' || x.type === 'output_text') && typeof x.text === 'string')
              .map((x) => x.text)
          : [];
    if (!texts.length) continue;
    // Interrupt marker: a user message whose body (a text part, not tool_result) is exactly
    // [Request interrupted by user]
    if (o.type === 'user' && texts.some((t) => /^\s*\[?request interrupted by user/i.test(String(t)))) {
      interrupted = true;
      if (ts) at = Math.max(at, ts);
      continue;
    }
    const role = String((msg && msg.role) || o.role || '');
    if (role === 'assistant') {
      const txt = texts.join('\n').trim();
      if (txt) said = txt; // take the last stretch (overwriting earlier ones)
    }
  }
  const res = { interrupted, said, at };
  _claudeTailCache.set(transcriptPath, { m: stat.mtimeMs, size: stat.size, sinceTs, res });
  return res;
}

/**
 * Claude Code's own **session state file**: `<claudeHome>/sessions/<pid>.json`, one file per running
 * CLI process. Fields as measured (2026-09-29, 2.1.281/2.1.283):
 *   { pid, sessionId, cwd, startedAt, kind:'interactive', entrypoint:'cli'|'claude-vscode',
 *     status:'busy'|'idle', updatedAt, statusUpdatedAt }
 *
 * **This is an undocumented internal Claude Code file** (the user explicitly agreed on 2026-09-29 to
 * use it as a fallback), its format may change at any time —— so unreadable / missing fields / parse
 * failures all mean "absent", never guess; and match strictly **by sessionId**.
 * Key measurement: **it stops refreshing while idle** (statusUpdatedAt stays frozen at the moment it
 * flipped to idle), which makes it exactly the timestamp of "when this round ended"; conversely
 * status='busy' means it is generating right now.
 *
 * Directory listing cached 2s, files cached by (mtime,size) —— every scan cycle asks several times, do
 * not re-read each time.
 * @param {string} sessionId
 * @returns {{status:string, statusUpdatedAt:number, updatedAt:number, pid:number, entrypoint:string, kind:string}|null}
 */
const _claudeSessFiles = { at: 0, names: [] };
const _claudeSessData = new Map(); // path -> {m, size, data}
function claudeSessionStatus(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return null;
  const dir = path.join(claudeHome(), 'sessions');
  const now = Date.now();
  if (now - _claudeSessFiles.at > 2_000) {
    _claudeSessFiles.names = readDir(dir).filter((n) => /\.json$/i.test(n));
    _claudeSessFiles.at = now;
  }
  let best = null;
  for (const name of _claudeSessFiles.names) {
    const p = path.join(dir, name);
    let stat = null;
    try {
      stat = fs.statSync(p);
    } catch {
      continue; // the file may be deleted when the process exits: skip, do not guess
    }
    const cached = _claudeSessData.get(p);
    let data = cached && cached.m === stat.mtimeMs && cached.size === stat.size ? cached.data : null;
    if (!data) {
      data = readJson(p);
      _claudeSessData.set(p, { m: stat.mtimeMs, size: stat.size, data });
    }
    if (!data || String(data.sessionId || '') !== sid) continue;
    // The same sessionId can exist in several copies (leftovers of old processes) → keep the newest by
    // updatedAt
    if (!best || Number(data.updatedAt || 0) > Number(best.updatedAt || 0)) best = data;
  }
  return best;
}

/** Round-start grace: right after submitting, the CLI may still say idle; without this grace a normal round gets misjudged as cancelled */
const CLAUDE_IDLE_GRACE_MS = 3_000;

/**
 * Whether this round (state file `j`) was interrupted by the user; if so, give the **interrupt time**.
 *
 * Two signals (both fallbacks on the "pressed stop yet emitted not one hook event" path), first hit
 * wins:
 *   ① `claudeInterruptTail`: that trailing `[Request interrupted by user]` in the transcript
 *      —— written by both the CLI and the IDE extension when interrupting while the model has already
 *      spoken or a tool is running;
 *   ② `~/.claude/sessions/<pid>.json` saying `status='idle'` with statusUpdatedAt later than this
 *      round's start
 *      —— "pressed ESC right after submitting, before the model uttered a word": the transcript gets
 *         **not one line** and hooks emit **not one event**, so this is the only place it shows
 *         (added 2026-09-29; the user explicitly agreed to use this undocumented file).
 *         ⚠ Only trusted once "this round has been running ≥ CLAUDE_IDLE_GRACE_MS": at the very instant
 *         a round starts the CLI may still say idle (not yet flipped to busy), and without the grace a
 *         freshly submitted normal round gets misjudged as cancelled.
 *      The cancel time is statusUpdatedAt (**not "now" impersonating it**).
 *
 * One more hard prerequisite: this round has **no wrap-up marker** (`j.done` earlier than this round's
 * start = leftover from the previous round, does not count).
 * @param {any} j reporter state file contents
 * @param {number} startedAt start time of this round
 * @returns {{hit:boolean, at:number, via:'transcript'|'idle'|''}} at=0 means the interrupt holds but no time is available
 */
function claudeInterruptOf(j, startedAt) {
  const none = { hit: false, at: 0, via: '' };
  if (!j) return none;
  // client now describes only the form (cli / vscode); the floor is guaranteed by the caller (the
  // claude/qoder reader)
  const started = Number(startedAt) || 0;
  const doneAt = Number(j.done && j.done.at) || 0;
  if (doneAt && (!started || doneAt >= started)) return none; // this round already wrapped up normally
  const ci = claudeInterruptTail(j.transcriptPath, started);
  if (ci.interrupted) return { hit: true, at: Number(ci.at) || 0, via: 'transcript' };
  const st = claudeSessionStatus(j.sessionId);
  if (!st || String(st.status) !== 'idle') return none;
  const at = Number(st.statusUpdatedAt || st.updatedAt) || 0;
  if (!at || !started || at < started) return none; // idle was flipped before this round started → that round has not ended
  if (Date.now() - started < CLAUDE_IDLE_GRACE_MS) return none; // just started, do not misfire
  return { hit: true, at, via: 'idle' };
}

/* ------------------------------ Current model (selectedModelOf) ------------------------------ */

/**
 * Claude Code's "session → current model" completion.
 *
 * Why it lives in this file (rather than a separate claudeModels.js): same structure as trae.js ——
 * this chunk is "how to read one product's private on-disk format", and what it reads is exactly the
 * same transcript that interrupt detection in claude.js also reads
 * (`<claudeHome>/projects/<slug>/<session>.jsonl`), so keeping them together reads best; a separate
 * file would split parsing of the same format in two.
 *
 * Why it has to be fished out of disk: **Claude Code's hook payload has no model field**. Decompiling
 * the CLI binary showed the payload schema: UserPromptSubmit carries only prompt / source /
 * session_title, PreToolUse / PostToolUse only tool fields; the common prefix is session_id /
 * transcript_path / cwd / permission_mode / prompt_id / agent_id / agent_type / effort —— none of them
 * model. Only SessionStart carries an optional model, which still cannot tell "which model this round
 * used". So the model reported by the reporter is structurally always an empty string for Claude (see
 * packages/reporter/src/hook.js), and filling that column means the server reading the transcript and
 * completing it itself.
 *
 * Where the truth is: `<claudeHome>/projects/<project slug>/<session_id>.jsonl`, where every assistant
 * line carries `message.model` (measured values look like `deepseek-flash`). Take the last one, i.e.
 * "the model in effect when this turn started".
 *
 * Anything unavailable (not installed / no such session / not a single assistant line yet) returns an
 * empty string —— never pass the default model off as the answer (if this session has not replied yet,
 * say "do not know", not "it is using the default model").
 */

/** Tail window starts at 64KB and quadruples when nothing is found; capped at 1MB (longest measured line locally: 117KB, so 1MB covers it) */
const TAIL_START = 64 * 1024;
const TAIL_MAX = 1024 * 1024;

/** One level of project directories under projects: do not readdir on every call */
const DIR_TTL_MS = 30_000;
let dirCache = { at: 0, dirs: null };

/** Session -> model: the hot path (the UI polls readReporterPhase every 1.5s and it has no cache of its own) relies entirely on this cache */
const MODEL_TTL_MS = 15_000;
const CACHE_MAX = 200;
const modelCache = new Map();

/**
 * Whether a session id can be used as a file name.
 * It comes from HTTP's `?session=` and hook payloads, i.e. **external input**: without validation
 * `../../` could escape the projects directory and read arbitrary files. The real value is a UUID, so
 * only a conservative character set is accepted here.
 */
function safeSessionId(id) {
  const s = String(id == null ? '' : id).trim();
  if (!s || s.length > 128) return '';
  if (s.includes('..') || s.includes('/') || s.includes('\\')) return '';
  return /^[A-Za-z0-9._-]+$/.test(s) ? s : '';
}

/** One level of project directories under `<claudeHome>/projects` */
function projectDirs() {
  const now = Date.now();
  if (dirCache.dirs && now - dirCache.at < DIR_TTL_MS) return dirCache.dirs;
  const root = path.join(claudeHome(), 'projects');
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    // not installed / never run: treat this round as "none" and let the upper layer leave it empty
  }
  dirCache = { at: now, dirs };
  return dirs;
}

/**
 * Absolute path of this session's transcript; empty string when not found.
 * The session id is the file name (header of products.js: three measured locations agree 100%), so all
 * that is needed is looking for a same-named file inside the project directories.
 */
function transcriptOf(sessionId) {
  const name = `${sessionId}.jsonl`;
  for (const d of projectDirs()) {
    const p = path.join(d, name);
    try {
      if (isFile(p)) return p;
    } catch {
      // this project directory has no such session; check the next one
    }
  }
  return '';
}

/**
 * Walk backwards from the end of the file to find "the last assistant's model".
 *
 * Why read backwards instead of sequentially: transcripts run hundreds of KB to tens of MB while this
 * function sits on a polling hot path. Assistant lines are dense, so 64KB at the tail almost always
 * catches one; the window only quadruples on very long lines, and it is capped so the whole file is
 * never read (cwdOfHead is its mirror, same reasoning —— see sessionRegistry.js).
 *
 * This is "decode the whole window + parse line by line in reverse", not "stitch chunks backwards": the
 * window is read once, and when the window does not start at the file head, the fragment before the
 * first newline is dropped —— the only thing a multibyte character can have split is that fragment, so
 * every decoded line is complete (0x0a never occurs inside a multibyte sequence).
 *
 * @param {string} file transcript path
 * @returns {{model: string, mtimeMs: number, size: number}|null} null when it cannot be opened
 */
function tailModel(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    // fstat rather than statSync: it gives the size/time **on this fd**, i.e. the same inode the
    // positional reads below hit. On rename rotation the fd still points at the consistent (if stale)
    // copy; on truncation the read returns n <= 0.
    const st = fs.fstatSync(fd);
    const size = st.size;
    if (!size) return { model: '', mtimeMs: st.mtimeMs, size };
    for (let win = TAIL_START; win <= TAIL_MAX; win *= 4) {
      const start = Math.max(0, size - win);
      const len = size - start;
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, start);
      // Fewer bytes read than expected = the file is being truncated / rotated: better to say
      // "unrecognized" than parse a half window
      if (n < len) return { model: '', mtimeMs: st.mtimeMs, size };
      let text = buf.toString('utf8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line) continue;
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          // truncated / half-written / non-JSON: skip and keep looking backwards (no regex rescue, that
          // could fish a fake model out of a tool_result)
          continue;
        }
        if (!j || j.type !== 'assistant') continue;
        // Subagent turns (older formats inline them in the parent file) are not this session's model
        if (j.isSidechain === true) continue;
        const m = j.message && j.message.model;
        if (typeof m === 'string' && m.trim()) return { model: m.trim(), mtimeMs: st.mtimeMs, size };
      }
      if (start === 0) break; // reached the head of the file; absent means absent
    }
    return { model: '', mtimeMs: st.mtimeMs, size };
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* failing to close does not affect what was already read */
    }
  }
}

/**
 * Which model this Claude Code session is using.
 * @param {string} sessionId the hook payload's session_id (also the transcript's file name)
 * @param {string} [_agentType] kept for the same signature as trae.selectedModelOf; Claude does not use it
 * @returns {string} empty string when unavailable
 */
function selectedModelOf(sessionId, _agentType = '') {
  const sid = safeSessionId(sessionId);
  if (!sid) return '';
  const now = Date.now();

  // Cache first: on a hit, stat the file from last time directly with **no directory scan** (for a user
  // with dozens of projects, one scan stats dozens of directories and costs more than actually reading
  // the tail). Nothing is even read while the file is untouched.
  const hit = modelCache.get(sid);
  if (hit && now - hit.at < MODEL_TTL_MS) {
    if (!hit.file) return ''; // this session was not found last time —— do not rescan repeatedly
    try {
      const st = fs.statSync(hit.file);
      if (st.mtimeMs === hit.mtimeMs && st.size === hit.size) return hit.model;
    } catch {
      // the file is gone: look it up again below (maybe the project directory changed); if it is still
      // missing, cache the empty result too
    }
  }

  const file = transcriptOf(sid);
  const r = file ? tailModel(file) : null;
  if (modelCache.size >= CACHE_MAX) modelCache.clear();
  modelCache.set(sid, {
    file: r ? file : '',
    mtimeMs: r ? r.mtimeMs : 0,
    size: r ? r.size : 0,
    model: r ? r.model : '',
    at: now,
  });
  return r ? r.model : '';
}

/** Claude Code's VS Code extension directory name: anthropic.claude-code-<version> */
const RE_CLAUDE_HOST = [/^anthropic\.claude/i];

const meta = {
  id: '4F',
  name: 'Claude Code',
  kind: 'cli',
  cmd: 'claude',
  agent: 'claude',
  plugin: false,
  // Someone who only installed the IDE extension still counts as "installed" here; altPluginRe picks up
  // that install evidence.
  altPluginRe: RE_CLAUDE_HOST,
  sources: [{ kind: 'cli', label: 'CLI/Plugin' }],
  dataKind: 'claude',
  // On-disk detection (used by findDataPath)
  matchRe: [/^claude/i],
  homeDirs: [claudeHome()],
  // CLI session files land under <dataRoot>/projects/<project>/, named after session_id
  sessionSubtree: 'projects',
  sessionIdOfFile: (name) => String(name).replace(/\.jsonl$/i, ''),
};

/**
 * Whether this "running" reporter phase is voided by this floor's cancel / interrupt marker.
 * The user pressed stop yet hooks emitted no event at all (Claude Code / Qoder, see claude.interruptTail):
 * if the trailing `[Request interrupted by user]` (or ~/.claude/sessions saying idle) is newer than this
 * phase, the phase is void —— otherwise the cancel marker lights up and a stale phase immediately feeds
 * it back into "thinking / calling tool".
 * Called by readReporterPhase in sessions.js through dispatch (common phase reading only dispatches;
 * interrupt knowledge belongs to this floor).
 * @param {object} j hook state file
 * @param {object} sp sessionPhase inside the state file
 * @param {number} slack phase timestamp tolerance (ms)
 */
function phaseSuperseded(j, sp, slack = 1_000) {
  const iv = claudeInterruptOf(j, Number(j.taskStartedAt) || 0);
  return iv.hit && (!iv.at || iv.at + slack >= Number(sp.ts || 0));
}

/* ============================================================== Hook events (server-side disk parsing) */

/**
 * The server reads Claude's JSONL transcript and takes this round's AI replies (after the last user
 * line). Same criterion as hookCommon.jsonlReplies (Claude/Codex share the JSONL shape); the export
 * name is kept for backwards compatibility.
 * @param {string} transcriptPath
 * @returns {Array<{id: string, text: string}>}
 */
function readClaudeReplies(transcriptPath) {
  return jsonlReplies(transcriptPath);
}

/**
 * Server-side hook event handling (raw events forwarded by the CLI hook).
 *
 * Disk parsing belongs entirely to the server: this file provides only Claude's "disk differences"
 * (reply parsing / interrupt detection / form detection), while event gating and the common
 * file/token/ghost logic are delegated to hookCommon.runHookEvent. Session state is held by the
 * dispatcher keyed by sessionId (replacing the hook's state file).
 */
const {
  runHookEvent,
  sharedHookImpl,
  jsonlReplies,
  headJsonLines,
  isSubagentEvent,
  resultOfResponse,
} = require('./ingest/hookCommon');

/** Claude's form this round (cli / plugin): read the entrypoint at the head of the transcript */
function claudeForm(transcriptPath) {
  for (const obj of headJsonLines(transcriptPath)) {
    const ep = obj && typeof obj.entrypoint === 'string' ? obj.entrypoint.trim().toLowerCase() : '';
    if (!ep) continue;
    if (ep === 'claude-vscode') return 'vscode';
    return ep === 'cli' ? 'cli' : '';
  }
  return '';
}

/**
 * Detect Claude's asynchronous Agent launch receipt. Async subagents keep running after the spawning
 * tool call returns, so this receipt binds the child id instead of closing the ghost.
 */
function claudeLaunchOf(ev) {
  const response = ev && ev.tool_response;
  const candidates = response && typeof response === 'object'
    ? [response, response.toolUseResult, response.result, response.tool_result]
    : [];
  const receipt = candidates.find(
    (r) => r && typeof r === 'object' && (r.isAsync === true || r.is_async === true || r.status === 'async_launched')
  );
  const text = resultOfResponse(ev);
  const asyncLaunch = Boolean(receipt) || /\bAsync agent launched\b/i.test(text) || /async_launched/i.test(text);
  if (!asyncLaunch) return null;
  const directId = receipt && (receipt.agentId || receipt.agent_id);
  const match = text.match(/agentId\s*:\s*([A-Za-z0-9_-]+)/i);
  return { agentId: String(directId || (match && match[1]) || '').trim(), background: true };
}

/** Claude differs only in how it reads its on-disk data: everything else lives in hookCommon.runHookEvent; only interfaces differing from the shared default are overridden, the rest falls back to sharedHookImpl */
const claudeImpl = {
  ...sharedHookImpl,
  hasPermissionEvent: true,
  awaitingPermission: (ev) => String((ev && ev.notification_type) || '') === 'permission_prompt',
  hasSubagentStart: false,
  // Claude subagent events carry the child agent_id while session_id remains the parent's.
  subagentEventOf: isSubagentEvent,
  subagentLaunchOf: claudeLaunchOf,
  // A Claude SubagentStop names the child id, never the spawning tool call. Only accept stops that
  // carry that identity; an old or malformed stop without it must not guess the first ledger row.
  subagentStopMatchesSpawn: (ev) => Boolean(String((ev && (ev.agent_id || ev.agentId)) || '').trim()),
  repliesOf: readClaudeReplies,
  filesSince: () => [],
  interruptedSince: (tp, since) => claudeInterruptTail(tp, since || 0).interrupted,
  formOf: (tp) => claudeForm(tp),
};
async function handleHookEvent(ev, ctx) {
  return runHookEvent(ev, ctx, claudeImpl);
}

module.exports = {
  meta, 
  RE_CLAUDE_HOST,
  claudeHome,
  // Interrupt detection (unified module-group interface: interruptOf / interruptTail / sessionStatus)
  interruptTail: claudeInterruptTail,
  sessionStatus: claudeSessionStatus,
  interruptOf: claudeInterruptOf,
  phaseSuperseded,
  CLAUDE_IDLE_GRACE_MS,
  // Current model (completed by reading the transcript; the hook payload has no model field)
  selectedModelOf,
  // Form detection (cli / plugin)
  claudeForm,
  // Static subagent dirs (project / user level): read by this floor's own syncAgents
  agentDirs,
  // Register this floor's user / project subagents with the roster (see agentLevel.makeAgentSync)
  syncAgents: makeAgentSync(agentDirs, meta.agent),
  // Cancel marker synthesis: dispatched uniformly by readReporterDones (the common code in sessions.js
  // keeps no Claude/Qoder-specific logic)
  synthMarks,
  // Server-side hook event handling (disk parsing belongs to the server): Claude dispatches through
  // hookCommon.runHookEvent
  handleHookEvent,
  readClaudeReplies,
};

/**
 * Floor-specific "cancelled" marker synthesis (shared by Claude / Qoder; both judge interrupts from the
 * transcript tail signal), dispatched uniformly by readReporterDones in sessions.js.
 *
 * After the user presses "stop", these two products emit **not a single hook event** —— the only
 * authoritative trace is that trailing `[Request interrupted by user]` (or Claude's own session state
 * file saying idle). The server recognizes it itself while polling (see claudeInterruptOf's two
 * signals), synthesizes a cancel marker, and sessionRegistry dedupes it before re-issuing
 * task/end(cancelled). No TASK_RUN_MS threshold: once the signal is there it should light up, and the
 * same round dedupes by (session, task, at) so it is re-issued only once.
 *
 * @param {object} ctx
 *   { workspacePath, client, allFiles, clientHit, roundFilesOf, synthCancel, now }
 */
function synthMarks(ctx) {
  const { workspacePath, client, allFiles, clientHit, roundFilesOf, synthCancel, now } = ctx;
  for (const j of allFiles) {
    if (!j || !j.taskId) continue;
    // client now describes only the form; the floor is guaranteed by the caller
    const startedAtJ = Number(j.taskStartedAt) || 0;
    const iv = claudeInterruptOf(j, startedAtJ);
    if (!iv.hit) continue;
    // The wrap-up self-report only exists on the transcript path (an early interrupt recognized by the
    // idle fallback never uttered a word at all)
    const ci = claudeInterruptTail(j.transcriptPath, startedAtJ);
    const id = String(j.sessionId || '');
    const ws = (j.done && j.done.workspacePath) || j.taskWorkspacePath || '';
    if (workspacePath && ws && path.resolve(ws) !== path.resolve(workspacePath)) continue;
    if (client && !clientHit(client, j.client)) continue;
    synthCancel({
      id,
      j,
      ws: ws || workspacePath || '',
      at: iv.at || Number(j.sessionPhase && j.sessionPhase.ts) || startedAtJ || now,
      files: roundFilesOf(j),
      said: String(ci.said || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      result: String(ci.said || '').trim().slice(0, 4_000),
    });
  }
}
