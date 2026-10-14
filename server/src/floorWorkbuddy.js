'use strict';

/**
 * 2F WorkBuddy。
 *
 * 只有 CLI 一个形态（见 server/src/products.js 文件头）：落盘 ~/.workbuddy 下的会话 jsonl。
 * 标准来源（cli/hook）由 sessionRegistry 默认 handler 处理，本文件只声明元数据。
 */

const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();

const meta = {
  id: '2F',
  name: 'WorkBuddy',
  kind: 'cli',
  cmd: 'workbuddy',
  agent: 'workbuddy',
  plugin: false,
  dataKind: 'workbuddy',
  // 落盘探测（findDataPath 用）
  matchRe: [/^workbuddy/i, /^work-?buddy/i],
  homeDirs: [path.join(HOME, '.workbuddy')],
  // 这一层 CLI 自己的安装目录（PATH 查不到时兜底）
  cliBinDirs: [path.join(HOME, '.workbuddy', 'bin')],
};

const { runHookEvent, sharedHookImpl, jsonlReplies, indexJsonReplies, turnInterrupted } = require('./ingest/hookCommon');
// 静态 subagent 目录（项目级 / 用户级）：本楼层私有知识，放这里而非中央 agentLevel
const { genericAgentDirs } = require('./ingest/agentLevel');

/**
 * 2F 的静态 subagent 定义目录：项目级 <ws>/.workbuddy/agents、用户级 ~/.workbuddy/agents。
 * 返回 [{ dir, level }]，项目级先于用户级。
 */
function agentDirs(workspacePath) {
  return genericAgentDirs([path.join(HOME, '.workbuddy')], workspacePath);
}

/** WorkBuddy 的落盘差异：事件开关与文件/token/ghost 等公共逻辑全在 hookCommon.runHookEvent。
 * 只覆盖与公有默认不同的接口；其余回退 sharedHookImpl。 */
const workbuddyImpl = {
  ...sharedHookImpl,
  awaitingPermission: () => true, // 非 idle 的 Notification 一律视为"等授权"
  repliesOf: (tp) => (/index\.json$/i.test(tp) ? indexJsonReplies(tp) : jsonlReplies(tp)),
  interruptedSince: (tp, since) => turnInterrupted(tp, since),
};

async function handleHookEvent(ev, ctx) {
  return runHookEvent(ev, ctx, workbuddyImpl);
}

module.exports = { id: '2F', meta, handleHookEvent, agentDirs };
