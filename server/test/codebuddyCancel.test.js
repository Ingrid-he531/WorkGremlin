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
 * 真正"用户按了停止"的信号：Claude / Qoder 认 transcript 尾部的打断标记 + 会话状态文件说 idle；
 * CodeBuddy 插件（IDE 扩展）认它自己 transcript 目录 messages/ 里那条 role=assistant、
 * text==='[User Cancelled]' 的消息（实测：每次用户按停止精确产生一条，内部超时不会产生——这正是对比
 * message-queue 的 pauseReason='cancel' 不可靠的原因，见 [5]）。见 server/src/sessions.js 的
 * claude.interruptOf 与 server/test/claudeCancel.test.js，CodeBuddy 这一路见 floorCodebuddy.js 的
 * codebuddyCancelAt。
 *
 * 本文件钉住的是"去掉 message-queue 误判 + 改用 transcript 真信号"这件事：
 *   [1] 长思考（taskId 占着、空闲 5 分钟、末轮 state='running'）→ **不再**合成取消；
 *   [2] 末轮 state='complete'（正常收尾）→ 当然也不合成；
 *   [3] 没有 taskId（已经收过尾）→ 不合成；
 *   [4] CodeBuddy 插件 transcript 写 [User Cancelled] → 合成取消（插件形态真信号）；
 *   [5] 只有 message-queue 的 pauseReason=cancel（内部超时）→ **不**合成取消；
 *   [6] 取消时刻早于本轮开始（上一轮取消）→ 不算到新一轮头上。
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

/**
 * 写一个 CodeBuddy reporter 状态文件 + 对应的 transcript（末轮 state 可控）。
 * @param {{ name: string, taskId?: string, startedAt?: number, running?: boolean, client?: string,
 *           form?: string, phase?: string, phaseTs?: number, done?: object }} o
 */
function scenario({ name, taskId, startedAt, running, client = 'codebuddy', form = 'cli', phase, phaseTs, done, transcriptPath }) {
  const tp = path.join(HOME, `transcript-${name}.json`);
  fs.writeFileSync(tp, JSON.stringify({ requests: [{ state: running ? 'running' : 'complete' }] }));
  fs.writeFileSync(
    path.join(HOME, 'hooks', `codebuddy__${name}.json`),
    JSON.stringify({
      client,
      form,
      sessionId: name,
      taskId: taskId || '',
      taskStartedAt: startedAt || 0,
      taskTitle: '改个东西',
      taskWorkspacePath: WS,
      transcriptPath: transcriptPath || tp,
      // 相位：不传就不写（老夹具行为）；传了才写，供 [4] 验"取消后 stale 相位作废"
      ...(phase ? { sessionPhase: { phase, ts: phaseTs, workspacePath: WS } } : {}),
      // 完成/取消标记：Stop 落盘（cancelled=true 即被用户掐断）；不传就不写
      ...(done ? { done } : {}),
    })
  );
}

const OLD = Date.now() - 5 * 60_000; // 5 分钟前（远超 TASK_RUN_MS = 2 分钟）

/**
 * 写一个 CodeBuddy **插件（IDE 扩展）**的 transcript 落盘（`<dir>/index.json` + `messages/<id>.json`）。
 * 用户按"停止"时插件在 messages 里写一条 role=assistant、text='[User Cancelled]' 的消息 ——
 * 那是插件形态唯一的取消真信号（message-queue 的 pauseReason='cancel' 内部超时也会写，不可靠；
 * CLI 那条 FinalStop 在 IDE 形态等不到）。取消时刻用这条消息文件的 mtime。
 */
function writeCancelTranscript(sid, at) {
  const dir = path.join(HOME, `tr-${sid}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ requests: [{ state: 'running' }] }));
  const mdir = path.join(dir, 'messages');
  fs.mkdirSync(mdir, { recursive: true });
  const fp = path.join(mdir, 'cancel.json');
  fs.writeFileSync(fp, JSON.stringify({
    role: 'assistant',
    message: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: '[User Cancelled]' }] }),
  }));
  fs.utimesSync(fp, new Date(at), new Date(at));
  return path.join(dir, 'index.json');
}

/**
 * 写一个 CodeBuddy 插件 message-queue 落盘（`<globalStorage>/<插件目录>/message-queue/*.json`），
 * 把 `runtime.pauseReason='cancel'` 写进去 —— 这是**不可靠**的历史信号（插件内部超时也会写），
 * 新逻辑已不再读取它（见 [5]）。
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

head('[4] CodeBuddy 插件按停止：transcript 写 [User Cancelled] → 合成取消（插件形态的真信号）');
{
  const sid = 'cb-pause-1';
  const at = Date.now() - 20_000;
  const tp = writeCancelTranscript(sid, at);
  scenario({
    name: sid,
    taskId: 't_pause',
    startedAt: Date.now() - 30_000,
    running: true,
    // 身份恒为基名 codebuddy；形态走 form（插件 = vscode）
    client: 'codebuddy',
    form: 'vscode',
    // 取消前冻着的那口相位（比取消时刻旧）
    phase: 'thinking',
    phaseTs: Date.now() - 35_000,
    transcriptPath: tp,
  });
  const { cancels, bySession } = readReporterDones(WS, 'codebuddy');
  const hit = cancels.find((c) => c.sessionId === sid) || null;
  ok('cancels 含它（补发 task/end 用）', Boolean(hit), JSON.stringify(cancels));
  ok('取消时刻用消息文件 mtime（不拿"现在"冒充）', Boolean(hit) && Math.abs(Number(hit.at) - at) <= 1000, hit && String(hit.at));
  const mark = bySession.get(sid) || null;
  ok('控制台那枚取消标记也在（红灯能亮）', Boolean(mark) && mark.cancelled === true, JSON.stringify(mark));
  // 相位作废：取消前那口 stale「思考中」不许再当实时相位喂给控制台
  const rp = readReporterPhase(WS, 'codebuddy', sid);
  ok('取消后那口 stale 相位作废（不再上报「思考中」）', rp === null, JSON.stringify(rp));
}

head('[5] 只有 message-queue 的 pauseReason=cancel、transcript 没有 [User Cancelled]（插件内部超时）→ 不误判成取消');
{
  const sid = 'cb-pause-2';
  writePauseRuntime(sid, { pauseReason: 'cancel', updatedAt: Date.now() - 20_000 });
  scenario({ name: sid, taskId: 't_pause2', startedAt: Date.now() - 30_000, running: true, client: 'codebuddy', form: 'vscode' });
  const { cancels, bySession } = readReporterDones(WS, 'codebuddy');
  ok('cancels 不含它（不再信 pauseReason，只认 transcript [User Cancelled]）', !cancels.some((c) => c.sessionId === sid), JSON.stringify(cancels));
  ok('也没有取消标记', !bySession.get(sid), JSON.stringify(bySession.get(sid)));
}

head('[6] 取消时刻早于本轮开始（上一轮的取消）→ 旧任务仍被兜底标 cancelled，但当前在跑任务不被误标');
{
  const sid = 'cb-pause-3';
  const at = Date.now() - 10 * 60_000;
  const tp = writeCancelTranscript(sid, at);
  scenario({ name: sid, taskId: 't_pause3', startedAt: Date.now() - 30_000, running: true, client: 'codebuddy', form: 'vscode', transcriptPath: tp });
  const { cancels, bySession } = readReporterDones(WS, 'codebuddy');
  // 多任务会话：上一轮的取消要被认出来（交给 flushSynthesizedCancels 按会话兜底匹配旧任务）
  const hit = cancels.find((c) => c.sessionId === sid) || null;
  ok('cancels 含它（旧任务会被兜底标 cancelled）', Boolean(hit), JSON.stringify(cancels));
  ok('但它不绑当前 taskId（交给会话兜底匹配，不误伤当前在跑任务）', Boolean(hit) && !hit.taskId, JSON.stringify(hit));
  // 当前这一轮还在跑，主控制台绝不能被上一轮的取消误标成「已取消」
  ok('主控制台不把当前在跑任务误标为取消', !bySession.get(sid) || bySession.get(sid).cancelled !== true, JSON.stringify(bySession.get(sid)));
}

head('[6b] 先取消过、后正常收尾的会话不许显示「任务取消」（done 比取消新）');
{
  const sid = 'cb-plugin-done-1';
  const cancelAt = Date.now() - 60_000; // 早先取消过一轮
  const doneAt = Date.now() - 10_000; // 之后这一轮正常收尾（比取消新）
  const tp = writeCancelTranscript(sid, cancelAt);
  scenario({
    name: sid,
    taskId: '',
    startedAt: 0,
    running: false,
    client: 'codebuddy',
    form: 'vscode',
    transcriptPath: tp,
    done: { at: doneAt, cancelled: false, title: '改个东西' },
  });
  const { bySession, cancels } = readReporterDones(WS, 'codebuddy');
  const mark = bySession.get(sid) || null;
  ok('主控制台是正常完成（cancelled 不为真）', Boolean(mark) && mark.cancelled !== true, JSON.stringify(mark));
  // 更早那轮的取消仍进台账，但不绑当前 taskId（交给会话兜底匹配，不误伤当前会话）
  const hit = cancels.find((c) => c.sessionId === sid) || null;
  ok('更早那轮的取消进台账、且不绑当前 taskId', Boolean(hit) && !hit.taskId, JSON.stringify(hit));
}

head('[7] CodeBuddy CLI 等待授权时按 ESC（Stop 落盘 done.cancelled）→ 主控制台相位作废（不再亮「等待授权」）');
{
  const sid = 'cb-cli-cancel-1';
  const at = Date.now() - 5_000;
  scenario({
    name: sid,
    taskId: 't_cli',
    startedAt: Date.now() - 60_000,
    running: true,
    client: 'codebuddy',
    // 冻结在「等待授权」（用户按 ESC 前那一刻）
    phase: 'await',
    phaseTs: Date.now() - 30_000,
    // Stop 落盘的取消标记（任务列表据此亮「已取消」）
    done: { cancelled: true, at },
  });
  const rp = readReporterPhase(WS, 'codebuddy', sid);
  ok('相位作废（主控制台切到「任务取消」红灯，不再是「等待授权」）', rp === null, JSON.stringify(rp));
}

head('[7b] 正常「等待授权」、没有取消标记 → 相位照常上报（不误作废）');
{
  const sid = 'cb-cli-await-1';
  // phaseTs 取当前时刻：保证越过 readReporterPhase 的「重启后残留相位」过滤（SERVER_STARTED_AT），
  // 把验证点收口在"done.cancelled 不误作废正常 await"上。
  scenario({
    name: sid,
    taskId: 't_cli2',
    startedAt: Date.now() - 60_000,
    running: true,
    client: 'codebuddy',
    phase: 'await',
    phaseTs: Date.now(),
  });
  const rp = readReporterPhase(WS, 'codebuddy', sid);
  ok('仍上报「等待授权」', Boolean(rp) && rp.phase === 'await', JSON.stringify(rp));
}

head('[7c] CLI 取消（done.cancelled）→ 也合成进 cancels（flush 才能把 task_runs 收成 cancelled，与主控制台/滚动屏统一）');
{
  const sid = 'cb-cli-cancel-2';
  const at = Date.now() - 5_000;
  scenario({
    name: sid,
    taskId: 't_cli3',
    startedAt: Date.now() - 60_000,
    running: true,
    client: 'codebuddy',
    phase: 'await',
    phaseTs: Date.now() - 30_000,
    // Stop 落盘：取消 + 那句「interrupted by user」产出摘要
    done: { cancelled: true, at, said: 'interrupted by user', workspacePath: WS, files: [] },
  });
  const { cancels, bySession } = readReporterDones(WS, 'codebuddy');
  const hit = cancels.find((c) => c.sessionId === sid) || null;
  ok('cancels 含 CLI 取消（补刀 task/end(cancelled) 用）', Boolean(hit), JSON.stringify(cancels));
  ok('result 带那句「interrupted by user」（取消也照带产出摘要）', Boolean(hit) && hit.result === 'interrupted by user', hit && hit.result);
  const mark = bySession.get(sid) || null;
  ok('bySession 取消标记也在（主控制台红灯）', Boolean(mark) && mark.cancelled === true, JSON.stringify(mark));
}

head('[7d] CLI 正常收尾（done.cancelled=false）→ 不合成 cancels（不误判成取消）');
{
  const sid = 'cb-cli-done-1';
  scenario({
    name: sid,
    taskId: 't_cli4',
    startedAt: Date.now() - 60_000,
    running: false,
    client: 'codebuddy',
    done: { cancelled: false, at: Date.now() - 5_000, said: 'done', workspacePath: WS, files: [] },
  });
  const { cancels } = readReporterDones(WS, 'codebuddy');
  ok('cancels 不含正常收尾', !cancels.some((c) => c.sessionId === sid), JSON.stringify(cancels));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
