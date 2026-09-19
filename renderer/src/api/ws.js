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
      // 顺序很重要：必须**先把 HELLO 发出去**，再通知上层 open。
      // 服务端要求"鉴权前的首帧必须是 HELLO"（见 server/src/ws/hub.js，否则 close(4001)）；
      // 若先 setState 通知上层，上层在 open 回调里抢先发的帧（订阅 / 回填）会排在 HELLO 之前
      // → 被服务端当成 bad token 踢掉 → 表现就是一直"连接断开，重连中"。
      send({ type: CLIENT_EVENTS.HELLO, token, team, ts: Date.now() });
      setState('open', { source: 'ws' });
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
