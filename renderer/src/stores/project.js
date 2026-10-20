import { defineStore } from 'pinia';
import { getServerInfo, getWorkspace, openWorkspace, wsUrl, httpBase } from '../api/bridge';
import { createConnection } from '../api/ws';
import { WS_EVENTS } from '@workgremlin/shared';
import { memberBelongsToProject } from '../lib/projectScope';
import { normalizeState } from '../lib/memberTask';

/** Fallback reconcile interval: WS increment events (especially member.remove) are one-shot, so a missed one stays stale forever; this heals it */
const RECONCILE_MS = 15_000;

/** Workstation view + connection state (current project's members / ghosts / connection) */
export const useProjectStore = defineStore('project', {
  state: () => ({
    /** All projects (demo project and real projects side by side) */
    projects: [],
    /** Current project */
    project: null,
    /**
     * Current project id (the server's projects.id —— equals the project in the workspace response
     * and the project on a member card). Stored separately because the workspace response only gives the id string while the snapshot gives the whole row object, and both need to take part in filtering.
     * Empty string = not known yet (old server / workspace not fetched yet) → no filtering, see lib/projectScope.js.
     */
    projectId: '',
    members: [],
    /** Current project display name (resolved by the server: package.json name > directory name; the demo project has a fixed name) */
    projectName: '',
    /** Current project root directory (empty for the demo project) */
    workspacePath: '',
    /** Recently opened projects */
    recent: [],
    connection: { state: 'connecting', source: 'ws' },
    serverInfo: null,
    /** Currently parked on the demo project (demo in the server's workspace response, toggled by the demo mode button) */
    demo: false,
    /** Which project was open before entering demo: return here when leaving demo (the demo project has no directory of its own) */
    demoReturnPath: '',
    _conn: null,
    _reconcileTimer: null,
  }),

  getters: {
    /** Counts aggregated by state (for the top overview) */
    stateCounts: (s) =>
      s.members.reduce((acc, m) => {
        const state = normalizeState(m.state);
        acc[state] = (acc[state] || 0) + 1;
        return acc;
      }, {}),
  },

  actions: {
    async init(onMessage) {
      const info = await getServerInfo();
      this.serverInfo = info;
      this.projectName = info.projectName || '';

      const ws = await getWorkspace(info);
      if (ws) this.applyWorkspace(ws);

      this._conn = createConnection({
        url: wsUrl(info),
        token: info.token,
        project: null,
        // Re-ask the server info before every (re)connect: a server restart changes the token / port,
        // and reconnecting with the stale copy only gets kicked with bad_token over and over (see the notes in api/ws.js).
        resolve: () => this.resolveServerAuth(),
        onEvent: (msg) => {
          switch (msg.type) {
            case WS_EVENTS.SNAPSHOT:
              this.applySnapshot(msg.payload);
              break;
            case WS_EVENTS.MEMBER_STATUS:
              this.upsertMember(msg.payload);
              break;
            case WS_EVENTS.MEMBER_REMOVE:
              this.removeMember(msg.payload && msg.payload.memberId);
              break;
            default:
              if (onMessage) onMessage(msg);
          }
        },
        onState: (st) => {
          this.connection = st;
          // Subscribe once as soon as WS connects: registers filters and makes the server immediately
          // return the current state, so there is no need to wait for the next incremental push
          // before seeing members/gremlins (HELLO also returns a snapshot; this is an explicit extra pull).
          // Must be sent after HELLO —— the order is guaranteed by api/ws.js's open callback, and jumping ahead of HELLO gets kicked by the server as a bad token.
          if (st && st.state === 'open' && this._conn) this._conn.subscribe({});
        },
      });

      // Fallback reconcile: member.remove is a one-shot event, so after a missed one (WS jitter / window unfocused) that member
      // hangs in the office forever (member.status updates never delete). Periodically pull a snapshot
      // to realign everything, guaranteeing eventual consistency.
      this.stopReconcile();
      this._reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_MS);
    },

    /**
     * Auth resolution before every (re)connect.
     *
     * The Electron main process rereads ~/.workgremlin/server.json every time (see desktop/src/main.js's
     * GET_SERVER_INFO), so what we get here is the port and token of "this current server instance".
     * Once it differs from what is recorded locally (= the server restarted), swap serverInfo to the new one and realign the project info once;
     * every page's HTTP polling reads project.serverInfo, so it picks up the new token too (no more 401 all the way down).
     * @returns {Promise<{url: string, token: string, project: null}>}
     */
    async resolveServerAuth() {
      let info = this.serverInfo || {};
      try {
        const fresh = await getServerInfo();
        if (fresh && fresh.port) {
          const changed =
            Number(fresh.port) !== Number(info.port) || String(fresh.token || '') !== String(info.token || '');
          if (changed) {
            info = fresh;
            this.serverInfo = fresh;
            const ws = await getWorkspace(fresh);
            if (ws) this.applyWorkspace(ws);
          }
        }
      } catch {
        /* If server.json can't be read (or IPC is down), keep trying with the old copy; don't jam the connection */
      }
      return { url: wsUrl(info), token: info.token, project: null };
    },

    /** Pull a current snapshot and overwrite the local member table wholesale (self-healing: extra stale members get wiped by this overwrite) */
    async reconcile() {
      try {
        const info = this.serverInfo || {};
        const res = await fetch(`${httpBase(info)}/api/v1/snapshot`, {
          headers: info.token ? { Authorization: `Bearer ${info.token}` } : undefined,
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.ok && data.snapshot) this.applySnapshot(data.snapshot);
      } catch {
        /* If unreachable, leave it for the next cycle; incremental pushes are unaffected */
      }
    },

    stopReconcile() {
      if (this._reconcileTimer) clearInterval(this._reconcileTimer);
      this._reconcileTimer = null;
    },

    applySnapshot(snapshot) {
      this.project = snapshot.project;
      if (snapshot.project && snapshot.project.id) this.projectId = String(snapshot.project.id);
      this.projects = snapshot.projects || [];
      // The snapshot is already sliced by current project; filtering again here is just defensive (server swapped / an old snapshot slipped in)
      this.members = (snapshot.members || []).filter((m) => memberBelongsToProject(m, this.projectId));
      if (snapshot.projectName) this.projectName = snapshot.projectName;
    },

    /** @param {any} card */
    upsertMember(card) {
      if (!card) return;
      // Never accept a member card from another project: the WS subscription carries no project, so the server
      // may broadcast other projects' events here, and letting one in makes it flash in the room and then vanish.
      if (!memberBelongsToProject(card, this.projectId)) return;
      const idx = this.members.findIndex((m) => m.memberId === card.memberId);
      if (idx >= 0) this.members.splice(idx, 1, { ...this.members[idx], ...card });
      else this.members.push(card);
    },

    /** Temporary member (ghost) leaves the stage: the subagent is done, so it shouldn't keep hovering in the room */
    removeMember(memberId) {
      if (!memberId) return;
      const idx = this.members.findIndex((m) => m.memberId === memberId);
      if (idx >= 0) this.members.splice(idx, 1);
    },

    applyWorkspace(ws) {
      if (!ws) return;
      this.projectName = ws.projectName || '';
      this.workspacePath = ws.workspacePath || '';
      this.recent = Array.isArray(ws.recent) ? ws.recent : [];
      this.demo = Boolean(ws.demo);
      // Switching projects must immediately clear the previous project's people from the room: the server's new snapshot arrives **asynchronously** (broadcast within the same request),
      // and without filtering first the previous project's members keep standing at their workstations during that stretch —— the 8 demo gremlins when leaving demo
      // are the most visible instance (2026-10-01 user test: after leaving demo and switching floors they briefly appeared again).
      // When the new project id is unavailable (old server / response missing the field), don't swap projectId and don't filter, keep things as they are.
      if (ws.project) {
        this.projectId = String(ws.project);
        this.members = this.members.filter((m) => memberBelongsToProject(m, this.projectId));
      }
    },

    /**
     * Open a project: the room's members/ghosts all switch to this project. An empty path / 'demo' switches to the demo project.
     * The server broadcasts the new snapshot, so there is no need to pull it here.
     * @param {string} path
     */
    async openWorkspace(path) {
      const cur = await openWorkspace(this.serverInfo || {}, path);
      this.applyWorkspace(cur);
      return cur;
    },

    /**
     * Directory to return to when leaving demo: the one recorded before entering demo → the most recently opened → the one resolved at server start.
     * The demo project has no directory of its own (workspacePath empty), so it can't be the "address to go back to".
     */
    realPath() {
      if (this.workspacePath) return this.workspacePath;
      const hit = (this.recent || []).find((r) => r && r.path);
      if (hit) return hit.path;
      return (this.serverInfo && this.serverInfo.workspacePath) || '';
    },

    /**
     * Enter demo mode: switch to the "demo project" (POST /api/v1/workspace with an empty path → the server's openDemo).
     * The server readies the demo data and starts the demo task driver along the way (see server/src/index.js's syncDemo).
     *
     * Record "which project to return to on exit" first —— it must be captured **before switching away** (after switching into demo workspacePath is empty).
     */
    async enterDemo() {
      if (this.demo) return null;
      this.demoReturnPath = this.realPath();
      return this.openWorkspace('demo');
    },

    /** Leave demo: return to the real project opened before entering demo; if there is not a single real project, stay in demo */
    async exitDemo() {
      if (!this.demo) return null;
      const back = this.demoReturnPath || this.realPath();
      if (!back) return null;
      return this.openWorkspace(back);
    },

    dispose() {
      this.stopReconcile();
      if (this._conn) this._conn.close();
      this._conn = null;
    },
  },
});
