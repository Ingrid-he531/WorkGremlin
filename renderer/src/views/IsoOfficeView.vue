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
import { httpBase, getServerInfo } from '../api/bridge';
import { createIsoOffice } from '../iso/engine';

const props = defineProps({
  selectedId: { type: String, default: '' },
});
const emit = defineEmits(['select']);

const team = useTeamStore();
const sessions = useSessionStore();
const mainAgent = useMainAgentStore();
const wrapRef = ref(null);
const canvasRef = ref(null);

/** 左上角"楼层"标签：办公室当前展示的是哪一层（来自 session store 的楼层表） */
const floorLabel = computed(() => {
  const f = sessions.floors.find((x) => x.id === sessions.selectedFloor);
  if (f) return `${f.id} · ${f.name}`;
  return sessions.selectedFloor || '—';
});

/* ------------------------------ 主 Agent 相位快轮询（1.5s） ------------------------------
 * 服务端 /api/v1/reporter-phase 直接回 reporter hook 的上报相位（已映射成 UI 字段），
 * 比 /sessions 的 10s 轮询新鲜，专供主控制台"操作"实时显示（调用工具 / 等待授权）。
 * 渲染层是沙箱的（contextIsolation + nodeIntegration:false），读不到本地状态文件，
 * 所以一律走服务端，复用 readReporterPhase 的容错读，不碰 fs。
 */
const fastPhase = ref(null);
let phaseTimer = null;

async function startPhasePoll() {
  const info = await getServerInfo().catch(() => ({ port: 0, token: '' }));
  if (!info || !info.port) return;
  const tick = async () => {
    try {
      const res = await fetch(`${httpBase(info)}/api/v1/reporter-phase`, {
        headers: info.token ? { Authorization: `Bearer ${info.token}` } : undefined,
      });
      if (res.ok) {
        const d = await res.json();
        if (d && d.ok && d.phase && d.phase !== 'idle') {
          fastPhase.value = { phase: d.phase, action: d.action, target: d.target, context: d.context || [], tool: d.tool || '', prompt: d.prompt || '', workspacePath: d.workspacePath || '' };
        } else {
          fastPhase.value = null;
        }
      }
    } catch {
      /* 拉不到就留着上一次的相位，别闪回空闲 */
    }
  };
  await tick();
  phaseTimer = setInterval(tick, 1500);
}

function stopPhasePoll() {
  if (phaseTimer) clearInterval(phaseTimer);
  phaseTimer = null;
  fastPhase.value = null;
}

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

/** 两个工程路径是否同一个（去尾斜杠比较；任一为空视为"不限定"，返回 true） */
function sameWorkspace(a, b) {
  const na = String(a || '').replace(/\/+$/, '');
  const nb = String(b || '').replace(/\/+$/, '');
  return !na || !nb || na === nb;
}

/**
 * 主控制台严格跟随下拉选中的会话：显示"这条会话自己"的相位
 * （它自己工程 reporter 上报的真值，或落盘推断值），绝不拿别的工程的实时相位冒充。
 * 这样多个工程同时开着时，下拉切到哪条就显示哪条，与所选会话一一对应。
 */
const consoleLive = computed(() => {
  const sel = sessions.selected;
  if (!sel) return null;
  // 选中的恰好是"全局当前在敲"的那条（fresh）：叠加 1.5s 快轮询的实时相位，
  // 让"调用工具 / 等待授权"更跟手（比 10s 会话轮询新鲜）。其余会话（哪怕是各自工程的
  // current=true）只用自己会话轮询的数据，绝不借全局实时相位冒充——否则切回旧会话会误显新工程的"调用工具"。
  // 再加一道"工程归属"校验：快轮询相位带回了它所属工程（workspacePath），只有选中会话正好
  // 属于那个工程才叠加。否则切工程后旧会话的 fresh 还来不及翻新（会话快照滞后），新工程的
  // "思考中"会短暂盖到旧会话上——现象就是旧会话闪一下"思考中"、随后回落"待命中"。
  if (sel.fresh && fastPhase.value && sameWorkspace(fastPhase.value.workspacePath, sel.projectPath)) {
    const fp = fastPhase.value;
    if (fp.phase === 'await') {
      return { phase: 'await', action: fp.action || '等待用户授权', context: fp.context && fp.context.length ? fp.context : ['等待用户授权后继续'], target: fp.target || null, prompt: fp.prompt || '' };
    }
    if (fp.phase === 'tool') {
      return { phase: 'tool', action: fp.action || '调用工具', context: fp.context && fp.context.length ? fp.context : [], target: fp.target || null, tool: fp.tool || '', prompt: fp.prompt || '' };
    }
    // 思考中：把用户那句话（prompt）同时放到第二层（action）和第三层。
    // 屏上第三层有"字号够大才画"的门槛（mainConsole 的 showL3），放大不够时不出字；
    // 第二层门槛低，所以放一份在第二层，保证"思考中"下面任何时候都看得到你问的那句话。
    // 注意：这里只用快轮询（1.5s，新鲜）的字段，**不再回落到 sel**——会话快照可能还是上一轮的，
    // 一旦用 sel.action / sel.context 兜底，就会出现"思考中却显示上一轮的操作"，几秒后才更正。
    if (fp.phase === 'thinking') {
      const p = fp.prompt || '';
      return { phase: 'thinking', action: fp.action || p, context: fp.context && fp.context.length ? fp.context : [], target: fp.target || null, prompt: p };
    }
  }
  // 否则直接用选中会话自身的相位（reporter 真值 if 它正活跃，否则推断），
  // 下拉切到旧工程会话就显示旧会话自己的状态，不再被新工程的实时相位覆盖。
  const selPrompt = sel.phase === 'thinking' ? sel.prompt || '' : '';
  return {
    phase: sel.phase || 'idle',
    action: sel.action || selPrompt,
    context: sel.context && sel.context.length ? sel.context : [],
    target: sel.target || null,
    tool: sel.tool || '',
    prompt: sel.prompt || '',
  };
});

/**
 * "任务完成"唯一真源 = reporter 在 Stop 时落盘的 doneAt（服务端按工程透传）。
 * 绝不靠"相位回落到空闲"来猜——那样会被轮询间隙 / 跨工程串味误触发，
 * 导致任务中途也弹出"任务完成"。而且只有 doneAt 真正变化（收到新 Stop）时才弹，
 * 切到一条早已收工的旧会话不会误报。
 */
let lastConsoleSessionId = undefined;
let lastDoneAt = undefined;
watch(
  consoleLive,
  (v) => {
    const sel = sessions.selected;
    const selId = sel ? sel.id : null;
    const doneAt = sel ? sel.doneAt || 0 : 0;
    // 切换了会话（或首次）：直接把控制台切到这条会话当前的状态，重置完成标记，不弹"任务完成"。
    // 办公室的工位小怪物也跟着选中的会话走：切到别的工程会话，就切到那个工程的成员清单，
    // 这样"主 Agent + 小怪物"整组都跟随下拉选中的那条，不再停在之前打开的工程。
    if (selId !== lastConsoleSessionId) {
      lastConsoleSessionId = selId;
      lastDoneAt = doneAt;
      mainAgent.applySession(v);
      if (sel && sel.projectPath && sel.projectPath !== team.workspacePath) {
        team.openWorkspace(sel.projectPath);
      }
      return;
    }
    // 同一条会话：收到 Stop（doneAt 新增 / 变化）→ 亮"任务完成"，概要用真实完成内容
    // （本次改动的文件），而不是最后那段相位上下文、更不拿用户的 prompt 当概要。
    if (doneAt && doneAt !== lastDoneAt) {
      lastDoneAt = doneAt;
      // 组装成**可读的完成摘要**：原来直接把 doneFiles 的对象塞进 context，
      // tooltip 里 {{ c }} 渲染对象就成了 JSON 串；这里先给一句总述，再一行一个文件。
      const files = (sel && sel.doneFiles) || [];
      const count = (sel && sel.files && Number(sel.files.count)) || files.length;
      const ctx = files.length
        ? [`改动 ${count} 个文件`, ...files.map((f) => `${f.name}  +${f.added}/-${f.removed}`)]
        : ['本次任务已完成'];
      mainAgent.enterDone('任务完成', ctx);
      return;
    }
    mainAgent.setLiveState(v);
  },
  { immediate: true }
);

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
// 主 Agent（role=agent）不占工位：它自己的实时状态由主控制台剪影单独吃
// （setMainAgent），在工位区再摆一个就是重复。所以从工位名单里剔掉，
// 只让真正的 subagent 小怪物（含扫描器注册的常驻成员）坐工位。
const sceneMembers = computed(() =>
  team.members
    .filter((m) => m.role !== 'agent')
    .map((m) => ({
      memberId: m.memberId,
      name: m.name || String(m.memberId || '').split('@')[0],
      level: m.level || null,
      state: sessions.live ? m.state || 'offline' : 'offline',
      degraded: sessions.live ? Boolean(m.degraded) : true,
      ghost: isEphemeralMember(m),
      project: projectLabelOf(m),
      taskProgress: sessions.live && m.task && Number.isFinite(m.task.progress) ? m.task.progress : 0,
      // 被召唤的 subagent 当前任务名：主 agent 会用气泡把它交代给小怪物
      task: m.task && m.task.title ? m.task.title : '',
    }))
);

watch(sceneMembers, (v) => office && office.setMembers(v));
watch(
  () => props.selectedId,
  (v) => office && office.setSelected(v)
);
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
  office.setMainAgent(mainAgentState.value);
}

onMounted(() => {
  office = createIsoOffice(canvasRef.value, { onSelect: openCard });
  office.setMembers(sceneMembers.value);
  office.setSelected(props.selectedId);
  office.setMainAgent(mainAgentState.value);
  mainAgent.start();
  startPhasePoll();

  const loop = () => {
    updateCardPos();
    cardRaf = requestAnimationFrame(loop);
  };
  cardRaf = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(cardRaf);
  mainAgent.stop();
  stopPhasePoll();
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

    <!-- 楼层标签（左上角）：办公室当前展示的是哪一层 -->
    <div class="floor-tag">
      <span class="ft-k">楼层</span>
      <span class="ft-v">{{ floorLabel }}</span>
    </div>

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
      <div
        class="ct-row"
        v-if="mainAgent.action || ((mainAgent.phase === 'done' || mainAgent.phase === 'summarize') && mainAgent.context.length)"
      >
        <b>操作</b>
        <span class="ct-val">
          <template v-if="(mainAgent.phase === 'done' || mainAgent.phase === 'summarize') && mainAgent.context.length">
            <span v-for="(c, i) in mainAgent.context" :key="i" class="ct-file">{{ c }}</span>
          </template>
          <template v-else-if="mainAgent.action">{{ mainAgent.action }}</template>
        </span>
      </div>
      <div v-if="mainAgent.target && mainAgent.phase === 'await'" class="ct-row"><b>目标</b><span class="ct-val">{{ mainAgent.target }}</span></div>
      <div v-if="mainAgent.skill" class="ct-row"><b>技能</b><span class="ct-val">{{ mainAgent.skill }}</span></div>
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
      <button @click="callAll">集合开会</button>
      <button @click="dismiss">全员回工位</button>
      <button @click="resetView">复位视角</button>
    </div>

    <div class="tip">
      拖拽平移 · 滚轮缩放 · 双击复位 · 点小怪物看任务
      <span class="dim">（前玻璃墙下是主 Agent 控制台，放大可看清屏幕）</span>
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

.floor-tag {
  position: absolute;
  left: 10px;
  top: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 6px;
  background: rgba(12, 15, 20, 0.8);
  border: 1px solid var(--border);
  color: var(--text, #e6ebf2);
  font-size: 12px;
  z-index: 4;
  pointer-events: none;
}

.floor-tag .ft-k {
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--text-dim, #6e7681);
}

.floor-tag .ft-v {
  font-weight: 600;
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
  max-width: 320px;
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
  /* 长内容（超长文件路径等）与标签顶部对齐，而不是撑破盒子 */
  align-items: flex-start;
}

.ct-row b {
  flex: 0 0 auto;
  color: #7fb0ff;
  font-weight: 600;
}

/* 值文本：可收缩，长串（文件路径 / 工具名）断词换行 */
.ct-val {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* 完成/暂停时的「改动」明细：每个文件单独一行 */
.ct-files .ct-file {
  display: block;
}

.dim {
  color: var(--text-faint);
}
</style>
