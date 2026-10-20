'use strict';
/**
 * Agent-roster self-test.
 *
 * The roster is now an upper-layer **registration API**: each floor scans its OWN agent dirs and
 * calls `registerAgent` / `unregisterAgent` (see agentLevel.makeAgentSync + poller.js). This test
 * drives that path end-to-end (floor scan → poller → roster → repo members) and locks:
 *   · a floor's project-level + user-level agents become members with the right role;
 *   · a definition file disappearing unregisters the member on the next scan;
 *   · the floor-provided level is what the member card shows (no central re-scan needed).
 *
 * Run: `npm run test:agent-roster`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* HOME / WORKGREMLIN_HOME must be set before requiring floors.js: each floor captures its home dir at load. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-roster-'));
const HOME = path.join(TMP, 'home');
const WS = path.join(TMP, 'proj');
fs.mkdirSync(path.join(HOME, '.codebuddy', 'agents'), { recursive: true });
fs.mkdirSync(path.join(WS, '.codebuddy', 'agents'), { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = path.join(TMP, 'wg');

const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');
const { createAgentRoster } = require('../src/ingest/agentRoster');
const { createPoller } = require('../src/poller');
const { floorByAgent } = require('../src/floors');

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

const leoFile = path.join(WS, '.codebuddy', 'agents', 'leo.md');
const archFile = path.join(HOME, '.codebuddy', 'agents', 'architect.md');
fs.writeFileSync(leoFile, ['---', 'name: leo', 'description: PM subagent', '---', ''].join('\n'));
fs.writeFileSync(archFile, ['---', 'name: architect', 'description: Architect', '---', ''].join('\n'));

const { repo, close } = openDatabase(path.join(TMP, 'test.db'));
repo.upsertProject.run({ id: 'p1', name: 'Proj One', workspacePath: WS, mainConversationId: null, source: 'report', createdAt: 1 });
const bus = createIngestBus({ repo, hub: { broadcast() {} }, projectName: 'Proj One', project: 'p1' });

let t = 1_000_000;
const roster = createAgentRoster({ bus, getProject: () => 'p1', getWorkspacePath: () => WS, now: () => t });

const poller = createPoller({
  bus,
  repo,
  getWorkspace: () => ({ workspacePath: WS, project: 'p1', projectName: 'Proj One' }),
  now: () => t,
  getFloors: () => [],
  getAgentFloors: () => [floorByAgent.codebuddy],
  snapshot: () => ({ defaultFloor: '1F', floors: [], sessions: [] }),
  agents: {
    pollMs: 15_000,
    registerAgent: (floor, a) => roster.registerAgent(floor, a),
    unregisterAgent: (floor, name) => roster.unregisterAgent(floor, name),
  },
});

const members = () => (repo.listMembers.all('p1') || []).map((m) => `${m.name}:${m.role}:${m.client}`).sort();

console.log('\n[1] 楼层扫自己的目录 → 上层注册成成员（项目级 + 用户级）');
poller.tick();
ok(
  '项目级 + 用户级 agent 都注册成了成员',
  JSON.stringify(members()) === JSON.stringify(['architect:subagent:user:codebuddy', 'leo:subagent:project:codebuddy']),
  JSON.stringify(members())
);
ok('名册的 isDefined 认这两个名字', roster.isDefined('leo') && roster.isDefined('architect'));
ok('defined 只列当前工程的', JSON.stringify([...roster.defined].sort()) === JSON.stringify(['architect', 'leo']), JSON.stringify(roster.defined));

console.log('\n[2] 定义文件消失 → 下一次扫盘注销该成员');
fs.rmSync(leoFile);
t += 15_000;
poller.tick();
ok('leo 被摘掉，只剩用户级 architect', JSON.stringify(members()) === JSON.stringify(['architect:subagent:user:codebuddy']), JSON.stringify(members()));
ok('isDefined 跟着变', !roster.isDefined('leo') && roster.isDefined('architect'));

console.log('\n[3] 召唤中的名字：名册心跳不覆盖它的工位状态');
fs.writeFileSync(leoFile, ['---', 'name: leo', '---', ''].join('\n'));
t += 15_000;
poller.tick();
ok('leo 重新注册回来', members().includes('leo:subagent:project:codebuddy'), JSON.stringify(members()));
roster.markActive('leo');
// After markActive, the per-round registerAgent (heartbeat) must not reset leo back to online
poller.syncAgentsNow();
ok('markActive 后 isDefined 仍为真（只是不再心跳）', roster.isDefined('leo'));
roster.markIdle('leo');
ok('markIdle 后仍定义', roster.isDefined('leo'));

console.log('\n[3a] 重启恢复顺序：幽灵先恢复、agent 定义后注册时仍显示忙碌');
{
  const lateFloor = { meta: { id: 'restart-test', agent: 'codebuddy' } };
  const lateId = 'late@p1';
  const lateState = () => (repo.getStatus.get(lateId) || {}).state;
  bus.setGhostRoster(roster);
  const spawned = bus.ghostSpawn({ project: 'p1', client: 'codebuddy', sessionId: 's-late', name: 'late', task: '重启后继续', id: 'late-1' });
  ok('幽灵恢复时同名 agent 还未定义', !roster.isDefined('late') && lateState() == null, String(lateState()));
  roster.registerAgent(lateFloor, { name: 'late', level: 'project', client: 'codebuddy' });
  ok('agent 定义出现后立即镜像活幽灵为忙碌', lateState() === 'busy', String(lateState()));
  bus.ghostRetire({ project: 'p1', client: 'codebuddy', sessionId: 's-late', name: 'late', id: 'late-1', result: '完成' });
  ok(
    '幽灵结束后工位回到在线',
    lateState() === 'online' && !bus.isGhostAlive({ project: 'p1', name: 'late' }),
    `${String(lateState())} / ${String(bus.isGhostAlive({ project: 'p1', name: 'late' }))} / ${String(roster.isDefined('late'))}`
  );
  ok('晚注册的幽灵仍复用原 run', spawned && spawned.runId > 0);
}

console.log('\n[4] 召唤 → 工位忙碌；收工 → 回到在线（回归：被召唤的小怪物状态仍是空闲）');
{
  // The ghost is the one doing the work, but the resident workstation must mirror its state
  // (busy while the summon runs, back to online once it ends) -- otherwise the office card shows
  // "idle" while a gremlin is out on a task.
  const leoId = (repo.getMember.get('leo@p1') || {}).id;
  const leoState = () => (leoId ? (repo.getStatus.get(leoId) || {}).state : null);
  bus.setGhostRoster(roster);
  ok('召唤前 leo 在线', leoState() === 'online', String(leoState()));
  bus.ghostSpawn({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'leo', task: '写文档', id: 'gl1' });
  ok('召唤后 leo 忙碌（幽灵在干活的镜像）', leoState() === 'busy', String(leoState()));
  bus.ghostRetire({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'leo', id: 'gl1', result: '写完' });
  ok('收工后 leo 回到在线（幽灵散场复位）', leoState() === 'online', String(leoState()));
}

console.log('\n[5] 忙碌租约：幽灵还活着就续期，幽灵没了才让 TTL 兜底');
{
  const leoId = (repo.getMember.get('leo@p1') || {}).id;
  const leoState = () => (leoId ? (repo.getStatus.get(leoId) || {}).state : null);
  // Live ghost past the TTL: the roster must renew the lease instead of resetting the card to online.
  bus.ghostSpawn({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'leo', task: '长任务', id: 'gl-ttl' });
  ok('召唤后 leo 忙碌', leoState() === 'busy', String(leoState()));
  t += 11 * 60_000;
  poller.syncAgentsNow();
  ok('超过 10 分钟但幽灵仍存活 → 工位保持忙碌', leoState() === 'busy', String(leoState()));
  bus.ghostRetire({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'leo', id: 'gl-ttl' });
  ok('收工后回到在线', leoState() === 'online', String(leoState()));

  // No ghost at all: the TTL must still clear a leaked marker (lost end event).
  roster.markActive('architect');
  ok('architect 标记忙碌', (repo.getStatus.get((repo.getMember.get('architect@p1') || {}).id) || {}).state === 'busy');
  t += 11 * 60_000;
  poller.syncAgentsNow();
  ok(
    '没有幽灵且超过 TTL → 兜底回到在线（不会永久卡忙碌）',
    (repo.getStatus.get((repo.getMember.get('architect@p1') || {}).id) || {}).state === 'online'
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
