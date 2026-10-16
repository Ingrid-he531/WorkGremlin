/**
 * iso.js —— projection + basic geometry drawing primitives for the isometric office.
 *
 * Everything is drawn live with Canvas 2D, relying on no external assets.
 *
 * Coordinate convention (world coordinates, unit = tile, roughly 1 meter):
 *   gx toward front-right (30° to the screen bottom-right)
 *   gy toward front-left (30° to the screen bottom-left)
 *   gz upward (straight up on screen)
 *
 * The projection is **true isometric**: the three axes are 120° apart on screen and equal in length (classic 30° isometric).
 *   sx = gx*AX.x + gy*AY.x + gz*AZ.x
 *   sy = gx*AX.y + gy*AY.y + gz*AZ.y
 * So the ground (x-y plane) is a standard diamond and the room forms a tidy box,
 * the back wall / left wall / desk top / screen are all parallelogram faces —— none of them faces the camera head-on.
 *
 * (No true-perspective "near large, far small": parallel relationships vanish, and both sorting and texturing would have to be redone.
 *  Parallel projection keeps shapes tidy, and occlusion can still be sorted with a single depth key.)
 *
 * Occlusion: the camera sits in the +x +y +z direction, so a larger depth is closer to the camera and later draws cover earlier ones.
 */

/** The "axis length" of one tile on screen (three equal axes = isometric) */
export const TILE = 44;
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);

/** Screen vectors for the three world axes (pixels / 1 tile) */
export const AX = { x: TILE * COS30, y: TILE * SIN30 };
export const AY = { x: -TILE * COS30, y: TILE * SIN30 };
export const AZ = { x: 0, y: -TILE };

/** Screen pixels for one height unit */
export const UNIT_Z = -AZ.y;

/** World coordinates → screen coordinates (camera zoom not applied; zoom is left to ctx.transform) */
export function project(gx, gy, gz = 0) {
  return {
    x: gx * AX.x + gy * AY.x + gz * AZ.x,
    y: gx * AX.y + gy * AY.y + gz * AZ.y,
  };
}

/**
 * Depth key: larger means closer to the front (drawn later).
 * Under isometric the two horizontal axes both "shrink with distance from the camera", so gx and gy carry equal weight: depth = gx + gy.
 */
export const depthOf = (gx, gy) => gx + gy;

/**
 * A circle on the ground (z = const plane) centered at (x, y) with world radius r projects to an **oblique ellipse**.
 * Solve for the semi-axes and tilt from the two conjugate radii u = r*AX and v = r*AY, then feed them straight to ctx.ellipse.
 */
export function groundEllipse(x, y, r, z = 0) {
  const c = project(x, y, z);
  const ux = r * AX.x;
  const uy = r * AX.y;
  const vx = r * AY.x;
  const vy = r * AY.y;
  const A = ux * ux + uy * uy;
  const B = ux * vx + uy * vy;
  const C = vx * vx + vy * vy;
  const s = (A + C) / 2;
  const d = Math.hypot((A - C) / 2, B);
  const t = 0.5 * Math.atan2(2 * B, A - C);
  const px = ux * Math.cos(t) + vx * Math.sin(t);
  const py = uy * Math.cos(t) + vy * Math.sin(t);
  return {
    x: c.x,
    y: c.y,
    rx: Math.sqrt(Math.max(0, s + d)),
    ry: Math.sqrt(Math.max(0, s - d)),
    rot: Math.atan2(py, px),
  };
}

/* ------------------------------------------------------------------ *
 * Color
 * ------------------------------------------------------------------ */

/** Color shading: k < 1 darkens, k > 1 brightens */
export function shade(hex, k) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  const r = clamp255(((n >> 16) & 255) * k);
  const g = clamp255(((n >> 8) & 255) * k);
  const b = clamp255((n & 255) * k);
  return `rgb(${r},${g},${b})`;
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** hex → rgba(...) */
export function rgba(hex, a) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ------------------------------------------------------------------ *
 * Basic primitives
 * ------------------------------------------------------------------ */

/** Polygon: [{x,y}...] */
export function poly(ctx, pts, fill, stroke, lw = 1) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}

/** Diamond on the ground (tile / carpet / zone base color) */
export function isoDiamond(ctx, o) {
  const { x, y, w, d, z = 0, fill, stroke, alpha = 1, lw = 1 } = o;
  const pts = [project(x, y, z), project(x + w, y, z), project(x + w, y + d, z), project(x, y + d, z)];
  ctx.save();
  if (alpha !== 1) ctx.globalAlpha *= alpha;
  poly(ctx, pts, fill, stroke, lw);
  ctx.restore();
}

/**
 * Isometric cuboid: the visible top face + two side faces.
 * The top face is brightest, the rear-right side (+gy, screen bottom-left) is mid, and the right side (+gx, screen bottom-right) is darkest.
 */
export function isoBox(ctx, o) {
  const { x, y, z = 0, w, d, h, color, alpha = 1, stroke, lw = 1, top, south, east } = o;
  const cTop = top || shade(color, 1.1);
  const cSouth = south || shade(color, 0.8);
  const cEast = east || shade(color, 0.58);

  ctx.save();
  if (alpha !== 1) ctx.globalAlpha *= alpha;
  // Face toward +gy (screen bottom-left)
  poly(ctx, [project(x, y + d, z + h), project(x + w, y + d, z + h), project(x + w, y + d, z), project(x, y + d, z)], cSouth, stroke, lw);
  // Face toward +gx (screen bottom-right)
  poly(ctx, [project(x + w, y, z + h), project(x + w, y + d, z + h), project(x + w, y + d, z), project(x + w, y, z)], cEast, stroke, lw);
  // Top face
  poly(ctx, [project(x, y, z + h), project(x + w, y, z + h), project(x + w, y + d, z + h), project(x, y + d, z + h)], cTop, stroke, lw);
  ctx.restore();
}

/**
 * Cylinder (cup, bucket, plant pot, chair center post).
 * Under oblique projection a ground circle is an **oblique ellipse**, which cannot be assembled from axis-aligned ctx.ellipse calls,
 * so the circumference is discretized into a polygon and projected point by point: the side = the band the circumference sweeps along the z axis.
 */
export function isoCylinder(ctx, o) {
  const { x, y, z = 0, r, h, color, alpha = 1, stroke, lw = 1, seg = 20 } = o;
  const bot = [];
  const top = [];
  for (let i = 0; i < seg; i += 1) {
    const t = (i / seg) * Math.PI * 2;
    const dx = Math.cos(t) * r;
    const dy = Math.sin(t) * r;
    bot.push(project(x + dx, y + dy, z));
    top.push(project(x + dx, y + dy, z + h));
  }

  ctx.save();
  if (alpha !== 1) ctx.globalAlpha *= alpha;
  // Side: bottom ring in forward order + top ring in reverse, so nonzero fill gives exactly the "swept band"
  ctx.beginPath();
  ctx.moveTo(bot[0].x, bot[0].y);
  for (let i = 1; i < seg; i += 1) ctx.lineTo(bot[i].x, bot[i].y);
  for (let i = seg - 1; i >= 0; i -= 1) ctx.lineTo(top[i].x, top[i].y);
  ctx.closePath();
  ctx.fillStyle = shade(color, 0.62);
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
  // Top face
  ctx.beginPath();
  ctx.moveTo(top[0].x, top[0].y);
  for (let i = 1; i < seg; i += 1) ctx.lineTo(top[i].x, top[i].y);
  ctx.closePath();
  ctx.fillStyle = shade(color, 1.12);
  ctx.fill();
  ctx.restore();
}

/** Ground shadow */
export function isoShadow(ctx, x, y, r = 0.42, alpha = 0.28) {
  const e = groundEllipse(x, y, r, 0);
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.beginPath();
  ctx.ellipse(e.x, e.y, e.rx, e.ry, e.rot, 0, Math.PI * 2);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();
}

/**
 * Rectangle on a wall (applied to the inner side of the back wall or left wall).
 * axis='y': back wall (gy fixed), a0/a1 is the gx range
 * axis='x': left wall (gx fixed), a0/a1 is the gy range
 */
export function wallQuad(ctx, axis, fixed, a0, a1, z0, z1, fill, stroke, lw = 1) {
  const p =
    axis === 'y'
      ? [project(a0, fixed, z1), project(a1, fixed, z1), project(a1, fixed, z0), project(a0, fixed, z0)]
      : [project(fixed, a0, z1), project(fixed, a1, z1), project(fixed, a1, z0), project(fixed, a0, z0)];
  poly(ctx, p, fill, stroke, lw);
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

/** Rounded rectangle path (independent of ctx.roundRect compatibility) */
export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** String → stable hash (used for palette colors and screen-content jitter) */
export function hash(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
