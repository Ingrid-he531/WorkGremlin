<script setup>
/**
 * 议事厅：选几层 agent，就一个问题开一场会，看它们谈成没谈成。
 *
 * 这个页面的责任是**如实呈现**，不是给一个好看的结论。所以：
 *   · 谁没答话就写「未表态」，红字摆上错误原文 —— 不画成一个立场；
 *   · 票型分两份显示：服务端判定的那份（依据）+ 从发言数出来的那份（印证），
 *     两份对不上时人一眼能看出来；
 *   · 材料截断了就在材料清单里写明"原文多少字节、只给了多少"；
 *   · 没谈成就大大方方写「未达成一致」并列出各自最后的立场，不合成一份"结论"。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useCouncilStore } from '../stores/council';
import { useI18n } from '../i18n';
import { voteKey, tokenTotal } from '../lib/councilTimeline';

const store = useCouncilStore();
const { t } = useI18n();

const form = reactive({ topic: '', floors: [], files: '', maxRounds: 3 });
const formError = ref('');

onMounted(async () => {
  await store.fetchFloors();
  await store.fetchList();
  form.maxRounds = store.defaults.maxRounds || 3;
});

const floorName = (id) => {
  const f = store.floors.find((x) => x.floorId === id);
  return f ? f.name : id;
};

const toggleFloor = (id) => {
  const at = form.floors.indexOf(id);
  if (at >= 0) form.floors.splice(at, 1);
  else form.floors.push(id);
};

const files = () => form.files.split('\n').map((s) => s.trim()).filter(Boolean);

async function submit() {
  formError.value = '';
  if (!form.topic.trim()) {
    formError.value = t('council.need_topic');
    return;
  }
  if (form.floors.length < 2) {
    formError.value = t('council.need_two_floors');
    return;
  }
  const id = await store.create({
    topic: form.topic.trim(),
    floors: form.floors,
    files: files(),
    maxRounds: Number(form.maxRounds) || store.defaults.maxRounds,
  });
  if (id) form.topic = '';
}

/* ---------------------------------------------------------------- 结果 */

const council = computed(() => (store.current ? store.current.council : null));

/** 达成一致的那一轮 —— 结论就是它桌上那份提案原文，原样显示，不由前端改写 */
const consensusRound = computed(() => {
  if (!store.current) return null;
  return store.current.rounds.find((r) => r.consensus === 1) || null;
});

/** 服务端判定的票型（按轮次索引），与从发言数出来的那份并存 */
const serverTally = (roundNo) => (store.current ? store.current.rounds.find((r) => r.round_no === roundNo) : null) || null;

const lastDebate = computed(() => {
  const rounds = store.timeline.filter((g) => g.roundNo > 0);
  return rounds.length ? rounds[rounds.length - 1] : null;
});

const statusKey = (s) => (['draft', 'running', 'done', 'failed', 'cancelled'].includes(s) ? s : 'done');
const verdictKey = (v) => (['consensus', 'no_consensus', 'cancelled', 'failed'].includes(v) ? v : 'failed');

const fmtBytes = (n) => (n == null ? '—' : `${n.toLocaleString()}`);

/** 只显示拿得到的数字：耗时为 0 秒和"读不到耗时"不是一回事 */
const metaOf = (u) => {
  const parts = [];
  const tk = tokenTotal(u);
  if (tk != null) parts.push(t('council.tokens', { n: tk }));
  if (u.durationMs != null) parts.push(t('council.seconds', { n: (u.durationMs / 1000).toFixed(1) }));
  return parts.join(' · ');
};

/** 删除不可撤销，先问一句；文案里写清"记录一并删掉" */
function confirmRemove(id) {
  if (window.confirm(t('council.delete_confirm'))) store.remove(id);
}
</script>

<template>
  <div class="view">
    <!-- ------------------------------------------------------------ 左栏：发起 + 历史 -->
    <aside class="side">
      <form class="compose" @submit.prevent="submit">
        <h2 class="h2">{{ t('council.new') }}</h2>

        <label class="lbl" for="cv-topic">{{ t('council.topic') }}</label>
        <textarea
          id="cv-topic"
          v-model="form.topic"
          class="ta"
          rows="3"
          :placeholder="t('council.topic_ph')"
        />

        <label class="lbl">{{ t('council.floors') }}</label>
        <p v-if="!store.canStart" class="why bad" data-testid="cv-no-floors">{{ t('council.empty_floors') }}</p>
        <ul class="floors">
          <li v-for="f in store.floors" :key="f.floorId" :class="{ off: !f.ready }">
            <label :title="f.ready ? f.cliPath : f.reason">
              <input
                type="checkbox"
                :value="f.floorId"
                :checked="form.floors.includes(f.floorId)"
                :disabled="!f.ready"
                @change="toggleFloor(f.floorId)"
              />
              <span class="fid">{{ f.floorId }}</span>
              <span class="fname">{{ f.name }}</span>
              <span v-if="!f.ready" class="why">{{ t('council.floor_not_ready') }}</span>
            </label>
            <!-- 请不动的原因原样显示（"只装了 IDE 插件"和"没装"要分得开） -->
            <p v-if="!f.ready" class="why dim">{{ f.reason }}</p>
          </li>
        </ul>
        <p class="hint">{{ t('council.floors_hint') }}</p>

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

        <p class="hint">
          {{ t('council.threshold') }}：{{
            store.defaults.threshold === 'majority' ? t('council.threshold.majority') : t('council.threshold.unanimous')
          }} —— {{ t('council.threshold_note') }}
        </p>

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
            <span class="v" :class="'v-' + verdictKey(c.verdict || 'failed')">
              {{ c.verdict ? t('council.verdict.' + verdictKey(c.verdict)) : t('council.status.' + statusKey(c.status)) }}
            </span>
            <span class="topic">{{ c.topic }}</span>
          </li>
        </ul>
      </div>
    </aside>

    <!-- ------------------------------------------------------------ 右栏：这场会 -->
    <section class="main">
      <p v-if="!store.current" class="empty">{{ t('council.pick_one') }}</p>

      <template v-else>
        <header class="head">
          <div class="who">
            <span class="badge" :class="'v-' + verdictKey(council.verdict || 'failed')">
              {{ council.verdict ? t('council.verdict.' + verdictKey(council.verdict)) : t('council.status.' + statusKey(council.status)) }}
            </span>
            <span v-if="store.live" class="live" data-testid="cv-live">● {{ t('council.live') }}</span>
          </div>
          <h2 class="topic-h">{{ council.topic }}</h2>
          <div class="acts">
            <button v-if="store.live" class="ghost" @click="store.cancel(council.id)">{{ t('council.cancel') }}</button>
            <button v-else class="ghost danger" @click="confirmRemove(council.id)">{{ t('council.delete') }}</button>
          </div>
        </header>

        <p v-if="store.error" class="why bad" data-testid="cv-op-error">{{ store.error }}</p>

        <!-- 结论：谈成了就原样引用那一轮的提案；没谈成就说没谈成 -->
        <div v-if="council.verdict === 'consensus' && consensusRound" class="result win" data-testid="cv-conclusion">
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
              <!-- 没表态的（超时 / 崩 / 解析不出）不补一句"没说理由"：它压根没答话，
                   理由栏空着才是实情，立场由上面那个「未表态」标签说清 -->
              <span v-if="u.voteReason" class="reason">{{ u.voteReason }}</span>
              <span v-else-if="u.status !== 'ok'" class="dim">{{ u.error }}</span>
            </li>
          </ul>
          <!-- 最后一轮桌上那份也要摆出来（可追溯），但**标明它没通过** ——
               不能长得跟上面那个「结论」区块一样，否则会被当成谈成了什么 -->
          <div v-if="store.currentProposal" class="last-proposal">
            <p class="hint">{{ t('council.last_proposal', { round: store.currentProposal.roundNo }) }}</p>
            <blockquote class="quote notpassed">{{ store.currentProposal.proposal }}</blockquote>
          </div>
        </div>

        <div v-else-if="council.verdict" class="result" data-testid="cv-aborted">
          <h3 class="h3">{{ t('council.verdict.' + verdictKey(council.verdict)) }}</h3>
          <p v-if="council.error" class="why bad">{{ council.error }}</p>
        </div>

        <!-- 现在桌上的是哪份提案 -->
        <div v-if="store.live && store.currentProposal" class="proposal" data-testid="cv-proposal">
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

        <!-- 逐轮时间线 -->
        <ol class="timeline">
          <li v-for="g in store.timeline" :key="g.roundNo" class="round">
            <div class="round-head">
              <span class="rno">{{ g.roundNo === 0 ? t('council.round_brief') : t('council.round_n', { n: g.roundNo }) }}</span>
              <span v-if="g.roundNo > 0" class="tally">
                {{ t('council.tally', { agree: g.tally.agree, disagree: g.tally.disagree, abstain: g.tally.abstain, invalid: g.tally.invalid }) }}
              </span>
              <span v-if="serverTally(g.roundNo) && serverTally(g.roundNo).consensus === 1" class="won">
                {{ t('council.consensus_reached') }}
              </span>
            </div>

            <article v-for="u in g.utterances" :key="u.floorId" class="said" :class="[u.status, u.role]">
              <div class="line">
                <span class="fid">{{ u.floorId }}</span>
                <span class="fname">{{ u.role === 'chair' ? t('council.chair') : floorName(u.floorId) }}</span>
                <span v-if="u.role !== 'chair'" class="v" :class="'v-' + voteKey(u.vote)">
                  {{ t('council.vote.' + voteKey(u.vote)) }}
                </span>
                <span v-if="u.second" class="dim">{{ t('council.second', { floor: u.second }) }}</span>
                <span class="spacer" />
                <span v-if="metaOf(u)" class="meta dim">{{ metaOf(u) }}</span>
              </div>

              <!-- 没答上来 / 没按约定表态：如实说，把错误原文摆出来 -->
              <p v-if="u.status !== 'ok'" class="why bad" :data-testid="'cv-notice-' + u.floorId">
                {{ u.status === 'unparsed' ? t('council.unparsed') : t('council.failed') }}
                <span v-if="u.error"> —— {{ u.error }}</span>
              </p>

              <pre v-if="u.content" class="body">{{ u.content }}</pre>

              <p v-if="u.voteReason" class="sub"><span class="k">{{ t('council.reason') }}</span>{{ u.voteReason }}</p>
              <p v-if="u.proposal" class="sub"><span class="k">{{ t('council.proposal') }}</span>{{ u.proposal }}</p>
            </article>
          </li>
        </ol>

        <!-- 出席者与材料 -->
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

/* ------------------------------------------------------------ 左栏 */
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
.history .topic {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ------------------------------------------------------------ 右栏 */
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
.v-agree { color: var(--state-online); border-color: var(--state-online); }
.v-disagree { color: var(--state-blocked); border-color: var(--state-blocked); }
.v-abstain { color: var(--state-idle); }
.v-none { color: var(--text-faint); }
.v-consensus { color: var(--state-online); border-color: var(--state-online); }
.v-no_consensus { color: var(--state-busy); border-color: var(--state-busy); }
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
/* 没通过的那份：虚线 + 灰——一眼能和"结论"分开 */
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
