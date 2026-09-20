<script setup>
import { computed } from 'vue';
import WorkstationCard from '../components/WorkstationCard.vue';
import { useProjectStore } from '../stores/project';
import { useSessionStore } from '../stores/sessions';

const project = useProjectStore();
const sessions = useSessionStore();

const sorted = computed(() => {
  const order = ['blocked', 'busy', 'thinking', 'online', 'idle', 'offline'];
  // 与办公室同一口径：按当前楼层的客户端过滤（client 为空的视作通用）
  const want = sessions.selectedClient;
  return project.members
    .filter((m) => !want || !m.client || m.client === want)
    .slice()
    .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
});
</script>

<template>
  <div class="view">
    <div class="summary">
      <span v-for="(n, s) in project.stateCounts" :key="s" class="pill" :class="`state-${s}`">
        {{ s }} · {{ n }}
      </span>
      <span v-if="project.degradedCount" class="pill warn">推断值 {{ project.degradedCount }}</span>
    </div>

    <div class="grid">
      <WorkstationCard v-for="m in sorted" :key="m.memberId" :member="m" />
    </div>

    <p v-if="!sorted.length" class="empty dim">本层暂无成员</p>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
}

.summary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.pill {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  font-size: 12px;
  color: var(--text-dim);
}

.pill.warn {
  border-style: dashed;
}

.grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--gap);
  align-content: start;
}

.empty {
  padding: 32px;
  text-align: center;
}
</style>
