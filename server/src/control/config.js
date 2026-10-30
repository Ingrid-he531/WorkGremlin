'use strict';

/**
 * Server-side policy for remote dispatch, read from **a configuration file**, not from the client UI.
 *
 * Client settings live in the renderer (language, etc.); this switch decides what the server allows
 * any client to do, so it must be owned by the machine that runs the agents:
 *
 *   ~/.workgremlin/config.json          (respects WORKGREMLIN_HOME)
 *   {
 *     "dispatch": { "mode": "off" }     // off | auto | confirm
 *   }
 *
 * The same file also has a `server` section (host / port / TLS), read once by startupConfig.js;
 * this module only parses the dispatch policy.
 *
 * The file is read on demand (every policy check), so edits take effect without restarting the
 * server. `WORKGREMLIN_DISPATCH_MODE` overrides the file for containers / tests; an invalid value in
 * either place falls back to `off` (never "allow by accident").
 *
 * This module only parses/validates. It does not create the file: an absent file means `off`.
 */

const fs = require('node:fs');

const { DEFAULTS } = require('@workgremlin/shared');
const { serverConfigPath } = require('@workgremlin/shared/paths');

const DEFAULT_MODE = 'off';

/** @param {unknown} value */
function validMode(value) {
  const text = String(value == null ? '' : value).trim();
  return DEFAULTS.DISPATCH_MODES.includes(text) ? text : null;
}

/**
 * @param {{file?: string, env?: Record<string, string|undefined>}} [opts]
 * @returns {{mode: 'off'|'auto'|'confirm', file: string}}
 */
function readDispatchConfig(opts = {}) {
  const file = opts.file || serverConfigPath();
  const env = opts.env || process.env;

  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null;
  }

  const dispatch = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.dispatch : null;
  const fromFile = dispatch && typeof dispatch === 'object' ? validMode(dispatch.mode) : null;

  return {
    // Environment wins, then the file, then the safe default.
    mode: validMode(env.WORKGREMLIN_DISPATCH_MODE) || fromFile || DEFAULT_MODE,
    file,
  };
}

module.exports = { readDispatchConfig, validMode, DEFAULT_MODE };
