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
import { useSessionStore } from '../stores/sessions';
import { useMainAgentStore } from '../stores/mainAgent';
import { isEphemeralMember, projectLabelOf } from '../lib/ephemeral';
import { createIsoOffice, STATE_COLOR, STATE_LABEL } from '../iso/engine';

const props = defineProps({
  selectedId: { type: String, default: '' },
});
const emit = defineEmits(['select']);

const team = useTeamStore();
const sessions = useSessionStore();
const mainAgent = useMainAgentStore();
const wrapRef = ref(null);
const canvasRef = ref(null);
const showPaths = ref(false);

/* ------------------------------ 主 Agent 控制台 tooltip ------------------------------
 * 鼠标停在悬浮屏上（hover 命中）超过 TIP_DELAY 才弹，避免拖拽 / 扫过也闪。
 * 内容取自主 Agent store：具体在做什么 + 技能名 + MCP 工具信息（都是 setMainAgent 喂进来的）。
 */
const TIP_DELAY = 400;
const tip = ref({ show: false, x: 0, y: 0 });
let tipTimer = null;

function clearTip() {
  if (tipTimer) {
    clearTimeout(tipTimer);
    tipTimer = null;
  }
  tip.value.show = false;
}

function onConsoleMove(e) {
  if (!office || !canvasRef.value) return;
  // 按住拖拽时不弹（那是平移视角，不是看信息）
  if (e.buttons) {
    clearTip();
    return;
  }
  const r = canvasRef.value.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  if (office.hitMainConsole(px, py)) {
    tip.value.x = e.clientX;
    tip.value.y = e.clientY;
    if (!tipTimer) tipTimer = setTimeout(() => { tip.value.show = true; }, TIP_DELAY);
  } else {
    clearTip();
  }
}

function onConsoleLeave() {
  clearTip();
}

/** 主 Agent 控制台：现在喂的是 mock 的阶段性状态，换成 hook 事件后这里不用动 */
const mainAgentState = computed(() => mainAgent.snapshot);

/**
 * reporter hook 把主 Agent 的实时状态上报成了 team 里的一个成员
 * （role=agent、主动上报 reported=1、非临时）。主控制台应该吃这个真值——
 * 它带心跳死亡检测（degraded 即 60s 没心跳），比磁盘推断准，也修掉了
 * "干活显示空闲"和"关掉 VS Code 还卡在规划中"两处失真。
 */
const mainMember = computed(() =>
  team.members.find((m) => m.role === 'agent' && m.reported && !m.ephemeral && !m.degraded) || null
);

/** 主控制台真正要显示的状态：优先 hook 实时上报，否则退回现有逻辑（演示 / 会话接管） */
const consoleLive = computed(() => {
  const m = mainMember.value;
  if (!m) return null;
  // 只有"没选会话"或"选中的就是当前会话（主 Agent 自己）"时才用 hook 覆盖；
  // 选了别的工程的会话则尊重会话接管（磁盘推断），不动它。
  const sel = sessions.selected;
  if (sel && sel.id && !sel.current) return null;

  if (m.state === 'blocked') {
    // 等授权：工具与目标走会话落盘的 await 叠加（sessions.js 已读 reporter 的本地文件）
    return {
      phase: 'await',
      action: (sel && sel.action) || '等待用户授权',
      context: sel && sel.context && sel.context.length ? sel.context : ['等待用户授权后继续'],
      target: sel && sel.target ? sel.target : null,
    };
  }
  if (m.state === 'thinking') {
    // 思考中：用户刚提交，尚未发起工具 / 授权。第二层写任务标题（即用户那句话）。
    const title = m.task && m.task.title ? m.task.title : '正在分析你的请求';
    return { phase: 'thinking', action: title, context: title !== '正在分析你的请求' ? [title] : [], target: null };
  }
  const phase = m.state === 'busy' ? 'tool' : 'idle';
  const action = m.task && m.task.title ? m.task.title : '';
  const files = Array.isArray(m.currentFiles)
    ? m.currentFiles.map((f) => (f && (f.path || f)) || '').filter(Boolean)
    : [];
  const context = files.length ? files.slice(0, 6) : action ? [action] : [];
  return { phase, action, context, target: null };
});

watch(consoleLive, (v) => mainAgent.setLiveState(v), { immediate: true });

/** @type {ReturnType<typeof createIsoOffice> | null} */
let office = null;
let cardRaf = 0;

/**
 * 场景演员：专家（有工位）+ 临时成员（幽灵，飘着）。
 *
 * 选中的会话不是"当前工程里正在跑的那个"时（别的工程的会话 / 只剩化石数据），
 * 这份成员清单跟那个会话对不上 —— 一律按离线 + 推断显示，绝不拿 A 工程的人
 * 冒充 B 工程的状态。办公室布局不受影响，还是这份清单摆出来的样子。
 */
const sceneMembers = computed(() =>
  team.members.map((m) => ({
    memberId: m.memberId,
    name: m.name || String(m.memberId || '').split('@')[0],
    state: sessions.live ? m.state || 'offline' : 'offline',
    degraded: sessions.live ? Boolean(m.degraded) : true,
    ghost: isEphemeralMember(m),
    project: projectLabelOf(m),
    taskProgress: sessions.live && m.task && Number.isFinite(m.task.progress) ? m.task.progress : 0,
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
watch(mainAgentState, (v) => office && office.setMainAgent(v));

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
  office.setMainAgent(mainAgentState.value);
}

onMounted(() => {
  office = createIsoOffice(canvasRef.value, { onSelect: openCard });
  office.setMembers(sceneMembers.value);
  office.setSelected(props.selectedId);
  office.setMainAgent(mainAgentState.value);
  mainAgent.start();

  const loop = () => {
    updateCardPos();
    cardRaf = requestAnimationFrame(loop);
  };
  cardRaf = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(cardRaf);
  mainAgent.stop();
  if (office) office.destroy();
  office = null;
});
</script>

<template>
  <div ref="wrapRef" class="scene-wrap">
    <canvas
      ref="canvasRef"
      class="scene"
      @click="onCanvasClick"
      @mousemove="onConsoleMove"
      @mouseleave="onConsoleLeave"
    />

    <!-- 主 Agent 控制台 tooltip：鼠标停在悬浮屏上 400ms 后弹出 -->
    <div
      v-if="tip.show"
      class="console-tip"
      :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
    >
      <div class="ct-head">
        <i class="dot" :style="{ background: mainAgent.phaseColor }" />
        <span class="ct-phase">{{ mainAgent.phaseLabel }}</span>
      </div>
      <div v-if="mainAgent.action" class="ct-row"><b>操作</b>{{ mainAgent.action }}</div>
      <div v-if="mainAgent.target && mainAgent.phase === 'await'" class="ct-row"><b>目标</b>{{ mainAgent.target }}</div>
      <div v-if="mainAgent.skill" class="ct-row"><b>技能</b>{{ mainAgent.skill }}</div>
      <div v-if="mainAgent.tool" class="ct-row"><b>工具</b>{{ mainAgent.tool }}</div>
    </div>

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
      <span class="legend">
        <i class="dot" :style="{ background: mainAgent.phaseColor }" />主 Agent · {{ mainAgent.phaseLabel }}
      </span>
      <span v-if="sessions.selected" class="legend session-tag">
        会话 {{ String(sessions.selected.id).slice(0, 8) }}
        <template v-if="sessions.selected.project">· {{ sessions.selected.project }}</template>
        <template v-if="!sessions.live">· 无实时数据</template>
      </span>
      <button :class="{ on: mainAgent.auto }" @click="mainAgent.setAuto(!mainAgent.auto)">
        {{ mainAgent.auto ? '演示中' : mainAgent.live ? '会话接管' : '已暂停' }}
      </button>
      <button :disabled="mainAgent.live" @click="mainAgent.next()">下一阶段</button>
      <span class="sep" />
      <button @click="callAll">集合开会</button>
      <button @click="dismiss">全员回工位</button>
      <button :class="{ on: showPaths }" @click="showPaths = !showPaths">路网</button>
      <button @click="resetView">复位视角</button>
    </div>

    <div class="tip">
      拖拽平移 · 滚轮缩放 · 双击复位 · 点小怪物看任务
      <span class="dim">（前玻璃墙下是主 Agent 控制台，放大可看清屏幕）</span>
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

.console-tip {
  position: fixed;
  transform: translate(16px, 16px);
  max-width: 290px;
  padding: 9px 11px;
  border-radius: 8px;
  background: rgba(14, 18, 26, 0.96);
  border: 1px solid var(--accent, #4c8dff);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
  color: var(--text, #e6ebf2);
  font-size: 12px;
  line-height: 1.5;
  z-index: 60;
  pointer-events: none;
}

.ct-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
}

.ct-phase {
  font-weight: 700;
}

.ct-row {
  display: flex;
  gap: 8px;
  color: var(--text-dim, #a8bdd6);
}

.ct-row b {
  flex: 0 0 auto;
  color: #7fb0ff;
  font-weight: 600;
}

.dim {
  color: var(--text-faint);
}
</style>
