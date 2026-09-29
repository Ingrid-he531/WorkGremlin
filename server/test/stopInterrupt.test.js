/**
 * 回归测试：**没有显式 `Interrupt` 事件**的楼层，用户按 ESC / 停止时也要亮红色「任务取消」。
 *
 * 背景：Interrupt 事件只有 Codex 发（而且交互式会话里还不一定发）。其余走 hook 的楼层
 * （Claude Code 4F / Qoder 6F）**不发 Interrupt**，只在 transcript 里留下痕迹：
 *   · Claude Code / Qoder：一条 user 消息 `[Request interrupted by user]`（工具中途打断带
 *     ` for tool use` 后缀）；
 *   · Codex：rollout 里一条 `event_msg` / `payload.type === 'turn_aborted'`（reason=interrupted）。
 * hook.js 的 Stop 分支会读这份 transcript（turnInterrupted），据此把这一轮按 **cancelled** 收尾、
 * 落一枚 `done.cancelled` —— 主控制台亮红色「任务取消」，而不是绿色「任务完成」。
 *
 * 盯三件事：
 *   [1] Claude：Stop 的 transcript 里有打断痕迹 → done.cancelled、task/end state=cancelled；
 *   [2] Codex：rollout 里的 turn_aborted → 同上；
 *   [3] 正常收工（transcript 里没有打断痕迹）→ 照常「任务完成」（不能一直红着）。
 *
 * 跑法：`npm run test:stop-interrupt`（零依赖：起一个假服务端 + 跑 hook.js 子进程）。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-stopint-'));
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
const ends = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/api/v1/task/end') ends.push(JSON.parse(body || '{}'));
    const out = req.url === '/api/v1/task/start'
      ? { ok: true, taskId: `t_${++taskSeq}`, project: 'WorkGremlin', workspacePath: WS }
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

/** Claude / Qoder 风格的 transcript：最后一条 user 消息是打断标记 */
function mkClaudeTranscript(sid, { interrupted, withReply = true }) {
  const p = path.join(TMP, `${sid}.jsonl`);
  const now = new Date().toISOString();
  const lines = [{ type: 'user', sessionId: sid, cwd: WS, timestamp: now, message: { role: 'user', content: '改点东西' } }];
  if (withReply) {
    lines.push({ type: 'assistant', sessionId: sid, cwd: WS, timestamp: now, entrypoint: 'cli', message: { role: 'assistant', content: [{ type: 'text', text: '好的，我来改' }] } });
  }
  if (interrupted) {
    lines.push({ type: 'user', sessionId: sid, cwd: WS, timestamp: now, message: { role: 'user', content: '[Request interrupted by user]' } });
  }
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

/** Codex 风格的 rollout：收尾痕迹是 event_msg / turn_aborted */
function mkCodexRollout(sid, { aborted }) {
  const p = path.join(TMP, `${sid}.jsonl`);
  const now = new Date().toISOString();
  const lines = [
    { timestamp: now, type: 'session_meta', payload: { id: sid, cwd: WS } },
    { timestamp: now, type: 'response_item', payload: { type: 'message', role: 'user', content: '改点东西' } },
  ];
  if (aborted) {
    lines.push({ timestamp: now, type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't', reason: 'interrupted' } });
  }
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

/**
 * 干扰 rollout：里面**出现过** `turn_aborted` / `Request interrupted by user` 这些词，
 * 但只出现在工具输出 / 思考 / 讨论里（不是真正的事件行）—— 不许据此判取消。
 * 实测 2026-09-29：跑一句 `rg 'turn_aborted'` 或讨论打断逻辑，输出被原样写进 rollout，
 * 全文匹配会把那一轮误判成"用户打断了"，控制台报红色「任务取消」、产出摘要还被清空。
 */
function mkCodexNoiseRollout(sid) {
  const p = path.join(TMP, `${sid}.jsonl`);
  const now = new Date().toISOString();
  const lines = [
    { timestamp: now, type: 'session_meta', payload: { id: sid, cwd: WS } },
    { timestamp: now, type: 'response_item', payload: { type: 'message', role: 'user', content: '改点东西' } },
    // 思考里提到这个词 —— 不算
    { timestamp: now, type: 'response_item', payload: { type: 'reasoning', summary: 'turn_aborted 是什么？' } },
    // 工具输出里 grep 到了这个词（跟上面 print 出来的那 63 处一模一样）—— 也不算
    {
      timestamp: now,
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c1', output: '743:{"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}' },
    },
    // 被讨论的打断逻辑字符串 —— 同样不算
    { timestamp: now, type: 'event_msg', payload: { type: 'agent_message', message: '读 [Request interrupted by user] 这一行' } },
    { timestamp: now, type: 'response_item', payload: { type: 'message', role: 'assistant', content: '改完了，收工' } },
  ];
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(WG, 'server.json'), JSON.stringify({ port: server.address().port, token: 'x' }));

  /* [1] Claude：ESC 之后 Stop，transcript 里有 [Request interrupted by user] → 任务取消 */
  head('[1] Claude Code：Stop 前 transcript 落了 [Request interrupted by user] → 任务取消');
  const claudeSid = 'claude-cancel-1';
  await runHook('claude', { hook_event_name: 'UserPromptSubmit', session_id: claudeSid, cwd: WS, prompt: '改办公室' });
  const cts = mkClaudeTranscript(claudeSid, { interrupted: true });
  await runHook('claude', { hook_event_name: 'Stop', session_id: claudeSid, cwd: WS, transcript_path: cts });
  const st1 = stateOf(claudeSid);
  ok('落了取消标记（done.cancelled 为真）', Boolean(st1 && st1.done && st1.done.cancelled === true), st1 && JSON.stringify(st1.done));
  ok('task/end 报的是 cancelled（不是 done）', lastEnd().state === 'cancelled', JSON.stringify(lastEnd()));
  // 取消只是"没干完"，不是"没产出"：这一轮吐出来的半句 + 改过的文件照常记（与「任务完成」同一条线）
  ok('取消时 task/end 照常带产出摘要（这一轮的那半句）', lastEnd().result === '好的，我来改', JSON.stringify(lastEnd()));
  ok('取消标记也带这句（said）', Boolean(st1 && st1.done && st1.done.said === '好的，我来改'), st1 && JSON.stringify(st1.done));
  // Stop 之后必须把实时相位清掉：留着旧相位的话服务端还会认它新鲜 2~5 分钟，
  // 控制台就一直停在「思考中」，红色「任务取消」刚亮就被盖回去（这一步是那个 bug 的根因）。
  ok(
    'Stop 后实时相位落回 idle（不再停在「思考中」）',
    Boolean(st1 && st1.sessionPhase && String(st1.sessionPhase.phase) === 'idle'),
    st1 && JSON.stringify(st1.sessionPhase)
  );

  /* [1b] 取消的这一轮什么都没吐、也没改文件 → 空，界面写「没有输出」 */
  head('[1b] 取消且这一轮没有任何输出 → 产出摘要留空（界面显示「没有输出」）');
  const emptySid = 'claude-cancel-empty';
  await runHook('claude', { hook_event_name: 'UserPromptSubmit', session_id: emptySid, cwd: WS, prompt: '想一想' });
  const ets = mkClaudeTranscript(emptySid, { interrupted: true, withReply: false });
  await runHook('claude', { hook_event_name: 'Stop', session_id: emptySid, cwd: WS, transcript_path: ets });
  const stE = stateOf(emptySid);
  ok('仍是取消', Boolean(stE && stE.done && stE.done.cancelled === true), stE && JSON.stringify(stE.done));
  ok('said 留空（没有输出可记）', Boolean(stE && stE.done && stE.done.said === ''), stE && JSON.stringify(stE.done && stE.done.said));
  ok('task/end 的 result 也是空（不编造）', !lastEnd().result, JSON.stringify(lastEnd()));

  /* [2] Codex：rollout 里 turn_aborted → 任务取消 */
  head('[2] Codex：rollout 里落了 turn_aborted → 任务取消');
  const codexSid = 'codex-cancel-1';
  await runHook('codex', { hook_event_name: 'UserPromptSubmit', session_id: codexSid, cwd: WS, prompt: '改办公室' });
  const rts = mkCodexRollout(codexSid, { aborted: true });
  await runHook('codex', { hook_event_name: 'Stop', session_id: codexSid, cwd: WS, transcript_path: rts });
  const st2 = stateOf(codexSid);
  ok('落了取消标记（done.cancelled 为真）', Boolean(st2 && st2.done && st2.done.cancelled === true), st2 && JSON.stringify(st2.done));
  ok('task/end 报的是 cancelled', lastEnd().state === 'cancelled', JSON.stringify(lastEnd()));

  /* [3] 正常收工：transcript 里没有打断痕迹 → 照常「任务完成」 */
  head('[3] 正常收工（没有打断痕迹）→ 照常落"完成"，不能一直红着');
  const okSid = 'claude-done-1';
  await runHook('claude', { hook_event_name: 'UserPromptSubmit', session_id: okSid, cwd: WS, prompt: '改办公室' });
  const ots = mkClaudeTranscript(okSid, { interrupted: false });
  await runHook('claude', { hook_event_name: 'Stop', session_id: okSid, cwd: WS, transcript_path: ots });
  const st3 = stateOf(okSid);
  ok('是"完成"（done 没有 cancelled）', Boolean(st3 && st3.done && !st3.done.cancelled), st3 && JSON.stringify(st3.done));
  ok('task/end 报的是 done', lastEnd().state === 'done', JSON.stringify(lastEnd()));

  /* [4] 反例：rollout 里**只**在工具输出 / 思考 / 讨论里出现过这些词 —— 不许误判成取消 */
  head('[4] 反例：打断关键词只出现在工具输出/思考里 → 仍是「任务完成」（不误判）');
  const noiseSid = 'codex-noise-1';
  await runHook('codex', { hook_event_name: 'UserPromptSubmit', session_id: noiseSid, cwd: WS, prompt: '改办公室' });
  const nts = mkCodexNoiseRollout(noiseSid);
  await runHook('codex', { hook_event_name: 'Stop', session_id: noiseSid, cwd: WS, transcript_path: nts });
  const st4 = stateOf(noiseSid);
  ok('没有被误判成取消', Boolean(st4 && st4.done && !st4.done.cancelled), st4 && JSON.stringify(st4.done));
  ok('task/end 仍报 done', lastEnd().state === 'done', JSON.stringify(lastEnd()));
  ok('产出摘要照常留着（没被当取消清空）', Boolean(st4 && st4.done && st4.done.said), st4 && JSON.stringify(st4.done && st4.done.said));

  /* [5] 空闲提醒不能把「任务完成 / 取消」标记抹掉（CodeBuddy CLI 每轮后会发 idle_prompt） */
  head('[5] Notification idle_prompt：不许抹掉 done（否则完成/取消标记 60s 后消失、控制台再无实时状态）');
  const idleSid = 'claude-idle-1';
  await runHook('claude', { hook_event_name: 'UserPromptSubmit', session_id: idleSid, cwd: WS, prompt: '改一下' });
  const its = mkClaudeTranscript(idleSid, { interrupted: false });
  await runHook('claude', { hook_event_name: 'Stop', session_id: idleSid, cwd: WS, transcript_path: its });
  const before = stateOf(idleSid);
  await runHook('claude', { hook_event_name: 'Notification', session_id: idleSid, cwd: WS, notification_type: 'idle_prompt' });
  const after = stateOf(idleSid);
  ok('idle_prompt 之前有完成标记', Boolean(before && before.done && before.done.at), before && JSON.stringify(before.done));
  ok('idle_prompt 之后完成标记还在（没被 clearAwait 抹掉）', Boolean(after && after.done && after.done.at === before.done.at), after && JSON.stringify(after.done));
  ok(
    'idle_prompt 把实时相位落回 idle（不停在旧相位）',
    Boolean(after && after.sessionPhase && String(after.sessionPhase.phase) === 'idle'),
    after && JSON.stringify(after.sessionPhase)
  );

  server.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
