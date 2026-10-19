/**
 * Main-console "waiting for subagents" scope self-test.
 *
 * Regression (2026-10-19): with 3F Codex running a subagent and 8F OpenCode idle, selecting 8F
 * showed "waiting for software-architect to report" even though 8F had no task. The console read
 * every busy ghost in the project without applying the floor / session filter used by the office
 * roster, so another floor's summon leaked into the main phase.
 *
 * Run: `npm run test:live-subs`
 */
const { busySubagentsOf } = await import('../src/lib/liveSubagents.js');

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

const ghost = (name, client, sessionId, state = 'busy') => ({
  memberId: `subagent-${name}-${sessionId || 'x'}`,
  name,
  role: 'subagent',
  ephemeral: true,
  client,
  sessionId,
  state,
});

console.log('\n[1] 楼层隔离：别的楼层的召唤不能驱动本层主相位');
{
  const members = [ghost('software-architect', 'codex', 's3f')];
  ok('8F OpenCode 看不到 3F Codex 的幽灵', busySubagentsOf(members, { client: 'opencode', sessionId: 's8f' }).length === 0);
  ok('3F 自己能看到', busySubagentsOf(members, { client: 'codex', sessionId: 's3f' }).length === 1);
}

console.log('\n[2] 同一楼层内按会话隔离');
{
  const members = [ghost('reviewer', 'codex', 'session-a')];
  ok('另一个会话的幽灵不算本会话在等', busySubagentsOf(members, { client: 'codex', sessionId: 'session-b' }).length === 0);
  ok('同一个会话才算', busySubagentsOf(members, { client: 'codex', sessionId: 'session-a' }).length === 1);
  ok('幽灵没带会话号（老数据）→ 放行', busySubagentsOf([ghost('reviewer', 'codex', '')], { client: 'codex', sessionId: 'session-b' }).length === 1);
}

console.log('\n[3] 只有「正在干活」的幽灵算等待');
{
  ok('busy 算', busySubagentsOf([ghost('a', 'codex', 's', 'busy')], { client: 'codex' }).length === 1);
  ok('blocked 算', busySubagentsOf([ghost('a', 'codex', 's', 'blocked')], { client: 'codex' }).length === 1);
  ok('online 不算', busySubagentsOf([ghost('a', 'codex', 's', 'online')], { client: 'codex' }).length === 0);
  ok('idle 不算', busySubagentsOf([ghost('a', 'codex', 's', 'idle')], { client: 'codex' }).length === 0);
  ok(
    '常驻工位成员即使 busy 也不算等待（等待只针对幽灵）',
    busySubagentsOf([{ memberId: 'leo', name: 'leo', role: 'subagent:project', client: 'codex', state: 'busy' }], { client: 'codex' }).length === 0
  );
}

console.log('\n[4] 缺字段时保持宽容');
{
  ok('members 为空不炸', busySubagentsOf(null).length === 0 && busySubagentsOf(undefined, { client: 'codex' }).length === 0);
  ok('幽灵 client 为空（老数据/手写）→ 每层都显示', busySubagentsOf([ghost('a', null, 's')], { client: 'opencode' }).length === 1);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
