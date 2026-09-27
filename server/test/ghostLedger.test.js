'use strict';
/**
 * 幽灵台账不重复记账（2026-09-27 实测：一只 peter 幽灵被记了 7 次）。
 *
 * 病因：subagentFeed 每 2s 扫一次清单。幽灵收工（条目写了 result）后，它还要在清单里
 * 再活 RETIRE_MS（10s）好播完"走到主 agent 面前汇报"那段动画 —— 而这 10s 里 sync() 每趟
 * 都会再进一次 `if (a.result)` 分支。上头刚 `tasks.delete(fullId)`，`known` 已经没了，
 * 于是每趟都走"从没开过任务行"那个兜底，补一行**空标题 / 无耗时**的 subagent_runs：
 *   · peter 那只：1 行真的 + 6 行空的（10s / 2s）；
 *   · 幽灵滞留在清单里更久的那次：同一只被记了 944 次。
 * 修法是给"收工"加一道闸：按**这一只**的身份（per-call id，没有才退名字）记一次就打住。
 * 键不能用 name —— 同名并发（三只都叫 Explore）会互相顶掉。
 *
 * 跑法：`npm run test:ghost-ledger`（零依赖，用假 bus / 假 repo 直接跑真实的 sync）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ghost-ledger-'));
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

/** 假 bus：只记调用次数与关键参数（不碰数据库） */
function makeBus() {
  const calls = { startTask: 0, endTask: 0, startRun: 0, endRun: 0, progress: 0 };
  const runTitles = [];
  let seq = 0;
  return {
    calls,
    runTitles,
    memberIdOf: (project, memberId) => `${memberId}@${project}`,
    tagMemberClient: () => {},
    registerMember: () => {},
    currentMainTaskId: () => 'parent-task',
    heartbeat: () => {},
    removeMember: () => {},
    taskProgress: () => {
      calls.progress += 1;
    },
    startTask: ({ title }) => {
      calls.startTask += 1;
      return { taskId: `task-${title || 'empty'}-${calls.startTask}` };
    },
    endTask: () => {
      calls.endTask += 1;
    },
    startSubagentRun: ({ title }) => {
      calls.startRun += 1;
      runTitles.push(title);
      seq += 1;
      return seq;
    },
    endSubagentRun: () => {
      calls.endRun += 1;
    },
  };
}

const repo = { listEphemeral: { all: () => [] } };

function writeFeed(agents) {
  fs.writeFileSync(FEED, `${JSON.stringify({ project: 'P', agents }, null, 2)}\n`, 'utf8');
}

(async () => {
  console.log('幽灵台账：收工只记一次');

  // [1] 一只幽灵：召唤 → 收工 → 之后连续轮询，台账不许再长
  {
    writeFeed([
      { name: 'peter', id: 'g1', state: 'busy', ts: Date.now(), client: 'codebuddy', task: '改 tooltip', sessionId: 's1' },
    ]);
    const bus = makeBus();
    const feed = createSubagentFeed({ bus, repo, project: 'P', workspacePath: TMP, intervalMs: 50 });
    feed.start();
    await sleep(150);
    ok('召唤阶段开了一行台账（带任务标题）', bus.calls.startRun === 1 && bus.runTitles[0] === '改 tooltip', JSON.stringify(bus.runTitles));

    // 收工：清单里写 result —— 这就是 RETIRE_MS 那段"还在清单里"的窗口
    writeFeed([
      { name: 'peter', id: 'g1', state: 'idle', ts: Date.now(), client: 'codebuddy', task: '改 tooltip', sessionId: 's1', result: '改完了' },
    ]);
    await sleep(400); // 覆盖 8 趟左右轮询（旧代码在这里每趟补一行）
    ok('收工只记一次（轮询 8 趟后台账没再长）', bus.calls.startRun === 1, `startRun=${bus.calls.startRun} titles=${JSON.stringify(bus.runTitles)}`);
    ok('收尾也是一次', bus.calls.endRun === 1, `endRun=${bus.calls.endRun}`);
    ok('没有补出空标题的兜底行', !bus.runTitles.includes(''), JSON.stringify(bus.runTitles));
    feed.stop();
  }

  // [2] 同名并发：两只都叫 Explore（不同 per-call id），各自的收工都要记上、且都只记一次。
  //     键若用 name，第二只的收工会被第一只的 retiring 顶掉 —— 它既记不上、也永远摘不出清单。
  {
    writeFeed([
      { name: 'Explore', id: 'e1', state: 'busy', ts: Date.now(), client: 'codebuddy', task: 'A', sessionId: 's1' },
      { name: 'Explore', id: 'e2', state: 'busy', ts: Date.now(), client: 'codebuddy', task: 'B', sessionId: 's1' },
    ]);
    const bus = makeBus();
    const feed = createSubagentFeed({ bus, repo, project: 'P', workspacePath: TMP, intervalMs: 50 });
    feed.start();
    await sleep(150);
    writeFeed([
      { name: 'Explore', id: 'e1', state: 'idle', ts: Date.now(), client: 'codebuddy', task: 'A', sessionId: 's1', result: 'A 完成' },
      { name: 'Explore', id: 'e2', state: 'idle', ts: Date.now(), client: 'codebuddy', task: 'B', sessionId: 's1', result: 'B 完成' },
    ]);
    await sleep(400);
    const before = bus.calls.startRun;
    ok('两只的收工都记上了', bus.calls.endRun === 2, `endRun=${bus.calls.endRun}`);
    await sleep(400);
    ok('两只都只记一次（再轮询 8 趟不再增长）', bus.calls.startRun === before, `${before} → ${bus.calls.startRun}`);
    feed.stop();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
