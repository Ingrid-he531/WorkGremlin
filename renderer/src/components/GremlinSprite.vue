<script setup>
/**
 * GremlinSprite —— 纯 SVG 的 Gremlin 小怪兽（局部坐标 64×64，脚底在 y=51）。
 *
 * 抽出来是为了能在两种容器里复用：
 *   - AgentAvatar：包一层 <svg viewBox="0 0 64 64"> 当头像用；
 *   - 办公室场景：外层 <g transform="translate(x,y) scale(s)"> 直接摆进大场景，可缩放/左右翻转。
 *
 * 状态表现：busy 敲手、idle 闭眼 Zzz、blocked 皱眉 + 红问号、offline 灰阶、degraded 半透明。
 * walking=true 时切成交替小跳（走路），并隐藏静态投影。
 */
import { computed } from 'vue';
import { avatarOf } from '@workgremlin/shared';

const props = defineProps({
  name: { type: String, required: true },
  state: { type: String, default: 'offline' },
  degraded: { type: Boolean, default: false },
  /** 走动中：小跳 + 左右轻摆 */
  walking: { type: Boolean, default: false },
});

const agentId = computed(() => props.name.split('@')[0]);
const skin = computed(() => avatarOf(props.name));
const isOffline = computed(() => props.state === 'offline');
</script>

<template>
  <g
    class="gremlin"
    :class="[`state-${state}`, { degraded, walking, offline: isOffline }]"
    :style="{ '--body': skin.body, '--horn': skin.horn }"
    :data-agent="agentId"
  >
    <ellipse class="shadow" cx="32" cy="56" rx="14" ry="3" />

    <g class="creature">
      <!-- 角 -->
      <path class="horn" d="M19 21 L13.5 8 L26 15 Z" />
      <path class="horn" d="M45 21 L50.5 8 L38 15 Z" />

      <!-- 身体 -->
      <path
        class="body"
        d="M32 13c11 0 19 8.2 19 19.2 0 10.6-8.5 18.8-19 18.8S13 42.8 13 32.2C13 21.2 21 13 32 13z"
      />
      <ellipse class="belly" cx="32" cy="41" rx="10.5" ry="8" />

      <!-- 手臂 -->
      <rect class="arm arm-l" x="11" y="34" width="7" height="10" rx="3.5" />
      <rect class="arm arm-r" x="46" y="34" width="7" height="10" rx="3.5" />

      <!-- 眼睛 -->
      <g class="eyes">
        <template v-if="state === 'idle'">
          <path class="eye-closed" d="M23 30h7" />
          <path class="eye-closed" d="M34 30h7" />
        </template>
        <template v-else>
          <circle class="eye" cx="26" cy="30" r="3.6" />
          <circle class="eye" cx="38" cy="30" r="3.6" />
          <circle class="pupil" cx="26" cy="31" r="1.5" />
          <circle class="pupil" cx="38" cy="31" r="1.5" />
        </template>
        <template v-if="state === 'blocked'">
          <path class="brow" d="M21 25l8 3" />
          <path class="brow" d="M43 25l-8 3" />
        </template>
      </g>

      <!-- 嘴 -->
      <path v-if="state === 'blocked'" class="mouth" d="M27 41q5-3 10 0" />
      <path v-else-if="state === 'idle'" class="mouth" d="M28 41q4 2 8 0" />
      <path v-else class="mouth" d="M26 39q6 6 12 0" />

      <!-- 配饰 -->
      <g v-if="skin.prop === 'megaphone'" class="prop">
        <path d="M44 26l13-7v18l-13-6z" fill="#ffd27a" />
        <rect x="40" y="31" width="6" height="5" rx="2" fill="#c98a2a" />
      </g>
      <g v-else-if="skin.prop === 'magnifier'" class="prop">
        <circle cx="47" cy="34" r="7" fill="none" stroke="#dff0ff" stroke-width="2.5" />
        <path d="M52 39l7 7" stroke="#dff0ff" stroke-width="3" stroke-linecap="round" />
      </g>
      <g v-else-if="skin.prop === 'keyboard'" class="prop">
        <rect x="38" y="36" width="22" height="9" rx="2" fill="#27303d" />
        <g fill="#8ea2bd">
          <rect x="40" y="38" width="3" height="2" />
          <rect x="45" y="38" width="3" height="2" />
          <rect x="50" y="38" width="3" height="2" />
          <rect x="55" y="38" width="3" height="2" />
          <rect x="42" y="41.5" width="14" height="2" />
        </g>
      </g>
      <g v-else-if="skin.prop === 'shield'" class="prop">
        <path d="M47 24l9 3v9c0 6-4.5 9.5-9 11-4.5-1.5-9-5-9-11v-9z" fill="#d5c2ff" />
        <path d="M43 37l4 4 8-8" fill="none" stroke="#5c3f9e" stroke-width="2.4" stroke-linecap="round" />
      </g>
      <g v-else-if="skin.prop === 'clipboard'" class="prop">
        <rect x="40" y="26" width="16" height="20" rx="2" fill="#ffd9ec" />
        <rect x="45" y="24" width="6" height="3" rx="1.5" fill="#c86aa0" />
        <g stroke="#c86aa0" stroke-width="1.6">
          <path d="M43 32h10M43 36h10M43 40h6" />
        </g>
      </g>
      <g v-else-if="skin.prop === 'wrench'" class="prop">
        <path d="M46 28a6 6 0 108 8l8-8-3-3-8 8-2-2z" fill="#c2cad6" />
      </g>
    </g>

    <!-- 阻塞：头顶问号 -->
    <g v-if="state === 'blocked'" class="mark">
      <circle cx="49" cy="14" r="8.5" />
      <text x="49" y="18.5" text-anchor="middle">?</text>
    </g>
    <!-- 空闲：Zzz -->
    <g v-else-if="state === 'idle'" class="zzz">
      <text x="47" y="18">Z</text>
      <text x="53" y="12">z</text>
    </g>
  </g>
</template>

<style scoped>
.gremlin {
  --body: #7f8c9b;
  --horn: #4a5160;
}

.creature {
  transform-box: fill-box;
  transform-origin: 50% 100%;
}

.shadow {
  fill: rgba(0, 0, 0, 0.32);
}
.walking .shadow {
  animation: shadow-pulse 0.42s ease-in-out infinite;
  transform-box: fill-box;
  transform-origin: 50% 50%;
}

.body {
  fill: var(--body);
}
.horn {
  fill: var(--horn);
}
.belly {
  fill: rgba(255, 255, 255, 0.16);
}
.arm {
  fill: var(--body);
  filter: brightness(0.9);
}
.eye {
  fill: #fff;
}
.pupil {
  fill: #1b2029;
}
.eye-closed,
.brow,
.mouth {
  stroke: #1b2029;
  stroke-width: 2.2;
  stroke-linecap: round;
  fill: none;
}
.brow {
  stroke-width: 2.2;
}

/* ---- 状态动画 ---- */
.state-busy .arm-l {
  animation: tap-l 0.5s ease-in-out infinite;
}
.state-busy .arm-r {
  animation: tap-r 0.5s ease-in-out infinite;
}
.state-online .creature {
  animation: breathe 3s ease-in-out infinite;
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

/* 离线：整体灰阶 */
.offline {
  opacity: 0.45;
}
/* degraded：值为推断，不是上报真值 */
.degraded {
  opacity: 0.66;
}

/* 走路：交替小跳 + 轻微前倾 */
.walking .creature {
  animation: hop 0.42s ease-in-out infinite;
}

@keyframes tap-l {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-2.5px);
  }
}
@keyframes tap-r {
  0%,
  100% {
    transform: translateY(-2px);
  }
  50% {
    transform: translateY(0.5px);
  }
}
@keyframes breathe {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.03);
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
@keyframes hop {
  0%,
  100% {
    transform: translateY(0) rotate(-2deg);
  }
  50% {
    transform: translateY(-5px) rotate(2deg);
  }
}
@keyframes shadow-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.32;
  }
  50% {
    transform: scale(0.82);
    opacity: 0.2;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gremlin * {
    animation: none !important;
  }
}
</style>
