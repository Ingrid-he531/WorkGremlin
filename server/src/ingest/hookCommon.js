'use strict';

/**
 * 服务端 hook 事件通用运行器 + 产品无关助手。
 *
 * 这是 hook.js 事件处理逻辑的"服务端版"：CLI 的 hook 退化成事件转发器后，原本在 hook 侧做的
 * 落盘解析 / 会话状态 / 台账写入全部搬到这里。设计目标：
 *   · **产品无关的部分**（文件抽取、todo 进度、ghost feed 写入、token 读取、事件开关）只写一次；
 *   · **产品差异**（回复解析、文件清单、打断检测、形态、token 口径）由各 floor 通过 `impl` 提供，
 *     真正做到"floorXXX 处理各自落盘的不同"。
 *
 * 会话状态：替代 hook 的 state 文件，按 sessionId 存在 dispatcher 的内存 Map 里（见 hookDispatch.js）。
 * ghost 台账：直接写 `<workspace>/.workgremlin/subagents.json`（与 hook 同文件，subagentFeed 读它）。
 *
 * 用法：每个 floor 导出 `handleHookEvent(ev, ctx)` → `return runHookEvent(ev, ctx, impl)`。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { updateJson } = require('@workgremlin/shared/fslock');
const { fnv1a32 } = require('@workgremlin/shared');
const { feedFilePath } = require('./subagentFeed');

/** 文件是否存在且为普通文件（读取落盘前先探一下） */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/* ============================== 常量（与 hook.js 对齐） ============================== */
const RESULT_MAX = 4_000;
const MSG_MAX = 8_000;
const MAX_REPLIES = 50;
const PENDING_SPAWN_MS = 2 * 60_000;
const CB_REQ_GRACE_MS = 5_000;
const CB_FLUSH_WAIT_MS = 1_200;
const CB_FLUSH_STEP_MS = 120;

const PROBE_TOOLS = new Set([
  'Edit', 'MultiEdit', 'NotebookEdit', 'Write', 'Delete',
  'replace_in_file', 'write_to_file', 'delete_file',
  'apply_patch',
]);

const INJECTED_PROMPT_RE = /^\s*<(?:task-notification|agent-message)[\s>]/i;

function isSubagentTool(tool) {
  return /^(task|agent|spawn_agent|collaborationspawn_agent)$/i.test(String(tool || '').trim());
}

/* ============================== 产品无关：文件 / 进度 ============================== */

/** 工具输入里的目标文件（CodeBuddy: file_path/filePath；Codex: apply_patch 的 patch 文本） */
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

/** apply_patch 结果里的权威清单：`Success. Updated the following files:` 之后的 `M/A/D <路径>` */
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

/** 从 Codex 的 rollout transcript 读本轮真正改过的文件（apply_patch 权威清单） */
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

/** 从 TodoWrite 类工具的入参里抽"任务进度"（已完成 / 总量） */
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

/** 工程内记相对路径，工程外记绝对路径 */
function relFile(file, cwd) {
  if (!file) return '';
  const abs = path.resolve(file);
  if (cwd && (abs === cwd || abs.startsWith(cwd + path.sep))) return path.relative(cwd, abs);
  return abs;
}

/** 用户原话：剥掉 IDE 插件注入的那段上下文 */
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

/** 兜底：按文件 mtime 扫出这一轮碰过的文件（agent 用 shell 改文件时前两手都瞎） */
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
      /* 已删除 / 读不到 */
    }
    if (out.length >= 200) break;
  }
  return out;
}

/** 本轮（startedAt 之后）改过的文件：三路合并（PostToolUse 记录 + transcript patch + mtime 扫描），按绝对路径去重 + 补体积 */
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
          /* 试下一个候选 */
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

/* ============================== 回复去重键 ============================== */

function replyKeyOf(reply) {
  const id = String((reply && reply.id) || '').trim();
  if (id) return id;
  return 'h' + fnv1a32(String((reply && reply.text) || ''));
}

function aiDedupeKey(client, sessionId, msgId) {
  return `ai:${client}:${String(sessionId || 'nosession')}:${String(msgId || 'noid')}`;
}

/* ============================== 回复解析（产品无关：jsonl / codebuddy index.json） ============================== */

/** 从内容块里抽人类可读文本（兼容 string / [{type,text}] / {text}，跳过 tool_use/tool_result/thinking） */
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

/** 一条 transcript 记录里的"消息体"，统一成 {role, content, id}（兼容 Codex payload / 通用 message / 顶层） */
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

/** 一行 JSONL 是不是"用户打断了这一轮"的结构化事件（Codex turn_aborted / Claude·Qoder 的 user 标记） */
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

/** 最后一条 user 之后的 assistant 消息 */
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

/** 通用 / Claude Code / Codex rollout 的 JSONL：逐行一个 JSON */
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
    if (isInterruptLine(obj)) continue; // 打断标记的 user 行不算"新一轮用户提问"边界
    const m = msgOf(obj);
    if (!m) continue;
    items.push({ role: String(m.role), id: m.id, text: extractText(m.content) });
  }
  return sinceLastUser(items);
}

/**
 * CodeBuddy 的会话正文不在索引里：索引 history/<sessionId>/index.json（缩进多行 JSON，非 JSONL），
 * 正文在同目录 messages/<id>.json（{role, message:"<JSON 字符串>"}）。一轮回复在索引里被切成若干
 * assistant 分片，按最后一个请求把分片拼成一条，去重键用请求 id。Qoder / WorkBuddy 的插件同款。
 */
function codebuddyReplies(indexPath) {
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
  // 没有 requests 索引（老版本）：退回"最后一条 user 之后的 assistant 分片各算一条"
  return sinceLastUser(msgs.map((m) => ({ role: String((m && m.role) || ''), id: String((m && m.id) || ''), text: m && m.id ? read(m.id) : '' })));
}

/** 读会话落盘头部若干行（形态判定用，只读窗口不读全文件） */
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

/** Codex 形态（cli / plugin）：rollout 首行 session_meta 的 source/originator */
function codexForm(transcriptPath) {
  for (const obj of headJsonLines(transcriptPath)) {
    const p = obj && obj.payload;
    if (!p || typeof p !== 'object') continue;
    if (obj.type !== 'session_meta' && !p.source && !p.originator) continue;
    const who = `${String(p.source || '')} ${String(p.originator || '')}`.toLowerCase();
    if (/vscode|jetbrains|extension|plugin|visual studio/.test(who)) return 'plugin';
    if (who.trim()) return 'cli';
  }
  return '';
}

/** Qoder 形态（cli / plugin）：transcript 首行 user 的 entrypoint */
function qoderForm(transcriptPath) {
  for (const obj of headJsonLines(transcriptPath)) {
    const ep = obj && typeof obj.entrypoint === 'string' ? obj.entrypoint.trim().toLowerCase() : '';
    if (!ep) continue;
    if (ep.includes('vscode') || ep.includes('plugin')) return 'plugin';
    return ep === 'cli' ? 'cli' : '';
  }
  return '';
}

/** 这一轮有没有被用户打断的痕迹（给"没有显式 Interrupt 事件"的产品用）：Codex turn_aborted / Claude·Qoder 的 user 标记 */
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

/* ============================== token 读取（搬 usage.js，产品无关） ============================== */

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
      /* 半截行 */
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

function codebuddyRequestTokens(indexPath, startedAt) {
  let idx;
  try {
    idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return null;
  }
  const reqs = Array.isArray(idx && idx.requests) ? idx.requests : [];
  let best = null;
  for (const r of reqs) {
    if (!r || typeof r !== 'object') continue;
    const ts = Number(r.startedAt);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (ts < startedAt - CB_REQ_GRACE_MS || ts > startedAt + CB_REQ_GRACE_MS) continue;
    if (!best || ts > Number(best.startAt)) best = r;
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

function tokenFinish(t) {
  if (!t) return null;
  if (t.input + t.output + t.cacheRead + t.cacheWrite <= 0) return null;
  return t;
}

/** 这一轮消耗的 token（产品无关：JSONL 走 requestSum/codexDelta；CodeBuddy 插件 index.json 走专门路） */
function readTokens(transcriptPath, startedAt) {
  const file = String(transcriptPath || '');
  if (!file) return null;
  if (!(Number(startedAt) > 0)) return null;
  if (/index\.json$/i.test(file)) return tokenFinish(codebuddyRequestTokens(file, Number(startedAt)));
  const rows = parseLines(file);
  if (!rows) return null;
  const t = codexDelta(rows, Number(startedAt)) || requestSum(rows, Number(startedAt));
  return tokenFinish(t);
}

/** 必要时等落盘（只为 CodeBuddy 插件那一手 index.json，比 Stop 晚 30~50ms） */
async function readTokensSettled(transcriptPath, startedAt) {
  const file = String(transcriptPath || '');
  const first = readTokens(file, startedAt);
  if (first || !file || !(Number(startedAt) > 0)) return first;
  if (!/index\.json$/i.test(file)) return null;
  for (let waited = 0; waited < CB_FLUSH_WAIT_MS; waited += CB_FLUSH_STEP_MS) {
    await new Promise((r) => setTimeout(r, CB_FLUSH_STEP_MS));
    const t = readTokens(file, startedAt);
    if (t) return t;
  }
  return null;
}

/* ============================== 子代理 key 合成 ============================== */

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

function subagentKeys(ev, name, task) {
  const out = [];
  const push = (k) => {
    if (k && !out.includes(k)) out.push(k);
  };
  for (const v of [ev && ev.tool_use_id, ev && ev.toolUseId, ev && ev.call_id, ev && ev.tool_call_id]) {
    const s = String(v || '').trim();
    if (s) push(s);
  }
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
  const r = ev && ev.tool_response;
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

/* ============================== ghost feed 写入（替代 hook 的 addGhost/finishGhost/sweepGhosts） ============================== */

function clientFamily(c) {
  return String(c || '').trim().toLowerCase().replace(/-plugin$/, '');
}

function ownsEntry(a, client, session = '') {
  if (!a) return false;
  const fam = clientFamily(a.client);
  if (fam) {
    if (fam !== clientFamily(client)) return false;
  } else if (clientFamily(client) !== 'codebuddy') {
    return false;
  }
  if (session) {
    const s = String(a.sessionId || '').trim();
    if (s && s !== session) return false;
  }
  return true;
}

/** 主 Agent 召唤 subagent → 加一只小幽灵（直接写 feed 文件，带 ts/client/sessionId 归属） */
function addGhost(workspacePath, name, task, id, parent, model, client, session = '') {
  const file = feedFilePath(workspacePath);
  updateJson(
    file,
    (feed) => {
      const dup = id
        ? (a) => a.id === id
        : (a) => a.name === name && String(a.sessionId || '') === String(session || '');
      if (feed.agents.some(dup)) return undefined;
      feed.agents.push({
        name,
        state: 'busy',
        ts: Date.now(),
        client,
        ...(session ? { sessionId: String(session) } : {}),
        ...(task ? { task } : {}),
        ...(id ? { id } : {}),
        ...(parent ? { parent } : {}),
        ...(model ? { model } : {}),
      });
      return feed;
    },
    { fallback: { project: '', agents: [] }, pretty: true }
  );
}

/** subagent 收工 → 改成"已收工待汇报"（不直接删，让 subagentFeed 播完汇报再回收） */
function retireGhost(workspacePath, name, id, result, client, session = '') {
  const file = feedFilePath(workspacePath);
  let changed = false;
  updateJson(
    file,
    (feed) => {
      let hit = id ? feed.agents.findIndex((a) => a.id === id) : -1;
      if (hit < 0) {
        hit = feed.agents.findIndex(
          (a) => a.name === name && (!session || !a.sessionId || String(a.sessionId) === String(session))
        );
      }
      if (hit < 0) return undefined;
      const cur = feed.agents[hit] || {};
      if (!ownsEntry(cur, client, session)) return undefined;
      const task = String(cur.task || '').trim();
      const said = String(result || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      feed.agents[hit] = { ...cur, state: 'idle', result: said || (task ? `已完成：${task}` : '已完成') };
      changed = true;
      return feed;
    },
    { fallback: { project: '', agents: [] }, pretty: true }
  );
  return changed;
}

/** 扫掉本 hook 召唤的幽灵（带 ts 的），并清掉会话台账里对应的记录 */
function sweepGhosts(workspacePath, client, opts = {}, session = '', sessionState = null) {
  const file = feedFilePath(workspacePath);
  let doomed = [];
  updateJson(
    file,
    (feed) => {
      doomed = feed.agents.filter(
        (a) => a && a.ts && ownsEntry(a, client, session) && (opts.all || !a.result)
      );
      if (!doomed.length) return undefined;
      feed.agents = feed.agents.filter((a) => !doomed.includes(a));
      return feed;
    },
    { fallback: { project: '', agents: [] }, pretty: true }
  );
  if (!doomed.length) return 0;
  // 清会话台账里对应的召唤记录
  if (sessionState && Array.isArray(sessionState.subagents)) {
    sessionState.subagents = sessionState.subagents.filter((r) => {
      if (!r) return false;
      return !doomed.some((a) => (a.id ? r.id === a.id : !r.id && r.name === a.name));
    });
  }
  return doomed.length;
}

/* ============================== 回复入库（替代 reportAiReplies） ============================== */

async function reportReplies(ctx, agent, taskId, replies, sessionId, client) {
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
          memberId: agent,
          from: agent,
          to: null,
          type: i === list.length - 1 ? 'result' : 'task_update',
          subject: null,
          content: content.slice(0, MSG_MAX),
          taskId: taskId || null,
          ts,
          dedupeKey: aiDedupeKey(client, sessionId, replyKeyOf(list[i])),
        });
      })
      .filter(Boolean)
  );
}

/* ============================== 形态（cli / plugin）判定 ============================== */

/**
 * 由事件自报的 client 字段判定 plugin 形态。vscode / extension / jetbrains / plugin 一律算 plugin；
 * CLI 用户（client 为 null / 'codex' / 'cli' 等）返回 ''（交给 impl.formOf 或落盘头再判）。
 * hook 已把原始 client 原样透传过来，plugin 判定就以此为准，不再靠拼 `-plugin` 后缀或猜落盘头。
 */
function clientPluginForm(ev) {
  const c = String((ev && ev.client) || '').toLowerCase();
  return /vscode|jetbrains|extension|plugin/.test(c) ? 'plugin' : '';
}

/* ============================== 通用事件开关（忠实搬运 hook.js main） ============================== */

/**
 * 处理一次 hook 事件。产品差异通过 `impl` 注入；其余（文件/进度/token/ghost/事件开关）都在本模块。
 * @param {object} ev 原始 hook 事件
 * @param {{project:string, workspacePath:string, bus:any, sessionGet:Function, sessionSet:Function}} ctx
 * @param {object} impl 产品差异
 */
async function runHookEvent(ev, ctx, impl) {
  const { bus, project, workspacePath, sessionGet, sessionSet } = ctx;
  const event = ev && ev.hook_event_name;
  if (!event) return { ok: false, error: 'missing hook_event_name' };

  const client = impl.client;
  const memberId = String(ev.agent || client);
  const sessionId = String(ev.session_id || '');
  const cwd = String(ev.cwd || '');
  const base = { project, workspacePath, memberId, client };

  const get = () => sessionGet(sessionId) || {};
  const set = (patch) => sessionSet(sessionId, patch);

  // 缓存 transcript 路径（后续事件从会话状态里取，hook 原逻辑见 SessionStart 那段）
  if (ev.transcript_path) set({ transcriptPath: String(ev.transcript_path) });
  const tp = () => String(ev.transcript_path || get().transcriptPath || '');

  const status = (state, reason) =>
    bus.setStatus({ ...base, state, taskId: get().taskId || null, ...(reason ? { reason } : {}) });
  const beat = () => bus.heartbeat({ ...base, memberId });
  const register = () => bus.registerMember({ ...base, name: memberId, role: 'agent' });

  // plugin 形态优先由事件自报的 client 判定（vscode 只是壳，rollout 头常仍标 cli，猜不准），
  // 落盘头只作 fallback。hook 已把原始 client 透传过来，这里按它识别 plugin。
  const clientForm = clientPluginForm(ev);
  const formOf = () => clientForm || impl.formOf(tp());

  // 给上一轮补报 token（新一轮开始时用）
  async function backfillPrevTokens(prevDone, transcriptPath) {
    const startedAt = Number(prevDone && prevDone.startedAt) || 0;
    if (!transcriptPath || !(startedAt > 0)) return;
    const tokens = readTokens(transcriptPath, startedAt);
    if (!tokens) return;
    await bus.backfillTaskTokens({ ...base, startedAt, tokens, sessionId });
  }

  // 这一轮被用户掐掉 → 按"取消"收尾（与 Stop 同一条线，三点不同）
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
    sweepGhosts(workspacePath, client, {}, sessionId, st0);
    const files0 = collectRoundFiles(st0, ev0, cwd, startedAt0, workspacePath);
    const last0 = replies0.length ? replies0[replies0.length - 1].text : '';
    const said0 = String(last0 || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const result0 = String(last0 || '').trim().slice(0, RESULT_MAX);
    if (taskId0) {
      const tokens0 = await readTokensSettled(tp(), startedAt0);
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
    await beat();
    await status('idle');
  }

  if (event === 'SessionStart') {
    const st = get();
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
      await status('thinking');
      return { ok: true, handled: event };
    }
    await register();
    await beat();
    await status('idle');
    return { ok: true, handled: event };
  }

  if (event === 'UserPromptSubmit') {
    if (INJECTED_PROMPT_RE.test(String((ev && ev.prompt) || ''))) return { ok: true, ignored: 'injected' };
    const prevDone = get().done || null;
    sweepGhosts(workspacePath, client, {}, sessionId, get());
    // 新的一轮：清"等授权/挂起/上一轮完成标记"
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
    await status('thinking');
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
    await beat();
    if (event === 'PreToolUse') {
      const tool = ev.tool_name || '';
      const f = relFile(fileOf(ev.tool_input, ev.tool_name), cwd);
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
      const probe = !impl.hasPermissionEvent && PROBE_TOOLS.has(tool);
      set({
        lastTool: tool,
        lastInput: ev.tool_input || '',
        pending: probe ? { tool, file: f, cmd: desc, at: Date.now(), workspacePath } : null,
        sessionPhase: { phase: 'tool', tool, file: f, cmd: desc, ts: Date.now(), workspacePath },
      });
      if (isSubagentTool(tool)) {
        const nm = agentName(ev.tool_input);
        const task = agentTask(ev.tool_input);
        if (impl.hasSubagentStart) {
          set({ pendingSpawn: { name: nm, task, at: Date.now() } });
        } else {
          const id = subagentKeys(ev, nm, task)[0] || '';
          // 记一笔召唤台账（收工回来查），再写 feed 飘幽灵
          const ledger = ((get().subagents) || []).filter((r) => r && (r.id || r.name)).slice(-8);
          if (id && !ledger.some((r) => r.id === id)) ledger.push({ id, name: nm, at: Date.now() });
          else if (!id && nm && !ledger.some((r) => r.name === nm)) ledger.push({ id: '', name: nm, at: Date.now() });
          set({ subagents: ledger });
          addGhost(workspacePath, nm, task, id, String(get().taskId || ''), String(ev.model || ''), client, sessionId);
        }
      }
      const toolTaskId = String(get().taskId || '');
      if (tool && toolTaskId) {
        await bus.toolUse({ ...base, taskId: toolTaskId, tool, sessionId, client });
      }
      await status('busy');
    } else {
      const touched = filesOf(ev.tool_input, ev.tool_name)
        .map((x) => ({ abs: path.resolve(x), path: relFile(x, cwd), op: opOf(ev.tool_name) }))
        .filter((t) => t.path);
      if (touched.length) {
        await bus.fileTouch({ ...base, files: touched.map((t) => t.path), op: opOf(ev.tool_name) });
        const ledger = ((get().roundFiles) || []).slice();
        for (const t of touched) {
          const ex = ledger.find((x) => x && x.path === t.path);
          if (ex) ex.op = t.op;
          else ledger.push({ path: t.path, op: t.op, abs: t.abs });
        }
        set({ roundFiles: ledger.slice(-30) });
      }
      const prog = todoProgress(ev.tool_name, ev.tool_input);
      if (prog != null) {
        const tid = get().taskId;
        if (tid) await bus.taskProgress({ ...base, taskId: tid, progress: prog });
      }
      if (isSubagentTool(ev.tool_name) && !impl.hasSubagentStart) {
        finishGhostServer(sessionId, get(), workspacePath, ev, client, set);
      }
      set({ sessionPhase: { phase: 'thinking', ts: Date.now(), workspacePath } });
      await status('thinking');
    }
    return { ok: true, handled: event };
  }

  if (event === 'Notification') {
    if (ev.notification_type === 'idle_prompt') {
      set({ await: null, pending: null, sessionPhase: { phase: 'idle', ts: Date.now(), workspacePath } });
      await status('idle');
    } else if (impl.awaitingPermission && !impl.awaitingPermission(ev)) {
      return { ok: true, ignored: event }; // 非权限类型（如 Claude 的 auth_success）不动状态
    } else {
      const tool = (ev && ev.tool_name) || get().lastTool || '';
      const input = (ev && ev.tool_input) || get().lastInput || '';
      const ff = relFile(fileOf(input, tool), cwd);
      set({
        await: { tool, file: ff, ts: Date.now(), workspacePath },
        sessionPhase: { phase: 'await', tool, file: ff, ts: Date.now(), workspacePath },
      });
      await status('blocked', 'awaiting_permission');
    }
    return { ok: true, handled: event };
  }

  if (event === 'PermissionRequest') {
    const tool = (ev && ev.tool_name) || get().lastTool || '';
    const input = (ev && ev.tool_input) || get().lastInput || '';
    const ff = relFile(fileOf(input, tool), cwd);
    set({
      await: { tool, file: ff, ts: Date.now(), workspacePath },
      sessionPhase: { phase: 'await', tool, file: ff, ts: Date.now(), workspacePath },
    });
    await status('blocked', 'awaiting_permission');
    return { ok: true, handled: event };
  }

  if (event === 'SubagentStart' && impl.hasSubagentStart) {
    const st = get();
    const pend = st.pendingSpawn && Date.now() - Number(st.pendingSpawn.at || 0) < PENDING_SPAWN_MS ? st.pendingSpawn : null;
    const type = String(ev.agent_type || '').trim();
    const name = (type && type !== 'default' ? type : '') || (pend && pend.name) || 'subagent';
    const id = agentIdOf(ev) || subagentKeys(ev, name, (pend && pend.task) || '')[0] || '';
    const ledger = ((st.subagents) || []).slice(-8);
    if (id && !ledger.some((r) => r.id === id)) ledger.push({ id, name, at: Date.now() });
    set({ subagents: ledger, pendingSpawn: null });
    addGhost(workspacePath, name, (pend && pend.task) || '', id, String(st.taskId || ''), String(ev.model || ''), client, sessionId);
    await beat();
    return { ok: true, handled: event };
  }

  if (event === 'SubagentStop') {
    finishGhostServer(sessionId, get(), workspacePath, { ...ev, last_assistant_message: ev.last_assistant_message }, client, set);
    await beat();
    return { ok: true, handled: event };
  }

  if (event === 'Stop') {
    const doneBeforeStop = get().done || null;
    const prevCancelledDone = Boolean(
      doneBeforeStop && doneBeforeStop.cancelled && Date.now() - Number(doneBeforeStop.at || 0) < 60_000
    );
    // 清"等授权/挂起"（done 已先读）
    set({ await: null, pending: null, done: null });
    sweepGhosts(workspacePath, client, {}, sessionId, get());
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
    const cancelledRound = justCancelled || stopReasonCancelled(ev) || impl.interruptedSince(tp(), startedAt);
    if (taskId) {
      const form = formOf() || st.form || '';
      const tokens = await readTokensSettled(tp(), startedAt);
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
    await beat();
    await status('idle');
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
        });
      }
    }
    set({
      await: null,
      pending: null,
      sessionEndedAt: Date.now(),
      sessionPhase: impl.coarse ? { phase: 'done', ts: Date.now(), workspacePath } : null,
    });
    sweepGhosts(workspacePath, client, { all: true }, sessionId, get());
    set({ taskId: null, taskWorkspacePath: '', taskStartedAt: 0, subagents: [] });
    await status('offline');
    return { ok: true, handled: event };
  }

  return { ok: true, ignored: event };
}

/** 服务端版 finishGhost：从会话台账找召唤记录，再写 feed 飘成"待汇报" */
function finishGhostServer(sessionId, st, workspacePath, ev, client, set) {
  const ti = ev && ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : null;
  const nm = ti ? agentName(ti) : '';
  const task = ti ? agentTask(ti) : '';
  const keys = subagentKeys(ev, nm, task);
  const aid = agentIdOf(ev);
  const list = st.subagents || [];
  const pick = (arr) => {
    let r = aid ? arr.find((x) => x.id === aid) : null;
    if (!r && keys.length) r = arr.find((x) => x.id && keys.includes(x.id)) || null;
    if (!r && nm && nm !== 'subagent') r = arr.find((x) => x.name === nm) || null;
    return r || arr[0] || null;
  };
  const hit = pick(list);
  if (!hit) return;
  st.subagents = list.filter((x) => x !== hit);
  if (set) set({ subagents: st.subagents });
  retireGhost(workspacePath, hit.name, hit.id, resultOfResponse(ev), client, sessionId);
}

module.exports = {
  runHookEvent,
  // 产品无关助手（导出便于单测与复用）
  filesOf, fileOf, opOf, todoProgress, relFile, userRequestText, touchedSince, collectRoundFiles,
  transcriptRoundFiles, stopReasonCancelled, isSubagentTool, readTokens, readTokensSettled,
  addGhost, retireGhost, sweepGhosts, ownsEntry, clientFamily, agentName, agentTask, subagentKeys,
  resultOfResponse, INJECTED_PROMPT_RE, PROBE_TOOLS, RESULT_MAX, MSG_MAX, MAX_REPLIES,
  PENDING_SPAWN_MS, CB_REQ_GRACE_MS, CB_FLUSH_WAIT_MS, CB_FLUSH_STEP_MS,
  // 回复解析 / 形态 / 打断（产品无关）
  extractText, msgOf, isInterruptLine, sinceLastUser, jsonlReplies, codebuddyReplies,
  headJsonLines, codexForm, qoderForm, turnInterrupted, INTERRUPT_HINT_RE,
};
