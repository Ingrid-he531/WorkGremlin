'use strict';
/**
 * install-hooks / install-plugins self-test.
 *
 * Bug it locks (measured 2026-10-14): the repo was cloned to a second directory and run from there.
 * Its hooks installer identified "our" entries by the **absolute** hook.js path, so the entry left by
 * the first checkout was not recognized, was never stripped, and a second entry was appended. Every
 * CodeBuddy event then fired our hook **twice** → two `UserPromptSubmit` → two same-title tasks in one
 * session (the earlier one cancelled by `endStaleTasksOfSession`).
 *
 * The fix matches our entries by the **repo-relative** path (`packages/reporter/src/hook.js`), so any
 * checkout's entry (old absolute path included) is recognized and replaced, not duplicated.
 *
 * Run: `npm run test:install-hooks`
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-install-hooks-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.codebuddy'), { recursive: true });
// A marker file so looksInstalled() passes for codebuddy without needing the real CLI in PATH.
fs.writeFileSync(path.join(HOME, '.codebuddy', 'credentials.json'), '{}');
// install-hooks captures HOME at require time → set it first.
process.env.HOME = HOME;
process.env.WORKGREMLIN_NO_AUTO_HOOKS = '1';

const { installHooks, HOOK_SCRIPT } = require('../../scripts/install-hooks');

const SETTINGS = path.join(HOME, '.codebuddy', 'settings.json');
const OLD_HOOK = '/home/someone/work/WorkGremlin/packages/reporter/src/hook.js'; // a different checkout
const OUR_SUFFIX = 'packages/reporter/src/hook.js';

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? `  — ${extra}` : ''}`);
  }
};

const readSettings = () => JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
const isOurGroup = (g) => (g.hooks || []).some((h) => String(h.command).replace(/\\/g, '/').includes(OUR_SUFFIX));
/** event -> how many of our hook groups it has */
const ourCountByEvent = () => {
  const s = readSettings();
  const out = {};
  for (const [ev, arr] of Object.entries(s.hooks || {})) out[ev] = (Array.isArray(arr) ? arr : []).filter(isOurGroup).length;
  return out;
};

// Pre-seed the config as the bug left it: an entry from the OLD checkout for every event.
const OLD_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];
const seed = [];
for (const ev of OLD_EVENTS) {
  seed.push({ matcher: null, hooks: [{ type: 'command', command: `node "${OLD_HOOK}" --agent codebuddy`, timeout: 10 }] });
}
fs.writeFileSync(SETTINGS, `${JSON.stringify({ hooks: { SessionStart: seed, UserPromptSubmit: seed, PreToolUse: seed, Stop: seed } }, null, 2)}\n`);

console.log('\n[1] 装一次：旧 checkout 的条目必须被认出来、换成当前 checkout，而不是并列两条');
installHooks({ targets: 'codebuddy' });
{
  const byEvent = ourCountByEvent();
  ok('seed 的每个事件都只剩一条我们的 hook（旧条目被替换，不是并列）', OLD_EVENTS.every((ev) => byEvent[ev] === 1), JSON.stringify(byEvent));
  const cmds = Object.values(readSettings().hooks || {})
    .flatMap((arr) => (Array.isArray(arr) ? arr : []))
    .filter(isOurGroup)
    .map((g) => g.hooks[0].command);
  ok('留下的是**当前** checkout 的命令（含当前绝对路径）', cmds.every((c) => c.includes(HOOK_SCRIPT)), JSON.stringify(cmds));
  ok('旧 checkout（不同绝对路径）的那条已被删掉', cmds.every((c) => !c.includes('/home/someone/work/WorkGremlin')), JSON.stringify(cmds));
  ok('UserPromptSubmit 只有一条', (readSettings().hooks.UserPromptSubmit || []).length === 1);
}

console.log('\n[2] 再装一次：幂等（不留第二条、也不再改文件）');
{
  const before = fs.readFileSync(SETTINGS, 'utf8');
  installHooks({ targets: 'codebuddy' });
  const after = fs.readFileSync(SETTINGS, 'utf8');
  ok('内容没变（already up to date）', before === after);
  ok('我们的 hook 仍然每个事件最多一条', Object.values(ourCountByEvent()).every((n) => n <= 1), JSON.stringify(ourCountByEvent()));
}

console.log('\n[3] 别家的 hook 不动');
{
  const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  s.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'node /opt/other/hook.js', timeout: 10 }] });
  fs.writeFileSync(SETTINGS, `${JSON.stringify(s, null, 2)}\n`);
  installHooks({ targets: 'codebuddy' });
  const ups = readSettings().hooks.UserPromptSubmit || [];
  ok('别人的那条还在', ups.some((g) => (g.hooks || []).some((h) => h.command === 'node /opt/other/hook.js')));
  ok('我们的仍然只有一条', ups.filter((g) => (g.hooks || []).some((h) => String(h.command).replace(/\\/g, '/').includes(OUR_SUFFIX))).length === 1);
}

console.log('\n[4] 卸载：只撤我们的');
{
  installHooks({ targets: 'codebuddy', uninstall: true });
  ok('我们的 hook 全撤了', Object.values(ourCountByEvent()).every((n) => n === 0), JSON.stringify(ourCountByEvent()));
  const ups = readSettings().hooks.UserPromptSubmit || [];
  ok('别人的那条还在', ups.some((g) => (g.hooks || []).some((h) => h.command === 'node /opt/other/hook.js')));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
