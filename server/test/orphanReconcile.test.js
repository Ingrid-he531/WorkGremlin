'use strict';

/**
 * Orphan task reconciliation self-test.
 *
 * A top-level running task is live only while its session id is in the active session registry.
 * Project, floor and client do not participate. The sweep uses bus.endTask so it also closes the
 * ledger row, clears blocked state and refreshes the member card through the normal task lifecycle.
 *
 * Run: `npm run test:orphan-reconcile`
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-orphan-reconcile-'));
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));
const bus = createIngestBus({ repo, hub: { broadcast() {} }, projectName: 'p1', project: 'p1' });

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

bus.registerMember({ project: 'p1', memberId: 'codex', name: 'codex', role: 'agent', client: 'codex' });
bus.registerMember({ project: 'p2', memberId: 'claude', name: 'claude', role: 'agent', client: 'claude' });

const NOW = Date.now();
const OLD = NOW - 120_000;

function seedTask({ id, projectId = 'p1', memberId = 'codex@p1', state = 'running', startedAt = OLD, parentTaskId = null, sessionId }) {
  repo.insertTask.run({
    id,
    projectId,
    memberId,
    parentTaskId,
    title: id,
    state,
    progress: 0,
    startedAt,
    endedAt: null,
  });
  if (sessionId !== undefined) {
    repo.upsertTaskRun.run({
      id,
      projectId,
      memberId,
      client: memberId.startsWith('claude') ? 'claude' : 'codex',
      sessionId,
      form: null,
      model: null,
      title: id,
      startedAt,
      baselineCommit: null,
    });
  }
}

seedTask({ id: 't-active', sessionId: 'shared-active' });
seedTask({ id: 't-active-other-project', projectId: 'p2', memberId: 'claude@p2', sessionId: 'shared-active' });
seedTask({ id: 't-gone', sessionId: 'gone-session' });
seedTask({ id: 't-no-run' });
seedTask({ id: 't-grace', sessionId: 'gone-session', startedAt: NOW - 10_000 });
seedTask({ id: 't-child', sessionId: 'gone-session', parentTaskId: 't-parent' });

console.log('[1] 缺少活跃会话集合时不做破坏性处理');
{
  const result = bus.reconcileRunningTasksWithActiveSessions({ now: NOW });
  ok('返回 missing_active_sessions', result.ok === false && result.error === 'missing_active_sessions', JSON.stringify(result));
  ok('running 任务保持原状', repo.getTask.get('t-gone').state === 'running');
}

console.log('[2] 按 sessionId 回收孤儿任务，project 不参与判定');
{
  const result = bus.reconcileRunningTasksWithActiveSessions({
    activeSessionIds: new Set(['shared-active']),
    now: NOW,
    graceMs: 30_000,
  });
  ok('恰好取消两个孤儿任务', result.ok === true && result.ended === 2, JSON.stringify(result));
  ok('活跃 session 的任务保留（p1）', repo.getTask.get('t-active').state === 'running');
  ok('相同 sessionId 在不同 project 中也保留', repo.getTask.get('t-active-other-project').state === 'running');
  ok('无活跃 session 的任务变为 cancelled', repo.getTask.get('t-gone').state === 'cancelled');
  ok('无 task_runs 行的任务也变为 cancelled', repo.getTask.get('t-no-run').state === 'cancelled');
  ok('宽限期内的新任务暂不取消', repo.getTask.get('t-grace').state === 'running');
  ok('子任务不由全局对账处理', repo.getTask.get('t-child').state === 'running');
  ok(
    '孤儿取消写入内部原因',
    repo.getTask.get('t-gone').cancel_reason === 'orphan_session' &&
      repo.getTask.get('t-no-run').cancel_reason === 'orphan_session'
  );
  ok(
    '取消时间统一取本轮扫描时间',
    repo.getTask.get('t-gone').ended_at === NOW && repo.getTask.get('t-no-run').ended_at === NOW
  );
  const insertedRun = repo.getTaskRun.get('t-no-run');
  ok('缺少 ledger 行时 endTask 正常补写并收尾', Boolean(insertedRun) && insertedRun.ended_at === NOW);
}

console.log('[3] 对账幂等');
{
  const result = bus.reconcileRunningTasksWithActiveSessions({
    activeSessionIds: new Set(['shared-active']),
    now: NOW,
    graceMs: 30_000,
  });
  ok('第二次没有可取消任务', result.ended === 0, JSON.stringify(result));
}

close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
