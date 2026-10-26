<script setup>
/**
 * Remote dispatch page — a long-running conversation with one floor on the server machine.
 *
 * Layout mirrors the council's intent: a list of sessions on the left, one transcript on the right.
 * Each prompt is a turn; the turn's output is streamed over WS while the CLI runs. The office and
 * task records are not written here: the spawned CLI is a normal session, recorded by the product.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from '../i18n';
import { useProjectStore } from '../stores/project';
import { useDispatchStore } from '../stores/dispatch';

const { t } = useI18n();
const project = useProjectStore();
const dispatch = useDispatchStore();

const showNew = ref(false);
const floor = ref('8F');
const workspace = ref('');
const model = ref('');
const prompt = ref('');
const error = ref('');
const sending = ref(false);
const creating = ref(false);
const scroller = ref(null);

const session = computed(() => dispatch.current);
const active = computed(() => dispatch.activeTurn);
const canSend = computed(
  () =>
    Boolean(session.value) &&
    Boolean(prompt.value.trim()) &&
    !active.value &&
    dispatch.mode !== 'off' &&
    !sending.value
);

const modeHint = computed(() => {
  if (dispatch.mode === 'off') return t('dispatch.mode_off');
  if (dispatch.mode === 'confirm') {
    return dispatch.canApprove ? t('dispatch.mode_confirm') : t('dispatch.mode_remote');
  }
  return '';
});

/** Cheap reactivity key for auto-scroll: turn count + the last turn's growth. */
const progressKey = computed(() => {
  const turns = session.value ? session.value.turns : [];
  const last = turns[turns.length - 1];
  return `${turns.length}:${last ? last.state : ''}:${last ? (last.output || '').length : 0}`;
});

onMounted(async () => {
  await dispatch.refresh(project.serverInfo || {});
  if (!dispatch.sessions.length) openNew();
});

watch(progressKey, () => {
  nextTick(() => {
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
});

function openNew() {
  showNew.value = true;
  error.value = '';
  if (!workspace.value) workspace.value = project.workspacePath || '';
}

function stateLabel(state) {
  return t(`dispatch.state.${state || 'pending'}`);
}

async function create() {
  if (creating.value) return;
  creating.value = true;
  error.value = '';
  try {
    await dispatch.createSession(project.serverInfo || {}, {
      floor: floor.value,
      workspacePath: workspace.value.trim(),
      model: model.value.trim() || undefined,
    });
    showNew.value = false;
  } catch (err) {
    error.value = (err && err.message) || String(err);
  } finally {
    creating.value = false;
  }
}

async function send() {
  if (!canSend.value) return;
  sending.value = true;
  error.value = '';
  try {
    await dispatch.sendTurn(project.serverInfo || {}, prompt.value.trim());
    prompt.value = '';
  } catch (err) {
    error.value = (err && err.message) || String(err);
  } finally {
    sending.value = false;
  }
}

async function cancelTurn(id) {
  error.value = '';
  try {
    await dispatch.cancelTurn(project.serverInfo || {}, id);
  } catch (err) {
    error.value = (err && err.message) || String(err);
  }
}

async function removeSession(id) {
  if (!window.confirm(t('dispatch.delete_confirm'))) return;
  error.value = '';
  try {
    await dispatch.deleteSession(project.serverInfo || {}, id);
    if (!dispatch.sessions.length) openNew();
  } catch (err) {
    error.value = (err && err.message) || String(err);
  }
}

function open(id) {
  showNew.value = false;
  dispatch.open(project.serverInfo || {}, id);
}

/** Prompt is sent with Enter; Shift+Enter inserts a newline. */
function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="dispatch-page" data-testid="dispatch-page">
    <aside class="side">
      <div class="side-head">
        <span class="side-title">{{ t('dispatch.sessions') }}</span>
        <button type="button" class="new-btn" @click="openNew">{{ t('dispatch.new') }}</button>
      </div>
      <div class="session-list">
        <button
          v-for="s in dispatch.sessions"
          :key="s.id"
          type="button"
          class="session-item"
          :class="{ on: !showNew && dispatch.currentId === s.id }"
          @click="open(s.id)"
        >
          <span class="s-title">{{ s.title || t('dispatch.untitled') }}</span>
          <span class="s-meta">
            <span>{{ s.floor }}</span>
            <span class="dot" :data-state="s.state" />
            <span>{{ stateLabel(s.state) }}</span>
          </span>
        </button>
        <p v-if="!dispatch.sessions.length" class="empty">{{ t('dispatch.empty') }}</p>
      </div>
    </aside>

    <section class="chat">
      <!-- New session -->
      <div v-if="showNew || !session" class="new-card">
        <div class="card-title">{{ t('dispatch.create_title') }}</div>
        <label class="field">
          <span class="lbl">{{ t('dispatch.floor') }}</span>
          <select v-model="floor" class="input">
            <option v-for="f in dispatch.floors" :key="f.id" :value="f.id" :disabled="!f.available">
              {{ f.id }} · OpenCode{{ f.available ? '' : ' —' }}
            </option>
          </select>
        </label>
        <label class="field">
          <span class="lbl">{{ t('dispatch.workspace') }}</span>
          <input v-model="workspace" class="input mono" :placeholder="t('dispatch.workspace_ph')" />
        </label>
        <label class="field">
          <span class="lbl">{{ t('dispatch.model') }}</span>
          <input v-model="model" class="input mono" :placeholder="t('dispatch.model_ph')" />
        </label>
        <p v-if="modeHint" class="hint" :class="{ bad: dispatch.mode === 'off' }">{{ modeHint }}</p>
        <p v-if="dispatch.configFile" class="hint mono">
          {{ t('dispatch.config_file', { path: dispatch.configFile }) }}
        </p>
        <p v-if="error" class="err">{{ error }}</p>
        <div class="actions">
          <button
            v-if="dispatch.sessions.length"
            type="button"
            class="ghost"
            @click="showNew = false"
          >
            {{ t('dispatch.close') }}
          </button>
          <button type="button" class="primary" :disabled="creating" @click="create">
            {{ t('dispatch.create') }}
          </button>
        </div>
      </div>

      <!-- Existing session -->
      <template v-else>
        <header class="chat-head">
          <div class="chat-title">
            <span class="t">{{ session.title || t('dispatch.untitled') }}</span>
            <span class="meta">
              {{ session.floor }} ·
              <span class="mono">{{ session.workspacePath }}</span>
            </span>
          </div>
          <div class="chat-actions">
            <span class="state" :data-state="session.state">{{ stateLabel(session.state) }}</span>
            <button type="button" class="ghost small" @click="removeSession(session.id)">
              {{ t('dispatch.delete') }}
            </button>
          </div>
        </header>

        <div ref="scroller" class="transcript">
          <div v-for="turn in session.turns" :key="turn.id" class="turn" :data-state="turn.state">
            <div class="turn-head">
              <span class="who">{{ t('dispatch.you') }}</span>
              <span class="state" :data-state="turn.state">{{ stateLabel(turn.state) }}</span>
              <span v-if="turn.state === 'pending' || turn.state === 'running'" class="grow" />
              <button
                v-if="turn.state === 'pending' || turn.state === 'running'"
                type="button"
                class="ghost tiny"
                @click="cancelTurn(turn.id)"
              >
                {{ t('dispatch.cancel_request') }}
              </button>
            </div>
            <div class="prompt">{{ turn.prompt }}</div>
            <pre v-if="turn.output" class="output">{{ turn.output }}</pre>
            <p v-else-if="turn.state === 'running'" class="waiting">{{ t('dispatch.waiting_output') }}</p>
            <p v-if="turn.error" class="err">{{ turn.error }}</p>
          </div>
          <p v-if="!session.turns.length" class="empty">{{ t('dispatch.session_empty') }}</p>
        </div>

        <div class="composer">
          <textarea
            v-model="prompt"
            class="input area"
            rows="3"
            :placeholder="t('dispatch.composer_ph')"
            :disabled="dispatch.mode === 'off'"
            @keydown="onKeydown"
          />
          <div class="composer-side">
            <p v-if="modeHint" class="hint" :class="{ bad: dispatch.mode === 'off' }">{{ modeHint }}</p>
            <p v-if="active" class="hint">{{ t('dispatch.active_hint') }}</p>
            <p v-if="error" class="err">{{ error }}</p>
            <button type="button" class="primary send" :disabled="!canSend" @click="send">
              {{ t('dispatch.send') }}
            </button>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.dispatch-page {
  display: flex;
  height: 100%;
  min-height: 0;
  color: var(--text);
}
.side {
  width: 260px;
  flex: 0 0 260px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  min-height: 0;
}
.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.side-title {
  font-size: 12px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.new-btn {
  border: 1px solid var(--accent);
  background: var(--accent-soft);
  color: var(--text);
  border-radius: 7px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.session-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px;
}
.session-item {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  border-radius: 8px;
  padding: 8px 10px;
  cursor: pointer;
}
.session-item:hover {
  background: rgba(255, 255, 255, 0.04);
}
.session-item.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.s-title {
  display: block;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.s-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-dim);
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-dim);
}
.dot[data-state='running'],
.dot[data-state='pending'] {
  background: #f0b429;
}
.dot[data-state='idle'] {
  background: #7ee0a0;
}
.chat {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.chat-title .t {
  display: block;
  font-size: 14px;
  font-weight: 600;
}
.chat-title .meta {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-dim);
}
.chat-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.state {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  white-space: nowrap;
}
.state[data-state='running'],
.state[data-state='pending'] {
  color: #f0b429;
  border-color: rgba(240, 180, 41, 0.4);
}
.state[data-state='done'],
.state[data-state='idle'] {
  color: #7ee0a0;
  border-color: rgba(126, 224, 160, 0.4);
}
.state[data-state='failed'],
.state[data-state='timeout'],
.state[data-state='cancelled'],
.state[data-state='rejected'],
.state[data-state='expired'] {
  color: #ff9b9b;
  border-color: rgba(255, 155, 155, 0.4);
}
.transcript {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px 16px 6px;
}
.turn {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 12px;
  background: rgba(255, 255, 255, 0.02);
}
.turn-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.who {
  font-size: 12px;
  font-weight: 600;
}
.grow {
  flex: 1;
}
.prompt {
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.output {
  margin: 8px 0 0;
  padding: 10px;
  max-height: 420px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.25);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.waiting {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-dim);
}
.composer {
  display: flex;
  gap: 12px;
  padding: 10px 16px 14px;
  border-top: 1px solid var(--border);
}
.composer .area {
  flex: 1;
  min-height: 64px;
}
.composer-side {
  width: 240px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.send {
  align-self: flex-end;
  margin-top: auto;
}
.input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  color: var(--text);
  font: inherit;
  font-size: 13px;
}
.area {
  resize: vertical;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.field {
  display: block;
  margin-bottom: 10px;
}
.lbl {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--text-dim);
}
.new-card {
  margin: 18px auto;
  width: min(560px, 92%);
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.02);
}
.card-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 12px;
}
.primary,
.ghost {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  padding: 6px 14px;
  cursor: pointer;
  font-size: 12px;
}
.primary {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.small {
  padding: 4px 10px;
}
.tiny {
  padding: 2px 8px;
  font-size: 11px;
}
.hint {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-dim);
}
.hint.bad {
  color: #ffb86b;
}
.err {
  margin: 6px 0 0;
  font-size: 12px;
  color: #ff8a8a;
  word-break: break-word;
}
.empty {
  padding: 18px 12px;
  font-size: 12px;
  color: var(--text-dim);
  text-align: center;
}
</style>
