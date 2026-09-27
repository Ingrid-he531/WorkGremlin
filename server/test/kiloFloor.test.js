/**
 * 7F Kilo Code 自检 —— 纯轮询楼层（Kilo 没有 hook，靠读它自己的 event-sourced SQLite）。
 *
 * 跑法：`npm run test:kilo`（= node 直接跑，零外部依赖；better-sqlite3 走工程里已装好的那份）。
 * 为什么要有它：7F 与 1F~6F 的每一条结论都对应"只有**真的**摆一个 kilo.db 进去才现形"的行为 ——
 * 楼层是不是一层、装的判定、event 推导相位、finish=stop 当完成、陈旧事件不算"正在说话"、
 * 以及**表结构变了不许把接口打挂**。所以不 mock，把 HOME / PATH 指到临时目录，
 * 现造一个与 Kilo 7.8.1 同构的库，让**真实的** products / sessionRegistry / kilo 跑一遍。
 *
 * 覆盖：
 *   A. 楼层表：7F 只有一层 Kilo Code
 *     [A1] 一层：clients = kilo（只有 CLI/TUI 一个形态）；两路来源（dir 只作展示 + kilo 产会话）
 *     [A2] 装了 kilo 可执行文件就算"装了"；数据根是 XDG 位置（~/.local/share/kilo）
 *     [A3] 那一路 dir 读不出会话 → 如实带一句说明（楼层胶囊 tooltip 显示）
 *   B. 会话与相位：从 session + event 推导
 *     [B1] 会话列出来：工程路径取 session.directory（不是 project.worktree）
 *     [B2] 相位：最新事件是 tool/running → 调用工具（带工具名与命令）
 *     [B3] 相位：最新事件是 tool/pending → 等待授权
 *     [B4] 相位：最新事件是 reasoning → 思考中
 *     [B5] 相位一律 inferred（轮询来的，不是上报的）
 *     [B6] **陈旧事件不算"正在说话"**：几小时前那条 text 事件让相位回到待命
 *   C. 完成标记：message.finish 的映射
 *     [C1] finish=stop（新鲜）→ 有完成标记，标题取会话标题
 *     [C2] finish=tool-calls → 不算完成（还要接着调工具）
 *     [C3] 撞长度 / 被内容过滤 → 不算完成（亮"任务完成"会误导）
 *     [C4] 过期的完成标记（DONE_TTL_MS 之外）→ 当没有
 *   D. 读不出来不许冒泡
 *     [D1] 库缺 event/message 表（Kilo 改版换表）→ 楼层仍列出，会话为空，接口不挂
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ 沙箱 ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-kilo-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const BIN = path.join(TMP, 'bin');
const KILO_HOME = path.join(HOME, '.local', 'share', 'kilo');
for (const d of [HOME, WG, BIN, KILO_HOME]) fs.mkdirSync(d, { recursive: true });
// 7F 的"装了"判定只认可执行文件（沙箱里放一个 kilo 替身）
fs.writeFileSync(path.join(BIN, 'kilo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
process.env.PATH = BIN;
// 指向沙箱里的 Kilo 数据根（等价于 XDG 位置，显式写出来免得受调用环境影响）
process.env.WORKGREMLIN_KILO_HOME = KILO_HOME;

const { detectProducts } = require('../src/products');
const kilo = require('../src/kilo');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail === undefined ? '' : `  — ${detail}`}`);
  }
}
function head(s) {
  console.log(`\n${s}`);
}

/* ------------------------------ 造 Kilo 的库 ------------------------------ */

let Database = null;
try {
  Database = require('better-sqlite3');
} catch {
  console.log('better-sqlite3 不可用，跳过 7F 自检（需要先 npm install + postinstall）');
  process.exit(0);
}

/**
 * 造一个与 Kilo 7.8.1 同构的 kilo.db。
 * 只建 7F 真正读到的列 —— 真实库里还有 workspace / credential / permission 等一堆表，
 * 那些 7F 一列都不碰（见 server/src/kilo.js 文件头的表说明），照抄只会让自检变脆。
 */
function makeKiloDb(file, { full = true } = {}) {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  const db = new Database(file);
  if (full) {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT,
        agent TEXT, model TEXT, summary_files INTEGER, summary_additions INTEGER,
        summary_deletions INTEGER, time_created INTEGER, time_updated INTEGER,
        time_archived INTEGER
      );
      CREATE TABLE event (
        id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT
      );
      CREATE UNIQUE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq);
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
        time_updated INTEGER, data TEXT
      );
    `);
  } else {
    // [D1] 只建 session 表：Kilo 改版换掉 event / message 时，7F 得"读不出会话"而不是崩
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER)');
  }
  return db;
}

const DB = path.join(KILO_HOME, 'kilo.db');
const MIN = 60_000;
let seq = 0;
/** 追加一条事件（Kilo 的 part 形状，与实测一致） */
function addEvent(db, sessionId, part, extra = {}) {
  seq += 1;
  db.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?,?,?,?,?)').run(
    `evt_${seq}`,
    sessionId,
    seq,
    'message.part.updated.1',
    JSON.stringify({ sessionID: sessionId, part: { id: `prt_${seq}`, ...part }, ...extra })
  );
}
function addMessage(db, sessionId, data) {
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(
    `msg_${db.prepare('SELECT COUNT(*) c FROM message').get().c + 1}`,
    sessionId,
    data.time.created || Date.now(),
    Date.now(),
    JSON.stringify(data)
  );
}

const WS = '/tmp/ProjKilo';
const SID = 'ses_kilo_0001';
{
  const db = makeKiloDb(DB);
  db.prepare(
    'INSERT INTO session (id, project_id, directory, title, agent, model, summary_files, summary_additions, summary_deletions, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(SID, 'proj1', WS, '把 7F 加进楼层表', 'code', '{"id":"kilo-auto/free","providerID":"kilo"}', 3, 40, 2, Date.now() - 10 * MIN, Date.now());
  // 最新一条是"正在跑 bash" —— 相位应推导成调用工具
  addEvent(db, SID, { type: 'text', text: '先看一眼', time: { start: Date.now() - 40_000, end: Date.now() - 39_000 } });
  addEvent(db, SID, { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'npm run test:floors' } }, time: { start: Date.now() - 5_000 } });
  db.close();
}

/* ------------------------------ A. 楼层表 ------------------------------ */

head('[A1] 7F 只有一层 Kilo Code：clients = kilo + kilo-plugin，两路来源（kilo 轮询 + hook 插件）');
{
  const floor = detectProducts({ force: true }).find((p) => p.id === '7F');
  ok('7F 这一层存在', Boolean(floor), '楼层表里没有 7F');
  ok('7F 名名叫 Kilo Code', floor && floor.name === 'Kilo Code', floor && floor.name);
  ok(
    '这一层接纳两种上报身份：kilo（CLI/TUI）与 kilo-plugin（VS Code 扩展装了 WorkGremlin 插件）',
    floor && JSON.stringify(floor.clients) === JSON.stringify(['kilo', 'kilo-plugin']),
    floor && JSON.stringify(floor.clients)
  );
  ok(
    '两路来源：kilo（轮询数据根里的 SQLite 产会话，tooltip 里标 CLI/Plugin）+ hook（插件的真相位）',
    floor &&
      JSON.stringify(floor.sources.map((s) => `${s.label || s.kind}:${s.kind}`)) ===
        JSON.stringify(['CLI/Plugin:kilo', 'hook:hook']),
    floor && JSON.stringify(floor.sources.map((s) => `${s.label || s.kind}:${s.kind}`))
  );
  ok('kilo 那一路产会话，不标 sessions:false', floor && floor.sources.every((s) => s.sessions !== false), floor && JSON.stringify(floor.sources.map((s) => `${s.kind}:${s.sessions}`)));
  ok('hook 那一路也产会话（插件写的状态文件）', floor && floor.sources.find((s) => s.kind === 'hook') && floor.sources.find((s) => s.kind === 'hook').sessions !== false, floor && JSON.stringify(floor.sources.map((s) => `${s.kind}:${s.sessions}`)));
  ok('hook 那一路按整层过滤：client = kilo,kilo-plugin（合并楼层两路都认）', floor && floor.sources.find((s) => s.kind === 'hook').client === 'kilo,kilo-plugin', floor && JSON.stringify(floor.sources.find((s) => s.kind === 'hook')));
}

head('[A2] 装了 kilo 可执行文件就算"装了"；数据根是 XDG 位置');
{
  const floor = detectProducts({ force: true }).find((p) => p.id === '7F');
  ok('装了 kilo（沙箱里放了可执行文件）就算装了', floor && floor.installed === true, floor && String(floor.installPathLabel));
  ok('数据根是 XDG 位置（~/.local/share/kilo）', String(floor.dataPathLabel).endsWith(path.join('.local', 'share', 'kilo')), floor && floor.dataPathLabel);
  ok('kiloHome 与楼层认的是同一个根', kilo.kiloHome() === KILO_HOME, kilo.kiloHome());
}

head('[A3] kilo 那一路：产会话，同时把数据根与"会话是 SQLite"的说明挂在同一行');
{
  const floor = detectProducts({ force: true }).find((p) => p.id === '7F');
  const src = floor.sources.find((s) => s.kind === 'kilo');
  ok('kilo 那一路产会话', src && src.sessions !== false, src && String(src.sessions));
  ok('kilo 那一路带着数据根（tooltip 据此显示落盘统计）', Boolean(src && src.dataPathLabel), src && src.dataPathLabel);
  ok('kilo 那一路说明"会话是 SQLite、不是可扫的文件"', /SQLite/.test((src && src.note) || ''), src && src.note);
}

/* ------------------------------ B. 会话与相位 ------------------------------ */

head('[B1] 会话列出来：工程路径取 session.directory');
{
  const list = kilo.listKiloSessions();
  const row = list.find((s) => s.id === SID);
  ok('会话列出来了', Boolean(row), list.map((s) => s.id).join(' '));
  ok('工程路径取自 session.directory', row && row.projectPath === WS, row && row.projectPath);
  ok('工程名解析出来了', row && row.project === 'ProjKilo', row && row.project);
  ok('会话 id 就是 Kilo 的 ses_xxx（轴 2）', row && row.id === SID, row && row.id);
  ok('模型从 session.model 取出', row && row.model === 'kilo-auto/free', row && row.model);
  ok('改动文件数取自 summary_files', row && row.fileCount === 3, row && String(row.fileCount));
}

head('[B2] 相位：最新事件 tool/running → 调用工具（带工具名与命令）');
{
  const ph = kilo.readKiloPhase(SID);
  ok('相位是 tool', ph && ph.phase === 'tool', ph && ph.phase);
  ok('工具名是 bash', ph && ph.tool === 'bash', ph && ph.tool);
  ok('动作带真实命令', ph && ph.action === 'npm run test:floors', ph && ph.action);
}

head('[B5] 相位一律 inferred（轮询来的，不是上报的）');
{
  const ph = kilo.readKiloPhase(SID);
  ok('inferred 为 true', ph && ph.inferred === true, ph && String(ph.inferred));
}

head('[C1] finish=stop（新鲜）→ 有完成标记，标题取会话标题');
{
  const db = new Database(DB);
  addMessage(db, SID, { role: 'assistant', time: { created: Date.now() - 30_000, completed: Date.now() - 20_000 }, finish: 'stop' });
  db.close();
  const done = kilo.readKiloDone(SID, { title: '把 7F 加进楼层表', fileCount: 3 });
  ok('拿到完成标记', done && done.doneAt > 0, JSON.stringify(done));
  ok('标题取会话标题', done && done.doneTitle === '把 7F 加进楼层表', done && done.doneTitle);
  ok('文件数带上了', done && done.doneCount === 3, done && String(done.doneCount));
}

head('[C2] finish=tool-calls → 不算完成（还要接着调工具）');
{
  const db = new Database(DB);
  // 只留这一条：它是"最近一次结束"，readKiloDone 就该判它不算完成（而不是退回更早那条 stop）
  db.prepare('DELETE FROM message').run();
  addMessage(db, SID, { role: 'assistant', time: { created: Date.now() - 10_000, completed: Date.now() - 9_000 }, finish: 'tool-calls' });
  db.close();
  const done = kilo.readKiloDone(SID, { title: 'tool-calls-不该亮' });
  ok('tool-calls 不算完成（当没有）', done.doneAt === 0, JSON.stringify(done));
}

head('[C3] 撞长度 / 被内容过滤 → 不算完成');
{
  for (const finish of ['length', 'content-filter']) {
    const db = new Database(DB);
    // 只有这一条候选消息：它要是被当成完成，[C3] 就该亮
    db.prepare('DELETE FROM message').run();
    addMessage(db, SID, { role: 'assistant', time: { created: Date.now() - 10_000, completed: Date.now() - 9_000 }, finish });
    db.close();
    const done = kilo.readKiloDone(SID, { title: `${finish}-不该亮` });
    ok(`finish=${finish} 不当完成`, done.doneAt === 0, JSON.stringify(done));
  }
}

head('[B3] 相位：最新事件 tool/pending → 等待授权');
{
  const db = new Database(DB);
  db.prepare('DELETE FROM event').run();
  seq = 0;
  addEvent(db, SID, { type: 'tool', tool: 'write', state: { status: 'pending', input: {} }, time: { start: Date.now() - 3_000 } });
  db.close();
  const ph = kilo.readKiloPhase(SID);
  ok('相位是 await', ph && ph.phase === 'await', ph && ph.phase);
  ok('动作为"申请执行 write"', ph && ph.action === '申请执行 write', ph && ph.action);
  ok('工具名是 write', ph && ph.tool === 'write', ph && ph.tool);
}

head('[B4] 相位：最新事件 reasoning → 思考中');
{
  const db = new Database(DB);
  db.prepare('DELETE FROM event').run();
  seq = 0;
  addEvent(db, SID, { type: 'reasoning', text: '想一下', time: { start: Date.now() - 2_000, end: Date.now() - 1_000 } });
  db.close();
  const ph = kilo.readKiloPhase(SID);
  ok('相位是 thinking', ph && ph.phase === 'thinking', ph && ph.phase);
}

head('[B6] 陈旧事件不算"正在说话"：几小时前那条 text 事件让相位回到待命');
{
  const db = new Database(DB);
  db.prepare('DELETE FROM event').run();
  seq = 0;
  // 三小时前说完的一段话 —— 收工了就该是待命，不能永远显示"刚刚在说话"
  addEvent(db, SID, { type: 'text', text: '搞定', time: { start: Date.now() - 3 * 60 * MIN, end: Date.now() - 3 * 60 * MIN + 1000 } });
  db.close();
  const ph = kilo.readKiloPhase(SID);
  ok('陈旧事件的相位是 idle（待命）', ph && ph.phase === 'idle', ph && ph.phase);
}

// [B7] step-start / step-finish 不是相位。
// 这两条在真实会话里极 frequent（实测一个会话 step-start 363 次 / step-finish 361 次，
// 对照 tool 2677 次）—— 它们是「一步」的边界记账。早先映射成「规划中 / 汇总中」，
// 后果是每次工具刚跑完、最新事件恰好落在 step-finish 上时控制台就一直卡在「汇总中」。
head('[B7] step-finish / step-start 不许变成「汇总中 / 规划中」');
{
  const db = new Database(DB);
  db.prepare('DELETE FROM event').run();
  seq = 0;
  // 刚跑完一个工具 → 紧接着就是 step-finish（这正是"卡在汇总中"的那个时刻）
  addEvent(db, SID, { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' } }, time: { start: Date.now() - 6000, end: Date.now() - 5000 } });
  addEvent(db, SID, { type: 'step-finish' });
  db.close();
  const ph = kilo.readKiloPhase(SID);
  ok('step-finish 不产生 summarize', !(ph && ph.phase === 'summarize'), ph && ph.phase);
  ok('step-finish 不产生 plan', !(ph && ph.phase === 'plan'), ph && ph.phase);
  // 跳过 step-* 之后应落到更旧的真实事件上：刚跑完工具、还没开始下一轮 → 待命
  ok('跳过 step-* 后落到待命（不是硬套一个相位）', ph && ph.phase === 'idle', ph && ph.phase);

  const db2 = new Database(DB);
  db2.prepare('DELETE FROM event').run();
  seq = 0;
  addEvent(db2, SID, { type: 'step-start' });
  addEvent(db2, SID, { type: 'reasoning', text: '想一下', time: { start: Date.now() - 3000, end: Date.now() - 2000 } });
  db2.close();
  const ph2 = kilo.readKiloPhase(SID);
  ok('step-start 之前的 reasoning 仍然是思考中', ph2 && ph2.phase === 'thinking', ph2 && ph2.phase);
  ok('step-start 不产生 plan', !(ph2 && ph2.phase === 'plan'), ph2 && ph2.phase);
}

head('[C4] 过期的完成标记（DONE_TTL_MS 之外）→ 当没有');
{
  const db = new Database(DB);
  db.prepare('DELETE FROM message').run();
  // 20 分钟前收工 —— 超过 10 分钟的新鲜期
  addMessage(db, SID, { role: 'assistant', time: { created: Date.now() - 20 * MIN, completed: Date.now() - 20 * MIN }, finish: 'stop' });
  db.close();
  const done = kilo.readKiloDone(SID, { title: '早收工了' });
  ok('过期标记当没有', done.doneAt === 0, JSON.stringify(done));
}

/* ------------------------------ D. 读不出来不许冒泡 ------------------------------ */

head('[D1] 库缺 event/message 表（Kilo 改版换表）→ 楼层仍列出，会话为空，接口不挂');
{
  // 换一份数据根：会话表按**库路径**分键（见 kilo.js 的 listKiloSessions），
  // 同一个 5s 缓存里还存着上面那份好数据，用同一个根测会读到缓存、看不出真实行为。
  const BROKEN = path.join(TMP, 'kilo-broken');
  fs.mkdirSync(BROKEN, { recursive: true });
  makeKiloDb(path.join(BROKEN, 'kilo.db'), { full: false }).close();
  process.env.WORKGREMLIN_KILO_HOME = BROKEN;

  const floor = detectProducts({ force: true }).find((p) => p.id === '7F');
  ok('楼层照样列出来', Boolean(floor), '7F 从楼层表里消失了');
  ok('装的判定不受影响', floor && floor.installed === true, floor && String(floor.installed));
  const list = kilo.listKiloSessions();
  ok('会话读成空，不抛', Array.isArray(list) && list.length === 0, JSON.stringify(list));
  ok('hasCoreTables 如实说"没有核心表"', kilo.hasCoreTables() === false, String(kilo.hasCoreTables()));
  // 相位 / 完成标记同样不许抛：缺表时回"没有"，不是把 1.5s 一次的轮询打挂
  ok('相位读不出时回 null，不抛', kilo.readKiloPhase(SID) === null, String(kilo.readKiloPhase(SID)));
  ok('完成标记读不出时回空，不抛', kilo.readKiloDone(SID, {}).doneAt === 0, JSON.stringify(kilo.readKiloDone(SID, {})));
}

/* ------------------------------ E. 两路合起来 ------------------------------ */

head('[E] 装了 WorkGremlin 插件时：kilo-plugin 的状态文件被认出（真相位优先于轮询）');
{
  // sessions / sessionRegistry **必须在取任何时间戳之前**加载：它们在模块加载那一刻记下
  // SERVER_STARTED_AT（"重启纪元"），而 readReporterPhase 只采信本进程启动之后写入的相位
  // （sessions.js 里那句 `if (sp.ts < SERVER_STARTED_AT) continue`）。
  // 反过来先算时间戳再 require 的话，写进去的相位永远早于 SERVER_STARTED_AT，
  // 会被当成上次运行的残留拒掉 —— 那样 [E] 永远测不到真相位那一路。
  const { reporterMainPhase, reporterStateMeta, readReporterDone } = require('../src/sessions');

  // 恢复好数据根：这一段测的是"插件写的状态文件"，跟上面那份库无关
  process.env.WORKGREMLIN_KILO_HOME = KILO_HOME;
  // 先把库重建成"正在调用工具"（[B6] 那一段把事件清成 3 小时前的陈旧 text 了，
  // 否则轮询那份会是 idle，测不出"插件没装时就是它兜底"那条）。
  {
    const db = new Database(DB);
    db.prepare('DELETE FROM event').run();
    seq = 0;
    addEvent(db, SID, { type: 'text', text: '先看一眼', time: { start: Date.now() - 40_000, end: Date.now() - 39_000 } });
    addEvent(db, SID, { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'npm run test:kilo' } }, time: { start: Date.now() - 5_000 } });
    db.close();
  }

  const at = Date.now();
  const sid = SID;
  const key = ['kilo-plugin', WS, sid].join('@').replace(/[^a-zA-Z0-9._-]/g, '_');
  fs.mkdirSync(WG, { recursive: true });
  fs.mkdirSync(path.join(WG, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(WG, 'hooks', `${key}.json`),
    JSON.stringify({
      client: 'kilo-plugin',
      sessionId: sid,
      hb: { lastEventAt: at },
      sessionPhase: { phase: 'await', ts: at, workspacePath: WS, tool: 'write', target: `${WS}/z.txt` },
      done: { at, title: '插件这一轮', fileCount: 2, files: ['a.ts', 'b.ts'], workspacePath: WS, sessionId: sid },
    })
  );

  const rpTruth = reporterMainPhase(WS, 'kilo-plugin', sid);
  const metaTruth = reporterStateMeta(WS, 'kilo-plugin', sid);
  const rpPoll = kilo.kiloMainPhase(WS, sid);
  ok('插件那份相位是 await（轮询给不出的那一相位）', rpTruth && rpTruth.phase === 'await', rpTruth && rpTruth.phase);
  ok('轮询那份仍在（tool）—— 插件没装时就是它兜底', rpPoll && rpPoll.phase === 'tool', rpPoll && rpPoll.phase);
  ok('真相位优先：useTruth 成立', Boolean(rpTruth && rpTruth.phase));
  ok('instrumented 为真（状态文件在）', Boolean(metaTruth.instrumented));
  const done = readReporterDone(WS, 'kilo-plugin', sid);
  ok('插件那份完成标记带**改动文件清单**', done && done.at && Array.isArray(done.files) && done.files.length === 2, JSON.stringify(done));
  ok('完成标记用 reporter 形状（渲染层读 fpDone.at / fpDone.sessionId）', done && typeof done.at === 'number' && done.sessionId === sid, JSON.stringify(done && Object.keys(done)));

  // 清掉插件状态文件，避免污染 [D] 那一段（它会去扫 hooks 目录）
  fs.rmSync(path.join(WG, 'hooks', `${key}.json`), { force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
