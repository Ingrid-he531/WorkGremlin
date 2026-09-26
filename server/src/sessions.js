'use strict';

/**
 * 会话（conversation）—— 受监控产品在各个工程下开着的会话。
 *
 * 同一层的 CLI 与 Plugin 两路落盘**不是同一份**，各自有各自的取法，但产出同一种会话行：
 *   · 插件那路（1F CodeBuddy 的插件形态、5F TraeCode Plugin）：就是本文件下面这套结构化落盘
 *     （genie-history / todos / message-queue / file-changes），能拿到运行态；
 *   · CLI 那路（1F CodeBuddy、2F、3F、4F）：会话在各自的会话 jsonl 里，只有文件时间可靠；
 *   · hook 那路（6F TraeCode IDE、1F CodeBuddy CLI 的兜底）：连 jsonl 都没有时，
 *     会话来源就是 reporter 状态文件（listReporterSessions）。
 * 楼层吃哪几路由 server/src/products.js 的 sources 声明（合并楼层可多路）。
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
const { clientBase } = require('@workgremlin/shared');
// 两个适配器同名导出（selectedModelOf），这里必须改名 —— 否则后一个静默盖掉前一个，
// 就会正好造出"某一层取不到模型"这个本次要修的 bug。
const { selectedModelOf: traeModelOf } = require('./traeModels');
const { selectedModelOf: claudeModelOf } = require('./claudeModels');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const IS_WIN = process.platform === 'win32';

/** 插件目录名（腾讯 Coding Copilot，别名兜底） */
const PLUGIN_RE = [/coding-copilot/i, /^codebuddy/i, /^tencent/i, /^ingram/i];

/**
 * 插件落盘这一路的来源客户端：**按楼层传入**，不再写死。
 * reporter 的状态文件按客户端分开写（同一个工程里 CodeBuddy / Codex / Claude … 各一份），
 * 每个插件楼层（1F CodeBuddy 的插件那一路、5F TraeCode-Plugin、未来的 Codex-Plugin …）只认自己
 * 这一路 —— 否则切到某层会看见别层在敲的命令、收工时还弹别层的「任务完成」。
 * 调用方（sessionRegistry）会把该楼层的 client（例如 'codebuddy-plugin' / 'trae-plugin'）传进来。
 * 合并楼层（1F CodeBuddy）另有一路 CLI 身份：见下面的 clientHit —— 它可以一次收一串 client。
 */

/**
 * 老状态文件（引入 client 字段之前写的）没有 client —— 那时只有 CodeBuddy 家族在写，
 * 所以这类文件按 codebuddy（CLI）归属。新文件一律带 client，不会走到这个兜底。
 * 注意：这只是历史兼容，绝不能当"默认客户端"用——client 必须显式传入。
 */
const LEGACY_STATE_CLIENT = 'codebuddy';

/**
 * 楼层身份匹配（轴 1 的过滤口径，全文件只此一处）。
 *
 * want 既可以是**单个 client**（如 'codebuddy-plugin'），也可以是**逗号分隔的一串** ——
 * 合并楼层（1F CodeBuddy 把 CLI 与 Plugin 合成一层）就是"一个楼层吃两路上报身份"，
 * 它把 clients 列表一起传进来（见 server/src/products.js 的 sources / clients）。
 * 别的楼层一律传单值，行为与改动前逐字一致（精确比对，不做基名放宽）——
 * 5F TraeCode Plugin 与 6F TraeCode IDE 必须靠这条继续分开。
 *
 * got 是状态文件里记的 client；老状态文件没有 client 字段 → 按 codebuddy（CLI）归属。
 * @param {string} want 楼层要求的 client（单个，或逗号分隔多个）；空 = 不限
 * @param {string} got 状态文件里的 client
 */
function clientHit(want, got) {
  if (!want) return true;
  const set = String(want)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!set.length) return true;
  return set.includes(String(got || LEGACY_STATE_CLIENT).toLowerCase());
}

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
/**
 * 会话"还在下拉里"的窗口 —— 与 CLI 楼层对齐（sessionRegistry 的 TIMEOUT_MS = 60 分钟）。
 *
 * 为什么不再用 IDLE_MS(10 分钟) 当在列标准：IDE 里开着但十几分钟没敲字的会话会被整条剔除，
 * 而同样空闲的 CLI 会话（3F Codex）却还在列表里，两边口径不一致（实测：插件那路空、CLI 有 4 条）。
 * 现在 IDLE_MS 只用来判断"相位还热不热"（inferPhase），不再决定会话是否出现。
 */
const LISTED_MS = 60 * 60_000;
/**
 * 完成标记的"新鲜期"：只有这么久之内结束的才算"刚发生"，才会回给界面。
 *
 * 为什么必须有：done 是**持久状态**（为了让一次一进程的 `codex exec` 也能看到完成摘要，
 * 会话结束后不清它），于是页面/楼层一打开就可能读到上一轮（甚至几小时前）的完成标记，
 * 把历史当成新闻重播一遍（现象：一开 3F 就弹「任务完成 · 链路测试完成」）。
 * 渲染层也做了"首次只当基线"的防护，这里是第二道，而且对旧前端也生效。
 */
const DONE_TTL_MS = 10 * 60_000;

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
function findPluginStorage(re = PLUGIN_RE) {
  // 与 products.js 的 matchIn 保持一致：pluginRe 既可是正则数组，也可是单个正则（如 /trae/i）
  const list = re instanceof RegExp ? [re] : re || [];
  const marks = ['genie-history', 'todos', 'file-changes', 'message-queue'];
  for (const root of globalStorageRoots()) {
    for (const name of readDir(root)) {
      if (!list.some((rx) => rx.test(name))) continue;
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

/**
 * 命令类工具（Bash / execute_command …）：**服务端一律按"调用工具"上报，不做任何特殊化**。
 *
 * 为什么不在这里把 Bash 标成 await（等待授权）或改文案：
 * 本环境实测 CodeBuddy Plugin既不发"等授权"通知、也不发"授权结束"通知，而命令类工具
 * 又不发 PostToolUse —— 于是"到底有没有在等授权"根本没有真信号。以前靠"工具是 Bash"
 * 直接标 await，结果点了 run 之后没有任何事件能把它清掉，主控制台就一路卡在「等待授权」。
 *
 * 现在服务端只如实上报：相位 tool（调用工具）+ 工具名 + 实际命令。
 * "要不要提示需要授权"交给渲染层按 tool 判断（见 renderer/src/iso/mainConsole.js 的
 * drawConsoleScreen），这样展示口径改起来不用动服务端。真正的授权信号（Notification）来时，
 * 仍走下面 rp.phase === 'await' 那条真值分支——那段逻辑保留不动。
 */

function reporterHookHome() {
  return process.env.WORKGREMLIN_HOME || path.join(os.homedir(), '.workgremlin');
}

/**
 * 这条会话在用什么模型。
 * 各产品模型字段的取法不通用，所以一个产品一个适配器、都从**各自的落盘**里捞：
 * TraeCode 见 traeModels.selectedModelOf，Claude Code 见 claudeModels.selectedModelOf。
 * 两者都是因为 hook payload 里压根没有模型字段才只能读盘。
 * 其余产品（CodeBuddy / Codex）payload 里有，用不着适配器；真取不到就留空（绝不编造）。
 * 这里只做"按 client 分派适配器"这一件事，避免把某个产品的私有存储格式写死进通用读函数，
 * 也保持和 products.js 的表驱动扩展约定一致（加新产品就往 MODEL_SOURCES 挂一条，不必改 this 函数）。
 * @param {string} client 楼层客户端（如 'trae' / 'trae-plugin' / 'claude' / 'codex' …）
 * @param {string} sessionId hook payload 的 session_id
 * @param {string} agentType hook payload 的 agent_type（已落盘）
 */
/** client → 取"这条会话当前模型"的适配器表；没挂的照旧取不到 */
const MODEL_SOURCES = { trae: traeModelOf, claude: claudeModelOf };
function sessionModel(client, sessionId, agentType = '') {
  // 按**基名**查表：同一产品的插件/CLI 两种形态（trae-plugin / claude-plugin …）落盘是同一份，
  // 适配器也只认产品，不该因为客户端带了个后缀就取不到（适配器对不认识的会话 id 一律回空串，
  // 所以这里放宽只会"多给一次机会"，不会给错模型）。
  const fn = MODEL_SOURCES[clientBase(client)];
  return fn ? fn(sessionId, agentType) || '' : '';
}

/**
 * reporter hook 的"主控制台相位"：每次事件都会把当前相位（thinking/tool/await）写进
 * ~/.workgremlin/hooks/<工位>.json 的 `sessionPhase` 字段（见 packages/reporter/src/hook.js）。
 * 这是上报真值，优先级高于从 genie-history 推断出来的相位，UI 按真值展示（不标"推断"）。
 * 超过新鲜期（5 分钟）视为作废，避免 IDE 关掉后残留相位一直挂着。
 * 顺带返回同一份状态文件里的 pending（PreToolUse 写、PostToolUse 清），专供"等授权"兜底推断。
 * @returns {{phase: string, tool: string, file: string, cmd: string, prompt: string, model: string, client: string, pending: {tool: string, file: string, cmd: string, at: number}|null}|null}
 */
function readReporterPhase(workspacePath, client = '', session = '') {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  let win = null;
  let winPending = null;
  let winPrompt = '';
  let winClient = '';
  let winModel = '';
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!sameSession(j, session)) continue;
    // 按客户端过滤。老状态文件（本次改动之前写的）没有 client 字段 —— 那会儿只有 CodeBuddy，
    // 所以按 codebuddy 归属，而不是"对谁都匹配"（否则刚重启、Codex 还没写过状态文件时，
    // 3F 会短暂借到 1F 的相位）。
    if (!clientHit(client, j.client)) continue;
    const sp = j.sessionPhase;
    if (!sp || !sp.ts || now - sp.ts > AWAIT_TTL_MS) continue;
    // 相位早于本进程启动 → 上次运行留下的残留（已关闭的工程），不采信；重启后等新事件再亮
    if (sp.ts < SERVER_STARTED_AT) continue;
    if (workspacePath && sp.workspacePath && path.resolve(sp.workspacePath) !== path.resolve(workspacePath)) continue;
    if (!win || sp.ts > win.ts) {
      win = sp;
      winClient = String(j.client || LEGACY_STATE_CLIENT);
      // 同一份状态文件里的 pending：PreToolUse 写、PostToolUse 清掉；迟迟不清 = 工具被权限框卡住
      winPending = j.pending || null;
      // 同一份状态文件里的 taskTitle = 用户那句话（标题），思考中时要顶到屏幕最前显示
      winPrompt = j.taskTitle || '';
      // 模型不在这份状态文件里（hook payload 不带），按会话去 TraeCode 自己的落盘取
      winModel = sessionModel(winClient, j.sessionId, j.agentType);
    }
  }
  if (!win) return null;
  return {
    // 这份相位是哪个客户端写的（Codex 有显式 PermissionRequest，不需要 pending 推断）
    client: String(winClient || LEGACY_STATE_CLIENT).toLowerCase(),
    phase: String(win.phase || 'thinking'),
    tool: String(win.tool || ''),
    file: String(win.file || ''),
    // hook 在 PreToolUse 写的"实际调用"可读命令（Read src/main.js / grep ... / Bash ...），
    // 给主控制台 tips 当"工具"显示，比纯工具名更直观
    cmd: String(win.cmd || ''),
    // 用户那句话（思考中时主控制台屏幕第三层顶到最前显示；UI 只在 thinking 相位用）
    prompt: String(winPrompt || ''),
    // 这条会话在用什么模型（只有 TraeCode 取得到；别的楼层留空）。取不到就是空串，不猜。
    model: String(winModel || ''),
    pending: winPending
      ? { tool: String(winPending.tool || ''), file: String(winPending.file || ''), cmd: String(winPending.cmd || ''), at: Number(winPending.at) || 0 }
      : null,
  };
}

/** 状态文件名里"这个工程"那一段：`@<工程绝对路径>` 整体 sanitize。 */
function stateFileWs(ws) {
  return `@${path.resolve(ws)}`.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * 会话过滤（轴 2）：这条状态文件是不是 `session` 那条会话写的。
 *
 * `session` 为空 → **不限**（保持老行为：同 client 里取最新那份）。
 * 指定了会话时，老状态文件（没有 sessionId 字段）一律不算 —— 它们属于"还没有会话概念"的时代，
 * 硬算给某条会话会让"看 A 会话"读到 B 会话的数据。
 */
function sameSession(j, session) {
  return !session || String((j && j.sessionId) || '') === String(session);
}

/** 进程还在不在（信号 0 = 只探测不投递）。权限不足也算"在"。 */
function pidAlive(pid) {
  const n = Number(pid);
  if (!n || n < 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但不归我们管；ESRCH = 真没了
    return Boolean(e && e.code === 'EPERM');
  }
}

/**
 * 这个成员**还有没有别的会话在跑**（轴 2）。
 *
 * 为什么需要它：`agent_status` 是**按成员一行**存的（`member_id` 是主键），没有会话维度。
 * 同一个 Claude Code 同时开着 A / B 两条会话时，A 收工（Stop → idle）或退出（SessionEnd → offline）
 * 都会去写那**唯一一行**，于是 B 还在干活、工位卡片已经显示「空闲 / 离线」。
 * 所以降级之前先问一句"这条成员的别的会话还活着吗"，活着就别降。
 *
 * 「活着」的判据（任一）：
 *   - 那份状态文件的**心跳守护进程还在**（`hb.pid` 存活）—— 主判据：会话没退，守护就没退；
 *   - 或者它还有**在飞的相位 / 任务**（`sessionPhase` 或 `taskId` 是新鲜的）——
 *     覆盖"守护没起来 / 刚被杀"的情况。注意 SessionEnd 会把这两样清空，所以干净退出的
 *     会话不会被这条误判成活着。
 *
 * **不能用 `hb.lastEventAt` 当判据**：会话干净退出后它照样是新的（它记的是"最后一次事件"，
 * 不是"最后一次心跳"），拿它判会把已结束的会话当成还在跑 —— 实测的症状是：A 退会话后
 * B 也退了，工位卡片还挂在「思考中」，永远降不下来。
 *
 * 只认**同一个 client + 同一个工程**下、**会话 id 不同**的状态文件；老命名文件（没有会话）
 * 不算"别的会话"（它压根没有会话维度，认了会把单会话场景也拦下来）。
 * @param {{workspacePath?: string, client?: string, session?: string, now?: number}} o
 * @returns {boolean}
 */
function hasOtherLiveSession({ workspacePath = '', client = '', session = '', now = Date.now() } = {}) {
  const ws = String(workspacePath || '').trim();
  // 没有会话标识就无从谈起"别的会话"（老 hook / 别的产品）→ 一律不拦
  if (!ws || !session) return false;
  const m = stateFileWs(ws);
  const dir = path.join(reporterHookHome(), 'hooks');
  for (const name of readDir(dir)) {
    const fileSession = stateFileSession(name, m, dir);
    if (fileSession === null || !fileSession || fileSession === session) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!clientHit(client, j.client)) continue;
    // 判据 1：心跳守护还活着（最可靠）
    if (j.hb && pidAlive(j.hb.pid)) return true;
    // 判据 2：还有在飞的相位 / 任务（见函数说明，**不能**用 hb.lastEventAt）
    const phaseTs = Number(j.sessionPhase && j.sessionPhase.ts) || 0;
    if (j.sessionPhase && phaseTs && now - phaseTs <= AWAIT_TTL_MS) return true;
    const startedAt = Number(j.taskStartedAt) || 0;
    if (j.taskId && startedAt && now - startedAt <= AWAIT_TTL_MS) return true;
  }
  return false;
}

/** 会话 id 的规范形状：UUID（Claude Code 实测就是这个）。 */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 状态文件的文件名 → 它属于哪个会话（`''` = 老命名，没带会话）。
 * 不认识这个名字（不是这个工程的状态文件 / 根本不是状态文件）→ 返回 `null`。
 *
 * 命名由 hook 的 statePath() 决定：`<agent>@<工程绝对路径>[@<会话>]` 整体 sanitize 成 `[A-Za-z0-9._-]`。
 * **加了会话之后文件名尾巴多一段 `_<会话>`**，所以老的 `endsWith('@<工程>.json')` 会全部匹配不上 ——
 * 两处调用（hasReporterState / reporterStateMeta）都走这里，别退回去用 endsWith。
 *
 * **这个编码是有损的**（`_` 既是分隔符又是合法字符），所以单看文件名分不清
 * "工程 `/a/b` + 会话 `sub`" 和 "工程 `/a/b/sub` + 没有会话"——后者是老命名的文件，
 * 会被前者误认成自己的会话。所以尾巴分两步认：
 *   1. 是 UUID → 直接认（Claude Code 的规范形状，绝大多数情况走这条，不读文件）；
 *   2. 不是 UUID → 回读文件内容，**内容里的 `sessionId` 才是权威**（它是 hook 原样写进去的，
 *      没过 sanitize）。内容对不上就不认 —— 于是上面那个 `/a/b/sub` 的老文件会被正确排除。
 * @param {string} name 文件名
 * @param {string} wsPart stateFileWs() 的结果
 * @param {string} dir hooks 目录（第 2 步回读内容用）
 * @returns {string|null} 会话 id（可为 ''）
 */
function stateFileSession(name, wsPart, dir) {
  if (!/\.json$/i.test(name)) return null;
  const base = name.slice(0, -5);
  if (base.endsWith(wsPart)) return '';
  const i = base.lastIndexOf(wsPart);
  if (i < 0) return null;
  const tail = base.slice(i + wsPart.length);
  // 会话尾巴只能是一段 `_<id>`（id 里不含 `_`：UUID 没有，sanitize 也把它会变成 `_`）
  if (!/^_[A-Za-z0-9.-]+$/.test(tail)) return null;
  const cand = tail.slice(1);
  if (SESSION_UUID_RE.test(cand)) return cand;
  const j = readJson(path.join(dir, name));
  return j && String(j.sessionId || '') === cand ? cand : null;
}

/**
 * 这个工程有没有接过 hook（= 有没有对应的 hook 状态文件）。
 *
 * 和"有没有新鲜相位"是两回事：会话结束后 hook 会把 sessionPhase 清空（正确行为），
 * 但此时 CLI 楼层不该退回"按 jsonl mtime 猜"的兜底（那会让 3F 一直显示「调用工具 / 改 xxx.jsonl」），
 * 而应该显示「待命」。渲染层靠这个字段区分"没接 hook"与"接了但当前没事干"。
 *
 * 状态文件名由 hook 的 statePath() 生成：`<member>@<工程绝对路径>[@<会话>]`，非 [A-Za-z0-9._-] 换成 `_`。
 * @param {string} workspacePath
 * @param {string} [client] 来源客户端；空则不限
 */
function hasReporterState(workspacePath, client = '') {
  const ws = String(workspacePath || '').trim();
  if (!ws) return false;
  const m = stateFileWs(ws);
  const dir = path.join(reporterHookHome(), 'hooks');
  for (const name of readDir(dir)) {
    // 注意判 null 而不是判 falsy：老命名文件（不带会话）返回的是空串，那也是**本工程的**状态文件
    if (stateFileSession(name, m, dir) === null) continue;
    if (!client) return true;
    const j = readJson(path.join(dir, name));
    // 老文件没记 client → 按 codebuddy 归属（同上）
    if (clientHit(client, j && j.client)) return true;
  }
  return false;
}

/**
 * 这个工程有没有接过 hook，以及那份状态文件属于**哪条会话**。
 *
 * 为什么要会话 id：hook 是会话级加载的（会话启动时装，之后改配置不影响它），
 * 所以"工程里有状态文件"不等于"你正在看的这条会话在上报"——
 * 实测：13:40 开的旧会话没有 hook，但同工程里跑过 `codex exec`，状态文件存在，
 * 界面就会把这条会话显示成「待命」，看起来像"整轮对话没有状态变化"。
 * @returns {{instrumented: boolean, sessionId: string}}
 */
function reporterStateMeta(workspacePath, client = '', session = '') {
  const ws = String(workspacePath || '').trim();
  if (!ws) return { instrumented: false, sessionId: '' };
  const m = stateFileWs(ws);
  const dir = path.join(reporterHookHome(), 'hooks');
  let best = null;
  let bestTs = -1;
  for (const name of readDir(dir)) {
    const fileSession = stateFileSession(name, m, dir);
    if (fileSession === null) continue;
    // 指定了会话就只认那一条：文件名里的会话是 hook 写的，最可信；
    // 老命名文件（没带会话）在指定会话时一律不算 —— 否则"看会话 B"会借到会话 A 的老文件。
    if (session && fileSession !== session) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    // 老状态文件没记 client → 按 codebuddy 归属（与相位读取同一口径）
    if (!clientHit(client, j.client)) continue;
    const ts = (j.sessionPhase && j.sessionPhase.ts) || j.taskStartedAt || (j.hb && j.hb.lastEventAt) || 0;
    if (ts >= bestTs) {
      bestTs = ts;
      best = j;
    }
  }
  if (!best) return { instrumented: false, sessionId: '' };
  return { instrumented: true, sessionId: String(best.sessionId || '') };
}

function reporterMainPhase(workspacePath, client = '', session = '') {
  const rp = readReporterPhase(workspacePath, client, session);
  if (!rp) return null;
  // 下面每个分支都是**各建各的对象**，不是展开 rp —— 要往外带什么字段，每个分支都得加一遍，
  // 漏了就会静默丢掉（model 就这么丢过一次）。
  if (rp.phase === 'await') {
    return {
      phase: 'await',
      action: rp.tool ? `申请执行 ${rp.tool}` : '等待用户授权',
      target: rp.file || '',
      context: ['等待用户授权后继续', rp.tool && `工具：${rp.tool}`, rp.file && `目标：${rp.file}`].filter(Boolean),
      prompt: rp.prompt || '',
      model: rp.model || '',
    };
  }
  // 等授权兜底：本环境实测 CodeBuddy 不发 permission_prompt 通知（events.log 无 Notification 行），
  // 所以靠 hook 留下的 pending 推断——PreToolUse 写了 pending + sessionPhase=tool，
  // 若超过 AWAIT_PROBE_MS 仍无 PostToolUse 来清掉，说明工具被权限框卡住了。
  // 只读 / 命令类工具（NEVER_AWAIT_TOOLS）本就不发 PostToolUse、也不该弹权限框，排除掉避免误报
  // （典型误报：读文件却显示「等待授权」、点了 run 还在「等待授权」）。
  if (
    clientBase(rp.client) !== 'codex' && // Codex 用显式 PermissionRequest，跳过这套推断（codex / codex-plugin 都算）
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
      model: rp.model || '',
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
      model: rp.model || '',
    };
  }
  // thinking：干净，不堆示意字；但把用户那句话（prompt）一并带出，屏幕第三层顶到最前显示
  return { phase: 'thinking', action: '', target: '', context: [], prompt: rp.prompt || '', model: rp.model || '' };
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
 * @param {string} [client] 来源客户端；空则不限客户端
 * @returns {boolean}
 */
function readReporterActiveTask(workspacePath, client = '', session = '') {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j || !j.taskId) continue;
    if (!sameSession(j, session)) continue;
    // 按客户端过滤（口径同 readReporterPhase：老状态文件没记 client → 归 codebuddy）：
    // 同一工程里别的产品在跑时，别把它的任务算成本层"还在干活"的活跃窗口
    if (!clientHit(client, j.client)) continue;
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

/**
 * reporter hook 在 Stop 时落的"完成"标记（带工程路径），按**工程 + 客户端**一次扫盘取回。
 * 返回 { latest, bySession }：latest = 该 (工程, 客户端) 里最新的一份；bySession = 会话 id -> 该会话最新的一份。
 *
 * 为什么拆成"一次读盘"和"按会话取"两步：会话表扫盘一次能扫出上百个历史会话文件，
 * 若每扫到一条就去调一次 readReporterDone，hooks 目录就要被扫上百遍
 * （消费方见 sessionRegistry 里按 (工程, 客户端) 缓存的 doneScans）。
 */
function readReporterDones(workspacePath, client = '') {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  /** sessionId -> 该会话最新的一份 */
  const bySession = new Map();
  /** 该工程 + 客户端里最新的一份（会话 id 拿不到的楼层用它兜底） */
  let latest = null;
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j || !j.done || !j.done.at) continue;
    if (now - Number(j.done.at) > DONE_TTL_MS) continue; // 过期的不算"刚发生"（见 DONE_TTL_MS）
    const ws = j.done.workspacePath || '';
    if (workspacePath && ws && path.resolve(ws) !== path.resolve(workspacePath)) continue;
    // 同一工程里 Codex 与 CodeBuddy 各有一份状态文件：按客户端取，别把对方的"完成"搬过来
    if (!clientHit(client, j.client)) continue;
    const done = j.done;
    const id = String(j.sessionId || '');
    const prev = id ? bySession.get(id) : null;
    if (id && (!prev || Number(done.at) > Number(prev.at))) bySession.set(id, done);
    if (!latest || Number(done.at) > Number(latest.at)) latest = done;
  }
  return { latest, bySession };
}

/** "任务完成"的唯一真源：取**某条会话**的完成标记（不靠相位回落到空闲来猜，避免中途误弹）。
 *  同一个 (工程, 客户端) 下可能有多条会话，各取各的；会话 id 拿不到的楼层（Codex 的
 *  rollout 文件名不含 session_id）退回"该 client 最新的一份"——不猜，只是放宽到这一步。 */
function readReporterDone(workspacePath, client = '', session = '') {
  const { latest, bySession } = readReporterDones(workspacePath, client);
  if (!session) return latest;
  return bySession.get(String(session)) || null;
}

/**
 * hook 上报的会话清单 —— 给"只认 hook"的楼层当会话来源（见 products.js 的 hookSource）。
 *
 * TraeCode IDE 没有可扫的会话落盘（`~/.trae-cn/memory/*.jsonl` 是它自己的记忆文件，
 * 不是对话会话，拿来当会话就是编造），所以它的会话表直接由 reporter 状态文件构成：
 * sessionId 就是 hook payload 的 `session_id`，工程路径取相位 / 任务里记的 workspacePath ——
 * 两个都是实测值，不猜。老命名文件（没有 sessionId）没有会话维度，不算。
 * @param {string} client 客户端身份（**这一路来源**的 client，如 trae / codebuddy）；空则不限
 * @returns {Array<{sessionId: string, workspacePath: string, lastEventAt: number}>}
 */
function listReporterSessions(client = '') {
  const dir = path.join(reporterHookHome(), 'hooks');
  const byId = new Map();
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!clientHit(client, j.client)) continue;
    const sessionId = String(j.sessionId || '').trim();
    if (!sessionId) continue;
    const sp = j.sessionPhase || {};
    const lastEventAt = Math.max(
      Number(j.hb && j.hb.lastEventAt) || 0,
      Number(sp.ts) || 0,
      Number(j.taskStartedAt) || 0
    );
    if (!lastEventAt) continue;
    const prev = byId.get(sessionId);
    // 同一会话可能有多份状态文件（换过工程 / 老命名残留）：取最新那份的工程
    if (!prev || lastEventAt > prev.lastEventAt) {
      byId.set(sessionId, {
        sessionId,
        workspacePath: String(sp.workspacePath || j.taskWorkspacePath || ''),
        lastEventAt,
      });
    }
  }
  return [...byId.values()];
}

/**
 * 当前"真正在敲"的工程：取 reporter hook 最近一次写相位 / task 的工程路径。
 * reporter 把相位打在 REAL_WS（它实际运行的工程），而不是 office 手工"打开工程"记的那个，
 * 所以这里用最新活动判定，避免 IDE 里直接开新工程时相位错归到旧工程（主控制台对不上下拉）。
 * 超过新鲜期（AWAIT_TTL_MS）视为失效，回落到传入的 fallback（通常是 office 当前打开的工程）。
 * @param {string} fallback 回落值
 * @returns {string}
 */
function freshestReporterWs(fallback, client = '', session = '') {
  const dir = path.join(reporterHookHome(), 'hooks');
  const now = Date.now();
  let best = '';
  let bestTs = 0;
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!sameSession(j, session)) continue;
    if (!clientHit(client, j.client)) continue;
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
function sessionInfo(storage, id, { current = false, now = Date.now(), workspacePath = '', inWindow = false, client = '' } = {}) {
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
  // 还在列表里（宽窗口，60 分钟）；active 仍是"热窗口"，只影响相位推断
  const listed = Boolean(lastUpdated && now - lastUpdated < LISTED_MS);
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
    const rp = reporterMainPhase(workspacePath, client);
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

  // 完成标记：reporter 仅在 Stop 时落盘（按工程 + 客户端区分），是"任务完成"的唯一真源；
  // 比"相位回落到空闲"可靠——任务中途因轮询间隙 / 跨工程串味出现空闲，绝不冒充完成。
  const done = readReporterDone(workspacePath, client) || null;
  const doneAt = done ? done.at : 0;
  const doneTitle = done ? done.title || '' : '';
  // 只挑"本轮任务开始之后"改过的文件：file-changes 是整个会话累积的，
  // 不筛会把上一轮（甚至更早）的改动当成"本次完成"——典型：这一轮只是 push，却显示上一轮改了多少文件。
  // done.startedAt 缺省（老数据）时不过滤，退回原来的"取最近几个"。
  const doneStartedAt = done ? Number(done.startedAt) || 0 : 0;
  const doneAll = done
    ? (Array.isArray(files.recent) ? files.recent.filter((f) => !doneStartedAt || Number(f.at) >= doneStartedAt) : [])
    : [];

  return {
    id,
    current,
    active,
    listed,
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
    doneCount: doneAll.length, // 本轮任务改动的文件数（在切片之前算）
    doneFiles: doneAll.slice(0, 6),
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
 * @param {{workspacePath?: string, force?: boolean, client?: string, pluginRe?: RegExp[]}} o
 * @returns {{ok: true, sessions: Array, current: string, workspacePath: string,
 *            storage: string, reason?: string}}
 *   reason: 'no-storage' 没找到插件落盘 / 'no-open-project' 一个活跃会话都没有
 */
function listSessions({ workspacePath = '', force = false, client = '', pluginRe = PLUGIN_RE } = {}) {
  // 会话归属用的"当前工程"跟随 reporter 真实活动的最新工程，
  // 而不是 office 手工"打开工程"记的那个（IDE 里直接开新工程时两者会脱节）。
  // 只认传入的 client 这一路：这份清单属于某个插件楼层，别层（其它产品 / 同一产品的 CLI）
  // 在别的工程里活动不该决定这一层的"当前工程" —— 否则 mine / current / fresh 全被带偏。
  const ws = freshestReporterWs(workspacePath, client);
  const now = Date.now();
  // 缓存键含 client：不同插件楼层（codebuddy-plugin / trae-plugin …）即使同一工程也各算各的
  const key = `${client}@@${ws}`;
  if (!force && cache.value && cache.key === key && now - cache.at < TTL) return cache.value;

  const storage = findPluginStorage(pluginRe);
  if (!storage) {
    cache = {
      at: now,
      key,
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
    const inWindow = readReporterActiveTask(m.projectPath, client);
    const info = sessionInfo(storage, id, {
      current: isProjectCurrent,
      now,
      workspacePath: m.projectPath,
      inWindow,
      client,
    });
    // 只按"还在窗口内"过滤（60 分钟），不再因为 10 分钟没动静就整条剔除 ——
    // 否则 IDE 里明明开着、只是十几分钟没敲字的会话会从这一层消失（与 CLI 那路口径不一致）。
    if (!info.listed) continue;
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

module.exports = {
  hasReporterState,
  reporterStateMeta,
  // 成员状态降级前的守卫：这条会话停了，同产品的别的会话还在跑吗（见函数说明）
  hasOtherLiveSession,
  readReporterDone,   // 完成标记（含 Codex 的收尾自述）：CLI 楼层靠它亮「任务完成」
  readReporterDones,  // 同上，但一次取回该 (工程, 客户端) 下所有会话的 —— 会话表扫盘用
  listReporterSessions, // 只认 hook 的楼层（6F TraeCode IDE）与合并楼层的 hook 那一路（1F CodeBuddy CLI）
  sessionModel,       // 这条会话在用什么模型（TraeCode 从 globalStorage 取，其余留空）
  listSessions,
  findPluginStorage,
  decodeDirName,
  reporterMainPhase,
  freshestReporterWs,
};
