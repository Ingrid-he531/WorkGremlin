import { defineStore } from 'pinia';
import { httpBase } from '../api/bridge';
import { useProjectStore } from './project';

function authHeaders(info) {
  return info && info.token ? { Authorization: `Bearer ${info.token}` } : undefined;
}

/**
 * 任务记录：从 DB 的 tasks 逐任务拉取（一行一次用户任务），
 * 一级检索（服务端）：filterProject（工程）/ filterClient（楼层=成员 client）；
 * 二级检索（状态）与关键词由前端在已拉结果上再筛（见 TaskRecordsView）。
 * 数据完全来自数据库，前端不编造任何字段。
 */
export const useTaskStore = defineStore('tasks', {
  state: () => ({
    tasks: [],
    subagents: [],
    selectedTaskId: null,
    loading: false,
    subLoading: false,
    /** 一级检索：'all' = 不过滤。工程按 project_id，楼层按成员 client */
    filterProject: 'all',
    filterClient: 'all',
  }),

  getters: {
    selectedTask: (s) => s.tasks.find((t) => t.id === s.selectedTaskId) || null,
  },

  actions: {
    async fetchTasks() {
      const project = useProjectStore();
      this.loading = true;
      try {
        const info = project.serverInfo || {};
        const params = new URLSearchParams();
        if (this.filterProject && this.filterProject !== 'all') params.set('project', this.filterProject);
        if (this.filterClient && this.filterClient !== 'all') params.set('client', this.filterClient);
        params.set('limit', '2000');
        const res = await fetch(
          `${httpBase(info)}/api/v1/task-runs?${params.toString()}`,
          { headers: authHeaders(info) }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.ok) this.tasks = data.items || [];
      } catch {
        /* 拉不到留空，下一轮再试 */
      } finally {
        this.loading = false;
      }
    },

    selectTask(id) {
      if (this.selectedTaskId === id) return;
      this.selectedTaskId = id;
      this.subagents = [];
      if (id) this.fetchSubagents(id);
    },

    async fetchSubagents(parentId) {
      const project = useProjectStore();
      const pid = project.project && project.project.id;
      if (!pid) return;
      this.subLoading = true;
      try {
        const info = project.serverInfo || {};
        const res = await fetch(
          `${httpBase(info)}/api/v1/subagent-runs?parent=${encodeURIComponent(parentId)}`,
          { headers: authHeaders(info) }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.ok) this.subagents = data.items || [];
      } catch {
        /* ignore */
      } finally {
        this.subLoading = false;
      }
    },

    /** 删单条任务记录（含 subagent / 产出）；前端已做二次确认 */
    async deleteTask(id) {
      const info = (useProjectStore().serverInfo) || {};
      try {
        const res = await fetch(`${httpBase(info)}/api/v1/task-runs/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: authHeaders(info),
        });
        if (!res.ok) return false;
        const data = await res.json();
        if (data && data.ok) {
          this.tasks = this.tasks.filter((t) => t.id !== id);
          if (this.selectedTaskId === id) {
            this.selectedTaskId = null;
            this.subagents = [];
          }
          return true;
        }
      } catch {
        /* ignore */
      }
      return false;
    },

    /** 批量删除：mode='all' 删筛选条件全部；mode='recent' 仅保留最近 days 天 */
    async deleteByFilter(mode, days) {
      const info = (useProjectStore().serverInfo) || {};
      const params = new URLSearchParams();
      if (this.filterProject && this.filterProject !== 'all') params.set('project', this.filterProject);
      if (this.filterClient && this.filterClient !== 'all') params.set('client', this.filterClient);
      params.set('mode', mode || 'all');
      if (mode === 'recent' && days) params.set('days', String(days));
      try {
        const res = await fetch(`${httpBase(info)}/api/v1/task-runs?${params.toString()}`, {
          method: 'DELETE',
          headers: authHeaders(info),
        });
        if (!res.ok) return 0;
        const data = await res.json();
        if (data && data.ok) {
          await this.fetchTasks();
          if (this.selectedTaskId && !this.tasks.find((t) => t.id === this.selectedTaskId)) {
            this.selectedTaskId = null;
            this.subagents = [];
          }
          return data.deleted || 0;
        }
      } catch {
        /* ignore */
      }
      return 0;
    },

    /** 读取服务端记录保留天数（天）；拉不到回退 30 */
    async fetchRetention() {
      const info = (useProjectStore().serverInfo) || {};
      try {
        const res = await fetch(`${httpBase(info)}/api/v1/settings/retention`, {
          headers: authHeaders(info),
        });
        if (res.ok) {
          const data = await res.json();
          if (data && Number.isFinite(Number(data.days))) return Number(data.days);
        }
      } catch {
        /* ignore */
      }
      return 30;
    },
    /** 修改记录保留天数：仅在用户点击「保存」时写回服务端（不轮询、不一直写） */
    async saveRetention(days) {
      const info = (useProjectStore().serverInfo) || {};
      const d = Math.max(1, Math.min(Number(days) || 30, 3650));
      try {
        const res = await fetch(`${httpBase(info)}/api/v1/settings/retention?days=${d}`, {
          method: 'PUT',
          headers: authHeaders(info),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  },
});
