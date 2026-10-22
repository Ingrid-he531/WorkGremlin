<script setup>
/**
 * Council: one moderator, one main answerer, one or more reviewers, and a topic.
 *
 * The page is deliberately split into "summary" and "process":
 *   · the right side shows **summary only** — convergence score and how it was computed, opinion
 *     counts, and each role's floor / model / token usage;
 *   · the complete process (plan, every round's proposal + diff + reviews + moderator output,
 *     adjudication, final draft) lives inside collapsed sections.
 *
 * Faithfulness rules that survive from the previous design:
 *   · a participant that did not answer is shown with its raw error, never as an opinion;
 *   · a round without a diff says so, instead of implying nothing changed;
 *   · the convergence score comes from the server (derived from the reviews); the model's own
 *     number is never displayed.
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useCouncilStore } from '../stores/council';
import { useI18n } from '../i18n';
import { formatTokens } from '../lib/councilTimeline';
import CouncilRawTurns from '../components/CouncilRawTurns.vue';

const store = useCouncilStore();
const { t } = useI18n();

const form = reactive({
  topic: '',
  moderator: '',
  main: '',
  reviewers: [],
  files: '',
  maxRounds: 3,
  workspace: '',
  /** floorId -> optional --model. Empty = that CLI's own default. */
  models: {},
});
const formError = ref('');
const showAdvanced = ref(false);

onMounted(async () => {
  await store.fetchFloors();
  await store.fetchList();
  form.maxRounds = store.defaults.maxRounds || 3;
});

const floorName = (id) => {
  const f = store.floors.find((x) => x.floorId === id);
  return f ? f.name : id;
};

const readyFloors = computed(() => store.readyFloors);
const notReadyFloors = computed(() => store.floors.filter((f) => !f.ready));
/** Reviewers may be any ready floor except the two single-role seats. */
const reviewerOptions = computed(() =>
  readyFloors.value.filter((f) => f.floorId !== form.moderator && f.floorId !== form.main),
);

/** One row per occupied seat, so the user can pin a model for each floor that will actually speak. */
const selectedSeats = computed(() => {
  const ids = [...new Set([form.moderator, form.main, ...form.reviewers].filter(Boolean))];
  return ids.map((id) => store.floors.find((f) => f.floorId === id) || { floorId: id, name: id });
});

/** The same floor cannot hold two roles. Changing a single-role seat drops it from the reviewer list. */
watch([() => form.moderator, () => form.main], () => {
  form.reviewers = form.reviewers.filter((id) => id !== form.moderator && id !== form.main);
});

const files = () => form.files.split('\n').map((s) => s.trim()).filter(Boolean);

async function submit() {
  formError.value = '';
  if (!form.topic.trim()) {
    formError.value = t('council.need_topic');
    return;
  }
  if (!form.moderator) {
    formError.value = t('council.need_moderator');
    return;
  }
  if (!form.main) {
    formError.value = t('council.need_main_answerer');
    return;
  }
  if (!form.reviewers.length) {
    formError.value = t('council.need_reviewer');
    return;
  }
  if (new Set([form.moderator, form.main, ...form.reviewers]).size !== 2 + form.reviewers.length) {
    formError.value = t('council.need_distinct');
    return;
  }
  // Absolute path only: whether it exists / is a directory is the server's call, and its message is
  // shown verbatim. This check just saves a round trip.
  const ws = form.workspace.trim();
  if (ws && !/^(~\/|\/|[A-Za-z]:[\\/]|\\\\)/.test(ws)) {
    formError.value = t('council.workspace_abs');
    return;
  }
  const models = {};
  for (const seat of selectedSeats.value) {
    const model = String(form.models[seat.floorId] || '').trim();
    if (model) models[seat.floorId] = model;
  }
  const id = await store.create({
    topic: form.topic.trim(),
    moderator: form.moderator,
    main: form.main,
    reviewers: form.reviewers,
    files: files(),
    maxRounds: Number(form.maxRounds) || store.defaults.maxRounds,
    workspacePath: ws,
    models,
  });
  if (id) form.topic = '';
}

/* ---------------------------------------------------------------- result */

const council = computed(() => (store.current ? store.current.council : null));
/** Meeting-level failure text (round/phase/floor + raw CLI error). Clarification questions have their own block. */
const meetingError = computed(() => {
  if (!council.value || !council.value.error) return '';
  if (council.value.verdict === 'needs_clarification') return '';
  return council.value.error;
});
const summary = computed(() => store.summary);
const rounds = computed(() => (store.current ? store.current.roundResults : []));
const plan = computed(() => (store.current ? store.current.plan : null));
const report = computed(() => (store.current ? store.current.report : null));
const reportFiles = computed(() => (store.current ? store.current.reportFiles : []));
const clarifications = computed(() => {
  if (!plan.value || !Array.isArray(plan.value.needsClarification)) return [];
  return plan.value.needsClarification.filter(Boolean);
});

/**
 * Final-phase output. The authoritative copy is inside the persisted report (it survives a refresh);
 * the WS-only copy is used while the meeting is still wrapping up.
 */
const adjudication = computed(() => {
  if (report.value && report.value.adjudication) return report.value.adjudication;
  return (store.current && store.current.adjudication) || null;
});
const finalDraft = computed(() => {
  if (report.value && report.value.finalDraft) return report.value.finalDraft;
  return (store.current && store.current.finalDraft) || null;
});
const warnings = computed(() => {
  const fromReport = report.value && report.value.summary && report.value.summary.warnings;
  const list = Array.isArray(fromReport) ? fromReport : [];
  if (list.length) return list;
  const out = [];
  for (const r of rounds.value) for (const w of r.warnings) out.push(w);
  return out;
});

const verdictKey = (v) =>
  ['completed', 'partial', 'needs_clarification', 'cancelled', 'failed'].includes(v) ? v : 'failed';
const PARTICIPANT_STATUSES = new Set([
  'ok',
  'failed',
  'unparsed',
  'timeout',
  'needs_clarification',
  'skipped',
  'cancelled',
  'pending',
  'running',
]);
const ERROR_STATUSES = new Set(['failed', 'timeout', 'unparsed']);
const participantStatusLabel = (status) =>
  PARTICIPANT_STATUSES.has(status) ? t('council.pstatus.' + status) : status;
const participantStatusIsError = (status) => ERROR_STATUSES.has(status);
const DECISIONS = ['approve', 'approve_with_changes', 'reject'];
const decisionKey = (d) => (DECISIONS.includes(d) ? d : null);

/** The phase the meeting is currently in, derived from the latest utterance. */
const livePhase = computed(() => {
  const list = store.current ? store.current.utterances : [];
  const last = list.length ? list[list.length - 1] : null;
  return last ? last.phase : null;
});

/**
 * Who is working on what right now. A turn can take minutes and speaks only when it ends, so this
 * strip is the honest answer to "is it stuck?" between utterances. Falls back to the latest
 * utterance's phase for older payloads that carry no progress.
 */
const working = computed(() => {
  if (!store.live) return null;
  const w = store.working;
  const phase = (w && w.phase) || livePhase.value || null;
  return {
    phase,
    roundNo: w && typeof w.roundNo === 'number' ? w.roundNo : 0,
    floors: ((w && w.floors) || []).map(floorName),
  };
});

/**
 * Every recorded turn per round, including turns that failed or only half-parsed. `system` is the
 * server's brief (the topic is already on screen), so it is not repeated here.
 */
const turnsByRound = computed(() => {
  const map = new Map();
  for (const g of store.timeline) {
    map.set(
      g.roundNo,
      g.utterances.filter((u) => u.floorId !== 'system')
    );
  }
  return map;
});
const turnsOf = (roundNo) => turnsByRound.value.get(roundNo) || [];

/** Phases that only exist in a debate round (the adjudication/final round is shown elsewhere). */
const DEBATE_PHASES = new Set(['plan', 'proposal', 'review', 'moderation']);

/**
 * Rounds that have raw turns but no completed RoundResult — fail-fast, cancel, or a round whose
 * later phases never ran. They still happened and must be visible after the meeting ends.
 */
const incompleteRounds = computed(() =>
  store.timeline
    .filter((g) => !rounds.value.some((r) => r.round === g.roundNo))
    .filter((g) => !(g.roundNo === 0 && plan.value))
    .map((g) => ({ roundNo: g.roundNo, utterances: turnsOf(g.roundNo) }))
    .filter((g) => g.utterances.some((u) => DEBATE_PHASES.has(u.phase)))
);

const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];
const ROLE_ORDER = { moderator: 0, main: 1, reviewer: 2 };
const roles = computed(() =>
  [...((summary.value && summary.value.roles) || [])].sort(
    (a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9),
  ),
);

const scoreMax = computed(() => store.defaults.scoreMax || 100);

/** Explainable formula for one round, built from the server's stats (never from the model). */
function formulaFor(round) {
  if (!round || !round.stats) return '';
  const weights = store.defaults.severityWeights || {};
  const conflictWeight = store.defaults.conflictWeight != null ? store.defaults.conflictWeight : 10;
  const by = round.stats.bySeverity || {};
  const parts = SEVERITIES.map((s) => `${s} ${by[s] || 0}×${weights[s] || 0}`);
  parts.push(`${t('council.conflicts')} ${round.stats.conflicts || 0}×${conflictWeight}`);
  return `${scoreMax.value} - (${parts.join(' + ')})`;
}

const lastRound = computed(() => {
  const list = rounds.value;
  return list.length ? list[list.length - 1] : null;
});
const summaryFormula = computed(() => formulaFor(lastRound.value));

const blockerCountOf = (round) => {
  if (!round) return 0;
  if (round.stats && round.stats.bySeverity && round.stats.bySeverity.blocker != null) {
    return round.stats.bySeverity.blocker;
  }
  return round.reviews.filter((r) => r.severity === 'blocker').length;
};

const severityLabel = (s) => t(`council.severity.${s}`);
const stanceLabel = (s) => t(`council.stance.${s}`);
const roleLabel = (r) => t(`council.role.${r}`);

/** Client-side JSON download; the server's CSV/Markdown files are listed separately. */
function downloadReport() {
  if (!report.value || !council.value) return;
  const blob = new Blob([`${JSON.stringify(report.value, null, 2)}\n`], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `council-${council.value.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Deletion is irreversible, so ask first. */
function confirmRemove(id) {
  if (window.confirm(t('council.delete_confirm'))) store.remove(id);
}

/** History index timestamps always carry the date as well as the clock — "13:57" alone is ambiguous. */
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fmtBytes = (n) => (n == null ? '—' : `${n.toLocaleString()}`);

function toggleReviewer(id) {
  const at = form.reviewers.indexOf(id);
  if (at >= 0) form.reviewers.splice(at, 1);
  else form.reviewers.push(id);
}
</script>

<template>
  <div class="view">
    <!-- ------------------------------------------------------------ left column: start + history -->
    <aside class="side">
      <form class="compose" @submit.prevent="submit">
        <label class="lbl" for="cv-topic">{{ t('council.topic') }}</label>
        <textarea
          id="cv-topic"
          v-model="form.topic"
          class="ta"
          rows="3"
          :placeholder="t('council.topic_ph')"
        />

        <p v-if="!store.canStart" class="why bad" data-testid="cv-no-floors">{{ t('council.empty_floors') }}</p>

        <p class="lbl">{{ t('council.roles') }}</p>

        <div class="role-row">
          <label class="role-lbl" for="cv-moderator">{{ t('council.role.moderator') }}</label>
          <select
            id="cv-moderator"
            v-model="form.moderator"
            class="sel"
            data-testid="cv-moderator"
            :disabled="!readyFloors.length"
          >
            <option value="">{{ t('council.role.please_select') }}</option>
            <option
              v-for="f in readyFloors"
              :key="f.floorId"
              :value="f.floorId"
              :disabled="f.floorId === form.main"
            >
              {{ f.floorId }} · {{ f.name }}
            </option>
          </select>
        </div>

        <div class="role-row">
          <label class="role-lbl" for="cv-main">{{ t('council.role.main') }}</label>
          <select
            id="cv-main"
            v-model="form.main"
            class="sel"
            data-testid="cv-main"
            :disabled="!readyFloors.length"
          >
            <option value="">{{ t('council.role.please_select') }}</option>
            <option
              v-for="f in readyFloors"
              :key="f.floorId"
              :value="f.floorId"
              :disabled="f.floorId === form.moderator"
            >
              {{ f.floorId }} · {{ f.name }}
            </option>
          </select>
        </div>

        <div class="role-row">
          <span class="role-lbl">{{ t('council.role.reviewer') }}</span>
          <ul class="plist" data-testid="cv-reviewers">
            <li v-for="f in reviewerOptions" :key="f.floorId">
              <label>
                <input
                  type="checkbox"
                  :value="f.floorId"
                  :checked="form.reviewers.includes(f.floorId)"
                  @change="toggleReviewer(f.floorId)"
                />
                <span class="fid">{{ f.floorId }}</span>
                <span class="fname">{{ f.name }}</span>
              </label>
            </li>
            <li v-if="!reviewerOptions.length" class="hint">{{ t('council.role.no_reviewers') }}</li>
          </ul>
          <p class="hint">{{ t('council.role.reviewer_hint') }}</p>
        </div>

        <ul v-if="notReadyFloors.length" class="floors">
          <li v-for="f in notReadyFloors" :key="f.floorId" class="off">
            <span class="fid">{{ f.floorId }}</span>
            <span class="fname">{{ f.name }}</span>
            <span class="why">{{ t('council.floor_not_ready') }}</span>
            <p class="why dim">{{ f.reason }}</p>
          </li>
        </ul>

        <div class="accordion" :class="{ open: showAdvanced }">
          <button
            type="button"
            class="accordion-hd"
            @click="showAdvanced = !showAdvanced"
            :aria-expanded="showAdvanced"
            data-testid="cv-advanced-toggle"
          >
            <span>{{ t('council.advanced') }}</span>
            <span class="caret" aria-hidden="true">▸</span>
          </button>
          <div class="accordion-bd">
            <label class="lbl" for="cv-files">{{ t('council.files') }}</label>
            <textarea
              id="cv-files"
              v-model="form.files"
              class="ta mono"
              rows="2"
              :placeholder="t('council.files_ph')"
            />
            <p class="hint">
              {{ t('council.files_hint', { kb: Math.round((store.defaults.materialMaxBytes || 0) / 1024) }) }}
            </p>

            <label class="lbl" for="cv-workspace">{{ t('council.workspace') }}</label>
            <input
              id="cv-workspace"
              v-model="form.workspace"
              class="ta mono"
              type="text"
              data-testid="cv-workspace"
              :placeholder="t('council.workspace_ph')"
            />
            <p class="hint">{{ t('council.workspace_hint') }}</p>
            <p v-if="form.workspace.trim()" class="hint">
              {{ t('council.workspace_timeout', { min: Math.round((store.defaults.workspaceTurnTimeoutMs || 0) / 60000) }) }}
            </p>

            <template v-if="selectedSeats.length">
              <p class="lbl">{{ t('council.models') }}</p>
              <div v-for="seat in selectedSeats" :key="seat.floorId" class="row">
                <span class="role-lbl">{{ seat.floorId }} · {{ seat.name }}</span>
                <input
                  v-model="form.models[seat.floorId]"
                  class="ta mono model-input"
                  type="text"
                  :data-testid="`cv-model-${seat.floorId}`"
                  :placeholder="t('council.model_ph')"
                />
              </div>
              <p class="hint">{{ t('council.models_hint') }}</p>
            </template>

            <div class="row">
              <label class="lbl inline" for="cv-rounds">{{ t('council.rounds') }}</label>
              <input
                id="cv-rounds"
                v-model.number="form.maxRounds"
                class="num"
                type="number"
                min="1"
                :max="store.defaults.maxRoundsLimit || 8"
              />
            </div>
            <p class="hint">{{ t('council.rounds_note') }}</p>
          </div>
        </div>

        <p v-if="formError" class="why bad" data-testid="cv-form-error">{{ formError }}</p>

        <button class="primary" type="submit" :disabled="store.submitting || !store.canStart">
          {{ store.submitting ? t('council.starting') : t('council.start') }}
        </button>
      </form>

      <div class="history">
        <h3 class="h3">{{ t('council.history') }}</h3>
        <p v-if="!store.list.length" class="hint">{{ t('council.no_history') }}</p>
        <ul>
          <li
            v-for="c in store.list"
            :key="c.id"
            :class="{ on: council && council.id === c.id }"
            @click="store.open(c.id)"
          >
            <span class="ctime">{{ fmtTime(c.created_at) }}</span>
            <span class="topic">{{ c.topic }}</span>
          </li>
        </ul>
      </div>
    </aside>

    <!-- ------------------------------------------------------------ right column: summary + collapsed process -->
    <section class="main">
      <div v-if="store.submitting" class="working" data-testid="cv-preflight" role="status" aria-live="polite">
        <span class="pulse" aria-hidden="true"></span>
        <strong class="working-hd">{{ t('council.preflight_running') }}</strong>
      </div>

      <template v-if="!store.current">
        <p v-if="!store.error && !store.submitting" class="empty">{{ t('council.pick_one') }}</p>
        <section v-else-if="store.error" class="card alert" data-testid="cv-op-error">
          <p class="alert-text">{{ store.error }}</p>
        </section>
      </template>

      <template v-else>
        <header class="head">
          <!-- A running meeting is already described by the work strip below; repeating the state
               here adds nothing. The verdict badge stays for a finished meeting, where it is the
               only summary of how the meeting ended. -->
          <div v-if="council.verdict" class="who">
            <span class="badge" :class="'v-' + verdictKey(council.verdict)">
              {{ t('council.verdict.' + verdictKey(council.verdict)) }}
            </span>
          </div>
          <h2 class="topic-h">{{ council.topic }}</h2>
          <p v-if="store.workspacePath" class="ws mono" data-testid="cv-workspace-show">
            {{ t('council.workspace_line') }}<span class="ws-path">{{ store.workspacePath }}</span>
          </p>
          <div class="acts">
            <button v-if="store.live" class="ghost" @click="store.cancel(council.id)">{{ t('council.cancel') }}</button>
            <button v-else class="ghost danger" @click="confirmRemove(council.id)">{{ t('council.delete') }}</button>
            <button v-if="report" class="ghost" data-testid="cv-download" @click="downloadReport">
              {{ t('council.download_json') }}
            </button>
          </div>
        </header>

        <section v-if="meetingError" class="card alert" data-testid="cv-council-error">
          <p class="alert-text">{{ meetingError }}</p>
        </section>

        <!-- ------------------------------------------------- live work strip -->
        <div v-if="working" class="working" data-testid="cv-working" role="status" aria-live="polite">
          <span class="pulse" aria-hidden="true"></span>
          <strong class="working-hd">{{ t('council.working_now') }}</strong>
          <template v-if="working.floors.length">
            <span class="sep">·</span>
            <span class="working-floors">{{ working.floors.join('、') }}</span>
          </template>
          <template v-if="working.phase">
            <span class="sep">·</span>
            <span>{{ t('council.phase.' + working.phase) }}</span>
          </template>
          <span class="sep">·</span>
          <span class="dim">{{ t('council.round_n', { n: working.roundNo }) }}</span>
        </div>

        <section v-if="store.error" class="card alert" data-testid="cv-op-error">
          <p class="alert-text">{{ store.error }}</p>
        </section>

        <!-- ------------------------------------------------ summary card -->
        <section class="card summary" data-testid="cv-summary">
          <div class="scoreline">
            <div class="score-num" data-testid="cv-score">
              {{ summary && summary.score != null ? summary.score : '—' }}
              <span class="score-max">/ {{ scoreMax }}</span>
            </div>
            <div class="score-meta">
              <span class="k">{{ t('council.convergence') }}</span>
              <span v-if="summaryFormula" class="mono formula" data-testid="cv-score-formula">{{ summaryFormula }}</span>
              <span class="hint">{{ t('council.score_formula_note') }}</span>
              <span class="hint">{{ t('council.rounds_done', { n: summary ? summary.rounds : 0 }) }}</span>
            </div>
          </div>

          <div class="chips">
            <span class="chip" data-testid="cv-review-count">
              {{ t('council.reviews_n', { n: summary ? summary.reviewCount : 0 }) }}
            </span>
            <span class="chip sev-blocker" data-testid="cv-blocker-count">
              {{ t('council.blockers_n', { n: summary ? summary.severityCounts.blocker : 0 }) }}
            </span>
            <span class="chip" data-testid="cv-conflict-count">
              {{ t('council.conflicts_n', { n: summary ? summary.conflictCount : 0 }) }}
            </span>
            <span
              v-for="s in SEVERITIES"
              :key="s"
              class="chip sm dim"
              :data-testid="'cv-sev-' + s"
            >{{ severityLabel(s) }} {{ summary ? summary.severityCounts[s] : 0 }}</span>
          </div>

          <div v-if="clarifications.length" class="clarify" data-testid="cv-clarification">
            <h4 class="wh">{{ t('council.needs_clarification') }}</h4>
            <ul>
              <li v-for="(question, i) in clarifications" :key="i">{{ question }}</li>
            </ul>
          </div>

          <table class="roles" data-testid="cv-roles">
            <thead>
              <tr>
                <th>{{ t('council.col.role') }}</th>
                <th>{{ t('council.col.floor') }}</th>
                <th>{{ t('council.col.model') }}</th>
                <th>{{ t('council.col.tokens') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in roles" :key="r.floorId" :data-testid="'cv-role-' + r.role">
                <td><span class="role" :class="'role-' + r.role">{{ roleLabel(r.role) }}</span></td>
                <td>
                  <span class="fid">{{ r.floorId }}</span>
                  <span class="fname">{{ floorName(r.floorId) }}</span>
                  <span
                    v-if="r.status && r.status !== 'ok'"
                    class="pstatus"
                    :class="{ bad: participantStatusIsError(r.status) }"
                    :title="r.error || ''"
                  >
                    {{ participantStatusLabel(r.status) }}
                  </span>
                </td>
                <td class="mono">{{ r.model || '—' }}</td>
                <td class="mono">{{ formatTokens(r.tokens) }}</td>
              </tr>
            </tbody>
          </table>

          <div v-if="warnings.length" class="warn" data-testid="cv-warnings">
            <h4 class="wh">{{ t('council.warnings') }}</h4>
            <p class="hint">{{ t('council.warnings_hint') }}</p>
            <ul>
              <li v-for="(w, i) in warnings" :key="i">{{ w.message }}</li>
            </ul>
          </div>
        </section>

        <!-- ------------------------------------------------ final result -->
        <section v-if="adjudication || finalDraft" class="card result" data-testid="cv-result">
          <h3 class="h3">{{ t('council.adjudication') }}</h3>
          <template v-if="adjudication">
            <p class="decision-line">
              <span
                v-if="decisionKey(adjudication.decision)"
                class="badge"
                :class="'d-' + decisionKey(adjudication.decision)"
                data-testid="cv-decision"
              >{{ t('council.decision.' + decisionKey(adjudication.decision)) }}</span>
              <span v-else class="dim">{{ adjudication.decision || '—' }}</span>
            </p>
            <p v-if="adjudication.summary" class="para">
              <span class="k">{{ t('council.adjudication_reason') }}</span>{{ adjudication.summary }}
            </p>
            <div v-if="adjudication.remainingRisks && adjudication.remainingRisks.length" class="block">
              <h4 class="bh">{{ t('council.remaining_risks') }}</h4>
              <ul class="list">
                <li v-for="(x, i) in adjudication.remainingRisks" :key="i">{{ x }}</li>
              </ul>
            </div>
            <div v-if="adjudication.finalDirectives && adjudication.finalDirectives.length" class="block">
              <h4 class="bh">{{ t('council.final_directives') }}</h4>
              <ul class="list">
                <li v-for="(x, i) in adjudication.finalDirectives" :key="i">{{ x }}</li>
              </ul>
            </div>
          </template>
          <p v-else class="why dim">{{ t('council.adjudication_unparsed') }}</p>

          <template v-if="finalDraft">
            <h3 class="h3 gap-top">{{ t('council.final_draft') }}</h3>
            <pre class="body" data-testid="cv-final-draft">{{ finalDraft.content }}</pre>
            <p v-if="finalDraft.changeNotes" class="sub">
              <span class="k">{{ t('council.change_notes') }}</span>{{ finalDraft.changeNotes }}
            </p>
          </template>
        </section>

        <!-- ------------------------------------------------ exported files -->
        <section v-if="reportFiles.length" class="card export" data-testid="cv-report-files">
          <h3 class="h3">{{ t('council.report_files') }}</h3>
          <p class="hint">{{ t('council.report_files_hint') }}</p>
          <ul class="files">
            <li v-for="f in reportFiles" :key="f" class="mono">{{ f }}</li>
          </ul>
        </section>

        <!-- ------------------------------------------------ complete process (collapsed) -->
        <details v-if="plan || rounds.length || incompleteRounds.length" class="process" data-testid="cv-process">
          <summary class="process-hd">
            {{ t('council.process') }}
            <span class="dim">（{{ t('council.rounds_done', { n: summary ? summary.rounds : 0 }) }}）</span>
          </summary>
          <p class="hint">{{ t('council.process_hint') }}</p>

          <details v-if="plan" class="round" data-testid="cv-plan">
            <summary class="round-hd">
              <span class="rno">{{ t('council.round0_plan') }}</span>
            </summary>
            <div class="rbody">
              <p v-if="!plan.parsed" class="why dim">{{ t('council.plan_unparsed') }}</p>
              <div v-if="plan.breakdown && plan.breakdown.length" class="block">
                <h4 class="bh">{{ t('council.breakdown') }}</h4>
                <ul class="list">
                  <li v-for="(x, i) in plan.breakdown" :key="i">{{ x }}</li>
                </ul>
              </div>
              <div v-if="plan.assignments && plan.assignments.length" class="block">
                <h4 class="bh">{{ t('council.assignments') }}</h4>
                <ul class="list">
                  <li v-for="(a, i) in plan.assignments" :key="i">
                    <span class="fid">{{ a.reviewer }}</span>
                    <span class="fname">{{ floorName(a.reviewer) }}</span>
                    <span v-if="a.focus" class="dim"> — {{ a.focus }}</span>
                  </li>
                </ul>
              </div>
              <p v-if="plan.reviewFocus" class="para dim">{{ plan.reviewFocus }}</p>
              <div class="block">
                <h4 class="bh">{{ t('council.raw_output') }}</h4>
                <CouncilRawTurns :utterances="turnsOf(0)" />
              </div>
            </div>
          </details>

          <details v-for="r in rounds" :key="r.round" class="round" :data-testid="'cv-round-' + r.round">
            <summary class="round-hd">
              <span class="rno">{{ t('council.round_n', { n: r.round }) }}</span>
              <span v-if="r.proposal.version" class="rver mono">{{ r.proposal.version }}</span>
              <span v-if="r.stats" class="chip sm">{{ t('council.score_short', { n: r.stats.score }) }}</span>
              <span class="dim counts">
                {{ t('council.reviews_n', { n: r.reviews.length }) }} · {{ t('council.blockers_n', { n: blockerCountOf(r) }) }}
              </span>
            </summary>

            <div class="rbody">
              <div class="block">
                <h4 class="bh">{{ t('council.diff') }}</h4>
                <pre v-if="r.proposal.diffFromPrev" class="diff" :data-testid="'cv-diff-' + r.round">{{ r.proposal.diffFromPrev }}</pre>
                <p v-else class="why dim" :data-testid="'cv-nodiff-' + r.round">{{ t('council.no_diff') }}</p>
              </div>

              <div class="block">
                <h4 class="bh">{{ t('council.proposal') }}</h4>
                <pre class="body">{{ r.proposal.content }}</pre>
              </div>

              <div class="block">
                <h4 class="bh">{{ t('council.reviews') }}</h4>
                <p v-if="!r.reviews.length" class="why dim">{{ t('council.no_reviews') }}</p>
                <article v-for="(rv, i) in r.reviews" :key="i" class="review">
                  <div class="rline">
                    <span class="sev" :class="'sev-' + rv.severity">{{ severityLabel(rv.severity) }}</span>
                    <span class="fid">{{ rv.reviewer }}</span>
                    <span class="fname">{{ floorName(rv.reviewer) }}</span>
                    <span class="dim">· {{ rv.dimension }}</span>
                    <span class="spacer" />
                    <span class="stance" :class="'st-' + rv.stance">{{ stanceLabel(rv.stance) }}</span>
                  </div>
                  <p class="para">{{ rv.issue }}</p>
                  <p v-if="rv.evidence" class="sub"><span class="k">{{ t('council.evidence') }}</span>{{ rv.evidence }}</p>
                  <p v-if="rv.suggestion" class="sub"><span class="k">{{ t('council.suggestion') }}</span>{{ rv.suggestion }}</p>
                </article>
              </div>

              <div class="block">
                <h4 class="bh">
                  {{ t('council.moderator_summary') }}
                  <span v-if="r.stats" class="chip sm">{{ t('council.score_short', { n: r.stats.score }) }}</span>
                </h4>
                <p v-if="formulaFor(r)" class="mono hint">{{ formulaFor(r) }}</p>
                <div class="msec">
                  <span class="mk">{{ t('council.consensus_items') }}</span>
                  <ul v-if="r.moderator.consensus.length" class="list">
                    <li v-for="(x, i) in r.moderator.consensus" :key="i">{{ x }}</li>
                  </ul>
                  <span v-else class="dim">{{ t('council.none') }}</span>
                </div>
                <div class="msec">
                  <span class="mk">{{ t('council.open_issues') }}</span>
                  <ul v-if="r.moderator.openIssues.length" class="list">
                    <li v-for="(x, i) in r.moderator.openIssues" :key="i">{{ x }}</li>
                  </ul>
                  <span v-else class="dim">{{ t('council.none') }}</span>
                </div>
                <div v-if="r.moderator.conflicts.length" class="msec">
                  <span class="mk">{{ t('council.conflicts') }}</span>
                  <ul class="list">
                    <li v-for="(c, i) in r.moderator.conflicts" :key="i">
                      <strong>{{ c.topic }}</strong>
                      <span v-for="(s, j) in c.sides" :key="j" class="side">
                        <span class="fid">{{ s.reviewer }}</span>{{ s.view }}
                      </span>
                    </li>
                  </ul>
                </div>
                <div class="msec">
                  <span class="mk">{{ t('council.directives') }}</span>
                  <ul v-if="r.moderator.revisionDirectives.length" class="list directives">
                    <li v-for="(x, i) in r.moderator.revisionDirectives" :key="i">{{ x }}</li>
                  </ul>
                  <span v-else class="dim">{{ t('council.none') }}</span>
                </div>
                <ul v-if="r.warnings.length" class="list round-warn">
                  <li v-for="(w, i) in r.warnings" :key="i" class="bad">{{ w.message }}</li>
                </ul>
              </div>

              <div class="block">
                <h4 class="bh">{{ t('council.raw_output') }}</h4>
                <CouncilRawTurns :utterances="turnsOf(r.round)" />
              </div>
            </div>
          </details>

          <details
            v-for="g in incompleteRounds"
            :key="'incomplete-' + g.roundNo"
            class="round"
            open
            :data-testid="'cv-round-incomplete-' + g.roundNo"
          >
            <summary class="round-hd">
              <span class="rno">{{ t('council.round_n', { n: g.roundNo }) }}</span>
              <span class="bad">{{ t('council.round_incomplete') }}</span>
            </summary>
            <div class="rbody">
              <p class="why dim">{{ t('council.round_incomplete_hint') }}</p>
              <div class="block">
                <h4 class="bh">{{ t('council.raw_output') }}</h4>
                <CouncilRawTurns :utterances="g.utterances" />
              </div>
            </div>
          </details>
        </details>

        <!-- materials -->
        <div v-if="store.current.materials.length" class="card">
          <h3 class="h3">{{ t('council.materials') }}</h3>
          <ul class="mlist">
            <li v-for="m in store.current.materials" :key="m.ord">
              <span class="mono path">{{ m.path }}</span>
              <span v-if="m.truncated" class="bad">
                {{ t('council.material_truncated', { total: fmtBytes(m.bytes_total), included: fmtBytes(m.bytes_included) }) }}
              </span>
              <span v-else class="dim">{{ t('council.material_full', { n: fmtBytes(m.bytes_included) }) }}</span>
            </li>
          </ul>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.view {
  display: grid;
  grid-template-columns: minmax(280px, 340px) 1fr;
  gap: var(--gap);
  height: 100%;
  min-height: 0;
}

/* ------------------------------------------------------------ left column */
.side {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
  min-height: 0;
  overflow: auto;
}

.compose,
.history {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
}

.h3 { font-size: 13px; margin: 0 0 8px; color: var(--text-dim); }
.h3.gap-top { margin-top: 14px; }
.lbl { display: block; font-size: 12px; color: var(--text-dim); margin: 10px 0 4px; }
.lbl.inline { margin: 0; }
.hint { font-size: 11px; color: var(--text-faint); margin: 6px 0 0; line-height: 1.5; }

.ta {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-elevated);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 8px;
  font: inherit;
  font-size: 12px;
  resize: vertical;
}
.ta.mono { font-family: var(--mono); font-size: 11px; }

.sel {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-elevated);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 6px 8px;
  font: inherit;
  font-size: 12px;
}
input.ta { padding: 6px 8px; }

.floors { list-style: none; margin: 0; padding: 0; }
.floors li { margin: 3px 0; }
.floors label { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
.floors li.off label { cursor: not-allowed; color: var(--text-faint); }
.fid {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--lcd-lit);
  min-width: 22px;
}
.fname { color: var(--text); }
.why { font-size: 11px; margin: 2px 0 0 22px; }
.why.bad { color: var(--state-blocked); }

/* ---- role assignment ---- */
.role-row { margin-top: 8px; }
.role-lbl {
  display: block;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 4px;
}
.role-row .plist {
  list-style: none;
  margin: 0;
  padding: 0;
}
.role-row .plist li { margin: 3px 0; }
.role-row .plist label { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }

/* ---- accordion collapse ---- */
.accordion {
  margin-top: 12px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-elevated);
}
.accordion-hd {
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.accordion-hd:hover { color: var(--text); }
.accordion .caret {
  font-size: 10px;
  transition: transform 0.2s ease;
}
.accordion.open .caret { transform: rotate(90deg); }
.accordion-bd {
  padding: 0 10px 10px;
  display: none;
}
.accordion.open .accordion-bd { display: block; }

.row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.row .role-lbl { margin-bottom: 0; white-space: nowrap; }
.model-input { flex: 1; min-width: 0; }
.num {
  width: 56px;
  background: var(--bg-elevated);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 3px 6px;
  font: inherit;
  font-size: 12px;
}

button.primary {
  width: 100%;
  margin-top: 12px;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--accent);
  background: var(--accent-soft);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
button.primary:disabled { opacity: 0.45; cursor: not-allowed; }

.history ul { list-style: none; margin: 0; padding: 0; }
.history li {
  display: flex;
  gap: 6px;
  align-items: baseline;
  padding: 5px 6px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.history li:hover { background: var(--bg-elevated); }
.history li.on { background: var(--accent-soft); }
.history .ctime {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
  flex-shrink: 0;
  min-width: 80px;
}
.history .topic {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ------------------------------------------------------------ right column */
.main {
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.empty { color: var(--text-faint); font-size: 13px; margin: 20px; }

.head { display: flex; flex-direction: column; gap: 6px; }
.who { display: flex; align-items: center; gap: 8px; }

.topic-h { font-size: 15px; margin: 0; line-height: 1.4; }

/* Live work strip: a long turn says nothing until it ends, so this is the only visible sign it is
   still moving. Deliberately plain — it reports who/phase/round, not a fake percentage. */
.working {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 12px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--state-busy) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--state-busy) 30%, transparent);
  border-radius: 8px;
}
.working-hd { color: var(--state-busy); font-weight: 600; }
.working .sep { color: var(--text-faint); }
.pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--state-busy);
  flex: none;
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.7); }
}
@media (prefers-reduced-motion: reduce) {
  .pulse { animation: none; }
}
.acts { display: flex; gap: 8px; }
.ws { font-size: 11px; color: var(--text-faint); margin: 0; word-break: break-all; }
.ws-path { color: var(--text-dim); margin-left: 4px; }

button.ghost {
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
button.ghost:hover { color: var(--text); border-color: var(--accent); }
button.ghost.danger:hover { color: var(--state-blocked); border-color: var(--state-blocked); }

.badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;
  border: 1px solid var(--border-strong);
  white-space: nowrap;
}
.v-completed { color: var(--state-success); border-color: var(--state-success); }
.v-partial { color: var(--state-busy); border-color: var(--state-busy); }
.v-needs_clarification,
.v-cancelled,
.v-failed { color: var(--text-dim); }

.card {
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 10px 12px;
  background: var(--bg-panel);
}
.card.result { border-color: var(--border-strong); }
/* Server/preflight failures belong in the right column, where the meeting lives; the left column is
   the form. `pre-wrap` is required: provider errors keep their own line breaks. */
.card.alert {
  border-color: var(--state-blocked);
  background: color-mix(in srgb, var(--state-blocked) 6%, var(--bg-panel));
}
.alert-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--state-blocked);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---- summary ---- */
.scoreline { display: flex; align-items: baseline; gap: 14px; }
.score-num {
  font-family: var(--mono);
  font-size: 34px;
  line-height: 1;
  color: var(--text);
  white-space: nowrap;
}
.score-max { font-size: 13px; color: var(--text-faint); }
.score-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.score-meta .k { font-size: 12px; color: var(--text-dim); }
.formula { font-size: 11px; color: var(--text-faint); word-break: break-word; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.chip {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  white-space: nowrap;
}
.chip.sm { font-size: 10px; padding: 0 6px; }
.chip.sev-blocker { color: var(--state-blocked); border-color: var(--state-blocked); }

.clarify { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 8px; }
.clarify .wh { font-size: 12px; margin: 0 0 4px; color: var(--text-dim); }
.clarify ul { margin: 4px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.55; }

.roles { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 12px; }
.roles th {
  text-align: left;
  font-weight: 400;
  font-size: 11px;
  color: var(--text-faint);
  padding: 0 8px 4px 0;
}
.roles td { padding: 4px 8px 4px 0; vertical-align: baseline; }
.roles .role { font-size: 11px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--border-strong); }
.roles .role-moderator { color: var(--accent); border-color: var(--accent); }
.roles .role-main { color: var(--state-success); border-color: var(--state-success); }
.roles .pstatus { font-size: 11px; margin-left: 6px; color: var(--text-dim); }
.roles .pstatus.bad { color: var(--state-blocked); }

.warn { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 8px; }
.warn .wh { font-size: 12px; margin: 0 0 4px; color: var(--text-dim); }
.warn ul { margin: 4px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.5; color: var(--state-busy); }

/* ---- final result ---- */
.decision-line { margin: 0 0 6px; }
.d-approve { color: var(--state-success); border-color: var(--state-success); }
.d-approve_with_changes { color: var(--state-busy); border-color: var(--state-busy); }
.d-reject { color: var(--state-blocked); border-color: var(--state-blocked); }
.para { margin: 4px 0 0; font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
.para .k { color: var(--text-faint); margin-right: 6px; }
.block { margin-top: 10px; }
.bh { font-size: 12px; margin: 0 0 4px; color: var(--text-dim); display: flex; align-items: center; gap: 8px; }
.list { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.6; }
.list li { margin: 2px 0; }
.list.directives { color: var(--text); }

.body {
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font: inherit;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
  max-height: 360px;
  overflow: auto;
  background: var(--bg-elevated);
  border-radius: 8px;
  padding: 8px 10px;
}
.diff {
  margin: 4px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.6;
  color: var(--text);
  background: var(--bg-elevated);
  border-left: 3px solid var(--accent);
  border-radius: 0 8px 8px 0;
  padding: 8px 10px;
  max-height: 280px;
  overflow: auto;
}
.sub { margin: 4px 0 0; font-size: 12px; color: var(--text-dim); line-height: 1.5; white-space: pre-wrap; }
.sub .k { color: var(--text-faint); margin-right: 6px; }

/* ---- exported files ---- */
.files { list-style: none; margin: 6px 0 0; padding: 0; }
.files li { font-size: 11px; word-break: break-all; margin: 2px 0; color: var(--text-dim); }

/* ---- complete process (collapsed) ---- */
.process {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel);
  padding: 8px 12px;
}
.process-hd {
  cursor: pointer;
  font-size: 13px;
  color: var(--text-dim);
  list-style: none;
  user-select: none;
}
.process-hd::-webkit-details-marker { display: none; }
.process-hd::before { content: '▸ '; color: var(--text-faint); }
.process[open] > .process-hd::before { content: '▾ '; }
.process > .hint { margin: 6px 0 8px; }

.round {
  margin-top: 8px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg-elevated);
  padding: 6px 10px;
}
.round-hd {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  list-style: none;
  user-select: none;
}
.round-hd::-webkit-details-marker { display: none; }
.round-hd::before { content: '▸'; font-size: 10px; color: var(--text-faint); }
.round[open] > .round-hd::before { content: '▾'; }
.rno { color: var(--text); font-weight: 600; }
.rver { color: var(--text-faint); font-size: 11px; }
.counts { font-size: 11px; color: var(--text-faint); }
.rbody { padding: 4px 0 8px 14px; }

.review { border-top: 1px solid var(--border); padding: 6px 0; }
.review:first-of-type { border-top: none; }
.rline { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.spacer { flex: 1; }
.sev,
.stance {
  font-size: 10px;
  padding: 0 6px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  white-space: nowrap;
}
.sev-blocker { color: var(--state-blocked); border-color: var(--state-blocked); }
.sev-major { color: var(--state-busy); border-color: var(--state-busy); }
.sev-minor { color: var(--text-dim); }
.sev-nit { color: var(--text-faint); }
.st-reject { color: var(--state-blocked); border-color: var(--state-blocked); }
.st-revise { color: var(--state-busy); border-color: var(--state-busy); }
.st-accept { color: var(--state-success); border-color: var(--state-success); }

.msec { display: flex; gap: 8px; margin-top: 6px; font-size: 12px; }
.mk { color: var(--text-faint); flex: 0 0 68px; }
.side { display: block; color: var(--text-dim); }
.side .fid { margin-right: 4px; }
.round-warn { margin-top: 8px; }

/* ---- materials ---- */
.mlist { list-style: none; margin: 0; padding: 0; }
.mlist li { display: flex; gap: 8px; align-items: baseline; font-size: 12px; margin: 3px 0; }
.mlist .path { font-size: 11px; word-break: break-all; }
.dim { color: var(--text-faint); }
.bad { color: var(--state-blocked); }
.mono { font-family: var(--mono); }
</style>
