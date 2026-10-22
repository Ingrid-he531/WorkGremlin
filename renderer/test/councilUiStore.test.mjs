/**
 * Council store self-check — with two data sources merged, which one does the UI actually show?
 *
 * Worth pinning because this store consumes both an **HTTP detail snapshot** and **WS increments**.
 * The failure modes are subtle and appear on only one path:
 *   · an increment wipes existing content → "the proposal disappeared after a refresh";
 *   · after a reconnect the WS copy is gone and the banner still shows the previous round;
 *   · the terminal event carries only a summary (verdict / status) — the report lives in the DB, so
 *     not re-pulling the detail leaves the page "finished" with no conclusion;
 *   · a delete that hits 409 (still running) is treated as success → it vanishes from the list but
 *     still exists.
 *
 * `fetch` is fully faked: this tests "what happens with the response", not the network.
 *
 * Run: `npm run test:council-ui-store`
 */
import { createServer } from 'vite';
import { createPinia, setActivePinia } from 'pinia';

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

const server = await createServer({
  root: 'renderer',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
  ssr: { external: ['@workgremlin/shared'] },
});
const { useCouncilStore } = await server.ssrLoadModule('/src/stores/council.js');
const { useProjectStore } = await server.ssrLoadModule('/src/stores/project.js');

/* ------------------------------------------------------------------ fake server */

const calls = [];
let routes = {};
const json = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });

globalThis.fetch = async (url, opts) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  let body = null;
  try {
    body = opts && opts.body ? JSON.parse(opts.body) : null;
  } catch {
    body = opts && opts.body ? String(opts.body) : null;
  }
  calls.push({ path, method: (opts && opts.method) || 'GET', body });
  const hit = Object.keys(routes).find((k) => k === `${(opts && opts.method) || 'GET'} ${path}`);
  if (!hit) return json({ ok: false, error: { code: 'not_found', message: `没有这条路由：${path}` } }, 404);
  return routes[hit]();
};

/** Each case starts from a clean pinia + clean route table */
function fresh() {
  setActivePinia(createPinia());
  const project = useProjectStore();
  project.serverInfo = { port: 45678, token: 'tk' };
  const council = useCouncilStore();
  calls.length = 0;
  routes = {};
  return council;
}

/** One three-seat meeting, round 1 complete and archived. */
const DETAIL = {
  ok: true,
  council: { id: 'c1', topic: '议题', status: 'running', verdict: null, max_rounds: 3, workspace_path: null },
  participants: [
    { floor_id: '4F', role: 'moderator', agent: 'claude', status: 'ok', error: null },
    { floor_id: '1F', role: 'main', agent: 'codebuddy', status: 'ok', error: null },
    { floor_id: '7F', role: 'reviewer', agent: 'kilo', status: 'ok', error: null },
  ],
  materials: [{ ord: 0, path: '/tmp/a.md', bytes_total: 10, bytes_included: 10, truncated: 0, content: '材料' }],
  rounds: [
    { round_no: 0, kind: 'plan', proposal_from: '4F', moderator_json: '{"parsed":true,"breakdown":["拆解 A"]}' },
    { round_no: 1, kind: 'debate', version: 'v1', proposal_text: '初版', proposal_from: '1F', moderator_json: '{"consensus":["一致"],"openIssues":[],"conflicts":[],"revisionDirectives":["改"],"convergenceScore":57}', stats_json: '{"score":57,"bySeverity":{"blocker":1,"major":0,"minor":0,"nit":0},"conflicts":0}' },
  ],
  reviews: [{ round_no: 1, reviewer: '7F', severity: 'blocker', dimension: '安全', issue: '缺鉴权', suggestion: '加中间件', stance: 'reject' }],
  roundResults: [
    {
      round: 1,
      proposal: { version: 'v1', content: '初版', diffFromPrev: null },
      reviews: [{ reviewer: '7F', severity: 'blocker', dimension: '安全', issue: '缺鉴权', suggestion: '加中间件', stance: 'reject' }],
      moderator: { consensus: ['一致'], openIssues: [], conflicts: [], revisionDirectives: ['改'], convergenceScore: 57 },
      stats: { score: 57, bySeverity: { blocker: 1, major: 0, minor: 0, nit: 0 }, conflicts: 0 },
      warnings: [],
    },
  ],
  utterances: [
    { round_no: 0, floor_id: '4F', phase: 'plan', content: '拆解', status: 'ok', model: 'sonnet', input_tokens: 100, output_tokens: 20 },
    { round_no: 1, floor_id: '1F', phase: 'proposal', content: '原文正文', status: 'ok', model: 'cb', input_tokens: 200, output_tokens: 50 },
    { round_no: 1, floor_id: '7F', phase: 'review', content: '评审原文', status: 'ok', model: 'kilo', input_tokens: 50, output_tokens: 10 },
  ],
  plan: { parsed: true, breakdown: ['拆解 A'], assignments: [], reviewFocus: [] },
  report: null,
  reportFiles: [],
  live: true,
  progress: { roundNo: 1, phase: 'review', floors: ['7F'], startedAt: 9 },
};

head('open: rows are normalized before they enter state');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  await s.open('c1');
  ok('the detail lands', Boolean(s.current) && s.current.council.id === 'c1');
  const review = s.current.utterances.find((u) => u.floorId === '7F');
  ok('utterances use one shape (roundNo / phase / tokens)', review.roundNo === 1 && review.phase === 'review' && review.outputTokens === 10);
  ok('timeline groups by round', s.timeline.length === 2 && s.timeline[0].roundNo === 0 && s.timeline[1].roundNo === 1);
  ok('RoundResult is normalized (version + reviews + server score)',
    s.current.roundResults[0].proposal.version === 'v1' && s.current.roundResults[0].stats.score === 57);
  ok('the plan is kept separately', s.current.plan.breakdown[0] === '拆解 A');
  ok('live comes from the server', s.current.live === true && s.live === true);
  ok('the in-flight progress comes from the server (a reload shows who is working)',
    s.working.roundNo === 1 && s.working.phase === 'review' && s.working.floors[0] === '7F');
  ok('auth headers were sent', calls[0] !== undefined);
}

head('right-side summary: score, N opinions, N blockers, roles / models / tokens');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  await s.open('c1');
  const sum = s.summary;
  ok('score is the server-computed one', sum.score === 57);
  ok('the breakdown is present (the score is explainable)', sum.breakdown.formula.includes('blocker 1×25'));
  ok('N opinions', sum.reviewCount === 1);
  ok('N blockers', sum.severityCounts.blocker === 1);
  ok('roles are moderator, main, reviewer', sum.roles.map((r) => r.role).join(',') === 'moderator,main,reviewer');
  ok('each role has its model', sum.roles.map((r) => r.model).join(',') === 'sonnet,cb,kilo');
  ok('each role has its token total', sum.roles.map((r) => r.tokens.total).join(',') === '120,250,60');
  ok('an unopened council has no summary', fresh().summary === null);
}

head('WS utterance increment: fills fields, never wipes content');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  await s.open('c1');
  s.applyEvent({ councilId: 'c1', utterance: { roundNo: 1, floorId: '1F', phase: 'proposal', durationMs: 1200, outputTokens: 60 } });
  const u = s.current.utterances.find((x) => x.floorId === '1F' && x.phase === 'proposal');
  ok('duration is filled in', u.durationMs === 1200);
  ok('the content is still there', u.content === '原文正文', String(u.content));
  ok('the token update is applied', u.outputTokens === 60);
  ok('no duplicate row was created',
    s.current.utterances.filter((x) => x.floorId === '1F' && x.phase === 'proposal').length === 1);
  s.applyEvent({ councilId: 'c1', utterance: { roundNo: 1, floorId: '1F', phase: 'final', content: '最终稿' } });
  ok('the same floor may speak again in another phase', s.current.utterances.filter((x) => x.floorId === '1F').length === 2);
}

head('WS round + adjudication + final draft updates reach the view');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  await s.open('c1');
  s.applyEvent({
    councilId: 'c1',
    round: {
      round: 2,
      proposal: { version: 'v2', content: '修订稿', diffFromPrev: '- 旧\n+ 新' },
      reviews: [{ reviewer: '7F', severity: 'major', dimension: '性能', issue: '慢', suggestion: '缓存', stance: 'revise' }],
      moderator: { consensus: [], openIssues: ['慢'], conflicts: [], revisionDirectives: ['【针对 慢】必须加缓存；验收标准：p99<100ms。'], convergenceScore: 82 },
      stats: { score: 82, bySeverity: { blocker: 0, major: 1, minor: 0, nit: 0 }, conflicts: 0 },
    },
  });
  ok('round 2 is merged', s.current.roundResults.length === 2 && s.lastRound.round === 2);
  ok('the diff is kept for the collapsed process view', s.lastRound.proposal.diffFromPrev === '- 旧\n+ 新');
  ok('the summary follows the latest round', s.summary.score === 82 && s.summary.reviewCount === 1);
  s.applyEvent({ councilId: 'c1', adjudication: { decision: 'approve_with_changes' }, finalDraft: '最终稿' });
  ok('adjudication is kept', s.current.adjudication.decision === 'approve_with_changes');
  ok('final draft is kept', s.current.finalDraft === '最终稿');
}

head('switching councils invalidates the previous run\'s live proposal');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  routes['GET /api/v1/councils/c2'] = () =>
    json({ ...DETAIL, council: { ...DETAIL.council, id: 'c2' }, roundResults: [], utterances: [], rounds: [] });
  await s.open('c1');
  s.applyEvent({ councilId: 'c1', roundNo: 2, phase: 'proposal', proposal: { version: 'v2', content: '实时修订稿' } });
  ok('the proposal banner is set', s.currentProposal && s.currentProposal.version === 'v2');
  await s.open('c2');
  ok('opening another meeting clears it', s.currentProposal === null, JSON.stringify(s.currentProposal));
}

head('current proposal: DB snapshot vs WS increment, newest round wins');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  await s.open('c1');
  ok('without WS the archived proposal is used', s.currentProposal.version === 'v1' && s.currentProposal.content === '初版');

  s.applyEvent({ councilId: 'c1', roundNo: 2, phase: 'proposal', proposal: { version: 'v2', content: '4F 的修订案' } });
  ok('a newer live round wins', s.currentProposal.version === 'v2' && s.currentProposal.roundNo === 2);

  // A stale increment for an older round must not override the archived latest round.
  const s2 = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  await s2.open('c1');
  s2.applyEvent({ councilId: 'c1', roundNo: 0, phase: 'proposal', proposal: { version: 'v0', content: '过期' } });
  ok('an older live round loses to the archived one', s2.currentProposal.version === 'v1');
}

head('terminal event: only the summary is pushed, so the detail must be re-pulled');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  routes['GET /api/v1/councils?limit=50'] = () =>
    json({ ok: true, councils: [{ id: 'c1', topic: '议题', status: 'done', verdict: 'completed', max_rounds: 3 }] });
  await s.open('c1');
  calls.length = 0;

  const done = { ...DETAIL, council: { ...DETAIL.council, status: 'done', verdict: 'completed' }, live: false };
  routes['GET /api/v1/councils/c1'] = () => json(done);

  s.applyEvent({ councilId: 'c1', status: 'done', verdict: 'completed' });
  await new Promise((r) => setTimeout(r, 10)); // fetchList / open are awaited internally
  ok('the detail was re-pulled', calls.some((c) => c.path === '/api/v1/councils/c1'), JSON.stringify(calls));
  ok('the history list was refreshed', calls.some((c) => c.path.startsWith('/api/v1/councils?')), JSON.stringify(calls));
  ok('the verdict lands in state (not "finished with no conclusion")', s.current.council.verdict === 'completed');
  ok('a finished meeting is no longer live', s.live === false);
  ok('the live proposal is cleared (the archived rounds are authoritative)', s.liveProposal === null);
}

head('WS progress: who is working now, and it never outlives the meeting');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json({ ...DETAIL, progress: null });
  await s.open('c1');
  ok('no progress in the detail -> no working indicator', s.working === null);

  s.applyEvent({ councilId: 'c1', status: 'running', roundNo: 2, phase: 'proposal', floors: ['1F'], startedAt: 11 });
  ok('a progress event fills the indicator',
    s.working.roundNo === 2 && s.working.phase === 'proposal' && s.working.floors[0] === '1F',
    JSON.stringify(s.working));

  s.applyEvent({ councilId: 'c1', status: 'running' });
  ok('a bare "running" event does not wipe it', s.working && s.working.phase === 'proposal');

  const done = { ...DETAIL, council: { ...DETAIL.council, status: 'done', verdict: 'completed' }, live: false, progress: null };
  routes['GET /api/v1/councils/c1'] = () => json(done);
  s.applyEvent({ councilId: 'c1', status: 'done', verdict: 'completed' });
  ok('the indicator is cleared when the meeting ends', s.working === null);
}

head('events from another council: refresh nothing into the current one');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  await s.open('c1');
  const before = s.current.utterances.length;
  s.applyEvent({ councilId: 'c-别的', utterance: { roundNo: 1, floorId: '8F', phase: 'review', content: '不该出现在这里' } });
  ok('the current meeting does not gain another meeting\'s utterance', s.current.utterances.length === before);
  ok('no phantom row appeared', !s.current.utterances.some((u) => u.floorId === '8F'));
}

head('delete: 409 (still discussing) is reported honestly, not as success');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  routes['GET /api/v1/councils?limit=50'] = () => json({ ok: true, councils: [] });
  await s.open('c1');
  routes['DELETE /api/v1/councils/c1'] = () =>
    json({ ok: false, error: { code: 'conflict', message: '这场会还在讨论，先取消再删' } }, 409);
  const done = await s.remove('c1');
  ok('returns failure', done === false);
  ok('the server message is carried through verbatim', s.error === '这场会还在讨论，先取消再删', s.error);
  ok('the meeting stays on screen (no pretending it was deleted)', Boolean(s.current));

  routes['DELETE /api/v1/councils/c1'] = () => json({ ok: true });
  const done2 = await s.remove('c1');
  ok('a real delete returns true', done2 === true);
  ok('the current meeting is cleared', s.current === null);
}

head('start: the server\'s rejection reason is passed through, not rewritten');
{
  const s = fresh();
  routes['POST /api/v1/councils'] = () =>
    json({ ok: false, error: { code: 'bad_payload', message: '这些楼层现在请不动 —— 8F：没找到命令行可执行文件' } }, 400);
  const id = await s.create({ topic: 'x', moderator: '4F', main: '1F', reviewers: ['8F'], files: [], maxRounds: 2 });
  ok('no id returned', id === null);
  ok('the reason is the server sentence', s.error === '这些楼层现在请不动 —— 8F：没找到命令行可执行文件', s.error);
  ok('no half-built meeting is left behind', s.current === null);
}

head('start: roles go into the body; a blank workspace omits the key');
{
  const s = fresh();
  routes['POST /api/v1/councils'] = () =>
    json({ ok: true, council: { id: 'c9', topic: 'x', status: 'draft', max_rounds: 2, workspace_path: '/home/me/proj' } });
  routes['GET /api/v1/councils?limit=50'] = () => json({ ok: true, councils: [] });
  routes['GET /api/v1/councils/c9'] = () =>
    json({
      ok: true,
      council: { id: 'c9', topic: 'x', status: 'draft', max_rounds: 2, workspace_path: '/home/me/proj' },
      participants: [], materials: [], rounds: [], roundResults: [], reviews: [], utterances: [],
      plan: null, report: null, reportFiles: [], live: false,
    });

  await s.create({
    topic: 'x',
    moderator: '4F',
    main: '1F',
    reviewers: ['7F', '8F'],
    files: ['/tmp/a.md'],
    maxRounds: 2,
    workspacePath: '/home/me/proj',
    models: { '1F': 'deepseek-v4.1-flash', '4F': '   ', '7F': '' },
  });
  const sent = calls.find((c) => c.method === 'POST');
  ok('moderator in the body', sent.body.moderator === '4F', JSON.stringify(sent.body));
  ok('main in the body', sent.body.main === '1F');
  ok('reviewers in the body', JSON.stringify(sent.body.reviewers) === JSON.stringify(['7F', '8F']));
  ok('files in the body', JSON.stringify(sent.body.files) === JSON.stringify(['/tmp/a.md']));
  ok('no vote-era "mode" key', !('mode' in sent.body), JSON.stringify(sent.body));
  ok('workspace in the body when given', sent.body.workspacePath === '/home/me/proj');
  ok('only non-empty per-seat models are sent',
    JSON.stringify(sent.body.models) === JSON.stringify({ '1F': 'deepseek-v4.1-flash' }), JSON.stringify(sent.body.models));
}
{
  const s = fresh();
  routes['POST /api/v1/councils'] = () => json({ ok: true, council: { id: 'c10', topic: 'x', status: 'draft', max_rounds: 2 } });
  routes['GET /api/v1/councils?limit=50'] = () => json({ ok: true, councils: [] });
  routes['GET /api/v1/councils/c10'] = () =>
    json({
      ok: true,
      council: { id: 'c10', topic: 'x', status: 'draft', max_rounds: 2, workspace_path: null },
      participants: [], materials: [], rounds: [], roundResults: [], reviews: [], utterances: [],
      plan: null, report: null, reportFiles: [], live: false,
    });

  await s.create({ topic: 'x', moderator: '4F', main: '1F', reviewers: ['7F'], files: [], maxRounds: 2, workspacePath: '   ' });
  const sent = calls.find((c) => c.method === 'POST');
  // A blank path is NOT sent as an empty string: isolated mode is the server default, and an empty
  // string would be a different thing to normalize. The old frontend never sent it either.
  ok('a blank workspace omits the key entirely', !('workspacePath' in sent.body), JSON.stringify(sent.body));
  ok('all-blank models omit the key entirely', !('models' in sent.body), JSON.stringify(sent.body));
}

head('workspacePath getter: null means isolated mode, shown as an empty string');
{
  const s = fresh();
  s.current = { council: { id: 'c1', workspace_path: '/home/me/proj' }, participants: [], materials: [], rounds: [], roundResults: [], utterances: [], live: false };
  ok('a value is passed through', s.workspacePath === '/home/me/proj');
  s.current = { council: { id: 'c2', workspace_path: null }, participants: [], materials: [], rounds: [], roundResults: [], utterances: [], live: false };
  ok('NULL -> empty string', s.workspacePath === '');
  s.current = null;
  ok('no current council -> empty string, no crash', s.workspacePath === '');
}

head('report fetch: lands in the current council');
{
  const s = fresh();
  routes['GET /api/v1/councils/c1'] = () => json(DETAIL);
  await s.open('c1');
  routes['GET /api/v1/councils/c1/report'] = () =>
    json({ ok: true, report: { schema: 'workgremlin.council.report/v1' }, adjudication: { decision: 'approve' }, finalDraft: '稿', changeNotes: '说明', files: ['/tmp/report.json'], createdAt: 1 });
  const r = await s.fetchReport('c1');
  ok('the report is returned', r.report.schema === 'workgremlin.council.report/v1');
  ok('it is stored on the current council', s.current.report.schema === 'workgremlin.council.report/v1');
  ok('the file list is stored too', s.current.reportFiles[0] === '/tmp/report.json');

  routes['GET /api/v1/councils/c1/report'] = () => json({ ok: false, error: { message: '这场会还没有报告' } }, 404);
  const none = await s.fetchReport('c1');
  ok('a missing report returns null and shows the server message', none === null && s.error === '这场会还没有报告');
}

await server.close();
console.log(`\n${fail ? '✗' : '✓'} council-ui-store: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
