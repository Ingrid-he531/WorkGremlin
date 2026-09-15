<script setup>
import { computed, ref } from 'vue';
import { chooseWorkspace } from '../api/bridge';

const props = defineProps({
  connection: { type: Object, required: true },
  demo: { type: Boolean, default: false },
  team: { type: Object, default: null },
  /** 当前工程名；空串时回落到原来的演示模式提示 */
  project: { type: String, default: '' },
  /** 最近打开过的工程（路径 + 工程名） */
  recent: { type: Array, default: () => [] },
  /** 当前工程下 subagent 清单文件路径 */
  feedPath: { type: String, default: '' },
  /** 屋里有没有人（没人时提示"等待上报"） */
  memberCount: { type: Number, default: 0 },
});

const emit = defineEmits(['open-workspace']);

const open = ref(false);
const error = ref('');

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

async function pick() {
  error.value = '';
  const dir = await chooseWorkspace();
  if (!dir) return;
  open.value = false;
  emit('open-workspace', dir);
}

function pickRecent(path) {
  open.value = false;
  emit('open-workspace', path);
}

function pickDemo() {
  open.value = false;
  emit('open-workspace', 'demo');
}
</script>

<template>
  <div class="bar">
    <span class="conn" :class="dotClass"><i />{{ text }}</span>
    <span v-if="team" class="dim">团队：{{ team.name }}</span>

    <span class="wrap">
      <!-- 同一个位置：平时显示工程名；演示数据仍在原位保留角标 -->
      <button v-if="project" class="project" data-testid="project-badge" @click="open = !open">
        项目：{{ project }}<em v-if="demo"> · 演示数据</em><em v-else-if="!memberCount"> · 等待上报</em>
        <b class="caret">▾</b>
      </button>
      <button v-else class="demo" data-testid="watcher-banner" @click="open = !open">
        演示模式（数据为确定性 mock）<b class="caret">▾</b>
      </button>

      <div v-if="open" class="panel">
        <button class="item" @click="pick">打开工程…</button>
        <template v-if="recent.length">
          <div class="sep">最近打开</div>
          <button v-for="r in recent" :key="r.path" class="item mono" @click="pickRecent(r.path)">
            {{ r.project || r.path }}
            <em>{{ r.path }}</em>
          </button>
        </template>
        <div class="sep">其它</div>
        <button class="item" :class="{ on: demo }" @click="pickDemo">演示数据（确定性 mock）</button>
        <div v-if="feedPath" class="hint">
          subagent 清单：<code>{{ feedPath }}</code>
        </div>
        <div v-if="error" class="hint err">{{ error }}</div>
      </div>
    </span>

    <span class="spacer" />
    <span class="legend faint">
      <i class="sw real" />上报真值
      <i class="sw infer" />推断值
    </span>
    <!-- 点空白处收起工程菜单 -->
    <div v-if="open" class="backdrop" @click="open = false" />
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

.wrap { position: relative; display: inline-flex; }

.demo,
.project {
  padding: 1px 8px;
  border-radius: 999px;
  font: inherit;
  color: var(--text);
  cursor: pointer;
}

.demo {
  border: 1px dashed var(--border-strong);
  color: var(--text-dim);
  background: transparent;
}

.project {
  border: 1px solid var(--border-strong);
  background: var(--accent-soft);
}

.demo em,
.project em {
  font-style: normal;
  color: var(--text-dim);
}

.caret {
  margin-left: 4px;
  font-weight: 400;
  color: var(--text-dim);
}

.panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 30;
  min-width: 280px;
  max-width: 420px;
  padding: 6px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg-elevated);
  box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
}

.item {
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.item:hover { background: var(--accent-soft); }
.item.on { color: var(--accent); }

.item.mono { display: flex; flex-direction: column; gap: 2px; }
.item.mono em { font-style: normal; color: var(--text-dim); font-size: 11px; }

.sep {
  padding: 6px 8px 2px;
  color: var(--text-faint);
  font-size: 11px;
}

.hint {
  padding: 6px 8px;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.5;
  word-break: break-all;
}

.hint code {
  color: var(--text);
  font-size: 11px;
}

.err { color: var(--state-blocked); }

.spacer { flex: 1; }

.backdrop { position: fixed; inset: 0; z-index: 20; }

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
