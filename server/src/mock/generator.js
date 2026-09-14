'use strict';

/**
 * 演示 / Mock 数据生成器（M0 用于两个界面的静态渲染）。
 *
 * 硬性要求（tester DEMO-01~07）：
 *   - **确定性**：相同 seed 必须产出完全一致的数据（含时间戳），否则 DOM 快照会 flaky；
 *   - 覆盖 5 种主状态，且至少 1 个 degraded、1 个 blocked、1 条 error 级消息；
 *   - 消息数 >= 200。
 *
 * 时间基准：默认**锚定当前时间**（各事件相对偏移固定），否则「已耗时」会显示成 —、
 * 心跳超时也不会触发 degraded。需要绝对时间可复现（DOM 快照测试）时设
 * `WORKGREMLIN_DEMO_FIXED_TS=1`，退回到固定的 UTC 基准。
 *
 * M1 接入真实数据源后本文件即被 watcher + reporter 取代，不再用于生产逻辑。
 */

const { MESSAGE_TYPES } = require('@workgremlin/shared');

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

const TASK_TITLES = {
  leader: '拆解 M1 任务并派发',
  researcher: '调研 .codebuddy/teams 数据格式',
  coder: '实现工位视图与对话记录窗口',
  tester: '编写 M0 验收用例',
  reviewer: '评审数据模型与协议定义',
  ops: '搭建本地打包流水线',
};

const FILES = {
  leader: ['docs/tech-design.md', 'docs/roadmap.md'],
  researcher: ['docs/research/codebuddy-format.md', 'fixtures/teams-sample/config.json'],
  coder: [
    'renderer/src/components/WorkstationCard.vue',
    'renderer/src/views/ConversationView.vue',
    'server/src/ingest/bus.js',
  ],
  tester: ['docs/test-strategy.md', 'tests/e2e/m0.spec.js'],
  reviewer: ['server/src/db/schema.sql'],
  ops: ['scripts/build.js', 'electron-builder.yml'],
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
 * @param {{bus: any, seed?: number, team?: string, workspacePath?: string, baseTs?: number}} opts
 */
function seedDemoData({ bus, seed = 1, team = 'workgremlin', workspacePath = '/demo/workspace', baseTs }) {
  const rng = makeRng(seed);
  const t0 = Number.isFinite(baseTs)
    ? Number(baseTs)
    : process.env.WORKGREMLIN_DEMO_FIXED_TS === '1'
      ? Date.UTC(2026, 8, 14, 9, 0, 0)
      : Date.now();
  const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];

  bus.ensureTeam(team, workspacePath, 'demo-conversation', 'report');

  for (const r of ROSTER) {
    const memberId = bus.registerMember({ team, name: r.name, role: r.role });
    const files = FILES[r.name] || [];
    if (r.reported) {
      bus.heartbeat({
        team,
        memberId,
        state: r.state,
        progress: r.progress,
        files,
        ts: t0 - Math.floor(rng() * 60_000),
      });
    } else {
      // 未接上报：状态行打 degraded，UI 必须灰显并标注"推断"
      bus.heartbeat({ team, memberId, state: r.state, ts: t0 - 3 * 60_000 });
      bus.raw && bus.raw;
    }
  }

  // 为每个 busy 成员建一条任务
  for (const r of ROSTER) {
    if (r.state !== 'busy') continue;
    const started = bus.startTask({
      team,
      memberId: r.name,
      title: TASK_TITLES[r.name],
      progress: r.progress,
      files: FILES[r.name] || [],
      ts: t0 - Math.floor(rng() * 600_000) - 600_000,
    });
    if (started.ok) {
      bus.taskProgress({
        team,
        memberId: r.name,
        taskId: started.taskId,
        progress: r.progress,
        ts: t0 - Math.floor(rng() * 300_000),
      });
    }
  }

  // blocked 成员额外写一条原因
  bus.setStatus({
    team,
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
      team,
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
    team,
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
  return { team, seed, members: ROSTER.length, messages: count + 1, baseTs: t0 };
}

/**
 * demo 心跳推进器：让演示团队"活着"。
 *
 * 只在 seed 时灌一次心跳的话，60s 后所有成员都会因超时被标 degraded，
 * 界面全灰——调试可视化时看不到状态流动。因此 demo 模式下按固定间隔：
 *   - 已接上报的成员：刷新心跳（保持不 degraded）并缓慢推进进度；
 *   - 未接上报的成员（ops）：**故意不刷新**，用于持续演示 degraded 灰显。
 *
 * @param {{bus: any, repo?: any, team?: string, intervalMs?: number, seed?: number}} opts
 */
function createDemoTicker({ bus, repo, team = 'workgremlin', intervalMs = 5_000, seed = 1 }) {
  const rng = makeRng((Number(seed) || 1) ^ 0x9e3779b9);
  const reported = ROSTER.filter((r) => r.reported);
  const progress = new Map(
    ROSTER.filter((r) => Number.isFinite(r.progress)).map((r) => [r.name, r.progress])
  );
  let timer = null;

  /** 找到成员当前进行中的任务（用于推进 tasks.progress，UI 进度条读的是这张表） */
  function runningTaskId(memberId) {
    if (!repo) return null;
    const rows = repo.listTasks.all(team) || [];
    const hit = rows.find((t) => t.member_id === memberId && t.state === 'running');
    return hit ? hit.id : null;
  }

  function tick() {
    for (const r of reported) {
      const ts = Date.now();
      const memberId = `${r.name}@${team}`;
      const cur = progress.get(r.name);

      if (r.state === 'busy' && cur != null) {
        const next = Math.min(0.99, cur + rng() * 0.012);
        progress.set(r.name, next);
        const taskId = runningTaskId(memberId);
        if (taskId) {
          bus.taskProgress({ team, memberId: r.name, taskId, progress: next, files: FILES[r.name] || [], ts });
          continue;
        }
      }
      bus.heartbeat({ team, memberId: r.name, state: r.state, files: FILES[r.name] || [], ts });
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

module.exports = { seedDemoData, createDemoTicker, makeRng };
