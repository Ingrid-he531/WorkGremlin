<script setup>
import { nextTick, onMounted, ref, watch } from 'vue';
import MessageRow from './MessageRow.vue';

const props = defineProps({
  messages: { type: Array, required: true },
  autoFollow: { type: Boolean, default: true },
});

const emit = defineEmits(['update:autoFollow']);

const scroller = ref(null);
const userScrolled = ref(false);

function scrollToBottom() {
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

function onScroll() {
  const el = scroller.value;
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  userScrolled.value = !atBottom;
  if (atBottom !== props.autoFollow) emit('update:autoFollow', atBottom);
}

watch(
  () => props.messages.length,
  async () => {
    if (!props.autoFollow) return;
    await nextTick();
    scrollToBottom();
  }
);

onMounted(scrollToBottom);

defineExpose({ scrollToBottom });
</script>

<template>
  <div class="wrap">
    <div ref="scroller" class="scroller" data-testid="conv-list" @scroll="onScroll">
      <MessageRow v-for="m in messages" :key="m.id" :message="m" />
      <div v-if="!messages.length" class="empty dim">没有匹配的消息</div>
    </div>

    <button v-if="!autoFollow" class="jump" @click="emit('update:autoFollow', true) && scrollToBottom()">
      ↓ 跟随最新
    </button>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  flex: 1;
  min-height: 0;
}

.scroller {
  height: 100%;
  overflow-y: auto;
  padding: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.empty {
  padding: 24px;
  text-align: center;
}

.jump {
  position: absolute;
  right: 16px;
  bottom: 16px;
}
</style>
