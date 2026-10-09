'use strict';

/**
 * 通用「落盘扫描基础设施」—— 只认操作系统/编辑器的目录约定，**不含任何具体楼层（产品）的知识**。
 *
 * 楼层相关的「按名字匹配什么」「家目录哪些候选」「CLI 装在哪」「pluginRe 是什么」全部下放到
 * 各楼层的 meta（见 floors.js 注册表 + 各 <product>.js 文件）。本模块只回答：
 *   · 平台级应用数据根在哪（dataRoots）
 *   · 编辑器扩展/插件装在哪（extensionRoots / globalStorageRoots）
 *   · 怎么数一个目录的体积（scanDataDir）
 *   · 怎么按正则在某个根下找命中的子项（matchIn / firstMatch / firstExisting）
 * 这样 floors.js 只做「注册表 + 探测编排」，trae.js 等楼层模块直接复用这里的通用能力，
 * 谁都不用写重复的目录枚举。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

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

/** 把绝对路径缩成 ~ 开头，UI 里好读 */
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

/** PATH 里的命令解析成绝对路径 */
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

/** 扫目录时跳过这些（又大又没信息量） */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'cache', 'Cache', 'logs', 'GPUCache']);

/**
 * 统计落盘数据：文件数、会话文件数（*.jsonl）、总字节、最后写入时间。
 * 有上限保护（深度 5 / 4000 个文件），避免大目录把接口拖死。
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
        /* 忽略读不到的文件 */
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

/* ------------------------------ 候选根目录 ------------------------------ */

/**
 * 额外搜索范围（配置文件 + 环境变量，二者并存、拼接去重）。详见 products.overrides.json。
 */
function workgremlinHome() {
  return process.env.WORKGREMLIN_HOME || path.join(HOME, '.workgremlin');
}

let _overridesCache = null;
/** 读一次配置文件（解析失败/不存在回空对象）；缓存避免每次扫盘都读盘 */
function readOverrides() {
  if (_overridesCache) return _overridesCache;
  const file = path.join(workgremlinHome(), 'products.overrides.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    cfg = {};
  }
  _overridesCache = cfg;
  return cfg;
}

/** 把开头的 ~ 展开成家目录 */
function expandHome(p) {
  return /^~([/\\]|$)/.test(p) ? path.join(HOME, p.replace(/^~[/\\]?/, '')) : p;
}

/** 合并「配置文件字段」+「环境变量」（env 优先同名，但二者都给则拼接去重）；~ 自动展开 */
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

/** 平台级应用数据根目录 */
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

/** 编辑器扩展目录（插件安装位置） */
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

/** 编辑器 globalStorage（插件的落盘位置） */
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

/** nvm 的 bin：<HOME>/.nvm/versions/node/<版本>/bin */
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

/** 在某个根目录下找名字命中的子项（只看一层，快） */
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
    /* 读不到就跳过 */
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
  shorten,
  humanSize,
  resolveCommand,
  scanDataDir,
  SKIP_DIRS,
  dataRoots,
  extensionRoots,
  globalStorageRoots,
  nvmBinDirs,
  extraDirs,
  matchIn,
  firstMatch,
  firstExisting,
};
