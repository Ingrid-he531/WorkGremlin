import { CLIENT_EVENTS, WS_EVENTS } from '@workgremlin/shared';

/**
 * WebSocket 客户端：自动重连（指数退避）+ 断线时降级为 HTTP 轮询。
 * M0 只实现重连与 snapshot 拉取；轮询降级路径留好 hook（DEGRADED_POLL_MS）。
 */
export function createConnection({ url, token, team, onEvent, onState }) {
  let socket = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer = null;

  const setState = (state, extra = {}) => onState && onState({ state, ...extra });

  function send(obj) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj));
  }

  function connect() {
    if (closed) return;
    setState('connecting');
    socket = new WebSocket(url);

    socket.addEventListener('open', () => {
      attempt = 0;
      setState('open', { source: 'ws' });
      send({ type: CLIENT_EVENTS.HELLO, token, team, ts: Date.now() });
    });

    socket.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      onEvent && onEvent(msg);
    });

    socket.addEventListener('close', () => {
      setState('closed', { source: 'ws' });
      if (closed) return;
      attempt += 1;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 15_000);
      reconnectTimer = setTimeout(connect, delay);
    });

    socket.addEventListener('error', () => {
      /* close 事件会负责重连 */
    });
  }

  connect();

  return {
    send,
    subscribe(filters) {
      send({ type: CLIENT_EVENTS.SUBSCRIBE, filters, ts: Date.now() });
    },
    backfill(beforeId, limit = 100) {
      send({ type: CLIENT_EVENTS.BACKFILL, beforeId, limit, ts: Date.now() });
    },
    ping() {
      send({ type: CLIENT_EVENTS.PING, ts: Date.now() });
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) socket.close();
    },
  };
}

export { WS_EVENTS };
