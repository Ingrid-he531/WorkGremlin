/**
 * 回归测试：上报归属**以 workspacePath 为准**，不是"办公室当前打开的那个工程"。
 *
 * 实测 2026-09-29：用户在办公室开着 workgremlin 的情况下，跑到 /home/yinghui/work/stb-insight
 * 里用 codex CLI 干了一轮 —— 任务记录里那条任务却挂在 workgremlin 名下（办公室视图里那条会话的
 * 工程名倒是对的，因为会话走的是 rollout 的 cwd）。根因：hook 的 resolveCtx 把 workspacePath
 * 取成了 `/api/v1/workspace`（办公室当前工程）的路径，服务端又拿 body.project 当归宿。
 *
 * 现在：hook / 插件都上报"自己真实所在目录"，服务端在 projectFirst 里用
 * bus.projectForReport() 反查工程（按 workspace_path 找已有工程 → 找不到按 package.json name /
 * 目录名建一条）；没带 workspacePath 的老上报退回 body.project，行为不变。
 *
 * 跑法：`npm run test:project-attribution`（零依赖）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');
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
function head(t) {
  console.log(`\n${t}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-attr-'));
/** 办公室当前打开的工程（workgremlin 的去标识版） */
const WS_A = path.join(TMP, 'workgremlin');
/** agent 真实干活的工程（stb-insight：package.json 名字与目录名不同，正好覆盖取名口径） */
const WS_B = path.join(TMP, 'stb-insight');
for (const [dir, name] of [
  [WS_A, 'workgremlin'],
  [WS_B, 'stb-dashboard'],
]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
}

const { repo, close } = openDatabase(path.join(TMP, 'test.db'));
const bus = createIngestBus({ repo, hub: { broadcast() {} }, projectName: 'workgremlin', project: 'workgremlin' });
// 办公室"打开"了 A：projects 里有 A 这一行（id = package.json name）
bus.ensureProject('workgremlin', WS_A, null, 'report');

const app = express();
app.use('/api/v1', createIngestRouter({ bus }));

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const post = async (route, body) => {
    const res = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  head('[1] 办公室开着 A、agent 在 B 里干活 → 任务归到 B（不是 A）');
  // agent 注册 + 开轮，都带自己真实所在目录（WS_B）、而 project 字段仍是办公室的 A
  await post('/register', { project: 'workgremlin', memberId: 'codex', name: 'codex', role: 'agent', workspacePath: WS_B });
  const started = await post('/task/start', { project: 'workgremlin', memberId: 'codex', title: '在 B 里干活', workspacePath: WS_B });
  ok('task/start 成功', started.status === 200 && started.body && started.body.ok, JSON.stringify(started.body));
  const taskId = started.body && started.body.taskId;
  const row = repo.getTask.get(taskId);
  ok('任务落到了 B 的工程 id（package.json name = stb-dashboard）', Boolean(row) && row.project_id === 'stb-dashboard', row && row.project_id);
  ok('B 的工程行按真实路径建好了', Boolean(repo.getProjectByWorkspace.get(WS_B)), JSON.stringify(repo.listProjects.all().map((p) => [p.id, p.workspace_path])));
  ok('成员也挂在 B 下（不是 A）', Boolean(repo.getMember.get('codex@stb-dashboard')), JSON.stringify(repo.listMembers.all('stb-dashboard').map((m) => m.id)));

  head('[2] 老上报（没带 workspacePath）→ 退回 project 字段，行为不变');
  await post('/register', { project: 'workgremlin', memberId: 'claude', name: 'claude', role: 'agent' });
  const started2 = await post('/task/start', { project: 'workgremlin', memberId: 'claude', title: '老上报' });
  const row2 = repo.getTask.get(started2.body && started2.body.taskId);
  ok('仍归到 project 指定的 A', Boolean(row2) && row2.project_id === 'workgremlin', row2 && row2.project_id);

  head('[3] 同一目录再次上报 → 复用同一工程行（不重复建）');
  const before = repo.listProjects.all().length;
  await post('/task/start', { project: 'workgremlin', memberId: 'codex', title: '再来一轮', workspacePath: WS_B });
  const after = repo.listProjects.all().length;
  ok('工程行数没变', before === after, `${before} → ${after}`);
  ok('B 的工程 id 仍是 stb-dashboard', (repo.getProjectByWorkspace.get(WS_B) || {}).id === 'stb-dashboard', JSON.stringify(repo.getProjectByWorkspace.get(WS_B)));

  server.close();
  close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
