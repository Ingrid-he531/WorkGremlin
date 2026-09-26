'use strict';

/**
 * 楼层 = 受监控的产品源。
 *   1F  CodeBuddy（CLI 与 Plugin 合并：同一产品的两种形态，合成一层）
 *   2F  WorkBuddy CLI
 *   3F  Codex（CLI 与 IDE 同 ~/.codex、同 hook，分不出，合并单楼层）
 *   4F  Claude Code（CLI 与 IDE 同 ~/.claude、同 hook，分不出，合并单楼层）
 *   5F  TraeCode（IDE 与 Plugin 合并：会话来自 hook 状态文件；插件落盘取不到会话，见下）
 *
 * **CodeBuddy 只有一层**（1F）：CLI 与 Plugin 是同一个产品的两种形态 —— CLI 落 `~/.codebuddy`
 * （会话 jsonl / hook 状态文件），Plugin 落编辑器的 globalStorage（genie-history / todos /
 * message-queue / file-changes 这套结构化目录，见 server/src/sessions.js 的 listSessions）。
 * 以前按"来源身份"把它硬拆成 1F CLI + 3F Plugin 两层，于是同一个产品在同一间办公室占两层，
 * 而"到底有几个在跑"其实是**会话**的事。现在合成一层：这一层的 `sources` 把两处落盘都扫一遍、
 * `clients` 照收 codebuddy 与 codebuddy-plugin 两种上报身份。同时开着 CLI 与 Plugin 时，
 * 表现是**这一层里的两条会话**（靠 session_id 区分），不是两个楼层。
 *
 * **TraeCode 也只有一层**（5F）：IDE（`~/.trae-cn`）与插件（`~/.marscode`）是同一个产品，
 * 以前拆成 5F Plugin / 6F IDE 两层。合并后**两处落盘都列出来**（kind 'dir'，只作展示），
 * 会话来源则是 reporter hook 的状态文件 —— TraeCode 两个形态都没有可扫的**会话**落盘：
 *   · `~/.trae-cn/memory/projects/<工程>/<日期>/session_memory_<会话>.jsonl` 与
 *     `project_memory.md`：**记忆**文件（文件名带 session_id，但它不是对话记录、没有工程路径，
 *     不足以当会话行用），另外还有 extensions / plugins / mcps 这些安装目录；
 *   · `~/.marscode`：插件自己的运行时（ai-chat 二进制、日志、`ai-agent/database.db` 与
 *     `snapshot/<链 id>/v2/.git` 文件快照 —— 前者不是可读的 sqlite，后者是逐轮改动的 git 快照）。
 * 所以这两路都**取不到会话**，只作落盘展示，并在楼层胶囊的 tooltip 里各带一句说明
 * （见 detectSource 的 label / note）。
 *
 * Claude Code 同理只有一层（4F）：CLI 与 IDE 插件共用同一份 ~/.claude 配置、同一套 hook、
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
 * 一改就会把 5F 的落盘从 ~/.marscode 带偏到编辑器的 globalStorage 去。
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
 * 服务端却还在老根下找会话，4F 于是永远扫不到东西。这个根只留这一处定义。
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
              // 插件形态（5F TraeCode 的插件那一路）：MarsCode 数据根，内置 trae 插件就装在
              // ~/.marscode/builtin/trae，落盘也在它下面。
              // 命令形态（同一个 5F 的 IDE 那一路）：~/.trae（国际版）/ ~/.trae-cn（国内版）。
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
 * 约定：每个 agent 正常情况下一个楼层；合并楼层（下面 sources 里挂了多路落盘）另说。目前——
 *   - codebuddy：1F 一层（CLI + Plugin 合并，见文件头）
 *   - workbuddy：2F CLI（暂无 Plugin）
 *   - codex     ：3F（CLI 与 IDE 同 ~/.codex、同 hook，分不出，合并为单楼层）
 *   - claude    ：4F CLI（**只有这一层**，见文件头说明：plugin 与 CLI 同配置同 hook，分不出来）
 *   - trae      ：5F（IDE 与 Plugin 合并，见文件头：会话只能靠 hook 状态文件）
 * 要再加楼层（或把某产品的两种形态合并），只需在这里加/改一条 —— client、归层、过滤、
 * 会话来源、落盘扫描全部自动跟着走。
 *
 * 字段说明：
 *   - agent  产品基名（codebuddy / workbuddy / codex / claude / trae），落盘目录匹配用
 *   - dataKind  主 client，下发给前端当"楼层客户端"（办公室按它过滤成员）
 *   - pluginRe  插件目录名匹配（仅 plugin 楼层需要；CLI 楼层忽略）
 *   - sources   这一层的**会话/落盘来源**，可多路（合并楼层）：'cli' | 'plugin' | 'hook'。
 *               不写则按 kind / plugin / hookSource 推出一路（老行为）。
 *               clients（这一层接纳的上报身份）由 sources 反推、去重，第一路是主身份。
 */
const PRODUCTS = [
  {
    id: '1F',
    name: 'CodeBuddy',
    kind: 'cli',
    cmd: 'codebuddy',
    agent: 'codebuddy',
    plugin: false,
    pluginRe: RE_PLUGIN,
    // 合并楼层（见文件头）：
    //   cli    —— ~/.codebuddy 下的会话 jsonl（CLI 的历史落盘）
    //   plugin —— 编辑器 globalStorage 里的结构化落盘（genie-history / todos / …）
    //   hook   —— reporter 状态文件（CLI 常常没有可扫的会话落盘，状态文件里的 sessionId /
    //             workspacePath 是 hook payload 实测值，是"它正在跑"的唯一真值）
    // 三路都归这一层；同一会话被两路同时看到时按 session_id 去重（见 sessionRegistry）。
    sources: ['cli', 'plugin', 'hook'],
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
    name: 'Codex',
    kind: 'cli',
    cmd: 'codex',
    agent: 'codex',
    plugin: false,
    // 3F 是「CLI 与 IDE 合并」楼层（文件头：二者同 ~/.codex、同 hook，分不出来）。
    // 于是这层的"装了"不能只认 codex 可执行文件 —— 只装 VS Code 的 Codex/ChatGPT 扩展、
    // 或只用 ChatGPT 桌面版的人，命令行里根本没有 codex，但人家确实在跑（会话就是证据）。
    // altPluginRe：仅作安装证据补抓，不影响 kind / client / 会话来源。
    altPluginRe: RE_CODEX_HOST,
    dataKind: clientOf('codex', false),
  },
  {
    id: '4F',
    name: 'Claude Code',
    kind: 'cli',
    cmd: 'claude',
    agent: 'claude',
    plugin: false,
    dataKind: clientOf('claude', false),
  },
  {
    id: '5F',
    name: 'TraeCode',
    kind: 'cli',
    cmd: 'trae',
    // 国内版 TraeCode 桌面 IDE 的命令是 trae-cn（/usr/bin/trae-cn，没有独立的 trae CLI）；
    // 主命令搜不到时认它（插件形态由 runner 自带，没有独立可执行文件）。
    altCmd: 'trae-cn',
    agent: 'trae',
    plugin: false,
    pluginRe: /trae/i,
    // 合并楼层（见文件头）：IDE 与 Plugin 是同一个产品，两个形态的落盘都要列出来。
    //   dir(IDE)    —— ~/.trae-cn（国内版）/ ~/.trae（国际版）：memory/ 里是
    //                  session_memory_<会话>.jsonl 这类**记忆**文件 + project_memory.md，
    //                  不是对话记录，所以只作落盘展示、不当会话来源（见下面的 note）
    //   dir(plugin) —— ~/.marscode：插件自己的运行时（没有会话索引）
    //   hook        —— 会话来源就是 reporter 状态文件（sessionId / workspacePath 都是实测值）
    sources: [
      {
        kind: 'dir',
        label: 'IDE',
        client: clientOf('trae', false),
        dirs: [path.join(HOME, '.trae-cn'), path.join(HOME, '.trae')],
        note: '这一路只作落盘展示：memory/ 里是 session_memory_<会话>.jsonl 这类记忆文件与 project_memory.md，不是对话记录；会话列表由 hook 状态文件提供',
      },
      {
        kind: 'dir',
        label: 'plugin',
        client: clientOf('trae', true),
        dirs: [path.join(HOME, '.marscode')],
        note: '这一路只作落盘展示：目录里是插件自己的运行时（日志、ai-agent/ 的文件快照，以及读不出的 database.db），没有会话索引；会话列表由 hook 状态文件提供',
      },
      { kind: 'hook' },
    ],
    // 老口径的标记（sources 之前用它推来源）：会话只能靠 hook 状态文件 —— 这一层确实如此
    hookSource: true,
    dataKind: clientOf('trae', false),
  },
];

/**
 * 这一层吃哪几路会话/落盘来源。合并楼层显式挂多路；其余楼层按老口径推出一路，
 * 行为与改动前完全一致。
 *
 * 条目是**字符串**（只给 kind，老写法）或**对象**（合并楼层用得上）：
 *   { kind, label?, client?, dirs?, note? }
 *   · kind   'cli'（扫会话 jsonl）| 'plugin'（结构化落盘）| 'hook'（reporter 状态文件）
 *            | 'dir'（**只作落盘展示**，不产会话 —— 目录里有东西但读不出会话时用它）
 *   · label  前端悬浮提示里的显示名（'IDE' / 'plugin' …）；不给就按 kind 显示
 *   · client 这一路对应的上报身份；不给就按 kind 推（plugin → agent-plugin，其余 → agent）
 *   · dirs   显式落盘目录候选（同一形态可能有多处：国际版 ~/.trae / 国内版 ~/.trae-cn）
 *   · note   这一路读不出会话时的说明（悬浮提示里显示）
 * @returns {Array<{kind: string, label?: string, client?: string, dirs?: string[], note?: string}>}
 */
function sourceSpecs(p) {
  const raw = p.sources && p.sources.length ? p.sources : p.hookSource ? ['hook'] : p.plugin ? ['plugin'] : ['cli'];
  // 老写法是一串 kind：按 kind 去重保序（对象写法可以挂两路同 kind 的 dir，不去重）
  if (raw.some((s) => typeof s !== 'string')) return raw.map((s) => ({ ...(typeof s === 'string' ? { kind: s } : s) }));
  return [...new Set(raw)].map((kind) => ({ kind }));
}

/** 这一路的上报身份：显式给了就用它，否则按 kind 推（plugin → agent-plugin，其余 → agent） */
function sourceClient(p, spec) {
  return spec.client || clientOf(p.agent, spec.kind === 'plugin');
}

/** 这一路的落盘目录候选（顺序即优先级）：hook 没有落盘目录；'dir' 用显式 dirs */
function sourceDirs(p, spec) {
  if (spec.dirs && spec.dirs.length) return spec.dirs;
  if (spec.kind === 'hook') return [];
  return [findDataPath(p.agent, spec.kind === 'plugin')];
}

/** 空统计（没有落盘目录时的占位，字段与 scanDataDir 一致） */
const NO_STATS = { files: 0, sessions: 0, bytes: 0, sizeLabel: '0 B', lastModifiedAt: null };

/**
 * 这一路落盘**能不能读出会话** —— 不能就明说，别让人以为"没数据是没跑过"。
 *
 * 判据很窄：插件的结构化会话索引是 `genie-history`（见 sessions.js 的 listSessions，
 * 会话 id、当前会话、待办、改动文件都挂在它下面）。没有这个目录，这一路就取不到会话。
 * 实测 TraeCode 插件（`~/.marscode`）正是这样：只有插件自己的运行时（ai-chat 二进制、
 * 日志、`ai-agent/database.db` 与 `snapshot/<链 id>/v2/.git` 文件快照）——前者不是可读的
 * sqlite，后者是逐轮改动的 git 快照、不是会话索引，所以会话只能靠 hook 那一路。
 * @returns {string} 说明文案；不需要说明时回空串
 */
function sourceNote(kind, dataPath) {
  // 只对"有落盘目录、但目录里没有会话索引"的插件来源补一句说明；
  // hook 那一路没有落盘目录（会话就是状态文件本身），由前端固定文案交代，不在这里重复。
  if (kind !== 'plugin' || !dataPath) return '';
  if (isDir(path.join(dataPath, 'genie-history'))) return '';
  return `${shorten(dataPath)} 里没有 genie-history 这类会话索引，只有产品自己的运行时文件 —— 这一路取不到会话（会话 id、运行态都读不到）`;
}

/**
 * 一路来源的描述：kind + client + 落盘目录 + 落盘统计（hook 来源没有自己的落盘目录）。
 * @param {string[]} clients 这一层接纳的全部上报身份 —— hook 那一路要按**整层**过滤：
 *   会话就是状态文件本身，合并楼层的两种身份（trae / trae-plugin、codebuddy / codebuddy-plugin）
 *   都属于这一层。单独传一个 client 会让"插件形态跑在 IDE 里"的那种会话漏掉。
 */
function detectSource(p, spec, clients) {
  // 目录候选里取第一个真实存在的（~/.trae-cn 与 ~/.trae 只会有一个）
  const dataPath = sourceDirs(p, spec).find((d) => d && isDir(d)) || '';
  return {
    kind: spec.kind,
    /** 前端显示名（'IDE' / 'plugin' …）；空则由前端按 kind 显示 */
    label: spec.label || '',
    client: spec.kind === 'hook' ? clients.join(',') : sourceClient(p, spec),
    /** 这一路产不产会话：'dir' = 只作落盘展示（目录里有东西，但读不出会话） */
    sessions: spec.kind !== 'dir',
    dataPath,
    dataPathLabel: shorten(dataPath),
    stats: dataPath ? scanDataDir(dataPath) : { ...NO_STATS },
    /** 这一路取不到会话时的说明（楼层胶囊 tooltip 里显示）；能取到 / 没目录就是空串 */
    note: dataPath ? spec.note || sourceNote(spec.kind, dataPath) : '',
  };
}

function detectOne(p) {
  const specs = sourceSpecs(p);
  // 这一层接纳的上报身份（去重保序）：由各来源的形态反推，第一路是主身份
  const clients = [...new Set(specs.map((spec) => sourceClient(p, spec)))];
  const sources = specs.map((spec) => detectSource(p, spec, clients));
  const hasPluginSource = specs.some((spec) => spec.kind === 'plugin');
  const installPath =
    (p.cmd ? resolveCommand(p.cmd) || findCliBin(p.cmd) : '') ||
    // 备用命令（5F TraeCode：国内版 IDE 的 trae-cn）——主命令搜不到时再认它。
    (p.altCmd ? resolveCommand(p.altCmd) || findCliBin(p.altCmd) : '') ||
    // 插件形态的安装证据：plugin 楼层看自己的 pluginRe；合并楼层（1F CodeBuddy）也认插件扩展
    // ——只装了 IDE 插件、没装 CLI 的人，这一层照样是"装了"（会话也确实在跑）。
    (p.plugin || hasPluginSource ? findPluginDir(p.pluginRe || RE_PLUGIN) : '') ||
    // 合并楼层（3F Codex）：命令行搜不到时，再认一次宿主扩展目录。
    // 不改 kind / client：这层本来就同时代表 CLI 与 IDE，只是我们抓不到可执行文件而已。
    (p.altPluginRe ? findPluginDir(p.altPluginRe) : '');
  // 主来源 = 老口径那一路（CLI 楼层取 cli、插件楼层取 plugin）；合并楼层没有那一路时，
  // 取第一个真的有落盘目录的（1F → cli 的 ~/.codebuddy，5F → IDE 的 ~/.trae-cn）。
  // dataPath / stats 沿用它的，保证前端悬浮提示、外层调用方的字段形状不变（多路清单在 sources 里）。
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
    /** 产品基名（codebuddy / workbuddy / codex / claude / trae）；落盘目录匹配用 */
    agent: p.agent,
    /** 主 client（上报身份）：前端当"楼层客户端"用；等于 clients[0] */
    dataKind,
    /** 这一层接纳的全部上报身份（合并楼层多个）：过滤相位 / 任务 / 成员时按它认 */
    clients,
    /** 插件目录名匹配（plugin 来源有意义；sessionRegistry 据此给 listSessions 传参） */
    pluginRe: p.pluginRe || null,
    /** 会话来源只有 reporter hook 状态文件（没有可扫的会话落盘），见 refresh 的对应分支 */
    hookSource: Boolean(p.hookSource),
    /**
     * 会话 / 落盘来源清单（合并楼层多路）：
     * [{ kind, client, dataPath, dataPathLabel, stats, note }]。
     * sessionRegistry 按它逐路取会话；前端悬浮提示按它逐路显示落盘信息，
     * note 非空 = 这一路读不出会话（照实说明，别让人误以为"没跑过"）。
     */
    sources,
    // 装没装只看**安装位置**：CLI 得找到可执行文件，插件得找到扩展目录。
    // 落盘目录不算证据 —— 我们自己的 hooks 安装脚本会给没装的产品写一份
    // settings.json 顺手造出一个目录（~/.workbuddy），拿它当证据等于自己骗自己。
    installed: Boolean(installPath),
    installPath,
    installPathLabel: shorten(installPath),
    dataPath: primary.dataPath,
    dataPathLabel: primary.dataPathLabel,
    stats: primary.stats,
  };
}

/** 探测所有楼层；force 可跳过缓存重新扫盘 */
function detectProducts({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.products.length && now - cache.at < TTL) return cache.products;
  const products = PRODUCTS.map(detectOne);
  cache = { at: now, products };
  return products;
}

module.exports = { detectProducts, PRODUCTS, shorten, humanSize, traeGlobalStorageRoots, claudeHome };
