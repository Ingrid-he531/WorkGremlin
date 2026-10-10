/**
 * Claude Code「会话 → 模型」自检 —— 沙箱里造 transcript，验尾部反读与派发。
 *
 * 跑法：`npm run test:claude-model`（node 直接跑，零依赖）。
 * 为什么要有它：这段逻辑是"读代码看不出来、只有文件摆成某个形状时才现形"的那一类 ——
 * 首行就是 assistant、末行没换行、CRLF、被窗口切掉一半的行、超长行把窗口顶穿、子代理回合……
 * 每一条都对应下面一个 case。所以这里不 mock，而是把 HOME / CLAUDE_CONFIG_DIR 指到临时目录，
 * 让**真实的** claudeModels / sessions 跑一遍，只断言它们吐出来的字符串。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ 沙箱 ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cmodel-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const CLAUDE = path.join(TMP, 'claude');
const PROJ = path.join(CLAUDE, 'projects', '-home-me-proj');
const HOOKS = path.join(WG, 'hooks');
for (const d of [HOME, WG, CLAUDE, PROJ, HOOKS]) fs.mkdirSync(d, { recursive: true });
// 必须在 require 业务模块**之前**改环境：products 的 HOME 是模块期取值的
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
process.env.CLAUDE_CONFIG_DIR = CLAUDE;

const { selectedModelOf } = require('../src/claude');
const { sessionModel, reporterMainPhase } = require('../src/sessions');
const { claudeHome } = require('../src/claude');

/* ------------------------------ 断言 ------------------------------ */

let pass = 0;
let fail = 0;
const ok = (name, got, want) => {
  if (got === want) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
  }
};

/* ------------------------------ 造 transcript ------------------------------ */

const assistant = (model, extra = {}) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model }, ...extra });
const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

let seq = 0;
/** 写一条会话的 transcript，返回它的 sessionId */
function writeTranscript(lines, sid = `00000000-0000-4000-8000-${String(seq++).padStart(12, '0')}`) {
  fs.writeFileSync(path.join(PROJ, `${sid}.jsonl`), lines.join('\n'));
  return sid;
}
/** 写同一份 transcript，但**不**在末尾补换行 */
function writeRaw(text, sid = `00000000-0000-4000-8000-${String(seq++).padStart(12, '0')}`) {
  fs.writeFileSync(path.join(PROJ, `${sid}.jsonl`), text);
  return sid;
}

/* ------------------------------ 用例 ------------------------------ */

console.log('\n[1] claudeHome：认 CLAUDE_CONFIG_DIR，没设就回 ~/.claude');
ok('设了 → 用环境变量', claudeHome(), CLAUDE);
delete process.env.CLAUDE_CONFIG_DIR;
ok('没设 → HOME/.claude', claudeHome(), path.join(HOME, '.claude'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE;

console.log('\n[2] 常规：取最后一条 assistant 的模型');
ok('两条 assistant → 取后一条', selectedModelOf(writeTranscript([user('hi'), assistant('claude-sonnet-5'), user('again'), assistant('deepseek-flash')])), 'deepseek-flash');

console.log('\n[3] 首行就是 assistant（整窗从 0 起，不许把首行当残段丢掉）');
ok('只有一行', selectedModelOf(writeRaw(assistant('claude-opus-5-5'))), 'claude-opus-5-5');
ok('首行 assistant + 尾随 user', selectedModelOf(writeTranscript([assistant('claude-opus-5-5'), user('x')])), 'claude-opus-5-5');

console.log('\n[4] 换行 / 编码的边角');
ok('末尾无换行', selectedModelOf(writeRaw([user('a'), assistant('claude-haiku-4-5')].join('\n'))), 'claude-haiku-4-5');
ok('CRLF', selectedModelOf(writeRaw([user('a'), assistant('claude-sonnet-5')].join('\r\n') + '\r\n')), 'claude-sonnet-5');
ok('末行是半截 JSON（正在写）→ 退到上一条', selectedModelOf(writeRaw([assistant('claude-sonnet-5'), '{"type":"assis'].join('\n'))), 'claude-sonnet-5');
ok(
  '多字节糊满（中文/emoji）也不截错',
  selectedModelOf(writeTranscript([user('中文😀🚀'), assistant('模型-α'), user('尾巴😀'.repeat(50))])),
  '模型-α'
);

console.log('\n[5] 空 / 没有 assistant 的会话 → 空串（不许编造）');
ok('空文件', selectedModelOf(writeRaw('')), '');
ok('只有 mode / user', selectedModelOf(writeTranscript([JSON.stringify({ type: 'mode', mode: 'x' }), user('a'), user('b')])), '');
ok('文件不存在', selectedModelOf('11111111-1111-4111-8111-111111111111'), '');

console.log('\n[6] 子代理回合（isSidechain）不算这条会话的模型');
ok('末行 sidechain → 跳过取主回合', selectedModelOf(writeTranscript([assistant('claude-sonnet-5'), assistant('claude-haiku-4-5', { isSidechain: true })])), 'claude-sonnet-5');
ok('整份只有 sidechain → 空串', selectedModelOf(writeTranscript([assistant('claude-haiku-4-5', { isSidechain: true })])), '');

console.log('\n[7] 超长行把尾部窗口顶穿 → 自动升窗口，仍要捞到');
{
  // 在最后一条 assistant 之后压一行 >64KB 的（真实场景是巨型 tool_result），
  // 64KB 窗口会整个落在这行里，必须翻到 256KB 才够
  const big = user('x'.repeat(200 * 1024));
  ok('200KB 尾行之后仍取到', selectedModelOf(writeTranscript([user('a'), assistant('deepseek-flash'), big])), 'deepseek-flash');
}

console.log('\n[8] 缓存：文件没动不重读，动了要重新读');
{
  const sid = writeTranscript([assistant('claude-sonnet-5')]);
  ok('第一次', selectedModelOf(sid), 'claude-sonnet-5');
  ok('第二次（命中缓存）', selectedModelOf(sid), 'claude-sonnet-5');
  // 同一会话追加一轮、且换了模型 —— mtime+size 变了，必须重读
  fs.appendFileSync(path.join(PROJ, `${sid}.jsonl`), '\n' + assistant('claude-opus-5-5') + '\n');
  ok('追加后重读（换模型）', selectedModelOf(sid), 'claude-opus-5-5');
}

console.log('\n[9] sessionId 是外部输入：不许穿目录');
for (const bad of ['../../etc/passwd', '..', 'a/b', 'a\\b', '', null, '   ']) {
  ok(`拒绝 ${JSON.stringify(bad)}`, selectedModelOf(bad), '');
}
ok('超长 id 拒绝', selectedModelOf('a'.repeat(129)), '');

console.log('\n[10] 派发：sessionModel 按**基名**查表');
{
  const sid = writeTranscript([assistant('deepseek-flash')]);
  ok('claude', sessionModel('claude', sid), 'deepseek-flash');
  ok('claude-plugin（同产品另一形态）', sessionModel('claude-plugin', sid), 'deepseek-flash');
  ok('CLAUDE（大小写）', sessionModel('CLAUDE', sid), 'deepseek-flash');
  // 适配器只认产品，但会话 id 对不上就是空 —— 别的楼层不会被这条 Claude 会话串味
  ok('codex 走不到 claude 的落盘', sessionModel('codex', sid), '');
  ok('空 client', sessionModel('', sid), '');
  ok('null client', sessionModel(null, sid), '');
  // trae 的适配器仍挂在表上（读的是它自己的 state.vscdb，沙箱里没有 → 空）
  ok('trae 仍挂着且取不到', sessionModel('trae', sid), '');
}

console.log('\n[11] 端到端：reporter 相位里也带上模型');
{
  const sid = writeTranscript([assistant('deepseek-flash')]);
  const transcriptPath = path.join(PROJ, `${sid}.jsonl`);
  // 状态文件字段照真实 hook.js 落的写；sessionPhase.ts 必须晚于本进程启动（纪元守卫）
  fs.writeFileSync(
    path.join(HOOKS, `claude__home-me-proj_${sid}.json`),
    JSON.stringify({
      client: 'claude',
      sessionId: sid,
      transcriptPath,
      sessionPhase: { phase: 'thinking', tool: '', file: '', ts: Date.now(), workspacePath: '/home/me/proj' },
      taskTitle: '改个配色',
    })
  );
  const rp = reporterMainPhase('/home/me/proj', 'claude', sid);
  ok('reporterMainPhase.model', rp && rp.model, 'deepseek-flash');
  ok('顺手确认相位没被带坏', rp && rp.phase, 'thinking');
  ok('用户那句话仍在', rp && rp.prompt, '改个配色');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
