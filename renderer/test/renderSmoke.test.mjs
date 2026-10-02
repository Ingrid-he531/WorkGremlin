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
  zh: {
    agreed: '达成一致', noStance: '未表态', truncated: '已截断', noAgreement: '到第 2 轮上限仍未达成一致', notPassed: '没通过',
    reported: '已呈报', report: '分析简报', support: '支持', oppose: '反对', unsure: '不确定',
    points: '要点', risks: '风险', questions: '存疑', noFindings: '没按约定给出要点',
    voteAgree: '同意', voteObject: '反对', couldNotSpeak: '这一轮没能发言', pickSpeaker: '选看哪一层的发言',
    // "本轮达成一致"这一句只在**结果区**出现（'达成一致' 本身会撞上发起表单的提示文案，
    // 拿它当判据会把静态文案也算进去）
    reached: '本轮达成一致',
  },
  en: {
    agreed: 'agreed', noStance: 'no stance', truncated: 'truncated', noAgreement: 'No agreement within 2 rounds', notPassed: 'did not pass',
    reported: 'reported', report: 'Analysis briefing', support: 'support', oppose: 'oppose', unsure: 'unsure',
    points: 'Points', risks: 'Risks', questions: 'Open questions', noFindings: 'no points/risks/questions',
    voteAgree: 'agree', voteObject: 'object', couldNotSpeak: 'could not speak this round', pickSpeaker: 'Choose whose reply to show',
    reached: 'agreed this round',
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

/**
 * 分析模式的收场。**故意塞了四种"不好看但必须如实"的形态**：
 *   · 表了态、要点齐全（1F）；
 *   · 表了态但**没给要点**（7F，findings 是 NULL）—— 必须和"给了三条空数组"分开写；
 *   · 表了态、要点三条都空（4F）；—— 这是"答了，答的是没有"
 *   · 压根没表态（8F 超时）—— 必须带错误原文，不许并进某一方。
 * 再加一条：`mode='analysis'` 却**没有** consensus 轮次 —— 界面不许凭空长出共识横幅。
 */
const ANALYSIS = {
  ...COUNCIL,
  council: {
    ...COUNCIL.council,
    topic: '这个 bug fix 会不会引入回归',
    mode: 'analysis',
    workspace_path: '/home/me/proj',
    status: 'done',
    verdict: 'reported',
    verdict_round: null,
    max_rounds: 2,
  },
  participants: [
    { floor_id: '1F', status: 'ok', error: null },
    { floor_id: '4F', status: 'ok', error: null },
    { floor_id: '7F', status: 'ok', error: null },
    { floor_id: '8F', status: 'timeout', error: '进程超时（300s）' },
  ],
  rounds: [
    { round_no: 0, kind: 'brief', proposal_text: '这个 bug fix 会不会引入回归', proposal_from: 'chair', consensus: 0 },
    // 分析模式没有"桌上那份提案"：proposal_* 是 NULL，票型三个列全是 0
    { round_no: 1, kind: 'debate', proposal_text: null, proposal_from: null, agree: 0, disagree: 0, abstain: 0, invalid: 1, consensus: 0 },
    { round_no: 2, kind: 'debate', proposal_text: null, proposal_from: null, agree: 0, disagree: 0, abstain: 0, invalid: 1, consensus: 0 },
  ],
  utterances: [
    { round_no: 0, floor_id: 'chair', role: 'chair', content: '这个 bug fix 会不会引入回归', status: 'ok' },
    { round_no: 1, floor_id: '1F', role: 'speaker', content: '我看了一遍调用方', stance: 'support', findings_json: '{"points":["影响面只有一处"],"risks":[],"questions":[]}', status: 'ok' },
    { round_no: 1, floor_id: '4F', role: 'speaker', content: '我觉得还得看测试', stance: 'unsure', findings_json: '{"points":[],"risks":[],"questions":[]}', status: 'ok' },
    { round_no: 1, floor_id: '7F', role: 'speaker', content: '我反对这么改', stance: 'oppose', findings_json: null, status: 'ok' },
    { round_no: 1, floor_id: '8F', role: 'speaker', content: null, stance: null, status: 'timeout', error: '进程超时（300s）' },
    // 最后一轮才是简报的依据 —— 4F 从"不确定"改成了"反对"
    { round_no: 2, floor_id: '1F', role: 'speaker', content: '结论不变', stance: 'support', findings_json: '{"points":["影响面只有一处"],"risks":["并发下可能重复写"],"questions":[]}', status: 'ok' },
    { round_no: 2, floor_id: '4F', role: 'speaker', content: '看完测试我改反对', stance: 'oppose', findings_json: '{"points":[],"risks":["没有覆盖并发路径"],"questions":["谁来补测试"]}', status: 'ok' },
    { round_no: 2, floor_id: '7F', role: 'speaker', content: '我还是反对', stance: 'oppose', findings_json: null, status: 'ok' },
    { round_no: 2, floor_id: '8F', role: 'speaker', content: null, stance: null, status: 'timeout', error: '进程超时（300s）' },
  ],
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

    // 一轮里好几层各说一大段，全摊开是一屏接一屏的正文，"谁说了什么"反而找不着 ——
    // 所以一轮只摊开一个人的，上面一排圆点选是谁。**收起来的是正文，不是事实**：
    // 票型与"这轮没能发言"必须留在那一行上，否则折叠就成了掩盖。
    const picks1 = regionOf(won, 'cv-picks-1');
    const picks2 = regionOf(won, 'cv-picks-2');
    ok('议事厅：一轮里的人摆成一排，可单选（radio）',
      picks1.includes('type="radio"') && picks1.includes(W.pickSpeaker));
    ok('议事厅：选中的那位在下面摊开，没选的那层正文不出现',
      won.includes('我觉得可以') && !won.includes('不行，得限定幂等'));
    ok('议事厅：收起来的那几层，票型照旧挂在那一行上',
      picks1.includes(W.voteAgree) && picks1.includes(W.voteObject));
    ok('议事厅：没能发言的那层，收起来也看得见（不是收起来就当没发生）', picks1.includes(W.couldNotSpeak));
    ok('议事厅：每一轮的圆点各自成组（同一轮单选，不同轮不互相踢）',
      picks2.includes('type="radio"') && picks1.includes('name="cv-pick-1"') && picks2.includes('name="cv-pick-2"'));
  }

  const lost = await render('/src/views/CouncilView.vue', seedCouncil(NO_CONSENSUS));
  ok('议事厅 · 未达成一致：渲染没抛错', typeof lost === 'string', lost && lost.error);
  if (typeof lost === 'string') {
    ok(`议事厅：没谈成就写没谈成（${W.noAgreement}）`, lost.includes('cv-no-conclusion') && lost.includes(W.noAgreement));
    ok('议事厅：没谈成时**不**出现结论区块', !lost.includes('cv-conclusion'));
    // 桌上最后是这份、没通过 —— 这一块来自服务端的轮次记录，不受"一轮只摊开一个人"影响
    const lastProposal = regionOf(lost, 'cv-last-proposal');
    ok(`议事厅：最后一轮那份提案照样摆出来，但标明${W.notPassed}`,
      lastProposal.includes(W.notPassed) && lastProposal.includes('把重试上限从 3 提到 5 吗'));
    ok(`议事厅：各方最后立场列出来了（${W.noStance}）`, lost.includes(W.noStance));
  }

  // ---- 议事厅 · 分析模式 ----
  const rep = await render('/src/views/CouncilView.vue', seedCouncil(ANALYSIS));
  ok('议事厅 · 分析模式：渲染没抛错', typeof rep === 'string', rep && rep.error);
  if (typeof rep === 'string') {
    ok(`议事厅：出的是简报（${W.report}）`, rep.includes('cv-report') && rep.includes(W.report));
    ok(`议事厅：verdict 写的是${W.reported}`, rep.includes(W.reported));
    // 这一条是顺序问题的机器证据：reported 要是掉进下面那个"中断"框，这座号就没了
    ok('议事厅：reported 没掉进通用的"中断"框（简报分支在它前面）', !rep.includes('cv-aborted'));
    ok('议事厅：分析模式不出现共识横幅', !rep.includes('cv-conclusion') && !rep.includes(W.reached));
    // 分析模式没有可对照的服务端票型，界面不许假装有
    ok('议事厅：分析模式不渲染"同意 N · 反对 N"那套票型', !rep.includes('同意 0 · 反对 0'));

    ok(`议事厅：按立场分了组（${W.support} / ${W.oppose}）`, rep.includes('cv-group-support') && rep.includes('cv-group-oppose'));
    ok(`议事厅：未表态单列一组（${W.noStance}）`, rep.includes('cv-group-none'));
    ok(`议事厅：未表态那组附了错误原文`, rep.includes('进程超时（300s）'));

    // "说了没有"与"没说"必须分开写 —— 这两句混起来，读的人会以为它看过风险
    ok(`议事厅：答了三条都空的那一层写成"${W.questions}"而不是沉默`, rep.includes(W.points) && rep.includes(W.risks));
    ok(`议事厅：没给出要点的那一层单独标一句（${W.noFindings}）`,
      rep.includes('cv-nofindings-7F') && rep.includes(W.noFindings));

    // 原文照录：不摘要、不改写
    ok('议事厅：要点原文照录（风险那条）', rep.includes('并发下可能重复写') && rep.includes('没有覆盖并发路径'));
    ok('议事厅：存疑原文照录', rep.includes('谁来补测试'));
    // 简报依据的是**最后一轮**：4F 在第 1 轮是不确定、第 2 轮改成反对，简报里它得在反对那组
    ok('议事厅：以最后一轮为准（4F 改口后的立场进的是反对组）',
      rep.indexOf('cv-group-oppose') < rep.indexOf('cv-group-none') && rep.includes('没有覆盖并发路径'));
    // 工作目录要摆出来：事后来看"他们在哪儿谈的"是理解这场会的前提
    ok('议事厅：标题区显示了工作目录', rep.includes('cv-workspace-show') && rep.includes('/home/me/proj'));
    ok('议事厅：历史/标题上有谈法角标', rep.includes('cv-mode-badge'));

    // 分析议题里**不许**在楼层名字右边贴「支持/反对」：那会让分析看起来像在投票
    // （立场归上面那份简报按组说，轮次标题上的那句合计也还在）。
    const aPicks = regionOf(rep, 'cv-picks-2');
    if (process.env.DBG) console.log('DBG aPicks 支持?', aPicks.includes('支持'), '反对?', aPicks.includes('反对'), 'len', aPicks.length, 'tail', JSON.stringify(aPicks.slice(-400)));
    ok('议事厅：分析模式的圆点行上不出现「支持/反对」',
      aPicks.includes('type="radio"') && !aPicks.includes(W.support) && !aPicks.includes(W.oppose) && !aPicks.includes(W.unsure));
    ok('议事厅：分析模式的简报里立场照旧分组写着（不是整页都不许提）',
      rep.includes('cv-group-support') && rep.includes(W.support));
    ok('议事厅：分析模式没能发言的那层也没被折叠掉', aPicks.includes(W.couldNotSpeak));
  }
}

setLocale('zh');
await server.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
