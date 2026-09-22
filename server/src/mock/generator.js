'use strict';

/**
 * 演示数据生成器：给「演示工程」灌一套可看的假数据（成员 / 任务 / 消息）。
 *
 * 触发时机：**不再有启动开关**（原 `--demo` / `WORKGREMLIN_DEMO=1` / `MOCK=1` 已移除）。
 * 它只由「切到演示工程」这一个动作触发 —— 界面 HUD 上的「演示模式」按钮 →
 * POST /api/v1/workspace（空路径）→ openDemo → index.js 的 syncDemo 按需播种 + 起推进器。
 *
 * 硬性要求（tester DEMO-01~07）：
 *   - **确定性**：相同 seed 必须产出完全一致的数据（含时间戳），否则 DOM 快照会 flaky；
 *   - 覆盖 5 种主状态，且至少 1 个 degraded、1 个 blocked、1 条 error 级消息；
 *   - 消息数 >= 200。
 *
 * 时间基准：默认**锚定当前时间**（各事件相对偏移固定），否则「已耗时」会显示成 —、
 * 心跳超时也不会触发 degraded。需要绝对时间可复现（DOM 快照测试）时设
 * `WORKGREMLIN_DEMO_FIXED_TS=1`，退回到固定的 UTC 基准。
 */

const { MESSAGE_TYPES } = require('@workgremlin/shared');
const config = require('../config');

/** mulberry32：小而确定的 PRNG */
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
  { name: 'ops', role: '构建与部署', state: 'offline', progress: null, reported: 0 }, // 未接上报 -> degraded
];

/**
 * 临时组队成员（GUESTS）：为某个项目临时拉进来的 agent。
 *
 * 判定靠 `ghost-` 前缀（见 shared.isEphemeralMember），UI 里是"幽灵"——
 * 不占工位、飘在空中；role 即所属项目名，显示在它头顶。
 */
const GUESTS = [
  { name: 'ghost-search', role: '临时项目 · 搜索重构', state: 'busy', progress: 0.44, reported: 1 },
  { name: 'ghost-i18n', role: '临时项目 · 多语言文案', state: 'idle', progress: null, reported: 1 },
];

/** 专家 + 临时成员：注册/心跳/任务都按这份名单来 */
const ALL_MEMBERS = ROSTER.concat(GUESTS);

/**
 * 演示种子成员的名字集合。
 *
 * 供启动清理用：老版本里演示 project 叫 workgremlin，和真实工程撞名，
 * 这些名字被写进了真实工程的 project；演示 project 改名后需要把它们从真实 project 里摘掉。
 * （注意：若某名字同时是工程里**已定义 subagent**（如 coder），说明那已是真实成员，不清。）
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
 * 生成演示数据。
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
      // 未接上报：状态行打 degraded，UI 必须灰显并标注"推断"
      bus.heartbeat({ project, memberId, state: r.state, ts: t0 - 3 * 60_000 });
      bus.raw && bus.raw;
    }
  }

  // 为每个 busy 成员建一条任务
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

  // 给 leader 那轮任务挂几个 subagent，演示"多次 subagent 调用 → 点开看单个"的能力
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

  // blocked 成员额外写一条原因
  bus.setStatus({
    project,
    memberId: 'reviewer',
    state: 'blocked',
    reason: '等待 FTS 分词器决策（trigram vs unicode61）',
    ts: t0 - 120_000,
  });

  // >=200 条确定性消息
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

  // 一条 error 级系统消息
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

  // ops 是"未接上报"的成员：把它的状态标成 degraded（模拟心跳超时）
  bus.sweepDegraded && bus.sweepDegraded();
  return { project, seed, members: ALL_MEMBERS.length, messages: count + 1, baseTs: t0 };
}

/**
 * demo 心跳推进器：让演示团队"活着"。
 *
 * 只在 seed 时灌一次心跳的话，60s 后所有成员都会因超时被标 degraded，
 * 界面全灰——调试可视化时看不到状态流动。因此 demo 模式下按固定间隔：
 *   - 已接上报的成员：刷新心跳（保持不 degraded）并缓慢推进进度；
 *   - 未接上报的成员（ops）：**故意不刷新**，用于持续演示 degraded 灰显。
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

  /** 找到成员当前进行中的任务（用于推进 tasks.progress，UI 进度条读的是这张表） */
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
