<script setup>
/**
 * AgentAvatar —— the member figure (avatar usage).
 *
 * The shape and state animations live in GremlinSprite; this only handles:
 * size, container, offline grayscale, degraded dashed circle (indicating "this is an inferred value").
 */
import { computed } from 'vue';
import GremlinSprite from './GremlinSprite.vue';
import GhostSprite from './GhostSprite.vue';
import { avatarOf } from '@workgremlin/shared';
import { isEphemeralMember } from '../lib/ephemeral';
import { useI18n } from '../i18n';

const { t } = useI18n();
const props = defineProps({
  /** Member name or memberId (coder@workgremlin) */
  name: { type: String, required: true },
  state: { type: String, default: 'offline' },
  degraded: { type: Boolean, default: false },
  /** Pixel size */
  size: { type: Number, default: 76 },
});

const agentId = computed(() => props.name.split('@')[0]);
const skin = computed(() => avatarOf(props.name));
const isOffline = computed(() => props.state === 'offline');
/** Temporary team member: uses the ghost form (no workstation, does not take an expert slot) */
const ephemeral = computed(() => isEphemeralMember({ memberId: props.name }));
</script>

<template>
  <div
    class="avatar"
    :class="[`state-${state}`, { degraded, offline: isOffline }]"
    :style="{ '--body': skin.body, '--horn': skin.horn, width: `${size}px`, height: `${size}px` }"
    :data-testid="`avatar-${agentId}`"
    :title="`${agentId} · ${state}${degraded ? ` (${t('status.tag_inferred')})` : ''}`"
  >
    <svg viewBox="0 0 64 64" role="img" :aria-label="agentId">
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

/* degraded: the value is inferred, not a reported true value */
.avatar.degraded::after {
  content: '';
  position: absolute;
  inset: 2px;
  border: 1px dashed var(--text-faint);
  border-radius: 50%;
  pointer-events: none;
}
</style>
