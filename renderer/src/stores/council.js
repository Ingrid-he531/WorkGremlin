import { defineStore } from 'pinia';
import { httpBase } from '../api/bridge';
import { useProjectStore } from './project';
import { mergeUtterance, normUtterance, groupByRound } from '../lib/councilTimeline';

function authHeaders(info) {
  return info && info.token ? { Authorization: `Bearer ${info.token}` } : undefined;
}

/**
 * Council: start a session, watch it advance round by round, and see whether it ended in agreement.
 *
 * Two data sources, both used:
 *   · HTTP —— list / detail (authoritative, still consistent after a refresh);
 *   · WS `council.update` —— incremental (utterances arrive one by one, so no polling).
 * WS is only for "knowing a little earlier": **always pull the detail once at wrap-up**, because the
 * verdict (verdict / which round it stopped at) is computed only when the server writes to the DB, and the push carries just a summary. Anything missed while disconnected is recovered by that pull.
 */
export const useCouncilStore = defineStore('council', {
  state: () => ({
    /** Selectable floors (including the ones with no CLI installed, and why) */
    floors: [],
    defaults: {
      maxRounds: 3,
      maxRoundsLimit: 8,
      threshold: 'unanimous',
      modes: ['vote', 'analysis'],
      mode: 'vote',
      workspaceTurnTimeoutMs: 0,
      materialMaxBytes: 0,
      materialTotalMaxBytes: 0,
    },
    /** History list */
    list: [],
    /** The session currently open */
    current: null,
    /** Proposal for the current round (pushed over WS, shown as a banner in the UI) */
    liveProposal: null,
    loading: false,
    submitting: false,
    /** Raw failure text. **Untouched** —— the user must see exactly what the server said */
    error: '',
  }),

  getters: {
    readyFloors: (s) => s.floors.filter((f) => f.ready),
    /** Only when no floor can be summoned is it "can't start". Don't block before probing (floors empty) —— the page will make it clear */
    canStart: (s) => s.floors.length === 0 || s.floors.some((f) => f.ready),
    /** Is the session still advancing (show the live timeline on the page; once it is over there is no need to wait for pushes) */
    live: (s) => Boolean(s.current && ['draft', 'running'].includes(s.current.council.status)),
    /**
     * How the current session talks. Old rows have no mode column (sessions created before the
     * migration) → always treat as 'vote': that was the only mode back then, and guessing anything else would route the UI down a branch it never walked.
     */
    mode: (s) => ((s.current && s.current.council.mode) === 'analysis' ? 'analysis' : 'vote'),
    /** Working directory the session read (the user's project); empty = the server used a temp directory */
    workspacePath: (s) => (s.current && s.current.council.workspace_path) || '',
    /** Timeline grouped by round (with vote tallies counted from the utterances), see lib/councilTimeline.js */
    timeline: (s) => (s.current ? groupByRound(s.current.utterances) : []),

    /**
     * The proposal now on the table. Each source is missing half, so **take the newer one by round number**:
     *   · The detail endpoint gives the per-round archived round rows —— still consistent after a
     *     refresh / reopen, but it is a snapshot and won't move on its own while the page is open;
     *   · The WS debate event is the one just placed on the table —— freshest, but only while connected.
     * Neither can win unconditionally: the DB copy lags a round when a new round has just opened (the
     * round row is created first, the proposal pushed later), and the WS copy is gone after a reconnect. The larger round number is the newer one, and that holds on both sides.
     */
    currentProposal: (s) => {
      if (!s.current) return null;
      const rows = s.current.rounds.filter((r) => r.kind === 'debate' && r.proposal_text);
      // rounds come from SQL in ascending round_no order, so the last row is the newest round in the DB
      const fromDb = rows.length
        ? {
            roundNo: rows[rows.length - 1].round_no,
            proposal: rows[rows.length - 1].proposal_text,
            proposalFrom: rows[rows.length - 1].proposal_from,
          }
        : null;
      const live = s.liveProposal;
      if (!fromDb) return live;
      if (!live) return fromDb;
      return live.roundNo >= fromDb.roundNo ? live : fromDb;
    },
  },

  actions: {
    async fetchFloors() {
      const project = useProjectStore();
      try {
        const info = project.serverInfo || {};
        const res = await fetch(`${httpBase(info)}/api/v1/councils/floors`, { headers: authHeaders(info) });
        const data = await res.json();
        if (data && data.ok) {
          this.floors = data.floors || [];
          if (data.defaults) this.defaults = data.defaults;
        }
      } catch {
        /* Leave it empty when unreachable: the buttons stay clickable, and starting surfaces the server's raw message */
      }
    },

    async fetchList() {
      const project = useProjectStore();
      try {
        const info = project.serverInfo || {};
        const res = await fetch(`${httpBase(info)}/api/v1/councils?limit=50`, { headers: authHeaders(info) });
        const data = await res.json();
        if (data && data.ok) this.list = data.councils || [];
      } catch {
        /* same as above */
      }
    },

    /** Open a session: pull the detail (rounds + utterances + materials + attendees) */
    async open(id) {
      if (!id) {
        this.current = null;
        return;
      }
      const project = useProjectStore();
      this.loading = true;
      // Switched to another session, so the previous one's live proposal is void at once (otherwise the new session's banner would show the old proposal)
      this.liveProposal = null;
      try {
        const info = project.serverInfo || {};
        const res = await fetch(`${httpBase(info)}/api/v1/councils/${encodeURIComponent(id)}`, { headers: authHeaders(info) });
        const data = await res.json();
        if (data && data.ok) {
          this.current = {
            council: data.council,
            participants: data.participants || [],
            materials: data.materials || [],
            rounds: data.rounds || [],
            // Normalize the shape: DB rows are snake_case, WS increments are camelCase, so unify before merging, see lib/councilTimeline.js
            utterances: (data.utterances || []).map(normUtterance),
            live: Boolean(data.live),
          };
        } else {
          this.error = (data && data.error && data.error.message) || '打不开这场会';
        }
      } catch {
        this.error = '读不到这场会（服务端没响应？）';
      } finally {
        this.loading = false;
      }
    },

    /**
     * Start a session.
     * @returns {Promise<string|null>} the new session id; on failure returns null and puts the reason in error
     */
    async create({ topic, floors, files, maxRounds, mode, workspacePath }) {
      const project = useProjectStore();
      this.submitting = true;
      this.error = '';
      const body = { topic, floors, files, maxRounds, mode: mode || 'vote' };
      // **An empty working directory means this key is simply not sent**: the server then uses a
      // throwaway temp directory, and an empty string would just translate "not filled in" into "filled in blank", costing the server an extra step.
      const ws = String(workspacePath == null ? '' : workspacePath).trim();
      if (ws) body.workspacePath = ws;
      try {
        const info = project.serverInfo || {};
        const res = await fetch(`${httpBase(info)}/api/v1/councils`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(authHeaders(info) || {}) },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          // Show the server's reason as is (like "4F: no command-line executable found"), no translation, no rewriting
          this.error = (data && data.error && data.error.message) || `发起失败（HTTP ${res.status}）`;
          return null;
        }
        const id = data.council.id;
        await this.fetchList();
        await this.open(id);
        return id;
      } catch (err) {
        this.error = `发起失败：${(err && err.message) || '和服务端联系不上'}`;
        return null;
      } finally {
        this.submitting = false;
      }
    },

    async cancel(id) {
      const project = useProjectStore();
      const info = project.serverInfo || {};
      try {
        const res = await fetch(`${httpBase(info)}/api/v1/councils/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
          headers: authHeaders(info),
        });
        await res.json();
        await this.open(id);
        await this.fetchList();
      } catch {
        this.error = '取消没发出去（服务端没响应？）';
      }
    },

    async remove(id) {
      const project = useProjectStore();
      this.error = '';
      const info = project.serverInfo || {};
      try {
        const res = await fetch(`${httpBase(info)}/api/v1/councils/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: authHeaders(info),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !(data && data.ok)) {
          this.error = (data && data.error && data.error.message) || `删除失败（HTTP ${res.status}）`;
          return false;
        }
        if (this.current && this.current.council.id === id) this.current = null;
        await this.fetchList();
        return true;
      } catch {
        this.error = '删除没发出去（服务端没响应？）';
        return false;
      }
    },

    /**
     * WS increments. **Only handles "the session currently open"**: activity from other sessions is
     * only used to refresh the list. A wrap-up event (the one carrying status) always pulls the detail —— the verdict text / which round it stopped at only exists in the DB.
     */
    applyEvent(payload) {
      const p = payload || {};
      if (!p.councilId) return;
      const cur = this.current;
      const isCurrent = cur && cur.council.id === p.councilId;

      if (isCurrent && p.utterance) {
        // Incremental merge (dedupe + non-empty overwrite), see lib/councilTimeline.js
        cur.utterances = mergeUtterance(cur.utterances, p.utterance);
      }
      // "Current proposal" only when there really is one on the table. In analysis mode the debate
      // event's proposal is always null (see orchestrator.js) —— treating null as a proposal would hang an empty banner in the UI.
      if (isCurrent && p.roundNo != null && p.phase === 'debate' && p.proposal) {
        this.liveProposal = { roundNo: p.roundNo, proposal: p.proposal, proposalFrom: p.proposalFrom };
      }
      if (isCurrent && p.round) {
        // The authoritative tally from the server: attach it to that round (the UI shows both it and the one counted from the utterances)
        const at = cur.rounds.findIndex((r) => r.round_no === p.roundNo);
        const merged = { ...(cur.rounds[at] || { council_id: p.councilId, round_no: p.roundNo }), ...p.round };
        if (at >= 0) cur.rounds.splice(at, 1, merged);
        else cur.rounds.push(merged);
      }

      const terminal = p.status && ['done', 'failed', 'cancelled'].includes(p.status);
      if (terminal) {
        // The session is over, so the proposal on the table is no longer "current": the verdict is decided by the detail endpoint's round rows
        if (isCurrent) this.liveProposal = null;
        this.fetchList();
        if (isCurrent) this.open(p.councilId);
      } else if (isCurrent && p.status === 'running') {
        cur.council = { ...cur.council, status: 'running' };
        cur.live = true;
      }
    },

    /** Close the current one (used when switching tabs, so WS stops writing into an invisible page) */
    close() {
      this.current = null;
      this.liveProposal = null;
      this.error = '';
    },
  },
});
