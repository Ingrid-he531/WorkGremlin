import { defineStore } from 'pinia';
import { getServerInfo, getFlags, getWorkspace, openWorkspace, wsUrl } from '../api/bridge';
import { createConnection } from '../api/ws';
import { WS_EVENTS } from '@workgremlin/shared';

/** 工位视图 + 连接状态 */
export const useTeamStore = defineStore('team', {
  state: () => ({
    teams: [],
    team: null,
    members: [],
    /** 当前工程名（server 解析：package.json name > 目录名） */
    project: '',
    workspacePath: '',
    /** 当前工程的 subagent 清单文件路径（幽灵的数据源） */
    feedPath: '',
    /** 最近打开过的工程 */
    recent: [],
    connection: { state: 'connecting', source: 'ws' },
    serverInfo: null,
    flags: { demo: false, seed: 1 },
    demo: false,
    _conn: null,
  }),

  getters: {
    /** 按状态聚合计数（供顶部概览） */
    stateCounts: (s) =>
      s.members.reduce((acc, m) => {
        acc[m.state] = (acc[m.state] || 0) + 1;
        return acc;
      }, {}),
    degradedCount: (s) => s.members.filter((m) => m.degraded).length,
  },

  actions: {
    async init(onMessage) {
      const info = await getServerInfo();
      this.serverInfo = info;
      this.project = info.project || '';
      const flags = await getFlags();
      this.flags = flags;
      this.demo = Boolean(flags.demo);

      const ws = await getWorkspace(info);
      if (ws) this.applyWorkspace(ws);

      this._conn = createConnection({
        url: wsUrl(info),
        token: info.token,
        team: null,
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
          // WS 一连上就主动订阅一次：注册 filters 并让服务端立刻回一份当前状态，
          // 不必等下一次推送（roster 心跳最长 15s）才见得到成员/小怪物（HELLO 也会回快照，这里是显式再拉一次）。
          // 必须在 HELLO 之后发 —— 顺序由 api/ws.js 的 open 回调保证，抢在 HELLO 前会被服务端当 bad token 踢掉。
          if (st && st.state === 'open' && this._conn) this._conn.subscribe({});
        },
      });
    },

    applySnapshot(snapshot) {
      this.team = snapshot.team;
      this.teams = snapshot.teams || [];
      this.members = snapshot.members || [];
      if (snapshot.project) this.project = snapshot.project;
    },

    /** @param {any} card */
    upsertMember(card) {
      if (!card) return;
      const idx = this.members.findIndex((m) => m.memberId === card.memberId);
      if (idx >= 0) this.members.splice(idx, 1, { ...this.members[idx], ...card });
      else this.members.push(card);
    },

    /** 临时成员（幽灵）退场：subagent 结束，屋里就不该再飘着它 */
    removeMember(memberId) {
      if (!memberId) return;
      const idx = this.members.findIndex((m) => m.memberId === memberId);
      if (idx >= 0) this.members.splice(idx, 1);
    },

    applyWorkspace(ws) {
      if (!ws) return;
      this.project = ws.project || '';
      this.workspacePath = ws.workspacePath || '';
      this.feedPath = ws.feedPath || '';
      this.recent = Array.isArray(ws.recent) ? ws.recent : [];
      this.demo = Boolean(ws.demo);
    },

    /**
     * 打开工程：屋里的成员/幽灵整体切到这个工程。path 为空 / 'demo' 切回演示数据。
     * 服务端会广播新快照，这里不用自己拉。
     * @param {string} path
     */
    async openWorkspace(path) {
      const cur = await openWorkspace(this.serverInfo || {}, path);
      this.applyWorkspace(cur);
      return cur;
    },

    /** 切换团队（单 workspace 下可有多个 team） */
    async switchTeam(name) {
      if (this._conn) this._conn.subscribe({ team: name });
    },

    /**
     * 下拉里选了一个"工程"：它属于别的目录就真正打开那个工程（换监听根 + 幽灵数据源），
     * 只切订阅会出现"屋里是 A 的成员、幽灵是 B 的"这种错位。
     * @param {string} name team 名
     */
    async selectTeam(name) {
      const t = this.teams.find((x) => x.name === name);
      if (t && t.workspacePath && this.workspacePath && t.workspacePath !== this.workspacePath) {
        await this.openWorkspace(t.workspacePath);
        return;
      }
      this.switchTeam(name);
    },

    dispose() {
      if (this._conn) this._conn.close();
      this._conn = null;
    },
  },
});
