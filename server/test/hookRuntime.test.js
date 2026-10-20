'use strict';
/**
 * Server-side generic hook runner integration test (the full Claude event chain).
 *
 * Covers: SessionStart / UserPromptSubmit / PreToolUse(Agent summons a ghost) /
 * PostToolUse(ghost retires or binds an async child) / Claude subagent attribution /
 * SubagentStop(identity match) / Stop(output + finish) / Interrupt(cancelled finish), and checks the
 * server bus calls (ghosts go through ghostSpawn/ghostBindIdentity/ghostRetire/ghostSweep).
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
  setBlocked: (b) => { calls.push(['setBlocked', b]); return { ok: true }; },
  clearBlocked: (b) => { calls.push(['clearBlocked', b]); return { ok: true }; },
  startTask: (b) => { calls.push(['startTask', b]); return { taskId: 't_gen' }; },
  endTask: (b) => { calls.push(['endTask', b]); return { ok: true }; },
  toolUse: (b) => { calls.push(['toolUse', b]); return { ok: true }; },
  fileTouch: (b) => { calls.push(['fileTouch', b]); return { ok: true }; },
  taskProgress: (b) => { calls.push(['taskProgress', b]); return { ok: true }; },
  recordMessage: (b) => { calls.push(['recordMessage', b]); return { ok: true }; },
  backfillTaskTokens: (b) => { calls.push(['backfillTaskTokens', b]); return { ok: true }; },
  currentTaskFor: () => null,
  currentMainTaskId: () => 't_main',
  ghostSpawn: (b) => { calls.push(['ghostSpawn', b]); return { memberId: `subagent-${b.name}@P`, runId: 1 }; },
  ghostBindIdentity: (b) => { calls.push(['ghostBindIdentity', b]); return true; },
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
  ok('SessionStart → clearBlocked', calls.some((c) => c[0] === 'clearBlocked'));

  // UserPromptSubmit → 起任务
  calls.length = 0;
  await d.dispatch(ev('UserPromptSubmit', { prompt: '写个函数' }), ctx);
  const start = calls.find((c) => c[0] === 'startTask');
  ok('UserPromptSubmit → startTask', !!start, JSON.stringify(calls.map((c) => c[0])));
  ok('UserPromptSubmit → 标题取原话', start && start[1].title === '写个函数');
  ok('UserPromptSubmit 不写 blocked 状态行', !calls.some((c) => c[0] === 'setBlocked'));

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
  ok('Stop → clearBlocked', calls.some((c) => c[0] === 'clearBlocked'));

  // Summoned but not finished (orphan) → swept along with the next UserPromptSubmit
  calls.length = 0;
  await d.dispatch(ev('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'Plan', description: '做计划' }, tool_use_id: 'call_2' }), ctx);
  ok('孤儿幽灵也落了库', calls.some((c) => c[0] === 'ghostSpawn' && c[1].name === 'Plan'));
  calls.length = 0;
  await d.dispatch(ev('UserPromptSubmit', { prompt: '再写个测试' }), ctx);
  ok('新轮 UserPromptSubmit → 扫场 ghostSweep', calls.some((c) => c[0] === 'ghostSweep' && c[1].sessionId === 's1'), JSON.stringify(calls.map((x) => x[0])));

  /* Claude emits subagent tool events with the parent's session_id plus the child's agent_id. */
  const ev2 = (name, extra = {}) => ({ ...ev(name, extra), session_id: 's2' });
  await d.dispatch(ev2('UserPromptSubmit', { prompt: '异步召唤子代理' }), ctx);
  calls.length = 0;
  await d.dispatch(
    ev2('PreToolUse', {
      tool_name: 'Agent',
      tool_use_id: 'call_async',
      tool_input: { subagent_type: 'Explore', description: '后台查代码' },
    }),
    ctx
  );
  ok('异步召唤先按 tool_use_id 开幽灵', calls.some((c) => c[0] === 'ghostSpawn' && c[1].id === 'call_async'));

  calls.length = 0;
  await d.dispatch(
    ev2('PostToolUse', {
      tool_name: 'Agent',
      tool_use_id: 'call_async',
      tool_input: { subagent_type: 'Explore', description: '后台查代码' },
      tool_response: { isAsync: true, status: 'async_launched', agentId: 'child-async' },
    }),
    ctx
  );
  ok(
    '异步回执绑定 agentId 但不收工',
    calls.some((c) => c[0] === 'ghostBindIdentity' && c[1].id === 'call_async' && c[1].agentId === 'child-async' && c[1].background === true) &&
      !calls.some((c) => c[0] === 'ghostRetire'),
    JSON.stringify(calls)
  );

  const beforeSubagentTool = JSON.stringify(d.sessionGet('s2') || {});
  calls.length = 0;
  await d.dispatch(
    ev2('PreToolUse', {
      agent_id: 'child-async',
      transcript_path: path.join(TMP, 'child.jsonl'),
      tool_name: 'Bash',
      tool_use_id: 'child-call',
      tool_input: { command: 'rg hookCommon' },
    }),
    ctx
  );
  const afterSubagentTool = JSON.stringify(d.sessionGet('s2') || {});
  ok('子代理工具事件不发业务心跳', !calls.some((c) => c[0] === 'heartbeat'));
  ok(
    '子代理工具事件不刷新父任务相位或工具归因',
    beforeSubagentTool === afterSubagentTool && !calls.some((c) => c[0] === 'toolUse' || c[0] === 'fileTouch' || c[0] === 'setBlocked'),
    `${beforeSubagentTool} -> ${afterSubagentTool}`
  );

  calls.length = 0;
  await d.dispatch(ev2('SubagentStop', { last_assistant_message: '缺少身份' }), ctx);
  ok('无身份 SubagentStop 不收工', !calls.some((c) => c[0] === 'ghostRetire'), JSON.stringify(calls));
  calls.length = 0;
  await d.dispatch(ev2('SubagentStop', { agent_id: 'child-unknown', last_assistant_message: '身份不匹配' }), ctx);
  ok(
    '未知身份 SubagentStop 只把精确 agentId 交给 bus 判定',
    calls.some((c) => c[0] === 'ghostRetire' && c[1].agentId === 'child-unknown' && !c[1].id),
    JSON.stringify(calls)
  );

  calls.length = 0;
  await d.dispatch(ev2('Stop', { last_assistant_message: '父任务正常完成' }), ctx);
  ok(
    '父任务正常完成保留后台子代理台账',
    calls.some((c) => c[0] === 'ghostSweep' && c[1].all === false) &&
      (d.sessionGet('s2').subagents || []).some((r) => r.id === 'call_async' && r.agentId === 'child-async'),
    JSON.stringify(d.sessionGet('s2'))
  );

  calls.length = 0;
  await d.dispatch(ev2('SubagentStop', { agent_id: 'child-async', last_assistant_message: '子代理完成' }), ctx);
  ok(
    '已知身份 SubagentStop 在父任务结束后仍精确收工',
    calls.some((c) => c[0] === 'ghostRetire' && c[1].id === 'call_async' && c[1].agentId === 'child-async') &&
      (d.sessionGet('s2').subagents || []).length === 0,
    JSON.stringify(calls)
  );

  calls.length = 0;
  await d.dispatch(ev2('SubagentStop', { agent_id: 'child-async', last_assistant_message: '子代理再次完成' }), ctx);
  ok(
    '台账移除后，同一 agentId 的再次停止仍转发给 bus 复活判定',
    calls.some((c) => c[0] === 'ghostRetire' && c[1].agentId === 'child-async' && !c[1].id),
    JSON.stringify(calls)
  );

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
