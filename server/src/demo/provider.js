'use strict';

/**
 * Read-only demo provider.
 *
 * Demo mode is exposed to the renderer as a normal **floor + session** selection. The virtual
 * `__demo__:session` and its `__demo__` project are built entirely in memory on every request:
 * this module never writes to `projects`, `members`, `tasks`, `messages`, `task_runs` or
 * `task_subagent`. It also owns the demo phase / member states, so the renderer only displays what
 * the server computes.
 */

const { DEFAULTS, DEMO_PROJECT_ID, DEMO_SESSION_ID } = require('@workgremlin/shared');
const config = require('../config');
const { floorOf } = require('../floors');
const {
  makeRng,
  ROSTER,
  GUESTS,
  TASK_TITLES,
  FILES,
  SUBJECTS,
  CONTENTS,
} = require('./data');

const SERVER_VERSION = '0.1.0';
const MESSAGE_COUNT = 220;

/**
 * The demo main-Agent phase timeline. It deliberately uses only phases the real console can show;
 * a completed / cancelled round is not part of the demo because the virtual session stays running
 * while demo mode is active.
 *
 * The browser must not copy these labels or timings: every response rebuilds `session.phase` from
 * this table, so the ticker suffix and the main console both read the same server truth.
 */
const PHASE_SCRIPT = [
  {
    phase: 'thinking',
    action: '正在分析你的请求',
    context: ['任务：重构用户登录模块', '思考：先理清登录链路'],
    prompt: '请帮我重构用户登录模块，先理清登录链路',
    tool: '',
    target: null,
    ms: 6000,
  },
  {
    phase: 'tool',
    action: '正在读取 src/auth/session.js',
    context: ['进度：已读取 3 个文件', '命中：7 处引用'],
    prompt: '',
    tool: 'mcp: filesystem.read_file',
    target: null,
    ms: 5000,
  },
  {
    phase: 'dispatch',
    action: '正在召唤 Coder 专家',
    context: ['任务：重构用户登录模块', '委托：Coder 改写登录逻辑'],
    prompt: '',
    tool: '',
    target: 'A1',
    ms: 5200,
  },
  {
    phase: 'tool',
    action: '正在执行构建脚本',
    context: ['进度：跑 npm run build', '校验：构建输出正常'],
    prompt: '',
    tool: 'bash: npm run build',
    target: null,
    ms: 4800,
  },
  {
    phase: 'await',
    action: '申请写入 renderer/vite.config.js',
    context: ['等待用户授权后继续', '原因：修改构建基路径 base'],
    prompt: '',
    tool: 'mcp: filesystem.write_file',
    target: 'renderer/vite.config.js',
    ms: 5000,
  },
  {
    phase: 'thinking',
    action: '正在整理本轮改动',
    context: ['已交付：登录链路重构', '改动 3 个文件'],
    prompt: '',
    tool: '',
    target: null,
    ms: 5000,
  },
];

const CYCLE_MS = PHASE_SCRIPT.reduce((sum, step) => sum + step.ms, 0);

/** @param {number} startedAt @param {number} now */
function phaseAt(startedAt, now) {
  let offset = Math.max(0, now - startedAt) % CYCLE_MS;
  for (const step of PHASE_SCRIPT) {
    if (offset < step.ms) return step;
    offset -= step.ms;
  }
  return PHASE_SCRIPT[0];
}

/** Demo member id: `name@__demo__`, matching the ordinary member-id convention. */
function memberIdOf(name) {
  return String(name).includes('@') ? String(name) : `${name}@${DEMO_PROJECT_ID}`;
}

/** Progress advances slowly so the demo is alive without mutating any table. */
function progressOf(base, startedAt, now) {
  if (base == null) return null;
  const minutes = Math.max(0, now - startedAt) / 60_000;
  return Math.min(0.96, Number(base) + minutes * 0.01);
}

function artifact(memberId, title, path, tsMs) {
  return {
    id: null,
    memberId,
    taskId: null,
    kind: 'text',
    title,
    path,
    tsMs,
  };
}

/**
 * Build one member card. The shape is the same as bus.buildMemberCard, so the office's normal
 * floor / session filtering and WorkstationCard can consume it without demo-specific branches.
 */
function memberCard({ row, client, sessionId, startedAt, now, ephemeral = false, projectLabel = null }) {
  const id = memberIdOf(row.name);
  const hasTask = row.state === 'busy' || row.state === 'blocked';
  const taskStartedAt = hasTask ? startedAt - 240_000 : null;
  const files = hasTask ? FILES[row.name] || [] : [];
  const tasks = hasTask
    ? [
        {
          id: `demo:${row.name}`,
          title: TASK_TITLES[row.name] || row.role || row.name,
          progress: progressOf(row.progress, taskStartedAt, now),
          startedAt: taskStartedAt,
          endedAt: null,
          state: 'running',
          sessionId,
          files,
        },
      ]
    : [];
  const sessionStatuses =
    row.state === 'blocked'
      ? [{ sessionId, state: 'blocked', stateSince: taskStartedAt }]
      : [];
  const stateSince = hasTask ? taskStartedAt : startedAt - 3_600_000;
  const card = {
    memberId: id,
    name: row.name,
    role: row.role,
    state: row.state,
    stateSince,
    agentState: 'idle',
    agentStateSince: null,
    tasks,
    sessionStatuses,
    currentFiles: files,
    artifacts: ephemeral
      ? [artifact(id, `${row.name} 已完成本轮演示任务`, 'workgremlin:summary', now - 8_000)]
      : [],
    lastTaskAt: hasTask ? taskStartedAt : null,
    lastTaskAtBySession: hasTask ? [{ sessionId, at: taskStartedAt }] : [],
    reported: Boolean(row.reported),
    messageCount: 0,
    ephemeral,
    projectLabel,
    project: DEMO_PROJECT_ID,
    client,
    sessionId,
    level: null,
    description: '',
    createdAt: startedAt - 3_600_000,
  };
  return card;
}

/**
 * Demo member tasks deliberately have **no independent task-level phase state machine**. A busy /
 * blocked member keeps its task title, progress and state for the lifetime of the demo; only the
 * session-level phase cycles (PHASE_SCRIPT). The office consumes member state + task progress, so
 * adding a second phase timeline per task would not change any visible behavior.
 */
function liveMembers(state, now) {
  const roster = ROSTER.map((row) =>
    memberCard({
      row,
      client: state.client,
      sessionId: state.sessionId,
      startedAt: state.startedAt,
      now,
    })
  );
  const guests = GUESTS.map((row) =>
    memberCard({
      row,
      client: state.client,
      sessionId: state.sessionId,
      startedAt: state.startedAt,
      now,
      ephemeral: true,
      projectLabel: String(row.role || '').replace(/^临时项目\s*[·:：\-]?\s*/, '').trim(),
    })
  );
  return roster.concat(guests);
}

/** The ordinary Message shape (bus.toMessage), generated once per demo start. */
function buildMessages(state) {
  const rng = makeRng(1);
  const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];
  const names = ROSTER.map((row) => row.name);
  const items = [];
  for (let i = 0; i < MESSAGE_COUNT; i += 1) {
    const from = pick(names);
    let to = pick(names);
    if (to === from) to = names[(names.indexOf(from) + 1) % names.length];
    items.push({
      id: i + 1,
      projectId: DEMO_PROJECT_ID,
      tsMs: state.startedAt - (MESSAGE_COUNT - i) * 20_000,
      fromMember: from,
      toMember: to,
      type: pick(['task_assign', 'task_update', 'result', 'question', 'block', 'review']),
      subject: pick(SUBJECTS),
      content: pick(CONTENTS),
      taskId: null,
      sessionId: state.sessionId,
      source: 'report',
      rawJson: null,
    });
  }
  items.push({
    id: MESSAGE_COUNT + 1,
    projectId: DEMO_PROJECT_ID,
    tsMs: state.startedAt - 10_000,
    fromMember: 'system',
    toMember: null,
    type: 'system',
    subject: '环境异常',
    content: 'better-sqlite3 ABI 不匹配：已触发 electron-rebuild。',
    taskId: null,
    sessionId: state.sessionId,
    source: 'report',
    rawJson: null,
  });
  return items;
}

function createState(floor) {
  const mod = floorOf(floor);
  if (!mod) throw new Error(`unknown floor: ${floor}`);
  const startedAt = Date.now();
  const state = {
    floor,
    client: String((mod.meta && mod.meta.agent) || ''),
    sessionId: DEMO_SESSION_ID,
    projectId: DEMO_PROJECT_ID,
    startedAt,
    messages: [],
  };
  state.messages = buildMessages(state);
  return state;
}

function buildSession(state, now) {
  const step = phaseAt(state.startedAt, now);
  return {
    id: state.sessionId,
    sessionId: state.sessionId,
    floor: state.floor,
    client: state.client,
    source: 'demo',
    form: 'demo',
    project: config.DEMO_PROJECT_NAME,
    projectId: state.projectId,
    projectName: config.DEMO_PROJECT_NAME,
    projectPath: '',
    live: true,
    mine: true,
    current: true,
    active: true,
    phase: step.phase,
    action: step.action || '',
    context: Array.isArray(step.context) ? step.context.slice() : [],
    target: step.target || null,
    tool: step.tool || '',
    prompt: step.prompt || '',
    inferred: false,
    instrumented: false,
    taskState: 'running',
    taskTitle: '演示：重构用户登录模块',
    taskStartedAt: state.startedAt,
    doneAt: 0,
    doneTitle: '',
    doneCount: 0,
    doneFiles: [],
    doneCancelled: false,
    lastEventAt: now,
    firstSeenAt: state.startedAt,
  };
}

function buildSnapshot(state, now, listProjects) {
  const demoProject = {
    id: state.projectId,
    name: config.DEMO_PROJECT,
    workspacePath: '',
    mainConversationId: 'demo-conversation',
    source: 'report',
    createdAt: state.startedAt,
    projectName: config.DEMO_PROJECT_NAME,
  };
  let real = [];
  try {
    real = (listProjects() || []).filter((p) => p && p.id !== state.projectId);
  } catch {
    real = [];
  }
  return {
    project: demoProject,
    projects: [demoProject, ...real],
    members: liveMembers(state, now),
    projectName: config.DEMO_PROJECT_NAME,
    recentMessages: state.messages.slice(-DEFAULTS.MESSAGE_WINDOW),
    serverTime: now,
    serverVersion: SERVER_VERSION,
  };
}

/**
 * @param {{listProjects?: () => Array<object>}} [opts]
 */
function createDemoProvider({ listProjects = () => [] } = {}) {
  /**
   * There is exactly **one** demo session per server process. The virtual session id is fixed and
   * the renderer can only show one demo at a time, so starting a demo on another floor replaces
   * the previous one instead of leaving unreachable in-memory demos behind.
   * @type {ReturnType<typeof createState>|null}
   */
  let active = null;

  function start(floor) {
    const state = createState(floor);
    active = state;
    const now = Date.now();
    return {
      session: buildSession(state, now),
      snapshot: buildSnapshot(state, now, listProjects),
    };
  }

  function get(floor, sessionId) {
    if (!active) return null;
    if (String(floor || '') !== active.floor) return null;
    if (sessionId && String(sessionId) !== active.sessionId) return null;
    const now = Date.now();
    return {
      session: buildSession(active, now),
      members: liveMembers(active, now),
    };
  }

  function stop(floor) {
    if (!active || String(floor || '') !== active.floor) return false;
    active = null;
    return true;
  }

  function stopAll() {
    const had = Boolean(active);
    active = null;
    return had;
  }

  return { start, get, stop, stopAll };
}

module.exports = { createDemoProvider, PHASE_SCRIPT };
