#!/usr/bin/env node
'use strict';

/**
 * 把 WorkGremlin 的上报 hook 装进各受监控产品的用户级配置
 * （CodeBuddy CLI+Plugin / WorkBuddy / Codex / Claude Code / TraeCode）。
 *
 * 默认**全装**：不带 --targets 时遍历下面 `all` 里的每一个非 optional 目标，
 * 各自「装了才写、没装跳过」（判定口径见 looksInstalled）。加新产品只需往 `all` 里加一条。
 *
 * 用法：
 *   node scripts/install-hooks.js                       装（用户级：~/.codebuddy + ~/.workbuddy + ~/.codex + ~/.claude + ~/.trae）
 *   node scripts/install-hooks.js --targets=workbuddy    只装某几个（codebuddy / workbuddy / codex / claude / trae / project）
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
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK_SCRIPT = path.join(REPO_ROOT, 'packages', 'reporter', 'src', 'hook.js');

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
  return ['.vscode', '.vscode-insiders', '.cursor', '.trae', '.windsurf', '.vscode-server']
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
  const codebuddyOurs = buildOurs(EVENTS, codebuddyCmd);
  const codexOurs = buildOurs(CODEX_EVENTS, codexCommand());
  const workbuddyOurs = buildOurs(EVENTS, workbuddyCommand());
  const traeOurs = buildOurs(EVENTS, traeCommand());
  const claudeOurs = buildOurs(CLAUDE_EVENTS, claudeCommand());

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
      label: 'TraeCode Plugin',
      // Trae 基于 VS Code 协议，hook 结构与 CodeBuddy Plugin 同源（settings.json + hooks 事件）。
      // 注意：路径是按 CodeBuddy 同款 ~/.trae/settings.json 推断的；若 Trae 实际用别的落盘位置需调整。
      file: path.join(os.homedir(), '.trae', 'settings.json'),
      cmd: 'trae',
      dir: path.join(os.homedir(), '.trae'),
      plugin: true,
      pluginRe: /trae/i,
      ours: traeOurs,
    },
    { id: 'project', label: `CodeBuddy 项目级（${path.basename(REPO_ROOT)}）`, file: path.join(REPO_ROOT, '.codebuddy', 'settings.json'), ours: codebuddyOurs, optional: true },
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

    const next = merge(existing || {}, t.ours, uninstall);
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
    if (!dryRun && exists && !hasOurs(existing)) {
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
    console.log('  · CodeBuddy Plugin：重开会话');
    console.log('  · CodeBuddy / WorkBuddy CLI：改完不会立刻生效，跑 /hooks 过一遍（外部改动需审核）');
    console.log('  · Claude Code：写完新起的会话直接就生效（claude --print 实测，没经过批准）；');
    console.log('                 若表现为"装了没反应"，在 /hooks 面板过一遍即可');
    console.log('  · 主 agent 身份由安装目标决定（codebuddy / codex / workbuddy / trae / claude），已写进 hook 命令的 --agent，无需也无法二次指定');
    console.log('[workgremlin] · 不想自动接入：WORKGREMLIN_NO_AUTO_HOOKS=1');
  }
  return result;
}

module.exports = { installHooks, HOOK_SCRIPT, EVENTS, CODEX_EVENTS, CLAUDE_EVENTS };

if (require.main === module) {
  try {
    installHooks();
  } catch (err) {
    console.error(`[workgremlin] ${err && err.message}`);
    process.exit(1);
  }
}
