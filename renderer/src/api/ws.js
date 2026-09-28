import { CLIENT_EVENTS, WS_EVENTS } from '@workgremlin/shared';

/**
 * WebSocket 客户端：自动重连（指数退避）+ 断线时降级为 HTTP 轮询。
 *
 * **每轮（重）连都要重新要一份鉴权**（`resolve`）：server 每次启动都换 token
 * （见 server/src/config.js），而断线往往正是因为 server 换过实例 ——
 * 拿启动那一刻吃死的 token 去重连，只会被服务端 bad_token 踢掉，然后一直重连一直踢，
 * 界面永远停在旧数据上（实测：任务列表里"运行中"的任务再也不出现）。
 * 所以重连前必须重新问一次"现在连哪个端口、用哪个 token"。
 *
 * @param {{url?: string, token?: string, project?: string|null,
 *          resolve?: () => Promise<{url: string, token: string, project?: string|null}>|{url: string, token: string, project?: string|null}>,
 *          onEvent?: (msg: any) => void, onState?: (st: any) => void}} opts
 */
export function createConnection({ url, token, project, resolve, onEvent, onState }) {
  let socket = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer = null;
  let connecting = false;
  /** 这一轮连接实际用的鉴权（resolve 给不出新的时候沿用上一份） */
  let auth = { url, token, project: project ?? null };

  const setState = (state, extra = {}) => onState && onState({ state, ...extra });

  function send(obj) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj));
  }

  /** 连接前解析这一轮该用的 url / token；resolve 抛错或给不出 url 就沿用上一份，下一轮再问 */
  async function currentAuth() {
    if (typeof resolve === 'function') {
      try {
        const fresh = await resolve();
        if (fresh && fresh.url) auth = { ...auth, ...fresh };
      } catch {
        /* 问不到就继续用上一份，不要因为一次 IPC 失败把连接卡死 */
      }
    }
    return auth;
  }

  async function connect() {
    if (closed || connecting) return;
    connecting = true;
    setState('connecting');
    let cur;
    try {
      cur = await currentAuth();
      if (closed) return;
      socket = new WebSocket(cur.url);
    } finally {
      // 建连（含解析鉴权）完成后就放开：这段 await 期间不允许再并发起一条连接，
      // 否则 server 重启时可能同时开出两条 socket，双双被踢、互相拉扯。
      connecting = false;
    }

    socket.addEventListener('open', () => {
      attempt = 0;
      // 顺序很重要：必须**先把 HELLO 发出去**，再通知上层 open。
      // 服务端要求"鉴权前的首帧必须是 HELLO"（见 server/src/ws/hub.js，否则 close(4001)）；
      // 若先 setState 通知上层，上层在 open 回调里抢先发的帧（订阅 / 回填）会排在 HELLO 之前
      // → 被服务端当成 bad token 踢掉 → 表现就是一直"连接断开，重连中"。
      send({ type: CLIENT_EVENTS.HELLO, token: cur.token, project: cur.project ?? null, ts: Date.now() });
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
      // 退避上限压到 5s：server 重启（换 token）后要尽快自己爬回来，每轮都会重问鉴权
      const delay = Math.min(1000 * 2 ** (attempt - 1), 5_000);
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
