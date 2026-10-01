/**
 * 「任务记录 · 每日看板」的口径自检。
 *
 * 看板是一张**楼层 × 时间**的甘特图：一层一行，行里的实心块就是这一层的一次任务，
 * 横轴是当天 00:00–24:00（每小时一条竖线）。
 *
 * 容易被改坏的恰恰是这几处：块在横轴上的百分比位置、相邻任务是不是真的首尾相接
 * （"用竖线分割任务"靠的就是这个）、同一层并行时会不会互相盖住、跨天与"没有结束时间"
 * 怎么算。全部用库里的真值（started_at / ended_at / state）定死在这里。
 *
 * 跑法：`npm run test:day-board`
 */
const { HOUR_COLS, MIN_PER_DAY, buildFloorGantt, dayStartOf, fmtHM, spanOf } = await import(
  '../src/lib/dayBoard.js'
);

/**
 * 兜底行名走 i18n（未记录楼层 / floor not recorded）：这里锁中文那一套。
 * 必须显式设一次 —— i18n 默认按浏览器语言猜，Node 的 navigator.language 是 en-US。
 */
const { setLocale } = await import('../src/i18n/index.js');
setLocale('zh');

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

/** 固定一天：2026-10-01 本地 00:00。min() 把"第几分钟"换算成绝对毫秒 */
const DAY = dayStartOf(new Date(2026, 9, 1, 0, 0, 0).getTime());
const min = (m) => DAY + m * 60_000;
const task = (sMin, eMin, extra = {}) => ({
  id: extra.id || `t${sMin}-${eMin}`,
  started_at: sMin == null ? null : min(sMin),
  ended_at: eMin == null ? null : min(eMin),
  state: 'done',
  client: 'codebuddy',
  ...extra,
});
/** 楼层解析：测试里用 client 直接映射成楼层行（真实现见 TaskRecordsView 的 rowOfTask） */
const FLOORS = {
  codebuddy: { key: '1F', label: '1F CodeBuddy', order: 1 },
  codex: { key: '3F', label: '3F Codex', order: 3 },
  claude: { key: '4F', label: '4F Claude Code', order: 4 },
  trae: { key: '5F', label: '5F TraeCode', order: 5 },
};
const rowOfTask = (t) => {
  if (FLOORS[t.client]) return FLOORS[t.client];
  if (!t.client) return { key: '__none__', label: '未记录楼层', order: 999 };
  return { key: String(t.client), label: t.client, order: 900 };
};
const gantt = (list, nowMin) => buildFloorGantt(list, DAY, min(nowMin), rowOfTask);
const pct = (n) => Math.round(n * 1000) / 1000;

console.log('\n[1] 骨架：一层一行，按楼层号自上而下排');
ok('24 小时刻度 / 一天 1440 分钟', HOUR_COLS === 24 && MIN_PER_DAY === 1440);
{
  const g = gantt([task(540, 630, { client: 'trae' }), task(600, 660, { client: 'codex' }), task(700, 720, { client: 'codex' })], 800);
  ok('两个楼层 ⇒ 两行', g.rows.length === 2, g.rows.map((r) => r.label).join(' '));
  ok('行按楼层号升序（3F 在 5F 前面）', g.rows[0].key === '3F' && g.rows[1].key === '5F', g.rows.map((r) => r.key).join(' '));
  ok('同一层的两条任务在同一行里', g.rows[0].items.length === 2);
  ok('总任务数 / 首末分钟', g.total === 3 && g.firstMin === 540 && g.lastMin === 720, JSON.stringify({ t: g.total, f: g.firstMin, l: g.lastMin }));
}

console.log('\n[2] 块在横轴上的位置 = 当天的时间占比');
{
  const g = gantt([task(540, 630)], 800); // 09:00–10:30
  const it = g.rows[0].items[0];
  ok('09:00 起 ⇒ left 37.5%', pct(it.left) === 37.5, String(pct(it.left)));
  ok('1.5 小时 ⇒ width 6.25%', pct(it.width) === 6.25, String(pct(it.width)));
  ok('块的起止分钟 = 09:00–10:30', it.startMin === 540 && it.endMin === 630);
  ok('只有一条时：一层一行、一个块、没有加深段', g.rows.length === 1 && g.rows[0].items.length === 1 && g.rows[0].overlaps.length === 0);
}

console.log('\n[3] 相邻任务首尾相接（竖线分割靠的就是这条）');
{
  const g = gantt([task(540, 600, { id: 'a' }), task(600, 660, { id: 'b' })], 800);
  const [a, b] = g.rows[0].items;
  ok('两条任务都在同一行（不重叠 ⇒ 不加深、也不多占一行）', g.rows.length === 1 && g.rows[0].items.length === 2 && g.rows[0].overlaps.length === 0);
  ok('前一块的右边界 = 后一块的左边界（中间只隔两条竖边）', pct(a.left + a.width) === pct(b.left), `${pct(a.left + a.width)} vs ${pct(b.left)}`);
}

console.log('\n[4] 同一层并行 ⇒ 仍是**一行**，重叠的那段加深（用户 2026-10-01 要求：不要 2 行）');
{
  // A 09:00–10:30、B 09:30–10:00（被 A 完全包住）、C 10:30–11:00（接在 A 后面）
  const g = gantt(
    [task(540, 630, { id: 'A' }), task(570, 600, { id: 'B' }), task(630, 660, { id: 'C' })],
    800
  );
  ok('三层任务只出 1 行（不再按并行数往下摞）', g.rows.length === 1, String(g.rows.length));
  ok('3 条任务都在这一行里（一条都没丢）', g.rows[0].items.length === 3);
  ok('长的先画、短的后画（短任务不会被整条盖住）', g.rows[0].items[0].task.id === 'A' && g.rows[0].items[1].task.id === 'B');
  const ov = g.rows[0].overlaps;
  ok('重叠段只有 A∩B 这一处（09:30–10:00）', ov.length === 1 && Math.abs(ov[0].left - 39.5833) < 0.01 && Math.abs(ov[0].width - 2.0833) < 0.01, JSON.stringify(ov.map((o) => [pct(o.left), pct(o.width)])));
  ok('这一段同时有 2 条 ⇒ count = 2（界面据此加深）', ov[0].count === 2, String(ov[0].count));
  ok('相接的两条（A 结束 = C 开始）不算重叠', ov.every((o) => !(o.left <= pct(75) && pct(o.left + o.width) > 75)), JSON.stringify(ov));
}
{
  // 三条叠在一起：覆盖数要按段区分（2 条那一段浅、3 条那一段深）
  const g = gantt([task(600, 660, { id: 'A' }), task(610, 650, { id: 'B' }), task(620, 640, { id: 'C' })], 700);
  const ov = g.rows[0].overlaps;
  ok('三条叠在一起 ⇒ 分成"2 条 / 3 条 / 2 条"三段', ov.length === 3 && ov.map((o) => o.count).join(',') === '2,3,2', JSON.stringify(ov.map((o) => o.count)));
}
{
  // 首尾相接（A 09:00–09:30，B 09:30–10:00）：不算重叠，一条暗片都不该有
  const g = gantt([task(540, 570, { id: 'A' }), task(570, 600, { id: 'B' })], 700);
  ok('首尾相接 ⇒ 没有加深段', g.rows[0].overlaps.length === 0, JSON.stringify(g.rows[0].overlaps));
}

console.log('\n[5] 没有结束时间怎么画（不编造）');
{
  const g = gantt([task(600, null, { state: 'running' })], 660);
  const it = g.rows[0].items[0];
  ok('还在跑的 ⇒ 画到此刻（10:00–11:00）', it.startMin === 600 && it.endMin === 660, `${it.startMin}-${it.endMin}`);
}
{
  const g = gantt([task(600, null, { state: 'cancelled' })], 1200);
  const it = g.rows[0].items[0];
  ok('取消/失败却没结束时间 ⇒ 只占开始那一瞬间，不替它编结束时刻', it.endMin === 601 && it.width > 0, `${it.startMin}-${it.endMin} w=${it.width}`);
}
{
  const g = gantt([{ id: 'x', started_at: null, ended_at: min(600), state: 'done', client: 'codex' }], 700);
  ok('没有开始时间 ⇒ 进不了图，单记一笔 untimed', g.total === 0 && g.untimed === 1 && g.rows.length === 0);
  ok('spanOf 也直接回 null', spanOf({ started_at: null }, min(700)) === null);
}

console.log('\n[6] 跨天 / 边界');
{
  const g = gantt([task(-60, 20, { client: 'codex' })], 600); // 昨天 23:00 → 今天 00:20
  const it = g.rows[0].items[0];
  ok('昨天开始的 ⇒ 今天从 00:00 画起（left = 0）', it.left === 0 && it.startMin === 0);
  ok('只画到 00:20', it.endMin === 20);
}
{
  const g = gantt([task(-30, 0, { client: 'codex' })], 600); // 昨天 23:30 → 今天 00:00 整
  ok('正好 00:00 收工 ⇒ 今天不算它', g.total === 0 && g.rows.length === 0);
}
{
  const g = gantt([task(0, 0, { client: 'codex' })], 600);
  ok('零长度（只知道开始）也留一块，不凭空消失', g.total === 1 && g.rows[0].items[0].endMin === 1);
}
{
  const g = gantt([task(1410, 1450, { client: 'codex' })], 1500); // 23:30 → 次日 00:10
  const it = g.rows[0].items[0];
  ok('23:30 之后开始的 ⇒ 画到 24:00 收口', it.startMin === 1410 && it.endMin === 1440, `${it.startMin}-${it.endMin}`);
}

console.log('\n[7] 认不出的楼层：如实单列，不硬塞进某一层');
{
  const g = gantt([task(600, 660, { client: 'weird-cli' }), task(600, 660, { client: null })], 700);
  const labels = g.rows.map((r) => r.label);
  ok('有 client 但楼层表里没有 / 压根没 client ⇒ 两行（排在最后）', labels.length === 2, labels.join(' '));
  ok('没 client 的那行叫「未记录楼层」、认不出的 client 照原名列出', labels.includes('未记录楼层') && labels.includes('weird-cli'), labels.join(' '));
  ok('这两行都排在真楼层之后', g.rows[1].order >= 900);
}
{
  // 解析器直接回 null（界面里 client 与楼层表都对不上时的兜底）：也归到「未记录楼层」，不丢任务
  const g = buildFloorGantt([task(600, 660, { client: 'x' })], DAY, min(700), () => null);
  ok('解析器回 null ⇒ 兜到「未记录楼层」行，任务不丢', g.total === 1 && g.rows[0].label === '未记录楼层', JSON.stringify(g.rows.map((r) => r.label)));
}

console.log('\n[7b] 没任务的楼层也占一行（筛选=全部楼层时传进来的 baseRows）');
{
  const installed = [
    { key: '1F', label: '1F CodeBuddy', order: 1 },
    { key: '3F', label: '3F Codex', order: 3 },
    { key: '6F', label: '6F Qoder', order: 6 },
  ];
  const g = buildFloorGantt([task(600, 660, { client: 'codex' })], DAY, min(700), rowOfTask, installed);
  ok('三层的行都在，哪怕只有 3F 有任务', g.rows.length === 3 && g.rows.map((r) => r.key).join(',') === '1F,3F,6F', g.rows.map((r) => r.key).join(','));
  ok('有任务的那行有条目、没任务的两行是空的', g.rows[0].items.length === 0 && g.rows[1].items.length === 1 && g.rows[2].items.length === 0);
  ok('空行照样报出来（界面据此画空格子）', g.rows[0].overlaps.length === 0 && g.total === 1);
  // 任务落在 baseRows 之外的楼层：不能因为"没预订这一行"就把任务吞掉
  const g2 = buildFloorGantt([task(600, 660, { client: 'trae' })], DAY, min(700), rowOfTask, installed);
  ok('任务所在楼层不在 baseRows 里 ⇒ 补一行，不吞任务', g2.rows.length === 4 && g2.total === 1, g2.rows.map((r) => r.key).join(','));
}

console.log('\n[8] 刻度文案');
ok('0 → 00:00', fmtHM(0) === '00:00');
ok('570 → 09:30', fmtHM(570) === '09:30');
ok('1440 → 24:00', fmtHM(1440) === '24:00');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
