/**
 * 议事厅接口自检 —— 真 express 路由 + 真 repo + 临时库，**只有编排器是假的**。
 *
 * 假编排器不是偷懒：这里要验的是"接口收什么、拒什么、返回什么"，而真编排器会去拉外部 CLI。
 * 假的记下 start / cancel 被怎么调了，就能断言"发起成功之后确实开跑了""删除在跑的会被拦住"。
 * 状态机本身在 councilOrchestrator.test.js 里用假参与者整条跑过。
 *
 * 盯的是接口层的几条"不编造"：
 *   · 楼层没装 CLI / 不在白名单 → 拒掉整条请求（**降级成三个人开会是编造**）；
 *   · 材料读不到 → 拒掉并列明是哪几个（静默跳过会让用户以为参与者看过那个文件）；
 *   · 在跑的会不许删（删了之后在飞的发言会写成孤儿行 —— 这几张表没有外键）。
 *
 * 跑法：`npm run test:council-api`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const express = require('express');

const { openDatabase } = require('../src/db');
const { createCouncilRouter } = require('../src/http/routes/council');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-council-api-'));
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));

/** 四个楼层，前三个装了 CLI、8F 没装（用来验"请不动"的拒绝与理由） */
const FLOORS = [
  { floorId: '1F', name: 'CodeBuddy', agent: 'codebuddy', ready: true, cliPath: '/usr/bin/codebuddy', reason: '' },
  { floorId: '4F', name: 'Claude Code', agent: 'claude', ready: true, cliPath: '/usr/bin/claude', reason: '' },
  { floorId: '7F', name: 'Kilo Code', agent: 'kilo', ready: true, cliPath: '/usr/bin/kilo', reason: '' },
  { floorId: '8F', name: 'OpenCode', agent: 'opencode', ready: false, cliPath: null, reason: '没找到命令行可执行文件' },
];

/** 假编排器：只记调用，不真开会 */
const orch = {
  started: [],
  active: new Set(),
  startedWith: [],
  start(id) {
    this.started.push(id);
    return Promise.resolve(null);
  },
  cancel(id) {
    if (!this.active.has(id)) return false;
    this.active.delete(id);
    this.startedWith.push(id);
    return true;
  },
  activeIds() {
    return [...this.active];
  },
};

const app = express();
app.use(express.json());
app.use('/api/v1', createCouncilRouter({ repo, orchestrator: orch, deps: { listFloors: () => FLOORS } }));

const post = (p, body) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const get = (p) => fetch(`${base}${p}`);
const del = (p) => fetch(`${base}${p}`, { method: 'DELETE' });

let base = '';
let server = null;

(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;

  /* ------------------------------------------------------------ 楼层 */
  head('可选楼层：不只是白名单，还要说清哪层请不动、为什么');
  {
    const res = await get('/councils/floors');
    const body = await res.json();
    ok('200', res.status === 200, String(res.status));
    ok('四层都在（两层以上才能开会）', body.floors.length === 4, String(body.floors.length));
    ok('没装 CLI 的那层 ready=false', body.floors.find((f) => f.floorId === '8F').ready === false);
    ok('并给了原因（界面要显示给用户，不能只说"不可用"）', Boolean(body.floors.find((f) => f.floorId === '8F').reason));
    ok('带上了缺省轮数（前端不用再写死一份）', body.defaults.maxRounds >= 1 && body.defaults.maxRoundsLimit >= body.defaults.maxRounds);
    ok('带上了材料字节上限（界面要拿它标注"已截断"）', body.defaults.materialMaxBytes > 0);
  }

  /* ------------------------------------------------------------ 发起：拒绝 */
  head('发起：这些请求必须被拒掉');
  {
    const cases = [
      [{ floors: ['1F', '4F'] }, '没有议题'],
      [{ topic: '   ', floors: ['1F', '4F'] }, '议题只有空白'],
      [{ topic: '要不要上 X', floors: ['1F'] }, '只请了一个人'],
      [{ topic: '要不要上 X', floors: [] }, '一个人都没请'],
      [{ topic: '要不要上 X', floors: ['1F', '9F'] }, '楼层不在白名单'],
      [{ topic: '要不要上 X', floors: ['1F', '8F'] }, '有一层请不动（没装 CLI）'],
    ];
    for (const [body, why] of cases) {
      const res = await post('/councils', body);
      const r = await res.json();
      ok(`拒绝：${why}`, res.status === 400 && r.ok === false && Boolean(r.error.message), `${res.status} ${JSON.stringify(r).slice(0, 120)}`);
    }
    ok('一层都没建成（拒掉就是拒掉，不留半场会）', repo.listCouncils(50).length === 0, String(repo.listCouncils(50).length));
    ok('也没让编排器开跑', orch.started.length === 0);
  }

  head('发起：材料文件读不到 → 整条拒掉，并点明是哪个文件');
  {
    const res = await post('/councils', {
      topic: '要不要上 X',
      floors: ['1F', '4F'],
      files: ['/tmp/这个文件肯定不存在-9f3a.txt'],
    });
    const r = await res.json();
    ok('400', res.status === 400, String(res.status));
    ok('错误里点名了那个文件（用户才知道该换哪个）', String(r.error.message).includes('这个文件肯定不存在'), String(r.error.message));
    ok('没有静默跳过、也没有建成半场会', repo.listCouncils(50).length === 0, String(repo.listCouncils(50).length));
  }

  /* ------------------------------------------------------------ 发起：成功 */
  head('发起：落库 + 立刻开跑');
  let id = null;
  {
    const doc = path.join(TMP, '说明.txt');
    fs.writeFileSync(doc, '这是背景材料的正文。');
    const res = await post('/councils', {
      topic: '要不要把 A 方案换成 B 方案？',
      floors: ['1F', '4F', '7F'],
      files: [doc],
      maxRounds: 2,
    });
    const r = await res.json();
    id = r.council && r.council.id;
    ok('201', res.status === 201, String(res.status));
    ok('回了这场会', Boolean(id), JSON.stringify(r).slice(0, 150));
    ok('初始是 draft（编排器才开始跑）', r.council.status === 'draft', r.council.status);
    ok('议题按用户原话存着', r.council.topic === '要不要把 A 方案换成 B 方案？');
    ok('轮数按请求存（不是写死的缺省）', r.council.max_rounds === 2, String(r.council.max_rounds));
    ok('判定口径落在这一场上（不被后续全局改动影响）', r.council.threshold === 'unanimous', String(r.council.threshold));

    ok('编排器被叫起来跑这一场', orch.started.includes(id), JSON.stringify(orch.started));
    const ps = repo.listParticipants(id);
    ok('三个出席者都落了库', ps.length === 3 && ps.map((p) => p.floor_id).join() === '1F,4F,7F', JSON.stringify(ps.map((p) => p.floor_id)));
    ok('记下了当时用的可执行文件（排查要知道是哪个）', ps[0].cli_path === '/usr/bin/codebuddy', String(ps[0].cli_path));
    const ms = repo.listMaterials(id);
    ok('材料正文落库了（可追溯"到底喂进去了什么"）', ms.length === 1 && ms[0].content === '这是背景材料的正文。', JSON.stringify(ms));
    ok('材料带上了字节数', ms[0].bytes_included === Buffer.byteLength('这是背景材料的正文。', 'utf8'));
  }

  head('发起：超上限的材料会被截断，且截断的事实一起落库');
  {
    const big = path.join(TMP, '大文件.txt');
    fs.writeFileSync(big, 'x'.repeat(200 * 1024));
    const res = await post('/councils', { topic: '长材料', floors: ['1F', '4F'], files: [big] });
    const r = await res.json();
    const m = repo.listMaterials(r.council.id)[0];
    ok('201 建起来了（截断不是错误）', res.status === 201, String(res.status));
    ok('truncated=1', m.truncated === 1);
    ok('bytesTotal 是真实大小 204800', m.bytes_total === 200 * 1024, String(m.bytes_total));
    ok('实际只给了 64KB', m.bytes_included === 64 * 1024, String(m.bytes_included));
    ok('正文长度与 bytes_included 对得上', Buffer.byteLength(m.content, 'utf8') === m.bytes_included);
  }

  /* ------------------------------------------------------------ 读 */
  head('详情：一次给全（轮次 / 发言 / 材料 / 是否还在跑）');
  {
    repo.upsertRound({
      councilId: id, roundNo: 0, kind: 'brief', proposalText: '要不要把 A 方案换成 B 方案？', proposalFrom: 'chair',
      agree: 0, disagree: 0, abstain: 0, invalid: 0, consensus: 0, startedAt: 1, endedAt: 2,
    });
    repo.insertUtterance({ councilId: id, roundNo: 0, floorId: 'chair', role: 'chair', content: '议题原文', status: 'ok' });
    repo.insertUtterance({ councilId: id, roundNo: 1, floorId: '4F', role: 'speaker', content: '我觉得可以', vote: 'agree', status: 'ok' });

    const res = await get(`/councils/${id}`);
    const r = await res.json();
    ok('200', res.status === 200, String(res.status));
    ok('带上轮次（含第 0 轮议题陈述）', r.rounds.length === 1 && r.rounds[0].round_no === 0);
    ok('带上发言（含主席那条）', r.utterances.length === 2 && r.utterances.some((u) => u.role === 'chair'));
    ok('带上票', r.utterances.find((u) => u.round_no === 1).vote === 'agree');
    ok('带上材料正文', r.materials.length === 1 && Boolean(r.materials[0].content));
    ok('带上出席者', r.participants.length === 3);
    ok('live=false（假编排器没把它标成在跑）', r.live === false);

    orch.active.add(id);
    const r2 = await (await get(`/councils/${id}`)).json();
    ok('在飞时 live=true（界面据此显示"讨论中"）', r2.live === true);
  }

  head('列表与 404');
  {
    const r = await (await get('/councils')).json();
    ok('列表按发起时间倒序给出全部会', r.councils.length === 2 && r.councils[0].created_at >= r.councils[1].created_at);
    const nf = await get('/councils/查无此会');
    ok('不存在的会 → 404', nf.status === 404, String(nf.status));
    ok('404 也带 { ok:false, error.message }', (await nf.json()).error.message === '没有这场会');
  }

  /* ------------------------------------------------------------ 取消 / 删除 */
  head('取消');
  {
    const r = await (await post(`/councils/${id}/cancel`)).json();
    ok('在跑 → cancelled=true', r.cancelled === true, JSON.stringify(r.cancelled));
    ok('编排器收到了取消', orch.startedWith.includes(id));
    const r2 = await (await post(`/councils/${id}/cancel`)).json();
    ok('再取消一次 → cancelled=false（不抛错，如实说没取消到）', r2.cancelled === false);
    const nf = await post('/councils/查无此会/cancel');
    ok('取消不存在的会 → 404', nf.status === 404, String(nf.status));
  }

  head('删除：在跑的会先取消再删（否则在飞的发言会写成孤儿行）');
  {
    orch.active.add(id);
    const res = await del(`/councils/${id}`);
    const r = await res.json();
    ok('在跑时删除 → 409', res.status === 409, String(res.status));
    ok('并告诉用户先取消', /先取消/.test(String(r.error.message)), String(r.error.message));
    ok('会还在（没被删掉）', repo.getCouncil(id) !== null);

    orch.active.delete(id);
    const res2 = await del(`/councils/${id}`);
    ok('停了之后删除 → 200', res2.status === 200, String(res2.status));
    ok('这场会没了', repo.getCouncil(id) === null);
    ok('子表也清干净了（不留孤儿）', repo.listUtterances(id).length === 0 && repo.listRounds(id).length === 0 && repo.listMaterials(id).length === 0 && repo.listParticipants(id).length === 0);

    const nf = await del('/councils/查无此会');
    ok('删不存在的会 → 404', nf.status === 404, String(nf.status));
    ok('删完之后列表里只剩另一场', repo.listCouncils(50).length === 1, String(repo.listCouncils(50).length));
  }

  server.close();
  close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${fail ? '✗' : '✓'} council-api: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
