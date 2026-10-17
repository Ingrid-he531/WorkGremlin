/**
 * officeMap.js —— the "world data" of the isometric office.
 *
 * It only says "what is where, how big it is, how people walk" —— no drawing code at all (drawing lives in engine.js).
 * Coordinates are world coordinates (tile): x toward the front-right, y toward the front-left, wall height 2.8.
 *
 * Floor plan (top-down; x to the right, y downward = toward the camera; the top edge is the back wall):
 *
 *   y=0     ┌──────────────────────────┬───────────┐
 *           │ win win win   door       │ meeting   │
 *   y=1.5   │ rear aisle               │ whiteboard│
 *   y=2.6   │ man man man              │ mtg table │
 *   y=2.9   │ desk desk desk           │           │
 *   y=3.95  │ ▬▬ nameplate divider ▬▬▬ │           │
 *   y=4.09  │ desk desk desk           │           │
 *   y=5.44  │ man man man              └── glass ──┘
 *   y=6.1   │ mid aisle
 *   y=6.75  │ man man man
 *   y=7.05  │ desk desk desk
 *   y=8.1   │ ▬▬ nameplate divider ▬▬▬
 *   y=8.24  │ desk desk desk
 *   y=9.59  │ man man man
 *   y=10.55 │ front aisle
 *   y=11.3  │ main Agent console
 *   y=11.8  │      └ summon spot
 *   y=13    └──────────────────────────────────────┘
 *
 * A workstation is a "face-to-face double desk": 3 columns × 2 groups = 6 groups = 12 workstations. In each group the two people face each other
 * (each sits on the outer side of their own desk), with only a divider between them.
 */

export const ROOM = { w: 20, d: 13 };

/** Scene palette (dark night office) */
export const COLORS = {
  /** Floor: full-coverage diamond carpet tiles —— two alternating shades + tile seams, one material for the whole room */
  floor: '#2e3442',
  floorAlt: '#333b4a',
  floorSeam: '#28303d',
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
  /** Workstation divider: opaque panel body + aluminium frame */
  divider: '#2a3241',
  dividerFrame: '#5f6a7e',
  /** Desk legs / desk frame (dark wood) */
  deskLeg: '#3a2d21',
  /** Sticky note on the divider: paper colour + ink colour of the writing on it (overridable per floor, see FLOOR_COLORS) */
  note: '#f2c94c',
  noteInk: '#3a2e0e',
};

/**
 * Floor palette overrides: the same office, but individual floors may have their own material colours.
 * Only the few tokens that need distinguishing are overridden; the rest follow the COLORS baseline above.
 *
 * Purpose: tell floors apart at a glance. Overrides only touch **furniture materials** such as the metal parts and desk/chair wood,
 * plus that **sticky note** on the divider (note / noteInk); floor / walls / glass / plants follow the baseline ——
 * what changes is the furniture and the note, not a full re-skin of the floor.
 *
 * Note: **the workstation divider (divider panel + dividerFrame aluminium frame) uses the baseline COLORS on every floor**,
 * and is not overridden per floor here —— each floor only distinguishes desks/chairs, metal furniture and the note.
 *   - 5F (TraeCode, IDE and plugin merged) goes warm amber, pulling away from the baseline cool blue-grey;
 *   - 3F (Codex CLI) goes cool violet, colliding with neither the baseline blue-grey nor 5F's amber:
 *     the furniture is indigo-violet graphite, and the note likewise moves from "note yellow" to cool violet (violet paper + violet ink);
 *   - 4F (Claude Code) goes terracotta brick red: furniture is terracotta / brick red, the note becomes coral pink paper + brick red ink.
 *     The hue is deliberately held around 10° (the brand clay colour band), pulled apart from 5F amber's 32° ——
 *     both are warm, but one is "brick" and the other "amber", so they are not lumped into one family;
 *   - 6F (Qoder CLI) goes verdant jade: furniture is jade / emerald stone, the note becomes mint paper + dark green ink.
 *     Hue held around 150° (a slightly cool green), clearly pulled apart from 3F's violet, 4F's brick red and 5F's amber,
 *     one material set per floor, colliding with no existing floor.
 *   - 7F (Kilo Code) goes brass moss: furniture is olive brass, the note becomes young moss paper + deep moss ink.
 *     Hue 84° (yellow-green). **It and 6F are both "green", but are deliberately not made into one family** ——
 *     6F is 157° jade (cool, blue-leaning), 7F is 84° brass moss (warm, yellow-leaning),
 *     the furniture wood parts measured **73°** apart (hues computed as HSL from `node`, not estimated).
 *     The two floors share an origin (Kilo Code CLI is a fork of OpenCode) yet get different palettes; the reason is in the 8F entry below.
 *     Incidentally, 7F is still 52° from its nearest floor (5F amber 32°), much roomier than the 19° between 4F↔5F.
 *   - 8F (OpenCode) goes magenta rosewood: furniture is magenta rosewood, the note becomes rose pink paper + plum purple ink.
 *     Hue ~335°, the furthest of the existing floors (3F 265° violet / 4F 10° brick red / 5F 32° amber /
 *     6F 150° jade / 7F 84° brass moss), colliding with no existing floor.
 *     7F Kilo Code shares an origin with it (see the evidence chain in server/src/products.js), but the two floors'
 *     furniture hues are deliberately separated —— floors are recognised "by product", not "by bloodline".
 *
 * Floors not listed here —— 1F CodeBuddy / 2F Cline —— use the baseline COLORS, visually identical to before.
 * After the TraeCode merge it occupies only 5F, and the old 6F (IDE) warm amber set moved to 5F wholesale;
 * the old 6F verdigris set (old 5F plugin) is no longer needed —— one floor gets exactly one material set.
 */
export const FLOOR_COLORS = {
  '3F': {
    // desk/chair wood: cool rosewood
    wood: '#634e74',
    woodDark: '#463653',
    deskLeg: '#382c44',
    // metal parts: indigo-violet graphite (dividers use the baseline colour everywhere, not overridden here)
    metal: '#403a5c',
    metalDark: '#2d2842',
    chair: '#3d3759',
    // divider note: cool violet paper + violet ink (baseline is note yellow #f2c94c, see COLORS)
    note: '#b3a4f0',
    noteInk: '#241d45',
  },
  '4F': {
    // desk/chair wood: terracotta brick red
    wood: '#7d4536',
    woodDark: '#583026',
    deskLeg: '#48271f',
    // metal parts: dark terracotta (dividers use the baseline colour everywhere, not overridden here)
    metal: '#54352e',
    metalDark: '#3a2420',
    chair: '#3f2b27',
    // divider note: coral pink paper + brick red ink (baseline is note yellow #f2c94c, see COLORS)
    note: '#f0a68e',
    noteInk: '#4a1c14',
  },
  '5F': {
    // desk/chair wood: warm oak
    wood: '#8a6438',
    woodDark: '#5d452a',
    deskLeg: '#4a3a26',
    // metal parts: warm bronze (dividers use the baseline colour everywhere, not overridden here)
    metal: '#4a4033',
    metalDark: '#332e26',
    chair: '#3e382d',
  },
  '6F': {
    // desk/chair wood: verdant jade
    wood: '#3f7a63',
    woodDark: '#2c5747',
    deskLeg: '#234539',
    // metal parts: bluestone graphite (dividers use the baseline colour everywhere, not overridden here)
    metal: '#34574e',
    metalDark: '#233b35',
    chair: '#2c463d',
    // divider note: mint paper + dark green ink (baseline is note yellow #f2c94c, see COLORS)
    note: '#a8e6c8',
    noteInk: '#10301f',
  },
  '7F': {
    // desk/chair wood: olive brass (hue ~84°, yellow-green)
    wood: '#557a1e',
    woodDark: '#3d5715',
    deskLeg: '#2e4210',
    // metal parts: bronze moss (dividers use the baseline colour everywhere, not overridden here)
    metal: '#4a5526',
    metalDark: '#333b1b',
    chair: '#3b4420',
    // divider note: young moss paper + deep moss ink (baseline is note yellow #f2c94c, see COLORS)
    note: '#d4e07a',
    noteInk: '#26330a',
  },
  '8F': {
    // desk/chair wood: magenta rosewood (hue ~335°)
    wood: '#7a3a63',
    woodDark: '#552741',
    deskLeg: '#421e30',
    // metal parts: amethyst graphite (dividers use the baseline colour everywhere, not overridden here)
    metal: '#553a51',
    metalDark: '#3a2838',
    chair: '#452f42',
    // divider note: rose pink paper + plum purple ink (baseline is note yellow #f2c94c, see COLORS)
    note: '#f2a8c8',
    noteInk: '#4a0f2e',
  },
  '9F': {
    // desk/chair wood: GitHub Copilot deep-blue cruise (cool blue-violet)
    wood: '#3b6ea8',
    woodDark: '#254a79',
    deskLeg: '#173458',
    metal: '#2f476d',
    metalDark: '#1d2c42',
    chair: '#2d3f5a',
    note: '#b7cfff',
    noteInk: '#11284f',
  },
};

/** Palette for a given floor (baseline COLORS + that floor's overrides; floors with no override return the baseline directly, with no extra copy) */
export function colorsFor(floorId) {
  const over = FLOOR_COLORS[floorId];
  return over ? { ...COLORS, ...over } : COLORS;
}

export const WALL = {
  h: 2.8,
  thickness: 0.28,
  /** Windows on the back wall (gx range + height range) */
  windows: [
    { x0: 1.2, x1: 4.2, z0: 1.1, z1: 2.2 },
    { x0: 5.2, x1: 8.2, z0: 1.1, z1: 2.2 },
    { x0: 9.2, x1: 12.2, z0: 1.1, z1: 2.2 },
  ],
  /**
   * Main door: cut into the left wall (the gx = 0 face), not the back wall.
   * That wall also holds the clock (cy 6.6); the door sits to the clock's left —— on this wall, a larger gy is further left on screen.
   * @property {number} y0 start of the doorway along gy
   * @property {number} y1 end of the doorway along gy
   */
  door: { y0: 8.4, y1: 9.4, z0: 0, z1: 2.05 },
};

/* ------------------------------------------------------------------ *
 * Workstations
 * ------------------------------------------------------------------ */

const DESK_W = 3.0;
/** Desk depth: a touch shallower than the old 1.25 —— one "face-to-face double desk" group has to fit desk + divider + desk + chairs on both sides,
 *  and two groups plus three aisles land exactly between the rear aisle (1.5) and the console (11.55) (1.05 deep still leaves room for a monitor + keyboard). */
const DESK_D = 1.05;
const DESK_H = 0.74;
/** Distance from a chair to the outer edge of its own desk (= where the person sits) */
const SEAT_GAP = 0.3;
/**
 * Mid-seam divider: **as long as the desk** (w = DESK_W, so its outer edge including the frame lines up exactly with the desk's left/right edges ——
 * the frame does not stick out and both sides of the desktop meet the vertical frame), depth 0.14, wrapped in a **dark metal frame (as thick as the panel)**,
 * floor-standing, no base, **opaque dark grey panel body**. The panel sits right on the seam between the two desks (north desk's south edge = panel's north edge,
 * panel's south edge = south desk's north edge), one desk pressed against each side —— that is, "the middle of the two desktops".
 *
 * Where the height 1.21 comes from (the ask was "cut the part sticking above the desktop in half": the 1.68 version stuck up 0.94 → now 0.47, exactly half),
 * and it is also the meeting point of three hard constraints:
 *   · **North desk stays readable**: an opaque panel sits between the two desks, and isometrically "a panel of height h hides h of the ground behind it",
 *     so the visible part of the clipped north desk = 1.93 − h. At h = 1.21 that is 0.72 (seven tenths), keeping monitor/keyboard/cup,
 *     so it still reads as "a desk behind a screen", not a desktop that stops at the panel's top edge (at 1.68 only 0.25 showed, which was exactly the problem).
 *   · **The nameplate fits on the panel face**: the plate hangs on the camera-facing side; its bottom edge must be above the visible line where the south desk cuts in (0.75),
 *     and its top edge must clear the top aluminium frame (1.21 − 0.05 = 1.16) → the plate height is squeezed to 0.38 and hung at z 0.77, fitting exactly.
 *   · **Sticks above the desktop**: 1.21 is 0.47 above the 0.74 desktop, clearly more than the old 0.84 version (0.16 high) —— that holds up.
 */
const DIVIDER_D = 0.14;
const DIVIDER_H = 1.21;
/** Width of the aluminium frame (all four edges the same width) */
const DIVIDER_FRAME = 0.05;

/* The sticky note on the divider: pasted at a tilt on the left of the **camera-facing side**, with a magnetic holder pressing its top edge.
 *
 * Only a narrow band is available to paste on —— the south desk (desktop height 0.74) sits in front of the divider along its south edge,
 * and isometrically "a thing of height h hides h of the image behind it", so the panel face is only exposed between
 * z 0.74 ~ 1.16 (the bottom edge of the top aluminium frame), 0.42 high in total. The note is 0.30 square and tilted 8°, giving a 0.34 bounding box; centred at 0.95
 * it leaves 0.04 above and below —— neither clipped at the bottom by the south desk nor bumped into the aluminium frame.
 *
 * Horizontally it takes 0.38 in from the left end: the south desk's monitor starts at gx +1.15 and sits entirely to the note's right, so it cannot hide the note
 * (any further right would clip a chunk of it off). */
const NOTE_SIDE = 0.3;
const NOTE_Z = 0.95;
const NOTE_DX = 0.38;
/** Radius of the magnetic holder (tile): about 1/5 of the note's side length, pressing the middle of the paper's top edge */
const NOTE_MAGNET_R = 0.06;
/** Left edge of the desks in the three columns (keeping the old column pitch 4.4: desk width 3.0 + 1.4 between columns to walk through) */
const COLS = [1.0, 5.4, 9.8];
/** y of the north person's seat in the two "face-to-face double desk" groups */
const BENCH_Y = [2.6, 6.75];
/** Where the person sits (gx offset): middle of the desk, facing the keyboard/monitor vertical band (keyboard centre x+1.6) */
const SEAT_DX = 1.6;

/**
 * One "face-to-face double desk" group (= 1 column × 1 group = 2 workstations).
 *
 * From north to south: north person → north desk → divider → south desk → south person.
 * The two people each sit on the **outer side of their own desk**, facing each other, with only a divider between them.
 * Workstation ids keep the A/B naming: `A<row*3+col>` (north side), `B<row*3+col>` (south side) ——
 * so the two `target: 'A1' / 'B1'` dispatch targets in the demo script still work.
 *
 * Layout of the things on the desk: person → keyboard → monitor, from that side's desk edge all the way to the divider (one behind the other);
 *   the name tag lies flat in the desktop's "bottom-left corner once you sit down" (north desk's north-east corner / south desk's south-west corner),
 *   clear of the keyboard, mouse and monitor positions.
 *
 * @param {number} col column index 0..2
 * @param {number} row group index 0..1
 * @param {number} x desk left edge
 * @param {number} yN seat y of the north person
 */
function bench(col, row, x, yN) {
  const northDesk = { x, y: yN + SEAT_GAP, w: DESK_W, d: DESK_D, h: DESK_H };
  const southDesk = { x, y: northDesk.y + DESK_D + DIVIDER_D, w: DESK_W, d: DESK_D, h: DESK_H };
  const yS = southDesk.y + DESK_D + SEAT_GAP;

  const northId = `A${row * COLS.length + col}`;
  const southId = `B${row * COLS.length + col}`;
  const common = { row, col, bench: `${col}:${row}`, x };

  return {
    id: `${col}:${row}`,
    /** Divider: the panel between the two desks (same length, with an aluminium frame); `seats` says which workstation each side belongs to */
    divider: {
      x,
      y: northDesk.y + DESK_D,
      w: DESK_W,
      d: DIVIDER_D,
      h: DIVIDER_H,
      frame: DIVIDER_FRAME,
      seats: [northId, southId],
      /** Upper/lower bounds for depth clipping (used by engine): the "desktop including the things on it" depth of this group's north / south desk */
      northDesk,
      southDesk,
      /** Sticky note: pasted at a tilt on the left of the camera-facing side (south face) (geometry in the NOTE_* comment above) */
      note: {
        x: x + NOTE_DX,
        z: NOTE_Z,
        w: NOTE_SIDE,
        h: NOTE_SIDE,
        /** Tilt angle (degrees, rotated about the paper centre within the panel face): negative = top edge leaning west. Staggered by group index so the six dividers are not clones */
        tilt: -8 + ((row * COLS.length + col) % 3) * 1.6,
        magnet: NOTE_MAGNET_R,
      },
    },
    north: {
      ...common,
      id: northId,
      /** 'south' = faces +gy (sits facing the camera); 'north' = faces -gy (sits with its back to the camera) */
      face: 'south',
      seat: { x: x + SEAT_DX, y: yN },
      chair: { x: x + SEAT_DX, y: yN },
      desk: northDesk,
      // monitor and keyboard one behind the other: keyboard in front of the person (north edge), monitor against the divider (back to the camera, so its back is what you see)
      monitor: { x: x + 1.15, y: northDesk.y + 0.5, w: 0.91, d: 0.12, h: 0.56 },
      keyboard: { x: x + 1.25, y: northDesk.y + 0.18, w: 0.7, d: 0.26 },
    },
    south: {
      ...common,
      id: southId,
      face: 'north',
      seat: { x: x + SEAT_DX, y: yS },
      chair: { x: x + SEAT_DX, y: yS },
      desk: southDesk,
      // mirrored: monitor north of the keyboard, basically touching it (0.36 from the divider, screen facing the camera)
      monitor: { x: x + 1.15, y: southDesk.y + 0.36, w: 0.91, d: 0.12, h: 0.56 },
      keyboard: { x: x + 1.25, y: southDesk.y + 0.56, w: 0.7, d: 0.26 },
    },
  };
}

/** 6 face-to-face double desk groups (3 columns × 2 groups) */
export const BENCHES = BENCH_Y.flatMap((y, row) => COLS.map((x, col) => bench(col, row, x, y)));

/** 12 workstations: [A0,B0, A1,B1, A2,B2, A3,B3, A4,B4, A5,B5] (the north side comes first within a group) */
export const DESK_UNITS = BENCHES.flatMap((b) => [b.north, b.south]);

/** 6 dividers (each carries two nameplates) */
export const DIVIDERS = BENCHES.map((b) => b.divider);

/* ------------------------------------------------------------------ *
 * Main Agent console (under the front glass wall, left of centre, centred in "the area other than the pantry")
 *
 * It takes no workstation and belongs to no meeting room; it is the main session (Craft Agent)'s own spot.
 * A larger gy is closer to the camera, so ordering outward from the camera: glass curtain wall (13) → silhouette (12.62) → console (11.55~12.4).
 * The silhouette has its back to the glass wall and faces all the workstations; the console and the floating screen are both in front of it (on the room side),
 * so when it looks up it is both watching the screen and watching the whole floor's workstations.
 * Horizontal centre x ≈ 7.1: on the right x ≥ 14.6 is the meeting room / pantry (right edge at x = 20, see MEETING.x); the console avoids them
 * and sits toward the front of the open work area, facing the middle column of workstations from the camera's view.
 * ------------------------------------------------------------------ */

export const CONSOLE = {
  /** Console body: low cabinet + countertop, dark low-poly */
  desk: { x: 5.0, y: 11.55, w: 4.2, d: 0.85, h: 0.95 },
  /**
   * Floating screen: stuck to a vertical plane of constant gy (facing +gy = facing the camera, so its content is visible).
   * z0/z1 are the top and bottom edges; the countertop starts at 0.95, leaving a gap to the screen's bottom so it looks like it floats.
   * The other reason the bottom edge cannot be too low: the top rail of the nearby glass curtain wall (z 2.69~2.8, drawn last) projects onto
   * the screen plane (1.0 from the wall) and would cover a strip at z 1.69~1.8 —— any lower and the bottom edge of the phase text gets
   * cut by that glass top edge (phase text bottom ≈ screen top − 0.77·screen height, ≈1.82 after raising, just clearing 1.8).
   */
  // x was 5.25 (center 7.1, same centre as desk/posts); in practice the screen face looked left, so shift right 0.2 to centre the screen on the base
  screen: { x: 5.45, y: 12.0, w: 3.7, z0: 1.49, z1: 2.59 },
  /** The two light pillars holding the screen (gx positions) */
  posts: [5.6, 8.6],
  /** Where the silhouette sits (foot position): between the console and the glass wall */
  seat: { x: 7.1, y: 12.62 },
  /** Origin of the dispatch beam (midpoint of the console face toward the room) */
  beam: { x: 7.1, y: 11.5 },
};

/* ------------------------------------------------------------------ *
 * Meeting room (upper right, glass room)
 * Shares x / w with the pantry: the two interlock vertically and exactly fill the right side's gy 0.35 ~ 12.5
 * ------------------------------------------------------------------ */

export const MEETING = {
  // Right-side block (meeting room + pantry) left edge 14.6: width 5.4 → right edge exactly 20 = ROOM.w.
  // 2026-09-30 user measurement: the old 14.2 (right edge 19.6) was 0.4 short of the room's right edge —— the pantry's north-wall glass
  // did not reach the end on the right, so the whole block shifted right 0.4 to line it up (furniture / doors / nav nodes in the block moved with it, relative layout unchanged).
  x: 14.6,
  y: 0.35,
  w: 5.4,
  d: 6.8,
  /** Glass: the door is cut in the middle of the side (west face); the south face is one full strip (also serving as the pantry's north wall) */
  glass: {
    /** Doorway at y 3.6 ~ 5.0 */
    westA: { x: 14.6, y: 0.35, w: 0.1, d: 3.25 },
    westB: { x: 14.6, y: 5.0, w: 0.1, d: 2.15 },
    south: { x: 14.6, y: 7.15, w: 5.4, d: 0.1 },
    h: 2.3,
  },
  table: { x: 16.1, y: 3.0, w: 3.2, d: 1.7, h: 0.74 },
  /** 8 chairs: the front 4 on the desk's north side, the back 4 on the south side */
  chairs: [
    { x: 16.4, y: 2.55 },
    { x: 17.3, y: 2.55 },
    { x: 18.2, y: 2.55 },
    { x: 19.1, y: 2.55 },
    { x: 16.4, y: 5.15 },
    { x: 17.3, y: 5.15 },
    { x: 18.2, y: 5.15 },
    { x: 19.1, y: 5.15 },
  ],
  /** Copier: north-west corner, tight against the rear solid wall; chunky (short and wide looks like an all-in-one, tall and thin turns into a filing cabinet) */
  printer: { x: 14.6, y: 0.35, w: 0.9, d: 0.6, h: 0.95 },
  /** Whiteboard against the inside of the back wall (widened along with the room) */
  whiteboard: { x0: 15.4, x1: 19.4, z0: 0.95, z1: 1.95 },
};

/** Seat points of the meeting room (= chair positions) */
export const MEETING_SEATS = MEETING.chairs.map((c) => ({ ...c }));

/* ------------------------------------------------------------------ *
 * Pantry (the room in front of the meeting room, glass partition)
 * ------------------------------------------------------------------ */

/** Borrows the meeting room's south wall on the north side and sits directly against the room's front glass curtain wall on the south side, so nothing extra is built */
export const PANTRY = {
  x: 14.6,
  y: 7.25,
  w: 5.4,
  d: 5.75,
  glass: {
    /** Door cut in the middle of the west face, doorway at y 9.15 ~ 10.35 */
    westA: { x: 14.6, y: 7.25, w: 0.1, d: 1.9 },
    westB: { x: 14.6, y: 10.35, w: 0.1, d: 2.65 },
    h: 2.3,
  },
  /** Water cooler (against the north wall, so you can get water right after entering) */
  cooler: { x: 15.3, y: 7.95, r: 0.3, h: 1.35 },
  /** Dining table */
  table: { x: 16.7, y: 9.6, w: 2.6, d: 1.2, h: 0.74 },
  /**
   * Magazine rack: against the pantry's **north wall east segment** (= the meeting room's south glass), covers facing +gy straight at the camera.
   *
   * Why this orientation is required (the first version sat on the west wall and looked wrong):
   *   · covers facing +gy with the rack body running along x → the row of covers **does not occlude itself**, and the camera sees at a glance "this is a stack of magazines";
   *   · placed against the west wall (body along y) the magazines queue along y, each hiding the one before, leaving only a few narrow slits that look like coloured slats.
   * Why the **east end** of the north wall: this wall is drawn as glass segments with keys increasing in x, and at the east end the rack's natural
   * depth (≈27.4 = depthOf(19.6, 7.77)) is already greater than every segment's (max ≈27.3 = depthOf(20, 7.25)),
   * so no manual key lifting is needed like the water cooler.
   * tiers = number of shelves; lean = how much higher a shelf's back edge is than its front edge (slanted shelves, so the covers tilt slightly upward).
   * d is the "depth poking out of the wall": 0.42 (≈42cm) —— the rack is a thin affair; the earlier 0.6 looked like a small cabinet.
   */
  rack: { x: 18.1, y: 7.35, w: 1.5, d: 0.42, h: 1.45, tiers: 3, lean: 0.12 },
  /** 6 chairs: three on each side of the dining table */
  chairs: [
    { x: 17.0, y: 9.15 },
    { x: 17.9, y: 9.15 },
    { x: 18.8, y: 9.15 },
    { x: 17.0, y: 11.25 },
    { x: 17.9, y: 11.25 },
    { x: 18.8, y: 11.25 },
  ],
};

/* ------------------------------------------------------------------ *
 * Plants
 * ------------------------------------------------------------------ */

/** Plants: along the back wall's base under the three windows (pot rims almost touching the wall), spaced apart */
export const PLANTS = [
  { x: 2.7, y: 0.33, s: 1 },
  { x: 6.0, y: 0.36, s: 0.95 },
  { x: 7.4, y: 0.32, s: 1.05 },
  { x: 10.7, y: 0.35, s: 1.1 },
];

/** Places the sprites go to */
export const PLACES = {
  /** Coffee: into the pantry, standing in front of the water cooler */
  coffee: { x: 15.4, y: 8.55 },
  /** Printing: into the meeting room, standing east of the copier (the machine is against the back wall, leaving standing space to the east) */
  printer: { x: 15.7, y: 0.6 },
  /** Entering / leaving: the main door in the left wall, standing one step inside it (x 0.9 from the wall, so it does not hug the surface) */
  door: { x: 0.9, y: 8.9 },
  /**
   * Outside the door: half a step further out from the doorway (gx < 0 = the small corridor outside the wall).
   * The gremlin starts here and walks into the doorway —— the door is only pushed open at this moment (see stepDoor in engine),
   * so it reads as "the door opened and someone came in" rather than popping into existence at the door.
   * Do not move it further out: the smaller gx is, the further up-left it runs on screen, until the wall hides every last bit of it (see the clipping in doorwayPath).
   */
  doorOut: { x: -0.6, y: 8.9 },
};

/* ------------------------------------------------------------------ *
 * Nav graph: sprites only walk between nodes, never through desks
 * ------------------------------------------------------------------ */

const N = {
  /* Three horizontal aisles (y aligned with the workstation geometry in officeMap):
     rear aisle 1.5 ｜ mid aisle 6.1 (between group 1's south seats 5.44 and group 2's north seats 6.75)
     ｜ front aisle 10.55 (south of group 2's south seats 9.59). */
  B06: { x: 0.6, y: 1.5 },
  B20: { x: 2.0, y: 1.5 },
  B64: { x: 6.4, y: 1.5 },
  B108: { x: 10.8, y: 1.5 },
  B134: { x: 13.4, y: 1.5 },

  M06: { x: 0.6, y: 6.1 },
  M20: { x: 2.0, y: 6.1 },
  M64: { x: 6.4, y: 6.1 },
  M108: { x: 10.8, y: 6.1 },
  M134: { x: 13.4, y: 6.1 },

  F06: { x: 0.6, y: 10.55 },
  F20: { x: 2.0, y: 10.55 },
  F64: { x: 6.4, y: 10.55 },
  /** Point on the front aisle straight in front of the console (console centre x≈7.1) */
  F91: { x: 7.1, y: 10.55 },
  F108: { x: 10.8, y: 10.55 },
  F134: { x: 13.4, y: 10.55 },

  DOOR: PLACES.door,
  COFFEE: PLACES.coffee,
  PRINT: PLACES.printer,

  /**
   * Workstation access: a face-to-face double desk's chairs are on the **outer edge of each side**, so the people on each side
   * walk straight in from their own side's aisle —— no need for the old layout's turning point "winding in through the divider gap".
   * There is a row of chairs on each side of the mid aisle (group 1's south side / group 2's north side), and they share the mid aisle nodes.
   */
  /**
   * Standing spot to the right of the main Agent (console): the gremlin walks here when summoned / for a wrap-up report.
   *
   * **It must stand to the right of the console, not directly in front of it.** In the isometric projection a larger gy is closer to the camera,
   * the console cabinet occupies gy 11.55~12.4 and the floating screen is at gy 12.0 —— the point directly in front (x 7.1 / y 11.3)
   * is actually **behind** the cabinet and screen (smaller gy, smaller depth), and the gremlin standing there has most of its body
   * blocked by the desk and the floating screen (2026-10-01 user measurement).
   * Moved to 0.9 cells east of the cabinet's right edge (9.2) → x 10.1: in screen space the person lands to the right of the console,
   * the body just clears the cabinet's easternmost projected point (-89.5px, person's left edge about -87px), and depth 21.9 is
   * also greater than the floating screen's 19.6, so it is no longer pressed down; the final segment slanting in from nav node F108 is still right of the cabinet
   * (at gy=11.55, x≈10.24 > 9.2).
   */
  CFRONT: { x: 10.1, y: 11.8 },

  /** Meeting room: door on the side (west wall) → inside the door → the two north / south inner corridors on the west side */
  MDOOR_OUT: { x: 13.6, y: 4.3 },
  MDOOR_IN: { x: 15.3, y: 4.3 },
  MSIDE_A: { x: 15.2, y: 5.9 },
  MSIDE_B: { x: 15.2, y: 2.3 },

  /** Pantry: door in the west wall → inside the door → in front of the water cooler */
  PDOOR_OUT: { x: 13.6, y: 9.75 },
  PDOOR_IN: { x: 15.2, y: 9.75 },
};

DESK_UNITS.forEach((d, i) => {
  N[`SEAT_${d.id}`] = { ...d.seat };
});
MEETING_SEATS.forEach((s, i) => {
  N[`MSEAT_${i}`] = { ...s };
});

const EDGES = [
  // three horizontal aisles
  ['B06', 'B20'], ['B20', 'B64'], ['B64', 'B108'], ['B108', 'B134'],
  ['M06', 'M20'], ['M20', 'M64'], ['M64', 'M108'], ['M108', 'M134'],
  ['F06', 'F20'], ['F20', 'F64'], ['F64', 'F91'], ['F91', 'F108'], ['F108', 'F134'],
  // vertical connections on both sides
  ['B06', 'M06'], ['M06', 'F06'],
  ['B134', 'M134'], ['M134', 'F134'],
  // Main door (left wall, left of the clock) → mid / front aisles (both on the west walkway at x<1, not crossing workstations)
  ['M06', 'DOOR'], ['F06', 'DOOR'],
  // Workstations: each side's aisle → seat. A face-to-face double desk's chairs are all on the **outer side**,
  // so the people on each side walk straight in from their own side's aisle (no more turning point "around the divider gap").
  ['B20', 'SEAT_A0'], ['B64', 'SEAT_A1'], ['B108', 'SEAT_A2'],
  ['M20', 'SEAT_B0'], ['M64', 'SEAT_B1'], ['M108', 'SEAT_B2'],
  ['M20', 'SEAT_A3'], ['M64', 'SEAT_A4'], ['M108', 'SEAT_A5'],
  ['F20', 'SEAT_B3'], ['F64', 'SEAT_B4'], ['F108', 'SEAT_B5'],
  // In front of the main Agent: the front aisle's **east segment** (F108) → the standing spot to the right of the console.
  // Do not connect F91 (the point directly in front of the console): F91 is on the centre line, and slanting to the right-hand spot would cut across the cabinet
  // (at gy=11.55 it only reaches x≈9.03 < the cabinet's right edge 9.2), so the gremlin would look like it emerges from inside the desk.
  // Connected to F108, the final segment stays right of the cabinet the whole way (at gy=11.55, x≈10.24), so the person comes round the console's right side.
  ['F108', 'CFRONT'],
  // Copier in the meeting room's north-west corner: inside the door → north inner corridor (MSIDE_B) → in front of the machine
  ['MSIDE_B', 'PRINT'],
  // Pantry: right-side aisle → side door → inside the door → water in front of the cooler
  ['M134', 'PDOOR_OUT'], ['F134', 'PDOOR_OUT'], ['PDOOR_OUT', 'PDOOR_IN'], ['PDOOR_IN', 'COFFEE'],
  // Meeting room: right-side aisle → outside the side door → inside the door → round the west inner corridor to the north / south sides of the table (8 seats)
  ['B134', 'MDOOR_OUT'], ['M134', 'MDOOR_OUT'], ['MDOOR_OUT', 'MDOOR_IN'],
  ['MDOOR_IN', 'MSIDE_A'], ['MDOOR_IN', 'MSIDE_B'],
  ['MSIDE_B', 'MSEAT_0'], ['MSIDE_B', 'MSEAT_1'], ['MSIDE_B', 'MSEAT_2'], ['MSIDE_B', 'MSEAT_3'],
  ['MSIDE_A', 'MSEAT_4'], ['MSIDE_A', 'MSEAT_5'], ['MSIDE_A', 'MSEAT_6'], ['MSIDE_A', 'MSEAT_7'],
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

/** Debug: all nav nodes (drawing them shows whether the routes make sense) */
export const NAV_NODES = Object.values(N);

/**
 * Landing point of the summon choreography: right of the main Agent (console), same coordinates as nav node CFRONT.
 * The nearest node is F108 (front aisle east segment); the final segment slants in from F108 across the open floor right of the cabinet,
 * never through a desk; once settled its depth (21.9) is greater than the floating screen's (19.6), so it is no longer hidden by the screen.
 */
export const CONSOLE_FRONT = { x: 10.1, y: 11.8 };

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
 * Plan a path: walk from any point to any point, returning the array of waypoints (including the exact start and end).
 * First snap to the nearest nav nodes and run BFS, then append the real start/end coordinates to avoid teleporting.
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
