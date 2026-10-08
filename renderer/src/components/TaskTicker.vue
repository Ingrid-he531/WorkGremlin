<script setup>
/**
 * TaskTicker —— 门楣上那块**长屏**：所有楼层当前任务的滚动条（2026-10-08 改版）。
 *
 * 上一版（FloorLcd）是"层站指示器"：答"现在在哪层 / 要去哪层"。现在整块屏改成任务流：
 *   · **不再显示当前楼层** —— 楼层在左边胶囊（FloorSelector）与轿厢里都有，屏上重复一份没用；
 *   · 屏**尽可能长**：门楣上项目名占它自己那点宽，剩下全给这块屏（见 ElevatorDoors 的布局）；
 *   · 内容 = **所有楼层正在跑**的任务（running），依次无限滚动；任务收工/取消时，结果行
 *     **只滚一遍**就退场（不再循环），之后只剩进行中的任务；都没了居中显示「暂无活跃任务」。
 *     服务端回"还在跑的 + 最近几分钟收工的"，见 /api/v1/task-feed。
 *
 * 三条硬约束（沿用 FloorLcd 那套）：
 *   1. 唯一真相源：条目全部来自服务端的 tasks 表（/api/v1/task-feed），本组件**不推断任务状态**；
 *      楼层号由 task.client 反查 sessions.floors 得到，不在这里另排一份楼层表；
 *   2. 只动 transform：滚动由 JS rAF 每帧写 `translateX(offset)`，offset 连续累加，
 *      不碰 width / left / top；这样增删内容（尤其是结束行）不会让已滚到一半的位置跳一下；
 *   3. 单条传送带：所有行（进行中 + 结束）都从最右侧进、向左滚；进行中行滚出左边缘
 *      就循环回右端（常驻滚动、字都从最右进），结束行滚出即删（只一遍，不重复）。
 *      offset 连续累加、回收时按"滚出行的宽度"补偿，增删内容不会让后面的字跳一下。
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
 * 收工后还"看不看得见"的窗口（分钟）：服务端按这个窗口回"刚收工"的那几条，
 * 本组件据此挑出要播报的结束提示。播报只滚一遍（见 detectEnded：结束行滚出左边缘即删），
 * 窗口只决定能捕捉到哪些刚结束的任务，不影响"已结束就不再循环"。
 */
const END_KEEP_MIN = 5;
/** 滚动速度（px/s）：一屏 1200px 大约 17s 走完一遍，读得完又不拖沓 */
const SPEED_PX_S = 70;
/** 单条文本**不限制长度**：用户原话在任务记录里可能是长句，门楣照原样滚，不截断。
 *  轨道 white-space:nowrap + 屏 overflow:hidden，长文本只是滚得久一点，不会溢出。 */
/** 降级路径（老服务端）一次取多少条台账：够覆盖"在跑的"，又不至于每 5s 拉一大包 */
const FALLBACK_LIMIT = 60;

/** 服务端回来的原始行 */
const rows = ref([]);
let timer = null;

/** 已播报过的结束任务（本次会话内不重复滚）：done/cancelled/failed 只滚一遍 */
const announcedIds = new Set();
/**
 * 传送带上的显示行（进行中 running + 待滚一遍的结束行 done/cancelled/failed）。
 * 统一从右端进、向左滚；整条滚出左边缘后瞬移回最右重新进（包裹式循环、单份、绝不重复），
 * 结束行滚过一遍即在 wrap 时清掉（只一遍）。w = 实测宽度，wrap 阈值用。
 */
const belt = ref([]);
/** 行间距（px）：与 CSS .line 的 padding-right 一致 */
const GAP = 48;
/** 内容变了要重测每行宽度（避免每帧读 layout） */
let beltDirty = true;
/** 本次会话启动时刻：只播报启动后才结束的任务，不回放历史（避免一启动就滚一堆"任务完成"） */
const sessionStart = Date.now();

/** 结束任务 → 屏上那一行（绿=完成 / 红=取消·失败）。只要「时间 楼层 任务完成」，不接用户输入——
 *  接了会很长、且和进行中的任务混在一起分不清谁收的工；只滚一遍即退场。 */
function endedText(r) {
  const floor = floorOf(r.client);
  const kind = r.state === 'done' ? 'done' : 'cancelled';
  const tail = r.state === 'done' ? t('ticker.done') : r.state === 'failed' ? t('ticker.failed') : t('ticker.cancelled');
  return { id: `${r.id}:${r.state}`, kind, text: `${hhmm(r.ended_at)} ${floor} ${tail}`, w: 0 };
}

/** 从 rows 里挑出"本次会话启动后才结束"的任务，把结束行追加到传送带右端（从最右侧进）。
 *  启动前就已结束的不回放（避免一启动就滚一堆"任务完成"）；announcedIds 防同任务重复。
 *  进行中行由 reconcileRunning 负责摘，这里只加结束行。 */
function detectEnded() {
  for (const r of rows.value) {
    if (!r || r.parent_task_id) continue;
    if (project.projectId && r.project_id !== project.projectId) continue;
    if (!['done', 'failed', 'cancelled'].includes(r.state)) continue;
    if (Number(r.ended_at) < sessionStart) continue; // 不回放启动前已结束的
    if (announcedIds.has(r.id)) continue;
    announcedIds.add(r.id);
    const kept = belt.value.concat();
    kept.push(endedText(r)); // 结束行追加到右端 → 从最右侧进
    const wasEmpty = belt.value.length === 0;
    belt.value = kept;
    beltDirty = true;
    if (wasEmpty && kept.length) offset = viewW.value || 600; // 从空到非空：从最右重新开始
  }
}

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
      reconcileRunning();
      detectEnded();
      return;
    }
    /**
     * 降级：server 是**常驻进程**（launcher（desktop/src/launcher.js）管生命周期，重启客户端不会重启它），
     * 所以"新版客户端 + 旧版服务端"是常见组合 —— 旧进程上没有 /task-feed（404），
     * 这时退到台账接口 /task-runs 自己筛，别让屏上一句"暂无活跃任务"把真在跑的任务盖住
     * （2026-10-08 实测：1F 那条任务在库里好好跑着，屏上却什么都没有）。
     * 代价：/task-runs 按开工时刻倒序截断，一条跑了很久、又被几百条新任务挤到窗口外的
     * 老任务可能漏掉 —— 这只是降级档，正式路径仍走 /task-feed。
     */
    const runs = await getJson(`/api/v1/task-runs?limit=${FALLBACK_LIMIT}`);
    // 两条路都拿不到：留着上一份，下一轮再试（不把屏清空）
    if (runs) {
      rows.value = pickFeed(runs.items || []);
      reconcileRunning();
      detectEnded();
    }
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

/** 不截断：保留 promptOf 取出的完整用户原话（见顶部 MAX_LEN 说明）。 */
const clip = (s) => s;

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

/** 进行中的任务（running）：无限滚动循环的常驻内容 */
const runningItems = computed(() =>
  rows.value
    .filter((r) => r && !r.parent_task_id && r.state === 'running' && (!project.projectId || r.project_id === project.projectId))
    .sort((a, b) => Number(a.started_at) - Number(b.started_at))
    .map((r) => {
      const floor = floorOf(r.client);
      const text = promptOf(r.title) || t('ticker.untitled');
      return { id: r.id, kind: 'running', text: `${hhmm(r.started_at)} ${floor} ${t('ticker.task', { text: clip(text) })}` };
    })
);

/**
 * 把"进行中任务"同步进传送带：保留已在带上的 running 行（常驻、包裹式循环），
 * 新开的任务追加到右端（从最右侧进），已收工/取消的行从中段摘掉并补 offset（让后面不跳）。
 */
function reconcileRunning() {
  const want = runningItems.value;
  const wantIds = new Set(want.map((i) => i.id));
  const kept = [];
  for (const it of belt.value) {
    if (it.kind === 'running') {
      if (wantIds.has(it.id)) kept.push(it); // 常驻保留
      else offset += it.w + GAP; // 任务已结束：摘掉，后面内容左移、offset 右移抵消
    } else {
      kept.push(it); // 结束行保留（滚过一遍后在 wrap 时清）
    }
  }
  const have = new Set(kept.filter((i) => i.kind === 'running').map((i) => i.id));
  for (const it of want) if (!have.has(it.id)) kept.push({ ...it, w: 0 });
  const wasEmpty = belt.value.length === 0;
  belt.value = kept;
  beltDirty = true;
  if (wasEmpty && kept.length) offset = viewW.value || 600; // 从空到非空：从最右重新开始
}

/** 没有任务：屏上只摆一句静态居中的话，不进滚动轨道 */
const idle = computed(() => belt.value.length === 0);

/** 读屏文本：屏上那串滚动的段码对 AT 是噪音，这里给一句静态的 */
const srText = computed(() => belt.value.map((i) => i.text).join('；'));

/* ------------------------------ 滚动（JS rAF 传送带 · 包裹式循环） ------------------------------
 * 单条传送带：所有行（进行中 + 结束）都从最右侧进、向左滚。
 *   · 进行中行常驻：整条滚出左边缘后，offset 瞬移回最右重新进（包裹式循环）。
 *     瞬移不可见（整条已离屏），所以同一任务**绝不会同时出现两份**、也不会从中间蹦出来。
 *   · 结束行滚过一遍即在 wrap 时清掉（只一遍，绝不重复成"一堆"）。
 * 增删只动 belt 数组；offset 连续累加，摘行时按"被摘行的宽度"补偿，不跳。 */

const viewEl = ref(null);
const trackEl = ref(null);
/** 屏幕可视宽度（px） */
const viewW = ref(0);
/** 系统「减弱动态效果」：不滚，静态摆着 */
const reduce = ref(false);
let ro = null;
let raf = null;
let lastTs = 0;
let offset = 0;
/** 整条传送带宽度（px）= 各 (w + GAP) 之和，wrap 阈值用 */
let totalWidth = 0;

/** 重测每行宽度 + 屏宽 + 整条宽度（写回 belt[i].w / viewW / totalWidth） */
function measureBelt() {
  if (viewEl.value) viewW.value = viewEl.value.clientWidth;
  const el = trackEl.value;
  if (!el) return;
  const lines = el.querySelectorAll('.line');
  let i = 0;
  let total = 0;
  for (const ln of lines) {
    const w = i < belt.value.length ? ln.getBoundingClientRect().width : 0;
    if (i < belt.value.length) belt.value[i].w = w;
    total += w + GAP;
    i++;
  }
  totalWidth = total;
  beltDirty = false;
}

function tick(ts) {
  if (!lastTs) lastTs = ts;
  const dt = (ts - lastTs) / 1000;
  lastTs = ts;
  const el = trackEl.value;
  if (!el) {
    raf = requestAnimationFrame(tick);
    return;
  }
  if (beltDirty) measureBelt();
  if (!reduce.value && belt.value.length) {
    offset -= SPEED_PX_S * dt;
    // 整条滚出左边缘（右沿到了屏左）→ 瞬移回最右重新进：
    // 因整条已离屏，瞬移不可见、不会跳；结束行滚过这一遍后清掉（只一遍）。
    if (offset <= -totalWidth) {
      offset = viewW.value || 600;
      if (belt.value.some((it) => it.kind !== 'running')) {
        belt.value = belt.value.filter((it) => it.kind === 'running');
        beltDirty = true;
      }
    }
    el.style.transform = `translateX(${offset}px)`;
  } else if (el) {
    el.style.transform = 'translateX(0)';
  }
  raf = requestAnimationFrame(tick);
}

onMounted(async () => {
  await load();
  await nextTick();
  measureBelt();
  if (belt.value.length) offset = viewW.value || 600; // 首屏从最右进（覆盖 load 时 viewW 未量的 600 猜测）
  if (typeof ResizeObserver !== 'undefined' && viewEl.value) {
    ro = new ResizeObserver(() => measureBelt());
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
  raf = requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  timer = null;
  if (ro) ro.disconnect();
  ro = null;
  if (raf) cancelAnimationFrame(raf);
  raf = null;
});
</script>

<template>
  <div class="ticker">
    <div ref="viewEl" class="screen">
      <!-- 没有任务：静态居中一句，不滚 -->
      <span v-if="idle" class="idle-line">{{ t('ticker.no_task') }}</span>
      <!-- 有任务：滚动的段码不进无障碍树，读屏听下面的 .sr。
           单条传送带：每条行（进行中 / 结束）都从最右端进、向左滚；
           进行中行滚出左边缘循环回右端，结束行滚出即删（只一遍）。位移由 JS rAF 驱动。 -->
      <div
        v-else
        ref="trackEl"
        class="track"
        :class="{ static: reduce }"
        aria-hidden="true"
      >
        <span v-for="it in belt" :key="it.id" class="line" :class="`k-${it.kind}`">{{ it.text }}</span>
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

/* 轨道：传送带本体，行横排；位移由 JS rAF 直接写 transform，不挂 CSS 动画 */
.track {
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

/* 系统「减弱动态效果」：不滚，JS 那边把 offset 固定为 0（见 tick），
   轨道本就没有 CSS 动画，这里无需再禁。 */

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
