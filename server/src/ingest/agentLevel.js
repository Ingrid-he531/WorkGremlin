'use strict';

/**
 * subagent 级别判定：用户级 vs 项目级。
 *
 * 渲染层是沙箱（读不了文件系统），所以"这个成员是用户级还是项目级 subagent"
 * 必须由服务端算好再随成员卡下发。判定口径与 CodeBuddy 官方一致：
 *   · 项目级：<workspacePath>/.codebuddy/agents/<name>.md
 *   · 用户级：~/.codebuddy/agents/<name>.md
 * 都不在 -> null（普通成员 / 演示数据，不戴级别牌）。
 *
 * 结果按 "name + workspacePath" 缓存（agent 定义一个会话内很少变）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const USER_AGENTS_DIR = path.join(HOME, '.codebuddy', 'agents');

/** 文件名大小写兼容：CodeBuddy 文档要求小写连字符，但保险起见两种都试 */
function fileExists(dir, name) {
  const base = String(name || '').trim();
  if (!base) return false;
  const cands = [`${base}.md`, `${base.toLowerCase()}.md`];
  return cands.some((f) => {
    try {
      return fs.statSync(path.join(dir, f)).isFile();
    } catch {
      return false;
    }
  });
}

const cache = new Map();

function detectLevel(name, workspacePath) {
  const ws = String(workspacePath || '').trim();
  const key = `${name} ${ws}`;
  if (cache.has(key)) return cache.get(key);

  let level = null;
  if (ws) {
    const projDir = path.join(path.resolve(ws), '.codebuddy', 'agents');
    if (fileExists(projDir, name)) level = 'project';
  }
  if (!level && fileExists(USER_AGENTS_DIR, name)) level = 'user';

  cache.set(key, level);
  return level;
}

function clearCache() {
  cache.clear();
}

module.exports = { detectLevel, clearCache };
