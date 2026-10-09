'use strict';

/**
 * 只读打开各产品自己的落盘 SQLite（kilo.db / opencode.db / 灵码 local.db …）。
 * better-sqlite3 把构造函数挂在 module.exports 上（没有 .Database 具名导出），
 * 项目其它文件都是直接 require 拿构造函数。打开失败（库没装 / 表结构变了）一律回 null，
 * 调用方据此当"没有"处理，绝不冒泡、绝不编造。
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
