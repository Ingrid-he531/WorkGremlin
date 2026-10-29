/**
 * TLS self-check for the standalone server (`--tls` / `--tls-cert` + `--tls-key`).
 *
 * Pinned rules:
 *   · a self-signed pair is generated once into <home>/tls and reused while it is valid + covers
 *     this machine —— regenerating per start would invalidate every browser's "continue" decision;
 *   · a certificate that no longer covers any current name is replaced (the expires-soon case is
 *     the same branch: isUsable says no);
 *   · a supplied pair is validated at startup: an unreadable file or a mismatched key fails here,
 *     not as a handshake error on every request;
 *   · the server really speaks HTTPS: /health works over TLS, plain HTTP on the same port does not,
 *     wss accepts the same token, and the static-page cookie is marked Secure (a Secure cookie sent
 *     over http:// would be dropped silently by the browser);
 *   · server.json carries `protocol: "https"` so clients build https/wss URLs — host+port alone
 *     cannot tell them the scheme.
 *
 * Run: `npm run test:tls`
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-tls-'));

// Everything this test writes must stay in TMP: the real ~/.workgremlin/server.json belongs to a
// running server, and overwriting it would point the office at a dead test process.
process.env.WORKGREMLIN_HOME = path.join(TMP, 'home');
process.env.WORKGREMLIN_NO_AUTO_HOOKS = '1';

const { resolveTls } = require('../src/tls');
const { createServer } = require('../src/index');
const WebSocket = require('ws');

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

/** HTTPS request with the self-signed certificate accepted (that is exactly the browser click-through). */
function request(base, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      new URL(pathname, base),
      { method, headers, rejectUnauthorized: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Plain HTTP against the TLS port: must not be answered. */
function plainRequest(base, pathname) {
  return new Promise((resolve) => {
    // Rewrite the scheme instead of copying it: http.request() refuses an https URL outright,
    // which would "pass" the test without ever touching the socket.
    const req = http.request(new URL(pathname, base.replace(/^https:/, 'http:')), () => resolve('answered'));
    req.on('error', () => resolve('refused'));
    req.end();
  });
}

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { rejectUnauthorized: false });
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

(async () => {
  const names = ['localhost', '127.0.0.1'];

  head('自签证书的生成与复用');
  {
    const dir = path.join(TMP, 'tls');
    const first = await resolveTls({ selfSigned: true, dir, names });
    ok('生成了证书与私钥', Boolean(first && first.cert && first.key));
    ok('指纹是 SHA-256 形式', FINGERPRINT.test(first.fingerprint256), first.fingerprint256);
    ok('私钥权限为 0600', (fs.statSync(first.keyFile).mode & 0o777) === 0o600);
    const x509 = new crypto.X509Certificate(first.cert);
    ok('SAN 覆盖 localhost', Boolean(x509.checkHost('localhost')));
    ok('SAN 覆盖 127.0.0.1', Boolean(x509.checkIP('127.0.0.1')));
    ok('有效期在 30 天以上', new Date(first.validTo).getTime() - Date.now() > 30 * 24 * 3600 * 1000);

    const second = await resolveTls({ selfSigned: true, dir, names });
    ok('有效证书被复用（不重签）', second.reused === true, `reused=${second.reused}`);
    ok('复用后指纹不变', second.fingerprint256 === first.fingerprint256);

    // A name set the stored certificate cannot cover forces a new pair: the "laptop moved to
    // another network / hostname changed" case.
    const third = await resolveTls({ selfSigned: true, dir, names: ['other.invalid'] });
    ok('覆盖不到的名字触发重签', third.reused === false, `reused=${third.reused}`);
    ok('重签后是另一张证书', third.fingerprint256 !== first.fingerprint256);
  }

  head('指定证书文件的校验');
  {
    const a = await resolveTls({ selfSigned: true, dir: path.join(TMP, 'a'), names });
    const b = await resolveTls({ selfSigned: true, dir: path.join(TMP, 'b'), names });

    const fromFile = await resolveTls({ certFile: a.certFile, keyFile: a.keyFile });
    ok('证书文件模式可用', fromFile.source === 'file' && fromFile.fingerprint256 === a.fingerprint256);

    let mismatched = '';
    try {
      await resolveTls({ certFile: a.certFile, keyFile: b.keyFile });
    } catch (err) {
      mismatched = (err && err.message) || String(err);
    }
    ok('证书与私钥不匹配会拒绝启动', /不匹配/.test(mismatched), mismatched);

    let halfPair = '';
    try {
      await resolveTls({ certFile: a.certFile });
    } catch (err) {
      halfPair = (err && err.message) || String(err);
    }
    ok('只给证书不给私钥会报错', /必须同时/.test(halfPair), halfPair);

    let missing = '';
    try {
      await resolveTls({ certFile: path.join(TMP, 'nope.crt'), keyFile: a.keyFile });
    } catch (err) {
      missing = (err && err.message) || String(err);
    }
    ok('证书文件不存在会说明路径', /读不到证书/.test(missing), missing);
  }

  head('HTTPS 服务端');
  {
    const site = path.join(TMP, 'site');
    fs.mkdirSync(site, { recursive: true });
    fs.writeFileSync(
      path.join(site, 'index.html'),
      '<!doctype html><html><head><title>WorkGremlin</title></head><body><div id="app"></div></body></html>'
    );

    const tls = await resolveTls({ selfSigned: true, dir: path.join(TMP, 'tls-server'), names });
    const server = createServer({
      dbPath: path.join(TMP, 'test.db'),
      token: 'tok',
      serveStatic: site,
      tls,
      silent: true,
      log: 'error',
    });
    await server.start(0);
    const base = `https://127.0.0.1:${server.info.port}`;

    ok('info.protocol 是 https', server.info.protocol === 'https', server.info.protocol);
    ok('info 带指纹', server.info.tlsFingerprint === tls.fingerprint256);

    const infoFile = path.join(process.env.WORKGREMLIN_HOME, 'server.json');
    const written = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
    ok('server.json 记录 protocol=https（客户端据此拼 URL）', written.protocol === 'https', written.protocol);

    let res = await request(base, '/api/v1/health');
    ok('HTTPS 上的 /api/v1/health 正常', res.status === 200 && JSON.parse(res.body).ok === true, `status=${res.status}`);

    ok('明文 HTTP 打同一端口不被当成正常响应', (await plainRequest(base, '/api/v1/health')) !== 'answered');

    res = await request(base, '/');
    ok('静态页无 token -> 401', res.status === 401, `status=${res.status}`);

    res = await request(base, '/?token=tok');
    const setCookie = res.headers['set-cookie'] || [];
    ok('带 token -> 302', res.status === 302, `status=${res.status}`);
    ok(
      'cookie 带 Secure（http 下浏览器会丢弃，所以必须跟随协议）',
      setCookie.some((c) => /wg_token=tok/.test(c) && /Secure/i.test(c)),
      setCookie.join(' | ')
    );

    res = await request(base, '/', { headers: { cookie: 'wg_token=tok' } });
    ok('cookie -> 200 且注入 boot token', res.status === 200 && res.body.includes('__WORKGREMLIN_BOOT__'));

    const ws = await wsConnect(`wss://127.0.0.1:${server.info.port}/ws?token=tok`);
    const frame = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws 没有收到首帧')), 5000);
      ws.once('message', (raw) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(String(raw)));
        } catch (err) {
          reject(err);
        }
      });
    });
    ok('wss 用同一个 token 完成握手并推送首帧', Boolean(frame && frame.type), JSON.stringify(frame && frame.type));
    ws.close();

    await server.close();
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n异常终止：', err);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
