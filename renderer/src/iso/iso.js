/**
 * iso.js —— 等距（isometric）办公室的投影 + 基础几何绘制原语。
 *
 * 全部用 Canvas 2D 现画，不依赖任何外部素材。
 *
 * 坐标约定（世界坐标，单位 = tile，约等于 1 米）：
 *   gx 向右前（屏幕右下 30°）
 *   gy 向左前（屏幕左下 30°）
 *   gz 向上（屏幕竖直向上）
 *
 * 投影用的是**真等距**：三根轴在屏幕上两两成 120°、长度相等（经典 30° 等距）。
 *   sx = gx*AX.x + gy*AY.x + gz*AZ.x
 *   sy = gx*AX.y + gy*AY.y + gz*AZ.y
 * 于是地面（x-y 平面）是标准菱形、房间围成一个规整的盒子，
 * 后墙 / 左墙 / 桌面 / 屏幕都是平行四边形的面 —— 没有任何一面是"正对镜头"的。
 *
 * （不用真透视的"近大远小"：平行关系消失，排序和贴图都要重做。
 *  平行投影形状规整，遮挡仍可用一个 depth 键排出来。）
 *
 * 遮挡：相机在 +x +y +z 方向，depth 越大越靠近镜头，后画的压住先画的。
 */

/** 一个地砖在屏幕上的"轴长"（三轴等长 = 等距） */
export const TILE = 44;
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);

/** 世界三根轴在屏幕上的向量（像素 / 1 tile） */
export const AX = { x: TILE * COS30, y: TILE * SIN30 };
export const AY = { x: -TILE * COS30, y: TILE * SIN30 };
export const AZ = { x: 0, y: -TILE };

/** 1 个高度单位对应的屏幕像素 */
export const UNIT_Z = -AZ.y;

/** 世界坐标 → 屏幕坐标（未乘相机缩放，缩放交给 ctx.transform） */
export function project(gx, gy, gz = 0) {
  return {
    x: gx * AX.x + gy * AY.x + gz * AZ.x,
    y: gx * AX.y + gy * AY.y + gz * AZ.y,
  };
}

/**
 * 排序键：越大越靠前（后画）。
 * 等距下两根水平轴都是"离镜头越远越小"，所以 gx、gy 权重相同：depth = gx + gy。
 */
export const depthOf = (gx, gy) => gx + gy;

/**
 * 地面（z = const 平面）上以 (x, y) 为心、世界半径 r 的圆，投影后是个**斜椭圆**。
 * 由两条共轭半径 u = r*AX、v = r*AY 解出半轴与倾角，直接喂给 ctx.ellipse。
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
 * 颜色
 * ------------------------------------------------------------------ */

/** 颜色明暗：k < 1 变暗，k > 1 变亮 */
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
 * 基础图元
 * ------------------------------------------------------------------ */

/** 多边形：[{x,y}...] */
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

/** 地面上的菱形（地砖 / 地毯 / 区域底色） */
export function isoDiamond(ctx, o) {
  const { x, y, w, d, z = 0, fill, stroke, alpha = 1, lw = 1 } = o;
  const pts = [project(x, y, z), project(x + w, y, z), project(x + w, y + d, z), project(x, y + d, z)];
  ctx.save();
  if (alpha !== 1) ctx.globalAlpha *= alpha;
  poly(ctx, pts, fill, stroke, lw);
  ctx.restore();
}

/**
 * 等距长方体：可见的顶面 + 两个侧面。
 * 顶面最亮、右后侧（+gy，屏幕左下）中等、右侧（+gx，屏幕右下）最暗。
 */
export function isoBox(ctx, o) {
  const { x, y, z = 0, w, d, h, color, alpha = 1, stroke, lw = 1, top, south, east } = o;
  const cTop = top || shade(color, 1.1);
  const cSouth = south || shade(color, 0.8);
  const cEast = east || shade(color, 0.58);

  ctx.save();
  if (alpha !== 1) ctx.globalAlpha *= alpha;
  // 朝 +gy 的面（屏幕左下）
  poly(ctx, [project(x, y + d, z + h), project(x + w, y + d, z + h), project(x + w, y + d, z), project(x, y + d, z)], cSouth, stroke, lw);
  // 朝 +gx 的面（屏幕右下）
  poly(ctx, [project(x + w, y, z + h), project(x + w, y + d, z + h), project(x + w, y + d, z), project(x + w, y, z)], cEast, stroke, lw);
  // 顶面
  poly(ctx, [project(x, y, z + h), project(x + w, y, z + h), project(x + w, y + d, z + h), project(x, y + d, z + h)], cTop, stroke, lw);
  ctx.restore();
}

/**
 * 圆柱（杯子、水桶、绿植盆、椅子的中柱）。
 * 斜投影下地面圆是**斜椭圆**，没法用轴对齐的 ctx.ellipse 拼，
 * 所以直接把圆周离散成多边形逐点投影：侧面 = 圆周沿 z 轴扫出的带。
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
  // 侧面：底环正序 + 顶环逆序，nonzero 填充正好是"扫掠带"
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
  // 顶面
  ctx.beginPath();
  ctx.moveTo(top[0].x, top[0].y);
  for (let i = 1; i < seg; i += 1) ctx.lineTo(top[i].x, top[i].y);
  ctx.closePath();
  ctx.fillStyle = shade(color, 1.12);
  ctx.fill();
  ctx.restore();
}

/** 落地投影 */
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
 * 墙面上的矩形（贴在后墙或左墙内侧）。
 * axis='y'：后墙（gy 固定），a0/a1 是 gx 范围
 * axis='x'：左墙（gx 固定），a0/a1 是 gy 范围
 */
export function wallQuad(ctx, axis, fixed, a0, a1, z0, z1, fill, stroke, lw = 1) {
  const p =
    axis === 'y'
      ? [project(a0, fixed, z1), project(a1, fixed, z1), project(a1, fixed, z0), project(a0, fixed, z0)]
      : [project(fixed, a0, z1), project(fixed, a1, z1), project(fixed, a1, z0), project(fixed, a0, z0)];
  poly(ctx, p, fill, stroke, lw);
}

/* ------------------------------------------------------------------ *
 * 杂项
 * ------------------------------------------------------------------ */

/** 圆角矩形路径（不依赖 ctx.roundRect 的兼容性） */
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

/** 字符串 → 稳定哈希（配色、屏幕内容抖动都用它） */
export function hash(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
