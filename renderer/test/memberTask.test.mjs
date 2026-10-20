/**
 * Workstation-card task and state scoping.
 *
 * The regression this locks down: one member can have several sessions at once. A card must
 * select its running task, blocked state, and last-active time by the selected session instead
 * of showing whichever session happened to write last.
 *
 * Run: `npm run test:member-task`
 */
const {
  currentTaskOf,
  currentTaskTitle,
  currentTaskStartedAt,
  isWorking,
  memberForSession,
  normalizeState,
  statusLabel,
  statusTone,
  summonTaskOf,
  summonTaskTitle,
} = await import('../src/lib/memberTask.js');

/**
 * Status labels come from i18n. Pin Chinese here because Node guesses en-US by default;
 * the English table is covered by the i18n completeness test.
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

const T = 1_700_000_000_000;
const task = (id, sessionId, title, startedAt = T, endedAt = null) => ({
  id,
  sessionId,
  title,
  startedAt,
  endedAt,
});

console.log('\n[1] Running tasks are selected by session');
const member = {
  memberId: 'codex@p',
  name: 'codex',
  role: 'agent',
  state: 'busy',
  stateSince: T,
  tasks: [task('t1', 'session-a', 'task A'), task('t2', 'session-b', 'task B', T + 1)],
  sessionStatuses: [],
  lastTaskAtBySession: [
    { sessionId: 'session-a', at: T + 100 },
    { sessionId: 'session-b', at: T + 200 },
  ],
  currentFiles: [],
};
ok('session A gets its own task', currentTaskOf(member, 'session-a').id === 't1');
ok('session B gets its own task', currentTaskOf(member, 'session-b').id === 't2');
ok('unknown session gets no task', currentTaskOf(member, 'session-c') === null);
ok('title follows the selected task', currentTaskTitle(member, 'session-a') === 'task A');
ok('start time follows the selected task', currentTaskStartedAt(member, 'session-a') === T);
ok('no session keeps the newest task for demo / legacy display', currentTaskOf(member).id === 't1');

console.log('\n[2] State is derived per session');
const blockedMember = {
  ...member,
  sessionStatuses: [{ sessionId: 'session-b', state: 'blocked', stateSince: T + 50 }],
};
const a = memberForSession(member, 'session-a', [member]);
const b = memberForSession(blockedMember, 'session-b', [blockedMember]);
const c = memberForSession(member, 'session-c', [member]);
ok('session A is busy', a.state === 'busy' && a.task.id === 't1');
ok('session B blocked wins over its running task', b.state === 'blocked' && b.task.id === 't2');
ok('session C is idle even while another session is busy', c.state === 'idle' && c.task === null);
ok('blocked state keeps that session timestamp', memberForSession(blockedMember, 'session-b').stateSince === T + 50);
ok('last active is filtered by session', a.lastTaskAt === T + 100 && b.lastTaskAt === T + 200);
ok('session C has no last-active value', c.lastTaskAt === null);

console.log('\n[3] Finished tasks are history, not current tasks');
const ended = { ...member, tasks: [task('old', 'session-a', 'old task', T, T + 10)] };
ok('ended task is not current', currentTaskOf(ended, 'session-a') === null);
ok('ended task title is empty', currentTaskTitle(ended, 'session-a') === '');
ok('missing tasks are safe', currentTaskOf({}, 'session-a') === null && currentTaskOf(null) === null);
ok('busy is the only working member state', isWorking({ state: 'busy' }) && !isWorking({ state: 'blocked' }) && !isWorking({ state: 'idle' }));
ok('unknown states normalize to idle', normalizeState('online') === 'idle' && normalizeState('offline') === 'idle');

console.log('\n[4] Resident gremlins borrow only a same-session summon');
const resident = {
  memberId: 'susan@p',
  name: 'susan',
  role: 'subagent:project',
  state: 'busy',
  agentState: 'busy',
  tasks: [],
  sessionStatuses: [],
  sessionId: null,
};
const ghost = {
  memberId: 'subagent-susan-1@p',
  name: 'susan',
  role: 'subagent',
  ephemeral: true,
  sessionId: 'session-a',
  state: 'busy',
  tasks: [task('g1', 'session-a', 'write docs')],
  sessionStatuses: [],
};
ok('same-name ghost task is borrowed', summonTaskTitle(resident, [resident, ghost], 'session-a') === 'write docs');
ok('summonTaskOf returns the ghost task', summonTaskOf(resident, [resident, ghost], 'session-a') === ghost.tasks[0]);
ok('another session does not borrow it', summonTaskTitle(resident, [resident, ghost], 'session-b') === '');
ok('ended ghost task is not borrowed', summonTaskTitle(resident, [resident, { ...ghost, tasks: [task('g1', 'session-a', 'write docs', T, T + 1)] }], 'session-a') === '');
ok('idle resident does not borrow', summonTaskTitle({ ...resident, agentState: 'idle' }, [resident, ghost], 'session-a') === '');
ok('resident own task wins', summonTaskTitle({ ...resident, tasks: [task('own', 'session-a', 'own work')] }, [resident, ghost], 'session-a') === 'own work');
ok(
  'a non-ghost same-name member is not borrowed',
  summonTaskTitle(
    resident,
    [resident, { ...ghost, memberId: 'susan-copy@p', ephemeral: false, role: 'subagent' }],
    'session-a'
  ) === ''
);

console.log('\n[5] Status labels stay three-state');
ok('busy -> working', statusLabel('busy') === '忙碌', statusLabel('busy'));
ok('blocked -> blocked', statusLabel('blocked') === '阻塞', statusLabel('blocked'));
ok('idle -> idle', statusLabel('idle') === '空闲', statusLabel('idle'));
ok('legacy online/offline values render as idle', statusLabel('online') === '空闲' && statusLabel('offline') === '空闲');
ok('unknown values render as idle', statusLabel('weird') === '空闲');
ok('tone and label share the normalized state', statusTone('blocked') === 'blocked' && statusTone('busy') === 'busy' && statusTone('online') === 'idle');

console.log('\n[6] Absolute clock formatting');
const { formatClock } = await import('@workgremlin/shared');
const at = new Date(2026, 8, 30, 21, 5, 42).getTime();
ok('format is MM-DD HH:mm', formatClock(at) === '09-30 21:05', formatClock(at));
ok('empty / invalid values return an empty string', formatClock(0) === '' && formatClock(NaN) === '' && formatClock(null) === '');
ok('the same timestamp is stable without a clock tick', formatClock(at) === formatClock(at));

console.log('\n[7] Every WorkstationCard gets its siblings and selected session');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.vue')) files.push(p);
    }
  })(root);
  const usages = [];
  const missingMembers = [];
  const missingSession = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /<WorkstationCard\b[\s\S]*?\/?>/g;
    let m;
    while ((m = re.exec(src))) {
      usages.push(path.relative(root, f));
      if (!/:members\b/.test(m[0])) missingMembers.push(path.relative(root, f));
      if (!/:session-id\b/.test(m[0])) missingSession.push(path.relative(root, f));
    }
  }
  ok('at least three WorkstationCard call sites are covered', usages.length >= 3, usages.join(', '));
  ok('all call sites pass :members', missingMembers.length === 0, missingMembers.join(', '));
  ok('all call sites pass :session-id', missingSession.length === 0, missingSession.join(', '));
}

console.log(`\nResult: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
