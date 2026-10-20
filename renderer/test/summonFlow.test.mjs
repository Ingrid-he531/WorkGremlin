/**
 * Summon flow check (pick up task in place -> ghost appears -> report in place -> wrap up).
 *
 * Background (user report, 2026-10-16): when the task is fast, the office animation gets beaten by
 * real data:
 *   1. the gremlin is still "walking to the console to pick up its task" while the ghost (the extra
 *      report ghost) already pops up;
 *   2. the main phase lights "Task done" first, swallowing the whole animation;
 *   3. the gremlin still has to walk back to its desk, so the report is never seen.
 * Now: the gremlin talks to the main console **in place** (no walk over, no walk back), and one summon
 * must play its whole arc (pick up task -> ghost appears busy -> report) before the wrap-up (the main
 * phase is deferred by IsoOfficeView via flowPending/whenFlowIdle).
 *
 * This drives the engine with a controllable clock and asserts:
 *   - during pick-up the ghost is not visible and the gremlin does not move;
 *   - the ghost only appears after the task is picked up;
 *   - the report bubble always says the result (even a very fast task is not swallowed);
 *   - once the arc drains, flowPending falls back to false (the view then releases "Task done").
 *
 * Run: `npm run test:summon-flow`
 */
import { register } from 'node:module';

// The engine uses extensionless relative imports like './iso' (Vite fills them in); Node needs a resolver hook
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, ctx, next) {
  try { return await next(specifier, ctx); } catch (e) {
    if (specifier.startsWith('.')) return next(specifier + '.js', ctx);
    throw e;
  }
}
`)
);

/** Controllable clock: the engine uses performance.now() everywhere, so faking it lets us fast-forward seconds */
let clock = 0;
globalThis.performance = { now: () => clock };

/** Collect drawn text into a sink (bubbles / name tags all go through fillText) */
function makeCtx(sink) {
  const any = new Proxy(function () {}, {
    get(_t, k) {
      if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
      if (k === 'fillText') {
        return (s) => {
          sink.push(String(s));
          return any;
        };
      }
      if (k === 'width' || k === 'height') return 100;
      if (k === Symbol.toPrimitive) return () => 0;
      return any;
    },
    apply: () => any,
    set: () => true,
  });
  return any;
}

let rafCb = null;
const drawn = [];
const fakeCanvas = () => ({
  width: 900,
  height: 700,
  style: {},
  getContext: () => makeCtx(drawn),
  addEventListener: () => {},
  removeEventListener: () => {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 700 }),
});
globalThis.document = { createElement: () => fakeCanvas(), addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = { devicePixelRatio: 1, addEventListener: () => {}, removeEventListener: () => {} };
globalThis.requestAnimationFrame = (cb) => {
  rafCb = cb;
  return 1;
};
globalThis.cancelAnimationFrame = () => {
  rafCb = null;
};

const { setLocale } = await import('../src/i18n/index.js');
setLocale('zh');
const { createIsoOffice } = await import('../src/iso/engine.js');

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

/** Fast-forward ms milliseconds (16ms per frame; the engine clamps dt to 0.05s) */
function advance(office, ms) {
  const frames = Math.ceil(ms / 16);
  for (let i = 0; i < frames; i += 1) {
    clock += 16;
    if (rafCb) { const cb = rafCb; rafCb = null; cb(clock); }
  }
}

const GREMLIN = { memberId: 'coder@x', name: 'coder', state: 'busy', role: 'subagent:project' };
const ghostWith = (extra = {}) => ({
  memberId: 'subagent-coder',
  name: 'coder',
  state: 'busy',
  ghost: true,
  task: '写文档',
  ...extra,
});

console.log('\n[1] 原地领任务：不走动、领完才现身幽灵');
{
  clock = 0;
  drawn.length = 0;
  const office = createIsoOffice(fakeCanvas(), {});
  office.setMembers([GREMLIN]);
  // Let it come in and walk to its seat and settle (entrance + a fairly long walk)
  advance(office, 12000);
  const at = office.screenOf('coder@x');
  ok('小怪物已落座（画布在出人）', Boolean(at));
  ok('还没召唤：没有待演的编排', office.flowPending() === false);

  office.setMembers([GREMLIN, ghostWith()]);
  advance(office, 1000);
  const during = office.screenOf('coder@x');
  const moved = at && during ? Math.hypot(during.x - at.x, during.y - at.y) : 999;
  ok('领任务期间小怪物原地不动（不再跑去控制台）', moved < 6, `位移 ${moved.toFixed(1)}px`);
  ok('领任务期间幽灵还不出现', office.screenOf('subagent-coder') === null);
  ok('领任务气泡说着任务名', drawn.includes('写文档'));
  ok('编排在跑（flowPending=true）', office.flowPending() === true);

  // Past DISPATCH_TALK (3.6s): the gremlin answers and the ghost should appear only now
  advance(office, 3200);
  ok('小怪物答「收到」', drawn.includes('收到'));
  ok('领完任务幽灵才现身', Boolean(office.screenOf('subagent-coder')));
}

console.log('\n[2] 任务再快也要汇报：先现身、再汇报，然后才收尾');
{
  drawn.length = 0;
  const office = createIsoOffice(fakeCanvas(), {});
  office.setMembers([GREMLIN]);
  advance(office, 12000);
  // Summon the ghost with a task, then it "finishes" right away (result arrives) — a very fast task
  const ghost = ghostWith({ memberId: 'subagent-coder-report' });
  office.setMembers([GREMLIN, ghost]);
  advance(office, 500);
  office.setMembers([GREMLIN, { ...ghost, result: '登录链路已重构' }]);
  advance(office, 4000); // pick-up (3.6s) runs out, ghost appears
  const g = office.screenOf(ghost.memberId);
  ok('收工很早，幽灵仍按节奏现身', Boolean(g));
  // Wait out REPORT_MIN_WORK (1.5s) + REPORT_TALK (3.4s); the report is spoken
  advance(office, 6000);
  ok('汇报气泡说出结果摘要', drawn.includes('登录链路已重构'));
  ok('落一笔最近结果（工位卡片可回看）', Boolean(office.lastResult('coder@x')));
  ok('整段跑完：flowPending 落回 false（视图据此放行「任务完成」）', office.flowPending() === false);
}

console.log('\n[3] 幽灵先被回收：补画的幽灵也要把汇报演完');
{
  drawn.length = 0;
  const office = createIsoOffice(fakeCanvas(), {});
  office.setMembers([GREMLIN]);
  advance(office, 12000);
  const ghost = ghostWith({ memberId: 'subagent-coder-recycled' });
  office.setMembers([GREMLIN, ghost]);
  advance(office, 500); // pick-up in progress
  // The ghost vanishes from the roster directly (no result written) — the extreme "very fast task" case
  office.setMembers([GREMLIN]);
  ok('幽灵没了，但编排还没完（要补汇报）', office.flowPending() === true);
  advance(office, 12000);
  ok('补画的幽灵照样把汇报说完', drawn.includes('已完成：写文档'));
  ok('收尾：flowPending 落回 false', office.flowPending() === false);
}

console.log('\n[4] 同一常驻小怪物召唤多只同名幽灵：头顶各自分道，不再叠成一只');
// Regression (2026-10-16): every same-name overhead ghost shared the gremlin's one hover centre, so
// several same-name subagents stacked into a single sprite. Each instance now gets its own lane
// around the seat (see seatFanOffset / SEAT_FAN_*), and the whole overhead area grows with the group.
{
  clock = 0;
  drawn.length = 0;
  const office = createIsoOffice(fakeCanvas(), {});
  office.setMembers([GREMLIN]);
  advance(office, 12000);
  // Freeze the drift direction so the lane separation is deterministic (the drift is random by design)
  const realRandom = Math.random;
  Math.random = () => 0.99999;
  try {
    const g1 = { ...ghostWith(), memberId: 'subagent-coder-1' };
    const g2 = { ...ghostWith({ task: '第二个任务' }), memberId: 'subagent-coder-2' };
    office.setMembers([GREMLIN, g1, g2]);
    // Two pick-up beats run back to back (DISPATCH_TALK ≈3.6s each) before both ghosts are up
    advance(office, 20000);
    const p1 = office.screenOf('subagent-coder-1');
    const p2 = office.screenOf('subagent-coder-2');
    ok('两只同名幽灵都现身', Boolean(p1) && Boolean(p2));
    const dist = p1 && p2 ? Math.hypot(p1.x - p2.x, p1.y - p2.y) : 0;
    ok('头顶各自分道（不再叠在一起）', dist > 30, `间距 ${dist.toFixed(1)}px`);
  } finally {
    Math.random = realRandom;
  }
}

console.log('\n[5] 切换楼层再回来：同一个任务不重播派单');
{
  clock = 0;
  drawn.length = 0;
  const office = createIsoOffice(fakeCanvas(), {});
  office.setMembers([GREMLIN]);
  advance(office, 12000);
  const ghost = ghostWith({ memberId: 'subagent-coder-floor-switch', taskKey: 'task-old' });
  office.setMembers([GREMLIN, ghost]);
  advance(office, 5000);
  ok('首次派单正常播放布置和收到', drawn.includes('写文档') && drawn.includes('收到'));

  // Leaving the floor removes the ghost from this engine's visible roster; it must not erase
  // the module-level dispatched-task ledger.
  drawn.length = 0;
  office.setMembers([]);
  advance(office, 100);
  office.setMembers([GREMLIN, ghost]);
  advance(office, 5000);
  ok('切回后小幽灵仍在工作', Boolean(office.screenOf(ghost.memberId)));
  ok('切回后不重播任务布置', !drawn.includes('写文档'), drawn.filter((s) => s === '写文档').length);
  ok('切回后不重播「收到」', !drawn.includes('收到'), drawn.filter((s) => s === '收到').length);
  ok('切回后没有残留编排', office.flowPending() === false);

  // The same memberId receiving a different task is a real new summon and must still play.
  drawn.length = 0;
  office.setMembers([GREMLIN, ghostWith({
    memberId: ghost.memberId,
    task: '写新文档',
    taskKey: 'task-new',
  })]);
  advance(office, 5000);
  ok('同一小幽灵的新任务仍会播放布置', drawn.includes('写新文档'));
  ok('同一小幽灵的新任务仍会回复收到', drawn.includes('收到'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
