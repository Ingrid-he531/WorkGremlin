/**
 * The council state machine, end to end — real SQLite, real repo, real temp dirs; only the CLI calls
 * are fake (`deps.runTurn`).
 *
 * The flow under test (no vote, no threshold, no early stop):
 *   round 0 plan → (round 1..N: proposal → parallel reviews → moderator convergence) → adjudication →
 *   final draft → report archive.
 *
 * What this file pins, beyond the happy path:
 *   · Every round is persisted as a RoundResult, and the convergence score in it is the SERVER'S
 *     number, not the model's `convergenceScore` field.
 *   · A missing/failed/unparseable turn is recorded honestly and never filled in on its behalf.
 *   · Bad news is surfaced as warnings (a moderator failing to record a conflict, an incomplete
 *     review, a final approval that leaves blockers).
 *   · Cancel/shutdown give a definite ending, kill nothing outside the meeting, and always archive
 *     whatever evidence exists — including the early-return and crash paths.
 *   · A user workspace is never written to or deleted; exports land only in the home council dir.
 *   · Office tables stay empty: council participants never become members/tasks.
 *
 * Run: `npm run test:council-orchestrator`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-council-orch-'));
process.env.WORKGREMLIN_HOME = path.join(TMP, 'home');

const { WS_EVENTS } = require('@workgremlin/shared');

const { openDatabase } = require('../src/db');
const { createCouncilOrchestrator, roundResultOf, TMP_PREFIX } = require('../src/council/orchestrator');
const { REPORT_SCHEMA } = require('../src/council/report');

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

const { repo, close } = openDatabase(path.join(TMP, 'test.db'));

let clock = 1_700_000_000_000;
const now = () => (clock += 1_000);

/* ---------------------------------- fake participants ---------------------------------- */

const jsonBlock = (obj) => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const OK = (text) => ({
  status: 'ok',
  text,
  tokens: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 },
  model: 'fake-model',
  error: null,
  durationMs: 5,
  exitCode: 0,
});
const FAIL = (error, status = 'failed') => ({
  status,
  text: '',
  tokens: null,
  model: null,
  error,
  durationMs: 9,
  exitCode: 1,
});

function phaseOf(prompt) {
  if (prompt.includes('议题拆解与评审分工')) return 'plan';
  if (prompt.includes('主答初稿') || prompt.includes('主答修订')) return 'proposal';
  if (prompt.includes('独立评审')) return 'review';
  if (prompt.includes('收敛汇总')) return 'moderation';
  if (prompt.includes('【最终裁决】')) return 'adjudication';
  if (prompt.includes('【最终交付稿】')) return 'final';
  return 'unknown';
}

function defaultReply({ phase, round }) {
  switch (phase) {
    case 'plan':
      return OK(
        `拆解如下。\n${jsonBlock({
          breakdown: ['拆解 A'],
          assignments: [{ reviewer: '7F', focus: '安全' }],
          reviewFocus: ['安全'],
        })}`
      );
    case 'proposal':
      return OK(
        `第 ${round} 版方案正文。\n${jsonBlock({
          version: `v${round}`,
          ...(round > 1 ? { diffFromPrev: `第 ${round} 版按上一轮指令修改` } : {}),
          addressed: [],
        })}`
      );
    case 'review':
      return OK(
        `评审意见。\n${jsonBlock({
          reviews: [
            {
              severity: 'minor',
              dimension: '安全',
              issue: `第 ${round} 轮的小问题`,
              suggestion: '补一行说明',
              stance: 'accept',
            },
          ],
        })}`
      );
    case 'moderation':
      return OK(
        `收敛结果。\n${jsonBlock({
          consensus: ['方向一致'],
          openIssues: [],
          conflicts: [],
          revisionDirectives: ['【针对 小问题】必须补说明；验收标准：方案里有说明。'],
          convergenceScore: 99,
        })}`
      );
    case 'adjudication':
      return OK(`最终裁决。\n${jsonBlock({ decision: 'approve', summary: '可以落地', remainingRisks: [], finalDirectives: [] })}`);
    case 'final':
      return OK(`最终交付稿正文。\n${jsonBlock({ changeNotes: '按裁决整理', addressed: [] })}`);
    default:
      return OK('unknown phase');
  }
}

function makeHarness() {
  const seen = [];
  const held = [];
  const overrides = new Map();
  let holdPredicate = null;

  const fakeChild = () => ({ pid: 2 ** 30, killed: false, once() {} });

  async function runTurn(arg) {
    const floor = String(arg.bin).split('/').pop();
    const prompt = arg.stdin != null ? String(arg.stdin) : String(arg.args[1] || '');
    const m = prompt.match(/第 (\d+)\/(\d+) 轮/);
    const round = m ? Number(m[1]) : 0;
    const phase = phaseOf(prompt);
    if (typeof arg.onChild === 'function') arg.onChild(fakeChild());
    seen.push({ floor, round, phase, prompt, cwd: arg.cwd, agent: arg.agent });

    const answer = () => {
      const spec =
        overrides.get(`${floor}:${phase}`) || overrides.get(floor) || defaultReply;
      const out = typeof spec === 'function' ? spec({ floor, round, phase, prompt }) : spec;
      return out || defaultReply({ floor, round, phase, prompt });
    };
    if (holdPredicate && holdPredicate(phase)) {
      return new Promise((resolve) => held.push(() => resolve(answer())));
    }
    return answer();
  }

  return {
    runTurn,
    seen,
    held,
    set: (key, spec) => overrides.set(key, spec),
    holdOn: (phases) => {
      const set = new Set(Array.isArray(phases) ? phases : [phases]);
      holdPredicate = (phase) => set.has(phase);
    },
    release: () => {
      const list = held.splice(0);
      for (const r of list) r();
    },
    callsOf: (phase) => seen.filter((s) => s.phase === phase),
    countOf: (floor, phase) => seen.filter((s) => s.floor === floor && s.phase === phase).length,
  };
}

const broadcasts = [];
function mkOrchestrator(h, extraDeps = {}) {
  return createCouncilOrchestrator({
    repo,
    broadcast: (project, type, payload) => broadcasts.push({ project, type, payload }),
    deps: {
      runTurn: h.runTurn,
      now,
      cliPathOf: (floorId) => `/fake/${floorId}`,
      mkdtemp: (prefix) => fs.mkdtempSync(path.join(TMP, prefix)),
      ...extraDeps,
    },
  });
}

/** One moderator, one main, N reviewers. */
function newCouncil(id, { maxRounds = 2, workspacePath, reviewerFloors = ['7F'] } = {}) {
  repo.createCouncil({ id, topic: `议题 ${id}`, workspacePath, maxRounds, createdAt: now() });
  repo.insertParticipant({ councilId: id, floorId: '4F', role: 'moderator', agent: 'claude', cliPath: null });
  repo.insertParticipant({ councilId: id, floorId: '1F', role: 'main', agent: 'codebuddy', cliPath: null });
  for (const f of reviewerFloors) {
    repo.insertParticipant({ councilId: id, floorId: f, role: 'reviewer', agent: 'kilo', cliPath: null });
  }
  return id;
}

const waitFor = async (cond, ms = 3_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

const statsOf = (row) => JSON.parse(row.stats_json);
const moderatorOf = (row) => JSON.parse(row.moderator_json);
const reportOf = (id) => {
  const row = repo.getReport(id);
  return row ? JSON.parse(row.report_json) : null;
};

(async () => {
  /* ============================================================ full run */
  head('a full meeting: plan → 2×(proposal, reviews, convergence) → adjudication → final draft');
  {
    const h = makeHarness();
    const id = newCouncil('cFull', { maxRounds: 2 });
    const orch = mkOrchestrator(h);
    const row = await orch.start(id);

    ok('verdict=completed', row.verdict === 'completed', String(row.verdict));
    ok('status=done', row.status === 'done', row.status);
    ok('round_current=2', row.round_current === 2, String(row.round_current));
    ok('no error', row.error === null, String(row.error));

    const rows = repo.listRounds(id);
    ok('three round rows: plan + debate + debate', rows.length === 3, String(rows.length));
    ok('round 0 is the moderator plan', rows[0].round_no === 0 && rows[0].kind === 'plan' && rows[0].proposal_from === '4F');
    ok('round 1 and 2 are debates', rows[1].round_no === 1 && rows[1].kind === 'debate' && rows[2].round_no === 2);
    ok('versions are v1/v2', rows[1].version === 'v1' && rows[2].version === 'v2');
    ok('round 1 has no diff (first proposal)', rows[1].diff_from_prev === null);
    ok('round 2 stores the diff it claims', String(rows[2].diff_from_prev).includes('按上一轮指令修改'));

    const rr1 = roundResultOf(rows[1], repo.listReviews(id).filter((r) => r.round_no === 1));
    const rr2 = roundResultOf(rows[2], repo.listReviews(id).filter((r) => r.round_no === 2));
    ok('RoundResult: proposal version/content/diff match', rr1.round === 1 && rr1.proposal.version === 'v1' && rr1.proposal.content.includes('第 1 版方案正文'));
    ok('RoundResult: one review per round, attributed to the reviewer floor',
      rr1.reviews.length === 1 && rr1.reviews[0].reviewer === '7F' && rr1.reviews[0].severity === 'minor');
    ok('RoundResult: moderator fields are all present',
      Array.isArray(rr1.moderator.consensus) && Array.isArray(rr1.moderator.openIssues) &&
        Array.isArray(rr1.moderator.conflicts) && Array.isArray(rr1.moderator.revisionDirectives));
    ok('RoundResult: convergenceScore is the server number (one minor -> 98), NOT the model\'s 99',
      rr1.moderator.convergenceScore === 98, String(rr1.moderator.convergenceScore));
    ok('RoundResult: raw stats are archived too', rr2.stats && rr2.stats.score === 98 && rr2.stats.bySeverity.minor === 1);

    ok('the loop runs every round (no early stop despite a high score)',
      h.countOf('1F', 'proposal') === 2 && h.countOf('7F', 'review') === 2 && h.countOf('4F', 'moderation') === 2,
      `proposal=${h.countOf('1F', 'proposal')} review=${h.countOf('7F', 'review')} moderation=${h.countOf('4F', 'moderation')}`);
    ok('the plan runs exactly once', h.countOf('4F', 'plan') === 1);
    ok('adjudication runs once, final draft once',
      h.countOf('4F', 'adjudication') === 1 && h.countOf('1F', 'final') === 1);
    ok('round 2 review prompt carries the previous round\'s directive',
      h.callsOf('review').find((s) => s.round === 2).prompt.includes('【针对 小问题】必须补说明'));
    ok('the revision prompt carries the previous directive and proposal version',
      (() => {
        const p = h.callsOf('proposal').find((s) => s.round === 2).prompt;
        return p.includes('【针对 小问题】必须补说明') && p.includes('上一版：v1');
      })());

    const utts = repo.listUtterances(id);
    const phases = new Set(utts.map((u) => u.phase));
    for (const phase of ['brief', 'plan', 'proposal', 'review', 'moderation', 'adjudication', 'final']) {
      ok(`utterance phase ${phase} recorded`, phases.has(phase));
    }
    ok('the brief is a system turn on round 0', utts[0].floor_id === 'system' && utts[0].round_no === 0 && utts[0].phase === 'brief');
    ok('model and tokens are recorded for participant turns',
      utts.filter((u) => u.floor_id !== 'system').every((u) => u.model === 'fake-model' && u.input_tokens === 10 && u.output_tokens === 2));
    ok('no vote column exists / nothing pretends to be a vote', !('vote' in utts[0]));

    ok('every participant ends ok', repo.listParticipants(id).every((p) => p.status === 'ok'),
      JSON.stringify(repo.listParticipants(id).map((p) => `${p.floor_id}:${p.status}`)));

    const report = reportOf(id);
    ok('report persisted', Boolean(report));
    ok('report schema', report.schema === REPORT_SCHEMA);
    ok('report verdict is completed', report.council.verdict === 'completed');
    ok('report final score is the last round\'s server score', report.score.final === 98, String(report.score.final));
    ok('report trend has both rounds', report.score.trend.length === 2 && report.score.trend[0].score === 98);
    ok('report counts both review points', report.summary.reviewCount === 2 && report.summary.blockers === 0);
    ok('report includes plan text and parsed breakdown', report.plan && report.plan.parsed === true && String(report.plan.text).includes('拆解如下'));
    ok('report includes adjudication + final draft + change notes',
      report.adjudication.decision === 'approve' && report.finalDraft.content.includes('最终交付稿正文') && report.finalDraft.changeNotes === '按裁决整理');
    ok('report lists three roles with model and exact tokens',
      report.roles.length === 3 &&
        report.roles.every((r) => r.model === 'fake-model' && r.tokens.exact === true && r.tokens.total > 0));
    ok('no warnings on a clean run', report.summary.warnings.length === 0, JSON.stringify(report.summary.warnings));

    const files = JSON.parse(repo.getReport(id).files_json);
    ok('four files written', files.length === 4, String(files.length));
    ok('every reported file exists on disk', files.every((f) => fs.existsSync(f)));
    ok('files live under councils/<id>/', files.every((f) => f.includes(path.join('councils', 'cFull'))));

    ok('temp dir used and then removed', h.seen[0].cwd.includes(TMP_PREFIX) && !fs.existsSync(h.seen[0].cwd));
    ok('not active any more', orch.activeIds().length === 0);
    ok('broadcasts are council.update events with project=null',
      broadcasts.length > 0 && broadcasts.every((b) => b.type === WS_EVENTS.COUNCIL && b.project === null));
    const finished = broadcasts.find((b) => b.payload.verdict === 'completed');
    ok('the closing broadcast carries verdict + report files',
      finished && finished.payload.status === 'done' && Array.isArray(finished.payload.reportFiles) && finished.payload.reportFiles.length === 4);

    const again = await orch.start(id);
    ok('starting a finished meeting again does not rerun it',
      again.status === 'done' && h.countOf('1F', 'proposal') === 2);
    ok('starting an unknown id returns null', (await orch.start('missing')) === null);
  }

  /* ============================================================ warnings */
  head('a moderator smoothing over a blocker is surfaced, and the score stays server-side');
  {
    const h = makeHarness();
    h.set('7F:review', () =>
      OK(`我反对。\n${jsonBlock({
        reviews: [{ severity: 'blocker', dimension: '安全', issue: '鉴权缺失', suggestion: '加中间件', stance: 'reject' }],
      })}`)
    );
    // The moderator records no conflict and no directive, and claims a score of 100.
    h.set('4F:moderation', () =>
      OK(`都挺好。\n${jsonBlock({ consensus: ['一致'], openIssues: [], conflicts: [], revisionDirectives: [], convergenceScore: 100 })}`)
    );
    h.set('4F:adjudication', () =>
      OK(`通过。\n${jsonBlock({ decision: 'approve', summary: '没问题', remainingRisks: [], finalDirectives: [] })}`)
    );

    const id = newCouncil('cWarn', { maxRounds: 1 });
    const orch = mkOrchestrator(h);
    const row = await orch.start(id);

    ok('the meeting still completes (warnings do not change the verdict)', row.verdict === 'completed', String(row.verdict));
    const r1 = repo.listRounds(id).find((r) => r.round_no === 1);
    ok('the score is computed from the blocker (75), ignoring the model\'s 100', statsOf(r1).score === 75, String(statsOf(r1).score));
    ok('roundResultOf shows the computed score', roundResultOf(r1, repo.listReviews(id)).moderator.convergenceScore === 75);
    const codes = moderatorOf(r1).warnings.map((w) => w.code);
    ok('blockers without directives is flagged', codes.includes('blockers_without_directives'), codes.join(','));
    ok('blockers without openIssues is flagged', codes.includes('blockers_without_open_issues'));
    ok('a reject stance with no conflict is flagged', codes.includes('split_stance_without_conflicts'));

    const reportCodes = reportOf(id).summary.warnings.map((w) => w.code);
    ok('final approve with a remaining blocker is flagged in the report',
      reportCodes.includes('final_accept_with_blockers'), reportCodes.join(','));
  }

  /* ============================================================ progress */
  head('while a turn is in flight the server says who is working');
  {
    const h = makeHarness();
    h.holdOn('plan');
    const id = newCouncil('cProgress', { maxRounds: 1 });
    const orch = mkOrchestrator(h);
    const run = orch.start(id);
    await waitFor(() => h.held.length === 1);

    const p = orch.progressOf(id);
    ok('progressOf reports round 0 / plan / the moderator floor',
      p && p.roundNo === 0 && p.phase === 'plan' && p.floors.includes('4F'), JSON.stringify(p));
    const ev = broadcasts
      .map((b) => b.payload)
      .filter((x) => x && x.councilId === id && x.status === 'running' && x.phase === 'plan')
      .pop();
    ok('a running broadcast carries the same progress',
      Boolean(ev) && ev.roundNo === 0 && ev.floors.includes('4F'), JSON.stringify(ev));

    h.release();
    await run;
    ok('progress is cleared when the meeting ends', orch.progressOf(id) === null);
  }

  /* ============================================================ failures */
  head('a moderator that cannot answer round 0 stops the meeting immediately');
  {
    const h = makeHarness();
    // Mirrors the real 1F failure: the CLI exited 0 but its transcript was cut off mid-JSON.
    h.set('4F:plan', () =>
      FAIL('输出解析不出内容（stdout 120 字节，stderr 0 字节，退出码 0）：{"type":"reasoning"')
    );
    const id = newCouncil('cPlanFail', { maxRounds: 2 });
    const orch = mkOrchestrator(h);
    const row = await orch.start(id);

    ok('verdict=failed (no round completed)', row.verdict === 'failed' && row.status === 'failed', `${row.verdict}/${row.status}`);
    ok('the error names round 0, the plan phase and 4F',
      String(row.error).includes('第 0 轮议题拆解') && String(row.error).includes('4F'), String(row.error));
    ok('the raw CLI error is kept', String(row.error).includes('退出码 0'), String(row.error));
    ok('no later phase was attempted', h.callsOf('proposal').length === 0 && h.callsOf('review').length === 0);
    const u = repo.listUtterances(id).find((x) => x.floor_id === '4F' && x.phase === 'plan');
    ok('the failed plan utterance is archived with its error', u.status === 'failed' && u.error.includes('退出码 0'));
    ok('the report still archives', Boolean(reportOf(id)));
    ok('no participant is left "running"',
      repo.listParticipants(id).every((p) => p.status !== 'running' && p.status !== 'pending'));
  }
  head('a moderator asking for a missing path ends normally as needs_clarification');
  {
    const h = makeHarness();
    h.set('4F:plan', () =>
      OK(`需要路径。\n${jsonBlock({ needsClarification: ['请给出需要评审的项目绝对路径'] })}`)
    );
    const id = newCouncil('cNeedsInfo', { maxRounds: 2 });
    const orch = mkOrchestrator(h);
    const row = await orch.start(id);

    ok('verdict=needs_clarification and status=done',
      row.verdict === 'needs_clarification' && row.status === 'done', `${row.verdict}/${row.status}`);
    ok('the meeting-level error carries the exact question',
      String(row.error).includes('请给出需要评审的项目绝对路径'), String(row.error));
    ok('only the plan was attempted',
      h.countOf('4F', 'plan') === 1 && h.callsOf('proposal').length === 0 &&
        h.callsOf('review').length === 0 && h.callsOf('moderation').length === 0,
      h.seen.map((x) => `${x.floor}:${x.phase}`).join(','));
    ok('the moderator is needs_clarification; roles that never ran are skipped',
      repo.listParticipants(id).map((p) => `${p.floor_id}:${p.status}`).join(',') ===
        '4F:needs_clarification,1F:skipped,7F:skipped',
      repo.listParticipants(id).map((p) => `${p.floor_id}:${p.status}`).join(','));

    const planUtterance = repo.listUtterances(id).find((u) => u.floor_id === '4F' && u.phase === 'plan');
    ok('the clarification reply is recorded as a normal moderator turn',
      planUtterance && planUtterance.status === 'ok' && planUtterance.content.includes('需要路径'));

    const report = reportOf(id);
    ok('the report keeps the clarification verdict and question',
      report && report.council.verdict === 'needs_clarification' &&
        report.plan.needsClarification[0] === '请给出需要评审的项目绝对路径',
      report && JSON.stringify(report.plan));
    ok('the report says the review never started',
      report.roles.length === 3 &&
        report.roles.find((r) => r.floor === '4F').status === 'needs_clarification' &&
        report.roles.filter((r) => r.status === 'skipped').length === 2);
    ok('report files are still archived',
      JSON.parse(repo.getReport(id).files_json).every((f) => fs.existsSync(f)));

    const planPrompt = h.callsOf('plan')[0].prompt;
    ok('the prompt says the temporary directory is not project evidence',
      planPrompt.includes('临时目录不是用户项目') && planPrompt.includes('不能作为项目证据'));
    ok('the temporary cwd is not presented as a user-provided project directory',
      planPrompt.includes('【用户提供的项目目录】') === false &&
        planPrompt.includes(h.callsOf('plan')[0].cwd) === false,
      planPrompt.slice(0, 700));
    ok('the temporary directory is removed after the early normal ending',
      !fs.existsSync(h.callsOf('plan')[0].cwd));
  }
  head('a reviewer that crashes stops the meeting, not replaced by a guessed opinion');
  {
    const h = makeHarness();
    h.set('7F:review', () => FAIL('kilo 崩了：段错误', 'failed'));
    const id = newCouncil('cRevFail', { maxRounds: 1 });
    const orch = mkOrchestrator(h);
    const row = await orch.start(id);

    const u = repo.listUtterances(id).find((x) => x.floor_id === '7F' && x.phase === 'review');
    ok('status=failed and the raw error is kept', u.status === 'failed' && u.error === 'kilo 崩了：段错误');
    ok('no content and no tokens invented', u.content === null && u.input_tokens === null);
    ok('the participant row is marked failed', repo.listParticipants(id).find((p) => p.floor_id === '7F').status === 'failed');
    ok('no review rows exist for it', repo.listReviews(id).filter((r) => r.round_no === 1).length === 0);
    ok('the meeting stopped before the moderator convergence', h.countOf('4F', 'moderation') === 0);
    ok('verdict=failed: no round completed', row.verdict === 'failed' && row.status === 'failed', `${row.verdict}/${row.status}`);
    ok('the error names the floor and the raw reason',
      String(row.error).includes('7F') && String(row.error).includes('kilo 崩了'), String(row.error));
    const codes = reportOf(id).summary.warnings.map((w) => w.code);
    ok('turn_failed is recorded in the report', codes.includes('turn_failed'), codes.join(','));
    ok('the report still archives', Boolean(reportOf(id)));
  }
  {
    const h = makeHarness();
    h.set('7F:review', () => OK('我觉得都行，看你们吧。') /* spoke, but no structured block */);
    const id = newCouncil('cRevUnparsed', { maxRounds: 1 });
    const orch = mkOrchestrator(h);
    const row = await orch.start(id);
    const u = repo.listUtterances(id).find((x) => x.floor_id === '7F' && x.phase === 'review');
    ok('speaking without the protocol -> unparsed (distinct from failed)', u.status === 'unparsed');
    ok('the text is kept for the user to read', u.content.includes('我觉得都行'));
    ok('no review point is invented', repo.listReviews(id).length === 0);
    ok('the meeting stops before the moderator convergence', h.countOf('4F', 'moderation') === 0);
    ok('verdict=failed and the reason names 7F', row.verdict === 'failed' && String(row.error).includes('7F'),
      `${row.verdict} / ${row.error}`);
  }
  {
    // Round 1 finishes; the main answerer fails in round 2. Evidence must still be archived.
    const h = makeHarness();
    h.set('1F:proposal', ({ round }) => (round === 2 ? FAIL('主答超时') : defaultReply({ phase: 'proposal', round })));
    const id = newCouncil('cNoProposal', { maxRounds: 2 });
    const orch = mkOrchestrator(h);
    const row = await orch.start(id);

    ok('one complete round -> verdict=partial', row.verdict === 'partial', String(row.verdict));
    ok('partial is a normal ending (done), not failed', row.status === 'done', row.status);
    ok('the error names the round', String(row.error).includes('第 2 轮主答没有产出可用方案'), String(row.error));
    ok('the second round was not fabricated', repo.listRounds(id).filter((r) => r.kind === 'debate').length === 1);
    const report = reportOf(id);
    ok('the partial run still archives the completed round', report && report.rounds.length === 1 && report.summary.reviewCount === 1);
    ok('the report carries proposal_missing', report.summary.warnings.some((w) => w.code === 'proposal_missing'));
    ok('report files were really written', JSON.parse(repo.getReport(id).files_json).every((f) => fs.existsSync(f)));
  }
  {
    const h = makeHarness();
    h.set('4F:adjudication', () => OK('我没什么可说的。'));
    const id = newCouncil('cPartial', { maxRounds: 1 });
    const orch = mkOrchestrator(h);
    const row = await orch.start(id);
    ok('unparseable adjudication -> partial', row.verdict === 'partial' && row.status === 'done', `${row.verdict}/${row.status}`);
    ok('adjudication_unparsed is recorded', reportOf(id).summary.warnings.some((w) => w.code === 'adjudication_unparsed'));
  }
  {
    const h = makeHarness();
    h.set('1F:final', () => FAIL('最终稿生成失败'));
    const id = newCouncil('cNoFinal', { maxRounds: 1 });
    const orch = mkOrchestrator(h);
    const row = await orch.start(id);
    ok('missing final draft -> partial, not failed (rounds completed)', row.verdict === 'partial' && row.status === 'done');
    ok('final_draft_missing is recorded', reportOf(id).summary.warnings.some((w) => w.code === 'final_draft_missing'));
    ok('the adjudication is still archived', reportOf(id).adjudication.decision === 'approve');
  }

  /* ============================================================ missing roles */
  head('missing roles fail fast with a clear reason');
  {
    const h = makeHarness();
    repo.createCouncil({ id: 'cNoMain', topic: 't', maxRounds: 1, createdAt: now() });
    repo.insertParticipant({ councilId: 'cNoMain', floorId: '4F', role: 'moderator', agent: 'x', cliPath: null });
    repo.insertParticipant({ councilId: 'cNoMain', floorId: '7F', role: 'reviewer', agent: 'x', cliPath: null });
    const orch = mkOrchestrator(h);
    const row = await orch.start('cNoMain');
    ok('no main answerer -> failed', row.verdict === 'failed' && row.status === 'failed');
    ok('the reason names the missing role', String(row.error).includes('缺少主答'), String(row.error));
    ok('not a single model call was made', h.seen.length === 0, String(h.seen.length));
  }
  {
    const h = makeHarness();
    repo.createCouncil({ id: 'cNoReviewer', topic: 't', maxRounds: 1, createdAt: now() });
    repo.insertParticipant({ councilId: 'cNoReviewer', floorId: '4F', role: 'moderator', agent: 'x', cliPath: null });
    repo.insertParticipant({ councilId: 'cNoReviewer', floorId: '1F', role: 'main', agent: 'x', cliPath: null });
    const orch = mkOrchestrator(h);
    const row = await orch.start('cNoReviewer');
    ok('no reviewer -> failed with a clear reason', row.verdict === 'failed' && String(row.error).includes('至少需要一位评审'));
  }

  /* ============================================================ cancel */
  head('cancel mid-review: no fake results, definite ending');
  {
    const h = makeHarness();
    h.holdOn(['review']);
    const id = newCouncil('cCancel', { maxRounds: 2 });
    const orch = mkOrchestrator(h);

    const pending = orch.start(id);
    await waitFor(() => h.held.length === 1);
    ok('the reviewer call is in flight', h.held.length === 1);
    ok('the meeting is visible as active', orch.activeIds().includes(id));
    const cwd = h.seen[0].cwd;

    ok('cancel returns true', orch.cancel(id) === true);
    ok('cancelling an unknown meeting returns false', orch.cancel('nope') === false);
    h.release();
    const row = await pending;

    ok('verdict=cancelled / status=cancelled', row.verdict === 'cancelled' && row.status === 'cancelled', `${row.verdict}/${row.status}`);
    ok('the round was started but not completed', (() => {
      const r1 = repo.listRounds(id).find((r) => r.round_no === 1);
      return r1 && r1.ended_at === null && r1.stats_json === null;
    })());
    ok('no review utterance was recorded for the killed turn',
      repo.listUtterances(id).filter((u) => u.phase === 'review').length === 0);
    ok('the proposal that did finish is kept', repo.listUtterances(id).some((u) => u.phase === 'proposal' && u.status === 'ok'));
    ok('temp dir cleaned up', !fs.existsSync(cwd));
    ok('no longer active', orch.activeIds().length === 0);
    ok('no report is written for a cancelled meeting (no final phase ran)', repo.getReport(id) === null);
  }

  /* ============================================================ shutdown */
  head('server shutdown: in-flight meetings get a definite ending and stale rows are swept');
  {
    const h = makeHarness();
    h.holdOn(['review']);
    const id = newCouncil('cShutdown', { maxRounds: 2 });
    const orch = mkOrchestrator(h);

    const pending = orch.start(id);
    await waitFor(() => h.held.length === 1);
    repo.createCouncil({ id: 'cStale', topic: 'left by a crash', maxRounds: 1, createdAt: now() });
    repo.markCouncilRunning('cStale', now());

    const swept = orch.shutdown();
    h.release();
    const row = await pending;

    ok('in-flight meeting is cancelled with the shutdown reason',
      row.status === 'cancelled' && /服务已关闭/.test(String(row.error)), `${row.status}/${row.error}`);
    ok('active table is empty', orch.activeIds().length === 0);
    ok('the stale row is swept exactly once', swept === 1, String(swept));
    const stale = repo.getCouncil('cStale');
    ok('the stale row is honestly failed', stale.status === 'failed' && stale.verdict === 'failed');
    ok('and carries the reason', /服务已关闭/.test(String(stale.error)));
  }

  /* ============================================================ workspace */
  head('workspace mode: report into the namespaced dir, never touch the user\'s files');
  {
    const ws = path.join(TMP, 'user-project');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'IMPORTANT.txt'), 'user data');
    const made = [];
    const removed = [];
    const h = makeHarness();
    const orch = mkOrchestrator(h, {
      mkdtemp: (prefix) => { const d = fs.mkdtempSync(path.join(TMP, prefix)); made.push(d); return d; },
      removeDir: (d) => { removed.push(d); fs.rmSync(d, { recursive: true, force: true }); },
      isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    });
    const id = newCouncil('cWs', { maxRounds: 1, workspacePath: ws });
    const row = await orch.start(id);

    ok('completed', row.verdict === 'completed', String(row.verdict));
    ok('participants ran inside the workspace', h.seen.every((s) => s.cwd === ws));
    ok('no temp directory was created', made.length === 0, made.join(','));
    ok('removeDir was never called (the user workspace is not ours to delete)', removed.length === 0, removed.join(','));
    ok('the user file is untouched', fs.readFileSync(path.join(ws, 'IMPORTANT.txt'), 'utf8') === 'user data');
    ok('prompts state the workspace and the read-only rule',
      h.seen.every((s) => s.prompt.includes(ws)) && h.seen.every((s) => s.prompt.includes('不能修改任何文件')));
    const files = JSON.parse(repo.getReport(id).files_json);
    ok('only the four home files are archived', files.length === 4, String(files.length));
    const homeDir = path.join(TMP, 'home', 'councils', 'cWs');
    ok('every archived file is under the home council dir',
      files.every((f) => path.dirname(f) === homeDir), files.join(','));
    ok('nothing at all is written into the user workspace',
      fs.readdirSync(ws).sort().join(',') === 'IMPORTANT.txt');
  }
  {
    const removed = [];
    const h = makeHarness();
    const orch = mkOrchestrator(h, {
      isDir: () => false,
      removeDir: (d) => removed.push(d),
    });
    const id = newCouncil('cWsGone', { maxRounds: 2, workspacePath: path.join(TMP, 'not-there') });
    const row = await orch.start(id);
    ok('a missing workspace fails before any model call', row.verdict === 'failed' && h.seen.length === 0);
    ok('the error names the path', String(row.error).includes('not-there'));
    ok('nothing was deleted', removed.length === 0);
  }

  /* ============================================================ isolation */
  head('isolation: the office tables stay empty');
  {
    const count = (t) => repo.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    for (const t of ['members', 'tasks', 'task_runs', 'messages', 'file_activity']) {
      ok(`${t} has no rows`, count(t) === 0, String(count(t)));
    }
    ok('the council tables do have data (so the above is not vacuous)', repo.listCouncils(100).length > 0);
  }

  close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${fail ? '✗' : '✓'} council-orchestrator: ${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
