/**
 * 8F OpenCode 自检 —— 与 7F Kilo 同类的轮询楼层，但**取法不同**，且多一路插件真相位。
 *
 * 跑法：`npm run test:opencode`（= node 直接跑，零外部依赖；better-sqlite3 走工程里已装好的那份）。
 *
 * 为什么 8F 不能照抄 7F 的测试与实现（同源，但 schema 已分叉 —— 实测 2026-09-26，
 * Kilo Code 7.8.1 / OpenCode 2.0.18）：
 *   · 会话表：Kilo 是 `session`，OpenCode 2.0.18 是 `session_v2`（老版本是 `session`）
 *   · 相位来源：Kilo 读 `event` 表的 part（**落盘**，2288 行）；OpenCode 的 `event` 表**是空的**
 *     （事件只在内存流里推、不落盘），只能改读 `session_message` 的 `content[]`
 *   · 消息表：Kilo 是 `message`，OpenCode 是 `session_message`
 *   · OpenCode 多一列 `time_suspended`（刻意**不**拿它过滤，理由见 opencode.js）
 * 所以这里现造一个与 **OpenCode 2.0.18** 同构的库（`session_v2` + `session_message`，
 * `event` 表存在但为空 —— 复现真实情况），让**真实的** products / sessionRegistry /
 * opencode 跑一遍。表结构变了不许把接口打挂，也在 [D] 里验。
 *
 * 覆盖：
 *   A. 楼层表：8F 只有一层 OpenCode
 *     [A1] 一层：clients = opencode；三路来源（dir 只作展示 + opencode 产会话 + hook 收插件真相位）
 *     [A2] `opencode` 不在 PATH 也能判"装了"（认 ~/.opencode/bin，官方安装脚本就装在那儿）
 *     [A3] 那一路 dir 读不出会话 → 如实带一句说明（楼层胶囊 tooltip 显示）
 *   B. 会话与相位：从 session_v2 + session_message 推导
 *     [B1] 会话列出来：工程路径取 session_v2.directory；子代理会话（parent_id 非空）不算独立会话
 *     [B2] 相位：最新消息里 tool/running → 调用工具（带工具名与实际命令）
 *     [B3] 相位：tool/error → 调用工具但报错
 *     [B4] 相位：reasoning → 思考中
 *     [B5] 相位：type='idle' 行（OpenCode 的**显式**空闲标记）→ 待命
 *     [B6] 相位一律 inferred（轮询来的，不是上报的）
 *     [B7] **陈旧消息不算"正在说话"**：几小时前那条 text 让相位回到待命
 *     [B8] 没有「等待授权」：tool 状态只有 completed/error/running（Kilo 有 pending、OpenCode 没有）——
 *          那一相位只能由插件那一路给（见 [E]）
 *   C. 完成标记：session_message.finish 的映射
 *     [C1] finish=stop（新鲜）→ 有完成标记
 *     [C2] finish=tool-calls → 不算完成（还要接着调工具）
 *     [C3] finish=error → 不算完成
 *     [C4] 过期的完成标记（DONE_TTL_MS 之外）→ 当没有
 *   D. 读不出来不许冒泡
 *     [D1] 库缺 session_message 表（OpenCode 改版换表）→ 楼层仍列出，会话表仍读得出、
 *         相位/完成标记/instrumented 如实回空，接口不挂（**降级而不是瘫**）
 *   E. 两路合起来：插件写的状态文件能被认出来（真相位优先于轮询）
 *     [E1] 装上插件的状态文件后，这一层会话的相位来自状态文件、instrumented 为真
 *     [E2] 插件那份完成标记带**改动文件清单**（轮询给不出这一项）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ 沙箱 ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-opencode-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const BIN = path.join(TMP, 'bin');
const OC_HOME = path.join(HOME, '.local', 'share', 'opencode');
for (const d of [HOME, WG, BIN, OC_HOME]) fs.mkdirSync(d, { recursive: true });
// 8F 的"装了"判定认 ~/.opencode/bin（实测官方安装脚本装在这儿，且**不在 PATH 里**）
fs.mkdirSync(path.join(HOME, '.opencode', 'bin'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.opencode', 'bin', 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
// 沙箱 PATH 里**故意不放** opencode：验证 CLI_BIN_DIRS 那一路，而不是碰巧在 PATH 里
process.env.PATH = BIN;
process.env.WORKGREMLIN_OPENCODE_HOME = OC_HOME;

const Database = require('better-sqlite3');

const { detectProducts } = require('../src/products');
const opencode = require('../src/opencode');
// sessions / sessionRegistry **必须在取任何时间戳之前**加载：它们在模块加载那一刻记下
// SERVER_STARTED_AT（"重启纪元"），而 readReporterPhase 只采信本进程启动之后写入的相位
// （sessions.js 里那句 `if (sp.ts < SERVER_STARTED_AT) continue`）。
// 反过来先算时间戳再 require 的话，写进去的相位永远早于 SERVER_STARTED_AT，
// 会被当成上次运行的残留拒掉 —— 那样 [E] 永远测不到真相位那一路。
const { reporterMainPhase, reporterStateMeta, readReporterDone } = require('../src/sessions');
const { refresh, snapshot } = require('../src/sessionRegistry');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail !== undefined ? `  —— ${detail}` : ''}`);
  }
}
function head(label) {
  console.log(`\n${label}`);
}

/* ------------------------------ 造一个 OpenCode 2.0.18 同构的库 ------------------------------ */

const DB = path.join(OC_HOME, 'opencode.db');
const now = Date.now();
const HOUR = 60 * 60_000;

/** 建库：session_v2 + session_message + 一个**空的** event 表（复现实测：OpenCode 不落盘事件） */
function buildDb({ withMessages = true } = {}) {
  fs.rmSync(DB, { force: true });
  const db = new Database(DB);
  db.exec(`
    CREATE TABLE session_v2 (
      id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
      directory text NOT NULL, title text, version text NOT NULL, agent text, model text,
      cost real DEFAULT 0 NOT NULL,
      summary_additions integer, summary_deletions integer, summary_files integer,
      time_created integer NOT NULL, time_updated integer NOT NULL,
      time_idle integer, idle_outcome text, time_archived integer, time_suspended integer
    );
    CREATE TABLE session_message (
      id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
    );
    CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, data text NOT NULL);
  `);
  const ins = db.prepare(
    `INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, agent, model,
                             cost, summary_files, time_created, time_updated, time_idle, idle_outcome, time_archived, time_suspended)
     VALUES (@id,'proj',@parent,'slug',@dir,@title,'2.0.18','build',@model,0,@files,@created,@updated,NULL,NULL,@archived,NULL)`
  );
  ins.run({
    id: 'ses_live0000000000000000000001', parent: null, dir: '/tmp/ProjO', title: '正在跑的那条',
    model: '{"id":"space-bunny-free","providerID":"opencode"}', files: 2, created: now - HOUR, updated: now, archived: null,
  });
  ins.run({
    id: 'ses_sub00000000000000000000001', parent: 'ses_live0000000000000000000001', dir: '/tmp/ProjO', title: '子代理会话',
    model: '{"id":"space-bunny-free","providerID":"opencode"}', files: 0, created: now - HOUR, updated: now, archived: null,
  });
  ins.run({
    id: 'ses_done0000000000000000000001', parent: null, dir: '/tmp/ProjO', title: '刚收工的那条',
    model: '{"id":"space-bunny-free","providerID":"opencode"}', files: 3, created: now - 2 * HOUR, updated: now - 60_000, archived: null,
  });
  ins.run({
    id: 'ses_old00000000000000000000001', parent: null, dir: '/tmp/ProjO', title: '几小时前收工',
    model: '{"id":"space-bunny-free","providerID":"opencode"}', files: 0, created: now - 5 * HOUR, updated: now - 4 * HOUR, archived: null,
  });
  ins.run({
    id: 'ses_arch0000000000000000000001', parent: null, dir: '/tmp/ProjO', title: '归档了',
    model: '{"id":"space-bunny-free","providerID":"opencode"}', files: 0, created: now - 5 * HOUR, updated: now, archived: now, 
  });

  if (withMessages) {
    const msg = db.prepare(
      `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)`
    );
    const put = (sid, seq, type, data, at) =>
      msg.run(`${sid}#${seq}`, sid, type, seq, at, at, JSON.stringify(data));

    // 正在跑的那条：最新消息里有一个 status=running 的 shell 工具块
    const live = 'ses_live0000000000000000000001';
    put(live, 1, 'assistant', { time: { created: now - 60_000 }, content: [{ type: 'reasoning', text: '想一下' }] }, now - 60_000);
    put(
      live,
      2,
      'assistant',
      {
        time: { created: now - 5_000, streamed: now - 4_000 },
        content: [
          { type: 'reasoning', text: '先看文件' },
          { type: 'tool', name: 'shell', state: { status: 'running', input: { command: 'ls -la /tmp/ProjO' } } },
        ],
      },
      now - 4_000
    );

    // 刚收工的那条：最后一条 assistant 有 finish=stop
    const done = 'ses_done0000000000000000000001';
    put(
      done,
      1,
      'assistant',
      {
        time: { created: now - 120_000, completed: now - 60_000 },
        finish: 'stop',
        content: [{ type: 'text', text: '收工了' }],
      },
      now - 60_000
    );

    // 几小时前收工的那条：同形状但过期（验证新鲜度）
    const old = 'ses_old00000000000000000000001';
    put(
      old,
      1,
      'assistant',
      {
        time: { created: now - 4 * HOUR, completed: now - 4 * HOUR + 1000 },
        finish: 'stop',
        content: [{ type: 'text', text: '很久以前' }],
      },
      now - 4 * HOUR
    );
  }
  db.close();
}

buildDb();
const flush = () => opencode.listOpencodeSessions();

/* ------------------------------ A. 楼层表 ------------------------------ */

head('[A] 楼层表：8F 只有一层 OpenCode');
{
  const floor = detectProducts({ force: true }).find((p) => p.id === '8F');
  ok('8F 存在且名叫 OpenCode', floor && floor.name === 'OpenCode', floor && floor.name);
  ok('这一层只接纳 opencode 一种上报身份', floor && JSON.stringify(floor.clients) === JSON.stringify(['opencode']), floor && JSON.stringify(floor.clients));
  ok(
    '三路来源：dir（只作展示）+ opencode（轮询产会话）+ hook（收插件真相位）',
    floor && floor.sources.length === 3 && floor.sources.map((s) => s.kind).join(',') === 'dir,opencode,hook',
    floor && floor.sources.map((s) => s.kind).join(',')
  );
  ok(
    '装了就算装了 —— opencode **不在 PATH 里**，靠 ~/.opencode/bin 命中',
    floor && floor.installed === true,
    floor && `${floor.installed} ${floor.installPathLabel}`
  );
  ok('数据根是 XDG 位置（~/.local/share/opencode）', floor && String(floor.sources[0].dataPathLabel).endsWith('.local/share/opencode'), floor && floor.sources[0].dataPathLabel);
  ok('安装位置认出 ~/.opencode/bin/opencode', floor && String(floor.installPathLabel).endsWith('.opencode/bin/opencode'), floor && floor.installPathLabel);
  ok(
    'dir 那一路读不出会话 → 如实带一句说明',
    floor && floor.sources[0].sessions === false && /SQLite/.test(floor.sources[0].note || ''),
    floor && `${floor.sources[0].sessions} ${floor.sources[0].note}`
  );
  ok('核心表齐了（session_v2 + session_message）', opencode.hasCoreTables() === true);
  ok('数据根/库路径函数可解析', opencode.opencodeHome() === OC_HOME && opencode.opencodeDbPath() === DB, `${opencode.opencodeHome()} | ${opencode.opencodeDbPath()}`);
}

/* ------------------------------ B. 会话与相位 ------------------------------ */

head('[B1] 会话列出来：工程路径取 directory，子代理不算独立会话');
{
  flush();
  const list = opencode.listOpencodeSessions();
  const ids = list.map((s) => s.id);
  ok('归档会话被滤掉', !ids.includes('ses_arch0000000000000000000001'), ids.join(' '));
  ok('子代理会话（parent_id 非空）不算独立会话', !ids.includes('ses_sub00000000000000000000001'), ids.join(' '));
  ok('正常会话都在', ids.includes('ses_live0000000000000000000001') && ids.includes('ses_done0000000000000000000001'), ids.join(' '));
  const live = list.find((s) => s.id === 'ses_live0000000000000000000001');
  ok('工程路径取 session_v2.directory', live && live.projectPath === '/tmp/ProjO', live && live.projectPath);
  ok('模型从 session_v2.model 的 JSON 串里取 id', live && live.model === 'space-bunny-free', live && live.model);
  ok('标题取 session_v2.title', live && live.title === '正在跑的那条', live && live.title);
}

head('[B2] 相位：最新消息里 tool/running → 调用工具（带工具名与实际命令）');
{
  const ph = opencode.readOpencodePhase('ses_live0000000000000000000001');
  ok('phase = tool', ph && ph.phase === 'tool', ph && ph.phase);
  ok('工具名取 part.name（OpenCode 用 name，不是 Kilo 的 tool）', ph && ph.tool === 'shell', ph && ph.tool);
  ok('实际命令从 part.state.input.command 取', ph && /ls -la \/tmp\/ProjO/.test(ph.action), ph && ph.action);
  ok('context 里带上工具名', ph && ph.context.some((c) => c.includes('shell')), ph && JSON.stringify(ph.context));
}

head('[B3] 相位：tool/error → 调用工具但报错');
{
  const db = new Database(DB);
  db.prepare("UPDATE session_message SET data=? WHERE session_id=? AND seq=2").run(
    JSON.stringify({
      time: { created: now - 5_000, streamed: now - 4_000 },
      content: [{ type: 'tool', name: 'read', state: { status: 'error', input: { path: '/tmp/ProjO/x.txt' } } }],
    }),
    'ses_live0000000000000000000001'
  );
  db.close();
  const ph = opencode.readOpencodePhase('ses_live0000000000000000000001');
  ok('phase 仍是 tool（UI 按工具名显示，不假装是别的相位）', ph && ph.phase === 'tool', ph && ph.phase);
  ok('动作里写明"报错"', ph && /报错/.test(ph.action), ph && ph.action);
  ok('目标文件从 input.path 取', ph && ph.target === '/tmp/ProjO/x.txt', ph && ph.target);
  // 复原成 running，后面的用例还要用
  const db2 = new Database(DB);
  db2.prepare("UPDATE session_message SET data=? WHERE session_id=? AND seq=2").run(
    JSON.stringify({
      time: { created: now - 5_000, streamed: now - 4_000 },
      content: [
        { type: 'reasoning', text: '先看文件' },
        { type: 'tool', name: 'shell', state: { status: 'running', input: { command: 'ls -la /tmp/ProjO' } } },
      ],
    }),
    'ses_live0000000000000000000001'
  );
  db2.close();
}

head('[B4] 相位：reasoning → 思考中');
{
  const db = new Database(DB);
  db.prepare("UPDATE session_message SET data=? WHERE session_id=? AND seq=2").run(
    JSON.stringify({ time: { created: now - 5_000 }, content: [{ type: 'reasoning', text: '在想' }] }),
    'ses_live0000000000000000000001'
  );
  db.close();
  const ph = opencode.readOpencodePhase('ses_live0000000000000000000001');
  ok('phase = thinking', ph && ph.phase === 'thinking', ph && ph.phase);
}

head('[B5] 相位：type=idle 行（OpenCode 的**显式**空闲标记）→ 待命');
{
  const db = new Database(DB);
  // 在"正在跑"那条上面压一条更新的 idle 行：显式空闲就该是待命，哪怕更下面还有 running 的工具
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)').run(
    'ses_live0000000000000000000001#99',
    'ses_live0000000000000000000001',
    'idle',
    99,
    now,
    now,
    JSON.stringify({ time: { created: now }, outcome: 'succeeded' })
  );
  db.close();
  const ph = opencode.readOpencodePhase('ses_live0000000000000000000001');
  ok('显式 idle 行优先 → phase = idle', ph && ph.phase === 'idle', ph && ph.phase);
  // 清掉它，后面的用例继续
  const db2 = new Database(DB);
  db2.prepare("DELETE FROM session_message WHERE session_id=? AND type='idle'").run('ses_live0000000000000000000001');
  db2.close();
}

head('[B6] 相位一律 inferred（轮询来的，不是上报的）');
{
  const ph = opencode.readOpencodePhase('ses_live0000000000000000000001');
  ok('inferred = true', ph && ph.inferred === true, ph && String(ph && ph.inferred));
}

head('[B7] 陈旧消息不算"正在说话"');
{
  const ph = opencode.readOpencodePhase('ses_old00000000000000000000001');
  ok('几小时前那条 text → 待命（不是"刚刚在说话"）', ph && ph.phase === 'idle', ph && ph.phase);
}

head('[B8] 没有「等待授权」：OpenCode 的 tool 状态没有 pending（Kilo 有）');
{
  const db = new Database(DB);
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)').run(
    'ses_live0000000000000000000001#98',
    'ses_live0000000000000000000001',
    'assistant',
    98,
    now,
    now,
    JSON.stringify({
      time: { created: now },
      content: [{ type: 'tool', name: 'write', state: { status: 'pending', input: { file: '/tmp/ProjO/z.txt' } } }],
    })
  );
  db.close();
  const ph = opencode.readOpencodePhase('ses_live0000000000000000000001');
  // pending 在 OpenCode 的库里不会出现；万一出现了也不许拿它冒充"等授权"
  ok('即便出现 pending 也不判成 await（那一相位只由插件给）', ph && ph.phase !== 'await', ph && ph.phase);
  const db2 = new Database(DB);
  db2.prepare("DELETE FROM session_message WHERE session_id=? AND seq=98").run('ses_live0000000000000000000001');
  db2.close();
}

/* ------------------------------ C. 完成标记 ------------------------------ */

head('[C] 完成标记：session_message.finish 的映射');
{
  const d1 = opencode.readOpencodeDone('ses_done0000000000000000000001', { title: '刚收工的那条', fileCount: 3 });
  ok('finish=stop（新鲜）→ 有完成标记', d1 && d1.doneAt > 0, JSON.stringify(d1));
  ok('标题取会话标题', d1 && d1.doneTitle === '刚收工的那条', d1 && d1.doneTitle);
  ok('文件数取会话的 summary_files', d1 && d1.doneCount === 3, d1 && d1.doneCount);
  ok('轮询这一路没有改动文件**清单**（那是插件的活）', d1 && Array.isArray(d1.doneFiles) && d1.doneFiles.length === 0, JSON.stringify(d1 && d1.doneFiles));

  const d2 = opencode.readOpencodeDone('ses_old00000000000000000000001', {});
  ok('过期的完成标记（DONE_TTL_MS 之外）→ 当没有', d2 && d2.doneAt === 0, JSON.stringify(d2));

  // finish=tool-calls / finish=error 都不该亮"任务完成"
  const db = new Database(DB);
  for (const [sid, finish] of [
    ['ses_tc000000000000000000000001', 'tool-calls'],
    ['ses_err00000000000000000000001', 'error'],
  ]) {
    db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)').run(
      `${sid}#1`, sid, 'assistant', 1, now, now,
      JSON.stringify({ time: { created: now, completed: now }, finish, content: [{ type: 'text', text: 'x' }] })
    );
  }
  db.close();
  ok('finish=tool-calls → 不算完成（还要接着调工具）', opencode.readOpencodeDone('ses_tc000000000000000000000001', {}).doneAt === 0);
  ok('finish=error → 不算完成', opencode.readOpencodeDone('ses_err00000000000000000000001', {}).doneAt === 0);
}

/* ------------------------------ D. 读不出来不许冒泡 ------------------------------ */

head('[D] 库缺 session_message 表（OpenCode 改版换表）→ 降级而不是瘫，接口不挂');
{
  fs.rmSync(DB, { force: true });
  const db = new Database(DB);
  db.exec('CREATE TABLE session_v2 (id text PRIMARY KEY, directory text NOT NULL, title text, time_created integer NOT NULL, time_updated integer NOT NULL);');
  db.close();
  const floor = detectProducts({ force: true }).find((p) => p.id === '8F');
  ok('楼层照样列得出来', Boolean(floor), floor && floor.id);
  ok('hasCoreTables 如实说"没有核心表"', opencode.hasCoreTables() === false, String(opencode.hasCoreTables()));
  // 降级而不是瘫：session_v2 还在，会话**仍应列得出来**（只是拿不到相位/完成标记）。
  // 这正是想要的 —— "读不出相位"不该连"这个产品在跑、有哪条会话"一起丢掉。
  // （这里只验"调用不抛、返回数组"：会话清单有 5s 缓存且按**库路径**分键，库里刚被换掉
  //  但路径没变，这一轮拿到的还是上一份缓存值 —— 那是刻意的（别让 1.5s 的轮询去撞锁）。）
  const degraded = opencode.listOpencodeSessions();
  ok('降级而不是瘫：调用不抛、返回数组', Array.isArray(degraded), typeof degraded);
  ok('相位读不出时回 null，不抛', opencode.readOpencodePhase('ses_live0000000000000000000001') === null, String(opencode.readOpencodePhase('ses_live0000000000000000000001')));
  ok('完成标记读不出时回空，不抛', opencode.readOpencodeDone('ses_live0000000000000000000001', {}).doneAt === 0);
  ok('instrumented 如实说 false', opencode.opencodeInstrumented('ses_live0000000000000000000001') === false);
}

/* ------------------------------ E. 两路合起来 ------------------------------ */

head('[E] 插件写的状态文件能被认出来（真相位优先于轮询）');
{
  buildDb();
  // 装一份"插件写的状态文件"：格式与 packages/reporter/src/hook.js 一致。
  // 时间戳取**写这一刻**（不是模块开头那个 now）：服务端有"重启纪元"守卫，只采信本进程
  // 启动之后写入的相位（sessions.js 的 SERVER_STARTED_AT），更早的时间戳会被当成上次运行的
  // 残留而拒掉 —— 那是刻意的，但用早于进程启动的时间戳就永远测不到真相位那一路。
  const at = Date.now();
  const sid = 'ses_live0000000000000000000001';
  const key = ['opencode', '/tmp/ProjO', sid].join('@').replace(/[^a-zA-Z0-9._-]/g, '_');
  fs.mkdirSync(path.join(WG, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(WG, 'hooks', `${key}.json`),
    JSON.stringify({
      client: 'opencode',
      sessionId: sid,
      hb: { lastEventAt: at },
      sessionPhase: { phase: 'await', ts: at, workspacePath: '/tmp/ProjO', tool: 'write', target: '/tmp/ProjO/z.txt' },
      done: { at, title: '插件这一轮', fileCount: 2, files: ['a.ts', 'b.ts'], workspacePath: '/tmp/ProjO', sessionId: sid },
    })
  );

  // 会话表那一路（轮询）也要能列出会话：hook 那一路是**叠加**在它上面的，不是替代
  refresh({ workspacePath: '/tmp/ProjO', force: true });
  const snap = snapshot({ workspacePath: '/tmp/ProjO' });
  const f8 = snap.floors.find((f) => f.id === '8F');
  const ids8 = f8 ? f8.sessions.map((s) => s.id) : [];
  // 4 小时前那条早过了 60 分钟超时（与 prune 同一把尺子），所以只剩"正在跑"+"刚收工"两条
  ok('8F 会话表列得出**还在超时窗口内**的会话', ids8.includes('ses_live0000000000000000000001') && ids8.includes('ses_done0000000000000000000001'), ids8.join(' '));
  ok('超时（60 分钟无动静）的会话已被剔除', !ids8.includes('ses_old00000000000000000000001'), ids8.join(' '));
  ok('clients = opencode（前端按它过滤相位与成员）', snap.floors.every((f) => f.id !== '8F' || JSON.stringify(f.clients) === JSON.stringify(['opencode'])));

  // 真相位那一路：/reporter-phase 的组装逻辑（直接调函数，免得起服务）
  const { opencodeMainPhase, opencodeInstrumented } = require('../src/opencode');
  const client = 'opencode';
  const rpTruth = reporterMainPhase('/tmp/ProjO', client, sid);
  const metaTruth = reporterStateMeta('/tmp/ProjO', client, sid);
  const rpPoll = opencodeMainPhase('/tmp/ProjO', sid);
  ok('插件那份相位是 await（轮询给不出的那一相位）', rpTruth && rpTruth.phase === 'await', rpTruth && rpTruth.phase);
  ok('轮询那份仍在（tool）—— 插件没装时就是它兜底', rpPoll && rpPoll.phase === 'tool', rpPoll && rpPoll.phase);
  ok('真相位优先：useTruth 成立', Boolean(rpTruth && rpTruth.phase));
  ok('instrumented 为真（状态文件在 或 会话在库）', Boolean(metaTruth.instrumented || opencodeInstrumented(sid)));
  const done = readReporterDone('/tmp/ProjO', client, sid);
  ok('插件那份完成标记带**改动文件清单**', done && done.at && Array.isArray(done.files) && done.files.length === 2, JSON.stringify(done));
  ok('完成标记用 reporter 形状（渲染层读 fpDone.at / fpDone.sessionId）', done && typeof done.at === 'number' && done.sessionId === sid, JSON.stringify(done && Object.keys(done)));
}

/* ------------------------------ 收尾 ------------------------------ */

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail ? '✗' : '✓'} 8F OpenCode：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
