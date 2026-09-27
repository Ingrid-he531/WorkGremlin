'use strict';
/**
 * 回归测试：收工兜底（bug 3）—— 本地 taskId 丢了也要能把这一轮收干净。
 *
 * 背景：hook 的状态文件是"读-改-写"的，CLI 同一毫秒并行触发多个 hook 进程时 taskId 会被
 * 覆盖冲掉 → Stop 不发 task/end → 产出摘要 / 改动文件 / 结束时间整块丢，任务永远挂 running
 * （实测 2026-09-27 的 13:14 / 13:18 / 13:29 三条 codebuddy 任务全部如此）。修法两条：
 *   · hook 侧：taskId 丢了就调 /api/v1/task/current 回捞（本文件验的是它背后的 bus.currentTaskFor）；
 *   · 服务端侧：task/end 没带 files 时，用 file_activity 里本轮窗口的真值补"修改的文件"。
 *
 * 跑法：`node server/test/taskRecover.test.js`（零依赖，建临时库、用真实 repo / bus）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/db');
const { createIngestBus } = require('../src/ingest/bus');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-task-recover-'));
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));

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

const bus = createIngestBus({ repo, hub: { broadcast() {} }, projectName: 'p1', project: 'p1' });
bus.ensureProject('p1', '/tmp/p1', null, 'report');
bus.registerMember({ project: 'p1', memberId: 'codebuddy', name: 'codebuddy', role: 'agent', client: 'codebuddy' });

console.log('收工兜底：回捞 taskId + 从 file_activity 补文件清单');

const started = bus.startTask({
  project: 'p1',
  memberId: 'codebuddy',
  title: '修一个 bug',
  client: 'codebuddy',
  sessionId: 'sess-A',
});
const taskId = started && started.taskId;
ok('startTask 返回 taskId', Boolean(taskId), JSON.stringify(started));

// [1] 本会话回捞：拿到正在跑的那条
const mine = bus.currentTaskFor('p1', 'codebuddy', 'sess-A');
ok('本会话回捞到正在跑的任务', mine && mine.taskId === taskId, JSON.stringify(mine));
ok('回捞结果带上任务标题（完成标记要用）', mine && mine.title === '修一个 bug', JSON.stringify(mine));

// [2] 别的会话不能误收：库里只有一条 running，但它属于 sess-A，sess-B 不该认领
const other = bus.currentTaskFor('p1', 'codebuddy', 'sess-B');
ok('别的会话回捞为空（绝不误收并行会话的任务）', other && other.taskId === null, JSON.stringify(other));

// [3] 没带会话标识时的保守口径：全表只有这一条 → 认领
const noSession = bus.currentTaskFor('p1', 'codebuddy', '');
ok('无会话标识 + 唯一 running → 认领', noSession && noSession.taskId === taskId, JSON.stringify(noSession));

// [4] 收工时 files 为空 → 用 file_activity 本轮窗口回捞"修改的文件"
bus.fileTouch({ project: 'p1', memberId: 'codebuddy', files: ['src/a.js', 'src/b.js'], op: 'write' });
bus.endTask({ project: 'p1', memberId: 'codebuddy', taskId, state: 'done', result: '改完了', files: [], fileCount: 0 });
const run = repo.getTaskRun.get(taskId);
ok('task/end 后任务已收尾（不是 running）', repo.getTask.get(taskId).state === 'done', repo.getTask.get(taskId).state);
ok('产出摘要落库', run && run.result === '改完了', run && run.result);
ok('files 为空时从 file_activity 补回改动文件数', run && run.file_count === 2, run && String(run.file_count));
ok('files_json 不是空', Boolean(run && run.files_json && run.files_json.includes('src/a.js')), run && run.files_json);

// [5] 收工后不该再回捞到它（避免重复收工）
const after = bus.currentTaskFor('p1', 'codebuddy', 'sess-A');
ok('收工后回捞为空（不会重复收工）', after && after.taskId === null, JSON.stringify(after));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
