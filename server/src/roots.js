'use strict';

/**
 * Generic "on-disk scanning infrastructure" —— it only knows the OS/editor directory conventions
 * and contains **no knowledge of any specific floor (product)**.
 *
 * Everything floor-related —— "what to match by name", "which home directories are candidates",
 * "where the CLI is installed", "what pluginRe is" —— is pushed down into each floor's meta
 * (see the floors.js registry + each <product>.js file). This module answers only:
 *   · Where the platform-level application data roots are (dataRoots)
 *   · Where editor extensions/plugins are installed (extensionRoots / globalStorageRoots) and where
 *     per-workspace editor state lives (workspaceStorageRoots)
 *   · How to find one product's plugin storage root by a caller-supplied regex + on-disk marker
 *     (findPluginStorage —— all matching rules come from the floor, never from here)
 *   · How to measure the size of a directory (scanDataDir)
 *   · How to find a matching child under a root by regex (matchIn / firstMatch / firstExisting)
 * That way floors.js only does "registry + detection orchestration", floor modules like trae.js
 * reuse the generic capabilities here directly, and nobody writes duplicate directory enumeration.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
// Single source of truth for WorkGremlin's own storage locations (see shared/paths.js).
const { productsOverridesPath } = require('@workgremlin/shared/paths');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const IS_WIN = process.platform === 'win32';

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Read a JSON file (tolerant: returns null on parse failure / missing file) */
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Read a directory (tolerant: returns an empty array when missing / no permission) */
function readDir(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

/** Shrink an absolute path to a ~ prefix, easier to read in the UI */
function shorten(p) {
  if (!p) return '';
  if (HOME && p.startsWith(HOME)) return `~${p.slice(HOME.length)}`;
  return p;
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Resolve a command on PATH into an absolute path */
function resolveCommand(cmd) {
  try {
    const out = execSync(IS_WIN ? `where ${cmd}` : `command -v ${cmd}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
      encoding: 'utf8',
    });
    return (
      String(out || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean) || ''
    );
  } catch {
    return '';
  }
}

/** Skip these while scanning (big and uninformative) */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'cache', 'Cache', 'logs', 'GPUCache']);

/**
 * Statistics for on-disk data: file count, session file count (*.jsonl), total bytes, last write time.
 * Bounded (depth 5 / 4000 files) so huge directories cannot stall the endpoint.
 */
function scanDataDir(dir) {
  let files = 0;
  let sessions = 0;
  let bytes = 0;
  let lastModifiedAt = null;

  const walk = (d, depth) => {
    if (depth > 5 || files > 4000) return;
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      files += 1;
      if (/\.jsonl$/i.test(e.name)) sessions += 1;
      try {
        const st = fs.statSync(p);
        bytes += st.size || 0;
        if (!lastModifiedAt || st.mtimeMs > lastModifiedAt) lastModifiedAt = st.mtimeMs;
      } catch {
        /* ignore unreadable files */
      }
      if (files > 4000) return;
    }
  };

  walk(dir, 0);
  return {
    files,
    sessions,
    bytes,
    sizeLabel: humanSize(bytes),
    lastModifiedAt: lastModifiedAt ? Math.round(lastModifiedAt) : null,
  };
}

/* ------------------------------ Candidate root directories ------------------------------ */

let _overridesCache = null;
/** Read the config file once (returns an empty object on parse failure / missing file); cached so rescanning does not hit the disk every time */
function readOverrides() {
  if (_overridesCache) return _overridesCache;
  const file = productsOverridesPath();
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    cfg = {};
  }
  _overridesCache = cfg;
  return cfg;
}

/** Expand a leading ~ into the home directory */
function expandHome(p) {
  return /^~([/\\]|$)/.test(p) ? path.join(HOME, p.replace(/^~[/\\]?/, '')) : p;
}

/** Merge the "config file field" + "environment variable" (env wins on the same name, but if both are given they are concatenated and deduped); ~ expands automatically */
function extraDirs(field, env) {
  const out = new Set();
  const cfg = readOverrides();
  if (Array.isArray(cfg[field])) {
    for (const d of cfg[field]) if (d && typeof d === 'string' && d.trim()) out.add(expandHome(d.trim()));
  }
  const v = process.env[env];
  if (v) for (const s of String(v).split(path.delimiter)) if (s.trim()) out.add(expandHome(s.trim()));
  return [...out];
}

/** Platform-level application data roots */
function dataRoots() {
  const roots = [];
  if (process.platform === 'darwin') {
    roots.push(path.join(HOME, 'Library', 'Application Support'));
  } else if (IS_WIN) {
    if (process.env.APPDATA) roots.push(process.env.APPDATA);
    if (process.env.LOCALAPPDATA) roots.push(process.env.LOCALAPPDATA);
  } else {
    roots.push(path.join(HOME, '.config'), path.join(HOME, '.local', 'share'));
  }
  for (const d of extraDirs('dataRoots', 'WORKGREMLIN_DATA_ROOTS')) if (isDir(d)) roots.push(d);
  return roots.filter(isDir);
}

/** Editor extension directories (where plugins are installed) */
function extensionRoots() {
  const base = [
    '.vscode',
    '.vscode-insiders',
    '.cursor',
    '.trae',
    '.trae-cn',
    '.qoder',
    '.qoder-cn',
    '.windsurf',
    '.vscode-server',
    '.marscode',
  ].map((d) => path.join(HOME, d, 'extensions'));
  const extras = extraDirs('extensionDirs', 'WORKGREMLIN_EXTENSION_DIRS').flatMap((d) => {
    const out = [path.join(d, 'extensions')];
    if (path.basename(d) === 'extensions') out.push(d);
    return out;
  });
  return base
    .concat(isDir(path.join(HOME, '.marscode', 'builtin')) ? [path.join(HOME, '.marscode', 'builtin')] : [])
    .concat(extras)
    .filter(isDir);
}

/** Editor globalStorage (where plugins write their data) */
function globalStorageRoots() {
  const out = [];
  for (const r of dataRoots()) {
    for (const ed of ['Code', 'Code - Insiders', 'Cursor', 'Trae', 'Windsurf', 'VSCodium']) {
      const p = path.join(r, ed, 'User', 'globalStorage');
      if (isDir(p)) out.push(p);
    }
  }
  const srv = path.join(HOME, '.vscode-server', 'data', 'User', 'globalStorage');
  if (isDir(srv)) out.push(srv);
  for (const d of extraDirs('globalStorageDirs', 'WORKGREMLIN_GLOBALSTORAGE_DIRS')) if (isDir(d)) out.push(d);
  return out;
}

/** Editor workspaceStorage (where VS Code keeps per-workspace state.vscdb) */
function workspaceStorageRoots() {
  const out = [];
  for (const r of dataRoots()) {
    for (const ed of ['Code', 'Code - Insiders', 'Cursor', 'Trae', 'Windsurf', 'VSCodium']) {
      const p = path.join(r, ed, 'User', 'workspaceStorage');
      if (isDir(p)) out.push(p);
    }
  }
  const srv = path.join(HOME, '.vscode-server', 'data', 'User', 'workspaceStorage');
  if (isDir(srv)) out.push(srv);
  return out;
}

/**
 * Find **one floor's** plugin directory inside globalStorage using the caller-supplied directory-name
 * regex. Callers always pass **their own floor's** meta.pluginRe (never a union across "all products")
 * and may additionally use marks to confirm this is "the one with session data on disk" (for instance,
 * when `github.copilot` and `github.copilot-chat` share a prefix, pass ['session-store.db'] to filter
 * out the one without a session store).
 * @param {RegExp|RegExp[]} re directory-name matcher for this product; iterates the directory list
 *   **in the given order** and takes the first hit. Omitted = no matching.
 * @param {string[]} [marks] subdirectory / file names that must exist inside a hit directory (any one
 *   suffices). Empty = no validation.
 * @returns {string} absolute path of the matching storage root; '' when not found
 */
function findPluginStorage(re, marks = []) {
  const list = (Array.isArray(re) ? re : re ? [re] : []).filter(Boolean);
  if (!list.length) return '';
  const need = Array.isArray(marks) ? marks.filter(Boolean) : [];
  for (const root of globalStorageRoots()) {
    for (const name of readDir(root)) {
      if (!list.some((rx) => rx.test(name))) continue;
      const dir = path.join(root, name);
      if (need.length && !need.some((m) => isDir(path.join(dir, m)) || isFile(path.join(dir, m)))) continue;
      return dir;
    }
  }
  return '';
}

/** nvm's bin: <HOME>/.nvm/versions/node/<version>/bin */
function nvmBinDirs() {
  const root = path.join(HOME, '.nvm', 'versions', 'node');
  if (!isDir(root)) return [];
  try {
    return fs
      .readdirSync(root)
      .map((v) => path.join(root, v, 'bin'))
      .filter(isDir);
  } catch {
    return [];
  }
}

/** Find a child whose name matches under a root directory (one level only, fast) */
function matchIn(root, res) {
  const list = res instanceof RegExp ? [res] : res || [];
  try {
    const candidates = [];
    for (const name of fs.readdirSync(root)) {
      const idx = list.findIndex((re) => re.test(name));
      if (idx >= 0) candidates.push({ name, idx });
    }
    if (!candidates.length) return '';
    candidates.sort((a, b) => a.idx - b.idx || a.name.localeCompare(b.name));
    return path.join(root, candidates[0].name);
  } catch {
    /* unreadable: skip */
  }
  return '';
}

function firstMatch(roots, res) {
  for (const r of roots) {
    const hit = matchIn(r, res);
    if (hit) return hit;
  }
  return '';
}

function firstExisting(dirs) {
  for (const d of dirs) if (isDir(d)) return d;
  return '';
}

module.exports = {
  HOME,
  isDir,
  isFile,
  readJson,
  readDir,
  shorten,
  humanSize,
  resolveCommand,
  scanDataDir,
  SKIP_DIRS,
  dataRoots,
  extensionRoots,
  globalStorageRoots,
  workspaceStorageRoots,
  findPluginStorage,
  nvmBinDirs,
  extraDirs,
  matchIn,
  firstMatch,
  firstExisting,
};
