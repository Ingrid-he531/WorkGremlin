'use strict';

/**
 * 议事厅的提示词 —— 纯函数，不碰 IO（材料内容是调用方读好传进来的）。
 *
 * 参与者能干什么，取决于**在哪儿谈**（见 agents.js）：
 *   · 隔离模式（工作目录 = 服务端现建的一次性临时目录）—— 它没有工具，读不到文件、跑不了
 *     命令、上不了网。所以背景材料必须由服务端**原样塞进提示词**，它才知道该讨论什么；
 *   · 工程模式（工作目录 = 用户的真实工程）—— 它有一套**只读**工具，可以自己去翻代码。
 *
 * 两种情况下都要把"你不知道什么"讲明白，免得它拿训练数据里的印象当事实说。
 *
 * 另外，一场会两种谈法（councils.mode）：'vote' 表决（提案 + 数票判共识）、
 * 'analysis' 分析（不投票，各写各的分析与风险，服务端不合成结论）。
 *
 * 另外要把"输出协议"写死，并且**由我们给出的例子本身带上围栏**：模型最爱模仿提示词里的
 * 格式，把例子写成它该交的样子，比用文字描述一遍可靠得多（解析端按"最后一个 JSON 块"取，
 * 见 agents.js 的 parseVoteBlock，所以中间出现的例子不会被误当结论）。
 */

/** 材料拼成一段文本；超限截断的事实必须写出来（谁看了都要知道给的内容不是全的） */
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

/** 表决模式的票型 → 中文（历史里给参与者看的那一版） */
const VOTE_ZH = { agree: '同意', disagree: '反对', abstain: '弃权' };
/** 分析模式的立场 → 中文 */
const STANCE_ZH = { support: '支持', oppose: '反对', unsure: '不确定' };

/** 前几轮发言按轮次列出。空历史返回 ''（第 1 轮没有人说过话） */
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
      // 分析模式认 stance，表决模式认 vote —— 两种场子的发言都可能出现在历史里，
      // 按谁来就标谁，都没有就不标（不猜立场）
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

/** 分析模式的结构化要点，拼成提示词里的三行。没给（null）就一个字都不加 */
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
 * 所有参与者共用的那段"你是谁、你不能干什么"。每轮都带上，防止它在多轮里忘掉。
 *
 * 两档（`workspace` 有没有值），**能力边界必须说准**：说了"能读代码"它就会去读，
 * 说了"什么都没有"它就只能拿材料说话。说岔了它的行为就跟着岔。
 * @param {string} floorId
 * @param {string} floorName
 * @param {string|null} [workspace] 工作目录；空 = 隔离模式（无工具）
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

/** 输出协议。例子带上围栏，模型照抄格式最稳 */
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
 * 分析模式的输出协议。**没有投票、没有提案、没有共识** —— 服务端不会去数票，
 * 也不会替它们合成一句结论；这里要的是"每人各自的分析"和"分歧在哪"。
 * 同样把例子带上围栏：模型照抄提示词里的格式，比用文字描述一遍可靠得多。
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
 * 一轮的发言提示词。
 *
 * @param {{topic:string, materials:Array, proposal?:string, proposalFrom?:string,
 *          roundNo:number, maxRounds:number, history:Array,
 *          floorId:string, floorName:string,
 *          mode?:'vote'|'analysis', workspace?:string|null}} arg
 *   mode 缺省按 'vote'（老调用方不必改）；proposal / proposalFrom 只有表决模式用得上。
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

  // 工作目录写在议题下面：工程模式下这是它"该去哪儿找答案"的唯一线索
  if (arg.workspace) parts.push('', '【工作目录】', String(arg.workspace));

  const mats = renderMaterials(arg.materials);
  if (mats) parts.push('', '【背景材料】', mats);

  if (analysis) {
    // 分析模式没有"桌上那份提案"这回事 —— 摆出来的只有议题本身
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
 * 议题陈述轮（第 0 轮）的文本 —— 这一轮**不调模型**，是服务端把题目摆上桌，
 * 落成一条 role='chair' 的发言，好让界面上的时间线从"议题是什么"开始。
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
