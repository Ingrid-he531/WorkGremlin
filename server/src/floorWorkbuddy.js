'use strict';

/**
 * 2F WorkBuddy.
 *
 * Only the CLI form exists (see the header of server/src/products.js): session jsonl files land
 * under ~/.workbuddy. Standard sources (cli/hook) are handled by the sessionRegistry default
 * handler; this file only declares metadata.
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
  // On-disk detection (used by findDataPath)
  matchRe: [/^workbuddy/i, /^work-?buddy/i],
  homeDirs: [path.join(HOME, '.workbuddy')],
  // This floor's own CLI install directory (fallback when PATH lookup fails)
  cliBinDirs: [path.join(HOME, '.workbuddy', 'bin')],
};

const { runHookEvent, sharedHookImpl, jsonlReplies, indexJsonReplies, turnInterrupted } = require('./ingest/hookCommon');
// Static subagent directories (project-level / user-level): private knowledge of this floor,
// kept here rather than in the central agentLevel
const { genericAgentDirs, makeAgentSync } = require('./ingest/agentLevel');

/**
 * 2F static subagent definition directories: project-level <ws>/.workbuddy/agents and
 * user-level ~/.workbuddy/agents.
 * Returns [{ dir, level }], project level before user level.
 */
function agentDirs(workspacePath) {
  return genericAgentDirs([path.join(HOME, '.workbuddy')], workspacePath);
}

/** WorkBuddy differs only in how it reads its on-disk data: event gating and the common
 * file/token/ghost logic all live in hookCommon.runHookEvent.
 * Only the interfaces that differ from the shared default are overridden; everything else
 * falls back to sharedHookImpl. */
const workbuddyImpl = {
  ...sharedHookImpl,
  awaitingPermission: () => true, // any non-idle Notification counts as "awaiting permission"
  repliesOf: (tp) => (/index\.json$/i.test(tp) ? indexJsonReplies(tp) : jsonlReplies(tp)),
  interruptedSince: (tp, since) => turnInterrupted(tp, since),
};

async function handleHookEvent(ev, ctx) {
  return runHookEvent(ev, ctx, workbuddyImpl);
}

module.exports = { meta, handleHookEvent, agentDirs, syncAgents: makeAgentSync(agentDirs, meta.agent) };
