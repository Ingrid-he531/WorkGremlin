/**
 * 回归测试：服务端自己认出来的"取消"，**必须真的落到台账上**（tasks.state / ended_at /
 * task_runs.result），而不是只在内存里亮个红灯。
 *
 * 病灶（2026-09-29 实测）：Claude Code / Qoder 按停止一个 hook 事件都不发，取消由
 * readReporterDones 从 transcript 末尾的 `[Request interrupted by user]` 合成，再交给
 * sessionRegistry 的 flushSynthesizedCancels 补一刀 task/end。但那一刀从来没发出去过：
 *
 *   ① 它 `require('./ingest/bus')` 拿的是**工厂模块**（`{createIngestBus, projectIdOf,
 *      memberIdOf}`），`bus.endTask` 压根不存在 → `undefined(...)` 抛 TypeError，
 *      被下面那个空 catch 吞掉；
 *   ② 就算拿得到 bus，它传的是工程**路径**（状态文件里只有路径）+ 客户端名，
 *      而 bus.endTask 收的是工程 id + 成员 id（`claude@workgremlin`）→ 算出来是
 *      `claude@/home/…/WorkGremlin` 这种不存在的成员，当场 unknown_member（不抛错）。
 *
 * 现象：控制台亮红色「任务取消」，但任务记录里那一轮永远挂在「进行中」、结束时间是空的、
 * 产出与改动文件整块丢（实测库里所有 cancelled 行的 ended_at 全是 NULL）。
 *
 * 本文件盯的是"补发这一刀"本身：注入假 bus + 假台账，跑真实的 refresh 扫盘，断言
 * task/end 收到的归属取自**台账那行任务**（工程 id + 成员 id），并且没有对应任务行时不发。
 *
 * 跑法：`npm run test:cancel-flush`（零依赖）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cancel-flush-'));
const HOME = path.join(TMP, 'home'); // WORKGREMLIN_HOME（状态文件在这）
const CLAUDE_HOME = path.join(TMP, 'claude'); // CLAUDE_CONFIG_DIR（transcript 落盘在这）
const WS = path.join(TMP, 'ws');
const SESSION = '9f1c0a2e-0000-4000-8000-0000000000f1';
const TASK_ID = 't_flush_cancel';
fs.mkdirSync(path.join(HOME, 'hooks'), { recursive: true });
fs.mkdirSync(path.join(CLAUDE_HOME, 'projects', '-tmp-ws'), { recursive: true });
fs.mkdirSync(WS, { recursive: true });
process.env.WORKGREMLIN_HOME = HOME;
process.env.CLAUDE_CONFIG_DIR = CLAUDE_HOME;

// 必须在设置 env 之后再 require（两个 home 都是每次调用现读 env）
const { refresh, setBackend } = require('../src/sessionRegistry');

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
function head(t) {
  console.log(`\n${t}`);
}

/**
 * 造一条"被用户掐掉"的 Claude Code 会话：4F 落盘的 transcript（末尾一条打断标记）+
 * reporter 状态文件（taskId 还占着、相位冻在打断前那一刻）。
 */
function writeInterruptedSession(startedAt = Date.now() - 30_000) {
  const tp = path.join(CLAUDE_HOME, 'projects', '-tmp-ws', `${SESSION}.jsonl`);
  const now = Date.now();
  fs.writeFileSync(
    tp,
    [
      JSON.stringify({ type: 'user', cwd: WS, sessionId: SESSION, timestamp: new Date(startedAt).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '改点东西' }] } }),
      JSON.stringify({ type: 'assistant', cwd: WS, sessionId: SESSION, timestamp: new Date(startedAt + 10_000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '先看仓库结构。' }] } }),
      JSON.stringify({ type: 'user', cwd: WS, sessionId: SESSION, timestamp: new Date(now).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    ].join('\n') + '\n'
  );
  fs.writeFileSync(
    path.join(HOME, 'hooks', `claude__${SESSION}.json`),
    JSON.stringify({
      client: 'claude',
      sessionId: SESSION,
      transcriptPath: tp,
      taskId: TASK_ID,
      taskStartedAt: startedAt,
      taskTitle: '改点东西',
      taskWorkspacePath: WS,
      sessionPhase: { phase: 'tool', tool: 'Bash', ts: now - 1_000, workspacePath: WS },
    })
  );
  return tp;
}

/** 假 bus：只记 task/end 的调用参数（不碰数据库、不广播） */
function makeBus() {
  const calls = [];
  return {
    calls,
    endTask: (p) => {
      calls.push(p);
      return { ok: true };
    },
  };
}

/** 假台账：只认一行任务（工程 id + 成员 id 都跟状态文件里的字面量不一样，专治"拿路径当 id"） */
function makeRepo(tasks) {
  return {
    getTask: { get: (id) => tasks.find((t) => t.id === id) || null },
  };
}

writeInterruptedSession();

head('[1] 合成的取消要真的补一刀 task/end(cancelled)，归属取自台账那行任务');
{
  const bus = makeBus();
  setBackend({ bus, repo: makeRepo([{ id: TASK_ID, project_id: 'workgremlin', member_id: 'claude@workgremlin' }]) });
  refresh({ workspacePath: WS, force: true });
  const hit = bus.calls.find((c) => c.taskId === TASK_ID) || null;
  ok('补发了 task/end', Boolean(hit), JSON.stringify(bus.calls));
  ok('state = cancelled', Boolean(hit) && hit.state === 'cancelled', JSON.stringify(hit));
  ok('工程用台账的 project_id（不是工程路径）', Boolean(hit) && hit.project === 'workgremlin', JSON.stringify(hit && hit.project));
  ok('成员用台账的 member_id（不是客户端名）', Boolean(hit) && hit.memberId === 'claude@workgremlin', JSON.stringify(hit && hit.memberId));
  ok('带上这一轮已吐出的文字', Boolean(hit) && hit.result === '先看仓库结构。', JSON.stringify(hit && hit.result));
  ok('带会话 id（台账按会话归属）', Boolean(hit) && hit.sessionId === SESSION, JSON.stringify(hit && hit.sessionId));
}

head('[2] 同一轮不会反复补发（refresh 扫好几遍只发一次）');
{
  // 换一个 taskStartedAt（去重键里含它）→ 算"另一轮"，从零开始数
  const startedAt = Date.now() - 5 * 60_000;
  writeInterruptedSession(startedAt);
  const bus = makeBus();
  setBackend({ bus, repo: makeRepo([{ id: TASK_ID, project_id: 'workgremlin', member_id: 'claude@workgremlin' }]) });
  refresh({ workspacePath: WS, force: true });
  refresh({ workspacePath: WS, force: true });
  refresh({ workspacePath: WS, force: true });
  ok('只补发一次', bus.calls.filter((c) => c.taskId === TASK_ID).length === 1, `发了 ${bus.calls.length} 次`);
}

head('[3] 台账里没有这一行任务 → 不发（绝不编造一个工程去写）');
{
  const bus = makeBus();
  setBackend({ bus, repo: makeRepo([]) });
  refresh({ workspacePath: WS, force: true });
  ok('没补发', !bus.calls.some((c) => c.taskId === TASK_ID), JSON.stringify(bus.calls));
}

head('[4] 没注入 bus（只调 snapshot 的老用法）→ 老老实实什么都不做');
{
  setBackend(null);
  let threw = null;
  try {
    refresh({ workspacePath: WS, force: true });
  } catch (e) {
    threw = e;
  }
  ok('不抛错', threw === null, threw && String(threw.message));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
