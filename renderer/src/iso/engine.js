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
  roundRectPath,
} from './iso';
import {
  ROOM,
  COLORS,
  WALL,
  DESK_UNITS,
  DIVIDERS,
  MEETING,
  MEETING_SEATS,
  PANTRY,
  PLANTS,
  PLACES,
  NAV_NODES,
  CONSOLE,
  CONSOLE_FRONT,
  route,
} from './officeMap';
import { drawGremlin, drawGhost, drawTag, colorOf, propOf, SPRITE_UNITS } from './sprites';
import { PHASES, drawConsoleDesk, drawConsoleScreen, drawOperator } from './mainConsole';

const STATE_COLOR = {
  online: '#2ecc71',
  busy: '#f5a623',
  idle: '#7f8c9b',
  blocked: '#ff5c5c',
  thinking: '#ffcf5c',
  offline: '#4a5160',
};
/** 工牌级别色（与小怪物脖子上的工牌一致）：user=蓝, project=绿, 其它（演示/普通）=灰 */
const LEVEL_COLOR = { user: '#3b82f6', project: '#22c55e' };
const levelColor = (level) => LEVEL_COLOR[level] || '#7c8aa5';
/** 对外只保留两档状态：忙碌 / 空闲 */
const STATE_LABEL = { busy: '忙碌', idle: '空闲' };
/** 后端的五种（+thinking）状态归并到这两档（busy / blocked / thinking 都算忙） */
const bucketOf = (s) => (s === 'busy' || s === 'blocked' || s === 'thinking' ? 'busy' : 'idle');
/** 忙碌时具体在干的事（只决定走路/钉座位，头顶标签不再显示细节） */
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

/** 小怪物跑到前面后停留 / 对话的时长（秒），之后回工位忙碌 */
const DISPATCH_TALK = 3.6;
/** 收工汇报：小怪物跑到主 agent 面前说出结果摘要的停留时长（秒） */
const REPORT_TALK = 3.4;
/**
 * 入场：小怪物不是凭空出现在工位上，而是一个个从大门进来、走到自己工位坐下。
 * @property {number} ENTER_DELAY 第一批露面前的等待（等画面先亮起来）
 * @property {number} ENTER_STAGGER 相邻两只之间隔多久（毫秒）
 */
const ENTER_DELAY = 400;
const ENTER_STAGGER = 480;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 标识位图缓存：同一文本只渲染一次（标签现在会被放进排序层重画，不能每帧新建 canvas） */
const WALL_TEXT_CACHE = new Map();

/**
 * 把"圆角牌底 + 文字"渲染到离屏画布（水平、高清），供斜贴到墙面。
 * 牌底+文字一起进同一张位图，斜贴后整块都随墙面平行四边形变形，像真挂在墙上。
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
  // 改 width/height 会清空上下文，重取一次
  g = off.getContext('2d');
  g.font = font;
  // 牌底（圆角深色 + 蓝边）
  roundRectPath(g, 0.75, 0.75, w - 1.5, h - 1.5, 10);
  g.fillStyle = 'rgba(18,24,34,0.82)';
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = 'rgba(127,176,255,0.55)';
  g.stroke();
  // 文字：近白、加阴影保证在花背景上清晰
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
  /** 召唤编排状态：{ agentId, start, back, task, ghostId, reply } */
  let dispatch = null;
  /** 召唤时出现的临时小幽灵：显示具体工作任务 */
  let dispatchGhost = null;
  /** 召唤队列：收到召唤 -> 排队走"跑到主 agent 面前领任务"的编排 */
  const summonQueue = [];
  /** 已入过队的召唤幽灵 memberId：避免重复触发 */
  const summonedGhostIds = new Set();
  /** 编排期间先隐藏的召唤幽灵 memberId：等小怪物回到工位再出现在头顶 */
  const pendingGhostIds = new Set();
  /** 待显幽灵"至少看过一次"（用于等待任务名的兜底，避免任务名一直不来时幽灵不出现） */
  const pendingSeenOnce = new Set();
  /** 坐工位小怪物名字 -> { seat, agentId }：把"被召唤的幽灵"对到它的小怪物 */
  let seatByName = {};
  /** 汇报编排：subagent 收工 -> 走到主 agent 面前说出结果摘要 -> 回工位，幽灵随后散掉 */
  let report = null;
  /** 汇报队列：召唤幽灵写了 result（收工）或直接从名单里消失时入队，一只一只汇报 */
  const reportQueue = [];
  /** 汇报期间补画的幽灵：幽灵已从名单里消失、但汇报还没演完时用 */
  let reportGhost = null;
  /** ghostId -> { agentId, name, color, task, result }：幽灵没了也知道是谁、干了什么 */
  const ghostMeta = new Map();
  /** 同一轮召唤只汇报一次（写了 result 汇报过，随后幽灵被回收时不再报第二次） */
  const reportedGhostIds = new Set();
  /** 正被召唤（幽灵还飘着）的小怪物 agentId：这段时间钉在工位上，不许起身溜达 */
  const summonedAgentIds = new Set();

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

  /** 把工位号 / 成员 id 解析成对应的小怪物（坐工位那只） */
  function agentByTarget(id) {
    const direct = agents.find((x) => x.memberId === id);
    if (direct) return direct;
    const u = DESK_UNITS.find((d) => d.id === id);
    if (u) return agents.find((x) => x.home === DESK_UNITS.indexOf(u)) || null;
    return null;
  }

  /** 主 Agent 对小怪物说的任务：从上下文里挑"委托 / 分配"那一行，没有就退回动作 */
  function delegationLine() {
    const lines = Array.isArray(mainAgent.context) ? mainAgent.context : [];
    const hit = lines.find((t) => /委托|分配|交给|让他|让她|去/.test(t));
    return String(hit || lines[0] || mainAgent.action || '新任务');
  }

  /** 入队一次召唤编排（小怪物跑去主 agent 面前领任务）。同一只不重复入队。 */
  function enqueueDispatch(agentId, task, ghostId = null) {
    if (!agentId) return;
    if (dispatch && dispatch.agentId === agentId) return;
    if (summonQueue.some((s) => s.agentId === agentId)) return;
    summonQueue.push({ agentId, task: task || '新任务', ghostId });
  }

  /** 启动队列里的下一段编排（当前空闲时） */
  function pumpDispatch() {
    if (dispatch || !summonQueue.length) return;
    const s = summonQueue.shift();
    const a = agents.find((x) => x.memberId === s.agentId);
    if (!a) return;
    dispatch = {
      agentId: a.memberId,
      start: performance.now(),
      // sent：是否已出发（等它进门 / 等手上动作收尾再发，别在门口就开走）
      sent: false,
      // talkAt：**走到控制台跟前**的时刻，对话从这时才开始计时。
      // 之前按"出发"计时，走得慢的小怪物还没到就被叫回去了 ——
      // 于是"走到主 agent 控制台前"这段根本看不见，气泡也在半路上就消失。
      talkAt: 0,
      back: false,
      task: s.task,
      ghostId: s.ghostId || null,
      reply: '收到',
    };
    dispatchGhost = {
      x: a.seat.x + 0.25,
      y: a.seat.y - 0.15,
      z: 1.7,
      color: a.color,
      phase: Math.random() * 6.28,
      name: a.name,
      task: s.task,
    };
  }

  /** 收尾当前编排：回工位后让"召唤幽灵"出现在头顶，并推进队列 */
  function finishDispatch() {
    if (!dispatch) return;
    const ghostId = dispatch.ghostId;
    dispatch = null;
    dispatchGhost = null;
    if (ghostId) revealGhost(ghostId);
    pumpDispatch();
  }

  /** 小怪物回到工位：显示之前被隐藏的召唤幽灵（飘在它头顶） */
  function revealGhost(ghostId) {
    pendingGhostIds.delete(ghostId);
    if (ghosts.some((g) => g.memberId === ghostId)) return;
    const m = members.find((x) => x.memberId === ghostId);
    if (!m) return;
    const info = m.ghost ? seatByName[m.name] : null;
    ghosts.push(makeGhost(m, ghosts.length, info && info.seat));
  }

  /* ------------------------------ 收工汇报 ------------------------------
   * subagent 干完活：走到主 agent 控制台前说出**结果摘要**（清单里写的 result，
   * 没写就退回"已完成：<任务名>"），说完回工位坐下，这时幽灵才散掉 ——
   * 顺序必须是 汇报 → 空闲 → 幽灵消失，不能"主 agent 一收到 stop 就复位"。
   */

  /** 汇报文案：优先结果摘要，没有就退回"已完成：<任务名>" */
  function reportText(r) {
    const res = String((r && r.result) || '').trim();
    if (res) return res;
    const task = String((r && r.task) || '').trim();
    return task ? `已完成：${task}` : '已完成';
  }

  /** 入队一次收工汇报（同一轮召唤只报一次） */
  function pushReport(ghostId, meta) {
    if (!meta || !meta.agentId) return;
    if (reportQueue.some((r) => r.ghostId === ghostId)) return;
    if (report && report.ghostId === ghostId) return;
    reportQueue.push({ agentId: meta.agentId, ghostId, task: meta.task, result: meta.result });
    // 幽灵已经不在名单里（没写 result 就被 rm 了）：补一只在工位上方，
    // 等这轮汇报演完再散，否则"干活的人先没了、再自己汇报"看着像穿帮。
    if (!reportGhost && !ghosts.some((g) => g.memberId === ghostId)) {
      const a = agents.find((x) => x.memberId === meta.agentId);
      if (a) {
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
    }
    pumpReport();
  }

  function pumpReport() {
    if (report || !reportQueue.length) return;
    const r = reportQueue.shift();
    const a = agents.find((x) => x.memberId === r.agentId);
    if (!a) return;
    report = { ...r, start: performance.now(), sent: false, talkAt: 0, back: false };
  }

  function finishReport() {
    if (!report) return;
    if (reportGhost && reportGhost.id === report.ghostId) reportGhost = null;
    report = null;
    pumpReport();
  }

  /** 这只小怪物此刻是否正被召唤（清单里有它的实例幽灵） */
  const isSummoned = (agentId) => summonedAgentIds.has(agentId);

  /** 主 agent 进入 dispatch 相位（mock / 真实）时，也让对应小怪物走同一套编排 */
  function syncDispatch() {
    // 真召唤不在这里触发：幽灵出现的那一刻（setMembers）就已经把任务交代过一次了，
    // 之后权限放行 / 相位回放再演一遍，就成了"同一个任务被交代两次"。
    if (mainAgent.phase === 'dispatch' && mainAgent.target) {
      const a = agentByTarget(mainAgent.target);
      if (a && !isSummoned(a.memberId)) enqueueDispatch(a.memberId, delegationLine());
    }
    pumpDispatch();
  }

  /* ------------------------------ 成员 ------------------------------ */

  function makeAgent(member, index, spawnAt = 0) {
    const seat = DESK_UNITS[index].seat;
    return {
      memberId: member.memberId,
      name: member.name || member.memberId,
      home: index,
      seat,
      x: seat.x,
      y: seat.y,
      /** 入场时刻（performance.now 毫秒）：到点之前还没进门 —— 不画、不动，到点才出现在门口 */
      spawnAt,
      entering: spawnAt > 0,
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
    };
  }

  function makeGhost(member, i, nearSeat) {
    // 对应坐工位小怪物的"头顶幽灵"：围绕工位上方一小片区域慢慢飘；
    // 其它临时成员飘在通用悬浮区。
    const center = nearSeat ? { x: nearSeat.x, y: nearSeat.y - 0.1, z: 2.15 } : null;
    const a = center || GHOST_SPOTS[i % GHOST_SPOTS.length];
    return {
      memberId: member.memberId,
      name: member.name || member.memberId,
      x: a.x,
      y: a.y,
      z: a.z,
      anchor: a,
      center, // 非空 = 头顶幽灵，围绕它小范围飘荡
      target: null,
      phase: Math.random() * 6.28,
      speed: center ? 0.35 : 0.5 + Math.random() * 0.35,
      hold: performance.now() + 800 + Math.random() * 2000,
      inMeeting: false,
      nearSeat: Boolean(nearSeat),
      color: colorOf(member.memberId),
      level: member.level || null,
    };
  }

  /** Vue 侧调用：members 是 [{memberId, name, state, degraded, ghost, project}] */
  function setMembers(list) {
    members = list || [];
    const seated = members.filter((m) => !m.ghost).slice(0, DESK_UNITS.length);
    const floating = members.filter((m) => !seated.includes(m));

    const seatIds = new Set(seated.map((m) => m.memberId));
    /** 小怪物 memberId -> 工位坐标（脚底） */
    const seatPos = {};
    /** 小怪物名字 -> { seat, agentId }：被召唤的幽灵按名字对到它的小怪物 */
    const byName = {};
    agents = agents.filter((a) => seatIds.has(a.memberId));
    // 新来的小怪物排队入场：按收到顺序错开，一只只从大门走进来
    let enterSlot = 0;
    const nowMs = performance.now();
    seated.forEach((m, i) => {
      let a = agents.find((x) => x.memberId === m.memberId);
      if (!a) {
        a = makeAgent(m, i, nowMs + ENTER_DELAY + enterSlot * ENTER_STAGGER);
        enterSlot += 1;
        agents.push(a);
      }
      a.home = i;
      a.seat = DESK_UNITS[i].seat;
      // 已存在的小怪物也要刷新名字 / 级别：级别是随成员卡异步下发的，
      // 首次建出来时可能还没有（会画成灰牌），后续收到必须更新，否则永远是灰的。
      a.name = m.name || a.name;
      a.level = m.level || null;
      a.taskProgress = Number.isFinite(m.taskProgress) ? m.taskProgress : 0;
      seatPos[m.memberId] = DESK_UNITS[i].seat;
      const nm = m.name || String(m.memberId).split('@')[0];
      if (nm) byName[nm] = { seat: DESK_UNITS[i].seat, agentId: m.memberId };
    });
    seatByName = byName;

    const gIds = new Set(floating.map((m) => m.memberId));
    ghosts = ghosts.filter((g) => gIds.has(g.memberId));
    // 幽灵已消失 -> 从待显 / 已触发集合里清掉，这样下次召唤能重新触发
    for (const id of [...pendingGhostIds]) if (!gIds.has(id)) pendingGhostIds.delete(id);
    for (const id of [...summonedGhostIds]) if (!gIds.has(id)) summonedGhostIds.delete(id);
    for (const id of [...pendingSeenOnce]) if (!gIds.has(id)) pendingSeenOnce.delete(id);

    // 召唤幽灵从名单里消失 = 这次召唤结束。之前没汇报过（清单里没写 result 就被 rm）
    // 的，补一次"回主 agent 面前汇报"，免得它无声无息地没了。
    for (const [id, meta] of [...ghostMeta]) {
      if (gIds.has(id)) continue;
      ghostMeta.delete(id);
      if (!reportedGhostIds.has(id)) pushReport(id, meta);
      reportedGhostIds.delete(id); // 下次再召唤得能再报一次
    }
    if (reportGhost && !gIds.has(reportGhost.id) && !reportQueue.some((r) => r.ghostId === reportGhost.id) && !(report && report.ghostId === reportGhost.id)) {
      reportGhost = null;
    }

    // 当前正在被召唤的小怪物：这段时间钉在工位上（见 canWander）
    summonedAgentIds.clear();
    for (const m of floating) {
      const info = m.ghost ? byName[m.name] : null;
      if (info) summonedAgentIds.add(info.agentId);
    }

    floating.forEach((m, i) => {
      // 幽灵名字若等于某个坐工位小怪物的名字，说明这是"某只小怪物被召唤"的实例幽灵。
      const info = m.ghost ? byName[m.name] : null;
      if (info && !summonedGhostIds.has(m.memberId)) {
        // 收到召唤（含页面刷新时已在跑的）：先隐藏这只幽灵，稍后入队走
        // "跑到主 agent 面前领任务 -> 回工位"的编排。
        summonedGhostIds.add(m.memberId);
        pendingGhostIds.add(m.memberId);
      }
      if (info && pendingGhostIds.has(m.memberId)) {
        // 幽灵先注册、任务名随后才写进成员卡：等任务到位再入队，免得显示成"新任务"。
        const queued = summonQueue.find((s) => s.ghostId === m.memberId);
        const running = !!(dispatch && dispatch.ghostId === m.memberId);
        if (!queued && !running) {
          if (m.task) summonQueue.push({ agentId: info.agentId, task: m.task, ghostId: m.memberId });
          else if (pendingSeenOnce.has(m.memberId)) summonQueue.push({ agentId: info.agentId, task: '执行任务', ghostId: m.memberId });
        } else if (m.task) {
          if (queued) queued.task = m.task;
          else if (running) dispatch.task = m.task;
        }
        pendingSeenOnce.add(m.memberId);
      }
      if (info) {
        // 记住这只召唤幽灵对应谁、在做什么、结果是什么：
        // 幽灵被回收后（名单里没了）还要靠它把汇报演完。
        const prev = ghostMeta.get(m.memberId) || {};
        ghostMeta.set(m.memberId, {
          agentId: info.agentId,
          name: m.name || prev.name || '',
          color: colorOf(m.memberId),
          task: m.task || prev.task || '',
          result: m.result || prev.result || '',
        });
        // 写了 result = 收工：立刻去汇报（幽灵还在，等汇报演完服务端才回收它）
        if (m.result && !reportedGhostIds.has(m.memberId)) {
          reportedGhostIds.add(m.memberId);
          pushReport(m.memberId, ghostMeta.get(m.memberId));
        }
      }
      if (pendingGhostIds.has(m.memberId)) return; // 还没到出现时机
      if (!ghosts.some((g) => g.memberId === m.memberId)) {
        ghosts.push(makeGhost(m, i, info && info.seat));
      }
    });

    pumpDispatch();
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
      // 还没进门：先在门口候着（不画不动），到点才冒出来、沿过道走向自己工位
      if (a.entering) {
        if (now < a.spawnAt) continue;
        a.entering = false;
        if (dispatch && dispatch.agentId === a.memberId) {
          // 刚建出来就被召唤了：别再走一遍入场，直接落座，交给召唤编排
          a.x = a.seat.x;
          a.y = a.seat.y;
        } else {
          a.x = PLACES.door.x;
          // 门洞沿 gy 有 1 格宽，随机错开一点，前后两只不会精确地叠在一条线上
          a.y = PLACES.door.y + (Math.random() - 0.5) * 0.5;
          a.facing = 1;
          a.mode = 'walk'; // 走的过程里得是"站着走"的姿态，到工位才坐下（pendingMode='sit'）
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
          g.hold = now + (g.nearSeat ? 1000 + Math.random() * 2000 : 6000 + Math.random() * 9000);
        } else {
          g.x += (dx / d) * step;
          g.y += (dy / d) * step;
          g.z += (dz / d) * step;
        }
      } else if (now >= g.hold) {
        if (g.nearSeat && g.center) {
          // 头顶幽灵：在整个工位附近随机飘（横向范围更大），别钉死、也别飘去别处
          const rx = 1.4;
          const ry = 0.9;
          const ang = Math.random() * Math.PI * 2;
          const rad = Math.sqrt(Math.random()); // 均匀落在椭圆内
          g.target = {
            x: g.center.x + Math.cos(ang) * rad * rx,
            y: g.center.y + Math.sin(ang) * rad * ry,
            z: g.center.z + (Math.random() - 0.5) * 0.25,
          };
        } else if (!g.inMeeting) {
          const pool = GHOST_SPOTS.filter((p) => p !== g.anchor);
          g.anchor = pool[Math.floor(Math.random() * pool.length)];
          g.target = g.anchor;
        }
      }
    }
  }

  /* ------------------------------ 开会 ------------------------------ */

  function startMeeting(ids) {
    let k = 0;
    agents.forEach((a) => {
      if (!ids.includes(a.memberId) || a.entering) return; // 还没进门的不去开会
      a.inMeeting = true;
      a.dwell = 0;
      goTo(a, MEETING_SEATS[k % MEETING_SEATS.length], 'meet');
      k += 1;
    });
    ghosts.forEach((g) => {
      if (g.nearSeat) return; // 留在小怪物身边，不进会议室
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

  /** 椅子底座：五星脚 + 中柱 + 座板（永远画在坐着的人之前） */
  function drawChairBase(c, x, y) {
    isoCylinder(c, { x, y, z: 0.02, r: 0.26, h: 0.04, color: '#2b3140' });
    isoCylinder(c, { x, y, z: 0.06, r: 0.05, h: 0.34, color: '#39414f' });
    isoBox(c, { x: x - 0.24, y: y - 0.24, z: 0.4, w: 0.48, d: 0.48, h: 0.08, color: COLORS.chair });
  }

  /** 椅背：backAtNorth=true 朝北（背对镜头），false 朝南（挡在人与镜头之间） */
  function drawChairBack(c, x, y, backAtNorth) {
    const by = backAtNorth ? y - 0.3 : y + 0.22;
    isoBox(c, { x: x - 0.22, y: by, z: 0.48, w: 0.44, d: 0.1, h: 0.5, color: COLORS.chair });
  }

  /**
   * 复印机（会议室西北角）：一台落地式一体机。
   *
   * 为什么不能只画一个金属方盒 —— 等距下那跟"文件柜"一模一样。复印机的辨识点全在**分层**上：
   *   1) 正面中段**凹进去一块**（出纸腔的后壁 / 内壁 / 腔底都压暗），腔里伸出一截浅色托盘，
   *      托盘上还搭着两张刚吐出来的白纸 —— "出纸"是打印机最直白的语言；
   *   2) 顶上是一块深色**稿台玻璃**（比机身窄一圈），上面压一块盖板 + 盖板上的进稿槽；
   *      玻璃必须在盖板**之前**画，盖板只压住中间，露出的那道前边就是"扫描台"；
   *   3) 控制面板装在稿台前沿（小蓝屏 + 一颗绿灯 + 两颗灰键）—— 柜门不会有这个；
   *   4) 底柜是两格**纸盒抽屉**（带把手凹槽），通体一整块板就成了柜子；
   *   5) 比例要敦实（矮胖），瘦高就又变回文件柜。
   */
  function drawPrinter(c, pr) {
    const { x, y, w, d } = pr;
    const H = pr.h;
    const xR = x + w;          // 朝 +gx 那面（屏幕右下）
    const yF = y + d;          // 朝 +gy 那面（朝镜头）
    const zBase = H * 0.44;    // 纸盒柜顶
    const zBody = H * 0.76;    // 中段顶 / 稿台底
    const zGlass = H * 0.83;   // 稿台玻璃面
    const zLid = H * 0.9;      // 掀盖顶
    const zAdf = H * 0.94;     // 进稿槽顶

    // ---- 机身：纸盒柜 → 中段（出纸腔所在）→ 稿台 ----
    isoBox(c, { x, y, z: 0, w, d, h: zBase, color: '#333c4b' });
    isoBox(c, { x, y, z: zBase, w, d, h: zBody - zBase, color: COLORS.metal });
    isoBox(c, { x, y, z: zBody, w, d, h: zGlass - zBody, color: '#2f3a4d' });

    // 稿台玻璃（画在盖板之前：盖板待会儿只压住它中间，露出前面那道边）
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

    // ---- 掀盖 + 盖板上的进稿槽 ----
    isoBox(c, { x: x + 0.02, y: y + 0.02, z: zGlass, w: w - 0.04, d: d - 0.04, h: zLid - zGlass, color: '#464f61' });
    isoBox(c, { x: x + 0.14, y: y + 0.06, z: zLid, w: w - 0.28, d: d - 0.12, h: zAdf - zLid, color: '#5b6577' });

    // ---- 出纸腔：正面凹进去一块（凹腔是"一体机"最硬的辨识点）----
    const cz0 = H * 0.46;
    const cz1 = H * 0.65;
    const cx0 = x + 0.08;
    const cx1 = xR - 0.08;
    const cyB = yF - 0.07;   // 腔的后壁（比机身正面往里）
    wallQuad(c, 'y', cyB, cx0, cx1, cz0, cz1, '#141a24');                       // 后壁
    wallQuad(c, 'x', cx0, cyB, yF, cz0, cz1, '#0f141c');                        // 西内壁
    poly(c, [project(cx0, cyB, cz0), project(cx1, cyB, cz0), project(cx1, yF, cz0), project(cx0, yF, cz0)], '#1c2331'); // 腔底

    // 出纸托盘 + 上面两张刚吐出来的纸（探出机身外面）
    isoBox(c, { x: cx0 + 0.02, y: cyB + 0.01, z: cz0, w: cx1 - cx0 - 0.04, d: 0.22, h: 0.025, color: '#a7b2c2' });
    isoBox(c, { x: cx0 + 0.06, y: cyB + 0.02, z: cz0 + 0.026, w: cx1 - cx0 - 0.12, d: 0.18, h: 0.012, color: '#eef2f8' });
    isoBox(c, { x: cx0 + 0.09, y: cyB + 0.05, z: cz0 + 0.039, w: cx1 - cx0 - 0.18, d: 0.15, h: 0.012, color: '#f6f9fc' });

    // ---- 控制面板：装在稿台前沿（小蓝屏 + 一颗绿灯 + 两颗灰键）----
    wallQuad(c, 'y', yF + 0.002, x + 0.1, xR - 0.1, H * 0.67, H * 0.745, '#1b2230', 'rgba(120,150,180,0.3)', 0.8);
    wallQuad(c, 'y', yF + 0.003, x + 0.13, x + 0.13 + w * 0.32, H * 0.685, H * 0.73, '#2f8fd8');
    for (let i = 0; i < 3; i += 1) {
      const bx = x + 0.19 + w * 0.32 + i * 0.09;
      wallQuad(c, 'y', yF + 0.003, bx, bx + 0.06, H * 0.695, H * 0.72, i === 0 ? '#7fe0a0' : '#5a6474');
    }

    // ---- 底柜：两格纸盒抽屉（分格 + 把手凹槽，才不是"一整块板"）----
    [
      [H * 0.05, H * 0.22, H * 0.115],
      [H * 0.25, H * 0.4, H * 0.305],
    ].forEach(([z0, z1, hz]) => {
      wallQuad(c, 'y', yF + 0.002, x + 0.06, xR - 0.06, z0, z1, '#3b4455', 'rgba(18,24,32,0.55)', 0.8);
      wallQuad(c, 'y', yF + 0.003, x + 0.3, xR - 0.3, hz, hz + H * 0.03, '#222a38');
    });

    // ---- 东侧面：散热格栅（三条横线）----
    for (let i = 0; i < 3; i += 1) {
      const gz = H * 0.12 + i * H * 0.045;
      wallQuad(c, 'x', xR + 0.001, y + 0.12, yF - 0.12, gz, gz + H * 0.014, '#2b3341');
    }
  }

  /**
   * 饮水机：机身（正面冷/热两个出水嘴 + 接水盘）+ 倒扣在顶上的 5 加仑水桶。
   *
   * 怎么才"看得出是个水桶"（而不是一根蓝色圆柱）：
   *   1) 侧影按高度做剖面：颈在下（插进机器那截细）→ 外扩 → 直筒 → 收肩 → 顶颈，
   *      再把每一层的"地面圆"投成椭圆，取长轴两端当左右侧影点，连成整个轮廓；
   *   2) 桶身是**半透明**的塑料：能透出后面的墙 / 帘，才像桶而不是一颗蓝球（地球）；
   *      桶里看得见水位：水面画一道椭圆（带亮边），水下面更蓝更沉，上面是空气，两截不同色；
   *   3) 侧面一道竖高光 + 一道暗面 —— 直筒才有圆柱的体积感；
   *   4) 几道环筋 + 底部蓝色颈圈 + 水里几个气泡，塑料桶的细节就齐了。
   */
  function drawCooler(c, pc) {
    const HW = 0.3;           // 机身半宽
    const BH = 0.55;          // 水桶高
    const bodyH = pc.h - BH;  // 机身高度（顶到桶底）
    const faceY = pc.y + HW;  // 朝镜头那面（+gy）

    // ---- 机身 ----
    isoBox(c, { x: pc.x - HW, y: pc.y - HW, z: 0, w: HW * 2, d: HW * 2, h: bodyH, color: COLORS.metal });
    // 正面：内凹的接水区（深色面板，出水嘴和接水盘都在这一块里）
    wallQuad(c, 'y', faceY, pc.x - 0.17, pc.x + 0.17, bodyH * 0.5, bodyH * 0.86, '#2a3340');
    // 冷 / 热两个出水嘴：往 +gy 伸出来一点，蓝 / 红各一个
    isoBox(c, { x: pc.x - 0.13, y: faceY - 0.03, z: bodyH * 0.55, w: 0.08, d: 0.1, h: 0.05, color: '#4aa3f0' });
    isoBox(c, { x: pc.x + 0.05, y: faceY - 0.03, z: bodyH * 0.55, w: 0.08, d: 0.1, h: 0.05, color: '#e0603f' });
    // 接水盘（格栅）：再往下、再往外一点
    isoBox(c, { x: pc.x - 0.15, y: faceY - 0.03, z: bodyH * 0.34, w: 0.3, d: 0.12, h: 0.035, color: '#39445a' });

    // ---- 水桶 ----
    const BZ = bodyH;   // 桶底（= 机器顶面）
    const R = 0.28;     // 桶身最大半径（比机身窄一圈）
    const LEVEL = 0.74; // 水位（占桶高的比例）

    /** 侧影半径：颈 0.13 → 外扩 → 直筒 R → 收肩 → 顶颈 0.10（s = smoothstep，接缝不生硬） */
    const rAt = (t) => {
      const s = (u) => u * u * (3 - 2 * u);
      if (t < 0.3) return 0.13 + (R - 0.13) * s(t / 0.3);
      if (t < 0.62) return R;
      if (t < 0.94) return R + (0.14 - R) * s((t - 0.62) / 0.32);
      return 0.14 + (0.1 - 0.14) * ((t - 0.94) / 0.06);
    };
    /** 某高度那一圈水/塑料投到屏幕上的椭圆 */
    const ell = (t, k = 1) => groundEllipse(pc.x, pc.y, rAt(t) * k, BZ + t * BH);
    /** 椭圆上一点：th = 0 是屏幕最右，π/2 是最下（也就是离镜头最近的一圈） */
    const at = (e, th) => ({
      x: e.x + e.rx * Math.cos(th) * Math.cos(e.rot) - e.ry * Math.sin(th) * Math.sin(e.rot),
      y: e.y + e.rx * Math.cos(th) * Math.sin(e.rot) + e.ry * Math.sin(th) * Math.cos(e.rot),
    });
    /** 轮廓：右侧影自下而上 + 左侧影自上而下 */
    const outline = (t0, t1) => {
      const pts = [];
      const n = 18;
      for (let i = 0; i <= n; i += 1) pts.push(at(ell(t0 + (t1 - t0) * (i / n)), 0));
      for (let i = n; i >= 0; i -= 1) pts.push(at(ell(t0 + (t1 - t0) * (i / n)), Math.PI));
      return pts;
    };
    const yTop = project(pc.x, pc.y, BZ + BH).y;
    const yBot = project(pc.x, pc.y, BZ).y;

    // 桶身（塑料）：半透明，能透出后面的墙 / 帘 —— 实心蓝白看着就是一颗球（"地球"）。
    // 白雾只留一丝（0.05）当塑料内壁的磨砂：铺厚了会把透明度抵消掉，看着跟没改一样。
    poly(c, outline(0, 1), 'rgba(255,255,255,0.05)');
    const gb = c.createLinearGradient(0, yTop, 0, yBot);
    gb.addColorStop(0, 'rgba(230,244,252,0.20)');
    gb.addColorStop(1, 'rgba(183,216,238,0.30)');
    poly(c, outline(0, 1), gb, 'rgba(58,92,120,0.30)', 1);

    // 水：下半截，跟着桶身一起透（更浅、更淡蓝，水底还是更沉一点，但不再糊成实心蓝）
    const gw = c.createLinearGradient(0, project(pc.x, pc.y, BZ + LEVEL * BH).y, 0, yBot);
    gw.addColorStop(0, 'rgba(150,208,240,0.40)');
    gw.addColorStop(1, 'rgba(70,148,196,0.52)');
    poly(c, outline(0, LEVEL), gw);

    // 水面：一道椭圆 + 亮边（桶身透明了，水位线反而更要留住 —— 它是"装了水"的关键线索）
    const se = ell(LEVEL, 0.99);
    c.beginPath();
    c.ellipse(se.x, se.y, se.rx, se.ry, se.rot, 0, Math.PI * 2);
    c.fillStyle = 'rgba(186,226,248,0.42)';
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.45)';
    c.lineWidth = 1;
    c.stroke();

    // 环筋：桶身上那几道塑料箍（桶身透明了就别画太实）
    c.strokeStyle = 'rgba(70,110,145,0.18)';
    [0.34, 0.42, 0.5, 0.58].forEach((t) => {
      const e = ell(t, 0.995);
      c.beginPath();
      c.ellipse(e.x, e.y, e.rx, e.ry, e.rot, 0, Math.PI * 2);
      c.stroke();
    });

    // 竖条带（沿桶身一条高光 / 一条暗面）：直筒才有圆柱感
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
    band(0.42, 0.95, gh);                                          // 高光在右前方（窗在那一侧）
    band(Math.PI - 0.95, Math.PI - 0.42, 'rgba(40,78,110,0.10)');  // 暗面在左前方
    // 透过前壁看到的**后壁**（远侧那半）：一道很淡的竖带，"透"的感觉大半来自它
    band(Math.PI * 1.5 - 0.3, Math.PI * 1.5 + 0.3, 'rgba(140,186,216,0.12)');

    // 颈圈：桶口插进机器那截的蓝色塑料环（最后画，正好压住桶底的颈部）
    isoCylinder(c, { x: pc.x, y: pc.y, z: BZ - 0.03, r: 0.17, h: 0.07, color: '#2f6ea8' });

    // 桶顶小圆盖：也跟着透一点（实心白会把它压成一块"贴片"）
    const te = ell(1);
    c.beginPath();
    c.ellipse(te.x, te.y, te.rx, te.ry, te.rot, 0, Math.PI * 2);
    c.fillStyle = 'rgba(238,246,252,0.55)';
    c.fill();
    c.strokeStyle = 'rgba(120,166,196,0.45)';
    c.lineWidth = 0.8;
    c.stroke();

    // 水里的几个气泡（桶身透亮，气泡就别抢戏）
    [[0.1, -0.06, 0.2], [-0.09, 0.08, 0.36], [0.06, 0.11, 0.5], [-0.05, -0.09, 0.62]].forEach(([dx, dy, t]) => {
      const b = project(pc.x + dx, pc.y + dy, BZ + t * BH);
      c.beginPath();
      c.arc(b.x, b.y, 1.4, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255,255,255,0.4)';
      c.fill();
    });
  }

  /**
   * 杂志架（茶水间北墙东段，见 PANTRY.rack）：三层斜面展示架。
   *
   * 等距下怎么才"看得出是杂志架"，而不是个摆了几本书的小柜子 —— 每条都是为"封面能被看见"：
   *   1) **架体沿 x 展开、封面朝 +gy**：镜头正对着 +gy 这一侧，一排封面彼此不遮挡。
   *      第一版靠着西墙摆（架体沿 y），杂志沿 y 排成一队、后一本盖住前一本，
   *      整排只剩几条 8px 宽的缝 —— 截图里看着像彩色木条，不像杂志封面；
   *   2) **层板朝 +gy 倾斜**（后沿高、前沿低）：封面略微仰起，比平放更像"一张封面立着"；
   *   3) 两端立板夹住层板 + 底下踢脚 + 背后背板：架子才落地，不然层板看着是悬空的。
   *
   * 一条硬规矩：**不能用 Math.random**。静态层每帧重画（见 buildStatics），随机色会闪成迪厅；
   * 高矮 / 宽窄 / 配色一律用 index 取模算（和工位上的键盘、杯子同一种做法）。
   */
  function drawMagRack(c, rk) {
    const X0 = rk.x;
    const X1 = rk.x + rk.w;
    const Y0 = rk.y;
    const Y1 = rk.y + rk.d;
    const zBase = 0.16; // 踢脚顶面：最下层板从这里起
    const zTop = rk.h - 0.1; // 顶层板的上限
    const tiers = Math.max(1, rk.tiers || 3);
    const step = (zTop - zBase) / tiers;
    const lean = rk.lean == null ? 0.12 : rk.lean;
    const T = 0.05; // 层板 / 立板厚度
    const PT = 0.07; // 两端立板厚度
    /** 层板面在某个 gy 处的高度：后沿（Y0，贴墙那侧）高、前沿（Y1）低 */
    const zAt = (zb, gy) => zb + lean * ((Y1 - gy) / rk.d);
    /** 封面配色：偏亮但不荧光（夜里太跳会跟主控制台抢视线） */
    const COVERS = ['#e6ebf2', '#7fb0ff', '#d9744f', '#3fb950', '#f5a623', '#a98cf2', '#51c7c0'];

    isoShadow(c, (X0 + X1) / 2, (Y0 + Y1) / 2 + 0.1, rk.w * 0.46, 0.26);

    // 架体：背板（贴墙）+ 踢脚 + 左端立板 —— 先把架子立起来，再往里塞层板和杂志
    isoBox(c, { x: X0, y: Y0, z: 0, w: rk.w, d: 0.05, h: rk.h, color: COLORS.metalDark });
    isoBox(c, { x: X0, y: Y0, z: 0, w: rk.w, d: rk.d, h: zBase, color: COLORS.metal });
    isoBox(c, { x: X0, y: Y0, z: 0, w: PT, d: rk.d, h: rk.h, color: COLORS.metal });

    for (let i = 0; i < tiers; i += 1) {
      const zb = zBase + i * step + 0.06;
      // ---- 层板：斜面顶 + 前沿立面（等距下层板朝镜头的只有这两面）----
      poly(
        c,
        [
          project(X0, Y0, zAt(zb, Y0) + T),
          project(X1, Y0, zAt(zb, Y0) + T),
          project(X1, Y1, zAt(zb, Y1) + T),
          project(X0, Y1, zAt(zb, Y1) + T),
        ],
        shade(COLORS.wood, 1.06)
      );
      poly(
        c,
        [
          project(X0, Y1, zAt(zb, Y1) + T),
          project(X1, Y1, zAt(zb, Y1) + T),
          project(X1, Y1, zAt(zb, Y1)),
          project(X0, Y1, zAt(zb, Y1)),
        ],
        shade(COLORS.wood, 0.66)
      );

      // ---- 一排杂志：沿 x 并排站、往后靠（顶边更靠 Y0，同时抬高 hj）----
      const n = 5 + (i % 2); // 5~6 本
      const slot = (rk.w - 0.2) / n;
      for (let j = 0; j < n; j += 1) {
        const xA = X0 + 0.1 + j * slot + slot * 0.14;
        const xB = xA + slot * 0.72;
        const hj = 0.2 + 0.035 * ((i * 7 + j * 5) % 3); // 高矮错开
        const yBot = Y1 - 0.09; // 底边靠前沿
        const yTp = Y0 + 0.11; // 顶边往后倒
        const zB = zAt(zb, yBot) + T;
        const zT = zAt(zb, yTp) + T + hj;
        const cover = COVERS[(i * 3 + j * 2) % COVERS.length];
        // 封面：朝 +gy 的那面 —— 镜头正对它，所以整排都看得见（和门楣屏、白板是同一类面）
        poly(
          c,
          [project(xA, yBot, zB), project(xB, yBot, zB), project(xB, yTp, zT), project(xA, yTp, zT)],
          shade(cover, 0.88),
          'rgba(10,13,19,0.5)',
          0.8
        );
      }
    }

    // 右端立板最后画：相机在 +x 方向，它是最靠近镜头的那块，把层板与杂志的端头夹进架子
    isoBox(c, { x: X1 - PT, y: Y0, z: 0, w: PT, d: rk.d, h: rk.h, color: COLORS.metal });
  }

  /**
   * 名牌：钉在隔板正面的一块小牌子，只写成员名字（name 字段，不是 role 职务）。
   * 板面贴在 gy 恒定的竖直平面上 —— 等距下是个"左右竖直、上下沿斜 30°"的平行四边形，
   * 所以文字要用 AX / AZ 当局部基底斜切，不然会浮在板子外面。
   */
  function drawWallPlate(c, { x, y, z, text, accent, maxW = 1.5, maxH = 0.5 }) {
    // 想让字在屏幕上恒为 ~11px → 反算世界字号；但牌子挂在隔板上，
    // 高度必须封顶（maxH，隔断的矮板传 0.38），所以字号再按牌高收一次，远看也不会撑爆隔板。
    const H_MAX = maxH;
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

  /**
   * 百叶帘（半透光）：贴在玻璃迎镜头那一面上的横向叶片。
   * 面取向与 wallQuad 一致：axis='x' 面 gx 固定（a0/a1 是 gy 范围）；axis='y' 面 gy 固定（a0/a1 是 gx 范围）。
   *
   * 观感要点（否则会像"贴上去的白色横条纹"）：
   *   1) 每片叶片用**屏幕竖向渐变**：顶刃受光（细亮边）→ 叶面中灰 → 叶底背光（暗），有立体感，
   *      而不是一整块平色；
   *   2) 整帘再叠一层**上亮下暗**的衰减（越靠上越贴窗光），拉开上下层次；
   *   3) 叶间留缝、缝隙透出玻璃，整层半透明 → 半透光，隔着帘子看得见屋里人影；
   *   4) 顶部轨道 + 两侧拉绳 + 底部底杆，收住边，不再是均匀平铺的条带。
   */
  function drawBlinds(c, o) {
    const { axis, fixed, a0, a1, z0 = 0, z1, base = '#6f849c', alpha = 0.92, pitch = 0.155, slatH = 0.1 } = o;
    const railH = 0.14;
    const baseGap = 0.07;
    const span = a1 - a0;
    const pAt = (a, z) => (axis === 'x' ? project(a, fixed, z) : project(fixed, a, z));

    c.save();
    c.globalAlpha *= alpha;

    // 叶片：自下而上；越靠上越亮（窗光自上方来），上下拉开更大的明暗对比
    for (let z = z0 + baseGap; z + slatH <= z1 - railH + 1e-6; z += pitch) {
      const k = 0.5 + 0.62 * ((z + slatH / 2) / z1);
      const pT = pAt(a0, z + slatH);
      const pB = pAt(a0, z);
      const g = c.createLinearGradient(pT.x, pT.y, pB.x, pB.y);
      g.addColorStop(0, shade(base, k * 1.42)); // 受光的顶刃
      g.addColorStop(0.14, shade(base, k * 1.02));
      g.addColorStop(0.6, shade(base, k * 0.74));
      g.addColorStop(1, shade(base, k * 0.4)); // 背光的叶底
      wallQuad(c, axis, fixed, a0, a1, z, z + slatH, g);
    }

    // 顶部轨道（深色实心）+ 一条高光，压住最上一片
    wallQuad(c, axis, fixed, a0, a1, z1 - railH, z1, '#242d38');
    wallQuad(c, axis, fixed, a0, a1, z1 - railH * 0.36, z1, '#4b586a');
    // 底部底杆
    wallQuad(c, axis, fixed, a0, a1, z0, z0 + baseGap - 0.01, shade(base, 0.7));
    // 两侧拉绳
    [a0 + span * 0.055, a1 - span * 0.075].forEach((a) => {
      wallQuad(c, axis, fixed, a, a + Math.min(0.028, span * 0.02), z0, z1 - railH, 'rgba(14,19,27,0.72)');
    });

    c.restore();
  }

  /**
   * 会议室 / 茶水间 标识：整块（牌底+文字）按墙面平行四边形斜贴，做到"平行墙面"
   * （不是水平悬浮）。AX 斜 30°、AZ 竖直，故文字底边随墙斜、竖笔仍直。
   * 用函数声明（提升）：buildStatics 在构造期就会调用它（茶水间标识要画在百叶帘之后）。
   */
  function drawWallLabel(c, text, gx, gy, gz) {
    const tc = makeWallText(text);
    const W = tc.width;
    const H = tc.height;
    const halfH = 0.34; // 标牌半高（世界单位），需压在墙高内
    const halfW = halfH * (W / H); // 与位图等比，文字不被拉伸
    // 墙面四边形的三個角（gy 恒定）：sD=左上 sC=右上 sA=左下
    const sD = project(gx - halfW, gy, gz + halfH);
    const sC = project(gx + halfW, gy, gz + halfH);
    const sA = project(gx - halfW, gy, gz - halfH);
    // 仿射：把位图(0..W,0..H) 映射到墙面平行四边形（绕墙斜切）
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
   * 金属竖直面（隔板铝框的南面 / 东面）：屏幕竖向渐变。
   * 拉丝铝的读法 —— 顶刃一条受光亮带（镜面高光）→ 快速回落到基调 → 底刃压暗；
   * 等距下 z 轴投成屏幕竖直线，所以渐变色标对所有 gx/gy 都成立。
   * k 给背光面整体降档（东面 ≈ 南面的 0.72，与原先 shade 0.8 / 0.58 的比例一致）。
   */
  function metalFace(c, base, z0, z1, k = 1) {
    const g = c.createLinearGradient(0, project(0, 0, z1).y, 0, project(0, 0, z0).y);
    g.addColorStop(0, shade(base, 1.62 * k)); // 顶刃高光
    g.addColorStop(0.16, shade(base, 1.06 * k));
    g.addColorStop(0.55, shade(base, 0.82 * k)); // 基调（≈ 原南面 0.8）
    g.addColorStop(1, shade(base, 0.5 * k)); // 底刃暗边
    return g;
  }

  /** 金属顶面：沿进深方向的提亮渐变 —— 北沿（远）更亮，像天光擦过框顶 */
  function metalTop(c, base, y, d, z) {
    const pN = project(0, y, z);
    const pS = project(0, y + d, z);
    const g = c.createLinearGradient(pN.x, pN.y, pS.x, pS.y);
    g.addColorStop(0, shade(base, 1.5));
    g.addColorStop(1, shade(base, 1.1));
    return g;
  }

  /** 预生成静态物件列表（每帧参与排序） */
  function buildStatics() {
    /** @type {{depth:number,draw:(c:CanvasRenderingContext2D, now:number)=>void}[]} */
    const items = [];
    const push = (depth, draw) => items.push({ depth, draw });

    /**
     * 一把椅子入队：底座与椅背分开排。
     * 椅背朝北（背对镜头）时整把画在人之前 —— 椅背本就在人身后；
     * 椅背朝南（挡在人与镜头之间，即"椅子朝向窗口"那排）时，椅背必须排在人**之后**：
     * 坐着的人下半身被椅背压住才读作"坐在椅子里"，否则人像站在椅子前面。
     */
    const pushChair = (x, y, backAtNorth) => {
      push(depthOf(x, y) - 0.02, (c) => {
        drawChairBase(c, x, y);
        if (backAtNorth) drawChairBack(c, x, y, true);
      });
      if (!backAtNorth) push(depthOf(x, y + 0.24), (c) => drawChairBack(c, x, y, false));
    };

    /* 工位（一）：隔断（铝合金边框）+ 它上面的两块名牌 —— 6 组面对面双人桌各一道 */
    DIVIDERS.forEach((p) => {
      // 兜底：HMR 期间可能拿到"新 officeMap 的隔断对象 + 旧引擎"或半截数据 ——
      // 那种情况下宁可少画一道隔断，也不要让整个办公室构建失败（白屏）。
      if (!p || !p.northDesk || !p.southDesk) return;
      /**
       * 隔断是 3.2 宽的一整块，但整块只能拿一个 depth（= 中心 x+y）参与排序：
       * 走道上的精灵 depth = x+y，走到板子后半段就会超过板子中心的 depth，
       * 于是被画到板子**前面** —— 看着就是"从板子里穿出来"。
       * 切成 4 段各排各的，遮挡判断就局部化了：板前的排后面、板后的排前面。
       */
      const SEG = 4;
      const segW = p.w / SEG;
      const natSegDepth = (s) => depthOf(p.x + (s + 0.5) * segW, p.y + p.d / 2);
      /**
       * 每段深度夹在**本组两张桌子**之间：
       *   下限 = 北桌（含桌上物）之后 → 隔断在它前面，要压住它；
       *   上限 = 南桌**本身**之前（ds − 0.01）→ 南桌更靠近镜头，要能压住隔断（连桌腿一起）。
       * 上限写大的后果：靠 x 大那几段的自然深度会超过南桌，哪怕 clamp 到 ds + 0.39 也仍在南桌
       * **之后**绘制 —— 隔断东端盖住南桌的东沿与东腿，看着就是"右边看不到前桌腿、
       * 板子突出了桌面、桌面爬到板子上"。所以上限必须严格小于南桌本身的深度。
       */
      const dn = depthOf(p.northDesk.x + p.northDesk.w / 2, p.northDesk.y + p.northDesk.d / 2);
      const ds = depthOf(p.southDesk.x + p.southDesk.w / 2, p.southDesk.y + p.southDesk.d / 2);
      const floor = dn + 0.4 + 0.01;
      const ceil = ds - 0.01;
      const segDepth = (s) => Math.min(ceil, Math.max(floor, natSegDepth(s))) + s * 0.0005; // 段间仍保持左→右的前后序
      /** 名牌落在哪一段上 */
      const segOf = (gx) => Math.max(0, Math.min(SEG - 1, Math.floor((gx - p.x) / segW)));

      // 落地阴影：用自然深度，避免被 clamp 抬高后盖到后方桌子上
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
       * 深色金属边框：与板体**同厚**（FD = 0，不往外探），四条边一样宽。
       * 亮铝色 + 比板厚会把边框读成一副独立于板子的浅色骨架；压暗、同厚之后，
       * 整块隔断读起来是"一块带收边的板"。
       */
      const FR = p.frame || 0.05;
      const FD = 0;
      const ALU = '#5f6a7e';
      /**
       * 板体左右各让出 FR，把这两条让给竖框：
       * 于是竖框**落在板边的那一条上、不压在板面上**（框外沿 = 板的总外沿 = 桌子左右沿）。
       * 之前板体铺满全宽、竖框又后画，等于框整根骑在板面前面 —— 看着就是"板前立了根柱子"，
       * 遮挡关系不对。
       */
      const bodySegW = (p.w - 2 * FR) / SEG;
      for (let s = 0; s < SEG; s += 1) {
        // 段间多画 0.01，压住接缝；多出来的部分被后一段盖住
        push(segDepth(s), (c) => {
          /**
           * 板体：不透明深灰，落地、无底座。
           * 高度是被"突出桌面减半 + 北桌仍可读 + 名牌压得进板面"三个条件夹出来的
           * （推导在 officeMap 的 DIVIDER_H 注释里）：再高北桌会被切剩一条边停在板顶
           * （"桌面爬到隔板上"）；再矮名牌压不进板面。
           */
          isoBox(c, { x: p.x + FR + s * bodySegW, y: p.y, w: bodySegW + 0.01, d: p.d, h: p.h, color: '#2a3241' });
          /**
           * 上横框：跟着段走（整条横框只拿一个深度会排错，被画到桌子前后不对的一侧）。
           * 画在板体之后：顶面与板顶共面、后画的框条压出"收边"；南面在板正面压出顶部那条框；
           * 朝东的端面被下一段板体盖住，接缝不露。
           */
          isoBox(c, {
            x: p.x + FR + s * bodySegW, y: p.y, z: p.h - FR, w: bodySegW + 0.01, d: p.d, h: FR, color: ALU,
            south: metalFace(c, ALU, p.h - FR, p.h, 1),
            east: metalFace(c, ALU, p.h - FR, p.h, 0.72),
            top: metalTop(c, ALU, p.y, p.d, p.h),
          });
          /**
           * 下横框只画正面那一条（wallQuad），不画盒子：
           * 盒子 z 0..FR 整段埋在板体脚下的体积里，顶面物理上就该被板体挡住 ——
           * 画盒子的话顶面那条亮色会浮在板根前面，只能不漏的方式就是根本没有那个面。
           * 正面这条比板面往外探 0.001，避免与板体南面共面打架。
           */
          wallQuad(c, 'y', p.y + p.d + 0.001, p.x + FR + s * bodySegW, p.x + FR + (s + 1) * bodySegW + 0.01, 0, FR, metalFace(c, ALU, 0, FR, 1));
        });
      }
      /**
       * 左竖框：必须排在第 0 段板体**之前**画（同深度入队又靠后 = 画在板体之后，
       * 朝东那条侧面就浮在板面上 —— 之前就是这么坏的）。它贴在板体西端，
       * 朝东的侧面整面埋在板体体积里，后画的板体（顶面 + 南面）会把它正好盖没；
       * 正面那条不与板体重叠（板体从 p.x+FR 起），仍然看得见。
       */
      push(segDepth(0) - 0.0005, (c) => {
        isoBox(c, {
          x: p.x, y: p.y - FD / 2, w: FR, d: p.d + FD, h: p.h, color: ALU,
          south: metalFace(c, ALU, 0, p.h, 1),
          east: metalFace(c, ALU, 0, p.h, 0.72),
          top: metalTop(c, ALU, p.y - FD / 2, p.d + FD, p.h),
        });
      });
      // 右竖框：朝东那面是隔断的外表面（该看见），排在最后一段板体之后，
      // 顺便盖住板体段间接缝多画出来的 0.01。
      push(segDepth(SEG - 1) + 0.0002, (c) => {
        isoBox(c, {
          x: p.x + p.w - FR, y: p.y - FD / 2, w: FR, d: p.d + FD, h: p.h, color: ALU,
          south: metalFace(c, ALU, 0, p.h, 1),
          east: metalFace(c, ALU, 0, p.h, 0.72),
          top: metalTop(c, ALU, p.y - FD / 2, p.d + FD, p.h),
        });
      });

      /**
       * 两块名牌：一张隔断属于哪两个工位（p.seats = [北侧号, 南侧号]），各写各自主人。
       * 两块都挂在隔断**朝镜头那一面** —— 本工程一贯的取舍：看得见优先于物理正确
       * （显示器屏幕也是这么处理的）。横向一西一东、各自留出边框的宽度；
       * 高度：底边 0.77 正好在南侧那张桌子压过来的可见线之上，顶边让开顶部铝框
       * （板 1.21 高、框 0.05 → 牌高压到 0.38，顶到 1.15）。
       */
      p.seats.forEach((seatId, k) => {
        const idx = DESK_UNITS.findIndex((u) => u.id === seatId);
        const owner = idx >= 0 ? agents.find((ag) => ag.home === idx) : null;
        if (!owner) return;
        const px = p.x + (k === 0 ? 0.08 : 1.52);
        push(segDepth(segOf(Math.min(px + 1.35, p.x + p.w))) + 0.002, (c) => {
          drawWallPlate(c, {
            x: px,
            y: p.y + p.d + 0.012,
            z: 0.77,
            text: owner.name,
            accent: levelColor(owner.level),
            maxW: 1.35,
            maxH: 0.38,
          });
        });
      });
    });

    /* 工位（二）：椅子 / 桌子 / 桌上的东西（显示器、键盘、水杯） */
    DESK_UNITS.forEach((u, i) => {
      const deskDepth = depthOf(u.desk.x + u.desk.w / 2, u.desk.y + u.desk.d / 2);

      // 椅子（底座在人之前画；椅背朝镜头那排由 pushChair 排到人之后）。
      // 椅背朝向跟着"面对面"来：face='south'（北侧那排，面朝 +gy）椅背朝北 → true；南侧那排相反 → false
      pushChair(u.chair.x, u.chair.y, u.face === 'south');

      // 桌子
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
        const prog = a && a.taskProgress != null ? a.taskProgress : 0;
        drawScreen(
          c,
          { x: u.monitor.x + 0.12, y: u.monitor.y, z: z + 0.06, w: u.monitor.w - 0.24, d: u.monitor.d, h: u.monitor.h },
          levelColor(a && a.level),
          prog,
          i * 977 + 13
        );
        // 键盘 / 鼠标
        isoBox(c, { x: u.keyboard.x, y: u.keyboard.y, z, w: u.keyboard.w, d: u.keyboard.d, h: 0.03, color: '#2a3240' });
      });
      // 水杯随桌面一起排序（跟显示器/键盘同层 deskDepth+0.4），不要人为抬到悬浮屏之上：
      // 屏后的水杯应被悬浮屏正确遮挡，而不是盖在屏上
      push(deskDepth + 0.4, (c) => {
        isoCylinder(c, { x: u.mug.x, y: u.mug.y, z: u.desk.h, r: u.mug.r, h: u.mug.h, color: '#e6ebf2' });
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

    // 前一半椅子在桌子北侧（椅背朝北），后一半在南侧（椅背朝镜头 → 排到人就座之后）
    MEETING.chairs.forEach((ch, i) => pushChair(ch.x, ch.y, i < 4));

    // 玻璃隔墙（半透明）+ 它迎镜头那一面的半透光百叶帘。
    //
    // 为什么"玻璃面"和"帘子"都必须按面坐标**分段**入队：等距排序键是 gx+gy（一个标量），
    // 而这几片玻璃横跨好几个 tile。整片只取一个中点键（再 +0.6 抬过屋里的人）时，靠它低坐标一侧、
    // 又实际贴在玻璃**前面**的东西（茶水间北墙的饮水机、走到跟前接水的小怪物）会被算成在玻璃后面 ——
    // 于是那层 16% 的半透明玻璃面就压在它们身上，看上去就是"饮水机被玻璃/帘子遮了一块"。
    // 按面坐标切成小段、各段用自己的中点定 depth，前后关系就回到真实的局部顺序：
    //   - 玻璃"后面"（屋里侧）的东西：键总小于对应段 → 先画，被玻璃 / 帘子盖住 ✓
    //   - 玻璃"前面"的东西（饮水机 / 复印机 / 站在饮水机前的小怪物）：键总大于对应段 → 后画 ✓
    // 玻璃面逐段用 wallQuad 画（而不是整块 isoBox、也不是拼多块 isoBox）：相邻段共边不重叠，
    // 既不会露出 isoBox 的端面接缝，也不会把 0.16 的透明度在接缝处叠成一条深线。
    const gh = MEETING.glass.h;
    /** 一面玻璃 +（可选）它迎镜头那面的百叶帘，按面坐标切成若干段分别入队：axis='x' 沿 gy 切，axis='y' 沿 gx 切 */
    const pushGlassFace = ({ axis, fixed, a0, a1, segW, h = gh, blinds = true }) => {
      const n = Math.max(1, Math.ceil((a1 - a0) / segW));
      const w = (a1 - a0) / n;
      for (let i = 0; i < n; i += 1) {
        const s0 = a0 + i * w;
        const s1 = s0 + w;
        const mid = (s0 + s1) / 2;
        const d = depthOf(axis === 'x' ? fixed : mid, axis === 'x' ? mid : fixed);
        push(d, (c) => wallQuad(c, axis, fixed, s0, s1, 0, h, rgba(COLORS.glass, 0.16)));
        if (blinds) push(d + 0.0005, (c) => drawBlinds(c, { axis, fixed, a0: s0, a1: s1, z0: 0, z1: h }));
      }
    };
    // 西面：分两段，中间是门洞（帘子按片挂，门洞处自然留空）；大面是 +gx 面（x = 右沿）
    [MEETING.glass.westA, MEETING.glass.westB].forEach((g) => {
      pushGlassFace({ axis: 'x', fixed: g.x + g.w, a0: g.y, a1: g.y + g.d, segW: 0.8 });
    });
    // 南面：一整条；大面是 +gy 面（y = 前沿）
    const gs = MEETING.glass.south;
    pushGlassFace({ axis: 'y', fixed: gs.y + gs.d, a0: gs.x, a1: gs.x + gs.w, segW: 0.7 });
    // 茶水间标识：贴在这片南面玻璃朝镜头那一面（= 茶水间的北墙）。
    // 帘子分了段、各段 depth 不同，标识必须排在**所有帘段**之后：取这条玻璃最右端的 depth 再抬一点。
    push(depthOf(gs.x + gs.w, gs.y + gs.d) + 0.3, (c) => {
      drawWallLabel(c, '茶水间', PANTRY.x + PANTRY.w / 2, PANTRY.y, 1.7);
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

    PANTRY.chairs.forEach((ch, i) => pushChair(ch.x, ch.y, i < 3));

    /* 杂志架（茶水间北墙东段），见 drawMagRack */
    const rk = PANTRY.rack;
    // 键取"前右侧角"，再抬到"这面墙最东端"之上：北墙（会议室南面玻璃）是分段画的，
    // 玻璃段的键会一路到 depthOf(19.6, 7.25) ≈ 26.85，架子只要比它浅，后画的玻璃就会切掉架子右角。
    // 现在架子摆最东端时天然就够（角键 ≈ 26.97），这句保证的是"以后把 d 收窄也不会破"。
    // 代价：站在它正东侧（x 更大）且更靠镜头的人可能被它压住 —— 那片是茶水间东北角，
    // 走道（PDOOR_IN → COFFEE）在最西侧，实际不会撞上。
    const wallEastDepth = depthOf(MEETING.x + MEETING.w, MEETING.y);
    push(Math.max(depthOf(rk.x + rk.w, rk.y + rk.d), wallEastDepth + 0.1), (c) => drawMagRack(c, rk));

    const pc = PANTRY.cooler;
    // 饮水机贴在茶水间北墙（= 会议室南面玻璃）跟前，属于"玻璃前面"的东西：
    // 它必须排在这条北墙的**所有**玻璃段 / 帘段之后 —— 帘片 alpha 0.92 几乎不透明，
    // 只要有一段排在它后面，就会从屏幕重叠处硬切掉它一块（实测被切的就是这个）。
    // 单纯用 depthOf(pc.x, pc.y)（22.85）不够：分段后靠右那些段的键会高到 23.1~26.5。
    // 上限卡死在"接水站位"（PLACES.coffee, 23.55）之下 —— 站在饮水机前接水的小怪物仍要能盖住它。
    const coolDepth = Math.max(depthOf(pc.x, pc.y), depthOf(PLACES.coffee.x, PLACES.coffee.y) - 0.05);
    push(coolDepth, (c) => drawCooler(c, pc));

    // 茶水间玻璃隔断：只砌西面（门在中间，两片分开挂帘 → 门洞处自然留空）；
    // 北面借会议室的南墙，南面直接贴房间最前面那道玻璃幕墙，不再多砌一道。
    // 帘子与玻璃面一样按面坐标分段（见上面 pushGlassFace 的说明）：整块中点键会把这层 16% 的玻璃
    // 压到贴在茶水间一侧的饮水机上，看上去就是饮水机左边被遮了一块。
    // 这两片帘子不会盖住饮水机：与饮水机在屏幕上重叠的只有靠北的两段（depth 21.87 / 22.50，
    // 都小于饮水机的 coolDepth 23.5，先画 → 被饮水机盖住）；靠南那几段在屏幕左下，根本不重叠。
    // （帘片 alpha 0.92 几乎不透明，所以必须靠 depth 卡住，不能靠透明度兜底。）
    const ph = PANTRY.glass.h;
    const pg = PANTRY.glass;
    [pg.westA, pg.westB].forEach((g) => {
      pushGlassFace({ axis: 'x', fixed: g.x + g.w, a0: g.y, a1: g.y + g.d, segW: 0.8, h: ph });
    });

    /* 复印机（会议室西北角）：一台落地式一体机，见 drawPrinter */
    const pr = MEETING.printer;
    // 西面帘子已按坐标分段（见上），复印机用正常 depth 就能排在对应帘段之后。
    push(depthOf(pr.x + pr.w / 2, pr.y + pr.d / 2), (c) => drawPrinter(c, pr));

    PLANTS.forEach((p) => push(depthOf(p.x, p.y), (c) => drawPlant(c, p)));

    /* 主 Agent 控制台：柜体 → 悬浮屏 → 剪影（depth 由小到大，正好是从里到外的顺序） */
    const cd = CONSOLE.desk;
    push(depthOf(cd.x + cd.w / 2, cd.y + cd.d / 2), (c, now) => drawConsoleDesk(c, now));
    const cs = CONSOLE.screen;
    // 悬浮屏必须盖住它后面（gy 更小）的所有工位内容：工位物品按桌心推深度最高约 22.28，
    // 而 operator（小黑人）在屏前（depth 22.62）。取 operator 深度 -0.1 ≈ 22.52，
    // 既高于工位、又不挡小黑人。
    push(depthOf(CONSOLE.seat.x, CONSOLE.seat.y) - 0.1, (c, now) =>
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
    // 满铺菱形地毯砖：每格一块菱形，深浅两档交替 + 一道砖缝，整间屋子同一种材质
    // （以前是几块颜色不一的大地毯盖在格子上，深浅打架，看着很花）。
    for (let gy = 0; gy < ROOM.d; gy += 1) {
      for (let gx = 0; gx < ROOM.w; gx += 1) {
        isoDiamond(c, {
          x: gx,
          y: gy,
          w: 1,
          d: 1,
          fill: (gx + gy) % 2 ? COLORS.floor : COLORS.floorAlt,
          stroke: COLORS.floorSeam,
          lw: 1,
        });
      }
    }
    // 房间地面边界：四条边就是四道墙脚，围成一个清晰的平行四边形
    isoDiamond(c, {
      x: 0, y: 0, w: ROOM.w, d: ROOM.d,
      fill: null, stroke: COLORS.wallTop, lw: 2.8, alpha: 0.9,
    });
  }

  // 靠近镜头的两面墙（右 gx = ROOM.w、前 gy = ROOM.d）：这个角度看到的是它们的外侧墙面。
  // 做成矮墙 + 玻璃幕墙：既把长方体围合完整（地面四边才是个完整的平行四边形），又不挡住屋里。
  // 矮墙是实心的、玻璃上的框线（上沿 + 竖挺）也是挡在镜头与屋子之间的实体 → 都不画在背景层，
  // 改由 drawNearLowWalls / drawNearGlassFrame 排在所有屋里物件之后（见下面说明）。
  // 只有那层几乎全透的玻璃面留在背景：alpha 只有 0.085~0.1，留在后面不会露出破绽，
  // 反过来若放到最后画，等于给屋里所有东西糊一层蓝膜，反而把画面压灰。
  const NEAR = [
    { axis: 'x', fixed: ROOM.w, a0: 0, a1: ROOM.d, k: 0.72, ga: 0.1 },
    { axis: 'y', fixed: ROOM.d, a0: 0, a1: ROOM.w, k: 0.6, ga: 0.085 },
  ];
  const NEAR_HALF_H = 0.55;
  const NEAR_FRAME = 'rgba(143,182,255,0.3)';
  /* 竖挺落在矮墙上的那截：矮墙是实心的，同样的 alpha 会比在玻璃上更闷一点，
     稍微提一档，上下两截看着才是同一根（不然矮墙顶上会有一道"换色"的横断口）。 */
  const NEAR_MULLION_BASE = 'rgba(152,192,255,0.38)';
  // 玻璃上沿单独一档：它是墙顶那条边的延续，太淡会看着像"边断在角上"
  const NEAR_RAIL = 'rgba(150,186,255,0.5)';
  const NEAR_RAIL_H = 0.11;

  function drawNearLowWalls(c) {
    NEAR.forEach((n) => {
      // 矮墙只画实心墙身：矮墙与玻璃的交界**不画横框** —— 一道横线等于把墙切成上下两截，
      // 竖挺通到底已经把两者扎成一整面墙了，再描一道边反而露出拼接感。
      wallQuad(c, n.axis, n.fixed, n.a0, n.a1, 0, NEAR_HALF_H, shade(COLORS.wall, n.k));
    });
  }

  /**
   * 近处幕墙的框线：玻璃上沿 + 竖挺。
   * 它们和矮墙一样挡在镜头与屋子之间 —— 屋里任何东西（走到跟前的小怪物、贴着这面墙的家具）
   * 只要在屏幕上跟它重叠，就该被它切掉一块。留在背景层的话会被后画的屋里物件盖住，
   * 看起来就是"竖挺断了 / 上沿被吃掉一截"，所以跟矮墙一起排到最后画。
   *
   * 近处两面**不画墙顶**：那是一整圈厚 0.28 的实体顶面，压在玻璃上沿上又重又挡视线
   * （屋里靠前的一切都被它切掉一条）。改由这道上沿收边 —— 后墙/左墙的墙顶在远端收口时
   * 与玻璃面齐平（见 drawWalls），墙顶那条边正好落在这道上沿的延长线上，看上去是一条连续的边。
   *
   * 竖挺（竖条）**从地面 0 一直画到墙顶 h**，中间在矮墙顶（NEAR_HALF_H）不断：
   * 只画在玻璃段的话，矮墙和幕墙就是"两截拼起来的"；一根竖挺通到底，整面墙才是一体的 ——
   * 矮墙是这根竖挺的基座，玻璃是它嵌的芯（交界处也不画横框，见 drawNearLowWalls）。
   */
  function drawNearGlassFrame(c) {
    const h = WALL.h;
    NEAR.forEach((n) => {
      wallQuad(c, n.axis, n.fixed, n.a0, n.a1, h - NEAR_RAIL_H, h, NEAR_RAIL);
      for (let k = Math.ceil(n.a0 + 1); k < n.a1 - 0.5; k += 2) {
        // 矮墙段（一直到地面）：压在实心矮墙上，与玻璃段在 NEAR_HALF_H 处无缝接上
        wallQuad(c, n.axis, n.fixed, k - 0.04, k + 0.04, 0, NEAR_HALF_H, NEAR_MULLION_BASE);
        // 玻璃段
        wallQuad(c, n.axis, n.fixed, k - 0.04, k + 0.04, NEAR_HALF_H, h, NEAR_FRAME);
      }
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

    NEAR.forEach((n) => {
      // 玻璃面（几乎全透，留在背景；框线不在这里画，见 drawNearGlassFrame）
      wallQuad(c, n.axis, n.fixed, n.a0, n.a1, NEAR_HALF_H, h, `rgba(127,176,255,${n.ga})`);
    });

    // 墙顶：只有后（gy=0）、左（gx=0）两面是实心墙才有这道顶面；屋里的一切都在它们前面，
    // 所以留在背景层（放到最后画会糊住站在墙前的角色）。
    // 两端收在与幕墙玻璃面齐平的位置（x 到 ROOM.w、y 到 ROOM.d）：这样墙顶这条边
    // 正好落在玻璃上沿那道线的延长线上，前后是一条连续的边，不会再"接不上"。
    isoDiamond(c, { x: -t, y: -t, w: ROOM.w + t, d: t, z: h, fill: COLORS.wallTop });
    isoDiamond(c, { x: -t, y: -t, w: t, d: ROOM.d + t, z: h, fill: shade(COLORS.wallTop, 0.92) });

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
      /* 地上的月光：不再用有棱有角的四边形（那看起来就是块地毯），
         改成"地板坐标系里的软椭圆"，边缘全透明地化开，才像光洒进来。
         做法：把画笔换成地板自己的两根轴（AX / AY）——在这个局部坐标里画圆，
         等距投影出来就是贴地的斜椭圆；再叠两片（贴墙根的亮核 + 往屋里铺开的淡晕），
         越往屋里越淡越散。 */
      const o = project(cxm, gy, 0);
      const spill = (rx, ry, cy, a) => {
        c.save();
        c.transform(AX.x, AX.y, AY.x, AY.y, o.x, o.y);
        // 只在墙内侧铺（gy >= 0）：不然光会爬到墙面上、把踢脚线照亮一圈
        c.beginPath();
        c.rect(-rx - 1, 0, (rx + 1) * 2, cy + ry + 1);
        c.clip();
        c.translate(0, cy);
        c.scale(rx, ry); // 圆 → 地面上的椭圆
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
      spill(halfW * 1.18, 2.6, 0.95, 0.12);  // 往屋里铺开、边缘化掉的大片淡晕
      spill(halfW * 0.92, 1.15, 0.42, 0.14); // 贴着窗根的亮核
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

    // 会议室标识：贴在实心后墙（gy=0，与白板同面）上方，z 不超墙高 2.8。
    // 茶水间标识不在这里画：它那面墙（= 会议室南面玻璃）挂了百叶帘，
    // 而背景是先画的、帘子在排序层后画，会被压住 → 改到 buildStatics 里排到帘子之后。
    drawWallLabel(c, '会议室', MEETING.x + MEETING.w / 2, 0, 2.4);
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
      level: a.level,
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

  /** 召唤编排推进：出发 -> 走到控制台跟前 -> 对话 -> 回工位，回到工位后收尾 */
  function stepDispatch(now) {
    if (!dispatch) return;
    const a = agents.find((x) => x.memberId === dispatch.agentId);
    if (!a) { finishDispatch(); return; }
    // 还没进门 / 还没落座：等它出现再往控制台走（在门口就开走会瞬移）
    if (!dispatch.sent) {
      if (a.entering) return;
      goTo(a, CONSOLE_FRONT, 'stand');
      dispatch.sent = true;
      return;
    }
    if (!dispatch.back) {
      if (!a.moving && !a.path.length) {
        // 到了控制台跟前才开始对话：走得远的小怪物也能把"走过去"演完整
        if (!dispatch.talkAt) dispatch.talkAt = now;
        else if (now - dispatch.talkAt >= DISPATCH_TALK * 1000) {
          dispatch.back = true;
          goHome(a);
        }
      }
      a.facing = -1; // 面向控制台（更小 gy）
    } else if (!a.moving && !a.path.length && Math.hypot(a.x - a.seat.x, a.y - a.seat.y) < 0.15) {
      // 已回到工位：让召唤幽灵出现在头顶，收尾本次编排
      finishDispatch();
      return;
    }
    if (dispatchGhost) dispatchGhost.phase = (now - t0) / 780;
  }

  /** 收工汇报推进：走到控制台跟前 -> 说出结果摘要 -> 回工位 -> 幽灵散掉 */
  function stepReport(now) {
    if (!report) return;
    const a = agents.find((x) => x.memberId === report.agentId);
    if (!a) { finishReport(); return; }
    if (!report.sent) {
      if (a.entering) return;
      goTo(a, CONSOLE_FRONT, 'stand');
      report.sent = true;
      return;
    }
    if (!report.back) {
      if (!a.moving && !a.path.length) {
        if (!report.talkAt) report.talkAt = now;
        else if (now - report.talkAt >= REPORT_TALK * 1000) {
          report.back = true;
          goHome(a);
        }
      }
      a.facing = -1;
    } else if (!a.moving && !a.path.length && Math.hypot(a.x - a.seat.x, a.y - a.seat.y) < 0.15) {
      finishReport();
      return;
    }
    if (reportGhost) reportGhost.phase = (now - t0) / 780;
  }

  /** 临时小幽灵精灵（自带漂浮 + 状态点）：召唤时 / 汇报期间共用 */
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

  /** 对话气泡（屏幕空间，锚点在脚下，(x,y) 是其上方的落点） */
  function drawBubble(c, x, y, text, alpha, color) {
    c.save();
    c.globalAlpha = alpha;
    c.font = '600 13px ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
    const padX = 12;
    // 结果摘要可能很长：按气泡宽度截断并加省略号，别让文字溢出到框外
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
    // 尾巴指向下方中心
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

  /* ------------------------------ 主循环 ------------------------------ */

  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;

    stepAgents(dt, now);
    stepGhosts(dt, now);
    stepDispatch(now);
    stepReport(now);
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
    for (const a of agents) {
      if (a.entering) continue; // 还没进门
      items.push({ depth: depthOf(a.x, a.y), draw: (c) => drawAgent(c, a) });
    }
    for (const g of ghosts) items.push({ depth: depthOf(g.x, g.y) + 3, draw: (c) => drawGhostSprite(c, g) });
    if (dispatchGhost) items.push({ depth: depthOf(dispatchGhost.x, dispatchGhost.y) + 3, draw: (c) => drawFloatingGhostSprite(c, dispatchGhost) });
    if (reportGhost) items.push({ depth: depthOf(reportGhost.x, reportGhost.y) + 3, draw: (c) => drawFloatingGhostSprite(c, reportGhost) });
    items.sort((p, q) => p.depth - q.depth);
    for (const it of items) it.draw(ctx, now);

    // 近处幕墙：实心矮墙 + 玻璃上的框线，屋里的一切都在它们后面 → 最后画，挡住该挡的
    drawNearLowWalls(ctx);
    drawNearGlassFrame(ctx);

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
      if (a.entering) continue; // 还没进门：不进屏幕坐标表，头顶标签和点选也就一并跟着不出现
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

    // 召唤时的临时小幽灵：名字 + 具体任务
    if (dispatchGhost) {
      const s = toScreen(dispatchGhost.x, dispatchGhost.y, dispatchGhost.z);
      const y = s.y - SPRITE_H * UNIT_Z * cam.zoom * 0.92 - 12;
      const box = drawTag(ctx, {
        x: s.x,
        y,
        text: `${dispatchGhost.name} · ${dispatchGhost.task}`,
        color: STATE_COLOR.busy,
        dashed: true,
      });
      pushHit('__dispatch_ghost', s.x - box.w / 2, y - box.h, s.x + box.w / 2, y);
    }

    // 汇报期间补画的幽灵：名字 + "正在汇报"（结果摘要在气泡里说）
    if (reportGhost) {
      const s = toScreen(reportGhost.x, reportGhost.y, reportGhost.z);
      const y = s.y - SPRITE_H * UNIT_Z * cam.zoom * 0.92 - 12;
      const box = drawTag(ctx, {
        x: s.x,
        y,
        text: `${reportGhost.name} · 汇报中`,
        color: STATE_COLOR.online,
        dashed: true,
      });
      pushHit('__report_ghost', s.x - box.w / 2, y - box.h, s.x + box.w / 2, y);
    }

    // 召唤对话气泡（屏幕空间，压在最上面）：主 agent 交代任务 -> 小怪物答"收到"
    // 计时从**走到控制台跟前**（talkAt）开始，没到之前一个字都别说。
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
        drawBubble(ctx, sp.x, sp.y - SPRITE_H * UNIT_Z * cam.zoom - 6, dispatch.reply || '收到', gremA, a.color);
      }
    }

    // 收工汇报气泡：小怪物站在主 agent 面前说结果摘要
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
   * 只有空闲的、或正在思考的人才会起身走动；写代码 / 写文档时钉在座位上。
   * 被召唤期间（幽灵还飘着 / 正在汇报）一律钉住：它正替主 agent 干活，
   * 头顶写着"忙碌"却在屋里溜达，看着像在摸鱼。
   */
  function canWander(a) {
    if (isSummoned(a.memberId)) return false;
    if (report && report.agentId === a.memberId) return false;
    return bucketOf(stateOf(a.memberId)) !== 'busy' || a.work === 'think';
  }

  /** 头顶只写状态：小怪物（被召唤的专家）只显示"忙碌"，具体在做什么交给小幽灵讲 */
  function tagText(a) {
    if (a.mode === 'meet') return '会议中';
    return bucketOf(stateOf(a.memberId)) === 'busy' ? '忙碌' : '空闲';
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
      syncDispatch();
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
