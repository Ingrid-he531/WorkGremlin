/**
 * preload bridge. Inside Electron use window.workgremlin (real port + token);
 * in browser dev mode fall back to same-origin /api, /ws (forwarded by the vite proxy).
 */

export function hasBridge() {
  return typeof window !== 'undefined' && Boolean(window.workgremlin);
}

/** @returns {Promise<{host?: string, port: number, token: string, dbPath?: string, version?: string}>} */
export async function getServerInfo() {
  if (hasBridge()) {
    try {
      const info = await window.workgremlin.getServerInfo();
      if (info && info.port) return info;
    } catch {
      /* fall back to same-origin */
    }
  }
  const fallbackPort = Number(import.meta.env.VITE_SERVER_PORT || location.port || 21800);
  // Browser-only mode (`--static`): the server injects this global into index.html with the token,
  // and API/WS are same-origin, so no bridge and no Vite proxy is involved. In Vite dev mode the
  // global is absent and the proxy injects the token instead.
  const boot = typeof window !== 'undefined' ? window.__WORKGREMLIN_BOOT__ : null;
  const bootToken = boot && typeof boot.token === 'string' ? boot.token : '';
  return { port: fallbackPort, token: bootToken, version: boot ? 'web' : 'dev', fallback: true };
}

/**
 * Bring the desktop window forward (no-op in a plain browser). Used when a remote dispatch request
 * needs a decision on this machine.
 * @returns {Promise<boolean>}
 */
export async function focusWindow() {
  if (hasBridge() && typeof window.workgremlin.focusWindow === 'function') {
    try {
      return Boolean(await window.workgremlin.focusWindow());
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Native (OS-level) fullscreen: when true the window fills the whole screen and the title bar /
 * frame / menu bar all go away.
 * Inside Electron this goes through IPC; in plain browser dev it falls back to the HTML5 Fullscreen
 * API (which also has no window chrome).
 * @param {boolean} on
 * @returns {Promise<boolean>} the actual state after the toggle
 */
export async function setFullScreen(on) {
  if (hasBridge() && typeof window.workgremlin.setFullScreen === 'function') {
    try {
      return Boolean(await window.workgremlin.setFullScreen(Boolean(on)));
    } catch {
      /* fall back to HTML5 fullscreen */
    }
  }
  try {
    if (on) {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    }
    return Boolean(document.fullscreenElement);
  } catch {
    /* no bridge and no Fullscreen API (old WebView): the in-app focus mode still applies */
    return false;
  }
}

/**
 * Subscribe to native fullscreen changes (F11 / system gesture / menu toggle all trigger it).
 * @param {(on: boolean) => void} cb
 * @returns {() => void} unsubscribe
 */
export function onFullScreen(cb) {
  if (hasBridge() && typeof window.workgremlin.onFullScreen === 'function') {
    return window.workgremlin.onFullScreen(cb);
  }
  const handler = () => cb(Boolean(document.fullscreenElement));
  document.addEventListener('fullscreenchange', handler);
  return () => document.removeEventListener('fullscreenchange', handler);
}

/**
 * Server-side default workspace (fallback for attribution / polling). The office does not use it
 * to choose a project; that follows the selected session.
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
 * Start (or restart) the in-memory demo session on a floor.
 * @param {{port?:number, token?:string, fallback?:boolean}} info
 * @param {string} floor
 */
export async function startDemoSession(info, floor) {
  const res = await fetch(`${httpBase(info)}/api/v1/demo/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(info && info.token ? { Authorization: `Bearer ${info.token}` } : {}),
    },
    body: JSON.stringify({ floor }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`);
  return data;
}

/**
 * Live demo phase / member state. Read-only; no DB access on the server.
 * @param {{port?:number, token?:string, fallback?:boolean}} info
 * @param {string} floor
 * @param {string} sessionId
 */
export async function getDemoSession(info, floor, sessionId) {
  const qs = new URLSearchParams({ floor: String(floor || ''), session: String(sessionId || '') });
  const res = await fetch(`${httpBase(info)}/api/v1/demo/session?${qs}`, {
    headers: info && info.token ? { Authorization: `Bearer ${info.token}` } : undefined,
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`);
  return data;
}

/**
 * Drop the in-memory demo state for a floor. Safe to call repeatedly.
 * @param {{port?:number, token?:string, fallback?:boolean}} info
 * @param {string} floor
 */
export async function stopDemoSession(info, floor) {
  const qs = new URLSearchParams({ floor: String(floor || '') });
  try {
    await fetch(`${httpBase(info)}/api/v1/demo/session?${qs}`, {
      method: 'DELETE',
      headers: info && info.token ? { Authorization: `Bearer ${info.token}` } : undefined,
    });
  } catch {
    /* Leaving demo must never be blocked by a network failure */
  }
}


/**
 * Host of the current target. Local mode stays on loopback; the desktop client can be pointed at
 * a server on another machine (see desktop/src/remoteConfig.js), which sets `host`.
 * @param {{host?: string}} [info]
 */
function hostOf(info) {
  return (info && info.host) || '127.0.0.1';
}

/**
 * WS url. With a bridge, connect straight to the configured host; otherwise go same-origin (vite proxy).
 * The scheme follows `info.protocol` because a remote target may speak https: `ws://host:port` against
 * a TLS listener fails the handshake, and host+port alone cannot tell us which one it is.
 * @param {{host?: string, port: number, token: string, protocol?: string}} info
 */
export function wsUrl(info) {
  if (info && info.port && !info.fallback) {
    const scheme = String(info.protocol || '').toLowerCase() === 'https' ? 'wss' : 'ws';
    return `${scheme}://${hostOf(info)}:${info.port}/ws`;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * HTTP base.
 * @param {{host?: string, port: number, protocol?: string, fallback?: boolean}} info
 */
export function httpBase(info) {
  if (info && info.port && !info.fallback) {
    const scheme = String(info.protocol || '').toLowerCase() === 'https' ? 'https' : 'http';
    return `${scheme}://${hostOf(info)}:${info.port}`;
  }
  return '';
}

/**
 * App version (package.json's version, read in the main process via getAppVersion).
 * @returns {Promise<string>} empty string when it cannot be read
 */
export async function getAppVersion() {
  if (hasBridge() && typeof window.workgremlin.getAppVersion === 'function') {
    try {
      return (await window.workgremlin.getAppVersion()) || '';
    } catch {
      /* fall back to an empty string */
    }
  }
  return '';
}

/**
 * Build info: app version + short sha of the latest commit + Electron / Node runtime versions.
 * @returns {Promise<{version:string, commit:string, electron:string, node:string}>}
 */
export async function getBuildInfo() {
  if (hasBridge() && typeof window.workgremlin.getBuildInfo === 'function') {
    try {
      const info = await window.workgremlin.getBuildInfo();
      if (info && typeof info === 'object') return info;
    } catch {
      /* fall back to an empty object */
    }
  }
  return { version: '', commit: '', electron: '', node: '' };
}

/**
 * Quit the whole app. Inside Electron this goes through IPC; in browser dev it falls back to closing
 * the window.
 */
export async function quitApp() {
  if (hasBridge() && typeof window.workgremlin.quit === 'function') {
    try {
      return await window.workgremlin.quit();
    } catch {
      /* fall back to closing the window */
    }
  }
  try {
    window.close();
  } catch {
    /* if it cannot be closed, so be it (common in dev) */
  }
}

/**
 * Open an external link with the system default program (Electron uses shell.openExternal, so no page
 * is embedded in the app). In browser dev it falls back to window.open.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function openExternal(url) {
  if (!url) return false;
  if (hasBridge() && typeof window.workgremlin.openExternal === 'function') {
    try {
      return Boolean(await window.workgremlin.openExternal(url));
    } catch {
      /* fall back to window.open */
    }
  }
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    /* ignore */
  }
  return true;
}
