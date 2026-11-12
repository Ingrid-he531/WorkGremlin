/**
 * WorkGremlin reporter for DeepSeek Harness (dsh).
 *
 * DSH is a Cordis-based harness: every session is a durable event log, and the
 * plugin API exposes `session/created`, `session/event`, and `session/disposed`.
 * This plugin translates those events into WorkGremlin's hook-event vocabulary
 * and forwards them to the local server (`~/.workgremlin/server.json`), so the
 * 10F floor gets **reported truth** instead of a polled inference:
 *
 *   DSH event                         WorkGremlin hook event
 *   --------------------------------  -------------------------------
 *   session/created                   SessionStart
 *   user/message (source.kind=user)   UserPromptSubmit
 *   tool/call                         PreToolUse
 *   tool/result                       PostToolUse
 *   approval/asked                    PermissionRequest
 *   approval/decided                  PermissionResolved
 *   turn/end                          Stop (reason + token usage)
 *   session/disposed                  SessionEnd
 *   subagent/end                      SubagentStop
 *
 * What DSH gives us that polling cannot:
 *   - `approval/asked` is a real event, so "awaiting permission" is not a guess;
 *   - `turn/end.reason` distinguishes completed / aborted / error, so a cancelled
 *     task is not silently marked done;
 *   - `assistant/message.usage` carries per-step token accounting;
 *   - `tool/call.arguments` and `tool/result.message.content` carry the exact
 *     tool input and output, so changed files and tool names match the harness.
 *
 * The plugin is deliberately self-contained: it is copied into `$DSH_HOME` by
 * `scripts/install-hooks.js` and loaded through the home-level Cordis patch, so
 * it must not depend on this repository being on the module path. Every network
 * failure is silent — a reporter must never hold up the agent.
 *
 * Install: `node scripts/install-hooks.js --targets=dsh-plugin`
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

export const name = 'workgremlin-dsh-reporter';
export const inject = [];

const CLIENT = 'dsh';
const REQUEST_TIMEOUT_MS = 2_000;
const SERVER_INFO_TTL_MS = 5_000;

/** The plugin entry: wire DSH's lifecycle events to the reporter. */
export function apply(ctx) {
  const reporter = new DshReporter({ post: createPoster() });
  ctx.on('session/created', (session) => reporter.sessionCreated(session));
  ctx.on('session/event', (session, event) => reporter.sessionEvent(session, event));
  ctx.on('session/disposed', (session) => reporter.sessionDisposed(session));
  ctx.on('subagent/end', (info) => reporter.subagentEnd(info));
  ctx.effect(() => () => reporter.close());
}

/**
 * Pure event mapper. Exported separately so the mapping can be tested without
 * booting DSH or a WorkGremlin server.
 */
export class DshReporter {
  /**
   * @param {{post?: (payload: object) => void, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.post = typeof options.post === 'function' ? options.post : () => {};
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    /** sessionId -> session state */
    this.sessions = new Map();
    /** The most recently active main session (fallback for subagent attribution). */
    this.active = '';
    /** In-flight HTTP posts; close() drains them so a headless process can exit cleanly. */
    this.pending = new Set();
    this.closed = false;
  }

  /** Remember a new DSH session and report the main ones. */
  sessionCreated(session) {
    const info = this._info(session);
    if (!info || info.subagent) return;
    this.active = info.id;
    this._send(info, 'SessionStart', { source: 'startup' });
  }

  /** Translate one durable session event into zero or more hook events. */
  sessionEvent(session, event) {
    const info = this._info(session);
    if (!info || info.subagent || !event || typeof event.type !== 'string') return;
    const data = event.data && typeof event.data === 'object' ? event.data : {};

    switch (event.type) {
      case 'session/title':
        if (data.title) info.title = String(data.title);
        return;
      case 'model/selection':
        info.model = modelRef(data);
        return;
      case 'working-directory/change':
        if (data.cwd) info.cwd = String(data.cwd);
        return;
      case 'turn/start':
        info.turn = Number(data.turn) || 0;
        info.tokens = emptyTokens();
        info.replies = [];
        info.tools.clear();
        info.promptSent = false;
        this.active = info.id;
        return;
      case 'user/message': {
        // Synthetic context injected by the harness is not the user's task.
        const source = data.source && typeof data.source === 'object' ? data.source : {};
        if (String(source.kind || '') !== 'user' || info.promptSent) return;
        const prompt = textOf(data.content);
        if (!prompt) return;
        info.promptSent = true;
        info.prompt = prompt;
        this._send(info, 'UserPromptSubmit', { prompt });
        return;
      }
      case 'tool/call': {
        const callId = String(data.callId || '');
        const tool = String(data.name || 'tool');
        const input = parseArguments(data.arguments);
        if (callId) info.tools.set(callId, { name: tool, input });
        this._send(info, 'PreToolUse', {
          tool_name: tool,
          tool_input: input,
          ...(callId ? { tool_use_id: callId } : {}),
        });
        return;
      }
      case 'tool/result': {
        const message = data.message && typeof data.message === 'object' ? data.message : {};
        const callId = String(message.toolCallId || '');
        const tool = info.tools.get(callId) || { name: 'tool', input: {} };
        const response = textOf(message.content);
        this._send(info, 'PostToolUse', {
          tool_name: tool.name,
          tool_input: tool.input,
          tool_response: response,
          ...(callId ? { tool_use_id: callId } : {}),
        });
        if (callId) info.tools.delete(callId);
        return;
      }
      case 'approval/asked': {
        const toolName = String(data.toolName || 'tool');
        const callId = String(data.callId || '');
        const tool = info.tools.get(callId) || { name: toolName, input: {} };
        this._send(info, 'PermissionRequest', {
          tool_name: toolName || tool.name,
          tool_input: tool.input,
          ...(data.reason ? { reason: String(data.reason) } : {}),
          ...(callId ? { tool_use_id: callId } : {}),
        });
        return;
      }
      case 'approval/decided': {
        // A dedicated event: the tool has not necessarily produced PostToolUse
        // yet, and DSH's approval outcome is the only truthful "no longer
        // blocked" signal. The server clears the wait on it.
        this._send(info, 'PermissionResolved', {
          ...(data.outcome ? { outcome: String(data.outcome) } : {}),
        });
        return;
      }
      case 'assistant/message': {
        const message = data.message && typeof data.message === 'object' ? data.message : {};
        const text = textOf(message.content);
        if (text) {
          info.replies.push({ id: String(message.id || `dsh-${this.now()}`), text });
          if (info.replies.length > 50) info.replies.splice(0, info.replies.length - 50);
        }
        if (data.usage && typeof data.usage === 'object') addUsage(info.tokens, data.usage);
        return;
      }
      case 'turn/end': {
        const reason =
          typeof data.reason === 'string'
            ? data.reason
            : data.reason && typeof data.reason === 'object'
              ? String(data.reason.kind || '')
              : '';
        const last = info.replies.length ? info.replies[info.replies.length - 1].text : '';
        const tokens = tokenFinish(info.tokens);
        this._send(info, 'Stop', {
          stop_reason: stopReason(reason),
          ...(last ? { last_assistant_message: last } : {}),
          ...(tokens ? { tokens } : {}),
        });
        info.promptSent = false;
        info.replies = [];
        info.tokens = emptyTokens();
        info.tools.clear();
        return;
      }
      default:
        // Every other DSH event is deliberately ignored: the ledger only needs
        // the turn/tool/permission/usage facts above.
        return;
    }
  }

  /** A main session ended; report it so the dropdown/ledger can close it. */
  sessionDisposed(session) {
    const info = this._info(session);
    if (!info || info.subagent) return;
    this._send(info, 'SessionEnd', {});
  }

  /**
   * DSH's subagent end carries the child session id and its final output. The
   * child's header names its parent, which is the session WorkGremlin must
   * attach the ghost to.
   */
  subagentEnd(run) {
    const child = run && run.id ? this.sessions.get(String(run.id)) : null;
    const parent = (child && child.parent) || this.active;
    if (!parent) return;
    const info = this.sessions.get(parent);
    if (!info) return;
    const text = textOf(run && run.lastAssistantMessage);
    this._send(info, 'SubagentStop', {
      agent_id: String((run && run.id) || ''),
      agent_type: 'general-purpose',
      stop_hook_active: false,
      ...(text ? { last_assistant_message: text } : {}),
    });
  }

  close() {
    this.closed = true;
    this.sessions.clear();
    // Best-effort delivery: the headless profile disposes the tree immediately
    // before exiting, so wait for any report already on the wire.
    return Promise.allSettled([...this.pending]).then(() => undefined);
  }

  /* ------------------------------ internals ------------------------------ */

  _info(session) {
    const header = session && session.header && typeof session.header === 'object' ? session.header : {};
    const id = String((session && session.id) || header.id || '');
    if (!id) return null;
    let info = this.sessions.get(id);
    if (!info) {
      info = {
        id,
        cwd: String(header.cwd || ''),
        parent: String(header.parentSession || ''),
        subagent: String(header.origin || '') === 'subagent',
        title: '',
        model: '',
        turn: 0,
        prompt: '',
        promptSent: false,
        tokens: emptyTokens(),
        replies: [],
        /** callId -> { name, input } */
        tools: new Map(),
      };
      this.sessions.set(id, info);
    }
    return info;
  }

  _send(info, event, extra) {
    if (this.closed || !info) return;
    const payload = {
      agent: CLIENT,
      hook_event_name: event,
      session_id: info.id,
      cwd: info.cwd,
      workspacePath: info.cwd,
      ...(info.model ? { model: info.model } : {}),
      ...(info.title ? { session_title: info.title } : {}),
      ...extra,
    };
    try {
      const result = this.post(payload);
      if (result && typeof result.then === 'function') {
        this.pending.add(result);
        result.finally(() => this.pending.delete(result)).catch(() => {});
      }
    } catch {
      /* a failed report must never affect the agent */
    }
  }
}

/** Latest-first cache of local server connection details. */
let serverInfo = { at: 0, value: null };

/** Read `~/.workgremlin/server.json`; returns null when no server is running. */
function readServerInfo() {
  const now = Date.now();
  if (now - serverInfo.at < SERVER_INFO_TTL_MS) return serverInfo.value;
  serverInfo = { at: now, value: null };
  try {
    const home = process.env.WORKGREMLIN_HOME || path.join(os.homedir(), '.workgremlin');
    const info = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8'));
    if (!info || !Number.isInteger(info.port) || info.port <= 0) return null;
    serverInfo.value = info;
    return info;
  } catch {
    return null;
  }
}

/** Fire-and-forget POST to the local WorkGremlin server. Returns a promise for close() to drain. */
function createPoster() {
  return (payload) => {
    if (process.env.WORKGREMLIN_DISABLE === '1') return Promise.resolve();
    const info = readServerInfo();
    if (!info) return Promise.resolve();
    const body = JSON.stringify(payload);
    const secure = String(info.protocol || '').toLowerCase() === 'https';
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      let req;
      try {
        req = (secure ? https : http).request(
          {
            hostname: '127.0.0.1',
            port: info.port,
            path: '/api/v1/hook',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
              ...(info.token ? { authorization: `Bearer ${info.token}` } : {}),
            },
            // The server's certificate is self-signed for loopback; scope the
            // exception to this request instead of disabling TLS process-wide.
            rejectUnauthorized: false,
          },
          (res) => {
            // Drain the body so the socket can be reused/closed; the result is
            // not needed by the reporter.
            res.on('end', finish);
            res.on('error', finish);
            res.on('close', finish);
            res.resume();
          }
        );
      } catch {
        finish();
        return;
      }
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        try {
          req.destroy();
        } catch {
          /* already gone */
        }
        finish();
      });
      req.on('error', finish);
      try {
        req.end(body);
      } catch {
        finish();
      }
    });
  };
}

/* ------------------------------ helpers ------------------------------ */

function modelRef(data) {
  const model = String((data && data.model) || '').trim();
  const provider = String((data && data.provider) || '').trim();
  if (provider && model) return `${provider}/${model}`;
  return model;
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** DSH's TokenUsage counts are already disjoint, matching WorkGremlin's shape. */
function addUsage(acc, usage) {
  acc.input += num(usage.inputTokens);
  acc.output += num(usage.outputTokens);
  acc.cacheRead += num(usage.cacheReadTokens);
  acc.cacheWrite += num(usage.cacheWriteTokens);
}

function tokenFinish(tokens) {
  if (!tokens) return null;
  if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite <= 0) return null;
  return { ...tokens };
}

function stopReason(reason) {
  if (reason === 'aborted' || reason === 'interrupted' || reason === 'blocked') return 'cancelled';
  if (reason === 'error') return 'failed';
  return 'completed';
}

function parseArguments(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : { input: parsed };
  } catch {
    return { command: String(raw) };
  }
}

/** Flatten DSH content blocks to the text WorkGremlin stores/display. */
function textOf(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}
