<script setup>
import { computed } from 'vue';
import WorkstationCard from '../components/WorkstationCard.vue';
import { useProjectStore } from '../stores/project';
import { useSessionStore } from '../stores/sessions';
import { useDemoStore } from '../stores/demo';
import { isEphemeralMember } from '../lib/ephemeral';
import { floorAcceptsClient, isBaseAgent } from '../lib/clientMatch';
import { memberForSession, normalizeState } from '../lib/memberTask';
import { useI18n } from '../i18n';

const project = useProjectStore();
const sessions = useSessionStore();
const demo = useDemoStore();
const { t } = useI18n();
/** Demo owns only the office roster; project data (task records, messages, workspace) stays real. */
const sourceMembers = computed(() => (demo.active ? demo.members : project.members));

// Main agent: the member name (with -plugin stripped) equals its client base name (codebuddy / qoder / codex …),
// matching the "main agent of this floor" registered by a hook; sub-agents (leo / peter / software-architect…) have names that differ from the base name.
function isMainAgent(m) {
  // Main agent = the member identity (memberId / name) is a product base name (codebuddy / kilo …),
  // sub-agents (leo / peter …) are not product base names, so they sort after the main agent.
  // Under the new model a member's client is the form (vscode / cli), so it cannot be compared against name for the base name.
  return isBaseAgent(m.memberId || m.name);
}

const sorted = computed(() => {
  const order = ['blocked', 'busy', 'idle'];
  // Same rule as the office: filter by the current floor's client (an empty client counts as generic)
  const want = sessions.selectedClient;
  // Recognize every floor's client: merged floors (1F CodeBuddy = CLI + Plugin) must include both variants,
  // and single floors (3F Codex, where CLI and IDE are merged) likewise.
  const allClients = (sessions.floors || []).map((f) => f.client);
  return sourceMembers.value
    // Workstation cards only show resident gremlins; ghosts summoned temporarily (subagent-xxx) are not listed,
    // avoiding the misunderstanding of "a same-named gremlin appearing in the card list after a summon".
    .filter((m) => !isEphemeralMember(m))
    .filter((m) => floorAcceptsClient(want, m.client))
    .slice()
    .map((m) => memberForSession(m, sessions.selectedSessionId, sourceMembers.value))
    // The main agent card is always pinned first (the rest still follow phase order), no longer random
    .sort((a, b) => {
      const am = isMainAgent(a) ? 0 : 1;
      const bm = isMainAgent(b) ? 0 : 1;
      if (am !== bm) return am - bm;
      return order.indexOf(normalizeState(a.state)) - order.indexOf(normalizeState(b.state));
    });
});

/**
 * Main agent card fallback: for floors like 6F Qoder / 7F Kilo / 9F GitHub Copilot,
 * the main agent is discovered by polling / on-disk probing (kilo.db / session-store.db) and is not registered as a roster member by a hook,
 * so the workstation view stays empty with no main agent card; yet the office console (main agent phase for that floor) clearly shows one,
 * and the two disagree. Here we synthesize a main agent card from the floor's product definition (client base name), with the phase taken from
 * the real derived value of the currently selected session (the same source as the office console —— never fabricate activity: no session means standby).
 * Floors that already registered a role='agent' member (1F/3F/4F/8F etc.) are not synthesized again.
 */
const MAIN_STATE_OF_PHASE = {
  tool: 'busy',
  // awaiting permission → the member is blocked (waiting on an external subject), see requirements §5.6
  await: 'blocked',
  // the phase axis distinguishes "thinking" from "calling a tool"; both are the member state `busy`
  thinking: 'busy',
  blocked: 'blocked',
  idle: 'idle',
  done: 'idle',
  unreported: 'idle',
};
const floorAgentBase = computed(() => {
  const f = (sessions.floors || []).find((x) => x.id === sessions.selectedFloor);
  return f && f.client ? String(f.client).toLowerCase() : '';
});
const mainAgentCard = computed(() => {
  // A real main agent member already exists: use it directly, do not synthesize
  if (sorted.value.some((m) => m.role === 'agent' || isMainAgent(m))) return null;
  const base = floorAgentBase.value;
  if (!base) return null;
  const sel = sessions.selected;
  const phase = sel && sel.phase ? sel.phase : 'idle';
  return {
    memberId: `__main_${base}`,
    name: base,
    role: 'agent',
    state: MAIN_STATE_OF_PHASE[phase] || 'idle',
    stateSince: Date.now(),
    reported: Boolean(sel && !sel.inferred),
    tasks: [],
    sessionStatuses: [],
    artifacts: [],
    messageCount: 0,
  };
});
</script>

<template>
  <div class="view">
    <div class="grid">
      <WorkstationCard
        v-if="mainAgentCard"
        :key="mainAgentCard.memberId"
        :member="mainAgentCard"
        :members="sourceMembers"
        :session-id="sessions.selectedSessionId"
      />
      <WorkstationCard
        v-for="m in sorted"
        :key="m.memberId"
        :member="m"
        :members="sourceMembers"
        :session-id="sessions.selectedSessionId"
      />
    </div>

    <p v-if="!mainAgentCard && !sorted.length" class="empty dim">{{ t('workstation.empty') }}</p>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
}

.grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--gap);
  align-content: start;
}

.empty {
  padding: 32px;
  text-align: center;
}
</style>
