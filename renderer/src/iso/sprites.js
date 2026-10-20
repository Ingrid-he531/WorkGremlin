/**
 * sprites.js —— Canvas sprites (gremlin / ghost) and overhead tags.
 *
 * All use a "billboard" style: the body always faces the camera, the soles align with the ground projection point,
 * so they keep a solid look without warping in an isometric scene.
 *
 * Local coordinates: sole center = (0, 0), up is -y, total height about 70 units (scaled externally by scale).
 */

import { hash, roundRectPath } from './iso';
import { normalizeState } from '../lib/memberTask';

export const SPRITE_UNITS = 70;

/** Body palette (stable hash by memberId) */
const PALETTE = [
  '#ffd79a', '#8fd3f4', '#2fbf71', '#c084fc',
  '#ff8fa3', '#9aa7b8', '#f2a33c', '#5aa9e6',
];

export function colorOf(id) {
  return PALETTE[hash(id) % PALETTE.length];
}

/** Prop in hand: guess the role from the name —— fall back to a small notepad */
const PROPS = {
  leader: 'megaphone',
  researcher: 'magnifier',
  coder: 'keyboard',
  tester: 'shield',
  reviewer: 'clipboard',
  ops: 'gear',
};

export function propOf(id) {
  const n = String(id || '').split('@')[0].toLowerCase();
  return PROPS[n] || 'note';
}

const FONT = '12px ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';

/* ------------------------------------------------------------------ *
 * Gremlin
 * ------------------------------------------------------------------ */

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number,s:number,color:string,state:string,facing?:number,
 *          walking?:boolean,phase?:number,sitting?:boolean,alpha?:number}} o
 */
export function drawGremlin(ctx, o) {
  const {
    x, y, s, color, state = 'idle',
    facing = 1, walking = false, phase = 0,
    sitting = false, alpha = 1, level,
  } = o;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s * facing, s);
  if (alpha !== 1) ctx.globalAlpha *= alpha;
  const normalizedState = normalizeState(state);

  const bounce = walking ? Math.abs(Math.sin(phase * 2)) * 2.2 : 0;
  const sink = sitting ? 5 : 0; // Sitting: sink down a little overall
  /**
   * When sitting, lift another 8 units: the rear lands on the seat surface (z≈0.42) and the calves dangle in front.
   * Without the lift the body sinks to ground level, and the chair back (the side facing the camera) leaves only the eyes and horns visible —— like being stuck down in the chair.
   * Keep the amount within the 12px gap under the overhead tag so the horns do not poke the tag.
   */
  const lift = sitting ? 8 : 0;
  ctx.translate(0, -bounce + sink - lift);

  const dark = mix(color, '#101720', 0.28);
  const belly = mix(color, '#ffffff', 0.42);

  // Legs
  const legH = sitting ? 4 : 13;
  roundRectPath(ctx, -10, -legH, 8, legH + 1, 3);
  ctx.fillStyle = dark;
  ctx.fill();
  roundRectPath(ctx, 2, -legH, 8, legH + 1, 3);
  ctx.fill();

  // Body
  const bodyTop = -40 + sink;
  roundRectPath(ctx, -15, bodyTop, 30, 31, 13);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = mix(color, '#000000', 0.35);
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Belly
  ctx.beginPath();
  ctx.ellipse(0, bodyTop + 20, 9.5, 8, 0, 0, Math.PI * 2);
  ctx.fillStyle = belly;
  ctx.fill();

  // Arms (swing back and forth while walking)
  const swing = walking ? Math.sin(phase * 2) * 5 : 0;
  ctx.strokeStyle = dark;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-14, bodyTop + 8);
  ctx.lineTo(-19, bodyTop + 18 + swing);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(14, bodyTop + 8);
  ctx.lineTo(19, bodyTop + 18 - swing);
  ctx.stroke();

  // Head
  const headY = -52 + sink;
  ctx.beginPath();
  ctx.arc(0, headY, 15.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.stroke();

  // Two horns
  ctx.beginPath();
  ctx.moveTo(-11, headY - 11);
  ctx.lineTo(-14, headY - 22);
  ctx.lineTo(-4, headY - 15);
  ctx.closePath();
  ctx.moveTo(11, headY - 11);
  ctx.lineTo(14, headY - 22);
  ctx.lineTo(4, headY - 15);
  ctx.closePath();
  ctx.fillStyle = dark;
  ctx.fill();

  drawFace(ctx, headY, normalizedState);

  // Prop in hand
  ctx.save();
  ctx.translate(17, bodyTop + 20);
  drawProp(ctx, o.prop || 'note', color);
  ctx.restore();

  // Badge on the neck: color distinguishes user level / project level (demo experts use neutral gray), with the black initial as the "name"
  ctx.save();
  if (facing < 0) ctx.scale(-1, 1); // The letter on the badge must not mirror along with the body
  drawLevelBadge(ctx, level, String(o.name || '').trim().charAt(0).toUpperCase(), { nx: 0, ny: bodyTop + 2 }, { bx: 0, by: bodyTop + 10 });
  ctx.restore();

  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Ghost (temporary member)
 * ------------------------------------------------------------------ */

export function drawGhost(ctx, o) {
  const {
    x, y, s, color, state = 'idle',
    facing = 1, phase = 0, alpha = 0.72,
  } = o;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s * facing, s);
  ctx.globalAlpha *= alpha;
  const normalizedState = normalizeState(state);

  const bob = Math.sin(phase) * 2; // Float: bob up and down overall
  ctx.translate(0, bob);

  const light = mix(color, '#ffffff', 0.35);
  const headY = -48;

  // Body: a half-circle on top + straight sides + a wavy hem
  ctx.beginPath();
  ctx.arc(0, headY, 15, Math.PI, 0);
  ctx.lineTo(15, -10);
  const n = 4;
  const step = -30 / n;
  for (let i = 0; i < n; i += 1) {
    const sx = 15 + step * i;
    const ex = sx + step;
    const dir = i % 2 === 0 ? 1 : -1;
    ctx.quadraticCurveTo((sx + ex) / 2, -10 + dir * 7, ex, -10);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = light;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.restore();

  // Highlight
  ctx.beginPath();
  ctx.ellipse(-6, headY + 2, 5, 7, -0.3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fill();

  drawFace(ctx, headY, normalizedState, true);

  // Antenna (remote access)
  ctx.strokeStyle = light;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, headY - 14);
  ctx.lineTo(2, headY - 22);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(2, headY - 23, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = light;
  ctx.fill();

  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Badge (level card on the neck) —— used only by the gremlin (drawGremlin)
 * ------------------------------------------------------------------ */

/**
 * Draw a small badge hanging on the neck. Distinguish subagent levels with a clearly solid background color:
 *   · user    -> blue (#3b82f6)
 *   · project -> green (#22c55e)
 *   · other (demo expert / regular member) -> neutral gray (#7c8aa5)
 * Write the name's initial in black at the center of the card (for Chinese names, take the first character).
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} level 'user' | 'project' | other
 * @param {string} initial Name initial (draw no letter when empty string)
 * @param {{nx:number, ny:number}} neck Neck anchor where the lanyard attaches
 * @param {{bx:number, by:number}} anchor Card horizontal center x and top edge y
 */
function drawLevelBadge(ctx, level, initial, neck, anchor) {
  const color =
    level === 'user' ? '#3b82f6' : level === 'project' ? '#22c55e' : '#7c8aa5';
  ctx.save();
  // Lanyard: pull from both sides of the neck to the top edge of the card (the anchor is at the neck, below the head and above the body)
  ctx.strokeStyle = 'rgba(20,24,32,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(neck.nx - 3, neck.ny);
  ctx.lineTo(anchor.bx - 3, anchor.by);
  ctx.moveTo(neck.nx + 3, neck.ny);
  ctx.lineTo(anchor.bx + 3, anchor.by);
  ctx.stroke();
  // Vertical rectangular card: a clearly solid background color + black border
  const cardW = 11;
  const cardH = 15;
  const left = anchor.bx - cardW / 2;
  roundRectPath(ctx, left, anchor.by, cardW, cardH, 2.5);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#0f141b';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // Name initial (black, centered)
  if (initial) {
    ctx.fillStyle = '#0f141b';
    ctx.font = '700 9px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, anchor.bx, anchor.by + cardH / 2 + 0.5);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Expression
 * ------------------------------------------------------------------ */

function drawFace(ctx, headY, state, ghost = false) {
  const eyeY = headY - 1;
  const eyeX = 5.6;
  ctx.save();
  ctx.fillStyle = '#1b2029';
  ctx.strokeStyle = '#1b2029';
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';

  if (state === 'idle') {
    // Closed eyes: two downward arcs
    ctx.beginPath();
    ctx.arc(-eyeX, eyeY + 1, 3.4, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(eyeX, eyeY + 1, 3.4, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
    // Zzz
    ctx.fillStyle = ghost ? 'rgba(200,230,255,0.9)' : '#8fa3bf';
    ctx.font = 'italic 9px ui-sans-serif, sans-serif';
    ctx.fillText('z', 12, headY - 16);
    ctx.font = 'italic 7px ui-sans-serif, sans-serif';
    ctx.fillText('z', 17, headY - 21);
  } else if (state === 'busy') {
    // Focused: squinted eyes + furrowed brows
    ctx.beginPath();
    ctx.moveTo(-eyeX - 3, eyeY);
    ctx.lineTo(-eyeX + 3, eyeY - 1.5);
    ctx.moveTo(eyeX - 3, eyeY - 1.5);
    ctx.lineTo(eyeX + 3, eyeY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-eyeX - 3, eyeY - 6);
    ctx.lineTo(-eyeX + 3, eyeY - 4);
    ctx.moveTo(eyeX - 3, eyeY - 4);
    ctx.lineTo(eyeX + 3, eyeY - 6);
    ctx.lineWidth = 1.3;
    ctx.stroke();
  } else if (state === 'blocked') {
    // Blocked: eyes are two dots + an exclamation mark overhead
    ctx.beginPath();
    ctx.arc(-eyeX, eyeY, 2.4, 0, Math.PI * 2);
    ctx.arc(eyeX, eyeY, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-eyeX - 4, eyeY - 6);
    ctx.lineTo(-eyeX + 3, eyeY - 3);
    ctx.moveTo(eyeX + 4, eyeY - 6);
    ctx.lineTo(eyeX - 3, eyeY - 3);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = '#ff5c5c';
    ctx.font = 'bold 15px ui-sans-serif, sans-serif';
    ctx.fillText('!', -2, headY - 20);
  } else {
    // Fallback: bright eyes + highlight
    ctx.beginPath();
    ctx.ellipse(-eyeX, eyeY, 3.2, 4, 0, 0, Math.PI * 2);
    ctx.ellipse(eyeX, eyeY, 3.2, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(-eyeX + 1.1, eyeY - 1.4, 1.1, 0, Math.PI * 2);
    ctx.arc(eyeX + 1.1, eyeY - 1.4, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = '#1b2029';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  if (state === 'blocked') ctx.arc(0, headY + 12, 3.5, Math.PI * 1.15, Math.PI * 1.85);
  else ctx.arc(0, headY + 7, 4, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Props
 * ------------------------------------------------------------------ */

function drawProp(ctx, kind, color) {
  ctx.save();
  ctx.lineWidth = 1.4;
  const dark = mix(color, '#101720', 0.4);

  if (kind === 'megaphone') {
    ctx.fillStyle = '#f2c94c';
    ctx.beginPath();
    ctx.moveTo(-2, -4);
    ctx.lineTo(9, -9);
    ctx.lineTo(9, 9);
    ctx.lineTo(-2, 4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = dark;
    ctx.fillRect(-6, -3, 5, 6);
  } else if (kind === 'magnifier') {
    ctx.strokeStyle = '#cfd6e2';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(2, -2, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(6, 2);
    ctx.lineTo(11, 8);
    ctx.stroke();
  } else if (kind === 'keyboard') {
    ctx.fillStyle = '#cfd6e2';
    roundRectPath(ctx, -8, -6, 16, 9, 2);
    ctx.fill();
    ctx.fillStyle = '#5b6779';
    for (let i = 0; i < 3; i += 1) ctx.fillRect(-6, -4 + i * 2.4, 12, 1);
  } else if (kind === 'shield') {
    ctx.fillStyle = '#8fd3f4';
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(7, -5);
    ctx.lineTo(7, 2);
    ctx.quadraticCurveTo(7, 8, 0, 10);
    ctx.quadraticCurveTo(-7, 8, -7, 2);
    ctx.lineTo(-7, -5);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'clipboard') {
    ctx.fillStyle = '#e6ebf2';
    roundRectPath(ctx, -6, -8, 12, 15, 2);
    ctx.fill();
    ctx.fillStyle = '#5b6779';
    ctx.fillRect(-3, -10, 6, 3);
    ctx.fillStyle = '#9aa7b8';
    ctx.fillRect(-4, -4, 8, 1.4);
    ctx.fillRect(-4, -1, 8, 1.4);
  } else if (kind === 'gear') {
    ctx.fillStyle = '#9aa7b8';
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = mix(color, '#101720', 0.5);
    ctx.beginPath();
    ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = '#e6ebf2';
    roundRectPath(ctx, -5, -7, 10, 12, 2);
    ctx.fill();
    ctx.strokeStyle = '#9aa7b8';
    ctx.stroke();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Overhead tag
 * ------------------------------------------------------------------ */

/**
 * Draw a capsule tag (status dot + text).
 * @returns {{w:number,h:number}} Size (for hit testing)
 */
export function drawTag(ctx, o) {
  const { x, y, text, color, dashed = false, alpha = 1 } = o;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = FONT;
  const w = Math.round(ctx.measureText(text).width) + 30;
  const h = 20;
  ctx.translate(x, y);

  roundRectPath(ctx, -w / 2, -h, w, h, h / 2);
  ctx.fillStyle = 'rgba(14,18,24,0.92)';
  ctx.fill();
  ctx.setLineDash(dashed ? [4, 3] : []);
  ctx.strokeStyle = dashed ? color : '#39424f';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(-w / 2 + 13, -h / 2, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.fillStyle = '#e6ebf2';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, -w / 2 + 22, -h / 2 + 1);
  ctx.restore();
  return { w, h };
}

/** Measure tag width (for hit testing) */
export function measureTag(ctx, text) {
  ctx.save();
  ctx.font = FONT;
  const w = Math.round(ctx.measureText(text).width) + 30;
  ctx.restore();
  return { w, h: 20 };
}

/* ------------------------------------------------------------------ *
 * Color helpers
 * ------------------------------------------------------------------ */

function mix(a, b, t) {
  const pa = parse(a);
  const pb = parse(b);
  return `rgb(${Math.round(pa[0] + (pb[0] - pa[0]) * t)},${Math.round(pa[1] + (pb[1] - pa[1]) * t)},${Math.round(
    pa[2] + (pb[2] - pa[2]) * t
  )})`;
}

function parse(c) {
  const s = String(c).replace('#', '');
  const full = s.length === 3 ? s.split('').map((ch) => ch + ch).join('') : s;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
