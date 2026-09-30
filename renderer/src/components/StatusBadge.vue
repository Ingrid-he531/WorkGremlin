<script setup>
import { computed } from 'vue';
import { statusLabel, statusTone } from '../lib/memberTask';

const props = defineProps({
  state: { type: String, required: true },
  degraded: { type: Boolean, default: false },
  testid: { type: String, default: '' },
});

/**
 * 工位卡 / 桌牌上的状态只分两档：忙碌 / 空闲（用户 2026-09-30 的要求）。
 * 判据与卡片其它地方同一份（见 lib/memberTask.js）—— busy/thinking/blocked = 在干活 → 忙碌。
 */
const label = computed(() => statusLabel(props.state));
const tone = computed(() => statusTone(props.state));
</script>

<template>
  <span
    class="badge"
    :class="[`state-${tone}`, { degraded }]"
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
  background: var(--state-idle);
}

.state-busy .dot { background: var(--state-busy); }
.state-idle .dot { background: var(--state-idle); }

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
