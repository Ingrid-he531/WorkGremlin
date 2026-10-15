'use strict';

/**
 * Demo data generator: fills the "demo project" with a viewable set of fake data
 * (members / tasks / messages).
 *
 * Trigger: there is **no startup switch anymore** (the old `--demo` / `WORKGREMLIN_DEMO=1` /
 * `MOCK=1` are gone). It is triggered only by the single action "switch to the demo project" ——
 * the "demo mode" button in the HUD → POST /api/v1/workspace (empty path) → openDemo → syncDemo in
 * index.js seeds on demand and starts the ticker.
 *
 * Hard requirements (tester DEMO-01~07):
 *   - **Deterministic**: the same seed must produce exactly identical data (timestamps included),
 *     otherwise DOM snapshots go flaky;
 *   - cover 5 main states, with at least 1 degraded, 1 blocked, and 1 error-level message;
 *   - message count >= 200.
 *
 * Time base: by default it is **anchored to the current time** (each event at a fixed relative
 * offset), otherwise "elapsed time" shows — and heartbeat timeouts never trigger degraded. When an
 * absolutely reproducible time is needed (DOM snapshot tests), set `WORKGREMLIN_DEMO_FIXED_TS=1`
 * to fall back to the fixed UTC base.
 */

const { MESSAGE_TYPES } = require('@workgremlin/shared');
const config = require('../config');

/** mulberry32: small and deterministic PRNG */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROSTER = [
  { name: 'leader', role: '任务拆解与派发', state: 'online', progress: null, reported: 1 },
  { name: 'researcher', role: '需求与技术调研', state: 'busy', progress: 0.62, reported: 1 },
  { name: 'coder', role: '编码实现', state: 'busy', progress: 0.38, reported: 1 },
  { name: 'tester', role: '测试与验收', state: 'idle', progress: null, reported: 1 },
  { name: 'reviewer', role: '代码评审', state: 'blocked', progress: 0.2, reported: 1 },
  { name: 'ops', role: '构建与部署', state: 'offline', progress: null, reported: 0 }, // no reporter attached -> degraded
];

/**
 * Temporary team members (GUESTS): agents pulled into a project temporarily.
 *
 * They are recognized by the `ghost-` prefix (see shared.isEphemeralMember) and appear in the UI as
 * "ghosts" —— taking no workstation and floating in the air; role is the project name they belong
 * to, shown above their head.
 */
const GUESTS = [
  { name: 'ghost-search', role: '临时项目 · 搜索重构', state: 'busy', progress: 0.44, reported: 1 },
  { name: 'ghost-i18n', role: '临时项目 · 多语言文案', state: 'idle', progress: null, reported: 1 },
];

/** Experts + temporary members: registration / heartbeat / tasks all follow this list */
const ALL_MEMBERS = ROSTER.concat(GUESTS);

/**
 * Name set of the demo seed members.
 *
 * Used for startup cleanup: in older versions the demo project was named workgremlin, colliding
 * with a real project, and these names were written into the real project; after renaming the demo
 * project they have to be removed from the real project.
 * (Note: if a name is also a **defined subagent** in the project (e.g. coder), it is already a real
 * member and is not removed.)
 */
const DEMO_MEMBER_NAMES = new Set(ALL_MEMBERS.map((m) => m.name));

const TASK_TITLES = {
  leader: '拆解 M1 任务并派发',
  researcher: '调研 .codebuddy/projects 数据格式',
  coder: '实现工位视图与对话记录窗口',
  tester: '编写 M0 验收用例',
  reviewer: '评审数据模型与协议定义',
  ops: '搭建本地打包流水线',
  'ghost-search': '搜索重构：补齐倒排索引',
  'ghost-i18n': '多语言文案校对（zh/en）',
};

const FILES = {
  leader: ['docs/tech-design.md', 'docs/roadmap.md'],
  researcher: ['docs/research/codebuddy-format.md', 'fixtures/projects-sample/config.json'],
  coder: [
    'renderer/src/components/WorkstationCard.vue',
    'renderer/src/views/ConversationView.vue',
    'server/src/ingest/bus.js',
  ],
  tester: ['docs/test-strategy.md', 'tests/e2e/m0.spec.js'],
  reviewer: ['server/src/db/schema.sql'],
  ops: ['scripts/build.js', 'electron-builder.yml'],
  'ghost-search': ['server/src/db/schema.sql', 'server/src/http/routes/snapshot.js'],
  'ghost-i18n': ['renderer/src/styles/theme.css'],
};

const SUBJECTS = [
  '任务派发',
  '进度同步',
  '阻塞求助',
  '产出交付',
  '评审意见',
  '环境异常',
  '结论同步',
];

const CONTENTS = [
  '已按 M0 清单拆好子任务，请认领各自模块。',
  '当前进度 60%，预计还需要 30 分钟完成解析层。',
  '这里我卡住了：schema 里的 FTS 分词器需要先定死，否则 M2 要重建索引。',
  '产出已提交，路径见附件，请查收。',
  '评审通过，但 secure_delete 需要补充双连接方案的说明。',
  '构建环境报错：better-sqlite3 ABI 不匹配，需要 electron-rebuild。',
  '结论：A+B 混合，以 B 为真值，A 仅兜底。',
];

/**
 * Generate demo data.
 * @param {{bus: any, seed?: number, project?: string, workspacePath?: string, baseTs?: number}} opts
 */
function seedDemoData({ bus, seed = 1, project = config.DEMO_PROJECT, workspacePath = '/demo/workspace', baseTs }) {
  const rng = makeRng(seed);
  const t0 = Number.isFinite(baseTs)
    ? Number(baseTs)
    : process.env.WORKGREMLIN_DEMO_FIXED_TS === '1'
      ? Date.UTC(2026, 8, 14, 9, 0, 0)
      : Date.now();
  const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];

  bus.ensureProject(project, workspacePath, 'demo-conversation', 'report');

  for (const r of ALL_MEMBERS) {
    const memberId = bus.registerMember({ project, name: r.name, role: r.role });
    const files = FILES[r.name] || [];
    if (r.reported) {
      bus.heartbeat({
        project,
        memberId,
        state: r.state,
        progress: r.progress,
        files,
        ts: t0 - Math.floor(rng() * 60_000),
      });
    } else {
      // No reporter attached: the state row is flagged degraded, and the UI must gray it out and
      // label it "inferred"
      bus.heartbeat({ project, memberId, state: r.state, ts: t0 - 3 * 60_000 });
      bus.raw && bus.raw;
    }
  }

  // Create one task for each busy member
  let leaderTaskId = null;
  for (const r of ALL_MEMBERS) {
    if (r.state !== 'busy') continue;
    const started = bus.startTask({
      project,
      memberId: r.name,
      title: TASK_TITLES[r.name],
      progress: r.progress,
      files: FILES[r.name] || [],
      ts: t0 - Math.floor(rng() * 600_000) - 600_000,
    });
    if (started.ok) {
      bus.taskProgress({
        project,
        memberId: r.name,
        taskId: started.taskId,
        progress: r.progress,
        ts: t0 - Math.floor(rng() * 300_000),
      });
      if (r.name === 'leader') leaderTaskId = started.taskId;
    }
  }

  // Attach a few subagents to the leader's round, to demo "multiple subagent calls → click to see one"
  if (leaderTaskId) {
    const subs = [
      { name: 'researcher', title: '调研 .codebuddy/projects 数据格式', result: '产出调研报告一份，字段与 schema 对齐', model: 'claude-opus-4' },
      { name: 'coder', title: '实现工位视图与对话记录窗口', result: '落地 WorkstationCard.vue 与列表渲染', model: 'claude-sonnet-4' },
      { name: 'reviewer', title: '代码评审与回归校验', result: '无阻断性问题，仅 2 条建议', model: 'claude-opus-4' },
    ];
    subs.forEach((s, i) => {
      const id = bus.startSubagentRun({
        project,
        memberId: `subagent-${s.name}@${project}`,
        name: s.name,
        parentTaskId: leaderTaskId,
        taskId: leaderTaskId,
        title: s.title,
        model: s.model,
        client: 'codebuddy',
        startedAt: t0 - (subs.length - i) * 120_000,
      });
      if (id) {
        bus.endSubagentRun({
          id,
          result: s.result,
          model: s.model,
          client: 'codebuddy',
          endedAt: t0 - (subs.length - i) * 120_000 + 90_000,
        });
      }
    });
  }

  // Write an extra reason line for the blocked member
  bus.setStatus({
    project,
    memberId: 'reviewer',
    state: 'blocked',
    reason: '等待 FTS 分词器决策（trigram vs unicode61）',
    ts: t0 - 120_000,
  });

  // >=200 deterministic messages
  const names = ROSTER.map((r) => r.name);
  const count = 220;
  for (let i = 0; i < count; i += 1) {
    const from = names[Math.floor(rng() * names.length) % names.length];
    let to = names[Math.floor(rng() * names.length) % names.length];
    if (to === from) to = names[(names.indexOf(from) + 1) % names.length];
    const ts = t0 - (count - i) * 20_000;
    const isError = i === count - 3;
    bus.recordMessage({
      project,
      from,
      to,
      type: isError ? 'block' : pick(MESSAGE_TYPES),
      subject: isError ? '环境异常' : pick(SUBJECTS),
      content: isError ? CONTENTS[5] : pick(CONTENTS),
      ts,
      source: 'report',
    });
  }

  // One error-level system message
  bus.recordMessage({
    project,
    from: 'system',
    to: null,
    type: 'system',
    subject: '环境异常',
    content: 'better-sqlite3 ABI 不匹配：已触发 electron-rebuild。',
    ts: t0 - 10_000,
    source: 'report',
  });

  // ops is the "no reporter attached" member: mark its state degraded (simulating heartbeat timeout)
  bus.sweepDegraded && bus.sweepDegraded();
  return { project, seed, members: ALL_MEMBERS.length, messages: count + 1, baseTs: t0 };
}

/**
 * Demo heartbeat ticker: keeps the demo team "alive".
 *
 * Seeding heartbeats only once would leave every member marked degraded after 60s of timeout and
 * the UI would go all gray —— you cannot watch state flow while debugging the visualization. So in
 * demo mode, at a fixed interval:
 *   - Members with a reporter attached: refresh the heartbeat (stay degraded-free) and slowly push
 *     progress forward;
 *   - Members without one (ops): **deliberately not refreshed**, to keep demonstrating grayed-out
 *     degraded state.
 *
 * @param {{bus: any, repo?: any, project?: string, intervalMs?: number, seed?: number}} opts
 */
function createDemoTicker({ bus, repo, project = config.DEMO_PROJECT, intervalMs = 5_000, seed = 1 }) {
  const rng = makeRng((Number(seed) || 1) ^ 0x9e3779b9);
  const reported = ALL_MEMBERS.filter((r) => r.reported);
  const progress = new Map(
    ALL_MEMBERS.filter((r) => Number.isFinite(r.progress)).map((r) => [r.name, r.progress])
  );
  let timer = null;

  /** Find the member's currently running task (to advance tasks.progress; the UI progress bar reads that table) */
  function runningTaskId(memberId) {
    if (!repo) return null;
    const rows = repo.listTasks.all(project) || [];
    const hit = rows.find((t) => t.member_id === memberId && t.state === 'running');
    return hit ? hit.id : null;
  }

  function tick() {
    for (const r of reported) {
      const ts = Date.now();
      const memberId = `${r.name}@${project}`;
      const cur = progress.get(r.name);

      if (r.state === 'busy' && cur != null) {
        const next = Math.min(0.99, cur + rng() * 0.012);
        progress.set(r.name, next);
        const taskId = runningTaskId(memberId);
        if (taskId) {
          bus.taskProgress({ project, memberId: r.name, taskId, progress: next, files: FILES[r.name] || [], ts });
          continue;
        }
      }
      bus.heartbeat({ project, memberId: r.name, state: r.state, files: FILES[r.name] || [], ts });
    }
  }

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { seedDemoData, createDemoTicker, makeRng, DEMO_MEMBER_NAMES };
