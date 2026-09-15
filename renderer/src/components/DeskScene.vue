<script setup>
/**
 * DeskScene —— 单个"真实工位"（2.5D 斜俯视）。
 *
 * 图层自后向前：地毯 → 隔断挡板 → 座椅 → 精灵 → 桌面 → 桌上物件（键盘/鼠标/马克杯/台灯/绿植）
 *              → 显示器（屏幕为 HTML 叠层，显示真实任务/进度/文件）→ 桌牌。
 *
 * 之所以拆成 bg / fg 两层 SVG：精灵是 HTML 组件（AgentAvatar），
 * 必须夹在"椅子"和"桌子"之间，才能做出"坐在桌后、手搭在桌上"的层次。
 *
 * 动画全部走 CSS keyframes，用 --phase 按成员名哈希错开相位，避免全员同步。
 */
import { computed } from 'vue';
import AgentAvatar from './AgentAvatar.vue';
import StatusBadge from './StatusBadge.vue';
import { avatarOf, formatDuration } from '@workgremlin/shared';

const props = defineProps({
  member: { type: Object, required: true },
  selected: { type: Boolean, default: false },
  /** 由父级统一 tick 传入，避免每个工位各起一个定时器 */
  now: { type: Number, default: () => Date.now() },
});
const emit = defineEmits(['select']);

const agentId = computed(() => props.member.memberId.split('@')[0]);
const skin = computed(() => avatarOf(props.member.memberId));
const state = computed(() => props.member.state);

const title = computed(() => (props.member.task ? props.member.task.title : '空闲 / 无进行中任务'));
const pct = computed(() => {
  const p = props.member.task && props.member.task.progress;
  return Number.isFinite(p) ? Math.max(0, Math.min(1, p)) * 100 : 0;
});
const fileText = computed(() =>
  props.member.currentFiles && props.member.currentFiles.length ? props.member.currentFiles[0] : '未上报文件'
);
const elapsed = computed(() => formatDuration(props.now - props.member.stateSince));

/** 动画相位 0~1.6s，按成员名哈希：全员动作不会整齐划一 */
const phase = computed(() => (agentId.value.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 16) / 10);
</script>

<template>
  <div
    class="desk-scene"
    :class="[`state-${state}`, { selected, 'is-degraded': member.degraded }]"
    :style="{ '--body': skin.body, '--horn': skin.horn, '--phase': `${phase}s` }"
    :data-testid="`desk-${agentId}`"
    @click="emit('select', member.memberId)"
  >
    <div class="stage">
      <!-- ===== 后景：地毯 / 隔断 / 座椅 ===== -->
      <svg class="layer" viewBox="0 0 260 210" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <polygon class="carpet" points="130,160 242,188 130,216 18,188" />
        <polygon class="carpet-inner" points="130,169 228,188 130,207 32,188" />

        <g class="panel">
          <rect class="panel-rail" x="44" y="33" width="172" height="7" rx="3.5" />
          <rect class="panel-body" x="46" y="39" width="168" height="109" rx="5" />
          <g class="panel-lines">
            <line v-for="x in [76, 106, 136, 166, 196]" :key="x" :x1="x" y1="43" :x2="x" y2="145" />
          </g>
          <g class="notes">
            <rect class="note note-a" x="168" y="54" width="14" height="14" rx="1.5" transform="rotate(-7 175 61)" />
            <rect class="note note-b" x="188" y="74" width="12" height="12" rx="1.5" transform="rotate(9 194 80)" />
          </g>
        </g>

        <g class="chair">
          <rect class="chair-back" x="66" y="76" width="68" height="72" rx="16" />
          <rect class="chair-inner" x="74" y="84" width="52" height="58" rx="12" />
        </g>
      </svg>

      <!-- ===== 精灵：夹在椅子与桌子之间 ===== -->
      <div class="gremlin">
        <AgentAvatar :name="member.memberId" :state="state" :degraded="member.degraded" :size="100" />
      </div>

      <!-- ===== 前景：桌面 / 桌上物件 / 显示器 ===== -->
      <svg class="layer" viewBox="0 0 260 210" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <!-- 台灯（含光锥） -->
        <g class="lamp">
          <polygon class="lamp-light" points="59,122 75,122 98,170 36,170" />
          <path class="lamp-stem" d="M67 148 L67 122" />
          <ellipse class="lamp-base" cx="67" cy="149" rx="11" ry="4" />
          <path class="lamp-shade" d="M56 122 L78 122 L73 111 L61 111 Z" />
        </g>

        <!-- 桌子 -->
        <polygon class="desk-top" points="58,146 202,146 218,170 42,170" />
        <polygon class="desk-front" points="42,170 218,170 218,181 42,181" />
        <polygon class="desk-leg" points="62,181 76,181 71,200 66,200" />
        <polygon class="desk-leg" points="184,181 198,181 194,200 189,200" />

        <!-- 键盘 -->
        <g class="keyboard">
          <polygon class="kb-body" points="72,149 152,149 158,164 66,164" />
          <g class="keys">
            <polygon class="kb-row" points="76,151 148,151 149,154 75,154" />
            <polygon class="kb-row" points="74,155 150,155 151,158 73,158" />
            <polygon class="kb-row" points="73,159 151,159 153,162 71,162" />
          </g>
        </g>

        <!-- 鼠标 -->
        <g class="mouse">
          <ellipse cx="184" cy="158" rx="6" ry="9" />
          <path d="M184 150 v6" />
        </g>

        <!-- 马克杯 + 热气 -->
        <g class="mug">
          <path class="handle" d="M70 159h3.5a3.5 3.5 0 0 1 0 7H70" />
          <rect class="cup" x="56" y="155" width="14" height="16" rx="3" />
          <g class="steam">
            <path d="M60 152c-2.5-3 2.5-5 0-8" />
            <path d="M67 152c-2.5-3 2.5-5 0-8" />
          </g>
        </g>

        <!-- 绿植 -->
        <g class="plant">
          <polygon class="pot" points="196,150 214,150 211,164 199,164" />
          <g class="leaves">
            <ellipse cx="205" cy="142" rx="4" ry="7.5" transform="rotate(-16 205 142)" />
            <ellipse cx="199" cy="145" rx="3.4" ry="6" transform="rotate(-40 199 145)" />
            <ellipse cx="211" cy="145" rx="3.4" ry="6" transform="rotate(24 211 145)" />
          </g>
        </g>

        <!-- 显示器 -->
        <g class="monitor" transform="rotate(-3 170 103)">
          <ellipse class="mon-base" cx="170" cy="146" rx="24" ry="6" />
          <rect class="mon-neck" x="165" y="126" width="10" height="21" />
          <rect class="mon-bezel" x="126" y="74" width="88" height="58" rx="5" />
          <rect class="mon-screen" x="130" y="78" width="80" height="46" rx="3" />
          <g class="mon-glow">
            <polygon points="130,124 210,124 224,170 116,170" />
          </g>
          <circle class="mon-led" cx="206" cy="128" r="2.6" />
        </g>
      </svg>

      <!-- ===== 屏幕内容（HTML 叠层，保证文字可截断/可读） ===== -->
      <div class="screen-ui">
        <div class="scr-head">
          <span class="scr-dot" />
          <span class="scr-title">{{ title }}</span>
        </div>
        <div class="scr-bar"><i :style="{ width: `${pct}%` }" /></div>
        <div class="scr-file mono">{{ fileText }}</div>
        <div v-if="state === 'blocked'" class="scr-alert">需要协助</div>
      </div>

      <!-- 悬停/选中时的详情卡（小屏看不全，用这个补全信息） -->
      <div class="peek">
        <div class="peek-title">{{ title }}</div>
        <div class="peek-row dim">进度 {{ Math.round(pct) }}% · 已耗时 {{ elapsed }}</div>
        <div v-if="member.currentFiles.length" class="peek-row mono">{{ member.currentFiles.join(' , ') }}</div>
      </div>
    </div>

    <!-- ===== 桌牌 ===== -->
    <div class="plate">
      <span class="p-name">{{ member.name }}</span>
      <span class="p-role dim">{{ member.role || '—' }}</span>
      <StatusBadge :state="state" :degraded="member.degraded" :testid="`seat-status-${agentId}`" />
      <span class="p-elapsed mono faint">{{ elapsed }}</span>
    </div>
  </div>
</template>

<style scoped>
.desk-scene {
  --phase: 0s;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 8px 8px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-panel);
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
}
.desk-scene:hover {
  border-color: var(--border-strong);
  transform: translateY(-2px);
}
.desk-scene.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-soft), 0 6px 18px rgba(0, 0, 0, 0.35);
}
.desk-scene.is-degraded {
  border-style: dashed;
}

.stage {
  position: relative;
  width: 100%;
  aspect-ratio: 260 / 210;
}

.layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

/* ---------- 后景 ---------- */
.carpet {
  fill: color-mix(in srgb, var(--body) 22%, #14181f);
}
.carpet-inner {
  fill: none;
  stroke: color-mix(in srgb, var(--body) 45%, transparent);
  stroke-width: 1;
}
.selected .carpet {
  fill: color-mix(in srgb, var(--body) 34%, #14181f);
}

.panel-rail {
  fill: #3c4658;
}
.panel-body {
  fill: #2a3241;
}
.panel-lines line {
  stroke: rgba(255, 255, 255, 0.04);
  stroke-width: 2;
}
.note-a {
  fill: #f2c94c;
}
.note-b {
  fill: #6fb3ff;
}

.chair-back {
  fill: #333c4b;
}
.chair-inner {
  fill: #3d4757;
}

/* ---------- 精灵 ---------- */
.gremlin {
  position: absolute;
  left: 21.5%;
  top: 29%;
  width: 32%;
  height: 53%;
  transform-origin: 50% 100%;
  transition: transform 0.35s ease, opacity 0.35s ease;
}
.gremlin :deep(.avatar) {
  width: 100%;
  height: 100%;
}
.gremlin :deep(.shadow) {
  display: none; /* 坐在桌后，地面投影被桌子挡住 */
}
.gremlin :deep(.prop) {
  display: none; /* 桌上已有键盘/放大镜等物件，避免和手里配饰重复 */
}
.state-busy .gremlin {
  transform: translateY(2px) rotate(-2deg);
}
.state-idle .gremlin {
  transform: translateY(4px) rotate(5deg);
}
.state-blocked .gremlin {
  animation: head-shake 2.4s ease-in-out infinite;
  animation-delay: var(--phase);
}
.state-offline .gremlin {
  opacity: 0; /* 人不在：椅子空着 */
}

/* ---------- 前景：桌子 ---------- */
.desk-top {
  fill: #6d5540;
}
.desk-front {
  fill: #4c3b2c;
}
.desk-leg {
  fill: #3a2d21;
}

/* ---------- 桌上物件 ---------- */
.kb-body {
  fill: #2a3240;
  stroke: #3a4557;
  stroke-width: 1;
}
.kb-row {
  fill: #7f8ea6;
  opacity: 0.55;
}
.mouse ellipse {
  fill: #cfd6e2;
}
.mouse path {
  stroke: #9aa5b6;
  stroke-width: 1.4;
}

.cup {
  fill: #e6ebf2;
}
.handle {
  fill: none;
  stroke: #e6ebf2;
  stroke-width: 2;
}
.steam path {
  fill: none;
  stroke: #dbe4ef;
  stroke-width: 1.6;
  stroke-linecap: round;
  opacity: 0;
}

.pot {
  fill: #b3653f;
}
.leaves ellipse {
  fill: #4f9e63;
}

.lamp-base {
  fill: #495468;
}
.lamp-stem {
  stroke: #495468;
  stroke-width: 2.5;
  fill: none;
}
.lamp-shade {
  fill: #5b6779;
}
.lamp-light {
  fill: #ffd489;
  opacity: 0.1;
}

/* ---------- 显示器 ---------- */
.mon-base {
  fill: #202735;
}
.mon-neck {
  fill: #2b3441;
}
.mon-bezel {
  fill: #171c26;
  stroke: #2b3341;
  stroke-width: 1.5;
}
.mon-screen {
  fill: #0a0d13;
}
.mon-glow polygon {
  fill: #6fa8ff;
  opacity: 0;
}
.mon-led {
  fill: var(--state-offline);
}

/* ---------- 屏幕内容 ---------- */
.screen-ui {
  position: absolute;
  left: 50%;
  top: 37.1%;
  width: 30.8%;
  height: 21.9%;
  transform: rotate(-3deg);
  transform-origin: 0 0;
  padding: 3px 4px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow: hidden;
  pointer-events: none;
}
.scr-head {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
}
.scr-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--state-offline);
  flex: none;
}
.scr-title {
  font-size: 8px;
  line-height: 1.15;
  color: #cfd8e6;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.scr-bar {
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
}
.scr-bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.4s ease;
}
.scr-file {
  font-size: 6px;
  color: #7f8ea6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.scr-alert {
  margin-top: auto;
  font-size: 6px;
  color: #ffb4b4;
  border-top: 1px solid var(--state-blocked);
  padding-top: 1px;
}

/* ---------- 悬停详情卡 ---------- */
.peek {
  position: absolute;
  left: 50%;
  bottom: 4%;
  transform: translateX(-50%) translateY(6px);
  width: 88%;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(10, 13, 18, 0.94);
  border: 1px solid var(--border-strong);
  font-size: 11px;
  line-height: 1.4;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s, transform 0.15s;
  z-index: 3;
}
.desk-scene:hover .peek,
.desk-scene.selected .peek {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
.peek-title {
  font-weight: 600;
  margin-bottom: 2px;
}
.peek-row {
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 桌牌 ---------- */
.plate {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}
.p-name {
  font-weight: 600;
  font-size: 13px;
}
.p-role {
  font-size: 11px;
}
.p-elapsed {
  font-size: 11px;
}

/* ================= 状态表现 ================= */
.state-online .scr-dot,
.state-online .mon-led {
  background: var(--state-online);
  fill: var(--state-online);
}
.state-busy .scr-dot,
.state-busy .mon-led {
  background: var(--state-busy);
  fill: var(--state-busy);
}
.state-idle .scr-dot,
.state-idle .mon-led {
  background: var(--state-idle);
  fill: var(--state-idle);
}
.state-blocked .scr-dot,
.state-blocked .mon-led {
  background: var(--state-blocked);
  fill: var(--state-blocked);
}

/* busy：键帽交替发光 + 屏幕蓝光溢出 + LED 快闪 */
.state-busy .kb-row {
  animation: key-tap 0.5s ease-in-out infinite;
  animation-delay: var(--phase);
}
.state-busy .kb-row:nth-child(2) {
  animation-delay: calc(var(--phase) + 0.12s);
}
.state-busy .kb-row:nth-child(3) {
  animation-delay: calc(var(--phase) + 0.24s);
}
.state-busy .mon-glow polygon {
  opacity: 0.14;
  animation: glow-pulse 1.8s ease-in-out infinite;
  animation-delay: var(--phase);
}
.state-busy .mon-led {
  animation: led-blink 0.9s steps(1, end) infinite;
}

/* online / idle：咖啡冒热气、绿植轻摆 */
.state-online .steam path,
.state-idle .steam path,
.state-busy .steam path {
  animation: steam 3.2s ease-in-out infinite;
  animation-delay: var(--phase);
}
.state-online .steam path:nth-child(2),
.state-idle .steam path:nth-child(2),
.state-busy .steam path:nth-child(2) {
  animation-delay: calc(var(--phase) + 1.1s);
}
.state-online .leaves,
.state-idle .leaves,
.state-busy .leaves {
  animation: sway 4.5s ease-in-out infinite;
  animation-delay: var(--phase);
  transform-origin: 205px 150px;
}

/* idle：屏幕变暗（屏保）+ 椅子后仰 + 热气更浓 */
.state-idle .screen-ui {
  opacity: 0.45;
}
.state-idle .chair {
  transform: rotate(-3deg);
  transform-origin: 100px 148px;
  transition: transform 0.4s ease;
}

/* blocked：台灯转红 + 光锥变红 + LED 急闪 + 屏幕红边 */
.state-blocked .lamp-light {
  fill: #ff7b7b;
  opacity: 0.16;
}
.state-blocked .lamp-shade {
  fill: #7a4a4a;
}
.state-blocked .mon-led {
  animation: led-blink 0.45s steps(1, end) infinite;
}
.state-blocked .screen-ui {
  box-shadow: inset 0 0 0 1px rgba(255, 107, 107, 0.5);
  border-radius: 2px;
}

/* offline：人不在、灯灭、屏幕黑、整体褪色 */
.state-offline {
  filter: saturate(0.45) brightness(0.85);
}
.state-offline .lamp-light {
  opacity: 0;
}
.state-offline .screen-ui {
  opacity: 0.25;
}
.state-offline .leaves ellipse {
  fill: #5a6b57;
}
.state-offline .chair-inner {
  fill: #373f4c;
}

/* busy 时椅子轻晃 */
.state-busy .chair {
  animation: rock 2.2s ease-in-out infinite;
  animation-delay: var(--phase);
  transform-origin: 100px 148px;
}

/* 推断值：虚线圈住工位，提示"这不是上报真值" */
.is-degraded .stage::after {
  content: '';
  position: absolute;
  inset: 2px;
  border: 1px dashed var(--text-faint);
  border-radius: 8px;
  pointer-events: none;
}

/* ================= 关键帧 ================= */
@keyframes key-tap {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 0.9;
  }
}
@keyframes glow-pulse {
  0%,
  100% {
    opacity: 0.08;
  }
  50% {
    opacity: 0.18;
  }
}
@keyframes led-blink {
  0%,
  49% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0.25;
  }
}
@keyframes steam {
  0% {
    opacity: 0;
    transform: translateY(2px);
  }
  30% {
    opacity: 0.7;
  }
  100% {
    opacity: 0;
    transform: translateY(-9px);
  }
}
@keyframes sway {
  0%,
  100% {
    transform: rotate(-2deg);
  }
  50% {
    transform: rotate(2deg);
  }
}
@keyframes rock {
  0%,
  100% {
    transform: rotate(0deg);
  }
  50% {
    transform: rotate(-1.5deg);
  }
}
@keyframes head-shake {
  0%,
  72%,
  100% {
    transform: rotate(0deg);
  }
  78% {
    transform: rotate(-4deg);
  }
  84% {
    transform: rotate(4deg);
  }
  90% {
    transform: rotate(-3deg);
  }
  96% {
    transform: rotate(2deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .desk-scene *,
  .desk-scene {
    animation: none !important;
    transition: none !important;
  }
}
</style>
