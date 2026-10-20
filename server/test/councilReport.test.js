/**
 * Council report self-check — real files in a temp `WORKGREMLIN_HOME`, no mocks.
 *
 * Pins the evidence rules:
 *   · tokens: null means "not reported" and prints `—`; a partial sum prints `≥ N`; it is never 0.
 *   · CSV is UTF-8 with BOM, quotes cells correctly, and keeps one review point per row.
 *   · exports are never overwritten (a second run gets a timestamp suffix).
 *   · the user's workspace is never written to, even when one was supplied.
 *
 * Run: `npm run test:council-report`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-council-report-'));
// The export dir is resolved through shared/paths at call time; point the whole suite at the temp home.
process.env.WORKGREMLIN_HOME = path.join(TMP, 'home');

const {
  REPORT_SCHEMA,
  aggregateTokens,
  modelOfUtterances,
  buildReportJson,
  reviewsCsv,
  roundsCsv,
  reportMarkdown,
  writeCouncilReports,
  uniquePath,
} = require('../src/council/report');
const { scoreFormula } = require('../src/council/convergence');

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

const BOM = '﻿';
const u = (over = {}) => ({
  floor_id: '1F',
  model: null,
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  ...over,
});

/* ------------------------------------------------------------ tokens */
head('token aggregation: never invent a number');
{
  const none = aggregateTokens([u(), u()]);
  eq('nothing reported -> everything null (UI shows —)', none, {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    total: null,
    exact: false,
  });
  const exact = aggregateTokens([
    u({ input_tokens: 100, output_tokens: 20, cache_read_tokens: 5, cache_write_tokens: 2 }),
    u({ input_tokens: 50, output_tokens: 10, cache_read_tokens: 1, cache_write_tokens: 0 }),
  ]);
  eq('all turns reported -> exact sum', exact, {
    input: 150,
    output: 30,
    cacheRead: 6,
    cacheWrite: 2,
    total: 180,
    exact: true,
  });
  const partial = aggregateTokens([u({ input_tokens: 100, output_tokens: 20 }), u()]);
  ok('some turns missing -> total is a lower bound (exact=false), not a fabricated sum',
    partial.total === 120 && partial.exact === false);
  const half = aggregateTokens([u({ output_tokens: 7 })]);
  ok('a turn with only one half reported is still a lower bound (exact=false)',
    half.total === 7 && half.exact === false, JSON.stringify(half));
  const cacheOnly = aggregateTokens([u({ cache_read_tokens: 999 })]);
  ok('cache-only usage is treated as "no token report" (total null, not 0)',
    cacheOnly.total === null && cacheOnly.exact === false);
  ok('empty input', aggregateTokens(null).total === null);
}
{
  const utterances = [
    { model: 'old-model', input_tokens: 1, output_tokens: 1 },
    { model: null, input_tokens: 2, output_tokens: 2 },
    { model: 'new-model', input_tokens: 3, output_tokens: 3 },
  ];
  ok('the latest non-null model wins', modelOfUtterances(utterances) === 'new-model');
  ok('no model reported -> null', modelOfUtterances([u()]) === null);
  ok('empty list -> null', modelOfUtterances([]) === null);
}

/* ------------------------------------------------------------ report model */
head('report model');
{
  const reviews = [
    { round_no: 2, reviewer: '7F', severity: 'blocker', dimension: '安全', issue: 'a', evidence: null, suggestion: 'b', stance: 'reject' },
    { round_no: 2, reviewer: '8F', severity: 'minor', dimension: '文档', issue: 'c', evidence: 'd', suggestion: 'e', stance: 'accept' },
  ];
  const stats = {
    total: 2,
    bySeverity: { blocker: 1, major: 0, minor: 1, nit: 0 },
    byDimension: { 安全: 1, 文档: 1 },
    byStance: { reject: 1, revise: 0, accept: 1 },
    conflicts: 1,
    weights: { blocker: 25, major: 8, minor: 2, nit: 0 },
    conflictWeight: 10,
    deduction: 37,
    rawScore: 63,
    score: 63,
    clamped: false,
  };
  const rounds = [
    {
      round: 1,
      proposal: { version: 'v1', content: 'first', diffFromPrev: null },
      reviews: [],
      moderator: { consensus: [], openIssues: [], conflicts: [], revisionDirectives: [] },
      stats: { ...stats, score: 100, bySeverity: { blocker: 0, major: 0, minor: 0, nit: 0 } },
    },
    {
      round: 2,
      proposal: { version: 'v2', content: 'second', diffFromPrev: '加了鉴权' },
      reviews,
      moderator: { consensus: ['x'], openIssues: ['鉴权'], conflicts: [{ topic: '缓存', sides: [] }], revisionDirectives: ['必须补'] },
      stats,
    },
  ];
  const participants = [
    { floor_id: '4F', role: 'moderator', agent: 'claude', status: 'ok' },
    { floor_id: '1F', role: 'main', agent: 'codebuddy', status: 'ok' },
    { floor_id: '7F', role: 'reviewer', agent: 'kilo', status: 'ok' },
  ];
  const utterances = [
    u({ floor_id: '4F', model: 'claude-opus', input_tokens: 10, output_tokens: 2 }),
    u({ floor_id: '1F', model: 'gpt-5.1', input_tokens: 20, output_tokens: 4 }),
    u({ floor_id: '7F', model: 'kimi-k2', input_tokens: 30, output_tokens: 6 }),
  ];
  const report = buildReportJson({
    council: {
      id: 'c1', topic: 'refactor', status: 'done', verdict: 'completed', max_rounds: 3,
      workspace_path: null, created_at: 1, started_at: 2, ended_at: 3, error: null,
    },
    participants,
    utterances,
    rounds,
    reviews,
    plan: { parsed: true, breakdown: ['A'], assignments: [], reviewFocus: [] },
    adjudication: { parsed: true, decision: 'approve', summary: 'ok', remainingRisks: [], finalDirectives: [] },
    finalDraft: { parsed: true, content: 'final', changeNotes: 'notes' },
    finalScore: stats,
    warnings: [{ code: 'vague_directives', message: 'm' }],
  });

  ok('schema id is pinned (archives must stay readable)', report.schema === REPORT_SCHEMA);
  ok('council identity and lifecycle are preserved',
    report.council.id === 'c1' && report.council.verdict === 'completed' && report.council.roundsCompleted === 2);
  ok('a missing workspace is null, not ""', report.council.workspacePath === null);

  ok('final score comes from the server-computed stats', report.score.final === 63 && report.score.max === 100);
  eq('score trend lists every round', report.score.trend, [{ round: 1, score: 100 }, { round: 2, score: 63 }]);
  eq('the formula is the same one the UI shows', report.score.formula, scoreFormula(stats));
  eq('weights are embedded for reproducibility', [report.score.weights, report.score.conflictWeight], [
    { blocker: 25, major: 8, minor: 2, nit: 0 },
    10,
  ]);

  ok('summary counts come from the LAST round', report.summary.reviewCount === 2 && report.summary.blockers === 1 && report.summary.minors === 1 && report.summary.conflicts === 1);
  eq('warnings are carried into the archive', report.summary.warnings.map((w) => w.code), ['vague_directives']);

  ok('every role is listed with its model', report.roles.length === 3 && report.roles[0].model === 'claude-opus' && report.roles[2].model === 'kimi-k2');
  ok('per-role tokens are summed', report.roles[1].tokens.total === 24 && report.roles[1].tokens.exact === true);
  ok('a role with no turns shows — (null), not 0', buildReportJson({ participants: [{ floor_id: '9F', role: 'reviewer', agent: 'x' }] }).roles[0].tokens.total === null);
  ok('plan / adjudication / final draft survive', report.plan.breakdown[0] === 'A' && report.adjudication.decision === 'approve' && report.finalDraft.content === 'final');
  ok('files starts empty (writeCouncilReports fills it)', Array.isArray(report.files) && report.files.length === 0);
}
{
  const bare = buildReportJson({ council: { id: 'empty', topic: 't', max_rounds: 2 } });
  ok('no rounds: final score / formula are null (not 0/100)', bare.score.final === null && bare.score.formula === null);
  ok('no rounds: summary counters are 0', bare.summary.rounds === 0 && bare.summary.blockers === 0 && bare.summary.reviewCount === 0);
  eq('no rounds: empty trend', bare.score.trend, []);
}

/* ------------------------------------------------------------ CSV */
head('CSV: one review per row, Excel-safe');
{
  const csv = reviewsCsv([
    { round_no: 1, reviewer: '7F', severity: 'blocker', dimension: '安全', issue: 'a,b', evidence: null, suggestion: 'say "no"', stance: 'reject' },
    { round_no: 1, reviewer: '8F', severity: 'nit', dimension: '文档', issue: 'line\nbreak', evidence: 'e', suggestion: 's', stance: 'accept' },
  ]);
  ok('starts with a UTF-8 BOM', csv.startsWith(BOM));
  ok('header names every field', csv.split('\r\n')[0].includes('round,reviewer,severity,dimension,issue,evidence,suggestion,stance'));
  ok('a comma and a quote are escaped', csv.includes('"a,b"') && csv.includes('"say ""no"""'));
  ok('a newline inside a cell is quoted, not split', csv.includes('"line\nbreak"'));
  ok('null evidence becomes an empty cell (not the string "null")', csv.includes(',,'));
  ok('CRLF row endings', csv.endsWith('\r\n'));
  ok('empty input still yields a header', reviewsCsv([]).split('\r\n')[0].includes('round'));
}
{
  const csv = roundsCsv([
    {
      round: 2,
      proposal: { version: 'v2', diffFromPrev: '加了鉴权' },
      stats: {
        bySeverity: { blocker: 1, major: 2, minor: 3, nit: 4 },
        conflicts: 1,
        score: 39,
        deduction: 61,
      },
      moderator: { openIssues: ['A', 'B'], revisionDirectives: ['必须 X', '必须 Y'] },
    },
  ]);
  ok('BOM', csv.startsWith(BOM));
  ok('severity counts, conflicts, score and deduction are in the row',
    csv.includes('2,v2,1,2,3,4,1,39,61'));
  ok('open issues / directives are joined with a Chinese semicolon', csv.includes('A；B') && csv.includes('必须 X；必须 Y'));
  ok('the per-round diff is exported', csv.includes('加了鉴权'));
  ok('a round with no stats writes empty score/deduction cells, not 0',
    roundsCsv([{ round: 1, proposal: {} }]).includes('1,,0,0,0,0,0,,,,'));
}

/* ------------------------------------------------------------ Markdown */
head('Markdown: the human-readable evidence');
{
  const report = buildReportJson({
    council: { id: 'c1', topic: '重构议事厅', status: 'done', verdict: 'completed', max_rounds: 2, workspace_path: '/w' },
    participants: [
      { floor_id: '4F', role: 'moderator', agent: 'claude' },
      { floor_id: '1F', role: 'main', agent: 'codebuddy' },
    ],
    utterances: [u({ floor_id: '4F', model: 'm1', input_tokens: 7, output_tokens: 3 })],
    rounds: [
      {
        round: 1,
        proposal: { version: 'v1', content: '方案正文', diffFromPrev: null },
        reviews: [
          { reviewer: '7F', severity: 'blocker', dimension: '安全', issue: '缺鉴权', evidence: 'line 4', suggestion: '加中间件', stance: 'reject' },
        ],
        moderator: {
          consensus: ['方向一致'],
          openIssues: ['鉴权未落地'],
          conflicts: [{ topic: '缓存', sides: [{ reviewer: '7F', view: '要' }, { reviewer: '8F', view: '不要' }] }],
          revisionDirectives: ['【针对 鉴权】必须加中间件；验收标准：401。'],
        },
        stats: { ...buildStats(), score: 65 },
      },
    ],
    adjudication: { decision: 'approve_with_changes', summary: '可以落地', remainingRisks: ['压测'], finalDirectives: ['必须补压测'] },
    finalDraft: { content: '最终稿正文', changeNotes: '补了压测' },
    finalScore: { ...buildStats(), score: 65 },
    warnings: [{ code: 'vague_directives', message: '有 1 条模糊指令' }],
  });
  const md = reportMarkdown(report);
  ok('title carries the topic', md.startsWith('# 议事厅报告：重构议事厅'));
  ok('score and formula are visible', md.includes('收敛度：**65 / 100**') && md.includes('100 - ('));
  ok('severity summary', md.includes('blocker 1、major 0、minor 0、nit 0'));
  ok('token cell is exact when known', md.includes('| 4F | moderator | claude | — | m1 | 10 （输入 7 / 输出 3） |'));
  ok('a role with no usage prints —, not 0', md.includes('| 1F | main | codebuddy | — | — | — |'));
  ok('warnings section', md.includes('## 一致性提示') && md.includes('有 1 条模糊指令'));
  ok('round, proposal, diff placeholder, review, moderator summary are present',
    md.includes('## 第 1 轮（v1）') && md.includes('方案正文') && md.includes('缺鉴权') && md.includes('## 主持人汇总'));
  ok('conflict sides are rendered', md.includes('缓存：7F 要 / 8F 不要'));
  ok('per-round formula is rendered', md.includes('本轮收敛度：65（100 - ('));
  ok('adjudication and final draft are included',
    md.includes('## 最终裁决') && md.includes('approve_with_changes') && md.includes('## 最终交付稿') && md.includes('补了压测'));
  ok('the workspace path is rendered when given', md.includes('工作目录：`/w`'));
}
{
  const md = reportMarkdown(buildReportJson({ council: { id: 'x', topic: 't', max_rounds: 1 } }));
  ok('an empty archive degrades gracefully', md.includes('收敛度：**— / 100**') && md.includes('- 评审意见：0 条'));
  ok('no rounds: no round sections are fabricated', !md.includes('## 第 1 轮'));
}
{
  const report = buildReportJson({
    council: {
      id: 'c-clarify',
      topic: '检查一个还没给出路径的项目',
      status: 'done',
      verdict: 'needs_clarification',
      max_rounds: 2,
    },
    participants: [
      { floor_id: '4F', role: 'moderator', agent: 'claude', status: 'needs_clarification' },
      { floor_id: '1F', role: 'main', agent: 'codebuddy', status: 'skipped' },
      { floor_id: '7F', role: 'reviewer', agent: 'kilo', status: 'skipped' },
    ],
    utterances: [],
    rounds: [],
    plan: {
      parsed: true,
      breakdown: [],
      assignments: [],
      reviewFocus: [],
      needsClarification: ['请给出需要评审的项目绝对路径'],
    },
  });
  const md = reportMarkdown(report);
  ok('a clarification meeting is archived with its questions',
    md.includes('## 需要补充信息') && md.includes('- 请给出需要评审的项目绝对路径'));
  ok('roles that never ran are marked skipped in the report',
    md.includes('| 1F | main | codebuddy | skipped |') &&
      md.includes('| 7F | reviewer | kilo | skipped |'));
}

/* ------------------------------------------------------------ writing */
head('writing files');
{
  const report = buildReportJson({
    council: { id: 'c-write', topic: '落盘', status: 'done', verdict: 'completed', max_rounds: 1 },
    participants: [{ floor_id: '1F', role: 'main', agent: 'x' }],
    rounds: [],
    finalScore: null,
  });

  const first = writeCouncilReports({ councilId: 'c-write', report });
  ok('four files are written to the home export dir', first.files.length === 4, String(first.files.length));
  const dir = path.join(TMP, 'home', 'councils', 'c-write');
  const names = first.files.map((f) => path.basename(f)).sort();
  eq('the archive consists of rounds/reviews/report.md/report.json', names, ['report.json', 'report.md', 'reviews.csv', 'rounds.csv']);
  ok('files live under councils/<id>/', first.files.every((f) => path.dirname(f) === dir));

  const json = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  ok('report.json lists its sibling files', json.files.length === 4 && json.files.includes(path.join(dir, 'report.json')));
  ok('CSV files carry a BOM on disk', fs.readFileSync(path.join(dir, 'reviews.csv')).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));

  // A workspace path is still passed through by older callers; it must not cause any write.
  const ws = path.join(TMP, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  const withWs = writeCouncilReports({ councilId: 'c-write', workspacePath: ws, writeWorkspace: true, report });
  ok('the workspace is never written to, even when one was supplied', fs.readdirSync(ws).length === 0);
  ok('every reported file is still under the home archive',
    withWs.files.length === 4 && withWs.files.every((f) => path.dirname(f) === dir));

  // A second run must not replace evidence. Wait past the one-second timestamp resolution.
  const original = fs.readFileSync(path.join(dir, 'report.json'), 'utf8');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
  const second = writeCouncilReports({ councilId: 'c-write', report });
  ok('a second run writes new files instead of overwriting', second.files.length === 4 &&
    second.files.every((f) => !first.files.includes(f)));
  ok('the first report.json is untouched', fs.readFileSync(path.join(dir, 'report.json'), 'utf8') === original);
  ok('the timestamp-suffixed copy exists', second.files.some((f) => /report-\d{8}-\d{6}\.json$/.test(f)));
}
{
  // Handing in a path that is not even a directory must not matter: nothing is written there.
  const blocked = path.join(TMP, 'not-a-dir');
  fs.writeFileSync(blocked, 'x');
  const r = writeCouncilReports({ councilId: 'c-fail', workspacePath: blocked, writeWorkspace: true, report: buildReportJson({}) });
  ok('a unusable workspace path does not affect the home archive',
    r.files.length === 4 && fs.readFileSync(blocked, 'utf8') === 'x');
}
{
  const r = writeCouncilReports({ councilId: '../evil', report: buildReportJson({}) });
  ok('a traversal-like id cannot escape councils/', r.files.every((f) => f.startsWith(path.join(TMP, 'home', 'councils') + path.sep)));
  const dirs = fs.readdirSync(path.join(TMP, 'home', 'councils'));
  ok('the id is sanitized to a single directory name', dirs.includes('.._evil'), dirs.join(','));
}
{
  const dir = path.join(TMP, 'unique');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), 'x');
  const p = uniquePath(dir, 'report', '.json');
  ok('uniquePath never returns an existing name', p !== path.join(dir, 'report.json') && /report-\d{8}-\d{6}\.json$/.test(p));
}

function buildStats() {
  return {
    total: 1,
    bySeverity: { blocker: 1, major: 0, minor: 0, nit: 0 },
    byDimension: { 安全: 1 },
    byStance: { reject: 1, revise: 0, accept: 0 },
    conflicts: 0,
    weights: { blocker: 25, major: 8, minor: 2, nit: 0 },
    conflictWeight: 10,
    deduction: 25,
    rawScore: 75,
    score: 75,
    clamped: false,
  };
}

console.log(`\n${fail ? '✗' : '✓'} council-report: ${pass} passed / ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
