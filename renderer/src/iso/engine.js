/**
 * engine.js —— rendering and behavior engine for the isometric office (pure Canvas 2D).
 *
 * One frame goes through:
 *   1. Background (floor/carpet/wall/window) -> offscreen cache, redrawn only when the camera changes
 *   2. "Static furniture" and "characters" mixed together, sorted by depth = x + y, then drawn in order
 *      —— so a desk naturally hides the lower half of the person sitting behind it; that is the "2.5D"
 *   3. Overhead tags drawn on a separate screen-space layer (not scaled, always crisp)
 */

import {
  AX,
  AY,
  AZ,
  UNIT_Z,
  project,
  depthOf,
  poly,
  isoBox,
  isoCylinder,
  isoShadow,
  isoDiamond,
  groundEllipse,
  wallQuad,
  shade,
  rgba,
  roundRectPath,
} from './iso';
import {
  ROOM,
  colorsFor,
  WALL,
  DESK_UNITS,
  DIVIDERS,
  MEETING,
  MEETING_SEATS,
  PANTRY,
  PANTRY_SEATS,
  PLANTS,
  PLACES,
  NAV_NODES,
  CONSOLE,
  route,
} from './officeMap';
import { drawGremlin, drawGhost, drawTag, colorOf, propOf, SPRITE_UNITS } from './sprites';
import { PHASES, drawConsoleDesk, drawConsoleScreen, drawOperator } from './mainConsole';
// Text on the canvas (nameplates, bubbles, wall signs) also goes through i18n: redrawn every frame, so it reads the current language
import { t } from '../i18n/index.js';

const STATE_COLOR = {
  busy: '#f5a623',
  idle: '#7f8c9b',
  blocked: '#ff5c5c',
};
const STATE_SUCCESS = '#2ecc71';
/** Metal color of the magnet pin on the divider sticky note (metal part, does not change per floor).
 *  The note paper and ink colors are not hardcoded here —— they use this floor's palette colors.note / colors.noteInk (see officeMap's FLOOR_COLORS). */
const MAGNET = '#c3ccda';
/** Badge level colors (matching the badge on the gremlin's neck): user=blue, project=green, others (demo/normal)=gray */
const LEVEL_COLOR = { user: '#3b82f6', project: '#22c55e' };
const levelColor = (level) => LEVEL_COLOR[level] || '#7c8aa5';
/**
 * Public status badge has three buckets: blocked / busy / idle. Unknown values normalize to idle.
 */
const bucketOf = (s) => (s === 'blocked' ? 'blocked' : s === 'busy' ? 'busy' : 'idle');
/** What it is actually doing while busy (only decides walking/pinning to seat; the overhead tag no longer shows details) */
const WORK_KEYS = ['think', 'code', 'doc'];
const hashOf = (s) => {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
};
/** Assigned deterministically by id, so it does not jump around on every refresh */
const workOf = (id) => WORK_KEYS[hashOf(id) % WORK_KEYS.length];

/** Height (tile): a person is ~1.55 floor tiles */
const SPRITE_H = 1.55;
/** Walk speed (tile/s) */
const SPEED = 2.1;

/** Ghost hover anchors (world coordinates + height) */
const GHOST_SPOTS = [
  { x: 3.5, y: 1.6, z: 2.05 },
  { x: 8.0, y: 1.5, z: 2.2 },
  { x: 12.2, y: 1.7, z: 1.95 },
  { x: 5.2, y: 5.4, z: 2.15 },
  { x: 10.4, y: 5.4, z: 1.9 },
  { x: 2.2, y: 9.4, z: 2.2 },
];
// The ghost's "staying in the meeting room" hover spot (shifted 0.4 together with the whole right block's move, still above the meeting table)
const GHOST_MEET = { x: 17.4, y: 3.6, z: 2.25 };

/**
 * Overhead hover (a summoned instance whose name matches a seated gremlin) drifts around that
 * gremlin's workstation. Same-name instances share a seat, so each instance is given its own lane
 * around the seat (see seatFanOffset) — otherwise they would all sit on one point and read as a
 * single ghost. The wander radii are the per-ghost activity range inside its lane (the whole
 * overhead area grows with the group size).
 */
const SEAT_FAN_DX = 2.4; // tiles: lane spacing between same-name instances around one seat (world x)
const SEAT_FAN_DY = 1.0; // tiles: depth stagger between neighbouring lanes (world y)
const SEAT_WANDER_RX = 1.6; // tiles: per-ghost wander radius along world x
const SEAT_WANDER_RY = 1.1; // tiles: per-ghost wander radius along world y
const SEAT_WANDER_RZ = 0.5; // tiles: per-ghost vertical bob range

/**
 * Lane offset for the slot-th same-name overhead ghost of one gremlin.
 * Slot 0 stays directly above the head; the rest alternate left/right in lanes of SEAT_FAN_DX, with a
 * small depth stagger so neighbouring lanes do not sit on one line.
 * @param {number} slot 0-based index within the same-name group
 * @returns {{x:number, y:number}} world-space offset from the seat
 */
function seatFanOffset(slot) {
  if (!slot) return { x: 0, y: 0 };
  const dir = slot % 2 === 1 ? 1 : -1;
  const lane = Math.ceil(slot / 2);
  return {
    x: dir * lane * SEAT_FAN_DX,
    y: (slot % 2 === 1 ? -1 : 1) * SEAT_FAN_DY,
  };
}

/** Pick-up dialogue: the main console hands over the task and the gremlin answers, in place. Seconds. */
const DISPATCH_TALK = 3.6;
/** Finish report: the gremlin says its result summary in place. Seconds. No walk back to the console. */
const REPORT_TALK = 3.4;
/**
 * How long the ghost "works" after it appears, before the report plays (ms).
 *
 * When the task is very fast (the subagent finishes almost as soon as it is summoned), pick-up and
 * report would land on the same instant — the viewer never sees the ghost appear and be busy, it
 * just pops up and reports. A short hold keeps one summon a complete arc:
 * pick up task -> ghost appears (busy) -> report -> wrap up.
 */
const REPORT_MIN_WORK = 1500;
/**
 * Ghost entry:
 *   - **Belongs to a gremlin** (a summoned instance whose name matches a seated gremlin) -> **appears
 *     directly above that gremlin's head**; it does not detour through the door. The point of a summon
 *     is "the gremlin picks up the task in place and the ghost appears on its head at the same time";
 *     going through the door would lag by a beat.
 *   - **Standalone ghost** (no matching gremlin, e.g. the demo's temporary members) -> drifts in from
 *     outside the door. That stretch (gx < 0) is hidden by the wall and only visible through the door
 *     opening, so "drifts in" really means it appears at the doorway, not out of thin air on its spot.
 *
 * Standalone ghosts start one by one only after **every gremlin is inside** (nobody still waiting to
 * appear, nobody stuck in the doorway) — so the demo's opening is "gremlins walk in and sit, then
 * ghosts drift in through the door".
 */
const GHOST_ENTRY_SPEED = 1.9; // tile/s: outside-door -> hover spot (faster than idle drift, or it takes ages)
const GHOST_ENTRY_STAGGER = 420; // ms: same batch leaves one at a time, not piled up at the door
const GHOST_ENTRY_SETTLE = 280; // ms: a beat after the gremlins are in, so the two rhythms read apart
const GHOST_ENTRY_WAIT_MAX = 5000; // ms: fallback for waiting on gremlins (a summon interrupts entry; never lock a ghost outside forever)
/**
 * Entry: available gremlins come in one by one through the front door and walk to their seat.
 * Busy gremlins are already working, so they appear seated when the floor is opened.
 * @property {number} ENTER_DELAY wait before the first one appears (let the scene light up first)
 * @property {number} ENTER_STAGGER how long between two adjacent ones (ms)
 */
const ENTER_DELAY = 400;
const ENTER_STAGGER = 480;
/**
 * Door open/close: push the door open before a gremlin appears, and it closes on its own after the last one is inside.
 * @property {number} DOOR_LEAD how early to start opening the door (ms) —— door moves first, person arrives after
 * @property {number} DOOR_SWING duration of one open / close swing (s)
 * @property {number} DOOR_LINGER after the last one is in, how much longer the door holds before closing (ms)
 */
const DOOR_LEAD = 420;
const DOOR_SWING = 0.42;
const DOOR_LINGER = 900;
/** Angle the door leaf opens to (degrees): just past 90°, so the door reads as "open and resting against it", not poking straight out */
const DOOR_OPEN_DEG = 96;
/** Open/close easing: slow at both ends, fast in the middle (the door has weight, it does not swing at constant speed) */
const smooth = (t) => t * t * (3 - 2 * t);
/** Reaching this gx counts as "inside": the doorway is at gx=0, at +0.55 the whole body is past the inner side of the door */
const DOOR_INSIDE_X = 0.55;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Sign bitmap cache: the same text is rendered once (tags now get redrawn in the sort layer, cannot make a canvas every frame) */
const WALL_TEXT_CACHE = new Map();

/* ------------------------------ Summon/report state persisted across instances ------------------------------
 * The office view (IsoOfficeView) is a route-level component: switching to "workstation card" / "conversation log" and back
 * unmounts/remounts it, and createIsoOffice makes a new instance. If these groups of state lived inside the instance,
 * on switching back it would think "this ghost was never summoned", so a gremlin already sent out to work would run up to the main agent
 * again and replay the "pick up task" dialogue.
 *
 * These states are recorded per ghost memberId. Transient orchestration state is cleared when the ghost leaves
 * the roster; the dispatched-task ledger survives cross-floor roster changes and uses the task identity to
 * recognize a genuinely new summon.
 */
/** Ghost memberIds registered as "summoned" */
const summonedGhostIds = new Set();
/**
 * Ghost memberId -> dispatched task identity. This must survive a floor switch: leaving
 * the floor hides the ghost from this engine's roster, but it does not start a new summon.
 */
const dispatchedGhostTasks = new Map();
/** Ghost memberIds hidden during orchestration first */
const pendingGhostIds = new Set();
/** Pending ghosts "seen at least once" (fallback for waiting on the task name) */
const pendingSeenOnce = new Set();
/** Ghost memberId -> { agentId, name, color, task, result }: the report can finish even after the ghost disperses */
const ghostMeta = new Map();
/** Report only once per summon round */
const reportedGhostIds = new Set();
/** The gremlin's most recent completed result: agent memberId -> { task, result, at } (tooltip / workstation card look-back) */
const lastResults = new Map();

/**
 * Render "rounded plate background + text" onto an offscreen canvas (horizontal, high-res), for skew-mounting onto a wall.
 * Plate background + text go into the same bitmap; after the skew mount the whole thing deforms with the wall parallelogram, as if really hung on the wall.
 */

function makeWallText(text) {
  const key = String(text);
  const cached = WALL_TEXT_CACHE.get(key);
  if (cached) return cached;
  const fontPx = 30;
  const padX = 16;
  const padY = 10;
  const font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  const off = document.createElement('canvas');
  let g = off.getContext('2d');
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + padX * 2;
  const h = fontPx + padY * 2;
  off.width = w;
  off.height = h;
  // Changing width/height clears the context, so get it again
  g = off.getContext('2d');
  g.font = font;
  // Plate background (rounded dark + blue border)
  roundRectPath(g, 0.75, 0.75, w - 1.5, h - 1.5, 10);
  g.fillStyle = 'rgba(18,24,34,0.82)';
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = 'rgba(127,176,255,0.55)';
  g.stroke();
  // Text: near-white, with shadow to stay legible over the busy backdrop
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 4;
  g.fillStyle = '#eaf1fb';
  g.fillText(text, w / 2, h / 2 + 1);
  WALL_TEXT_CACHE.set(key, off);
  return off;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{onSelect?: (id: string) => void, floor?: string}} [opts]
 *   floor: current floor id (e.g. '1F' / '3F' / '5F'). Used to pick this floor's material palette (see officeMap's colorsFor),
 *   and can later be switched at runtime with setFloor().
 */
export function createIsoOffice(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const onSelect = opts.onSelect || (() => {});
  /** This floor's palette: material tokens that change per floor (dividers / metal / wood), the rest follows the base */
  let colors = colorsFor(opts.floor);
  let floorId = opts.floor || '';

  let W = 0;
  let H = 0;
  let dpr = 1;
  const cam = { zoom: 1, ox: 0, oy: 0 };

  /** @type {Array<{memberId:string,state:string,ghost:boolean,project:string,name:string}>} */
  let members = [];
  /** @type {any[]} */
  let agents = [];
  /** @type {any[]} */
  let ghosts = [];
  /**
   * The ghost's "gate open" moment: the instant every gremlin has finished entering (see stepGhosts).
   * The first batch of ghosts drifts in through the front door one by one from this moment; 0 = gate not open yet.
   */
  let ghostGateAt = 0;
  let selectedId = '';
  let hoverId = '';
  let showPaths = false;
  let manualMeeting = false;
  /** Dispatch state: { agentId, start, talkAt, task, ghostId } (the gremlin talks to the console in place) */
  let dispatch = null;
  /** Dispatch queue: a summon -> queue the "pick up task" beat (dialogue in place, no walking) */
  const summonQueue = [];
  /** Seated gremlin name -> { seat, agentId }: maps a summoned ghost to its gremlin */
  let seatByName = {};
  /** Report beat: subagent finished -> say the result summary in place, then the ghost disperses */
  let report = null;
  /** Report queue: queued when a summoned ghost writes a result (finished) or vanishes from the roster; one at a time */
  const reportQueue = [];
  /** Extra ghost drawn during a report, when the real ghost already left the roster */
  let reportGhost = null;
  /** The ghost "works" until this moment (performance.now ms) before the report may start; see REPORT_MIN_WORK */
  let reportHoldUntil = 0;
  /** One-shot callback fired when the whole summon/report arc drains (flowPending() turns false); see whenFlowIdle */
  let flowIdleCb = null;
  /** agentId of a gremlin currently being summoned (ghost still floating): pinned to its seat, no wandering */
  const summonedAgentIds = new Set();

  let raf = 0;
  let last = 0;
  const t0 = performance.now();

  /** Clickable regions this frame (screen coordinates, CSS px) */
  let hits = [];
  /** Screen coordinates of each character this frame (foot, CSS px) */
  const screenPos = new Map();

  const bg = document.createElement('canvas');
  let bgKey = '';

  /* ------------------------------ Camera ------------------------------ */

  function roomBounds() {
    const pts = [
      project(0, 0, 0),
      project(ROOM.w, 0, 0),
      project(0, ROOM.d, 0),
      project(ROOM.w, ROOM.d, 0),
      project(0, 0, WALL.h),
      project(ROOM.w, 0, WALL.h),
      project(0, ROOM.d, WALL.h),
      project(ROOM.w, ROOM.d, WALL.h),
    ];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return {
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      y0: Math.min(...ys),
      y1: Math.max(...ys),
    };
  }

  /** Fit the whole room to fill the canvas exactly */
  function fit() {
    if (!W || !H) return;
    const b = roomBounds();
    const pad = 24;
    const bw = b.x1 - b.x0;
    const bh = b.y1 - b.y0;
    cam.zoom = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh);
    cam.zoom = Math.max(0.35, Math.min(2.4, cam.zoom));
    cam.ox = W / 2 - ((b.x0 + b.x1) / 2) * cam.zoom;
    cam.oy = H / 2 - ((b.y0 + b.y1) / 2) * cam.zoom;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(rect.width));
    H = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const prevZoom = cam.zoom;
    fit();
    if (Math.abs(prevZoom - cam.zoom) > 0.0001) bgKey = '';
  }

  /** World coordinates -> CSS pixel coordinates */
  function toScreen(gx, gy, gz = 0) {
    const p = project(gx, gy, gz);
    return { x: p.x * cam.zoom + cam.ox, y: p.y * cam.zoom + cam.oy };
  }

  /* ------------------------------ Main Agent console ------------------------------ */

  /**
   * Main session (Craft Agent) state: { phase, action, context[], target }.
   * Currently fed by the mock in stores/mainAgent.js; later swapped for hook events, the drawing stays the same.
   */
  let mainAgent = { phase: 'idle', action: '', context: [], target: null };

  /** Dispatch target: can be a workstation id (A0…B2) or a member id —— both are converted to foot coordinates */
  function targetSeat(id) {
    const u = DESK_UNITS.find((d) => d.id === id);
    if (u) return u.seat;
    const a = agents.find((ag) => ag.memberId === id);
    return a ? { x: a.x, y: a.y } : null;
  }

  /** Resolve a workstation id / member id to its gremlin (the one sitting at the workstation) */
  function agentByTarget(id) {
    const direct = agents.find((x) => x.memberId === id);
    if (direct) return direct;
    const u = DESK_UNITS.find((d) => d.id === id);
    if (u) return agents.find((x) => x.home === DESK_UNITS.indexOf(u)) || null;
    return null;
  }

  /** Task the main Agent tells the gremlin: pick the "delegate / assign" line from the context, else fall back to the action */
  function delegationLine() {
    const lines = Array.isArray(mainAgent.context) ? mainAgent.context : [];
    const hit = lines.find((t) => /委托|分配|交给|让他|让她|去/.test(t));
    return String(hit || lines[0] || mainAgent.action || t('office.task_new'));
  }

  /** Queue a summon beat (the gremlin picks up its task in place). Never queue the same gremlin twice. */
  function enqueueDispatch(agentId, task, ghostId = null) {
    if (!agentId) return;
    if (dispatch && dispatch.agentId === agentId) return;
    if (summonQueue.some((s) => s.agentId === agentId)) return;
    summonQueue.push({ agentId, task: task || t('office.task_new'), ghostId });
  }

  /** Start the next queued beat (when idle) */
  function pumpDispatch() {
    if (dispatch || !summonQueue.length) return;
    const s = summonQueue.shift();
    const a = agents.find((x) => x.memberId === s.agentId);
    if (!a) return;
    dispatch = {
      agentId: a.memberId,
      start: performance.now(),
      // talkAt: when it starts talking. The gremlin talks to the main console **in place**, no walk;
      // wait until it is inside (still entering) so the dialogue does not overlap the entrance.
      talkAt: 0,
      task: s.task,
      ghostId: s.ghostId || null,
    };
  }

  /** Wrap up the current beat: make the summoned ghost appear above the gremlin and advance the queue */
  function finishDispatch() {
    if (!dispatch) return;
    const ghostId = dispatch.ghostId;
    dispatch = null;
    if (ghostId) revealGhost(ghostId);
    pumpDispatch();
    // Only after the task is picked up and the ghost has appeared does the report come (see pumpReport's
    // dispatch guard) — so even a very fast subagent still reports while the ghost is visible.
    // The ghost gets a short "working" beat first (REPORT_MIN_WORK): a fast task still reads as a full arc.
    if (ghostId) {
      ensureReportGhost(ghostId);
      reportHoldUntil = performance.now() + REPORT_MIN_WORK;
    }
    pumpReport();
  }

  /** Task picked up: show the previously hidden summoned ghost (directly above the gremlin's head) */
  function revealGhost(ghostId) {
    pendingGhostIds.delete(ghostId);
    if (ghosts.some((g) => g.memberId === ghostId)) return;
    const m = members.find((x) => x.memberId === ghostId);
    if (!m) return;
    const info = m.ghost ? seatByName[m.name] : null;
    ghosts.push(makeGhost(m, ghosts.length, info && info.seat));
  }

  /**
   * Draw an extra ghost during a report: this summon's ghost already left the roster (recycled without a
   * result, or finished faster than the pick-up), but the report is still playing. Draw one above its
   * gremlin's head and let it disperse after the report, otherwise "the worker vanished first, then
   * reports itself" looks like a glitch.
   *
   * Only when there really is a report for it (queued / playing): when the ghost simply floated and left
   * without a report, we do not add a lingering ghost out of nowhere.
   */
  function ensureReportGhost(ghostId) {
    if (!ghostId) return;
    if (reportGhost && reportGhost.id === ghostId) return;
    if (ghosts.some((g) => g.memberId === ghostId)) return;
    const hasReport = reportQueue.some((r) => r.ghostId === ghostId) || (report && report.ghostId === ghostId);
    if (!hasReport) return;
    const meta = ghostMeta.get(ghostId);
    if (!meta || !meta.agentId) return;
    const a = agents.find((x) => x.memberId === meta.agentId);
    if (!a) return;
    reportGhost = {
      id: ghostId,
      x: a.seat.x + 0.25,
      y: a.seat.y - 0.15,
      z: 1.7,
      color: meta.color || a.color,
      phase: Math.random() * 6.28,
      name: meta.name || a.name,
    };
  }

  /* ------------------------------ Finish report ------------------------------
   * The subagent finished: the gremlin says the **result summary** in place (the roster's result,
   * or "Done: <task>" when missing). No walk back to the console.
   * Order must be report -> idle -> ghost disperses; never "reset as soon as the main agent sees stop".
   */

  /** Report text: prefer the result summary, fall back to "Done: <task>" */
  function reportText(r) {
    const res = String((r && r.result) || '').trim();
    if (res) return res;
    const task = String((r && r.task) || '').trim();
    return task ? t('bubble.done_prefix', { task }) : t('bubble.done');
  }

  /** Queue one finish report (only once per summon) */
  function pushReport(ghostId, meta) {
    if (!meta || !meta.agentId) return;
    if (reportQueue.some((r) => r.ghostId === ghostId)) return;
    if (report && report.ghostId === ghostId) return;
    reportQueue.push({ agentId: meta.agentId, ghostId, task: meta.task, result: meta.result });
    pumpReport();
  }

  function pumpReport() {
    // Do not report while the "pick up task" beat is still running: a subagent can finish faster than the
    // gremlin picks up its task, and reporting then would speak before the ghost has even appeared.
    // Wait for finishDispatch (ghost appears).
    if (report || dispatch || !reportQueue.length) return;
    // The ghost just appeared; let it "work" this short beat (see REPORT_MIN_WORK in finishDispatch)
    if (performance.now() < reportHoldUntil) return;
    const r = reportQueue.shift();
    const a = agents.find((x) => x.memberId === r.agentId);
    if (!a) return;
    report = { ...r, start: performance.now(), talkAt: 0 };
    ensureReportGhost(r.ghostId);
  }

  function finishReport() {
    if (!report) return;
    // Note down "what this gremlin last finished": the report counts as delivered once it plays, and tooltip / workstation card
    // can look back at it later (the ghost has dispersed by then, the result only lives here).
    if (report.agentId) {
      lastResults.set(report.agentId, {
        task: String(report.task || ''),
        result: String(report.result || ''),
        at: Date.now(),
      });
    }
    if (reportGhost && reportGhost.id === report.ghostId) reportGhost = null;
    report = null;
    pumpReport();
  }

  /** Is this gremlin currently being summoned (its instance ghost is on the roster)? */
  const isSummoned = (agentId) => summonedAgentIds.has(agentId);

  /**
   * Should the main console's "Task done" wait? True while a summon / report beat is running or queued.
   *
   * When the task is fast, real data reports "finished" first while the office still has to play
   * "pick up task -> ghost appears -> report". If the main phase jumped to "Task done" immediately the
   * whole animation would be swallowed. The view defers the wrap-up to the whenFlowIdle() callback
   * (see IsoOfficeView).
   */
  function flowPending() {
    return Boolean(dispatch || report || summonQueue.length || reportQueue.length || pendingGhostIds.size);
  }

  /**
   * Run cb once the beats drain: fire immediately when nothing is running, otherwise remember it and
   * call it when flowPending() turns false (see tick). Only one callback is kept; a later one replaces it.
   */
  function whenFlowIdle(cb) {
    if (typeof cb !== 'function') return;
    if (!flowPending()) { cb(); return; }
    flowIdleCb = cb;
  }

  /**
   * When the main agent enters the dispatch phase (mock / real), make the matching gremlin go through the same orchestration.
   *
   * **Only play it once on "just entered" dispatch**: the phase is fed by a 1.5s poll, and the same dispatch
   * phase is sent again and again (target unchanged); without detecting "just entered", every send would requeue ——
   * the symptom is that clicking a workstation card once (triggering one state round-trip) replays the same dialogue.
   * @param {{phase?:string, target?:any}|null} prev the previous phase (null = first time)
   */
  function syncDispatch(prev) {
    // Real summons are not triggered here: the moment the ghost appears (setMembers) the task has already been handed over once;
    // playing it again on permission release / phase replay would mean "the same task handed over twice".
    if (mainAgent.phase === 'dispatch' && mainAgent.target) {
      const a = agentByTarget(mainAgent.target);
      const sameAsPrev = prev && prev.phase === 'dispatch' && String(prev.target) === String(mainAgent.target);
      if (a && !sameAsPrev && !isSummoned(a.memberId)) enqueueDispatch(a.memberId, delegationLine());
    }
    pumpDispatch();
  }

  /* ------------------------------ Members ------------------------------ */

  function makeAgent(member, index, spawnAt = 0) {
    const seat = DESK_UNITS[index].seat;
    return {
      memberId: member.memberId,
      name: member.name || member.memberId,
      home: index,
      seat,
      x: seat.x,
      y: seat.y,
      /** Entry moment (performance.now ms): has not entered before it arrives —— not drawn, not moved; walks in from outside the door on time */
      spawnAt,
      entering: spawnAt > 0,
      /** In the doorway right now (outside door -> inner side of door): the front door must stay open during this (see stepDoor) */
      atDoor: false,
      facing: 1,
      mode: 'sit',
      moving: false,
      inMeeting: false,
      path: [],
      pi: 0,
      dwell: 0,
      pendingMode: 'sit',
      pendingDwell: 0,
      nextThink: performance.now() + 4000 + Math.random() * 14000,
      phase: Math.random() * 6.28,
      color: colorOf(member.memberId),
      prop: propOf(member.memberId),
      work: workOf(member.memberId),
      level: member.level || null,
      /** Last public state bucket; a transition away from idle interrupts any lounge activity. */
      stateBucket: bucketOf(member.state),
    };
  }

  /**
   * Create a ghost.
   *
   * Whether in the demo or a real scene, it **starts from outside the front door** (gx < 0, hidden by the wall -> invisible),
   * and drifts to its hover spot only after all gremlins are inside (see stepGhosts and GHOST_ENTRY_*).
   * The "overhead ghost" of a seated gremlin (nearSeat non-null: the one above a summoned gremlin) drifts in a small
   * range above its workstation once in place; other temporary members drift in the generic hover area.
   *
   * @param {number} i index within the same ghost batch: decides which hover spot it drifts to, and in what order it enters
   * @param {{x:number,y:number}|null} nearSeat non-null = overhead ghost, drifts around this workstation
   */
  function makeGhost(member, i, nearSeat) {
    const gname = member.name || member.memberId;
    // Same-name instances of one gremlin share a seat: fan them into their own lanes so they do not
    // stack into a single ghost (slot = how many same-name overhead ghosts already exist).
    const slot = nearSeat ? ghosts.filter((g) => g.nearSeat && g.name === gname).length : 0;
    const fan = nearSeat ? seatFanOffset(slot) : null;
    const center = nearSeat ? { x: nearSeat.x + fan.x, y: nearSeat.y - 0.1 + fan.y, z: 2.15 } : null;
    const a = center || GHOST_SPOTS[i % GHOST_SPOTS.length];
    const now = performance.now();
    return {
      memberId: member.memberId,
      name: gname,
      // Overhead ghost: appears directly above the gremlin's head (waiting=false, drifts from the anchor);
      // standalone ghost: starts outside the door (gx < 0, hidden by the wall), drifts in once the window gate opens.
      x: nearSeat ? a.x : PLACES.doorOut.x,
      y: nearSeat ? a.y : PLACES.doorOut.y + (Math.random() - 0.5) * 0.36,
      z: nearSeat ? a.z : 1.45,
      anchor: a,
      center, // non-null = overhead ghost, drifts in a small range around it
      target: null,
      /** Still waiting outside the door (not departed): clipped to the doorway when drawing, so invisible */
      waiting: !nearSeat,
      /** Currently drifting from outside the door to the hover spot (faster in this stretch) */
      entering: false,
      /** Passing through the doorway: the door must stay open (see stepDoor) */
      atDoor: false,
      /** Position in the queue (departure time = gate time + SETTLE + order × STAGGER, see stepGhosts) */
      order: i,
      /** Fallback for waiting on gremlins to enter: departs on time whether or not they are inside */
      enterDeadline: now + GHOST_ENTRY_WAIT_MAX,
      phase: Math.random() * 6.28,
      speed: center ? 0.35 : 0.5 + Math.random() * 0.35,
      hold: 0,
      inMeeting: false,
      nearSeat: Boolean(nearSeat),
      color: colorOf(member.memberId),
      level: member.level || null,
    };
  }

  /** Called from Vue: members is [{memberId, name, state, ghost, project, task, taskKey}] */
  function setMembers(list) {
    members = list || [];
    const seated = members.filter((m) => !m.ghost).slice(0, DESK_UNITS.length);
    const floating = members.filter((m) => !seated.includes(m));

    const seatIds = new Set(seated.map((m) => m.memberId));
    /** Gremlin memberId -> workstation coordinates (foot) */
    const seatPos = {};
    /** Gremlin name -> { seat, agentId }: match a summoned ghost to its gremlin by name */
    const byName = {};
    agents = agents.filter((a) => seatIds.has(a.memberId));
    // New gremlins enter in a queue: staggered in the order received, walking in one by one through the front door
    let enterSlot = 0;
    const nowMs = performance.now();
    seated.forEach((m, i) => {
      let a = agents.find((x) => x.memberId === m.memberId);
      if (!a) {
        // A busy workstation gremlin is already working, so switching to this floor should
        // reveal it seated instead of replaying an entrance it did not just perform.
        const startsAtDesk = bucketOf(m.state) === 'busy';
        a = makeAgent(m, i, startsAtDesk ? 0 : nowMs + ENTER_DELAY + enterSlot * ENTER_STAGGER);
        if (!startsAtDesk) enterSlot += 1;
        agents.push(a);
      }
      a.home = i;
      a.seat = DESK_UNITS[i].seat;
      // Existing gremlins also need a name / level refresh: the level is delivered asynchronously with the member card,
      // so on first creation it may not be there yet (would be drawn as a gray plate); later updates must apply, or it stays gray forever.
      a.name = m.name || a.name;
      a.level = m.level || null;
      const stateBucket = bucketOf(m.state);
      const becameActive = a.stateBucket === 'idle' && stateBucket !== 'idle';
      a.stateBucket = stateBucket;
      // An idle lounge/coffee trip can outlive the state update that made the member busy or blocked.
      // Interrupt it immediately so a working gremlin does not keep sitting in the pantry.
      if (becameActive && !a.entering && !a.inMeeting) {
        a.dwell = 0;
        goHome(a);
      }
      seatPos[m.memberId] = DESK_UNITS[i].seat;
      const nm = m.name || String(m.memberId).split('@')[0];
      if (nm) byName[nm] = { seat: DESK_UNITS[i].seat, agentId: m.memberId };
    });
    seatByName = byName;
    /**
     * A new batch of gremlins arrived this round (walking in one by one through the door) -> close the ghost gate one notch again:
     * they have to let this batch finish entering before drifting in (the demo's opening is "everyone goes in, then ghosts drift in").
     * Rounds with no newcomers leave it alone —— ghosts already drifting inside are unaffected.
     */
    if (enterSlot) ghostGateAt = 0;

    const gIds = new Set(floating.map((m) => m.memberId));
    ghosts = ghosts.filter((g) => gIds.has(g.memberId));
    // Ghost has disappeared -> clear it from the pending / triggered sets, so the next summon can trigger again
    for (const id of [...pendingGhostIds]) if (!gIds.has(id)) pendingGhostIds.delete(id);
    for (const id of [...summonedGhostIds]) if (!gIds.has(id)) summonedGhostIds.delete(id);
    // The dispatched-task ledger intentionally survives roster changes. A floor switch removes
    // the current floor's ghosts from this roster, but returning must not replay their dispatch.
    for (const id of [...pendingSeenOnce]) if (!gIds.has(id)) pendingSeenOnce.delete(id);

    // A summoned ghost vanishing from the roster = this summon is over. If it never reported
    // (recycled with no result written), queue one last in-place report so it does not just disappear.
    for (const [id, meta] of [...ghostMeta]) {
      if (gIds.has(id)) continue;
      ghostMeta.delete(id);
      if (!reportedGhostIds.has(id)) pushReport(id, meta);
      reportedGhostIds.delete(id); // the next summon must be able to report again
    }
    if (reportGhost && !gIds.has(reportGhost.id) && !reportQueue.some((r) => r.ghostId === reportGhost.id) && !(report && report.ghostId === reportGhost.id)) {
      reportGhost = null;
    }

    // Gremlins currently being summoned: pinned to their workstation during this time (see canWander)
    summonedAgentIds.clear();
    for (const m of floating) {
      const info = m.ghost ? byName[m.name] : null;
      if (info) summonedAgentIds.add(info.agentId);
    }

    floating.forEach((m, i) => {
      const taskKey = String(m.taskKey || '');
      // If a ghost's name equals some seated gremlin's name, this is the instance ghost of "some gremlin was summoned".
      const info = m.ghost ? byName[m.name] : null;
      const queued = summonQueue.find((s) => s.ghostId === m.memberId);
      const running = !!(dispatch && dispatch.ghostId === m.memberId);
      const dispatched = dispatchedGhostTasks.has(m.memberId);
      const dispatchedKey = dispatchedGhostTasks.get(m.memberId);
      // A stable task key changing while the ghost still owns the same memberId means an actual
      // new summon, not a floor switch. Hide the old sprite and play the new pick-up beat.
      const taskChanged = Boolean(dispatched && dispatchedKey && taskKey && dispatchedKey !== taskKey);
      if (info && taskChanged && !queued && !running) {
        pendingGhostIds.add(m.memberId);
        ghosts = ghosts.filter((g) => g.memberId !== m.memberId);
      }
      if (info && !summonedGhostIds.has(m.memberId)) {
        // Summoned (including one already running on page refresh): hide this ghost first, then queue the
        // "pick up task in place -> ghost appears" beat.
        summonedGhostIds.add(m.memberId);
        if (!dispatched) pendingGhostIds.add(m.memberId);
      }
      if (info && pendingGhostIds.has(m.memberId)) {
        // The ghost registers first, the task name is written into the member card later: queue only once the task is in, so it does not show as "new task".
        if (!queued && !running) {
          if (dispatched && !taskChanged) {
            // The dispatch already happened in another engine instance (for example after a
            // route remount). Reveal it without replaying the dialogue.
            pendingGhostIds.delete(m.memberId);
          } else if (m.task) {
            summonQueue.push({ agentId: info.agentId, task: m.task, ghostId: m.memberId });
            dispatchedGhostTasks.set(m.memberId, taskKey);
          } else if (pendingSeenOnce.has(m.memberId) && !dispatched) {
            summonQueue.push({ agentId: info.agentId, task: t('bubble.working'), ghostId: m.memberId });
            dispatchedGhostTasks.set(m.memberId, taskKey);
          }
        } else if (m.task) {
          if (queued) queued.task = m.task;
          else if (running) dispatch.task = m.task;
          dispatchedGhostTasks.set(m.memberId, taskKey);
        }
        pendingSeenOnce.add(m.memberId);
      }
      if (info) {
        // Remember which gremlin this summoned ghost maps to, what it is doing, and what the result is:
        // after the ghost is recycled (gone from the roster) the report still relies on it to finish.
        const prev = ghostMeta.get(m.memberId) || {};
        ghostMeta.set(m.memberId, {
          agentId: info.agentId,
          name: m.name || prev.name || '',
          color: colorOf(m.memberId),
          task: m.task || prev.task || '',
          result: m.result || prev.result || '',
        });
        // result written = wrap up: report right away (the ghost is still there; the server only recycles it after the report plays)
        // Also record the result first: even if the page switches away before the report finishes, tooltip / workstation card can still look back.
        if (m.result && info) {
          lastResults.set(info.agentId, {
            task: String(m.task || ghostMeta.get(m.memberId)?.task || ''),
            result: String(m.result),
            at: Date.now(),
          });
        }
        if (m.result && !reportedGhostIds.has(m.memberId)) {
          reportedGhostIds.add(m.memberId);
          pushReport(m.memberId, ghostMeta.get(m.memberId));
        }
      }
      if (pendingGhostIds.has(m.memberId)) return; // not time to appear yet
      if (!ghosts.some((g) => g.memberId === m.memberId)) {
        ghosts.push(makeGhost(m, i, info && info.seat));
      }
    });

    pumpDispatch();
    maybeMeeting();
  }

  const memberOf = (id) => members.find((m) => m.memberId === id) || null;
  const stateOf = (id) => (memberOf(id) || {}).state || 'idle';

  /* ------------------------------ Movement ------------------------------ */

  function goTo(a, to, mode, dwellMs = 0) {
    a.path = route({ x: a.x, y: a.y }, to);
    a.pi = 0;
    a.pendingMode = mode;
    a.pendingDwell = dwellMs;
  }

  const goHome = (a) => goTo(a, a.seat, 'sit');

  /**
   * Turn a speaking-in-place gremlin toward the main console (by x: console center is x≈7.1, see
   * officeMap's CONSOLE). An iso sprite only faces left or right, so this is the best approximation
   * of "facing the console side".
   */
  function faceConsole(a) {
    a.facing = a.x < CONSOLE.seat.x ? 1 : -1;
  }

  const WANDER = [
    { x: 6.9, y: 5.4 },
    { x: 13.4, y: 5.4 },
    { x: 6.9, y: 9.4 },
    { x: 0.6, y: 1.5 },
    { x: 13.4, y: 9.4 },
  ];

  function pickActivity(a) {
    const r = Math.random();
    if (r < 0.24) {
      goTo(a, PLACES.coffee, 'coffee', 6000 + Math.random() * 8000);
    } else if (r < 0.4) {
      goTo(a, PLACES.printer, 'print', 4000 + Math.random() * 6000);
    } else if (r < 0.62 && agents.length > 1) {
      const other = agents[(a.home + 1 + Math.floor(Math.random() * 2)) % agents.length];
      if (other && other !== a) {
        // Stand inside the other's workstation (the divider side, not in the corridor chatting over the partition)
        goTo(a, { x: other.seat.x + 0.85, y: other.seat.y }, 'chat', 5000 + Math.random() * 6000);
      }
    } else if (r < 0.84) {
      // Break room: go sit on one of the pantry chairs for a while (idle gremlins rest here)
      goTo(a, PANTRY_SEATS[Math.floor(Math.random() * PANTRY_SEATS.length)], 'sit', 9000 + Math.random() * 12000);
    } else {
      goTo(a, WANDER[Math.floor(Math.random() * WANDER.length)], 'walk', 3000 + Math.random() * 4000);
    }
  }

  function stepAgents(dt, now) {
    for (const a of agents) {
      // Not inside yet: wait outside the door first (not drawn, not moved), and only walk in from outside the door on time (the door pushes open at the same time, see stepDoor)
      if (a.entering) {
        if (now < a.spawnAt) continue;
        a.entering = false;
        if (dispatch && dispatch.agentId === a.memberId) {
          // Summoned right after being created: skip the entry walk, sit down directly, hand over to the summon orchestration
          a.x = a.seat.x;
          a.y = a.seat.y;
        } else {
          // Start from **outside the door** (gx < 0 = the small corridor outside the wall), pass through the doorway then turn toward the workstation ——
          // the door is pushed open exactly then (see stepDoor), so it reads as "the door opens and the person walks in".
          // Stagger a bit randomly: the doorway is 1 tile wide along gy, so two in a row do not overlap exactly on one line.
          // Offset only ±0.12 (was ±0.25): too much and it hugs the doorway edge and the wall clips off half its body.
          a.x = PLACES.doorOut.x;
          a.y = PLACES.doorOut.y + (Math.random() - 0.5) * 0.24;
          a.atDoor = true;
          a.facing = 1;
          a.mode = 'walk'; // during the walk it must be in a "standing walk" pose, and only sit down at the workstation (pendingMode='sit')
          goTo(a, a.seat, 'sit');
        }
        a.nextThink = now + 4000 + Math.random() * 14000;
      }
      if (a.path.length && a.pi < a.path.length) {
        let budget = SPEED * dt;
        while (budget > 0 && a.pi < a.path.length) {
          const tgt = a.path[a.pi];
          const dx = tgt.x - a.x;
          const dy = tgt.y - a.y;
          const d = Math.hypot(dx, dy);
          if (d <= budget || d < 0.01) {
            a.x = tgt.x;
            a.y = tgt.y;
            budget -= d;
            a.pi += 1;
          } else {
            if (Math.abs(dx) > 0.02) a.facing = dx > 0 ? 1 : -1;
            a.x += (dx / d) * budget;
            a.y += (dy / d) * budget;
            a.phase += dt * 9;
            budget = 0;
          }
        }
        a.moving = true;
        if (a.pi >= a.path.length) {
          a.path = [];
          a.moving = false;
          a.mode = a.pendingMode || 'sit';
          a.dwell = a.pendingDwell ? now + a.pendingDwell : 0;
          if (a.mode === 'sit') a.facing = 1;
        }
      } else {
        a.moving = false;
        a.phase += dt * 2;
        if (!a.inMeeting && a.dwell && now >= a.dwell) {
          a.dwell = 0;
          goHome(a);
        }
      }
      // Walked inside (whole body past the doorway) -> the door no longer needs to stay open for it
      if (a.atDoor && a.x >= DOOR_INSIDE_X) a.atDoor = false;

      if (a.mode === 'sit' && !a.path.length && !a.inMeeting && now >= a.nextThink) {
        a.nextThink = now + 8000 + Math.random() * 16000;
        if (Math.random() < 0.6 && canWander(a)) pickActivity(a);
      }
    }
  }

  function stepGhosts(dt, now) {
    /**
     * Are all gremlins inside: none still waiting to appear (entering), and none still stuck in the doorway (atDoor).
     * Ghosts wait for this before departing —— the demo's opening is "people go in first, then ghosts drift in".
     */
    const gremlinsIn = !agents.some((a) => a.entering || a.atDoor);
    // The gate time is recorded once: the first batch of ghosts orders departures by it; ghosts that arrive later (finish report / new summon)
    // get a departure time already past, so they drift in from the door immediately.
    if (gremlinsIn && !ghostGateAt) ghostGateAt = now;
    for (const g of ghosts) {
      // Still waiting outside the door: it departs only when its time comes and everyone is inside
      if (g.waiting) {
        // Gate not open yet (gremlins still entering) -> keep waiting outside the door;
        // but enterDeadline is the fallback —— a summon interrupts a gremlin's entry (sits directly / called to the console),
        // so do not keep a ghost locked outside the door forever just because someone never sits down.
        if (!ghostGateAt && now < g.enterDeadline) continue;
        const readyAt = ghostGateAt + GHOST_ENTRY_SETTLE + g.order * GHOST_ENTRY_STAGGER;
        if (ghostGateAt && now < readyAt && now < g.enterDeadline) continue;
        g.waiting = false;
        g.entering = true;
        g.atDoor = true;
        // Ones drifting in during a meeting go straight to the meeting room, not first back to their own hover spot
        g.target = g.inMeeting ? GHOST_MEET : g.anchor;
      }
      if (g.target) {
        const dx = g.target.x - g.x;
        const dy = g.target.y - g.y;
        const dz = g.target.z - g.z;
        const d = Math.hypot(dx, dy, dz);
        // The entry stretch moves faster: drifting from the door to the hover spot crosses half the room
        const step = (g.entering ? GHOST_ENTRY_SPEED : g.speed) * dt;
        if (d <= step || d < 0.02) {
          g.x = g.target.x;
          g.y = g.target.y;
          g.z = g.target.z;
          g.target = null;
          g.entering = false;
          g.hold = now + (g.nearSeat ? 1000 + Math.random() * 2000 : 6000 + Math.random() * 9000);
        } else {
          g.x += (dx / d) * step;
          g.y += (dy / d) * step;
          g.z += (dz / d) * step;
        }
      } else if (now >= g.hold) {
        if (g.nearSeat && g.center) {
          // Overhead ghost: drifts randomly around its own lane above the workstation (wider
          // horizontally), do not pin it, and do not drift elsewhere.
          const ang = Math.random() * Math.PI * 2;
          const rad = Math.sqrt(Math.random()); // evenly distributed inside the ellipse
          g.target = {
            x: g.center.x + Math.cos(ang) * rad * SEAT_WANDER_RX,
            y: g.center.y + Math.sin(ang) * rad * SEAT_WANDER_RY,
            z: g.center.z + (Math.random() - 0.5) * SEAT_WANDER_RZ,
          };
        } else if (!g.inMeeting) {
          const pool = GHOST_SPOTS.filter((p) => p !== g.anchor);
          g.anchor = pool[Math.floor(Math.random() * pool.length)];
          g.target = g.anchor;
        }
      }
      // Whole body is inside the room -> the door no longer needs to stay open for it (same as a gremlin's atDoor)
      if (g.atDoor && g.x >= DOOR_INSIDE_X) g.atDoor = false;
    }
  }

  /* ------------------------------ Meeting ------------------------------ */

  function startMeeting(ids) {
    let k = 0;
    agents.forEach((a) => {
      if (!ids.includes(a.memberId) || a.entering) return; // those not inside yet do not go to the meeting
      a.inMeeting = true;
      a.dwell = 0;
      goTo(a, MEETING_SEATS[k % MEETING_SEATS.length], 'meet');
      k += 1;
    });
    ghosts.forEach((g) => {
      if (g.nearSeat) return; // stays by its gremlin, does not enter the meeting room
      g.inMeeting = true;
      g.target = GHOST_MEET;
    });
  }

  function endMeeting() {
    agents.forEach((a) => {
      if (!a.inMeeting) return;
      a.inMeeting = false;
      a.dwell = 0;
      goHome(a);
    });
    ghosts.forEach((g) => {
      if (!g.inMeeting) return;
      g.inMeeting = false;
      g.target = g.anchor;
    });
  }

  function maybeMeeting() {
    const blocked = members.filter((m) => m.state === 'blocked').map((m) => m.memberId);
    if (blocked.length >= 2) startMeeting(blocked);
    else if (!manualMeeting) endMeeting();
  }

  /* ------------------------------ Static furniture ------------------------------ */

  /**
   * Monospace font used for the "typing" on screens: one character occupies one cell, so it can pop out cell by cell.
   * The font size is written in **screen-local units** (tile) —— the same scheme as mainConsole's screen text,
   * skew-mounted onto the screen via c.transform, so it scales up and down with zoom automatically.
   */
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
  /** Character pool to type out: lowercase letters + digits + a few symbols, so up close it looks like typing code */
  const TYPE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789_./:-=><()[]{}#$*';

  /** Deterministic pseudo-random 0~1: each machine's content differs, but the value is the same every frame —— Math.random is forbidden (it would flash like a disco) */
  function screenRnd(a, b) {
    const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return s - Math.floor(s);
  }
  /** The i-th character to type out: about 1/6 are spaces, to fake the "word + space" feel of code lines */
  function screenChar(seed, i) {
    if (screenRnd(seed, i * 1.37 + 0.11) < 0.17) return ' ';
    const n = TYPE_CHARS.length;
    return TYPE_CHARS[Math.floor(screenRnd(seed + 7.3, i * 2.11 + 3.7) * n) % n];
  }

  /**
   * The text being typed on screen: **pops out one character at a time**, the cursor follows and blinks,
   * fills the whole screen -> pauses -> clears and starts over (infinite loop).
   *
   * Rhythm/content is entirely decided by (seed, now): each monitor has its own text and speed (not synchronized),
   * but the result is stable every frame, no jitter. The characters are **real letters** (not white dots/dashes),
   * so from afar it reads as "this screen keeps outputting", and zooming in with the wheel you can make out letters.
   * @param {{x0:number,x1:number,z0:number,z1:number,face:number,seed:number,now:number}} o
   */
  function drawTyping(c, o) {
    const { x0, x1, z0, z1, face, seed, now } = o;
    // Content area: leave room at the top for the status dot, at the bottom for the progress bar, and pull the right edge in a bit to avoid the top-right light
    const left = x0 + 0.04;
    const right = x1 - 0.13;
    const top = z1 - 0.05;
    const bot = z0 + 0.1;
    const w = right - left;
    const h = top - bot;
    if (w <= 0 || h <= 0) return;

    const COLS = 11;
    const ROWS = 3;
    const cw = w / COLS;
    const lh = h / ROWS;
    const fs = Math.min(lh * 0.95, cw * 1.7); // glyph height is governed by line spacing, glyph width must not spill into the neighboring cell
    const cap = COLS * ROWS;

    // Rhythm: typing speed + phase differ per machine; after filling it pauses `hold` seconds, then clears and starts over
    const cps = 9 + (seed % 5);
    const off = ((seed >> 3) % 40) / 10;
    const hold = 1.0;
    const cycle = cap / cps + hold;
    const typed = Math.min(cap, Math.floor(((now / 1000 + off) % cycle) * cps));

    c.save();
    // Switch to the screen face's own local coordinates: u along +gx (the slant hugging the screen), v downward
    const o0 = project(left, face, top);
    c.transform(AX.x, AX.y, -AZ.x, -AZ.y, o0.x, o0.y);
    c.beginPath();
    c.rect(0, 0, w, h);
    c.clip();

    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.font = `${fs}px ${MONO}`;
    for (let i = 0; i < typed; i += 1) {
      const ch = screenChar(seed, i);
      if (ch === ' ') continue;
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      // The line just typed is brightest, dimmer going up —— like old output scrolling up in a terminal
      const age = (typed - 1 - i) / COLS;
      c.fillStyle = age < 1 ? '#f4fff8' : age < 2 ? '#d0f4de' : '#a4e6bf';
      c.fillText(ch, col * cw, row * lh + (lh - fs) * 0.5);
    }

    // Cursor: lands where the next character will appear; after filling, it blinks on the last cell, waiting for the clear
    if (Math.floor(now / 500) % 2 === 0) {
      const ci = typed < cap ? typed : cap - 1;
      c.fillStyle = 'rgba(244,255,248,0.9)';
      c.fillRect((ci % COLS) * cw, Math.floor(ci / COLS) * lh + lh * 0.1, cw * 0.8, lh * 0.8);
    }
    c.restore();
  }

  /**
   * Monitor screen (south desk, the face toward the camera).
   * on=false (empty workstation): **standby** —— laid in dark blue, with a small patch of cool glow showing through the screen,
   * so it reads as "powered on, just no content", instantly distinct from the lit screen next door (not a dead black block that lost power).
   * on=true: old monitor phosphor green —— bright green fills the black bezel (the panel body), and the screen shows the **typing animation**
   * (characters popping out one by one + cursor blinking + clear-and-restart when full, see drawTyping), no longer drawing those white dashes/dots.
   * Everything uses deterministic pseudo-random from seed; Math.random is not allowed, or it would flash like a disco every frame.
   *
   * The bottom bar **does not read task.progress** (removed 2026-09-29): that field has no real value —— a task writes 0 at start and
   * 1 at finish, with no one advancing it in between (all 489 tasks in the local DB land on {0,1}, see the comment on the
   * "progress" line in TaskRecordsView). Drawing by it gives an "empty bar" or a "full bar", i.e. reports a progress that does not exist. Changed to an **indeterminate bar**
   * (same convention as the main console mainConsole's bottom bar, the same 1800ms period): it only expresses "this machine is working",
   * and does not claim how far it has gotten.
   */
  function drawScreen(c, m, color, seed, on, now = 0) {
    const face = m.y + m.d;
    const z0 = m.z + 0.08;
    const z1 = m.z + m.h - 0.1;
    const x0 = m.x + 0.07;
    const x1 = m.x + m.w - 0.07;
    if (!on) {
      // Dark blue base: top edge slightly brighter, bottom edge sinking, so the screen has the thickness of "a pane of glass"
      const pTop = project((x0 + x1) / 2, face, z1);
      const pBot = project((x0 + x1) / 2, face, z0);
      const gb = c.createLinearGradient(0, pTop.y, 0, pBot.y);
      gb.addColorStop(0, '#14283f');
      gb.addColorStop(1, '#08142a');
      wallQuad(c, 'y', face, x0, x1, z0, z1, gb);

      // Cool light in the middle of the screen: drawn inside the polygon (clip), must not spill onto the bezel
      c.save();
      poly(c, [project(x0, face, z1), project(x1, face, z1), project(x1, face, z0), project(x0, face, z0)]);
      c.clip();
      const gz = z0 + (z1 - z0) * 0.44;
      const gp = project((x0 + x1) / 2, face, gz);
      const r = Math.max(4, Math.abs(project(x1, face, gz).x - project(x0, face, gz).x) * 0.55);
      const gg = c.createRadialGradient(gp.x, gp.y, 0, gp.x, gp.y, r);
      gg.addColorStop(0, 'rgba(122,180,255,0.20)');
      gg.addColorStop(0.5, 'rgba(92,152,236,0.08)');
      gg.addColorStop(1, 'rgba(70,130,215,0)');
      c.fillStyle = gg;
      c.fillRect(gp.x - r * 2, gp.y - r * 2, r * 4, r * 4);
      c.restore();

      // A slanted reflection (the glass is still there, just not lit)
      wallQuad(c, 'y', face + 0.001, x0 + 0.12, x0 + 0.26, z0 + 0.04, z1 - 0.12, 'rgba(150,190,240,0.07)');
      return;
    }
    // Dark green fill (the muted green of an old monitor, not fluorescent green)
    wallQuad(c, 'y', face, x0, x1, z0, z1, '#1f5c40');
    // Top-right status dot (reuses the member level color)
    wallQuad(c, 'y', face + 0.001, x1 - 0.12, x1 - 0.07, z1 - 0.05, z1 - 0.01, color);
    // Text being typed on screen: characters pop one by one, cursor blinks, clear-and-restart when full
    drawTyping(c, { x0, x1, z0, z1, face, seed, now });
    // Bottom bar: dark green track (not pure black, so it does not smudge into one black blob) + a bright green **indeterminate** bar
    // (period matches the main console, see the note above: no real progress, so no length is drawn).
    const pz = z0 + 0.04;
    wallQuad(c, 'y', face, x0 + 0.06, x1 - 0.06, pz, pz + 0.04, 'rgba(6,32,20,0.5)');
    {
      const full = x1 - 0.06 - (x0 + 0.06);
      const seg = full * 0.3;
      const at = (x0 + 0.06) + ((now / 1800) % 1) * (full - seg);
      wallQuad(c, 'y', face, at, at + seg, pz, pz + 0.04, '#9fe8b8');
    }
  }

  /** Chair base: five-star legs + center column + seat plate (always drawn before the seated person) */
  function drawChairBase(c, x, y) {
    // Base (five-star legs + center column) in a uniform bright silver (only the chair base changes; the global metal token stays:
    // printer / water cooler / magazine rack all use colors.metal)
    const SILVER = '#2b2f36';
    isoCylinder(c, { x, y, z: 0.02, r: 0.26, h: 0.04, color: '#1d2025' });
    isoCylinder(c, { x, y, z: 0.06, r: 0.05, h: 0.34, color: SILVER });
    isoBox(c, { x: x - 0.24, y: y - 0.24, z: 0.4, w: 0.48, d: 0.48, h: 0.08, color: colors.chair });
  }

  /** Chair back: backAtNorth=true faces north (back to the camera), false faces south (between the person and the camera) */
  function drawChairBack(c, x, y, backAtNorth) {
    const by = backAtNorth ? y - 0.3 : y + 0.22;
    isoBox(c, { x: x - 0.22, y: by, z: 0.48, w: 0.44, d: 0.1, h: 0.5, color: colors.chair });
  }

  /**
   * Printer (meeting room's northwest corner): a floor-standing all-in-one.
   *
   * Why not just draw a metal box —— in isometric it looks exactly like a "filing cabinet". The printer's giveaways are all in the **layering**:
   *   1) The front's mid-section **recesses inward** (the output cavity's back wall / inner wall / cavity floor are all darkened), with a light tray sticking out,
   *      and two freshly ejected white sheets on the tray —— "paper out" is the printer's most direct language;
   *   2) On top is a dark **platen glass** (a ring narrower than the body), pressed by a lid + the document feeder slot on the lid;
   *      the glass must be drawn **before** the lid, the lid only covers its middle, and the exposed front edge is the "scan bed";
   *   3) The control panel is mounted on the platen's front edge (small blue screen + one green light + two gray keys) —— a cabinet door would not have this;
   *   4) The base cabinet is two **paper cassette drawers** (with handle grooves); a single solid slab would just be a cabinet;
   *   5) The proportions must be stocky (short and plump); tall and thin and it turns back into a filing cabinet.
   */
  function drawPrinter(c, pr) {
    const { x, y, w, d } = pr;
    const H = pr.h;
    const xR = x + w;          // the +gx face (screen lower-right)
    const yF = y + d;          // the +gy face (toward the camera)
    const zBase = H * 0.44;    // paper cassette cabinet top
    const zBody = H * 0.76;    // mid-section top / platen bottom
    const zGlass = H * 0.83;   // platen glass surface
    const zLid = H * 0.9;      // lid top
    const zAdf = H * 0.94;     // document feeder slot top

    // ---- Body: cassette cabinet -> mid-section (where the output cavity is) -> platen ----
    isoBox(c, { x, y, z: 0, w, d, h: zBase, color: '#333c4b' });
    isoBox(c, { x, y, z: zBase, w, d, h: zBody - zBase, color: colors.metal });
    isoBox(c, { x, y, z: zBody, w, d, h: zGlass - zBody, color: '#2f3a4d' });

    // Platen glass (drawn before the lid: the lid will only cover its middle, exposing that front edge)
    poly(
      c,
      [
        project(x + 0.05, y + 0.04, zGlass),
        project(xR - 0.05, y + 0.04, zGlass),
        project(xR - 0.05, yF - 0.03, zGlass),
        project(x + 0.05, yF - 0.03, zGlass),
      ],
      '#212b3a',
      'rgba(176,208,240,0.45)',
      0.8
    );

    // ---- Lid + document feeder slot on the lid ----
    isoBox(c, { x: x + 0.02, y: y + 0.02, z: zGlass, w: w - 0.04, d: d - 0.04, h: zLid - zGlass, color: '#464f61' });
    isoBox(c, { x: x + 0.14, y: y + 0.06, z: zLid, w: w - 0.28, d: d - 0.12, h: zAdf - zLid, color: '#5b6577' });

    // ---- Output cavity: the front recesses inward (the recess is the all-in-one's hardest giveaway) ----
    const cz0 = H * 0.46;
    const cz1 = H * 0.65;
    const cx0 = x + 0.08;
    const cx1 = xR - 0.08;
    const cyB = yF - 0.07;   // the cavity's back wall (further in than the body's front)
    wallQuad(c, 'y', cyB, cx0, cx1, cz0, cz1, '#141a24');                       // back wall
    wallQuad(c, 'x', cx0, cyB, yF, cz0, cz1, '#0f141c');                        // west inner wall
    poly(c, [project(cx0, cyB, cz0), project(cx1, cyB, cz0), project(cx1, yF, cz0), project(cx0, yF, cz0)], '#1c2331'); // cavity floor

    // Output tray + the two freshly ejected sheets on it (poking out beyond the body)
    isoBox(c, { x: cx0 + 0.02, y: cyB + 0.01, z: cz0, w: cx1 - cx0 - 0.04, d: 0.22, h: 0.025, color: '#a7b2c2' });
    isoBox(c, { x: cx0 + 0.06, y: cyB + 0.02, z: cz0 + 0.026, w: cx1 - cx0 - 0.12, d: 0.18, h: 0.012, color: '#eef2f8' });
    isoBox(c, { x: cx0 + 0.09, y: cyB + 0.05, z: cz0 + 0.039, w: cx1 - cx0 - 0.18, d: 0.15, h: 0.012, color: '#f6f9fc' });

    // ---- Control panel: mounted on the platen's front edge (small blue screen + one green light + two gray keys) ----
    wallQuad(c, 'y', yF + 0.002, x + 0.1, xR - 0.1, H * 0.67, H * 0.745, '#1b2230', 'rgba(120,150,180,0.3)', 0.8);
    wallQuad(c, 'y', yF + 0.003, x + 0.13, x + 0.13 + w * 0.32, H * 0.685, H * 0.73, '#2f8fd8');
    for (let i = 0; i < 3; i += 1) {
      const bx = x + 0.19 + w * 0.32 + i * 0.09;
      wallQuad(c, 'y', yF + 0.003, bx, bx + 0.06, H * 0.695, H * 0.72, i === 0 ? '#7fe0a0' : '#5a6474');
    }

    // ---- Base cabinet: two paper cassette drawers (compartments + handle grooves, so it is not "one solid slab") ----
    [
      [H * 0.05, H * 0.22, H * 0.115],
      [H * 0.25, H * 0.4, H * 0.305],
    ].forEach(([z0, z1, hz]) => {
      wallQuad(c, 'y', yF + 0.002, x + 0.06, xR - 0.06, z0, z1, '#3b4455', 'rgba(18,24,32,0.55)', 0.8);
      wallQuad(c, 'y', yF + 0.003, x + 0.3, xR - 0.3, hz, hz + H * 0.03, '#222a38');
    });

    // ---- East side: cooling vents (three horizontal lines) ----
    for (let i = 0; i < 3; i += 1) {
      const gz = H * 0.12 + i * H * 0.045;
      wallQuad(c, 'x', xR + 0.001, y + 0.12, yF - 0.12, gz, gz + H * 0.014, '#2b3341');
    }
  }

  /**
   * Water cooler: body (front cold/hot two spouts + drip tray) + a 5-gallon jug inverted on top.
   *
   * How to make it "read as a water jug" (and not a blue cylinder):
   *   1) Profile the silhouette by height: neck at the bottom (the thin part inserted into the machine) -> flare -> straight barrel -> shoulder -> top neck,
   *      then project each level's "ground circle" as an ellipse and take the two ends of its major axis as the left/right silhouette points, joined into the whole outline;
   *   2) The jug body is **semi-transparent** plastic: it shows the wall / curtain behind, so it looks like a jug and not a blue ball (the Earth);
   *      the water level is visible inside: draw an ellipse for the surface (with a bright edge), below the water is bluer and heavier, above is air, the two sections a different color;
   *   3) A vertical highlight + a dark side on the barrel —— only a straight barrel has cylindrical volume;
   *   4) A few ribs + a blue neck ring at the bottom + a few bubbles in the water, and the plastic jug's details are complete.
   */
  function drawCooler(c, pc) {
    const HW = 0.3;           // body half-width
    const BH = 0.55;          // water jug height
    const bodyH = pc.h - BH;  // body height (top to jug bottom)
    const faceY = pc.y + HW;  // the face toward the camera (+gy)

    // ---- Body ----
    isoBox(c, { x: pc.x - HW, y: pc.y - HW, z: 0, w: HW * 2, d: HW * 2, h: bodyH, color: colors.metal });
    // Front: recessed dispensing area (dark panel, both spouts and the drip tray are in this block)
    wallQuad(c, 'y', faceY, pc.x - 0.17, pc.x + 0.17, bodyH * 0.5, bodyH * 0.86, '#2a3340');
    // Cold / hot two spouts: poke out a little toward +gy, one blue / one red
    isoBox(c, { x: pc.x - 0.13, y: faceY - 0.03, z: bodyH * 0.55, w: 0.08, d: 0.1, h: 0.05, color: '#4aa3f0' });
    isoBox(c, { x: pc.x + 0.05, y: faceY - 0.03, z: bodyH * 0.55, w: 0.08, d: 0.1, h: 0.05, color: '#e0603f' });
    // Drip tray (grille): a bit lower and further out
    isoBox(c, { x: pc.x - 0.15, y: faceY - 0.03, z: bodyH * 0.34, w: 0.3, d: 0.12, h: 0.035, color: '#39445a' });

    // ---- Water jug ----
    const BZ = bodyH;   // jug bottom (= machine top)
    const R = 0.28;     // maximum jug body radius (a ring narrower than the body)
    const LEVEL = 0.74; // water level (fraction of jug height)

    /** Silhouette radius: neck 0.13 -> flare -> straight barrel R -> shoulder -> top neck 0.10 (s = smoothstep, so seams are not harsh) */
    const rAt = (t) => {
      const s = (u) => u * u * (3 - 2 * u);
      if (t < 0.3) return 0.13 + (R - 0.13) * s(t / 0.3);
      if (t < 0.62) return R;
      if (t < 0.94) return R + (0.14 - R) * s((t - 0.62) / 0.32);
      return 0.14 + (0.1 - 0.14) * ((t - 0.94) / 0.06);
    };
    /** The ellipse a ring of water/plastic at some height projects onto the screen */
    const ell = (t, k = 1) => groundEllipse(pc.x, pc.y, rAt(t) * k, BZ + t * BH);
    /** A point on the ellipse: th = 0 is the screen's far right, π/2 is the bottom (i.e. the ring closest to the camera) */
    const at = (e, th) => ({
      x: e.x + e.rx * Math.cos(th) * Math.cos(e.rot) - e.ry * Math.sin(th) * Math.sin(e.rot),
      y: e.y + e.rx * Math.cos(th) * Math.sin(e.rot) + e.ry * Math.sin(th) * Math.cos(e.rot),
    });
    /** Outline: right silhouette bottom-to-top + left silhouette top-to-bottom */
    const outline = (t0, t1) => {
      const pts = [];
      const n = 18;
      for (let i = 0; i <= n; i += 1) pts.push(at(ell(t0 + (t1 - t0) * (i / n)), 0));
      for (let i = n; i >= 0; i -= 1) pts.push(at(ell(t0 + (t1 - t0) * (i / n)), Math.PI));
      return pts;
    };
    const yTop = project(pc.x, pc.y, BZ + BH).y;
    const yBot = project(pc.x, pc.y, BZ).y;

    // Jug body (plastic): semi-transparent, shows the wall / curtain behind —— solid blue-white just looks like a ball (the "Earth").
    // Keep only a trace of white haze (0.05) as the plastic inner wall's frost: pile it on and the transparency cancels out, looking unchanged.
    poly(c, outline(0, 1), 'rgba(255,255,255,0.05)');
    const gb = c.createLinearGradient(0, yTop, 0, yBot);
    gb.addColorStop(0, 'rgba(230,244,252,0.20)');
    gb.addColorStop(1, 'rgba(183,216,238,0.30)');
    poly(c, outline(0, 1), gb, 'rgba(58,92,120,0.30)', 1);

    // Water: the lower half, transparent along with the jug body (lighter, paler blue; the bottom is still a bit heavier, but no longer smears into solid blue)
    const gw = c.createLinearGradient(0, project(pc.x, pc.y, BZ + LEVEL * BH).y, 0, yBot);
    gw.addColorStop(0, 'rgba(150,208,240,0.40)');
    gw.addColorStop(1, 'rgba(70,148,196,0.52)');
    poly(c, outline(0, LEVEL), gw);

    // Water surface: an ellipse + a bright edge (the body is transparent now, so the water line matters even more —— it is the key clue of "filled with water")
    const se = ell(LEVEL, 0.99);
    c.beginPath();
    c.ellipse(se.x, se.y, se.rx, se.ry, se.rot, 0, Math.PI * 2);
    c.fillStyle = 'rgba(186,226,248,0.42)';
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.45)';
    c.lineWidth = 1;
    c.stroke();

    // Ribs: those plastic hoops on the jug body (do not draw them too solid since the body is transparent)
    c.strokeStyle = 'rgba(70,110,145,0.18)';
    [0.34, 0.42, 0.5, 0.58].forEach((t) => {
      const e = ell(t, 0.995);
      c.beginPath();
      c.ellipse(e.x, e.y, e.rx, e.ry, e.rot, 0, Math.PI * 2);
      c.stroke();
    });

    // Vertical bands (one highlight / one dark side along the jug body): only a straight barrel reads as a cylinder
    const band = (thA, thB, fill) => {
      const pts = [];
      const n = 10;
      for (let i = 0; i <= n; i += 1) pts.push(at(ell(0.1 + 0.8 * (i / n)), thA));
      for (let i = n; i >= 0; i -= 1) pts.push(at(ell(0.1 + 0.8 * (i / n)), thB));
      poly(c, pts, fill);
    };
    const gh = c.createLinearGradient(0, yTop, 0, yBot);
    gh.addColorStop(0, 'rgba(255,255,255,0.34)');
    gh.addColorStop(0.7, 'rgba(255,255,255,0.12)');
    gh.addColorStop(1, 'rgba(255,255,255,0.04)');
    band(0.42, 0.95, gh);                                          // highlight on the right-front (the window is on that side)
    band(Math.PI - 0.95, Math.PI - 0.42, 'rgba(40,78,110,0.10)');  // dark side on the left-front
    // The **back wall** seen through the front wall (the far half): a very faint vertical band; most of the "transparent" feel comes from it
    band(Math.PI * 1.5 - 0.3, Math.PI * 1.5 + 0.3, 'rgba(140,186,216,0.12)');

    // Neck ring: the blue plastic ring where the jug mouth is inserted into the machine (drawn last, exactly covering the neck at the jug bottom)
    isoCylinder(c, { x: pc.x, y: pc.y, z: BZ - 0.03, r: 0.17, h: 0.07, color: '#2f6ea8' });

    // Small round cap on top of the jug: also a bit transparent (solid white would flatten it into a "decal")
    const te = ell(1);
    c.beginPath();
    c.ellipse(te.x, te.y, te.rx, te.ry, te.rot, 0, Math.PI * 2);
    c.fillStyle = 'rgba(238,246,252,0.55)';
    c.fill();
    c.strokeStyle = 'rgba(120,166,196,0.45)';
    c.lineWidth = 0.8;
    c.stroke();

    // A few bubbles in the water (the jug body is translucent, so the bubbles should not steal the show)
    [[0.1, -0.06, 0.2], [-0.09, 0.08, 0.36], [0.06, 0.11, 0.5], [-0.05, -0.09, 0.62]].forEach(([dx, dy, t]) => {
      const b = project(pc.x + dx, pc.y + dy, BZ + t * BH);
      c.beginPath();
      c.arc(b.x, b.y, 1.4, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255,255,255,0.4)';
      c.fill();
    });
  }

  /**
   * Magazine rack (pantry north wall, east section, see PANTRY.rack): a three-tier slanted display rack.
   *
   * How to make it "read as a magazine rack" in isometric, and not a small cabinet with a few books —— every point is for "the cover can be seen":
   *   1) **The rack runs along x, covers face +gy**: the camera looks straight at the +gy side, so a row of covers does not occlude each other.
   *      The first version sat against the west wall (rack along y), magazines lined up along y with each one covering the one before,
   *      leaving only a few 8px-wide slits —— in a screenshot it looked like colored wooden slats, not magazine covers;
   *   2) **Tiers slant toward +gy** (back edge high, front edge low): the cover tilts up a bit, reading more like "a cover standing up" than laid flat;
   *   3) End panels clamp the shelves + a kick plate below + a back panel behind: only then does the rack sit on the floor, otherwise the shelves look floating.
   *
   * One hard rule: **Math.random is not allowed**. The static layer is redrawn every frame (see buildStatics), and random colors would flash like a disco;
   * height / width / palette are all computed by index modulo (the same approach as the keyboards and cups on the workstations).
   */
  function drawMagRack(c, rk) {
    const X0 = rk.x;
    const X1 = rk.x + rk.w;
    const Y0 = rk.y;
    const Y1 = rk.y + rk.d;
    const zBase = 0.16; // kick plate top: the lowest shelf starts here
    const zTop = rk.h - 0.1; // upper limit of the top shelf
    const tiers = Math.max(1, rk.tiers || 3);
    const step = (zTop - zBase) / tiers;
    const lean = rk.lean == null ? 0.12 : rk.lean;
    const T = 0.05; // shelf / panel thickness
    const PT = 0.07; // end panel thickness
    /** Shelf surface height at some gy: back edge (Y0, the wall side) high, front edge (Y1) low */
    const zAt = (zb, gy) => zb + lean * ((Y1 - gy) / rk.d);
    /** Cover palette: on the bright side but not fluorescent (too loud at night and it competes with the main console for attention) */
    const COVERS = ['#e6ebf2', '#7fb0ff', '#d9744f', '#3fb950', '#f5a623', '#a98cf2', '#51c7c0'];

    isoShadow(c, (X0 + X1) / 2, (Y0 + Y1) / 2 + 0.1, rk.w * 0.46, 0.26);

    // Frame: back panel (against the wall) + kick plate + left end panel —— stand the rack up first, then fill in shelves and magazines
    isoBox(c, { x: X0, y: Y0, z: 0, w: rk.w, d: 0.05, h: rk.h, color: colors.metalDark });
    isoBox(c, { x: X0, y: Y0, z: 0, w: rk.w, d: rk.d, h: zBase, color: colors.metal });
    isoBox(c, { x: X0, y: Y0, z: 0, w: PT, d: rk.d, h: rk.h, color: colors.metal });

    for (let i = 0; i < tiers; i += 1) {
      const zb = zBase + i * step + 0.06;
      // ---- Shelf: slanted top + front face (in isometric only these two faces of a shelf face the camera) ----
      poly(
        c,
        [
          project(X0, Y0, zAt(zb, Y0) + T),
          project(X1, Y0, zAt(zb, Y0) + T),
          project(X1, Y1, zAt(zb, Y1) + T),
          project(X0, Y1, zAt(zb, Y1) + T),
        ],
        shade(colors.wood, 1.06)
      );
      poly(
        c,
        [
          project(X0, Y1, zAt(zb, Y1) + T),
          project(X1, Y1, zAt(zb, Y1) + T),
          project(X1, Y1, zAt(zb, Y1)),
          project(X0, Y1, zAt(zb, Y1)),
        ],
        shade(colors.wood, 0.66)
      );

      // ---- A row of magazines: standing side by side along x, leaning back (top edge closer to Y0, raising hj at the same time) ----
      const n = 5 + (i % 2); // 5~6 issues
      const slot = (rk.w - 0.2) / n;
      for (let j = 0; j < n; j += 1) {
        const xA = X0 + 0.1 + j * slot + slot * 0.14;
        const xB = xA + slot * 0.72;
        const hj = 0.2 + 0.035 * ((i * 7 + j * 5) % 3); // stagger the heights
        const yBot = Y1 - 0.09; // bottom edge near the front
        const yTp = Y0 + 0.11; // top edge leans back
        const zB = zAt(zb, yBot) + T;
        const zT = zAt(zb, yTp) + T + hj;
        const cover = COVERS[(i * 3 + j * 2) % COVERS.length];
        // Cover: the face toward +gy —— the camera looks straight at it, so the whole row is visible (the same kind of face as the lintel screen and the whiteboard)
        poly(
          c,
          [project(xA, yBot, zB), project(xB, yBot, zB), project(xB, yTp, zT), project(xA, yTp, zT)],
          shade(cover, 0.88),
          'rgba(10,13,19,0.5)',
          0.8
        );
      }
    }

    // Right end panel drawn last: the camera is on the +x side, so it is the piece closest to the camera, tucking the ends of the shelves and magazines into the rack
    isoBox(c, { x: X1 - PT, y: Y0, z: 0, w: PT, d: rk.d, h: rk.h, color: colors.metal });
  }

  /**
   * Desk nameplate: a small nameplate laid flat on the desk (replacing the one that used to hang on the divider), writing only the member's name.
   * The text is skew-mapped along the desk's own two axes (AX / AY) and laid on the desk; the level color strip is kept (user blue / project green).
   * The text stays ~10px on screen: first back-compute the world font size from the camera, then shrink proportionally when the name is longer than the plate.
   */
  function drawDeskTag(c, { x, y, z, text, accent, maxW = 0.85, flip = false, alignRight = false }) {
    const fsPx = 10 / cam.zoom;
    c.font = `600 ${fsPx}px ui-sans-serif, system-ui, sans-serif`;
    const w = Math.max(0.5, Math.min(maxW, c.measureText(text).width / UNIT_Z + 0.22));
    const d = 0.3;
    // alignRight: x is the plate's right edge (when flush against the desk side, the plate width varying with the name still aligns to the desk edge)
    const tx = alignRight ? x - w : x;
    // Level color strip: normally on the west side; with flip (north desk) it moves to the opposite side (east) along with the text ——
    // from the seated gremlin's view, the strip is always to the left of the text
    const stripX = flip ? tx + w - 0.07 : tx;
    // Plate base (light) + a level color strip
    isoDiamond(c, { x: tx, y, w, d, z, fill: '#eef2f8', stroke: 'rgba(18,24,34,0.4)', lw: 0.8 });
    isoDiamond(c, { x: stripX, y, w: 0.07, d, z: z + 0.001, fill: accent });
    // Name: skew-mapped along the desk axes (local u along +gx, v along +gy, unit tile).
    // flip=true (north desk): rotate 180° about the plate center; the text is upside down to the camera, upright to the gremlin sitting on the north side
    let fsTile = fsPx / UNIT_Z;
    const tw = c.measureText(text).width / UNIT_Z;
    if (tw > w - 0.16) fsTile *= (w - 0.16) / tw;
    const cx = flip ? (w - 0.09) / 2 : 0.09 + (w - 0.09) / 2; // text center (leaving room on the strip side)
    const o = flip ? project(tx + w, y + d, z + 0.002) : project(tx, y, z + 0.002);
    c.save();
    if (flip) c.transform(-AX.x, -AX.y, -AY.x, -AY.y, o.x, o.y);
    else c.transform(AX.x, AX.y, AY.x, AY.y, o.x, o.y);
    c.font = `600 ${fsTile}px ui-sans-serif, system-ui, sans-serif`;
    c.fillStyle = '#2c3442';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, flip ? w - cx : cx, d / 2);
    c.restore();
  }

  function drawPlant(c, p) {
    isoCylinder(c, { x: p.x, y: p.y, z: 0, r: 0.3, h: 0.36, color: '#b3653f' });
    const t = project(p.x, p.y, 0.36);
    c.save();
    c.translate(t.x, t.y);
    c.scale(p.s, p.s);
    c.fillStyle = colors.plant;
    c.beginPath();
    c.ellipse(0, -16, 13, 16, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#4f9e63';
    c.beginPath();
    c.ellipse(-11, -7, 8, 11, -0.4, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.ellipse(11, -9, 8, 11, 0.4, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  /**
   * Blinds (translucent): horizontal slats on the glass face toward the camera.
   * Face orientation matches wallQuad: axis='x' face has fixed gx (a0/a1 are the gy range); axis='y' face has fixed gy (a0/a1 are the gx range).
   *
   * Look-and-feel points (otherwise it looks like "white horizontal stripes stuck on"):
   *   1) Each slat uses a **screen-vertical gradient**: top edge lit (thin bright rim) -> mid-gray face -> bottom edge in shadow (dark), giving volume,
   *      instead of one flat color;
   *   2) The whole blind adds another **bright-top dark-bottom** falloff (higher up is closer to the window light), separating the vertical layers;
   *   3) Gaps between slats let the glass show through, the whole layer semi-transparent -> translucent, silhouettes visible through the blind;
   *   4) Top rail + pull cords on both sides + bottom rail, finishing the edges, no longer a uniformly tiled band.
   */
  function drawBlinds(c, o) {
    const { axis, fixed, a0, a1, z0 = 0, z1, base = '#6f849c', alpha = 0.92, pitch = 0.155, slatH = 0.1 } = o;
    const railH = 0.14;
    const baseGap = 0.07;
    const span = a1 - a0;
    const pAt = (a, z) => (axis === 'x' ? project(a, fixed, z) : project(fixed, a, z));

    c.save();
    c.globalAlpha *= alpha;

    // Slats: bottom to top; higher up is brighter (window light comes from above), separating the vertical light-dark contrast more
    for (let z = z0 + baseGap; z + slatH <= z1 - railH + 1e-6; z += pitch) {
      const k = 0.5 + 0.62 * ((z + slatH / 2) / z1);
      const pT = pAt(a0, z + slatH);
      const pB = pAt(a0, z);
      const g = c.createLinearGradient(pT.x, pT.y, pB.x, pB.y);
      g.addColorStop(0, shade(base, k * 1.42)); // lit top edge
      g.addColorStop(0.14, shade(base, k * 1.02));
      g.addColorStop(0.6, shade(base, k * 0.74));
      g.addColorStop(1, shade(base, k * 0.4)); // backlit slat bottom
      wallQuad(c, axis, fixed, a0, a1, z, z + slatH, g);
    }

    // Top rail (solid dark) + a highlight, covering the top slat
    wallQuad(c, axis, fixed, a0, a1, z1 - railH, z1, '#242d38');
    wallQuad(c, axis, fixed, a0, a1, z1 - railH * 0.36, z1, '#4b586a');
    // Bottom rail
    wallQuad(c, axis, fixed, a0, a1, z0, z0 + baseGap - 0.01, shade(base, 0.7));
    // Pull cords on both sides
    [a0 + span * 0.055, a1 - span * 0.075].forEach((a) => {
      wallQuad(c, axis, fixed, a, a + Math.min(0.028, span * 0.02), z0, z1 - railH, 'rgba(14,19,27,0.72)');
    });

    c.restore();
  }

  /**
   * Meeting room / pantry signs: the whole block (plate background + text) is skew-mounted along the wall parallelogram, achieving "parallel to the wall"
   * (not floating horizontally). AX is slanted 30°, AZ is vertical, so the text's bottom edge follows the wall slant while vertical strokes stay upright.
   * Uses a function declaration (hoisting): buildStatics calls it during construction (the pantry sign must be drawn after the blinds).
   */
  function drawWallLabel(c, text, gx, gy, gz) {
    const tc = makeWallText(text);
    const W = tc.width;
    const H = tc.height;
    const halfH = 0.34; // sign half-height (world units), must fit within the wall height
    const halfW = halfH * (W / H); // proportional to the bitmap, so the text is not stretched
    // The three corners of the wall quad (gy constant): sD=top-left sC=top-right sA=bottom-left
    const sD = project(gx - halfW, gy, gz + halfH);
    const sC = project(gx + halfW, gy, gz + halfH);
    const sA = project(gx - halfW, gy, gz - halfH);
    // Affine: map the bitmap (0..W,0..H) onto the wall parallelogram (skew around the wall)
    const a = (sC.x - sD.x) / W;
    const b = (sC.y - sD.y) / W;
    const cc = (sA.x - sD.x) / H;
    const d = (sA.y - sD.y) / H;
    c.save();
    c.transform(a, b, cc, d, sD.x, sD.y);
    c.drawImage(tc, 0, 0);
    c.restore();
  }

  /**
   * Metal vertical face (the divider's aluminum frame south / east face): screen-vertical gradient, from (gx,gy,z1) to (gx,gy,z0).
   * The gradient must take its coordinates hugging **the actual face** —— if you just take a vertical line at the origin by z,
   * the face is far outside the gradient range, and the part beyond it only gets the end color
   * (the south face becomes one block of 0.5 dark, the same color as the board, and the frame "disappears").
   * How to read brushed aluminum —— top edge a lit bright band (specular highlight) -> quickly falls back to the base tone -> bottom edge darkened;
   * k steps down the whole backlit face (east ≈ 0.72 of south, matching the original shade 0.8 / 0.58 ratio).
   */
  function metalFace(c, base, gx, gy, z0, z1, k = 1) {
    const pT = project(gx, gy, z1);
    const pB = project(gx, gy, z0);
    const g = c.createLinearGradient(pT.x, pT.y, pB.x, pB.y);
    g.addColorStop(0, shade(base, 1.62 * k)); // top edge highlight
    g.addColorStop(0.16, shade(base, 1.06 * k));
    g.addColorStop(0.55, shade(base, 0.82 * k)); // base tone (≈ original south 0.8)
    g.addColorStop(1, shade(base, 0.5 * k)); // bottom edge darkened
    return g;
  }

  /** Metal top face: brightening gradient along the depth direction —— north edge (far) brighter, like skylight grazing the frame top */
  function metalTop(c, base, y, d, z) {
    const pN = project(0, y, z);
    const pS = project(0, y + d, z);
    const g = c.createLinearGradient(pN.x, pN.y, pS.x, pS.y);
    g.addColorStop(0, shade(base, 1.5));
    g.addColorStop(1, shade(base, 1.1));
    return g;
  }

  /**
   * Sticky note on the divider: a small tilted square of paper + a magnet pin pressing on its top edge.
   *
   * Both the paper and the magnet are stuck on the divider's **face toward the camera** (gy = board south edge + 0.002, lifted a hair so it does not fight the board face),
   * i.e. both lie in the (gx, gz) vertical plane. Method: first rotate the four corners "askew" around the paper's center within the plane,
   * then project each corner —— under the oblique projection the square naturally becomes a parallelogram, fitting the board face exactly,
   * instead of a decal facing the camera and floating in front of the board.
   *
   * The magnet is a disk (its face parallel to the board face), which projects to a **slanted ellipse**: the two in-plane axes AX / AZ
   * project to equal length (44px) but at 120°; when equal conjugate radii form 120°, the ellipse's semi-axes are
   * 44r·√1.5 (major, along screen 60°) and 44r·√0.5 (minor, along −30°),
   * so just feed those to ctx.ellipse's rotation.
   *
   * Paper and ink colors come from this floor's palette (colors.note / colors.noteInk): the base floors (1F/2F) are sticky-note yellow, 3F is cool violet,
   * and they change with applyFloor() when switching floors —— the note is static furniture and gets rebuilt into statics.
   */
  function drawDividerNote(c, p, note) {
    const y = p.y + p.d + 0.002;
    const th = (note.tilt * Math.PI) / 180;
    const co = Math.cos(th);
    const si = Math.sin(th);
    /** In-plane local coordinates (u along gx, v along gz, rotated by tilt about the paper center) -> screen point */
    const at = (u, v) => project(note.x + u * co - v * si, y, note.z + u * si + v * co);
    const hw = note.w / 2;
    const hh = note.h / 2;
    /** Four corners (du/dv = translation of the whole paper within the plane, used to draw the shadow) */
    const quad = (du = 0, dv = 0) => [
      at(-hw + du, hh + dv),
      at(hw + du, hh + dv),
      at(hw + du, -hh + dv),
      at(-hw + du, -hh + dv),
    ];

    // Shadow: light comes from the upper left, the shadow shifts a bit to the board's lower-right, so the paper "floats" on the board face instead of being printed on it
    poly(c, quad(0.03, -0.03), 'rgba(8,11,16,0.35)');

    // Paper face: bright top, dark bottom (top edge lit)
    const pT = at(0, hh);
    const pB = at(0, -hh);
    const gp = c.createLinearGradient(pT.x, pT.y, pB.x, pB.y);
    gp.addColorStop(0, shade(colors.note, 1.14));
    gp.addColorStop(1, shade(colors.note, 0.8));
    poly(c, quad(), gp, 'rgba(24,20,8,0.35)', 0.7);

    // A dark band along the bottom edge: the note's bottom curls up slightly, and this band is the curl's shadow falling on the paper
    poly(c, [at(-hw, -hh), at(hw, -hh), at(hw, -hh + 0.055), at(-hw, -hh + 0.055)], 'rgba(20,16,4,0.16)');

    // Two handwriting strokes (under 1px, just to make it read as a "note with writing" and not a color block)
    c.save();
    c.strokeStyle = rgba(colors.noteInk, 0.5);
    c.lineWidth = 0.7;
    c.lineCap = 'round';
    [[-0.085, -0.03, 0.105], [-0.095, -0.09, 0.07]].forEach(([u0, v, len]) => {
      const a = at(u0, v);
      const b = at(u0 + len, v);
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.stroke();
    });
    c.restore();

    // Magnet pin: pressing on the top edge of the paper, centered —— dark outer ring (thickness) + metal face + a bit of highlight
    const r = note.magnet;
    const mj = UNIT_Z * r * Math.sqrt(1.5);
    const mn = UNIT_Z * r * Math.sqrt(0.5);
    const ROT = Math.PI / 3;
    const mc = at(0, hh - r - 0.03);
    c.beginPath();
    c.ellipse(mc.x, mc.y, mj * 1.3, mn * 1.3, ROT, 0, Math.PI * 2);
    c.fillStyle = 'rgba(10,14,20,0.5)';
    c.fill();
    const gm = c.createLinearGradient(mc.x, mc.y - mj, mc.x + mj * 0.5, mc.y + mj);
    gm.addColorStop(0, shade(MAGNET, 1.32));
    gm.addColorStop(0.55, shade(MAGNET, 0.95));
    gm.addColorStop(1, shade(MAGNET, 0.5));
    c.beginPath();
    c.ellipse(mc.x, mc.y, mj, mn, ROT, 0, Math.PI * 2);
    c.fillStyle = gm;
    c.fill();
    c.beginPath();
    c.ellipse(mc.x - mj * 0.16, mc.y - mn * 0.26, mj * 0.4, mn * 0.42, ROT, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.fill();
  }

  /** Pre-generate the static object list (participates in sorting every frame) */
  function buildStatics() {
    /** @type {{depth:number,draw:(c:CanvasRenderingContext2D, now:number)=>void}[]} */
    const items = [];
    const push = (depth, draw) => items.push({ depth, draw });

    /**
     * Enqueue one chair: the base and the back are sorted separately.
     * When the back faces north (back to the camera) the whole chair is drawn before the person —— the back is behind the person anyway;
     * when the back faces south (between the person and the camera, i.e. the "chair facing the window" row) the back must be sorted **after** the person:
     * only when the seated person's lower half is pressed by the back does it read as "sitting in the chair", otherwise the person looks like standing in front of the chair.
     */
    const pushChair = (x, y, backAtNorth) => {
      push(depthOf(x, y) - 0.02, (c) => {
        drawChairBase(c, x, y);
        if (backAtNorth) drawChairBack(c, x, y, true);
      });
      if (!backAtNorth) push(depthOf(x, y + 0.24), (c) => drawChairBack(c, x, y, false));
    };

    /* Workstations (1): dividers (aluminum frame) —— one for each of the 6 face-to-face pair desks */
    DIVIDERS.forEach((p) => {
      // Fallback: during HMR we may get "a new officeMap divider object + old engine" or half data ——
      // in that case, better to draw one divider fewer than to fail building the whole office (white screen).
      if (!p || !p.northDesk || !p.southDesk) return;
      /**
       * The divider is one 3.2-wide block, but the whole block can only take one depth (= center x+y) for sorting:
       * a sprite in the corridor has depth = x+y, and walking to the back half of the board exceeds the board's center depth,
       * so it gets drawn **in front of** the board —— looking like "coming out through the board".
       * Cutting it into 4 segments that sort separately localizes the occlusion: in front of the board sorts after, behind the board sorts before.
       */
      const SEG = 4;
      const segW = p.w / SEG;
      const natSegDepth = (s) => depthOf(p.x + (s + 0.5) * segW, p.y + p.d / 2);
      /**
       * Each segment's depth is clamped between **this pair's two desks**:
       *   floor = after the north desk (including items on it) -> the divider is in front of it and must press it;
       *   ceil = before the south desk **itself** (ds − 0.01) -> the south desk is closer to the camera and must be able to press the divider (legs included).
       * If ceil is too large: the natural depth of the segments with larger x exceeds the south desk, and even clamped to ds + 0.39 they are still drawn
       * **after** the south desk —— the divider's east end covers the south desk's east edge and east legs, looking like "you cannot see the front desk legs on the right,
       * the board sticks out past the desktop, the desktop climbs onto the board". So ceil must be strictly less than the south desk's own depth.
       */
      const dn = depthOf(p.northDesk.x + p.northDesk.w / 2, p.northDesk.y + p.northDesk.d / 2);
      const ds = depthOf(p.southDesk.x + p.southDesk.w / 2, p.southDesk.y + p.southDesk.d / 2);
      const floor = dn + 0.4 + 0.01;
      const ceil = ds - 0.01;
      const segDepth = (s) => Math.min(ceil, Math.max(floor, natSegDepth(s))) + s * 0.0005; // segments still keep their left->right ordering

      // Ground shadow: use the natural depth, so it is not clamped upward and covers the desks behind
      push(natSegDepth(0) - 0.5, (c) => {
        isoDiamond(c, {
          x: p.x - 0.06,
          y: p.y + p.d - 0.06,
          w: p.w + 0.12,
          d: 0.28,
          z: 0.002,
          fill: '#0b0e14',
          alpha: 0.5,
        });
      });

      /**
       * Dark metal frame: the **same thickness** as the board body (FD = 0, does not protrude), all four sides equally wide.
       * Bright aluminum + thicker than the board would make the frame read as a light-colored skeleton independent of the board; darkened and equal-thickness,
       * the whole divider reads as "a board with an edge trim".
       */
      const FR = p.frame || 0.05;
      const FD = 0;
      const ALU = colors.dividerFrame;
      /**
       * The board body yields FR on each side, giving those two strips to the vertical frames:
       * so the vertical frames **land on the strip at the board edge, not on the board face** (frame outer edge = board's total outer edge = desk left/right edges).
       * Previously the body spanned the full width and the vertical frames were drawn later, so the frame straddled in front of the board face —— looking like "a post standing in front of the board",
       * with the wrong occlusion.
       */
      const bodySegW = (p.w - 2 * FR) / SEG;
      for (let s = 0; s < SEG; s += 1) {
        // Draw 0.01 extra between segments to press the seam; the overflow is covered by the next segment
        push(segDepth(s), (c) => {
          /**
           * Board body: opaque dark gray, on the floor, no base.
           * Its height is squeezed out of three conditions: "protrude past the desktop by half + the north desk stays readable + the nameplate presses into the board face"
           * (derivation in officeMap's DIVIDER_H comment): any taller and the north desk is cut to a sliver stopping at the board top
           * ("the desktop climbs onto the divider"); any shorter and the nameplate does not press into the board face.
           */
          isoBox(c, { x: p.x + FR + s * bodySegW, y: p.y, w: bodySegW + 0.01, d: p.d, h: p.h, color: colors.divider });
          /**
           * Top horizontal frame: follows the segment (a single-depth whole strip would sort wrong and get drawn on the wrong side of the desk).
           * Drawn after the board body: its top face is coplanar with the board top, and the later-drawn strip presses out the "edge trim"; the south face presses the top strip onto the board front;
           * the east end face is covered by the next board segment, so the seam does not show.
           */
          isoBox(c, {
            x: p.x + FR + s * bodySegW, y: p.y, z: p.h - FR, w: bodySegW + 0.01, d: p.d, h: FR, color: ALU,
            south: metalFace(c, ALU, p.x + FR + s * bodySegW, p.y + p.d, p.h - FR, p.h, 1),
            east: metalFace(c, ALU, p.x + FR + (s + 1) * bodySegW, p.y, p.h - FR, p.h, 0.72),
            top: metalTop(c, ALU, p.x + FR + s * bodySegW, p.y, p.d, p.h),
          });
          /**
           * The bottom horizontal frame draws only the front strip (wallQuad), not a box:
           * a box from z 0..FR is entirely buried in the volume at the board body's foot, and its top face should physically be blocked by the body ——
           * drawing a box would make that bright top edge float in front of the board root; the only way not to leak it is to have no such face at all.
           * This front strip pokes 0.001 past the board face, to avoid fighting the board's south face.
           */
          wallQuad(c, 'y', p.y + p.d + 0.001, p.x + FR + s * bodySegW, p.x + FR + (s + 1) * bodySegW + 0.01, 0, FR, metalFace(c, ALU, p.x + FR + s * bodySegW, p.y + p.d, 0, FR, 1));
        });
      }
      /**
       * Left vertical frame: must be drawn **before** segment 0's board body (enqueued at the same depth but later = drawn after the body,
       * and the east side face floats on the board face —— that is exactly how it broke before). It hugs the board body's west end,
       * its east side face is entirely buried in the board body's volume, and the later-drawn body (top + south faces) covers it exactly;
       * its front strip does not overlap the body (the body starts at p.x+FR), so it is still visible.
       */
      push(segDepth(0) - 0.0005, (c) => {
        isoBox(c, {
          x: p.x, y: p.y - FD / 2, w: FR, d: p.d + FD, h: p.h, color: ALU,
          south: metalFace(c, ALU, p.x, p.y + p.d, 0, p.h, 1),
          east: metalFace(c, ALU, p.x + FR, p.y, 0, p.h, 0.72),
          top: metalTop(c, ALU, p.x, p.y - FD / 2, p.d + FD, p.h),
        });
      });
      // Right vertical frame: its east face is the divider's outer surface (should be visible), sorted after the last board segment,
      // incidentally covering the 0.01 extra drawn at the body segment seams.
      push(segDepth(SEG - 1) + 0.0002, (c) => {
        isoBox(c, {
          x: p.x + p.w - FR, y: p.y - FD / 2, w: FR, d: p.d + FD, h: p.h, color: ALU,
          south: metalFace(c, ALU, p.x + p.w - FR, p.y + p.d, 0, p.h, 1),
          east: metalFace(c, ALU, p.x + p.w, p.y, 0, p.h, 0.72),
          top: metalTop(c, ALU, p.x + p.w - FR, p.y - FD / 2, p.d + FD, p.h),
        });
      });
      /**
       * Sticky note (+ magnet pin): sorted **after the last board segment and the right vertical frame** —— it is stuck on the board face,
       * so it must press on top of the board; and it is strictly less than the south desk's depth (ceil = ds − 0.01),
       * so even if the paper's bottom edge reaches desktop height, it is still correctly cut by the later-drawn south desk and does not float in front of the desk.
       */
      if (p.note) push(segDepth(SEG - 1) + 0.0004, (c) => drawDividerNote(c, p, p.note));

      // Nameplates no longer hang on the divider: moved to each desk top (see drawDeskTag in the DESK_UNITS section)
    });

    /* Workstations (2): chairs / desks / items on the desk (monitor, keyboard, cup) */
    DESK_UNITS.forEach((u, i) => {
      const deskDepth = depthOf(u.desk.x + u.desk.w / 2, u.desk.y + u.desk.d / 2);

      // Chair (the base is drawn before the person; the back on the camera-facing row is sorted after the person by pushChair).
      // The back's facing follows "face-to-face": face='south' (north row, facing +gy) back faces north -> true; the south row is the opposite -> false
      pushChair(u.chair.x, u.chair.y, u.face === 'south');

      // Desk
      push(deskDepth, (c) => {
        const { x, y, w, d, h } = u.desk;
        // Four legs
        isoBox(c, { x: x + 0.1, y: y + 0.1, z: 0, w: 0.1, d: 0.1, h: h - 0.06, color: colors.deskLeg });
        isoBox(c, { x: x + w - 0.2, y: y + 0.1, z: 0, w: 0.1, d: 0.1, h: h - 0.06, color: colors.deskLeg });
        isoBox(c, { x: x + 0.1, y: y + d - 0.2, z: 0, w: 0.1, d: 0.1, h: h - 0.06, color: colors.deskLeg });
        isoBox(c, { x: x + w - 0.2, y: y + d - 0.2, z: 0, w: 0.1, d: 0.1, h: h - 0.06, color: colors.deskLeg });
        // Desk top
        isoBox(c, { x, y, z: h - 0.08, w, d, h: 0.08, color: colors.wood });
      });

      // Items on the desk (depth a bit more than the desk -> pressed onto the desktop)
      push(deskDepth + 0.4, (c, now) => {
        const z = u.desk.h;
        const m = u.monitor;
        const kb = u.keyboard;
        const a = agents.find((ag) => ag.home === i);

        /**
         * Monitor: base + stand + panel (a thin box as the bezel).
         * South desk (face='north'): the screen faces the camera (and the user), drawScreen is drawn on the panel's front;
         * North desk (face='south'): the user sits facing south, the screen faces north —— the camera sees the **back**,
         * so draw two horizontal vent lines + a center logo plate, to read as "the monitor's back shell" and not a blackboard.
         */
        const drawMonitor = () => {
          isoBox(c, { x: m.x + m.w / 2 - 0.2, y: m.y + 0.01, z, w: 0.4, d: 0.15, h: 0.03, color: '#202735' });
          isoBox(c, { x: m.x + m.w / 2 - 0.03, y: m.y + 0.02, z: z + 0.03, w: 0.06, d: 0.1, h: 0.09, color: '#242c3a' });
          isoBox(c, { x: m.x, y: m.y, z: z + 0.12, w: m.w, d: m.d, h: m.h, color: '#1b2230' });
          if (u.face === 'north') {
            drawScreen(
              c,
              { x: m.x, y: m.y, z: z + 0.12, w: m.w, d: m.d, h: m.h },
              levelColor(a && a.level),
              i * 977 + 13,
              Boolean(a), // empty workstation: screen off
              now // timeline for the typing animation + bottom bar
            );
          } else {
            const backY = m.y + m.d + 0.001;
            const z0 = z + 0.12;
            wallQuad(c, 'y', backY, m.x + 0.12, m.x + m.w - 0.12, z0 + m.h * 0.3, z0 + m.h * 0.36, 'rgba(120,140,170,0.22)');
            wallQuad(c, 'y', backY, m.x + 0.12, m.x + m.w - 0.12, z0 + m.h * 0.42, z0 + m.h * 0.48, 'rgba(120,140,170,0.16)');
            wallQuad(c, 'y', backY + 0.001, m.x + m.w / 2 - 0.055, m.x + m.w / 2 + 0.055, z0 + m.h * 0.58, z0 + m.h * 0.58 + 0.09, '#31405a', 'rgba(140,170,210,0.35)', 0.8);
            /**
             * Power indicator light: on the back's lower edge, pulled a bit toward center from the lower-right corner (not dead center —— center looks like a camera),
             * a small 3×1 horizontal line (parallel to the monitor's horizontal edges: the gx axis is 30° on screen, not window-horizontal).
             *   · Seated (powered and running): cyan-blue, opacity breathing 0.3 → 1.0 → 0.3, period 1.8s, staggered phase per workstation;
             *   · Empty workstation (standby): switch to a **dim blue glow**, steady, no breathing —— the north row only shows the monitor's back shell,
             *     and this light conveys "the machine is powered, the screen is dim-blue standby", not that this one is broken.
             */
            const breath = a
              ? 0.3 + 0.7 * (0.5 + 0.5 * Math.sin((now / 1000) * ((Math.PI * 2) / 1.8) + i * 0.9))
              : 0.2;
            const lp = project(m.x + m.w * 0.72, backY + 0.002, z0 + 0.05);
            const gl = c.createRadialGradient(lp.x, lp.y, 0, lp.x, lp.y, 4);
            gl.addColorStop(0, `rgba(79,195,247,${(a ? 0.15 : 0.05) * breath})`);
            gl.addColorStop(1, 'rgba(79,195,247,0)');
            c.beginPath();
            c.arc(lp.x, lp.y, 4, 0, Math.PI * 2);
            c.fillStyle = gl;
            c.fill();
            c.save();
            c.globalAlpha *= breath;
            c.fillStyle = a ? '#4FC3F7' : '#3d6d99';
            c.translate(lp.x, lp.y);
            c.rotate(Math.atan2(AX.y, AX.x));
            c.fillRect(-1.5, -0.5, 3, 1);
            c.restore();
          }
        };

        /**
         * Keyboard: a thin base plate + three rows of keycaps on top (small light diamonds).
         * Keycaps are not drawn with thickness (a box under 3px shows no volume; flat small cells read as a keyboard at a glance).
         * A mouse to the keyboard's right: base shadow + a bright small hump + a center line as the scroll wheel.
         */
        const drawKeyboard = () => {
          isoBox(c, { x: kb.x, y: kb.y, z, w: kb.w, d: kb.d, h: 0.025, color: '#242c3a' });
          const ROWS = 3;
          const COLS = 7;
          for (let r = 0; r < ROWS; r += 1) {
            for (let q = 0; q < COLS; q += 1) {
              isoDiamond(c, {
                x: kb.x + 0.05 + q * ((kb.w - 0.1) / COLS),
                y: kb.y + 0.04 + r * ((kb.d - 0.08) / ROWS),
                w: (kb.w - 0.1) / COLS - 0.02,
                d: (kb.d - 0.08) / ROWS - 0.015,
                z: z + 0.026,
                fill: '#454f61',
              });
            }
          }
          /**
           * Mouse: an ellipse elongated along the desk's front-back (the gy axis on screen), colored in the same dark gray-blue family as the keyboard.
           * Positioned on the user's **right hand side**: south desk (back to the camera) right hand is east (the keyboard's +x side),
           * north desk (facing the camera) right hand is west (the keyboard's −x side) —— the two rows are not the same screen direction, so they cannot be mirrored.
           *
           * The base shadow's offset direction is the opposite of local +y: local +y points up-left on screen,
           * so the shadow must go toward local −y to land at the **lower-right** (matching light from the upper-left).
           */
          const mx = u.face === 'north' ? kb.x + kb.w + 0.1 : kb.x - 0.1;
          const my = kb.y + kb.d / 2;
          const pM = project(mx, my, z + 0.045);
          const mAng = Math.atan2(AY.y, AY.x); // direction of the gy axis on screen
          c.save();
          c.translate(pM.x, pM.y);
          c.rotate(mAng);
          c.beginPath();
          c.ellipse(0, -0.9, 4.7, 2.9, 0, 0, Math.PI * 2); // base shadow -> lower-right
          c.fillStyle = '#161c26';
          c.fill();
          c.beginPath();
          c.ellipse(0, 0, 4.5, 2.75, 0, 0, Math.PI * 2); // mouse body (same color family as the keyboard)
          c.fillStyle = '#39424f';
          c.fill();
          c.strokeStyle = '#4b5666';
          c.lineWidth = 0.7;
          c.stroke();
          c.beginPath(); // front scroll-wheel bright line
          c.moveTo(-1.7, 0);
          c.lineTo(-3.6, 0);
          c.strokeStyle = '#5b6779';
          c.stroke();
          c.restore();
        };

        /**
         * One behind the other, whichever is closer to the camera is drawn later:
         * North desk's monitor is south of the keyboard (closer to the camera) -> monitor drawn later, keyboard is pressed by it
         * (the workstation opposite sees the monitor's back shell blocking the keyboard); south desk's keyboard is on the south -> keyboard drawn later.
         */
        if (u.face === 'south') {
          drawKeyboard();
          drawMonitor();
        } else {
          drawMonitor();
          drawKeyboard();
        }

        /**
         * Nameplate: laid flat at the "lower-left corner after sitting down" of one's own desk (keeping the level color strip), flush against the desk's left edge.
         * North desk (sitting facing +gy): the left-hand side is the east -> flush against the desk's east edge, near one's own north edge,
         *   the text flipped 180° and the strip moved to the opposite side —— upside down to the camera, upright to the gremlin sitting there;
         * South desk (sitting with back to the camera): the left-hand side is the west -> flush against the desk's west edge, near one's own south edge,
         *   the text toward the camera, already upright as seen by the seated gremlin.
         */
        if (a) {
          const common = { z: z + 0.002, text: a.name, accent: levelColor(a.level) };
          if (u.face === 'south') {
            // North desk: shift toward the divider (y 0.22..0.52). The limit is the plate's south edge >0.47 from the divider
            // (the divider is 1.21 tall, hiding things below 1.21−Δ behind it; plate face z=0.74 → needs Δ>0.47 to be fully exposed),
            // 0.52 is 0.53 from the divider, just still above the occlusion line and fully visible.
            drawDeskTag(c, { ...common, x: u.desk.x + u.desk.w - 0.02, y: u.desk.y + 0.22, flip: true, alignRight: true });
          } else {
            // South desk: likewise shifted a small amount toward the divider (y 0.55..0.85); the divider is behind it, so no occlusion
            drawDeskTag(c, { ...common, x: u.desk.x + 0.02, y: u.desk.y + 0.55 });
          }
        }
      });
    });

    /* Meeting room */
    const mt = MEETING.table;
    push(depthOf(mt.x + mt.w / 2, mt.y + mt.d / 2), (c) => {
      isoBox(c, { x: mt.x + 0.15, y: mt.y + 0.2, z: 0, w: 0.18, d: 0.18, h: mt.h - 0.08, color: colors.deskLeg });
      isoBox(c, { x: mt.x + mt.w - 0.33, y: mt.y + mt.d - 0.38, z: 0, w: 0.18, d: 0.18, h: mt.h - 0.08, color: colors.deskLeg });
      isoBox(c, { x: mt.x, y: mt.y, z: mt.h - 0.1, w: mt.w, d: mt.d, h: 0.1, color: colors.wood });
      // On the table: a stack of papers + a projector
      isoBox(c, { x: mt.x + 1.1, y: mt.y + 0.55, z: mt.h, w: 0.5, d: 0.4, h: 0.04, color: '#e6ebf2' });
      isoBox(c, { x: mt.x + 1.9, y: mt.y + 0.6, z: mt.h, w: 0.42, d: 0.3, h: 0.12, color: '#2b3140' });
    });

    // The first half of the chairs are on the table's north side (back facing north), the second half on the south side (back facing the camera -> sorted after people sit)
    MEETING.chairs.forEach((ch, i) => pushChair(ch.x, ch.y, i < 4));

    // Glass partition (semi-transparent) + the translucent blinds on its camera-facing side.
    //
    // Why both the "glass face" and the "blinds" must be enqueued **in segments** by face coordinate: the isometric sort key is gx+gy (a scalar),
    // while these glass panes span several tiles. If the whole pane took a single midpoint key (plus +0.6 to clear the people inside), things on its low-coordinate side
    // that are actually stuck **in front of** the glass (the pantry north wall's water cooler, a gremlin walking up to it for water) would count as being behind the glass ——
    // so that 16% translucent glass face would press on them, appearing as "the water cooler is partly hidden by the glass / blinds".
    // Cutting by face coordinate into small segments, each with its own midpoint depth, restores the true local front-back order:
    //   - Things "behind" the glass (room side): key always less than the matching segment -> drawn first, covered by the glass / blinds ✓
    //   - Things "in front of" the glass (water cooler / printer / a gremlin standing at the cooler): key always greater than the matching segment -> drawn later ✓
    // The glass face is drawn segment by segment with wallQuad (not one isoBox, nor several isoBoxes): adjacent segments share edges without overlapping,
    // so it neither exposes isoBox end-face seams nor stacks the 0.16 alpha into a dark line at the seams.
    const gh = MEETING.glass.h;
    /** One glass face + (optionally) the blinds on its camera-facing side, cut into segments by face coordinate and enqueued separately: axis='x' cuts along gy, axis='y' along gx */
    const pushGlassFace = ({ axis, fixed, a0, a1, segW, h = gh, blinds = true }) => {
      const n = Math.max(1, Math.ceil((a1 - a0) / segW));
      const w = (a1 - a0) / n;
      for (let i = 0; i < n; i += 1) {
        const s0 = a0 + i * w;
        const s1 = s0 + w;
        const mid = (s0 + s1) / 2;
        const d = depthOf(axis === 'x' ? fixed : mid, axis === 'x' ? mid : fixed);
        push(d, (c) => wallQuad(c, axis, fixed, s0, s1, 0, h, rgba(colors.glass, 0.16)));
        if (blinds) push(d + 0.0005, (c) => drawBlinds(c, { axis, fixed, a0: s0, a1: s1, z0: 0, z1: h }));
      }
    };
    // West face: two segments, with the doorway in the middle (blinds hang per panel, so the doorway is naturally empty); the big face is the +gx face (x = right edge)
    [MEETING.glass.westA, MEETING.glass.westB].forEach((g) => {
      pushGlassFace({ axis: 'x', fixed: g.x + g.w, a0: g.y, a1: g.y + g.d, segW: 0.8 });
    });
    // South face: one whole strip; the big face is the +gy face (y = front edge)
    const gs = MEETING.glass.south;
    pushGlassFace({ axis: 'y', fixed: gs.y + gs.d, a0: gs.x, a1: gs.x + gs.w, segW: 0.7 });
    // Pantry sign: stuck on the camera-facing side of this south glass (= the pantry's north wall).
    // The blinds are segmented with different depths, so the sign must be sorted **after all blind segments**: take the depth at this glass's far-right end and lift it a bit.
    push(depthOf(gs.x + gs.w, gs.y + gs.d) + 0.3, (c) => {
      drawWallLabel(c, t('wall.pantry'), PANTRY.x + PANTRY.w / 2, PANTRY.y, 1.7);
    });

    /* Pantry */
    const pt = PANTRY.table;
    push(depthOf(pt.x + pt.w / 2, pt.y + pt.d / 2), (c) => {
      [[0.12, 0.1], [pt.w - 0.24, 0.1], [0.12, pt.d - 0.22], [pt.w - 0.24, pt.d - 0.22]].forEach(([dx, dy]) => {
        isoBox(c, { x: pt.x + dx, y: pt.y + dy, z: 0, w: 0.12, d: 0.12, h: pt.h - 0.08, color: colors.deskLeg });
      });
      isoBox(c, { x: pt.x, y: pt.y, z: pt.h - 0.08, w: pt.w, d: pt.d, h: 0.08, color: colors.wood });
      // Cup on the table
      isoCylinder(c, { x: pt.x + 0.5, y: pt.y + 0.42, z: pt.h, r: 0.09, h: 0.16, color: '#e6ebf2' });
      isoCylinder(c, { x: pt.x + 1.45, y: pt.y + 0.6, z: pt.h, r: 0.09, h: 0.16, color: '#e6ebf2' });
    });

    PANTRY.chairs.forEach((ch, i) => pushChair(ch.x, ch.y, i < 3));

    /* Magazine rack (pantry north wall, east section), see drawMagRack */
    const rk = PANTRY.rack;
    // The key takes the "front-right corner", then lifts above "the east end of this wall": the north wall (meeting room's south glass) is drawn in segments,
    // and the glass segments' keys run all the way to depthOf(20, 7.25) ≈ 27.25; if the rack is any shallower, the later-drawn glass cuts off the rack's right corner.
    // Now that the rack sits at the east end it is naturally enough (corner key ≈ 27.37); this line guarantees "narrowing d later will not break it".
    // Cost: a person standing directly east of it (larger x) and closer to the camera may be pressed by it —— that patch is the pantry's northeast corner,
    // and the corridor (PDOOR_IN → COFFEE) is at the far west, so it will not actually collide.
    const wallEastDepth = depthOf(MEETING.x + MEETING.w, MEETING.y);
    push(Math.max(depthOf(rk.x + rk.w, rk.y + rk.d), wallEastDepth + 0.1), (c) => drawMagRack(c, rk));

    const pc = PANTRY.cooler;
    // The water cooler hugs the pantry north wall (= the meeting room's south glass), so it counts as being "in front of the glass":
    // it must be sorted after **all** glass segments / blind segments of this north wall —— the blind slats' alpha 0.92 is nearly opaque,
    // and any segment sorted after it would hard-cut a chunk off it where they overlap on screen (that is exactly what was observed being cut).
    // depthOf(pc.x, pc.y) (22.85) alone is not enough: after segmenting, the right-side segments' keys go up to 23.1~26.5.
    // The ceiling is pinned below the "water spot" (PLACES.coffee, 23.55) —— a gremlin standing at the cooler for water must still be able to cover it.
    const coolDepth = Math.max(depthOf(pc.x, pc.y), depthOf(PLACES.coffee.x, PLACES.coffee.y) - 0.05);
    push(coolDepth, (c) => drawCooler(c, pc));

    // Pantry glass partition: only the west face is built (the door is in the middle, two panels hang blinds separately → the doorway is naturally empty);
    // the north side borrows the meeting room's south wall, and the south side directly hugs the room's frontmost glass curtain wall, so no extra one is built.
    // The blinds are segmented by face coordinate like the glass face (see pushGlassFace above): a single midpoint key would press this 16% glass
    // onto the water cooler hugging the pantry side, appearing as the cooler's left part being hidden.
    // These two blind panels do not cover the water cooler: the only ones overlapping the cooler on screen are the two northern segments (depth 21.87 / 22.50,
    // both less than the cooler's coolDepth 23.5, drawn first -> covered by the cooler); the southern segments are at the screen's lower-left and do not overlap at all.
    // (Blind slats' alpha 0.92 is nearly opaque, so it must be pinned by depth, not rescued by transparency.)
    const ph = PANTRY.glass.h;
    const pg = PANTRY.glass;
    [pg.westA, pg.westB].forEach((g) => {
      pushGlassFace({ axis: 'x', fixed: g.x + g.w, a0: g.y, a1: g.y + g.d, segW: 0.8, h: ph });
    });

    /* Printer (meeting room's northwest corner): a floor-standing all-in-one, see drawPrinter */
    const pr = MEETING.printer;
    // The west blinds are already segmented by coordinate (see above), so the printer with a normal depth sorts after the matching blind segments.
    push(depthOf(pr.x + pr.w / 2, pr.y + pr.d / 2), (c) => drawPrinter(c, pr));

    PLANTS.forEach((p) => push(depthOf(p.x, p.y), (c) => drawPlant(c, p)));

    /* Main Agent console: cabinet -> floating screen -> silhouette (depth increasing, exactly the inside-out order) */
    const cd = CONSOLE.desk;
    push(depthOf(cd.x + cd.w / 2, cd.y + cd.d / 2), (c, now) => drawConsoleDesk(c, now));
    const cs = CONSOLE.screen;
    // The floating screen must cover the workstation content directly behind it (smaller gy): the screen depth takes the operator depth -0.1,
    // the operator is in front of the screen (depth = seat.x + seat.y). Directly behind the screen are the middle-column workstations (x+y far below the screen),
    // so they are necessarily drawn first and covered by the screen; the rightmost column, though its x+y is slightly higher, is to the screen's right and its projection does not overlap, so it is unaffected.
    push(depthOf(CONSOLE.seat.x, CONSOLE.seat.y) - 0.1, (c, now) =>
      drawConsoleScreen(c, { state: mainAgent, now, zoom: cam.zoom })
    );
    push(depthOf(CONSOLE.seat.x, CONSOLE.seat.y), (c, now) => drawOperator(c, { state: mainAgent, now }));

    return items;
  }

  /** Static furniture draw list (with each item's depth). The palette changes per floor; switching floors rebuilds via applyFloor() */
  let statics = buildStatics();

  /** Switch floor: re-pick the palette and rebuild the affected caches (furniture list + background) */
  function applyFloor(id) {
    const next = id || '';
    if (next === floorId) return;
    floorId = next;
    colors = colorsFor(floorId);
    statics = buildStatics();
    bgKey = '';
  }

  /* ------------------------------ Background (cached) ------------------------------ */

  function drawFloor(c) {
    // The floor is a flat parallelogram: do not give it plate thickness,
    // once a side face shows, the whole outline becomes a hexagon and no longer looks like a parallelogram.
    // Fully tiled diamond carpet tiles: one diamond per cell, two alternating shades + a tile seam, the same material for the whole room
    // (previously several differently colored large rugs over the cells, whose shades fought each other and looked busy).
    for (let gy = 0; gy < ROOM.d; gy += 1) {
      for (let gx = 0; gx < ROOM.w; gx += 1) {
        isoDiamond(c, {
          x: gx,
          y: gy,
          w: 1,
          d: 1,
          fill: (gx + gy) % 2 ? colors.floor : colors.floorAlt,
          stroke: colors.floorSeam,
          lw: 1,
        });
      }
    }
    // Room floor boundary: the four sides are the four wall bases, enclosing a crisp parallelogram
    isoDiamond(c, {
      x: 0, y: 0, w: ROOM.w, d: ROOM.d,
      fill: null, stroke: colors.wallTop, lw: 2.8, alpha: 0.9,
    });
  }

  /* ------------------------------ Door (opens and closes) ------------------------------ */

  /**
   * Door opening 0..1 (0 = fully shut, 1 = fully open); holdUntil = the door stays open until this moment.
   * The door leaf **does not go into the background cache**: the cache is only redrawn when the camera changes, and once drawn in it could never be pushed open.
   */
  const door = { a: 0, holdUntil: 0 };

  /**
   * The door follows "whoever is about to enter": if someone is about to appear (DOOR_LEAD ahead) or is still in the doorway, the door stays open;
   * after they are done it holds for DOOR_LINGER before closing —— otherwise the last one has just stepped in and the door slams on them.
   */
  function stepDoor(dt, now) {
    let busy = false;
    for (const a of agents) {
      if ((a.entering && now >= a.spawnAt - DOOR_LEAD) || a.atDoor) { busy = true; break; }
    }
    // Ghosts use this door too: while one is in the doorway, the door must likewise stay open (otherwise the door slams on the ghost)
    if (!busy) {
      for (const g of ghosts) {
        if (g.atDoor) { busy = true; break; }
      }
    }
    if (busy) door.holdUntil = Math.max(door.holdUntil, now + DOOR_LINGER);
    const want = now < door.holdUntil ? 1 : 0;
    const step = dt / DOOR_SWING;
    door.a = want > door.a ? Math.min(1, door.a + step) : Math.max(0, door.a - step);
  }

  /** Landing point of the door leaf's free edge: rotate DOOR_OPEN_DEG into the room around the hinge (on the doorway's clock side gy = y0) */
  function doorLeafEdge() {
    const d = WALL.door;
    const w = d.y1 - d.y0;
    const ang = ((DOOR_OPEN_DEG * Math.PI) / 180) * smooth(door.a);
    return { d, fx: w * Math.sin(ang), fy: d.y0 + w * Math.cos(ang) };
  }

  /** The doorway quad: while a gremlin is still outside the wall, only this part of the opening should be visible (the rest is hidden by the wall) */
  function doorwayPath(c) {
    const d = WALL.door;
    const p = [project(0, d.y0, d.z1), project(0, d.y1, d.z1), project(0, d.y1, d.z0), project(0, d.y0, d.z0)];
    c.beginPath();
    c.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i += 1) c.lineTo(p[i].x, p[i].y);
    c.closePath();
  }

  /** Door leaf: a panel that swings open about the hinge (recessed panel + top-edge highlight + handle), open/close driven by door.a */
  function drawDoor(c) {
    const { d, fx, fy } = doorLeafEdge();
    /** Point on the door leaf at parameter t (0 = hinge side, 1 = free edge) and height z */
    const at = (t, z) => project(t * fx, d.y0 + t * (fy - d.y0), z);
    const z0 = d.z0 + 0.02;
    const z1 = d.z1 - 0.02;
    poly(c, [at(0, z1), at(1, z1), at(1, z0), at(0, z0)], '#2f3745');
    // A narrow lit strip along the top edge: only then does the door leaf have thickness, otherwise it looks like a sheet of paper
    poly(c, [at(0, z1), at(1, z1), at(1, z1 - 0.06), at(0, z1 - 0.06)], shade('#2f3745', 1.45));
    // The recessed panel face + a dark strip its top edge casts down (so the door is not one flat slab)
    poly(c, [at(0.16, z1 - 0.14), at(0.84, z1 - 0.14), at(0.84, z0 + 0.18), at(0.16, z0 + 0.18)], '#242c38');
    poly(c, [at(0.16, z1 - 0.14), at(0.84, z1 - 0.14), at(0.84, z1 - 0.2), at(0.16, z1 - 0.2)], '#1a1f28');
    // Handle: mounted on the free-edge side (the hinge is at gy = y0, so the handle is always on the opposite side)
    const k = at(0.86, 1.0);
    c.beginPath();
    c.arc(k.x, k.y, 2.2, 0, Math.PI * 2);
    c.fillStyle = '#9aa7b8';
    c.fill();
  }

  /** The door leaf's position in the sort layer: take the leaf's midline (when shut it equals the doorway cell on the wall) */
  function doorDepth() {
    const { d, fx, fy } = doorLeafEdge();
    return depthOf(fx / 2, (d.y0 + fy) / 2);
  }

  function drawWalls(c) {
    const th = WALL.thickness;
    const h = WALL.h;

    // Floor first, walls press on top
    drawFloor(c);

    // Back wall inner surface (gy = 0): in isometric it is a parallelogram slanting down along +gx
    wallQuad(c, 'y', 0, 0, ROOM.w, 0, h, colors.wall);
    // Left wall inner surface (gx = 0): the other half slanting down along +gy
    wallQuad(c, 'x', 0, 0, ROOM.d, 0, h, shade(colors.wall, 0.82));

    /* The two faces near the camera (right gx = ROOM.w, front gy = ROOM.d) **get no wall**: this side is open toward the camera,
       so nothing in the room (sprites walking near the edge, furniture in front) is cut by a low wall / glass frame line.
       The floor's boundary line (see drawFloor) still closes the room into a complete parallelogram. */

    // Wall top: only the back (gy=0) and left (gx=0) solid walls have this top face; everything in the room is in front of them,
    // so it stays in the background layer (drawing it last would smear over characters standing in front of the wall).
    // Both ends close off at the room's two corners (x to ROOM.w, y to ROOM.d): the near two faces have no wall,
    // so the wall top stops at the corners and no longer needs to align with the glass tops.
    isoDiamond(c, { x: -th, y: -th, w: ROOM.w + th, d: th, z: h, fill: colors.wallTop });
    isoDiamond(c, { x: -th, y: -th, w: th, d: ROOM.d + th, z: h, fill: shade(colors.wallTop, 0.92) });

    // Baseboard
    wallQuad(c, 'y', 0, 0, ROOM.w, 0, 0.12, shade(colors.wall, 0.75));
    wallQuad(c, 'x', 0, 0, ROOM.d, 0, 0.12, shade(colors.wall, 0.66));

    // Window (night scene): outer frame + glass + sill, plus moonlight leaking into the room
    WALL.windows.forEach((w, wi) => {
      const gy = 0;
      const cxm = (w.x0 + w.x1) / 2;
      const czm = (w.z0 + w.z1) / 2;
      const FW = 0.11;  // frame width
      const SD = 0.18;  // how far the sill sticks out from the wall
      const frame = '#3d4859';
      const frameLit = shade(frame, 1.4);   // top edge catches skylight
      const frameDim = shade(frame, 0.6);   // bottom edge in shadow

      /* Light transmission: first a halo of cool light on the wall, then a patch of moonlight on the floor. Both added with lighter,
         so it looks like "light" added onto the wall/floor, not a gray patch. */
      c.save();
      c.globalCompositeOperation = 'lighter';
      // Wall halo: use the wall's own two axes (gx, gz) as the local basis, so the circle does not render as a screen-perfect circle
      const gc0 = project(cxm, gy, czm);
      c.save();
      c.transform(AX.x, AX.y, AZ.x, AZ.y, gc0.x, gc0.y);
      const rg = c.createRadialGradient(0, 0, 0, 0, 0, 2);
      rg.addColorStop(0, 'rgba(120,165,255,0.17)');
      rg.addColorStop(0.5, 'rgba(110,150,255,0.07)');
      rg.addColorStop(1, 'rgba(100,140,255,0)');
      c.beginPath();
      c.arc(0, 0, 2, 0, Math.PI * 2);
      c.fillStyle = rg;
      c.fill();
      c.restore();
      /* Moonlight on the floor: no more cornered quad (that just looks like a rug),
         changed to a "soft ellipse in floor coordinates", with edges fading to fully transparent, so it looks like light spilling in.
         Method: switch the brush to the floor's own two axes (AX / AY) —— draw a circle in this local space,
         and the isometric projection gives a slanted ellipse hugging the ground; then layer two (a bright core at the wall base + a soft halo spreading into the room),
         fainter and more diffuse the further into the room. */
      const o = project(cxm, gy, 0);
      const spill = (rx, ry, cy, a) => {
        c.save();
        c.transform(AX.x, AX.y, AY.x, AY.y, o.x, o.y);
        // Lay it only inside the wall (gy >= 0): otherwise the light climbs onto the wall face and lights a ring around the baseboard
        c.beginPath();
        c.rect(-rx - 1, 0, (rx + 1) * 2, cy + ry + 1);
        c.clip();
        c.translate(0, cy);
        c.scale(rx, ry); // circle -> ellipse on the ground
        const sg = c.createRadialGradient(0, 0, 0, 0, 0, 1);
        sg.addColorStop(0, `rgba(126,168,255,${a})`);
        sg.addColorStop(0.42, `rgba(126,168,255,${a * 0.5})`);
        sg.addColorStop(1, 'rgba(126,168,255,0)');
        c.beginPath();
        c.arc(0, 0, 1, 0, Math.PI * 2);
        c.fillStyle = sg;
        c.fill();
        c.restore();
      };
      const halfW = (w.x1 - w.x0) / 2 + 0.25;
      spill(halfW * 1.18, 2.6, 0.95, 0.12);  // a large soft halo spreading into the room, edges faded out
      spill(halfW * 0.92, 1.15, 0.42, 0.14); // bright core hugging the window base
      c.restore();

      // The opening in the wall: a dark edge a ring larger than the glass, i.e. the wall thickness
      wallQuad(c, 'y', gy, w.x0 - FW, w.x1 + FW, w.z0 - FW, w.z1 + FW, '#1a1f28');
      // Outer frame: top edge bright, bottom edge dark, so it reads as a "frame" at a glance, not a black block
      wallQuad(c, 'y', gy, w.x0 - FW, w.x1 + FW, w.z1, w.z1 + FW, frameLit);
      wallQuad(c, 'y', gy, w.x0 - FW, w.x1 + FW, w.z0 - FW, w.z0, frameDim);
      wallQuad(c, 'y', gy, w.x0 - FW, w.x0, w.z0, w.z1, frame);
      wallQuad(c, 'y', gy, w.x1, w.x1 + FW, w.z0, w.z1, frameDim);

      // Glass: night sky gradient, bright top, dark bottom
      const pTop = project(cxm, gy, w.z1);
      const pBot = project(cxm, gy, w.z0);
      const g = c.createLinearGradient(0, pTop.y, 0, pBot.y);
      g.addColorStop(0, '#1d2e52');
      g.addColorStop(0.55, '#141d33');
      g.addColorStop(1, '#0a0f1c');
      poly(c, [
        project(w.x0, gy, w.z1),
        project(w.x1, gy, w.z1),
        project(w.x1, gy, w.z0),
        project(w.x0, gy, w.z0),
      ], g);

      // Moon: a patch of cool light in the upper-right
      const moon = project(w.x1 - 0.6, gy, w.z1 - 0.45);
      const mg = c.createRadialGradient(moon.x, moon.y, 0, moon.x, moon.y, 14);
      mg.addColorStop(0, 'rgba(226,238,255,0.95)');
      mg.addColorStop(0.3, 'rgba(170,205,255,0.4)');
      mg.addColorStop(1, 'rgba(120,160,255,0)');
      c.beginPath();
      c.arc(moon.x, moon.y, 14, 0, Math.PI * 2);
      c.fillStyle = mg;
      c.fill();

      // Stars: each window has a different arrangement (deterministic pseudo-random seeded by the window index)
      const rnd = (i) => {
        const s = Math.sin((wi + 1) * 12.9898 + i * 78.233) * 43758.5453;
        return s - Math.floor(s);
      };
      for (let k = 0; k < 7; k += 1) {
        const sp = project(
          w.x0 + 0.35 + rnd(k) * (w.x1 - w.x0 - 0.7),
          gy,
          w.z0 + 0.2 + rnd(k + 7) * (w.z1 - w.z0 - 0.55),
        );
        c.beginPath();
        c.arc(sp.x, sp.y, 0.9 + rnd(k + 13) * 0.6, 0, Math.PI * 2);
        c.fillStyle = 'rgba(160,200,255,0.5)';
        c.fill();
      }

      // Mullions: one vertical and one horizontal in a cross, using a frame color one notch brighter than the glass so it is visible
      const mull = shade(frame, 1.25);
      wallQuad(c, 'y', gy, cxm - 0.035, cxm + 0.035, w.z0, w.z1, mull);
      wallQuad(c, 'y', gy, w.x0, w.x1, czm - 0.03, czm + 0.03, mull);
      wallQuad(c, 'y', gy, w.x0, w.x1, czm + 0.03, czm + 0.05, frameLit);

      // Sill: a narrow ledge sticking out of the wall, with a highlight pressed along its front edge
      const sill = '#394252';
      isoDiamond(c, { x: w.x0 - FW, y: gy, w: w.x1 - w.x0 + FW * 2, d: SD, z: w.z0 - FW, fill: sill });
      isoDiamond(c, {
        x: w.x0 - FW, y: gy + SD - 0.05, w: w.x1 - w.x0 + FW * 2, d: 0.05, z: w.z0 - FW, fill: shade(sill, 1.3),
      });
    });

    /* Door (left wall gx = 0, hanging to the left of the clock. The wall switched sides -> use the 'x' face, the a axis becomes gy):
       here we draw only the **door casing + doorway**; the swinging leaf is drawn per frame in the sort layer (see drawDoor) ——
       drawn into the background cache it could never be pushed open (the cache is only redrawn when the camera changes).
       Inside the opening is the small corridor outside the wall: step back a layer and darken a notch to get the depth of "seeing through". */
    const d = WALL.door;
    wallQuad(c, 'x', 0, d.y0 - 0.09, d.y1 + 0.09, d.z0, d.z1 + 0.09, '#39424f'); // door casing
    wallQuad(c, 'x', 0, d.y0, d.y1, d.z0, d.z1, '#10151e');                       // opening
    c.save();
    doorwayPath(c); // the recessed layer is larger than the opening (offset up-left), so it must be clipped to the opening or it smears onto the wall
    c.clip();
    wallQuad(c, 'x', -0.32, d.y0, d.y1, d.z0, d.z1, '#070a10');
    c.restore();
    // Meeting room whiteboard (on the back wall's inner side): 0.09 aluminum frame + inner shadow under the frame + pen tray (markers / eraser).
    // A lone whiteboard looks too much like a sheet of paper —— the frame's thickness, the bright-top dark-bottom frame edge, and the pen tray protruding from the wall are what make it a "whiteboard".
    const wb = MEETING.whiteboard;
    const WFW = 0.09;
    const wframe = '#5a6478';
    // The aluminum frame's four sides: top edge lit bright, bottom edge dark (the same language as the window frame)
    wallQuad(c, 'y', 0, wb.x0 - WFW, wb.x1 + WFW, wb.z1, wb.z1 + WFW, shade(wframe, 1.35));
    wallQuad(c, 'y', 0, wb.x0 - WFW, wb.x1 + WFW, wb.z0 - WFW, wb.z0, shade(wframe, 0.65));
    wallQuad(c, 'y', 0, wb.x0 - WFW, wb.x0, wb.z0, wb.z1, wframe);
    wallQuad(c, 'y', 0, wb.x1, wb.x1 + WFW, wb.z0, wb.z1, shade(wframe, 0.85));
    // Panel face + inner shadow pressed down by the frame (so the panel reads as set into the frame, not stuck on the wall)
    wallQuad(c, 'y', 0, wb.x0, wb.x1, wb.z0, wb.z1, '#dfe6ef');
    wallQuad(c, 'y', 0, wb.x0, wb.x1, wb.z1 - 0.05, wb.z1, 'rgba(20,28,40,0.14)');
    // Pen tray: a small strip protruding from the wall along the panel's bottom edge (top + front), holding two markers + an eraser
    const trayZ = wb.z0 - WFW - 0.02;
    isoDiamond(c, { x: wb.x0 + 0.3, y: 0, w: wb.x1 - wb.x0 - 0.6, d: 0.1, z: trayZ, fill: '#4a5468' });
    wallQuad(c, 'y', 0.1, wb.x0 + 0.3, wb.x1 - 0.3, trayZ - 0.04, trayZ, '#3a4354');
    isoBox(c, { x: wb.x0 + 0.6, y: 0.02, z: trayZ, w: 0.22, d: 0.05, h: 0.03, color: '#2f6ea8' });
    isoBox(c, { x: wb.x0 + 0.95, y: 0.02, z: trayZ, w: 0.22, d: 0.05, h: 0.03, color: '#c0453d' });
    isoBox(c, { x: wb.x1 - 0.8, y: 0.01, z: trayZ, w: 0.26, d: 0.08, h: 0.05, color: '#39414f' });
    for (let k = 0; k < 3; k += 1) {
      const z = wb.z1 - 0.22 - k * 0.24;
      wallQuad(c, 'y', 0, wb.x0 + 0.2, wb.x1 - 0.5 - k * 0.35, z, z + 0.05, '#7d8ea6');
    }
    wallQuad(c, 'y', 0, wb.x0 + 1.9, wb.x0 + 2.5, wb.z0 + 0.16, wb.z1 - 0.16, 'rgba(76,141,255,0.18)');

    // Meeting room sign: stuck above the solid back wall (gy=0, same plane as the whiteboard), z does not exceed the wall height 2.8.
    // The pantry sign is not drawn here: its wall (= the meeting room's south glass) has blinds hung on it,
    // and the background is drawn first while the blinds are drawn later in the sort layer, so it would be pressed -> moved to buildStatics, sorted after the blinds.
    drawWallLabel(c, t('wall.meeting_room'), MEETING.x + MEETING.w / 2, 0, 2.4);
  }

  /**
   * Left-wall clock (the gx = 0 wall; the door is also on this wall, to the left of the clock at the larger gy end).
   * The second hand moves, so it is drawn every frame —— drawn into the cached background it would freeze at the first second.
   * The wall is slanted in isometric, so like the nameplate it is skew-mapped using the wall's own two axes as the local basis.
   * Hung high enough (cz > 1.4) that furniture cannot cover it: in isometric the wall height furniture can block = object height − object distance to the wall.
   */
  function drawClock(c) {
    const cy = 6.6;
    const cz = 2.15;
    const r = 0.45;
    /** How long 1 screen pixel is in local coordinates (unit tile) —— so line width does not thicken with zoom */
    const px = 1 / (UNIT_Z * cam.zoom);
    const d = new Date();
    const turn = (v, unit) => ((v % unit) / unit) * Math.PI * 2;

    const o = project(0, cy, cz);
    c.save();
    // Local coordinates: u along -gy (the "right hand side" when standing in front of this wall), v downward, unit tile, center at (0,0).
    // Note it cannot be along +gy: that would mirror the whole dial (3 o'clock to the left, the second hand turning backwards).
    // The back wall uses +gx = AX because the back wall's right hand side happens to be +gx; not every "axis along the wall" can be copied.
    c.transform(-AY.x, -AY.y, -AZ.x, -AZ.y, o.x, o.y);
    /** Draw a hand from (tail) to (len) at angle a: 0 = 12 o'clock, clockwise */
    const hand = (a, len, w, color, tail = 0) => {
      const s = Math.sin(a);
      const k = -Math.cos(a);
      c.beginPath();
      c.moveTo(s * tail, k * tail);
      c.lineTo(s * len, k * len);
      c.strokeStyle = color;
      c.lineWidth = w * px;
      c.lineCap = 'round';
      c.stroke();
    };

    // Shadow cast on the wall (offset a bit to the lower-right, so the clock has thickness)
    c.beginPath();
    c.arc(2 * px, 3 * px, r + 1 * px, 0, Math.PI * 2);
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fill();
    // Bezel
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fillStyle = '#12161d';
    c.fill();
    // Dial
    c.beginPath();
    c.arc(0, 0, r - 3 * px, 0, Math.PI * 2);
    c.fillStyle = '#e8edf5';
    c.fill();
    c.strokeStyle = '#9aa7b8';
    c.lineWidth = 1 * px;
    c.stroke();
    // 12 tick marks, with 3/6/9/12 drawn a bit longer
    for (let i = 0; i < 12; i += 1) {
      const long = i % 3 === 0;
      hand(
        (i / 12) * Math.PI * 2,
        r - (long ? 6 : 4) * px,
        long ? 2 : 1.2,
        '#3a4454',
        r - 9 * px
      );
    }
    // Hour / minute / second hands: the second hand moves continuously, with a tail segment
    const sec = d.getSeconds() + d.getMilliseconds() / 1000;
    const min = d.getMinutes() + sec / 60;
    const hour = (d.getHours() % 12) + min / 60;
    hand(turn(hour, 12), r * 0.5, 3.4, '#2c3442');
    hand(turn(min, 60), r * 0.72, 2.4, '#2c3442');
    hand(turn(sec, 60), r * 0.78, 1.3, '#e0574f', -r * 0.2);
    // Center pivot
    c.beginPath();
    c.arc(0, 0, 2.6 * px, 0, Math.PI * 2);
    c.fillStyle = '#2c3442';
    c.fill();
    c.restore();
  }

  /**
   * Background (floor + carpet + wall + window) drawn to an offscreen bitmap.
   * The bitmap only depends on zoom, not on camera pan —— so dragging the scene does not require a redraw.
   */
  const bgAt = { x: 0, y: 0 };

  function ensureBg() {
    const key = `${W}|${H}|${dpr}|${cam.zoom.toFixed(3)}`;
    if (bgKey === key) return;
    bgKey = key;
    const b = roomBounds();
    const PAD = 60;
    const cw = (b.x1 - b.x0) * cam.zoom + PAD * 2;
    const ch = (b.y1 - b.y0) * cam.zoom + PAD * 2;
    bg.width = Math.max(1, Math.round(cw * dpr));
    bg.height = Math.max(1, Math.round(ch * dpr));
    const c = bg.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cw, ch);
    // Align the world bounding box's top-left corner to the bitmap's (PAD, PAD)
    bgAt.x = PAD - b.x0 * cam.zoom;
    bgAt.y = PAD - b.y0 * cam.zoom;
    c.translate(bgAt.x, bgAt.y);
    c.scale(cam.zoom, cam.zoom);
    drawWalls(c);
  }

  /* ------------------------------ Character drawing ------------------------------ */

  const SPRITE_S = (SPRITE_H * UNIT_Z) / SPRITE_UNITS;

  function drawAgent(c, a) {
    const st = stateOf(a.memberId);
    const p = project(a.x, a.y, 0);
    isoShadow(c, a.x, a.y, 0.44, 0.3);
    if (a.memberId === selectedId) {
      const e = groundEllipse(a.x, a.y, 0.55, 0.02);
      c.save();
      c.strokeStyle = '#4c8dff';
      c.lineWidth = 2;
      c.setLineDash([5, 4]);
      c.beginPath();
      c.ellipse(e.x, e.y, e.rx, e.ry, e.rot, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }
    if (hoverId === a.memberId) {
      const e = groundEllipse(a.x, a.y, 0.5, 0.02);
      c.save();
      c.fillStyle = 'rgba(255,255,255,0.07)';
      c.beginPath();
      c.ellipse(e.x, e.y, e.rx, e.ry, e.rot, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
    drawGremlin(c, {
      x: p.x,
      y: p.y,
      s: SPRITE_S,
      color: a.color,
      prop: a.prop,
      name: a.name,
      state: st,
      facing: a.facing,
      walking: a.moving,
      phase: a.phase,
      sitting: a.mode === 'sit' || a.mode === 'meet',
      level: a.level,
    });
  }

  function drawGhostSprite(c, g) {
    const st = stateOf(g.memberId);
    const p = project(g.x, g.y, g.z);
    // Floating: leave a faint shadow on the ground
    const ge = groundEllipse(g.x, g.y, 0.4, 0);
    c.save();
    c.globalAlpha *= 0.16;
    c.beginPath();
    c.ellipse(ge.x, ge.y, ge.rx, ge.ry, ge.rot, 0, Math.PI * 2);
    c.fillStyle = '#9fe8ff';
    c.fill();
    c.restore();
    drawGhost(c, {
      x: p.x,
      y: p.y,
      s: SPRITE_S * 0.92,
      color: g.color,
      state: st,
      facing: 1,
      phase: g.phase + (performance.now() - t0) / 780,
    });
  }

  /**
   * Dispatch beat: the gremlin talks to the main console **in place** (picks up its task) — no walk
   * over and no walk back. Wrap up when the dialogue ends (ghost appears). Wait until it is inside so
   * the dialogue does not overlap the entrance.
   */
  function stepDispatch(now) {
    if (!dispatch) return;
    const a = agents.find((x) => x.memberId === dispatch.agentId);
    if (!a) { finishDispatch(); return; }
    if (a.entering) return; // still walking in from outside: wait until it is visible
    if (!dispatch.talkAt) { dispatch.talkAt = now; return; } // start talking this frame
    faceConsole(a);
    if (now - dispatch.talkAt >= DISPATCH_TALK * 1000) finishDispatch();
  }

  /** Report beat: the gremlin says the result summary **in place**, then the ghost disperses. No walk back. */
  function stepReport(now) {
    // Try every frame even when no report is playing: after the REPORT_MIN_WORK hold expires nothing else
    // wakes pumpReport, so this is what releases a queued report (see finishDispatch).
    if (!report) { pumpReport(); return; }
    const a = agents.find((x) => x.memberId === report.agentId);
    if (!a) { finishReport(); return; }
    if (a.entering) return;
    if (!report.talkAt) { report.talkAt = now; return; }
    faceConsole(a);
    if (reportGhost) reportGhost.phase = (now - t0) / 780;
    if (now - report.talkAt >= REPORT_TALK * 1000) finishReport();
  }

  /** Temporary ghost sprite (with its own float + status dot): shared by summons / during a report */
  function drawFloatingGhostSprite(c, g) {
    if (!g) return;
    const p = project(g.x, g.y, g.z);
    const ge = groundEllipse(g.x, g.y, 0.4, 0);
    c.save();
    c.globalAlpha *= 0.16;
    c.beginPath();
    c.ellipse(ge.x, ge.y, ge.rx, ge.ry, ge.rot, 0, Math.PI * 2);
    c.fillStyle = '#9fe8ff';
    c.fill();
    c.restore();
    drawGhost(c, {
      x: p.x,
      y: p.y,
      s: SPRITE_S * 0.92,
      color: g.color,
      state: 'busy',
      phase: g.phase,
    });
  }

  /** Speech bubble (screen space, anchored at the foot, (x,y) is the landing point above it) */
  function drawBubble(c, x, y, text, alpha, color) {
    c.save();
    c.globalAlpha = alpha;
    c.font = '600 13px ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
    const padX = 12;
    // The result summary can be long: truncate to the bubble width and add an ellipsis, so the text does not spill outside the frame
    const maxW = 232;
    let t = String(text || '');
    if (c.measureText(t).width > maxW) {
      while (t.length > 1 && c.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
      t = `${t}…`;
    }
    const tw = c.measureText(t).width;
    const w = tw + padX * 2;
    const h = 30;
    const bx = x - w / 2;
    const by = y - h;
    roundRectPath(c, bx, by, w, h, 10);
    c.fillStyle = 'rgba(16,21,30,0.95)';
    c.fill();
    c.strokeStyle = color;
    c.lineWidth = 1.6;
    c.stroke();
    // Tail pointing down to the center
    c.beginPath();
    c.moveTo(x - 7, by + h - 0.5);
    c.lineTo(x + 7, by + h - 0.5);
    c.lineTo(x, by + h + 9);
    c.closePath();
    c.fillStyle = 'rgba(16,21,30,0.95)';
    c.fill();
    c.stroke();
    c.fillStyle = '#eaf1fb';
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillText(t, bx + padX, by + h / 2 + 1);
    c.restore();
  }

  /* ------------------------------ Main loop ------------------------------ */

  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;

    stepAgents(dt, now);
    stepDoor(dt, now);
    stepGhosts(dt, now);
    stepDispatch(now);
    stepReport(now);
    // The whole summon/report arc drained -> fire the waiting callback once (the main console's
    // "Task done" is deferred until after the animation; see IsoOfficeView).
    if (flowIdleCb && !flowPending()) {
      const cb = flowIdleCb;
      flowIdleCb = null;
      cb();
    }
    draw(now);
    raf = requestAnimationFrame(tick);
  }

  function draw(now) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ensureBg();
    ctx.drawImage(bg, (cam.ox - bgAt.x) * dpr, (cam.oy - bgAt.y) * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(cam.ox, cam.oy);
    ctx.scale(cam.zoom, cam.zoom);

    // Left-wall clock: stuck on the gx=0 wall, hung high enough that nothing in the room covers it, so drawn first
    drawClock(ctx);

    // Sorting: furniture + characters mixed together, larger depth drawn later (covers the ones in front)
    const items = statics.slice();
    // Door: the leaf swings, so it also joins the sort layer —— shut it exactly covers the doorway, open it blocks between the opening and the corridor
    items.push({ depth: doorDepth(), draw: (c) => drawDoor(c) });
    for (const a of agents) {
      if (a.entering) continue; // not inside yet
      // Still outside the wall (gx < 0): the part hidden by the wall should not be visible; clip to just the doorway
      const outside = a.x < 0;
      items.push({
        depth: depthOf(a.x, a.y),
        draw: (c) => {
          if (!outside) { drawAgent(c, a); return; }
          c.save();
          doorwayPath(c);
          c.clip();
          drawAgent(c, a);
          c.restore();
        },
      });
    }
    for (const g of ghosts) {
      // Still outside the door (waiting / passing through the doorway): like a gremlin, only the doorway part shows —— so it reads as "drifting in through the door"
      const outside = g.x < 0;
      items.push({
        depth: depthOf(g.x, g.y) + 3,
        draw: (c) => {
          // Still waiting outside the door: draw none of it (the bit of body outside the wall leaks through the door gap under the isometric projection,
          // and the door is shut at that time —— leaking out would look like "a ghost stuck in front of the door leaf")
          if (g.waiting) return;
          if (!outside) { drawGhostSprite(c, g); return; }
          c.save();
          doorwayPath(c);
          c.clip();
          drawGhostSprite(c, g);
          c.restore();
        },
      });
    }
    if (reportGhost) items.push({ depth: depthOf(reportGhost.x, reportGhost.y) + 3, draw: (c) => drawFloatingGhostSprite(c, reportGhost) });
    items.sort((p, q) => p.depth - q.depth);
    for (const it of items) it.draw(ctx, now);

    // Path-network debug
    if (showPaths) {
      for (const n of NAV_NODES) {
        const p = project(n.x, n.y, 0.02);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3 / cam.zoom, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(76,141,255,0.75)';
        ctx.fill();
      }
    }

    // ---- Overhead tags: screen space, not deformed by zoom ----
    hits = [];
    screenPos.clear();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // The hitbox needs width: it used to be a zero-width vertical line (x0 === x1 === s.x), so the mouse had to land exactly on
    // the body's centerline to hit —— effectively "the body cannot be clicked". During a summon the ghost also floats above the gremlin,
    // so it looked like "neither the ghost nor its gremlin has a tooltip". Give the body a real width,
    // so the mouse brushing the body counts as a hit (the sprite is locally ~44 units wide; take half-width 24 here).
    // Order: ghosts pushed first, gremlins after —— hitAt searches from back to front, so on overlap the gremlin wins.
    // The ghost itself still gets no tooltip (excluded in memberAt), but because it blocks above,
    // the gremlin working underneath should not lose its tooltip either.
    for (const g of ghosts) {
      // Still outside the door / in the doorway (body hidden by the wall): do not enter the screen-coordinate table; the tag and picking are likewise absent
      if (g.x < 0) continue;
      const s = toScreen(g.x, g.y, g.z);
      screenPos.set(g.memberId, s);
      const h = SPRITE_H * UNIT_Z * cam.zoom * 0.92;
      const hw = SPRITE_S * 0.92 * 24 * cam.zoom;
      pushHit(g.memberId, s.x - hw, s.y - h - 16, s.x + hw, s.y + 6);
    }
    for (const a of agents) {
      // Not inside yet / still outside the wall (body still hidden by the wall): do not enter the screen-coordinate table, so the overhead tag and picking are likewise absent
      if (a.entering || a.x < 0) continue;
      const s = toScreen(a.x, a.y, 0);
      screenPos.set(a.memberId, s);
      const h = SPRITE_H * UNIT_Z * cam.zoom;
      const hw = SPRITE_S * 24 * cam.zoom;
      pushHit(a.memberId, s.x - hw, s.y - h - 16, s.x + hw, s.y + 6);
    }

    // Tags (characters above, furniture below, hence drawn later); likewise ghosts first, gremlins after
    for (const g of ghosts) {
      const s = screenPos.get(g.memberId);
      if (!s) continue;
      const y = s.y - SPRITE_H * UNIT_Z * cam.zoom * 0.92 - 12;
      const box = drawTag(ctx, {
        x: s.x,
        y,
        text: ghostTagText(g),
        color: STATE_COLOR[bucketOf(stateOf(g.memberId))],
        dashed: true,
      });
      pushHit(g.memberId, s.x - box.w / 2, y - box.h, s.x + box.w / 2, y);
    }
    for (const a of agents) {
      const s = screenPos.get(a.memberId);
      if (!s) continue;
      const box = drawTag(ctx, {
        x: s.x,
        y: s.y - SPRITE_H * UNIT_Z * cam.zoom - 12,
        text: tagText(a),
        color: STATE_COLOR[bucketOf(stateOf(a.memberId))],
      });
      pushHit(a.memberId, s.x - box.w / 2, s.y - SPRITE_H * UNIT_Z * cam.zoom - 12 - box.h, s.x + box.w / 2, s.y - SPRITE_H * UNIT_Z * cam.zoom - 12);
    }

    // Ghost drawn extra during a report: name + "reporting" (the result summary is said in the bubble)
    if (reportGhost) {
      const s = toScreen(reportGhost.x, reportGhost.y, reportGhost.z);
      const y = s.y - SPRITE_H * UNIT_Z * cam.zoom * 0.92 - 12;
      const box = drawTag(ctx, {
        x: s.x,
        y,
        text: reportGhost.name,
        color: STATE_SUCCESS,
        dashed: true,
      });
      pushHit('__report_ghost', s.x - box.w / 2, y - box.h, s.x + box.w / 2, y);
    }

    // Summon dialogue bubbles (screen space, on top): the main console hands over the task, the gremlin
    // answers "Got it" in place. Timing starts at **talkAt** (when it opens its mouth); nothing before.
    if (dispatch) {
      const a = agents.find((x) => x.memberId === dispatch.agentId);
      const el = dispatch.talkAt ? (now - dispatch.talkAt) / 1000 : -1;
      const fadeOut = 1 - clamp01((el - (DISPATCH_TALK + 0.2)) / 0.7);
      const mainA = clamp01(el / 0.4) * fadeOut;
      const gremA = clamp01((el - 1.0) / 0.4) * fadeOut;
      if (a && mainA > 0.02) {
        const cs = toScreen(CONSOLE.screen.x + CONSOLE.screen.w / 2, CONSOLE.screen.y, CONSOLE.screen.z1);
        drawBubble(ctx, cs.x, cs.y - 12, dispatch.task || delegationLine(), mainA, '#7fb0ff');
      }
      if (a && gremA > 0.02) {
        const sp = toScreen(a.x, a.y, 0);
        drawBubble(ctx, sp.x, sp.y - SPRITE_H * UNIT_Z * cam.zoom - 6, t('bubble.received'), gremA, a.color);
      }
    }

    // Finish report bubble: the gremlin says the result summary in place (at its desk)
    if (report) {
      const a = agents.find((x) => x.memberId === report.agentId);
      const el = report.talkAt ? (now - report.talkAt) / 1000 : -1;
      const alpha = clamp01(el / 0.4) * (1 - clamp01((el - (REPORT_TALK + 0.2)) / 0.7));
      if (a && alpha > 0.02) {
        const sp = toScreen(a.x, a.y, 0);
        drawBubble(ctx, sp.x, sp.y - SPRITE_H * UNIT_Z * cam.zoom - 6, reportText(report), alpha, a.color);
      }
    }
  }

  function pushHit(id, x0, y0, x1, y1) {
    hits.push({ id, x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
  }

  /**
   * Only idle or thinking people get up and walk; when coding / writing docs they are pinned to their seat.
   * During a summon (ghost still floating / currently reporting) always pinned: it is working for the main agent,
   * and walking around the room with "busy" written overhead looks like slacking off.
   */
  function canWander(a) {
    if (isSummoned(a.memberId)) return false;
    if (report && report.agentId === a.memberId) return false;
    const b = bucketOf(stateOf(a.memberId));
    // blocked = stuck waiting on an external dependency -> pin to the seat (wandering the room looks like slacking off)
    if (b === 'blocked') return false;
    return b !== 'busy' || a.work === 'think';
  }

  /** Write the status overhead: busy / blocked / idle; what exactly it is doing is left to the ghost / tooltip */
  function tagText(a) {
    if (a.mode === 'meet') return t('tag.meeting');
    const b = bucketOf(stateOf(a.memberId));
    if (b === 'blocked') return t('tag.blocked');
    return b === 'busy' ? t('tag.busy') : t('tag.idle');
  }

  /**
   * Ghost overhead tag: **name only** (the subagent's own name, e.g. susan / simmon).
   *
   * It used to say "name · project name", but the project name is mostly just the current project, so everyone wore the same suffix overhead,
   * squeezing out "who it is"; the task content should be told by the **gremlin** (the seated one) tooltip anyway,
   * and the ghost only says the result in a bubble during the few seconds of the wrap-up report (see reportText).
   */
  function ghostTagText(g) {
    if (g.inMeeting) return t('tag.attending');
    const m = memberOf(g.memberId);
    const name = (m && m.name) || g.name || '';
    return name || t('tag.temp_member');
  }

  /* ------------------------------ Interaction ------------------------------ */

  function hitAt(px, py) {
    for (let i = hits.length - 1; i >= 0; i -= 1) {
      const h = hits[i];
      if (px >= h.x0 && px <= h.x1 && py >= h.y0 && py <= h.y1) return h.id;
    }
    return null;
  }

  /** Ray casting to test whether a screen coordinate falls inside a polygon (CSS px) */
  function pointInPoly(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x;
      const yi = pts[i].y;
      const xj = pts[j].x;
      const yj = pts[j].y;
      const hit = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (hit) inside = !inside;
    }
    return inside;
  }

  /**
   * Hit test for the main Agent's floating screen (the same CSS pixel coordinates as onMove's px/py).
   * The screen is a wallQuad on the constant-gy vertical plane; point-in-polygon after projecting its four corners into a screen quad.
   * Pad a ring beyond the drawn screen frame, so hover is easier to hit.
   */
  function hitMainConsole(px, py) {
    const s = CONSOLE.screen;
    const pad = 0.06;
    const fx = s.y - 0.012;
    const x0 = s.x - 0.07 - pad;
    const x1 = s.x + s.w + 0.07 + pad;
    const z0 = s.z0 - 0.07 - pad;
    const z1 = s.z1 + 0.07 + pad;
    const poly = [
      toScreen(x0, fx, z1),
      toScreen(x1, fx, z1),
      toScreen(x1, fx, z0),
      toScreen(x0, fx, z0),
    ];
    return pointInPoly(px, py, poly);
  }

  function onMove(e) {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (drag.active) {
      cam.ox += px - drag.x;
      cam.oy += py - drag.y;
      drag.x = px;
      drag.y = py;
      drag.moved = true;
      return;
    }
    hoverId = hitAt(px, py) || '';
    canvas.style.cursor = hoverId ? 'pointer' : 'grab';
  }

  const drag = { active: false, x: 0, y: 0, moved: false };

  function onDown(e) {
    drag.active = true;
    drag.moved = false;
    const r = canvas.getBoundingClientRect();
    drag.x = e.clientX - r.left;
    drag.y = e.clientY - r.top;
    canvas.style.cursor = 'grabbing';
  }

  function onUp(e) {
    drag.active = false;
    canvas.style.cursor = hoverId ? 'pointer' : 'grab';
    if (drag.moved) return;
    const r = canvas.getBoundingClientRect();
    const id = hitAt(e.clientX - r.left, e.clientY - r.top);
    if (id) onSelect(id);
  }

  function onWheel(e) {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nz = Math.max(0.35, Math.min(2.6, cam.zoom * k));
    const f = nz / cam.zoom;
    cam.ox = px - (px - cam.ox) * f;
    cam.oy = py - (py - cam.oy) * f;
    cam.zoom = nz;
    bgKey = '';
  }

  function onDblClick() {
    fit();
    bgKey = '';
  }

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDblClick);

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(canvas);
  else window.addEventListener('resize', resize);

  resize();
  last = performance.now();
  raf = requestAnimationFrame(tick);

  return {
    setMembers,
    /** Switch floor: change this floor's material palette (dividers / metal / wood), see officeMap's FLOOR_COLORS */
    setFloor(id) {
      applyFloor(id);
    },
    setSelected(id) {
      selectedId = id || '';
    },
    setShowPaths(v) {
      showPaths = Boolean(v);
    },
    callAll() {
      manualMeeting = true;
      startMeeting(agents.map((a) => a.memberId));
    },
    dismiss() {
      manualMeeting = false;
      endMeeting();
    },
    /** Character foot CSS pixel coordinates (used to position the task card) */
    screenOf(id) {
      return screenPos.get(id) || null;
    },
    /** Main Agent floating screen hit test (CSS px): used by the Vue side to pop a tooltip when hovering that screen */
    hitMainConsole(px, py) {
      return hitMainConsole(px, py);
    },
    /**
     * Whether the mouse is over some member (CSS px), returns memberId; empty = no hit.
     * `__xxx` are internal sprites (temporary ghosts for summon / report), not counted as members and given no tooltip.
     */
    memberAt(px, py) {
      const id = hitAt(px, py);
      if (!id || String(id).startsWith('__')) return '';
      // Ghosts (temporary members) get no tooltip: their overhead tag shows only the name, the task is told by their matching gremlin
      const m = members.find((x) => x.memberId === id);
      if (m && m.ghost) return '';
      return String(id);
    },
    /** The gremlin's most recent completed task result: { task, result, at }; null if it never worked */
    lastResult(id) {
      return lastResults.get(id) || null;
    },
    /** Office still has a summon / report beat running or queued: the main console's "Task done" defers; see whenFlowIdle */
    flowPending,
    /** Call back once the beats drain (immediately when idle): defers the main console wrap-up until after the animation */
    whenFlowIdle,
    /** Main Agent console: { phase, action, context[], target } (currently mock-driven, later swapped for hook events) */
    setMainAgent(s) {
      const prev = mainAgent;
      mainAgent = { phase: 'idle', action: '', context: [], target: null, ...(s || {}) };
      syncDispatch(prev);
    },
    meetingCount: () => agents.filter((a) => a.inMeeting).length + ghosts.filter((g) => g.inMeeting).length,
    stateColor: (s) => STATE_COLOR[bucketOf(s)],
    destroy() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
      if (ro) ro.disconnect();
      else window.removeEventListener('resize', resize);
    },
  };
}

export { STATE_COLOR };
