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

/**
 * 跑一次 hook。extraEnv 用来试 WORKGREMLIN_DISABLE（议事厅的参与者注入的就是它）。
 * resolve 退出码 —— 各家 CLI 是**同步等着** hook 结束的，早退那一路的退出码也是行为的一部分。
 */
function runHookWithEnv(payload, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, '--agent', 'claude'], {
      cwd: WS,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, ...(extraEnv || {}) },
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    child.on('close', (code) => resolve(code));
  });
}

const runHook = (payload) => runHookWithEnv(payload, null);

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

  /* [6] 注入信封不当新一轮：Claude Code 把「后台子 agent 完成」从用户输入队列投递，
   *     于是 UserPromptSubmit 照常触发、ev.prompt 就是那段 XML（实测 2026-09-30）。 */
  head('[6] <task-notification> 不当用户任务：不开新任务、不动正在跑的那一轮');
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cfm-inj', cwd: WS, prompt: '真的用户任务' });
  const st6 = stateOf('cfm-inj');
  const starts6 = starts.length;
  const ends6 = ends.length;
  const NOTIFY = [
    '<task-notification>',
    '<task-id>a8be33807de04142a</task-id>',
    '<tool-use-id>call_00_rARf9Selg5A31PAQWXXa4188</tool-use-id>',
    '<status>completed</status>',
    '<summary>Agent "Design per-round Kilo ledger fix" finished</summary>',
    '</task-notification>',
  ].join('\n');
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cfm-inj', cwd: WS, prompt: NOTIFY });
  const st6b = stateOf('cfm-inj') || {};
  ok('没开新任务（task/start 一次都没发）', starts.length === starts6, `starts ${starts6} → ${starts.length}`);
  ok('也没发收工上报', ends.length === ends6, `ends ${ends6} → ${ends.length}`);
  ok('正在跑那轮的 taskId 原样保留（没被覆盖）', Boolean(st6.taskId) && st6b.taskId === st6.taskId, `${st6.taskId} → ${st6b.taskId}`);
  ok('标题没被那段 XML 顶掉', st6b.taskTitle === '真的用户任务', JSON.stringify(st6b.taskTitle));
  ok('相位没被这次注入刷新', st6b.sessionPhase && st6.sessionPhase && st6b.sessionPhase.ts === st6.sessionPhase.ts);

  /* [7] 同一类信封：别的会话 / subagent 递过来的消息 */
  head('[7] <agent-message> 同样不当用户任务');
  const starts7 = starts.length;
  await runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'cfm-inj',
    cwd: WS,
    prompt: '<agent-message from="a73b954e42a3f777e">\n帮我看一眼 7F\n</agent-message>',
  });
  ok('没开新任务', starts.length === starts7, `starts ${starts7} → ${starts.length}`);

  /* [8] 边界：真人那句话**中间**提到这个字样（用户报这个 bug 时就是这么写的）—— 必须照常开任务 */
  head('[8] 边界：<task-notification> 出现在真人 prompt 中间 → 照常开任务');
  const starts8 = starts.length;
  await runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'cfm-real',
    cwd: WS,
    prompt: '后面就又出现一个新任务，prompt 是：<task-notification> <task-id>a8be33807de04142a</task-id>，你看看',
  });
  ok('照常开任务', starts.length === starts8 + 1, `starts ${starts8} → ${starts.length}`);
  ok('标题是用户原话', String(lastStart().title || '').startsWith('后面就又出现一个新任务'), JSON.stringify(lastStart().title));

  /* [9] IDE 注入的"打开了某文件"是**前缀**，不是整条信封：剥掉块、留下用户原话当标题
   *     （实测 2026-09-24：标题被这个块占满，落了两条看不见用户话的任务） */
  head('[9] <ide_opened_file> 是前缀 → 剥掉块，标题留用户原话');
  const starts9 = starts.length;
  await runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'cfm-ide-open',
    cwd: WS,
    prompt:
      '<ide_opened_file>The user opened the file /home/yinghui/work/WorkGremlin/packages/reporter/src/hook.js in the IDE. This may or may not be related to the current task.</ide_opened_file>装上吧',
  });
  ok('照常开任务（它是真 prompt，不能整条丢掉）', starts.length === starts9 + 1, `starts ${starts9} → ${starts.length}`);
  ok('标题是用户原话（不是那串 XML）', lastStart().title === '装上吧', JSON.stringify(lastStart().title));

  /* [10] WORKGREMLIN_DISABLE=1：议事厅的参与者一个字都不上报（见 council/agents.js 的 QUIET_ENV）
   *      工程模式下参与者的 cwd 就是用户的真实工程，挡不住这一下，参与者当场变成
   *      "你工程里的一个成员" —— 直接违反"只在议事厅看得见"。*/
  head('[10] WORKGREMLIN_DISABLE=1 → 什么都不上报（议事厅的参与者）');
  const quietPayload = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'cfm-quiet',
    cwd: WS,
    prompt: '议事厅参与者说的这一句不该出现在任何地方',
    transcript_path: mkTranscript('cfm-quiet.jsonl', 'cli'),
  };
  const starts10 = starts.length;
  const ends10 = ends.length;
  const code = await runHookWithEnv(quietPayload, { WORKGREMLIN_DISABLE: '1' });
  ok('没有 task/start（这是"参与者进办公室"的唯一入口）', starts.length === starts10, `starts ${starts10} → ${starts.length}`);
  ok('没有 task/end', ends.length === ends10, `ends ${ends10} → ${ends.length}`);
  ok('也没留下会话状态文件', stateOf('cfm-quiet') === null);
  ok('退出码 0（各家 CLI 同步等它，早退不能变成一条报错）', code === 0, String(code));

  // 对照：同一条 payload、去掉那个变量 → 必须真的上报。
  // 少了这一条，上面四条是"因为整条路都坏了"才通过的，验不出什么。
  head('[10b] 对照组：不设那个变量时，同一条 payload 照常上报');
  const starts10b = starts.length;
  await runHook(quietPayload);
  ok('task/start 来了（说明上面挡住的确实是我们挡的）', starts.length === starts10b + 1, `starts ${starts10b} → ${starts.length}`);

  server.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
