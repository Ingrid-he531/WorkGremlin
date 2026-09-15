'use strict';

/**
 * 工程（workspace）标识解析。
 *
 * 顶部连接条要显示"现在盯的是哪个工程"，名字按优先级取：
 *   1. WORKGREMLIN_WORKSPACE / 入参指定的目录
 *   2. 否则 process.cwd()
 * 名字本身：<dir>/package.json 的 name（去 scope） > 目录名 > 空串。
 *
 * 拿不到就是空串 —— UI 侧回落到原来的提示，绝不编造一个"看起来像"的项目名。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {string} [dir]
 * @returns {string} package.json 的 name（已去掉 @scope/），读不到返回 ''
 */
function readPackageName(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const name = typeof pkg.name === 'string' ? pkg.name.trim() : '';
    return name ? name.replace(/^@[^/]+\//, '') : '';
  } catch {
    return '';
  }
}

/**
 * 工程根目录。
 * @param {string} [input]
 */
function resolveWorkspacePath(input) {
  const raw = String(input || process.env.WORKGREMLIN_WORKSPACE || '').trim();
  if (raw) return path.resolve(raw);
  return path.resolve(process.cwd());
}

/**
 * 工程名。
 * @param {string} [workspacePath]
 */
function resolveProjectName(workspacePath) {
  const dir = resolveWorkspacePath(workspacePath);
  const fromPkg = readPackageName(dir);
  if (fromPkg) return fromPkg;
  const base = path.basename(dir);
  return base && base !== path.sep ? base : '';
}

module.exports = { readPackageName, resolveWorkspacePath, resolveProjectName };
