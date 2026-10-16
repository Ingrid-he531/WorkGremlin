<script setup>
/**
 * DeskScene —— a single "real workstation" (2.5D oblique top-down view).
 *
 * Layers from back to front: carpet → partition panel → chair → sprite → desk top → items on the desk (keyboard/mouse/mug/lamp/plant)
 *              → monitor (the screen is an HTML overlay showing the real task/file) → name plate.
 *
 * The reason it is split into bg / fg SVG layers: the sprite is an HTML component (AgentAvatar),
 * it must be sandwiched between the "chair" and the "desk" to get the layering of "sitting behind the desk with hands on it".
 *
 * All animation goes through CSS keyframes, using --phase hashed by member name to stagger the phase and avoid everyone moving in sync.
 */
import { computed } from 'vue';
import AgentAvatar from './AgentAvatar.vue';
import StatusBadge from './StatusBadge.vue';
import { avatarOf, formatClock } from '@workgremlin/shared';
import { currentTaskOf, currentTaskTitle, currentTaskStartedAt } from '../lib/memberTask';
import { useI18n } from '../i18n';

const props = defineProps({
  member: { type: Object, required: true },
  selected: { type: Boolean, default: false },
});
const emit = defineEmits(['select']);

const agentId = computed(() => props.member.memberId.split('@')[0]);
const skin = computed(() => avatarOf(props.member.memberId));
const state = computed(() => props.member.state);
const { t } = useI18n();

// The "current task" definition is consistent with the other cards (see lib/memberTask.js): when idle, the entry in the slot is the **previous task**,
// it must not stay on the screen impersonating the current task.
const task = computed(() => currentTaskOf(props.member));
const title = computed(() => currentTaskTitle(props.member) || t('card.idle'));
// The bar on the screen is **indeterminate** (it only crawls while working and does not represent completion) —— before 2026-09-29 it drew its length from
// member.task.progress, but that field has no real values (across the whole DB there are only 0 and 1, 0 written at start and 1 written at finish,
// nobody advances it in between; see the note on the "progress" row in TaskRecordsView), so it always drew an empty or full bar.
// Therefore here it only checks "working or not", with the same value as the main console (see PHASES.busy in iso/mainConsole.js).
const running = computed(() => state.value === 'busy');
const fileText = computed(() =>
  props.member.currentFiles && props.member.currentFiles.length ? props.member.currentFiles[0] : t('card.no_file')
);
/**
 * Both time points use an **absolute time** (MM-DD HH:mm): start = the start time of the current task, last active = the finish time of the previous task.
 * No "how long ago" relative duration —— that requires recomputing every second, and if recomputation breaks you get "some workstations frozen, others still climbing"
 * (measured by the user on 2026-09-30). A hardcoded time point needs no timer (the parent's now tick was removed along with it).
 */
const startAt = computed(() => formatClock(currentTaskStartedAt(props.member) || props.member.stateSince));
const lastActiveAt = computed(() => formatClock(props.member.lastTaskAt) || '—');

/** animation phase 0~1.6s, hashed by member name: everyone's motion is not perfectly uniform */
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
      <!-- ===== background: carpet / partition / chair ===== -->
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

      <!-- ===== sprite: sandwiched between the chair and the desk ===== -->
      <div class="gremlin">
        <AgentAvatar :name="member.memberId" :state="state" :degraded="member.degraded" :size="100" />
      </div>

      <!-- ===== foreground: desk top / items on the desk / monitor ===== -->
      <svg class="layer" viewBox="0 0 260 210" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <!-- lamp (with light cone) -->
        <g class="lamp">
          <polygon class="lamp-light" points="59,122 75,122 98,170 36,170" />
          <path class="lamp-stem" d="M67 148 L67 122" />
          <ellipse class="lamp-base" cx="67" cy="149" rx="11" ry="4" />
          <path class="lamp-shade" d="M56 122 L78 122 L73 111 L61 111 Z" />
        </g>

        <!-- desk -->
        <polygon class="desk-top" points="58,146 202,146 218,170 42,170" />
        <polygon class="desk-front" points="42,170 218,170 218,181 42,181" />
        <polygon class="desk-leg" points="62,181 76,181 71,200 66,200" />
        <polygon class="desk-leg" points="184,181 198,181 194,200 189,200" />

        <!-- keyboard -->
        <g class="keyboard">
          <polygon class="kb-body" points="72,149 152,149 158,164 66,164" />
          <g class="keys">
            <polygon class="kb-row" points="76,151 148,151 149,154 75,154" />
            <polygon class="kb-row" points="74,155 150,155 151,158 73,158" />
            <polygon class="kb-row" points="73,159 151,159 153,162 71,162" />
          </g>
        </g>

        <!-- mouse -->
        <g class="mouse">
          <ellipse cx="184" cy="158" rx="6" ry="9" />
          <path d="M184 150 v6" />
        </g>

        <!-- mug + steam -->
        <g class="mug">
          <path class="handle" d="M70 159h3.5a3.5 3.5 0 0 1 0 7H70" />
          <rect class="cup" x="56" y="155" width="14" height="16" rx="3" />
          <g class="steam">
            <path d="M60 152c-2.5-3 2.5-5 0-8" />
            <path d="M67 152c-2.5-3 2.5-5 0-8" />
          </g>
        </g>

        <!-- plant -->
        <g class="plant">
          <polygon class="pot" points="196,150 214,150 211,164 199,164" />
          <g class="leaves">
            <ellipse cx="205" cy="142" rx="4" ry="7.5" transform="rotate(-16 205 142)" />
            <ellipse cx="199" cy="145" rx="3.4" ry="6" transform="rotate(-40 199 145)" />
            <ellipse cx="211" cy="145" rx="3.4" ry="6" transform="rotate(24 211 145)" />
          </g>
        </g>

        <!-- monitor -->
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

      <!-- ===== screen content (HTML overlay, ensuring text can be truncated/readable) ===== -->
      <div class="screen-ui">
        <div class="scr-head">
          <span class="scr-dot" />
          <span class="scr-title">{{ title }}</span>
        </div>
        <!-- bar: indeterminate animation (the track is always visible, the light band only crawls while working). The 1800ms period matches the main console,
             see the ph.busy section in iso/mainConsole.js. -->
        <div class="scr-bar"><i v-if="running" /></div>
        <div class="scr-file mono">{{ fileText }}</div>
        <div v-if="state === 'blocked'" class="scr-alert">{{ t('card.needs_help') }}</div>
      </div>

      <!-- detail card on hover/selection (the small screen cannot show everything, this fills in the information) -->
      <div class="peek">
        <div class="peek-title">{{ title }}</div>
        <!-- "progress x%" was removed (2026-09-29): that percentage was fake, with only two possible values 0% and 100%.
             The time points are all written as absolute times (no relative duration, avoiding per-second recomputation): start / last active. -->
        <div v-if="task" class="peek-row dim">{{ t('card.started', { time: startAt }) }}</div>
        <div v-else class="peek-row dim">{{ t('card.last_active', { time: lastActiveAt }) }}</div>
        <div v-if="member.currentFiles.length" class="peek-row mono">{{ member.currentFiles.join(' , ') }}</div>
      </div>
    </div>

    <!-- ===== name plate ===== -->
    <div class="plate">
      <span class="p-name">{{ member.name }}</span>
      <span class="p-role dim">{{ member.role || '—' }}</span>
      <StatusBadge :state="state" :degraded="member.degraded" :testid="`seat-status-${agentId}`" />
      <!-- the small number on the name plate is also only meaningful while working (the start time of the current task) -->
      <span v-if="task" class="p-elapsed mono faint">{{ startAt }}</span>
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

/* ---------- background ---------- */
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

/* ---------- sprite ---------- */
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
  display: none; /* sitting behind the desk, the ground shadow is blocked by the desk */
}
.gremlin :deep(.prop) {
  display: none; /* the desk already has a keyboard/magnifier and other items, avoiding duplication with the prop in hand */
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
  opacity: 0; /* person absent: the chair is empty */
}

/* ---------- foreground: desk ---------- */
.desk-top {
  fill: #6d5540;
}
.desk-front {
  fill: #4c3b2c;
}
.desk-leg {
  fill: #3a2d21;
}

/* ---------- items on the desk ---------- */
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

/* ---------- monitor ---------- */
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

/* ---------- screen content ---------- */
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
/* indeterminate bar: the light band occupies a fixed 30% of the track and loops sliding from left to right (it does not represent completion, it represents "running").
   The translation is computed from the light band's own width: -100% = fully slid out to the left, 333% ≒ fully slid out to the right (30% × 3.33 ≈ 100%). */
.scr-bar i {
  display: block;
  height: 100%;
  width: 30%;
  background: var(--accent);
  animation: scr-crawl 1.8s linear infinite;
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

/* ---------- hover detail card ---------- */
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

/* ---------- name plate ---------- */
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

/* ================= state presentation ================= */
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

/* busy: keycaps glow alternately + screen blue light spill + LED fast blink */
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

/* online / idle: coffee steams, plant sways gently */
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

/* idle: screen dims (screensaver) + chair leans back + steam thicker */
.state-idle .screen-ui {
  opacity: 0.45;
}
.state-idle .chair {
  transform: rotate(-3deg);
  transform-origin: 100px 148px;
  transition: transform 0.4s ease;
}

/* blocked: lamp turns red + light cone turns red + LED urgent blink + screen red border */
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

/* offline: person absent, lamp off, screen black, overall desaturated */
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

/* the chair sways slightly while busy */
.state-busy .chair {
  animation: rock 2.2s ease-in-out infinite;
  animation-delay: var(--phase);
  transform-origin: 100px 148px;
}

/* inferred value: a dashed line circles the workstation, hinting "this is not a reported true value" */
.is-degraded .stage::after {
  content: '';
  position: absolute;
  inset: 2px;
  border: 1px dashed var(--text-faint);
  border-radius: 8px;
  pointer-events: none;
}

/* ================= keyframes ================= */
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
/* the bar on the screen: crawls from left to right, 1.8s per cycle (same period as the main console mainConsole) */
@keyframes scr-crawl {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(333%);
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

  /* the indeterminate bar expresses "running" through "motion": with animation off it is left with only a fixed-length light band, which would be read as
     "progress 30%", effectively creating another fake progress. So here the light band is simply not drawn and only the empty track is kept. */
  .scr-bar i {
    display: none;
  }
}
</style>
