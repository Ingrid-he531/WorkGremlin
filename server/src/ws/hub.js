'use strict';

/**
 * WebSocket hub: connection management, subscription filtering, event broadcasting.
 *
 * The client's first frame must be {type:'hello', token, project, filters}; the token may also
 * be passed as ?token= on the URL. Everything the server pushes goes out as an envelope
 * (see shared/index.js).
 */

const { WebSocketServer } = require('ws');
const { PROTOCOL_VERSION, WS_EVENTS, CLIENT_EVENTS, DEFAULTS, envelope } = require('@workgremlin/shared');

/**
 * @param {{server: import('node:http').Server, token: string, bus: any, repo: any}} ctx
 */
function createHub({ server, token, bus, repo }) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });
  /** @type {Set<{ws: any, project: string|null, filters: any, authed: boolean}>} */
  const clients = new Set();

  function send(conn, type, payload) {
    if (conn.ws.readyState !== 1) return;
    try {
      conn.ws.send(JSON.stringify(envelope(type, conn.project || '', 'server', payload)));
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
      project: url.searchParams.get('project') || null,
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
          conn.project = msg.project || conn.project;
          conn.filters = msg.filters || conn.filters;
          // Send a snapshot even when no project is specified (buildSnapshot(null) uses the team
          // of "the currently open project"). Otherwise the client receives no frame after
          // connecting and has to wait for a later status broadcast.
          send(conn, WS_EVENTS.SNAPSHOT, bus.buildSnapshot(conn.project));
          break;
        case CLIENT_EVENTS.SUBSCRIBE:
          conn.filters = msg.filters || {};
          if (msg.project) conn.project = msg.project;
          send(conn, WS_EVENTS.SNAPSHOT, bus.buildSnapshot(conn.project));
          break;
        case CLIENT_EVENTS.BACKFILL: {
          if (!conn.project) break;
          const items = repo
            .listMessages(conn.project, {
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
    }, DEFAULTS.WS_HEARTBEAT_TIMEOUT_MS / 2);
    ws.on('close', () => clearInterval(hb));
  });

  /**
   * Broadcast. project === null means broadcast to every connection.
   * @param {string|null} project
   * @param {string} type
   * @param {unknown} payload
   */
  function broadcast(project, type, payload) {
    for (const conn of clients) {
      if (!conn.authed) continue;
      if (project && conn.project && conn.project !== project) continue;
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
