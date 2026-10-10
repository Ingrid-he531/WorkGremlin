'use strict';
/**
 * hook.js 转发器端到端测试：起一个本地假 server 收 /api/v1/hook，跑真实的
 * packages/reporter/src/hook.js 转发一个事件，验证它把事件 POST 出去且退出 0。
 *
 * 这证明"hook 退化成纯事件转发器"这条链路真的通（hook 侧读 stdin → fetch POST）。
 * 服务端对 /hook 的解析已在 hookDispatch / hookRuntime / hookProducts 覆盖，本测试只验证转发器本身。
 *
 * 跑法：`npm run test:hook-forward`
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'packages', 'reporter', 'src', 'hook.js');

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? `  — ${extra}` : ''}`); }
};

async function run() {
  console.log('hook.js 转发器端到端（读 stdin → POST /api/v1/hook → 退出）');

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-hookfwd-'));
  let received = null;
  let exitCode = null;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/hook') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { received = JSON.parse(body); } catch { received = body; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // 伪造 server.json（readServerInfo 读 ~/<home>/server.json）
  fs.writeFileSync(path.join(TMP, 'server.json'), JSON.stringify({ port, token: 'test-token' }), 'utf8');

  const ev = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess_abc',
    cwd: '/home/u/proj',
    agent: 'codex',
    client: 'codex',
    prompt: '写个函数',
    transcript_path: '/tmp/rollout.jsonl',
  };

  await new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, '--agent', 'codex'], {
      env: { ...process.env, WORKGREMLIN_HOME: TMP },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(JSON.stringify(ev));
    child.stdin.end();
    const errOut = [];
    child.stderr.on('data', (d) => errOut.push(d.toString()));
    child.on('close', (code) => { exitCode = code; resolve(); });
  });

  ok('假 server 收到了 /api/v1/hook 的 POST', !!received, 'received=null');
  ok('转发 body 带 hook_event_name', received && received.hook_event_name === 'UserPromptSubmit');
  ok('转发 body 带 agent', received && received.agent === 'codex');
  ok('转发 body 带 client', received && received.client === 'codex');
  ok('转发 body 带 workspacePath(=cwd)', received && received.workspacePath === '/home/u/proj');
  ok('转发 body 透传 transcript_path', received && received.transcript_path === '/tmp/rollout.jsonl');
  ok('hook 进程退出码为 0', exitCode === 0, `exitCode=${exitCode}`);

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
