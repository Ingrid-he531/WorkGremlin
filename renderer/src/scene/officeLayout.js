/**
 * officeLayout —— geometry and pathfinding for the full-screen office scene.
 *
 * Coordinate convention: scene is 1600×900, screen top = office north side (far from camera), bottom = south side (near camera).
 * So a larger y is "closer to the camera", and whatever is drawn later covers what was drawn before.
 *
 * Zones:
 *   y 0..153     back wall + windows
 *   y 153..210   north corridor (walkway)
 *   y 210..345   row A workstations (person to the north, desk to the south; the desk covers the lower body = seated)
 *   y 345..500   middle corridor
 *   y 500..635   row B workstations
 *   y 635..900   front area: pantry counter / print area (front corridor y=830)
 *   x 1100..1560 meeting room (glass room)
 *
 * Sprites only move along corridor nodes (BFS shortest path), so they never walk through desks.
 */

export const SCENE = { w: 1600, h: 900 };

/** Zone top y of both workstation rows (row A on top) */
export const ROW = { A: 210, B: 500 };
/** x of each workstation cell's top-left corner (cell width 280) */
export const DESK_X = [80, 380, 680];
/** Sprite size in the scene (roughly 2× the GremlinSprite 64 coordinate system) */
export const SPRITE_SCALE = 2.05;

/** All geometry for one workstation (local: x = cell left edge, p = zone top) */
export function deskUnit(x, p) {
  return {
    rail: { x: x + 8, y: p - 6, w: 264, h: 7 },
    partition: { x: x + 10, y: p, w: 260, h: 70 },
    chair: { x: x + 55, y: p + 22, w: 95, h: 58 },
    chairInner: { x: x + 63, y: p + 30, w: 79, h: 46 },
    seat: { x: x + 100, y: p + 78 },
    deskTop: `${x + 40},${p + 70} ${x + 240},${p + 70} ${x + 270},${p + 105} ${x + 10},${p + 105}`,
    deskFront: { x: x + 10, y: p + 105, w: 260, h: 8 },
    legs: [
      `${x + 30},${p + 113} ${x + 44},${p + 113} ${x + 40},${p + 135} ${x + 34},${p + 135}`,
      `${x + 236},${p + 113} ${x + 250},${p + 113} ${x + 246},${p + 135} ${x + 240},${p + 135}`,
    ],
    monitor: {
      base: { cx: x + 200, cy: p + 72, rx: 22, ry: 5 },
      neck: { x: x + 195, y: p + 55, w: 10, h: 17 },
      bezel: { x: x + 140, y: p + 8, w: 110, h: 48 },
      screen: { x: x + 145, y: p + 12, w: 100, h: 40 },
      led: { cx: x + 244, cy: p + 52, r: 2.6 },
    },
    keyboard: `${x + 64},${p + 76} ${x + 166},${p + 76} ${x + 172},${p + 94} ${x + 58},${p + 94}`,
    keyRows: [
      `${x + 68},${p + 79} ${x + 162},${p + 79} ${x + 163},${p + 82} ${x + 67},${p + 82}`,
      `${x + 66},${p + 84} ${x + 164},${p + 84} ${x + 165},${p + 87} ${x + 65},${p + 87}`,
      `${x + 64},${p + 89} ${x + 166},${p + 89} ${x + 168},${p + 92} ${x + 62},${p + 92}`,
    ],
    mouse: { cx: x + 186, cy: p + 88, rx: 6, ry: 9 },
    mug: { x: x + 228, y: p + 78, w: 14, h: 16 },
    note: { x: x + 215, y: p + 18, w: 14, h: 14 },
  };
}

/** 6 workstations (first 3 in row A, last 3 in row B) */
export const DESKS = [
  ...DESK_X.map((x, i) => ({ id: `A${i}`, row: 'A', index: i, ...deskUnit(x, ROW.A) })),
  ...DESK_X.map((x, i) => ({ id: `B${i}`, row: 'B', index: i + 3, ...deskUnit(x, ROW.B) })),
];

/** Meeting room */
export const MEETING = {
  x: 1100,
  y: 153,
  w: 460,
  h: 487,
  glassLeft: { x: 1100, y: 153, w: 12, h: 487 },
  glassFront: { x: 1100, y: 620, w: 460, h: 12 },
  doorGap: { x: 1180, w: 100 },
  wallRight: { x: 1548, y: 153, w: 12, h: 487 },
  table: { x: 1160, y: 360, w: 340, h: 110, rx: 55 },
  whiteboard: { x: 1215, y: 175, w: 250, h: 100 },
  clock: { cx: 1512, cy: 198, r: 18 },
  /** 6 seats: 4 on the north side of the long table, 2 at the two ends */
  seats: [
    { x: 1195, y: 380 },
    { x: 1290, y: 380 },
    { x: 1385, y: 380 },
    { x: 1480, y: 380 },
    { x: 1165, y: 430 },
    { x: 1490, y: 430 },
  ],
};

/** Front area: pantry counter + print area */
export const LOUNGE = {
  counter: { x: 40, y: 690, w: 260, h: 80 },
  counterTop: { x: 40, y: 682, w: 260, h: 10 },
  machine: { x: 70, y: 645, w: 60, h: 40 },
  cups: [
    { x: 150, y: 668, w: 12, h: 14 },
    { x: 170, y: 668, w: 12, h: 14 },
    { x: 190, y: 668, w: 12, h: 14 },
  ],
  printer: { x: 860, y: 700, w: 130, h: 70 },
  cooler: { x: 520, y: 700, w: 60, h: 90 },
  plants: [
    { x: 1040, y: 240, s: 1 },
    { x: 1005, y: 700, s: 1.15 },
    { x: 340, y: 660, s: 0.95 },
    { x: 25, y: 430, s: 0.9 },
  ],
};

/** Back wall windows */
export const WINDOWS = [
  { x: 90, y: 40, w: 260, h: 80 },
  { x: 420, y: 40, w: 260, h: 80 },
  { x: 750, y: 40, w: 260, h: 80 },
];

/** "Places" a sprite can go to (workstations excluded —— those are DESKS[i].seat) */
export const PLACES = {
  coffee: { x: 170, y: 800 },
  printer: { x: 935, y: 810 },
  door: { x: 1225, y: 660 },
};

/* ------------------------------------------------------------------ *
 * Airspace for temporary members (ghosts)
 *
 * Ghosts have no workstation and don't use the path network —— they drift in the air band between the window
 * sill (y=120) and the partition top (y=210), so they never block seated people (head top y≈183 is lower down).
 * ------------------------------------------------------------------ */
export const GHOST = {
  /** Hover anchors: y is the height of the "hem", head top at y - 51 * GHOST_SCALE */
  anchors: [
    { x: 300, y: 240 },
    { x: 600, y: 240 },
    { x: 900, y: 240 },
    { x: 450, y: 253 },
    { x: 750, y: 253 },
    { x: 150, y: 235 },
  ],
  /** Above the meeting room (drift over to sit in when a meeting is called) */
  meeting: { x: 1200, y: 360 },
};

/** Ghosts are slightly smaller than seated sprites —— visually lighter and further away */
export const GHOST_SCALE = 1.7;

/* ------------------------------------------------------------------ *
 * Corridor network: sprites only walk between nodes, so they never cut through desks
 * ------------------------------------------------------------------ */

const N = {
  N30: { x: 30, y: 195 },
  N180: { x: 180, y: 195 },
  N370: { x: 370, y: 195 },
  N480: { x: 480, y: 195 },
  N670: { x: 670, y: 195 },
  N780: { x: 780, y: 195 },
  N1020: { x: 1020, y: 195 },

  M30: { x: 30, y: 430 },
  M180: { x: 180, y: 430 },
  M370: { x: 370, y: 430 },
  M480: { x: 480, y: 430 },
  M670: { x: 670, y: 430 },
  M780: { x: 780, y: 430 },
  M1020: { x: 1020, y: 430 },

  F30: { x: 30, y: 830 },
  F170: { x: 170, y: 830 },
  F370: { x: 370, y: 830 },
  F670: { x: 670, y: 830 },
  F935: { x: 935, y: 830 },
  F1020: { x: 1020, y: 830 },
  F1225: { x: 1225, y: 830 },

  SA0: { x: 180, y: 288 },
  SA1: { x: 480, y: 288 },
  SA2: { x: 780, y: 288 },
  SB0: { x: 180, y: 578 },
  SB1: { x: 480, y: 578 },
  SB2: { x: 780, y: 578 },

  COFFEE: PLACES.coffee,
  PRINTER: PLACES.printer,
  DOOR: PLACES.door,
};

MEETING.seats.forEach((s, i) => {
  N[`MS${i}`] = s;
});

const EDGES = [
  // North corridor / middle corridor / front corridor
  ['N30', 'N180'], ['N180', 'N370'], ['N370', 'N480'], ['N480', 'N670'], ['N670', 'N780'], ['N780', 'N1020'],
  ['M30', 'M180'], ['M180', 'M370'], ['M370', 'M480'], ['M480', 'M670'], ['M670', 'M780'], ['M780', 'M1020'],
  ['F30', 'F170'], ['F170', 'F370'], ['F370', 'F670'], ['F670', 'F935'], ['F935', 'F1020'], ['F1020', 'F1225'],
  // Vertical links (the gaps between desks)
  ['N30', 'M30'], ['M30', 'F30'],
  ['N370', 'M370'], ['M370', 'F370'],
  ['N670', 'M670'], ['M670', 'F670'],
  ['N1020', 'M1020'], ['M1020', 'F1020'],
  // Workstations: turn off the corridor into the seat
  ['N180', 'SA0'], ['N480', 'SA1'], ['N780', 'SA2'],
  ['M180', 'SB0'], ['M480', 'SB1'], ['M780', 'SB2'],
  // Pantry counter / printer / meeting room door
  ['F170', 'COFFEE'], ['F935', 'PRINTER'], ['F1225', 'DOOR'],
];
MEETING.seats.forEach((_, i) => EDGES.push(['DOOR', `MS${i}`]));

const ADJ = (() => {
  const m = new Map();
  Object.keys(N).forEach((k) => m.set(k, []));
  EDGES.forEach(([a, b]) => {
    m.get(a).push(b);
    m.get(b).push(a);
  });
  return m;
})();

/** Debug use: all path-network node coordinates (draw them to see whether the routes sprites take make sense) */
export const GRAPH_POINTS = Object.values(N);

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Name of the corridor node nearest to a given point */
export function nearestNode(pt) {
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

/** Breadth-first: returns an array of node names (including start and end), or null if not found */
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
 * Plan a path: walk from any point to any point, return the waypoint array (with exact start and end).
 * First find the nearest nodes on the network, take the shortest path, then fill in the real start and end coordinates.
 */
export function route(from, to) {
  const a = nearestNode(from);
  const b = nearestNode(to);
  const path = bfs(a, b) || [];
  const pts = path.map((k) => ({ ...N[k] }));
  // Replace the "nearest node" with the real coordinates at the start/end to avoid teleporting
  if (pts.length) {
    if (dist(pts[0], from) > 1) pts.unshift({ ...from });
    else pts[0] = { ...from };
    const last = pts[pts.length - 1];
    if (dist(last, to) > 1) pts.push({ ...to });
    else pts[pts.length - 1] = { ...to };
  } else {
    pts.push({ ...from }, { ...to });
  }
  return pts;
}
