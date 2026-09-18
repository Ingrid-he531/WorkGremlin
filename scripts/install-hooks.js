#!/usr/bin/env node
'use strict';

/**
 * 把 WorkGremlin 的上报 hook 装进 CodeBuddy 插件 / CodeBuddy CLI / WorkBuddy CLI 的 settings.json。
 *
 * 用法：
 *   node scripts/install-hooks.js                       装（用户级：~/.codebuddy + ~/.workbuddy）
 *   node scripts/install-hooks.js --targets=workbuddy    只装某几个（codebuddy / workbuddy / project）
 *   node scripts/install-hooks.js --project              另外写一份项目级 <仓库>/.codebuddy/settings.json
 *   node scripts/install-hooks.js --member coder         指定工位名（默认 codebuddy）
 *   node scripts/install-hooks.js --uninstall            撤掉（只删我们加的那几条，别人的配置不动）
 *   node scripts/install-hooks.js --dry-run              只打印将要写什么，不落盘
 *
 * 说明：
 *   - CodeBuddy 插件与 CodeBuddy CLI 共用同一份用户级配置（~/.codebuddy/settings.json），
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
 */
const EVENTS = [
  ['SessionStart', ''],
  ['UserPromptSubmit', null],
  ['PreToolUse', ''],
  ['PostToolUse', '^(Write|Edit|MultiEdit|NotebookEdit|write_to_file|replace_in_file)$'],
  ['Notification', 'permission_prompt|idle_prompt'],
  ['Stop', null],
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

function command(member) {
  const base = `node "${HOOK_SCRIPT}"`;
  return member && member !== 'codebuddy' ? `${base} --member ${member}` : base;
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
function pluginMatchIn(root) {
  try {
    for (const name of fs.readdirSync(root)) {
      if (RE_PLUGIN.some((re) => re.test(name))) return path.join(root, name);
    }
  } catch {
    /* 读不到就跳过 */
  }
  return '';
}
function findPluginDir() {
  for (const r of extensionRoots()) {
    const hit = pluginMatchIn(r);
    if (hit) return hit;
  }
  return '';
}

function looksInstalled(t) {
  // CLI：PATH 或常见安装目录里找得到可执行文件
  if (t.cmd && (resolveCommand(t.cmd) || findCliBin(t.cmd))) return true;
  // 插件：编辑器扩展目录里找得到（CodeBuddy 插件与 CLI 共用 ~/.codebuddy）
  if (t.plugin && findPluginDir()) return true;
  // 兜底：配置目录里除了我们自己的 settings.json 还有别的数据
  const ours = new Set(['settings.json', 'settings.json.bak-workgremlin']);
  try {
    return fs.readdirSync(t.dir).some((n) => !ours.has(n));
  } catch {
    return false;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const member = String(args.member || 'codebuddy').trim() || 'codebuddy';
  const dryRun = args['dry-run'] === true;
  const uninstall = args.uninstall === true;
  const wanted = String(args.targets || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const cmd = command(member);
  const ours = {};
  for (const [event, matcher] of EVENTS) {
    const entry = { type: 'command', command: cmd, timeout: 10 };
    ours[event] = [matcher === null ? { hooks: [entry] } : { matcher, hooks: [entry] }];
  }

  const all = [
    {
      id: 'codebuddy',
      label: 'CodeBuddy 插件 / CodeBuddy CLI',
      file: path.join(os.homedir(), '.codebuddy', 'settings.json'),
      cmd: 'codebuddy',
      dir: path.join(os.homedir(), '.codebuddy'),
      plugin: true,
    },
    {
      id: 'workbuddy',
      label: 'WorkBuddy CLI',
      file: path.join(os.homedir(), '.workbuddy', 'settings.json'),
      cmd: 'workbuddy',
      dir: path.join(os.homedir(), '.workbuddy'),
    },
    { id: 'project', label: `CodeBuddy 项目级（${path.basename(REPO_ROOT)}）`, file: path.join(REPO_ROOT, '.codebuddy', 'settings.json'), optional: true },
  ];
  const targets = all.filter((t) => (t.optional ? args.project === true || wanted.includes(t.id) : !wanted.length || wanted.includes(t.id)));

  if (!fs.existsSync(HOOK_SCRIPT)) {
    console.error(`[workgremlin] 找不到 hook 脚本：${HOOK_SCRIPT}`);
    process.exit(1);
  }

  console.log(`[workgremlin] hook 命令：${cmd}`);
  console.log(`[workgremlin] 工位名：${member}（WORKGREMLIN_MEMBER 可在环境里覆盖）`);
  if (dryRun) console.log('[workgremlin] --dry-run：不落盘');

  for (const t of targets) {
    // 没装的产品不写：写了就等于给它凭空造出一份"已安装"的证据
    if (!uninstall && !t.optional && !looksInstalled(t)) {
      console.log(
        `[workgremlin] · ${t.label}：看着没装（PATH 里没有 ${t.cmd}，${t.dir} 里也没有别的数据），跳过（确定装了就 --targets=${t.id} 强制写）`
      );
      continue;
    }

    const exists = fs.existsSync(t.file);
    const existing = exists ? readSettings(t.file) : null;
    if (exists && existing === null) {
      console.error(`[workgremlin] ✗ ${t.label}：${t.file} 不是合法 JSON，先修好再装（没动它）`);
      continue;
    }

    const next = merge(existing || {}, ours, uninstall);
    const before = JSON.stringify(existing || {});
    const after = JSON.stringify(next);

    if (!uninstall && before === after) {
      console.log(`[workgremlin] · ${t.label}：已是最新 ${t.file}`);
      continue;
    }
    if (uninstall && before === after) {
      console.log(`[workgremlin] · ${t.label}：本来就没装 ${t.file}`);
      continue;
    }

    if (exists && !hasOurs(existing)) {
      fs.copyFileSync(t.file, `${t.file}.bak-workgremlin`);
      console.log(`[workgremlin]   备份 -> ${t.file}.bak-workgremlin`);
    }

    writeSettings(t.file, next, dryRun);
    console.log(`[workgremlin] ✓ ${t.label}：${uninstall ? '已移除' : '已写入'} ${t.file}`);
  }

  if (!uninstall) {
    console.log('');
    console.log('[workgremlin] 生效方式：');
    console.log('  · CodeBuddy 插件：重开会话');
    console.log('  · CodeBuddy / WorkBuddy CLI：改完不会立刻生效，跑 /hooks 过一遍（外部改动需审核）');
    console.log('  · 想换工位名：node scripts/install-hooks.js --uninstall && node scripts/install-hooks.js --member coder');
  }
}

main();
