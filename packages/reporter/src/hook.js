#!/usr/bin/env node
'use strict';

/**
 * CodeBuddy 插件 / CodeBuddy CLI / WorkBuddy CLI 的 hook 入口。
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
 *   WORKGREMLIN_MEMBER      工位名（缺省 codebuddy）
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

/**
 * 本 hook 服务哪个 CLI（安装器写进 hook 命令：Codex 那份是 WORKGREMLIN_CLIENT=codex）。
 * 实测差异（Codex CLI 0.151.0）：
 *   · 工具名：Bash / apply_patch（tool_input 是 patch 文本）/ collaborationspawn_agent …
 *   · 事件：有 PermissionRequest、SubagentStart、Interrupt；没有 Notification
 *   · 每个工具事件都带真 tool_use_id；子代理事件带 agent_id / agent_type
 * 对照 CodeBuddy：工具名 Write/Edit/MultiEdit/Task，事件 Notification / SubagentStop。
 */
const CLIENT = String(process.env.WORKGREMLIN_CLIENT || 'codebuddy').toLowerCase();
const IS_CODEX = CLIENT === 'codex';
/** spawn_agent → SubagentStart 之间的"待认领"窗口 */
const PENDING_SPAWN_MS = 2 * 60_000;

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
 * 每个工位 + 工程一份：当前任务 id + 心跳守护的 pid。
 * 文件名带上工程（cwd 解析后的 REAL_WS），这样多个工程同时开着（同一 member 名 codebuddy）
 * 时各自写自己的文件，互不覆盖相位 / 任务 / 心跳 —— 否则会出现旧会话乱跳"思考中"、
 * "任务完成"被别的工程串味误弹等跨工程失真。
 */
function statePath(member) {
  const key = `${String(member)}@${REAL_WS}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(home(), 'hooks', `${key}.json`);
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
    const next = { ...readState(file), ...patch };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next)}\n`, 'utf8');
    return next;
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

/** 编辑类算 edit，其余写类算 write（server 侧只分 read / write 之外的 op） */
function opOf(tool) {
  const t = String(tool || '');
  if (t === 'apply_patch') return 'edit'; // Codex
  return /^(Edit|MultiEdit|NotebookEdit|replace_in_file)$/.test(t) ? 'edit' : 'write';
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

function readFeedFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const agents = Array.isArray(data) ? data : Array.isArray(data.agents) ? data.agents : [];
    const project = (!Array.isArray(data) && typeof data.project === 'string' && data.project) || '';
    return { project, agents };
  } catch {
    return { project: '', agents: [] };
  }
}

function writeFeedFile(file, feed) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(feed, null, 2)}\n`, 'utf8');
  } catch (err) {
    debug('写 subagent 清单失败：', err && err.message);
  }
}

/**
 * 召唤 subagent 的工具名：CodeBuddy 插件 / CLI 用的是 **Task**
 * （日志实测 5 次 PreToolUse 全是 Task、一次 Agent 都没出现过）；
 * 旧版 / Claude Code 风格里它叫 Agent，两个都认，免得换一端就全瞎。
 */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const isSubagentTool = (tool) => {
  const t = String(tool || '');
  // CodeBuddy / Claude 风格是 Task / Agent；Codex 是 collaborationspawn_agent（带命名空间前缀）
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
 *      **CodeBuddy 插件没有**：读扩展源码（out/extension/index.js）实测，PreToolUse / PostToolUse
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
 * 这条清单条目归不归本 hook 管。
 * Codex 与 CodeBuddy 写的是**同一个** <workspace>/.workgremlin/subagents.json，
 * 所以收工 / 扫场必须认来源，否则会把对方的幽灵一起收掉。
 * 写了 client 的按 client 认；没写的（老版本 hook / 手工脚本）算 CodeBuddy 的历史条目。
 */
function ownsEntry(a) {
  if (!a) return false;
  const c = String(a.client || '').trim().toLowerCase();
  if (c) return c === CLIENT;
  return CLIENT === 'codebuddy';
}

/**
 * 主 Agent 召唤 subagent → 加一只小幽灵。
 * key 用**本次调用的 id**而不是名字：同一个 subagent_type 并发起两个 Task 是很常见的，
 * 按名字去重的话第二只根本登记不上，而第一只收工又会按名字把还在跑的那只一起划掉。
 */
function addGhost(workspacePath, name, task, id) {
  const file = feedFileFor(workspacePath);
  const feed = readFeedFile(file);
  const dup = id ? (a) => a.id === id : (a) => a.name === name;
  if (feed.agents.some(dup)) return;
  feed.agents.push({
    name,
    state: 'busy',
    ts: Date.now(),
    client: CLIENT, // 归属：同一个工程下 Codex 与 CodeBuddy 共用一个清单文件
    ...(task ? { task } : {}),
    ...(id ? { id } : {}),
  });
  writeFeedFile(file, feed);
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
function retireGhost(workspacePath, name, id, result) {
  const file = feedFileFor(workspacePath);
  const feed = readFeedFile(file);
  let hit = id ? feed.agents.findIndex((a) => a.id === id) : -1;
  if (hit < 0) hit = feed.agents.findIndex((a) => a.name === name);
  if (hit < 0) return;
  const cur = feed.agents[hit] || {};
  if (!ownsEntry(cur)) return; // 别动别的客户端的幽灵
  const task = String(cur.task || '').trim();
  // Codex 的 SubagentStop 会带子代理最后那段话，直接当汇报文案（比"已完成：任务名"实在）
  const said = String(result || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const next = feed.agents.slice();
  next[hit] = { ...cur, state: 'idle', result: said || (task ? `已完成：${task}` : '已完成') };
  writeFeedFile(file, { ...feed, agents: next });
}

/**
 * 记一笔"还没收工的召唤"（最多留最近 8 条）。
 * 结束信号（PostToolUse / SubagentStop）的 payload 未必带全 —— PostToolUse 的 tool_input
 * 可能和 PreToolUse 不一样，SubagentStop 更是可能什么都不带 —— 只靠事件本身算出来的
 * 名字会退化成兜底的 'subagent'，删不掉任何东西。所以召唤时把 id / name 记在状态文件里，
 * 收工时回来查。**多槽**（不是"最近一条"）：同名并发时前一只收工不能把后一只的账一起销掉。
 */
function rememberSubagent(file, id, name) {
  const list = (readState(file).subagents || []).filter((r) => r && (r.id || r.name));
  if (id && !list.some((r) => r.id === id)) list.push({ id, name, at: Date.now() });
  else if (!id && name && !list.some((r) => r.name === name)) list.push({ id: '', name, at: Date.now() });
  writeState(file, { subagents: list.slice(-8) });
}

/** 收工：按 id 精确找，找不到再按 name，都找不到就认最早那只（FIFO）。转成待汇报并销账。 */
function finishGhost(file, workspacePath, ev, opts = {}) {
  const list = readState(file).subagents || [];
  const ti = ev && ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : null;
  const nm = ti ? agentName(ti) : '';
  const keys = subagentKeys(ev, nm, ti ? agentTask(ti) : '');
  const aid = agentIdOf(ev);
  // 匹配顺序：agent_id（Codex）> 合成 key（CodeBuddy）> 名字 > 最早那只
  let rec = aid ? list.find((r) => r.id === aid) : null;
  if (!rec && keys.length) rec = list.find((r) => r.id && keys.includes(r.id)) || null;
  if (!rec && nm && nm !== 'subagent') rec = list.find((r) => r.name === nm) || null;
  if (!rec) rec = list[0] || null;
  if (!rec) return;
  retireGhost(workspacePath, rec.name, rec.id, opts.result);
  writeState(file, { subagents: list.filter((r) => r !== rec) });
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
function sweepGhosts(stateFile, workspacePath, opts = {}) {
  // 注意两个路径别搞混：stateFile 是 hook 状态文件（账本在里面），
  // 清单文件要按 workspacePath 现算 —— 混了的话本函数会静默变成空操作。
  const feedFile = feedFileFor(workspacePath);
  const feed = readFeedFile(feedFile);
  // 默认只扫「从没收过工的孤儿」（没有 result）：带 result 的已经进了「待汇报」流程，
  // 由 subagentFeed 播完汇报再回收 —— 连它一起扫会把刚做好的汇报动画掐掉。
  // 会话真的结束了（SessionEnd）才 all:true 全清。
  const doomed = feed.agents.filter((a) => a && a.ts && ownsEntry(a) && (opts.all || !a.result));
  if (!doomed.length) return 0;
  writeFeedFile(feedFile, { ...feed, agents: feed.agents.filter((a) => !doomed.includes(a)) });

  const pool = (readState(stateFile).subagents || []).slice();
  for (const a of doomed) {
    const i = pool.findIndex((r) => r && (a.id ? r.id === a.id : !r.id && r.name === a.name));
    if (i >= 0) pool.splice(i, 1);
  }
  writeState(stateFile, { subagents: pool });
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

function startHeartbeat(member) {
  const file = statePath(member);
  const st = readState(file);
  if (st.hb && st.hb.pid && alive(st.hb.pid)) return; // 已经有一个在跑
  try {
    const child = spawn(process.execPath, [__filename, '--heartbeat', '--member', member], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    writeState(file, { hb: { pid: child.pid, startedAt: Date.now(), lastEventAt: Date.now() } });
  } catch (err) {
    debug('拉起心跳守护失败：', err && err.message);
  }
}

function stopHeartbeat(member) {
  const file = statePath(member);
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
async function runHeartbeat(info, member) {
  const file = statePath(member);
  const startedAt = Date.now();
  const ctx = await resolveCtx(info);
  const body = { project: ctx.project, workspacePath: ctx.workspacePath, memberId: member };
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
  const member = flag(argv, '--member') || process.env.WORKGREMLIN_MEMBER || (IS_CODEX ? 'codex' : 'codebuddy');

  const info = readServerInfo();
  if (!info || !info.port) {
    debug('没有 ~/.workgremlin/server.json，WorkGremlin 没在跑 —— 跳过');
    return;
  }

  if (argv.includes('--heartbeat')) return runHeartbeat(info, member);

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
  trace(event, { member, tool: ev.tool_name, notification_type: ev.notification_type });

  const ctx = await resolveCtx(info);
  const base = { project: ctx.project, workspacePath: ctx.workspacePath };
  const file = statePath(member);
  const cwd = typeof ev.cwd === 'string' ? ev.cwd : '';
  // 状态文件里记下来源客户端：同一个工程可能同时有 Codex 与 CodeBuddy 在跑，
  // 主控制台要按楼层（客户端）取相位，不能谁新鲜就显示谁。
  writeState(file, { client: CLIENT, sessionId: String((ev && ev.session_id) || '') });

  // 心跳守护的"最后活跃时间"（它靠这个判断会话还在不在）
  if (event !== 'SessionEnd') writeState(file, { hb: { ...(readState(file).hb || {}), lastEventAt: Date.now() } });

  const register = () =>
    request(info, HTTP_ROUTES.REGISTER, {
      ...base,
      memberId: member,
      name: member,
      role: process.env.WORKGREMLIN_ROLE || 'agent',
      // 来源客户端：办公室按当前楼层的客户端过滤成员（server 的 members.client）
      client: CLIENT,
    });
  const beat = () => request(info, HTTP_ROUTES.HEARTBEAT, { ...base, memberId: member });
  const status = (state, reason) =>
    request(info, HTTP_ROUTES.STATUS, { ...base, memberId: member, state, ...(reason ? { reason } : {}) });

  // 会话边界的事件才 register（工具前后各 register 一次太吵）；
  // 但中途才装上 hook 的话第一个事件也可能是 SessionStart 之外的，所以 UserPromptSubmit / Stop 也补一次。
  if (event === 'SessionStart') {
    startHeartbeat(member);
    await register();
    await beat();
    await status('idle');
    return;
  }

  if (event === 'UserPromptSubmit') {
    // 新一轮用户输入 = 上一轮已经结束：Task 是阻塞工具，轮次一结束它就不可能在飞了。
    // 结束事件可能丢（实测：打断时 PostToolUse / SubagentStop 都不来），这里兜底扫掉。
    sweepGhosts(file, REAL_WS);
    clearAwait(file); // 新的一轮用户输入：之前挂起的"等授权"作废
    const prompt = String(ev.prompt || '');
    const title = prompt.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || '（未命名任务）';
    await register();
    const started = await request(info, HTTP_ROUTES.TASK_START, { ...base, memberId: member, title });
    // taskTitle（用户原话）无论 TASK_START 成功与否都要落盘：它是"思考中"屏上 / tooltip 里显示的那句话，
    // 不能因为上报失败就留着上一轮的旧标题 —— 否则"思考中"会先显示上一轮内容，等快照刷新才更正。
    const patch = { taskTitle: title, done: null };
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
        memberId: member,
        from: member,
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
      // Codex 有显式的 PermissionRequest 事件，不需要"pending 超时 = 等授权"这套兜底推断；
      // 而且 Codex 的写类工具（apply_patch）经常跑很久，打了 pending 会被误判成"等待授权"。
      const probe = !IS_CODEX && PROBE_TOOLS.has(tool);
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
          trace('ghost-pending', { member, tool, name: nm });
        } else {
          const id = subagentKeys(ev, nm, task)[0] || '';
          rememberSubagent(file, id, nm);
          addGhost(REAL_WS, nm, task, id);
          trace('ghost+', { member, tool, name: nm, id, gen: ev.generation_id || '', agentId: ev.agent_id || '' });
        }
      }
      await status('busy');
    } else {
      const touched = filesOf(ev.tool_input, ev.tool_name).map((x) => relFile(x, cwd)).filter(Boolean);
      if (touched.length) {
        await request(info, HTTP_ROUTES.FILE_TOUCH, { ...base, memberId: member, files: touched, op: opOf(ev.tool_name) });
      }
      // 工具真正跑完了 → 权限已通过，撤掉"等授权"，回到"思考中"
      clearAwait(file);
      writeState(file, { sessionPhase: { phase: 'thinking', ts: Date.now(), workspacePath: REAL_WS } });
      // subagent 收工 → 从清单划掉，小幽灵散掉
      // Codex 的 spawn_agent 返回 ≠ 子代理干完（它的收工只认 SubagentStop）
      if (isSubagentTool(ev.tool_name) && !IS_CODEX) finishGhost(file, REAL_WS, ev);
      // PostToolUse = 工具已跑完，进入"思考中"（处理返回结果），直到下一个事件
      await status('thinking');
    }
    return;
  }

  if (event === 'Notification') {
    if (ev.notification_type === 'idle_prompt') {
      clearAwait(file);
      await status('idle');
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
    sweepGhosts(file, REAL_WS);
    const st = readState(file);
    const taskId = st.taskId;
    const title = st.taskTitle || '';
    // 本轮任务的开始时刻：服务端据此只挑"这一轮改过的文件"做完成概要，
    // 否则会把上一轮的改动也算进来（典型：这一轮只是 push，却显示上一轮改了多少文件）。
    const startedAt = Number(st.taskStartedAt) || 0;
    if (taskId) await request(info, HTTP_ROUTES.TASK_END, { ...base, memberId: member, taskId, state: 'done' });
    // 落"完成"标记：带工程路径 + 任务标题 + 起始时刻，服务端据此（且仅据此）亮"任务完成"概要，
    // 不再靠"相位回落到空闲"来猜，避免中途被其它工程串味误弹。
    // Codex 的 Stop 带 last_assistant_message（收尾自述）——落进完成标记，主控制台拿它当摘要；
    // CodeBuddy 没有这个字段，said 为空，仍然走"本轮改动文件"那套。
    const said = String((ev && ev.last_assistant_message) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    writeState(file, {
      taskId: null,
      taskWorkspacePath: '',
      taskStartedAt: 0,
      done: { at: Date.now(), title, workspacePath: REAL_WS, startedAt, said, sessionId: String((ev && ev.session_id) || '') },
    });
    await beat();
    await status('idle');
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
    addGhost(REAL_WS, name, (pend && pend.task) || '', id);
    writeState(file, { pendingSpawn: null });
    trace('ghost+', { member, tool: 'SubagentStart', name, id, agentType: type });
    await beat();
    return;
  }

  // 打断（ESC / 停止）：这一轮飞出去的召唤不可能还活着 —— 只收孤儿，不碰主会话的任务与相位。
  if (event === 'Interrupt') {
    sweepGhosts(file, REAL_WS);
    await beat();
    return;
  }

  // SubagentStop：subagent 收工 —— **只收幽灵**，绝不碰主会话的任务 / 相位
  // （子代理收工 ≠ 主会话收工，所以不能像 Stop 那样结束任务，否则会误报"任务完成"）。
  // Codex 的这条事件还带 last_assistant_message，直接拿来当汇报文案。
  if (event === 'SubagentStop') {
    finishGhost(file, REAL_WS, ev, { result: ev.last_assistant_message });
    await beat();
    return;
  }

  if (event === 'SessionEnd') {
    // 注意：这里不能调 clearAwait() —— 它会把 done 一起清掉，而 done 是"上一轮任务完成"的标记，
    // 会话结束后办公室可能还停在这条会话上（尤其 codex exec 这种一次一进程的短会话），
    // 清掉就永远看不到「任务完成」摘要了。所以只清"当前进行中"的那几项。
    writeState(file, { await: null, pending: null, sessionPhase: null });
    stopHeartbeat(member);
    // 兜底：会话都结束了，它召唤出去的幽灵不该还飘着（手工 scripts/subagents.js
    // 写的那些没有 ts，不动它们）。
    sweepGhosts(file, REAL_WS, { all: true });
    writeState(file, { taskId: null, taskWorkspacePath: '', taskStartedAt: 0, subagents: [] });
    await status('offline');
  }
}

main().catch((err) => {
  debug('异常（忽略）：', err && err.message);
  process.exit(0); // hook 失败绝不能把 agent 卡住
});
