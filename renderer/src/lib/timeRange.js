/**
 * 任务记录的「时间筛选」—— 把档位（今天 / 昨天 / 过去 7 天 / 这个月 / 自定义 …）算成一个时间窗。
 *
 * 为什么单独一层纯函数：这里全是**边界**，而边界只有拿固定时刻才测得出来 ——
 * 跨午夜、"过去 7 天"算不算今天、月末（1 月 31 日往前一个月是几号）、夏令时那天
 * 到底差几小时。跟 lib/dayBoard.js 同一个理由：SFC 里混着 DOM 与轮询，测不动。
 *
 * 口径（对齐 requirements.md §P0-6「绝不编造」）：
 *   · 筛的是任务的**开始时刻**（started_at），左闭右开 `[from, to)`。
 *   · 日期一律按**自然日**加减（setDate 走日历），不是拿毫秒硬减 —— 跨夏令时不会差一小时。
 *   · 每一端的 null 表示"这一端不设限"（全部时间 / 自定义只填了一边）。
 *   · 读不出的输入（空串、格式不对的日期、非有限的时间戳）一律当"不设限"或"不命中"，
 *     不拿"现在"之类的值顶上。
 */

import { dayStartOf } from './dayBoard.js';

/** 下拉里的档位（顺序 = 显示顺序）。key 与 timeWindowOf 的分支一一对应 */
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

/** 从某时刻所在的那一天起，往前 / 往后 n 个自然日，返回那天本地 00:00 的时间戳 */
export function shiftDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `YYYY-MM-DD`（<input type="date"> 的值）→ 那一天本地 00:00 的时间戳；空 / 格式不对 → null */
export function dayValueToTs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setHours(0, 0, 0, 0);
  const ts = d.getTime();
  return Number.isFinite(ts) ? ts : null;
}

/**
 * 当前档位对应的时间窗 `{from, to}`（左闭右开；null = 那一端不设限）。
 *
 * 「过去 7 天 / 30 天」**含今天**：从今天往前数 7（30）个自然日。不含今天的话，今天刚跑的
 * 任务会被自己筛掉，看着像坏了 —— 这类界面里的通常含义就是含今天。
 * 「这个月 / 上个月」的右端取**下月 1 日 00:00**（不是"此刻"）：时钟偏快的机器上落了个
 * 明天日期的任务，也不该被"这个月"切掉。
 * 「自定义」选中的那两天**整天都算**（右端 +1 天变右开）；只填一边 = 单边开放。
 *
 * @param {string} key 档位（TIME_RANGES 的 key）；认不出 → 不设限
 * @param {number} now 当前时刻（毫秒）
 * @param {string} [fromStr] 自定义的左端 `YYYY-MM-DD`
 * @param {string} [toStr] 自定义的右端 `YYYY-MM-DD`
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
 * 某个时刻落在时间窗里吗。
 * @param {number} at 任务的开始时刻（started_at）
 * @param {{from: number|null, to: number|null}} win
 * @returns {boolean} 开始时刻读不出（老数据 / null）→ **只有"全部时间"才放行**：
 *   归不进任何一天的任务，不该硬塞进某一档。
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
 * 时间窗 → 看板「能看哪几天」（按天粒度，两端都含）。
 *
 * 图形看板一格就是一天，而窗口是毫秒区间的 `[from, to)` —— 得落回"哪几天"：
 *   · 下界 = from 那天（窗口端点本来就落在本地 00:00）
 *   · 上界 = **to 的前一天**：to 是右开边界、本身不在窗内（今天的窗口是
 *     [今天 00:00, 明天 00:00)，能看的就只有今天）
 * 某一端为 null = 那一端不设限（全部时间 / 自定义只填了一边）。
 *
 * 反着的自定义区间（起始晚于结束）会得到 minDay > maxDay 的空区间 —— 如实是个空集，
 * 不交换两端凑一个出来：那时候列表本来也是空的。
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

/** 看板当前这天在可选区间里吗（区间那一端不设限就算在） */
export function dayInRange(day, range) {
  const { minDay, maxDay } = range || {};
  const t = Number(day);
  if (!Number.isFinite(t) || t <= 0) return false;
  if (minDay != null && t < minDay) return false;
  if (maxDay != null && t > maxDay) return false;
  return true;
}

/**
 * 把某天夹进可选区间；已经在里面就原样返回。
 *
 * 越界时**挪到最近的那一端**，而不是保持不动：换了筛选条件（比如从"全部时间"切到"今天"）
 * 以后，原来停在的那天可能已经不在窗内了，硬画出来就是一片空白 —— 看着像坏了。
 */
export function clampDay(day, range) {
  const { minDay, maxDay } = range || {};
  const n = Number(day);
  const t = dayStartOf(Number.isFinite(n) && n > 0 ? n : Date.now());
  if (minDay != null && t < minDay) return minDay;
  if (maxDay != null && t > maxDay) return maxDay;
  return t;
}
