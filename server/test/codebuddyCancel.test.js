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
// HOME 也要换：插件落盘（globalStorage）是按 HOME 找平台数据根（sessions.js 的 dataRoots），
// 不换的话会去读**真实**机器上的 Code/User/globalStorage —— 夹具写进临时 HOME 就永远命中不了。
process.env.HOME = HOME;
// 明确隔离 Claude 那份会话状态文件的根：本文件只验 CodeBuddy，别读进真实环境的东西
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude-empty');

// 必须在设置 WORKGREMLIN_HOME 之后再 require（reporterHookHome 每次调用读 env）
const { readReporterDones, readReporterPhase } = require('../src/sessions');

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
function scenario({ name, taskId, startedAt, running, client = 'codebuddy', phase, phaseTs }) {
  const tp = path.join(HOME, `transcript-${name}.json`);
  fs.writeFileSync(tp, JSON.stringify({ requests: [{ state: running ? 'running' : 'complete' }] }));
  fs.writeFileSync(
    path.join(HOME, 'hooks', `codebuddy__${name}.json`),
    JSON.stringify({
      client,
      sessionId: name,
      taskId: taskId || '',
      taskStartedAt: startedAt || 0,
      taskTitle: '改个东西',
      taskWorkspacePath: WS,
      transcriptPath: tp,
      // 相位：不传就不写（老夹具行为）；传了才写，供 [4] 验"取消后 stale 相位作废"
      ...(phase ? { sessionPhase: { phase, ts: phaseTs, workspacePath: WS } } : {}),
    })
  );
}

const OLD = Date.now() - 5 * 60_000; // 5 分钟前（远超 TASK_RUN_MS = 2 分钟）

/**
 * 写一个 CodeBuddy **插件（IDE 扩展）**的 message-queue 落盘（`<globalStorage>/<插件目录>/message-queue/*.json`）。
 * 插件按"停止"时会把 `runtime.pauseReason='cancel'` 写在这里 —— 那是插件形态唯一的取消真信号
 * （扩展日志里只有 AgentState.cancelled，没有任何 HookExecutor；CLI 那条 FinalStop 等不到）。
 */
function writePauseRuntime(sid, { pauseReason, updatedAt }) {
  const dir = path.join(HOME, '.config', 'Code', 'User', 'globalStorage', 'tencent-cloud.coding-copilot', 'message-queue');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'proj.json'),
    JSON.stringify({
      version: 2,
      conversations: {
        [sid]: {
          conversationId: sid,
          updatedAt,
          runtime: { activated: true, paused: true, pauseReason, updatedAt },
          items: [],
        },
      },
    })
  );
}

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

head('[4] CodeBuddy 插件按停止：message-queue 写 pauseReason=cancel → 合成取消（插件形态的真信号）');
{
  const sid = 'cb-pause-1';
  const at = Date.now() - 20_000;
  writePauseRuntime(sid, { pauseReason: 'cancel', updatedAt: at });
  scenario({
    name: sid,
    taskId: 't_pause',
    startedAt: Date.now() - 30_000,
    running: true,
    client: 'codebuddy-plugin',
    // 取消前冻着的那口相位（比取消时刻旧）
    phase: 'thinking',
    phaseTs: Date.now() - 35_000,
  });
  const { cancels, bySession } = readReporterDones(WS, 'codebuddy,codebuddy-plugin');
  const hit = cancels.find((c) => c.sessionId === sid) || null;
  ok('cancels 含它（补发 task/end 用）', Boolean(hit), JSON.stringify(cancels));
  ok('取消时刻用 runtime.updatedAt（不拿"现在"冒充）', Boolean(hit) && hit.at === at, hit && String(hit.at));
  const mark = bySession.get(sid) || null;
  ok('控制台那枚取消标记也在（红灯能亮）', Boolean(mark) && mark.cancelled === true, JSON.stringify(mark));
  // 顺手钉住相位作废：取消前那口 stale「思考中」不许再当实时相位喂给控制台
  // （否则红灯亮完 10s 又被喂回来，看着像"取消了还停在思考中"）
  const rp = readReporterPhase(WS, 'codebuddy,codebuddy-plugin', sid);
  ok('取消后那口 stale 相位作废（不再上报「思考中」）', rp === null, JSON.stringify(rp));
}

head('[5] paused 但不是 cancel（手工暂停 / 队列等待）→ 不误判成取消');
{
  const sid = 'cb-pause-2';
  writePauseRuntime(sid, { pauseReason: 'manual', updatedAt: Date.now() - 20_000 });
  scenario({ name: sid, taskId: 't_pause2', startedAt: Date.now() - 30_000, running: true, client: 'codebuddy-plugin' });
  const { cancels, bySession } = readReporterDones(WS, 'codebuddy,codebuddy-plugin');
  ok('cancels 不含它', !cancels.some((c) => c.sessionId === sid), JSON.stringify(cancels));
  ok('也没有取消标记', !bySession.get(sid), JSON.stringify(bySession.get(sid)));
}

head('[6] 取消时刻早于本轮开始（上一轮的取消）→ 不算到新一轮头上');
{
  const sid = 'cb-pause-3';
  writePauseRuntime(sid, { pauseReason: 'cancel', updatedAt: Date.now() - 10 * 60_000 });
  scenario({ name: sid, taskId: 't_pause3', startedAt: Date.now() - 30_000, running: true, client: 'codebuddy-plugin' });
  const { cancels, bySession } = readReporterDones(WS, 'codebuddy,codebuddy-plugin');
  ok('cancels 不含它', !cancels.some((c) => c.sessionId === sid), JSON.stringify(cancels));
  ok('也没有取消标记', !bySession.get(sid), JSON.stringify(bySession.get(sid)));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
