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
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { resolveTls } = require('../src/tls');

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
  let hookAttempts = 0;
  let failNextLifecycle = false;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/hook') {
      hookAttempts += 1;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = body; }
        if (failNextLifecycle && parsed && parsed.hook_event_name === 'SessionStart') {
          failNextLifecycle = false;
          res.writeHead(503);
          res.end();
          return;
        }
        received = parsed;
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
      env: {
        ...process.env,
        WORKGREMLIN_HOME: TMP,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_vscode',
        UNLISTED_TEST_SECRET: 'do-not-forward',
      },
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
  ok(
    '白名单内的 Codex host 环境变量被转发',
    received && received.hookEnv && received.hookEnv.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === 'codex_vscode',
    received && JSON.stringify(received.hookEnv)
  );
  ok(
    '白名单外的环境变量不被转发',
    received && received.hookEnv && !Object.prototype.hasOwnProperty.call(received.hookEnv, 'UNLISTED_TEST_SECRET'),
    received && JSON.stringify(received.hookEnv)
  );
  ok('hook 不替楼层解释 form', received && received.form === undefined, received && received.form);
  ok('转发 body 带 workspacePath(=cwd)', received && received.workspacePath === '/home/u/proj');
  ok('转发 body 透传 transcript_path', received && received.transcript_path === '/tmp/rollout.jsonl');
  ok('hook 进程退出码为 0', exitCode === 0, `exitCode=${exitCode}`);

  received = null;
  exitCode = null;
  hookAttempts = 0;
  failNextLifecycle = true;
  const lifecycleEvent = {
    hook_event_name: 'SessionStart',
    session_id: '12345678-1234-4234-8234-123456789abc',
    cwd: '/home/u/proj',
    agent: 'codebuddy',
    client: 'CLI',
  };
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, '--agent', 'codebuddy'], {
      env: { ...process.env, WORKGREMLIN_HOME: TMP },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(JSON.stringify(lifecycleEvent));
    child.stdin.end();
    child.on('close', (code) => { exitCode = code; resolve(); });
  });
  ok('SessionStart 遇到 503 只尝试一次（不重试）', hookAttempts === 1, `attempts=${hookAttempts}`);
  ok('503 下事件未送达', !received, JSON.stringify(received));
  ok('503 下 hook 仍以 0 退出（绝不阻塞 agent）', exitCode === 0, `exitCode=${exitCode}`);

  server.close();

  // --- TLS: server.json says protocol https, so the forwarder must not keep knocking on http ------
  // Regression: an http:// request to a TLS port gets an empty reply, and the hook swallows the
  // failure by design — every hook-based floor (4F Claude Code first among them) silently stopped
  // writing task records the moment TLS was enabled, while polling floors kept working.
  const tls = await resolveTls({ selfSigned: true, dir: path.join(TMP, 'tls'), names: ['localhost', '127.0.0.1'] });
  received = null;
  exitCode = null;
  const tlsServer = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { received = JSON.parse(body); } catch { received = body; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(
    path.join(TMP, 'server.json'),
    JSON.stringify({ port: tlsServer.address().port, token: 'test-token', protocol: 'https' }),
    'utf8'
  );
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, '--agent', 'claude'], {
      env: { ...process.env, WORKGREMLIN_HOME: TMP },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(JSON.stringify({ ...ev, agent: 'claude', client: 'claude' }));
    child.stdin.end();
    child.on('close', (code) => { exitCode = code; resolve(); });
  });
  ok('TLS 服务端收到 /api/v1/hook 的 POST', !!received, 'received=null');
  ok('TLS 下转发 body 带 hook_event_name', received && received.hook_event_name === 'UserPromptSubmit');
  ok('TLS 下转发 body 带 agent', received && received.agent === 'claude');
  ok('TLS 下 hook 进程退出码为 0', exitCode === 0, `exitCode=${exitCode}`);
  tlsServer.close();

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
