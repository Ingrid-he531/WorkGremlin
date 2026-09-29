/**
 * 回归测试：1F CodeBuddy IDE 的「兜底合成取消标记」—— 这一路不收 Stop / Interrupt，
 * 取消只靠 reporter 状态文件里 taskId 一直占着 + transcript 末轮 state='running' 兜底漏出来。
 *
 * 以前这枚兜底标记只写内存、从不 notify 服务端台账 → 任务永远卡在「进行中」。
 * 现在 readReporterDones 把"该补一刀 task/end(cancelled)"的会话列进 `cancels`，
 * 由 sessionRegistry 在 refresh 时去重后发出（见 codebuddyCancel 相关改动）。
 *
 * 本文件只盯 readReporterDones 的检测是否正确（flush 是薄封装，直接调 bus.endTask）：
 *   [1] taskId 占着 + 末轮 running + 空闲 > TASK_RUN_MS → cancels 含这轮打断；
 *   [2] 末轮 state='complete'（正常收尾）→ 不误判成取消；
 *   [3] 空闲还没到 TASK_RUN_MS → 不提前误判（避免长任务被误取消）；
 *   [4] 没有 taskId（已经收过尾）→ 不漏取消标记。
 *
 * 跑法：`node server/test/codebuddyCancel.test.js`（零依赖）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cb-cancel-'));
const HOME = path.join(TMP, 'home');
const WS = path.join(TMP, 'ws');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(path.join(HOME, 'hooks'), { recursive: true });
process.env.WORKGREMLIN_HOME = HOME;

// 必须在设置 WORKGREMLIN_HOME 之后再 require（reporterHookHome 每次调用读 env）
const { readReporterDones } = require('../src/sessions');

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

/** 写一个 CodeBuddy reporter 状态文件 + 对应的 transcript（末轮 state / 产出可控） */
function scenario({ name, taskId, startedAt, running, result, roundFiles }) {
  const tp = path.join(HOME, `transcript-${name}.json`);
  fs.writeFileSync(
    tp,
    JSON.stringify({ requests: [{ state: running ? 'running' : 'complete', ...(result ? { result } : {}) }] })
  );
  const file = path.join(HOME, 'hooks', `codebuddy__${name}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      client: 'codebuddy',
      sessionId: name,
      taskId: taskId || '',
      taskStartedAt: startedAt || 0,
      taskTitle: '改个东西',
      taskWorkspacePath: WS,
      transcriptPath: tp,
      ...(roundFiles ? { roundFiles } : {}),
    })
  );
  return file;
}

const OLD = Date.now() - 5 * 60_000; // 5 分钟前（远超 TASK_RUN_MS）
const RECENT = Date.now() - 10_000; // 10 秒前

head('[1] taskId 占着 + 末轮 running + 空闲够久 → 兜底合成取消标记');
scenario({ name: 'a', taskId: 't_a', startedAt: OLD, running: true });
{
  const { cancels } = readReporterDones(WS, 'codebuddy');
  const hit = cancels.find((c) => c.sessionId === 'a' && c.taskId === 't_a');
  ok('cancels 含被打断的那轮', Boolean(hit), JSON.stringify(cancels));
  ok('补发用的 client 是 codebuddy', hit && hit.client === 'codebuddy', JSON.stringify(hit));
  ok('补发带 workspacePath', hit && hit.workspacePath === WS, JSON.stringify(hit));
}

head('[2] 末轮 state=complete（正常收尾）→ 不误判成取消');
scenario({ name: 'b', taskId: 't_b', startedAt: OLD, running: false });
{
  const { cancels } = readReporterDones(WS, 'codebuddy');
  ok('cancels 不含正常收尾的轮', !cancels.some((c) => c.sessionId === 'b'), JSON.stringify(cancels));
}

head('[3] 空闲还没到 TASK_RUN_MS → 不提前误判（保护长任务）');
scenario({ name: 'c', taskId: 't_c', startedAt: RECENT, running: true });
{
  const { cancels } = readReporterDones(WS, 'codebuddy');
  ok('cancels 不含还在飞的那轮', !cancels.some((c) => c.sessionId === 'c'), JSON.stringify(cancels));
}

head('[4] 没有 taskId（已经收过尾）→ 不漏取消标记');
scenario({ name: 'd', taskId: '', startedAt: OLD, running: true });
{
  const { cancels } = readReporterDones(WS, 'codebuddy');
  ok('cancels 不含没在跑任务的会话', !cancels.some((c) => c.sessionId === 'd'), JSON.stringify(cancels));
}

head('[5] 取消照「任务完成」记录产出：这一轮改过的文件 + 已吐出来的收尾自述都要带上');
{
  const rel = 'src/foo.js';
  const abs = path.join(WS, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'export const a = 1;\n'); // 真建出来，才有 size 可 stat
  scenario({
    name: 'e',
    taskId: 't_e',
    startedAt: OLD,
    running: true,
    result: '改到一半就被掐了',
    roundFiles: [
      { path: rel, op: 'edit', abs },
      { path: rel, op: 'edit', abs }, // 重复项要去掉
    ],
  });
  const { cancels, bySession } = readReporterDones(WS, 'codebuddy');
  const hit = cancels.find((c) => c.sessionId === 'e') || null;
  ok('补发的 task/end 带上 result（这一轮已吐出的自述）', Boolean(hit) && hit.result === '改到一半就被掐了', JSON.stringify(hit));
  ok('补发的 task/end 带上改动文件（去重后一个）', Boolean(hit) && hit.fileCount === 1 && hit.files.some((f) => f.path === rel), JSON.stringify(hit && hit.files));
  const mark = bySession.get('e') || null;
  ok('控制台那枚取消标记也带 files/said（不是空的「没有输出」）', Boolean(mark) && mark.cancelled === true && mark.said === '改到一半就被掐了' && mark.files.length === 1, JSON.stringify(mark));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
