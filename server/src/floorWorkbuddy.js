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

const { runHookEvent, jsonlReplies, codebuddyReplies, turnInterrupted } = require('./ingest/hookCommon');

/** WorkBuddy 的落盘差异：事件开关与文件/token/ghost 等公共逻辑全在 hookCommon.runHookEvent */
const workbuddyImpl = {
  client: 'workbuddy',
  coarse: false,
  hasPermissionEvent: false,
  awaitingPermission: () => true, // 非 idle 的 Notification 一律视为"等授权"
  hasSubagentStart: false,
  repliesOf: (tp) => (/index\.json$/i.test(tp) ? codebuddyReplies(tp) : jsonlReplies(tp)),
  interruptedSince: (tp, since) => turnInterrupted(tp, since),
  formOf: () => '',
};

async function handleHookEvent(ev, ctx) {
  return runHookEvent(ev, ctx, workbuddyImpl);
}

module.exports = { id: '2F', meta, handleHookEvent };
