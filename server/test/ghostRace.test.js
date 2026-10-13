'use strict';
/**
 * 回归测试：并发 hook 的"丢失更新"与"幽灵收不掉"（2026-09-27 的 bug 1 / 2 / 3）。
 *
 * 背景（实测）：CodeBuddy CLI 会在**同一毫秒**并行触发多个 hook 事件 ——
 * ~/.workgremlin/hooks/events.log 里 05:29:45.178 / .184 / .189 三条 PreToolUse(Agent)。
 * 旧代码每个 hook 是独立进程，各自 readFile → 改内存 → writeFileSync，于是互相覆盖：
 *   · 三条 ghost+ 只落两条 —— 召唤台账丢了，幽灵收不掉（bug 1）；
 *   · 状态文件里的 taskId / roundFiles / done 被"回写旧版本"削掉 —— 整轮产出全丢、
 *     任务永远挂 running（bug 2 / 3）。
 * 修法见 shared/fslock.js（O_EXCL 抢锁 + 原子 rename）。
 * 重构后 hook 退化成纯转发器，ghost 操作全在服务端 hookCommon 完成 ——
 * 本测试用 createHookDispatch 直接调服务端 dispatch 复现并发场景。
 *
 * 跑法：`node server/test/ghostRace.test.js`（零依赖）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ghost-race-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const PROJECT = path.join(TMP, 'project');
for (const d of [HOME, WG, PROJECT]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;

const { createHookDispatch } = require('../src/ingest/hookDispatch');
const { feedFilePath } = require('../src/ingest/subagentFeed');

const FEED = path.join(PROJECT, '.workgremlin', 'subagents.json');
const SESSION = 'sess-race';

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
  projectForReport: () => 'WorkGremlin',
  registerMember: (b) => { calls.push(['registerMember', b]); return b.memberId; },
  setStatus: (b) => { calls.push(['setStatus', b]); return { ok: true }; },
  startTask: (b) => { calls.push(['startTask', b]); return { taskId: 't_gen' }; },
  endTask: (b) => { calls.push(['endTask', b]); return { ok: true }; },
  toolUse: (b) => { calls.push(['toolUse', b]); return { ok: true }; },
  fileTouch: (b) => { calls.push(['fileTouch', b]); return { ok: true }; },
  taskProgress: (b) => { calls.push(['taskProgress', b]); return { ok: true }; },
  heartbeat: (b) => { calls.push(['heartbeat', b]); return { ok: true }; },
  recordMessage: (b) => { calls.push(['recordMessage', b]); return { ok: true }; },
  backfillTaskTokens: (b) => { calls.push(['backfillTaskTokens', b]); return { ok: true }; },
  currentTaskFor: () => null,
};

const d = createHookDispatch();
const ctx = { project: 'WorkGremlin', workspacePath: PROJECT, bus, repo: {} };

async function runHook(eventName, payload = {}) {
  await d.dispatch(
    { hook_event_name: eventName, session_id: SESSION, cwd: PROJECT, client: 'CLI', agent: 'codebuddy', ...payload },
    ctx
  );
}

function readFeed() {
  try {
    return JSON.parse(fs.readFileSync(FEED, 'utf8'));
  } catch {
    return { project: '', agents: [] };
  }
}

function writeFeedRaw(agents) {
  fs.mkdirSync(path.dirname(FEED), { recursive: true });
  fs.writeFileSync(FEED, `${JSON.stringify({ project: 'WorkGremlin', agents }, null, 2)}\n`, 'utf8');
}

/** 本会话的 hook 状态文件路径（文件名里含 session id） */
function stateFileOf(session) {
  const dir = path.join(WG, 'hooks');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const n = names.find((x) => x.includes(session) && x.endsWith('.json'));
  return n ? path.join(dir, n) : null;
}

function stateOf(session) {
  const p = stateFileOf(session);
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 清空状态文件里的召唤台账 + 内存台账 */
function resetLedger() {
  const p = stateFileOf(SESSION);
  if (p) {
    fs.writeFileSync(p, `${JSON.stringify({ ...(stateOf(SESSION) || {}), subagents: [] })}\n`, 'utf8');
  }
  d.sessionSet(SESSION, { subagents: [] });
}

function killHeartbeat() {
  // hook 已退化为转发器，没有独立心跳进程需要杀；dispatch 在本进程内跑，
  // hb.pid 就是本进程的 pid，不能杀。这里只清状态文件里的 hb 字段。
  const p = stateFileOf(SESSION);
  if (!p) return;
  const st = stateOf(SESSION);
  if (st && st.hb) {
    fs.writeFileSync(p, `${JSON.stringify({ ...st, hb: null })}\n`, 'utf8');
  }
}

(async () => {
  console.log('并发 hook：召唤台账不丢 + 幽灵归属扫场');

  // [1] 并发召唤：N 条几乎同时到达，一条都不能丢（旧代码在这里会丢条目）
  const N = 12;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      runHook('PreToolUse', {
        tool_name: 'Agent',
        tool_input: { subagent_type: 'Explore', prompt: `探查第 ${i} 个子任务` },
      })
    )
  );
  const feed = readFeed();
  ok(`并发 ${N} 次召唤全部落盘`, feed.agents.length === N, `实到 ${feed.agents.length}`);
  const ids = feed.agents.map((a) => a.id).filter(Boolean);
  ok('每条召唤的 per-call id 唯一（没被去重吞掉）', ids.length === N && new Set(ids).size === N, `ids=${ids.length} uniq=${new Set(ids).size}`);

  // [2] 状态文件的 subagents 台账同样是"读-改-写"，并发下也不能丢账
  const st = stateOf(SESSION);
  // 台账是多槽有上限的（slice(-8) 后再 push 一条，稳态上限 9）；12 条并发下应正好到上限 ——
  // 少于上限就说明"读-改-写"还在丢账。
  const cap = Math.min(N, 9);
  const ledger = (st && st.subagents) || [];
  ok(`状态文件台账不丢账（记满 ${cap} 条）`, ledger.length === cap, `实到 ${ledger.length}`);

  // [3] 跨会话扫场：ownsEntry 按 client+sessionId 隔离，别会话的同产品幽灵不会被本会话 Stop 扫掉
  //     （那条会话可能还活着，不能误收；只能等 GHOST_TTL_MS 超时兜底）。
  writeFeedRaw([
    { name: 'Explore', state: 'busy', ts: Date.now(), client: 'codebuddy', sessionId: 'other-session', id: 'ghost-legacy', task: '别的会话召唤的幽灵' },
  ]);
  await runHook('Stop');
  ok(
    'Stop 不扫别会话的同产品幽灵（按会话隔离）',
    readFeed().agents.some((a) => a.id === 'ghost-legacy'),
    JSON.stringify(readFeed().agents)
  );
  killHeartbeat();

  // [4] 反例：别的会话 / 别的产品的幽灵必须留着（别把并行会话的幽灵误扫）
  writeFeedRaw([
    { name: 'Explore', state: 'busy', ts: Date.now(), client: 'codebuddy', sessionId: 'other-session', id: 'ghost-other-session', task: '别的会话' },
    { name: 'Explore', state: 'busy', ts: Date.now(), client: 'codex', sessionId: SESSION, id: 'ghost-other-product', task: '别的产品' },
    { name: 'Explore', state: 'busy', ts: Date.now(), client: 'codebuddy', sessionId: SESSION, id: 'ghost-mine', task: '本会话' },
  ]);
  await runHook('Stop');
  const after = readFeed().agents.map((a) => a.id);
  ok('别的会话的幽灵被保住', after.includes('ghost-other-session'), after.join(','));
  ok('别的产品的幽灵被保住', after.includes('ghost-other-product'), after.join(','));
  ok('本会话的幽灵被扫掉', !after.includes('ghost-mine'), after.join(','));
  killHeartbeat();

  // [5] 并发收工（SubagentStop）：挑账 + 销账必须是一次原子操作。
  //     旧代码在这里是"各自读台账 → 各自挑 list[0] → 各自整体写回" —— 三个进程读到同一份
  //     台账、挑中同一只，于是三只幽灵只收掉一只，剩下两只干等 GHOST_TTL_MS。
  writeFeedRaw([]);
  resetLedger(); // 台账里还留着 [1] 那 8 条，不清空的话 finishGhost 会挑到它们（清单已被清空，划不掉）
  await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      runHook('PreToolUse', {
        tool_name: 'Agent',
        tool_input: { subagent_type: 'Explore', prompt: `收工测试 ${i}` },
      })
    )
  );
  ok('[5] 前置：三只幽灵都召唤出来了', readFeed().agents.length === 3, `实到 ${readFeed().agents.length}`);
  await Promise.all(Array.from({ length: 3 }, () => runHook('SubagentStop', {})));
  const retired = readFeed().agents.filter((a) => a.result).length;
  ok('三只全部收工（并发销账没互相覆盖）', retired === 3, `实到 ${retired} 只`);
  const leftover = (stateOf(SESSION) && stateOf(SESSION).subagents) || [];
  ok('台账已清空（三笔销账都落盘了）', leftover.length === 0, `残留 ${leftover.length} 条`);
  killHeartbeat();

  // [6] fslock 原语：并发读-改-写一次都不能丢。
  //     这一条才真正钉住"加锁"那件事 —— [5] 那种端到端竞态靠进程调度，可能碰巧被串成
  //     顺序执行而蒙混过关（实测：把 finishGhost 退回无锁版，[5] 仍然全绿）。
  //     这里是 6 个进程 × 150 次密集读改写同一个文件，无锁必然丢更新。
  const COUNTER = path.join(TMP, 'counter.json');
  const FLOCK = path.resolve(__dirname, '..', '..', 'shared', 'fslock.js');
  fs.writeFileSync(COUNTER, '0\n', 'utf8');
  const WORKERS = 6;
  const PER = 150;
  const childCode = `const { updateJson } = require(${JSON.stringify(FLOCK)});
for (let i = 0; i < ${PER}; i++) {
  updateJson(${JSON.stringify(COUNTER)}, (v) => (Number(v) || 0) + 1, { pretty: false });
}`;
  await Promise.all(
    Array.from({ length: WORKERS }, () =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, ['-e', childCode], { stdio: ['ignore', 'ignore', 'ignore'] });
        c.on('close', () => resolve());
      })
    )
  );
  const total = Number(String(fs.readFileSync(COUNTER, 'utf8')).trim());
  ok(`并发 ${WORKERS * PER} 次读-改-写一次不丢`, total === WORKERS * PER, `实到 ${total}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
