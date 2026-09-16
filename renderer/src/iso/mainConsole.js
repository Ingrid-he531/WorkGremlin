/**
 * mainConsole.js —— 主 Agent（Craft Agent）控制台。
 *
 * 只负责画，不负责状态：阶段、动作、上下文都由外面传进来（现在传的是 mock，
 * 以后换成 hook 事件即可，见 stores/mainAgent.js）。
 *
 * 三样东西：
 *   1. 控制台本体（矮柜 + 台面 + 指示灯）—— 暗色低多边形，跟屋里家具同一套画法
 *   2. 悬浮屏——贴在 gy 恒定的竖直面上，所以等距下是平行四边形，内容正对镜头
 *      三层信息：阶段（最大）/ 动作或对象（中）/ 任务上下文（小、可滚动）
 *      远看是一块发光板（只留阶段名 + 抽象光条），放大到能看清时才把后两层写出来
 *   3. 剪影——深色的一个坐着的影子，没有五官；手在滑 / 点 / 悬停，不敲键盘
 *
 * 局部坐标：屏幕内容用 (u, v) 两个 tile 当单位，u 沿 +gx、v 向下（跟名牌同一套斜切）。
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

/** 屏幕第一层：五个阶段。busy 决定有没有光标 / 加载动画 */
export const PHASES = {
  idle: { label: '待命中', color: '#6b7c94', glow: 0.22, busy: false },
  plan: { label: '规划中', color: '#7fb0ff', glow: 0.55, busy: true },
  tool: { label: '调用工具', color: '#4c8dff', glow: 0.85, busy: true },
  dispatch: { label: '委托专家', color: '#c084fc', glow: 1.0, busy: true },
  summarize: { label: '汇总中', color: '#2fbf71', glow: 0.7, busy: true },
};

export const PHASE_LIST = Object.keys(PHASES);

const FONT = 'ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';

/** 剪影：跟精灵同一套局部单位（70 ≈ 1.55 tile 高），坐着所以整体矮一截 */
const BODY_UNITS = 70;
const BODY_H = 1.55;

/** 量一段文字，超宽就截掉加省略号（省得挤出屏外） */
function fit(c, text, maxW) {
  const s = String(text || '');
  if (!s) return '';
  if (c.measureText(s).width <= maxW) return s;
  let t = s;
  while (t.length > 1 && c.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/* ------------------------------------------------------------------ *
 * 控制台本体
 * ------------------------------------------------------------------ */

/**
 * 矮柜 + 台面 + 正面指示灯带 + 两根托屏的光柱。
 * 指示灯是唯一会动的地方：跑马灯式地亮过去，暗示"一直在运转"。
 */
export function drawConsoleDesk(c, now) {
  const { x, y, w, d, h } = CONSOLE.desk;

  // 屏幕漏到台面和地上的光
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

  // 柜体：下半深、台面浅一档（低多边形就靠这两块面）
  isoBox(c, { x, y, z: 0, w, d, h: h - 0.1, color: '#252c39' });
  isoBox(c, { x: x - 0.05, y: y - 0.05, z: h - 0.1, w: w + 0.1, d: d + 0.1, h: 0.1, color: '#39414f' });

  // 正面（朝 +gy = 朝镜头）的指示灯带
  const face = y + d;
  const lights = 9;
  const lz = h * 0.42;
  for (let i = 0; i < lights; i += 1) {
    const u = x + 0.4 + i * ((w - 0.8) / (lights - 1));
    // 跑马灯：亮的位置随时间往前推
    const k = ((now / 900 + i * 0.12) % 1.6) / 1.6;
    const on = k < 0.34;
    const col = on ? '#6fa8ff' : i % 3 === 0 ? '#3d4c66' : '#2c3646';
    wallQuad(c, 'y', face + 0.002, u - 0.08, u + 0.08, lz, lz + 0.09, col);
  }

  // 台面上斜放的一块操作板（一块薄板 + 两道凹槽，不画键盘——主 Agent 不敲键盘）
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

  // 托住悬浮屏的两根光柱
  CONSOLE.posts.forEach((px) => {
    isoBox(c, { x: px - 0.045, y: y + 0.3, z: h, w: 0.09, d: 0.09, h: CONSOLE.screen.z0 - h, color: '#39414f' });
    // 柱顶一小截发光，光柱才有"撑着屏幕"的感觉
    wallQuad(c, 'y', y + 0.3 + 0.09, px - 0.045, px + 0.045, CONSOLE.screen.z0 - 0.12, CONSOLE.screen.z0, 'rgba(111,168,255,0.5)');
  });
}

/* ------------------------------------------------------------------ *
 * 悬浮屏
 * ------------------------------------------------------------------ */

/**
 * @param {CanvasRenderingContext2D} c
 * @param {{state:{phase:string,action:string,context:string[]}, now:number, zoom:number}} o
 */
export function drawConsoleScreen(c, o) {
  const { state, now, zoom } = o;
  const s = CONSOLE.screen;
  const ph = PHASES[state.phase] || PHASES.idle;
  const W = s.w;
  const H = s.z1 - s.z0;
  const face = s.y;

  // 边框（比屏大一圈，当作屏幕的厚度）
  wallQuad(c, 'y', face - 0.012, s.x - 0.07, s.x + W + 0.07, s.z0 - 0.07, s.z1 + 0.07, '#1a2130');
  // 屏底：几乎全黑，靠后面的辉光提亮
  wallQuad(c, 'y', face, s.x, s.x + W, s.z0, s.z1, '#05080e');

  // 整屏辉光：执行中亮、待命中几乎不亮
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

  // ---- 内容：切到屏面自己的局部坐标（u 沿 +gx、v 向下）----
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
  const fs2 = H * 0.155;
  const fs3 = H * 0.115;
  /** 字号小于这个就不写了 —— 远看留一块发光板，凑近才出字 */
  const MIN_PX = 7;
  const showL1 = fs1 * pxPerTile >= 9;
  const showL2 = fs2 * pxPerTile >= MIN_PX;
  const showL3 = fs3 * pxPerTile >= MIN_PX;

  // 顶部状态条
  c.fillStyle = rgba(ph.color, 0.35 + 0.45 * ph.glow);
  c.fillRect(0, 0, W, H * 0.06);

  if (!showL1) {
    // 太小了：只留三条抽象光条（远看就是"屏上有东西在动"）
    for (let k = 0; k < 3; k += 1) {
      const v = H * (0.22 + k * 0.24);
      const ww = inner * (0.35 + ((k * 7 + Math.floor(now / 700)) % 4) * 0.14);
      c.fillStyle = rgba(k === 0 ? ph.color : '#5b6779', k === 0 ? 0.55 : 0.3);
      c.fillRect(padX, v, ww, H * 0.09);
    }
    c.restore();
    return;
  }

  c.textAlign = 'left';
  c.textBaseline = 'top';

  /* 第一层：阶段。待命中时缓慢呼吸，执行中常亮 */
  const blink = ph.busy ? 1 : 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(now / 700));
  c.globalAlpha = blink;
  c.font = `700 ${fs1}px ${FONT}`;
  c.fillStyle = ph.color;
  c.fillText(fit(c, ph.label, inner), padX, H * 0.13);
  c.globalAlpha = 1;

  /* 第二层：具体在做什么。后面跟一个闪烁的光标 */
  if (showL2 && state.action) {
    c.font = `500 ${fs2}px ${FONT}`;
    const t2 = fit(c, state.action, inner - fs2);
    c.fillStyle = '#a8bdd6';
    c.fillText(t2, padX, H * 0.5);
    if (ph.busy && Math.floor(now / 420) % 2 === 0) {
      const w2 = c.measureText(t2).width;
      c.fillStyle = ph.color;
      c.fillRect(padX + w2 + fs2 * 0.28, H * 0.5 + fs2 * 0.16, fs2 * 0.62, fs2 * 0.8);
    }
  }

  /* 第三层：任务上下文，多出来就慢慢往上滚 */
  const lines = Array.isArray(state.context) ? state.context : [];
  if (showL3 && lines.length) {
    const lineH = fs3 * 1.65;
    const topV = H * 0.68;
    const viewH = H * 0.22;
    const total = lines.length * lineH;
    c.save();
    c.beginPath();
    c.rect(padX, topV, inner, viewH);
    c.clip();
    c.font = `400 ${fs3}px ${FONT}`;
    c.fillStyle = '#6d7d92';
    const gap = viewH * 0.6;
    const off = total > viewH ? ((now / 1000) * 0.12) % (total + gap) : 0;
    for (let rep = 0; rep < 2; rep += 1) {
      for (let i = 0; i < lines.length; i += 1) {
        const v = topV + i * lineH + (total + gap) * rep - off;
        if (v > topV - lineH && v < topV + viewH) c.fillText(fit(c, lines[i], inner), padX, v);
      }
    }
    c.restore();
  }

  /* 底部：执行中走一条不确定的进度条 */
  c.fillStyle = 'rgba(255,255,255,0.07)';
  c.fillRect(padX, H * 0.93, inner, H * 0.035);
  if (ph.busy) {
    const segW = inner * 0.3;
    const u = padX + ((now / 1800) % 1) * (inner - segW);
    c.fillStyle = ph.color;
    c.globalAlpha = 0.85;
    c.fillRect(u, H * 0.93, segW, H * 0.035);
    c.globalAlpha = 1;
  }

  // 玻璃反光：一道斜着的高光
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
 * 主 Agent 剪影
 * ------------------------------------------------------------------ */

/**
 * 一个深色的、没有五官的影子：头 + 肩 + 前伸的手臂 + 屈着的腿。
 * 动作在 滑 / 点 / 静观 之间循环（待命时基本只静观 + 呼吸），
 * 手是往控制台那边伸的，不敲键盘 —— 它是在"监控和调度"。
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

  // 动作：待命 = 静观（只有呼吸）；忙起来才滑动 / 点击
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

  // 腿：屈着坐（大腿向前、小腿向下），只露一点点
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

  // 躯干：微微前倾，随呼吸起伏
  c.save();
  c.translate(0, breathe);
  c.beginPath();
  c.moveTo(-14, -30);
  c.quadraticCurveTo(-16, -46, -8, -52);
  c.lineTo(10, -52);
  c.quadraticCurveTo(17, -45, 15, -29);
  c.closePath();
  c.fill();

  // 头（没有五官，就是个圆）
  c.beginPath();
  c.arc(2 + Math.sin(t * 0.8) * 0.7, -60, 9.6, 0, Math.PI * 2);
  c.fill();
  c.restore();

  // 手臂：肩 → 肘 → 手，手往控制台那边伸（屏幕上在右下方）
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
  // 另一只手搭在台沿上，几乎不动
  c.beginPath();
  c.moveTo(-10, -46 + breathe);
  c.lineTo(-16, -38 + breathe);
  c.lineTo(-6, -32 + breathe);
  c.stroke();

  // 轮廓光：屏在右下方，所以亮边压在右侧
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

  // 手上一点光：滑动 / 点击时才亮，像是在屏上操作
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

  c.restore();
}

/* ------------------------------------------------------------------ *
 * 调度光束
 * ------------------------------------------------------------------ */

/**
 * 委托专家时，从控制台射向对应工位的一道地面光 + 一个跑过去的光点 + 落点光环。
 * 用 lighter 叠加，画在所有家具之上 —— 光是"照过去"的，被桌子挡住反而不像光。
 * @param {{x:number,y:number}} from
 * @param {{x:number,y:number}} to
 */
export function drawDispatchBeam(c, from, to, now, color) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const wA = 0.5;
  const wB = 0.16;

  c.save();
  c.globalCompositeOperation = 'lighter';

  const a = project(from.x, from.y, 0.03);
  const b = project(to.x, to.y, 0.03);
  const g = c.createLinearGradient(a.x, a.y, b.x, b.y);
  g.addColorStop(0, rgba(color, 0.3));
  g.addColorStop(0.55, rgba(color, 0.16));
  g.addColorStop(1, rgba(color, 0.05));
  poly(
    c,
    [
      project(from.x + nx * wA, from.y + ny * wA, 0.03),
      project(to.x + nx * wB, to.y + ny * wB, 0.03),
      project(to.x - nx * wB, to.y - ny * wB, 0.03),
      project(from.x - nx * wA, from.y - ny * wA, 0.03),
    ],
    g
  );

  // 沿线跑的光点
  const k = (now / 1500) % 1;
  const q = { x: from.x + dx * k, y: from.y + dy * k };
  const e = groundEllipse(q.x, q.y, 0.34, 0.04);
  const pg = c.createRadialGradient(e.x, e.y, 0, e.x, e.y, e.rx);
  pg.addColorStop(0, rgba(color, 0.55));
  pg.addColorStop(1, rgba(color, 0));
  c.save();
  c.beginPath();
  c.ellipse(e.x, e.y, e.rx, e.ry, e.rot, 0, Math.PI * 2);
  c.fillStyle = pg;
  c.fill();
  c.restore();

  // 落点：工位脚下一圈呼吸的光环
  const r = groundEllipse(to.x, to.y, 0.62 + Math.sin(now / 240) * 0.06, 0.04);
  c.beginPath();
  c.ellipse(r.x, r.y, r.rx, r.ry, r.rot, 0, Math.PI * 2);
  c.strokeStyle = rgba(color, 0.5);
  c.lineWidth = 1.6;
  c.stroke();

  c.restore();
}
