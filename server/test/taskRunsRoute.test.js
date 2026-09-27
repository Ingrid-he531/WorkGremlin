'use strict';
/**
 * `/api/v1/task-runs` 的**真实 SQL** 自检 —— 任务记录页唯一的取数接口。
 *
 * 为什么单独一个文件：这条 SQL 是手写的一大段（LEFT JOIN + COALESCE + CASE + instr 过滤），
 * 2026-09-27 往里加一列注释时把它插进了 CASE 子查询里，`SqliteError: near "tr": syntax error`
 * —— 接口 500、任务列表整页空白，而当时的自检（只跑 repo 语句 / 不走路由）全都绿。
 * 所以这里起**真路由**（express + 真 repo + 临时库），把这条 SQL 真跑一遍并断言返回字段。
 *
 * 跑法：`npm run test:task-runs-route`
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-task-runs-route-'));
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));
const hub = { broadcast() {} };
const bus = createIngestBus({ repo, hub, projectName: 'p1', project: 'p1' });

/* ------------------------------ 造数据 ------------------------------ */
repo.upsertProject.run({ id: 'p1', name: 'p1', workspacePath: '/tmp/p1', mainConversationId: null, source: 'report', createdAt: 1 });
repo.upsertMember.run({
  id: 'codex@p1',
  projectId: 'p1',
  name: 'codex',
  role: 'agent',
  sessionId: null,
  reported: 1,
  createdAt: 1,
  lastSeenAt: 1,
  ephemeral: 0,
  projectLabel: null,
  client: 'codex',
});
function seedTask(id, form, startedAt) {
  repo.insertTask.run({
    id,
    projectId: 'p1',
    memberId: 'codex@p1',
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
    memberId: 'codex@p1',
    client: 'codex',
    sessionId: `s-${id}`,
    form,
    model: 'gpt-x',
    title: `t-${id}`,
    startedAt,
    baselineCommit: null,
  });
}
seedTask('t-plugin', 'plugin', 2000);
seedTask('t-cli', 'cli', 1000);
seedTask('t-old', null, 500); // 老数据：没有形态

/* ------------------------------ 真路由 ------------------------------ */
const app = express();
app.use('/api/v1', createQueryRouter({ bus, repo }));

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const get = async (qs) => {
    const res = await fetch(`${base}/task-runs?${qs}`);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };

  console.log('[1] 接口本身不报错（SQL 能 prepare + 执行）');
  const all = await get('limit=50');
  ok('HTTP 200', all.status === 200, `status=${all.status}`);
  ok('ok=true 且带回全部 3 条', Boolean(all.body && all.body.ok) && (all.body.items || []).length === 3, JSON.stringify(all.body && all.body.items && all.body.items.length));

  console.log('[2] 返回字段齐（任务列表按这些字段渲染）');
  const row = (all.body.items || []).find((t) => t.id === 't-plugin') || {};
  ok('client 在', row.client === 'codex', row.client);
  ok('form 在（Codex CLI / Codex Plugin 靠它）', row.form === 'plugin', JSON.stringify(row.form));
  ok('老数据 form 为 null（显示退回只写产品名）', (all.body.items.find((t) => t.id === 't-old') || {}).form === null);
  ok('file_count / files_json / model / result 列都在 SELECT 里', ['file_count', 'files_json', 'model', 'result', 'session_id', 'duration_ms', 'subagentCount'].every((k) => k in row), Object.keys(row).join(','));

  console.log('[3] 楼层筛选照常（合并楼层的逗号集合）');
  const filtered = await get('limit=50&client=codex');
  ok('client=codex 取到 3 条', (filtered.body.items || []).length === 3, JSON.stringify((filtered.body.items || []).map((t) => t.id)));

  server.close();
  close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
