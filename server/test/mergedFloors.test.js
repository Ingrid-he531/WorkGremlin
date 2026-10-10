/**
 * 合并楼层自检 —— 1F CodeBuddy（CLI + Plugin）、5F TraeCode（IDE + 插件）、6F Qoder（CLI 与插件合并，transcript + hook 两路会话）。
 *
 * 跑法：`npm run test:floors`（= node 直接跑，零依赖）。
 * 为什么要有它：这几层的每个结论都对应一条"只有真实文件摆到位才现形"的行为 —— 楼层是不是
 * 一层、多路落盘是不是都认、同时开着两种形态时是两条会话、两条会话的相位会不会串味、
 * 以及**读不出会话的那一路**有没有如实写进楼层说明（5F 的 TraeCode 插件落盘）。
 * 所以不 mock，把 HOME / WORKGREMLIN_HOME / PATH 指到临时目录，让**真实的** products 探测、
 * sessionRegistry、sessions 跑一遍。
 *
 * 覆盖：
 *   A. 1F CodeBuddy（cli + plugin + hook 三路）
 *     [A1] 一层：clients = codebuddy + codebuddy-plugin；只装 IDE 插件、没有 CLI 可执行文件也算"装了"
 *     [A2] 同时开着 CLI 与 Plugin → 这一层里**两条会话**，不是两个楼层
 *     [A3] 相位各认各的：client 传整层的串时，插件会话拿到插件的 tool、CLI 会话拿到自己的 thinking；
 *          只传单 client 时互不串味
 *     [A4] **陈旧 jsonl 不算数**：mtime 三小时前的 jsonl 在，正在跑（只有 hook 状态文件）的
 *          会话照样要进表 —— jsonl 优先的判据必须是"扫到了还活着的会话"，不是"扫到了任何行"
 *     [A5] jsonl 那一路优先：CLI 落盘扫得到**活**会话时，hook 那一路整层让位（同一条会话不列两遍）
 *   B. 5F TraeCode（IDE + 插件合并，会话只能靠 hook 状态文件）
 *     [B1] 一层：clients = trae + trae-plugin；三路来源（IDE 落盘 + 插件落盘 + hook）
 *     [B2] **两个形态的落盘目录都要列出来**（~/.trae-cn 与 ~/.marscode）；这两路只作展示、
 *          取不到会话 → 各带一句说明（楼层胶囊 tooltip 显示它们）
 *     [B3] 两种身份的 hook 状态文件（trae / trae-plugin）都归这一层
 *   C. 6F Qoder（CLI 与插件合并：同 ~/.qoder、同 hook、同 transcript，分不出，合并单楼层，类 4F）
 *     [C] 一层：只接纳 qoder 一种身份（CLI 与插件共用同一 client）；三路来源（cli 扫 transcript 产会话 + lingma 轮询插件的 local.db + hook 实时相位兜底）；只装了 qoder 就算"装了"
 *     [C2] 会话来自 hook 状态文件兜底：qoder 状态文件归这一层、相位按整层 client 取得到
 *     [C3] 会话也来自落盘 transcript：~/.qoder/projects/<工程>/<会话>.jsonl（Claude Code 同款格式）被 cli 那一路扫出，工程从 cwd 解析
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ 沙箱 ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-floors-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const BIN = path.join(TMP, 'bin');
const HOOKS = path.join(WG, 'hooks');
for (const d of [HOME, HOOKS, BIN]) fs.mkdirSync(d, { recursive: true });
// 不给 codebuddy 可执行文件：这一层"装了"的证据只有 IDE 里的插件扩展 —— 正是本机的情形
fs.mkdirSync(path.join(HOME, '.vscode', 'extensions', 'tencent-cloud.coding-copilot-4.12.0'), { recursive: true });
// CLI 的落盘根先立着（里面暂时一个会话文件都没有）：顺带覆盖"目录在、会话 jsonl 还没有"
// 这种最常见的形态 —— 这时 1F 的会话只能靠 hook 状态文件兜底列出来（见 [2]）
fs.mkdirSync(path.join(HOME, '.codebuddy'), { recursive: true });
// 5F TraeCode：装的是国内版 IDE（trae-cn 在 PATH 上），插件形态由 runner 自带、没有独立可执行文件
fs.writeFileSync(path.join(BIN, 'trae-cn'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
// 6F Qoder：沙箱里放一个 qoder 可执行文件（让"装了"判定命中），并立一个 ~/.qoder 落盘根；
// 再放一个 Qoder CN 的编辑器插件（通义灵码，displayName 就是 "Qoder CN (Formerly Lingma)"）
fs.writeFileSync(path.join(BIN, 'qoder'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
fs.mkdirSync(path.join(HOME, '.qoder'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.vscode', 'extensions', 'alibaba-cloud.tongyi-lingma-2.6.10'), { recursive: true });
// 插件那一路的落盘根：故意**不放** genie-history —— 复现"这一路读不出会话"
fs.mkdirSync(path.join(HOME, '.marscode', 'ai-chat', 'AppData', 'vscode', 'ai-agent'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.marscode', 'ai-chat', 'AppData', 'vscode', 'ai-agent', 'database.db'), 'not a sqlite\n');
fs.mkdirSync(path.join(HOME, '.trae-cn', 'memory', 'projects'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.vscode', 'extensions', 'GitHub.copilot-1.0.0'), { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
process.env.PATH = BIN;

const { snapshot, table } = require('../src/sessionRegistry');
const { reporterMainPhase, listReporterSessions, listSessions } = require('../src/sessions');
const { detectProducts } = require('../src/floors');

/* ------------------------------ 造数据 ------------------------------ */

const WS = '/tmp/ProjCB';
/** 插件的会话 id：实测就是 hook payload 的 session_id（genie-history 的 conversationId 与之一字不差） */
const PLUGIN_SID = '0819ef3ed32241a4970a17b8013f9289';
const CANCELLED_PLUGIN_SID = 'cancelled-plugin-conversation';
/** CLI 的会话 id：hook payload 的 session_id（uuid 形状） */
const CLI_SID = 'aaaa1111-2222-3333-4444-555566667777';

/** 状态文件名照 hook.js 的 statePath：`<agent>@<工程>@<会话>` 整体 sanitize 成 [A-Za-z0-9._-] */
function writeState(client, sessionId, extra, ws = WS) {
  const name = `${client}@${ws}@${sessionId}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  fs.writeFileSync(
    path.join(HOOKS, `${name}.json`),
    JSON.stringify({ client, sessionId, taskId: `task-${sessionId}`, taskStartedAt: Date.now(), taskWorkspacePath: ws, hb: { lastEventAt: Date.now() }, ...extra }, null, 2)
  );
}

// 插件的结构化落盘（genie-history / todos / message-queue / file-changes）：
// 工程目录名是工程路径的 base64（见 sessions.js 的 collectProjects / decodeDirName）
const STORAGE = path.join(HOME, '.config', 'Code', 'User', 'globalStorage', 'tencent-cloud.coding-copilot');
const PROJ_DIR = path.join(STORAGE, 'genie-history', Buffer.from(WS).toString('base64'));
fs.mkdirSync(path.join(PROJ_DIR, 'conversations', PLUGIN_SID), { recursive: true });
fs.mkdirSync(path.join(PROJ_DIR, 'conversations', CANCELLED_PLUGIN_SID), { recursive: true });
fs.mkdirSync(path.join(STORAGE, 'todos'), { recursive: true });
fs.mkdirSync(path.join(STORAGE, 'file-changes', PLUGIN_SID), { recursive: true });
fs.mkdirSync(path.join(STORAGE, 'message-queue'), { recursive: true });

const GITHUB_STORAGE = path.join(HOME, '.config', 'Code', 'User', 'globalStorage', 'github.copilot-chat');
const GITHUB_SID = 'github-sqlite-session-123';
fs.mkdirSync(GITHUB_STORAGE, { recursive: true });
const Database = require('better-sqlite3');
const db = new Database(path.join(GITHUB_STORAGE, 'session-store.db'));
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      repository TEXT,
      host_type TEXT,
      branch TEXT,
      summary TEXT,
      agent_name TEXT,
      agent_description TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  db.prepare('INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, agent_name, agent_description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(GITHUB_SID, WS, 'demo/repo', 'vscode', 'main', 'github highlight', 'GitHub Copilot Chat', '', new Date().toISOString(), new Date().toISOString());
} finally {
  db.close();
}
// current.json 指到这条会话：它才是"这个工程当前开着的会话"（吃得到 reporter 的实时相位）
fs.writeFileSync(path.join(PROJ_DIR, 'current.json'), JSON.stringify({ conversationId: PLUGIN_SID, lastUpdated: new Date().toISOString() }));
fs.writeFileSync(
  path.join(STORAGE, 'todos', `${PLUGIN_SID}.json`),
  JSON.stringify({ todos: [{ status: 'in_progress', content: '插件那路：改 renderer' }] })
);
fs.writeFileSync(
  path.join(STORAGE, 'file-changes', PLUGIN_SID, 'a.json'),
  JSON.stringify({ fileName: 'renderer/x.js', filePath: '/tmp/ProjCB/renderer/x.js', changeType: 'modify', addedLines: 3, removedLines: 1 })
);
fs.writeFileSync(
  path.join(STORAGE, 'message-queue', 'mq.json'),
  JSON.stringify({ conversations: {
    [PLUGIN_SID]: { runtime: { activated: true, paused: false }, updatedAt: Date.now(), items: [] },
    [CANCELLED_PLUGIN_SID]: {
      runtime: { activated: true, paused: true, pauseReason: 'cancel', updatedAt: Date.now() - 2 * 60 * 60_000 },
      updatedAt: Date.now() - 2 * 60 * 60_000,
      items: [],
    },
  } })
);

// 两份 hook 状态文件：同一个工程、两种身份、各自有新鲜的相位
writeState('codebuddy-plugin', PLUGIN_SID, {
  sessionPhase: { phase: 'tool', ts: Date.now(), workspacePath: WS, tool: 'Edit', target: 'renderer/x.js', detail: '改 renderer/x.js' },
  pending: null,
});
writeState('codebuddy', CLI_SID, {
  sessionPhase: { phase: 'thinking', ts: Date.now(), workspacePath: WS, detail: '' },
  pending: null,
});

// 5F TraeCode：同样是"两种身份、同一层"。TraeCode **没有可扫的会话落盘**，
// 两条会话都只能靠 hook 状态文件列出来（这正是这一层要合并成一层的原因）。
const TR_WS = '/tmp/ProjTr';
const TRAE_SID = '6ab7214d6fa5e51568fec603';
const TRAE_PLUGIN_SID = '6ab52af89e789b7a36fd23b9';
writeState('trae', TRAE_SID, { sessionPhase: { phase: 'tool', ts: Date.now(), workspacePath: TR_WS, detail: '改 renderer' }, pending: null }, TR_WS);
writeState('trae-plugin', TRAE_PLUGIN_SID, { sessionPhase: { phase: 'thinking', ts: Date.now(), workspacePath: TR_WS, detail: '' }, pending: null }, TR_WS);

/* ------------------------------ 断言 ------------------------------ */

let pass = 0;
let fail = 0;
const head = (t) => console.log(`\n${t}`);
function ok(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? `  — ${extra}` : ''}`);
  }
}

console.log(`沙箱：${TMP}`);

/* [A1] 一层：CLI 与 Plugin 是同一个楼层 */
head('[A1] 楼层表：1F 只有一层 CodeBuddy，两种 client、三路来源都在这一层');
{
  const products = detectProducts({ force: true });
  const floor = products.find((p) => p.id === '1F');
  ok('只有一个 CodeBuddy 楼层（没有第二个 CodeBuddy Plugin 层）', products.filter((p) => p.agent === 'codebuddy').length === 1);
  ok('1F 名叫 CodeBuddy', floor && floor.name === 'CodeBuddy', floor && floor.name);
  ok(
    '这一层接纳 codebuddy + codebuddy-plugin 两种上报身份',
    floor && JSON.stringify(floor.clients) === JSON.stringify(['codebuddy', 'codebuddy-plugin']),
    floor && JSON.stringify(floor.clients)
  );
  ok(
    '三路来源：cli（~/.codebuddy）+ plugin（globalStorage）+ hook（状态文件）',
    floor && JSON.stringify(floor.sources.map((s) => s.kind)) === JSON.stringify(['cli', 'plugin', 'hook']),
    floor && JSON.stringify(floor.sources.map((s) => s.kind))
  );
  ok(
    '只装了 IDE 插件（没有 CLI 可执行文件）也算"装了"',
    floor && floor.installed === true,
    floor && `installed=${floor.installed} installPath=${floor.installPath}`
  );
  ok(
    '插件那一路扫到了 globalStorage 的落盘',
    floor && (floor.sources.find((s) => s.kind === 'plugin') || {}).dataPath === STORAGE,
    floor && JSON.stringify(floor.sources.find((s) => s.kind === 'plugin'))
  );
}

/* [A2] 同时开着 CLI 与 Plugin → 一层里的两条会话 */
head('[A2] 同时开着 CLI 与 Plugin：是这一层里的两条会话，不是两个楼层');
{
  const snap = snapshot({ force: true, workspacePath: WS });
  const floor = snap.floors.find((f) => f.id === '1F');
  const ids = floor.sessions.map((s) => s.sessionId).sort();
  ok('1F 上两条活跃会话', floor.sessions.length === 2, floor.sessions.map((s) => `${s.source}:${s.sessionId}`).join(' '));
  ok('两条会话的 id 分别是插件与 CLI 的', JSON.stringify(ids) === JSON.stringify([CLI_SID, PLUGIN_SID].sort()), JSON.stringify(ids));
  const pluginRow = floor.sessions.find((s) => s.sessionId === PLUGIN_SID);
  const cliRow = floor.sessions.find((s) => s.sessionId === CLI_SID);
  ok('插件那条走结构化那一场（plugin 来源、有运行态）', Boolean(pluginRow) && pluginRow.source === 'plugin' && pluginRow.live === true);
  ok('CLI 那条没有会话 jsonl 时由 hook 状态文件兜底列出', Boolean(cliRow) && cliRow.projectPath === WS, cliRow && JSON.stringify(cliRow.projectPath));
  ok('两条都归属同一工程', Boolean(pluginRow && cliRow) && pluginRow.projectPath === WS && cliRow.projectPath === WS);
  ok('取消的 Plugin 会话不留在下拉列表', !floor.sessions.some((s) => s.sessionId === CANCELLED_PLUGIN_SID), floor.sessions.map((s) => `${s.source}:${s.sessionId}`).join(' '));
}

/* [A3] 相位各认各的（不串味） */
head('[A3] 同一层里两条会话的实时相位各认各的（这一层要认一串 client）');
{
  const both = 'codebuddy,codebuddy-plugin';
  const p = reporterMainPhase(WS, both, PLUGIN_SID);
  const c = reporterMainPhase(WS, both, CLI_SID);
  ok('插件会话拿到插件那路的相位（tool）', Boolean(p) && p.phase === 'tool', p && JSON.stringify(p));
  ok('CLI 会话拿到 CLI 那路的相位（thinking）', Boolean(c) && c.phase === 'thinking', c && JSON.stringify(c));
  ok('两条会话的相位互不相同（没有谁最新谁生效）', Boolean(p && c) && p.phase !== c.phase);
  ok('只传 CLI 那一路时，插件会话的相位取不到（不串味）', reporterMainPhase(WS, 'codebuddy', PLUGIN_SID) === null);
  ok('只传插件那一路时，CLI 会话的相位取不到（不串味）', reporterMainPhase(WS, 'codebuddy-plugin', CLI_SID) === null);
}

head('[A3b] CodeBuddy Plugin 收到 SessionEnd 后移除；再次 SessionStart 后重新列出');
{
  const endedAt = Date.now();
  writeState('codebuddy-plugin', PLUGIN_SID, { sessionEndedAt: endedAt });
  let snap = snapshot({ force: true, workspacePath: WS });
  let floor = snap.floors.find((f) => f.id === '1F');
  ok('Plugin SessionEnd 后会话立即从下拉数据移除', !floor.sessions.some((s) => s.sessionId === PLUGIN_SID), floor.sessions.map((s) => `${s.source}:${s.sessionId}`).join(' '));
  writeState('codebuddy-plugin', PLUGIN_SID, { sessionEndedAt: null, sessionWorkspacePath: WS });
  snap = snapshot({ force: true, workspacePath: WS });
  floor = snap.floors.find((f) => f.id === '1F');
  ok('同一 Plugin 会话再次 SessionStart 后重新出现', floor.sessions.some((s) => s.sessionId === PLUGIN_SID), floor.sessions.map((s) => `${s.source}:${s.sessionId}`).join(' '));
}

/* [A4] 陈旧 jsonl 不能让正在跑的会话从 1F 消失（jsonl 优先的判据得看"活着的"，不是"任何行"） */
head('[A4] 陈旧 jsonl 在，也不该让 hook 那一路的正在跑会话从 1F 失踪');
{
  // 一条陈旧 jsonl：mtime 设在 3 小时前（远超 60min 超时，prune() 马上要剔除）
  const stale = path.join(HOME, '.codebuddy', 'projects', 'old.jsonl');
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, `${JSON.stringify({ cwd: '/tmp/StaleProj', type: 'message', text: 'long gone' })}\n`);
  fs.utimesSync(stale, new Date(Date.now() - 3 * 3600_000), new Date(Date.now() - 3 * 3600_000));

  const snap = snapshot({ force: true, workspacePath: WS });
  const floor = snap.floors.find((f) => f.id === '1F');
  const running = floor.sessions.find((s) => s.sessionId === CLI_SID);
  ok('陈旧 jsonl 在，1F 不至于整层空掉', floor.sessions.length > 0, floor.sessions.map((s) => `${s.source}:${s.sessionId}`).join(' '));
  ok('正在跑的 CLI 会话（hook 那一路）仍然在表里', Boolean(running), floor.sessions.map((s) => `${s.source}:${s.sessionId}`).join(' '));
  ok('陈旧 jsonl 那条没被当成活会话列出来', !floor.sessions.some((s) => String(s.id).includes('old.jsonl')));
  // 顺带钉住一个实现细节：陈旧行**不登记**（不是"登记了但筛掉"）—— 登记进来的话，它会拿
  // 会话 id 去 claim，同名 id 的活会话会在那一步被顶掉（jsonl 那一路排在 hook 之前）。
  // 上面那条"仍然在表里"才是这个 bug 的判据；这条防的是以后把过滤退回成"登记后再筛"。
  ok(
    '陈旧 jsonl 连表都没进（不拿它去 claim 会话 id）',
    ![...table.values()].some((s) => s.floor === '1F' && String(s.id).includes('old.jsonl')),
    [...table.values()].filter((s) => s.floor === '1F').map((s) => String(s.id)).join(' ')
  );
}

/* [A5] jsonl 优先：CLI 落盘有【活】会话时，hook 那一路整层让位（同一条会话不列两遍） */
head('[A5] CLI 落盘扫得到活会话时，hook 兜底整层让位（同一条会话不会列两遍）');
{
  const rel = path.join('projects', `${CLI_SID}.jsonl`);
  const file = path.join(HOME, '.codebuddy', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ cwd: WS, type: 'message', text: 'hi' })}\n`);

  const snap = snapshot({ force: true, workspacePath: WS });
  const floor = snap.floors.find((f) => f.id === '1F');
  const fromHook = floor.sessions.filter((s) => s.source === 'hook' && s.sessionId === CLI_SID);
  const fromJsonl = floor.sessions.filter((s) => String(s.id).includes(`${CLI_SID}.jsonl`));
  ok('CLI 会话改由 jsonl 那一路列出', fromJsonl.length === 1, floor.sessions.map((s) => `${s.source}:${s.id}`).join(' '));
  ok('同一条 CLI 会话没有同时留下 hook 那一路的行（不重复）', fromHook.length === 0);
  ok('插件那条会话照常还在（两处落盘互不影响）', floor.sessions.some((s) => s.sessionId === PLUGIN_SID));
  const codebuddyPluginRe = detectProducts({ force: true }).find((p) => p.id === '1F').pluginRe;
  const storage = listSessions({ force: true, client: 'codebuddy-plugin', pluginRe: codebuddyPluginRe });
  ok('插件落盘这一路自己仍然列得出会话', (storage.sessions || []).some((s) => s.id === PLUGIN_SID));
}

head('[A6] CLI 收到 SessionEnd 后重开：旧 JSONL 不能挡住新 SessionStart 会话');
{
  const endedAt = Date.now();
  writeState('codebuddy', CLI_SID, {
    hb: { pid: process.pid, lastEventAt: endedAt - 1_000 },
    sessionPhase: null,
    taskId: '',
    taskWorkspacePath: '',
    taskStartedAt: 0,
    sessionEndedAt: endedAt,
  });
  const reopenedSid = 'bbbb1111-2222-3333-4444-555566667777';
  writeState('codebuddy', reopenedSid, {
    hb: { pid: process.pid, lastEventAt: endedAt + 1 },
    sessionPhase: null,
    sessionWorkspacePath: WS,
    taskId: '',
    taskWorkspacePath: '',
    taskStartedAt: 0,
    sessionEndedAt: null,
  });
  const ended = listReporterSessions('codebuddy', { includeEnded: true }).find((s) => s.sessionId === CLI_SID);
  ok('reporter 索引识别旧会话的 SessionEnd 标记', ended && ended.endedAt === endedAt, JSON.stringify(ended));

  const snap = snapshot({ force: true, workspacePath: WS });
  const floor = snap.floors.find((f) => f.id === '1F');
  const reopened = floor.sessions.find((s) => s.sessionId === reopenedSid);
  ok('新 SessionStart 会话在尚未输入时就已列出', Boolean(reopened), floor.sessions.map((s) => `${s.source}:${s.sessionId}`).join(' '));
  ok('新会话无需等 JSONL 首条记录就归属当前工程', reopened && reopened.projectPath === WS && reopened.mine, reopened && `${reopened.projectPath} mine=${reopened.mine}`);
  ok('SessionEnd 的旧会话不再作为活跃会话列出', !floor.sessions.some((s) => s.sessionId === CLI_SID), floor.sessions.map((s) => `${s.source}:${s.sessionId}`).join(' '));
}

/* [B1] 5F TraeCode：IDE 与插件也是一层 */
head('[B1] 楼层表：5F 只有一层 TraeCode（IDE 与插件合并）');
{
  const products = detectProducts({ force: true });
  const floor = products.find((p) => p.id === '5F');
  ok('只有一个 TraeCode 楼层（没有第二个 trae 楼层）', products.filter((p) => p.agent === 'trae').length === 1);
  ok('5F 名叫 TraeCode', floor && floor.name === 'TraeCode', floor && floor.name);
  // 楼层数会随新楼层增长（7F Kilo / 8F OpenCode 都是轮询路线），所以这里不断言"共 N 层"——
  // 那种断言每加一层就得改一次，漏改就红。改为断言**编号从 1F 起连续**且**没有重号**：
  // 加楼层时这条恒真，真出现"两层撞成同一个 id"或"编号跳号"才会红。
  const ids = products.map((p) => p.id);
  const nums = ids.map((id) => parseInt(String(id).replace(/^[A-Z]+/, ''), 10)).filter((n) => Number.isFinite(n));
  ok('楼层编号从 1F 起连续、没有重号', nums.length === ids.length && nums.every((n, i) => n === i + 1), ids.join(' '));
  ok('7F 是 Kilo Code（轮询 SQLite 那一路）', products.some((p) => p.id === '7F' && p.name === 'Kilo Code'), products.map((p) => `${p.id}:${p.name}`).join(' '));
  ok(
    '这一层接纳 trae + trae-plugin 两种上报身份',
    floor && JSON.stringify(floor.clients) === JSON.stringify(['trae', 'trae-plugin']),
    floor && JSON.stringify(floor.clients)
  );
  ok(
    '三路来源：IDE 落盘 + 插件落盘（都只作展示）+ hook（会话来源）',
    floor && JSON.stringify(floor.sources.map((s) => s.kind)) === JSON.stringify(['dir', 'dir', 'hook']),
    floor && JSON.stringify(floor.sources.map((s) => `${s.label || s.kind}:${s.kind}`))
  );
  ok(
    '两路落盘各有自己的显示名（IDE / plugin）',
    floor && JSON.stringify(floor.sources.filter((s) => s.kind === 'dir').map((s) => s.label)) === JSON.stringify(['IDE', 'plugin']),
    floor && JSON.stringify(floor.sources.map((s) => s.label))
  );
  ok(
    '只有 hook 那一路产会话（两路落盘 sessions=false）',
    floor && floor.sources.filter((s) => s.sessions !== false).map((s) => s.kind).join(',') === 'hook',
    floor && JSON.stringify(floor.sources.map((s) => `${s.kind}:${s.sessions}`))
  );
  ok('装了国内版 IDE（trae-cn）就算装了', floor && floor.installed === true, floor && String(floor.installPath));
}

/* [B2] 两个形态的落盘目录都要列出来（胶囊 tooltip 显示的就是它们）；两路都不带 sources[].note */
head('[B2] 5F 的两路落盘：IDE 的 ~/.trae-cn 与插件的 ~/.marscode 都要在 tooltip 里');
{
  const products = detectProducts({ force: true });
  const dirs = products.find((p) => p.id === '5F').sources.filter((s) => s.kind === 'dir');
  const ideSrc = dirs.find((s) => s.label === 'IDE');
  const pluginSrc = dirs.find((s) => s.label === 'plugin');
  ok('IDE 那一路扫的是 ~/.trae-cn（国内版）', Boolean(ideSrc) && String(ideSrc.dataPathLabel).endsWith('.trae-cn'), ideSrc && ideSrc.dataPathLabel);
  ok('插件那一路扫的是 ~/.marscode', Boolean(pluginSrc) && String(pluginSrc.dataPathLabel).endsWith('.marscode'), pluginSrc && pluginSrc.dataPathLabel);
  // tooltip 只列目录与落盘统计，不带 sources[].note（形态靠上报身份区分，见 clientMatch 的 CLIENT_LABELS）
  ok('两路都不带说明（tooltip 只列目录与落盘统计）', !ideSrc.note && !pluginSrc.note, `${ideSrc.note} | ${pluginSrc.note}`);
  // 明确没有 genie-history 这类会话索引（否则本该由 listSessions 读出来，而不是只作展示）
  ok('两路都没有 genie-history 这类会话索引', !fs.existsSync(path.join(ideSrc.dataPath, 'genie-history')) && !fs.existsSync(path.join(pluginSrc.dataPath, 'genie-history')));

  // 真值验证：插件那一路的会话列举确实拿不到东西（不是我们没去问）
  const st = listSessions({ force: true, client: 'trae-plugin', pluginRe: /trae/i });
  ok('listSessions 对插件那一路回空（没有结构化落盘）', (st.sessions || []).length === 0, JSON.stringify(st.sessions).slice(0, 200));

  // 楼层快照（前端拿到的就是这份）也要带上这两路（前端 tooltip 直接列它们）
  const snap = snapshot({ force: true, workspacePath: TR_WS });
  const floor = snap.floors.find((f) => f.id === '5F');
  const labels = (floor.sources || []).filter((s) => s.kind === 'dir').map((s) => s.label);
  ok('楼层快照里两路落盘的 label 都在（前端 tooltip 直接列它们）', JSON.stringify(labels) === JSON.stringify(['IDE', 'plugin']), JSON.stringify(floor.sources));
}

/* [B3] 会话来自 hook 状态文件；两种身份都归这一层 */
head('[B3] 5F 的会话来自 hook：trae 与 trae-plugin 两种状态文件都归这一层');
{
  const snap = snapshot({ force: true, workspacePath: TR_WS });
  const floor = snap.floors.find((f) => f.id === '5F');
  const ids = floor.sessions.map((s) => s.sessionId).sort();
  ok('这一层两条会话', floor.sessions.length === 2, floor.sessions.map((s) => `${s.sessionId}`).join(' '));
  ok('两种身份的会话都在（trae + trae-plugin）', JSON.stringify(ids) === JSON.stringify([TRAE_PLUGIN_SID, TRAE_SID].sort()), JSON.stringify(ids));
  ok('两条都归属同一个工程', floor.sessions.every((s) => s.projectPath === TR_WS), JSON.stringify(floor.sessions.map((s) => s.projectPath)));
  const both = 'trae,trae-plugin';
  ok('相位按这一层的 client 串取得到（整层的两路都认）', Boolean(reporterMainPhase(TR_WS, both, TRAE_SID)));
  ok('相位按会话精确：两条会话拿到各自的相位', reporterMainPhase(TR_WS, both, TRAE_SID).phase === 'tool' && reporterMainPhase(TR_WS, both, TRAE_PLUGIN_SID).phase === 'thinking');
}

/* [C] 6F Qoder：CLI 与插件合并（同 ~/.qoder、同 hook、同 transcript，分不出，合并单楼层，类 4F） */
head('[C] 楼层表：6F 只有一层 Qoder（CLI 与插件合并，cli 扫 transcript + 插件轮询 local.db + hook 兜底）');
{
  const products = detectProducts({ force: true });
  const floor = products.find((p) => p.id === '6F');
  ok('有 6F 这一层', Boolean(floor), products.map((p) => p.id).join(' '));
  ok('6F 名叫 Qoder', floor && floor.name === 'Qoder', floor && floor.name);
  ok('这一层只接纳 qoder 一种上报身份（CLI 与插件分不出，共用同一 client，无 qoder-plugin）', floor && JSON.stringify(floor.clients) === JSON.stringify(['qoder']), floor && JSON.stringify(floor.clients));
  ok(
    '三路来源：cli（扫 ~/.qoder/projects transcript 产会话）+ lingma（插件自己的 local.db）+ hook（实时相位兜底）',
    floor && JSON.stringify(floor.sources.map((s) => s.kind)) === JSON.stringify(['cli', 'lingma', 'hook']),
    floor && JSON.stringify(floor.sources.map((s) => `${s.label || s.kind}:${s.kind}`))
  );
  ok('三路都产会话（cli 扫 transcript、lingma 轮询插件的库、hook 兜底）', floor && floor.sources.filter((s) => s.sessions !== false).map((s) => s.kind).join(',') === 'cli,lingma,hook', floor && JSON.stringify(floor.sources.map((s) => `${s.kind}:${s.sessions}`)));
  ok('装了 qoder（沙箱里放了可执行文件）就算装了', floor && floor.installed === true, floor && String(floor.installPath));
  ok('Qoder CN 编辑器插件（tongyi-lingma）算插件安装证据', floor && String(floor.pluginInstallPath || '').includes('tongyi-lingma'), floor && String(floor.pluginInstallPath));
  ok('cli 那一路扫的是 ~/.qoder（子树 projects）', Boolean(floor.sources.find((s) => s.kind === 'cli')) && String(floor.sources.find((s) => s.kind === 'cli').dataPathLabel).endsWith('.qoder'));
}

/* [C2] 会话来自 hook 状态文件兜底；qoder 状态文件归这一层 */
head('[C2] 6F 的会话来自 hook：qoder 状态文件归这一层');
{
  const Q_WS = '/tmp/ProjQ';
  const Q_SID = 'qoder-session-0001';
  writeState('qoder', Q_SID, { sessionPhase: { phase: 'thinking', ts: Date.now(), workspacePath: Q_WS }, pending: null }, Q_WS);
  const snap = snapshot({ force: true, workspacePath: Q_WS });
  const floor = snap.floors.find((f) => f.id === '6F');
  ok('这一层一条会话（hook 兜底）', floor.sessions.length === 1, floor.sessions.map((s) => `${s.source}:${s.sessionId}`).join(' '));
  ok('会话就是 qoder 状态文件那条', floor.sessions[0] && floor.sessions[0].sessionId === Q_SID, floor.sessions.map((s) => s.sessionId).join(' '));
  ok('会话归属正确工程', floor.sessions[0] && floor.sessions[0].projectPath === Q_WS, floor.sessions.map((s) => String(s.projectPath)).join(' '));
  ok('相位按这一层的 client 取得到', Boolean(reporterMainPhase(Q_WS, 'qoder', Q_SID)));
}

/* [C3] 会话也来自落盘 transcript：~/.qoder/projects/<工程>/<会话>.jsonl（Claude Code 同款格式） */
head('[C3] 6F 也吃落盘 transcript：~/.qoder/projects/<工程>/<会话>.jsonl 被 cli 那一路扫出');
{
  const Q_PROJ = '/tmp/ProjQTranscript';
  const Q_TSID = 'c0ffee00-1234-5678-9abc-def012345678';
  const tdir = path.join(HOME, '.qoder', 'projects', '-tmp-ProjQTranscript');
  fs.mkdirSync(tdir, { recursive: true });
  // Claude Code 同款：首行 workspace-directories（无 cwd），user 行带 cwd 与 sessionId
  const lines = [
    JSON.stringify({ type: 'workspace-directories', sessionId: Q_TSID, directories: [Q_PROJ] }),
    JSON.stringify({ type: 'user', sessionId: Q_TSID, cwd: Q_PROJ, message: { role: 'user', content: 'hi' } }),
  ];
  fs.writeFileSync(path.join(tdir, `${Q_TSID}.jsonl`), lines.join('\n') + '\n');

  const snap = snapshot({ force: true, workspacePath: Q_PROJ });
  const floor = snap.floors.find((f) => f.id === '6F');
  const row = floor.sessions.find((s) => s.sessionId === Q_TSID);
  ok('落盘 transcript 那条会话被 cli 那一路扫出', Boolean(row) && row.sourceKind === 'cli', floor.sessions.map((s) => `${s.sourceKind}:${s.sessionId}`).join(' '));
  ok('会话 id 从文件名取到（与 Claude 同款）', Boolean(row) && row.sessionId === Q_TSID, row && row.sessionId);
  ok('工程路径从 cwd 解析到', Boolean(row) && row.projectPath === Q_PROJ, row && row.projectPath);
}

/* [D] 9F GitHub Copilot：插件扩展一层，视觉上可展示且可点 */
head('[D] 9F GitHub Copilot：插件扩展楼层被识别并展示');
{
  const products = detectProducts({ force: true });
  const floor = products.find((p) => p.id === '9F');
  ok('有 9F 这一层', Boolean(floor), products.map((p) => p.id).join(' '));
  ok('9F 名叫 GitHub Copilot', floor && floor.name === 'GitHub Copilot', floor && floor.name);
  ok('9F 只接纳 copilot-plugin 这一路上报身份', floor && JSON.stringify(floor.clients) === JSON.stringify(['copilot-plugin']), floor && JSON.stringify(floor.clients));
  ok('插件扩展目录命中后会被判定为已安装', floor && floor.installed === true, floor && String(floor.installPath));
  ok('9F 视图层会拿到插件落盘源', floor && floor.sources.some((s) => s.kind === 'plugin'), floor && JSON.stringify(floor.sources.map((s) => s.kind)));

  const ghStorage = path.join(HOME, '.config', 'Code', 'User', 'globalStorage', 'github.copilot-chat');
  const tencentStorage = path.join(HOME, '.config', 'Code', 'User', 'globalStorage', 'tencent-cloud.coding-copilot');
  const globalStorageRoot = path.join(HOME, '.config', 'Code', 'User', 'globalStorage');
  fs.mkdirSync(globalStorageRoot, { recursive: true });
  fs.mkdirSync(ghStorage, { recursive: true });
  fs.mkdirSync(tencentStorage, { recursive: true });

  const ghSid = 'gh-copilot-session-9f';
  const Database = require('better-sqlite3');
  const db = new Database(path.join(ghStorage, 'session-store.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      repository TEXT,
      host_type TEXT,
      branch TEXT,
      summary TEXT,
      agent_name TEXT,
      agent_description TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      turn_index INTEGER,
      user_message TEXT,
      assistant_response TEXT,
      timestamp TEXT
    );
    CREATE TABLE IF NOT EXISTS session_files (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      file_path TEXT,
      tool_name TEXT,
      turn_index INTEGER,
      first_seen_at TEXT
    );
  `);
  const nowIso = new Date().toISOString();
  db.prepare(`INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, agent_name, agent_description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ghSid, '/tmp/ProjGitHubCopilot', 'https://example.com/repo.git', 'vscode', 'main', 'github highlight', 'GitHub Copilot Chat', '', nowIso, nowIso);
  db.prepare(`INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)`)
    .run(ghSid, 0, 'fix the highlight bug', 'done', nowIso);
  db.prepare(`INSERT INTO session_files (session_id, file_path, tool_name, turn_index, first_seen_at) VALUES (?, ?, ?, ?, ?)`)
    .run(ghSid, '/tmp/ProjGitHubCopilot/src/highlight.ts', 'read_file', 0, nowIso);
  // 读过的文件不算"改动文件"（Copilot 0.65.0 的 session_files 整表都是 read_file，实测）；
  // 写工具碰过的才算 —— 下面两条一起验证这个筛子。
  db.prepare(`INSERT INTO session_files (session_id, file_path, tool_name, turn_index, first_seen_at) VALUES (?, ?, ?, ?, ?)`)
    .run(ghSid, '/tmp/ProjGitHubCopilot/src/changed.ts', 'edit_file', 0, nowIso);
  db.close();

  // GitHub Copilot 的真实落盘是 SQLite `session-store.db`，不是 `genie-history`。
  // 这条回归确保不再把真实会话库当成“空目录”，否则 9F 会被旧的 Tencent 目录覆盖、胶囊永远不亮。

  const tencentDir = path.join(tencentStorage, 'genie-history', Buffer.from('/tmp/ProjGitHubCopilot').toString('base64'));
  fs.mkdirSync(path.join(tencentDir, 'conversations', 'old-session'), { recursive: true });
  fs.writeFileSync(path.join(tencentDir, 'current.json'), JSON.stringify({ conversationId: 'old-session', lastUpdated: new Date().toISOString() }));
  fs.mkdirSync(path.join(tencentStorage, 'todos'), { recursive: true });
  fs.writeFileSync(path.join(tencentStorage, 'todos', 'old-session.json'), JSON.stringify({ todos: [{ status: 'in_progress', content: 'stale tencent' }] }));

  // 这条是根因回归：同一台机上会同时有老的 Tencent Copilot 目录和新的 GitHub Copilot 目录；
  // 代码必须优先选真正的 GitHub Copilot，不然 9F 会被旧目录吞掉，胶囊永远不亮。
  const sessionSnap = listSessions({ workspacePath: '/tmp/ProjGitHubCopilot', force: true, client: 'copilot-plugin' });
  const storage = sessionSnap.storage;
  ok('9F 优先选 GitHub Copilot 的真实插件存储', storage === ghStorage, `实际 ${storage}，期望 ${ghStorage}`);
  ok('9F 能从 GitHub Copilot 的真实 SQLite 会话库读出活跃会话', Array.isArray(sessionSnap.sessions) && sessionSnap.sessions.some((s) => s.id === ghSid), JSON.stringify(sessionSnap.sessions.map((s) => s.id)));
  ok('旧的 Tencent Copilot 目录不会覆盖 GitHub Copilot 的 9F 亮起', !storage || storage !== tencentStorage, `实际 ${storage}`);

  // 任务记录：Copilot 的 turns / session_files 表读出来后要体现在会话行里
  const ghSession = sessionSnap.sessions.find((s) => s.id === ghSid);
  ok('9F 会话带 Copilot 的 summary 作标题', ghSession && ghSession.doneTitle === 'github highlight', ghSession && ghSession.doneTitle);
  ok('9F 会话带 Copilot 的 turn 数（doneCount）', ghSession && ghSession.doneCount === 1, ghSession && String(ghSession.doneCount));
  ok('9F 会话带最后一条 user_message 作 prompt', ghSession && ghSession.prompt === 'fix the highlight bug', ghSession && ghSession.prompt);
  ok(
    '9F 会话的文件清单只留写工具碰过的（读过的 read_file 剔掉）、并转成相对路径',
    ghSession && ghSession.files && ghSession.files.count === 1 && ghSession.files.recent[0] && ghSession.files.recent[0].path === 'src/changed.ts',
    ghSession && JSON.stringify(ghSession.files)
  );

  const ghPhase = reporterMainPhase('/tmp/ProjGitHubCopilot', 'copilot-plugin', ghSid);
  ok('9F 主 Agent 相位可从 GitHub Copilot SQLite 会话回退得到', ghPhase && ghPhase.phase === 'thinking' && ghPhase.prompt === 'fix the highlight bug', ghPhase && JSON.stringify(ghPhase));

  // 9F 相位：Copilot 自己的库是**整轮写完**才落的（turns 行带 assistant_response 一起出现，
  // sessions.updated_at 也是那一刻才动），所以"正在生成"在它库里看不见 ——
  // 只看时间窗就会出现"跑着显示待命、跑完显示思考中"。
  // VS Code 自己有一份更细的索引：workspaceStorage/<hash>/state.vscdb 的
  // `chat.ChatSessionStore.index`（timing.lastRequestStarted / lastRequestEnded）。
  // 下面现造一份，验证 9F 相位听这份旁证。
  const wsHash = 'ws-9f-fixture';
  const wsDir = path.join(HOME, '.config', 'Code', 'User', 'workspaceStorage', wsHash);
  fs.mkdirSync(wsDir, { recursive: true });
  /** @param {number} started @param {number} ended 0 表示这一轮还没有 ended（在飞） */
  const writeChatIndex = (started, ended, pad = '') => {
    const idb = new Database(path.join(wsDir, 'state.vscdb'));
    idb.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    idb
      .prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
      .run(
        'chat.ChatSessionStore.index',
        JSON.stringify({
          version: 1,
          entries: {
            [ghSid]: {
              sessionId: ghSid,
              title: 'github highlight',
              timing: { created: started, lastRequestStarted: started, ...(ended ? { lastRequestEnded: ended } : {}) },
              lastResponseState: 1,
              pad,
            },
          },
        })
      );
    idb.close();
  };

  writeChatIndex(1790580000000, 0); // 只有开始、没有结束 = 这一轮在飞
  const liveSnap = listSessions({ workspacePath: '/tmp/ProjGitHubCopilot', force: true, client: 'copilot-plugin' });
  const liveRow = liveSnap.sessions.find((s) => s.id === ghSid);
  ok(
    '9F 相位：chat 索引说这一轮在飞 → thinking（不是待命）',
    liveRow && liveRow.phase === 'thinking' && liveRow.inFlight === true,
    liveRow && JSON.stringify({ phase: liveRow.phase, inFlight: liveRow.inFlight })
  );
  const livePhase = reporterMainPhase('/tmp/ProjGitHubCopilot', 'copilot-plugin', ghSid);
  ok('9F 主 Agent 相位同口径（在飞 → thinking）', livePhase && livePhase.phase === 'thinking', livePhase && livePhase.phase);

  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  sleepSync(20);
  writeChatIndex(1790580000000, 1790580050000, 'ended'); // 结束晚于开始 = 这一轮收工了
  const idleSnap = listSessions({ workspacePath: '/tmp/ProjGitHubCopilot', force: true, client: 'copilot-plugin' });
  const idleRow = idleSnap.sessions.find((s) => s.id === ghSid);
  ok(
    '9F 相位：索引说这一轮已收工 → idle（不再拿 2 分钟窗口糊着）',
    idleRow && idleRow.phase === 'idle' && idleRow.inFlight === false,
    idleRow && JSON.stringify({ phase: idleRow.phase, inFlight: idleRow.inFlight })
  );

  // 会话日志（chatSessions/<会话>.jsonl）：最新一轮**在请求开始时就落下**（带用户原话），
  // 完成时间稍后以 requests.<n>.modelState.completedAt 补 —— 9F「正在跑」最靠谱的旁证，
  // 也是「思考中」那句用户原话的来源（Copilot 自己的库要整轮写完才有）。
  const chatDir = path.join(wsDir, 'chatSessions');
  fs.mkdirSync(chatDir, { recursive: true });
  const logFile = path.join(chatDir, `${ghSid}.jsonl`);
  const liveStart = Date.now();
  const writeLog = (obj) => fs.appendFileSync(logFile, `${JSON.stringify(obj)}\n`);
  writeLog({
    kind: 1,
    k: ['requests'],
    v: [{ requestId: 'r1', timestamp: liveStart, message: { text: '这一轮在做 9F 相位' }, modelState: { value: 0 } }],
  });
  const liveSnap2 = listSessions({ workspacePath: '/tmp/ProjGitHubCopilot', force: true, client: 'copilot-plugin' });
  const liveRow2 = liveSnap2.sessions.find((s) => s.id === ghSid);
  ok(
    '9F 相位：会话日志说这一轮刚开始 → thinking',
    liveRow2 && liveRow2.phase === 'thinking' && liveRow2.inFlight === true,
    liveRow2 && JSON.stringify({ phase: liveRow2.phase, inFlight: liveRow2.inFlight })
  );
  ok('9F「思考中」带的是这一轮用户原话（不是上一轮）', liveRow2 && liveRow2.prompt === '这一轮在做 9F 相位', liveRow2 && liveRow2.prompt);
  const livePhase2 = reporterMainPhase('/tmp/ProjGitHubCopilot', 'copilot-plugin', ghSid);
  ok(
    '9F 主 Agent 相位同口径（在飞 → thinking + 原话）',
    livePhase2 && livePhase2.phase === 'thinking' && livePhase2.prompt === '这一轮在做 9F 相位',
    livePhase2 && JSON.stringify({ phase: livePhase2.phase, prompt: livePhase2.prompt })
  );

  writeLog({ kind: 1, k: ['requests', 0, 'elapsedMs'], v: 42000 });
  writeLog({ kind: 1, k: ['requests', 0, 'modelState'], v: { value: 1, completedAt: liveStart + 42000 } });
  const doneSnap = listSessions({ workspacePath: '/tmp/ProjGitHubCopilot', force: true, client: 'copilot-plugin' });
  const doneRow = doneSnap.sessions.find((s) => s.id === ghSid);
  ok(
    '9F 相位：日志补上完成标记后 → idle',
    doneRow && doneRow.phase === 'idle' && doneRow.inFlight === false,
    doneRow && JSON.stringify({ phase: doneRow.phase, inFlight: doneRow.inFlight })
  );
  ok(
    '9F 这一轮的起止从日志算得出来（台账按轮记账用）',
    Boolean(doneRow) && Array.isArray(doneRow.liveReqs) && doneRow.liveReqs[0] && doneRow.liveReqs[0].startedAt === liveStart && doneRow.liveReqs[0].endedAt === liveStart + 42000,
    JSON.stringify(doneRow && doneRow.liveReqs)
  );

  // 回归（2026-09-28 实测的坑）：新一轮刚开始时，日志里只有整份 requests（带这一轮的
  // 起始时间与用户原话），**还没有它的 requests.<n>.* 补丁** —— 完成标记还是上一轮的。
  // 早先拿"补丁里的最大轮号"当这一轮的轮号，就会把上一轮的 completedAt 当成它的完成标记，
  // 于是"正在跑"被判成"已收工"：用户跑任务时 9F 连「思考中」都没有。
  // 时间上必须排在上一轮收工之后（真实数据就是顺序的）：上一轮 completedAt = liveStart+42000
  const liveStart2 = liveStart + 42000 + 1000;
  // 真实 VS Code 0.65.0 实测：索引会把 lastRequestEnded 写成和 lastRequestStarted 一样
  // （永远判不出在飞），所以"日志说刚开跑"不能被索引压掉。
  writeChatIndex(liveStart2, liveStart2, 'same-instant');
  writeLog({
    kind: 1,
    k: ['requests'],
    v: [{ requestId: 'r2', timestamp: liveStart2, message: { text: '新一轮刚开始' }, modelState: { value: 0 } }],
  });
  // 这一轮改动的文件：日志里**写工具**碰过的（read_file 不算）
  writeLog({
    kind: 1,
    k: ['requests', 1, 'response'],
    v: [
      { kind: 'toolInvocationSerialized', toolId: 'copilot_readFile', invocationMessage: { value: 'Reading [](file:///tmp/ProjGitHubCopilot/src/read-only.ts)' } },
      { kind: 'toolInvocationSerialized', toolId: 'copilot_multiReplaceString', invocationMessage: { value: 'Replacing 1 lines with 2 lines in [](file:///tmp/ProjGitHubCopilot/src/highlight.ts)' } },
    ],
  });
  const newSnap = listSessions({ workspacePath: '/tmp/ProjGitHubCopilot', force: true, client: 'copilot-plugin' });
  const newRow = newSnap.sessions.find((s) => s.id === ghSid);
  ok(
    '9F 相位：新一轮刚开始（完成补丁还没落、索引又写成 started==ended）→ 仍然 thinking',
    newRow && newRow.phase === 'thinking' && newRow.inFlight === true,
    newRow && JSON.stringify({ phase: newRow.phase, inFlight: newRow.inFlight, index: newRow.liveIndex })
  );
  ok('9F 这一轮的轮序号 = 上一轮 + 1（不是沿用上一轮的）', newRow && newRow.liveIndex === 1, newRow && String(newRow.liveIndex));
  ok(
    '9F 改动文件只认写工具碰过的（read_file 不算）',
    Boolean(newRow) && Array.isArray(newRow.liveChanged) && newRow.liveChanged[0] && JSON.stringify(newRow.liveChanged[0].files) === JSON.stringify(['/tmp/ProjGitHubCopilot/src/highlight.ts']),
    JSON.stringify(newRow && newRow.liveChanged)
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
