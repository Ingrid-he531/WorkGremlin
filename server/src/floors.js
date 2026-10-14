'use strict';

/**
 * Floor registry + detection orchestration (framework core).
 *
 * Design goal: **one floor = one file** (`server/src/<product>.js`, e.g. `codebuddy.js` / `trae.js` …).
 * Adding or changing a floor touches only its own file plus one line in `floors` below — never
 * `sessionRegistry.js` / `sessions.js` or other central files, which is exactly where past
 * regressions came from.
 *
 * This file does **only two things**: ① the registry (`floors` / `floorOf`); ② detection orchestration
 * (`detectProducts` aggregates each floor's `meta` into detect results). Anything about "what a
 * product is called, where it is installed, what names match it" lives in each floor's meta
 * (`matchRe` / `homeDirs` / `homeDirsPlugin` / `pluginRe` / `altPluginRe` / `cliBinDirs` …); this file
 * contains no product-specific content. Generic "OS/editor directory enumeration, directory size"
 * helpers live in roots.js (also floor-agnostic).
 *
 * Floor module contract:
 *   id           floor id ('1F' … '9F')
 *   meta         product detection metadata (id/name/kind/cmd/agent/plugin/pluginRe/altPluginRe/
 *                sources/hookSource/dataKind/matchRe/homeDirs/homeDirsPlugin/cliBinDirs)
 *   kindHandlers (optional) this floor's own "session source branch": { <kind>: (product, spec, ctx) => void }
 *   sessionTitle (optional) this floor's own session-title read: function(sessionId) => string
 *   syncTasks / pollMs (optional) floors that write the task ledger by polling (see each floor file):
 *                syncTasks(ctx) reads the local store and fills in task + task_run; pollMs declares
 *                the cadence (default 5000). **Floors hold no timers** — the single clock lives in
 *                server/src/poller.js, which walks this registry.
 *   pluginStore  (optional) structured on-disk reader for this floor's plugin kind:
 *                { readTodos(storage,id), readFileChanges(storage,id), readRuntime(storage,id),
 *                  collectProjects(storage,candidates) } — sessions.js dispatches by client (1F: floorCodebuddy)
 *   pluginPolicy (optional) session-list policy for this floor's plugin kind, dispatched generically
 *                by sessionRegistry.handlePlugin: (ctx) => { currentOnly?, active?, ended?, exclude?(row) }
 *                (1F: floorCodebuddy)
 *
 * Dependency direction: this file requires every floor module (to build the registry); floor modules
 * require only generic modules (roots.js / @workgremlin/shared) and never this file — so there is no
 * circular require.
 */

const os = require('node:os');
const path = require('node:path');

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

// 静态 subagent 发现引擎（产品无关，只按"给定目录"找定义文件 / 读描述 / 判级别）。
// 各楼层自己的目录知识在 floor<X>.js 的 agentDirs 里；本文件只做聚合 + 按 client 派发。
const { detectLevelInDirs, descriptionInDirs, listAgentFiles } = require('./ingest/agentLevel');

const HOME = os.homedir();

/** Contract export names (docs / self-check only; not enforced) */
const FLOOR_CONTRACT = [
  'id',
  'meta',
  'kindHandlers',
  'sessionTitle',
  'syncTasks',
  'pollMs',
  'modelOf',
  'pluginStore',
  'pluginPolicy',
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

/** agent（楼层基名，如 'codebuddy'）→ 楼层模块；hookDispatch 据此把事件派发给对应楼层的 handleHookEvent */
const floorByAgent = {};
for (const f of Object.values(floors)) {
  const a = f?.meta?.agent;
  if (a) floorByAgent[String(a).toLowerCase()] = f;
}

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

/**
 * 这一路的上报身份 client —— **恒等于楼层基名**（agent）。
 * 形态（CLI / 插件）不走身份：由下面的 sourceForm / spec.kind 表达，是不是插件用 shared.isPluginClient(form) 判。
 * A spec.client override is allowed (rare), but never synthesize an `<agent>-plugin` identity —
 * the reported state file's client is the bare base name (see hookCommon's `client = ev.agent`).
 */
function sourceClient(p, spec) {
  return spec.client || p.agent;
}

/** 这一路的形态（cli / vscode / ide …）：显式给了就用它，否则按 kind 推；hook 那一路形态不定（''，两种都收） */
function sourceForm(spec) {
  if (spec.form) return spec.form;
  if (spec.kind === 'plugin') return 'vscode';
  if (spec.kind === 'cli') return 'cli';
  return '';
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
    // client 恒为楼层基名；形态另放 form（消费者按 isPluginClient(form) 判插件）
    client: sourceClient(p, spec),
    form: sourceForm(spec),
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

/* ============================================================== Polling floor registry */

/**
 * Floors that write the task ledger by polling (no hook / no reporter).
 *
 * These floors (6F Qoder plugin / 7F Kilo / 8F OpenCode / 9F Copilot) never write to `tasks`
 * themselves; the server reads their local store (local.db / kilo.db / opencode.db /
 * session-store.db) and writes the task + task_run per session turn. A floor does that inside
 * `syncTasks(ctx)` and **holds no timer** — the server's single unified poller (see poller.js) walks
 * this registry and calls each floor on its declared `pollMs` (default 5000). Per-floor failures are
 * swallowed by the poller, so one missing/locked store never stalls the loop.
 *
 * The opt-in signal is simply "exports syncTasks": 1F~5F and 6F CLI report via hooks and do not
 * export it, so they only get their sessions scanned.
 * @returns {Array<object>} floor modules that participate in task polling
 */
function taskSyncerFloors() {
  return Object.values(floors).filter((f) => typeof f.syncTasks === 'function');
}

/* ============================================================== 静态 subagent 聚合 */

/**
 * 取某 client（楼层基名）对应的 agent 目录列表；client 缺省时汇总所有楼层。
 * 顺序即优先级（楼层内 project 先于 user；跨楼层按 1F…9F）。
 * @param {string} [client]
 * @param {string} [workspacePath]
 * @returns {Array<{dir:string, level:'project'|'user'}>}
 */
function dirsForClient(client, workspacePath) {
  if (client) {
    const f = floorByAgent[String(client).toLowerCase()];
    return f && typeof f.agentDirs === 'function' ? f.agentDirs(workspacePath) : [];
  }
  const out = [];
  for (const f of Object.values(floors)) {
    if (typeof f.agentDirs === 'function') out.push(...f.agentDirs(workspacePath));
  }
  return out;
}

/**
 * subagent 级别（用户级 / 项目级）。client 给定时只在该楼层目录里找；缺省时汇总所有楼层。
 * 取不到回 null（普通成员 / 演示数据，不戴级别牌）。
 * @param {string} name
 * @param {string} workspacePath
 * @param {string} [client]
 * @returns {'project'|'user'|null}
 */
function detectLevel(name, workspacePath, client) {
  return detectLevelInDirs(name, workspacePath, dirsForClient(client, workspacePath));
}

/**
 * subagent 功能描述（agent 定义文件里的静态数据）。client 给定时只在该楼层目录里找；缺省时
 * 汇总所有楼层，命中第一个。取不到回空串（渲染层据此隐藏那一栏）。
 * @param {string} name
 * @param {string} workspacePath
 * @param {string} [client]
 */
function agentDescription(name, workspacePath, client) {
  return descriptionInDirs(name, workspacePath, dirsForClient(client, workspacePath));
}

/**
 * 汇总所有楼层"已定义的静态 subagent"（项目级优先于用户级，跨楼层重名去重）。
 * 返回 [{ name, level, client }]，供 agentRoster 注册成坐工位、带工牌的小怪物。
 * @param {string} workspacePath 当前工程路径（项目级 agent 在这里找）
 * @returns {Array<{name:string, level:'project'|'user', client:string}>}
 */
function listStaticSubagents(workspacePath) {
  const ws = String(workspacePath || '').trim();
  const seen = new Map(); // name -> { name, level, client }
  for (const f of Object.values(floors)) {
    if (typeof f.agentDirs !== 'function') continue;
    const client = (f.meta && f.meta.agent) || '';
    // 楼层内 project 目录先于 user 目录（agentDirs 已按此顺序返回），先见者胜出
    for (const { dir, level } of f.agentDirs(ws)) {
      for (const n of listAgentFiles(dir)) {
        if (!seen.has(n)) seen.set(n, { name: n, level, client });
      }
    }
  }
  return [...seen.values()];
}

/* ============================================================== 导出 */

module.exports.FLOOR_CONTRACT = FLOOR_CONTRACT;
module.exports.floors = floors;
module.exports.floorOf = floorOf;
module.exports.floorByAgent = floorByAgent;
module.exports.detectProducts = detectProducts;
module.exports.taskSyncerFloors = taskSyncerFloors;
module.exports.detectLevel = detectLevel;
module.exports.agentDescription = agentDescription;
module.exports.listStaticSubagents = listStaticSubagents;
