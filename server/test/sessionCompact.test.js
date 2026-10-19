/**
 * Regression test: **context compaction is not a new session**.
 *
 * Symptom (measured 2026-10-19, 3F Codex): a task was still running while the task record said
 * "cancelled". Codex / Claude re-fire `SessionStart` with `source: 'compact'` on every automatic
 * context compaction, and that happens **in the middle of a running turn** (20+ times inside one
 * 25-minute task in the measured case). The SessionStart handler treated every SessionStart as a
 * brand-new session: it cleared `taskId` / `taskStartedAt` from the state file and pushed the
 * session to idle. `session_status.task_id` therefore became NULL while the task row was still
 * `running`, `/task-runs`' liveness check (`ss.task_id = t.id`, see taskAliveSql) had nothing to
 * match, and the still-running task was normalized to "cancelled". Later tool events also lost
 * their task attribution.
 *
 * What this file pins down:
 *   [1] SessionStart(source=compact) mid-round -> taskId kept, status stays busy with that taskId,
 *       no task/end is sent;
 *   [2] SessionStart(source=startup) -> the normal reset still happens (taskId cleared, idle);
 *   [3] SessionStart(source=compact) with no round in flight -> falls through to the normal reset;
 *   [4] server restarted (in-memory state gone, only the state file knows the round) + compact ->
 *       taskId is recovered from the ledger and the round stays busy;
 *   [5] a busy status after a restart re-attaches the round (task_id is what liveness reads), and
 *       the round still closes normally afterwards (Stop -> done), so keeping it is not a leak.
 *
 * Run: `node server/test/sessionCompact.test.js` (no dependencies: temp dirs + fake bus)
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-session-compact-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const WS = path.join(TMP, 'ws');
for (const d of [HOME, WG, WS]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
process.chdir(WS);

const { createHookDispatch } = require('../src/ingest/hookDispatch');

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

let taskSeq = 0;
const starts = [];
const ends = [];
const statuses = [];
/** Ledger view the fake bus exposes to `currentTaskFor` (used to emulate a server restart) */
let ledgerTask = null;

const bus = {
  startTask: async (args) => {
    starts.push(args);
    const taskId = `t_compact_${++taskSeq}`;
    ledgerTask = { taskId, title: args.title || '', sessionId: args.sessionId || '', startedAt: Date.now() };
    return { ok: true, taskId };
  },
  endTask: async (args) => {
    ends.push(args);
    ledgerTask = null;
  },
  toolUse: async () => {},
  setStatus: async (args) => { statuses.push(args); },
  heartbeat: async () => {},
  registerMember: async () => {},
  projectForReport: () => '',
  backfillTaskTokens: async () => {},
  currentTaskFor: () => (ledgerTask ? { ok: true, ...ledgerTask } : { ok: true, taskId: null }),
  recordMessage: async () => {},
  fileTouch: async () => {},
  taskProgress: async () => {},
};
const ctx = { project: 'WorkGremlin', workspacePath: WS, bus };

/** A fresh dispatcher = a restarted server: the in-memory session Map is empty, the state file is not. */
function newDispatch() {
  return createHookDispatch();
}

async function run(d, payload) {
  await d.dispatch({ ...payload, agent: 'codex', workspacePath: payload.cwd || WS }, ctx);
}

function stateOf(sid) {
  const dir = path.join(WG, 'hooks');
  let ents = [];
  try {
    ents = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const name = ents.find((n) => n.includes(`_${sid}.json`) || n.endsWith(`@${sid}.json`));
  if (!name) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch {
    return null;
  }
}
const lastStatus = () => statuses[statuses.length - 1] || {};

async function main() {
  head('[1] SessionStart(source=compact) mid-round keeps the round alive');
  {
    const sid = 'codex-compact-1';
    const d = newDispatch();
    await run(d, { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: WS, prompt: '改点东西' });
    const taskId = String((stateOf(sid) || {}).taskId || '');
    ok('the round opened (taskId on disk)', Boolean(taskId), JSON.stringify(stateOf(sid)));
    const endsBefore = ends.length;
    statuses.length = 0;

    await run(d, { hook_event_name: 'SessionStart', session_id: sid, cwd: WS, source: 'compact' });

    const st = stateOf(sid);
    ok('taskId survives the compaction', Boolean(st && st.taskId === taskId), st && JSON.stringify(st.taskId));
    ok('taskStartedAt survives (the round keeps its start time)', Boolean(st && Number(st.taskStartedAt) > 0), st && JSON.stringify(st.taskStartedAt));
    ok('no task/end is sent', ends.length === endsBefore, `${endsBefore} → ${ends.length}`);
    ok('status stays busy', lastStatus().state === 'busy', JSON.stringify(lastStatus()));
    ok('status still carries this taskId (liveness keeps matching)', lastStatus().taskId === taskId, JSON.stringify(lastStatus()));
    ok('phase is not pushed to idle', Boolean(st && st.sessionPhase && st.sessionPhase.phase !== 'idle'), st && JSON.stringify(st.sessionPhase));
  }

  head('[2] SessionStart(source=startup) still performs the normal reset');
  {
    const sid = 'codex-compact-2';
    const d = newDispatch();
    await run(d, { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: WS, prompt: '再来一轮' });
    const taskId = String((stateOf(sid) || {}).taskId || '');
    statuses.length = 0;
    await run(d, { hook_event_name: 'SessionStart', session_id: sid, cwd: WS, source: 'startup' });
    const st = stateOf(sid);
    ok('taskId cleared on a real new session', Boolean(st && !st.taskId), st && JSON.stringify(st.taskId));
    ok('phase is idle', Boolean(st && st.sessionPhase && st.sessionPhase.phase === 'idle'), st && JSON.stringify(st.sessionPhase));
    ok('status is idle', lastStatus().state === 'idle', JSON.stringify(lastStatus()));
    ok('the previous round was not closed by the reset itself', !ends.some((e) => e.taskId === taskId), JSON.stringify(ends.map((e) => [e.taskId, e.state])));
  }

  head('[3] SessionStart(source=compact) with no round in flight falls through to the reset');
  {
    const sid = 'codex-compact-3';
    const d = newDispatch();
    ledgerTask = null;
    statuses.length = 0;
    await run(d, { hook_event_name: 'SessionStart', session_id: sid, cwd: WS, source: 'compact' });
    const st = stateOf(sid);
    ok('no taskId to keep', Boolean(st && !st.taskId), st && JSON.stringify(st.taskId));
    ok('phase is idle', Boolean(st && st.sessionPhase && st.sessionPhase.phase === 'idle'), st && JSON.stringify(st.sessionPhase));
    ok('status is idle', lastStatus().state === 'idle', JSON.stringify(lastStatus()));
  }

  head('[4] after a server restart (memory lost) a compaction recovers the round from the ledger');
  {
    const sid = 'codex-compact-4';
    const d1 = newDispatch();
    await run(d1, { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: WS, prompt: '重启前开的一轮' });
    const taskId = String((stateOf(sid) || {}).taskId || '');
    ok('round opened before the restart', Boolean(taskId), JSON.stringify(stateOf(sid)));

    const d2 = newDispatch(); // restart: the in-memory Map is gone, the state file is still there
    statuses.length = 0;
    await run(d2, { hook_event_name: 'SessionStart', session_id: sid, cwd: WS, source: 'compact' });
    const st = stateOf(sid);
    ok('taskId recovered into the state file', Boolean(st && st.taskId === taskId), st && JSON.stringify(st.taskId));
    ok('status busy with the recovered taskId', lastStatus().state === 'busy' && lastStatus().taskId === taskId, JSON.stringify(lastStatus()));
    ok('no task/end is sent', !ends.some((e) => e.taskId === taskId), JSON.stringify(ends.map((e) => [e.taskId, e.state])));
  }

  head('[5] a busy status after a restart re-attaches the round (task_id is what liveness reads)');
  {
    const sid = 'codex-compact-6';
    const d1 = newDispatch();
    await run(d1, { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: WS, prompt: '重启后继续干活' });
    const taskId = String((stateOf(sid) || {}).taskId || '');

    const d2 = newDispatch(); // restart: only the ledger knows the round
    statuses.length = 0;
    await run(d2, { hook_event_name: 'PreToolUse', session_id: sid, cwd: WS, tool_name: 'Bash', tool_input: { command: 'ls' } });
    ok('busy status carries the recovered taskId', lastStatus().state === 'busy' && lastStatus().taskId === taskId, JSON.stringify(lastStatus()));
    const st = stateOf(sid);
    ok('the recovered taskId is written back to the state file', Boolean(st && st.taskId === taskId), st && JSON.stringify(st.taskId));

    // An idle status must NOT resurrect a stale ledger row: it reports the empty slot as-is.
    statuses.length = 0;
    await run(d2, { hook_event_name: 'Stop', session_id: sid, cwd: WS });
    ok('Stop still closes the recovered round', (ends.find((e) => e.taskId === taskId) || {}).state === 'done', JSON.stringify(ends.filter((e) => e.taskId === taskId)));
  }

  head('[6] the kept round still closes normally on Stop');
  {
    const sid = 'codex-compact-5';
    const d = newDispatch();
    await run(d, { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: WS, prompt: '跑完就收工' });
    const taskId = String((stateOf(sid) || {}).taskId || '');
    await run(d, { hook_event_name: 'SessionStart', session_id: sid, cwd: WS, source: 'compact' });
    await run(d, { hook_event_name: 'Stop', session_id: sid, cwd: WS });
    const end = ends.find((e) => e.taskId === taskId) || {};
    ok('Stop closes the very round that survived the compaction', end.state === 'done', JSON.stringify(end));
    const st = stateOf(sid);
    ok('task slot cleared after Stop', Boolean(st && !st.taskId), st && JSON.stringify(st.taskId));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
