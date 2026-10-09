/**
 * 回归测试：会话**还没说过一句话**时，下拉里的工程名不能是「未知工程」。
 *
 * 起因（用户 2026-10-09 提问）：CLI 刚起、一条对话都还没落盘的那段窗口里，
 * `projects/<工程>/<会话>.jsonl` 里压根没有 cwd —— cwdOfHead 回空 → project 空串 →
 * 渲染层兜底成「未知工程」（renderer/src/stores/sessions.js 的 t('sessions.unknown_project')）。
 *
 * 兜底信号是 `<产品 home>/sessions/<pid>.json`：进程一起来就写，带 sessionId 与 cwd，
 * 比 transcript 还早。2026-10-09 本机实测（~/.codebuddy/sessions/10642.json）。
 *
 * 这里不 mock：真建目录、真写落盘，跑真实的 scanCliSessions，验证：
 *   [1] 前提：这种 transcript 里确实取不到 cwd（不然这条回归测不到东西）
 *   [2] 有一条对口的状态文件 → 工程名 / 工程路径都认出来（不再显示「未知工程」）
 *   [3] 没有对口的状态文件（sessionId 对不上）→ 仍然留空，不猜
 *   [4] transcript 里有 cwd 时，两处都在也不改啄权：仍以 transcript 为准
 *   [5] 整个 sessions/ 目录都没有 → 退回老行为，两条会话都是空工程名
 *
 * 跑法：`npm run test:session-project`（node 直接跑，零依赖）。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ 沙箱 ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-sessproj-'));
process.env.HOME = path.join(TMP, 'home');
process.env.WORKGREMLIN_HOME = path.join(TMP, 'wg');
fs.mkdirSync(process.env.WORKGREMLIN_HOME, { recursive: true });

const { scanCliSessions } = require('../src/sessionRegistry');

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

/* ------------------------------ 造数据 ------------------------------ */

const WS = path.join(TMP, 'work', 'WorkGremlin');
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(WS, 'package.json'), JSON.stringify({ name: '@wg/workgremlin' }));

/** 说话之前的 transcript：有内容（非 0 字节，会被扫进来），但一行都不带 cwd */
const SID = '01a11e3f-2f6c-70ea-9c84-909dc0559741';
/** 另一条同工程的会话：故意不给它配状态文件 —— 它必须保持空工程名 */
const SID2 = '01a11e3f-2f6c-70ea-9c84-909dc0559742';
/** 第三条：transcript 自带 cwd，用它验"两处都有时谁赢" */
const SID3 = '01a11e3f-2f6c-70ea-9c84-909dc0559743';

const ROOT = path.join(process.env.HOME, '.codebuddy');
const PROJ = path.join(ROOT, 'projects', 'tmp-work-WorkGremlin');
fs.mkdirSync(PROJ, { recursive: true });

const slugOf = (p) => p.replace(/[\\/]/g, '-').replace(/^-/, '');

fs.writeFileSync(path.join(PROJ, `${SID}.jsonl`), `${JSON.stringify({ type: 'queue-operation', sessionId: SID })}\n`);
fs.writeFileSync(path.join(PROJ, `${SID2}.jsonl`), `${JSON.stringify({ type: 'queue-operation', sessionId: SID2 })}\n`);
fs.writeFileSync(
  path.join(PROJ, `${SID3}.jsonl`),
  `${JSON.stringify({ id: 'm1', type: 'message', role: 'user', sessionId: SID3, cwd: WS, content: [{ type: 'input_text', text: '你好' }] })}\n`
);

// 会话状态文件：进程起来就写的那种（比 transcript 早）
fs.mkdirSync(path.join(ROOT, 'sessions'), { recursive: true });
const now = Date.now();
fs.writeFileSync(
  path.join(ROOT, 'sessions', '10642.json'),
  JSON.stringify({ pid: 10642, sessionId: SID, cwd: WS, startedAt: now, kind: 'interactive', updatedAt: now })
);
// 诱饵：sessionId 对不上的一份，cwd 指向别处 —— 绝不能串到 SID 头上
const OTHER_WS = path.join(TMP, 'other', 'SomeoneElse');
fs.mkdirSync(OTHER_WS, { recursive: true });
fs.writeFileSync(path.join(OTHER_WS, 'package.json'), JSON.stringify({ name: 'someone-else' }));
fs.writeFileSync(
  path.join(ROOT, 'sessions', '10643.json'),
  JSON.stringify({ pid: 10643, sessionId: 'deadbeef-0000-0000-0000-000000000000', cwd: OTHER_WS, startedAt: now, updatedAt: now })
);
// 诱饵二：cwd 缺字段的一份残缺写法（给自己人 DELETE 一半也不许猜）
fs.writeFileSync(path.join(ROOT, 'sessions', '10644.json'), JSON.stringify({ pid: 10644, sessionId: SID2 }));
// 诱饵三：不是 JSON 的一份（写到一半被杀）
fs.writeFileSync(path.join(ROOT, 'sessions', '10645.json'), '{"pid":10645,"sessionId":"tr');
// 诱饵四：给 SID3 也配一份状态文件，但 cwd 指向别处 —— transcript 自带 cwd 时不许被它覆盖
fs.writeFileSync(
  path.join(ROOT, 'sessions', '10646.json'),
  JSON.stringify({ pid: 10646, sessionId: SID3, cwd: OTHER_WS, startedAt: now, updatedAt: now + 1000 })
);

const rows = scanCliSessions(ROOT, { kind: 'codebuddy' });
const rowOf = (sid) => rows.find((r) => r.sessionId === sid);

/* ------------------------------ 用例 ------------------------------ */

head('[1] 前提：说话之前的 transcript 里确实读不到 cwd');
ok('三条会话都被扫进来了', rows.length === 3, JSON.stringify(rows.map((r) => r.sessionId)));
ok('SID 的 transcript 不带 cwd（cwdOfHead 回空）', !JSON.parse(fs.readFileSync(path.join(PROJ, `${SID}.jsonl`), 'utf8')).cwd);

head('[2] 有一份对口的状态文件 → 工程名认得出来（不再「未知工程」）');
{
  const r = rowOf(SID);
  ok('这条会话在表里', Boolean(r));
  if (r) {
    ok('工程名不再是「未知工程」', r.project === 'workgremlin', JSON.stringify(r.project));
    ok('工程路径是真实的绝对路径', r.projectPath === WS, String(r.projectPath));
  }
}

head('[3] sessionId 对不上 / 字段残缺 → 仍然留空，不猜');
{
  const r = rowOf(SID2);
  ok('这条会话在表里', Boolean(r));
  if (r) {
    ok('没有对口状态文件 → 工程名留空（渲染层显示「未知工程」，与改动前一致）', r.project === '', JSON.stringify(r.project));
    ok('工程路径为空，不拿别处的路径顶替', r.projectPath === '', JSON.stringify(r.projectPath));
  }
}

head('[4] transcript 里已经有 cwd → 不必改啄权，仍以 transcript 为准');
{
  const r = rowOf(SID3);
  ok('这条会话在表里', Boolean(r));
  if (r) {
    ok('工程名仍是 transcript 里的那个（状态文件那份 cwd 被无视）', r.project === 'workgremlin', JSON.stringify(r.project));
    ok('工程路径仍是 transcript 里的那个', r.projectPath === WS, String(r.projectPath));
  }
}

head('[5] 整个 sessions/ 都没有 → 退回老行为');
{
  // 换一个落盘根（不同 dataPath，绕开 liveSessionCwds 的目录级缓存）
  const ROOT2 = path.join(TMP, 'no-state-home', '.claude');
  const PROJ2 = path.join(ROOT2, 'projects', slugOf(WS));
  fs.mkdirSync(PROJ2, { recursive: true });
  fs.writeFileSync(path.join(PROJ2, `${SID}.jsonl`), `${JSON.stringify({ type: 'queue-operation', sessionId: SID })}\n`);
  const rows2 = scanCliSessions(ROOT2, { kind: 'claude' });
  const r2 = rows2.find((r) => r.sessionId === SID);
  ok('会话照样被扫进来（没被状态文件那条路误伤）', Boolean(r2), JSON.stringify(rows2.map((r) => r.sessionId)));
  if (r2) ok('没有 sessions/ 目录 → 工程名留空，不报错', r2.project === '', JSON.stringify(r2.project));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
