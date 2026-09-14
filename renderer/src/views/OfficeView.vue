<script setup>
/**
 * OfficeView —— 办公室俯视图。
 *
 * 每个成员一张工位：显示器（任务 + 进度 + 正在读写的文件）、桌面（状态灯）、
 * 座椅上的形象、桌牌（姓名 / 角色 / 状态徽标）。
 * 点击工位 = 选中该成员（用于与右侧对话抽屉联动）。
 *
 * 人一多（> 6）自动切紧凑尺寸，避免工位被压扁。
 */
import { computed, onUnmounted, ref } from 'vue';
import AgentAvatar from '../components/AgentAvatar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import ProgressBar from '../components/ProgressBar.vue';
import { useTeamStore } from '../stores/team';
import { formatDuration } from '@workgremlin/shared';

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

/** 异常优先：blocked > busy > online > idle > offline，保证异常成员在首屏 */
const desks = computed(() => {
  const order = ['blocked', 'busy', 'online', 'idle', 'offline'];
  return team.members
    .slice()
    .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
});

const compact = computed(() => desks.value.length > 6);

const agentId = (m) => m.memberId.split('@')[0];
const elapsed = (m) => formatDuration(tick.value - m.stateSince);
</script>

<template>
  <div class="office" :class="{ compact }">
    <div class="floor">
      <div v-if="!desks.length" class="empty dim">还没有成员。启动服务后会自动出现工位。</div>

      <div v-else class="desks">
        <div
          v-for="m in desks"
          :key="m.memberId"
          class="desk"
          :class="[`state-${m.state}`, { selected: selectedId === m.memberId, 'is-degraded': m.degraded }]"
          :data-testid="`desk-${agentId(m)}`"
          @click="emit('select', m.memberId)"
        >
          <!-- 显示器 -->
          <div class="monitor">
            <div class="screen">
              <div class="screen-row">
                <span class="screen-label">当前任务</span>
                <span class="screen-elapsed mono">{{ elapsed(m) }}</span>
              </div>
              <div class="screen-task">{{ m.task ? m.task.title : '空闲 / 无进行中任务' }}</div>
              <ProgressBar :value="m.task ? m.task.progress : null" />
              <ul v-if="m.currentFiles.length" class="screen-files mono">
                <li v-for="f in m.currentFiles.slice(0, 2)" :key="f">{{ f }}</li>
              </ul>
              <div v-else class="screen-files faint">未上报文件</div>
            </div>
            <div class="stand" />
          </div>

          <!-- 桌面 + 状态灯 -->
          <div class="surface">
            <span class="lamp" :title="m.state" />
            <span class="mug" />
            <span class="paper" />
          </div>

          <!-- 座椅 + 形象 -->
          <div class="seat">
            <AgentAvatar :name="m.memberId" :state="m.state" :degraded="m.degraded" :size="compact ? 54 : 68" />
          </div>

          <!-- 桌牌 -->
          <div class="plate">
            <span class="name">{{ m.name }}</span>
            <span class="role dim">{{ m.role || '—' }}</span>
            <StatusBadge
              :state="m.state"
              :degraded="m.degraded"
              :testid="`seat-status-${agentId(m)}`"
            />
          </div>
        </div>
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
  grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
  gap: 18px;
  align-content: start;
}

.desk {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 10px 10px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-panel);
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
}

.desk:hover {
  border-color: var(--border-strong);
  transform: translateY(-2px);
}

.desk.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-soft), 0 6px 18px rgba(0, 0, 0, 0.35);
}

.desk.is-degraded {
  border-style: dashed;
}

/* ---- 显示器 ---- */
.monitor {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}

.screen {
  width: 100%;
  min-height: 104px;
  padding: 7px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: #0b0e13;
  box-shadow: inset 0 0 18px rgba(76, 141, 255, 0.06);
  display: flex;
  flex-direction: column;
  gap: 5px;
  text-align: left;
}

.screen-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.screen-label {
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--text-faint);
  text-transform: uppercase;
}

.screen-elapsed {
  font-size: 10px;
  color: var(--text-faint);
}

.screen-task {
  font-size: 12px;
  line-height: 1.35;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.screen-files {
  margin: 2px 0 0;
  padding-left: 13px;
  font-size: 10px;
  color: var(--text-dim);
  list-style: square;
}

.screen-files li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stand {
  width: 26px;
  height: 7px;
  background: var(--border-strong);
  border-radius: 0 0 3px 3px;
}

/* ---- 桌面 ---- */
.surface {
  position: relative;
  width: 88%;
  height: 16px;
  border-radius: 3px;
  background: linear-gradient(180deg, #3a4152, #2a303c);
  border: 1px solid #454e60;
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.35);
}

.lamp {
  position: absolute;
  left: 7px;
  top: -5px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--state-offline);
  box-shadow: 0 0 6px currentColor;
}

.state-online .lamp {
  background: var(--state-online);
  color: var(--state-online);
}
.state-busy .lamp {
  background: var(--state-busy);
  color: var(--state-busy);
  animation: blink 1s ease-in-out infinite;
}
.state-idle .lamp {
  background: var(--state-idle);
  color: var(--state-idle);
}
.state-blocked .lamp {
  background: var(--state-blocked);
  color: var(--state-blocked);
  animation: blink 0.5s steps(1, end) infinite;
}

.mug {
  position: absolute;
  right: 10px;
  top: -7px;
  width: 8px;
  height: 9px;
  border-radius: 1px 1px 3px 3px;
  background: #d8dde6;
}

.paper {
  position: absolute;
  right: 26px;
  top: -3px;
  width: 14px;
  height: 5px;
  background: #dfe4ec;
  border-radius: 1px;
  transform: rotate(-4deg);
}

/* ---- 座椅 ---- */
.seat {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  min-height: 60px;
}

/* ---- 桌牌 ---- */
.plate {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
  padding-top: 4px;
  border-top: 1px solid var(--border);
  width: 100%;
}

.name {
  font-weight: 600;
}

.role {
  font-size: 11px;
}

.compact .desks {
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 12px;
}

.compact .screen {
  min-height: 84px;
}

.compact .screen-task {
  -webkit-line-clamp: 1;
}

.compact .seat {
  min-height: 46px;
}

.empty {
  padding: 40px;
  text-align: center;
}

@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lamp {
    animation: none !important;
  }
}
</style>
