/**
 * preload 桥接。Electron 内运行时用 window.workgremlin（真实端口+token）；
 * 浏览器 dev 模式下降级为同源 /api、/ws（由 vite proxy 转发）。
 */

export function hasBridge() {
  return typeof window !== 'undefined' && Boolean(window.workgremlin);
}

/** @returns {Promise<{port: number, token: string, dbPath?: string, version?: string}>} */
export async function getServerInfo() {
  if (hasBridge()) {
    try {
      const info = await window.workgremlin.getServerInfo();
      if (info && info.port) return info;
    } catch {
      /* 降级到同源 */
    }
  }
  const fallbackPort = Number(import.meta.env.VITE_SERVER_PORT || location.port || 21800);
  return { port: fallbackPort, token: '', version: 'dev', fallback: true };
}

export async function getFlags() {
  if (hasBridge()) {
    try {
      return await window.workgremlin.getFlags();
    } catch {
      /* ignore */
    }
  }
  return { demo: false, seed: 1 };
}

/**
 * WS 地址。有 bridge 时直连 127.0.0.1:<port>；否则走同源（vite proxy）。
 * @param {{port:number, token:string}} info
 */
export function wsUrl(info) {
  if (info && info.port && !info.fallback) return `ws://127.0.0.1:${info.port}/ws`;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * HTTP 基址。
 * @param {{port:number, fallback?:boolean}} info
 */
export function httpBase(info) {
  if (info && info.port && !info.fallback) return `http://127.0.0.1:${info.port}`;
  return '';
}
