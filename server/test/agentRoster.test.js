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

const { db, repo, close } = openDatabase(path.join(TMP, 'test.db'));
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

console.log('\n[3] 注册本身不代表在线：没有显式状态行就是空闲');
fs.writeFileSync(leoFile, ['---', 'name: leo', '---', ''].join('\n'));
t += 15_000;
poller.tick();
ok('leo 重新注册回来', members().includes('leo:subagent:project:codebuddy'), JSON.stringify(members()));
const cardOf = (memberId) => bus.buildMemberCard(memberId) || {};
ok('新注册的 leo 没有 agent_status 行', (repo.getStatus.get('leo@p1') || null) === null);
ok('没有状态行时工位卡显示空闲', cardOf('leo@p1').state === 'idle', String(cardOf('leo@p1').state));

roster.markActive('leo');
ok('markActive 写入借用忙碌', cardOf('leo@p1').state === 'busy', String(cardOf('leo@p1').state));
roster.markIdle('leo');
ok('markIdle 删除状态行而不是写 idle', (repo.getStatus.get('leo@p1') || null) === null);
ok('markIdle 后工位回到空闲且仍被定义', cardOf('leo@p1').state === 'idle' && roster.isDefined('leo'));

console.log('\n[3a] 重启恢复顺序：幽灵先恢复、agent 定义后注册时仍显示忙碌');
{
  const lateFloor = { meta: { id: 'restart-test', agent: 'codebuddy' } };
  const lateId = 'late@p1';
  const lateState = () => cardOf(lateId).state;
  bus.setGhostRoster(roster);
  const spawned = bus.ghostSpawn({ project: 'p1', client: 'codebuddy', sessionId: 's-late', name: 'late', task: '重启后继续', id: 'late-1' });
  ok('幽灵恢复时同名 agent 还未定义', !roster.isDefined('late') && lateState() === undefined, String(lateState()));
  roster.registerAgent(lateFloor, { name: 'late', level: 'project', client: 'codebuddy' });
  ok('agent 定义出现后立即镜像活幽灵为忙碌', lateState() === 'busy', String(lateState()));
  bus.ghostRetire({ project: 'p1', client: 'codebuddy', sessionId: 's-late', name: 'late', id: 'late-1', result: '完成' });
  ok(
    '幽灵结束后工位回到空闲',
    lateState() === 'idle' && (repo.getStatus.get(lateId) || null) === null && !bus.isGhostAlive({ project: 'p1', name: 'late' }),
    `${String(lateState())} / ${String(bus.isGhostAlive({ project: 'p1', name: 'late' }))} / ${String(roster.isDefined('late'))}`
  );
  ok('晚注册的幽灵仍复用原 run', spawned && spawned.runId > 0);
}

console.log('\n[4] 召唤 → 工位忙碌；收工 → 回到空闲');
{
  const leoState = () => cardOf('leo@p1').state;
  bus.setGhostRoster(roster);
  ok('召唤前 leo 空闲', leoState() === 'idle', String(leoState()));
  bus.ghostSpawn({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'leo', task: '写文档', id: 'gl1' });
  ok('召唤后 leo 忙碌（幽灵在干活的镜像）', leoState() === 'busy', String(leoState()));
  bus.ghostRetire({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'leo', id: 'gl1', result: '写完' });
  ok('收工后 leo 回到空闲（幽灵散场复位）', leoState() === 'idle', String(leoState()));
}

console.log('\n[4a] 定义名大小写与文件名不一致时仍借用忙碌（Simmon / simmon）');
{
  const archState = () => cardOf('architect@p1').state;
  bus.setGhostRoster(roster);
  ok('大小写不敏感地认定已定义', roster.isDefined('Architect') && roster.isDefined('ARCHITECT'));
  const before = repo.listMembers.all('p1').length;
  roster.registerAgent({ meta: { id: 'other-floor', agent: 'codebuddy' } }, { name: 'ARCHITECT', level: 'user', client: 'codebuddy' });
  ok('同名不同大小写的定义不会建第二个工位', repo.listMembers.all('p1').length === before, `${before} -> ${repo.listMembers.all('p1').length}`);
  bus.ghostSpawn({ project: 'p1', client: 'codebuddy', sessionId: 's-case', name: 'Architect', task: '按定义名召唤', id: 'gc1' });
  ok('按定义名（首字母大写）召唤仍点亮同名工位', archState() === 'busy', String(archState()));
  ok(
    '借用忙碌写在常驻成员 id 上，而不是召唤名上',
    Boolean(repo.getStatus.get('architect@p1')) && (repo.getStatus.get('Architect@p1') || null) === null
  );
  bus.ghostRetire({ project: 'p1', client: 'codebuddy', sessionId: 's-case', name: 'Architect', id: 'gc1', result: '收工' });
  ok('按定义名收工后回到空闲', archState() === 'idle', String(archState()));
}

console.log('\n[5] 借用忙碌没有 TTL：以幽灵是否仍存活为准');
{
  const leoState = () => cardOf('leo@p1').state;
  bus.ghostSpawn({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'leo', task: '长任务', id: 'gl-ttl' });
  ok('召唤后 leo 忙碌', leoState() === 'busy', String(leoState()));
  t += 11 * 60_000;
  poller.syncAgentsNow();
  ok('超过 10 分钟但幽灵仍存活 → 工位保持忙碌', leoState() === 'busy', String(leoState()));
  bus.ghostRetire({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'leo', id: 'gl-ttl' });
  ok('收工后回到空闲', leoState() === 'idle', String(leoState()));
  bus.ghostSpawn({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'architect', task: '另一个长任务', id: 'arch-ttl' });
  ok('architect 的幽灵在跑时工位忙碌', cardOf('architect@p1').state === 'busy');
  t += 11 * 60_000;
  poller.syncAgentsNow();
  ok('时间流逝不会自动改写借用状态', cardOf('architect@p1').state === 'busy', String(cardOf('architect@p1').state));
  bus.ghostRetire({ project: 'p1', client: 'codebuddy', sessionId: 's1', name: 'architect', id: 'arch-ttl', result: '跑完了' });
  ok('只有明确的收工路径才清掉借用忙碌', cardOf('architect@p1').state === 'idle');
}

console.log('\n[6] 状态模型没有 online / offline / degraded / 状态历史');
{
  const statusColumns = db.prepare('PRAGMA table_info(agent_status)').all().map((c) => c.name);
  ok('agent_status 只有显式状态字段', JSON.stringify(statusColumns) === JSON.stringify(['member_id', 'state', 'state_since', 'updated_at']), JSON.stringify(statusColumns));
  ok('agent_status_history 已删除', db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_status_history'").get() == null);
  ok('shared 状态集合只有 busy / idle / blocked', JSON.stringify(require('@workgremlin/shared').AGENT_STATES) === JSON.stringify(['busy', 'idle', 'blocked']));
  let rejected = false;
  try {
    repo.upsertStatus.run({ memberId: 'leo@p1', state: 'blocked', stateSince: t, updatedAt: t });
  } catch {
    rejected = true;
  }
  ok('agent_status rejects blocked (blocked is session-scoped)', rejected);
  const missingSession = bus.setBlocked({ project: 'p1', memberId: 'leo' });
  ok('setBlocked requires a session id', missingSession.ok === false && missingSession.error === 'missing_session', JSON.stringify(missingSession));
  bus.setBorrowedBusy({ project: 'p1', memberId: 'leo', ts: t });
  const borrowed = repo.getStatus.get('leo@p1');
  bus.clearBorrowedBusy({ project: 'p1', memberId: 'leo' });
  const clearAgain = bus.clearBorrowedBusy({ project: 'p1', memberId: 'leo' });
  ok('borrowed busy has one writer and is idempotently cleared', borrowed && borrowed.state === 'busy' && clearAgain.ok && (repo.getStatus.get('leo@p1') || null) === null);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
