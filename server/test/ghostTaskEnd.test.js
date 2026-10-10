'use strict';
/**
 * 任务终止 → 它召唤出去的幽灵跟着散掉（2026-10-10 实测：CodeBuddy CLI 里按 ESC 掐掉一轮，
 * 幽灵还在办公室里飘）。
 *
 * 病因：幽灵唯一的"优雅退场"是 hook 侧的扫场（Stop / FinalStop / UserPromptSubmit /
 * SessionEnd → sweepGhosts），**只在事件到达时才发生**。而召唤它的那轮任务一终止，
 * 服务端其实就已经知道了（task/end 落地、tasks.state 不再是 running）—— 这条真值一直没被
 * 用上。实测 2026-09-27：05:29 召唤的三只幽灵，到 05:45 的 Stop 才被扫掉两只，
 * 中间 16 分钟一直飘在屋里。
 *
 * 修法：subagentFeed 每趟 sync 顺手认一次父任务 —— 条目上的 `parent` 对应的任务
 * 已经收工（done / cancelled / failed）且这只自己从没收过工（没写 result）→ 当场从清单
 * 里摘掉，幽灵散掉。只晚一轮轮询（2s），且不再依赖任何 hook 事件。
 *
 * 盯四件事：
 *   [1] 父任务还在跑 → 幽灵留着（绝不误伤还在干活的）；
 *   [2] 父任务收工（cancelled）→ 孤儿幽灵从清单摘掉、办公室里的成员也退掉；
 *   [3] 已经收工待汇报的那只（写了 result）→ **保住**（汇报动画还没播完）；
 *   [4] 认不出父任务的（没 parent / 查不到任务行）→ 保住（不臆断）。
 *
 * 跑法：`npm run test:ghost-task-end`（零依赖，用假 bus / 假 repo 直接跑真实的 sync）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ghost-task-end-'));
const FEED = path.join(TMP, 'subagents.json');
process.env.WORKGREMLIN_SUBAGENTS_FILE = FEED;

const { createSubagentFeed } = require('../src/ingest/subagentFeed');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 bus：只记调用（不碰数据库） */
function makeBus() {
  return {
    removed: [],
    memberIdOf: (project, memberId) => `${memberId}@${project}`,
    tagMemberClient: () => {},
    registerMember: () => {},
    currentMainTaskId: () => '',
    heartbeat: () => {},
    removeMember: ({ memberId }) => {
      busRef.removed.push(memberId);
    },
    taskProgress: () => {},
    startTask: ({ title }) => ({ taskId: `t_${title}` }),
    endTask: () => {},
    startSubagentRun: () => 1,
    endSubagentRun: () => {},
  };
}
let busRef = null;

/** 假 repo：父任务状态由测试驱动；屋里挂着一个临时成员（幽灵） */
function makeRepo(taskState) {
  const repo = {
    state: taskState, // 'running' | 'cancelled' | 'gone'
    listEphemeral: {
      // 服务端里幽灵就是这样一行临时成员；sync 靠它把"清单里已经没有的"退掉
      all: () => [{ id: 'subagent-Explore@P', name: 'Explore' }],
    },
  };
  repo.getTask = {
    get(id) {
      if (repo.state === 'gone') return undefined;
      return { id, state: repo.state, ended_at: repo.state === 'running' ? null : Date.now() };
    },
  };
  return repo;
}

function writeFeed(agents) {
  fs.writeFileSync(FEED, `${JSON.stringify({ project: 'P', agents }, null, 2)}\n`, 'utf8');
}
function readFeed() {
  try {
    return JSON.parse(fs.readFileSync(FEED, 'utf8'));
  } catch {
    return { project: '', agents: [] };
  }
}
const names = (feed) => (feed.agents || []).map((a) => `${a.name}${a.id ? `#${a.id}` : ''}`);

(async () => {
  console.log('任务终止 → 它召唤的幽灵跟着散掉');

  // [1] 父任务还在跑 → 幽灵留着（绝不误伤还在干活的）
  {
    writeFeed([
      { name: 'Explore', id: 'g1', state: 'busy', ts: Date.now(), client: 'codebuddy', task: 'review 代码', parent: 'parent-1' },
    ]);
    busRef = makeBus();
    const repo = makeRepo('running');
    const feed = createSubagentFeed({ bus: busRef, repo, project: 'P', workspacePath: TMP, intervalMs: 50 });
    feed.start();
    await sleep(200);
    ok('[1] 父任务还在跑 → 清单里的幽灵留着', names(readFeed()).includes('Explore#g1'), JSON.stringify(names(readFeed())));
    ok('[1] 办公室里的成员也没被退掉', busRef.removed.length === 0, JSON.stringify(busRef.removed));
    feed.stop();
  }

  // [2] 父任务收工（cancelled）→ 孤儿幽灵当场散掉
  {
    writeFeed([
      { name: 'Explore', id: 'g1', state: 'busy', ts: Date.now(), client: 'codebuddy', task: 'review 代码', parent: 'parent-1' },
    ]);
    busRef = makeBus();
    const repo = makeRepo('cancelled');
    const feed = createSubagentFeed({ bus: busRef, repo, project: 'P', workspacePath: TMP, intervalMs: 50 });
    feed.start();
    await sleep(200);
    ok('[2] 父任务收工 → 清单里的幽灵被摘掉', !names(readFeed()).includes('Explore#g1'), JSON.stringify(names(readFeed())));
    ok('[2] 办公室里的成员也退掉了', busRef.removed.includes('subagent-Explore@P'), JSON.stringify(busRef.removed));
    feed.stop();
  }

  // [3] 已经收工待汇报的那只（写了 result）→ 保住：汇报动画还没播完
  {
    writeFeed([
      { name: 'Explore', id: 'g2', state: 'idle', ts: Date.now(), client: 'codebuddy', task: 'review 代码', parent: 'parent-1', result: '看完了，三处可改' },
    ]);
    busRef = makeBus();
    const repo = makeRepo('cancelled');
    const feed = createSubagentFeed({ bus: busRef, repo, project: 'P', workspacePath: TMP, intervalMs: 50 });
    feed.start();
    await sleep(200);
    ok('[3] 待汇报的那只被保住（父任务收工也不许掐掉汇报）', names(readFeed()).includes('Explore#g2'), JSON.stringify(names(readFeed())));
    feed.stop();
  }

  // [4] 认不出父任务的（没 parent / 查不到任务行）→ 保住：不臆断"它收工了"
  {
    writeFeed([
      { name: 'NoParent', id: 'g3', state: 'busy', ts: Date.now(), client: 'codebuddy', task: '没有 parent' },
      { name: 'LostParent', id: 'g4', state: 'busy', ts: Date.now(), client: 'codebuddy', task: '父任务查不到', parent: 'parent-404' },
    ]);
    busRef = makeBus();
    const repo = makeRepo('gone');
    const feed = createSubagentFeed({ bus: busRef, repo, project: 'P', workspacePath: TMP, intervalMs: 50 });
    feed.start();
    await sleep(200);
    const left = names(readFeed());
    ok('[4] 没写 parent 的保住', left.includes('NoParent#g3'), JSON.stringify(left));
    ok('[4] 父任务查不到的保住', left.includes('LostParent#g4'), JSON.stringify(left));
    feed.stop();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
