'use strict';

/**
 * 楼层模块统一注册表 + 探测编排（框架核心）。
 *
 * 设计目标：**一个楼层 = 一个文件**（`server/src/<product>.js`，如 `codebuddy.js` /
 * `trae.js` …）。新增 / 修改一个楼层只动它自己的文件 + 在下面的 `floors` 里挂一行，
 * 绝不用改 `sessionRegistry.js` / `sessions.js` 这些中央文件 —— 这正是过去 regression 的来源。
 *
 * 本文件**只做两件事**：① 注册表（floors / floorOf）；② 探测编排（detectProducts 把各楼层
 * meta 聚合成探测结果）。凡是「某个产品叫什么、装在哪、按什么名字匹配」都下放到楼层 meta
 * （matchRe / homeDirs / homeDirsPlugin / pluginRe / altPluginRe / cliBinDirs …），本文件不出现
 * 任何具体楼层的内容。通用的「操作系统/编辑器目录枚举、目录体积统计」放在 roots.js（同样不含楼层知识）。
 *
 * 每个楼层模块约定导出：
 *   id           楼层 id（'1F' … '9F'）
 *   meta         产品探测元数据（id/name/kind/cmd/agent/plugin/pluginRe/altPluginRe/
 *                sources/hookSource/dataKind/matchRe/homeDirs/homeDirsPlugin/cliBinDirs）
 *   kindHandlers (可选) 该楼层特有的"会话来源分支"：{ <kind>: (product, spec, ctx) => void }
 *   sessionTitle (可选) 该楼层自己的会话标题读取：function(sessionId) => string
 *   syncTasks / startSyncer (可选) 后台台账同步器（见各楼层文件）
 *
 * 依赖方向：本文件 require 所有楼层模块（构建注册表）；楼层模块只 require 通用模块（roots.js /
 * @workgremlin/shared），不再 require 本文件 —— 因此不存在循环 require。
 */

const os = require('node:os');
const path = require('node:path');
const { diskKey } = require('@workgremlin/shared');

// 通用扫描基础设施（操作系统/编辑器目录枚举、目录体积、正则匹配……不认任何具体产品）
const {
  isDir,
  isFile,
  shorten,
  humanSize,
  scanDataDir,
  dataRoots,
  extensionRoots,
  globalStorageRoots,
  resolveCommand,
  matchIn,
  firstMatch,
  firstExisting,
  nvmBinDirs,
  extraDirs,
} = require('./roots');

const HOME = os.homedir();

/** 契约要求/约定的导出名（仅文档与自检用，不强制） */
const FLOOR_CONTRACT = [
  'id',
  'meta',
  'kindHandlers',
  'sessionTitle',
  'syncTasks',
  'startSyncer',
  'modelOf',
];

/* ============================================================== 注册表 */

/** 楼层 id → 楼层模块（每个楼层一个文件，新增楼层只在这里加一行） */
const floors = {
  '1F': require('./floorCodebuddy'),
  '2F': require('./floorWorkbuddy'),
  '3F': require('./floorCodex'),
  '4F': require('./floorClaude'),
  '5F': require('./floorTrae'),
  '6F': require('./floorQoder'),
  '7F': require('./floorKilo'),
  '8F': require('./floorOpencode'),
  '9F': require('./floorCopilot'),
};

/** 按楼层 id 取模块；没有返回 null */
function floorOf(id) {
  return floors[String(id)] || null;
}

/* ============================================================== CLI 安装目录（通用兜底） */

/**
 * CLI 常见安装目录（PATH 查不到时的兜底）。**只放与具体产品无关的通用位置**——
 * 某一层自己的 CLI 装在哪（~/.codebuddy/bin、~/.qoder/entry …）由该层 meta.cliBinDirs 声明，
 * 探测时拼在本数组之前。
 */
const BASE_CLI_BIN_DIRS = [
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, 'bin'),
  path.join(HOME, '.npm-global', 'bin'),
  path.dirname(process.execPath),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  path.join(HOME, '.yarn', 'bin'),
  path.join(HOME, '.bun', 'bin'),
  '/snap/bin',
  ...nvmBinDirs(),
  ...extraDirs('cliBinDirs', 'WORKGREMLIN_CLI_BIN_DIRS'),
];

function findCliBin(cmd, p) {
  if (!cmd) return '';
  const names = process.platform === 'win32' ? [`${cmd}.cmd`, `${cmd}.exe`, cmd] : [cmd];
  const dirs = [...(p && p.cliBinDirs ? p.cliBinDirs : []), ...BASE_CLI_BIN_DIRS];
  for (const dir of dirs) {
    for (const n of names) {
      const fp = path.join(dir, n);
      if (isFile(fp)) return fp;
    }
  }
  return '';
}

/* ============================================================== 落盘目录探测（按 meta 编排） */

/**
 * 找落盘目录。各楼层的"按名字匹配什么"与"家目录里的哪些候选"都在 meta.matchRe / meta.homeDirs
 * （plugin 形态用 meta.homeDirsPlugin）里声明 —— 本文件完全不出现具体楼层的名字/路径。
 * @param {{matchRe?: RegExp[], homeDirs?: string[], homeDirsPlugin?: string[]}} p 楼层 meta
 * @param {boolean} plugin 是否插件形态
 */
function findDataPath(p, plugin) {
  const res = p && p.matchRe && p.matchRe.length ? p.matchRe : [];
  const homeDirs = plugin ? (p.homeDirsPlugin || p.homeDirs || []) : p.homeDirs || [];
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

/** 找插件安装目录（编辑器扩展）。res 传楼层 meta.pluginRe（或 altPluginRe） */
function findPluginDir(res) {
  return firstMatch(extensionRoots(), res || []);
}

/** 找插件 globalStorage 目录（扩展目录搜不到时的兜底安装证据）。res 同上 */
function findPluginStorageDir(res) {
  return firstMatch(globalStorageRoots(), res || []);
}

/* ============================================================== 来源规格 */

/**
 * 这一层吃哪几路会话/落盘来源。
 * 条目是**字符串**（只给 kind）或**对象**（合并楼层用得上）。
 * @returns {Array<{kind: string, label?: string, client?: string, dirs?: string[], note?: string}>}
 */
function sourceSpecs(p) {
  const raw = p.sources && p.sources.length ? p.sources : p.hookSource ? ['hook'] : p.plugin ? ['plugin'] : ['cli'];
  if (raw.some((s) => typeof s !== 'string')) return raw.map((s) => ({ ...(typeof s === 'string' ? { kind: s } : s) }));
  return [...new Set(raw)].map((kind) => ({ kind }));
}

/** 这一路的上报身份：显式给了就用它，否则按 kind 推（plugin → agent-plugin，其余 → agent） */
function sourceClient(p, spec) {
  return spec.client || diskKey(p.agent, spec.kind === 'plugin' ? 'vscode' : 'cli');
}

/** 这一路的落盘目录候选（顺序即优先级）：hook 没有落盘目录；'dir' 用显式 dirs */
function sourceDirs(p, spec) {
  if (spec.dirs && spec.dirs.length) return spec.dirs;
  if (spec.kind === 'hook') return [];
  if (spec.kind === 'kilo') return [];
  if (spec.kind === 'opencode') return [];
  if (spec.kind === 'lingma') return [];
  return [findDataPath(p, spec.kind === 'plugin')];
}

/** 空统计（没有落盘目录时的占位，字段与 scanDataDir 一致） */
const NO_STATS = { files: 0, sessions: 0, bytes: 0, sizeLabel: '0 B', lastModifiedAt: null };

/**
 * 这一路落盘**能不能读出会话** —— 不能就明说。
 * @returns {string} 说明文案；不需要说明时回空串
 */
function sourceNote(kind, dataPath) {
  if (kind !== 'plugin' || !dataPath) return '';
  if (isDir(path.join(dataPath, 'genie-history'))) return '';
  return `${shorten(dataPath)} 里没有 genie-history 这类会话索引，只有产品自己的运行时文件 —— 这一路取不到会话（会话 id、运行态都读不到）`;
}

/**
 * 一路来源的描述：kind + client + 落盘目录 + 落盘统计（hook 来源没有自己的落盘目录）。
 */
function detectSource(p, spec, clients) {
  const dataPath = sourceDirs(p, spec).find((d) => d && isDir(d)) || '';
  return {
    kind: spec.kind,
    label: spec.label || '',
    client: (spec.kind === 'hook' || spec.kind === 'kilo') ? clients.join(',') : sourceClient(p, spec),
    sessions: spec.kind !== 'dir',
    dataPath,
    dataPathLabel: shorten(dataPath),
    stats: dataPath ? scanDataDir(dataPath) : { ...NO_STATS },
    note: spec.note || (dataPath ? sourceNote(spec.kind, dataPath) : ''),
  };
}

function detectOne(p) {
  const specs = sourceSpecs(p);
  const clients = [...new Set(specs.map((spec) => sourceClient(p, spec)))];
  const sources = specs.map((spec) => detectSource(p, spec, clients));
  const hasPluginSource = specs.some((spec) => spec.kind === 'plugin');
  const cliInstallPath =
    (p.cmd ? resolveCommand(p.cmd) || findCliBin(p.cmd, p) : '') ||
    (p.altCmd ? resolveCommand(p.altCmd) || findCliBin(p.altCmd, p) : '');
  const pluginInstallPath =
    (p.plugin || hasPluginSource || p.pluginRe ? findPluginDir(p.pluginRe) : '') ||
    (p.altPluginRe ? findPluginDir(p.altPluginRe) : '') ||
    (p.plugin || hasPluginSource || p.pluginRe ? findPluginStorageDir(p.pluginRe) : '');
  const installPath = cliInstallPath || pluginInstallPath;
  const emptySource = { dataPath: '', dataPathLabel: '', stats: { ...NO_STATS } };
  const primary =
    sources.find((s) => s.kind === (p.plugin ? 'plugin' : 'cli')) ||
    sources.find((s) => s.dataPath) ||
    sources[0] ||
    emptySource;
  const dataKind = clients[0] || p.dataKind;

  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    agent: p.agent,
    dataKind,
    clients,
    pluginRe: p.pluginRe || null,
    hookSource: Boolean(p.hookSource),
    sources,
    installed: Boolean(installPath),
    installPath,
    installPathLabel: shorten(installPath),
    cliInstallPath,
    cliInstallPathLabel: shorten(cliInstallPath),
    pluginInstallPath,
    pluginInstallPathLabel: shorten(pluginInstallPath),
    installPaths: [
      ...(cliInstallPath ? [{ kind: 'cli', path: cliInstallPath, label: shorten(cliInstallPath) }] : []),
      ...(pluginInstallPath ? [{ kind: 'plugin', path: pluginInstallPath, label: shorten(pluginInstallPath) }] : []),
    ],
    dataPath: primary.dataPath,
    dataPathLabel: primary.dataPathLabel,
    stats: primary.stats,
  };
}

/* ============================================================== 楼层元数据聚合 */

/**
 * 产品元数据不再硬编码：每个楼层在自己的文件（server/src/<product>.js）导出 `meta`，
 * 这里只从楼层注册表聚合。
 * @returns {Array}
 */
function floorMetas() {
  // 按楼层 id 升序，保证 1F…9F 的顺序稳定（UI / 快照都依赖这个顺序）
  return Object.keys(floors)
    .sort()
    .map((id) => floors[id].meta);
}

/** 探测所有楼层；force 可跳过缓存重新扫盘 */
function detectProducts({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.products.length && now - cache.at < TTL) return cache.products;
  const products = floorMetas().map(detectOne);
  cache = { at: now, products };
  return products;
}

/** 扫盘不便宜，结果缓存 60 秒 */
const TTL = 60_000;
let cache = { at: 0, products: [] };

/* ============================================================== 任务同步器编排 */

/**
 * 启动所有"无 hook 上报能力"楼层的后台任务同步器。
 *
 * 这些楼层（6F Qoder 插件形态 / 7F Kilo / 8F OpenCode / 9F Copilot）不会自己往 tasks 表写东西，
 * 靠这个兜底同步器每 5s 轮询各自本地库（session-store.db / kilo.db / opencode.db / local.db），
 * 把会话或每一轮对话补写成 task + task_run，让任务列表和主控制台都能看到它们。
 *
 * 各同步器内部异常各自吞掉、不阻断主流程；返回的定时器都已 unref，不阻止进程退出。
 * @param {{bus: object, repo: object, now: ()=>number}} ctx
 * @returns {Array<object>} 各同步器注册的定时器
 */
function startTaskSyncers({ bus, repo, now }) {
  const timers = [];
  // 9F Copilot：无 reporter hook，每 5s 轮询 session-store.db 把会话写成 task + task_run。
  timers.push(floors['9F'].startCopilotTaskSyncer({ bus, repo, now }));
  // 7F Kilo Code：同 9F，轮询 kilo.db（含 model 信息）。
  timers.push(floors['7F'].startKiloTaskSyncer({ bus, repo, now }));
  // 8F OpenCode：轮询 opencode.db 的 session_message 流，按每一轮用户任务写。
  timers.push(floors['8F'].startOpencodeTaskSyncer({ bus, repo, now }));
  // 6F Qoder 插件形态：扩展无 hook 子系统，轮询 local.db，按每一轮写（标题=用户原话、产出=summary）。
  // 同一成员若被 CLI 一路占着状态栏，这一路只写台账、不动相位（见 floorQoder.js 头）。
  timers.push(floors['6F'].startQoderPluginTaskSyncer({ bus, repo, now }));
  return timers;
}

/* ============================================================== 导出 */

module.exports.FLOOR_CONTRACT = FLOOR_CONTRACT;
module.exports.floors = floors;
module.exports.floorOf = floorOf;
module.exports.detectProducts = detectProducts;
module.exports.startTaskSyncers = startTaskSyncers;
