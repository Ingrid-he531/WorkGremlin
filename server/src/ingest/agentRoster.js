'use strict';

/**
 * Sitting-gremlin roster: registers the "defined subagents" (project-level + user-level) as members
 * with workstations.
 *
 * Ownership lives in the floors: each floor scans its OWN agent dirs (its `syncAgents`, built from
 * `agentDirs` — see agentLevel.makeAgentSync) and calls `registerAgent` / `unregisterAgent` here.
 * This module is the upper-layer registration API plus the in-memory bookkeeping (ownership, the
 * "defined" set, the "summoned" set). It owns **no timer** — the server's unified poller drives the
 * floors (see poller.js).
 *
 * Split with the ghost path (bus.ghostSpawn / ghostRetire / ghostSweep):
 *   · this module ensures every defined subagent has a sitting, badged gremlin;
 *   · the ghost path handles the running instances (ephemeral members).
 *   memberIds differ (a gremlin uses the bare name, a ghost uses `subagent-<name>`), so they never clash.
 */

const config = require('../config');

/**
 * @param {{bus:any, project?:string, getProject?:()=>string, getWorkspacePath?:()=>string}} opts
 */
function createAgentRoster(opts) {
  const bus = opts.bus;
  /**
   * Which project the gremlins register under: **follows the currently open project**. Pass
   * `getProject()` so it is read fresh each time — otherwise the roster pins to one project (the old
   * code hardcoded the demo project id, which only "worked" because the demo happened to share the
   * real project's name) and gremlins won't follow a project switch.
   */
  const getProject = typeof opts.getProject === 'function' ? opts.getProject : () => opts.project || config.DEMO_PROJECT;
  const getWorkspacePath = typeof opts.getWorkspacePath === 'function' ? opts.getWorkspacePath : () => '';
  /** project -> Set(name) this roster registered there */
  const registered = new Map();
  /** project -> Map(name -> floor id that claimed it); the first floor to claim a duplicate name wins */
  const owners = new Map();
  /** project -> Set(name): resident gremlins whose same-name ghost is currently working */
  const active = new Map();

  function state(project) {
    let mine = registered.get(project);
    if (!mine) {
      mine = new Set();
      registered.set(project, mine);
    }
    let own = owners.get(project);
    if (!own) {
      own = new Map();
      owners.set(project, own);
    }
    let act = active.get(project);
    if (!act) {
      act = new Set();
      active.set(project, act);
    }
    return { mine, own, act };
  }

  function ghostAlive(project, name) {
    try {
      return typeof bus.isGhostAlive === 'function' && bus.isGhostAlive({ project, name });
    } catch {
      return false;
    }
  }

  function writeBorrowedBusy(project, name, busy) {
    try {
      if (busy) bus.setBorrowedBusy({ project, memberId: name });
      else bus.clearBorrowedBusy({ project, memberId: name });
    } catch {
      /* ignore */
    }
  }

  /**
   * A floor found this subagent defined: register it under the current project (the first floor to
   * claim a duplicate name wins). Registration does not write an idle row; a member with no explicit
   * state is idle by definition.
   * @param {{meta?: {id?: string, agent?: string}}} floor
   * @param {{name: string, level: 'project'|'user', client?: string}} a
   */
  function registerAgent(floor, a) {
    const project = getProject();
    const ws = getWorkspacePath();
    const name = String((a && a.name) || '').trim();
    if (!name) return;
    const floorId = (floor && floor.meta && floor.meta.id) || '';
    const client = (a && a.client) || (floor && floor.meta && floor.meta.agent) || '';
    const { mine, own, act } = state(project);
    if (mine.has(name)) {
      const alive = act.has(name) && ghostAlive(project, name);
      if (alive) act.add(name);
      else if (act.delete(name)) writeBorrowedBusy(project, name, false);
      return;
    }
    mine.add(name);
    own.set(name, floorId);
    bus.registerMember({
      project,
      memberId: name,
      name,
      role: a.level === 'project' ? 'subagent:project' : 'subagent:user',
      sessionId: null,
      ephemeral: false,
      projectLabel: '',
      workspacePath: ws,
      client,
      // The floor already knows the level; pass it so bus does not re-scan the disk by name.
      level: a.level,
    });
    // Ghosts can be restored before the poller scans the agent definitions. Mirror an already-live
    // summon; no state row is needed when the workstation is idle.
    if (ghostAlive(project, name)) markActive(name);
  }

  /**
   * A floor no longer finds this subagent: remove it (only if that floor is the one that claimed it).
   * @param {{meta?: {id?: string}}} floor
   * @param {string} name
   */
  function unregisterAgent(floor, name) {
    name = String(name || '').trim();
    if (!name) return;
    const project = getProject();
    const floorId = (floor && floor.meta && floor.meta.id) || '';
    const { mine, own, act } = state(project);
    if (!mine.has(name)) return;
    if (floorId && own.get(name) !== floorId) return; // a different floor owns this name
    try {
      bus.removeMember({ project, memberId: name });
    } catch {
      /* ignore */
    }
    mine.delete(name);
    own.delete(name);
    act.delete(name);
  }

  /**
   * Summoned: mark the resident workstation busy while a same-name ghost is working.
   */
  function markActive(name) {
    name = String(name || '').trim();
    if (!name) return;
    const project = getProject();
    const { act } = state(project);
    if (act.has(name)) return;
    act.add(name);
    writeBorrowedBusy(project, name, true);
  }

  /** Summon finished: clear the borrowed busy state so the resident workstation returns to idle. */
  function markIdle(name) {
    name = String(name || '').trim();
    if (!name) return;
    const project = getProject();
    const { act } = state(project);
    act.delete(name);
    writeBorrowedBusy(project, name, false);
  }

  function isDefined(name) {
    const mine = registered.get(getProject());
    return Boolean(mine && mine.has(String(name || '').trim()));
  }

  return {
    registerAgent,
    unregisterAgent,
    markActive,
    markIdle,
    isDefined,
    get defined() {
      const mine = registered.get(getProject());
      return mine ? [...mine] : [];
    },
  };
}

module.exports = { createAgentRoster };
