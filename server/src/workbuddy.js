'use strict';

/**
 * 2F WorkBuddy。
 *
 * 只有 CLI 一个形态（见 server/src/products.js 文件头）：落盘 ~/.workbuddy 下的会话 jsonl。
 * 标准来源（cli/hook）由 sessionRegistry 默认 handler 处理，本文件只声明元数据。
 */

const os = require('node:os');
const path = require('node:path');
const { clientOf } = require('@workgremlin/shared');

const HOME = os.homedir();

const meta = {
  id: '2F',
  name: 'WorkBuddy',
  kind: 'cli',
  cmd: 'workbuddy',
  agent: 'workbuddy',
  plugin: false,
  dataKind: clientOf('workbuddy', false),
  // 落盘探测（findDataPath 用）
  matchRe: [/^workbuddy/i, /^work-?buddy/i],
  homeDirs: [path.join(HOME, '.workbuddy')],
  // 这一层 CLI 自己的安装目录（PATH 查不到时兜底）
  cliBinDirs: [path.join(HOME, '.workbuddy', 'bin')],
};

module.exports = { id: '2F', meta };
