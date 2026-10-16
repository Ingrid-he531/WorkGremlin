import { CLIENT_EVENTS, WS_EVENTS } from '@workgremlin/shared';

/**
 * WebSocket client: auto-reconnect (exponential backoff) + fall back to HTTP polling while offline.
 *
 * **Every (re)connect asks for the credentials again** (`resolve`): the server rotates its token on
 * each start (see server/src/config.js), and a dropped connection is often exactly because the server
 * restarted. Reconnecting with the token captured at startup only gets kicked by the server as
 * bad_token, then reconnects and gets kicked again forever, and the UI is stuck on stale data
 * (measured: "running" tasks in the task list never show up again). So before reconnecting we must ask
 * once more "which port / which token is current".
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
  /** The credentials this connection round actually used (keep the previous ones when resolve gives nothing new) */
  let auth = { url, token, project: project ?? null };

  const setState = (state, extra = {}) => onState && onState({ state, ...extra });

  function send(obj) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj));
  }

  /** Resolve the url / token to use for this round before connecting; on a resolve throw or a missing url, reuse the previous ones and ask again next round */
  async function currentAuth() {
    if (typeof resolve === 'function') {
      try {
        const fresh = await resolve();
        if (fresh && fresh.url) auth = { ...auth, ...fresh };
      } catch {
        /* if it cannot be resolved, keep using the previous ones; do not stall the connection over one IPC failure */
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
      // Release it once the connect (including credential resolution) is done: no second connection may
      // be started concurrently during this await, otherwise a server restart can open two sockets at
      // once, both get kicked, and they fight each other.
      connecting = false;
    }

    socket.addEventListener('open', () => {
      attempt = 0;
      // Order matters: **send HELLO first**, then tell the layer above that we are open.
      // The server requires "the first frame before auth must be HELLO" (see server/src/ws/hub.js,
      // otherwise close(4001)); if we setState first, the frame the layer above eagerly sends in its
      // open callback (subscribe / backfill) would be queued before HELLO → the server treats it as a
      // bad token and kicks us → the symptom is being stuck on "disconnected, reconnecting" forever.
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
      // Cap the backoff at 5s: after a server restart (new token) it must climb back quickly, and each
      // round re-asks for the credentials.
      const delay = Math.min(1000 * 2 ** (attempt - 1), 5_000);
      reconnectTimer = setTimeout(connect, delay);
    });

    socket.addEventListener('error', () => {
      /* the close event handles reconnecting */
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
