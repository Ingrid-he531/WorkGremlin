<script setup>
/**
 * GhostSprite —— the "ghost" form of a temporary team member (local coordinates 64×64, hem bottom at y=52).
 *
 * Differences from GremlinSprite (tellable at a glance):
 *   - semi-transparent + dashed outline (temporary, unowned)
 *   - the hem is wavy (no legs, does not touch the ground)
 *   - an antenna on top of the head (remote access, not belonging to this office)
 *   - no ground shadow (floats in the air); the scene layer draws a separate hovering halo
 *
 * The color is a soft hue hashed from memberId (stable per member across refreshes),
 * and the state is still expressed via expression + opacity: idle closes eyes, blocked frowns + a question mark.
 */
import { computed } from 'vue';
import { normalizeState } from '../lib/memberTask';

const props = defineProps({
  name: { type: String, required: true },
  state: { type: String, default: 'idle' },
});

/** Soft palette: avoids the saturated role colors of the expert team, so it does not "look like a certain expert" */
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
const normalizedState = computed(() => normalizeState(props.state));
</script>

<template>
  <g
    class="ghost"
    :class="`state-${normalizedState}`"
    :style="{ '--body': body }"
    :data-agent="agentId"
  >
    <!-- Soft glow: makes it "glow" against a dark background -->
    <ellipse class="aura" cx="32" cy="36" rx="21" ry="26" />

    <g class="creature">
      <!-- Antenna: remote temporary member -->
      <path class="antenna-line" d="M32 15V7" />
      <circle class="antenna-tip" cx="32" cy="4.5" r="2.6" />

      <!-- Body: round dome + wavy hem -->
      <path
        class="body"
        d="M13 33 A19 19 0 0 1 51 33 V52 q-4.75 7 -9.5 0 q-4.75 -7 -9.5 0 q-4.75 7 -9.5 0 q-4.75 -7 -9.5 0 Z"
      />

      <!-- Eyes -->
      <g class="eyes">
        <template v-if="normalizedState === 'idle'">
          <path class="eye-closed" d="M22 31h8" />
          <path class="eye-closed" d="M34 31h8" />
        </template>
        <template v-else>
          <ellipse class="eye" cx="26" cy="31" rx="3.4" ry="4.4" />
          <ellipse class="eye" cx="38" cy="31" rx="3.4" ry="4.4" />
        </template>
        <template v-if="normalizedState === 'blocked'">
          <path class="brow" d="M21 25l8 4" />
          <path class="brow" d="M43 25l-8 4" />
        </template>
      </g>

      <!-- Mouth -->
      <path v-if="normalizedState === 'blocked'" class="mouth" d="M27 41q5-3 10 0" />
      <path v-else-if="normalizedState === 'idle'" class="mouth" d="M28 41q4 2 8 0" />
      <path v-else class="mouth" d="M26 39q6 6 12 0" />
    </g>

    <!-- Blocked: question mark above the head -->
    <g v-if="normalizedState === 'blocked'" class="mark">
      <circle cx="50" cy="14" r="8.5" />
      <text x="50" y="18.5" text-anchor="middle">?</text>
    </g>
    <!-- Idle: Zzz -->
    <g v-else-if="normalizedState === 'idle'" class="zzz">
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

/* Hovering: slight sway (the up/down bobbing is computed per frame by the scene layer, so the label follows) */
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
