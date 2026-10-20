/**
 * Regression test: a Claude background child's handback opens a continuation task.
 *
 * Claude queues `<agent-message from="...">` through UserPromptSubmit when a background child hands
 * work back. The parent task has already stopped by then, so the main agent's final summary needs a
 * new ledger row. Only a handback that names a persisted background child in the same session may
 * open that row; unknown senders, task notifications, foreground children and an already-running
 * main task must leave the ledger alone.
 *
 * Run: `node server/test/claudeContinuation.test.js`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-claude-continuation-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const PROJECT = path.join(TMP, 'project');
for (const dir of [HOME, WG, PROJECT]) fs.mkdirSync(dir, { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;

const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');
const { createHookDispatch } = require('../src/ingest/hookDispatch');

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

function head(text) {
  console.log(`\n${text}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
const ctx = { project: PROJECT_ID, workspacePath: PROJECT, bus, repo };

const topTasks = () => repo.raw.prepare('SELECT * FROM tasks WHERE parent_task_id IS NULL ORDER BY started_at, id').all();
const taskRuns = () => repo.raw.prepare('SELECT * FROM task_runs ORDER BY started_at, id').all();
const runOfTask = (taskId) => repo.raw.prepare('SELECT * FROM task_runs WHERE id = ?').get(taskId);
const handback = (sid, agentId, promptId, body = '子代理报告') =>
  `<agent-message from="${agentId}">\n${body}\n</agent-message>`;

function ev(name, sid, extra = {}) {
  return { hook_event_name: name, session_id: sid, cwd: PROJECT, agent: 'claude', form: 'vscode', ...extra };
}

async function dispatch(dispatcher, name, sid, extra = {}) {
  return dispatcher.dispatch(ev(name, sid, extra), ctx);
}

async function openMainTask(dispatcher, sid, title) {
  await dispatch(dispatcher, 'UserPromptSubmit', sid, { prompt: title, prompt_id: `${sid}-parent` });
  return topTasks().find((task) => task.title === title && task.state === 'running');
}

async function main() {
  const dispatcher = createHookDispatch();

  head('[1] A known background handback opens a continuation task, survives compact, and closes on Stop');
  {
    const sid = 'claude-continuation-main';
    const parent = await openMainTask(dispatcher, sid, '等待 eva 后台审查');
    await sleep(5);
    const child = bus.ghostSpawn({
      project: PROJECT_ID,
      workspacePath: PROJECT,
      client: 'claude',
      sessionId: sid,
      name: 'eva',
      task: '审查设计',
      id: 'call-eva-main',
      parentTaskId: parent.id,
      agentId: 'agent-eva-main',
      background: true,
    });
    await dispatch(dispatcher, 'Stop', sid, { last_assistant_message: '已交给 eva，后台继续' });
    const before = topTasks().length;

    const first = await dispatch(dispatcher, 'UserPromptSubmit', sid, {
      prompt: handback(sid, 'agent-eva-main', 'prompt-eva-main', '审查完成，建议合并'),
      prompt_id: 'prompt-eva-main',
    });
    const continued = topTasks().find((task) => task.title === 'eva 返回后续作');
    ok('known handback is handled', first && first.continued === true, JSON.stringify(first));
    ok('exactly one continuation task is opened', topTasks().length === before + 1, JSON.stringify(topTasks()));
    ok('continuation task is running', continued && continued.state === 'running' && !continued.ended_at, JSON.stringify(continued));
    ok('continuation title names the child, not the report body', continued && continued.title === 'eva 返回后续作', continued && continued.title);
    ok('continuation ledger keeps the same session', continued && runOfTask(continued.id).session_id === sid, continued && JSON.stringify(runOfTask(continued.id)));
    ok('the background ghost is still open before its stop', repo.getSubagentRun.get(child.runId).ended_at === null);

    const duplicate = await dispatch(dispatcher, 'UserPromptSubmit', sid, {
      prompt: handback(sid, 'agent-eva-main', 'prompt-eva-main', '重复投递'),
      prompt_id: 'prompt-eva-main',
    });
    ok('duplicate prompt_id is ignored', duplicate && duplicate.ignored === 'duplicate_subagent_handback', JSON.stringify(duplicate));
    ok('duplicate does not add a task', topTasks().length === before + 1, JSON.stringify(topTasks()));

    const restarted = createHookDispatch();
    await dispatch(restarted, 'SessionStart', sid, { source: 'compact' });
    const running = topTasks().filter((task) => task.state === 'running');
    ok('compact after restart keeps the continuation task running', running.length === 1 && running[0].id === continued.id, JSON.stringify(running));
    ok('compact does not open another task', topTasks().length === before + 1, JSON.stringify(topTasks()));

    await dispatch(restarted, 'SubagentStop', sid, {
      agent_id: 'agent-eva-main',
      agent_type: 'eva',
      last_assistant_message: '审查完成',
    });
    ok('SubagentStop still retires only the ghost', repo.getSubagentRun.get(child.runId).ended_at !== null && repo.getTask.get(continued.id).state === 'running');

    await dispatch(restarted, 'Stop', sid, { last_assistant_message: '综合 eva 的结论，代码可以合并。' });
    const done = repo.getTask.get(continued.id);
    const doneRun = runOfTask(continued.id);
    ok('final Stop closes the continuation as done', done && done.state === 'done' && !!done.ended_at, JSON.stringify(done));
    ok('final main-agent summary is stored on the continuation run', doneRun && doneRun.result === '综合 eva 的结论，代码可以合并。', JSON.stringify(doneRun));
    ok('the continuation prompt did not replace the parent task', repo.getTask.get(parent.id).state === 'done' && parent.id !== continued.id);
  }

  head('[2] Unknown senders, task notifications and foreground children do not open tasks');
  {
    const sid = 'claude-continuation-guards';
    const before = topTasks().length;
    const unknown = await dispatch(dispatcher, 'UserPromptSubmit', sid, {
      prompt: handback(sid, 'agent-unknown', 'prompt-unknown'),
      prompt_id: 'prompt-unknown',
    });
    ok('unknown agent_id is ignored', unknown && unknown.ignored === 'unknown_subagent_handback', JSON.stringify(unknown));
    ok('unknown sender opens no task', topTasks().length === before, JSON.stringify(topTasks()));

    const notification = await dispatch(dispatcher, 'UserPromptSubmit', sid, {
      prompt: '<task-notification><status>completed</status></task-notification>',
      prompt_id: 'prompt-notification',
    });
    ok('task-notification is still ignored', notification && notification.ignored === 'injected', JSON.stringify(notification));
    ok('task-notification opens no task', topTasks().length === before, JSON.stringify(topTasks()));

    const mixedParent = await openMainTask(dispatcher, sid, '带普通文字的父任务');
    await sleep(5);
    bus.ghostSpawn({
      project: PROJECT_ID,
      workspacePath: PROJECT,
      client: 'claude',
      sessionId: sid,
      name: 'mixed-child',
      task: '后台执行',
      id: 'call-mixed',
      parentTaskId: mixedParent.id,
      agentId: 'agent-mixed',
      background: true,
    });
    await dispatch(dispatcher, 'Stop', sid, { last_assistant_message: '父任务结束' });
    const mixedBefore = topTasks().length;
    const mixed = await dispatch(dispatcher, 'UserPromptSubmit', sid, {
      prompt: `${handback(sid, 'agent-mixed', 'prompt-mixed')}\n普通用户文字`,
      prompt_id: 'prompt-mixed',
    });
    ok('a partial agent-message envelope does not continue', mixed && mixed.ignored === 'injected', JSON.stringify(mixed));
    ok('a partial envelope opens no task', topTasks().length === mixedBefore, JSON.stringify(topTasks()));

    const parent = await openMainTask(dispatcher, sid, '前台子代理的父任务');
    await sleep(5);
    bus.ghostSpawn({
      project: PROJECT_ID,
      workspacePath: PROJECT,
      client: 'claude',
      sessionId: sid,
      name: 'foreground-child',
      task: '前台执行',
      id: 'call-foreground',
      parentTaskId: parent.id,
      agentId: 'agent-foreground',
      background: false,
    });
    const foreground = await dispatch(dispatcher, 'UserPromptSubmit', sid, {
      prompt: handback(sid, 'agent-foreground', 'prompt-foreground'),
      prompt_id: 'prompt-foreground',
    });
    ok('foreground child is not a continuation source', foreground && foreground.ignored === 'unknown_subagent_handback', JSON.stringify(foreground));
    await dispatch(dispatcher, 'Stop', sid, { last_assistant_message: '前台父任务结束' });
  }

  head('[3] A handback during a running main task does not open a second ledger row');
  {
    const sid = 'claude-continuation-active';
    const parent = await openMainTask(dispatcher, sid, '主任务仍在运行');
    await sleep(5);
    bus.ghostSpawn({
      project: PROJECT_ID,
      workspacePath: PROJECT,
      client: 'claude',
      sessionId: sid,
      name: 'background-child',
      task: '后台执行',
      id: 'call-active',
      parentTaskId: parent.id,
      agentId: 'agent-active',
      background: true,
    });
    const before = topTasks().length;
    const active = await dispatch(dispatcher, 'UserPromptSubmit', sid, {
      prompt: handback(sid, 'agent-active', 'prompt-active'),
      prompt_id: 'prompt-active',
    });
    ok('handback with a live task is ignored', active && active.ignored === 'continuation_task_active', JSON.stringify(active));
    ok('live main task remains the only running top-level task', topTasks().length === before && repo.getTask.get(parent.id).state === 'running', JSON.stringify(topTasks()));
    await dispatch(dispatcher, 'SubagentStop', sid, { agent_id: 'agent-active', last_assistant_message: '后台完成' });
    await dispatch(dispatcher, 'Stop', sid, { last_assistant_message: '父任务完成' });
    ok('only the original parent task remains in this scenario', taskRuns().filter((row) => row.session_id === sid).length === 1, JSON.stringify(taskRuns().filter((row) => row.session_id === sid)));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n结果：${pass} 通过 / ${fail + 1} 失败`);
  close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
