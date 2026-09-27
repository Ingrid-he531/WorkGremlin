'use strict';
/**
 * 回归测试：并发 hook 的"丢失更新"与"幽灵收不掉"（2026-09-27 的 bug 1 / 2 / 3）。
 *
 * 背景（实测）：CodeBuddy CLI 会在**同一毫秒**并行触发多个 hook 进程 ——
 * ~/.workgremlin/hooks/events.log 里 05:29:45.178 / .184 / .189 三条 PreToolUse(Agent)。
 * 每个 hook 都是独立进程，各自 readFile → 改内存 → writeFileSync，于是互相覆盖：
 *   · 三条 ghost+ 只落两条 —— 召唤台账丢了，幽灵收不掉（bug 1）；
 *   · 状态文件里的 taskId / roundFiles / done 被"回写旧版本"削掉 —— 整轮产出全丢、
 *     任务永远挂 running（bug 2 / 3）。
 * 修法见 shared/fslock.js（O_EXCL 抢锁 + 原子 rename）。本测试直接拉 hook.js 子进程复现。
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
// 假的 server.json：越过"WorkGremlin 没在跑就跳过"的闸门；端口 9 连不通 → 上报静默失败（纪律 #1）
fs.writeFileSync(path.join(WG, 'server.json'), JSON.stringify({ port: 9, token: 'x' }));
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;

const HOOK = path.resolve(__dirname, '..', '..', 'packages', 'reporter', 'src', 'hook.js');
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

function runHook(eventName, payload = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, '--agent', 'codebuddy'], {
      cwd: PROJECT,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.write(
      JSON.stringify({ hook_event_name: eventName, session_id: SESSION, cwd: PROJECT, client: 'CLI', ...payload })
    );
    child.stdin.end();
    child.on('close', () => resolve());
  });
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

/** 清空状态文件里的召唤台账（保留 hb —— 里面记着心跳守护的 pid） */
function resetLedger() {
  const p = stateFileOf(SESSION);
  if (!p) return;
  fs.writeFileSync(p, `${JSON.stringify({ ...(stateOf(SESSION) || {}), subagents: [] })}\n`, 'utf8');
}

function killHeartbeat() {
  const st = stateOf(SESSION);
  const pid = st && st.hb && st.hb.pid;
  if (pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经退了 */
    }
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
  // 台账是多槽有上限的（最多留最近 8 条，见 rememberSubagent）；12 条并发下应正好记满 8 ——
  // 少于 8 就说明"读-改-写"还在丢账。
  const cap = Math.min(N, 8);
  const ledger = (st && st.subagents) || [];
  ok(`状态文件台账不丢账（记满 ${cap} 条）`, ledger.length === cap, `实到 ${ledger.length}`);

  // [3] 跨身份扫场：条目 client 是 codebuddy-plugin，而 CLI 上报的身份是 codebuddy ——
  //     同一个产品（1F 已合并单层）必须能收掉，否则只能干等 GHOST_TTL_MS。
  writeFeedRaw([
    { name: 'Explore', state: 'busy', ts: Date.now(), client: 'codebuddy-plugin', sessionId: SESSION, id: 'ghost-legacy', task: '旧身份召唤的幽灵' },
  ]);
  await runHook('Stop');
  ok(
    'Stop 能扫掉 client=codebuddy-plugin 的幽灵（按产品家族归属）',
    !readFeed().agents.some((a) => a.id === 'ghost-legacy'),
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
