<script setup>
import { computed } from 'vue';
import { useI18n } from '../i18n';

const { t } = useI18n();

const props = defineProps({
  connection: { type: Object, required: true },
  /** 相位来源：'reported'（agent 上报真值）/ 'inferred'（服务端推断）/ 'demo'（演示脚本）/ ''（无会话） */
  source: { type: String, default: '' },
  /** 嵌进宿主条里（办公室左下角说明条）：不再自带底板与边框，跟着宿主走 */
  bare: { type: Boolean, default: false },
});

/** 相位来源文案（演示脚本不是"真值"也不是"推断"，单列一项） */
const sourceText = computed(() =>
  props.source === 'demo'
    ? t('conn.source.demo')
    : props.source === 'inferred'
      ? t('conn.source.inferred')
      : t('conn.source.reported')
);

const text = computed(() => {
  switch (props.connection.state) {
    case 'open':
      return t('conn.connected');
    case 'connecting':
      return t('conn.connecting');
    case 'closed':
      return t('conn.disconnected');
    default:
      return props.connection.state;
  }
});

const dotClass = computed(() => props.connection.state);
</script>

<template>
  <!-- 连接 / 相位来源：常驻办公室场景**左下角**说明条（见 IsoOfficeView 的 .tip）。
       项目名不在这里 —— 它跟着楼层屏走，见 ElevatorDoors 门楣最左边。 -->
  <div class="bar" :class="{ bare }">
    <span class="conn" :class="dotClass"><i />{{ text }}</span>

    <!-- 选中会话时给常驻的「相位来源」标识；没选会话时退回解释性图例 -->
    <span v-if="source" class="src">
      {{ t('conn.source_label') }}：
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
      <i class="sw real" />{{ t('conn.source.reported') }}
      <i class="sw infer" />{{ t('conn.source.inferred') }}
    </span>
  </div>
</template>

<style scoped>
/* 连接 / 相位来源一组。默认自带底板（跟 .hud 一套观感：半透明 + 圆角 + 细边）；
   嵌进左下角说明条时宿主已经有底板了，用 .bare 摘掉自己这份（见 IsoOfficeView 的 .tip） */
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

.bar.bare {
  background: transparent;
  border: 0;
  padding: 0;
  backdrop-filter: none;
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
