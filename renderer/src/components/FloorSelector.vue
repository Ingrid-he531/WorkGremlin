<script setup>
/**
 * FloorSelector —— 左侧竖向堆叠的"楼层"胶囊。
 * 每个楼层对应一个受监控的产品：1F CodeBuddy CLI / 2F WorkBuddy CLI / 3F CodeBuddy 插件。
 *   - 选中：高亮边框（accent + 外发光）
 *   - 已安装：正常颜色 + 绿色状态点
 *   - 未安装：整体置灰
 */
const props = defineProps({
  products: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

function select(p) {
  emit('update:modelValue', p.id);
}
</script>

<template>
  <aside class="rail" aria-label="楼层选择">
    <header class="rail-title">楼层</header>
    <button
      v-for="p in products"
      :key="p.id"
      type="button"
      class="floor"
      :class="{ selected: p.id === modelValue, dim: !p.installed }"
      :title="`${p.name} · ${p.installed ? '已安装' : '未安装'}`"
      @click="select(p)"
    >
      <span class="fid">{{ p.id }}</span>
      <span class="fname">{{ p.name }}</span>
      <span class="fdot" :class="p.installed ? 'on' : 'off'" />
    </button>
  </aside>
</template>

<style scoped>
.rail {
  flex: 0 0 104px;
  width: 104px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 10px;
  border-right: 1px solid var(--border);
  background: var(--panel, #0e1116);
  overflow-y: auto;
}

.rail-title {
  font-size: 11px;
  letter-spacing: 2px;
  color: var(--muted, #6e7681);
  text-align: center;
  margin-bottom: 2px;
}

.floor {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 6px;
  border-radius: 16px;
  border: 2px solid var(--border);
  background: var(--surface, #161b22);
  color: var(--text, #e6edf3);
  cursor: pointer;
  font: inherit;
  transition: border-color 0.15s, transform 0.1s, opacity 0.15s, box-shadow 0.15s;
}

.floor:hover {
  border-color: var(--accent, #58a6ff);
}

.floor:active {
  transform: translateY(1px);
}

.floor .fid {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 0.5px;
  line-height: 1;
}

.floor .fname {
  font-size: 11px;
  line-height: 1.25;
  text-align: center;
  opacity: 0.85;
}

.floor .fdot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ok, #3fb950);
  box-shadow: 0 0 6px var(--ok, #3fb950);
}

.floor .fdot.off {
  background: var(--muted, #6e7681);
  box-shadow: none;
}

/* 选中：高亮边框 + 外发光 */
.floor.selected {
  border-color: var(--accent, #58a6ff);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #58a6ff) 28%, transparent);
}

/* 未安装：整体置灰 */
.floor.dim {
  color: var(--muted, #6e7681);
  border-color: var(--border);
  opacity: 0.55;
}

.floor.dim:hover {
  border-color: var(--muted, #6e7681);
}
</style>
