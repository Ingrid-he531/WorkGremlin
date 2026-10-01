import { defineStore } from 'pinia';
import { getServerInfo, getWorkspace, openWorkspace, wsUrl, httpBase } from '../api/bridge';
import { createConnection } from '../api/ws';
import { WS_EVENTS } from '@workgremlin/shared';
import { memberBelongsToProject } from '../lib/projectScope';

/** 兜底对账间隔：WS 增量事件（尤其 member.remove）是一次性的，漏收就永久陈旧，靠它自愈 */
const RECONCILE_MS = 15_000;

/** 工位视图 + 连接状态（当前工程的成员 / 幽灵 / 连接） */
export const useProjectStore = defineStore('project', {
  state: () => ({
    /** 全部工程（演示工程和真实工程并列） */
    projects: [],
    /** 当前工程 */
    project: null,
    /**
     * 当前工程 id（server 的 projects.id —— 等于 workspace 响应里的 project、成员卡上的 project）。
     * 单独存一份是因为 workspace 响应只给 id 字符串、快照给的是整行对象，两处都要能参与过滤。
     * 空串 = 还不知道（老服务端 / 还没拿到 workspace）→ 不过滤，见 lib/projectScope.js。
     */
    projectId: '',
    members: [],
    /** 当前工程显示名（server 解析：package.json name > 目录名；演示工程为固定名） */
    projectName: '',
    /** 当前工程根目录（演示工程为空） */
    workspacePath: '',
    /** 当前工程的 subagent 清单文件路径（幽灵的数据源） */
    feedPath: '',
    /** 最近打开过的工程 */
    recent: [],
    connection: { state: 'connecting', source: 'ws' },
    serverInfo: null,
    /** 当前停在演示工程（服务端 workspace 响应里的 demo，由「演示模式」按钮切换） */
    demo: false,
    /** 进演示前打开的是哪个工程：退出演示时回这里（演示工程自己没有目录） */
    demoReturnPath: '',
    _conn: null,
    _reconcileTimer: null,
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
      this.projectName = info.projectName || '';

      const ws = await getWorkspace(info);
      if (ws) this.applyWorkspace(ws);

      this._conn = createConnection({
        url: wsUrl(info),
        token: info.token,
        project: null,
        // 每轮（重）连前重新问一次 server 信息：server 重启会换 token / 端口，
        // 拿旧的那份重连只会被 bad_token 一直踢（见 api/ws.js 的说明）。
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
          // WS 一连上就主动订阅一次：注册 filters 并让服务端立刻回一份当前状态，
          // 不必等下一次推送（roster 心跳最长 15s）才见得到成员/小怪物（HELLO 也会回快照，这里是显式再拉一次）。
          // 必须在 HELLO 之后发 —— 顺序由 api/ws.js 的 open 回调保证，抢在 HELLO 前会被服务端当 bad token 踢掉。
          if (st && st.state === 'open' && this._conn) this._conn.subscribe({});
        },
      });

      // 兜底对账：member.remove 是一次性事件，漏收（WS 抖动 / 窗口失焦）后那条成员会永久挂在
      // 办公室里（member.status 心跳只更新不删除）。周期性拉一次快照整体对齐，保证最终一致。
      this.stopReconcile();
      this._reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_MS);
    },

    /**
     * 每次（重）连前的鉴权解析。
     *
     * Electron 主进程每次都会重读 ~/.workgremlin/server.json（见 desktop/src/main.js 的
     * GET_SERVER_INFO），所以这里拿到的是"当前这个 server 实例"的端口与 token。
     * 一旦和本地记的不一样（= server 重启过），就把 serverInfo 换成新的并把工程信息对齐一次；
     * 各页面的 HTTP 轮询都读 project.serverInfo，因此也会跟着用上新 token（不再一路 401）。
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
        /* 读不到 server.json（或 IPC 不通）就用旧的那份继续试，别把连接卡死 */
      }
      return { url: wsUrl(info), token: info.token, project: null };
    },

    /** 拉一份当前快照，整体覆盖本地成员表（自愈：多出来的陈旧成员会被这次覆盖掉） */
    async reconcile() {
      try {
        const info = this.serverInfo || {};
        const res = await fetch(`${httpBase(info)}/api/v1/snapshot`, {
          headers: info.token ? { Authorization: `Bearer ${info.token}` } : undefined,
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.ok && data.snapshot) this.applySnapshot(data.snapshot);
      } catch {
        /* 拉不到就留到下一轮，不影响增量推送 */
      }
    },

    stopReconcile() {
      if (this._reconcileTimer) clearInterval(this._reconcileTimer);
      this._reconcileTimer = null;
    },

    applySnapshot(snapshot) {
      this.project = snapshot.project;
      if (snapshot.project && snapshot.project.id) this.projectId = String(snapshot.project.id);
      this.projects = snapshot.projects || [];
      // 快照本身就是按当前工程切的，这里再滤一道只是防御（服务端换了 / 老快照混进来）
      this.members = (snapshot.members || []).filter((m) => memberBelongsToProject(m, this.projectId));
      if (snapshot.projectName) this.projectName = snapshot.projectName;
    },

    /** @param {any} card */
    upsertMember(card) {
      if (!card) return;
      // 别的工程的成员卡一律不收：WS 订阅不带 project，服务端会把所有工程的广播都发过来
      // （退出演示后 __demo__ 的心跳超时扫描就是一例），塞进来就会在屋里闪一下又消失。
      if (!memberBelongsToProject(card, this.projectId)) return;
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
      this.projectName = ws.projectName || '';
      this.workspacePath = ws.workspacePath || '';
      this.feedPath = ws.feedPath || '';
      this.recent = Array.isArray(ws.recent) ? ws.recent : [];
      this.demo = Boolean(ws.demo);
      // 换工程要立刻把上一个工程的人从屋里撤掉：服务端的新快照是**异步**到的（同一次请求里广播），
      // 不先滤一道，上一个工程的成员会在这段时间继续站在工位上 —— 退出演示时那 8 只演示小怪物
      // 是最容易被看见的一例（2026-10-01 用户实测：退出演示、切楼层后它们又短暂出现）。
      // 拿不到新工程 id 时（老服务端 / 响应缺字段）不换 projectId、也不过滤，维持原样。
      if (ws.project) {
        this.projectId = String(ws.project);
        this.members = this.members.filter((m) => memberBelongsToProject(m, this.projectId));
      }
    },

    /**
     * 打开工程：屋里的成员/幽灵整体切到这个工程。path 为空 / 'demo' 切到演示工程。
     * 服务端会广播新快照，这里不用自己拉。
     * @param {string} path
     */
    async openWorkspace(path) {
      const cur = await openWorkspace(this.serverInfo || {}, path);
      this.applyWorkspace(cur);
      return cur;
    },

    /**
     * 退出演示时该回的目录：进演示前记下的那个 → 最近打开过的 → 服务启动时解析出来的。
     * 演示工程自己没有目录（workspacePath 为空），所以它自己不能当"回去的地址"。
     */
    realPath() {
      if (this.workspacePath) return this.workspacePath;
      const hit = (this.recent || []).find((r) => r && r.path);
      if (hit) return hit.path;
      return (this.serverInfo && this.serverInfo.workspacePath) || '';
    },

    /**
     * 进演示模式：切到「演示工程」（POST /api/v1/workspace 空路径 → 服务端 openDemo）。
     * 服务端会顺手把演示数据备好并起心跳推进器（见 server/src/index.js 的 syncDemo）。
     *
     * 先把"退出时回哪个工程"记下来 —— 必须**在切走之前**抓（切进演示后 workspacePath 就是空的了）。
     */
    async enterDemo() {
      if (this.demo) return null;
      this.demoReturnPath = this.realPath();
      return this.openWorkspace('demo');
    },

    /** 退出演示：回到进演示前打开的那个真实工程；一个真实工程都没有就留在演示 */
    async exitDemo() {
      if (!this.demo) return null;
      const back = this.demoReturnPath || this.realPath();
      if (!back) return null;
      return this.openWorkspace(back);
    },

    dispose() {
      this.stopReconcile();
      if (this._conn) this._conn.close();
      this._conn = null;
    },
  },
});
