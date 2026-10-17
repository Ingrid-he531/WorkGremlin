'use strict';

/**
 * Server-side hook event dispatcher.
 *
 * Architecture background (see the refactor notes): the CLI hook is reduced to "read the stdin
 * event -> POST /api/v1/hook"; all on-disk parsing / session state / ledger writes happen on
 * the **server side** — the server is a local process sharing the same machine and file system
 * as the CLI, and it already reads the agent's on-disk data anyway (that is how the
 * Kilo/Copilot crowd has always worked).
 *
 * This module does only three things:
 *   ① Work out the client (floor) from the event;
 *   ② Find that floor's `handleHookEvent` and dispatch to it;
 *   ③ Own the "session state" — replacing what used to be the hook's state file
 *      (taskId / taskStartedAt / taskTitle …), indexed by sessionId; when it cannot be found,
 *      the floor fishes it back out of the bus itself (currentTaskFor).
 *
 * Floors without a `handleHookEvent` (Cline / Kilo / Copilot / OpenCode / Trae and other poll-driven
 * ones) simply ignore events; their ledgers are covered by their own synchronizers and do not
 * go through this hook path.
 *
 * Floor `handleHookEvent` contract:
 *   async (ev, ctx) => any
 *   ctx = { project, workspacePath, client, bus, repo, sessionGet(id), sessionSet(id, patch) }
 *   Any returned object is handed back to the hook as-is (wrapped as { ok:true, ... });
 *   returning {ok:false,...} results in a 400.
 */

const { floorByAgent } = require('../floors');

function createHookDispatch() {
  // Session state: replaces the hook's state file. sessionId -> context of the current round.
  const sessions = new Map();

  const sessionGet = (id) => (id ? sessions.get(id) || null : null);
  const sessionSet = (id, patch) => {
    if (!id) return;
    sessions.set(id, { ...(sessions.get(id) || {}), ...(patch || {}) });
  };

  /**
   * Dispatch one hook event.
   * @param {object} ev raw hook event (hook_event_name / session_id / cwd / transcript_path / client / agent …)
   * @param {{project: string, workspacePath: string, bus: any, repo: any}} ctx
   */
  async function dispatch(ev, ctx) {
    const event = ev && ev.hook_event_name;
    if (!event || !ev.agent) {
      return { ok: false, error: 'missing hook_event_name or agent' };
    }
    const floor = floorByAgent[String(ev.agent).toLowerCase()];
    if (!floor || typeof floor.handleHookEvent !== 'function') {
      return { ok: true, ignored: true };
    }
    return floor.handleHookEvent(ev, {
      project: ctx.project,
      workspacePath: ctx.workspacePath,
      bus: ctx.bus,
      repo: ctx.repo,
      sessionGet,
      sessionSet,
    });
  }

  return { dispatch, sessionGet, sessionSet, _sessions: sessions };
}

module.exports = { createHookDispatch };
