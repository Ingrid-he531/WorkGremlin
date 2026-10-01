<script setup>
import { computed } from 'vue';
import { useI18n } from '../i18n';

const { t } = useI18n();

/**
 * 会话下拉：直接列出**当前选中楼层**的活跃会话（扁平，不显示楼层标题）。
 * 切楼层时自动换一批；该层没有活跃会话 → 下拉禁用，显示占位文案。
 */
const props = defineProps({
  /** [{ value, label, title }] —— 已是当前楼层的会话 */
  items: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
  emptyLabel: { type: String, default: '' },
});

const emit = defineEmits(['update:modelValue']);

const count = computed(() => props.items.length);

/** 悬停提示：有会话时显示数量，没会话时才显示占位原因。
 *  之前写死成 emptyLabel，导致即使有会话 hover 也提示"没有活跃会话"，属误导。 */
const title = computed(() =>
  count.value ? t('session.active_sessions', { n: count.value }) : props.emptyLabel || t('session.empty_no_project')
);
</script>

<template>
  <select
    data-testid="session-switcher"
    class="session-switcher"
    :class="{ empty: !count }"
    :disabled="!count"
    :value="modelValue"
    :title="title"
    @change="emit('update:modelValue', $event.target.value)"
  >
    <option v-if="!count" value="">{{ props.emptyLabel }}</option>
    <option v-for="o in props.items" :key="o.value" :value="o.value" :title="o.title">
      {{ o.label }}
    </option>
  </select>
</template>
