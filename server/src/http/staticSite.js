'use strict';

/**
 * Serve the built renderer (renderer/dist) from the server itself, so a machine with nothing but a
 * browser can use WorkGremlin —— no client install, no Electron, no Node.
 *
 * Auth is deliberately not a second scheme:
 *   · `GET /?token=<token>` sets an httpOnly cookie and serves the page directly (a mobile
 *     browser that mishandles 302 + Set-Cookie otherwise appears to reload forever); the inline
 *     boot script removes the token from the address bar with history.replaceState;
 *   · later page loads ride the cookie, and the page receives the token through an injected boot
 *     script (the browser cannot read an httpOnly cookie);
 *   · `/api/*` and `/ws` still authenticate with the same token.
 *
 * Serving the page directly (instead of redirecting) also means a browser that refuses to store the
 * cookie still gets a working first page: the injected boot token is what the renderer uses for
 * HTTP/WS. The cookie only makes a later refresh convenient.
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
  // The second inline script removes `?token=` from the address bar before the app starts; unlike a
  // 302 + Set-Cookie redirect, this also works in mobile browsers that drop the cookie or re-prompt
  // for a self-signed certificate on every navigation.
  const boot =
    `<script>window.__WORKGREMLIN_BOOT__ = { token: ${JSON.stringify(token || '')} };</script>` +
    `<script>try { const u = new URL(location.href); if (u.searchParams.has('token')) {` +
    ` u.searchParams.delete('token'); history.replaceState(null, '', u.pathname + u.search + u.hash); }` +
    ` } catch (e) {}</script>`;
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
        .send('WorkGremlin: token required —— open /?token=<token> (read the token from ~/.workgremlin/server.json)');
    }

    if (!queryToken) return res.type('html').send(index);

    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: Boolean(secure) });
    // Serve the page directly instead of redirecting: a 302 here made some mobile browsers bounce
    // between the token URL and "/" (or re-prompt for the self-signed certificate) and end on a
    // blank page. The inline boot script strips the token from the address bar instead.
    return res.type('html').send(index);
  };
}

module.exports = { createStaticSite, COOKIE };
