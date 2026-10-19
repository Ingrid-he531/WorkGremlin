/**
 * Council structured-output parsing self-check — pure functions, no DB, no processes.
 *
 * The contract: find the **last** JSON block (models show examples mid-text), forgive location, but never
 * forgive meaning. An unusable review item is dropped and counted; it is never patched with a guessed
 * severity or stance. A recognized-but-empty block (`{"conflicts":[]}`) is a legitimate answer and must
 * stay `parsed: true`.
 *
 * Run: `npm run test:council-parse`
 */
'use strict';

const {
  findLastJsonChunk,
  extractBalanced,
  normalizeSeverity,
  normalizeStance,
  normalizeDecision,
  parsePlanBlock,
  parseProposalBlock,
  parseReviewBlock,
  parseModerationBlock,
  parseAdjudicationBlock,
  parseFinalBlock,
} = require('../src/council/parse');

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

/* ------------------------------------------------------------ locating blocks */
head('locating the answer block');
{
  const text = 'example: {"a":1}\n\nfinal:\n```json\n{"a":2}\n```\n';
  const found = findLastJsonChunk(text, (o) => 'a' in o);
  ok('the LAST fenced block wins (a mid-text example is ignored)', found && found.obj.a === 2);
  ok('the returned range covers the fence', text.slice(found.start, found.end).startsWith('```json'));
}
{
  const found = findLastJsonChunk('prefix {"a":1} middle {"a":2} suffix', (o) => 'a' in o);
  ok('without a fence, the last balanced inline object wins', found && found.obj.a === 2);
}
{
  const s = '{"k":"a } brace inside a string","n":1}';
  const found = findLastJsonChunk(s, (o) => o.n === 1);
  ok('braces inside a string do not end the object early', found && found.obj.k === 'a } brace inside a string');
  ok('extractBalanced handles the same input', extractBalanced(s, 0) === s);
}
{
  ok('invalid JSON is ignored (no throw)', findLastJsonChunk('{"a": }', () => true) === null);
  ok('a scalar array contains no object', findLastJsonChunk('[1,2]', () => true) === null);
  ok('an object failing the predicate is ignored', findLastJsonChunk('{"a":1}', (o) => 'b' in o) === null);
  ok('empty input yields null', findLastJsonChunk('', () => true) === null);
}
{
  // Regression: scanning backwards from the last `{` used to return the last array element. The
  // wrapping object must win, otherwise every review except the final one silently disappears.
  const text = '{"reviews":[{"issue":"one"},{"issue":"two"},{"issue":"three"}]}';
  const found = findLastJsonChunk(text, (o) => Array.isArray(o.reviews));
  ok('an object wrapping an array wins over its last element', found && found.obj.reviews.length === 3);
}

/* ------------------------------------------------------------ vocabularies */
head('severity / stance / decision vocabularies');
{
  eq('severity synonyms collapse to the four levels',
    ['P0', 'critical', '阻断', 'high', '严重', 'low', '一般', 'suggestion', '细节'].map(normalizeSeverity),
    ['blocker', 'blocker', 'blocker', 'major', 'major', 'minor', 'minor', 'nit', 'nit']);
  eq('unknown severity is null, not a default', normalizeSeverity('catastrophic'), null);
  eq('empty severity is null', normalizeSeverity('  '), null);

  eq('stance synonyms',
    ['拒绝', 'against', '修改', '有条件通过', '支持', 'yes'].map(normalizeStance),
    ['reject', 'reject', 'revise', 'revise', 'accept', 'accept']);
  eq('unknown stance is null', normalizeStance('meh'), null);

  eq('decision synonyms',
    ['通过', 'approved', '修改后通过', 'conditional', '拒绝', 'fail'].map(normalizeDecision),
    ['approve', 'approve', 'approve_with_changes', 'approve_with_changes', 'reject', 'reject']);
  eq('unknown decision is null', normalizeDecision('whatever'), null);
}

/* ------------------------------------------------------------ round 0 plan */
head('round 0: moderator plan');
{
  const p = parsePlanBlock(`拆解如下。\n{"breakdown":["问题 A","问题 B"],"assignments":[{"reviewer":"7F","focus":"安全"},{"floor":"8F"}],"reviewFocus":["性能"]}`);
  ok('parsed', p.parsed === true);
  eq('breakdown preserved in order', p.breakdown, ['问题 A', '问题 B']);
  eq('assignments accept floor as an alias; a missing focus stays null', p.assignments, [
    { reviewer: '7F', focus: '安全' },
    { reviewer: '8F', focus: null },
  ]);
  eq('reviewFocus', p.reviewFocus, ['性能']);
}
{
  const p = parsePlanBlock('I will decompose the topic, no JSON.');
  ok('prose without a block: parsed=false and every list empty', p.parsed === false && p.breakdown.length === 0);
  const e = parsePlanBlock('');
  ok('empty text: parsed=false', e.parsed === false);
  const loose = parsePlanBlock('{"assignments":[null,"x",{"reviewer":"  "},{"reviewer":"9F","focus":" "}]}');
  ok('malformed assignment rows are skipped, not invented', loose.assignments.length === 1 && loose.assignments[0].reviewer === '9F' && loose.assignments[0].focus === null);
}

/* ------------------------------------------------------------ proposal */
head('proposal');
{
  const p = parseProposalBlock(`这是方案正文。\n\n\`\`\`json\n{"version":"v1","diffFromPrev":"相比上版增加了鉴权","addressed":[{"directive":"补鉴权","how":"加了中间件"},{"directive":"写测试"}]}\n\`\`\``);
  ok('the body minus the JSON block is the content', p.content === '这是方案正文。');
  ok('metadata is read', p.parsed && p.version === 'v1' && p.diffFromPrev === '相比上版增加了鉴权');
  eq('addressed keeps both directives; a missing how is null', p.addressed, [
    { directive: '补鉴权', how: '加了中间件' },
    { directive: '写测试', how: null },
  ]);
}
{
  const p = parseProposalBlock('{"version":"v2","content":"整篇方案都在 content 里"}');
  ok('inline content wins over the surrounding prose', p.content === '整篇方案都在 content 里');
}
{
  const p = parseProposalBlock('纯文本方案，没有 JSON。');
  ok('no block: parsed=false but the prose is still the content (never dropped)', p.parsed === false && p.content === '纯文本方案，没有 JSON。');
  ok('no block: version/diff are null, not empty strings', p.version === null && p.diffFromPrev === null);
}

/* ------------------------------------------------------------ review */
head('review points');
{
  const text = `我的意见如下。
{"stance":"revise","reviews":[
  {"severity":"blocker","dimension":"安全","issue":"没有鉴权","evidence":"line 4","suggestion":"加中间件","stance":"reject"},
  {"severity":"P3","issue":"错别字","suggestion":"改掉"},
  {"severity":"blocker","issue":"缺建议"},
  {"severity":"major","issue":"缺立场","suggestion":"补上"}
]}`;
  const r = parseReviewBlock(text);
  ok('parsed; 3 usable points', r.parsed === true && r.reviews.length === 3, String(r.reviews.length));
  ok('the point missing a suggestion is counted, not silently lost', r.dropped === 1, String(r.dropped));
  eq('first point is fully mapped', r.reviews[0], {
    severity: 'blocker',
    dimension: '安全',
    issue: '没有鉴权',
    evidence: 'line 4',
    suggestion: '加中间件',
    stance: 'reject',
  });
  ok('missing dimension falls back to 其他', r.reviews[1].dimension === '其他');
  ok('missing evidence is null', r.reviews[1].evidence === null);
  ok('missing per-item stance inherits the overall stance', r.reviews[1].stance === 'revise');
  ok('a later point missing its stance also inherits it', r.reviews[2].severity === 'major' && r.reviews[2].stance === 'revise');
  ok('the server assigns reviewer identity (the parser never returns one)',
    r.reviews.every((x) => !('reviewer' in x)));
  ok('overall stance is reported separately', r.overallStance === 'revise');
}
{
  const r = parseReviewBlock('{"reviews":[{"severity":"major","issue":"缺立场","suggestion":"补上"}]}');
  ok('with no overall stance, a point with no stance is unusable (not defaulted to accept)',
    r.reviews.length === 0 && r.dropped === 1);
}
{
  const single = parseReviewBlock('{"severity":"minor","issue":"命名","suggestion":"重命名","stance":"accept"}');
  ok('a bare review object (no reviews array) is treated as one point', single.reviews.length === 1 && single.reviews[0].severity === 'minor');
  const empty = parseReviewBlock('我同意，没有意见。{"reviews":[]}');
  ok('a recognized empty review list is parsed=true (a legitimate "no issues")', empty.parsed === true && empty.reviews.length === 0);
  const none = parseReviewBlock('我同意，没有 JSON 块。');
  ok('no block: parsed=false, so the caller can flag an incomplete review', none.parsed === false);
}

/* ------------------------------------------------------------ moderation */
head('moderator convergence block');
{
  const text = `收敛如下。
{"consensus":["鉴权方案达成一致"],"openIssues":["性能未验证"],
 "conflicts":[{"topic":"是否缓存","sides":[{"reviewer":"7F","view":"要缓存"},{"floor":"8F","opinion":"先不缓存"}]},
              {"topic":"","sides":[{"reviewer":"7F","view":"x"}]}],
 "revisionDirectives":["【针对 性能】必须补压测；验收标准：QPS 数据。",{"directive":"【针对 鉴权】必须加测试；验收标准：覆盖率 80%。"}],
 "convergenceScore": 99}`;
  const m = parseModerationBlock(text);
  ok('parsed', m.parsed === true);
  eq('consensus', m.consensus, ['鉴权方案达成一致']);
  eq('openIssues', m.openIssues, ['性能未验证']);
  ok('a conflict with a topic and both sides is kept', m.conflicts.length === 1 && m.conflicts[0].topic === '是否缓存');
  eq('side aliases (floor/opinion) are normalized', m.conflicts[0].sides, [
    { reviewer: '7F', view: '要缓存' },
    { reviewer: '8F', view: '先不缓存' },
  ]);
  ok('a conflict without a topic is dropped and counted', m.dropped === 1, String(m.dropped));
  ok('directives accept both strings and {directive} wrappers',
    m.revisionDirectives.length === 2 && m.revisionDirectives[0].includes('压测') && m.revisionDirectives[1].includes('覆盖率'));
  ok('a model-reported convergenceScore is NOT part of the parse result (server computes it)', !('convergenceScore' in m));
}
{
  const empty = parseModerationBlock('{"consensus":[],"openIssues":[],"conflicts":[],"revisionDirectives":[]}');
  ok('an explicitly empty round stays parsed=true', empty.parsed === true && empty.conflicts.length === 0 && empty.dropped === 0);
  ok('no block: parsed=false', parseModerationBlock('大家都同意。').parsed === false);
  const junk = parseModerationBlock('{"conflicts":[null,42,{"topic":"x","sides":[{"reviewer":"7F"}]}]}');
  ok('invalid conflict rows are counted as dropped, not invented',
    junk.dropped === 3 && junk.conflicts.length === 0, String(junk.dropped));
}

/* ------------------------------------------------------------ adjudication */
head('final adjudication');
{
  const a = parseAdjudicationBlock(`最终裁定。
{"verdict":"approve_with_changes","conclusion":"可以落地，但需补齐压测",
 "risks":["压测缺失"],"directives":["【针对 压测】必须补；验收标准：有报告。"]}`);
  ok('parsed', a.parsed === true);
  ok('decision aliases map to the canonical three', a.decision === 'approve_with_changes');
  ok('summary accepts conclusion', a.summary === '可以落地，但需补齐压测');
  eq('remaining risks', a.remainingRisks, ['压测缺失']);
  eq('final directives', a.finalDirectives, ['【针对 压测】必须补；验收标准：有报告。']);
  ok('an unknown decision stays null (the caller must not infer approval)', parseAdjudicationBlock('{"decision":"looks fine"}').decision === null);
  ok('empty lists remain parsed=true', parseAdjudicationBlock('{"decision":"approve","remainingRisks":[]}').parsed === true);
  ok('no block: parsed=false', parseAdjudicationBlock('Approved.').parsed === false);
}

/* ------------------------------------------------------------ final draft */
head('final draft');
{
  const f = parseFinalBlock(`最终稿正文。\n{"changeNotes":"补了压测章节","addressed":[{"directive":"补压测","how":"新增第 5 节"}]}`);
  ok('content is the prose', f.content === '最终稿正文。');
  ok('changeNotes read', f.parsed && f.changeNotes === '补了压测章节');
  eq('addressed', f.addressed, [{ directive: '补压测', how: '新增第 5 节' }]);
  const inline = parseFinalBlock('{"finalDraft":"全文","changes":"无"}');
  ok('finalDraft/changes aliases work', inline.content === '全文' && inline.changeNotes === '无');
  const raw = parseFinalBlock('没有 JSON 的最终稿。');
  ok('no block: the whole message is kept as the draft', raw.parsed === false && raw.content === '没有 JSON 的最终稿。');
}

console.log(`\n${fail ? '✗' : '✓'} council-parse: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
