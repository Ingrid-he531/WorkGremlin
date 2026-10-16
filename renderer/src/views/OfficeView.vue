<script setup>
/**
 * OfficeView —— top-down view of the office (a real workstation per member).
 *
 * Sorting pushes anomalous members to the front: blocked > busy > online > idle > offline.
 * Clicking a workstation = selecting that member (wired to the conversation drawer on the right).
 */
import { computed } from 'vue';
import DeskScene from '../components/DeskScene.vue';
import { useProjectStore } from '../stores/project';

const props = defineProps({
  selectedId: { type: String, default: '' },
});
const emit = defineEmits(['select']);

const project = useProjectStore();

/** Anomalous first: makes sure blocked/busy members are always on the first screen */
const desks = computed(() => {
  const order = ['blocked', 'busy', 'online', 'idle', 'offline'];
  return project.members.slice().sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
});
</script>

<template>
  <div class="office">
    <div class="floor">
      <div v-if="!desks.length" class="empty dim">还没有成员。启动服务后会自动出现工位。</div>

      <div v-else class="desks">
        <DeskScene
          v-for="m in desks"
          :key="m.memberId"
          :member="m"
          :selected="selectedId === m.memberId"
          @select="emit('select', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.office {
  height: 100%;
  min-height: 0;
}

.floor {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background-color: var(--bg-elevated);
  /* Floor grid pattern */
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.022) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.022) 1px, transparent 1px);
  background-size: 28px 28px;
}

.desks {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(252px, 1fr));
  gap: 16px;
  align-content: start;
}

.empty {
  padding: 40px;
  text-align: center;
}
</style>
