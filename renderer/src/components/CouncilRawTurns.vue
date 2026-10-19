<script setup>
/**
 * Raw turns of one council round.
 *
 * The structured view above it only shows what parsed successfully. This shows every turn that
 * actually happened — its body text, or the raw error when it did not answer — so a failed or
 * half-finished round never turns into a blank space once the meeting is over.
 */
import { useCouncilStore } from '../stores/council';
import { useI18n } from '../i18n';

defineProps({
  utterances: { type: Array, default: () => [] },
});

const store = useCouncilStore();
const { t } = useI18n();

const floorName = (id) => {
  const f = store.floors.find((x) => x.floorId === id);
  return f ? f.name : '';
};
</script>

<template>
  <div class="raw-turns" data-testid="cv-raw-turns">
    <p v-if="!utterances.length" class="empty">{{ t('council.no_turns') }}</p>
    <article v-for="(u, i) in utterances" :key="i" class="turn">
      <header class="hd">
        <span class="fid">{{ u.floorId }}</span>
        <span v-if="floorName(u.floorId)" class="fname">{{ floorName(u.floorId) }}</span>
        <span class="chip">{{ t('council.phase.' + u.phase) }}</span>
        <span class="chip" :class="{ bad: u.status !== 'ok' }">{{ t('council.pstatus.' + u.status) }}</span>
        <span v-if="u.durationMs" class="dim ms">{{ (u.durationMs / 1000).toFixed(1) }}s</span>
      </header>
      <pre v-if="u.content" class="text">{{ u.content }}</pre>
      <p v-if="u.error" class="err">{{ u.error }}</p>
      <p v-if="!u.content && !u.error" class="dim">{{ t('council.turn_empty') }}</p>
    </article>
  </div>
</template>

<style scoped>
.raw-turns { margin-top: 10px; }
.empty { font-size: 12px; color: var(--text-faint); }
.turn {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: color-mix(in srgb, var(--text) 3%, transparent);
}
.hd { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 11px; }
.fid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-dim); }
.fname { color: var(--text-dim); }
.chip {
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-dim);
}
.chip.bad { color: var(--bad, #e5534b); border-color: currentColor; }
.dim { color: var(--text-faint); }
.ms { margin-left: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.text {
  margin: 8px 0 0;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-dim);
}
.err { margin: 8px 0 0; font-size: 12px; color: var(--bad, #e5534b); white-space: pre-wrap; }
</style>
