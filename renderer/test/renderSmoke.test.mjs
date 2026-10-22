/**
 * 主要页面 × 中英切换 的渲染冒烟。
 *
 * 背景（2026-10-01 用户实测）：切成英文后「办公室」和「任务记录」都变空了。
 * 根因是两处**只在真渲染时才炸**的错：
 *   · TaskRecordsView 里两处写成 `t(...)`（该文件的翻译函数叫 `tr`，`t` 是"一条任务"）
 *     → 渲染时 `t is not defined`，整页白屏；
 *   · iso/engine 的 `drawWalls()` 里局部 `const t = WALL.thickness` 遮住了翻译函数
 *     → 画布第一帧就抛，raf 循环死掉 → 一片空画布（画布那条由 canvasScene.test.mjs 守）。
 * 编译期看不出这类错，所以这里用 Vite 的 SSR 加载器把真组件渲染一遍（两种语言各一次）。
 *
 * 跑法：`npm run test:render-smoke`
 */
import { createServer } from 'vite';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
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

// SSR 加载器：.vue 现编译，省扩展名的相对导入照旧能解析（浏览器里是 Vite 补的）
const server = await createServer({
  root: 'renderer',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
  ssr: { external: ['@workgremlin/shared'] },
});

const { setLocale } = await server.ssrLoadModule('/src/i18n/index.js');
const { useTaskStore } = await server.ssrLoadModule('/src/stores/tasks.js');
const { useProjectStore } = await server.ssrLoadModule('/src/stores/project.js');
const { useCouncilStore } = await server.ssrLoadModule('/src/stores/council.js');
const { normUtterance } = await server.ssrLoadModule('/src/lib/councilTimeline.js');

/** A few words per language that prove the page really rendered in that language */
const WORDS = {
  zh: {
    completed: '已完成', partial: '部分完成', running: '讨论中',
    convergence: '收敛度', opinions: '1 条意见', blockers: '0 条 blocker', conflicts: '1 处冲突',
    roleModerator: '主持人', roleMain: '主答', roleReviewer: '评审',
    noAnswer: '没答上来', needClarification: '需要补充信息', notReached: '未轮到',
    approveChanges: '修改后通过',
    remainingRisks: '剩余风险', finalDirectives: '最终要求', finalDraft: '最终交付稿', changeNotes: '变更说明',
    warnings: '一致性提示', truncated: '已截断', noDiff: '这一轮没有给出 diff',
    process: '完整过程', plan: '第 0 轮 · 议题拆解与评审分工', breakdown: '议题拆解', assignments: '评审分工',
    moderatorSummary: '主持人汇总', consensus: '共识', openIssues: '未决问题', directives: '修改指令',
    working: '正在工作中', phaseReview: '评审', round1: '第 1 轮',
    rawOutput: '原始输出', incomplete: '未完成', incompleteHint: '这一轮没有走完',
    timedOut: '超时', noTurns: '没有留下任何发言记录',
  },
  en: {
    completed: 'completed', partial: 'partially completed', running: 'in session',
    convergence: 'Convergence', opinions: '1 opinion(s)', blockers: '0 blocker(s)', conflicts: '1 conflict(s)',
    roleModerator: 'Moderator', roleMain: 'Main answerer', roleReviewer: 'Reviewer',
    noAnswer: 'no answer', needClarification: 'needs clarification', notReached: 'not reached',
    approveChanges: 'approve with changes',
    remainingRisks: 'Remaining risks', finalDirectives: 'Final directives', finalDraft: 'Final draft', changeNotes: 'Change notes',
    warnings: 'Consistency warnings', truncated: 'truncated', noDiff: 'No diff was given for this round',
    process: 'Full process', plan: 'Round 0 · topic breakdown and review assignments', breakdown: 'Topic breakdown', assignments: 'Review assignments',
    moderatorSummary: 'Moderator summary', consensus: 'Consensus', openIssues: 'Open issues', directives: 'Revision directives',
    working: 'Working', phaseReview: 'review', round1: 'Round 1',
    rawOutput: 'Raw output', incomplete: 'Incomplete', incompleteHint: 'This round did not finish',
    timedOut: 'timed out', noTurns: 'No turns were recorded',
  },
};

/** 渲染一个组件；抛错就如实报出来（返回 null） */
async function render(path, setup, props) {
  const pinia = createPinia();
  setActivePinia(pinia);
  if (setup) setup();
  const mod = await server.ssrLoadModule(path);
  const app = createSSRApp({ render: () => h(mod.default, props) });
  app.use(pinia);
  try {
    return await renderToString(app);
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

/**
 * 从渲染出来的 HTML 里抠出挂某个 testid 的那一小块（含它自己的开标签，到 `</div>` 为止）。
 * 用处：断言"这一排圆点上有什么、没什么"——按整页搜会搜到别处的同名文案，
 * 比如简报里那几组也写着「支持 / 反对」。
 *
 * 注释要先剔掉：SSR 会**原样带上模板里的注释**（打包时才会去掉），
 * 而注释里正写着「支持/反对」这几个字 —— 不剔就会把讲解当成人说的话。
 */
const regionOf = (html, testid) => {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const at = clean.indexOf(`data-testid="${testid}"`);
  if (at < 0) return '';
  const start = clean.lastIndexOf('<div', at);
  const end = clean.indexOf('</div>', at);
  return clean.slice(start, end < 0 ? clean.length : end);
};

const TASK = {
  id: 't1',
  title: '跑个任务',
  state: 'done',
  started_at: Date.now() - 60_000,
  ended_at: Date.now(),
  client: 'codex',
  model: 'gpt-5',
  project_id: 'proj',
  duration_ms: 60_000,
  file_count: 2,
};

/**
 * A finished council in its real shape.
 *
 * It deliberately contains three "ugly but must stay honest" things: a floor that **did not answer**
 * (8F timed out), a round **without a diff** (round 1), and **truncated material**. If any of them is
 * rendered as a normal result (timeout → silence, truncation → unmentioned), the page loses its point.
 */
const COUNCIL = {
  council: {
    id: 'c1',
    topic: '把重试上限从 3 提到 5 吗',
    status: 'done',
    verdict: 'completed',
    max_rounds: 2,
    workspace_path: '/home/me/proj',
    error: null,
  },
  // One older meeting in the history rail. The local-time constructor keeps the expected string
  // stable regardless of the machine's timezone.
  list: [
    { id: 'c0', topic: '上一次会议', created_at: new Date(2024, 0, 2, 3, 4).getTime() },
  ],
  participants: [
    { floor_id: '4F', role: 'moderator', agent: 'claude', status: 'ok', error: null },
    { floor_id: '1F', role: 'main', agent: 'codebuddy', status: 'ok', error: null },
    { floor_id: '7F', role: 'reviewer', agent: 'kilo', status: 'ok', error: null },
    { floor_id: '8F', role: 'reviewer', agent: 'opencode', status: 'failed', error: '进程超时（300s）' },
  ],
  materials: [
    { ord: 0, path: '/tmp/spec.md', bytes_total: 204800, bytes_included: 65536, truncated: 1 },
  ],
  rounds: [
    { round_no: 0, kind: 'plan', proposal_from: '4F' },
    { round_no: 1, kind: 'debate', version: 'v1', proposal_text: '上限提到 5', proposal_from: '1F' },
    { round_no: 2, kind: 'debate', version: 'v2', proposal_text: '上限提到 5，但只对幂等操作生效', proposal_from: '1F' },
  ],
  reviews: [
    { round_no: 1, reviewer: '7F', severity: 'blocker', dimension: '安全', issue: '支付路径会重复扣款', suggestion: '只对幂等操作重试', stance: 'reject' },
    { round_no: 1, reviewer: '7F', severity: 'major', dimension: '兼容性', issue: '老客户端没有幂等键', suggestion: '保留旧上限', stance: 'revise' },
    { round_no: 2, reviewer: '7F', severity: 'major', dimension: '测试', issue: '幂等边界仍需测试覆盖', evidence: 'spec.md 第 3 节', suggestion: '补三个并发用例', stance: 'revise' },
  ],
  roundResults: [
    {
      round: 1,
      proposal: { version: 'v1', content: '上限提到 5', diffFromPrev: null },
      reviews: [
        { reviewer: '7F', severity: 'blocker', dimension: '安全', issue: '支付路径会重复扣款', suggestion: '只对幂等操作重试', stance: 'reject' },
        { reviewer: '7F', severity: 'major', dimension: '兼容性', issue: '老客户端没有幂等键', suggestion: '保留旧上限', stance: 'revise' },
      ],
      moderator: {
        consensus: [],
        openIssues: ['幂等边界'],
        conflicts: [{ topic: '重试范围', sides: [{ reviewer: '1F', view: '所有请求' }, { reviewer: '7F', view: '仅幂等操作' }] }],
        revisionDirectives: ['【针对 重复扣款】必须只对幂等操作重试；验收标准：支付路径有测试覆盖。'],
        convergenceScore: 57,
      },
      stats: { score: 57, bySeverity: { blocker: 1, major: 1, minor: 0, nit: 0 }, conflicts: 1 },
      warnings: [{ code: 'vague_directive', message: '第 1 轮的修改指令缺少验收标准。' }],
    },
    {
      round: 2,
      proposal: {
        version: 'v2',
        content: '上限提到 5，但只对幂等操作生效',
        diffFromPrev: '- 所有请求重试\n+ 仅幂等操作重试',
      },
      reviews: [
        { reviewer: '7F', severity: 'major', dimension: '测试', issue: '幂等边界仍需测试覆盖', evidence: 'spec.md 第 3 节', suggestion: '补三个并发用例', stance: 'revise' },
      ],
      moderator: {
        consensus: ['只对幂等操作重试'],
        openIssues: [],
        conflicts: [{ topic: '测试范围', sides: [{ reviewer: '1F', view: '三个用例' }, { reviewer: '7F', view: '五个用例' }] }],
        revisionDirectives: ['【针对 幂等边界】必须补三个并发用例；验收标准：CI 全绿。'],
        convergenceScore: 82,
      },
      stats: { score: 82, bySeverity: { blocker: 0, major: 1, minor: 0, nit: 0 }, conflicts: 1 },
      warnings: [],
    },
  ],
  utterances: [
    { round_no: 0, floor_id: '4F', phase: 'plan', content: '拆解议题', status: 'ok', model: 'claude-sonnet-5-5', input_tokens: 100, output_tokens: 20 },
    { round_no: 1, floor_id: '1F', phase: 'proposal', content: '上限提到 5', status: 'ok', model: 'codebuddy-x', input_tokens: 200, output_tokens: 50 },
    { round_no: 1, floor_id: '7F', phase: 'review', content: '支付路径会重复扣款', status: 'ok', model: 'kilo-latest', input_tokens: 50, output_tokens: 10 },
    // The floor that timed out: no content. It must not turn into an opinion or an "abstain".
    { round_no: 1, floor_id: '8F', phase: 'review', content: null, status: 'failed', error: '进程超时（300s）' },
    { round_no: 1, floor_id: '4F', phase: 'moderation', content: '汇总', status: 'ok', model: 'claude-sonnet-5-5', input_tokens: 60, output_tokens: 15 },
    { round_no: 2, floor_id: '1F', phase: 'proposal', content: '上限提到 5，但只对幂等操作生效', status: 'ok', model: 'codebuddy-x', input_tokens: 210, output_tokens: 55 },
    { round_no: 2, floor_id: '7F', phase: 'review', content: '幂等边界仍需测试覆盖', status: 'ok', model: 'kilo-latest', input_tokens: 55, output_tokens: 12 },
    { round_no: 2, floor_id: '8F', phase: 'review', content: null, status: 'failed', error: '进程超时（300s）' },
    { round_no: 2, floor_id: '4F', phase: 'moderation', content: '汇总', status: 'ok', model: 'claude-sonnet-5-5', input_tokens: 70, output_tokens: 18 },
    { round_no: 3, floor_id: '4F', phase: 'adjudication', content: '裁决', status: 'ok', model: 'claude-sonnet-5-5', input_tokens: 30, output_tokens: 9 },
    { round_no: 3, floor_id: '1F', phase: 'final', content: '最终稿正文', status: 'ok', model: 'codebuddy-x', input_tokens: 40, output_tokens: 11 },
  ],
  plan: {
    parsed: true,
    breakdown: ['拆解 A：重试上限', '拆解 B：幂等边界'],
    assignments: [{ reviewer: '7F', focus: '安全与兼容性' }],
    reviewFocus: '重点核对支付路径。',
  },
  report: {
    schema: 'workgremlin.council.report/v1',
    summary: { warnings: [{ code: 'vague_directive', message: '主持人给出的修改指令缺少验收标准。' }] },
    adjudication: {
      decision: 'approve_with_changes',
      summary: '方向可行，但必须先解决幂等边界问题。',
      remainingRisks: ['并发下仍可能重复写'],
      finalDirectives: ['补三个并发用例后再上线'],
    },
    finalDraft: { content: '最终交付稿正文', changeNotes: '只对幂等操作重试' },
  },
  reportFiles: [
    '/home/me/.workgremlin/councils/c1/report.json',
    '/home/me/.workgremlin/councils/c1/reviews.csv',
  ],
  live: false,
};

/** A council that could not finish: verdict=partial, no report, no final result. */
const PARTIAL = {
  ...COUNCIL,
  council: { ...COUNCIL.council, verdict: 'partial', error: '最终交付稿没有解析出来' },
  report: null,
  reportFiles: [],
};

/**
 * A meeting that died mid-round: round 1 completed, round 2's proposal timed out and the server
 * stopped the meeting. Round 2 has no RoundResult, so the structured view cannot describe it —
 * but its turns still happened and must stay readable.
 */
const INCOMPLETE = {
  ...COUNCIL,
  council: {
    ...COUNCIL.council,
    status: 'failed',
    verdict: 'partial',
    error: '第 2 轮主答没有产出可用方案（timeout）',
  },
  roundResults: COUNCIL.roundResults.slice(0, 1),
  utterances: [
    ...COUNCIL.utterances.filter((u) => u.round_no <= 1),
    { round_no: 2, floor_id: '1F', phase: 'proposal', content: null, status: 'timeout', error: '进程超时（300s）' },
  ],
  report: null,
  reportFiles: [],
};

/** A council still in session: status=running, no report yet, live indicator on. */
const LIVE = {
  ...COUNCIL,
  council: { ...COUNCIL.council, status: 'running', verdict: null, max_rounds: 3 },
  roundResults: COUNCIL.roundResults.slice(0, 1),
  report: null,
  reportFiles: [],
  live: true,
  progress: { roundNo: 1, phase: 'review', floors: ['7F'], startedAt: 1 },
};

/**
 * The moderator needs a project path before it can break down the topic. This is a normal ending:
 * the moderator did answer, and the roles that were never called are not failures.
 */
const CLARIFICATION = {
  council: {
    id: 'c3',
    topic: '评审这个改动会不会导致回归',
    status: 'done',
    verdict: 'needs_clarification',
    max_rounds: 3,
    workspace_path: null,
    error: '主持人需要补充信息：请给出需要评审的项目绝对路径',
  },
  list: [],
  participants: [
    { floor_id: '1F', role: 'moderator', agent: 'codebuddy', status: 'needs_clarification', error: null },
    { floor_id: '4F', role: 'main', agent: 'claude', status: 'skipped', error: '这一角色没有轮到发言' },
    { floor_id: '7F', role: 'reviewer', agent: 'kilo', status: 'skipped', error: '这一角色没有轮到发言' },
  ],
  materials: [],
  rounds: [],
  reviews: [],
  roundResults: [],
  utterances: [
    {
      round_no: 0,
      floor_id: '1F',
      phase: 'plan',
      content: '需要项目路径才能检查真实代码。',
      status: 'ok',
      model: 'codebuddy-x',
      input_tokens: 80,
      output_tokens: 20,
    },
  ],
  plan: {
    parsed: true,
    breakdown: [],
    assignments: [],
    reviewFocus: [],
    needsClarification: ['请给出需要评审的项目绝对路径'],
  },
  report: { schema: 'workgremlin.council.report/v1', summary: { warnings: [] } },
  reportFiles: ['/home/me/.workgremlin/councils/c3/report.json'],
  live: false,
};

for (const [loc, stateWord, hudWord, taskWord, overviewWord] of [
  ['zh', '完成', '演示模式', '当前任务', '数据总览'],
  ['en', 'Done', 'Demo mode', 'Current task', 'Overview'],
]) {
  console.log(`\n[${loc}] 主要页面渲染得出来（不是一片空白）`);
  setLocale(loc);

  const records = await render('/src/views/TaskRecordsView.vue', () => {
    const tasks = useTaskStore();
    // 第二条**故意没有标题**：汇总页原来在 `promptOf(t) || i18nT(...)` 那里炸
    // （i18nT 根本不存在，只有"标题为空"才走到那一边）→ 整页空白。有它才守得住。
    tasks.tasks = [TASK, { ...TASK, id: 't2', title: '', state: 'cancelled' }];
  });
  ok('任务记录：渲染没抛错', typeof records === 'string', records && records.error);
  if (typeof records === 'string') {
    ok('任务记录：列表里真的有那条任务', records.includes(TASK.title));
    ok(`任务记录：状态按当前语言写（${stateWord}）`, records.includes(stateWord));
  }

  for (const v of ['summary', 'board']) {
    const html = await render('/src/views/TaskRecordsView.vue', () => {
      const tasks = useTaskStore();
      tasks.tasks = [TASK, { ...TASK, id: 't2', title: '', state: 'cancelled' }];
    }, { initialView: v });
    ok(`任务记录 · ${v} 视图：渲染没抛错`, typeof html === 'string', html && html.error);
    if (typeof html === 'string' && v === 'summary') {
      ok('汇总：默认维度页签是翻译过的（不是原始 key）', html.includes(overviewWord) && !html.includes('records.dim.'), overviewWord);
      ok('汇总：表格里有数据行', /class="report-row"/.test(html));
    }
  }

  const office = await render('/src/views/IsoOfficeView.vue');
  ok('办公室：渲染没抛错', typeof office === 'string', office && office.error);
  if (typeof office === 'string') {
    ok('办公室：HUD 按钮在（画布外那层）', office.includes(hudWord));
    ok('办公室：画布容器在', office.includes('scene-wrap'));
  }

  const ws = await render('/src/views/WorkstationView.vue', () => {
    const project = useProjectStore();
    project.members = [
      { memberId: 'coder@proj', name: 'coder', role: 'subagent:project', state: 'busy', client: 'codex', level: 'project' },
    ];
  });
  ok('工位卡片页：渲染没抛错', typeof ws === 'string', ws && ws.error);
  if (typeof ws === 'string') ok('工位卡片页：卡片上的字段也跟着语言走', ws.includes(taskWord));

  const lab = await render('/src/views/DeskLabView.vue');
  ok('设计台（?tab=lab）：渲染没抛错', typeof lab === 'string', lab && lab.error);

  const flat = await render('/src/views/OfficeSceneView.vue');
  ok('旧 2D 场景（?tab=flat）：渲染没抛错', typeof flat === 'string', flat && flat.error);

  const conv = await render('/src/views/ConversationView.vue');
  ok('对话记录（旧页）：渲染没抛错', typeof conv === 'string', conv && conv.error);

  // ---- council ----
  // The fixtures are already in the normalized shape (the same path as open()), so this also pins
  // "snake_case rows from GET can be rendered".
  const W = WORDS[loc];
  const seedCouncil = (data) => () => {
    const council = useCouncilStore();
    council.floors = [
      { floorId: '1F', name: 'CodeBuddy', ready: true, cliPath: '/usr/bin/codebuddy', reason: null },
      { floorId: '4F', name: 'Claude Code', ready: true, cliPath: '/usr/bin/claude', reason: null },
      { floorId: '7F', name: 'Kilo Code', ready: true, cliPath: '/usr/bin/kilo', reason: null },
      { floorId: '8F', name: 'OpenCode', ready: false, cliPath: null, reason: '没找到可执行文件' },
    ];
    council.defaults = {
      ...council.defaults,
      severityWeights: { blocker: 25, major: 8, minor: 2, nit: 0 },
      conflictWeight: 10,
      scoreMax: 100,
    };
    council.current = { ...data, utterances: data.utterances.map(normUtterance) };
    council.list = data.list || [];
  };
  /** Opening tag of the element carrying a testid (works for details/section/div). */
  const openingTagOf = (html, testid) => {
    const at = html.indexOf(`data-testid="${testid}"`);
    if (at < 0) return '';
    const start = html.lastIndexOf('<', at);
    const end = html.indexOf('>', at);
    return html.slice(start, end + 1);
  };
  /** The element's content up to its first closing div (enough for a small summary block). */
  const chunkOf = (html, testid) => {
    const at = html.indexOf(`data-testid="${testid}"`);
    if (at < 0) return '';
    const end = html.indexOf('</div>', at);
    return html.slice(at, end < 0 ? html.length : end);
  };
  /** Everything from one testid up to the next one (for a section with nested blocks). */
  const between = (html, fromId, toId) => {
    const at = html.indexOf(`data-testid="${fromId}"`);
    if (at < 0) return '';
    const end = html.indexOf(`data-testid="${toId}"`, at);
    return html.slice(at, end < 0 ? html.length : end);
  };

  const won = await render('/src/views/CouncilView.vue', seedCouncil(COUNCIL));
  ok('council · completed: renders without throwing', typeof won === 'string', won && won.error);
  if (typeof won === 'string') {
    ok(`council: verdict badge (${W.completed})`, won.includes(W.completed));
    ok('council: workspace is shown (where they talked is part of understanding the result)',
      won.includes('cv-workspace-show') && won.includes('/home/me/proj'));

    // ---------------------------------------------------- summary only
    const score = chunkOf(won, 'cv-score');
    ok('council: the summary score is the last round\'s server score', score.includes('82'), score.slice(0, 160));
    const formula = chunkOf(won, 'cv-score-formula');
    ok('council: the score formula is shown (explainable, not a bare number)',
      formula.includes('100 - (') && formula.includes('blocker 0×25') && formula.includes('1×10'), formula.slice(0, 200));
    ok(`council: N opinions (${W.opinions})`, won.includes(W.opinions));
    ok(`council: N blockers (${W.blockers})`, won.includes(W.blockers));
    ok(`council: N conflicts (${W.conflicts})`, won.includes(W.conflicts));

    ok('council: the role table shows all three roles',
      won.includes(W.roleModerator) && won.includes(W.roleMain) && won.includes(W.roleReviewer));
    ok('council: every role shows its model',
      won.includes('claude-sonnet-5-5') && won.includes('codebuddy-x') && won.includes('kilo-latest'));
    ok('council: token totals are per role (4F 322, 1F 566, 7F 127)',
      won.includes('>322<') && won.includes('>566<') && won.includes('>127<'));
    ok('council: a role with no reported usage shows "—", not 0', won.includes('>—<'));
    ok(`council: a failed role is marked (${W.noAnswer})`, won.includes(W.noAnswer));

    const warn = chunkOf(won, 'cv-warnings');
    ok(`council: mechanical consistency warnings are shown (${W.warnings})`,
      warn.includes(W.warnings) && warn.includes('主持人给出的修改指令缺少验收标准。'));

    // ---------------------------------------------------- final result
    const result = between(won, 'cv-result', 'cv-report-files');
    ok(`council: the adjudication decision is shown (${W.approveChanges})`,
      result.includes('cv-decision') && result.includes(W.approveChanges));
    ok('council: the adjudication reason is shown', result.includes('方向可行，但必须先解决幂等边界问题。'));
    ok(`council: remaining risks (${W.remainingRisks})`,
      result.includes(W.remainingRisks) && result.includes('并发下仍可能重复写'));
    ok(`council: final directives (${W.finalDirectives})`,
      result.includes(W.finalDirectives) && result.includes('补三个并发用例后再上线'));
    ok(`council: the final draft and change notes (${W.finalDraft})`,
      result.includes(W.finalDraft) && result.includes('最终交付稿正文') && result.includes(W.changeNotes) && result.includes('只对幂等操作重试'));

    ok('council: report files are listed (written at wrap-up)', won.includes('cv-report-files') && won.includes('report.json'));

    // ---------------------------------------------------- history rail
    ok('council: history entries show the date as well as the time (never a bare clock)',
      won.includes('01-02 03:04') && won.includes('上一次会议'));

    // ---------------------------------------------------- collapsed full process
    const processTag = openingTagOf(won, 'cv-process');
    ok(`council: the full process is a collapsed section (${W.process})`,
      processTag.startsWith('<details') && won.includes(W.process) && !/\sopen(?=[\s>])/.test(processTag), processTag);
    ok('council: the plan (round 0) is inside the process',
      openingTagOf(won, 'cv-plan').startsWith('<details') && won.includes(W.plan));
    ok('council: the plan shows the breakdown, assignments and review focus',
      won.includes(W.breakdown) && won.includes('拆解 A：重试上限') &&
        won.includes(W.assignments) && won.includes('安全与兼容性') && won.includes('重点核对支付路径。'));

    ok('council: round 1 exists', openingTagOf(won, 'cv-round-1').startsWith('<details'));
    ok(`council: a round with no diff says so (${W.noDiff})`,
      won.includes('cv-nodiff-1') && won.includes(W.noDiff));
    ok('council: round 1 keeps its proposal text', won.includes('上限提到 5'));
    ok('council: round 1 reviews are shown with severity + stance',
      won.includes('支付路径会重复扣款') && won.includes('只对幂等操作重试') && won.includes('blocker') && won.includes('reject'));
    ok('council: round 1 moderator output is shown (open issues, conflicts, directives)',
      won.includes(W.openIssues) && won.includes('幂等边界') && won.includes('重试范围') &&
        won.includes('所有请求') && won.includes('仅幂等操作') && won.includes(W.directives));
    ok('council: round 1 warnings are shown', won.includes('第 1 轮的修改指令缺少验收标准。'));

    ok('council: round 2 shows its diff against the previous version',
      won.includes('cv-diff-2') && won.includes('- 所有请求重试') && won.includes('+ 仅幂等操作重试'));
    ok('council: round 2 shows the revised proposal', won.includes('上限提到 5，但只对幂等操作生效'));
    ok('council: round 2 reviews keep evidence and suggestion',
      won.includes('spec.md 第 3 节') && won.includes('补三个并发用例'));
    ok(`council: round 2 moderator summary (${W.moderatorSummary})`,
      won.includes(W.moderatorSummary) && won.includes(W.consensus) && won.includes('只对幂等操作重试'));
    ok('council: conflicts list both sides', won.includes('测试范围') && won.includes('三个用例') && won.includes('五个用例'));

    // ---------------------------------------------------- raw output survives the meeting
    ok(`council: every round keeps its raw participant output (${W.rawOutput})`,
      won.includes(W.rawOutput) && won.includes('cv-raw-turns') && won.includes('拆解议题'));
    ok('council: the wrap-up round is not mislabelled as an incomplete debate round',
      !won.includes('cv-round-incomplete-3'));

    // ---------------------------------------------------- not a vote
    ok('council: there is no vote UI at all', !won.includes('cv-vote') && !won.includes('cv-tally') && !won.includes('cv-vote-count'));
    ok(`council: truncated material is labelled (${W.truncated})`, won.includes(W.truncated) && won.includes('/tmp/spec.md'));
  }

  const startFail = await render('/src/views/CouncilView.vue', () => {
    const council = useCouncilStore();
    council.floors = [
      { floorId: '1F', name: 'CodeBuddy', ready: true, cliPath: '/usr/bin/codebuddy', reason: null },
      { floorId: '4F', name: 'Claude Code', ready: true, cliPath: '/usr/bin/claude', reason: null },
    ];
    council.current = null;
    council.error = '这些楼层现在说不了话 —— 1F（400 Copilot: The requested model is not supported）';
  });
  ok('council · failed start: renders without throwing', typeof startFail === 'string', startFail && startFail.error);
  if (typeof startFail === 'string') {
    const alert = chunkOf(startFail, 'cv-op-error');
    ok('council: the preflight reason is shown in the right column',
      alert.includes('The requested model is not supported'), alert.slice(0, 240));
    ok('council: the left form does not repeat the server error', !startFail.includes('cv-store-error'));
  }

  const partial = await render('/src/views/CouncilView.vue', seedCouncil(PARTIAL));
  ok('council · partial: renders without throwing', typeof partial === 'string', partial && partial.error);
  if (typeof partial === 'string') {
    ok(`council: a partial meeting says so (${W.partial})`, partial.includes(W.partial));
    ok('council: partial still shows the summary and the process',
      partial.includes('cv-summary') && partial.includes('cv-process'));
    ok('council: partial has no adjudication/final result block', !partial.includes('cv-result'));
    ok('council: partial has no report files block', !partial.includes('cv-report-files'));
    ok('council: partial still shows which floor did not answer', partial.includes(W.noAnswer));
    const finalError = chunkOf(partial, 'cv-council-error');
    ok('council: the final failure reason is shown in the right column',
      finalError.includes('最终交付稿没有解析出来'), finalError.slice(0, 240));
  }

  const incomplete = await render('/src/views/CouncilView.vue', seedCouncil(INCOMPLETE));
  ok('council · unfinished round: renders without throwing', typeof incomplete === 'string', incomplete && incomplete.error);
  if (typeof incomplete === 'string') {
    ok('council: a round that never finished still shows up after the meeting ended',
      incomplete.includes('cv-round-incomplete-2'));
    ok(`council: the unfinished round says it did not finish (${W.incomplete})`,
      incomplete.includes(W.incomplete) && incomplete.includes(W.incompleteHint));
    ok('council: the unfinished round keeps its raw turns and the real error',
      incomplete.includes(W.rawOutput) && incomplete.includes('进程超时（300s）') && incomplete.includes(W.timedOut));
    ok('council: a completed round keeps its raw output too',
      incomplete.includes('cv-round-1') && incomplete.includes('上限提到 5'));
  }

  const clarification = await render('/src/views/CouncilView.vue', seedCouncil(CLARIFICATION));
  ok('council · clarification: renders without throwing',
    typeof clarification === 'string', clarification && clarification.error);
  if (typeof clarification === 'string') {
    ok(`council: a clarification request is a normal verdict (${W.needClarification})`,
      clarification.includes(W.needClarification) && clarification.includes('v-needs_clarification'));
    const ask = chunkOf(clarification, 'cv-clarification');
    ok('council: the exact question the moderator needs is shown',
      ask.includes('请给出需要评审的项目绝对路径'), ask);
    ok(`council: roles that never ran are marked not reached (${W.notReached})`,
      clarification.includes(W.notReached));
    const roleTableAt = clarification.indexOf('data-testid="cv-roles"');
    const roleTableEnd = clarification.indexOf('</table>', roleTableAt);
    const roleTable = roleTableAt < 0 ? '' : clarification.slice(roleTableAt, roleTableEnd);
    ok('council: asking for information is not shown as a moderator failure',
      roleTable.includes(W.needClarification) && !roleTable.includes(W.noAnswer), roleTable);
    ok('council: a clarification question is not repeated as a failure',
      !clarification.includes('cv-council-error'));
    ok('council: no adjudication is fabricated for a clarification request',
      !clarification.includes('cv-result'));
    ok('council: the clarification report is still archived',
      clarification.includes('cv-report-files') && clarification.includes('c3/report.json'));
  }

  const live = await render('/src/views/CouncilView.vue', seedCouncil(LIVE));
  ok('council · live: renders without throwing', typeof live === 'string', live && live.error);
  if (typeof live === 'string') {
    ok('council: a running meeting is described by the work strip, not a repeated header status',
      !live.includes(W.running) && !live.includes('v-running') && !live.includes('cv-live'));
    ok('council: a finished meeting has no working strip', !won.includes('cv-working'));
    const working = chunkOf(live, 'cv-working');
    ok('council: the working strip names who, the phase and the round',
      working.includes(W.working) && working.includes('Kilo Code') &&
        working.includes(W.phaseReview) && working.includes(W.round1), working.slice(0, 220));
    ok('council: no result yet', !live.includes('cv-result'));
    ok('council: the summary is already visible while it runs', live.includes('cv-summary'));
  }
}

setLocale('zh');
await server.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
