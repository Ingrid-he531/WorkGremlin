/**
 * preload bridge. Inside Electron use window.workgremlin (real port + token);
 * in browser dev mode fall back to same-origin /api, /ws (forwarded by the vite proxy).
 */
import { t } from '../i18n/index.js';

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
      /* fall back to same-origin */
    }
  }
  const fallbackPort = Number(import.meta.env.VITE_SERVER_PORT || location.port || 21800);
  return { port: fallbackPort, token: '', version: 'dev', fallback: true };
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
 * Current project + recently opened projects + subagent manifest path.
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
 * Open a project. An empty path / 'demo' means switch back to the demo data.
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
 * Pop up the system directory picker (Electron). In browser dev it falls back to window.prompt.
 * @returns {Promise<string|null>}
 */
export async function chooseWorkspace() {
  if (hasBridge() && typeof window.workgremlin.chooseWorkspace === 'function') {
    try {
      return await window.workgremlin.chooseWorkspace();
    } catch {
      /* fall back to prompt */
    }
  }
  const p = window.prompt(t('workspace.prompt'));
  return p ? p.trim() : null;
}

/**
 * WS url. With a bridge, connect straight to 127.0.0.1:<port>; otherwise go same-origin (vite proxy).
 * @param {{port:number, token:string}} info
 */
export function wsUrl(info) {
  if (info && info.port && !info.fallback) return `ws://127.0.0.1:${info.port}/ws`;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * HTTP base.
 * @param {{port:number, fallback?:boolean}} info
 */
export function httpBase(info) {
  if (info && info.port && !info.fallback) return `http://127.0.0.1:${info.port}`;
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
