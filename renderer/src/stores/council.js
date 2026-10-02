import { defineStore } from 'pinia';
import { httpBase } from '../api/bridge';
import { useProjectStore } from './project';
import { mergeUtterance, normUtterance, groupByRound } from '../lib/councilTimeline';

function authHeaders(info) {
  return info && info.token ? { Authorization: `Bearer ${info.token}` } : undefined;
}

/**
 * 议事厅：发起一场会、看它逐轮推进、看最后谈成没谈成。
 *
 * 数据来源两条，都要用：
 *   · HTTP —— 列表 / 详情（权威，刷新后仍对得上）；
 *   · WS `council.update` —— 增量（发言一条条推来，不用轮询）。
 * WS 只当"早知道一点"用：**收尾时一定回拉一次详情**，因为结论（verdict / 停在第几轮）
 * 是服务端落库时才算出来的，推送里只有一个摘要。断线期间漏掉的也能靠这次回拉补上。
 */
export const useCouncilStore = defineStore('council', {
  state: () => ({
    /** 可选楼层（含没装 CLI 的那几层与原因） */
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
    /** 历史列表 */
    list: [],
    /** 当前打开的那场会 */
    current: null,
    /** 当前这轮的提案（WS 推来，界面上做成横幅） */
    liveProposal: null,
    loading: false,
    submitting: false,
    /** 操作失败的原文。**不加工** —— 用户要看到服务端到底说了什么 */
    error: '',
  }),

  getters: {
    readyFloors: (s) => s.floors.filter((f) => f.ready),
    /** 一层都请不动才叫"开不起来"。还没探测到（floors 为空）时不拦，进页面会说清楚 */
    canStart: (s) => s.floors.length === 0 || s.floors.some((f) => f.ready),
    /** 会还在推进吗（在页面上显示实时时间线；结束了就不必再等推送） */
    live: (s) => Boolean(s.current && ['draft', 'running'].includes(s.current.council.status)),
    /**
     * 当前这场会的谈法。老行没有 mode 列（迁移前建的会）→ 一律当 'vote'：
     * 那时候只有这一种谈法，猜成别的会把界面引到一条它根本没走过的分支上。
     */
    mode: (s) => ((s.current && s.current.council.mode) === 'analysis' ? 'analysis' : 'vote'),
    /** 当前这场会的工作目录（工程模式）；空 = 隔离模式 */
    workspacePath: (s) => (s.current && s.current.council.workspace_path) || '',
    /** 按轮次分好的时间线（含从发言现数的票型），见 lib/councilTimeline.js */
    timeline: (s) => (s.current ? groupByRound(s.current.utterances) : []),

    /**
     * 现在桌上那份提案。两个来源各缺一半，**按轮次号取新的那份**：
     *   · 详情接口给的是逐轮存档的轮次行 —— 刷新 / 重开之后仍然对得上，但它是一份快照，
     *     页面开着的时候不会自己往前走；
     *   · WS 的 debate 事件是刚上桌的那份 —— 最新，但只有连着的时候才有。
     * 谁也不能无条件优先：库里那份在新一轮刚开谈时会落后一轮（轮次行先建、提案后推），
     * WS 那份在断线重连之后就没了。轮次号大的是新的，两边都成立。
     */
    currentProposal: (s) => {
      if (!s.current) return null;
      const rows = s.current.rounds.filter((r) => r.kind === 'debate' && r.proposal_text);
      // rounds 按 round_no 升序来自 SQL，最后一行就是库里最新的一轮
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
        /* 拉不到就先空着：界面上按钮照常可点，发起时会给出服务端的原文 */
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
        /* 同上 */
      }
    },

    /** 打开一场会：拉详情（轮次 + 发言 + 材料 + 出席者） */
    async open(id) {
      if (!id) {
        this.current = null;
        return;
      }
      const project = useProjectStore();
      this.loading = true;
      // 换了一场会，上一场的实时提案立刻作废（否则新会的横幅会挂着旧会的提案）
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
            // 统一形状：DB 行是 snake_case，WS 增量是 camelCase，合并前必须先归一，见 lib/councilTimeline.js
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
     * 发起一场会。
     * @returns {Promise<string|null>} 新会的 id；失败返回 null 并把原因放进 error
     */
    async create({ topic, floors, files, maxRounds, mode, workspacePath }) {
      const project = useProjectStore();
      this.submitting = true;
      this.error = '';
      const body = { topic, floors, files, maxRounds, mode: mode || 'vote' };
      // 工作目录**留空就不发这个 key**：隔离模式是服务端的缺省行为，
      // 发一个空串过去只是把"没填"翻译成"填了个空"，服务端要多一步才能认出它。
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
          // 服务端给的原因直接显示（"4F：没找到命令行可执行文件"这种），不翻译、不改写
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
     * WS 增量。**只处理"当前打开的那场"**：别的会的动静只用来刷新列表。
     * 收尾事件（带 status 的那种）一定回拉详情 —— 结论文本 / 停在第几轮只有库里有。
     */
    applyEvent(payload) {
      const p = payload || {};
      if (!p.councilId) return;
      const cur = this.current;
      const isCurrent = cur && cur.council.id === p.councilId;

      if (isCurrent && p.utterance) {
        // 增量合并（去重 + 非空覆盖），见 lib/councilTimeline.js
        cur.utterances = mergeUtterance(cur.utterances, p.utterance);
      }
      // 桌上真有一份提案才叫"当前提案"。分析模式的 debate 事件里 proposal 恒为 null
      // （见 orchestrator.js）—— 认 null 当提案的话，界面上会挂起一条空横幅。
      if (isCurrent && p.roundNo != null && p.phase === 'debate' && p.proposal) {
        this.liveProposal = { roundNo: p.roundNo, proposal: p.proposal, proposalFrom: p.proposalFrom };
      }
      if (isCurrent && p.round) {
        // 服务端给的权威票型：挂到那一轮上（界面同时显示它和从发言数出来的那一份）
        const at = cur.rounds.findIndex((r) => r.round_no === p.roundNo);
        const merged = { ...(cur.rounds[at] || { council_id: p.councilId, round_no: p.roundNo }), ...p.round };
        if (at >= 0) cur.rounds.splice(at, 1, merged);
        else cur.rounds.push(merged);
      }

      const terminal = p.status && ['done', 'failed', 'cancelled'].includes(p.status);
      if (terminal) {
        // 会开完了，桌上那份提案不再是"当前的"：结论由详情接口的轮次行说了算
        if (isCurrent) this.liveProposal = null;
        this.fetchList();
        if (isCurrent) this.open(p.councilId);
      } else if (isCurrent && p.status === 'running') {
        cur.council = { ...cur.council, status: 'running' };
        cur.live = true;
      }
    },

    /** 关掉当前这场（切走页签时用，别让 WS 继续往一个看不见的页面上写） */
    close() {
      this.current = null;
      this.liveProposal = null;
      this.error = '';
    },
  },
});
