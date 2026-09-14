import { defineStore } from 'pinia';
import { DEFAULTS } from '@workgremlin/shared';

/** 对话记录窗口：全量消息流 + 过滤 + 关键字搜索 + 自动跟随滚动 */
export const useMessageStore = defineStore('messages', {
  state: () => ({
    messages: [],
    filters: { members: [], types: [], since: null, until: null },
    keyword: '',
    autoFollow: true,
    pendingCount: 0,
  }),

  getters: {
    /** 按发送者 + 时间过滤 + 关键字搜索（M0 前端过滤；M2 切到服务端 FTS5 trigram） */
    filtered() {
      const kw = this.keyword.trim().toLowerCase();
      const members = this.filters.members || [];
      const types = this.filters.types || [];
      return this.messages.filter((m) => {
        if (members.length && !members.includes(m.fromMember) && !members.includes(m.toMember)) return false;
        if (types.length && !types.includes(m.type)) return false;
        if (this.filters.since && m.tsMs < this.filters.since) return false;
        if (this.filters.until && m.tsMs > this.filters.until) return false;
        if (kw) {
          const hay = `${m.subject || ''} ${m.content || ''}`.toLowerCase();
          if (!hay.includes(kw)) return false;
        }
        return true;
      });
    },
    count: (s) => s.messages.length,
  },

  actions: {
    setSnapshot(list) {
      // 服务端返回的是时间倒序，前端统一按时间正序渲染（新消息在底部，便于自动跟随）
      this.messages = (list || []).slice().sort((a, b) => a.tsMs - b.tsMs || a.id - b.id);
      if (this.messages.length > DEFAULTS.MESSAGE_WINDOW) {
        this.messages = this.messages.slice(-DEFAULTS.MESSAGE_WINDOW);
      }
    },

    /** @param {any} m */
    push(m) {
      const last = this.messages[this.messages.length - 1];
      if (last && last.id === m.id) return;
      this.messages.push(m);
      if (this.messages.length > DEFAULTS.MESSAGE_WINDOW) this.messages.shift();
      if (!this.autoFollow) this.pendingCount += 1;
    },

    setKeyword(kw) {
      this.keyword = kw;
    },

    setFilters(patch) {
      this.filters = { ...this.filters, ...patch };
    },

    toggleMember(name) {
      const set = new Set(this.filters.members);
      if (set.has(name)) set.delete(name);
      else set.add(name);
      this.filters.members = [...set];
    },

    clearFilters() {
      this.filters = { members: [], types: [], since: null, until: null };
      this.keyword = '';
    },

    setAutoFollow(v) {
      this.autoFollow = v;
      if (v) this.pendingCount = 0;
    },
  },
});
