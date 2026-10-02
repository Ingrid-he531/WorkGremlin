/**
 * 议事厅「共识判定」自检 —— 纯函数，不起进程、不连库。
 *
 * 为什么先写它：议事厅最容易违反仓库铁律「不允许编造」的地方，就是最后那声「达成一致」。
 * 只要把判定交给模型自述（"我们都同意了"），就会出现"其实三分之二没答话，界面却报谈成了"。
 * 这里把口径钉死：**只数结构化投票**，没表态的一律不算同意，没人回话的一轮不可能算谈成。
 *
 * 跑法：`npm run test:council-consensus`
 */
'use strict';

const {
  VOTES,
  THRESHOLDS,
  normalizeVote,
  tally,
  isConsensus,
  pickProposal,
  decideRound,
  compareFloor,
} = require('../src/council/consensus');

let pass = 0;
let fail = 0;
function ok(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? `  — ${extra}` : ''}`);
  }
}
const head = (t) => console.log(`\n${t}`);

/** 一条发言记录；默认是"跑了、给了票" */
const u = (floorId, vote, extra = {}) => ({ floorId, vote, status: 'ok', ...extra });
/** 一条没跑成的发言记录（超时 / 崩 / 解析不出）；带上 vote 也不该被采信 */
const dead = (floorId, status = 'failed', vote = 'agree') => ({ floorId, vote, status });

// ---------------------------------------------------------------- 票型归一化
head('票型归一化：只认明确表达，认不出就是未表态（绝不猜方向）');
for (const raw of ['agree', 'AGREE', 'Agree', 'yes', '同意', '赞成', '支持']) {
  ok(`「${raw}」→ agree`, normalizeVote(raw) === VOTES.AGREE);
}
for (const raw of ['disagree', 'NO', 'reject', '反对', '不同意', '否决']) {
  ok(`「${raw}」→ disagree`, normalizeVote(raw) === VOTES.DISAGREE);
}
for (const raw of ['abstain', 'neutral', '弃权', '中立', '不表态']) {
  ok(`「${raw}」→ abstain`, normalizeVote(raw) === VOTES.ABSTAIN);
}
for (const raw of [null, undefined, '', '   ', '嗯……看情况吧', 'maybe', 0, {}, []]) {
  ok(`${JSON.stringify(raw)} → null（未表态）`, normalizeVote(raw) === null);
}
// 这一条是最容易写错的：「不反对」里同时有"反对"和"同意"的字面，混判会把弃权算成票
ok('「不反对」不被误判成 agree', normalizeVote('不反对') === null);

// -------------------------------------------------------------------- 数票
head('数票：失败的进程不该被采信，哪怕它带了 vote');
{
  const t = tally([u('1F', 'agree'), u('4F', 'disagree'), u('7F', 'abstain'), dead('8F')]);
  ok('seats 按发问人数算 = 4', t.seats === 4, JSON.stringify(t));
  ok('agree=1 / disagree=1 / abstain=1', t.agree === 1 && t.disagree === 1 && t.abstain === 1, JSON.stringify(t));
  ok('挂了的那条算未表态 = 1', t.invalid === 1);
}
{
  // 进程崩了但 stdout 里残留一个 "agree" —— 不能当成赞成票
  const t = tally([dead('1F', 'timeout', 'agree'), dead('4F', 'unparsed', 'agree')]);
  ok('超时/解析失败即便带 agree 也不算票', t.agree === 0 && t.invalid === 2, JSON.stringify(t));
}
{
  const t = tally([]);
  ok('空集不炸：seats=0', t.seats === 0 && t.invalid === 0, JSON.stringify(t));
  ok('空集不算一致（0 人的共识是无意义）', isConsensus(t) === false);
}
ok('非数组输入不炸', tally(null).seats === 0 && tally(undefined).seats === 0);

// -------------------------------------------------------- 判定：无反对 + 过半
head('判定（缺省 unanimous）：无反对 + 同意过半 + 无人没答话');
const U = THRESHOLDS.UNANIMOUS;
ok('4 人全同意 → 达成', isConsensus(tally([u('1F', 'agree'), u('4F', 'agree'), u('7F', 'agree'), u('8F', 'agree')]), U) === true);
ok('4 人 3 同意 1 反对 → 不达成', isConsensus(tally([u('1F', 'agree'), u('4F', 'agree'), u('7F', 'agree'), u('8F', 'disagree')]), U) === false);
ok('4 人 2 同意 2 弃权 → 达成（弃权不拖后腿，也不充数）', isConsensus(tally([u('1F', 'agree'), u('4F', 'agree'), u('7F', 'abstain'), u('8F', 'abstain')]), U) === true);
ok('4 人 1 同意 3 弃权 → 不达成（1 票没过半）', isConsensus(tally([u('1F', 'agree'), u('4F', 'abstain'), u('7F', 'abstain'), u('8F', 'abstain')]), U) === false);
ok('4 人全弃权 → 不达成（没人背书的东西不是共识）', isConsensus(tally([u('1F', 'abstain'), u('4F', 'abstain'), u('7F', 'abstain'), u('8F', 'abstain')]), U) === false);
ok('3 人 2 同意 1 弃权 → 达成', isConsensus(tally([u('1F', 'agree'), u('4F', 'agree'), u('7F', 'abstain')]), U) === true);
// 边界：口径是「同意票 ≥ 席位的半数」，**恰好半数也算**。2 人里 1 人同意 + 1 人明确弃权
// （不是没答话）→ 成立。这条容易被"过半 = 超过一半"的习惯读法写成不成立，所以专门钉一下。
ok('2 人 1 同意 1 弃权 → 达成（恰好半数）', isConsensus(tally([u('1F', 'agree'), u('4F', 'abstain')]), U) === true);
ok('5 人 3 同意 2 弃权 → 达成', isConsensus(tally([u('1F', 'agree'), u('4F', 'agree'), u('7F', 'agree'), u('8F', 'abstain'), u('9F', 'abstain')]), U) === true);
ok('认不出的口径按缺省处理', isConsensus(tally([u('1F', 'agree'), u('4F', 'agree')]), '胡说') === true);

// ----------------------------------------------------------- 铁律：缺席不算默许
head('铁律：没人答话的一轮，不能因为"没人反对"就算谈成了');
ok(
  '4 人 2 同意 2 超时 → 不达成（不知道的那两票不能当默许）',
  isConsensus(tally([u('1F', 'agree'), u('4F', 'agree'), dead('7F', 'timeout'), dead('8F', 'failed')]), U) === false
);
ok(
  '4 人 3 同意 1 失败 → 不达成（差一票就是差一票）',
  isConsensus(tally([u('1F', 'agree'), u('4F', 'agree'), u('7F', 'agree'), dead('8F')]), U) === false
);
ok('全员失败 → 不达成', isConsensus(tally([dead('1F'), dead('4F')]), U) === false);

// --------------------------------------------------------- 判定：少数服从多数
head('判定（majority）：同意 > 反对，同样要求无人没答话');
const M = THRESHOLDS.MAJORITY;
ok('4 人 3 同意 1 反对 → 达成', isConsensus(tally([u('1F', 'agree'), u('4F', 'agree'), u('7F', 'agree'), u('8F', 'disagree')]), M) === true);
ok('4 人 1 同意 1 反对 2 弃权 → 不达成（没有多数）', isConsensus(tally([u('1F', 'agree'), u('4F', 'disagree'), u('7F', 'abstain'), u('8F', 'abstain')]), M) === false);
ok('4 人 1 同意 1 反对 1 弃权 1 失败 → 不达成', isConsensus(tally([u('1F', 'agree'), u('4F', 'disagree'), u('7F', 'abstain'), dead('8F')]), M) === false);
ok('2 人 1 同意 1 反对 → 不达成（打平不算多数）', isConsensus(tally([u('1F', 'agree'), u('4F', 'disagree')]), M) === false);

// ------------------------------------------------------------ 下一轮上桌的提案
head('选下一轮的提案：附议最多者胜，并列取楼层号最小');
{
  const picked = pickProposal([
    u('4F', 'disagree', { proposal: '改成 A 方案' }),
    u('1F', 'disagree', { proposal: '改成 B 方案' }),
    u('7F', 'agree', { second: '1F' }),
    u('8F', 'agree', { second: '1F' }),
  ]);
  ok('被附议两次的那份胜出', picked && picked.floorId === '1F' && picked.text === '改成 B 方案', JSON.stringify(picked));
  ok('附议数如实记着', picked && picked.seconds === 2);
}
{
  const picked = pickProposal([
    u('7F', 'disagree', { proposal: '七楼的说法' }),
    u('1F', 'disagree', { proposal: '一楼的说法' }),
  ]);
  ok('无人附议 → 楼层号最小的赢（确定性，不挑"看着更好"的）', picked && picked.floorId === '1F', JSON.stringify(picked));
  ok('无人附议时 seconds=0', picked && picked.seconds === 0);
}
{
  const picked = pickProposal([
    u('8F', 'disagree', { proposal: '八楼的' }),
    u('4F', 'disagree', { proposal: '四楼的' }),
    u('1F', 'agree', { second: '8F' }),
    u('7F', 'agree', { second: '4F' }),
  ]);
  ok('一票对一票 → 回到楼层号裁决', picked && picked.floorId === '4F', JSON.stringify(picked));
}
{
  const picked = pickProposal([u('1F', 'disagree', { proposal: '自己附议自己', second: '1F' })]);
  ok('自己附议自己不算数（否则谁都能给自己刷一票）', picked && picked.seconds === 0);
}
{
  const picked = pickProposal([
    u('1F', 'disagree', { proposal: '' }),
    u('4F', 'disagree', { proposal: '   ' }),
    dead('7F', 'failed'),
  ]);
  ok('空提案 / 失败者的提案都不产生候选', picked === null);
}
ok('没有候选时返回 null（而不是编一份出来）', pickProposal([u('1F', 'agree')]) === null && pickProposal([]) === null && pickProposal(null) === null);
ok('失败的参与者即便写了提案也不算候选', pickProposal([dead('1F', 'timeout')]) === null);

head('楼层号排序');
ok("'1F' < '4F' < '7F' < '8F'", compareFloor('1F', '4F') < 0 && compareFloor('4F', '7F') < 0 && compareFloor('7F', '8F') < 0);
ok('两位数楼层不会被当字符串比', compareFloor('9F', '10F') < 0, `${compareFloor('9F', '10F')}`);

// ------------------------------------------------------------------ 整轮判定
head('整轮判定：达成 / 继续 / 到上限');
{
  const r = decideRound({ utterances: [u('1F', 'agree'), u('4F', 'agree')], maxRounds: 3, roundNo: 1 });
  ok('达成 → done，outcome=consensus', r.done === true && r.outcome === 'consensus' && r.consensus === true);
  ok('达成时不再挑下一轮的提案', r.nextProposal === null);
}
{
  const r = decideRound({
    utterances: [u('1F', 'disagree', { proposal: '改一版' }), u('4F', 'agree')],
    maxRounds: 3,
    roundNo: 1,
  });
  ok('未达成且没到上限 → 不 done', r.done === false && r.outcome === null);
  ok('带着下一轮要上桌的提案', r.nextProposal && r.nextProposal.text === '改一版');
}
{
  const r = decideRound({
    utterances: [u('1F', 'disagree', { proposal: '改一版' }), u('4F', 'agree')],
    maxRounds: 3,
    roundNo: 3,
  });
  ok('到上限仍分歧 → done，outcome=no_consensus', r.done === true && r.outcome === 'no_consensus');
  ok('未达成是**合法结果**，不是错误（不硬凑结论）', r.consensus === false && r.tally.disagree === 1);
}
{
  const r = decideRound({ utterances: [dead('1F'), dead('4F')], maxRounds: 2, roundNo: 2 });
  ok('全员失败 + 到上限 → no_consensus（不是 consensus）', r.outcome === 'no_consensus');
}
{
  const r = decideRound({ utterances: [u('1F', 'agree'), u('4F', 'agree')], maxRounds: 1, roundNo: 1 });
  ok('已达成的轮次不受上限影响', r.outcome === 'consensus');
}

console.log(`\n${fail ? '✗' : '✓'} council-consensus: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
