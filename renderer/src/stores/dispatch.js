import { defineStore } from 'pinia';
import { httpBase } from '../api/bridge';

function authHeaders(info) {
  return info && info.token ? { Authorization: `Bearer ${info.token}` } : undefined;
}

/** @param {any[]} list @param {any} item */
function upsertById(list, item) {
  const idx = list.findIndex((x) => x && x.id === item.id);
  if (idx >= 0) list.splice(idx, 1, { ...list[idx], ...item });
  else list.unshift(item);
}

/** Keep the transcript bounded on the client too (the server keeps the last 200 KB per turn) */
const CLIENT_OUTPUT_MAX = 400 * 1024;
/** Remember which session this window had open, so reopening the app resumes the same conversation */
const LAST_SESSION_KEY = 'workgremlin.dispatch.lastSession';

function readLastSession() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(LAST_SESSION_KEY) || '' : '';
  } catch {
    return '';
  }
}

function writeLastSession(id) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (id) localStorage.setItem(LAST_SESSION_KEY, id);
    else localStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    /* private mode / quota: sessions still work, just no resume */
  }
}

/**
 * Remote dispatch: long-running **sessions** on the server machine.
 *
 * Two data sources, like the council:
 *   · HTTP — session list / transcript (authoritative after a refresh);
 *   · WS `dispatch.update` — session created, turn state changed, streamed output chunks.
 * The store never writes the office/ledger: the spawned CLI is a normal session there.
 */
export const useDispatchStore = defineStore('dispatch', {
  state: () => ({
    /** off | auto | confirm (server policy; not editable from here) */
    mode: 'off',
    /** [{ id, available }] */
    floors: [],
    /** Model references for the per-turn picker (e.g. opencode-go/deepseek-v4.1-flash) */
    models: [],
    /** id -> human label (Claude's model picker); empty for floors without labels */
    modelLabels: {},
    /** Why the catalog could not be read; the picker still offers "default model" */
    modelsError: '',
    /** Session summaries, newest first */
    sessions: [],
    /** Currently open session id + its full transcript */
    currentId: '',
    current: null,
    /** Turns waiting for a server-side decision, across sessions: [{ turn, session }] */
    pendingTurns: [],
    /** Whether this window may approve (server-side loopback check) */
    canApprove: false,
    /** Server config path (sent only to the server machine) */
    configFile: '',
    loaded: false,
    loading: false,
    error: '',
  }),

  getters: {
    /** The first request that needs a decision on this machine */
    pending: (s) => s.pendingTurns[0] || null,
    /** The active turn of the current session (pending/running) */
    activeTurn: (s) =>
      (s.current && s.current.turns.find((t) => t.state === 'pending' || t.state === 'running')) || null,
    availableFloors: (s) => s.floors.filter((f) => f.available),
  },

  actions: {
    /** @param {{token?: string}|null} info */
    async refresh(info) {
      this.loading = true;
      this.error = '';
      try {
        const res = await fetch(`${httpBase(info)}/api/v1/dispatch`, { headers: authHeaders(info) });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
        this.mode = data.mode || 'off';
        this.floors = data.floors || [];
        this.sessions = data.sessions || [];
        this.canApprove = Boolean(data.canApprove);
        this.configFile = data.configFile || '';
        this.loaded = true;

        if (!this.currentId && this.sessions.length) {
          const saved = readLastSession();
          this.currentId = this.sessions.some((s) => s.id === saved) ? saved : this.sessions[0].id;
        }
        if (this.currentId && this.sessions.some((s) => s.id === this.currentId)) {
          await this.open(info, this.currentId);
        } else {
          this.currentId = '';
          this.current = null;
        }
      } catch (err) {
        this.error = (err && err.message) || String(err);
      } finally {
        this.loading = false;
      }
    },

    /**
     * Load one session's full transcript.
     * @param {{token?: string}|null} info
     * @param {string} id
     */
    async open(info, id) {
      this.currentId = id;
      this.current = null;
      this.error = '';
      writeLastSession(id);
      try {
        const res = await fetch(`${httpBase(info)}/api/v1/dispatch/sessions/${encodeURIComponent(id)}`, {
          headers: authHeaders(info),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
        this.current = data.session;
        upsertById(this.sessions, data.session);
        this.rebuildPending();
      } catch (err) {
        this.error = (err && err.message) || String(err);
      }
    },

    /**
     * @param {{token?: string}|null} info
     * @param {{floor: string, workspacePath: string, permission?: string, model?: string}} payload
     */
    async createSession(info, payload) {
      this.error = '';
      const res = await fetch(`${httpBase(info)}/api/v1/dispatch/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authHeaders(info) || {}) },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      upsertById(this.sessions, data.session);
      this.currentId = data.session.id;
      this.current = { ...data.session, turns: [] };
      writeLastSession(data.session.id);
      return data.session;
    },

    /**
     * Load the floor's model catalog for the composer picker.
     * @param {{token?: string}|null} info
     * @param {string} [floor] defaults to the first available floor
     */
    async loadModels(info, floor) {
      const f = String(floor || (this.availableFloors[0] && this.availableFloors[0].id) || '8F');
      this.modelsError = '';
      try {
        const res = await fetch(`${httpBase(info)}/api/v1/dispatch/models?floor=${encodeURIComponent(f)}`, {
          headers: authHeaders(info),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
        this.models = Array.isArray(data.models) ? data.models : [];
        this.modelLabels = data.labels && typeof data.labels === 'object' ? data.labels : {};
        this.modelsError = data.error || '';
      } catch (err) {
        this.models = [];
        this.modelLabels = {};
        this.modelsError = (err && err.message) || String(err);
      }
    },

    /**
     * Send one prompt into the current session. 202 = parked for server-side approval.
     * @param {{token?: string}|null} info
     * @param {string} prompt
     * @param {string} [model] per-turn model override; empty = the floor's default
     * @param {string} [permission] per-turn permission override; empty = the session/default
     */
    async sendTurn(info, prompt, model, permission) {
      if (!this.currentId) throw new Error('no session');
      this.error = '';
      const sessionId = this.currentId;
      const res = await fetch(
        `${httpBase(info)}/api/v1/dispatch/sessions/${encodeURIComponent(sessionId)}/turns`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(authHeaders(info) || {}) },
          body: JSON.stringify({ prompt, model: model || '', permission: permission || '' }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      // Do not merge the possibly stale summary from before the request; WS sends the updated one.
      this.applyTurn(sessionId, data.turn, null);
      return data.turn;
    },

    /**
     * @param {{token?: string}|null} info
     * @param {string} turnId
     * @param {boolean} approve
     */
    async decide(info, turnId, approve) {
      const res = await fetch(`${httpBase(info)}/api/v1/dispatch/turns/${encodeURIComponent(turnId)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authHeaders(info) || {}) },
        body: JSON.stringify({ approve: Boolean(approve) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      const pair = this.pendingTurns.find((p) => p.turn.id === turnId);
      this.applyTurn(pair ? pair.session.id : this.currentId, data.turn, null);
      return data.turn;
    },

    /**
     * @param {{token?: string}|null} info
     * @param {string} turnId
     */
    async cancelTurn(info, turnId) {
      const pair = this.pendingTurns.find((p) => p.turn.id === turnId);
      const sessionId = pair ? pair.session.id : this.currentId;
      const res = await fetch(`${httpBase(info)}/api/v1/dispatch/turns/${encodeURIComponent(turnId)}`, {
        method: 'DELETE',
        headers: authHeaders(info),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      this.applyTurn(sessionId, data.turn, null);
      return data.turn;
    },

    /**
     * @param {{token?: string}|null} info
     * @param {string} id
     */
    async deleteSession(info, id) {
      const res = await fetch(`${httpBase(info)}/api/v1/dispatch/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: authHeaders(info),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      this.sessions = this.sessions.filter((s) => s.id !== id);
      this.pendingTurns = this.pendingTurns.filter((p) => p.session.id !== id);
      if (this.currentId === id) {
        this.currentId = this.sessions.length ? this.sessions[0].id : '';
        this.current = null;
        if (this.currentId) await this.open(info, this.currentId);
        else writeLastSession('');
      }
      return data;
    },

    /**
     * Merge one turn (from HTTP or WS) into the current transcript and the pending queue.
     * @param {string} sessionId
     * @param {any} turn
     * @param {any} [session]
     */
    applyTurn(sessionId, turn, session) {
      if (session) upsertById(this.sessions, session);
      const listSession = this.sessions.find((s) => s.id === sessionId);
      if (this.current && this.current.id === sessionId) {
        const idx = this.current.turns.findIndex((t) => t.id === turn.id);
        if (idx >= 0) this.current.turns.splice(idx, 1, { ...this.current.turns[idx], ...turn });
        else this.current.turns.push(turn);
        if (listSession) {
          this.current.state = listSession.state;
          this.current.title = listSession.title || this.current.title;
          this.current.updatedAt = listSession.updatedAt;
        }
      }
      // Keep the (small) pending queue accurate even for sessions that are not open
      this.pendingTurns = this.pendingTurns.filter((p) => p.turn.id !== turn.id);
      if (turn.state === 'pending' && session) this.pendingTurns.push({ turn, session });
      if (turn.state === 'pending' && !session && listSession) {
        this.pendingTurns.push({ turn, session: listSession });
      }
    },

    /** Recompute the pending queue from the open transcript (used after a full refresh). */
    rebuildPending() {
      const known = new Set(this.pendingTurns.map((p) => p.turn.id));
      if (!this.current) return;
      for (const turn of this.current.turns) {
        if (turn.state === 'pending' && !known.has(turn.id)) {
          this.pendingTurns.push({ turn, session: this.current });
        }
      }
      this.pendingTurns = this.pendingTurns.filter(
        (p) => !this.current || p.session.id !== this.current.id || this.current.turns.some((t) => t.id === p.turn.id && t.state === 'pending')
      );
    },

    /**
     * Apply a `dispatch.update` WS event.
     * @param {{kind?: string, session?: any, sessionId?: string, turn?: any, chunk?: string}} payload
     */
    applyEvent(payload) {
      if (!payload) return;
      if (payload.kind === 'session' && payload.session) {
        upsertById(this.sessions, payload.session);
        if (this.current && this.current.id === payload.session.id) {
          this.current.state = payload.session.state;
          this.current.title = payload.session.title || this.current.title;
          this.current.updatedAt = payload.session.updatedAt;
        }
        return;
      }
      if (payload.kind === 'turn' && payload.turn) {
        this.applyTurn(payload.sessionId, payload.turn, payload.session);
        return;
      }
      if (payload.kind === 'output' && payload.chunk) {
        if (!this.current || this.current.id !== payload.sessionId) return;
        const turn = this.current.turns.find((t) => t.id === payload.turnId);
        if (!turn) return;
        turn.output = ((turn.output || '') + payload.chunk).slice(-CLIENT_OUTPUT_MAX);
        return;
      }
      if (payload.kind === 'session_deleted' && payload.sessionId) {
        this.sessions = this.sessions.filter((s) => s.id !== payload.sessionId);
        this.pendingTurns = this.pendingTurns.filter((p) => p.session.id !== payload.sessionId);
        if (this.currentId === payload.sessionId) {
          this.currentId = this.sessions.length ? this.sessions[0].id : '';
          this.current = null;
          writeLastSession(this.currentId);
        }
      }
    },
  },
});
