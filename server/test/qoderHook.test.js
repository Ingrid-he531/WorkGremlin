'use strict';
/**
 * 回归测试：Qoder 只发 SessionStart / SessionEnd，没有 UserPromptSubmit / PreToolUse / PostToolUse
 * 这类细粒度事件（见 scripts/install-hooks.js 的 QODER_EVENTS 注释与 ~/.workgremlin/hooks/events.log 实测）。
 * 因此 hook.js 必须在这两个事件上补"思考中 / 已完成"的粗粒度相位 —— 否则主控制台一直显示「未上报」。
 *
 * 跑法：`node server/test/qoderHook.test.js`（零依赖，直接跑 hook.js 子进程）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-qoder-hook-'));
const HOME = path.join(TMP, 'home');
const WG = path.join(TMP, 'wg');
const BIN = path.join(TMP, 'bin');
for (const d of [HOME, WG, BIN]) fs.mkdirSync(d, { recursive: true });
// 假的 server.json：让 hook.js 越过"没在跑就跳过"的闸门；端口 9 连不通，
// 上报请求会静默失败（纪律 #1），但不影响本地 sessionPhase 的写入。
fs.writeFileSync(path.join(WG, 'server.json'), JSON.stringify({ port: 9, token: 'x' }));
process.env.HOME = HOME;
process.env.WORKGREMLIN_HOME = WG;
process.env.PATH = BIN;

const HOOK = path.resolve(__dirname, '..', 'packages', 'reporter', 'src', 'hook.js');
const CWD = TMP;

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

function runHook(agent, eventName, sessionId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, '--agent', agent], { cwd: CWD, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.write(JSON.stringify({ hook_event_name: eventName, session_id: sessionId, cwd: CWD }));
    child.stdin.end();
    child.on('close', () => resolve());
  });
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

function killHeartbeat(sessionId) {
  const st = stateFile(sessionId);
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
  console.log('Qoder 粗粒度相位（只有 SessionStart / SessionEnd）');

  // Qoder：SessionStart 应补 thinking
  await runHook('qoder', 'SessionStart', 'qtest-qoder-1');
  let st = stateFile('qtest-qoder-1');
  ok('qoder SessionStart → sessionPhase.phase = thinking', Boolean(st && st.sessionPhase && st.sessionPhase.phase === 'thinking'), st && JSON.stringify(st.sessionPhase));
  killHeartbeat('qtest-qoder-1');

  // Qoder：SessionEnd 应补 done（而不是回落 null → 未上报）
  await runHook('qoder', 'SessionEnd', 'qtest-qoder-1');
  st = stateFile('qtest-qoder-1');
  ok('qoder SessionEnd → sessionPhase.phase = done', Boolean(st && st.sessionPhase && st.sessionPhase.phase === 'done'), st && JSON.stringify(st.sessionPhase));
  killHeartbeat('qtest-qoder-1');

  // 回归：非 qoder（claude）SessionStart 不补粗粒度相位（仍 null，等后续细粒度事件覆盖）
  await runHook('claude', 'SessionStart', 'qtest-claude-1');
  st = stateFile('qtest-claude-1');
  ok('claude SessionStart 不补粗粒度相位（sessionPhase 仍为 null，留给 UserPromptSubmit）', Boolean(st && st.sessionPhase === null), st && JSON.stringify(st.sessionPhase));
  killHeartbeat('qtest-claude-1');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
