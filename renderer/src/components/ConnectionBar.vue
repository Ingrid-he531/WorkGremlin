<script setup>
import { computed } from 'vue';

const props = defineProps({
  connection: { type: Object, required: true },
  team: { type: Object, default: null },
  /** 当前工程名；仅作展示，工程切换改由右侧"活跃会话"下拉负责，不再提供选择入口 */
  project: { type: String, default: '' },
});

const text = computed(() => {
  switch (props.connection.state) {
    case 'open':
      return '实时连接已建立';
    case 'connecting':
      return '连接中…';
    case 'closed':
      return '连接断开，重连中…';
    default:
      return props.connection.state;
  }
});

const dotClass = computed(() => props.connection.state);
</script>

<template>
  <div class="bar">
    <span class="conn" :class="dotClass"><i />{{ text }}</span>
    <span v-if="team" class="dim">团队：{{ team.name }}</span>
    <span v-if="project" class="dim proj">项目：{{ project }}</span>

    <span class="spacer" />
    <span class="legend faint">
      <i class="sw real" />上报真值
      <i class="sw infer" />推断值
    </span>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 12px;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}

.conn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.conn i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--state-idle);
}

.conn.open i { background: var(--state-online); }
.conn.connecting i { background: var(--state-busy); }
.conn.closed i { background: var(--state-blocked); }

.proj { font: inherit; }

.spacer { flex: 1; }

.legend { display: inline-flex; align-items: center; gap: 6px; }

.sw {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
}

.sw.real { background: var(--state-online); }
.sw.infer { background: var(--state-idle); border: 1px dashed var(--text-faint); }
</style>
