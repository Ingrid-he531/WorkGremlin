/**
 * 2F Cline 自检 —— 纯轮询楼层（Cline 没有装 WorkGremlin 的 hook，靠读它自己的落盘）。
 *
 * 跑法：`npm run test:cline`（= node 直接跑；better-sqlite3 走工程里已装好的那份）。
 * 为什么要有它：2F 的每条结论都对应"只有真的摆一份 Cline 4.x 的落盘进去才现形"的行为 ——
 * 数据根是不是 ~/.cline/data、会话怎么列、相位从消息尾巴怎么推、完成标记、逐轮清单、
 * 以及**表结构变了不许把接口打挂**。所以不 mock，把 HOME / CLINE_DATA_DIR 指到临时目录，
 * 现造一个与 Cline 4.1.25 同构的 sessions.db + 会话 JSON，让真实的 floors / floorCline 跑一遍。
 *
 * 覆盖：
 *   A. 楼层表：2F 只有一层 Cline
 *     [A1] 一层：clients = cline；一路来源（kind = cline，读数据根）
 *     [A2] 装了 VS Code 扩展（saoudrizwan.claude-dev-*）就算"装了"；数据根是 ~/.cline/data
 *   B. 会话与相位：从消息尾巴推导
 *     [B1] 会话列出来：工程路径取 workspace_root；子代理行不列
 *     [B2] 相位：assistant 尾巴是 tool_use → 调用工具（带工具名）
 *     [B3] 相位：assistant 尾巴是 thinking → 思考中
 *     [B4] 相位：assistant 尾巴是 text → 待命（这一轮说完了）
 *     [B5] 相位一律 inferred（轮询来的，不是上报的）
 *     [B6] 陈旧消息不算"正在说话"：几分钟前那条 tool_use 让相位回到待命
 *     [B7] 「思考中」带上这一轮用户说的话；模型取会话行
 *   C. 完成标记：assistant 尾巴是 text 才算
 *     [C1] 新鲜的收尾 text → 有完成标记
 *     [C2] 尾巴是 tool_use → 不算完成
 *     [C3] 过期的完成标记（DONE_TTL_MS 之外）→ 当没有
 *   D. 逐轮清单：台账「每一轮一条」的真源
 *     [D1] 轮边界 = <user_input>；用户原话 / 改动文件 / 收工判据
 *     [D2] 最后一轮带 token 真值
 *   E. 读不出来不许冒泡
 *     [E1] 库缺 sessions 表（Cline 改版换表）→ 楼层仍在、会话为空、不抛
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ 沙箱 ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cline-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const DATA = path.join(HOME, '.cline', 'data');
for (const d of [HOME, WG, DATA, path.join(DATA, 'db'), path.join(DATA, 'sessions')]) fs.mkdirSync(d, { recursive: true });
// 2F 的"装了"判定认 VS Code 扩展目录（沙箱里放一个 saoudrizwan.claude-dev-* 替身）
fs.mkdirSync(path.join(HOME, '.vscode', 'extensions', 'saoudrizwan.claude-dev-4.1.25'), { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
// 指向沙箱数据根（显式写出来，免得受调用环境影响）
process.env.CLINE_DATA_DIR = DATA;

const { detectProducts } = require('../src/floors');
const cline = require('../src/floorCline');

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

let Database = null;
try {
  Database = require('better-sqlite3');
} catch {
  console.log('better-sqlite3 不可用，跳过 2F 自检（需要先 npm install + postinstall）');
  process.exit(0);
}

/* ------------------------------ 造 Cline 的库与会话文件 ------------------------------ */

const MIN = 60_000;
const ISO = (t) => new Date(t).toISOString();

/** 建一个与 Cline 4.1.25 同构的 sessions.db（只建 2F 真正读到的列）。 */
function makeClineDb(file, rows) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, source TEXT, pid INTEGER, started_at TEXT, ended_at TEXT,
      exit_code INTEGER, status TEXT, status_lock INTEGER, interactive INTEGER, provider TEXT,
      model TEXT, cwd TEXT, workspace_root TEXT, team_name TEXT, enable_tools INTEGER,
      enable_spawn INTEGER, enable_teams INTEGER, parent_session_id TEXT, parent_agent_id TEXT,
      agent_id TEXT, conversation_id TEXT, is_subagent INTEGER, prompt TEXT, metadata_json TEXT,
      transcript_path TEXT, hook_path TEXT, messages_path TEXT, updated_at TEXT
    )
  `);
  const ins = db.prepare(`
    INSERT INTO sessions (session_id, source, status, provider, model, cwd, workspace_root, prompt,
                          metadata_json, is_subagent, messages_path, updated_at)
    VALUES (@session_id, @source, @status, @provider, @model, @cwd, @workspace_root, @prompt,
            @metadata_json, @is_subagent, @messages_path, @updated_at)
  `);
  for (const r of rows) ins.run(r);
  db.close();
  return file;
}

/** 写一份会话消息文件（Cline 的形状），返回它的绝对路径。 */
function writeConvo(id, messages, updatedAt) {
  const dir = path.join(DATA, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${id}.messages.json`);
  fs.writeFileSync(
    p,
    JSON.stringify({ version: 1, updated_at: ISO(updatedAt), agent: 'lead', sessionId: id, messages },
      null, 0),
    'utf8'
  );
  return p;
}

const text = (t) => ({ type: 'text', text: t });
const thinking = () => ({ type: 'thinking', thinking: '……' });
const toolUse = (name, input = {}) => ({ type: 'tool_use', id: `call-${Math.random().toString(36).slice(2)}`, name, input });
const toolResult = () => ({ type: 'tool_result', tool_use_id: 'x', name: 'read_files', content: [] });
const userInput = (t) => ({ type: 'text', text: `<user_input mode="act">${t}</user_input>` });
const msg = (role, content, ts) => ({ id: `msg_${Math.random().toString(36).slice(2)}`, role, content, ts });

/** 一行 sessions 表记录（默认近 1 秒内更新）。 */
function row(id, { source = 'vscode', model = 'cline-free/nemotron', cwd = '/tmp/proj', title = '', tokens = null, at = Date.now(), isSubagent = 0, messagesPath } = {}) {
  const md = { title };
  if (tokens) md.aggregateUsage = { inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cacheRead, cacheWriteTokens: tokens.cacheWrite };
  return {
    session_id: id,
    source,
    status: 'idle',
    provider: 'cline',
    model,
    cwd,
    workspace_root: cwd,
    prompt: '',
    metadata_json: JSON.stringify(md),
    is_subagent: isSubagent,
    messages_path: messagesPath || '',
    updated_at: ISO(at),
  };
}

const NOW = Date.now();
const MAIN_DB = path.join(DATA, 'db', 'sessions.db');

// main：覆盖相位 / 完成 / 逐轮
{
  const recent = NOW - 1_000;
  const stale = NOW - 5 * MIN;
  const expired = NOW - 11 * MIN;

  const pTool = writeConvo('cli-tool', [
    msg('user', [userInput('帮我跑一下测试')], NOW - 30_000),
    msg('assistant', [thinking(), text('先看看'), toolUse('run_commands', { command: 'npm test' })], recent),
  ], recent);
  const pThink = writeConvo('cli-think', [
    msg('user', [userInput('想想怎么办')], recent - 500),
    msg('assistant', [thinking()], recent),
  ], recent);
  const pIdle = writeConvo('cli-idle', [
    msg('user', [userInput('给我个总结')], NOW - 40_000),
    msg('assistant', [thinking(), text('这就是总结。')], recent),
  ], recent);
  const pStale = writeConvo('cli-stale', [
    msg('user', [userInput('很久以前那一轮')], stale - 10_000),
    msg('assistant', [thinking(), toolUse('read_files', { files: [{ path: '/tmp/proj/a.js' }] })], stale),
  ], stale);
  const pOld = writeConvo('cli-old', [
    msg('user', [userInput('十一点前那轮')], expired - 10_000),
    msg('assistant', [thinking(), text('早就说完了。')], expired),
  ], expired);
  const pHist = writeConvo('cli-hist', [
    msg('user', [userInput('第一轮任务')], NOW - 6 * MIN),
    msg('assistant', [thinking(), text('第一轮做完了'), toolUse('read_files', { files: [{ path: '/tmp/proj/src/a.js' }] })], NOW - 5 * MIN),
    msg('assistant', [text('第一轮收尾')], NOW - 4 * MIN),
    msg('user', [toolResult()], NOW - 3 * MIN),
    msg('user', [userInput('在飞这一轮')], NOW - 20_000),
    msg('assistant', [thinking(), toolUse('run_commands', { command: 'npm run build' })], NOW - 5_000),
  ], NOW - 5_000);

  makeClineDb(MAIN_DB, [
    row('cli-tool', { messagesPath: pTool, title: '跑测试', model: 'cline-free/nemotron' }),
    row('cli-think', { messagesPath: pThink, title: '想事情' }),
    row('cli-idle', { messagesPath: pIdle, source: 'cli', title: '给总结' }),
    row('cli-stale', { messagesPath: pStale, title: '很久以前' }),
    row('cli-old', { messagesPath: pOld, title: '老会话' }),
    row('cli-hist', { messagesPath: pHist, title: '两轮会话', tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 } }),
    row('cli-sub', { messagesPath: pTool, title: '子代理', isSubagent: 1 }),
  ]);
}

/* ------------------------------ 跑 ------------------------------ */

console.log('2F Cline 自检（纯轮询：读 ~/.cline/data）');

head('[A] 楼层表');
{
  const products = detectProducts({ force: true });
  const f2 = products.find((p) => p.id === '2F') || {};
  ok('[A1] 2F 是 Cline 一层', f2.name === 'Cline' && JSON.stringify(f2.clients) === JSON.stringify(['cline']), JSON.stringify([f2.name, f2.clients]));
  ok('[A1] 一路来源，kind = cline', f2.sources && f2.sources.length === 1 && f2.sources[0].kind === 'cline', JSON.stringify(f2.sources && f2.sources.map((s) => s.kind)));
  ok('[A2] 数据根是 ~/.cline/data', f2.sources && f2.sources[0].dataPath === DATA, f2.sources && f2.sources[0].dataPath);
  ok('[A2] 装了扩展 → 楼层算"已安装"', f2.installed === true, String(f2.installed));
}

head('[B] 会话与相位');
{
  const list = cline.listClineSessions();
  const ids = list.map((s) => s.id);
  ok('[B1] 列出顶层会话，子代理行不列', ids.includes('cli-tool') && !ids.includes('cli-sub'), JSON.stringify(ids));
  const tool = list.find((s) => s.id === 'cli-tool') || {};
  ok('[B1] 工程路径取 workspace_root', tool.projectPath === '/tmp/proj' && tool.project === 'proj', JSON.stringify([tool.projectPath, tool.project]));
  ok('[B1] 形态来自 source（vscode → vscode）', tool.form === 'vscode', tool.form);

  const phTool = cline.readClinePhase('cli-tool') || {};
  ok('[B2] assistant 尾巴 tool_use → 调用工具（带工具名）', phTool.phase === 'tool' && phTool.tool === 'run_commands' && /npm test/.test(phTool.action), JSON.stringify(phTool));
  ok('[B5] 相位一律 inferred', phTool.inferred === true, String(phTool.inferred));
  ok('[B7] 带上这一轮用户说的话', phTool.prompt === '帮我跑一下测试', phTool.prompt);
  ok('[B7] 模型取会话行', phTool.model === 'cline-free/nemotron', phTool.model);

  const phThink = cline.readClinePhase('cli-think') || {};
  ok('[B3] assistant 尾巴 thinking → 思考中', phThink.phase === 'thinking', phThink.phase);
  ok('[B7] 思考中带上用户原话', phThink.prompt === '想想怎么办', phThink.prompt);

  const phIdle = cline.readClinePhase('cli-idle') || {};
  ok('[B4] assistant 尾巴 text → 待命', phIdle.phase === 'idle', phIdle.phase);

  const phStale = cline.readClinePhase('cli-stale') || {};
  ok('[B6] 陈旧 tool_use → 待命（不是永远"调用工具"）', phStale.phase === 'idle', phStale.phase);

  const cidle = list.find((s) => s.id === 'cli-idle') || {};
  ok('[B1] 形态来自 source（cli → cli）', cidle.form === 'cli', cidle.form);
}

head('[C] 完成标记');
{
  const dIdle = cline.readClineDone('cli-idle', {});
  ok('[C1] 新鲜收尾 text → 有完成标记', Number(dIdle.doneAt) > 0, JSON.stringify(dIdle));
  ok('[C1] 收尾文字带上了', dIdle.doneSaid === '这就是总结。', dIdle.doneSaid);
  const dTool = cline.readClineDone('cli-tool', {});
  ok('[C2] 尾巴 tool_use → 不算完成', !dTool.doneAt, JSON.stringify(dTool));
  const dOld = cline.readClineDone('cli-old', {});
  ok('[C3] 过期的完成标记 → 当没有', !dOld.doneAt, JSON.stringify(dOld));
}

head('[D] 逐轮清单');
{
  const rounds = cline.readClineRounds('cli-hist');
  ok('[D1] 两轮（<user_input> 为边界）', rounds.length === 2, JSON.stringify(rounds.map((r) => r.index)));
  const r0 = rounds[0] || {};
  const r1 = rounds[1] || {};
  ok('[D1] 第一轮：原话 + 收工', r0.prompt === '第一轮任务' && r0.outcome === 'done' && Number(r0.endedAt) > 0, JSON.stringify(r0));
  ok('[D1] 第一轮改动文件只留工具碰过的路径', Array.isArray(r0.files) && r0.files.includes('/tmp/proj/src/a.js'), JSON.stringify(r0.files));
  ok('[D1] 在飞那轮：running', r1.prompt === '在飞这一轮' && r1.outcome === 'running' && !r1.endedAt, JSON.stringify(r1));
  ok('[D2] 最后一轮带 token 真值', r1.tokens && r1.tokens.input === 100 && r1.tokens.output === 20, JSON.stringify(r1.tokens));
}

head('[E] 读不出来不许冒泡');
{
  // 换一个只有别名的库：Cline 改版换表时，2F 得"读不出会话"而不是崩
  const BAD = path.join(DATA, 'db', 'bad.db');
  const db = new Database(BAD);
  db.exec('CREATE TABLE other (x TEXT)');
  db.close();
  process.env.WORKGREMLIN_CLINE_DB = BAD;
  let threw = false;
  let list = null;
  try {
    list = cline.listClineSessions();
  } catch {
    threw = true;
  }
  ok('[E1] 缺表 → 会话为空且不抛', !threw && Array.isArray(list) && list.length === 0, JSON.stringify(list));
  ok('[E1] 读相位也不抛（会话不在 → null）', cline.readClinePhase('nope') === null);
  const f2 = detectProducts({ force: true }).find((p) => p.id === '2F') || {};
  ok('[E1] 楼层仍列着（只是没会话）', f2.name === 'Cline');
  delete process.env.WORKGREMLIN_CLINE_DB;
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
