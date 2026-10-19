/**
 * Council convergence self-check — pure arithmetic and consistency rules.
 *
 * The score is the whole point of this module: it must be **computable from the data** and must not be
 * moveable by the moderator's prose. The formula is pinned literally here so a silent weight change
 * fails the suite:
 *   raw = 100 - (blocker*25 + major*8 + minor*2 + nit*0 + conflicts*10), clamped 0..100
 *
 * Run: `npm run test:council-convergence`
 */
'use strict';

const {
  WEIGHTS,
  CONFLICT_WEIGHT,
  SCORE_MAX,
  clamp,
  computeStats,
  scoreFormula,
  directiveProblems,
  consistencyWarnings,
  finalWarnings,
  scoreTrend,
} = require('../src/council/convergence');

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
const eq = (label, actual, expected) =>
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
const head = (t) => console.log(`\n${t}`);

const review = (severity, extra = {}) => ({
  severity,
  dimension: '其他',
  stance: 'revise',
  ...extra,
});

/* ------------------------------------------------------------ weights */
head('weights are fixed (a change here is a product decision)');
{
  eq('severity weights', WEIGHTS, { blocker: 25, major: 8, minor: 2, nit: 0 });
  eq('conflict weight', CONFLICT_WEIGHT, 10);
  eq('score ceiling', SCORE_MAX, 100);
  eq('clamp', [clamp(-5, 0, 100), clamp(50, 0, 100), clamp(105, 0, 100)], [0, 50, 100]);
}

/* ------------------------------------------------------------ stats */
head('per-round stats');
{
  const reviews = [
    review('blocker', { dimension: '安全', stance: 'reject' }),
    review('blocker', { dimension: '安全', stance: 'revise' }),
    review('major', { dimension: '性能' }),
    review('minor', { dimension: '性能' }),
    review('nit', { dimension: '文档', stance: 'accept' }),
  ];
  const conflicts = [{ topic: '缓存', sides: [] }, { topic: '技术栈', sides: [] }];
  const s = computeStats(reviews, conflicts);

  ok('total counts every point', s.total === 5);
  eq('bySeverity', s.bySeverity, { blocker: 2, major: 1, minor: 1, nit: 1 });
  eq('byDimension groups points', s.byDimension, { 安全: 2, 性能: 2, 文档: 1 });
  eq('byStance', s.byStance, { reject: 1, revise: 3, accept: 1 });
  ok('conflicts counted from the moderator list', s.conflicts === 2);
  ok('deduction = 2*25 + 1*8 + 1*2 + 2*10 = 80', s.deduction === 80, String(s.deduction));
  ok('score = 20', s.score === 20, String(s.score));
  ok('not clamped', s.clamped === false);
  ok('weights are echoed for the UI/report', s.weights.blocker === 25 && s.conflictWeight === 10);
}
{
  const s = computeStats([review('blocker'), review('blocker'), review('blocker'), review('blocker')], []);
  ok('a truly awful round clamps at 0', s.rawScore === 0 && s.score === 0 && s.clamped === false);
  const worse = computeStats([review('blocker'), review('blocker'), review('blocker'), review('blocker'), review('major')], [{ topic: 'x' }]);
  ok('below zero is clamped to 0 and marked clamped', worse.rawScore === -18 && worse.score === 0 && worse.clamped === true);
}
{
  const s = computeStats([review('nit'), review('nit'), review('nit')], []);
  ok('nit weight is 0 — cosmetic notes cannot move the number', s.deduction === 0 && s.score === 100);
  const empty = computeStats([], []);
  eq('no reviews: score 100, all counters zero, no NaN', empty, {
    total: 0,
    bySeverity: { blocker: 0, major: 0, minor: 0, nit: 0 },
    byDimension: {},
    byStance: { reject: 0, revise: 0, accept: 0 },
    conflicts: 0,
    weights: { blocker: 25, major: 8, minor: 2, nit: 0 },
    conflictWeight: 10,
    deduction: 0,
    rawScore: 100,
    score: 100,
    clamped: false,
  });
}
{
  const s = computeStats(
    [review('major', { dimension: '  ' }), review('major', { dimension: null }), { severity: 'made-up', dimension: 'x', stance: 'weird' }],
    null
  );
  ok('a blank dimension falls back to 其他', s.byDimension['其他'] === 2);
  ok('an unknown severity adds to total but to no severity bucket',
    s.total === 3 && Object.values(s.bySeverity).reduce((a, b) => a + b, 0) === 2);
  ok('an unknown stance is not counted in any stance bucket', s.byStance.reject + s.byStance.revise + s.byStance.accept === 2);
  ok('a null conflict list is treated as empty, not a crash', s.conflicts === 0);
}

/* ------------------------------------------------------------ formula text */
head('the score must be explainable');
{
  const s = computeStats([review('blocker'), review('major'), review('minor')], [{ topic: 'x' }]);
  const f = scoreFormula(s);
  eq('formula matches the arithmetic', f, '100 - (blocker 1×25 + major 1×8 + minor 1×2 + nit 0×0 + 冲突 1×10) = 55');
  const clamped = scoreFormula(computeStats(Array(6).fill(review('blocker')), []));
  ok('a clamped score says so instead of hiding the negative raw value', clamped.includes('= -50 → 封顶 0'), clamped);
}

/* ------------------------------------------------------------ directive quality */
head('hard directive vs suggestion');
{
  const good = '【针对 鉴权缺失】必须新增 token 校验中间件；验收标准：未带 token 的请求返回 401。';
  eq('a well-formed directive has no problems', directiveProblems(good), []);
  ok('missing 必须 is flagged', directiveProblems('【针对 鉴权】补一个中间件；验收标准：401。').includes('missing_must'));
  ok('missing acceptance criterion is flagged', directiveProblems('【针对 鉴权】必须补中间件。').includes('missing_acceptance'));
  ok('"建议" is flagged as vague', directiveProblems('【针对 鉴权】建议补中间件；验收标准：401。').includes('vague'));
  ok('"可以考虑" is flagged', directiveProblems('【针对 鉴权】可以考虑补中间件；验收标准：401。').includes('vague'));
  ok('English hedging is caught too', directiveProblems('You must consider adding middleware; 验收标准：401.').includes('vague'));
  eq('non-string input yields no false confidence', directiveProblems(null), ['missing_must', 'missing_acceptance']);
}

/* ------------------------------------------------------------ consistency */
head('consistency warnings: the moderator cannot smooth over a split');
{
  const base = {
    round: 1,
    reviews: [review('blocker', { stance: 'reject' })],
    moderator: { consensus: [], openIssues: [], conflicts: [], revisionDirectives: [] },
  };
  const codes = consistencyWarnings(base).map((w) => w.code);
  ok('blockers with no directive -> flagged', codes.includes('blockers_without_directives'));
  ok('blockers not carried into openIssues -> flagged', codes.includes('blockers_without_open_issues'));
  ok('a reject stance with no recorded conflict -> flagged', codes.includes('split_stance_without_conflicts'));
  ok('each warning carries a readable message', consistencyWarnings(base).every((w) => w.message && w.message.length > 4));

  const acceptAndRevise = {
    round: 1,
    reviews: [review('minor', { stance: 'accept' }), review('minor', { stance: 'revise' })],
    moderator: { consensus: [], openIssues: [], conflicts: [], revisionDirectives: [] },
  };
  ok('accept+revise without a conflict is also a hidden split',
    consistencyWarnings(acceptAndRevise).some((w) => w.code === 'split_stance_without_conflicts'));
  const allAccept = {
    round: 1,
    reviews: [review('nit', { stance: 'accept' })],
    moderator: { consensus: [], openIssues: [], conflicts: [], revisionDirectives: [] },
  };
  ok('unanimous accept with no conflicts is clean', consistencyWarnings(allAccept).length === 0);
}
{
  const withDirectives = {
    round: 2,
    reviews: [review('blocker')],
    moderator: {
      consensus: ['方向一致'],
      openIssues: ['鉴权未落地'],
      conflicts: [{ topic: '缓存', sides: [] }],
      revisionDirectives: [
        '【针对 鉴权】建议补中间件；验收标准：401。',
        '【针对 压测】必须补一份报告。',
        '【针对 日志】必须补字段；验收标准：日志含 traceId。',
      ],
    },
  };
  const codes = consistencyWarnings(withDirectives).map((w) => w.code);
  ok('a vague directive is flagged', codes.includes('vague_directives'));
  ok('a directive without an acceptance criterion is flagged', codes.includes('directives_without_acceptance'));
  ok('well-covered blockers are not flagged for missing directives/open issues',
    !codes.includes('blockers_without_directives') && !codes.includes('blockers_without_open_issues'));
}
{
  const w = consistencyWarnings({
    round: 3,
    reviews: [],
    expectedReviewers: ['7F', '8F', '9F'],
    submittedReviewers: ['7F'],
    moderator: { consensus: [], openIssues: [], conflicts: [], revisionDirectives: [] },
  });
  const incomplete = w.find((x) => x.code === 'incomplete_reviews');
  ok('reviewers that produced nothing are named', incomplete && incomplete.message.includes('8F、9F'));
  ok('submitted reviewers are not listed as missing', incomplete && !incomplete.message.includes('7F'));
}

/* ------------------------------------------------------------ final */
head('final-phase warning');
{
  ok('final approve with a remaining blocker is flagged',
    finalWarnings({ decision: 'approve', lastRoundReviews: [review('blocker')] })[0].code === 'final_accept_with_blockers');
  ok('approve with a clear last round is clean',
    finalWarnings({ decision: 'approve', lastRoundReviews: [review('minor')] }).length === 0);
  ok('approve_with_changes is not "approve" (no false positive)',
    finalWarnings({ decision: 'approve_with_changes', lastRoundReviews: [review('blocker')] }).length === 0);
  ok('reject is never flagged as wrongly accepting',
    finalWarnings({ decision: 'reject', lastRoundReviews: [review('blocker')] }).length === 0);
}

/* ------------------------------------------------------------ trend */
head('score trend for the summary');
{
  const trend = scoreTrend([
    { round_no: 1, stats_json: JSON.stringify({ score: 30 }) },
    { round_no: 2, stats_json: 'not json' },
    { round_no: 3, stats_json: null },
    { round_no: 4, stats_json: JSON.stringify({ score: 92 }) },
  ]);
  eq('only rows with a numeric score are kept (a broken archive row cannot break the summary)', trend, [
    { round: 1, score: 30 },
    { round: 4, score: 92 },
  ]);
  eq('empty input', scoreTrend(null), []);
}

console.log(`\n${fail ? '✗' : '✓'} council-convergence: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
