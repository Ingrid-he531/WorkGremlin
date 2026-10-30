/**
 * Token persistence: a restart must not invalidate every remote client.
 *
 * Pinned rules:
 *   · the first start generates a token and writes it to ~/.workgremlin/server.json (0600);
 *   · later starts reuse that token, so a client configured once keeps working;
 *   · an explicit token (--token) wins and is then reused by later starts;
 *   · --no-token writes an empty token, which is not reused (a later normal start generates one);
 *   · a normal shutdown keeps only { token }, so readers that need a live server see no connection.
 *
 * Run: `npm run test:token-persistence`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-token-'));
process.env.WORKGREMLIN_HOME = TMP;
process.env.WORKGREMLIN_NO_AUTO_HOOKS = '1';

const config = require('../src/config');
const { createServer } = require('../src/index');

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
const head = (t) => console.log(`\n${t}`);

function infoFile() {
  return path.join(TMP, 'server.json');
}

function readInfo() {
  return JSON.parse(fs.readFileSync(infoFile(), 'utf8'));
}

/** Start a server on a random free port, run `fn`, then close it. */
async function withServer(opts, fn) {
  const server = createServer({
    dbPath: path.join(TMP, 'test.db'),
    silent: true,
    log: 'error',
    ...opts,
  });
  await server.start(0);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

(async () => {
  head('首次启动：生成并落盘');
  let firstToken = null;
  await withServer({}, async (server) => {
    firstToken = server.info.token;
    const info = readInfo();
    ok('生成了非空 token', /^[0-9a-f]{48}$/.test(firstToken), firstToken);
    ok('server.json 里是同一个 token', info.token === firstToken);
    if (process.platform !== 'win32') {
      ok('server.json 权限是 0600', (fs.statSync(infoFile()).mode & 0o777) === 0o600);
    }
  });

  head('正常关闭：只保留 token，不再像活着的服务');
  {
    const stopped = readInfo();
    ok('关闭后 server.json 仍有 token', stopped.token === firstToken);
    ok('关闭后没有 port', stopped.port === undefined, JSON.stringify(stopped));
    ok('persistedToken 仍能读到它', config.persistedToken() === firstToken);
    ok('readServerInfo 不再把它当成连接信息', config.readServerInfo() === null);
  }

  head('再次启动：复用同一个 token');
  await withServer({}, async (server) => {
    ok('重启后 token 不变', server.info.token === firstToken, server.info.token);
  });

  head('显式 token 优先，并继续持久化');
  await withServer({ token: 'explicit-token' }, async (server) => {
    ok('显式 token 生效', server.info.token === 'explicit-token');
  });
  await withServer({}, async (server) => {
    ok('下一次启动复用显式 token', server.info.token === 'explicit-token');
  });

  head('--no-token：空 token 不被复用');
  await withServer({ token: '' }, async (server) => {
    ok('本次启动没有 token', server.info.token === '');
    ok('空 token 不会被当成可复用 token', config.persistedToken() === null);
  });
  let afterNoToken = null;
  await withServer({}, async (server) => {
    afterNoToken = server.info.token;
    ok('之后的正常启动重新生成 token', Boolean(afterNoToken) && afterNoToken !== '');
  });
  ok('重新生成的 token 与首次不同', afterNoToken !== firstToken, afterNoToken);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n异常终止：', err);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
