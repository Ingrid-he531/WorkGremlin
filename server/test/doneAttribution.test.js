/**
 * 「任务完成」归属自检 —— 在沙箱里造 hooks 状态文件与各产品的会话落盘，验五条路。
 *
 * 跑法：`npm run test:done`（= node 直接跑，零依赖）。
 * 为什么要有它：这块的每个 bug 都是"读代码看不出来、只有在真实状态文件摆放到位时才现形"的
 * 那一类 —— 切楼层误弹、7F 永不亮、跨工程把别人的收工搬过来。所以这里不 mock 内部函数，
 * 而是把 HOME / WORKGREMLIN_HOME / PATH 全指到临时目录，让**真实的** products 探测、
 * scanCliSessions、doneFieldsOf、snapshot 跑一遍，只断言会话表里出来的字段。
 *
 * 覆盖（每条都对应一个踩过的坑）：
 *   [1] 7F hookSource：有会话 id、工程为空（Stop 后 hook 清空了 sessionPhase）→ 标记照样亮
 *       （守卫只砍 latest 兜底，不许砍精确命中；一刀砍就会让 7F 永不亮 + 下一轮假弹）
 *   [2] 1F CLI：没有会话 id、工程也解析不出来 → 返回空标记，**不能**拿别工程的 latest 冒充
 *   [3] 4F Codex：会话 id 从 rollout 文件名取到 → 完成标记按会话精确，不吃同工程别人刚收工
 *   [4] 相同工程但 id 对不上 → 空标记（"命中不了"= 没完成过，不退回 latest）
 *   [5] 有工程、没有 id（1F）→ 走该工程内的 latest 兜底，且跨工程那份（更新的）不会赢
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ 沙箱 ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-done-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const BIN = path.join(TMP, 'bin');
const HOOKS = path.join(WG, 'hooks');
for (const d of [HOME, HOOKS, BIN]) fs.mkdirSync(d, { recursive: true });
// 7F 是唯一 hookSource 楼层，"装没装"只看这条命令在不在 PATH 上；给个假的，让它进 products
fs.writeFileSync(path.join(BIN, 'trae-cn'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
// 必须在 require 业务模块**之前**改环境：products 的 HOME、sessions 的 reporterHookHome 都在模块期取值
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const { snapshot } = require('../src/sessionRegistry');
const { readReporterDones } = require('../src/sessions');

/* ------------------------------ 造数据 ------------------------------ */

const NOW = Date.now();
/** Stop 时 hook 落的那份完成标记（字段照真实 payload：files 里是 {path,op,size}） */
const doneOf = (msAgo, title, file, ws) => ({
  at: NOW - msAgo,
  title,
  workspacePath: ws,
  startedAt: 0,
  files: [{ path: file, op: 'modify', size: 10 }],
  fileCount: 1,
});

/**
 * 写一份 hook 状态文件。名字照 hook.js 的规则：`<client>__<工程路径把 / 换 _>_<会话id>.json`。
 * 默认 sessionPhase:null + taskWorkspacePath:'' —— 这正是 Stop 之后留下的样子。
 */
function writeState(client, ws, sessionId, done) {
  fs.writeFileSync(
    path.join(HOOKS, `${client}__${String(ws).replace(/\//g, '_')}${sessionId ? `_${sessionId}` : ''}.json`),
    JSON.stringify(
      { client, sessionId, hb: { lastEventAt: NOW - 60_000 }, sessionPhase: null, taskWorkspacePath: '', taskId: null, done },
      null,
      2
    )
  );
}

/** 写一份会话 transcript（一个 jsonl = 一条会话） */
function writeTranscript(root, rel, lines) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const U7 = 'aaaa1111-2222-3333-4444-555566667777';
const UA = '01a0dbb6-5d72-7af1-8afd-bd964964fd3a';
const UB = '01a0dc1c-1ea8-7993-860d-eea6ba644a4e';
const UX = 'bbbb1111-2222-3333-4444-555566667777';
const UY = 'cccc1111-2222-3333-4444-555566667777';

// [1] 7F：Stop 之后的状态文件（有 id、无工程），完成标记必须在
writeState('trae', '/tmp/Proj7', U7, doneOf(60, '7F 收工摘要', 'note.js', '/tmp/Proj7'));

// [2] 1F：没有 cwd 的 transcript（工程解析不出来）+ 另一工程刚落的完成标记
writeTranscript(path.join(HOME, '.codebuddy'), 'nocwd.jsonl', [{ type: 'message', text: 'hi' }]);
writeState('codebuddy', '/tmp/ProjOther', '', doneOf(30, '别的工程收工', 'other.js', '/tmp/ProjOther'));

// [3] 4F：同工程两条 Codex 会话，各自有完成标记（B 更新）
const CODEX_DIR = path.join(HOME, '.codex', 'sessions', '2026', '09', '26');
writeTranscript(CODEX_DIR, `rollout-2026-09-26T10-00-00-${UA}.jsonl`, [
  { type: 'session_meta', payload: { cwd: '/tmp/ProjA' } },
]);
writeTranscript(CODEX_DIR, `rollout-2026-09-26T11-00-00-${UB}.jsonl`, [
  { type: 'session_meta', payload: { cwd: '/tmp/ProjA' } },
]);
writeState('codex', '/tmp/ProjA', UA, doneOf(120, 'A 收工', 'a.js', '/tmp/ProjA'));
writeState('codex', '/tmp/ProjA', UB, doneOf(10, 'B 收工', 'b.js', '/tmp/ProjA'));

// [4] 5F：transcript 的 id 与状态文件里的 id 对不上（同工程另一条会话有完成标记）
writeTranscript(path.join(HOME, '.claude', 'projects', '-tmp-ProjD'), `${UX}.jsonl`, [{ cwd: '/tmp/ProjD' }]);
writeState('claude', '/tmp/ProjD', UY, doneOf(20, '同工程别人的收工', 'y.js', '/tmp/ProjD'));

// [5] 1F：有 cwd 的 transcript（工程解析得出来），本工程有一份、别的工程有一份更新的
writeTranscript(path.join(HOME, '.codebuddy'), 'withcwd.jsonl', [{ cwd: '/tmp/ProjB', text: 'hi' }]);
writeState('codebuddy', '/tmp/ProjB', '', doneOf(120, '同工程收工', 'b.js', '/tmp/ProjB'));
writeState('codebuddy', '/tmp/ProjC', '', doneOf(10, '别工程更新', 'c.js', '/tmp/ProjC'));

/* ------------------------------ 断言 ------------------------------ */

let pass = 0;
let fail = 0;
const head = (t) => console.log(`\n${t}`);
function ok(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? `  — ${extra}` : ''}`);
  }
}

const snap = snapshot({ force: true });
const rows = (floor) => snap.sessions.filter((s) => s.floor === floor);
const desc = (r) => `projectPath=${JSON.stringify(r.projectPath)} sessionId=${JSON.stringify(r.sessionId)} doneAt=${r.doneAt} title=${JSON.stringify(r.doneTitle)}`;

console.log(`沙箱：${TMP}`);
console.log(`楼层：${snap.floors.map((f) => `${f.id}${f.installed ? '' : '(未装)'}`).join(' ')}`);

head('[1] 7F hookSource：有会话 id、工程为空（Stop 后 sessionPhase 被清空）→ 标记照样亮');
{
  const r = rows('7F').find((x) => x.sessionId === U7);
  ok('7F 这一行存在', Boolean(r), JSON.stringify(snap.floors.find((f) => f.id === '7F') || {}));
  if (r) {
    ok('工程归属确为空（复现 Stop 后的状态）', r.projectPath === '', desc(r));
    ok('完成标记仍在（守卫没把精确命中一起砍掉）', r.doneAt === NOW - 60, desc(r));
    ok('摘要用真实完成内容，不是空标记', r.doneTitle === '7F 收工摘要' && r.doneFiles[0] && r.doneFiles[0].name === 'note.js', desc(r));
  }
}

head('[2] 1F CLI：没有会话 id、工程也解析不出来 → 空标记（不许拿别工程的 latest 冒充）');
{
  const r = rows('1F').find((x) => String(x.id).includes('nocwd'));
  ok('1F 这一行存在', Boolean(r));
  if (r) {
    ok('工程确实为空、也没有会话 id', r.projectPath === '' && r.sessionId === '', desc(r));
    ok('完成标记为空（守卫挡住了跨工程兜底）', r.doneAt === 0 && r.doneTitle === '', desc(r));
  }
  // 记录守卫存在的理由：此刻"不按工程过滤"的那份 latest 是全库最新的一份（[5] 里 /tmp/ProjC 那份），
  // 一旦守卫放宽，这一行就会显示成它的收工。
  const { latest } = readReporterDones('', 'codebuddy');
  ok('（背景）不带工程过滤时 latest 是别工程最新的一份', Boolean(latest && latest.title === '别工程更新'), JSON.stringify(latest && latest.title));
}

head('[3] 4F Codex：id 从 rollout 文件名取到 → 完成标记按会话精确');
{
  const a = rows('4F').find((x) => x.sessionId === UA);
  const b = rows('4F').find((x) => x.sessionId === UB);
  ok('两条 Codex 会话都从 rollout 文件名取到了会话 id', Boolean(a && b), `A=${Boolean(a)} B=${Boolean(b)}`);
  if (a) ok('A 拿的是自己的收工（不是更新的 B 的）', a.doneAt === NOW - 120 && a.doneTitle === 'A 收工', desc(a));
  if (b) ok('B 拿的是自己的收工', b.doneAt === NOW - 10 && b.doneTitle === 'B 收工', desc(b));
  if (a && b) ok('同工程两条会话各自独立（没有 latest 串味）', a.doneAt !== b.doneAt, `${desc(a)} | ${desc(b)}`);
}

head('[4] Claude：同工程但 id 对不上 → 空标记（"命中不了"= 没完成过）');
{
  const r = rows('5F').find((x) => x.sessionId === UX);
  ok('5F 这一行存在且 id 取自 transcript 文件名', Boolean(r), desc(rows('5F')[0] || {}));
  if (r) {
    ok('工程解析正确', r.projectPath === '/tmp/ProjD', desc(r));
    ok('不退回 latest：同工程别人的收工不算它的', r.doneAt === 0 && r.doneTitle === '', desc(r));
  }
}

head('[5] 有工程、没有 id（1F）→ 该工程内的 latest 兜底，跨工程那份更新的不赢');
{
  const r = rows('1F').find((x) => String(x.id).includes('withcwd'));
  ok('1F 这一行存在且工程解析出来了', Boolean(r) && r.projectPath === '/tmp/ProjB', r ? desc(r) : '');
  if (r) {
    ok('拿到本工程的收工（不是更新的"别工程更新"）', r.doneAt === NOW - 120 && r.doneTitle === '同工程收工', desc(r));
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
