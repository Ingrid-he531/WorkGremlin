/**
 * sessions.js —— the renderer's global table of active sessions.
 *
 * The server (server/src/sessionRegistry.js) keeps a table of the active sessions across every
 * agent (floor) × every project, dropping a session after 60 minutes without an event. This store
 * only carries that table in and remembers which floor / session the user picked.
 *
 * Rules:
 *   - group by floor (floor list on the left + optgroup in the dropdown);
 *   - **the selected floor never moves on its own.** Only the user's own actions change it
 *     (riding the elevator, picking a floor, picking a session). A task starting on some other
 *     floor is not a reason to switch to it — that auto-follow was removed deliberately, so do not
 *     reintroduce it here;
 *   - the one exception is a floor that is gone: if the selected floor is no longer installed, fall
 *     back to the server-suggested floor, otherwise the user is left staring at a missing floor;
 *   - a floor with no active sessions still shows its office, just with an empty dropdown and a
 *     grey status dot;
 *   - the selected session decides what the main Agent console shows (the ghost state follows it);
 *     the office layout does not move.
 */

import { defineStore } from 'pinia';
import { httpBase } from '../api/bridge';
import { consolePhaseLabel } from '../iso/mainConsole';
import { t } from '../i18n/index.js';
import { useProjectStore } from './project';

const POLL_MS = 5_000;
/** The timer lives outside the store: it is not state */
let timer = null;

// Phase labels share their source with the main console (both the zh and en sets live in the i18n table) — do not keep a second copy here
const phaseLabel = (p) => consolePhaseLabel({ phase: p });
/**
 * The short id in the dropdown: **the first 8 chars of the session id**.
 * No longer guess a filename from the on-disk locator (`x.id`, which for CLI floors is the
 * transcript's relative path) —— the 3F Codex filename is
 * `rollout-<timestamp>-<session-id>.jsonl`, so the first 8 chars always yield `rollout-` and you
 * cannot tell who is who. The phase comes from the **session**, so the dropdown should show the session id too.
 */
const shortId = (sessionId) => String(sessionId || '').slice(0, 8);

export const useSessionStore = defineStore('sessions', {
  state: () => ({
    /** Floors: [{ id, name, installed, activeCount, sessions: [...] }] */
    floors: [],
    /** Active sessions across all floors (flat, in floor order) */
    sessions: [],
    selectedFloor: '',
    selectedId: '',
    /**
     * The user switched to a floor with **no active sessions**.
     * No one is working on this floor → the office must clear along with it (the people in the room,
     * the main console, and the conversation should not still be showing the previous project's);
     * once a session appears on this floor (or the user picks one) it automatically resets to false.
     * Only set on a user-initiated floor switch: on initial load / in demo mode, no sessions must not clear the office.
     */
    floorEmpty: false,
    /** The server-suggested floor (the first floor with active sessions) */
    defaultFloor: '',
    /** Why the table is empty: no-storage / no-open-project */
    reason: '',
    /** How long a session with no events survives before removal (ms) */
    timeoutMs: 60 * 60_000,
    loaded: false,
  }),

  getters: {
    /** The current floor's sessions */
    floorSessions: (s) => {
      const f = s.floors.find((x) => x.id === s.selectedFloor);
      return f ? f.sessions : [];
    },

    selected: (s) => s.sessions.find((x) => x.id === s.selectedId) || null,

    /**
     * The **session id** (axis 2) of the selected session — the `session_id`
     * carried in the agent's hook payload. The server scopes `/api/v1/reporter-phase`
     * by it, so multiple sessions on the same floor (two terminals, or CLI + plugin
     * mixed) each show their own live phase instead of "whoever is newest wins".
     *
     * This is distinct from `id`: `id` is the server-assigned session key the
     * renderer simply receives. How the server derives it (e.g. CLI jsonl path vs
     * plugin history id) is a server-side concern, not the renderer's. When the
     * server cannot resolve a session id it returns an empty string and falls back
     * to its legacy behavior.
     * @returns {string}
     */
    selectedSessionId: (s) => {
      const x = s.sessions.find((y) => y.id === s.selectedId);
      return (x && x.sessionId) || '';
    },

    /**
     * The clients the current floor accepts (the server's floors[].clients passed through as-is; the
     * identity is always the floor base name, e.g. 1F's ['codebuddy']).
     * /reporter-phase filters phases by it; the floor ↔ client mapping is authoritative in the server's
     * floors, so it is not repeated here.
     */
    selectedClients: (s) => {
      const f = s.floors.find((x) => x.id === s.selectedFloor);
      if (!f) return [];
      if (Array.isArray(f.clients) && f.clients.length) return f.clients;
      return f.client ? [f.client] : [];
    },

    /**
     * The current floor's client (= clients[0], the floor base name, e.g. codebuddy / kilo).
     * The office filters members/ghosts by it (the client on a member card is stamped by the server,
     * see the server's members.client) —— match by base name.
     */
    selectedClient: (s) => {
      const f = s.floors.find((x) => x.id === s.selectedFloor);
      return (f && f.client) || '';
    },

    /** Placeholder text when the dropdown has nothing to pick (decided by the current floor) */
    emptyLabel: (s) => (s.sessions.length === 0 ? t('session.empty_no_project') : t('session.empty_no_active')),

    /**
     * Dropdown options: list all active sessions of the **currently selected floor** directly (flat,
     * no floor headings, and no distinction of "another project" —— there is no concept of a "currently
     * open project" now, all sessions are treated the same).
     * Switching floors naturally swaps the set along with it.
     */
    options: (s) => {
      const f = s.floors.find((x) => x.id === s.selectedFloor);
      if (!f) return [];
      return f.sessions.map((x) => {
        // Source tag: the backend's source is already derived from form (plugin/cli/ide), use it as-is
        // plugin → Plugin-, cli → CLI-, ide → IDE-, empty → no prefix
        const src = String(x.source || '').toLowerCase();
        const tag = src === 'plugin' ? 'Plugin' : src === 'cli' ? 'CLI' : src === 'ide' ? 'IDE' : '';
        const proj = x.project || t('sessions.unknown_project');
        const body = tag ? `${tag}-${proj}` : proj;
        return {
          value: x.id,
          label: [body, shortId(x.sessionId)].filter(Boolean).join(' '),
          title: [x.projectPath || x.project || '', x.sessionId].filter(Boolean).join(' · '),
        };
      });
    },

    total: (s) => s.sessions.length,

    /**
     * Whether the selected session is worth treating as "live".
     * Only sessions in the **current project** that the **plugin still recognizes** (has a runtime) are live;
     * sessions from another project / with only fossil data show everyone in the room as offline (no invented state).
     * No session selected (empty dropdown) → leave the room's current display untouched.
     */
    live: (s) => {
      const x = s.sessions.find((y) => y.id === s.selectedId);
      return x ? Boolean(x.live) && Boolean(x.mine) : true;
    },
  },

  actions: {
    /** @param {{port?:number, token?:string, fallback?:boolean}} info */
    async refresh(info = {}) {
      try {
        const res = await fetch(`${httpBase(info)}/api/v1/sessions`, {
          headers: info && info.token ? { Authorization: `Bearer ${info.token}` } : undefined,
        });
        const data = await res.json();
        if (!data || !data.ok) return;
        this.applySnapshot(data);
      } catch {
        /* If the fetch fails, keep the previous list; do not flash the dropdown empty */
      }
    },

    /** Apply a session snapshot (shared by the HTTP poll and the live WS push), and fix up the selected floor / session */
    applySnapshot(data) {
      if (!data || !data.ok) return;
      this.floors = data.floors || [];
      this.sessions = data.sessions || [];
      this.defaultFloor = data.defaultFloor || '';
      this.reason = data.reason || '';
      if (Number(data.timeoutMs)) this.timeoutMs = Number(data.timeoutMs);
      this.loaded = true;

      // The only floor move this store makes on its own: the selected floor is **gone** (never seen,
      // or no longer installed) — without this the user is left staring at a floor that does not
      // exist. An installed floor that merely has no active sessions is NOT a reason to move; the
      // floor list still renders it and the user can stay there.
      const cur = this.floors.find((f) => f.id === this.selectedFloor);
      if (!cur || !cur.installed) {
        this.selectedFloor = this.defaultFloor || this.floors.find((f) => f.installed)?.id || '';
      }

      // The selected session dropped (timed out / floor changed): pick a new one on the current floor
      const list = this.floorSessions;
      if (this.selectedId && !list.some((x) => x.id === this.selectedId)) this.selectedId = '';
      if (!this.selectedId && list.length) {
        // current is already the "globally unique" current session (the one in the current truly active project), prefer it
        const pick = list.find((x) => x.current) || list[0];
        this.selectedId = pick.id;
      }
      // This floor finally has sessions (it was empty before) → the office returns to normal display
      if (this.selectedId) this.floorEmpty = false;
    },

    /** Select a session: the floor follows it (sessions are already grouped by floor) */
    select(id) {
      this.selectedId = id || '';
      this.floorEmpty = false;
      const s = this.sessions.find((x) => x.id === this.selectedId);
      if (s && s.floor) this.selectedFloor = s.floor;
    },

    /**
     * Switch floor: the dropdown swaps along with it; **when this floor has no active sessions the office
     * clears as well** —— no one is working on that floor, and if the room still held the previous
     * project's gremlins while the previous project's name hung on top, it would look like the switch
     * never happened (session / project / conversation all still from the previous floor).
     */
    selectFloor(id) {
      this.selectedFloor = id || '';
      const list = this.floorSessions;
      const pick = list.find((x) => x.current) || list[0];
      this.selectedId = pick ? pick.id : '';
      this.floorEmpty = !this.selectedId;
    },

    /**
     * @param {{port?:number, token?:string, fallback?:boolean}} info only used as the first-round fallback
     *
     * Do not **freeze the info captured at startup into the closure**: the server swaps its token on
     * restart (see api/ws.js), and a poll frozen on the old token then 401s forever, leaving the UI
     * stuck on stale data and no longer updating
     * (observed: a running task never reappears in the task/session tables). So take the current serverInfo every round.
     */
    startPolling(info = {}) {
      this.stopPolling();
      const fallback = info;
      timer = setInterval(() => this.refresh(useProjectStore().serverInfo || fallback), POLL_MS);
    },

    stopPolling() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  },
});
