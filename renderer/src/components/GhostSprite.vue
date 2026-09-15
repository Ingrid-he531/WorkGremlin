<script setup>
/**
 * GhostSprite —— 临时组队成员的"幽灵"形象（局部坐标 64×64，下摆底在 y=52）。
 *
 * 与 GremlinSprite 的区别（一眼能分辨）：
 *   - 半透明 + 虚线描边（临时的、没有归属）
 *   - 下摆是波浪（没有腿、不着地）
 *   - 头顶一根天线（远程接入，不属于这间办公室）
 *   - 没有落地投影（飘在空中），场景层另外画一个悬浮光晕
 *
 * 颜色按 memberId 哈希取柔和色（同一成员每次刷新颜色稳定），
 * 状态仍然靠表情 + 透明度表达：idle 闭眼、blocked 皱眉 + 问号、offline 灰阶。
 */
import { computed } from 'vue';

const props = defineProps({
  name: { type: String, required: true },
  state: { type: String, default: 'offline' },
  degraded: { type: Boolean, default: false },
});

/** 柔和色板：避开专家团队的饱和角色色，避免"像某个专家" */
const PALETTE = ['#7fe3d4', '#9db8ff', '#c9a7ff', '#ffb3d1', '#ffd79a', '#a8e6a1', '#8fe0f5'];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const agentId = computed(() => props.name.split('@')[0]);
const body = computed(() => PALETTE[hash(props.name) % PALETTE.length]);
const isOffline = computed(() => props.state === 'offline');
</script>

<template>
  <g
    class="ghost"
    :class="[`state-${state}`, { degraded, offline: isOffline }]"
    :style="{ '--body': body }"
    :data-agent="agentId"
  >
    <!-- 柔光：让它在暗背景上"发光" -->
    <ellipse class="aura" cx="32" cy="36" rx="21" ry="26" />

    <g class="creature">
      <!-- 天线：远程临时成员 -->
      <path class="antenna-line" d="M32 15V7" />
      <circle class="antenna-tip" cx="32" cy="4.5" r="2.6" />

      <!-- 身体：圆顶 + 波浪下摆 -->
      <path
        class="body"
        d="M13 33 A19 19 0 0 1 51 33 V52 q-4.75 7 -9.5 0 q-4.75 -7 -9.5 0 q-4.75 7 -9.5 0 q-4.75 -7 -9.5 0 Z"
      />

      <!-- 眼睛 -->
      <g class="eyes">
        <template v-if="state === 'idle'">
          <path class="eye-closed" d="M22 31h8" />
          <path class="eye-closed" d="M34 31h8" />
        </template>
        <template v-else>
          <ellipse class="eye" cx="26" cy="31" rx="3.4" ry="4.4" />
          <ellipse class="eye" cx="38" cy="31" rx="3.4" ry="4.4" />
        </template>
        <template v-if="state === 'blocked'">
          <path class="brow" d="M21 25l8 4" />
          <path class="brow" d="M43 25l-8 4" />
        </template>
      </g>

      <!-- 嘴 -->
      <path v-if="state === 'blocked'" class="mouth" d="M27 41q5-3 10 0" />
      <path v-else-if="state === 'idle'" class="mouth" d="M28 41q4 2 8 0" />
      <path v-else class="mouth" d="M26 39q6 6 12 0" />
    </g>

    <!-- 阻塞：头顶问号 -->
    <g v-if="state === 'blocked'" class="mark">
      <circle cx="50" cy="14" r="8.5" />
      <text x="50" y="18.5" text-anchor="middle">?</text>
    </g>
    <!-- 空闲：Zzz -->
    <g v-else-if="state === 'idle'" class="zzz">
      <text x="48" y="18">Z</text>
      <text x="54" y="12">z</text>
    </g>
  </g>
</template>

<style scoped>
.ghost {
  --body: #7fe3d4;
}

.creature {
  transform-box: fill-box;
  transform-origin: 50% 15%;
}

.aura {
  fill: var(--body);
  opacity: 0.1;
  animation: aura-pulse 4s ease-in-out infinite;
  transform-box: fill-box;
  transform-origin: 50% 50%;
}

.body {
  fill: var(--body);
  fill-opacity: 0.5;
  stroke: var(--body);
  stroke-width: 2;
  stroke-dasharray: 5 4;
  stroke-opacity: 0.85;
}

.antenna-line {
  stroke: var(--body);
  stroke-width: 2;
  stroke-linecap: round;
  opacity: 0.8;
  fill: none;
}
.antenna-tip {
  fill: var(--body);
  animation: tip-blink 1.8s ease-in-out infinite;
}

.eye {
  fill: #10161f;
  opacity: 0.82;
}
.eye-closed,
.brow,
.mouth {
  stroke: #10161f;
  stroke-width: 2.2;
  stroke-linecap: round;
  fill: none;
  opacity: 0.8;
}

/* 悬浮：轻微摆动（上下浮动由场景层按帧计算，好让标签跟着动） */
.creature {
  animation: sway 3.8s ease-in-out infinite;
}

.mark circle {
  fill: var(--state-blocked);
}
.mark text {
  fill: #fff;
  font-size: 11px;
  font-weight: 700;
}
.mark {
  animation: bob 1.4s ease-in-out infinite;
}

.zzz text {
  fill: var(--text-faint);
  font-size: 10px;
  font-weight: 700;
}
.zzz {
  animation: float-up 2.6s ease-in-out infinite;
}

/* offline：灰阶 + 更淡 */
.offline {
  opacity: 0.4;
  filter: grayscale(1);
}
/* degraded：值是推断的，不是上报真值 */
.degraded {
  opacity: 0.6;
}

@keyframes sway {
  0%,
  100% {
    transform: rotate(-2.5deg) translateY(0);
  }
  50% {
    transform: rotate(2.5deg) translateY(-2px);
  }
}
@keyframes aura-pulse {
  0%,
  100% {
    opacity: 0.08;
    transform: scale(1);
  }
  50% {
    opacity: 0.16;
    transform: scale(1.06);
  }
}
@keyframes tip-blink {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}
@keyframes bob {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-3px);
  }
}
@keyframes float-up {
  0% {
    opacity: 0;
    transform: translateY(4px);
  }
  40% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translateY(-8px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ghost * {
    animation: none !important;
  }
}
</style>
