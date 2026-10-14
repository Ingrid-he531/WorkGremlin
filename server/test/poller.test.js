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
const { floors, taskSyncerFloors } = require('../src/floors');

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
  ok('恰好 4 层参与任务轮询（6F/7F/8F/9F）', JSON.stringify(ids) === JSON.stringify(['6F', '7F', '8F', '9F']), JSON.stringify(ids));
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
    bus: { sweepDegraded() {} },
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
    bus: { sweepDegraded() {} },
    repo: {},
    getWorkspace: () => ({ workspacePath: '' }),
    now: () => t,
    getFloors: () => list,
    snapshot: () => ({ defaultFloor: '1F', floors: [], sessions: [] }),
  });
  for (let i = 0; i <= 5; i += 1) { t = 2_000_000 + i * 1000; poller.tick(); }
  ok(`缺省 cadence = ${DEFAULT_POLL_MS}ms → 0/5000 两次`, n === 2, String(n));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
