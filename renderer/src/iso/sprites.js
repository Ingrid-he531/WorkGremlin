/**
 * sprites.js —— Canvas 版精灵（小怪物 / 幽灵）与头顶标签。
 *
 * 都是"广告牌"画法：身体始终正对镜头，脚底对齐地面投影点，
 * 这样在等距场景里既有立体感又不会变形。
 *
 * 局部坐标：脚底中心 = (0, 0)，向上为 -y，整体高约 70 单位（由外部 scale 缩放）。
 */

import { hash, roundRectPath } from './iso';

export const SPRITE_UNITS = 70;

/** 身体配色（按 memberId 稳定哈希） */
const PALETTE = [
  '#ffd79a', '#8fd3f4', '#2fbf71', '#c084fc',
  '#ff8fa3', '#9aa7b8', '#f2a33c', '#5aa9e6',
];

export function colorOf(id) {
  return PALETTE[hash(id) % PALETTE.length];
}

/** 手里的道具：按名字猜职业，猜不到就给个小本子 */
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
 * 小怪物
 * ------------------------------------------------------------------ */

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number,s:number,color:string,state:string,facing?:number,
 *          walking?:boolean,phase?:number,sitting?:boolean,degraded?:boolean,alpha?:number}} o
 */
export function drawGremlin(ctx, o) {
  const {
    x, y, s, color, state = 'online',
    facing = 1, walking = false, phase = 0,
    sitting = false, degraded = false, alpha = 1, level,
  } = o;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s * facing, s);
  if (alpha !== 1) ctx.globalAlpha *= alpha;
  if (state === 'offline') {
    // 离线：整体变淡、脚下加一个虚线环，避免融入暗背景
    ctx.globalAlpha *= 0.5;
    ctx.save();
    ctx.strokeStyle = '#9aa7b8';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 2, 18, 9, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  } else if (degraded) {
    ctx.filter = 'grayscale(0.85)';
  }

  const bounce = walking ? Math.abs(Math.sin(phase * 2)) * 2.2 : 0;
  const sink = sitting ? 5 : 0; // 坐着：整体下沉一点
  ctx.translate(0, -bounce + sink);

  const dark = mix(color, '#101720', 0.28);
  const belly = mix(color, '#ffffff', 0.42);

  // 腿
  const legH = sitting ? 4 : 13;
  roundRectPath(ctx, -10, -legH, 8, legH + 1, 3);
  ctx.fillStyle = dark;
  ctx.fill();
  roundRectPath(ctx, 2, -legH, 8, legH + 1, 3);
  ctx.fill();

  // 身体
  const bodyTop = -40 + sink;
  roundRectPath(ctx, -15, bodyTop, 30, 31, 13);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = mix(color, '#000000', 0.35);
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // 肚皮
  ctx.beginPath();
  ctx.ellipse(0, bodyTop + 20, 9.5, 8, 0, 0, Math.PI * 2);
  ctx.fillStyle = belly;
  ctx.fill();

  // 手臂（走路时前后摆）
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

  // 头
  const headY = -52 + sink;
  ctx.beginPath();
  ctx.arc(0, headY, 15.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.stroke();

  // 两只角
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

  drawFace(ctx, headY, state);

  // 手里的道具
  ctx.save();
  ctx.translate(17, bodyTop + 20);
  drawProp(ctx, o.prop || 'note', color);
  ctx.restore();

  // 脖子上的工牌：颜色区分用户级 / 项目级（演示专家用中性灰），两个白点示意有字
  drawLevelBadge(ctx, level, { nx: 0, ny: bodyTop + 2 }, { bx: 0, by: bodyTop + 10 });

  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * 幽灵（临时成员）
 * ------------------------------------------------------------------ */

export function drawGhost(ctx, o) {
  const {
    x, y, s, color, state = 'online',
    facing = 1, phase = 0, alpha = 0.72,
  } = o;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s * facing, s);
  ctx.globalAlpha *= alpha;
  if (state === 'offline') ctx.filter = 'grayscale(0.8)';

  const bob = Math.sin(phase) * 2; // 飘：整体上下
  ctx.translate(0, bob);

  const light = mix(color, '#ffffff', 0.35);
  const headY = -48;

  // 身体：头顶半圆 + 两侧直下 + 波浪下摆
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

  // 高光
  ctx.beginPath();
  ctx.ellipse(-6, headY + 2, 5, 7, -0.3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fill();

  drawFace(ctx, headY, state, true);

  // 天线（远程接入）
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
 * 工牌（脖子上的级别牌）—— 仅小怪物（drawGremlin）使用
 * ------------------------------------------------------------------ */

/**
 * 画一张挂在脖子上的小工牌。用明显的实色底色区分 subagent 级别：
 *   · user    -> 蓝（#3b82f6）
 *   · project -> 绿（#22c55e）
 *   · 其它（演示专家 / 普通成员）-> 中性灰（#7c8aa5）
 * 卡片上两个白点示意"有字"（不渲染文字，保持小尺寸清晰）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} level 'user' | 'project' | 其它
 * @param {{nx:number, ny:number}} neck 挂绳在脖子上的锚点
 * @param {{bx:number, by:number}} anchor 卡片的水平中心 x 与上沿 y
 */
function drawLevelBadge(ctx, level, neck, anchor) {
  const color =
    level === 'user' ? '#3b82f6' : level === 'project' ? '#22c55e' : '#7c8aa5';
  ctx.save();
  // 挂绳：从脖子两侧拉到卡片上沿（锚点在头部下方、身体上方的脖子处）
  ctx.strokeStyle = 'rgba(20,24,32,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(neck.nx - 3, neck.ny);
  ctx.lineTo(anchor.bx - 3, anchor.by);
  ctx.moveTo(neck.nx + 3, neck.ny);
  ctx.lineTo(anchor.bx + 3, anchor.by);
  ctx.stroke();
  // 竖长方形卡片：明显的实色底色 + 黑色边框
  const cardW = 11;
  const cardH = 15;
  const left = anchor.bx - cardW / 2;
  roundRectPath(ctx, left, anchor.by, cardW, cardH, 2.5);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#0f141b';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // 一个白点：示意卡片上有字
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(anchor.bx, anchor.by + cardH / 2, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * 表情
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
    // 闭眼：两条下弧
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
    // 专注：眯眼 + 皱眉
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
    // 卡住：眼睛是两个点 + 头顶感叹号
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
  } else if (state === 'offline') {
    // 离线：一条横线
    ctx.beginPath();
    ctx.moveTo(-eyeX - 3, eyeY);
    ctx.lineTo(-eyeX + 3, eyeY);
    ctx.moveTo(eyeX - 3, eyeY);
    ctx.lineTo(eyeX + 3, eyeY);
    ctx.lineWidth = 1.8;
    ctx.stroke();
  } else {
    // online：亮眼睛 + 高光
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

  // 嘴（除离线）
  if (state !== 'offline') {
    ctx.strokeStyle = '#1b2029';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (state === 'blocked') ctx.arc(0, headY + 12, 3.5, Math.PI * 1.15, Math.PI * 1.85);
    else ctx.arc(0, headY + 7, 4, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * 道具
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
 * 头顶标签
 * ------------------------------------------------------------------ */

/**
 * 画一个胶囊标签（状态点 + 文字）。
 * @returns {{w:number,h:number}} 尺寸（供命中测试）
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

/** 测量标签宽度（命中测试用） */
export function measureTag(ctx, text) {
  ctx.save();
  ctx.font = FONT;
  const w = Math.round(ctx.measureText(text).width) + 30;
  ctx.restore();
  return { w, h: 20 };
}

/* ------------------------------------------------------------------ *
 * 颜色工具
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
