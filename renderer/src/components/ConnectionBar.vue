<script setup>
import { computed } from 'vue';

const props = defineProps({
  connection: { type: Object, required: true },
  /** 当前工程名；仅作展示，工程切换改由右侧"活跃会话"下拉负责，不再提供选择入口 */
  project: { type: String, default: '' },
  /** 相位来源：'reported'（agent 上报真值）/ 'inferred'（服务端推断）/ 'demo'（演示脚本）/ ''（无会话） */
  source: { type: String, default: '' },
});

/** 相位来源文案（演示脚本不是"真值"也不是"推断"，单列一项） */
const sourceText = computed(() =>
  props.source === 'demo' ? '演示脚本' : props.source === 'inferred' ? '推断值' : '上报真值'
);

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
  <!-- 连接 / 项目 / 相位来源：三样并排一组，常驻办公室场景左上角（见 IsoOfficeView 的 .status-hud） -->
  <div class="bar">
    <span class="conn" :class="dotClass"><i />{{ text }}</span>
    <span v-if="project" class="dim proj">项目：{{ project }}</span>

    <!-- 选中会话时给常驻的「相位来源」标识；没选会话时退回解释性图例 -->
    <span v-if="source" class="src">
      相位来源：
      <b
        :class="{
          'src-infer': source === 'inferred',
          'src-real': source === 'reported',
          'src-demo': source === 'demo',
        }"
      >
        {{ sourceText }}
      </b>
    </span>
    <span v-else class="legend faint">
      <i class="sw real" />上报真值
      <i class="sw infer" />推断值
    </span>
  </div>
</template>

<style scoped>
/* 浮在办公室场景左上角的小徽标：跟 .hud 一套观感（半透明 + 圆角 + 细边） */
.bar {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(12, 15, 20, 0.82);
  border: 1px solid var(--border);
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  backdrop-filter: blur(2px);
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

.legend { display: inline-flex; align-items: center; gap: 6px; }

/* 相位来源常驻标识：真值绿、推断灰虚 */
.src { display: inline-flex; align-items: center; gap: 4px; color: var(--text-dim); }
.src b { font-weight: 600; }
.src-real { color: var(--state-online); }
.src-infer { color: var(--text-dim); border-bottom: 1px dashed var(--text-faint); }
/* 演示模式：这一路的相位既不是上报真值也不是推断，用 accent 单列，别跟前两者混 */
.src-demo { color: var(--accent, #4c8dff); }

.sw {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
}

.sw.real { background: var(--state-online); }
.sw.infer { background: var(--state-idle); border: 1px dashed var(--text-faint); }
</style>
