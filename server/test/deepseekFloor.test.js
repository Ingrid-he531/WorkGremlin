'use strict';

/**
 * 10F DeepSeek Harness self-test.
 *
 * Run: `npm run test:dsh` (this file is the floor half).
 *
 * What it locks:
 *   [A] detection: a `dsh` executable is enough, and the source points at
 *       `$DSH_HOME/sessions` (not at ~/.dsh itself, which is only config/skills).
 *   [B] session list: both raw `.jsonl` and the default concatenated-Zstandard
 *       log expose their immutable header frame; the body is never decoded.
 *   [C] child subagent sessions do not become independent dropdown entries.
 *   [D] the floor's rows carry the real cwd/project and stay explicitly
 *       `unreported` until the DSH plugin reports a phase.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-dsh-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const BIN = path.join(TMP, 'bin');
const DSH_HOME = path.join(HOME, '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const PROJ = path.join(TMP, 'DeepSeekProj');
for (const d of [HOME, WG, BIN, SESSIONS, PROJ]) fs.mkdirSync(d, { recursive: true });

// The floor reads HOME / DSH_HOME at require time.
process.env.HOME = HOME;
process.env.DSH_HOME = DSH_HOME;
process.env.WORKGREMLIN_HOME = WG;
process.env.PATH = BIN;
fs.writeFileSync(path.join(BIN, 'dsh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const { detectProducts } = require('../src/floors');
const { snapshot } = require('../src/sessionRegistry');
const dsh = require('../src/floorDeepseek');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail !== undefined ? `  — ${detail}` : ''}`);
  }
}

const now = Date.now();
const projectDir = path.join(SESSIONS, '--tmp-DeepSeekProj--');
fs.mkdirSync(projectDir, { recursive: true });

function header(id, extra = {}) {
  return JSON.stringify({
    type: 'session',
    version: 4,
    id,
    createdAt: now - 60_000,
    cwd: PROJ,
    isSeeded: false,
    delegationDepth: 0,
    ...extra,
  });
}

/** A raw log, the `compression: 'none'` form. */
const PLAIN_ID = 'session-plain-0001';
const plainDir = path.join(projectDir, 'plain');
fs.mkdirSync(plainDir, { recursive: true });
fs.writeFileSync(path.join(plainDir, 'session.v4.jsonl'), `${header(PLAIN_ID)}\n`, 'utf8');

/** The default form: a header frame followed by a data frame. */
const ZSTD_ID = 'session-zstd-0002';
const zstdDir = path.join(projectDir, 'zstd');
fs.mkdirSync(zstdDir, { recursive: true });
const zstdFile = path.join(zstdDir, 'session.v4.jsonl.zstd');
if (typeof zlib.zstdCompressSync === 'function') {
  const frames = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(`${header(ZSTD_ID)}\n`, 'utf8')),
    zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', data: { turn: 1 } })}\n`, 'utf8')),
  ]);
  fs.writeFileSync(zstdFile, frames);
} else {
  console.log('  (skipping zstd fixture: this Node has no zstdCompressSync)');
}

/** A child subagent session: same project, but `origin: 'subagent'`. */
const CHILD_ID = 'session-child-0003';
const childDir = path.join(projectDir, 'child');
fs.mkdirSync(childDir, { recursive: true });
fs.writeFileSync(
  path.join(childDir, 'session.v4.jsonl'),
  `${header(CHILD_ID, { origin: 'subagent', parentSession: PLAIN_ID })}\n`,
  'utf8'
);

for (const dir of [plainDir, zstdDir, childDir]) {
  try {
    fs.utimesSync(path.join(dir, 'session.v4.jsonl'), now / 1000, now / 1000);
  } catch {
    /* zstd dir has a different file name */
  }
  try {
    fs.utimesSync(path.join(dir, 'session.v4.jsonl.zstd'), now / 1000, now / 1000);
  } catch {
    /* not every dir has a zstd log */
  }
}

console.log('\n[A] detection: one 10F floor, source at $DSH_HOME/sessions');
{
  const products = detectProducts({ force: true });
  const p = products.find((x) => x.id === '10F');
  ok('floor 10F exists and is named DeepSeek Harness', p && p.name === 'DeepSeek Harness' && p.agent === 'dsh');
  ok('a dsh executable counts as installed', Boolean(p && p.installed), p && p.installPath);
  ok('the data path is the sessions root, not ~/.dsh', Boolean(p && p.dataPath === SESSIONS), p && p.dataPath);
  ok('both the directory source and the hook source are declared', Boolean(p && p.sources.some((s) => s.kind === 'dsh') && p.sources.some((s) => s.kind === 'hook')));
  ok('floor order is numeric (10F comes after 9F)', products.findIndex((x) => x.id === '10F') === products.length - 1);
}

console.log('\n[B] session discovery: header only, raw and zstd');
{
  const rows = dsh.listDshSessions();
  ok('the raw session is listed', rows.some((r) => r.sessionId === PLAIN_ID), rows.map((r) => r.sessionId).join(','));
  if (typeof zlib.zstdCompressSync === 'function') {
    ok('the zstd header frame is readable even with a second frame appended', rows.some((r) => r.sessionId === ZSTD_ID));
  }
  ok('cwd becomes the project path', rows.every((r) => r.projectPath === PROJ), JSON.stringify(rows.map((r) => r.projectPath)));
  ok('the newest session sorts first', rows.length > 1 && rows[0].lastEventAt >= rows[rows.length - 1].lastEventAt);
}

console.log('\n[C] child subagent sessions are not independent sessions');
{
  const rows = dsh.listDshSessions();
  ok('the origin:subagent child is skipped', !rows.some((r) => r.sessionId === CHILD_ID), rows.map((r) => r.sessionId).join(','));
}

console.log('\n[D] registry row: real project, explicit unreported phase');
{
  const snap = snapshot({ workspacePath: PROJ, force: true });
  const floor = (snap.floors || []).find((f) => f.id === '10F');
  ok('the 10F floor is in the snapshot', Boolean(floor));
  const rows = (floor && floor.sessions) || [];
  const main = rows.find((s) => s.sessionId === PLAIN_ID);
  ok('the main session is listed with its real project path', Boolean(main && main.projectPath === PROJ), JSON.stringify(rows.map((s) => [s.sessionId, s.projectPath])));
  ok('the row is marked as coming from the dsh source', Boolean(main && main.sourceKind === 'dsh'), main && main.sourceKind);
  ok('no plugin report means unreported, never an invented phase', Boolean(main && main.phase === 'unreported' && main.inferred === true), main && `${main.phase}/${main.inferred}`);
  ok('the child session is not in the dropdown', !rows.some((s) => s.sessionId === CHILD_ID));
}

async function hookPathTest() {
console.log('\n[E] hook path: prompt, tools, permission wait, and token/reason handoff');
{
  const { createHookDispatch } = require('../src/ingest/hookDispatch');
  const dispatch = createHookDispatch();
  const starts = [];
  const ends = [];
  const blocked = [];
  const cleared = [];
  const toolUses = [];
  const files = [];
  let seq = 0;
  const bus = {
    startTask: async (args) => { starts.push(args); return { ok: true, taskId: `t_dsh_${++seq}` }; },
    endTask: async (args) => { ends.push(args); },
    toolUse: async (args) => { toolUses.push(args); },
    fileTouch: async (args) => { files.push(args); },
    setBlocked: async (args) => { blocked.push(args); },
    clearBlocked: async (args) => { cleared.push(args); return { ok: true }; },
    registerMember: async () => {},
    projectForReport: () => '',
    backfillTaskTokens: async () => {},
    currentTaskFor: () => null,
    recordMessage: async () => {},
    taskProgress: async () => {},
    ghostSpawn: async () => ({}),
    ghostRetire: async () => ({}),
    ghostBindIdentity: async () => ({}),
    ghostSweep: async () => 0,
  };
  const ctx = { project: 'dsh-proj', workspacePath: PROJ, bus };
  const run = (payload) => dispatch.dispatch({ agent: 'dsh', workspacePath: PROJ, cwd: PROJ, ...payload }, ctx);

  const sid = 'dsh-hook-1';
  await run({ hook_event_name: 'SessionStart', session_id: sid, source: 'startup' });
  await run({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'fix the parser', model: 'opencode-go/deepseek-v4.1-flash' });
  ok('UserPromptSubmit opens a task with the user prompt', Boolean(starts[0] && starts[0].title === 'fix the parser'), JSON.stringify(starts[0]));
  ok('the model is carried into the ledger', Boolean(starts[0] && starts[0].model === 'opencode-go/deepseek-v4.1-flash'));

  await run({ hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'write', tool_input: { path: 'src/a.js' } });
  await run({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'write', tool_input: { path: 'src/a.js' }, tool_response: 'written' });
  ok('a dsh lowercase write tool counts as a tool use', toolUses.some((t) => t.tool === 'write'), JSON.stringify(toolUses));
  ok('the changed file is recorded as a project-relative path', files.some((f) => (f.files || []).includes('src/a.js')), JSON.stringify(files));

  await run({ hook_event_name: 'PermissionRequest', session_id: sid, tool_name: 'bash', tool_input: { command: 'npm test' } });
  ok('PermissionRequest blocks the floor', blocked.some((b) => b.reason === 'awaiting_permission'), JSON.stringify(blocked));
  await run({ hook_event_name: 'PermissionResolved', session_id: sid, outcome: 'approved' });
  ok('PermissionResolved clears the block without ending the task', cleared.length > 0 && dispatch.sessionGet(sid).taskId, JSON.stringify(cleared));

  await run({
    hook_event_name: 'Stop',
    session_id: sid,
    stop_reason: 'completed',
    last_assistant_message: 'parser fixed',
    tokens: { input: 7, output: 3, cacheRead: 1, cacheWrite: 2 },
  });
  const done = ends[ends.length - 1] || {};
  ok('Stop ends the task as done', done.state === 'done', JSON.stringify(done));
  ok('the plugin token counts reach the ledger', Boolean(done.tokens && done.tokens.input === 7 && done.tokens.output === 3 && done.tokens.cacheRead === 1 && done.tokens.cacheWrite === 2), JSON.stringify(done.tokens));
  ok('the plugin final answer reaches the ledger', done.result === 'parser fixed', done.result);

  const sid2 = 'dsh-hook-2';
  await run({ hook_event_name: 'UserPromptSubmit', session_id: sid2, prompt: 'fail this' });
  await run({ hook_event_name: 'Stop', session_id: sid2, stop_reason: 'failed' });
  ok('a failed turn is not marked done', (ends[ends.length - 1] || {}).state === 'failed', JSON.stringify(ends[ends.length - 1]));

  const sid3 = 'dsh-hook-3';
  await run({ hook_event_name: 'UserPromptSubmit', session_id: sid3, prompt: 'stop this' });
  await run({ hook_event_name: 'Stop', session_id: sid3, stop_reason: 'cancelled' });
  ok('an aborted turn is marked cancelled', (ends[ends.length - 1] || {}).state === 'cancelled', JSON.stringify(ends[ends.length - 1]));

  const sid4 = 'dsh-hook-4';
  await run({ hook_event_name: 'UserPromptSubmit', session_id: sid4, prompt: 'headless exits mid-turn' });
  await run({ hook_event_name: 'SessionEnd', session_id: sid4 });
  ok('SessionEnd closes a still-running turn as cancelled (headless shutdown)', (ends[ends.length - 1] || {}).state === 'cancelled', JSON.stringify(ends[ends.length - 1]));
}
}

hookPathTest()
  .then(() => {
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  });
