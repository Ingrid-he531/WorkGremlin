'use strict';
/**
 * unified poller self-test — locks the refactor's contract:
 *   · floor modules hold no timers (no `start*Syncer` export) and opt into polling only via
 *     `syncTasks` + `pollMs`;
 *   · the server drives them from ONE registry walk (no hardcoded floor ids), each on its own cadence;
 *   · one floor throwing never stops the others (per-floor swallow).
 *
 * Run: `npm run test:poller`
 */
const { createPoller, DEFAULT_POLL_MS } = require('../src/poller');
const { floors, taskSyncerFloors, agentSyncerFloors } = require('../src/floors');

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

head('[1] 楼层不持有定时器，只靠 syncTasks + pollMs 参与轮询');
{
  const list = taskSyncerFloors();
  const ids = list.map((f) => f.meta.id).sort();
  ok('恰好 5 层参与任务轮询（2F/6F/7F/8F/9F）', JSON.stringify(ids) === JSON.stringify(['2F', '6F', '7F', '8F', '9F']), JSON.stringify(ids));
  ok('每层都导出了 syncTasks 函数', list.every((f) => typeof f.syncTasks === 'function'));
  ok('每层都声明了 pollMs', list.every((f) => Number(f.pollMs) > 0));

  const timerExports = [];
  for (const f of Object.values(floors)) {
    for (const k of Object.keys(f)) {
      if (/^start.*Syncer$/.test(k)) timerExports.push(`${f.meta.id}.${k}`);
    }
  }
  ok('没有任何楼层再导出 start*Syncer（时钟已上收）', timerExports.length === 0, timerExports.join(','));
}

head('[2] 一个循环按注册表遍历，各层按自己的 pollMs 节流');
{
  const calls = new Map();
  const ctxSeen = [];
  const mk = (id, pollMs, opts = {}) => ({
    meta: { id },
    pollMs,
    syncTasks: (ctx) => {
      calls.set(id, (calls.get(id) || 0) + 1);
      ctxSeen.push(ctx);
      if (opts.throw) throw new Error('boom');
    },
  });
  const list = [mk('A', 5000), mk('B', 1000), mk('C', 5000, { throw: true })];
  let t = 1_000_000;
  const poller = createPoller({
    bus: {},
    repo: {},
    getWorkspace: () => ({ workspacePath: '' }),
    broadcast: () => {},
    now: () => t,
    getFloors: () => list,
    snapshot: () => ({ defaultFloor: '1F', floors: [], sessions: [] }),
  });

  // t = base, base+1000, ... base+5000
  for (let i = 0; i <= 5; i += 1) {
    t = 1_000_000 + i * 1000;
    poller.tick();
  }

  ok('A（pollMs 5000）在 0/5000 各跑一次 = 2', calls.get('A') === 2, String(calls.get('A')));
  ok('B（pollMs 1000）每 tick 都跑 = 6', calls.get('B') === 6, String(calls.get('B')));
  ok('C 抛异常被吞掉，A/B 照常跑（不阻断主循环）', calls.get('A') === 2 && calls.get('B') === 6);
  ok('syncTasks 收到 { bus, repo, now }', ctxSeen.length > 0 && typeof ctxSeen[0].bus === 'object' && typeof ctxSeen[0].now === 'function');
}

head('[3] 没声明 pollMs 的楼层按缺省 5000 节流');
{
  let n = 0;
  const list = [{ meta: { id: 'X' }, syncTasks: () => { n += 1; } }];
  let t = 2_000_000;
  const poller = createPoller({
    bus: {},
    repo: {},
    getWorkspace: () => ({ workspacePath: '' }),
    now: () => t,
    getFloors: () => list,
    snapshot: () => ({ defaultFloor: '1F', floors: [], sessions: [] }),
  });
  for (let i = 0; i <= 5; i += 1) { t = 2_000_000 + i * 1000; poller.tick(); }
  ok(`缺省 cadence = ${DEFAULT_POLL_MS}ms → 0/5000 两次`, n === 2, String(n));
}

head('[4] 楼层自己扫 agent，经上层注册；当前工程名随 ctx 传入；按 agents 节奏节流');
{
  const ctxs = [];
  const registered = [];
  const removed = [];
  const floorA = {
    meta: { id: '1F', agent: 'codebuddy' },
    syncAgents: (ctx) => {
      ctxs.push(ctx);
      ctx.registerAgent({ name: 'leo', level: 'project', client: 'codebuddy' });
      ctx.registerAgent({ name: 'architect', level: 'user', client: 'codebuddy' });
      if (ctxs.length > 1) ctx.unregisterAgent('gone');
    },
  };
  let t = 3_000_000;
  const poller = createPoller({
    bus: {},
    repo: {},
    getWorkspace: () => ({ workspacePath: '/ws', project: 'p1', projectName: 'Demo Project' }),
    now: () => t,
    getFloors: () => [],
    getAgentFloors: () => [floorA],
    snapshot: () => ({ defaultFloor: '1F', floors: [], sessions: [] }),
    agents: {
      pollMs: 15_000,
      registerAgent: (floor, a) => registered.push([floor.meta.id, a.name, a.level]),
      unregisterAgent: (floor, name) => removed.push([floor.meta.id, name]),
    },
  });

  poller.tick();
  ok('第一次 tick 就扫了（floor 注册了两个 agent）', registered.length === 2, JSON.stringify(registered));
  ok('上层收到的是 { name, level, client }（level 由楼层判定）', registered[0][1] === 'leo' && registered[0][2] === 'project');
  ok('ctx 带上了当前工程 id + 显示名 + 工作区', ctxs[0].project === 'p1' && ctxs[0].projectName === 'Demo Project' && ctxs[0].workspacePath === '/ws');

  t += 5_000;
  poller.tick();
  ok('未到 15s 不再扫（仍只扫过一次）', ctxs.length === 1, String(ctxs.length));

  t += 10_000; // cum 15s
  poller.tick();
  ok('到 15s 又扫一次', ctxs.length === 2, String(ctxs.length));
  ok('楼层发现消失的 agent → 调上层 unregister', removed.length === 1 && removed[0][1] === 'gone', JSON.stringify(removed));

  poller.syncAgentsNow();
  ok('syncAgentsNow() 忽略节流，立刻再扫一次', ctxs.length === 3, String(ctxs.length));
}

head('[6] 会话扫描成功后才对账孤儿任务；扫描失败时不触发取消');
{
  let t = 4_000_000;
  let scanOk = false;
  let reconcileCalls = 0;
  let seenIds = null;
  const poller = createPoller({
    bus: {
      reconcileRunningTasksWithActiveSessions: ({ activeSessionIds }) => {
        reconcileCalls += 1;
        seenIds = [...activeSessionIds];
      },
    },
    repo: {},
    getWorkspace: () => ({ workspacePath: '' }),
    now: () => t,
    getFloors: () => [],
    getAgentFloors: () => [],
    snapshot: () => {
      if (!scanOk) throw new Error('scan failed');
      return { defaultFloor: '1F', floors: [], sessions: [] };
    },
    getActiveSessionIds: () => new Set(['active-session']),
  });

  poller.tick();
  ok('首次扫描失败不触发孤儿任务取消', reconcileCalls === 0, String(reconcileCalls));

  t += 2_000;
  scanOk = true;
  poller.tick();
  ok('成功扫描后立即对账一次', reconcileCalls === 1, String(reconcileCalls));
  ok(
    '对账只收到活跃 session id',
    JSON.stringify(seenIds) === JSON.stringify(['active-session']),
    JSON.stringify(seenIds)
  );

  t += 2_000;
  scanOk = false;
  poller.tick();
  ok('后续扫描失败不再触发对账', reconcileCalls === 1, String(reconcileCalls));
}

head('[7] getActiveSessionIds 只收集活跃且有 id 的会话');
{
  const { table, getActiveSessionIds } = require('../src/sessionRegistry');
  const keys = ['__active_a', '__active_b', '__active_c'];
  table.set(keys[0], { active: true, sessionId: 's-active' });
  table.set(keys[1], { active: false, sessionId: 's-stale' });
  table.set(keys[2], { active: true, sessionId: '' });
  const ids = getActiveSessionIds();
  ok('只返回 active=true 且 sessionId 非空的会话', ids.has('s-active') && !ids.has('s-stale') && !ids.has(''), JSON.stringify([...ids]));
  for (const key of keys) table.delete(key);
}

head('[5] 楼层注册表：agentSyncerFloors 是"导出了 syncAgents"的楼层');
{
  const list = agentSyncerFloors();
  const ids = list.map((f) => f.meta.id).sort();
  ok('有 agent 目录的楼层都参与（1F~6F/8F；7F/9F 目录为空不参与）',
    JSON.stringify(ids) === JSON.stringify(['1F', '2F', '3F', '4F', '5F', '6F', '8F']), JSON.stringify(ids));
  ok('每层都有 syncAgents 函数', list.every((f) => typeof f.syncAgents === 'function'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
