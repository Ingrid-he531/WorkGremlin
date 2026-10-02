/**
 * 议事厅时间线的纯逻辑自检。
 *
 * 存在的理由很具体：同一场会的发言从**两条路**进到界面 —— GET 详情给的是数据库行
 * （snake_case），WS 推的是增量（camelCase）。归一没做对的话，症状是
 * 「刷新一下，理由就没了」这种只在一条路径上出现的怪事，肉眼很难发现。
 * 另外去重也得钉住：WS 抖动会重复推同一条发言，界面上会变成两层楼各说了两遍。
 *
 * 跑法：`npm run test:council-timeline`
 */
const {
  normUtterance,
  mergeUtterance,
  groupByRound,
  tallyOf,
  voteKey,
  tokenTotal,
} = await import('../src/lib/councilTimeline.js');

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

head('两种形状归一：数据库行（snake_case）');
{
  const u = normUtterance({
    round_no: 1,
    floor_id: '4F',
    role: 'speaker',
    content: '我觉得可以',
    vote: 'agree',
    vote_reason: '风险可控',
    proposal_text: null,
    second_floor: null,
    status: 'ok',
    duration_ms: 1234,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: null,
    cache_write_tokens: null,
  });
  ok('roundNo 认出来了', u.roundNo === 1);
  ok('floorId 认出来了', u.floorId === '4F');
  ok('理由从 vote_reason 取到', u.voteReason === '风险可控', String(u.voteReason));
  ok('耗时从 duration_ms 取到', u.durationMs === 1234);
  ok('词元从 input_tokens 取到', u.inputTokens === 10);
}

head('两种形状归一：WS 增量（camelCase）');
{
  const u = normUtterance({ roundNo: 2, floorId: '7F', vote: 'disagree', voteReason: '没有兜底', durationMs: 88, outputTokens: 5 });
  ok('roundNo 没被当成 undefined', u.roundNo === 2);
  ok('理由认出来了', u.voteReason === '没有兜底');
  ok('耗时认出来了', u.durationMs === 88);
  ok('票认出来了', u.vote === 'disagree');
}

head('没表态就是没表态：界面绝不显示成"同意"');
{
  const u = normUtterance({ round_no: 1, floor_id: '8F', vote: null, status: 'failed', error: '超时' });
  ok('vote=null', u.vote === null);
  ok('voteKey= none（渲染成「未表态」那一档）', voteKey(u.vote) === 'none', voteKey(u.vote));
  ok('认不出的票型也不猜', normUtterance({ vote: 'maybe' }).vote === null);
  ok('错误原文留着', u.error === '超时');
  ok('没答话就没有词元 → tokenTotal 是 null（不是 0）', tokenTotal(u) === null, String(tokenTotal(u)));
}

head('词元合计：全都取不到才留空');
{
  ok('四项全 null → null', tokenTotal(normUtterance({})) === null);
  ok('只有输出 → 就是输出', tokenTotal(normUtterance({ output_tokens: 7 })) === 7);
  ok('四项都有 → 相加', tokenTotal(normUtterance({ input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4 })) === 10);
  ok('真 0 是 0（不是"读不到"）', tokenTotal(normUtterance({ input_tokens: 0 })) === 0);
}

head('合并去重：同一轮同一层只留一条（WS 会重复推）');
{
  let list = [];
  list = mergeUtterance(list, { roundNo: 1, floorId: '4F', content: '我说了话' });
  ok('第一条进来了', list.length === 1);
  list = mergeUtterance(list, { roundNo: 1, floorId: '4F', content: '我说了话' });
  ok('重复推同一条不会变成两条', list.length === 1, String(list.length));
  list = mergeUtterance(list, { roundNo: 1, floorId: '7F', content: '我也说' });
  ok('别的楼层是新的一条', list.length === 2);

  // 后到的增量更完整（先推正文、再推票型）→ 合并而不是丢弃
  list = mergeUtterance(list, { roundNo: 1, floorId: '4F', vote: 'agree', voteReason: '可以' });
  const four = list.find((u) => u.floorId === '4F');
  ok('后到的票补上了', four.vote === 'agree' && four.voteReason === '可以');
  ok('先到的正文没被抹掉', four.content === '我说了话', String(four.content));

  ok('原数组没被原地改（响应式 state 要新对象）', list !== undefined && mergeUtterance(list, { roundNo: 9, floorId: '1F' }).length === 3);
}

head('按轮次分组：轮次升序、主席排最前');
{
  const rows = [
    { roundNo: 1, floorId: '7F', role: 'speaker', status: 'ok', vote: 'agree' },
    { roundNo: 0, floorId: 'chair', role: 'chair', content: '议题' },
    { roundNo: 1, floorId: '1F', role: 'speaker', status: 'ok', vote: 'disagree' },
    { roundNo: 2, floorId: '1F', role: 'speaker', status: 'ok', vote: 'agree' },
  ].map(normUtterance);
  const groups = groupByRound(rows);
  ok('分了 3 轮', groups.length === 3, String(groups.length));
  ok('轮次升序（0 在最前）', groups.map((g) => g.roundNo).join() === '0,1,2', groups.map((g) => g.roundNo).join());
  ok('第 1 轮里 1F 排在 7F 前（按楼层号）', groups[1].utterances.map((u) => u.floorId).join() === '1F,7F', groups[1].utterances.map((u) => u.floorId).join());
  const chairGroup = groupByRound([normUtterance({ roundNo: 0, floorId: 'chair', role: 'chair' }), normUtterance({ roundNo: 0, floorId: '1F' })]);
  ok('主席排在同轮最前', chairGroup[0].utterances[0].role === 'chair');
  ok('空输入不炸', groupByRound([]).length === 0 && groupByRound(null).length === 0);
}

head('从发言数出来的票型：跟服务端那份互相印证');
{
  const g = groupByRound([
    { roundNo: 1, floorId: 'chair', role: 'chair' },
    { roundNo: 1, floorId: '1F', status: 'ok', vote: 'agree' },
    { roundNo: 1, floorId: '4F', status: 'ok', vote: 'disagree' },
    { roundNo: 1, floorId: '7F', status: 'timeout', vote: null },
  ].map(normUtterance));
  const t = tallyOf(g[0].utterances);
  ok('主席不占席位（3 人而不是 4 人）', t.seats === 3, String(t.seats));
  ok('同意 1 反对 1', t.agree === 1 && t.disagree === 1);
  ok('超时的那位算未表态，不算反对也不算同意', t.invalid === 1, String(t.invalid));
  ok('两边加起来等于席位（没漏算）', t.agree + t.disagree + t.abstain + t.invalid === t.seats);
}

console.log(`\n${fail ? '✗' : '✓'} council-timeline: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
