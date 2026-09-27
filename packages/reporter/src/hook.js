#!/usr/bin/env node
'use strict';

/**
 * 各受监控产品的 hook 入口（CodeBuddy CLI+Plugin / WorkBuddy / Codex / Claude Code / TraeCode / Qoder）。
 *
 * 各家差异（同一份 hook 靠 `--agent` 注入的产品身份选口径）：
 *   · CodeBuddy / WorkBuddy / Trae：工具名 Write/Edit/MultiEdit/Task，事件 Notification / SubagentStop；
 *     没有显式的等授权事件，靠 pending 超时推断；子代理没有 per-call id，靠字段合成 key。
 *   · Codex：工具名 Bash/apply_patch，有 PermissionRequest / SubagentStart / Interrupt（无 Notification）；
 *     子代理事件带 agent_id（天然唯一键）；subagent 用 collaborationspawn_agent。
 *   · Claude Code（2.1 实测）：工具名与 CodeBuddy 同名，但子代理工具叫 **Agent**（不是 Task）；
 *     有 PermissionRequest / SubagentStart（同样不注册，避免与 PreToolUse(Agent) 登记出两只幽灵）
 *     与 SubagentStop；PostToolUse **对所有工具都发**；notification_type 还多出
 *     auth_success / elicitation_dialog，不能一律当"等授权"。
 *     transcript 与 Codex 一样是 JSONL（~/.claude/projects/<cwd 斜杠换横线>/<session_id>.jsonl），
 *     所以 turnReplies 的 jsonlReplies 那一路直接复用。
 *
 * 由 scripts/install-hooks.js 写进各家的 settings.json，形如：
 *   { "hooks": { "SessionStart": [ { "matcher": "", "hooks": [
 *       { "type": "command", "command": "node /abs/packages/reporter/src/hook.js", "timeout": 10 } ] } ] } }
 *
 * 事件 → 上报（对齐 docs/requirements.md §5 的状态机）：
 *   SessionStart      register + idle（等派单）+ 拉起心跳守护
 *   UserPromptSubmit  task/start（标题 = 用户那句话的前 80 字）+ thinking（思考中，直到下一个事件）
 *   PreToolUse        busy（顺带心跳）；工具是 Task/Agent（召唤 subagent）→ 飘出一只小幽灵
 *   PostToolUse       写/改类工具 → file/touch，并 busy；工具是 Task/Agent → 幽灵转「待汇报」
 *   Notification      等权限 → blocked(reason=awaiting_permission)；空闲提醒 → idle
 *                     （Claude Code 还有 auth_success / elicitation_dialog 等非权限类型，不认、不动状态）
 *   PermissionRequest 等授权（Codex / Claude Code 的显式事件）→ blocked(reason=awaiting_permission)
 *   SubagentStop      只收幽灵（不碰主会话的任务 / 相位）
 *   Stop              task/end(done) + idle；顺手扫掉本轮残留的幽灵
 *   SessionEnd        offline + 撤掉心跳守护 + 扫掉本 hook 召唤的幽灵
 *
 * 三条纪律：
 *   1) 服务没起 / 拿不到上下文 / 上报失败 —— 一律静默退出 0，**绝不阻塞 agent**；
 *   2) stdout 可能被当作上下文塞回给 agent，**一个字都不往 stdout 写**（调试走 stderr + WORKGREMLIN_HOOK_DEBUG=1）；
 *   3) 心跳 60s 一断就 degraded（shared DEFAULTS.HEARTBEAT_TIMEOUT_MS），
 *      所以 SessionStart 会另起一个守护进程按 15s 心跳，免得 agent 一思考就灰。
 *
 * 环境变量：
 *   WORKGREMLIN_PROJECT        project 名（缺省用服务端"当前打开的工程"那个 project）
 *   --agent <name>          主 agent 名字（必填；codebuddy / codex / workbuddy / trae / claude …）
 *   WORKGREMLIN_ROLE        角色（缺省 agent）
 *   WORKGREMLIN_HOOK_DEBUG=1      把失败原因打到 stderr
 *   WORKGREMLIN_HOOK_MESSAGES=1   另外把每条用户指令当消息投进对话记录
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { readServerInfo, HTTP_ROUTES } = require('./index');
const { fnv1a32 } = require('@workgremlin/shared');
// 进程间互斥 + 原子写：CLI 会在同一毫秒并行触发多个 hook 进程，各写各的会互相覆盖
// （见 fslock.js 头部的实测记录）。writeState / updateState / updateFeedFile 都走这里。
const { updateJson } = require('@workgremlin/shared/fslock');

/**
 * 本 hook 服务哪个 CLI（安装器写进 hook 命令：Codex 那份是 --agent codex）。
 * 实测差异（Codex CLI 0.151.0）：
 *   · 工具名：Bash / apply_patch（tool_input 是 patch 文本）/ collaborationspawn_agent …
 *   · 事件：有 PermissionRequest、SubagentStart、Interrupt；没有 Notification
 *   · 每个工具事件都带真 tool_use_id；子代理事件带 agent_id / agent_type
 * 对照 CodeBuddy：工具名 Write/Edit/MultiEdit/Task，事件 Notification / SubagentStop。
 */
/** 本 hook 服务哪个产品（安装器通过 --agent 注入；必填，缺省直接报错退出）。
 *  这是**轴 1（产品家族）**：trae / codebuddy-plugin 都跑在 VS Code 协议上、运行时 payload 长得一样
 *  （都自报 client:'vscode'），光靠 payload 分不出，只能靠安装期身份。
 *  只有 codebuddy 这个家族还要靠 payload 的 client 再分 cli / plugin 两种身份，见 eventClient
 *  ——分出来的两种身份**同属 1F CodeBuddy 一层**（CLI 与 Plugin 合并，见 server/src/products.js），
 *  服务端按会话把这些上报区分开，不再拆成两个楼层。 */
let AGENT = '';
let IS_CODEX = false;
/** Claude Code（--agent claude）。与 CodeBuddy 的差别见 header 的"各家差异"一段 */
let IS_CLAUDE = false;

/**
 * **轴 2（会话）**：本次事件所属的会话 id，取自 payload 的 `session_id`。
 *
 * 同一个 CLI 可以同时开着好几条会话（两个终端 / 一个终端 + 一个 IDE 窗口），
 * 它们的产品身份（AGENT / client）**完全一样**，只有 session_id 不同 —— 所以会话
 * 只能靠它区分。实测 Claude Code 2.1.281：14/14 个事件都带 session_id，且与
 * `CLAUDE_CODE_SESSION_ID`、transcript 文件名（`~/.claude/projects/<工程>/<session_id>.jsonl`）
 * 三处 100% 一致；子代理转录共用父会话的 sessionId，另靠 agent_id 区分实例。
 *
 * 拿不到（老版本 payload / 手工脚本 / 其它产品没这个字段）时留空 → 状态文件名
 * 退回"只按 工位+工程"的旧形式，行为与改动前完全一致（向后兼容）。
 */
let SESSION = '';

/**
 * 本产品有没有**显式的等授权事件**。
 *
 * Codex 与 Claude Code 都会发 PermissionRequest（payload 带 tool_name / tool_input），
 * 所以"等授权"靠真事件点亮，不需要 CodeBuddy 那套「PreToolUse 打 pending、超时未清即猜」——
 * 那套只在"没有显式事件、又必须在弹权限框时给出一个相位"时才用得上。
 * 对这两家继续打 pending 反而会把"跑得久的写类工具"误判成"等待授权"。
 */
const hasPermissionEvent = () => IS_CODEX || IS_CLAUDE;

/** spawn_agent → SubagentStart 之间的"待认领"窗口 */
const PENDING_SPAWN_MS = 2 * 60_000;

/**
 * 本事件究竟来自哪个客户端（codebuddy / codebuddy-plugin / codex / codex-plugin / …）。
 *
 * 这是**来源身份的合同映射**，不是运行时猜测：Plugin 与 CLI 共用同一份
 * ~/.codebuddy/settings.json、跑同一条 hook 命令，所以只能靠 payload 里
 * 稳定携带的 `client` 字段来区分二者，再归一化到服务端约定的来源身份。
 *
 * 约定（全产品通用，codex / trae 同样适用）：
 *   - 非 plugin（CLI / 独立可执行）：直接返回 **agent 本身**（codebuddy / codex / trae / workbuddy）。
 *   - plugin（VS Code 系扩展，payload 自报 `client: 'vscode'`）：返回 **agent + '-plugin'**
 *     （codebuddy-plugin / codex-plugin / trae-plugin）。
 *
 * 这样每个产品既能分清 CLI 与 plugin 两种上报身份（CodeBuddy 的 CLI / Plugin 都在 1F，
 * 靠这一位区分它们各自的相位与完成标记），又能让只有一个楼层的产品（codex）把两种变体
 * 都归到那一层。
 *
 * @param {any} ev hook 事件
 * @returns {string}
 */
function eventClient(ev) {
  const ec = ev && ev.client ? String(ev.client).trim().toLowerCase() : '';
  // Plugin 自报的 'vscode'（及历史 'codebuddy'）一律加 '-plugin' 后缀归到 plugin 身份；
  // 其余（含空，即 CLI）按 agent 本身返回。
  if (ec && ec !== AGENT.toLowerCase() && ec !== 'cli') return AGENT + "-plugin";
  return AGENT;
}

/** 本 reporter 进程真实运行所在的工程（cwd 解析成绝对路径）。
 * 相位 / task 都打这个路径，服务端据此把"当前工程"归到你真正在敲的工程，
 * 而不是 office 里手工"打开工程"记的那个（IDE 里直接开新工程时两者会脱节）。 */
const REAL_WS = path.resolve(process.cwd());
/** shared 里没有登记这条（服务端在 server/src/http/routes/workspace.js） */
const WORKSPACE_ROUTE = '/api/v1/workspace';
const REQ_TIMEOUT_MS = 2_000;
const STDIN_TIMEOUT_MS = 1_500;
const HB_INTERVAL_MS = 15_000;
/** 这么久没有任何 hook 事件 -> 会话大概率没了，守护自己退（不留孤儿） */
const HB_IDLE_EXIT_MS = 30 * 60_000;
/** 兜底：再怎么样 6 小时也退 */
const HB_MAX_LIFE_MS = 6 * 60 * 60_000;
const TITLE_MAX = 80;
/** 台账"产出"全文上限（服务端另有上限，见 server/src/ingest/bus.js 的 RUN_RESULT_MAX） */
const RESULT_MAX = 4_000;
/** 单条 AI 回复进对话记录的长度上限 */
const MSG_MAX = 8_000;
/** 一轮最多上报几条 AI 回复（并发上报，所以这里只是防刷的闸门，不是延迟闸门） */
const MAX_REPLIES = 50;

const DEBUG = process.env.WORKGREMLIN_HOOK_DEBUG === '1';
const debug = (...args) => {
  if (DEBUG) console.error('[workgremlin-hook]', ...args);
};

function home() {
  return process.env.WORKGREMLIN_HOME || path.join(os.homedir(), '.workgremlin');
}

/** 追加式事件时间线（诊断用）：每次 hook 事件写一行到 ~/.workgremlin/hooks/events.log。
 *  含事件名 / 工具 / notification_type / 工位，方便排查"等授权没收到""相位跳变"等问题。 */
function trace(event, extra) {
  try {
    const line = `${new Date().toISOString()} ${event}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
    fs.appendFileSync(path.join(home(), 'hooks', 'events.log'), line);
  } catch {
    /* 落盘失败不影响 hook */
  }
}

/**
 * 每个「工位 + 工程 + 会话」一份：当前任务 id + 相位 + 完成标记 + 心跳守护的 pid。
 *
 * 文件名带**两级**归属：
 *   1) 工程（REAL_WS）—— 多个工程同时开着（同一 agent 名）时各自写自己的文件，
 *      互不覆盖相位 / 任务 / 心跳，避免旧会话乱跳"思考中"、"任务完成"被别的工程串味；
 *   2) 会话（session）—— 同一个工程里同一个 agent 开着两条会话（两个终端、或终端 + IDE）
 *      时，**产品身份完全一样**，只有会话不同。少了这一级，两条会话会往同一个文件里
 *      写相位 / taskId / roundFiles / done，症状是：切到 A 却显示 B 的相位、
 *      A 开始新一轮把 B 攒的改动文件清单清空、A 按 Stop 却关掉 B 的任务。
 *
 * 会话为空（拿不到 session_id）时不拼这一段，文件名与"只按 工位+工程"的旧形式一致。
 */
function statePath(agent, session = SESSION) {
  const parts = [String(agent), REAL_WS];
  if (session) parts.push(String(session));
  const key = parts.join('@').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(home(), 'hooks', `${key}.json`);
}

/** 状态文件保留时长：超过就从 hooks/ 里清掉。 */
const STATE_KEEP_MS = 7 * 24 * 60 * 60_000;

/**
 * 清掉过期状态文件。
 *
 * 为什么现在必须要这一步：状态文件名从「工位+工程」变成「工位+工程+会话」之后，
 * 文件数从"每人一份"变成"每条会话一份"，只增不减。而服务端读相位是**每 1.5s
 * 扫一遍整个 hooks/ 目录**（见 server/src/sessions.js 的 readReporterState）——
 * 攒到几千份就是每 1.5s 几千次读文件，主控制台会被拖垮。
 *
 * 按 **mtime** 判过期，不按文件名：正在跑的会话刚写过文件，mtime 是新的，绝不会被误删。
 * 只在 SessionStart 跑（每条会话一次，频率极低），失败不影响 hook。
 */
function pruneStateFiles(maxAgeMs = STATE_KEEP_MS) {
  const dir = path.join(home(), 'hooks');
  const now = Date.now();
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue; // 别碰 events.log
      const p = path.join(dir, name);
      try {
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
          fs.unlinkSync(p);
          removed += 1;
        }
      } catch {
        /* 读不到 / 删不掉就跳过 */
      }
    }
  } catch {
    /* 目录不存在等 —— 都不是错误 */
  }
  if (removed) trace('state-prune', { removed });
  return removed;
}

function readState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeState(file, patch) {
  try {
    // 加锁 + 原子写：同一毫秒并行的多个 hook 进程各读一份旧状态，后写的会把先写的冲掉
    // （2026-09-27 实测：taskId / roundFiles / done 就是这么被削掉的）。锁里读改写，
    // 原子 rename 保证读者永远看不到半截 JSON（半截会让 readState 退回 {} → 整份状态写没）。
    return updateJson(
      file,
      (cur) => ({ ...(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}), ...patch }),
      { fallback: {}, pretty: false } // 状态文件保持原来的紧凑单行格式
    );
  } catch (err) {
    debug('写状态失败：', err && err.message);
    return readState(file);
  }
}

/**
 * 加锁的状态读-改-写：mutate 收到当前状态，返回新状态写回。
 * writeState 只保证"单次 patch 不丢"（加锁 + 原子写）；像 rememberSubagent /
 * rememberRoundFiles 这种"读账本 → 追加 → 写回"的**复合**更新必须整段在锁里 ——
 * 只把最后那一次 writeState 加锁是没用的：两个进程仍会读到同一份旧账本、各推各的。
 */
function updateState(file, mutate) {
  try {
    return updateJson(
      file,
      (cur) => mutate(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}),
      { fallback: {}, pretty: false }
    );
  } catch (err) {
    debug('写状态失败：', err && err.message);
    return readState(file);
  }
}

function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !String(argv[i + 1]).startsWith('--') ? String(argv[i + 1]) : '';
}

/** 读 stdin（hook 的输入 JSON）。hook runner 不关 stdin 时到点就走，绝不干等。 */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/**
 * @param {{port: number, token?: string}} info
 * @param {string} route
 * @param {object|null} body null 表示 GET
 */
async function request(info, route, body) {
  const init = {
    method: body ? 'POST' : 'GET',
    headers: info.token ? { authorization: `Bearer ${info.token}` } : {},
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  };
  if (body) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}${route}`, init);
    if (!res.ok) {
      debug(route, '->', res.status);
      return null;
    }
    return await res.json().catch(() => null);
  } catch (err) {
    debug(route, '失败：', err && err.message);
    return null;
  }
}

/**
 * 上报到哪个工程：环境变量 > 服务端"当前打开的工程"（唯一的正常来源）。
 * 服务端不可达时才留空 —— 留空什么都不会归属错，宁可不上报也不写进别的工程。
 * 顺带把 workspacePath 也带回来 —— register 会 upsert 工程，
 * 用服务端现有的值回写，才不会把"打开工程"记的工程目录改掉。
 * @param {{port: number, token?: string}} info
 */
async function resolveCtx(info) {
  const fallback = { project: '', workspacePath: '' };
  const cur = await request(info, WORKSPACE_ROUTE, null);
  const project = String(process.env.WORKGREMLIN_PROJECT || '').trim() || (cur && cur.project) || fallback.project;
  return { project, workspacePath: (cur && cur.workspacePath) || fallback.workspacePath };
}

/**
 * Codex 的 apply_patch：tool_input 只有 { command: "*** Begin Patch
*** Update File: <路径>
…" }，
 * **没有 file_path**（实测）—— 路径只能从 patch 文本里解析。
 */
function patchPaths(text) {
  const out = [];
  const src = String(text || '');
  const re = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  let m = re.exec(src);
  while (m) {
    const f = m[1].trim();
    if (f && !out.includes(f)) out.push(f);
    m = re.exec(src);
  }
  return out;
}

/** 工具输入里的目标文件（CodeBuddy: file_path/filePath；Codex: apply_patch 的 patch 文本） @returns {string[]} */
function filesOf(input, tool) {
  if (!input || typeof input !== 'object') return [];
  const p = input.file_path || input.filePath || input.path || input.notebook_path || input.target_file || '';
  if (typeof p === 'string' && p) return [p];
  if (String(tool || '') === 'apply_patch' && typeof input.command === 'string') return patchPaths(input.command);
  return [];
}

/** 单个路径（相位与日志展示用，取第一个） */
function fileOf(input, tool) {
  return filesOf(input, tool)[0] || '';
}

/** 编辑类算 edit，删除类算 delete，其余写类算 write（server 侧按 op 分 新增/改动/删除） */
function opOf(tool) {
  const t = String(tool || '');
  if (t === 'apply_patch') return 'edit'; // Codex
  if (/delete/i.test(t)) return 'delete'; // 删除类工具
  return /^(Edit|MultiEdit|NotebookEdit|replace_in_file)$/.test(t) ? 'edit' : 'write';
}

/**
 * 从 TodoWrite 类工具的入参里抽"任务进度"（已完成 / 总量）。
 * 这是任务进行中能拿到的**真实**完成比例信号：agent 用待办清单组织任务时，
 * 每改写一次清单就反映"做了几个"，hook 据此调 /task/progress，任务记录的进度
 * 才不是只有 0% 和 100%。抽不到（非待办工具 / 没有可解析的清单）返回 null。
 * 兼容各家 schema：todos / todo_list / todoList / items；status 认 completed/done
 * 算 1、in_progress 算 0.5（正在做那一个算半步），其余算 0。
 */
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

/**
 * 只有这些"写类"工具才打 pending 标记（用于"等授权"兜底推断）。
 * 依据：本环境 events.log 实测 Read/Grep/Glob/ReadLints/Bash 等只读 / 命令类工具
 * **根本不发 PostToolUse**，一旦给它们打 pending，PostToolUse 永远不来、清不掉，
 * 兜底就会把"读文件 / 点了 run 正在跑"误判成"等待授权"。
 * 写类工具（Edit/Write/Delete 家族）既可能弹权限框、又会发 PostToolUse，
 * 所以只有它们适合用"PreToolUse 打 pending、PostToolUse 清掉、超时未清即等授权"这套逻辑。
 */
const PROBE_TOOLS = new Set([
  'Edit', 'MultiEdit', 'NotebookEdit', 'Write', 'Delete', // CodeBuddy 写类
  'replace_in_file', 'write_to_file', 'delete_file', // 本助手写类
  'apply_patch', // Codex 的写类工具（tool_input 是 patch 文本，会弹权限框，也会发 PostToolUse）
]);

/** 工程内的文件记相对路径，工程外的记绝对路径（不猜、不编造） */
function relFile(file, cwd) {
  if (!file) return '';
  const abs = path.resolve(file);
  if (cwd && (abs === cwd || abs.startsWith(cwd + path.sep))) return path.relative(cwd, abs);
  return abs;
}

/** 内容块里算"回复正文"的类型：reasoning / tool-call 之类不算
 * （CodeBuddy 会把思维链也塞进 content，整段并进来会把一条回复撑成上万字）。 */
const TEXT_BLOCK_TYPES = new Set(['text', 'output_text', 'input_text', 'summary_text']);

/** 从内容块里抽人类可读文本（兼容 string / [{type:'text'|'output_text',text}] / {text}） */
function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((x) => {
        if (!x || typeof x !== 'object' || typeof x.text !== 'string') return '';
        const t = x.type == null ? '' : String(x.type);
        return !t || TEXT_BLOCK_TYPES.has(t) ? x.text : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text.trim();
  return '';
}

/**
 * 一条 transcript 记录里的"消息体"。各家封装不同，这里统一成 {role, content, id}：
 *   · Codex rollout：{type:'response_item', payload:{type:'message', role, content:[{type:'output_text',text}]}}
 *     —— role 在 **payload** 里，不在 message 里（实测 2026-09-22，Codex 0.151.0）；
 *   · 通用 / Claude Code / CodeBuddy CLI：{message:{role, content:[{type:'text',text}]}}
 *   · 顶层本身就是消息：{role, content}
 * @param {any} obj
 * @returns {{role: string, content: any, id: string}|null}
 */
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

/** 本轮 = 最后一条 user 消息之后的 assistant 消息。一条 user 都没有时全算（宁可多报，服务端按 id 去重）。 */
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
      continue; // 半截行 / 非 JSON 行：跳过，不猜
    }
    const m = msgOf(obj);
    if (!m) continue;
    const ts = Date.parse(String((obj && obj.timestamp) || '')) || 0;
    items.push({ role: String(m.role), id: m.id, text: extractText(m.content), ts });
  }
  return sinceLastUser(items);
}

/**
 * CodeBuddy 的会话正文**不在**索引文件里：索引是 history/<sessionId>/index.json
 * （缩进过的多行 JSON，不是 JSONL，按行解析必然全失败），正文在同目录 messages/<消息 id>.json
 * （{role, message:"<JSON 字符串>"}）。一轮回复在索引里被切成若干 assistant 分片（实测），
 * 所以按"最后一个请求 requests[-1]"把分片拼成一条，去重键用请求 id。
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
  return sinceLastUser(
    msgs.map((m) => ({
      role: String((m && m.role) || ''),
      id: String((m && m.id) || ''),
      text: m && m.id ? read(m.id) : '',
    }))
  );
}

/**
 * 本轮 AI 回复列表（可能多条）——"每次回复入库"与"产出摘要"共用这一个来源。
 * transcriptPath 指向 CodeBuddy 的 index.json 时走 CodeBuddy 那套，其余（Codex rollout /
 * Claude Code / CodeBuddy CLI 的 JSONL）逐行解析。
 * @param {string} transcriptPath
 * @returns {Array<{id: string, text: string}>}
 */
function turnReplies(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return [];
  return /index\.json$/i.test(transcriptPath) ? codebuddyReplies(transcriptPath) : jsonlReplies(transcriptPath);
}

/**
 * 一条回复的"身份"：优先用 transcript 里的消息 id（Codex 的 payload.id / CodeBuddy 的请求 id）；
 * 没有 id 就用**正文哈希**兜底。
 * 这里绝不能拿 taskId 兜底：Stop 上报时 state 里还是真实 taskId，而 SessionEnd / Interrupt 补报时
 * taskId 已经被清空（或已切到下一轮）—— 同一轮回复会算出两个不同的键，ON CONFLICT DO NOTHING
 * 拦不住，库里就出现两行一模一样的内容（实测复现过）。正文哈希跨 Stop/SessionEnd 都稳定。
 */
function replyKeyOf(reply) {
  const id = String((reply && reply.id) || '').trim();
  if (id) return id;
  return 'h' + fnv1a32(String((reply && reply.text) || ''));
}

/** 对话记录里每条 AI 回复的去重键：同一轮重复上报（Stop 之后又来 SessionEnd、重放）不会写重 */
function aiDedupeKey(client, sessionId, msgId) {
  return `ai:${client}:${String(sessionId || 'nosession')}:${String(msgId || 'noid')}`;
}

/**
 * 把本轮 AI 回复投进对话记录（messages 表）—— 这条线回答"每次回复都入库"，
 * 与 task_runs.result（一轮一条摘要）互不替代。
 * 一条都拿不到就什么都不做（绝不编造）；超长单条按 MSG_MAX 截断，别把一条消息撑爆。
 */
async function reportAiReplies(info, base, agent, taskId, replies, sessionId, client) {
  if (!Array.isArray(replies) || !replies.length) return;
  const list = replies.slice(-MAX_REPLIES);
  const now = Date.now();
  // 并发上报：一条一条 await 的话，服务端卡顿时耗时 = 条数 × REQ_TIMEOUT_MS（2s），
  // 20 条最坏 40s —— 而 hook 命令在 settings.json 里配了 10s 超时，会被 runner 掐掉，
  // 连 status('idle') 都发不出去（实测 5 条挂 2s 的服务就是 10069ms）。
  // 顺序**不靠发送次序**：每条都带显式 ts（transcript 里有真时间就用真的，没有就按回复次序
  // 单调铺开），消息表与前端都按 ts_ms 排序，所以并发不会把一轮的回复打乱。
  await Promise.all(
    list
      .map((r, i) => {
        const content = String(r.text || '').trim();
        if (!content) return null;
        const ts = Number(r.ts) > 0 ? Number(r.ts) : now - (list.length - 1 - i);
        return request(info, HTTP_ROUTES.MESSAGE, {
          ...base,
          memberId: agent,
          from: agent,
          to: null,
          // 收尾那条算产出，中间那几条算过程（都在 MESSAGE_TYPES 里，前端不用改）
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

/* ------------------------------------------------------------------ *
 * 主 Agent 召唤 subagent（Agent 工具）时，往 subagent 清单写一条，
 * 服务端 subagentFeed 盯着它 → 办公室飘出一只小幽灵（临时成员）。
 * 工具跑完（PostToolUse）就从清单里划掉，幽灵散掉。
 * 复用 server/src/ingest/subagentFeed.js 的 feedFilePath 规则：
 *   $WORKGREMLIN_SUBAGENTS_FILE > <workspacePath>/.workgremlin/subagents.json > <cwd>/.workgremlin/subagents.json
 * ------------------------------------------------------------------ */
function feedFileFor(workspacePath) {
  const env = String(process.env.WORKGREMLIN_SUBAGENTS_FILE || '').trim();
  if (env) return path.resolve(env);
  const ws = String(workspacePath || '').trim();
  return path.join(ws ? path.resolve(ws) : process.cwd(), '.workgremlin', 'subagents.json');
}

/**
 * 加锁的清单读-改-写：mutate 收到归一化后的 { project, agents }，返回新清单写回。
 * addGhost / retireGhost / sweepGhosts 都是"读 → 改 → 写"，必须整段在锁里 ——
 * 否则并发召唤时后写的会冲掉先写的（实测三条 ghost+ 只落两条）。
 * mutate 返回 undefined = 放弃这次更新（不写盘）。
 * @param {string} file
 * @param {(feed: {project: string, agents: any[]}) => any} mutate
 */
function updateFeedFile(file, mutate) {
  try {
    return updateJson(
      file,
      (raw) => {
        const agents = Array.isArray(raw) ? raw : Array.isArray(raw && raw.agents) ? raw.agents : [];
        const project = (!Array.isArray(raw) && raw && typeof raw.project === 'string' && raw.project) || '';
        return mutate({ project, agents });
      },
      { fallback: { project: '', agents: [] }, pretty: true }
    );
  } catch (err) {
    debug('写 subagent 清单失败：', err && err.message);
    return null;
  }
}

/**
 * 召唤 subagent 的工具名：CodeBuddy Plugin / CLI 用的是 **task**（小写，实测 PostToolUse
 * 里就是 `task`；老日志里的 `Task` 是同一支工具的另一种写法）；Claude Code 风格叫 agent。
 * 两个都认，且**忽略大小写** —— 大小写敏感时小写 `task` 匹配不上，收工那一步
 * （PostToolUse → finishGhost）永远不执行，幽灵只能等 Stop / SessionEnd 兜底扫掉，
 * 表现就是"子代理干完了、幽灵还飘着，直到下一次会话才开始"。
 */
const SUBAGENT_TOOLS = new Set(['task', 'agent']);
const isSubagentTool = (tool) => {
  const t = String(tool || '').trim().toLowerCase();
  // CodeBuddy / Claude 风格是 task / agent；Codex 是 collaborationspawn_agent（带命名空间前缀）
  return SUBAGENT_TOOLS.has(t) || t.endsWith('spawn_agent');
};

/**
 * subagent 的**名字**：subagent_type（Claude Code 风格）/ subagent_name（CodeBuddy 风格）/ name。
 *
 * 必须是 .codebuddy/agents/*.md 里那个名字（simmon / susan / leo…）——
 * 办公室就是按名字把幽灵挂到同名小怪物头上的（iso/engine 用 byName[m.name] 对号），
 * 取成 description 的话联动整条断掉：roster.isDefined(name) 为假 → 小怪物不会变忙，
 * 幽灵也飘不到它头顶、不会触发"跑去主控制台领任务"那套编排。
 * 都取不到才回退 'subagent'（这时不指望联动，但幽灵照样飘）。
 */
function agentName(input) {
  if (!input || typeof input !== 'object') return 'subagent';
  const n = input.subagent_type || input.subagent_name || input.task_name || input.name || input.agent || ''; // Codex 用 task_name
  return String(n).trim() || 'subagent';
}

/** 幽灵头顶那句"在干嘛"：description（那行人类可读短描述）优先，回退 prompt 前 80 字 */
function agentTask(input) {
  if (!input || typeof input !== 'object') return '';
  const d = input.description || input.prompt || input.message || ''; // Codex 的 spawn_agent 用 message
  return String(d).replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * 本次召唤的 **key 候选列表**（由强到弱），用来把"召唤"与"收工"配成一对。
 *
 *   1) 真 per-call id（tool_use_id / call_id …）—— Claude Code 风格有；
 *      **CodeBuddy Plugin没有**：读扩展源码（out/extension/index.js）实测，PreToolUse / PostToolUse
 *      的 payload 只有 session_id / transcript_path / cwd / tool_name / tool_input / tool_response /
 *      generation_id / model / agent_type / agent_id / client / version —— 一个 per-call id 都没有。
 *   2) 那就用**两端应当一致**的字段合成：PostToolUse 会原样带回 tool_input，所以
 *      session_id / 名字 / 任务 一定一样，agent_id / generation_id 大概率一样。
 *      为了不把成败押在"大概率"上，这里一次给三个候选（带 generation_id → 不带 → 只用名字+任务），
 *      收工时任一命中即可。
 *
 * 为什么非要这个 key：同一个 subagent_type 并发跑两次很常见（比如两只 susan 分头做两件事），
 * 只按名字记账的话，第一只收工会把还在跑的第二只一起划掉。
 * 一个可用字段都没有时返回空数组，调用方退回"按名字删一条"。
 * @param {any} ev hook 事件
 * @param {string} [name] subagent 名
 * @param {string} [task] 本次任务文案
 * @returns {string[]}
 */
/** Codex 的 SubagentStart / SubagentStop / 子代理自己的工具调用都带 agent_id —— 天然唯一键 */
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

/**
 * client 的"家族"：codebuddy 与 codebuddy-plugin 是**同一个产品**（1F 已把 CLI / 插件
 * 合并成单层），共用同一份 <workspace>/.workgremlin/subagents.json。
 * 实测（2026-09-27）：一只 05:01 召唤的幽灵条目 client 写的是 'codebuddy-plugin'，
 * 而当天下午 CLI 上报的身份变成 'codebuddy' —— 精确比对 client 时这只幽灵谁都收不掉，
 * 只能干等 GHOST_TTL_MS 过期。比较归属时按家族归一。
 */
function clientFamily(c) {
  return String(c || '').trim().toLowerCase().replace(/-plugin$/, '');
}

/**
 * 这条清单条目归不归本 hook 管。
 * Codex 与 CodeBuddy 写的是**同一个** <workspace>/.workgremlin/subagents.json，
 * 所以收工 / 扫场必须认来源，否则会把对方的幽灵一起收掉。
 * 写了 client 的按**家族**认（见 clientFamily）；没写的（老版本 hook / 手工脚本）
 * 算 CodeBuddy 的历史条目。
 */
function ownsEntry(a, client, session = '') {
  if (!a) return false;
  const fam = clientFamily(a.client);
  if (fam) {
    if (fam !== clientFamily(client)) return false;
  } else if (clientFamily(client) !== 'codebuddy') {
    return false;
  }
  // 会话这一级只在**两边都有**时才比：老条目 / 手工 `scripts/subagents.js` 写的条目
  // 根本没有 sessionId，不能因为缺字段就当"不是我的"（那会把手工幽灵变成本层谁都收不掉）。
  // 两条 claude 会话的 client 都是 'claude'，只有这一步能把它们分开。
  if (session) {
    const s = String(a.sessionId || '').trim();
    if (s && s !== session) return false;
  }
  return true;
}

/**
 * 主 Agent 召唤 subagent → 加一只小幽灵。
 * key 用**本次调用的 id**而不是名字：同一个 subagent_type 并发起两个 Task 是很常见的，
 * 按名字去重的话第二只根本登记不上，而第一只收工又会按名字把还在跑的那只一起划掉。
 */
/**
 * @param {string} workspacePath
 * @param {string} name subagent 类型（susan / code-explorer …）
 * @param {string} task 它这一单的任务
 * @param {string} id 本次召唤的 key
 * @param {string} parent 召唤它的那轮用户任务 id（主 agent 当前任务）—— 台账认父用
 * @param {string} model 召唤时的模型（拿不到就空，服务端留 NULL）
 */
function addGhost(workspacePath, name, task, id, parent, model, client, session = SESSION) {
  const file = feedFileFor(workspacePath);
  // 读改写整段在锁里：召唤是并发到达的（实测三条 PreToolUse(Agent) 只差 5~11ms），
  // 老写法"各自读 → push → 各自整体写回"会互相覆盖，三条只落两条。
  updateFeedFile(file, (feed) => {
    // 去重也要按会话：同一个 subagent 名 + 同一个 id 只会出现在一条会话里，
    // 但两条会话各自召唤同名 subagent 时，只按 name 去重会把第二只吞掉。
    const dup = id
      ? (a) => a.id === id
      : (a) => a.name === name && String(a.sessionId || '') === String(session || '');
    if (feed.agents.some(dup)) return undefined; // 已有 → 不写
    feed.agents.push({
      name,
      state: 'busy',
      ts: Date.now(),
      client, // 归属轴 1（产品）：同一个工程下 Codex / CLI / Plugin 共用一个清单文件，按 client 区分
      // 归属轴 2（会话）：同产品两条会话的 client 完全一样，只能靠 sessionId 分开。
      // 收工 / 扫场都用 ownsEntry 比它，否则 A 的 Stop 会把 B 还在跑的幽灵一起收掉。
      ...(session ? { sessionId: String(session) } : {}),
      ...(task ? { task } : {}),
      ...(id ? { id } : {}),
      ...(parent ? { parent } : {}),
      ...(model ? { model } : {}),
    });
    return feed;
  });
}

/**
 * subagent 收工 → 把这条改成**已收工待汇报**，不直接删。
 *
 * 为什么不是删：Task 工具的结束信号恰好落在"Task 返回"那一刻，而主 agent 拿到返回值
 * 之后才有机会写自己的结果摘要 —— 直接删就等于"干活的人无声无息地没了"，
 * 办公室里看不到汇报（实测：真召唤一次 susan，全程没有汇报动画）。
 * 现在改写它会连带一句摘要交给 subagentFeed：feed 播完"走到主 agent 面前汇报"
 * 再自动回收幽灵（见 subagentFeed 的 RETIRE_MS），顺序恰好是 汇报 → 空闲 → 幽灵消失。
 *
 * 匹配优先按 id 精确命中**一条**；没有 id 才退回按名字（也只改一条，别动同名的另一只）。
 * 摘要用 description/prompt 那句任务名兜底（feed 那边也会再兜一次），
 * 主 agent 若随后写了更具体的 result，会覆盖掉这句。
 */
function retireGhost(workspacePath, name, id, result, client, session = SESSION) {
  const file = feedFileFor(workspacePath);
  updateFeedFile(file, (feed) => {
    let hit = id ? feed.agents.findIndex((a) => a.id === id) : -1;
    // 没有 id 才退回按名字。按名字这一步也要带会话：两条会话各自召唤同名 subagent 时，
    // 只按名字找会收掉对方那只。
    if (hit < 0) {
      hit = feed.agents.findIndex(
        (a) => a.name === name && (!session || !a.sessionId || String(a.sessionId) === String(session))
      );
    }
    if (hit < 0) return undefined;
    const cur = feed.agents[hit] || {};
    // client 必须传进来：ownsEntry 拿它跟条目上的 client 比。
    // 早先这里漏传（ownsEntry(cur)），而 ownsEntry 在 client 为 undefined 时**恒返回 false**，
    // 于是本函数永远提前 return —— 幽灵从没进过"待汇报"，只会被 Stop / SessionEnd 当孤儿扫掉，
    // 「走到主 agent 面前汇报」那段动画对所有客户端都没播过（实测 ghost-report 打了，
    // 紧接着 ghost-sweep 仍把它当孤儿 remove 掉，就是这条）。
    if (!ownsEntry(cur, client, session)) return undefined; // 别动别的客户端 / 别的会话的幽灵
    const task = String(cur.task || '').trim();
    // Codex 的 SubagentStop 会带子代理最后那段话，直接当汇报文案（比"已完成：任务名"实在）
    const said = String(result || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    feed.agents[hit] = { ...cur, state: 'idle', result: said || (task ? `已完成：${task}` : '已完成') };
    return feed;
  });
}

/**
 * 记一笔"还没收工的召唤"（最多留最近 8 条）。
 * 结束信号（PostToolUse / SubagentStop）的 payload 未必带全 —— PostToolUse 的 tool_input
 * 可能和 PreToolUse 不一样，SubagentStop 更是可能什么都不带 —— 只靠事件本身算出来的
 * 名字会退化成兜底的 'subagent'，删不掉任何东西。所以召唤时把 id / name 记在状态文件里，
 * 收工时回来查。**多槽**（不是"最近一条"）：同名并发时前一只收工不能把后一只的账一起销掉。
 */
function rememberSubagent(file, id, name) {
  // 读账本 → 追加 → 写回，整段在锁里（并发召唤时 12 条只落 6 条就是这么丢的）
  updateState(file, (st) => {
    const list = (st.subagents || []).filter((r) => r && (r.id || r.name));
    if (id && !list.some((r) => r.id === id)) list.push({ id, name, at: Date.now() });
    else if (!id && name && !list.some((r) => r.name === name)) list.push({ id: '', name, at: Date.now() });
    return { ...st, subagents: list.slice(-8) };
  });
}

/**
 * 记录本轮用工具动过的文件（带 op：write=新增 / edit=改动 / delete=删除）。
 * 同文件多次出现后者覆盖，最后一步操作决定归类；最多保留 30 条。
 * @param {string} file 状态文件路径
 * @param {{path:string,op:string}[]} items 相对工程的文件 + 操作
 */
function rememberRoundFiles(file, items) {
  if (!items || !items.length) return;
  // 同 rememberSubagent：读-改-写整段在锁里，否则并发时"这一轮改了哪些文件"会互相覆盖
  updateState(file, (st) => {
    const map = new Map();
    for (const x of st.roundFiles || []) {
      if (x && x.path) map.set(x.path, x.op);
    }
    for (const it of items) {
      if (it && it.path) map.set(it.path, it.op);
    }
    const list = [...map.entries()].map(([path, op]) => ({ path, op }));
    return { ...st, roundFiles: list.slice(-30) };
  });
}

/**
 * 子代理收工时的**结果摘要**：PostToolUse 的 tool_response 里带着它最后说的话。
 * 各端形状不一（纯字符串 / {content} / {result}），能取到就用，取不到返回空 ——
 * retireGhost 会退回「已完成：<任务名>」，绝不编造。
 */
function resultOfResponse(ev) {
  const r = ev && ev.tool_response;
  if (r == null) return '';
  let s = '';
  if (typeof r === 'string') s = r;
  else if (typeof r === 'object') {
    const c = r.content != null ? r.content : r.result;
    if (typeof c === 'string') s = c;
    else if (Array.isArray(c)) {
      // Claude 风格：content 是 [{type:'text', text:'…'}]，只取文本片段
      s = c
        .map((x) => (x && typeof x === 'object' ? String(x.text || '') : String(x || '')))
        .join(' ')
        .trim();
    } else if (c != null) s = String(c);
  }
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** 收工：按 id 精确找，找不到再按 name，都找不到就认最早那只（FIFO）。转成待汇报并销账。 */
function finishGhost(file, workspacePath, ev, client, opts = {}, session = SESSION) {
  const ti = ev && ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : null;
  const nm = ti ? agentName(ti) : '';
  const keys = subagentKeys(ev, nm, ti ? agentTask(ti) : '');
  const aid = agentIdOf(ev);
  /** 匹配顺序：agent_id（Codex）> 合成 key（CodeBuddy）> 名字 > 最早那只（判据只依赖事件 + 台账） */
  const pick = (list) => {
    let r = aid ? list.find((x) => x.id === aid) : null;
    if (!r && keys.length) r = list.find((x) => x.id && keys.includes(x.id)) || null;
    if (!r && nm && nm !== 'subagent') r = list.find((x) => x.name === nm) || null;
    return r || list[0] || null;
  };
  // 挑出要收工的那只 + 销台账，**一起**在锁里：挑和销必须是一次原子操作，否则并发的
  // SubagentStop（实测同一秒来三个）会读到同一份台账、挑中同一只 —— 三只幽灵只收掉一只，
  // 剩下两只干等 GHOST_TTL_MS。
  let rec = null;
  updateState(file, (st) => {
    const list = st.subagents || [];
    const hit = pick(list);
    if (!hit) return undefined;
    rec = hit;
    return { ...st, subagents: list.filter((x) => x !== hit) };
  });
  if (!rec) return;
  // 划掉清单里的那只（先销账、后划账）：万一划账失败，台账少一条是无害的 ——
  // Stop / UserPromptSubmit 的 sweepGhosts 会按"没收过工的孤儿"把它兜底扫掉。
  retireGhost(workspacePath, rec.name, rec.id, opts.result, client, session);
  trace('ghost-report', { name: rec.name, id: rec.id, via: ev && ev.hook_event_name });
}

/**
 * 扫掉**本 hook 召唤的**幽灵，并销掉本地账本里的对应记录。
 *
 * 判据是条目带 `ts`：hook 写条目时一定带 ts，手工 `node scripts/subagents.js set …`
 * 写的条目没有 ts —— 手工归手工，不动。
 *
 * 早先这里按 `id` 判（"带 id 的才是 hook 写的"），但真实召唤根本没有 per-call id
 * （见 subagentKeys 的说明），于是这条兜底对真实场景**从来没生效过**。
 *
 * 调用点：Stop（本轮结束）、UserPromptSubmit（新一轮开始）、SessionEnd（会话结束）——
 * 前三者都意味着"上一轮召唤出去的 subagent 不可能还在飞"。
 * 扫的**范围**不同：Stop / UserPromptSubmit 只扫「从没收过工的孤儿」（保住待汇报的幽灵），
 * SessionEnd 全扫（会话都没了，没什么好汇报的了）。
 * @returns {number} 清掉的条数
 */
function sweepGhosts(stateFile, workspacePath, client, opts = {}, session = SESSION) {
  // 注意两个路径别搞混：stateFile 是 hook 状态文件（账本在里面），
  // 清单文件要按 workspacePath 现算 —— 混了的话本函数会静默变成空操作。
  const feedFile = feedFileFor(workspacePath);
  // 默认只扫「从没收过工的孤儿」（没有 result）：带 result 的已经进了「待汇报」流程，
  // 由 subagentFeed 播完汇报再回收 —— 连它一起扫会把刚做好的汇报动画掐掉。
  // 会话真的结束了（SessionEnd）才 all:true 全清。
  // **会话维度**：all:true 也只是"这条会话全清"，不是"清光整个工程" ——
  // 否则你关掉一个终端，另一个终端里还在飞的幽灵会被一起扫掉。
  // 读改写整段在锁里：清单文件是多个 hook 进程 / 服务端 subagentFeed / CLI 脚本共用的。
  let doomed = [];
  updateFeedFile(feedFile, (feed) => {
    doomed = feed.agents.filter((a) => a && a.ts && ownsEntry(a, client, session) && (opts.all || !a.result));
    if (!doomed.length) return undefined; // 没得扫 → 不开销一次写盘
    feed.agents = feed.agents.filter((a) => !doomed.includes(a));
    return feed;
  });
  if (!doomed.length) return 0;

  // 销台账：同样是"读-改-写"，整段在锁里 —— 并发的 Stop / UserPromptSubmit 会互相覆盖，
  // 销不掉的那条会一直挂在台账里（下一次 finishGhost 可能拿它去收错幽灵）。
  updateState(stateFile, (st) => {
    const pool = (st.subagents || []).slice();
    for (const a of doomed) {
      const i = pool.findIndex((r) => r && (a.id ? r.id === a.id : !r.id && r.name === a.name));
      if (i >= 0) pool.splice(i, 1);
    }
    return { ...st, subagents: pool };
  });
  trace('ghost-sweep', { removed: doomed.length, agents: doomed.map((a) => a.name) });
  return doomed.length;
}

/** 把"等权限"标记写进本地状态文件：要执行的工具 + 目标文件 + 工程 + 时间。
 *  优先取 notification 自带的工具信息，取不到就回退到最近一次 PreToolUse 记的。 */
function setAwait(file, ctx, cwd, ev) {
  const st = readState(file);
  const tool = (ev && ev.tool_name) || st.lastTool || '';
  const input = (ev && ev.tool_input) || st.lastInput || '';
  const f = relFile(fileOf(input), cwd);
  writeState(file, {
    await: { tool, file: f, ts: Date.now(), workspacePath: REAL_WS },
    sessionPhase: { phase: 'await', tool, file: f, ts: Date.now(), workspacePath: REAL_WS },
  });
}

/** 撤掉"等权限"标记（工具放行 / 新回合 / 会话结束）。
 *  顺便把 pending 一起清掉：它只是 PreToolUse 留下的"兜底推断"标记。 */
function clearAwait(file) {
  writeState(file, { await: null, pending: null, sessionPhase: null, done: null });
}

function startHeartbeat(agent, session = SESSION) {
  const file = statePath(agent, session);
  const st = readState(file);
  if (st.hb && st.hb.pid && alive(st.hb.pid)) return; // 已经有一个在跑
  try {
    // --session 必须传给子进程：守护要按会话找**自己那份**状态文件。
    // 少了它，两条会话的守护会共用一份文件，一条 SessionEnd 就把另一条还在跑的心跳杀掉。
    const child = spawn(
      process.execPath,
      [__filename, '--heartbeat', '--agent', agent, ...(session ? ['--session', session] : [])],
      {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      }
    );
    child.unref();
    writeState(file, { hb: { pid: child.pid, startedAt: Date.now(), lastEventAt: Date.now() } });
  } catch (err) {
    debug('拉起心跳守护失败：', err && err.message);
  }
}

function stopHeartbeat(agent, session = SESSION) {
  const file = statePath(agent, session);
  const st = readState(file);
  const pid = st.hb && st.hb.pid;
  // 先立停止旗，再发信号：守护即便错过信号，下一轮也会自己退
  writeState(file, { hb: { ...(st.hb || {}), stop: true } });
  if (pid && alive(pid)) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {
      /* 已经没了 */
    }
  }
}

/**
 * 心跳守护：SessionStart 拉起、SessionEnd 收掉。
 * 没有它，agent 只要思考超过 60s，屋里就把它标成 degraded（灰 + 「推断」）。
 */
async function runHeartbeat(info, agent, session = '') {
  const file = statePath(agent, session);
  const startedAt = Date.now();
  const ctx = await resolveCtx(info);
  const body = { project: ctx.project, workspacePath: ctx.workspacePath, memberId: agent, sessionId: session };
  writeState(file, { hb: { pid: process.pid, startedAt, lastEventAt: Date.now() } });

  const stop = () => {
    clearInterval(timer);
    const st = readState(file);
    writeState(file, { hb: { ...(st.hb || {}), pid: null, stop: false } });
  };

  const tick = async () => {
    const hb = readState(file).hb || {};
    // 停止旗 / 被后来者顶掉 / 太久没事件 / 活太久 —— 都退，绝不留下孤儿
    if (hb.stop || (hb.pid && hb.pid !== process.pid) || Date.now() - startedAt > HB_MAX_LIFE_MS) return stop();
    if (hb.lastEventAt && Date.now() - hb.lastEventAt > HB_IDLE_EXIT_MS) return stop();
    await request(info, HTTP_ROUTES.HEARTBEAT, body);
  };

  const timer = setInterval(tick, HB_INTERVAL_MS);
  if (timer.unref) timer.unref();
  await tick();
}

async function main() {
  const argv = process.argv.slice(2);
  // 主 agent 身份：安装器在命令里用 --agent 注入，必填；缺了直接报错退出。
  AGENT = flag(argv, '--agent');
  if (!AGENT) {
    console.error('[workgremlin-hook] 缺少必需参数 --agent（主 agent 名字，如 codebuddy / codex / workbuddy / trae / claude / qoder）');
    process.exit(1);
  }
  IS_CODEX = AGENT === 'codex';
  IS_CLAUDE = AGENT === 'claude';

  const info = readServerInfo();
  if (!info || !info.port) {
    debug('没有 ~/.workgremlin/server.json，WorkGremlin 没在跑 —— 跳过');
    return;
  }

  // 心跳守护：--session 由 startHeartbeat 拉起时注入，决定它盯哪一份状态文件
  if (argv.includes('--heartbeat')) return runHeartbeat(info, AGENT, flag(argv, '--session'));

  const raw = await readStdin();
  let ev = null;
  try {
    ev = JSON.parse(raw);
  } catch {
    debug('stdin 不是 JSON —— 跳过');
    return;
  }
  const event = ev && ev.hook_event_name;
  if (!event) return;
  // 轴 2：本次事件属于哪条会话。必须在算 statePath / 拉心跳之前定下来 ——
  // 它决定这一整轮所有读写落在**哪一份**状态文件上。
  // 拿不到就留空（退回旧的文件名，向后兼容），绝不是"随便挑一条会话"。
  SESSION = String((ev && ev.session_id) || '').trim();
  // 本次事件归属的客户端：默认 CodeBuddy 钩子落 'codebuddy'（CLI 来源），
  // plugin（payload 自带 client）则落 'codebuddy-plugin'（Plugin 来源）——两种身份都在
  // 1F CodeBuddy 这一层，服务端按会话区分；其余产品同此
  // （codex / codex-plugin、trae / trae-plugin …），由 eventClient 统一归层。
  const cl = eventClient(ev);
  // 观测用：把"安装器注入的 client（env）"与"payload 自带的 client（ev）"都按原值打出来，
  // 方便对照 codebuddy plugin / traeCode plugin / codex cli 各自长什么样。
  trace(event, {
    client: cl,
    agent: AGENT,
    raw_ev_client: ev && ev.client !== undefined ? ev.client : null,
    tool: ev.tool_name,
    notification_type: ev.notification_type,
  });

  const ctx = await resolveCtx(info);
  // sessionId 放进公共信封：register / task/start / task/end / file/touch / message / status
  // 全都从 base 展开，一处加上即全线带上 —— 服务端据此把每条记录挂到**具体会话**上。
  const base = { project: ctx.project, workspacePath: ctx.workspacePath, sessionId: SESSION };
  const file = statePath(AGENT);
  const cwd = typeof ev.cwd === 'string' ? ev.cwd : '';
  // 状态文件里记下来源客户端：同一个工程可能同时有 Codex / CLI / Plugin 在跑，
  // 主控制台要按楼层（客户端）取相位，不能谁新鲜就显示谁。
  // agent_type 一并落盘：TraeCode 把"每个会话选了哪个模型"按 agentType 分组记在
  // globalStorage 里（agent / solo_agent 各一项），服务端靠它挑对应那一项。
  const agentType = String((ev && ev.agent_type) || '').trim();
  writeState(file, {
    client: cl,
    sessionId: String((ev && ev.session_id) || ''),
    ...(agentType ? { agentType } : {}),
  });

  // transcript 路径：Codex / CodeBuddy 的 hook payload 都带，存下来供 Stop 取"产出摘要"。
  // 纯问答没有工具事件、Stop 也不带 last_assistant_message 时，只能从 transcript 读最后一条 assistant。
  if (ev.transcript_path) writeState(file, { transcriptPath: String(ev.transcript_path) });

  // 心跳守护的"最后活跃时间"（它靠这个判断会话还在不在）
  if (event !== 'SessionEnd') {
    // 读-改-写（要保留原来的 hb.pid / startedAt）：整段在锁里，别把心跳守护的登记冲掉
    updateState(file, (st) => ({ ...st, hb: { ...(st.hb || {}), lastEventAt: Date.now() } }));
  }

  const register = () =>
    request(info, HTTP_ROUTES.REGISTER, {
      ...base,
      memberId: AGENT,
      name: AGENT,
      role: process.env.WORKGREMLIN_ROLE || 'agent',
      // 来源客户端：办公室按当前楼层的客户端过滤成员（server 的 members.client）
      client: cl,
    });
  const beat = () => request(info, HTTP_ROUTES.HEARTBEAT, { ...base, memberId: AGENT });
  /**
   * 状态上报。顺带把**这条会话此刻挂在哪个任务上**一起报（轴 2）。
   *
   * 为什么非报不可：服务端 `agent_status` 是**一行一成员**、只有一个 task_id 槽位，
   * 同产品的多条会话共用它。不报的话服务端只能沿用上一行，槽位就被"最后调 startTask 的
   * 那条会话"占死 —— 实测后果是状态**正好反了**：已退出的那条在报表里显示「进行中」，
   * 正在干活的这条显示「已取消」（见 server/src/ingest/bus.js 的 nextTaskSlot）。
   *
   * 值取状态文件里的 taskId（UserPromptSubmit 落、Stop 清），所以收工时发出去的
   * 是显式 `null` —— "这条会话现在没有在跑的任务"，服务端据此只释放**自己**占的槽位。
   */
  const status = (state, reason) =>
    request(info, HTTP_ROUTES.STATUS, {
      ...base,
      memberId: AGENT,
      state,
      taskId: readState(file).taskId || null,
      ...(reason ? { reason } : {}),
    });

  // 会话边界的事件才 register（工具前后各 register 一次太吵）；
  // 但中途才装上 hook 的话第一个事件也可能是 SessionStart 之外的，所以 UserPromptSubmit / Stop 也补一次。
  if (event === 'SessionStart') {
    pruneStateFiles(); // 顺手清过期状态文件（见该函数说明：不清理会把 1.5s 快轮询拖垮）
    startHeartbeat(AGENT, SESSION);
    await register();
    await beat();
    await status('idle');
    // Qoder 实测只发 SessionStart / SessionEnd，没有 UserPromptSubmit / PreToolUse / PostToolUse
    // 这些细粒度事件（见 scripts/install-hooks.js 的 QODER_EVENTS 注释与 ~/.workgremlin/hooks/events.log）。
    // 不补一笔"会话进行中"的粗粒度真值，主控制台只会一直显示「未上报」。Claude / CodeBuddy 有
    // 细粒度事件随后把相位推进到 thinking / tool，不受这句影响。
    if (AGENT === 'qoder') {
      writeState(file, { sessionPhase: { phase: 'thinking', ts: Date.now(), workspacePath: REAL_WS } });
    }
    return;
  }

  if (event === 'UserPromptSubmit') {
    // 新一轮用户输入 = 上一轮已经结束：Task 是阻塞工具，轮次一结束它就不可能在飞了。
    // 结束事件可能丢（实测：打断时 PostToolUse / SubagentStop 都不来），这里兜底扫掉。
    sweepGhosts(file, REAL_WS, cl);
    clearAwait(file); // 新的一轮用户输入：之前挂起的"等授权"作废
    const prompt = String(ev.prompt || '');
    const title = prompt.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || '（未命名任务）';
    await register();
    // model 一并上报：报表要记这一轮用的是哪个模型（hook payload 没带就是空 → 服务端留 NULL）
    const started = await request(info, HTTP_ROUTES.TASK_START, {
      ...base,
      memberId: AGENT,
      title,
      model: String(ev.model || ''),
    });
    // taskTitle（用户原话）无论 TASK_START 成功与否都要落盘：它是"思考中"屏上 / tooltip 里显示的那句话，
    // 不能因为上报失败就留着上一轮的旧标题 —— 否则"思考中"会先显示上一轮内容，等快照刷新才更正。
    // 新一轮：上一轮动过的文件清单作废（完成概要只算这一轮的）
    const patch = { taskTitle: title, done: null, roundFiles: [] };
    if (started && started.taskId) {
      patch.taskId = started.taskId;
      patch.taskWorkspacePath = REAL_WS;
      patch.taskStartedAt = Date.now();
    }
    writeState(file, patch);
    // 进入"思考中"：直到下一个事件（PreToolUse / Notification / Stop）才切换
    writeState(file, { sessionPhase: { phase: 'thinking', ts: Date.now(), workspacePath: REAL_WS } });
    // 用户刚提交：进入"思考中"，直到下一个事件（PreToolUse / Stop / Notification）才切换。
    // 思考期间没有任何工具/授权事件，牌子上就一直显示「思考中」。
    await status('thinking');
    if (process.env.WORKGREMLIN_HOOK_MESSAGES === '1') {
      await request(info, HTTP_ROUTES.MESSAGE, {
        ...base,
        memberId: AGENT,
        from: AGENT,
        to: null,
        type: 'task_assign',
        subject: title,
        content: prompt.slice(0, 2_000),
      });
    }
    return;
  }

  if (event === 'PreToolUse' || event === 'PostToolUse') {
    await beat();
    if (event === 'PreToolUse') {
      const tool = ev.tool_name || '';
      // 注意：工具目标文件用局部变量 f 接，绝不能覆盖外层的 file（= 状态文件路径）！
      // 否则 writeState(file, ...) 会把 sessionPhase 写到相对路径（如 src/main.js）而非状态文件，
      // server 永远读不到 tool 相位 → 思考中卡住、转不到调用工具（今天这个 bug 的根因）。
      const f = relFile(fileOf(ev.tool_input, ev.tool_name), cwd);
      const input = ev.tool_input || {};
      // 给 tips 用的"实际调用"：Bash/命令类用 command，Grep 类用 pattern+路径，读改写类用"工具 文件"
      // apply_patch 的 input.command 是**整段 patch 文本**，塞进 desc 会把主控制台那一行刷爆 ——
      // 它已经有解析出来的目标文件了，用「apply_patch <文件>」足够。Codex 的工具名还带
      // collaborationspawn_agent 这种命名空间前缀，展示时去掉，牌子上好读。
      const toolLabel = tool.replace(/^collaboration/, '');
      const cmdText = /^apply_patch$/.test(tool) ? '' : input.command || input.cmd || '';
      const desc = cmdText
        ? `${toolLabel} ${cmdText}`
        : input.pattern || input.regex || input.query
          ? `${toolLabel} ${input.pattern || input.regex || input.query}${f ? ' ' + f : ''}`
          : f ? `${toolLabel} ${f}` : toolLabel;
      // pending 只给"会发 PostToolUse、且可能要权限"的写类工具打。
      // 本环境实测 Read/Grep/Glob/ReadLints/Bash 等只读 / 命令类工具根本不发 PostToolUse，
      // 一旦给它们打 pending，PostToolUse 永远不来、清不掉 → 兜底误判成"等待授权"
      // （典型误报：读文件却显示「等待授权」、点了 run 还在「等待授权」）。
      // Codex / Claude Code 有显式的 PermissionRequest 事件，不需要"pending 超时 = 等授权"
      // 这套兜底推断；而且它们的写类工具经常跑很久，打了 pending 会被误判成"等待授权"。
      const probe = !hasPermissionEvent() && PROBE_TOOLS.has(tool);
      writeState(file, {
        lastTool: tool,
        lastInput: ev.tool_input || '',
        pending: probe
          ? { tool, file: f, cmd: desc, at: Date.now(), workspacePath: REAL_WS }
          : null, // 非写类：显式清掉上一支可能残留的 pending
        // 工具开始跑 → 主控制台相位「调用工具」（PreToolUse..PostToolUse 这段就是"在调工具"）
        sessionPhase: { phase: 'tool', tool, file: f, cmd: desc, ts: Date.now(), workspacePath: REAL_WS },
      });
      // 主 Agent 召唤 subagent（Task / Agent 工具）→ 往清单写一条，办公室飘出一只小幽灵。
      // 写 REAL_WS（插件真正在干活的工程）而不是服务端"当前打开的工程"：
      // 相位 / 任务都打 REAL_WS，幽灵跟着走才不会串到别的工程屋里去。
      if (isSubagentTool(tool)) {
        const nm = agentName(ev.tool_input);
        const task = agentTask(ev.tool_input);
        if (IS_CODEX) {
          // Codex：真正的召唤信号是紧跟着的 SubagentStart（带 agent_id）。spawn_agent 的
          // tool_response 里没有 agent_id（实测只有 {"task_name":"/root/xxx"}），所以这里只把
          // 名字 / 任务记成"待认领"，由 SubagentStart 认领后生成幽灵；收工只认 SubagentStop。
          writeState(file, { pendingSpawn: { name: nm, task, at: Date.now() } });
          trace('ghost-pending', { agent: AGENT, tool, name: nm });
        } else {
          const id = subagentKeys(ev, nm, task)[0] || '';
          rememberSubagent(file, id, nm);
          // parent = 主 agent 当前这一轮的用户任务 id：台账靠它把这次召唤挂到那一轮头上
          addGhost(REAL_WS, nm, task, id, String(readState(file).taskId || ''), String(ev.model || ''), cl);
          trace('ghost+', { agent: AGENT, tool, name: nm, id, gen: ev.generation_id || '', agentId: ev.agent_id || '' });
        }
      }
      await status('busy');
    } else {
      const touched = filesOf(ev.tool_input, ev.tool_name).map((x) => relFile(x, cwd)).filter(Boolean);
      if (touched.length) {
        await request(info, HTTP_ROUTES.FILE_TOUCH, { ...base, memberId: AGENT, files: touched, op: opOf(ev.tool_name) });
        // 本地也记一份：上报失败（服务没起 / 接口报错）时完成概要仍拿得到文件清单
        rememberRoundFiles(file, touched.map((p) => ({ path: p, op: opOf(ev.tool_name) })));
      }
      // TodoWrite / 待办清单更新：据此上报"任务进度"（已完成占比）。
      // 这是任务进行中能拿到的真实完成比例信号——agent 用待办清单组织任务时，
      // 每改写一次清单就反映"做了几个"，hook 调 /task/progress，任务记录的进度
      // 才不是只有 0% 和 100%。抽不到（非待办工具 / 清单不可解析）就不上报。
      const prog = todoProgress(ev.tool_name, ev.tool_input);
      if (prog != null) {
        const tid = readState(file).taskId;
        if (tid) {
          await request(info, HTTP_ROUTES.TASK_PROGRESS, { ...base, memberId: AGENT, taskId: tid, progress: prog });
        }
      }
      // 工具真正跑完了 → 权限已通过，撤掉"等授权"，回到"思考中"
      clearAwait(file);
      writeState(file, { sessionPhase: { phase: 'thinking', ts: Date.now(), workspacePath: REAL_WS } });
      // subagent 收工 → 从清单划掉，小幽灵散掉
      // Codex 的 spawn_agent 返回 ≠ 子代理干完（它的收工只认 SubagentStop）
      // 带上结果摘要：tool_response 里有子代理最后说的话就当汇报文案，
      // 没有就由 retireGhost 退回"已完成：<任务名>"。
      if (isSubagentTool(ev.tool_name) && !IS_CODEX) finishGhost(file, REAL_WS, ev, cl, { result: resultOfResponse(ev) });
      // PostToolUse = 工具已跑完，进入"思考中"（处理返回结果），直到下一个事件
      await status('thinking');
    }
    return;
  }

  if (event === 'Notification') {
    if (ev.notification_type === 'idle_prompt') {
      clearAwait(file);
      await status('idle');
    } else if (IS_CLAUDE && ev.notification_type !== 'permission_prompt') {
      // Claude Code 的 notification_type 枚举还有 auth_success / elicitation_dialog 等，
      // 它们**都不是**在等权限（实测 2.1.281 二进制里的枚举）。
      // CodeBuddy 的非 idle 类型只有"要权限"这一种，所以它的 else 可以直接当"等授权"；
      // Claude 若照抄 else，登录成功那一下就会被标成"等待授权"。不认的类型直接不动状态。
      return;
    } else {
      // 等权限：把要执行的工具 + 目标文件写进本地状态文件，主控制台会读它显示"等待授权"
      setAwait(file, ctx, cwd, ev);
      // 同时把相位标成「await」写进 sessionPhase —— server/src/sessions.js 的 readReporterPhase
      // 只读 sessionPhase、不读 await 字段，所以不标这一笔主控制台就收不到"等待授权"的真实操作。
      const tool = (ev && ev.tool_name) || readState(file).lastTool || '';
      const input = (ev && ev.tool_input) || readState(file).lastInput || '';
      writeState(file, {
        sessionPhase: { phase: 'await', tool, file: relFile(fileOf(input), cwd), ts: Date.now(), workspacePath: REAL_WS },
      });
      await status('blocked', 'awaiting_permission');
    }
    return;
  }

  if (event === 'Stop') {
    clearAwait(file);
    // 本轮结束：同理，屋里不该再留着上一轮召唤的幽灵
    sweepGhosts(file, REAL_WS, cl);
    const st = readState(file);
    let taskId = st.taskId;
    let title = st.taskTitle || '';
    // 本轮任务的开始时刻：服务端据此只挑"这一轮改过的文件"做完成概要，
    // 否则会把上一轮的改动也算进来（典型：这一轮只是 push，却显示上一轮改了多少文件）。
    let startedAt = Number(st.taskStartedAt) || 0;
    // 兜底（bug 3）：并发覆盖会让状态文件丢掉 taskId —— 那样本轮就不发 task/end，
    // 产出摘要 / 改动文件 / 结束时间整块丢，任务永远挂 running（实测 13:14 / 13:18 /
    // 13:29 三条 codebuddy 任务全部如此）。taskId 丢了就向服务端回捞"本成员 + 本会话
    // 当前在跑的任务"（服务端 agent_status / task_runs 里是真值），拿回来照常收工。
    if (!taskId) {
      const cur = await request(info, HTTP_ROUTES.TASK_CURRENT, { ...base, memberId: AGENT });
      if (cur && cur.taskId) {
        taskId = cur.taskId;
        if (!title && cur.title) title = cur.title;
        if (!startedAt && cur.startedAt) startedAt = Number(cur.startedAt) || 0;
        trace('task-recover', { agent: AGENT, taskId, sessionId: SESSION });
      }
    }
    // 落"完成"标记：带工程路径 + 任务标题 + 起始时刻，服务端据此（且仅据此）亮"任务完成"概要，
    // 不再靠"相位回落到空闲"来猜，避免中途被其它工程串味误弹。
    // 本轮的 AI 回复：Stop 自带的 last_assistant_message 优先（Codex 实测有），
    // 取不到（CodeBuddy 实测为空）就回退读 transcript —— 按各家落盘格式解析，见 turnReplies()。
    const replies = turnReplies(ev.transcript_path || st.transcriptPath || '');
    const eventSaid = String((ev && ev.last_assistant_message) || '').replace(/\s+/g, ' ').trim();
    const lastText = eventSaid || (replies.length ? replies[replies.length - 1].text : '');
    // 主控制台那口气泡只放一句话：摘要留短（160）；台账 result 与对话记录存全文（各有上限）。
    const said = lastText.replace(/\s+/g, ' ').trim().slice(0, 160);
    const result = lastText.trim().slice(0, RESULT_MAX);
    // transcript 读不到（路径没了 / 格式不认识）时，至少把 Stop 自带的这句当成一条回复存下来；
    // 去重键用正文哈希（同一轮重复上报仍不会写重，不同轮内容不同就是两条）。
    if (!replies.length && lastText) replies.push({ id: 'h' + fnv1a32(lastText), text: lastText });
    // 本轮用工具动过的文件（PostToolUse 一路记下来的）：跟着完成标记一起落盘，
    // 这样 1.5s 快轮询拿到 doneAt 的**同一时刻**就有文件清单，不用等 10s 的会话快照，
    // 「任务完成」才不会退化成一句"本次任务已完成"。
    // 注意：rememberRoundFiles 存的是 {path, op} 对象（op 区分 新增/改动/删除），
    // 这里只过滤无效项，不要把对象当成字符串丢掉（否则文件清单永远为空）。
    const roundFiles = (st.roundFiles || []).filter((x) => x && (typeof x === 'string' ? x : x.path));
    // 本轮用工具动过的文件：补上"当前体积（字节）"，主控制台好显示文件大小。
    // 大小在收工那一刻现 stat。解析按优先级试多个基路径：文件本身（工具给的往往是绝对路径）
    // → 按事件 cwd → 按 REAL_WS（= process.cwd()）。插件 / IDE 下 cwd 常常对不上工程，
    // 只信 cwd 会把大小算成 null，所以要多试几个、谁先 stat 到用谁。
    // 之所以在 hook 侧算、不让服务端算：服务端按工程存的 workspace_path 反查文件，
    // 而开发工程那条 workspace_path 往往为空 / 对不上，服务端 stat 必失败 → 大小永远 null。
    const roundFileDetails = roundFiles.map((x) => {
      const p = typeof x === 'string' ? x : x.path;
      const op = typeof x === 'string' ? null : x.op;
      let size = null;
      if (op !== 'delete') {
        const candidates = [p, cwd ? path.resolve(cwd, p) : null, path.resolve(REAL_WS, p)].filter(Boolean);
        for (const cp of candidates) {
          try {
            const st0 = fs.statSync(cp);
            if (st0.isFile()) {
              size = st0.size;
              break;
            }
          } catch {
            /* 试下一个候选 */
          }
        }
      }
      return { path: p, op, size };
    });
    // 收工上报：把**这一轮的产出**一起交给服务端进台账（task_runs）——
    // 收尾自述 + 改动文件清单（含大小）+ 模型，报表要的"输入 / 产出 / 改了多少文件 / 用了什么模型"就齐了。
    if (taskId) {
      await request(info, HTTP_ROUTES.TASK_END, {
        ...base,
        memberId: AGENT,
        taskId,
        state: 'done',
        model: String(ev.model || ''),
        result,
        files: roundFileDetails,
        fileCount: roundFileDetails.length,
      });
    }
    // 每次 AI 回复都进对话记录（messages 表）——这是"每次回复入库"那条线，
    // 与上面的 task_runs.result（一轮一条摘要）互不替代。
    // 放在清 taskId 之前：消息要挂在本轮任务上；重复上报由 dedupeKey 吃掉。
    writeState(file, {
      taskId: null,
      taskWorkspacePath: '',
      taskStartedAt: 0,
      roundFiles: [],
      done: {
        at: Date.now(),
        title,
        workspacePath: REAL_WS,
        startedAt,
        said,
        sessionId: String((ev && ev.session_id) || ''),
        // 只带前 8 条（屏上放不下就省略），总数另给一个字段，界面好写"改动 N 个文件"
        files: roundFileDetails.slice(0, 8),
        fileCount: roundFileDetails.length,
      },
    });
    // 先把"任务完成 / 空闲"告诉办公室，再做回复入库 —— 入库慢不该拖住界面。
    // taskId / replies / sessionId 都在局部变量里，所以放在清状态之后归属也不会错。
    await beat();
    await status('idle');
    await reportAiReplies(info, base, AGENT, taskId, replies, String((ev && ev.session_id) || st.sessionId || ''), cl);
    return;
  }

  // Codex：等授权是独立事件（带 tool_name / tool_input），比 CodeBuddy 靠 Notification 更准，
  // 主控制台的"等待授权"相位在 Codex 下靠它点亮。
  if (event === 'PermissionRequest') {
    setAwait(file, ctx, cwd, ev);
    await status('blocked', 'awaiting_permission');
    return;
  }

  // Codex：子代理起手（带 agent_id / agent_type）—— 这是最干净的召唤信号，不用从工具名推断。
  // CodeBuddy 没有这个事件，所以那边仍然走 PreToolUse(Task) 那条路。
  if (event === 'SubagentStart') {
    const st = readState(file);
    const pend =
      st.pendingSpawn && Date.now() - Number(st.pendingSpawn.at || 0) < PENDING_SPAWN_MS ? st.pendingSpawn : null;
    const type = String(ev.agent_type || '').trim();
    // 名字优先级：agent_type（真起了具名子代理时）> spawn_agent 的 task_name > 'subagent'
    const name = (type && type !== 'default' ? type : '') || (pend && pend.name) || 'subagent';
    const id = agentIdOf(ev) || subagentKeys(ev, name, (pend && pend.task) || '')[0] || '';
    rememberSubagent(file, id, name);
    addGhost(REAL_WS, name, (pend && pend.task) || '', id, String(readState(file).taskId || ''), String(ev.model || ''), cl);
    writeState(file, { pendingSpawn: null });
    trace('ghost+', { agent: AGENT, tool: 'SubagentStart', name, id, agentType: type });
    await beat();
    return;
  }

  // 打断（ESC / 停止）：这一轮飞出去的召唤不可能还活着 —— 只收孤儿，不碰主会话的任务与相位。
  if (event === 'Interrupt') {
    // 被打断的这一轮：之后再来一句 user，本轮回复就永远落在"上一条 user 之前"了 —— 先补一刀留档。
    const stInt = readState(file);
    await reportAiReplies(
      info,
      base,
      AGENT,
      stInt.taskId,
      turnReplies(ev.transcript_path || stInt.transcriptPath || ''),
      String((ev && ev.session_id) || stInt.sessionId || ''),
      cl
    );
    sweepGhosts(file, REAL_WS, cl);
    await beat();
    return;
  }

  // SubagentStop：subagent 收工 —— **只收幽灵**，绝不碰主会话的任务 / 相位
  // （子代理收工 ≠ 主会话收工，所以不能像 Stop 那样结束任务，否则会误报"任务完成"）。
  // Codex 的这条事件还带 last_assistant_message，直接拿来当汇报文案。
  if (event === 'SubagentStop') {
    finishGhost(file, REAL_WS, ev, cl, { result: ev.last_assistant_message });
    await beat();
    return;
  }

  if (event === 'SessionEnd') {
    // 注意：这里不能调 clearAwait() —— 它会把 done 一起清掉，而 done 是"上一轮任务完成"的标记，
    // 会话结束后办公室可能还停在这条会话上（尤其 codex exec 这种一次一进程的短会话），
    // 清掉就永远看不到「任务完成」摘要了。所以只清"当前进行中"的那几项。
    // 兜底：Stop 没来（进程被杀 / 打断 / 一次一进程的 codex exec 收尾）时，本轮 AI 回复也别丢 ——
    // 同样按"消息 id / 请求 id"去重，SessionEnd 之后再报一遍不会写重。
    const stEnd = readState(file);
    await reportAiReplies(
      info,
      base,
      AGENT,
      stEnd.taskId,
      turnReplies(ev.transcript_path || stEnd.transcriptPath || ''),
      String((ev && ev.session_id) || stEnd.sessionId || ''),
      cl
    );
    // Qoder 没有 Stop（只有 SessionStart / SessionEnd），收尾给一个"已完成"的粗粒度相位，
    // 否则 sessionPhase 回落成 null，主控制台又会显示「未上报」。其它产品维持原状（null）。
    writeState(file, {
      await: null,
      pending: null,
      sessionPhase: AGENT === 'qoder' ? { phase: 'done', ts: Date.now(), workspacePath: REAL_WS } : null,
    });
    stopHeartbeat(AGENT);
    // 兜底：会话都结束了，它召唤出去的幽灵不该还飘着（手工 scripts/subagents.js
    // 写的那些没有 ts，不动它们）。
    sweepGhosts(file, REAL_WS, cl, { all: true });
    writeState(file, { taskId: null, taskWorkspacePath: '', taskStartedAt: 0, subagents: [] });
    await status('offline');
  }
}

main().catch((err) => {
  debug('异常（忽略）：', err && err.message);
  process.exit(0); // hook 失败绝不能把 agent 卡住
});
