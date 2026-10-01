<script setup>
import { computed } from 'vue';
import MessageList from '../components/MessageList.vue';
import MessageFilters from '../components/MessageFilters.vue';
import SearchBox from '../components/SearchBox.vue';
import { useProjectStore } from '../stores/project';
import { useMessageStore } from '../stores/messages';
import { useI18n } from '../i18n';

const project = useProjectStore();
const msgs = useMessageStore();
const { t } = useI18n();

const shown = computed(() => msgs.filtered);
</script>

<template>
  <div class="view">
    <div class="toolbar">
      <MessageFilters
        :members="project.members"
        :model-value="msgs.filters"
        @update:model-value="msgs.setFilters($event)"
        @clear="msgs.clearFilters()"
      />
      <span class="spacer" />
      <span class="dim">{{ t('chat.count', { shown: shown.length, total: msgs.count }) }}</span>
      <SearchBox :model-value="msgs.keyword" @update:model-value="msgs.setKeyword($event)" />
    </div>

    <MessageList
      :messages="shown"
      :auto-follow="msgs.autoFollow"
      @update:auto-follow="msgs.setAutoFollow($event)"
    />

    <div v-if="msgs.pendingCount" class="pending" data-testid="archive-notice">
      {{ t('chat.new_messages', { n: msgs.pendingCount }) }}
    </div>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.spacer { flex: 1; }

.pending {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
  background: var(--accent-soft);
  border: 1px solid var(--accent);
}
</style>
