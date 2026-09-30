'use strict';
/**
 * 成员卡上的「子代理功能描述」自检。
 *
 * 背景（2026-09-30 用户实测）：子代理卡片那一栏显示的是「项目子代理 · 空闲」——那是**状态话术**，
 * 不是子代理的功能。要显示的是 agent 定义文件里的 `description`（静态数据）：.md 在 YAML
 * frontmatter，Codex 的 .toml 是 `description = "…"`；尾巴上那句给模型看的
 * "（use PROACTIVELY …）"是噪声，要裁掉。
 *
 * 顺带锁住同一张卡上另外两件事：任务行带 endedAt（渲染层据此区分"当前任务"与"上一个任务"，
 * 空闲时不把上一条挂在卡片上），以及 lastTaskAt（「最近活跃」= 上一个任务在多久以前，
 * 不是最后一次心跳）。
 *
 * 跑法：`npm run test:agent-desc`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* HOME 必须在 require 之前指到沙箱：agentLevel.js 在 require 时就把家目录记下来了 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-agent-desc-'));
const HOME = path.join(TMP, 'home');
const WS = path.join(TMP, 'proj');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(WS, { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = path.join(TMP, 'wg');
delete process.env.CODEX_HOME; // 用沙箱里的 ~/.codex

const { agentDescription, detectLevel } = require('../src/ingest/agentLevel');
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

console.log('\n[2] 成员卡：描述随卡下发，任务行带 endedAt，最近活跃来自上一个任务的收工时刻');
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));
const bus = createIngestBus({ repo, hub: { broadcast() {} }, projectName: 'p1', project: 'p1' });
const now = Date.now();
repo.upsertProject.run({ id: 'p1', name: 'p1', workspacePath: WS, mainConversationId: null, source: 'report', createdAt: 1 });
bus.registerMember({ project: 'p1', memberId: 'leo', name: 'leo', role: 'subagent:project', workspacePath: WS, client: 'codebuddy' });
bus.registerMember({ project: 'p1', memberId: 'codex', name: 'codex', role: 'agent', workspacePath: WS, client: 'codex' });
repo.insertTask.run({ id: 't_done', projectId: 'p1', memberId: 'codex@p1', parentTaskId: null, title: '上一个任务', state: 'done', progress: 1, startedAt: now - 600_000, endedAt: now - 540_000 });
repo.upsertStatus.run({ memberId: 'codex@p1', state: 'idle', stateSince: now - 540_000, taskId: 't_done', progress: 1, currentFiles: null, lastHeartbeatAt: now, degraded: 0, source: 'report', updatedAt: now });

const snap = bus.buildSnapshot('p1');
const leo = snap.members.find((m) => m.memberId === 'leo@p1');
const codex = snap.members.find((m) => m.memberId === 'codex@p1');
ok('子代理卡带功能描述（不是"项目子代理 · 空闲"）', leo && leo.description.startsWith('产品经理子代理 Leo。'), leo && leo.description);
ok('级别照旧下发（工牌配色用）', leo && leo.level === 'project', leo && String(leo.level));
ok('任务行带 endedAt（渲染层据此判"已收工 = 上一个任务"）', Boolean(codex && codex.task && codex.task.endedAt === now - 540_000), codex && JSON.stringify(codex.task));
ok('lastTaskAt = 上一个任务的收工时刻（「最近活跃」的数据源）', Boolean(codex && codex.lastTaskAt === now - 540_000), codex && String(codex.lastTaskAt));
ok('没跑过任务的成员 lastTaskAt 为空（卡片显示 —，不编造）', Boolean(leo && leo.lastTaskAt === null), leo && String(leo.lastTaskAt));

close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
