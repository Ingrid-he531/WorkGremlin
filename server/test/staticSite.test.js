/**
 * Browser-only mode (`--static`) self-check: the built UI is served by the server, gated by the
 * same token as the API.
 *
 * Pinned rules:
 *   · no token / wrong token → 401, the page is not handed out;
 *   · `?token=<token>` → 302 to `/` + httpOnly cookie, so the token leaves the address bar;
 *   · a valid cookie → index.html with the boot token injected (the page cannot read the cookie);
 *   · static assets are served normally;
 *   · `--no-token` keeps the old "no gate" behavior instead of inventing a second auth scheme.
 *
 * Run: `npm run test:static-site`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const express = require('express');
const { createStaticSite } = require('../src/http/staticSite');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-static-site-'));
fs.mkdirSync(path.join(TMP, 'assets'));
fs.writeFileSync(
  path.join(TMP, 'index.html'),
  '<!doctype html><html><head><title>WorkGremlin</title></head><body><div id="app"></div></body></html>'
);
fs.writeFileSync(path.join(TMP, 'assets', 'app.js'), 'console.log("bundle");');

/** @param {import('express').Express} app */
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function buildApp(token) {
  const app = express();
  app.use(createStaticSite({ dir: TMP, token }));
  return app;
}

(async () => {
  head('token enabled');
  {
    const server = await listen(buildApp('tok'));
    const base = `http://127.0.0.1:${server.address().port}`;

    let res = await fetch(`${base}/`);
    ok('no token -> 401', res.status === 401, `status=${res.status}`);
    ok('the page is not served', !(await res.text()).includes('<div id="app">'));

    res = await fetch(`${base}/?token=nope`);
    ok('wrong token -> 401', res.status === 401, `status=${res.status}`);

    res = await fetch(`${base}/?token=tok`, { redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie') || '';
    ok('right token -> 302', res.status === 302, `status=${res.status}`);
    ok('redirect removes the token from the URL', res.headers.get('location') === '/');
    ok('sets an httpOnly cookie', /wg_token=tok/.test(setCookie) && /HttpOnly/i.test(setCookie), setCookie);

    res = await fetch(`${base}/`, { headers: { cookie: 'wg_token=tok' } });
    const html = await res.text();
    ok('cookie -> 200', res.status === 200, `status=${res.status}`);
    ok('boot token is injected', html.includes('__WORKGREMLIN_BOOT__') && html.includes('"tok"'));
    ok('injection keeps the document intact', html.includes('</head>') && html.includes('<div id="app">'));

    res = await fetch(`${base}/assets/app.js`);
    ok(
      'static assets are served',
      res.status === 200 && (await res.text()).includes('console.log')
    );

    server.close();
  }

  head('--no-token');
  {
    const server = await listen(buildApp(''));
    const base = `http://127.0.0.1:${server.address().port}`;

    const res = await fetch(`${base}/`);
    const html = await res.text();
    ok('page served without a token', res.status === 200, `status=${res.status}`);
    ok('boot token stays empty', html.includes('__WORKGREMLIN_BOOT__') && html.includes('""'));

    server.close();
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
