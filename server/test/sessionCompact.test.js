/**
 * Regression test: **context compaction is not a new session**.
 *
 * Symptom (measured 2026-10-19, 3F Codex): a task was still running while the task record said
 * "cancelled". Codex / Claude re-fire `SessionStart` with `source: 'compact'` on every automatic
 * context compaction, and that happens **in the middle of a running turn** (20+ times inside one
 * 25-minute task in the measured case). The SessionStart handler treated every SessionStart as a
 * brand-new session: it cleared `taskId` / `taskStartedAt` from the state file and pushed the
 * taskId / taskStartedAt from the state file and pushed the session to idle. The session then
 * lost its task attribution even though the task row was still `running`; later tool events could
 * no longer be attached to that round.
 *
 * What this file pins down:
 *   [1] SessionStart(source=compact) mid-round -> taskId kept and no task/end is sent;
 *   [2] SessionStart(source=startup) -> the normal reset still happens (taskId cleared);
 *   [3] SessionStart(source=compact) with no round in flight -> falls through to the normal reset;
 *   [4] server restarted (in-memory state gone, only the state file knows the round) + compact ->
 *       taskId is recovered from the ledger;
 *   [5] after a restart, a tool event re-attaches the round through the state file, and the round
 *       still closes normally afterwards (Stop -> done). No busy/idle status row is written.
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
const blockedWrites = [];
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
  setBlocked: async (args) => { blockedWrites.push(args); },
  clearBlocked: async () => ({ ok: true }),
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

async function main() {
  head('[1] SessionStart(source=compact) mid-round keeps the round alive');
  {
    const sid = 'codex-compact-1';
    const d = newDispatch();
    await run(d, { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: WS, prompt: '改点东西' });
    const taskId = String((stateOf(sid) || {}).taskId || '');
    ok('the round opened (taskId on disk)', Boolean(taskId), JSON.stringify(stateOf(sid)));
    const endsBefore = ends.length;
    blockedWrites.length = 0;

    await run(d, { hook_event_name: 'SessionStart', session_id: sid, cwd: WS, source: 'compact' });

    const st = stateOf(sid);
    ok('taskId survives the compaction', Boolean(st && st.taskId === taskId), st && JSON.stringify(st.taskId));
    ok('taskStartedAt survives (the round keeps its start time)', Boolean(st && Number(st.taskStartedAt) > 0), st && JSON.stringify(st.taskStartedAt));
    ok('no task/end is sent', ends.length === endsBefore, `${endsBefore} → ${ends.length}`);
    ok('no blocked row is written', blockedWrites.length === 0, JSON.stringify(blockedWrites));
    ok('phase is not pushed to idle', Boolean(st && st.sessionPhase && st.sessionPhase.phase !== 'idle'), st && JSON.stringify(st.sessionPhase));
  }

  head('[2] SessionStart(source=startup) still performs the normal reset');
  {
    const sid = 'codex-compact-2';
    const d = newDispatch();
    await run(d, { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: WS, prompt: '再来一轮' });
    const taskId = String((stateOf(sid) || {}).taskId || '');
    blockedWrites.length = 0;
    await run(d, { hook_event_name: 'SessionStart', session_id: sid, cwd: WS, source: 'startup' });
    const st = stateOf(sid);
    ok('taskId cleared on a real new session', Boolean(st && !st.taskId), st && JSON.stringify(st.taskId));
    ok('phase is idle', Boolean(st && st.sessionPhase && st.sessionPhase.phase === 'idle'), st && JSON.stringify(st.sessionPhase));
    ok('no blocked row is written', blockedWrites.length === 0, JSON.stringify(blockedWrites));
    ok('the previous round was not closed by the reset itself', !ends.some((e) => e.taskId === taskId), JSON.stringify(ends.map((e) => [e.taskId, e.state])));
  }

  head('[3] SessionStart(source=compact) with no round in flight falls through to the reset');
  {
    const sid = 'codex-compact-3';
    const d = newDispatch();
    ledgerTask = null;
    blockedWrites.length = 0;
    await run(d, { hook_event_name: 'SessionStart', session_id: sid, cwd: WS, source: 'compact' });
    const st = stateOf(sid);
    ok('no taskId to keep', Boolean(st && !st.taskId), st && JSON.stringify(st.taskId));
    ok('phase is idle', Boolean(st && st.sessionPhase && st.sessionPhase.phase === 'idle'), st && JSON.stringify(st.sessionPhase));
    ok('no blocked row is written', blockedWrites.length === 0, JSON.stringify(blockedWrites));
  }

  head('[4] after a server restart (memory lost) a compaction recovers the round from the ledger');
  {
    const sid = 'codex-compact-4';
    const d1 = newDispatch();
    await run(d1, { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: WS, prompt: '重启前开的一轮' });
    const taskId = String((stateOf(sid) || {}).taskId || '');
    ok('round opened before the restart', Boolean(taskId), JSON.stringify(stateOf(sid)));

    const d2 = newDispatch(); // restart: the in-memory Map is gone, the state file is still there
    blockedWrites.length = 0;
    await run(d2, { hook_event_name: 'SessionStart', session_id: sid, cwd: WS, source: 'compact' });
    const st = stateOf(sid);
    ok('taskId recovered into the state file', Boolean(st && st.taskId === taskId), st && JSON.stringify(st.taskId));
    ok('recovery does not write a blocked row', blockedWrites.length === 0, JSON.stringify(blockedWrites));
    ok('no task/end is sent', !ends.some((e) => e.taskId === taskId), JSON.stringify(ends.map((e) => [e.taskId, e.state])));
  }

  head('[5] a tool event after a restart re-attaches the running round');
  {
    const sid = 'codex-compact-6';
    const d1 = newDispatch();
    await run(d1, { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: WS, prompt: '重启后继续干活' });
    const taskId = String((stateOf(sid) || {}).taskId || '');

    const d2 = newDispatch(); // restart: only the ledger knows the round
    blockedWrites.length = 0;
    await run(d2, { hook_event_name: 'PreToolUse', session_id: sid, cwd: WS, tool_name: 'Bash', tool_input: { command: 'ls' } });
    const st = stateOf(sid);
    ok('the recovered taskId is written back to the state file', Boolean(st && st.taskId === taskId), st && JSON.stringify(st.taskId));
    ok('task activity does not write a blocked row', blockedWrites.length === 0, JSON.stringify(blockedWrites));

    blockedWrites.length = 0;
    await run(d2, { hook_event_name: 'Stop', session_id: sid, cwd: WS });
    ok('Stop still closes the recovered round', (ends.find((e) => e.taskId === taskId) || {}).state === 'done', JSON.stringify(ends.filter((e) => e.taskId === taskId)));
    ok('Stop writes no blocked row', blockedWrites.length === 0, JSON.stringify(blockedWrites));
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
