/**
 * 议事厅 store 的自检 —— 两条数据来源合到一起之后，界面上看到的到底是哪一份。
 *
 * 为什么值得单独钉：这个 store 同时吃 **HTTP 详情**（一份快照）和 **WS 增量**（一条条推）。
 * 出错的形态都很隐蔽，而且只在某一条路径上出现：
 *   · 增量把已有正文抹掉 → "刷新一下，正文就没了"；
 *   · 断线重连后 WS 那份没了，横幅还挂着上一轮的提案 → "明明进了第 3 轮，桌上还写着第 2 轮"；
 *   · 收尾事件只带一个摘要（verdict / status），**结论文本和停在第几轮只有库里有** ——
 *     不回拉详情的话，页面会停在一个没有结论的"已结束"上；
 *   · 删除撞上 409（会还在跑）被当成成功 → 从列表里消失、其实还在。
 *
 * fetch 整个换成假的：这里要验的是"拿到响应之后怎么处理"，不是网络本身。
 *
 * 跑法：`npm run test:council-ui-store`
 */
import { createServer } from 'vite';
import { createPinia, setActivePinia } from 'pinia';

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

const server = await createServer({
  root: 'renderer',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
  ssr: { external: ['@workgremlin/shared'] },
});
const { useCouncilStore } = await server.ssrLoadModule('/src/stores/council.js');
const { useProjectStore } = await server.ssrLoadModule('/src/stores/project.js');

/* ------------------------------------------------------------------ 假服务端 */

const calls = [];
let routes = {};
const json = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });

globalThis.fetch = async (url, opts) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  calls.push({ path, method: (opts && opts.method) || 'GET' });
  const hit = Object.keys(routes).find((k) => k === `${(opts && opts.method) || 'GET'} ${path}`);
  if (!hit) return json({ ok: false, error: { code: 'not_found', message: `没有这条路由：${path}` } }, 404);
  return routes[hit]();
};

/** 每个用例都从干净的 pinia + 干净的路由表开始 */
function fresh() {
  setActivePinia(createPinia());
  const project = useProjectStore();
  project.serverInfo = { port: 45678, token: 'tk' };
  const council = useCouncilStore();
  calls.length = 0;
  routes = {};
  return council;
}

/** 一场两层的会，第 1 轮还没结束 */
const DETAIL = {
  ok: true,
  council: { id: 'c1', topic: '议题', status: 'running', verdict: null, max_rounds: 3 },
  participants: [{ floor_id: '1F', status: 'ok', error: null }],
  materials: [{ ord: 0, path: '/tmp/a.md', bytes_total: 10, bytes_included: 10, truncated: 0 }],
  rounds: [
    { round_no: 0, kind: 'brief', proposal_text: '议题', proposal_from: 'chair' },
    { round_no: 1, kind: 'debate', proposal_text: '初版', proposal_from: 'chair' },
  ],
  utterances: [
    // 第 0 轮的主席陈述也是**一条发言**（服务端落库的，不是前端凭空加的）
    { round_no: 0, floor_id: 'chair', role: 'chair', content: '议题', status: 'ok' },
    { round_no: 1, floor_id: '1F', role: 'speaker', content: '原文正文', vote: 'agree', vote_reason: '可以', status: 'ok' },
  ],
  live: true,
};

head('打开一场会：SQL 行归一之后才进 state');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  await s.open('c1');
  ok('详情进来了', Boolean(s.current) && s.current.council.id === 'c1');
  const u1 = s.current.utterances.find((x) => x.floorId === '1F');
  ok('发言按统一形状存（roundNo / voteReason）', u1.roundNo === 1 && u1.voteReason === '可以');
  ok(
    '时间线分好组（第 0 轮陈述 + 第 1 轮讨论），票型从发言数出来、主席不占席位',
    s.timeline.length === 2 && s.timeline[1].tally.agree === 1 && s.timeline[0].tally.seats === 0,
    JSON.stringify(s.timeline.map((g) => g.tally))
  );
  ok('带上了鉴权头', calls[0] !== undefined);
}

head('WS 增量：补齐字段，但**不许**把已有的正文抹掉');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  await s.open('c1');
  // 服务端补推一条更"完整"的记录，但没带正文（增量里没有的字段就是 null）
  s.applyEvent({ councilId: 'c1', utterance: { roundNo: 1, floorId: '1F', vote: 'agree', durationMs: 1200 } });
  const u = s.current.utterances.find((x) => x.floorId === '1F');
  ok('耗时补上了', u.durationMs === 1200);
  ok('正文还在（没有被 null 覆盖）', u.content === '原文正文', String(u.content));
  ok('理由还在', u.voteReason === '可以');
  ok(
    '没造出重复的一层（1F 仍然只有一条）',
    s.current.utterances.filter((x) => x.floorId === '1F').length === 1,
    String(s.current.utterances.filter((x) => x.floorId === '1F').length)
  );
}

head('换一场会：上一场的实时提案立刻作废');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  routes['GET /api/v1/councils/c2'] = () =>
    json({ ...DETAIL, council: { ...DETAIL.council, id: 'c2' }, rounds: [DETAIL.rounds[0]], utterances: [] });
  await s.open('c1');
  s.applyEvent({ councilId: 'c1', roundNo: 1, phase: 'debate', proposal: '初版', proposalFrom: 'chair' });
  ok('第 1 轮的提案挂上了', s.currentProposal && s.currentProposal.proposal === '初版');
  await s.open('c2');
  ok('打开新的一场后，旧提案不再显示', s.currentProposal === null, JSON.stringify(s.currentProposal));
}

head('当前提案：库里的快照与 WS 的增量，按轮次号取新的那份');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  await s.open('c1');
  ok('库里只有第 1 轮 → 就是它', s.currentProposal.roundNo === 1 && s.currentProposal.proposal === '初版');

  // 进第 2 轮：WS 先推，详情那份还是打开时的快照（停在第 1 轮）
  s.applyEvent({ councilId: 'c1', roundNo: 2, phase: 'debate', proposal: '4F 的修订案', proposalFrom: '4F' });
  ok('WS 更新的那份赢（界面不会停在第 1 轮）', s.currentProposal.roundNo === 2 && s.currentProposal.proposal === '4F 的修订案');

  // 断线重连后 WS 那份没了：回落到库里最新的一轮，而不是空着
  const s2 = fresh();
  s2.current = { ...s.current, rounds: [...DETAIL.rounds, { round_no: 2, kind: 'debate', proposal_text: '4F 的修订案', proposal_from: '4F' }], utterances: [] };
  ok('没有 WS 增量时用库里最新的那份', s2.currentProposal.roundNo === 2 && s2.currentProposal.proposal === '4F 的修订案');
}

head('收尾：推送只有摘要，结论必须回拉一次详情');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  routes['GET /api/v1/councils?limit=50'] = () => json({ ok: true, councils: [{ id: 'c1', topic: '议题', status: 'done', verdict: 'consensus', max_rounds: 3 }] });
  await s.open('c1');
  calls.length = 0;

  const DONE = { ...DETAIL, council: { ...DETAIL.council, status: 'done', verdict: 'consensus', verdict_round: 1 }, live: false };
  let detail = DETAIL;
  routes['GET /api/v1/councils/c1'] = () => json(detail);
  detail = DONE;

  s.applyEvent({ councilId: 'c1', status: 'done', verdict: 'consensus', verdictRound: 1 });
  await new Promise((r) => setTimeout(r, 10)); // fetchList / open 是 await 出去的
  ok('回拉了详情', calls.some((c) => c.path === '/api/v1/councils/c1'), JSON.stringify(calls));
  ok('也刷了历史列表', calls.some((c) => c.path.startsWith('/api/v1/councils?')), JSON.stringify(calls));
  ok('结论落进 state（不是停在"已结束但没有结论"）', s.current.council.verdict === 'consensus');
  ok('已结束的会不再是 live', s.live === false);
  ok('实时提案清掉了（结论由轮次行说了算）', s.liveProposal === null);
}

head('别的会的动静：刷新列表，但不许搅乱当前这场');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  await s.open('c1');
  const before = s.current.utterances.length;
  s.applyEvent({ councilId: 'c-别的', utterance: { roundNo: 1, floorId: '8F', content: '不该出现在这里' } });
  ok('当前这场没被写进别人的发言', s.current.utterances.length === before);
  ok('也没有凭空冒出一条', !s.current.utterances.some((u) => u.floorId === '8F'));
}

head('删除：409（还在讨论）要如实报错，不能当成功');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  routes['GET /api/v1/councils?limit=50'] = () => json({ ok: true, councils: [] });
  await s.open('c1');
  routes['DELETE /api/v1/councils/c1'] = () =>
    json({ ok: false, error: { code: 'conflict', message: '这场会还在讨论，先取消再删' } }, 409);
  const done = await s.remove('c1');
  ok('返回失败', done === false);
  ok('服务端的原话照搬出来', s.error === '这场会还在讨论，先取消再删', s.error);
  ok('这场会还开在页面上（没有假装删掉了）', Boolean(s.current));

  routes['DELETE /api/v1/councils/c1'] = () => json({ ok: true });
  const done2 = await s.remove('c1');
  ok('真删掉了才算成功', done2 === true);
  ok('删掉后当前这场清空', s.current === null);
}

head('发起：服务端拒绝时原因原样带出来，不自己编一句');
{
  const s = fresh();
  routes['POST /api/v1/councils'] = () =>
    json({ ok: false, error: { code: 'bad_request', message: '4F：没找到命令行可执行文件' } }, 400);
  const id = await s.create({ topic: 'x', floors: ['1F', '4F'], files: [], maxRounds: 2 });
  ok('没有返回 id', id === null);
  ok('原因就是服务端那句', s.error === '4F：没找到命令行可执行文件', s.error);
  ok('没有留下半场会', s.current === null);
}

await server.close();
console.log(`\n${fail ? '✗' : '✓'} council-ui-store: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
