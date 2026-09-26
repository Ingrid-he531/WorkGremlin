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

/**
 * 上一份快照里见过的会话（`楼层:id`）。放在 store 外面：只是记账，不参与渲染。
 * null = 还没接过第一份快照（那时一切都是"第一次见"，不算新来的）。
 */
let seenKeys = null;
const keyOf = (s) => `${s && s.floor ? s.floor : ''}:${s && s.id ? s.id : ''}`;

/**
 * 当前这条会话算不算"没在跑"：待命 / 任务完成都算，可以放心跟到新会话上；
 * 等待授权（await）不算 —— 用户正等着给它放行，别把焦点抢走。
 */
// unreported（没接 hook 的 CLI 楼层）也算"没在跑"：新会话出现时可以让它跟过去
const isIdleish = (s) => !s || s.phase === 'idle' || s.phase === 'done' || s.phase === 'unreported';

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
    /**
     * 用户切到了一个**没有活跃会话**的楼层。
     * 这层没人在干活 → 办公室要跟着清空（屋里的人、主控制台、对话都不该再挂着上一层工程的）；
     * 一旦这层出现会话（或用户选了某条会话）就自动置回 false。
     * 只在用户主动切楼层时置位：初始加载 / 演示模式下没有会话也不该把办公室清掉。
     */
    floorEmpty: false,
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

    /**
     * 选中会话的**会话 id**（轴 2）—— hook payload 里的 `session_id`，服务端拿它过滤
     * `/api/v1/reporter-phase`，这样同一个楼层里多条会话（两个终端 / CLI 与插件混跑）
     * 各显示各的实时相位，不会"谁最新显示谁"。
     *
     * 它跟 `id` 不是一回事：`id` 是**落盘定位符**（CLI 是 `<工程目录>/<会话>.jsonl` 的相对路径，
     * 插件是 genie-history 的会话 id），只有落盘文件名本身就等于会话 id 的产品（Claude Code）
     * 才拿得到。拿不到（Codex 的 rollout-*.jsonl、插件）就返回空串 → 服务端退回老行为。
     * @returns {string}
     */
    selectedSessionId: (s) => {
      const x = s.sessions.find((y) => y.id === s.selectedId);
      return (x && x.sessionId) || '';
    },

    /**
     * 当前楼层接纳的**全部**客户端（服务端 floors[].clients 原样透传：合并楼层两个、单层一个）。
     * /reporter-phase 收逗号分隔的一串（见 server 的 clientHit）；楼层 ↔ client 的对应关系以
     * server/src/products.js 为准，这里不重复列举（免得跟着楼层重编号过期）。
     */
    selectedClients: (s) => {
      const f = s.floors.find((x) => x.id === s.selectedFloor);
      if (!f) return [];
      if (Array.isArray(f.clients) && f.clients.length) return f.clients;
      return f.client ? [f.client] : [];
    },

    /**
     * 当前楼层的**主**客户端（= clients[0]）。plugin（VS Code 系扩展）统一带 -plugin 后缀。
     * 办公室按它过滤成员/幽灵（成员卡上的 client 由服务端打，见 server 的 members.client）——
     * 过滤按**基名**认，所以主 client=codebuddy 的楼层也收 codebuddy-plugin 的成员。
     */
    selectedClient: (s) => {
      const f = s.floors.find((x) => x.id === s.selectedFloor);
      return (f && f.client) || '';
    },

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
      // 这层终于有会话了（刚才还是空的）→ 办公室恢复正常显示
      if (this.selectedId) this.floorEmpty = false;

      // 新会话插队：当前这条"没在跑"时，自动跟到刚出现的会话上（见 followNewSessions）
      this.followNewSessions();
    },

    /**
     * 新会话插队：这一份快照里出现了上次没见过的会话，且当前选中那条"没在跑"
     * （待命 / 任务完成），就自动切过去 —— 用户在 IDE 里开了新会话，办公室别还停在旧那条上发呆。
     * 正在跑 / 等待授权的会话不抢：那是有主的状态。
     * @returns {string} 切过去的会话 id；没切返回 ''
     */
    followNewSessions() {
      const keys = this.sessions.map(keyOf);
      if (!seenKeys) {
        // 第一份快照只记账：否则一进页面就会被"第一次见"的第一条抢走
        seenKeys = new Set(keys);
        return '';
      }
      const fresh = this.sessions.filter((s) => !seenKeys.has(keyOf(s)));
      seenKeys = new Set(keys);
      if (!fresh.length) return '';
      if (!isIdleish(this.selected)) return '';
      // 同时冒出多条：先挑标了 current / fresh 的（真实在活动的那条），否则取最后一条（最新的）
      const pick = fresh.find((x) => x.current || x.fresh) || fresh[fresh.length - 1];
      this.select(pick.id);
      return pick.id;
    },

    /** 选中某个会话：楼层跟着它走（会话本来就按楼层分组） */
    select(id) {
      this.selectedId = id || '';
      this.floorEmpty = false;
      const s = this.sessions.find((x) => x.id === this.selectedId);
      if (s && s.floor) this.selectedFloor = s.floor;
    },

    /**
     * 切楼层：下拉跟着换一批；**这一层没有活跃会话时办公室一并清空** ——
     * 那层没人在干活，屋里要是还站着上一层工程的小怪物、顶上还挂着上一个工程的名字，
     * 看着就像没切换（会话 / 工程 / 对话都还是上一层的）。
     */
    selectFloor(id) {
      this.selectedFloor = id || '';
      const list = this.floorSessions;
      const pick = list.find((x) => x.current) || list[0];
      this.selectedId = pick ? pick.id : '';
      this.floorEmpty = !this.selectedId;
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
