'use strict';

/**
 * Unified poller — the server's only periodic clock.
 *
 * Floor modules hold **no process / thread / timer**; they only export functions. This loop walks the
 * floor registry and owns all periodic duties, each throttled on its own cadence:
 *   · session scan (2s)      — registrySnapshot(force): the full session table + phase, broadcast only on change;
 *                              after a successful scan, cancel top-level running tasks with no active session;
 *   · floor task sync        — per floor `pollMs` (default 5s); floors opt in by exporting `syncTasks(ctx)`
 *                              (6F Qoder plugin / 7F Kilo / 8F OpenCode / 9F Copilot);
 *   · floor agent sync       — per floor `agentsPollMs` (default 15s); floors opt in by exporting
 *                              `syncAgents(ctx)`; the floor scans its OWN agent dirs and registers the
 *                              changes through the upper layer's register / unregister callbacks;
 *   · ghost GC (2s)          — bus.gcGhosts(): disperse subagent ghosts whose parent task ended, or
 *                              that outlived the orphan TTL while no running parent vouches for them.
 *
 * Everything floor-specific (store schemas, "yield to the plugin" rules, phase inference, which dirs
 * hold agents) stays inside the floor functions — this file contains no floor knowledge, and the
 * server owns the single clock so there is exactly one place that decides cadence, ordering and
 * shutdown. Hook reporting is unaffected: it is a push path (POST /api/v1/hook etc.), not a poll.
 */

const { WS_EVENTS } = require('@workgremlin/shared');
const { snapshot: registrySnapshot, getActiveSessionIds: registryActiveSessionIds } = require('./sessionRegistry');
const { taskSyncerFloors, agentSyncerFloors } = require('./floors');

/** Base tick. Duty cadences below are throttled against `now`, so this only bounds latency. */
const TICK_MS = 1_000;
const SESSION_SCAN_MS = 2_000;
/** Default task-sync cadence when a floor does not declare `pollMs`. */
const DEFAULT_POLL_MS = 5_000;
/** Default agent-sync cadence when the caller does not declare `agents.pollMs`. */
const DEFAULT_AGENT_POLL_MS = 15_000;
/** Ghost GC cadence: disperse summons whose parent task ended or that outlived the orphan TTL. */
const GHOST_GC_MS = 2_000;

/**
 * @param {{
 *   bus: object,
 *   repo: object,
 *   getWorkspace: () => { workspacePath?: string, project?: string, projectName?: string },
 *   broadcast?: (project: string|null, type: string, payload: any) => void,
 *   now?: () => number,
 *   getFloors?: () => Array<object>,
 *   getAgentFloors?: () => Array<object>,
 *   snapshot?: (opts: { workspacePath: string, force: boolean }) => object,
 *   getActiveSessionIds?: () => Iterable<string>,
 *   agents?: { registerAgent: (floor: object, a: object) => void,
 *              unregisterAgent: (floor: object, name: string) => void,
 *              pollMs?: number } | null,
 * }} deps
 */
function createPoller({
  bus,
  repo,
  getWorkspace,
  broadcast,
  now = () => Date.now(),
  getFloors = taskSyncerFloors,
  getAgentFloors = agentSyncerFloors,
  snapshot = registrySnapshot,
  getActiveSessionIds = registryActiveSessionIds,
  agents = null,
}) {
  const lastTaskAt = new Map();
  const lastAgentsAt = new Map();
  let lastSessionAt = 0;
  let lastGhostAt = 0;
  let lastSessionSig = '';
  let timer = null;

  /** Session table + phase for every floor; broadcast only when the active-session set actually changed. */
  function scanSessions() {
    const cur = (getWorkspace && getWorkspace()) || {};
    const snap = snapshot({ workspacePath: cur.workspacePath || '', force: true });
    const sig = JSON.stringify({
      d: snap.defaultFloor,
      f: snap.floors.map((f) => [f.id, f.activeCount, f.installed ? 1 : 0]),
      s: snap.sessions.map((x) => [x.floor, x.id, x.active ? 1 : 0, x.lastEventAt]),
    });
    if (sig !== lastSessionSig) {
      lastSessionSig = sig;
      if (broadcast) broadcast(null, WS_EVENTS.SESSIONS, snap);
    }
  }

  /** Write the task ledger for every polling floor, each on its own `pollMs`. */
  function syncFloorTasks(at) {
    for (const f of getFloors()) {
      const id = f.meta ? f.meta.id : f;
      const ms = Number(f.pollMs) > 0 ? Number(f.pollMs) : DEFAULT_POLL_MS;
      if (at - (lastTaskAt.get(id) || 0) < ms) continue;
      lastTaskAt.set(id, at);
      try {
        f.syncTasks({ bus, repo, now });
      } catch {
        /* One floor's local store may be missing or locked → skip it this round, never stall the loop. */
      }
    }
  }

  /**
   * Let every floor scan its own agent dirs and register the changes through the upper layer. The floor
   * gets the server's default workspace (id + display name + path) and the register / unregister
   * callbacks; the server keeps no per-product agent knowledge. This default is a polling fallback,
   * not the project a client is viewing (the office filters cards by the selected session).
   */
  function syncFloorAgents(at) {
    const cur = (getWorkspace && getWorkspace()) || {};
    const ms = Number(agents.pollMs) > 0 ? Number(agents.pollMs) : DEFAULT_AGENT_POLL_MS;
    for (const f of getAgentFloors()) {
      const id = f.meta ? f.meta.id : f;
      if (at - (lastAgentsAt.get(id) || 0) < ms) continue;
      lastAgentsAt.set(id, at);
      try {
        f.syncAgents({
          project: cur.project,
          projectName: cur.projectName,
          workspacePath: cur.workspacePath,
          registerAgent: (a) => agents.registerAgent(f, a),
          unregisterAgent: (name) => agents.unregisterAgent(f, name),
        });
      } catch {
        /* One floor's dir scan failing must not stall the others. */
      }
    }
  }

  /** Run the agent sync now, ignoring the cadence (tests / an explicit refresh). */
  function syncAgentsNow() {
    if (!agents) return;
    lastAgentsAt.clear();
    syncFloorAgents(now());
  }

  function tick() {
    const at = now();
    if (at - lastSessionAt >= SESSION_SCAN_MS) {
      lastSessionAt = at;
      let scanned = false;
      try {
        scanSessions();
        scanned = true;
      } catch {
        /* A disk scan failure must not stall the loop or trigger destructive reconciliation. */
      }
      if (scanned && typeof bus.reconcileRunningTasksWithActiveSessions === 'function') {
        try {
          bus.reconcileRunningTasksWithActiveSessions({
            activeSessionIds: getActiveSessionIds(),
            now: at,
          });
        } catch {
          /* Reconciliation is retried on the next successful session scan. */
        }
      }
    }
    syncFloorTasks(at);
    if (agents) syncFloorAgents(at);
    if (at - lastGhostAt >= GHOST_GC_MS) {
      lastGhostAt = at;
      try {
        if (typeof bus.gcGhosts === 'function') bus.gcGhosts();
      } catch {
        /* ignore */
      }
    }
  }

  /** Run one tick immediately, then keep ticking; returns the (unref'ed) timer. */
  function start() {
    tick();
    timer = setInterval(tick, TICK_MS);
    if (timer.unref) timer.unref();
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, syncAgentsNow };
}

module.exports = { createPoller, TICK_MS, SESSION_SCAN_MS, DEFAULT_POLL_MS, DEFAULT_AGENT_POLL_MS };
