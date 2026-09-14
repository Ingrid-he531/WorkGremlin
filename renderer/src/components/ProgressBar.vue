<script setup>
import { computed } from 'vue';

const props = defineProps({
  /** null = 未知（agent 未上报）—— 显示"未知"而不是 0% */
  value: { type: [Number, null], default: null },
  testid: { type: String, default: '' },
});

const known = computed(() => typeof props.value === 'number' && Number.isFinite(props.value));
const pct = computed(() => (known.value ? Math.max(0, Math.min(1, props.value)) * 100 : 0));
</script>

<template>
  <div class="progress" :data-testid="testid">
    <div v-if="known" class="track">
      <div class="fill" :style="{ width: pct + '%' }" />
    </div>
    <span v-if="known" class="pct mono">{{ Math.round(pct) }}%</span>
    <span v-else class="na">进度未知（未上报）</span>
  </div>
</template>

<style scoped>
.progress {
  display: flex;
  align-items: center;
  gap: 8px;
}

.track {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--bg);
  border: 1px solid var(--border);
  overflow: hidden;
}

.fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), #6aa8ff);
  transition: width 240ms ease;
}

.pct {
  width: 40px;
  text-align: right;
  color: var(--text-dim);
}
</style>
