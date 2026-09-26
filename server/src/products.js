'use strict';

/**
 * 楼层 = 受监控的产品源。
 *   1F  CodeBuddy CLI
 *   2F  WorkBuddy CLI
 *   3F  CodeBuddy Plugin
 *   4F  Codex（CLI 与 IDE 同 ~/.codex、同 hook，分不出，合并单楼层）
 *   5F  Claude Code（CLI 与 IDE 同 ~/.claude、同 hook，分不出，合并单楼层）
 *   6F  TraeCode Plugin
 *   7F  TraeCode IDE
 *
 * Claude Code **只有一层**（5F）：CLI 与 IDE 插件共用同一份 ~/.claude 配置、同一套 hook、
 * 同一个落盘目录（~/.claude/projects），连二进制都是同一份 —— 事件 payload 里没有任何字段能
 * 区分二者（实测 2.1：不含 client，只有 session_id / cwd / transcript_path 这类共用字段）。
 * 既然"分不出"，就不该硬拆两层。
 *
 * 那"同一层里同时开着多会话"怎么分？靠 **session_id**（轴 2，见 docs/implementation-status.md）：
 * 它是 hook payload 的字段、也是 transcript 的文件名（`<session_id>.jsonl`）、还写在 transcript
 * 首行的 sessionId 里，三处实测 100% 一致。所以：
 *   - hook 侧：状态文件按 `<agent>@<工程>@<会话>.json` 分（见 packages/reporter/src/hook.js 的 statePath）
 *   - 服务端：/api/v1/reporter-phase 收 `?session=`，只取那一条会话的相位
 *   - 落库：task_runs / messages 都带 session_id
 * 楼层仍然只有一层，会话在层内区分 —— 这就是"一个楼层 + 会话"的设计。
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
const { clientOf } = require('@workgremlin/shared');

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
  return [
    '.vscode',
    '.vscode-insiders',
    '.cursor',
    '.trae',
    '.trae-cn',
    '.windsurf',
    '.vscode-server',
    // MarsCode（火山引擎 IDE）的扩展装在自家的 builtin 目录里，不在标准 extensions 下。
    // TraeCode 就是它的内置插件：~/.marscode/builtin/trae，所以这里也要认。
  ]
    .map((d) => path.join(HOME, d, 'extensions'))
    .concat(isDir(path.join(HOME, '.marscode', 'builtin')) ? [path.join(HOME, '.marscode', 'builtin')] : [])
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

/**
 * TraeCode 家族的 globalStorage（模型选择就记在它的 state.vscdb 里）。
 * 单列一份、不并进 globalStorageRoots：那份是**插件楼层的落盘位置**，
 * 一改就会把 6F 的落盘从 ~/.marscode 带偏到编辑器的 globalStorage 去。
 */
function traeGlobalStorageRoots() {
  const out = [];
  for (const r of dataRoots()) {
    for (const ed of ['Trae', 'Trae CN']) {
      const p = path.join(r, ed, 'User', 'globalStorage');
      if (isDir(p)) out.push(p);
    }
  }
  return out;
}

/**
 * Claude Code 的配置根 —— 配置、hook（settings.json）与会话落盘（projects/）都在它下面。
 *
 * 认 CLAUDE_CONFIG_DIR：**装 hook 的那一头（scripts/install-hooks.js）早就认了**，
 * 找落盘这一头以前写死 ~/.claude —— 设了这个变量的人，hooks 装到了新根下，
 * 服务端却还在老根下找会话，5F 于是永远扫不到东西。这个根只留这一处定义。
 */
function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
}

/**
 * nvm 的 bin：<HOME>/.nvm/versions/node/<版本>/bin。
 * 版本目录名不固定（v18.20.4 / v22.11.0 …），没法写死，只能在运行时展开一层。
 * 服务端常由桌面端拉起，PATH 里往往没有 nvm，所以这条兜底不能省。
 */
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

/** CLI 常见安装目录（PATH 查不到时兜底） */
const CLI_BIN_DIRS = [
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, 'bin'),
  path.join(HOME, '.codebuddy', 'bin'),
  path.join(HOME, '.workbuddy', 'bin'),
  path.join(HOME, '.npm-global', 'bin'),
  // npm 全局 bin：和当前 node 可执行文件同目录（/usr/local/nodejs/bin 这类装法）
  path.dirname(process.execPath),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  path.join(HOME, '.yarn', 'bin'),
  path.join(HOME, '.bun', 'bin'),
  '/snap/bin',
  ...nvmBinDirs(),
  // ChatGPT 桌面版自带一份 codex（Linux deb/rpm 落在 /usr/lib，手工解包常在 /opt），
  // 它不在 PATH 里 —— 只用桌面版 Codex 的人，可执行文件全盘就这一处。
  '/usr/lib/chatgpt/resources',
  '/opt/chatgpt/resources',
  ...(process.platform === 'darwin' ? ['/Applications/ChatGPT.app/Contents/Resources'] : []),
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
const RE_CODEX = [/^codex/i];
/** Codex 的宿主扩展目录名：VS Code 里的 openai.chatgpt-* / openai.codex-*（它们自带 codex） */
const RE_CODEX_HOST = [/^openai\.(chatgpt|codex)/i];
const RE_CLAUDE = [/^claude/i];
const RE_TRAE = [/^trae/i];
const RE_PLUGIN = [/codebuddy/i, /tencent/i, /ingram/i, /code-?buddy/i];

/** 在某个根目录下找名字命中的子项（只看一层，快） */
function matchIn(root, res) {
  // res 可能是单个正则（某产品的 pluginRe，如 /trae/i）或正则数组：统一成数组再 .some
  const list = res instanceof RegExp ? [res] : res || [];
  try {
    for (const name of fs.readdirSync(root)) {
      if (list.some((re) => re.test(name))) return path.join(root, name);
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
  const res =
    kind === 'workbuddy'
      ? RE_WORKBUDDY
      : kind === 'codex'
        ? RE_CODEX
        : kind === 'claude'
          ? RE_CLAUDE
          : kind === 'trae'
            ? RE_TRAE
            : RE_CODEBUDDY;
  const homeDirs =
    kind === 'workbuddy'
      ? [path.join(HOME, '.workbuddy')]
      : kind === 'codex'
        ? [path.join(HOME, '.codex')]
        : kind === 'claude'
          ? [claudeHome()]
          : kind === 'trae'
            ? plugin
              // 插件形态（6F TraeCode Plugin）：MarsCode 数据根，内置 trae 插件就装在
              // ~/.marscode/builtin/trae，落盘也在它下面。
              // 命令形态（7F TraeCode IDE）：~/.trae（国际版）/ ~/.trae-cn（国内版）。
              ? [path.join(HOME, '.marscode'), path.join(HOME, '.trae-cn'), path.join(HOME, '.trae')]
              : [path.join(HOME, '.trae'), path.join(HOME, '.trae-cn')]
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

/** 找插件安装目录（编辑器扩展）。res 可传单个正则（某产品的 pluginRe）或正则数组 */
function findPluginDir(res = RE_PLUGIN) {
  return firstMatch(extensionRoots(), res);
}

/* ------------------------------ 产品定义 ------------------------------ */

/**
 * 楼层 = 受监控的产品源。
 * 每个楼层绑定一个 **agent 基名** + 是否 plugin；由此派生出它的 client（= 上报身份）：
 *   client = clientOf(agent, plugin)  →  agent 本身（CLI）或 agent + '-plugin'（Plugin）。
 * 约定：每个 agent 可有 CLI 与 Plugin 两个独立楼层（变体）。目前——
 *   - codebuddy：1F CLI / 3F Plugin
 *   - workbuddy：2F CLI（暂无 Plugin）
 *   - codex     ：4F（CLI 与 IDE 同 ~/.codex、同 hook，分不出，合并为单楼层）
 *   - claude    ：5F CLI（**只有这一层**，见文件头说明：plugin 与 CLI 同配置同 hook，分不出来）
 *   - trae      ：6F Plugin / 7F CLI
 * 要再加变体（例如给 workbuddy 加 Plugin，或新增某个 agent 的 CLI/Plugin），只需在这里加一条
 * { id, name, agent, plugin:true|false, pluginRe? } —— client、归层、过滤、会话来源全部自动跟着走。
 *
 * 字段说明：
 *   - agent  产品基名（codebuddy / workbuddy / codex / claude / trae），落盘目录匹配用
 *   - dataKind  == client，下发给前端当"楼层客户端"（办公室按它过滤成员）；也当会话扫描形态
 *   - pluginRe  插件目录名匹配（仅 plugin 楼层需要；CLI 楼层忽略）
 */
const PRODUCTS = [
  {
    id: '1F',
    name: 'CodeBuddy CLI',
    kind: 'cli',
    cmd: 'codebuddy',
    agent: 'codebuddy',
    plugin: false,
    dataKind: clientOf('codebuddy', false),
  },
  {
    id: '2F',
    name: 'WorkBuddy CLI',
    kind: 'cli',
    cmd: 'workbuddy',
    agent: 'workbuddy',
    plugin: false,
    dataKind: clientOf('workbuddy', false),
  },
  {
    id: '3F',
    name: 'CodeBuddy Plugin',
    kind: 'plugin',
    cmd: '',
    agent: 'codebuddy',
    plugin: true,
    pluginRe: RE_PLUGIN,
    dataKind: clientOf('codebuddy', true),
  },
  {
    id: '4F',
    name: 'Codex',
    kind: 'cli',
    cmd: 'codex',
    agent: 'codex',
    plugin: false,
    // 4F 是「CLI 与 IDE 合并」楼层（文件头：二者同 ~/.codex、同 hook，分不出来）。
    // 于是这层的"装了"不能只认 codex 可执行文件 —— 只装 VS Code 的 Codex/ChatGPT 扩展、
    // 或只用 ChatGPT 桌面版的人，命令行里根本没有 codex，但人家确实在跑（会话就是证据）。
    // altPluginRe：仅作安装证据补抓，不影响 kind / client / 会话来源。
    altPluginRe: RE_CODEX_HOST,
    dataKind: clientOf('codex', false),
  },
  {
    id: '5F',
    name: 'Claude Code',
    kind: 'cli',
    cmd: 'claude',
    agent: 'claude',
    plugin: false,
    dataKind: clientOf('claude', false),
  },
  {
    id: '6F',
    name: 'TraeCode Plugin',
    kind: 'plugin',
    cmd: '',
    agent: 'trae',
    plugin: true,
    pluginRe: /trae/i,
    dataKind: clientOf('trae', true),
  },
  {
    id: '7F',
    name: 'TraeCode IDE',
    kind: 'cli',
    cmd: 'trae',
    // 国内版 TraeCode 桌面 IDE 的命令是 trae-cn（/usr/bin/trae-cn，没有独立的 trae CLI）；
    // 这层对应的就是那台 IDE，主命令搜不到时认它。
    altCmd: 'trae-cn',
    agent: 'trae',
    plugin: false,
    // 这层没有人能扫的会话落盘（TraeCode 的 memory/*.jsonl 不是会话），会话来源改用
    // reporter hook 的状态文件本身（sessionId / workspacePath 都是 hook payload 实测值）。
    hookSource: true,
    dataKind: clientOf('trae', false),
  },
];

function detectOne(p) {
  const installPath =
    (p.cmd ? resolveCommand(p.cmd) || findCliBin(p.cmd) : '') ||
    // 备用命令（7F TraeCode：国内版 IDE 的 trae-cn）——主命令搜不到时再认它。
    (p.altCmd ? resolveCommand(p.altCmd) || findCliBin(p.altCmd) : '') ||
    (p.plugin ? findPluginDir(p.pluginRe || RE_PLUGIN) : '') ||
    // 合并楼层（当前只有 4F Codex）：命令行搜不到时，再认一次宿主扩展目录。
    // 不改 kind / client：这层本来就同时代表 CLI 与 IDE，只是我们抓不到可执行文件而已。
    (p.altPluginRe ? findPluginDir(p.altPluginRe) : '');
  const dataPath = findDataPath(p.agent, p.plugin);
  const stats = dataPath
    ? scanDataDir(dataPath)
    : { files: 0, sessions: 0, bytes: 0, sizeLabel: '0 B', lastModifiedAt: null };

  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    /** 产品基名（codebuddy / workbuddy / codex / claude / trae）；落盘目录匹配用 */
    agent: p.agent,
    /** 落盘形态（codebuddy / workbuddy / codex）—— 会话扫描按它挑解析方式；也等于 client（楼层客户端） */
    dataKind: p.dataKind,
    /** 插件目录名匹配（仅 plugin 楼层有意义；sessionRegistry 据此给 listSessions 传参） */
    pluginRe: p.pluginRe || null,
    /** 会话来源只有 reporter hook 状态文件（没有可扫的会话落盘），见 refresh 的对应分支 */
    hookSource: Boolean(p.hookSource),
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

module.exports = { detectProducts, PRODUCTS, shorten, humanSize, traeGlobalStorageRoots, claudeHome };
