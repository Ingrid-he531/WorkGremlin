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
const path = require('path');
const { resolveProjectName } = require('./project');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const IS_WIN = process.platform === 'win32';

/** 插件目录名（腾讯 Coding Copilot，别名兜底） */
const PLUGIN_RE = [/coding-copilot/i, /^codebuddy/i, /^tencent/i, /^ingram/i];

/** 缓存：列表扫盘 + 读十几个小 json，5 秒足够 */
const TTL = 5_000;
let cache = { at: 0, key: '', value: null };

/**
 * 本进程（server）的启动时刻 —— "纪元"起点。
 * reporter 把相位写进本地状态文件、且不会被主动删除；上次运行（尤其被 kill/崩溃、
 * 没走 SessionEnd）留下的相位会在重启后被重新读到，表现为"已关闭的工程又亮了思考中"。
 * 所以只采信"本进程启动之后"写入的相位：重启后一律先回到待命，等下一个新事件再点亮。
 * 用时间戳比较而不是"退出时删文件"，是因为删除依赖干净退出，kill -9 / 崩溃时根本删不到。
 */
const SERVER_STARTED_AT = Date.now();

/** 多久没动静算"不活跃"（插件 runtime 没有心跳，只能用文件时间） */
const IDLE_MS = 10 * 60_000;
/** 文件改动在这么久之内 → 认为正在动手 */
const BUSY_MS = 90_000;
/** 落盘在这么久之内 → 认为这一轮对话还在推进（含纯推理、只读工具等拿不到文件/待办证据的情况） */
const FRESH_MS = 2 * 60_000;

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
 * reporter hook 在"等权限"时会把要执行的工具 + 目标文件写进 ~/.workgremlin/hooks/<工位>.json
 * 的 `await` 字段（见 packages/reporter/src/hook.js）。这里读回来给主控制台用。
 * 多工位时取 workspacePath 匹配且最新的一条；没有匹配工程就取最新一条。
 * 超过新鲜期的（默认 5 分钟）视为过期作废，避免权限已处理却还显示"等待授权"。
 * @returns {{tool: string, file: string}|null}
 */
const AWAIT_TTL_MS = 5 * 60_000;
/**
 * 等授权兜底阈值：本环境实测 CodeBuddy 不发 permission_prompt 通知（events.log 无 Notification 行），
 * 所以靠 hook 留下的 pending 推断——PreToolUse 写 pending + sessionPhase=tool，PostToolUse 才清掉它。
 * 一旦 pending 超过这个时间仍没被清（没有 PostToolUse 来），就认为工具被权限框卡住了 → 标「等待授权」。
 * 设 3.5s：绝大多数工具在 PreToolUse..PostToolUse 之间远小于此值，不会误报；权限框通常一弹就卡住不动。
 */
const AWAIT_PROBE_MS = 3_500;

/**
 * 这些工具永远不该被标成"等待授权"：
 *  - 只读 / 诊断类（Read/Grep/Glob/...）：本就不弹权限框；且本环境实测它们不发 PostToolUse，
 *    一旦 pending 残留就会误报成 await。
 *  - 命令类（Bash/execute_command）：可能弹 run 权限框，但本环境实测同样不发 PostToolUse，
 *    点了 run 开始执行后 pending 永远清不掉 → 会卡成"等待授权"。所以也不参与兜底推断，
 *    避免出现"点了 run 还在等授权"的误报（需要真信号时再放开，见 hook.js 的 PROBE_TOOLS）。
 */
const NEVER_AWAIT_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'ReadLints', 'read_file', 'search_content', 'search_file', 'read_lints', 'list_dir',
  'RAG_search', 'web_fetch', 'web_search', 'use_skill', 'ask_followup_question', 'read_rules', 'task', 'update_memory', 'todo_write', 'send_message',
  'Bash', 'execute_command',
]);

function reporterHookHome() {
  return process.env.WORKGREMLIN_HOME || path.join(os.homedir(), '.workgremlin');
}

/**
 * reporter hook 的"主控制台相位"：每次事件都会把当前相位（thinking/tool/await）写进
 * ~/.workgremlin/hooks/<工位>.json 的 `sessionPhase` 字段（见 packages/reporter/src/hook.js）。
 * 这是上报真值，优先级高于从 genie-history 推断出来的相位，UI 按真值展示（不标"推断"）。
 * 超过新鲜期（5 分钟）视为作废，避免 IDE 关掉后残留相位一直挂着。
 * 顺带返回同一份状态文件里的 pending（PreToolUse 写、PostToolUse 清），专供"等授权"兜底推断。
 * @returns {{phase: string, tool: string, file: string, pending: {tool: string, file: string, at: number}|null}|null}
 */
function readReporterPhase(workspacePath) {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  let win = null;
  let winPending = null;
  let winPrompt = '';
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    const sp = j && j.sessionPhase;
    if (!sp || !sp.ts || now - sp.ts > AWAIT_TTL_MS) continue;
    // 相位早于本进程启动 → 上次运行留下的残留（已关闭的工程），不采信；重启后等新事件再亮
    if (sp.ts < SERVER_STARTED_AT) continue;
    if (workspacePath && sp.workspacePath && path.resolve(sp.workspacePath) !== path.resolve(workspacePath)) continue;
    if (!win || sp.ts > win.ts) {
      win = sp;
      // 同一份状态文件里的 pending：PreToolUse 写、PostToolUse 清掉；迟迟不清 = 工具被权限框卡住
      winPending = j.pending || null;
      // 同一份状态文件里的 taskTitle = 用户那句话（标题），思考中时要顶到屏幕最前显示
      winPrompt = j.taskTitle || '';
    }
  }
  if (!win) return null;
  return {
    phase: String(win.phase || 'thinking'),
    tool: String(win.tool || ''),
    file: String(win.file || ''),
    // hook 在 PreToolUse 写的"实际调用"可读命令（Read src/main.js / grep ... / Bash ...），
    // 给主控制台 tips 当"工具"显示，比纯工具名更直观
    cmd: String(win.cmd || ''),
    // 用户那句话（思考中时主控制台屏幕第三层顶到最前显示；UI 只在 thinking 相位用）
    prompt: String(winPrompt || ''),
    pending: winPending
      ? { tool: String(winPending.tool || ''), file: String(winPending.file || ''), cmd: String(winPending.cmd || ''), at: Number(winPending.at) || 0 }
      : null,
  };
}

/**
 * 主 Agent 上报相位（已映射成 UI 字段）。轻量接口 /api/v1/reporter-phase 也用它，
 * 避免把"调用工具 / 等待授权"的文案映射写两遍。
 * @param {string} workspacePath 当前工程；空则不限工程
 * @returns {{phase:string, action:string, target:string, context:string[]}|null}
 */
function reporterMainPhase(workspacePath) {
  const rp = readReporterPhase(workspacePath);
  if (!rp) return null;
  if (rp.phase === 'await') {
    return {
      phase: 'await',
      action: rp.tool ? `申请执行 ${rp.tool}` : '等待用户授权',
      target: rp.file || '',
      context: ['等待用户授权后继续', rp.tool && `工具：${rp.tool}`, rp.file && `目标：${rp.file}`].filter(Boolean),
      prompt: rp.prompt || '',
    };
  }
  // 等授权兜底：本环境实测 CodeBuddy 不发 permission_prompt 通知（events.log 无 Notification 行），
  // 所以靠 hook 留下的 pending 推断——PreToolUse 写了 pending + sessionPhase=tool，
  // 若超过 AWAIT_PROBE_MS 仍无 PostToolUse 来清掉，说明工具被权限框卡住了。
  // 只读 / 命令类工具（NEVER_AWAIT_TOOLS）本就不发 PostToolUse、也不该弹权限框，排除掉避免误报
  // （典型误报：读文件却显示「等待授权」、点了 run 还在「等待授权」）。
  if (
    rp.phase === 'tool' &&
    rp.pending &&
    rp.pending.at &&
    Date.now() - rp.pending.at > AWAIT_PROBE_MS &&
    !NEVER_AWAIT_TOOLS.has(rp.pending.tool || rp.tool)
  ) {
    const tool = rp.pending.tool || rp.tool;
    const file = rp.pending.file || rp.file;
    return {
      phase: 'await',
      action: tool ? `申请执行 ${tool}` : '等待用户授权',
      target: file || '',
      context: ['等待用户授权后继续', tool && `工具：${tool}`, file && `目标：${file}`].filter(Boolean),
      prompt: rp.prompt || '',
    };
  }
  if (rp.phase === 'tool') {
    // 优先显示 hook 报上来的完整命令（Read src/main.js / grep ... / Bash npm run build），
    // 没有再回退到「调用 Xxx」泛化文案。
    // action 是具体在做什么；tool 只显示工具名，不要塞完整命令。
    const cmd = rp.cmd || (rp.tool ? `调用 ${rp.tool}` : '调用工具');
    return {
      phase: 'tool',
      action: cmd,
      tool: rp.tool || '',
      target: rp.file || '',
      context: rp.file ? [`目标：${rp.file}`] : [],
      prompt: rp.prompt || '',
    };
  }
  // thinking：干净，不堆示意字；但把用户那句话（prompt）一并带出，屏幕第三层顶到最前显示
  return { phase: 'thinking', action: '', target: '', context: [], prompt: rp.prompt || '' };
}

/**
 * reporter hook 的"活跃窗口"：UserPromptSubmit 落 taskId、Stop 清空。
 * 只有在这个窗口内（用户提交了任务、agent 还没收工）才算"活着"；
 * 会话存在但没有事件时一律待命 —— 主控制台据此决定要不要显示活跃状态。
 *
 * 还要校验"这份状态文件本身是否还活着"：历史遗留 / 已退出的会话会在 hooks 目录里
 * 留下 taskId 不再更新的死文件（例如改「按工位+工程分文件」之前的老命名文件）。
 * 不校验的话，只要有一个死文件的 taskId 跟当前工程匹配，inWindow 就会被永久顶成 true，
 * 于是 Stop 之后仍旧按"还在干活"推出「思考中」。
 * @param {string} workspacePath 当前打开的工程；空则不限工程
 * @returns {boolean}
 */
function readReporterActiveTask(workspacePath) {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j || !j.taskId) continue;
    const ws = j.taskWorkspacePath || '';
    if (workspacePath && ws && path.resolve(ws) !== path.resolve(workspacePath)) continue;
    // 心跳时间 / 任务开始 / 相位时间三者取最新：最近还有 hook 事件才算这个会话活着。
    // 超过相位新鲜期（AWAIT_TTL_MS）没动静 → 视为死会话，它的 taskId 不作数。
    const lastAt = Math.max(
      Number(j.hb && j.hb.lastEventAt) || 0,
      Number(j.taskStartedAt) || 0,
      Number(j.sessionPhase && j.sessionPhase.ts) || 0
    );
    if (!lastAt || now - lastAt > AWAIT_TTL_MS) continue;
    return true;
  }
  return false;
}

/** reporter hook 在 Stop 时落的"完成"标记（带工程路径）。按工程归属取，
 *  作为"任务完成"的唯一真源——不靠相位回落到空闲来猜，避免中途误弹。 */
function readReporterDone(workspacePath) {
  const dir = path.join(reporterHookHome(), 'hooks');
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j || !j.done || !j.done.at) continue;
    const ws = j.done.workspacePath || '';
    if (workspacePath && ws && path.resolve(ws) !== path.resolve(workspacePath)) continue;
    return j.done;
  }
  return null;
}

/**
 * 当前"真正在敲"的工程：取 reporter hook 最近一次写相位 / task 的工程路径。
 * reporter 把相位打在 REAL_WS（它实际运行的工程），而不是 office 手工"打开工程"记的那个，
 * 所以这里用最新活动判定，避免 IDE 里直接开新工程时相位错归到旧工程（主控制台对不上下拉）。
 * 超过新鲜期（AWAIT_TTL_MS）视为失效，回落到传入的 fallback（通常是 office 当前打开的工程）。
 * @param {string} fallback 回落值
 * @returns {string}
 */
function freshestReporterWs(fallback) {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  let best = '';
  let bestTs = 0;
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    const sp = j.sessionPhase;
    const ts = (sp && sp.ts) || (j.taskId ? j.taskStartedAt || 0 : 0);
    const ws = (sp && sp.workspacePath) || j.taskWorkspacePath || '';
    if (!ws || !ts || now - ts > AWAIT_TTL_MS) continue;
    // 同上：只认本进程启动之后写入的相位，避免用上次运行的残留判定"当前工程"
    if (ts < SERVER_STARTED_AT) continue;
    if (ts > bestTs) {
      bestTs = ts;
      best = ws;
    }
  }
  return best ? path.resolve(best) : fallback ? path.resolve(fallback) : '';
}

/**
 * 主 Agent 阶段：会话落盘里没有"阶段"这个字段，只能推。
 * 所以返回值一律带 inferred: true，UI 按推断展示。
 */
function inferPhase({ todos, files, runtime, pending, lastUpdated, now, inWindow }) {
  // 活跃窗口 = reporter hook 的 UserPromptSubmit..Stop（本地状态文件 taskId 非空）。
  // 不在窗口内 → 一律待命：会话存在但没有事件，绝不凭空显示活跃状态。
  if (!inWindow) {
    return { phase: 'idle', action: '', inferred: true };
  }
  // 没有任何线索（没待办、没改文件、没运行态）→ 空闲
  if (!todos.total && !files.count && !runtime.activated) {
    return { phase: 'idle', action: '', inferred: true };
  }
  // 重启纪元：推断用的时间证据（文件改动 / 待办 / 运行态落盘）也必须是**本进程启动之后**的。
  // 否则"上次运行留下的最后一次文件改动"（仍在 BUSY_MS 窗口内）会在重启瞬间被判成「调用工具」，
  // 与"重启后先待命、等下一个新事件"相悖。与 readReporterPhase 用同一把尺子。
  const afterRestart = (ts) => Number(ts) >= SERVER_STARTED_AT;
  // 显式状态也只在"近期真有动静"时采信，避免 IDE 关掉后残留的运行态一直挂着
  if (runtime.paused && afterRestart(lastUpdated) && now - lastUpdated < IDLE_MS) {
    return { phase: 'idle', action: '会话已暂停', inferred: true };
  }
  if (runtime.awaitingSessionIdle && afterRestart(lastUpdated) && now - lastUpdated < IDLE_MS) {
    return { phase: 'summarize', action: '等会话空闲后收尾', inferred: true };
  }

  // 正在干活：必须"新鲜"证据，否则 IDE 关掉后残留的 in_progress 待办 / 文件改动会一直显示「工具中」
  if (todos.doing && afterRestart(todos.at) && now - todos.at < IDLE_MS) {
    return { phase: 'tool', action: todos.doing, inferred: true };
  }
  if (afterRestart(files.lastAt) && now - files.lastAt < BUSY_MS) {
    const f = files.recent[0];
    return { phase: 'tool', action: `改 ${f.name}（+${f.added}/-${f.removed}）`, inferred: true };
  }
  // 运行态极新鲜（插件最近在落盘）→ 这一轮对话真的在推进（含纯推理、只读工具等拿不到文件/待办证据的情况）。
  // 没有"正在调工具"的硬证据，只是知道在动，归到「思考中」——绝不凭空显示「调用工具」。
  if (afterRestart(lastUpdated) && now - lastUpdated < FRESH_MS) {
    return { phase: 'thinking', action: '', inferred: true };
  }

  // 有排队待发消息（且不是陈年残留）→ 规划 / 待处理
  if (pending > 0 && afterRestart(lastUpdated) && now - lastUpdated < IDLE_MS) {
    return { phase: 'plan', action: `${pending} 条待发消息排队中`, inferred: true };
  }

  // 没有新动静：IDE 多半关了 / 在等用户。回空闲，不再凭"激活过"瞎显示「规划中」
  return { phase: 'idle', action: '会话空闲', inferred: true };
}

/** 单个会话的完整信息 */
function sessionInfo(storage, id, { current = false, now = Date.now(), workspacePath = '', inWindow = false } = {}) {
  const todos = readTodos(storage, id);
  const files = readFileChanges(storage, id);
  const mq = readRuntime(storage, id);
  const lastUpdated = Math.max(todos.at, files.lastAt, mq.updatedAt) || null;
  // 活跃 = 当前会话且近期有动静 / 运行态新鲜 / 刚改过文件。
  // 关键：关掉 IDE 后插件不再落盘，但 current.json 仍指向它、runtime.activated 也残留为真，
  // 所以不能只靠 current / activated 判定活跃，必须用"近期有写入"确认它真的还活着，
  // 否则关掉窗口的会话会一直卡在列表里、相位还停在「规划中」。
  const active = Boolean(
    (current && lastUpdated && now - lastUpdated < IDLE_MS) ||
      (mq.runtime.activated && lastUpdated && now - lastUpdated < IDLE_MS) ||
      (files.lastAt && now - files.lastAt < BUSY_MS)
  );
  const inferred = inferPhase({ todos, files, runtime: mq.runtime, pending: mq.pending, lastUpdated, now, inWindow });

  /** 悬浮屏第三层：任务清单（状态用符号标出来，不做翻译） */
  const mark = { completed: '✓', in_progress: '▶', pending: '·' };
  let phase = inferred.phase;
  let action = inferred.action;
  let target = '';
  let tool = '';
  let context = todos.items.map((t) => `${mark[t.status] || '·'} ${t.content}`);

  // 上报真值：reporter hook 把每个事件的相位（思考中 / 调用工具 / 等待授权）落到本地状态文件。
  // 优先级高于从 genie-history 推断的相位；只在"当前会话"上生效（相位必然出在这只 agent 身上）。
  let reported = false;
  let prompt = '';
  if (current && inWindow) {
    const rp = reporterMainPhase(workspacePath);
    if (rp) {
      reported = true;
      phase = rp.phase;
      action = rp.action;
      target = rp.target;
      context = rp.context;
      tool = rp.tool || '';
      prompt = rp.prompt || '';
    }
  }

  // 完成标记：reporter 仅在 Stop 时落盘（且按工程区分），是"任务完成"的唯一真源；
  // 比"相位回落到空闲"可靠——任务中途因轮询间隙 / 跨工程串味出现空闲，绝不冒充完成。
  const done = readReporterDone(workspacePath) || null;
  const doneAt = done ? done.at : 0;
  const doneTitle = done ? done.title || '' : '';
  const doneFiles = done ? (Array.isArray(files.recent) ? files.recent.slice(0, 6) : []) : [];

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
    phase,
    action,
    target,
    tool,
    context,
    prompt,
    doneAt,
    doneTitle,
    doneFiles,
    inferred: !reported, // 上报真值（reporter hook）不算推断
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
  // 会话归属用的"当前工程"跟随 reporter 真实活动的最新工程，
  // 而不是 office 手工"打开工程"记的那个（IDE 里直接开新工程时两者会脱节）。
  const ws = freshestReporterWs(workspacePath);
  const now = Date.now();
  if (!force && cache.value && cache.key === ws && now - cache.at < TTL) return cache.value;

  const storage = findPluginStorage();
  if (!storage) {
    cache = {
      at: now,
      key: ws,
      value: { ok: true, sessions: [], current: '', workspacePath: ws, storage: '', reason: 'no-storage' },
    };
    return cache.value;
  }

  /** 会话 id -> 归属（工程名 / 工程路径）。每个工程自己的"当前会话"单独记，
   *  不做成全局唯一 —— 这样多工程时每条工程里的活跃会话都能拿到自己 reporter 的实时相位，
   *  主控制台跟随下拉选中的那条，不再被全局"最后一个 reporter"覆盖。 */
  const meta = new Map();
  const perProjectCurrent = new Map(); // 工程路径 -> 该工程 current.json 指向的会话 id
  let currentId = '';
  for (const p of collectProjects(storage)) {
    const cur = readJson(path.join(p.dir, 'current.json')) || {};
    const cid = cur && cur.conversationId ? String(cur.conversationId) : '';
    if (cid) {
      perProjectCurrent.set(p.path, cid);
      // 全局唯一的"当前会话"仍认真实活动工程（ws）里那条，用于默认选中 / 高亮
      if (p.path === ws) currentId = currentId || cid;
    }
    for (const id of readDir(path.join(p.dir, 'conversations'))) {
      if (id) meta.set(id, { project: p.project, projectPath: p.path });
    }
    if (cid && !meta.has(cid)) meta.set(cid, { project: p.project, projectPath: p.path });
  }
  // 兜底：插件新版可能不写 genie-history，会话只在 todos / 消息队列里露过头。
  // 这类会话没有工程归属（project 留空），但它是"正在跑的那个"，不列出来更糟。
  for (const name of readDir(path.join(storage, 'todos'))) {
    const id = name.replace(/\.json$/i, '');
    if (id && !meta.has(id)) meta.set(id, { project: '', projectPath: '' });
  }

  const sessions = [];
  for (const [id, m] of meta) {
    // 这条会话是不是它"自己工程"里当前开着的那个（每个工程各算各的，可多条同时为 true）。
    // 只有它才吃得到本工程 reporter 上报的实时相位；别的工程 / 历史会话一律走推断。
    const isProjectCurrent = id === (perProjectCurrent.get(m.projectPath) || '');
    // 活跃窗口按"这条会话自己的工程"匹配 reporter 的 taskId：工程没在跑就不采信它的相位，
    // 避免旧工程残留的"思考中"相位在 IDE 关掉 / 切走后还挂着。
    const inWindow = readReporterActiveTask(m.projectPath);
    const info = sessionInfo(storage, id, { current: isProjectCurrent, now, workspacePath: m.projectPath, inWindow });
    if (!info.active) continue; // 下拉只要活跃会话
    sessions.push({
      ...info,
      project: m.project,
      projectPath: m.projectPath,
      /** 属于当前真实活动工程（ws）—— 只有它才有幽灵清单可看 */
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

module.exports = { listSessions, findPluginStorage, decodeDirName, reporterMainPhase, freshestReporterWs };
