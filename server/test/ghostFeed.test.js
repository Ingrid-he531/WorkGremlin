'use strict';
/**
 * Ghost (subagent summon) self-test.
 *
 * The hook is a pure forwarder now, so summon / retire / sweep write straight into the DB from the
 * server — an ephemeral member + its own task + a subagent_run, tied to the session and the parent
 * task. There is no manifest file and no feed poller anymore. gcGhosts() (driven by the unified
 * poller) disperses any ghost whose parent task ended or that outlived the orphan TTL.
 *
 * Run: `npm run test:ghost-feed`
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ghost-'));
process.env.WORKGREMLIN_HOME = path.join(TMP, 'wg');

const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');

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

const { repo, close } = openDatabase(path.join(TMP, 'test.db'));
repo.upsertProject.run({ id: 'p1', name: 'p1', workspacePath: '/tmp/p1', mainConversationId: null, source: 'report', createdAt: 1 });
const bus = createIngestBus({ repo, hub: { broadcast() {} }, projectName: 'p1', project: 'p1' });
bus.registerMember({ project: 'p1', memberId: 'codebuddy', name: 'codebuddy', role: 'agent', client: 'codebuddy' });
const main = bus.startTask({ project: 'p1', memberId: 'codebuddy', title: '主任务', client: 'codebuddy' }).taskId;

const runs = () => repo.raw.prepare('SELECT COUNT(*) AS c FROM subagent_runs').get().c;
const member = (name) => repo.getMember.get(`${name}@p1`);

console.log('\n[1] 召唤 → 临时成员 + 一条 run（挂在会话与父任务上）');
bus.ghostSpawn({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'Explore', task: '查代码', id: 'g1', parentTaskId: main });
ok('幽灵成员是 ephemeral', member('subagent-Explore') && member('subagent-Explore').ephemeral === 1);
ok('开了一条 subagent_run', runs() === 1, String(runs()));
const run1 = repo.raw.prepare('SELECT * FROM subagent_runs ORDER BY id').get();
ok('run 挂在父任务上、记了名字', run1.parent_task_id === main && run1.name === 'Explore');
ok('幽灵自己那一轮任务也开了（办公室显示当前任务 + 收工汇报都靠它）', !!run1.task_id);

console.log('\n[2] 同一只重复召唤不重复记账；同名并发各记一条');
bus.ghostSpawn({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'Explore', task: '查代码', id: 'g1', parentTaskId: main });
ok('同一 per-call id 再召唤 → 还是 1 条', runs() === 1, String(runs()));
bus.ghostSpawn({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'Explore', task: '查别的', id: 'g2', parentTaskId: main });
ok('同名并发（不同 id）→ 2 条', runs() === 2, String(runs()));

console.log('\n[3] 收工 → run 收尾 + 汇报产出 + 幽灵散');
bus.ghostRetire({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'Explore', id: 'g1', result: '查完了' });
const r1 = repo.raw.prepare('SELECT * FROM subagent_runs WHERE task_id = ?').get(run1.task_id);
ok('这条 run 有结束时间与产出', !!r1.ended_at && r1.result === '查完了');
ok('同名还有一只在跑 → 成员先留着', !!member('subagent-Explore'));
bus.ghostRetire({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'Explore', id: 'g2', result: '也完了' });
ok('最后一只收工 → 成员摘掉', !member('subagent-Explore'));
ok('汇报作为 kind=text 产出挂上了', repo.raw.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE path = 'workgremlin:summary'").get().c >= 1);

console.log('\n[4] 扫场按会话隔离');
bus.ghostSpawn({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'A', id: 'a1', parentTaskId: main });
bus.ghostSpawn({ project: 'p1', client: 'codebuddy', sessionId: 's2', name: 'B', id: 'b1', parentTaskId: main });
ok('扫 s1 只散掉 1 只', bus.ghostSweep({ project: 'p1', client: 'codebuddy', sessionId: 's1' }) === 1);
ok('s1 的没了', !member('subagent-A'));
ok('s2 的还在', !!member('subagent-B'));
bus.ghostSweep({ project: 'p1', client: 'codebuddy', sessionId: 's2' });

console.log('\n[5] gcGhosts：父任务收工 → 幽灵跟着散（不再依赖 hook 事件）');
bus.ghostSpawn({ project: 'p1', client: 'codebuddy', sessionId: 's3', name: 'C', id: 'c1', parentTaskId: main });
ok('父任务还在跑时不散', bus.gcGhosts() === 0 && !!member('subagent-C'));
bus.endTask({ project: 'p1', memberId: 'codebuddy', taskId: main, state: 'cancelled' });
ok('父任务取消 → 散场', bus.gcGhosts() >= 1 && !member('subagent-C'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
