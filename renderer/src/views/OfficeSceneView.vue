<script setup>
/**
 * OfficeSceneView —— full-screen immersive office scene.
 *
 * Layers (back → front, larger y is closer to the camera):
 *   1 bg      back wall / windows / floor / carpet / partitions / chairs / meeting room interior / coffee counter / print area
 *   2 seated  sprites sitting at a workstation or in the meeting room (the desk covers the lower body = the "seated" effect)
 *   3 fg      desks / monitors / meeting table / glass (drawn over the seated layer)
 *   4 walkers walking sprites (always frontmost)
 *   5 tags    overhead status tags + selection ring
 *
 * Behavior: by default each gremlin sits at its own workstation, then randomly gets up to go to the coffee room / print / visit a neighbor / wander;
 * when 2 or more members are blocked they automatically go to the meeting room (and return to their workstation after recovering); meetings can also be called manually.
 * Movement follows the officeLayout corridor graph (BFS shortest path) and never walks through desks.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import GremlinSprite from '../components/GremlinSprite.vue';
import GhostSprite from '../components/GhostSprite.vue';
import WorkstationCard from '../components/WorkstationCard.vue';
import { useProjectStore } from '../stores/project';
import { useSessionStore } from '../stores/sessions';
import { useDemoStore } from '../stores/demo';
import { isEphemeralMember, projectLabelOf } from '../lib/ephemeral';
import { floorAcceptsClient } from '../lib/clientMatch';
import { memberForSession, normalizeState } from '../lib/memberTask';
import { useI18n } from '../i18n';

const { t } = useI18n();
import {
  DESKS,
  GHOST,
  GHOST_SCALE,
  GRAPH_POINTS,
  LOUNGE,
  MEETING,
  PLACES,
  SCENE,
  SPRITE_SCALE,
  WINDOWS,
  route,
} from '../scene/officeLayout';

const props = defineProps({
  selectedId: { type: String, default: '' },
});
const emit = defineEmits(['select']);

const project = useProjectStore();
const sessions = useSessionStore();
const demo = useDemoStore();
/** Demo owns only the office roster; task records / messages keep reading the real project. */
const sourceMembers = computed(() => (demo.active ? demo.members : project.members));

const wrapRef = ref(null);
const svgRef = ref(null);

const STATE_COLOR = {
  busy: '#f5a623',
  idle: '#7f8c9b',
  blocked: '#ff5c5c',
};
/** Three workstation states -> i18n keys (shared by the legend and the overhead tags) */
const STATE_KEY = {
  busy: 'state.busy',
  idle: 'state.idle',
  blocked: 'state.blocked',
};
const stateText = (s) => t(STATE_KEY[normalizeState(s)]);

/* ------------------------------ Members → Workstations ------------------------------ */

/** Expert team: resident members, one workstation each (ephemeral members take no workstation).
 *  The main Agent (role=agent) only shows up as a silhouette at the main console and takes no workstation, so it is dropped from the roster. */
const roster = computed(() =>
  sourceMembers.value
    .filter((m) => !isEphemeralMember(m) && m.role !== 'agent')
    .filter((m) => floorAcceptsClient(sessions.selectedClient, m.client))
    .slice(0, DESKS.length)
);
/** Ephemeral team members + members that do not fit at a workstation: no workstation, they float in mid-air */
const ghostRoster = computed(() => {
  const seated = new Set(roster.value.map((m) => m.memberId));
  const sid = sessions.selectedSessionId;
  return sourceMembers.value
    .filter((m) => !seated.has(m.memberId))
    .filter((m) => floorAcceptsClient(sessions.selectedClient, m.client))
    .filter((m) => !isEphemeralMember(m) || !sid || !m.sessionId || m.sessionId === sid);
});
const memberOf = computed(() => {
  const m = new Map();
  sourceMembers.value.forEach((x) => m.set(x.memberId, memberForSession(x, sessions.selectedSessionId, sourceMembers.value)));
  return m;
});

const agents = ref([]);

function makeAgent(member, index) {
  const seat = DESKS[index].seat;
  return {
    memberId: member.memberId,
    home: index,
    seat,
    x: seat.x,
    y: seat.y,
    facing: 1,
    mode: 'sit',
    moving: false,
    inMeeting: false,
    path: [],
    pi: 0,
    dwell: 0,
    pendingMode: 'sit',
    pendingDwell: 0,
    nextThink: Date.now() + 4000 + Math.random() * 14000,
  };
}

watch(
  roster,
  (list) => {
    const ids = new Set(list.map((m) => m.memberId));
    agents.value = agents.value.filter((a) => ids.has(a.memberId));
    list.forEach((m, i) => {
      let a = agents.value.find((x) => x.memberId === m.memberId);
      if (!a) {
        a = makeAgent(m, i);
        agents.value.push(a);
      }
      a.home = i;
      a.seat = DESKS[i].seat;
    });
  },
  { immediate: true }
);

/* ------------------------------ Ephemeral members (ghosts) ------------------------------ */

const ghosts = ref([]);

function makeGhost(member, i) {
  const anchor = GHOST.anchors[i % GHOST.anchors.length];
  return {
    memberId: member.memberId,
    anchor,
    x: anchor.x,
    y: anchor.y,
    baseY: anchor.y,
    /** Float phase: offset each one so they do not bob up and down in unison */
    phase: Math.random() * Math.PI * 2,
    speed: 46 + Math.random() * 26,
    target: null,
    hold: Date.now() + 1500 + Math.random() * 4000,
    inMeeting: false,
  };
}

watch(
  ghostRoster,
  (list) => {
    const ids = new Set(list.map((m) => m.memberId));
    ghosts.value = ghosts.value.filter((g) => ids.has(g.memberId));
    list.forEach((m, i) => {
      if (!ghosts.value.some((g) => g.memberId === m.memberId)) ghosts.value.push(makeGhost(m, i));
    });
  },
  { immediate: true }
);

const stateOf = (a) => normalizeState((memberOf.value.get(a.memberId) || {}).state);

/* ------------------------------ Movement ------------------------------ */

const SPEED = 240; // scene units per second

function goTo(a, to, mode, dwellMs = 0) {
  a.path = route({ x: a.x, y: a.y }, to);
  a.pi = 0;
  a.pendingMode = mode;
  a.pendingDwell = dwellMs;
}

function goHome(a) {
  goTo(a, a.seat, 'sit');
}

const WANDER = [
  { x: 370, y: 430 },
  { x: 1020, y: 430 },
  { x: 670, y: 830 },
  { x: 30, y: 195 },
  { x: 1020, y: 195 },
];

/** Randomly get up: coffee room / print / visit a neighbor / wander */
function pickActivity(a) {
  const r = Math.random();
  if (r < 0.32) {
    goTo(a, PLACES.coffee, 'coffee', 6000 + Math.random() * 8000);
  } else if (r < 0.52) {
    goTo(a, PLACES.printer, 'print', 4000 + Math.random() * 6000);
  } else if (r < 0.78) {
    const other = agents.value[(a.home + 1 + Math.floor(Math.random() * 2)) % agents.value.length];
    if (other && other !== a) {
      const row = DESKS[other.home].row;
      goTo(a, { x: other.seat.x, y: row === 'A' ? 195 : 430 }, 'chat', 5000 + Math.random() * 6000);
    }
  } else {
    goTo(a, WANDER[Math.floor(Math.random() * WANDER.length)], 'walk', 3000 + Math.random() * 4000);
  }
}

let raf = 0;
let last = 0;

function frame(t) {
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  const now = Date.now();

  for (const a of agents.value) {
    if (a.path.length && a.pi < a.path.length) {
      let budget = SPEED * dt;
      while (budget > 0 && a.pi < a.path.length) {
        const tgt = a.path[a.pi];
        const dx = tgt.x - a.x;
        const dy = tgt.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d <= budget || d < 0.5) {
          a.x = tgt.x;
          a.y = tgt.y;
          budget -= d;
          a.pi += 1;
        } else {
          if (Math.abs(dx) > 0.5) a.facing = dx > 0 ? 1 : -1;
          a.x += (dx / d) * budget;
          a.y += (dy / d) * budget;
          budget = 0;
        }
      }
      a.moving = true;
      if (a.pi >= a.path.length) {
        a.path = [];
        a.moving = false;
        a.mode = a.pendingMode || 'sit';
        a.dwell = a.pendingDwell ? now + a.pendingDwell : 0;
      }
    } else {
      a.moving = false;
      if (!a.inMeeting && a.dwell && now >= a.dwell) {
        a.dwell = 0;
        goHome(a);
      }
    }

    if (a.mode === 'sit' && !a.path.length && !a.inMeeting && now >= a.nextThink) {
      a.nextThink = now + 8000 + Math.random() * 16000;
      if (Math.random() < 0.6) pickActivity(a);
    }
  }

  // Ghosts: skip the corridor graph, drift slowly between two hover anchors and bob up and down the whole time
  for (const g of ghosts.value) {
    if (g.target) {
      const dx = g.target.x - g.x;
      const dy = g.target.y - g.baseY;
      const d = Math.hypot(dx, dy);
      const step = g.speed * dt;
      if (d <= step || d < 0.5) {
        g.x = g.target.x;
        g.baseY = g.target.y;
        g.target = null;
        g.hold = now + 6000 + Math.random() * 9000;
      } else {
        g.x += (dx / d) * step;
        g.baseY += (dy / d) * step;
      }
    } else if (!g.inMeeting && now >= g.hold) {
      const pool = GHOST.anchors.filter((p) => p !== g.anchor);
      g.anchor = pool[Math.floor(Math.random() * pool.length)];
      g.target = g.anchor;
    }
    g.y = g.baseY + Math.sin(now / 780 + g.phase) * 7;
  }

  updateCardPos();
  raf = requestAnimationFrame(frame);
}

/* ------------------------------ Meeting ------------------------------ */

const manualMeeting = ref(false);
const blockedIds = computed(() =>
  [...memberOf.value.values()].filter((m) => m.state === 'blocked' && !isEphemeralMember(m)).map((m) => m.memberId)
);

function startMeeting(ids) {
  let k = 0;
  agents.value.forEach((a) => {
    if (!ids.includes(a.memberId)) return;
    a.inMeeting = true;
    a.dwell = 0;
    goTo(a, MEETING.seats[k % MEETING.seats.length], 'meet');
    k += 1;
  });
  // Ephemeral members have no seat, so they hover above the meeting room to listen in
  ghosts.value.forEach((g) => {
    g.inMeeting = true;
    g.target = GHOST.meeting;
  });
}

function endMeeting() {
  agents.value.forEach((a) => {
    if (!a.inMeeting) return;
    a.inMeeting = false;
    a.dwell = 0;
    goHome(a);
  });
  ghosts.value.forEach((g) => {
    if (!g.inMeeting) return;
    g.inMeeting = false;
    g.target = g.anchor;
  });
}

watch(blockedIds, (ids) => {
  if (ids.length >= 2) startMeeting(ids);
  else if (!manualMeeting.value) endMeeting();
});

function callAll() {
  manualMeeting.value = true;
  startMeeting(agents.value.map((a) => a.memberId));
}

function dismiss() {
  manualMeeting.value = false;
  endMeeting();
}

const meetingCount = computed(() => agents.value.filter((a) => a.inMeeting).length);

/* ------------------------------ Overhead status tags ------------------------------ */

const ACTIVITY_KEY = {
  coffee: 'scene.activity.coffee',
  print: 'scene.activity.print',
  chat: 'scene.activity.chat',
  walk: 'scene.activity.walk',
  meet: 'scene.activity.meet',
};
const activityText = (m) => (ACTIVITY_KEY[m] ? t(ACTIVITY_KEY[m]) : '');

function tagText(a) {
  if (a.mode === 'meet') return t('tag.meeting');
  if (a.moving) return a.pendingMode && activityText(a.pendingMode) ? t('scene.going', { place: activityText(a.pendingMode) }) : t('scene.walking');
  if (a.dwell && activityText(a.mode)) return activityText(a.mode);
  return stateText(stateOf(a));
}

/** Above a ghost: the project name takes priority (ephemeral members are pulled in for a specific project) */
function ghostTagText(g) {
  if (g.inMeeting) return t('tag.attending');
  const proj = projectLabelOf(memberOf.value.get(g.memberId));
  return t('scene.temp', { x: proj || stateText(stateOf(g)) });
}

function tagWidth(text) {
  let w = 0;
  for (const ch of text) w += /[一-龥]/.test(ch) ? 15 : 8.4;
  return Math.round(w + 28);
}

const tagY = (a) => a.y - 92;

/* ------------------------------ Click → Task card ------------------------------ */

const card = ref(null);

function toPixels(x, y) {
  const svg = svgRef.value;
  const wrap = wrapRef.value;
  if (!svg || !wrap) return { x: 0, y: 0 };
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = svg.createSVGPoint();
  p.x = x;
  p.y = y;
  const sp = p.matrixTransform(ctm);
  const r = wrap.getBoundingClientRect();
  return { x: sp.x - r.left, y: sp.y - r.top };
}

/** The card follows the sprite/ghost */
function updateCardPos() {
  if (!card.value || !wrapRef.value) return;
  const a = agents.value.concat(ghosts.value).find((x) => x.memberId === card.value.memberId);
  if (!a) return;
  const p = toPixels(a.x, a.y - 96);
  const w = wrapRef.value.clientWidth || 800;
  card.value.left = Math.round(Math.max(170, Math.min(w - 170, p.x)));
  card.value.top = Math.round(Math.max(8, p.y));
}

function openCard(a, ev) {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  emit('select', a.memberId);
  card.value = { memberId: a.memberId, left: 0, top: 0 };
  updateCardPos();
}

const cardMember = computed(() => (card.value ? memberOf.value.get(card.value.memberId) : null));
function closeCard() {
  card.value = null;
}

/* ------------------------------ Desk screens (abstract UI) ------------------------------ */

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const deskScreens = computed(() =>
  DESKS.map((d, i) => {
    const m = roster.value[i];
    const seed = hash(m ? m.memberId : d.id);
    return {
      color: STATE_COLOR[normalizeState(m && m.state)],
      lines: [0, 1, 2].map((k) => 30 + ((seed >> (k * 3)) % 55)),
      // The crawl bar on the screen does **not** draw progress (progress was dropped on 2026-09-29): task.progress only has 0/1
      // two values (0 when work starts, 1 when it ends, and nobody advances it in between — see the "progress" row in TaskRecordsView),
      // so a length drawn from it would forever be an empty or full bar. Here we only check whether work is in progress and let the light band crawl by itself (see .scr-crawl in the template).
      running: Boolean(m && m.state === 'busy'),
    };
  })
);

function deskMemberId(i) {
  const m = roster.value[i];
  return m ? m.memberId : '';
}

const showGraph = ref(false);

onMounted(() => {
  last = performance.now();
  raf = requestAnimationFrame(frame);
});
onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>

<template>
  <div ref="wrapRef" class="scene-wrap" @click="closeCard">
    <svg ref="svgRef" class="scene" :viewBox="`0 0 ${SCENE.w} ${SCENE.h}`" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="night" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#16233d" />
          <stop offset="100%" stop-color="#0b1020" />
        </linearGradient>
      </defs>

      <!-- ============ 1. Background ============ -->
      <g class="bg">
        <rect x="0" y="0" :width="SCENE.w" height="153" fill="#1b2029" />
        <g v-for="(w, i) in WINDOWS" :key="`win${i}`">
          <rect :x="w.x - 4" :y="w.y - 4" :width="w.w + 8" :height="w.h + 8" rx="3" fill="#232a36" />
          <rect :x="w.x" :y="w.y" :width="w.w" :height="w.h" fill="#101827" />
          <rect :x="w.x" :y="w.y" :width="w.w" :height="w.h" fill="url(#night)" opacity="0.85" />
          <circle v-for="k in 5" :key="k" :cx="w.x + 30 + k * 42" :cy="w.y + 24 + ((k * 17) % 40)" r="1.8" fill="#8fb6ff" opacity="0.5" />
          <line :x1="w.x + w.w / 2" :y1="w.y" :x2="w.x + w.w / 2" :y2="w.y + w.h" stroke="#232a36" stroke-width="3" />
        </g>
        <rect x="0" y="145" :width="SCENE.w" height="8" fill="#151922" />

        <rect x="0" y="153" :width="SCENE.w" :height="SCENE.h - 153" fill="#23262e" />
        <g opacity="0.05">
          <line v-for="y in 12" :key="`pl${y}`" x1="0" :y1="153 + y * 62" :x2="SCENE.w" :y2="153 + y * 62" stroke="#fff" stroke-width="1" />
        </g>
        <rect x="40" y="186" width="1020" height="474" rx="14" fill="#262c37" />
        <rect x="40" y="186" width="1020" height="474" rx="14" fill="none" stroke="#2f3745" stroke-width="2" />

        <!-- Partitions + chairs (sprites are drawn on top of them) -->
        <g v-for="d in DESKS" :key="`p${d.id}`">
          <rect :x="d.rail.x" :y="d.rail.y" :width="d.rail.w" :height="d.rail.h" rx="3.5" fill="#3c4658" />
          <rect :x="d.partition.x" :y="d.partition.y" :width="d.partition.w" :height="d.partition.h" rx="4" fill="#2a3241" />
          <g opacity="0.06">
            <line v-for="k in 5" :key="k" :x1="d.partition.x + 20 + k * 44" :y1="d.partition.y + 4" :x2="d.partition.x + 20 + k * 44" :y2="d.partition.y + d.partition.h - 4" stroke="#fff" stroke-width="2" />
          </g>
          <rect :x="d.note.x" :y="d.note.y" :width="d.note.w" :height="d.note.h" rx="1.5" fill="#f2c94c" opacity="0.9" :transform="`rotate(-7 ${d.note.x + 7} ${d.note.y + 7})`" />
          <rect :x="d.chair.x" :y="d.chair.y" :width="d.chair.w" :height="d.chair.h" rx="16" fill="#333c4b" />
          <rect :x="d.chairInner.x" :y="d.chairInner.y" :width="d.chairInner.w" :height="d.chairInner.h" rx="12" fill="#3d4757" />
        </g>

        <!-- Meeting room interior -->
        <g class="room">
          <rect :x="MEETING.x" :y="MEETING.y" :width="MEETING.w" :height="MEETING.h" fill="#1e242e" />
          <rect :x="MEETING.x" :y="MEETING.y" :width="MEETING.w" height="6" fill="#2b3341" />
          <rect :x="MEETING.whiteboard.x - 4" :y="MEETING.whiteboard.y - 4" :width="MEETING.whiteboard.w + 8" :height="MEETING.whiteboard.h + 8" rx="4" fill="#39414f" />
          <rect :x="MEETING.whiteboard.x" :y="MEETING.whiteboard.y" :width="MEETING.whiteboard.w" :height="MEETING.whiteboard.h" fill="#dfe6ef" />
          <g stroke="#7d8ea6" stroke-width="2" opacity="0.8">
            <path :d="`M${MEETING.whiteboard.x + 18} ${MEETING.whiteboard.y + 26}h${MEETING.whiteboard.w - 60}`" />
            <path :d="`M${MEETING.whiteboard.x + 18} ${MEETING.whiteboard.y + 46}h${MEETING.whiteboard.w - 110}`" />
            <path :d="`M${MEETING.whiteboard.x + 18} ${MEETING.whiteboard.y + 66}h${MEETING.whiteboard.w - 80}`" />
          </g>
          <g stroke="#4c8dff" stroke-width="2.4" fill="none">
            <rect :x="MEETING.whiteboard.x + 170" :y="MEETING.whiteboard.y + 14" width="56" height="34" rx="4" />
            <path :d="`M${MEETING.whiteboard.x + 182} ${MEETING.whiteboard.y + 40}l12-16 12 16`" />
          </g>
          <circle :cx="MEETING.clock.cx" :cy="MEETING.clock.cy" :r="MEETING.clock.r" fill="#2b3341" stroke="#4a5568" stroke-width="3" />
          <path :d="`M${MEETING.clock.cx} ${MEETING.clock.cy} v-9 M${MEETING.clock.cx} ${MEETING.clock.cy} l6 4`" stroke="#9aa3b2" stroke-width="2" stroke-linecap="round" />
          <g v-for="(s, i) in MEETING.seats" :key="`mc${i}`">
            <rect :x="s.x - 30" :y="s.y - 92" width="60" height="52" rx="14" fill="#333c4b" />
            <rect :x="s.x - 23" :y="s.y - 84" width="46" height="38" rx="11" fill="#3d4757" />
          </g>
        </g>

        <!-- Front area: coffee counter / print / water cooler / plants -->
        <g class="lounge">
          <rect :x="LOUNGE.counter.x" :y="LOUNGE.counter.y" :width="LOUNGE.counter.w" :height="LOUNGE.counter.h" fill="#39414f" />
          <rect :x="LOUNGE.counterTop.x" :y="LOUNGE.counterTop.y" :width="LOUNGE.counterTop.w" :height="LOUNGE.counterTop.h" rx="3" fill="#4d5768" />
          <rect :x="LOUNGE.machine.x" :y="LOUNGE.machine.y" :width="LOUNGE.machine.w" :height="LOUNGE.machine.h" rx="4" fill="#2b3140" />
          <rect :x="LOUNGE.machine.x + 12" :y="LOUNGE.machine.y + 10" width="36" height="14" rx="3" fill="#0f1319" />
          <rect :x="LOUNGE.machine.x + 20" :y="LOUNGE.machine.y + 30" width="20" height="8" rx="2" fill="#6b7688" />
          <rect v-for="(c, i) in LOUNGE.cups" :key="`cup${i}`" :x="c.x" :y="c.y" :width="c.w" :height="c.h" rx="2" fill="#e6ebf2" />

          <rect :x="LOUNGE.printer.x" :y="LOUNGE.printer.y" :width="LOUNGE.printer.w" :height="LOUNGE.printer.h" rx="6" fill="#39414f" />
          <rect :x="LOUNGE.printer.x + 16" :y="LOUNGE.printer.y + 12" width="98" height="18" rx="3" fill="#2b3140" />
          <rect :x="LOUNGE.printer.x + 26" :y="LOUNGE.printer.y + 34" width="78" height="30" rx="2" fill="#e6ebf2" />

          <rect :x="LOUNGE.cooler.x" :y="LOUNGE.cooler.y" :width="LOUNGE.cooler.w" :height="LOUNGE.cooler.h" rx="6" fill="#39414f" />
          <rect :x="LOUNGE.cooler.x + 10" :y="LOUNGE.cooler.y - 42" width="40" height="46" rx="14" fill="#5aa9e6" opacity="0.85" />

          <g v-for="(p, i) in LOUNGE.plants" :key="`pl${i}`" :transform="`translate(${p.x} ${p.y}) scale(${p.s})`">
            <polygon points="-16,0 16,0 12,32 -12,32" fill="#b3653f" />
            <ellipse cx="0" cy="-14" rx="17" ry="20" fill="#3f7f52" />
            <ellipse cx="-11" cy="-6" rx="9" ry="13" fill="#4f9e63" transform="rotate(-24 -11 -6)" />
            <ellipse cx="11" cy="-8" rx="9" ry="13" fill="#4f9e63" transform="rotate(22 11 -8)" />
          </g>
        </g>
      </g>

      <!-- ============ 2. Seated sprites (lower body hidden behind the desk) ============ -->
      <g class="seated">
        <g
          v-for="a in agents.filter((x) => !x.moving)"
          :key="`s${a.memberId}`"
          class="sprite"
          :transform="`translate(${a.x} ${a.y}) scale(${a.facing * SPRITE_SCALE} ${SPRITE_SCALE}) translate(-32 -51)`"
          @click.stop="openCard(a, $event)"
        >
          <rect x="-32" y="-46" width="64" height="54" fill="transparent" />
          <GremlinSprite :name="a.memberId" :state="stateOf(a)" :walking="false" />
        </g>
      </g>

      <!-- ============ 3. Foreground furniture ============ -->
      <g class="fg">
        <g
          v-for="(d, i) in DESKS"
          :key="`d${d.id}`"
          class="desk"
          @click.stop="deskMemberId(i) && emit('select', deskMemberId(i))"
        >
          <polygon v-for="(leg, k) in d.legs" :key="k" :points="leg" fill="#3a2d21" />
          <polygon :points="d.deskTop" fill="#6d5540" />
          <rect :x="d.deskFront.x" :y="d.deskFront.y" :width="d.deskFront.w" :height="d.deskFront.h" fill="#4c3b2c" />

          <ellipse :cx="d.monitor.base.cx" :cy="d.monitor.base.cy" :rx="d.monitor.base.rx" :ry="d.monitor.base.ry" fill="#202735" />
          <rect :x="d.monitor.neck.x" :y="d.monitor.neck.y" :width="d.monitor.neck.w" :height="d.monitor.neck.h" fill="#2b3441" />
          <rect :x="d.monitor.bezel.x" :y="d.monitor.bezel.y" :width="d.monitor.bezel.w" :height="d.monitor.bezel.h" rx="4" fill="#171c26" stroke="#2b3341" stroke-width="1.5" />
          <rect :x="d.monitor.screen.x" :y="d.monitor.screen.y" :width="d.monitor.screen.w" :height="d.monitor.screen.h" fill="#0a0d13" />
          <rect :x="d.monitor.screen.x" :y="d.monitor.screen.y" :width="d.monitor.screen.w" height="5" :fill="deskScreens[i].color" />
          <rect
            v-for="(lw, k) in deskScreens[i].lines"
            :key="`l${k}`"
            :x="d.monitor.screen.x + 8"
            :y="d.monitor.screen.y + 12 + k * 7"
            :width="lw"
            height="3"
            rx="1.5"
            :fill="k === 1 ? '#6fa8ff' : '#5b6779'"
            opacity="0.9"
          />
          <rect :x="d.monitor.screen.x + 8" :y="d.monitor.screen.y + 32" :width="d.monitor.screen.w - 16" height="3" rx="1.5" fill="#232c3a" />
          <!-- Bottom crawl bar: the light band always takes up 30% of the track and crawls from left to right in a loop (indeterminate, it does not mean progress).
               The 1.8s period matches the main console, see the ph.busy part in iso/mainConsole.js. -->
          <rect
            v-if="deskScreens[i].running"
            class="scr-crawl"
            :x="d.monitor.screen.x + 8"
            :y="d.monitor.screen.y + 32"
            :width="(d.monitor.screen.w - 16) * 0.3"
            height="3"
            rx="1.5"
            fill="#4c8dff"
          />
          <circle :cx="d.monitor.led.cx" :cy="d.monitor.led.cy" :r="d.monitor.led.r" :fill="deskScreens[i].color" />

          <polygon :points="d.keyboard" fill="#2a3240" stroke="#3a4557" stroke-width="1" />
          <polygon v-for="(r, k) in d.keyRows" :key="`kb${k}`" :points="r" fill="#7f8ea6" opacity="0.5" />
          <ellipse :cx="d.mouse.cx" :cy="d.mouse.cy" :rx="d.mouse.rx" :ry="d.mouse.ry" fill="#cfd6e2" />
          <rect :x="d.mug.x" :y="d.mug.y" :width="d.mug.w" :height="d.mug.h" rx="3" fill="#e6ebf2" />
        </g>

        <!-- Meeting table -->
        <rect :x="MEETING.table.x" :y="MEETING.table.y" :width="MEETING.table.w" :height="MEETING.table.h" :rx="MEETING.table.rx" fill="#6d5540" />
        <rect :x="MEETING.table.x + 14" :y="MEETING.table.y + 14" :width="MEETING.table.w - 28" :height="MEETING.table.h - 28" :rx="MEETING.table.rx - 14" fill="none" stroke="#5a4534" stroke-width="3" />
        <ellipse :cx="MEETING.table.x + MEETING.table.w / 2" :cy="MEETING.table.y + MEETING.table.h / 2" rx="30" ry="12" fill="#5a4534" opacity="0.6" />

        <!-- Glass (drawn over the sprites → you see into the room through the glass) -->
        <g class="glass">
          <rect :x="MEETING.glassLeft.x" :y="MEETING.glassLeft.y" :width="MEETING.glassLeft.w" :height="MEETING.glassLeft.h" fill="#7fb0ff" opacity="0.13" />
          <rect :x="MEETING.wallRight.x" :y="MEETING.wallRight.y" :width="MEETING.wallRight.w" :height="MEETING.wallRight.h" fill="#39414f" />
          <rect :x="MEETING.glassFront.x" :y="MEETING.glassFront.y" :width="MEETING.doorGap.x - MEETING.glassFront.x" :height="MEETING.glassFront.h" fill="#7fb0ff" opacity="0.13" />
          <rect
            :x="MEETING.doorGap.x + MEETING.doorGap.w"
            :y="MEETING.glassFront.y"
            :width="MEETING.glassFront.x + MEETING.glassFront.w - (MEETING.doorGap.x + MEETING.doorGap.w)"
            :height="MEETING.glassFront.h"
            fill="#7fb0ff"
            opacity="0.13"
          />
          <rect :x="MEETING.glassLeft.x" :y="MEETING.glassLeft.y" :width="MEETING.wallRight.x + MEETING.wallRight.w - MEETING.glassLeft.x" :height="MEETING.glassLeft.h" fill="none" stroke="#4a5568" stroke-width="2" />
        </g>
        <text :x="MEETING.x + MEETING.w / 2" :y="MEETING.glassFront.y - 14" class="room-label" text-anchor="middle">{{ t('wall.meeting_room') }}</text>
      </g>

      <!-- ============ 4. Walking sprites ============ -->
      <g class="walkers">
        <g
          v-for="a in agents.filter((x) => x.moving)"
          :key="`w${a.memberId}`"
          class="sprite"
          :transform="`translate(${a.x} ${a.y}) scale(${a.facing * SPRITE_SCALE} ${SPRITE_SCALE}) translate(-32 -51)`"
          @click.stop="openCard(a, $event)"
        >
          <rect x="-32" y="-46" width="64" height="54" fill="transparent" />
          <GremlinSprite :name="a.memberId" :state="stateOf(a)" :walking="true" />
        </g>
      </g>

      <!-- ============ 4.5 Ephemeral members (ghosts): no workstation, they float in mid-air ============ -->
      <g class="ghosts">
        <g v-for="g in ghosts" :key="`g${g.memberId}`">
          <ellipse class="hover-glow" :cx="g.x" :cy="g.y + 44" rx="27" ry="7" />
          <g
            class="sprite ghost-sprite"
            :transform="`translate(${g.x} ${g.y}) scale(${GHOST_SCALE}) translate(-32 -51)`"
            @click.stop="openCard(g, $event)"
          >
            <rect x="-32" y="-50" width="64" height="62" fill="transparent" />
            <GhostSprite :name="g.memberId" :state="stateOf(g)" />
          </g>
        </g>
      </g>

      <!-- ============ 5. Overhead status + selection ring ============ -->
      <g class="tags">
        <g v-for="a in agents" :key="`t${a.memberId}`">
          <ellipse v-if="selectedId === a.memberId" :cx="a.x" :cy="a.y" rx="38" ry="10" class="sel-ring" />
          <g :transform="`translate(${a.x} ${tagY(a)})`" class="tag" @click.stop="openCard(a, $event)">
            <rect :x="-tagWidth(tagText(a)) / 2" y="-22" :width="tagWidth(tagText(a))" height="22" rx="11" fill="#12161d" stroke="#333b4a" />
            <circle :cx="-tagWidth(tagText(a)) / 2 + 12" cy="-11" r="4" :fill="STATE_COLOR[stateOf(a)]" />
            <text :x="-tagWidth(tagText(a)) / 2 + 21" y="-6" class="tag-text">{{ tagText(a) }}</text>
          </g>
        </g>

        <!-- Ghosts: dashed tags that name the owning project -->
        <g v-for="g in ghosts" :key="`gt${g.memberId}`">
          <ellipse v-if="selectedId === g.memberId" :cx="g.x" :cy="g.y" rx="34" ry="9" class="sel-ring" />
          <g :transform="`translate(${g.x} ${g.y - 92})`" class="tag" @click.stop="openCard(g, $event)">
            <rect
              :x="-tagWidth(ghostTagText(g)) / 2"
              y="-22"
              :width="tagWidth(ghostTagText(g))"
              height="22"
              rx="11"
              fill="#12161d"
              :stroke="STATE_COLOR[stateOf(g)]"
              stroke-dasharray="4 3"
            />
            <circle :cx="-tagWidth(ghostTagText(g)) / 2 + 12" cy="-11" r="4" :fill="STATE_COLOR[stateOf(g)]" />
            <text :x="-tagWidth(ghostTagText(g)) / 2 + 21" y="-6" class="tag-text">{{ ghostTagText(g) }}</text>
          </g>
        </g>
      </g>

      <g v-if="showGraph" class="graph">
        <circle v-for="(p, k) in GRAPH_POINTS" :key="k" :cx="p.x" :cy="p.y" r="4" fill="#4c8dff" opacity="0.7" />
      </g>
    </svg>

    <!-- Task card (follows the sprite) -->
    <div
      v-if="card && cardMember"
      class="card-layer"
      :style="{ left: `${card.left}px`, top: `${card.top}px` }"
      @click.stop
    >
      <WorkstationCard :member="cardMember" :members="sourceMembers" :session-id="sessions.selectedSessionId" />
      <button class="card-close" @click="closeCard">{{ t('records.delete_cancel') }}</button>
    </div>

    <!-- HUD -->
    <div class="hud" @click.stop>
      <span v-for="(key, s) in STATE_KEY" :key="s" class="legend">
        <i class="dot" :style="{ background: STATE_COLOR[s] }" />{{ t(key) }}
      </span>
      <span class="legend"><i class="dot ghost-dot" />{{ t('tag.temp_member') }}</span>
      <span class="sep" />
      <button @click="callAll">{{ t('office.meeting') }}</button>
      <button @click="dismiss">{{ t('office.back_to_desk') }}</button>
      <button @click="showGraph = !showGraph">{{ t('office.graph') }}</button>
      <span v-if="meetingCount" class="meeting-tip">{{ t('scene.meeting_count', { n: meetingCount }) }}</span>
    </div>
  </div>
</template>

<style scoped>
.scene-wrap {
  position: relative;
  height: 100%;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: #1b2029;
}

.scene {
  width: 100%;
  height: 100%;
  display: block;
}

.sprite {
  cursor: pointer;
}

.tag {
  cursor: pointer;
}

.tag-text {
  font-size: 14px;
  fill: var(--text);
  font-family: inherit;
}

.room-label {
  font-size: 16px;
  fill: var(--text-faint);
  letter-spacing: 0.2em;
}

.sel-ring {
  fill: none;
  stroke: var(--accent);
  stroke-width: 3;
  opacity: 0.9;
}

.desk {
  cursor: pointer;
}

/* Task card */
.card-layer {
  position: absolute;
  transform: translate(-50%, -100%);
  width: 320px;
  z-index: 5;
  filter: drop-shadow(0 8px 24px rgba(0, 0, 0, 0.5));
}

.card-close {
  margin-top: 6px;
  width: 100%;
}

/* HUD */
.hud {
  position: absolute;
  right: 10px;
  top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(12, 15, 20, 0.82);
  border: 1px solid var(--border);
  font-size: 12px;
  z-index: 4;
}

.legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-dim);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

/* Ephemeral members: hollow dashed circle (mirrors the dashed outline of the ghost) */
.ghost-dot {
  background: transparent;
  border: 1px dashed #8fe0f5;
}

/* Ghost hover glow: it floats in mid-air, so only a faint shadow is left below */
.hover-glow {
  fill: #9fe8ff;
  opacity: 0.07;
}

.sep {
  width: 1px;
  height: 16px;
  background: var(--border-strong);
}

.meeting-tip {
  color: var(--accent);
}

/* The crawl bar on the monitor: the light band crawls from left to right, one loop every 1.8s (same period as the main console mainConsole).
   The translate amount is measured against the width of the light band: -100% = fully slid off the left, 333% ≈ fully slid off the right (30% × 3.33 ≈ 100%). */
.scr-crawl {
  /* transform-box: fill-box —— must be set explicitly: the initial value for SVG elements is view-box,
     which would make translateX(-100%) use the whole canvas width and send the light band right off-screen. */
  transform-box: fill-box;
  animation: scr-crawl-x 1.8s linear infinite;
}
@keyframes scr-crawl-x {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(333%);
  }
}

/* A light band that signals "running" through motion alone would, with the animation off, be left as a fixed-length segment read as "30% progress" ——
   better to draw nothing at all than to show fake progress. */
@media (prefers-reduced-motion: reduce) {
  .scr-crawl {
    display: none;
  }
}
</style>
