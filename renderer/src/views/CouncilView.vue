<script setup>
/**
 * Council: pick a few floors of agents, hold a meeting on one topic, and see whether they reach agreement.
 *
 * This page's job is to **present faithfully**, not to hand over a nice-looking conclusion. So:
 *   · Whoever did not answer is written as "no stance", with the raw error in red —— not painted as a position;
 *   · Vote tallies are shown in two parts: the one the server determined (evidence) + the one counted from the utterances (cross-check),
 *     so a mismatch between the two is obvious at a glance;
 *   · When material was truncated, the material list says how many bytes the original had and how many were included;
 *   · When there is no consensus, plainly write "no consensus" and list each side's final position, without synthesizing a "conclusion".
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useCouncilStore } from '../stores/council';
import { useI18n } from '../i18n';
import { voteKey, stanceKey, tokenTotal } from '../lib/councilTimeline';

const store = useCouncilStore();
const { t } = useI18n();

/**
 * Role assignment: one chair and one main answerer, participants can be multi-selected.
 * Backward compatible: on submit, merge the floors of the three roles into a floors array and send it to the server;
 * the server does not distinguish roles for now (until the orchestrator is changed later).
 */
const form = reactive({
  topic: '',
  chair: '',
  mainAnswerer: '',
  participants: [],
  files: '',
  maxRounds: 3,
  mode: 'vote',
  workspace: '',
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
/** Participant options: the available floors other than the chair and main answerer */
const participantOptions = computed(() =>
  readyFloors.value.filter((f) => f.floorId !== form.chair && f.floorId !== form.mainAnswerer),
);
/** Floors that cannot be summoned (plugin installed but CLI missing, etc.); list them and state the reason */
const notReadyFloors = computed(() => store.floors.filter((f) => !f.ready));

const files = () => form.files.split('\n').map((s) => s.trim()).filter(Boolean);

async function submit() {
  formError.value = '';
  if (!form.topic.trim()) {
    formError.value = t('council.need_topic');
    return;
  }
  if (!form.chair) {
    formError.value = t('council.need_chair');
    return;
  }
  if (!form.mainAnswerer) {
    formError.value = t('council.need_main_answerer');
    return;
  }
  const floors = [...new Set([form.chair, form.mainAnswerer, ...form.participants].filter(Boolean))];
  if (floors.length < 2) {
    formError.value = t('council.need_two_floors');
    return;
  }
  // The frontend only blocks on one thing for the workspace: **an absolute path is required**. Whether it exists or is a directory is left to the server ——
  // it validates at the moment of start, which is more accurate than the frontend guessing, and its message is shown to the user verbatim.
  // The frontend checks this one rule only to "save the user a round trip", not to make the judgment for them.
  const ws = form.workspace.trim();
  if (ws && !/^(~\/|\/|[A-Za-z]:[\\/]|\\\\)/.test(ws)) {
    formError.value = t('council.workspace_abs');
    return;
  }
  const id = await store.create({
    topic: form.topic.trim(),
    floors,
    files: files(),
    maxRounds: Number(form.maxRounds) || store.defaults.maxRounds,
    mode: form.mode,
    workspacePath: ws,
  });
  if (id) form.topic = '';
}

/* ---------------------------------------------------------------- result */

const council = computed(() => (store.current ? store.current.council : null));

/** The round where consensus was reached —— the conclusion is the proposal text on its table, shown as-is, not rewritten by the frontend */
const consensusRound = computed(() => {
  if (!store.current) return null;
  return store.current.rounds.find((r) => r.consensus === 1) || null;
});

/** The vote tally determined by the server (indexed by round), coexisting with the one counted from utterances */
const serverTally = (roundNo) => (store.current ? store.current.rounds.find((r) => r.round_no === roundNo) : null) || null;

const lastDebate = computed(() => {
  const rounds = store.timeline.filter((g) => g.roundNo > 0);
  return rounds.length ? rounds[rounds.length - 1] : null;
});

const statusKey = (s) => (['draft', 'running', 'done', 'failed', 'cancelled'].includes(s) ? s : 'done');
const verdictKey = (v) =>
  ['consensus', 'no_consensus', 'reported', 'cancelled', 'failed'].includes(v) ? v : 'failed';

/**
 * Analysis-mode report grouping —— **the server does not synthesize a conclusion, and neither do we**.
 * It does one thing only: place each person's final judgment from the last round together by stance, listing `points` / `risks` / `questions`
 * as-is. The order is fixed at four levels (support → oppose → unsure → none); empty groups are not rendered.
 *
 * Why the **last round** is authoritative: the prompt explicitly says the last round must give the final judgment, while the middle rounds are process ——
 * stacking every round's stance on top of each other makes it harder for the reader to see where they finally stand. The process is in the timeline below,
 * nothing is lost.
 */
const STANCE_ORDER = ['support', 'oppose', 'unsure', 'none'];
const report = computed(() => {
  if (!lastDebate.value) return [];
  const seats = lastDebate.value.utterances.filter((u) => u.role !== 'chair');
  return STANCE_ORDER.map((key) => ({
    key,
    items: seats.filter((u) => stanceKey(u.stance) === key),
  })).filter((g) => g.items.length);
});

/** Stance counts in the report (counted from utterances). chair does not take a seat, consistent with the vote definition */
const stanceTally = computed(() => (lastDebate.value ? lastDebate.value.stanceTally : null));

/**
 * An utterance's key points → grouped in pairs of "heading key + that column's entries"; empty columns do not appear.
 * When findings is null (unparsed), returns an empty array —— that is a different statement (findings_unparsed);
 * the caller branches on `!u.findings` and does not rely on this empty array to tell them apart.
 */
const findingRows = (u) => {
  const f = u && u.findings;
  if (!f) return [];
  return [
    ['council.points', f.points],
    ['council.risks', f.risks],
    ['council.questions', f.questions],
  ]
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([k, v]) => ({ k, v }));
};

/* ------------------------------------------------------- whose utterance to view in a round */

/**
 * A round may have several floors each saying a long passage; spreading them all out is screen after screen of text, and "who said what" becomes impossible to find.
 * So a round **expands only one person at a time**, with a row of dots above to pick who —— what is collapsed is the body text, not the facts:
 * the vote tally (vote mode) and "could not speak this round" stay on that row; nothing is allowed to be folded away.
 *
 * The key is the round number, the value is the floor. If nothing was picked, or the picked floor is gone in this round → fall back to the first in the round,
 * **never leave it empty**: showing no one in a round looks like no one spoke in it.
 */
const picked = reactive({});
const shownId = (g) => {
  const want = picked[g.roundNo];
  return g.utterances.some((u) => u.floorId === want) ? want : g.utterances[0] && g.utterances[0].floorId;
};
const shown = (g) => g.utterances.filter((u) => u.floorId === shownId(g));
/** Round 0 has only the chair stating the topic; there is no "pick who", so do not show a row of dots with a single option */
const hasPicks = (g) => g.utterances.length > 1 || (g.utterances.length === 1 && g.utterances[0].role !== 'chair');

/** Clear the selection when switching councils: the 7F picked in the previous council should not carry over to this one */
watch(
  () => (store.current ? store.current.council.id : null),
  () => Object.keys(picked).forEach((k) => delete picked[k]),
);

const fmtBytes = (n) => (n == null ? '—' : `${n.toLocaleString()}`);

/** Show only the numbers we have: a duration of 0 seconds and "duration unavailable" are not the same thing */
const metaOf = (u) => {
  const parts = [];
  const tk = tokenTotal(u);
  if (tk != null) parts.push(t('council.tokens', { n: tk }));
  if (u.durationMs != null) parts.push(t('council.seconds', { n: (u.durationMs / 1000).toFixed(1) }));
  return parts.join(' · ');
};

/** Deletion is irreversible, so ask first; the copy states that the record is deleted along with it */
function confirmRemove(id) {
  if (window.confirm(t('council.delete_confirm'))) store.remove(id);
}

/** Timestamps in the history list: compact display; today shows only hour:minute, earlier shows month/day + hour:minute */
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
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

        <div class="role-row">
          <label class="role-lbl" for="cv-chair">{{ t('council.role.chair') }}</label>
          <select id="cv-chair" v-model="form.chair" class="sel" data-testid="cv-chair" :disabled="!readyFloors.length">
            <option value="">{{ t('council.role.please_select') }}</option>
            <option v-for="f in readyFloors" :key="f.floorId" :value="f.floorId">
              {{ f.floorId }} · {{ f.name }}
            </option>
          </select>
        </div>

        <div class="role-row">
          <label class="role-lbl" for="cv-main">{{ t('council.role.main_answerer') }}</label>
          <select id="cv-main" v-model="form.mainAnswerer" class="sel" data-testid="cv-main" :disabled="!readyFloors.length">
            <option value="">{{ t('council.role.please_select') }}</option>
            <option
              v-for="f in readyFloors"
              :key="f.floorId"
              :value="f.floorId"
              :disabled="f.floorId === form.chair"
            >
              {{ f.floorId }} · {{ f.name }}
            </option>
          </select>
        </div>

        <div class="role-row">
          <span class="role-lbl">{{ t('council.role.participants') }}</span>
          <ul class="plist">
            <li v-for="f in participantOptions" :key="f.floorId">
              <label>
                <input type="checkbox" :value="f.floorId" v-model="form.participants" />
                <span class="fid">{{ f.floorId }}</span>
                <span class="fname">{{ f.name }}</span>
              </label>
            </li>
            <li v-if="!participantOptions.length" class="hint">{{ t('council.role.no_participants') }}</li>
          </ul>
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
            <p class="hint">{{ form.mode === 'analysis' ? t('council.rounds_note_analysis') : t('council.rounds_note') }}</p>

            <p v-if="form.mode === 'vote'" class="hint">
              {{ t('council.threshold') }}：{{
                store.defaults.threshold === 'majority' ? t('council.threshold.majority') : t('council.threshold.unanimous')
              }} —— {{ t('council.threshold_note') }}
            </p>
          </div>
        </div>

        <p v-if="formError" class="why bad" data-testid="cv-form-error">{{ formError }}</p>
        <p v-if="store.error" class="why bad" data-testid="cv-store-error">{{ store.error }}</p>

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

    <!-- ------------------------------------------------------------ right column: this council -->
    <section class="main">
      <p v-if="!store.current" class="empty">{{ t('council.pick_one') }}</p>

      <template v-else>
        <header class="head">
          <div class="who">
            <span class="badge" :class="'v-' + verdictKey(council.verdict || 'failed')">
              {{ council.verdict ? t('council.verdict.' + verdictKey(council.verdict)) : t('council.status.' + statusKey(council.status)) }}
            </span>
            <!-- Both the mode and the workspace are shown here: in hindsight, "where they talked" is a prerequisite for understanding this council -->
            <span class="badge m" :class="'m-' + store.mode" data-testid="cv-mode-badge">
              {{ t('council.mode.' + store.mode) }}
            </span>
            <span v-if="store.live" class="live" data-testid="cv-live">● {{ t('council.live') }}</span>
          </div>
          <h2 class="topic-h">{{ council.topic }}</h2>
          <p v-if="store.workspacePath" class="ws mono" data-testid="cv-workspace-show">
            {{ t('council.workspace_line') }}<span class="ws-path">{{ store.workspacePath }}</span>
          </p>
          <div class="acts">
            <button v-if="store.live" class="ghost" @click="store.cancel(council.id)">{{ t('council.cancel') }}</button>
            <button v-else class="ghost danger" @click="confirmRemove(council.id)">{{ t('council.delete') }}</button>
          </div>
        </header>

        <p v-if="store.error" class="why bad" data-testid="cv-op-error">{{ store.error }}</p>

        <!--
          The analysis-mode report. **It must come before the generic verdict branch below** ——
          otherwise verdict='reported' would fall into the last "aborted" box and look like this council went wrong.
          Here too no conclusion is synthesized: it only groups by stance and lists what each side said as-is.
        -->
        <div
          v-if="store.mode === 'analysis' && council.verdict === 'reported'"
          class="result report"
          data-testid="cv-report"
        >
          <h3 class="h3">{{ t('council.report') }}</h3>
          <p class="hint">{{ t('council.report_hint', { n: council.max_rounds }) }}</p>
          <p v-if="stanceTally" class="tally" data-testid="cv-report-tally">
            {{
              t('council.stance_tally', {
                support: stanceTally.support,
                oppose: stanceTally.oppose,
                unsure: stanceTally.unsure,
                none: stanceTally.none,
              })
            }}
          </p>

          <section
            v-for="g in report"
            :key="g.key"
            class="rgroup"
            :class="'v-' + g.key"
            :data-testid="'cv-group-' + g.key"
          >
            <h4 class="gh">{{ t('council.stance.' + g.key) }}（{{ g.items.length }}）</h4>
            <ul class="rlist">
              <li v-for="u in g.items" :key="u.floorId">
                <div class="line">
                  <span class="fid">{{ u.floorId }}</span>
                  <span class="fname">{{ floorName(u.floorId) }}</span>
                  <span v-if="u.stance" class="v" :class="'v-' + stanceKey(u.stance)">
                    {{ t('council.stance.' + stanceKey(u.stance)) }}
                  </span>
                </div>

                <!-- No stance: either it did not answer, or it did not give the trailing block as agreed. Show the raw error as-is; do not fill in with something else -->
                <p v-if="g.key === 'none'" class="why bad">
                  {{ u.status === 'unparsed' ? t('council.unparsed') : t('council.failed') }}
                  <span v-if="u.error"> —— {{ u.error }}</span>
                </p>

                <!-- Took a stance but gave no key points: this is "did not give as agreed", not "it said there are no risks"; the two are different statements -->
                <p v-else-if="!u.findings" class="why dim" :data-testid="'cv-nofindings-' + u.floorId">
                  {{ t('council.findings_unparsed') }}
                </p>

                <template v-else>
                  <div v-for="row in findingRows(u)" :key="row.k" class="fl">
                    <span class="fk">{{ t(row.k) }}</span>
                    <ul class="fv">
                      <li v-for="(x, i) in row.v" :key="i">{{ x }}</li>
                    </ul>
                  </div>
                  <!-- All three arrays are empty: it answered, and the answer was "none". This must be kept distinct from the "gave none" above -->
                  <p v-if="!findingRows(u).length" class="why dim">{{ t('council.findings_empty') }}</p>
                </template>
              </li>
            </ul>
          </section>
        </div>

        <!-- Conclusion: on consensus, quote that round's proposal as-is; on no consensus, say no consensus -->
        <div v-else-if="council.verdict === 'consensus' && consensusRound" class="result win" data-testid="cv-conclusion">
          <h3 class="h3">{{ t('council.conclusion') }}</h3>
          <p class="hint">{{ t('council.conclusion_from_round', { n: consensusRound.round_no }) }}</p>
          <blockquote class="quote">{{ consensusRound.proposal_text }}</blockquote>
        </div>

        <div v-else-if="council.verdict === 'no_consensus'" class="result lose" data-testid="cv-no-conclusion">
          <h3 class="h3">{{ t('council.no_conclusion', { n: council.max_rounds }) }}</h3>
          <p class="hint">{{ t('council.no_conclusion_hint') }}</p>
          <ul v-if="lastDebate" class="stances">
            <li v-for="u in lastDebate.utterances.filter((x) => x.role !== 'chair')" :key="u.floorId">
              <span class="v" :class="'v-' + voteKey(u.vote)">{{ t('council.vote.' + voteKey(u.vote)) }}</span>
              <span class="fid">{{ u.floorId }}</span>
              <!-- Those with no stance (timeout / crash / unparsed) do not get a "gave no reason" note: they never answered at all,
                   so leaving the reason column empty is the truth, and the stance is made clear by the "no stance" tag above -->
              <span v-if="u.voteReason" class="reason">{{ u.voteReason }}</span>
              <span v-else-if="u.status !== 'ok'" class="dim">{{ u.error }}</span>
            </li>
          </ul>
          <!-- The one on the table in the last round must also be shown (for traceability), but **marked as not passed** ——
               it must not look like the "conclusion" block above, or it would be taken as something agreed -->
          <div v-if="store.currentProposal" class="last-proposal" data-testid="cv-last-proposal">
            <p class="hint">{{ t('council.last_proposal', { round: store.currentProposal.roundNo }) }}</p>
            <blockquote class="quote notpassed">{{ store.currentProposal.proposal }}</blockquote>
          </div>
        </div>

        <div v-else-if="council.verdict" class="result" data-testid="cv-aborted">
          <h3 class="h3">{{ t('council.verdict.' + verdictKey(council.verdict)) }}</h3>
          <p v-if="council.error" class="why bad">{{ council.error }}</p>
        </div>

        <!-- Which proposal is currently on the table (only vote mode has the notion of "the proposal on the table") -->
        <div v-if="store.mode === 'vote' && store.live && store.currentProposal" class="proposal" data-testid="cv-proposal">
          <span class="tag">{{ t('council.current_proposal') }}</span>
          <span class="p-round">{{ t('council.round_of', { n: store.currentProposal.roundNo, total: council.max_rounds }) }}</span>
          <p class="p-text">{{ store.currentProposal.proposal }}</p>
          <p class="hint">
            {{
              store.currentProposal.proposalFrom === 'chair'
                ? t('council.proposal_from_chair')
                : t('council.proposal_from', { floor: store.currentProposal.proposalFrom })
            }}
          </p>
          <p class="hint">{{ t('council.tie_rule') }}</p>
        </div>

        <!-- Round-by-round timeline -->
        <ol class="timeline">
          <li v-for="g in store.timeline" :key="g.roundNo" class="round">
            <div class="round-head">
              <span class="rno">{{ g.roundNo === 0 ? t('council.round_brief') : t('council.round_n', { n: g.roundNo }) }}</span>
              <span v-if="g.roundNo > 0 && store.mode === 'vote'" class="tally">
                {{ t('council.tally', { agree: g.tally.agree, disagree: g.tally.disagree, abstain: g.tally.abstain, invalid: g.tally.invalid }) }}
              </span>
              <!-- Analysis mode does not count votes: this line gives "each person's leaning this round", with the definition and the no-stance count spelled out -->
              <span v-else-if="g.roundNo > 0" class="tally">
                {{
                  t('council.stance_tally', {
                    support: g.stanceTally.support,
                    oppose: g.stanceTally.oppose,
                    unsure: g.stanceTally.unsure,
                    none: g.stanceTally.none,
                  })
                }}
              </span>
              <span v-if="store.mode === 'vote' && serverTally(g.roundNo) && serverTally(g.roundNo).consensus === 1" class="won">
                {{ t('council.consensus_reached') }}
              </span>
            </div>

            <!-- Pick whose utterance to view in a round. Only the body text is collapsed; the vote tally and "did not answer" still hang on the row -->
            <div
              v-if="hasPicks(g)"
              class="picks"
              role="radiogroup"
              :aria-label="t('council.pick_speaker')"
              :data-testid="'cv-picks-' + g.roundNo"
            >
              <label
                v-for="u in g.utterances"
                :key="u.floorId"
                class="pick"
                :class="[{ on: shownId(g) === u.floorId }, u.status]"
                :data-testid="'cv-pick-' + g.roundNo + '-' + u.floorId"
              >
                <input
                  type="radio"
                  :name="'cv-pick-' + g.roundNo"
                  :value="u.floorId"
                  :checked="shownId(g) === u.floorId"
                  @change="picked[g.roundNo] = u.floorId"
                />
                <span class="fid">{{ u.floorId }}</span>
                <span class="fname">{{ u.role === 'chair' ? t('council.chair') : floorName(u.floorId) }}</span>
                <!-- The vote tally is marked only in vote mode. Analysis-mode stances are written by group in the report above ——
                     putting "support/oppose" to the right of the floor name would make people think the analysis is also voting -->
                <span v-if="store.mode === 'vote' && u.role !== 'chair'" class="v" :class="'v-' + voteKey(u.vote)">
                  {{ t('council.vote.' + voteKey(u.vote)) }}
                </span>
                <span v-if="store.mode === 'vote' && u.second" class="dim">{{ t('council.second', { floor: u.second }) }}</span>
                <!-- The floor that could not speak: the body text is collapsed, but this must not become invisible too.
                     The reason (raw error) is on the title attribute, available in place; the full text is still listed in the attendance column -->
                <span v-if="u.status !== 'ok'" class="bad" :title="u.error || ''">
                  {{ u.status === 'unparsed' ? t('council.unparsed') : t('council.failed') }}
                </span>
              </label>
            </div>

            <article v-for="u in shown(g)" :key="u.floorId" class="said" :class="[u.status, u.role]">
              <!-- When there is only one utterance (the chair's statement in round 0) there is no row of dots above, so the byline must be written here itself -->
              <div v-if="!hasPicks(g)" class="line">
                <span class="fid">{{ u.floorId }}</span>
                <span class="fname">{{ u.role === 'chair' ? t('council.chair') : floorName(u.floorId) }}</span>
                <!-- Same as above: analysis mode does not put a stance to the right of the floor -->
                <span v-if="store.mode === 'vote' && u.role !== 'chair'" class="v" :class="'v-' + voteKey(u.vote)">
                  {{ t('council.vote.' + voteKey(u.vote)) }}
                </span>
                <span v-if="store.mode === 'vote' && u.second" class="dim">{{ t('council.second', { floor: u.second }) }}</span>
                <span class="spacer" />
                <span v-if="metaOf(u)" class="meta dim">{{ metaOf(u) }}</span>
              </div>

              <!-- Did not answer / did not take a stance as agreed: say so faithfully and show the raw error -->
              <p v-if="u.status !== 'ok'" class="why bad" :data-testid="'cv-notice-' + u.floorId">
                {{ u.status === 'unparsed' ? t('council.unparsed') : t('council.failed') }}
                <span v-if="u.error"> —— {{ u.error }}</span>
              </p>

              <pre v-if="u.content" class="body">{{ u.content }}</pre>

              <p v-if="u.voteReason" class="sub"><span class="k">{{ t('council.reason') }}</span>{{ u.voteReason }}</p>
              <p v-if="u.proposal" class="sub"><span class="k">{{ t('council.proposal') }}</span>{{ u.proposal }}</p>

              <!-- Analysis mode: list the three parsed columns once (the JSON snippet in the body is still above; that is the raw text) -->
              <div v-for="row in findingRows(u)" :key="row.k" class="fl">
                <span class="fk">{{ t(row.k) }}</span>
                <ul class="fv">
                  <li v-for="(x, i) in row.v" :key="i">{{ x }}</li>
                </ul>
              </div>
            </article>
          </li>
        </ol>

        <!-- Attendees and materials -->
        <div class="foot">
          <div class="box">
            <h3 class="h3">{{ t('council.participants') }}</h3>
            <ul class="plist">
              <li v-for="p in store.current.participants" :key="p.floor_id">
                <span class="fid">{{ p.floor_id }}</span>
                <span class="fname">{{ floorName(p.floor_id) }}</span>
                <span class="st" :class="p.status">{{ t('council.pstatus.' + p.status) }}</span>
                <span v-if="p.error" class="dim">{{ p.error }}</span>
              </li>
            </ul>
          </div>
          <div v-if="store.current.materials.length" class="box">
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

.h2 { font-size: 14px; margin: 0 0 10px; }
.h3 { font-size: 13px; margin: 0 0 8px; color: var(--text-dim); }
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
/* Mode badge in the history list: short and unobtrusive, only to separate the two kinds of councils */
.m { font-size: 10px; color: var(--text-faint); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
.badge.m-analysis { color: var(--accent); border-color: var(--accent); }
.ws { font-size: 11px; color: var(--text-faint); margin: 0; word-break: break-all; }
.ws-path { color: var(--text-dim); margin-left: 4px; }

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
.live { font-size: 11px; color: var(--state-busy); }
.acts { display: flex; gap: 8px; }

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

.badge,
.v {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;
  border: 1px solid var(--border-strong);
  white-space: nowrap;
}
.v-agree,
.v-support { color: var(--state-online); border-color: var(--state-online); }
.v-disagree,
.v-oppose { color: var(--state-blocked); border-color: var(--state-blocked); }
.v-abstain,
.v-unsure { color: var(--state-idle); }
.v-none { color: var(--text-faint); }
.v-consensus { color: var(--state-online); border-color: var(--state-online); }
.v-no_consensus { color: var(--state-busy); border-color: var(--state-busy); }
.v-reported { color: var(--accent); border-color: var(--accent); }
.v-cancelled,
.v-failed { color: var(--text-dim); }

.result {
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 10px 12px;
  background: var(--bg-panel);
}
.result.win { border-color: var(--state-online); }
.result.lose { border-color: var(--state-busy); }
/* Report: no color —— it is not a verdict, just the parties' words placed side by side */
.result.report { border-color: var(--border-strong); }

.rgroup { margin-top: 10px; }
.rgroup .gh { font-size: 12px; margin: 0 0 6px; color: var(--text-dim); }
/* A color bar on the left so the four levels are distinguishable at a glance (the no-stance level is gray; it does not pretend to have a position) */
.rgroup { border-left: 3px solid var(--border-strong); padding-left: 10px; }
.rgroup.v-support { border-left-color: var(--state-online); }
.rgroup.v-oppose { border-left-color: var(--state-blocked); }
.rgroup.v-unsure { border-left-color: var(--state-idle); }
.rgroup.v-none { border-left-color: var(--text-faint); }
.rlist { list-style: none; margin: 0; padding: 0; }
.rlist > li { margin: 0 0 8px; }
.rlist > li:last-child { margin-bottom: 0; }

/* Three key-point rows: conclusion / risks / questions. Listed as-is, not rewritten or reordered */
.fl { display: flex; gap: 8px; margin: 4px 0 0; font-size: 12px; }
.fk { color: var(--text-faint); flex: 0 0 auto; min-width: 32px; }
.fv { list-style: none; margin: 0; padding: 0; color: var(--text); line-height: 1.5; }
.fv li::before { content: '· '; color: var(--text-faint); }
.quote {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-left: 3px solid var(--state-online);
  background: var(--bg-elevated);
  border-radius: 0 8px 8px 0;
  white-space: pre-wrap;
  font-size: 12px;
  line-height: 1.6;
}
/* The one that did not pass: dashed border + gray —— distinguishable from the "conclusion" at a glance */
.quote.notpassed {
  border-left-style: dashed;
  border-left-color: var(--state-busy);
  color: var(--text-dim);
}
.last-proposal { margin-top: 10px; }
.stances { list-style: none; margin: 6px 0 0; padding: 0; }
.stances li { display: flex; gap: 8px; align-items: baseline; font-size: 12px; margin: 4px 0; }
.reason { color: var(--text-dim); }

.proposal {
  border: 1px dashed var(--accent);
  border-radius: var(--radius);
  padding: 8px 12px;
  background: var(--bg-elevated);
}
.tag { font-size: 11px; color: var(--accent); }
.p-round { font-size: 11px; color: var(--text-faint); margin-left: 8px; }
.p-text { margin: 6px 0 0; white-space: pre-wrap; font-size: 12px; line-height: 1.6; }

.timeline { list-style: none; margin: 0; padding: 0; }
.round { margin-bottom: 12px; }
.round-head { display: flex; gap: 8px; align-items: baseline; margin-bottom: 6px; }
.rno { font-size: 12px; color: var(--text-dim); font-weight: 600; }
.tally { font-size: 11px; color: var(--text-faint); }
.won { font-size: 11px; color: var(--state-online); }

/* Pick whose utterance to view in a round: a row of dots, with the selected one's body text expanded below */
.picks { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-bottom: 6px; }
.pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
}
.pick:hover { background: var(--bg-elevated); }
.pick.on { background: var(--accent-soft); border-color: var(--border-strong); color: var(--text); }
.pick input { margin: 0; accent-color: var(--accent); }
.pick.failed,
.pick.timeout { color: var(--state-blocked); }

.said {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  padding: 8px 10px;
  margin-bottom: 6px;
}
.said.chair { background: var(--bg-elevated); }
.said.failed,
.said.timeout { border-color: var(--state-blocked); }
.line { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.spacer { flex: 1; }
.meta { font-size: 11px; }
.body {
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font: inherit;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
  max-height: 320px;
  overflow: auto;
}
.sub { margin: 4px 0 0; font-size: 12px; color: var(--text-dim); line-height: 1.5; }
.sub .k { color: var(--text-faint); margin-right: 6px; }

.foot { display: flex; gap: var(--gap); flex-wrap: wrap; margin-top: 4px; }
.box {
  flex: 1 1 260px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
}
.plist,
.mlist { list-style: none; margin: 0; padding: 0; }
.plist li,
.mlist li { display: flex; gap: 8px; align-items: baseline; font-size: 12px; margin: 3px 0; }
.plist .st { font-size: 11px; color: var(--text-faint); }
.plist .st.ok { color: var(--state-online); }
.plist .st.failed { color: var(--state-blocked); }
.mlist .path { font-size: 11px; word-break: break-all; }
.dim { color: var(--text-faint); }
.bad { color: var(--state-blocked); }
.mono { font-family: var(--mono); }
</style>