<script setup>
/**
 * A checkbox dropdown for multi-value filters.
 *
 * Native `<select multiple>` needs Ctrl/Cmd-click and shows almost nothing, so this uses
 * `<details>` + checkboxes: the summary shows the current selection and the body is a checkbox list.
 *
 * `modelValue` is the array of selected option values; an empty array means "no filter" (= all) and
 * the summary falls back to `allLabel` (e.g. "All projects") with nothing checked.
 * `<details>` handles opening natively; closing is handled here so the menu also collapses when the
 * pointer or focus moves to another control.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from '../i18n';

const props = defineProps({
  modelValue: { type: Array, required: true },
  options: { type: Array, required: true },
  allLabel: { type: String, default: '' },
  ariaLabel: { type: String, default: '' },
});

const emit = defineEmits(['update:modelValue']);

const { t } = useI18n();

const root = ref(null);
const selectedSet = computed(() => new Set(props.modelValue));

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

function toggle(value) {
  const next = props.modelValue.slice();
  const i = next.indexOf(value);
  if (i >= 0) next.splice(i, 1);
  else next.push(value);
  emit('update:modelValue', next);
}

function close() {
  if (root.value && root.value.open) root.value.open = false;
}

/** Close when a pointer press lands outside this dropdown. */
function onPointerDown(e) {
  if (root.value && !root.value.contains(e.target)) close();
}

/** Close when focus moves to a control outside this dropdown (Tab, or clicking another filter). */
function onFocusOut(e) {
  if (!root.value) return;
  const next = e.relatedTarget;
  if (!next || !root.value.contains(next)) close();
}

onMounted(() => {
  if (typeof document === 'undefined') return;
  // Capture phase so it runs even if an inner element stops propagation.
  document.addEventListener('pointerdown', onPointerDown, true);
});
onBeforeUnmount(() => {
  if (typeof document === 'undefined') return;
  document.removeEventListener('pointerdown', onPointerDown, true);
});
</script>

<template>
  <details ref="root" class="msel" @focusout="onFocusOut">
    <summary class="msel-btn" :aria-label="ariaLabel" :title="summaryText">
      <span class="msel-text">{{ summaryText }}</span>
      <span class="msel-caret" aria-hidden="true">▾</span>
    </summary>
    <div class="msel-menu" role="listbox" aria-multiselectable="true">
      <label v-for="o in options" :key="o.value" class="msel-opt">
        <input type="checkbox" :checked="selectedSet.has(o.value)" @change="toggle(o.value)" />
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
