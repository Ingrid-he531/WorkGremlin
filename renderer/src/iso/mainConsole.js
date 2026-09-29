/**
 * mainConsole.js —— 主 Agent（Craft Agent）控制台。
 *
 * 只负责画，不负责状态：阶段、动作、上下文都由外面传进来（现在传的是 mock，
 * 以后换成 hook 事件即可，见 stores/mainAgent.js）。
 *
 * 三样东西：
 *   1. 控制台本体（矮柜 + 台面 + 指示灯）—— 暗色低多边形，跟屋里家具同一套画法
 *   2. 悬浮屏——贴在 gy 恒定的竖直面上，所以等距下是平行四边形，内容正对镜头
 *      只显示相位状态（思考中 / 调用工具 …）：具体 prompt、读写文件、工具细节都不上屏。
 *      远看是一块发光板（只留抽象光条），放大到能看清时才把相位名写出来
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
  /**
   * 未上报：这一层的 CLI 还没接 hook，只有会话文件时间可看 —— 不推断动作，
   * 也不假装它在调工具（以前会显示「调用工具 · 改 xxx.jsonl」，那是拿文件名编造）。
   */
  unreported: { label: '未上报', color: '#6b7c94', glow: 0.18, busy: false },
  plan: { label: '规划中', color: '#7fb0ff', glow: 0.55, busy: true },
  thinking: { label: '思考中', color: '#ffcf5c', glow: 0.6, busy: true },
  tool: { label: '调用工具', color: '#4c8dff', glow: 0.85, busy: true },
  dispatch: { label: '委托专家', color: '#7fb0ff', glow: 1.0, busy: true },
  summarize: { label: '汇总中', color: '#2fbf71', glow: 0.7, busy: true },
  /** 任务完成：屏上写"任务完成"，剪影回到静观；内容第三层显示本次改动概要 */
  done: { label: '任务完成', color: '#2fbf71', glow: 0.5, busy: false },
  /**
   * 任务取消：用户按了 ESC / 停止，这一轮没干完就被掐掉 ——
   * 与 done 的区别只有两个：**红色**（不是"完成"那种绿）+ 屏上 / tooltip 写「任务取消」。
   * 第三层同样是"这一轮的产出"：动过文件就列文件，一个都没动就写「没有输出」
   * （见 IsoOfficeView 里 enterCancelled 那一段）。
   */
  cancelled: { label: '任务取消', color: '#ff5c5c', glow: 0.5, busy: false },
  /** 等待用户授权：屏上写"等待授权"，剪影举起一块牌子（见 drawOperator 的 isAwait 分支） */
  await: { label: '等待授权', color: '#f5a623', glow: 0.6, busy: false },
  /**
   * 等待 subagent 汇报：主会话还没收到 Stop，但活已经派出去了 ——
   * 既不是"待命中"（人还在这轮任务里），也不是自己正在干活，所以单开一个相位：
   * 屏上写"等待中"，并写出在等谁（见 IsoOfficeView 的 consoleLive）。
   */
  waiting: { label: '等待中', color: '#5aa9ff', glow: 0.42, busy: false },
};

export const PHASE_LIST = Object.keys(PHASES);

const FONT = 'ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';

/**
 * 屏上第一层 与 tooltip 第一行**共用的**相位文案（两处口径永远一致）。
 *
 * 一律取 PHASES 的原标签，不按工具名换文案：调用工具就写「调用工具」。
 * 工具名只说明"上一支调的是什么"，不足以说明"正在等授权" —— 命令类工具（Bash / Shell）
 * 以前会被换成「调用工具，需要授权」，既串到「任务完成」这些相位上（tool 字段残留），
 * 也让人以为卡住了。真正的授权信号由 await 相位单独表示，不靠工具名猜。
 * @param {{phase?:string}} state
 */
export function consolePhaseLabel(state) {
  return (PHASES[String((state && state.phase) || 'idle')] || PHASES.idle).label;
}

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
 * @param {{state:{phase:string,action:string,context:string[],tool?:string}, now:number, zoom:number}} o
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
  /** 字号小于这个就不写了 —— 远看留一块发光板，凑近才出字 */
  const showL1 = fs1 * pxPerTile >= 9;

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

  /* 唯一一层内容：相位状态（思考中 / 调用工具 …）。
     只显示状态，不显示具体 prompt、读写文件、调用工具的细节 —— 那些留在 tooltip / 对话记录里。
     文案与 tooltip 第一行走同一个 consolePhaseLabel()（调用工具就写「调用工具」）；
     文案长就自动缩字号，别被 fit 截成省略号。
     待命中缓慢呼吸，执行中常亮。文字按整宽排 —— 不跟闪烁光标（给它预留位置会把文案挤成省略号）。 */
  const blink = ph.busy ? 1 : 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(now / 700));
  const label = consolePhaseLabel(state);
  let lfs = fs1;
  c.font = `700 ${lfs}px ${FONT}`;
  const labelW = c.measureText(label).width;
  if (labelW > inner) {
    lfs = Math.max(fs1 * 0.5, (fs1 * inner) / labelW);
    c.font = `700 ${lfs}px ${FONT}`;
  }
  const labelV = H * 0.38; // 只剩一层：垂直居中偏上（顶部状态条与底部进度条之间）
  const labelText = fit(c, label, inner);
  c.globalAlpha = blink;
  c.fillStyle = ph.color;
  c.fillText(labelText, padX, labelV + (fs1 - lfs) * 0.5);
  c.globalAlpha = 1;

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

  // 手臂：等待授权时举牌（一只手高高举起一块牌子），其余状态沿用 滑/点/静观
  const isAwait = state.phase === 'await';
  if (isAwait) {
    // 举牌的胳膊：手抬到头部高度即可，别举过头顶去挡悬浮屏
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
    // 另一只手搭在台沿上
    c.beginPath();
    c.moveTo(-10, -46 + breathe);
    c.lineTo(-16, -38 + breathe);
    c.lineTo(-6, -32 + breathe);
    c.stroke();
    // 牌子：小一点，举在头部高度（牌底贴手，整体在头顶以下），不挡屏
    const bw = 22;
    const bh = 12;
    const boardCx = hand.x + 1;
    const boardCy = hand.y - bh / 2 - 3;
    // 牌立柱（手 → 牌底）
    c.strokeStyle = '#3a4252';
    c.lineWidth = 2.6;
    c.beginPath();
    c.moveTo(hand.x, hand.y);
    c.lineTo(boardCx, boardCy + bh / 2);
    c.stroke();
    // 牌子淡光晕
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
    // 牌面：小、深灰底
    c.fillStyle = '#414a5a';
    c.fillRect(boardCx - bw / 2, boardCy - bh / 2, bw, bh);
    c.strokeStyle = '#6b7686';
    c.lineWidth = 1.1;
    c.strokeRect(boardCx - bw / 2, boardCy - bh / 2, bw, bh);
    // 牌上用一排两个白色点点示意有字（点4：原三排白点改成一排两个）
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
    // 举牌胳膊的轮廓光
    c.strokeStyle = rim;
    c.lineWidth = 1.4;
    c.beginPath();
    c.moveTo(el.x, el.y);
    c.lineTo(hand.x, hand.y);
    c.stroke();
  } else {
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
  }

  c.restore();
}

