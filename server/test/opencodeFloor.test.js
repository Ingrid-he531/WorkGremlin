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
 *     [C5] 逐轮清单带 token 真值（reasoning 并进 output）；这一轮一条都没读到 → null 留空
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

const { detectProducts } = require('../src/floors');
const { DEFAULTS } = require('@workgremlin/shared');
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
  // 议事厅参与者的会话：与上面几条**同一个工程、同样新鲜**，只有标题不同。
  // 它必须不出现在任何一份会话清单里（见 opencode.js 的 listOpencodeSessionsUncached），
  // 所以它的存在不会改上面任何一条计数 —— 这条 fixture 本身就是下面 [G] 断言的一半：
  // 光断言"没列出来"证明不了什么，得先有这一行在库里。
  ins.run({
    id: 'ses_council00000000000000000001', parent: null, dir: '/tmp/ProjO', title: DEFAULTS.COUNCIL_SESSION_TITLE,
    model: '{"id":"space-bunny-free","providerID":"opencode"}', files: 1, created: now - 60_000, updated: now, archived: null,
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
  ok('这一层接纳 opencode 与 opencode-plugin 两种上报身份', floor && JSON.stringify(floor.clients) === JSON.stringify(['opencode', 'opencode-plugin']), floor && JSON.stringify(floor.clients));
  ok(
    '两路来源：opencode（轮询产会话 + 数据根落盘统计，标 CLI/Desktop）+ hook（收插件真相位）',
    floor && floor.sources.length === 2 && floor.sources.map((s) => s.kind).join(',') === 'opencode,hook' && floor.sources[0].label === 'CLI/Desktop',
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
    'opencode 那一路带着数据根，并说明"会话是 SQLite、不是可扫的文件"',
    Boolean(floor && floor.sources[0].dataPathLabel) && floor.sources[0].sessions !== false && /SQLite/.test(floor.sources[0].note || ''),
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
  // [B4b] 回归（2026-09-28 实测）：这一轮的 assistant 消息 parts 是 [reasoning, text]，
  // **还没写完**（没有 time.completed）。从后往前扫先撞到 text —— 早先把 text 一律当待命，
  // 于是整轮都显示"待命/任务完成"，看不到"思考中"。正在流式的 text 应该算思考中。
  const dbIn = new Database(DB);
  const streaming = { time: { created: now - 3_000 }, content: [{ type: 'reasoning', text: '在想' }, { type: 'text', text: '正在往外吐字' }] };
  dbIn.prepare('UPDATE session_message SET data=? WHERE session_id=? AND seq=2').run(JSON.stringify(streaming), 'ses_live0000000000000000000001');
  dbIn.close();
  const phStream = opencode.readOpencodePhase('ses_live0000000000000000000001');
  ok('流式中的 text → 思考中（不是待命）', phStream && phStream.phase === 'thinking', phStream && phStream.phase);

  const dbDone = new Database(DB);
  dbDone.prepare('UPDATE session_message SET data=? WHERE session_id=? AND seq=2').run(
    JSON.stringify({ ...streaming, time: { created: now - 3_000, completed: now - 1_000 }, finish: 'stop' }),
    'ses_live0000000000000000000001'
  );
  dbDone.close();
  const phDone = opencode.readOpencodePhase('ses_live0000000000000000000001');
  ok('写完（有 completed + finish=stop）的 text → 待命', phDone && phDone.phase === 'idle', phDone && phDone.phase);

  // 工具步：这一步以"要调工具"收尾（finish=tool-calls），而工具块落盘时**常常已经跑完**
  // （`read` 这种毫秒级），status 是 completed —— 早先只认 running，于是整轮看不到"调用工具"
  // （实测 2026-09-28：一轮 10 次工具调用，1.5s 采样只撞到 1 帧）。现在"以调工具收尾、
  // 下一步还没出现"就算在用工具。
  const dbTool = new Database(DB);
  dbTool.prepare('UPDATE session_message SET data=? WHERE session_id=? AND seq=2').run(
    JSON.stringify({
      time: { created: now - 3_000, streamed: now - 2_500, completed: now - 2_000 },
      finish: 'tool-calls',
      content: [
        { type: 'reasoning', text: '先看一下' },
        { type: 'tool', name: 'read', state: { status: 'completed', input: { path: '/tmp/ProjO/a.js' } } },
      ],
    }),
    'ses_live0000000000000000000001'
  );
  dbTool.close();
  const phTool = opencode.readOpencodePhase('ses_live0000000000000000000001');
  ok(
    '以调工具收尾的步（finish=tool-calls、工具已 completed）→ 调用工具',
    phTool && phTool.phase === 'tool' && phTool.tool === 'read',
    phTool && JSON.stringify({ phase: phTool.phase, tool: phTool.tool, action: phTool.action })
  );

  // 轮次刚开跑：最新一条是 **user** 消息（assistant 行还没写出来）→ 思考中，不是待命。
  // 实测 2026-09-28：缺这条时，用户发完消息后那十几秒主控制台显示"待命"，
  // 整轮采样里只有 tool → idle 在来回切，看不到"思考中"。
  const dbUser = new Database(DB);
  dbUser
    .prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
    .run(
      'ses_live0000000000000000000001#96',
      'ses_live0000000000000000000001',
      'user',
      96,
      now,
      now,
      JSON.stringify({ time: { created: now }, text: '刚发的一句话' })
    );
  dbUser.close();
  const phUser = opencode.readOpencodePhase('ses_live0000000000000000000001');
  ok('最新是 user 消息（assistant 还没出来）→ 思考中', phUser && phUser.phase === 'thinking', phUser && phUser.phase);
  ok('「思考中」带上这句话', phUser && phUser.prompt === '刚发的一句话', phUser && phUser.prompt);
  const dbUserClean = new Database(DB);
  dbUserClean.prepare('DELETE FROM session_message WHERE session_id=? AND seq=96').run('ses_live0000000000000000000001');
  dbUserClean.close();

  // 还原成 fixture 原本的"正在跑（shell running）"，后面的用例继续按原状态跑
  const dbRestore = new Database(DB);
  dbRestore.prepare('UPDATE session_message SET data=? WHERE session_id=? AND seq=2').run(
    JSON.stringify({
      time: { created: now - 5_000, streamed: now - 4_000 },
      content: [
        { type: 'reasoning', text: '先看文件' },
        { type: 'tool', name: 'shell', state: { status: 'running', input: { command: 'ls -la /tmp/ProjO' } } },
      ],
    }),
    'ses_live0000000000000000000001'
  );
  dbRestore.close();

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

/* ------------------------------ C2. 被打断的那一轮 → 取消标记 ------------------------------ */

head('[C2] 被打断的一轮（idle.outcome=interrupted）→ 完成标记带 doneCancelled（主控制台亮红色「任务取消」）');
{
  const db = new Database(DB);
  const sid = 'ses_cancel00000000000000000001';
  db.prepare(
    `INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, agent, model,
                             cost, summary_files, time_created, time_updated, time_idle, idle_outcome, time_archived, time_suspended)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(sid, 'proj', null, 'slug', '/tmp/ProjO', '被打断的那条', '2.0.18', 'build', '{"id":"x"}', 0, 1, now - 60_000, now - 1_000, null, 'interrupted', null, null);
  const msg = db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)`
  );
  const put = (seq, type, data, at) => msg.run(`${sid}#${seq}`, sid, type, seq, at, at, JSON.stringify(data));
  put(1, 'user', { time: { created: now - 50_000 }, text: '改点东西' }, now - 50_000);
  put(2, 'assistant', { time: { created: now - 40_000, completed: now - 30_000 }, finish: 'tool-calls', content: [{ type: 'text', text: '改到一半' }] }, now - 30_000);
  // 显式空闲标记：用户终止了这一轮（没有 finish=stop 的 assistant 消息）
  put(3, 'idle', { time: { created: now - 1_000 }, outcome: 'interrupted' }, now - 1_000);
  db.close();

  const d = opencode.readOpencodeDone(sid, { title: '被打断的那条' });
  ok('被打断的一轮也回一枚完成标记（不然主控制台拿不到"这一轮结束了"）', d && d.doneAt > 0, JSON.stringify(d));
  ok('且带 doneCancelled=true（→ 红色「任务取消」，不是「任务完成」）', d && d.doneCancelled === true, JSON.stringify(d));
  ok('正常完成的那条 doneCancelled=false（不臆造取消）', opencode.readOpencodeDone('ses_done0000000000000000000001', {}).doneCancelled === false);
}

/* ------------------------------ C3. 每一轮的 token 真值 ------------------------------ */

head('[C5] 逐轮清单带 token 真值（reasoning 并进 output）；这一轮一条都没读到 → null 留空');
{
  const db = new Database(DB);
  const sid = 'ses_tokens00000000000000000001';
  const msg = db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)`
  );
  const put = (seq, type, data, at) => msg.run(`${sid}#${seq}`, sid, type, seq, at, at, JSON.stringify(data));

  // 第 0 轮：两条 assistant 各带一份 tokens。形状与语义**同 7F Kilo**（input 不含缓存、reasoning 单列），
  // 所以折法也一样：reasoning 并进 output（Claude 的 output_tokens 本来就含思考）。
  put(1, 'user', { time: { created: now - 40 * 60_000 }, text: '把 token 落库' }, now - 40 * 60_000);
  put(
    2,
    'assistant',
    {
      time: { created: now - 39 * 60_000, completed: now - 38 * 60_000 },
      finish: 'tool-calls',
      tokens: { input: 100, output: 30, reasoning: 20, cache: { read: 5, write: 5 } },
      content: [{ type: 'text', text: '落好了' }],
    },
    now - 38 * 60_000
  );
  // 同一轮的第二次请求：token 逐条累加（一轮里可能有多次 API 请求）
  put(
    3,
    'assistant',
    {
      time: { created: now - 37 * 60_000, completed: now - 36 * 60_000 },
      finish: 'stop',
      tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 20, write: 0 } },
      content: [{ type: 'text', text: '都好了' }],
    },
    now - 36 * 60_000
  );
  put(4, 'idle', { time: { created: now - 35 * 60_000 }, outcome: 'succeeded' }, now - 35 * 60_000);

  // 第 1 轮：assistant 行里**没有** tokens（老版本 OpenCode 不写 / 这一轮还没跑完一次请求）
  // —— 这一轮回 null，让台账留空，不写 4 个 0 冒充"消耗为零"。
  put(5, 'user', { time: { created: now - 20 * 60_000 }, text: '这一轮没数' }, now - 20 * 60_000);
  put(
    6,
    'assistant',
    { time: { created: now - 19 * 60_000, completed: now - 18 * 60_000 }, finish: 'stop', content: [{ type: 'text', text: '嗯' }] },
    now - 18 * 60_000
  );
  put(7, 'idle', { time: { created: now - 17 * 60_000 }, outcome: 'succeeded' }, now - 17 * 60_000);
  db.close();

  const turns = opencode.readOpencodeTurns(sid);
  const t0 = turns[0] && turns[0].tokens;
  ok('两条 assistant 的 token 逐条累加（input 100+10）', t0 && t0.input === 110, JSON.stringify(t0));
  ok('reasoning 并进 output（30+20+10=60，不是 40）', t0 && t0.output === 60, t0 && String(t0.output));
  ok('缓存读 / 写分列原样取（read 5+20、write 5+0）', t0 && t0.cacheRead === 25 && t0.cacheWrite === 5, JSON.stringify(t0));
  ok('这一轮一条 tokens 都没读到 → null（不是 4 个 0）', turns[1] && turns[1].tokens === null, JSON.stringify(turns[1] && turns[1].tokens));
}

/* ------------------------- G. 议事厅参与者不进办公室 ------------------------- */

head('[G] 议事厅参与者（title = COUNCIL_SESSION_TITLE）不出现在 8F 的会话表里');
{
  // 为什么值得单独钉：OpenCode 把会话记在**全局** SQLite 里，`session_v2.directory` 是当时的
  // cwd。工程模式下参与者的 cwd 就是用户的工程 —— 不挡的话它当场变成办公室 8F 上多出来的
  // 一个"会话"，而 requirements.md §15.2 写死了「那两页看不出任何痕迹」。
  const COUNCIL_SID = 'ses_council00000000000000000001';
  // 先证明那一行**真的在库里**（否则"没列出来"可能只是 fixture 压根没插进去，测了个寂寞）
  const db = new Database(DB, { readonly: true });
  const row = db.prepare('SELECT id, title, directory FROM session_v2 WHERE id = ?').get(COUNCIL_SID);
  db.close();
  ok(
    '参与者的会话行确实在库里（同工程、标题就是那个标记）',
    Boolean(row) && row.title === DEFAULTS.COUNCIL_SESSION_TITLE && row.directory === '/tmp/ProjO',
    JSON.stringify(row)
  );

  const ids = opencode.listOpencodeSessions().map((s) => s.id);
  ok('但它不出现在 8F 的会话清单里', !ids.includes(COUNCIL_SID), ids.join(' '));
  ok('同一工程里的用户会话照常列出来（挡的是这一条，不是整个工程）', ids.includes('ses_live0000000000000000000001'), ids.join(' '));

  // 过滤判据是"标题"这个约定：一头在 agents.js（发 --title），另一头在 opencode.js（跳过它）。
  // 两头不一致的话过滤会**静默失效**，所以直接把它们对起来钉死。
  const args = require('../src/council/agents').RECIPES['8F'].build({ bin: 'opencode', prompt: 'x', allow: 'none' }).args;
  const at = args.indexOf('--title');
  ok('8F 配方发的标题 = 这里过滤的标题（两头不一致 = 过滤白写）', at >= 0 && args[at + 1] === DEFAULTS.COUNCIL_SESSION_TITLE, JSON.stringify(args));
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
  ok('clients = opencode + opencode-plugin（前端按它过滤相位与成员）', snap.floors.every((f) => f.id !== '8F' || JSON.stringify(f.clients) === JSON.stringify(['opencode', 'opencode-plugin'])));

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
