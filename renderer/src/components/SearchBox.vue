<script setup>
import { ref, watch } from 'vue';
import { useI18n } from '../i18n';

const { t } = useI18n();

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
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
    :placeholder="placeholder || t('chat.search_placeholder')"
  />
</template>

<style scoped>
.search {
  width: 260px;
}
</style>
