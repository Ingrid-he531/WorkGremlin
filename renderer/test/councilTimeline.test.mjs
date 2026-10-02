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
  stanceKey,
  stanceCountsOf,
  normFindings,
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

/* ============================================================ 分析模式
 * 这一组盯的是分析模式那两个新字段。最容易出事的不是"读不到"，而是**把读不到当成读到了**：
 *   · 立场认不出 → 必须 'none'（未表态），绝不能拿别的场子里的 vote 顶上；
 *   · 要点解析不出（null）与"答了三条都空"（{}）**不是一回事**，界面上的话术不同；
 *   · DB 那条路给的是 JSON 字符串、WS 那条路给的是对象 —— 两种都要吃，否则
 *     "刷新前有要点、刷新后没了"。
 * 另外钉一条回归：表决模式那条路（tally / voteKey / vote）**逐字不许变**。 */
head('分析模式：立场归一，认不出就是未表态');
{
  const u = normUtterance({ roundNo: 1, floorId: '4F', stance: 'oppose', content: '我看不行' });
  ok('stance 认出来了', u.stance === 'oppose', String(u.stance));
  ok('没给 vote 时 vote 仍是 null（两条路互不冒充）', u.vote === null, String(u.vote));
  ok('stanceKey 认得三个值', stanceKey('support') === 'support' && stanceKey('oppose') === 'oppose' && stanceKey('unsure') === 'unsure');
  ok('认不出的立场 → none（未表态），不猜', stanceKey('maybe') === 'none' && stanceKey(null) === 'none' && stanceKey(undefined) === 'none');
  const bad = normUtterance({ roundNo: 1, floorId: '4F', stance: '支持' });
  ok('怪词不硬塞：stance 归一成 null', bad.stance === null, String(bad.stance));
  // 表决那套一字未动（分析模式的字段不该渗进 vote 的判定）
  const v = normUtterance({ roundNo: 1, floorId: '4F', vote: 'agree', stance: 'oppose' });
  ok('同一行里 vote 与 stance 各归各的，互不影响', v.vote === 'agree' && v.stance === 'oppose');
  ok('voteKey 回归：认不出仍是 none', voteKey('maybe') === 'none' && voteKey('agree') === 'agree');
}

head('分析模式：要点要同时吃 JSON 字符串与已解析对象');
{
  const fromDb = normFindings('{"points":["A"],"risks":["B"],"questions":["C"]}');
  ok('DB 那条路：JSON 字符串解析出来', fromDb && fromDb.points[0] === 'A' && fromDb.risks[0] === 'B' && fromDb.questions[0] === 'C', JSON.stringify(fromDb));
  const fromWs = normFindings({ points: ['A'], risks: ['B'], questions: ['C'] });
  ok('WS 那条路：对象直接用', fromWs && fromWs.points[0] === 'A', JSON.stringify(fromWs));
  ok('两条路归一成同一种形状（否则会出现"刷新一下要点就变了"）', JSON.stringify(fromDb) === JSON.stringify(fromWs));

  ok('null → null（"没说"）', normFindings(null) === null);
  ok('空串 → null', normFindings('') === null);
  ok('坏 JSON → null（不炸、也不当成空数组）', normFindings('{不是 json') === null, JSON.stringify(normFindings('{不是 json')));
  ok('数组不是我们要的形状 → null', normFindings('[1,2]') === null && normFindings('[]') === null);
  // 这一条是本次最容易被合并掉的区别
  const empty = normFindings('{"points":[],"risks":[],"questions":[]}');
  ok('三个空数组 → 不是 null（"答了，答的是没有"）', empty !== null, JSON.stringify(empty));
  ok('空数组那三条确实是空的', empty.points.length === 0 && empty.risks.length === 0 && empty.questions.length === 0);
  ok('缺的键补成空数组（不是 undefined）', JSON.stringify(normFindings('{"points":["A"]}')) === JSON.stringify({ points: ['A'], risks: [], questions: [] }));
  ok('非字符串元素与空白被丢掉，不硬转字符串',
    JSON.stringify(normFindings({ points: ['好', { o: 1 }, '   ', 42] }).points) === JSON.stringify(['好']));

  const u = normUtterance({ roundNo: 1, floorId: '4F', findings_json: '{"points":["来自库"]}' });
  ok('normUtterance 把 findings_json 一起归一了', u.findings && u.findings.points[0] === '来自库', JSON.stringify(u.findings));
  const w = normUtterance({ roundNo: 1, floorId: '4F', findings: { points: ['来自 WS'] } });
  ok('normUtterance 也吃 WS 的 findings 对象', w.findings && w.findings.points[0] === '来自 WS', JSON.stringify(w.findings));
}

head('分析模式：WS 增量合并不许把正文抹掉');
{
  // WS 是增量推送：先来正文，再来尾块。第二条里没提到的字段是 null，
  // 按"后到的赢"合并就会把正文抹成 null —— 界面上表现为"刷新一下正文就没了"。
  let list = mergeUtterance([], { roundNo: 1, floorId: '1F', content: '我的分析正文' });
  list = mergeUtterance(list, { roundNo: 1, floorId: '1F', stance: 'support', findings: { points: ['P'] } });
  ok('正文还在', list[0].content === '我的分析正文', String(list[0].content));
  ok('后到的立场与要点补上了', list[0].stance === 'support' && list[0].findings.points[0] === 'P');
  // 反过来：尾块先到、正文后到
  let list2 = mergeUtterance([], { roundNo: 1, floorId: '1F', stance: 'oppose', findings: { points: ['Q'] } });
  list2 = mergeUtterance(list2, { roundNo: 1, floorId: '1F', content: '正文晚一步到' });
  ok('先到的要点不被后到的正文抹掉', list2[0].findings.points[0] === 'Q' && list2[0].stance === 'oppose', JSON.stringify(list2[0].findings));
}

head('分析模式的立场汇总：口径与票型那套一致（chair 不占席位、未表态单列）');
{
  const t = stanceCountsOf([
    { roundNo: 1, floorId: 'chair', role: 'chair' },
    { roundNo: 1, floorId: '1F', status: 'ok', stance: 'support' },
    { roundNo: 1, floorId: '4F', status: 'ok', stance: 'oppose' },
    { roundNo: 1, floorId: '7F', status: 'ok', stance: 'unsure' },
    { roundNo: 1, floorId: '8F', status: 'timeout', stance: null },
  ].map(normUtterance));
  ok('主席不占席位（4 人而不是 5 人）', t.seats === 4, String(t.seats));
  ok('支持 1 / 反对 1 / 不确定 1', t.support === 1 && t.oppose === 1 && t.unsure === 1);
  ok('超时的那位算未表态', t.none === 1, String(t.none));
  ok('四档加起来等于席位（没漏算）', t.support + t.oppose + t.unsure + t.none === t.seats);
  // 说了话但没给出立场（unparsed）也落进未表态 —— 它确实没表态，只是原因不同
  const t2 = stanceCountsOf([{ roundNo: 1, floorId: '1F', status: 'unparsed', stance: null }].map(normUtterance));
  ok('没按约定给出立场（unparsed）也算未表态', t2.none === 1, JSON.stringify(t2));
  ok('空输入不炸', stanceCountsOf([]).seats === 0 && stanceCountsOf(null).seats === 0);
}

head('groupByRound 多挂了一个 stanceTally（加字段，不是改字段）');
{
  const g = groupByRound([
    { roundNo: 1, floorId: '1F', status: 'ok', vote: 'agree', stance: 'support' },
    { roundNo: 1, floorId: '4F', status: 'ok', vote: 'disagree', stance: 'oppose' },
  ].map(normUtterance));
  ok('stanceTally 在', Boolean(g[0].stanceTally));
  ok('它数的是立场', g[0].stanceTally.support === 1 && g[0].stanceTally.oppose === 1);
  // 回归：表决那条路的分组结果逐字不变（分析字段是**加**出来的，没动旧的）
  ok('tally 仍然是票型那一份（没被立场污染）', g[0].tally.agree === 1 && g[0].tally.disagree === 1, JSON.stringify(g[0].tally));
  ok('分组形状里的键只多了 stanceTally', Object.keys(g[0]).sort().join() === 'roundNo,stanceTally,tally,utterances', Object.keys(g[0]).join());
}

head('回归：分析模式的行不许影响表决那套');
{
  // 一场"老库里的表决会"——没有 mode、没有 stance、没有 findings。所有旧口径必须原样成立
  const rows = [
    { round_no: 0, floor_id: 'chair', role: 'chair', content: '议题' },
    { round_no: 1, floor_id: '1F', role: 'speaker', status: 'ok', vote: 'agree', vote_reason: '可以' },
    { round_no: 1, floor_id: '4F', role: 'speaker', status: 'ok', vote: 'disagree', proposal_text: '换方案 B' },
  ].map(normUtterance);
  ok('票型照旧（同意 1 反对 1，主席不占席位）', JSON.stringify(tallyOf(rows.filter((u) => u.roundNo === 1))) === JSON.stringify({ seats: 2, agree: 1, disagree: 1, abstain: 0, invalid: 0 }));
  ok('没给 stance 的老行读出 null（不是别的）', rows.every((u) => u.stance === null));
  ok('没给 findings 的老行读出 null', rows.every((u) => u.findings === null));
  ok('立场汇总里老行全算未表态（它们确实没表过态）', stanceCountsOf(rows.filter((u) => u.roundNo === 1)).none === 2);
}

console.log(`\n${fail ? '✗' : '✓'} council-timeline: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
