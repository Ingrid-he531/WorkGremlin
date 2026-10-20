<script setup>
/**
 * AgentAvatar —— the member figure (avatar usage).
 *
 * The shape and state animations live in GremlinSprite; this only handles size and container.
 */
import { computed } from 'vue';
import GremlinSprite from './GremlinSprite.vue';
import GhostSprite from './GhostSprite.vue';
import { avatarOf } from '@workgremlin/shared';
import { isEphemeralMember } from '../lib/ephemeral';
import { normalizeState } from '../lib/memberTask';

const props = defineProps({
  /** Member name or memberId (coder@workgremlin) */
  name: { type: String, required: true },
  state: { type: String, default: 'idle' },
  /** Pixel size */
  size: { type: Number, default: 76 },
});

const agentId = computed(() => props.name.split('@')[0]);
const skin = computed(() => avatarOf(props.name));
const normalizedState = computed(() => normalizeState(props.state));
/** Temporary team member: uses the ghost form and does not take a workstation */
const ephemeral = computed(() => isEphemeralMember({ memberId: props.name }));
</script>

<template>
  <div
    class="avatar"
    :class="`state-${normalizedState}`"
    :style="{ '--body': skin.body, '--horn': skin.horn, width: `${size}px`, height: `${size}px` }"
    :data-testid="`avatar-${agentId}`"
    :title="`${agentId} · ${normalizedState}`"
  >
    <svg viewBox="0 0 64 64" role="img" :aria-label="agentId">
      <GhostSprite v-if="ephemeral" :name="name" :state="normalizedState" />
      <GremlinSprite v-else :name="name" :state="normalizedState" />
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
</style>
