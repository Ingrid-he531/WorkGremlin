'use strict';

/**
 * 会话（conversation）—— 当前智能体（CodeBuddy 插件）在各个工程下开着的会话。
 *
 * 真源是插件自己的落盘（不经我们同意也一直在写），四个目录互相索引：
 *   genie-history/{base64(工程目录)}/conversations/{会话id}/   工程 ↔ 会话名单（目录本身是空的）
 *   genie-history/{base64(工程目录)}/current.json              { conversationId, lastUpdated } 该工程当前会话
 *   todos/{会话id}.json                                        { conversationId, todos:[{id,status,content}] }
 *   message-queue/*.json                                       每会话 runtime:{activated,paused,awaitingSessionIdle} + 排队消息
 *   file-changes/{会话id}/*.json                               改动文件（增删行 + diff）
 *
 * 下拉要的是**所有工程里活跃着的会话**（不限当前打开的那个工程），所以这里
 * 遍历 genie-history 下每个工程目录；一个活跃会话都没有 → reason: 'no-open-project'。
 *
 * 纪律（对齐 docs/requirements.md §P0-6「绝不编造」）：
 *   - 会话里**没有**职务 / 进度 / 耗时这些字段，一行都不补，拿不到就是拿不到；
 *   - 主 Agent 的阶段是从 runtime + todos + 文件改动**推**出来的，全部标 `inferred: true`，
 *     UI 侧要按"推断"展示（灰显 + 标注），不能当成上报值。
 *
 * 扫盘便宜（几十个文件），缓存 5 秒足够。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveProjectName } = require('./project');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const IS_WIN = process.platform === 'win32';

/** 插件目录名（腾讯 Coding Copilot，别名兜底） */
const PLUGIN_RE = [/coding-copilot/i, /^codebuddy/i, /^tencent/i, /^ingram/i];

/** 缓存：列表扫盘 + 读十几个小 json，5 秒足够 */
const TTL = 5_000;
let cache = { at: 0, key: '', value: null };

/** 多久没动静算"不活跃"（插件 runtime 没有心跳，只能用文件时间） */
const IDLE_MS = 10 * 60_000;
/** 文件改动在这么久之内 → 认为正在动手 */
const BUSY_MS = 90_000;

/* ------------------------------ 基础工具 ------------------------------ */

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readDir(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

function mtime(p) {
  try {
    return Math.round(fs.statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

/* ------------------------------ 定位插件落盘 ------------------------------ */

/** 平台级应用数据根目录 */
function dataRoots() {
  const roots = [];
  if (process.platform === 'darwin') {
    roots.push(path.join(HOME, 'Library', 'Application Support'));
  } else if (IS_WIN) {
    if (process.env.APPDATA) roots.push(process.env.APPDATA);
    if (process.env.LOCALAPPDATA) roots.push(process.env.LOCALAPPDATA);
  } else {
    roots.push(path.join(HOME, '.config'), path.join(HOME, '.local', 'share'));
  }
  return roots.filter(isDir);
}

/** 编辑器 globalStorage 目录（插件落盘的地方） */
function globalStorageRoots() {
  const out = [];
  for (const r of dataRoots()) {
    for (const ed of ['Code', 'Code - Insiders', 'Cursor', 'Trae', 'Windsurf', 'VSCodium']) {
      const p = path.join(r, ed, 'User', 'globalStorage');
      if (isDir(p)) out.push(p);
    }
  }
  const srv = path.join(HOME, '.vscode-server', 'data', 'User', 'globalStorage');
  if (isDir(srv)) out.push(srv);
  return out;
}

/** 插件目录名会带版本号，所以按名字前缀找；要求里面有会话相关子目录才算数 */
function findPluginStorage() {
  const marks = ['genie-history', 'todos', 'file-changes', 'message-queue'];
  for (const root of globalStorageRoots()) {
    for (const name of readDir(root)) {
      if (!PLUGIN_RE.some((re) => re.test(name))) continue;
      const p = path.join(root, name);
      if (marks.some((m) => isDir(path.join(p, m)))) return p;
    }
  }
  return '';
}

/** 目录名是工程路径的 base64；解不出来（不是路径）就返回空 */
function decodeDirName(name) {
  try {
    const s = Buffer.from(String(name), 'base64').toString('utf8');
    if (!s || s.includes('\u0000')) return '';
    if (s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s)) return s;
  } catch {
    /* 不是 base64，跳过 */
  }
  return '';
}

/* ------------------------------ 会话数据 ------------------------------ */

/** 每个会话的待办：total / done / doing（第一条 in_progress）/ 前几条的文案 */
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

/** 改动文件：按最后写入倒序取最近几个 */
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
      at: mtime(p),
    });
  }
  out.sort((a, b) => b.at - a.at);
  return { count: out.length, recent: out.slice(0, 6), lastAt: out.length ? out[0].at : 0 };
}

/**
 * 消息队列里该会话的运行态 + 排队条数。
 * 一个 message-queue 文件里可能装着多个会话，全部扫一遍取自己的那份。
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
    updatedAt = Math.max(updatedAt, Number(conv.updatedAt) || 0, mtime(path.join(dir, name)));
  }
  return {
    runtime: runtime || { activated: false, paused: false, awaitingSessionIdle: false },
    pending,
    hasRuntime: Boolean(runtime),
    updatedAt,
  };
}

/**
 * 主 Agent 阶段：会话落盘里没有"阶段"这个字段，只能推。
 * 所以返回值一律带 inferred: true，UI 按推断展示。
 */
function inferPhase({ todos, files, runtime, pending, lastUpdated, now }) {
  if (!todos.total && !files.count && !runtime.activated) {
    return { phase: 'idle', action: '', inferred: true };
  }
  if (runtime.paused) return { phase: 'idle', action: '会话已暂停', inferred: true };
  if (runtime.awaitingSessionIdle) return { phase: 'summarize', action: '等会话空闲后收尾', inferred: true };
  if (todos.doing) return { phase: 'tool', action: todos.doing, inferred: true };
  if (files.lastAt && now - files.lastAt < BUSY_MS) {
    const f = files.recent[0];
    return { phase: 'tool', action: `改 ${f.name}（+${f.added}/-${f.removed}）`, inferred: true };
  }
  if (pending > 0) return { phase: 'plan', action: `${pending} 条待发消息排队中`, inferred: true };
  if (lastUpdated && now - lastUpdated < IDLE_MS && runtime.activated) {
    return { phase: 'plan', action: '会话活跃中', inferred: true };
  }
  return { phase: 'idle', action: '会话空闲', inferred: true };
}

/** 单个会话的完整信息 */
function sessionInfo(storage, id, { current = false, now = Date.now() } = {}) {
  const todos = readTodos(storage, id);
  const files = readFileChanges(storage, id);
  const mq = readRuntime(storage, id);
  const lastUpdated = Math.max(todos.at, files.lastAt, mq.updatedAt) || null;
  // 当前会话（IDE 里正开着）一律算活跃；其余看 runtime 心跳 / 最近有没有动文件
  const active = Boolean(
    current ||
      (mq.runtime.activated && lastUpdated && now - lastUpdated < IDLE_MS) ||
      (files.lastAt && now - files.lastAt < BUSY_MS)
  );
  const inferred = inferPhase({ todos, files, runtime: mq.runtime, pending: mq.pending, lastUpdated, now });

  /** 悬浮屏第三层：任务清单（状态用符号标出来，不做翻译） */
  const mark = { completed: '✓', in_progress: '▶', pending: '·' };
  const context = todos.items.map((t) => `${mark[t.status] || '·'} ${t.content}`);

  return {
    id,
    current,
    active,
    // 有 runtime 说明插件还认这个会话；没有就是历史会话（只剩待办/改动的化石）
    live: Boolean(mq.hasRuntime),
    lastUpdated,
    runtime: mq.runtime,
    pending: mq.pending,
    todos: { total: todos.total, done: todos.done, doing: todos.doing, items: todos.items },
    files: { count: files.count, recent: files.recent, lastAt: files.lastAt || null },
    phase: inferred.phase,
    action: inferred.action,
    context,
    inferred: true, // 全部来自被动观测，不是上报值
  };
}

/* ------------------------------ 对外：列会话 ------------------------------ */

/**
 * genie-history 下每个 base64 目录 = 一个工程（目录名解出来就是工程绝对路径）。
 * @returns {Array<{dir: string, path: string, project: string}>}
 */
function collectProjects(storage) {
  const gh = path.join(storage, 'genie-history');
  const out = [];
  for (const name of readDir(gh)) {
    const dir = path.join(gh, name);
    if (!isDir(dir)) continue;
    const ws = decodeDirName(name);
    if (!ws) continue;
    out.push({ dir, path: ws, project: resolveProjectName(ws) || path.basename(ws) });
  }
  return out;
}

/**
 * 列出**所有工程**里的活跃会话（不局限于当前打开的那个工程）。
 * @param {{workspacePath?: string, force?: boolean}} o
 * @returns {{ok: true, sessions: Array, current: string, workspacePath: string,
 *            storage: string, reason?: string}}
 *   reason: 'no-storage' 没找到插件落盘 / 'no-open-project' 一个活跃会话都没有
 */
function listSessions({ workspacePath = '', force = false } = {}) {
  const ws = workspacePath ? path.resolve(workspacePath) : '';
  const now = Date.now();
  if (!force && cache.value && now - cache.at < TTL) return cache.value;

  const storage = findPluginStorage();
  if (!storage) {
    cache = {
      at: now,
      key: ws,
      value: { ok: true, sessions: [], current: '', workspacePath: ws, storage: '', reason: 'no-storage' },
    };
    return cache.value;
  }

  /** 会话 id -> 归属（工程名 / 工程路径 / 是不是该工程正开着的那个） */
  const meta = new Map();
  let currentId = '';
  for (const p of collectProjects(storage)) {
    const cur = readJson(path.join(p.dir, 'current.json')) || {};
    const cid = cur && cur.conversationId ? String(cur.conversationId) : '';
    if (cid && p.path === ws) currentId = currentId || cid;
    for (const id of readDir(path.join(p.dir, 'conversations'))) {
      if (id) meta.set(id, { project: p.project, projectPath: p.path, current: id === cid });
    }
    if (cid && !meta.has(cid)) meta.set(cid, { project: p.project, projectPath: p.path, current: true });
  }
  // 兜底：插件新版可能不写 genie-history，会话只在 todos / 消息队列里露过头。
  // 这类会话没有工程归属（project 留空），但它是"正在跑的那个"，不列出来更糟。
  for (const name of readDir(path.join(storage, 'todos'))) {
    const id = name.replace(/\.json$/i, '');
    if (id && !meta.has(id)) meta.set(id, { project: '', projectPath: '', current: false });
  }

  const sessions = [];
  for (const [id, m] of meta) {
    const info = sessionInfo(storage, id, { current: m.current, now });
    if (!info.active) continue; // 下拉只要活跃会话
    sessions.push({
      ...info,
      project: m.project,
      projectPath: m.projectPath,
      /** 属于当前打开的工程 —— 只有它才有幽灵清单可看 */
      mine: Boolean(ws) && m.projectPath === ws,
    });
  }
  sessions.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    return (b.lastUpdated || 0) - (a.lastUpdated || 0);
  });

  cache = {
    at: now,
    key: ws,
    value: {
      ok: true,
      sessions,
      current: currentId,
      workspacePath: ws,
      storage,
      ...(sessions.length ? {} : { reason: 'no-open-project' }),
    },
  };
  return cache.value;
}

module.exports = { listSessions, findPluginStorage, decodeDirName };
