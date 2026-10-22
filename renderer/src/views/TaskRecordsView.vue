<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useProjectStore } from '../stores/project';
import { useSessionStore } from '../stores/sessions';
import { useTaskStore } from '../stores/tasks';
import { HOUR_COLS, MIN_PER_DAY, buildFloorGantt, concurrencyAlpha, dayStartOf, fmtHM, isBoardTask } from '../lib/dayBoard';
import {
  TIME_RANGES,
  clampDay,
  dayInRange,
  dayRangeOf,
  inTimeWindow as inWindowAt,
  timeWindowOf,
} from '../lib/timeRange';
import { DEFAULTS } from '@workgremlin/shared';
import { httpBase } from '../api/bridge';
import { useI18n } from '../i18n';
import { marked } from 'marked';
import MultiSelect from '../components/MultiSelect.vue';

/**
 * Which view to open on (list / summary / board).
 * Only the default matters at runtime; the SSR smoke test (renderSmoke) uses it to render the
 * summary / board branches too — otherwise those two are only reachable by hand, and white-screen
 * bugs (the 2026-10-01 blank summary page) would go untested.
 */
const props = defineProps({
  initialView: { type: String, default: 'list' },
});

const project = useProjectStore();
const session = useSessionStore();
const tasks = useTaskStore();
/**
 * Alias the translator as `tr`: in this file `t` means "a task" everywhere (`dimLabel(t, dim)`,
 * `v-for="t in list"`, row variables in the template), so calling the translation function `tr`
 * keeps it from ever being shadowed by a row variable.
 */
const { t: tr } = useI18n();

/**
 * Markdown rendering for the task-detail "output summary".
 * An agent's result is a chunk of markdown (headings / lists / code blocks / bold …); it used to be
 * shown as plain text with <p> + pre-wrap, which mashed headings, lists and code blocks together.
 * Here it is parsed to HTML and then lightly sanitized with DOMParser (drop script/style and on*
 * attributes, javascript: links) — the output comes from a local agent so the risk is low, but the
 * render layer should not execute arbitrary HTML as-is. In non-browser environments (unit tests) it
 * returns marked's raw output so assertions are unaffected.
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

/** Top-level filter options: all projects + all floors (a floor = a member client) */
const projectOptions = computed(() => project.projects || []);
// Only floors with a client can serve as a task filter dimension (some floors are unreported and have no client)
const floorOptions = computed(() => (session.floors || []).filter((f) => f.client));

/**
 * Floor ↔ client (axis 1):
 *   - A floor is identified by one bare client base name; CLI and plugin forms share it;
 *   - Selecting several floors produces a comma-separated value for the server's set filter.
 */
function floorClients(f) {
  return Array.isArray(f.clients) && f.clients.length ? f.clients : f.client ? [f.client] : [];
}
function floorValue(f) {
  return floorClients(f).join(',');
}
/** Dropdown item text: floor number + product name ("1F CodeBuddy"); when the floor number is missing, give only the name — never invent one */
function floorText(f) {
  return [f.id, f.name].filter(Boolean).join(' ');
}
/** Which floor this task's agent belongs to (matched by base agent name; CLI and plugin share a floor) */
function floorOfClient(c) {
  const k = String(c || '')
    .split('@')[0]
    .toLowerCase();
  if (!k) return null;
  return (
    floorOptions.value.find(
      (f) => String(f.agent || f.client || '').split('@')[0].toLowerCase() === k,
    ) || null
  );
}

/**
 * "Now" is used in two places: which cell a **still-running task** is drawn up to on the board, and
 * where the time-filter "today / past 7 days" starts from (see lib/timeRange.js). It rides along
 * with the page's existing 4s poll instead of starting another timer — the page can stay open across
 * midnight, and "today" rolls over to the new day by itself.
 *
 * **Must be declared before list**: the `watch(list, …, { immediate: true })` below evaluates the
 * moment it is registered, and it reads nowMs through inTimeWindow → timeWindow; moving it to the
 * second half of the file causes a TDZ error (Cannot access 'nowMs' before initialization) and
 * blanks the whole page.
 */
const nowMs = ref(Date.now());

/** Poll every 4s (tasks / subagents are low-frequency events, so polling is enough; no WS needed) */
const POLL_MS = 4000;
let timer = null;

function start() {
  nowMs.value = Date.now();
  tasks.fetchTasks();
  if (timer) clearInterval(timer);
  // "Now" rides along with each poll so the board's "how far a running task is drawn" doesn't freeze at page-open time
  timer = setInterval(() => {
    nowMs.value = Date.now();
    tasks.fetchTasks();
    // Refresh the selected task's subagents too: a running task can summon **new** subagents after it
    // was selected, so fetching only in selectTask left the detail pane stuck on "loading subagents"
    // (subagentCount > 0 but the list never reloaded).
    if (tasks.selectedTaskId) tasks.fetchSubagents(tasks.selectedTaskId);
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
// When the project changes, refetch and reset filters
watch(
  () => project.project && project.project.id,
  (id) => {
    tasks.selectedTaskId = null;
    tasks.subagents = [];
    tasks.filterProjects = [];
    tasks.filterClients = [];
    tasks.filterStates = [];
    tasks.filterTime = 'all';
    tasks.customFrom = '';
    tasks.customTo = '';
    keyword.value = '';
    filterModel.value = '';
    if (id) tasks.fetchTasks();
  }
);
// Top-level filter changed → refetch (project / client go through the server)
watch(
  () => [tasks.projectParam, tasks.clientParam],
  () => tasks.fetchTasks()
);

const expandedSub = ref(null);
function toggleSub(id) {
  expandedSub.value = expandedSub.value === id ? null : id;
}

// ---- Formatting ----
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
/** Usage points. null shows "—" (same convention as the token row); otherwise a plain number with
 *  two decimals, no currency symbol. */
function fmtPoints(n) {
  if (n == null) return '—';
  return Number(n).toFixed(2);
}
/** Whether this is a Trae task: the Trae client reports `"trae"` (plain trae) or `"trae,trae-plugin"`
 *  (comma-separated). Trae's renderer.log only gives an amount, not an input/output_tokens breakdown
 *  → the detail panel shows "points" instead of "tokens". */
function isTraeTask(t) {
  const c = t && String(t.client || '');
  if (!c) return false;
  return c.split(',').map((x) => x.trim()).includes('trae');
}
/**
 * This round's **total input** = non-cached + cache reads.
 *
 * The two columns are stored separately in the DB (semantics in the comment in
 * server/src/db/schema.sql: `input_tokens` is only the part that **did not hit the cache**), and when
 * a person asks "how much went in this round" they mean the whole context that was sent — showing
 * only the input_tokens column makes 4F Claude display 161 when the real number is 46,497, which
 * looks broken. The breakdown is attached to the title.
 * Both columns NULL = this floor can't report tokens (5F/6F/9F…) → return null to show "—", which is
 * distinct from "consumed zero" (the latter displays 0).
 */
function inputTotalOf(t) {
  if (!t) return null;
  const parts = [t.input_tokens, t.cache_read_tokens];
  if (parts.every((v) => v == null)) return null;
  return parts.reduce((s, v) => s + (Number(v) || 0), 0);
}
/**
 * The "tokens" row: all three values **laid out**, separated by " / " (user request 2026-10-01;
 * on 2026-10-08 the user asked to drop "cache write input" — on this machine that column is always 0
 * across all 12 floors, so it takes a cell without adding information).
 * Order follows the DB column order — **non-cached input / cache-read input / output**; the first
 * two sum to "this round's total input" (input_tokens in the DB excludes the cache, see schema.sql;
 * showing only it makes 4F Claude read "5,662" when 1,457,438 actually went in, which looks broken).
 * Each item is taken on its own: for floors that can't report tokens all three are "—" (**not 0** —
 * "can't report" and "consumed zero" are two different things).
 */
function tokenQuadOf(t) {
  const s = t || {};
  return [s.input_tokens, s.cache_read_tokens, s.output_tokens].map(fmtTokens).join(' / ');
}
/** Hover text for the "tokens" row: what each of the three numbers is (same order as the main row) + the sum of the first two */
function tokenTitleOf(t) {
  const head = tr('records.tokens_order');
  const total = inputTotalOf(t);
  return total == null ? head : tr('records.tokens_total', { head, n: fmtTokens(total) });
}
/**
 * A task's **total tokens** = non-cached input + cache-read input + output (all three added).
 * The "tokens" column of the summary report's "data overview" table (one row per task) uses it.
 * All three NULL (5F TraeCode / 6F Qoder and other floors that can't report tokens) → null shows "—",
 * distinct from "consumed zero" (the latter displays 0).
 */
function totalTokensOf(t) {
  if (!t) return null;
  const parts = [t.input_tokens, t.cache_read_tokens, t.output_tokens];
  if (parts.every((v) => v == null)) return null;
  return parts.reduce((s, v) => s + (Number(v) || 0), 0);
}
/** State key → i18n entry (shared by the filter options and the state column in the table) */
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
/** Currently **has no caller**: the "progress" row in the detail was commented out per the
 *  2026-09-29 request (see the note in the template); it is kept so one line can bring it back once
 *  there is real progress. progress now only takes 0 / 1. */
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
  // Tolerate old data (plain path strings / {path,added,removed}) and the new shape ({path,op,size})
  return a.map((x) => {
    if (typeof x === 'string') return { path: x, op: null, size: null };
    return { path: x.path, op: x.op ?? null, size: x.size ?? null };
  });
}

/**
 * Tools used this round (name + count). The server aggregates them from the tool_usage table and
 * sends them with the task row (see /task-runs in server/src/http/routes/query.js); with no records
 * it's an empty array and that whole section is hidden in the detail — the frontend neither converts
 * nor invents anything.
 */
function toolsOf(task) {
  const a = task && task.tools;
  if (!Array.isArray(a)) return [];
  return a
    .filter((x) => x && x.tool)
    .map((x) => ({ tool: String(x.tool), count: Number(x.count) || 0 }));
}

/**
 * The "user's own words" inside a task title.
 *
 * Old data (from before the hook was fixed) stored the whole IDE-injected context block as the title
 * — `# Context from my IDE setup: ## Active file: …`. The hook no longer stores it that way (the
 * rule is in userRequestText in packages/reporter/src/hook.js), but **historical rows** are still in
 * the DB, so strip it once more with the same rule at display time — otherwise the task list is a
 * screen of IDE context. The rule is kept consistent with the hook side.
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
 * Session title: a **session-level** name — every round of the same session gets the same value, and
 * it is how you tell "which tasks belong to the same session" (a round = a task row; each round's own
 * title differs).
 * Server lookup order: 6F/7F/8F use the session summary in their SQLite; other floors fall back to
 * the user's words from the **first round** of that session (the title when the session starts is
 * the user's words).
 * When it can't be found it's always an empty string (see server/src/sessionTitle.js), and that row
 * is simply not shown here.
 */
function sessionTitleOf(t) {
  return String((t && t.session_title) || '').trim();
}
/**
 * The list / summary / gantt / export all show **this round's own user input** (promptOf), never the
 * session title — the session title is session-level (shared by every round of a session), so using
 * it as a row title would make a whole column read as the first round's sentence, indistinguishable.
 * It appears only as a single row in the detail (see "session title" in the detail).
 */
/** Bucket a hook op into one of three kinds: add = new / del = deleted / mod = changed (includes old data with no op) */
function classify(f) {
  if (f.op === 'delete') return 'del';
  if (f.op === 'write') return 'add';
  return 'mod';
}
const addedFiles = (t) => filesOf(t).filter((f) => classify(f) === 'add');
const modifiedFiles = (t) => filesOf(t).filter((f) => classify(f) === 'mod');
const deletedFiles = (t) => filesOf(t).filter((f) => classify(f) === 'del');
/** Byte count -> human readable (B / KB / MB) */
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Top filters: state filter + title keyword (page-local only, pure client-side filtering, no schema
 * change). The state filter is multi-select and its selection lives in the store so it survives page
 * switches; an empty selection means "no filter". "failed" and "pending" were dropped per request.
 */
const FILTER_STATES = ['running', 'done', 'cancelled'];
const keyword = ref('');

/**
 * Time filter (user request 2026-10-01). The bucket table and window algorithm live in
 * lib/timeRange.js (pure functions with regression tests — everything here is a midnight / month-end
 * / DST boundary and can't be tested inside an SFC).
 *
 * The selection (bucket + custom range) lives in the store so it survives page switches.
 *
 * "Now" comes from nowMs (riding along with the page's 4s poll): when the page stays open across
 * midnight "today" rolls over to the new day by itself, no extra timer needed.
 */
/** Time bucket labels (the bucket table is in lib/timeRange.js, the text is in the i18n tables; an unknown key is shown as-is) */
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
const timeWindow = computed(() => timeWindowOf(tasks.filterTime, nowMs.value, tasks.customFrom, tasks.customTo));

/** Options for the three multi-select checkbox dropdowns (project / floor / state) */
const projectSelOptions = computed(() => projectOptions.value.map((p) => ({ value: p.id, label: p.name })));
const floorSelOptions = computed(() => floorOptions.value.map((f) => ({ value: floorValue(f), label: floorText(f) })));
const stateSelOptions = computed(() => FILTER_STATES.map((s) => ({ value: s, label: stateLabel(s) })));
/** Does this task's start time fall in the current time window? (semantics in inTimeWindow in lib/timeRange.js) */
function inTimeWindow(t) {
  return inWindowAt(t && t.started_at, timeWindow.value);
}

/** Three parallel views sharing the filters above: list (default) / summary report / graphical board */
const VIEWS = [
  { key: 'list', label: 'records.view.list' },
  { key: 'summary', label: 'records.view.summary' },
  { key: 'board', label: 'records.view.board' },
];
const view = ref(props.initialView);

// There is no dedicated model dropdown; this backs the client-side filter used when drilling down from a summary report row (empty = no filter, list-view logic unchanged)
const filterModel = ref('');

const list = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  const fm = filterModel.value;
  return (tasks.tasks || []).filter((t) => {
    if (tasks.filterStates.length && !tasks.filterStates.includes(t.state)) return false;
    if (!inTimeWindow(t)) return false;
    if (kw && !promptOf(t).toLowerCase().includes(kw) && !String((t.session_title) || '').toLowerCase().includes(kw)) return false;
    if (fm && (t.model || '') !== fm) return false;
    return true;
  });
});

// After the list opens / data refreshes, default-select the first task if none is selected; with no tasks the right side stays empty.
watch(
  list,
  (arr) => {
    if (!tasks.selectedTaskId && arr && arr.length) tasks.selectTask(arr[0].id);
  },
  { immediate: true }
);

// ---- Summary report: aggregate by dimension (based on the filtered list, filters shared by all three views) ----
/**
 * The dimension tab order = the array order. "Data overview" comes first (user request 2026-10-01)
 * and is also the default view when the report opens.
 *
 * The key is still `time`: it marks "this version lists tasks one by one in time order" (parallel to
 * the three dimension-aggregated ones); only the tab text became "data overview" — the key is an
 * internal identifier used by the CSV branch and tests, so it stays.
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
/** Default to the first dimension (currently "data overview") — it is the first tab and what opens by default */
const reportDim = ref(DIMS[0].key);
const reportSort = ref({ key: 'taskCount', dir: 'desc' });

function dimValue(t, dim) {
  if (dim === 'project') return t.project_id || '';
  if (dim === 'model') return t.model || '';
  // Aggregate by floor: the CLI and Plugin clients belong to the same floor (1F CodeBuddy) → same group key
  if (dim === 'floor') {
    const f = floorOfClient(t.memberId || t.client);
    return f ? floorValue(f) : t.client || '';
  }
  return '';
}
function dimLabel(t, dim) {
  if (dim === 'project') return (projectOptions.value.find((p) => p.id === t.project_id) || {}).name || t.project_id || tr('records.unnamed_project');
  if (dim === 'model') return t.model || tr('records.unrecorded');
  if (dim === 'floor') {
    const f = floorOfClient(t.memberId || t.client);
    if (f) return f.name;
    return t.client_label || tr('records.unrecorded');
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
      // sids: the session_ids seen in this group (for dedup) — the session count = how many elements
      // it has, not the task count (a session usually has several rounds). Session-level dedup; the
      // task count still counts one per round.
      g = { key: k, label: dimLabel(t, dim), taskCount: 0, sids: new Set(), successCount: 0, cancelCount: 0, fileCount: 0, durationSum: 0, durN: 0, tokenSum: 0, tokenN: 0 };
      map.set(k, g);
    }
    g.taskCount += 1;
    const sid = String(t.session_id || '').trim();
    if (sid) g.sids.add(sid);
    // Old tasks without a session_id: they count as one task but do not inflate the session count (we don't know which session they belong to, so don't invent one)
    if (t.state === 'done') g.successCount += 1;
    else if (t.state === 'cancelled') g.cancelCount += 1;
    g.fileCount += Number(t.file_count) || 0;
    const d = Number(t.duration_ms) || 0;
    if (d > 0) { g.durationSum += d; g.durN += 1; }
    // Token total: **only sum tasks that can report tokens** (ones that can't are excluded, not
    // counted as 0, matching the footer total of the "data overview" table). tokenN records "how
    // many rows in this group have real numbers".
    const tk = totalTokensOf(t);
    if (tk != null) { g.tokenSum += tk; g.tokenN += 1; }
  }
  return [...map.values()].map((g) => {
    const avgDuration = g.durN ? g.durationSum / g.durN : 0;
    return { ...g, avgDuration, sessionCount: g.sids.size };
  });
});
const reportTotal = computed(() => {
  // Total session count = the deduplicated union over all groups (not the sum of the groups' session
  // counts — one session can fall into two groups, e.g. switching models within a session puts it in
  // two groups when grouping by model)
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
/* ---- By time: list tasks one by one (no aggregation); columns = time / task / client / model / project / duration / state ---- */
/**
 * The task title is truncated to the first 10 characters (adds an ellipsis if longer): this version
 * shows one task per row, and a full title would squeeze out client / model / project on the right.
 * The full title is attached to `title`.
 * Use [...s] to split by **code point** — a direct slice cuts emoji / rare characters in half and
 * shows mojibake.
 */
/** Truncate by **code point** (a direct slice cuts emoji / rare characters in half and shows mojibake) */
function shortText(s, n = 10) {
  const chars = [...String(s || '')];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : String(s || '');
}
function shortTitle(task, n = 10) {
  // Don't name the parameter t: in this file t means "a task" everywhere, and the translator is tr
  return shortText(promptOf(task) || tr('records.untitled_task'), n);
}
/** Project column: same semantics as the task detail (server-computed project_label from the project dir > name in the DB > id) */
function projectOf(t) {
  return t.project_label || t.project_name || t.project_id || '—';
}
/** Sorting for the data-overview version (default newest → oldest; click a header to toggle) */
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
/** Footer row: count + total duration (tasks that never finished have no duration and are excluded, not invented) */
const timeTotalMs = computed(() => timeRows.value.reduce((s, t) => s + (Number(t.duration_ms) || 0), 0));
/** Footer session count: how many **distinct** sessions this screen covers (old tasks without a session_id are excluded, not invented) */
const timeSessionCount = computed(() => {
  const sids = new Set();
  for (const t of timeRows.value) {
    const sid = String(t.session_id || '').trim();
    if (sid) sids.add(sid);
  }
  return sids.size;
});
/**
 * Footer token total: **only sum tasks that can report tokens** (ones that can't are excluded, not
 * counted as 0). If none can → null shows "—" (this screen has no real value at all; a 0 would make
 * people think "it ran but used no tokens").
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

/** Click a report row: switch to the list view and filter by that row's dimension value (project/floor go through server-side filtering, model/agent through client-side) */
function drillDown(row) {
  const dim = reportDim.value;
  // The data-overview version lists tasks themselves, so clicking a row = open that task's detail
  if (dim === 'time') {
    tasks.selectTask(row.id);
    view.value = 'list';
    return;
  }
  filterModel.value = '';
  if (dim === 'project') { tasks.filterProjects = row.key ? [row.key] : []; tasks.filterClients = []; }
  else if (dim === 'floor') { tasks.filterClients = row.key ? [row.key] : []; tasks.filterProjects = []; }
  else if (dim === 'model') { filterModel.value = row.key; }
  view.value = 'list';
}
/** Write a 2D array as CSV and download it (client-side Blob; sensitive data like phone/ID numbers isn't here, so no extra handling) */
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

/** Export the report as CSV (client-side download, includes the current sort and the total row; the data-overview version exports the per-task rows) */
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
      promptOf(t) || tr('records.untitled_task'), // Export the full title, don't export the ellipsis
      sessionTitleOf(t), // Session: empty string when unavailable (the table shows "—", the export stays empty, no placeholder)
      t.client_label,
      t.model || '',
      projectOf(t),
      // Tokens export as a **bare number** (no thousands separators, so Excel can treat it as a number); empty when unavailable, never 0
      totalTokensOf(t) == null ? '' : totalTokensOf(t),
      t.duration_ms == null ? '' : Math.round(t.duration_ms),
      stateLabel(t.state),
    ]);
    // The file name follows the tab (the aggregated versions below also build it from the label); changing the tab text means changing this too
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
  // Tokens export as a **bare number** (no thousands separators, so Excel can calculate directly); empty when this group has no real value, never 0
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

/* ------------------------------ Graphical board: daily ------------------------------
 * One gantt chart per day:
 *   x-axis = the day 00:00–24:00, **one vertical line per hour** (ticks 09:00 / 10:00 …);
 *   y-axis = **floor** (one row per floor, e.g. "3F Codex");
 *   a solid block in a row = one task on that floor; its left and right vertical edges cut it off
 *   from the neighboring tasks ("divide tasks with vertical lines").
 * **One row per floor, always**: when several rounds run in parallel on the same floor we no longer
 * stack more lanes downward but **darken** the overlapping span (a dark layer on the block) — the row
 * count stays stable, and you can still see "two or three are running at once".
 *
 * Semantics:
 *   · Split by floor? No — the board is divided by floor by definition; the filter bar above still
 *     applies (project / floor / state / keyword all act on list), so filtering to one floor leaves
 *     only that row on the chart;
 *   · States drawn: only running / done / cancelled —— failed and pending are dropped (isBoardTask in
 *     lib/dayBoard.js, user request 2026-10-19), so red on the chart means one thing: cancelled;
 *   · Cross-day / no end time / start time only — these boundaries are all in lib/dayBoard.js (pure
 *     functions with regression tests).
 */
function fmtDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const wd = tr('records.weekdays')[d.getDay()] || '';
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}${wd ? ` ${wd}` : ''}`;
}

/** Row height (px): one row per floor always; this value determines both the row height and the block height */
const LANE_H = 16;

const boardDay = ref(dayStartOf(Date.now()));
const boardIsToday = computed(() => boardDay.value === dayStartOf(Date.now()));

/**
 * The days the board can page to = the window of the top time filter (user request 2026-10-01).
 * With "today" selected only today remains, and neither previous nor next day is clickable; "past 7
 * days" can only page within 9/25–10/1. "All time" is null at both ends — paging is free as before.
 * The algorithm is in lib/timeRange.js (with regression tests).
 */
const boardDayRange = computed(() => dayRangeOf(timeWindow.value));
/** The current bucket's text (used as the title of disabled buttons so people know which filter is blocking them) */
const filterTimeLabel = computed(
  () => timeRangeLabel(tasks.filterTime)
);
/** After switching buckets / crossing midnight, pull the day back if it's outside the window — otherwise the chart is blank and looks broken */
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
/** Whether the board can page to that day: clickable only if the target is inside the filter window (otherwise the button is greyed out) */
function canShiftDay(n) {
  const d = new Date(boardDay.value);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return dayInRange(d.getTime(), boardDayRange.value);
}
/** The "today" jump: greyed out when the window has no today (e.g. filtering "last month"), so nobody is sent outside the window */
const canBackToToday = computed(() => dayInRange(dayStartOf(Date.now()), boardDayRange.value));

function backToToday() {
  boardDay.value = clampDay(dayStartOf(Date.now()), boardDayRange.value);
}
/** Local YYYY-MM-DD (don't use toISOString — that's UTC and can be off by a day) */
function dayValueOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const boardDayValue = computed(() => dayValueOf(boardDay.value));
/** min / max of <input type="date">: give undefined for the unbounded end (the attribute isn't rendered at all) */
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
  // Cover both manual typing and browsers that ignore min/max: clamp back into the window so the board never sits outside it
  boardDay.value = clampDay(d.getTime(), boardDayRange.value);
}

/** Which row a task lands on: client → floor (merged floors matched by base name, see floorOfClient) */
function rowOfTask(t) {
  const f = floorOfClient(t.memberId || t.client);
  if (f) return { key: f.id, label: floorText(f), order: Number.parseInt(f.id, 10) || 900 };
  if (!(t.memberId || t.client)) return { key: '__none__', label: tr('records.no_floor'), order: 999 };
  // Has a client but not in the floor table (old data / product not installed): show which client it is honestly, don't force it into a floor
  return { key: String(t.memberId || t.client), label: t.client_label, order: 900 };
}

/**
 * Floors that still get a row even with no tasks that day (user request 2026-10-01):
 *   · Floor filter = all floors → **every installed floor** is drawn, empty ones leaving an empty row;
 *   · One or more floors are selected → only the matching floors remain.
 * When a task really lands somewhere not listed (a client not in the floor table / no client at all),
 * buildFloorGantt still adds a row for it — not a single row is lost.
 */
const boardBaseRows = computed(() => {
  const wantSet = new Set(tasks.clientList.map((c) => c.toLowerCase()));
  const hit = (f) => {
    if (!wantSet.size) return f.installed !== false;
    return floorClients(f).some((c) => wantSet.has(String(c).toLowerCase()));
  };
  return floorOptions.value
    .filter(hit)
    .map((f) => ({ key: f.id, label: floorText(f), order: Number.parseInt(f.id, 10) || 900 }));
});

const boardGantt = computed(() =>
  // The board hides failed / pending rounds (isBoardTask, user request 2026-10-19): a timeline only
  // keeps running / done / cancelled, everything else would just crowd the chart.
  buildFloorGantt(list.value.filter(isBoardTask), boardDay.value, nowMs.value, rowOfTask, boardBaseRows.value)
);
const boardRows = computed(() => boardGantt.value.rows);
/** The position of "now" on the x-axis (%); returns -1 when not viewing today (so the line isn't drawn) */
const boardNowPct = computed(() => {
  if (!boardIsToday.value) return -1;
  return ((nowMs.value - boardDay.value) / (MIN_PER_DAY * 60 * 1000)) * 100;
});

/** Hover tooltip on a block: which task, from when to when, how long, and what state */
function blockTitle(it) {
  const task = it.task;
  const dur = task.duration_ms != null ? fmtDuration(task.duration_ms) : tr('records.unfinished');
  return `${promptOf(task) || tr('records.untitled_task')}\n${fmtHM(it.startMin)}–${fmtHM(it.endMin)} · ${dur} · ${stateLabel(task.state)}`;
}
/**
 * Clicking the dark parallel overlay opens the task under the cursor, exactly as if the overlay were
 * not there: find the topmost painted block at that instant (items are sorted by start, longer first,
 * and painted in order, so the last match wins).
 */
function openOverlap(row, ev) {
  const lane = ev.currentTarget.parentElement;
  const rect = lane && lane.getBoundingClientRect();
  if (!rect || !rect.width) return;
  const at = boardDay.value + ((ev.clientX - rect.left) / rect.width) * MIN_PER_DAY * 60_000;
  let hit = null;
  for (const it of row.items) if (it.s <= at && at < it.e) hit = it;
  if (!hit) hit = row.items.find((it) => it.s <= at && at <= it.e);
  if (hit) openTask(hit.task.id);
}
/** Click a block = view that task's detail: jump to the list view and select it */
function openTask(id) {
  tasks.selectTask(id);
  view.value = 'list';
}

// ---- Delete ----
/** Single delete: confirm twice (the first click turns into "confirm delete?", the second actually deletes; you can cancel in between) */
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
 * Bulk delete: delete every record under the current filters (project/floor) (manual, takes effect
 * immediately).
 *
 * Note the two filter groups have **different scopes**: project/floor go through the server (the
 * DELETE query), while state/keyword/time are client-side on this page. So even when only a few rows
 * remain visible, this still deletes the whole project/floor slice — the copy must make that gap
 * clear, not just report a headline number.
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
 * Record retention days: the server auto-cleans older task records by this (written back only on
 * change, no polling).
 *
 * The initial value just shows something sensible **before the server setting is fetched** — the
 * real value comes from GET /settings/retention (a user-modified value stored in the DB wins, and is
 * unrelated to this default). The default follows DEFAULTS; don't hardcode it here.
 */
const retentionDays = ref(DEFAULTS.RETENTION_DAYS);
async function loadRetention() {
  try {
    retentionDays.value = await tasks.fetchRetention();
  } catch {
    /* If it can't be fetched, keep the default (not "write back 90" — if it wasn't read, leave the server alone) */
  }
}
async function saveRetention() {
  const ok = await tasks.saveRetention(retentionDays.value);
  if (!ok) window.alert(tr('records.retention_failed'));
}
</script>

<template>
  <div class="view" data-testid="task-records">
    <!-- Filters: top-level (project + floor) + second-level (state) + title search + count; page-local only.
         The first three are multi-select checkbox dropdowns; their selection lives in the store so it
         survives page switches, like the time bucket. -->
    <div class="filters">
      <span class="spacer" />
      <MultiSelect
        v-model="tasks.filterProjects"
        :options="projectSelOptions"
        :all-label="tr('records.filter.project')"
        :aria-label="tr('records.col.project')"
      />
      <!-- Floor values are bare client base names; selecting several floors sends a comma-separated set to the server.
           The item text includes the floor number ("1F CodeBuddy") so floors with similar product names stay distinguishable. -->
      <MultiSelect
        v-model="tasks.filterClients"
        :options="floorSelOptions"
        :all-label="tr('records.filter.floor')"
        :aria-label="tr('records.dim.floor')"
      />
      <MultiSelect
        v-model="tasks.filterStates"
        :options="stateSelOptions"
        :all-label="tr('records.filter.state')"
        :aria-label="tr('records.col.state')"
      />
      <!-- Time filter: keyed on the task's start time (see timeWindow). Only "custom" reveals the two date fields -->
      <select v-model="tasks.filterTime" class="sel" :aria-label="tr('records.col.time')">
        <option v-for="r in TIME_RANGES" :key="r.key" :value="r.key">{{ timeRangeLabel(r.key, r.label) }}</option>
      </select>
      <template v-if="tasks.filterTime === 'custom'">
        <input v-model="tasks.customFrom" class="day-input" type="date" :aria-label="tr('records.filter.custom_from')" />
        <span class="dim">→</span>
        <input v-model="tasks.customTo" class="day-input" type="date" :aria-label="tr('records.filter.custom_to')" />
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

    <!-- Three-view switch: shares the filters above -->
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
      <!-- Left: one task per row -->
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
            <span v-if="t.memberId || t.client">{{ t.client_label }}</span>
            <span v-if="t.model">{{ t.model }}</span>
            <span>{{ fmtDuration(t.duration_ms) }}</span>
            <span v-if="t.file_count != null">{{ tr('records.n_files', { n: t.file_count }) }}</span>
          </div>
        </li>
        <li v-if="!list.length" class="empty-hint">{{ tr('records.list.empty') }}</li>
      </ul>

      <!-- Right: the selected task's detail + its subagents -->
      <section class="detail">
        <template v-if="tasks.selectedTask">
          <header class="detail-head">
            <!-- Detail title = this round's own user input; the session title is a separate row in the key-value grid below -->
            <div class="detail-title">{{ promptOf(tasks.selectedTask) || tr('records.untitled_task') }}</div>
            <div class="detail-meta">
              <span>{{ fmtTime(tasks.selectedTask.started_at) }}</span>
              <span v-if="tasks.selectedTask.ended_at">→ {{ fmtTime(tasks.selectedTask.ended_at) }}</span>
              <span>{{ fmtDuration(tasks.selectedTask.duration_ms) }}</span>
            </div>
          </header>

          <div class="kv">
            <!-- Session title (agent summary): only 6F/7F/8F have a value, and the row is listed only when present —
                 other floors simply don't have this, so no "—" placeholder (which would look like something was lost) -->
            <template v-if="sessionTitleOf(tasks.selectedTask)">
              <div class="k">{{ tr('records.detail.session_title') }}</div>
              <div class="v">{{ sessionTitleOf(tasks.selectedTask) }}</div>
            </template>
            <div class="k">{{ tr('records.detail.state') }}</div><div class="v">{{ stateLabel(tasks.selectedTask.state) }}</div>
            <!-- "Progress" is hidden for now (commented out per the 2026-09-29 request): progress has no real value —
                 it's 0 at start and 1 at finish, with nobody advancing it in between (the only thing that would is the
                 hook rule "count finished items from the TodoWrite list", see todoProgress in reporter/hook.js, which in
                 practice never reaches the DB). Measured on this machine's DB: across 489 tasks progress only takes 0
                 (80) and 1 (409), with no intermediate value at all — showing it would just be "0% / 100%" jumping, purely
                 misleading. Put this row back once there's a real per-round progress source (reviving fmtProgress too). -->
            <div class="k">{{ tr('records.detail.client') }}</div><div class="v">{{ tasks.selectedTask.client_label }}</div>
            <div class="k">{{ tr('records.detail.model') }}</div><div class="v">{{ tasks.selectedTask.model || '—' }}</div>
            <!-- Project: the project this round belongs to. The server computes it from the project **directory** on the fly
                 (package.json name > directory name, the same semantics as "open project", see project_label in /task-runs);
                 only when the directory is unavailable does it fall back to projects.name in the DB (which may carry a
                 same-name conflict suffix like stb-dashboard-2), then to project_id, and only then a placeholder — never invented -->
            <div class="k">{{ tr('records.detail.project') }}</div>
            <div class="v">{{ tasks.selectedTask.project_label || tasks.selectedTask.project_name || tasks.selectedTask.project_id || '—' }}</div>
            <!-- The file count moved into the key-value grid to line up with "model"; no changes (pure Q&A) shows 0 -->
            <!-- Tokens / points, pick one: Trae has an amount but no token breakdown → show the "points" row instead of "tokens";
                 other floors have tokens but no amount → show the "tokens" row as usual. Mutually exclusive, no duplicate cell. -->
            <template v-if="isTraeTask(tasks.selectedTask)">
              <div class="k">{{ tr('records.detail.amount') }}</div>
              <div class="v">{{ fmtPoints(tasks.selectedTask.usage_yuan) }}</div>
            </template>
            <template v-else>
              <div class="k">{{ tr('records.detail.tokens') }}</div>
              <div class="v" :title="tokenTitleOf(tasks.selectedTask)">{{ tokenQuadOf(tasks.selectedTask) }}</div>
            </template>
            <div class="k">{{ tr('records.detail.files') }}</div>
            <div class="v v-bright">{{ filesOf(tasks.selectedTask).length || (tasks.selectedTask.file_count != null ? tasks.selectedTask.file_count : 0) }}</div>
            <!-- Tokens consumed this round: all three laid out, separated by " / " (user request 2026-10-01) —
                 `non-cached input / cache-read input / output`, in the same order as the DB columns
                 ("cache write input" was dropped per the 2026-10-08 request: it's always 0 on this machine, taking a cell
                 without adding information); hover to see what each number is. The real values come from each floor's own
                 session files (see reporter/src/usage.js); floors that can't provide them (5F TraeCode has no usage,
                 6F Qoder's transcript doesn't have it, 2F/9F aren't wired up) show "—", not 0 —
                 "can't report" and "consumed zero" are two different things. -->
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

          <!-- Tool usage: how many times each tool was used this round (the reporter increments per call, see toolUse in server/src/ingest/bus.js) -->
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

          <!-- Subagent list: click one to view its detail -->
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
                    <div class="k">{{ tr('records.detail.client') }}</div><div class="v">{{ s.client_label }}</div>
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

    <!-- Bulk actions: delete filtered results (manual) / record retention days (server auto-clean); list view only, at the bottom of the list page -->
    <div class="bulk-bar" v-if="view === 'list'">
      <span class="dim">{{ tr('records.bulk_ops') }}</span>
      <button type="button" class="del-btn danger" @click="bulkDeleteAll">{{ tr('records.bulk_delete') }}</button>
      <span class="dim">{{ tr('records.retention_before') }}</span>
      <input v-model.number="retentionDays" class="days" type="number" min="1" max="3650" :aria-label="tr('records.retention_aria')" />
      <span class="dim">{{ tr('records.retention_after') }}</span>
      <button type="button" class="btn" @click="saveRetention">{{ tr('records.retention_save') }}</button>
    </div>

    <!-- Summary report: a table aggregated by dimension; shares the filter bar above -->
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

      <!-- By time: list tasks one by one (no aggregation); columns = time / task / client / model / project / tokens / duration / state -->
      <div v-if="reportDim === 'time' && timeRows.length" class="report-scroll">
        <table class="report-table">
          <thead>
            <tr>
              <th class="th-dim sortable" :class="timeSortCls('started_at')" @click="sortTimeBy('started_at')">{{ tr('records.col.time') }}</th>
              <th class="th-dim">{{ tr('records.col.task') }}</th>
              <!-- Session: which session this round belongs to (session-level title, shared by every round of the session) —
                   shows "—" when unavailable (old task without a session_id / not found by the server), never invented -->
              <th class="th-dim">{{ tr('records.col.session') }}</th>
              <th class="th-dim">{{ tr('records.col.client') }}</th>
              <th class="th-dim">{{ tr('records.col.model') }}</th>
              <th class="th-dim">{{ tr('records.col.project') }}</th>
              <!-- One task per row; this column = **this task's total tokens** (all three added, see totalTokensOf).
                   Hover to see the three-part breakdown; floors that can't report tokens show "—" (not 0). -->
              <th class="sortable num" :class="timeSortCls('tokens')" @click="sortTimeBy('tokens')" :title="tr('records.col.tokens_title')">{{ tr('records.col.tokens') }}</th>
              <th class="sortable num" :class="timeSortCls('duration_ms')" @click="sortTimeBy('duration_ms')">{{ tr('records.col.duration') }}</th>
              <th class="th-dim">{{ tr('records.col.state') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in timeRows" :key="t.id" class="report-row" @click="drillDown(t)">
              <td class="td-dim mono">{{ fmtTime(t.started_at) }}</td>
              <!-- The title takes only the first 10 characters; the full sentence is attached to `title` (hover to see) -->
              <td class="td-dim td-task" :title="promptOf(t) || tr('records.untitled_task')">{{ shortTitle(t) }}</td>
              <td class="td-dim td-session" :title="sessionTitleOf(t) || ''">{{ sessionTitleOf(t) ? shortText(sessionTitleOf(t)) : '—' }}</td>
              <td class="td-dim">{{ t.client_label }}</td>
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
              <!-- Session count: how many **distinct** sessions this screen covers (not the task count) -->
              <td class="num">{{ timeSessionCount }}</td>
              <td class="td-dim" />
              <td class="td-dim" />
              <td class="td-dim" />
              <!-- The total only sums tasks that can report tokens; when there are none → "—" (never 0) -->
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
              <!-- Session count: how many **distinct** sessions this group has (a round = one task, so it's usually far below the task count);
                   old tasks without a session_id only count as tasks, not as sessions -->
              <th class="sortable num" :class="sortCls('sessionCount')" @click="sortBy('sessionCount')" :title="tr('records.col.session_count')">{{ tr('records.col.session_count') }}</th>
              <th class="sortable num" :class="sortCls('successCount')" @click="sortBy('successCount')">{{ tr('records.col.success_count') }}</th>
              <th class="sortable num" :class="sortCls('cancelCount')" @click="sortBy('cancelCount')">{{ tr('records.col.cancel_count') }}</th>
              <th class="sortable num" :class="sortCls('fileCount')" @click="sortBy('fileCount')">{{ tr('records.col.file_count') }}</th>
              <!-- Token sum = all three parts of **the tasks in this group that can report tokens**, added up (same semantics as the data-overview footer) -->
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
              <!-- A group with no reported tokens shows "—" (not 0 — "can't report" and "consumed zero" are two different things) -->
              <td class="num">{{ fmtTokens(r.tokenN ? r.tokenSum : null) }}</td>
              <td class="num">{{ fmtDuration(r.durationSum) }}</td>
              <td class="num">{{ fmtDuration(r.avgDuration) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="total-row">
              <td class="td-dim">{{ reportTotal.label }}</td>
              <td class="num">{{ reportTotal.taskCount }}</td>
              <!-- The total session count is the **deduplicated union** over the groups, not the sum of the groups' session counts -->
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

    <!-- Graphical board · daily: x-axis = an hourly vertical line for the day, y-axis = floor; a solid block in a row is one task on that floor -->
    <div v-else class="board">
      <!-- Paging and date selection are confined to the top time-filter window (with "today" selected only today is viewable) -->
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
          <i class="dot st-cancelled" />{{ tr('records.board.legend_cancelled') }}
        </span>
      </div>

      <div class="board-scroll">
        <div class="gantt">
          <!-- Header: one tick per hour; the vertical line on the left of a cell is the hour line -->
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
              <!-- More than one at the same time: lay down a dark layer (not another row). The deeper the
                   colour, the more tasks run at once; hovering names the count, clicking still opens a task. -->
              <span
                v-for="(o, i) in row.overlaps"
                :key="`o${i}`"
                class="overlap"
                :style="{
                  left: `${o.left}%`,
                  width: `${o.width}%`,
                  top: '2px',
                  height: `${LANE_H - 4}px`,
                  background: `rgba(0, 0, 0, ${concurrencyAlpha(o.count)})`,
                }"
                :title="tr('records.board.concurrent', { n: o.count })"
                @click="openOverlap(row, $event)"
              />
            </div>
          </div>

          <!-- No tasks this day: still draw the table (an empty row + hour lines), don't leave a "no tasks" notice board -->
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
        <!-- On a day with no tasks, don't write things like "0 tasks": the empty table says it all (so this checks the task count, not the row count) -->
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
/* Flexible spacer: pushes the filter control group to the right as a whole */
.spacer { flex: 1; }
/* Count: fixed width + right align + tabular numerals, to avoid horizontal jitter when the digit count changes */
.count { flex: 0 0 100px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }

/* Three-view switch */
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

/* Empty pane: a fallback when a view currently has nothing to draw */
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

/* Graphical board · daily: y-axis = floor (one row per floor), x-axis = one vertical line per hour of the day */
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
/* Legend: the swatches match the block / left-edge state colors. Only the three states the board
   draws are listed —— failed / pending never reach the chart (isBoardTask), cancelled is the red one. */
.legend { display: flex; align-items: center; gap: 4px 10px; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); }
.legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
.legend .dot.st-running { background: var(--accent); }
.legend .dot.st-done { background: #7ee787; }
.legend .dot.st-cancelled { background: #ff7b72; }
.board-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel);
  padding: 10px 12px 12px;
}
/* Don't let the 24 hours cram together in a narrow window (at least ~36px per hour): scroll horizontally when it doesn't fit */
.gantt { min-width: 960px; }
.gantt-head { display: flex; }
/* Left-side floor name (one per row), fixed width so the time axis on the right lines up.
   124px fits the longest name ("9F GitHub Copilot"); any narrower and you'd have to rely on the title tooltip */
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
 * One row per floor: one vertical line per hour (a 1px line tiled, tile width = container width / 24),
 * with blocks absolutely positioned on top.
 * Don't use repeating-linear-gradient's calc stop points — if the parser deems that form invalid, the
 * whole background-image silently fails (all hour lines vanish, with no error). This tiled-background
 * approach has no such pitfall.
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
/* A day with no tasks: only this empty table remains (add a bottom border to close it off) */
.lane-area.empty { border-bottom: 1px solid var(--border); }
.block {
  position: absolute;
  box-sizing: border-box;
  /* At least 3px: 1px on each side for the vertical edges plus 1px of color, so a short task still reads as a block and not a line */
  min-width: 3px;
  padding: 0;
  border: 0;
  /* Left and right vertical edges: when neighboring tasks touch, these two edges are the "divider between tasks" */
  border-left: 1px solid rgba(0, 0, 0, 0.55);
  border-right: 1px solid rgba(0, 0, 0, 0.55);
  border-radius: 2px;
  cursor: pointer;
  /* Fallback color: if state is an unseen value, the block is still visible (never let it vanish into nothing) */
  background: var(--state-idle, #7f8c9b);
}
.block:hover { filter: brightness(1.18); }
.block.st-running { background: var(--accent); }
.block.st-done { background: #7ee787; }
/* cancelled is the red one (failed / pending never reach the board, see BOARD_HIDDEN_STATES) */
.block.st-cancelled { background: #ff7b72; }
/**
 * The span where tasks run in parallel: lay down a dark layer (not another row). Opacity comes from
 * concurrencyAlpha (log scale, deeper for every extra task). It must take mouse events so hovering can
 * name the count; clicks are forwarded to the task under the cursor by openOverlap.
 */
.overlap {
  position: absolute;
  border-radius: 2px;
  cursor: pointer;
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

/* Summary report */
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
/* The data-overview version: the time column uses a monospace font (digits line up), the task column is width-limited + ellipsis (first 10 chars) */
.report-table td.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.report-table td.td-task { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Session column: same width limit + ellipsis as the task column, so it doesn't squeeze out client / model on the right */
.report-table td.td-session { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* State colors: `.report-table td`'s color is more specific than .st-*, so without writing these the states would all be white.
   Same palette as the list / board: red means cancelled, failed is amber (user request 2026-10-19). */
.report-table td.st-running { color: var(--accent); }
.report-table td.st-done { color: #7ee787; }
.report-table td.st-failed { color: var(--state-busy, #f5a623); }
.report-table td.st-cancelled { color: #ff7b72; }
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
/* red = cancelled, failed is amber (same rule as the board / summary, user request 2026-10-19) */
.st-failed { color: var(--state-busy, #f5a623); border-color: var(--state-busy, #f5a623); }
.st-cancelled { color: #ff7b72; }
.st-pending { color: var(--text-dim); }
.empty-hint { padding: 20px; text-align: center; color: var(--text-dim); }

.detail {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel);
  padding: 14px 16px;
  overflow-y: auto;
  min-height: 0;
  /* The detail page is "for reading and copying" (task text / file list / errors), so the global select-off is lifted here */
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
/* File count: bright white + bold, to stand out from the values above */
.kv .v.v-bright { color: #fff; font-weight: 600; }

.files { margin-top: 12px; }
.files-head { font-size: 12px; color: var(--text-dim); margin-bottom: 5px; letter-spacing: 0.5px; }
.files .cat { font-size: 12px; color: var(--text); margin: 8px 0 3px; font-weight: 600; }
.files ul { margin: 0; padding-left: 18px; }
.files li { font-size: 12px; color: var(--text-dim); font-family: var(--mono); display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.files li .fp { word-break: break-all; }
.files li .sz { color: var(--text-faint); font-variant-numeric: tabular-nums; }

/* Tool usage: name on the left, count on the right (tabular numerals so the column lines up for scanning) */
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
/* Tool names in bright white, counts dimmed — you see "which tools were used" at a glance, the count is secondary */
.tool-item .tool-name { word-break: break-all; color: #fff; }
.tool-item .tool-count { color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }

.result-block { margin-top: 12px; }
.result { margin: 0; font-size: 13px; color: var(--text); line-height: 1.6; white-space: pre-wrap; }
/* "Output summary" markdown rendering (see md()): the HTML tags in the list only take effect inside this block, not elsewhere */
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

/* Bulk-delete toolbar */
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
/* Greyed-out buttons (when board paging is blocked by the time filter): disabled alone isn't enough —
   background / color are hardcoded above, which overrides the browser's default greyed style and
   makes them look clickable */
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn:disabled:hover { border-color: var(--border); }

/* Delete button (shared by single + bulk) */
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
