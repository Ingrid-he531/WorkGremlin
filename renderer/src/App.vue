<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import SessionSwitcher from './components/SessionSwitcher.vue';
import FloorSelector from './components/FloorSelector.vue';
import ElevatorDoors from './components/ElevatorDoors.vue';
import IsoOfficeView from './views/IsoOfficeView.vue';
import OfficeSceneView from './views/OfficeSceneView.vue';
import DeskLabView from './views/DeskLabView.vue';
import WorkstationView from './views/WorkstationView.vue';
import ConversationView from './views/ConversationView.vue';
import TaskRecordsView from './views/TaskRecordsView.vue';
import { useProjectStore } from './stores/project';
import { useMessageStore } from './stores/messages';
import { useSessionStore } from './stores/sessions';
import { WS_EVENTS } from '@workgremlin/shared';
import { httpBase, setFullScreen, onFullScreen } from './api/bridge';
import { useElevator } from './composables/useElevator';

const project = useProjectStore();
const msgs = useMessageStore();
const sessions = useSessionStore();

/**
 * 电梯过渡：状态机是模块级单例，主舞台（门）与左栏（轿厢 / 高亮）共用同一个实例。
 * 切楼层改走 request()：换脸（selectFloor）由它在关门 70% 处提交（设计 §2 段 1）。
 */
const { phase, motionMode, flash, request: requestFloor, settleElevator } = useElevator();

/** 支持 ?tab=lab 直接进入工位设计台（调造型时用） */
const initialTab = (() => {
  try {
    return new URLSearchParams(location.search).get('tab') || 'office';
  } catch {
    return 'office';
  }
})();
const tab = ref(initialTab);
const selectedId = ref('');

/**
 * 全屏（专注）模式：只留主舞台（办公室场景，也就是主 Agent 控制台那块屏），
 * 收掉左边楼层胶囊和顶栏所有控件（连接条 + 页签 + 会话下拉）；
 * 同时切**原生**全屏，把窗口标题栏 / 边框 / 菜单栏一起去掉（见 api/bridge 的 setFullScreen）。
 *
 * 出口三条，保证任何时候都能回来：右上角那个半透明浮起按钮、Esc、再按一次 F
 *（系统自己退出全屏 —— F11 / 手势 / macOS 菜单 —— 也会被同步回来）。
 * 从非办公室页签进全屏时先切回办公室（要的就是主屏幕），退出再还回原来那个页签。
 */
const fullscreen = ref(false);
/** 进全屏前的页签（见 enterFullscreen） */
let tabBeforeFs = '';
/** 原生全屏订阅的退订函数 */
let stopNativeFs = null;
/** true = 这次切换是我们自己发起的，原生事件回灌时别再处理一次 */
let fsSyncing = false;

/** 连带切换原生全屏：拿不到（纯浏览器 dev 无 Electron）也不影响应用内专注模式 */
async function applyNativeFullscreen(on) {
  fsSyncing = true;
  try {
    await setFullScreen(on);
  } catch {
    /* 忽略：窗口外壳还在，界面已经全屏了 */
  } finally {
    fsSyncing = false;
  }
}

function enterFullscreen() {
  if (fullscreen.value) return;
  if (tab.value !== 'office') {
    tabBeforeFs = tab.value;
    tab.value = 'office';
  }
  fullscreen.value = true;
  applyNativeFullscreen(true);
}

function exitFullscreen() {
  if (!fullscreen.value) return;
  fullscreen.value = false;
  if (tabBeforeFs) {
    tab.value = tabBeforeFs;
    tabBeforeFs = '';
  }
  applyNativeFullscreen(false);
}

function toggleFullscreen() {
  if (fullscreen.value) exitFullscreen();
  else enterFullscreen();
}

/** 键盘：F 进/出全屏，Esc 只出。输入框里打字时不抢键 */
function onKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  const tag = t && t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
  if (e.key === 'Escape') {
    if (!fullscreen.value) return;
    e.preventDefault();
    exitFullscreen();
    return;
  }
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    toggleFullscreen();
  }
}

async function refreshMessages() {
  const info = project.serverInfo || {};
  const base = httpBase(info);
  const t = project.project ? project.project.name : '';
  try {
    const res = await fetch(`${base}/api/v1/snapshot${t ? `?project=${encodeURIComponent(t)}` : ''}`, {
      headers: info.token ? { Authorization: `Bearer ${info.token}` } : undefined,
    });
    const data = await res.json();
    if (data && data.ok && data.snapshot) msgs.setSnapshot(data.snapshot.recentMessages || []);
  } catch {
    /* 忽略：WS 重连后会重新推 snapshot */
  }
}

/** 选中/取消选中工位：同步把对话抽屉过滤到该成员 */
function selectDesk(id) {
  selectedId.value = selectedId.value === id ? '' : id;
  msgs.setFilters({ members: selectedId.value ? [selectedId.value] : [] });
}

/**
 * 顶栏"项目"：优先跟着选中的会话走；
 * 切到没有活跃会话的楼层时显示楼层本身 —— 项目还挂着上一个工程的名字，
 * 会让人以为楼层没切（屋里的人已经是上一层那个工程的了）。
 *
 * 演示模式**压过**上面两条：屋里站的是演示成员、控制台演的是演示脚本，这时还跟着
 * 下拉里那条真会话显示真工程名就自相矛盾了（放最前面判）。
 */
const projectLabel = computed(() => {
  if (project.demo) return `${project.projectName || '演示工程'} · 演示模式`;
  if (sessions.selected) return sessions.selected.project;
  if (sessions.floorEmpty) {
    const f = sessions.floors.find((x) => x.id === sessions.selectedFloor);
    return f ? `${f.name} · 本层暂无活跃会话` : '';
  }
  return project.projectName;
});

/**
 * 会话下拉的内容：演示模式下换成**唯一一项**「演示工程 · 演示会话」。
 *
 * 为什么不把真会话继续列着：演示不是任何一条真会话 —— 列着既点不动（演示期间不切工程，
 * 见 IsoOfficeView 的演示保护），又和"项目：演示工程"打架。要退出演示走 HUD 的「退出演示」。
 */
const DEMO_SESSION_ID = '__demo__';
const sessionItems = computed(() =>
  project.demo
    ? [
        {
          value: DEMO_SESSION_ID,
          label: '演示工程 · 演示会话',
          title: '演示模式（退出：办公室操作条上的「退出演示」）',
        },
      ]
    : sessions.options
);
const sessionValue = computed(() => (project.demo ? DEMO_SESSION_ID : sessions.selectedId));
const sessionEmptyLabel = computed(() => (project.demo ? '演示工程 · 演示会话' : sessions.emptyLabel));

/** 选中会话：演示期间不切（要退出演示请走 HUD 的按钮） */
function selectSession(id) {
  if (project.demo) return;
  sessions.select(id);
}

/** 相位来源徽标：演示时说"演示脚本"，别拿真会话的"上报真值 / 推断值"冒充 */
const phaseSource = computed(() => {
  if (project.demo) return 'demo';
  const sel = sessions.selected;
  if (!sel) return '';
  return sel.inferred ? 'inferred' : 'reported';
});

/**
 * 对话记录跟着"当前在看哪一层"走：
 *   - 空楼层 → 清空（这层没会话，也不该留着上一层的对话）；
 *   - 切到有会话的楼层 / 会话换了工程 → 按新工程重新拉一批。
 */
watch(
  () => (sessions.floorEmpty ? '' : (project.project && project.project.name) || ''),
  (name) => {
    if (!name) msgs.setSnapshot([]);
    else refreshMessages();
  }
);

/** 选中的会话变了 → 由 IsoOfficeView 的主控制台负责（严格跟随所选会话，办公室布局不动） */

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  // 系统自己改了原生全屏（F11 / 手势 / macOS 菜单）→ 应用内同步，
  // 否则会停在"窗口已经不是全屏，界面却还挂着没有出口按钮的专注态"。
  stopNativeFs = onFullScreen((on) => {
    if (fsSyncing) return;
    if (on) enterFullscreen();
    else exitFullscreen();
  });
  await project.init((msg) => {
    if (msg.type === WS_EVENTS.MESSAGE_NEW) msgs.push(msg.payload);
    // 空楼层不收快照：否则服务端推来的那份（还是上一个工程的）会把刚清空的对话又填回去
    if (msg.type === WS_EVENTS.SNAPSHOT && !sessions.floorEmpty) msgs.setSnapshot(msg.payload.recentMessages || []);
    // 会话（开/关工程·会话）实时推送：立即刷新楼层与下拉，不等 10s 轮询
    if (msg.type === WS_EVENTS.SESSIONS) sessions.applySnapshot(msg.payload);
  });
  await refreshMessages();
  await sessions.refresh(project.serverInfo || {});
  sessions.startPolling(project.serverInfo || {});
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  if (stopNativeFs) stopNativeFs();
  // 卸载时把在途那一趟收尾（设计 §8.1：不允许留下"门关到一半"的状态）
  settleElevator();
  sessions.stopPolling();
  project.dispose();
});
</script>

<template>
  <!-- data-motion 挂在根部：它要同时罩住左栏（轿厢）和主舞台（门）—— 挂 .stage 就罩不到左栏 -->
  <div class="app" :class="{ fullscreen }" :data-motion="motionMode">
    <!-- 全屏：顶栏整条收掉（页签 + 会话下拉），出口见 .fs-exit。
         连接 / 相位来源 在办公室左下角说明条里（IsoOfficeView 的 .tip）；
         项目名在门楣（楼层液晶屏那块板）最左边（ElevatorDoors 的 .lintel-proj）——
         三样都不占顶栏，所以收掉顶栏不会丢信息。 -->
    <nav v-if="!fullscreen" class="tabs">
      <button :class="{ on: tab === 'office' }" @click="tab = 'office'">办公室</button>
      <button :class="{ on: tab === 'workstation' }" @click="tab = 'workstation'">工位卡片</button>
      <button :class="{ on: tab === 'conversation' }" @click="tab = 'conversation'">任务记录</button>
      <span class="spacer" />
      <!-- 工位卡片 / 任务记录页不需要会话下拉与全屏，收掉右上角这两样 -->
      <SessionSwitcher
        v-if="tab !== 'workstation' && tab !== 'conversation'"
        :items="sessionItems"
        :model-value="sessionValue"
        :empty-label="sessionEmptyLabel"
        @update:model-value="selectSession($event)"
      />
      <button
        v-if="tab !== 'workstation' && tab !== 'conversation'"
        class="fs-btn"
        title="全屏只显示主屏幕（F）"
        @click="toggleFullscreen"
      >全屏</button>
    </nav>

    <main class="body">
      <!-- 楼层：一层一个受监控的智能体；状态点绿 = 这一层有活跃会话。
           任务记录页不需要井道（不是电梯场景），去掉左边胶囊楼层 -->
      <FloorSelector
        v-if="!fullscreen && tab !== 'conversation'"
        :products="sessions.floors"
        :model-value="sessions.selectedFloor"
        @update:model-value="requestFloor($event)"
      />

      <ElevatorDoors
        :phase="phase"
        :floors="sessions.floors"
        :flash="flash"
        :project-label="projectLabel"
        :show-floor-lcd="tab !== 'conversation'"
        :show-lintel="tab !== 'conversation'"
      >
        <section class="stage">
          <IsoOfficeView
            v-if="tab === 'office'"
            :selected-id="selectedId"
            :connection="project.connection"
            :source="phaseSource"
            @select="selectDesk"
          />
          <!-- 旧的 2D 正视场景，?tab=flat 还能进，用来和新场景对比 -->
          <OfficeSceneView
            v-else-if="tab === 'flat'"
            :selected-id="selectedId"
            @select="selectDesk"
          />
          <WorkstationView v-else-if="tab === 'workstation'" />
          <DeskLabView v-else-if="tab === 'lab'" />
          <TaskRecordsView v-else-if="tab === 'conversation'" />
          <ConversationView v-else />
        </section>
      </ElevatorDoors>
    </main>

    <!-- 全屏唯一的常驻出口：平时压到很淡，鼠标靠近才亮，不抢画面 -->
    <button
      v-if="fullscreen"
      class="fs-exit"
      title="退出全屏（Esc / F）"
      @click="exitFullscreen"
    >
      退出全屏
    </button>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.tabs button.on {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.spacer {
  flex: 1;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 12px;
}

/* ------------------------------ 全屏（专注）模式 ------------------------------
 * 主舞台吃满整窗：去掉舞台留白，连场景自己的边框/圆角一起收掉（那是子组件的根元素，
 * 用 :deep 才够得着）。左栏与顶栏是 v-if 收的，这里不用管。
 */
.app.fullscreen .stage {
  padding: 0;
}

.app.fullscreen :deep(.scene-wrap) {
  border: 0;
  border-radius: 0;
}

/* 门楣（楼层屏那片）与画布是同一块板的上下两段：全屏时画布顶满，
   它也得跟着去掉外圈留白与边框，否则画布贴边了、上面还悬着一块圆角板。 */
.app.fullscreen :deep(.lintel) {
  margin: 0;
  border: 0;
  border-radius: 0;
}

.fs-btn {
  flex: 0 0 auto;
}

/* 右上角出口：半透明常驻，hover 才完全亮起来 */
.fs-exit {
  position: fixed;
  right: 12px;
  top: 10px;
  z-index: 50;
  opacity: 0.3;
  transition: opacity 0.15s ease;
  background: rgba(12, 15, 20, 0.82);
}

.fs-exit:hover,
.fs-exit:focus-visible {
  opacity: 1;
}
</style>
