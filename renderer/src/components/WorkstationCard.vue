<script setup>
import { computed } from 'vue';
import StatusBadge from './StatusBadge.vue';
import { formatClock } from '@workgremlin/shared';
import { currentTaskOf, currentTaskStartedAt, currentTaskTitle } from '../lib/memberTask';
import { useI18n } from '../i18n';

const { t } = useI18n();

const props = defineProps({
  member: { type: Object, required: true },
});

/** 主 agent 与子代理在工位卡片上分别展示自己的任务描述，用这个开关区分 */
const isSubagent = computed(() => props.member.role && props.member.role.startsWith('subagent'));

/** 当前任务：口径见 lib/memberTask.js（空闲时槽位里那条是**上一个任务**，不算当前任务） */
const currentTask = computed(() => currentTaskOf(props.member));
/** 当前任务是否进行中（驱动"已耗时 / 最近活跃"的互斥显示） */
const hasTask = computed(() => Boolean(currentTask.value));
/** 这一栏常驻：没有当前任务时如实写「空闲」，不把上一次的任务留在卡片上 */
const taskTitle = computed(() => currentTaskTitle(props.member) || t('card.idle'));

/** 短 id：coder@workgremlin -> coder（用于 data-testid，保证选择器稳定） */
const agentId = computed(() => props.member.memberId.split('@')[0]);
/**
 * 两个时间点都用**绝对时刻**（MM-DD HH:mm），不走"多久以前"的相对时长：
 *   · 开始     = 当前任务开工时刻（原「已耗时」的绝对值）
 *   · 最近活跃 = 上一个任务收工时刻（最近一条已收工任务）
 * 相对时长要求界面每秒重算，重算一旦断掉就会出现"1F 的最近活跃不动、3F 的已耗时还在涨"
 * 这种同一屏两种行为（用户 2026-09-30 实测）。写死的时间点不需要定时器，也不会漏刷。
 */
const startAt = computed(() => formatClock(currentTaskStartedAt(props.member) || props.member.stateSince));
const lastActiveAt = computed(() => formatClock(props.member.lastTaskAt) || '—');

/** 角色文案：主 agent 与子代理在工位卡片上显示为中文；项目级 / 用户级子代理分开标注。 */
const roleLabel = computed(() => {
  const r = props.member.role;
  if (!r) return '—';
  if (r === 'agent') return t('card.role.agent');
  if (r === 'subagent:project') return t('card.role.subagent_project');
  if (r === 'subagent:user' || r === 'subagent') return t('card.role.subagent_user');
  return r;
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
      <div class="label dim">{{ t('card.current_task') }}</div>
      <div class="task-title" :class="{ na: !hasTask }">{{ taskTitle }}</div>
      <!-- 进度条暂时去掉（2026-09-29）：task.progress 没有真值 —— 开工 0、收工 1，
           中间没人推进它（本机库 489 条任务全落在 {0,1}，见 TaskRecordsView「进度」那行），
           画出来只有"空条"和"满条"两种状态，等于报了个不存在的进度。
           将来有了真进度再把 ProgressBar 接回来（它自己会把 null 显示成「进度未知（未上报）」）。 -->
      <!-- <ProgressBar :value="member.task ? member.task.progress : null" :testid="`seat-progress-${agentId}`" /> -->
    </div>

    <div v-if="isSubagent && member.description" class="subagent-desc" :data-testid="`seat-desc-${agentId}`">
      <span class="dim">{{ t('card.description') }}</span>
      <div class="desc-text">{{ member.description }}</div>
    </div>

    <footer>
      <span v-if="hasTask" class="mono dim">{{ t('card.started', { time: startAt }) }}</span>
      <span v-else class="mono dim">{{ t('card.last_active', { time: lastActiveAt }) }}</span>
      <span v-if="!member.reported" class="tag">{{ t('card.passive') }}</span>
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
