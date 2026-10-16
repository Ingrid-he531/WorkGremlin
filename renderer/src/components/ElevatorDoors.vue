<script setup>
/**
 * ElevatorDoors —— the lintel (the long screen above the elevator doors) + the two doors of the main stage.
 *
 * Design basis: design-elevator-transition.md §1 (the doors are built on the main stage rather than on the car) / §7.2,
 *          design-elevator-effort.md §2.4 (the lintel LCD screen).
 *
 * Structure (one column, two layers, like a real elevator door frame):
 *   .elevator-doors
 *     ├─ .lintel  ← lintel: a wall band that **does not participate in the animation**, the screen is fixed here (the landing indicator position of a real elevator)
 *     │              the project name has moved to the top bar (the "settings" row) centered, here there is only the task ticker screen (which eats the whole width)
 *     └─ .portal  ← door opening: the main stage content + the two door leaves, the doors only open and close within this area
 *
 * What scrolls on the screen is the **current task of all floors** (TaskTicker), no longer "the current floor":
 * the floor is available both in the left capsule and in the car, and this widest lintel area is better left for "what is happening on each floor".
 *
 * Key points:
 *   - the doors are a **decorative layer**: `pointer-events: none` + `aria-hidden`, they must not swallow clicks even at the moment of closing;
 *   - the door leaves only cover .portal, so closing/sliding will not press on the screen on the lintel (the screen is above the doors and stays visible);
 *   - displacement only moves `transform` (`translateX(±100%)` ↔ 0), never touches width / left / top;
 *   - state is fully driven by the `data-phase` attribute (no `<Transition>`, no WAAPI —— the design already rejected them);
 *   - `will-change` is attached only when not idle and removed immediately on entering idle (keeping it permanently would hold the compositing layer memory long-term);
 *   - a "ding" sounds on arrival: triggered at the moment phase enters `opening` (the doors start to open), see elevatorChime.js.
 */
import { watch } from 'vue';
import TaskTicker from './TaskTicker.vue';
import { playArrivalChime } from '../lib/elevatorChime';
import { useI18n } from '../i18n';

const { t } = useI18n();

const props = defineProps({
  /** idle | closing | moving | opening | settling —— the phase from useElevator */
  phase: { type: String, default: 'idle' },
  /** the fade-out/fade-in switch of the degraded mode (the system's "reduce motion"), from useElevator's flash */
  flash: { type: Boolean, default: false },
  /** whether the task ticker screen on the right of the lintel is shown. Non-elevator scenes such as the task records page do not need it,
   *  turning off the lintel will not leave a blank black block. Default on (pages such as the office still show it). */
  showScreen: { type: Boolean, default: true },
  /** whether the whole lintel (task ticker screen) is shown. The task records page does not need the elevator lintel at all, turning it off,
   *  the content goes straight to the top. Default on (elevator scenes such as the office keep the lintel). */
  showLintel: { type: Boolean, default: true },
});

watch(
  () => props.phase,
  (p, prev) => {
    // arrival: a "ding" at the moment the doors start to open. It rings only once when **entering** opening (settling / idle do not ring again)
    if (p === 'opening' && prev !== 'opening') playArrivalChime();
  }
);
</script>

<template>
  <div class="elevator-doors" :data-phase="phase" :data-flash="flash ? 'on' : 'off'">
    <!-- lintel: wall band + task ticker screen. The door leaves slide in the .portal below and cannot reach here.
         The project name has moved to the top bar (the "settings" row) centered, here only the ticker screen is left (it eats the whole width,
         the screen must be as long as possible —— one row has to fit "time + floor + the user's own words") -->
    <div v-if="showLintel" class="lintel">
      <TaskTicker v-if="showScreen" class="lintel-screen" />
    </div>
    <div class="portal">
      <!-- wrap the content in one more layer: this is the target of the "content in place" animation (writing styles directly on the root element of the slot content would land on the child component) -->
      <div class="stage-wrap">
        <slot />
      </div>
      <div class="door door-l" aria-hidden="true" />
      <div class="door door-r" aria-hidden="true" />
    </div>
  </div>
</template>

<style scoped>
.elevator-doors {
  /* takes over the role the old .stage had in .body: fill the main area; the doors are absolutely positioned, so this itself must be relative */
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column; /* above: the lintel (screen) / below: the door opening (stage + door leaves) */
  overflow: hidden;
}

/* lintel: the screen is fixed here. The height is driven by the content (the screen), not hardcoded —— changing the screen font size needs no change back here.
 *
 * appearance: same color, same frame, same radius as the office canvas below (--iso-bg / --border / --radius),
 * with one more ring left around it (margin 12px, aligned with .stage's padding, so the left and right edges of the lintel and the canvas form one vertical line).
 * That is, it is **not** "a color band stuck to the top edge of the window", but the same board sitting side by side with the canvas ——
 * the background is the same as the canvas, so the screen looks like it is mounted on that board rather than floating in a differently-colored bar. */
.lintel {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 12px 0;
  padding: 8px 12px;
  background: var(--iso-bg, #151a22);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

/* task ticker screen: it eats the **entire** width of the lintel (the screen as long as possible).
   It is the root element of the child component (TaskTicker) —— scoped styles can hit the child component root, so giving the width here is enough,
   the screen shell's own look (dark background / monospace font / scanlines) is managed inside the component. */
.lintel-screen {
  flex: 1 1 auto;
  min-width: 0;
}

/* door opening: the container of the stage content and the door leaves, so that when the leaves slide to ±100% no horizontal scrollbar is pushed out */
.portal {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

/* content in place (design §2 paragraph 4): the swap happens at 70% of the closing, so the "new content" is already inside during the moving phase ——
   first hide the whole block of content (the doors are closed throughout moving, so hiding it is invisible), and as soon as the doors start to open it returns in 120ms
   via opacity/scale. What is hidden is the content, not the entire stage: when the doors open one must not see a blank board.
   Note that [data-phase='closing'] is not used to hide here —— on the first frame of closing the doors are still fully open, and at that instant the content would flash away. */
.stage-wrap {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  opacity: 1;
  transform: scale(1);
  transition: opacity var(--dur-settle) var(--ease-settle), transform var(--dur-settle) var(--ease-settle);
}

[data-phase='moving'] .stage-wrap {
  opacity: 0;
  transform: scale(0.985);
  transition: none; /* this whole stretch is covered by the doors, no transition needed (it slides back when the doors open) */
}

/* degraded mode (the system's "reduce motion"): no elevator performance, but no hard cut either —— 40ms fade out, swap, 40ms fade in.
   The duration uses --dur-flash, one-to-one with useElevator's FLASH_MS. */
[data-flash='on'] .stage-wrap {
  opacity: 0;
  transition-duration: var(--dur-flash);
  transition-timing-function: linear;
}

.door {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 50%;
  z-index: 5;
  background: var(--bg-panel, #1b2029);
  pointer-events: none; /* purely decorative: it must not swallow clicks even at the moment of closing */
  transition: transform var(--dur-door-open) var(--ease-door-open);
}

/* door seam: a line is left where the two leaves meet, door-r's seam is on its own left */
.door-l {
  transform: translateX(-100%);
  border-right: 1px solid var(--border-strong, #333b4a);
}

.door-r {
  left: 50%;
  transform: translateX(100%);
  border-left: 1px solid var(--border-strong, #333b4a);
}

/* idle: the doors are fully open. Hardcoded in the idle state to avoid a first frame flashing a full-screen door (effort §2-2 pitfall ④) */
[data-phase='idle'] .door-l {
  transform: translateX(-100%);
}

[data-phase='idle'] .door-r {
  transform: translateX(100%);
}

/* closing: coming together. The curve accelerates first then seats, with no overshoot at the tail (doors bumping looks bad) */
[data-phase='closing'] .door {
  transform: translateX(0);
  transition-duration: var(--dur-door-close);
  transition-timing-function: var(--ease-door-close);
}

/* moving: keep closed. The target value is unchanged → no new transition is started, this just catches the rule above */
[data-phase='moving'] .door {
  transform: translateX(0);
}

/* opening / settling use .door's default state (translateX(±100%) + open duration/curve) */

/* will-change is attached only during animation and removed immediately on entering idle —— driven by phase, not transitionend (which drops events) */
.elevator-doors:not([data-phase='idle']) .door {
  will-change: transform;
}
</style>
