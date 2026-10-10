#!/usr/bin/env node
'use strict';

/**
 * 各受监控产品的 hook 入口（codebuddy / codex / workbuddy / trae / claude / qoder …）。
 *
 * 2026-10 重构：hook 退化成「只读 stdin 事件 → POST /api/v1/hook → 退出」的纯转发器。
 * 所有落盘解析 / 会话状态 / 台账写入 / token 读取 / 子代理幽灵 全部在服务端完成
 * （server/src/ingest/hookCommon.js）—— 服务端是本地进程，与 CLI 同机同文件系统，本就读得到 agent 的落盘。
 *
 * 由 scripts/install-hooks.js 写进各家的 settings.json，形如：
 *   { "hooks": { "SessionStart": [ { "matcher": "", "hooks": [
 *       { "type": "command", "command": "node /abs/packages/reporter/src/hook.js --agent codex", "timeout": 10 } ] } ] } }
 *
 * 三条纪律（与重构前一致）：
 *   1) 服务没起 / 拿不到上下文 / 上报失败 —— 一律静默退出 0，绝不阻塞 agent；
 *   2) stdout 一个字都不写（调试走 stderr + WORKGREMLIN_HOOK_DEBUG=1）；
 *   3) 失败时吞掉异常，process.exit(0)，agent 不能被 hook 卡住。
 *
 * 用法：node hook.js --agent <name>
 * 环境变量：WORKGREMLIN_DISABLE=1 直接跳过；WORKGREMLIN_HOOK_DEBUG=1 打 stderr 诊断。
 */

const fs = require('node:fs');
const path = require('node:path');

// 只取 readServerInfo（探测本地 server 的 port / token，转发 POST 要用）；其余路由常量由服务端持有。
const { readServerInfo } = require('./index');
const { home } = require('@workgremlin/shared');

const REQ_TIMEOUT_MS = 2_000;
const STDIN_TIMEOUT_MS = 1_500;

const DEBUG = process.env.WORKGREMLIN_HOOK_DEBUG === '1';
const debug = (...args) => { if (DEBUG) console.error('[workgremlin-hook]', ...args); };

/** 追加式事件时间线（诊断用），写到 ~/.workgremlin/hooks/events.log */
function trace(event, extra) {
  try {
    const line = `${new Date().toISOString()} ${event}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
    fs.appendFileSync(path.join(home(), 'hooks', 'events.log'), line);
  } catch {
    /* 落盘失败不影响 hook */
  }
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || '' : '';
}

/** 读 stdin 全部内容（带超时兜底，绝不阻塞 agent） */
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

/** 转发到本地 server（复用 Bearer 令牌）。body 非空即 POST，否则 GET。 */
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

async function main() {
  // 议事厅参与者不上报（见 server/src/council/agents.js 的 QUIET_ENV）：在读 stdin / 连服务端前就退。
  // 必须在最前面：hook 是被各家 CLI 同步等着的，早退一步参与者就少等一步。
  if (process.env.WORKGREMLIN_DISABLE === '1') return;

  const argv = process.argv.slice(2);
  // 主 agent 身份：安装器在命令里用 --agent 注入，必填；缺了直接报错退出。
  const AGENT = flag(argv, '--agent');
  if (!AGENT) {
    console.error('[workgremlin-hook] 缺少必需参数 --agent（主 agent 名字，如 codebuddy / codex / workbuddy / trae / claude / qoder）');
    process.exit(1);
  }

  const info = readServerInfo();
  if (!info || !info.port) {
    debug('没有 ~/.workgremlin/server.json，WorkGremlin 没在跑 —— 跳过');
    return;
  }

  const raw = await readStdin();
  let ev = null;
  try {
    ev = JSON.parse(raw);
    if (!ev || !ev.hook_event_name) return;
  } catch {
    debug('stdin 不是 JSON —— 跳过');
    return;
  }
  const event = ev.hook_event_name;
  /**
   * 本事件来自哪个客户端（vscode / null / cli …）。
   * 与 hookCommon 的 form 计算，按 client 是否含 vscode/extension/jetbrains/plugin 识别）。
   */
  const client = ev.client ? String(ev.client).trim() : '';
  const cwd = typeof ev.cwd === 'string' ? ev.cwd : '';

  trace(event, { client, agent: AGENT, tool: ev.tool_name, notification_type: ev.notification_type });

  // 纯转发：落盘解析 / 会话状态 / 台账 / token / 子代理幽灵 全在服务端做（server/src/ingest/hookCommon.js）。
  // 把 agent / client / workspacePath 一并带上，服务端据此路由到对应楼层并归工程。
  await request(info, '/api/v1/hook', { ...ev, agent: AGENT, client, workspacePath: cwd });
}

main().catch((err) => {
  debug('异常（忽略）：', err && err.message);
  process.exit(0); // hook 失败绝不能把 agent 卡住
});
