import { defineStore } from 'pinia';
import { httpBase } from '../api/bridge';
import { useProjectStore } from './project';
import {
  mergeUtterance,
  mergeRoundResult,
  normUtterance,
  normRoundResults,
  groupUtterances,
  summarizeCouncil,
} from '../lib/councilTimeline';

function authHeaders(info) {
  return info && info.token ? { Authorization: `Bearer ${info.token}` } : undefined;
}

/**
 * Council: start a moderated review loop, watch it advance phase by phase, read the summary, and
 * download the archive.
 *
 * Two data sources, both used:
 *   · HTTP — list / detail / report (authoritative, still consistent after a refresh);
 *   · WS `council.update` — incremental utterances and round results.
 * WS is only "a little earlier": a terminal event always pulls the detail, because the final report
 * and verdict are written by the server at wrap-up.
 */
export const useCouncilStore = defineStore('council', {
  state: () => ({
    /** Selectable floors (including ones with no CLI installed, and why) */
    floors: [],
    defaults: {
      maxRounds: 3,
      maxRoundsLimit: 8,
      roles: ['moderator', 'main', 'reviewer'],
      severities: ['blocker', 'major', 'minor', 'nit'],
      stances: ['reject', 'revise', 'accept'],
      dimensions: [],
      severityWeights: {},
      conflictWeight: 10,
      scoreMax: 100,
      workspaceTurnTimeoutMs: 0,
      materialMaxBytes: 0,
      materialTotalMaxBytes: 0,
    },
    /** History list */
    list: [],
    /** The council currently open */
    current: null,
    /** Proposal for the current round (pushed over WS, shown as a banner) */
    liveProposal: null,
    loading: false,
    submitting: false,
    /** Raw failure text. **Untouched** — the user must see exactly what the server said */
    error: '',
  }),

  getters: {
    readyFloors: (s) => s.floors.filter((f) => f.ready),
    canStart: (s) => s.floors.length === 0 || s.floors.some((f) => f.ready),
    live: (s) => Boolean(s.current && ['draft', 'running'].includes(s.current.council.status)),
    /**
     * What is in flight right now: `{ roundNo, phase, floors, startedAt }`, or null when the meeting
     * is not running. A long turn emits nothing for minutes, so this is the only live evidence.
     */
    working: (s) => (s.current && s.current.live ? s.current.progress : null),
    workspacePath: (s) => (s.current && s.current.council.workspace_path) || '',

    /** Right-side summary: score, counts, roles, models, token usage */
    summary: (s) =>
      s.current
        ? summarizeCouncil({
            participants: s.current.participants,
            utterances: s.current.utterances,
            roundResults: s.current.roundResults,
          })
        : null,

    /** Utterances grouped by round (collapsed process view) */
    timeline: (s) => (s.current ? groupUtterances(s.current.utterances) : []),

    lastRound: (s) => {
      const list = s.current ? s.current.roundResults : [];
      return list.length ? list[list.length - 1] : null;
    },

    currentProposal: (s) => {
      if (!s.current) return null;
      const results = s.current.roundResults;
      const fromDb = results.length ? results[results.length - 1].proposal : null;
      const live = s.liveProposal;
      if (!fromDb) return live;
      if (!live) return fromDb;
      return (live.roundNo || 0) >= (s.lastRound ? s.lastRound.round : 0) ? live : fromDb;
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
        /* Leave it empty when unreachable: starting surfaces the server's raw message */
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

    /** Open a council: pull the detail (plan, RoundResults, utterances, materials, roles, report) */
    async open(id) {
      if (!id) {
        this.current = null;
        return;
      }
      const project = useProjectStore();
      this.loading = true;
      this.liveProposal = null;
      this.error = '';
      try {
        const info = project.serverInfo || {};
        const res = await fetch(`${httpBase(info)}/api/v1/councils/${encodeURIComponent(id)}`, {
          headers: authHeaders(info),
        });
        const data = await res.json();
        if (data && data.ok) {
          this.current = {
            council: data.council,
            participants: data.participants || [],
            materials: data.materials || [],
            rounds: data.rounds || [],
            roundResults: normRoundResults(data.roundResults || []),
            reviews: data.reviews || [],
            plan: data.plan || null,
            report: data.report || null,
            reportFiles: data.reportFiles || [],
            utterances: (data.utterances || []).map(normUtterance),
            live: Boolean(data.live),
            progress: data.progress || null,
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
     * Start a council.
     * @returns {Promise<string|null>} the new id; on failure null and the reason in `error`
     */
    async create({ topic, moderator, main, reviewers, files, maxRounds, workspacePath }) {
      const project = useProjectStore();
      this.submitting = true;
      this.error = '';
      const body = {
        topic,
        moderator,
        main,
        reviewers: Array.isArray(reviewers) ? reviewers : [],
        files: Array.isArray(files) ? files : [],
        maxRounds,
      };
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

    /** Pull the archive report (JSON + exported file paths). */
    async fetchReport(id) {
      const project = useProjectStore();
      const info = project.serverInfo || {};
      try {
        const res = await fetch(`${httpBase(info)}/api/v1/councils/${encodeURIComponent(id)}/report`, {
          headers: authHeaders(info),
        });
        const data = await res.json();
        if (data && data.ok) {
          if (this.current && this.current.council.id === id) {
            this.current.report = data.report || null;
            this.current.reportFiles = data.files || [];
          }
          return data;
        }
        this.error = (data && data.error && data.error.message) || '读不到报告';
      } catch {
        this.error = '读不到报告（服务端没响应？）';
      }
      return null;
    },

    /**
     * WS increments. Only the currently open council is updated in place; other councils merely
     * refresh the list. A terminal event always pulls the detail, because the verdict/report only
     * exist in the DB.
     */
    applyEvent(payload) {
      const p = payload || {};
      if (!p.councilId) return;
      const cur = this.current;
      const isCurrent = cur && cur.council.id === p.councilId;

      if (isCurrent && p.utterance) {
        cur.utterances = mergeUtterance(cur.utterances, p.utterance);
      }
      if (isCurrent && p.phase === 'plan' && p.plan) {
        cur.plan = p.plan;
      }
      if (isCurrent && p.phase === 'proposal' && p.proposal) {
        this.liveProposal = { roundNo: p.roundNo, ...p.proposal };
      }
      if (isCurrent && p.round) {
        cur.roundResults = mergeRoundResult(cur.roundResults, p.round);
      }
      if (isCurrent && p.adjudication) {
        cur.adjudication = p.adjudication;
      }
      if (isCurrent && p.finalDraft) {
        cur.finalDraft = p.finalDraft;
      }

      const terminal = p.status && ['done', 'failed', 'cancelled'].includes(p.status);
      if (terminal) {
        if (isCurrent) {
          this.liveProposal = null;
          cur.progress = null;
          // Flip the status now so the working strip disappears immediately; the detail refetch
          // below confirms the verdict and brings the report.
          cur.council = {
            ...cur.council,
            status: p.status,
            verdict: p.verdict != null ? p.verdict : cur.council.verdict,
          };
        }
        this.fetchList();
        if (isCurrent) this.open(p.councilId);
      } else if (isCurrent && p.status === 'running') {
        cur.council = { ...cur.council, status: 'running' };
        cur.live = true;
        // Progress events carry who is working; plain "running" events (e.g. a workspace error)
        // carry no phase and must not wipe what we already know.
        if (p.phase) {
          cur.progress = {
            roundNo: p.roundNo || 0,
            phase: p.phase,
            floors: Array.isArray(p.floors) ? p.floors : [],
            startedAt: p.startedAt || null,
          };
        }
      }
    },

    close() {
      this.current = null;
      this.liveProposal = null;
      this.error = '';
    },
  },
});
