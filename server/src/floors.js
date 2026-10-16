'use strict';

/**
 * Floor registry + detection orchestration (framework core).
 *
 * Design goal: **one floor = one file** (`server/src/<product>.js`, e.g. `codebuddy.js` / `trae.js` …).
 * Adding or changing a floor touches only its own file plus one line in `floors` below — never
 * `sessionRegistry.js` / `sessions.js` or other central files, which is exactly where past
 * regressions came from.
 *
 * This file does **three things**: ① the registry (`floors` / `floorOf`); ② detection orchestration
 * (`detectProducts` aggregates each floor's `meta` into detect results); ③ the on-disk window constants
 * shared by plugin-kind sources (IDLE_MS / … / DONE_TTL_MS, read by sessions.js). Anything about "what a
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

// Generic scanning infrastructure (OS/editor directory enumeration, directory size, regex matching
// … knows no specific product)
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

// Static subagent discovery engine (product-agnostic: it only finds files / reads descriptions /
// decides levels for a given set of dirs). Each floor's own dir knowledge lives in its `agentDirs`;
// each floor scans those dirs itself via agentLevel.makeAgentSync and registers through the upper
// layer (see poller.js) — this file only dispatches lookups by client (detectLevel / agentDescription)
// and no longer aggregates across floors.
const { detectLevelInDirs, descriptionInDirs } = require('./ingest/agentLevel');

const HOME = os.homedir();

/** Contract export names (docs / self-check only; not enforced) */
const FLOOR_CONTRACT = [
  'meta',
  'kindHandlers',
  'sessionTitle',
  'syncTasks',
  'pollMs',
  'modelOf',
  'pluginStore',
  'pluginPolicy',
];

/* ============================================================== Registry */

/**
 * Floor modules in floor order (1F…9F). Adding a floor = one `require` line here; the id lives in
 * **`meta.id` only** (the single source — it is not repeated as this object's key nor as a top-level
 * `module.exports.id`).
 */
const FLOOR_MODULES = [
  require('./floorCodebuddy'),
  require('./floorWorkbuddy'),
  require('./floorCodex'),
  require('./floorClaude'),
  require('./floorTrae'),
  require('./floorQoder'),
  require('./floorKilo'),
  require('./floorOpencode'),
  require('./floorCopilot'),
];

/** Floor id → floor module (keyed by `meta.id`) */
const floors = Object.fromEntries(FLOOR_MODULES.map((m) => [m.meta.id, m]));

/** agent (floor base name, e.g. 'codebuddy') → floor module; hookDispatch uses this to send events to that floor's handleHookEvent */
const floorByAgent = {};
for (const f of Object.values(floors)) {
  const a = f?.meta?.agent;
  if (a) floorByAgent[String(a).toLowerCase()] = f;
}

/** Get a module by floor id; null when absent */
function floorOf(id) {
  return floors[String(id)] || null;
}

/* ============================================================== Plugin source on-disk windows */

/**
 * On-disk windows shared by the plugin-kind sources (aligned with the CLI floors; sessionRegistry's
 * TIMEOUT_MS = 60 minutes). sessions.js reads plugin data with them, so the single copy lives here
 * rather than in each consumer.
 */
const IDLE_MS = 10 * 60_000; // how long without activity counts as "inactive" (the plugin runtime has no heartbeat, so only file times can be used)
const BUSY_MS = 90_000; // a file changed within this long → considered to be actively working
const FRESH_MS = 2 * 60_000; // on-disk writes within this long → this round of conversation is still advancing (covers cases like pure reasoning or read-only tools that leave no file/todo evidence)
const LISTED_MS = 60 * 60_000; // window in which a session is "still in the dropdown" (see the notes in sessions.js)
const DONE_TTL_MS = 10 * 60_000; // "freshness" window of the done marker: only something that finished within this long counts as "just happened"

/* ============================================================== CLI install directories (generic fallback) */

/**
 * Common CLI install directories (fallback when PATH lookup fails). **Only product-independent
 * generic locations belong here** —— where a given floor's own CLI lives (~/.codebuddy/bin,
 * ~/.qoder/entry …) is declared by that floor's meta.cliBinDirs, which is prepended at detection.
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

/* ============================================================== On-disk directory detection (orchestrated by meta) */

/**
 * Find the on-disk directory. Each floor's "match what by name" and "which candidates in the home
 * directory" are declared in meta.matchRe / meta.homeDirs (meta.homeDirsPlugin for the plugin form)
 * —— concrete floor names/paths never appear in this file.
 * @param {{matchRe?: RegExp[], homeDirs?: string[], homeDirsPlugin?: string[]}} p floor meta
 * @param {boolean} plugin whether it is the plugin form
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

/** Find the plugin install directory (editor extension). res takes the floor's meta.pluginRe (or altPluginRe) */
function findPluginDir(res) {
  return firstMatch(extensionRoots(), res || []);
}

/** Find the plugin's globalStorage directory (install evidence fallback when the extension directory search fails). res as above */
function findPluginStorageDir(res) {
  return firstMatch(globalStorageRoots(), res || []);
}

/* ============================================================== Source specs */

/**
 * Which session / on-disk sources this floor consumes.
 * Entries are either **strings** (kind only) or **objects** (needed by merged floors).
 * @returns {Array<{kind: string, label?: string, client?: string, dirs?: string[], note?: string}>}
 */
function sourceSpecs(p) {
  const raw = p.sources && p.sources.length ? p.sources : p.hookSource ? ['hook'] : p.plugin ? ['plugin'] : ['cli'];
  if (raw.some((s) => typeof s !== 'string')) return raw.map((s) => ({ ...(typeof s === 'string' ? { kind: s } : s) }));
  return [...new Set(raw)].map((kind) => ({ kind }));
}

/**
 * The reporting identity `client` of this path —— **always equal to the floor base name** (agent).
 * The form (CLI / plugin) is not part of the identity: it is expressed by sourceForm / spec.kind
 * below, and whether something is a plugin is decided by shared.isPluginClient(form).
 * A spec.client override is allowed (rare), but never synthesize an `<agent>-plugin` identity —
 * the reported state file's client is the bare base name (see hookCommon's `client = ev.agent`).
 */
function sourceClient(p, spec) {
  return spec.client || p.agent;
}

/** The form of this path (cli / vscode / ide …): use the explicit value when given, otherwise derive it from kind; the hook path has no fixed form ('', both accepted) */
function sourceForm(spec) {
  if (spec.form) return spec.form;
  if (spec.kind === 'plugin') return 'vscode';
  if (spec.kind === 'cli') return 'cli';
  return '';
}

/** Candidate on-disk directories for this path (order is priority): the hook path has no directory; 'dir' uses explicit dirs */
function sourceDirs(p, spec) {
  if (spec.dirs && spec.dirs.length) return spec.dirs;
  if (spec.kind === 'hook') return [];
  if (spec.kind === 'kilo') return [];
  if (spec.kind === 'opencode') return [];
  if (spec.kind === 'lingma') return [];
  return [findDataPath(p, spec.kind === 'plugin')];
}

/** Empty stats (placeholder when there is no on-disk directory; same fields as scanDataDir) */
const NO_STATS = { files: 0, sessions: 0, bytes: 0, sizeLabel: '0 B', lastModifiedAt: null };

/**
 * Whether sessions can actually be **read out** of this path's on-disk data —— say so plainly when not.
 * @returns {string} explanatory copy; empty string when no explanation is needed
 */
function sourceNote(kind, dataPath) {
  if (kind !== 'plugin' || !dataPath) return '';
  if (isDir(path.join(dataPath, 'genie-history'))) return '';
  return `${shorten(dataPath)} 里没有 genie-history 这类会话索引，只有产品自己的运行时文件 —— 这一路取不到会话（会话 id、运行态都读不到）`;
}

/**
 * Description of one source: kind + client + on-disk directory + on-disk stats (the hook source has
 * no on-disk directory of its own).
 */
function detectSource(p, spec, clients) {
  const dataPath = sourceDirs(p, spec).find((d) => d && isDir(d)) || '';
  return {
    kind: spec.kind,
    label: spec.label || '',
    // client is always the floor base name; the form goes into form separately (consumers use
    // isPluginClient(form) to detect plugins)
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

/* ============================================================== Floor metadata aggregation */

/**
 * Product metadata is no longer hardcoded: each floor exports `meta` from its own file
 * (server/src/<product>.js), and this only aggregates from the floor registry.
 * @returns {Array}
 */
function floorMetas() {
  // Ascending floor id, so the 1F…9F order stays stable (both the UI and snapshots depend on it)
  return Object.keys(floors)
    .sort()
    .map((id) => floors[id].meta);
}

/** Detect every floor; force skips the cache and rescans the disk */
function detectProducts({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.products.length && now - cache.at < TTL) return cache.products;
  const products = floorMetas().map(detectOne);
  cache = { at: now, products };
  return products;
}

/** Scanning the disk is not cheap, so results are cached for 60 seconds */
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
  return /** @type {Array<any>} */ (Object.values(floors)).filter((f) => typeof f.syncTasks === 'function');
}

/* ============================================================== Static subagent aggregation */

/**
 * Agent directory list for a given client (floor base name); when client is omitted all floors are
 * aggregated. Order is priority (project before user within a floor; 1F…9F across floors).
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
 * subagent level (user / project). With a client, only that floor's directories are searched; without
 * one, all floors are aggregated. null when unavailable (ordinary members / demo data wear no level
 * badge).
 * @param {string} name
 * @param {string} workspacePath
 * @param {string} [client]
 * @returns {'project'|'user'|null}
 */
function detectLevel(name, workspacePath, client) {
  return detectLevelInDirs(name, workspacePath, dirsForClient(client, workspacePath));
}

/**
 * subagent functional description (static data from the agent definition file). With a client, only
 * that floor's directories are searched; without one, all floors are aggregated and the first hit
 * wins. Empty string when unavailable (the render layer hides that field accordingly).
 * @param {string} name
 * @param {string} workspacePath
 * @param {string} [client]
 */
function agentDescription(name, workspacePath, client) {
  return descriptionInDirs(name, workspacePath, dirsForClient(client, workspacePath));
}

/**
 * Floors that sync their own user / project subagents into the roster.
 *
 * A floor opts in by exporting `syncAgents(ctx)` (built with agentLevel.makeAgentSync from its own
 * `agentDirs`): it scans its own dirs, diffs against what it registered last time for the current
 * project, and calls the upper layer's register / unregister callbacks. The server's unified poller
 * drives them (see poller.js) — floors hold no timers.
 * @returns {Array<object>} floor modules that participate in agent sync
 */
function agentSyncerFloors() {
  return /** @type {Array<any>} */ (Object.values(floors)).filter((f) => typeof f.syncAgents === 'function');
}

/* ============================================================== Exports */

module.exports.FLOOR_CONTRACT = FLOOR_CONTRACT;
module.exports.floors = floors;
module.exports.floorOf = floorOf;
module.exports.floorByAgent = floorByAgent;
module.exports.detectProducts = detectProducts;
module.exports.taskSyncerFloors = taskSyncerFloors;
module.exports.agentSyncerFloors = agentSyncerFloors;
module.exports.detectLevel = detectLevel;
module.exports.agentDescription = agentDescription;

// Plugin source on-disk windows (shared with sessions.js)
module.exports.IDLE_MS = IDLE_MS;
module.exports.BUSY_MS = BUSY_MS;
module.exports.FRESH_MS = FRESH_MS;
module.exports.LISTED_MS = LISTED_MS;
module.exports.DONE_TTL_MS = DONE_TTL_MS;
