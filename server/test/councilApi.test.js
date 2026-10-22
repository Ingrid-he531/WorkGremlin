/**
 * Council HTTP API self-check — real Express router + real repo + a temp DB; only the orchestrator is
 * fake (starting it really would spawn CLIs).
 *
 * This file pins the request contract and the "never fabricate / never silently degrade" rules:
 *   · unknown floors or a floor whose CLI is missing → reject the whole request, listing why;
 *   · roles must be exactly one moderator, one main, at least one reviewer, all distinct floors;
 *   · unreadable material → reject and name the file (silently skipping makes the user believe it was
 *     read);
 *   · a running meeting cannot be deleted;
 *   · detail returns assembled RoundResults, the plan, and the report without mixing them up.
 *
 * Run: `npm run test:council-api`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const express = require('express');

const { openDatabase } = require('../src/db');
const { createCouncilRouter } = require('../src/http/routes/council');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-council-api-'));
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));

/** Four floors; 8F has no CLI so the "cannot start it" rejection has a real target. */
const FLOORS = [
  { floorId: '1F', name: 'CodeBuddy', agent: 'codebuddy', ready: true, cliPath: '/usr/bin/codebuddy', reason: '' },
  { floorId: '4F', name: 'Claude Code', agent: 'claude', ready: true, cliPath: '/usr/bin/claude', reason: '' },
  { floorId: '7F', name: 'Kilo Code', agent: 'kilo', ready: true, cliPath: '/usr/bin/kilo', reason: '' },
  { floorId: '8F', name: 'OpenCode', agent: 'opencode', ready: false, cliPath: null, reason: '没找到命令行可执行文件' },
];

const orch = {
  started: [],
  active: new Set(),
  cancelled: [],
  start(id) {
    this.started.push(id);
    return Promise.resolve(null);
  },
  cancel(id) {
    if (!this.active.has(id)) return false;
    this.active.delete(id);
    this.cancelled.push(id);
    return true;
  },
  activeIds() {
    return [...this.active];
  },
  /** Set by the tests that exercise the working indicator; null means nothing is in flight. */
  progress: new Map(),
  progressOf(id) {
    return this.progress.get(id) || null;
  },
};

/** Preflight is a real model call, so the API test stubs it; individual cases override `probeBehavior`. */
const probeCalls = [];
let probeBehavior = () => null;
const probeFloors = async (floorIds, opts) => {
  probeCalls.push({ floorIds: [...floorIds], models: { ...(opts && opts.models) } });
  return floorIds.map((floorId) => {
    const forced = probeBehavior(floorId, opts);
    if (forced) return { floorId, ok: false, model: null, cliPath: null, status: 'failed', error: forced, errorKind: 'model', durationMs: 1, cached: false };
    return {
      floorId,
      ok: true,
      model: (opts && opts.models && opts.models[floorId]) || null,
      cliPath: (FLOORS.find((f) => f.floorId === floorId) || {}).cliPath || null,
      status: 'ok',
      error: null,
      errorKind: null,
      durationMs: 1,
      cached: false,
    };
  });
};

const app = express();
app.use(express.json());
app.use(
  '/api/v1',
  createCouncilRouter({
    repo,
    orchestrator: orch,
    deps: { listFloors: () => FLOORS, probeFloors },
  })
);

const post = (p, body) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const get = (p) => fetch(`${base}${p}`);
const del = (p) => fetch(`${base}${p}`, { method: 'DELETE' });

let base = '';
let server = null;

const valid = (over = {}) => ({
  topic: '要不要把 A 方案换成 B 方案？',
  moderator: '4F',
  main: '1F',
  reviewers: ['7F'],
  ...over,
});

(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;

  /* ------------------------------------------------------------ floors */
  head('available floors and the shared vocabulary');
  {
    const res = await get('/councils/floors');
    const body = await res.json();
    ok('200', res.status === 200, String(res.status));
    ok('four floors are listed', body.floors.length === 4, String(body.floors.length));
    ok('a floor without its CLI is ready=false', body.floors.find((f) => f.floorId === '8F').ready === false);
    ok('and says why (the UI must show a reason, not just "unavailable")',
      Boolean(body.floors.find((f) => f.floorId === '8F').reason));
    ok('roles are published', body.defaults.roles.join(',') === 'moderator,main,reviewer', JSON.stringify(body.defaults.roles));
    ok('severities / stances are published',
      body.defaults.severities.join(',') === 'blocker,major,minor,nit' &&
        body.defaults.stances.join(',') === 'reject,revise,accept');
    ok('the score weights are published (the UI must not hard-code another copy)',
      body.defaults.severityWeights.blocker === 25 && body.defaults.conflictWeight === 10 && body.defaults.scoreMax === 100);
    ok('round defaults are published',
      body.defaults.maxRounds >= 1 && body.defaults.maxRoundsLimit >= body.defaults.maxRounds);
    ok('material byte limits are published', body.defaults.materialMaxBytes > 0 && body.defaults.materialTotalMaxBytes > 0);
    ok('turn timeouts are published', body.defaults.turnTimeoutMs > 0 && body.defaults.workspaceTurnTimeoutMs >= 60_000);
  }

  /* ------------------------------------------------------------ preflight endpoint */
  head('preflight: the UI can ask before creating a meeting');
  {
    probeBehavior = () => null;
    probeCalls.length = 0;
    const res = await post('/councils/preflight', { floors: ['4F', '1F'], models: { '1F': 'deepseek-v4.1-flash' } });
    const body = await res.json();
    ok('200', res.status === 200, String(res.status));
    ok('ok=true when every floor answers', body.ok === true, JSON.stringify(body));
    ok('one result per requested floor', body.results.length === 2, String(body.results.length));
    ok('the per-seat model reached the probe', probeCalls.at(-1).models['1F'] === 'deepseek-v4.1-flash', JSON.stringify(probeCalls.at(-1)));

    probeBehavior = (floorId) => (floorId === '1F' ? '401 You need to sign in to use this model' : null);
    const bad = await post('/councils/preflight', { floors: ['4F', '1F'] });
    const badBody = await bad.json();
    ok('ok=false when one floor fails', badBody.ok === false, JSON.stringify(badBody));
    ok('the failure is attached to that floor',
      badBody.results.find((r) => r.floorId === '1F').ok === false, JSON.stringify(badBody));
    probeBehavior = () => null;
  }

  /* ------------------------------------------------------------ rejection */
  head('start: these requests must be rejected');
  {
    const cases = [
      [{ moderator: '4F', main: '1F', reviewers: ['7F'] }, 'no topic', '议题不能是空的'],
      [valid({ topic: '   ' }), 'blank topic', '议题不能是空的'],
      [{ topic: 'X', main: '1F', reviewers: ['7F'] }, 'no moderator', '必须指定主持人'],
      [{ topic: 'X', moderator: '4F', reviewers: ['7F'] }, 'no main', '必须指定主答'],
      [valid({ reviewers: [] }), 'no reviewer', '至少需要一位评审'],
      [valid({ main: '4F' }), 'moderator and main are the same floor', '主持人和主答不能是同一个楼层'],
      [valid({ reviewers: ['4F'] }), 'the moderator doubles as reviewer', '主持人不能再兼任评审'],
      [valid({ reviewers: ['1F'] }), 'the main doubles as reviewer', '主答不能再兼任评审'],
      [valid({ reviewers: ['9F'] }), 'floor not on the whitelist', '请不了'],
      [valid({ reviewers: ['8F'] }), 'floor whose CLI is missing', '请不动'],
    ];
    for (const [body, why, needle] of cases) {
      const res = await post('/councils', body);
      const r = await res.json();
      ok(`reject: ${why}`, res.status === 400 && r.ok === false && String(r.error.message).includes(needle),
        `${res.status} ${JSON.stringify(r).slice(0, 140)}`);
    }
    ok('no half-built meeting was left behind', repo.listCouncils(50).length === 0, String(repo.listCouncils(50).length));
    ok('the orchestrator was never started', orch.started.length === 0);
  }

  head('start: duplicate reviewers are collapsed, not counted twice');
  {
    const res = await post('/councils', valid({ reviewers: ['7F', '7F'], maxRounds: 1 }));
    ok('201', res.status === 201, String(res.status));
    const r = await res.json();
    const reviewers = repo.listParticipants(r.council.id).filter((p) => p.role === 'reviewer');
    ok('one reviewer row, not two', reviewers.length === 1, String(reviewers.length));
    await del(`/councils/${r.council.id}`);
  }

  head('start: workspace validation');
  {
    const doc = path.join(TMP, 'not-a-dir.txt');
    fs.writeFileSync(doc, 'x');
    const cases = [
      ['relative path', 'relative/path'],
      ['nonexistent directory', path.join(TMP, 'no-such-dir-xyz')],
      ['a file, not a directory', doc],
    ];
    for (const [why, workspacePath] of cases) {
      const res = await post('/councils', valid({ workspacePath }));
      const r = await res.json();
      ok(`reject: workspace ${why}`, res.status === 400 && String(r.error.message).includes('工作目录'));
      ok(`the error echoes the path (${why})`, String(r.error.message).includes(workspacePath));
    }
    const tilde = await post('/councils', valid({ workspacePath: '~/绝对不存在的工程目录-xyz' }));
    const tr = await tilde.json();
    ok('~ is expanded to the home directory',
      tilde.status === 400 && String(tr.error.message).includes(os.homedir()) && !String(tr.error.message).includes('~'),
      String(tr.error.message));
    ok('still no meeting was built', repo.listCouncils(50).length === 0);
  }

  head('start: an unreadable material file rejects the whole request');
  {
    const res = await post('/councils', valid({ files: ['/tmp/这个文件肯定不存在-9f3a.txt'] }));
    const r = await res.json();
    ok('400', res.status === 400, String(res.status));
    ok('the file is named', String(r.error.message).includes('这个文件肯定不存在'), String(r.error.message));
    ok('nothing was silently skipped', repo.listCouncils(50).length === 0);
  }

  head('start: preflight refuses a floor that cannot speak');
  {
    probeBehavior = (floorId) =>
      floorId === '1F' ? '400 Copilot: The requested model is not supported.' : null;
    const before = repo.listCouncils(50).length;
    const res = await post('/councils', valid());
    const r = await res.json();
    ok('400', res.status === 400, String(res.status));
    ok('the dead floor is named', String(r.error.message).includes('1F'), String(r.error.message));
    ok('the provider reason is echoed', String(r.error.message).includes('model is not supported'), String(r.error.message));
    ok('no meeting was built', repo.listCouncils(50).length === before);
    probeBehavior = () => null;
  }

  head('start: per-seat model reaches preflight and is persisted');
  {
    probeCalls.length = 0;
    const res = await post('/councils', valid({ models: { '1F': 'deepseek-v4.1-flash', '7F': '' } }));
    const r = await res.json();
    ok('201', res.status === 201, `${res.status} ${JSON.stringify(r).slice(0, 120)}`);
    ok('preflight received the model', probeCalls.at(-1).models['1F'] === 'deepseek-v4.1-flash', JSON.stringify(probeCalls.at(-1)));
    ok('a blank model is not sent', !('7F' in probeCalls.at(-1).models), JSON.stringify(probeCalls.at(-1)));
    const seat = repo.listParticipants(r.council.id).find((p) => p.floor_id === '1F');
    ok('the participant row stores it', seat && seat.model === 'deepseek-v4.1-flash', JSON.stringify(seat));
    await del(`/councils/${r.council.id}`);
  }

  /* ------------------------------------------------------------ success */
  head('start: persist, then launch');
  let id = null;
  {
    const doc = path.join(TMP, '说明.txt');
    fs.writeFileSync(doc, '这是背景材料的正文。');
    const res = await post('/councils', valid({ files: [doc], maxRounds: 2, reviewers: ['7F', '1F', '7F'] }));
    // Note: the main floor in reviewers is rejected; use the clean shape below instead.
    ok('a reviewer that is also the main is rejected before anything is stored', res.status === 400);
  }
  {
    const doc = path.join(TMP, '说明.txt');
    const res = await post('/councils', valid({ files: [doc], maxRounds: 2 }));
    const r = await res.json();
    id = r.council && r.council.id;
    ok('201', res.status === 201, String(res.status));
    ok('the meeting is returned', Boolean(id), JSON.stringify(r).slice(0, 140));
    ok('status starts as draft (the orchestrator has only just been called)', r.council.status === 'draft', r.council.status);
    ok('the topic is stored verbatim', r.council.topic === '要不要把 A 方案换成 B 方案？');
    ok('max_rounds follows the request', r.council.max_rounds === 2, String(r.council.max_rounds));
    ok('no workspace -> NULL, not an empty string', r.council.workspace_path === null, String(r.council.workspace_path));
    ok('the orchestrator was started', orch.started.includes(id));

    const ps = repo.listParticipants(id);
    ok('three participants with the right roles',
      ps.length === 3 &&
        ps.map((p) => `${p.floor_id}:${p.role}`).join(',') === '4F:moderator,1F:main,7F:reviewer',
      JSON.stringify(ps.map((p) => `${p.floor_id}:${p.role}`)));
    ok('the CLI path used at creation is recorded', ps[2].cli_path === '/usr/bin/kilo', String(ps[2].cli_path));
    ok('the agent name is recorded', ps[0].agent === 'claude' && ps[1].agent === 'codebuddy');

    const ms = repo.listMaterials(id);
    ok('the material is stored in full (what was fed in stays auditable)',
      ms.length === 1 && ms[0].content === '这是背景材料的正文。');
    ok('material byte count recorded', ms[0].bytes_included === Buffer.byteLength('这是背景材料的正文。', 'utf8'));
  }

  head('start: workspace mode and maxRounds clamping');
  {
    const ws = path.join(TMP, 'real-project');
    fs.mkdirSync(ws, { recursive: true });
    const res = await post('/councils', valid({ workspacePath: ws, maxRounds: 999 }));
    const r = await res.json();
    ok('201', res.status === 201, `${res.status} ${JSON.stringify(r).slice(0, 120)}`);
    ok('the absolute workspace is stored', r.council.workspace_path === ws, String(r.council.workspace_path));
    ok('maxRounds is clamped to the published limit', r.council.max_rounds === 8, String(r.council.max_rounds));
    const detail = await (await get(`/councils/${r.council.id}`)).json();
    ok('detail returns the same workspace', detail.council.workspace_path === ws);
    await del(`/councils/${r.council.id}`);
  }
  {
    const res = await post('/councils', valid({ maxRounds: 0 }));
    const r = await res.json();
    ok('an invalid maxRounds falls back to the default (not 0)', r.council.max_rounds === 3, String(r.council.max_rounds));
    await del(`/councils/${r.council.id}`);
  }

  head('start: oversized materials are truncated, and the fact is stored');
  {
    const big = path.join(TMP, '大文件.txt');
    fs.writeFileSync(big, 'x'.repeat(200 * 1024));
    const res = await post('/councils', valid({ files: [big] }));
    const r = await res.json();
    const m = repo.listMaterials(r.council.id)[0];
    ok('201 (truncation is not an error)', res.status === 201, String(res.status));
    ok('truncated=1', m.truncated === 1);
    ok('bytesTotal is the real size', m.bytes_total === 200 * 1024, String(m.bytes_total));
    ok('only 64KB is included', m.bytes_included === 64 * 1024, String(m.bytes_included));
    ok('content length matches bytes_included', Buffer.byteLength(m.content, 'utf8') === m.bytes_included);
    await del(`/councils/${r.council.id}`);
  }

  /* ------------------------------------------------------------ detail */
  head('detail: rounds, RoundResults, plan, report, materials, participants, live');
  {
    repo.upsertRound({
      councilId: id,
      roundNo: 0,
      kind: 'plan',
      version: null,
      proposalText: null,
      diffFromPrev: null,
      proposalFrom: '4F',
      moderatorJson: JSON.stringify({ parsed: true, breakdown: ['拆解 A'], assignments: [], reviewFocus: [] }),
      statsJson: null,
      startedAt: 1,
      endedAt: 2,
    });
    repo.upsertRound({
      councilId: id,
      roundNo: 1,
      kind: 'debate',
      version: 'v1',
      proposalText: '方案正文',
      diffFromPrev: null,
      proposalFrom: '1F',
      moderatorJson: JSON.stringify({
        consensus: ['一致'],
        openIssues: [],
        conflicts: [],
        revisionDirectives: ['【针对 X】必须改；验收标准：有。'],
        convergenceScore: 75,
      }),
      statsJson: JSON.stringify({ total: 1, score: 75, bySeverity: { blocker: 1, major: 0, minor: 0, nit: 0 }, conflicts: 0 }),
      startedAt: 3,
      endedAt: 4,
    });
    repo.insertReviews(id, 1, [
      { reviewer: '7F', severity: 'blocker', dimension: '安全', issue: '缺鉴权', evidence: null, suggestion: '加中间件', stance: 'reject' },
    ], 5);
    repo.insertUtterance({ councilId: id, roundNo: 0, floorId: 'system', phase: 'brief', content: '议题原文', status: 'ok' });
    repo.insertUtterance({ councilId: id, roundNo: 1, floorId: '1F', phase: 'proposal', content: '方案正文', status: 'ok', model: 'm1', inputTokens: 10, outputTokens: 2 });
    repo.insertReport({
      councilId: id,
      adjudicationJson: JSON.stringify({ decision: 'approve_with_changes' }),
      adjudicationText: '裁决原文',
      finalDraftText: '最终稿',
      changeNotes: '说明',
      reportJson: JSON.stringify({ schema: 'workgremlin.council.report/v1', summary: { warnings: [] } }),
      filesJson: JSON.stringify(['/tmp/report.json']),
      createdAt: 6,
    });

    const res = await get(`/councils/${id}`);
    const r = await res.json();
    ok('200', res.status === 200, String(res.status));
    ok('raw rounds include the plan and the debate', r.rounds.length === 2 && r.rounds[0].kind === 'plan' && r.rounds[1].kind === 'debate');
    ok('roundResults contain only debate rounds', r.roundResults.length === 1 && r.roundResults[0].round === 1);
    ok('RoundResult proposal comes from the round row',
      r.roundResults[0].proposal.version === 'v1' && r.roundResults[0].proposal.content === '方案正文');
    ok('RoundResult reviews come from council_reviews (reviewer assigned by the server)',
      r.roundResults[0].reviews.length === 1 && r.roundResults[0].reviews[0].reviewer === '7F');
    ok('RoundResult moderator.convergenceScore is the archived server score',
      r.roundResults[0].moderator.convergenceScore === 75);
    ok('the plan is returned separately (parsed JSON)', r.plan && r.plan.parsed === true && r.plan.breakdown[0] === '拆解 A');
    ok('the report and its files are returned', r.report.schema === 'workgremlin.council.report/v1' && r.reportFiles[0] === '/tmp/report.json');
    ok('utterances include the brief and the proposal', r.utterances.length === 2 && r.utterances[0].phase === 'brief');
    ok('materials still carry their content', r.materials.length === 1 && Boolean(r.materials[0].content));
    ok('participants come back with roles', r.participants.length === 3);
    ok('live=false while not active', r.live === false);
    ok('progress=null while nothing is in flight', r.progress === null);
    ok('no vote-era columns survive on the council row', !('threshold' in r.council) && !('mode' in r.council));

    orch.active.add(id);
    orch.progress.set(id, { roundNo: 1, phase: 'review', floors: ['7F'], startedAt: 10 });
    const live = await (await get(`/councils/${id}`)).json();
    ok('live=true while the orchestrator says it is active', live.live === true);
    ok('detail returns the in-flight progress (round/phase/floors)',
      live.progress.roundNo === 1 && live.progress.phase === 'review' && live.progress.floors[0] === '7F',
      JSON.stringify(live.progress));
    orch.progress.delete(id);
  }

  head('report endpoint');
  {
    const res = await get(`/councils/${id}/report`);
    const r = await res.json();
    ok('200', res.status === 200, String(res.status));
    ok('parsed adjudication', r.adjudication.decision === 'approve_with_changes');
    ok('final draft and change notes', r.finalDraft === '最终稿' && r.changeNotes === '说明');
    ok('files', r.files.length === 1 && r.files[0] === '/tmp/report.json');
    ok('the report body is returned', r.report.schema === 'workgremlin.council.report/v1');
    ok('createdAt is the stored timestamp, not the request time', r.createdAt === 6, String(r.createdAt));
    ok('no vote-era fields were resurrected', !('threshold' in r) && !('tally' in r));
    const missing = await get('/councils/nope/report');
    ok('unknown council -> 404', missing.status === 404, String(missing.status));
  }
  {
    const noReport = await post('/councils', valid({ maxRounds: 1 }));
    const noReportId = (await noReport.json()).council.id;
    const res = await get(`/councils/${noReportId}/report`);
    ok('a meeting without a report -> 404 "还没有报告"', res.status === 404);
    const body = await res.json();
    ok('the message distinguishes it from a missing meeting', String(body.error.message).includes('报告'));
    orch.active.delete(noReportId);
    await del(`/councils/${noReportId}`);
  }

  head('list and 404');
  {
    const r = await (await get('/councils')).json();
    ok('the list has the remaining meeting', r.councils.length === 1 && r.councils[0].id === id, String(r.councils.length));
    const nf = await get('/councils/查无此会');
    ok('unknown council -> 404', nf.status === 404, String(nf.status));
    ok('404 body shape', (await nf.json()).error.message === '没有这场会');
  }

  /* ------------------------------------------------------------ cancel / delete */
  head('cancel');
  {
    orch.active.add(id);
    const r = await (await post(`/councils/${id}/cancel`)).json();
    ok('active -> cancelled=true', r.cancelled === true);
    ok('the orchestrator received the cancel', orch.cancelled.includes(id));
    const again = await (await post(`/councils/${id}/cancel`)).json();
    ok('cancelling again -> cancelled=false (not an error)', again.cancelled === false);
    ok('unknown council -> 404', (await post('/councils/查无此会/cancel')).status === 404);
  }

  head('delete: a running meeting must be cancelled first');
  {
    orch.active.add(id);
    const res = await del(`/councils/${id}`);
    const r = await res.json();
    ok('active -> 409', res.status === 409, String(res.status));
    ok('the message tells the user to cancel first', /先取消/.test(String(r.error.message)), String(r.error.message));
    ok('the meeting still exists', repo.getCouncil(id) !== null);

    orch.active.delete(id);
    const res2 = await del(`/councils/${id}`);
    ok('after it stops -> 200', res2.status === 200, String(res2.status));
    ok('the meeting is gone', repo.getCouncil(id) === null);
    ok('child rows are gone too',
      repo.listUtterances(id).length === 0 &&
        repo.listRounds(id).length === 0 &&
        repo.listReviews(id).length === 0 &&
        repo.listMaterials(id).length === 0 &&
        repo.listParticipants(id).length === 0 &&
        repo.getReport(id) === null);
    ok('deleting an unknown council -> 404', (await del('/councils/查无此会')).status === 404);
    ok('the list is empty', repo.listCouncils(50).length === 0);
  }

  server.close();
  close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${fail ? '✗' : '✓'} council-api: ${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
