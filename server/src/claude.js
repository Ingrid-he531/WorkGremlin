'use strict';

/**
 * 4F Claude Code（CLI 与 IDE 合并楼层）。
 *
 * CLI 与 IDE 插件共用同一份 ~/.claude 配置、同一套 hook、同一个落盘目录，分不出来，
 * 合并成单楼层（见 server/src/products.js 文件头）。只有一路 cli 来源（CLI/Plugin 两形态都由它代表）。
 * 标准来源由 sessionRegistry 默认 handler 处理，本文件只声明元数据。
 */

const os = require('node:os');
const path = require('node:path');
const { clientOf } = require('@workgremlin/shared');

const HOME = os.homedir();

/**
 * Claude Code 的配置根 —— 配置、hook（settings.json）与会话落盘（projects/）都在它下面。
 * 认 CLAUDE_CONFIG_DIR（装 hook 那头早认了，找落盘这一头也得认，否则 ~/.claude 写死会偏）。
 * 这是 4F 自己私有的目录知识，放在本文件而非中央模块。
 */
function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
}

/** Claude Code 的 VS Code 扩展目录名：anthropic.claude-code-<版本> */
const RE_CLAUDE_HOST = [/^anthropic\.claude/i];

const meta = {
  id: '4F',
  name: 'Claude Code',
  kind: 'cli',
  cmd: 'claude',
  agent: 'claude',
  plugin: false,
  // 只装 IDE 扩展的人这一层照样"装了"，altPluginRe 补抓安装证据。
  altPluginRe: RE_CLAUDE_HOST,
  sources: [{ kind: 'cli', label: 'CLI/Plugin' }],
  dataKind: clientOf('claude', false),
  // 落盘探测（findDataPath 用）
  matchRe: [/^claude/i],
  homeDirs: [claudeHome()],
  // CLI 会话文件落在 <dataRoot>/projects/<工程>/ 下，文件名即 session_id
  sessionSubtree: 'projects',
  sessionIdOfFile: (name) => String(name).replace(/\.jsonl$/i, ''),
};

module.exports = { id: '4F', meta, RE_CLAUDE_HOST, claudeHome };
