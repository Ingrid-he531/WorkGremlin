<script setup>
import { computed, onUnmounted, ref } from 'vue';
import StatusBadge from './StatusBadge.vue';
import { formatDuration } from '@workgremlin/shared';
import { currentTaskOf, currentTaskStartedAt, currentTaskTitle } from '../lib/memberTask';

const props = defineProps({
  member: { type: Object, required: true },
});

const tick = ref(Date.now());
const timer = setInterval(() => {
  tick.value = Date.now();
}, 1000);
onUnmounted(() => clearInterval(timer));

/** 主 agent 与子代理在工位卡片上分别展示自己的任务描述，用这个开关区分 */
const isSubagent = computed(() => props.member.role && props.member.role.startsWith('subagent'));

/** 当前任务：口径见 lib/memberTask.js（空闲时槽位里那条是**上一个任务**，不算当前任务） */
const currentTask = computed(() => currentTaskOf(props.member));
/** 当前任务是否进行中（驱动"已耗时 / 最近活跃"的互斥显示） */
const hasTask = computed(() => Boolean(currentTask.value));
/** 这一栏常驻：没有当前任务时如实写「空闲」，不把上一次的任务留在卡片上 */
const taskTitle = computed(() => currentTaskTitle(props.member) || '空闲');

/** 短 id：coder@workgremlin -> coder（用于 data-testid，保证选择器稳定） */
const agentId = computed(() => props.member.memberId.split('@')[0]);
/** 已耗时 = **当前任务**的已耗时（从这一轮任务开工算起），不是状态停留时长 */
const elapsed = computed(() => formatDuration(tick.value - (currentTaskStartedAt(props.member) || props.member.stateSince)));
/** 最近活跃 = 上一个任务在多久以前（最近一条已收工任务的收工时刻），不是最后一次心跳 */
const lastActiveAgo = computed(() => {
  const at = Number(props.member.lastTaskAt || 0);
  return at ? formatDuration(tick.value - at) : '';
});

/** 角色文案：主 agent 与子代理在工位卡片上显示为中文；项目级 / 用户级子代理分开标注。 */
const ROLE_LABELS = {
  agent: '主代理',
  'subagent:project': '项目子代理',
  'subagent:user': '用户子代理',
};
const roleLabel = computed(() => {
  const r = props.member.role;
  if (!r) return '—';
  return ROLE_LABELS[r] || (r === 'subagent' ? '用户子代理' : r);
});
</script>

<template>
  <section class="card" :data-testid="`seat-card-${agentId}`" :class="{ 'is-degraded': member.degraded }">
    <header>
      <div class="who">
        <h3>{{ member.name }}</h3>
        <span class="role dim">{{ roleLabel }}</span>
      </div>
      <StatusBadge
        :state="member.state"
        :degraded="member.degraded"
        :testid="`seat-status-${agentId}`"
      />
    </header>

    <div class="task">
      <div class="label dim">当前任务</div>
      <div class="task-title" :class="{ na: !hasTask }">{{ taskTitle }}</div>
      <!-- 进度条暂时去掉（2026-09-29）：task.progress 没有真值 —— 开工 0、收工 1，
           中间没人推进它（本机库 489 条任务全落在 {0,1}，见 TaskRecordsView「进度」那行），
           画出来只有"空条"和"满条"两种状态，等于报了个不存在的进度。
           将来有了真进度再把 ProgressBar 接回来（它自己会把 null 显示成「进度未知（未上报）」）。 -->
      <!-- <ProgressBar :value="member.task ? member.task.progress : null" :testid="`seat-progress-${agentId}`" /> -->
    </div>

    <div v-if="isSubagent && member.description" class="subagent-desc" :data-testid="`seat-desc-${agentId}`">
      <span class="dim">描述</span>
      <div class="desc-text">{{ member.description }}</div>
    </div>

    <footer>
      <span v-if="hasTask" class="mono dim">已耗时 {{ elapsed }}</span>
      <span v-else class="mono dim">最近活跃 {{ lastActiveAgo ? `${lastActiveAgo}前` : '—' }}</span>
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

.label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.task-title {
  margin: 2px 0 6px;
}

/* 没有当前任务时那一栏写「空闲」——不抢眼，但不留空 */
.task-title.na {
  color: var(--text-faint);
}

.row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.subagent-desc {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-base);
  border: 1px solid var(--border);
  font-size: 13px;
}

.desc-text {
  margin-top: 2px;
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
