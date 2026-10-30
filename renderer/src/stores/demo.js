/**
 * demo.js —— renderer-side lifecycle of the read-only virtual demo session.
 *
 * The backend owns the demo roster, messages and phase (server/src/demo/provider.js). This store
 * only:
 *   1. starts / stops the in-memory demo on the current floor;
 *   2. installs the virtual session into the ordinary sessions table (so the dropdown, floor
 *      filtering, member cards and sprites behave exactly like a real session);
 *   3. keeps the live demo snapshot / members in its own state. The real project store is **not**
 *      overwritten: task records and the conversation log keep reading real
 *      data while the office / workstation views opt into `demo.members`;
 *   4. restores the previous real session when demo mode exits.
 *
 * Demo rows are never persisted, so nothing here survives a page reload or a server restart.
 */

import { defineStore } from 'pinia';
import { getDemoSession, startDemoSession, stopDemoSession } from '../api/bridge';
import { useProjectStore } from './project';
import { useSessionStore } from './sessions';

const POLL_MS = 1_500;
/** The timer lives outside Pinia state: it is a runtime resource, not serializable data */
let timer = null;
let inFlight = false;
/** Serializes exit so a fast re-enter cannot be deleted by the previous exit's in-flight DELETE */
let exitPromise = null;

export const useDemoStore = defineStore('demo', {
  state: () => ({
    active: false,
    loading: false,
    error: '',
    /** Floor + virtual session id currently owned by this demo */
    floor: '',
    sessionId: '',
    /** Latest server-built session row (phase / action / task state are refreshed by polling) */
    session: null,
    /** Initial snapshot (the virtual project + recent messages) */
    snapshot: null,
    /** Live member cards for the demo project; consumed only by the office / workstation views */
    members: [],
    /** What to restore when demo exits (only if the user has not switched floors in the meantime) */
    returnFloor: '',
    returnSessionId: '',
  }),

  actions: {
    /** Start demo mode on a floor (or restart it if it is already active). */
    async enter(floor) {
      const target = String(floor || '').trim();
      if (!target) throw new Error('no floor selected');
      // A click during the previous exit must wait for its DELETE before starting a new demo on
      // the same floor; otherwise the late DELETE would drop the newly created in-memory state.
      if (exitPromise) await exitPromise;
      if (this.active) await this.exit({ restore: false });
      if (this.loading) return;

      const project = useProjectStore();
      const sessions = useSessionStore();
      this.returnFloor = sessions.selectedFloor;
      this.returnSessionId = sessions.selectedId;
      this.loading = true;
      this.error = '';
      try {
        const data = await startDemoSession(project.serverInfo || {}, target);
        if (!data || !data.session || !data.snapshot) throw new Error('invalid demo response');
        this.active = true;
        this.floor = data.session.floor || target;
        this.sessionId = data.session.id;
        this.session = data.session;
        this.snapshot = data.snapshot;
        this.members = Array.isArray(data.snapshot.members) ? data.snapshot.members : [];

        // The real project store deliberately stays untouched: the demo snapshot is display-only
        // office data. Sessions are the only global table that receives the virtual row.
        sessions.setVirtualSession(data.session);
        sessions.select(data.session.id);
        this.startPolling();
        return data;
      } catch (err) {
        this.active = false;
        this.session = null;
        this.snapshot = null;
        this.members = [];
        sessions.removeVirtualSession();
        this.error = String((err && err.message) || err || 'cannot start demo');
        throw err;
      } finally {
        this.loading = false;
      }
    },

    /** Toggle from the HUD; the current floor decides where the demo runs. */
    async toggle(floor) {
      if (this.active) return this.exit({ restore: true });
      return this.enter(floor);
    },

    /**
     * Leave demo mode.
     * @param {{restore?: boolean, silent?: boolean}} [opts]
     * restore=false is used when the page is going away: no need to refetch the real state.
     */
    async exit(opts = {}) {
      if (exitPromise) return exitPromise;
      if (!this.active && !this.session && !this.sessionId) return;
      exitPromise = this._exit(opts).finally(() => {
        exitPromise = null;
      });
      return exitPromise;
    },

    /** The actual exit body; callers must go through exit() so concurrent calls share one DELETE. */
    async _exit(opts = {}) {
      const { restore = true, silent = false } = opts;
      if (!this.active && !this.session && !this.sessionId) return;
      const floor = this.floor;
      const project = useProjectStore();
      const sessions = useSessionStore();

      this.stopPolling();
      this.active = false;
      this.floor = '';
      this.sessionId = '';
      this.session = null;
      this.snapshot = null;
      this.members = [];
      sessions.removeVirtualSession();

      // The server state is memory-only; drop it so a later GET cannot revive an old demo.
      if (floor) await stopDemoSession(project.serverInfo || {}, floor);
      if (!restore) return;

      // The real project store never left the real data, so this only heals any gap that opened
      // while the demo was running. Then refresh the real session table; the demo session is
      // already removed, so refresh() cannot re-inject it.
      try {
        await project.reconcile();
      } catch {
        /* Keep the last real state if the server is momentarily unavailable */
      }
      await sessions.refresh(project.serverInfo || {});

      // Only restore the previous session if the user did not switch floors while demo was active.
      if (this.returnSessionId && sessions.selectedFloor === this.returnFloor) {
        const back = sessions.sessions.find((x) => x.id === this.returnSessionId);
        if (back) sessions.select(back.id);
      }
      // No real session left on this floor: treat it like a normal empty-floor switch so the
      // console returns to standby instead of showing the demo round's "done" summary.
      if (!sessions.selectedId) sessions.floorEmpty = true;
      if (!silent) this.error = '';
      this.returnFloor = '';
      this.returnSessionId = '';
    },

    startPolling() {
      this.stopPolling();
      timer = setInterval(() => this.poll(), POLL_MS);
      // Do not wait for the first interval: the initial snapshot already has a phase, but an
      // immediate pull also catches a server-side restart quickly.
      this.poll();
    },

    stopPolling() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    async poll() {
      if (!this.active || inFlight) return;
      const project = useProjectStore();
      const sessions = useSessionStore();
      const floor = this.floor;
      const sessionId = this.sessionId;
      if (!floor || !sessionId) return;
      inFlight = true;
      try {
        const data = await getDemoSession(project.serverInfo || {}, floor, sessionId);
        // Exit may have raced the request; never let an old response revive demo state.
        if (!this.active || this.floor !== floor || this.sessionId !== sessionId) return;
        if (!data || !data.session) return;
        this.session = data.session;
        this.members = Array.isArray(data.members) ? data.members : [];
        this.snapshot = this.snapshot
          ? { ...this.snapshot, members: this.members, serverTime: Date.now() }
          : this.snapshot;
        sessions.updateVirtualSession(data.session);
      } catch (err) {
        const msg = String((err && err.message) || err || '');
        // The in-memory demo disappears on a server restart; leave demo and restore the real view.
        // A transient fetch failure is kept as an error and retried on the next tick.
        if (/not active|HTTP 404/i.test(msg)) {
          await this.exit({ restore: true, silent: true });
        } else {
          this.error = msg;
        }
      } finally {
        inFlight = false;
      }
    },

    /** Page teardown: stop timers and best-effort delete the in-memory demo. */
    dispose() {
      this.stopPolling();
      if (this.active) this.exit({ restore: false });
    },
  },
});
