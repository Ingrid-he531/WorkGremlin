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
 *   UserPromptSubmit  task/start（标题 = 用户那句话的前 80 字）+ busy
 *   PreToolUse        busy（顺带心跳）
 *   PostToolUse       写/改类工具 → file/touch，并 busy
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

/** 每个工位一份：当前任务 id + 心跳守护的 pid */
function statePath(member) {
  return path.join(home(), 'hooks', `${String(member).replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
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

/** 工程内的文件记相对路径，工程外的记绝对路径（不猜、不编造） */
function relFile(file, cwd) {
  if (!file) return '';
  const abs = path.resolve(file);
  if (cwd && (abs === cwd || abs.startsWith(cwd + path.sep))) return path.relative(cwd, abs);
  return abs;
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

  const ctx = await resolveCtx(info);
  const base = { team: ctx.team, workspacePath: ctx.workspacePath };
  const file = statePath(member);
  const cwd = typeof ev.cwd === 'string' ? ev.cwd : '';
  const isBusyEvent = event === 'PreToolUse' || event === 'PostToolUse';

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
    const prompt = String(ev.prompt || '');
    const title = prompt.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || '（未命名任务）';
    await register();
    const started = await request(info, HTTP_ROUTES.TASK_START, { ...base, memberId: member, title });
    if (started && started.taskId) writeState(file, { taskId: started.taskId });
    await status('busy');
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

  if (isBusyEvent) {
    await beat();
    if (event === 'PostToolUse') {
      const f = relFile(fileOf(ev.tool_input), cwd);
      if (f) await request(info, HTTP_ROUTES.FILE_TOUCH, { ...base, memberId: member, files: [f], op: opOf(ev.tool_name) });
    }
    await status('busy');
    return;
  }

  if (event === 'Notification') {
    if (ev.notification_type === 'idle_prompt') await status('idle');
    else await status('blocked', 'awaiting_permission');
    return;
  }

  if (event === 'Stop') {
    const taskId = readState(file).taskId;
    if (taskId) await request(info, HTTP_ROUTES.TASK_END, { ...base, memberId: member, taskId, state: 'done' });
    writeState(file, { taskId: null });
    await beat();
    await status('idle');
    return;
  }

  // SubagentStop 不接：子代理收工不等于主会话收工，结束主任务会误报。
  if (event === 'SessionEnd') {
    stopHeartbeat(member);
    await status('offline');
  }
}

main().catch((err) => {
  debug('异常（忽略）：', err && err.message);
  process.exit(0); // hook 失败绝不能把 agent 卡住
});
