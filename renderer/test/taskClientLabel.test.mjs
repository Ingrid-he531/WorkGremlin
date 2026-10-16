/**
 * Task-list "client" label self-check: the **form** a round ran as (CLI / IDE plugin) must appear
 * in the label.
 *
 * Background: Codex (3F) and Claude Code (4F) share one on-disk store and one client between the
 * CLI and their IDE extension (that is why the floor is merged); from the client alone you can
 * only show "Codex" / "Claude Code". The hook recognizes the form from the session's own record
 * (form = 'cli' | 'plugin', see packages/reporter/src/hook.js codexForm / claudeForm) and reports
 * it with the task; this layer only joins the two into "Codex CLI / Codex Plugin" and
 * "Claude Code CLI / Claude Code Plugin". The client is always the floor base name and the form is
 * the only axis — an unrecognized form is never guessed.
 *
 * Run: `npm run test:task-client` (node runs it directly; renderer .js is treated as ESM by node's syntax check)
 */
const { clientLabel, formToSource } = await import('@workgremlin/shared');

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
ok('form=vscode → Codex Plugin', clientLabel('codex', 'vscode') === 'Codex Plugin', clientLabel('codex', 'vscode'));
// The Codex desktop app reports source=vscode; it must show as "Codex Desktop", never "Codex Plugin".
ok('form=desktop → Codex Desktop', clientLabel('codex', 'desktop') === 'Codex Desktop', clientLabel('codex', 'desktop'));
ok('form=DESKTOP 大小写不敏感 → Codex Desktop', clientLabel('codex', 'DESKTOP') === 'Codex Desktop', clientLabel('codex', 'DESKTOP'));
ok('没有 form（老数据 / 读不到 rollout）→ 还是 Codex', clientLabel('codex') === 'Codex', clientLabel('codex'));
ok('form 大小写不敏感', clientLabel('codex', 'VSCODE') === 'Codex Plugin', clientLabel('codex', 'VSCODE'));

console.log('\n[1b] form → source 映射：desktop 单独一档，不当 plugin');
ok("form=vscode → source=plugin", formToSource('vscode') === 'plugin', formToSource('vscode'));
ok("form=desktop → source=desktop", formToSource('desktop') === 'desktop', formToSource('desktop'));
ok("form=cli → source=cli", formToSource('cli') === 'cli', formToSource('cli'));

console.log('\n[2] Claude Code：同理，靠 form 补（CLI 与 VS Code 扩展共用同一个 client）');
ok('form=cli → Claude Code CLI', clientLabel('claude', 'cli') === 'Claude Code CLI', clientLabel('claude', 'cli'));
ok(
  'form=vscode → Claude Code Plugin',
  clientLabel('claude', 'vscode') === 'Claude Code Plugin',
  clientLabel('claude', 'vscode')
);
ok('没有 form（老数据 / 下游没认出来）→ 还是 Claude Code', clientLabel('claude') === 'Claude Code', clientLabel('claude'));

console.log('\n[3] 楼层基名 + form（client 不再带 -plugin 后缀）');
ok('codebuddy + form=cli → CodeBuddy CLI', clientLabel('codebuddy', 'cli') === 'CodeBuddy CLI', clientLabel('codebuddy', 'cli'));
ok('codebuddy + form=vscode → CodeBuddy Plugin', clientLabel('codebuddy', 'vscode') === 'CodeBuddy Plugin', clientLabel('codebuddy', 'vscode'));
ok('memberId 形态（name@project）也归到楼层', clientLabel('codebuddy@proj', 'vscode') === 'CodeBuddy Plugin', clientLabel('codebuddy@proj', 'vscode'));

console.log('\n[4] 认不出的一律不猜');
ok("form='' → Claude Code", clientLabel('claude', '') === 'Claude Code', clientLabel('claude', ''));
ok("form='weird' → Claude Code", clientLabel('claude', 'weird') === 'Claude Code', clientLabel('claude', 'weird'));
ok('未知 client 原样返回 + 形态', clientLabel('mystery', 'cli') === 'mystery CLI', clientLabel('mystery', 'cli'));
ok('空 client 显示占位符', clientLabel('') === '—', clientLabel(''));

console.log('\n[5] TraeCode（5F）：base 标签是 TraeCode，形态靠 form 区分');
ok('trae（无 form）→ TraeCode', clientLabel('trae') === 'TraeCode', clientLabel('trae'));
ok('trae + form=vscode → TraeCode Plugin', clientLabel('trae', 'vscode') === 'TraeCode Plugin', clientLabel('trae', 'vscode'));
ok('trae + form=cli → TraeCode CLI', clientLabel('trae', 'cli') === 'TraeCode CLI', clientLabel('trae', 'cli'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
