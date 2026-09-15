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
 * 当前工程 + 最近打开过的工程 + subagent 清单路径。
 * @param {{port?:number, token?:string, fallback?:boolean}} info
 */
export async function getWorkspace(info) {
  try {
    const res = await fetch(`${httpBase(info)}/api/v1/workspace`, {
      headers: info && info.token ? { Authorization: `Bearer ${info.token}` } : undefined,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 打开工程。path 为空 / 'demo' 表示切回演示数据。
 * @param {{port?:number, token?:string, fallback?:boolean}} info
 * @param {string} path
 */
export async function openWorkspace(info, path) {
  const res = await fetch(`${httpBase(info)}/api/v1/workspace`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(info && info.token ? { Authorization: `Bearer ${info.token}` } : {}),
    },
    body: JSON.stringify({ path }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`);
  return data;
}

/**
 * 弹出系统目录选择框（Electron）。浏览器 dev 模式下降级为 window.prompt。
 * @returns {Promise<string|null>}
 */
export async function chooseWorkspace() {
  if (hasBridge() && typeof window.workgremlin.chooseWorkspace === 'function') {
    try {
      return await window.workgremlin.chooseWorkspace();
    } catch {
      /* 降级到 prompt */
    }
  }
  const p = window.prompt('工程目录（绝对路径）');
  return p ? p.trim() : null;
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
