'use strict';

/**
 * plugin.js —— IDE 插件（编辑器 globalStorage）来源读取器（plugin kind 的底层数据读取）。
 *
 * 只认"插件结构化落盘"这一路（genie-history / todos / message-queue / file-changes /
 * GitHub Copilot 的 session-store.db），与 CLI / hook 两路无关。
 * sessions.js 的 listSessions 在这里取结构化落盘，copilot.js 的 readSqliteSessionRows /
 * readCopilotSessions 在这里取 Copilot 自己的 SQLite —— 彼此不串味。
 *
 * 历史上的问题：这套读取逻辑最初全堆在 sessions.js，且 copilot.js 又反向 require 回 sessions.js
 * 取 findPluginStorage / readSqliteSessionRows（sessions ↔ copilot 循环依赖，靠运行时调用才没崩）。
 * 现在统一收口到这里：本文件只依赖 roots.js（平台目录约定）与 project.js（工程名解析），
 * **不**依赖任何具体楼层；Copilot SQLite 那一路的读取与 enrich 在 copilot.js 里做。
 *
 * 「绝不编造」纪律：读不到就是读不到，任何字段都不补、不猜。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { dataRoots, globalStorageRoots, isDir, isFile, readJson, readDir } = require('./roots');
const { resolveProjectName } = require('./project');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

/** 插件目录名（腾讯 Coding Copilot、GitHub Copilot、别名兜底）—— 通用插件落盘匹配 */
const PLUGIN_RE = [/coding-copilot/i, /github\.copilot/i, /github-copilot/i, /^codebuddy/i, /^tencent/i, /^ingram/i, /^copilot/i];

/** 落盘窗口（与 CLI 楼层对齐，sessionRegistry 的 TIMEOUT_MS = 60 分钟） */
const IDLE_MS = 10 * 60_000; // 多久没动静算"不活跃"（插件 runtime 没有心跳，只能用文件时间）
const BUSY_MS = 90_000; // 文件改动在这么久之内 → 认为正在动手
const FRESH_MS = 2 * 60_000; // 落盘在这么久之内 → 这一轮对话还在推进（含纯推理、只读工具等拿不到文件/待办证据的情况）
const LISTED_MS = 60 * 60_000; // 会话"还在下拉里"的窗口（见 sessions.js 说明）
const DONE_TTL_MS = 10 * 60_000; // 完成标记的"新鲜期"：只有这么久之内结束的才算"刚发生"

function mtime(p) {
  try {
    return Math.round(fs.statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

/** 编辑器 workspaceStorage 目录（VS Code 按工作区存 state.vscdb 的地方） */
function workspaceStorageRoots() {
  const out = [];
  for (const r of dataRoots()) {
    for (const ed of ['Code', 'Code - Insiders', 'Cursor', 'Trae', 'Windsurf', 'VSCodium']) {
      const p = path.join(r, ed, 'User', 'workspaceStorage');
      if (isDir(p)) out.push(p);
    }
  }
  const srv = path.join(HOME, '.vscode-server', 'data', 'User', 'workspaceStorage');
  if (isDir(srv)) out.push(srv);
  return out;
}

/**
 * 插件落盘根目录：按名字前缀在 globalStorage 里找出"这一个产品"的插件目录。
 * 命中优先级：GitHub Copilot > 腾讯/CodeBuddy 家族 > 其它（见 priority）。
 * 一份落盘要"有会话相关子目录"才算数（genie-history / todos / file-changes / message-queue /
 * session-store.db）。
 * @param {RegExp|RegExp[]} [re] 产品目录名匹配；默认 PLUGIN_RE（所有插件）。找不到回 ''
 */
function findPluginStorage(re = PLUGIN_RE) {
  const list = re instanceof RegExp ? [re] : re || [];
  const marks = ['genie-history', 'todos', 'file-changes', 'message-queue', 'session-store.db'];
  const priority = (name) => {
    const n = String(name || '').toLowerCase();
    if (/github\.copilot|github-copilot|^copilot/i.test(n)) return 0;
    if (/coding-copilot|tencent|ingram|codebuddy/i.test(n)) return 1;
    return 2;
  };
  for (const root of globalStorageRoots()) {
    const names = [...readDir(root)].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
    for (const name of names) {
      if (!list.some((rx) => rx.test(name))) continue;
      const p = path.join(root, name);
      const hasSessionStore = isFile(path.join(p, 'session-store.db'));
      if (hasSessionStore || marks.some((m) => isDir(path.join(p, m)) || (m === 'session-store.db' ? isFile(path.join(p, m)) : false))) {
        return p;
      }
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

/**
 * 补全被扩展截断的工程路径（genie-history 目录名截到 64 字符 → 解出来只剩半截）。
 * 在已知真实工程（按可信度排序）里找一条以半截串为前缀的补上；优先磁盘上真实存在的目录。
 * 补不上就原样返回，不影响没被截断的机器。
 */
function completeTruncatedWorkspace(decoded, candidates) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!decoded || isDir(decoded)) return decoded; // 磁盘上真有这个目录 = 没被截断
  const want = norm(decoded);
  if (!want) return decoded;
  // 顺序即优先级：候选里第一条"以半截串为前缀（截断=纯前缀截断）"就是答案。不做"取最短"——
  // 两条候选共享同一截断前缀时，按长短挑会挑错工程；按可信度排序才能保证真实活动工程（ws，放最前）优先补上。
  // isDir 只作**优先判据，不作硬门槛**：优先补到磁盘上真实存在的目录，都没有就按顺序退回第一条命中。
  let fallback = '';
  for (const c of candidates || []) {
    if (!c) continue;
    const n = norm(c);
    if (!n || n === want || !n.startsWith(want)) continue;
    if (isDir(c)) return c;
    if (!fallback) fallback = c;
  }
  return fallback || decoded;
}

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

/** 文件当前字节大小（按绝对路径现 stat）。删除类改动的源文件已不存在 → null，绝不编造。 */
function fileSizeOf(fp) {
  if (!fp || typeof fp !== 'string') return null;
  try {
    const s = fs.statSync(fp);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
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
      // 字节大小：文件本体（filePath 是绝对路径）现 stat。插件 / IDE 这份落盘只给行数、
      // 不给体积，只能服务端现算；删除类改动的源文件已不在，算不到就留 null。
      size: fileSizeOf(j.filePath),
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

/** genie-history 下每个 base64 目录 = 一个工程（目录名解出来就是工程绝对路径） */
function collectProjects(storage, candidates = []) {
  const gh = path.join(storage, 'genie-history');
  const out = [];
  for (const name of readDir(gh)) {
    const dir = path.join(gh, name);
    if (!isDir(dir)) continue;
    const ws = completeTruncatedWorkspace(decodeDirName(name), candidates);
    if (!ws) continue;
    out.push({ dir, path: ws, project: resolveProjectName(ws) || path.basename(ws) });
  }
  return out;
}

module.exports = {
  PLUGIN_RE,
  findPluginStorage,
  dataRoots,
  globalStorageRoots,
  workspaceStorageRoots,
  decodeDirName,
  completeTruncatedWorkspace,
  readTodos,
  readFileChanges,
  readRuntime,
  collectProjects,
  // 落盘窗口常量（插件来源与 CLI 楼层对齐）：sessions.js / copilot.js 共用，避免各定义一份
  IDLE_MS,
  BUSY_MS,
  FRESH_MS,
  LISTED_MS,
  DONE_TTL_MS,
};
