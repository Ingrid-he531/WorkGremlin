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
 *     [C] 一层：只接纳 qoder 一种身份（CLI 与插件共用同一 client）；两路来源（cli 扫 transcript 产会话 + hook 实时相位兜底）；只装了 qoder 就算"装了"
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
// 6F Qoder：沙箱里放一个 qoder 可执行文件（让"装了"判定命中），并立一个 ~/.qoder 落盘根
fs.writeFileSync(path.join(BIN, 'qoder'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
fs.mkdirSync(path.join(HOME, '.qoder'), { recursive: true });
// 插件那一路的落盘根：故意**不放** genie-history —— 复现"这一路读不出会话"
fs.mkdirSync(path.join(HOME, '.marscode', 'ai-chat', 'AppData', 'vscode', 'ai-agent'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.marscode', 'ai-chat', 'AppData', 'vscode', 'ai-agent', 'database.db'), 'not a sqlite\n');
fs.mkdirSync(path.join(HOME, '.trae-cn', 'memory', 'projects'), { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
process.env.PATH = BIN;

const { snapshot, table } = require('../src/sessionRegistry');
const { reporterMainPhase, listSessions } = require('../src/sessions');
const { detectProducts } = require('../src/products');

/* ------------------------------ 造数据 ------------------------------ */

const WS = '/tmp/ProjCB';
/** 插件的会话 id：实测就是 hook payload 的 session_id（genie-history 的 conversationId 与之一字不差） */
const PLUGIN_SID = '0819ef3ed32241a4970a17b8013f9289';
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
fs.mkdirSync(path.join(STORAGE, 'todos'), { recursive: true });
fs.mkdirSync(path.join(STORAGE, 'file-changes', PLUGIN_SID), { recursive: true });
fs.mkdirSync(path.join(STORAGE, 'message-queue'), { recursive: true });
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
  JSON.stringify({ conversations: { [PLUGIN_SID]: { runtime: { activated: true, paused: false }, updatedAt: Date.now(), items: [] } } })
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
  const rel = path.join('projects', 'x.jsonl');
  const file = path.join(HOME, '.codebuddy', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ cwd: WS, type: 'message', text: 'hi' })}\n`);

  const snap = snapshot({ force: true, workspacePath: WS });
  const floor = snap.floors.find((f) => f.id === '1F');
  const fromHook = floor.sessions.filter((s) => s.sessionId === CLI_SID);
  const fromJsonl = floor.sessions.filter((s) => String(s.id).includes('x.jsonl'));
  ok('CLI 会话改由 jsonl 那一路列出', fromJsonl.length === 1, floor.sessions.map((s) => `${s.source}:${s.id}`).join(' '));
  ok('同一条 CLI 会话没有同时留下 hook 那一路的行（不重复）', fromHook.length === 0);
  ok('插件那条会话照常还在（两处落盘互不影响）', floor.sessions.some((s) => s.sessionId === PLUGIN_SID));
  const storage = listSessions({ force: true, client: 'codebuddy-plugin' });
  ok('插件落盘这一路自己仍然列得出会话', (storage.sessions || []).some((s) => s.id === PLUGIN_SID));
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
head('[C] 楼层表：6F 只有一层 Qoder（CLI 与插件合并，cli 扫 transcript + hook 兜底）');
{
  const products = detectProducts({ force: true });
  const floor = products.find((p) => p.id === '6F');
  ok('有 6F 这一层', Boolean(floor), products.map((p) => p.id).join(' '));
  ok('6F 名叫 Qoder', floor && floor.name === 'Qoder', floor && floor.name);
  ok('这一层只接纳 qoder 一种上报身份（CLI 与插件分不出，共用同一 client，无 qoder-plugin）', floor && JSON.stringify(floor.clients) === JSON.stringify(['qoder']), floor && JSON.stringify(floor.clients));
  ok(
    '两路来源：cli（扫 ~/.qoder/projects transcript 产会话）+ hook（实时相位兜底）',
    floor && JSON.stringify(floor.sources.map((s) => s.kind)) === JSON.stringify(['cli', 'hook']),
    floor && JSON.stringify(floor.sources.map((s) => `${s.label || s.kind}:${s.kind}`))
  );
  ok('cli 与 hook 两路都产会话（cli 扫 transcript、hook 兜底）', floor && floor.sources.filter((s) => s.sessions !== false).map((s) => s.kind).join(',') === 'cli,hook', floor && JSON.stringify(floor.sources.map((s) => `${s.kind}:${s.sessions}`)));
  ok('装了 qoder（沙箱里放了可执行文件）就算装了', floor && floor.installed === true, floor && String(floor.installPath));
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
