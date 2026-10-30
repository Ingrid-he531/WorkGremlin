import { defineStore } from 'pinia';
import { getServerInfo, getWorkspace, wsUrl, httpBase } from '../api/bridge';
import { createConnection } from '../api/ws';
import { WS_EVENTS } from '@workgremlin/shared';
import { memberBelongsToProject, sameWorkspacePath } from '../lib/projectScope';
import { normalizeState } from '../lib/memberTask';

/** Fallback reconcile interval: WS increment events (especially member.remove) are one-shot, so a missed one stays stale forever; this heals it */
const RECONCILE_MS = 15_000;

/** Office view + connection state (the selected session's project members / ghosts / WS) */
export const useProjectStore = defineStore('project', {
  state: () => ({
    /** All real projects (the virtual demo project lives in stores/demo.js, not here) */
    projects: [],
    /** Current project */
    project: null,
    /**
     * Current project id (the server's projects.id —— equals the project in the workspace response
     * and the project on a member card). Stored separately because the workspace response only gives the id string while the snapshot gives the whole row object, and both need to take part in filtering.
     * Empty string = not known yet (old server / workspace not fetched yet) → no filtering, see lib/projectScope.js.
     */
    projectId: '',
    /**
     * The selected session names a project the server has no row for (a workspace opened without a
     * folder, a deleted project, …). The room is deliberately empty then: keeping the previous
     * project's gremlins would show another project's people under this session. This flag also keeps
     * global snapshots / member broadcasts from repopulating the room until a real project is selected.
     */
    projectUnresolved: false,
    members: [],
    /** Current real project display name (resolved by the server: package.json name > directory name) */
    projectName: '',
    /** Current real project root directory */
    workspacePath: '',
    connection: { state: 'connecting', source: 'ws' },
    serverInfo: null,
    _conn: null,
    /** Project already requested from the WS; avoids re-subscribing on every 5s session poll */
    _subscribedProjectId: '',
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
          if (st && st.state === 'open' && this._conn) {
            this._subscribedProjectId = this.projectId ? String(this.projectId) : '';
            this._conn.subscribe({}, this.projectId || undefined);
          }
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
        // Reconcile the project the office is actually showing (the selected session's project), not
        // the server's default workspace.
        const q = this.projectId ? `?project=${encodeURIComponent(this.projectId)}` : '';
        const res = await fetch(`${httpBase(info)}/api/v1/snapshot${q}`, {
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

    applySnapshot(snapshot, opts = {}) {
      if (!snapshot) return;
      // A session whose project has no row keeps an empty room: a global snapshot (or the periodic
      // reconcile of the empty project) must not pull the default project's gremlins back in.
      if (this.projectUnresolved && !opts.force) {
        this.projects = snapshot.projects || this.projects;
        return;
      }
      // A global workspace switch (another client, an explicit API call) must not steal the project
      // this client is showing: project follows the selected session. Keep the project list fresh,
      // but leave members/messages alone unless the snapshot is for the viewed project.
      if (
        !opts.force &&
        this.projectId &&
        (!snapshot.project || String(snapshot.project.id) !== String(this.projectId))
      ) {
        this.projects = snapshot.projects || this.projects;
        return;
      }
      this.projectUnresolved = false;
      this.project = snapshot.project;
      if (snapshot.project && snapshot.project.id) this.projectId = String(snapshot.project.id);
      this.projects = snapshot.projects || [];
      // The snapshot is already sliced by the viewed project; filtering again here is just defensive (server swapped / an old snapshot slipped in)
      this.members = (snapshot.members || []).filter((m) => memberBelongsToProject(m, this.projectId));
      if (snapshot.projectName) this.projectName = snapshot.projectName;
      // Keep the real workspace path in sync: the next project open uses it.
      if (snapshot.project && Object.prototype.hasOwnProperty.call(snapshot.project, 'workspacePath')) {
        this.workspacePath = snapshot.project.workspacePath || '';
      }
    },

    /** @param {any} card */
    upsertMember(card) {
      if (!card) return;
      // The room is showing "this session's project does not exist"; a broadcast from any real
      // project must not put gremlins into it.
      if (this.projectUnresolved) return;
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
      // Switching projects must immediately clear the previous project's people from the room: the server's new snapshot arrives **asynchronously** (broadcast within the same request),
      // and without filtering first the previous project's members keep standing at their workstations during that stretch.
      // When the new project id is unavailable (old server / response missing the field), don't swap projectId and don't filter, keep things as they are.
      if (ws.project) {
        this.projectId = String(ws.project);
        this.projectUnresolved = false;
        this.members = this.members.filter((m) => memberBelongsToProject(m, this.projectId));
      }
    },

    /**
     * Show the office of one selected session's project **locally**.
     *
     * Project is not a user-managed, server-global state: the session already carries its
     * workspace path, so this only loads that project's members/messages into this client. It must
     * never change the server's default workspace — that would affect every other connected client.
     *
     * @param {{projectPath?: string}|null} session
     * @returns {Promise<boolean>} whether a concrete project was found and applied
     */
    async followSession(session) {
      const projectPath = String((session && session.projectPath) || '').trim();
      if (!projectPath) return false;
      // Never jump away from the project already on screen when it points at the same directory.
      // Several rows can claim one workspace path (a historical duplicate), and switching to a
      // sibling row would swap the roster for that row's fragment: resident gremlins disappear or
      // lose their level badges (grey neck badges).
      const current = this.projects.find((p) => String(p.id) === String(this.projectId));
      if (current && sameWorkspacePath(current.workspacePath, projectPath)) {
        this.projectUnresolved = false;
        this.subscribeProject(current.id);
        return true;
      }
      // Prefer the original row among same-path duplicates: the canonical project is the oldest one,
      // the suffixed clones are newer fragments (see the server's projectByWorkspace).
      const matches = this.projects.filter((p) => sameWorkspacePath(p.workspacePath, projectPath));
      const target = matches
        .slice()
        .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))[0] || null;
      // Unknown to the local list (a project without a row yet): let the server resolve the path.
      const result = await this.loadProject(target ? target.id : projectPath);
      if (result === 'no-project') this.showUnresolvedProject(projectPath);
      return result === true;
    },

    /**
     * The selected session's project has no row on the server: empty the room instead of leaving the
     * previous project's people standing in it. The project label still comes from the session itself,
     * so the dropdown keeps naming the (possibly unknown) project.
     * @param {string} projectPath the path the session carries
     */
    showUnresolvedProject(projectPath = '') {
      this.project = null;
      this.projectId = '';
      this.projectUnresolved = true;
      this.members = [];
      this.projectName = '';
      this.workspacePath = String(projectPath || '');
      // No real project is being viewed: clear the subscription bookkeeping so selecting a project
      // again re-subscribes. The server keeps its previous filter, but member cards are dropped by
      // the `projectUnresolved` guard in upsertMember.
      this._subscribedProjectId = '';
    },

    /**
     * Load one project's snapshot into this client only; no server-side workspace switch.
     * @returns {Promise<true|false|'no-project'>} true = applied; 'no-project' = the server answered
     *   but owns no row for this path; false = transient failure (keep the current room)
     */
    async loadProject(projectIdOrPath) {
      const key = String(projectIdOrPath || '').trim();
      if (!key) return false;
      const info = this.serverInfo || {};
      try {
        const res = await fetch(`${httpBase(info)}/api/v1/snapshot?project=${encodeURIComponent(key)}`, {
          headers: info.token ? { Authorization: `Bearer ${info.token}` } : undefined,
        });
        const data = await res.json();
        if (!res.ok || !data || !data.ok || !data.snapshot) return false;
        // A resolved request with no project: the path is not a project the server knows (it
        // deliberately does not fall back to the default workspace for an explicit path).
        if (!data.snapshot.project) return 'no-project';
        this.applySnapshot(data.snapshot, { force: true });
        this.subscribeProject(data.snapshot.project.id);
        return true;
      } catch {
        return false;
      }
    },

    /** Scope live member events to the project the office is showing. */
    subscribeProject(projectId) {
      const id = projectId ? String(projectId) : '';
      if (this._subscribedProjectId === id) return;
      this._subscribedProjectId = id;
      if (this._conn) this._conn.subscribe({}, id || undefined);
    },

    dispose() {
      this.stopReconcile();
      if (this._conn) this._conn.close();
      this._conn = null;
      this._subscribedProjectId = '';
    },
  },
});
