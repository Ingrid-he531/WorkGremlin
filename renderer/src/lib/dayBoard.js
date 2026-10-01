/**
 * 「每日看板」的纯计算：把任务铺成**楼层 × 时间**的甘特图。
 *
 * 一天一张图：
 *   横轴 = 当天 00:00–24:00，每小时一条竖线（刻度写 09:00 / 10:00 …）；
 *   纵轴 = **楼层**（一层一行，如「3F Codex」）；
 *   每行里的实心块 = 这一层的一次任务，左右两条竖边把相邻任务切开（看着就是"用竖线分割任务"）。
 * **一层恒定一行**：同一层同一时刻并行好几轮时不再往下摞泳道，而是把重叠的那一段**加深**
 * （见 overlapSpans，界面拿它铺一层暗色）—— 行数稳、一眼还是能看出"这里同时跑了两三条"。
 *
 * 口径（与任务记录页其它视图一致：只认库里的真值，不编造）：
 *   · started_at 缺 → 进不了图，单独计数（untimed），由界面如实写出来；
 *   · 有 ended_at → 用它；
 *   · 没 ended_at 且 state === 'running' → 画到"此刻"（now）；
 *   · 没 ended_at 但已经收工（取消 / 失败时常这样）→ 只占**开始那一瞬间**（一个点），
 *     不替它编一个结束时刻。
 * 时间一律按传入的本地毫秒算，没有时区 / UTC 换算（调用方给本地 00:00）。
 */

export const MIN_PER_DAY = 24 * 60;
/** 横轴的小时数（每小时一条竖线） */
export const HOUR_COLS = 24;

/** 本地时区里某时刻所在那天的 00:00 */
export function dayStartOf(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 一天的分钟数（0 → "00:00"，1440 → "24:00"）— 刻度与"活跃时段"文案用它 */
export function fmtHM(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * 一条任务的时间区间；拿不到开始时间的返回 null（不编造）。
 * @param {{started_at?:number|null, ended_at?:number|null, state?:string}} t
 * @param {number} now 此刻（本地毫秒）：只用来决定"还在跑"的任务画到哪
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
 * 一行里时间重叠的段（覆盖数 ≥ 2）：界面拿它把重叠处**加深**，而不是让这一层再占一行。
 * 端点按"先收工、再开工"处理 —— A 的结束正好等于 B 的开始算**相接**，不算重叠。
 * @param {Array<{s:number,e:number}>} items 同一行（同一楼层）里的任务区间
 * @returns {Array<{s:number,e:number,count:number}>} 按时间升序；count = 这一段里同时有几条
 */
export function overlapSpans(items) {
  const evts = [];
  for (const it of items || []) {
    evts.push({ t: it.s, d: 1 }, { t: it.e, d: -1 });
  }
  // 同一时刻先 -1（收工）后 +1（开工）：首尾相接的两条不会被算成重叠
  evts.sort((a, b) => a.t - b.t || a.d - b.d);
  const segs = [];
  let cur = 0;
  let start = 0;
  for (const ev of evts) {
    if (cur >= 2 && ev.t > start) segs.push({ s: start, e: ev.t, count: cur });
    cur += ev.d;
    start = ev.t;
  }
  // 相邻且覆盖数相同的段并成一段（省得界面上铺一串等长的暗片）
  const out = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (last && last.e === seg.s && last.count === seg.count) last.e = seg.e;
    else out.push({ ...seg });
  }
  return out;
}

/**
 * 铺甘特行。
 * @param {Array<object>} tasks 已经过筛选的任务（与列表视图同一份 list）
 * @param {number} dayStart 当天本地 00:00
 * @param {number} now 此刻
 * @param {(t:object)=>{key:string,label:string,order:number}|null} resolveFloor 任务 → 所属楼层
 *        （关联表在界面层：client → 楼层，见 TaskRecordsView 的 rowOfTask）
 * @param {Array<{key:string,label:string,order:number}>} [baseRows] 就算这一天没有任务也要画出来的行
 *        （界面在"筛选 = 全部楼层"时把**已安装的全部楼层**传进来 —— 空楼层留一行空格子，
 *        好一眼看出"这层今天没干活"，而不是那一层整行消失）
 * @returns {{
 *   rows: Array<{key:string,label:string,order:number,
 *     items:Array<{task:object, left:number, width:number, startMin:number, endMin:number}>,
 *     overlaps:Array<{left:number, width:number, count:number}>}>,
 *   total:number, untimed:number, firstMin:number, lastMin:number
 * }} left/width 是**占整天的百分比**（0–100），界面直接拿去定位；firstMin/lastMin 是
 *    "这一天有任务的最早 / 最晚分钟"，没有任务时为 -1。
 */
export function buildFloorGantt(tasks, dayStart, now, resolveFloor, baseRows = []) {
  const dayMs = MIN_PER_DAY * 60 * 1000;
  const dayEnd = dayStart + dayMs;
  const groups = new Map();
  // 先把"占了行但可能没任务"的楼层建好：后面有任务落进来就往这些行上补块，不会多出一行
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
     * 零长度（只知道开始时间）当成"那一刻的一个点"：给它 1 毫秒的宽度再判归属，
     * 否则正好卡在 00:00 的那条会被 `e <= dayStart` 误判成"没碰上这一天"而整条消失。
     */
    const e = sp.e > sp.s ? sp.e : sp.s + 1;
    if (e <= dayStart || sp.s >= dayEnd) continue; // 这一天没碰上

    const f = (resolveFloor && resolveFloor(t)) || { key: '__none__', label: '未记录楼层', order: 999 };
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
     * 一层恒定一行：块的先后只影响"谁盖在谁上面"。长的先画、短的后画 ——
     * 同一时刻并行的短任务才不会被长的整条盖住（长的那条仍能从两端露出来）。
     */
    row.items.sort((a, b) => a.s - b.s || b.e - a.e);
    for (const it of row.items) {
      it.left = ((it.s - dayStart) / dayMs) * 100;
      it.width = ((it.e - it.s) / dayMs) * 100;
    }
    // 重叠处：界面照这个铺一层暗色 = "同一时间有不止一条"（而不是再占一行）
    row.overlaps = overlapSpans(row.items).map((o) => ({
      left: ((o.s - dayStart) / dayMs) * 100,
      width: ((o.e - o.s) / dayMs) * 100,
      count: o.count,
    }));
  }

  return { rows, total, untimed, firstMin, lastMin };
}
