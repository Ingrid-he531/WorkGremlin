/**
 * 回归测试：genie-history 目录名被扩展截断时，工程路径要补回完整值，
 * 主控制台才拿得到实时相位（否则插件会话的 fresh 永远为 false）。
 *
 * 实测（Windows 长路径）：扩展把 `base64(工程路径)` 截到 64 字符，64 字符只装得下 48 字节，
 * 于是 collectProjects 解出来的工程路径只剩前 48 字节（`…/2026-09-14-19-28-26/Wor`），
 * 与 freshestReporterWs 读到的真实路径对不上 —— listSessions 里 `p.path === ws` 永远不成立：
 *   currentId 为空 → sessionRegistry 的 `fresh` 为 false → IsoOfficeView 的 canUseFast 为 false
 *   → 主控制台丢掉 1.5s 快轮询的实时相位，只剩推断出的「待命」，工程名也变成截断残尾 "Wor"。
 *
 * 这里不 mock：把 HOME / WORKGREMLIN_HOME 指到临时目录，摆一份真实落盘（长路径 → 截断目录名
 * + hook 状态文件），跑真实的 listSessions，验证：
 *   [1] 前提成立：目录名确实被截断，解出的半截在磁盘上不是目录；
 *   [2] 端到端：补全后 currentId / project / projectPath / phase / inferred 都对；
 *   [3] 单元：completeTruncatedWorkspace 的边界（未截断放行、补不上原样返回、不误伤）。
 *
 * 跑法：`npm run test:truncated-ws`（node 直接跑，零依赖）。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------ 沙箱 ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-trunc-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
fs.mkdirSync(path.join(HOME, '.config', 'Code', 'User', 'globalStorage'), { recursive: true });
fs.mkdirSync(path.join(WG, 'hooks'), { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;

// 先 require：sessions.js 的 SERVER_STARTED_AT 必须早于下面写的 hook 时间戳，
// 否则相位会被"重启纪元"守卫丢掉 —— 那不是这里要测的东西。
const { listSessions, decodeDirName, completeTruncatedWorkspace } = require('../src/sessions');

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

/** 真实工程路径：刻意拉长（> 48 字节），复现扩展的 64 字符截断 */
const WS = path.join(TMP, 'Users', 'yingh', 'WorkBuddy', '2026-09-14-19-28-26', 'WorkGremlin');
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(WS, 'package.json'), JSON.stringify({ name: 'workgremlin' }));

const STORAGE = path.join(HOME, '.config', 'Code', 'User', 'globalStorage', 'tencent-cloud.coding-copilot');
const SID = '0819ef3ed32241a4970a17b8013f9289';
const CLIENT = 'codebuddy-plugin';
const b64 = Buffer.from(WS).toString('base64url');
const TRUNC = b64.slice(0, 64); // 扩展的截断口径：base64 目录名只留 64 字符
const decoded = decodeDirName(TRUNC); // 只剩前 48 字节

head('[1] 前提：目录名确实被截断（不然这条回归测不到东西）');
ok('base64 目录名超过 64 字符（会被截）', b64.length > 64, `len=${b64.length}`);
ok('截断后的目录名解得出路径', Boolean(decoded), JSON.stringify(decoded));
ok('解出的路径不是真实工程路径', decoded !== WS, `${decoded} vs ${WS}`);
ok(
  '解出的路径是真实路径的前缀（截断=纯前缀截断）',
  WS.replace(/\\/g, '/').toLowerCase().startsWith(decoded.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()),
  `${decoded} ⊄ ${WS}`
);
ok('磁盘上并没有这个半截目录（isDir 判据才成立）', !fs.existsSync(decoded));

// genie-history：按扩展的落盘方式写，目录名就是被截断的 base64
const PROJ_DIR = path.join(STORAGE, 'genie-history', TRUNC);
fs.mkdirSync(path.join(PROJ_DIR, 'conversations', SID), { recursive: true });
fs.writeFileSync(path.join(PROJ_DIR, 'current.json'), JSON.stringify({ conversationId: SID, lastUpdated: Date.now() }));
fs.mkdirSync(path.join(STORAGE, 'todos'), { recursive: true });
fs.writeFileSync(
  path.join(STORAGE, 'todos', `${SID}.json`),
  JSON.stringify({ conversationId: SID, todos: [{ id: 't1', status: 'in_progress', content: '补全工程名' }] })
);
fs.mkdirSync(path.join(STORAGE, 'message-queue'), { recursive: true });
fs.writeFileSync(
  path.join(STORAGE, 'message-queue', 'mq.json'),
  JSON.stringify({ conversations: { [SID]: { runtime: { activated: true, paused: false }, updatedAt: Date.now(), items: [] } } })
);

// hook 状态文件：reporter 上报的是**真实**工程路径（freshestReporterWs 的取值来源）
const hookName = `${CLIENT}@${WS}@${SID}`.replace(/[^a-zA-Z0-9._-]/g, '_');
const now = Date.now();
fs.writeFileSync(
  path.join(WG, 'hooks', `${hookName}.json`),
  JSON.stringify({
    client: CLIENT,
    sessionId: SID,
    taskId: 'task-1',
    taskStartedAt: now,
    taskWorkspacePath: WS,
    sessionPhase: { ts: now, workspacePath: WS, phase: 'tool', tool: 'Edit', target: 'renderer/x.js', detail: '改 renderer/x.js' },
  })
);

/* ------------------------------ 用例 ------------------------------ */

head('[2] 端到端：listSessions 补全半截路径后，主控制台那几样都在');
const st = listSessions({ workspacePath: WS, client: CLIENT, force: true });
ok('currentId 指向这条会话（fresh 的前提）', st.current === SID, JSON.stringify(st.current));
ok('workspacePath 是真实完整路径', st.workspacePath === WS, st.workspacePath);
const row = (st.sessions || []).find((s) => s.id === SID);
ok('这条会话在表里', Boolean(row), JSON.stringify((st.sessions || []).map((s) => s.id)));
if (row) {
  ok('工程名不再是截断残尾（不是 "Wor"）', row.project === 'workgremlin', JSON.stringify(row.project));
  ok('工程路径补回完整值', row.projectPath === WS, row.projectPath);
  ok('mine 置真（归属当前活动工程）', row.mine === true);
  ok('相位是上报真值 tool（不是推断出的待命）', row.phase === 'tool', row.phase);
  ok('inferred 为 false（真值不灰显）', row.inferred === false, String(row.inferred));
}

/* ---------------------------------------------------------------------------
 * [2b] 端到端：两条候选共享同一截断前缀、且"顺序"与"长短"给出相反结论时，
 * 必须按可信度顺序取（ws 在先），不能退回"取最短"。
 *
 * 这是这批改动的核心语义（92b4bde 把「取最短」改成「顺序即优先级」），单靠 [3] 的函数级
 * 断言守住不够：那里 candidates 是手搓的，绕过 listSessions 的 [ws, workspacePath] 拼装。
 * 没有这一段的话，把实现换回「取最短」整套测试照样全绿 —— 回归等于没盯住。
 * --------------------------------------------------------------------------- */
head('[2b] 端到端：候选一长一短、共享同一截断前缀时，按可信度排在前的那条赢');
// 诱饵工程：与 WS 共享被截断的那 48 字节前缀，但比 WS 短 —— 「取最短」会挑它、于是挑错工程。
// 它走的是第二个候选（workspacePath），排在真实活动工程（ws，来自 hook）之后。
const DECOY = `${decoded}z`;
fs.mkdirSync(DECOY, { recursive: true });
fs.writeFileSync(path.join(DECOY, 'package.json'), JSON.stringify({ name: 'decoy' }));
ok('诱饵前提：与 WS 共享被截断的那段前缀', WS.startsWith(decoded) && DECOY.startsWith(decoded), DECOY);
ok('诱饵前提：比 WS 短（「取最短」会挑它）', DECOY.length < WS.length, `${DECOY.length} < ${WS.length}`);
const st2 = listSessions({ workspacePath: DECOY, client: CLIENT, force: true });
ok('currentId 仍指向这条会话（主控制台 fresh 的前提）', st2.current === SID, JSON.stringify(st2.current));
const row2 = (st2.sessions || []).find((s) => s.id === SID);
ok('这条会话在表里', Boolean(row2));
if (row2) {
  ok('补的是真实活动工程 WS，不是更短的诱饵', row2.projectPath === WS, `${row2.projectPath} vs ${DECOY}`);
  ok('工程名是 workgremlin（不是诱饵的 decoy）', row2.project === 'workgremlin', JSON.stringify(row2.project));
  ok('mine 仍置真（会话归属没被诱饵抢走）', row2.mine === true);
}

head('[3] 单元：completeTruncatedWorkspace 的边界');
// 未截断：磁盘上真有这个目录 → 原样返回，绝不乱补
const realDir = path.join(TMP, 'short', 'proj');
fs.mkdirSync(realDir, { recursive: true });
ok('路径是真实存在的目录 → 原样返回（不误伤未截断的机器）', completeTruncatedWorkspace(realDir, [path.join(TMP, 'short')]) === realDir);
// 补不上：没有候选以它为前缀 → 原样返回（不影响别的机器）
ok('候选里没有前缀命中 → 原样返回', completeTruncatedWorkspace(decoded, ['/nope/other']) === decoded);
// 正常补全
ok('候选命中 → 补成完整路径', completeTruncatedWorkspace(decoded, [WS]) === WS);
// 候选里那条正好等于截断串本身 → 不算命中（否则会把半截串当补全目标）
ok('候选等于半截串本身 → 跳过它，取另一条', completeTruncatedWorkspace(decoded, [decoded, WS]) === WS);
// isDir 只作优先判据，不作硬门槛：命中前缀但磁盘上没有该目录 → 仍然补上，
// 不能因为 stat 不到就退回半截残尾（那正是 ec10df 要修的 bug 复发）
ok('命中前缀但磁盘上没有该目录 → 仍补上（isDir 不是硬门槛）', completeTruncatedWorkspace(decoded, [`${WS}-nope`]) === `${WS}-nope`);
// isDir 优先：顺序在前的那条不存在时，让位给后面真实存在的那条
{
  const gBase = path.join(TMP, 'ghost', 'ghost-project-name-here');
  const gMissing = `${gBase}-one`; // 不建目录
  const gReal = `${gBase}-two`; // 真建目录
  fs.mkdirSync(gReal, { recursive: true });
  const gPart = gBase.slice(0, gBase.length - 4); // 半截串：两条都以它为前缀，它本身不是目录
  ok('半截串本身不是目录（前提）', !fs.existsSync(gPart));
  ok('顺序在前但不存在 → 让位给后面真实存在的', completeTruncatedWorkspace(gPart, [gMissing, gReal]) === gReal);
  ok('两条都不存在 → 退回顺序第一条（不硬失败）', completeTruncatedWorkspace(gPart, [gMissing, `${gPart}-x`]) === gMissing);
}
// 顺序即优先级：两条候选共享同一截断前缀时，用排在前面的那条（不做"取最短"）
{
  const common = path.join(TMP, 'collide', 'long-project-name-here');
  const second = path.join(TMP, 'collide', 'long-project-name-here-and-more');
  fs.mkdirSync(common, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  const part = common.slice(0, common.length - 4); // 半截串：两条候选都以它为前缀，但它本身不是目录
  ok('半截串本身不是目录（前提）', !fs.existsSync(part));
  ok('候选共享前缀 → 按顺序取第一条（长的在前也照样取它）', completeTruncatedWorkspace(part, [second, common]) === second);
  ok('（对照）换顺序就取另一条 —— 证明是顺序而不是长短在决定', completeTruncatedWorkspace(part, [common, second]) === common);
}
// 空值安全
ok('decoded 为空 → 原样返回空', completeTruncatedWorkspace('', [WS]) === '');
ok('candidates 为空数组 → 原样返回', completeTruncatedWorkspace(decoded, []) === decoded);
ok('candidates 未传 → 原样返回（默认参数）', completeTruncatedWorkspace(decoded) === decoded);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
