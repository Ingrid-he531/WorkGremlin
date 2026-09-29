/**
 * 回归测试：用户按 ESC / 停止打断那一轮 → 控制台得亮红色「任务取消」，而不是「任务完成」。
 *
 * 背景：Interrupt（打断）与 Stop（这一轮结束了）是两件事。以前只有 Stop 会落"完成"标记，
 * 被打断的那一轮跟着 Stop 一起收尾 → 主控制台照样报「任务完成」，用户明明没让它干完。
 * 现在 Interrupt 自己落一枚 done（**与 Stop 同形，多一个 cancelled:true**），
 * 服务端与渲染层照同一条路透传，UI 据此换成红色「任务取消」。
 *
 * 这个文件盯四件事（都是"别把打断当成完成"这条线的关键分岔）：
 *   [1] 打断 → done.cancelled 为真、task/end state=cancelled、任务槽清空；
 *   [2] ESC 之后常常紧跟着来一次 Stop（那一轮照样"结束了"）→ 不许把取消标记盖成完成；
 *   [3] 打断后用户又发了新任务 → 新一轮的 Stop 照常落"完成"（不能一直红着）；
 *   [4] 什么都没改就被打断 → files 为空 / fileCount=0：渲染层显示「没有输出」而不是文件清单。
 *   [5] 改了文件之后才取消 → 取消标记照样带"取消前动过的文件"（不是永远「没有输出」）：
 *       用户说的对——被打断的那一轮常常已经改了文件，done.files 必须如实带上，UI 才列得出清单。
 *
 * 跑法：`npm run test:cancel`（零依赖：起一个假服务端 + 跑 hook.js 子进程，--agent claude）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cancel-'));
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
/** 收到的 task/start、task/end 请求体 */
const starts = [];
const ends = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/api/v1/task/start') starts.push(JSON.parse(body || '{}'));
    if (req.url === '/api/v1/task/end') ends.push(JSON.parse(body || '{}'));
    const out = req.url === '/api/v1/task/start'
      ? { ok: true, taskId: `t_cancel_${++taskSeq}` }
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
  // 文件名里还带着工程路径（claude__tmp_xxx_ws_<session>.json），只按 sid 子串找会串到别的会话：
  // 认准"_<sid>.json"这个尾巴。
  const name = ents.find((n) => n.includes(`_${sid}.json`));
  if (!name) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch {
    return null;
  }
}

/** 造一份最小 transcript（hook 会拿它找本轮回复；这里只需要"能读"） */
function mkTranscript(file, { withReply = true } = {}) {
  const p = path.join(TMP, file);
  const sid = file.replace(/\.jsonl$/, '');
  const lines = [{ type: 'user', sessionId: sid, cwd: WS, message: { role: 'user', content: '改点东西' } }];
  if (withReply) {
    lines.push({ type: 'assistant', sessionId: sid, cwd: WS, message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } });
  }
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(WG, 'server.json'), JSON.stringify({ port: server.address().port, token: 'x' }));

  const ts = mkTranscript('cancel-a.jsonl');

  /* [1] 打断：落"取消"标记 */
  head('[1] ESC / 停止打断 → done.cancelled，任务按 cancelled 收尾');
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cancel-a', cwd: WS, prompt: '把办公室改一下', transcript_path: ts });
  const startedWith = stateOf('cancel-a').taskId;
  ok('开轮：状态文件里有任务', Boolean(startedWith), JSON.stringify(stateOf('cancel-a')));
  await runHook({ hook_event_name: 'Interrupt', session_id: 'cancel-a', cwd: WS, transcript_path: ts });
  const st1 = stateOf('cancel-a');
  ok('落了取消标记（done.cancelled 为真）', st1.done && st1.done.cancelled === true, JSON.stringify(st1.done));
  ok('完成标记形状与 Stop 同款（有 at / sessionId / files / fileCount）', Boolean(st1.done && st1.done.at && st1.done.sessionId), JSON.stringify(st1.done));
  ok('任务槽清空了（taskId 回到空）', !st1.taskId, JSON.stringify(st1));
  ok('task/end 报的是 cancelled（不是 done）', lastEnd().state === 'cancelled', JSON.stringify(lastEnd()));

  /* [2] ESC 之后紧跟着的 Stop 不许把取消盖成完成 */
  head('[2] 打断后紧跟着的 Stop：不许把「任务取消」盖成「任务完成」');
  await runHook({ hook_event_name: 'Stop', session_id: 'cancel-a', cwd: WS, transcript_path: ts, last_assistant_message: '（被打断）' });
  const st2 = stateOf('cancel-a');
  ok('仍然是取消标记', st2.done && st2.done.cancelled === true, JSON.stringify(st2.done));
  ok('没被换成一枚新的完成标记（at 没变）', st2.done.at === st1.done.at, `${st1.done.at} → ${st2.done.at}`);

  /* [3] 打断后又发新任务 → 新一轮照常算完成 */
  head('[3] 打断后又发了新任务：新一轮的 Stop 照常落"完成"（不能一直红着）');
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cancel-a', cwd: WS, prompt: '再来一轮', transcript_path: ts });
  ok('新一轮有任务在跑', Boolean(stateOf('cancel-a').taskId), JSON.stringify(stateOf('cancel-a')));
  await runHook({ hook_event_name: 'Stop', session_id: 'cancel-a', cwd: WS, transcript_path: ts, last_assistant_message: '这轮干完了' });
  const st3 = stateOf('cancel-a');
  ok('新一轮是完成的（不是取消）', st3.done && !st3.done.cancelled, JSON.stringify(st3.done));
  ok('完成标记是新的（at 推进了）', Number(st3.done.at) > Number(st1.done.at), `${st1.done.at} → ${st3.done.at}`);

  /* [4] 什么都没改、也没吐字就被打断 → 没有输出（UI 显示「没有输出」） */
  head('[4] 什么都没改、也没吐字就被打断 → 文件清单与摘要都空（UI 显示「没有输出」）');
  // 这一轮的 transcript 里**没有** assistant 回复（真·没有输出）—— 有回复时按 [4b] 照记，
  // 所以这里用 withReply:false 造"一句话都没来得及说"的形态。
  const ts2 = mkTranscript('cancel-b.jsonl', { withReply: false });
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cancel-b', cwd: WS, prompt: '想一想就行', transcript_path: ts2 });
  await runHook({ hook_event_name: 'Interrupt', session_id: 'cancel-b', cwd: WS, transcript_path: ts2 });
  const st4 = stateOf('cancel-b');
  ok('done.fileCount = 0', st4.done && st4.done.fileCount === 0, JSON.stringify(st4.done));
  ok('done.files 是空数组（不是 null / undefined）', st4.done && Array.isArray(st4.done.files) && st4.done.files.length === 0, JSON.stringify(st4.done));
  ok('said 留空（这一轮一个字都没吐）', st4.done && st4.done.said === '', JSON.stringify(st4.done));

  /* [4b] 被打断的那一轮已经吐了话 → 照「任务完成」一样记（不因"取消"丢产出） */
  head('[4b] 打断前已经吐了话 → said / 台账 result 照常记（取消≠没产出）');
  const ts4 = mkTranscript('cancel-d.jsonl'); // 带一句 assistant 回复
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cancel-d', cwd: WS, prompt: '说两句就停', transcript_path: ts4 });
  await runHook({ hook_event_name: 'Interrupt', session_id: 'cancel-d', cwd: WS, transcript_path: ts4 });
  const st4b = stateOf('cancel-d');
  ok('仍是取消', st4b.done && st4b.done.cancelled === true, JSON.stringify(st4b.done));
  ok('said = 这一轮已吐出的那句话', st4b.done && st4b.done.said === '好的', JSON.stringify(st4b.done && st4b.done.said));
  ok('台账 result 也带上这句（不因取消清空）', lastEnd().result === '好的', JSON.stringify(lastEnd()));

  /* [5] 改了文件之后才取消 → done.files 带取消前动过的文件（不是永远「没有输出」） */
  head('[5] 改了文件才取消：done.files 带取消前动过的文件，不写「没有输出」');
  const ts3 = mkTranscript('cancel-c.jsonl');
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cancel-c', cwd: WS, prompt: '改个文件', transcript_path: ts3 });
  // 调一次写类工具，把文件落进本轮 roundFiles（PostToolUse 那一路）
  await runHook({ hook_event_name: 'PreToolUse', session_id: 'cancel-c', cwd: WS, tool_name: 'Write', tool_input: { file_path: 'src/foo.js' }, transcript_path: ts3 });
  await runHook({ hook_event_name: 'PostToolUse', session_id: 'cancel-c', cwd: WS, tool_name: 'Write', tool_input: { file_path: 'src/foo.js' }, transcript_path: ts3 });
  await runHook({ hook_event_name: 'Interrupt', session_id: 'cancel-c', cwd: WS, transcript_path: ts3 });
  const st5 = stateOf('cancel-c');
  ok('仍是取消标记（cancelled 为真）', st5.done && st5.done.cancelled === true, JSON.stringify(st5.done));
  ok('done.files 含取消前改过的文件', st5.done && Array.isArray(st5.done.files) && st5.done.files.some((f) => String(f.path || f) === 'src/foo.js'), JSON.stringify(st5.done && st5.done.files));
  ok('done.fileCount >= 1（不是「没有输出」）', st5.done && st5.done.fileCount >= 1, JSON.stringify(st5.done && st5.done.fileCount));

  server.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
