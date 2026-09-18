<script setup>
/**
 * ChatPanel —— 常驻右侧的沟通记录抽屉（360px，可折叠）。
 *
 * 与办公室联动：选中工位后这里只显示该成员的往来消息；点气泡里的头像可反向选中工位。
 * 自动跟随滚动：用户手动上滚则暂停跟随并显示「N 条新消息」。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import AgentAvatar from './AgentAvatar.vue';
import SearchBox from './SearchBox.vue';
import { useMessageStore } from '../stores/messages';

const props = defineProps({
  selectedId: { type: String, default: '' },
  collapsed: { type: Boolean, default: false },
});
const emit = defineEmits(['select', 'clear-select', 'update:collapsed']);

const msgs = useMessageStore();
const listEl = ref(null);

const shown = computed(() => msgs.filtered);
const selectedName = computed(() => (props.selectedId ? props.selectedId.split('@')[0] : ''));

const time = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const short = (id) => (id ? id.split('@')[0] : '');

function toBottom() {
  nextTick(() => {
    const el = listEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function onScroll() {
  const el = listEl.value;
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  if (atBottom !== msgs.autoFollow) msgs.setAutoFollow(atBottom);
}

watch(() => shown.value.length, () => {
  if (msgs.autoFollow) toBottom();
});
watch(() => msgs.autoFollow, (v) => {
  if (v) toBottom();
});
onMounted(toBottom);

/** 点气泡 = 选中该成员的工位 */
function pick(id) {
  if (!id) return;
  emit('select', id);
}
</script>

<template>
  <aside class="panel" :class="{ collapsed }" data-testid="chat-panel">
    <header>
      <button class="fold" :title="collapsed ? '展开对话' : '收起对话'" @click="emit('update:collapsed', !collapsed)">
        {{ collapsed ? '‹' : '›' }}
      </button>
      <template v-if="!collapsed">
        <h2>沟通记录</h2>
        <span class="dim count">{{ shown.length }} / {{ msgs.count }}</span>
      </template>
    </header>

    <template v-if="!collapsed">
      <div class="tools">
        <SearchBox :model-value="msgs.keyword" @update:model-value="msgs.setKeyword($event)" />
        <button v-if="selectedName" class="chip" @click="emit('clear-select')">
          仅看 {{ selectedName }} ✕
        </button>
      </div>

      <div ref="listEl" class="list" data-testid="conv-list" @scroll.passive="onScroll">
        <div
          v-for="m in shown"
          :key="m.id"
          class="bubble"
          :class="[`type-${m.type}`, { mine: selectedId && m.fromMember === selectedId }]"
          :data-testid="`msg-row-${m.id}`"
        >
          <button class="ava" :title="short(m.fromMember)" @click="pick(m.fromMember)">
            <AgentAvatar :name="m.fromMember" state="online" :size="26" />
          </button>
          <div class="body">
            <div class="meta">
              <span class="from">{{ short(m.fromMember) }}</span>
              <span class="arrow faint">→</span>
              <span class="to">{{ m.toMember ? short(m.toMember) : '全员' }}</span>
              <span class="type">{{ m.type }}</span>
              <span class="ts mono faint">{{ time(m.tsMs) }}</span>
            </div>
            <div v-if="m.subject" class="subject">{{ m.subject }}</div>
            <div class="text">{{ m.content }}</div>
          </div>
        </div>
        <p v-if="!shown.length" class="empty dim">没有匹配的消息</p>
      </div>

      <div v-if="msgs.pendingCount" class="pending" @click="msgs.setAutoFollow(true)">
        {{ msgs.pendingCount }} 条新消息 · 点击回到底部
      </div>
    </template>
  </aside>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  width: 360px;
  flex: none;
  min-height: 0;
  border-left: 1px solid var(--border);
  background: var(--bg-elevated);
  transition: width 0.18s ease;
}

.panel.collapsed {
  width: 40px;
}

header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.count {
  font-size: 11px;
}

.fold {
  padding: 2px 7px;
  line-height: 1.2;
}

.tools {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  border-color: var(--accent);
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bubble {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.ava {
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  line-height: 0;
}

.body {
  min-width: 0;
  flex: 1;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  animation: pop 0.22s ease-out;
}

.meta {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 11px;
  margin-bottom: 2px;
  flex-wrap: wrap;
}

.from {
  color: var(--accent);
  font-weight: 600;
}

.to {
  color: var(--text-dim);
}

.type {
  font-size: 10px;
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
}

.ts {
  font-size: 10px;
  margin-left: auto;
}

.subject {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 2px;
}

.text {
  font-size: 12px;
  color: var(--text-dim);
  word-break: break-word;
}

.bubble.type-block .body {
  border-color: rgba(255, 92, 92, 0.5);
}
.bubble.type-block .text {
  color: #ff9d9d;
}
.bubble.type-error .body {
  border-color: rgba(255, 92, 92, 0.5);
}
.bubble.mine .body {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.pending {
  padding: 6px 10px;
  font-size: 12px;
  text-align: center;
  background: var(--accent-soft);
  border-top: 1px solid var(--accent);
  cursor: pointer;
}

.empty {
  padding: 24px;
  text-align: center;
}

@keyframes pop {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .body {
    animation: none;
  }
}
</style>
