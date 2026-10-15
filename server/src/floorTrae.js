'use strict';

/**
 * 5F TraeCode (Trae / Trae CN) floor module —— merges cancel detection, token amounts and model
 * completion (formerly traeCancel.js / traeTokens.js / traeModels.js) into this one file.
 *
 * All three signals are dug out of Trae's own on-disk data (renderer.log / globalStorage's
 * state.vscdb), independent of each other, each with an mtime+size incremental + TTL cache. Detailed
 * semantics are in the comments above each function.
 *
 * Unified interface (see FLOOR_CONTRACT in floors.js):
 *   id / client   floor identity
 *   cancelAt      cancel moment detection (= traeCancelAt)
 *   allCancels    full cancel scan (written back to the DB by flush)
 *   modelOf       this session's current model (= selectedModelOf)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// The Trae family's globalStorage / logs roots: private to this floor, kept here (no longer polluting floors.js).
const { isDir, dataRoots } = require('./roots');
// Static subagent directories (project-level / user-level): private knowledge of this floor, kept here
// rather than in the central agentLevel
const { genericAgentDirs, makeAgentSync } = require('./ingest/agentLevel');
// WorkGremlin's own state-file dir comes from shared/paths.js (single source of truth).
const { hooksDir } = require('@workgremlin/shared/paths');

/**
 * 5F's static subagent definition directories. Trae has no "user-level / project-level agent definition
 * file" mechanism yet, so this goes through the generic derivation (meta.homeDirs is empty → returns [],
 * no disk scan). If Trae ever puts agent definitions in some directory, just give the explicit directories
 * here (same interface as CodeBuddy / Codex / Claude).
 * @returns {Array<{dir:string, level:'project'|'user'}>}
 */
function agentDirs(workspacePath) {
  return genericAgentDirs((meta && meta.homeDirs) || [], workspacePath);
}

/**
 * The TraeCode family's globalStorage (the model selection is recorded in its state.vscdb). Listed
 * separately and not merged into globalStorageRoots: that one is **the plugin floors' on-disk location**,
 * and changing it would drag 5F's on-disk data away from ~/.marscode.
 */
function traeGlobalStorageRoots() {
  const out = [];
  for (const r of dataRoots()) {
    for (const ed of ['Trae', 'Trae CN']) {
      const p = path.join(r, ed, 'User', 'globalStorage');
      if (isDir(p)) out.push(p);
    }
  }
  return out;
}

/**
 * The TraeCode family's logs root. Newer Trae moved "session → currently selected model" into an in-memory
 * store + encrypted DB, and that row in state.vscdb is no longer written —— the model-store events in
 * renderer.log became the only plaintext source.
 */
function traeLogRoots() {
  const out = [];
  for (const r of dataRoots()) {
    for (const ed of ['Trae', 'Trae CN']) {
      const p = path.join(r, ed, 'logs');
      if (isDir(p)) out.push(p);
    }
  }
  return out;
}

/**
 * 5F TraeCode floor metadata (formerly the 5F entry in products.js). IDE and plugin merged floor:
 * both dir paths exist only for on-disk display (no sessions can be read), the session source is the hook
 * state file.
 */
const meta = {
  id: '5F',
  name: 'TraeCode',
  kind: 'cli',
  cmd: 'trae',
  altCmd: 'trae-cn',
  agent: 'trae',
  plugin: false,
  pluginRe: /trae|coding-copilot/i,
  sources: [
    { kind: 'dir', label: 'IDE', client: 'trae', dirs: [path.join(os.homedir(), '.trae-cn'), path.join(os.homedir(), '.trae')] },
    { kind: 'dir', label: 'plugin', form: 'vscode', dirs: [path.join(os.homedir(), '.marscode')] },
    { kind: 'hook' },
  ],
  hookSource: true,
  dataKind: 'trae',
};

const TTL_MS = 15_000;
function safeReadDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}
function isDirSafe(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/* ───────────── formerly traeCancel.js ───────────── */



/** The four rules for recognizing a cancel marker: each is [log tag fragment, key-value pair to check in the JSON] */
const CANCEL_RULES = [
  // DoneHandler: status:"canceled" (the JSON at the end of the whole line contains this field)
  ['DoneHandler', { status: (v) => String(v).toLowerCase() === 'canceled' || String(v).toLowerCase() === 'cancelled' }],
  // StreamDomainService: cancelReason:"stop_button" (both stop and esc are this)
  ['StreamDomainService', { cancelReason: (v) => !!v }],
  // NotificationPort: stopType:"cancel"
  ['NotificationPort', { stopType: (v) => String(v).toLowerCase() === 'cancel' || String(v).toLowerCase() === 'abort' }],
  // stream-diagnostics done: transformedStatus:"canceled" or stopType:"cancel"
  ['stream-diagnostics', null], // special handling: the line has both canceled and the "done" keyword
];

/**
 * Whether a line of renderer.log is TraeCode's cancel signal.
 * The line ends with a chunk of JSON (same shape as traeModels.js's model-store event parsing),
 * and only four structured markers carrying a sessionId are recognized.
 * @returns {{sessionId:string, at:number}|null} at = this line's timestamp (ms), 0 = unparseable
 */
function parseCancelLine(line) {
  if (!line || !/cancel|canceled|cancelled|stop_button/.test(line)) return null;
  // Extract sessionId (every one of the cancel markers carries it)
  const sidMatch = line.match(/"sessionId"\s*:\s*"([^"]+)"/) || line.match(/"chat_session_id"\s*:\s*"([^"]+)"/);
  const sid = sidMatch ? sidMatch[1] : '';
  if (!sid) return null;

  // The JSON at the end of the line (everything after the first {)
  const brace = line.indexOf('{');
  let j = null;
  if (brace >= 0) {
    try { j = JSON.parse(line.slice(brace)); } catch { j = null; }
  }

  let hit = false;
  if (j) {
    const s = JSON.stringify(j).toLowerCase();
    // ① DoneHandler: status:"canceled"
    if (j.status && /^cancel(ed|led)$/i.test(String(j.status))) hit = true;
    // ② StreamDomainService: cancelReason non-empty
    else if (j.cancelReason && typeof j.cancelReason === 'string') hit = true;
    // ③ NotificationPort: stopType:"cancel"
    else if (j.stopType && /^(cancel|abort|interrupt)/i.test(String(j.stopType))) hit = true;
    // ④ stream-diagnostics done: transformedStatus:"canceled"
    else if (j.transformedStatus && /^cancel(ed|led)$/i.test(String(j.transformedStatus))) hit = true;
  } else {
    // JSON parse failed —— next best thing, search the line directly for sessionId + cancel keywords
    hit = /cancel(ed|led)|stop_button|stopType.*cancel/i.test(line);
  }

  if (!hit) return null;

  // Timestamp: ISO format at the start of the line 2026-10-09T13:35:43.609+08:00
  const tsMatch = line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+/);
  let at = 0;
  if (tsMatch) {
    const at2 = Date.parse(tsMatch[0]);
    if (Number.isFinite(at2)) at = at2;
  }
  return { sessionId: sid, at };
}

/**
 * Read renderer.log in full (UTF-8). Trae's renderer.log is generally 1-5MB, not too big;
 * and it is cached by mtime+size (same criterion as traeModels.js), so an untouched file is not re-read
 * —— every full scan only really spends IO on the few files currently being written.
 *
 * Reading only the trailing 256KB was tried once (cancel signals "should" be appended at the end), but
 * measured behavior shows renderer.log runs several consecutive conversation rounds in the same window
 * (one round cancelled → a new one starts), pushing the old round's cancel signal into the middle of the
 * file, so reading only the tail loses every historical cancel. Scanning the whole file is safer.
 */
function readLog(f) {
  try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
}

/** File-level cache: path -> { mtimeMs, size, cancels: { [sessionId]: at } } */
const _fileCache = new Map();
/** Global TTL cache (avoid scanning the whole disk every time) */

let _cache = { at: 0, map: null };

/**
 * Scan every Trae renderer.log, aggregate cancel signals → `{ [sessionId]: latest cancel moment }`
 * Incremental by mtime+size (same criterion as traeModels.js).
 */
function allCancels() {
  const now = Date.now();
  if (_cache.map && now - _cache.at < TTL_MS) return _cache.map;

  const files = [];
  for (const logsRoot of traeLogRoots()) {
    for (const launch of safeReadDir(logsRoot)) {
      const launchDir = path.join(logsRoot, launch);
      if (!isDirSafe(launchDir)) continue;
      for (const win of safeReadDir(launchDir)) {
        if (!/^window/.test(win)) continue;
        const f = path.join(launchDir, win, 'renderer.log');
        try {
          const st = fs.statSync(f);
          if (st.isFile()) files.push({ f, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* skip */
        }
      }
    }
  }
  // Ascending mtime → later processing overwrites earlier (multiple cancels of one session take the last)
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.f < b.f ? -1 : 1));
  const seen = new Set(files.map((x) => x.f));
  for (const k of [..._fileCache.keys()]) if (!seen.has(k)) _fileCache.delete(k);

  const merged = {};
  for (const { f, mtimeMs, size } of files) {
    const hit = _fileCache.get(f);
    let fileMap;
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      fileMap = hit.map;
    } else {
      fileMap = parseFileCancels(f);
      _fileCache.set(f, { mtimeMs, size, map: fileMap });
    }
    for (const [sid, at] of Object.entries(fileMap)) {
      if (!merged[sid] || at > merged[sid]) merged[sid] = at;
    }
  }
  _cache = { at: now, map: merged };
  return merged;
}

/** One renderer.log → `{ [sessionId]: at }` */
function parseFileCancels(f) {
  const content = readLog(f);
  const out = {};
  for (const line of String(content || '').split('\n')) {
    const hit = parseCancelLine(line);
    if (!hit) continue;
    if (!out[hit.sessionId] || hit.at > out[hit.sessionId]) out[hit.sessionId] = hit.at;
  }
  return out;
}

/**
 * Whether this TraeCode session was cancelled by the user, and when.
 * @param {string} sessionId
 * @param {number} sinceTs only cancels after this moment count (0 = no filtering)
 * @returns {number} cancel moment (0 = not cancelled / not recognized)
 */
function traeCancelAt(sessionId, sinceTs = 0) {
  const sid = String(sessionId || '').trim();
  if (!sid) return 0;
  const map = allCancels();
  const at = Number(map[sid]) || 0;
  if (!at) return 0;
  if (sinceTs && at < sinceTs) return 0; // an old cancel does not count against the new round
  return at;
}

/* ─────────────────────────────────────────────────────────────────────
 * Trae DoneHandler scan —— the authoritative status signal for every round's end in renderer.log.
 *
 * Format:
 *   [DoneHandler] Stream done event received {"sessionId":"…","status":"completed|canceled","agentMessageId":"…"}
 *
 * Division of labor with allCancels() (which scans the earlier stop_button / NotificationPort cancel
 * signals):
 *   · readReporterPhase / readReporterActiveTask use traeCancelAt —— puncturing the phase as early as
 *     possible is best
 *   · flushTraeDone uses allDoneHandlers —— DoneHandler is the final state truth
 *   · readReporterDones synthesizes markers from DoneHandler —— completed/canceled cannot be wrong
 *
 * The cache reuses allCancels' mtime+size + TTL 15s criterion, scanning the same file set.
 * ───────────────────────────────────────────────────────────────────── */

/** Whether a line is a DoneHandler Stream done event —— carrying sessionId + status(completed|canceled) + agentMessageId */
function parseDoneHandlerLine(line) {
  if (!line || !/DoneHandler.*Stream done event received/.test(line)) return null;
  const brace = line.indexOf('{');
  let j = null;
  if (brace >= 0) {
    try { j = JSON.parse(line.slice(brace)); } catch { /* not valid JSON */ }
  }
  if (!j || !j.sessionId || !j.status) return null;
  const s = String(j.status).toLowerCase();
  if (s !== 'completed' && s !== 'canceled' && s !== 'cancelled') return null;
  const sid = String(j.sessionId);
  const agentMsg = j.agentMessageId ? String(j.agentMessageId) : '';
  // Timestamp: ISO format at the start of the line
  const tsMatch = line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+/);
  let at = 0;
  if (tsMatch) {
    const at2 = Date.parse(tsMatch[0]);
    if (Number.isFinite(at2)) at = at2;
  }
  return { sessionId: sid, agentMessageId: agentMsg, status: s === 'completed' ? 'completed' : 'canceled', at };
}

/** One renderer.log → DoneHandler event array (one per round, ascending by at, sessionId not deduped) */
function parseFileDoneHandlers(f) {
  const content = readLog(f);
  const out = [];
  const seen = new Set(); // the same line may be scanned twice → dedup by agentMessageId + at
  for (const line of String(content || '').split('\n')) {
    const hit = parseDoneHandlerLine(line);
    if (!hit) continue;
    const dedup = `${hit.sessionId}|${hit.agentMessageId}|${hit.at}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push(hit);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** File-level cache: path → { mtimeMs, size, handlers } */
const _doneFileCache = new Map();
/** Global TTL cache (avoid scanning the whole disk every time) —— same TTL as _cache (cancels) */
let _doneCache = { at: 0, list: null };

/**
 * Scan every Trae renderer.log, aggregate DoneHandler signals → event array
 * `[{sessionId, agentMessageId, status:'completed'|'canceled', at}, ...]`
 * Sorted ascending by at (one per round's end, never overwritten by sessionId).
 *
 * Same file set, same mtime+size increment, same TTL 15s as allCancels().
 */
function allDoneHandlers() {
  const now = Date.now();
  if (_doneCache.list && now - _doneCache.at < TTL_MS) return _doneCache.list;

  const files = [];
  for (const logsRoot of traeLogRoots()) {
    for (const launch of safeReadDir(logsRoot)) {
      const launchDir = path.join(logsRoot, launch);
      if (!isDirSafe(launchDir)) continue;
      for (const win of safeReadDir(launchDir)) {
        if (!/^window/.test(win)) continue;
        const f = path.join(launchDir, win, 'renderer.log');
        try {
          const st = fs.statSync(f);
          if (st.isFile()) files.push({ f, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* skip */ }
      }
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.f < b.f ? -1 : 1));
  const seen = new Set(files.map((x) => x.f));
  for (const k of [..._doneFileCache.keys()]) if (!seen.has(k)) _doneFileCache.delete(k);

  const merged = [];
  const globalSeen = new Set();
  for (const { f, mtimeMs, size } of files) {
    const hit = _doneFileCache.get(f);
    let arr;
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      arr = hit.handlers;
    } else {
      arr = parseFileDoneHandlers(f);
      _doneFileCache.set(f, { mtimeMs, size, handlers: arr });
    }
    for (const h of arr) {
      const dedup = `${h.sessionId}|${h.agentMessageId}|${h.at}`;
      if (globalSeen.has(dedup)) continue;
      globalSeen.add(dedup);
      merged.push(h);
    }
  }
  merged.sort((a, b) => a.at - b.at);
  _doneCache = { at: now, list: merged };
  return merged;
}

/**
 * What the latest round's DoneHandler status of this TraeCode session is.
 * @param {string} sessionId
 * @returns {{status:'completed'|'canceled', at:number, agentMessageId:string}|null} null = no DoneHandler
 *   scanned (still running / not recognized)
 */
function traeDoneStatus(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  const list = allDoneHandlers();
  let latest = null;
  for (const h of list) {
    if (h.sessionId === sid && (!latest || h.at > latest.at)) latest = h;
  }
  return latest;
}




/* ───────────── formerly traeTokens.js ───────────── */




let _usagesCache = { at: 0, list: null };




/**
 * One line of renderer.log → token usage event (only the one with action="show" counts; request_success
 * is a precursor and request_fail is a cancel scenario, neither is taken as the amount).
 * @returns {{sessionId:string, agentMessageId:string, userMessageId:string, usageYuan:number, ts:number}|null}
 */
function parseUsageLine(line) {
  if (!line || !line.includes('cn_session_usage_tail')) return null;
  const m = line.match(/params:\s*(\{.+?\})$/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[1]); } catch { return null; }
  if (j.action !== 'show') return null;

  const tsMatch = line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+/);
  let ts = 0;
  if (tsMatch) {
    const t = Date.parse(tsMatch[0]);
    if (Number.isFinite(t)) ts = t;
  }

  const yuan = Number(j.usage_summary);
  if (!Number.isFinite(yuan)) return null;

  return {
    sessionId: String(j.session_id || ''),
    agentMessageId: String(j.agent_message_id || ''),
    userMessageId: String(j.user_message_id || ''),
    usageYuan: yuan,
    ts,
  };
}

/** One renderer.log → the usage event array in that file */
function parseFileUsages(f) {
  const content = (() => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } })();
  const out = [];
  const seen = new Set();
  for (const line of String(content || '').split('\n')) {
    const hit = parseUsageLine(line);
    if (!hit || !hit.sessionId || !hit.agentMessageId) continue;
    const key = hit.sessionId + '|' + hit.agentMessageId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/**
 * Scan every Trae renderer.log, aggregate all cn_session_usage_tail events.
 * Cached incrementally by mtime+size (same criterion as traeCancel.js).
 * @returns {Array<{sessionId:string, agentMessageId:string, userMessageId:string, usageYuan:number, ts:number}>}
 */
function allTokenUsages() {
  const now = Date.now();
  if (_usagesCache.list && now - _usagesCache.at < TTL_MS) return _usagesCache.list;

  const files = [];
  for (const logsRoot of traeLogRoots()) {
    for (const launch of safeReadDir(logsRoot)) {
      const launchDir = path.join(logsRoot, launch);
      if (!isDirSafe(launchDir)) continue;
      for (const win of safeReadDir(launchDir)) {
        if (!/^window/.test(win)) continue;
        const f = path.join(launchDir, win, 'renderer.log');
        try {
          const st = fs.statSync(f);
          if (st.isFile()) files.push({ f, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* skip */ }
      }
    }
  }

  // File-level cache: each file is parsed once per mtime+size
  const _fileCache = new Map();
  const results = [];
  for (const { f, mtimeMs, size } of files) {
    const hit = _fileCache.get(f);
    let arr;
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      arr = hit.list;
    } else {
      arr = parseFileUsages(f);
      _fileCache.set(f, { mtimeMs, size, list: arr });
    }
    results.push(...arr);
  }

  // Global dedup: the same sessionId + agentMessageId may span files (old files are kept),
  // the one with the largest ts wins
  const global = new Map();
  for (const r of results) {
    const key = r.sessionId + '|' + r.agentMessageId;
    const old = global.get(key);
    if (!old || r.ts > old.ts) global.set(key, r);
  }
  const list = [...global.values()].sort((a, b) => b.ts - a.ts);

  _usagesCache = { at: now, list };
  return list;
}

/**
 * Only the token consumption events of a given session.
 * @param {string} sessionId
 */
function traeTokenOf(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return [];
  return allTokenUsages().filter((r) => r.sessionId === sid);
}


/* ───────────── Subagent contributions (IdeSubagentContribution) ─────────────
 * Trae IDE's subagents (experts) do not report Task/Agent tool calls through the hook system,
 * they only leave a post-hoc report signal in renderer.log. Format:
 *   [tooling] [IdeSubagentContribution] downstream SDK report started:
 *     source=ide_subagent, sessionId=..., parentOperationId=..., operationId=...,
 *     documentUri=file:///..., acceptCodeLength=N, line=N
 *
 * source=ide_agent is the main agent itself and is not recorded; only source=ide_subagent counts.
 * This is a post-hoc signal (the subagent has finished and its code was accepted), it cannot drive a live
 * ghost —— but it can be backfilled into the subagent call list in task details.
 */

/**
 * One line of renderer.log → subagent contribution event.
 * Only IdeSubagentContribution lines with source=ide_subagent count.
 * @returns {{sessionId:string, operationId:string, documentUri:string, acceptCodeLength:number, at:number}|null}
 */
function parseSubagentLine(line) {
  if (!line || !line.includes('IdeSubagentContribution')) return null;
  // Only source=ide_subagent counts (the main agent's own is not recorded)
  if (!/source=ide_subagent/.test(line)) return null;
  // Only report started / report succeeded (the detail lines carrying documentUri),
  // skip report finished (a summary line with no documentUri / acceptCodeLength)
  if (!/report (started|succeeded)/.test(line)) return null;

  const sessionId = (line.match(/sessionId=([^,]+)/) || [])[1] || '';
  // operationId has a lowercase o, so it never mismatches parentOperationId (capital O)
  const operationId = (line.match(/\boperationId=([^,]+)/) || [])[1] || '';
  const documentUri = (line.match(/documentUri=([^,]+)/) || [])[1] || '';
  const acceptCodeLength = parseInt((line.match(/acceptCodeLength=(\d+)/) || [])[1] || '0', 10);

  if (!sessionId || !operationId) return null;

  // Timestamp: ISO format at the start of the line
  const tsMatch = line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+/);
  let at = 0;
  if (tsMatch) {
    const t = Date.parse(tsMatch[0]);
    if (Number.isFinite(t)) at = t;
  }

  // documentUri is in file:///... format, convert to a local path
  let filePath = '';
  if (documentUri) {
    try { filePath = decodeURIComponent(documentUri.replace(/^file:\/\//, '')); } catch { filePath = documentUri; }
  }

  return { sessionId: sessionId.trim(), operationId: operationId.trim(), documentUri: filePath, acceptCodeLength, at };
}

/** One renderer.log → subagent contribution event array */
function parseFileSubagents(f) {
  const content = readLog(f);
  const out = [];
  const seen = new Set();
  for (const line of String(content || '').split('\n')) {
    const hit = parseSubagentLine(line);
    if (!hit) continue;
    const dedup = `${hit.sessionId}|${hit.operationId}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push(hit);
  }
  return out;
}

/** File-level cache: path → { mtimeMs, size, list } */
const _subagentFileCache = new Map();
/** Global TTL cache */
let _subagentCache = { at: 0, list: null };

/**
 * Scan every Trae renderer.log, aggregate subagent contribution events.
 * Cached incrementally by mtime+size (same criterion as allCancels / allTokenUsages).
 * @returns {Array<{sessionId, operationId, documentUri, acceptCodeLength, at}>}
 */
function allSubagentContribs() {
  const now = Date.now();
  if (_subagentCache.list && now - _subagentCache.at < TTL_MS) return _subagentCache.list;

  const files = [];
  for (const logsRoot of traeLogRoots()) {
    for (const launch of safeReadDir(logsRoot)) {
      const launchDir = path.join(logsRoot, launch);
      if (!isDirSafe(launchDir)) continue;
      for (const win of safeReadDir(launchDir)) {
        if (!/^window/.test(win)) continue;
        const f = path.join(launchDir, win, 'renderer.log');
        try {
          const st = fs.statSync(f);
          if (st.isFile()) files.push({ f, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* skip */ }
      }
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.f < b.f ? -1 : 1));
  const seen = new Set(files.map((x) => x.f));
  for (const k of [..._subagentFileCache.keys()]) if (!seen.has(k)) _subagentFileCache.delete(k);

  const merged = [];
  const globalSeen = new Set();
  for (const { f, mtimeMs, size } of files) {
    const hit = _subagentFileCache.get(f);
    let arr;
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      arr = hit.list;
    } else {
      arr = parseFileSubagents(f);
      _subagentFileCache.set(f, { mtimeMs, size, list: arr });
    }
    for (const item of arr) {
      const dedup = `${item.sessionId}|${item.operationId}`;
      if (globalSeen.has(dedup)) continue;
      globalSeen.add(dedup);
      merged.push(item);
    }
  }
  merged.sort((a, b) => a.at - b.at);
  _subagentCache = { at: now, list: merged };
  return merged;
}

/**
 * Background flush: backfill Trae subagent contributions into the subagent_runs table.
 * Called by flushBackend (same cycle as flushTraeDone / flushTraeYuan).
 * @param {number} now current moment
 * @param {object} backend { bus, repo }
 */
const postedSubagent = new Map(); // key → expiry timestamp (in-memory dedup, after a restart the DB's hasSubagentByName is the fallback)

function flushTraeSubagents(now, backend) {
  const { repo } = backend || {};
  if (!repo) return;
  const contribs = allSubagentContribs();
  if (!contribs.length) return;

  // sessionId → { projectId }, looked up from the hook state file (same as flushTraeDone / flushTraeYuan)
  const hookDir = hooksDir();
  const sidProject = new Map();
  try {
    for (const f of fs.readdirSync(hookDir)) {
      if (!/\.json$/i.test(f)) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(hookDir, f), 'utf8')); } catch { continue; }
      if (!j || !j.sessionId) continue;
      const ws = (j.done && j.done.workspacePath) || j.taskWorkspacePath || j.sessionWorkspacePath || '';
      if (!ws) continue;
      const proj = repo.getProjectByWorkspace ? repo.getProjectByWorkspace.get(path.resolve(ws)) : null;
      if (proj) sidProject.set(j.sessionId, proj.id);
    }
  } catch { /* no hook dir */ }

  for (const c of contribs) {
    const sid = c.sessionId;
    if (!sid || !c.operationId) continue;
    const projectId = sidProject.get(sid);
    if (!projectId) continue;

    // Find the task this session was running when the contribution event happened (serial execution → the
    // newest one with started_at <= at)
    const task = repo.latestTaskBySession ? repo.latestTaskBySession.get(projectId, sid, c.at, c.at) : null;
    if (!task) continue;

    // DB-level dedup: the same parent task + the same operationId is not backfilled twice
    const exists = repo.hasSubagentByName ? repo.hasSubagentByName.get(task.id, c.operationId) : null;
    if (exists && exists.c > 0) continue;

    // In-memory dedup (avoid retrying within the same flush cycle)
    const key = `${task.id}|${c.operationId}`;
    if (postedSubagent.get(key) > now) continue;

    // Build member_id: subagent-<first 8 chars of operationId>@<project> (same format as hook-driven ones)
    const memberId = `subagent-${c.operationId.slice(0, 8)}@${projectId}`;
    // files_json: which files were changed
    const filesJson = c.documentUri
      ? JSON.stringify([{ path: c.documentUri, added: c.acceptCodeLength || 0, removed: 0 }])
      : null;
    // result: how many lines of code were accepted
    const result = c.acceptCodeLength > 0 ? `采纳 ${c.acceptCodeLength} 行` : '';

    try {
      repo.insertSubagentContribution.run({
        projectId,
        parentTaskId: task.id,
        memberId,
        name: c.operationId,
        client: 'trae',
        title: c.documentUri || '',
        result,
        filesJson,
        startedAt: c.at || null,
        endedAt: c.at || null,
      });
      postedSubagent.set(key, now + 10 * 60_000);
    } catch { /* a failed backfill does not affect the ledger */ }
  }
  for (const [k, v] of postedSubagent) if (v <= now) postedSubagent.delete(k);
}







const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

/** The ItemTable key where TraeCode records "which model each session selected" (prefix is the user id, only the suffix is matched) */
const TRAE_MODEL_KEY_SUFFIX = ':AI.agent.model.session_selected_model';
/** vscdb is a DB TraeCode itself is writing: open it once and keep it a moment, do not reopen it on every 1.5s fast poll */
const TRAE_MODEL_TTL_MS = 15_000;
let traeModelCache = { at: 0, map: null };

/** The marker of model-change events in renderer.log (the line ends with a chunk of JSON, appended line by line, append-only) */
const TRAE_LOG_EVENT = 'session selected model changed';
/** Log scanning also carries a TTL + an mtime/size increment: an unchanged file is not re-read */
let traeLogCache = { at: 0, map: null };
const traeLogFileCache = new Map(); // renderer.log absolute path → { mtimeMs, size, map }

/**
 * Get the model name out of TraeCode's modelId: `solo_agent_1__deepseek-v4.1-flash_null` → `deepseek-v4.1-flash`.
 * This format was cross-checked against TraeCode's own renderer.log (`agent_1__Doubao-Seed-Code_null` ↔
 * `Doubao-Seed-Code`).
 * Returns an empty string when it cannot be decoded —— no guessing.
 */
function traeModelName(modelId) {
  const s = String(modelId || '');
  const i = s.indexOf('__');
  if (i < 0) return '';
  return s.slice(i + 2).replace(/_null$/, '');
}

/**
 * Old Trae's "session → currently selected model" table (globalStorage state.vscdb).
 * @returns {Object|null} null when it cannot be read (not installed / DB busy / no such key)
 */
function traeSelectedModelsFromDb() {
  const now = Date.now();
  if (traeModelCache.map && now - traeModelCache.at < TRAE_MODEL_TTL_MS) return traeModelCache.map;
  for (const root of traeGlobalStorageRoots()) {
    const dbFile = path.join(root, 'state.vscdb');
    let db = null;
    try {
      if (!fs.existsSync(dbFile)) continue;
      const Database = require('better-sqlite3');
      db = new Database(dbFile, { readonly: true, fileMustExist: true });
      const rows = db.prepare('select value from ItemTable where key like ?').all(`%${TRAE_MODEL_KEY_SUFFIX}`);
      for (const r of rows) {
        const map = JSON.parse(String(r.value || '{}'));
        if (map && typeof map === 'object' && Object.keys(map).length) {
          traeModelCache = { at: now, map };
          return map;
        }
      }
    } catch {
      // the DB is held by TraeCode / the table shape is not as expected: if it cannot be read this round
      // it counts as absent, the upper layer leaves it empty
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          /* failing to close does not affect what was read */
        }
      }
    }
  }
  traeModelCache = { at: now, map: null };
  return null;
}

/**
 * Parse the model-change events in a chunk of renderer.log text → `{ sessionId: { agentLabel: { modelId } } }`.
 * The shape deliberately matches vscdb's table (only the key swaps agentType for the log's agentLabel ——
 * the value domain is the same, so both ends of selectedModelOf's fallback chain work with it).
 * A line whose trailing JSON fails to parse (a half-written line) skips that entry.
 */
function parseTraeLogEvents(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(TRAE_LOG_EVENT);
    if (i < 0) continue;
    const brace = line.indexOf('{', i);
    if (brace < 0) continue;
    try {
      const j = JSON.parse(line.slice(brace));
      const sid = String(j.sessionId || '').trim();
      const modelId = j.nextSelection && j.nextSelection.modelId ? String(j.nextSelection.modelId) : '';
      const label = String(j.agentLabel || j.agentType || '').trim();
      if (!sid || !modelId || !label) continue;
      (out[sid] = out[sid] || {})[label] = { modelId };
    } catch {
      /* half line / not JSON: skip */
    }
  }
  return out;
}



/**
 * New Trae's fallback table: aggregated from the event stream in logs/<launch>/windowN/renderer.log.
 * Incremental by mtime: an unchanged file (neither mtime nor size moved) reuses the previous parse result,
 * and only the file currently being written is re-read. Directories are processed in ascending mtime order,
 * later ones overwrite earlier ones —— the same session takes its latest event.
 * @returns {Object|null} null when there is not a single event
 */
function traeSelectedModelsFromLogs() {
  const now = Date.now();
  if (traeLogCache.map && now - traeLogCache.at < TRAE_MODEL_TTL_MS) return traeLogCache.map;
  const files = [];
  for (const logsRoot of traeLogRoots()) {
    for (const launch of safeReadDir(logsRoot)) {
      const launchDir = path.join(logsRoot, launch);
      if (!isDirSafe(launchDir)) continue;
      for (const win of safeReadDir(launchDir)) {
        if (!/^window/.test(win)) continue;
        const f = path.join(launchDir, win, 'renderer.log');
        try {
          const st = fs.statSync(f);
          if (st.isFile()) files.push({ f, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* a window with no renderer.log: skip */
        }
      }
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.f < b.f ? -1 : 1));
  const seen = new Set(files.map((x) => x.f));
  for (const k of [...traeLogFileCache.keys()]) if (!seen.has(k)) traeLogFileCache.delete(k);
  let merged = null;
  for (const { f, mtimeMs, size } of files) {
    const hit = traeLogFileCache.get(f);
    let map;
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      map = hit.map;
    } else {
      try {
        map = parseTraeLogEvents(fs.readFileSync(f, 'utf8'));
      } catch {
        map = {};
      }
      traeLogFileCache.set(f, { mtimeMs, size, map });
    }
    if (map && Object.keys(map).length) merged = { ...(merged || {}), ...map };
  }
  traeLogCache = { at: now, map: merged };
  return merged;
}

/**
 * TraeCode's "session → currently selected model" table: the old version goes through vscdb, the new one
 * through log events, merged by session id (a given session id only exists on one of the two paths; if it
 * somehow exists on both, the structured on-disk vscdb wins).
 * @returns {Object|null} null when neither path yields anything
 */
function traeSelectedModels() {
  const db = traeSelectedModelsFromDb();
  const logs = traeSelectedModelsFromLogs();
  if (!db) return logs;
  if (!logs) return db;
  return { ...logs, ...db };
}

/**
 * Which model this TraeCode session is using.
 * @param {string} sessionId the hook payload's session_id
 * @param {string} agentType the hook payload's agent_type (already on disk), decides whether to take the
 *   agent / solo_agent entry
 * @returns {string} empty string when it cannot be had
 */
function selectedModelOf(sessionId, agentType = '') {
  const sid = String(sessionId || '').trim();
  if (!sid) return '';
  const sel = (traeSelectedModels() || {})[sid];
  if (!sel) return '';
  const prefer = String(agentType || '').trim();
  for (const k of [prefer, 'solo_agent', 'agent', 'solo_coder']) {
    if (k && sel[k] && sel[k].modelId) {
      const name = traeModelName(sel[k].modelId);
      if (name) return name;
    }
  }
  return '';
}



/**
 * Trae's background flush: backfill "the only truth about the end state" into the ledger. Called by
 * sessionRegistry's floor loop (it runs before the generic flush, otherwise superseded would first turn
 * Trae's normally finished running tasks into cancelled).
 * Two actions: ① DoneHandler status → bus.endTask (final state truth); ② usage_tail → only the amount is
 * filled in.
 *
 * All of 5F's interaction with the ledger is concentrated here, so debugging Trae never requires touching
 * sessionRegistry.
 * @param {object} ctx the shared context the framework provides (now / backend)
 */
const postedDoneHandler = new Map(); // key → expiry timestamp
const postedYuan = new Map(); // key → expiry timestamp

function flushTraeDone(now, backend) {
  const { bus, repo } = backend || {};
  if (!bus || typeof bus.endTask !== 'function' || !repo) return;
  const handlers = allDoneHandlers();
  if (!Object.keys(handlers).length) return;

  // sessionId → { projectId, workspacePath }, looked up from the hook state file (same as flushTraeYuan)
  const hookDir = hooksDir();
  const sidProject = new Map();
  try {
    for (const f of fs.readdirSync(hookDir)) {
      if (!/\.json$/i.test(f)) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(hookDir, f), 'utf8')); } catch { continue; }
      if (!j || !j.sessionId) continue;
      // The Trae hook clears taskWorkspacePath and writes the path into done.workspacePath once the task
      // finishes —— same as Claude/CodeBuddy, prefer done.workspacePath as the fallback
      // (see sessions.js:658, floorCodebuddy.js:242)
      const ws = (j.done && j.done.workspacePath) || j.taskWorkspacePath || j.sessionWorkspacePath || '';
      if (!ws) continue;
      const proj = repo.getProjectByWorkspace ? repo.getProjectByWorkspace.get(path.resolve(ws)) : null;
      if (proj) sidProject.set(j.sessionId, { projectId: proj.id, workspacePath: ws });
    }
  } catch { /* no hook dir */ }

  // Process in ascending at —— the earliest DoneHandler matches the earliest finished running task first
  const sorted = [...handlers].sort((a, b) => a.at - b.at);
  for (const h of sorted) {
    const sid = h.sessionId;
    if (!sid || !h.at) continue;
    const info = sidProject.get(sid);
    if (!info) continue;
    const key = `${sid}|${h.agentMessageId}|${h.status}|${h.at}`;
    if (postedDoneHandler.get(key) > now) continue;
    const proj = repo.getProjectByWorkspace ? repo.getProjectByWorkspace.get(info.workspacePath) : null;
    if (!proj) continue;
    const all = repo.listStaleRunningBySession ? repo.listStaleRunningBySession.all(proj.id, sid) : [];
    const atH = Number(h.at) || 0;
    const match = all
      .filter((r) => Number(r.startedAt) && (!atH || Number(r.startedAt) <= atH))
      .sort((a, b) => Number(b.startedAt) - Number(a.startAt))[0];
    if (!match) continue;
    const state = h.status === 'completed' ? 'done' : 'cancelled';
    const task = repo.getTask ? repo.getTask.get(match.id) : null;
    if (!task) continue;
    postedDoneHandler.set(key, now + 10 * 60_000);
    try {
      bus.endTask({
        project: proj.id,
        memberId: task.member_id,
        taskId: match.id,
        state,
        model: task.model || '',
        result: String(task.result || ''),
        form: task.form || '',
        sessionId: sid,
        ts: h.at, // when DoneHandler was written = the real end moment of this round
      });
    } catch { /* a failed re-emission does not affect the ledger */ }
  }
  for (const [k, v] of postedDoneHandler) if (v <= now) postedDoneHandler.delete(k);
}

function flushTraeYuan(now, backend) {
  const { repo } = backend || {};
  if (!repo) return;
  const usages = allTokenUsages();
  if (!usages.length) return;

  const hookDir = hooksDir();
  const sidProject = new Map();
  try {
    for (const f of fs.readdirSync(hookDir)) {
      if (!/\.json$/i.test(f)) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(hookDir, f), 'utf8')); } catch { continue; }
      if (!j || !j.sessionId) continue;
      // Same as above: once the Trae hook finishes, taskWorkspacePath is cleared and the path lives in
      // done.workspacePath
      const ws = (j.done && j.done.workspacePath) || j.taskWorkspacePath || j.sessionWorkspacePath || '';
      if (!ws) continue;
      const proj = repo.getProjectByWorkspace ? repo.getProjectByWorkspace.get(path.resolve(ws)) : null;
      if (proj) sidProject.set(j.sessionId, { projectId: proj.id, workspacePath: ws });
    }
  } catch { /* no hook dir */ }

  for (const u of usages) {
    const sid = u.sessionId;
    if (!sid) continue;
    const info = sidProject.get(sid);
    if (!info) continue;
    const key = `${sid}|${u.agentMessageId}|${u.usageYuan}`;
    if (postedYuan.get(key) > now) continue;
    const row = repo.runAwaitingYuan.get(info.projectId, sid, u.ts);
    if (!row) continue;
    repo.setTaskRunYuan.run({ id: row.id, usageYuan: u.usageYuan });
    postedYuan.set(key, now + 10 * 60_000);
  }
  for (const [k, v] of postedYuan) if (v <= now) postedYuan.delete(k);
}

function flushBackend(ctx) {
  const now = ctx.now;
  const backend = ctx.backend;
  flushTraeDone(now, backend);
  flushTraeYuan(now, backend);
  flushTraeSubagents(now, backend);
}

/**
 * Whether this "running" reporter phase is voided by this floor's cancel marker.
 * When TraeCode cancels, the Stop hook does not fire and the phase freezes at the moment before the cancel,
 * so only the moment of DoneHandler's status:"canceled" in renderer.log can puncture it (see traeCancelAt).
 * For readReporterPhase in sessions.js to dispatch.
 * @param {object} j hook state file
 * @param {object} sp the state file's sessionPhase
 * @param {number} slack phase timestamp tolerance (ms)
 */
function phaseSuperseded(j, sp, slack = 1_000) {
  const at = traeCancelAt(j.sessionId, Number(j.taskStartedAt) || 0);
  return !!at && at + slack >= Number(sp.ts || 0);
}

/* ───────────── Hook event handling (added after the refactor) ─────────────
 * Trae IDE's hook event payload has no session_id field,
 * so in runHookEvent sessionId = String(ev.session_id || '') → empty string,
 * and the guard in sessionGet/sessionSet (if(!id)return) makes the whole live state chain spin in place:
 *   in the Stop handler, get().taskId is forever undefined → endTask is never called → the task stays
 *   running forever.
 *
 * Fix: in handleHookEvent's entry point, fill session_id in from the Trae hook state file already on disk,
 * so Trae also walks runHookEvent's full chain (writing to the in-memory Map → the Stop handler can get
 * taskId).
 *
 * interruptedSince is covered too —— Trae's cancel signal is in renderer.log (DoneHandler status:"canceled"
 * / stop_button / NotificationPort), not in the transcript, so traeCancelAt scans renderer.log. */
const { runHookEvent, sharedHookImpl } = require('./ingest/hookCommon');

/**
 * Fill in sessionId from an existing Trae hook state file.
 * Matching workspacePath takes priority; failing that it falls back to the newest one (by mtime).
 * @param {string} workspacePath
 * @returns {string} sessionId (empty string = not found)
 */
function _inferSessionIdFromStateFile(workspacePath) {
  const dir = hooksDir();
  let names;
  try { names = fs.readdirSync(dir); } catch { return ''; }

  const files = names
    .filter((n) => n.startsWith('trae') && n.endsWith('.json'))
    .map((n) => ({ name: n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!files.length) return '';

  // Prefer the file matching workspacePath (file names are sanitized, so sanitize before comparing)
  const wsPart = String(workspacePath || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (wsPart) {
    for (const f of files) {
      if (f.name.includes(wsPart)) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, f.name), 'utf8'));
          const sid = String(j.sessionId || '').trim();
          if (sid) return sid;
        } catch { /* skip */ }
      }
    }
  }

  // Fall back to the newest one
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, files[0].name), 'utf8'));
    return String(j.sessionId || '').trim();
  } catch {
    return '';
  }
}

const traeImpl = {
  ...sharedHookImpl,
  // Trae IDE is a standalone product form: not a VS Code plugin (isPluginClient only recognizes vscode),
  // and not a CLI ('cli'); returning 'IDE' makes clientLabel fall back to the base name "TraeCode" (none of
  // the three branches hit)
  formOf: () => 'IDE',
  // Trae's cancel signal is in renderer.log (DoneHandler status:"canceled" / stop_button /
  // NotificationPort), not in the transcript. traeCancelAt scans renderer.log.
  // Signature (tp, since, sessionId) —— the third parameter is passed in by runHookEvent.
  interruptedSince: (tp, since, sessionId) => Boolean(traeCancelAt(sessionId, since)),
};

async function handleHookEvent(ev, ctx) {
  // Trae hook event payloads carry no session_id —— inject it from the hook state file already on disk
  if (!String(ev.session_id || '').trim()) {
    const inferred = _inferSessionIdFromStateFile(ctx.workspacePath || '');
    if (inferred) ev.session_id = inferred;
  }
  return runHookEvent(ev, ctx, traeImpl);
}

module.exports = {
  // 5F TraeCode
  id: '5F',
  client: 'trae',
  meta,
  flushBackend,
  // Cancel detection (formerly traeCancel.js)
  allCancels,
  allDoneHandlers,
  traeDoneStatus,
  // Token amounts (formerly traeTokens.js)
  allTokenUsages,
  // Static subagent dirs (project / user level): read by this floor's own syncAgents
  agentDirs,
  // Register this floor's user / project subagents with the roster (see agentLevel.makeAgentSync)
  syncAgents: makeAgentSync(agentDirs, meta.agent),
  traeTokenOf,
  // Subagent contribution backfill (IdeSubagentContribution → subagent_runs)
  allSubagentContribs,
  // Model completion (formerly traeModels.js)
  selectedModelOf,
  traeModelName,
  traeSelectedModels,
  parseTraeLogEvents,
  // Unified interface aliases
  cancelAt: traeCancelAt,
  modelOf: selectedModelOf,
  phaseSuperseded,
  // Done / cancel marker synthesis: dispatched uniformly by readReporterDones (sessions.js's common code
  // keeps no Trae-specific logic)
  synthMarks,
  // Hook event handling (reporter state file on disk → session table → main console phase)
  handleHookEvent,
};

/**
 * Floor-specific "done/cancel" marker synthesis, dispatched uniformly by readReporterDones in sessions.js.
 * No TraeCode-specific logic is written in the common code: this only recognizes Trae's own renderer.log
 * (DoneHandler / allCancels).
 *
 * Why scan independently rather than hooking onto the state file's `if (j.taskId)`:
 *   · When Trae cancels, the Stop hook does not fire, so renderer.log is the only authoritative signal.
 *   · The hook state file is "one per session", and starting a new round overwrites the old taskId /
 *     taskStartedAt wholesale; hooking onto startedAt would filter out the old cancel signal as soon as
 *     the "previous round cancelled → new round started" window passes.
 *   · The render layer decides what to show by "whose phase.ts vs done.at is newer"; an old done.at with a
 *     new phase.ts → the new round overwrites cancelled, so no false red light and no smart filtering
 *     needed.
 *
 * @param {object} ctx
 *   { workspacePath, client, hookBySid, clientHit, roundFilesOf, synthCancel, synthDone, bySession }
 */
function synthMarks(ctx) {
  const { workspacePath, client, hookBySid, clientHit, roundFilesOf, synthCancel, synthDone, bySession, now } = ctx;
  // Freshness window of the done/cancel marker: same criterion as sessions.js reading j.done (DONE_TTL_MS =
  // 10 minutes).
  // Without this, a DoneHandler from 3 days ago in renderer.log would push into latest, and an old session's
  // cancel marker would resurrect across days.
  const DONE_TTL_MS = 10 * 60_000;
  // ── Scan DoneHandler first (final state truth) ──
  // completed → synthesize a normal done marker (cancelled:false, overwriting a possible cancelled:true)
  // canceled  → synthesize a cancel marker (same as synthCancel)
  const handlers = allDoneHandlers();
  for (const h of handlers) {
    const sid = h.sessionId;
    if (!sid || !h.at) continue;
    const hook = hookBySid.get(sid);
    const j = hook ? hook.j : null;
    const hookWs = j ? ((j.done && j.done.workspacePath) || j.taskWorkspacePath || '') : '';
    if (workspacePath && hookWs && path.resolve(hookWs) !== path.resolve(workspacePath)) continue;
    if (j && client && !clientHit(client, j.client)) continue;
    // Leftover DoneHandler from the previous round: h.at belongs to an earlier round (< the current round's
    // taskStartedAt), so once the new round has started the previous round's done/cancel marker must not be
    // stuffed into bySession —— reporter-phase would return that old done together with the new taskTitle,
    // and the frontend would see doneAt change and mistake it for "task finished".
    if (j && Number(j.taskStartedAt) && h.at < Number(j.taskStartedAt)) continue;
    // TTL: a DoneHandler from 3 days ago must not push into latest (an old session's cancel marker
    // resurrecting across days)
    if (now && now - h.at > DONE_TTL_MS) continue;
    if (h.status === 'completed') {
      // DoneHandler completed → a normal done marker (cancelled:false), overwriting any cancelled:true
      // already in bySession;
      // only overwrite when DoneHandler's at is greater —— a completed signal should arrive later than a
      // cancel signal.
      synthDone({
        id: sid,
        ws: hookWs || workspacePath || '',
        at: h.at,
        title: (j && j.taskTitle) || '',
        files: [],
      });
    } else {
      // DoneHandler canceled → same as synthCancel; skip when the same cancel (±5s tolerance) already
      // exists, to avoid synthesizing it twice
      const existing = bySession.get(sid);
      if (existing && existing.cancelled && Math.abs(Number(existing.at) - h.at) < 5_000) continue;
      synthCancel({
        id: sid,
        j: j ? { taskTitle: j.taskTitle || '', client: j.client } : { taskTitle: '', client: 'trae' },
        ws: hookWs || workspacePath || '',
        at: h.at,
        files: j ? roundFilesOf(j) : [],
      });
    }
  }

  // ── Then scan allCancels (the earlier cancel signal, as a supplement) ──
  // If DoneHandler already wrote a mark for that session → skip (DoneHandler is more authoritative)
  const traeCancels = allCancels();
  const traeSids = Object.keys(traeCancels || {});
  if (traeSids.length) {
    for (const sid of traeSids) {
      const atC = Number(traeCancels[sid]) || 0;
      if (!atC) continue;
      if (bySession.has(sid)) continue;
      const hook = hookBySid.get(sid);
      const j = hook ? hook.j : null;
      // Same as above: the previous round's cancel signal (atC < the current taskStartedAt) resurrecting
      // across rounds, skip
      if (j && Number(j.taskStartedAt) && atC < Number(j.taskStartedAt)) continue;
      // TTL: an old session's cancel marker is expired and must not push into latest
      if (now && now - atC > DONE_TTL_MS) continue;
      const hookWs = j ? ((j.done && j.done.workspacePath) || j.taskWorkspacePath || '') : '';
      if (workspacePath && hookWs && path.resolve(hookWs) !== path.resolve(workspacePath)) continue;
      if (j && client && !clientHit(client, j.client)) continue;
      synthCancel({
        id: sid,
        j: j ? { taskTitle: j.taskTitle || '', client: j.client } : { taskTitle: '', client: 'trae' },
        ws: hookWs || workspacePath || '',
        at: atC,
        files: j ? roundFilesOf(j) : [],
      });
    }
  }
}
