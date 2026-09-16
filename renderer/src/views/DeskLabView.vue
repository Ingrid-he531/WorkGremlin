<script setup>
/**
 * DeskLabView —— 工位设计台（调造型/动效用）。
 *
 * 不依赖真实数据：把 5 种状态各渲染一个大工位 + 一排实际尺寸的工位，
 * 方便对照着改配色、比例、动画，而不用等服务里正好出现某个状态。
 */
import { computed, onUnmounted, ref } from 'vue';
import DeskScene from '../components/DeskScene.vue';
import { useTeamStore } from '../stores/team';

const team = useTeamStore();

const tick = ref(Date.now());
const timer = setInterval(() => {
  tick.value = Date.now();
}, 1000);
onUnmounted(() => clearInterval(timer));

const ROLES = ['leader', 'coder', 'researcher', 'tester', 'reviewer', 'ops'];
const STATES = ['online', 'busy', 'idle', 'blocked', 'thinking', 'offline'];

/** @param {number} i @param {string} state */
function makeMember(i, state) {
  const role = ROLES[i % ROLES.length];
  return {
    memberId: `${role}@workgremlin`,
    name: role,
    role,
    state,
    degraded: state === 'offline',
    reported: state !== 'offline',
    stateSince: Date.now() - (90 + i * 37) * 1000,
    lastSeenAt: Date.now() - (state === 'offline' ? 300 : 5) * 1000,
    messageCount: 0,
    task:
      state === 'busy' || state === 'blocked' || state === 'thinking'
        ? { id: role, title: '实现工位视图与对话记录窗口', progress: state === 'blocked' ? 0.34 : 0.62 }
        : null,
    currentFiles: state === 'busy' || state === 'thinking' ? ['renderer/src/components/DeskScene.vue', 'server/src/ingest/bus.js'] : [],
    artifacts: [],
  };
}

const big = computed(() => STATES.map((s, i) => makeMember(i, s)));
const grid = computed(() => ROLES.map((r, i) => makeMember(i, STATES[i % STATES.length])));
const live = computed(() => team.members);
</script>

<template>
  <div class="lab">
    <p class="hint dim">
      同一张工位的 5 种状态（大图用于看细节，下面一排是办公室里的真实尺寸）。
      有真实数据时最下方会显示线上成员。
    </p>

    <div class="big-row">
      <div v-for="m in big" :key="m.memberId" class="big-cell">
        <DeskScene :member="m" :now="tick" />
        <div class="cap mono">{{ m.state }}</div>
      </div>
    </div>

    <h3 class="sec">实际尺寸（办公室网格）</h3>
    <div class="grid">
      <DeskScene v-for="m in grid" :key="m.memberId" :member="m" :now="tick" />
    </div>

    <template v-if="live.length">
      <h3 class="sec">线上成员（真实数据）</h3>
      <div class="grid">
        <DeskScene v-for="m in live" :key="m.memberId" :member="m" :now="tick" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.lab {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
}

.hint {
  margin: 0 0 12px;
  font-size: 12px;
}

.big-row {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  padding-bottom: 6px;
}

.big-cell {
  flex: none;
  width: 340px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.cap {
  font-size: 11px;
  color: var(--text-faint);
}

.sec {
  margin: 18px 0 10px;
  font-size: 13px;
  font-weight: 600;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(252px, 1fr));
  gap: 16px;
}
</style>
