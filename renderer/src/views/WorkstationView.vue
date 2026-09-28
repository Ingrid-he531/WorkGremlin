<script setup>
import { computed } from 'vue';
import WorkstationCard from '../components/WorkstationCard.vue';
import { useProjectStore } from '../stores/project';
import { useSessionStore } from '../stores/sessions';
import { isEphemeralMember } from '../lib/ephemeral';
import { floorAcceptsClient } from '../lib/clientMatch';
import { clientBase } from '@workgremlin/shared';

const project = useProjectStore();
const sessions = useSessionStore();

// 主 agent：成员名（剥 -plugin）等于其 client 基名（codebuddy / qoder / codex …），
// 对应 hook 注册的那只"本层主 agent"；子代理（leo / peter / software-architect…）名与基名不同。
function isMainAgent(m) {
  return clientBase(m.name) === clientBase(m.client);
}

const sorted = computed(() => {
  const order = ['blocked', 'busy', 'thinking', 'online', 'idle', 'offline'];
  // 与办公室同一口径：按当前楼层的客户端过滤（client 为空的视作通用）
  const want = sessions.selectedClient;
  // 所有楼层的 client 都认一遍：合并楼层（1F CodeBuddy = CLI + Plugin）要把两种变体都收进来，
  // 单楼层（3F Codex 这种 CLI 与 IDE 合并的）同理。
  const allClients = (sessions.floors || []).map((f) => f.client);
  return project.members
    // 工位卡片只显示常住小怪物；临时召唤出来的幽灵（subagent-xxx）不在这张表里占位，
    // 避免"召唤后卡片列表里多出同名小怪物"的误会。
    .filter((m) => !isEphemeralMember(m))
    .filter((m) => floorAcceptsClient(want, m.client, allClients))
    .slice()
    // 主 agent 卡片固定排最前（其余仍按相位顺序），不再随机
    .sort((a, b) => {
      const am = isMainAgent(a) ? 0 : 1;
      const bm = isMainAgent(b) ? 0 : 1;
      if (am !== bm) return am - bm;
      return order.indexOf(a.state) - order.indexOf(b.state);
    });
});

/**
 * 主 agent 卡片兜底：6F Qoder / 7F Kilo / 9F GitHub Copilot 这类楼层，
 * 主 agent 走轮询 / 落盘探测（kilo.db / session-store.db），不经由 hook 注册成 roster 成员，
 * 工位视图原本就空着、没有主代理卡片；但办公室控制台（同层主 agent 相位）明明有显示，
 * 两边不一致。这里按楼层产品定义（client 基名）合成一张主代理卡片，相位取自当前选中会话
 * 的真实推导值（与办公室控制台同一来源，绝不编造活动：没有会话就显示待命）。
 * 楼层自己已注册了 role='agent' 成员时（1F/3F/4F/8F 等）不重复合成。
 */
const MAIN_STATE_OF_PHASE = {
  tool: 'busy',
  await: 'busy',
  thinking: 'thinking',
  blocked: 'blocked',
  idle: 'idle',
  done: 'idle',
  unreported: 'idle',
};
const floorAgentBase = computed(() => {
  const f = (sessions.floors || []).find((x) => x.id === sessions.selectedFloor);
  return f && f.client ? clientBase(f.client) : '';
});
const mainAgentCard = computed(() => {
  // 已有真实主 agent 成员：直接用，不合成
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
    // 轮询 / 落盘推导的相位是推断值（不标真值），如实标灰；没有会话则状态未知
    degraded: !sel || Boolean(sel.inferred),
    stateSince: Date.now(),
    lastSeenAt: Date.now(),
    reported: Boolean(sel && !sel.inferred),
    task: null,
    artifacts: [],
    messageCount: 0,
  };
});
</script>

<template>
  <div class="view">
    <div class="grid">
      <WorkstationCard v-if="mainAgentCard" :key="mainAgentCard.memberId" :member="mainAgentCard" />
      <WorkstationCard v-for="m in sorted" :key="m.memberId" :member="m" />
    </div>

    <p v-if="!mainAgentCard && !sorted.length" class="empty dim">本层暂无成员</p>
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
