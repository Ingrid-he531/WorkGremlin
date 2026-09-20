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
/** Codex CLI 的 agent 定义目录（实测：codex home 下有 agents/；扩展名以 .md / .toml 都试） */
const USER_CODEX_AGENTS_DIR = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'agents');

/** 文件名大小写兼容：CodeBuddy 文档要求小写连字符，但保险起见两种都试 */
function fileExists(dir, name) {
  const base = String(name || '').trim();
  if (!base) return false;
  const cands = [`${base}.md`, `${base.toLowerCase()}.md`, `${base}.toml`, `${base.toLowerCase()}.toml`];
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
    const root = path.resolve(ws);
    if (fileExists(path.join(root, '.codebuddy', 'agents'), name)) level = 'project';
    else if (fileExists(path.join(root, '.codex', 'agents'), name)) level = 'project'; // Codex CLI
  }
  if (!level && fileExists(USER_AGENTS_DIR, name)) level = 'user';
  else if (!level && fileExists(USER_CODEX_AGENTS_DIR, name)) level = 'user'; // Codex CLI

  cache.set(key, level);
  return level;
}

function clearCache() {
  cache.clear();
}

module.exports = { detectLevel, clearCache };
