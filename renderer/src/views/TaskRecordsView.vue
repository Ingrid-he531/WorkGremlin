<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useProjectStore } from '../stores/project';
import { useSessionStore } from '../stores/sessions';
import { useTaskStore } from '../stores/tasks';
import { clientLabel } from '../lib/clientMatch';
import { HOUR_COLS, MIN_PER_DAY, buildFloorGantt, dayStartOf, fmtHM } from '../lib/dayBoard';
import {
  TIME_RANGES,
  clampDay,
  dayInRange,
  dayRangeOf,
  inTimeWindow as inWindowAt,
  timeWindowOf,
} from '../lib/timeRange';
import { DEFAULTS, clientBase } from '@workgremlin/shared';
import { httpBase } from '../api/bridge';
import { useI18n } from '../i18n';
import { marked } from 'marked';

/**
 * 打开时停在哪个视图（list / summary / board）。
 * 只有默认值在真跑时用得上；SSR 冒烟测试（renderSmoke）靠它把汇总 / 看板那两个分支也渲染一遍 ——
 * 否则那两块只有手点才走到，白屏类的问题（2026-10-01 汇总页整页空白）测不出来。
 */
const props = defineProps({
  initialView: { type: String, default: 'list' },
});

const project = useProjectStore();
const session = useSessionStore();
const tasks = useTaskStore();
/**
 * 取个别名 `tr`：这个文件里 `t` 到处都是"一条任务"（`dimLabel(t, dim)`、`v-for="t in list"`、
 * 模板里的行变量），用 `tr` 当翻译函数就永远不会被行变量遮住。
 */
const { t: tr } = useI18n();

/**
 * 任务详情「产出摘要」的 markdown 渲染。
 * agent 的 result 是一段 markdown（标题 / 列表 / 代码块 / 加粗 …），原先用 <p> + pre-wrap 当纯文本，
 * 标题列表代码块全糊成一团。这里解析成 HTML 再用 DOMParser 做一层轻量 sanitize
 * （去掉 script/style 与 on* 属性、javascript: 链接）—— 产出来自本机 agent，风险很低，
 * 但渲染层不该原样执行任意 HTML。非浏览器环境（单测）直接返回 marked 原输出，不影响断言。
 */
const md = (text) => {
  if (!text) return '';
  const html = marked.parse(String(text), { breaks: true, gfm: true });
  if (typeof document === 'undefined') return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach((e) => e.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || /^javascript:/i.test(a.value)) el.removeAttribute(a.name);
    }
    if (el.tagName === 'A' && /^\s*javascript:/i.test(el.getAttribute('href') || '')) {
      el.removeAttribute('href');
    }
  });
  return doc.body.innerHTML;
};

/** 一级检索的可选项：所有工程 + 所有楼层（楼层 = 成员 client） */
const projectOptions = computed(() => project.projects || []);
// 楼层里只有带 client 的才能当任务过滤维度（部分楼层 unreported 没有 client）
const floorOptions = computed(() => (session.floors || []).filter((f) => f.client));

/**
 * 楼层 ↔ 客户端（轴 1）：
 *   - 合并楼层（1F CodeBuddy = CLI + Plugin）的 key 是**逗号分隔的 client 串**，服务端按集合取；
 *   - 单楼层就是一个 client，走同一条路（串里只有它自己），行为不变。
 */
function floorClients(f) {
  return Array.isArray(f.clients) && f.clients.length ? f.clients : f.client ? [f.client] : [];
}
function floorValue(f) {
  return floorClients(f).join(',');
}
/** 下拉条目文案：楼层号 + 产品名（"1F CodeBuddy"）；楼层号缺省时只给名字，不编造 */
function floorText(f) {
  return [f.id, f.name].filter(Boolean).join(' ');
}
/** 这条任务的 client 归哪个楼层（先精确命中，再按基名兜底认合并楼层） */
function floorOfClient(c) {
  const k = String(c || '').toLowerCase();
  if (!k) return null;
  return (
    floorOptions.value.find((f) => floorClients(f).some((x) => String(x).toLowerCase() === k)) ||
    floorOptions.value.find((f) => f.client && clientBase(f.client) === clientBase(k)) ||
    null
  );
}

/**
 * 「此刻」有两处用：看板上**还在跑的任务画到哪一格**、以及时间筛选的「今天 / 过去 7 天」
 * 从哪算起（见 lib/timeRange.js）。跟着本页已有的 4s 轮询一起走，不另起定时器 ——
 * 页面开着跨过午夜时，「今天」会自己滚到新的一天。
 *
 * **必须声明在 list 之前**：下面那个 `watch(list, …, { immediate: true })` 在注册的那一刻就
 * 求值，而它经 inTimeWindow → timeWindow 读 nowMs；挪到文件后半段就是 TDZ
 * （Cannot access 'nowMs' before initialization），整个页面白屏。
 */
const nowMs = ref(Date.now());

/** 每 4s 轮询一次（任务/ subagent 是低频事件，轮询足够，不必挂 WS） */
const POLL_MS = 4000;
let timer = null;

function start() {
  nowMs.value = Date.now();
  tasks.fetchTasks();
  if (timer) clearInterval(timer);
  // 「此刻」跟着这轮轮询一起走：看板上"还在跑的任务画到哪一格"才不会停在打开页面那一刻
  timer = setInterval(() => {
    nowMs.value = Date.now();
    tasks.fetchTasks();
  }, POLL_MS);
}
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

onMounted(() => {
  start();
  loadRetention();
});
onUnmounted(stop);
// 切工程时重拉 + 复位筛选
watch(
  () => project.project && project.project.id,
  (id) => {
    tasks.selectedTaskId = null;
    tasks.subagents = [];
    tasks.filterProject = 'all';
    tasks.filterClient = 'all';
    filterState.value = 'all';
    filterTime.value = 'all';
    customFrom.value = '';
    customTo.value = '';
    keyword.value = '';
    filterModel.value = '';
    if (id) tasks.fetchTasks();
  }
);
// 一级检索变化 → 重新拉取（project / client 走服务端）
watch(
  () => [tasks.filterProject, tasks.filterClient],
  () => tasks.fetchTasks()
);

const expandedSub = ref(null);
function toggleSub(id) {
  expandedSub.value = expandedSub.value === id ? null : id;
}

// ---- 格式化 ----
function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m${r ? ` ${r}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function fmtTokens(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}
/**
 * 本轮的**输入总量** = 非缓存 + 缓存读。
 *
 * 库里两列是分开存的（语义见 server/src/db/schema.sql 的注释：`input_tokens` 只是**没命中缓存**
 * 的那部分），而人问"这轮输入了多少"问的是整段送进去的上下文 —— 只显示 input_tokens 那一列，
 * 4F Claude 会显示成 161 而实际是 46,497，看着像坏了。拆分明细挂在 title 上。
 * 两列全 NULL = 这个楼层报不出 token（5F/6F/9F…）→ 返回 null 显示 "—"，
 * 与"消耗为 0"区分开（后者会显示 0）。
 */
function inputTotalOf(t) {
  if (!t) return null;
  const parts = [t.input_tokens, t.cache_read_tokens];
  if (parts.every((v) => v == null)) return null;
  return parts.reduce((s, v) => s + (Number(v) || 0), 0);
}
/**
 * 「词元」那一行：三项**全摊开**、用 " / " 隔开（2026-10-01 用户要求；2026-10-08 用户要求
 * 去掉「缓存写输入」—— 本机 12 个楼层实测这一列**恒为 0**，占一格还不带信息）。
 * 顺序照库里的列序 —— **非缓存输入 / 缓存读输入 / 输出**，
 * 前两项相加才是"这一轮输入总量"（库里 `input_tokens` 不含缓存，见 schema.sql 的注释；
 * 只显示它的话 4F Claude 会出现 "5,662" 而实际送进去 1,457,438，看着像坏了）。
 * 每一项各取各的：报不出 token 的楼层三项都是 "—"（**不是 0** ——"报不出来"与"消耗为零"是两回事）。
 */
function tokenQuadOf(t) {
  const s = t || {};
  return [s.input_tokens, s.cache_read_tokens, s.output_tokens].map(fmtTokens).join(' / ');
}
/** 「词元」那一行的悬停说明：三个数各是什么（顺序与主行一致）+ 前两项的合计 */
function tokenTitleOf(t) {
  const head = tr('records.tokens_order');
  const total = inputTotalOf(t);
  return total == null ? head : tr('records.tokens_total', { head, n: fmtTokens(total) });
}
/**
 * 一条任务的**总词元** = 非缓存输入 + 缓存读输入 + 输出（三项全加）。
 * 汇总报表「数据总览」那张表（一行一个任务）的「词元」列用它。
 * 三项全 NULL（5F TraeCode / 6F Qoder 这些报不出 token 的楼层）→ null 显示 "—"，
 * 与"消耗为 0"区分开（后者会显示 0）。
 */
function totalTokensOf(t) {
  if (!t) return null;
  const parts = [t.input_tokens, t.cache_read_tokens, t.output_tokens];
  if (parts.every((v) => v == null)) return null;
  return parts.reduce((s, v) => s + (Number(v) || 0), 0);
}
/** 状态 key → i18n 词条（筛选项与表格里的状态列共用） */
const STATE_KEY = {
  all: 'records.state.all',
  pending: 'records.state.pending',
  running: 'records.state.running',
  done: 'records.state.done',
  failed: 'records.state.failed',
  cancelled: 'records.state.cancelled',
};
function stateLabel(s) {
  return STATE_KEY[s] ? tr(STATE_KEY[s]) : s || '—';
}
/** 当前**没有调用方**：详情里那一行「进度」按 2026-09-29 的要求注释掉了（见模板里的说明），
 *  留着是为了将来有真进度时一行就能放回来。progress 现在只有 0 / 1 两个取值。 */
function fmtProgress(p) {
  if (p == null) return '—';
  return `${Math.round(p * 100)}%`;
}
function filesOf(task) {
  let a = [];
  try {
    const raw = JSON.parse((task && task.files_json) || '[]');
    a = Array.isArray(raw) ? raw : [];
  } catch {
    a = [];
  }
  // 兼容老数据（纯路径字符串 / {path,added,removed}）与新结构（{path,op,size}）
  return a.map((x) => {
    if (typeof x === 'string') return { path: x, op: null, size: null };
    return { path: x.path, op: x.op ?? null, size: x.size ?? null };
  });
}

/**
 * 这一轮用过的工具（名字 + 次数）。服务端按 tool_usage 表聚合好随任务行下发
 * （见 server/src/http/routes/query.js 的 /task-runs）；没有记录就是空数组，
 * 详情里那一段整块不显示 —— 前端不折算、不编造。
 */
function toolsOf(task) {
  const a = task && task.tools;
  if (!Array.isArray(a)) return [];
  return a
    .filter((x) => x && x.tool)
    .map((x) => ({ tool: String(x.tool), count: Number(x.count) || 0 }));
}

/**
 * 任务标题里的"用户原话"。
 *
 * 老数据（hook 修掉之前）把 IDE 注入的那段上下文整段当标题存了下来 ——
 * `# Context from my IDE setup: ## Active file: …`。钩子那边已经不再这么存（规则见
 * packages/reporter/src/hook.js 的 userRequestText），但**历史行**还在库里，显示时按
 * 同一套规则再剥一次，任务列表才不是一屏 IDE 上下文。规则与 hook 侧保持一致。
 */
function promptOf(t) {
  const raw = String((t && t.title) || '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) return '';
  const injected =
    /^[ \t]*#{0,6}[ \t]*Context from my IDE setup\b/im.test(raw) ||
    /^[ \t]*#{1,6}[ \t]*(?:Active file|Open tabs)\b/im.test(raw);
  if (!injected) return raw.trim();
  const parts = raw.split(
    /^[ \t]*#{0,6}[ \t]*(?:My request|User request|Request|我的请求|用户请求)[ \t]*[:：][ \t]*$/im
  );
  return parts.length > 1 ? parts.slice(1).join('\n').trim() : '';
}
/**
 * 会话标题：**会话级**的名字 —— 同一条会话的各轮任务拿到同一个值，
 * 凭它认出"哪些任务属于同一个会话"（一轮 = 一行任务，各轮自己的标题互不相同）。
 * 服务端取值顺序：6F/7F/8F 用它们 SQLite 里的会话摘要；其余楼层兜底成
 * 这条会话**第一轮**的用户原话（会话开始时的标题就是用户原话）。
 * 拿不到一律空串（见 server/src/sessionTitle.js），这里就不显示那一行。
 */
function sessionTitleOf(t) {
  return String((t && t.session_title) || '').trim();
}
/**
 * 列表 / 汇总 / 甘特 / 导出一律显示**这一轮自己的用户输入**（promptOf），不用会话标题 ——
 * 会话标题是会话级的（同一会话各轮共用同一个值），拿它当行标题会让一列任务全显示成
 * 第一轮的那一句，分不出谁是谁。它只在详情里单列一行（见详情的「会话标题」）。
 */
/** 把 hook 的 op 归到三类：add=新增 / del=删除 / mod=改动（含老数据无 op） */
function classify(f) {
  if (f.op === 'delete') return 'del';
  if (f.op === 'write') return 'add';
  return 'mod';
}
const addedFiles = (t) => filesOf(t).filter((f) => classify(f) === 'add');
const modifiedFiles = (t) => filesOf(t).filter((f) => classify(f) === 'mod');
const deletedFiles = (t) => filesOf(t).filter((f) => classify(f) === 'del');
/** 字节数 -> 人类可读（B / KB / MB） */
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 顶部筛选：状态分段 + 标题关键词（仅本页生效，纯客户端过滤，不改表结构） */
const FILTER_STATES = ['all', 'running', 'done', 'failed', 'cancelled', 'pending'];
const filterState = ref('all');
const keyword = ref('');

/**
 * 时间筛选（2026-10-01 用户要求）。档位表与窗口算法都在 lib/timeRange.js（纯函数、有回归
 * 测试 —— 这里全是跨午夜 / 月末 / 夏令时的边界，混在 SFC 里测不动）。
 *
 * "此刻"取 nowMs（跟着本页 4s 轮询走）：页面开着跨过午夜时，「今天」会自己滚到新的一天，
 * 不必另起定时器。
 */
const filterTime = ref('all');
/** 时间档位的文案（档位表在 lib/timeRange.js，文案在中英文案表里；认不出的 key 原样显示） */
const TIME_KEY = {
  all: 'records.time.all',
  today: 'records.time.today',
  yesterday: 'records.time.yesterday',
  d7: 'records.time.d7',
  d30: 'records.time.d30',
  thisMonth: 'records.time.this_month',
  lastMonth: 'records.time.last_month',
  custom: 'records.time.custom',
};
function timeRangeLabel(key) {
  return TIME_KEY[key] ? tr(TIME_KEY[key]) : String(key || '');
}
/** 自定义区间：两个 <input type="date"> 的值，本地 YYYY-MM-DD（空 = 那一端不设限） */
const customFrom = ref('');
const customTo = ref('');
const timeWindow = computed(() => timeWindowOf(filterTime.value, nowMs.value, customFrom.value, customTo.value));
/** 这条任务的开始时刻落在当前时间窗里吗（口径见 lib/timeRange.js 的 inTimeWindow） */
function inTimeWindow(t) {
  return inWindowAt(t && t.started_at, timeWindow.value);
}

/** 三个并列视图，共享上方筛选条件：列表视图（默认）/ 汇总报表 / 图形看板 */
const VIEWS = [
  { key: 'list', label: 'records.view.list' },
  { key: 'summary', label: 'records.view.summary' },
  { key: 'board', label: 'records.view.board' },
];
const view = ref(props.initialView);

// 模型无专属下拉，留给“汇总报表”点行下钻时用的客户端筛选（默认空=不过滤，不影响列表视图现有逻辑）
const filterModel = ref('');

const list = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  const fm = filterModel.value;
  return (tasks.tasks || []).filter((t) => {
    if (filterState.value !== 'all' && t.state !== filterState.value) return false;
    if (!inTimeWindow(t)) return false;
    if (kw && !promptOf(t).toLowerCase().includes(kw) && !String((t.session_title) || '').toLowerCase().includes(kw)) return false;
    if (fm && (t.model || '') !== fm) return false;
    return true;
  });
});

// 列表视图打开 / 数据刷新后，若尚未选中任何任务则默认选中第一条；无任务时右侧留空。
watch(
  list,
  (arr) => {
    if (!tasks.selectedTaskId && arr && arr.length) tasks.selectTask(arr[0].id);
  },
  { immediate: true }
);

// ---- 汇总报表：按维度聚合（基于已筛选的 list，三视图共享筛选条件）----
/**
 * 维度页签的顺序 = 数组顺序。「数据总览」放最前面（用户 2026-10-01 要求），它也是打开报表时的
 * 默认视图。
 *
 * key 仍叫 `time`：它标的是"这一版按时间逐条列任务"（跟那三个按维度聚合的并列），
 * 只是页签文案改成了「数据总览」—— key 是内部标识，跟着 CSV 分支与测试走，不改。
 */
const DIMS = [
  { key: 'time', label: 'records.dim.time' },
  { key: 'project', label: 'records.dim.project' },
  { key: 'model', label: 'records.dim.model' },
  { key: 'floor', label: 'records.dim.floor' },
];
const DIM_COL = {
  project: 'records.col.project',
  model: 'records.col.model',
  floor: 'records.dim.floor',
  time: 'records.col.time',
};
/** 默认停在第一个维度（现在就是「数据总览」）—— 页签排在最前、打开也是它 */
const reportDim = ref(DIMS[0].key);
const reportSort = ref({ key: 'taskCount', dir: 'desc' });

function dimValue(t, dim) {
  if (dim === 'project') return t.project_id || '';
  if (dim === 'model') return t.model || '';
  // 按楼层聚合：CLI 与 Plugin 两个 client 归同一个楼层（1F CodeBuddy）→ 同一个分组 key
  if (dim === 'floor') {
    const f = floorOfClient(t.client);
    return f ? floorValue(f) : t.client || '';
  }
  return '';
}
function dimLabel(t, dim) {
  if (dim === 'project') return (projectOptions.value.find((p) => p.id === t.project_id) || {}).name || t.project_id || tr('records.unnamed_project');
  if (dim === 'model') return t.model || tr('records.unrecorded');
  if (dim === 'floor') {
    const f = floorOfClient(t.client);
    if (f) return f.name;
    return t.client ? clientLabel(t.client) : tr('records.unrecorded');
  }
  return '';
}
const reportGroups = computed(() => {
  const dim = reportDim.value;
  const map = new Map();
  for (const t of list.value) {
    const k = dimValue(t, dim);
    let g = map.get(k);
    if (!g) {
      // sids：这一组里出现过的 session_id（去重用）—— 会话数 = 它有多少个元素，
      // 不是任务数（一条会话通常有多轮任务）。会话级去重，任务数照旧一轮算一条。
      g = { key: k, label: dimLabel(t, dim), taskCount: 0, sids: new Set(), successCount: 0, cancelCount: 0, fileCount: 0, durationSum: 0, durN: 0, tokenSum: 0, tokenN: 0 };
      map.set(k, g);
    }
    g.taskCount += 1;
    const sid = String(t.session_id || '').trim();
    if (sid) g.sids.add(sid);
    // 没有 session_id 的老任务：占一条任务，但不撑会话数（不知道它属于哪条会话，不编造）
    if (t.state === 'done') g.successCount += 1;
    else if (t.state === 'cancelled') g.cancelCount += 1;
    g.fileCount += Number(t.file_count) || 0;
    const d = Number(t.duration_ms) || 0;
    if (d > 0) { g.durationSum += d; g.durN += 1; }
    // 词元合计：**只累加报得出 token 的任务**（报不出的不计入、也不当 0 拉低，
    // 口径与「数据总览」那张表的表尾合计一致）。tokenN 记"这一组有几条真有数"。
    const tk = totalTokensOf(t);
    if (tk != null) { g.tokenSum += tk; g.tokenN += 1; }
  }
  return [...map.values()].map((g) => {
    const avgDuration = g.durN ? g.durationSum / g.durN : 0;
    return { ...g, avgDuration, sessionCount: g.sids.size };
  });
});
const reportTotal = computed(() => {
  // 合计的会话数 = 所有组去重后的并集（不是各组会话数相加 —— 一条会话可能同时落在
  // 两个组里，比如同一个 session 里换过模型，按模型分组时它会进两组）
  const allSids = new Set();
  const a = reportGroups.value.reduce(
    (s, g) => {
      for (const id of g.sids) allSids.add(id);
      return {
        taskCount: s.taskCount + g.taskCount,
        successCount: s.successCount + g.successCount,
        cancelCount: s.cancelCount + g.cancelCount,
        fileCount: s.fileCount + g.fileCount,
        durationSum: s.durationSum + g.durationSum,
        durN: s.durN + g.durN,
        tokenSum: s.tokenSum + g.tokenSum,
        tokenN: s.tokenN + g.tokenN,
      };
    },
    { taskCount: 0, successCount: 0, cancelCount: 0, fileCount: 0, durationSum: 0, durN: 0, tokenSum: 0, tokenN: 0 }
  );
  const avgDuration = a.durN ? a.durationSum / a.durN : 0;
  return { label: tr('records.total'), taskCount: a.taskCount, sessionCount: allSids.size, successCount: a.successCount, cancelCount: a.cancelCount, fileCount: a.fileCount, avgDuration, tokenSum: a.tokenSum, tokenN: a.tokenN };
});
const reportSorted = computed(() => {
  const rows = reportGroups.value.slice();
  const { key, dir } = reportSort.value;
  if (key) rows.sort((x, y) => (dir === 'asc' ? x[key] - y[key] : y[key] - x[key]));
  return rows;
});
const dimColName = computed(() => tr(DIM_COL[reportDim.value] || 'records.dim.default'));
function sortBy(key) {
  if (reportSort.value.key === key) reportSort.value.dir = reportSort.value.dir === 'asc' ? 'desc' : 'asc';
  else reportSort.value = { key, dir: 'desc' };
}
function sortCls(key) {
  const s = reportSort.value;
  return { active: s.key === key, asc: s.key === key && s.dir === 'asc', desc: s.key === key && s.dir === 'desc' };
}
/* ---- 按时间：逐条列任务（不聚合），列 = 时间 / 任务 / 客户端 / 模型 / 工程 / 时长 / 状态 ---- */
/**
 * 任务标题只取前 10 个字（超了加省略号）：这一版一行一个任务，
 * 标题原样铺开会把右边的客户端 / 模型 / 工程挤出去。完整标题挂在 title 上。
 * 用 [...s] 按**码点**切 —— 直接 slice 会把 emoji / 生僻字劈成半个，显出乱码。
 */
/** 按**码点**截断（直接 slice 会把 emoji / 生僻字劈成半个，显出乱码） */
function shortText(s, n = 10) {
  const chars = [...String(s || '')];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : String(s || '');
}
function shortTitle(task, n = 10) {
  // 注意参数名别叫 t：这个文件里 t 到处都是"一条任务"，翻译函数取的是 tr
  return shortText(promptOf(task) || tr('records.untitled_task'), n);
}
/** 工程列：与任务详情同一口径（服务端按工程目录现算的 project_label > 库里的 name > id） */
function projectOf(t) {
  return t.project_label || t.project_name || t.project_id || '—';
}
/** 数据总览那一版的排序（默认新→旧；点表头切换） */
const timeSort = ref({ key: 'started_at', dir: 'desc' });
function sortTimeBy(key) {
  if (timeSort.value.key === key) timeSort.value = { key, dir: timeSort.value.dir === 'asc' ? 'desc' : 'asc' };
  else timeSort.value = { key, dir: 'desc' };
}
function timeSortCls(key) {
  const s = timeSort.value;
  return { active: s.key === key, asc: s.key === key && s.dir === 'asc', desc: s.key === key && s.dir === 'desc' };
}
const timeRows = computed(() => {
  const { key, dir } = timeSort.value;
  const val = (t) => {
    if (key === 'tokens') return Number(totalTokensOf(t)) || 0;
    if (key === 'duration_ms') return Number(t.duration_ms) || 0;
    return Number(t.started_at) || 0;
  };
  return list.value.slice().sort((a, b) => (dir === 'asc' ? val(a) - val(b) : val(b) - val(a)));
});
/** 表尾那一行：条数 + 总时长（没收工的任务没有 duration，不计入，不编造） */
const timeTotalMs = computed(() => timeRows.value.reduce((s, t) => s + (Number(t.duration_ms) || 0), 0));
/** 表尾的会话数：这一屏涉及多少条**不同**的会话（没有 session_id 的老任务不计，不编造） */
const timeSessionCount = computed(() => {
  const sids = new Set();
  for (const t of timeRows.value) {
    const sid = String(t.session_id || '').trim();
    if (sid) sids.add(sid);
  }
  return sids.size;
});
/**
 * 表尾的词元合计：**只累加报得出 token 的那些任务**（报不出的不计入，也不当 0 拉低）。
 * 一条都报不出 → null 显示 "—"（这一屏压根没有真值，写 0 会让人以为"跑了但不耗词元"）。
 */
const timeTotalTokens = computed(() => {
  let sum = 0;
  let n = 0;
  for (const t of timeRows.value) {
    const v = totalTokensOf(t);
    if (v == null) continue;
    sum += v;
    n += 1;
  }
  return n ? sum : null;
});

/** 点报表行：切到列表视图并按该行维度值筛选（工程/楼层走服务端筛选，模型/Agent 走客户端筛选） */
function drillDown(row) {
  const dim = reportDim.value;
  // 数据总览那一版列的就是任务本身，点一行 = 直接看这条任务的详情
  if (dim === 'time') {
    tasks.selectTask(row.id);
    view.value = 'list';
    return;
  }
  filterModel.value = '';
  if (dim === 'project') { tasks.filterProject = row.key || 'all'; tasks.filterClient = 'all'; }
  else if (dim === 'floor') { tasks.filterClient = row.key || 'all'; tasks.filterProject = 'all'; }
  else if (dim === 'model') { filterModel.value = row.key; }
  view.value = 'list';
}
/** 把二维数组写成 CSV 并下载（客户端 Blob，手机号/身份证那类敏感数据不在这里，无需额外处理） */
function downloadCsv(fileName, lines) {
  const csv = lines
    .map((line) => line.map((c) => {
      const s = String(c);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
    .join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 导出报表为 CSV（客户端下载，含当前排序与合计行；数据总览那一版导的就是逐条任务） */
function exportCsv() {
  if (reportDim.value === 'time') {
    const head = [
      tr('records.col.time'), tr('records.col.task'), tr('records.col.session'),
      tr('records.col.client'),
      tr('records.col.model'), tr('records.col.project'), tr('records.col.tokens'),
      `${tr('records.col.duration')}(ms)`, tr('records.col.state'),
    ];
    const rows = timeRows.value.map((t) => [
      fmtTime(t.started_at),
      promptOf(t) || tr('records.untitled_task'), // 导出用完整标题，别把省略号也导出去
      sessionTitleOf(t), // 会话：拿不到就是空串（表里显示 "—"，导出留空，不写占位）
      clientLabel(t.client, t.form),
      t.model || '',
      projectOf(t),
      // 词元导出的是**裸数字**（不带千位逗号，Excel 才好当数值算）；取不到留空，不写 0
      totalTokensOf(t) == null ? '' : totalTokensOf(t),
      t.duration_ms == null ? '' : Math.round(t.duration_ms),
      stateLabel(t.state),
    ]);
    // 文件名跟页签走（下面聚合那几版也是拿 label 拼的），改页签文案时这里要一起改
    downloadCsv(`${tr('records.view.summary')}_${tr('records.dim.time')}.csv`, [head, ...rows]);
    return;
  }
  const dimLabelNow = tr((DIMS.find((d) => d.key === reportDim.value) || {}).label || 'records.dim.default');
  const head = [
    tr('records.dim.default'), tr('records.col.task_count'), tr('records.col.session_count'),
    tr('records.col.success_count'),
    tr('records.col.cancel_count'), tr('records.col.file_count'), tr('records.col.token_sum'),
    `${tr('records.col.duration_sum')}(ms)`, `${tr('records.col.avg_duration')}(ms)`,
  ];
  // 词元导出**裸数字**（不带千位逗号，Excel 里才能直接算）；这一组没有真值就留空，不写 0
  const tokenCell = (x) => (x.tokenN ? x.tokenSum : '');
  const rows = reportSorted.value.map((r) => [
    r.label, r.taskCount, r.sessionCount, r.successCount, r.cancelCount, r.fileCount,
    tokenCell(r),
    Math.round(r.durationSum), Math.round(r.avgDuration),
  ]);
  const totalLine = [
    reportTotal.value.label, reportTotal.value.taskCount, reportTotal.value.sessionCount,
    reportTotal.value.successCount,
    reportTotal.value.cancelCount, reportTotal.value.fileCount,
    tokenCell(reportTotal.value),
    Math.round(reportTotal.value.durationSum), Math.round(reportTotal.value.avgDuration),
  ];
  rows.push(totalLine);
  downloadCsv(`${tr('records.view.summary')}_${dimLabelNow}.csv`, [head, ...rows]);
}

/* ------------------------------ 图形看板：每日 ------------------------------
 * 一天一张甘特图：
 *   横轴 = 当天 00:00–24:00，**每小时一条竖线**（刻度 09:00 / 10:00 …）；
 *   纵轴 = **楼层**（一层一行，如「3F Codex」）；
 *   行里的实心块 = 这一层的一次任务，左右两条竖边把相邻任务切开（"用竖线分割任务"）。
 * **一层恒定一行**：同一层同一时刻并行好几轮时不再往下摞泳道，而是把重叠的那一段**加深**
 * （暗色叠在块上）—— 行数稳，也照样看得出"这会儿同时跑了两三条"。
 *
 * 口径：
 *   · 不分楼层？不 —— 看板就是按楼层分行的；上方筛选栏照旧生效（工程 / 楼层 / 状态 / 关键字
 *     都作用在 list 上），所以只筛某一层时图上就只有那一行；
 *   · 跨天 / 没有结束时间 / 只有开始时间这些边界都在 lib/dayBoard.js（纯函数，有回归测试）。
 */
function fmtDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const wd = tr('records.weekdays')[d.getDay()] || '';
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}${wd ? ` ${wd}` : ''}`;
}

/** 一行的行高（px）：一层恒定一行，这个值同时决定行高与块高 */
const LANE_H = 16;

const boardDay = ref(dayStartOf(Date.now()));
const boardIsToday = computed(() => boardDay.value === dayStartOf(Date.now()));

/**
 * 看板能翻到哪几天 = 顶部时间筛选的那个窗口（用户 2026-10-01 要求）。
 * 选中「今天」就只剩今天，前一天 / 后一天都没得点；「过去 7 天」只能在 9/25–10/1 之间翻。
 * 「全部时间」两端都是 null —— 跟以前一样自由翻。算法在 lib/timeRange.js（有回归测试）。
 */
const boardDayRange = computed(() => dayRangeOf(timeWindow.value));
/** 当前档位的文案（给灰掉的按钮写 title 用，让人知道是被哪个筛选卡住的） */
const filterTimeLabel = computed(
  () => timeRangeLabel(filterTime.value)
);
/** 换档位 / 跨过午夜后，把停在窗外的这天拉回来 —— 否则画出来是一片空白，看着像坏了 */
watch(
  boardDayRange,
  () => {
    const next = clampDay(boardDay.value, boardDayRange.value);
    if (next !== boardDay.value) boardDay.value = next;
  },
  { immediate: true }
);

function shiftDay(n) {
  const d = new Date(boardDay.value);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  boardDay.value = clampDay(d.getTime(), boardDayRange.value);
}
/** 这一天能不能翻过去：翻过去还在筛选窗口里才让点（否则按钮置灰） */
function canShiftDay(n) {
  const d = new Date(boardDay.value);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return dayInRange(d.getTime(), boardDayRange.value);
}
/** 「今天」这一跳：窗口里没有今天（比如筛的是"上个月"）时置灰，不把人送到窗外 */
const canBackToToday = computed(() => dayInRange(dayStartOf(Date.now()), boardDayRange.value));

function backToToday() {
  boardDay.value = clampDay(dayStartOf(Date.now()), boardDayRange.value);
}
/** 本地 YYYY-MM-DD（不能用 toISOString —— 那是 UTC，会差一天） */
function dayValueOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const boardDayValue = computed(() => dayValueOf(boardDay.value));
/** <input type="date"> 的 min / max：不设限的那一端给 undefined（属性整个不渲染） */
const boardDayMin = computed(() =>
  boardDayRange.value.minDay == null ? undefined : dayValueOf(boardDayRange.value.minDay)
);
const boardDayMax = computed(() =>
  boardDayRange.value.maxDay == null ? undefined : dayValueOf(boardDayRange.value.maxDay)
);
function onBoardDayInput(e) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String((e.target && e.target.value) || ''));
  if (!m) return;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setHours(0, 0, 0, 0);
  // 手敲 / 浏览器不认 min·max 的情况都兜一下：夹回窗口，别让看板停在窗外
  boardDay.value = clampDay(d.getTime(), boardDayRange.value);
}

/** 一次任务落在哪一行：client → 楼层（合并楼层按基名认，见 floorOfClient） */
function rowOfTask(t) {
  const f = floorOfClient(t.client);
  if (f) return { key: f.id, label: floorText(f), order: Number.parseInt(f.id, 10) || 900 };
  if (!t.client) return { key: '__none__', label: tr('records.no_floor'), order: 999 };
  // 有 client 但不在楼层表里（老数据 / 该产品没装）：如实标出是哪个 client，不硬塞进某层
  return { key: String(t.client), label: clientLabel(t.client, t.form), order: 900 };
}

/**
 * 就算这一天没有任务也要占一行的楼层（用户 2026-10-01 要求）：
 *   · 楼层筛选 = 全部楼层 → **所有已安装的楼层**都画出来，空的留一行空格子；
 *   · 筛了具体楼层 → 只留命中的那几层（合并楼层的值是逗号分隔的一串 client）。
 * 任务真落在没列出来的地方（不在楼层表里的 client / 压根没 client）时，
 * buildFloorGantt 仍会为它补一行 —— 一行都不会丢。
 */
const boardBaseRows = computed(() => {
  const want = String(tasks.filterClient || 'all').toLowerCase();
  const hit = (f) => {
    if (want === 'all') return f.installed !== false;
    const list = floorClients(f).map((c) => String(c).toLowerCase());
    return String(tasks.filterClient)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .some((c) => list.includes(c));
  };
  return floorOptions.value
    .filter(hit)
    .map((f) => ({ key: f.id, label: floorText(f), order: Number.parseInt(f.id, 10) || 900 }));
});

const boardGantt = computed(() =>
  buildFloorGantt(list.value, boardDay.value, nowMs.value, rowOfTask, boardBaseRows.value)
);
const boardRows = computed(() => boardGantt.value.rows);
/** 「此刻」在横轴上的位置（%）；看的不是今天就返回 -1（不画那条线） */
const boardNowPct = computed(() => {
  if (!boardIsToday.value) return -1;
  return ((nowMs.value - boardDay.value) / (MIN_PER_DAY * 60 * 1000)) * 100;
});

/** 块上的悬停提示：是哪条任务、几点到几点、多久、什么状态 */
function blockTitle(it) {
  const task = it.task;
  const dur = task.duration_ms != null ? fmtDuration(task.duration_ms) : tr('records.unfinished');
  return `${promptOf(task) || tr('records.untitled_task')}\n${fmtHM(it.startMin)}–${fmtHM(it.endMin)} · ${dur} · ${stateLabel(task.state)}`;
}
/**
 * 重叠段的加深：同时跑 2 条加一档、3 条再加一档（最深压住，免得糊成一块黑）。
 * 只加暗、不换色 —— 块本身的状态色不被这层盖掉多少，仍读得出是"完成"还是"在跑"。
 */
function scrimAlpha(count) {
  return Math.min(0.6, 0.22 * (count - 1));
}
/** 点块 = 看这条任务的详情：跳到列表视图并选中它 */
function openTask(id) {
  tasks.selectTask(id);
  view.value = 'list';
}

// ---- 删除 ----
/** 单个删除：二次确认（点一次变"确认删除?"，再点才真删，期间可"取消"） */
const confirmId = ref(null);
function askDelete(t) {
  if (confirmId.value === t.id) {
    confirmId.value = null;
    tasks.deleteTask(t.id);
  } else {
    confirmId.value = t.id;
  }
}
function cancelDelete() {
  confirmId.value = null;
}

/**
 * 批量删除：删除当前筛选（工程/楼层）下的全部记录（手动、立即生效）。
 *
 * 注意这两组筛选的范围**不一样**：工程/楼层走服务端（DELETE 的 query），状态/关键词/时间
 * 走本页客户端。所以列表上看着只剩几条时，这一下删的仍是工程/楼层那一整片 —— 文案得把这个
 * 差额说清楚，不能只报个头衔。
 */
function bulkDeleteAll() {
  const n = tasks.tasks.length;
  const shown = list.value.length;
  const scope = tr('records.delete_scope', { n });
  const gap = shown < n ? `\n\n${tr('records.delete_scope_hint', { n: shown })}` : '';
  if (!window.confirm(tr('records.delete_confirm_text', { scope, gap }))) return;
  tasks.deleteByFilter('all');
}
/**
 * 记录保留天数：服务端按此自动清理更早的任务记录（改动才写回，不轮询）。
 *
 * 初值只是**在拉到服务端设置之前**先显个像样的数 —— 真值以 GET /settings/retention 为准
 * （用户改过的话落库值优先，跟这里的缺省无关）。缺省跟着 DEFAULTS 走，别在这写死。
 */
const retentionDays = ref(DEFAULTS.RETENTION_DAYS);
async function loadRetention() {
  try {
    retentionDays.value = await tasks.fetchRetention();
  } catch {
    /* 拉不到就留着缺省值（不是"写回 90"—— 没读到就不动服务端） */
  }
}
async function saveRetention() {
  const ok = await tasks.saveRetention(retentionDays.value);
  if (!ok) window.alert(tr('records.retention_failed'));
}
</script>

<template>
  <div class="view" data-testid="task-records">
    <!-- 筛选：一级（工程 + 楼层）+ 二级（状态分段）+ 标题搜索 + 计数，仅本页生效 -->
    <div class="filters">
      <span class="spacer" />
      <select v-model="tasks.filterProject" class="sel" :aria-label="tr('records.col.project')">
        <option value="all">{{ tr('records.filter.project') }}</option>
        <option v-for="p in projectOptions" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <select v-model="tasks.filterClient" class="sel" :aria-label="tr('records.dim.floor')">
        <option value="all">{{ tr('records.filter.floor') }}</option>
        <!-- 合并楼层（1F CodeBuddy）的值是逗号分隔的 client 串，服务端按集合取（见 query.js）；
             条目文案带上楼层号（"1F CodeBuddy"）—— 只有产品名时认不出是哪层 -->
        <option v-for="f in floorOptions" :key="f.id" :value="floorValue(f)">{{ floorText(f) }}</option>
      </select>
      <select v-model="filterState" class="sel" :aria-label="tr('records.col.state')">
        <option value="all">{{ tr('records.filter.state') }}</option>
        <option v-for="s in FILTER_STATES.filter((s) => s !== 'all')" :key="s" :value="s">{{ stateLabel(s) }}</option>
      </select>
      <!-- 时间筛选：口径 = 任务的开始时刻（见 timeWindow）。选「自定义」才露出两个日期框 -->
      <select v-model="filterTime" class="sel" :aria-label="tr('records.col.time')">
        <option v-for="r in TIME_RANGES" :key="r.key" :value="r.key">{{ timeRangeLabel(r.key, r.label) }}</option>
      </select>
      <template v-if="filterTime === 'custom'">
        <input v-model="customFrom" class="day-input" type="date" :aria-label="tr('records.filter.custom_from')" />
        <span class="dim">→</span>
        <input v-model="customTo" class="day-input" type="date" :aria-label="tr('records.filter.custom_to')" />
      </template>
      <input
        v-model="keyword"
        class="search"
        type="search"
        :placeholder="tr('records.filter.keyword')"
        :aria-label="tr('records.filter.keyword')"
      />
      <span class="dim count">{{ tr('records.count', { n: list.length }) }}</span>
    </div>

    <!-- 三视图切换：共享上方筛选条件 -->
    <div class="view-tabs">
      <button
        v-for="v in VIEWS"
        :key="v.key"
        type="button"
        class="view-tab"
        :class="{ on: view === v.key }"
        @click="view = v.key"
      >{{ tr(v.label) }}</button>
    </div>

    <div class="body" v-if="view === 'list'">
      <!-- 左：每行一次任务 -->
      <ul class="task-list" :class="{ empty: !list.length }">
        <li
          v-for="t in list"
          :key="t.id"
          class="task-row"
          :class="{ on: t.id === tasks.selectedTaskId }"
          @click="tasks.selectTask(t.id)"
        >
          <div class="row-top">
            <span class="time">{{ fmtTime(t.started_at) }}</span>
            <span class="row-actions">
              <span v-if="t.subagentCount" class="badge">{{ t.subagentCount }} subagent</span>
              <template v-if="confirmId === t.id">
                <button
                  type="button"
                  class="del-btn confirm"
                  :title="tr('records.delete_confirm_title')"
                  @click.stop="askDelete(t)"
                >{{ tr('records.delete_confirm') }}</button>
                <button
                  type="button"
                  class="del-btn"
                  :title="tr('records.delete_cancel_title')"
                  @click.stop="cancelDelete"
                >{{ tr('records.delete_cancel') }}</button>
              </template>
              <button
                v-else
                type="button"
                class="del-btn"
                :title="tr('records.delete_title')"
                @click.stop="askDelete(t)"
              >{{ tr('records.delete') }}</button>
            </span>
          </div>
          <div class="row-title">{{ promptOf(t) || tr('records.untitled_task') }}</div>
          <div class="row-meta">
            <span v-if="t.state" class="st" :class="'st-' + t.state">{{ stateLabel(t.state) }}</span>
            <span v-if="t.client">{{ clientLabel(t.client, t.form) }}</span>
            <span v-if="t.model">{{ t.model }}</span>
            <span>{{ fmtDuration(t.duration_ms) }}</span>
            <span v-if="t.file_count != null">{{ tr('records.n_files', { n: t.file_count }) }}</span>
          </div>
        </li>
        <li v-if="!list.length" class="empty-hint">{{ tr('records.list.empty') }}</li>
      </ul>

      <!-- 右：选中任务的详情 + 它的 subagent -->
      <section class="detail">
        <template v-if="tasks.selectedTask">
          <header class="detail-head">
            <!-- 详情标题 = 这一轮自己的用户输入；会话标题在下面的键值网格里单列一行 -->
            <div class="detail-title">{{ promptOf(tasks.selectedTask) || tr('records.untitled_task') }}</div>
            <div class="detail-meta">
              <span>{{ fmtTime(tasks.selectedTask.started_at) }}</span>
              <span v-if="tasks.selectedTask.ended_at">→ {{ fmtTime(tasks.selectedTask.ended_at) }}</span>
              <span>{{ fmtDuration(tasks.selectedTask.duration_ms) }}</span>
            </div>
          </header>

          <div class="kv">
            <!-- 会话标题（agent 摘要）：只对 6F/7F/8F 有值，拿到才列这一行 ——
                 其余楼层本来就没有这东西，不显示 "—" 占位（免得看着像"丢了"） -->
            <template v-if="sessionTitleOf(tasks.selectedTask)">
              <div class="k">{{ tr('records.detail.session_title') }}</div>
              <div class="v">{{ sessionTitleOf(tasks.selectedTask) }}</div>
            </template>
            <div class="k">{{ tr('records.detail.state') }}</div><div class="v">{{ stateLabel(tasks.selectedTask.state) }}</div>
            <!-- 「进度」暂时不显示（2026-09-29 用户要求注释掉）：progress 现在拿不到真值 ——
                 开工写 0、收工写 1，中间没人推进（唯一会推的是 hook 里"按 TodoWrite 清单
                 折算几项做完"那一条，见 reporter/hook.js 的 todoProgress，实测落不到库里）。
                 本机库实测：489 条任务的 progress 只有 0（80 条）和 1（409 条）两种取值，
                 一个中间值都没有 —— 显示出来就是「0% / 100%」两个数跳，纯误导。
                 将来有了能按轮次推进的真实进度来源，再把这一行放回来（fmtProgress 一并复活）。 -->
            <div class="k">{{ tr('records.detail.client') }}</div><div class="v">{{ clientLabel(tasks.selectedTask.client, tasks.selectedTask.form) }}</div>
            <div class="k">{{ tr('records.detail.model') }}</div><div class="v">{{ tasks.selectedTask.model || '—' }}</div>
            <!-- 工程：这一轮归属的工程名。服务端按工程**目录**现算（package.json name > 目录名，
                 与"打开工程"同一口径，见 /task-runs 的 project_label）；拿不到目录才退回库里的
                 projects.name（可能带同名冲突后缀，如 stb-dashboard-2），再没有退 project_id，
                 最后才写占位 —— 绝不编造 -->
            <div class="k">{{ tr('records.detail.project') }}</div>
            <div class="v">{{ tasks.selectedTask.project_label || tasks.selectedTask.project_name || tasks.selectedTask.project_id || '—' }}</div>
            <!-- 文件数挪到键值网格、与「模型」对齐；无改动（纯问答）显示 0 -->
            <div class="k">{{ tr('records.detail.tokens') }}</div>
            <div class="v" :title="tokenTitleOf(tasks.selectedTask)">{{ tokenQuadOf(tasks.selectedTask) }}</div>
            <div class="k">{{ tr('records.detail.files') }}</div>
            <div class="v v-bright">{{ filesOf(tasks.selectedTask).length || (tasks.selectedTask.file_count != null ? tasks.selectedTask.file_count : 0) }}</div>
            <!-- 本轮消耗的词元：三项摊开、用 " / " 隔开（2026-10-01 用户要求）——
                 `非缓存输入 / 缓存读输入 / 输出`，顺序与库里的列序一致
                 （「缓存写输入」2026-10-08 用户要求去掉：本机实测恒为 0，占一格不带信息），
                 鼠标悬停看这四个数各是什么。真值来自各楼层自己的会话落盘
                 （见 reporter/src/usage.js），拿不到的楼层（5F TraeCode 没有 usage、
                 6F Qoder 的 transcript 里没有、2F/9F 没接）显示 "—"，不显示 0 ——
                 「报不出来」和「消耗为零」是两回事。 -->
          </div>

          <div v-if="filesOf(tasks.selectedTask).length" class="files">

            <template v-if="addedFiles(tasks.selectedTask).length">
              <div class="cat">{{ tr('records.files.added', { n: addedFiles(tasks.selectedTask).length }) }}</div>
              <ul>
                <li v-for="(f, i) in addedFiles(tasks.selectedTask)" :key="'a' + i">
                  <span class="fp">{{ f.path }}</span>
                  <span v-if="f.size != null" class="sz">({{ fmtSize(f.size) }})</span>
                </li>
              </ul>
            </template>

            <template v-if="modifiedFiles(tasks.selectedTask).length">
              <div class="cat">{{ tr('records.files.modified', { n: modifiedFiles(tasks.selectedTask).length }) }}</div>
              <ul>
                <li v-for="(f, i) in modifiedFiles(tasks.selectedTask)" :key="'m' + i">
                  <span class="fp">{{ f.path }}</span>
                  <span v-if="f.size != null" class="sz">({{ fmtSize(f.size) }})</span>
                </li>
              </ul>
            </template>

            <template v-if="deletedFiles(tasks.selectedTask).length">
              <div class="cat">{{ tr('records.files.deleted', { n: deletedFiles(tasks.selectedTask).length }) }}</div>
              <ul>
                <li v-for="(f, i) in deletedFiles(tasks.selectedTask)" :key="'d' + i">
                  <span class="fp">{{ f.path }}</span>
                </li>
              </ul>
            </template>
          </div>

          <!-- 工具使用：这一轮每个工具用了几次（上报方逐次 +1，见 server/src/ingest/bus.js 的 toolUse） -->
          <div v-if="toolsOf(tasks.selectedTask).length" class="tools">
            <div class="files-head">{{ tr('records.detail.tools') }}</div>
            <ul class="tool-list">
              <li v-for="(t, i) in toolsOf(tasks.selectedTask)" :key="'tool' + i" class="tool-item">
                <span class="tool-name">{{ t.tool }}</span>
                <span class="tool-count">{{ tr('records.detail.tools_times', { n: t.count }) }}</span>
              </li>
            </ul>
          </div>

          <div class="result-block">
            <div class="files-head">{{ tr('records.detail.result') }}</div>
            <div v-if="tasks.selectedTask.result" class="result-md" v-html="md(tasks.selectedTask.result)"></div>
            <p v-else class="result">{{ tr('records.none_paren') }}</p>
          </div>

          <!-- subagent 列表：点击单个看详情 -->
          <div v-if="tasks.subagents.length" class="subs">
            <div class="files-head">{{ tr('records.detail.subagents', { n: tasks.subagents.length }) }}</div>
            <ul class="sub-list">
              <li
                v-for="s in tasks.subagents"
                :key="s.id"
                class="sub-item"
                :class="{ on: expandedSub === s.id }"
              >
                <button class="sub-btn" @click="toggleSub(s.id)">
                  <span class="sub-name">{{ s.name }}</span>
                  <span class="sub-sub">{{ s.title || tr('records.sub_untitled') }}</span>
                  <span class="sub-dur">{{ fmtDuration(s.duration_ms) }}</span>
                </button>
                <div v-if="expandedSub === s.id" class="sub-detail">
                  <div class="kv">
                    <div class="k">{{ tr('records.detail.sub_name') }}</div><div class="v">{{ s.name }}</div>
                    <div class="k">{{ tr('records.detail.sub_task') }}</div><div class="v">{{ s.title || tr('records.sub_untitled') }}</div>
                    <div class="k">{{ tr('records.detail.client') }}</div><div class="v">{{ clientLabel(s.client) }}</div>
                    <div class="k">{{ tr('records.detail.model') }}</div><div class="v">{{ s.model || '—' }}</div>
                    <div class="k">{{ tr('records.detail.sub_start') }}</div><div class="v">{{ fmtTime(s.started_at) }}</div>
                    <div class="k">{{ tr('records.detail.sub_end') }}</div><div class="v">{{ fmtTime(s.ended_at) }}</div>
                    <div class="k">{{ tr('records.detail.sub_duration') }}</div><div class="v">{{ fmtDuration(s.duration_ms) }}</div>
                    <div class="k">{{ tr('records.detail.sub_in_tokens') }}</div><div class="v">{{ fmtTokens(s.input_tokens) }}</div>
                    <div class="k">{{ tr('records.detail.sub_out_tokens') }}</div><div class="v">{{ fmtTokens(s.output_tokens) }}</div>
                  </div>
                  <div v-if="filesOf(s).length" class="files">
                    <div class="files-head">{{ tr('records.detail.sub_files') }}</div>

                    <template v-if="addedFiles(s).length">
                      <div class="cat">{{ tr('records.files.added', { n: addedFiles(s).length }) }}</div>
                      <ul>
                        <li v-for="(f, i) in addedFiles(s)" :key="'a' + i">
                          <span class="fp">{{ f.path }}</span>
                          <span v-if="f.size != null" class="sz">({{ fmtSize(f.size) }})</span>
                        </li>
                      </ul>
                    </template>

                    <template v-if="modifiedFiles(s).length">
                      <div class="cat">{{ tr('records.files.modified', { n: modifiedFiles(s).length }) }}</div>
                      <ul>
                        <li v-for="(f, i) in modifiedFiles(s)" :key="'m' + i">
                          <span class="fp">{{ f.path }}</span>
                          <span v-if="f.size != null" class="sz">({{ fmtSize(f.size) }})</span>
                        </li>
                      </ul>
                    </template>

                    <template v-if="deletedFiles(s).length">
                      <div class="cat">{{ tr('records.files.deleted', { n: deletedFiles(s).length }) }}</div>
                      <ul>
                        <li v-for="(f, i) in deletedFiles(s)" :key="'d' + i">
                          <span class="fp">{{ f.path }}</span>
                        </li>
                      </ul>
                    </template>
                  </div>
                  <div class="result-block">
                    <div class="files-head">{{ tr('records.detail.sub_result') }}</div>
                    <div v-if="s.result" class="result-md" v-html="md(s.result)"></div>
                    <p v-else class="result">{{ tr('records.none_paren') }}</p>
                  </div>
                </div>
              </li>
            </ul>
          </div>
          <div v-else-if="tasks.selectedTask.subagentCount" class="dim loading">{{ tr('records.loading_subagents') }}</div>
        </template>
      </section>
    </div>

    <!-- 批量操作：删除筛选结果（手动）/ 记录保留天数（服务端自动清理）；仅列表视图，位于列表页底部 -->
    <div class="bulk-bar" v-if="view === 'list'">
      <span class="dim">{{ tr('records.bulk_ops') }}</span>
      <button type="button" class="del-btn danger" @click="bulkDeleteAll">{{ tr('records.bulk_delete') }}</button>
      <span class="dim">{{ tr('records.retention_before') }}</span>
      <input v-model.number="retentionDays" class="days" type="number" min="1" max="3650" :aria-label="tr('records.retention_aria')" />
      <span class="dim">{{ tr('records.retention_after') }}</span>
      <button type="button" class="btn" @click="saveRetention">{{ tr('records.retention_save') }}</button>
    </div>

    <!-- 汇总报表：按维度聚合的表格；共享上方筛选栏条件 -->
    <div v-else-if="view === 'summary'" class="report">
      <div class="report-bar">
        <div class="dim-tabs">
          <button
            v-for="d in DIMS"
            :key="d.key"
            type="button"
            class="view-tab"
            :class="{ on: reportDim === d.key }"
            @click="reportDim = d.key"
          >{{ tr(d.label) }}</button>
        </div>
        <button type="button" class="btn export" @click="exportCsv">{{ tr('records.export') }}</button>
      </div>

      <!-- 按时间：逐条列任务（不聚合），列 = 时间 / 任务 / 客户端 / 模型 / 工程 / 词元 / 时长 / 状态 -->
      <div v-if="reportDim === 'time' && timeRows.length" class="report-scroll">
        <table class="report-table">
          <thead>
            <tr>
              <th class="th-dim sortable" :class="timeSortCls('started_at')" @click="sortTimeBy('started_at')">{{ tr('records.col.time') }}</th>
              <th class="th-dim">{{ tr('records.col.task') }}</th>
              <!-- 会话：这一轮属于哪条会话（会话级标题，同一会话的各轮共用同一个值）——
                   拿不到（老任务没有 session_id / 服务端查不到）显示 "—"，不编造 -->
              <th class="th-dim">{{ tr('records.col.session') }}</th>
              <th class="th-dim">{{ tr('records.col.client') }}</th>
              <th class="th-dim">{{ tr('records.col.model') }}</th>
              <th class="th-dim">{{ tr('records.col.project') }}</th>
              <!-- 一行一个任务，这一列 = **这条任务的总词元**（三项全加，见 totalTokensOf）。
                   悬停看三项拆分；报不出 token 的楼层显示 "—"（不是 0）。 -->
              <th class="sortable num" :class="timeSortCls('tokens')" @click="sortTimeBy('tokens')" :title="tr('records.col.tokens_title')">{{ tr('records.col.tokens') }}</th>
              <th class="sortable num" :class="timeSortCls('duration_ms')" @click="sortTimeBy('duration_ms')">{{ tr('records.col.duration') }}</th>
              <th class="th-dim">{{ tr('records.col.state') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in timeRows" :key="t.id" class="report-row" @click="drillDown(t)">
              <td class="td-dim mono">{{ fmtTime(t.started_at) }}</td>
              <!-- 标题只取前 10 个字，完整的那句挂在 title 上（悬停可看） -->
              <td class="td-dim td-task" :title="promptOf(t) || tr('records.untitled_task')">{{ shortTitle(t) }}</td>
              <td class="td-dim td-session" :title="sessionTitleOf(t) || ''">{{ sessionTitleOf(t) ? shortText(sessionTitleOf(t)) : '—' }}</td>
              <td class="td-dim">{{ clientLabel(t.client, t.form) }}</td>
              <td class="td-dim">{{ t.model || '—' }}</td>
              <td class="td-dim">{{ projectOf(t) }}</td>
              <td class="num" :title="tokenTitleOf(t)">{{ fmtTokens(totalTokensOf(t)) }}</td>
              <td class="num">{{ fmtDuration(t.duration_ms) }}</td>
              <td class="td-dim" :class="'st-' + t.state">{{ stateLabel(t.state) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="total-row">
              <td class="td-dim">{{ tr('records.total') }}</td>
              <td class="td-dim">{{ tr('records.times', { n: timeRows.length }) }}</td>
              <!-- 会话数：这一屏涉及多少条**不同**的会话（不是任务数） -->
              <td class="num">{{ timeSessionCount }}</td>
              <td class="td-dim" />
              <td class="td-dim" />
              <td class="td-dim" />
              <!-- 合计只累加报得出 token 的任务；一条都没有 → "—"（不拿 0 顶） -->
              <td class="num">{{ fmtTokens(timeTotalTokens) }}</td>
              <td class="num">{{ fmtDuration(timeTotalMs) }}</td>
              <td class="td-dim" />
            </tr>
          </tfoot>
        </table>
      </div>

      <div v-else-if="reportDim !== 'time' && reportGroups.length" class="report-scroll">
        <table class="report-table">
          <thead>
            <tr>
              <th class="th-dim">{{ dimColName }}</th>
              <th class="sortable num" :class="sortCls('taskCount')" @click="sortBy('taskCount')">{{ tr('records.col.task_count') }}</th>
              <!-- 会话数：这一组里有多少条**不同**的会话（一轮 = 一条任务，所以它通常远小于任务数）；
                   没有 session_id 的老任务只进任务数，不撑会话数 -->
              <th class="sortable num" :class="sortCls('sessionCount')" @click="sortBy('sessionCount')" :title="tr('records.col.session_count')">{{ tr('records.col.session_count') }}</th>
              <th class="sortable num" :class="sortCls('successCount')" @click="sortBy('successCount')">{{ tr('records.col.success_count') }}</th>
              <th class="sortable num" :class="sortCls('cancelCount')" @click="sortBy('cancelCount')">{{ tr('records.col.cancel_count') }}</th>
              <th class="sortable num" :class="sortCls('fileCount')" @click="sortBy('fileCount')">{{ tr('records.col.file_count') }}</th>
              <!-- 词元合计 = 这一组里**报得出 token 的那些任务**的四项全加（与「数据总览」表尾同一口径） -->
              <th class="sortable num" :class="sortCls('tokenSum')" @click="sortBy('tokenSum')" :title="tr('records.col.token_sum_title')">{{ tr('records.col.token_sum') }}</th>
              <th class="sortable num" :class="sortCls('durationSum')" @click="sortBy('durationSum')">{{ tr('records.col.duration_sum') }}</th>
              <th class="sortable num" :class="sortCls('avgDuration')" @click="sortBy('avgDuration')">{{ tr('records.col.avg_duration') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in reportSorted"
              :key="r.key"
              class="report-row"
              @click="drillDown(r)"
            >
              <td class="td-dim">{{ r.label }}</td>
              <td class="num">{{ r.taskCount }}</td>
              <td class="num">{{ r.sessionCount }}</td>
              <td class="num">{{ r.successCount }}</td>
              <td class="num">{{ r.cancelCount }}</td>
              <td class="num">{{ r.fileCount }}</td>
              <!-- 一条都没报出 token 的组显示 "—"（不是 0 ——「报不出来」与「消耗为零」是两回事） -->
              <td class="num">{{ fmtTokens(r.tokenN ? r.tokenSum : null) }}</td>
              <td class="num">{{ fmtDuration(r.durationSum) }}</td>
              <td class="num">{{ fmtDuration(r.avgDuration) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="total-row">
              <td class="td-dim">{{ reportTotal.label }}</td>
              <td class="num">{{ reportTotal.taskCount }}</td>
              <!-- 合计的会话数是各组**去重后的并集**，不是把各组会话数加起来 -->
              <td class="num">{{ reportTotal.sessionCount }}</td>
              <td class="num">{{ reportTotal.successCount }}</td>
              <td class="num">{{ reportTotal.cancelCount }}</td>
              <td class="num">{{ reportTotal.fileCount }}</td>
              <td class="num">{{ fmtTokens(reportTotal.tokenN ? reportTotal.tokenSum : null) }}</td>
              <td class="num">{{ fmtDuration(reportTotal.durationSum) }}</td>
              <td class="num">{{ fmtDuration(reportTotal.avgDuration) }}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div v-else class="empty-pane">
        <span class="dim">{{ tr('records.empty') }}</span>
      </div>
    </div>

    <!-- 图形看板 · 每日：横轴＝当天每小时的竖线，纵轴＝楼层；行里的实心块就是这一层的一次任务 -->
    <div v-else class="board">
      <!-- 翻页与选日期都限制在顶部的时间筛选窗口里（选中「今天」就只有今天可看） -->
      <div class="board-bar">
        <button
          type="button"
          class="btn"
          :disabled="!canShiftDay(-1)"
          :title="canShiftDay(-1) ? tr('records.board.prev') : tr('records.board.prev_out', { range: filterTimeLabel })"
          @click="shiftDay(-1)"
        >← {{ tr('records.board.prev') }}</button>
        <input
          class="day-input"
          type="date"
          :value="boardDayValue"
          :min="boardDayMin"
          :max="boardDayMax"
          :title="tr('records.board.range_aria', { range: filterTimeLabel })"
          :aria-label="tr('records.board.date_aria')"
          @change="onBoardDayInput"
        />
        <span class="day-label">
          {{ fmtDay(boardDay) }}<span v-if="boardIsToday" class="dim">{{ tr('records.board.today_suffix') }}</span>
        </span>
        <button
          type="button"
          class="btn"
          :disabled="!canShiftDay(1)"
          :title="canShiftDay(1) ? tr('records.board.next') : tr('records.board.next_out', { range: filterTimeLabel })"
          @click="shiftDay(1)"
        >{{ tr('records.board.next') }} →</button>
        <button
          type="button"
          class="btn"
          :disabled="boardIsToday || !canBackToToday"
          :title="canBackToToday ? tr('records.board.today_back') : tr('records.board.today_out', { range: filterTimeLabel })"
          @click="backToToday"
        >{{ tr('records.board.today') }}</button>
        <span class="spacer" />
        <span class="legend">
          <i class="dot st-running" />{{ tr('records.board.legend_running') }}
          <i class="dot st-done" />{{ tr('records.board.legend_done') }}
          <i class="dot st-failed" />{{ tr('records.board.legend_failed') }}
          <i class="dot st-cancelled" />{{ tr('records.board.legend_cancelled') }}
          <i class="dot st-pending" />{{ tr('records.board.legend_pending') }}
        </span>
      </div>

      <div class="board-scroll">
        <div class="gantt">
          <!-- 表头：每小时一格刻度，格子左边那条竖线就是小时线 -->
          <div class="gantt-head">
            <div class="gutter" />
            <div class="axis">
              <div v-for="h in HOUR_COLS" :key="h" class="tick">{{ fmtHM((h - 1) * 60) }}</div>
            </div>
          </div>

          <div v-for="row in boardRows" :key="row.key" class="gantt-row">
            <div class="gutter" :title="row.label">{{ row.label }}</div>
            <div class="lane-area" :style="{ height: `${LANE_H}px` }">
              <div
                v-if="boardNowPct >= 0"
                class="now-line"
                :style="{ left: `${boardNowPct}%` }"
                :title="tr('office.tip.now')"
              />
              <button
                v-for="it in row.items"
                :key="it.task.id"
                type="button"
                class="block"
                :class="`st-${it.task.state || 'pending'}`"
                :style="{
                  left: `${it.left}%`,
                  width: `${it.width}%`,
                  top: '2px',
                  height: `${LANE_H - 4}px`,
                }"
                :title="blockTitle(it)"
                @click="openTask(it.task.id)"
              />
              <!-- 同一时间不止一条：叠一层暗色（不是再占一行） -->
              <span
                v-for="(o, i) in row.overlaps"
                :key="`o${i}`"
                class="overlap"
                :style="{
                  left: `${o.left}%`,
                  width: `${o.width}%`,
                  top: '2px',
                  height: `${LANE_H - 4}px`,
                  background: `rgba(0, 0, 0, ${scrimAlpha(o.count)})`,
                }"
              />
            </div>
          </div>

          <!-- 这一天没有任务：照样把表格画出来（空行 + 小时线），不留一块"没有任务"的提示板 -->
          <div v-if="!boardRows.length" class="gantt-row">
            <div class="gutter" />
            <div class="lane-area empty" :style="{ height: `${LANE_H * 3}px` }">
              <div
                v-if="boardNowPct >= 0"
                class="now-line"
                :style="{ left: `${boardNowPct}%` }"
                :title="tr('office.tip.now')"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="board-foot dim">
        <!-- 没有任务的日子不写"任务 0 次"这类话：空表格本身就说清楚了（所以这里看的是 task 数，不是行数） -->
        <template v-if="boardGantt.total">
          <span>{{ tr('records.board.sum_tasks', { n: boardGantt.total }) }}</span>
          <span class="sep">·</span>
          <span>{{ tr('records.board.sum_floors', { n: boardRows.length }) }}</span>
          <template v-if="boardGantt.firstMin >= 0">
            <span class="sep">·</span>
            <span>{{ tr('records.board.active_window', { from: fmtHM(boardGantt.firstMin), to: fmtHM(boardGantt.lastMin) }) }}</span>
          </template>
        </template>
        <template v-if="boardGantt.untimed">
          <span v-if="boardGantt.total" class="sep">·</span>
          <span>{{ tr('records.board.untimed', { n: boardGantt.untimed }) }}</span>
        </template>
        <span class="spacer" />
        <span>{{ tr('records.board.hint') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
}
.dim { color: var(--text-dim); font-size: 12px; }
.loading { color: var(--accent); }
/* 弹性占位：把筛选控件组整体顶到右侧 */
.spacer { flex: 1; }
/* 计数：固定宽度 + 右对齐 + 等宽数字，避免数字位数变化引发水平抖动 */
.count { flex: 0 0 100px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }

/* 三视图切换 */
.view-tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.view-tab {
  font: inherit;
  font-size: 13px;
  color: var(--text-dim);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 5px 14px;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.view-tab:hover { color: var(--text); border-color: var(--accent); }
.view-tab.on { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }

/* 空面板：某个视图当前没有内容可画时用它兜底 */
.empty-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel);
}

/* 图形看板 · 每日：纵轴＝楼层（一层一行），横轴＝当天每小时一条竖线 */
.board {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
}
.board-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.day-label { font-size: 13px; color: var(--text); white-space: nowrap; }
.day-input {
  padding: 2px 6px;
  font-size: 12px;
  line-height: 1.6;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated, #2a2f3a);
  color: var(--text);
  font-family: var(--mono);
}
.day-input:hover { border-color: var(--accent); }
/* 图例：色块与块、左边那条状态色一致（色值来自列表视图的 .st-* 那一套） */
.legend { display: flex; align-items: center; gap: 4px 10px; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); }
.legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
.legend .dot.st-running { background: var(--accent); }
.legend .dot.st-done { background: #7ee787; }
.legend .dot.st-failed { background: #ff7b72; }
.legend .dot.st-cancelled { background: var(--state-offline, #4a5160); }
.legend .dot.st-pending { background: var(--state-idle, #7f8c9b); }
.board-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel);
  padding: 10px 12px 12px;
}
/* 窄窗口下不让 24 小时挤成一团（每小时至少 ~36px）：放不下就横向滚动 */
.gantt { min-width: 960px; }
.gantt-head { display: flex; }
/* 左侧楼层名（每行一个），宽度固定，右侧时间轴才对得齐。
   124px 是为了放得下最长的那个名字（「9F GitHub Copilot」），再窄就要靠 title 提示了 */
.gutter {
  flex: none;
  width: 124px;
  padding-right: 8px;
  text-align: right;
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gantt-head .gutter { height: 18px; }
.axis { flex: 1; min-width: 0; display: flex; }
.tick {
  flex: 1 1 0;
  min-width: 0;
  padding-left: 3px;
  font-size: 10px;
  line-height: 18px;
  color: var(--text-faint);
  font-family: var(--mono);
  border-left: 1px solid var(--border);
}
.gantt-row { display: flex; }
.gantt-row .gutter { padding-top: 1px; line-height: 1.2; }
/**
 * 一层一行：每小时一条竖线（1px 的线平铺，平铺宽度 = 容器宽 / 24），块绝对定位落在上面。
 * 不用 repeating-linear-gradient 的 calc 停靠点 —— 那个写法一旦被解析器判无效，整条
 * background-image 会静默失效（小时线全没了，还不报错）。背景平铺这套没有这个坑。
 */
.lane-area {
  position: relative;
  flex: 1;
  min-width: 0;
  border-top: 1px solid var(--border);
  background-image: linear-gradient(to right, var(--border) 0 1px, transparent 1px);
  background-size: calc(100% / 24) 100%;
  background-repeat: repeat-x;
}
/* 没有任务的那一天：只留这张空表格（底下补一条边把表收口） */
.lane-area.empty { border-bottom: 1px solid var(--border); }
.block {
  position: absolute;
  box-sizing: border-box;
  /* 至少 3px：左右各 1px 竖边之外还留 1px 的颜色，短任务也看得出是块不是线 */
  min-width: 3px;
  padding: 0;
  border: 0;
  /* 左右两条竖边：相邻任务贴在一起时，这两条边就是"任务之间的分割线" */
  border-left: 1px solid rgba(0, 0, 0, 0.55);
  border-right: 1px solid rgba(0, 0, 0, 0.55);
  border-radius: 2px;
  cursor: pointer;
  /* 兜底色：万一 state 是没见过的值，块也照样看得见（不给它凭空消失的机会） */
  background: var(--state-idle, #7f8c9b);
}
.block:hover { filter: brightness(1.18); }
.block.st-running { background: var(--accent); }
.block.st-done { background: #7ee787; }
.block.st-failed { background: #ff7b72; }
.block.st-cancelled { background: var(--state-offline, #4a5160); }
.block.st-pending { background: var(--state-idle, #7f8c9b); }
/**
 * 同一时间并行的那一段：盖一层暗色（不是再占一行）。最深压到 0.6，不糊成一块黑。
 * 不吃鼠标事件 —— 悬停还是落在下面那块任务上（照样出任务标题）。
 */
.overlap {
  position: absolute;
  border-radius: 2px;
  pointer-events: none;
}
.now-line {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px dashed var(--accent);
  opacity: 0.75;
  pointer-events: none;
}
.board-foot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
.board-foot .sep { color: var(--text-faint); }

/* 汇总报表 */
.report {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
}
.report-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.dim-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.btn.export { border-color: var(--accent); color: var(--accent); }
.btn.export:hover { background: var(--accent-soft); }
.report-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel);
}
.report-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.report-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-weight: 600;
  text-align: right;
  padding: 8px 12px;
  white-space: nowrap;
  border-bottom: 1px solid var(--border);
}
.report-table thead th.th-dim { text-align: left; }
.report-table th.sortable { cursor: pointer; user-select: none; }
.report-table th.sortable:hover { color: var(--text); }
.report-table th.sortable.active { color: var(--accent); }
.report-table th.sortable.active.desc::after { content: ' ▼'; }
.report-table th.sortable.active.asc::after { content: ' ▲'; }
.report-table td {
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  color: var(--text);
  text-align: right;
}
.report-table td.td-dim { text-align: left; }
.report-table .num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
/* 数据总览那一版：时间列用等宽字体（一列数字对得齐），任务列限宽 + 省略号（前 10 个字） */
.report-table td.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.report-table td.td-task { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 会话列：跟任务列同一套限宽 + 省略号，别把右边的客户端 / 模型挤出去 */
.report-table td.td-session { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 状态色：`.report-table td` 的 color 比 .st-* 更具体，不单独写一遍的话状态就全是白的 */
.report-table td.st-running { color: var(--accent); }
.report-table td.st-done { color: #7ee787; }
.report-table td.st-failed { color: #ff7b72; }
.report-table td.st-cancelled { color: var(--text-faint); }
.report-table td.st-pending { color: var(--text-dim); }
.report-row { cursor: pointer; transition: background 0.12s; }
.report-row:hover { background: var(--bg-elevated); }
.total-row td {
  font-weight: 600;
  background: var(--bg-elevated);
  border-top: 2px solid var(--border);
}

.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.sel {
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 4px 8px;
  max-width: 200px;
}
.sel:focus { outline: none; border-color: var(--accent); }
.search {
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 4px 10px;
  min-width: 140px;
  flex: 0 1 200px;
}
.search:focus { outline: none; border-color: var(--accent); }
.search::placeholder { color: var(--text-faint); }

.body {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) 1.3fr;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

.task-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel);
}
.task-row {
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.12s;
}
.task-row:hover { background: var(--bg-elevated); }
.task-row.on { background: var(--accent-soft); }
.task-row.empty { padding: 0; }
.row-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.time { color: var(--text-faint); font-size: 12px; font-family: var(--mono); }
.badge {
  font-size: 11px;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 999px;
  padding: 1px 7px;
}
.row-title {
  margin-top: 3px;
  font-size: 14px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-meta {
  margin-top: 3px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim);
}
.st { padding: 0 6px; border-radius: 999px; border: 1px solid var(--border); }
.st-running { color: var(--accent); border-color: var(--accent); }
.st-done { color: #7ee787; border-color: #7ee787; }
.st-failed { color: #ff7b72; border-color: #ff7b72; }
.st-cancelled { color: var(--text-faint); }
.st-pending { color: var(--text-dim); }
.empty-hint { padding: 20px; text-align: center; color: var(--text-dim); }

.detail {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel);
  padding: 14px 16px;
  overflow-y: auto;
  min-height: 0;
  /* 详情页是"给人读、给人复制"的（任务原话 / 文件清单 / 报错），全局禁选在这里放开 */
  -webkit-user-select: text;
  user-select: text;
}
.detail.empty-detail {
  display: flex;
  align-items: center;
  justify-content: center;
}
.detail-head { border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 10px; }
.detail-title { font-size: 16px; color: var(--text); }
.detail-meta { margin-top: 4px; display: flex; gap: 10px; font-size: 12px; color: var(--text-dim); font-family: var(--mono); }

.kv {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 4px 12px;
  font-size: 13px;
}
.kv .k { color: var(--text-faint); }
.kv .v { color: var(--text); font-family: var(--mono); word-break: break-all; }
/* 文件数量：亮白色 + 加粗，与上方各值区分 */
.kv .v.v-bright { color: #fff; font-weight: 600; }

.files { margin-top: 12px; }
.files-head { font-size: 12px; color: var(--text-dim); margin-bottom: 5px; letter-spacing: 0.5px; }
.files .cat { font-size: 12px; color: var(--text); margin: 8px 0 3px; font-weight: 600; }
.files ul { margin: 0; padding-left: 18px; }
.files li { font-size: 12px; color: var(--text-dim); font-family: var(--mono); display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.files li .fp { word-break: break-all; }
.files li .sz { color: var(--text-faint); font-variant-numeric: tabular-nums; }

/* 工具使用：名字在左、次数在右（次数等宽数字，一列对齐好扫） */
.tools { margin-top: 12px; }
.tool-list { list-style: none; margin: 4px 0 0; padding: 0; }
.tool-item {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
  color: var(--text-dim);
  font-family: var(--mono);
  padding: 2px 0;
}
/* 工具名用亮白色，次数留暗色 —— 一眼看到"用了哪些工具"，次数是次要信息 */
.tool-item .tool-name { word-break: break-all; color: #fff; }
.tool-item .tool-count { color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }

.result-block { margin-top: 12px; }
.result { margin: 0; font-size: 13px; color: var(--text); line-height: 1.6; white-space: pre-wrap; }
/* 「产出摘要」markdown 渲染（见 md()）：清单里的 HTML 标签只在这块内生效，不影响别处 */
.result-md { font-size: 13px; color: var(--text); line-height: 1.6; word-break: break-word; }
.result-md > :first-child { margin-top: 0; }
.result-md > :last-child { margin-bottom: 0; }
.result-md h1, .result-md h2, .result-md h3, .result-md h4, .result-md h5, .result-md h6 { margin: 10px 0 6px; line-height: 1.3; font-weight: 600; }
.result-md h1 { font-size: 1.25em; }
.result-md h2 { font-size: 1.15em; }
.result-md h3 { font-size: 1.05em; }
.result-md p { margin: 6px 0; }
.result-md ul, .result-md ol { margin: 6px 0; padding-left: 22px; }
.result-md li { margin: 2px 0; }
.result-md code { font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 0.92em; background: var(--bg-sunken, #1f2430); padding: 1px 5px; border-radius: 4px; }
.result-md pre { background: var(--bg-sunken, #1f2430); padding: 10px 12px; border-radius: 8px; overflow: auto; margin: 8px 0; }
.result-md pre code { background: none; padding: 0; font-size: 0.9em; }
.result-md blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid var(--border, #2a3142); color: var(--text-faint); }
.result-md a { color: var(--accent, #6ea8fe); text-decoration: none; }
.result-md a:hover { text-decoration: underline; }
.result-md table { border-collapse: collapse; margin: 8px 0; }
.result-md th, .result-md td { border: 1px solid var(--border, #2a3142); padding: 4px 8px; }
.result-md hr { border: none; border-top: 1px solid var(--border, #2a3142); margin: 10px 0; }
.result-md img { max-width: 100%; }

.subs { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 10px; }
.sub-list { list-style: none; margin: 6px 0 0; padding: 0; }
.sub-item { border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 6px; overflow: hidden; }
.sub-item.on { border-color: var(--accent); }
.sub-btn {
  width: 100%;
  display: grid;
  grid-template-columns: 120px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: transparent;
  border: 0;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}
.sub-btn:hover { background: var(--bg-elevated); }
.sub-name { font-weight: 600; color: var(--accent); }
.sub-sub { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub-dur { color: var(--text-faint); font-family: var(--mono); font-size: 12px; }
.sub-detail { padding: 10px 12px; border-top: 1px solid var(--border); background: var(--bg-elevated); }

/* 批量删除工具条 */
.bulk-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 2px;
  margin-top: 4px;
  border-top: 1px solid var(--border);
}
.days {
  width: 64px;
  padding: 3px 6px;
  background: var(--bg-input, var(--bg-elevated));
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-family: var(--mono);
}
.btn {
  padding: 2px 10px;
  font-size: 12px;
  line-height: 1.6;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated, #2a2f3a);
  color: var(--text);
  cursor: pointer;
}
.btn:hover { border-color: var(--accent); }
/* 置灰的按钮（看板翻页被时间筛选卡住时）：光靠 disabled 不够 —— 上面写死了
   background / color，会把浏览器默认的置灰样式盖掉，看着跟能点一样 */
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn:disabled:hover { border-color: var(--border); }

/* 删除按钮（单条 + 批量通用） */
.del-btn {
  padding: 2px 8px;
  font-size: 11px;
  line-height: 1.6;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.del-btn:hover { color: var(--text); border-color: var(--text-dim); }
.del-btn.danger { color: #ff7b72; border-color: rgba(255, 123, 114, 0.4); }
.del-btn.danger:hover { background: rgba(255, 123, 114, 0.12); }
.del-btn.confirm {
  color: #fff;
  background: #da3633;
  border-color: #da3633;
}
.del-btn.confirm:hover { background: #f85149; }
.row-actions { display: inline-flex; align-items: center; gap: 8px; }
.row-top { display: flex; justify-content: space-between; align-items: center; }
</style>