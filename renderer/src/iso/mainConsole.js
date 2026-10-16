/**
 * mainConsole.js —— main Agent (Craft Agent) console.
 *
 * Drawing only, no state: phase, action, and context are all passed in from outside (currently mock
 * data; later swap in hook events, see stores/mainAgent.js).
 *
 * Three things:
 *   1. The console body (low cabinet + tabletop + status lights) —— dark low-poly, same drawing style as the room's furniture
 *   2. The floating screen —— mounted on a plane of constant gy, so it is a parallelogram in isometric; content faces the camera
 *      Only shows the phase status (thinking / calling tools …): the actual prompt, file reads/writes, and tool details never go on screen.
 *      From afar it is a glowing panel (just abstract light bars); only when zoomed in enough does it spell out the phase name
 *   3. The silhouette —— a dark seated shadow with no features; the hand swipes / taps / hovers, never types
 *
 * Local coordinates: screen content uses two tiles (u, v) as units, u along +gx, v downward (same skew as the nameplate).
 */

import {
  AX,
  AZ,
  UNIT_Z,
  project,
  poly,
  isoBox,
  isoCylinder,
  isoShadow,
  groundEllipse,
  wallQuad,
  rgba,
} from './iso';
import { CONSOLE } from './officeMap';
// Phase labels go through i18n (the screen's first line and the tooltip's first line share one source, see consolePhaseLabel). Write /index.js explicitly:
// canvas modules may also be imported directly by node scripts (HMR / self-check), and Node does not add extensions.
import { t } from '../i18n/index.js';

/**
 * The screen's first layer: the phase table. busy decides whether there is a cursor / loading animation.
 *
 * 2026-10-01 removed the "plan" and "summarize" phases: they only lived in the demo script,
 * never produced on a real machine —— upstream is either the demo choreography or the server's two inference
 * branches that almost never fire (the IDE plugin's awaitingSessionIdle / queued messages, see server/src/sessions.js), while the reporter hook,
 * Kilo, and OpenCode all explicitly do not map step-start / step-finish onto them (step boundaries are too frequent; once mapped,
 * every tool completion would get stuck on "summarizing"). Keeping them would make people think there really is a "plan / summarize" work phase.
 * Those two kinds of information are instead expressed as "idle + action line description" (see mainAgent.enterPause / sessions.inferPhase).
 */
export const PHASES = {
  idle: { color: '#6b7c94', glow: 0.22, busy: false },
  /**
   * Unreported: the CLI at this layer does not have the hook wired up yet, only session file times are visible —— do not infer actions,
   * and do not pretend it is calling tools (it used to show "calling tools · edited xxx.jsonl", which was inventing things from the filename).
   */
  unreported: { color: '#6b7c94', glow: 0.18, busy: false },
  thinking: { color: '#ffcf5c', glow: 0.6, busy: true },
  tool: { color: '#4c8dff', glow: 0.85, busy: true },
  dispatch: { color: '#7fb0ff', glow: 1.0, busy: true },
  /** Task done: the screen says "task done", the silhouette returns to watching; the third content layer shows a summary of this change */
  done: { color: '#2fbf71', glow: 0.5, busy: false },
  /**
   * Task cancelled: the user pressed ESC / stop, this round was cut off before finishing ——
   * the only two differences from done: **red** (not the "done" green) + the screen / tooltip says "task cancelled".
   * The third layer is likewise "this round's output": list the files if any were touched, or write "no output" if none were
   * (see the enterCancelled section in IsoOfficeView).
   */
  cancelled: { color: '#ff5c5c', glow: 0.5, busy: false },
  /** Waiting for user authorization: the screen says "waiting for authorization", the silhouette raises a sign (see the isAwait branch in drawOperator) */
  await: { color: '#f5a623', glow: 0.6, busy: false },
  /**
   * Waiting for a subagent report: the main session has not received Stop yet, but the work is already dispatched ——
   * this is neither "idle" (the person is still in this round's task) nor doing the work itself, so it gets its own phase:
   * the screen says "waiting", and spells out who it is waiting for (see consoleLive in IsoOfficeView).
   */
  waiting: { color: '#5aa9ff', glow: 0.42, busy: false },
};

export const PHASE_LIST = Object.keys(PHASES);

const FONT = 'ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';

/**
 * The phase label **shared** by the screen's first layer and the tooltip's first line (the two always agree).
 *
 * The label is keyed by phase (`phase.idle` / `phase.tool` …); the Chinese and English sets live in the i18n entry table;
 * an unrecognized phase falls back to "idle". Always key by phase, **never swap the label by tool name**:
 * the tool name only says "what the last call was", not enough to say "currently waiting for authorization" —— command tools (Bash / Shell)
 * used to be swapped to "calling tools, authorization required", which both bled onto phases like "task done" (leftover tool field),
 * and made people think it was stuck. The real authorization signal is represented solely by the await phase, not guessed from the tool name.
 * @param {{phase?:string}} state
 */
export function consolePhaseLabel(state) {
  const key = String((state && state.phase) || 'idle');
  return t(`phase.${PHASES[key] ? key : 'idle'}`);
}

/** Silhouette: same local units as the sprite (70 ≈ 1.55 tile tall), seated so it is shorter overall */
const BODY_UNITS = 70;
const BODY_H = 1.55;

/** Measure a run of text; if too wide, truncate and add an ellipsis (so it does not spill off screen) */
function fit(c, text, maxW) {
  const s = String(text || '');
  if (!s) return '';
  if (c.measureText(s).width <= maxW) return s;
  let t = s;
  while (t.length > 1 && c.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/* ------------------------------------------------------------------ *
 * Console body
 * ------------------------------------------------------------------ */

/**
 * Low cabinet + tabletop + front status light strip + two light posts holding the screen.
 * The status lights are the only moving part: they run past marquee-style, hinting that it is "always running".
 */
export function drawConsoleDesk(c, now) {
  const { x, y, w, d, h } = CONSOLE.desk;

  // Light spilling from the screen onto the tabletop and floor
  const spill = groundEllipse(x + w / 2, y + d * 0.2, 2.1, 0.01);
  const sg = c.createRadialGradient(spill.x, spill.y, 0, spill.x, spill.y, spill.rx);
  sg.addColorStop(0, 'rgba(96,150,255,0.13)');
  sg.addColorStop(1, 'rgba(96,150,255,0)');
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.beginPath();
  c.ellipse(spill.x, spill.y, spill.rx, spill.ry, spill.rot, 0, Math.PI * 2);
  c.fillStyle = sg;
  c.fill();
  c.restore();

  // Cabinet body: darker lower half, tabletop one shade lighter (low-poly relies on just these two faces)
  isoBox(c, { x, y, z: 0, w, d, h: h - 0.1, color: '#252c39' });
  isoBox(c, { x: x - 0.05, y: y - 0.05, z: h - 0.1, w: w + 0.1, d: d + 0.1, h: 0.1, color: '#39414f' });

  // Status light strip on the front face (facing +gy = facing the camera)
  const face = y + d;
  const lights = 9;
  const lz = h * 0.42;
  for (let i = 0; i < lights; i += 1) {
    const u = x + 0.4 + i * ((w - 0.8) / (lights - 1));
    // Marquee: the lit position advances over time
    const k = ((now / 900 + i * 0.12) % 1.6) / 1.6;
    const on = k < 0.34;
    const col = on ? '#6fa8ff' : i % 3 === 0 ? '#3d4c66' : '#2c3646';
    wallQuad(c, 'y', face + 0.002, u - 0.08, u + 0.08, lz, lz + 0.09, col);
  }

  // An angled control board on the tabletop (a thin board + two grooves, no keyboard drawn —— the main Agent never types)
  isoBox(c, {
    x: x + 0.5,
    y: y + 0.18,
    z: h,
    w: w - 1.0,
    d: 0.36,
    h: 0.06,
    color: '#2f3746',
  });
  wallQuad(c, 'y', y + 0.18 + 0.36, x + 0.7, x + w - 0.7, h + 0.06, h + 0.09, 'rgba(111,168,255,0.35)');

  // Two light posts holding up the floating screen
  CONSOLE.posts.forEach((px) => {
    isoBox(c, { x: px - 0.045, y: y + 0.3, z: h, w: 0.09, d: 0.09, h: CONSOLE.screen.z0 - h, color: '#39414f' });
    // A short glowing segment at the top of each post, so the post feels like it is "propping up the screen"
    wallQuad(c, 'y', y + 0.3 + 0.09, px - 0.045, px + 0.045, CONSOLE.screen.z0 - 0.12, CONSOLE.screen.z0, 'rgba(111,168,255,0.5)');
  });
}

/* ------------------------------------------------------------------ *
 * Floating screen
 * ------------------------------------------------------------------ */

/**
 * @param {CanvasRenderingContext2D} c
 * @param {{state:{phase:string,action:string,context:string[],tool?:string}, now:number, zoom:number}} o
 */
export function drawConsoleScreen(c, o) {
  const { state, now, zoom } = o;
  const s = CONSOLE.screen;
  const ph = PHASES[state.phase] || PHASES.idle;
  const W = s.w;
  const H = s.z1 - s.z0;
  const face = s.y;

  // Border (a ring larger than the screen, treated as the screen's thickness)
  wallQuad(c, 'y', face - 0.012, s.x - 0.07, s.x + W + 0.07, s.z0 - 0.07, s.z1 + 0.07, '#1a2130');
  // Screen base: almost fully black, lit up by the glow behind it
  wallQuad(c, 'y', face, s.x, s.x + W, s.z0, s.z1, '#05080e');

  // Whole-screen glow: bright while running, barely lit when idle
  c.save();
  c.globalCompositeOperation = 'lighter';
  const top = project(s.x, face, s.z1);
  const bot = project(s.x, face, s.z0);
  const g = c.createLinearGradient(0, top.y, 0, bot.y);
  g.addColorStop(0, rgba(ph.color, 0.05 + 0.2 * ph.glow));
  g.addColorStop(1, rgba(ph.color, 0.02 + 0.06 * ph.glow));
  poly(
    c,
    [project(s.x, face, s.z1), project(s.x + W, face, s.z1), project(s.x + W, face, s.z0), project(s.x, face, s.z0)],
    g
  );
  c.restore();

  // ---- Content: switch to the screen face's own local coordinates (u along +gx, v downward) ----
  const o0 = project(s.x, face, s.z1);
  c.save();
  c.transform(AX.x, AX.y, -AZ.x, -AZ.y, o0.x, o0.y);
  c.beginPath();
  c.rect(0, 0, W, H);
  c.clip();

  const pxPerTile = UNIT_Z * zoom;
  const padX = 0.2;
  const inner = W - padX * 2;
  const fs1 = H * 0.32;
  /** Below this font size, write nothing —— from afar leave a glowing panel, only close up do letters appear */
  const showL1 = fs1 * pxPerTile >= 9;

  if (!showL1) {
    // Too small: keep only three abstract light bars (from afar it reads as "something moving on the screen")
    for (let k = 0; k < 3; k += 1) {
      const v = H * (0.22 + k * 0.24);
      const ww = inner * (0.35 + ((k * 7 + Math.floor(now / 700)) % 4) * 0.14);
      c.fillStyle = rgba(k === 0 ? ph.color : '#5b6779', k === 0 ? 0.55 : 0.3);
      c.fillRect(padX, v, ww, H * 0.09);
    }
    c.restore();
    return;
  }

  // Center the status text (2026-09-30 user request): horizontally centered on the screen width, vertically centered in the area "above the bottom progress bar".
  // Use textBaseline='middle' to position by the midline directly —— so no offset is needed when the font size auto-shrinks (lfs below).
  c.textAlign = 'center';
  c.textBaseline = 'middle';

  /* The only content layer: the phase status (thinking / calling tools …).
     Shows only the status, not the actual prompt, file reads/writes, or tool-call details —— those stay in the tooltip / conversation log.
     The label comes from the same consolePhaseLabel() as the tooltip's first line (calling tools writes "calling tools");
     if the label is long it auto-shrinks the font size, so it does not get truncated into an ellipsis by fit.
     Idle breathes slowly, running stays lit. Text is laid out across the full width —— not alongside the blinking cursor (reserving space for it would squeeze the label into an ellipsis). */
  const blink = ph.busy ? 1 : 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(now / 700));
  const label = consolePhaseLabel(state);
  let lfs = fs1;
  c.font = `700 ${lfs}px ${FONT}`;
  const labelW = c.measureText(label).width;
  if (labelW > inner) {
    lfs = Math.max(fs1 * 0.5, (fs1 * inner) / labelW);
    c.font = `700 ${lfs}px ${FONT}`;
  }
  /** Top edge of the indeterminate progress bar at the bottom; the status text is centered in the area above it */
  const barTop = H * 0.93;
  const labelV = barTop / 2;
  const labelText = fit(c, label, inner);
  c.globalAlpha = blink;
  c.fillStyle = ph.color;
  c.fillText(labelText, W / 2, labelV);
  c.globalAlpha = 1;

  /* Bottom: while running, an indeterminate progress bar slides */
  c.fillStyle = 'rgba(255,255,255,0.07)';
  c.fillRect(padX, barTop, inner, H * 0.035);
  if (ph.busy) {
    const segW = inner * 0.3;
    const u = padX + ((now / 1800) % 1) * (inner - segW);
    c.fillStyle = ph.color;
    c.globalAlpha = 0.85;
    c.fillRect(u, barTop, segW, H * 0.035);
    c.globalAlpha = 1;
  }

  // Glass reflection: a slanted highlight
  c.globalCompositeOperation = 'lighter';
  c.fillStyle = 'rgba(255,255,255,0.03)';
  c.beginPath();
  c.moveTo(W * 0.12, 0);
  c.lineTo(W * 0.34, 0);
  c.lineTo(W * 0.14, H);
  c.lineTo(-W * 0.08, H);
  c.closePath();
  c.fill();

  c.restore();
}

/* ------------------------------------------------------------------ *
 * Main Agent silhouette
 * ------------------------------------------------------------------ */

/**
 * A dark shadow with no features: head + shoulders + forward arm + bent legs.
 * The motion cycles among swipe / tap / watch (while idle it mostly just watches + breathes),
 * the hand reaches toward the console, never types —— it is "monitoring and dispatching".
 */
export function drawOperator(c, o) {
  const { state, now } = o;
  const ph = PHASES[state.phase] || PHASES.idle;
  const seat = CONSOLE.seat;

  isoCylinder(c, { x: seat.x, y: seat.y, z: 0, r: 0.24, h: 0.4, color: '#222a36' });
  isoShadow(c, seat.x, seat.y, 0.4, 0.34);

  const p = project(seat.x, seat.y, 0);
  const s = (BODY_H * UNIT_Z) / BODY_UNITS;
  const t = now / 1000;

  // Motion: idle = watch (only breathing); only when busy does it swipe / tap
  const kinds = ['swipe', 'tap', 'watch'];
  const slot = Math.floor(t / 3.2);
  const k = (t / 3.2) % 1;
  const kind = ph.busy ? kinds[slot % kinds.length] : 'watch';
  const breathe = Math.sin(t * 1.5) * 0.6;

  let handU = 0;
  let handV = 0;
  if (kind === 'swipe') handU = Math.sin(k * Math.PI * 2) * 10;
  else if (kind === 'tap') handV = k < 0.55 ? -Math.abs(Math.sin(k * 5.7 * Math.PI)) * 5 : 0;

  c.save();
  c.translate(p.x, p.y);
  c.scale(s, s);

  const body = '#0a0f16';
  const rim = rgba(ph.color, 0.34);

  // Legs: seated with bent knees (thigh forward, shin down), only a little shows
  c.fillStyle = body;
  c.beginPath();
  c.moveTo(2, -28);
  c.lineTo(22, -26);
  c.lineTo(24, -16);
  c.lineTo(20, -4);
  c.lineTo(8, -4);
  c.lineTo(4, -18);
  c.closePath();
  c.fill();

  // Torso: leaning slightly forward, rising and falling with the breath
  c.save();
  c.translate(0, breathe);
  c.beginPath();
  c.moveTo(-14, -30);
  c.quadraticCurveTo(-16, -46, -8, -52);
  c.lineTo(10, -52);
  c.quadraticCurveTo(17, -45, 15, -29);
  c.closePath();
  c.fill();

  // Head (no features, just a circle)
  c.beginPath();
  c.arc(2 + Math.sin(t * 0.8) * 0.7, -60, 9.6, 0, Math.PI * 2);
  c.fill();
  c.restore();

  // Arms: while awaiting authorization it raises a sign (one hand holds a board high), other states reuse swipe/tap/watch
  const isAwait = state.phase === 'await';
  if (isAwait) {
    // Sign-raising arm: raise the hand only to head height, do not go above the head and block the floating screen
    const bob = Math.sin(t * 2.2) * 2.4;
    const sh = { x: 8, y: -47 + breathe };
    const hand = { x: 28, y: -60 + bob + breathe };
    const el = { x: (sh.x + hand.x) / 2 + 5, y: (sh.y + hand.y) / 2 };
    c.strokeStyle = body;
    c.lineWidth = 7;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(sh.x, sh.y);
    c.lineTo(el.x, el.y);
    c.lineTo(hand.x, hand.y);
    c.stroke();
    // Other hand resting on the tabletop edge
    c.beginPath();
    c.moveTo(-10, -46 + breathe);
    c.lineTo(-16, -38 + breathe);
    c.lineTo(-6, -32 + breathe);
    c.stroke();
    // Sign: keep it small, held at head height (bottom touches the hand, entirely below the top of the head), does not block the screen
    const bw = 22;
    const bh = 12;
    const boardCx = hand.x + 1;
    const boardCy = hand.y - bh / 2 - 3;
    // Sign post (hand → sign bottom)
    c.strokeStyle = '#3a4252';
    c.lineWidth = 2.6;
    c.beginPath();
    c.moveTo(hand.x, hand.y);
    c.lineTo(boardCx, boardCy + bh / 2);
    c.stroke();
    // Soft halo on the sign
    c.save();
    c.globalCompositeOperation = 'lighter';
    const sg2 = c.createRadialGradient(boardCx, boardCy, 0, boardCx, boardCy, 16);
    sg2.addColorStop(0, rgba(ph.color, 0.28));
    sg2.addColorStop(1, rgba(ph.color, 0));
    c.fillStyle = sg2;
    c.beginPath();
    c.arc(boardCx, boardCy, 16, 0, Math.PI * 2);
    c.fill();
    c.restore();
    // Sign face: small, dark gray base
    c.fillStyle = '#414a5a';
    c.fillRect(boardCx - bw / 2, boardCy - bh / 2, bw, bh);
    c.strokeStyle = '#6b7686';
    c.lineWidth = 1.1;
    c.strokeRect(boardCx - bw / 2, boardCy - bh / 2, bw, bh);
    // On the sign, a row of two white dots suggests text (dot 4: the original three rows of white dots became one row of two)
    c.fillStyle = 'rgba(232,237,242,0.92)';
    const dotR = 1.25;
    const gap = 3.3;
    const rowW = gap;
    const sx = boardCx - rowW / 2;
    for (let d = 0; d < 2; d += 1) {
      c.beginPath();
      c.arc(sx + d * gap, boardCy, dotR, 0, Math.PI * 2);
      c.fill();
    }
    // Rim light on the sign-raising arm
    c.strokeStyle = rim;
    c.lineWidth = 1.4;
    c.beginPath();
    c.moveTo(el.x, el.y);
    c.lineTo(hand.x, hand.y);
    c.stroke();
  } else {
  // Arm: shoulder → elbow → hand, the hand reaches toward the console (down-right on screen)
  const sh = { x: 8, y: -47 + breathe };
  const hand = { x: 26 + handU, y: -34 + handV + breathe };
  const el = { x: (sh.x + hand.x) / 2 + 4, y: (sh.y + hand.y) / 2 + 5 };
  c.strokeStyle = body;
  c.lineWidth = 7;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(sh.x, sh.y);
  c.lineTo(el.x, el.y);
  c.lineTo(hand.x, hand.y);
  c.stroke();
  // Other hand resting on the tabletop edge, barely moving
  c.beginPath();
  c.moveTo(-10, -46 + breathe);
  c.lineTo(-16, -38 + breathe);
  c.lineTo(-6, -32 + breathe);
  c.stroke();

  // Rim light: the screen is down-right, so the bright edge is pressed onto the right side
  c.strokeStyle = rim;
  c.lineWidth = 1.4;
  c.beginPath();
  c.moveTo(15, -29 + breathe);
  c.quadraticCurveTo(17, -45 + breathe, 10, -52 + breathe);
  c.stroke();
  c.beginPath();
  c.arc(2, -60, 9.6, -Math.PI * 0.35, Math.PI * 0.5);
  c.stroke();
  c.beginPath();
  c.moveTo(el.x, el.y);
  c.lineTo(hand.x, hand.y);
  c.stroke();

  // A bit of light on the hand: lights up only on swipe / tap, as if operating on the screen
  if (kind !== 'watch') {
    c.save();
    c.globalCompositeOperation = 'lighter';
    const gg = c.createRadialGradient(hand.x, hand.y, 0, hand.x, hand.y, 9);
    gg.addColorStop(0, rgba(ph.color, 0.5));
    gg.addColorStop(1, rgba(ph.color, 0));
    c.fillStyle = gg;
    c.beginPath();
    c.arc(hand.x, hand.y, 9, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }
  }

  c.restore();
}
