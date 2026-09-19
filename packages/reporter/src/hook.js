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
 *   PreToolUse        busy（顺带心跳）；工具是 Agent → 飘出一只小幽灵
 *   PostToolUse       写/改类工具 → file/touch，并 busy；工具是 Agent → 小幽灵散掉
 *   Notification      等权限 → blocked(reason=awaiting_permission)；空闲提醒 → idle
 *   Stop              task/end(done) + idle
 *   SessionEnd        offline + 撤掉心跳守护
 *
 * 三条纪律：
 *   1) 服务没起 / 拿不到上下文 / 上报失败 —— 一律静默退出 0，**绝不阻塞 agent**；
 *   2) stdout 可能被当作上下文塞回给 agent，**一个字都不往 stdout 写**（调试走 stderr + WORKGREMLIN_HOOK_DEBUG=1）；
 *   3) 心跳 60s 一断就 degraded（shared DEFAULTS.HEARTBEAT_TIMEOUT_MS），
 *      所以 SessionStart 会另起一个守护进程按 15s 心跳，免得 agent 一思考就灰。
 *
 * 环境变量：
 *   WORKGREMLIN_TEAM        team 名（缺省用服务端"当前打开的工程"那个 team）
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
 * 上报到哪个 team：环境变量 > 服务端"当前打开的工程" > 回落 workgremlin。
 * 顺带把 workspacePath 也带回来 —— register 会 upsert team，
 * 用服务端现有的值回写，才不会把"打开工程"记的工程目录改掉。
 * @param {{port: number, token?: string}} info
 */
async function resolveCtx(info) {
  const fallback = { team: 'workgremlin', workspacePath: '' };
  const cur = await request(info, WORKSPACE_ROUTE, null);
  const team = String(process.env.WORKGREMLIN_TEAM || '').trim() || (cur && cur.team) || fallback.team;
  return { team, workspacePath: (cur && cur.workspacePath) || fallback.workspacePath };
}

/** 工具输入里的文件路径（CLI 风格 file_path / IDE 风格 filePath 都认） */
function fileOf(input) {
  if (!input || typeof input !== 'object') return '';
  const p = input.file_path || input.filePath || input.path || input.notebook_path || input.target_file || '';
  return typeof p === 'string' ? p : '';
}

/** 编辑类算 edit，其余写类算 write（server 侧只分 read / write 之外的 op） */
function opOf(tool) {
  return /^(Edit|MultiEdit|NotebookEdit|replace_in_file)$/.test(String(tool || '')) ? 'edit' : 'write';
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

/** Agent 工具输入的"名字"：优先 description（UI 上那行短描述），回退 subagent_type / name */
function agentName(input) {
  if (!input || typeof input !== 'object') return 'subagent';
  const d = input.description || input.subagent_type || input.name || '';
  return String(d).trim() || 'subagent';
}

/** Agent 工具输入的"在干嘛"：取 prompt 前 80 字 */
function agentTask(input) {
  if (!input || typeof input !== 'object') return '';
  const p = input.prompt || '';
  return String(p).replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** 主 Agent 召唤 subagent → 加一只小幽灵（同名已在飘就跳过，避免并发同名合并后误删） */
function addGhost(workspacePath, name, task) {
  const file = feedFileFor(workspacePath);
  const feed = readFeedFile(file);
  if (feed.agents.some((a) => a.name === name)) return;
  feed.agents.push({ name, state: 'busy', ...(task ? { task } : {}) });
  writeFeedFile(file, feed);
}

/** subagent 收工 → 划掉，幽灵散掉 */
function removeGhost(workspacePath, name) {
  const file = feedFileFor(workspacePath);
  const feed = readFeedFile(file);
  const next = feed.agents.filter((a) => a.name !== name);
  if (next.length !== feed.agents.length) writeFeedFile(file, { ...feed, agents: next });
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
  const body = { team: ctx.team, workspacePath: ctx.workspacePath, memberId: member };
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
  const member = flag(argv, '--member') || process.env.WORKGREMLIN_MEMBER || 'codebuddy';

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
  const base = { team: ctx.team, workspacePath: ctx.workspacePath };
  const file = statePath(member);
  const cwd = typeof ev.cwd === 'string' ? ev.cwd : '';

  // 心跳守护的"最后活跃时间"（它靠这个判断会话还在不在）
  if (event !== 'SessionEnd') writeState(file, { hb: { ...(readState(file).hb || {}), lastEventAt: Date.now() } });

  const register = () =>
    request(info, HTTP_ROUTES.REGISTER, {
      ...base,
      memberId: member,
      name: member,
      role: process.env.WORKGREMLIN_ROLE || 'agent',
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
    clearAwait(file); // 新的一轮用户输入：之前挂起的"等授权"作废
    const prompt = String(ev.prompt || '');
    const title = prompt.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || '（未命名任务）';
    await register();
    const started = await request(info, HTTP_ROUTES.TASK_START, { ...base, memberId: member, title });
    if (started && started.taskId) writeState(file, { taskId: started.taskId, taskWorkspacePath: REAL_WS, taskStartedAt: Date.now(), taskTitle: title, done: null });
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
      const f = relFile(fileOf(ev.tool_input), cwd);
      const input = ev.tool_input || {};
      // 给 tips 用的"实际调用"：Bash/命令类用 command，Grep 类用 pattern+路径，读改写类用"工具 文件"
      const desc =
        input.command || input.cmd
          ? `${tool} ${input.command || input.cmd}`
          : input.pattern || input.regex || input.query
            ? `${tool} ${input.pattern || input.regex || input.query}${f ? ' ' + f : ''}`
            : f ? `${tool} ${f}` : tool;
      // pending 只给"会发 PostToolUse、且可能要权限"的写类工具打。
      // 本环境实测 Read/Grep/Glob/ReadLints/Bash 等只读 / 命令类工具根本不发 PostToolUse，
      // 一旦给它们打 pending，PostToolUse 永远不来、清不掉 → 兜底误判成"等待授权"
      // （典型误报：读文件却显示「等待授权」、点了 run 还在「等待授权」）。
      const probe = PROBE_TOOLS.has(tool);
      writeState(file, {
        lastTool: tool,
        lastInput: ev.tool_input || '',
        pending: probe
          ? { tool, file: f, cmd: desc, at: Date.now(), workspacePath: REAL_WS }
          : null, // 非写类：显式清掉上一支可能残留的 pending
        // 工具开始跑 → 主控制台相位「调用工具」（PreToolUse..PostToolUse 这段就是"在调工具"）
        sessionPhase: { phase: 'tool', tool, file: f, cmd: desc, ts: Date.now(), workspacePath: REAL_WS },
      });
      // 主 Agent 召唤 subagent（Agent 工具）→ 往清单写一条，办公室飘出一只小幽灵
      if (tool === 'Agent') addGhost(ctx.workspacePath, agentName(ev.tool_input), agentTask(ev.tool_input));
      await status('busy');
    } else {
      const f = relFile(fileOf(ev.tool_input), cwd);
      if (f) await request(info, HTTP_ROUTES.FILE_TOUCH, { ...base, memberId: member, files: [f], op: opOf(ev.tool_name) });
      // 工具真正跑完了 → 权限已通过，撤掉"等授权"，回到"思考中"
      clearAwait(file);
      writeState(file, { sessionPhase: { phase: 'thinking', ts: Date.now(), workspacePath: REAL_WS } });
      // subagent 收工 → 从清单划掉，小幽灵散掉
      if (ev.tool_name === 'Agent') removeGhost(ctx.workspacePath, agentName(ev.tool_input));
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
    const st = readState(file);
    const taskId = st.taskId;
    const title = st.taskTitle || '';
    if (taskId) await request(info, HTTP_ROUTES.TASK_END, { ...base, memberId: member, taskId, state: 'done' });
    // 落"完成"标记：带工程路径 + 任务标题，服务端据此（且仅据此）亮"任务完成"概要，
    // 不再靠"相位回落到空闲"来猜，避免中途被其它工程串味误弹。
    writeState(file, { taskId: null, taskWorkspacePath: '', taskStartedAt: 0, done: { at: Date.now(), title, workspacePath: REAL_WS } });
    await beat();
    await status('idle');
    return;
  }

  // SubagentStop 不接：子代理收工不等于主会话收工，结束主任务会误报。
  if (event === 'SessionEnd') {
    clearAwait(file);
    stopHeartbeat(member);
    writeState(file, { taskId: null, taskWorkspacePath: '', taskStartedAt: 0 });
    await status('offline');
  }
}

main().catch((err) => {
  debug('异常（忽略）：', err && err.message);
  process.exit(0); // hook 失败绝不能把 agent 卡住
});
