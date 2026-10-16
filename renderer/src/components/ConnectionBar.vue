<script setup>
import { computed } from 'vue';
import { useI18n } from '../i18n';

const { t } = useI18n();

const props = defineProps({
  connection: { type: Object, required: true },
  /** Phase source: 'reported' (agent-reported ground truth) / 'inferred' (server-side inference) / 'demo' (demo script) / '' (no session) */
  source: { type: String, default: '' },
  /** Embedded in the host bar (the note bar at the bottom-left of the office): no longer carries its own backing and border, it follows the host */
  bare: { type: Boolean, default: false },
});

/** Phase source text (the demo script is neither "ground truth" nor "inferred", so it gets its own entry) */
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
  <!-- Connection / phase source: the persistent note bar at the **bottom-left** of the office scene (see IsoOfficeView's .tip).
       The project name is not here —— it follows the floor screen, see the far left of the ElevatorDoors lintel. -->
  <div class="bar" :class="{ bare }">
    <span class="conn" :class="dotClass"><i />{{ text }}</span>

    <!-- When a session is selected, show the persistent "phase source" marker; with no session selected, fall back to the explanatory legend -->
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
/* Connection / phase source as one group. It carries its own backing by default (same feel as .hud: semi-transparent + rounded + thin border);
   when embedded in the bottom-left note bar the host already has a backing, so .bare removes its own (see IsoOfficeView's .tip) */
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

/* Persistent phase-source marker: ground truth in green, inferred in dashed gray */
.src { display: inline-flex; align-items: center; gap: 4px; color: var(--text-dim); }
.src b { font-weight: 600; }
.src-real { color: var(--state-online); }
.src-infer { color: var(--text-dim); border-bottom: 1px dashed var(--text-faint); }
/* Demo mode: this phase is neither reported ground truth nor inferred, so list it separately with accent, do not mix it with the other two */
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
