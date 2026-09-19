/**
 * sessions.js —— 全局活跃会话表（渲染层）。
 *
 * 服务端（server/src/sessionRegistry.js）维护一张表：所有智能体（楼层）× 所有工程
 * 的活跃会话，60 分钟没有事件就剔除。这里只负责把它搬进来 + 记住用户选了哪层哪个会话。
 *
 * 规则：
 *   - 按楼层分组渲染（左侧楼层 + 下拉 optgroup）；
 *   - 默认选中有活跃会话的楼层（用户选中的那层没活跃会话了，就跟到有的那层）；
 *   - 没有活跃会话的楼层照样显示办公室，只是下拉为空 + 状态点灰；
 *   - 选中的会话决定主 Agent 控制台显示什么（幽灵状态跟着它），办公室布局不动。
 */

import { defineStore } from 'pinia';
import { httpBase } from '../api/bridge';
import { PHASES } from '../iso/mainConsole';

const POLL_MS = 10_000;
/** 定时器放在 store 外面：它不是状态 */
let timer = null;

const phaseLabel = (p) => (PHASES[p] || PHASES.idle).label;
const shortId = (id) => String(id || '').slice(0, 8);

export const useSessionStore = defineStore('sessions', {
  state: () => ({
    /** 楼层：[{ id, name, installed, activeCount, sessions: [...] }] */
    floors: [],
    /** 所有楼层的活跃会话（扁平，按楼层顺序） */
    sessions: [],
    selectedFloor: '',
    selectedId: '',
    /** 服务端建议的楼层（第一个有活跃会话的层） */
    defaultFloor: '',
    /** 空表原因：no-storage / no-open-project */
    reason: '',
    /** 会话多久没事件会被移除（ms） */
    timeoutMs: 60 * 60_000,
    loaded: false,
  }),

  getters: {
    /** 当前楼层的会话 */
    floorSessions: (s) => {
      const f = s.floors.find((x) => x.id === s.selectedFloor);
      return f ? f.sessions : [];
    },

    selected: (s) => s.sessions.find((x) => x.id === s.selectedId) || null,

    /** 下拉里没东西可挑时的占位文案（按当前楼层判定） */
    emptyLabel: (s) => (s.sessions.length === 0 ? '没有打开的工程' : '没有活跃会话'),

    /**
     * 下拉选项：直接列出**当前选中楼层**的所有活跃会话（扁平，不显示楼层标题、
     * 也不区分"别的工程"——现在没有"当前打开的工程"这个概念，所有会话一视同仁）。
     * 切楼层时自然跟着换一批。
     */
    options: (s) => {
      const f = s.floors.find((x) => x.id === s.selectedFloor);
      if (!f) return [];
      return f.sessions.map((x) => ({
        value: x.id,
        label: [x.project || '未知工程', shortId(x.id)].filter(Boolean).join(' '),
        title: x.projectPath || x.project || x.id,
      }));
    },

    total: (s) => s.sessions.length,

    /**
     * 选中的会话值不值得"实时"对待。
     * 只有**当前工程**里、**插件还认**（有 runtime）的会话才是实时的；
     * 别的工程 / 只剩化石数据的会话，屋里的人一律按离线显示（不编造状态）。
     * 一个会话都没选（下拉为空）→ 不动屋里现有的显示。
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
        /* 拉不到就留着上一次的列表，别把下拉闪成空 */
      }
    },

    /** 应用一份会话快照（HTTP 轮询与 WS 实时推送共用），并修正当前楼层 / 会话选择 */
    applySnapshot(data) {
      if (!data || !data.ok) return;
      this.floors = data.floors || [];
      this.sessions = data.sessions || [];
      this.defaultFloor = data.defaultFloor || '';
      this.reason = data.reason || '';
      if (Number(data.timeoutMs)) this.timeoutMs = Number(data.timeoutMs);
      this.loaded = true;

      // 默认选中有活跃会话的楼层：用户选的那层没装 / 活跃会话掉光了，就跟到还行的那层
      const cur = this.floors.find((f) => f.id === this.selectedFloor);
      if (!cur || !cur.installed) {
        this.selectedFloor = this.defaultFloor || this.floors.find((f) => f.installed)?.id || '';
      }

      // 选中的会话掉了（超时剔除 / 换楼层）就在当前层重新落一个
      const list = this.floorSessions;
      if (this.selectedId && !list.some((x) => x.id === this.selectedId)) this.selectedId = '';
      if (!this.selectedId && list.length) {
        // current 已是"全局唯一"的当前会话（仅当前真实活动工程里那条），优先选它
        const pick = list.find((x) => x.current) || list[0];
        this.selectedId = pick.id;
      }
    },

    /** 选中某个会话：楼层跟着它走（会话本来就按楼层分组） */
    select(id) {
      this.selectedId = id || '';
      const s = this.sessions.find((x) => x.id === this.selectedId);
      if (s && s.floor) this.selectedFloor = s.floor;
    },

    /** 切楼层：办公室照常显示（没有活跃会话的层也一样），只是下拉跟着换一批 */
    selectFloor(id) {
      this.selectedFloor = id || '';
      const list = this.floorSessions;
      const pick = list.find((x) => x.current) || list[0];
      this.selectedId = pick ? pick.id : '';
    },

    /** @param {{port?:number, token?:string, fallback?:boolean}} info */
    startPolling(info = {}) {
      this.stopPolling();
      timer = setInterval(() => this.refresh(info), POLL_MS);
    },

    stopPolling() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  },
});
