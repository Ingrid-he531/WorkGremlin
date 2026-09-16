<script setup>
import { computed } from 'vue';

/**
 * 会话下拉：直接列出**当前选中楼层**的活跃会话（扁平，不显示楼层标题）。
 * 切楼层时自动换一批；该层没有活跃会话 → 下拉禁用，显示占位文案。
 */
const props = defineProps({
  /** [{ value, label, title }] —— 已是当前楼层的会话 */
  items: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
  emptyLabel: { type: String, default: '没有打开的工程' },
});

const emit = defineEmits(['update:modelValue']);

const count = computed(() => props.items.length);
</script>

<template>
  <select
    data-testid="session-switcher"
    class="session-switcher"
    :class="{ empty: !count }"
    :disabled="!count"
    :value="modelValue"
    :title="emptyLabel"
    @change="emit('update:modelValue', $event.target.value)"
  >
    <option v-if="!count" value="">{{ props.emptyLabel }}</option>
    <option v-for="o in props.items" :key="o.value" :value="o.value" :title="o.title">
      {{ o.label }}
    </option>
  </select>
</template>
