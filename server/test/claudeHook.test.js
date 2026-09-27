/**
 * 回归测试：Claude Code 的**形态**（终端 CLI / VS Code 扩展）随任务上报 —— 4F 的 3F Codex 同款问题。
 *
 * 背景：Claude 的 CLI 与 VS Code 扩展共用同一份 ~/.claude、同一套 hook、同一个 client
 * （4F 就是这么合并的，见 server/src/products.js），hook payload 里没有任何字段分得出二者
 * （实测每个事件只有 session_id / transcript_path / cwd / permission_mode），
 * 任务列表光看 client 只能显示「Claude Code」。
 *
 * 分得出的是**会话自己落的 transcript**：第 3~5 行的 `entrypoint`（实测 2.1.283）——
 * 终端起的是 'cli'，VS Code 扩展起的是 'claude-vscode'。hook 认出形态（form = 'cli' | 'plugin'，
 * 见 packages/reporter/src/hook.js 的 claudeForm）随任务上报，落 task_runs.form，
 * 任务列表才标得成「Claude Code CLI / Claude Code Plugin」。
 *
 * 这个文件只盯"认得出 / 认不出"这两种结果：认不出（老版本没有 entrypoint、落盘读不到、
 * entrypoint 是 sdk-cli 这类别的形态）必须**留空**，绝不猜 —— 服务端存 NULL、列表退回产品名。
 *
 * 跑法：`npm run test:claude-hook`（零依赖：起一个假服务端 + 跑 hook.js 子进程，--agent claude）。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-claude-hook-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const WS = path.join(TMP, 'ws'); // 假的工程目录 = hook 子进程的 cwd
for (const d of [HOME, WG, WS]) fs.mkdirSync(d, { recursive: true });
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
/** 收到的 task/start、task/end 请求体（断言 form 有没有跟着走） */
const starts = [];
const ends = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/api/v1/task/start') starts.push(JSON.parse(body || '{}'));
    if (req.url === '/api/v1/task/end') ends.push(JSON.parse(body || '{}'));
    const out = req.url === '/api/v1/task/start'
      ? { ok: true, taskId: `t_claude_${++taskSeq}` }
      : { ok: true, project: 'WorkGremlin', workspacePath: WS, taskId: null, title: '' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});

function runHook(payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, '--agent', 'claude'], { cwd: WS, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    child.on('close', () => resolve());
  });
}

/** 最近一次 task/start、task/end 收到的请求体 */
const lastStart = () => starts[starts.length - 1] || {};
const lastEnd = () => ends[ends.length - 1] || {};

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

/**
 * 造一份 Claude transcript 的**文件头**（真实形状：前两行是启动期的 mode / operation 记录，
 * entrypoint 落在第一条 user 记录上）。`entrypoint` 传 null 表示这个版本/这条会话没有这一位。
 */
function mkTranscript(file, entrypoint) {
  const p = path.join(TMP, file);
  const sid = file.replace(/\.jsonl$/, '');
  const lines = [
    { type: 'mode', mode: 'default', sessionId: sid },
    { type: 'operation', operation: 'enqueue', sessionId: sid, timestamp: new Date().toISOString() },
    {
      type: 'user',
      ...(entrypoint ? { entrypoint } : {}),
      sessionId: sid,
      cwd: WS,
      userType: 'external',
      message: { role: 'user', content: '随便说一句' },
    },
  ];
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(WG, 'server.json'), JSON.stringify({ port: server.address().port, token: 'x' }));

  /* [1] 终端 CLI 起的会话：entrypoint 'cli' → form=cli */
  head('[1] 终端 CLI：transcript 的 entrypoint=cli → task/start 带 form=cli');
  await runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'cfm-cli',
    cwd: WS,
    prompt: '把 4F 的标签补上形态',
    transcript_path: mkTranscript('cfm-cli.jsonl', 'cli'),
  });
  ok('task/start 的 form=cli', lastStart().form === 'cli', JSON.stringify(lastStart()));
  ok('形态写进了状态文件（认过就不再读盘）', stateOf('cfm-cli').form === 'cli', JSON.stringify(stateOf('cfm-cli')));

  /* [2] VS Code 扩展起的会话：entrypoint 'claude-vscode' → form=plugin */
  head('[2] VS Code 扩展：transcript 的 entrypoint=claude-vscode → task/start 带 form=plugin');
  const tsIde = mkTranscript('cfm-ide.jsonl', 'claude-vscode');
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cfm-ide', cwd: WS, prompt: '在 IDE 里问一句', transcript_path: tsIde });
  ok('task/start 的 form=plugin', lastStart().form === 'plugin', JSON.stringify(lastStart()));

  /* [3] 认不出就不猜：别的形态 / 没有这一位 / 读不到落盘 —— 一律不带 form */
  head('[3] 认不出就不猜（form 留空）：sdk-cli / 老版本没有 entrypoint / 落盘读不到');
  await runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'cfm-sdk',
    cwd: WS,
    prompt: 'SDK 起的一轮',
    transcript_path: mkTranscript('cfm-sdk.jsonl', 'sdk-cli'),
  });
  ok('entrypoint=sdk-cli（不是「终端 vs IDE 插件」里的任何一种）→ 不带 form', !lastStart().form, JSON.stringify(lastStart()));
  await runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'cfm-old',
    cwd: WS,
    prompt: '老版本的一轮',
    transcript_path: mkTranscript('cfm-old.jsonl', null),
  });
  ok('transcript 里没有 entrypoint（老版本）→ 不带 form', !lastStart().form, JSON.stringify(lastStart()));
  await runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'cfm-miss',
    cwd: WS,
    prompt: '落盘读不到的一轮',
    transcript_path: path.join(TMP, '根本不存在的.jsonl'),
  });
  ok('落盘读不到 → 不带 form', !lastStart().form, JSON.stringify(lastStart()));
  ok('认不出的会话没往状态文件里写 form', !(stateOf('cfm-miss') || {}).form, JSON.stringify(stateOf('cfm-miss')));

  /* [4] 形态是会话级的：认过一次就写进状态文件，落盘后面读不到（删了 / 路径变了）也照报 */
  head('[4] 认过就缓存：下一轮落盘读不到也照报（会话级真值）');
  fs.rmSync(tsIde, { force: true });
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cfm-ide', cwd: WS, prompt: '第二轮', transcript_path: '' });
  ok('第二轮（transcript 已删）仍然是 form=plugin', lastStart().form === 'plugin', JSON.stringify(lastStart()));

  /* [5] 收工兜底：开轮时落盘还没写好 → task/end 再认一次，TASK_END 与开轮同口径 */
  head('[5] 收工兜底：开轮读不出 → task/end 补上 form');
  const tsLate = mkTranscript('cfm-late.jsonl', 'claude-vscode');
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cfm-late', cwd: WS, prompt: '开轮时还没有 transcript' });
  ok('开轮那一下确实读不到（不带 form）', !lastStart().form, JSON.stringify(lastStart()));
  await runHook({
    hook_event_name: 'Stop',
    session_id: 'cfm-late',
    cwd: WS,
    transcript_path: tsLate,
    last_assistant_message: '干完了',
  });
  ok('task/end 带上了 form=plugin', lastEnd().form === 'plugin', JSON.stringify(lastEnd()));
  ok('这一笔确实是收工上报（带 taskId）', Boolean(lastEnd().taskId), JSON.stringify(lastEnd()));

  server.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
