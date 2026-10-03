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
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useCouncilStore } from '../stores/council';
import { useI18n } from '../i18n';
import { voteKey, stanceKey, tokenTotal } from '../lib/councilTimeline';

const store = useCouncilStore();
const { t } = useI18n();

/**
 * 角色分配：主持人、主答各一人，参会者可多选。
 * 向后兼容：提交时把三种角色的楼层合并成 floors 数组发给服务端，
 * 服务端暂时不区分角色（等后续再改 orchestrator）。
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
/** 参会者候选项：除主持人和主答之外的可用楼层 */
const participantOptions = computed(() =>
  readyFloors.value.filter((f) => f.floorId !== form.chair && f.floorId !== form.mainAnswerer),
);
/** 请不动的楼层（装了插件但没装 CLI 等），列出来并写明原因 */
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
  // 工作目录前端只拦一件事：**必须写绝对路径**。存在不存在、是不是目录，交给服务端 ——
  // 它在发起的那一刻校验，比前端猜准，而且它说的话原样显示给用户。
  // 前端自己判一句的原因只是"让用户少等一趟往返"，不是为了替他做判断。
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
const verdictKey = (v) =>
  ['consensus', 'no_consensus', 'reported', 'cancelled', 'failed'].includes(v) ? v : 'failed';

/**
 * 分析模式的简报分组 —— **服务端不合成结论，我们也不合成**。
 * 只做一件事：把最后一轮各人的最终判断按立场摆到一起，`points` / `risks` / `questions`
 * 原样列出。顺序固定四档（支持 → 反对 → 不确定 → 未表态），空组不渲染。
 *
 * 为什么以**最后一轮**为准：提示词里明写了最后那轮要给最终判断，而中间轮次是过程 ——
 * 把每一轮的立场都堆上来，读的人反而看不出他们最后到底站哪儿。过程在下面的时间线里，
 * 一条都没丢。
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

/** 简报里的立场计数（从发言现数）。chair 不占席位，与表决那套口径一致 */
const stanceTally = computed(() => (lastDebate.value ? lastDebate.value.stanceTally : null));

/**
 * 一条发言的要点 → 「标题键 + 该列的条目」两两一组，空列不出现。
 * findings 为 null（没解析出来）时返回空数组 —— 那是另一句话（findings_unparsed），
 * 调用方按 `!u.findings` 分开走，不靠这个空数组来区分。
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

/* ------------------------------------------------------- 一轮里看谁的发言 */

/**
 * 一轮里可能有好几层各说了一大段，全摊开就是一屏接一屏的正文，"谁说了什么"反而找不着。
 * 所以一轮**一次只摊开一个人的**，上面一排圆点选是谁 —— 收起来的是正文，不是事实：
 * 票型（表决模式）与"这轮没能发言"照旧留在那一行上，谁也不许被折叠掉。
 *
 * 键是轮次号，值是楼层。没选过、或选的那一层在这一轮里没了 → 退回本轮第一位，
 * **绝不空着**：一轮里一个人都不显示，看起来就像这轮没人说话。
 */
const picked = reactive({});
const shownId = (g) => {
  const want = picked[g.roundNo];
  return g.utterances.some((u) => u.floorId === want) ? want : g.utterances[0] && g.utterances[0].floorId;
};
const shown = (g) => g.utterances.filter((u) => u.floorId === shownId(g));
/** 第 0 轮只有主席在陈述议题，没有"选谁"这回事，就别摆一排只有一个选项的圆点 */
const hasPicks = (g) => g.utterances.length > 1 || (g.utterances.length === 1 && g.utterances[0].role !== 'chair');

/** 换一场会就把选择清空：上一场选的 7F 不该管到这一场 */
watch(
  () => (store.current ? store.current.council.id : null),
  () => Object.keys(picked).forEach((k) => delete picked[k]),
);

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

/** 历史列表里的时间：紧凑显示，今天的只看时分，更早的看月日+时分 */
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
    <!-- ------------------------------------------------------------ 左栏：发起 + 历史 -->
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

    <!-- ------------------------------------------------------------ 右栏：这场会 -->
    <section class="main">
      <p v-if="!store.current" class="empty">{{ t('council.pick_one') }}</p>

      <template v-else>
        <header class="head">
          <div class="who">
            <span class="badge" :class="'v-' + verdictKey(council.verdict || 'failed')">
              {{ council.verdict ? t('council.verdict.' + verdictKey(council.verdict)) : t('council.status.' + statusKey(council.status)) }}
            </span>
            <!-- 谈法与工作目录都摆在这儿：事后来看，"他们在哪儿谈的"是理解这场会的前提 -->
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
          分析模式的简报。**必须排在下面那个通用 verdict 分支之前** ——
          否则 verdict='reported' 会掉进最后那个"中断"框，看起来像这场会出事了。
          这里同样不合成结论：只按立场分组，各自说了什么照原样列。
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

                <!-- 未表态的：它要么没答上来、要么没按约定给尾块。错误原文照摆，别拿别的凑 -->
                <p v-if="g.key === 'none'" class="why bad">
                  {{ u.status === 'unparsed' ? t('council.unparsed') : t('council.failed') }}
                  <span v-if="u.error"> —— {{ u.error }}</span>
                </p>

                <!-- 表了态却没给要点：这是"没按约定给"，不是"它说没有风险"，两句话不一样 -->
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
                  <!-- 三条数组都空：它答了，答的是"没有"。这跟上面"没给"要分得开 -->
                  <p v-if="!findingRows(u).length" class="why dim">{{ t('council.findings_empty') }}</p>
                </template>
              </li>
            </ul>
          </section>
        </div>

        <!-- 结论：谈成了就原样引用那一轮的提案；没谈成就说没谈成 -->
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
              <!-- 没表态的（超时 / 崩 / 解析不出）不补一句"没说理由"：它压根没答话，
                   理由栏空着才是实情，立场由上面那个「未表态」标签说清 -->
              <span v-if="u.voteReason" class="reason">{{ u.voteReason }}</span>
              <span v-else-if="u.status !== 'ok'" class="dim">{{ u.error }}</span>
            </li>
          </ul>
          <!-- 最后一轮桌上那份也要摆出来（可追溯），但**标明它没通过** ——
               不能长得跟上面那个「结论」区块一样，否则会被当成谈成了什么 -->
          <div v-if="store.currentProposal" class="last-proposal" data-testid="cv-last-proposal">
            <p class="hint">{{ t('council.last_proposal', { round: store.currentProposal.roundNo }) }}</p>
            <blockquote class="quote notpassed">{{ store.currentProposal.proposal }}</blockquote>
          </div>
        </div>

        <div v-else-if="council.verdict" class="result" data-testid="cv-aborted">
          <h3 class="h3">{{ t('council.verdict.' + verdictKey(council.verdict)) }}</h3>
          <p v-if="council.error" class="why bad">{{ council.error }}</p>
        </div>

        <!-- 现在桌上的是哪份提案（只有表决模式有"桌上那份提案"这回事） -->
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

        <!-- 逐轮时间线 -->
        <ol class="timeline">
          <li v-for="g in store.timeline" :key="g.roundNo" class="round">
            <div class="round-head">
              <span class="rno">{{ g.roundNo === 0 ? t('council.round_brief') : t('council.round_n', { n: g.roundNo }) }}</span>
              <span v-if="g.roundNo > 0 && store.mode === 'vote'" class="tally">
                {{ t('council.tally', { agree: g.tally.agree, disagree: g.tally.disagree, abstain: g.tally.abstain, invalid: g.tally.invalid }) }}
              </span>
              <!-- 分析模式不数票：这一行给的是"这轮各人的倾向"，口径与未表态人数都写清 -->
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

            <!-- 一轮里选看谁的发言。收起来的只是正文，票型与"没答上来"照旧挂在行上 -->
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
                <!-- 票型只标在表决模式。分析模式的立场在上面那份简报里按组写着 ——
                     把「支持/反对」贴在楼层名字右边，会让人以为分析也是在投票 -->
                <span v-if="store.mode === 'vote' && u.role !== 'chair'" class="v" :class="'v-' + voteKey(u.vote)">
                  {{ t('council.vote.' + voteKey(u.vote)) }}
                </span>
                <span v-if="store.mode === 'vote' && u.second" class="dim">{{ t('council.second', { floor: u.second }) }}</span>
                <!-- 没能发言的那一层：正文收起来了，这件事也不能跟着看不见。
                     原因（error 原文）挂在 title 上就地可取；出席那一栏里也照旧列着全文 -->
                <span v-if="u.status !== 'ok'" class="bad" :title="u.error || ''">
                  {{ u.status === 'unparsed' ? t('council.unparsed') : t('council.failed') }}
                </span>
              </label>
            </div>

            <article v-for="u in shown(g)" :key="u.floorId" class="said" :class="[u.status, u.role]">
              <!-- 只有一处发言时（第 0 轮的主席陈述）没有上面那排圆点，署名就得自己写在这儿 -->
              <div v-if="!hasPicks(g)" class="line">
                <span class="fid">{{ u.floorId }}</span>
                <span class="fname">{{ u.role === 'chair' ? t('council.chair') : floorName(u.floorId) }}</span>
                <!-- 同上：分析模式不在楼层右边贴立场 -->
                <span v-if="store.mode === 'vote' && u.role !== 'chair'" class="v" :class="'v-' + voteKey(u.vote)">
                  {{ t('council.vote.' + voteKey(u.vote)) }}
                </span>
                <span v-if="store.mode === 'vote' && u.second" class="dim">{{ t('council.second', { floor: u.second }) }}</span>
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

              <!-- 分析模式：把解析出的三条单列一遍（正文里那截 JSON 也还在上面，那是原文） -->
              <div v-for="row in findingRows(u)" :key="row.k" class="fl">
                <span class="fk">{{ t(row.k) }}</span>
                <ul class="fv">
                  <li v-for="(x, i) in row.v" :key="i">{{ x }}</li>
                </ul>
              </div>
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

/* ---- 角色分配 ---- */
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

/* ---- 手风琴折叠 ---- */
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
/* 历史列表里的谈法角标：短、不抢眼，只是为了把两种会分开 */
.m { font-size: 10px; color: var(--text-faint); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
.badge.m-analysis { color: var(--accent); border-color: var(--accent); }
.ws { font-size: 11px; color: var(--text-faint); margin: 0; word-break: break-all; }
.ws-path { color: var(--text-dim); margin-left: 4px; }

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
/* 简报：不着色 —— 它不是一个判定，只是把各方说的话摆到一起 */
.result.report { border-color: var(--border-strong); }

.rgroup { margin-top: 10px; }
.rgroup .gh { font-size: 12px; margin: 0 0 6px; color: var(--text-dim); }
/* 左边一道色条，四档一眼分得开（未表态那档是灰的，不假装它有立场） */
.rgroup { border-left: 3px solid var(--border-strong); padding-left: 10px; }
.rgroup.v-support { border-left-color: var(--state-online); }
.rgroup.v-oppose { border-left-color: var(--state-blocked); }
.rgroup.v-unsure { border-left-color: var(--state-idle); }
.rgroup.v-none { border-left-color: var(--text-faint); }
.rlist { list-style: none; margin: 0; padding: 0; }
.rlist > li { margin: 0 0 8px; }
.rlist > li:last-child { margin-bottom: 0; }

/* 要点三行：结论 / 风险 / 存疑。原样列，不重写、不排序 */
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

/* 一轮里选看谁的发言：一排圆点，选中的那个在下面摊开正文 */
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