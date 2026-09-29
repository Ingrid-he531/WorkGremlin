/**
 * 回归测试：4F Claude Code / 6F Qoder 按"停止"时 —— **一个 hook 事件都不发**，
 * 服务端必须自己从 transcript 尾部认出这一轮被打断，合成取消标记。
 *
 * 实测 2026-09-29（4F，VS Code 扩展形态）：按下停止后 events.log 里 Stop / SessionEnd /
 * Notification 全无，事件流停在最后一次 PostToolUse；hook 侧那条 `turnInterrupted` 跑在
 * Stop 分支里，没事件就永远执行不到 → 控制台一直停在「思考中」、也永远不亮红色「任务取消」。
 * 唯一权威的痕迹是 transcript 末尾那条 user 消息 `[Request interrupted by user]`。
 *
 * 本文件盯 readReporterDones 的检测（补发 task/end 那一步是薄封装，直接调 bus.endTask）：
 *   [1] taskId 占着 + transcript 末尾有打断标记 → cancels 含这轮，并按会话给出取消标记；
 *   [2] 正常收尾（没有打断标记）→ 不误判；
 *   [3] 打断标记是**上一轮**落的（时间戳早于本轮开始）→ 不算这一轮；
 *   [4] 取消标记照「任务完成」一样带产出：roundFiles 的改动清单 + 打断前最后那句话。
 *
 * 跑法：`npm run test:claude-cancel`（零依赖）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-claude-cancel-'));
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

/**
 * 造 Claude 风格的 transcript（JSONL）+ reporter 状态文件。
 * @param {{name:string, taskId?:string, startedAt?:number, interrupted?:boolean,
 *          said?:string, markerTs?:string, roundFiles?:Array<any>}} o
 */
function scenario({ name, taskId, startedAt, interrupted = false, said = '', markerTs = '', roundFiles }) {
  const nowIso = new Date().toISOString();
  const tp = path.join(HOME, `transcript-${name}.jsonl`);
  const lines = [
    { type: 'user', sessionId: name, timestamp: nowIso, message: { role: 'user', content: [{ type: 'text', text: '改点东西' }] } },
  ];
  if (said) {
    lines.push({
      type: 'assistant',
      sessionId: name,
      timestamp: nowIso,
      message: { role: 'assistant', content: [{ type: 'text', text: said }] },
    });
  }
  if (interrupted) {
    lines.push({
      type: 'user',
      sessionId: name,
      timestamp: markerTs || nowIso,
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    });
  }
  fs.writeFileSync(tp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const file = path.join(HOME, 'hooks', `claude__${name}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      client: 'claude',
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

const NOW = Date.now();

head('[1] taskId 占着 + transcript 末尾有 [Request interrupted by user] → 合成取消标记');
scenario({ name: 'a', taskId: 't_a', startedAt: NOW - 30_000, interrupted: true });
{
  const { cancels, bySession } = readReporterDones(WS, 'claude');
  const hit = cancels.find((c) => c.sessionId === 'a' && c.taskId === 't_a') || null;
  ok('cancels 含被打断的那轮（补发 task/end 用）', Boolean(hit), JSON.stringify(cancels));
  ok('补发带 workspacePath / client', Boolean(hit) && hit.workspacePath === WS && hit.client === 'claude', JSON.stringify(hit));
  const mark = bySession.get('a') || null;
  ok('按会话给出取消标记（控制台亮红色「任务取消」靠它）', Boolean(mark) && mark.cancelled === true, JSON.stringify(mark));
}

head('[2] 正常收尾（transcript 里没有打断标记）→ 不误判成取消');
scenario({ name: 'b', taskId: 't_b', startedAt: NOW - 30_000, interrupted: false, said: '这一轮干完了' });
{
  const { cancels, bySession } = readReporterDones(WS, 'claude');
  ok('cancels 不含正常收尾的轮', !cancels.some((c) => c.sessionId === 'b'), JSON.stringify(cancels));
  ok('也没有取消标记', !bySession.get('b'), JSON.stringify(bySession.get('b')));
}

head('[3] 打断标记是**上一轮**落的（早于本轮开始）→ 不算这一轮');
scenario({
  name: 'c',
  taskId: 't_c',
  startedAt: NOW - 10_000,
  interrupted: true,
  markerTs: new Date(NOW - 30 * 60_000).toISOString(),
});
{
  const { cancels, bySession } = readReporterDones(WS, 'claude');
  ok('cancels 不含它（老标记不能算到新一轮头上）', !cancels.some((c) => c.sessionId === 'c'), JSON.stringify(cancels));
  ok('也没有取消标记', !bySession.get('c'), JSON.stringify(bySession.get('c')));
}

head('[4] 取消照「任务完成」一样带产出：改动清单 + 打断前最后那句话');
{
  const rel = 'src/foo.js';
  const abs = path.join(WS, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'export const a = 1;\n');
  scenario({
    name: 'd',
    taskId: 't_d',
    startedAt: NOW - 30_000,
    interrupted: true,
    said: '改到一半就被掐了',
    roundFiles: [
      { path: rel, op: 'edit', abs },
      { path: rel, op: 'edit', abs }, // 重复项要去掉
    ],
  });
  const { cancels, bySession } = readReporterDones(WS, 'claude');
  const hit = cancels.find((c) => c.sessionId === 'd') || null;
  ok('补发带 result（打断前最后一句话）', Boolean(hit) && hit.result === '改到一半就被掐了', JSON.stringify(hit));
  ok('补发带改动清单（去重后 1 个）', Boolean(hit) && hit.fileCount === 1 && hit.files.some((f) => f.path === rel), JSON.stringify(hit && hit.files));
  const mark = bySession.get('d') || null;
  ok('控制台那枚取消标记也带 files / said', Boolean(mark) && mark.said === '改到一半就被掐了' && mark.files.length === 1, JSON.stringify(mark));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
