/**
 * useElevator —— the state machine for the floor-switch "elevator" transition.
 *
 * Basis: docs/design-elevator-transition.md §2 timing table / §4 state machine (incl. §4.3 interrupt
 * policy) / §5.1 degraded mode / §7.2 organization / §8.1 risk mitigation, and
 * docs/design-elevator-effort.md §2.3 (highlighting the pending target floor).
 *
 * Four hard rules (read the design before changing; do not go by feel):
 *   1. Module-level singleton + ref, not in Pinia —— this is transient UI state, and putting it into a
 *      store would broadcast a subscription round on every animation (design §7.2). App.vue,
 *      ElevatorDoors and FloorSelector share the same instance.
 *   2. **Every advance must go through `step()`** (which checks the token and arms a 2s fallback). Spraying
 *      `await sleep` and checking the token separately is the T1 style; once interrupt logic is added it is
 *      very easy to miss a spot —— and one missed spot is "the previous trip's door is half open, the next
 *      one closes it again".
 *   3. The face change (selectFloor) must happen after the door is 70% closed —— a content jump has to hide
 *      behind the door.
 *   4. Do not use `transitionend` (events are lost in multi-segment choreography and it can fire twice; the
 *      design already ruled this out).
 *
 * Pure logic, no DOM (the watchdog only attaches one `visibilitychange`, see settleElevator), and sleep is
 * injectable: `injectSleep(controllable clock)` runs the whole interrupt suite without mounting components.
 */

import { computed, ref } from 'vue';
import { useSessionStore } from '../stores/sessions';

/** Duration of each segment (ms) —— one-to-one with the --dur-* tokens in theme.css; change one and sync the other */
export const DURATIONS = { close: 180, open: 260, settle: 120 };

/** Commit selectFloor once the close reaches this ratio: the face change must happen behind the door (design §2 segment 1) */
export const COMMIT_AT = 0.7;

/**
 * Fallback ceiling for each segment (design §8.1 first rule: **no exception may leave the door closed
 * forever**). A normal `sleep` always resolves; this guards the extreme cases "the injected clock never
 * calls back / the main thread is stuck": if `segment duration + 2s` passes with no advance, force the move.
 */
export const SEG_TIMEOUT_MS = 2000;

/**
 * Degraded tier (system "reduce motion"): the fade in/out duration per half segment (ms), one-to-one with
 * the `--dur-flash` in theme.css. Design §5.1 requires this tier to total <100ms: 40ms fade out + face
 * change + 40ms fade in = 80ms.
 */
export const FLASH_MS = 40;

/**
 * Shaft travel duration: across N floors = clamp(240 + 130 × N, 300, 700)
 *   N=1 → 300ms (860ms total)  N=2 → 500ms  N=3 → 630ms  N≥4 → 700ms cap
 * Why the cap: 4 floors is already the largest span this product offers; any longer and the user feels "the
 * software is lagging, doing effects".
 */
export function moveMsFor(n) {
  return Math.min(700, Math.max(300, Math.round(240 + 130 * Math.abs(n))));
}

/** idle | closing | moving | opening | settling —— the single source of animation truth; CSS expands it via data-phase */
const phase = ref('idle');
/** This trip's destination floor (when the destination is changed mid-run, it is this that changes) */
const targetFloor = ref('');
/** This trip's origin floor: the car is still parked here while the door closes (see carFloor) */
const fromFloor = ref('');
/**
 * The "change destination" reservation slot (design §4.3): pressing another floor mid-run does not teleport;
 * it first finishes this segment (to the nearest reachable floor), and on arrival does not open the door but
 * reverses toward it. Only at that point does it become the real targetFloor.
 */
const pendingTarget = ref('');
/** This trip's shaft travel duration, for the car to write an inline transition-duration */
const moveMs = ref(moveMsFor(1));
/**
 * on | reduced | off —— the `auto` tier is normalized here:
 *   on      full elevator animation
 *   reduced the system has "reduce motion" on: no elevator, but **not a hard cut** either; one 80ms
 *           fade out/in (design §5.1)
 *   off     the user explicitly turned animation off: a true hard cut, not even a fade
 */
const motionMode = ref('on');
/** Fade-out/in switch of the degraded tier: attached to ElevatorDoors' data-flash; CSS only does opacity */
const flash = ref(false);
/** Incremented on each request: every advance relies on it to avoid cross-talk */
let token = 0;
/** Whether this trip has already committed selectFloor (the face change behind the door). The closing segment's "press the current floor = undo" is told apart by it */
let committed = false;

/** sleep is injectable: unit tests swap in a controllable clock instead of really waiting 860ms */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sleep = defaultSleep;

export function injectSleep(fn) {
  sleep = typeof fn === 'function' ? fn : defaultSleep;
}

/**
 * Merge the three-position switch: localStorage['wg.elevatorMotion'] (on / off / auto, default auto);
 * the auto tier looks at the system prefers-reduced-motion. There is no switch UI entry (effort §2-7);
 * write localStorage in the console by hand to verify.
 *
 * Note auto + system preference → **`reduced`, not `off`**: the system preference says "move less", not
 * "no feedback". Falling straight to off becomes a hard cut, and switching floors gives no motion at all
 * (design §5.1 originally means a 60ms fade, total <100ms). Only the user turning it off in settings is a
 * true zero-animation.
 */
function readMode() {
  let v = 'auto';
  try {
    v = localStorage.getItem('wg.elevatorMotion') || 'auto';
  } catch {
    /* private mode / storage disabled: go with auto */
  }
  if (v === 'on' || v === 'off') return v;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'on';
  } catch {
    return 'on';
  }
}

/** The current floor (the one in the store). The store is fetched lazily: activePinia only exists after app.use(pinia) */
const currentFloor = computed(() => useSessionStore().selectedFloor);

/**
 * For highlighting (effort §2.3 option A): the destination-floor pill must light up at t=0, but the store's
 * selectedFloor is only committed at 70% of the close —— during those one-hundred-plus milliseconds there is
 * no truth, and this covers it uniformly.
 * With a reservation slot (destination changed mid-run) it lights **the one the user pressed last**: pressing
 * should light it, which is also common sense in a real elevator (the car is still heading to the floor above,
 * but the 5F you pressed is already lit).
 */
const displayFloor = computed(() => {
  if (phase.value === 'idle') return currentFloor.value;
  return pendingTarget.value || targetFloor.value;
});

/**
 * For the car. Same source as displayFloor (the same phase / targetFloor / currentFloor), but the car only
 * starts once the door is closed (design §2 segment 2 is when moving comes): sliding away while the door is
 * still open has no elevator feel, so during closing it stays at the origin floor. Do not open a separate
 * source, to avoid "the highlight is at 4F while the car is at 3F".
 * Note it **ignores pendingTarget**: the car physically goes to this trip's destination; the reservation slot
 * only affects button highlighting.
 */
const carFloor = computed(() => {
  if (phase.value === 'idle') return currentFloor.value;
  return phase.value === 'closing' ? fromFloor.value : targetFloor.value;
});

/**
 * This trip's direction: 'up' | 'down' | ''. The LCD's ▲▼ uses it —— it only speaks while **not yet arrived**
 * (closing / moving), the same gate as pendingFloor: once arrived, direction is meaningless and the screen
 * should not keep an up arrow (the car has stopped).
 * Note it compares fromFloor → targetFloor, **not** carFloor → targetFloor: direction is a property of "this
 * trip" and must light up at close time, whereas in the moving segment carFloor already equals target, so
 * judging by it would always be empty.
 * Floor order comes from store.floors (the same source as the car and the highlight); do not lay out another
 * set inside the component.
 */
const facing = computed(() => phase.value === 'closing' || phase.value === 'moving');
const direction = computed(() => {
  if (!facing.value) return '';
  const floors = useSessionStore().floors;
  const a = floors.findIndex((f) => f.id === fromFloor.value);
  const b = floors.findIndex((f) => f.id === targetFloor.value);
  if (a < 0 || b < 0 || a === b) return '';
  return b > a ? 'up' : 'down';
});

/**
 * LCD "pending floor": only has a value while not yet arrived (closing / moving); it goes dark as soon as we
 * arrive (opening / settling).
 * Division of labor with displayFloor: displayFloor answers "which floor should the button light up at" (the
 * one the user pressed, including the reservation slot); this answers "which floor the car is heading to"
 * (this trip's destination), and it is gone once arrived.
 */
const pendingFloor = computed(() => (facing.value ? targetFloor.value : ''));

/** A floor's index in the list (used for the floor span and the direction; not in the list → -1) */
function floorIndex(store, id) {
  return store.floors.findIndex((f) => f.id === id);
}

/**
 * The **only** segment-advance entry point: wait out this segment's duration, then report back whether "this
 * trip is still the current one".
 *
 * - Returns `false` = already invalidated (someone pressed another floor / undo / forced wrap-up); the caller
 *   must exit the whole trip;
 * - Built-in 2s fallback: forces the move even when `sleep` never resolves (design §8.1). A `sleep` throw also
 *   counts as "this segment passed" and likewise must not lock the door.
 */
function step(my, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(my === token);
    };
    const guard = setTimeout(finish, ms + SEG_TIMEOUT_MS);
    Promise.resolve()
      .then(() => sleep(ms))
      .then(() => {
        clearTimeout(guard);
        finish();
      })
      .catch(() => {
        clearTimeout(guard);
        finish();
      });
  });
}

/** Invalidate the in-flight trip and clear this trip's transient state (phase is decided by the caller) */
function abortRun() {
  token += 1;
  committed = false;
  pendingTarget.value = '';
  targetFloor.value = '';
  fromFloor.value = '';
  flash.value = false; // do not leave the degraded tier "fading out" mid-way (that is an invisible screen's worth of content)
}

/** Start a trip: close → face change → shaft travel (incl. reversal) → open → settle */
function startRun(id, store) {
  const my = ++token;
  committed = false;
  fromFloor.value = store.selectedFloor;
  targetFloor.value = id;
  pendingTarget.value = '';
  phase.value = 'closing';
  void run(my, store);
}

async function run(my, store) {
  // Segment 1 close: face change at 70% (the content jump hides behind the door). The target floor may have
  // been changed mid-close (§4.3), so what is committed is the **current** targetFloor, not the input id.
  const commitAt = Math.round(DURATIONS.close * COMMIT_AT);
  if (!(await step(my, commitAt))) return;
  committed = true;
  store.selectFloor(targetFloor.value);
  if (!(await step(my, DURATIONS.close - commitAt))) return;

  // Segment 2 shaft travel. It may run twice: someone changes the destination mid-run → do not open on
  // arrival, reverse and travel another segment.
  for (;;) {
    const n = floorIndex(store, targetFloor.value) - floorIndex(store, fromFloor.value);
    moveMs.value = moveMsFor(Number.isFinite(n) && n !== 0 ? n : 1);
    phase.value = 'moving';
    if (!(await step(my, moveMs.value))) return;

    const next = pendingTarget.value;
    if (!next) break;
    // Reversal: this floor is already done (**no teleport**), the door does not open, and we travel another
    // segment with a new target —— effort §4's "naive two-stage": no path replanning, one extra moveMs,
    // at half the code.
    fromFloor.value = targetFloor.value;
    targetFloor.value = next;
    pendingTarget.value = '';
  }

  // On reversal the store is still on "the destination committed at close time" (say 3F was committed first):
  // the door is closed the whole time, so patch the face change here; the jump is still hidden behind the door
  // (unit test [7] missed this step —— the car arrived at 5F while the content was still 3F)
  if (store.selectedFloor !== targetFloor.value) store.selectFloor(targetFloor.value);

  // Segment 3 open
  phase.value = 'opening';
  if (!(await step(my, DURATIONS.open))) return;

  // Segment 4 content settle
  phase.value = 'settling';
  if (!(await step(my, DURATIONS.settle))) return;

  phase.value = 'idle';
  targetFloor.value = '';
  fromFloor.value = '';
}

/** Undo (pressing the current floor mid-close): invalidate this trip; the door's target returns to idle and the browser keeps sliding it open from "half closed" */
function cancelRun() {
  abortRun();
  phase.value = 'idle';
}

/**
 * Forced wrap-up: "finish" the in-flight trip (apply the floor change it owes), open the door, return to idle.
 *
 * Used in two places: the page is hidden, and App unmount. It is **not "cancel back to idle"** —— the user
 * pressed, so it should go; a silent cancel becomes "pressed and nothing happened". The trigger is
 * `document.hidden` (minimize / switch to another page), and it **does not look at `blur`**: cutting the
 * animation off because another window was clicked is too brusque, and blur does not trigger timer throttling.
 */
export function settleElevator() {
  if (phase.value === 'idle') return;
  if (!committed && targetFloor.value) {
    committed = true;
    try {
      useSessionStore().selectFloor(targetFloor.value);
    } catch {
      /* store not ready yet (extreme timing): ignore; the wrap-up must not throw again */
    }
  }
  abortRun();
  phase.value = 'idle';
}

/** Wrap up only when the page is really hidden: Chromium throttles a hidden page's timers to the minute scale, and waiting really would be "the door closed and not moving" */
let watchdogArmed = false;
function armWatchdog() {
  if (watchdogArmed || typeof document === 'undefined') return;
  watchdogArmed = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) settleElevator();
  });
}

/**
 * Call the elevator —— the whole interrupt policy lives here (the table in design §4.3 is the ifs below):
 *
 * | When | Which floor pressed | Behavior |
 * | --- | --- | --- |
 * | any | a floor not installed | ignore (unreachable) |
 * | any | (`off` tier) | true hard cut: invalidate the in-flight trip then selectFloor directly, no animation or fade |
 * | any | (`reduced` tier) | 40ms fade out → face change → 40ms fade in, not the elevator's five segments |
 * | idle | another floor | start a trip |
 * | idle | the same floor again within 250ms | one trip, not two (**no dedicated dedup needed**, see below) |
 * | closing | the current floor | undo: the door reopens, back to idle |
 * | closing | another floor | change the destination, **do not restart the close** (closing is an irrevocable work-in-progress) |
 * | moving | the floor about to be reached | ignore (we are almost there anyway) |
 * | moving | another floor | record a reservation; do not open on arrival, reverse instead |
 * | opening / settling | any floor | **preempt**: close again immediately (the only interruptible boundary) |
 *
 * Design §4.3 says to dedup "the same floor pressed again within 250ms". **This deliberately does not**,
 * for two reasons that only became clear during implementation:
 *   ① Not needed: `startRun` synchronously switches phase to closing, so the second click lands in the
 *      `closing` branch with the same target floor → naturally idempotent and only one trip anyway (a unit
 *      test pins this down);
 *   ② Harmful: dedup would have to remember "last pressed floor + time", and the sequence below would hit
 *      it —— press 4F (starts a trip) → 50ms later press 1F to undo (back to idle) → 100ms later press 4F
 *      again: it lands inside the 250ms window, and dedup would swallow this **genuine re-press**, making
 *      the user feel "pressed and nothing happened".
 */
export async function request(id) {
  const store = useSessionStore();
  motionMode.value = readMode();

  // A floor not installed (greyed out / :disabled) is unreachable; the elevator does not go to a floor that cannot be pressed
  const floor = store.floors.find((f) => f.id === id);
  if (!floor || !floor.installed) return;

  // Zero-animation tier: no animation, switch directly (effort §4-5). The in-flight trip must be invalidated ——
  // otherwise it comes back and changes the floor once more
  if (motionMode.value === 'off') {
    abortRun();
    store.selectFloor(id);
    return;
  }

  armWatchdog();

  if (id === currentFloor.value) {
    // Pressing the current floor mid-close = undo. The face change has not happened yet (committed=false), so
    // the content does not need rolling back
    if (phase.value === 'closing' && !committed) return cancelRun();
    return; // already on this floor / already heading to it: nothing happens
  }

  // Degraded tier: no elevator, just one 40ms fade out → face change → 40ms fade in (80ms total; design §5.1
  // requires <100ms). Not falling to off is intentional: the system preference says "move less", not "no
  // feedback", and a hard cut is ugly in another way.
  if (motionMode.value === 'reduced') {
    abortRun();
    const my = ++token;
    flash.value = true;
    if (!(await step(my, FLASH_MS))) {
      flash.value = false;
      return;
    }
    store.selectFloor(id);
    flash.value = false;
    return;
  }

  if (phase.value === 'idle') return startRun(id, store);

  /* Everything below is the interrupt policy for phase !== 'idle' */

  if (phase.value === 'closing') {
    targetFloor.value = id; // the door keeps closing, only the destination changes (restarting the close would flicker)
    return;
  }

  if (phase.value === 'moving') {
    if (id === targetFloor.value) return; // pressing the floor about to be reached: ignore
    pendingTarget.value = id; // reservation: reverse on arrival (a real elevator also has to pass this floor before it can go back)
    return;
  }

  // opening / settling: the only preemptible boundary —— close again before the door is fully open, crisper than queuing ~380ms
  return startRun(id, store);
}

/**
 * Singleton exit. Everything returned is the same ref —— each call does not create new state.
 * (App.vue takes phase / motionMode / request; FloorSelector takes carFloor / displayFloor / moveMs; the
 *  lintel screen (TaskTicker) does not take floors —— it scrolls each floor's tasks and does not care which
 *  floor it is on.)
 */
export function useElevator() {
  return {
    phase,
    targetFloor,
    pendingTarget,
    currentFloor,
    displayFloor,
    carFloor,
    pendingFloor,
    direction,
    moveMs,
    motionMode,
    /** The degraded tier's fade-out/in switch (ElevatorDoors attaches it to data-flash) */
    flash,
    request,
    settleElevator,
  };
}
