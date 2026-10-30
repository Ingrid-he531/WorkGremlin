'use strict';

/**
 * 1F CodeBuddy (CLI and Plugin merged floor).
 *
 * This floor = two forms of the same product merged into one (see the header of
 * server/src/products.js):
 *   cli    —— session jsonl under ~/.codebuddy (CLI history on disk)
 *   plugin —— structured on-disk data in the editor's globalStorage (genie-history / todos / …)
 *   hook   —— reporter state file (the only truth when the CLI often has no scannable session data)
 * All three standard sources (cli/plugin/hook) are handled by sessionRegistry's default handler; this
 * file only declares metadata and needs no kindHandlers. Adding / adjusting this floor touches only
 * this file.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
// Shared server logger (warn goes to stderr and to ~/.workgremlin/logs).
const log = require('./log');
// The list of globalStorage roots (where plugins write) is centralized in roots.js, a single source of
// truth for the whole repo, so nobody rewrites their own copy and misses the macOS/Windows directories
const { dataRoots, isDir, isFile, readJson, readDir } = require('./roots');
// Project name resolution (genie-history directory name → project name) is centralized in project.js
const { resolveProjectName } = require('./project');
// Static subagent directories (project-level / user-level): private knowledge of this floor, kept here
// rather than in the central agentLevel
const { genericAgentDirs, makeAgentSync } = require('./ingest/agentLevel');

/**
 * 1F's static subagent definition directories: project-level <ws>/.codebuddy/agents and user-level
 * ~/.codebuddy/agents.
 * Returns [{ dir, level }], project level before user level (match priority). floors.js aggregates from
 * this and decides the level.
 */
function agentDirs(workspacePath) {
  return genericAgentDirs([path.join(HOME, '.codebuddy')], workspacePath);
}

const HOME = os.homedir();

/** Plugin directory name matching (only the plugin floor needs it); findPluginDir's default regex uses it too */
const RE_PLUGIN = [/codebuddy/i, /tencent/i, /ingram/i, /code-?buddy/i];

/* ===================== CodeBuddy family plugin structured on-disk data (plugin kind reads) =====================
 * This whole directory structure of genie-history (project grouping) / todos / file-changes /
 * message-queue is **unique to the CodeBuddy** (Tencent Coding Copilot) plugin; other plugin floors
 * each have their own on-disk shape (9F Copilot is session-store.db, see floorCopilot.js). So it belongs
 * to this floor —— sessions.js's listSessions dispatches by client to pluginStore below, and the generic
 * plugin reader (roots.js's findPluginStorage) no longer meddles with any product's internal directory structure.
 */

/** File mtime (ms); returns 0 when unreadable ("never touched", never fabricated) */
function mtime(p) {
  try {
    return Math.round(fs.statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

/** A decoded string only counts as a workspace path when it has no control characters and no
 *  interior replacement character. A trailing U+FFFD is tolerated: the extension cuts the name to
 *  64 base64 chars, which can split the last UTF-8 sequence of a non-ASCII path. */
function looksLikePath(value) {
  const s = String(value || '');
  if (!s) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (/\uFFFD(?!$)/.test(s)) return false;
  return s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s);
}

/**
 * The plugin encodes "no folder is open" as the filesystem root (`/`, `C:\`, …). Such a session has
 * no project to show in the office and used to surface as an "unknown project" dropdown entry, so it
 * is not a 1F session at all.
 * @param {string} value workspace path
 * @returns {boolean}
 */
function isRootWorkspace(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  let abs = '';
  try {
    abs = path.resolve(s);
  } catch {
    return false;
  }
  return abs === path.parse(abs).root;
}

/** @param {string} text @returns {string} UTF-8 text, '' when the input cannot be decoded */
function decodeBase64(text) {
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * The directory name is the base64 of the project path; returns empty when it does not decode (not a path).
 *
 * The extension's `sanitizeWorkspaceId` is `base64(path).replace(/[/+=]/g, '_')` (then cut to 64
 * chars). `_` for `/` / `+` is normal base64url and decodes correctly, but **the `=` padding is
 * replaced too**. Feeding trailing `_` straight to Node makes it read them as base64url data, so a
 * short path such as `/` (`Lw==` → `Lw__`) decodes to `/\x0f\uFFFD` and its project label shows up
 * as unreadable characters. Try the literal form first (long names carry no padding), then restore
 * one or two trailing `_` as padding — whichever form yields a plausible path.
 */
function decodeDirName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';

  const direct = decodeBase64(raw);
  if (looksLikePath(direct)) return direct;

  for (const pad of [1, 2]) {
    if (!raw.endsWith('_'.repeat(pad))) continue;
    const restored = decodeBase64(raw.slice(0, raw.length - pad) + '='.repeat(pad));
    if (looksLikePath(restored)) return restored;
  }
  return '';
}

/**
 * Ordered candidates that could be the untruncated form of `decoded`.
 *
 * The extension cuts the genie-history directory name (base64 of the project path) to 64
 * characters, so truncation is a plain prefix cut of the decoded string. A candidate
 * qualifies when it starts with `decoded` (normalized: backslashes -> slashes, trailing
 * slashes trimmed, case-insensitive). A candidate equal to `decoded` is not a match: it
 * would mean the path was never cut, so there is nothing to complete. Duplicates are
 * dropped, so `[ws, workspacePath]` holding the same path counts as a single candidate.
 *
 * @param {string} decoded result of decodeDirName
 * @param {string[]} candidates known real project paths, most trustworthy first
 * @returns {string[]}
 */
function truncatedWorkspaceMatches(decoded, candidates) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const want = norm(decoded);
  if (!want) return [];
  const seen = new Set();
  const out = [];
  for (const c of candidates || []) {
    if (!c) continue;
    const n = norm(c);
    if (!n || n === want || !n.startsWith(want)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(c);
  }
  return out;
}

/**
 * Complete a project path that the extension truncated (genie-history directory names are
 * cut to 64 base64 characters, which only fits 48 bytes -> the decoded path is a half).
 *
 * Matches are consumed in candidate order, and that order *is* the priority (the active
 * project comes first). A candidate that really exists on disk wins; when none exists, the
 * first match is used as a best-effort guess, so the caller never falls back to a truncated
 * stub just because the directory cannot be stat'ed. With no match at all the decoded string
 * is returned unchanged (machines with short paths are untouched).
 *
 * Ambiguity: two real projects can share the whole truncated prefix (`/u/base/proj` and
 * `/u/base/proj-utils`), and the prefix alone cannot tell them apart. collectProjects logs a
 * warning when that happens so a wrong attribution can be traced back later.
 *
 * @param {string} decoded result of decodeDirName
 * @param {string[]} candidates known real project paths, most trustworthy first
 * @returns {string}
 */
function completeTruncatedWorkspace(decoded, candidates) {
  if (!decoded || isDir(decoded)) return decoded; // real dir on disk = not truncated
  const matches = truncatedWorkspaceMatches(decoded, candidates);
  if (!matches.length) return decoded;
  return matches.find((c) => isDir(c)) || matches[0]; // prefer a real dir; else first by priority
}

/** genie-history: one base64 dir per project (the dir name decodes to the project path) */
function collectProjects(storage, candidates = []) {
  const gh = path.join(storage, 'genie-history');
  const out = [];
  for (const name of readDir(gh)) {
    const dir = path.join(gh, name);
    if (!isDir(dir)) continue;
    const raw = decodeDirName(name);
    const ws = completeTruncatedWorkspace(raw, candidates);
    if (!ws) continue;
    const matches = truncatedWorkspaceMatches(raw, candidates);
    // guessed: the path was reconstructed from a truncated dir name, not read as-is.
    // ambiguous: several known projects share the truncated prefix, so the guess can be
    // wrong (another project may own this dir). Log it for post-mortem triage.
    const guessed = ws !== raw;
    const ambiguous = guessed && matches.length > 1;
    if (ambiguous) {
      log.warn(
        `genie-history 工程目录「${name}」被截断：解出的「${raw}」命中 ${matches.length} 个已知工程 ` +
          `[${matches.join('、')}]，补全取「${ws}」（猜测，可能归属有误）`
      );
    }
    out.push({ dir, path: ws, project: resolveProjectName(ws) || path.basename(ws), guessed, ambiguous });
  }
  return out;
}

/** Per-session todos: total / done / doing (the first in_progress) / the text of the first few */
function readTodos(storage, id) {
  const file = path.join(storage, 'todos', `${id}.json`);
  const data = readJson(file);
  const list = Array.isArray(data && data.todos) ? data.todos : [];
  const doing = list.find((t) => t && t.status === 'in_progress') || null;
  return {
    total: list.length,
    done: list.filter((t) => t && t.status === 'completed').length,
    doing: doing ? String(doing.content || '') : '',
    items: list.slice(0, 8).map((t) => ({
      status: String((t && t.status) || 'pending'),
      content: String((t && t.content) || '').replace(/\s+/g, ' ').trim(),
    })),
    at: mtime(file),
  };
}

/** Current byte size of a file (stat'ed live by absolute path). Deletion-type changes have no source file left → null, never fabricated. */
function fileSizeOf(fp) {
  if (!fp || typeof fp !== 'string') return null;
  try {
    const s = fs.statSync(fp);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/** Changed files: newest first, by last write */
function readFileChanges(storage, id) {
  const dir = path.join(storage, 'file-changes', id);
  const out = [];
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const p = path.join(dir, name);
    const j = readJson(p);
    if (!j) continue;
    out.push({
      name: String(j.fileName || path.basename(String(j.filePath || name))),
      op: String(j.changeType || ''),
      added: Number(j.addedLines) || 0,
      removed: Number(j.removedLines) || 0,
      // Byte size: the file itself (filePath is absolute) stat'ed live. The plugin / IDE on-disk data
      // gives line counts only, no volume, so the server has to compute it; the source file of a
      // deletion-type change is gone, so if it cannot be computed it stays null.
      size: fileSizeOf(j.filePath),
      at: mtime(p),
    });
  }
  out.sort((a, b) => b.at - a.at);
  return { count: out.length, recent: out.slice(0, 6), lastAt: out.length ? out[0].at : 0 };
}

/**
 * The runtime state + queued count for this session in the message queue.
 * One message-queue file can hold several sessions, so all of them are scanned for its own share.
 */
function readRuntime(storage, id) {
  const dir = path.join(storage, 'message-queue');
  let runtime = null;
  let pending = 0;
  let updatedAt = 0;
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    const conv = j && j.conversations ? j.conversations[id] : null;
    if (!conv) continue;
    if (conv.runtime) runtime = { ...(runtime || {}), ...conv.runtime };
    for (const it of conv.items || []) if (it && it.status === 'pending') pending += 1;
    const itemUpdatedAt = (conv.items || []).reduce((best, item) => Math.max(
      best,
      Number(item && (item.updatedAt || item.createdAt || item.at)) || 0
    ), 0);
    updatedAt = Math.max(
      updatedAt,
      Number(conv.updatedAt) || 0,
      Number(conv.runtime && conv.runtime.updatedAt) || 0,
      itemUpdatedAt
    );
  }
  return {
    runtime: runtime || { activated: false, paused: false, awaitingSessionIdle: false },
    pending,
    hasRuntime: Boolean(runtime),
    updatedAt,
  };
}

/**
 * This floor's structured on-disk reader for the plugin kind —— sessions.js's listSessions /
 * sessionInfo dispatch here by client (see pluginStoreOf in sessions.js). The interface matches the
 * "plugin on-disk read" convention:
 *   readTodos(storage, id) / readFileChanges(storage, id) / readRuntime(storage, id) / collectProjects(storage, candidates)
 */
const pluginStore = { readTodos, readFileChanges, readRuntime, collectProjects };

/* ------------------------------ Cancel detection ------------------------------ */

/**
 * CodeBuddy plugin transcript cancel-signal cache: messages dir -> {m, size, cancels:[mtime...]}
 * Incremented by directory mtime+size; sinceTs filtering happens at the call site, the cache only holds
 * the "raw list of cancel moments" to avoid rescanning the disk.
 */
const _cbCancelCache = new Map();

/**
 * Fallback location of a session's transcript directory (containing index.json and messages/).
 * Normally transcript_path is already put into the reporter state file j.transcriptPath by the hook (see
 * hookCommon.js), with no scanning needed; this function is only used when "the state file has no
 * transcriptPath". On-disk structure:
 *   <dataRoot>/CodeBuddyExtension/Data/<uuid>/VSCode/<uuid>/history/<projectId>/<sessionId>/index.json
 */
function codebuddyTranscriptDirOf(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return '';
  for (const r of dataRoots()) {
    const base = path.join(r, 'CodeBuddyExtension', 'Data');
    if (!isDir(base)) continue;
    for (const a of readDir(base)) {
      const vsc = path.join(base, a, 'VSCode');
      if (!isDir(vsc)) continue;
      for (const b of readDir(vsc)) {
        const hist = path.join(vsc, b, 'history');
        if (!isDir(hist)) continue;
        for (const proj of readDir(hist)) {
          if (isFile(path.join(hist, proj, sid, 'index.json'))) return path.join(hist, proj, sid);
        }
      }
    }
  }
  return '';
}

/**
 * CodeBuddy plugin cancel detection: from the transcript directory's `messages/<id>.json`, find the
 * message with **role=assistant and content text==='[User Cancelled]'**, and take that file's mtime as
 * the cancel moment.
 *
 * Why read the transcript rather than message-queue: the CodeBuddy plugin emits **not a single hook
 * event** when cancelling (that FinalStop of the CLI never comes in the IDE form), and message-queue's
 * `runtime.pauseReason='cancel'` is unreliable —— an internal plugin timeout (the agent goes
 * unresponsive for a long time) writes it too, which misjudges "still running" as "cancelled".
 * The transcript's `[User Cancelled]` appears only when the user really presses stop (measured
 * 2026-10-12: 4 terminations today hit exactly 4 entries, internal timeouts produce none), the only
 * reliable signal.
 *
 * transcript_path (j.transcriptPath) points at `.../history/<projectId>/<sessionId>/index.json`,
 * and messages sits in the sibling messages/ directory.
 *
 * @param {string} sessionId
 * @param {number} sinceTs start moment of this round's task (0 = no filtering): only cancels from this
 *   round count, ones from an earlier round do not
 * @param {string} [transcriptDir] the session transcript directory; empty = locate it automatically
 * @returns {number} cancel moment (the message file's mtime; 0 = none / cannot be determined)
 */
/**
 * Read **all** `[User Cancelled]` cancel moments in a transcript directory's messages/ (message file
 * mtime). Cached incrementally by messages dir mtime+size; no sinceTs filtering —— filtering is left to
 * the caller, which decides by use case.
 * @returns {number[]}
 */
function codebuddyReadCancels(transcriptDir) {
  if (!transcriptDir) return [];
  const mdir = path.join(transcriptDir, 'messages');
  let files;
  try {
    files = readDir(mdir).filter((n) => /\.json$/i.test(n));
  } catch {
    return [];
  }
  // The invalidation signal has to look at "each file's mtime/size", not just the directory mtime: the
  // cancel message is often an in-place rewrite of the last assistant message (no new file created), so
  // the directory mtime does not change → the stale cache hits forever → misses (early cancels always
  // reproduce this).
  let sig = '';
  for (const n of files) {
    try {
      const st = fs.statSync(path.join(mdir, n));
      sig += `${n}:${st.mtimeMs}:${st.size};`;
    } catch { sig += `${n}:?;`; }
  }
  const cached = _cbCancelCache.get(mdir);
  if (cached && cached.sig === sig) {
    return cached.cancels;
  }
  const cancels = [];
  try {
    for (const name of files) {
      const fp = path.join(mdir, name);
      let o;
      try {
        o = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch {
        continue;
      }
      if (!o || o.role !== 'assistant') continue;
      let inner;
      try {
        inner = JSON.parse(o.message);
      } catch {
        continue;
      }
      const txt = Array.isArray(inner && inner.content)
        ? inner.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('')
        : '';
      if (txt !== '[User Cancelled]') continue; // exact match (with brackets, English); same-named strings in tool echoes do not count thanks to the role filter
      let at = 0;
      try {
        at = Math.round(fs.statSync(fp).mtimeMs);
      } catch {
        continue;
      }
      cancels.push(at);
    }
  } catch {
    /* skip when unreadable */
  }
  cancels.sort((a, b) => a - b);
  _cbCancelCache.set(mdir, { sig, cancels });
  return cancels;
}

/**
 * CodeBuddy plugin cancel detection (takes the newest cancel of "this round" by sinceTs; 0 = no filtering).
 * Used by the phaseSuperseded / cancelAt exports.
 */
function codebuddyCancelAt(sessionId, sinceTs = 0, transcriptDir = '') {
  const sid = String(sessionId || '');
  const dir = transcriptDir || codebuddyTranscriptDirOf(sid);
  if (!dir) return 0;
  let best = 0;
  for (const at of codebuddyReadCancels(dir)) {
    if (sinceTs && at < sinceTs) continue; // an earlier round's cancel must not land on the new round
    if (at > best) best = at;
  }
  return best;
}

/**
 * Returns **all** `[User Cancelled]` cancel moments in a session transcript (no sinceTs filtering).
 * For multi-task sessions (one CodeBuddy session holding several tasks): every cancel corresponds to one
 * terminated task, and synthMarks hands each to flushSynthesizedCancels, which marks it cancelled as a
 * fallback by "matching in-flight tasks on the cancel moment".
 */
function codebuddyCancelTimes(sessionId, transcriptDir = '') {
  const sid = String(sessionId || '');
  const dir = transcriptDir || codebuddyTranscriptDirOf(sid);
  if (!dir) return [];
  return codebuddyReadCancels(dir);
}

/**
 * Scan every CodeBuddy session transcript and collect the "cancelled by user" ones →
 * `{ [sessionId]: cancel moment }`.
 * Same criterion as codebuddyCancelAt, but **no sinceTs filtering, aggregating all cancels per session**
 * (like Trae's allCancels) —— when cancelling, the plugin does not rewrite the state file and even clears
 * taskId, so gating on startedAt again would fail to recognize the cancel; the render layer decides what
 * to show itself from phase.ts vs done.at, and here it only matters that "this round was cancelled", no
 * smart filtering needed.
 */
function allCodebuddyCancels() {
  const merged = {};
  for (const r of dataRoots()) {
    const base = path.join(r, 'CodeBuddyExtension', 'Data');
    if (!isDir(base)) continue;
    for (const a of readDir(base)) {
      const vsc = path.join(base, a, 'VSCode');
      if (!isDir(vsc)) continue;
      for (const b of readDir(vsc)) {
        const hist = path.join(vsc, b, 'history');
        if (!isDir(hist)) continue;
        for (const proj of readDir(hist)) {
          const projDir = path.join(hist, proj);
          for (const sid of readDir(projDir)) {
            const at = codebuddyCancelAt(sid, 0, path.join(projDir, sid));
            if (at && (!merged[sid] || at > merged[sid])) merged[sid] = at;
          }
        }
      }
    }
  }
  return merged;
}

const meta = {
  id: '1F',
  name: 'CodeBuddy',
  kind: 'cli',
  cmd: 'codebuddy',
  agent: 'codebuddy',
  plugin: false,
  pluginRe: RE_PLUGIN,
  // Marker for "what this floor's plugin structured on-disk data looks like": a directory matching
  // pluginRe counts as its plugin storage root only if it holds any one of these
  // (see findPluginStorage in roots.js). Kept in meta so the generic locator hardcodes no product
  // directory names.
  pluginStorageMarks: ['genie-history', 'todos', 'file-changes', 'message-queue'],
  // Merged floor: all three paths belong to it; when the same session is seen by two paths at once it is
  // deduped by session_id (see sessionRegistry).
  sources: ['cli', 'plugin', 'hook'],
  dataKind: 'codebuddy',
  // On-disk detection (used by findDataPath): what to match by name, which candidates in the home directory
  matchRe: [/^codebuddy/i, /^code-?buddy/i, /^tencent/i, /^ingram/i],
  homeDirs: [path.join(HOME, '.codebuddy'), path.join(HOME, '.codebuddy-cli')],
  // This floor's own CLI install directory (fallback when PATH lookup fails); product-independent
  // locations are in the generic fallback in floors.js
  cliBinDirs: [path.join(HOME, '.codebuddy', 'bin')],
  // CLI session files land under <dataRoot>/projects/<project>/, named after session_id
  // (old versions give 32 hex chars without hyphens, recognized as well)
  sessionSubtree: 'projects',
  sessionIdOfFile: (name) => {
    const stem = String(name).replace(/\.jsonl$/i, '');
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem) ||
      /^[0-9a-f]{32}$/i.test(stem)
      ? stem
      : '';
  },
};

/**
 * Whether this "running" reporter phase is voided by this floor's cancel marker.
 * The CodeBuddy plugin emits not a single hook event when cancelling, so the phase freezes at
 * "thinking / calling tool" and only the transcript's `[User Cancelled]` moment can puncture it (see
 * codebuddyCancelAt).
 * transcript_path comes from j.transcriptPath (the hook drops it into the state file) and points at the
 * session transcript directory.
 * Called by readReporterPhase's dispatch in sessions.js.
 * @param {object} j hook state file
 * @param {object} sp sessionPhase inside the state file
 * @param {number} slack phase timestamp tolerance (ms)
 */
function phaseSuperseded(j, sp, slack = 1_000) {
  const dir = j && j.transcriptPath ? path.dirname(j.transcriptPath) : '';
  const at = codebuddyCancelAt(j.sessionId, Number(j.taskStartedAt) || 0, dir);
  return !!at && at + slack >= Number(sp.ts || 0);
}

const { runHookEvent, sharedHookImpl, jsonlReplies, indexJsonReplies, turnInterrupted,
  normOpenAI, tokenFinish, readTokens,
  headJsonLines } = require('./ingest/hookCommon');

/* ============================== CodeBuddy-only constants ==============================
 * Moved down here from hookCommon together with codebuddyRequestTokens / codebuddyReadTokensOf,
 * consumed by this floor only, no longer polluting the framework layer. */

const CB_REQ_GRACE_MS = 5_000;
const CB_FLUSH_WAIT_MS = 1_200;
const CB_FLUSH_STEP_MS = 120;

/* ============================== CodeBuddy Plugin index.json token parsing ==============================
 * Moved down from hookCommon —— this is CodeBuddy's own index.json usage format (defined by the
 * CodeBuddy Plugin: inputTokens/cacheTokens/cachedWriteTokens/outputTokens), which the framework layer
 * should not hardcode. */

function codebuddyRequestTokens(indexPath, startedAt) {
  let idx;
  try { idx = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { return null; }
  const reqs = Array.isArray(idx && idx.requests) ? idx.requests : [];
  let best = null;
  for (const r of reqs) {
    if (!r || typeof r !== 'object') continue;
    const ts = Number(r.startedAt);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (ts < startedAt - CB_REQ_GRACE_MS || ts > startedAt + CB_REQ_GRACE_MS) continue;
    if (!best || ts > Number(best.startedAt)) best = r;
  }
  if (!best) return null;
  const u = best.usage;
  if (!u || typeof u !== 'object') return null;
  return normOpenAI({
    prompt_tokens: u.inputTokens,
    prompt_cache_hit_tokens: u.cacheTokens,
    prompt_cache_write_tokens: u.cachedWriteTokens,
    completion_tokens: u.outputTokens,
  });
}

/* ============================== CodeBuddy transcript path derivation ==============================
 *
 * CodeBuddy has three independent on-disk layouts, and the hook event's transcript_path field is
 * **often missing** (the Plugin form almost never carries it, and the CLI trace form misses it too at
 * times). The framework layer's tp() only recognizes the event payload by default ——
 * hence the floor's transcriptPathOf override derives it.
 *
 * Priority: event payload > session state cache > search the three candidate locations by
 * sessionId/mtime.
 */

/** ws-slug cache: compute a given workspace path's slug once */
const _wsSlugCache = new Map();

/**
 * Derive the CodeBuddy CLI projects slug from a workspace path.
 *   /home/me/proj → home-me-proj  →  ~/.codebuddy/projects/home-me-proj/<sessionId>.jsonl
 */
function slugForWs(ws) {
  const s = String(ws || '').trim();
  if (!s) return '';
  const hit = _wsSlugCache.get(s);
  if (hit != null) return hit;
  const slug = s.replace(/^\/+/, '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/\/+$/, '');
  _wsSlugCache.set(s, slug);
  return slug;
}

/** Given sessionId + workspacePath, search the three CodeBuddy transcript locations by priority.
 *  Returns the absolute path of the first file that exists; empty string when none does. */
function inferCodebuddyTranscript(sessionId, workspacePath) {
  const sid = String(sessionId || '').trim();
  if (!sid) return '';
  const wsSlug = slugForWs(workspacePath);

  // 1. CLI projects jsonl —— ~/.codebuddy/projects/<ws-slug>/<sessionId>.jsonl
  if (wsSlug) {
    const p = path.join(HOME, '.codebuddy', 'projects', wsSlug, `${sid}.jsonl`);
    if (fs.existsSync(p)) return p;
  }

  // 2. Plugin index.json —— ~/.local/share/CodeBuddyExtension/Data/**/history/<sessionId>/*/index.json
  //    the history directory name == sessionId (see ~/.local/share/CodeBuddyExtension/Data/<uuid>/VSCode/<uuid>/history/)
  const pluginRoot = path.join(HOME, '.local', 'share', 'CodeBuddyExtension');
  if (fs.existsSync(pluginRoot)) {
    // find the history/<sessionId> directory, then take index.json from any of its subdirectories
    const dataDir = path.join(pluginRoot, 'Data');
    if (fs.existsSync(dataDir)) {
      for (const entry of fs.readdirSync(dataDir)) {
        const cand = path.join(dataDir, entry);
        if (!fs.statSync(cand).isDirectory()) continue;
        // recursively look for the history/<sessionId> directory
        const hit = findPluginHistoryIndex(cand, sid);
        if (hit) return hit;
      }
    }
  }

  // 3. CLI trace jsonl (OTel) —— ~/.codebuddy/traces/*/trace_*.jsonl
  //    the trace file name does **not** contain sessionId, so only the newest by mtime can be taken.
  //    This location is the least reliable (it may match another session), so it goes last.
  const tracesDir = path.join(HOME, '.codebuddy', 'traces');
  if (fs.existsSync(tracesDir)) {
    let best = '';
    let bestMtime = 0;
    for (const sub of fs.readdirSync(tracesDir)) {
      const subDir = path.join(tracesDir, sub);
      try { if (!fs.statSync(subDir).isDirectory()) continue; } catch { continue; }
      for (const f of fs.readdirSync(subDir)) {
        if (!/^trace_.*\.jsonl$/i.test(f)) continue;
        const full = path.join(subDir, f);
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = full; }
        } catch { /* ignore */ }
      }
    }
    if (best) return best;
  }

  return '';
}

/** Recursively search for history/<sessionId> under CodeBuddy Plugin Data; return the subdirectory's index.json path when found */
function findPluginHistoryIndex(root, sessionId) {
  // first look at the direct history directory
  const historyDir = path.join(root, 'history');
  if (fs.existsSync(historyDir)) {
    const sessionDir = path.join(historyDir, sessionId);
    if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()) {
      // take index.json under the session directory (it may hold several rounds, one subdirectory each)
      for (const sub of fs.readdirSync(sessionDir)) {
        const idx = path.join(sessionDir, sub, 'index.json');
        if (fs.existsSync(idx)) return idx;
      }
    }
  }
  // recurse one level down (the VSCode/<uuid> layer)
  let found = '';
  try {
    for (const e of fs.readdirSync(root)) {
      const p = path.join(root, e);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        found = findPluginHistoryIndex(p, sessionId);
        if (found) return found;
      }
    }
  } catch { /* ignore permission */ }
  return found;
}

/* ============================== CodeBuddy trace jsonl (OTel) token parsing ==============================
 *
 * The CLI's new trace jsonl is not an ordinary JSONL message stream, it is OpenTelemetry span format:
 *   {"type":"span_end","span":{"type":"generation","startedAt":"ISO","toolOutput":"[{\"usage\":{...}}]"}}
 * usage sits inside the toolOutput string, wrapped in one more layer of JSON array; the usage format
 * matches OpenAI (prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens).
 */
function codebuddyTraceTokens(tracePath, startedAt) {
  const file = String(tracePath || '');
  if (!file || !(Number(startedAt) > 0)) return null;
  let rows;
  try { rows = fs.readFileSync(file, 'utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return null; }
  if (!rows.length) return null;
  let acc = null;
  for (const o of rows) {
    if (o.type !== 'span_end') continue;
    const span = o.span;
    if (!span || span.type !== 'generation') continue;
    const ts = Date.parse(span.startedAt);
    if (!ts || ts < startedAt) continue;
    let toolOut; try { toolOut = JSON.parse(span.toolOutput); } catch { continue; }
    const first = Array.isArray(toolOut) ? toolOut[0] : toolOut;
    const u = first && first.usage;
    if (!u) continue;
    const part = normOpenAI({
      prompt_tokens: u.prompt_tokens,
      prompt_cache_hit_tokens: u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens,
      prompt_cache_write_tokens: u.prompt_cache_write_tokens,
      completion_tokens: u.completion_tokens,
    });
    if (!acc) acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    acc.input += part.input;
    acc.output += part.output;
    acc.cacheRead += part.cacheRead;
    acc.cacheWrite += part.cacheWrite;
  }
  return tokenFinish(acc);
}

/* ============================== CodeBuddy's three-way token reading ==============================
 *
 * The framework layer's default readTokensOf implementation only recognizes "standard JSONL format"
 * (Codex rollout / Claude transcript). CodeBuddy has three formats, branched by file suffix:
 *   · index.json → codebuddyRequestTokens (plugin on-disk)
 *   · trace_*.jsonl → codebuddyTraceTokens (CLI OTel trace form)
 *   · everything else jsonl → readTokens (old form under projects, parsed with requestSum)
 *
 * Also, the CodeBuddy Plugin's index.json **lands on disk ~30-50ms later than the Stop hook event**,
 * so there is a "wait for it to land" retry loop here (the old job of hookCommon.readTokensSettled).
 */
async function codebuddyReadTokensOf(transcriptPath, startedAt) {
  const file = String(transcriptPath || '');
  if (!file || !(Number(startedAt) > 0)) return null;
  const t = codebuddyTryRead(file, startedAt);
  if (t) return t;
  // Only index.json needs waiting; the other jsonl formats are already written before the Stop moment
  if (!/index\.json$/i.test(file)) return null;
  for (let waited = 0; waited < CB_FLUSH_WAIT_MS; waited += CB_FLUSH_STEP_MS) {
    await new Promise((r) => setTimeout(r, CB_FLUSH_STEP_MS));
    const t2 = codebuddyTryRead(file, startedAt);
    if (t2) return t2;
  }
  return null;
}

/** Synchronous version of the three-way dispatch (codebuddyReadTokensOf also calls it for the first attempt + retries) */
function codebuddyTryRead(file, startedAt) {
  if (/index\.json$/i.test(file)) return tokenFinish(codebuddyRequestTokens(file, Number(startedAt)));
  if (/trace_.*\.jsonl$/i.test(file)) return codebuddyTraceTokens(file, Number(startedAt));
  return readTokens(file, Number(startedAt));
}

/* ============================== CodeBuddy sessionId inference ==============================
 *
 * CodeBuddy CLI / Plugin hook events carry no session_id field (events.log confirms: all None).
 * The server has to derive it from the transcript file itself —— the transcript file / directory name is
 * the sessionId.
 *
 * Reverse derivation (when there is no sessionId):
 *   1. CLI projects directory (most reliable): ~/.codebuddy/projects/<ws-slug>/<sid>.jsonl
 *      take the newest .jsonl by mtime => basename
 *   2. Plugin history directory:
 *      ~/.local/share/CodeBuddyExtension/Data/<uuid>/<ver>/history/<sid>/
 *      take the newest history/<sid> directory by mtime => sid
 *
 * Concurrency safety: a module-level Map caches workspacePath -> most recent sessionId.
 * The SessionStart event updates the cache and later events reuse it directly, avoiding concurrent
 * mismatches.
 */

/** Active session cache: workspacePath → sessionId (derived by the most recent SessionStart) */
const _activeSessionCache = new Map();

/** Derive CodeBuddy's currently active sessionId from workspacePath */
function inferCodebuddySessionId(workspacePath) {
  const ws = String(workspacePath || '').trim();

  // 0. Cache hit (SessionStart already derived it for this workspace)
  if (ws && _activeSessionCache.has(ws)) {
    const cached = _activeSessionCache.get(ws);
    if (cached) return cached;
  }

  const wsSlug = slugForWs(ws);

  // 1. CLI projects —— most reliable: the file name is the sessionId
  if (wsSlug) {
    const dir = path.join(HOME, '.codebuddy', 'projects', wsSlug);
    if (fs.existsSync(dir)) {
      let best = '';
      let bestMtime = 0;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl') || f.startsWith('.')) continue;
        const full = path.join(dir, f);
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs > bestMtime) {
            bestMtime = st.mtimeMs;
            best = f.replace(/\.jsonl$/i, '');
          }
        } catch { /* ignore */ }
      }
      if (best) {
        if (ws) _activeSessionCache.set(ws, best);
        return best;
      }
    }
  }

  // 2. Plugin history —— the directory name is the sessionId
  const pluginRoot = path.join(HOME, '.local', 'share', 'CodeBuddyExtension', 'Data');
  if (fs.existsSync(pluginRoot)) {
    let best = '';
    let bestMtime = 0;
    for (const entry of fs.readdirSync(pluginRoot)) {
      const cand = path.join(pluginRoot, entry);
      try { if (!fs.statSync(cand).isDirectory()) continue; } catch { continue; }
      // look for the history/<uuid>/ directory
      for (const sub of fs.readdirSync(cand)) {
        const historyDir = path.join(cand, sub, 'history');
        if (!fs.existsSync(historyDir)) continue;
        try {
          if (!fs.statSync(historyDir).isDirectory()) continue;
          for (const histEntry of fs.readdirSync(historyDir)) {
            const histFull = path.join(historyDir, histEntry);
            try {
              const st = fs.statSync(histFull);
              if (!st.isDirectory()) continue;
              if (st.mtimeMs > bestMtime) {
                bestMtime = st.mtimeMs;
                best = histEntry; // directory name = sessionId
              }
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    }
    if (best) {
      if (ws) _activeSessionCache.set(ws, best);
      return best;
    }
  }

  return '';
}

/** CodeBuddy CLI's transcriptPathOf override: event payload > state cache > derive from the three candidate locations */
function codebuddyTranscriptPathOf(ev, st, sessionId, workspacePath) {
  if (ev && ev.transcript_path) return String(ev.transcript_path);
  if (st && st.transcriptPath) return String(st.transcriptPath);
  return inferCodebuddyTranscript(sessionId, workspacePath);
}

/** CodeBuddy's on-disk differences: event gating and the common file/token/ghost logic all live in hookCommon.runHookEvent.
 *  Only interfaces differing from the shared default are overridden; the rest falls back to sharedHookImpl. */
const codebuddyImpl = {
  ...sharedHookImpl,
  // hasSubagentStart must fall back to sharedHookImpl's false: CodeBuddy emits 0 SubagentStart events
  // (events.log confirms), only SubagentStop. Things like PreToolUse pendingSpawn claims would wait
  // forever → addGhost would always be skipped.
  // Take the !hasSubagentStart branch: PreToolUse(Task/Agent) addGhost directly, PostToolUse /
  // SubagentStop each finishGhostServer.
  // Refactor commit 9d0a11c was false, and 07dec75 later changed it to true by mistake (its comment
  // fabricated "the plugin emits SubagentStart") —— that was a regression.
  awaitingPermission: () => true, // any non-idle Notification counts as "awaiting permission"
  repliesOf: (tp) => (/index\.json$/i.test(tp) ? indexJsonReplies(tp) : jsonlReplies(tp)),
  interruptedSince: (tp, since) => turnInterrupted(tp, since),
  // New interface overrides: transcript path derivation + three-way token parsing
  transcriptPathOf: codebuddyTranscriptPathOf,
  readTokensOf: codebuddyReadTokensOf,
};

async function handleHookEvent(ev, ctx) {
  // CodeBuddy CLI/Plugin hook events carry no session_id —— derive it from the transcript file
  if (!String((ev && ev.session_id) || '').trim()) {
    const ws = String((ctx && ctx.workspacePath) || (ev && ev.cwd) || '').trim();
    const sid = inferCodebuddySessionId(ws);
    if (sid) ev.session_id = sid;
  }
  return runHookEvent(ev, ctx, codebuddyImpl);
}

module.exports = {
  meta,
  // For findPluginDir / findPluginStorageDir default regex reuse
  RE_PLUGIN,
  // plugin kind structured on-disk reads: sessions.js dispatches here by client (see pluginStore)
  pluginStore,
  // genie-history dir-name decoding / truncated-path completion (used by self-checks and collectProjects)
  decodeDirName,
  completeTruncatedWorkspace,
  truncatedWorkspaceMatches,
  // plugin kind session list policy: dispatched generically by sessionRegistry.handlePlugin (see pluginPolicy)
  pluginPolicy,
  // Cancel detection (unified module-group interface: cancelAt / allCancels, same signature as trae)
  cancelAt: codebuddyCancelAt,
  phaseSuperseded,
  allCancels: allCodebuddyCancels,
  // Done / cancel marker synthesis: dispatched uniformly by readReporterDones (sessions.js's common code
  // keeps no CodeBuddy-specific logic)
  synthMarks,
  // Server-side hook event handling (disk parsing belongs to the server)
  handleHookEvent,
  // Static subagent dirs (project / user level): read by this floor's own syncAgents
  agentDirs,
  // Register this floor's user / project subagents with the roster (see agentLevel.makeAgentSync)
  syncAgents: makeAgentSync(agentDirs, meta.agent),
};

/**
 * 1F plugin (VS Code extension) **session list policy** —— dispatched generically by
 * sessionRegistry.handlePlugin.
 * The framework knows no CodeBuddy details, only this interface (see FLOOR_CONTRACT in floors.js).
 *
 * Why it is needed: for the plugin form, whether a session is "enrolled / retired" is recorded by
 * SessionStart / SessionEnd in the reporter state file (reported client as `codebuddy`, form as
 * `vscode` —— the CLI client carries no form). The requirement is that the 1F dropdown **lists only the
 * current session**, adding / removing dynamically by SessionStart / SessionEnd, rather than stuffing
 * every historical session in.
 *
 * @param {object} ctx refresh's shared toolkit (uses listReporterSessions)
 * @returns {{currentOnly?:boolean, active?:object[], ended?:object[], exclude?:(row:object)=>boolean}}
 */
function pluginPolicy(ctx) {
  const listReporterSessions = ctx && ctx.listReporterSessions;
  if (typeof listReporterSessions !== 'function') return {};
  const life = listReporterSessions('codebuddy', { includeEnded: true }).filter((s) => s.form === 'vscode');
  return {
    // List only the one current.json points at + active sessions, do not stuff historical sessions into the dropdown
    currentOnly: true,
    // Ones SessionStart has landed for and that have no SessionEnd yet: they must be listed (even if it
    // is not the one current.json points at)
    active: life.filter((s) => s.currentProcess && !s.endedAt),
    // Ones already SessionEnd'd: removed from the list
    ended: life.filter((s) => s.endedAt),
    // Ones whose runtime already cancelled: still should not enter the dropdown (cancelled = did not
    // finish, so it should not hold a session slot either).
    // A "no folder is open" session (filesystem root) is not a project either: listing it only adds an
    // "unknown project" row whose office is necessarily empty.
    exclude: (row) =>
      isRootWorkspace(row && row.projectPath) ||
      Boolean(row && row.runtime && row.runtime.paused && String(row.runtime.pauseReason || '').toLowerCase() === 'cancel'),
  };
}

/**
 * Floor-specific "cancel" marker synthesis, dispatched uniformly by readReporterDones in sessions.js.
 *
 * The CodeBuddy **plugin** (IDE extension) emits **not a single hook event** when cancelling (that
 * FinalStop of the CLI never comes in the IDE form); the only authoritative signal is that
 * role=assistant, text==='[User Cancelled]' message in the transcript's `messages/<id>.json` (see
 * codebuddyCancelTimes). The session's transcript_path is already put into the state file j.transcriptPath
 * by the hook, so it can be read per session directly, with no need to scan the whole message-queue disk.
 *
 * Handling multi-task sessions (one CodeBuddy session holding several tasks / conversations):
 *   · A session may have **several** `[User Cancelled]` entries (one per termination), each corresponding
 *     to one terminated task.
 *   · The state file keeps only the "current task"'s taskId / taskStartedAt; starting a new task after a
 *     cancel overwrites both fields wholesale, so a cancel must never be bound to j.taskId, nor gated by
 *     the current taskStartedAt (otherwise the previous round's cancel is never recognized and the
 *     cancelled task hangs on running forever).
 *   · Hence: every cancel synthesizes one cancel marker with an empty taskId → handed to
 *     sessionRegistry.flushSynthesizedCancels, whose "match in-flight tasks by session + cancel moment"
 *     fallback covers it (listStaleRunningBySession finds the nearest in-flight task with startedAt<=at;
 *     a new round with startedAt>at is never taken by mistake), landing precisely on the terminated round.
 *   · The main console's red light (bySession) only recognizes "the latest cancel is this round"
 *     (at >= taskStartedAt), otherwise a previous round's cancel would be misattributed to the currently
 *     running task.
 *
 * @param {object} ctx { workspacePath, client, hookBySid, clientHit, synthCancel, bySession }
 */
function synthMarks(ctx) {
  const { workspacePath, hookBySid, synthCancel } = ctx || {};
  if (!hookBySid) return;
  for (const [sid, entry] of hookBySid) {
    const j = entry && entry.j; // hookBySid values are { j } wrappers, not the j itself
    if (!j) continue;
    if (!/^codebuddy/i.test(String(j.client || ''))) continue;
    const dir = j.transcriptPath ? path.dirname(j.transcriptPath) : '';
    const times = codebuddyCancelTimes(sid, dir); // every [User Cancelled] moment of this session (unfiltered)
    if (!times.length) continue;
    const taskStarted = Number(j.taskStartedAt) || 0;
    const latest = times.reduce((a, b) => Math.max(a, b), 0);
    // Whether this round already **wrapped up normally**: if the Stop-landed done is newer than the
    // cancel, this cancel belongs to an earlier round and should neither light the main console red nor
    // bind the current taskId. done must be compared —— the plugin session list reads the done marker by
    // src.client ('codebuddy-plugin'), while the plugin's reporting identity is codebuddy(+form=vscode),
    // so this path **cannot read** done; without looking at done, a session that "was cancelled first and
    // then wrapped up normally" would keep showing "task cancelled" (measured 2026-10-13).
    const doneAt = Number(j.done && j.done.at) || 0;
    for (const at of times) {
      if (taskStarted && at < taskStarted) {
        // An earlier task's cancel: taskId stays empty, handed to the session fallback match (neither
        // misfires on the currently running task nor lights the current red light)
        synthCancel({ id: sid, j, ws: workspacePath || '', at, consoleMark: false, taskId: '' });
      }
    }
    // This round (or no start moment for this round): synthesize normally (with taskId + light the main
    // console red)
    if (!taskStarted || latest >= taskStarted) {
      if (doneAt && latest <= doneAt) {
        // There is already a newer normal wrap-up → only register it into the ledger (retiring that
        // earlier round as a fallback), no red light, no binding of the current taskId
        synthCancel({ id: sid, j, ws: workspacePath || '', at: latest, consoleMark: false, taskId: '' });
      } else {
        synthCancel({ id: sid, j, ws: workspacePath || '', at: latest });
      }
    }
  }
}
