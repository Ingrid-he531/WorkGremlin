'use strict';

/**
 * WebSocket 集线器：连接管理、订阅过滤、事件广播。
 *
 * 客户端首帧必须是 {type:'hello', token, team, filters}；也可以在 URL 上带 ?token=。
 * 服务端推送统一走 envelope（见 shared/index.js）。
 */

const { WebSocketServer } = require('ws');
const { PROTOCOL_VERSION, WS_EVENTS, CLIENT_EVENTS, DEFAULTS, envelope } = require('@workgremlin/shared');

/**
 * @param {{server: import('node:http').Server, token: string, bus: any, repo: any}} ctx
 */
function createHub({ server, token, bus, repo }) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });
  /** @type {Set<{ws: any, team: string|null, filters: any, authed: boolean}>} */
  const clients = new Set();

  function send(conn, type, payload) {
    if (conn.ws.readyState !== 1) return;
    try {
      conn.ws.send(JSON.stringify(envelope(type, conn.team || '', 'server', payload)));
    } catch {
      /* ignore */
    }
  }

  function matchesFilters(conn, msg) {
    const f = conn.filters || {};
    if (f.members && f.members.length) {
      if (!f.members.includes(msg.fromMember) && !f.members.includes(msg.toMember)) return false;
    }
    if (f.types && f.types.length && !f.types.includes(msg.type)) return false;
    if (Number.isFinite(f.since) && msg.tsMs < f.since) return false;
    if (Number.isFinite(f.until) && msg.tsMs > f.until) return false;
    if (f.keyword) {
      const kw = String(f.keyword).toLowerCase();
      const hay = `${msg.content || ''} ${msg.subject || ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/ws', 'http://127.0.0.1');
    const queryToken = url.searchParams.get('token');
    const conn = {
      ws,
      team: url.searchParams.get('team') || null,
      filters: {},
      authed: !token || queryToken === token,
    };
    clients.add(conn);

    send(conn, WS_EVENTS.CONNECTION, { state: 'open', source: 'ws', protocol: PROTOCOL_VERSION });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send(conn, WS_EVENTS.ERROR, { code: 'bad_payload', message: 'invalid JSON' });
      }

      if (!conn.authed) {
        if (msg.type !== CLIENT_EVENTS.HELLO || msg.token !== token) {
          send(conn, WS_EVENTS.ERROR, { code: 'bad_token', message: 'token mismatch' });
          return ws.close(4001, 'bad token');
        }
        conn.authed = true;
      }

      switch (msg.type) {
        case CLIENT_EVENTS.HELLO:
          conn.team = msg.team || conn.team;
          conn.filters = msg.filters || conn.filters;
          if (conn.team) send(conn, WS_EVENTS.SNAPSHOT, bus.buildSnapshot(conn.team));
          break;
        case CLIENT_EVENTS.SUBSCRIBE:
          conn.filters = msg.filters || {};
          if (msg.team) conn.team = msg.team;
          send(conn, WS_EVENTS.SNAPSHOT, bus.buildSnapshot(conn.team));
          break;
        case CLIENT_EVENTS.BACKFILL: {
          if (!conn.team) break;
          const items = repo
            .listMessages(conn.team, {
              ...(conn.filters || {}),
              beforeId: msg.beforeId,
              limit: msg.limit || 100,
              direction: 'desc',
            })
            .map(bus.toMessage);
          send(conn, WS_EVENTS.MESSAGES_PAGE, {
            beforeId: msg.beforeId ?? null,
            items,
            hasMore: items.length >= (msg.limit || 100),
          });
          break;
        }
        case CLIENT_EVENTS.PING:
          send(conn, 'pong', { ts: msg.ts });
          break;
        default:
          break;
      }
    });

    ws.on('close', () => clients.delete(conn));
    ws.on('error', () => clients.delete(conn));

    const hb = setInterval(() => {
      if (ws.readyState === 1) ws.ping();
    }, DEFAULTS.HEARTBEAT_TIMEOUT_MS / 2);
    ws.on('close', () => clearInterval(hb));
  });

  /**
   * 广播。team 为 null 表示广播给所有连接。
   * @param {string|null} team
   * @param {string} type
   * @param {unknown} payload
   */
  function broadcast(team, type, payload) {
    for (const conn of clients) {
      if (!conn.authed) continue;
      if (team && conn.team && conn.team !== team) continue;
      if (type === WS_EVENTS.MESSAGE_NEW && !matchesFilters(conn, payload)) continue;
      send(conn, type, payload);
    }
  }

  function close() {
    for (const c of clients) {
      try {
        c.ws.close(1001, 'server shutdown');
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    wss.close();
  }

  return { wss, clients, broadcast, close };
}

module.exports = { createHub };
