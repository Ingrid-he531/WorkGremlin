/**
 * 成员卡「工程归属」自检。
 *
 * 背景（2026-10-01 用户实测）：进演示模式 → 退出演示 → 切楼层，演示那 8 只小怪物会
 * "再次短暂出现，然后才消失"。
 *
 * 根因不是渲染帧，而是**事件串工程**：渲染层的 WS 订阅不带 project（见 stores/project.js 的
 * init），服务端于是把**所有**工程的 member.status 广播都发过来，而 upsertMember 只看事件类型、
 * 不看工程，有卡就往 members 里塞。退出演示后，__demo__ 那批成员的心跳不再刷新，
 * 服务端每 10s 一次的心跳超时扫描（阈值 60s）在把它们标成 degraded 时**逐个广播了成员卡** →
 * 客户端照单收下 → 屋里闪回 8 只 → 下一次对账（15s，整份快照覆盖）又清掉。
 *
 * 所以把判据固定成一个小函数，三处共用（applyWorkspace / applySnapshot / upsertMember）：
 *   · 两边都有 project 且不一致 → 拦掉；
 *   · 缺字段（老服务端 / 老事件 / 还没拿到 workspace）→ 放行（宁可多显示，别误挡当前工程的人）。
 *
 * 跑法：`npm run test:project-scope`
 */
const { memberBelongsToProject } = await import('../src/lib/projectScope.js');

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

console.log('\n[1] 同工程 / 别的工程');
ok('同一个工程 → 收', memberBelongsToProject({ memberId: 'coder@realproj', project: 'realproj' }, 'realproj'));
ok(
  '演示工程的成员卡在真实工程里 → 拦（就是这次修的"闪回来"）',
  !memberBelongsToProject({ memberId: 'coder@__demo__', project: '__demo__' }, 'realproj')
);
ok(
  '真实工程的成员卡在演示工程里 → 同样拦',
  !memberBelongsToProject({ memberId: 'coder@realproj', project: 'realproj' }, '__demo__')
);
ok('同工程但 id 一个是数字一个是字符串 → 收（按字符串比）', memberBelongsToProject({ project: 7 }, '7'));

console.log('\n[2] 缺字段时一律放行（不能因为缺信息把当前工程的人挡掉）');
ok('卡片没带 project（老服务端 / 老事件）→ 收', memberBelongsToProject({ memberId: 'coder@x' }, 'realproj'));
ok('还不知道当前工程（workspace 还没回来）→ 收', memberBelongsToProject({ project: '__demo__' }, ''));
ok('卡片为 null → 不抛错、收', memberBelongsToProject(null, 'realproj'));
ok('projectId 为 undefined → 收', memberBelongsToProject({ project: 'x' }, undefined));

console.log('\n[3] 与场景里的过滤是两条独立的轴');
// 楼层过滤（client）拦不住这次的问题：演示成员的 client 是 NULL，而 NULL 在
// floorAcceptsClient 里表示"哪层都显示"（见 lib/clientMatch.js）—— 所以必须另有工程这道闸。
const { floorAcceptsClient } = await import('../src/lib/clientMatch.js');
ok('演示成员的 client 为 NULL → 楼层过滤放行（所以挡不住，得靠工程过滤）', floorAcceptsClient('codex', null));
ok('工程过滤把它拦下', !memberBelongsToProject({ project: '__demo__', client: null }, 'realproj'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
