<script setup>
defineProps({
  teams: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
});

const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <select
    data-testid="team-switcher"
    :value="modelValue"
    @change="emit('update:modelValue', $event.target.value)"
  >
    <option v-for="t in teams" :key="t.id" :value="t.name">{{ t.name }}</option>
  </select>
</template>
