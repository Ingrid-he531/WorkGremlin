'use strict';

/**
 * The council room's prompts —— pure functions, no IO (material content is read by the caller and
 * passed in).
 *
 * What a participant can do depends on **where it is talking** (see agents.js):
 *   · Isolated mode (working directory = a throwaway temp directory created by the server) —— it has
 *     no tools, cannot read files, cannot run commands, cannot reach the network. So the background
 *     material must be **stuffed into the prompt as-is by the server**, otherwise it has no idea
 *     what is being discussed;
 *   · Project mode (working directory = the user's real project) —— it has a **read-only** tool set
 *     and can go dig through the code itself.
 *
 * In both cases "what you do not know" has to be spelled out, so it does not pass off impressions
 * from its training data as facts.
 *
 * Also, a meeting can run in two ways (councils.mode): 'vote' (proposal + count votes to decide
 * consensus) and 'analysis' (no voting, each writes its own analysis and risks, and the server does
 * not synthesize a conclusion).
 *
 * The "output protocol" must be pinned down, and **the examples we give should carry the fences
 * themselves**: models love to imitate the format in the prompt, so writing the example in the shape
 * they should submit is far more reliable than describing it in prose (the parser takes "the last
 * JSON block", see parseVoteBlock in agents.js, so intermediate examples are never mistaken for the
 * conclusion).
 */

/** Materials joined into one block of text; the fact of truncation must be spelled out (anyone reading it has to know the content given is not complete) */
function renderMaterials(materials) {
  const list = Array.isArray(materials) ? materials : [];
  if (!list.length) return '';
  const blocks = list.map((m) => {
    const head =
      `--- ${m.path}` +
      (m.truncated
        ? `（**已截断**：原始 ${m.bytesTotal} 字节，这里只给了前 ${m.bytesIncluded} 字节）`
        : m.bytesTotal != null
          ? `（${m.bytesTotal} 字节）`
          : '');
    return `${head} ---\n${m.content == null ? '（读不到内容）' : m.content}`;
  });
  return blocks.join('\n\n');
}

/** Vote type -> Chinese (the version shown to participants in the history) */
const VOTE_ZH = { agree: '同意', disagree: '反对', abstain: '弃权' };
/** Stance -> Chinese (analysis mode) */
const STANCE_ZH = { support: '支持', oppose: '反对', unsure: '不确定' };

/** List earlier speeches by round. Empty history returns '' (in round 1 nobody has spoken) */
function renderHistory(history) {
  const list = Array.isArray(history) ? history : [];
  if (!list.length) return '';
  const byRound = new Map();
  for (const h of list) {
    if (!byRound.has(h.roundNo)) byRound.set(h.roundNo, []);
    byRound.get(h.roundNo).push(h);
  }
  const chunks = [];
  for (const roundNo of [...byRound.keys()].sort((a, b) => a - b)) {
    const lines = byRound.get(roundNo).map((h) => {
      const who = `${h.floorId}${h.floorName ? ` ${h.floorName}` : ''}`;
      if (h.status !== 'ok') return `- ${who}：**未能发言**（${h.status}${h.error ? `：${h.error}` : ''}）`;
      // Analysis mode carries stance, vote mode carries vote —— speeches from either kind of meeting
      // may show up in the history, so label whichever one is present, and label nothing when
      // neither is (never guess a stance)
      const mark = h.stance ? STANCE_ZH[h.stance] : h.vote ? VOTE_ZH[h.vote] : '';
      const stance = mark ? `［${mark}］` : '';
      const reason = h.voteReason ? `\n  理由：${h.voteReason}` : '';
      const proposal = h.proposal ? `\n  它建议：${h.proposal}` : '';
      const findings = renderFindings(h.findings);
      return `- ${who}：${stance}\n  ${String(h.content || '').trim()}${reason}${proposal}${findings}`;
    });
    chunks.push(`第 ${roundNo} 轮：\n${lines.join('\n')}`);
  }
  return chunks.join('\n\n');
}

/** Structured points of analysis mode, rendered as three lines in the prompt. Nothing (null) adds not a single word */
function renderFindings(f) {
  if (!f) return '';
  return [
    ['要点', f.points],
    ['风险', f.risks],
    ['存疑', f.questions],
  ]
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([k, v]) => `\n  ${k}：${v.join('；')}`)
    .join('');
}

/**
 * The "who you are and what you cannot do" block shared by every participant. Carried every round
 * so it cannot forget over multiple rounds.
 *
 * Two tiers (depending on whether `workspace` has a value), and **the capability boundary must be
 * accurate**: say "you can read code" and it will read; say "you have nothing" and it can only
 * speak from the material. Get it wrong and its behavior goes wrong with it.
 * @param {string} floorId
 * @param {string} floorName
 * @param {string|null} [workspace] working directory; empty = isolated mode (no tools)
 */
function roleBlock(floorId, floorName, workspace) {
  const head = `你是 WorkGremlin 议事厅里【${floorId} ${floorName}】这一层的代表，正在参加一场多方讨论。`;
  if (workspace) {
    return [
      head,
      '',
      `你正在 \`${workspace}\` 这个工程目录里，可以用**只读**工具自己去翻代码（读文件、按名字或内容搜索）。`,
      '除此之外你什么都做不了：**不能修改任何文件、不能执行命令、不能上网、看不到对方的机器**。',
      '你看到的就是这个工程真实的当前代码 —— 拿不准的事就去读，别凭印象编造；读了仍然不确定，就直说不确定。',
    ].join('\n');
  }
  return [
    head,
    '',
    '你能做的只有一件事：**说话**。你没有文件读写、不能执行命令、不能上网、看不到对方的机器。',
    '下面给出的材料就是你能知道的全部信息 —— 材料里没有的，不要凭印象编造；不确定就直说不确定。',
  ].join('\n');
}

/** Output protocol. The example carries the fence, so copying the format is the safest bet */
const OUTPUT_PROTOCOL = [
  '【本轮怎么回】',
  '1. 先用自然语言说你的看法（可以直接指出别人发言里的问题，也可以改变自己的立场）。',
  '2. 然后在**最后**附一个 JSON 代码块，格式必须是这样：',
  '',
  '```json',
  '{"vote":"agree","reason":"一句话说明你的理由"}',
  '```',
  '',
  'vote 只能是 agree / disagree / abstain 三个之一。',
  '如果你投 disagree，**必须**在同一个 JSON 里加一个 proposal 字段，写清你建议改成什么：',
  '',
  '```json',
  '{"vote":"disagree","reason":"风险没有兜底","proposal":"你建议的替代方案，一句话说清"}',
  '```',
  '',
  '如果你认可**别人**提出的修订方案，可以加 second 字段填那个楼层的编号（例如 "second":"4F"）表示附议。',
  '如果你没有明确立场，可以投 abstain，但 reason 仍要写 —— 弃权也是一个需要说明的态度。',
].join('\n');

/**
 * Output protocol for analysis mode. **No voting, no proposal, no consensus** —— the server does not
 * count votes and does not synthesize a conclusion for them; what is wanted here is "each one's own
 * analysis" and "where the disagreement lies".
 * The examples carry the fences too: copying the prompt's format beats describing it in prose.
 */
const ANALYSIS_PROTOCOL = [
  '【本轮怎么回】',
  '1. 先写你的分析（自然语言，可以引用代码里的具体位置、可以指出别人分析里的问题、也可以改自己的判断）。',
  '2. 然后在**最后**附一个 JSON 代码块，格式必须是这样：',
  '',
  '```json',
  '{"stance":"support","points":["你的关键结论"],"risks":["这个做法可能引入的风险或回归点"],"questions":["你还不确定、需要别人补充的"]}',
  '```',
  '',
  'stance 只能是 support（支持这个做法）/ oppose（反对）/ unsure（还不确定）三个之一 —— 它是你**本轮**的总体倾向。',
  'points / risks / questions 三个数组可以留空（写成 []），但不要为了凑数编内容：',
  '没发现风险就写 []，读不出来、拿不准的，写进 questions 或者直接说不确定。',
].join('\n');

/**
 * The speech prompt for one round.
 *
 * @param {{topic:string, materials:Array, proposal?:string, proposalFrom?:string,
 *          roundNo:number, maxRounds:number, history:Array,
 *          floorId:string, floorName:string,
 *          mode?:'vote'|'analysis', workspace?:string|null}} arg
 *   mode defaults to 'vote' (old callers need no change); proposal / proposalFrom are only used in
 *   vote mode.
 * @returns {string}
 */
function buildSpeechPrompt(arg) {
  const analysis = arg.mode === 'analysis';
  const parts = [
    roleBlock(arg.floorId, arg.floorName, arg.workspace),
    '',
    '【议题】',
    String(arg.topic || '').trim(),
  ];

  // The working directory goes under the topic: in project mode it is the only clue about "where to
  // look for the answer"
  if (arg.workspace) parts.push('', '【工作目录】', String(arg.workspace));

  const mats = renderMaterials(arg.materials);
  if (mats) parts.push('', '【背景材料】', mats);

  if (analysis) {
    // Analysis mode has no such thing as "the proposal on the table" —— all that is put forward is
    // the topic itself
    parts.push('', `【第 ${arg.roundNo}/${arg.maxRounds} 轮】`);
    if (arg.roundNo === arg.maxRounds) parts.push('这是最后一轮 —— 请给出你的最终判断。');
  } else {
    parts.push(
      '',
      `【现在要表决的提案】（第 ${arg.roundNo}/${arg.maxRounds} 轮）`,
      String(arg.proposal || '').trim(),
      arg.proposalFrom === 'chair' ? '（这份提案就是议题原文，还没有人改过）' : `（这份是对 ${arg.proposalFrom} 提出的修订）`
    );
  }

  const hist = renderHistory(arg.history);
  if (hist) parts.push('', '【之前各轮的发言】', hist);
  else parts.push('', '（你是第一轮发言，还没有人说过话。）');

  parts.push('', analysis ? ANALYSIS_PROTOCOL : OUTPUT_PROTOCOL);
  return parts.join('\n');
}

/**
 * Text for the topic presentation round (round 0) —— this round **does not call a model**; it is the
 * server putting the question on the table, recorded as a role='chair' speech so the timeline in the
 * UI starts from "what the topic is".
 */
function buildBriefText(topic, materials) {
  const mats = renderMaterials(materials);
  return mats ? `${String(topic || '').trim()}\n\n【背景材料】\n${mats}` : String(topic || '').trim();
}

module.exports = {
  buildSpeechPrompt,
  buildBriefText,
  renderMaterials,
  renderHistory,
  OUTPUT_PROTOCOL,
  ANALYSIS_PROTOCOL,
};
