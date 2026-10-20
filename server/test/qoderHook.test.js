'use strict';
/**
 * Qoder 的 hook 口径：**细粒度产品**（有 UserPromptSubmit / PreToolUse / PostToolUse / Stop），
 * 不补会话级的粗粒度任务与相位。见 packages/reporter/src/hook.js 的 COARSE_AGENTS。
 *
 * 为什么要有这个自检：Qoder 曾经被当成"只发 SessionStart / SessionEnd"的粗粒度产品
 * （7dec250 引入 `AGENT === 'qoder'` 的会话级补笔），于是每次开一个会话都凭空多一条
 * 标题为 `Qoder Session` 的会话级任务；而 agent_status 一行一成员只有一个 task_id 槽位，
 * 它永远抢不过真实的那一轮 → 在任务记录里一直显示「已取消」，会话其实好好开着。
 * 2026-09-30 实测 Qoder CLI 1.1.64 的事件流（~/.workgremlin/hooks/events.log）：
 *   SessionStart → Notification(auth_success) → UserPromptSubmit → PreToolUse(Bash) →
 *   PostToolUse → Stop → Notification(idle_prompt)
 * 细粒度一应俱全，所以按细粒度走（与 4F Claude 同口径）——**这就是本文件的断言**。
 *
 * 关键手法：沙箱里起一个**真的 HTTP 服务**当服务端，把 hook 发出去的每一条上报记下来。
 * 只看状态文件是不够的 —— "有没有多出一条会话级任务"只有看它到底 POST 了什么才知道。
 *
 * 跑法：`npm run test:qoder`（零依赖，直接跑 hook.js 子进程）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-qoder-hook-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const BIN = path.join(TMP, 'bin');
for (const d of [HOME, WG, BIN]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
process.env.PATH = BIN;
const CWD = TMP;
process.chdir(CWD);

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

/** 收到的每一条上报：{ path, body } */
let seen = [];
/** 下一步之后收到的上报从这里切（每段只看这一段里发了什么） */
function since(mark) {
  return seen.slice(mark);
}
const pathsOf = (list) => list.map((r) => r.path);
const startOf = (list) => list.filter((r) => r.path === '/api/v1/task/start');

const { dispatch } = createHookDispatch();
const bus = {
  startTask: async (args) => { seen.push({ path: '/api/v1/task/start', body: args }); return { ok: true, taskId: 't-fake-1' }; },
  endTask: async (args) => { seen.push({ path: '/api/v1/task/end', body: args }); },
  toolUse: async (args) => { seen.push({ path: '/api/v1/tool/use', body: args }); },
  registerMember: async (args) => { seen.push({ path: '/api/v1/register', body: args }); },
  setBlocked: async (args) => { seen.push({ path: '/api/v1/blocked', body: args }); },
  clearBlocked: async () => ({ ok: true }),
  projectForReport: () => '',
  backfillTaskTokens: async () => {},
  currentTaskFor: () => null,
  recordMessage: async () => {},
  fileTouch: async () => {},
  taskProgress: async () => {},
};
const ctx = { project: 'WorkGremlin', workspacePath: CWD, bus };

async function runHook(agent, eventName, sessionId, extra = {}) {
  await dispatch({ hook_event_name: eventName, session_id: sessionId, cwd: CWD, ...extra, agent, workspacePath: CWD }, ctx);
}

function stateFile(sessionId) {
  const dir = path.join(WG, 'hooks');
  let ents = [];
  try {
    ents = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const name = ents.find((n) => n.includes(sessionId) && n.endsWith('.json'));
  if (!name) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch {
    return null;
  }
}

// 直接调用 dispatch 不经子进程，无需 kill 心跳
function killHeartbeat() {}

(async () => {
  console.log('Qoder：细粒度产品 —— 会话边界不补任务、不补相位，相位交给 UserPromptSubmit / Stop');

  /* [1] SessionStart：只注册，**不许**发 /task/start */
  let mark = seen.length;
  await runHook('qoder', 'SessionStart', 'qtest-qoder-1');
  let got = since(mark);
  let st = stateFile('qtest-qoder-1');
  ok('SessionStart 照常注册（发了 /register）', pathsOf(got).includes('/api/v1/register'), pathsOf(got).join(' '));
  ok('SessionStart **没有**发会话级任务（/task/start 一条都没有）', startOf(got).length === 0, JSON.stringify(startOf(got)));
  ok('SessionStart 不编造任务相位（只落 idle，留给 UserPromptSubmit 推进）', Boolean(st && st.sessionPhase && st.sessionPhase.phase === 'idle'), st && JSON.stringify(st.sessionPhase));
  ok('状态文件里没有会话级 taskId', Boolean(st && !st.taskId), st && JSON.stringify(st.taskId));
  killHeartbeat('qtest-qoder-1');

  /* [2] UserPromptSubmit：这一刀才是 Qoder 的任务与相位来源 */
  mark = seen.length;
  await runHook('qoder', 'UserPromptSubmit', 'qtest-qoder-1', { prompt: '测试一条 plugin 任务。不同回复' });
  got = since(mark);
  st = stateFile('qtest-qoder-1');
  const starts = startOf(got);
  ok('UserPromptSubmit 发了 /task/start（Qoder 有细粒度事件）', starts.length === 1, JSON.stringify(pathsOf(got)));
  ok('任务标题就是用户原话', Boolean(starts[0] && starts[0].body && starts[0].body.title === '测试一条 plugin 任务。不同回复'), starts[0] && JSON.stringify(starts[0].body && starts[0].body.title));
  ok('相位推进到 thinking', Boolean(st && st.sessionPhase && st.sessionPhase.phase === 'thinking'), st && JSON.stringify(st.sessionPhase));
  killHeartbeat('qtest-qoder-1');

  /* [3] SessionEnd：清尾可以，但**不许**再补一条会话级任务或 done 相位 */
  mark = seen.length;
  await runHook('qoder', 'SessionEnd', 'qtest-qoder-1');
  got = since(mark);
  st = stateFile('qtest-qoder-1');
  ok('SessionEnd 没有补会话级任务（/task/start 一条都没有）', startOf(got).length === 0, JSON.stringify(startOf(got)));
  ok('SessionEnd 没有编造 done 相位（那是 Stop 那一刀的事）', Boolean(st && !st.sessionPhase), st && JSON.stringify(st.sessionPhase));
  killHeartbeat('qtest-qoder-1');

  /* [4] 回归：claude 也不补（两家同口径） */
  mark = seen.length;
  await runHook('claude', 'SessionStart', 'qtest-claude-1');
  got = since(mark);
  st = stateFile('qtest-claude-1');
  ok('claude SessionStart 只落 idle 相位、不发 /task/start', Boolean(st && st.sessionPhase && st.sessionPhase.phase === 'idle') && startOf(got).length === 0, st && JSON.stringify(st.sessionPhase));
  killHeartbeat('qtest-claude-1');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
