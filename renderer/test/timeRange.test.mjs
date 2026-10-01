/**
 * 「任务记录 · 时间筛选」的口径自检（lib/timeRange.js）。
 *
 * 这一层全是**边界**：跨午夜、「过去 7 天」含不含今天、月末往前推一个月是几号、跨年、
 * 自定义区间两端的开闭、以及"开始时刻读不出的老数据"该不该被某一档收进来。
 * 每条都拿**固定时刻**（2026-10-01 15:30 本地）算，跟机器现在的日期无关。
 *
 * 跑法：`npm run test:time-range`
 */
const { TIME_RANGES, clampDay, dayInRange, dayRangeOf, dayValueToTs, inTimeWindow, shiftDays, timeWindowOf } =
  await import('../src/lib/timeRange.js');
const { dayStartOf } = await import('../src/lib/dayBoard.js');

let pass = 0;
let fail = 0;
function ok(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? `  — ${extra}` : ''}`);
  }
}
function head(t) {
  console.log(`\n${t}`);
}

/** 本地时刻（月份从 1 数，跟人说话一样；Date 的月份是从 0 数的） */
const at = (y, m, d, hh = 0, mm = 0, ss = 0) => new Date(y, m - 1, d, hh, mm, ss, 0).getTime();
/** 固定的"此刻"：2026-10-01（周四）15:30 本地 */
const NOW = at(2026, 10, 1, 15, 30);
/** 某档位收不收某个时刻 */
const hit = (key, ts, from = '', to = '') => inTimeWindow(ts, timeWindowOf(key, NOW, from, to));

head('[1] 档位表：八个选项、key 不重复（下拉直接渲染它）');
{
  const keys = TIME_RANGES.map((r) => r.key);
  ok('八个档位', TIME_RANGES.length === 8, String(TIME_RANGES.length));
  ok('key 不重复', new Set(keys).size === keys.length, keys.join(','));
  ok(
    '文案与用户要的一致',
    TIME_RANGES.map((r) => r.label).join('/') === '全部时间/今天/昨天/过去 7 天/过去 30 天/这个月/上个月/自定义',
    TIME_RANGES.map((r) => r.label).join('/')
  );
}

head('[2] 全部时间：两端都不设限，连"开始时刻读不出"的老数据也放行');
{
  const w = timeWindowOf('all', NOW);
  ok('两端都 null', w.from === null && w.to === null, JSON.stringify(w));
  ok('再早的任务也通过', hit('all', at(2020, 1, 1)));
  ok('started_at 为 null 的老数据也通过（这一档不该把它藏起来）', hit('all', null));
  ok('认不出的档位同样不设限（不静默筛掉全部）', JSON.stringify(timeWindowOf('???', NOW)) === JSON.stringify({ from: null, to: null }));
}

head('[3] 今天 / 昨天：自然日，左闭右开');
{
  ok('今天 00:00 命中', hit('today', at(2026, 10, 1, 0, 0, 0)));
  ok('今天 15:30 命中', hit('today', NOW));
  ok('今天 23:59:59 命中', hit('today', at(2026, 10, 1, 23, 59, 59)));
  ok('明天 00:00 不命中（右端是开的）', !hit('today', at(2026, 10, 2, 0, 0, 0)));
  ok('昨天 23:59:59 不命中', !hit('today', at(2026, 9, 30, 23, 59, 59)));

  ok('昨天 00:00 命中', hit('yesterday', at(2026, 9, 30, 0, 0, 0)));
  ok('昨天 23:59:59 命中', hit('yesterday', at(2026, 9, 30, 23, 59, 59)));
  ok('今天 00:00 不命中（昨天到今天就截止）', !hit('yesterday', at(2026, 10, 1, 0, 0, 0)));
  ok('前天不命中', !hit('yesterday', at(2026, 9, 29, 23, 0, 0)));
}

head('[4] 过去 7 天 / 30 天：**含今天**（今天起往前数 7 / 30 个自然日）');
{
  ok('过去 7 天：今天往前第 6 天 00:00 命中（含今天的第 7 天）', hit('d7', at(2026, 9, 25, 0, 0, 0)));
  ok('过去 7 天：再往前一天 23:59 不命中', !hit('d7', at(2026, 9, 24, 23, 59, 59)));
  ok('过去 7 天：今天 23:59 也在里面（含今天）', hit('d7', at(2026, 10, 1, 23, 59, 59)));
  ok('过去 30 天：今天往前第 29 天 00:00 命中', hit('d30', at(2026, 9, 2, 0, 0, 0)));
  ok('过去 30 天：再往前一天不命中', !hit('d30', at(2026, 9, 1, 23, 59, 59)));
  // 「过去 7 天」比「过去 30 天」窄：一档是另一档的真子集
  ok('9 月 20 日的任务：过去 30 天收，过去 7 天不收', hit('d30', at(2026, 9, 20)) && !hit('d7', at(2026, 9, 20)));
}

head('[5] 这个月 / 上个月：自然月，右端取"下月 1 日"（不是"此刻"）');
{
  ok('本月 1 日 00:00 命中', hit('thisMonth', at(2026, 10, 1, 0, 0, 0)));
  ok('本月 31 日 23:00 也命中（右端不是"此刻"，是下月 1 日）', hit('thisMonth', at(2026, 10, 31, 23, 0, 0)));
  ok('上月末（9/30）不命中', !hit('thisMonth', at(2026, 9, 30, 23, 59, 59)));
  ok('下月 1 日 00:00 不命中（右开）', !hit('thisMonth', at(2026, 11, 1, 0, 0, 0)));

  ok('上个月 1 日命中', hit('lastMonth', at(2026, 9, 1, 0, 0, 0)));
  ok('上个月 30 日 23:59 命中', hit('lastMonth', at(2026, 9, 30, 23, 59, 59)));
  ok('本月 1 日 00:00 不命中', !hit('lastMonth', at(2026, 10, 1, 0, 0, 0)));
  ok('8 月底不命中', !hit('lastMonth', at(2026, 8, 31, 23, 59, 59)));
}

head('[6] 跨月跨年：往前推一个月 / 一天要按日历算');
{
  const mar31 = at(2026, 3, 31, 10, 0);
  const w = timeWindowOf('lastMonth', mar31);
  ok(
    '3 月 31 日的"上个月" = 整个 2 月（2/1 00:00 – 3/1 00:00），不是"往前 30 天"',
    w.from === at(2026, 2, 1) && w.to === at(2026, 3, 1),
    JSON.stringify([new Date(w.from), new Date(w.to)])
  );
  const jan15 = at(2026, 1, 15, 9, 0);
  const w2 = timeWindowOf('lastMonth', jan15);
  ok('1 月的"上个月"跨到上一年 12 月', w2.from === at(2025, 12, 1) && w2.to === at(2026, 1, 1), JSON.stringify([new Date(w2.from), new Date(w2.to)]));

  const jan1 = at(2026, 1, 1, 8, 0);
  ok('元旦的"昨天"是上一年 12 月 31 日（不是 1 月 0 日）', timeWindowOf('yesterday', jan1).from === at(2025, 12, 31));
  ok('3 月 1 日的"过去 7 天"含 2 月末那几天', inTimeWindow(at(2026, 2, 23), timeWindowOf('d7', at(2026, 3, 1, 12, 0))));
  ok('shiftDays 跨月：3/1 往前 1 天 = 2/28（2026 不是闰年）', shiftDays(at(2026, 3, 1), -1) === at(2026, 2, 28));
}

head('[7] 自定义：选中的那两天**整天都算**；只填一边就是单边开放');
{
  ok('起止都填：9/12 当天 23:59:59 命中（右端那天整天算）', hit('custom', at(2026, 9, 12, 23, 59, 59), '2026-09-10', '2026-09-12'));
  ok('起止都填：9/10 当天 00:00 命中', hit('custom', at(2026, 9, 10, 0, 0, 0), '2026-09-10', '2026-09-12'));
  ok('起止都填：9/13 00:00 不命中', !hit('custom', at(2026, 9, 13, 0, 0, 0), '2026-09-10', '2026-09-12'));
  ok('起止都填：9/9 23:59 不命中', !hit('custom', at(2026, 9, 9, 23, 59, 59), '2026-09-10', '2026-09-12'));

  ok('只填起始：往后的都算（右端不设限）', hit('custom', at(2027, 1, 1), '2026-09-10', '') && !hit('custom', at(2026, 9, 9), '2026-09-10', ''));
  ok('只填结束：往前的都算（左端不设限）', hit('custom', at(2020, 1, 1), '', '2026-09-12') && !hit('custom', at(2026, 9, 13), '', '2026-09-12'));
  ok('两边都空 = 不设限（等于"全部时间"，不会把列表清空）', JSON.stringify(timeWindowOf('custom', NOW, '', '')) === JSON.stringify({ from: null, to: null }));
  ok('日期格式不对 = 那一端不设限（不猜成"今天"）', JSON.stringify(timeWindowOf('custom', NOW, '2026/09/10', 'yesterday')) === JSON.stringify({ from: null, to: null }));
}

head('[8] 日期解析：只认 <input type="date"> 给的 YYYY-MM-DD');
{
  ok('标准格式 → 那天本地 00:00', dayValueToTs('2026-10-01') === at(2026, 10, 1));
  ok('空串 → null', dayValueToTs('') === null && dayValueToTs(undefined) === null);
  ok('不补零的 2026-9-1 → null（严格，别猜）', dayValueToTs('2026-9-1') === null);
  ok('乱七八糟的字符串 → null', dayValueToTs('今天') === null && dayValueToTs('abc') === null);
}

head('[9] 开始时刻读不出的任务：只有"全部时间"收它，别的档一律不收（不硬塞）');
{
  ok('null 不落进"今天"', !hit('today', null));
  ok('0 不落进"今天"', !hit('today', 0));
  ok('undefined 不落进"过去 30 天"', !hit('d30', undefined));
  ok('字符串时间戳 "abc" 不落进"这个月"', !hit('thisMonth', 'abc'));
  ok('但"全部时间"照收（老数据不该在默认视图里消失）', hit('all', null) && hit('all', 0));
}

head('[10] 看板可选的天：由时间窗落回"哪几天"（右端取 to 的前一天）');
{
  // 某档位对应的"能看哪几天"
  const range = (key, from = '', to = '') => dayRangeOf(timeWindowOf(key, NOW, from, to));

  const rAll = range('all');
  ok('全部时间：两端都不设限（看板跟以前一样自由翻）', rAll.minDay === null && rAll.maxDay === null, JSON.stringify(rAll));
  ok('全部时间：随便哪一天都算在区间里', dayInRange(at(2020, 1, 1), rAll) && dayInRange(at(2030, 5, 5), rAll));

  const rToday = range('today');
  ok('今天：上下界都是今天（就这一天可看）', rToday.minDay === at(2026, 10, 1) && rToday.maxDay === at(2026, 10, 1), JSON.stringify(rToday));
  ok('今天：今天在区间里', dayInRange(at(2026, 10, 1), rToday));
  ok('今天：昨天不在（上界是 to 的前一天，不是 to 那天）', !dayInRange(at(2026, 9, 30), rToday));
  ok('今天：明天不在', !dayInRange(at(2026, 10, 2), rToday));

  const rY = range('yesterday');
  ok('昨天：上界是昨天（窗口 to = 今天 00:00，要退一天）', rY.minDay === at(2026, 9, 30) && rY.maxDay === at(2026, 9, 30), JSON.stringify(rY));

  const r7 = range('d7');
  ok('过去 7 天：含今天，共 7 天（9/25 – 10/1）', r7.minDay === at(2026, 9, 25) && r7.maxDay === at(2026, 10, 1), JSON.stringify(r7));
  ok('过去 7 天：窗口里每一天都能看', [25, 26, 27, 28, 29, 30].every((d) => dayInRange(at(2026, 9, d), r7)) && dayInRange(at(2026, 10, 1), r7));

  const rM = range('thisMonth');
  ok('这个月：10/1 – 10/31（右端是下月 1 日的前一天）', rM.minDay === at(2026, 10, 1) && rM.maxDay === at(2026, 10, 31), JSON.stringify(rM));
  const rL = range('lastMonth');
  ok('上个月：整个 9 月', rL.minDay === at(2026, 9, 1) && rL.maxDay === at(2026, 9, 30), JSON.stringify(rL));

  const rC = range('custom', '2026-09-10', '2026-09-12');
  ok('自定义：选中的那三天都能看（右端那天算整天）', rC.minDay === at(2026, 9, 10) && rC.maxDay === at(2026, 9, 12), JSON.stringify(rC));
  ok('自定义：只填起始 → 上界不设限', dayRangeOf(timeWindowOf('custom', NOW, '2026-09-10', '')).minDay === at(2026, 9, 10) && dayRangeOf(timeWindowOf('custom', NOW, '2026-09-10', '')).maxDay === null);
  ok('自定义：只填结束 → 下界不设限', dayRangeOf(timeWindowOf('custom', NOW, '', '2026-09-12')).minDay === null && dayRangeOf(timeWindowOf('custom', NOW, '', '2026-09-12')).maxDay === at(2026, 9, 12));

  ok(
    '反着的区间（起始晚于结束）= 空集，不交换两端凑一天出来',
    (() => {
      const r = dayRangeOf(timeWindowOf('custom', NOW, '2026-09-12', '2026-09-10'));
      return r.minDay === at(2026, 9, 12) && r.maxDay === at(2026, 9, 10) && r.minDay > r.maxDay;
    })()
  );
}

head('[11] 夹住看板当前这天：越界就挪到最近的那一端');
{
  const rToday = dayRangeOf(timeWindowOf('today', NOW));
  const r7 = dayRangeOf(timeWindowOf('d7', NOW));
  const rAll = dayRangeOf(timeWindowOf('all', NOW));

  ok('在区间里：原样不动（今天）', clampDay(at(2026, 10, 1, 13, 45), rToday) === at(2026, 10, 1));
  ok('带着时分秒进来：归一化到当天 00:00', clampDay(at(2026, 10, 1, 13, 45), rAll) === at(2026, 10, 1));
  ok('早于下界：贴到下界', clampDay(at(2026, 9, 20), r7) === at(2026, 9, 25));
  ok('晚于上界：贴到上界', clampDay(at(2026, 12, 1), r7) === at(2026, 10, 1));
  ok('单日窗口：哪边越界都落回那一天', clampDay(at(2026, 5, 5), rToday) === at(2026, 10, 1) && clampDay(at(2027, 1, 1), rToday) === at(2026, 10, 1));
  ok('全开区间：夹了等于没夹', clampDay(at(2020, 3, 3), rAll) === at(2020, 3, 3));
  ok('这天读不出（0 / NaN）→ 退回今天再夹，不崩', clampDay(0, rAll) === dayStartOf(Date.now()) && Number.isFinite(clampDay(NaN, r7)));

  // 「前一天 / 后一天」按钮该不该灰：挪过去还在区间里才让点
  const canShift = (day, n, r) => {
    const d = new Date(day);
    d.setDate(d.getDate() + n);
    d.setHours(0, 0, 0, 0);
    return dayInRange(d.getTime(), r);
  };
  ok('今天档：前一天、后一天都灰（无处可去）', !canShift(at(2026, 10, 1), -1, rToday) && !canShift(at(2026, 10, 1), 1, rToday));
  ok('过去 7 天：停在今天时"后一天"灰、前一天可点', !canShift(at(2026, 10, 1), 1, r7) && canShift(at(2026, 10, 1), -1, r7));
  ok('过去 7 天：停在下界那天时"前一天"灰', !canShift(at(2026, 9, 25), -1, r7) && canShift(at(2026, 9, 25), 1, r7));
  ok('全部时间：两边都能点', canShift(at(2026, 10, 1), -1, rAll) && canShift(at(2026, 10, 1), 1, rAll));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
