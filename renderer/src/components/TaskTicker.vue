<script setup>
/**
 * TaskTicker —— 门楣上那块**长屏**：所有楼层当前任务的滚动条（2026-10-08 改版）。
 *
 * 上一版（FloorLcd）是"层站指示器"：答"现在在哪层 / 要去哪层"。现在整块屏改成任务流：
 *   · **不再显示当前楼层** —— 楼层在左边胶囊（FloorSelector）与轿厢里都有，屏上重复一份没用；
 *   · 屏**尽可能长**：门楣上项目名占它自己那点宽，剩下全给这块屏（见 ElevatorDoors 的布局）；
 *   · 内容 = **所有楼层**的当前任务，多个任务依次滚动；任务收工/取消后它就不再滚
 *     （服务端只回"还在跑的 + 最近几分钟收工的"，见 /api/v1/task-feed）。
 *
 * 三条硬约束（沿用 FloorLcd 那套）：
 *   1. 唯一真相源：条目全部来自服务端的 tasks 表（/api/v1/task-feed），本组件**不推断任务状态**；
 *      楼层号由 task.client 反查 sessions.floors 得到，不在这里另排一份楼层表；
 *   2. 只动 transform：滚动是 CSS keyframes 的 translateX，位移量 = 一份序列的实测宽度
 *      （写进 --ticker-shift），不碰 width / left / top；
 *   3. 无缝循环：轨道里放 N 份相同序列，动画正好走**一份**的宽度就回到原点，所以看不出接缝。
 *      N 由"一份宽度 vs 屏宽"算出来（屏比一份宽时补到填满，否则尾部会空一段）。
 *
 * 无障碍：滚动的段码对读屏是噪音 → 屏幕本体 aria-hidden，另给一句 sr-only 的静态文本。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { httpBase } from '../api/bridge';
import { useProjectStore } from '../stores/project';
import { useSessionStore } from '../stores/sessions';
import { floorAcceptsClient } from '../lib/clientMatch';
import { useI18n } from '../i18n';

const { t } = useI18n();
const project = useProjectStore();
const sessions = useSessionStore();

/** 轮询间隔：任务是低频事件（开工/收工），5s 足够，不必挂 WS */
const POLL_MS = 5000;
/**
 * 收工后还滚多久（分钟）：服务端按这个窗口回"刚收工"的那几条。
 * 用户要求"任务结束或取消后不再滚动" —— 这里是"结果再滚一会儿让人看见，之后自动退场"。
 */
const END_KEEP_MIN = 5;
/** 滚动速度（px/s）：一屏 1200px 大约 17s 走完一遍，读得完又不拖沓 */
const SPEED_PX_S = 70;
/** 最短一圈时长（s）：条目很短（比如只有「当前无任务」）时也别快成一道闪光 */
const MIN_DUR_S = 12;
/** 单条文本上限：一条滚过去要看得完，超长的标题截断（原文在悬停/任务记录页里看） */
const MAX_LEN = 120;
/** 降级路径（老服务端）一次取多少条台账：够覆盖"在跑的"，又不至于每 5s 拉一大包 */
const FALLBACK_LIMIT = 60;

/** 服务端回来的原始行 */
const rows = ref([]);
let timer = null;

async function getJson(path) {
  const info = project.serverInfo || {};
  const res = await fetch(`${httpBase(info)}${path}`, {
    headers: info.token ? { Authorization: `Bearer ${info.token}` } : undefined,
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data && data.ok ? data : null;
}

/**
 * 降级路径里自己筛出"该滚的那几条"，口径与服务端 /task-feed 一致：
 * 在跑的（僵尸任务服务端已归一成 cancelled，这里照单全收）+ 最近 END_KEEP_MIN 分钟收工的。
 * 只要**当前工程**的顶层任务（子任务是 subagent，滚出来会跟父任务重复一行）。
 */
function pickFeed(items) {
  const pid = project.projectId;
  const since = Date.now() - END_KEEP_MIN * 60_000;
  const running = [];
  const ended = [];
  for (const r of items) {
    if (!r || r.parent_task_id) continue;
    if (pid && r.project_id !== pid) continue;
    if (r.state === 'running') running.push(r);
    else if (['done', 'failed', 'cancelled'].includes(r.state) && Number(r.ended_at) >= since) ended.push(r);
  }
  running.sort((a, b) => Number(a.started_at) - Number(b.started_at));
  ended.sort((a, b) => Number(a.ended_at) - Number(b.ended_at));
  return [...running, ...ended];
}

async function load() {
  try {
    const q = new URLSearchParams({ minutes: String(END_KEEP_MIN) });
    // 只滚**当前工程**的任务：屋里站的是这个工程的人，别的工程的任务混进来是噪音
    if (project.projectId) q.set('project', project.projectId);

    const feed = await getJson(`/api/v1/task-feed?${q.toString()}`);
    if (feed) {
      rows.value = feed.items || [];
      return;
    }
    /**
     * 降级：server 是**常驻进程**（scripts/launch.js 管生命周期，重启客户端不会重启它），
     * 所以"新版客户端 + 旧版服务端"是常见组合 —— 旧进程上没有 /task-feed（404），
     * 这时退到台账接口 /task-runs 自己筛，别让屏上一句"暂无活跃任务"把真在跑的任务盖住
     * （2026-10-08 实测：1F 那条任务在库里好好跑着，屏上却什么都没有）。
     * 代价：/task-runs 按开工时刻倒序截断，一条跑了很久、又被几百条新任务挤到窗口外的
     * 老任务可能漏掉 —— 这只是降级档，正式路径仍走 /task-feed。
     */
    const runs = await getJson(`/api/v1/task-runs?limit=${FALLBACK_LIMIT}`);
    // 两条路都拿不到：留着上一份，下一轮再试（不把屏清空）
    if (runs) rows.value = pickFeed(runs.items || []);
  } catch {
    /* 拉不到就留着上一份，下一轮再试 */
  }
}

/** HH:mm（屏上是段码手感，只要时与分；日期交给任务记录页） */
function hhmm(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '--:--';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 任务标题里的"用户原话"。
 * 与 TaskRecordsView 的 promptOf 同一套规则：老数据把 IDE 注入的 `# Context from my IDE setup`
 * 整段存成了标题，钩子已经不再这么存，但历史行还在库里 —— 不剥一次屏上滚的就是一屏 IDE 上下文。
 */
function promptOf(title) {
  const raw = String(title || '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) return '';
  const injected =
    /^[ \t]*#{0,6}[ \t]*Context from my IDE setup\b/im.test(raw) ||
    /^[ \t]*#{1,6}[ \t]*(?:Active file|Open tabs)\b/im.test(raw);
  const body = injected
    ? raw.split(/^[ \t]*#{0,6}[ \t]*(?:My request|User request|Request|我的请求|用户请求)[ \t]*[:：][ \t]*$/im)
        .slice(1)
        .join('\n')
    : raw;
  return body.replace(/\s+/g, ' ').trim();
}

const clip = (s) => (s.length > MAX_LEN ? `${s.slice(0, MAX_LEN)}…` : s);

/**
 * client → 楼层号（1F / 3F …）。
 * 楼层归属以 sessions.floors 为准（与胶囊、轿厢同一份来源）；合并楼层（1F = CLI + Plugin）
 * 两种身份都要认。认不出（老任务没补 client）就写 '—'，不猜楼层。
 */
function floorOf(client) {
  const c = String(client || '');
  if (!c) return '—';
  const f = (sessions.floors || []).find((x) =>
    [x.client, ...(Array.isArray(x.clients) ? x.clients : [])].some((cc) => cc && floorAcceptsClient(cc, c))
  );
  return f ? f.id : '—';
}

/** 滚动条目：kind 决定颜色，text 是屏上那一整行 */
const items = computed(() => {
  const list = [];
  for (const r of rows.value) {
    if (!r) continue;
    const floor = floorOf(r.client);
    if (r.state === 'running') {
      const text = promptOf(r.title) || t('ticker.untitled');
      list.push({ id: r.id, kind: 'running', text: `${hhmm(r.started_at)} ${floor} ${t('ticker.task', { text: clip(text) })}` });
      continue;
    }
    // 收工的三态：完成（绿）/ 取消（红）/ 失败（红，文案如实写"失败"）
    const kind = r.state === 'done' ? 'done' : 'cancelled';
    const tail = r.state === 'done' ? t('ticker.done') : r.state === 'failed' ? t('ticker.failed') : t('ticker.cancelled');
    list.push({ id: `${r.id}:${r.state}`, kind, text: `${hhmm(r.ended_at)} ${floor} ${tail}` });
  }
  // 一条都没有：静态居中一句「暂无活跃任务」——不是留一块黑屏，也不滚
  // （滚一条"没有任务"看着像有东西在动，反倒像漏了什么）
  return list.length ? list : [{ id: 'none', kind: 'none', text: t('ticker.no_task') }];
});

/** 没有任务：屏上只摆一句静态居中的话，不进滚动轨道 */
const idle = computed(() => items.value.length === 1 && items.value[0].kind === 'none');

/** 读屏文本：屏上那串滚动的段码对 AT 是噪音，这里给一句静态的 */
const srText = computed(() => items.value.map((i) => i.text).join('；'));

/* ------------------------------ 滚动（无缝循环） ------------------------------ */

const viewEl = ref(null);
const trackEl = ref(null);
/** 一份序列的实测宽度（px）= 动画要走的距离 */
const seqW = ref(0);
/** 屏幕可视宽度（px） */
const viewW = ref(0);
/** 系统「减弱动态效果」：不滚，静态摆着 */
const reduce = ref(false);
let ro = null;

/** 内容指纹：变了才重启动画（否则每次轮询都会把滚到一半的字扯回原点） */
const sig = computed(() => items.value.map((i) => `${i.kind}:${i.text}`).join('|'));

/**
 * 轨道里放几份序列：动画走完一份就回原点，所以轨道至少要"一份 + 一屏"宽，
 * 否则尾部会先空出来一段（条目少 / 屏很宽时最容易撞上）。
 */
const reps = computed(() => {
  if (reduce.value) return 1; // 不滚就只摆一份
  // 还没量到宽度（首帧）时先按 2 份排 —— 拿 1 当除数会算出上千份，白铺一屏 DOM
  if (!seqW.value) return 2;
  return Math.max(2, Math.ceil(1 + viewW.value / seqW.value));
});
/** 一圈时长：按内容宽度算，保证快慢一致（条目多就滚得久，不是快得看不清） */
const durS = computed(() => (seqW.value ? Math.max(MIN_DUR_S, seqW.value / SPEED_PX_S) : 0));
const trackStyle = computed(() => ({
  animationDuration: `${durS.value}s`,
  '--ticker-shift': `-${seqW.value}px`,
}));

function measure() {
  const v = viewEl.value;
  if (v) viewW.value = v.clientWidth;
  // 轨道不在（没有任务时只摆一句静态的话）→ 宽度归零，别拿上一份的旧宽度算份数
  const seq = trackEl.value && trackEl.value.firstElementChild;
  seqW.value = seq ? seq.getBoundingClientRect().width : 0;
}

onMounted(async () => {
  await load();
  measure();
  if (typeof ResizeObserver !== 'undefined' && viewEl.value) {
    ro = new ResizeObserver(() => measure());
    ro.observe(viewEl.value);
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduce.value = mq.matches;
    const onChange = (e) => {
      reduce.value = e.matches;
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange); // 老 Safari
  }
  timer = setInterval(load, POLL_MS);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  timer = null;
  if (ro) ro.disconnect();
  ro = null;
});

// 内容变了（新任务 / 收工 / 切语言）→ DOM 换了 → 重新量宽度，动画按新宽度走
watch(sig, () => nextTick(measure));
// 份数变了（窗口缩放 / 初次量到宽度）→ 轨道重排，也要重量
watch(reps, () => nextTick(measure));
</script>

<template>
  <div class="ticker">
    <div ref="viewEl" class="screen">
      <!-- 没有任务：静态居中一句，不滚 -->
      <span v-if="idle" class="idle-line">{{ items[0].text }}</span>
      <!-- 有任务：滚动的段码不进无障碍树，读屏听下面的 .sr -->
      <div
        v-else
        ref="trackEl"
        :key="sig"
        class="track"
        :class="{ static: reduce }"
        :style="trackStyle"
        aria-hidden="true"
      >
        <span v-for="n in reps" :key="n" class="seq">
          <span v-for="it in items" :key="it.id" class="line" :class="`k-${it.kind}`">{{ it.text }}</span>
        </span>
      </div>
      <span class="scan" aria-hidden="true" />
    </div>
    <p class="sr" role="status" aria-live="polite">{{ srText }}</p>
  </div>
</template>

<style scoped>
/* 门楣里的一列：项目名占自己那份宽，剩下**全给这块屏**（屏尽可能长，见 ElevatorDoors） */
.ticker {
  flex: 1 1 auto;
  min-width: 0;
}

/* 屏壳：暗底 + 等宽字（段码手感），高度沿用液晶屏那一格（--lcd-slot） */
.screen {
  position: relative;
  display: flex;
  align-items: center;
  /* 居中：① 没有任务时那句话居中；② 有任务时轨道比屏宽，横向溢出两边均分，
     位移一份宽度后画面与起点完全重合，接缝照样看不出来 */
  justify-content: center;
  height: calc(var(--lcd-slot, 26px) + 16px);
  overflow: hidden;
  border: 1px solid var(--border-strong, #333b4a);
  border-radius: var(--radius, 10px);
  background: var(--lcd-bg, #05070a);
  box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.75);
  font-family: var(--mono, monospace);
}

/* 扫描线：静态背景（不参与动画），手感来自"有栅格"而不是"在闪" */
.scan {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    to bottom,
    rgba(255, 255, 255, 0.035) 0 1px,
    rgba(0, 0, 0, 0) 1px 3px
  );
}

/* 轨道：N 份序列横排，动画正好走一份（--ticker-shift）就无缝回到原点 */
.track {
  display: flex;
  flex: none;
  animation-name: ticker-roll;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}

/* 一份序列 */
.seq {
  display: flex;
  flex: none;
}

.line {
  flex: none;
  /* 条目之间的空档：一条滚完再接下一条，别让两条粘在一起 */
  padding-right: 48px;
  font-size: 13px;
  letter-spacing: 0.5px;
  white-space: nowrap;
  color: var(--text-dim);
}

/* 蓝 = 任务开始（正在跑）；绿 = 完成；红 = 取消 / 失败；灰 = 没有任务 */
.k-running {
  color: var(--accent, #4c8dff);
  text-shadow: 0 0 6px currentColor;
}

.k-done {
  color: var(--state-online, #2ecc71);
  text-shadow: 0 0 6px currentColor;
}

.k-cancelled {
  color: var(--state-blocked, #ff5c5c);
  text-shadow: 0 0 6px currentColor;
}

/* 没有任务：静态居中，颜色比"暗段"亮一档（--text-dim）——
   压得太暗会看成屏坏了，太亮又会跟蓝/绿/红那三条任务状态抢眼 */
.idle-line {
  padding: 0 12px;
  font-size: 13px;
  letter-spacing: 1px;
  white-space: nowrap;
  color: var(--text-dim, #9aa3b2);
}

@keyframes ticker-roll {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(var(--ticker-shift, -50%));
  }
}

/* 系统「减弱动态效果」：不滚，静态摆着（JS 那边同时把份数降到 1，不重复文本） */
@media (prefers-reduced-motion: reduce) {
  .track {
    animation: none !important;
  }
}

.track.static {
  animation: none;
}

/* 屏上段码不进无障碍树（见模板 aria-hidden），这一句是给 AT 的替代文本 */
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
</style>
