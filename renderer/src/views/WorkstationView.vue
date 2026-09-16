<script setup>
import { computed } from 'vue';
import WorkstationCard from '../components/WorkstationCard.vue';
import { useTeamStore } from '../stores/team';

const team = useTeamStore();

const sorted = computed(() => {
  const order = ['blocked', 'busy', 'thinking', 'online', 'idle', 'offline'];
  return team.members.slice().sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
});
</script>

<template>
  <div class="view">
    <div class="summary">
      <span v-for="(n, s) in team.stateCounts" :key="s" class="pill" :class="`state-${s}`">
        {{ s }} · {{ n }}
      </span>
      <span v-if="team.degradedCount" class="pill warn">推断值 {{ team.degradedCount }}</span>
    </div>

    <div class="grid">
      <WorkstationCard v-for="m in sorted" :key="m.memberId" :member="m" />
    </div>

    <p v-if="!team.members.length" class="empty dim">暂无成员数据</p>
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
