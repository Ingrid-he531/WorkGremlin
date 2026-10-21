<script setup>
/**
 * TaskTicker — the **long screen** on the lintel: a scrolling ticker of the current task on every
 * floor (reworked 2026-10-08).
 *
 * The previous version (FloorLcd) was a "floor indicator": it answered "which floor are we on /
 * which floor are we heading to". The whole screen is now a task stream instead:
 *   · **the current floor is no longer shown** — the floor already appears in the capsule on the
 *     left (FloorSelector) and inside the car, so repeating it on the screen is useless;
 *   · the screen is **as long as possible**: the project name on the lintel takes only its own bit
 *     of width, and the rest all goes to this screen (see the layout in ElevatorDoors);
 *   · content = the tasks **running on every floor** (running), scrolling infinitely one after
 *     another; when a task finishes / is cancelled, its result line **scrolls past once** and then
 *     leaves (no looping), after which only the in-progress tasks remain; when there are none, "no
 *     active tasks" is shown centered. The server returns "still running + finished in the last few
 *     minutes", see /api/v1/task-feed.
 *
 * Three hard constraints (carried over from FloorLcd):
 *   1. Single source of truth: every entry comes from the server's tasks table
 *      (/api/v1/task-feed), and this component **does not infer task state**;
 *      the floor number is looked up by reverse-checking task.client against sessions.floors, not a
 *      separate floor table built here;
 *   2. Only transform is touched: the scroll is written by a JS rAF loop each frame as
 *      `translateX(offset)`, with offset accumulating continuously; width / left / top are never
 *      touched; this way adding or removing content (especially an ended line) does not make an
 *      already half-scrolled position jump;
 *   3. Segmented conveyor belt: the track is a series of "segments" (a snapshot of one pass of the
 *      content), entering from the far right and scrolling left; a segment is recycled once it
 *      scrolls off the left edge, and a new one is appended at the right end — between two passes
 *      there is only a 5s run (5s counted from **the last character of the previous pass entering
 *      the screen**, at which point the first character of the next pass enters the screen, see
 *      GAP_MS), not "wait 5s after the whole thing has scrolled off the left edge".
 *      An ended line enters **one** segment only (it is gone once scrolled off, and the screen
 *      never shows several copies of it at once); once the segment has scrolled past and there are
 *      no other tasks, the track is empty → the screen goes back to "no active tasks". A segment is
 *      a snapshot, so adding or removing tasks does not make the text on screen jump.
 *
 * Accessibility: the scrolling segment code is noise to a screen reader → the screen itself is
 * aria-hidden, and a separate sr-only static text is provided.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useSessionStore } from '../stores/sessions';
import { colorsFor } from '../iso/officeMap';
import { shade } from '../iso/iso';
import { PHASES } from '../iso/mainConsole';
import { useI18n } from '../i18n';
import { agentBase } from '@workgremlin/shared';
import { httpBase, getServerInfo } from '../api/bridge';

const { t } = useI18n();
const sessions = useSessionStore();

/**
 * The **single source of truth** for the ticker: the server's /api/v1/task-feed (see
 * server/src/http/routes/query.js). It lists the tasks table directly by taskId and returns each
 * task's { id, title, started_at, ended_at, client, state }. The server includes a running task only
 * while its session is active, and permanently hides tasks cancelled by orphan reconciliation. The
 * component therefore performs no floor deduplication or session-liveness inference of its own; each
 * active task is shown separately. client is reverse-looked up to a floor number here.
 */
const feed = ref([]);
let feedTimer = null;
async function loadFeed() {
  try {
    const info = await getServerInfo();
    const headers = info && info.token ? { Authorization: `Bearer ${info.token}` } : undefined;
    const res = await fetch(`${httpBase(info)}/api/v1/task-feed?minutes=5`, { headers });
    const data = await res.json();
    if (data && data.ok && Array.isArray(data.items)) {
      feed.value = data.items;
      detectEnded();
    }
  } catch {
    /* If it cannot be fetched, keep the previous copy rather than flashing the screen empty */
  }
}

/**
 * The window (minutes) during which a finished task is still "visible": the server returns the
 * "just finished" ones within this window, and this component picks out the end notices to announce
 * from them. An announcement scrolls only once (see detectEnded: an ended line is removed once it
 * scrolls off the left edge); the window only decides which just-finished tasks can be caught, and
 * does not affect "once ended, never looped again".
 */
const END_KEEP_MIN = 5;
/** Scroll speed (px/s): a 1200px screen takes about 17s per pass, readable without dragging */
const SPEED_PX_S = 70;
/** Each task line occupies exactly one screen width. A long task is cut by the ellipsis on its
 *  **task text** (true width, so CJK/ASCII are both exact), while the trailing phase suffix
 *  ("(thinking)/(calling tools)/…/(task complete)/(task cancelled)") is kept and a short task leaves the rest of
 *  its screen-wide box blank — every line is one screen long and the spacing is uniform. */

/** Ended tasks already announced (not scrolled again within this session): done/cancelled/failed scroll only once */
const announcedIds = new Set();
/**
 * The **segments** on the track (one pass of content): a segment is a **snapshot** fixed at creation
 * time; it is recycled once it scrolls off the left edge, and a new segment is appended at the right
 * end. This change was made because "ended lines scroll only once" and "multiple copies filling the
 * screen" conflict — when one pass of content is rendered N times, the same "task complete" would
 * sit on screen N times at once (measured scrolling out 4~5 passes). After switching to segmented
 * snapshots:
 *   · an ended line enters **one segment** only (see makeSeg), so it appears exactly once from start
 *     to finish and is gone once it scrolls off;
 *   · newly started / finished tasks only affect segments generated **after** them; text already on
 *     screen is neither changed nor made to jump.
 */
const segs = ref([]);
/** Ended lines waiting to be announced: they go into the next appended segment with it (once only), and are cleared as soon as they do */
const pendingEnded = ref([]);
/** Dirty flag for segment-width / screen-width measurement: re-measure after segments change or the window or screen width changes */
let segsDirty = true;
/** The freshly appended segment has not been measured yet (while set, stop appending, so one frame does not append several segments) */
let freshSeg = false;
/** Segment id sequence */
let segSeq = 0;
/** This session's start time: only announce tasks finished after it, never replay history (to avoid a pile of "task complete" lines scrolling on startup) */
const sessionStart = Date.now();

/**
 * A task line's trailing **phase suffix**: text = the main Agent's current phase (i18n `phase.*`),
 * colour = the phase colour (`PHASES[phase].color`, the same map the console uses). The surrounding
 * brackets come from i18n (`suffixOpen` / `suffixClose`) so zh/en punctuation stays right.
 */
const wrapSuffix = (label) => (label ? `${t('ticker.suffixOpen')}${label}${t('ticker.suffixClose')}` : '');
const phaseColorOf = (ph) => (PHASES[ph] || PHASES.idle).color;

/**
 * A task's current main-Agent phase: join the feed row's `sessionId` against the sessions snapshot
 * (the same truth the console / session dropdown use) and read its `phase`. Returns '' when it cannot
 * be resolved (legacy rows without a session id, or the session has been dropped) — never guess a phase.
 */
function phaseOfTask(it) {
  const sid = String((it && it.sessionId) || '');
  if (!sid) return '';
  const s = (sessions.sessions || []).find((x) => String((x && x.sessionId) || '') === sid);
  const ph = String((s && s.phase) || '');
  return PHASES[ph] ? ph : '';
}

/**
 * Phases that mean "the main Agent is actively working". Anything else (idle / unreported / a stale
 * done · cancelled / an unresolved session) is **not** shown for a running task.
 */
const WORKING_PHASES = new Set(['thinking', 'tool', 'await', 'dispatch', 'waiting']);

/**
 * The phase shown on a **running** task line. A task that is already on the track must never read
 * "(idle)" (nor "(unreported)" / a stale "(task complete)") — it is visibly running, so the least it
 * can be is "(thinking)".
 * So: use the resolved session phase when it is an active-work phase, otherwise fall back to thinking.
 */
function runningPhaseOfTask(it) {
  const ph = phaseOfTask(it);
  return WORKING_PHASES.has(ph) ? ph : 'thinking';
}

/**
 * A line's trailing suffix, resolved **at render time**.
 *
 * Ended lines keep the suffix baked when they entered the track (done / cancelled is terminal and must
 * never change). **Live** running lines are resolved from the session snapshot on every render, so the
 * phase tracks the agent within the store's poll window.
 *
 * Why it cannot be baked into the line: a line only lives inside a scroll **segment**, and a segment is
 * an immutable snapshot (fixed at creation, not changed until it scrolls off). A screen-wide segment
 * lasts ~20-30s (screen width at 70px/s), so baking sampled the phase only once per segment — a few
 * seconds of "tool" was almost never caught and the line read "thinking" nearly always. The store poll
 * is 5s, so live is the only way it stays honest.
 */
const lineSuffix = (it) =>
  it.live ? wrapSuffix(t(`phase.${runningPhaseOfTask(it)}`)) : it.suffix || '';
const lineSuffixColor = (it) => (it.live ? phaseColorOf(runningPhaseOfTask(it)) : it.suffixColor);

/**
 * An ended task's line: reuse the **same wording it scrolled with** (time floor task: prompt) and append
 * the phase suffix "(task complete)/(task cancelled)" — same wording and colour as the phase scheme (done green,
 * cancelled/failed red). It scrolls exactly once (see pendingEnded → makeSeg) and then leaves the track.
 */
function endedText(it) {
  const floor = floorLabelForClient(it.client);
  const base = promptOf(it.title || '') || t('ticker.untitled');
  const done = it.state === 'done';
  const suffix = wrapSuffix(done ? t('ticker.done') : t('ticker.cancelled'));
  const suffixColor = done ? PHASES.done.color : PHASES.cancelled.color;
  const taskLabel = t('ticker.taskLabel');
  const taskText = clip(base);
  const time = hhmm(it.ended_at);
  return {
    id: `${it.id}:${it.state}`,
    kind: 'running',
    time,
    floor,
    taskLabel,
    taskText,
    floorColor: shade(colorsFor(floor).wood, 1.6),
    text: `${time} ${floor} ${taskLabel}${taskText}`,
    suffix,
    suffixColor,
  };
}

/** Pick the tasks that "finished after this session started" from all sessions of all projects and
 *  queue their ended lines into pendingEnded — they enter the next appended segment with it and
 *  **scroll only once**. Tasks already finished before startup are not replayed (to avoid a pile of
 *  "task complete" lines scrolling on startup); announcedIds prevents announcing the same task
 *  twice. The end criterion uses the server-side unified taskState (see the per-session taskState
 *  computed in the server's sessionRegistry snapshot), the same source of truth as the lintel and
 *  main console, no longer computed separately. */
function detectEnded() {
  let added = false;
  for (const it of feed.value) {
    // Only announce tasks finished "after this session started", to avoid a pile of "task complete" lines scrolling on startup
    if ((it.state === 'done' || it.state === 'cancelled' || it.state === 'failed') && Number(it.ended_at) >= sessionStart) {
      if (announcedIds.has(it.id)) continue;
      announcedIds.add(it.id);
      pendingEnded.value = pendingEnded.value.concat(endedText(it));
      added = true;
      if (typeof console !== 'undefined' && console.debug) {
        console.debug('[TaskTicker] 检测到结束任务:', {
          id: it.id,
          state: it.state,
          title: String(it.title || '').slice(0, 40),
          endedAt: it.ended_at ? new Date(it.ended_at).toISOString() : null,
        });
      }
    }
  }
  // The screen is already empty (there were no tasks) but there is something to announce: append a segment immediately, don't wait for the next poll
  if (added && segs.value.length === 0) pushSeg();
}

/** Ended lines are picked out by detectEnded, triggered by loadFeed (polling /api/v1/task-feed); no longer dependent on the session snapshot */


/** HH:mm (the screen wants a segment-display feel, only hours and minutes; the date belongs to the task records page) */
function hhmm(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '--:--';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * The "user's own words" inside a task title.
 * Same rules as promptOf in TaskRecordsView: old data stored the whole IDE-injected
 * `# Context from my IDE setup` block as the title, and the hook no longer stores it that way, but
 * historical rows are still in the database — without stripping it once, what scrolls on screen is a
 * whole screen of IDE context.
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

/** No truncation: keep the full user prompt extracted by promptOf (see the MAX_LEN note at the top). */
const clip = (s) => s;

/**
 * client (agent base name, e.g. codebuddy / traecode) → floor number (1F / 3F …).
 * Same floors source as the capsule and the car: take the client's agent base name and look it up in
 * floors[].clients, and show the id (1F) of whichever floor matches. When it cannot be found (floors
 * not loaded yet / an old database without client), fall back to the base name itself.
 */
function floorLabelForClient(client) {
  const base = agentBase(client);
  const f = (sessions.floors || []).find(
    (x) => Array.isArray(x.clients) && x.clients.some((c) => agentBase(c) === base)
  );
  return f ? f.id || f.name || base : base || client || '—';
}

/**
 * In-progress tasks (state === 'running' in the feed): the permanent content of the infinite scroll
 * loop. Taken directly from /api/v1/task-feed, each task on its own line, **no longer deduplicated by
 * floor**. The server has already filtered out tasks outside active sessions, so this only projects
 * the valid running rows into display lines.
 */
const runningItems = computed(() => {
  return feed.value
    .filter((it) => it.state === 'running')
    .map((it) => {
      const floor = floorLabelForClient(it.client);
      const text = promptOf(it.title || '') || t('ticker.untitled');
      const taskLabel = t('ticker.taskLabel');
      const taskText = clip(text);
      // The time is the task's actual start time (tasks.started_at), no longer the "current time"
      const time = hhmm(it.started_at);
      // Live phase suffix: what this task's main Agent is doing right now (thinking / calling tools /
      // waiting for authorization …), with the colour following the phase colour (the same PHASES as
      // the main console). **A running task never shows "idle"**: it is already scrolling on screen,
      // so the least it can be is "thinking" (see runningPhaseOfTask)
      const phase = runningPhaseOfTask(it);
      return {
        id: it.id,
        kind: 'running',
        // Marks a **live** running line (ended lines also use kind:'running', see endedText). The render
        // layer resolves its suffix from the session snapshot on every render (see lineSuffix) instead of
        // freezing it into the scroll segment at creation time.
        live: true,
        sessionId: it.sessionId,
        time,
        floor,
        taskLabel,
        taskText,
        floorColor: shade(colorsFor(floor).wood, 1.6),
        text: `${time} ${floor} ${taskLabel}${taskText}`,
        suffix: wrapSuffix(t(`phase.${phase}`)),
        suffixColor: phaseColorOf(phase),
        startedAt: Number(it.started_at) || 0,
      };
    })
    .sort((a, b) => a.startedAt - b.startedAt);
});

/**
 * The condition for showing the static centered line: **there is no segment on the track at all, and
 * there is truly nothing to scroll** (no running task and no ended line waiting to be announced).
 * Judging by "track is empty" alone will not do — right when a new task appears the track is also
 * empty, and that is when scrolling is about to start (the track must be rendered first so tick can
 * append segments to it).
 */
const idle = computed(
  () => segs.value.length === 0 && runningItems.value.length === 0 && pendingEnded.value.length === 0
);

/** Screen-reader text: the scrolling segment code on screen is noise to AT, so a static line is provided here */
const srText = computed(() =>
  [...runningItems.value, ...pendingEnded.value].map((i) => `${i.text}${i.suffix || ''}`).join('；')
);

/* ------------------------------ Scrolling (JS rAF · segmented conveyor belt) ------------------------------
 * The track is a series of **segments** (one pass of content), each ending with a gap; a segment is
 * recycled once it scrolls off the left edge, and a new segment is appended at the right end at any
 * time.
 *   · A segment is a snapshot: its content is fixed at creation and not changed until it scrolls
 *     away. So newly started / finished tasks only affect segments generated **after** them, and the
 *     text currently scrolling on screen is neither changed nor made to jump position.
 *   · The interval GAP_MS: the gap at the end of a segment = the run of GAP_MS, so 5s counted from
 *     "the last character of the previous pass entering the screen", at which point the first
 *     character of the next pass enters from the right — the screen keeps scrolling and never sits
 *     still waiting.
 *   · An ended line scrolls only once: it is generated with **one segment** only (pendingEnded is
 *     cleared as it enters the segment in makeSeg), so the screen never shows several copies at once
 *     and it is gone once it scrolls off; when there are no other tasks after it, the track is empty
 *     → "no active tasks" is shown. */

const viewEl = ref(null);
const trackEl = ref(null);
/** Screen visible width (px) */
const viewW = ref(0);
/** System "reduce motion": no scrolling, laid out statically */
const reduce = ref(false);
let ro = null;
let raf = null;
let lastTs = 0;
let offset = 0;
/** Total width of all segments on the track (px, including trailing gaps): used to decide appending / recycling */
let trackW = 0;
/**
 * The interval between two passes (ms): counted **from the last character of the previous pass
 * entering from the right** until the first character of the next pass enters from the right.
 * Not "wait still for 5s after the whole thing scrolls off" — that would make the real interval =
 * remaining scroll distance + 5s, and a reader would feel it waits too long. The screen scrolls
 * continuously, so this interval is just "the stretch of run left blank between characters" (gapPx),
 * with no pause where the screen sits empty and still.
 */
const GAP_MS = 5000;
/** Line spacing = the CSS .line padding-right (48px), already counted into each measured width; it must be subtracted when computing the trailing gap, otherwise the interval gains this extra stretch */
const LINE_GAP_PX = 48;
/** Trailing gap (px): interval time × speed − the line's own trailing padding, making "last character enters screen → GAP_MS → next segment enters screen" hold exactly */
const gapPx = () => Math.max(0, (GAP_MS / 1000) * SPEED_PX_S - LINE_GAP_PX);

/** Build one segment: the currently running tasks + the ended lines waiting to be announced (an ended line is cleared as it enters, so it belongs to this segment only) */
function makeSeg() {
  const lines = runningItems.value.map((it) => ({ ...it }));
  if (pendingEnded.value.length) {
    lines.push(...pendingEnded.value);
    pendingEnded.value = [];
  }
  return { id: `seg-${(segSeq += 1)}`, lines, w: 0 };
}

/** Append a segment at the right end: called only when it should be appended (see tick); when it is appended it is still off the right of the screen, invisible */
function pushSeg() {
  if (segs.value.length === 0) offset = viewW.value || 600; // From empty to non-empty: enter from the far right
  segs.value.push(makeSeg());
  freshSeg = true;
  segsDirty = true;
}

/** Re-measure the screen width + each segment's width (write back to segs[i].w / viewW / trackW) */
function measureSegs() {
  if (viewEl.value) viewW.value = viewEl.value.clientWidth;
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
  if (i >= segs.value.length) freshSeg = false; // All segments measured, so appending may continue
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
    // Recycle: once the leftmost segment has fully scrolled off the left edge, drop it and move offset right by its width — the following segments stay put, no jump
    let head = segs.value[0];
    while (head && head.w > 0 && offset + head.w <= 0) {
      offset += head.w;
      trackW -= head.w;
      segs.value.shift();
      segsDirty = true;
      head = segs.value[0];
    }
  }
  // Append: once the right end of the track has come into the screen, append another segment
  // (appended off the right of the screen, invisible). If there is no content to append (neither a
  // running task nor an ended line waiting to be announced), do not append — the remaining segments
  // scroll past and the screen goes back to "no active tasks".
  const hasContent = runningItems.value.length > 0 || pendingEnded.value.length > 0;
  // +4 is a lead margin: append **before** the right end of the track comes into the screen, so the new segment enters from off-screen and does not pop into the screen out of nowhere
  if (!freshSeg && hasContent && offset + trackW <= viewW.value + 4) pushSeg();
  el.style.transform = `translateX(${offset}px)`;
  raf = requestAnimationFrame(tick);
}

onMounted(async () => {
  // The ticker's data is fetched by its own polling (see loadFeed), decoupled from the session snapshot
  loadFeed();
  feedTimer = setInterval(loadFeed, 3000);
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
    else if (mq.addListener) mq.addListener(onChange); // Old Safari
  }
  raf = requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
  if (ro) ro.disconnect();
  ro = null;
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  if (feedTimer) clearInterval(feedTimer);
  feedTimer = null;
});
</script>

<template>
  <div class="ticker">
    <!-- Static label at the left of the screen: explains what this screen scrolls (tasks from all floors); it **does not take part in the scroll** -->
    <span class="tag">{{ t('ticker.tag') }}</span>
    <div ref="viewEl" class="screen" :style="{ '--screen-w': (viewW > 0 ? viewW : 100000) + 'px' }">
      <!-- No tasks: a static centered line, no scrolling -->
      <span v-if="idle" class="idle-line">{{ t('ticker.no_task') }}</span>
      <!-- Has content: the scrolling segment code does not enter the accessibility tree; a screen reader
           reads the .sr below. The track is a series of segments (one pass of content), each ending with a
           --loop-gap gap; a segment scrolling off the left is recycled and a new one is appended at the
           right. An ended line enters only one of the segments, so "task complete" appears exactly once
           from start to finish and is gone once it scrolls off. The offset is driven by JS rAF. -->
      <div
        v-else
        ref="trackEl"
        class="track"
        :class="{ static: reduce }"
        :style="{ '--loop-gap': `${gapPx()}px` }"
        aria-hidden="true"
      >
        <!-- Under reduce motion it is laid out statically, showing only one segment (several segments just look like the same line repeating) -->
        <span v-for="s in (reduce ? segs.slice(0, 1) : segs)" :key="s.id" class="seg">
        <span v-for="it in s.lines" :key="it.id" class="line" :class="`k-${it.kind}`" :style="{ '--floor-color': it.floorColor }"><span class="time">{{ it.time }}</span>&nbsp;<span class="floor">{{ it.floor }}</span>&nbsp;<span class="task-label">{{ it.taskLabel }}</span><span class="task-text">{{ it.taskText }}</span><span v-if="lineSuffix(it)" class="suf" :style="{ color: lineSuffixColor(it) }">{{ lineSuffix(it) }}</span></span>
        </span>
      </div>
      <span class="scan" aria-hidden="true" />
    </div>
    <p class="sr" role="status" aria-live="polite">{{ srText }}</p>
  </div>
</template>

<style scoped>
/* One column in the lintel: the label takes its own width and the rest **all goes to this screen** (the screen as long as possible, see ElevatorDoors) */
.ticker {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Static label at the left of the screen: it makes clear what this screen scrolls. It does not scroll
   and does not widen with the content. Plain text only; do not give it an outline / background — a
   border plus a background looks like a button that cannot be clicked, which it is not. */
.tag {
  flex: none;
  display: flex;
  align-items: center;
  height: calc(var(--lcd-slot, 26px) + 16px); /* Same height as the screen, so the two boxes line up top and bottom */
  padding: 0 8px 0 2px;
  font-size: 12px;
  letter-spacing: 1px;
  white-space: nowrap;
  color: var(--text-dim, #9aa3b2);
}

/* Screen shell: dark background + crisp type, height reusing the LCD slot (--lcd-slot) */
.screen {
  position: relative;
  flex: 1 1 auto; /* The rest of the lintel's width all goes to the screen; the label takes only its own bit */
  min-width: 0;
  display: flex;
  align-items: center;
  /* The track is anchored to the left edge: translateX(offset) runs from viewW (entering at the far
     right) all the way to -period (one pass done and wrapped), so even content narrower than the screen
     scrolls flush to the left edge instead of stopping centered (otherwise "short content never reaches
     the far left and gets stuck in the middle") */
  justify-content: flex-start;
  height: calc(var(--lcd-slot, 26px) + 16px);
  overflow: hidden;
  border: 1px solid var(--border-strong, #333b4a);
  border-radius: var(--radius, 10px);
  background: var(--lcd-bg, #05070a);
  box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.75);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif;
}

/* Scanlines: a static background (not animated); the feel comes from "having a grid" rather than "flashing" */
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

/* Track: the conveyor belt itself, laid out with several .seg in a row; the offset is written directly as transform by JS rAF, with no CSS animation attached */
.track {
  display: flex;
  flex: none;
}

/* One segment (a whole pass of content): its trailing gap = --loop-gap (= the run of GAP_MS − the
   line's own trailing padding); that is the blank between "the last character of the previous pass"
   and "the first character of the next pass" — the interval is determined by it, see GAP_MS */
.seg {
  display: flex;
  flex: none;
  padding-right: var(--loop-gap, 302px);
}

.line {
  display: flex;
  align-items: center;
  flex: none;
  box-sizing: border-box;
  /* One task line occupies exactly one screen: `width` (not `max-width`) with no flex-grow leaves the
     rest of a short task's box blank, while a long task is cut by the ellipsis on `.task-text` only.
     The trailing status word (`.suf`) is `flex: none`, so "(done)/(cancelled)" is never pushed out. */
  width: var(--screen-w, 100%);
  overflow: hidden;
  /* Gap between entries: one line finishes scrolling before the next follows, so two lines are not stuck together */
  padding-right: 48px;
  white-space: nowrap;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 0.5px;
  /* Line body colour = the floor desktop's wood tone (the dot, time, floor number and "task:" label
     all inherit it); when no floor colour is set, fall back to the running blue */
  color: var(--floor-color, var(--accent, #4c8dff));
}

/* The prefixes (time / floor / "task:" label) and the trailing phase suffix always render in full:
   only the **task prompt** (.task-text) may be ellipsised (flex-shrink + min-width:0 + ellipsis). So the
   suffix ("(thinking)/(task complete)…") always stays visible right after the prompt and is never pushed off
   screen by a long title — that was the root cause of the "ended line shows ... but no status word" bug. */
.line .time,
.line .floor,
.line .task-label,
.line .suf {
  flex: none;
}
.line .task-text {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The leading dot takes the line's own colour (--floor-color, the floor's wood tone), so one glance
   tells you which floor a line belongs to. The trailing phase suffix carries its own phase colour. */
.line::before {
  content: '';
  display: inline-block;
  vertical-align: middle;
  width: 7px;
  height: 7px;
  margin-right: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}

/* Per-part colouring within a line:
   · dot / time / floor number (xF) / "task:" label / task prompt → all use the floor desktop's wood
     tone (--floor-color, colorsFor(floor).wood), the same colour as that floor's desks and chairs in
     the office, so you can tell at a glance which floor a task belongs to;
   · the status word at the end of an ended line (.suf) → green/red, coloured independently. */
.line .time,
.line .floor,
.line .task-label,
.line .task-text {
  color: var(--floor-color);
  text-shadow: 0 0 6px currentColor;
}

/* The line body colour comes from --floor-color (see .line); the k-* classes are kept for future
   whole-line status colouring. The trailing phase suffix (.suf) carries its own phase colour,
   independent of the line body. */

/* Trailing phase suffix: the colour is written inline by JS from the phase colour (the `color` of
   `.suf`, see PHASES); this rule only handles the glow. The phase colours are the same set as the main
   console: thinking yellow / calling tools blue / waiting for authorization orange / task complete
   green / task cancelled red. */
.suf {
  flex: none;
  text-shadow: 0 0 6px currentColor;
}

/* No tasks: static centered (the track uses flex-start flush left; this line is centered alone with auto), one notch brighter than a "dim segment" */
.idle-line {
  margin: 0 auto;
  padding: 0 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 1px;
  white-space: nowrap;
  color: var(--text-dim, #9aa3b2);
}

/* System "reduce motion": no scrolling, and the JS side fixes offset at 0 (see tick); the track has no
   CSS animation anyway, so there is nothing to disable here. */

/* The segment code on screen does not enter the accessibility tree (see aria-hidden in the template); this line is the alternative text for AT */
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
