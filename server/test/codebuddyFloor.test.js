/**
 * 1F CodeBuddy「合并楼层」自检 —— 在沙箱里摆两处落盘 + 两份状态文件，验四件事。
 *
 * 跑法：`npm run test:codebuddy`（= node 直接跑，零依赖）。
 * 为什么要有它：这一层是 CLI 与 Plugin 合并来的，每个断言都对应一条"只有真实文件摆到位
 * 才现形"的行为 —— 楼层是不是一层、两处落盘是不是都认、同时开着两种形态时是两条会话、
 * 两条会话的相位会不会串味。所以不 mock，把 HOME / WORKGREMLIN_HOME 指到临时目录，
 * 让**真实的** products 探测、sessionRegistry、sessions 跑一遍。
 *
 * 覆盖：
 *   [1] 一层：1F = CodeBuddy，clients = codebuddy + codebuddy-plugin，sources 三路
 *       （cli / plugin / hook）；只装了 IDE 插件、没有 CLI 可执行文件也算"装了"
 *   [2] 同时开着 CLI 与 Plugin → 这一层里**两条会话**，不是两个楼层
 *   [3] 相位各认各的：client 传整层的串时，插件会话拿到插件的 tool、CLI 会话拿到自己的 thinking；
 *       只传单 client 时互不串味
 *   [4] jsonl 那一路优先：一旦 CLI 落盘扫得到会话，hook 那一路整层让位（同一条会话不会列两遍）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ 沙箱 ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cbfloor-'));
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
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
process.env.PATH = BIN;

const { snapshot } = require('../src/sessionRegistry');
const { reporterMainPhase, listSessions } = require('../src/sessions');
const { detectProducts } = require('../src/products');

/* ------------------------------ 造数据 ------------------------------ */

const WS = '/tmp/ProjCB';
/** 插件的会话 id：实测就是 hook payload 的 session_id（genie-history 的 conversationId 与之一字不差） */
const PLUGIN_SID = '0819ef3ed32241a4970a17b8013f9289';
/** CLI 的会话 id：hook payload 的 session_id（uuid 形状） */
const CLI_SID = 'aaaa1111-2222-3333-4444-555566667777';

/** 状态文件名照 hook.js 的 statePath：`<agent>@<工程>@<会话>` 整体 sanitize 成 [A-Za-z0-9._-] */
function writeState(client, sessionId, extra) {
  const name = `${client}@${WS}@${sessionId}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  fs.writeFileSync(
    path.join(HOOKS, `${name}.json`),
    JSON.stringify({ client, sessionId, taskId: `task-${sessionId}`, taskStartedAt: Date.now(), taskWorkspacePath: WS, hb: { lastEventAt: Date.now() }, ...extra }, null, 2)
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

/* [1] 一层：CLI 与 Plugin 是同一个楼层 */
head('[1] 楼层表：1F 只有一层 CodeBuddy，两种 client、三路来源都在这一层');
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

/* [2] 同时开着 CLI 与 Plugin → 一层里的两条会话 */
head('[2] 同时开着 CLI 与 Plugin：是这一层里的两条会话，不是两个楼层');
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

/* [3] 相位各认各的（不串味） */
head('[3] 同一层里两条会话的实时相位各认各的（这一层要认一串 client）');
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

/* [4] jsonl 优先：CLI 落盘有会话时，hook 那一路整层让位（同一条会话不列两遍） */
head('[4] CLI 落盘扫得到会话时，hook 兜底整层让位（同一条会话不会列两遍）');
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
