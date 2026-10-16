<script setup>
import { computed } from 'vue';
import StatusBadge from './StatusBadge.vue';
import { formatClock } from '@workgremlin/shared';
import { summonTaskOf, summonTaskStartedAt, summonTaskTitle } from '../lib/memberTask';
import { useI18n } from '../i18n';

const { t } = useI18n();

const props = defineProps({
  member: { type: Object, required: true },
  /** All members of the same project (including summon ghosts): when a minion is summoned, its current task borrows the entry from the ghost with the same name */
  members: { type: Array, default: () => [] },
});

/** The main agent and subagents each show their own task description on the workstation card; this switch tells them apart */
const isSubagent = computed(() => props.member.role && props.member.role.startsWith('subagent'));

/** Current task: for the definition see lib/memberTask.js (when idle, the slot entry is the **previous task** and does not count as the current one).
 *  A minion does not hold a task itself (the task lives on the `subagent-<name>` ghost) → borrow the running ghost with the same name. */
const currentTask = computed(() => summonTaskOf(props.member, props.members));
/** Whether the current task is in progress (drives the mutually exclusive "elapsed / last active" display) */
const hasTask = computed(() => Boolean(currentTask.value));
/** This slot is always present: it honestly shows "Idle" when there is no current task, so the previous task is not left on the card */
const taskTitle = computed(() => summonTaskTitle(props.member, props.members) || t('card.idle'));

/** Short id: coder@workgremlin -> coder (used for data-testid to keep selectors stable) */
const agentId = computed(() => props.member.memberId.split('@')[0]);
/**
 * Both time points use an **absolute clock** (MM-DD HH:mm), not the "how long ago" relative duration:
 *   · Started    = start time of the current task (the absolute value of the former "elapsed")
 *   · Last active = finish time of the previous task (the most recent finished task)
 * Relative durations need the UI to recompute every second; once that recomputation breaks you get "1F's last active frozen while 3F's elapsed keeps climbing",
 * these two behaviors on the same screen (measured by the user on 2026-09-30). Hard-coded time points need no timer and never miss a refresh.
 */
const startAt = computed(() => formatClock(summonTaskStartedAt(props.member, props.members) || props.member.stateSince));
const lastActiveAt = computed(() => formatClock(props.member.lastTaskAt) || '—');

/** Role text: on the workstation card the main agent and subagents are shown in Chinese; project-level / user-level subagents are labeled separately. */
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
      <!-- Once truncated the full text cannot be read, so the whole sentence is attached to the native title: hovering shows it in full,
           no need to add a popover for it or spare any card space (it need not be attached when taskTitle is "Idle") -->
      <div class="task-title" :class="{ na: !hasTask }" :title="hasTask ? taskTitle : null">{{ taskTitle }}</div>
      <!-- Progress bar temporarily removed (2026-09-29): task.progress has no real value —— 0 when starting, 1 when finishing,
           nothing advances it in between (all 489 tasks in the local store fall in {0,1}, see the "progress" row of TaskRecordsView),
           so drawing it would only show two states, "empty bar" and "full bar", which is reporting a progress that does not exist.
           Once real progress exists, hook ProgressBar back up (it itself renders null as "progress unknown (not reported)"). -->
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

/*
 * The height of the "current task" block is hardcoded to two lines, and anything that does not fit is cut off with an ellipsis —— the card must not be stretched taller by the title.
 *
 * Why the height must be hardcoded: a card is one cell of the grid (WorkstationView's .grid), and the tallest one in a row
 * decides the height of the whole row. A long title would pull the whole row of workstations taller together, and the moment a title grows a row of cards grows with it,
 * so no flush edges can be found on screen anymore —— glancing to recognize a workstation is ruined.
 *
 * Why two lines: to match the same sentence on the DeskScene monitor (.scr-title), which is also truncated at 2 lines.
 * A short title still fills both lines (it is not "tall when long, short when short"), so the card height is therefore independent of title length.
 */
.task-title {
  margin: 2px 0 6px;
  /* line-height × line count = fixed block height: em follows its own font size, so changing the font size needs no change here */
  line-height: 1.4;
  height: calc(1.4em * 2);
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  /* Long runs without spaces (English titles / file paths) must wrap too, otherwise they get hard-cut with no ellipsis */
  overflow-wrap: anywhere;
}

/* With no current task that cell reads "Idle" —— not attention-grabbing, but not left blank */
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
