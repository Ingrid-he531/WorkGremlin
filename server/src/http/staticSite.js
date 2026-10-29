'use strict';

/**
 * Serve the built renderer (renderer/dist) from the server itself, so a machine with nothing but a
 * browser can use WorkGremlin —— no client install, no Electron, no Node.
 *
 * Auth is deliberately not a second scheme:
 *   · `GET /?token=<token>` sets an httpOnly cookie and redirects to `/` (the token leaves the
 *     address bar immediately);
 *   · later page loads ride the cookie, and the page receives the token through an injected boot
 *     script (the browser cannot read an httpOnly cookie);
 *   · `/api/*` and `/ws` still authenticate with the same token.
 *
 * Transport: the server can terminate TLS itself (`--tls`, see server/src/tls.js) or sit behind a
 * reverse proxy / SSH tunnel. Without one of those the page and all data travel in clear text on
 * the LAN, and the token is only as private as the network.
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const COOKIE = 'wg_token';

/**
 * @param {string} header raw Cookie header
 * @param {string} name
 * @returns {string}
 */
function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return part.slice(idx + 1).trim();
    }
  }
  return '';
}

/**
 * @param {{dir: string, token: string, secure?: boolean}} opts
 *   `secure` marks the cookie Secure when the page is served over HTTPS. It has to follow the
 *   actual protocol instead of being hard-coded: a Secure cookie set by an http:// server is
 *   silently dropped by the browser, which looks exactly like "the token keeps getting rejected".
 * @returns {import('express').RequestHandler}
 */
function createStaticSite({ dir, token, secure = false }) {
  const root = path.resolve(dir);
  const indexFile = path.join(root, 'index.html');
  const html = fs.readFileSync(indexFile, 'utf8');

  // The token is handed to the page exactly when the page itself is served (cookie checked first).
  const boot = `<script>window.__WORKGREMLIN_BOOT__ = { token: ${JSON.stringify(token || '')} };</script>`;
  const index = html.includes('</head>') ? html.replace('</head>', `${boot}</head>`) : `${html}${boot}`;

  const staticFiles = express.static(root, { index: false });

  return function staticSite(req, res, next) {
    const isIndex = req.path === '/' || req.path === '/index.html';
    if (!isIndex) return staticFiles(req, res, next);

    // --no-token: nothing to gate, hand out the page as-is (same as API behavior).
    if (!token) return res.type('html').send(index);

    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    const cookieToken = readCookie(req.headers.cookie, COOKIE);
    if ((queryToken || cookieToken) !== token) {
      return res
        .status(401)
        .type('text')
        .send('WorkGremlin: token required —— open /?token=<token> (the token is printed by the server)');
    }

    if (!queryToken) return res.type('html').send(index);

    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: Boolean(secure) });
    // Drop the token from the address bar right away; the cookie carries it from now on.
    const url = new URL(req.originalUrl, 'http://localhost');
    url.searchParams.delete('token');
    const target = `${url.pathname}${url.search}`;
    return res.redirect(302, target || '/');
  };
}

module.exports = { createStaticSite, COOKIE };
