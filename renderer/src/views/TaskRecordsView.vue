<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useProjectStore } from '../stores/project';
import { useSessionStore } from '../stores/sessions';
import { useTaskStore } from '../stores/tasks';
import { clientLabel } from '../lib/clientMatch';
import { clientBase } from '@workgremlin/shared';
import { httpBase } from '../api/bridge';

const project = useProjectStore();
const session = useSessionStore();
const tasks = useTaskStore();

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

/** 每 4s 轮询一次（任务/ subagent 是低频事件，轮询足够，不必挂 WS） */
const POLL_MS = 4000;
let timer = null;

function start() {
  tasks.fetchTasks();
  if (timer) clearInterval(timer);
  timer = setInterval(() => tasks.fetchTasks(), POLL_MS);
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
const STATE_LABEL = { all: '全部', pending: '待命', running: '运行中', done: '完成', failed: '失败', cancelled: '已取消' };
function stateLabel(s) {
  return STATE_LABEL[s] || s || '—';
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

/** 三个并列视图，共享上方筛选条件：列表视图（默认）/ 汇总报表 / 图形看板 */
const VIEWS = [
  { key: 'list', label: '列表视图' },
  { key: 'summary', label: '汇总报表' },
  { key: 'board', label: '图形看板' },
];
const view = ref('list');

// 模型无专属下拉，留给“汇总报表”点行下钻时用的客户端筛选（默认空=不过滤，不影响列表视图现有逻辑）
const filterModel = ref('');

const list = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  const fm = filterModel.value;
  return (tasks.tasks || []).filter((t) => {
    if (filterState.value !== 'all' && t.state !== filterState.value) return false;
    if (kw && !promptOf(t).toLowerCase().includes(kw)) return false;
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
const DIMS = [
  { key: 'project', label: '按工程' },
  { key: 'model', label: '按模型' },
  { key: 'floor', label: '按楼层' },
];
const DIM_COL = { project: '工程', model: '模型', floor: '楼层' };
const reportDim = ref('project');
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
  if (dim === 'project') return (projectOptions.value.find((p) => p.id === t.project_id) || {}).name || t.project_id || '(未命名工程)';
  if (dim === 'model') return t.model || '(未记录)';
  if (dim === 'floor') {
    const f = floorOfClient(t.client);
    if (f) return f.name;
    return t.client ? clientLabel(t.client) : '(未记录)';
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
      g = { key: k, label: dimLabel(t, dim), taskCount: 0, successCount: 0, cancelCount: 0, fileCount: 0, durationSum: 0, durN: 0 };
      map.set(k, g);
    }
    g.taskCount += 1;
    if (t.state === 'done') g.successCount += 1;
    else if (t.state === 'cancelled') g.cancelCount += 1;
    g.fileCount += Number(t.file_count) || 0;
    const d = Number(t.duration_ms) || 0;
    if (d > 0) { g.durationSum += d; g.durN += 1; }
  }
  return [...map.values()].map((g) => {
    const avgDuration = g.durN ? g.durationSum / g.durN : 0;
    return { ...g, avgDuration };
  });
});
const reportTotal = computed(() => {
  const a = reportGroups.value.reduce(
    (s, g) => ({
      taskCount: s.taskCount + g.taskCount,
      successCount: s.successCount + g.successCount,
      cancelCount: s.cancelCount + g.cancelCount,
      fileCount: s.fileCount + g.fileCount,
      durationSum: s.durationSum + g.durationSum,
      durN: s.durN + g.durN,
    }),
    { taskCount: 0, successCount: 0, cancelCount: 0, fileCount: 0, durationSum: 0, durN: 0 }
  );
  const avgDuration = a.durN ? a.durationSum / a.durN : 0;
  return { label: '合计', taskCount: a.taskCount, successCount: a.successCount, cancelCount: a.cancelCount, fileCount: a.fileCount, avgDuration };
});
const reportSorted = computed(() => {
  const rows = reportGroups.value.slice();
  const { key, dir } = reportSort.value;
  if (key) rows.sort((x, y) => (dir === 'asc' ? x[key] - y[key] : y[key] - x[key]));
  return rows;
});
const dimColName = computed(() => DIM_COL[reportDim.value] || '维度');
function sortBy(key) {
  if (reportSort.value.key === key) reportSort.value.dir = reportSort.value.dir === 'asc' ? 'desc' : 'asc';
  else reportSort.value = { key, dir: 'desc' };
}
function sortCls(key) {
  const s = reportSort.value;
  return { active: s.key === key, asc: s.key === key && s.dir === 'asc', desc: s.key === key && s.dir === 'desc' };
}
/** 点报表行：切到列表视图并按该行维度值筛选（工程/楼层走服务端筛选，模型/Agent 走客户端筛选） */
function drillDown(row) {
  const dim = reportDim.value;
  filterModel.value = '';
  if (dim === 'project') { tasks.filterProject = row.key || 'all'; tasks.filterClient = 'all'; }
  else if (dim === 'floor') { tasks.filterClient = row.key || 'all'; tasks.filterProject = 'all'; }
  else if (dim === 'model') { filterModel.value = row.key; }
  view.value = 'list';
}
/** 导出报表为 CSV（客户端 Blob 下载，含当前排序与合计行） */
function exportCsv() {
  const dimLabelNow = (DIMS.find((d) => d.key === reportDim.value) || {}).label || '';
  const head = ['维度', '任务数', '成功数', '取消数', '改动文件数', '总耗时(ms)', '平均耗时(ms)'];
  const rows = reportSorted.value.map((r) => [
    r.label, r.taskCount, r.successCount, r.cancelCount, r.fileCount,
    Math.round(r.durationSum), Math.round(r.avgDuration),
  ]);
  const totalLine = [
    reportTotal.value.label, reportTotal.value.taskCount, reportTotal.value.successCount,
    reportTotal.value.cancelCount, reportTotal.value.fileCount,
    Math.round(reportTotal.value.durationSum), Math.round(reportTotal.value.avgDuration),
  ];
  rows.push(totalLine);
  const csv = [head, ...rows]
    .map((line) => line.map((c) => {
      const s = String(c);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
    .join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `汇总报表_${dimLabelNow}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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

/** 批量删除：删除当前筛选（工程/楼层）下的全部记录（手动、立即生效） */
function bulkDeleteAll() {
  const n = tasks.tasks.length;
  if (!window.confirm(`将删除当前筛选（工程/楼层）下的全部 ${n} 条任务记录，含其 subagent 与产出，此操作不可撤销。确认？`)) return;
  tasks.deleteByFilter('all');
}
/** 记录保留天数：服务端按此自动清理更早的任务记录（改动才写回，不轮询） */
const retentionDays = ref(30);
async function loadRetention() {
  try {
    retentionDays.value = await tasks.fetchRetention();
  } catch {
    /* 拉不到就用默认 30 */
  }
}
async function saveRetention() {
  const ok = await tasks.saveRetention(retentionDays.value);
  if (!ok) window.alert('保存保留天数失败');
}
</script>

<template>
  <div class="view" data-testid="task-records">
    <!-- 筛选：一级（工程 + 楼层）+ 二级（状态分段）+ 标题搜索 + 计数，仅本页生效 -->
    <div class="filters">
      <span class="spacer" />
      <select v-model="tasks.filterProject" class="sel" aria-label="按工程筛选">
        <option value="all">全部工程</option>
        <option v-for="p in projectOptions" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <select v-model="tasks.filterClient" class="sel" aria-label="按楼层筛选">
        <option value="all">全部楼层</option>
        <!-- 合并楼层（1F CodeBuddy）的值是逗号分隔的 client 串，服务端按集合取（见 query.js）；
             条目文案带上楼层号（"1F CodeBuddy"）—— 只有产品名时认不出是哪层 -->
        <option v-for="f in floorOptions" :key="f.id" :value="floorValue(f)">{{ floorText(f) }}</option>
      </select>
      <select v-model="filterState" class="sel" aria-label="按状态筛选">
        <option value="all">全部状态</option>
        <option v-for="s in FILTER_STATES.filter((s) => s !== 'all')" :key="s" :value="s">{{ stateLabel(s) }}</option>
      </select>
      <input
        v-model="keyword"
        class="search"
        type="search"
        placeholder="搜索任务标题…"
        aria-label="搜索任务标题"
      />
      <span class="dim count">共 {{ list.length }} 次任务</span>
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
      >{{ v.label }}</button>
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
                  title="确认删除该任务记录"
                  @click.stop="askDelete(t)"
                >确认删除</button>
                <button
                  type="button"
                  class="del-btn"
                  title="取消删除"
                  @click.stop="cancelDelete"
                >取消</button>
              </template>
              <button
                v-else
                type="button"
                class="del-btn"
                title="删除该任务记录"
                @click.stop="askDelete(t)"
              >删除</button>
            </span>
          </div>
          <div class="row-title">{{ promptOf(t) || '(未命名任务)' }}</div>
          <div class="row-meta">
            <span v-if="t.state" class="st" :class="'st-' + t.state">{{ stateLabel(t.state) }}</span>
            <span v-if="t.client">{{ clientLabel(t.client, t.form) }}</span>
            <span v-if="t.model">{{ t.model }}</span>
            <span>{{ fmtDuration(t.duration_ms) }}</span>
            <span v-if="t.file_count != null">{{ t.file_count }} 文件</span>
          </div>
        </li>
        <li v-if="!list.length" class="empty-hint">暂无任务记录</li>
      </ul>

      <!-- 右：选中任务的详情 + 它的 subagent -->
      <section class="detail">
        <template v-if="tasks.selectedTask">
          <header class="detail-head">
            <div class="detail-title">{{ promptOf(tasks.selectedTask) || '(未命名任务)' }}</div>
            <div class="detail-meta">
              <span>{{ fmtTime(tasks.selectedTask.started_at) }}</span>
              <span v-if="tasks.selectedTask.ended_at">→ {{ fmtTime(tasks.selectedTask.ended_at) }}</span>
              <span>{{ fmtDuration(tasks.selectedTask.duration_ms) }}</span>
            </div>
          </header>

          <div class="kv">
            <div class="k">状态</div><div class="v">{{ stateLabel(tasks.selectedTask.state) }}</div>
            <!-- 「进度」暂时不显示（2026-09-29 用户要求注释掉）：progress 现在拿不到真值 ——
                 开工写 0、收工写 1，中间没人推进（唯一会推的是 hook 里"按 TodoWrite 清单
                 折算几项做完"那一条，见 reporter/hook.js 的 todoProgress，实测落不到库里）。
                 本机库实测：489 条任务的 progress 只有 0（80 条）和 1（409 条）两种取值，
                 一个中间值都没有 —— 显示出来就是「0% / 100%」两个数跳，纯误导。
                 将来有了能按轮次推进的真实进度来源，再把这一行放回来（fmtProgress 一并复活）。 -->
            <div class="k">客户端</div><div class="v">{{ clientLabel(tasks.selectedTask.client, tasks.selectedTask.form) }}</div>
            <div class="k">模型</div><div class="v">{{ tasks.selectedTask.model || '—' }}</div>
            <!-- 工程：这一轮归属的工程名。服务端按工程**目录**现算（package.json name > 目录名，
                 与"打开工程"同一口径，见 /task-runs 的 project_label）；拿不到目录才退回库里的
                 projects.name（可能带同名冲突后缀，如 stb-dashboard-2），再没有退 project_id，
                 最后才写占位 —— 绝不编造 -->
            <div class="k">工程</div>
            <div class="v">{{ tasks.selectedTask.project_label || tasks.selectedTask.project_name || tasks.selectedTask.project_id || '—' }}</div>
            <!-- 文件数挪到键值网格、与「模型」对齐；无改动（纯问答）显示 0 -->
            <div class="k">文件变化</div>
            <div class="v v-bright">{{ filesOf(tasks.selectedTask).length || (tasks.selectedTask.file_count != null ? tasks.selectedTask.file_count : 0) }}</div>
          </div>

          <div v-if="filesOf(tasks.selectedTask).length" class="files">

            <template v-if="addedFiles(tasks.selectedTask).length">
              <div class="cat">新增文件 ({{ addedFiles(tasks.selectedTask).length }})</div>
              <ul>
                <li v-for="(f, i) in addedFiles(tasks.selectedTask)" :key="'a' + i">
                  <span class="fp">{{ f.path }}</span>
                  <span v-if="f.size != null" class="sz">({{ fmtSize(f.size) }})</span>
                </li>
              </ul>
            </template>

            <template v-if="modifiedFiles(tasks.selectedTask).length">
              <div class="cat">改动文件 ({{ modifiedFiles(tasks.selectedTask).length }})</div>
              <ul>
                <li v-for="(f, i) in modifiedFiles(tasks.selectedTask)" :key="'m' + i">
                  <span class="fp">{{ f.path }}</span>
                  <span v-if="f.size != null" class="sz">({{ fmtSize(f.size) }})</span>
                </li>
              </ul>
            </template>

            <template v-if="deletedFiles(tasks.selectedTask).length">
              <div class="cat">删除文件 ({{ deletedFiles(tasks.selectedTask).length }})</div>
              <ul>
                <li v-for="(f, i) in deletedFiles(tasks.selectedTask)" :key="'d' + i">
                  <span class="fp">{{ f.path }}</span>
                </li>
              </ul>
            </template>
          </div>

          <!-- 工具使用：这一轮每个工具用了几次（上报方逐次 +1，见 server/src/ingest/bus.js 的 toolUse） -->
          <div v-if="toolsOf(tasks.selectedTask).length" class="tools">
            <div class="files-head">工具使用</div>
            <ul class="tool-list">
              <li v-for="(t, i) in toolsOf(tasks.selectedTask)" :key="'tool' + i" class="tool-item">
                <span class="tool-name">{{ t.tool }}</span>
                <span class="tool-count">{{ t.count }} 次</span>
              </li>
            </ul>
          </div>

          <div class="result-block">
            <div class="files-head">产出摘要</div>
            <p class="result">{{ tasks.selectedTask.result || '（无）' }}</p>
          </div>

          <!-- subagent 列表：点击单个看详情 -->
          <div v-if="tasks.subagents.length" class="subs">
            <div class="files-head">本轮 subagent（{{ tasks.subagents.length }}）</div>
            <ul class="sub-list">
              <li
                v-for="s in tasks.subagents"
                :key="s.id"
                class="sub-item"
                :class="{ on: expandedSub === s.id }"
              >
                <button class="sub-btn" @click="toggleSub(s.id)">
                  <span class="sub-name">{{ s.name }}</span>
                  <span class="sub-sub">{{ s.title || '（未命名）' }}</span>
                  <span class="sub-dur">{{ fmtDuration(s.duration_ms) }}</span>
                </button>
                <div v-if="expandedSub === s.id" class="sub-detail">
                  <div class="kv">
                    <div class="k">名字</div><div class="v">{{ s.name }}</div>
                    <div class="k">任务</div><div class="v">{{ s.title || '（未命名）' }}</div>
                    <div class="k">客户端</div><div class="v">{{ clientLabel(s.client) }}</div>
                    <div class="k">模型</div><div class="v">{{ s.model || '—' }}</div>
                    <div class="k">开始</div><div class="v">{{ fmtTime(s.started_at) }}</div>
                    <div class="k">结束</div><div class="v">{{ fmtTime(s.ended_at) }}</div>
                    <div class="k">耗时</div><div class="v">{{ fmtDuration(s.duration_ms) }}</div>
                    <div class="k">输入 token</div><div class="v">{{ fmtTokens(s.input_tokens) }}</div>
                    <div class="k">输出 token</div><div class="v">{{ fmtTokens(s.output_tokens) }}</div>
                  </div>
                  <div v-if="filesOf(s).length" class="files">
                    <div class="files-head">改动文件</div>

                    <template v-if="addedFiles(s).length">
                      <div class="cat">新增文件 ({{ addedFiles(s).length }})</div>
                      <ul>
                        <li v-for="(f, i) in addedFiles(s)" :key="'a' + i">
                          <span class="fp">{{ f.path }}</span>
                          <span v-if="f.size != null" class="sz">({{ fmtSize(f.size) }})</span>
                        </li>
                      </ul>
                    </template>

                    <template v-if="modifiedFiles(s).length">
                      <div class="cat">改动文件 ({{ modifiedFiles(s).length }})</div>
                      <ul>
                        <li v-for="(f, i) in modifiedFiles(s)" :key="'m' + i">
                          <span class="fp">{{ f.path }}</span>
                          <span v-if="f.size != null" class="sz">({{ fmtSize(f.size) }})</span>
                        </li>
                      </ul>
                    </template>

                    <template v-if="deletedFiles(s).length">
                      <div class="cat">删除文件 ({{ deletedFiles(s).length }})</div>
                      <ul>
                        <li v-for="(f, i) in deletedFiles(s)" :key="'d' + i">
                          <span class="fp">{{ f.path }}</span>
                        </li>
                      </ul>
                    </template>
                  </div>
                  <div class="result-block">
                    <div class="files-head">完成任务（产出）</div>
                    <p class="result">{{ s.result || '（无）' }}</p>
                  </div>
                </div>
              </li>
            </ul>
          </div>
          <div v-else-if="tasks.selectedTask.subagentCount" class="dim loading">加载 subagent…</div>
        </template>
      </section>
    </div>

    <!-- 批量操作：删除筛选结果（手动）/ 记录保留天数（服务端自动清理）；仅列表视图，位于列表页底部 -->
    <div class="bulk-bar" v-if="view === 'list'">
      <span class="dim">批量操作：</span>
      <button type="button" class="del-btn danger" @click="bulkDeleteAll">删除筛选结果</button>
      <span class="dim">自动保留最近</span>
      <input v-model.number="retentionDays" class="days" type="number" min="1" max="3650" aria-label="保留天数" />
      <span class="dim">天（更早记录由服务端自动清理）</span>
      <button type="button" class="btn" @click="saveRetention">保存天数</button>
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
          >{{ d.label }}</button>
        </div>
        <button type="button" class="btn export" @click="exportCsv">导出 CSV</button>
      </div>

      <div v-if="reportGroups.length" class="report-scroll">
        <table class="report-table">
          <thead>
            <tr>
              <th class="th-dim">{{ dimColName }}</th>
              <th class="sortable num" :class="sortCls('taskCount')" @click="sortBy('taskCount')">任务数</th>
              <th class="sortable num" :class="sortCls('successCount')" @click="sortBy('successCount')">成功数</th>
              <th class="sortable num" :class="sortCls('cancelCount')" @click="sortBy('cancelCount')">取消数</th>
              <th class="sortable num" :class="sortCls('fileCount')" @click="sortBy('fileCount')">改动文件数</th>
              <th class="sortable num" :class="sortCls('durationSum')" @click="sortBy('durationSum')">总耗时</th>
              <th class="sortable num" :class="sortCls('avgDuration')" @click="sortBy('avgDuration')">平均耗时</th>
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
              <td class="num">{{ r.successCount }}</td>
              <td class="num">{{ r.cancelCount }}</td>
              <td class="num">{{ r.fileCount }}</td>
              <td class="num">{{ fmtDuration(r.durationSum) }}</td>
              <td class="num">{{ fmtDuration(r.avgDuration) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="total-row">
              <td class="td-dim">{{ reportTotal.label }}</td>
<td class="num">{{ reportTotal.taskCount }}</td>
              <td class="num">{{ reportTotal.successCount }}</td>
              <td class="num">{{ reportTotal.cancelCount }}</td>
              <td class="num">{{ reportTotal.fileCount }}</td>
              <td class="num">{{ fmtDuration(reportTotal.durationSum) }}</td>
              <td class="num">{{ fmtDuration(reportTotal.avgDuration) }}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div v-else class="empty-pane">
        <span class="dim">当前筛选条件下暂无数据</span>
      </div>
    </div>

    <!-- 图形看板：占位，后续落地 -->
    <div v-else class="empty-pane">
      <span class="dim">图形看板（待实现）</span>
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

/* 未落地视图的占位面板 */
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
