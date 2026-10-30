'use strict';

/**
 * Locations for WorkGremlin's **own** storage + logic-free file operations.
 * Node-only; do NOT bundle it into the browser (import it explicitly via
 * `require('@workgremlin/shared/paths')`, same pattern as fslock.js).
 *
 * ## Why this module exists
 *
 * The paths under `~/.workgremlin` used to be assembled independently in server /
 * reporter / desktop / renderer:
 *   - home dir: two implementations, `shared.home()` and `server/src/roots.js` `workgremlinHome()`;
 *   - `hooks/` state-file dir: written separately in plugin, hookCommon, sessions.js (x8)
 *     and floorTrae.js (x3, hardcoded);
 *   - `server.json`: written by config.js, read by reporter/index.js, read again by the plugin,
 *     assembled by desktop/vite;
 *   - state file `<client>@<workspace>@<session>.json`: two identically-named implementations
 *     (plugin and hookCommon);
 *   - state-file I/O: the plugin used raw fs (**non-atomic**), the hook side went through fslock
 *     (locked + atomic) — the same file written two different ways.
 *
 * A real incident already happened: floorTrae.js hardcoded `os.homedir()/.workgremlin/hooks`
 * in three places, so as soon as a user set `WORKGREMLIN_HOME`, Trae's done/ghost/token sync
 * all pointed at the wrong directory — exactly the "server and client read from different dirs"
 * class of bug. A location must have **one** definition, and this is it.
 *
 * ## Scope
 *
 * Only **locations** and **logic-free file operations** live here:
 *   - locations: the file/dir paths under home;
 *   - operations: merge-style read-modify-write of state files (readState / writeState /
 *     updateState), reading server.json, and process-liveness checks.
 * **Not** here: business fields (client / form / hb / sessionPhase normalization stay at each
 * call site), and anything with behavior (writeServerInfo writing token/permissions, port
 * probing, dir-permission setup stay in config.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const { home } = require('./index');
const { readJson, updateJson } = require('./fslock');

/* ============================== directories / file locations ============================== */

/** Create the home dir (0700, readable by this user only). config.js calls this once at startup. */
function ensureHome() {
  const dir = home();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* ignore on non-POSIX systems */
  }
  return dir;
}

/** State-file dir: `~/.workgremlin/hooks` (the name is legacy; it holds both hook and plugin sources) */
function hooksDir() {
  return path.join(home(), 'hooks');
}

/** Server runtime info (port / token / pid): `~/.workgremlin/server.json` */
function serverInfoPath() {
  return path.join(home(), 'server.json');
}

/**
 * User-editable server configuration: `~/.workgremlin/config.json`.
 *
 * Not written by the server (unlike server.json). `dispatch` is re-read on every policy check;
 * `server` is read once at startup. Shape:
 *   {
 *     "server": { "host": "0.0.0.0", "port": 21800, "tls": true },
 *     "dispatch": { "mode": "off" | "auto" | "confirm" }
 *   }
 */
function serverConfigPath() {
  return path.join(home(), 'config.json');
}

/** Remote-dispatch session store (written by the server): `~/.workgremlin/dispatch-sessions.json` */
function dispatchStorePath() {
  return path.join(home(), 'dispatch-sessions.json');
}

/** Server database: `~/.workgremlin/workgremlin.db` */
function dbPath() {
  return path.join(home(), 'workgremlin.db');
}

/** Project list: `~/.workgremlin/workspaces.json` */
function workspacesPath() {
  return path.join(home(), 'workspaces.json');
}

/** Server log dir: `~/.workgremlin/logs` */
function logsDir() {
  return path.join(home(), 'logs');
}

/**
 * Export dir for one council: `~/.workgremlin/councils/<id>/`.
 * The id is sanitized so a malformed id can never escape the councils dir.
 * @param {string} councilId
 */
function councilReportDir(councilId) {
  const safe = String(councilId || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(home(), 'councils', safe);
}

/** Reporter event timeline (hook.js appends, log.js prunes by age): `~/.workgremlin/hooks/events.log` */
function eventsLogPath() {
  return path.join(hooksDir(), 'events.log');
}

/** Extra search roots for each product's disk dirs: `~/.workgremlin/products.overrides.json` */
function productsOverridesPath() {
  return path.join(home(), 'products.overrides.json');
}

/* ============================== state files ============================== */

/**
 * State-file path: `<client>@<workspace>[@<session id>].json`; illegal filename chars become `_`.
 *
 * The workspace + session ownership is required: when several sessions of the same product run
 * in one workspace, without those two levels session A's phase would be overwritten by session B.
 * The hook and plugin paths share this naming (the server's sessions.js matches `clientHit` by
 * the client embedded in the filename).
 *
 * @param {string} client report identity (floor base name: kilo / opencode / codebuddy …)
 * @param {string} workspacePath workspace path
 * @param {string} [sessionId] session id; without it the file is workspace-level
 */
function statePath(client, workspacePath, sessionId) {
  const parts = [String(client), String(workspacePath || '')];
  if (sessionId) parts.push(String(sessionId));
  const key = parts.join('@').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(hooksDir(), `${key}.json`);
}

/**
 * Lenient state-file read: missing / corrupt / non-object (array, string, …) all return `fallback`
 * (default `{}`). Same as fslock.readJson, plus rejecting "non-plain-object" as well — a state file
 * is defined as an object, and using a truncated array as an object is worse than reading nothing.
 * @param {string} file
 * @param {any} [fallback]
 */
function readState(file, fallback = {}) {
  const data = readJson(file, fallback);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : fallback;
}

/**
 * Merge-style write (read, patch, write back): **locked + atomic** (fslock.updateJson), same as
 * the hook side.
 *
 * Why not raw `fs.writeFileSync` (what the plugin used to do): the hook can be triggered in parallel
 * several times within the same millisecond; independent read -> modify -> write calls overwrite each
 * other and can read a half-written JSON, wiping the whole state file (see fslock.js header). The
 * plugin path is also concurrent across events, so there is no reason to use the weaker form.
 *
 * A failed write **does not throw**: reporting is best-effort and must never crash the agent (kept
 * from the plugin's writeState). Callers that need strictness should use fslock.updateJson directly.
 *
 * @param {string} file
 * @param {object} patch fields to merge in
 * @param {{pretty?: boolean}} [opts] pretty defaults to false (state files stay compact single-line)
 * @returns {object|undefined} the written value; undefined if the write failed
 */
function writeState(file, patch, opts = {}) {
  return updateState(file, (cur) => ({ ...cur, ...(patch || {}) }), opts);
}

/**
 * More general locked read-modify-write: `mutate(cur)` receives the current object and returns the
 * full object to write back. For call sites that add business fields (e.g. hookCommon's `set` which
 * fills in client / form / hb and normalizes sessionPhase). Returning undefined abandons this update
 * (no write). A failed write **does not throw** either.
 *
 * @param {string} file
 * @param {(cur: object) => object|undefined} mutate
 * @param {{pretty?: boolean}} [opts]
 * @returns {object|undefined} the written value; the read value when abandoned; undefined on write failure
 */
function updateState(file, mutate, opts = {}) {
  const { pretty = false } = opts;
  try {
    return updateJson(
      file,
      (cur) => {
        const base = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
        return mutate(base);
      },
      { fallback: {}, pretty }
    );
  } catch {
    return undefined;
  }
}

/* ============================== server.json / liveness ============================== */

/**
 * Is the process alive? — server.json / state files left behind by a crashed run must not be used
 * (pid reuse is also accepted; better to err on the side of caution).
 * @param {number} pid
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read `~/.workgremlin/server.json`.
 *
 * Three historical readers are unified here, distinguished by `requireAlive` (**default false**,
 * matching the reporter SDK / plugin; config.js's variant must check, since connection info left by
 * a crashed run should not be treated as valid):
 *   - the server itself: `readServerInfo({ requireAlive: true })`
 *   - reporter SDK / plugin: `readServerInfo()` (whether to check pid is left to the caller)
 *
 * A file without a usable `port` is not connection info: after a normal shutdown config.js keeps
 * only `{ token }` so the next start can reuse the token, and those readers must treat it as absent.
 *
 * @param {{requireAlive?: boolean}} [opts]
 * @returns {Record<string, any>|null}
 */
function readServerInfo(opts = {}) {
  const info = readJson(serverInfoPath(), null);
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  if (!Number.isInteger(info.port) || info.port <= 0) return null;
  if (opts.requireAlive && !isPidAlive(info.pid)) return null;
  return info;
}

module.exports = {
  // locations
  ensureHome,
  hooksDir,
  serverInfoPath,
  serverConfigPath,
  dispatchStorePath,
  dbPath,
  workspacesPath,
  logsDir,
  councilReportDir,
  eventsLogPath,
  productsOverridesPath,
  // state files
  statePath,
  readState,
  writeState,
  updateState,
  // server.json / liveness
  readServerInfo,
  isPidAlive,
};
