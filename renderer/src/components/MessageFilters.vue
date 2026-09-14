<script setup>
import { computed } from 'vue';
import { MESSAGE_TYPES } from '@workgremlin/shared';

const props = defineProps({
  members: { type: Array, required: true },
  modelValue: { type: Object, required: true },
});

const emit = defineEmits(['update:modelValue', 'clear']);

const selected = computed(() => props.modelValue.members || []);

function toggle(name) {
  const set = new Set(selected.value);
  if (set.has(name)) set.delete(name);
  else set.add(name);
  emit('update:modelValue', { ...props.modelValue, members: [...set] });
}

function setRange(field, value) {
  const ts = value ? new Date(value).getTime() : null;
  emit('update:modelValue', { ...props.modelValue, [field]: Number.isFinite(ts) ? ts : null });
}
</script>

<template>
  <div class="filters">
    <div class="group">
      <span class="label dim">成员</span>
      <button
        v-for="m in members"
        :key="m.memberId"
        class="chip"
        :class="{ on: selected.includes(m.memberId) }"
        data-testid="filter-agent"
        @click="toggle(m.memberId)"
      >
        {{ m.name }}
      </button>
    </div>

    <div class="group">
      <span class="label dim">起始</span>
      <input type="datetime-local" @change="setRange('since', $event.target.value)" />
      <span class="label dim">截止</span>
      <input type="datetime-local" @change="setRange('until', $event.target.value)" />
    </div>

    <div class="group">
      <span class="label dim">类型</span>
      <select
        multiple
        size="1"
        @change="
          emit('update:modelValue', {
            ...modelValue,
            types: [...$event.target.selectedOptions].map((o) => o.value),
          })
        "
      >
        <option v-for="t in MESSAGE_TYPES" :key="t" :value="t">{{ t }}</option>
      </select>
    </div>

    <button data-testid="filter-clear" @click="emit('clear')">清空过滤</button>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.label {
  font-size: 11px;
  text-transform: uppercase;
}

.chip {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
}

.chip.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--text);
}
</style>
