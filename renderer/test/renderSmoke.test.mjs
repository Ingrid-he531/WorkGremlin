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

/** 每个语言里几个"一眼能认出这一页在说什么"的词 */
const WORDS = {
  zh: { agreed: '达成一致', noStance: '未表态', truncated: '已截断', noAgreement: '到第 2 轮上限仍未达成一致', notPassed: '没通过' },
  en: { agreed: 'agreed', noStance: 'no stance', truncated: 'truncated', noAgreement: 'No agreement within 2 rounds', notPassed: 'did not pass' },
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
 * 议事厅的两种收场，摆成真形状喂给页面。
 *
 * 这里刻意塞了三种"不好看但必须如实"的东西：**没答上来的那一层**（7F 超时）、
 * **没表态的那一条**、**被截断的材料**。这三样只要有一样被渲染成正常结果
 * （超时 →「弃权」、截断 → 不提），这一页就失去了它存在的意义。
 */
const COUNCIL = {
  council: {
    id: 'c1',
    topic: '把重试上限从 3 提到 5 吗',
    status: 'done',
    verdict: 'consensus',
    verdict_round: 2,
    max_rounds: 3,
    error: null,
  },
  participants: [
    { floor_id: '1F', status: 'ok', error: null },
    { floor_id: '4F', status: 'ok', error: null },
    { floor_id: '7F', status: 'failed', error: '进程超时（120s）' },
  ],
  materials: [
    { ord: 0, path: '/tmp/spec.md', bytes_total: 204800, bytes_included: 65536, truncated: 1 },
  ],
  rounds: [
    { round_no: 0, kind: 'brief', proposal_text: '把重试上限从 3 提到 5 吗', proposal_from: 'chair', consensus: 0 },
    { round_no: 1, kind: 'debate', proposal_text: '把重试上限从 3 提到 5 吗', proposal_from: 'chair', agree: 1, disagree: 1, abstain: 0, invalid: 1, consensus: 0 },
    { round_no: 2, kind: 'debate', proposal_text: '上限提到 5，但只对幂等操作生效', proposal_from: '4F', agree: 2, disagree: 0, abstain: 0, invalid: 1, consensus: 1 },
  ],
  utterances: [
    { round_no: 0, floor_id: 'chair', role: 'chair', content: '把重试上限从 3 提到 5 吗', status: 'ok' },
    { round_no: 1, floor_id: '1F', role: 'speaker', content: '我觉得可以', vote: 'agree', vote_reason: '机器扛得住', status: 'ok', output_tokens: 12, duration_ms: 3000 },
    { round_no: 1, floor_id: '4F', role: 'speaker', content: '不行，得限定幂等', vote: 'disagree', vote_reason: '支付重试会重复扣款', proposal_text: '上限提到 5，但只对幂等操作生效', status: 'ok' },
    // 超时的那一层：**没有票**。它不能变成"弃权"，更不能变成"同意"
    { round_no: 1, floor_id: '7F', role: 'speaker', content: null, vote: null, status: 'timeout', error: '进程超时（120s）' },
    { round_no: 2, floor_id: '1F', role: 'speaker', content: '同意这个限定', vote: 'agree', vote_reason: '把面收窄是对的', second: '4F', status: 'ok' },
    { round_no: 2, floor_id: '4F', role: 'speaker', content: '那就这样', vote: 'agree', vote_reason: '我的提案', status: 'ok' },
    { round_no: 2, floor_id: '7F', role: 'speaker', content: null, vote: null, status: 'timeout', error: '进程超时（120s）' },
  ],
};

const NO_CONSENSUS = {
  ...COUNCIL,
  council: { ...COUNCIL.council, verdict: 'no_consensus', verdict_round: null, max_rounds: 2 },
  rounds: COUNCIL.rounds.slice(0, 2),
  utterances: COUNCIL.utterances.filter((u) => u.round_no <= 1),
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

  // ---- 议事厅 ----
  // 喂进去的是**归一之后**的形状（跟 open() 走的是同一条路），所以这也顺带钉住
  // "GET 回来的 snake_case 行能渲染出来"这件事。
  const W = WORDS[loc];
  const seedCouncil = (data) => () => {
    const council = useCouncilStore();
    council.floors = [
      { floorId: '1F', name: 'CodeBuddy', ready: true, cliPath: '/usr/bin/codebuddy', reason: null },
      { floorId: '4F', name: 'Claude Code', ready: true, cliPath: '/usr/bin/claude', reason: null },
      { floorId: '7F', name: 'Kilo Code', ready: true, cliPath: '/usr/bin/kilo', reason: null },
      { floorId: '8F', name: 'OpenCode', ready: false, cliPath: null, reason: '没找到可执行文件' },
    ];
    council.current = { ...data, utterances: data.utterances.map(normUtterance) };
  };

  const won = await render('/src/views/CouncilView.vue', seedCouncil(COUNCIL));
  ok('议事厅 · 达成一致：渲染没抛错', typeof won === 'string', won && won.error);
  if (typeof won === 'string') {
    ok('议事厅：结论引的是那轮提案原文（一字不改）', won.includes('上限提到 5，但只对幂等操作生效'));
    ok(`议事厅：结论区块在（${W.agreed}）`, won.includes('cv-conclusion') && won.includes(W.agreed));
    ok('议事厅：超时那层的错误原文摆出来了', won.includes('进程超时（120s）'));
    ok(`议事厅：超时算作未表态（${W.noStance} 1），没有变成同意`, won.includes(`${W.noStance} 1`));
    ok(`议事厅：材料截断有标注（${W.truncated}）`, won.includes(W.truncated));
    ok('议事厅：请不动的楼层写着原因', won.includes('没找到可执行文件'));
  }

  const lost = await render('/src/views/CouncilView.vue', seedCouncil(NO_CONSENSUS));
  ok('议事厅 · 未达成一致：渲染没抛错', typeof lost === 'string', lost && lost.error);
  if (typeof lost === 'string') {
    ok(`议事厅：没谈成就写没谈成（${W.noAgreement}）`, lost.includes('cv-no-conclusion') && lost.includes(W.noAgreement));
    ok('议事厅：没谈成时**不**出现结论区块', !lost.includes('cv-conclusion'));
    ok(`议事厅：最后一轮那份提案照样摆出来，但标明${W.notPassed}`, lost.includes(W.notPassed) && lost.includes('上限提到 5，但只对幂等操作生效'));
    ok(`议事厅：各方最后立场列出来了（${W.noStance}）`, lost.includes(W.noStance));
  }
}

setLocale('zh');
await server.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
