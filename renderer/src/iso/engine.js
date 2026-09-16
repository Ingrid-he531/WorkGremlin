/**
 * engine.js —— 等距办公室的渲染与行为引擎（纯 Canvas 2D）。
 *
 * 一帧的流程：
 *   1. 背景（地板/地毯/墙/窗）→ 离屏缓存，只在相机变化时重画
 *   2. 把"静态家具"和"角色"混在一起，按 depth = x + y 排序后依次画
 *      —— 所以桌子会自然挡住坐在后面的人的下半身，这就是"2.5D"
 *   3. 头顶标签单独一层画在屏幕空间（不跟着缩放，永远清晰）
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
} from './iso';
import {
  ROOM,
  COLORS,
  WALL,
  DESK_UNITS,
  RUGS,
  MEETING,
  MEETING_SEATS,
  PANTRY,
  PLANTS,
  PLACES,
  NAV_NODES,
  CONSOLE,
  route,
} from './officeMap';
import { drawGremlin, drawGhost, drawTag, colorOf, propOf, SPRITE_UNITS } from './sprites';
import { PHASES, drawConsoleDesk, drawConsoleScreen, drawOperator, drawDispatchBeam } from './mainConsole';

const STATE_COLOR = {
  online: '#2ecc71',
  busy: '#f5a623',
  idle: '#7f8c9b',
  blocked: '#ff5c5c',
  thinking: '#ffcf5c',
  offline: '#4a5160',
};
/** 对外只保留两档状态：忙碌 / 空闲 */
const STATE_LABEL = { busy: '忙碌', idle: '空闲' };
/** 后端的五种（+thinking）状态归并到这两档（busy / blocked / thinking 都算忙） */
const bucketOf = (s) => (s === 'busy' || s === 'blocked' || s === 'thinking' ? 'busy' : 'idle');
/** 忙碌时具体在干的事：只有"思考"允许起身走动 */
const WORK_LABEL = { think: '思考', code: '写代码', doc: '写文档' };
const WORK_KEYS = ['think', 'code', 'doc'];
const hashOf = (s) => {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
};
/** 按 id 固定分配，避免每次刷新乱跳 */
const workOf = (id) => WORK_KEYS[hashOf(id) % WORK_KEYS.length];

/** 身高（tile）：人 ≈ 1.55 个地砖 */
const SPRITE_H = 1.55;
/** 走路速度（tile/秒） */
const SPEED = 2.1;

/** 幽灵的悬浮锚点（世界坐标 + 高度） */
const GHOST_SPOTS = [
  { x: 3.5, y: 1.6, z: 2.05 },
  { x: 8.0, y: 1.5, z: 2.2 },
  { x: 12.2, y: 1.7, z: 1.95 },
  { x: 5.2, y: 5.4, z: 2.15 },
  { x: 10.4, y: 5.4, z: 1.9 },
  { x: 2.2, y: 9.4, z: 2.2 },
];
const GHOST_MEET = { x: 17.0, y: 3.6, z: 2.25 };

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{onSelect?: (id: string) => void}} [opts]
 */
export function createIsoOffice(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const onSelect = opts.onSelect || (() => {});

  let W = 0;
  let H = 0;
  let dpr = 1;
  const cam = { zoom: 1, ox: 0, oy: 0 };

  /** @type {Array<{memberId:string,state:string,degraded:boolean,ghost:boolean,project:string,name:string}>} */
  let members = [];
  /** @type {any[]} */
  let agents = [];
  /** @type {any[]} */
  let ghosts = [];
  let selectedId = '';
  let hoverId = '';
  let showPaths = false;
  let manualMeeting = false;

  let raf = 0;
  let last = 0;
  const t0 = performance.now();

  /** 本帧可点击区域（屏幕坐标，CSS px） */
  let hits = [];
  /** 本帧每个角色的屏幕坐标（脚底，CSS px） */
  const screenPos = new Map();

  const bg = document.createElement('canvas');
  let bgKey = '';

  /* ------------------------------ 相机 ------------------------------ */

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

  /** 让整个房间刚好装满画布 */
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

  /** 世界坐标 → CSS 像素坐标 */
  function toScreen(gx, gy, gz = 0) {
    const p = project(gx, gy, gz);
    return { x: p.x * cam.zoom + cam.ox, y: p.y * cam.zoom + cam.oy };
  }

  /* ------------------------------ 主 Agent 控制台 ------------------------------ */

  /**
   * 主会话（Craft Agent）的状态：{ phase, action, context[], target }。
   * 现在由 stores/mainAgent.js 的 mock 喂，以后换成 hook 事件即可，画法不变。
   */
  let mainAgent = { phase: 'idle', action: '', context: [], target: null };

  /** 调度目标：可以写工位号（A0…B2），也可以写成员 id —— 都换算成脚下的坐标 */
  function targetSeat(id) {
    const u = DESK_UNITS.find((d) => d.id === id);
    if (u) return u.seat;
    const a = agents.find((ag) => ag.memberId === id);
    return a ? { x: a.x, y: a.y } : null;
  }

  /* ------------------------------ 成员 ------------------------------ */

  function makeAgent(member, index) {
    const seat = DESK_UNITS[index].seat;
    return {
      memberId: member.memberId,
      name: member.name || member.memberId,
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
      nextThink: performance.now() + 4000 + Math.random() * 14000,
      phase: Math.random() * 6.28,
      color: colorOf(member.memberId),
      prop: propOf(member.memberId),
      work: workOf(member.memberId),
    };
  }

  function makeGhost(member, i) {
    const a = GHOST_SPOTS[i % GHOST_SPOTS.length];
    return {
      memberId: member.memberId,
      name: member.name || member.memberId,
      x: a.x,
      y: a.y,
      z: a.z,
      anchor: a,
      target: null,
      phase: Math.random() * 6.28,
      speed: 0.5 + Math.random() * 0.35,
      hold: performance.now() + 1500 + Math.random() * 4000,
      inMeeting: false,
      color: colorOf(member.memberId),
    };
  }

  /** Vue 侧调用：members 是 [{memberId, name, state, degraded, ghost, project}] */
  function setMembers(list) {
    members = list || [];
    const seated = members.filter((m) => !m.ghost).slice(0, DESK_UNITS.length);
    const floating = members.filter((m) => !seated.includes(m));

    const seatIds = new Set(seated.map((m) => m.memberId));
    agents = agents.filter((a) => seatIds.has(a.memberId));
    seated.forEach((m, i) => {
      let a = agents.find((x) => x.memberId === m.memberId);
      if (!a) {
        a = makeAgent(m, i);
        agents.push(a);
      }
      a.home = i;
      a.seat = DESK_UNITS[i].seat;
      a.taskProgress = Number.isFinite(m.taskProgress) ? m.taskProgress : 0;
    });

    const gIds = new Set(floating.map((m) => m.memberId));
    ghosts = ghosts.filter((g) => gIds.has(g.memberId));
    floating.forEach((m, i) => {
      if (!ghosts.some((g) => g.memberId === m.memberId)) ghosts.push(makeGhost(m, i));
    });

    maybeMeeting();
  }

  const memberOf = (id) => members.find((m) => m.memberId === id) || null;
  const stateOf = (id) => (memberOf(id) || {}).state || 'offline';
  const degradedOf = (id) => Boolean((memberOf(id) || {}).degraded);

  /* ------------------------------ 移动 ------------------------------ */

  function goTo(a, to, mode, dwellMs = 0) {
    a.path = route({ x: a.x, y: a.y }, to);
    a.pi = 0;
    a.pendingMode = mode;
    a.pendingDwell = dwellMs;
  }

  const goHome = (a) => goTo(a, a.seat, 'sit');

  const WANDER = [
    { x: 6.9, y: 5.4 },
    { x: 13.4, y: 5.4 },
    { x: 6.9, y: 9.4 },
    { x: 0.6, y: 1.5 },
    { x: 13.4, y: 9.4 },
  ];

  function pickActivity(a) {
    const r = Math.random();
    if (r < 0.3) {
      goTo(a, PLACES.coffee, 'coffee', 6000 + Math.random() * 8000);
    } else if (r < 0.5) {
      goTo(a, PLACES.printer, 'print', 4000 + Math.random() * 6000);
    } else if (r < 0.76 && agents.length > 1) {
      const other = agents[(a.home + 1 + Math.floor(Math.random() * 2)) % agents.length];
      if (other && other !== a) {
        // 站到对方工位里（隔板那一侧，别站过道上隔着挡板聊）
        goTo(a, { x: other.seat.x + 0.85, y: other.seat.y }, 'chat', 5000 + Math.random() * 6000);
      }
    } else {
      goTo(a, WANDER[Math.floor(Math.random() * WANDER.length)], 'walk', 3000 + Math.random() * 4000);
    }
  }

  function stepAgents(dt, now) {
    for (const a of agents) {
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

      if (a.mode === 'sit' && !a.path.length && !a.inMeeting && now >= a.nextThink) {
        a.nextThink = now + 8000 + Math.random() * 16000;
        if (Math.random() < 0.6 && canWander(a)) pickActivity(a);
      }
    }
  }

  function stepGhosts(dt, now) {
    for (const g of ghosts) {
      if (g.target) {
        const dx = g.target.x - g.x;
        const dy = g.target.y - g.y;
        const dz = g.target.z - g.z;
        const d = Math.hypot(dx, dy, dz);
        const step = g.speed * dt;
        if (d <= step || d < 0.02) {
          g.x = g.target.x;
          g.y = g.target.y;
          g.z = g.target.z;
          g.target = null;
          g.hold = now + 6000 + Math.random() * 9000;
        } else {
          g.x += (dx / d) * step;
          g.y += (dy / d) * step;
          g.z += (dz / d) * step;
        }
      } else if (!g.inMeeting && now >= g.hold) {
        const pool = GHOST_SPOTS.filter((p) => p !== g.anchor);
        g.anchor = pool[Math.floor(Math.random() * pool.length)];
        g.target = g.anchor;
      }
    }
  }

  /* ------------------------------ 开会 ------------------------------ */

  function startMeeting(ids) {
    let k = 0;
    agents.forEach((a) => {
      if (!ids.includes(a.memberId)) return;
      a.inMeeting = true;
      a.dwell = 0;
      goTo(a, MEETING_SEATS[k % MEETING_SEATS.length], 'meet');
      k += 1;
    });
    ghosts.forEach((g) => {
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

  /* ------------------------------ 静态家具 ------------------------------ */

  /** 显示器屏幕：画在朝镜头那一面（gy = m.y + m.d） */
  function drawScreen(c, m, color, progress, seed) {
    const face = m.y + m.d;
    const z0 = m.z + 0.08;
    const z1 = m.z + m.h - 0.1;
    const x0 = m.x + 0.07;
    const x1 = m.x + m.w - 0.07;
    // 屏幕底
    wallQuad(c, 'y', face, x0, x1, z0, z1, COLORS.screen);
    // 顶部状态条
    wallQuad(c, 'y', face, x0, x1, z1 - 0.1, z1, color);
    // 几行"代码"
    for (let k = 0; k < 3; k += 1) {
      const zz = z1 - 0.24 - k * 0.12;
      const w = 0.22 + ((seed >> (k * 3)) % 5) * 0.11;
      wallQuad(c, 'y', face, x0 + 0.08, Math.min(x1 - 0.08, x0 + 0.08 + w), zz, zz + 0.055, k === 1 ? '#6fa8ff' : '#5b6779');
    }
    // 进度条
    const pz = z0 + 0.1;
    wallQuad(c, 'y', face, x0 + 0.08, x1 - 0.08, pz, pz + 0.05, '#232c3a');
    if (progress > 0) {
      const full = x1 - 0.08 - (x0 + 0.08);
      wallQuad(c, 'y', face, x0 + 0.08, x0 + 0.08 + full * progress, pz, pz + 0.05, '#4c8dff');
    }
  }

  function drawChair(c, x, y, backAtNorth = true) {
    // 五星脚（简化成一个扁圆柱）+ 中柱 + 座板 + 靠背
    isoCylinder(c, { x, y, z: 0.02, r: 0.26, h: 0.04, color: '#2b3140' });
    isoCylinder(c, { x, y, z: 0.06, r: 0.05, h: 0.34, color: '#39414f' });
    isoBox(c, { x: x - 0.24, y: y - 0.24, z: 0.4, w: 0.48, d: 0.48, h: 0.08, color: COLORS.chair });
    const by = backAtNorth ? y - 0.3 : y + 0.22;
    isoBox(c, { x: x - 0.22, y: by, z: 0.48, w: 0.44, d: 0.1, h: 0.5, color: COLORS.chair });
  }

  /**
   * 名牌：钉在隔板正面的一块小牌子，只写成员名字（name 字段，不是 role 职务）。
   * 板面贴在 gy 恒定的竖直平面上 —— 等距下是个"左右竖直、上下沿斜 30°"的平行四边形，
   * 所以文字要用 AX / AZ 当局部基底斜切，不然会浮在板子外面。
   */
  function drawWallPlate(c, { x, y, z, text, accent, maxW = 1.5 }) {
    // 想让字在屏幕上恒为 ~11px → 反算世界字号；但牌子挂在 1.2 高的隔板上，
    // 高度必须封顶（H_MAX），所以字号再按牌高收一次，远看也不会撑爆隔板。
    const H_MAX = 0.5;
    const fsPx = 11 / cam.zoom;
    const wantTile = fsPx / UNIT_Z; // 期望的世界字号（tile）
    c.font = `600 ${fsPx}px ui-sans-serif, system-ui, sans-serif`;
    // 牌宽跟着名字长度走，长名字也不会挤成一团（上限留给隔板上的便利贴）
    const w = Math.max(0.9, Math.min(maxW, c.measureText(text).width / UNIT_Z + 0.3));
    const h = Math.min(H_MAX, Math.max(0.34, wantTile * 2.1));
    const fsTile = Math.min(wantTile, h * 0.5); // 字号跟着牌高收
    const face = y; // 紧贴隔板正面
    const z1 = z + h;

    // 落在隔板上的投影（牌子下方偏右一点，暗示它离板面有一点点距离）
    wallQuad(c, 'y', face - 0.002, x + 0.07, x + w + 0.09, z - 0.07, z1 - 0.06, 'rgba(0,0,0,0.38)');
    // 深色边框（当作牌子的厚度/包边）
    wallQuad(c, 'y', face + 0.006, x - 0.035, x + w + 0.035, z - 0.035, z1 + 0.035, '#1a2130');
    // 牌面
    wallQuad(c, 'y', face + 0.012, x, x + w, z, z1, '#eef2f8', 'rgba(18,24,34,0.35)', 0.8);
    // 左侧状态色条
    wallQuad(c, 'y', face + 0.018, x, x + 0.09, z, z1, accent);

    // 名字：贴着牌面斜切（局部坐标 u 沿牌宽、v 向下）
    const o = project(x, face + 0.018, z1);
    c.save();
    c.transform(AX.x, AX.y, -AZ.x, -AZ.y, o.x, o.y);
    c.font = `600 ${fsTile}px ui-sans-serif, system-ui, sans-serif`;
    c.fillStyle = '#2c3442';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, 0.09 + (w - 0.09) / 2, h / 2);
    c.restore();
  }

  function drawPlant(c, p) {
    isoCylinder(c, { x: p.x, y: p.y, z: 0, r: 0.3, h: 0.36, color: '#b3653f' });
    const t = project(p.x, p.y, 0.36);
    c.save();
    c.translate(t.x, t.y);
    c.scale(p.s, p.s);
    c.fillStyle = COLORS.plant;
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

  /** 预生成静态物件列表（每帧参与排序） */
  function buildStatics() {
    /** @type {{depth:number,draw:(c:CanvasRenderingContext2D, now:number)=>void}[]} */
    const items = [];
    const push = (depth, draw) => items.push({ depth, draw });

    /* 工位 */
    DESK_UNITS.forEach((u, i) => {
      const p = u.partition;
      /**
       * 隔板是 3.2 宽的一整块，但整块只能拿一个 depth（= 中心 x+y）参与排序：
       * 走道上的精灵 depth = x+y，走到板子后半段就会超过板子中心的 depth，
       * 于是被画到板子**前面** —— 看着就是"从板子里穿出来"。
       * 切成 4 段各排各的，遮挡判断就局部化了：板前的排后面、板后的排前面。
       */
      const SEG = 4;
      const segW = p.w / SEG;
      const segDepth = (s) => depthOf(p.x + (s + 0.5) * segW, p.y + p.d / 2);
      /** 名牌落在哪一段上 */
      const segOf = (gx) => Math.max(0, Math.min(SEG - 1, Math.floor((gx - p.x) / segW)));

      // 落地阴影：隔板脚下的暗带，明确"它立在地上"
      push(segDepth(0) - 0.5, (c) => {
        isoDiamond(c, {
          x: p.x - 0.06,
          y: p.y + p.d - 0.06,
          w: p.w + 0.12,
          d: 0.36,
          z: 0.002,
          fill: '#0b0e14',
          alpha: 0.5,
        });
      });

      for (let s = 0; s < SEG; s += 1) {
        // 段间多画 0.01，压住接缝；多出来的部分被后一段盖住
        push(segDepth(s), (c) => {
          isoBox(c, { x: p.x + s * segW, y: p.y, w: segW + 0.01, d: p.d, h: p.h, color: '#2a3241' });
        });
      }

      // 名牌：钉在隔板正面，写成员名字（不是职务）。牌子最宽 1.5，按最右端选段
      push(segDepth(segOf(Math.min(p.x + 0.26 + 1.5, p.x + p.w))) + 0.002, (c) => {
        const owner = agents.find((ag) => ag.home === i);
        if (!owner) return;
        drawWallPlate(c, {
          x: p.x + 0.26,
          y: p.y + p.d + 0.001,
          z: 0.58,
          text: owner.name,
          accent: STATE_COLOR[stateOf(owner.memberId)] || STATE_COLOR.offline,
        });
      });

      // 椅子（在人之前画，人被画在上面）
      push(depthOf(u.chair.x, u.chair.y) - 0.02, (c) => drawChair(c, u.chair.x, u.chair.y, true));

      // 桌子
      const deskDepth = depthOf(u.desk.x + u.desk.w / 2, u.desk.y + u.desk.d / 2);
      push(deskDepth, (c) => {
        const { x, y, w, d, h } = u.desk;
        // 四条腿
        isoBox(c, { x: x + 0.1, y: y + 0.1, z: 0, w: 0.1, d: 0.1, h: h - 0.06, color: '#3a2d21' });
        isoBox(c, { x: x + w - 0.2, y: y + 0.1, z: 0, w: 0.1, d: 0.1, h: h - 0.06, color: '#3a2d21' });
        isoBox(c, { x: x + 0.1, y: y + d - 0.2, z: 0, w: 0.1, d: 0.1, h: h - 0.06, color: '#3a2d21' });
        isoBox(c, { x: x + w - 0.2, y: y + d - 0.2, z: 0, w: 0.1, d: 0.1, h: h - 0.06, color: '#3a2d21' });
        // 桌面
        isoBox(c, { x, y, z: h - 0.08, w, d, h: 0.08, color: COLORS.wood });
      });

      // 桌上的东西（depth 比桌子大一点 → 压在桌面上）
      push(deskDepth + 0.4, (c) => {
        const z = u.desk.h;
        // 显示器
        isoBox(c, { x: u.monitor.x, y: u.monitor.y, z, w: u.monitor.w, d: u.monitor.d, h: 0.06, color: '#202735' });
        const a = agents.find((ag) => ag.home === i);
        const st = a ? stateOf(a.memberId) : 'offline';
        const prog = a && a.taskProgress != null ? a.taskProgress : 0;
        drawScreen(
          c,
          { x: u.monitor.x + 0.12, y: u.monitor.y, z: z + 0.06, w: u.monitor.w - 0.24, d: u.monitor.d, h: u.monitor.h },
          STATE_COLOR[st] || STATE_COLOR.offline,
          prog,
          i * 977 + 13
        );
        // 键盘 / 鼠标 / 杯子
        isoBox(c, { x: u.keyboard.x, y: u.keyboard.y, z, w: u.keyboard.w, d: u.keyboard.d, h: 0.03, color: '#2a3240' });
        isoCylinder(c, { x: u.mug.x, y: u.mug.y, z, r: u.mug.r, h: u.mug.h, color: '#e6ebf2' });
      });

    });

    /* 会议室 */
    const mt = MEETING.table;
    push(depthOf(mt.x + mt.w / 2, mt.y + mt.d / 2), (c) => {
      isoBox(c, { x: mt.x + 0.15, y: mt.y + 0.2, z: 0, w: 0.18, d: 0.18, h: mt.h - 0.08, color: '#3a2d21' });
      isoBox(c, { x: mt.x + mt.w - 0.33, y: mt.y + mt.d - 0.38, z: 0, w: 0.18, d: 0.18, h: mt.h - 0.08, color: '#3a2d21' });
      isoBox(c, { x: mt.x, y: mt.y, z: mt.h - 0.1, w: mt.w, d: mt.d, h: 0.1, color: COLORS.wood });
      // 桌上：一摞纸 + 投影仪
      isoBox(c, { x: mt.x + 1.1, y: mt.y + 0.55, z: mt.h, w: 0.5, d: 0.4, h: 0.04, color: '#e6ebf2' });
      isoBox(c, { x: mt.x + 1.9, y: mt.y + 0.6, z: mt.h, w: 0.42, d: 0.3, h: 0.12, color: '#2b3140' });
    });

    // 前一半椅子在桌子北侧（椅背朝北），后一半在南侧
    MEETING.chairs.forEach((ch, i) => {
      push(depthOf(ch.x, ch.y) - 0.02, (c) => drawChair(c, ch.x, ch.y, i < 4));
    });

    // 玻璃隔墙（半透明，压在会议室里的人之上）
    const gh = MEETING.glass.h;
    // 西面：分两段，中间是门洞
    [MEETING.glass.westA, MEETING.glass.westB].forEach((g) => {
      push(depthOf(g.x, g.y + g.d / 2) + 0.6, (c) => {
        isoBox(c, { ...g, h: gh, color: COLORS.glass, alpha: 0.16 });
      });
    });
    // 南面：一整条
    push(depthOf(MEETING.glass.south.x + MEETING.glass.south.w / 2, MEETING.glass.south.y) + 0.6, (c) => {
      isoBox(c, { ...MEETING.glass.south, h: gh, color: COLORS.glass, alpha: 0.16 });
    });

    /* 茶水间 */
    const pt = PANTRY.table;
    push(depthOf(pt.x + pt.w / 2, pt.y + pt.d / 2), (c) => {
      [[0.12, 0.1], [pt.w - 0.24, 0.1], [0.12, pt.d - 0.22], [pt.w - 0.24, pt.d - 0.22]].forEach(([dx, dy]) => {
        isoBox(c, { x: pt.x + dx, y: pt.y + dy, z: 0, w: 0.12, d: 0.12, h: pt.h - 0.08, color: '#3a2d21' });
      });
      isoBox(c, { x: pt.x, y: pt.y, z: pt.h - 0.08, w: pt.w, d: pt.d, h: 0.08, color: COLORS.wood });
      // 桌上的杯子
      isoCylinder(c, { x: pt.x + 0.5, y: pt.y + 0.42, z: pt.h, r: 0.09, h: 0.16, color: '#e6ebf2' });
      isoCylinder(c, { x: pt.x + 1.45, y: pt.y + 0.6, z: pt.h, r: 0.09, h: 0.16, color: '#e6ebf2' });
    });

    PANTRY.chairs.forEach((ch, i) => {
      push(depthOf(ch.x, ch.y) - 0.02, (c) => drawChair(c, ch.x, ch.y, i < 3));
    });

    const pc = PANTRY.cooler;
    push(depthOf(pc.x, pc.y), (c) => {
      isoBox(c, { x: pc.x - 0.3, y: pc.y - 0.3, z: 0, w: 0.6, d: 0.6, h: pc.h - 0.5, color: COLORS.metal });
      isoCylinder(c, { x: pc.x, y: pc.y, z: pc.h - 0.5, r: 0.28, h: 0.5, color: '#5aa9e6', alpha: 0.85 });
    });

    // 茶水间玻璃隔断：只砌西面（门在中间）；
    // 北面借会议室的南墙，南面直接贴房间最前面那道玻璃幕墙，不再多砌一道
    const ph = PANTRY.glass.h;
    const pg = PANTRY.glass;
    [pg.westA, pg.westB].forEach((g) => {
      push(depthOf(g.x, g.y + g.d / 2) + 0.6, (c) => {
        isoBox(c, { ...g, h: ph, color: COLORS.glass, alpha: 0.16 });
      });
    });

    /* 复印机（会议室东南角） */
    const pr = MEETING.printer;
    push(depthOf(pr.x + pr.w / 2, pr.y + pr.d / 2), (c) => {
      isoBox(c, { ...pr, color: COLORS.metal });
      // 出纸口 + 控制面板
      wallQuad(c, 'y', pr.y + pr.d, pr.x + 0.2, pr.x + pr.w - 0.2, pr.h - 0.4, pr.h - 0.1, '#e6ebf2');
      wallQuad(c, 'y', pr.y + pr.d, pr.x + 0.3, pr.x + pr.w - 0.3, pr.h - 0.36, pr.h - 0.14, '#9aa7b8');
    });

    PLANTS.forEach((p) => push(depthOf(p.x, p.y), (c) => drawPlant(c, p)));

    /* 主 Agent 控制台：柜体 → 悬浮屏 → 剪影（depth 由小到大，正好是从里到外的顺序） */
    const cd = CONSOLE.desk;
    push(depthOf(cd.x + cd.w / 2, cd.y + cd.d / 2), (c, now) => drawConsoleDesk(c, now));
    const cs = CONSOLE.screen;
    push(depthOf(cs.x + cs.w / 2, cs.y) + 0.05, (c, now) =>
      drawConsoleScreen(c, { state: mainAgent, now, zoom: cam.zoom })
    );
    push(depthOf(CONSOLE.seat.x, CONSOLE.seat.y), (c, now) => drawOperator(c, { state: mainAgent, now }));

    return items;
  }

  const statics = buildStatics();

  /* ------------------------------ 背景（缓存） ------------------------------ */

  function drawFloor(c) {
    // 地面是一块纯平的平行四边形：不要给它加板厚，
    // 一旦露出侧面，整个外轮廓就变成六边形，看着就不像平行四边形了。
    for (let gy = 0; gy < ROOM.d; gy += 1) {
      for (let gx = 0; gx < ROOM.w; gx += 1) {
        isoDiamond(c, {
          x: gx,
          y: gy,
          w: 1,
          d: 1,
          fill: (gx + gy) % 2 ? COLORS.floorA : COLORS.floorB,
          stroke: COLORS.floorLine,
          lw: 1.1,
        });
      }
    }
    RUGS.forEach((r) => {
      isoDiamond(c, { x: r.x, y: r.y, w: r.w, d: r.d, fill: r.color, stroke: COLORS.rugEdge, lw: 1.6 });
    });
    // 房间地面边界：四条边就是四道墙脚，围成一个清晰的平行四边形
    isoDiamond(c, {
      x: 0, y: 0, w: ROOM.w, d: ROOM.d,
      fill: null, stroke: COLORS.wallTop, lw: 2.8, alpha: 0.9,
    });
  }

  function drawWalls(c) {
    const t = WALL.thickness;
    const h = WALL.h;

    // 地板先画，墙压在上面
    drawFloor(c);

    // 后墙内表面（gy = 0）：等距下是沿 +gx 方向斜下去的平行四边形
    wallQuad(c, 'y', 0, 0, ROOM.w, 0, h, COLORS.wall);
    // 左墙内表面（gx = 0）：沿 +gy 方向斜下去的另一半
    wallQuad(c, 'x', 0, 0, ROOM.d, 0, h, shade(COLORS.wall, 0.82));

    // 靠近镜头的两面墙（右 gx = ROOM.w、前 gy = ROOM.d）是这个角度看得见的外侧墙面。
    // 做成矮墙 + 玻璃幕墙：既把长方体围合完整（地面四边才是个完整的平行四边形），又不挡住屋里。
    const halfH = 0.55;
    const frame = 'rgba(143,182,255,0.3)';
    const near = [
      { axis: 'x', fixed: ROOM.w, a0: 0, a1: ROOM.d, k: 0.72, ga: 0.1 },
      { axis: 'y', fixed: ROOM.d, a0: 0, a1: ROOM.w, k: 0.6, ga: 0.085 },
    ];
    near.forEach((n) => {
      // 矮墙
      wallQuad(c, n.axis, n.fixed, n.a0, n.a1, 0, halfH, shade(COLORS.wall, n.k));
      // 玻璃
      wallQuad(c, n.axis, n.fixed, n.a0, n.a1, halfH, h, `rgba(127,176,255,${n.ga})`);
      // 玻璃上下沿 + 竖挺
      wallQuad(c, n.axis, n.fixed, n.a0, n.a1, h - 0.07, h, frame);
      wallQuad(c, n.axis, n.fixed, n.a0, n.a1, halfH, halfH + 0.07, frame);
      for (let k = Math.ceil(n.a0 + 1); k < n.a1 - 0.5; k += 2) {
        wallQuad(c, n.axis, n.fixed, k - 0.04, k + 0.04, halfH, h, frame);
      }
    });

    // 墙顶：绕一整圈，盒子才是完整的
    isoDiamond(c, { x: -t, y: -t, w: ROOM.w + t * 2, d: t, z: h, fill: COLORS.wallTop });
    isoDiamond(c, { x: -t, y: -t, w: t, d: ROOM.d + t, z: h, fill: shade(COLORS.wallTop, 0.92) });
    isoDiamond(c, { x: ROOM.w, y: -t, w: t, d: ROOM.d + t, z: h, fill: shade(COLORS.wallTop, 0.8) });
    isoDiamond(c, { x: -t, y: ROOM.d, w: ROOM.w + t * 2, d: t, z: h, fill: shade(COLORS.wallTop, 0.7) });

    // 踢脚线
    wallQuad(c, 'y', 0, 0, ROOM.w, 0, 0.12, shade(COLORS.wall, 0.75));
    wallQuad(c, 'x', 0, 0, ROOM.d, 0, 0.12, shade(COLORS.wall, 0.66));

    // 窗（夜景）：外框 + 玻璃 + 窗台，外加漏进屋里的月光
    WALL.windows.forEach((w, wi) => {
      const gy = 0;
      const cxm = (w.x0 + w.x1) / 2;
      const czm = (w.z0 + w.z1) / 2;
      const FW = 0.11;  // 窗框宽
      const SD = 0.18;  // 窗台伸出墙面的深度
      const frame = '#3d4859';
      const frameLit = shade(frame, 1.4);   // 上沿受天光
      const frameDim = shade(frame, 0.6);   // 下沿背光

      /* 透光：先在墙面上晕一圈冷光，再往地上铺一片月光。都用 lighter 叠加，
         才像"光"加在墙/地上，而不是一块灰补丁。 */
      c.save();
      c.globalCompositeOperation = 'lighter';
      // 墙上的光晕：拿墙自己的两根轴（gx、gz）当局部基底，圆才不会画成屏幕上正圆
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
      // 地上的光斑：从墙根往屋里渐隐（略微外扩，像光是斜着进来的）
      const fL = 2;
      const gA = project(cxm, gy + 0.1, 0);
      const gB = project(cxm, gy + fL, 0);
      const fg = c.createLinearGradient(gA.x, gA.y, gB.x, gB.y);
      fg.addColorStop(0, 'rgba(126,168,255,0.20)');
      fg.addColorStop(1, 'rgba(126,168,255,0)');
      poly(c, [
        project(w.x0 - 0.1, gy + 0.1, 0),
        project(w.x1 + 0.1, gy + 0.1, 0),
        project(w.x1 + 0.35, gy + fL, 0),
        project(w.x0 - 0.35, gy + fL, 0),
      ], fg);
      c.restore();

      // 墙上的洞口：比玻璃大一圈的暗边，就是墙体厚度
      wallQuad(c, 'y', gy, w.x0 - FW, w.x1 + FW, w.z0 - FW, w.z1 + FW, '#1a1f28');
      // 外框：上沿亮、下沿暗，一眼能看出是"框"而不是一块黑
      wallQuad(c, 'y', gy, w.x0 - FW, w.x1 + FW, w.z1, w.z1 + FW, frameLit);
      wallQuad(c, 'y', gy, w.x0 - FW, w.x1 + FW, w.z0 - FW, w.z0, frameDim);
      wallQuad(c, 'y', gy, w.x0 - FW, w.x0, w.z0, w.z1, frame);
      wallQuad(c, 'y', gy, w.x1, w.x1 + FW, w.z0, w.z1, frameDim);

      // 玻璃：夜空渐变，上亮下暗
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

      // 月亮：右上角一团冷光
      const moon = project(w.x1 - 0.6, gy, w.z1 - 0.45);
      const mg = c.createRadialGradient(moon.x, moon.y, 0, moon.x, moon.y, 14);
      mg.addColorStop(0, 'rgba(226,238,255,0.95)');
      mg.addColorStop(0.3, 'rgba(170,205,255,0.4)');
      mg.addColorStop(1, 'rgba(120,160,255,0)');
      c.beginPath();
      c.arc(moon.x, moon.y, 14, 0, Math.PI * 2);
      c.fillStyle = mg;
      c.fill();

      // 星星：每扇窗排布不同（用窗口序号当种子的确定性伪随机）
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

      // 窗棂：十字一根竖一根横，用比玻璃亮一档的框色才看得见
      const mull = shade(frame, 1.25);
      wallQuad(c, 'y', gy, cxm - 0.035, cxm + 0.035, w.z0, w.z1, mull);
      wallQuad(c, 'y', gy, w.x0, w.x1, czm - 0.03, czm + 0.03, mull);
      wallQuad(c, 'y', gy, w.x0, w.x1, czm + 0.03, czm + 0.05, frameLit);

      // 窗台：从墙里伸出来一道窄台面，前沿压一条高光
      const sill = '#394252';
      isoDiamond(c, { x: w.x0 - FW, y: gy, w: w.x1 - w.x0 + FW * 2, d: SD, z: w.z0 - FW, fill: sill });
      isoDiamond(c, {
        x: w.x0 - FW, y: gy + SD - 0.05, w: w.x1 - w.x0 + FW * 2, d: 0.05, z: w.z0 - FW, fill: shade(sill, 1.3),
      });
    });

    // 大门（左墙 gx = 0，挂在挂钟左侧。墙换了一面 → 用 'x' 面，a 轴变成 gy）
    const d = WALL.door;
    wallQuad(c, 'x', 0, d.y0, d.y1, d.z0, d.z1, '#2f3745');
    wallQuad(c, 'x', 0, d.y0 + 0.06, d.y1 - 0.06, d.z0 + 0.06, d.z1 - 0.06, '#1a1f28');
    // 门把手：装在靠钟那一侧的门边
    const knob = project(0, d.y0 + 0.18, 1.0);
    c.beginPath();
    c.arc(knob.x, knob.y, 2, 0, Math.PI * 2);
    c.fillStyle = '#9aa7b8';
    c.fill();
    // 会议室白板（贴在后墙内侧）
    const wb = MEETING.whiteboard;
    wallQuad(c, 'y', 0, wb.x0 - 0.06, wb.x1 + 0.06, wb.z0 - 0.06, wb.z1 + 0.06, '#39414f');
    wallQuad(c, 'y', 0, wb.x0, wb.x1, wb.z0, wb.z1, '#dfe6ef');
    for (let k = 0; k < 3; k += 1) {
      const z = wb.z1 - 0.22 - k * 0.24;
      wallQuad(c, 'y', 0, wb.x0 + 0.2, wb.x1 - 0.5 - k * 0.35, z, z + 0.05, '#7d8ea6');
    }
    wallQuad(c, 'y', 0, wb.x0 + 1.9, wb.x0 + 2.5, wb.z0 + 0.16, wb.z1 - 0.16, 'rgba(76,141,255,0.18)');

    // 会议室标识
    const label = project(MEETING.x + MEETING.w / 2, MEETING.y + MEETING.d + 0.35, 2.45);
    c.save();
    c.fillStyle = '#8fa3bf';
    c.font = '12px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('会议室', label.x, label.y);
    c.restore();

    // 茶水间标识
    // 南面就是玻璃幕墙，标识退回屋里一点，免得被幕墙压住
    const plabel = project(PANTRY.x + PANTRY.w / 2, PANTRY.y + PANTRY.d - 0.35, 2.45);
    c.save();
    c.fillStyle = '#8fa3bf';
    c.font = '12px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('茶水间', plabel.x, plabel.y);
    c.restore();
  }

  /**
   * 左墙挂钟（gx = 0 那面墙；大门也开在这面墙上，在钟的左侧 gy 更大的那头）。
   * 秒针会动，所以每帧现画 —— 画进缓存的背景里就永远停在开局那一秒了。
   * 墙面在等距下是斜的，跟名牌一样用墙面自己的两根轴当局部基底斜切。
   * 挂得够高（cz > 1.4）屋里家具就盖不到它：等距下家具能挡住的墙高 = 物高 − 物到墙的距离。
   */
  function drawClock(c) {
    const cy = 6.6;
    const cz = 2.15;
    const r = 0.45;
    /** 局部坐标里 1 个屏幕像素有多长（单位 tile）—— 线宽才不会随缩放变粗 */
    const px = 1 / (UNIT_Z * cam.zoom);
    const d = new Date();
    const turn = (v, unit) => ((v % unit) / unit) * Math.PI * 2;

    const o = project(0, cy, cz);
    c.save();
    // 局部坐标：u 沿 -gy（站在这面墙前的"右手边"）、v 向下，单位 tile，圆心在 (0,0)。
    // 注意不能沿 +gy：那会让整块表盘镜像（3 点跑到左边、秒针倒着转）。
    // 后墙用的是 +gx = AX，是因为后墙的右手边恰好就是 +gx，不是"沿墙那根轴"都能照抄。
    c.transform(-AY.x, -AY.y, -AZ.x, -AZ.y, o.x, o.y);
    /** 从 (tail) 到 (len) 画一根针，角度 a：0 = 12 点，顺时针 */
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

    // 落在墙上的影子（往右下偏一点，钟才有厚度）
    c.beginPath();
    c.arc(2 * px, 3 * px, r + 1 * px, 0, Math.PI * 2);
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fill();
    // 表框
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fillStyle = '#12161d';
    c.fill();
    // 表盘
    c.beginPath();
    c.arc(0, 0, r - 3 * px, 0, Math.PI * 2);
    c.fillStyle = '#e8edf5';
    c.fill();
    c.strokeStyle = '#9aa7b8';
    c.lineWidth = 1 * px;
    c.stroke();
    // 12 个刻度，3/6/9/12 画长一点
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
    // 时针 / 分针 / 秒针：秒针连续走，带一截尾巴
    const sec = d.getSeconds() + d.getMilliseconds() / 1000;
    const min = d.getMinutes() + sec / 60;
    const hour = (d.getHours() % 12) + min / 60;
    hand(turn(hour, 12), r * 0.5, 3.4, '#2c3442');
    hand(turn(min, 60), r * 0.72, 2.4, '#2c3442');
    hand(turn(sec, 60), r * 0.78, 1.3, '#e0574f', -r * 0.2);
    // 中心轴
    c.beginPath();
    c.arc(0, 0, 2.6 * px, 0, Math.PI * 2);
    c.fillStyle = '#2c3442';
    c.fill();
    c.restore();
  }

  /**
   * 背景（地板 + 地毯 + 墙 + 窗）画到离屏位图上。
   * 位图只跟 zoom 有关，跟相机平移无关 —— 所以拖动场景时不用重画。
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
    // 世界包围盒左上角对齐到位图的 (PAD, PAD)
    bgAt.x = PAD - b.x0 * cam.zoom;
    bgAt.y = PAD - b.y0 * cam.zoom;
    c.translate(bgAt.x, bgAt.y);
    c.scale(cam.zoom, cam.zoom);
    drawWalls(c);
  }

  /* ------------------------------ 角色绘制 ------------------------------ */

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
      state: st,
      facing: a.facing,
      walking: a.moving,
      phase: a.phase,
      sitting: a.mode === 'sit' || a.mode === 'meet',
      degraded: degradedOf(a.memberId),
    });
  }

  function drawGhostSprite(c, g) {
    const st = stateOf(g.memberId);
    const p = project(g.x, g.y, g.z);
    // 悬空：地面留一点虚影
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

  /* ------------------------------ 主循环 ------------------------------ */

  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;

    stepAgents(dt, now);
    stepGhosts(dt, now);
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

    // 左墙挂钟：贴在 gx=0 那面墙上，挂得够高，屋里的家具都盖不到，所以先画
    drawClock(ctx);

    // 排序：家具 + 角色混在一起，depth 大的后画（挡住前面的）
    const items = statics.slice();
    for (const a of agents) items.push({ depth: depthOf(a.x, a.y), draw: (c) => drawAgent(c, a) });
    for (const g of ghosts) items.push({ depth: depthOf(g.x, g.y) + 3, draw: (c) => drawGhostSprite(c, g) });
    items.sort((p, q) => p.depth - q.depth);
    for (const it of items) it.draw(ctx, now);

    // 委托专家：一道光从控制台射向那个工位。光是"照过去"的，所以压在家具之上。
    if (mainAgent.phase === 'dispatch' && mainAgent.target) {
      const seat = targetSeat(mainAgent.target);
      if (seat) drawDispatchBeam(ctx, CONSOLE.beam, seat, now, PHASES.dispatch.color);
    }

    // 路网调试
    if (showPaths) {
      for (const n of NAV_NODES) {
        const p = project(n.x, n.y, 0.02);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3 / cam.zoom, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(76,141,255,0.75)';
        ctx.fill();
      }
    }

    // ---- 头顶标签：屏幕空间，不随缩放变形 ----
    hits = [];
    screenPos.clear();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const a of agents) {
      const s = toScreen(a.x, a.y, 0);
      screenPos.set(a.memberId, s);
      const h = SPRITE_H * UNIT_Z * cam.zoom;
      pushHit(a.memberId, s.x, s.y - h - 16, s.x, s.y + 6);
    }
    for (const g of ghosts) {
      const s = toScreen(g.x, g.y, g.z);
      screenPos.set(g.memberId, s);
      const h = SPRITE_H * UNIT_Z * cam.zoom * 0.92;
      pushHit(g.memberId, s.x, s.y - h - 16, s.x, s.y + 6);
    }

    // 标签（角色在上、家具在下，所以后画）
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
  }

  function pushHit(id, x0, y0, x1, y1) {
    hits.push({ id, x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
  }

  /** 忙碌的就显示具体在做什么，其余一律是空闲 */
  function workText(a) {
    return bucketOf(stateOf(a.memberId)) === 'busy' ? WORK_LABEL[a.work] : '空闲';
  }

  /** 只有空闲的、或正在思考的人才会起身走动；写代码 / 写文档时钉在座位上 */
  function canWander(a) {
    return bucketOf(stateOf(a.memberId)) !== 'busy' || a.work === 'think';
  }

  /** 头顶只写状态：去茶水间、去文印这类去向都不再标注 */
  function tagText(a) {
    if (a.mode === 'meet') return '会议中';
    return workText(a) + (degradedOf(a.memberId) ? '?' : '');
  }

  /**
   * 幽灵头顶：临时成员（subagent）的名字 + 它所属的项目。
   * 名字优先于"临时"这个泛称 —— 这样才能对上"是哪个 subagent 在跑"。
   */
  function ghostTagText(g) {
    if (g.inMeeting) return '旁听会议';
    const m = memberOf(g.memberId);
    const name = (m && m.name) || g.name || '';
    const proj = m && m.project;
    const tail = proj || STATE_LABEL[bucketOf(stateOf(g.memberId))];
    return name ? `${name} · ${tail}` : `临时 · ${tail}`;
  }

  /* ------------------------------ 交互 ------------------------------ */

  function hitAt(px, py) {
    for (let i = hits.length - 1; i >= 0; i -= 1) {
      const h = hits[i];
      if (px >= h.x0 && px <= h.x1 && py >= h.y0 && py <= h.y1) return h.id;
    }
    return null;
  }

  /** 射线法判断屏幕坐标是否落在多边形内（CSS px） */
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
   * 主 Agent 悬浮屏的命中检测（与 onMove 的 px/py 同一套 CSS 像素坐标）。
   * 屏是贴在 gy 恒定竖直面上的一块 wallQuad，四个角投影成屏幕四边形后做 point-in-polygon。
   * 比画出来的屏框再外扩一圈 padding，hover 好命中一点。
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
    /** 角色脚底的 CSS 像素坐标（给任务卡定位用） */
    screenOf(id) {
      return screenPos.get(id) || null;
    },
    /** 主 Agent 悬浮屏命中检测（CSS px）：hover 该屏时给 Vue 侧弹 tooltip 用 */
    hitMainConsole(px, py) {
      return hitMainConsole(px, py);
    },
    /** 主 Agent 控制台：{ phase, action, context[], target }（现在由 mock 驱动，以后接 hook 事件） */
    setMainAgent(s) {
      mainAgent = { phase: 'idle', action: '', context: [], target: null, ...(s || {}) };
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

export { STATE_COLOR, STATE_LABEL };
