/**
 * Council timeline pure-logic self-check.
 *
 * Why this file exists: the same meeting reaches the UI by **two paths** — GET detail returns DB rows
 * (snake_case) and WS pushes increments (camelCase). If normalization is wrong, the symptom is
 * "the content disappears after a refresh" — a bug that only shows up on one path and is hard to see.
 * Dedup matters too: WS jitter repeats an utterance and the UI would show two of everything.
 *
 * Run: `npm run test:council-timeline`
 */
const {
  normReviewPoint,
  normRoundResult,
  normRoundResults,
  mergeRoundResult,
  normUtterance,
  utteranceKey,
  mergeUtterance,
  groupUtterances,
  tokenUsageOf,
  modelOfUtterances,
  roleSummary,
  severityCountsOf,
  stanceCountsOf,
  scoreOf,
  scoreBreakdownOf,
  summarizeCouncil,
  phaseLabelKey,
  formatTokens,
} = await import('../src/lib/councilTimeline.js');

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

/* ---------------------------------- utterances ---------------------------------- */

head('utterances: DB rows (snake_case) and WS increments (camelCase) normalize alike');
{
  const dbRow = normUtterance({
    round_no: 1,
    floor_id: '4F',
    phase: 'review',
    content: '缺鉴权',
    model: 'claude-sonnet-5-5',
    status: 'ok',
    duration_ms: 1234,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 3,
    cache_write_tokens: 4,
    parse_dropped: 2,
  });
  ok('roundNo comes from round_no', dbRow.roundNo === 1);
  ok('floorId comes from floor_id', dbRow.floorId === '4F');
  ok('phase is kept', dbRow.phase === 'review');
  ok('durationMs comes from duration_ms', dbRow.durationMs === 1234);
  ok('tokens come from the snake_case columns',
    dbRow.inputTokens === 10 && dbRow.outputTokens === 20 && dbRow.cacheReadTokens === 3 && dbRow.cacheWriteTokens === 4);
  ok('parseDropped is kept (drops are visible, not silently swallowed)', dbRow.parseDropped === 2);

  const ws = normUtterance({ roundNo: 2, floorId: '7F', phase: 'proposal', durationMs: 88, outputTokens: 5 });
  ok('camelCase fields are read', ws.roundNo === 2 && ws.floorId === '7F' && ws.phase === 'proposal' && ws.durationMs === 88);
  ok('missing phase falls back to brief', normUtterance({ roundNo: 1, floorId: '1F' }).phase === 'brief');
  ok('missing status falls back to ok', normUtterance({ floorNo: 1 }).status === 'ok');
}

head('missing numbers stay null — never rendered as 0');
{
  const u = normUtterance({ round_no: 1, floor_id: '8F', status: 'failed', error: '超时', input_tokens: null });
  ok('unreadable tokens stay null', u.inputTokens === null && u.outputTokens === null);
  ok('the failure text is kept verbatim', u.error === '超时');
  ok('a real 0 stays 0 (0 is not "unreadable")', normUtterance({ input_tokens: 0 }).inputTokens === 0);
  ok('a missing content is null, not an empty string', normUtterance({}).content === null);
  ok('formatTokens shows a dash when nothing was reported', formatTokens(tokenUsageOf([u])) === '—');
}

head('token totals: unknown is not zero');
{
  ok('all four missing -> total null', tokenUsageOf([normUtterance({})]).total === null);
  ok('no utterances -> null', tokenUsageOf([]).total === null && tokenUsageOf(null).total === null);
  const onlyOutput = tokenUsageOf([normUtterance({ output_tokens: 7 })]);
  ok('only output reported -> total is that output', onlyOutput.total === 7);
  ok('and it is marked inexact ("≥ 7")', onlyOutput.exact === false && formatTokens(onlyOutput) === '≥ 7');
  const full = tokenUsageOf([
    normUtterance({ input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4 }),
    normUtterance({ input_tokens: 10, output_tokens: 20 }),
  ]);
  ok('all turns reported -> exact sum', full.total === 33 && full.exact === true, JSON.stringify(full));
  ok('exact renders without a prefix', formatTokens(full) === '33');
  const realZero = tokenUsageOf([normUtterance({ input_tokens: 0, output_tokens: 0 })]);
  ok('reported zeros are 0, not "—"', realZero.total === 0 && realZero.exact === true && formatTokens(realZero) === '0');

  ok('the model is the last turn that named one',
    modelOfUtterances([normUtterance({ model: 'm1' }), normUtterance({}), normUtterance({ model: 'm2' })]) === 'm2');
  ok('no model reported -> null', modelOfUtterances([normUtterance({})]) === null);
}

head('merge: one turn per (round, floor, phase)');
{
  let list = [];
  list = mergeUtterance(list, { roundNo: 1, floorId: '4F', phase: 'review', content: '我说了话' });
  ok('first increment lands', list.length === 1);
  list = mergeUtterance(list, { roundNo: 1, floorId: '4F', phase: 'review', content: '我说了话' });
  ok('the same increment twice does not create a second row', list.length === 1, String(list.length));
  list = mergeUtterance(list, { roundNo: 1, floorId: '4F', phase: 'proposal', content: '我提了案' });
  ok('the same floor may speak a different phase in the same round', list.length === 2);
  ok('phase is part of the key', utteranceKey({ roundNo: 1, floorId: '4F', phase: 'review' }) === '1#4F#review');
  list = mergeUtterance(list, { roundNo: 1, floorId: '7F', phase: 'review', content: '我也说' });
  ok('another floor is a new row', list.length === 3);

  list = mergeUtterance(list, { roundNo: 1, floorId: '4F', phase: 'review', outputTokens: 9 });
  const four = list.find((u) => u.floorId === '4F' && u.phase === 'review');
  ok('a later increment fills in the token count', four.outputTokens === 9);
  ok('and does not wipe the content that was already there', four.content === '我说了话', String(four.content));
  ok('the input array is not mutated in place', mergeUtterance(list, { roundNo: 9, floorId: '1F' }).length === 4);

  const blank = mergeUtterance([normUtterance({ roundNo: 1, floorId: '1F', content: '正文' })], {
    roundNo: 1,
    floorId: '1F',
    phase: 'brief',
    content: '',
  });
  ok('an empty string never overwrites a non-empty value', blank[0].content === '正文', String(blank[0].content));
}

head('group: rounds ascending, server insertion order preserved');
{
  const rows = [
    { roundNo: 1, floorId: '7F', status: 'ok' },
    { roundNo: 0, floorId: '4F', phase: 'plan', content: '议题' },
    { roundNo: 1, floorId: '1F', status: 'ok' },
    { roundNo: 2, floorId: '1F', status: 'ok' },
  ].map(normUtterance);
  const groups = groupUtterances(rows);
  ok('three round groups', groups.length === 3, String(groups.length));
  ok('round order is 0,1,2', groups.map((g) => g.roundNo).join() === '0,1,2', groups.map((g) => g.roundNo).join());
  ok('inside a round the server order is kept (7F before 1F as received)',
    groups[1].utterances.map((u) => u.floorId).join() === '7F,1F', groups[1].utterances.map((u) => u.floorId).join());
  ok('empty input is safe', groupUtterances([]).length === 0 && groupUtterances(null).length === 0);
}

/* ---------------------------------- review points ---------------------------------- */

head('review points: vocabulary is enforced, never invented');
{
  const r = normReviewPoint({
    reviewer: '7F',
    severity: 'blocker',
    dimension: '安全',
    issue: '缺鉴权',
    evidence: 'app.js:10',
    suggestion: '加中间件',
    stance: 'reject',
  });
  ok('all seven fields survive normalization',
    r.reviewer === '7F' && r.severity === 'blocker' && r.dimension === '安全' && r.issue === '缺鉴权' &&
      r.evidence === 'app.js:10' && r.suggestion === '加中间件' && r.stance === 'reject');
  ok('an unknown severity falls back to minor (the UI vocabulary has four values)',
    normReviewPoint({ severity: 'fatal' }).severity === 'minor');
  ok('an unknown stance falls back to revise', normReviewPoint({ stance: '有条件通过' }).stance === 'revise');
  ok('a missing dimension becomes 其他', normReviewPoint({}).dimension === '其他');
  ok('empty evidence is null, not ""', normReviewPoint({ evidence: '' }).evidence === null);
}

head('RoundResult: API shape and WS shape both normalize');
{
  const r = normRoundResult({
    round: 2,
    proposal: { version: 'v2', content: '修订稿', diffFromPrev: '- 旧\n+ 新' },
    reviews: [{ reviewer: '7F', severity: 'major', dimension: '性能', issue: '慢', suggestion: '缓存', stance: 'revise' }],
    moderator: {
      consensus: [' 已达成 ', '', '第二条'],
      openIssues: ['待定'],
      conflicts: [{ topic: '数据库', sides: [{ reviewer: '1F', view: 'MySQL' }, { reviewer: '7F', view: 'PG' }] }, { topic: '' }],
      revisionDirectives: ['【针对 慢】必须加缓存；验收标准：p99 < 100ms。'],
      convergenceScore: 57,
    },
    stats: { score: 57, bySeverity: { blocker: 0, major: 1, minor: 0, nit: 0 }, conflicts: 1 },
    warnings: [{ code: 'vague_directive', message: '空泛指令' }],
  });
  ok('round number', r.round === 2);
  ok('proposal version/content/diff', r.proposal.version === 'v2' && r.proposal.content === '修订稿' && r.proposal.diffFromPrev === '- 旧\n+ 新');
  ok('reviews are normalized', r.reviews.length === 1 && r.reviews[0].severity === 'major');
  ok('consensus drops blanks', r.moderator.consensus.join(',') === '已达成,第二条');
  ok('conflicts keep only entries with a topic', r.moderator.conflicts.length === 1 && r.moderator.conflicts[0].topic === '数据库');
  ok('conflict sides are normalized', r.moderator.conflicts[0].sides[1].reviewer === '7F');
  ok('revision directives survive verbatim', r.moderator.revisionDirectives[0].includes('验收标准'));
  ok('convergence score', r.moderator.convergenceScore === 57);
  ok('stats are kept for the explainable breakdown', r.stats.score === 57);
  ok('warnings are kept', r.warnings[0].code === 'vague_directive');
  ok('missing fields default without inventing a score',
    normRoundResult({ round: 1 }).moderator.convergenceScore === null);

  const dbShape = normRoundResult({ round_no: 3, proposal: { content: 'x' } });
  ok('round_no is accepted as round', dbShape.round === 3);
  ok('missing diff is null', dbShape.proposal.diffFromPrev === null);
}

head('normRoundResults: debate rounds only, ascending');
{
  const list = normRoundResults([
    { round: 2, proposal: { content: 'b' } },
    { round: 0, proposal: { content: 'plan' } },
    { round: 1, proposal: { content: 'a' } },
  ]);
  ok('round 0 (the plan) is not a RoundResult', list.length === 2 && list[0].round === 1, JSON.stringify(list.map((r) => r.round)));
  ok('sorted ascending', list.map((r) => r.round).join() === '1,2');
  ok('null input -> empty list', normRoundResults(null).length === 0);
}

head('mergeRoundResult: non-empty wins so a partial push cannot erase a full round');
{
  let list = normRoundResults([{ round: 1, proposal: { version: 'v1', content: '正文' }, reviews: [{ severity: 'major' }], moderator: { consensus: ['一致'], convergenceScore: 60 } }]);
  list = mergeRoundResult(list, { round: 1, moderator: { consensus: [], openIssues: [] } });
  ok('an empty moderator payload does not erase the previous one', list[0].moderator.consensus[0] === '一致', JSON.stringify(list[0].moderator));
  ok('an empty reviews array does not erase the previous reviews', list[0].reviews.length === 1);
  ok('an empty proposal content does not erase the proposal', list[0].proposal.content === '正文');
  list = mergeRoundResult(list, { round: 1, stats: { score: 42 } });
  ok('new stats replace old stats', list[0].stats.score === 42);
  list = mergeRoundResult(list, { round: 2, proposal: { content: '第二版' } });
  ok('a new round is appended and sorted', list.length === 2 && list[1].round === 2);
  ok('a round 0 push is ignored', mergeRoundResult(list, { round: 0 }).length === 2);
  ok('the source list is not mutated in place', list !== undefined && mergeRoundResult([], { round: 1 }).length === 1);
}

/* ---------------------------------- aggregation ---------------------------------- */

head('severity and stance counts');
{
  const reviews = [
    { severity: 'blocker', stance: 'reject' },
    { severity: 'blocker', stance: 'revise' },
    { severity: 'major', stance: 'accept' },
    { severity: 'nit', stance: 'accept' },
    { severity: 'unknown', stance: 'unknown' },
  ];
  const sev = severityCountsOf(reviews);
  ok('blockers counted', sev.blocker === 2);
  ok('major/minor/nit counted', sev.major === 1 && sev.minor === 0 && sev.nit === 1);
  ok('unknown severity is not mapped to a bucket', Object.values(sev).reduce((a, b) => a + b, 0) === 4);
  const st = stanceCountsOf(reviews);
  ok('stances counted', st.reject === 1 && st.revise === 1 && st.accept === 2 && st.unknown === undefined);
  ok('empty input is safe', severityCountsOf(null).blocker === 0 && stanceCountsOf(null).accept === 0);
}

head('score: server-computed value wins; the fallback formula is identical');
{
  const withStats = normRoundResults([
    { round: 1, stats: { score: 57, bySeverity: { blocker: 1, major: 1, minor: 0, nit: 0 }, conflicts: 1 }, moderator: { convergenceScore: 99 } },
  ]);
  ok('scoreOf prefers stats.score over the model-reported moderator score', scoreOf(withStats) === 57);

  const b = scoreBreakdownOf(withStats);
  ok('breakdown uses the server score', b.score === 57);
  ok('the formula is spelled out', b.formula === '100 - (blocker 1×25 + major 1×8 + minor 0×2 + nit 0×0 + 冲突 1×10)', b.formula);
  ok('deduction is shown', b.deduction === 43);
  ok('cap is published', b.max === 100);

  const fallback = scoreBreakdownOf(normRoundResults([
    { round: 1, reviews: [{ severity: 'blocker' }, { severity: 'blocker' }], moderator: { conflicts: [{ topic: 'x' }] } },
  ]));
  ok('without stats the same formula is recomputed from the review points', fallback.score === 40, String(fallback.score));
  ok('fallback counts the conflicts', fallback.conflicts === 1 && fallback.deduction === 60);

  const clamped = scoreBreakdownOf(normRoundResults([
    { round: 1, reviews: Array.from({ length: 10 }, () => ({ severity: 'blocker' })) },
  ]));
  ok('the score never goes below 0', clamped.score === 0, String(clamped.score));

  ok('no rounds -> no breakdown', scoreBreakdownOf([]) === null);
  ok('no score anywhere -> null', scoreOf([]) === null);
}

head('right-side summary: score, N opinions, N blockers, role models and tokens');
{
  const participants = [
    { floor_id: '4F', role: 'moderator', agent: 'claude', status: 'ok', error: null },
    { floor_id: '1F', role: 'main', agent: 'codebuddy', status: 'ok', error: null },
    { floor_id: '7F', role: 'reviewer', agent: 'kilo', status: 'failed', error: '超时' },
  ];
  const utterances = [
    { roundNo: 0, floorId: '4F', phase: 'plan', model: 'sonnet', inputTokens: 100, outputTokens: 20 },
    { roundNo: 1, floorId: '1F', phase: 'proposal', model: 'codebuddy-x', inputTokens: 200, outputTokens: 50 },
    { roundNo: 1, floorId: '7F', phase: 'review', model: null, inputTokens: null, outputTokens: null },
  ].map(normUtterance);
  const roundResults = normRoundResults([
    {
      round: 1,
      reviews: [
        { reviewer: '7F', severity: 'blocker', stance: 'reject' },
        { reviewer: '7F', severity: 'major', stance: 'revise' },
      ],
      moderator: { conflicts: [{ topic: 'x', sides: [] }], revisionDirectives: ['d'] },
      stats: { score: 57, bySeverity: { blocker: 1, major: 1, minor: 0, nit: 0 }, conflicts: 1 },
    },
  ]);
  const summary = summarizeCouncil({ participants, utterances, roundResults });
  ok('round count', summary.rounds === 1);
  ok('score', summary.score === 57);
  ok('breakdown is included (the number is explainable in the UI)', summary.breakdown.deduction === 43);
  ok('N opinions', summary.reviewCount === 2);
  ok('N blockers', summary.severityCounts.blocker === 1);
  ok('stance counts', summary.stanceCounts.reject === 1 && summary.stanceCounts.revise === 1);
  ok('conflict count', summary.conflictCount === 1);
  ok('trend lists each round that reported a score', JSON.stringify(summary.trend) === JSON.stringify([{ round: 1, score: 57 }]));

  const roles = summary.roles;
  ok('one row per participant, in seat order', roles.map((r) => r.role).join(',') === 'moderator,main,reviewer');
  ok('each role reports its floor', roles.map((r) => r.floorId).join(',') === '4F,1F,7F');
  ok('each role reports its model', roles[0].model === 'sonnet' && roles[1].model === 'codebuddy-x');
  ok('each role reports token usage', roles[0].tokens.total === 120 && roles[1].tokens.total === 250);
  ok('a floor with no reported usage has null tokens (shown as "—", not 0)',
    roles[2].tokens.total === null && formatTokens(roles[2].tokens) === '—');
  ok('the failure is carried through', roles[2].status === 'failed' && roles[2].error === '超时');

  const empty = summarizeCouncil({ participants: [], utterances: [], roundResults: [] });
  ok('an empty council summarizes to null score, not 100', empty.score === null && empty.rounds === 0 && empty.reviewCount === 0);
  ok('and no role rows', empty.roles.length === 0);
}

head('roleSummary uses the utterance camelCase shape only (single normalization path)');
{
  const roles = roleSummary(
    [{ floor_id: '1F', role: 'main', status: 'ok' }],
    [normUtterance({ floorId: '1F', inputTokens: 5, outputTokens: 5 })]
  );
  ok('a normalized utterance is matched by floorId', roles[0].tokens.total === 10);
  ok('raw DB rows are not silently accepted here — callers normalize first',
    roleSummary([{ floor_id: '1F', role: 'main' }], [{ floor_id: '1F', input_tokens: 5 }])[0].tokens.total === null);
}

head('phase labels');
{
  ok('phase label key', phaseLabelKey('review') === 'council.phase.review');
  ok('every phase gets a key', ['plan', 'proposal', 'review', 'moderation', 'adjudication', 'final']
    .every((p) => phaseLabelKey(p).startsWith('council.phase.')));
}

console.log(`\n${fail ? '✗' : '✓'} council-timeline: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
