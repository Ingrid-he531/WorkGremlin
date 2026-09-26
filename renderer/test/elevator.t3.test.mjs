/**
 * useElevator T3（打断 / retarget / 兜底）单测 —— 可控时钟，不起组件、不起 Electron。
 *
 * 跑法：`npm run test:elevator`（= node 直接跑，零依赖）。
 * 为什么不叫 *.test.js 挂到 node --test：仓库里 renderer 的源码用的是 Vite 风格的无扩展名导入
 * （`../stores/sessions`），node 原生跑不了，本文件顶部用 `module.registerHooks()` 补一个解析钩子。
 * docs/test-strategy.md 的 L1 规划是 Vitest —— 等 Vitest 落地后把这个文件迁过去即可（用例不用改）。
 *
 * 覆盖（设计 §4.3 那张策略表的每一行 + §8.1 两条风险）：
 *   [1] 基本一趟：五段走完，换脸发生在关门 70% 之后
 *   [2] 未安装层不可达      [3] 点当前层无事发生
 *   [4] 双击同一层只走一趟（不需要专门去重，见 useElevator 里的说明）
 *   [5] 关门途中反悔：门重开、内容不动
 *   [6] 关门途中改目的层：不重启关门，70% 处换的是新目标
 *   [7] 运行中改目的层：先到原目标再折返，不瞬移、不跳变
 *   [8] 运行中点"即将到达层"：忽略
 *   [9] 开门途中抢占：立即重新关门
 *   [10] 零动画档：不空转，直接换
 *   [11] settleElevator：在途那一趟走完、回 idle（页面隐藏 / 卸载用）
 *   [12] 兜底：sleep 永不 resolve 时，每段最多多等 2s 也强制往下走（真等约 4.5s）
 *   [13] 降级档（系统减弱动态效果）：不演电梯，只做 40+40ms 的淡出淡入
 */
import { registerHooks } from 'node:module';

/* ---------- 让 node 能解析 renderer 源码里的无扩展名导入（必须在 import 应用代码之前注册） ---------- */
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        for (const ext of ['.js', '/index.js', '.mjs']) {
          try {
            return next(specifier + ext, context);
          } catch {
            /* 试下一个后缀 */
          }
        }
      }
      throw err;
    }
  },
});

const { createPinia, setActivePinia } = await import('pinia');
const { useSessionStore } = await import('../src/stores/sessions.js');
const { useElevator, injectSleep, moveMsFor, settleElevator } = await import('../src/composables/useElevator.js');

setActivePinia(createPinia());
globalThis.localStorage = {
  s: {},
  getItem: (k) => globalThis.localStorage.s[k] ?? null,
  setItem: (k, v) => (globalThis.localStorage.s[k] = v),
};

const store = useSessionStore();
const { phase, request, displayFloor, carFloor, pendingTarget, pendingFloor, flash } = useElevator();
let commits = 0;
const rawSelect = store.selectFloor.bind(store);
store.selectFloor = (id) => {
  commits += 1;
  rawSelect(id);
};

const reset = () => {
  store.floors = ['1F', '2F', '3F', '4F', '5F'].map((id) => ({ id, name: id, installed: true, sessions: [], activeCount: 0 }));
  store.selectedFloor = '1F';
  commits = 0;
};

/* ------------------------------ 可控时钟 ------------------------------ */
let queue = [];
let clock = 0;
const tick = () => new Promise((r) => setTimeout(r, 0));
/** 可控时钟：sleep 只是把回调排进队列，由 advance() 手动推进 */
const fakeSleep = (ms) => new Promise((res) => queue.push({ at: clock + ms, res }));
injectSleep(fakeSleep);

let carSeq = [];
/** 推进假时钟 ms 毫秒：按时间顺序把到期的 sleep 挨个 resolve，并采一次轿厢位置 */
async function advance(ms) {
  await tick(); // 先让"刚发起的 request"把它那条 sleep 注册进来
  const target = clock + ms;
  for (;;) {
    let i = -1;
    let best = Infinity;
    queue.forEach((q, k) => {
      if (q.at <= target && q.at < best) {
        best = q.at;
        i = k;
      }
    });
    if (i < 0) break;
    const [q] = queue.splice(i, 1);
    clock = q.at;
    q.res();
    await tick();
    carSeq.push(carFloor.value);
  }
  clock = target;
  await tick();
}

/** 一直推到回 idle（或超时），返回推进的毫秒数 */
async function runToIdle(cap = 4000) {
  let t = 0;
  while (phase.value !== 'idle' && t < cap) {
    await advance(50);
    t += 50;
  }
  return t;
}

/* ------------------------------ 断言与用例 ------------------------------ */
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
  }
};
const head = (s) => console.log(`\n${s}`);
const fresh = () => {
  // 上一例可能留了一趟在途（比如 [12] 故意卡死的时钟）：先收尾，再把时钟换回可控的
  settleElevator();
  injectSleep(fakeSleep);
  reset();
  queue = [];
  clock = 0;
  carSeq = [];
};

head('[1] 基本一趟：1F → 3F，五段走完，换脸在关门 70% 之后');
fresh();
request('3F');
ok('立刻进 closing', phase.value === 'closing');
await advance(125);
ok('125ms（<70%）还没换脸', store.selectedFloor === '1F' && commits === 0);
await advance(2);
ok('127ms（≥70%）已换脸', store.selectedFloor === '3F' && commits === 1);
await advance(100);
ok('关门结束进 moving', phase.value === 'moving');
ok('轿厢已指向 3F', carFloor.value === '3F');
ok('跨 2 层 = 500ms', moveMsFor(2) === 500);
await advance(500);
ok('到站进 opening', phase.value === 'opening');
ok('到站后屏上目的层熄灭', pendingFloor.value === '');
await advance(260);
ok('开门结束进 settling', phase.value === 'settling');
await advance(120);
ok('就位后回 idle', phase.value === 'idle');
ok('全程只换脸一次', commits === 1);

head('[2] 未安装层：不启动');
fresh();
store.floors[2].installed = false;
request('3F');
ok('phase 仍是 idle', phase.value === 'idle', `实际 ${phase.value}`);
ok('没有换脸', commits === 0);

head('[3] 点当前层：无事发生');
fresh();
request('1F');
ok('phase 仍是 idle', phase.value === 'idle');

head('[4] 双击同一层：走一趟，不是两趟');
fresh();
request('4F');
const firstPhase = phase.value;
request('4F');
ok('第二次点击没有重启', phase.value === firstPhase && commits === 0);
await runToIdle();
ok('到 4F 且只换脸一次', store.selectedFloor === '4F' && commits === 1);
ok('回 idle', phase.value === 'idle');

head('[5] 关门途中反悔：门重开、内容不动');
fresh();
request('4F');
await advance(100);
ok('正在关门', phase.value === 'closing');
request('1F');
ok('立刻回 idle（门从当前位置滑开）', phase.value === 'idle');
await advance(600);
ok('没有换脸', store.selectedFloor === '1F' && commits === 0);
ok('那一趟确实被作废', phase.value === 'idle');

head('[6] 关门途中改目的层：不重启关门');
fresh();
request('4F');
await advance(100);
request('5F');
ok('门继续关', phase.value === 'closing');
ok('目的是新的 5F', pendingFloor.value === '5F');
await advance(30); // 越过 126ms 提交点
ok('70% 处换的是新目标', store.selectedFloor === '5F', `实际 ${store.selectedFloor}`);
await runToIdle();
ok('最终停在 5F', store.selectedFloor === '5F' && phase.value === 'idle');

head('[7] 运行中改目的层：先到 3F 再折返 5F，不瞬移');
fresh();
request('3F');
await advance(280); // 进 moving 100ms
ok('正在运行', phase.value === 'moving');
ok('轿厢朝 3F', carFloor.value === '3F');
request('5F');
ok('预约位记下来了', pendingTarget.value === '5F');
ok('本趟目标仍是 3F（不瞬移）', carFloor.value === '3F');
ok('按钮高亮已跟到 5F（按了就该亮）', displayFloor.value === '5F');
await advance(400);
ok('到 3F 后不开门，直接折返', phase.value === 'moving' && carFloor.value === '5F');
ok('内容已在 3F（换脸发生在关门时）', store.selectedFloor === '3F');
await advance(500);
ok('折返到站进 opening', phase.value === 'opening');
await runToIdle();
ok('最终停在 5F', store.selectedFloor === '5F' && phase.value === 'idle');
const i3 = carSeq.indexOf('3F');
const i5 = carSeq.indexOf('5F');
ok('轿厢轨迹单向 1F→3F→5F，无回跳', i3 >= 0 && i5 > i3 && carSeq.slice(i5).every((x) => x === '5F'), carSeq.join(','));

head('[8] 运行中点"即将到达层"：忽略');
fresh();
request('3F');
await advance(280);
request('3F');
ok('没有产生折返', pendingTarget.value === '', `实际 ${pendingTarget.value}`);
await runToIdle();
ok('正常到 3F', store.selectedFloor === '3F' && phase.value === 'idle');

head('[9] 开门途中抢占：立即重新关门');
fresh();
request('3F');
await advance(700); // 180 关门 + 500 运行 + 20 开门
ok('正在开门', phase.value === 'opening');
request('2F');
ok('立刻转 closing', phase.value === 'closing');
await runToIdle();
ok('最终停在 2F', store.selectedFloor === '2F' && phase.value === 'idle');

head('[10] off 档：零动画直接换');
fresh();
localStorage.setItem('wg.elevatorMotion', 'off');
await request('3F');
ok('直接换到 3F', store.selectedFloor === '3F');
ok('phase 始终 idle（不空转）', phase.value === 'idle');
localStorage.setItem('wg.elevatorMotion', 'on');

head('[11] settleElevator：把在途那一趟走完');
fresh();
request('4F');
await advance(100);
settleElevator();
ok('该换的层换掉了', store.selectedFloor === '4F');
ok('门开、回 idle', phase.value === 'idle');
await advance(600);
ok('那一趟不再回头改状态', store.selectedFloor === '4F' && phase.value === 'idle');
ok('预约位清空', pendingTarget.value === '');

head('[12] 兜底 2s：sleep 永不 resolve 也要往下走（真等约 4.5s）');
fresh();
injectSleep(() => new Promise(() => {})); // 卡死时钟
request('3F');
ok('已进 closing', phase.value === 'closing');
const t0 = Date.now();
await new Promise((r) => setTimeout(r, 4500));
ok(`4.5s 后已越过卡死段（实际 ${Date.now() - t0}ms）`, phase.value !== 'closing' && phase.value !== 'idle', `phase=${phase.value}`);
ok('兜底时也把层换掉了', store.selectedFloor === '3F');

head('[13] reduced 档（系统「减弱动态效果」）：40ms 淡出 → 换脸 → 40ms 淡入');
fresh();
globalThis.window = { matchMedia: () => ({ matches: true }) }; // 假装系统开了减弱动态效果
localStorage.setItem('wg.elevatorMotion', 'auto');
request('3F');
ok('不走电梯五段：phase 仍是 idle', phase.value === 'idle', `实际 ${phase.value}`);
ok('flash 打开（内容正在淡出）', flash.value === true);
await advance(39);
ok('39ms 还没换脸', store.selectedFloor === '1F' && commits === 0);
await advance(1);
ok('40ms 换脸完成', store.selectedFloor === '3F' && commits === 1);
ok('flash 已关（开始淡入）', flash.value === false);
ok('没有产生任何关门/运行相位', phase.value === 'idle');
delete globalThis.window;
localStorage.setItem('wg.elevatorMotion', 'on');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
injectSleep(null);
process.exit(fail ? 1 : 0);
