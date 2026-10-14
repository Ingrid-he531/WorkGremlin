import { defineStore } from 'pinia';
import { httpBase } from '../api/bridge';
import { useProjectStore } from './project';

function authHeaders(info) {
  return info && info.token ? { Authorization: `Bearer ${info.token}` } : undefined;
}

/**
 * Task records: fetched task by task from the DB `tasks` table (one row per user task).
 * Top-level filters (server-side): filterProjects (projects) / filterClients (floors = member clients).
 * The second-level filters (states) and the keyword are applied on the fetched rows by the frontend
 * (see TaskRecordsView). All data comes from the database; the frontend never invents a field.
 */
export const useTaskStore = defineStore('tasks', {
  state: () => ({
    tasks: [],
    subagents: [],
    selectedTaskId: null,
    loading: false,
    subLoading: false,
    /**
     * Top-level filters: empty array = no filter. A project entry is a project id; a client entry is
     * a member client, and it may itself be a comma-separated string (a merged floor such as
     * 1F CodeBuddy = codebuddy + codebuddy-plugin), matched by the server as a set.
     * They live in the store so the selection survives switching pages.
     */
    filterProjects: [],
    filterClients: [],
    /**
     * Second-level filters, kept here for the same reason (survive page switches): the state filter
     * (client-side, applied in TaskRecordsView), the time filter and its custom range.
     */
    filterStates: [],
    filterTime: 'all',
    customFrom: '',
    customTo: '',
  }),

  getters: {
    selectedTask: (s) => s.tasks.find((t) => t.id === s.selectedTaskId) || null,
    /** Deduped client list from the selected floors (flatten each entry's comma-separated clients) */
    clientList: (s) => {
      const set = new Set();
      for (const v of s.filterClients) {
        for (const c of String(v || '').split(',')) {
          const t = c.trim();
          if (t) set.add(t);
        }
      }
      return [...set];
    },
    /** Comma-joined server params; an empty string means "no filter" */
    projectParam: (s) => s.filterProjects.filter(Boolean).join(','),
    clientParam() {
      return this.clientList.join(',');
    },
  },

  actions: {
    async fetchTasks() {
      const project = useProjectStore();
      this.loading = true;
      try {
        const info = project.serverInfo || {};
        const params = new URLSearchParams();
        if (this.projectParam) params.set('project', this.projectParam);
        if (this.clientParam) params.set('client', this.clientParam);
        params.set('limit', '2000');
        const res = await fetch(
          `${httpBase(info)}/api/v1/task-runs?${params.toString()}`,
          { headers: authHeaders(info) }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.ok) this.tasks = data.items || [];
      } catch {
        /* If the fetch fails, leave it empty and retry on the next poll */
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

    /** Bulk delete: mode='all' deletes everything matching the filters; mode='recent' keeps only the last days */
    async deleteByFilter(mode, days) {
      const info = (useProjectStore().serverInfo) || {};
      const params = new URLSearchParams();
      if (this.projectParam) params.set('project', this.projectParam);
      if (this.clientParam) params.set('client', this.clientParam);
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
