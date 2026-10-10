'use strict';
/**
 * 服务端 hook 事件分发（2026-10-10 重构：CLI hook 退化成事件转发器，落盘解析全归服务端）。
 *
 * 盯三件事：
 *   [1] Stop 事件派给 floorClaude 后，服务端**自己读 transcript** 取最后一句话当产出（result），
 *       并 endTask(done) + setStatus(idle) —— 证明"解析在服务器、不在 hook"。
 *   [2] UserPromptSubmit 派给 floorClaude 后，startTask(title) + setStatus(thinking)，本轮 taskId 入会话状态。
 *   [3] 没有 handleHookEvent 的楼层（如 kilo，靠轮询）收到事件应被忽略，不清不掉任何东西。
 *
 * 跑法：`npm run test:hook-dispatch`（零依赖，假 bus + 合成 transcript）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-hook-dispatch-'));
const TP = path.join(TMP, 'sess.jsonl');
// 一条 user + 一条 assistant（最后一句即产出）
fs.writeFileSync(
  TP,
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我写个函数' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的，已写好 add 函数。' }] } }),
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

(async () => {
  console.log('服务端 hook 事件分发（落盘解析归服务端）');

  // 假 bus：只记调用
  const calls = [];
  const bus = {
    registerMember: (b) => { calls.push(['registerMember', b]); return b.memberId; },
    setStatus: (b) => { calls.push(['setStatus', b]); return { ok: true }; },
    startTask: (b) => { calls.push(['startTask', b]); return { taskId: 't_generated' }; },
    endTask: (b) => { calls.push(['endTask', b]); return { ok: true }; },
    heartbeat: (b) => { calls.push(['heartbeat', b]); return { ok: true }; },
    recordMessage: (b) => { calls.push(['recordMessage', b]); return { ok: true }; },
    currentTaskFor: () => null,
  };
  const ctx = { project: 'P', workspacePath: TMP, bus, repo: {} };
  const d = createHookDispatch();

  // [2] UserPromptSubmit → 起任务 + 思考中（先跑，给后面 Stop 建好会话状态）
  {
    calls.length = 0;
    const r = await d.dispatch(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', client: 'claude', prompt: '帮我写个函数', agent: 'claude' },
      ctx
    );
    const start = calls.find((c) => c[0] === 'startTask');
    const st = calls.find((c) => c[0] === 'setStatus');
    ok('[2] UserPromptSubmit 落到 startTask', !!start);
    ok('[2] 任务标题取用户原话', start && start[1].title === '帮我写个函数', start && start[1].title);
    ok('[2] 相位 thinking', st && st[1].state === 'thinking');
    ok('[2] 本轮 taskId 记入会话状态', d.sessionGet('s1') && d.sessionGet('s1').taskId === 't_generated');
    ok('[2] 返回 handled: UserPromptSubmit', r && r.handled === 'UserPromptSubmit');
  }

  // [1] Stop → 服务端读 transcript 取产出（会话里已有 taskId）
  {
    calls.length = 0;
    const r = await d.dispatch(
      { hook_event_name: 'Stop', session_id: 's1', client: 'claude', transcript_path: TP, agent: 'claude' },
      ctx
    );
    const end = calls.find((c) => c[0] === 'endTask');
    const st = calls.find((c) => c[0] === 'setStatus');
    ok('[1] Stop 落到 floorClaude.endTask', !!end, JSON.stringify(calls.map((c) => c[0])));
    ok('[1] 服务端读 transcript 把最后一句话当产出(result)', end && end[1].result === '好的，已写好 add 函数。', end && end[1].result);
    ok('[1] 状态收尾为 done', end && end[1].state === 'done');
    ok('[1] 收尾相位 idle', st && st[1].state === 'idle' && st[1].taskId === null);
    ok('[1] 返回 handled: Stop', r && r.handled === 'Stop');
  }

  // [3] 无 handleHookEvent 的楼层（kilo）被忽略
  {
    calls.length = 0;
    const r = await d.dispatch({ hook_event_name: 'Stop', session_id: 'sx', client: 'kilo', agent: 'kilo' }, ctx);
    ok('[3] kilo 事件被忽略', r && r.ignored === true);
    ok('[3] 没触发任何 bus 调用', calls.length === 0, JSON.stringify(calls.map((c) => c[0])));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
