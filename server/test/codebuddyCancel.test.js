/**
 * 回归测试：**别再按"任务槽卡死 + transcript 末轮 state='running'"去合成取消**。
 *
 * 背景：1F CodeBuddy IDE 收不到 Stop / Interrupt，曾经有一条兜底 —— "taskId 还占着 +
 * 空闲超过 TASK_RUN_MS + transcript 末轮 state='running' ⇒ 这一轮被打断"，然后合成取消标记
 * （红色「任务取消」）并补一刀 task/end(cancelled)。
 *
 * 2026-09-29 去掉：它分不清"还在慢慢想"和"被打断"。用户实测 —— codebuddy 当前这一轮明明还在跑，
 * 控制台先弹「任务取消」+「待命中」，下一条事件回来又跳回「思考中」（模型有一次纯推理 >2 分钟、
 * 中间一个工具事件都没有）。宁可这种轮暂时停在旧相位（相位新鲜期到了会回落待命），也不误报取消。
 *
 * 真正"用户按了停止"的信号只认 Claude / Qoder 那两个（transcript 尾部的打断标记、
 * Claude 自己那份会话状态文件说 idle），见 server/src/sessions.js 的 claudeInterruptOf
 * 与 server/test/claudeCancel.test.js。
 *
 * 本文件钉住的是"去掉"这件事：
 *   [1] 长思考（taskId 占着、空闲 5 分钟、末轮 state='running'）→ **不再**合成取消；
 *   [2] 末轮 state='complete'（正常收尾）→ 当然也不合成；
 *   [3] 没有 taskId（已经收过尾）→ 不合成。
 *
 * 跑法：`npm run test:codebuddy-cancel`（零依赖）
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
// 明确隔离 Claude 那份会话状态文件的根：本文件只验 CodeBuddy，别读进真实环境的东西
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude-empty');

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

/** 写一个 CodeBuddy reporter 状态文件 + 对应的 transcript（末轮 state 可控） */
function scenario({ name, taskId, startedAt, running }) {
  const tp = path.join(HOME, `transcript-${name}.json`);
  fs.writeFileSync(tp, JSON.stringify({ requests: [{ state: running ? 'running' : 'complete' }] }));
  fs.writeFileSync(
    path.join(HOME, 'hooks', `codebuddy__${name}.json`),
    JSON.stringify({
      client: 'codebuddy',
      sessionId: name,
      taskId: taskId || '',
      taskStartedAt: startedAt || 0,
      taskTitle: '改个东西',
      taskWorkspacePath: WS,
      transcriptPath: tp,
    })
  );
}

const OLD = Date.now() - 5 * 60_000; // 5 分钟前（远超 TASK_RUN_MS = 2 分钟）

head('[1] 长思考（taskId 占着 + 空闲 5 分钟 + 末轮 running）→ 不再合成取消');
scenario({ name: 'a', taskId: 't_a', startedAt: OLD, running: true });
{
  const { cancels, bySession } = readReporterDones(WS, 'codebuddy');
  ok('cancels 不含它（不会误报「任务取消」）', !cancels.some((c) => c.sessionId === 'a'), JSON.stringify(cancels));
  ok('也没有按会话的取消标记', !bySession.get('a'), JSON.stringify(bySession.get('a')));
}

head('[2] 末轮 state=complete（正常收尾）→ 同样不合成');
scenario({ name: 'b', taskId: 't_b', startedAt: OLD, running: false });
{
  const { cancels } = readReporterDones(WS, 'codebuddy');
  ok('cancels 不含正常收尾的轮', !cancels.some((c) => c.sessionId === 'b'), JSON.stringify(cancels));
}

head('[3] 没有 taskId（已经收过尾）→ 不合成');
scenario({ name: 'c', taskId: '', startedAt: OLD, running: true });
{
  const { cancels } = readReporterDones(WS, 'codebuddy');
  ok('cancels 不含没在跑任务的会话', !cancels.some((c) => c.sessionId === 'c'), JSON.stringify(cancels));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
