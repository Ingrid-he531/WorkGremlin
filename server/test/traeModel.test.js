/**
 * TraeCode「会话 → 模型」自检 —— 老版 vscdb 之外，新版 Trae（2026-09）把
 * `<uid>:AI.agent.model.session_selected_model` 那条 key 彻底废弃了（选择搬进内存态
 * core store，落盘走加密库），唯一明文来源是 renderer.log 的 model-store 事件流。
 *
 * 跑法：`npm run test:trae-model`（node 直接跑，零依赖）。
 * 这里不 mock：把 WORKGREMLIN_DATA_ROOTS 指到临时目录，造出真的
 * `Trae CN/logs/<启动>/window1/renderer.log`，让**真实的** traeModels 跑一遍，
 * 只断言它吐出来的字符串。不碰 better-sqlite3（沙箱 HOME 下没有 vscdb，
 * 老版那一路自然为空，正好单测日志兜底这一路）。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ 沙箱 ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-tmodel-'));
const HOME = path.join(TMP, 'home');
const DATA = path.join(TMP, 'data'); // WORKGREMLIN_DATA_ROOTS 指这里
const LOGS = path.join(DATA, 'Trae CN', 'logs');
fs.mkdirSync(HOME, { recursive: true });
// 必须在 require 业务模块**之前**改环境：products 的 HOME 是模块期取值的
process.env.HOME = HOME;
process.env.WORKGREMLIN_DATA_ROOTS = DATA;

const { selectedModelOf, traeModelName, parseTraeLogEvents } = require('../src/traeModels');

/** 造一次 Trae 启动的 renderer.log；返回写入的文件路径 */
function writeLog(launch, win, lines) {
  const dir = path.join(LOGS, launch, win);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'renderer.log');
  fs.writeFileSync(f, lines.join('\n') + (lines.length ? '\n' : ''));
  return f;
}

/** 真机上抓来的一条原版事件（agentLabel: agent） */
const ev = (sid, label, modelId) =>
  `2026-09-28T13:41:58.886+08:00 [info] [ai-chat/v2] [AiChatV2SelectionFlow][core][model-store] session selected model changed {"sessionId":"${sid}","agentType":"chat","agentLabel":"${label}","previousSelection":{"modelId":"${modelId}","mode":1},"nextSelection":{"modelId":"${modelId}","mode":1}}`;

const SID = '6ab9f62e7dce1ed626032ef3';
const SID2 = 'aaaaf62e7dce1ed626032ef3';

/* ------------------------------ 断言 ------------------------------ */

let pass = 0;
let fail = 0;
const ok = (name, got, want) => {
  if (got === want) {
    pass += 1;
    console.log(`  ok ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${name}\n    want: ${JSON.stringify(want)}\n    got:  ${JSON.stringify(got)}`);
  }
};

console.log('traeModelName');
ok('solo 前缀', traeModelName('solo_agent_1__deepseek-v4.1-flash_null'), 'deepseek-v4.1-flash');
ok('agent 前缀', traeModelName('agent_1__Doubao-Seed-Code_null'), 'Doubao-Seed-Code');
ok('没有 __', traeModelName('Doubao-Seed-Code'), '');
ok('空串', traeModelName(''), '');

console.log('parseTraeLogEvents');
(() => {
  const m = parseTraeLogEvents(ev(SID, 'agent', 'agent_1__Doubao-Seed-Code_null'));
  ok('单事件', JSON.stringify(m), JSON.stringify({ [SID]: { agent: { modelId: 'agent_1__Doubao-Seed-Code_null' } } }));
})();
(() => {
  const m = parseTraeLogEvents([ev(SID, 'agent', 'agent_1__A_null'), ev(SID, 'agent', 'agent_1__B_null')].join('\n'));
  ok('同会话换模型 → 后一条胜', m[SID].agent.modelId, 'agent_1__B_null');
})();
(() => {
  const m = parseTraeLogEvents('前缀没事件的行\n半截 {"sessionId":"x"');
  ok('无事件/半截 JSON → 空', Object.keys(m).length, 0);
})();
(() => {
  const m = parseTraeLogEvents(ev(SID, 'agent', ''));
  ok('缺 modelId → 跳过', Object.keys(m).length, 0);
})();

console.log('selectedModelOf（日志兜底，端到端）');
(() => {
  // 启动 A：两个会话、solo 会话后来换了模型
  writeLog('20260928T130710', 'window1', [
    ev(SID, 'agent', 'agent_1__Doubao-Seed-Code_null'),
    ev(SID2, 'solo_agent', 'solo_agent_1__deepseek-v4.1-flash_null'),
    ev(SID2, 'solo_agent', 'solo_agent_1__kimi-k3_null'),
    '2026-09-28T13:00:00.000+08:00 [info] some other log line',
  ]);
  // 启动 B（更晚）：会话 2 又换了一次模型 —— 以最新启动为准
  writeLog('20260928T140000', 'window1', [ev(SID2, 'solo_agent', 'solo_agent_1__glm-5-flash_null')]);
  ok('agent 会话（agentLabel=agent，payload=solo_agent → 兜底链命中）', selectedModelOf(SID, 'solo_agent'), 'Doubao-Seed-Code');
  ok('solo 会话取最新事件', selectedModelOf(SID2, 'solo_agent'), 'glm-5-flash');
  ok('老版 vscdb 没有这条会话 → 不编造', selectedModelOf('cccccccccccccccccccccccccccccccc', 'solo_agent'), '');
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
