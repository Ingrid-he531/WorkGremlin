'use strict';

/**
 * 3F Codex (CLI and IDE merged floor).
 *
 * The CLI and the IDE plugin share the same ~/.codex and the same set of hooks, and cannot be
 * told apart, so they are merged into a single floor (see the header of server/src/products.js).
 * There is only one cli source (both the CLI and the Plugin forms are represented by it).
 * Standard sources are handled by the sessionRegistry default handler; this file only declares
 * metadata.
 */

const os = require('node:os');
const path = require('node:path');
// Static subagent directories (project-level / user-level): private knowledge of this floor,
// kept here rather than in the central agentLevel
const { genericAgentDirs, makeAgentSync } = require('./ingest/agentLevel');

const HOME = os.homedir();

/** Codex host extension directory names: openai.chatgpt-* / openai.codex-* in VS Code (they ship codex themselves) */
const RE_CODEX_HOST = [/^openai\.(chatgpt|codex)/i];

const meta = {
  id: '3F',
  name: 'Codex',
  kind: 'cli',
  cmd: 'codex',
  agent: 'codex',
  plugin: false,
  // A "CLI and IDE merged" floor: someone who only installed the VS Code extension / ChatGPT
  // desktop app has no `codex` on the command line, yet is clearly running it (a session is
  // the evidence), so altPluginRe picks up that install evidence.
  altPluginRe: RE_CODEX_HOST,
  sources: [{ kind: 'cli', label: 'CLI/Plugin' }],
  dataKind: 'codex',
  // On-disk detection (used by findDataPath)
  matchRe: [/^codex/i],
  homeDirs: [path.join(HOME, '.codex')],
  // The Codex equivalent = the ChatGPT desktop app: the CLI lives in these two resource
  // directories (product-independent locations are in the generic fallback)
  cliBinDirs: [
    '/usr/lib/chatgpt/resources',
    '/opt/chatgpt/resources',
    ...(process.platform === 'darwin' ? ['/Applications/ChatGPT.app/Contents/Resources'] : []),
  ],
  // CLI session files land under <dataRoot>/sessions/YYYY/MM/DD/, named like
  // rollout-<timestamp>-<session_id>.jsonl, with the id in the trailing segment
  sessionSubtree: 'sessions',
  sessionIdOfFile: (name) => {
    const m = String(name).match(
      /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
    );
    return m ? m[1] : '';
  },
};

const { runHookEvent, sharedHookImpl, jsonlReplies, turnInterrupted, headJsonLines } = require('./ingest/hookCommon');

/** Codex form (cli / plugin): the source/originator of the session_meta first line of a rollout.
 * Moved here from hookCommon (it is part of "the floor's own interface"); fields not overridden
 * fall back to sharedHookImpl. */
function codexForm(transcriptPath) {
  for (const obj of headJsonLines(transcriptPath)) {
    const p = obj && obj.payload;
    if (!p || typeof p !== 'object') continue;
    if (obj.type !== 'session_meta' && !p.source && !p.originator) continue;
    const who = `${String(p.source || '')} ${String(p.originator || '')}`.toLowerCase();
    if (/jetbrains/.test(who)) return 'jetbrains';
    if (/vscode|visual studio|extension|plugin/.test(who)) return 'vscode';
    if (who.trim()) return 'cli';
  }
  return '';
}

/** Codex differs only in how it reads its on-disk data: event gating and the common
 * file/token/ghost logic all live in hookCommon.runHookEvent */
const codexImpl = {
  ...sharedHookImpl,
  hasPermissionEvent: true, // Codex has its own dedicated PermissionRequest event
  awaitingPermission: () => true, // any non-idle Notification counts as "awaiting permission" (idle is already handled earlier)
  hasSubagentStart: true, // Codex emits SubagentStart / SubagentStop
  repliesOf: jsonlReplies,
  interruptedSince: (tp, since) => turnInterrupted(tp, since),
  formOf: (tp) => codexForm(tp),
};

async function handleHookEvent(ev, ctx) {
  return runHookEvent(ev, ctx, codexImpl);
}

/**
 * 3F static subagent definition directories: project-level <ws>/.codex/agents and user-level
 * $CODEX_HOME/agents (CODEX_HOME falls back to ~/.codex).
 * Returns [{ dir, level }], project level before user level.
 */
function agentDirs(workspacePath) {
  const home = process.env.CODEX_HOME || path.join(HOME, '.codex');
  return genericAgentDirs([home], workspacePath);
}

module.exports = { meta, RE_CODEX_HOST, handleHookEvent, codexForm, agentDirs, syncAgents: makeAgentSync(agentDirs, meta.agent) };
