<script setup>
/**
 * AgentAvatar —— 成员形象（头像用法）。
 *
 * 造型与状态动画都在 GremlinSprite 里，这里只负责：
 * 尺寸、容器、离线灰阶、degraded 虚线圈（提示"这是推断值"）。
 */
import { computed } from 'vue';
import GremlinSprite from './GremlinSprite.vue';
import GhostSprite from './GhostSprite.vue';
import { avatarOf } from '@workgremlin/shared';
import { isEphemeralMember } from '../lib/ephemeral';

const props = defineProps({
  /** 成员名或 memberId（coder@workgremlin） */
  name: { type: String, required: true },
  state: { type: String, default: 'offline' },
  degraded: { type: Boolean, default: false },
  /** 像素尺寸 */
  size: { type: Number, default: 76 },
});

const agentId = computed(() => props.name.split('@')[0]);
const skin = computed(() => avatarOf(props.name));
const isOffline = computed(() => props.state === 'offline');
/** 临时组队成员：用幽灵形象（没有工位，不占专家名额） */
const ephemeral = computed(() => isEphemeralMember({ memberId: props.name }));
</script>

<template>
  <div
    class="avatar"
    :class="[`state-${state}`, { degraded, offline: isOffline }]"
    :style="{ '--body': skin.body, '--horn': skin.horn, width: `${size}px`, height: `${size}px` }"
    :data-testid="`avatar-${agentId}`"
    :title="`${agentId} · ${state}${degraded ? ' (推断)' : ''}`"
  >
    <svg viewBox="0 0 64 64" role="img" :aria-label="`${agentId} 的形象`">
      <GhostSprite v-if="ephemeral" :name="name" :state="state" :degraded="degraded" />
      <GremlinSprite v-else :name="name" :state="state" :degraded="degraded" />
    </svg>
  </div>
</template>

<style scoped>
.avatar {
  position: relative;
  display: inline-flex;
  align-items: flex-end;
  justify-content: center;
  flex: none;
}

svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}

.avatar.offline svg {
  filter: grayscale(1);
  opacity: 0.5;
}

/* degraded：值为推断，非上报真值 */
.avatar.degraded::after {
  content: '';
  position: absolute;
  inset: 2px;
  border: 1px dashed var(--text-faint);
  border-radius: 50%;
  pointer-events: none;
}
</style>
