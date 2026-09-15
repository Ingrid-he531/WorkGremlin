<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import ConnectionBar from './components/ConnectionBar.vue';
import TeamSwitcher from './components/TeamSwitcher.vue';
import ChatPanel from './components/ChatPanel.vue';
import IsoOfficeView from './views/IsoOfficeView.vue';
import OfficeSceneView from './views/OfficeSceneView.vue';
import DeskLabView from './views/DeskLabView.vue';
import WorkstationView from './views/WorkstationView.vue';
import ConversationView from './views/ConversationView.vue';
import { useTeamStore } from './stores/team';
import { useMessageStore } from './stores/messages';
import { WS_EVENTS } from '@workgremlin/shared';
import { httpBase } from './api/bridge';

const team = useTeamStore();
const msgs = useMessageStore();

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
const chatCollapsed = ref(false);

async function refreshMessages() {
  const base = httpBase(team.serverInfo || {});
  const t = team.team ? team.team.name : '';
  try {
    const res = await fetch(`${base}/api/v1/snapshot${t ? `?team=${encodeURIComponent(t)}` : ''}`);
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

function clearSelect() {
  selectedId.value = '';
  msgs.setFilters({ members: [] });
}

/** 打开工程：服务端会广播新快照（成员/消息/幽灵整体换一批） */
async function onOpenWorkspace(path) {
  selectedId.value = '';
  msgs.setFilters({ members: [] });
  try {
    await team.openWorkspace(path);
  } catch (err) {
    console.warn('[workgremlin] 打开工程失败：', err && err.message);
  }
}

onMounted(async () => {
  await team.init((msg) => {
    if (msg.type === WS_EVENTS.MESSAGE_NEW) msgs.push(msg.payload);
    if (msg.type === WS_EVENTS.SNAPSHOT) msgs.setSnapshot(msg.payload.recentMessages || []);
  });
  await refreshMessages();
});

onUnmounted(() => team.dispose());
</script>

<template>
  <div class="app">
    <ConnectionBar
      :connection="team.connection"
      :demo="team.demo"
      :team="team.team"
      :project="team.project"
      :recent="team.recent"
      :feed-path="team.feedPath"
      :member-count="team.members.length"
      @open-workspace="onOpenWorkspace"
    />

    <nav class="tabs">
      <button :class="{ on: tab === 'office' }" @click="tab = 'office'">办公室</button>
      <button :class="{ on: tab === 'workstation' }" @click="tab = 'workstation'">工位卡片</button>
      <button :class="{ on: tab === 'conversation' }" @click="tab = 'conversation'">对话记录</button>
      <button :class="{ on: tab === 'lab' }" @click="tab = 'lab'">工位设计</button>
      <span class="spacer" />
      <TeamSwitcher
        :teams="team.teams"
        :model-value="team.team ? team.team.name : ''"
        @update:model-value="team.switchTeam($event)"
      />
    </nav>

    <main class="body">
      <section class="stage">
        <IsoOfficeView
          v-if="tab === 'office'"
          :selected-id="selectedId"
          @select="selectDesk"
          @toggle-chat="chatCollapsed = !chatCollapsed"
        />
        <!-- 旧的 2D 正视场景，?tab=flat 还能进，用来和新场景对比 -->
        <OfficeSceneView
          v-else-if="tab === 'flat'"
          :selected-id="selectedId"
          @select="selectDesk"
          @toggle-chat="chatCollapsed = !chatCollapsed"
        />
        <WorkstationView v-else-if="tab === 'workstation'" />
        <DeskLabView v-else-if="tab === 'lab'" />
        <ConversationView v-else />
      </section>

      <ChatPanel
        v-show="tab !== 'conversation'"
        :selected-id="selectedId"
        :collapsed="chatCollapsed"
        @update:collapsed="chatCollapsed = $event"
        @select="selectDesk"
        @clear-select="clearSelect"
      />
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
