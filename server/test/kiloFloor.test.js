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
 *     [B8] **轮中的 assistant 文字 → 思考中**（不是待命）：只有 finish=stop 那段才是待命
 *     [B9] 「思考中」带上这一轮用户说的话（别的楼层都有，7F 原来一个字都没有）
 *   C. 完成标记：message.finish 的映射
 *     [C1] finish=stop（新鲜）→ 有完成标记，标题取会话标题
 *     [C2] finish=tool-calls → 不算完成（还要接着调工具）
 *     [C3] 撞长度 / 被内容过滤 → 不算完成（亮"任务完成"会误导）
 *     [C4] 过期的完成标记（DONE_TTL_MS 之外）→ 当没有
 *   D. 读不出来不许冒泡
 *     [B10] 逐轮清单：轮边界 / 收工判据 / 用户原话 / 改动文件（台账「每一轮一条」的真源）
 *     [B11] 逐轮清单的边界：没干完又过了窗口 → cancelled；compaction 注入不算新任务
 *     [B12] 逐轮清单带 token 真值（reasoning 并进 output）；这一轮一条都没读到 → null 留空
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
const { DEFAULTS } = require('@workgremlin/shared');
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
      -- 逐轮清单（readKiloRounds）读 part 拿用户原话 / 改动文件 / 收尾自述。
      -- 注意 Kilo 的 **session_message 表是空的**（实测 0 行），所以这里也不建它。
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
        time_created INTEGER, time_updated INTEGER, data TEXT
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
function addMessage(db, sessionId, data, updatedAt = Date.now()) {
  // 返回这条消息的 id：相位推导要靠 part.messageID join 回 message 才能判 finish
  // （轮中的文字 vs 整轮收尾，见 [B8]），造数据时得能引用它。
  // updatedAt 同样可显式给：逐轮清单拿消息时间算"这一轮最后动到什么时候"，
  // 默认 Date.now() 会把几十轮前的数据算成"刚刚"。
  const id = `msg_${db.prepare('SELECT COUNT(*) c FROM message').get().c + 1}`;
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(
    id,
    sessionId,
    data.time.created || Date.now(),
    updatedAt,
    JSON.stringify(data)
  );
  return id;
}

/**
 * 追加一条 part（真实库的 part 形状）。
 * `at` 要显式给 —— 逐轮清单拿 part 的时间算"这一轮最后动到什么时候"，
 * 默认 Date.now() 会把几十轮前的数据算成"刚刚"，测起来全是假阳性。
 */
function addPart(db, sessionId, messageId, data, at = Date.now()) {
  const id = `prt_p${db.prepare('SELECT COUNT(*) c FROM part').get().c + 1}`;
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(
    id,
    messageId,
    sessionId,
    at,
    at,
    JSON.stringify(data)
  );
  return id;
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

// [B8] **轮中的一段 assistant 文字 = 思考中，不是待命**（实测 2026-09-28 修的坑）。
//
// Kilo 在**一轮之内**会多次吐 assistant 文字（每次工具调用前后都可能来一段），
// 而轮询只看"最新那条 part"：模型在两次工具调用之间说话时，最新 part 正是 text。
// 早先一律 `text → 待命`，于是任务还在跑、控制台却闪回「待命中」，几秒后又被下一条
// tool 事件顶回「调用工具」—— 相位在两个值之间来回跳。其它楼层在这段间隙是回到
// 「思考中」的（hook.js 的 PostToolUse：工具跑完 → sessionPhase thinking）。
// 判据是那条 text 归属消息的 finish：只有 finish=stop（且 completed）才是整轮说完了。
head('[B8] 轮中的 assistant 文字 → 思考中；只有整轮收尾（finish=stop）才待命');
{
  const db = new Database(DB);
  db.prepare('DELETE FROM event').run();
  db.prepare('DELETE FROM message').run();
  seq = 0;
  const midTurn = addMessage(db, SID, { role: 'assistant', time: { created: Date.now() - 4000, completed: Date.now() - 3000 }, finish: 'tool-calls' });
  // 最新一条 part 就是这段"轮中"文字（后面还会接着调工具）
  addEvent(db, SID, { type: 'text', messageID: midTurn, text: '先确认一下插件到底加载没有', time: { start: Date.now() - 2000, end: Date.now() - 1000 } });
  db.close();
  const ph = kilo.readKiloPhase(SID);
  ok('轮中的 assistant 文字是 thinking（不是待命）', ph && ph.phase === 'thinking', ph && ph.phase);
  ok('不是 idle', !(ph && ph.phase === 'idle'), ph && ph.phase);

  const db2 = new Database(DB);
  db2.prepare('DELETE FROM event').run();
  db2.prepare('DELETE FROM message').run();
  seq = 0;
  const doneMsg = addMessage(db2, SID, { role: 'assistant', time: { created: Date.now() - 3000, completed: Date.now() - 2000 }, finish: 'stop' });
  addEvent(db2, SID, { type: 'text', messageID: doneMsg, text: '搞定', time: { start: Date.now() - 2000, end: Date.now() - 1000 } });
  db2.close();
  const ph2 = kilo.readKiloPhase(SID);
  ok('整轮收尾（finish=stop）的那段文字才是待命', ph2 && ph2.phase === 'idle', ph2 && ph2.phase);
}

// [B10] **陈旧判定必须看信封上的 time，不能只看 part.time**（实测 2026-09-28 修的坑）。
//
// 这是 [B8] 连带挖出来的**旧洞**：`readKiloPhase` 原先只从 `part.time.end|start` 取时间，
// 取不到就算 at=0，而 `if (at && now - at > PHASE_FRESH_MS)` 对 at=0 直接跳过判定 ——
// 于是**没有 part.time 的 part（tool / patch / step-start / 正在流式吐字的 text）永远不会被
// 判成陈旧**。真机实测一个真实会话最近 400 条 part 事件：tool 270 条、step-start 30 条、
// patch 5 条、流式 text 1 条 都没有 part.time，只有 text 26 / reasoning 38 / step-finish 30 有。
// 每一条事件的信封上都带 `time`（number），那才是可靠的时间源。
//
// 这个洞原先被 `text → 待命` 盖住了（这类会话恰好显示成待命，看着"对"）；
// 改成"轮中文字 → 思考中"之后它就露出来了：一个 50 分钟前收工、最后一条是
// 无 part.time 的 text 的会话，会**永远显示「思考中」**（真机上确实复现了两条）。
head('[B10] 没有 part.time 的陈旧事件（信封 time 兜底）→ 回到待命，不许永远「思考中」');
{
  const db = new Database(DB);
  db.prepare('DELETE FROM event').run();
  db.prepare('DELETE FROM message').run();
  seq = 0;
  // 50 分钟前收工的一条会话：最后一条是**没有 part.time** 的 text（实测就长这样）
  const old = Date.now() - 50 * MIN;
  addMessage(db, SID, { role: 'assistant', time: { created: old, completed: old } });
  seq += 1;
  db.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?,?,?,?,?)').run(
    `evt_${seq}`,
    SID,
    seq,
    'message.part.updated.1',
    JSON.stringify({ sessionID: SID, part: { id: `prt_${seq}`, type: 'text', text: 'say hi' }, time: old })
  );
  db.close();
  const ph = kilo.readKiloPhase(SID);
  ok('陈旧且没有 part.time 的 text → 待命（不是思考中）', ph && ph.phase === 'idle', ph && ph.phase);
  ok('不是 thinking', !(ph && ph.phase === 'thinking'), ph && ph.phase);

  // 同一条"新鲜的"（信封 time 是现在）→ 仍然是思考中，证明兜底不是无脑判待命
  const db2 = new Database(DB);
  db2.prepare('DELETE FROM event').run();
  seq = 0;
  seq += 1;
  db2.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?,?,?,?,?)').run(
    `evt_${seq}`,
    SID,
    seq,
    'message.part.updated.1',
    JSON.stringify({ sessionID: SID, part: { id: `prt_${seq}`, type: 'text', text: '还在说' }, time: Date.now() })
  );
  db2.close();
  const ph2 = kilo.readKiloPhase(SID);
  ok('新鲜的同类事件仍是思考中（信封 time 兜底没有把活跃会话也判成待命）', ph2 && ph2.phase === 'thinking', ph2 && ph2.phase);
}

head('[B9] 「思考中」要带上这一轮用户说的话（别的一层都有，7F 原来一个字都没有）');
{
  const db = new Database(DB);
  db.prepare('DELETE FROM event').run();
  db.prepare('DELETE FROM message').run();
  seq = 0;
  const userMsg = addMessage(db, SID, { role: 'user', time: { created: Date.now() - 5000 } });
  // 实测 Kilo 的用户原话带一层 JSON 引号
  addEvent(db, SID, { type: 'text', messageID: userMsg, text: JSON.stringify('7F 的任务记录为什么是空的'), time: { start: Date.now() - 4000 } });
  const asst = addMessage(db, SID, { role: 'assistant', time: { created: Date.now() - 3000, completed: Date.now() - 2000 }, finish: 'tool-calls' });
  addEvent(db, SID, { type: 'reasoning', messageID: asst, text: '先看插件配置', time: { start: Date.now() - 2000, end: Date.now() - 1000 } });
  db.close();
  const ph = kilo.readKiloPhase(SID);
  ok('相位是 thinking', ph && ph.phase === 'thinking', ph && ph.phase);
  ok('prompt 是用户那句话（引号已剥）', ph && ph.prompt === '7F 的任务记录为什么是空的', JSON.stringify(ph && ph.prompt));
  // tool 相位同样带上：屏上"调用工具"那行下面也能看到用户问的是什么
  // （用户那句话那条 event 保留，只把**最新**换成正在跑的 tool）
  const db2 = new Database(DB);
  seq += 1;
  addEvent(db2, SID, { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'npm test' } }, time: { start: Date.now() - 500 } });
  db2.close();
  const ph2 = kilo.readKiloPhase(SID);
  ok('tool 相位也带 prompt', ph2 && ph2.prompt === '7F 的任务记录为什么是空的', JSON.stringify(ph2 && ph2.prompt));
}

/* ------------------------------ C2. 逐轮清单（台账「每一轮一条」的真源） ------------------------------ */

head('[B10] 逐轮清单：轮边界、收工判据、用户原话、改动文件（readKiloRounds）');
{
  const db = new Database(DB);
  db.prepare('DELETE FROM event').run();
  db.prepare('DELETE FROM message').run();
  db.prepare('DELETE FROM part').run();
  seq = 0;
  const now = Date.now();
  const fileAbs = path.join(WS, 'server/src/kiloTasks.js');

  // 第 0 轮：干完了（finish=stop），改了一个文件
  const u0 = addMessage(db, SID, { role: 'user', time: { created: now - 30 * MIN } }, now - 29 * MIN);
  addPart(db, SID, u0, { type: 'text', text: JSON.stringify('把 7F 接上台账') }, now - 29 * MIN);
  // 真实库里同一段文字在 event 与 part **两张表**里各有一份：屏上那句（readRoundPrompt）
  // 走 event，台账（readKiloRounds）走 part。两份都要造，才能锁住"两处口径不许分叉"。
  addEvent(db, SID, { type: 'text', messageID: u0, text: JSON.stringify('把 7F 接上台账'), time: { start: now - 29 * MIN } });
  const a0 = addMessage(
    db,
    SID,
    { role: 'assistant', time: { created: now - 29 * MIN, completed: now - 28 * MIN }, finish: 'stop' },
    now - 28 * MIN
  );
  addPart(db, SID, a0, { type: 'text', text: '接上了' }, now - 28 * MIN);
  // Kilo 自己记的改动文件（实测 patch part 的 files 是**绝对路径**数组）
  addPart(db, SID, a0, { type: 'patch', files: [fileAbs] }, now - 28 * MIN);

  // 第 1 轮：还没干完（只有 tool-calls）→ 最后一轮且新鲜 → running
  const u1 = addMessage(db, SID, { role: 'user', time: { created: now - 5_000 } }, now - 5_000);
  addPart(db, SID, u1, { type: 'text', text: JSON.stringify('再看看任务记录') }, now - 5_000);
  addEvent(db, SID, { type: 'text', messageID: u1, text: JSON.stringify('再看看任务记录'), time: { start: now - 5_000 } });
  const a1 = addMessage(db, SID, { role: 'assistant', time: { created: now - 4_000 }, finish: 'tool-calls' }, now - 4_000);
  addPart(db, SID, a1, { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'ls' } } }, now - 3_000);
  db.close();

  const rounds = kilo.readKiloRounds(SID);
  ok('切成 2 轮', rounds.length === 2, String(rounds.length));
  ok('轮序号从 0 起（台账 id 的后缀就是它）', rounds[0].index === 0 && rounds[1].index === 1, JSON.stringify(rounds.map((r) => r.index)));
  ok('标题 = 那一轮用户原话（引号已剥）', rounds[0].prompt === '把 7F 接上台账', JSON.stringify(rounds[0].prompt));
  // 这条是 2026-09-30 那个故障的根：起点必须来自**那一轮**的 user 消息（不可变），
  // 不是"第一次见到这条会话"的时刻（那条会被 insertTask 的 COALESCE 永远钉住）。
  ok('起点 = 那一轮 user 消息的 time.created', rounds[0].startedAt === now - 30 * MIN, String(rounds[0].startedAt));
  ok(
    '干完的那轮 → done，收工时刻 = assistant 的 time.completed',
    rounds[0].outcome === 'done' && rounds[0].endedAt === now - 28 * MIN,
    `${rounds[0].outcome}/${rounds[0].endedAt}`
  );
  ok('收尾自述取这一轮最后一条 assistant 文字', rounds[0].result === '接上了', JSON.stringify(rounds[0].result));
  // 改动文件只认 patch part —— 工具入参里有 filePath 的只读工具（read/grep）不算改动
  ok(
    '改动文件取 patch part 的 files（不是工具入参）',
    JSON.stringify(rounds[0].files) === JSON.stringify([fileAbs]),
    JSON.stringify(rounds[0].files)
  );
  ok(
    '最后一轮还没干完 → running、ended_at 为空',
    rounds[1].outcome === 'running' && rounds[1].endedAt === null,
    `${rounds[1].outcome}/${rounds[1].endedAt}`
  );
  // 两处取用户原话的口径不许分叉：屏上那句（readRoundPrompt）就是台账的标题来源
  ok(
    'readRoundPrompt 与最后一轮的 prompt 是同一句',
    kilo.readRoundPrompt(SID) === rounds[1].prompt,
    `${JSON.stringify(kilo.readRoundPrompt(SID))} vs ${JSON.stringify(rounds[1].prompt)}`
  );
}

head('[B11] 逐轮清单的两个边界：没干完又过了窗口 → cancelled；compaction 注入不算新任务');
{
  const db = new Database(DB);
  db.prepare('DELETE FROM event').run();
  db.prepare('DELETE FROM message').run();
  db.prepare('DELETE FROM part').run();
  seq = 0;
  const now = Date.now();

  const u0 = addMessage(db, SID, { role: 'user', time: { created: now - 40 * MIN } }, now - 39 * MIN);
  addPart(db, SID, u0, { type: 'text', text: JSON.stringify('干一半被打断') }, now - 39 * MIN);
  // 只有 tool-calls、没有终态 finish，而且早就停了 → 这一轮是"没干完"
  const a0 = addMessage(db, SID, { role: 'assistant', time: { created: now - 39 * MIN }, finish: 'tool-calls' }, now - 39 * MIN);
  addPart(db, SID, a0, { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'sleep 1' } } }, now - 39 * MIN);
  // Kilo 自己的 compaction 注入：role=user 但**没有 text part** —— 不许算成新的一轮
  const c0 = addMessage(db, SID, { role: 'user', time: { created: now - 38 * MIN } }, now - 38 * MIN);
  addPart(db, SID, c0, { type: 'compaction', text: '' }, now - 38 * MIN);
  db.close();

  const rounds = kilo.readKiloRounds(SID);
  ok('compaction 注入没有新起一轮', rounds.length === 1, String(rounds.length));
  ok('没干完又过了窗口的轮 → cancelled（不是 done）', rounds[0].outcome === 'cancelled', rounds[0].outcome);
  ok(
    'cancelled 的收工时刻有值、且不早于起点',
    Number.isFinite(rounds[0].endedAt) && rounds[0].endedAt >= rounds[0].startedAt,
    String(rounds[0].endedAt)
  );
  ok('没干完的那轮不写收尾自述（半截话不算产出）', rounds[0].result === '', JSON.stringify(rounds[0].result));
}

head('[B12] 逐轮清单带 token 真值（reasoning 并进 output）；这一轮一条都没读到 → null 留空');
{
  const db = new Database(DB);
  db.prepare('DELETE FROM event').run();
  db.prepare('DELETE FROM message').run();
  db.prepare('DELETE FROM part').run();
  seq = 0;
  const now = Date.now();

  // 第 0 轮：两条 assistant 各带一份 tokens。Kilo 的语义与 Claude 一致
  // （input **不含**缓存、reasoning **单列**），所以折法只有一处选择：reasoning 并进 output。
  const u0 = addMessage(db, SID, { role: 'user', time: { created: now - 40 * MIN } }, now - 39 * MIN);
  addPart(db, SID, u0, { type: 'text', text: JSON.stringify('把 token 落库') }, now - 39 * MIN);
  const a0 = addMessage(
    db,
    SID,
    {
      role: 'assistant',
      time: { created: now - 39 * MIN, completed: now - 38 * MIN },
      finish: 'stop',
      tokens: { total: 160, input: 100, output: 30, reasoning: 20, cache: { read: 5, write: 5 } },
    },
    now - 38 * MIN
  );
  addPart(db, SID, a0, { type: 'text', text: '落好了' }, now - 38 * MIN);
  // 同一轮的第二次请求：后面这条的消息会覆盖 finish，但 token 是**逐条累加**的（一轮里可能有多次 API 请求）
  addMessage(
    db,
    SID,
    {
      role: 'assistant',
      time: { created: now - 37 * MIN },
      finish: 'stop',
      tokens: { total: 40, input: 10, output: 10, reasoning: 0, cache: { read: 20, write: 0 } },
    },
    now - 37 * MIN
  );

  // 第 1 轮：assistant 消息里**没有** tokens（老版本 Kilo 不写 / 这一轮还没跑完一次请求）
  // —— 这一轮必须回 null，让台账留空，不写 4 个 0 冒充"消耗为零"。
  const u1 = addMessage(db, SID, { role: 'user', time: { created: now - 30 * MIN } }, now - 29 * MIN);
  addPart(db, SID, u1, { type: 'text', text: JSON.stringify('这一轮没数') }, now - 29 * MIN);
  const a1 = addMessage(db, SID, { role: 'assistant', time: { created: now - 29 * MIN }, finish: 'tool-calls' }, now - 28 * MIN);
  addPart(db, SID, a1, { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'ls' } } }, now - 28 * MIN);
  db.close();

  const rounds = kilo.readKiloRounds(SID);
  const t0 = rounds[0] && rounds[0].tokens;
  ok('两条 assistant 的 token 逐条累加（input 100+10）', t0 && t0.input === 110, JSON.stringify(t0));
  // 30+20(reasoning) + 10+0 —— reasoning 并进 output，跟 4F Claude 的 output_tokens 同口径
  ok('reasoning 并进 output（30+20+10=60，不是 40）', t0 && t0.output === 60, t0 && String(t0.output));
  ok('缓存读 / 写分列原样取（read 5+20、write 5+0）', t0 && t0.cacheRead === 25 && t0.cacheWrite === 5, JSON.stringify(t0));
  ok('这一轮一条 tokens 都没读到 → null（不是 4 个 0）', rounds[1] && rounds[1].tokens === null, JSON.stringify(rounds[1] && rounds[1].tokens));
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
  // 缺的是 message / part 表 → 逐轮清单读不出任何一轮（但也不许抛）
  ok('逐轮清单读不出时回空数组，不抛', JSON.stringify(kilo.readKiloRounds(SID)) === '[]', JSON.stringify(kilo.readKiloRounds(SID)));
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

/* ------------------------- F. 议事厅参与者不进办公室 ------------------------- */

head('[F] 议事厅参与者（title = COUNCIL_SESSION_TITLE）不出现在 7F 的会话表里');
{
  // 为什么值得单独钉：Kilo 把会话记在**全局** SQLite 里，`session.directory` 是当时的 cwd。
  // 工程模式下参与者的 cwd 就是用户的工程 —— 不挡的话它当场变成办公室 7F 上多出来的一个
  // "会话"（还带着真实工程路径），而 requirements.md §15.2 写死了「那两页看不出任何痕迹」。
  //
  // 换一份干净的数据根：会话表按**库路径**分键缓存（见 kilo.js 的 listKiloSessions），
  // 同一个根里还存着上面那份好数据，用同一个根会读到缓存、看不出真实行为。
  // 同一份库里放**两条**会话（一条普通、一条参与者标题），才能证明"真的读了库、
  // 只挡住了那一条"，而不是整层读空。
  const ROOT = path.join(TMP, 'kilo-council');
  fs.mkdirSync(ROOT, { recursive: true });
  const db = makeKiloDb(path.join(ROOT, 'kilo.db'));
  const now = Date.now();
  const ins = db.prepare(
    'INSERT INTO session (id, project_id, directory, title, agent, model, summary_files, summary_additions, summary_deletions, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  ins.run('ses_user_1', 'proj1', WS, '我自己开的会话', 'code', '{"id":"kilo-auto/free"}', 0, 0, 0, now - MIN, now);
  ins.run('ses_council_1', 'proj1', WS, DEFAULTS.COUNCIL_SESSION_TITLE, 'code', '{"id":"kilo-auto/free"}', 2, 9, 1, now - MIN, now);
  db.close();
  process.env.WORKGREMLIN_KILO_HOME = ROOT;

  const list = kilo.listKiloSessions();
  const ids = list.map((s) => s.id);
  ok('同库同工程里的**用户会话**照常列出来（挡的不是整个工程）', ids.includes('ses_user_1'), ids.join(' '));
  ok('参与者那条被挡住了', !ids.includes('ses_council_1'), ids.join(' '));
  ok('这个工程下只剩一条（另一条是被挡掉的那条）', list.filter((s) => s.projectPath === WS).length === 1, ids.join(' '));
  // 过滤的判据是"标题"这个约定：一头在 agents.js（发 --title），另一头在这儿（跳过它）。
  // 两头不一致的话过滤会**静默失效**（参与者照样出现在办公室），所以直接把它们对起来钉死。
  const args = require('../src/council/agents').RECIPES['7F'].build({ bin: 'kilo', prompt: 'x', allow: 'none' }).args;
  const at = args.indexOf('--title');
  ok('7F 配方发的标题 = 这里过滤的标题（两头不一致 = 过滤白写）', at >= 0 && args[at + 1] === DEFAULTS.COUNCIL_SESSION_TITLE, JSON.stringify(args));
  process.env.WORKGREMLIN_KILO_HOME = KILO_HOME;
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
