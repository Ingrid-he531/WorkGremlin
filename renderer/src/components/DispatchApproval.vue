<script setup>
/**
 * Server-side approval dialog for a remote dispatch request.
 *
 * Only the window that talks to a server on its own machine shows this: the server rejects
 * decisions that do not come from loopback, and a remote client only sees "waiting for approval".
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from '../i18n';
import { useProjectStore } from '../stores/project';
import { useDispatchStore } from '../stores/dispatch';
import { focusWindow } from '../api/bridge';

const { t } = useI18n();
const project = useProjectStore();
const dispatch = useDispatchStore();

const busy = ref(false);
const error = ref('');
const tick = ref(Date.now());
let timer = null;

/** { turn, session } of the first request waiting for a decision on this machine */
const item = computed(() => (dispatch.canApprove ? dispatch.pending : null));
const remaining = computed(() => {
  const deadline = item.value && item.value.turn && item.value.turn.pendingDeadline;
  if (!deadline) return 0;
  return Math.max(0, Math.ceil((deadline - tick.value) / 1000));
});

watch(
  item,
  (value) => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (value) {
      tick.value = Date.now();
      timer = setInterval(() => {
        tick.value = Date.now();
      }, 1000);
      // The operator may be in another app; bring the server window forward for the decision.
      focusWindow();
    }
  },
  { immediate: true }
);

onUnmounted(() => {
  if (timer) clearInterval(timer);
});

async function decide(approve) {
  if (!item.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await dispatch.decide(project.serverInfo || {}, item.value.turn.id, approve);
  } catch (err) {
    error.value = (err && err.message) || String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="item" class="mask" data-testid="dispatch-approval">
    <div class="panel" role="dialog" aria-modal="true">
      <div class="head">
        <span class="title">{{ t('dispatch.approval_title') }}</span>
        <span class="count" v-if="remaining > 0">{{ t('dispatch.expires_in', { n: remaining }) }}</span>
      </div>

      <div class="row">
        <span class="k">{{ t('dispatch.floor') }}</span>
        <span class="v">{{ item.session.floor }}</span>
      </div>
      <div class="row">
        <span class="k">{{ t('dispatch.workspace') }}</span>
        <span class="v mono">{{ item.session.workspacePath }}</span>
      </div>
      <div class="prompt">{{ item.turn.prompt }}</div>

      <p class="hint">{{ t('dispatch.approval_hint') }}</p>
      <p v-if="error" class="err">{{ error }}</p>

      <div class="actions">
        <button type="button" class="reject" :disabled="busy" @click="decide(false)">
          {{ t('dispatch.reject') }}
        </button>
        <button type="button" class="allow" :disabled="busy" @click="decide(true)">
          {{ t('dispatch.allow') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(4, 6, 10, 0.62);
}
.panel {
  width: min(560px, 92vw);
  padding: 18px 20px 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel, #171a21);
  color: var(--text);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.title {
  font-size: 15px;
  font-weight: 600;
}
.count {
  font-size: 12px;
  color: var(--muted, #8b93a7);
}
.row {
  display: flex;
  gap: 10px;
  margin: 4px 0;
  font-size: 13px;
}
.k {
  min-width: 86px;
  color: var(--muted, #8b93a7);
}
.v {
  word-break: break-all;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.prompt {
  margin: 12px 0;
  padding: 10px 12px;
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.hint {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--muted, #8b93a7);
}
.err {
  margin: 0 0 6px;
  font-size: 12px;
  color: #ff8a8a;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 12px;
}
.actions button {
  padding: 7px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.actions .allow {
  border-color: var(--accent);
  background: var(--accent-soft, rgba(90, 140, 255, 0.18));
}
.actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
