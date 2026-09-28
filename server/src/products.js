'use strict';

/**
 * 楼层 = 受监控的产品源。
 *   1F  CodeBuddy（CLI 与 Plugin 合并：同一产品的两种形态，合成一层）
 *   2F  WorkBuddy
 *   3F  Codex（CLI 与 IDE 同 ~/.codex、同 hook，分不出，合并单楼层）
 *   4F  Claude Code（CLI 与 IDE 同 ~/.claude、同 hook，分不出，合并单楼层）
 *   5F  TraeCode（IDE 与 Plugin 合并：会话来自 hook 状态文件；插件落盘取不到会话，见下）
 *   6F  Qoder（CLI 与插件合并：同 ~/.qoder | ~/.qoder-cn、同 hook、同 transcript，分不出，合并单楼层，类 4F）
 *   7F  Kilo Code（CLI 与 IDE 扩展合并：同一个 kilo 二进制、同一个数据根，分不出，合并单楼层。
 *                  **纯轮询楼层**（与 8F OpenCode 同类）：Kilo 没有 hook 子系统，会话/相位/完成标记
 *                  全部由服务端轮询它自己的 event-sourced SQLite 推导，见 server/src/kilo.js）
 *   8F  OpenCode（CLI 与桌面端/网页端合并：同一个 opencode 二进制、同一个数据根）
 *
 * **CodeBuddy 只有一层**（1F）：CLI 与 Plugin 是同一个产品的两种形态 —— CLI 落 `~/.codebuddy`
 * （会话 jsonl / hook 状态文件），Plugin 落编辑器的 globalStorage（genie-history / todos /
 * message-queue / file-changes 这套结构化目录，见 server/src/sessions.js 的 listSessions）。
 * 以前按"来源身份"把它硬拆成 1F CLI + 3F Plugin 两层，于是同一个产品在同一间办公室占两层，
 * 而"到底有几个在跑"其实是**会话**的事。现在合成一层：这一层的 `sources` 把两处落盘都扫一遍、
 * `clients` 照收 codebuddy 与 codebuddy-plugin 两种上报身份。同时开着 CLI 与 Plugin 时，
 * 表现是**这一层里的两条会话**（靠 session_id 区分），不是两个楼层。
 *
 * **TraeCode 也只有一层**（5F）：IDE（`~/.trae-cn`）与插件（`~/.marscode`）是同一个产品的两种形态，
 * 以前拆成 5F Plugin / 6F IDE 两层。合并后**两路落盘都列出来**（kind 'dir'，只作展示），
 * 会话来源则是 reporter hook 的状态文件 —— TraeCode 两个形态都没有可扫的**会话**落盘：
 *   · `~/.trae-cn/memory/projects/<工程>/<日期>/session_memory_<会话>.jsonl` 与
 *     `project_memory.md`：**记忆**文件（文件名带 session_id，但它不是对话记录、没有工程路径，
 *     不足以当会话行用），另外还有 extensions / plugins / mcps 这些安装目录；
 *   · `~/.marscode`：插件自己的运行时。会话数据在 `ai-agent/database.db` 里，实测是**加密**数据
 *     （非 SQLite，打不开）；`snapshot/<链 id>/v2/.git` 只是逐轮改动的 git 快照、不是会话索引；
 *     插件侧 hook（`~/.marscode/hooks.json`）实测也不生效 —— 所以**插件这一形态目前不支持会话**，
 *     保留这一路只为交代清"这层是两形态产品"，等以后有可读落盘再接。
 * 两路都**不带 note**（tooltip 只列目录与落盘统计）：形态靠上报身份（client）就分得开，
 * 任务列表里分别叫 TraeCode IDE / TraeCode Plugin（见 renderer/src/lib/clientMatch.js 的 CLIENT_LABELS）。
 *
 * Claude Code 同理只有一层（4F）：CLI 与 IDE 插件共用同一份 ~/.claude 配置、同一套 hook、
 * 同一个落盘目录（~/.claude/projects），连二进制都是同一份 —— 事件 payload 里没有任何字段能
 * 区分二者（实测 2.1：不含 client，只有 session_id / cwd / transcript_path 这类共用字段）。
 * 既然"分不出"，就不该硬拆两层。**形态**另说：这两个形态是同一层里的两条会话，
 * 任务行上的 form（hook 从 transcript 的 entrypoint 认出来，见 hook.js 的 claudeForm）
 * 标得出这一轮是 CLI 还是 VS Code 扩展 —— 那是任务列表的事，与楼层无关。
 *
 * **OpenCode 家族（7F Kilo Code / 8F OpenCode）也各只有一层**，而且是同一个理由的第三次复现，
 * 证据链（实测 2026-09-26，本机 Kilo Code 7.8.1 / OpenCode 2.0.18）：
 *   · **Kilo Code CLI 就是 OpenCode 的 fork**。落盘结构一模一样：
 *     `~/.local/share/{kilo,opencode}/` 下都是 `<名>.db` + `storage/session_diff/` + `repos/`
 *     + `shell/` + `snapshot/` + `log/` —— 连 Kilo 的日志目录里都直接躺着一个 `opencode.log`。
 *     会话表 Kilo 叫 `session`、OpenCode V2 叫 `session_v2`（字段几乎同构）。
 *   · **Kilo 的 VS Code 扩展（kilocode.kilo-code）不另起一份数据**：扩展目录里自带
 *     `bin/kilo`，用 `spawn(cliPath, ["serve","--port","0"])` 起的就是同一个 CLI server，
 *     只多带 `KILO_CLIENT=vscode` / `KILOCODE_FEATURE=vscode-extension` / `KILO_PLATFORM=vscode`，
 *     **不覆盖 `XDG_DATA_HOME` / `KILO_CONFIG_DIR`** → 共用 `~/.local/share/kilo/kilo.db`、
 *     共用 `~/.config/kilo/kilo.jsonc`。扩展也不写编辑器 globalStorage
 *     （实测 `~/.config/Code/User/globalStorage` 下没有它的目录）。
 *   · **会话行里也没有平台字段**（`metadata` 只有 `kilocode.sandbox`），所以连"按行认形态"都做不到。
 *   → 同 4F Claude / 6F Qoder：一个 agent 基名 = 一个 client = 一个楼层；CLI 与 IDE 的区分留给上游。
 *
 * 这两层**没有 jsonl transcript**（与 1F~4F、6F 的最大不同），会话来源是新增的 `db` 一路：
 * 只读 SQLite 会话表（见 server/src/ingest/sessionDb.js）。实时相位那一路是 `hook`，
 * 由 WorkGremlin 的 OpenCode 插件写状态文件（见 packages/reporter/src/plugin/）。
 * 没装插件时 `hook` 那一路空着，7F/8F 照样按落盘列出会话，只是相位显示「未上报」。
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
// Kilo Code 的数据根（XDG 位置）—— 与 server/src/kilo.js 同源，别在这里另写一份
const { kiloHome } = require('./kilo');
// 8F OpenCode 的数据根 —— 同理，与 server/src/opencode.js 同源
const { opencodeHome } = require('./opencode');

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

/**
 * 额外搜索范围（配置文件 + 环境变量，二者并存、拼接去重）。不同 IDE 的插件装在各自目录，
 * 默认只认一批常见编辑器，认不到（JetBrains / Zed / Neovim / 其他非标编辑器）时靠它扩范围。
 *   · 配置文件：~/.workgremlin/products.overrides.json（见 workgremlinHome），字段：
 *       extensionDirs      —— 额外编辑器根目录（自动拼 extensions/；直接给 extensions 目录也认）
 *       globalStorageDirs —— 额外编辑器 globalStorage 目录（直接给目录）
 *       dataRoots         —— 额外平台数据根（Application Support / APPDATA 同类）
 *       cliBinDirs        —— 额外 CLI 可执行文件目录（自定义 npm 前缀、/opt 里的 .deb 等）
 *   · 环境变量（更即时、适合临时注入，与配置文件字段一一对应）：
 *       WORKGREMLIN_EXTENSION_DIRS / WORKGREMLIN_GLOBALSTORAGE_DIRS / WORKGREMLIN_DATA_ROOTS
 *       / WORKGREMLIN_CLI_BIN_DIRS（均为冒号分隔）
 * 见下方 extensionRoots / globalStorageRoots / dataRoots / CLI_BIN_DIRS 的引用点。
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

/** 把开头的 ~ 展开成家目录（配置里写 ~/xxx 是常见习惯，不展开会被当字面量） */
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
  // 配置注入的额外数据根（不同 IDE 的非标数据位置）
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
    // Qoder 编辑器（若装了本体）的扩展也落自家 extensions 目录（对称 Trae 的 .trae[-cn]）
    '.qoder',
    '.qoder-cn',
    '.windsurf',
    '.vscode-server',
    // MarsCode（火山引擎 IDE）的扩展装在自家的 builtin 目录里，不在标准 extensions 下。
    // TraeCode 就是它的内置插件：~/.marscode/builtin/trae，所以这里也要认。
  ].map((d) => path.join(HOME, d, 'extensions'));
  // 配置注入的额外编辑器根目录：自动拼 extensions/；若给的就是 extensions 目录本身也认
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

/**
 * XDG 数据根（OpenCode 家族的数据落在这套约定下，不在 ~/.codebuddy 那种家目录隐藏目录里）。
 *
 * 认 `XDG_DATA_HOME` 是因为 Kilo 与 OpenCode **都**认它（实测二进制里有这个变量，
 * 扩展起 server 时原样透传），设过的人数据根就跟着搬走了。顺序：
 *   1. $XDG_DATA_HOME/<名>
 *   2. 平台约定的应用数据根（macOS 的 ~/Library/Application Support、Win 的 %APPDATA%）—— dataRoots()
 *   3. Linux 的 ~/.local/share/<名>（兜底；dataRoots() 里已有，这里补的是"目录还不存在"的情形，
 *      因为上面几步都只认**已经存在**的目录，而"没建过数据根"正是最该被认出来的状态）
 *
 * 只给候选、不判断存在 —— 存在性由调用方 firstExisting / firstMatch 负责。
 * @param {string} name 数据根目录名（kilo / opencode）
 * @returns {string[]}
 */
function xdgDataDirs(name) {
  const out = [];
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) out.push(path.join(xdg, name));
  for (const r of dataRoots()) out.push(path.join(r, name));
  // Linux 桌面版的默认位置，显式补一份（dataRoots() 在 Linux 上给的是 ~/.local/share）
  if (process.platform === 'linux') out.push(path.join(HOME, '.local', 'share', name));
  return out;
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
  // 配置注入的额外 globalStorage 目录（直接给目录，覆盖非标 IDE 的插件落盘点）
  for (const d of extraDirs('globalStorageDirs', 'WORKGREMLIN_GLOBALSTORAGE_DIRS')) if (isDir(d)) out.push(d);
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
 * TraeCode 家族的 logs 根。新版 Trae 把「会话 → 当前选中模型」搬进了内存态 store +
 * 加密库（ModularData/ai-agent/database.db），state.vscdb 里那条
 * `<uid>:AI.agent.model.session_selected_model` 不再写 —— renderer.log 的
 * model-store 事件成了唯一明文来源，成对放在这里，别劈进 traeModels.js。
 */
function traeLogRoots() {
  const out = [];
  for (const r of dataRoots()) {
    for (const ed of ['Trae', 'Trae CN']) {
      const p = path.join(r, ed, 'logs');
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
  // OpenCode 官方安装脚本把二进制放在 ~/.opencode/bin（实测 2.0.18 就在这儿，200MB 单文件），
  // 它**不在 PATH 里**，不认这一条 8F 的"装了没装"就永远判不出来。
  // Kilo 的 CLI 是 npm 全局包（在 nvm bin 里，下面那条已经覆盖），但 ~/.kilo/bin 也一并认上。
  path.join(HOME, '.opencode', 'bin'),
  path.join(HOME, '.kilo', 'bin'),
  // Qoder（6F）自带启动器：二进制在 ~/.qoder[-cn]/entry/qoder[-cn]（国内版实测 ~/.qoder-cn/entry/qoder-cn，
  // 国际版对称 ~/.qoder/entry/qoder）。桌面/GUI 拉起的 server 进程 PATH 里通常没有这个 entry 目录，
  // 不认这两条的话，"装了没装"在图形会话里永远判不出来（终端里能、UI 里不行，就是这个坑）。
  path.join(HOME, '.qoder', 'entry'),
  path.join(HOME, '.qoder-cn', 'entry'),
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
  // 配置注入的额外 CLI bin 目录（自定义 npm 前缀、/opt 里的 .deb、其他非标安装位置）：
  //   products.overrides.json 的 cliBinDirs 字段 / WORKGREMLIN_CLI_BIN_DIRS 环境变量
  ...extraDirs('cliBinDirs', 'WORKGREMLIN_CLI_BIN_DIRS'),
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
const RE_GITHUB_COPILOT = [/^github\.copilot/i, /^github-copilot/i, /^github\.copilot-chat/i, /^copilot/i];
/** Codex 的宿主扩展目录名：VS Code 里的 openai.chatgpt-* / openai.codex-*（它们自带 codex） */
const RE_CODEX_HOST = [/^openai\.(chatgpt|codex)/i];
/** Claude Code 的 VS Code 扩展目录名：anthropic.claude-code-<版本>（4F 合并楼层的插件安装证据） */
const RE_CLAUDE_HOST = [/^anthropic\.claude/i];
const RE_CLAUDE = [/^claude/i];
const RE_TRAE = [/^trae/i];
/** 7F Kilo Code：CLI 叫 kilo（也提供 kilocode 这个别名，二者同一个二进制） */
const RE_KILO = [/^kilo(code)?$/i];
/** Kilo 的 VS Code 扩展目录名：kilocode.kilo-code-<版本>-<平台> */
const RE_KILO_HOST = [/^kilocode\./i];
/** 8F OpenCode */
const RE_OPENCODE = [/^opencode$/i];
const RE_PLUGIN = [/codebuddy/i, /tencent/i, /ingram/i, /code-?buddy/i];

/** 在某个根目录下找名字命中的子项（只看一层，快） */
function matchIn(root, res) {
  // res 可能是单个正则（某产品的 pluginRe，如 /trae/i）或正则数组：统一成数组再比较优先级。
  // 关键修正：原来只要它命中就返回，`/copilot/i` 会把 `tencent-cloud.coding-copilot` 和
  // `github.copilot-chat` 一起命中，盘符遍历顺序不同就会偶发选到旧目录，9F 胶囊就不亮。
  // 这里按“最具体的匹配规则优先”选：GitHub 相关目录排在通配 `/copilot/i` 前面。
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
            : kind === 'kilo'
              ? RE_KILO
              : kind === 'opencode'
                ? RE_OPENCODE
                : kind === 'copilot'
                  ? RE_GITHUB_COPILOT
                  : RE_CODEBUDDY;
  const homeDirs =
    kind === 'workbuddy'
      ? [path.join(HOME, '.workbuddy')]
      : kind === 'codex'
        ? [path.join(HOME, '.codex')]
        : kind === 'claude'
          ? [claudeHome()]
          : kind === 'kilo'
            ? xdgDataDirs('kilo')
            : kind === 'opencode'
              ? xdgDataDirs('opencode')
              : kind === 'trae'
                ? plugin
                  // 插件形态（5F TraeCode 的插件那一路）：MarsCode 数据根，内置 trae 插件就装在
                  // ~/.marscode/builtin/trae，落盘也在它下面。
                  // 命令形态（同一个 5F 的 IDE 那一路）：~/.trae（国际版）/ ~/.trae-cn（国内版）。
                  ? [path.join(HOME, '.marscode'), path.join(HOME, '.trae-cn'), path.join(HOME, '.trae')]
                  : [path.join(HOME, '.trae'), path.join(HOME, '.trae-cn')]
                : kind === 'copilot'
                  ? [path.join(HOME, '.config', 'Code', 'User', 'globalStorage')]
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

/** 找插件 globalStorage 目录（扩展目录搜不到时的兜底安装证据）。res 同上。 */
function findPluginStorageDir(res = RE_PLUGIN) {
  return firstMatch(globalStorageRoots(), res);
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
    // 胶囊上只写产品名（跟 1F CodeBuddy / 5F TraeCode 一致）：它只有 CLI 一个形态，
    // 没必要把"CLI"挂在楼层名上；上报身份仍是 client=workbuddy（见 shared 的合同）
    name: 'WorkBuddy',
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
    // 只有一路 cli（~/.codex）：CLI 与 IDE 插件共用同一份落盘、同 hook，分不出，所以这一路
    // 同时代表两种形态 —— tooltip 里直接标 'CLI/Plugin'，别让人以为这层只认命令行
    // （1F 是显式挂了 cli + plugin 两路，由前端合成这个叫法；这层只有一路，所以在来源上标）。
    sources: [{ kind: 'cli', label: 'CLI/Plugin' }],
    dataKind: clientOf('codex', false),
  },
  {
    id: '4F',
    name: 'Claude Code',
    kind: 'cli',
    cmd: 'claude',
    agent: 'claude',
    plugin: false,
    // 同 3F Codex：命令行里搜不到 claude 时，再认一次 VS Code 的 Claude Code 扩展
    // （anthropic.claude-code-*）作安装证据 —— 只装 IDE 扩展的人这一层照样"装了"。
    // altPluginRe 仅作安装证据补抓，不影响 kind / client / 会话来源。
    altPluginRe: RE_CLAUDE_HOST,
    // 只有一路 cli（~/.claude）：CLI 与 IDE 插件共用同一份配置、同一套 hook、同一份
    // transcript，**楼层**上分不出，所以这一路同时代表两种形态 —— tooltip 里标 'CLI/Plugin'（类 3F）。
    // 任务列表那一层分得出（transcript 的 entrypoint → form，见 hook.js 的 claudeForm）。
    sources: [{ kind: 'cli', label: 'CLI/Plugin' }],
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
    pluginRe: /trae|coding-copilot/i,
    // 合并楼层（见文件头）：IDE 与 Plugin 是同一个产品的两种形态，两个形态的落盘都要列出来。
    //   dir(IDE)    —— ~/.trae-cn（国内版）/ ~/.trae（国际版）：memory/ 里是
    //                  session_memory_<会话>.jsonl 这类**记忆**文件 + project_memory.md，
    //                  不是对话记录，所以只作落盘展示、不当会话来源（任务列表里这一形态叫 TraeCode IDE）
    //   dir(plugin) —— ~/.marscode：插件自己的运行时。**目前不支持会话**：会话数据在
    //                  ai-agent/database.db 里，实测是加密数据（非 SQLite，打不开），
    //                  snapshot/<链 id>/v2/.git 只是逐轮 git 快照、不是会话索引，插件侧 hook
    //                  （~/.marscode/hooks.json）实测也不生效 —— 保留这一路只为交代清"这层是两形态
    //                  产品"，等插件有了可读落盘再接会话（任务列表里这一形态叫 TraeCode Plugin）
    //   hook        —— 会话来源就是 reporter 状态文件（sessionId / workspacePath 都是实测值）
    sources: [
      {
        kind: 'dir',
        label: 'IDE',
        client: clientOf('trae', false),
        dirs: [path.join(HOME, '.trae-cn'), path.join(HOME, '.trae')],
      },
      {
        kind: 'dir',
        label: 'plugin',
        client: clientOf('trae', true),
        dirs: [path.join(HOME, '.marscode')],
      },
      { kind: 'hook' },
    ],
    // 老口径的标记（sources 之前用它推来源）：会话只能靠 hook 状态文件 —— 这一层确实如此
    hookSource: true,
    dataKind: clientOf('trae', false),
  },
  {
    id: '6F',
    name: 'Qoder',
    kind: 'cli',
    cmd: 'qoder',
    // 国内版 Qoder 的命令是 qoder-cn（实测 ~/.qoder-cn/entry/qoder-cn，PATH 里没有 qoder）；
    // 主命令搜不到时认它（类 5F TraeCode 的 trae-cn）。
    altCmd: 'qoder-cn',
    agent: 'qoder',
    plugin: false,
    // 插件形态的安装证据：Qoder 国内版的编辑器插件以 tongyi-lingma（通义灵码）发布 ——
    // 扩展 displayName 实测就是 "Qoder CN (Formerly Lingma)"（~/.vscode/extensions/alibaba-cloud.tongyi-lingma-*）。
    // 仅补安装证据（类 3F/4F 的 altPluginRe），不影响 kind / client / 会话来源。
    altPluginRe: /tongyi-lingma/i,
    // Qoder 的 CLI 与插件（qoder-context 等）共用同一份配置、同一套 hook、同一个落盘目录
    // （~/.qoder 与 ~/.qoder-cn/projects/<工程>/…），分不出，合并单楼层（类 4F Claude）。
    // 国际版装 ~/.qoder、国内版装 ~/.qoder-cn（两者可能只装其一，dirs 按序取第一个存在的）。
    // 所以 6F 走「cli 扫 transcript + hook 实时相位」两路：
    //   cli   —— <家>/projects/<工程>/<会话>.jsonl（Claude Code 同款格式：各带 sessionId 与 cwd，
    //            文件名即 session_id；会话来自落盘，工程路径从 cwd 解析；见 sessionRegistry 的 SUBTREE/sessionIdOfFile）
    //   hook  —— reporter 状态文件兜底（jsonl 还没写/读不出时，hook 那一路照常列会话并提供实时相位）
    // 两路按 session_id 去重（见 sessionRegistry 的 claim / cliLandingSeen：cli 有活会话就撤掉 hook 行）。
    sources: [
      {
        kind: 'cli',
        label: 'CLI/Plugin',
        client: clientOf('qoder', false),
        dirs: [path.join(HOME, '.qoder'), path.join(HOME, '.qoder-cn')],
      },
      { kind: 'hook' },
    ],
    hookSource: true,
    dataKind: clientOf('qoder', false),
  },
  {
    id: '7F',
    name: 'Kilo Code',
    kind: 'cli',
    cmd: 'kilo',
    // 产品基名：上报身份 client=kilo（shared 的 clientOf 合同，见 shared/index.js）
    agent: 'kilo',
    plugin: false,
    // 同 3F/4F：VS Code 扩展 kilocode.kilo-code-* 也是这一层的安装证据（RE_KILO_HOST，
    // 之前定义了却没用上）。altPluginRe 仅补安装证据，不影响 kind / client / 会话来源。
    altPluginRe: RE_KILO_HOST,
    // Kilo Code（7F）是**两路**楼层（与 8F OpenCode 同类，取法各自不同）：
    //   · CLI / TUI（没装 WorkGremlin 插件）：纯轮询，从它自己的 event-sourced SQLite 推导
    //     （见 server/src/kilo.js）。Kilo 没有 hook 子系统（实测 7.8.1 —— 没有 hooks.json、
    //     没有任何可挂命令的事件点），所以这一路既没有 hook 上报，也没有可扫的会话 jsonl：
    //     会话、相位、完成标记全部由服务端轮询它自己的库推导，恒带 inferred。
    //   · VS Code 扩展（装了 WorkGremlin 插件）：插件订阅 Kilo 的内存事件流，把相位/完成标记
    //     写成 reporter 状态文件（见 packages/reporter/src/plugin/）。那是**上报真值**
    //     （不标 inferred、UI 不灰显），而且只有它能给「等待授权」—— Kilo 的 tool 状态
    //     实测也只有 completed / error / running，没有 pending，轮询同样推不出等授权。
    //     插件实例的上报身份是 kilo-plugin（扩展起 server 时带 KILO_CLIENT=vscode 等，
    //     见 plugin/index.js 的 resolveClient），与 CLI 的 kilo 分开。
    // 两路的会话都来自同一个 kilo.db（扩展不另起数据，见文件头），按 session_id 去重。
    // 唯一一路来源：
    //   kilo —— 轮询数据根里的 kilo.db（session + event + message 三张表）产会话，同时带上
    //           数据根（XDG 位置，见 kilo.js 的 kiloHome）作落盘统计：目录里有日志/快照/会话库，
    //           但会话不是"扫文件"能得到的，所以那一行的文件数/体积只作展示（见下面的 note）。
    //   hook —— 装了插件时的真相位一路（client=kilo-plugin）。
    // label 标 'CLI/Plugin'：这一层同时代表 Kilo Code 的 CLI 与 VS Code 扩展 ——
    // 扩展自带同一个二进制、共用同一个数据根（见文件头），落盘里没有平台字段可分。
    // kind 用 'kilo' 而不是复用 'cli'：CLI 那一路是"扫 *.jsonl"，Kilo 是"读 SQLite"，
    // 两种完全不同的取法，别让 sessionRegistry 里两条分支互相误认。
    // 顺序：kilo（轮询，永远在场）→ hook（插件在场时的真相位）。
    // **hook 放后面是有意的**：sessionRegistry 里 claim() 先到先得，而 hook 那一支
    // 沿用 1F~6F 的老约定 —— 它的会话行只报 phase:'unreported'（见 sessionRegistry 的
    // 「相位不在这里造」注释），实时相位由 /reporter-phase 快轮询单独给。
    // 若让 hook 先 claim，同一条会话的 /sessions 行就变成"未上报"，比轮询推导出的
    // 灰显相位信息量还少（实测：调换后 kiloPluginE2E 的 [4] 变成 unreported）。
    // 真相位要压过轮询推导，不靠 claim 顺序，而是靠 sessionRegistry 的 kilo 那一支
    // **自己去问 reporterMainPhase**（见那里「装了插件就用真值」那段）。
    sources: [
      {
        kind: 'kilo',
        label: 'CLI/Plugin',
        client: clientOf('kilo', false),
        dirs: [kiloHome()],
        note: '这一路读的是数据根里的 kilo.db（SQLite），不是可扫的会话文件；文件数/体积是数据根的落盘统计，不是会话数',
      },
      // hook 那一路：装了 WorkGremlin 插件时的真相位一路。插件实例的上报身份是 kilo-plugin
      // （扩展起 server 时带 KILO_CLIENT=vscode 等，见 plugin/index.js 的 resolveClient），
      // 所以这一路显式挂 kilo-plugin —— 让 listReporterSessions / readReporterDone 能认到
      // 插件写的状态文件（否则按 kind 推出的 kilo 把插件的相位当成别层的）。
      { kind: 'hook', client: clientOf('kilo', true) },
    ],
    // 老口径的标记：会话来源既不是 hook 状态文件、也不是 jsonl，就是"轮询 Kilo 自己的库"
    hookSource: true,
    dataKind: clientOf('kilo', false),
  },
  {
    id: '8F',
    name: 'OpenCode',
    kind: 'cli',
    // 实测：官方安装脚本把二进制放在 ~/.opencode/bin/opencode，它**不在 PATH 里** ——
    // 所以 CLI_BIN_DIRS 必须显式认这一条，否则这层永远判成"没装"（已加，见 CLI_BIN_DIRS）。
    cmd: 'opencode',
    // 产品基名：上报身份 client=opencode（shared 的 clientOf 合同，见 shared/index.js）
    agent: 'opencode',
    plugin: false,
    // 与 7F Kilo 同源（Kilo Code CLI 就是 OpenCode 的 fork），但**不能照抄 7F 的取法**：
    // OpenCode 2.0.18 的 `event` 表是空的（事件只在内存流里推、不落盘），所以轮询那一路
    // 改读 `session_message` 的 content[]（见 server/src/opencode.js 文件头的分叉实测）。
    //
    // 两路来源：
    //   opencode  —— 会话来源：轮询数据根里的 opencode.db（session_v2 + session_message
    //                两张表）产会话，同时带上数据根（XDG 位置，见 opencode.js 的
    //                opencodeHome）作落盘统计
    //   hook      —— **装了 WorkGremlin 插件时**的真相位一路：插件订阅 OpenCode 的内存事件流，
    //               把相位/完成标记写成 reporter 状态文件（见 packages/reporter/src/plugin/）。
    //               没装插件这一路空着，8F 照常按轮询列会话，只是相位按推断灰显。
    //               这一路是「等待授权」相位的**唯一来源** —— OpenCode 的 tool 状态实测只有
    //               completed/error/running，授权信号只在事件流里（见 opencode.js 文件头）。
    // kind 用 'opencode' 而不是复用 'cli'/'kilo'：那两种是"扫 jsonl"和"读 event 表"，
    // 8F 是"读 session_message"，三种取法别互相误认。
    // label 标 'CLI/Desktop'：这一层同时代表 OpenCode 的 CLI/TUI、桌面端与网页端 ——
    // 同一个二进制、同一个数据根（见文件头与 renderer/src/lib/clientMatch.js 的说明）。
    //
    // CLI/Plugin 区分：OpenCode 的 CLI 与 VS Code 扩展共用同一个二进制、同一个数据根，
    // 但插件实例的上报身份是 opencode-plugin（扩展起 server 时带 OPENCODE_CLIENT=vscode 等，
    // 见 plugin/index.js 的 resolveClient），与 CLI 的 opencode 分开。
    // 任务记录通过 form 字段（'cli'/'plugin'）区分两种形态。
    sources: [
      {
        kind: 'opencode',
        label: 'CLI/Desktop',
        client: clientOf('opencode', false),
        dirs: [opencodeHome()],
        note: '这一路读的是数据根里的 opencode.db（SQLite，session_message 表），不是可扫的会话文件；文件数/体积是数据根的落盘统计，不是会话数',
      },
      // hook 那一路：装了 WorkGremlin 插件时的真相位一路。插件实例的上报身份是 opencode-plugin
      // （扩展起 server 时带 OPENCODE_CLIENT=vscode 等，见 plugin/index.js 的 resolveClient），
      // 所以这一路显式挂 opencode-plugin —— 让 listReporterSessions / readReporterDone 能认到
      // 插件写的状态文件（否则按 kind 推出的 opencode 把插件的相位当成别层的）。
      { kind: 'hook', client: clientOf('opencode', true) },
    ],
    hookSource: true,
    dataKind: clientOf('opencode', false),
  },
  {
    id: '9F',
    name: 'GitHub Copilot',
    kind: 'plugin',
    cmd: 'copilot',
    agent: 'copilot',
    plugin: true,
    pluginRe: RE_GITHUB_COPILOT,
    // 9F 仅展示 GitHub Copilot VS Code 插件这一层：它没有独立 CLI 形态（至少主流程里走的是插件），
    // 由 VS Code 扩展目录的 globalStorage / extension 目录做安装与落盘证据。
    sources: ['plugin'],
    dataKind: clientOf('copilot', true),
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
  // 'kilo'（7F）也没有独立的落盘目录可扫：会话在 SQLite 库里，由 kilo.js 轮询。
  // 这里必须显式回空 —— 落到下面的 findDataPath 会拿 RE_CODEBUDDY 去 matchIn 家目录，
  // 给 Kilo 楼层报出一个 ~/.codebuddy 的路径（装别的产品的机器上尤其难看）。
  if (spec.kind === 'kilo') return [];
  // 'opencode'（8F）同理：会话在 opencode.db 里，由 opencode.js 轮询，没有可扫的落盘目录。
  if (spec.kind === 'opencode') return [];
  return [findDataPath(p.agent, spec.kind === 'plugin')];
}

/** 空统计（没有落盘目录时的占位，字段与 scanDataDir 一致） */
const NO_STATS = { files: 0, sessions: 0, bytes: 0, sizeLabel: '0 B', lastModifiedAt: null };

/**
 * 这一路落盘**能不能读出会话** —— 不能就明说，别让人以为"没数据是没跑过"。
 *
 * 判据很窄：插件的结构化会话索引是 `genie-history`（见 sessions.js 的 listSessions，
 * 会话 id、当前会话、待办、改动文件都挂在它下面）。没有这个目录，这一路就取不到会话。
 * 只对 kind 'plugin' 的来源生效；5F TraeCode 的两路来源都是 'dir'（见其 sources 注释），
 * 不在这里补说明，tooltip 里只列目录与落盘统计。
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
    // hook 那一路（以及 kilo 那一路）按**整层**过滤：会话就是状态文件本身 / 同一个库，
    // 合并楼层的两种身份（kilo / kilo-plugin）都属于这一层。单独传一个 client 会让
    // "插件形态跑在 IDE 里"的那种会话漏掉（doneFieldsOf 查不到 kilo-plugin 的完成标记）。
    client: (spec.kind === 'hook' || spec.kind === 'kilo') ? clients.join(',') : sourceClient(p, spec),
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
  // 安装位置分两路记：CLI 可执行文件、插件扩展目录。合并楼层（1F CodeBuddy）两种形态
  // 可能同时装着、也可能只装其一 —— 两路都要落到 tooltip 里（见 detectOne 返回 installPaths），
  // 别像以前只取第一个命中就丢了另一路（只装了插件的人，tooltip 里永远只见 CLI 路径）。
  const cliInstallPath =
    (p.cmd ? resolveCommand(p.cmd) || findCliBin(p.cmd) : '') ||
    // 备用命令（5F TraeCode：国内版 IDE 的 trae-cn）——主命令搜不到时再认它。
    (p.altCmd ? resolveCommand(p.altCmd) || findCliBin(p.altCmd) : '');
  // 插件形态的安装证据：plugin 楼层看自己的 pluginRe；合并楼层（1F CodeBuddy）也认插件扩展
  // ——只装了 IDE 插件、没装 CLI 的人，这一层照样是"装了"（会话也确实在跑）。
  // 3F Codex 这种「CLI 与 IDE 合并成一层」再认一次宿主扩展目录（altPluginRe）。
  const pluginInstallPath =
    (p.plugin || hasPluginSource || p.pluginRe ? findPluginDir(p.pluginRe || RE_PLUGIN) : '') ||
    (p.altPluginRe ? findPluginDir(p.altPluginRe) : '') ||
    // 扩展目录没扫到时（装进非标编辑器 / 扩展被卸但 globalStorage 还在），globalStorage
    // 也算安装证据 —— 9F GitHub Copilot 只认扩展目录，而它家 globalStorage 在
    // ~/.config/Code/User/globalStorage/github.copilot-chat 下还在，就会误判"未安装"。
    (p.plugin || hasPluginSource || p.pluginRe ? findPluginStorageDir(p.pluginRe || RE_PLUGIN) : '');
  // 兜底兼容：installed / 单值 installPath 仍取第一个命中的（老前端 / 调用方继续可用）
  const installPath = cliInstallPath || pluginInstallPath;
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
    /** CLI 可执行文件安装位置（合并楼层里它和插件可能都装了） */
    cliInstallPath,
    cliInstallPathLabel: shorten(cliInstallPath),
    /** 插件扩展目录安装位置（只装了插件、没 CLI 的人，这一路才有值） */
    pluginInstallPath,
    pluginInstallPathLabel: shorten(pluginInstallPath),
    /**
     * 安装位置逐路清单：合并楼层（CLI + 插件）两种形态都列出，tooltip 照它逐行显示。
     * 老服务端 / 老前端没有这个字段时，前端用 installPathLabel 兜底单行。
     * @type {Array<{kind: string, path: string, label: string}>}
     */
    installPaths: [
      ...(cliInstallPath ? [{ kind: 'cli', path: cliInstallPath, label: shorten(cliInstallPath) }] : []),
      ...(pluginInstallPath ? [{ kind: 'plugin', path: pluginInstallPath, label: shorten(pluginInstallPath) }] : []),
    ],
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

module.exports = { detectProducts, PRODUCTS, shorten, humanSize, traeGlobalStorageRoots, traeLogRoots, claudeHome };