/**
 * 回归测试：CodeBuddy 家族的 **`FinalStop`** 事件 —— 一轮的终态，payload 带
 * `final_stop_reason ∈ completed | cancelled | failed | interrupted`。
 *
 * 为什么需要它：1F CodeBuddy 的 IDE（扩展形态）按"停止"时**不发 Stop、不发 Interrupt**，
 * 以前靠服务端猜（taskId 卡死 + transcript 末轮 state='running' ⇒ 判被打断）—— 那条兜底
 * 分不清"还在慢慢想"和"被打断"，把"模型纯推理 >2 分钟、中间没有工具事件"的长轮误报成
 * 「任务取消」，用户实测后删掉了。`FinalStop.final_stop_reason` 是 CodeBuddy **主动报**的信号，
 * 用它才算真值（见 packages/reporter/src/hook.js 的 finishCancelled / FinalStop 分支）。
 *
 * 盯三件事：
 *   [1] FinalStop(cancelled) → task/end(state=cancelled) + done.cancelled + 相位落 idle；
 *   [2] FinalStop(completed) → **不**在这里收工（交给 Stop 那条正常路），不许误报取消；
 *   [3] 没开轮（没有 taskId）时 FinalStop(cancelled) 也不炸（只落标记，不发 task/end）。
 *
 * 跑法：`npm run test:final-stop`（零依赖：假服务端 + hook.js 子进程）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-final-stop-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const WS = path.join(TMP, 'ws');
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

let taskSeq = 0;
const starts = [];
const ends = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/api/v1/task/start') starts.push(JSON.parse(body || '{}'));
    if (req.url === '/api/v1/task/end') ends.push(JSON.parse(body || '{}'));
    const out =
      req.url === '/api/v1/task/start'
        ? { ok: true, taskId: `t_fs_${++taskSeq}` }
        : { ok: true, project: 'WorkGremlin', workspacePath: WS, taskId: null, title: '' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});

function runHook(agent, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, '--agent', agent], { cwd: WS, stdio: ['pipe', 'ignore', 'ignore'] });
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
  const name = ents.find((n) => n.includes(`_${sid}.json`) || n.endsWith(`@${sid}.json`));
  if (!name) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch {
    return null;
  }
}
const lastEnd = () => ends[ends.length - 1] || {};

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(WG, 'server.json'), JSON.stringify({ port: server.address().port, token: 'x' }));

  const sid = 'codebuddy-fs-1';
  head('[1] FinalStop(reason=cancelled) → 按取消收尾（task/end cancelled + done.cancelled + 相位 idle）');
  await runHook('codebuddy', { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: WS, prompt: '改点东西' });
  const taskId = String((stateOf(sid) || {}).taskId || '');
  ok('开轮：状态文件里有任务', Boolean(taskId), JSON.stringify(stateOf(sid)));
  await runHook('codebuddy', { hook_event_name: 'FinalStop', session_id: sid, cwd: WS, final_stop_reason: 'cancelled' });
  const st1 = stateOf(sid);
  ok('task/end 报的是 cancelled', lastEnd().state === 'cancelled', JSON.stringify(lastEnd()));
  ok('结束的是这一轮的任务', lastEnd().taskId === taskId, JSON.stringify(lastEnd()));
  ok('落了取消标记（done.cancelled 为真）', Boolean(st1 && st1.done && st1.done.cancelled === true), st1 && JSON.stringify(st1.done));
  ok('任务槽清空', Boolean(st1 && !st1.taskId), st1 && JSON.stringify(st1.taskId));
  ok('相位落成显式 idle（红色不会被 stale 相位顶回去）', Boolean(st1 && st1.sessionPhase && st1.sessionPhase.phase === 'idle'), st1 && JSON.stringify(st1.sessionPhase));

  head('[2] FinalStop(reason=completed) → 不在这里收工（交给 Stop），不许误报取消');
  const sid2 = 'codebuddy-fs-2';
  await runHook('codebuddy', { hook_event_name: 'UserPromptSubmit', session_id: sid2, cwd: WS, prompt: '再改点' });
  const taskId2 = String((stateOf(sid2) || {}).taskId || '');
  await runHook('codebuddy', { hook_event_name: 'FinalStop', session_id: sid2, cwd: WS, final_stop_reason: 'completed' });
  const st2 = stateOf(sid2);
  ok('没有发出 task/end', !ends.some((e) => e.taskId === taskId2), JSON.stringify(ends.map((e) => [e.taskId, e.state])));
  ok('状态文件里没有取消标记', Boolean(st2 && !(st2.done && st2.done.cancelled)), st2 && JSON.stringify(st2.done));
  ok('任务槽还占着（等 Stop 正常收工）', Boolean(st2 && st2.taskId === taskId2), st2 && JSON.stringify(st2.taskId));

  head('[3] 没开轮（没有 taskId）时 FinalStop(cancelled) 也不炸：只落标记，不发 task/end');
  const sid3 = 'codebuddy-fs-3';
  const before = ends.length;
  await runHook('codebuddy', { hook_event_name: 'FinalStop', session_id: sid3, cwd: WS, final_stop_reason: 'interrupted' });
  ok('没有新增 task/end', ends.length === before, `${before} → ${ends.length}`);
  const st3 = stateOf(sid3);
  ok('仍落了取消标记（下一轮开始会被清掉）', Boolean(st3 && st3.done && st3.done.cancelled === true), st3 && JSON.stringify(st3.done));

  head('[4] SessionEnd 标记会话结束；重新 SessionStart 清除标记');
  const sid4 = 'codebuddy-session-reopen';
  await runHook('codebuddy', { hook_event_name: 'SessionStart', session_id: sid4, cwd: WS });
  const beforeEnd = stateOf(sid4);
  ok('SessionStart 后会话未标记结束', Boolean(beforeEnd && !beforeEnd.sessionEndedAt), beforeEnd && String(beforeEnd.sessionEndedAt));
  ok('SessionStart 即记录工程路径（无需等首条用户输入）', Boolean(beforeEnd && beforeEnd.sessionWorkspacePath === WS), beforeEnd && beforeEnd.sessionWorkspacePath);
  await runHook('codebuddy', { hook_event_name: 'SessionEnd', session_id: sid4, cwd: WS });
  const ended = stateOf(sid4);
  ok('SessionEnd 落下结束时间', Boolean(ended && Number(ended.sessionEndedAt) > 0), ended && String(ended.sessionEndedAt));
  await runHook('codebuddy', { hook_event_name: 'SessionStart', session_id: sid4, cwd: WS });
  const reopened = stateOf(sid4);
  ok('重新 SessionStart 清除结束时间', Boolean(reopened && !reopened.sessionEndedAt), reopened && String(reopened.sessionEndedAt));

  server.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
