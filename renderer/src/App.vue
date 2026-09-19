<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue';
import ConnectionBar from './components/ConnectionBar.vue';
import SessionSwitcher from './components/SessionSwitcher.vue';
import FloorSelector from './components/FloorSelector.vue';
import IsoOfficeView from './views/IsoOfficeView.vue';
import OfficeSceneView from './views/OfficeSceneView.vue';
import DeskLabView from './views/DeskLabView.vue';
import WorkstationView from './views/WorkstationView.vue';
import ConversationView from './views/ConversationView.vue';
import { useTeamStore } from './stores/team';
import { useMessageStore } from './stores/messages';
import { useSessionStore } from './stores/sessions';
import { useMainAgentStore } from './stores/mainAgent';
import { WS_EVENTS } from '@workgremlin/shared';
import { httpBase } from './api/bridge';

const team = useTeamStore();
const msgs = useMessageStore();
const sessions = useSessionStore();
const mainAgent = useMainAgentStore();

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
  const info = team.serverInfo || {};
  const base = httpBase(info);
  const t = team.team ? team.team.name : '';
  try {
    const res = await fetch(`${base}/api/v1/snapshot${t ? `?team=${encodeURIComponent(t)}` : ''}`, {
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

/** 选中的会话变了 → 主 Agent 控制台改显示这个会话的状态（办公室布局不动） */
watch(
  () => sessions.selected,
  (s) => mainAgent.applySession(s)
);

onMounted(async () => {
  await team.init((msg) => {
    if (msg.type === WS_EVENTS.MESSAGE_NEW) msgs.push(msg.payload);
    if (msg.type === WS_EVENTS.SNAPSHOT) msgs.setSnapshot(msg.payload.recentMessages || []);
    // 会话（开/关工程·会话）实时推送：立即刷新楼层与下拉，不等 10s 轮询
    if (msg.type === WS_EVENTS.SESSIONS) sessions.applySnapshot(msg.payload);
  });
  await refreshMessages();
  await sessions.refresh(team.serverInfo || {});
  sessions.startPolling(team.serverInfo || {});
});

onUnmounted(() => {
  sessions.stopPolling();
  team.dispose();
});
</script>

<template>
  <div class="app">
    <ConnectionBar
      :connection="team.connection"
      :team="team.team"
      :project="team.project"
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
        @update:model-value="sessions.selectFloor($event)"
      />

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
