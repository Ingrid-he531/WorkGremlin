'use strict';

/**
 * 楼层 = 受监控的产品源。
 *   1F  CodeBuddy CLI
 *   2F  WorkBuddy CLI
 *   3F  CodeBuddy 插件
 *
 * 每一层自动搜索两样东西：
 *   - 安装位置：CLI 的可执行文件（PATH + 常见安装目录），插件的扩展目录
 *   - 落盘信息：数据目录（会话/配置/缓存），统计文件数、会话文件(*.jsonl)数、体积、最后写入时间
 *
 * 判定：**只有安装位置命中才算 installed=true**（UI 显示可点、未安装则全灰不可点）。
 * 落盘目录只作展示，不当证据 —— 别人（包括我们自己的 hooks 安装脚本）随手写一个
 * settings.json 就能造出一个数据目录，那不算"装了这个产品"。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const IS_WIN = process.platform === 'win32';

/** 扫盘不便宜，结果缓存 60 秒 */
const TTL = 60_000;
let cache = { at: 0, products: [] };

/* ------------------------------ 基础工具 ------------------------------ */

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

/* ------------------------------ 落盘目录扫描 ------------------------------ */

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
  return roots.filter(isDir);
}

/** 编辑器扩展目录（插件安装位置） */
function extensionRoots() {
  return ['.vscode', '.vscode-insiders', '.cursor', '.trae', '.windsurf', '.vscode-server']
    .map((d) => path.join(HOME, d, 'extensions'))
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
  // vscode-server（远程/容器场景）也顺手看一眼
  const srv = path.join(HOME, '.vscode-server', 'data', 'User', 'globalStorage');
  if (isDir(srv)) out.push(srv);
  return out;
}

/** CLI 常见安装目录（PATH 查不到时兜底） */
const CLI_BIN_DIRS = [
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, 'bin'),
  path.join(HOME, '.codebuddy', 'bin'),
  path.join(HOME, '.workbuddy', 'bin'),
  path.join(HOME, '.npm-global', 'bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
];

function findCliBin(cmd) {
  const names = IS_WIN ? [`${cmd}.cmd`, `${cmd}.exe`, cmd] : [cmd];
  for (const dir of CLI_BIN_DIRS) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (isFile(p)) return p;
    }
  }
  return '';
}

/* ------------------------------ 名字匹配 ------------------------------ */

const RE_CODEBUDDY = [/^codebuddy/i, /^code-?buddy/i, /^tencent/i, /^ingram/i];
const RE_WORKBUDDY = [/^workbuddy/i, /^work-?buddy/i];
const RE_PLUGIN = [/codebuddy/i, /tencent/i, /ingram/i, /code-?buddy/i];

/** 在某个根目录下找名字命中的子项（只看一层，快） */
function matchIn(root, res) {
  try {
    for (const name of fs.readdirSync(root)) {
      if (res.some((re) => re.test(name))) return path.join(root, name);
    }
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

/**
 * 找落盘目录。
 * CLI 优先家目录隐藏目录（~/.codebuddy），插件优先编辑器的 globalStorage。
 */
function findDataPath(kind, plugin) {
  const res = kind === 'workbuddy' ? RE_WORKBUDDY : RE_CODEBUDDY;
  const homeDirs =
    kind === 'workbuddy'
      ? [path.join(HOME, '.workbuddy')]
      : [path.join(HOME, '.codebuddy'), path.join(HOME, '.codebuddy-cli')];

  const steps = plugin
    ? [
        () => firstMatch(globalStorageRoots(), res),
        () => firstExisting(homeDirs),
        () => firstMatch(dataRoots(), res),
      ]
    : [
        () => firstExisting(homeDirs),
        () => firstMatch(dataRoots(), res),
        () => firstMatch(globalStorageRoots(), res),
      ];

  for (const step of steps) {
    const hit = step();
    if (hit) return hit;
  }
  return '';
}

/** 找插件安装目录（编辑器扩展） */
function findPluginDir() {
  return firstMatch(extensionRoots(), RE_PLUGIN);
}

/* ------------------------------ 产品定义 ------------------------------ */

const PRODUCTS = [
  {
    id: '1F',
    name: 'CodeBuddy CLI',
    kind: 'cli',
    cmd: 'codebuddy',
    dataKind: 'codebuddy',
    plugin: false,
  },
  {
    id: '2F',
    name: 'WorkBuddy CLI',
    kind: 'cli',
    cmd: 'workbuddy',
    dataKind: 'workbuddy',
    plugin: false,
  },
  {
    id: '3F',
    name: 'CodeBuddy 插件',
    kind: 'plugin',
    cmd: '',
    dataKind: 'codebuddy',
    plugin: true,
  },
];

function detectOne(p) {
  const installPath =
    (p.cmd ? resolveCommand(p.cmd) || findCliBin(p.cmd) : '') || (p.plugin ? findPluginDir() : '');
  const dataPath = findDataPath(p.dataKind, p.plugin);
  const stats = dataPath
    ? scanDataDir(dataPath)
    : { files: 0, sessions: 0, bytes: 0, sizeLabel: '0 B', lastModifiedAt: null };

  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    // 装没装只看**安装位置**：CLI 得找到可执行文件，插件得找到扩展目录。
    // 落盘目录不算证据 —— 我们自己的 hooks 安装脚本会给没装的产品写一份
    // settings.json 顺手造出一个目录（~/.workbuddy），拿它当证据等于自己骗自己。
    installed: Boolean(installPath),
    installPath,
    installPathLabel: shorten(installPath),
    dataPath,
    dataPathLabel: shorten(dataPath),
    stats,
  };
}

/** 探测三个楼层；force 可跳过缓存重新扫盘 */
function detectProducts({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.products.length && now - cache.at < TTL) return cache.products;
  const products = PRODUCTS.map(detectOne);
  cache = { at: now, products };
  return products;
}

module.exports = { detectProducts, PRODUCTS, shorten, humanSize };
