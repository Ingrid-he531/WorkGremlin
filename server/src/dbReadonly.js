'use strict';

/**
 * Open each product's own on-disk SQLite read-only (kilo.db / opencode.db / Lingma local.db …).
 * better-sqlite3 hangs the constructor off module.exports (there is no named .Database export),
 * and every other file in the project just requires it to get the constructor.
 * Any open failure (library not installed / schema changed) returns null, and callers treat
 * that as "absent" — never bubble it up, never fabricate anything.
 */

const Database = require('better-sqlite3');

const OPEN_TIMEOUT_MS = 3_000;

function openReadonly(file) {
  if (!file) return null;
  try {
    return new Database(file, { readonly: true, fileMustExist: true, timeout: OPEN_TIMEOUT_MS });
  } catch {
    return null;
  }
}

function readOne(db, sql, ...params) {
  if (!db) return null;
  try {
    return db.prepare(sql).get(...params);
  } catch {
    return null;
  }
}

module.exports = { openReadonly, readOne };
