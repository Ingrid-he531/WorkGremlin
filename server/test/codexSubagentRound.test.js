/**
 * Regression test: a Codex subagent's own hook events must not become a new user round.
 *
 * Symptom (measured 2026-10-19, 3F Codex): summoning a subagent flipped the running main task to
 * `cancelled`, and the subagent showed up as a separate top-level task. Codex emits hook events
 * from the subagent thread with the **parent's `session_id`** and the subagent thread id in
 * `agent_id` (the rollout's `session_meta` has `session_id` = parent, `id` = subagent thread).
 * `UserPromptSubmit` treated that prompt as "the user sent a new message": it swept the ghost and
 * called `startTask`, whose `endStaleTasksOfSession` closed the still-running parent task as
 * cancelled (same project / session / client).
 *
 * What this file pins down:
 *   [1] main prompt -> one running task;
 *   [2] spawn_agent + SubagentStart -> a live ghost, no second task;
 *   [3] the subagent's UserPromptSubmit -> the main task is still running, no new task row, the
 *       ghost is still alive (no sweep);
 *   [4] the subagent's PreToolUse does not overwrite the main round's phase / tool attribution;
 *   [5] SubagentStop retires the ghost; the main Stop closes the task as done, not cancelled.
 *
 * Run: `node server/test/codexSubagentRound.test.js`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-codex-subagent-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const PROJECT = path.join(TMP, 'project');
for (const d of [HOME, WG, PROJECT]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;

const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');
const { createHookDispatch } = require('../src/ingest/hookDispatch');

const SESSION = 'sess-codex-sub';
const SUB_AGENT = 'sub-thread-1';
const PROJECT_ID = 'WorkGremlin';
const MAIN_TP = path.join(TMP, 'main-rollout.jsonl');
const SUB_TP = path.join(TMP, 'sub-rollout.jsonl');
fs.writeFileSync(MAIN_TP, '', 'utf8');
fs.writeFileSync(SUB_TP, '', 'utf8');

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

const { repo, close } = openDatabase(path.join(TMP, 'test.db'));
repo.upsertProject.run({
  id: PROJECT_ID,
  name: PROJECT_ID,
  workspacePath: PROJECT,
  mainConversationId: null,
  source: 'report',
  createdAt: 1,
});
const bus = createIngestBus({ repo, hub: { broadcast() {} }, projectName: PROJECT_ID, project: PROJECT_ID });
const d = createHookDispatch();
const ctx = { project: PROJECT_ID, workspacePath: PROJECT, bus, repo };

const tasks = () => repo.raw.prepare('SELECT * FROM tasks ORDER BY started_at').all();
const topTasks = () => repo.raw.prepare('SELECT * FROM tasks WHERE parent_task_id IS NULL ORDER BY started_at').all();
const taskRuns = () => repo.raw.prepare('SELECT * FROM task_runs ORDER BY started_at').all();
const openGhosts = () => repo.raw.prepare('SELECT * FROM subagent_runs WHERE ended_at IS NULL').all();
const ghostRows = () => repo.raw.prepare('SELECT * FROM subagent_runs ORDER BY id').all();
const state = () => d._sessions.get(SESSION) || {};

function ev(name, extra = {}) {
  return { hook_event_name: name, session_id: SESSION, cwd: PROJECT, agent: 'codex', ...extra };
}

(async () => {
  console.log('3F Codex：子代理的 hook 事件不能挤掉主任务');

  // [1] The user's own prompt opens the main round
  await d.dispatch(ev('UserPromptSubmit', { prompt: '看一下这个设计', model: 'gpt-5', transcript_path: MAIN_TP }), ctx);
  const mainTask = tasks()[0];
  ok('主轮起了唯一一条任务', tasks().length === 1 && taskRuns().length === 1, JSON.stringify(tasks()));
  ok('主任务正在跑', mainTask && mainTask.state === 'running' && !mainTask.ended_at, JSON.stringify(mainTask));
  ok('标题取用户原话', mainTask && mainTask.title === '看一下这个设计', mainTask && mainTask.title);

  // A distinct millisecond keeps endStaleTasksOfSession's "same instant = this round" guard out of the way.
  await sleep(10);
  await d.dispatch(
    ev('PreToolUse', {
      tool_name: 'spawn_agent',
      tool_input: { subagent_type: 'software-architect', prompt: '评审这个设计' },
      tool_use_id: 'call-spawn-1',
    }),
    ctx
  );
  await d.dispatch(ev('SubagentStart', { agent_id: SUB_AGENT, agent_type: 'software-architect', transcript_path: SUB_TP }), ctx);
  ok('召唤后有一条活着的幽灵', openGhosts().length === 1, JSON.stringify(ghostRows()));
  ok('幽灵挂在主任务下', openGhosts()[0] && openGhosts()[0].parent_task_id === mainTask.id, JSON.stringify(openGhosts()[0]));
  ok(
    'Codex SubagentStart 记录子线程身份并标记为后台',
    openGhosts()[0] && openGhosts()[0].agent_id === SUB_AGENT && openGhosts()[0].background === 1,
    JSON.stringify(openGhosts()[0])
  );
  ok('子代理的 transcript 没顶掉主轮的', state().transcriptPath === MAIN_TP, String(state().transcriptPath));

  await sleep(10);
  // [3] The subagent's own prompt: same session_id, but agent_id identifies the subagent thread
  await d.dispatch(
    ev('UserPromptSubmit', {
      agent_id: SUB_AGENT,
      agent_type: 'software-architect',
      prompt: '你是架构师，请评审这个设计',
      transcript_path: SUB_TP,
    }),
    ctx
  );
  const afterPrompt = tasks();
  ok('子代理的提示没有新开顶层任务', topTasks().length === 1 && taskRuns().length === 1, JSON.stringify(afterPrompt));
  ok('主任务仍是 running（没被 cancel）', afterPrompt[0] && afterPrompt[0].state === 'running', JSON.stringify(afterPrompt[0]));
  ok('主任务没有被收尾（ended_at 为空）', afterPrompt[0] && !afterPrompt[0].ended_at, JSON.stringify(afterPrompt[0]));
  ok('会话状态仍指向主任务', state().taskId === mainTask.id, JSON.stringify(state().taskId));
  ok('主任务标题没被子代理提示顶掉', state().taskTitle === '看一下这个设计', String(state().taskTitle));
  ok('幽灵没有被新轮扫场收掉', openGhosts().length === 1, JSON.stringify(ghostRows()));
  ok('主轮 transcript 仍是自己的', state().transcriptPath === MAIN_TP, String(state().transcriptPath));

  // [4] The subagent's tool events must not overwrite the main round's phase or tool counts
  await d.dispatch(
    ev('PreToolUse', {
      agent_id: SUB_AGENT,
      agent_type: 'software-architect',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'call-sub-bash',
    }),
    ctx
  );
  ok('相位仍是主轮的 spawn_agent', state().lastTool === 'spawn_agent', String(state().lastTool));
  ok('相位没被子代理的 Bash 覆盖', state().sessionPhase && state().sessionPhase.tool === 'spawn_agent', JSON.stringify(state().sessionPhase));
  const tools = repo.raw.prepare('SELECT tool, count FROM tool_usage WHERE task_id = ?').all(mainTask.id);
  ok('子代理的工具没记到主任务上', !tools.some((t) => t.tool === 'Bash'), JSON.stringify(tools));
  ok('主任务仍只有自己的 spawn_agent 记录', tools.some((t) => t.tool === 'spawn_agent'), JSON.stringify(tools));

  // [5] SubagentStop retires the ghost; the main Stop closes the round normally
  await d.dispatch(
    ev('SubagentStop', { agent_id: SUB_AGENT, agent_type: 'software-architect', last_assistant_message: '评审完成：方案可行' }),
    ctx
  );
  ok('SubagentStop 收掉幽灵', openGhosts().length === 0, JSON.stringify(ghostRows()));
  ok('幽灵结果落库', /评审完成/.test(String(ghostRows()[0] && ghostRows()[0].result)), String(ghostRows()[0] && ghostRows()[0].result));

  await d.dispatch(ev('Stop', { last_assistant_message: '主任务完成' }), ctx);
  const done = tasks()[0];
  ok('主 Stop 把任务收成 done', done && done.state === 'done', JSON.stringify(done));
  ok('不是 cancelled', done && done.state !== 'cancelled', String(done && done.state));
  ok('全程只有一条顶层任务', topTasks().length === 1 && taskRuns().length === 1, JSON.stringify(taskRuns()));

  // [6] A detached Codex child can outlive the parent turn. Interrupting that turn must cancel the
  // parent task without sweeping the still-running background ghost.
  const interruptSession = 'sess-codex-interrupt';
  const interruptEv = (name, extra = {}) => ev(name, { session_id: interruptSession, ...extra });
  await d.dispatch(interruptEv('UserPromptSubmit', { prompt: '后台跑完再回来', model: 'gpt-5', transcript_path: MAIN_TP }), ctx);
  const interruptParent = tasks().find((t) => t.state === 'running' && t.parent_task_id == null);
  await sleep(10);
  await d.dispatch(
    interruptEv('PreToolUse', {
      tool_name: 'spawn_agent',
      tool_input: { subagent_type: 'peter', prompt: '审查这个改动' },
      tool_use_id: 'call-spawn-interrupt',
    }),
    ctx
  );
  await d.dispatch(interruptEv('SubagentStart', { agent_id: 'sub-thread-interrupt', agent_type: 'peter', transcript_path: SUB_TP }), ctx);
  await d.dispatch(interruptEv('Interrupt'), ctx);

  const cancelledParent = repo.getTask.get(interruptParent.id);
  const interruptGhost = repo.raw.prepare("SELECT * FROM subagent_runs WHERE session_id = ? AND ended_at IS NULL").get(interruptSession);
  ok('父轮 Interrupt 把父任务收成 cancelled', cancelledParent && cancelledParent.state === 'cancelled', JSON.stringify(cancelledParent));
  ok('后台幽灵在父轮被打断后仍活着', Boolean(interruptGhost) && interruptGhost.background === 1, JSON.stringify(interruptGhost));
  ok(
    '后台子任务仍在 running',
    interruptGhost && repo.getTask.get(interruptGhost.task_id) && repo.getTask.get(interruptGhost.task_id).state === 'running',
    JSON.stringify(interruptGhost && repo.getTask.get(interruptGhost.task_id))
  );
  bus.gcGhosts();
  ok('GC 不会因父任务取消而提前收掉后台幽灵', Boolean(repo.raw.prepare('SELECT ended_at FROM subagent_runs WHERE id = ?').get(interruptGhost.id).ended_at === null));

  await d.dispatch(interruptEv('SubagentStop', { agent_id: 'sub-thread-interrupt', agent_type: 'peter', last_assistant_message: '审查完成' }), ctx);
  ok('最终 SubagentStop 正常收掉后台幽灵', Boolean(repo.raw.prepare('SELECT ended_at FROM subagent_runs WHERE id = ?').get(interruptGhost.id).ended_at));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  console.log(`\n结果：${pass} 通过 / ${fail + 1} 失败`);
  process.exit(1);
});
