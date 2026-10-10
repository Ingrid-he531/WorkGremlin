'use strict';

/**
 * 3F Codex（CLI 与 IDE 合并楼层）。
 *
 * CLI 与 IDE 插件共用同一份 ~/.codex、同一套 hook，分不出来，合并成单楼层
 * （见 server/src/products.js 文件头）。只有一路 cli 来源（CLI/Plugin 两种形态都由它代表）。
 * 标准来源由 sessionRegistry 默认 handler 处理，本文件只声明元数据。
 */

const os = require('node:os');
const path = require('node:path');
const { clientOf } = require('@workgremlin/shared');

const HOME = os.homedir();

/** Codex 的宿主扩展目录名：VS Code 里的 openai.chatgpt-* / openai.codex-*（它们自带 codex） */
const RE_CODEX_HOST = [/^openai\.(chatgpt|codex)/i];

const meta = {
  id: '3F',
  name: 'Codex',
  kind: 'cli',
  cmd: 'codex',
  agent: 'codex',
  plugin: false,
  // 「CLI 与 IDE 合并」楼层：只装 VS Code 扩展 / ChatGPT 桌面版的人命令行里没有 codex，
  // 但确实在跑（会话就是证据），所以 altPluginRe 补抓安装证据。
  altPluginRe: RE_CODEX_HOST,
  sources: [{ kind: 'cli', label: 'CLI/Plugin' }],
  dataKind: clientOf('codex', false),
  // 落盘探测（findDataPath 用）
  matchRe: [/^codex/i],
  homeDirs: [path.join(HOME, '.codex')],
  // Codex 同款 = ChatGPT 桌面端：CLI 装在这两个资源目录里（与具体产品无关的位置在通用兜底里）
  cliBinDirs: [
    '/usr/lib/chatgpt/resources',
    '/opt/chatgpt/resources',
    ...(process.platform === 'darwin' ? ['/Applications/ChatGPT.app/Contents/Resources'] : []),
  ],
  // CLI 会话文件落在 <dataRoot>/sessions/YYYY/MM/DD/ 下，文件名形如
  // rollout-<时间戳>-<session_id>.jsonl，id 在尾段
  sessionSubtree: 'sessions',
  sessionIdOfFile: (name) => {
    const m = String(name).match(
      /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
    );
    return m ? m[1] : '';
  },
};

const { runHookEvent, jsonlReplies, codexForm, turnInterrupted } = require('./ingest/hookCommon');

/** Codex 的落盘差异：事件开关与文件/token/ghost 等公共逻辑全在 hookCommon.runHookEvent */
const codexImpl = {
  client: 'codex',
  coarse: false,
  hasPermissionEvent: true, // Codex 有独立的 PermissionRequest 事件
  awaitingPermission: () => true, // 非 idle 的 Notification 一律视为"等授权"（idle 已在前面处理）
  hasSubagentStart: true, // Codex 发 SubagentStart / SubagentStop
  repliesOf: jsonlReplies,
  interruptedSince: (tp, since) => turnInterrupted(tp, since),
  formOf: (tp) => codexForm(tp),
};

async function handleHookEvent(ev, ctx) {
  return runHookEvent(ev, ctx, codexImpl);
}

module.exports = { id: '3F', meta, RE_CODEX_HOST, handleHookEvent };
