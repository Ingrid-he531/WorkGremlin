/**
 * 2F Cline self-test — a pure poll floor (WorkGremlin does not install into Cline's hooks; it reads
 * Cline's own on-disk store).
 *
 * Run: `npm run test:cline` (= node directly; better-sqlite3 uses the copy already installed in the repo).
 * Why it exists: every 2F conclusion corresponds to behavior that only shows up with a *real* Cline 4.x
 * store in place — is the data root ~/.cline/data, how sessions are listed, how the phase is derived from
 * the message tail, the done marker, the per-turn list, and **a schema change must not take the endpoint
 * down**. So nothing is mocked: HOME / CLINE_DATA_DIR point at a temp dir, and a sessions.db + session
 * JSON isomorphic to Cline 4.1.25 are built, then the real floors / floorCline run over them.
 *
 * Coverage:
 *   A. Floor table: 2F is one floor, Cline
 *     [A1] one floor: clients = cline; one source (kind = cline, reading the data root)
 *     [A2] the VS Code extension (saoudrizwan.claude-dev-*) counts as "installed"; data root is ~/.cline/data
 *   B. Sessions and phase: derived from the message tail
 *     [B1] sessions are listed: project path from workspace_root; subagent rows are not listed
 *     [B2] phase: assistant tail is tool_use -> calling a tool (with the tool name)
 *     [B3] phase: assistant tail is thinking -> thinking
 *     [B4] phase: assistant tail is text -> idle (the turn finished speaking)
 *     [B5] every phase is inferred (polled, not reported)
 *     [B6] a stale message is not "still speaking": the tool_use from minutes ago falls back to idle
 *     [B7] "thinking" carries what the user said this turn; the model comes from the session row
 *   C. Done marker: only an assistant tail of text counts
 *     [C1] a fresh closing text -> a done marker
 *     [C2] tail is tool_use -> not done
 *     [C3] an expired done marker (beyond DONE_TTL_MS) -> treated as absent
 *   D. Per-turn list: the source of the ledger's "one row per turn"
 *     [D1] turn boundary = <user_input>; the user's words / finish test (no changed files: Cline cannot see them)
 *     [D2] the last turn carries the real token values
 *   E. Unreadable must not bubble
 *     [E1] the db lacks the sessions table (Cline changes its schema) -> floor still listed, sessions empty, no throw
 *   G. Council isolation
 *     [G1] a session whose title carries COUNCIL_PROMPT_MARKER is skipped; a mere mention is not
 *   H. Terminal sessions
 *     [H1] a finished (terminal) session is not listed; [H2] its existing registry row is retracted; [H3] in-flight ones stay
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ Sandbox ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cline-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const DATA = path.join(HOME, '.cline', 'data');
for (const d of [HOME, WG, DATA, path.join(DATA, 'db'), path.join(DATA, 'sessions')]) fs.mkdirSync(d, { recursive: true });
// 2F's "installed" test recognizes the VS Code extension dir (put a stand-in saoudrizwan.claude-dev-* in the sandbox)
fs.mkdirSync(path.join(HOME, '.vscode', 'extensions', 'saoudrizwan.claude-dev-4.1.25'), { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
// Point at the sandbox data root (written explicitly so the calling environment cannot shift it)
process.env.CLINE_DATA_DIR = DATA;

const { detectProducts, agentDescription, detectLevel } = require('../src/floors');
const cline = require('../src/floorCline');
const { DEFAULTS } = require('@workgremlin/shared');

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

/* ------------------------------ Build Cline's db and conversation files ------------------------------ */

const MIN = 60_000;
const ISO = (t) => new Date(t).toISOString();

/** Build a sessions.db isomorphic to Cline 4.1.25 (only the columns 2F actually reads). */
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
    INSERT INTO sessions (session_id, source, status, ended_at, provider, model, cwd, workspace_root, prompt,
                          metadata_json, is_subagent, messages_path, updated_at, parent_session_id, started_at)
    VALUES (@session_id, @source, @status, @ended_at, @provider, @model, @cwd, @workspace_root, @prompt,
            @metadata_json, @is_subagent, @messages_path, @updated_at, @parent_session_id, @started_at)
  `);
  for (const r of rows) ins.run(r);
  db.close();
  return file;
}

/** Write one conversation file (Cline's shape) and return its absolute path. */
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

/** One sessions-table record (updated ~1 second ago by default). */
function row(id, { source = 'vscode', model = 'cline-free/nemotron', cwd = '/tmp/proj', title = '', tokens = null, at = Date.now(), isSubagent = 0, messagesPath, status = 'idle', endedAt = 0, parentSessionId = null, prompt = '', startedAt = 0 } = {}) {
  const md = { title };
  if (tokens) md.aggregateUsage = { inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cacheRead, cacheWriteTokens: tokens.cacheWrite };
  return {
    session_id: id,
    source,
    status,
    // Cline stamps ended_at when the session finishes; a cancelled session carries it too.
    ended_at: endedAt ? ISO(endedAt) : null,
    provider: 'cline',
    model,
    cwd,
    workspace_root: cwd,
    prompt,
    metadata_json: JSON.stringify(md),
    is_subagent: isSubagent,
    messages_path: messagesPath || '',
    updated_at: ISO(at),
    parent_session_id: parentSessionId,
    started_at: startedAt ? ISO(startedAt) : null,
  };
}

const NOW = Date.now();
const MAIN_DB = path.join(DATA, 'db', 'sessions.db');

// main: covers phase / done / per-turn
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
  // Cancelled: the conversation ends on a user prompt (no closing assistant text), and Cline stamped the
  // session terminal. The transcript alone cannot tell "still working" from "user pressed stop".
  const pCancelEnd = writeConvo('cli-cancel-end', [
    msg('user', [userInput('帮我改一下配置')], NOW - 4 * MIN),
    msg('assistant', [thinking(), toolUse('run_commands', { command: 'npm test' })], NOW - 3 * MIN),
    msg('user', [toolResult()], NOW - 3 * MIN + 1_000),
  ], NOW - 90_000);
  // Cancelled then retried: a new prompt opened while the previous turn never closed.
  const pCancelNext = writeConvo('cli-cancel-next', [
    msg('user', [userInput('第一轮')], NOW - 5 * MIN),
    msg('assistant', [thinking(), toolUse('read_files', { files: [{ path: '/tmp/proj/a.js' }] })], NOW - 4 * MIN),
    msg('user', [userInput('第二轮')], NOW - 3 * MIN),
    msg('assistant', [thinking(), text('第二轮完成')], NOW - 2 * MIN),
  ], NOW - 2 * MIN);

  makeClineDb(MAIN_DB, [
    row('cli-tool', { messagesPath: pTool, title: '跑测试', model: 'cline-free/nemotron' }),
    row('cli-think', { messagesPath: pThink, title: '想事情' }),
    row('cli-idle', { messagesPath: pIdle, source: 'cli', title: '给总结' }),
    row('cli-stale', { messagesPath: pStale, title: '很久以前' }),
    row('cli-old', { messagesPath: pOld, title: '老会话' }),
    row('cli-hist', { messagesPath: pHist, title: '两轮会话', tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 } }),
    row('cli-cancel-end', { messagesPath: pCancelEnd, title: '被取消那轮', status: 'cancelled', endedAt: NOW - 90_000 }),
    row('cli-cancel-next', { messagesPath: pCancelNext, title: '取消后重试' }),
    row('cli-sub', { messagesPath: pTool, title: '子代理', isSubagent: 1 }),
    // A council participant: Cline stores the prompt itself as the session title, and the council prompt
    // always opens with COUNCIL_PROMPT_MARKER. 2F must skip it (else in workspace mode it would surface on
    // the office's 2F, violating requirements.md §15.2).
    row('cli-council', { messagesPath: pIdle, title: `你是 ${DEFAULTS.COUNCIL_PROMPT_MARKER}里【2F Cline】这一层的代表` }),
    // The other direction: a title that merely mentions the word must NOT be filtered (the marker is the
    // exact phrase, not a loose keyword).
    row('cli-mentions', { messagesPath: pIdle, title: '讨论议事厅要不要加楼层' }),
  ]);
}

/* ------------------------------ Run ------------------------------ */

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
  ok('[D1] 改动文件字段存在且为数组（无写工具则为空数组）', Array.isArray(r0.files) && r0.files.length === 0, JSON.stringify(r0.files));
  ok('[D1] 收尾文字作为任务详情的「输出」', r0.result === '第一轮收尾', JSON.stringify(r0.result));
  ok('[D1] 在飞那轮：running', r1.prompt === '在飞这一轮' && r1.outcome === 'running' && !r1.endedAt, JSON.stringify(r1));
  ok('[D2] 最后一轮带 session-level token 真值', !r0.tokens && r1.tokens && r1.tokens.input === 100 && r1.tokens.output === 20, JSON.stringify({ r0: r0.tokens, r1: r1.tokens }));
}

head('[F] 取消检测：以 Cline 自己的会话终态为准');
{
  // The transcript ends on a user prompt with no closing assistant text. Cline's sessions.status /
  // ended_at is the only signal that says "this was a stop, not work in progress".
  const roundsEnd = cline.readClineRounds('cli-cancel-end');
  const rEnd = roundsEnd[roundsEnd.length - 1] || {};
  ok('[F1] 会话终态 cancelled → 尾巴那轮判 cancelled（不再永远 running）', rEnd.outcome === 'cancelled' && Number(rEnd.endedAt) > 0, JSON.stringify(rEnd));

  const dEnd = cline.readClineDone('cli-cancel-end', {});
  ok('[F2] 新鲜取消 → 完成标记带 doneCancelled（主控台亮"任务取消"）', dEnd.doneCancelled === true && Number(dEnd.doneAt) > 0, JSON.stringify(dEnd));

  // A new prompt while the previous turn is still open = that turn was interrupted.
  const roundsNext = cline.readClineRounds('cli-cancel-next');
  ok('[F3] 新一轮 prompt 顶掉没收尾的上一轮 → 上一轮 cancelled', roundsNext[0] && roundsNext[0].outcome === 'cancelled' && Number(roundsNext[0].endedAt) > 0, JSON.stringify(roundsNext[0]));
  ok('[F3] 正常收尾的那轮仍是 done', roundsNext[1] && roundsNext[1].outcome === 'done', JSON.stringify(roundsNext[1]));

  // Guard the other direction: while the session is running, an open trailing turn is genuinely running.
  const roundsLive = cline.readClineRounds('cli-hist');
  ok('[F4] 会话仍在跑 → 开着的轮保持 running（不误判取消）', roundsLive[1] && roundsLive[1].outcome === 'running' && !roundsLive[1].endedAt, JSON.stringify(roundsLive[1]));
}

head('[G] 议事厅参与者不进 2F（标题带 COUNCIL_PROMPT_MARKER）');
{
  const list = cline.listClineSessions();
  ok('[G1] 标题带标记的参与者会话被跳过', !list.some((s) => s.id === 'cli-council'), JSON.stringify(list.map((s) => s.id)));
  // Exact phrase, not a loose keyword: an ordinary session that merely mentions it stays listed.
  ok('[G2] 普通会话只是提到这个词 → 照常列出', list.some((s) => s.id === 'cli-mentions'), JSON.stringify(list.map((s) => s.id)));
}

head('[H] 终态会话立刻回收（源里标了结束就不进下拉）');
{
  // Fake registry context: `table` is a Map, claim/upsert record what the handler did.
  const table = new Map();
  const upserts = [];
  const ctx = {
    claim: () => true,
    upsert: (e) => {
      upserts.push(e);
      table.set(`${e.floor}:${e.id}`, e);
    },
    now: Date.now(),
    workspacePath: '',
    TIMEOUT_MS: 60 * 60_000,
    reporterMainPhase: () => null,
    readReporterDone: () => null,
    doneFieldsFromReporter: () => ({}),
    table,
  };
  // cli-cancel-end is status=cancelled + ended_at (terminal); cli-hist is still in flight.
  table.set('2F:cli-cancel-end', { floor: '2F', id: 'cli-cancel-end' });
  cline.kindHandlers.cline({ id: '2F' }, { kind: 'cline', client: 'cline' }, ctx);
  ok('[H1] 终态会话不进下拉', !upserts.some((e) => e.id === 'cli-cancel-end'), JSON.stringify(upserts.map((e) => e.id)));
  ok('[H2] 已存在的终态行被撤回', !table.has('2F:cli-cancel-end'));
  ok('[H3] 在飞的会话照常列出（不误伤）', upserts.some((e) => e.id === 'cli-hist'), JSON.stringify(upserts.map((e) => e.id)));
}

head('[I] 静态子代理：Cline 的 YAML / YML 定义进入名册');
{
  const PROJ = path.join(TMP, 'yaml-project');
  const userAgents = path.join(HOME, '.cline', 'agents');
  const projectAgents = path.join(PROJ, '.cline', 'agents');
  fs.mkdirSync(userAgents, { recursive: true });
  fs.mkdirSync(projectAgents, { recursive: true });
  fs.writeFileSync(
    path.join(userAgents, 'ingrid.yaml'),
    [
      '---',
      'name: Ingrid',
      'description: "资深编程专家：负责复杂代码库的设计、实现、调试、重构与审查。"',
      '---',
      '',
      'You are Ingrid.',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(projectAgents, 'reviewer.yml'),
    ['name: Reviewer', 'description: Reviews changes for regressions.', ''].join('\n'),
    'utf8'
  );

  const dirs = cline.agentDirs(PROJ);
  ok(
    '[I1] 项目级 <ws>/.cline/agents + 用户级 ~/.cline/agents 都在候选里',
    dirs.some((d) => d.level === 'project' && d.dir === projectAgents) &&
      dirs.some((d) => d.level === 'user' && d.dir === userAgents),
    JSON.stringify(dirs)
  );

  const registered = [];
  const removed = [];
  cline.syncAgents({
    project: 'p1',
    workspacePath: PROJ,
    registerAgent: (a) => registered.push(a),
    unregisterAgent: (n) => removed.push(n),
  });
  const byName = Object.fromEntries(registered.map((a) => [a.name, a]));
  ok('[I2] ingrid.yaml 注册为用户级 cline 子代理', byName.ingrid && byName.ingrid.level === 'user' && byName.ingrid.client === 'cline', JSON.stringify(registered));
  ok('[I2] reviewer.yml 注册为项目级 cline 子代理', byName.reviewer && byName.reviewer.level === 'project' && byName.reviewer.client === 'cline', JSON.stringify(registered));
  ok('[I2] 第一次同步没有误删', removed.length === 0, JSON.stringify(removed));
  ok('[I3] YAML 的 description 读得到', agentDescription('ingrid', PROJ, 'cline').startsWith('资深编程专家'), agentDescription('ingrid', PROJ, 'cline'));
  ok('[I3] 级别判定按目录', detectLevel('ingrid', PROJ, 'cline') === 'user' && detectLevel('reviewer', PROJ, 'cline') === 'project');
}

head('[J] 子代理会话 → 2F 幽灵（spawn / retire）');
{
  const SUB_DB = path.join(DATA, 'db', 'subagents.db');
  const pParent = writeConvo('cli-parent', [
    msg('user', [userInput('让两个子代理干活')], NOW - 20_000),
    msg('assistant', [thinking(), toolUse('subagent_ingrid', { prompt: '审查这个改动' })], NOW - 19_000),
    msg('assistant', [toolUse('subagent_reviewer', { prompt: '检查测试' })], NOW - 18_000),
  ], NOW - 18_000);
  const pActive = writeConvo('cli-child-active', [
    msg('user', [text('审查这个改动')], NOW - 17_000),
    msg('assistant', [thinking()], NOW - 1_000),
  ], NOW - 1_000);
  const pDone = writeConvo('cli-child-done', [
    msg('user', [text('检查测试')], NOW - 17_500),
    msg('assistant', [text('检查完成，没有回归。')], NOW - 16_000),
  ], NOW - 16_000);
  makeClineDb(SUB_DB, [
    row('cli-parent', { messagesPath: pParent, title: '父会话' }),
    row('cli-child-active', {
      messagesPath: pActive,
      status: 'running',
      at: NOW - 1_000,
      isSubagent: 1,
      parentSessionId: 'cli-parent',
      prompt: '审查这个改动',
      startedAt: NOW - 17_000,
    }),
    row('cli-child-done', {
      messagesPath: pDone,
      status: 'completed',
      endedAt: NOW - 16_000,
      at: NOW - 16_000,
      isSubagent: 1,
      parentSessionId: 'cli-parent',
      prompt: '检查测试',
      startedAt: NOW - 17_500,
    }),
  ]);
  process.env.WORKGREMLIN_CLINE_DB = SUB_DB;

  const calls = [];
  const bus = {
    ghostSpawn: (p) => {
      calls.push(['spawn', p]);
      return { memberId: `subagent-${p.name}`, runId: 1 };
    },
    ghostRetire: (p) => {
      calls.push(['retire', p]);
      return true;
    },
  };
  const n = cline.syncClineSubagents({ bus });
  const spawn = calls.find((c) => c[0] === 'spawn' && c[1].id === 'cli-child-active');
  const retire = calls.find((c) => c[0] === 'retire' && c[1].id === 'cli-child-done');
  ok('[J1] 两条子代理行都同步了', n === 2, String(n));
  ok(
    '[J1] 在飞的子代理 → spawn（子会话 id / 父会话 id / 工具名）',
    Boolean(spawn) && spawn[1].sessionId === 'cli-parent' && spawn[1].name === 'ingrid' && spawn[1].task === '审查这个改动',
    JSON.stringify(spawn)
  );
  ok(
    '[J1] 终态子代理 → retire（工具名 + 子代理最后的文字）',
    Boolean(retire) && retire[1].sessionId === 'cli-parent' && retire[1].name === 'reviewer' && retire[1].result === '检查完成，没有回归。',
    JSON.stringify(retire)
  );

  // No top-level sessions (the parent row is gone): syncTasks must still reach the child sync before
  // its early return, and an orphaned child keeps its own project attribution from its row.
  const ORPHAN_DB = path.join(DATA, 'db', 'orphan-subagent.db');
  makeClineDb(ORPHAN_DB, [
    row('cli-orphan', {
      status: 'running',
      isSubagent: 1,
      parentSessionId: 'gone-parent',
      prompt: '孤儿任务',
      startedAt: NOW - 5_000,
    }),
  ]);
  process.env.WORKGREMLIN_CLINE_DB = ORPHAN_DB;
  const orphanCalls = [];
  const orphanBus = {
    ghostSpawn: (p) => {
      orphanCalls.push(p);
      return { memberId: 'subagent-subagent', runId: 1 };
    },
    ghostRetire: () => true,
  };
  const tasks = cline.syncClineTasks({ bus: orphanBus, repo: null });
  ok(
    '[J2] 顶层会话为空时仍同步子代理（早退之前）',
    tasks === 0 && orphanCalls.length === 1 && orphanCalls[0].id === 'cli-orphan' && orphanCalls[0].sessionId === 'gone-parent',
    JSON.stringify({ tasks, orphanCalls })
  );
}

head('[E] 读不出来不许冒泡');{
  // Swap in a db with only an unrelated table: when Cline changes its schema, 2F must "read no sessions" and not crash
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
