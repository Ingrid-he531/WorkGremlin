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
const { detectProducts } = require('../src/products');
const sessionsMod = require('../src/sessions');
const kiloMod = require('../src/kilo');
const opencodeMod = require('../src/opencode');

/* 固定数据打桩：只把"厂商落盘"那一层换掉，repo / 路由 / 同步器全是真的 */
let copilotRows = [];
let kiloRows = [];
let kiloFiles = [];
let opencodeRows = [];
sessionsMod.listSessions = () => ({ sessions: copilotRows });
sessionsMod.copilotCurrentModel = () => 'GPT-5 mini';
kiloMod.listKiloSessions = () => kiloRows;
kiloMod.readKiloFiles = () => kiloFiles;
kiloMod.readRoundPrompt = (sid) => ((kiloRows.find((r) => r.id === sid) || {}).roundPrompt || '');
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
  kiloRows = [
    {
      id: 'kilo-sid-1',
      project: 'p1',
      projectPath: '/tmp/p1',
      lastEventAt: Date.now(),
      title: '把 7F 接上台账',
      roundPrompt: '把 7F 接上台账（这一轮）',
      model: 'kilo-auto/free',
      fileCount: 0,
    },
  ];
  kiloFiles = ['/tmp/p1/src/a.js', '/tmp/p1/src/b.js'];
  ok('同步器写了 1 条', syncKiloTasks({ bus, repo }) === 1);
  const run7 = repo.getTaskRun.get('kilo:kilo-sid-1');
  ok('台账行的 client 是楼层接纳的身份', Boolean(run7) && F7.includes(run7.client), run7 && run7.client);
  const items7 = await get(`project=p1&client=${F7.join(',')}&limit=50`);
  const row7 = items7.find((t) => t.id === 'kilo:kilo-sid-1') || null;
  ok('按 7F 楼层筛选能取到这条任务记录', Boolean(row7), JSON.stringify(items7.map((t) => t.id)));
  ok('标题用这一轮用户说的话（不是永远不变的会话标题）', Boolean(row7) && row7.title === '把 7F 接上台账（这一轮）', row7 && row7.title);
  ok('模型信息带上了（Kilo 的 session.model）', Boolean(row7) && row7.model === 'kilo-auto/free', row7 && row7.model);
  ok(
    '改动文件按工程相对路径落库',
    Boolean(row7) && String(row7.files_json) === JSON.stringify(['src/a.js', 'src/b.js']),
    row7 && row7.files_json
  );
  ok('活跃会话 → 成员卡 thinking', stateOf('kilo@p1') === 'thinking', stateOf('kilo@p1'));

  console.log('[4] 7F Kilo Code：会话停下 → 成员卡回落 idle');
  kiloRows = [{ ...kiloRows[0], lastEventAt: Date.now() - 30 * 60_000 }];
  syncKiloTasks({ bus, repo });
  ok('成员卡回落 idle', stateOf('kilo@p1') === 'idle', stateOf('kilo@p1'));

  console.log('[5] 同一工程多条会话：在跑的那条不许被判成「已取消」');
  // 回归（2026-09-28 实测）：agent_status 主键是 member_id，一个工程只有一条状态行。
  // 早先每条会话都去写它，谁最后写谁赢 —— 正在跑的那条任务因此在 agent_status 里
  // 找不到对应心跳，任务列表按 query.js 的 CASE 把它算成「已取消」，运行中的任务就没了。
  // 这里故意把"早就停了的那条"排在后面（谁最后写谁赢的写法就会踩中）。
  kiloRows = [
    { id: 'kilo-sid-active', project: 'p1', projectPath: '/tmp/p1', lastEventAt: Date.now(), title: '在跑的这条', model: 'kilo-auto/free', fileCount: 0 },
    { id: 'kilo-sid-old', project: 'p1', projectPath: '/tmp/p1', lastEventAt: Date.now() - 30 * 60_000, title: '早就停了的', model: '', fileCount: 0 },
  ];
  syncKiloTasks({ bus, repo });
  const seven2 = await get(`project=p1&client=${F7.join(',')}&limit=50`);
  const active7 = seven2.find((t) => t.id === 'kilo:kilo-sid-active') || null;
  ok('7F 运行中的任务是 running（不是 cancelled）', Boolean(active7) && active7.state === 'running', active7 && active7.state);
  ok('心跳指着在跑的那条任务', taskIdOf('kilo@p1') === 'kilo:kilo-sid-active', taskIdOf('kilo@p1'));

  console.log('[6] 9F：会话行说「在飞」→ 只有那一轮是 running（不受 2 分钟窗口影响）');
  // Copilot 自己的库整轮写完才落盘，只看 updated_at 会出现"跑着显示待命、跑完显示思考中"。
  // sessions.js 从 VS Code 的 chat 索引 / 会话日志读出「这一轮在不在飞」并挂在会话行上
  // （inFlight + livePrompt/liveIndex），同步器必须听它：下面这条 lastUpdated 是半小时前的。
  const liveStart2 = Date.now() - 3000;
  copilotRows = [
    {
      id: 'cop-sid-live',
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

  console.log('[8] /reporter-phase：楼层客户端是逗号串也要走对那条路（8F 回归）');
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
