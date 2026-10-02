'use strict';

/**
 * 议事厅的提示词 —— 纯函数，不碰 IO（材料内容是调用方读好传进来的）。
 *
 * 参与者是**没有工具的**（见 agents.js）：它读不到文件、跑不了命令、上不了网。所以背景材料
 * 必须由服务端**原样塞进提示词**，它才知道该讨论什么；材料里没写的，它就无从得知 ——
 * 这一点要在提示词里对它讲明白，免得它拿训练数据里的印象当事实说。
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
      const stance = h.vote ? `［${h.vote === 'agree' ? '同意' : h.vote === 'disagree' ? '反对' : '弃权'}］` : '';
      const reason = h.voteReason ? `\n  理由：${h.voteReason}` : '';
      const proposal = h.proposal ? `\n  它建议：${h.proposal}` : '';
      return `- ${who}：${stance}\n  ${String(h.content || '').trim()}${reason}${proposal}`;
    });
    chunks.push(`第 ${roundNo} 轮：\n${lines.join('\n')}`);
  }
  return chunks.join('\n\n');
}

/** 所有参与者共用的那段"你是谁、你不能干什么"。每轮都带上，防止它在多轮里忘掉 */
function roleBlock(floorId, floorName) {
  return [
    `你是 WorkGremlin 议事厅里【${floorId} ${floorName}】这一层的代表，正在参加一场多方讨论。`,
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
 * 一轮的发言提示词。
 *
 * @param {{topic:string, materials:Array, proposal:string, proposalFrom:string,
 *          roundNo:number, maxRounds:number, history:Array,
 *          floorId:string, floorName:string}} arg
 * @returns {string}
 */
function buildSpeechPrompt(arg) {
  const parts = [roleBlock(arg.floorId, arg.floorName), '', '【议题】', String(arg.topic || '').trim()];

  const mats = renderMaterials(arg.materials);
  if (mats) parts.push('', '【背景材料】', mats);

  parts.push(
    '',
    `【现在要表决的提案】（第 ${arg.roundNo}/${arg.maxRounds} 轮）`,
    String(arg.proposal || '').trim(),
    arg.proposalFrom === 'chair' ? '（这份提案就是议题原文，还没有人改过）' : `（这份是对 ${arg.proposalFrom} 提出的修订）`
  );

  const hist = renderHistory(arg.history);
  if (hist) parts.push('', '【之前各轮的发言】', hist);
  else parts.push('', '（你是第一轮发言，还没有人说过话。）');

  parts.push('', OUTPUT_PROTOCOL);
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

module.exports = { buildSpeechPrompt, buildBriefText, renderMaterials, renderHistory, OUTPUT_PROTOCOL };
