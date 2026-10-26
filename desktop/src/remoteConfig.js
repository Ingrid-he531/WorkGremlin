'use strict';

/**
 * Optional remote target for the desktop client.
 *
 * By default the window connects to a server on this machine, discovered through
 * ~/.workgremlin/server.json. When a remote target is configured, the window connects to a
 * server running elsewhere and never starts or reads a local one: the renderer only needs an
 * HTTP base and a WebSocket URL, so the rest of the UI is unchanged.
 *
 * Configuration (environment wins over the files):
 *
 *   WORKGREMLIN_REMOTE=host:port          WORKGREMLIN_REMOTE_TOKEN=<token>
 *   <next to the executable>/client.json  { "host": "...", "port": 21800, "token": "..." }
 *   ~/.workgremlin/client.json            same shape
 *
 * The executable-adjacent file is what a portable client package uses: unzip, drop client.json
 * beside the binary, run. (For an AppImage the file goes next to the .AppImage itself.)
 *
 * The token must be a fixed one passed to the remote server with `--token`: the default token
 * is regenerated on every server start and is only readable from the server machine.
 */

const fs = require('node:fs');
const path = require('node:path');
const { home } = require('@workgremlin/shared');

const DEFAULT_PORT = 21800;

/**
 * @param {string} host
 * @param {number} [port]
 * @returns {{host: string, port: number}|null}
 */
function targetOf(host, port) {
  const text = String(host || '').trim();
  const num = port === undefined || port === null ? DEFAULT_PORT : Number(port);
  if (!text || !Number.isInteger(num) || num <= 0 || num > 65535) return null;
  return { host: text, port: num };
}

/**
 * Parse "host", "host:port" or "scheme://host:port".
 * @param {string} raw
 * @returns {{host: string, port: number}|null}
 */
function parseHostPort(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) return null;
    return targetOf(url.hostname, url.port ? Number(url.port) : DEFAULT_PORT);
  } catch {
    return null;
  }
}

/** @returns {{host: string, port: number, token: string}|null} */
function fromEnv() {
  const target = parseHostPort(process.env.WORKGREMLIN_REMOTE);
  if (!target) return null;
  return { ...target, token: process.env.WORKGREMLIN_REMOTE_TOKEN || '' };
}

/**
 * `client.json` locations, most specific first:
 *   · next to a portable Windows exe (`PORTABLE_EXECUTABLE_DIR`, set by electron-builder's
 *     portable target — inside a portable run, process.execPath points at the temp extraction dir)
 *   · next to the AppImage itself / next to the installed executable
 *   · ~/.workgremlin/client.json (same home as the server's server.json)
 * @returns {string[]}
 */
function clientFiles() {
  const dirs = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) dirs.push(process.env.PORTABLE_EXECUTABLE_DIR);
  if (process.env.APPIMAGE) dirs.push(path.dirname(process.env.APPIMAGE));
  else if (process.execPath) dirs.push(path.dirname(process.execPath));
  dirs.push(home());
  return dirs.map((dir) => path.join(dir, 'client.json'));
}

/** @returns {{host: string, port: number, token: string}|null} */
function fromFile() {
  for (const file of clientFiles()) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const target = raw && raw.url ? parseHostPort(raw.url) : targetOf(raw && raw.host, raw && raw.port);
      if (!target) continue;
      return { ...target, token: typeof raw.token === 'string' ? raw.token : '' };
    } catch {
      /* missing / invalid file: try the next location */
    }
  }
  return null;
}

/**
 * Current remote target, or null when the client should use the local server.
 * @returns {{host: string, port: number, token: string}|null}
 */
function remoteConfig() {
  return fromEnv() || fromFile();
}

/**
 * Whether this is the client-only package (see electron-builder.client.yml): it ships no server,
 * so it must have a remote target instead of falling back to a local one.
 * @param {string} appPath
 * @returns {boolean}
 */
function isClientBuild(appPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf8'));
    return pkg.workgremlinClient === true;
  } catch {
    return false;
  }
}

module.exports = { remoteConfig, isClientBuild, clientFiles, parseHostPort, targetOf };

