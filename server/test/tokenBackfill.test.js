'use strict';
/**
 * 收工**之后**补报 token（`/api/v1/task/tokens`）的自检。
 *
 * 为什么要有这条接口：CodeBuddy **插件**形态那条 request 的 usage 落盘比 Stop 晚得多
 * （本机实测：0c1f… 会话第一轮 Stop 于 14:12:41，hook 在 Stop 里等 1.2s 都等不到，
 * 那条 request 直到第二轮开始之后才补上 usage）—— 收工那一刻读不到真值，插件形态
 * 的 token 就永远是 "—"。所以落盘之后再补一刀（见 packages/reporter/src/tokenBackfill.js）。
 *
 * 这里锁的是"补报只写 token 四列"这条边界：
 *   · 真的补上了（会话 + 起点附近认得出那一行）；
 *   · 已经记过数的行**不许改**（重复补不能把真值冲掉）；
 *   · 认不出（别的会话 / 起点对不上）就一行都不写 —— 宁可留 "—" 也不写到别的轮次头上；
 *   · 产出摘要 / 收工时间这些别的字段一个都不动（这是它与 endTask 的分工）。
 *
 * 跑法：`npm run test:token-backfill`
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const WG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-token-backfill-home-'));
process.env.WORKGREMLIN_HOME = WG_HOME;

const express = require('express');
const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');
const { createIngestRouter } = require('../src/http/routes/ingest');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-token-backfill-'));
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));
const hub = { broadcast() {} };
const bus = createIngestBus({ repo, hub, projectName: 'p1', project: 'p1' });

repo.upsertProject.run({ id: 'p1', name: 'p1', workspacePath: '/tmp/p1', mainConversationId: null, source: 'report', createdAt: 1 });
repo.upsertMember.run({
  id: 'codebuddy@p1',
  projectId: 'p1',
  name: 'codebuddy',
  role: 'agent',
  sessionId: null,
  reported: 1,
  createdAt: 1,
  lastSeenAt: 1,
  ephemeral: 0,
  projectLabel: null,
  client: 'codebuddy',
});

const app = express();
app.use('/api/v1', createIngestRouter({ bus }));
const server = app.listen(0);
let port = 0;

/* ------------------------------ 工具 ------------------------------ */

function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          let j = {};
          try {
            j = JSON.parse(raw);
          } catch {
            /* 空响应 */
          }
          resolve({ status: res.statusCode, body: j });
        });
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

const runOf = (id) => repo.getTaskRun.get(id);
const T0 = 1_800_000_000_000;

/* ------------------------------ 用例 ------------------------------ */

(async () => {
  port = server.address().port;
  const base = { project: 'p1', workspacePath: '/tmp/p1', memberId: 'codebuddy@p1', sessionId: 'ses_1' };

  console.log('\n[1] 收工了但没数的一行：补报写进去');
  const started = await post('/api/v1/task/start', { ...base, title: '打开看看', model: 'auto', form: 'plugin' });
  const taskId = started.body.taskId;
  await post('/api/v1/task/end', { ...base, taskId, state: 'done', result: '改好了', files: [], fileCount: 0 });
  ok('收工时没带 token → 四列全空', runOf(taskId).input_tokens === null && runOf(taskId).output_tokens === null);

  /* hook 手上那份"本轮起点"是它自己记的 Date.now()，库里这份是服务端写的 ——
     差一个 HTTP 往返（几毫秒到几十毫秒），所以补报按"附近"认，不要求等值。 */
  const startedAt0 = Number(runOf(taskId).started_at) || 0;
  const r1 = await post('/api/v1/task/tokens', {
    ...base,
    startedAt: startedAt0 + 5,
    tokens: { input: 231, output: 163, cacheRead: 18176, cacheWrite: 0 },
  });
  const after = runOf(taskId);
  ok('补报返回 ok + 认到的行', r1.status === 200 && r1.body.taskId === taskId, JSON.stringify(r1.body));
  ok(
    '四列都写上了',
    after.input_tokens === 231 && after.output_tokens === 163 && after.cache_read_tokens === 18176 && after.cache_write_tokens === 0,
    JSON.stringify(after)
  );

  console.log('\n[2] 补报**只**动 token：产出摘要 / 收工时间 / 标题原样');
  ok('result 没被抹掉', after.result === '改好了', String(after.result));
  ok('ended_at 没被改写', Number(after.ended_at) > 0, String(after.ended_at));
  ok('标题原样', after.title === '打开看看', String(after.title));

  console.log('\n[3] 已经记过数的行：再补一刀不许改');
  const r2 = await post('/api/v1/task/tokens', {
    ...base,
    startedAt: startedAt0 + 5,
    tokens: { input: 999999, output: 999999, cacheRead: 999999, cacheWrite: 999999 },
  });
  const again = runOf(taskId);
  ok('第二次补报没人认领（skipped）', r2.body.taskId === undefined, JSON.stringify(r2.body));
  ok('真值还在（没被第二次盖掉）', again.input_tokens === 231 && again.output_tokens === 163, JSON.stringify(again));

  console.log('\n[4] 认不出该补哪行 → 一行都不写');
  // 起点差 60s：hook 与服务端那份 started_at 只差一个 HTTP 往返，差一分钟说明不是同一轮
  await post('/api/v1/task/start', { ...base, title: '第二轮', model: 'auto', form: 'plugin' });
  const s2 = await post('/api/v1/task/start', { ...base, title: '真正要补的那轮', model: 'auto', form: 'plugin' });
  const id2 = s2.body.taskId;
  await post('/api/v1/task/end', { ...base, taskId: id2, state: 'done' });
  const r3 = await post('/api/v1/task/tokens', { ...base, startedAt: (Number(runOf(id2).started_at) || 0) + 60_000, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
  ok('起点对不上 → 不补（skipped）', r3.body.taskId === undefined, JSON.stringify(r3.body));
  ok('那一行仍是空（不是 0）', runOf(id2).input_tokens === null, String(runOf(id2).input_tokens));

  const r4 = await post('/api/v1/task/tokens', {
    ...base,
    sessionId: 'ses_别的会话',
    startedAt: startedAt0 + 5,
    tokens: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
  });
  ok('别的会话 → 不补（不串台）', r4.body.taskId === undefined, JSON.stringify(r4.body));

  console.log('\n[5] 没带 token 的上报直接拒（不写 0）');
  const r5 = await post('/api/v1/task/tokens', { ...base, startedAt: startedAt0 + 5 });
  ok('缺 tokens → 400', r5.status === 400, String(r5.status));

  console.log('\n[6] 被取消但没收工（ended_at 仍空）的行：也认得出来补');
  const s6 = await post('/api/v1/task/start', { ...base, title: '被打断那轮', model: 'auto', form: 'plugin' });
  const id6 = s6.body.taskId;
  // 这一轮被打断、收工流程没跑成功 → ended_at 仍是 NULL、token 全空（正是 10-08 13:40 那条的样子）
  const r6 = await post('/api/v1/task/tokens', {
    ...base,
    startedAt: Number(runOf(id6).started_at) + 5,
    tokens: { input: 11, output: 22, cacheRead: 33, cacheWrite: 0 },
  });
  ok('取消没收工的行也被补上了', r6.status === 200 && r6.body.taskId === id6, JSON.stringify(r6.body));
  ok('四列写入', runOf(id6).input_tokens === 11 && runOf(id6).output_tokens === 22 && runOf(id6).cache_read_tokens === 33);

  close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(WG_HOME, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
