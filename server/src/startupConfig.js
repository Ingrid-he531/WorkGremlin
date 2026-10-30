'use strict';

/**
 * Startup settings (host / port / TLS) for the standalone server.
 *
 * They can live in the same user-editable file as the dispatch policy:
 *
 *   ~/.workgremlin/config.json          (respects WORKGREMLIN_HOME)
 *   {
 *     "server": { "host": "0.0.0.0", "port": 21800, "tls": true },
 *     "dispatch": { "mode": "off" }
 *   }
 *
 * Precedence per field: command line > environment > config.json > default.
 * Unlike `dispatch.mode`, this section is read once at startup, so a change needs a restart.
 * Invalid values are ignored (the server falls back to the next source), never "allow by
 * accident".
 */

const fs = require('node:fs');

const { serverConfigPath } = require('@workgremlin/shared/paths');

const DEFAULT_HOST = '127.0.0.1';

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function validHost(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

/**
 * @param {unknown} value
 * @returns {number|undefined}
 */
function validPort(value) {
  if (typeof value === 'boolean' || value === null || value === undefined) return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(num) && num > 0 && num <= 65535 ? num : undefined;
}

/**
 * @param {unknown} value
 * @returns {boolean|undefined}
 */
function validTls(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'self-signed'].includes(text)) return true;
  if (['0', 'false', 'off', 'no'].includes(text)) return false;
  return undefined;
}

/**
 * Read the `server` section of config.json. Missing / corrupt / wrong-typed values are ignored.
 * @param {string} [file]
 * @returns {{host?: string, port?: number, tls?: boolean}}
 */
function readFileSettings(file = serverConfigPath()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const server = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.server : null;
  if (!server || typeof server !== 'object' || Array.isArray(server)) return {};

  const out = {};
  const host = validHost(server.host);
  if (host) out.host = host;
  const port = validPort(server.port);
  if (port) out.port = port;
  const tls = validTls(server.tls);
  if (tls !== undefined) out.tls = tls;
  return out;
}

/**
 * Resolve the effective startup settings.
 * @param {{args?: Record<string, any>, env?: Record<string, string|undefined>, file?: string}} [opts]
 * @returns {{host: string, port: number|undefined, tls: boolean, file: string}}
 */
function resolveStartupSettings(opts = {}) {
  const args = opts.args || {};
  const env = opts.env || process.env;
  const file = opts.file || serverConfigPath();
  const fromFile = readFileSettings(file);

  const host = validHost(args.host) || validHost(env.WORKGREMLIN_HOST) || fromFile.host || DEFAULT_HOST;
  const port =
    validPort(args.port) || validPort(env.WORKGREMLIN_PORT) || fromFile.port || undefined;
  const cliTls = validTls(args.tls);
  const envTls = validTls(env.WORKGREMLIN_TLS);
  const tls = cliTls !== undefined ? cliTls : envTls !== undefined ? envTls : Boolean(fromFile.tls);

  return { host, port, tls, file };
}

module.exports = {
  DEFAULT_HOST,
  readFileSettings,
  resolveStartupSettings,
  validHost,
  validPort,
  validTls,
};
