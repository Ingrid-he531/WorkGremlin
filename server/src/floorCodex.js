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
const fs = require('node:fs');
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
  /**
   * Whether a file under sessions/ is a real user session.
   *
   * Codex writes subagent rollouts into the ordinary sessions tree with the same
   * rollout-<timestamp>-<uuid>.jsonl name as a user session, so only the content tells them apart:
   * the first line's session_meta carries thread_source "subagent" (newer versions also carry
   * source.subagent / parent_thread_id). Such a rollout is the child transcript of the parent
   * conversation, not an independent session. Listing it makes the dropdown show a second entry
   * with no task and phase "unreported"; because that file is often fresher than the parent's, the
   * renderer can auto-select it and the main console falls back to idle while the parent's ghosts
   * are still running.
   *
   * Reads only the first line (session_meta), capped at 512 KB because that line carries the base
   * instructions. If the head cannot be read, keep the file: showing one extra session beats hiding
   * a real one.
   * @param {string} file absolute rollout path
   * @returns {boolean}
   */
  isSessionFile: (file) => {
    const CAP = 512 * 1024;
    let head = Buffer.alloc(0);
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const chunk = Buffer.alloc(8192);
        while (head.length < CAP) {
          const n = fs.readSync(fd, chunk, 0, chunk.length, head.length);
          if (n <= 0) break;
          head = Buffer.concat([head, chunk.subarray(0, n)]);
          if (head.indexOf(0x0a) >= 0) break;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return true;
    }
    const nl = head.indexOf(0x0a);
    const firstLine = (nl >= 0 ? head.subarray(0, nl) : head).toString('utf8');
    let meta;
    try {
      meta = JSON.parse(firstLine);
    } catch {
      // A truncated / unparseable head: do not hide the session on a guess.
      return true;
    }
    const payload = meta && meta.payload;
    if (!payload || typeof payload !== 'object') return true;
    if (String(payload.thread_source || '').toLowerCase() === 'subagent') return false;
    const source = payload.source;
    if (source && typeof source === 'object' && source.subagent) return false;
    if (payload.parent_thread_id) return false;
    return true;
  },
};

const { runHookEvent, sharedHookImpl, jsonlReplies, turnInterrupted, headJsonLines } = require('./ingest/hookCommon');

/** Interpret the raw host signal forwarded by hook.js. The environment belongs to the process
 * that launched the hook, so it is more authoritative than a stale rollout header. */
function codexFormFromHookEnv(hookEnv) {
  const originator = String((hookEnv && hookEnv.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) || '').toLowerCase();
  if (/desktop/.test(originator)) return 'desktop';
  if (/vscode|visual studio|extension|plugin/.test(originator)) return 'vscode';
  return '';
}

/** Codex form (cli / desktop / vscode): the source/originator of the session_meta first line of a
 * rollout. Moved here from hookCommon (it is part of "the floor's own interface"); fields not
 * overridden fall back to sharedHookImpl.
 *
 * The Codex desktop app reports `source: "vscode"` together with `originator: "Codex Desktop"`,
 * while the VS Code extension reports `originator: "codex_vscode"` -- the two share `source`, so
 * only the originator can tell them apart. "desktop" is therefore matched against `originator`
 * alone (never the source), and checked before the vscode-family match; otherwise the desktop app
 * is mistaken for the VS Code extension and shown as "Codex Plugin". */
function codexForm(transcriptPath) {
  for (const obj of headJsonLines(transcriptPath)) {
    const p = obj && obj.payload;
    if (!p || typeof p !== 'object') continue;
    if (obj.type !== 'session_meta' && !p.source && !p.originator) continue;
    const source = String(p.source || '').toLowerCase();
    const originator = String(p.originator || '').toLowerCase();
    const who = `${source} ${originator}`;
    if (/desktop/.test(originator)) return 'desktop';
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
  const hookForm = codexFormFromHookEnv(ev && ev.hookEnv);
  return runHookEvent(hookForm ? { ...ev, form: hookForm } : ev, ctx, codexImpl);
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
