'use strict';

/**
 * plugin.js —— **generic location resolution and shared conventions** for IDE plugin
 * (editor globalStorage) on-disk data.
 *
 * This file holds only the layer that is "independent of any specific product"; nobody should
 * push knowledge of a particular floor in here:
 *   · Where plugins land: globalStorageRoots (extension data roots) / workspaceStorageRoots
 *     (per-workspace data)
 *   · Finding one product's plugin storage root inside globalStorage by a **caller-supplied**
 *     directory-name regex + on-disk marker (findPluginStorage —— all matching rules come from
 *     the caller, per floor)
 *   · On-disk window constants shared by plugin sources (IDLE_MS / … / DONE_TTL_MS)
 *
 * Each floor's **own** on-disk format stays in that floor's file (see FLOOR_CONTRACT in
 * floors.js):
 *   · 1F CodeBuddy's genie-history / todos / file-changes / message-queue → pluginStore in
 *     floorCodebuddy.js
 *   · 9F GitHub Copilot's session-store.db / state.vscdb                  → floorCopilot.js
 * sessions.js's listSessions dispatches on-disk reads to the right floor by client, and uses
 * this file only as "find the directory + window constants" —— no product directory names
 * appear here anymore, and there is no built-in fallback like "the union of all plugin
 * products" (that union was the root cause of "9F scanning into 1F's on-disk data", see
 * server/test/taskSync.test.js [8]).
 *
 * The "never fabricate" discipline: not found means not found —— return an empty string / empty
 * array, never guess.
 */

const path = require('node:path');
const os = require('node:os');
const { dataRoots, globalStorageRoots, isDir, isFile, readDir } = require('./roots');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

/** On-disk windows (aligned with the CLI floors; sessionRegistry's TIMEOUT_MS = 60 minutes) */
const IDLE_MS = 10 * 60_000; // how long without activity counts as "inactive" (the plugin runtime has no heartbeat, so only file times can be used)
const BUSY_MS = 90_000; // a file changed within this long → considered to be actively working
const FRESH_MS = 2 * 60_000; // on-disk writes within this long → this round of conversation is still advancing (covers cases like pure reasoning or read-only tools that leave no file/todo evidence)
const LISTED_MS = 60 * 60_000; // window in which a session is "still in the dropdown" (see the notes in sessions.js)
const DONE_TTL_MS = 10 * 60_000; // "freshness" window of the done marker: only something that finished within this long counts as "just happened"

/** Editor workspaceStorage directories (where VS Code keeps per-workspace state.vscdb) */
function workspaceStorageRoots() {
  const out = [];
  for (const r of dataRoots()) {
    for (const ed of ['Code', 'Code - Insiders', 'Cursor', 'Trae', 'Windsurf', 'VSCodium']) {
      const p = path.join(r, ed, 'User', 'workspaceStorage');
      if (isDir(p)) out.push(p);
    }
  }
  const srv = path.join(HOME, '.vscode-server', 'data', 'User', 'workspaceStorage');
  if (isDir(srv)) out.push(srv);
  return out;
}

/**
 * Plugin storage root: find **this one floor's** plugin directory inside globalStorage using
 * the caller-supplied directory-name regex.
 * Callers always pass **their own floor's** meta.pluginRe (never a union across "all products")
 * and may additionally use marks to confirm this is "the one with session data on disk"
 * (for instance, when `github.copilot` and `github.copilot-chat` share a prefix, pass
 * ['session-store.db'] to filter out the one without a session store).
 * @param {RegExp|RegExp[]} re directory-name matcher for this product; iterates the directory
 *   list **in the given order** and takes the first hit. Omitted = no matching.
 * @param {string[]} [marks] subdirectory / file names that must exist inside a hit directory
 *   (any one suffices). Empty = no validation.
 * @returns {string} absolute path of the matching storage root; '' when not found
 */
function findPluginStorage(re, marks = []) {
  const list = (Array.isArray(re) ? re : re ? [re] : []).filter(Boolean);
  if (!list.length) return '';
  const need = Array.isArray(marks) ? marks.filter(Boolean) : [];
  for (const root of globalStorageRoots()) {
    for (const name of readDir(root)) {
      if (!list.some((rx) => rx.test(name))) continue;
      const dir = path.join(root, name);
      if (need.length && !need.some((m) => isDir(path.join(dir, m)) || isFile(path.join(dir, m)))) continue;
      return dir;
    }
  }
  return '';
}

module.exports = {
  // Product-independent on-disk resolution
  dataRoots,
  globalStorageRoots,
  workspaceStorageRoots,
  findPluginStorage,
  // On-disk window constants shared by plugin sources (used by sessions.js / floorCopilot.js,
  // so each does not have to define its own copy)
  IDLE_MS,
  BUSY_MS,
  FRESH_MS,
  LISTED_MS,
  DONE_TTL_MS,
};
