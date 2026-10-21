'use strict';

/**
 * Server-side generic hook-event runner + product-agnostic helpers.
 *
 * This is the "server-side" version of the hook.js event handling: once the CLI hook became a pure
 * forwarder, all the on-disk parsing / session state / ledger writing moved here. Design goals:
 *   · **product-agnostic parts** (file extraction, todo progress, ghost persistence, token read,
 *     event switches) are written once;
 *   · **product differences** (reply parsing, file lists, interrupt detection, form, token flavor)
 *     come from each floor via `impl`, so "floorXXX handles its own on-disk differences" really holds.
 *
 * Session state: replaces the hook's state file, kept per sessionId in the dispatcher's in-memory map
 * (see hookDispatch.js).
 * Ghosts: summon / retire / sweep write straight to the DB (an ephemeral member + a subagent_run),
 * living and dying with the session and parent task (see the bus ghost API).
 *
 * Usage: each floor exports `handleHookEvent(ev, ctx)` → `return runHookEvent(ev, ctx, impl)`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const log = require('../log');
const { updateJson } = require('@workgremlin/shared/fslock');
const { fnv1a32, isPluginClient } = require('@workgremlin/shared');
const { hooksDir, statePath } = require('@workgremlin/shared/paths');
const { isFile } = require('../roots');

/* ============================== constants (kept in sync with hook.js) ============================== */
const RESULT_MAX = 4_000;
const MSG_MAX = 8_000;
const MAX_REPLIES = 50;
const PENDING_SPAWN_MS = 2 * 60_000;
// CodeBuddy-specific constants (CB_REQ_GRACE_MS / CB_FLUSH_WAIT_MS / CB_FLUSH_STEP_MS) have moved to floorCodebuddy.js
// -- they are consumed only by the CodeBuddy floor, and no longer pollute the framework layer

/**
 * Tool names that actually write/modify a file. Read-only tools (Read, Grep, Glob, ReadLints, LS …)
 * never count: collecting every tool that carries a file_path put files the turn only read into the
 * task detail's changed-file list. The same set decides whether PreToolUse waits for a permission
 * round-trip, since only a write prompts for one.
 *
 * Measured against the tools the hook-path floors (Claude / CodeBuddy / Codex / Qoder / Trae) really
 * emit, so a new product's write tool has to be added here.
 */
const WRITE_TOOLS = new Set([
  'Edit', 'MultiEdit', 'NotebookEdit', 'Write', 'Delete',
  'replace_in_file', 'write_to_file', 'delete_file',
  'apply_patch',
]);

const INJECTED_PROMPT_RE = /^\s*<(?:task-notification|agent-message)[\s>]/i;

function isSubagentTool(tool) {
  return /^(task|agent|spawn_agent|collaborationspawn_agent)$/i.test(String(tool || '').trim());
}

/* ============================== product-agnostic: files / progress ============================== */

/** The target file in the tool input (CodeBuddy: file_path/filePath; Codex: the patch text of apply_patch) */
function filesOf(input, tool) {
  if (typeof input === 'string') input = { command: input };
  if (!input || typeof input !== 'object') return [];
  const p = input.file_path || input.filePath || input.path || input.notebook_path || input.target_file || '';
  if (typeof p === 'string' && p) return [p];
  if (String(tool || '') === 'apply_patch') return patchPaths(patchText(input));
  return [];
}

function fileOf(input, tool) {
  return filesOf(input, tool)[0] || '';
}

function patchText(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const t = input.command || input.input || input.patch || input.diff || '';
  return typeof t === 'string' ? t : '';
}

function patchPaths(text) {
  const out = [];
  const re = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  let m = re.exec(text);
  while (m) {
    const f = m[1].trim();
    if (f && !out.includes(f)) out.push(f);
    m = re.exec(text);
  }
  return out;
}

/** The authoritative list in the apply_patch result: the `M/A/D <path>` lines after `Success. Updated the following files:` */
function patchOutputFiles(text) {
  const src = String(text || '');
  const i = src.indexOf('Success. Updated the following files');
  if (i < 0) return [];
  const out = [];
  for (const line of src.slice(i).split('\n').slice(1)) {
    const m = line.match(/^[ \t]*([MAD])[ \t]+(\S.*?)[ \t]*$/);
    if (!m) {
      if (out.length) break;
      continue;
    }
    out.push({ path: m[2].trim(), op: m[1] === 'M' ? 'edit' : m[1] === 'A' ? 'write' : 'delete' });
  }
  return out;
}

/** Read the files actually changed this round from Codex's rollout transcript (the apply_patch authoritative list) */
function transcriptRoundFiles(transcriptPath, sinceTs) {
  if (!transcriptPath || typeof transcriptPath !== 'string' || !(Number(sinceTs) > 0)) return [];
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return [];
  }
  const out = [];
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    const p = obj && obj.payload;
    if (!p || typeof p !== 'object') continue;
    if (p.type !== 'custom_tool_call_output' && p.type !== 'function_call_output') continue;
    const ts = Date.parse(String((obj && obj.timestamp) || '')) || 0;
    if (ts && ts < Number(sinceTs)) continue;
    out.push(...patchOutputFiles(p.output));
  }
  return out;
}

function opOf(tool) {
  const t = String(tool || '');
  if (t === 'apply_patch') return 'edit';
  if (/delete/i.test(t)) return 'delete';
  return /^(Edit|MultiEdit|NotebookEdit|replace_in_file)$/.test(t) ? 'edit' : 'write';
}

/** Extract "task progress" (completed / total) from the input of TodoWrite-like tools */
function todoProgress(tool, input) {
  if (!input || typeof input !== 'object') return null;
  if (!/todo/i.test(String(tool || ''))) return null;
  const arr = input.todos || input.todo_list || input.todoList || input.items || [];
  if (!Array.isArray(arr) || !arr.length) return null;
  let done = 0;
  for (const t of arr) {
    const s = String((t && t.status) || '').toLowerCase();
    if (s === 'completed' || s === 'done' || s === 'finished') done += 1;
    else if (s === 'in_progress' || s === 'progress' || s === 'active' || s === 'inprogress') done += 0.5;
  }
  return Math.min(1, done / arr.length);
}

/** Record a relative path inside the project, an absolute path outside it */
function relFile(file, cwd) {
  if (!file) return '';
  const abs = path.resolve(file);
  if (cwd && (abs === cwd || abs.startsWith(cwd + path.sep))) return path.relative(cwd, abs);
  return abs;
}

/** The user's own words: strip out the context injected by the IDE plugin */
function userRequestText(raw) {
  const text = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi, '');
  if (!text.trim()) return '';
  const injected =
    /^[ \t]*#{0,6}[ \t]*Context from my IDE setup\b/im.test(text) ||
    /^[ \t]*#{1,6}[ \t]*(?:Active file|Open tabs)\b/im.test(text);
  if (!injected) return text.trim();
  const parts = text.split(
    /^[ \t]*#{0,6}[ \t]*(?:My request|User request|Request|我的请求|用户请求)[ \t]*[:：][ \t]*$/im
  );
  return parts.length > 1 ? parts.slice(1).join('\n').trim() : '';
}

/** Fallback: scan by file mtime for the files touched this round (the first two approaches are blind when the agent changes files via shell) */
function touchedSince(ws, sinceTs) {
  if (!ws || !(Number(sinceTs) > 0)) return [];
  const git = (args) =>
    execSync(`git ${args}`, {
      cwd: ws,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  let list;
  try {
    const tracked = git('ls-files -z --cached').split('\0').filter(Boolean);
    const others = git('ls-files -z --others --exclude-standard').split('\0').filter(Boolean);
    list = [...tracked.map((p) => [p, 'edit']), ...others.map((p) => [p, 'write'])];
  } catch {
    return [];
  }
  if (list.length > 30000) return [];
  const out = [];
  for (const [rel, op] of list) {
    if (!rel || rel.startsWith('.git/')) continue;
    try {
      if (fs.statSync(path.resolve(ws, rel)).mtimeMs >= Number(sinceTs) - 2000) out.push({ path: rel, op });
    } catch {
      /* deleted / unreadable */
    }
    if (out.length >= 200) break;
  }
  return out;
}

/** Files changed this round (after startedAt): three-way merge (PostToolUse records + transcript patch + mtime scan), deduplicated by absolute path + sizes filled in */
function collectRoundFiles(st, ev, cwd, startedAt, workspacePath) {
  const roundFiles = ((st && st.roundFiles) || []).filter((x) => x && (typeof x === 'string' ? x : x.path));
  const baseDir = cwd || workspacePath;
  const byAbs = new Map();
  for (const x of roundFiles) {
    const p = typeof x === 'string' ? x : x.path;
    if (!p) continue;
    const abs = (typeof x === 'object' && x.abs) || path.resolve(baseDir, p);
    byAbs.set(abs, { path: p, op: typeof x === 'string' ? null : x.op, abs });
  }
  const tp = (ev && ev.transcript_path) || (st && st.transcriptPath) || '';
  for (const t of transcriptRoundFiles(tp, startedAt)) {
    const abs = path.resolve(baseDir, t.path);
    const prev = byAbs.get(abs);
    byAbs.set(abs, prev || { path: relFile(abs, baseDir), op: t.op, abs });
  }
  for (const t of touchedSince(baseDir, startedAt)) {
    const abs = path.resolve(baseDir, t.path);
    const prev = byAbs.get(abs);
    byAbs.set(abs, prev || { path: relFile(abs, baseDir), op: t.op, abs });
  }
  return [...byAbs.values()].map((x) => {
    const p = x.path;
    const op = x.op || null;
    let size = null;
    if (op !== 'delete') {
      const candidates = [x.abs, p, cwd ? path.resolve(cwd, p) : null, path.resolve(workspacePath, p)].filter(Boolean);
      for (const cp of candidates) {
        try {
          const s0 = fs.statSync(cp);
          if (s0.isFile()) {
            size = s0.size;
            break;
          }
        } catch {
          /* try the next candidate */
        }
      }
    }
    return { path: p, op, size };
  });
}

function stopReasonCancelled(ev) {
  const r = String((ev && (ev.final_stop_reason || ev.stop_reason || ev.reason)) || '')
    .trim()
    .toLowerCase();
  return r === 'cancelled' || r === 'canceled' || r === 'interrupted' || r === 'aborted';
}

/* ============================== reply dedupe key ============================== */

function replyKeyOf(reply) {
  const id = String((reply && reply.id) || '').trim();
  if (id) return id;
  return 'h' + fnv1a32(String((reply && reply.text) || ''));
}

function aiDedupeKey(floor, sessionId, msgId) {
  return `ai:${floor}:${String(sessionId || 'nosession')}:${String(msgId || 'noid')}`;
}

/* ============================== Reply parsing (product-agnostic: jsonl / codebuddy index.json) ============================== */

/** Extract human-readable text from content blocks (handles string / [{type,text}] / {text}, skipping tool_use/tool_result/thinking) */
function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((x) => {
        if (!x || typeof x !== 'object') return '';
        if (typeof x.text !== 'string') return '';
        const t = x.type == null ? '' : String(x.type);
        if (!t || /^(text|output_text|input_text|summary_text)$/.test(t)) return x.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text.trim();
  return '';
}

/** The "message body" in a transcript record, normalized to {role, content, id} (handles Codex payload / generic message / top level) */
function msgOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const p = obj.payload;
  if (p && typeof p === 'object' && typeof p.role === 'string' && p.content !== undefined) {
    return { role: p.role, content: p.content, id: String(p.id || '') };
  }
  const m = obj.message;
  if (m && typeof m === 'object' && typeof m.role === 'string' && m.content !== undefined) {
    return { role: m.role, content: m.content, id: String(m.id || '') };
  }
  if (typeof obj.role === 'string') return { role: obj.role, content: obj.content, id: String(obj.id || '') };
  return null;
}

const INTERRUPT_HINT_RE = /turn_aborted|Request interrupted by user/i;

/** Whether a JSONL line is a structured "the user interrupted this round" event (Codex turn_aborted / Claude·Qoder's user marker) */
function isInterruptLine(o) {
  if (!o || typeof o !== 'object') return false;
  const p = o.payload;
  if (o.type === 'event_msg' && p && typeof p === 'object' && p.type === 'turn_aborted') {
    const reason = String(p.reason || '').toLowerCase();
    return !reason || reason === 'interrupted' || reason === 'aborted' || reason === 'cancelled' || reason === 'canceled';
  }
  if (o.type === 'user' && o.message && typeof o.message === 'object') {
    const c = o.message.content;
    const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text) : [];
    return texts.some((t) => /^\s*\[?request interrupted by user/i.test(String(t || '')));
  }
  return false;
}

/** Assistant messages after the last user message */
function sinceLastUser(items) {
  let start = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].role === 'user') {
      start = i + 1;
      break;
    }
  }
  return items.slice(start).filter((x) => x.role === 'assistant' && x.text);
}

/** JSONL of generic / Claude Code / Codex rollouts: one JSON per line */
function jsonlReplies(file) {
  if (!file || typeof file !== 'string' || !isFile(file)) return [];
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
  const items = [];
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (isInterruptLine(obj)) continue; // a user line marked as an interrupt doesn't count as a "new round of user questions" boundary
    const m = msgOf(obj);
    if (!m) continue;
    items.push({ role: String(m.role), id: m.id, text: extractText(m.content) });
  }
  return sinceLastUser(items);
}

/**
 * Conversation body parsing for the IDE plugin form (the index.json format) -- shared by CodeBuddy / Qoder.
 * Format: the index history/<sessionId>/index.json (indented multi-line JSON, not JSONL), with bodies in messages/<id>.json
 * ({role, message:"<JSON string>"}) in the same directory. One round of replies is split into several assistant
 * fragments in the index; the fragments are joined into one by the last request, with the dedupe key using the request id.
 */
function indexJsonReplies(indexPath) {
  const dir = path.dirname(indexPath);
  let idx;
  try {
    idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return [];
  }
  const msgs = Array.isArray(idx && idx.messages) ? idx.messages : [];
  const byId = new Map(msgs.map((m) => [m && m.id, m]));
  const read = (id) => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'messages', `${id}.json`), 'utf8'));
      const inner = typeof raw.message === 'string' ? JSON.parse(raw.message) : raw.message;
      return extractText(inner && inner.content !== undefined ? inner.content : inner);
    } catch {
      return '';
    }
  };
  const reqs = Array.isArray(idx && idx.requests) ? idx.requests : [];
  const req = reqs.length ? reqs[reqs.length - 1] : null;
  if (req && Array.isArray(req.messages) && req.messages.length) {
    const parts = [];
    for (const id of req.messages) {
      const m = byId.get(id);
      if (!m || String(m.role) !== 'assistant') continue;
      const t = read(id);
      if (t) parts.push(t);
    }
    const text = parts.join('\n\n').trim();
    if (text) return [{ id: String(req.id || req.startedAt || 'last'), text }];
  }
  // No requests index (old version): fall back to "each assistant fragment after the last user message counts as one"
  return sinceLastUser(msgs.map((m) => ({ role: String((m && m.role) || ''), id: String((m && m.id) || ''), text: m && m.id ? read(m.id) : '' })));
}

/** Read the first few lines of the session's on-disk file (for form detection, reads only a window, not the whole file) */
function headJsonLines(file, maxLines = 20) {
  if (!file || typeof file !== 'string') return [];
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.slice(0, n).toString('utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const ln of head.split('\n').slice(0, maxLines)) {
    const s = ln.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      break;
    }
  }
  return out;
}

/** Whether this round shows traces of being interrupted by the user (for products with "no explicit Interrupt event"): Codex turn_aborted / Claude·Qoder's user marker */
function turnInterrupted(transcriptPath, startedAt) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return false;
  let raw = '';
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return false;
  }
  if (!INTERRUPT_HINT_RE.test(raw)) return false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line || !INTERRUPT_HINT_RE.test(line)) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isInterruptLine(o)) continue;
    if (!startedAt) return true;
    const ts = Date.parse(String(o.timestamp || ''));
    if (Number.isFinite(ts) && ts >= startedAt) return true;
  }
  return false;
}

/* ============================== token reading (moved from usage.js, product-agnostic) ============================== */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function tsOf(o) {
  const t = o && o.timestamp;
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  const n = Date.parse(String(t || ''));
  return Number.isFinite(n) ? n : 0;
}

function parseLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const out = [];
  for (const ln of raw.split('\n')) {
    const s = ln.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') out.push(o);
    } catch {
      /* half a line */
    }
  }
  return out;
}

function normAnthropic(u) {
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
}

function normOpenAI(u) {
  const prompt = num(u.prompt_tokens);
  const details = u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object' ? u.prompt_tokens_details : {};
  const cacheRead = num(u.prompt_cache_hit_tokens) || num(details.cached_tokens) || num(u.cached_tokens);
  const cacheWrite = num(u.prompt_cache_write_tokens);
  return {
    input: Math.max(0, prompt - cacheRead - cacheWrite),
    output: num(u.completion_tokens) || num(u.output_tokens),
    cacheRead,
    cacheWrite,
  };
}

function usageOf(row) {
  const raw = row.providerData && row.providerData.rawUsage;
  if (raw && typeof raw === 'object' && 'prompt_tokens' in raw) {
    return { kind: 'openai', u: raw, key: String(row.id || row.callId || ''), ts: tsOf(row) };
  }
  const m = row.message;
  const u = m && m.usage;
  if (u && typeof u === 'object') {
    if ('cache_creation_input_tokens' in u) {
      return { kind: 'anthropic', u, key: String(m.id || row.uuid || ''), ts: tsOf(row) };
    }
    if ('prompt_tokens' in u) {
      return { kind: 'openai', u, key: String(row.id || row.uuid || ''), ts: tsOf(row) };
    }
  }
  return null;
}

function requestSum(rows, startedAt) {
  const seen = new Set();
  let acc = null;
  for (const row of rows) {
    const got = usageOf(row);
    if (!got) continue;
    if (!got.ts || got.ts < startedAt) continue;
    if (got.key) {
      if (seen.has(got.key)) continue;
      seen.add(got.key);
    }
    const part = got.kind === 'anthropic' ? normAnthropic(got.u) : normOpenAI(got.u);
    if (!acc) acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    acc.input += part.input;
    acc.output += part.output;
    acc.cacheRead += part.cacheRead;
    acc.cacheWrite += part.cacheWrite;
  }
  return acc;
}

function codexDelta(rows, startedAt) {
  const evs = [];
  for (const o of rows) {
    if (!o || o.type !== 'event_msg') continue;
    const p = o.payload;
    if (!p || p.type !== 'token_count') continue;
    const t = p.info && p.info.total_token_usage;
    if (!t || typeof t !== 'object') continue;
    evs.push({ ts: tsOf(o), t });
  }
  if (!evs.length) return null;
  let base = null;
  for (const e of evs) if (e.ts && e.ts <= startedAt) base = e;
  const last = evs[evs.length - 1];
  if (!base && last.ts && last.ts < startedAt) return null;
  const from = base ? base.t : {};
  const d = (k) => Math.max(0, num(last.t[k]) - num(from[k]));
  return normOpenAI({
    prompt_tokens: d('input_tokens'),
    prompt_cache_hit_tokens: d('cached_input_tokens'),
    prompt_cache_write_tokens: d('cache_write_input_tokens'),
    completion_tokens: d('output_tokens'),
  });
}

function tokenFinish(t) {
  if (!t) return null;
  if (t.input + t.output + t.cacheRead + t.cacheWrite <= 0) return null;
  return t;
}

/**
 * The tokens a round of tasks consumed -- the framework-layer primitive for parsing the **pure JSONL format**.
 *
 * These are the "formats the framework understands": Codex rollout jsonl (event_msg/token_count), Claude Code transcript
 * (message.usage / providerData.rawUsage). When a floor has a more exotic format (such as the IDE plugin's index.json,
 * or OTel trace jsonl), the floor's own readTokensOf override handles it -- the framework layer doesn't care about format variety.
 *
 * Returns `{input, output, cacheRead, cacheWrite} | null` -- null when unavailable or when all four are zero.
 * A floor's readTokensOf follows the same rule, and the server-side bus.endTask / backfillTaskTokens consume this shape uniformly.
 */
function readTokens(jsonlPath, startedAt) {
  const file = String(jsonlPath || '');
  if (!file || !(Number(startedAt) > 0)) return null;
  const rows = parseLines(file);
  if (!rows) return null;
  const t = codexDelta(rows, Number(startedAt)) || requestSum(rows, Number(startedAt));
  return tokenFinish(t);
}

/* ============================== subagent key composition ============================== */

function agentName(input) {
  if (!input || typeof input !== 'object') return 'subagent';
  const n = input.subagent_type || input.subagent_name || input.task_name || input.name || input.agent || '';
  return String(n).trim() || 'subagent';
}

function agentTask(input) {
  if (!input || typeof input !== 'object') return '';
  const d = input.description || input.prompt || input.message || '';
  return String(d).replace(/\s+/g, ' ').trim().slice(0, 80);
}

function agentIdOf(ev) {
  return String((ev && (ev.agent_id || ev.agentId)) || '').trim();
}

/**
 * Whether a hook event was emitted from inside a subagent.
 *
 * Codex subagent threads reuse the **parent's** `session_id` and put their own thread id in
 * `agent_id` (the rollout's `session_meta` has `session_id` = parent, `id` = the subagent thread).
 * Such events describe the subagent's own turn, not a new round of the main agent. SubagentStart /
 * SubagentStop are the lifecycle events that *report* a subagent and are handled on purpose, so
 * callers must apply this gate to the main-round events only.
 */
function isSubagentEvent(ev) {
  const aid = agentIdOf(ev);
  if (!aid) return false;
  const sid = String((ev && ev.session_id) || '').trim();
  return aid !== sid;
}

/**
 * The event's **per-call** ids, in priority order — the ids that name one summoned instance.
 * The raw half of subagentKeys, factored out so the two cannot drift apart: a caller that needs to
 * know "did this event name an instance?" must agree with the caller that composes the keys.
 * @param {any} ev
 * @returns {string[]}
 */
function callIdsOf(ev) {
  return [ev && ev.tool_use_id, ev && ev.toolUseId, ev && ev.call_id, ev && ev.tool_call_id]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
}

function subagentKeys(ev, name, task) {
  const out = [];
  const push = (k) => {
    if (k && !out.includes(k)) out.push(k);
  };
  for (const s of callIdsOf(ev)) push(s);
  const mk = (fields) => {
    const parts = fields.map((v) => String(v == null ? '' : v).trim());
    return parts.join('').replace(/\|/g, '') ? `k${fnv1a32(parts.join('|'))}` : '';
  };
  const sid = ev && ev.session_id;
  const aid = ev && ev.agent_id;
  const gen = ev && ev.generation_id;
  push(mk([sid, aid, name, task, gen]));
  push(mk([sid, name, task]));
  push(mk([name, task]));
  return out;
}

function resultOfResponse(ev) {
  // PostToolUse carries the tool output in tool_response; SubagentStop carries the subagent's
  // closing summary in last_assistant_message (required by Codex's schema).
  const r = ev && (ev.tool_response != null ? ev.tool_response : ev.last_assistant_message);
  if (r == null) return '';
  let s = '';
  if (typeof r === 'string') s = r;
  else if (typeof r === 'object') {
    const c = r.content != null ? r.content : r.result;
    if (typeof c === 'string') s = c;
    else if (Array.isArray(c)) {
      s = c.map((x) => (x && typeof x === 'object' ? String(x.text || '') : String(x || ''))).join(' ').trim();
    } else if (c != null) s = String(c);
  }
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/* ============================== ghosts (subagent summons) ==============================
 * The hook is a pure forwarder, so these run server-side: summon / retire / sweep write straight
 * into the DB (an ephemeral member + a subagent_run; tied to the session and the parent task),
 * instead of a manifest file. Ownership = project + floor (client) + session + parent task, and
 * the ghost lives and dies with the task state. */

/**
 * The main agent summoned a subagent → record a ghost (ephemeral member) + a subagent_run, tied to
 * the session and the parent task.
 * @param {any} bus
 * @param {string} project project id
 */
function addGhost(bus, project, workspacePath, name, task, id, parent, model, client, session = '', identity = {}) {
  if (!bus || typeof bus.ghostSpawn !== 'function') return null;
  return bus.ghostSpawn({
    project,
    workspacePath,
    client,
    sessionId: session,
    name: name || 'subagent',
    task,
    id,
    parentTaskId: parent,
    model,
    agentId: identity.agentId,
    background: identity.background,
  });
}

/** Forward a subagent stop; the bus owns exact matching, retirement and background wake-up recovery. */
function retireGhost(bus, project, name, id, result, client, session = '', agentId = '') {
  if (!bus || typeof bus.ghostRetire !== 'function') return false;
  return bus.ghostRetire({ project, client, sessionId: session, name, id, agentId, result });
}

/** Attach a product-reported child identity to an already-open summon without closing it. */
function bindGhostIdentity(bus, project, name, id, agentId, background, client, session = '') {
  if (!bus || typeof bus.ghostBindIdentity !== 'function') return false;
  return bus.ghostBindIdentity({
    project,
    client,
    sessionId: session,
    name,
    id,
    agentId,
    background: Boolean(background),
  });
}

/**
 * Sweep one session's (or one floor's) ghosts: close their runs, drop the ephemeral members; also
 * retain background summons in the session ledger until their exact completion signal or cancellation.
 * @param {{all?: boolean, state?: string}} opts
 */
function sweepGhosts(bus, project, client, opts = {}, session = '', sessionState = null) {
  const n =
    bus && typeof bus.ghostSweep === 'function'
      ? bus.ghostSweep({
          project,
          client,
          sessionId: session,
          all: Boolean(opts && opts.all),
          state: opts && opts.state,
        })
      : 0;
  if (sessionState && Array.isArray(sessionState.subagents)) {
    sessionState.subagents = opts && opts.all ? [] : sessionState.subagents.filter((r) => r && r.background);
  }
  return n;
}

/* ============================== reply storage (replaces reportAiReplies) ============================== */
async function reportReplies(ctx, memberId, taskId, replies, sessionId, floor) {
  const { bus, project, workspacePath } = ctx;
  if (!Array.isArray(replies) || !replies.length) return;
  const list = replies.slice(-MAX_REPLIES);
  const now = Date.now();
  await Promise.all(
    list
      .map((r, i) => {
        const content = String(r.text || '').trim();
        if (!content) return null;
        const ts = Number(r.ts) > 0 ? Number(r.ts) : now - (list.length - 1 - i);
        return bus.recordMessage({
          project,
          workspacePath,
          memberId: memberId,
          from: floor,
          to: null,
          type: i === list.length - 1 ? 'result' : 'task_update',
          subject: null,
          content: content.slice(0, MSG_MAX),
          taskId: taskId || null,
          ts,
          dedupeKey: aiDedupeKey(floor, sessionId, replyKeyOf(list[i])),
        });
      })
      .filter(Boolean)
  );
}

/* ============================== form (cli / plugin) detection ============================== */

/**
 * Take the event's explicit form when present. Legacy events reported the shell form in
 * `client`; keep accepting that shape, but agent identity remains `ev.agent`.
 */
function fixedFormOf(ev) {
  const form = String((ev && ev.form) || '').toLowerCase();
  if (form) return form;
  const legacy = String((ev && ev.client) || '').toLowerCase();
  if (!legacy) return null;
  return isPluginClient(legacy) ? legacy : 'cli';
}

/* ============================== generic event switch (faithfully ported from hook.js main) ============================== */

/**
 * Handle one hook event. Product differences are injected via `impl`; everything else (files/progress/token/ghost/event switch) lives in this module.
 * @param {object} ev the raw hook event
 * @param {{project:string, workspacePath:string, bus:any, sessionGet:Function, sessionSet:Function}} ctx
 * @param {object} impl product differences
 */

/**
 * The real-time phase write point for hook events.
 *
 * The refactor moved session state into the dispatcher's in-memory Map (see hookDispatch.js),
 * but `/reporter-phase` and `freshestReporterWs` / listSessions(current/fresh) still read the
 * `<floor>@<workspace>@<session>.json` file. The plugin path (IDE extensions writing directly)
 * writes that file; the hook path (CodeBuddy / Codex / Trae / Qoder …) used to only
 * `set` in memory — so those floors' real-time phase was never readable and the main console's
 * phase hung. Every `set` now syncs the same state to disk, matching the plugin path.
 *
 * The location and naming come from shared/paths.js (single source of truth).
 */

/**
 * The public default hook behavior: floor modules fall back to this for any interface they don't provide themselves (see each floorXXX.js's handleHookEvent).
 * Each floor assembles impl with `{ ...sharedHookImpl, ...this floor's overrides }`, so uncovered fields automatically use the public default.
 *
 * The new `transcriptPathOf` and `readTokensOf` let floors push product-specific transcript path derivation / format parsing
 * down into their own files -- the framework layer only does event dispatch and state management, and doesn't hardcode CodeBuddy/Claude/Codex paths.
 */
const sharedHookImpl = {
  coarse: false,
  coarseTitle: '',
  hasPermissionEvent: false,
  hasSubagentStart: false,
  subagentStopMatchesSpawn: true,
  /** Optional product override for identifying events emitted inside a subagent turn. */
  subagentEventOf: null,
  /** Optional product parser for an asynchronous subagent launch receipt: { agentId, background }. */
  subagentLaunchOf: () => null,
  /** Optional product parser for a background-child handback prompt: { agentId }. */
  subagentHandbackOf: () => null,
  awaitingPermission: null,
  repliesOf: (tp) => jsonlReplies(tp),
  interruptedSince: (tp, since, sessionId) => turnInterrupted(tp, since),
  formOf: () => '',
  /**
   * This round's transcript path. Default: use it if the event payload has it, empty otherwise.
   * CodeBuddy override: hook events often carry no transcript_path (the Plugin form and some CLI forms),
   * so two candidate locations have to be reverse-derived from sessionId + workspacePath (see floorCodebuddy.js).
   */
  transcriptPathOf: (ev, st, sessionId, workspacePath) => String((ev && ev.transcript_path) || ''),
  /**
   * This round's token reading. Default: the pure JSONL format (Codex rollout / Claude transcript).
   * CodeBuddy override: three-way dispatch (index.json via codebuddyRequestTokens,
   * OTel span traces via codebuddyTraceTokens, projects jsonl via requestSum).
   */
  readTokensOf: (tp, startedAt) => readTokens(tp, startedAt),
};

async function runHookEvent(ev, ctx, floorImpl) {
  const impl = { ...sharedHookImpl, ...(floorImpl || {}) };
  const { bus, project, workspacePath, sessionGet, sessionSet } = ctx;
  const event = ev && ev.hook_event_name;
  if (!event) return { ok: false, error: 'missing hook_event_name' };
  // Floors opt in explicitly. The default keeps the original Codex-only behavior, while Claude can
  // use agent_id without pretending it emits SubagentStart.
  const fromSubagent = typeof impl.subagentEventOf === 'function'
    ? Boolean(impl.subagentEventOf(ev))
    : Boolean(impl.hasSubagentStart && isSubagentEvent(ev));

  const memberId = String(ev.agent);
  const client = String(ev.agent || '').trim().toLowerCase();
  let sessionId = String(ev.session_id || '');
  // sessionId format validation: only blocks clearly dirty data (ghost- prefixed test forgeries)
  // No longer restricts to hex/UUID formats -- test session IDs (cancel-a etc.) and each product's
  // session ID formats vary widely (UUID, 16hex, 24hex, dashed strings, etc.), and an overly narrow format
  // check would kill legitimate session IDs, causing the state file to go unwritten -> phase and tasks all break.
  if (sessionId && /^ghost-/i.test(sessionId)) {
    log.error('[hookCommon] ignoring ghost- session_id:', sessionId);
    sessionId = '';
  }
  const cwd = String(ev.cwd || '');
  // client = the floor's product base name, consistent with memberId's base name; floor uses it directly to represent the floor,
  // unified with registerMember's contract (client is the floor), avoiding client / floor being computed separately in two places,
  // and the client field not matching floor filters when writing the phase file (see readReporterPhase's clientHit).
  const get = () => sessionGet(sessionId) || {};
  // A stable project path / project id: each event's cwd drifts (e.g. Bash runs under home and only cd's into the project inside the command),
  // so using it directly to derive project would push the same session onto some non-project path -> requireMember resolves to "<product base name>@home",
  // which doesn't match "<product base name>@<project path>" -> bus.toolUse / status are skipped entirely (tool counts all empty, state not updated).
  // Prefer the project directory left by this round's task (that's the project directory at UserPromptSubmit), falling back to this event's workspacePath.
  const stableWs = get().taskWorkspacePath || workspacePath;
  const stableProject = bus.projectForReport('', stableWs) || project;
  const base = { project: stableProject, workspacePath: stableWs, memberId, sessionId };
  // Dual-write to the in-memory Map (dispatcher) and the on-disk state file: the former is the server's single source of truth, the latter is for /reporter-phase,
  // listSessions(current/fresh) to read the real-time phase. Writing only to memory would lose the real-time phase of hook-type floors (see the comment above).
  const set = (patch) => {
    sessionSet(sessionId, patch);
    // The phase file's workspacePath must use the "project path", not the cwd the tool ran in: cwd drifts with every command
    // (e.g. Bash runs under home and only cd's into the project inside the command), which both splits the same session's phase
    // into multiple files by cwd, and makes the frontend consoleBase's sameWs comparison fail -> the main console stops receiving
    // the real-time "calling tool" phase (falling back to a stale snapshot). The project path prefers this round's taskWorkspacePath
    // (the one left at UserPromptSubmit is the project directory), falling back to this event's workspacePath.
    const effWs = get().taskWorkspacePath || workspacePath;
    if (!client || !sessionId) return;
    try {
      fs.mkdirSync(hooksDir(), { recursive: true });
      updateJson(
        statePath(client, effWs, sessionId),
        (prev) => {
          const next = {
            ...(prev || {}),
            client,
            form: formOf(),
            sessionId,
            ...patch,
            hb: { pid: process.pid, lastEventAt: Date.now() },
          };
          // Normalize the workspacePath inside the phase to the project path as well (otherwise sameWs comparison fails)
          if (next.sessionPhase) next.sessionPhase.workspacePath = effWs;
          return next;
        },
        { fallback: {} }
      );
    } catch {
      /* a failure to write to disk doesn't affect the agent's main flow */
    }
    // Restart recovery: updateJson is async and lock-based, so the updater above hasn't run before this function returns,
    // and we can't rely on it to pass back next. A server restart clears the dispatcher's in-memory sessions Map, while the on-disk phase file
    // retains taskId -- read it synchronously and feed taskId back into memory, otherwise the next bus.toolUse gets skipped entirely
    // because get().taskId is empty -> "calls per tool" in the task details all empty.
    try {
      const onDisk = JSON.parse(fs.readFileSync(statePath(client, effWs, sessionId), 'utf8') || '{}');
      if (onDisk && onDisk.taskId && !get().taskId) {
        sessionSet(sessionId, {
          taskId: onDisk.taskId,
          taskWorkspacePath: onDisk.taskWorkspacePath,
          taskTitle: onDisk.taskTitle,
          taskStartedAt: onDisk.taskStartedAt,
        });
      }
    } catch {
      /* skip the backfill when the disk can't be read */
    }
  };

  // Cache the transcript path (later events take it from the session state; for the hook's original logic see the SessionStart section).
  // Subagent hooks share the parent session id but their transcript_path points at the subagent
  // rollout; caching it would make the parent's Stop read the subagent's replies and tokens.
  if (ev.transcript_path && !fromSubagent) set({ transcriptPath: String(ev.transcript_path) });
  // tp() goes through impl.transcriptPathOf: by default only the event payload is recognized; floors can override it to derive the path
  // (some products' hook events carry no transcript_path, so it has to be reverse-derived from sessionId+workspacePath).
  const tp = () => String(impl.transcriptPathOf(ev, get(), sessionId, workspacePath) || get().transcriptPath || '');

  const setBlocked = (reason) =>
    bus.setBlocked({
      ...base,
      ...(reason ? { reason } : {}),
    });
  const clearBlocked = () => bus.clearBlocked({ ...base });
  // The main agent's floor identity is put into client: memberId's base name (= ev.agent) and client are both the product base name,
  // unified with static gremlins / ghosts under the convention "client = the floor (product base name), memberId only as primary key".
  const register = () => bus.registerMember({ ...base, name: memberId, role: 'agent', client });

  // The plugin form is preferably decided by the event's self-reported form (vscode is just a shell, and the rollout header often still says cli, so it can't be guessed),
  // with the on-disk header only as a fallback. The hook already passes the raw form through, so plugin is recognized by it here.
  const formOf = () => fixedFormOf(ev) || impl.formOf(tp());

  // Backfill the previous round's tokens (used at the start of a new round) -- goes through impl.readTokensOf, letting the floor decide which parser to use
  async function backfillPrevTokens(prevDone, transcriptPath) {
    const startedAt = Number(prevDone && prevDone.startedAt) || 0;
    if (!transcriptPath || !(startedAt > 0)) return;
    const tokens = await impl.readTokensOf(transcriptPath, startedAt);
    if (!tokens) return;
    await bus.backfillTaskTokens({ ...base, startedAt, tokens, sessionId });
  }

  // Delayed token backfill: the plugin's index.json usage often hasn't landed on disk yet at the Stop/cancel moment
  // (codebuddyReadTokensOf only retries for 1200ms, which isn't reliable), and backfillPrevTokens only fires "at the start of the next round"
  // -- the last task has no next round, so its tokens can never be backfilled. Here we wait a few seconds after endTask and read/write back once more,
  // ensuring the finishing task gets its tokens too (setTimeout doesn't block Stop handling). Reading is still server-side, writing back to task_runs.
  const TOKEN_BACKFILL_DELAY_MS = 5_000;
  function scheduleDelayedBackfill(startedAt, transcriptPath) {
    const sa = Number(startedAt) || 0;
    if (!transcriptPath || !(sa > 0)) return;
    setTimeout(async () => {
      try {
        const tokens = await impl.readTokensOf(transcriptPath, sa);
        if (!tokens) return;
        await bus.backfillTaskTokens({ ...base, startedAt: sa, tokens, sessionId });
      } catch { /* a failure reading from disk doesn't affect the main flow */ }
    }, TOKEN_BACKFILL_DELAY_MS);
  }

  // This round was killed by the user -> finish it as "cancelled" (same line as Stop, with three differences)
  async function finishCancelled(ev0) {
    const st0 = get();
    let taskId0 = st0.taskId || '';
    let startedAt0 = Number(st0.taskStartedAt) || 0;
    if (!taskId0) {
      const cur = typeof bus.currentTaskFor === 'function' ? bus.currentTaskFor(project, memberId, sessionId) : null;
      if (cur && cur.taskId) {
        taskId0 = cur.taskId;
        if (!startedAt0 && cur.startedAt) startedAt0 = Number(cur.startedAt) || 0;
      }
    }
    const replies0 = impl.repliesOf(tp());
    await reportReplies(ctx, memberId, taskId0, replies0, sessionId, client);
    // Detached background children survive the parent turn, while foreground children are closed
    // with this cancellation. Explicit session teardown still sweeps every remaining child.
    sweepGhosts(bus, stableProject, client, { state: 'cancelled' }, sessionId, st0);
    const files0 = collectRoundFiles(st0, ev0, cwd, startedAt0, workspacePath);
    const last0 = replies0.length ? replies0[replies0.length - 1].text : '';
    const said0 = String(last0 || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const result0 = String(last0 || '').trim().slice(0, RESULT_MAX);
    if (taskId0) {
      const transcriptPath = tp();
      const tokens0 = await impl.readTokensOf(transcriptPath, startedAt0);
      await bus.endTask({
        ...base,
        taskId: taskId0,
        state: 'cancelled',
        model: String(ev0.model || ''),
        result: result0,
        files: files0,
        fileCount: files0.length,
        form: formOf(),
        ...(tokens0 ? { tokens: tokens0 } : {}),
      });
      scheduleDelayedBackfill(startedAt0, transcriptPath);
    }
    set({
      taskId: null,
      taskWorkspacePath: '',
      taskStartedAt: 0,
      roundFiles: [],
      sessionPhase: { phase: 'idle', ts: Date.now(), workspacePath },
      done: {
        at: Date.now(),
        title: st0.taskTitle || '',
        workspacePath,
        startedAt: startedAt0,
        said: said0,
        sessionId,
        files: files0.slice(0, 8),
        fileCount: files0.length,
        cancelled: true,
      },
    });
    await clearBlocked();
  }

  if (event === 'SessionStart') {
    const st = get();
    /**
     * Context compaction is **not** a new session.
     *
     * Codex / Claude re-fire SessionStart with `source: 'compact'` every time the context is
     * auto-compacted, and that happens **in the middle of a running turn** (measured 2026-10-19,
     * 3F Codex: 20+ compactions inside one 25-minute task). The reset below is for a genuinely new
     * session; applied to a compaction it wiped taskId / taskStartedAt from the state file and
     * pushed the session to idle and lost the round's tool attribution. A compaction must keep the
     * existing running task intact because task liveness comes only from `tasks.state`.
     *
     * Keep the round intact and stay busy. When no round is in flight, fall through to the normal reset.
     */
    if (String((ev && ev.source) || '').toLowerCase() === 'compact') {
      const cur = st.taskId
        ? { taskId: st.taskId, startedAt: Number(st.taskStartedAt) || 0 }
        : typeof bus.currentTaskFor === 'function'
        ? bus.currentTaskFor(stableProject, memberId, sessionId)
        : null;
      if (cur && cur.taskId) {
        // Recover taskId into memory when the server restarted and only the state file still knows it
        if (!st.taskId) {
          set({
            taskId: cur.taskId,
            taskWorkspacePath: st.taskWorkspacePath || workspacePath,
            taskStartedAt: Number(cur.startedAt) || 0,
            ...(cur.title ? { taskTitle: cur.title } : {}),
          });
        }
        set({ sessionEndedAt: null, sessionWorkspacePath: workspacePath });
        await register();
        return { ok: true, handled: event, kept: 'compact' };
      }
    }
    set({
      sessionEndedAt: null,
      sessionWorkspacePath: workspacePath,
      taskWorkspacePath: '',
      taskId: null,
      taskStartedAt: 0,
      sessionPhase: { phase: 'idle', ts: Date.now(), workspacePath },
    });
    if (impl.coarse) {
      const qForm = formOf();
      const started = await bus.startTask({ ...base, title: impl.coarseTitle, model: '', form: qForm });
      const patch = { taskTitle: impl.coarseTitle, done: null, roundFiles: [] };
      if (qForm) patch.form = qForm;
      if (started && started.taskId) {
        patch.taskId = started.taskId;
        patch.taskWorkspacePath = workspacePath;
        patch.taskStartedAt = Date.now();
      }
      set(patch);
      set({ sessionPhase: { phase: 'thinking', ts: Date.now(), workspacePath } });
      return { ok: true, handled: event };
    }
    await register();
    await clearBlocked();
    return { ok: true, handled: event };
  }

  if (event === 'UserPromptSubmit') {
    const handback = typeof impl.subagentHandbackOf === 'function' ? impl.subagentHandbackOf(ev) : null;
    if (handback) {
      const promptId = String((ev && ev.prompt_id) || '').trim();
      const continuation =
        promptId && typeof bus.backgroundSubagentFor === 'function'
          ? bus.backgroundSubagentFor({
              project: stableProject,
              client,
              sessionId,
              agentId: handback.agentId,
            })
          : null;
      if (!continuation) return { ok: true, ignored: 'unknown_subagent_handback' };

      const st = get();
      const seen = Array.isArray(st.continuationPromptIds) ? st.continuationPromptIds : [];
      if (seen.includes(promptId)) return { ok: true, ignored: 'duplicate_subagent_handback' };
      const cur = typeof bus.currentTaskFor === 'function'
        ? bus.currentTaskFor(stableProject, memberId, sessionId)
        : null;
      if (cur && cur.taskId) {
        set({ continuationPromptIds: [...seen, promptId].slice(-20) });
        return { ok: true, ignored: 'continuation_task_active' };
      }

      const prevDone = st.done || null;
      sweepGhosts(bus, stableProject, client, {}, sessionId, get());
      // Reserve the prompt id before awaiting so concurrent duplicate delivery cannot open two tasks.
      set({ continuationPromptIds: [...seen, promptId].slice(-20), await: null, pending: null, done: null });
      const name = String(continuation.name || '子代理').replace(/\s+/g, ' ').trim();
      const title = `${name || '子代理'} 返回后续作`;
      const form = formOf() || st.form || '';
      await register();
      const started = await bus.startTask({ ...base, title, model: String(ev.model || ''), form });
      const patch = { taskTitle: title, done: null, roundFiles: [] };
      if (form) patch.form = form;
      if (started && started.taskId) {
        patch.taskId = started.taskId;
        patch.taskWorkspacePath = workspacePath;
        patch.taskStartedAt = Date.now();
      }
      set(patch);
      await backfillPrevTokens(prevDone, tp());
      set({ sessionPhase: { phase: 'thinking', ts: Date.now(), workspacePath } });
      return { ok: true, handled: event, continued: true };
    }
    if (fromSubagent) {
      // The subagent's own prompt shares the parent session_id; only agent_id differs. Starting a
      // task here would call startTask -> endStaleTasksOfSession and cancel the parent's live
      // round, and sweeping would drop the ghost that SubagentStart just opened.
      return { ok: true, ignored: 'subagent_prompt' };
    }
    if (INJECTED_PROMPT_RE.test(String((ev && ev.prompt) || ''))) return { ok: true, ignored: 'injected' };
    const prevDone = get().done || null;
    sweepGhosts(bus, stableProject, client, {}, sessionId, get());
    // A new round: clear "awaiting permission / pending / previous round's done marker"
    set({ await: null, pending: null, done: null });
    const prompt = userRequestText(ev.prompt);
    const title = prompt.replace(/\s+/g, ' ').trim() || '（未命名任务）';
    const st0 = get();
    const form = formOf() || st0.form || '';
    await register();
    const started = await bus.startTask({ ...base, title, model: String(ev.model || ''), form });
    const patch = { taskTitle: title, done: null, roundFiles: [] };
    if (form) patch.form = form;
    if (started && started.taskId) {
      patch.taskId = started.taskId;
      patch.taskWorkspacePath = workspacePath;
      patch.taskStartedAt = Date.now();
    }
    set(patch);
    await backfillPrevTokens(prevDone, tp());
    set({ sessionPhase: { phase: 'thinking', ts: Date.now(), workspacePath } });
    await clearBlocked();
    if (process.env.WORKGREMLIN_HOOK_MESSAGES === '1') {
      await bus.recordMessage({
        project,
        workspacePath,
        memberId,
        from: memberId,
        to: null,
        type: 'task_assign',
        subject: title,
        content: prompt.slice(0, 2_000),
      });
    }
    return { ok: true, handled: event };
  }

  if (event === 'PreToolUse' || event === 'PostToolUse') {
    // The tool name field in the hook event may be tool_name (native upstream) or tool (mapped by some reporting layers)
    const toolName = ev.tool_name || ev.tool || '';
    if (event === 'PreToolUse') {
      const tool = toolName;
      // A subagent's tools run in its own turn: keep the main console's phase / pending state
      // intact. A nested summon still registers its ghost below.
      if (!fromSubagent) {
        const f = relFile(fileOf(ev.tool_input, toolName), cwd);
        const input = ev.tool_input || {};
        const toolLabel = tool.replace(/^collaboration/, '');
        const cmdText = /^apply_patch$/.test(tool) ? '' : input.command || input.cmd || '';
        const desc = cmdText
          ? `${toolLabel} ${cmdText}`
          : input.pattern || input.regex || input.query
          ? `${toolLabel} ${input.pattern || input.regex || input.query}${f ? ' ' + f : ''}`
          : f
          ? `${toolLabel} ${f}`
          : toolLabel;
        const probe = !impl.hasPermissionEvent && WRITE_TOOLS.has(tool);
        set({
          lastTool: tool,
          lastInput: ev.tool_input || '',
          pending: probe ? { tool, file: f, cmd: desc, at: Date.now(), workspacePath } : null,
          sessionPhase: { phase: 'tool', tool, file: f, cmd: desc, ts: Date.now(), workspacePath },
        });
      }
      if (isSubagentTool(tool)) {
        const nm = agentName(ev.tool_input);
        const task = agentTask(ev.tool_input);
        if (impl.hasSubagentStart) {
          set({ pendingSpawn: { name: nm, task, at: Date.now() } });
        } else {
          const id = subagentKeys(ev, nm, task)[0] || '';
          // Record a summon ledger entry (to look up when it finishes), then write the feed to float the ghost
          const ledger = ((get().subagents) || []).filter((r) => r && (r.id || r.name)).slice(-8);
          if (id && !ledger.some((r) => r.id === id)) ledger.push({ id, name: nm, at: Date.now() });
          else if (!id && nm && !ledger.some((r) => r.name === nm)) ledger.push({ id: '', name: nm, at: Date.now() });
          set({ subagents: ledger });
          addGhost(bus, stableProject, stableWs, nm, task, id, String(get().taskId || ''), String(ev.model || ''), client, sessionId);
        }
      }
      if (!fromSubagent) {
        const toolTaskId = String(get().taskId || '');
        if (tool && toolTaskId) {
          await bus.toolUse({ ...base, taskId: toolTaskId, tool });
        }
        await clearBlocked();
      }
    } else {
      const launch = isSubagentTool(toolName) && typeof impl.subagentLaunchOf === 'function'
        ? impl.subagentLaunchOf(ev)
        : null;
      if (fromSubagent) {
        // A nested summon can still bind/retire its own ghost; the rest of the event belongs to the
        // subagent's turn and must not touch the parent's phase or task attribution.
        if (isSubagentTool(toolName) && !impl.hasSubagentStart) {
          if (launch) bindGhostFromLaunch(bus, stableProject, sessionId, get(), ev, launch, client, set);
          else finishGhostServer(bus, stableProject, sessionId, get(), ev, client, set);
        }
        return { ok: true, ignored: 'subagent_tool' };
      }
      // Only write-class tools name a changed file: `Read` / `Grep` / `Glob` / `ReadLints` carry a
      // file_path too, so taking every tool that does listed files the turn merely read as changed ones.
      const touched = WRITE_TOOLS.has(toolName)
        ? filesOf(ev.tool_input, toolName)
            .map((x) => ({ abs: path.resolve(x), path: relFile(x, cwd), op: opOf(toolName) }))
            .filter((t) => t.path)
        : [];
      if (touched.length) {
        await bus.fileTouch({ ...base, files: touched.map((t) => t.path), op: opOf(toolName) });
        const ledger = ((get().roundFiles) || []).slice();
        for (const t of touched) {
          const ex = ledger.find((x) => x && x.path === t.path);
          if (ex) ex.op = t.op;
          else ledger.push({ path: t.path, op: t.op, abs: t.abs });
        }
        set({ roundFiles: ledger.slice(-30) });
      }
      const prog = todoProgress(toolName, ev.tool_input);
      if (prog != null) {
        const tid = get().taskId;
        if (tid) await bus.taskProgress({ ...base, taskId: tid, progress: prog });
      }
      if (isSubagentTool(toolName) && !impl.hasSubagentStart) {
        if (launch) bindGhostFromLaunch(bus, stableProject, sessionId, get(), ev, launch, client, set);
        else finishGhostServer(bus, stableProject, sessionId, get(), ev, client, set);
      }
      set({ sessionPhase: { phase: 'thinking', ts: Date.now(), workspacePath } });
      await clearBlocked();
    }
    return { ok: true, handled: event };
  }

  if (event === 'Notification') {
    if (ev.notification_type === 'idle_prompt') {
      set({ await: null, pending: null, sessionPhase: { phase: 'idle', ts: Date.now(), workspacePath } });
      await clearBlocked();
    } else if (impl.awaitingPermission && !impl.awaitingPermission(ev)) {
      return { ok: true, ignored: event }; // non-permission types (such as Claude's auth_success) don't touch state
    } else {
      const tool = (ev && (ev.tool_name || ev.tool)) || get().lastTool || '';
      const input = (ev && ev.tool_input) || get().lastInput || '';
      const ff = relFile(fileOf(input, tool), cwd);
      set({
        await: { tool, file: ff, ts: Date.now(), workspacePath },
        sessionPhase: { phase: 'await', tool, file: ff, ts: Date.now(), workspacePath },
      });
      await setBlocked('awaiting_permission');
    }
    return { ok: true, handled: event };
  }

  if (event === 'PermissionRequest') {
    const tool = (ev && (ev.tool_name || ev.tool)) || get().lastTool || '';
    const input = (ev && ev.tool_input) || get().lastInput || '';
    const ff = relFile(fileOf(input, tool), cwd);
    set({
      await: { tool, file: ff, ts: Date.now(), workspacePath },
      sessionPhase: { phase: 'await', tool, file: ff, ts: Date.now(), workspacePath },
    });
    await setBlocked('awaiting_permission');
    return { ok: true, handled: event };
  }

  if (event === 'SubagentStart' && impl.hasSubagentStart) {
    const st = get();
    const pend = st.pendingSpawn && Date.now() - Number(st.pendingSpawn.at || 0) < PENDING_SPAWN_MS ? st.pendingSpawn : null;
    const launch = typeof impl.subagentLaunchOf === 'function' ? impl.subagentLaunchOf(ev) : null;
    const type = String(ev.agent_type || '').trim();
    const name = (type && type !== 'default' ? type : '') || (pend && pend.name) || 'subagent';
    const agentId = String((launch && launch.agentId) || agentIdOf(ev) || '').trim();
    const id = agentId || subagentKeys(ev, name, (pend && pend.task) || '')[0] || '';
    const ledger = ((st.subagents) || []).slice(-8);
    if (id && !ledger.some((r) => r.id === id)) {
      ledger.push({ id, name, at: Date.now(), agentId, background: Boolean(launch && launch.background) });
    }
    set({ subagents: ledger, pendingSpawn: null });
    addGhost(
      bus,
      stableProject,
      stableWs,
      name,
      (pend && pend.task) || '',
      id,
      String(st.taskId || ''),
      String(ev.model || ''),
      client,
      sessionId,
      { agentId, background: launch ? launch.background : undefined }
    );
    return { ok: true, handled: event };
  }

  const subagentStopMatchesSpawn = typeof impl.subagentStopMatchesSpawn === 'function'
    ? Boolean(impl.subagentStopMatchesSpawn(ev))
    : Boolean(impl.subagentStopMatchesSpawn);
  if (event === 'SubagentStop' && subagentStopMatchesSpawn) {
    finishGhostServer(bus, stableProject, sessionId, get(), { ...ev, last_assistant_message: ev.last_assistant_message }, client, set);
    return { ok: true, handled: event };
  }

  if (event === 'Stop') {
    const doneBeforeStop = get().done || null;
    const prevCancelledDone = Boolean(
      doneBeforeStop && doneBeforeStop.cancelled && Date.now() - Number(doneBeforeStop.at || 0) < 60_000
    );
    // Clear "awaiting permission / pending" (done was already read first)
    set({ await: null, pending: null, done: null });
    const st = get();
    let taskId = st.taskId;
    let title = st.taskTitle || '';
    let startedAt = Number(st.taskStartedAt) || 0;
    if (!taskId) {
      const cur = typeof bus.currentTaskFor === 'function' ? bus.currentTaskFor(project, memberId, sessionId) : null;
      if (cur && cur.taskId) {
        taskId = cur.taskId;
        if (!title && cur.title) title = cur.title;
        if (!startedAt && cur.startedAt) startedAt = Number(cur.startedAt) || 0;
      }
    }
    const replies = impl.repliesOf(tp());
    const eventSaid = String((ev && ev.last_assistant_message) || '').replace(/\s+/g, ' ').trim();
    const lastText = eventSaid || (replies.length ? replies[replies.length - 1].text : '');
    const said = lastText.replace(/\s+/g, ' ').trim().slice(0, 160);
    const result = lastText.trim().slice(0, RESULT_MAX);
    if (!replies.length && lastText) replies.push({ id: 'h' + fnv1a32(lastText), text: lastText });
    const roundFileDetails = collectRoundFiles(st, ev, cwd, startedAt, workspacePath);
    const justCancelled = prevCancelledDone && !taskId;
    const cancelledRound = justCancelled || stopReasonCancelled(ev) || impl.interruptedSince(tp(), startedAt, sessionId);
    sweepGhosts(bus, stableProject, client, cancelledRound ? { state: 'cancelled' } : {}, sessionId, get());
    if (taskId) {
      const form = formOf() || st.form || '';
      const transcriptPath = tp();
      const tokens = await impl.readTokensOf(transcriptPath, startedAt);
      await bus.endTask({
        ...base,
        taskId,
        state: cancelledRound ? 'cancelled' : 'done',
        model: String(ev.model || ''),
        result,
        files: roundFileDetails,
        fileCount: roundFileDetails.length,
        form,
        ...(tokens ? { tokens } : {}),
      });
      scheduleDelayedBackfill(startedAt, transcriptPath);
    }
    set({
      taskId: null,
      taskWorkspacePath: '',
      taskStartedAt: 0,
      roundFiles: [],
      sessionPhase: { phase: 'idle', ts: Date.now(), workspacePath },
      done: justCancelled
        ? doneBeforeStop
        : {
            at: Date.now(),
            title,
            workspacePath,
            startedAt,
            said,
            sessionId,
            files: roundFileDetails.slice(0, 8),
            fileCount: roundFileDetails.length,
            ...(cancelledRound ? { cancelled: true } : {}),
          },
    });
    await clearBlocked();
    await reportReplies(ctx, memberId, taskId, replies, sessionId, client);
    return { ok: true, handled: event };
  }

  if (event === 'Interrupt') {
    await finishCancelled(ev);
    return { ok: true, handled: event };
  }

  if (event === 'FinalStop') {
    const reason = String((ev && ev.final_stop_reason) || '').trim().toLowerCase();
    if (reason === 'cancelled' || reason === 'canceled' || reason === 'interrupted' || reason === 'aborted') {
      await finishCancelled(ev);
    }
    return { ok: true, handled: event };
  }

  if (event === 'SessionEnd') {
    const stEnd = get();
    await reportReplies(ctx, memberId, stEnd.taskId, impl.repliesOf(tp()), sessionId, client);
    if (impl.coarse) {
      const qFormEnd = formOf() || stEnd.form || '';
      if (qFormEnd && qFormEnd !== stEnd.form) set({ form: qFormEnd });
      if (stEnd.taskId) {
        await bus.endTask({
          ...base,
          taskId: stEnd.taskId,
          state: 'done',
          model: '',
          result: '',
          files: [],
          fileCount: 0,
          form: qFormEnd,
          sessionId,
        });
      }
    }
    set({
      await: null,
      pending: null,
      sessionEndedAt: Date.now(),
      sessionPhase: impl.coarse ? { phase: 'done', ts: Date.now(), workspacePath } : null,
    });
    sweepGhosts(bus, stableProject, client, { all: true }, sessionId, get());
    set({ taskId: null, taskWorkspacePath: '', taskStartedAt: 0, subagents: [] });
    await clearBlocked();
    return { ok: true, handled: event };
  }

  return { ok: true, ignored: event };
}

/** Server-side finishGhost: find the summon record in the session ledger, then retire its ghost */
function finishGhostServer(bus, project, sessionId, st, ev, floor, set) {
  const ti = ev && ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : null;
  const nm = ti ? agentName(ti) : '';
  const task = ti ? agentTask(ti) : '';
  const keys = subagentKeys(ev, nm, task);
  const aid = agentIdOf(ev);
  const callId = callIdsOf(ev)[0] || '';
  const hasInstanceId = Boolean(aid || callId);
  const list = st.subagents || [];
  const pick = (arr) => {
    let r = aid ? arr.find((x) => x.id === aid || x.agentId === aid) : null;
    if (!r && keys.length) r = arr.find((x) => x.id && keys.includes(x.id)) || null;
    if (!r && !hasInstanceId && nm && nm !== 'subagent') r = arr.find((x) => x.name === nm) || null;
    if (r) return r;
    // `arr[0]` is only for an event that names **no instance at all** (older reporters, tests).
    // An event that names one — agent_id, or a per-call tool id — but matches no ledger row must
    // not be resolved by guessing: with two concurrent same-name summons `arr[0]` is the *other*,
    // still-running one, so the guess retires the wrong ghost and writes this result onto its run.
    if (hasInstanceId) return null;
    return arr[0] || null;
  };
  const hit = pick(list);
  if (!hit) {
    // The state ledger drops an instance after its first stop. A later stop carrying the exact
    // child identity is how a resumed background agent returns; the bus decides from its ledger
    // whether that identity is a genuine wake-up or an unknown/stale event.
    if (hasInstanceId) retireGhost(bus, project, nm, callId, resultOfResponse(ev), floor, sessionId, aid);
    return;
  }
  st.subagents = list.filter((x) => x !== hit);
  if (set) set({ subagents: st.subagents });
  retireGhost(bus, project, hit.name, hit.id, resultOfResponse(ev), floor, sessionId, aid);
}

/** Bind Claude's asynchronous launch receipt to the ledger row opened by the spawning tool call. */
function bindGhostFromLaunch(bus, project, sessionId, st, ev, launch, floor, set) {
  const ti = ev && ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : null;
  const name = ti ? agentName(ti) : 'subagent';
  const task = ti ? agentTask(ti) : '';
  const keys = subagentKeys(ev, name, task);
  const callId = callIdsOf(ev)[0] || '';
  const list = st.subagents || [];
  const hit =
    (callId && list.find((x) => x.id === callId)) ||
    (keys.length && list.find((x) => x.id && keys.includes(x.id))) ||
    null;
  if (hit) {
    hit.agentId = launch.agentId || '';
    hit.background = Boolean(launch.background);
    if (set) set({ subagents: list });
  }
  bindGhostIdentity(
    bus,
    project,
    name,
    (hit && hit.id) || callId || keys[0] || '',
    launch.agentId,
    launch.background,
    floor,
    sessionId
  );
}

module.exports = {
  runHookEvent,
  // product-agnostic helpers (exported for unit tests and reuse)
  filesOf, fileOf, opOf, todoProgress, relFile, userRequestText, touchedSince, collectRoundFiles,
  transcriptRoundFiles, stopReasonCancelled, isSubagentTool, isSubagentEvent, readTokens,
  addGhost, retireGhost, bindGhostIdentity, sweepGhosts, agentName, agentTask, subagentKeys,
  resultOfResponse, INJECTED_PROMPT_RE, WRITE_TOOLS, RESULT_MAX, MSG_MAX, MAX_REPLIES,
  PENDING_SPAWN_MS,
  // token normalization primitives (product-agnostic)
  normOpenAI, normAnthropic, tokenFinish,
  // reply parsing / form / interrupt (product-agnostic)
  extractText, msgOf, isInterruptLine, sinceLastUser, jsonlReplies, indexJsonReplies,
  headJsonLines, turnInterrupted, INTERRUPT_HINT_RE,
  // public default hook behavior (interfaces a floor module doesn't override fall back to this)
  sharedHookImpl,
};
