<script setup>
/**
 * FloorSelector —— 左侧竖向堆叠的"楼层"胶囊。
 * 每个楼层对应一个受监控的产品：1F CodeBuddy CLI / 2F WorkBuddy CLI / 3F CodeBuddy 插件。
 *
 * 状态点看的是**这一层有没有活跃会话**（全局活跃会话表，60 分钟没事件会剔除）：
 *   - 有活跃会话：绿色状态点 + 数量角标
 *   - 没有（或压根没装）：灰色状态点
 * 没有活跃会话的楼层照样能点进去，办公室照常显示，只是下拉为空。
 * 未安装（后端没搜到安装位置或落盘数据）：整体置灰，显示"未安装"。
 * 选中：高亮边框（accent + 外发光）。
 */

const props = defineProps({
  products: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

function select(p) {
  emit('update:modelValue', p.id);
}

/** 悬浮提示：活跃会话 + 安装位置 + 落盘统计 */
function tip(p) {
  const lines = [p.name];
  lines.push(
    p.activeCount
      ? `活跃会话：${p.activeCount} 个（状态点绿）`
      : '活跃会话：0 个（状态点灰；60 分钟没有事件就移出表）'
  );
  if (!p.installed) {
    lines.push('未安装（没搜到可执行文件或扩展目录）→ 置灰，不能点');
    return lines.join('\n');
  }
  lines.push(`安装：${p.installPathLabel || '（未定位到可执行文件）'}`);
  if (p.dataPathLabel) {
    const s = p.stats || {};
    const bits = [];
    if (s.sessions) bits.push(`${s.sessions} 个会话文件`);
    if (s.files) bits.push(`${s.files} 个文件`);
    if (s.sizeLabel) bits.push(s.sizeLabel);
    if (s.lastModifiedAt) bits.push(`最后写入 ${new Date(s.lastModifiedAt).toLocaleString()}`);
    lines.push(`落盘：${p.dataPathLabel}${bits.length ? `（${bits.join(' · ')}）` : ''}`);
  } else {
    lines.push('落盘：未找到数据目录');
  }
  return lines.join('\n');
}

/** 胶囊上那行小字：优先显示落盘路径，没有就显示安装路径 */
function pathLine(p) {
  if (!p.installed) return '未安装';
  return p.dataPathLabel || p.installPathLabel || '已安装';
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
      :disabled="!p.installed"
      :title="tip(p)"
      @click="select(p)"
    >
      <span class="fid">{{ p.id }}</span>
      <span class="fname">{{ p.name }}</span>
      <span class="fpath">{{ pathLine(p) }}</span>
      <span class="fstat">
        <span class="fdot" :class="p.activeCount ? 'on' : 'off'" />
        <span v-if="p.activeCount" class="fbadge">{{ p.activeCount }}</span>
      </span>
    </button>
  </aside>
</template>

<style scoped>
.rail {
  flex: 0 0 140px;
  width: 140px;
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
  padding: 14px 8px 16px;
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
  opacity: 0.9;
}

/* 落盘路径：单行截断，完整内容在 title 里 */
.floor .fpath {
  max-width: 100%;
  font-size: 10px;
  line-height: 1.2;
  color: var(--muted, #6e7681);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.floor .fdot {
  width: 8px;
  height: 8px;
  margin-top: 2px;
  border-radius: 50%;
  background: var(--ok, #3fb950);
  box-shadow: 0 0 6px var(--ok, #3fb950);
}

.floor .fdot.off {
  background: var(--muted, #6e7681);
  box-shadow: none;
}

/* 状态点 + 活跃会话数 */
.floor .fstat {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.floor .fbadge {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ok, #3fb950) 22%, transparent);
  color: var(--ok, #3fb950);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}

/* 选中：高亮边框 + 外发光 */
.floor.selected {
  border-color: var(--accent, #58a6ff);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #58a6ff) 28%, transparent);
}

/* 未安装：整体置灰 + 点不动 */
.floor.dim {
  color: var(--muted, #6e7681);
  border-color: var(--border);
  opacity: 0.45;
}

.floor.dim:hover {
  border-color: var(--muted, #6e7681);
}

.floor:disabled {
  cursor: not-allowed;
}

.floor:disabled:hover {
  border-color: var(--border);
}
</style>
