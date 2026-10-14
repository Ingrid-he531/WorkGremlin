'use strict';
/**
 * Server-side generic hook runner integration test (the full Claude event chain).
 *
 * Covers: SessionStart / UserPromptSubmit / PreToolUse(Agent summons a ghost) /
 * PostToolUse(ghost retires) / Stop(output + finish) / Interrupt(cancelled finish), and checks the
 * server bus calls (ghosts go through ghostSpawn/ghostRetire/ghostSweep).
 * Run: `npm run test:hook-runtime`
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-hook-rt-'));
// 隔离状态文件：不设 WORKGREMLIN_HOME 的话，hookCommon 会把相位/会话状态写进**真实的**
// ~/.workgremlin/hooks/ —— 每跑一次测试就在真机上多一条幽灵会话。
process.env.WORKGREMLIN_HOME = path.join(TMP, 'wg');
fs.mkdirSync(process.env.WORKGREMLIN_HOME, { recursive: true });
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
  projectForReport: () => 'P',
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
  currentMainTaskId: () => 't_main',
  ghostSpawn: (b) => { calls.push(['ghostSpawn', b]); return { memberId: `subagent-${b.name}@P`, runId: 1 }; },
  ghostRetire: (b) => { calls.push(['ghostRetire', b]); return true; },
  ghostSweep: (b) => { calls.push(['ghostSweep', b]); return 0; },
};

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

  // PreToolUse: the Agent tool summons a subagent → record a ghost (busy) + toolUse
  calls.length = 0;
  await d.dispatch(ev('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', description: '搜代码' }, tool_use_id: 'call_1' }), ctx);
  ok('PreToolUse Agent → toolUse', calls.some((c) => c[0] === 'toolUse' && c[1].tool === 'Agent'));
  ok('PreToolUse Agent → ghostSpawn(Explore)', calls.some((c) => c[0] === 'ghostSpawn' && c[1].name === 'Explore'), JSON.stringify(calls.map((x) => x[0])));

  // PostToolUse: the Agent tool finishes → retire the ghost
  calls.length = 0;
  await d.dispatch(ev('PostToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', description: '搜代码' }, tool_use_id: 'call_1', tool_response: '找到了三处用法' }), ctx);
  ok('PostToolUse Agent → ghostRetire(result)', calls.some((c) => c[0] === 'ghostRetire' && /找到了三处用法/.test(c[1].result || '')), JSON.stringify(calls.map((x) => x[0])));

  // Stop → 服务端读 transcript 取产出 + 收尾 done
  calls.length = 0;
  await d.dispatch(ev('Stop'), ctx);
  const end = calls.find((c) => c[0] === 'endTask');
  ok('Stop → endTask', !!end);
  ok('Stop → 服务端读产出(result)', end && /已写好 add/.test(end[1].result || ''), end && end[1].result);
  ok('Stop → 状态 done', end && end[1].state === 'done');
  ok('Stop → 收尾 idle', calls.some((c) => c[0] === 'setStatus' && c[1].state === 'idle'));

  // Summoned but not finished (orphan) → swept along with the next UserPromptSubmit
  calls.length = 0;
  await d.dispatch(ev('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'Plan', description: '做计划' }, tool_use_id: 'call_2' }), ctx);
  ok('孤儿幽灵也落了库', calls.some((c) => c[0] === 'ghostSpawn' && c[1].name === 'Plan'));
  calls.length = 0;
  await d.dispatch(ev('UserPromptSubmit', { prompt: '再写个测试' }), ctx);
  ok('新轮 UserPromptSubmit → 扫场 ghostSweep', calls.some((c) => c[0] === 'ghostSweep' && c[1].sessionId === 's1'), JSON.stringify(calls.map((x) => x[0])));

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
