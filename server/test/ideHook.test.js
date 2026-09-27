'use strict';
/**
 * 回归测试：IDE 形态（Codex 的 VS Code 扩展 / app-server）下的两个坑 ——
 *
 *   ① UserPromptSubmit 的 prompt 是**拼好的**：IDE 在前面注入一段上下文
 *      （`# Context from my IDE setup:` + Active file / Open tabs + `## My request:`），
 *      hook 直接拿整段当任务标题 → 任务列表里只剩注入块，用户那句话一个字都看不见
 *      （标题只截前 TITLE_MAX 字，实测 2026-09-27）。
 *   ② 改动文件记不下来：hook 原先只在 PostToolUse 从 tool_input.command 解析 apply_patch
 *      的 patch 文本，IDE 形态给的是 `input` 键 → 那一路什么都记不到，任务收工
 *      "改动文件"整块是空的。现在：几个键都认 + 收工时按 transcript 里 apply_patch 的
 *      权威清单再补一遍。
 *
 * 跑法：`node server/test/ideHook.test.js`（零依赖：起一个假服务端 + 跑 hook.js 子进程）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ide-hook-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const WS = path.join(TMP, 'ws'); // 假的工程目录 = hook 子进程的 cwd
for (const d of [HOME, WG, path.join(WS, 'src')]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;

const HOOK = path.resolve(__dirname, '..', '..', 'packages', 'reporter', 'src', 'hook.js');

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
function head(t) {
  console.log(`\n${t}`);
}

/* ------------------------------ 假服务端（只回 hook 要的那几个字段） ------------------------------ */
let taskSeq = 0;
/** 收到的 task/start 请求体（要断言 form = 这一轮走的形态） */
const starts = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/api/v1/task/start') starts.push(JSON.parse(body || '{}'));
    const out = req.url === '/api/v1/task/start'
      ? { ok: true, taskId: `t_ide_${++taskSeq}` }
      : { ok: true, project: 'WorkGremlin', workspacePath: WS, taskId: null, title: '' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});

function runHook(payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, '--agent', 'codex'], { cwd: WS, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    child.on('close', () => resolve());
  });
}

function stateOf(sid) {
  const dir = path.join(WG, 'hooks');
  let ents = [];
  try {
    ents = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const name = ents.find((n) => n.includes(sid) && n.endsWith('.json'));
  if (!name) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch {
    return null;
  }
}

/** IDE 插件拼出来的那种 prompt（实测格式） */
const IDE_PROMPT = [
  '# Context from my IDE setup:',
  '',
  '## Active file: renderer/src/stores/sessions.js',
  '',
  '## Open tabs:',
  '- sessions.js: renderer/src/stores/sessions.js',
  '- hook.js: packages/reporter/src/hook.js',
  '',
  '## My request:',
  '把左边 3F 楼层胶囊的 tooltip 改一下',
  '',
].join('\n');

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(WG, 'server.json'), JSON.stringify({ port: server.address().port, token: 'x' }));

  /* [1] 用户原话：剥掉 IDE 注入块 */
  head('[1] IDE 注入的 prompt → 标题只取用户那句话');
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'ideprompt1', cwd: WS, prompt: IDE_PROMPT });
  const s1 = stateOf('ideprompt1');
  ok('「My request:」后面那句成了任务标题', s1 && s1.taskTitle === '把左边 3F 楼层胶囊的 tooltip 改一下', s1 && s1.taskTitle);
  ok('标题里不再有注入块', Boolean(s1) && !/Context from my IDE setup|Active file|Open tabs/.test(s1.taskTitle || ''), s1 && s1.taskTitle);

  head('[2] 普通 prompt 原样保留（别误伤）');
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'ideprompt2', cwd: WS, prompt: '推代码吧' });
  const s2 = stateOf('ideprompt2');
  ok('没有注入块时一字不改', s2 && s2.taskTitle === '推代码吧', s2 && s2.taskTitle);

  head('[3] 整段都是注入内容（没有请求行）→ 不拿它当标题');
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'ideprompt3', cwd: WS, prompt: '# Context from my IDE setup:\n\n## Active file: renderer/src/stores/sessions.js\n' });
  const s3 = stateOf('ideprompt3');
  ok('退化成（未命名任务），不是一整段 IDE 上下文', s3 && s3.taskTitle === '（未命名任务）', s3 && s3.taskTitle);

  /* [4] apply_patch 的 tool_input 是 `input`（IDE / app-server 形态）时也要记到 */
  head('[4] apply_patch 用 `input` 键传 patch 文本 → 照样记进本轮改动文件');
  const FILE4 = 'src/foo.js';
  fs.writeFileSync(path.join(WS, FILE4), 'export const a = 1;\n');
  const PATCH4 = `*** Begin Patch\n*** Update File: ${FILE4}\n@@\n-export const a = 1;\n+export const a = 2;\n*** End Patch\n`;
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'idepatch1', cwd: WS, prompt: '把 a 改成 2' });
  await runHook({ hook_event_name: 'PreToolUse', session_id: 'idepatch1', cwd: WS, tool_name: 'apply_patch', tool_input: { input: PATCH4 } });
  await runHook({ hook_event_name: 'PostToolUse', session_id: 'idepatch1', cwd: WS, tool_name: 'apply_patch', tool_input: { input: PATCH4 } });
  await runHook({ hook_event_name: 'Stop', session_id: 'idepatch1', cwd: WS, transcript_path: '' });
  const s4 = stateOf('idepatch1');
  const files4 = (s4 && s4.done && s4.done.files) || [];
  ok('改动文件清单里有那个文件', files4.some((f) => f.path === FILE4), JSON.stringify(files4));
  ok('带 op=edit 与当前体积', files4.some((f) => f.path === FILE4 && f.op === 'edit' && f.size > 0), JSON.stringify(files4));
  ok('fileCount 与清单条数一致', Boolean(s4 && s4.done) && s4.done.fileCount === files4.length, s4 && JSON.stringify({ c: s4.done && s4.done.fileCount }));

  /* [5] PostToolUse 一路完全没记到时，从 transcript 里补 */
  head('[5] transcript 兜底：apply_patch 的权威清单（Success. Updated the following files）');
  const FILE5 = 'src/bar.js';
  fs.writeFileSync(path.join(WS, FILE5), 'export const b = 1;\n');
  const TS5 = path.join(TMP, 'rollout-test.jsonl');
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'idetx1', cwd: WS, prompt: '再加一个文件' });
  // 本轮开始之后：transcript 里留下 apply_patch 的结果（相对路径 + M/A/D 标记）
  fs.writeFileSync(
    TS5,
    JSON.stringify({
      timestamp: new Date(Date.now()).toISOString(),
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        output: `Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess. Updated the following files:\nA ${FILE5}\n`,
      },
    }) + '\n'
  );
  await runHook({ hook_event_name: 'Stop', session_id: 'idetx1', cwd: WS, transcript_path: TS5 });
  const s5 = stateOf('idetx1');
  const files5 = (s5 && s5.done && s5.done.files) || [];
  ok('没记到的改动由 transcript 补上', files5.some((f) => f.path === FILE5), JSON.stringify(files5));
  ok('新增文件按 write 记（A 标记）', files5.some((f) => f.path === FILE5 && f.op === 'write'), JSON.stringify(files5));

  /* [6] transcript 里上一轮的记录不算这一轮 */
  head('[6] 上一轮的改动（时间戳早于本轮开始）不进本轮清单');
  const FILE6 = 'src/old.js';
  fs.writeFileSync(path.join(WS, FILE6), 'export const c = 1;\n');
  const TS6 = path.join(TMP, 'rollout-old.jsonl');
  fs.writeFileSync(
    TS6,
    JSON.stringify({
      timestamp: new Date(Date.now() - 3600_000).toISOString(),
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', output: `Success. Updated the following files:\nM ${FILE6}\n` },
    }) + '\n'
  );
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'idetx2', cwd: WS, prompt: '这一轮没改文件' });
  await runHook({ hook_event_name: 'Stop', session_id: 'idetx2', cwd: WS, transcript_path: TS6 });
  const s6 = stateOf('idetx2');
  const files6 = (s6 && s6.done && s6.done.files) || [];
  ok('一小时前那条改动没被算进本轮', !files6.some((f) => f.path === FILE6), JSON.stringify(files6));

  /* [7] 形态（CLI / IDE 插件）：Codex 的两种形态共用一份落盘、client 都是 codex，
   *     只有 rollout 的 session_meta 分得出 —— 任务列表的「Codex CLI / Codex Plugin」靠它 */
  head('[7] 形态上报：rollout 的 session_meta 说是谁起的 → task/start 带 form');
  const mkRollout = (file, meta) => {
    fs.writeFileSync(
      path.join(TMP, file),
      JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: meta }) + '\n'
    );
    return path.join(TMP, file);
  };
  const TS_IDE = mkRollout('rollout-ide.jsonl', { session_id: 'ideform1', source: 'vscode', originator: 'codex_vscode' });
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'ideform1', cwd: WS, prompt: 'IDE 里的一轮', transcript_path: TS_IDE });
  ok('VS Code 扩展起的会话 → form=plugin', starts[starts.length - 1].form === 'plugin', JSON.stringify(starts[starts.length - 1]));
  ok('形态写进了状态文件（下一轮直接用）', stateOf('ideform1').form === 'plugin', stateOf('ideform1').form);

  const TS_TUI = mkRollout('rollout-tui.jsonl', { session_id: 'ideform2', source: 'cli', originator: 'codex-tui' });
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'ideform2', cwd: WS, prompt: '终端里的一轮', transcript_path: TS_TUI });
  ok('终端 CLI 起的会话 → form=cli', starts[starts.length - 1].form === 'cli', JSON.stringify(starts[starts.length - 1]));

  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'ideform3', cwd: WS, prompt: '读不到 rollout 的一轮' });
  ok('读不到 rollout 就不猜（form 为空）', !starts[starts.length - 1].form, JSON.stringify(starts[starts.length - 1]));


  /* [8] 兜底那一路：agent 用 shell 改文件（sed -i / patch / python）时，前两路都看不到，
   *     靠 mtime 扫（git ls-files 里 mtime ≥ 本轮开始）把"文件变化 0"救回来 */
  head('[8] mtime 兜底：shell 改过的文件也要算进本轮改动');
  const { execSync } = require('node:child_process');
  const TMPGIT = path.join(TMP, 'gitws');
  fs.mkdirSync(path.join(TMPGIT, 'src'), { recursive: true });
  execSync('git init -q', { cwd: TMPGIT });
  fs.writeFileSync(path.join(TMPGIT, 'src/tracked.js'), 'export const t = 1;\n');
  execSync('git add src/tracked.js', { cwd: TMPGIT });
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'idegit1', cwd: TMPGIT, prompt: '用 shell 改两个文件' });
  await new Promise((r) => setTimeout(r, 20)); // mtime 必须晚于本轮开始
  fs.writeFileSync(path.join(TMPGIT, 'src/tracked.js'), 'export const t = 2;\n');
  fs.writeFileSync(path.join(TMPGIT, 'src/new.js'), 'export const n = 1;\n');
  await runHook({ hook_event_name: 'Stop', session_id: 'idegit1', cwd: TMPGIT, transcript_path: '' });
  const files8 = (stateOf('idegit1').done.files || []).map((f) => `${f.path}:${f.op}`);
  ok('改过的已跟踪文件进来了', files8.includes('src/tracked.js:edit'), JSON.stringify(files8));
  ok('新建的未跟踪文件按 write 记', files8.includes('src/new.js:write'), JSON.stringify(files8));
  ok('本轮之前就有的文件不算（src/foo.js 是上一轮写的）', !files8.some((x) => x.startsWith('src/foo.js')), JSON.stringify(files8));
  server.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main();
