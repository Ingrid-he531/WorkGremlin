<script setup>
import { computed, onUnmounted, ref } from 'vue';
import StatusBadge from './StatusBadge.vue';
import ProgressBar from './ProgressBar.vue';
import { formatDuration } from '@workgremlin/shared';

const props = defineProps({
  member: { type: Object, required: true },
});

const tick = ref(Date.now());
const timer = setInterval(() => {
  tick.value = Date.now();
}, 1000);
onUnmounted(() => clearInterval(timer));

/** 短 id：coder@workgremlin -> coder（用于 data-testid，保证选择器稳定） */
const agentId = computed(() => props.member.memberId.split('@')[0]);
const elapsed = computed(() => formatDuration(tick.value - props.member.stateSince));
const lastSeen = computed(() => formatDuration(tick.value - props.member.lastSeenAt));
</script>

<template>
  <section class="card" :data-testid="`seat-card-${agentId}`" :class="{ 'is-degraded': member.degraded }">
    <header>
      <div class="who">
        <h3>{{ member.name }}</h3>
        <span class="role dim">{{ member.role || '—' }}</span>
      </div>
      <StatusBadge
        :state="member.state"
        :degraded="member.degraded"
        :testid="`seat-status-${agentId}`"
      />
    </header>

    <div v-if="member.degraded" class="watcher-banner" :data-testid="`seat-degraded-${agentId}`">
      状态为推断值：该成员未上报心跳（&gt;60s）
    </div>

    <div class="task">
      <div class="label dim">当前任务</div>
      <div v-if="member.task" class="task-title">{{ member.task.title }}</div>
      <div v-else class="na">空闲 / 无进行中任务</div>
      <ProgressBar :value="member.task ? member.task.progress : null" :testid="`seat-progress-${agentId}`" />
    </div>

    <div class="row">
      <div class="label dim">正在读写</div>
      <ul v-if="member.currentFiles.length" class="files mono">
        <li v-for="f in member.currentFiles.slice(0, 3)" :key="f">{{ f }}</li>
      </ul>
      <span v-else class="na">未上报</span>
    </div>

    <div class="row">
      <div class="label dim">最近产出</div>
      <ul v-if="member.artifacts.length" class="artifacts">
        <li v-for="a in member.artifacts" :key="a.id ?? a.title">{{ a.title }}</li>
      </ul>
      <span v-else class="na">—</span>
    </div>

    <footer>
      <span class="mono dim">已耗时 {{ elapsed }}</span>
      <span class="mono faint">最近活跃 {{ lastSeen }}前</span>
      <span class="mono faint">消息 {{ member.messageCount }}</span>
      <span v-if="!member.reported" class="tag">被动观测</span>
    </footer>
  </section>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.card.is-degraded {
  border-style: dashed;
}

header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

h3 {
  margin: 0;
  font-size: 15px;
}

.role {
  font-size: 12px;
}

.watcher-banner {
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: #ffd08a;
  background: rgba(245, 166, 35, 0.1);
  border: 1px solid rgba(245, 166, 35, 0.35);
}

.label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.task-title {
  margin: 2px 0 6px;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

ul {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
}

.artifacts {
  list-style: none;
  padding-left: 0;
}

footer {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}

.tag {
  padding: 0 6px;
  border-radius: 4px;
  border: 1px solid var(--border-strong);
  color: var(--text-faint);
}
</style>
