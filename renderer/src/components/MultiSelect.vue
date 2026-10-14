<script setup>
/**
 * A checkbox dropdown for multi-value filters.
 *
 * Native `<select multiple>` needs Ctrl/Cmd-click and shows almost nothing, so this uses
 * `<details>` + checkboxes: the summary shows the current selection and the body is a checkbox
 * list. `<details>` handles open/close natively, so there is no click-outside listener and it
 * renders fine under SSR.
 *
 * `modelValue` is the array of selected option values. An empty array means "no filter" (= all), and
 * in that state every checkbox shows as checked and the summary falls back to `allLabel`
 * (e.g. "All projects"). Toggling an item off switches to an explicit selection; selecting every item
 * again collapses back to the empty "all" state.
 */
import { computed } from 'vue';
import { useI18n } from '../i18n';

const props = defineProps({
  modelValue: { type: Array, required: true },
  options: { type: Array, required: true },
  allLabel: { type: String, default: '' },
  ariaLabel: { type: String, default: '' },
});

const emit = defineEmits(['update:modelValue']);

const { t } = useI18n();

const allValues = computed(() => props.options.map((o) => o.value));

/** Summary text: the single selected label, or the count when several are selected, or `allLabel` when none. */
const summaryText = computed(() => {
  const n = props.modelValue.length;
  if (!n) return props.allLabel;
  if (n === 1) {
    const hit = props.options.find((o) => o.value === props.modelValue[0]);
    return hit ? hit.label : props.allLabel;
  }
  return t('records.filter.selected_n', { n });
});

/** An empty modelValue means "all", so in that state every option reads as checked. */
function isChecked(value) {
  return props.modelValue.length === 0 || props.modelValue.includes(value);
}

function toggle(value) {
  // Work off the effective set: an empty modelValue stands for "all options selected".
  const current = props.modelValue.length ? props.modelValue : allValues.value;
  const next = current.filter((v) => v !== value);
  if (next.length === current.length) next.push(value); // the value was not selected → select it
  // Having every option selected is the same as "all" → collapse back to the empty representation.
  emit('update:modelValue', next.length === allValues.value.length ? [] : next);
}
</script>

<template>
  <details class="msel">
    <summary class="msel-btn" :aria-label="ariaLabel" :title="summaryText">
      <span class="msel-text">{{ summaryText }}</span>
      <span class="msel-caret" aria-hidden="true">▾</span>
    </summary>
    <div class="msel-menu" role="listbox" aria-multiselectable="true">
      <label v-for="o in options" :key="o.value" class="msel-opt">
        <input type="checkbox" :checked="isChecked(o.value)" @change="toggle(o.value)" />
        <span class="msel-opt-text">{{ o.label }}</span>
      </label>
      <div v-if="!options.length" class="msel-empty">—</div>
    </div>
  </details>
</template>

<style scoped>
.msel { position: relative; }
.msel-btn {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 4px 8px;
  min-width: 120px;
  max-width: 200px;
  cursor: pointer;
}
.msel-btn::-webkit-details-marker { display: none; }
.msel-btn:hover { border-color: var(--accent); }
.msel[open] > .msel-btn { border-color: var(--accent); }
.msel-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msel-caret { color: var(--text-faint); font-size: 10px; }

.msel-menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  left: 0;
  min-width: 100%;
  max-width: 320px;
  max-height: 260px;
  overflow: auto;
  background: var(--bg-elevated, #2a2f3a);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.msel-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: 13px;
  color: var(--text);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.msel-opt:hover { background: var(--accent-soft); }
.msel-opt input { accent-color: var(--accent); }
.msel-empty { padding: 4px 8px; color: var(--text-faint); }
</style>
