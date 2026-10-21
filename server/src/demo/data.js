'use strict';

/**
 * Static demo data definitions.
 *
 * This module contains **no writer**: the old seeder / ticker used to turn these rows into real
 * `projects` / `members` / `tasks` / `messages` writes. Demo mode now only reads them while building
 * an in-memory snapshot (see provider.js), so importing this file can never touch the office tables.
 */

/** mulberry32: small and deterministic PRNG */
function makeRng(seed) {
  let a = (Number(seed) || 1) >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROSTER = [
  { name: 'leader', role: '任务拆解与派发', state: 'idle', progress: null, reported: 1 },
  { name: 'researcher', role: '需求与技术调研', state: 'busy', progress: 0.62, reported: 1 },
  { name: 'coder', role: '编码实现', state: 'busy', progress: 0.38, reported: 1 },
  { name: 'tester', role: '测试与验收', state: 'idle', progress: null, reported: 1 },
  { name: 'reviewer', role: '代码评审', state: 'blocked', progress: 0.2, reported: 1 },
  { name: 'ops', role: '构建与部署', state: 'idle', progress: null, reported: 0 },
];

/**
 * Temporary team members (GUESTS): agents pulled into a project temporarily.
 *
 * They are recognized by the `ghost-` prefix (see shared.isEphemeralMember) and appear in the UI as
 * "ghosts" — taking no workstation and floating in the air; role is the project name they belong to.
 */
const GUESTS = [
  { name: 'ghost-search', role: '临时项目 · 搜索重构', state: 'busy', progress: 0.44, reported: 1 },
  { name: 'ghost-i18n', role: '临时项目 · 多语言文案', state: 'idle', progress: null, reported: 1 },
];

/** Experts + temporary members. */
const ALL_MEMBERS = ROSTER.concat(GUESTS);

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

module.exports = {
  makeRng,
  ROSTER,
  GUESTS,
  ALL_MEMBERS,
  TASK_TITLES,
  FILES,
  SUBJECTS,
  CONTENTS,
};
