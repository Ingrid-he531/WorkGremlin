'use strict';
/**
 * 7F Kilo / 9F GitHub Copilot 的**任务台账同步器**自检。
 *
 * 为什么单独一个文件：这两层没有 reporter hook，任务记录全靠服务端同步器往 tasks /
 * task_runs 写（server/src/kiloTasks.js / copilotTasks.js）。而任务列表是按**楼层的 clients**
 * 精确过滤的（query.js 的 instr(...) 判定）—— 同步器写的身份与楼层接纳的身份对不上，
 * 记录会被静默挡在列表外：库里有行，页面上一条都看不到。
 * （2026-09-28 实测：9F 同步器写 'copilot'，而 9F 只认 'copilot-plugin'，任务记录页永远空。）
 *
 * 所以这里不测"函数有没有跑"，而是端到端测**用户看到的那条路**：
 *   同步器写库 → /api/v1/task-runs?client=<该楼层的 clients> 能取回这条记录。
 * 顺带锁住两个踩过的坑：
 *   · 会话停下后成员状态要回落 idle（只写 thinking，成员卡会永远"思考中"）；
 *   · 会话停下后 ended_at 要真的有值（活跃任务不能被旧值卡住）。
 *
 * 跑法：`npm run test:task-sync`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

/* ------------------------------ 沙箱 ------------------------------ */
// sessions.js / products.js 在 require 时就把 HOME 记下来了，环境变量必须先设
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-task-sync-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(WG, { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;

const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');
const { createQueryRouter } = require('../src/http/routes/query');
const { detectProducts, RE_GITHUB_COPILOT } = require('../src/products');
const sessionsMod = require('../src/sessions');
const kiloMod = require('../src/kilo');
const opencodeMod = require('../src/opencode');

/* 固定数据打桩：只把"厂商落盘"那一层换掉，repo / 路由 / 同步器全是真的。
 * [9] 那一节要跑**真实的扫盘**证明别的产品的会话不会被写进 9F —— 用一个开关切过去：
 * copilotTasks 在 require 时就把 listSessions 解构走了，之后改模块导出对它无效。 */
const realListSessions = sessionsMod.listSessions;
let scanReal = false;
let lastScanOpts = null;
let copilotRows = [];
let kiloRows = [];
let opencodeRows = [];
sessionsMod.listSessions = (opts = {}) => {
  lastScanOpts = opts;
  return scanReal ? realListSessions(opts) : { sessions: copilotRows };
};
sessionsMod.copilotCurrentModel = () => 'GPT-5 mini';
kiloMod.listKiloSessions = () => kiloRows;
// 7F 是「每一轮一条」：会话行上挂 `rounds`（形状同 kilo.js 的 readKiloRounds）
kiloMod.readKiloRounds = (sid) => ((kiloRows.find((r) => r.id === sid) || {}).rounds || []);
opencodeMod.listOpencodeSessions = () => opencodeRows;
opencodeMod.readOpencodeTurns = (sid) => ((opencodeRows.find((r) => r.id === sid) || {}).turns || []);

const { syncCopilotTasks } = require('../src/copilotTasks');
const { syncKiloTasks } = require('../src/kiloTasks');
const { syncOpencodeTasks } = require('../src/opencodeTasks');

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
const bus = createIngestBus({ repo, hub: { broadcast() {} }, projectName: 'p1', project: 'p1' });
repo.upsertProject.run({
  id: 'p1',
  name: 'p1',
  workspacePath: '/tmp/p1',
  mainConversationId: null,
  source: 'report',
  createdAt: 1,
});

/** 楼层真正接纳的上报身份（任务列表就是按它过滤的） */
const products = detectProducts();
const clientsOf = (id) => ((products.find((p) => p.id === id) || {}).clients) || [];
const F9 = clientsOf('9F');
const F7 = clientsOf('7F');

/** 成员卡状态（工位上那只小怪物显示的相位） */
function stateOf(memberId) {
  const m = bus.buildSnapshot('p1').members.find((x) => x.memberId === memberId);
  return m && m.state;
}
/** 成员卡上挂着的那条任务 id（任务列表判「已取消」时对的就是它） */
function taskIdOf(memberId) {
  const m = bus.buildSnapshot('p1').members.find((x) => x.memberId === memberId);
  return (m && m.task && m.task.id) || '';
}

const app = express();
app.use('/api/v1', createQueryRouter({ bus, repo }));

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const get = async (qs) => {
    const res = await fetch(`${base}/task-runs?${qs}`);
    const body = await res.json().catch(() => null);
    return (body && body.items) || [];
  };

  console.log('[0] 前置：两层接纳的身份（同步器必须写这里的值，否则被楼层筛选挡掉）');
  ok('7F 接纳 kilo', F7.includes('kilo'), F7.join(','));
  ok('9F 只接纳 copilot-plugin', F9.length === 1 && F9[0] === 'copilot-plugin', F9.join(','));

  console.log('[1] 9F Copilot：每一轮一条台账（收工的两轮 + 在飞那一轮）');
  const t0 = Date.now() - 10 * 60_000;
  const t1 = Date.now() - 5 * 60_000;
  const liveStart = Date.now() - 20_000;
  const liveEnd = Date.now();
  copilotRows = [
    {
      id: 'cop-sid-1',
      copilot: true, // 只有 Copilot 自己 session-store.db 里读出来的会话才带这个标记（见 sessions.js）
      project: 'p1',
      projectPath: '/tmp/p1',
      lastUpdated: t1,
      inFlight: true,
      doneTitle: '会话标题',
      prompt: '上一轮',
      // turns 表：已收工的两轮
      copilotTurns: [
        { index: 0, userMessage: '第一轮任务', at: t0 },
        { index: 1, userMessage: '第二轮任务', at: t1 },
      ],
      // 会话日志：在飞那轮的用户原话 + 起始时间；第 1 轮的起止（completedAt - elapsedMs）
      livePrompt: '正在跑的第三轮任务',
      liveStartedAt: liveStart,
      liveIndex: 2,
      liveReqs: [{ index: 1, startedAt: t1 - 60_000, endedAt: t1 }],
      // 改动文件只认会话日志里**写工具**碰过的（绝对路径，同步器转成工程相对）
      liveChanged: [{ index: 1, files: ['/tmp/p1/src/highlight.ts'] }],
      files: { count: 0, recent: [] },
    },
  ];
  ok('同步器写了 3 条（两轮已收工 + 在飞那轮）', syncCopilotTasks({ bus, repo }) === 3);
  ok('过渡期那条「一条会话一条」的旧台账被收掉', !repo.getTaskRun.get('copilot:cop-sid-1'));
  const run9 = repo.getTaskRun.get('copilot:cop-sid-1:1');
  ok('每轮台账的 client 是楼层接纳的身份', Boolean(run9) && F9.includes(run9.client), run9 && run9.client);
  const items9 = await get(`project=p1&client=${F9.join(',')}&limit=50`);
  const row0 = items9.find((t) => t.id === 'copilot:cop-sid-1:0') || null;
  const row1 = items9.find((t) => t.id === 'copilot:cop-sid-1:1') || null;
  const row2 = items9.find((t) => t.id === 'copilot:cop-sid-1:2') || null;
  ok('两轮已收工的都按 9F 楼层筛选取得到', Boolean(row0) && Boolean(row1), JSON.stringify(items9.map((t) => t.id)));
  ok('标题 = 那一轮用户说的话', Boolean(row0) && row0.title === '第一轮任务' && Boolean(row1) && row1.title === '第二轮任务', `${row0 && row0.title} / ${row1 && row1.title}`);
  ok('在飞那轮是 running，标题 = 正在跑的那句话', Boolean(row2) && row2.state === 'running' && row2.title === '正在跑的第三轮任务', row2 && `${row2.state} ${row2.title}`);
  ok('收工那轮的起止来自会话日志（耗时 60s，不是 0）', Boolean(row1) && row1.duration_ms === 60_000, row1 && String(row1.duration_ms));
  ok('改动文件按轮挂（第 1 轮那条带 highlight.ts）', Boolean(row1) && row1.file_count === 1 && String(row1.files_json).includes('src/highlight.ts'), row1 && `${row1.file_count} ${row1.files_json}`);
  ok('没改文件的那轮不许报文件（读过的文件不算改动）', Boolean(row0) && row0.file_count === 0 && row0.files_json === null, row0 && `${row0.file_count} ${row0.files_json}`);
  ok('模型带上了（Copilot 的来自 VS Code state.vscdb）', Boolean(row1) && row1.model === 'GPT-5 mini', row1 && row1.model);
  ok('在飞 → 成员卡 thinking，心跳指着在飞那条', stateOf('copilot@p1') === 'thinking' && taskIdOf('copilot@p1') === 'copilot:cop-sid-1:2', `${stateOf('copilot@p1')} / ${taskIdOf('copilot@p1')}`);

  console.log('[2] 9F Copilot：在飞那轮收工 → 变 done + 成员卡回落 idle');
  copilotRows = [
    {
      ...copilotRows[0],
      inFlight: false,
      copilotTurns: [...copilotRows[0].copilotTurns, { index: 2, userMessage: '正在跑的第三轮任务', at: liveEnd }],
      liveReqs: [...copilotRows[0].liveReqs, { index: 2, startedAt: liveStart, endedAt: liveEnd }],
    },
  ];
  syncCopilotTasks({ bus, repo });
  const task9 = repo.getTask.get('copilot:cop-sid-1:2');
  ok('那一轮 state=done', Boolean(task9) && task9.state === 'done', task9 && task9.state);
  ok('ended_at 是会话日志给的收工时刻', Boolean(task9) && task9.ended_at === liveEnd, task9 && String(task9.ended_at));
  ok('成员卡回落 idle（不再永远"思考中"）', stateOf('copilot@p1') === 'idle', stateOf('copilot@p1'));

  console.log('[3] 7F Kilo Code：活跃会话 → 台账 + 成员卡思考中');
  const round7Start = Date.now() - 60_000;
  kiloRows = [
    {
      id: 'kilo-sid-1',
      project: 'p1',
      projectPath: '/tmp/p1',
      lastEventAt: Date.now(),
      title: '把 7F 接上台账',
      model: 'kilo-auto/free',
      fileCount: 0,
      rounds: [
        {
          index: 3,
          prompt: '把 7F 接上台账（这一轮）',
          startedAt: round7Start,
          endedAt: null,
          outcome: 'running',
          files: ['/tmp/p1/src/a.js', '/tmp/p1/src/b.js'],
          result: '',
        },
      ],
    },
  ];
  ok('同步器写了 1 条', syncKiloTasks({ bus, repo }) === 1);
  // 台账 id 必须带**轮序号**：一条会话一行那版已经废掉（见 kiloTasks.js 头部的说明），
  // 那条老 id 是本次同步顺手收掉的过渡期残留。
  ok('过渡期那条"一条会话一行"的旧台账被收掉', !repo.getTaskRun.get('kilo:kilo-sid-1'));
  const run7 = repo.getTaskRun.get('kilo:kilo-sid-1:3');
  ok('台账行的 client 是楼层接纳的身份', Boolean(run7) && F7.includes(run7.client), run7 && run7.client);
  const items7 = await get(`project=p1&client=${F7.join(',')}&limit=50`);
  const row7 = items7.find((t) => t.id === 'kilo:kilo-sid-1:3') || null;
  ok('按 7F 楼层筛选能取到这条任务记录', Boolean(row7), JSON.stringify(items7.map((t) => t.id)));
  ok('标题用这一轮用户说的话（不是永远不变的会话标题）', Boolean(row7) && row7.title === '把 7F 接上台账（这一轮）', row7 && row7.title);
  ok('模型信息带上了（Kilo 的 session.model）', Boolean(row7) && row7.model === 'kilo-auto/free', row7 && row7.model);
  ok(
    '改动文件按工程相对路径落库',
    Boolean(row7) && String(row7.files_json) === JSON.stringify(['src/a.js', 'src/b.js']),
    row7 && row7.files_json
  );
  // 起点必须是**那一轮**的起点，不是"第一次见到这条会话"的时刻 —— 这就是 2026-09-30 报的
  // 那个故障（老会话里跑新任务，行还是几天前那条、时间戳被 insertTask 的 COALESCE 钉死）。
  ok('台账起点 = 这一轮的起点（不是会话第一次被看见的时刻）', Boolean(row7) && Number(row7.started_at) === round7Start, row7 && String(row7.started_at));
  ok('活跃会话 → 成员卡 thinking', stateOf('kilo@p1') === 'thinking', stateOf('kilo@p1'));

  console.log('[4] 7F Kilo Code：一轮收工 → 成员卡回落 idle，时长是真的');
  const round7End = Date.now() - 30 * 60_000;
  kiloRows = [
    {
      ...kiloRows[0],
      rounds: [{ ...kiloRows[0].rounds[0], endedAt: round7End, outcome: 'done', result: '已经把 7F 接上了' }],
    },
  ];
  syncKiloTasks({ bus, repo });
  ok('成员卡回落 idle', stateOf('kilo@p1') === 'idle', stateOf('kilo@p1'));
  const done7 = repo.getTask.get('kilo:kilo-sid-1:3');
  ok('那一轮落成 done', Boolean(done7) && done7.state === 'done', done7 && done7.state);
  ok(
    'duration_ms 是这一轮真实的耗时（不再是 0）',
    Boolean(run7) && repo.getTaskRun.get('kilo:kilo-sid-1:3').duration_ms === round7End - round7Start,
    String(repo.getTaskRun.get('kilo:kilo-sid-1:3').duration_ms)
  );
  ok('收工后补上这一轮的收尾自述', repo.getTaskRun.get('kilo:kilo-sid-1:3').result === '已经把 7F 接上了');

  console.log('[4b] 7F Kilo Code：没干完就断了的那一轮 → 已取消（不是完成）');
  // 没有终态 finish 的轮（用户 ESC / 进程没了）在 readKiloRounds 里就判成 cancelled，
  // 同步器照写 —— 不能写 done（明明没干完），也不能留着 running 等 query.js 的 CASE 兜。
  kiloRows = [
    {
      ...kiloRows[0],
      id: 'kilo-sid-cut',
      rounds: [
        { index: 0, prompt: '干一半被打断', startedAt: round7End, endedAt: round7End + 5_000, outcome: 'cancelled', files: [], result: '' },
      ],
    },
  ];
  syncKiloTasks({ bus, repo });
  const cut7 = repo.getTask.get('kilo:kilo-sid-cut:0');
  ok('被打断的那轮记 cancelled', Boolean(cut7) && cut7.state === 'cancelled', cut7 && cut7.state);

  console.log('[5] 同一工程多条会话：在跑的那条不许被判成「已取消」');
  // 回归（2026-09-28 实测）：agent_status 主键是 member_id，一个工程只有一条状态行。
  // 早先每条会话都去写它，谁最后写谁赢 —— 正在跑的那条任务因此在 agent_status 里
  // 找不到对应心跳，任务列表按 query.js 的 CASE 把它算成「已取消」，运行中的任务就没了。
  // 这里故意把"早就停了的那条"排在后面（谁最后写谁赢的写法就会踩中）。
  const r5a = { index: 0, prompt: '在跑的这条', startedAt: round7End + 60_000, endedAt: null, outcome: 'running', files: [], result: '' };
  const r5b = { index: 0, prompt: '早就停了的', startedAt: round7End, endedAt: round7End + 1_000, outcome: 'done', files: [], result: '' };
  kiloRows = [
    { id: 'kilo-sid-active', project: 'p1', projectPath: '/tmp/p1', lastEventAt: Date.now(), title: '在跑的这条', model: 'kilo-auto/free', fileCount: 0, rounds: [r5a] },
    { id: 'kilo-sid-old', project: 'p1', projectPath: '/tmp/p1', lastEventAt: Date.now() - 30 * 60_000, title: '早就停了的', model: '', fileCount: 0, rounds: [r5b] },
  ];
  syncKiloTasks({ bus, repo });
  const seven2 = await get(`project=p1&client=${F7.join(',')}&limit=50`);
  const active7 = seven2.find((t) => t.id === 'kilo:kilo-sid-active:0') || null;
  ok('7F 运行中的任务是 running（不是 cancelled）', Boolean(active7) && active7.state === 'running', active7 && active7.state);
  ok('心跳指着在跑的那条任务', taskIdOf('kilo@p1') === 'kilo:kilo-sid-active:0', taskIdOf('kilo@p1'));

  console.log('[5b] 7F：下一轮开始时，上一轮被定稿（不许永远挂在 running）');
  // 只记"当前这一轮"，所以上一轮的状态是**下一条用户任务来了以后**才补上的。
  // 不补的话它会永远停在 running，被 query.js 的 CASE 判成「已取消」—— 而它其实干完了。
  const r5c = { index: 1, prompt: '又开了一轮', startedAt: r5a.startedAt + 10_000, endedAt: null, outcome: 'running', files: [], result: '' };
  kiloRows = [{ ...kiloRows[0], rounds: [{ ...r5a, endedAt: r5a.startedAt + 5_000, outcome: 'done', result: '上一轮干完了' }, r5c] }];
  ok('同步器写了 2 条（定稿上一轮 + 写当前轮）', syncKiloTasks({ bus, repo }) === 2);
  const prev7 = repo.getTask.get('kilo:kilo-sid-active:0');
  ok('上一轮被定稿成 done', Boolean(prev7) && prev7.state === 'done', prev7 && prev7.state);
  const now7 = repo.getTask.get('kilo:kilo-sid-active:1');
  ok('当前这一轮是 running', Boolean(now7) && now7.state === 'running', now7 && now7.state);
  ok('心跳改指新的一轮', taskIdOf('kilo@p1') === 'kilo:kilo-sid-active:1', taskIdOf('kilo@p1'));

  console.log('[5c] 7F：插件在场就整条让位（会话里已有插件写的行 → 轮询不写自己的行）');
  // 回归（2026-09-30 实测）：判据原先是「这个会话有没有 client === 'kilo-plugin' 的行」，
  // 而插件那份**在修好形态判定之前报的是裸 kilo**（见 plugin/index.js 的 resolveClient）——
  // 于是这个条件从来没命中过，轮询从不让位：同一轮插件与轮询各写一行
  // （实测孪生行同 session、同标题，started_at 只差 5 毫秒）。
  // 现在按 **id 前缀**认：插件写的是服务端发的 `k_*`，轮询写的是 `kilo:*` —— 问的是
  // "这行是不是我写的"，而不是"对方自称是谁"，不再依赖对方身份判得对不对。
  repo.insertTask.run({ id: 'k_plugin_1', projectId: 'p1', memberId: 'kilo-plugin@p1', parentTaskId: null, title: '插件写的那一行', state: 'running', progress: null, startedAt: r5c.startedAt, endedAt: null });
  repo.upsertTaskRun.run({ id: 'k_plugin_1', projectId: 'p1', memberId: 'kilo-plugin@p1', client: 'kilo-plugin', sessionId: 'kilo-sid-active', form: 'plugin', model: null, title: '插件写的那一行', startedAt: r5c.startedAt, baselineCommit: null });
  ok('轮询一条都不写（这个会话已经有插件行）', syncKiloTasks({ bus, repo }) === 0);
  ok(
    '轮询自己此前写的那两行被收掉（不许与插件并存）',
    !repo.getTaskRun.get('kilo:kilo-sid-active:0') && !repo.getTaskRun.get('kilo:kilo-sid-active:1'),
    JSON.stringify([repo.getTaskRun.get('kilo:kilo-sid-active:0'), repo.getTaskRun.get('kilo:kilo-sid-active:1')])
  );
  ok('插件写的那一行纹丝不动（只删自己前缀的 id）', Boolean(repo.getTaskRun.get('k_plugin_1')));

  console.log('[5d] 7F：让位的会话不参与 owner 选择（同工程那条真在跑的不能被判成「已取消」）');
  // 回归（2026-09-30 实测）：owner 是在**全部**会话里选的，而让位那条这一路根本不写心跳 ——
  // 于是让位会话只要更新（插件那条恰恰总是最新的），同工程另一条真在跑的会话就永远选不上
  // owner：它的心跳停在上一刻，任务列表按 query.js 的 CASE 判成「已取消」，运行中的任务
  // 在列表里凭空消失（实测：插件会话一出现，老会话的状态行就冻住不再刷新了）。
  const dRun = { index: 0, prompt: '终端这条在跑', startedAt: Date.now() - 5_000, endedAt: null, outcome: 'running', files: [], result: '' };
  const dPlug = { index: 0, prompt: '插件那条', startedAt: Date.now() - 3_000, endedAt: null, outcome: 'running', files: [], result: '' };
  kiloRows = [
    { id: 'kilo-sid-d-run', project: 'p2', projectPath: '/tmp/p2', lastEventAt: Date.now() - 60_000, title: '终端这条在跑', model: 'kilo-auto/free', fileCount: 0, rounds: [dRun] },
    { id: 'kilo-sid-d-plugin', project: 'p2', projectPath: '/tmp/p2', lastEventAt: Date.now(), title: '插件那条', model: '', fileCount: 0, rounds: [dPlug] },
  ];
  bus.ensureProject('p2', '/tmp/p2', null, 'report'); // 台账行有工程外键，先让工程存在
  repo.insertTask.run({ id: 'k_plugin_d', projectId: 'p2', memberId: 'kilo-plugin@p2', parentTaskId: null, title: '插件那条', state: 'running', progress: null, startedAt: dPlug.startedAt, endedAt: null });
  repo.upsertTaskRun.run({ id: 'k_plugin_d', projectId: 'p2', memberId: 'kilo-plugin@p2', client: 'kilo-plugin', sessionId: 'kilo-sid-d-plugin', form: 'plugin', model: null, title: '插件那条', startedAt: dPlug.startedAt, baselineCommit: null });
  // stateOf / taskIdOf 那两个小工具是给 p1 写死的，这里问的是 p2 的成员卡
  const cardP2 = () => (bus.buildSnapshot('p2').members.find((x) => x.memberId === 'kilo@p2') || {});
  const hbP2 = () => (cardP2().task && cardP2().task.id) || '';
  ok('让位那条不写轮询行，同工程另一条照写', syncKiloTasks({ bus, repo }) === 1);
  ok('同工程在跑的那条照样拿得到心跳', hbP2() === 'kilo:kilo-sid-d-run:0', hbP2());
  const two2 = await get(`project=p2&client=${F7.join(',')}&limit=50`);
  const runD = two2.find((t) => t.id === 'kilo:kilo-sid-d-run:0') || null;
  ok('它在任务列表里是 running（没被判成「已取消」）', Boolean(runD) && runD.state === 'running', runD && runD.state);

  console.log('[5d-2] 7F：插件冒我们这个身份在报（CLI 形态）且那轮没完 → 成员状态整栏让给它');
  // `kilo run` 里的插件报的是裸 `kilo`（同一个成员 kilo@工程，见 plugin/index.js 的
  // resolveClient）—— 插件与轮询写的是同一条 agent_status，谁最后写谁赢。轮询 5s 一次，
  // 不让开就会把插件刚写的相位覆盖成自己那份旧状态（现场：相位在两个值之间来回跳）。
  repo.upsertTaskRun.run({ id: 'k_plugin_d', projectId: 'p2', memberId: 'kilo@p2', client: 'kilo', sessionId: 'kilo-sid-d-plugin', form: 'cli', model: null, title: '插件那条', startedAt: dPlug.startedAt, baselineCommit: null });
  repo.upsertStatus.run({ memberId: 'kilo@p2', state: 'blocked', stateSince: 1, taskId: 'k_plugin_d', progress: null, currentFiles: null, lastHeartbeatAt: Date.now(), degraded: 0, source: 'report', updatedAt: Date.now() });
  syncKiloTasks({ bus, repo });
  ok('插件那份状态没被轮询覆盖', cardP2().state === 'blocked', cardP2().state);
  // 插件那条收工后（不再有在飞的轮）这一栏交回轮询 —— 否则同工程别的会话永远没有心跳
  dPlug.endedAt = dPlug.startedAt + 1_000;
  dPlug.outcome = 'done';
  syncKiloTasks({ bus, repo });
  ok('插件那轮收工后，心跳交回轮询', hbP2() === 'kilo:kilo-sid-d-run:0', hbP2());

  console.log('[5e] 7F：源里已经没有的那几轮被收掉（别再挂在 running 上冒充「已取消」）');
  // 轮次表缩短时（Kilo 清了消息 / 压过上下文），比最后一轮靠后的行永远等不到自己的轮，
  // 会一直挂在 'running' —— 任务列表按 query.js 的 CASE 显示成「已取消」，成了一条假任务。
  const cutA = { index: 0, prompt: '第一轮', startedAt: Date.now() - 60_000, endedAt: Date.now() - 50_000, outcome: 'done', files: [], result: '' };
  const cutB = { index: 1, prompt: '第二轮', startedAt: Date.now() - 40_000, endedAt: Date.now() - 30_000, outcome: 'done', files: [], result: '' };
  const cutC = { index: 2, prompt: '第三轮', startedAt: Date.now() - 20_000, endedAt: null, outcome: 'running', files: [], result: '' };
  kiloRows = [{ id: 'kilo-sid-cut2', project: 'p2', projectPath: '/tmp/p2', lastEventAt: Date.now(), title: '第三轮', model: '', fileCount: 0, rounds: [cutA, cutB, cutC] }];
  syncKiloTasks({ bus, repo });
  ok('最后一轮写下了', Boolean(repo.getTaskRun.get('kilo:kilo-sid-cut2:2')));
  // 源里只剩两轮了（第三轮被清掉）
  kiloRows = [{ ...kiloRows[0], rounds: [cutA, cutB] }];
  syncKiloTasks({ bus, repo });
  ok('比最后一轮靠后的那一行被收掉', !repo.getTaskRun.get('kilo:kilo-sid-cut2:2'), JSON.stringify(repo.getTaskRun.get('kilo:kilo-sid-cut2:2')));
  ok('新的最后一轮顶上来了', Boolean(repo.getTaskRun.get('kilo:kilo-sid-cut2:1')));

  console.log('[5f] 7F：插件通道断了 → 把会话收回来，别让用户跑的轮次凭空消失');
  // 回归（2026-09-30 用户实测）：Kilo CLI 进程 11:00 起（那一版插件还没有"重读 server.json"），
  // WorkGremlin 11:29 重启换了随机 token（config.js 每次启动随机生成）→ 那个进程里插件的每条
  // 上报都 401 且完全无声：状态文件照写（相位正常）、台账一条不来；而轮询这一路只要看到
  // "这个会话有插件行"就整条让位 → 用户 12:46 / 12:48 跑的两轮**两条都查不到**。
  // 让位现在要求"插件**这一轮**也写了"：它最新一行比源里最新一轮还旧 + 过了宽限期 → 收回来。
  const deadPlugRow = Date.now() - 20 * 60_000; // 插件最后报到的那一轮（20 分钟前）
  const deadA = { index: 0, prompt: '插件报过的那轮', startedAt: deadPlugRow, endedAt: deadPlugRow + 30_000, outcome: 'done', files: [], result: '做完了' };
  const deadB = { index: 1, prompt: '断线后第一轮', startedAt: Date.now() - 8 * 60_000, endedAt: Date.now() - 7 * 60_000, outcome: 'cancelled', files: [], result: '' };
  const deadC = { index: 2, prompt: '断线后第二轮', startedAt: Date.now() - 5 * 60_000, endedAt: null, outcome: 'running', files: [], result: '' };
  kiloRows = [{ id: 'kilo-sid-dead', project: 'p1', projectPath: '/tmp/p1', lastEventAt: Date.now() - 4 * 60_000, title: '断线后第二轮', model: '', fileCount: 0, rounds: [deadA, deadB, deadC] }];
  repo.insertTask.run({ id: 'k_plugin_dead', projectId: 'p1', memberId: 'kilo-plugin@p1', parentTaskId: null, title: '插件报过的那轮', state: 'done', progress: 1, startedAt: deadPlugRow, endedAt: deadPlugRow + 30_000 });
  repo.upsertTaskRun.run({ id: 'k_plugin_dead', projectId: 'p1', memberId: 'kilo-plugin@p1', client: 'kilo-plugin', sessionId: 'kilo-sid-dead', form: 'plugin', model: null, title: '插件报过的那轮', startedAt: deadPlugRow, baselineCommit: null });
  ok('通道断了就收回来：这一轮写下了', syncKiloTasks({ bus, repo }) >= 1 && Boolean(repo.getTaskRun.get('kilo:kilo-sid-dead:2')));
  ok('插件断线期间漏掉的那一轮也补上（②b）', Boolean(repo.getTaskRun.get('kilo:kilo-sid-dead:1')), JSON.stringify(repo.getTaskRun.get('kilo:kilo-sid-dead:1')));
  ok('插件自己报过的那一轮不重复写（它已经有行了）', !repo.getTaskRun.get('kilo:kilo-sid-dead:0'));
  ok('插件那行纹丝不动', Boolean(repo.getTaskRun.get('k_plugin_dead')));
  const deadList = await get(`project=p1&client=${F7.join(',')}&limit=50`);
  ok('任务列表里真的看得到（用户报的就是"看不到任务"）',
    Boolean(deadList.find((t) => t.id === 'kilo:kilo-sid-dead:1')) && Boolean(deadList.find((t) => t.id === 'kilo:kilo-sid-dead:2')),
    JSON.stringify(deadList.filter((t) => String(t.id).includes('kilo-sid-dead')).map((t) => [t.id, t.state])));

  console.log('[5f-2] 7F：插件只是慢了（这一轮刚起、还没过宽限期）→ 照旧让位，不抢');
  // 宽限期量的是"这一轮开跑到现在"（插件本地回环，正常 1 秒内就落库），不是"插件沉默多久"：
  // 插件两轮之间本来就不写东西，沉默是常态，拿沉默当死会把正常会话全抢过来。
  const slowPlug = Date.now() - 3 * 60_000;
  const slowA = { index: 0, prompt: '插件那条', startedAt: slowPlug, endedAt: null, outcome: 'running', files: [], result: '' };
  const slowB = { index: 1, prompt: '刚起的一轮', startedAt: Date.now() - 1_000, endedAt: null, outcome: 'running', files: [], result: '' };
  kiloRows = [{ id: 'kilo-sid-slow', project: 'p1', projectPath: '/tmp/p1', lastEventAt: Date.now(), title: '刚起的一轮', model: '', fileCount: 0, rounds: [slowA, slowB] }];
  repo.insertTask.run({ id: 'k_plugin_slow', projectId: 'p1', memberId: 'kilo@p1', parentTaskId: null, title: '插件那条', state: 'running', progress: null, startedAt: slowPlug, endedAt: null });
  repo.upsertTaskRun.run({ id: 'k_plugin_slow', projectId: 'p1', memberId: 'kilo@p1', client: 'kilo', sessionId: 'kilo-sid-slow', form: 'cli', model: null, title: '插件那条', startedAt: slowPlug, baselineCommit: null });
  ok('还在宽限期里 → 一条都不写（插件那 1 秒内就会补上自己的行）', syncKiloTasks({ bus, repo }) === 0);

  console.log('[5f-3] 7F：插件沉默了两个多小时 + 这一轮刚起 → 宽限期一过就收回来，别让整轮都看不见');
  // 回归（2026-09-30 用户实测）：「输入 Prompt 后没看到任务，任务结束后一会才看到任务记录」。
  // 那条会话的插件早就哑了（最后一次上报是 11:02，进程 11:00 起、之后 token 换过），
  // 13:42:44 起的那一轮 **8 秒就结束了**（13:42:52），而宽限期按 60 秒算是**从这一轮起点**
  // 起算的 —— 整轮都在宽限期里，轮询一行都不写（用户看着任务跑完、又等了 52 秒才看到那行）。
  // 现在宽限期 3 秒：这一轮还在跑（8 秒）的时候行就写下去了。
  const stalePlug = Date.now() - 160 * 60_000; // 插件最后报到的那一轮（两个多小时前）
  const sT0 = { index: 0, prompt: '插件报过的老轮', startedAt: stalePlug, endedAt: stalePlug + 30_000, outcome: 'done', files: [], result: '做完了' };
  const sT1 = { index: 1, prompt: '刚起的这一轮', startedAt: Date.now() - 8_000, endedAt: null, outcome: 'running', files: [], result: '' };
  kiloRows = [{ id: 'kilo-sid-stale', project: 'p1', projectPath: '/tmp/p1', lastEventAt: Date.now() - 7_000, title: '刚起的这一轮', model: '', fileCount: 0, rounds: [sT0, sT1] }];
  repo.insertTask.run({ id: 'k_plugin_stale', projectId: 'p1', memberId: 'kilo@p1', parentTaskId: null, title: '插件报过的老轮', state: 'done', progress: 1, startedAt: stalePlug, endedAt: stalePlug + 30_000 });
  repo.upsertTaskRun.run({ id: 'k_plugin_stale', projectId: 'p1', memberId: 'kilo@p1', client: 'kilo', sessionId: 'kilo-sid-stale', form: 'cli', model: null, title: '插件报过的老轮', startedAt: stalePlug, baselineCommit: null });
  const staleWrote = syncKiloTasks({ bus, repo });
  ok('这一轮还在跑的时候就把行写下了（宽限期只有 3 秒）', staleWrote === 1 && Boolean(repo.getTaskRun.get('kilo:kilo-sid-stale:1')), `${staleWrote} / ${JSON.stringify(repo.getTaskRun.get('kilo:kilo-sid-stale:1'))}`);
  const staleList = await get(`project=p1&client=${F7.join(',')}&limit=50`);
  const stale = staleList.find((t) => t.id === 'kilo:kilo-sid-stale:1') || null;
  ok('任务列表里看得到，而且是 running（不是等收工后才冒出来）', Boolean(stale) && stale.state === 'running', stale && stale.state);
  ok('插件报过的老轮不重复写（按轮次起点对齐认"这一轮它报过没有"）', !repo.getTaskRun.get('kilo:kilo-sid-stale:0'));

  console.log('[5f-4] 7F：插件那行比轮次起点早了几十毫秒 → 照样算"这一轮它报过"，不许并排多写一条');
  // 回归：插件记的是它**看到消息**的时刻，轮次表记的是消息**落库**的时刻，实测差 ±90ms 且
  // 方向不定（+34 / -87 / -14ms）。判据若写成"插件最新一行比这一轮起点新"，插件先落 87 毫秒
  // 那条会话就会在宽限期后被我抢过来 → 同一轮两行（孪生行，而且它自己好不了：越判越不像）。
  const twinStart = Date.now() - 120_000; // 这一轮早已过了宽限期（老口径下必被抢）
  const twinRound = { index: 0, prompt: '插件先落的那一轮', startedAt: twinStart, endedAt: null, outcome: 'running', files: [], result: '' };
  kiloRows = [{ id: 'kilo-sid-twin', project: 'p1', projectPath: '/tmp/p1', lastEventAt: Date.now(), title: '插件先落的那一轮', model: '', fileCount: 0, rounds: [twinRound] }];
  repo.insertTask.run({ id: 'k_plugin_twin', projectId: 'p1', memberId: 'kilo@p1', parentTaskId: null, title: '插件先落的那一轮', state: 'running', progress: null, startedAt: twinStart - 87, endedAt: null });
  repo.upsertTaskRun.run({ id: 'k_plugin_twin', projectId: 'p1', memberId: 'kilo@p1', client: 'kilo', sessionId: 'kilo-sid-twin', form: 'cli', model: null, title: '插件先落的那一轮', startedAt: twinStart - 87, baselineCommit: null });
  ok('轮询一条都不写（这一轮插件报过，早 87 毫秒也算）', syncKiloTasks({ bus, repo }) === 0, JSON.stringify(repo.getTaskRun.get('kilo:kilo-sid-twin:0')));

  console.log('[6] 9F：会话行说「在飞」→ 只有那一轮是 running（不受 2 分钟窗口影响）');
  // Copilot 自己的库整轮写完才落盘，只看 updated_at 会出现"跑着显示待命、跑完显示思考中"。
  // sessions.js 从 VS Code 的 chat 索引 / 会话日志读出「这一轮在不在飞」并挂在会话行上
  // （inFlight + livePrompt/liveIndex），同步器必须听它：下面这条 lastUpdated 是半小时前的。
  const liveStart2 = Date.now() - 3000;
  copilotRows = [
    {
      id: 'cop-sid-live',
      copilot: true,
      project: 'p1',
      projectPath: '/tmp/p1',
      lastUpdated: Date.now() - 30 * 60_000,
      inFlight: true,
      doneTitle: '会话标题',
      prompt: '上一轮',
      copilotTurns: [{ index: 0, userMessage: '半小时前那轮', at: Date.now() - 30 * 60_000 }],
      livePrompt: '正在跑的这轮',
      liveStartedAt: liveStart2,
      liveIndex: 1,
      liveReqs: [],
      files: { count: 0, recent: [] },
    },
  ];
  syncCopilotTasks({ bus, repo });
  const nine2 = await get(`project=p1&client=${F9.join(',')}&limit=50`);
  const old9 = nine2.find((t) => t.id === 'copilot:cop-sid-live:0') || null;
  const live9 = nine2.find((t) => t.id === 'copilot:cop-sid-live:1') || null;
  ok('老轮躺成 done', Boolean(old9) && old9.state === 'done', old9 && old9.state);
  ok('在飞那轮 running（lastUpdated 半小时前也不影响）', Boolean(live9) && live9.state === 'running', live9 && live9.state);
  ok('成员卡 thinking', stateOf('copilot@p1') === 'thinking', stateOf('copilot@p1'));
  ok('心跳指着在跑的那条任务', taskIdOf('copilot@p1') === 'copilot:cop-sid-live:1', taskIdOf('copilot@p1'));

  copilotRows = [
    {
      ...copilotRows[0],
      inFlight: false,
      copilotTurns: [...copilotRows[0].copilotTurns, { index: 1, userMessage: '正在跑的这轮', at: Date.now() }],
      liveReqs: [{ index: 1, startedAt: liveStart2, endedAt: Date.now() }],
    },
  ];
  syncCopilotTasks({ bus, repo });
  const nine3 = await get(`project=p1&client=${F9.join(',')}&limit=50`);
  const done9 = nine3.find((t) => t.id === 'copilot:cop-sid-live:1') || null;
  ok('收工后那一轮 done / 成员卡 idle', Boolean(done9) && done9.state === 'done' && stateOf('copilot@p1') === 'idle', `${done9 && done9.state}/${stateOf('copilot@p1')}`);

  console.log('[7] 8F OpenCode：每一轮一条台账（在飞那轮 running）+ 改动文件只认 edit');
  const o0 = Date.now() - 20 * 60_000;
  const o1 = Date.now() - 15 * 60_000;
  const o2 = Date.now() - 30_000;
  const F8 = clientsOf('8F');
  opencodeRows = [
    {
      id: 'oc-sid-1',
      project: 'p1',
      projectPath: '/tmp/p1',
      title: '会话标题',
      model: 'longcat-2.5-preview-free',
      lastEventAt: o2,
      turns: [
        { index: 0, prompt: '第一轮（8F）', startedAt: o0, endedAt: o1, files: ['/tmp/p1/server/src/a.js'], result: '第一轮的收尾自述' },
        { index: 1, prompt: '正在跑的第二轮', startedAt: o2, endedAt: null, files: [] },
      ],
    },
  ];
  ok('同步器写了 2 条（每轮一条）', syncOpencodeTasks({ bus, repo }) === 2);
  ok('8F 接纳 opencode', F8.includes('opencode'), F8.join(','));
  const eight = await get(`project=p1&client=${F8.join(',')}&limit=50`);
  const oc0 = eight.find((t) => t.id === 'opencode:oc-sid-1:0') || null;
  const oc1 = eight.find((t) => t.id === 'opencode:oc-sid-1:1') || null;
  ok('两轮都按 8F 楼层筛选取得到', Boolean(oc0) && Boolean(oc1), JSON.stringify(eight.map((t) => t.id)));
  ok('标题 = 那一轮用户原话', Boolean(oc0) && oc0.title === '第一轮（8F）' && Boolean(oc1) && oc1.title === '正在跑的第二轮', `${oc0 && oc0.title} / ${oc1 && oc1.title}`);
  ok('在飞那轮 running、收工那轮 done', Boolean(oc1) && oc1.state === 'running' && Boolean(oc0) && oc0.state === 'done', `${oc1 && oc1.state}/${oc0 && oc0.state}`);
  ok('改动文件来自 edit 工具并转成工程相对路径', Boolean(oc0) && oc0.file_count === 1 && String(oc0.files_json) === JSON.stringify(['server/src/a.js']), oc0 && `${oc0.file_count} ${oc0.files_json}`);
  ok('产出摘要（result）带上了', Boolean(oc0) && oc0.result === '第一轮的收尾自述', oc0 && oc0.result);
  ok('还在跑的那轮不写产出摘要（半截话不算）', Boolean(oc1) && !oc1.result, oc1 && oc1.result);
  ok('模型带上了（OpenCode 的 session.model）', Boolean(oc0) && oc0.model === 'longcat-2.5-preview-free', oc0 && oc0.model);
  ok('在飞 → 成员卡 thinking，心跳指着在飞那条', stateOf('opencode@p1') === 'thinking' && taskIdOf('opencode@p1') === 'opencode:oc-sid-1:1', `${stateOf('opencode@p1')} / ${taskIdOf('opencode@p1')}`);

  opencodeRows = [
    {
      ...opencodeRows[0],
      turns: [opencodeRows[0].turns[0], { ...opencodeRows[0].turns[1], endedAt: Date.now() }],
    },
  ];
  syncOpencodeTasks({ bus, repo });
  const eight2 = await get(`project=p1&client=${F8.join(',')}&limit=50`);
  const done8 = eight2.find((t) => t.id === 'opencode:oc-sid-1:1') || null;
  ok('收工后那一轮 done / 成员卡 idle', Boolean(done8) && done8.state === 'done' && stateOf('opencode@p1') === 'idle', `${done8 && done8.state}/${stateOf('opencode@p1')}`);

  // 被终止的一轮：OpenCode 的 idle 行写 outcome=interrupted —— 台账要记「已取消」，不是「完成」
  // （回归 2026-09-28：用户终止了一轮，台账却报「完成」）
  opencodeRows = [
    {
      ...opencodeRows[0],
      turns: [opencodeRows[0].turns[0], { ...opencodeRows[0].turns[1], endedAt: Date.now(), outcome: 'interrupted' }],
    },
  ];
  syncOpencodeTasks({ bus, repo });
  const eightInterrupted = await get(`project=p1&client=${F8.join(',')}&limit=50`);
  const cancel8 = eightInterrupted.find((t) => t.id === 'opencode:oc-sid-1:1') || null;
  ok('被终止（idle.outcome=interrupted）的那轮记「已取消」，不是「完成」', Boolean(cancel8) && cancel8.state === 'cancelled', cancel8 && cancel8.state);

  // 装了 WorkGremlin 插件时让位（插件那一路上报的才是真值）
  repo.insertTask.run({ id: 't_oc_plugin', projectId: 'p1', memberId: 'opencode@p1', parentTaskId: null, title: '插件那一路', state: 'done', progress: 1, startedAt: o2, endedAt: o2 + 1000 });
  repo.upsertTaskRun.run({ id: 't_oc_plugin', projectId: 'p1', memberId: 'opencode@p1', client: 'opencode-plugin', sessionId: 'oc-sid-1', form: 'plugin', model: 'x', title: '插件那一路', startedAt: o2, baselineCommit: null });
  syncOpencodeTasks({ bus, repo });
  const eight3 = await get(`project=p1&client=${F8.join(',')}&limit=50`);
  ok(
    '插件上报过这条会话 → 轮询兜底整条让位（自己的行收掉，插件的行留着）',
    !eight3.some((t) => String(t.id).startsWith('opencode:oc-sid-1:')) && eight3.some((t) => t.id === 't_oc_plugin'),
    JSON.stringify(eight3.map((t) => [t.id, t.client]))
  );

  // ---- 8F 与 7F 统一口径（2026-09-30）：让位只在插件**还在报**的时候成立 ----
  console.log('[7b] 8F：让位的会话不参与 owner 选择（同工程那条真在跑的不能被判成「已取消」）');
  // 同 kiloTasks.js [5d]：owner 若在**全部**会话里选，让位那条（它这一路不写心跳）只要更新
  // 就会把同工程真在跑的那条挤掉 —— 那条任务在 agent_status 里找不到心跳，被判成「已取消」。
  const yhTurn = { index: 0, prompt: '插件那条', startedAt: Date.now() - 3_000, endedAt: null, files: [] };
  const yrTurn = { index: 0, prompt: '终端这条在跑', startedAt: Date.now() - 5_000, endedAt: null, files: [] };
  opencodeRows = [
    { id: 'oc-sid-y-held', project: 'p1', projectPath: '/tmp/p1', title: '插件那条', model: '', lastEventAt: Date.now(), turns: [yhTurn] },
    { id: 'oc-sid-y-run', project: 'p1', projectPath: '/tmp/p1', title: '终端这条在跑', model: '', lastEventAt: Date.now() - 60_000, turns: [yrTurn] },
  ];
  repo.insertTask.run({ id: 't_oc_held', projectId: 'p1', memberId: 'opencode@p1', parentTaskId: null, title: '插件那条', state: 'running', progress: null, startedAt: yhTurn.startedAt, endedAt: null });
  repo.upsertTaskRun.run({ id: 't_oc_held', projectId: 'p1', memberId: 'opencode@p1', client: 'opencode-plugin', sessionId: 'oc-sid-y-held', form: 'plugin', model: null, title: '插件那条', startedAt: yhTurn.startedAt, baselineCommit: null });
  ok('让位那条不写轮询行，同工程另一条照写', syncOpencodeTasks({ bus, repo }) === 1);
  ok('同工程在跑的那条照样拿得到心跳', taskIdOf('opencode@p1') === 'opencode:oc-sid-y-run:0', taskIdOf('opencode@p1'));
  const eightB = await get(`project=p1&client=${F8.join(',')}&limit=50`);
  const runY = eightB.find((t) => t.id === 'opencode:oc-sid-y-run:0') || null;
  ok('它在任务列表里是 running（没被判成「已取消」）', Boolean(runY) && runY.state === 'running', runY && runY.state);

  console.log('[7c] 8F：插件通道断了 → 把会话收回来（同 7F 的 ②b）');
  // 回归（2026-09-30）：插件写的行只证明它**曾经**在报。它跟 agent 进程活，通道断了
  // （服务端重启换随机 token）时两路都不写 → 用户跑的轮次凭空消失。
  // 让位现在要求"插件**这一轮**也写了"：它最新一行比源里最新一轮还旧 + 过了宽限期 → 收回来。
  const deadRow = Date.now() - 20 * 60_000; // 插件最后报到的那一轮（20 分钟前）
  const dT0 = { index: 0, prompt: '插件报过的那轮', startedAt: deadRow, endedAt: deadRow + 30_000, files: [], result: '做完了' };
  const dT1 = { index: 1, prompt: '断线后第一轮', startedAt: Date.now() - 8 * 60_000, endedAt: Date.now() - 7 * 60_000, outcome: 'interrupted', files: [] };
  const dT2 = { index: 2, prompt: '断线后第二轮', startedAt: Date.now() - 5 * 60_000, endedAt: null, files: [] };
  opencodeRows = [{ id: 'oc-sid-dead', project: 'p1', projectPath: '/tmp/p1', title: '断线后第二轮', model: '', lastEventAt: Date.now() - 4 * 60_000, turns: [dT0, dT1, dT2] }];
  repo.insertTask.run({ id: 't_oc_dead', projectId: 'p1', memberId: 'opencode@p1', parentTaskId: null, title: '插件报过的那轮', state: 'done', progress: 1, startedAt: deadRow, endedAt: deadRow + 30_000 });
  repo.upsertTaskRun.run({ id: 't_oc_dead', projectId: 'p1', memberId: 'opencode@p1', client: 'opencode', sessionId: 'oc-sid-dead', form: 'cli', model: null, title: '插件报过的那轮', startedAt: deadRow, baselineCommit: null });
  ok(
    '通道断了就收回来：断线之后那两轮都补上了',
    syncOpencodeTasks({ bus, repo }) === 2 && Boolean(repo.getTaskRun.get('opencode:oc-sid-dead:1')) && Boolean(repo.getTaskRun.get('opencode:oc-sid-dead:2'))
  );
  ok('插件自己报过的那一轮不重复写（它已经有行了）', !repo.getTaskRun.get('opencode:oc-sid-dead:0'));
  ok('插件那行纹丝不动', Boolean(repo.getTaskRun.get('t_oc_dead')));
  const eightC = await get(`project=p1&client=${F8.join(',')}&limit=50`);
  ok(
    '任务列表里真的看得到（用户报的就是"看不到任务"）',
    Boolean(eightC.find((t) => t.id === 'opencode:oc-sid-dead:1')) && Boolean(eightC.find((t) => t.id === 'opencode:oc-sid-dead:2')),
    JSON.stringify(eightC.filter((t) => String(t.id).includes('oc-sid-dead')).map((t) => [t.id, t.state]))
  );

  console.log('[7d] 8F：源里已经没有的那几轮被收掉（同 7F 的 ③b）');
  // 轮次表缩短时（OpenCode 清了消息 / 压过上下文），比最后一轮靠后的行永远等不到自己的轮，
  // 会一直挂在 'running' —— 任务列表按 query.js 的 CASE 显示成「已取消」，成了一条假任务。
  const cutT = (i, endAgo, startAgo) => ({ index: i, prompt: `第${i}轮`, startedAt: Date.now() - startAgo, endedAt: endAgo === null ? null : Date.now() - endAgo, files: [] });
  opencodeRows = [{ id: 'oc-sid-cut', project: 'p1', projectPath: '/tmp/p1', title: '第三轮', model: '', lastEventAt: Date.now(), turns: [cutT(0, 50_000, 60_000), cutT(1, 30_000, 40_000), cutT(2, null, 20_000)] }];
  syncOpencodeTasks({ bus, repo });
  ok('最后一轮写下了', Boolean(repo.getTaskRun.get('opencode:oc-sid-cut:2')));
  const cutTurn = opencodeRows[0].turns.slice(0, 2); // 源里只剩两轮（第三轮被清掉）
  opencodeRows = [{ ...opencodeRows[0], turns: cutTurn }];
  syncOpencodeTasks({ bus, repo });
  ok('比最后一轮靠后的那一行被收掉', !repo.getTaskRun.get('opencode:oc-sid-cut:2'), JSON.stringify(repo.getTaskRun.get('opencode:oc-sid-cut:2')));
  ok('新的最后一轮顶上来了', Boolean(repo.getTaskRun.get('opencode:oc-sid-cut:1')));

  console.log('[7e] 8F：插件只是慢了（这一轮刚起、还没过宽限期）→ 照旧让位，不抢');
  // 与 7F 的 [5f-2] 同口径：宽限期量的是"这一轮开跑到现在"，不是"插件沉默多久"。
  const graPlug = Date.now() - 3 * 60_000;
  opencodeRows = [
    {
      id: 'oc-sid-grace',
      project: 'p1',
      projectPath: '/tmp/p1',
      title: '刚起的一轮',
      model: '',
      lastEventAt: Date.now(),
      turns: [
        { index: 0, prompt: '插件那条', startedAt: graPlug, endedAt: null, files: [] },
        { index: 1, prompt: '刚起的一轮', startedAt: Date.now() - 1_000, endedAt: null, files: [] },
      ],
    },
  ];
  repo.insertTask.run({ id: 't_oc_grace', projectId: 'p1', memberId: 'opencode@p1', parentTaskId: null, title: '插件那条', state: 'running', progress: null, startedAt: graPlug, endedAt: null });
  repo.upsertTaskRun.run({ id: 't_oc_grace', projectId: 'p1', memberId: 'opencode@p1', client: 'opencode', sessionId: 'oc-sid-grace', form: 'cli', model: null, title: '插件那条', startedAt: graPlug, baselineCommit: null });
  ok('还在宽限期里 → 一条都不写（插件那 1 秒内就会补上自己的行）', syncOpencodeTasks({ bus, repo }) === 0);

  console.log('[7f] 8F：插件沉默了两个多小时 + 这一轮刚起 → 宽限期一过就收回来（同 7F 的 [5f-3]）');
  const ocStale = Date.now() - 160 * 60_000;
  opencodeRows = [
    {
      id: 'oc-sid-stale',
      project: 'p1',
      projectPath: '/tmp/p1',
      title: '刚起的这一轮',
      model: '',
      lastEventAt: Date.now() - 7_000,
      turns: [
        { index: 0, prompt: '插件报过的老轮', startedAt: ocStale, endedAt: ocStale + 30_000, files: [], result: '做完了' },
        { index: 1, prompt: '刚起的这一轮', startedAt: Date.now() - 8_000, endedAt: null, files: [] },
      ],
    },
  ];
  repo.insertTask.run({ id: 't_oc_stale', projectId: 'p1', memberId: 'opencode@p1', parentTaskId: null, title: '插件报过的老轮', state: 'done', progress: 1, startedAt: ocStale, endedAt: ocStale + 30_000 });
  repo.upsertTaskRun.run({ id: 't_oc_stale', projectId: 'p1', memberId: 'opencode@p1', client: 'opencode', sessionId: 'oc-sid-stale', form: 'cli', model: null, title: '插件报过的老轮', startedAt: ocStale, baselineCommit: null });
  const ocStaleWrote = syncOpencodeTasks({ bus, repo });
  ok('这一轮还在跑的时候就把行写下了（宽限期只有 3 秒）', ocStaleWrote === 1 && Boolean(repo.getTaskRun.get('opencode:oc-sid-stale:1')), `${ocStaleWrote} / ${JSON.stringify(repo.getTaskRun.get('opencode:oc-sid-stale:1'))}`);
  ok('插件报过的老轮不重复写（按轮次起点对齐认"这一轮它报过没有"）', !repo.getTaskRun.get('opencode:oc-sid-stale:0'));

  console.log('[7g] 8F：插件那行比轮次起点早了几十毫秒 → 照样算"这一轮它报过"（同 7F 的 [5f-4]）');
  const ocTwinStart = Date.now() - 120_000; // 这一轮早已过了宽限期（老口径下必被抢）
  opencodeRows = [
    {
      id: 'oc-sid-twin',
      project: 'p1',
      projectPath: '/tmp/p1',
      title: '插件先落的那一轮',
      model: '',
      lastEventAt: Date.now(),
      turns: [{ index: 0, prompt: '插件先落的那一轮', startedAt: ocTwinStart, endedAt: null, files: [] }],
    },
  ];
  repo.insertTask.run({ id: 't_oc_twin', projectId: 'p1', memberId: 'opencode@p1', parentTaskId: null, title: '插件先落的那一轮', state: 'running', progress: null, startedAt: ocTwinStart - 87, endedAt: null });
  repo.upsertTaskRun.run({ id: 't_oc_twin', projectId: 'p1', memberId: 'opencode@p1', client: 'opencode', sessionId: 'oc-sid-twin', form: 'cli', model: null, title: '插件先落的那一轮', startedAt: ocTwinStart - 87, baselineCommit: null });
  ok('轮询一条都不写（这一轮插件报过，早 87 毫秒也算）', syncOpencodeTasks({ bus, repo }) === 0, JSON.stringify(repo.getTaskRun.get('opencode:oc-sid-twin:0')));

  console.log('[8] 9F：别的楼层的会话不许被写成 Copilot 台账（打开 VS Code 就冒「(Copilot 会话)」的根因）');
  // 回归（2026-09-30 用户实测）：9F 同步器原来用 listSessions 的**默认** PLUGIN_RE 去要会话清单，
  // 那一串里含 `/^tencent/` 与 `/coding-copilot/i` —— 本机上命中 Tencent CodeBuddy 的
  // `tencent-cloud.coding-copilot` 目录。于是 1F 正在跑的会话被写成了 9F 的任务：
  // 用户根本没在 Copilot Chat 里输入，打开 VS Code 任务记录里就多一条「(Copilot 会话)」在飞行；
  // 而且那条行永远收不了工（收工靠 Copilot 自己的 turns 表，别的产品的会话在它表里没有）。
  const GSR = path.join(HOME, '.config', 'Code', 'User', 'globalStorage');
  const TEN = path.join(GSR, 'tencent-cloud.coding-copilot');
  const cbSid = 'cb-session-phantom';
  const cbProj = path.join(TEN, 'genie-history', Buffer.from('/tmp/ProjCB').toString('base64'));
  fs.mkdirSync(path.join(cbProj, 'conversations', cbSid), { recursive: true });
  fs.writeFileSync(path.join(cbProj, 'current.json'), JSON.stringify({ conversationId: cbSid, lastUpdated: new Date().toISOString() }));
  fs.mkdirSync(path.join(TEN, 'todos'), { recursive: true });
  fs.writeFileSync(path.join(TEN, 'todos', `${cbSid}.json`), JSON.stringify({ todos: [{ status: 'in_progress', content: '别的楼层正在跑' }] }));
  fs.mkdirSync(path.join(TEN, 'file-changes', cbSid), { recursive: true });

  // 先证明事故现场：共享 PLUGIN_RE 确实把这条会话扫得出来（不锁 pluginRe 就是这个后果）
  const unionSnap = realListSessions({ force: true, client: 'copilot-plugin' });
  ok('前置：共享 PLUGIN_RE 会把 Tencent 目录里正在跑的会话当 Copilot 扫出来（事故现场）', unionSnap.sessions.some((s) => s.id === cbSid), unionSnap.storage);
  const scopedSnap = realListSessions({ force: true, client: 'copilot-plugin', pluginRe: RE_GITHUB_COPILOT });
  ok('9F 自己的 pluginRe 不会把别的产品的落盘当自己的', !scopedSnap.sessions.some((s) => s.id === cbSid), scopedSnap.storage);

  // 上一版留下的错行：同步器写的在飞记录（那条会话永远等不到收工）
  repo.insertTask.run({ id: `copilot:${cbSid}:0`, projectId: 'p1', memberId: 'copilot@p1', parentTaskId: null, title: '(Copilot 会话)', state: 'running', progress: null, startedAt: Date.now() - 60_000, endedAt: null });
  repo.upsertTaskRun.run({ id: `copilot:${cbSid}:0`, projectId: 'p1', memberId: 'copilot@p1', client: 'copilot-plugin', sessionId: cbSid, form: null, model: null, title: '(Copilot 会话)', startedAt: Date.now() - 60_000, baselineCommit: null });

  scanReal = true;
  const phantomWrote = syncCopilotTasks({ bus, repo });
  scanReal = false;
  ok('同步器要按 9F 自己的 pluginRe 要清单（不再吃默认的共享 PLUGIN_RE）', lastScanOpts && lastScanOpts.pluginRe === RE_GITHUB_COPILOT, JSON.stringify(lastScanOpts && lastScanOpts.pluginRe));
  ok('别的楼层正在跑的会话不会再被写成 9F 台账', phantomWrote === 0 && !repo.getTaskRun.get(`copilot:${cbSid}:0`), `${phantomWrote} / ${JSON.stringify(repo.getTaskRun.get(`copilot:${cbSid}:0`))}`);
  const phantomGone = (await get(`project=p1&client=${F9.join(',')}&limit=50`)).find((t) => t.id === `copilot:${cbSid}:0`);
  ok('上一版留下的「(Copilot 会话)」在飞行被收掉（任务记录页不再挂一条永远进行中）', !phantomGone);

  // 第二道闸：即使清单里混进一条**没有 Copilot 标记**的会话（不是 Copilot 库读出来的），也不写
  copilotRows = [{ id: 'not-copilot-sid', project: 'p1', projectPath: '/tmp/p1', lastUpdated: Date.now(), inFlight: true, copilotTurns: [] }];
  ok('清单里没带 Copilot 标记的会话不写（第二道闸：只认 Copilot 自己 session-store.db 读出来的）', syncCopilotTasks({ bus, repo }) === 0 && !repo.getTaskRun.get('copilot:not-copilot-sid:0'));
  copilotRows = [];

  console.log('\n[8b] 9F：没有会话时要把「思考中」落回空闲（否则卡片一直显示忙碌，却没有任务）');
  // 用户实测（2026-09-30）：GitHub Copilot 楼层一直「忙碌」，可库里那条占位任务早被收掉了 ——
  // agent_status 还停在最后一次上报的 thinking（task_id 指向一条已经不在的任务）。
  // 9F 没有 hook / 插件上报，这条状态行只有同步器会写；不在的会话就必须落回 idle。
  const staleAt = Date.now() - 5 * 60_000;
  repo.insertTask.run({ id: 'copilot:gone:0', projectId: 'p1', memberId: 'copilot@p1', parentTaskId: null, title: '(Copilot 会话)', state: 'running', progress: null, startedAt: staleAt, endedAt: null });
  repo.upsertTaskRun.run({ id: 'copilot:gone:0', projectId: 'p1', memberId: 'copilot@p1', client: 'copilot-plugin', sessionId: 'gone', form: null, model: null, title: '(Copilot 会话)', startedAt: staleAt, baselineCommit: null });
  repo.upsertStatus.run({ memberId: 'copilot@p1', state: 'thinking', stateSince: staleAt, taskId: 'copilot:gone:0', progress: null, currentFiles: null, lastHeartbeatAt: staleAt, degraded: 1, source: 'timeout', updatedAt: staleAt });
  copilotRows = [];
  syncCopilotTasks({ bus, repo });
  const settled = repo.getStatus.get('copilot@p1');
  ok('状态落回 idle（卡片显示「空闲」而不是「忙碌」）', settled && settled.state === 'idle', settled && settled.state);
  ok('悬空的 task_id 一起清掉（卡片不会再挂一个不存在的任务）', settled && settled.task_id === null, settled && String(settled.task_id));
  ok('成员卡上也没有任务了', stateOf('copilot@p1') === 'idle' && taskIdOf('copilot@p1') === '', `${stateOf('copilot@p1')} / ${taskIdOf('copilot@p1')}`);

  console.log('\n[8c] 9F：有会话在跑时，收工那一手不许碰它（真值优先）');
  copilotRows = [
    {
      id: 'cop-sid-keep',
      copilot: true,
      project: 'p1',
      projectPath: '/tmp/p1',
      lastUpdated: Date.now(),
      inFlight: true,
      copilotTurns: [],
      livePrompt: '正在跑的这一轮',
      liveStartedAt: Date.now() - 3_000,
      liveIndex: 0,
      liveReqs: [],
    },
  ];
  syncCopilotTasks({ bus, repo });
  ok('按会话写了 thinking 的成员不被收工覆盖', stateOf('copilot@p1') === 'thinking', stateOf('copilot@p1'));
  ok('心跳指着在跑的那条任务', taskIdOf('copilot@p1') === 'copilot:cop-sid-keep:0', taskIdOf('copilot@p1'));
  copilotRows = [];
  syncCopilotTasks({ bus, repo });
  ok('会话停掉后再跑一轮 → 落回 idle', stateOf('copilot@p1') === 'idle', stateOf('copilot@p1'));

  console.log('[9] /reporter-phase：楼层客户端是逗号串也要走对那条路（8F 回归）');
  // 回归（2026-09-28 实测）：route 里两条分支曾写成 `clientBase(client) === 'opencode' | 'kilo'`，
  // 而渲染层传的是**整个楼层的 clients 串**（合并楼层就是 'opencode,opencode-plugin'），
  // clientBase 只剥单个 -plugin 后缀、逗号串永远不相等 → 整条分支不生效：
  // 主控制台相位/模型/完成标记全空，只剩一句"思考中"、没有任何内容。
  sessionsMod.reporterMainPhase = () => null;
  sessionsMod.reporterStateMeta = () => ({ sessionId: '', instrumented: false });
  sessionsMod.readReporterDone = () => null;
  opencodeMod.listOpencodeSessions = () => opencodeRows;
  opencodeMod.opencodeMainPhase = () => ({
    sessionId: 'oc-sid-1',
    phase: 'thinking',
    action: '',
    target: '',
    context: [],
    tool: '',
    prompt: '逗号串也要给原话',
    model: 'longcat',
  });
  // 用可变变量 + 闭包：route 在 require 时就把 readOpencodeDone 解构进去了，
  // 之后再改模块导出对它无效（第一版就是踩了这个，done 一直是 null）。
  let ocDone = null;
  opencodeMod.readOpencodeDone = () => ocDone;
  opencodeMod.opencodeInstrumented = () => true;
  const { createSessionsRouter } = require('../src/http/routes/sessions');
  const appPhase = express();
  appPhase.use('/api/v1', createSessionsRouter({ workspace: { current: () => ({ workspacePath: '/tmp/p1' }) } }));
  const srvPhase = appPhase.listen(0, '127.0.0.1');
  await new Promise((r) => srvPhase.once('listening', r));
  const rpComma = await (
    await fetch(`http://127.0.0.1:${srvPhase.address().port}/api/v1/reporter-phase?client=opencode,opencode-plugin`)
  ).json();
  ok(
    '逗号串也走 8F 轮询那一路（相位 / 用户原话 / 模型都在）',
    rpComma.phase === 'thinking' && rpComma.prompt === '逗号串也要给原话' && rpComma.model === 'longcat',
    JSON.stringify({ phase: rpComma.phase, prompt: rpComma.prompt, model: rpComma.model })
  );
  // 被打断的那一轮：轮询那一路（readOpencodeDone）带的 doneCancelled 要经 toReporterDone 透传成
  // 快轮询的 `done.cancelled` —— 渲染层读的就是它（IsoOfficeView 的 `fpDone.cancelled`），
  // 少了这一步 8F 被终止也只会干等回待命，不会亮红色「任务取消」。
  ocDone = {
    doneAt: Date.now(),
    doneTitle: '',
    doneCount: 1,
    doneFiles: [],
    doneCancelled: true,
  };
  const srv2 = appPhase.listen(0, '127.0.0.1');
  await new Promise((r) => srv2.once('listening', r));
  const rpCancel = await (
    await fetch(`http://127.0.0.1:${srv2.address().port}/api/v1/reporter-phase?client=opencode,opencode-plugin`)
  ).json();
  ok(
    '8F 被打断：快轮询的 done.cancelled=true（主控制台据此亮红色「任务取消」）',
    Boolean(rpCancel.done && rpCancel.done.cancelled === true),
    JSON.stringify(rpCancel.done)
  );
  srv2.close();
  srvPhase.close();

  server.close();
  close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
