'use strict';
/**
 * Concurrent hooks: summons are not lost, and finishes line up (regression for 2026-09-27 bug 1).
 *
 * Context: the CodeBuddy CLI fires several hook events in the **same millisecond**. In the old code
 * each hook was its own process doing readFile → mutate → writeFileSync, overwriting each other
 * (three ghost+ calls landed only two). Now the hook is a pure forwarder, so summon / retire / sweep
 * all write straight to the DB on the server (the bus ghost API, backed by an in-memory Map). This
 * test drives server dispatch concurrently via createHookDispatch and checks subagent_runs end to end.
 *
 * Run: `npm run test:ghost` (zero deps).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ghost-race-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const PROJECT = path.join(TMP, 'project');
for (const d of [HOME, WG, PROJECT]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;

const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');
const { createHookDispatch } = require('../src/ingest/hookDispatch');

const SESSION = 'sess-race';
const PROJECT_ID = 'WorkGremlin';

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

const { repo, close } = openDatabase(path.join(TMP, 'test.db'));
repo.upsertProject.run({ id: PROJECT_ID, name: PROJECT_ID, workspacePath: PROJECT, mainConversationId: null, source: 'report', createdAt: 1 });
const bus = createIngestBus({ repo, hub: { broadcast() {} }, projectName: PROJECT_ID, project: PROJECT_ID });
bus.registerMember({ project: PROJECT_ID, memberId: 'codebuddy', name: 'codebuddy', role: 'agent', client: 'codebuddy' });
const main = bus.startTask({ project: PROJECT_ID, memberId: 'codebuddy', title: '主任务', client: 'codebuddy' }).taskId;

const d = createHookDispatch();
const ctx = { project: PROJECT_ID, workspacePath: PROJECT, bus, repo };
async function runHook(eventName, payload = {}, session = SESSION) {
  await d.dispatch(
    { hook_event_name: eventName, session_id: session, cwd: PROJECT, client: 'CLI', agent: 'codebuddy', ...payload },
    ctx
  );
}

const runCount = () => repo.raw.prepare('SELECT COUNT(*) AS c FROM subagent_runs').get().c;
/** Any live ghost member named `name` (each instance now has its own suffixed id, so look up by name) */
const member = (name) => repo.raw.prepare('SELECT * FROM members WHERE project_id = ? AND name = ? AND ephemeral = 1').get(PROJECT_ID, name);

(async () => {
  console.log('并发 hook：召唤不丢 + 幽灵归属扫场');

  // [1] Concurrent summons: N arrive almost at once, none may be lost
  const N = 12;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      runHook('PreToolUse', {
        tool_name: 'Agent',
        tool_input: { subagent_type: 'Explore', prompt: `探查第 ${i} 个子任务` },
      })
    )
  );
  ok(`并发 ${N} 次召唤全部落库（subagent_runs = ${N}）`, runCount() === N, `实到 ${runCount()}`);

  // [2] Cross-session sweep: only this session's ghosts go; another session's stays (it may still be alive)
  await runHook('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: '别的会话' } }, 'other-session');
  ok('别的会话也记了一条', runCount() === N + 1, String(runCount()));
  await runHook('Stop');
  ok('本会话同名成员已散（12 只同名都收掉后成员摘掉）', !member('Explore'));
  const otherStill = repo.raw
    .prepare("SELECT COUNT(*) AS c FROM subagent_runs WHERE ended_at IS NULL")
    .get().c;
  ok('别的会话那条仍在跑（没被本会话 Stop 误扫）', otherStill === 1, String(otherStill));
  bus.ghostSweep({ project: PROJECT_ID, client: 'codebuddy', sessionId: 'other-session' });

  // [3] Concurrent finishes (SubagentStop): three summons, three finishes at once — each must line up
  await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      runHook('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: `收工测试 ${i}` } })
    )
  );
  const openBefore = repo.raw.prepare('SELECT COUNT(*) AS c FROM subagent_runs WHERE ended_at IS NULL').get().c;
  await Promise.all(Array.from({ length: 3 }, () => runHook('SubagentStop', {})));
  const openAfter = repo.raw.prepare('SELECT COUNT(*) AS c FROM subagent_runs WHERE ended_at IS NULL').get().c;
  ok('并发收工把三只都收掉了', openAfter === openBefore - 3, `${openBefore} → ${openAfter}`);

  // [3b] A finish event that names an instance but matches no ledger row must retire nothing.
  // Resolving it by guessing `arr[0]` retired the *other*, still-running summon and wrote this
  // event's result onto its run.
  const IA = 'call_00_aaa';
  const IB = 'call_00_bbb';
  const spawnSame = (inst, prompt) =>
    runHook('PreToolUse', { tool_name: 'Agent', tool_use_id: inst, tool_input: { subagent_type: 'SameName', prompt } });
  const openSame = () =>
    repo.raw.prepare("SELECT COUNT(*) AS c FROM subagent_runs WHERE ended_at IS NULL AND name = 'SameName'").get().c;
  const endedSame = () =>
    repo.raw
      .prepare("SELECT member_id FROM subagent_runs WHERE ended_at IS NOT NULL AND name = 'SameName'")
      .all()
      .map((r) => r.member_id);
  await spawnSame(IA, '同名 A');
  await spawnSame(IB, '同名 B');
  ok('两只同名幽灵同时在跑', openSame() === 2, String(openSame()));
  await runHook('SubagentStop', { agent_id: 'agent-of-B' });
  ok(
    'SubagentStop 只带对不上的 agent_id → 一只都不收（不再猜 arr[0]）',
    openSame() === 2 && endedSame().length === 0,
    `open=${openSame()} ended=${JSON.stringify(endedSame())}`
  );
  await runHook('PostToolUse', {
    tool_name: 'Agent',
    tool_use_id: 'call_00_ccc',
    tool_input: { subagent_type: 'SameName', prompt: '同名 C' },
  });
  ok(
    '带不匹配的 tool_use_id 和同名类型 → 仍然一只都不收',
    openSame() === 2 && endedSame().length === 0,
    `open=${openSame()} ended=${JSON.stringify(endedSame())}`
  );
  await runHook('PostToolUse', {
    tool_name: 'Agent',
    tool_use_id: IA,
    tool_input: { subagent_type: 'SameName', prompt: '同名 A' },
  });
  ok(
    'PostToolUse 按 tool_use_id 精确收掉 A、留下 B',
    openSame() === 1 && endedSame().length === 1 && endedSame()[0].includes(IA),
    `open=${openSame()} ended=${JSON.stringify(endedSame())}`
  );

  // [3c] Claude opens the ghost from PreToolUse(Agent), binds the asynchronous launch receipt from
  // PostToolUse(Agent), and finally names the same child in SubagentStop. The three events must line
  // up without retiring a same-name sibling by guesswork.
  const CLAUDE_SESSION = 'sess-claude-ghost';
  const CLAUDE_CALL_A = 'call_00_claude_guide_a';
  const CLAUDE_CALL_B = 'call_00_claude_guide_b';
  const CLAUDE_CALL_C = 'call_00_claude_guide_c';
  const CLAUDE_AGENT_A = 'agent-child-guide-a';
  const CLAUDE_AGENT_B = 'agent-child-guide-b';
  bus.registerMember({ project: PROJECT_ID, memberId: 'claude', name: 'claude', role: 'agent', client: 'claude' });
  const runClaude = (eventName, payload = {}) =>
    d.dispatch(
      {
        hook_event_name: eventName,
        session_id: CLAUDE_SESSION,
        cwd: PROJECT,
        client: 'cli',
        agent: 'claude',
        ...payload,
      },
      ctx
    );
  const openClaude = () =>
    repo.raw
      .prepare("SELECT COUNT(*) AS c FROM subagent_runs WHERE ended_at IS NULL AND name = 'ClaudeGuide'")
      .get().c;
  const claudeRuns = () =>
    repo.raw
      .prepare("SELECT * FROM subagent_runs WHERE name = 'ClaudeGuide' ORDER BY id")
      .all();
  await runClaude('UserPromptSubmit', { prompt: '召唤 Claude 子代理' });
  await runClaude('PreToolUse', {
    tool_name: 'Agent',
    tool_use_id: CLAUDE_CALL_A,
    tool_input: { subagent_type: 'ClaudeGuide', prompt: '查一下 hook 文档 A' },
  });
  await runClaude('PreToolUse', {
    tool_name: 'Agent',
    tool_use_id: CLAUDE_CALL_B,
    tool_input: { subagent_type: 'ClaudeGuide', prompt: '查一下 hook 文档 B' },
  });
  ok('Claude 两只同名幽灵同时在跑', openClaude() === 2, String(openClaude()));
  await runClaude('PostToolUse', {
    tool_name: 'Agent',
    tool_use_id: CLAUDE_CALL_A,
    tool_input: { subagent_type: 'ClaudeGuide', prompt: '查一下 hook 文档 A' },
    tool_response: { isAsync: true, status: 'async_launched', agentId: CLAUDE_AGENT_A },
  });
  await runClaude('PostToolUse', {
    tool_name: 'Agent',
    tool_use_id: CLAUDE_CALL_B,
    tool_input: { subagent_type: 'ClaudeGuide', prompt: '查一下 hook 文档 B' },
    tool_response: `Async agent launched successfully.\nagentId: ${CLAUDE_AGENT_B}`,
  });
  const boundRuns = claudeRuns();
  ok(
    '异步回执不收工，并把结构化/文本 agentId 写入台账',
    openClaude() === 2 && boundRuns.some((r) => r.agent_id === CLAUDE_AGENT_A) && boundRuns.some((r) => r.agent_id === CLAUDE_AGENT_B),
    JSON.stringify(boundRuns.map((r) => ({ id: r.id, agent_id: r.agent_id, ended_at: r.ended_at })))
  );
  await runClaude('SubagentStop', {
    agent_id: 'agent-child-unknown',
    agent_type: 'ClaudeGuide',
    last_assistant_message: '不属于这里',
  });
  ok('未知 agentId 的 SubagentStop 不收任何幽灵', openClaude() === 2, String(openClaude()));
  await runClaude('SubagentStop', { last_assistant_message: '旧事件没有实例身份' });
  ok('无身份 SubagentStop 不猜 arr[0]', openClaude() === 2, String(openClaude()));
  await runClaude('SubagentStop', {
    agent_id: CLAUDE_AGENT_A,
    agent_type: 'ClaudeGuide',
    last_assistant_message: 'A 查完了',
  });
  const afterA = claudeRuns();
  const endedA = afterA.find((r) => r.agent_id === CLAUDE_AGENT_A);
  ok(
    '已知 agentId 的 SubagentStop 只收 A',
    openClaude() === 1 && endedA && endedA.result === 'A 查完了',
    JSON.stringify(afterA.map((r) => ({ agent_id: r.agent_id, ended_at: r.ended_at, result: r.result })))
  );
  await runClaude('Stop', { last_assistant_message: '主任务先完成' });
  ok('父任务正常完成不会收掉后台幽灵', openClaude() === 1, String(openClaude()));
  await runClaude('SubagentStop', {
    agent_id: CLAUDE_AGENT_B,
    agent_type: 'ClaudeGuide',
    last_assistant_message: 'B 也查完了',
  });
  ok('父任务结束后，后台幽灵仍按 agentId 精确收工', openClaude() === 0, String(openClaude()));

  // A synchronous Claude Agent call has no async receipt and still retires by its spawning call id.
  await runClaude('UserPromptSubmit', { prompt: '同步召唤 Claude 子代理' });
  await runClaude('PreToolUse', {
    tool_name: 'Agent',
    tool_use_id: CLAUDE_CALL_C,
    tool_input: { subagent_type: 'ClaudeGuide', prompt: '同步查询' },
  });
  await runClaude('PostToolUse', {
    tool_name: 'Agent',
    tool_use_id: CLAUDE_CALL_C,
    tool_input: { subagent_type: 'ClaudeGuide', prompt: '同步查询' },
    tool_response: '同步查完了',
  });
  ok('同步 PostToolUse 仍按 tool_use_id 收掉幽灵', openClaude() === 0, String(openClaude()));

  // [4] fslock primitive: concurrent read-modify-write must not lose an update (the state file still uses it)
  const COUNTER = path.join(TMP, 'counter.json');
  const FLOCK = path.resolve(__dirname, '..', '..', 'shared', 'fslock.js');
  fs.writeFileSync(COUNTER, '0\n', 'utf8');
  const WORKERS = 6;
  const PER = 150;
  const childCode = `const { updateJson } = require(${JSON.stringify(FLOCK)});
for (let i = 0; i < ${PER}; i++) {
  updateJson(${JSON.stringify(COUNTER)}, (v) => (Number(v) || 0) + 1, { pretty: false });
}`;
  await Promise.all(
    Array.from({ length: WORKERS }, () =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, ['-e', childCode], { stdio: ['ignore', 'ignore', 'ignore'] });
        c.on('close', () => resolve());
      })
    )
  );
  const total = Number(String(fs.readFileSync(COUNTER, 'utf8')).trim());
  ok(`并发 ${WORKERS * PER} 次读-改-写一次不丢`, total === WORKERS * PER, `实到 ${total}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
