'use strict';
/**
 * `/api/v1/task-runs` 的**真实 SQL** 自检 —— 任务记录页唯一的取数接口。
 *
 * 为什么单独一个文件：这条 SQL 是手写的一大段（LEFT JOIN + COALESCE + CASE + instr 过滤），
 * 2026-09-27 往里加一列注释时把它插进了 CASE 子查询里，`SqliteError: near "tr": syntax error`
 * —— 接口 500、任务列表整页空白，而当时的自检（只跑 repo 语句 / 不走路由）全都绿。
 * 所以这里起**真路由**（express + 真 repo + 临时库），把这条 SQL 真跑一遍并断言返回字段。
 *
 * 跑法：`npm run test:task-runs-route`
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ 沙箱 ------------------------------ */

// **必须在 require 业务模块之前**改环境（与 doneAttribution.test.js 同款）：sessions.js 的
// reporterHookHome / products.js 的 HOME 都在模块期取值。[6] 那段要靠 hook 状态文件复现
// "同产品两条会话同时在跑"，不换的话读的是**真实 home** 的 hooks/ —— 自检结果会随机上
// 正跑着什么而变。
const WG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-task-runs-home-'));
process.env.WORKGREMLIN_HOME = WG_HOME;

const express = require('express');

const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');
const { createQueryRouter } = require('../src/http/routes/query');
const { createIngestRouter } = require('../src/http/routes/ingest');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-task-runs-route-'));
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));
const hub = { broadcast() {} };
const bus = createIngestBus({ repo, hub, projectName: 'p1', project: 'p1' });

/* ------------------------------ 造数据 ------------------------------ */
repo.upsertProject.run({ id: 'p1', name: 'p1', workspacePath: '/tmp/p1', mainConversationId: null, source: 'report', createdAt: 1 });
repo.upsertMember.run({
  id: 'codex@p1',
  projectId: 'p1',
  name: 'codex',
  role: 'agent',
  sessionId: null,
  reported: 1,
  createdAt: 1,
  lastSeenAt: 1,
  ephemeral: 0,
  projectLabel: null,
  client: 'codex',
});
function seedTask(id, form, startedAt) {
  repo.insertTask.run({
    id,
    projectId: 'p1',
    memberId: 'codex@p1',
    parentTaskId: null,
    title: `t-${id}`,
    state: 'done',
    progress: 1,
    startedAt,
    endedAt: startedAt + 1000,
  });
  repo.upsertTaskRun.run({
    id,
    projectId: 'p1',
    memberId: 'codex@p1',
    client: 'codex',
    sessionId: `s-${id}`,
    form,
    model: 'gpt-x',
    title: `t-${id}`,
    startedAt,
    baselineCommit: null,
  });
}
seedTask('t-plugin', 'plugin', 2000);
seedTask('t-cli', 'cli', 1000);
seedTask('t-old', null, 500); // 老数据：没有形态
// 同名不同目录：这一层的 id / name 被加了冲突后缀（stb-dashboard-2），但目录里的
// package.json name 才是用户认得出的名字 —— 任务detail「工程」要显示后者（见 query.js 的 projectLabelOf）
const WS2 = path.join(TMP, 'stb-insight');
fs.mkdirSync(WS2, { recursive: true });
fs.writeFileSync(path.join(WS2, 'package.json'), JSON.stringify({ name: 'stb-dashboard' }));
repo.upsertProject.run({
  id: 'stb-dashboard-2',
  name: 'stb-dashboard-2',
  workspacePath: WS2,
  mainConversationId: null,
  source: 'report',
  createdAt: 3,
});
repo.insertTask.run({
  id: 't-stb',
  projectId: 'stb-dashboard-2',
  memberId: 'claude@stb-dashboard-2',
  parentTaskId: null,
  title: 't-stb',
  state: 'done',
  progress: 1,
  startedAt: 300,
  endedAt: 1300,
});
repo.upsertTaskRun.run({
  id: 't-stb',
  projectId: 'stb-dashboard-2',
  memberId: 'claude@stb-dashboard-2',
  client: 'claude',
  sessionId: 's-t-stb',
  form: null,
  model: 'x',
  title: 't-stb',
  startedAt: 300,
  baselineCommit: null,
});

/* ------------------------------ 真路由 ------------------------------ */
const app = express();
app.use('/api/v1', createQueryRouter({ bus, repo }));
// 上报接口也挂上：工具使用（/tool/use）走的就是它，这里连 HTTP 那一段一起验
app.use('/api/v1', createIngestRouter({ bus }));

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const get = async (qs) => {
    const res = await fetch(`${base}/task-runs?${qs}`);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };

  console.log('[1] 接口本身不报错（SQL 能 prepare + 执行）');
  const all = await get('limit=50');
  ok('HTTP 200', all.status === 200, `status=${all.status}`);
  ok('ok=true 且带回全部 4 条', Boolean(all.body && all.body.ok) && (all.body.items || []).length === 4, JSON.stringify(all.body && all.body.items && all.body.items.length));

  console.log('[2] 返回字段齐（任务列表按这些字段渲染）');
  const row = (all.body.items || []).find((t) => t.id === 't-plugin') || {};
  ok('client 在', row.client === 'codex', row.client);
  ok('form 在（Codex CLI / Codex Plugin 靠它）', row.form === 'plugin', JSON.stringify(row.form));
  ok('项目名在（任务详情「工程」那一栏）', 'project_name' in row && row.project_name === 'p1', JSON.stringify(row.project_name));
  ok('老数据 form 为 null（显示退回只写产品名）', (all.body.items.find((t) => t.id === 't-old') || {}).form === null);
  ok('file_count / files_json / model / result 列都在 SELECT 里', ['file_count', 'files_json', 'model', 'result', 'session_id', 'duration_ms', 'subagentCount'].every((k) => k in row), Object.keys(row).join(','));

  console.log('[3] 楼层筛选照常（合并楼层的逗号集合）');
  const filtered = await get('limit=50&client=codex');
  ok('client=codex 取到 3 条', (filtered.body.items || []).length === 3, JSON.stringify((filtered.body.items || []).map((t) => t.id)));

  console.log('[4] 工具使用：POST /tool/use 逐次累加 → /task-runs 每行带 tools（名字 + 次数）');
  const post = async (p, body) => {
    const res = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'p1', memberId: 'codex@p1', ...body }),
    });
    return res.status;
  };
  // 一轮里：Bash 调了 3 次、Edit 调了 2 次（上报方每调用一次报一条，服务端按 (任务,工具) 累加）
  for (let i = 0; i < 3; i += 1) await post('/tool/use', { taskId: 't-cli', tool: 'Bash', sessionId: 's-t-cli', client: 'codex' });
  for (let i = 0; i < 2; i += 1) await post('/tool/use', { taskId: 't-cli', tool: 'Edit', sessionId: 's-t-cli', client: 'codex' });
  // 拿不到 taskId / 拿不到工具名 → 不记（没任务的计数无处可挂，绝不瞎归因）
  await post('/tool/use', { tool: 'Bash' });
  await post('/tool/use', { taskId: 't-cli', tool: '' });

  const withTools = await get('limit=50');
  const cli = (withTools.body.items || []).find((t) => t.id === 't-cli') || {};
  ok(
    't-cli.tools 累加正确（Bash 3 / Edit 2，次数多的在前）',
    JSON.stringify(cli.tools) === JSON.stringify([{ tool: 'Bash', count: 3 }, { tool: 'Edit', count: 2 }]),
    JSON.stringify(cli.tools)
  );
  const plugin = (withTools.body.items || []).find((t) => t.id === 't-plugin') || {};
  ok('没用过工具的任务 → tools 是空数组（详情那段整块不显示）', Array.isArray(plugin.tools) && plugin.tools.length === 0, JSON.stringify(plugin.tools));

  console.log('[5] 工程显示名：按目录现算（同名不同目录时不该露出冲突后缀）');
  const stb = (withTools.body.items || []).find((t) => t.id === 't-stb') || {};
  ok('project_label = 目录里 package.json 的 name（stb-dashboard）', stb.project_label === 'stb-dashboard', JSON.stringify(stb.project_label));
  ok('库里那行 name 仍是带后缀的 id（只改显示，不动数据）', stb.project_name === 'stb-dashboard-2', JSON.stringify(stb.project_name));

  console.log('[6] 同产品两条会话同时在跑：槽位要跟着还在跑的那条（否则它显示「已取消」）');
  /**
   * 实测 2026-09-30 14:03（Kilo CLI）：会话 A 13:58:46 起的那一轮一直在跑，会话 B 14:03:26 起、
   * 14:03:27 被用户打断收工。B 的 `/task/end` 命中 keepStateForOtherSession（A 还活着）→ 整块
   * 跳过状态写入，槽位（agent_status 一行一成员、只有一个 task_id）于是停在**B 自己那条已经结束
   * 的**任务上，A 那一轮在存活判定里找不到匹配行 → 任务列表里一直显示「已取消」。
   *
   * 这里照真实顺序走路由复现：两条 start → B end（B 的收工状态别被吞掉）→ 查列表里 A 是什么。
   * 让 A "活着"的那份 hook 状态文件照 hook.js 的 statePath 命名写（`<agent>@<工程>@<会话>` 整体
   * sanitize 成 `_`；判据 1 看 hb.pid 还活着，所以 pid 就给本进程）。
   */
  const HOOKS_P1 = path.join(WG_HOME, 'hooks');
  fs.mkdirSync(HOOKS_P1, { recursive: true });
  fs.writeFileSync(
    path.join(HOOKS_P1, 'codex___tmp_p1_s-cli-a.json'),
    JSON.stringify({ client: 'codex', sessionId: 's-cli-a', hb: { pid: process.pid, lastEventAt: Date.now() } })
  );
  await post('/task/start', { taskId: 't-cli-a', sessionId: 's-cli-a', title: 'A' });
  await post('/task/start', { taskId: 't-cli-b', sessionId: 's-cli-b', title: 'B' });
  await post('/task/end', { taskId: 't-cli-b', sessionId: 's-cli-b', state: 'cancelled', workspacePath: '/tmp/p1' });
  const afterEnd = await get('limit=50');
  const stateOf = (body, id) => ((body.items || []).find((t) => t.id === id) || {}).state;
  ok('B 收工后 A 仍显示「进行中」（槽位交接给还没收工的那条）', stateOf(afterEnd.body, 't-cli-a') === 'running', JSON.stringify(stateOf(afterEnd.body, 't-cli-a')));
  ok('B 自己的「已取消」没被交接带走', stateOf(afterEnd.body, 't-cli-b') === 'cancelled', JSON.stringify(stateOf(afterEnd.body, 't-cli-b')));

  // 收工那条会话的心跳**不许**把槽位抢回来（它台账里已经没有在飞的任务了）
  await post('/heartbeat', { sessionId: 's-cli-b', workspacePath: '/tmp/p1' });
  const afterBHb = await get('limit=50');
  ok('收工那条会话的心跳不动槽位', stateOf(afterBHb.body, 't-cli-a') === 'running', JSON.stringify(stateOf(afterBHb.body, 't-cli-a')));

  // 自愈：槽位因为任何原因指歪了（这里手工摆成"指着一条已完成的任务 + 挂在 idle 上"），
  // 那条会话的下一次心跳要把它认领回来，并把 idle 抬成 busy（存活判定要求 busy/thinking/blocked）
  repo.upsertStatus.run({
    memberId: 'codex@p1',
    state: 'idle',
    stateSince: 1,
    taskId: 't-plugin',
    progress: null,
    currentFiles: null,
    lastHeartbeatAt: 1,
    degraded: 0,
    source: 'report',
    updatedAt: 1,
  });
  await post('/heartbeat', { sessionId: 's-cli-a', workspacePath: '/tmp/p1' });
  const st = repo.getStatus.get('codex@p1');
  ok('心跳认领回本会话在飞的那条 + idle 抬成 busy', st.task_id === 't-cli-a' && st.state === 'busy', `${st.task_id}/${st.state}`);
  const healed = await get('limit=50');
  ok('列表里 A 跟着变回「进行中」', stateOf(healed.body, 't-cli-a') === 'running', JSON.stringify(stateOf(healed.body, 't-cli-a')));

  console.log('[6b] CodeBuddy CLI 与 Plugin 是两个会话：后开的任务不能把先开的会话判成已取消');
  bus.registerMember({ project: 'p1', memberId: 'codebuddy', name: 'CodeBuddy', role: 'agent', client: 'codebuddy-plugin' });
  await post('/task/start', {
    memberId: 'codebuddy', taskId: 't-cb-plugin', sessionId: 'cb-plugin-session',
    client: 'codebuddy-plugin', title: 'Plugin 任务',
  });
  bus.registerMember({ project: 'p1', memberId: 'codebuddy', name: 'CodeBuddy', role: 'agent', client: 'codebuddy' });
  await post('/task/start', {
    memberId: 'codebuddy', taskId: 't-cb-cli', sessionId: 'cb-cli-session',
    client: 'codebuddy', title: 'CLI 任务',
  });
  const bothCodeBuddy = await get('limit=50&client=codebuddy,codebuddy-plugin');
  ok('Plugin 会话任务仍显示 running', stateOf(bothCodeBuddy.body, 't-cb-plugin') === 'running', JSON.stringify(stateOf(bothCodeBuddy.body, 't-cb-plugin')));
  ok('CLI 会话任务也显示 running', stateOf(bothCodeBuddy.body, 't-cb-cli') === 'running', JSON.stringify(stateOf(bothCodeBuddy.body, 't-cb-cli')));
  const pluginSessionStatus = repo.getSessionStatus.get({ memberId: 'codebuddy@p1', sessionId: 'cb-plugin-session' });
  const cliSessionStatus = repo.getSessionStatus.get({ memberId: 'codebuddy@p1', sessionId: 'cb-cli-session' });
  ok('Plugin 与 CLI 各自有独立 task 状态行', pluginSessionStatus && pluginSessionStatus.task_id === 't-cb-plugin' && cliSessionStatus && cliSessionStatus.task_id === 't-cb-cli');
  await post('/task/end', {
    memberId: 'codebuddy', taskId: 't-cb-plugin', sessionId: 'cb-plugin-session', state: 'cancelled',
  });
  const afterPluginEnd = await get('limit=50&client=codebuddy,codebuddy-plugin');
  ok('Plugin 收工后只结束自己的任务', stateOf(afterPluginEnd.body, 't-cb-plugin') === 'cancelled', JSON.stringify(stateOf(afterPluginEnd.body, 't-cb-plugin')));
  ok('Plugin 收工不影响 CLI 会话继续 running', stateOf(afterPluginEnd.body, 't-cb-cli') === 'running', JSON.stringify(stateOf(afterPluginEnd.body, 't-cb-cli')));

  console.log('[7] 收工带上来的 token 落进 task_runs 四列 → 接口里读得到（取不到如实 NULL）');
  /**
   * 走**真上报路径**（POST /task/end → bus.endTask → setTaskRunTokens）：reporter hook、
   * 7F Kilo / 8F OpenCode 轮询三路都汇到同一条语句上，所以在这里验一次就够。
   */
  const endStatus = await post('/task/end', {
    taskId: 't-cli',
    sessionId: 's-t-cli',
    client: 'codex',
    state: 'done',
    tokens: { input: 385, output: 440, cacheRead: 93568, cacheWrite: 1024 },
  });
  ok('POST /task/end 200', endStatus === 200, String(endStatus));
  // 没有 usage 的楼层（5F TraeCode / 6F Qoder transcript 里根本没有）整块不发 → 四列留空
  const endNoTokens = await post('/task/end', { taskId: 't-old', sessionId: 's-t-old', client: 'codex', state: 'done' });
  ok('不带 tokens 的收工也 200（缺字段不许把上报打挂）', endNoTokens === 200, String(endNoTokens));

  const tkRows = await get('limit=50');
  const tkRow = (tkRows.body.items || []).find((t) => t.id === 't-cli') || {};
  ok(
    '四列原样落库、且在 /task-runs 的 SELECT 里（渲染层靠它们画「输入 / 输出 token」）',
    tkRow.input_tokens === 385 && tkRow.output_tokens === 440 && tkRow.cache_read_tokens === 93568 && tkRow.cache_write_tokens === 1024,
    JSON.stringify([tkRow.input_tokens, tkRow.output_tokens, tkRow.cache_read_tokens, tkRow.cache_write_tokens])
  );
  const noTk = (tkRows.body.items || []).find((t) => t.id === 't-old') || {};
  ok(
    '没报 token 的那条四列是 null（不是 0 —— 详情显示 "—"，0 是"确实消耗为零"）',
    noTk.input_tokens === null && noTk.output_tokens === null && noTk.cache_read_tokens === null && noTk.cache_write_tokens === null,
    JSON.stringify([noTk.input_tokens, noTk.output_tokens, noTk.cache_read_tokens, noTk.cache_write_tokens])
  );

  // 同一轮收工两次（Stop 之后 SessionEnd 再来一刀、或打断路径紧随其后）：后一刀读不出 usage
  // 就整块不带 —— 那种"没报"只该表示这次没带数，**不许把前一刀落的真值擦成 NULL**。
  await post('/task/end', { taskId: 't-cli', sessionId: 's-t-cli', client: 'codex', state: 'done' });
  const reEnded = await get('limit=50');
  const reRow = (reEnded.body.items || []).find((t) => t.id === 't-cli') || {};
  ok(
    '二次收工没带 token → 已有的真值不被擦掉',
    reRow.input_tokens === 385 && reRow.output_tokens === 440 && reRow.cache_write_tokens === 1024,
    JSON.stringify([reRow.input_tokens, reRow.output_tokens, reRow.cache_write_tokens])
  );

  server.close();
  close();
  fs.rmSync(WG_HOME, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
