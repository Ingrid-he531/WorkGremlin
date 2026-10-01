/**
 * 「自动保留最近 N 天」的缺省值与清理口径自检。
 *
 * 为什么要有它（2026-10-01 用户要求把缺省从 30 改成 90）：
 *   · 这个数原来**散在三处**（repo 的 fallback、两个路由的 `|| 30`、前端 ref 的初值），
 *     改一处忘一处就会出现"界面显示 30、服务端按 90 清"这种对不上的情况 —— 现在都取
 *     DEFAULTS.RETENTION_DAYS，这里盯着它们别再分叉。
 *   · 它还是**会真删数据**的：PUT /settings/retention 存下来后会立刻按新保留期清一次。
 *     缺省值一改，影响的不只是界面上显示的那个数字。
 *
 * 跑法：`npm run test:retention`（起真路由 + 真 repo + 临时库，不 mock）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const express = require('express');
const { DEFAULTS } = require('@workgremlin/shared');

const { openDatabase } = require('../src/db');
const { createQueryRouter } = require('../src/http/routes/query');

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
const head = (t) => console.log(`\n${t}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-retention-'));
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));

const DAY = 24 * 60 * 60 * 1000;
// 用**真实此刻**：清理的切割线是路由里拿 `Date.now()` 现算的，拿固定时刻造数据的话
// 整个相对关系会飘（第一版写成 1_800_000_000_000，"100 天前"其实落在未来，一条都删不掉）
const NOW = Date.now();

repo.upsertProject.run({ id: 'p1', name: 'p1', workspacePath: '/tmp/p1', mainConversationId: null, source: 'report', createdAt: 1 });
// tasks.member_id 是 NOT NULL：造个成员挂着（记录保留跟成员无关，只是表约束）
repo.upsertMember.run({
  id: 'm@p1', projectId: 'p1', name: 'm', role: 'agent', sessionId: null, reported: 1,
  createdAt: 1, lastSeenAt: 1, ephemeral: 0, projectLabel: null, client: 'claude-code',
});

/** 一条任务记录，开始时刻 = now 往前 ageDays 天（清理按 started_at 比） */
function task(id, ageDays) {
  const startedAt = NOW - ageDays * DAY;
  repo.insertTask.run({
    id,
    projectId: 'p1',
    memberId: 'm@p1',
    parentTaskId: null,
    title: `t-${id}`,
    state: 'done',
    progress: 1,
    startedAt,
    endedAt: startedAt + 1000,
  });
  repo.upsertTaskRun.run({
    id,
    projectId: 'p1',
    memberId: 'm@p1',
    client: 'claude-code',
    sessionId: null,
    form: null,
    model: null,
    title: `t-${id}`,
    startedAt,
    baselineCommit: null,
  });
}

const app = express();
app.use('/api/v1', createQueryRouter({ repo }));
const server = app.listen(0, '127.0.0.1');
const listening = new Promise((r) => server.once('listening', r));
let base = '';
const get = async (p) => (await fetch(`${base}${p}`)).json();
const put = async (p) => (await fetch(`${base}${p}`, { method: 'PUT' })).json();
const countRuns = () => repo.raw.prepare('SELECT COUNT(*) AS n FROM task_runs').get().n;

(async () => {
  await listening;
  base = `http://127.0.0.1:${server.address().port}/api/v1`;

  head('[1] 缺省值：全新库 = DEFAULTS.RETENTION_DAYS（用户要的 90）');
  {
    ok('常量本身就是 90', DEFAULTS.RETENTION_DAYS === 90, String(DEFAULTS.RETENTION_DAYS));
    ok('repo 的缺省跟常量一致（没在别处写死 30）', repo.getRetentionDays() === DEFAULTS.RETENTION_DAYS, String(repo.getRetentionDays()));
    const r = await get('/settings/retention');
    ok('GET /settings/retention 也报 90', r.ok && r.days === DEFAULTS.RETENTION_DAYS, JSON.stringify(r));
  }

  head('[2] 落库值优先：用户改过就按用户的来');
  {
    await put('/settings/retention?days=300');
    ok('存 300 → 读回 300', repo.getRetentionDays() === 300 && (await get('/settings/retention')).days === 300);
    await put('/settings/retention?days=45');
    ok('再存 45 → 读回 45（覆盖写，不是取大）', repo.getRetentionDays() === 45);
  }

  head('[3] 夹在 1~3650；读不出数的回缺省值（不是 0，更不是今天的某个数）');
  {
    // days=0 这里**不是**夹成 1，而是当成"没填" → 缺省值。`Number('0') || 缺省` 里 0 是假值，
    // 先被 `||` 接走了，`Math.max(1, …)` 轮不到它。这是改动前就有的口径，如实钉住：
    // 万一哪天真想成"只留今天"，那是个会删库的语义，得单独决定，不该顺着 falsy 滑过去。
    const r0 = await put('/settings/retention?days=0');
    ok('存 0 → 当"没填"处理，回缺省值（不是夹成 1）', r0.days === DEFAULTS.RETENTION_DAYS && repo.getRetentionDays() === DEFAULTS.RETENTION_DAYS, JSON.stringify(r0));
    const rNeg = await put('/settings/retention?days=-5');
    ok('存负数 → 夹到 1', rNeg.days === 1);
    const rBig = await put('/settings/retention?days=99999');
    ok('存 99999 → 夹到 3650', rBig.days === 3650 && repo.getRetentionDays() === 3650);
    const rBad = await put('/settings/retention?days=abc');
    ok(`存 abc → 回缺省值（${DEFAULTS.RETENTION_DAYS}）`, rBad.days === DEFAULTS.RETENTION_DAYS, JSON.stringify(rBad));
    const rNone = await put('/settings/retention');
    ok('压根不带 days → 也回缺省值', rNone.days === DEFAULTS.RETENTION_DAYS, JSON.stringify(rNone));
  }

  head('[4] 保存即生效：按新保留期立刻清一次（这条缺省值一改就真会删数据）');
  {
    await put('/settings/retention?days=3650'); // 先把保留期放到最大，免得下面造的数据被顺手删掉
    task('t-old', 100); // 100 天前
    task('t-mid', 50); // 50 天前
    task('t-new', 1); // 昨天
    ok('造好 3 条', countRuns() === 3, String(countRuns()));

    // 90 天：100 天前那条该走，50 天前和昨天该留
    const r = await put('/settings/retention?days=90');
    ok('删掉的条数如实回报（cleaned=1）', r.cleaned === 1, JSON.stringify(r));
    const left = repo.raw.prepare('SELECT id FROM task_runs ORDER BY id').all().map((x) => x.id);
    ok('100 天前的没了', !left.includes('t-old'), left.join(','));
    ok('50 天前的还在（缺省 90 天以内）', left.includes('t-mid'), left.join(','));
    ok('昨天的还在', left.includes('t-new'), left.join(','));
  }

  close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
