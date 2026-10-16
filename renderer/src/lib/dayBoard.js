/**
 * Pure computation for the "daily board": lay tasks out as a **floor × time** Gantt chart.
 *
 * One chart per day:
 *   x-axis = the day's 00:00–24:00, one vertical line per hour (ticks labeled 09:00 / 10:00 …);
 *   y-axis = **floor** (one row per floor, e.g. "3F Codex");
 *   the solid block in each row = one task of that floor, the two vertical edges separate adjacent tasks (visually "splitting tasks with vertical lines").
 * **One row per floor, always**: when several rounds run in parallel on the same floor at the same time, don't stack swimlanes, instead **darken** the overlapping span
 * (see overlapSpans, the UI uses it to lay down a dark overlay) —— the row count stays stable and you can still see at a glance that "two or three ran here at once".
 *
 * Definition (consistent with the other views of the task-records page: only real values from the DB, nothing fabricated):
 *   · missing started_at → can't enter the chart, counted separately (untimed), written out truthfully by the UI;
 *   · has ended_at → use it;
 *   · no ended_at and state === 'running' → draw up to "now";
 *   · no ended_at but already finished (often the case for cancel / failure) → occupies only **the instant it started** (a point),
 *     don't invent an end time for it.
 * Everything is computed in the local milliseconds passed in, with no timezone / UTC conversion (the caller passes local 00:00).
 */
// Write /index.js explicitly: renderer/test node scripts import this file directly, and Node won't add the extension.
// Alias it as tr: the loop variable in buildFloorGantt below is called t (one task), so the names must not collide.
import { t as tr } from '../i18n/index.js';

export const MIN_PER_DAY = 24 * 60;
/** Number of hours on the x-axis (one vertical line per hour) */
export const HOUR_COLS = 24;

/** 00:00 of the day an instant falls in, in the local timezone */
export function dayStartOf(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Minutes in a day (0 → "00:00", 1440 → "24:00") — used by the ticks and the "active span" text */
export function fmtHM(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * A task's time span; returns null when the start time is unavailable (nothing fabricated).
 * @param {{started_at?:number|null, ended_at?:number|null, state?:string}} t
 * @param {number} now the current instant (local ms): only used to decide how far to draw a task that is "still running"
 * @returns {{s:number,e:number}|null}
 */
export function spanOf(t, now) {
  const s = Number(t && t.started_at) || 0;
  if (!s) return null;
  let e = Number(t && t.ended_at) || 0;
  if (!e) e = t.state === 'running' ? now : s;
  return { s, e: Math.max(e, s) };
}

/**
 * Time-overlapping spans within one row (coverage count ≥ 2): the UI uses it to **darken** the overlap instead of letting that floor take another row.
 * Endpoints are handled as "finish first, then start" —— A's end exactly equal to B's start counts as **adjacent**, not overlapping.
 * @param {Array<{s:number,e:number}>} items task spans in the same row (same floor)
 * @returns {Array<{s:number,e:number,count:number}>} ascending by time; count = how many run at once in this span
 */
export function overlapSpans(items) {
  const evts = [];
  for (const it of items || []) {
    evts.push({ t: it.s, d: 1 }, { t: it.e, d: -1 });
  }
  // At the same instant, -1 (finish) comes before +1 (start): two tasks that touch end-to-start aren't counted as overlapping
  evts.sort((a, b) => a.t - b.t || a.d - b.d);
  const segs = [];
  let cur = 0;
  let start = 0;
  for (const ev of evts) {
    if (cur >= 2 && ev.t > start) segs.push({ s: start, e: ev.t, count: cur });
    cur += ev.d;
    start = ev.t;
  }
  // Merge adjacent spans with the same coverage count into one (so the UI doesn't lay down a string of equal dark slices)
  const out = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (last && last.e === seg.s && last.count === seg.count) last.e = seg.e;
    else out.push({ ...seg });
  }
  return out;
}

/**
 * Build the Gantt rows.
 * @param {Array<object>} tasks already-filtered tasks (the same list as the list view)
 * @param {number} dayStart local 00:00 of the day
 * @param {number} now the current instant
 * @param {(t:object)=>{key:string,label:string,order:number}|null} resolveFloor task → its floor
 *        (the mapping table lives in the UI layer: client → floor, see TaskRecordsView's rowOfTask)
 * @param {Array<{key:string,label:string,order:number}>} [baseRows] rows to draw even if there is no task this day
 *        (when the UI's "filter = all floors" it passes in **every installed floor** —— an empty floor keeps a blank row,
 *        so you can see at a glance that "this floor did nothing today" instead of the whole row disappearing)
 * @returns {{
 *   rows: Array<{key:string,label:string,order:number,
 *     items:Array<{task:object, left:number, width:number, startMin:number, endMin:number}>,
 *     overlaps:Array<{left:number, width:number, count:number}>}>,
 *   total:number, untimed:number, firstMin:number, lastMin:number
 * }} left/width are **percentages of the whole day** (0–100), the UI uses them directly for positioning; firstMin/lastMin are
 *    "the earliest / latest minute with a task this day", -1 when there is no task.
 */
export function buildFloorGantt(tasks, dayStart, now, resolveFloor, baseRows = []) {
  const dayMs = MIN_PER_DAY * 60 * 1000;
  const dayEnd = dayStart + dayMs;
  const groups = new Map();
  // First build the floors that "take a row but may have no tasks": later tasks drop into these rows, no extra row appears
  for (const r of baseRows || []) {
    if (!r || !r.key || groups.has(r.key)) continue;
    groups.set(r.key, {
      key: r.key,
      label: r.label,
      order: Number.isFinite(r.order) ? r.order : 900,
      items: [],
      overlaps: [],
    });
  }
  let total = 0;
  let untimed = 0;
  let firstMin = -1;
  let lastMin = -1;

  for (const t of tasks || []) {
    const sp = spanOf(t, now);
    if (!sp) {
      untimed += 1;
      continue;
    }
    /**
     * Zero length (only the start time is known) is treated as "a point at that instant": give it a 1ms width before assigning it,
     * otherwise one sitting exactly at 00:00 would be misjudged by `e <= dayStart` as "doesn't touch this day" and vanish entirely.
     */
    const e = sp.e > sp.s ? sp.e : sp.s + 1;
    if (e <= dayStart || sp.s >= dayEnd) continue; // doesn't touch this day

    const f = (resolveFloor && resolveFloor(t)) || { key: '__none__', label: tr('records.no_floor'), order: 999 };
    let g = groups.get(f.key);
    if (!g) {
      g = { key: f.key, label: f.label, order: Number.isFinite(f.order) ? f.order : 900, items: [], overlaps: [] };
      groups.set(f.key, g);
    }
    const s = Math.max(sp.s, dayStart);
    const ve = Math.min(e, dayEnd);
    const startMin = Math.floor((s - dayStart) / 60000);
    const endMin = Math.ceil((ve - dayStart) / 60000);
    g.items.push({ task: t, s, e: ve, startMin, endMin });
    total += 1;
    if (firstMin < 0 || startMin < firstMin) firstMin = startMin;
    if (endMin > lastMin) lastMin = endMin;
  }

  const rows = [...groups.values()].sort((a, b) => a.order - b.order || String(a.label).localeCompare(String(b.label)));
  for (const row of rows) {
    /**
     * One row per floor, always: the order of blocks only affects "who is on top of whom". Longer drawn first, shorter after ——
     * this way a short task running in parallel isn't fully covered by a long one (the long one still shows at both ends).
     */
    row.items.sort((a, b) => a.s - b.s || b.e - a.e);
    for (const it of row.items) {
      it.left = ((it.s - dayStart) / dayMs) * 100;
      it.width = ((it.e - it.s) / dayMs) * 100;
    }
    // Overlaps: the UI lays a dark layer per this = "more than one at the same time" (instead of taking another row)
    row.overlaps = overlapSpans(row.items).map((o) => ({
      left: ((o.s - dayStart) / dayMs) * 100,
      width: ((o.e - o.s) / dayMs) * 100,
      count: o.count,
    }));
  }

  return { rows, total, untimed, firstMin, lastMin };
}
