<script setup>
/**
 * IsoOfficeView —— 2.5D 等距办公室。
 *
 * 场景全部由 Canvas 现画（见 iso/），这里只负责：
 *   - 把 store 里的成员翻译成场景里的演员（专家坐工位 / 临时成员飘在空中）
 *   - HUD、任务卡、交互提示
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import WorkstationCard from '../components/WorkstationCard.vue';
import { useTeamStore } from '../stores/team';
import { isEphemeralMember, projectLabelOf } from '../lib/ephemeral';
import { createIsoOffice, STATE_COLOR, STATE_LABEL } from '../iso/engine';

const props = defineProps({
  selectedId: { type: String, default: '' },
});
const emit = defineEmits(['select', 'toggle-chat']);

const team = useTeamStore();
const wrapRef = ref(null);
const canvasRef = ref(null);
const showPaths = ref(false);

/** @type {ReturnType<typeof createIsoOffice> | null} */
let office = null;
let cardRaf = 0;

/** 场景演员：专家（有工位）+ 临时成员（幽灵，飘着） */
const sceneMembers = computed(() =>
  team.members.map((m) => ({
    memberId: m.memberId,
    name: m.name || String(m.memberId || '').split('@')[0],
    state: m.state || 'offline',
    degraded: Boolean(m.degraded),
    ghost: isEphemeralMember(m),
    project: projectLabelOf(m),
    taskProgress: m.task && Number.isFinite(m.task.progress) ? m.task.progress : 0,
  }))
);

const seatedCount = computed(() => sceneMembers.value.filter((m) => !m.ghost).length);
const ghostCount = computed(() => sceneMembers.value.filter((m) => m.ghost).length);

watch(sceneMembers, (v) => office && office.setMembers(v));
watch(
  () => props.selectedId,
  (v) => office && office.setSelected(v)
);
watch(showPaths, (v) => office && office.setShowPaths(v));

/* ------------------------------ 任务卡 ------------------------------ */

const card = ref(null);
let lastOpen = 0;

const cardMember = computed(() => (card.value ? team.members.find((m) => m.memberId === card.value.memberId) : null));

function updateCardPos() {
  if (!card.value || !office || !wrapRef.value) return;
  const p = office.screenOf(card.value.memberId);
  if (!p) return;
  const w = wrapRef.value.clientWidth || 800;
  card.value.left = Math.round(Math.max(175, Math.min(w - 175, p.x)));
  card.value.top = Math.round(Math.max(8, p.y - 14));
}

function openCard(id) {
  lastOpen = Date.now();
  emit('select', id);
  card.value = { memberId: id, left: 0, top: 0 };
  updateCardPos();
}

function onCanvasClick() {
  // engine 命中角色时会先调 openCard，这里只处理"点空白"
  if (Date.now() - lastOpen < 150) return;
  card.value = null;
}

function closeCard() {
  card.value = null;
}

/* ------------------------------ HUD ------------------------------ */

function callAll() {
  if (office) office.callAll();
}
function dismiss() {
  if (office) office.dismiss();
}
function resetView() {
  if (!office) return;
  office.destroy();
  office = createIsoOffice(canvasRef.value, { onSelect: openCard });
  office.setMembers(sceneMembers.value);
  office.setSelected(props.selectedId);
  office.setShowPaths(showPaths.value);
}

onMounted(() => {
  office = createIsoOffice(canvasRef.value, { onSelect: openCard });
  office.setMembers(sceneMembers.value);
  office.setSelected(props.selectedId);

  const loop = () => {
    updateCardPos();
    cardRaf = requestAnimationFrame(loop);
  };
  cardRaf = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(cardRaf);
  if (office) office.destroy();
  office = null;
});
</script>

<template>
  <div ref="wrapRef" class="scene-wrap">
    <canvas ref="canvasRef" class="scene" @click="onCanvasClick" />

    <!-- 任务卡（跟着角色走） -->
    <div
      v-if="card && cardMember"
      class="card-layer"
      :style="{ left: `${card.left}px`, top: `${card.top}px` }"
      @click.stop
    >
      <WorkstationCard :member="cardMember" />
      <button class="card-close" @click="closeCard">关闭</button>
    </div>

    <!-- HUD -->
    <div class="hud" @click.stop>
      <span v-for="(label, s) in STATE_LABEL" :key="s" class="legend">
        <i class="dot" :style="{ background: STATE_COLOR[s] }" />{{ label }}
      </span>
      <span class="legend"><i class="dot ghost-dot" />临时成员</span>
      <span class="sep" />
      <button @click="callAll">集合开会</button>
      <button @click="dismiss">全员回工位</button>
      <button :class="{ on: showPaths }" @click="showPaths = !showPaths">路网</button>
      <button @click="resetView">复位视角</button>
      <button @click="emit('toggle-chat')">折叠对话</button>
    </div>

    <div class="tip">
      拖拽平移 · 滚轮缩放 · 双击复位 · 点小怪物看任务
      <span class="dim">（工位 {{ seatedCount }} · 临时 {{ ghostCount }}）</span>
    </div>
  </div>
</template>

<style scoped>
.scene-wrap {
  position: relative;
  height: 100%;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: #151a22;
}

.scene {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}

.card-layer {
  position: absolute;
  transform: translate(-50%, -100%);
  width: 320px;
  z-index: 5;
  filter: drop-shadow(0 8px 24px rgba(0, 0, 0, 0.5));
}

.card-close {
  margin-top: 6px;
  width: 100%;
}

.hud {
  position: absolute;
  right: 10px;
  top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(12, 15, 20, 0.82);
  border: 1px solid var(--border);
  font-size: 12px;
  z-index: 4;
}

.hud button.on {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-dim);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.ghost-dot {
  background: transparent;
  border: 1px dashed #8fe0f5;
}

.sep {
  width: 1px;
  height: 16px;
  background: var(--border-strong);
}

.tip {
  position: absolute;
  left: 10px;
  bottom: 10px;
  padding: 5px 10px;
  border-radius: 6px;
  background: rgba(12, 15, 20, 0.7);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 11px;
  z-index: 4;
}

.dim {
  color: var(--text-faint);
}
</style>
