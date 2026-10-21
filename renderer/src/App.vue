<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import SessionSwitcher from './components/SessionSwitcher.vue';
import LangSwitch from './components/LangSwitch.vue';
import FloorSelector from './components/FloorSelector.vue';
import ElevatorDoors from './components/ElevatorDoors.vue';
import IsoOfficeView from './views/IsoOfficeView.vue';
import OfficeSceneView from './views/OfficeSceneView.vue';
import DeskLabView from './views/DeskLabView.vue';
import WorkstationView from './views/WorkstationView.vue';
import ConversationView from './views/ConversationView.vue';
import TaskRecordsView from './views/TaskRecordsView.vue';
import CouncilView from './views/CouncilView.vue';
import { useCouncilStore } from './stores/council';
import { useProjectStore } from './stores/project';
import { useMessageStore } from './stores/messages';
import { useSessionStore } from './stores/sessions';
import { useDemoStore } from './stores/demo';
import { WS_EVENTS } from '@workgremlin/shared';
import { httpBase, setFullScreen, onFullScreen } from './api/bridge';
import { useElevator } from './composables/useElevator';
import { useI18n } from './i18n';

const project = useProjectStore();
const msgs = useMessageStore();
const sessions = useSessionStore();
const demo = useDemoStore();
const council = useCouncilStore();
const { t } = useI18n();

/**
 * Elevator transition: the state machine is a module-level singleton, shared by the main stage
 * (the door) and the left column (car / highlight).
 * Floor switching goes through request(): the face change (selectFloor) is committed by it at 70%
 * of the door close (design §2 segment 1).
 */
const { phase, motionMode, flash, request: requestFloor, settleElevator } = useElevator();

/** Supports ?tab=lab to jump straight into the workstation design bench (for tuning shapes) */
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
 * The pages that are "not an elevator scene" (task records, council): the left floor pills, the
 * top-right session dropdown and fullscreen are all hidden.
 * They are collected here because these conditions used to be scattered in four places (floor
 * pills / session dropdown / fullscreen button / lintel LCD), so every new page meant remembering
 * to change all four —— miss one and you get "the page is tidy but the lintel still hangs a floor".
 * The workstation card **does not** count: it still switches floors to look at, so it keeps the
 * floor pills and the session dropdown.
 */
const bareTab = computed(() => tab.value === 'conversation' || tab.value === 'council');

/**
 * Fullscreen (focus) mode: keep only the main stage (the office scene, i.e. the main Agent console
 * screen), hide the left floor pills and every top-bar control (connection bar + tabs + session
 * dropdown); also switch the **native** fullscreen, dropping the window title bar / frame / menu
 * bar together (see setFullScreen in api/bridge).
 *
 * Three exits, so you can always get back: the translucent floating button in the top-right
 * corner, Esc, and pressing F again (the system leaving fullscreen on its own —— F11 / a gesture /
 * the macOS menu —— is synced back too).
 * Entering fullscreen from a non-office tab first returns to the office (that is the screen you
 * want), and leaving it restores the previous tab.
 */
const fullscreen = ref(false);
/** The tab from before entering fullscreen (see enterFullscreen) */
let tabBeforeFs = '';
/** Unsubscribe function for the native-fullscreen subscription */
let stopNativeFs = null;
/** true = this switch was initiated by us, so do not handle it again when the native event comes back */
let fsSyncing = false;

/** Also switch native fullscreen: not getting it (plain browser dev, no Electron) does not affect the in-app focus mode */
async function applyNativeFullscreen(on) {
  fsSyncing = true;
  try {
    await setFullScreen(on);
  } catch {
    /* ignore: the window chrome is still there, but the UI is already fullscreen */
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

/** Keyboard: F toggles fullscreen, Esc only exits. Do not steal keys while typing in an input */
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
  // Demo mode only replaces the office members. The conversation log always follows the real
  // project, just like task records and the project selector.
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
    /* ignore: the snapshot is pushed again after the WS reconnects */
  }
}

/** Select/deselect a workstation: filter the conversation drawer to that member at the same time */
function selectDesk(id) {
  selectedId.value = selectedId.value === id ? '' : id;
  msgs.setFilters({ members: selectedId.value ? [selectedId.value] : [] });
}

/**
 * The demo session is injected by stores/sessions.js like any other active session, so the
 * dropdown is always the normal floor-scoped list. Selecting a real entry leaves demo mode first;
 * selecting the virtual demo entry only re-selects it.
 */
const sessionItems = computed(() => sessions.options);
const sessionValue = computed(() => sessions.selectedId);
const sessionEmptyLabel = computed(() => sessions.emptyLabel);

async function selectSession(id) {
  if (demo.active && id !== demo.sessionId) {
    await demo.exit({ restore: true });
  }
  sessions.select(id);
}

/** Phase-source badge: the demo phase still comes from the server provider, just not from a real hook */
const phaseSource = computed(() => {
  if (demo.active) return 'demo';
  const sel = sessions.selected;
  if (!sel) return '';
  return sel.inferred ? 'inferred' : 'reported';
});

/**
 * The conversation log follows "which floor you are currently viewing":
 *   - empty floor -> clear (this floor has no session, and the previous floor's conversation
 *     should not linger);
 *   - switching to a floor with sessions / the session changing project -> refetch a batch for the new project.
 */
watch(
  () => (sessions.floorEmpty ? '' : (project.project && project.project.name) || ''),
  (name) => {
    if (!name) msgs.setSnapshot([]);
    else refreshMessages();
  }
);

/**
 * Demo is tied to **one floor**. Riding the elevator / picking a floor leaves it; the normal floor
 * + session filtering then drives the real project again. The old session on the old floor is
 * restored only if it is still alive (see stores/demo.js).
 */
watch(
  () => sessions.selectedFloor,
  (floor, old) => {
    if (demo.active && old && floor && floor !== demo.floor) demo.exit({ restore: true });
  }
);

/** The selected session changed -> handled by IsoOfficeView's main console (strictly follows the selected session; the office layout does not move) */

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  // The system changed native fullscreen itself (F11 / gesture / macOS menu) -> sync it in-app,
  // otherwise you get stuck in "the window is no longer fullscreen but the UI still hangs a focus
  // state with no exit button".
  stopNativeFs = onFullScreen((on) => {
    if (fsSyncing) return;
    if (on) enterFullscreen();
    else exitFullscreen();
  });
  await project.init((msg) => {
    if (msg.type === WS_EVENTS.MESSAGE_NEW) msgs.push(msg.payload);
    // An empty floor accepts no snapshot: otherwise the server-pushed one (still from the previous project) would refill the conversation just cleared.
    // Demo mode never changes the real project, so real message pushes keep flowing.
    if (msg.type === WS_EVENTS.SNAPSHOT && !sessions.floorEmpty) {
      msgs.setSnapshot(msg.payload.recentMessages || []);
    }
    // Sessions (project/session open-close) are pushed live: refresh the floors and dropdown immediately instead of waiting for the 10s poll
    if (msg.type === WS_EVENTS.SESSIONS) sessions.applySnapshot(msg.payload);
    // Council: start / round-by-round speech / vote count / wrap up. project is null to broadcast, independent of the project
    if (msg.type === WS_EVENTS.COUNCIL) council.applyEvent(msg.payload);
  });
  await refreshMessages();
  await sessions.refresh(project.serverInfo || {});
  sessions.startPolling(project.serverInfo || {});
  // The council entry needs to know "whether any floor can be summoned" to decide if the button is clickable (if it cannot be fetched, keep it clickable and explain on the page)
  await council.fetchFloors();
});

// Fetch history once when switching over: a council started elsewhere meanwhile must not wait for a page refresh to appear
watch(tab, (v) => {
  if (v === 'council') council.fetchList();
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  if (stopNativeFs) stopNativeFs();
  // Finish the in-flight trip on unmount (design §8.1: a "door closed halfway" state must not be left behind)
  settleElevator();
  sessions.stopPolling();
  demo.dispose();
  project.dispose();
});
</script>

<template>
  <!-- data-motion sits on the root: it has to cover both the left column (car) and the main stage (door) —— on .stage it would not cover the left column -->
  <div class="app" :class="{ fullscreen }" :data-motion="motionMode">
    <!-- Fullscreen: the whole top bar is hidden (tabs + session dropdown). The fullscreen toggle
         button is on the office HUD's "demo mode" row (IsoOfficeView's .hud), so hiding the top bar
         loses no exit and does not fall to the right of the marquee screen.
         Connection / phase source live in the office's bottom-left caption bar (IsoOfficeView's .tip). -->
    <nav v-if="!fullscreen" class="tabs">
      <div class="tabs-group">
        <button :class="{ on: tab === 'office' }" @click="tab = 'office'">{{ t('nav.office') }}</button>
        <button :class="{ on: tab === 'workstation' }" @click="tab = 'workstation'">{{ t('nav.workstation') }}</button>
        <button :class="{ on: tab === 'conversation' }" @click="tab = 'conversation'">{{ t('nav.records') }}</button>
        <!-- Council: no dead entry when no CLI is installed on any floor —— the button is disabled, and the title explains why -->
        <button
          :class="{ on: tab === 'council' }"
          :disabled="!council.canStart"
          :title="council.canStart ? '' : t('nav.council_title')"
          @click="tab = 'council'"
        >{{ t('nav.council') }}</button>
      </div>
      <div class="tabs-group tabs-actions">
        <SessionSwitcher
          v-if="!bareTab"
          :items="sessionItems"
          :model-value="sessionValue"
          :empty-label="sessionEmptyLabel"
          @update:model-value="selectSession($event)"
        />
        <LangSwitch />
      </div>
    </nav>

    <main class="body">
      <!-- Floors: one monitored agent per floor; a green status dot = this floor has an active session.
           The task-records page needs no shaft (it is not an elevator scene), so the left floor pills are dropped -->
      <FloorSelector
        v-if="!fullscreen && !bareTab"
        :products="sessions.floors"
        :model-value="sessions.selectedFloor"
        @update:model-value="requestFloor($event)"
      />

      <ElevatorDoors
        :phase="phase"
        :flash="flash"
        :show-screen="!bareTab"
        :show-lintel="!bareTab"
      >
        <section class="stage">
          <IsoOfficeView
            v-if="tab === 'office'"
            :selected-id="selectedId"
            :connection="project.connection"
            :source="phaseSource"
            :fullscreen="fullscreen"
            @select="selectDesk"
            @toggle-fullscreen="toggleFullscreen"
          />
          <!-- The old 2D front view; ?tab=flat still enters it, for comparing with the new scene -->
          <OfficeSceneView
            v-else-if="tab === 'flat'"
            :selected-id="selectedId"
            @select="selectDesk"
          />
          <WorkstationView v-else-if="tab === 'workstation'" />
          <DeskLabView v-else-if="tab === 'lab'" />
          <TaskRecordsView v-else-if="tab === 'conversation'" />
          <CouncilView v-else-if="tab === 'council'" />
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

/* The disabled state should read as "not clickable", not "broken": dim it + a not-allowed cursor + a title explaining why */
.tabs button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* The top bar's two groups: tabs on the left, settings etc. on the right; each takes its own content width (no stretching) */
.tabs-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.tabs-actions {
  margin-left: auto;
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

/* ------------------------------ Fullscreen (focus) mode ------------------------------
 * The main stage fills the whole window: drop the stage padding and the scene's own border /
 * radius too (that is the child component's root element, reachable only with :deep). The left
 * column and top bar are removed by v-if, so no need to touch them here.
 */
.app.fullscreen .stage {
  padding: 0;
}

.app.fullscreen :deep(.scene-wrap) {
  border: 0;
  border-radius: 0;
}

/* The lintel (the floor-screen strip) and the canvas are the top and bottom halves of the same
   board: in fullscreen the canvas fills the edge, so it must drop its outer padding and border too,
   otherwise the canvas is flush while a rounded board still hangs above. */
.app.fullscreen :deep(.lintel) {
  margin: 0;
  border: 0;
  border-radius: 0;
}

</style>
