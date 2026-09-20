<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import ConnectionBar from './components/ConnectionBar.vue';
import SessionSwitcher from './components/SessionSwitcher.vue';
import FloorSelector from './components/FloorSelector.vue';
import ElevatorDoors from './components/ElevatorDoors.vue';
import IsoOfficeView from './views/IsoOfficeView.vue';
import OfficeSceneView from './views/OfficeSceneView.vue';
import DeskLabView from './views/DeskLabView.vue';
import WorkstationView from './views/WorkstationView.vue';
import ConversationView from './views/ConversationView.vue';
import { useProjectStore } from './stores/project';
import { useMessageStore } from './stores/messages';
import { useSessionStore } from './stores/sessions';
import { WS_EVENTS } from '@workgremlin/shared';
import { httpBase } from './api/bridge';
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
 */
const projectLabel = computed(() => {
  if (sessions.selected) return sessions.selected.project;
  if (sessions.floorEmpty) {
    const f = sessions.floors.find((x) => x.id === sessions.selectedFloor);
    return f ? `${f.name} · 本层暂无活跃会话` : '';
  }
  return project.projectName;
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
  // 卸载时把在途那一趟收尾（设计 §8.1：不允许留下"门关到一半"的状态）
  settleElevator();
  sessions.stopPolling();
  project.dispose();
});
</script>

<template>
  <!-- data-motion 挂在根部：它要同时罩住左栏（轿厢）和主舞台（门）—— 挂 .stage 就罩不到左栏 -->
  <div class="app" :data-motion="motionMode">
    <ConnectionBar
      :connection="project.connection"
      :project="projectLabel"
      :source="sessions.selected ? (sessions.selected.inferred ? 'inferred' : 'reported') : ''"
    />

    <nav class="tabs">
      <button :class="{ on: tab === 'office' }" @click="tab = 'office'">办公室</button>
      <button :class="{ on: tab === 'workstation' }" @click="tab = 'workstation'">工位卡片</button>
      <button :class="{ on: tab === 'conversation' }" @click="tab = 'conversation'">对话记录</button>
      <span class="spacer" />
      <SessionSwitcher
        :items="sessions.options"
        :model-value="sessions.selectedId"
        :empty-label="sessions.emptyLabel"
        @update:model-value="sessions.select($event)"
      />
    </nav>

    <main class="body">
      <!-- 楼层：一层一个受监控的智能体；状态点绿 = 这一层有活跃会话 -->
      <FloorSelector
        :products="sessions.floors"
        :model-value="sessions.selectedFloor"
        @update:model-value="requestFloor($event)"
      />

      <ElevatorDoors :phase="phase" :floors="sessions.floors" :flash="flash">
        <section class="stage">
          <IsoOfficeView
            v-if="tab === 'office'"
            :selected-id="selectedId"
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
          <ConversationView v-else />
        </section>
      </ElevatorDoors>
    </main>
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
</style>
