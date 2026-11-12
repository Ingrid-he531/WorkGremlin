'use strict';

/**
 * 10F DeepSeek Harness (dsh) floor.
 *
 * DSH is a Cordis-based agent harness. Unlike the CLI floors, its default session
 * persistence is a directory of per-session JSONL logs compressed as concatenated
 * Zstandard frames:
 *
 *   $DSH_HOME/sessions/--<normalized-cwd>--/<session-id>/session.v4.jsonl.zstd
 *
 * Two integration paths are deliberately combined:
 *
 *   1. **Reporter truth** — `packages/reporter/src/plugin-dsh/index.mjs`, loaded by
 *      DSH itself, forwards `session/created`, `user/message`, `tool/call`,
 *      `tool/result`, `approval/asked`, `turn/end` … to `/api/v1/hook`. That is the
 *      only way to get "awaiting permission", an aborted turn, exact token usage
 *      and changed files without guessing.
 *   2. **On-disk session list** — the first Zstandard frame of every session log is
 *      the immutable header. Reading just that frame gives the session id, cwd and
 *      creation time, so the session dropdown still works after a server restart
 *      or for sessions that ran before the plugin was installed.
 *
 * What this floor does **not** do: infer a phase from the compressed event stream.
 * Zstandard concatenates frames, and the default Node decoder stops at the first
 * one; a partial/streaming reader would be a second, fragile implementation of
 * DSH's own persistence format. If the plugin is not loaded, the floor honestly
 * reports `unreported` instead of inventing a phase.
 *
 * Floor module contract: see `server/src/floors.js`.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { formToSource } = require('@workgremlin/shared');
const { resolveProjectName } = require('./project');
const { isFile } = require('./roots');
const { runHookEvent, sharedHookImpl, resultOfResponse } = require('./ingest/hookCommon');

const HOME = os.homedir();

/**
 * DSH's user-data root. `$DSH_HOME` is DSH's own override; otherwise `~/.dsh`
 * (see `@deepseek-ai/dsh-home-paths`).
 */
function dshHome() {
  const explicit = String(process.env.DSH_HOME || '').trim();
  return explicit ? path.resolve(explicit) : path.join(HOME, '.dsh');
}

/** Root of DSH's per-session JSONL logs. */
function dshSessionsDir() {
  return path.join(dshHome(), 'sessions');
}

/** Floor metadata (formerly the products.js 10F entry). */
const meta = {
  id: '10F',
  name: 'DeepSeek Harness',
  kind: 'cli',
  cmd: 'dsh',
  agent: 'dsh',
  plugin: false,
  sources: [
    {
      kind: 'dsh',
      label: 'CLI / Web / Desktop',
      client: 'dsh',
      dirs: [dshSessionsDir()],
    },
    // The reporter plugin's true-phase path. DSH loads it from the home-level
    // Cordis patch, so sessions from every profile (web / headless / acp) are
    // reported with the same identity.
    { kind: 'hook' },
  ],
  hookSource: true,
  dataKind: 'dsh',
  // DSH is normally installed by npm; some installers put the launcher under
  // ~/.dsh/bin. The common npm global dirs come from floors.js's fallback list.
  cliBinDirs: [path.join(dshHome(), 'bin')],
};

/* ============================== Session discovery ============================== */

const SESSION_FILE_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/i;
const HEADER_WINDOW = 256 * 1024;
const SESSION_LIMIT = 200;
const SESSION_TTL = 5_000;

/** file path -> parsed header (the header frame is immutable for the life of a session). */
const headerCache = new Map();
let listCache = { at: 0, root: '', rows: [] };

function mtime(p) {
  try {
    return Math.round(fs.statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Read the first line/header of one session log without decoding the event body.
 * DSH's default encoder writes the header as its own checksummed Zstandard frame;
 * Node's decompressor returns that first frame and ignores the concatenated ones.
 * @param {string} file absolute session log path
 * @returns {{id:string, cwd:string, createdAt:number}|null}
 */
function readSessionHeader(file) {
  if (!file || !isFile(file)) return null;
  const cached = headerCache.get(file);
  if (cached) return cached;
  let text = '';
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, HEADER_WINDOW);
    if (!size) return null;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size);
      const n = fs.readSync(fd, buf, 0, size, 0);
      const raw = buf.subarray(0, n);
      if (/\.zstd$/i.test(file)) {
        if (typeof zlib.zstdDecompressSync !== 'function') return null;
        text = zlib.zstdDecompressSync(raw).toString('utf8');
      } else {
        text = raw.toString('utf8');
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* close failure does not affect the bytes already read */
      }
    }
  } catch {
    return null;
  }
  const first = String(text || '').split(/\r?\n/, 1)[0].trim();
  if (!first) return null;
  let header = null;
  try {
    header = JSON.parse(first);
  } catch {
    return null;
  }
  // DSH's physical header is a `type: "session"` record. A different shape means
  // the persistence format changed; leave it unread rather than misattribute it.
  if (!header || header.type !== 'session' || !String(header.id || '').trim()) return null;
  const value = {
    id: String(header.id),
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    createdAt: num(header.createdAt),
    ...(String(header.origin || '') === 'subagent' ? { subagent: true } : {}),
  };
  headerCache.set(file, value);
  return value;
}

/** Pick the numerically highest `session[.vN].jsonl[.zstd]` log for one session directory. */
function sessionLogOf(dir) {
  let best = null;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of ents) {
    if (!ent.isFile()) continue;
    const match = SESSION_FILE_RE.exec(ent.name);
    if (!match) continue;
    const version = match[1] === undefined ? 0 : Number(match[1]);
    if (!best || version > best.version) best = { version, file: path.join(dir, ent.name) };
  }
  return best ? best.file : null;
}

/**
 * All DSH sessions known on disk, newest first.
 *
 * The layout is fixed by DSH: one readable project directory, then one
 * session-owned directory per session. We deliberately do not walk deeper than
 * that; a future nested layout should be added here with evidence, not guessed.
 * @returns {Array<{id:string, sessionId:string, project:string, projectPath:string, lastEventAt:number}>}
 */
function listDshSessions() {
  const root = dshSessionsDir();
  const now = Date.now();
  if (listCache.root === root && now - listCache.at < SESSION_TTL) return listCache.rows;
  const rows = [];
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    listCache = { at: now, root, rows };
    return rows;
  }
  for (const project of projects) {
    const projectDir = path.join(root, project.name);
    let sessions = [];
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const session of sessions) {
      const file = sessionLogOf(path.join(projectDir, session.name));
      if (!file) continue;
      const header = readSessionHeader(file);
      if (!header) continue;
      // A session without a workspace has no project to show in the office; the
      // same P0 rule applies as CodeBuddy's "no folder open" sessions.
      if (!header.cwd) continue;
      // A child subagent session shares the parent's project but is not an
      // independent session in the dropdown (same rule as Claude/Codex).
      if (header.subagent) continue;
      const lastEventAt = mtime(file);
      const cwd = header.cwd;
      rows.push({
        id: header.id,
        sessionId: header.id,
        project: cwd ? resolveProjectName(cwd) || path.basename(cwd) : '',
        projectPath: cwd,
        lastEventAt: lastEventAt || header.createdAt || now,
      });
    }
  }
  rows.sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
  listCache = { at: now, root, rows: rows.slice(0, SESSION_LIMIT) };
  return listCache.rows;
}

/**
 * 10F's source branch. This mirrors the framework's cli/hook branch but scans
 * DSH's session-directory layout and reads only each log's header frame.
 */
function dshHandler(p, src, ctx) {
  const {
    workspacePath, table, claimSession, upsert, now, TIMEOUT_MS,
    listReporterSessions, doneFieldsOf, formatAge, cliLandingSessions,
  } = ctx;
  const reporterSessions = listReporterSessions(src.client, { includeEnded: true });
  const ended = new Set(reporterSessions.filter((s) => s.endedAt).map((s) => s.sessionId));
  for (const [key, session] of table) {
    if (session.floor === p.id && ended.has(session.sessionId) && ['dsh', 'hook'].includes(session.sourceKind)) {
      table.delete(key);
    }
  }
  const rows = listDshSessions().filter((s) => !ended.has(s.sessionId));
  const live = rows
    .filter((s) => now - (Number(s.lastEventAt) || 0) < TIMEOUT_MS)
    .filter((s) => s.sessionId);
  // The hook source and the on-disk source describe the same session. The
  // on-disk row wins (it carries the project path and survives a restart), and
  // the hook handler withdraws its duplicate for these ids (see handleCliHook).
  if (live.length) {
    const ids = new Set(live.map((s) => s.sessionId).filter(Boolean));
    cliLandingSessions.set(p.id, ids);
    for (const sessionId of ids) {
      const old = table.get(`${p.id}:${sessionId}`);
      if (old && old.sourceKind === 'hook') table.delete(`${p.id}:${sessionId}`);
    }
  }
  for (const s of live) {
    if (!claimSession(p.id, s.sessionId)) continue;
    upsert({
      floor: p.id,
      id: s.id,
      sessionId: s.sessionId,
      source: formToSource(''),
      sourceKind: 'dsh',
      form: '',
      project: s.project,
      projectPath: s.projectPath,
      mine: Boolean(workspacePath && s.projectPath && path.resolve(s.projectPath) === path.resolve(workspacePath)),
      current: false,
      live: true,
      phase: 'unreported',
      action: '',
      target: '',
      tool: '',
      context: [`会话文件${formatAge(now - s.lastEventAt)}（未收到 DSH 插件上报，不推断动作）`],
      prompt: '',
      inferred: true,
      ...doneFieldsOf(s.projectPath, src.client, s.sessionId),
      lastEventAt: s.lastEventAt,
    });
  }
}

/* ============================== Reporter event handling ============================== */

/**
 * The plugin's `turn/end` already knows the turn's token usage and final text;
 * `runHookEvent` normally reads both from a transcript file. DSH's transcript is
 * compressed and may be unreadable while the process is live, so the floor keeps
 * a tiny last-round cache keyed by the synthetic transcript id `dsh:<session>`.
 */
const tokenCache = new Map();
const replyCache = new Map();
const CACHE_MAX = 200;

function cacheSet(cache, key, value) {
  if (!key) return;
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function transcriptKey(sessionId) {
  return `dsh:${String(sessionId || '')}`;
}

/**
 * DSH's tool result for the subagent tool is rendered as
 * `started subagent <child-session-id>`. Binding that id lets the ghost survive
 * the asynchronous launch and be retired later by `SubagentStop`.
 */
function subagentLaunchOf(ev) {
  const text = resultOfResponse(ev);
  const match = /started subagent\s+([A-Za-z0-9_-]+)/i.exec(text);
  if (match) return { agentId: match[1], background: true };
  // Some DSH versions may carry the structured activation object instead of the
  // rendered text. Accept both shapes; never guess an id that is not present.
  try {
    const obj = JSON.parse(text);
    const id = String((obj && (obj.subagentId || obj.agentId || obj.id)) || '').trim();
    if (id) return { agentId: id, background: true };
  } catch {
    /* not JSON: the rendered text above is the only supported shape */
  }
  return null;
}

const dshImpl = {
  ...sharedHookImpl,
  // DSH emits approval/asked explicitly; PreToolUse must not guess "pending".
  hasPermissionEvent: true,
  // A headless DSH process disposes its session tree and exits: if the final
  // Stop did not make it out, SessionEnd must close the running task rather
  // than leaving a permanently running row.
  endOnSessionEnd: true,
  // DSH's session log is not a readable JSONL transcript at this layer.
  transcriptPathOf: (ev, st, sessionId) => transcriptKey(sessionId),
  repliesOf: (tp) => {
    const list = replyCache.get(tp);
    return Array.isArray(list) ? list : [];
  },
  readTokensOf: (tp, startedAt) => {
    const entry = tokenCache.get(tp);
    if (!entry) return null;
    // A token reading from an earlier round must not leak into a later round:
    // the plugin captures usage at Stop, so `at` is the round's end time.
    if (Number(startedAt) > 0 && Number(entry.at) < Number(startedAt)) return null;
    return { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite };
  },
  interruptedSince: () => false,
  formOf: () => '',
  subagentLaunchOf,
  subagentStopMatchesSpawn: (ev) => Boolean(String((ev && (ev.agent_id || ev.agentId)) || '').trim()),
};

/**
 * Server-side handler for `/api/v1/hook` events forwarded by the DSH plugin.
 * The generic framework does all ledger/phase/ghost work; this wrapper only
 * feeds DSH's token and final-answer values into the read hooks above.
 */
async function handleHookEvent(ev, ctx) {
  const sessionId = String((ev && ev.session_id) || '');
  const key = transcriptKey(sessionId);
  if (sessionId && ev && ev.tokens && typeof ev.tokens === 'object') {
    const tokens = {
      input: num(ev.tokens.input),
      output: num(ev.tokens.output),
      cacheRead: num(ev.tokens.cacheRead),
      cacheWrite: num(ev.tokens.cacheWrite),
      at: Date.now(),
    };
    if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0) cacheSet(tokenCache, key, tokens);
  }
  if (sessionId && ev && typeof ev.last_assistant_message === 'string' && ev.last_assistant_message.trim()) {
    cacheSet(replyCache, key, [{ id: `dsh-${Date.now()}`, text: ev.last_assistant_message.trim() }]);
  }
  // A new human round must not inherit the previous round's final answer when
  // this turn produced no assistant text (for example a user cancellation).
  if (sessionId && ev && ev.hook_event_name === 'UserPromptSubmit') replyCache.delete(key);
  return runHookEvent(ev, ctx, dshImpl);
}

module.exports = {
  meta,
  kindHandlers: { dsh: dshHandler },
  handleHookEvent,
  // Exported for the self-test / diagnostics.
  dshHome,
  dshSessionsDir,
  listDshSessions,
  readSessionHeader,
};
