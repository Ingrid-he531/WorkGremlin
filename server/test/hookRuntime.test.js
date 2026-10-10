'use strict';
/**
 * 服务端 hook 通用运行器（Claude 全事件链路）集成测试。
 *
 * 覆盖：SessionStart / UserPromptSubmit / PreToolUse(Agent 召唤幽灵) / PostToolUse(幽灵收工) /
 * Stop(产出+收尾) / Interrupt(取消收尾)，并验证幽灵 feed 文件与服务端 bus 调用。
 *
 * 跑法：`npm run test:hook-runtime`
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-hook-rt-'));
const TP = path.join(TMP, 'sess.jsonl');
fs.writeFileSync(
  TP,
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '写个函数' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已写好 add。' }] } }),
  ].join('\n'),
  'utf8'
);

const { createHookDispatch } = require('../src/ingest/hookDispatch');
const { feedFilePath } = require('../src/ingest/subagentFeed');

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

const calls = [];
const bus = {
  registerMember: (b) => { calls.push(['registerMember', b]); return b.memberId; },
  setStatus: (b) => { calls.push(['setStatus', b]); return { ok: true }; },
  startTask: (b) => { calls.push(['startTask', b]); return { taskId: 't_gen' }; },
  endTask: (b) => { calls.push(['endTask', b]); return { ok: true }; },
  toolUse: (b) => { calls.push(['toolUse', b]); return { ok: true }; },
  fileTouch: (b) => { calls.push(['fileTouch', b]); return { ok: true }; },
  taskProgress: (b) => { calls.push(['taskProgress', b]); return { ok: true }; },
  heartbeat: (b) => { calls.push(['heartbeat', b]); return { ok: true }; },
  recordMessage: (b) => { calls.push(['recordMessage', b]); return { ok: true }; },
  backfillTaskTokens: (b) => { calls.push(['backfillTaskTokens', b]); return { ok: true }; },
  currentTaskFor: () => null,
};

function feedAgents() {
  const f = feedFilePath(TMP);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).agents || []; } catch { return []; }
}

(async () => {
  console.log('服务端 hook 通用运行器（Claude 全链路）');
  const ctx = { project: 'P', workspacePath: TMP, bus, repo: {} };
  const d = createHookDispatch();
  const ev = (name, extra = {}) => ({ hook_event_name: name, session_id: 's1', client: 'claude', agent: 'claude', cwd: TMP, transcript_path: TP, ...extra });

  // SessionStart
  calls.length = 0;
  await d.dispatch(ev('SessionStart'), ctx);
  ok('SessionStart → registerMember', calls.some((c) => c[0] === 'registerMember'));
  ok('SessionStart → idle', calls.some((c) => c[0] === 'setStatus' && c[1].state === 'idle'));

  // UserPromptSubmit → 起任务
  calls.length = 0;
  await d.dispatch(ev('UserPromptSubmit', { prompt: '写个函数' }), ctx);
  const start = calls.find((c) => c[0] === 'startTask');
  ok('UserPromptSubmit → startTask', !!start, JSON.stringify(calls.map((c) => c[0])));
  ok('UserPromptSubmit → 标题取原话', start && start[1].title === '写个函数');
  ok('UserPromptSubmit → thinking', calls.some((c) => c[0] === 'setStatus' && c[1].state === 'thinking'));

  // PreToolUse：Agent 工具召唤子代理 → 飘幽灵(busy) + toolUse
  calls.length = 0;
  await d.dispatch(ev('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', description: '搜代码' }, tool_use_id: 'call_1' }), ctx);
  ok('PreToolUse Agent → toolUse', calls.some((c) => c[0] === 'toolUse' && c[1].tool === 'Agent'));
  const ghostBusy = feedAgents().find((a) => a.id === 'call_1');
  ok('PreToolUse Agent → feed 飘幽灵(busy)', !!ghostBusy && ghostBusy.state === 'busy' && ghostBusy.name === 'Explore', JSON.stringify(feedAgents()));

  // PostToolUse：Agent 收工 → 幽灵变 idle 待汇报
  calls.length = 0;
  await d.dispatch(ev('PostToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', description: '搜代码' }, tool_use_id: 'call_1', tool_response: '找到了三处用法' }), ctx);
  const ghostDone = feedAgents().find((a) => a.id === 'call_1');
  ok('PostToolUse Agent → 幽灵收工(idle+result)', ghostDone && ghostDone.state === 'idle' && /找到了三处用法/.test(ghostDone.result || ''), JSON.stringify(feedAgents()));

  // Stop → 服务端读 transcript 取产出 + 收尾 done
  calls.length = 0;
  await d.dispatch(ev('Stop'), ctx);
  const end = calls.find((c) => c[0] === 'endTask');
  ok('Stop → endTask', !!end);
  ok('Stop → 服务端读产出(result)', end && /已写好 add/.test(end[1].result || ''), end && end[1].result);
  ok('Stop → 状态 done', end && end[1].state === 'done');
  ok('Stop → 收尾 idle', calls.some((c) => c[0] === 'setStatus' && c[1].state === 'idle'));

  // 已收工（带 result）的幽灵不会被 UserPromptSubmit 扫掉（它要留给 subagentFeed 播完汇报再回收）
  ok('已收工的幽灵在 feed 里保留待汇报', feedAgents().some((a) => a.id === 'call_1' && a.state === 'idle'), JSON.stringify(feedAgents()));

  // 召唤了一个但没收工（孤儿，无 result）→ 下一轮 UserPromptSubmit 应被扫掉
  await d.dispatch(ev('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'Plan', description: '做计划' }, tool_use_id: 'call_2' }), ctx);
  ok('孤儿幽灵已被加入(busy, 无 result)', feedAgents().some((a) => a.id === 'call_2' && a.state === 'busy'));
  calls.length = 0;
  await d.dispatch(ev('UserPromptSubmit', { prompt: '再写个测试' }), ctx);
  ok('新轮 UserPromptSubmit → 扫掉上一轮的孤儿幽灵', !feedAgents().some((a) => a.id === 'call_2'), JSON.stringify(feedAgents()));
  ok('已收工的幽灵不被误扫', feedAgents().some((a) => a.id === 'call_1'), JSON.stringify(feedAgents()));

  // Interrupt → 取消收尾
  calls.length = 0;
  await d.dispatch(ev('UserPromptSubmit', { prompt: '别写了' }), ctx);
  await d.dispatch(ev('Interrupt'), ctx);
  const endC = calls.find((c) => c[0] === 'endTask');
  ok('Interrupt → endTask(cancelled)', endC && endC[1].state === 'cancelled', JSON.stringify(calls.map((c) => c[0])));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
