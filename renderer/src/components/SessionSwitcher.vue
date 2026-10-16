<script setup>
import { computed } from 'vue';
import { useI18n } from '../i18n';

const { t } = useI18n();

/**
 * Session dropdown: directly lists the active sessions of the **currently selected floor** (flat, no floor heading).
 * Switching floors swaps the batch automatically; when that floor has no active sessions → the dropdown is disabled and shows the placeholder text.
 */
const props = defineProps({
  /** [{ value, label, title }] —— already the sessions of the current floor */
  items: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
  emptyLabel: { type: String, default: '' },
});

const emit = defineEmits(['update:modelValue']);

const count = computed(() => props.items.length);

/** Hover tip: when there are sessions, show the count; only with no sessions show the placeholder reason.
 *  It used to be hardcoded to emptyLabel, so even with sessions the hover tip said "no active sessions", which was misleading. */
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
