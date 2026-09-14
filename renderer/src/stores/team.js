import { defineStore } from 'pinia';
import { getServerInfo, getFlags, wsUrl } from '../api/bridge';
import { createConnection } from '../api/ws';
import { WS_EVENTS } from '@workgremlin/shared';

/** 工位视图 + 连接状态 */
export const useTeamStore = defineStore('team', {
  state: () => ({
    teams: [],
    team: null,
    members: [],
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
      const flags = await getFlags();
      this.flags = flags;
      this.demo = Boolean(flags.demo);

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
            default:
              if (onMessage) onMessage(msg);
          }
        },
        onState: (st) => {
          this.connection = st;
        },
      });
    },

    applySnapshot(snapshot) {
      this.team = snapshot.team;
      this.teams = snapshot.teams || [];
      this.members = snapshot.members || [];
    },

    /** @param {any} card */
    upsertMember(card) {
      if (!card) return;
      const idx = this.members.findIndex((m) => m.memberId === card.memberId);
      if (idx >= 0) this.members.splice(idx, 1, { ...this.members[idx], ...card });
      else this.members.push(card);
    },

    /** 切换团队（单 workspace 下可有多个 team） */
    async switchTeam(name) {
      if (this._conn) this._conn.subscribe({ team: name });
    },

    dispose() {
      if (this._conn) this._conn.close();
      this._conn = null;
    },
  },
});
