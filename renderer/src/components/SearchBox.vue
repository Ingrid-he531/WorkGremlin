<script setup>
import { ref, watch } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '搜索消息内容…' },
});

const emit = defineEmits(['update:modelValue']);
const local = ref(props.modelValue);
let timer = null;

watch(local, (v) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => emit('update:modelValue', v), 200); // 防抖
});

watch(
  () => props.modelValue,
  (v) => {
    if (v !== local.value) local.value = v;
  }
);
</script>

<template>
  <input
    v-model="local"
    class="search"
    type="search"
    data-testid="search-input"
    :placeholder="placeholder"
  />
</template>

<style scoped>
.search {
  width: 260px;
}
</style>
