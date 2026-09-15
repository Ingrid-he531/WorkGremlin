<script setup>
/**
 * OfficeView —— 办公室俯视图（每个成员一张真实工位）。
 *
 * 排序把异常成员顶到前面：blocked > busy > online > idle > offline。
 * 点击工位 = 选中该成员（与右侧对话抽屉联动）。
 */
import { computed, onUnmounted, ref } from 'vue';
import DeskScene from '../components/DeskScene.vue';
import { useTeamStore } from '../stores/team';

const props = defineProps({
  selectedId: { type: String, default: '' },
});
const emit = defineEmits(['select']);

const team = useTeamStore();

const tick = ref(Date.now());
const timer = setInterval(() => {
  tick.value = Date.now();
}, 1000);
onUnmounted(() => clearInterval(timer));

/** 异常优先：保证阻塞/忙碌的成员一定在首屏 */
const desks = computed(() => {
  const order = ['blocked', 'busy', 'online', 'idle', 'offline'];
  return team.members.slice().sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
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
          :now="tick"
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
  /* 地板格纹 */
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
