<script setup>
import { computed } from 'vue';

const props = defineProps({
  message: { type: Object, required: true },
});

const time = computed(() => {
  const d = new Date(props.message.tsMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
});

const short = (id) => (id ? id.split('@')[0] : '');
</script>

<template>
  <div class="row" :data-testid="`msg-row-${message.id}`" :class="`type-${message.type}`">
    <span class="ts mono faint">{{ time }}</span>
    <span class="from">{{ short(message.fromMember) }}</span>
    <span class="arrow faint">→</span>
    <span class="to">{{ message.toMember ? short(message.toMember) : '全员' }}</span>
    <span class="type" :title="message.type">{{ message.type }}</span>
    <span v-if="message.subject" class="subject">{{ message.subject }}</span>
    <span class="content">{{ message.content }}</span>
    <span v-if="message.source === 'watch'" class="src faint" title="来自目录监听兜底">watch</span>
  </div>
</template>

<style scoped>
.row {
  display: grid;
  grid-template-columns: 62px 78px 14px 78px 78px auto 1fr auto;
  gap: 8px;
  align-items: baseline;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 12px;
}

.row:hover {
  background: var(--bg-panel);
}

.from {
  color: var(--accent);
}

.type {
  color: var(--text-faint);
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
  justify-self: start;
}

.subject {
  color: var(--text);
  font-weight: 600;
}

.content {
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.type-block .content {
  color: #ff9d9d;
}

.src {
  font-size: 11px;
}
</style>
