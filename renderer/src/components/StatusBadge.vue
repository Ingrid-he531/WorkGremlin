<script setup>
import { computed } from 'vue';
import { STATE_LABELS } from '@workgremlin/shared';

const props = defineProps({
  state: { type: String, required: true },
  degraded: { type: Boolean, default: false },
  testid: { type: String, default: '' },
});

const label = computed(() => STATE_LABELS[props.state] || props.state);
</script>

<template>
  <span
    class="badge"
    :class="[`state-${state}`, { degraded }]"
    :data-testid="testid"
    :title="degraded ? '状态为推断值（非 agent 上报真值）' : 'agent 上报真值'"
  >
    <i class="dot" />
    {{ label }}
    <em v-if="degraded" class="degraded-tag">推断</em>
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid var(--border-strong);
  background: var(--bg-panel);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--state-offline);
}

.state-online .dot { background: var(--state-online); }
.state-busy .dot { background: var(--state-busy); }
.state-idle .dot { background: var(--state-idle); }
.state-blocked .dot { background: var(--state-blocked); }
.state-offline .dot { background: var(--state-offline); }

.badge.degraded {
  opacity: 0.62;
  border-style: dashed;
}

.degraded-tag {
  font-style: normal;
  font-size: 11px;
  color: var(--text-faint);
}
</style>
