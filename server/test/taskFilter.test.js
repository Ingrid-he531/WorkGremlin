/**
 * 任务记录的「楼层筛选」自检 —— 合并楼层（1F CodeBuddy = CLI + Plugin）要能一次筛两路。
 *
 * 跑法：`npm run test:task-filter`（= node 直接跑，零依赖）。
 * 为什么要有它：楼层与成员 client 现在是多对一（一个楼层对应 codebuddy 与 codebuddy-plugin
 * 两个 client），筛选与批量删除都改成了"逗号分隔的集合命中"（SQL instr）。这类改动读代码
 * 看不出来，只有当库里真有这两种 client 的行、又拿真实语句去查时才现形 —— 所以这里建临时库、
 * 用真实 repo 的语句跑，不 mock。
 *
 * 覆盖：
 *   [1] 单值筛选（老口径）：client=codebuddy 只取 CLI 那条，行为与改动前一致
 *   [2] 合并楼层：client=codebuddy,codebuddy-plugin 两条都取回来
 *   [3] 命中口径与报表分组一致：client 只在 task_runs 上、members 里为空的行也要命中
 *   [4] 批量删除同样认集合：按合并楼层删，两路一起删
 *   [5] 'all' / 空 = 不过滤（别误删）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/db');

let pass = 0;
let fail = 0;
const head = (t) => console.log(`\n${t}`);
function ok(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? `  — ${extra}` : ''}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-taskfilter-'));
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));

/* ------------------------------ 造数据 ------------------------------ */

repo.upsertProject.run({ id: 'p1', name: 'p1', workspacePath: '/tmp/p1', mainConversationId: null, source: 'report', createdAt: 1 });

function member(id, client) {
  repo.upsertMember.run({
    id,
    projectId: 'p1',
    name: String(id).split('@')[0],
    role: 'agent',
    sessionId: null,
    reported: 1,
    createdAt: 1,
    lastSeenAt: 1,
    ephemeral: 0,
    projectLabel: null,
    client,
  });
}
/** 一轮用户任务：tasks 一行 + task_runs 一行（client 也写在这里，报表按 COALESCE(tr.client, m.client) 取） */
function task(id, memberId, runClient) {
  repo.insertTask.run({
    id,
    projectId: 'p1',
    memberId,
    parentTaskId: null,
    title: `t-${id}`,
    state: 'done',
    progress: 1,
    startedAt: 1000,
    endedAt: 2000,
  });
  repo.upsertTaskRun.run({
    id,
    projectId: 'p1',
    memberId,
    client: runClient,
    sessionId: null,
    model: null,
    title: `t-${id}`,
    startedAt: 1000,
    baselineCommit: null,
  });
}

// t-cli：CLI 那一路；t-plugin：插件那一路；t-noMemberClient：成员 client 为空、只有 task_runs 上有
member('main@p1', 'codebuddy');
member('plug@p1', 'codebuddy-plugin');
member('nullc@p1', null);
task('t-cli', 'main@p1', 'codebuddy');
task('t-plugin', 'plug@p1', 'codebuddy-plugin');
task('t-noMemberClient', 'nullc@p1', 'codebuddy-plugin');

/** 走真实语句（与 /api/v1/task-runs 的 WHERE 同口径：COALESCE(tr.client, m.client)） */
function idsFor(client) {
  return repo.raw
    .prepare(
      `SELECT t.id FROM tasks t
       LEFT JOIN task_runs tr ON tr.id = t.id
       LEFT JOIN members m ON m.id = t.member_id
       WHERE t.parent_task_id IS NULL
         AND (@client IS NULL OR instr(@client, ',' || COALESCE(tr.client, m.client) || ',') > 0)
       ORDER BY t.id`
    )
    .all({ client })
    .map((r) => r.id);
}

/* ------------------------------ 断言 ------------------------------ */

head('[1] 单值筛选：老口径不变');
ok('client=codebuddy 只取 CLI 那条', JSON.stringify(idsFor(',codebuddy,')) === JSON.stringify(['t-cli']), JSON.stringify(idsFor(',codebuddy,')));
ok(
  'client=codebuddy-plugin 取插件两条',
  JSON.stringify(idsFor(',codebuddy-plugin,')) === JSON.stringify(['t-noMemberClient', 't-plugin']),
  JSON.stringify(idsFor(',codebuddy-plugin,'))
);

head('[2] 合并楼层：一个楼层 = 两个 client');
{
  const got = idsFor(',codebuddy,codebuddy-plugin,');
  ok('两路都取回来（3 条）', got.length === 3, JSON.stringify(got));
  ok('CLI 与插件都在里面', got.includes('t-cli') && got.includes('t-plugin') && got.includes('t-noMemberClient'));
}

head('[3] 命中口径与报表分组一致（client 只在 task_runs 上的行也算）');
ok('members.client 为空、task_runs 写了插件 client 的那条被取到', idsFor(',codebuddy-plugin,').includes('t-noMemberClient'));

head('[4] 批量删除同样认集合');
{
  const n = repo.deleteTaskRunsByFilter({ client: 'codebuddy,codebuddy-plugin' });
  ok('按合并楼层一次删掉 3 条', n === 3, `deleted=${n}`);
  ok('删完这个楼层筛不出东西了', idsFor(',codebuddy,codebuddy-plugin,').length === 0);
}

head('[5] all / 空 = 不过滤（现有语义：无筛选就是"全部"）');
{
  task('t-codex', 'main@p1', 'codex');
  task('t-cli2', 'main@p1', 'codebuddy');
  ok('先插一条别楼层的、一条本楼层的', idsFor(',codebuddy,').length >= 1);
  const n = repo.deleteTaskRunsByFilter({ client: 'all' });
  ok('client=all 时按"全部"删（别楼层那条也在内）', n === 2, `deleted=${n}`);
  ok('顶层任务清空', repo.raw.prepare('SELECT COUNT(*) AS c FROM tasks WHERE parent_task_id IS NULL').get().c === 0);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
