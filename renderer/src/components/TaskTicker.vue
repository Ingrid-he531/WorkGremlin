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
 *   3. 分段传送带：轨道是一串"段"（一遍内容的快照），从最右侧进、向左滚，滚出左边缘即回收、
 *      右端再补新段 —— 两遍之间只隔 5s 的行程（上一遍**最后一个字符进屏**起算 5s，下一遍
 *      头字符就进屏，见 GAP_MS），不是"整条滚出左边缘后再空等 5s"。
 *      结束行只进**一个**段（滚出去就没了，屏上绝不会同时摆好几遍）；段滚完且没有别的
 *      任务时，轨道空 → 屏上回到「暂无活跃任务」。段是快照，所以增删任务不会让屏上的字跳。
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
 * 轨道上的**段**（一遍内容）：段是生成时就定好的**快照**，滚出左边缘即回收、右端再补新段。
 * 这么改是因为"结束行只滚一遍"和"多份填满屏"会打架 —— 一份内容重复渲染 N 份时，
 * 同一个"任务完成"会同时在屏上摆着 N 份（实测滚出 4~5 遍）。改成分段快照后：
 *   · 结束行只进**一个段**（见 makeSeg），屏上从头到尾只有一遍，滚出去就没了；
 *   · 新开/收工的任务只影响**之后**生成的段，已在屏上的字不会被改掉、也不会跳。
 */
const segs = ref([]);
/** 待播报的结束行：下次补段时一起进那一段（只进一次），进完即清 */
const pendingEnded = ref([]);
/** 段宽/屏宽的测量脏标记：段增删、窗口或屏宽变化后要重测 */
let segsDirty = true;
/** 刚补的段还没测到宽度（有它就不继续补，免得一帧补出好几段） */
let freshSeg = false;
/** 段 id 序列 */
let segSeq = 0;
/** 本次会话启动时刻：只播报启动后才结束的任务，不回放历史（避免一启动就滚一堆"任务完成"） */
const sessionStart = Date.now();

/** 结束任务 → 屏上那一行（绿=完成 / 红=取消·失败）。只要「时间 楼层 任务完成」，不接用户输入——
 *  接了会很长、且和进行中的任务混在一起分不清谁收的工；只滚一遍即退场。 */
function endedText(r) {
  const floor = floorOf(r.client);
  const kind = r.state === 'done' ? 'done' : 'cancelled';
  const tail = r.state === 'done' ? t('ticker.done') : r.state === 'failed' ? t('ticker.failed') : t('ticker.cancelled');
  return { id: `${r.id}:${r.state}`, kind, text: `${hhmm(r.ended_at)} ${floor} ${tail}` };
}

/** 从 rows 里挑出"本次会话启动后才结束"的任务，把结束行排进 pendingEnded —— 下次补段时
 *  跟着进那一段，**只滚一遍**。启动前就已结束的不回放（避免一启动就滚一堆"任务完成"）；
 *  announcedIds 防同一任务重复播报。 */
function detectEnded() {
  let added = false;
  for (const r of rows.value) {
    if (!r || r.parent_task_id) continue;
    if (project.projectId && r.project_id !== project.projectId) continue;
    if (!['done', 'failed', 'cancelled'].includes(r.state)) continue;
    if (Number(r.ended_at) < sessionStart) continue; // 不回放启动前已结束的
    if (announcedIds.has(r.id)) continue;
    announcedIds.add(r.id);
    pendingEnded.value = pendingEnded.value.concat(endedText(r));
    added = true;
  }
  // 屏上已经空了（之前没任务）却有东西要播：立刻补一段，别等下一轮轮询才动
  if (added && segs.value.length === 0) pushSeg();
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
 * 屏上摆静态居中那句话的条件：**轨道上一段都没有，且确实没东西可滚**（没有在跑的任务、
 * 也没有待播的结束行）。只按"轨道空"判断不行 —— 刚有新任务时轨道也是空的，
 * 那是要开始滚的（轨道得先渲染出来，tick 才能往里补段）。
 */
const idle = computed(
  () => segs.value.length === 0 && runningItems.value.length === 0 && pendingEnded.value.length === 0
);

/** 读屏文本：屏上那串滚动的段码对 AT 是噪音，这里给一句静态的 */
const srText = computed(() => [...runningItems.value, ...pendingEnded.value].map((i) => i.text).join('；'));

/* ------------------------------ 滚动（JS rAF · 分段传送带） ------------------------------
 * 轨道是一串**段**（一遍内容），段尾各带一份空档；段滚出左边缘就回收、右端随时补新段。
 *   · 段是快照：生成时定下内容，滚出去之前不改。所以新开/收工的任务只影响**之后**的段，
 *     屏上正在滚的字既不会被改掉、也不会跳位置。
 *   · 间隔 GAP_MS：段尾空档 = GAP_MS 的行程，所以"上一遍最后一个字进屏"起算 5s，
 *     下一遍的头一个字就从右边进屏 —— 屏一直在滚，没有空着不动的死等。
 *   · 结束行只滚一遍：它只随**一个段**生成（makeSeg 里 pendingEnded 进段即清），
 *     屏上不会同时摆着好几份，滚出去就没了；后面没别的任务时，轨道空 → 显示「暂无活跃任务」。 */

const viewEl = ref(null);
const trackEl = ref(null);
/** 量单字符宽用的探针：一串等宽数字，测出来除以长度就是"一个字"占多宽（含 letter-spacing） */
const probeEl = ref(null);
const PROBE_LEN = 20;
/** 单字符宽度（px）：字号固定，量一次就够，不随窗口变（用 ref 是为了量到之后 perLine 能自己重算） */
const charW = ref(0);
/** 圆点 + 它右边的空隙（px）：算"一屏能放几个字"时要先扣掉它 */
const DOT_W = 14;
/** 屏幕可视宽度（px） */
const viewW = ref(0);
/** 一屏能放下的字符数：短句按这个数在后面补空格，凑满一屏（长句照原样滚，不截断） */
const perLine = computed(() => {
  if (!viewW.value || !charW.value) return 0;
  return Math.max(0, Math.floor((viewW.value - DOT_W) / charW.value));
});
/** 不足一屏的行在末尾补空格，让每条都占满一屏那么长 */
function padText(s) {
  const n = perLine.value;
  const str = String(s || '');
  return n && str.length < n ? str + ' '.repeat(n - str.length) : str;
}
/** 系统「减弱动态效果」：不滚，静态摆着 */
const reduce = ref(false);
let ro = null;
let raf = null;
let lastTs = 0;
let offset = 0;
/** 轨道上所有段的总宽（px，含段尾空档）：补段 / 回收的判断用它 */
let trackW = 0;
/**
 * 两遍之间的间隔（ms）：**从上一遍最后一个字符由右边进屏**起算，到下一遍头字符从右边进屏。
 * 不是"整条滚出后再静止等 5s" —— 那样实际间隔 = 滚出剩余行程 + 5s，读数的人会觉得等太久。
 * 屏是连续滚的，这个间隔只是"字与字之间空出的那一段行程"（gapPx），没有屏空着不动的停顿。
 */
const GAP_MS = 5000;
/** 行间距 = CSS .line 的 padding-right（48px），已算进每条实测宽度里；算段尾空档时要扣掉它，否则间隔会多出这一段 */
const LINE_GAP_PX = 48;
/** 段尾空档（px）：间隔时间 × 速度 − 行尾自带 padding，使"尾字进屏 → GAP_MS → 下一段进屏"精确成立 */
const gapPx = () => Math.max(0, (GAP_MS / 1000) * SPEED_PX_S - LINE_GAP_PX);

/** 生成一段：当前进行中的任务 + 待播报的结束行（结束行进段即清，所以它只属于这一段） */
function makeSeg() {
  const lines = runningItems.value.map((it) => ({ ...it }));
  if (pendingEnded.value.length) {
    lines.push(...pendingEnded.value);
    pendingEnded.value = [];
  }
  return { id: `seg-${(segSeq += 1)}`, lines, w: 0 };
}

/** 右端补一段：只在该补的时候调（见 tick），补进来时它还在屏右外，看不见 */
function pushSeg() {
  if (segs.value.length === 0) offset = viewW.value || 600; // 从空到非空：从最右进
  segs.value.push(makeSeg());
  freshSeg = true;
  segsDirty = true;
}

/** 重测屏宽 + 各段宽度（写回 segs[i].w / viewW / trackW） */
function measureSegs() {
  if (viewEl.value) viewW.value = viewEl.value.clientWidth;
  // 探针只在第一次量得到宽度时取值：字号不变，一个字多宽就不变
  if (probeEl.value && !charW.value) {
    const w = probeEl.value.getBoundingClientRect().width;
    if (w > 0) charW.value = w / PROBE_LEN;
  }
  const el = trackEl.value;
  if (!el) return;
  const nodes = el.querySelectorAll('.seg');
  let total = 0;
  let i = 0;
  for (const n of nodes) {
    const w = n.getBoundingClientRect().width;
    if (i < segs.value.length) segs.value[i].w = w;
    total += w;
    i += 1;
  }
  trackW = total;
  if (i >= segs.value.length) freshSeg = false; // 段都量过了，可以继续补
  segsDirty = false;
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
  if (segsDirty) measureSegs();
  if (!reduce.value && segs.value.length) {
    offset -= SPEED_PX_S * dt;
    // 回收：最左那段整个滚出左边缘就丢掉，offset 右移它的宽度 —— 后面的段原地不动，不跳
    let head = segs.value[0];
    while (head && head.w > 0 && offset + head.w <= 0) {
      offset += head.w;
      trackW -= head.w;
      segs.value.shift();
      segsDirty = true;
      head = segs.value[0];
    }
  }
  // 补段：轨道右端已经露进屏里就再补一段（补在屏右外，看不见）。
  // 没内容可补（既没在跑的任务、也没待播的结束行）就不补 —— 剩下的段滚完，屏上回到「暂无活跃任务」。
  const hasContent = runningItems.value.length > 0 || pendingEnded.value.length > 0;
  // +4 是提前量：赶在轨道右端露进屏**之前**补，新段就从屏外进，不会凭空冒在屏里
  if (!freshSeg && hasContent && offset + trackW <= viewW.value + 4) pushSeg();
  el.style.transform = `translateX(${offset}px)`;
  raf = requestAnimationFrame(tick);
}

onMounted(async () => {
  await load();
  await nextTick();
  measureSegs();
  if (typeof ResizeObserver !== 'undefined' && viewEl.value) {
    ro = new ResizeObserver(() => {
      segsDirty = true;
    });
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
    <!-- 屏左边的静态标签：说明这块屏滚的是什么（所有楼层的任务），它**不参与滚动** -->
    <span class="tag">{{ t('ticker.tag') }}</span>
    <div ref="viewEl" class="screen">
      <!-- 没有任务：静态居中一句，不滚 -->
      <span v-if="idle" class="idle-line">{{ t('ticker.no_task') }}</span>
      <!-- 有内容：滚动的段码不进无障碍树，读屏听下面的 .sr。
           轨道是一串段（一遍内容），段尾各带 --loop-gap 空档；滚出左边的段被回收、右端再补新段。
           结束行只进其中一段，所以屏上从头到尾只有一遍「任务完成」，滚出去就没了。位移由 JS rAF 驱动。 -->
      <div
        v-else
        ref="trackEl"
        class="track"
        :class="{ static: reduce }"
        :style="{ '--loop-gap': `${gapPx()}px` }"
        aria-hidden="true"
      >
        <!-- 减弱动态效果时静态摆着，只摆一段（多段看着就是同一句在重复） -->
        <span v-for="s in (reduce ? segs.slice(0, 1) : segs)" :key="s.id" class="seg">
          <span v-for="it in s.lines" :key="it.id" class="line" :class="`k-${it.kind}`">{{ padText(it.text) }}</span>
        </span>
      </div>
      <!-- 量字宽的探针：一串等宽数字，看不见也不占地方（算"一屏能放几个字"用） -->
      <span ref="probeEl" class="probe" aria-hidden="true">{{ '0'.repeat(PROBE_LEN) }}</span>
      <span class="scan" aria-hidden="true" />
    </div>
    <p class="sr" role="status" aria-live="polite">{{ srText }}</p>
  </div>
</template>

<style scoped>
/* 门楣里的一列：标签占自己那份宽，剩下**全给这块屏**（屏尽可能长，见 ElevatorDoors） */
.ticker {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 屏左边的静态标签：说清这块屏滚的是什么。它不滚、也不跟着内容变宽。
   纯文字，别给它描边 / 底色 —— 有框+有底看着就是一枚不能点的按钮，那不是它。 */
.tag {
  flex: none;
  display: flex;
  align-items: center;
  height: calc(var(--lcd-slot, 26px) + 16px); /* 与屏等高，两个盒子顶底齐平 */
  padding: 0 8px 0 2px;
  font-size: 12px;
  letter-spacing: 1px;
  white-space: nowrap;
  color: var(--text-dim, #9aa3b2);
}

/* 屏壳：暗底 + 等宽字（段码手感），高度沿用液晶屏那一格（--lcd-slot） */
.screen {
  position: relative;
  flex: 1 1 auto; /* 门楣剩下的宽度全给屏，标签只占它自己那点 */
  min-width: 0;
  display: flex;
  align-items: center;
  /* 轨道锚定左边缘：translateX(offset) 从 viewW(最右进) 一路走到 -period(一份滚完回绕)，
     内容比屏窄时也贴着左边缘滚到底、不居中停留（否则"短内容滚不到最左、卡在中间"） */
  justify-content: flex-start;
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

/* 轨道：传送带本体，若干份（.seg）横排；位移由 JS rAF 直接写 transform，不挂 CSS 动画 */
.track {
  display: flex;
  flex: none;
}

/* 一段（一整遍内容）：段尾的空档 = --loop-gap（= GAP_MS 的行程 − 行尾自带的 padding），
   它就是"上一遍最后一个字"到"下一遍第一个字"之间那段空白 —— 间隔时间由它决定，见 GAP_MS */
.seg {
  display: flex;
  flex: none;
  padding-right: var(--loop-gap, 302px);
}

.line {
  display: inline-flex;
  align-items: center;
  flex: none;
  /* 条目之间的空档：一条滚完再接下一条，别让两条粘在一起 */
  padding-right: 48px;
  font-size: 13px;
  letter-spacing: 0.5px;
  /* 补的空格就靠它留着，不然末尾那一串空格会被折叠掉 */
  white-space: pre;
  color: var(--text-dim);
}

/* 每条前面的圆点：颜色跟着这一条自己的颜色走（蓝=在跑 / 绿=完成 / 红=取消），
   所以"看圆点就知道是哪一类"，不用读完那行字 */
.line::before {
  content: '';
  flex: none;
  width: 7px;
  height: 7px;
  margin-right: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}

/* 量字宽的探针：绝对定位 + 看不见，不参与布局 */
.probe {
  position: absolute;
  top: 0;
  left: 0;
  visibility: hidden;
  pointer-events: none;
  font-size: 13px;
  letter-spacing: 0.5px;
  white-space: pre;
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

/* 没有任务：静态居中（轨道用 flex-start 贴左，这句单独用 auto 居中），颜色比"暗段"亮一档 */
.idle-line {
  margin: 0 auto;
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
