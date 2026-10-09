'use strict';
/**
 * 回归测试：被顶掉上一轮的扫尾（endStaleTasksOfSession）不许收掉**当轮自己**。
 *
 * 病灶（2026-10-09 实测，1F CodeBuddy 插件会话）：sessionRegistry.flushSupersededTasks
 * 从 hook 状态文件读到 rounds（sessionId + taskStartedAt，原本没有 taskId）→ 调
 * bus.endStaleTasksOfSession({ ts: 当轮开工时刻 })，且**不传 excludeTaskId**。那边判界用
 * `old.startedAt > ts`，而新一轮 started_at 与扫描读到的 taskStartedAt 是同一个值
 * （同一份 hook 上报）——相等拦不住、excludeTaskId 又是空串 → **每条新任务开工瞬间就被
 * 写成 cancelled**：ticker 开场滚「已取消」、任务记录/成员卡跟着错，直到真收工才被重写
 * 回来。库里指纹：开工同秒 cancelled、file_count=NULL（13:00:09 那条）。
 *
 * 修法：判界改 `>= ts`（同刻开工的就是当轮自己）+ rounds 带上 taskId 供调用方显式排除。
 *
 * 跑法：`node server/test/supersededSweep.test.js`（零依赖，建临时库、用真实 repo / bus）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-superseded-sweep-'));
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));

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

const bus = createIngestBus({ repo, hub: { broadcast() {} }, projectName: 'p1', project: 'p1' });
bus.ensureProject('p1', '/tmp/p1', null, 'report');
bus.registerMember({ project: 'p1', memberId: 'codebuddy', name: 'codebuddy', role: 'agent', client: 'codebuddy' });

const SID = 'sess-sweep';
const T0 = Date.now() - 60_000; // 上一轮：一分钟前开工，至今没收尾（结束事件永远到不了的那种）

console.log('[1] 造一条"被顶掉的上一轮"：同会话、同形态、running');
repo.insertTask.run({
  id: 't-old', projectId: 'p1', memberId: 'codebuddy', parentTaskId: null,
  title: '被顶掉的上一轮', state: 'running', progress: 0, startedAt: T0, endedAt: null,
});
repo.upsertTaskRun.run({
  id: 't-old', projectId: 'p1', memberId: 'codebuddy', client: 'codebuddy', sessionId: SID,
  form: null, model: null, title: '被顶掉的上一轮', startedAt: T0, baselineCommit: null,
});
ok('上一轮已在台账挂 running', repo.getTask.get('t-old').state === 'running');

console.log('[2] 新一轮开工（startTask，ts 与状态文件里的 taskStartedAt 同值）');
const T1 = Date.now();
bus.startTask({
  project: 'p1', memberId: 'codebuddy', taskId: 't-new',
  title: '当轮', client: 'codebuddy', sessionId: SID, ts: T1,
});
ok('当轮已落库 running', repo.getTask.get('t-new').state === 'running', repo.getTask.get('t-new').state);
ok('startTask 自己那刀把上一轮收了（带 excludeTaskId，不伤当轮）', repo.getTask.get('t-old').state === 'cancelled', repo.getTask.get('t-old').state);

console.log('[3] 注册表扫尾的调用口径：ts = 当轮 taskStartedAt + excludeTaskId = 当轮 taskId');
{
  const n = bus.endStaleTasksOfSession({ project: 'p1', sessionId: SID, ts: T1, excludeTaskId: 't-new', client: 'codebuddy' });
  ok('没有旧轮可收（上一轮已被 startTask 收掉）', n === 0, String(n));
  ok('**当轮自己还活着（核心回归：开工同刻不许被收）**', repo.getTask.get('t-new').state === 'running', repo.getTask.get('t-new').state);
}

console.log('[4] 老调用口径（不传 excludeTaskId，判界只靠 startedAt >= ts）也不许误伤当轮');
{
  // 再造一条更早的 running，验证不传 excludeTaskId 时扫尾照常收旧、放过当轮
  repo.insertTask.run({
    id: 't-older', projectId: 'p1', memberId: 'codebuddy', parentTaskId: null,
    title: '更早的一轮', state: 'running', progress: 0, startedAt: T0 - 1000, endedAt: null,
  });
  repo.upsertTaskRun.run({
    id: 't-older', projectId: 'p1', memberId: 'codebuddy', client: 'codebuddy', sessionId: SID,
    form: null, model: null, title: '更早的一轮', startedAt: T0 - 1000, baselineCommit: null,
  });
  const n = bus.endStaleTasksOfSession({ project: 'p1', sessionId: SID, ts: T1, client: 'codebuddy' });
  ok('更早的一轮被收掉', n === 1 && repo.getTask.get('t-older').state === 'cancelled', `${n} / ${repo.getTask.get('t-older').state}`);
  ok('当轮仍然活着', repo.getTask.get('t-new').state === 'running', repo.getTask.get('t-new').state);
}

console.log('[5] 比当轮更新的任务（不同会话同_member的并行不算，这里按 ts 判界）不动');
{
  const n = bus.endStaleTasksOfSession({ project: 'p1', sessionId: SID, ts: T1 - 5000, client: 'codebuddy' });
  ok('ts 往前拨 5s：当轮（比 ts 新）不在收尾范围', n === 0, String(n));
  ok('当轮依旧活着', repo.getTask.get('t-new').state === 'running', repo.getTask.get('t-new').state);
}

close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
