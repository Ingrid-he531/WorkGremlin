/**
 * Task records' "time filter" —— turn a preset (today / yesterday / past 7 days / this month / custom …) into a time window.
 *
 * Why a separate pure layer: this is all **boundaries**, and boundaries can only be tested with fixed instants ——
 * crossing midnight, whether "past 7 days" includes today, month-end (what date is one month before Jan 31), the day of daylight saving
 * and exactly how many hours it shifts. Same reason as lib/dayBoard.js: SFCs mix in DOM and polling, so you can't test them.
 *
 * Definition (aligned with requirements.md §P0-6 "never fabricate"):
 *   · it filters on the task's **start time** (started_at), half-open `[from, to)`.
 *   · dates are always added/subtracted by **calendar day** (setDate goes through the calendar), not by raw milliseconds —— crossing daylight saving won't be off by an hour.
 *   · a null on either end means "no limit on that end" (all time / only one side of custom filled in).
 *   · unreadable input (empty string, malformed date, non-finite timestamp) always counts as "no limit" or "no match",
 *     never substituting a value like "now".
 */

import { dayStartOf } from './dayBoard.js';

/** The presets in the dropdown (order = display order). key maps one-to-one to the branches of timeWindowOf */
export const TIME_RANGES = [
  { key: 'all', label: '全部时间' },
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'd7', label: '过去 7 天' },
  { key: 'd30', label: '过去 30 天' },
  { key: 'thisMonth', label: '这个月' },
  { key: 'lastMonth', label: '上个月' },
  { key: 'custom', label: '自定义' },
];

/** From the day an instant falls in, shift n calendar days forward / backward and return that day's local 00:00 timestamp */
export function shiftDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `YYYY-MM-DD` (the value of <input type="date">) → that day's local 00:00 timestamp; empty / malformed → null */
export function dayValueToTs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setHours(0, 0, 0, 0);
  const ts = d.getTime();
  return Number.isFinite(ts) ? ts : null;
}

/**
 * The time window `{from, to}` for the current preset (half-open; null = no limit on that end).
 *
 * "Past 7 / 30 days" **includes today**: count 7 (30) calendar days back from today. Without today, a
 * task that just ran today would be filtered out by itself, looking broken —— the usual meaning in this kind of UI is to include today.
 * "This month / last month" takes **the 1st of the next month 00:00** as the right end (not "now"): a task dated
 * tomorrow on a machine with a fast clock shouldn't be cut off by "this month" either.
 * The two days selected under "custom" **count as whole days** (right end +1 day becomes half-open); filling only one side = open on that side.
 *
 * @param {string} key the preset (a TIME_RANGES key); unrecognized → no limit
 * @param {number} now the current instant (ms)
 * @param {string} [fromStr] the custom left end `YYYY-MM-DD`
 * @param {string} [toStr] the custom right end `YYYY-MM-DD`
 */
export function timeWindowOf(key, now, fromStr = '', toStr = '') {
  const at = Number(now);
  const t = Number.isFinite(at) && at > 0 ? at : Date.now();
  const today = dayStartOf(t);
  if (key === 'today') return { from: today, to: shiftDays(today, 1) };
  if (key === 'yesterday') return { from: shiftDays(today, -1), to: today };
  if (key === 'd7') return { from: shiftDays(today, -6), to: shiftDays(today, 1) };
  if (key === 'd30') return { from: shiftDays(today, -29), to: shiftDays(today, 1) };
  if (key === 'thisMonth' || key === 'lastMonth') {
    const d = new Date(t);
    const y = d.getFullYear();
    const m = d.getMonth();
    const thisFirst = new Date(y, m, 1).getTime();
    return key === 'thisMonth'
      ? { from: thisFirst, to: new Date(y, m + 1, 1).getTime() }
      : { from: new Date(y, m - 1, 1).getTime(), to: thisFirst };
  }
  if (key === 'custom') {
    const from = dayValueToTs(fromStr);
    const to = dayValueToTs(toStr);
    return { from, to: to == null ? null : shiftDays(to, 1) };
  }
  return { from: null, to: null };
}

/**
 * Whether an instant falls in the time window.
 * @param {number} at the task's start time (started_at)
 * @param {{from: number|null, to: number|null}} win
 * @returns {boolean} unreadable start time (old data / null) → **only "all time" lets it through**:
 *   a task that fits into no day shouldn't be forced into one preset.
 */
export function inTimeWindow(at, win) {
  const { from, to } = win || {};
  if (from == null && to == null) return true;
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return false;
  if (from != null && t < from) return false;
  if (to != null && t >= to) return false;
  return true;
}

/**
 * Time window → which days the board "can show" (day granularity, both ends inclusive).
 *
 * A graphical board's cell is one day, while the window is a millisecond interval `[from, to)` —— it has to fall back to "which days":
 *   · lower bound = the day of from (the window endpoints already fall on local 00:00)
 *   · upper bound = **the day before to**: to is the open-right boundary and isn't in the window itself (today's window is
 *     [today 00:00, tomorrow 00:00), so only today can be shown)
 * A null on either end = no limit on that end (all time / only one side of custom filled in).
 *
 * A reversed custom range (start later than end) yields an empty range with minDay > maxDay —— truthfully an empty set,
 * don't swap the ends to conjure one up: the list is empty then anyway.
 *
 * @param {{from: number|null, to: number|null}} win
 * @returns {{minDay: number|null, maxDay: number|null}}
 */
export function dayRangeOf(win) {
  const { from, to } = win || {};
  const minDay = from == null ? null : dayStartOf(from);
  const maxDay = to == null ? null : shiftDays(to, -1);
  return { minDay, maxDay };
}

/** Whether the board's current day is in the selectable range (an unbounded end counts as in) */
export function dayInRange(day, range) {
  const { minDay, maxDay } = range || {};
  const t = Number(day);
  if (!Number.isFinite(t) || t <= 0) return false;
  if (minDay != null && t < minDay) return false;
  if (maxDay != null && t > maxDay) return false;
  return true;
}

/**
 * Clamp a day into the selectable range; returns it unchanged if it's already in.
 *
 * When out of range, **move to the nearest end** rather than staying put: after changing the filter (say from "all time" to "today")
 * the day it was parked on may already be outside the window, and drawing it anyway is just blank —— looking broken.
 */
export function clampDay(day, range) {
  const { minDay, maxDay } = range || {};
  const n = Number(day);
  const t = dayStartOf(Number.isFinite(n) && n > 0 ? n : Date.now());
  if (minDay != null && t < minDay) return minDay;
  if (maxDay != null && t > maxDay) return maxDay;
  return t;
}
