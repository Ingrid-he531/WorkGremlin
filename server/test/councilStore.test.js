/**
 * Council persistence self-check — real SQLite (a temp DB) + the real repo, no mocks.
 *
 * Three things are pinned here:
 *   1. The new tables build and the column names line up (schema.sql is hand-written; a typo blows up here first).
 *   2. **Unavailable values stay NULL, never 0** — unreadable tokens are NULL so the UI can show "—";
 *      writing 0 would claim "used nothing", which is fabrication.
 *   3. Isolation: deleting one council removes every child row; a hard-killed run is honestly marked
 *      failed at startup; a legacy (vote-era) DB is dropped wholesale rather than half-read.
 *
 * Run: `npm run test:council-store`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');

const { openDatabase } = require('../src/db');

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
const head = (t) => console.log(`\n${t}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-council-store-'));
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));

const AT = 1_700_000_000_000;
const mk = (id, extra = {}) =>
  repo.createCouncil({ id, topic: `topic ${id}`, maxRounds: 3, createdAt: AT, ...extra });

/* ------------------------------------------------------------ create / read */
head('create and read back');
{
  const c = mk('c1');
  ok('createCouncil returns the stored row', c && c.id === 'c1');
  ok('starts as draft', c.status === 'draft', c.status);
  ok('round_current starts at 0', c.round_current === 0);
  ok('verdict / ended_at start NULL', c.verdict === null && c.ended_at === null);
  ok('workspace_path defaults to NULL (temp dir), not an empty string', c.workspace_path === null, String(c.workspace_path));
  ok('getCouncil reads it back', repo.getCouncil('c1').topic === 'topic c1');
  ok('unknown id returns null (does not throw)', repo.getCouncil('nope') === null);
}
{
  mk('c2', { workspacePath: '/home/me/proj' });
  ok('workspace_path is stored when given', repo.getCouncil('c2').workspace_path === '/home/me/proj');
  mk('c3', { workspacePath: '' });
  ok('an empty workspace is normalized to NULL', repo.getCouncil('c3').workspace_path === null);
  const list = repo.listCouncils(10);
  ok('list returns every council, newest first', list.length === 3 && list.every((r) => r.id));
  ok('limit is clamped to a sane range', repo.listCouncils(0).length >= 1 && repo.listCouncils(1e9).length === 3);
}

/* ------------------------------------------------------------ participants */
head('participants and roles');
{
  repo.insertParticipant({ councilId: 'c1', floorId: '4F', role: 'moderator', agent: 'claude', cliPath: '/usr/bin/claude' });
  repo.insertParticipant({ councilId: 'c1', floorId: '1F', role: 'main', agent: 'codebuddy', cliPath: '/usr/bin/codebuddy' });
  repo.insertParticipant({ councilId: 'c1', floorId: '7F', role: 'reviewer', agent: 'kilo', cliPath: null });
  const ps = repo.listParticipants('c1');
  ok(
    'display order is seat order (moderator, main, then reviewers by floor)',
    ps.length === 3 && ps.map((p) => `${p.floor_id}:${p.role}`).join(',') === '4F:moderator,1F:main,7F:reviewer',
    JSON.stringify(ps.map((p) => `${p.floor_id}:${p.role}`)),
  );
  ok('cli_path is preserved for troubleshooting', ps[0].cli_path === '/usr/bin/claude');
  ok('initial status = pending', ps[1].status === 'pending');
  repo.setParticipantStatus('c1', '1F', 'failed', 'spawn ENOENT');
  const one = repo.listParticipants('c1')[1];
  ok('raw failure text is stored verbatim', one.status === 'failed' && one.error === 'spawn ENOENT');
}

/* ------------------------------------------------------------ materials */
head('inlined materials');
{
  repo.insertMaterial({ councilId: 'c1', ord: 0, path: '/tmp/a.txt', bytesTotal: 100, bytesIncluded: 100, truncated: 0, content: 'A' });
  repo.insertMaterial({ councilId: 'c1', ord: 1, path: '/tmp/big.txt', bytesTotal: 999999, bytesIncluded: 65536, truncated: 1, content: 'B' });
  const ms = repo.listMaterials('c1');
  ok('sorted by ord', ms.length === 2 && ms[0].path === '/tmp/a.txt' && ms[1].path === '/tmp/big.txt');
  ok('truncation is recorded (original size != inlined size)', ms[1].truncated === 1 && ms[1].bytes_total === 999999 && ms[1].bytes_included === 65536);
}
{
  repo.insertMaterial({ councilId: 'c1', ord: 2, path: '/tmp/gone.txt', bytesTotal: null, bytesIncluded: 0, truncated: 0, content: null });
  const m = repo.listMaterials('c1')[2];
  ok('unreadable file: bytes_total stays NULL, **not 0**', m.bytes_total === null, String(m.bytes_total));
}

/* ------------------------------------------------------------ rounds */
head('rounds: upsert per round, started_at is not overwritten');
{
  repo.upsertRound({
    councilId: 'c1', roundNo: 0, kind: 'plan', version: null, proposalText: null,
    diffFromPrev: null, proposalFrom: '4F', moderatorJson: '{"parsed":true}', statsJson: null,
    startedAt: AT, endedAt: AT + 10,
  });
  repo.upsertRound({
    councilId: 'c1', roundNo: 1, kind: 'debate', version: 'v1', proposalText: 'proposal one',
    diffFromPrev: null, proposalFrom: '1F', moderatorJson: null, statsJson: null,
    startedAt: AT + 100, endedAt: null,
  });
  const rs = repo.listRounds('c1');
  ok('two rounds come back in order', rs.length === 2 && rs[0].round_no === 0 && rs[1].round_no === 1);
  ok('round 0 is the moderator plan', rs[0].kind === 'plan' && rs[0].proposal_from === '4F');
  ok('the debate round keeps its version', rs[1].version === 'v1' && rs[1].proposal_text === 'proposal one');

  repo.upsertRound({
    councilId: 'c1', roundNo: 1, kind: 'debate', version: 'v1', proposalText: 'proposal one',
    diffFromPrev: 'changed X', proposalFrom: '1F',
    moderatorJson: '{"consensus":[]}', statsJson: '{"score":80}',
    startedAt: AT + 999, endedAt: AT + 200,
  });
  const again = repo.listRounds('c1')[1];
  ok('started_at keeps the first write (999 does not overwrite)', again.started_at === AT + 100, String(again.started_at));
  ok('ended_at is filled in later', again.ended_at === AT + 200);
  ok('moderator_json / stats_json / diff land', again.moderator_json === '{"consensus":[]}' && again.stats_json === '{"score":80}' && again.diff_from_prev === 'changed X');
  ok('still two rounds (upsert, not insert)', repo.listRounds('c1').length === 2);
}

/* ------------------------------------------------------------ reviews */
head('review points');
{
  repo.delReviewsFromRound('c1', 1);
  const n = repo.insertReviews('c1', 1, [
    { reviewer: '7F', severity: 'blocker', dimension: '安全', issue: 'no auth', evidence: 'line 4', suggestion: 'add auth', stance: 'reject' },
    { reviewer: '8F', severity: 'nit', dimension: '文档', issue: 'typo', evidence: null, suggestion: 'fix it', stance: 'accept' },
  ], AT + 300);
  ok('insertReviews reports how many landed', n === 2);
  const rs = repo.listReviews('c1');
  ok('ordered by round, reviewer, ord', rs.length === 2 && rs[0].reviewer === '7F' && rs[1].reviewer === '8F');
  ok('severity / stance / dimension survive', rs[0].severity === 'blocker' && rs[0].stance === 'reject' && rs[0].dimension === '安全');
  ok('missing evidence stays NULL (not an empty string)', rs[1].evidence === null, String(rs[1].evidence));
  repo.delReviewsFromRound('c1', 1);
  ok('a round can be cleared before re-inserting', repo.listReviews('c1').length === 0);
}

/* ------------------------------------------------------------ utterances */
head('utterances: unavailable values stay NULL');
{
  repo.insertUtterance({
    councilId: 'c1', roundNo: 0, floorId: 'system', phase: 'brief', content: 'topic text', status: 'ok',
  });
  repo.insertUtterance({
    councilId: 'c1', roundNo: 1, floorId: '7F', phase: 'review', content: 'looks risky',
    model: 'gpt-5.1', status: 'ok',
    inputTokens: 100, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    parseDropped: 2, startedAt: AT + 100, endedAt: AT + 150, durationMs: 50,
  });
  repo.insertUtterance({
    councilId: 'c1', roundNo: 1, floorId: '8F', phase: 'review', content: null, model: null,
    status: 'timeout', error: '120s 未返回，已杀进程',
    startedAt: AT + 100, endedAt: AT + 220, durationMs: 120000,
  });
  const us = repo.listUtterances('c1');
  ok('ordered by round then insertion id', us.length === 3 && us[0].phase === 'brief' && us[2].floor_id === '8F');
  ok('phase, model, parse_dropped round-trip', us[1].phase === 'review' && us[1].model === 'gpt-5.1' && us[1].parse_dropped === 2);
  ok('a missing token count is NULL, **not 0**', us[1].output_tokens === null, String(us[1].output_tokens));
  ok('failure text is kept verbatim', us[2].status === 'timeout' && String(us[2].error).includes('120s'));
  ok('duration is recorded when known', us[1].duration_ms === 50);
}

/* ------------------------------------------------------------ report */
head('report row');
{
  const saved = repo.insertReport({
    councilId: 'c1',
    adjudicationJson: '{"decision":"approve_with_changes"}',
    adjudicationText: 'raw adjudication text',
    finalDraftText: 'final draft',
    changeNotes: 'notes',
    reportJson: '{"schema":"workgremlin.council.report/v1"}',
    filesJson: '["/tmp/report.json"]',
    createdAt: AT + 400,
  });
  ok('insertReport returns the stored row', saved && saved.council_id === 'c1');
  const got = repo.getReport('c1');
  ok('every field round-trips', got.final_draft_text === 'final draft' && got.change_notes === 'notes' && got.created_at === AT + 400);
  repo.insertReport({ councilId: 'c1', reportJson: '{"schema":"v2"}' });
  ok('a second save upserts (one row per council)', repo.getReport('c1').report_json === '{"schema":"v2"}' && repo.raw.prepare("SELECT COUNT(*) AS c FROM council_reports WHERE council_id='c1'").get().c === 1);
  ok('unknown council has no report', repo.getReport('nope') === null);
}

/* ------------------------------------------------------------ wrap-up */
head('wrap-up: completed / partial are normal, cancelled / failed are not');
{
  ok('markCouncilRunning flips draft once', repo.markCouncilRunning('c1', AT) === true);
  ok('a second flip is refused (cannot pull a running meeting back)', repo.markCouncilRunning('c1', AT) === false);
  const c = repo.finishCouncil('c1', { verdict: 'completed', endedAt: AT + 500 });
  ok('completed -> status=done', c.status === 'done' && c.verdict === 'completed');
  ok('ended_at is stored', c.ended_at === AT + 500);
}
{
  mk('c4');
  repo.markCouncilRunning('c4', AT);
  const c = repo.finishCouncil('c4', { verdict: 'partial', error: 'final phase missing', endedAt: AT + 1 });
  ok('partial is also a normal ending (done, not failed)', c.status === 'done' && c.verdict === 'partial');
}
{
  mk('c5');
  const c = repo.finishCouncil('c5', { verdict: 'cancelled', endedAt: AT + 1 });
  ok('cancelled -> status=cancelled', c.status === 'cancelled' && c.verdict === 'cancelled');
}
{
  mk('c6');
  const c = repo.finishCouncil('c6', { verdict: 'failed', error: 'boom', endedAt: AT + 1 });
  ok('failed -> status=failed and keeps the reason', c.status === 'failed' && c.error === 'boom');
}
{
  mk('cClarify');
  repo.markCouncilRunning('cClarify', AT);
  const c = repo.finishCouncil('cClarify', {
    verdict: 'needs_clarification',
    error: '请给出项目路径',
    endedAt: AT + 1,
  });
  ok('needs_clarification is a normal ending (done)',
    c.status === 'done' && c.verdict === 'needs_clarification');
}

/* ------------------------------------------------------------ startup sweep */
head('startup sweep: a hard-killed run is marked failed honestly');
{
  mk('c7');
  repo.markCouncilRunning('c7', AT);
  const n = repo.failStaleCouncils('server was interrupted; this meeting did not finish', AT + 9999);
  ok('exactly one stale row is swept', n === 1, String(n));
  const c = repo.getCouncil('c7');
  ok('marked failed with the reason (does not pretend to still be live)', c.status === 'failed' && c.verdict === 'failed' && String(c.error).includes('interrupted'));
  ok('finished meetings are untouched', repo.getCouncil('c1').status === 'done' && repo.getCouncil('c5').status === 'cancelled');
  ok('a second sweep finds nothing (idempotent)', repo.failStaleCouncils('x', AT) === 0);
}

/* ------------------------------------------------------------ isolation */
head('isolation: one council deletes cleanly, no orphan rows');
{
  const before = {
    utt: repo.listUtterances('c1').length,
    rounds: repo.listRounds('c1').length,
    mats: repo.listMaterials('c1').length,
    ps: repo.listParticipants('c1').length,
    reviews: repo.listReviews('c1').length,
    report: repo.getReport('c1') !== null,
  };
  ok('child rows exist before the delete', before.utt > 0 && before.rounds > 0 && before.mats > 0 && before.ps > 0 && before.report, JSON.stringify(before));
  ok('deleteCouncil reports success', repo.deleteCouncil('c1') === true);
  ok('the council itself is gone', repo.getCouncil('c1') === null);
  ok('utterances cleared', repo.listUtterances('c1').length === 0);
  ok('rounds cleared', repo.listRounds('c1').length === 0);
  ok('materials cleared', repo.listMaterials('c1').length === 0);
  ok('participants cleared', repo.listParticipants('c1').length === 0);
  ok('reviews cleared', repo.listReviews('c1').length === 0);
  ok('report cleared', repo.getReport('c1') === null);
  ok('deleting a missing council returns false (route maps it to 404)', repo.deleteCouncil('c1') === false);
  ok('other councils are untouched', repo.getCouncil('c2') !== null && repo.getCouncil('c4') !== null);
  const orphans = [
    'council_utterances',
    'council_rounds',
    'council_materials',
    'council_participants',
    'council_reviews',
    'council_reports',
  ]
    .map((t) => repo.raw.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE council_id = 'c1'`).get().c)
    .reduce((a, b) => a + b, 0);
  ok('six child tables keep zero rows', orphans === 0, String(orphans));
}

close();

/* ------------------------------------------------------------ status check migration */
head('status checks: an existing council database is rebuilt without losing evidence');
{
  const statusPath = path.join(TMP, 'status-check.db');
  const old = new Database(statusPath);
  old.exec(`
    CREATE TABLE councils (
      id             TEXT PRIMARY KEY,
      topic          TEXT NOT NULL,
      workspace_path TEXT,
      status         TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','running','done','failed','cancelled')),
      max_rounds     INTEGER NOT NULL,
      round_current  INTEGER NOT NULL DEFAULT 0,
      verdict        TEXT
                     CHECK (verdict IS NULL OR verdict IN ('completed','partial','cancelled','failed')),
      error          TEXT,
      created_at     INTEGER NOT NULL,
      started_at     INTEGER,
      ended_at       INTEGER
    );
    CREATE TABLE council_participants (
      council_id TEXT NOT NULL,
      floor_id   TEXT NOT NULL,
      role       TEXT NOT NULL CHECK (role IN ('moderator','main','reviewer')),
      agent      TEXT NOT NULL,
      cli_path   TEXT,
      status     TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','ok','failed')),
      error      TEXT,
      PRIMARY KEY (council_id, floor_id)
    );
    CREATE TABLE council_utterances (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      council_id    TEXT NOT NULL,
      round_no      INTEGER NOT NULL,
      floor_id      TEXT NOT NULL,
      phase         TEXT NOT NULL
                    CHECK (phase IN ('brief','plan','proposal','review','moderation','adjudication','final')),
      content       TEXT,
      model         TEXT,
      status        TEXT NOT NULL DEFAULT 'ok'
                    CHECK (status IN ('ok','failed','timeout','unparsed')),
      error         TEXT,
      input_tokens       INTEGER,
      output_tokens      INTEGER,
      cache_read_tokens  INTEGER,
      cache_write_tokens INTEGER,
      parse_dropped INTEGER NOT NULL DEFAULT 0,
      started_at    INTEGER,
      ended_at      INTEGER,
      duration_ms   INTEGER
    );
    CREATE INDEX idx_council_utt ON council_utterances(council_id, round_no, floor_id);
    CREATE INDEX idx_council_utt_floor ON council_utterances(council_id, floor_id);
  `);
  old.prepare(`
    INSERT INTO councils
      (id, topic, workspace_path, status, max_rounds, round_current, verdict, error, created_at, started_at, ended_at)
    VALUES
      ('c_keep', 'history that must survive', '/tmp/project', 'done', 2, 1, 'partial', 'final turn missing', ?, ?, ?)
  `).run(AT, AT + 1, AT + 2);
  old.prepare(`
    INSERT INTO council_participants (council_id, floor_id, role, agent, cli_path, status, error)
    VALUES ('c_keep', '4F', 'moderator', 'claude', '/usr/bin/claude', 'ok', NULL)
  `).run();
  old.prepare(`
    INSERT INTO council_utterances
      (council_id, round_no, floor_id, phase, content, status, started_at, ended_at)
    VALUES ('c_keep', 0, '4F', 'plan', 'old plan text', 'ok', ?, ?)
  `).run(AT + 10, AT + 20);
  old.close();

  const up = openDatabase(statusPath);
  const r2 = up.repo;
  const kept = r2.getCouncil('c_keep');
  ok('the council row survives the CHECK rebuild',
    kept && kept.topic === 'history that must survive' && kept.verdict === 'partial');
  ok('participant and utterance evidence survive',
    r2.listParticipants('c_keep')[0].status === 'ok' &&
      r2.listUtterances('c_keep')[0].content === 'old plan text');

  r2.setParticipantStatus('c_keep', '4F', 'needs_clarification', 'ask for a path');
  r2.insertParticipant({
    councilId: 'c_keep',
    floorId: '1F',
    role: 'main',
    agent: 'codebuddy',
    cliPath: null,
  });
  r2.setParticipantStatus('c_keep', '1F', 'skipped', 'never reached');
  ok('new participant states are accepted after the rebuild',
    r2.listParticipants('c_keep').map((p) => p.status).join(',') === 'needs_clarification,skipped');

  r2.insertUtterance({
    councilId: 'c_keep',
    roundNo: 0,
    floorId: '4F',
    phase: 'plan',
    content: 'new evidence',
    status: 'unparsed',
  });
  ok('the utterance sequence was preserved and AUTOINCREMENT continues',
    r2.listUtterances('c_keep').length === 2 && r2.listUtterances('c_keep')[1].id > 1);
  up.close();
}

/* ------------------------------------------------------------ legacy reset */
// The council feature changed shape before any real data existed. An old DB must be reset wholesale:
// CREATE TABLE IF NOT EXISTS cannot change columns or CHECK constraints, so leaving the old tables
// would make every new query fail.
head('legacy schema: vote-era tables are dropped and rebuilt, not half-read');
{
  const oldPath = path.join(TMP, 'old.db');
  const old = new Database(oldPath);
  old.exec(`
    CREATE TABLE councils (
      id            TEXT PRIMARY KEY,
      topic         TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','running','done','failed','cancelled')),
      threshold     TEXT NOT NULL DEFAULT 'unanimous',
      max_rounds    INTEGER NOT NULL,
      round_current INTEGER NOT NULL DEFAULT 0,
      verdict       TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL,
      ended_at      INTEGER
    );
    CREATE TABLE council_utterances (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      council_id  TEXT NOT NULL,
      round_no    INTEGER NOT NULL,
      floor_id    TEXT NOT NULL,
      vote        TEXT,
      content     TEXT,
      status      TEXT NOT NULL DEFAULT 'ok'
    );
  `);
  old.prepare("INSERT INTO councils (id, topic, max_rounds, created_at) VALUES ('c_old', 'old topic', 2, ?)").run(AT);
  old.prepare("INSERT INTO council_utterances (council_id, round_no, floor_id, vote) VALUES ('c_old', 1, '4F', 'disagree')").run();
  old.close();

  // Upgrade = opening the old DB with the new code.
  const up = openDatabase(oldPath);
  const r2 = up.repo;

  const cols = r2.raw.prepare('PRAGMA table_info(councils)').all().map((c) => c.name);
  ok('old mode/threshold columns are gone', !cols.includes('mode') && !cols.includes('threshold'), cols.join(','));
  ok('new workspace_path column exists', cols.includes('workspace_path'));
  ok('the old council row is gone (no partial migration)', r2.getCouncil('c_old') === null);

  const uc = r2.raw.prepare('PRAGMA table_info(council_utterances)').all().map((c) => c.name);
  ok('the old vote column is gone', !uc.includes('vote'), uc.join(','));
  ok('the new phase/model columns are present', uc.includes('phase') && uc.includes('model'));

  const created = r2.createCouncil({ id: 'c_new', topic: 'new topic', maxRounds: 2, createdAt: AT + 100 });
  ok('a new council can be created after the reset', created && created.id === 'c_new');
  r2.insertParticipant({ councilId: 'c_new', floorId: '4F', role: 'moderator', agent: 'claude', cliPath: null });
  ok('a participant with the new role column lands', r2.listParticipants('c_new')[0].role === 'moderator');
  const fin = r2.finishCouncil('c_new', { verdict: 'completed', endedAt: AT + 200 });
  ok('the new verdict value is accepted by the rebuilt CHECK', fin.verdict === 'completed' && fin.status === 'done');
  up.close();
}

console.log(`\n${fail ? '✗' : '✓'} council-store: ${pass} passed / ${fail} failed`);
// Tear down the temp DB (and its directory) even when the run failed.
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
