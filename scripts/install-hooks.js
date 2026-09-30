#!/usr/bin/env node
'use strict';

/**
 * 把 WorkGremlin 的上报 hook 装进各受监控产品的用户级配置
 * （CodeBuddy CLI+Plugin / WorkBuddy / Codex / Claude Code / TraeCode / Qoder）。
 *
 * 默认**全装**：不带 --targets 时遍历下面 `all` 里每一个非 optional 目标，
 * 各自「装了才写、没装跳过」（判定口径见 looksInstalled）。加新产品只需往 `all` 里加一条。
 *
 * 用法：
 *   node scripts/install-hooks.js                       装（用户级：~/.codebuddy + ~/.workbuddy + ~/.codex + ~/.claude + ~/.trae-cn/hooks.json）
 *   node scripts/install-hooks.js --targets=workbuddy    只装某几个（codebuddy / workbuddy / codex / claude / trae / qoder / qoder-cn / project）
 *   node scripts/install-hooks.js --project              另外写一份项目级 <仓库>/.codebuddy/settings.json
 *   node scripts/install-hooks.js --uninstall            撤掉（只删我们加的那几条，别人的配置不动）
 *   node scripts/install-hooks.js --dry-run              只打印将要写什么，不落盘
 *
 * 说明：
 *   - CodeBuddy Plugin与 CodeBuddy CLI 共用同一份用户级配置（~/.codebuddy/settings.json），
 *     所以 codebuddy 这一份同时覆盖两者；matcher 里 CLI 风格（Write/Edit）与 IDE 风格
 *     （write_to_file/replace_in_file）都写了，两端都能命中。
 *   - 合并写、可重复执行：先摘掉上一次我们自己加的条目（按 command 里含 hook 脚本路径识别），
 *     再追加，别人的 hooks 一条不动。首次改动前备份成 <file>.bak-workgremlin。
 *   - CLI 侧改完不会立刻生效：启动时会快照 hooks，外部改动要在 /hooks 面板里过一遍（安全设计）。
 *     插件侧重开会话即可。
 *   - **7F Kilo Code 不在此列表**：Kilo 没有 hook 子系统（无 hooks.json、无可挂事件点），
 *     没有 hook 可装。它的数据由服务端轮询 Kilo 自己的 SQLite 库获取
 *     （见 server/src/kilo.js），不需要也不应该在这里写任何配置。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK_SCRIPT = path.join(REPO_ROOT, 'packages', 'reporter', 'src', 'hook.js');
/**
 * WorkGremlin 自己的 OpenCode / Kilo 插件（上报真相位 + 台账的那一份）。
 * 7F Kilo / 8F OpenCode 没有 hook 子系统可挂，只能以「插件」形态注册进它们的配置。
 */
const PLUGIN_ENTRY_FILE = path.join(REPO_ROOT, 'packages', 'reporter', 'src', 'plugin', 'index.js');

/**
 * matcher 为 null 表示这个事件不吃 matcher（UserPromptSubmit / Stop）。
 * 写 / 改类工具才记 file_activity，读类不记（读了什么文件不重要，也免得刷屏）。
 *
 * PostToolUse 的白名单里**必须有 Task**：subagent 的"收工"信号原本押在它身上，
 * 结果 Task 不在名单里 → CodeBuddy 压根不为它调我们的 hook → 幽灵只加不散
 * （日志实测：5 次 Task 的 PreToolUse，0 次 PostToolUse；写类工具才是成对的）。
 * 同理注册 SubagentStop 作为第二条收场信号（hook 侧只收幽灵、不碰主会话任务）。
 */
const CODEX_EVENTS = [
  ['SessionStart', ''],
  ['UserPromptSubmit', null],
  ['PreToolUse', ''],
  ['PostToolUse', ''],
  ['PermissionRequest', null],
  ['SubagentStart', null],
  ['SubagentStop', null],
  ['Stop', null],
  ['Interrupt', null],
  ['SessionEnd', ''],
];

/**
 * Claude Code（2.1 实测）的事件表。
 *
 * 与 CodeBuddy 的差别，决定了这里**不能直接复用 EVENTS**：
 *   - 有显式的 PermissionRequest（payload 带 tool_name / tool_input），
 *     等授权不用再靠"PreToolUse 打 pending、超时未清即猜"，与 Codex 同档；
 *   - PostToolUse **对所有工具都发**（含 Read/Grep/Bash），所以 matcher 留空，
 *     不用像 EVENTS 那样开白名单；
 *   - 子代理工具叫 **Agent**（不是 Task），由 hook 的 isSubagentTool 大小写不敏感地认。
 *
 * 故意**不注册 SubagentStart**：PreToolUse(Agent) 已经能拿到真 tool_use_id 并登记幽灵，
 * 再注册一次 SubagentStart 会让同一只子代理登记出两只幽灵。
 * SubagentStop 仍然注册，作为"PostToolUse 没来"时的第二条收场信号。
 */
const CLAUDE_EVENTS = [
  ['SessionStart', ''],
  ['UserPromptSubmit', null],
  ['PreToolUse', ''],
  ['PostToolUse', ''],
  ['PermissionRequest', null],
  ['Notification', null],
  ['SubagentStop', null],
  ['Stop', null],
  ['SessionEnd', ''],
];

const EVENTS = [
  ['SessionStart', ''],
  ['UserPromptSubmit', null],
  ['PreToolUse', ''],
  ['PostToolUse', '^(Write|Edit|MultiEdit|NotebookEdit|write_to_file|replace_in_file|Task|Agent)$'],
  // Notification 和 UserPromptSubmit / Stop / SubagentStop 一样**不吃 matcher**
  // （扩展源码：EVENTS_WITHOUT_MATCHER 恰好是这四个）—— 给它写 matcher 可能整条不生效
  ['Notification', null],
  ['Stop', null],
  ['SubagentStop', null],
  ['SessionEnd', ''],
];

/**
 * CodeBuddy / WorkBuddy 的事件表 = EVENTS + `FinalStop`。
 *
 * `FinalStop` 是 CodeBuddy 家族的**一轮终态**事件，payload 带
 * `final_stop_reason ∈ completed | cancelled | failed | interrupted`
 * （实测 2026-09-29：dist 的 `executeFinalStopHooks(sessionId, reason)` 里发这个事件）。
 * 1F 靠它认"用户按了停止"—— 以前靠服务端猜（taskId 卡死 + transcript 末轮 state='running'），
 * 会把"模型纯推理超过 2 分钟、中间没有工具事件"的长轮误判成取消，那条兜底已删
 * （见 server/src/sessions.js / packages/reporter/src/hook.js 的 finishCancelled）。
 *
 * **Trae 不并进来**：它是另一家的 VS Code 分支，不认识这个事件名就别硬塞（沿用 EVENTS）。
 */
const CODEBUDDY_EVENTS = [...EVENTS, ['FinalStop', null]];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const [key, inline] = a.slice(2).split('=');
    const next = argv[i + 1];
    if (inline !== undefined) args[key] = inline;
    else if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else args[key] = true;
  }
  return args;
}

function codebuddyCommand() {
  // codebuddy 家族（cli/plugin 共用 ~/.codebuddy/settings.json）：--agent codebuddy，
  // 由 hook 再按 payload 的 client 分 cli（1F）/ plugin（3F）。
  return `node "${HOOK_SCRIPT}" --agent codebuddy`;
}

/**
 * Codex 的 hook 命令：用 --agent codex 注入产品家族身份（hook 靠它选事件名与工具名口径，
 * 见 packages/reporter/src/hook.js 的 IS_CODEX），默认工位名也换成 codex —— 不跟 CodeBuddy
 * 抢同一张工位卡。
 */
function codexCommand() {
  return `node "${HOOK_SCRIPT}" --agent codex`;
}

/** WorkBuddy 同理：用 --agent workbuddy 注入产品家族身份，别写成 codebuddy */
function workbuddyCommand() {
  return `node "${HOOK_SCRIPT}" --agent workbuddy`;
}

/** TraeCode 插件：用 --agent trae 注入产品家族身份（trae 与 codebuddy 都自报 client:'vscode'，
 *  运行时分不出，只能靠安装期身份），别写成 codebuddy。工位名默认 trae。 */
function traeCommand() {
  return `node "${HOOK_SCRIPT}" --agent trae`;
}

/** Claude Code CLI：用 --agent claude 注入产品家族身份，工位名默认 claude */
function claudeCommand() {
  return `node "${HOOK_SCRIPT}" --agent claude`;
}

/**
 * Qoder CLI（6F）：hook 配置落在 ~/.qoder/settings.json（Claude / CodeBuddy 同款，hooks 嵌在 settings.json）。
 * Qoder 的真实 hook 事件名暂未确认，这里**默认采用最宽覆盖的 Claude 风格事件表**
 * （PreToolUse / PostToolUse 对所有工具都发，且带 PermissionRequest / Notification / SubagentStop）：
 * 这样无论 Qoder 的工具名长什么样，我们的 hook 都至少能抓到 会话起止 / 工具前后 / 授权 这类事件。
 * 若 Qoder 实际事件名不同，只需把 QODER_EVENTS 换成 EVENTS / CODEX_EVENTS 或自定义即可，
 * 不涉及 hook.js 逻辑 —— hook.js 靠 --agent qoder 走通用路径（非 codex / 非 claude）。
 */
const QODER_EVENTS = CLAUDE_EVENTS;

/** Qoder CLI：用 --agent qoder 注入产品家族身份，工位名默认 qoder */
function qoderCommand() {
  return `node "${HOOK_SCRIPT}" --agent qoder`;
}

/** 我们加的那几条：按 command 里有没有 hook 脚本路径识别 */
function isOurs(group) {
  return !!group && Array.isArray(group.hooks) && group.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(HOOK_SCRIPT));
}

/** 这份配置里是不是已经有我们的 hook（决定要不要备份） */
function hasOurs(settings) {
  const groups = Object.values((settings && settings.hooks) || {}).flatMap((g) => (Array.isArray(g) ? g : []));
  return groups.some(isOurs);
}

function readSettings(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/* ------------------------------ 插件形态（7F Kilo / 8F OpenCode） ------------------------------ */

/**
 * 我们要写进 Kilo / OpenCode 配置的那条 plugin 条目。
 *
 * 这两个产品**没有 hook 子系统**（Kilo 7.8.1 实测：`--help` 里没有 hook 子命令，也没有
 * `hooks.json`），所以上报只能走它们自己的**插件**机制：插件订阅 agent 的内存事件流，
 * 把相位/完成标记写成 reporter 状态文件，并往台账上报成员/任务/对话记录/文件活动
 * （见 packages/reporter/src/plugin/index.js）。没有这条，7F/8F 就只有轮询推导 ——
 * 相位恒带 inferred 灰显，而且**完全没有任务台账**（轮询是只读的，监控端不能伪造上报）。
 *
 * `options.client` 钉的是**产品**（这里是 `kilo`），**不是形态**：形态由插件自己按环境判
 * （见 plugin/index.js 的 resolveClient —— 编辑器扩展起的带 KILO_CLIENT=vscode，判成
 * kilo-plugin；终端 CLI 一个 KILO_* 都没有，判成 kilo）。
 * 选项里写死 `-plugin` 是错的：这条条目写在 `kilo.jsonc` 里，而**同一份配置 CLI 和 VS Code
 * 扩展都会读**，写死哪一个形态都会把另一半弄反。
 */

/**
 * **键名是 `plugin`（单数），不是 `plugins`** —— 这一点实测踩过坑，必须写在这里。
 *
 * 早先这里写的是 `plugins: [{ package, options }]`。Kilo 7.8.1 认不出来：
 * 它把配置**降级到 V1** 时对 `plugins` 报一条 WARN 然后**整段丢掉** ——
 *   WARN configuration compatibility diagnostic source=~/.config/kilo/kilo.jsonc
 *        path="[\"plugins\"]" kind=unsupported
 *        action="Omitted native setting that cannot be represented in V1"
 * 症状是「插件看着装上了、配置里也确实有那条，但一条状态文件都不写，7F 任务台账永远空」，
 * 而且**没有任何报错**，只有那条 WARN（要翻 ~/.local/share/kilo/log/opencode.log 才看得到）。
 *
 * 真正的形状（二进制里 `plugin: J.optional(J.Array(Spec))`，`Spec = String | [String, Record]`）：
 *   "plugin": [ ["/abs/path/index.js", { "client": "kilo" }] ]
 * 实测（Kilo 7.8.1 `kilo debug config`）：这样写才会进解析结果（并被规范成 file:// URL），
 * 探针插件实测能收到 session.created / message.part.updated 等真实事件。
 * 路径必须是**绝对路径**（相对路径是相对配置文件目录解析的，跨机器必坏）。
 * @param {string} client 上报身份
 * @returns {[string, {client:string}]} 一条 plugin 条目
 */
function pluginEntry(client) {
  return [PLUGIN_ENTRY_FILE, { client }];
}

/**
 * 工程目录里还有没有**我们自己**的零配置入口（`.kilo/{plugin,plugins}/*.{ts,js}`）。
 *
 * 7F **只能有一处注册**。Kilo 的来源有两路 —— 每个配置目录下 `{plugin,plugins}/*.{ts,js}`，
 * 以及配置文件里的 `plugin` 数组 —— 两路都在时就是同一个进程里的**两个插件实例**：
 * 同一轮任务被上报两遍（实测 2026-09-30：同一 session、同一标题的两行台账，`started_at`
 * 只差 5 毫秒），而且它的去重是按 **spec 字符串**做的（绝对路径与 shim 里的相对路径算两条），
 * 所以两份都留得下来。
 *
 * 安装器只**报**不删：那是用户工程里的文件，删不删由他定。
 * @returns {string[]} 冲突的文件路径
 */
function projectPluginEntryFiles(dir) {
  const hits = [];
  for (const cfg of ['.kilo', '.kilocode']) {
    for (const sub of ['plugin', 'plugins']) {
      const d = path.join(dir, cfg, sub);
      let names = [];
      try {
        names = fs.readdirSync(d);
      } catch {
        continue; // 这个目录不存在就是没这回事
      }
      for (const n of names) {
        if (!/\.(ts|js)$/.test(n)) continue;
        const f = path.join(d, n);
        let body = '';
        try {
          body = fs.readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        // 名字或内容提到我们就算 —— shim 只是转发，认内容比认文件名稳
        if (/workgremlin/i.test(n) || body.includes(PLUGIN_ENTRY_FILE) || /workgremlin/i.test(body)) hits.push(f);
      }
    }
  }
  return hits;
}

/** 一条 plugin 条目里那个包路径（字符串形式 / [路径, 选项] 元组都认） */
function pluginPathOf(entry) {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) return String(entry[0] || '');
  if (entry && typeof entry === 'object') return String(entry.package || entry.path || '');
  return '';
}

/** 这份配置里有没有我们自己那条插件条目（按 package 路径认，认 path 不认名字） */
function hasPluginEntry(settings, client) {
  const list = Array.isArray(settings && settings.plugin) ? settings.plugin : [];
  const want = pluginEntry(client)[0];
  return list.some((p) => pluginPathOf(p) === want);
}

/**
 * 幂等合并 plugin 数组：摘掉上一次我们自己写的那条（同 package 路径），再追加。
 * 别人的插件一条不动；`uninstall` 只摘我们自己的。
 *
 * 顺手清掉早先写错键名留下的 `plugins` 段：Kilo 本来就不认它，留着只会在每次启动时
 * 多一条 "Omitted native setting" WARN（还会让人误以为插件已装）。
 */
function mergePlugins(existing, client, uninstall) {
  const list = Array.isArray(existing.plugin) ? existing.plugin : [];
  const want = pluginEntry(client)[0];
  const kept = list.filter((p) => pluginPathOf(p) !== want);
  const out = { ...existing };
  delete out.plugins;
  const next = uninstall ? kept : [...kept, pluginEntry(client)];
  if (next.length) out.plugin = next;
  else delete out.plugin;
  return out;
}

function writeSettings(file, settings, dryRun) {
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  if (dryRun) return text;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return text;
}

/**
 * @param {object} existing
 * @param {object} ours 事件 -> 组数组
 * @param {boolean} uninstall
 */
function merge(existing, ours, uninstall) {
  const hooks = { ...(existing.hooks || {}) };
  for (const event of Object.keys(ours)) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((g) => !isOurs(g));
    const next = uninstall ? kept : [...kept, ...ours[event]];
    if (next.length) hooks[event] = next;
    else delete hooks[event];
  }
  const out = { ...existing };
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  return out;
}

/**
 * 这个目标看着装了吗？**没装就别写**。
 *
 * 判定口径和 server/src/products.js 对齐：只认"安装位置"——
 *   · CLI：在 PATH 或常见 bin 目录里找得到可执行文件；
 *   · 插件：在编辑器扩展目录里找得到（覆盖"只装了插件、没装 CLI、~/.codebuddy 还没数据"的情况）。
 * 另外保留一条兜底：配置目录里除了我们的 settings.json 还有别的数据（产品真在用这个目录）。
 * （早期版本曾把"配置目录存在"当证据，被我们自己的安装脚本造出的目录骗了；
 *  现在 products.js 只用安装位置判 installed，所以即便这里新建了配置目录也不会误判成已装。）
 *
 * 注意：这里只决定"要不要写"；"有没有装过我们的 hook、有了就不重复写"由
 * 下面的 merge + before===after 跳过逻辑保证（即"有就跳过、没有就装"）。
 */

const HOME = os.homedir();

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

/** PATH 里的命令解析成绝对路径 */
function resolveCommand(cmd) {
  try {
    const out = execSync(`command -v ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, encoding: 'utf8' });
    return String(out || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  } catch {
    return '';
  }
}

/** CLI 常见安装目录兜底（PATH 查不到时） */
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
  const names = process.platform === 'win32' ? [`${cmd}.cmd`, `${cmd}.exe`, cmd] : [cmd];
  for (const dir of CLI_BIN_DIRS) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (isFile(p)) return p;
    }
  }
  return '';
}

/** 编辑器扩展目录（插件安装位置） */
function extensionRoots() {
  // .trae-cn 是 TraeCode（国内版）的扩展根；coding-copilot 扩展就装在它下面
  return ['.vscode', '.vscode-insiders', '.cursor', '.trae', '.trae-cn', '.windsurf', '.vscode-server']
    .map((d) => path.join(HOME, d, 'extensions'))
    .filter(isDir);
}
const RE_PLUGIN = [/codebuddy/i, /tencent/i, /ingram/i, /code-?buddy/i];
function pluginMatchIn(root, res) {
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
function findPluginDir(res = RE_PLUGIN) {
  for (const r of extensionRoots()) {
    const hit = pluginMatchIn(r, res);
    if (hit) return hit;
  }
  return '';
}

function looksInstalled(t) {
  // CLI：PATH 或常见安装目录里找得到可执行文件
  if (t.cmd && (resolveCommand(t.cmd) || findCliBin(t.cmd))) return true;
  // 插件：编辑器扩展目录里找得到（CodeBuddy Plugin与 CLI 共用 ~/.codebuddy）
  if (t.plugin && findPluginDir(t.pluginRe || RE_PLUGIN)) return true;
  // 兜底：配置目录里除了我们自己的 settings.json 还有别的数据
  const ours = new Set(['settings.json', 'settings.json.bak-workgremlin']);
  try {
    return fs.readdirSync(t.dir).some((n) => !ours.has(n));
  } catch {
    return false;
  }
}

/**
 * 安装/卸载 hook。既能当函数调（服务启动时自动接入），也能走 CLI（见文件末尾）。
 * @param {Record<string, any>} [args] 同 CLI 参数（targets / dry-run / uninstall / project）
 * @returns {{installed: string[], unchanged: string[], skipped: string[], failed: string[], files: string[]}}
 */
function installHooks(args = parseArgs(process.argv.slice(2))) {
  /** @type {{installed: string[], unchanged: string[], skipped: string[], failed: string[], files: string[]}} */
  const result = { installed: [], unchanged: [], skipped: [], failed: [], files: [] };
  const dryRun = args['dry-run'] === true;
  const uninstall = args.uninstall === true;
  const wanted = String(args.targets || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const codebuddyCmd = codebuddyCommand();
  const buildOurs = (events, hookCmd) => {
    const out = {};
    for (const [event, matcher] of events) {
      const entry = { type: 'command', command: hookCmd, timeout: 10 };
      out[event] = [matcher === null ? { hooks: [entry] } : { matcher, hooks: [entry] }];
    }
    return out;
  };
  const codebuddyOurs = buildOurs(CODEBUDDY_EVENTS, codebuddyCmd);
  const codexOurs = buildOurs(CODEX_EVENTS, codexCommand());
  const workbuddyOurs = buildOurs(CODEBUDDY_EVENTS, workbuddyCommand());
  const traeOurs = buildOurs(EVENTS, traeCommand());
  const claudeOurs = buildOurs(CLAUDE_EVENTS, claudeCommand());
  const qoderOurs = buildOurs(QODER_EVENTS, qoderCommand());

  const all = [
    {
      id: 'codebuddy',
      label: 'CodeBuddy Plugin / CodeBuddy CLI',
      file: path.join(os.homedir(), '.codebuddy', 'settings.json'),
      cmd: 'codebuddy',
      dir: path.join(os.homedir(), '.codebuddy'),
      plugin: true,
      ours: codebuddyOurs,
    },
    {
      id: 'workbuddy',
      label: 'WorkBuddy CLI',
      file: path.join(os.homedir(), '.workbuddy', 'settings.json'),
      cmd: 'workbuddy',
      dir: path.join(os.homedir(), '.workbuddy'),
      ours: workbuddyOurs,
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      // 实测（Codex 0.151.0）：用户级 hooks 文件就在 codex home 下，结构与 CodeBuddy settings.json 同源
      file: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'),
      cmd: 'codex',
      dir: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      ours: codexOurs,
    },
    {
      id: 'claude',
      label: 'Claude Code CLI',
      // Claude Code 的 hooks 与 CodeBuddy 同构（settings.json + hooks 事件 + matcher），
      // 用户级就是 ~/.claude/settings.json。注意它多一道「工作区信任」闸门（见文件末尾提示）。
      file: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'),
      cmd: 'claude',
      dir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
      ours: claudeOurs,
    },
    {
      id: 'trae',
      label: 'TraeCode 全局 Hook',
      // 官方文档（docs.trae.cn「Hook 配置详解」）：Linux/macOS 全局 hook 落
      // ~/.trae-cn/hooks.json，格式为 { version: 1, hooks: { <事件>: [ { matcher, hooks:[{type,command,timeout}] } ] } }
      // —— 不是 CodeBuddy 同款的 settings.json，也不是 ~/.trae/。项目级才是 <工程>/.trae/hooks.json。
      file: path.join(os.homedir(), '.trae-cn', 'hooks.json'),
      cmd: 'trae',
      dir: path.join(os.homedir(), '.trae-cn'),
      plugin: true,
      // 扩展在编辑器扩展目录里叫 tencent-cloud.coding-copilot（TraeCode 内核），不是 trae 字样
      pluginRe: /trae|coding-copilot/i,
      version: 1,
      ours: traeOurs,
    },
    { id: 'project', label: `CodeBuddy 项目级（${path.basename(REPO_ROOT)}）`, file: path.join(REPO_ROOT, '.codebuddy', 'settings.json'), ours: codebuddyOurs, optional: true },
    {
      id: 'qoder',
      label: 'Qoder CLI（国际版）',
      // Qoder 的 hooks 与 Claude / CodeBuddy 同构：hooks 嵌在 ~/.qoder/settings.json 里。
      file: path.join(os.homedir(), '.qoder', 'settings.json'),
      cmd: 'qoder',
      dir: path.join(os.homedir(), '.qoder'),
      ours: qoderOurs,
    },
    {
      // 国内版 Qoder：命令是 qoder-cn，配置家在 ~/.qoder-cn（settings.json 同构）。
      // 上报身份仍是 --agent qoder（产品家族基名，见 6F 的 agent），只是落盘的家不同。
      id: 'qoder-cn',
      label: 'Qoder CLI（国内版）',
      file: path.join(os.homedir(), '.qoder-cn', 'settings.json'),
      cmd: 'qoder-cn',
      dir: path.join(os.homedir(), '.qoder-cn'),
      ours: qoderOurs,
    },
    {
      // 7F Kilo Code：**没有 hook 可装**，装的是我们自己的插件。
      // Kilo 7.8.1 实测没有 hook 子命令、也没有 hooks.json，所以上报走它的 `plugin` 机制
      // （**单数键**，条目是 [绝对路径, options]，见 pluginEntry）。
      // 不装插件 7F 也**有**任务台账 —— 服务端轮询每一轮写一条（只读推导，`kiloTasks.js`）；
      // 插件那一路补的是轮询拿不到的东西：真相位（不灰显）、「等待授权」、
      // 收尾自述与对话记录/文件活动，以及**形态**（CLI / VS Code 插件）。
      id: 'kilo-plugin',
      label: 'Kilo Code 插件（真相位 + 任务台账）',
      kind: 'plugin',
      file: path.join(os.homedir(), '.config', 'kilo', 'kilo.jsonc'),
      // 装了没装的判定：跟别的楼层同一把尺子（PATH 里有 kilo / 数据根存在）
      cmd: 'kilo',
      dir: (() => {
        const explicit = String(process.env.WORKGREMLIN_KILO_HOME || '').trim();
        if (explicit) return path.resolve(explicit);
        const xdg = String(process.env.XDG_DATA_HOME || '').trim();
        if (xdg) return path.join(path.resolve(xdg), 'kilo');
        return path.join(os.homedir(), '.local', 'share', 'kilo');
      })(),
      // CLI / TUI 形态的上报身份（VS Code 扩展那份是 kilo-plugin，由扩展自己判）
      client: 'kilo',
    },
  ];
  const targets = all.filter((t) => (t.optional ? args.project === true || wanted.includes(t.id) : !wanted.length || wanted.includes(t.id)));

  if (!fs.existsSync(HOOK_SCRIPT)) {
    // 抛错而不是 process.exit：服务端启动时自动接入会调本函数，退出会把服务带下去
    throw new Error(`找不到 hook 脚本：${HOOK_SCRIPT}`);
  }

  console.log(`[workgremlin] hook 命令：${codebuddyCmd}`);
  if (!wanted.length || wanted.includes('codex')) console.log(`[workgremlin] Codex 命令：${codexCommand()}`);
  if (!wanted.length || wanted.includes('trae')) console.log(`[workgremlin] TraeCode 命令：${traeCommand()}`);
  if (!wanted.length || wanted.includes('claude')) console.log(`[workgremlin] Claude Code 命令：${claudeCommand()}`);
  if (dryRun) console.log('[workgremlin] --dry-run：不落盘');

  // 7F **只能有一处注册**。全局那条（kilo.jsonc 的 plugin 数组）已经够用；工程目录里再留
  // 一份零配置入口的话，Kilo 会把两份都加载 → 同一进程里两个实例 → 同一轮台账落两行。
  // 只报不删：那是用户工程里的文件（本仓库自己踩过这个坑，2026-09-30 实测）。
  if (!uninstall && targets.some((t) => t.id === 'kilo-plugin')) {
    const dirs = [...new Set([process.cwd(), REPO_ROOT])];
    const conflicts = dirs.flatMap((d) => projectPluginEntryFiles(d));
    if (conflicts.length) {
      console.warn('[workgremlin] ⚠ Kilo Code：这个工程里还有别的零配置插件入口：');
      for (const f of conflicts) console.warn(`[workgremlin]     ${f}`);
      console.warn('[workgremlin]   两处注册会在同一个 Kilo 进程里起两个插件实例，同一轮任务上报两遍（任务记录里一行变两行）。');
      console.warn('[workgremlin]   全局那条（kilo.jsonc）已经够用，建议删掉上面这份（我们不自动动你的文件）。');
    }
  }

  for (const t of targets) {
    // 没装的产品不写：写了就等于给它凭空造出一份"已安装"的证据
    if (!uninstall && !t.optional && !looksInstalled(t)) {
      console.log(
        `[workgremlin] · ${t.label}：看着没装（PATH 里没有 ${t.cmd}，${t.dir} 里也没有别的数据），跳过（确定装了就 --targets=${t.id} 强制写）`
      );
      result.skipped.push(t.label);
      continue;
    }

    const exists = fs.existsSync(t.file);
    const existing = exists ? readSettings(t.file) : null;
    if (exists && existing === null) {
      console.error(`[workgremlin] ✗ ${t.label}：${t.file} 不是合法 JSON，先修好再装（没动它）`);
      result.failed.push(t.label);
      continue;
    }

    const isPlugin = t.kind === 'plugin';
    const next = isPlugin ? mergePlugins(existing || {}, t.client, uninstall) : merge(existing || {}, t.ours, uninstall);
    // hooks.json 协议（TraeCode）默认带 schema version：新建/已存在都保证有，已有的不覆盖
    if (!uninstall && t.version) next.version = next.version || t.version;
    const before = JSON.stringify(existing || {});
    const after = JSON.stringify(next);

    if (!uninstall && before === after) {
      console.log(`[workgremlin] · ${t.label}：已是最新 ${t.file}`);
      result.unchanged.push(t.label);
      continue;
    }
    if (uninstall && before === after) {
      console.log(`[workgremlin] · ${t.label}：本来就没装 ${t.file}`);
      result.unchanged.push(t.label);
      continue;
    }

    // dry-run 也要一步都不落盘：早先这里没判 dryRun，预览时会真写出 .bak-workgremlin
    // 插件形态认自己的那条（按 package 路径），别拿 hasOurs 去问 hooks —— 它只看 hooks
    if (!dryRun && exists && !(isPlugin ? hasPluginEntry(existing, t.client) : hasOurs(existing))) {
      fs.copyFileSync(t.file, `${t.file}.bak-workgremlin`);
      console.log(`[workgremlin]   备份 -> ${t.file}.bak-workgremlin`);
    }

    writeSettings(t.file, next, dryRun);
    // dry-run 时如实说"将写入"——不然预览输出会谎报已经写过了
    const verb = uninstall ? '已移除' : '已写入';
    console.log(`[workgremlin] ✓ ${t.label}：${dryRun ? (uninstall ? '将移除' : '将写入') : verb} ${t.file}`);
    if (!dryRun) result.installed.push(t.label);
    result.files.push(t.file);
  }

  if (!uninstall) {
    console.log('');
    console.log('[workgremlin] · Codex CLI：hook 需要「信任」才会执行 —— 首次在新会话里用 /hooks 批准一次；');
    console.log('                       自动化场合可临时加 --dangerously-bypass-hook-trust');
    console.log('[workgremlin] 生效方式：');
    console.log('  · TraeCode：首次在 设置 > Hooks 面板确认全局 hooks.json 已启用（外部写入有安全闸门），再重开会话');
    console.log('  · CodeBuddy Plugin：重开会话');
    console.log('  · CodeBuddy / WorkBuddy CLI：改完不会立刻生效，跑 /hooks 过一遍（外部改动需审核）');
    console.log('  · Claude Code：写完新起的会话直接就生效（claude --print 实测，没经过批准）；');
    console.log('                 若表现为"装了没反应"，在 /hooks 面板过一遍即可');
    console.log('  · 主 agent 身份由安装目标决定（codebuddy / codex / workbuddy / trae / claude / qoder），已写进 hook 命令的 --agent，无需也无法二次指定');
    console.log('  · 7F Kilo Code：**没有 hook**（实测 7.8.1 无 hook 子命令 / hooks.json），所以装的是插件；');
    console.log('                 改完 kilo.jsonc 要**重开 Kilo 会话**才加载。不装插件也有任务台账 ——');
    console.log('                 服务端轮询每一轮写一条（只读推导：相位灰显、没有收尾自述）；');
    console.log('                 装了插件那份才是真值（相位不灰显、有「等待授权」、对话记录与文件活动）');
    console.log('[workgremlin] · 不想自动接入：WORKGREMLIN_NO_AUTO_HOOKS=1');
  }
  return result;
}

module.exports = { installHooks, HOOK_SCRIPT, EVENTS, CODEBUDDY_EVENTS, CODEX_EVENTS, CLAUDE_EVENTS };

if (require.main === module) {
  try {
    installHooks();
  } catch (err) {
    console.error(`[workgremlin] ${err && err.message}`);
    process.exit(1);
  }
}
