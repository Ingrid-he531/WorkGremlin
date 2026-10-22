'use strict';
/**
 * 9F GitHub Copilot CLI form self-test.
 *
 * 9F used to read only the VS Code extension's `session-store.db`. Copilot CLI keeps an independent store
 * (`~/.copilot/session-store.db`) with the same schema, plus a live event stream
 * (`~/.copilot/session-state/<id>/events.jsonl`) that plays the role of VS Code's chat index: it says whether
 * the newest turn is still running, what the user said, and when the turn ended.
 *
 * The assertions go through the paths users see:
 *   · detectProducts: CLI alone (no extension) counts as installed, and both forms are listed as sources
 *   · sessionRegistry.snapshot: the CLI session is one 9F row, form=cli, phase=thinking while in flight
 *   · sessions.readReporterDone: the CLI turn end becomes the done marker
 *   · syncCopilotTasks: one ledger row per turn, the in-flight one running, the finished one done
 *
 * Run: `npm run test:copilot-cli`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ sandbox ------------------------------ */
// sessions.js / floorCopilot.js capture HOME at require time, so set it first.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-copilot-cli-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const BIN = path.join(TMP, 'bin');
const COPILOT = path.join(HOME, '.copilot');
const WS = path.join(TMP, 'project');
const SID = '11111111-2222-4333-8444-555555555555';
for (const d of [HOME, WG, BIN, COPILOT, WS, path.join(COPILOT, 'session-state', SID)]) {
  fs.mkdirSync(d, { recursive: true });
}
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH || ''}`;
fs.writeFileSync(path.join(BIN, 'copilot'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const Database = require('better-sqlite3');
const db = new Database(path.join(COPILOT, 'session-store.db'));
db.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT,
    created_at TEXT, updated_at TEXT
  );
  CREATE TABLE turns (
    id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, user_message TEXT,
    assistant_response TEXT, timestamp TEXT, UNIQUE(session_id, turn_index)
  );
  CREATE TABLE session_files (
    id INTEGER PRIMARY KEY, session_id TEXT, file_path TEXT, tool_name TEXT, turn_index INTEGER,
    first_seen_at TEXT, UNIQUE(session_id, file_path)
  );
`);
const now = Date.now();
const iso = (t) => new Date(t).toISOString();
db.prepare('INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(SID, WS, 'example/repo', 'github', 'main', 'cli session title', iso(now - 60_000), iso(now));
db.prepare('INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?,?,?,?,?)')
  .run(SID, 0, 'first task', 'done', iso(now - 50_000));
db.close();

const eventsFile = path.join(COPILOT, 'session-state', SID, 'events.jsonl');
const event = (type, data, at) =>
  JSON.stringify({ type, data, id: `${type}-${at}`, timestamp: iso(at), parentId: null });
function writeEvents(lines) {
  fs.writeFileSync(eventsFile, `${lines.join('\n')}\n`);
}
writeEvents([
  event('session.start', { sessionId: SID, context: { cwd: WS } }, now - 60_000),
  event('user.message', { content: 'first task' }, now - 50_000),
  event('assistant.turn_start', { turnId: '0' }, now - 49_000),
  event('assistant.message', { model: 'gpt-5-mini', content: 'done', turnId: '0' }, now - 45_000),
  event('assistant.turn_end', { turnId: '0' }, now - 45_000),
  event('user.message', { content: 'run the tests' }, now - 10_000),
  event('assistant.turn_start', { turnId: '1' }, now - 9_000),
]);

const { detectProducts } = require('../src/floors');
const { readCopilotCliLiveRequest, readCopilotDone, syncCopilotTasks } = require('../src/floorCopilot');
const sessionsMod = require('../src/sessions');
const { snapshot } = require('../src/sessionRegistry');
const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');

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
const head = (s) => console.log(`\n${s}`);

/* [1] detection ----------------------------------------------------------------------------------- */
head('[1] 9F detection: CLI alone is installed, and both forms are exposed');
{
  const floor = detectProducts({ force: true }).find((p) => p.id === '9F');
  ok('CLI alone (no extension) counts as installed', floor && floor.installed === true, floor && String(floor.installPath));
  ok('floor kind is cli', floor && floor.kind === 'cli', floor && floor.kind);
  ok('CLI executable resolved', floor && Boolean(floor.cliInstallPath), floor && String(floor.cliInstallPath));
  const kinds = floor ? floor.sources.map((s) => s.kind) : [];
  ok('sources contain the CLI store and the extension store', kinds.includes('copilot-cli') && kinds.includes('plugin'), JSON.stringify(kinds));
  const cli = floor && floor.sources.find((s) => s.kind === 'copilot-cli');
  ok('CLI source points at ~/.copilot', cli && cli.dataPath === COPILOT, cli && cli.dataPath);
  ok('CLI source carries form=cli', cli && cli.form === 'cli', cli && cli.form);
}

/* [2] live event stream --------------------------------------------------------------------------- */
head('[2] CLI events.jsonl: newest turn in flight, exact prompt, prior turn timings');
{
  const live = readCopilotCliLiveRequest(SID);
  ok('live row exists', Boolean(live), JSON.stringify(live));
  ok('in-flight turn index is 1', live && live.index === 1, live && String(live.index));
  ok('not completed while turn_start has no turn_end', live && live.completed === false);
  ok('prompt is the newest user message', live && live.prompt === 'run the tests', live && live.prompt);
  ok('the finished turn keeps its start/end', live && live.reqs.some((r) => r.index === 0 && r.startedAt && r.endedAt), live && JSON.stringify(live.reqs));
  ok('model comes from assistant.message', live && live.model === 'gpt-5-mini', live && live.model);
}

/* [3] session table ------------------------------------------------------------------------------- */
head('[3] session table: one 9F CLI row, phase=thinking while the turn runs');
{
  const snap = snapshot({ force: true, workspacePath: WS });
  const floor = snap.floors.find((f) => f.id === '9F');
  const row = floor && floor.sessions.find((s) => s.sessionId === SID);
  ok('9F has the CLI session', Boolean(row), floor && JSON.stringify(floor.sessions.map((s) => s.sessionId)));
  ok('form is cli', row && row.form === 'cli', row && row.form);
  ok('source is cli', row && row.source === 'cli', row && row.source);
  ok('project path is the session cwd', row && row.projectPath === WS, row && row.projectPath);
  ok('in-flight turn shows thinking', row && row.phase === 'thinking', row && row.phase);
  ok('prompt is the exact user words', row && row.prompt === 'run the tests', row && row.prompt);
}

/* [4] done marker --------------------------------------------------------------------------------- */
head('[4] turn end in the event stream is the done marker');
{
  let done = readCopilotDone(SID);
  ok('no done marker while the turn is running', done === null, JSON.stringify(done));
  const at = Date.now();
  writeEvents([
    event('session.start', { sessionId: SID, context: { cwd: WS } }, now - 60_000),
    event('user.message', { content: 'first task' }, now - 50_000),
    event('assistant.turn_start', { turnId: '0' }, now - 49_000),
    event('assistant.message', { model: 'gpt-5-mini', content: 'done', turnId: '0' }, now - 45_000),
    event('assistant.turn_end', { turnId: '0' }, now - 45_000),
    event('user.message', { content: 'run the tests' }, now - 10_000),
    event('assistant.turn_start', { turnId: '1' }, now - 9_000),
    event('assistant.turn_end', { turnId: '1' }, at),
  ]);
  done = readCopilotDone(SID);
  ok('turn end becomes doneAt', done && done.doneAt === at, JSON.stringify(done));
  const viaReporter = sessionsMod.readReporterDone(WS, 'copilot', SID);
  ok('the server done path reads it too', viaReporter && viaReporter.doneAt === at, JSON.stringify(viaReporter));
}

/* [5] task ledger --------------------------------------------------------------------------------- */
head('[5] ledger: one row per turn, running while in flight, done after turn end');
{
  const { repo, close } = openDatabase(path.join(TMP, 'test.db'));
  repo.upsertProject.run({
    id: 'p1', name: 'p1', workspacePath: WS, mainConversationId: null, source: 'report', createdAt: 1,
  });
  const bus = createIngestBus({ repo, hub: { broadcast() {} }, projectName: 'p1', project: 'p1' });
  // The first turn is finished; the second one is not (rewind the event stream to the in-flight state).
  writeEvents([
    event('session.start', { sessionId: SID, context: { cwd: WS } }, now - 60_000),
    event('user.message', { content: 'first task' }, now - 50_000),
    event('assistant.turn_start', { turnId: '0' }, now - 49_000),
    event('assistant.message', { model: 'gpt-5-mini', content: 'done', turnId: '0' }, now - 45_000),
    event('assistant.turn_end', { turnId: '0' }, now - 45_000),
    event('user.message', { content: 'run the tests' }, now - 10_000),
    event('assistant.turn_start', { turnId: '1' }, now - 9_000),
  ]);
  const written = syncCopilotTasks({ bus, repo });
  ok('two turns written', written === 2, String(written));
  // State lives on the task; model and timing live on the run row.
  const t0 = repo.getTask.get(`copilot:${SID}:0`);
  const t1 = repo.getTask.get(`copilot:${SID}:1`);
  const r1 = repo.getTaskRun.get(`copilot:${SID}:1`);
  ok('finished turn is done', Boolean(t0) && t0.state === 'done', t0 && t0.state);
  ok('in-flight turn is running', Boolean(t1) && t1.state === 'running', t1 && t1.state);
  ok('title is that turn user words', Boolean(t1) && t1.title === 'run the tests', t1 && t1.title);
  ok('model is the CLI model', Boolean(r1) && r1.model === 'gpt-5-mini', r1 && r1.model);
  close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
