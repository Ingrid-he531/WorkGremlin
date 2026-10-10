'use strict';
/**
 * 多产品 hook 转发冒烟测试（Codex / CodeBuddy / Qoder / WorkBuddy）。
 *
 * 验证各家 floor 的 impl 接线正确：repliesOf / formOf / interruptedSince 能跑、事件能路由到
 * startTask / endTask，且产出文本被正确读到。落盘解析全在服务端。
 *
 * 跑法：`npm run test:hook-products`
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-hook-prod-'));

const { createHookDispatch } = require('../src/ingest/hookDispatch');

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

const calls = [];
const bus = {
  registerMember: (b) => { calls.push(['registerMember', b]); return b.memberId; },
  setStatus: () => ({ ok: true }),
  startTask: (b) => { calls.push(['startTask', b]); return { taskId: 't_gen' }; },
  endTask: (b) => { calls.push(['endTask', b]); return { ok: true }; },
  heartbeat: () => ({ ok: true }),
  recordMessage: () => ({ ok: true }),
  toolUse: () => ({ ok: true }),
  fileTouch: () => ({ ok: true }),
  taskProgress: () => ({ ok: true }),
  backfillTaskTokens: () => ({ ok: true }),
  currentTaskFor: () => null,
};

const ctx = { project: 'P', workspacePath: TMP, bus, repo: {} };
const d = createHookDispatch();

function writeJsonl(p, rows) {
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
}

// Codex rollout（首行 session_meta 标 cli 形态）
const CODEX_TP = path.join(TMP, 'codex-rollout.jsonl');
writeJsonl(CODEX_TP, [
  { type: 'session_meta', payload: { source: 'cli', originator: 'codex-tui' } },
  { type: 'user', message: { role: 'user', content: 'codex 干啥' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'output_text', text: 'codex 干成了' }] } },
]);

// Qoder jsonl（首行 user 带 entrypoint 标 cli）
const QODER_TP = path.join(TMP, 'qoder.jsonl');
writeJsonl(QODER_TP, [
  { type: 'user', entrypoint: 'cli', message: { role: 'user', content: 'qoder 干啥' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'qoder 干成了' }] } },
]);

// WorkBuddy jsonl
const WB_TP = path.join(TMP, 'workbuddy.jsonl');
writeJsonl(WB_TP, [
  { type: 'user', message: { role: 'user', content: 'workbuddy 干啥' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'workbuddy 干成了' }] } },
]);

// CodeBuddy index.json + messages/<id>.json（同 Qoder/WorkBuddy 插件）
const CB_DIR = path.join(TMP, 'cb-history', 'sess1');
fs.mkdirSync(path.join(CB_DIR, 'messages'), { recursive: true });
fs.writeFileSync(path.join(CB_DIR, 'index.json'), JSON.stringify({
  messages: [{ id: 'a1', role: 'assistant' }],
  requests: [{ id: 'r1', messages: ['a1'] }],
}), 'utf8');
fs.writeFileSync(path.join(CB_DIR, 'messages', 'a1.json'), JSON.stringify({
  role: 'assistant',
  message: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'codebuddy 干成了' }] }),
}), 'utf8');
const CB_TP = path.join(CB_DIR, 'index.json');

(async () => {
  console.log('多产品 hook 转发冒烟（落盘解析归服务端）');

  async function run(client, tp, expectText) {
    calls.length = 0;
    await d.dispatch({ hook_event_name: 'UserPromptSubmit', session_id: `s_${client}`, client, prompt: '开始', agent: client, cwd: TMP, transcript_path: tp }, ctx);
    const start = calls.find((c) => c[0] === 'startTask');
    ok(`${client} UserPromptSubmit → startTask`, !!start, JSON.stringify(calls.map((c) => c[0])));
    calls.length = 0;
    await d.dispatch({ hook_event_name: 'Stop', session_id: `s_${client}`, client, agent: client, cwd: TMP, transcript_path: tp }, ctx);
    const end = calls.find((c) => c[0] === 'endTask');
    ok(`${client} Stop → endTask(done)`, end && end[1].state === 'done', end && JSON.stringify(end[1]));
    ok(`${client} 服务端读到了产出(${expectText})`, end && end[1].result === expectText, end && end[1].result);
  }

  await run('codex', CODEX_TP, 'codex 干成了');
  await run('qoder', QODER_TP, 'qoder 干成了');
  await run('workbuddy', WB_TP, 'workbuddy 干成了');
  await run('codebuddy', CB_TP, 'codebuddy 干成了');

  // Codex 形态判定应标 cli（通过 formOf 间接验证：起任务时带 form）
  calls.length = 0;
  await d.dispatch({ hook_event_name: 'UserPromptSubmit', session_id: 's_codex2', client: 'codex', prompt: '再', agent: 'codex', cwd: TMP, transcript_path: CODEX_TP }, ctx);
  const st = calls.find((c) => c[0] === 'startTask');
  ok('Codex 形态被识别为 cli', st && st[1].form === 'cli', st && JSON.stringify(st[1]));

  // 形态判定优先看 ev.client：vscode 壳装的 codex（agent 仍是 codex）应标 plugin，且路由仍落到 codex 楼层
  calls.length = 0;
  await d.dispatch({ hook_event_name: 'UserPromptSubmit', session_id: 's_codex_vsc', client: 'vscode', prompt: '再', agent: 'codex', cwd: TMP, transcript_path: CODEX_TP }, ctx);
  const stV = calls.find((c) => c[0] === 'startTask');
  ok('Codex + client=vscode 路由仍落到 codex 楼层', !!stV, stV && JSON.stringify(stV[1]));
  ok('Codex + client=vscode 被识别为 plugin', stV && stV[1].form === 'plugin', stV && JSON.stringify(stV[1]));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
