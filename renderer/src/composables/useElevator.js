/**
 * useElevator —— 楼层切换「电梯」过渡的状态机。
 *
 * 依据：docs/design-elevator-transition.md §2 时序表 / §4 状态机（含 §4.3 打断策略）/ §5.1 降级 /
 *      §7.2 组织方式 / §8.1 风险缓解，docs/design-elevator-effort.md §2.3（待定目标层高亮）。
 *
 * 四条定死的约定（改之前先看设计，别凭手感改）：
 *   1. 模块级单例 + ref，不进 Pinia —— 这是瞬时 UI 状态，进 store 会让每次动画
 *      广播一轮订阅（设计 §7.2）。App.vue、ElevatorDoors、FloorSelector 共用同一实例。
 *   2. **所有推进都必须过 `step()`**（内部先判 token + 挂 2s 兜底）。散着写 `await sleep`
 *      再各自判 token 是 T1 的写法，加打断逻辑后极易漏一处 —— 漏一处就是"上一趟的门开到
 *      一半、下一趟又关上"。
 *   3. 换脸（selectFloor）必须发生在关门 70% 之后 —— 内容突变要躲在门后。
 *   4. 不用 `transitionend`（多段编排里丢事件、会重复触发，设计已判定）。
 *
 * 纯逻辑、不碰 DOM（看门狗只挂一个 `visibilitychange`，见 settleElevator）、sleep 可注入：
 * `injectSleep(可控时钟)` 就能不起组件跑整套打断用例。
 */

import { computed, ref } from 'vue';
import { useSessionStore } from '../stores/sessions';

/** 各段时长（ms）—— 与 theme.css 里的 --dur-* token 一一对应，改一边要同步另一边 */
export const DURATIONS = { close: 180, open: 260, settle: 120 };

/** 关门进行到这个比例时提交 selectFloor：换脸必须发生在门后（设计 §2 段 1） */
export const COMMIT_AT = 0.7;

/**
 * 每段的兜底上限（设计 §8.1 第一条：**任何异常都不能把门永久关上**）。
 * 正常 `sleep` 一定会 resolve，这里防的是"注入的时钟不回调 / 主线程被卡住"这类极端情况：
 * 超过 `本段时长 + 2s` 仍没推进，就强制往下走。
 */
export const SEG_TIMEOUT_MS = 2000;

/**
 * 降级档（系统「减弱动态效果」）每半段淡入/淡出的时长（ms），与 theme.css 的 `--dur-flash` 一一对应。
 * 设计 §5.1 要求这个档总耗时 <100ms：40ms 淡出 + 换脸 + 40ms 淡入 = 80ms。
 */
export const FLASH_MS = 40;

/**
 * 井道运行时长：跨 N 层 = clamp(240 + 130 × N, 300, 700)
 *   N=1 → 300ms（全程 860ms）  N=2 → 500ms  N=3 → 630ms  N≥4 → 700ms 封顶
 * 封顶理由：4 层已是本产品最大跨度，再长用户会觉得「软件卡了在做特效」。
 */
export function moveMsFor(n) {
  return Math.min(700, Math.max(300, Math.round(240 + 130 * Math.abs(n))));
}

/** idle | closing | moving | opening | settling —— 唯一的动画真相，CSS 靠 data-phase 展开 */
const phase = ref('idle');
/** 本趟的目的层（运行中改目的层时，改的是它） */
const targetFloor = ref('');
/** 本趟的出发层：关门期间轿厢还停在这儿（见 carFloor） */
const fromFloor = ref('');
/**
 * 「改目的层」的预约位（设计 §4.3）：运行中点别的层不会瞬移，先走完当前这一层
 * （到最近可达层），到站后不开门、折返去它。到了这一步才把它转正成 targetFloor。
 */
const pendingTarget = ref('');
/** 本趟的井道运行时长，供轿厢写内联 transition-duration */
const moveMs = ref(moveMsFor(1));
/**
 * on | reduced | off —— `auto` 档在这里归一：
 *   on      完整电梯动画
 *   reduced 系统开了「减弱动态效果」：不演电梯，但**不做硬切**，给一次 80ms 淡出淡入（设计 §5.1）
 *   off     用户明确关掉动画：真·硬切，连淡入淡出也不要
 */
const motionMode = ref('on');
/** 降级档的淡出/淡入开关：挂在 ElevatorDoors 的 data-flash 上，CSS 只做 opacity */
const flash = ref(false);
/** 每次 request 自增：所有推进都靠它防串台 */
let token = 0;
/** 本趟是否已经提交过 selectFloor（门后换脸那一下）。closing 段"点当前层 = 反悔"要靠它区分 */
let committed = false;

/** sleep 可注入：单测换成可控时钟，不用真等 860ms */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sleep = defaultSleep;

export function injectSleep(fn) {
  sleep = typeof fn === 'function' ? fn : defaultSleep;
}

/**
 * 三档开关归并：localStorage['wg.elevatorMotion']（on / off / auto，缺省 auto），
 * auto 档看系统 prefers-reduced-motion。开关 UI 入口不做（effort §2-7），
 * 手动在控制台写 localStorage 即可验证。
 *
 * 注意 auto + 系统偏好 → **`reduced` 而不是 `off`**：系统那只偏好说的是"少动"，
 * 不是"没有反馈"。直接落 off 就成了硬切，切楼层什么动静都没有（设计 §5.1 的原意是给
 * 60ms 淡入淡出，总耗时 <100ms）。用户自己在设置里关掉，才是真·零动画。
 */
function readMode() {
  let v = 'auto';
  try {
    v = localStorage.getItem('wg.elevatorMotion') || 'auto';
  } catch {
    /* 隐私模式 / 禁用存储：按 auto 走 */
  }
  if (v === 'on' || v === 'off') return v;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'on';
  } catch {
    return 'on';
  }
}

/** 当前层（store 里那个）。延迟到用的时候再取 store：app.use(pinia) 之后才有 activePinia */
const currentFloor = computed(() => useSessionStore().selectedFloor);

/**
 * 高亮用（effort §2.3 方案 A）：t=0 就要点亮目的层胶囊，但 store 的 selectedFloor
 * 要到关门 70% 才提交 —— 中间这一百多毫秒没有真相，由这里统一兜住。
 * 有预约位时（运行中改目的层）亮**用户最后点的那个**：按了就该亮，这在真电梯里也是常识
 * （车还在往上一层走，但你按的 5F 已经亮了）。
 */
const displayFloor = computed(() => {
  if (phase.value === 'idle') return currentFloor.value;
  return pendingTarget.value || targetFloor.value;
});

/**
 * 轿厢用。与 displayFloor 同源（同一份 phase / targetFloor / currentFloor），
 * 但轿厢要等门关上才起步（设计 §2 段 2 才轮到 moving）：门还开着就滑走没有电梯感，
 * 所以 closing 期间它停在出发层。不另开一套来源，避免「高亮在 4F、轿厢在 3F」。
 * 注意它**不看 pendingTarget**：车是物理地去当前这一趟的目的地，预约位只影响按钮高亮。
 */
const carFloor = computed(() => {
  if (phase.value === 'idle') return currentFloor.value;
  return phase.value === 'closing' ? fromFloor.value : targetFloor.value;
});

/**
 * 本趟方向：'up' | 'down' | ''。液晶屏的 ▲▼ 用它 —— 只在**还没到站**（closing / moving）表态，
 * 与 pendingFloor 同一道闸：到站后方向就没有意义了，屏上不该留一支指着上的箭头（车已经停了）。
 * 注意判的是 fromFloor → targetFloor，**不是** carFloor → targetFloor：方向是「这一趟」的属性，
 * 关门时就要点亮，而 moving 段 carFloor 已经等于 target，按它判永远是空。
 * 楼层顺序取自 store.floors（与轿厢、高亮同一份来源），不在组件里另排一套。
 */
const facing = computed(() => phase.value === 'closing' || phase.value === 'moving');
const direction = computed(() => {
  if (!facing.value) return '';
  const floors = useSessionStore().floors;
  const a = floors.findIndex((f) => f.id === fromFloor.value);
  const b = floors.findIndex((f) => f.id === targetFloor.value);
  if (a < 0 || b < 0 || a === b) return '';
  return b > a ? 'up' : 'down';
});

/**
 * 液晶屏「待到达层」：只在还没到站时（closing / moving）有值，到站（opening / settling）立刻熄灭。
 * 与 displayFloor 的分工：displayFloor 回答「按钮该亮在哪层」（用户按的，含预约位）；
 * 这里回答「车正在去哪层」（本趟目的地），到了就没了。
 */
const pendingFloor = computed(() => (facing.value ? targetFloor.value : ''));

/** 楼层在表里的下标（算跨几层、算方向都靠它；表里没有 → -1） */
function floorIndex(store, id) {
  return store.floors.findIndex((f) => f.id === id);
}

/**
 * **唯一**的段推进入口：等这一段的时长，然后回报"这一趟还是不是当前趟"。
 *
 * - 返回 `false` = 已经被作废（有人按了别的层 / 反悔 / 强制收尾），调用方必须整趟退出；
 * - 内置 2s 兜底：`sleep` 迟迟不 resolve 时也强制往下走（设计 §8.1）。
 *   `sleep` 抛错也算"过了这一段"，同样不能把门锁死。
 */
function step(my, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(my === token);
    };
    const guard = setTimeout(finish, ms + SEG_TIMEOUT_MS);
    Promise.resolve()
      .then(() => sleep(ms))
      .then(() => {
        clearTimeout(guard);
        finish();
      })
      .catch(() => {
        clearTimeout(guard);
        finish();
      });
  });
}

/** 作废在途那一趟，并清掉本趟临时状态（phase 由调用方决定） */
function abortRun() {
  token += 1;
  committed = false;
  pendingTarget.value = '';
  targetFloor.value = '';
  fromFloor.value = '';
  flash.value = false; // 别把降级档的"淡出中"留在半路（那就是一屏看不见的内容）
}

/** 起一趟：关门 → 换脸 → 井道运行（含折返）→ 开门 → 就位 */
function startRun(id, store) {
  const my = ++token;
  committed = false;
  fromFloor.value = store.selectedFloor;
  targetFloor.value = id;
  pendingTarget.value = '';
  phase.value = 'closing';
  void run(my, store);
}

async function run(my, store) {
  // 段 1 关门：70% 处换脸（内容突变藏在门后）。目标层可能已在关门途中被改（§4.3），
  // 所以提交的是**当时的** targetFloor，而不是入参 id。
  const commitAt = Math.round(DURATIONS.close * COMMIT_AT);
  if (!(await step(my, commitAt))) return;
  committed = true;
  store.selectFloor(targetFloor.value);
  if (!(await step(my, DURATIONS.close - commitAt))) return;

  // 段 2 井道运行。可能走两段：运行中有人改了目的层 → 到站不开门、折返再走一段
  for (;;) {
    const n = floorIndex(store, targetFloor.value) - floorIndex(store, fromFloor.value);
    moveMs.value = moveMsFor(Number.isFinite(n) && n !== 0 ? n : 1);
    phase.value = 'moving';
    if (!(await step(my, moveMs.value))) return;

    const next = pendingTarget.value;
    if (!next) break;
    // 折返：这一层已经走完（**不瞬移**），门不开，换个目标再走一段 ——
    // effort §4 的"朴素两段式"：不做路径重规划，多花一段 moveMs，换代码量减半
    fromFloor.value = targetFloor.value;
    targetFloor.value = next;
    pendingTarget.value = '';
  }

  // 折返时 store 还停在"关门那一刻提交的目的地"（比如先提交了 3F）：门全程关着，
  // 到这里补一次换脸，突变照样藏在门后（单测 [7] 就是漏了这一步 —— 车到了 5F、内容还是 3F）
  if (store.selectedFloor !== targetFloor.value) store.selectFloor(targetFloor.value);

  // 段 3 开门
  phase.value = 'opening';
  if (!(await step(my, DURATIONS.open))) return;

  // 段 4 内容就位
  phase.value = 'settling';
  if (!(await step(my, DURATIONS.settle))) return;

  phase.value = 'idle';
  targetFloor.value = '';
  fromFloor.value = '';
}

/** 反悔（关门途中点当前层）：作废这一趟；门的目标值回到 idle 态，浏览器会从"合到一半"的位置继续滑开 */
function cancelRun() {
  abortRun();
  phase.value = 'idle';
}

/**
 * 强制收尾：把在途那一趟"走完"（该换的层换掉），门开、回 idle。
 *
 * 用在两处：页面被隐藏、App 卸载。**不是"取消回 idle"** —— 用户点了就该去，
 * 静默取消会变成"点了没反应"。触发条件是 `document.hidden`（最小化 / 切到别的页面），
 * **不看 `blur`**：点一下别的窗口就把动画掐掉太粗暴，而且 blur 并不触发定时器节流。
 */
export function settleElevator() {
  if (phase.value === 'idle') return;
  if (!committed && targetFloor.value) {
    committed = true;
    try {
      useSessionStore().selectFloor(targetFloor.value);
    } catch {
      /* store 还没就绪（极端时序）：忽略，不能因为收尾再抛一次 */
    }
  }
  abortRun();
  phase.value = 'idle';
}

/** 只在页面真的被隐藏时收尾：Chromium 会把隐藏页的定时器节流到分钟级，真等下去就是"门关着不动" */
let watchdogArmed = false;
function armWatchdog() {
  if (watchdogArmed || typeof document === 'undefined') return;
  watchdogArmed = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) settleElevator();
  });
}

/**
 * 呼梯 —— 全部打断策略都在这里（设计 §4.3 那张表就是下面这几段 if）：
 *
 * | 时机 | 点哪层 | 行为 |
 * | --- | --- | --- |
 * | 任意 | 点未安装层 | 忽略（不可达） |
 * | 任意 | （`off` 档） | 真·硬切：作废在途那一趟后直接 selectFloor，不演也不淡 |
 * | 任意 | （`reduced` 档） | 40ms 淡出 → 换脸 → 40ms 淡入，不走电梯那五段 |
 * | idle | 其它层 | 起一趟 |
 * | idle | 250ms 内重复点同一层 | 走一趟，不是两趟（**不需要专门去重**，见下） |
 * | closing | 当前层 | 反悔：门重开，回 idle |
 * | closing | 其它层 | 改目的层，**不重启关门**（关门是不可撤销的进行时） |
 * | moving | 即将到达的那层 | 忽略（反正马上到） |
 * | moving | 其它层 | 记预约位，到站不开门、折返 |
 * | opening / settling | 任意层 | **抢占**：立即重新关门（唯一允许打断的边界） |
 *
 * 设计 §4.3 说要给"250ms 内重复点同一层"做去重。**这里刻意不做**，理由有两条，
 * 都是实现时才看清的：
 *   ① 不需要：`startRun` 是同步把 phase 切到 closing 的，第二次点击落在 `closing` 分支，
 *      目标层相同 → 天然幂等，本来就只走一趟（有单测钉住这条）；
 *   ② 有害：做去重就得记"上次点的层 + 时刻"，而下面这个序列会踩到它 ——
 *      点 4F（起一趟）→ 50ms 后点 1F 反悔（回 idle）→ 100ms 后再点 4F：
 *      落在 250ms 窗口内，去重会把这次**真实的复按**吞掉，用户会觉得"按了没反应"。
 */
export async function request(id) {
  const store = useSessionStore();
  motionMode.value = readMode();

  // 未安装层（置灰 / :disabled）不可达，电梯不去点不动的层
  const floor = store.floors.find((f) => f.id === id);
  if (!floor || !floor.installed) return;

  // 零动画档：不演，直接换（effort §4-5）。在途那一趟要作废 —— 否则它回来还会再改一次楼层
  if (motionMode.value === 'off') {
    abortRun();
    store.selectFloor(id);
    return;
  }

  armWatchdog();

  if (id === currentFloor.value) {
    // 关门途中点当前层 = 反悔。换脸还没发生（committed=false），所以内容不用回滚
    if (phase.value === 'closing' && !committed) return cancelRun();
    return; // 已经在这层 / 正要去这层：无事发生
  }

  // 降级档：不演电梯，只做一次 40ms 淡出 → 换脸 → 40ms 淡入（总 80ms，设计 §5.1 要求 <100ms）。
  // 不落 off 是有意的：系统那只偏好说的是"少动"，不是"没有反馈"，硬切是另一种难看。
  if (motionMode.value === 'reduced') {
    abortRun();
    const my = ++token;
    flash.value = true;
    if (!(await step(my, FLASH_MS))) {
      flash.value = false;
      return;
    }
    store.selectFloor(id);
    flash.value = false;
    return;
  }

  if (phase.value === 'idle') return startRun(id, store);

  /* 这一段以下是 phase !== 'idle' 时的打断策略 */

  if (phase.value === 'closing') {
    targetFloor.value = id; // 门继续关，只是把目的层改掉（重启关门会闪）
    return;
  }

  if (phase.value === 'moving') {
    if (id === targetFloor.value) return; // 点即将到达的那层：忽略
    pendingTarget.value = id; // 预约：到站后折返（真电梯也得过了这层才能反向）
    return;
  }

  // opening / settling：唯一允许抢占的边界 —— 门还没全开就重新关上，比排队等 380ms 干脆
  return startRun(id, store);
}

/**
 * 单例出口。返回的都是同一个 ref —— 每次调用不会新建状态。
 * （App.vue 拿 phase / motionMode / request，FloorSelector 拿 carFloor / displayFloor / moveMs，
 *   FloorLcd 拿 carFloor / pendingFloor / direction / moveMs —— 液晶屏不自己算楼层。）
 */
export function useElevator() {
  return {
    phase,
    targetFloor,
    pendingTarget,
    currentFloor,
    displayFloor,
    carFloor,
    pendingFloor,
    direction,
    moveMs,
    motionMode,
    /** 降级档的淡出/淡入开关（ElevatorDoors 挂到 data-flash 上） */
    flash,
    request,
    settleElevator,
  };
}
