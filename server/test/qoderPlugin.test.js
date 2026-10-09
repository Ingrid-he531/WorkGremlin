'use strict';
/**
 * 6F Qoder **插件形态**（VS Code / Trae CN 里的「Qoder CN (Formerly Lingma)」扩展）自检。
 *
 * 为什么单独一个文件：这个扩展没有 hook 子系统（实测 2026-09-30，extension.js 里连
 * SessionStart / PreToolUse 都搜不到），任务记录只能靠服务端轮询它自己的落盘
 * （server/src/qoder.js：6F Qoder 插件形态，数据源与任务同步器合并于一处）。
 * 与 7F/8F/9F 的 [test:task-sync] 同一个道理，测的是**用户看到的那条路**：
 *   造一个与扩展同构的库 → 同步器写库 → /api/v1/task-runs?client=qoder 取回来。
 * 顺带锁住 6F 独有的两个点：
 *   · **让位给 CLI**：`qoder@工程` 是 CLI 与插件共用的成员（products.js 合并单楼层），
 *     成员卡只有一个槽位 —— CLI 在跑时插件这一路只写台账，不许压掉 CLI 刚上报的相位；
 *   · **相位是推断**（源里没有"跑完了没有"的真值，只有最后一次落盘的时刻）。
 *
 * 库的表结构照抄真实库（`chat_session` / `chat_record` / `chat_snapshot` /
 * `chat_working_space_file`，2026-09-30 从 ~/.lingma/.../local.db 里 dump 出来的），
 * 逐字正文按真实情况填成密文（**只**用明文那两处：extra.originalContent 与 summary）。
 *
 * 跑法：`npm run test:qoder-plugin`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

/* ------------------------------ 沙箱 ------------------------------ */
// qoder.js / project.js 都在调用时读环境与文件，但 HOME 还是先设为妙（与别的自检一致）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-qoder-plugin-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const PROJ = path.join(TMP, 'p1');
const DBP = path.join(TMP, 'lingma', 'local.db');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(WG, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });
fs.writeFileSync(path.join(PROJ, 'package.json'), JSON.stringify({ name: 'p1' }));
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
process.env.WORKGREMLIN_LINGMA_DB = DBP;

const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');
const { createQueryRouter } = require('../src/http/routes/query');
const { detectProducts } = require('../src/floors');
const { snapshot } = require('../src/sessionRegistry');
const qoder = require('../src/qoder');
const { syncQoderPluginTasks, LIVE_MS, TASK_ID_PREFIX } = qoder;

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
function head(label) {
  console.log(`\n${label}`);
}

/* ------------------------------ 造一个与扩展同构的库 ------------------------------ */

const SCHEMA = `
  CREATE TABLE chat_session (
    session_id varchar(64) primary key, user_id VARCHAR(64) not null, user_name varchar(64),
    session_title varchar(256) not null, project_id varchar(64) not null, project_uri varchar(512),
    project_name varchar(64), gmt_create INTEGER, gmt_modified INTEGER, org_id VARCHAR(64) default '',
    session_type VARCHAR(64) DEFAULT '', mode VARCHAR(64) DEFAULT '', version VARCHAR(64) DEFAULT ''
  );
  CREATE TABLE chat_record (
    request_id varchar(64) primary key, session_id varchar(64) not null, chat_task varchar(64) not null,
    question text, answer text, gmt_create INTEGER, gmt_modified INTEGER, finish_status INTEGER,
    extra text DEFAULT '{}', summary text DEFAULT ''
  );
  CREATE TABLE chat_snapshot (
    snapshot_id varchar(64) primary key, session_id varchar(64) not null, chat_record_id varchar(64),
    status varchar(64), name varchar(64), gmt_create INTEGER, gmt_modified INTEGER
  );
  CREATE TABLE chat_working_space_file (
    item_id varchar(64) primary key, session_id varchar(64) not null, snapshot_id varchar(64) not null,
    file_id varchar(512), content_type varchar(64), type varchar(64), gmt_create INTEGER, gmt_modified INTEGER
  );
`;

/**
 * 重建库。`sessions` / `records` 的形状刻意贴住 qoder.js 的读法：
 *   session: {id, title, projectPath, createdAt, lastEventAt, type}
 *   record : {requestId, sessionId, prompt, summary, model, startedAt, updatedAt}
 *   snapshot: {id, sessionId, recordId|null, at, files:[绝对路径]}
 */
function writeDb({ sessions = [], records = [], snapshots = [], schema = SCHEMA } = {}) {
  fs.mkdirSync(path.dirname(DBP), { recursive: true });
  fs.rmSync(DBP, { force: true });
  const db = new Database(DBP);
  db.exec(schema);
  const insS = db.prepare(
    `INSERT INTO chat_session (session_id,user_id,user_name,session_title,project_id,project_uri,project_name,
                               gmt_create,gmt_modified,org_id,session_type,mode,version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const s of sessions) {
    insS.run(
      s.id, 'u1', 'yh', s.title, 'proj-1', s.projectPath === undefined ? PROJ : s.projectPath, 'p1',
      s.createdAt || NOW - 60_000, s.lastEventAt || NOW, '', s.type || 'assistant', 'agent', '1.0.0'
    );
  }
  const insR = db.prepare(
    `INSERT INTO chat_record (request_id,session_id,chat_task,question,answer,gmt_create,gmt_modified,finish_status,extra,summary)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  for (const r of records) {
    insR.run(
      r.requestId, r.sessionId, 't', 'CIPHER-Q', 'CIPHER-A', r.startedAt, r.updatedAt, 0,
      JSON.stringify({ context: {}, modelConfig: { key: r.model || 'auto' }, originalContent: r.prompt }),
      r.summary || ''
    );
  }
  const insSnap = db.prepare('INSERT INTO chat_snapshot (snapshot_id,session_id,chat_record_id,status,name,gmt_create,gmt_modified) VALUES (?,?,?,?,?,?,?)');
  const insFile = db.prepare('INSERT INTO chat_working_space_file (item_id,session_id,snapshot_id,file_id,content_type,type,gmt_create,gmt_modified) VALUES (?,?,?,?,?,?,?,?)');
  for (const [i, sn] of snapshots.entries()) {
    insSnap.run(sn.id, sn.sessionId, sn.recordId === undefined ? null : sn.recordId, 'ok', 'snap', sn.at || NOW, sn.at || NOW);
    for (const [j, f] of (sn.files || []).entries()) {
      insFile.run(`${sn.id}-f${j}`, sn.sessionId, sn.id, f, 'text/plain', 'file', sn.at || NOW, sn.at || NOW);
    }
  }
  db.close();
  qoder.resetLingmaCache(); // 会话表有 5s 缓存：刚换过库/刚写过行必须清掉
}

const NOW = Date.now();
const MIN = 60_000;

/* ------------------------------ 台面 ------------------------------ */

const { repo, close } = openDatabase(path.join(TMP, 'test.db'));
const bus = createIngestBus({ repo, hub: { broadcast() {} }, projectName: 'p1', project: 'p1' });
bus.ensureProject('p1', PROJ, null, 'report');

const products = detectProducts();
const F6 = ((products.find((p) => p.id === '6F') || {}).clients) || [];

/** 成员卡状态（工位上那只小怪物显示的相位）/ 卡上挂着的那条任务 */
const cardOf = (memberId) => bus.buildSnapshot('p1').members.find((x) => x.memberId === memberId) || {};
const stateOf = (memberId) => cardOf(memberId).state;
const taskIdOf = (memberId) => (cardOf(memberId).task && cardOf(memberId).task.id) || '';
const MEMBER = 'qoder@p1';

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

  head('[0] 前置：6F 接纳的上报身份（同步器必须写这里的值，否则被楼层筛选挡掉）');
  ok('6F 接纳 qoder（CLI 与插件合并单楼层）', F6.includes('qoder'), F6.join(','));
  ok('库还没造出来时 → 路径回空串（没装扩展就是这个样子）', qoder.lingmaDbPath() === '', qoder.lingmaDbPath());

  /* ------------------------------ A. 读法 ------------------------------ */

  head('[A1] 只认对话会话：行内补全不算任务，没有工程路径的归不了层');
  writeDb({
    sessions: [
      { id: 's-a', title: '插件会话 A', lastEventAt: NOW },
      { id: 's-completion', title: '行内补全', type: 'completion', lastEventAt: NOW },
      { id: 's-noproj', title: '没工程', projectPath: null, lastEventAt: NOW },
    ],
    records: [
      { requestId: 'r1', sessionId: 's-a', prompt: '第一轮', startedAt: NOW - 30 * MIN, updatedAt: NOW - 25 * MIN },
    ],
  });
  const sess = qoder.listLingmaSessions();
  const idsA = sess.map((s) => s.id);
  ok('库路径认 WORKGREMLIN_LINGMA_DB（自检指到临时库上）', qoder.lingmaDbPath() === DBP, qoder.lingmaDbPath());
  ok('对话会话列出来了', idsA.includes('s-a'), idsA.join(' '));
  ok('行内补全（session_type=completion）不算任务', !idsA.includes('s-completion'), idsA.join(' '));
  ok('没有工程路径的跳过', !idsA.includes('s-noproj'), idsA.join(' '));
  ok('工程名与 CLI 那一路同一条解析（package.json name）', (sess.find((s) => s.id === 's-a') || {}).project === 'p1', JSON.stringify(sess[0] && sess[0].project));
  ok('核心表齐了', qoder.hasCoreTables() === true);

  head('[A2] 每一轮：标题=用户原话（明文）、产出=扩展写的 summary、模型只在用户真的选了时才有');
  writeDb({
    sessions: [{ id: 's-a', title: '插件会话 A', lastEventAt: NOW }],
    records: [
      { requestId: 'r0', sessionId: 's-a', prompt: '把 6F 接上台账', summary: '**对话总结：** 接好了', model: 'qwen3-coder', startedAt: NOW - 30 * MIN, updatedAt: NOW - 25 * MIN },
      { requestId: 'r1', sessionId: 's-a', prompt: '再改一处', model: 'auto', startedAt: NOW - 10 * MIN, updatedAt: NOW - 5 * MIN },
    ],
  });
  const rounds = qoder.readLingmaRounds('s-a');
  ok('按 gmt_create 升序（真实先后）', rounds.length === 2 && rounds[0].index === 0 && rounds[1].index === 1, JSON.stringify(rounds.map((r) => r.index)));
  ok('标题 = 用户原话（extra.originalContent 是明文）', rounds[0].prompt === '把 6F 接上台账' && rounds[1].prompt === '再改一处', `${rounds[0].prompt} / ${rounds[1].prompt}`);
  ok('产出 = 扩展自己写的 summary（明文）', rounds[0].summary === '**对话总结：** 接好了', rounds[0].summary);
  ok('用户选了模型就带上', rounds[0].model === 'qwen3-coder', rounds[0].model);
  ok("'auto' 不算模型名（那是让插件自己挑）→ 留空", rounds[1].model === '', JSON.stringify(rounds[1].model));
  ok('逐字正文一个字都不碰（question/answer 是密文）', !JSON.stringify(rounds).includes('CIPHER'), '应只出现明文那两处');
  ok('认不出 extra 的回合回空标题，不猜', qoder.readLingmaRounds('不存在的会话').length === 0);

  head('[A3] 改动文件：快照挂到轮次上才认，挂不上的整个跳过');
  writeDb({
    sessions: [{ id: 's-a', title: '插件会话 A', lastEventAt: NOW }],
    records: [
      { requestId: 'r0', sessionId: 's-a', prompt: '改点东西', startedAt: NOW - 30 * MIN, updatedAt: NOW - 25 * MIN },
      { requestId: 'r1', sessionId: 's-a', prompt: '第二轮', startedAt: NOW - 10 * MIN, updatedAt: NOW - 5 * MIN },
    ],
    snapshots: [
      { id: 'snap-0', sessionId: 's-a', recordId: 'r0', at: NOW - 26 * MIN, files: [path.join(PROJ, 'server/src/a.js'), '/tmp/别人家/b.js', path.join(PROJ, 'server/src/a.js')] },
      { id: 'snap-live', sessionId: 's-a', recordId: null, at: NOW, files: [path.join(PROJ, 'server/src/半截.js')] },
    ],
  });
  const rWithFiles = qoder.readLingmaRounds('s-a');
  ok('挂上轮次的快照算这一轮改过', rWithFiles[0].files.length === 2, JSON.stringify(rWithFiles[0].files));
  ok('同一路径去重', rWithFiles[0].files.filter((f) => f.endsWith('a.js')).length === 1, JSON.stringify(rWithFiles[0].files));
  ok('没有轮次归属的快照（正在写的那一个）不挂给任何一轮', rWithFiles[1].files.length === 0 && !JSON.stringify(rWithFiles).includes('半截'), JSON.stringify(rWithFiles.map((r) => r.files)));

  head('[A4] 读不出来一律降级，不冒泡');
  fs.rmSync(DBP, { force: true });
  const dbStub = new Database(DBP);
  dbStub.exec('CREATE TABLE chat_session (session_id text primary key, session_title text, project_uri text, session_type text, mode text, gmt_create integer, gmt_modified integer);');
  dbStub.close();
  qoder.resetLingmaCache();
  let threw = '';
  try {
    qoder.listLingmaSessions();
    qoder.readLingmaRounds('s-a');
  } catch (e) {
    threw = String(e && e.message);
  }
  ok('缺表（扩展改版换表）→ 不抛', threw === '', threw);
  ok('缺表 → hasCoreTables 如实说 false', qoder.hasCoreTables() === false, String(qoder.hasCoreTables()));
  fs.rmSync(DBP, { force: true });
  qoder.resetLingmaCache();
  ok('库文件不在（没装扩展）→ 空清单，不抛', qoder.lingmaDbPath() === '' && qoder.listLingmaSessions().length === 0);

  /* ------------------------------ B. 写台账 ------------------------------ */

  head('[B1] 每一轮一条台账：标题=用户原话、产出=summary、改动文件=工程相对');
  const liveStart = NOW - 20_000;
  writeDb({
    sessions: [{ id: 's-live', title: '插件会话', lastEventAt: NOW }],
    records: [
      { requestId: 'q0', sessionId: 's-live', prompt: '上一轮干完了', summary: '做完了', startedAt: NOW - 30 * MIN, updatedAt: NOW - 25 * MIN },
      { requestId: 'q1', sessionId: 's-live', prompt: '修复后测试，你不用回复和工作', startedAt: liveStart, updatedAt: NOW - 2_000 },
    ],
    snapshots: [
      { id: 'snap-q0', sessionId: 's-live', recordId: 'q0', at: NOW - 26 * MIN, files: [path.join(PROJ, 'server/test/pluginReply.test.js')] },
    ],
  });
  ok('同步器写了 2 条（每轮一条）', syncQoderPluginTasks({ bus, repo }) === 2);
  ok('6F 接纳的身份写对了', (repo.getTaskRun.get(`${TASK_ID_PREFIX}s-live:1`) || {}).client === 'qoder', JSON.stringify(repo.getTaskRun.get(`${TASK_ID_PREFIX}s-live:1`)));
  const items = await get(`project=p1&client=${F6.join(',')}&limit=50`);
  const row0 = items.find((t) => t.id === `${TASK_ID_PREFIX}s-live:0`) || null;
  const row1 = items.find((t) => t.id === `${TASK_ID_PREFIX}s-live:1`) || null;
  ok('两轮都按 6F 楼层筛选取得到', Boolean(row0) && Boolean(row1), JSON.stringify(items.map((t) => t.id)));
  ok('标题 = 那一轮用户原话', Boolean(row0) && row0.title === '上一轮干完了' && Boolean(row1) && row1.title === '修复后测试，你不用回复和工作', `${row0 && row0.title} / ${row1 && row1.title}`);
  ok('在飞那轮 running、收工那轮 done', Boolean(row1) && row1.state === 'running' && Boolean(row0) && row0.state === 'done', `${row1 && row1.state}/${row0 && row0.state}`);
  ok('产出摘要用扩展写的 summary', Boolean(row0) && row0.result === '做完了', row0 && row0.result);
  ok('还在飞的那轮不写产出（半截话不算）', Boolean(row1) && !row1.result, row1 && row1.result);
  ok('改动文件转成工程相对路径', Boolean(row0) && row0.file_count === 1 && String(row0.files_json) === JSON.stringify(['server/test/pluginReply.test.js']), row0 && `${row0.file_count} ${row0.files_json}`);
  ok('形态标成 plugin（任务列表显示「Qoder Plugin」而不是 CLI）', Boolean(row1) && row1.form === 'plugin', row1 && row1.form);
  ok('在飞 → 成员卡 thinking，心跳指着在飞那条', stateOf(MEMBER) === 'thinking' && taskIdOf(MEMBER) === `${TASK_ID_PREFIX}s-live:1`, `${stateOf(MEMBER)} / ${taskIdOf(MEMBER)}`);
  const sessionStatus = repo.getSessionStatus.get({ memberId: MEMBER, sessionId: 's-live' });
  ok('Qoder 插件的在飞任务也记在该会话状态行上', sessionStatus && sessionStatus.task_id === `${TASK_ID_PREFIX}s-live:1` && sessionStatus.state === 'thinking');
  ok('成员与 CLI 那一路是同一个（qoder@p1，同一层同一个工位），插件先来的话名字叫 Qoder', (repo.getMember.get(MEMBER) || {}).name === 'Qoder', JSON.stringify(repo.getMember.get(MEMBER)));

  head('[B1b] 幂等：连跑两次不会插重、不会把起点推走');
  const startedBefore = repo.getTaskRun.get(`${TASK_ID_PREFIX}s-live:1`).started_at;
  syncQoderPluginTasks({ bus, repo });
  const items2 = await get(`project=p1&client=${F6.join(',')}&limit=50`);
  ok('还是那两条，没有多出来', items2.filter((t) => String(t.id).startsWith(TASK_ID_PREFIX)).length === 2, JSON.stringify(items2.filter((t) => String(t.id).startsWith(TASK_ID_PREFIX)).map((t) => t.id)));
  ok('起点还是这一轮的起点（没被下一次同步推到现在）', repo.getTaskRun.get(`${TASK_ID_PREFIX}s-live:1`).started_at === startedBefore, `${startedBefore} → ${repo.getTaskRun.get(`${TASK_ID_PREFIX}s-live:1`).started_at}`);

  head('[B2] 一轮收工（超过 LIVE_MS 没再落盘）→ done + 成员卡回落 idle');
  writeDb({
    sessions: [{ id: 's-live', title: '插件会话', lastEventAt: NOW - 5 * MIN }],
    records: [
      { requestId: 'q0', sessionId: 's-live', prompt: '上一轮干完了', summary: '做完了', startedAt: NOW - 30 * MIN, updatedAt: NOW - 25 * MIN },
      { requestId: 'q1', sessionId: 's-live', prompt: '修复后测试，你不用回复和工作', summary: '修好并跑过测试了', startedAt: liveStart, updatedAt: NOW - 5 * MIN },
    ],
  });
  syncQoderPluginTasks({ bus, repo });
  const doneRow = repo.getTask.get(`${TASK_ID_PREFIX}s-live:1`);
  ok('那一轮落成 done', Boolean(doneRow) && doneRow.state === 'done', doneRow && doneRow.state);
  ok('收工时刻 = 这一轮最后一次落盘（源里没有更准的，见文件头）', Boolean(doneRow) && doneRow.ended_at === NOW - 5 * MIN, doneRow && String(doneRow.ended_at));
  ok('收工后补上产出摘要', repo.getTaskRun.get(`${TASK_ID_PREFIX}s-live:1`).result === '修好并跑过测试了');
  ok('成员卡回落 idle（不再永远"思考中"）', stateOf(MEMBER) === 'idle', stateOf(MEMBER));
  ok('LIVE_MS 是 90 秒（判据见该常量处）', LIVE_MS === 90_000, String(LIVE_MS));

  head('[B3] CLI 那一路在跑 → 插件这一路只写台账，不许压掉 CLI 的相位');
  // 回归口径（同 7F 的 [5d-2]）：qoder@p1 是 CLI 与插件**共用**的成员，agent_status 一行一成员、
  // 只有一个 task_id 槽位。插件这一路 5 秒硬写一次，会让 CLI 刚上报的相位来回跳。
  writeDb({
    sessions: [{ id: 's-cli', title: '插件会话', lastEventAt: NOW }],
    records: [{ requestId: 'c0', sessionId: 's-cli', prompt: '插件这一轮在跑', startedAt: NOW - 3_000, updatedAt: NOW - 1_000 }],
  });
  repo.insertTask.run({ id: 't_cli_1', projectId: 'p1', memberId: MEMBER, parentTaskId: null, title: 'CLI 那一轮', state: 'running', progress: null, startedAt: NOW - 8_000, endedAt: null });
  repo.upsertTaskRun.run({ id: 't_cli_1', projectId: 'p1', memberId: MEMBER, client: 'qoder', sessionId: 'cli-session-1', form: 'cli', model: null, title: 'CLI 那一轮', startedAt: NOW - 8_000, baselineCommit: null });
  repo.upsertStatus.run({ memberId: MEMBER, state: 'blocked', stateSince: NOW - 8_000, taskId: 't_cli_1', progress: null, currentFiles: null, lastHeartbeatAt: Date.now(), degraded: 0, source: 'report', updatedAt: Date.now() });
  const nameBefore = repo.getMember.get(MEMBER).name;
  ok('同步器照样写台账（一行都不少）', syncQoderPluginTasks({ bus, repo }) === 1);
  // 名字由第一次落库的那一路定（repo.upsertMember 的 ON CONFLICT 不更新 name）：
  // 插件先来 → 'Qoder'；CLI 先来 → 'qoder'（hook 上报不带名字，bus 按 memberId 前缀落）。
  // 这一路每 5 秒写一次，绝不能把名字改来改去。
  ok('这一路不改已有成员的名字', repo.getMember.get(MEMBER).name === nameBefore, `${nameBefore} → ${repo.getMember.get(MEMBER).name}`);
  ok('CLI 那份相位没被覆盖（还是 blocked）', stateOf(MEMBER) === 'blocked', stateOf(MEMBER));
  ok('心跳还指着 CLI 那条任务', taskIdOf(MEMBER) === 't_cli_1', taskIdOf(MEMBER));

  head('[B3b] CLI 的心跳过期了（进程没了/断了）→ 这一栏收回来，别冻在旧状态上');
  repo.upsertStatus.run({ memberId: MEMBER, state: 'blocked', stateSince: NOW - 30 * MIN, taskId: 't_cli_1', progress: null, currentFiles: null, lastHeartbeatAt: Date.now() - 30 * MIN, degraded: 0, source: 'report', updatedAt: Date.now() - 30 * MIN });
  syncQoderPluginTasks({ bus, repo });
  ok('心跳交回插件这一路', taskIdOf(MEMBER) === `${TASK_ID_PREFIX}s-cli:0`, taskIdOf(MEMBER));
  ok('相位跟着变成 thinking（这一轮在跑）', stateOf(MEMBER) === 'thinking', stateOf(MEMBER));

  head('[B4] 同工程两条会话：在跑的那条拿心跳（旧的那条不许抢）');
  writeDb({
    sessions: [
      { id: 's-held', title: '插件那条', lastEventAt: NOW },
      { id: 's-old', title: '早就停了的', lastEventAt: NOW - 30 * MIN },
    ],
    records: [
      { requestId: 'h0', sessionId: 's-held', prompt: '插件这条在跑', startedAt: NOW - 3_000, updatedAt: NOW - 1_000 },
      { requestId: 'o0', sessionId: 's-old', prompt: '早停了', summary: '做完了', startedAt: NOW - 40 * MIN, updatedAt: NOW - 35 * MIN },
    ],
  });
  ok('两条会话各写自己那一轮（共 2 条）', syncQoderPluginTasks({ bus, repo }) === 2);
  ok('心跳指着在跑的那条', taskIdOf(MEMBER) === `${TASK_ID_PREFIX}s-held:0`, taskIdOf(MEMBER));
  const items4 = await get(`project=p1&client=${F6.join(',')}&limit=50`);
  const held = items4.find((t) => t.id === `${TASK_ID_PREFIX}s-held:0`) || null;
  const old = items4.find((t) => t.id === `${TASK_ID_PREFIX}s-old:0`) || null;
  ok('在跑那条在列表里是 running（没被判成「已取消」）', Boolean(held) && held.state === 'running', held && held.state);
  ok('旧的收工那条是 done', Boolean(old) && old.state === 'done', old && old.state);

  head('[B5] 源里已经没有的那几轮被收掉（别再挂在 running 上冒充「已取消」）');
  writeDb({
    sessions: [{ id: 's-cut', title: '插件会话', lastEventAt: NOW }],
    records: [
      { requestId: 'x0', sessionId: 's-cut', prompt: '第一轮', summary: '干完了', startedAt: NOW - 20 * MIN, updatedAt: NOW - 18 * MIN },
      { requestId: 'x1', sessionId: 's-cut', prompt: '第二轮', startedAt: NOW - 10 * MIN, updatedAt: NOW - 9 * MIN },
    ],
  });
  syncQoderPluginTasks({ bus, repo });
  ok('两轮都写下了', Boolean(repo.getTaskRun.get(`${TASK_ID_PREFIX}s-cut:0`)) && Boolean(repo.getTaskRun.get(`${TASK_ID_PREFIX}s-cut:1`)));
  writeDb({
    sessions: [{ id: 's-cut', title: '插件会话', lastEventAt: NOW }],
    records: [{ requestId: 'x0', sessionId: 's-cut', prompt: '第一轮', summary: '干完了', startedAt: NOW - 20 * MIN, updatedAt: NOW - 18 * MIN }],
  });
  syncQoderPluginTasks({ bus, repo });
  ok('源里没有了的那一条被收掉', !repo.getTaskRun.get(`${TASK_ID_PREFIX}s-cut:1`), JSON.stringify(repo.getTaskRun.get(`${TASK_ID_PREFIX}s-cut:1`)));
  ok('还在的那一轮留着', Boolean(repo.getTaskRun.get(`${TASK_ID_PREFIX}s-cut:0`)));

  head('[B6] 库读不出来（没装扩展 / 改版换表）→ 一条都不写，也不抛');
  fs.rmSync(DBP, { force: true });
  qoder.resetLingmaCache();
  let threw2 = '';
  let wrote = -1;
  try {
    wrote = syncQoderPluginTasks({ bus, repo });
  } catch (e) {
    threw2 = String(e && e.message);
  }
  ok('不抛', threw2 === '', threw2);
  ok('返回 0（没东西可写）', wrote === 0, String(wrote));

  /* ------------------------------ C. 主控制台看得到这条会话 ------------------------------ */
  /* 台账那条路（A/B 两段）走通了还不够：**主控制台严格跟随所选会话**
     （见 IsoOfficeView 的 consoleBase），会话表里没有这一行，插件那条任务在主控制台
     就是"没有会话" —— 这一段锁的就是那一行的形状。 */

  head('[C1] 会话表：插件那条会话进 6F（主控制台跟着所选会话走）');
  writeDb({
    sessions: [{ id: 's-ui', title: '插件会话', lastEventAt: NOW }],
    records: [
      { requestId: 'u0', sessionId: 's-ui', prompt: '把左下角那个圆点去掉', summary: '**对话总结：** 去掉了', startedAt: NOW - 30 * MIN, updatedAt: NOW - 25 * MIN },
      { requestId: 'u1', sessionId: 's-ui', prompt: '再看看', model: 'qwen3-coder', startedAt: NOW - 20_000, updatedAt: NOW - 2_000 },
    ],
  });
  {
    const snap = snapshot({ force: true, workspacePath: PROJ });
    const floor = snap.floors.find((f) => f.id === '6F');
    const row = ((floor && floor.sessions) || []).find((s) => s.sessionId === 's-ui') || null;
    ok('插件那条会话进 6F 的会话表', Boolean(row), ((floor && floor.sessions) || []).map((s) => `${s.sourceKind}:${s.sessionId}`).join(' '));
    ok('标明来自 lingma 那一路（轮询插件的 local.db）', Boolean(row) && row.sourceKind === 'lingma', row && row.sourceKind);
    ok('工程归属 = project_uri 解析出来的那个工程', Boolean(row) && row.projectPath === PROJ, row && String(row.projectPath));
    ok('当前工程里的会话算 mine（屋里的人按在线显示）', Boolean(row) && row.mine === true, row && String(row.mine));
    ok('最后一轮还在跑（90s 内有落盘）→ thinking', Boolean(row) && row.phase === 'thinking', row && row.phase);
    ok('屏上那句用户原话 = 最后一轮的原话', Boolean(row) && row.prompt === '再看看', row && String(row.prompt));
    ok('相位是推断（不是它上报的）→ inferred', Boolean(row) && row.inferred === true, row && String(row.inferred));
    ok('还在跑 → 没有完成标记（不臆造）', Boolean(row) && !row.doneAt, row && String(row.doneAt));
  }

  head('[C2] 收工（超过 LIVE_MS 没再落盘）→ idle + 一枚完成标记（凭据是扩展自己写的 summary）');
  const doneAt = NOW - 3 * MIN;
  writeDb({
    sessions: [{ id: 's-ui', title: '插件会话', lastEventAt: doneAt }],
    records: [
      { requestId: 'u0', sessionId: 's-ui', prompt: '把左下角那个圆点去掉', summary: '**对话总结：** 去掉了', startedAt: NOW - 30 * MIN, updatedAt: NOW - 25 * MIN },
      { requestId: 'u1', sessionId: 's-ui', prompt: '再看看', summary: '**对话总结：** 弄好了', startedAt: NOW - 10 * MIN, updatedAt: doneAt },
    ],
  });
  {
    const snap = snapshot({ force: true, workspacePath: PROJ });
    const floor = snap.floors.find((f) => f.id === '6F');
    const row = ((floor && floor.sessions) || []).find((s) => s.sessionId === 's-ui') || null;
    ok('相位回落待命中', Boolean(row) && row.phase === 'idle', row && row.phase);
    ok('完成标记 = 那一轮最后一次落盘（源里没有更准的）', Boolean(row) && row.doneAt === doneAt, row && String(row.doneAt));
    ok('完成标题 = 那一轮用户原话', Boolean(row) && row.doneTitle === '再看看', row && String(row.doneTitle));
    ok('收尾自述 = 扩展自己写的 summary（明文）', Boolean(row) && /弄好了/.test(row.doneSaid || ''), row && String(row.doneSaid));
    ok('扩展的落盘里没有"被用户打断"这个信号 → 不臆造取消', Boolean(row) && row.doneCancelled === false, row && String(row.doneCancelled));
  }

  head('[C3] 只在插件里开了会话、一句话没说 → 不建会话行（与台账同口径）');
  writeDb({ sessions: [{ id: 's-empty', title: '空会话', lastEventAt: NOW }], records: [] });
  {
    const snap = snapshot({ force: true, workspacePath: PROJ });
    const floor = snap.floors.find((f) => f.id === '6F');
    ok('空会话不进表（主控制台不会凭空多一条）', !((floor && floor.sessions) || []).some((s) => s.sessionId === 's-empty'), ((floor && floor.sessions) || []).map((s) => s.sessionId).join(' '));
  }

  server.close();
  close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
