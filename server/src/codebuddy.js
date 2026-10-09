'use strict';

/**
 * 1F CodeBuddy（CLI 与 Plugin 合并楼层）。
 *
 * 这一层 = 同一个产品的两种形态合成一层（见 server/src/products.js 文件头）：
 *   cli    —— ~/.codebuddy 下的会话 jsonl（CLI 历史落盘）
 *   plugin —— 编辑器 globalStorage 里的结构化落盘（genie-history / todos / …）
 *   hook   —— reporter 状态文件（CLI 常常没有可扫的会话落盘时的唯一真值）
 * 三种标准来源（cli/plugin/hook）都由 sessionRegistry 的默认 handler 处理，
 * 本文件只声明元数据，不需要写 kindHandlers。新增/调整本楼层只改这个文件。
 */

const os = require('node:os');
const path = require('node:path');
const { clientOf } = require('@workgremlin/shared');

const HOME = os.homedir();

/** 插件目录名匹配（仅 plugin 楼层需要）；findPluginDir 的默认正则也用它 */
const RE_PLUGIN = [/codebuddy/i, /tencent/i, /ingram/i, /code-?buddy/i];

const meta = {
  id: '1F',
  name: 'CodeBuddy',
  kind: 'cli',
  cmd: 'codebuddy',
  agent: 'codebuddy',
  plugin: false,
  pluginRe: RE_PLUGIN,
  // 合并楼层：三路都归这一层；同一会话被两路同时看到时按 session_id 去重（见 sessionRegistry）。
  sources: ['cli', 'plugin', 'hook'],
  dataKind: clientOf('codebuddy', false),
  // 落盘探测（findDataPath 用）：按名字匹配什么、家目录里哪些候选
  matchRe: [/^codebuddy/i, /^code-?buddy/i, /^tencent/i, /^ingram/i],
  homeDirs: [path.join(HOME, '.codebuddy'), path.join(HOME, '.codebuddy-cli')],
  // 这一层 CLI 自己的安装目录（PATH 查不到时兜底）；与具体产品无关的位置在 floors.js 的通用兜底里
  cliBinDirs: [path.join(HOME, '.codebuddy', 'bin')],
  // CLI 会话文件落在 <dataRoot>/projects/<工程>/ 下，文件名即 session_id
  // （老版本给的是 32 位十六进制无连字符，一并认）
  sessionSubtree: 'projects',
  sessionIdOfFile: (name) => {
    const stem = String(name).replace(/\.jsonl$/i, '');
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem) ||
      /^[0-9a-f]{32}$/i.test(stem)
      ? stem
      : '';
  },
};

module.exports = {
  id: '1F',
  meta,
  // 供 findPluginDir / findPluginStorageDir 默认正则复用
  RE_PLUGIN,
};
