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
}

setLocale('zh');
await server.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
