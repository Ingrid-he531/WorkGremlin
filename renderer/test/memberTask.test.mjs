/**
 * 工位卡 / 办公室小怪物「当前任务」口径自检。
 *
 * 背景（2026-09-30 用户实测）：主代理已经空闲，卡片上却还挂着上一个任务的标题、已耗时还在走。
 * 根因是 `agent_status.task_id` 不随收工清空 —— 空闲之后槽位仍指着**上一条已完成**的任务，
 * 渲染层照着显示就把它当成了当前任务。这一层只做一件事：把「当前任务」的判据固定下来
 * （未收工 + 成员在干活），空闲时留给调用方显示「空闲 / 最近活跃」。
 *
 * 跑法：`npm run test:member-task`（node 直接跑；renderer 的 .js 由 node 的语法检测当 ESM）
 */
const { currentTaskOf, currentTaskTitle, currentTaskStartedAt, isWorking, statusLabel, statusTone } = await import(
  '../src/lib/memberTask.js'
);

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

const T = 1_700_000_000_000;

console.log('\n[1] 在干活 → 槽位里那条就是当前任务');
const running = { state: 'busy', task: { id: 't1', title: '正在跑的任务', startedAt: T, endedAt: null } };
ok('busy + 未收工 → 当前任务', currentTaskOf(running) === running.task);
ok('标题取任务的 title', currentTaskTitle(running) === '正在跑的任务', currentTaskTitle(running));
ok('已耗时从任务开工时刻算', currentTaskStartedAt(running) === T, String(currentTaskStartedAt(running)));
ok('thinking / blocked 同样算在干活', isWorking({ state: 'thinking' }) && isWorking({ state: 'blocked' }));

console.log('\n[2] 空闲 → 槽位里那条是**上一个任务**，不算当前任务（回归：空闲还挂着旧任务 + 已耗时在走）');
const idle = { state: 'idle', task: { id: 't0', title: '上一个任务', startedAt: T - 600_000, endedAt: T - 540_000 } };
ok('idle + 已收工 → 没有当前任务（卡片显示「空闲」）', currentTaskOf(idle) === null, JSON.stringify(currentTaskOf(idle)));
ok('标题回空串（调用方显示「空闲」）', currentTaskTitle(idle) === '', currentTaskTitle(idle));
ok('已收工的任务即使在 busy 相位也不算当前任务', currentTaskOf({ state: 'busy', task: idle.task }) === null);
ok('online（只注册没干活）也算空闲', currentTaskOf({ state: 'online', task: running.task }) === null);
ok('offline 同理', currentTaskOf({ state: 'offline', task: running.task }) === null);

console.log('\n[3] 兜底：没有任务 / 幽灵的字符串任务');
ok('没有 task → null', currentTaskOf({ state: 'busy', task: null }) === null);
ok('成员为空不炸', currentTaskOf(null) === null && currentTaskTitle(undefined) === '');
ok('幽灵的字符串任务（在跑）照样认', currentTaskTitle({ state: 'busy', task: '审查这段 diff' }) === '审查这段 diff');
ok('幽灵的字符串任务 + 空闲 → 不认', currentTaskOf({ state: 'idle', task: '审查这段 diff' }) === null);

console.log('\n[4] 卡片右上角的状态牌只有两档：忙碌 / 空闲（用户 2026-09-30 要求）');
ok('busy / thinking / blocked → 忙碌', ['busy', 'thinking', 'blocked'].every((s) => statusLabel(s) === '忙碌'));
ok('online / idle / offline → 空闲', ['online', 'idle', 'offline'].every((s) => statusLabel(s) === '空闲'));
ok('未知状态按空闲处理（不把原始 state 直接怼给用户）', statusLabel('weird') === '空闲', statusLabel('weird'));
ok('色调与文案同源（忙碌=busy 点，其余=idle 点）', statusTone('thinking') === 'busy' && statusTone('online') === 'idle' && statusTone('offline') === 'idle');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
