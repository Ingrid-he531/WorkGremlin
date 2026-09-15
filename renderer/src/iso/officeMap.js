/**
 * officeMap.js —— 等距办公室的"世界数据"。
 *
 * 只描述"东西在哪、有多大、人怎么走"，不含任何绘制代码（绘制在 engine.js）。
 * 坐标是世界坐标（tile），x 向右前、y 向左前，墙高 2.8。
 *
 * 平面（俯视，x 向右、y 向下=靠近镜头）：
 *
 *   y=0    后墙 ┌──────────────────────────┬───────────┐
 *               │ 窗 窗 窗      大门        │  会议室    │
 *   y=1.5       │        后过道             │  白板     │
 *   y=1.95      │  ▮隔板 A0  A1  A2         │  会议桌    │
 *   y=3.0       │   人   人   人            │           │
 *   y=3.4       │  桌子 桌子 桌子           │           │
 *   y=5.4       │        中过道             │           │
 *   y=5.95      │  ▮隔板 B0  B1  B2        └─── 玻璃 ───┘
 *   y=7.0       │   人   人   人
 *   y=7.4       │  桌子 桌子 桌子
 *   y=9.4       │        前过道
 *   y=10.3      │ 茶水台          打印机   饮水机
 *   y=13        └────────────────────────────────────────┘
 */

export const ROOM = { w: 20, d: 13 };

/** 场景配色（暗色夜间办公室） */
export const COLORS = {
  floorA: '#252b36',
  floorB: '#212733',
  floorLine: '#1c222c',
  rug: '#2e3442',
  rugEdge: '#3a4354',
  wall: '#1e232d',
  wallTop: '#2b3341',
  wallSide: '#191d25',
  glass: '#7fb0ff',
  wood: '#6d5540',
  woodDark: '#4c3b2c',
  metal: '#39414f',
  metalDark: '#2b3140',
  screen: '#0a0d13',
  plant: '#3f7f52',
  chair: '#333c4b',
};

export const WALL = {
  h: 2.8,
  thickness: 0.28,
  /** 后墙上的窗（gx 范围 + 高度范围） */
  windows: [
    { x0: 1.2, x1: 4.2, z0: 1.1, z1: 2.2 },
    { x0: 5.2, x1: 8.2, z0: 1.1, z1: 2.2 },
    { x0: 9.2, x1: 12.2, z0: 1.1, z1: 2.2 },
  ],
  /** 大门（后墙上） */
  door: { x0: 12.5, x1: 13.5, z0: 0, z1: 2.05 },
};

/* ------------------------------------------------------------------ *
 * 工位
 * ------------------------------------------------------------------ */

const DESK_W = 3.0;
const DESK_D = 1.25;

/**
 * 一个工位单元：从后往前依次是 隔板 → 人/椅 → 桌子。
 * @param {number} dy 单元顶部 y（隔板所在位置）
 */
function deskUnit(id, x, dy, row) {
  return {
    id,
    row,
    x,
    y: dy,
    /**
     * 隔板（立在地上，挡住走道视线）
     * 往后退 0.45：等距下"高 h 的桌子会遮住身后 h 的地面"（0.74），
     * 隔板如果贴在 dy 上，底边正好压在桌面后沿线上 → 看起来像架在桌上。
     * 退开后中间露出约 0.5 tile 地面，落地感才出来。
     */
    partition: { x: x - 0.1, y: dy - 0.45, w: DESK_W + 0.2, d: 0.14, h: 1.2 },
    /** 椅子 */
    chair: { x: x + 1.0, y: dy + 0.62 },
    /** 人坐的位置（脚底）：等距下偏桌子左侧，避免被右边的显示器糊住 */
    seat: { x: x + 1.0, y: dy + 0.62 },
    /** 桌子 */
    desk: { x, y: dy + 0.95, w: DESK_W, d: DESK_D, h: 0.74 },
    /** 显示器（桌子靠右，人坐左边，屏幕上照旧朝镜头这侧 —— 任务进度才看得见） */
    monitor: { x: x + 1.95, y: dy + 1.15, w: 1.0, d: 0.12, h: 0.62 },
    /** 键盘 / 鼠标 / 杯子 */
    keyboard: { x: x + 0.55, y: dy + 1.45, w: 0.9, d: 0.34 },
    mug: { x: x + 0.3, y: dy + 1.72, r: 0.11, h: 0.2 },
  };
}

/** A 排在上（靠后墙），B 排在下 */
export const DESK_UNITS = [
  ...[1.0, 5.4, 9.8].map((x, i) => deskUnit(`A${i}`, x, 2.4, 'A')),
  ...[1.0, 5.4, 9.8].map((x, i) => deskUnit(`B${i}`, x, 6.4, 'B')),
];

/** 地毯（工位区 + 会议室） */
export const RUGS = [
  { x: 0.6, y: 1.7, w: 13.0, d: 7.3, color: COLORS.rug },
  { x: 14.4, y: 0.4, w: 5.0, d: 4.8, color: '#2a3341' },
  { x: 14.6, y: 5.3, w: 4.8, d: 3.6, color: '#2a3341' },
];

/* ------------------------------------------------------------------ *
 * 会议室（右上角，玻璃房）
 * ------------------------------------------------------------------ */

export const MEETING = {
  x: 14.4,
  y: 0.4,
  w: 5.0,
  d: 4.8,
  /** 玻璃：门开在侧面（西面）中段，南面是一整条 */
  glass: {
    /** 门洞在 y 2.7 ~ 4.1 */
    westA: { x: 14.4, y: 0.4, w: 0.1, d: 2.3 },
    westB: { x: 14.4, y: 4.1, w: 0.1, d: 1.1 },
    south: { x: 14.4, y: 5.2, w: 5.0, d: 0.1 },
    h: 2.3,
  },
  table: { x: 15.7, y: 1.5, w: 3.0, d: 1.4, h: 0.74 },
  /** 6 把椅子：3 把在桌子北侧，3 把在南侧 */
  chairs: [
    { x: 15.9, y: 1.1 },
    { x: 17.2, y: 1.1 },
    { x: 18.5, y: 1.1 },
    { x: 15.9, y: 3.3 },
    { x: 17.2, y: 3.3 },
    { x: 18.5, y: 3.3 },
  ],
  /** 复印机：东南角，贴东墙 */
  printer: { x: 17.8, y: 3.8, w: 1.6, d: 1.1, h: 1.0 },
  /** 白板贴在后墙内侧 */
  whiteboard: { x0: 15.4, x1: 18.6, z0: 0.95, z1: 1.95 },
};

/** 会议室的座位点（= 椅子位置） */
export const MEETING_SEATS = MEETING.chairs.map((c) => ({ ...c }));

/* ------------------------------------------------------------------ *
 * 茶水间（会议室前面那间，玻璃隔断）
 * ------------------------------------------------------------------ */

/** 北面不另砌墙：会议室的南墙就是两间房共用的那道隔墙 */
export const PANTRY = {
  x: 14.6,
  y: 5.3,
  w: 4.8,
  d: 3.6,
  glass: {
    /** 门开在西面中段，门洞在 y 7.0 ~ 8.2 */
    westA: { x: 14.6, y: 5.3, w: 0.1, d: 1.7 },
    westB: { x: 14.6, y: 8.2, w: 0.1, d: 0.7 },
    south: { x: 14.6, y: 8.9, w: 4.8, d: 0.1 },
    h: 2.3,
  },
  /** 饮水机（靠北墙，进屋就能接水） */
  cooler: { x: 15.1, y: 5.9, r: 0.3, h: 1.35 },
  /** 餐桌 */
  table: { x: 16.0, y: 6.6, w: 2.2, d: 1.1, h: 0.74 },
  /** 4 把椅子：餐桌南北各两把 */
  chairs: [
    { x: 16.5, y: 6.25 },
    { x: 17.7, y: 6.25 },
    { x: 16.5, y: 8.05 },
    { x: 17.7, y: 8.05 },
  ],
};

/* ------------------------------------------------------------------ *
 * 绿植
 * ------------------------------------------------------------------ */

/** 绿植：贴着后墙墙根摆在三扇窗下面（盆沿几乎挨到墙面），彼此分开 */
export const PLANTS = [
  { x: 2.7, y: 0.33, s: 1 },
  { x: 6.0, y: 0.36, s: 0.95 },
  { x: 7.4, y: 0.32, s: 1.05 },
  { x: 10.7, y: 0.35, s: 1.1 },
];

/** 精灵会去的地点 */
export const PLACES = {
  /** 接水：进茶水间屋里，站在饮水机前 */
  coffee: { x: 15.1, y: 6.5 },
  /** 文印：进会议室，站在复印机西侧 */
  printer: { x: 17.3, y: 4.35 },
  door: { x: 13.0, y: 0.9 },
};

/* ------------------------------------------------------------------ *
 * 路网：精灵只在节点之间走，不会穿桌子
 * ------------------------------------------------------------------ */

const N = {
  B06: { x: 0.6, y: 1.5 },
  B25: { x: 2.5, y: 1.5 },
  B69: { x: 6.9, y: 1.5 },
  B113: { x: 11.3, y: 1.5 },
  B134: { x: 13.4, y: 1.5 },

  M06: { x: 0.6, y: 5.4 },
  M25: { x: 2.5, y: 5.4 },
  M69: { x: 6.9, y: 5.4 },
  M113: { x: 11.3, y: 5.4 },
  M134: { x: 13.4, y: 5.4 },

  F06: { x: 0.6, y: 9.4 },
  F25: { x: 2.5, y: 9.4 },
  F69: { x: 6.9, y: 9.4 },
  F113: { x: 11.3, y: 9.4 },
  F134: { x: 13.4, y: 9.4 },
  F169: { x: 16.9, y: 10.0 },

  DOOR: PLACES.door,
  COFFEE: PLACES.coffee,
  PRINT: PLACES.printer,

  /**
   * 进出工位的通道。隔板是 3.2 宽的一整块，座位在它和桌子之间，
   * 所以只能从两处缺口（x 4.1~5.3 / 8.5~9.7）和左右两端（x<0.9 / x>12.9）绕进去，
   * 直接"座位 ↔ 过道"连直线会穿板。
   * 排内落脚点 y 取隔板前脸（A 2.09 / B 6.09）和椅背（A 2.72 / B 6.72）之间的空当。
   */
  AIN_L: { x: 0.45, y: 2.7 },
  AIN_1: { x: 4.7, y: 2.7 },
  AIN_2: { x: 9.1, y: 2.7 },
  AIN_R: { x: 13.4, y: 2.7 },
  BIN_L: { x: 0.45, y: 6.7 },
  BIN_1: { x: 4.7, y: 6.7 },
  BIN_2: { x: 9.1, y: 6.7 },
  BIN_R: { x: 13.4, y: 6.7 },
  /** 过道上正对缺口的点：从这里拐进排里 */
  AG1: { x: 4.7, y: 1.5 },
  AG2: { x: 9.1, y: 1.5 },
  MG1: { x: 4.7, y: 5.4 },
  MG2: { x: 9.1, y: 5.4 },

  /** 会议室：门在侧面（西墙）→ 门内 → 绕到桌子北侧 */
  MDOOR_OUT: { x: 13.6, y: 3.4 },
  MDOOR_IN: { x: 15.0, y: 3.4 },
  MSIDE_A: { x: 14.9, y: 4.5 },
  MSIDE_B: { x: 14.9, y: 1.5 },

  /** 茶水间：门在西墙 → 门内 → 饮水机前 */
  PDOOR_OUT: { x: 13.6, y: 7.6 },
  PDOOR_IN: { x: 15.2, y: 7.6 },
};

DESK_UNITS.forEach((d, i) => {
  N[`SEAT_${d.id}`] = { ...d.seat };
});
MEETING_SEATS.forEach((s, i) => {
  N[`MSEAT_${i}`] = { ...s };
});

const EDGES = [
  // 三条横向过道（缺口处补节点，方便拐进工位）
  ['B06', 'B25'], ['B25', 'AG1'], ['AG1', 'B69'], ['B69', 'AG2'], ['AG2', 'B113'], ['B113', 'B134'],
  ['M06', 'M25'], ['M25', 'MG1'], ['MG1', 'M69'], ['M69', 'MG2'], ['MG2', 'M113'], ['M113', 'M134'],
  ['F06', 'F25'], ['F25', 'F69'], ['F69', 'F113'], ['F113', 'F134'], ['F134', 'F169'],
  // 两侧竖向连接
  ['B06', 'M06'], ['M06', 'F06'],
  ['B134', 'M134'], ['M134', 'F134'],
  // 大门
  ['B134', 'DOOR'],
  // 工位：过道 → 缺口 → 排内 → 座位（A 排走后过道，B 排走中过道，全程绕开隔板）
  ['B06', 'AIN_L'], ['AG1', 'AIN_1'], ['AG2', 'AIN_2'], ['B134', 'AIN_R'],
  ['AIN_L', 'SEAT_A0'], ['AIN_1', 'SEAT_A0'], ['AIN_1', 'SEAT_A1'], ['AIN_2', 'SEAT_A1'],
  ['AIN_2', 'SEAT_A2'], ['AIN_R', 'SEAT_A2'],
  ['M06', 'BIN_L'], ['MG1', 'BIN_1'], ['MG2', 'BIN_2'], ['M134', 'BIN_R'],
  ['BIN_L', 'SEAT_B0'], ['BIN_1', 'SEAT_B0'], ['BIN_1', 'SEAT_B1'], ['BIN_2', 'SEAT_B1'],
  ['BIN_2', 'SEAT_B2'], ['BIN_R', 'SEAT_B2'],
  // 复印机在会议室里：门内 → 南侧走廊 → 机器前
  ['MSIDE_A', 'PRINT'],
  // 茶水间：右侧过道 → 侧面门 → 门内 → 饮水机前接水
  ['M134', 'PDOOR_OUT'], ['F134', 'PDOOR_OUT'], ['PDOOR_OUT', 'PDOOR_IN'], ['PDOOR_IN', 'COFFEE'],
  // 会议室：右侧过道 → 侧面门外 → 门内 → 南侧座位 / 绕到北侧
  ['B134', 'MDOOR_OUT'], ['M134', 'MDOOR_OUT'], ['MDOOR_OUT', 'MDOOR_IN'],
  ['MDOOR_IN', 'MSEAT_3'], ['MDOOR_IN', 'MSEAT_4'], ['MDOOR_IN', 'MSEAT_5'],
  ['MDOOR_IN', 'MSIDE_A'], ['MSIDE_A', 'MSIDE_B'],
  ['MSIDE_B', 'MSEAT_0'], ['MSIDE_B', 'MSEAT_1'], ['MSIDE_B', 'MSEAT_2'],
];

const ADJ = (() => {
  const m = new Map();
  Object.keys(N).forEach((k) => m.set(k, []));
  EDGES.forEach(([a, b]) => {
    if (!m.has(a) || !m.has(b)) return;
    m.get(a).push(b);
    m.get(b).push(a);
  });
  return m;
})();

/** 调试：所有路网节点（画出来能看出路线合不合理） */
export const NAV_NODES = Object.values(N);

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function nearestNode(pt) {
  let best = null;
  let bestD = Infinity;
  for (const [k, v] of Object.entries(N)) {
    const d = dist(pt, v);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

function bfs(from, to) {
  if (from === to) return [from];
  const prev = new Map([[from, null]]);
  const q = [from];
  while (q.length) {
    const cur = q.shift();
    for (const nb of ADJ.get(cur) || []) {
      if (prev.has(nb)) continue;
      prev.set(nb, cur);
      if (nb === to) {
        const path = [nb];
        let c = cur;
        while (c) {
          path.unshift(c);
          c = prev.get(c);
        }
        return path;
      }
      q.push(nb);
    }
  }
  return null;
}

/**
 * 规划路径：从任意点走到任意点，返回途经点数组（含精确起终点）。
 * 先吸附到最近的路网节点走 BFS，再补上首尾真实坐标，避免瞬移。
 */
export function route(from, to) {
  const a = nearestNode(from);
  const b = nearestNode(to);
  const path = bfs(a, b) || [];
  const pts = path.map((k) => ({ ...N[k] }));
  if (pts.length) {
    if (dist(pts[0], from) > 0.05) pts.unshift({ ...from });
    else pts[0] = { ...from };
    const last = pts[pts.length - 1];
    if (dist(last, to) > 0.05) pts.push({ ...to });
    else pts[pts.length - 1] = { ...to };
  } else {
    pts.push({ ...from }, { ...to });
  }
  return pts;
}
