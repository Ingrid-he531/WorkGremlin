<script setup>
import { computed } from 'vue';
import { statusLabel, statusTone } from '../lib/memberTask';

const props = defineProps({
  state: { type: String, required: true },
  testid: { type: String, default: '' },
});

/**
 * Three status levels on the workstation card / desk sign: blocked / busy / idle.
 * The criteria are the same as elsewhere on the card (see lib/memberTask.js):
 * blocked -> blocked, busy -> busy, everything else -> idle.
 */
const label = computed(() => statusLabel(props.state));
const tone = computed(() => statusTone(props.state));
</script>

<template>
  <span
    class="badge"
    :class="`state-${tone}`"
    :data-testid="testid"
  >
    <i class="dot" />
    {{ label }}
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
.state-blocked .dot { background: var(--state-blocked); }
.state-idle .dot { background: var(--state-idle); }

.state-blocked {
  color: var(--state-blocked);
  border-color: var(--state-blocked);
}

</style>
