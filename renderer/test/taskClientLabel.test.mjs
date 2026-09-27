/**
 * 任务列表「客户端」标签自检：一轮任务走的**形态**（CLI / IDE 插件）要出现在标签里。
 *
 * 背景：Codex 的 CLI 与 VS Code 扩展共用一份 ~/.codex、同一个 client（3F 就是这么合并的），
 * 光看 client 只能显示 "Codex"。hook 从 rollout 的 session_meta 认出形态
 * （form = 'cli' | 'plugin'，见 packages/reporter/src/hook.js 的 codexForm）随任务一起上报，
 * 这一层只负责把两样拼成「Codex CLI / Codex Plugin」；标签里已经带形态的
 * （CodeBuddy CLI / CodeBuddy Plugin）不重复追加，认不出的 form 一律不猜。
 *
 * 跑法：`npm run test:task-client`（node 直接跑；renderer 的 .js 由 node 的语法检测当 ESM）
 */
const { clientLabel } = await import('../src/lib/clientMatch.js');

let pass = 0;
let fail = 0;
function ok(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? `  — ${extra}` : ''}`);
  }
}

console.log('\n[1] Codex：client 分不出两种形态，靠 form 补');
ok('form=cli → Codex CLI', clientLabel('codex', 'cli') === 'Codex CLI', clientLabel('codex', 'cli'));
ok('form=plugin → Codex Plugin', clientLabel('codex', 'plugin') === 'Codex Plugin', clientLabel('codex', 'plugin'));
ok('没有 form（老数据 / 读不到 rollout）→ 还是 Codex', clientLabel('codex') === 'Codex', clientLabel('codex'));
ok('form 大小写不敏感', clientLabel('codex', 'PLUGIN') === 'Codex Plugin', clientLabel('codex', 'PLUGIN'));

console.log('\n[2] 已经带形态的 client 不重复追加');
ok('codebuddy → CodeBuddy CLI', clientLabel('codebuddy', 'cli') === 'CodeBuddy CLI', clientLabel('codebuddy', 'cli'));
ok(
  'codebuddy-plugin → CodeBuddy Plugin（只一个）',
  clientLabel('codebuddy-plugin', 'plugin') === 'CodeBuddy Plugin',
  clientLabel('codebuddy-plugin', 'plugin')
);

console.log('\n[3] 认不出的一律不猜');
ok("form='' → Claude Code", clientLabel('claude', '') === 'Claude Code', clientLabel('claude', ''));
ok("form='weird' → Claude Code", clientLabel('claude', 'weird') === 'Claude Code', clientLabel('claude', 'weird'));
ok('未知 client 原样返回 + 形态', clientLabel('mystery', 'cli') === 'mystery CLI', clientLabel('mystery', 'cli'));
ok('空 client 显示占位符', clientLabel('') === '—', clientLabel(''));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
