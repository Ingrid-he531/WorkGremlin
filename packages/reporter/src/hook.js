#!/usr/bin/env node
'use strict';

/**
 * Hook entry point for the monitored products (codebuddy / codex / trae / claude / qoder …).
 *
 * Refactor 2026-10: the hook became a pure forwarder — "read a stdin event → POST /api/v1/hook → exit".
 * All on-disk parsing / session state / ledger writes / token reading / subagent ghosts happen on the
 * server (server/src/ingest/hookCommon.js) — the server is a local process on the same machine and
 * filesystem as the CLI, so it can read the agent's on-disk data anyway.
 *
 * Written into each product's settings.json by scripts/install-hooks.js, like:
 *   { "hooks": { "SessionStart": [ { "matcher": "", "hooks": [
 *       { "type": "command", "command": "node /abs/packages/reporter/src/hook.js --agent codex", "timeout": 10 } ] } ] } }
 *
 * Three disciplines (same as before the refactor):
 *   1) server not running / no context / report failed — always exit 0 silently, never block the agent;
 *   2) write not a single byte to stdout (debugging goes to stderr with WORKGREMLIN_HOOK_DEBUG=1);
 *   3) swallow exceptions on failure and process.exit(0); the agent must not be held up by the hook.
 *
 * Usage: node hook.js --agent <name>
 * Env: WORKGREMLIN_DISABLE=1 skips entirely; WORKGREMLIN_HOOK_DEBUG=1 prints stderr diagnostics.
 */

const fs = require('node:fs');
const path = require('node:path');

// Only readServerInfo is needed (to find the local server's port / token for the forwarding POST);
// the route constants are owned by the server.
const { readServerInfo } = require('./index');
const { home } = require('@workgremlin/shared');

const REQ_TIMEOUT_MS = 2_000;
const STDIN_TIMEOUT_MS = 1_500;
const HOOK_ENV_KEYS = ['CODEX_INTERNAL_ORIGINATOR_OVERRIDE'];

const DEBUG = process.env.WORKGREMLIN_HOOK_DEBUG === '1';
const debug = (...args) => { if (DEBUG) console.error('[workgremlin-hook]', ...args); };

/** Append-only event timeline (for diagnostics), written to ~/.workgremlin/hooks/events.log */
function trace(event, extra) {
  try {
    const line = `${new Date().toISOString()} ${event}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
    fs.appendFileSync(path.join(home(), 'hooks', 'events.log'), line);
  } catch {
    /* a failed write must not affect the hook */
  }
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || '' : '';
}

/** Snapshot only host-process signals that a floor is allowed to interpret. */
function hookEnv() {
  const out = {};
  for (const key of HOOK_ENV_KEYS) {
    const value = process.env[key];
    if (value != null && value !== '') out[key] = value;
  }
  return out;
}

/** Read all of stdin (with a timeout fallback; never block the agent) */
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

/** Forward to the local server (reusing the Bearer token). A non-empty body means POST, otherwise GET. */
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
  // Council participants are not reported (see server/src/council/agents.js QUIET_ENV): exit before
  // reading stdin / connecting to the server. Must be first — the hook is awaited synchronously by each
  // CLI, so returning a step earlier saves the participant a step.
  if (process.env.WORKGREMLIN_DISABLE === '1') return;

  const argv = process.argv.slice(2);
  // Main agent identity: the installer injects it via --agent; required, error out if missing.
  const agent = flag(argv, '--agent');
  if (!agent) {
    console.error('[workgremlin-hook] 缺少必需参数 --agent（主 agent 名字，如 codebuddy / codex / trae / claude / qoder）');
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
  const env = hookEnv();
  trace(ev.hook_event_name, { agent: ev.agent || agent, client: ev.client, hookEnv: env, session: ev.session_id, tool: ev.tool_name, notification_type: ev.notification_type });

  const cwd = typeof ev.cwd === 'string' ? ev.cwd : '';
  // Pure forwarding: on-disk parsing / session state / ledger / tokens / subagent ghosts all happen on
  // the server (server/src/ingest/hookCommon.js). The allowlisted host environment is raw evidence;
  // the routed floor, not this forwarder, decides what it means.
  await request(info, '/api/v1/hook', { ...ev, hookEnv: env, agent, workspacePath: cwd });
}

main().catch((err) => {
  debug('异常（忽略）：', err && err.message);
  process.exit(0); // a failed hook must never hold up the agent
});
