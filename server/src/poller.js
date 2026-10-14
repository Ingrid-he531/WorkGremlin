'use strict';

/**
 * Unified poller — the server's only periodic clock.
 *
 * Floor modules hold **no process / thread / timer**; they only export functions. This loop walks the
 * floor registry and owns all three periodic duties, each throttled on its own cadence:
 *   · session scan (2s)      — registrySnapshot(force): the full session table + phase, broadcast only on change;
 *   · floor task sync        — per floor `pollMs` (default 5s); floors opt in by exporting `syncTasks(ctx)`
 *                              (6F Qoder plugin / 7F Kilo / 8F OpenCode / 9F Copilot);
 *   · degraded sweep (10s)   — bus.sweepDegraded(): drop stale heartbeats.
 *
 * Everything floor-specific (shell schemas, "yield to the plugin" rules, phase inference) stays inside
 * the floor functions — this file contains no floor knowledge, and the server owns the single clock so
 * there is exactly one place that decides cadence, ordering and shutdown.
 *
 * Hook reporting is unaffected: it is a push path (POST /api/v1/hook etc.), not a poll.
 */

const { WS_EVENTS } = require('@workgremlin/shared');
const { snapshot: registrySnapshot } = require('./sessionRegistry');
const { taskSyncerFloors } = require('./floors');

/** Base tick. Duty cadences below are throttled against `now`, so this only bounds latency. */
const TICK_MS = 1_000;
const SESSION_SCAN_MS = 2_000;
const SWEEP_DEGRADED_MS = 10_000;
/** Default task-sync cadence when a floor does not declare `pollMs`. */
const DEFAULT_POLL_MS = 5_000;

/**
 * @param {{
 *   bus: object,
 *   repo: object,
 *   getWorkspace: () => { workspacePath?: string },
 *   broadcast?: (project: string|null, type: string, payload: any) => void,
 *   now?: () => number,
 *   getFloors?: () => Array<object>,
 *   snapshot?: (opts: { workspacePath: string, force: boolean }) => object,
 * }} deps
 */
function createPoller({
  bus,
  repo,
  getWorkspace,
  broadcast,
  now = () => Date.now(),
  getFloors = taskSyncerFloors,
  snapshot = registrySnapshot,
}) {
  const lastTaskAt = new Map();
  let lastSessionAt = 0;
  let lastSweepAt = 0;
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

  function tick() {
    const at = now();
    if (at - lastSessionAt >= SESSION_SCAN_MS) {
      lastSessionAt = at;
      try {
        scanSessions();
      } catch {
        /* A disk scan failure must not stall the loop. */
      }
    }
    syncFloorTasks(at);
    if (at - lastSweepAt >= SWEEP_DEGRADED_MS) {
      lastSweepAt = at;
      try {
        bus.sweepDegraded();
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

  return { start, stop, tick };
}

module.exports = { createPoller, TICK_MS, SESSION_SCAN_MS, SWEEP_DEGRADED_MS, DEFAULT_POLL_MS };
