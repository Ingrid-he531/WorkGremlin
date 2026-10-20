'use strict';
/**
 * Member-card agent-description self-test.
 *
 * The card must show the static `description` from the agent definition file, not status text.
 * Markdown files keep it in YAML frontmatter; Codex TOML files use `description = "..."`.
 * The model-facing "(use PROACTIVELY ...)" suffix is noise and must be removed.
 *
 * The same card also locks two state rules: running tasks carry their real session/timestamps,
 * and last-active time comes from task start/end timestamps rather than any heartbeat.
 *
 * Run: `npm run test:agent-desc`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* HOME 必须在 require 之前指到沙箱：floors.js 在 require 时各楼层就把家目录记下来了 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-agent-desc-'));
const HOME = path.join(TMP, 'home');
const WS = path.join(TMP, 'proj');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(WS, { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = path.join(TMP, 'wg');
delete process.env.CODEX_HOME; // 用沙箱里的 ~/.codex

// 静态 subagent 的发现已下放到各楼层（见 server/src/floor<X>.js 的 agentDirs），
// floors.js 负责按目录聚合 + 按 client 派发；这里直接从 floors 取。
const { agentDescription, detectLevel } = require('../src/floors');
const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');

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

console.log('\n[1] 描述从 agent 定义文件里读（.md 的 frontmatter / .toml 的 description）');
fs.mkdirSync(path.join(WS, '.codebuddy', 'agents'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.codex', 'agents'), { recursive: true });
fs.writeFileSync(
  path.join(WS, '.codebuddy', 'agents', 'leo.md'),
  ['---', 'name: leo', 'description: 产品经理子代理 Leo。擅长需求梳理与 PRD。（use PROACTIVELY when the task is about PM).', '---', '', '你是 Leo。'].join('\n')
);
fs.writeFileSync(
  path.join(HOME, '.codex', 'agents', 'architect.toml'),
  ['name = "architect"', 'description = "资深架构师子代理：做系统设计与技术选型。"', ''].join('\n')
);
ok('项目级 .md：读到功能描述', agentDescription('leo', WS).startsWith('产品经理子代理 Leo。'), agentDescription('leo', WS));
ok('尾巴上那句英文触发说明被裁掉', !/PROACTIVELY/i.test(agentDescription('leo', WS)), agentDescription('leo', WS));
ok('用户级 .toml：同样读得到', agentDescription('architect', WS) === '资深架构师子代理：做系统设计与技术选型。', agentDescription('architect', WS));
ok('没有定义的成员回空串（卡片那一栏隐藏，不拿状态话术顶替）', agentDescription('nobody', WS) === '', agentDescription('nobody', WS));
ok('级别判定照旧（项目级 / 用户级）', detectLevel('leo', WS) === 'project' && detectLevel('architect', WS) === 'user');
let noWs = '__threw__';
try {
  noWs = agentDescription('leo', '/no/such/dir');
} catch {
  /* 保持哨兵值：抛异常就是失败 */
}
ok('工程路径不存在时不炸，回空串（项目级 agent 没地方找）', noWs === '', noWs);

console.log('\n[2] Member card: description, no idle-row residue, and task-derived last-active time');
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));
const bus = createIngestBus({ repo, hub: { broadcast() {} }, projectName: 'p1', project: 'p1' });
const now = Date.now();
repo.upsertProject.run({ id: 'p1', name: 'p1', workspacePath: WS, mainConversationId: null, source: 'report', createdAt: 1 });
bus.registerMember({ project: 'p1', memberId: 'leo', name: 'leo', role: 'subagent:project', workspacePath: WS, client: 'codebuddy' });
bus.registerMember({ project: 'p1', memberId: 'codex', name: 'codex', role: 'agent', workspacePath: WS, client: 'codex' });
repo.insertTask.run({ id: 't_done', projectId: 'p1', memberId: 'codex@p1', parentTaskId: null, title: '上一个任务', state: 'done', progress: 1, startedAt: now - 600_000, endedAt: now - 540_000 });

const snap = bus.buildSnapshot('p1');
const leo = snap.members.find((m) => m.memberId === 'leo@p1');
const codex = snap.members.find((m) => m.memberId === 'codex@p1');
ok('子代理卡带功能描述（不是"项目子代理 · 空闲"）', leo && leo.description.startsWith('产品经理子代理 Leo。'), leo && leo.description);
ok('级别照旧下发（工牌配色用）', leo && leo.level === 'project', leo && String(leo.level));
ok('已结束任务不挂成当前任务', Boolean(codex && Array.isArray(codex.tasks) && codex.tasks.length === 0), codex && JSON.stringify(codex.tasks));
ok('没有显式状态行时，成员按任务推断为空闲', Boolean(codex && codex.state === 'idle'), codex && codex.state);
ok('收工后不保留 agent_status 行', repo.getStatus.get('codex@p1') === undefined);
ok('lastTaskAt = 上一个任务的收工时刻（「最近活跃」的数据源）', Boolean(codex && codex.lastTaskAt === now - 540_000), codex && String(codex.lastTaskAt));
ok('没跑过任务的成员 lastTaskAt 为空（卡片显示 —，不编造）', Boolean(leo && leo.lastTaskAt === null), leo && String(leo.lastTaskAt));

close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
