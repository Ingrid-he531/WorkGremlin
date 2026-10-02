'use strict';

/**
 * 议事厅的**共识判定** —— 纯函数：不碰 IO、不碰数据库、不起进程。
 *
 * 为什么单独拆出来、还要用纯函数写：仓库的铁律是「不允许编造」（docs/requirements.md §1）。
 * 议事厅最容易踩线的地方就是"最后达成一致"这一下 —— 让模型自己说一句「我们都同意」是最省事的
 * 做法，也是最能骗人的做法。所以这里不认模型的自述，只数**结构化投票**；数不出来就如实说
 * 「未达成一致」。这一段单独成文件，是为了让它能被逐条用例钉住。
 *
 * 词的口径（全仓库统一，别处要用同一套）：
 *   · 出席（seats）—— 这一场选了几个楼层，就几个座位。**缺席也是出席**，不因失败而缩水，
 *     否则"三个人里两个挂了、剩下那个同意"会被算成一致。
 *   · 有效票 —— status='ok' 且票型解析得出来的那些。解析不出来 = 未表态。
 *   · 未表态（invalid）—— 超时 / 进程失败 / 输出解析不出。**它既不算同意也不算反对**，
 *     但会让本轮**达不成一致**：没人回话的一轮不可能算谈成了。
 */

/** 三种票。弃权是**明确表了态**的（"我不反对，但也不背书"），跟"没表态"不是一回事。 */
const VOTES = Object.freeze({
  AGREE: 'agree',
  DISAGREE: 'disagree',
  ABSTAIN: 'abstain',
});

/** 两种判定口径 */
const THRESHOLDS = Object.freeze({
  /** 缺省：无反对 + 同意过半数 + 无人没答话 */
  UNANIMOUS: 'unanimous',
  /** 少数服从多数：同意 > 反对 + 无人没答话 */
  MAJORITY: 'majority',
});

/**
 * 模型给的票型五花八门，这里只认**明确**的表达，认不出来一律 null（未表态）。
 * 宁可判「没表态」也不能猜 —— 猜错方向会把"其实没谈成"报成"谈成了"。
 *
 * @param {unknown} raw
 * @returns {'agree'|'disagree'|'abstain'|null}
 */
function normalizeVote(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  // 中文 / 英文 / 常见同义词都收；顺序有讲究：先判"弃权"再判"同意"，
  // 因为「不反对」这种写法里同时含"反对"和"同意"的字面，混判会把弃权算成票。
  if (/^(abstain|neutral|none|弃权|中立|不表态|无所谓)$/.test(s)) return VOTES.ABSTAIN;
  if (/^(agree|yes|approve|accept|同意|赞成|支持|通过)$/.test(s)) return VOTES.AGREE;
  if (/^(disagree|no|reject|oppose|反对|不同意|否决)$/.test(s)) return VOTES.DISAGREE;
  return null;
}

/**
 * 数票。**只数票，不下结论** —— 结论在 isConsensus 里，两件事分开好测。
 *
 * @param {Array<{vote?:unknown, status?:string}>} utterances 本轮每人的输出（含失败的那几条）
 * @returns {{seats:number, agree:number, disagree:number, abstain:number, invalid:number}}
 *   seats 是这一轮实际发问的人数（= 出席）；invalid 是没给出有效表态的人数。
 */
function tally(utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  let agree = 0;
  let disagree = 0;
  let abstain = 0;
  for (const u of list) {
    // 进程没跑成（超时/崩/解析不出）→ 未表态，无论它带了什么 vote 字段都不认
    const status = (u && u.status) || 'ok';
    const vote = status === 'ok' ? normalizeVote(u && u.vote) : null;
    if (vote === VOTES.AGREE) agree += 1;
    else if (vote === VOTES.DISAGREE) disagree += 1;
    else if (vote === VOTES.ABSTAIN) abstain += 1;
  }
  const seats = list.length;
  return { seats, agree, disagree, abstain, invalid: seats - agree - disagree - abstain };
}

/**
 * 判定本轮是否达成一致。
 *
 * **两种口径都要求「无人未表态」**：有人没答话的那一轮不能算谈成了 —— 这不是严苛，
 * 是"不编造"的直接推论：缺席者的立场我们**不知道**，把不知道当成默许就是替它编了一个立场。
 * 一个人挂了导致本轮不算数，比拿 3 票冒充 4 票的共识要诚实得多；下一轮会重问。
 *
 * @param {{seats:number,agree:number,disagree:number,abstain:number,invalid:number}} t
 * @param {string} [threshold] 见 THRESHOLDS；认不出的值按缺省 UNANIMOUS 处理
 * @returns {boolean}
 */
function isConsensus(t, threshold) {
  if (!t || t.seats <= 0) return false;
  if (t.invalid > 0) return false; // 有人没表态 → 本轮不成立（两种口径都一样）
  // majority 口径下**有反对票是正常的** —— 别把 disagree 的检查提到这上面来，
  // 那会把「3 同意 1 反对」也毙掉，少数服从多数就没意义了。
  if (threshold === THRESHOLDS.MAJORITY) return t.agree > t.disagree;
  if (t.disagree > 0) return false; // unanimous：有任何反对就不成立
  // 缺省 unanimous：同意的要**够半数**（弃权不算同意，但也不拖后腿）。
  // 边界取「恰好半数也算」：2 人有 1 人同意、另一人明确弃权（没反对）→ 成立。
  // 全弃权 → agree=0 → 不成立：没人背书的东西不叫共识。
  return t.agree * 2 >= t.seats;
}

/**
 * 下一轮拿谁的修订案上桌。
 *
 * 规则（机械、确定性、界面要如实写出来）：
 *   1. 候选 = 投反对票者提交的修订案（没提交的反对者不产生候选）；
 *   2. 取**被附议最多**的那一份 —— 附议 = 本轮有人在结构化块里点名 second 了这个楼层；
 *   3. 并列 / 无人附议 → 按**楼层号升序**取第一个（确定性；不挑"看起来更好"的那份）。
 *
 * 为什么不让服务端"挑一份最好的"：那等于服务端下场替参与者写提案，越过了"不编造"。
 * 这里的每一步都只用参与者自己给出的字段。
 *
 * @param {Array<{floorId:string, status?:string, proposal?:string, second?:string}>} utterances
 * @returns {{floorId:string, text:string, seconds:number}|null} 没有可用候选时返回 null
 */
function pickProposal(utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  const byFloor = new Map();
  for (const u of list) {
    if (u && u.floorId) byFloor.set(String(u.floorId), u);
  }
  // 附议计数：只认"点名了某个参选楼层"的那些，自己附议自己不算
  const seconds = new Map();
  for (const u of list) {
    const target = u && u.second != null ? String(u.second) : '';
    if (!target) continue;
    if (u.floorId && String(u.floorId) === target) continue;
    seconds.set(target, (seconds.get(target) || 0) + 1);
  }

  let best = null;
  for (const [floorId, u] of byFloor) {
    if ((u.status || 'ok') !== 'ok') continue;
    const text = typeof u.proposal === 'string' ? u.proposal.trim() : '';
    if (!text) continue;
    const candidate = { floorId, text, seconds: seconds.get(floorId) || 0 };
    if (best == null) {
      best = candidate;
      continue;
    }
    if (candidate.seconds > best.seconds) best = candidate;
    // 并列（含都不被附议）→ 楼层号小的赢，保证同一批输入永远得到同一个结果
    else if (candidate.seconds === best.seconds && compareFloor(candidate.floorId, best.floorId) < 0) {
      best = candidate;
    }
  }
  return best;
}

/** 楼层号排序：'1F' < '4F' < '7F' < '8F'；认不出的排后面并退化成字符串比较 */
function compareFloor(a, b) {
  const na = parseInt(String(a), 10);
  const nb = parseInt(String(b), 10);
  const okA = Number.isFinite(na);
  const okB = Number.isFinite(nb);
  if (okA && okB && na !== nb) return na - nb;
  if (okA !== okB) return okA ? -1 : 1;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * 一轮的完整判定：数票 + 定共识 + 挑下一轮的提案。编排器直接用它。
 *
 * @param {{utterances:Array, threshold?:string, maxRounds:number, roundNo:number}} args
 *   roundNo 是**本轮**的序号（从 1 起）；maxRounds 是讨论轮上限。
 * @returns {{tally:object, consensus:boolean, nextProposal:object|null, done:boolean, outcome:string|null}}
 *   done=true 表示这场会到此为止；outcome 取 'consensus' / 'no_consensus'；没结束则是 null。
 */
function decideRound({ utterances, threshold, maxRounds, roundNo }) {
  const t = tally(utterances);
  const consensus = isConsensus(t, threshold);
  if (consensus) {
    return { tally: t, consensus: true, nextProposal: null, done: true, outcome: 'consensus' };
  }
  const exhausted = !Number.isFinite(maxRounds) || roundNo >= maxRounds;
  if (exhausted) {
    return { tally: t, consensus: false, nextProposal: null, done: true, outcome: 'no_consensus' };
  }
  return {
    tally: t,
    consensus: false,
    nextProposal: pickProposal(utterances),
    done: false,
    outcome: null,
  };
}

module.exports = { VOTES, THRESHOLDS, normalizeVote, tally, isConsensus, pickProposal, decideRound, compareFloor };
