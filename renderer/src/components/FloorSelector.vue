<script setup>
/**
 * FloorSelector —— 左侧竖向堆叠的"楼层"胶囊。
 * 每个楼层对应一个受监控的产品：1F CodeBuddy CLI / 2F WorkBuddy CLI / 3F CodeBuddy Plugin / 4F Codex CLI / 5F Claude Code CLI。
 *
 * 状态点看的是**这一层有没有活跃会话**（全局活跃会话表，60 分钟没事件会剔除）：
 *   - 有活跃会话：绿色状态点 + 数量角标
 *   - 没有（或压根没装）：灰色状态点
 * 没有活跃会话的楼层照样能点进去，办公室照常显示，只是下拉为空。
 * 未安装（后端没搜到安装位置或落盘数据）：整体置灰，显示"未安装"。
 * 选中：高亮边框（accent + 外发光）。
 *
 * 电梯（design-elevator-transition.md §1 / §5.2）：`.rail` 就是井道，本组件额外挂一个
 * `.car` 轿厢覆盖层。高亮与轿厢位置都从 useElevator 拿（effort §2.3 方案 A），
 * 保证「高亮在 4F、轿厢在 3F」这种错位不会出现。
 * 楼层显示屏（FloorLcd）**不在这里**：它挂在电梯门上方（ElevatorDoors 的门楣），
 * 由 App.vue 把楼层表传过去（effort §2.4）。井道这边只负责井道 + 轿厢。
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useElevator } from '../composables/useElevator';

const props = defineProps({
  products: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

const { displayFloor, carFloor, phase, moveMs } = useElevator();

function select(p) {
  emit('update:modelValue', p.id);
}

/* ---------- 轿厢定位 ---------- */

const railEl = ref(null);
/** 胶囊 DOM（floorId → element）：量 offsetTop 用，不进响应式 —— 只有量出来的结果才进 */
const floorEls = new Map();
/** { [floorId]: { top, height } } —— 实测缓存，ResizeObserver 只写这里 */
const metrics = ref({});
let ro = null;

function setFloorEl(id, el) {
  if (!el) {
    floorEls.delete(id);
    return;
  }
  floorEls.set(id, el);
  if (ro) ro.observe(el);
}

function sameMetrics(a, b) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] && b[k].top === a[k].top && b[k].height === a[k].height);
}

/**
 * 量一次所有胶囊的位置。
 * 不能按索引硬算：胶囊高度会随路径文案换行变化（设计 §5.2 / §8.1）。
 * offsetTop 相对 offsetParent —— `.rail` 已 position: relative，所以它就是井道坐标。
 */
function measure() {
  const next = {};
  floorEls.forEach((el, id) => {
    next[id] = { top: el.offsetTop, height: el.offsetHeight };
  });
  if (sameMetrics(next, metrics.value)) return; // 每 10s 一次轮询也会进来，值没变就不惊动渲染
  metrics.value = next;
}

const carMetric = computed(() => metrics.value[carFloor.value] || null);

/** 轿厢：只动 transform（+ 静态 height/opacity），不碰 width / left / top */
const carStyle = computed(() => ({
  height: `${carMetric.value.height}px`,
  transform: `translateY(${carMetric.value.top}px)`,
  // 只有 moving 段真的在井道里跑；其余时刻 0ms（保持停靠，不跟着高亮提前滑走）
  transitionDuration: phase.value === 'moving' ? `${moveMs.value}ms` : '0ms',
}));

/* ---------- 轿厢自己的层号带 ---------- */

/**
 * 设计 §1「楼层数字」原文那版：**轿厢内的 odometer 数字条** —— 一串纵向层号，
 * 窗口只露一格，轿厢滚到哪层，带子就滚到哪格。
 *
 * 与门楣那块屏的分工（两块屏不是重复，是真电梯也各有一块）：
 *   · 门楣屏 = 层站指示器：固定不动，答"现在在哪层 / 要去哪层"（含方向）
 *   · 这里   = 轿厢自己的显示屏：跟着车走，只有层号，路过中间层时能看到数字滚过去
 *
 * 对齐靠"同一条曲线 + 同一个 moveMs"（设计 §2 段2 的并行说明）：带子与轿厢共用
 * `--ease-shaft-move` 和内联的 transitionDuration，天然同步 ——
 * 所以设计 §7.1 那套"按层数预计算 ease⁻¹(k/N) 的 setTimeout"不需要了。
 */
const odoSlots = computed(() => props.products.map((f) => ({ id: f.id, lit: f.installed !== false })));
const odoIndex = computed(() => {
  const i = odoSlots.value.findIndex((s) => s.id === carFloor.value);
  return i < 0 ? 0 : i;
});
const odoStyle = computed(() => ({
  transform: `translateY(calc(-1 * ${odoIndex.value} * var(--car-slot)))`,
  transitionDuration: phase.value === 'moving' ? `${moveMs.value}ms` : '0ms',
}));

/**
 * 1F 胶囊顶与右侧办公室画面顶对齐：实测 .scene-wrap 相对井道顶的偏移，写进 --office-top。
 * 那个偏移 = 门楣（内容撑高，没定数）+ 舞台留白，所以只能量，不能按 CSS 硬算。
 */
function syncOfficeTop() {
  const rail = railEl.value;
  const scene = document.querySelector('.scene-wrap');
  if (!rail || !scene) return; // 非办公室页签：没有 .scene-wrap，沿用上一次的结果
  const t = Math.round(scene.getBoundingClientRect().top - rail.getBoundingClientRect().top);
  rail.style.setProperty('--office-top', `${Math.max(0, t)}px`);
}

let lintelRo = null;
let officeTopRaf = 0;

onMounted(() => {
  measure();
  // 回调里只写缓存，不碰 phase、不重启动画（设计 §5.2）
  ro = new ResizeObserver(() => measure());
  if (railEl.value) ro.observe(railEl.value);
  floorEls.forEach((el) => ro.observe(el));

  // 门楣高度随楼层屏内容变、窗口缩放也变 → 三处都重测（首帧兄弟组件可能还没挂上，等一帧）
  officeTopRaf = requestAnimationFrame(syncOfficeTop);
  const lintel = document.querySelector('.lintel');
  if (lintel) {
    lintelRo = new ResizeObserver(syncOfficeTop);
    lintelRo.observe(lintel);
  }
  window.addEventListener('resize', syncOfficeTop);
});

onBeforeUnmount(() => {
  if (ro) ro.disconnect();
  ro = null;
  if (lintelRo) lintelRo.disconnect();
  lintelRo = null;
  cancelAnimationFrame(officeTopRaf);
  window.removeEventListener('resize', syncOfficeTop);
});

/** 楼层列表换了（首次加载 / 10s 轮询）→ DOM 更新后再量一次 */
watch(() => props.products, () => measure(), { flush: 'post' });

/** 悬浮提示：活跃会话 + 安装位置 + 落盘统计 */
function tip(p) {
  const lines = [p.name];
  lines.push(
    p.activeCount
      ? `活跃会话：${p.activeCount} 个（状态点绿）`
      : '活跃会话：0 个（状态点灰；60 分钟没有事件就移出表）'
  );
  if (!p.installed) {
    lines.push('未安装（没搜到可执行文件或扩展目录）→ 置灰，不能点');
    return lines.join('\n');
  }
  lines.push(`安装：${p.installPathLabel || '（未定位到可执行文件）'}`);
  if (p.dataPathLabel) {
    const s = p.stats || {};
    const bits = [];
    if (s.sessions) bits.push(`${s.sessions} 个会话文件`);
    if (s.files) bits.push(`${s.files} 个文件`);
    if (s.sizeLabel) bits.push(s.sizeLabel);
    if (s.lastModifiedAt) bits.push(`最后写入 ${new Date(s.lastModifiedAt).toLocaleString()}`);
    lines.push(`落盘：${p.dataPathLabel}${bits.length ? `（${bits.join(' · ')}）` : ''}`);
  } else {
    lines.push('落盘：未找到数据目录');
  }
  return lines.join('\n');
}

/** 胶囊上不再显示智能体目录（路径）—— 路径信息仍在悬浮提示（tip）里；未安装的楼层只留"未安装"状态字 */
</script>

<template>
  <!-- data-phase 挂在这里：轿厢门缝线（.car::after）的"关门变亮 + 到点锁一下"要靠它驱动 -->
  <aside ref="railEl" class="rail" :data-phase="phase" aria-label="楼层选择">
    <!-- 顶格：与右侧"门楣+舞台留白"等高（--office-top 实测），让 1F 胶囊顶与办公室画面顶对齐 -->
    <div class="rail-head">
      <header class="rail-title">楼层</header>
    </div>

    <!-- 胶囊区：内容整体缩小 30%（scale 只影响这一区，标题不参与） -->
    <div class="rail-floors">
      <button
        v-for="p in products"
        :key="p.id"
        :ref="(el) => setFloorEl(p.id, el)"
        type="button"
        class="floor"
        :class="{ selected: p.id === displayFloor, dim: !p.installed }"
        :disabled="!p.installed"
        :title="tip(p)"
        @click="select(p)"
      >
        <span class="fid">{{ p.id }}</span>
        <span class="fname">{{ p.name }}</span>
        <span class="fstat">
          <span class="fdot" :class="p.activeCount ? 'on' : 'off'" />
          <span v-if="p.activeCount" class="fbadge">{{ p.activeCount }}</span>
        </span>
      </button>

      <!-- 轿厢：井道里那一格。纯装饰（不拦点击、不进无障碍树），位移只走 transform -->
      <div v-if="carMetric" class="car" :style="carStyle" aria-hidden="true">
        <!-- 轿厢内的层号带：窗口只露一格，跟着车滚过每一层（设计 §1「楼层数字」原文） -->
        <div class="car-odo">
          <div v-if="odoSlots.length" class="car-odo-strip" :style="odoStyle">
            <span v-for="s in odoSlots" :key="s.id" :class="{ dim: !s.lit }">{{ s.id }}</span>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.rail {
  /* 井道外框：宽 = 胶囊区排版宽 140 × 0.7（胶囊整体缩小 30%，见 .rail-floors） */
  flex: 0 0 98px;
  width: 98px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--panel, #0e1116);
  overflow: hidden;
}

/* 顶格：高度 = 右侧"门楣 + 舞台留白"（运行时实测写进 --office-top，见 syncOfficeTop），
   于是下面第一颗胶囊（1F）的顶边正好与办公室画面顶边水平对齐 */
.rail-head {
  flex: none;
  height: var(--office-top, 70px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.rail-title {
  /* "楼层"标题：不参与胶囊区的 0.7 缩放，字号单独调大（原 11px） */
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 2px;
  color: var(--muted, #6e7681);
  text-align: center;
}

/* 胶囊区（= 原来的井道）：胶囊整体缩小 30% —— 按原尺寸排版、整体 scale(0.7)。
   用 transform 不用 zoom：胶囊的 offsetTop/offsetHeight（轿厢定位的实测来源）不受
   transform 影响，而缩放对整棵子树统一生效 —— 轿厢、层号带跟着一起缩，天然不错位。
   它因此接替成为轿厢（.car）的定位祖先（原来这个角色在 .rail 上，设计 §1）。 */
.rail-floors {
  position: relative;
  flex: 1;
  min-height: 0;
  width: 140px; /* 缩放前的排版宽度，缩完正好 98 = 井道宽 */
  transform: scale(0.7);
  transform-origin: top left;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 10px 14px;
  overflow-y: auto;
}

/* 轿厢：跟着 carFloor 在井道里滑。只动画 transform，duration 由内联 style 按层数给 */
.car {
  position: absolute;
  top: 0;
  /* 左右对齐胶囊的内容边（= .rail 的左右 padding 10px）；上下位置与高度靠实测 */
  left: 10px;
  right: 10px;
  z-index: 2;
  border-radius: 16px;
  border: 2px solid var(--accent, #58a6ff);
  background: color-mix(in srgb, var(--accent, #58a6ff) 12%, transparent);
  pointer-events: none; /* 纯装饰：不许拦住胶囊点击 */
  transition: transform var(--dur-shaft-move) var(--ease-shaft-move);
}

/* 轿厢内的层号带（设计 §1「楼层数字」原文那版）：窗口横贯轿厢，数字在里面逐格滚过。
   窗口高度 = 一格（`--car-slot`，正好是胶囊 `.fid` 的行高），纵向压在胶囊第一行上
   （`.floor` 的 padding-top 14px），所以**静止时把胶囊自己那个层号整行盖住**。
   为什么必须横贯（而不是贴个小方块）：运行途中车在两格之间，"谁被压过" 的层号会从旁边
   露出来 —— 我第一版做成 44px 宽的小方块，截出来就是「小屏 4F」和「胶囊 4F」并排重影。
   带宽铺满后，凡是被车压过的层号都在带子里，读起来才是"数字滚过窗口"。
   改 `.floor` 的 padding-top 或 `.fid` 字号时，这里的 top 要一起改。 */
.car-odo {
  position: absolute;
  top: 14px;
  left: 0;
  right: 0;
  height: var(--car-slot);
  display: flex;
  justify-content: center;
  border-radius: 2px;
  background: var(--lcd-bg, #05070a);
  box-shadow: inset 0 0 6px rgba(0, 0, 0, 0.8);
  overflow: hidden; /* 只露一格：上下邻居被裁掉 */
  font-family: var(--mono, monospace);
}

/* 时长由内联给（moving 才有值），曲线与轿厢同一条 —— 数字和车天然同步 */
.car-odo-strip {
  display: flex;
  flex-direction: column;
  transition: transform var(--dur-shaft-move) var(--ease-shaft-move);
}

.car-odo-strip span {
  height: var(--car-slot);
  line-height: var(--car-slot);
  font-size: 19px; /* 与胶囊 .fid 同字号 —— 显示带整行盖在胶囊层号上，字号变了要一起改 */
  font-weight: 700;
  letter-spacing: 0.5px;
  text-align: center;
  color: var(--lcd-lit, #7fe6ff);
  text-shadow: 0 0 5px currentColor;
}

/* 未安装（置灰、点不动）的层：段码压暗 —— 轿厢物理上会经过它，但不表示"能到" */
.car-odo-strip span.dim {
  color: var(--lcd-dim, #33414d);
  text-shadow: none;
}

/* will-change 只在真的滚层号时挂、进 idle 立刻摘（与门 / 门楣屏同一条规矩） */
.rail[data-phase='moving'] .car-odo-strip {
  will-change: transform;
}

/* 运行中把井道里的层号压暗：车在两格之间时，被它压过的那格白字会从显示带下面露出
   （瞬时"重影"）。压暗之后，整条井道里亮的只有轿厢那块滚动的显示带 + 目的地那一格 ——
   既消掉了重影，也让人一眼看出"数字在滚"、要去哪层。到站（opening）立刻回到常态。
   （`.selected` 那一格不压：它是用户刚点的目的层，压暗等于把"我要去 5F"这条信息抹掉一半。） */
.rail[data-phase='moving'] .floor:not(.selected) .fid {
  opacity: 0.32;
  transition: opacity var(--dur-settle) linear;
}

/* 轿厢门缝：胶囊只有 140px 宽，做真门片看不清 —— 用一条竖线暗示（设计 §1） */
.car::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 12%;
  bottom: 12%;
  width: 1px;
  background: var(--accent, #58a6ff);
  opacity: 0.35;
  transition: opacity var(--dur-door-close) linear;
}

/* 关门（设计 §2 段 1b）：门缝线随门合拢亮起来，合到底再"锁一下" ——
   40ms 的亮度脉冲，延迟到关门结束那一刻才开始（delay = --dur-door-close）。
   animation 一旦进入延迟期就会接管 opacity，所以和上面那条 transition 不打架。 */
[data-phase='closing'] .car::after {
  opacity: 0.5;
  animation: car-lock 40ms linear var(--dur-door-close) 1;
}

@keyframes car-lock {
  0% {
    opacity: 0.5;
  }
  45% {
    opacity: 1;
  }
  100% {
    opacity: 0.55;
  }
}

.floor {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 8px 16px;
  border-radius: 16px;
  border: 2px solid var(--border);
  background: var(--surface, #161b22);
  color: var(--text, #e6edf3);
  cursor: pointer;
  font: inherit;
  /* 只收窄到 .floor 自己：轿厢（.car）有自己的 transform 过渡，两者不许互相盖 */
  transition: border-color 0.15s, transform 0.1s, opacity 0.15s, box-shadow 0.15s;
}

.floor:hover {
  border-color: var(--accent, #58a6ff);
}

.floor:active {
  transform: translateY(1px);
}

.floor .fid {
  /* 字号/字重与轿厢显示带一致（19px / 700，行高仍取 --car-slot 22px）——
     胶囊区整体缩了 0.7，层号这里补大一点；改字号时显示带（.car-odo-strip）要一起改。 */
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.5px;
  line-height: var(--car-slot);
}

.floor .fname {
  font-size: 13px;
  line-height: 1.25;
  text-align: center;
  opacity: 0.9;
}

.floor .fdot {
  width: 8px;
  height: 8px;
  margin-top: 2px;
  border-radius: 50%;
  background: var(--ok, #3fb950);
  box-shadow: 0 0 6px var(--ok, #3fb950);
}

.floor .fdot.off {
  background: var(--muted, #6e7681);
  box-shadow: none;
}

/* 状态点 + 活跃会话数 */
.floor .fstat {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.floor .fbadge {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ok, #3fb950) 22%, transparent);
  color: var(--ok, #3fb950);
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}

/* 选中：高亮边框 + 外发光 */
.floor.selected {
  border-color: var(--accent, #58a6ff);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #58a6ff) 28%, transparent);
}

/* 未安装：置灰 + 点不动。不透明度别压太低（0.72）—— 置灰是"不能点"的提示，
   层号与名字还得读得清 */
.floor.dim {
  color: var(--muted, #6e7681);
  border-color: var(--border);
  opacity: 0.72;
}

.floor.dim:hover {
  border-color: var(--muted, #6e7681);
}

.floor:disabled {
  cursor: not-allowed;
}

.floor:disabled:hover {
  border-color: var(--border);
}
</style>
