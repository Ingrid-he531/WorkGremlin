/**
 * 议事厅「一场会怎么跑完」自检 —— 真 SQLite + 真 repo + 真临时目录，**只有参与者是假的**。
 *
 * 假的只是"跑一个外部 CLI"那一下（`deps.runTurn`），其余全是真件：状态机、落库、计票、
 * 目录隔离、广播、取消与关服。这么切是因为真机跑一场会要花几十秒和一次模型调用，而且
 * 结果每次都不一样 —— 没法拿它钉"有人挂了会怎样""谈不拢会怎样"。真 CLI 的对接放在第 7 步
 * 的烟测里（唯一一次真调外部命令的地方）。
 *
 * 盯的是这个状态机最容易骗人的几处：
 *   · **有人没答话的一轮不算谈成** —— 拿三个人的意见冒充四个人的共识是最难发现的作弊；
 *   · **失败 / 没表态一律留空**，不替它补一个立场（铁律：不允许编造）；
 *   · **谈不拢就报谈不拢**，服务端不合成一份"结论"；
 *   · 取消 / 关服之后**不再往下推进**，临时目录清干净，库里不留"永远在讨论"的会。
 *
 * 跑法：`npm run test:council-orchestrator`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WS_EVENTS } = require('@workgremlin/shared');

const { openDatabase } = require('../src/db');
const { createCouncilOrchestrator, TMP_PREFIX } = require('../src/council/orchestrator');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-council-orch-'));
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));

let clock = 1_700_000_000_000;
const now = () => (clock += 1_000);

/* ---------------------------------- 假参与者 ---------------------------------- */

/** 一段带投票块的发言（参与者被要求交的形状） */
const says = (vote, extra = {}) => `这是我的看法。\n\n\`\`\`json\n${JSON.stringify({ vote, ...extra })}\n\`\`\`\n`;
/** 一次成功的调用 */
const OK = (text, tokens = null) => ({ status: 'ok', text, tokens, error: null, durationMs: 5, exitCode: 0 });

function makeHarness() {
  /** 每次调用记录：哪一层、第几轮、提示词是什么、跑在哪个目录 */
  const seen = [];
  /** 挂住的那些调用（测取消 / 关服用）：release 一下就当"进程被杀，调用返回了" */
  const held = [];
  const replies = new Map();
  let hold = false;

  /** 假的子进程句柄。pid 取一个不可能存在的值，killTree 会静默失败（真杀进程由 runner 的用例验） */
  const fakeChild = () => ({ pid: 2 ** 30, killed: false, once() {} });

  async function runTurn(arg) {
    const floor = String(arg.bin).split('/').pop();
    const prompt = arg.stdin != null ? arg.stdin : String(arg.args[1] || '');
    const m = prompt.match(/第 (\d+)\/(\d+) 轮/);
    const round = m ? Number(m[1]) : 0;
    if (typeof arg.onChild === 'function') arg.onChild(fakeChild());
    seen.push({ floor, round, prompt, cwd: arg.cwd, agent: arg.agent });

    const answer = () => {
      const spec = replies.get(floor);
      const out = typeof spec === 'function' ? spec({ floor, round, prompt }) : spec;
      return out || OK(says('agree'));
    };
    if (hold) return new Promise((resolve) => held.push(() => resolve(answer())));
    return answer();
  }

  return {
    runTurn,
    seen,
    held,
    set: (floor, spec) => replies.set(floor, spec),
    all: (spec) => {
      for (const f of ['1F', '4F', '7F', '8F']) replies.set(f, spec);
    },
    startHolding: () => {
      hold = true;
    },
    /** 放开所有挂住的调用：模拟这些进程被杀掉后 runOnce 返回 */
    release: () => {
      const list = held.splice(0);
      for (const r of list) r();
    },
    roundsAsked: (floor) => seen.filter((s) => s.floor === floor).length,
  };
}

const broadcasts = [];
const mkOrchestrator = (h) =>
  createCouncilOrchestrator({
    repo,
    broadcast: (project, type, payload) => broadcasts.push({ project, type, payload }),
    deps: {
      runTurn: h.runTurn,
      now,
      cliPathOf: (floorId) => `/fake/${floorId}`,
      // 真建目录、真删目录，只是挪到本用例自己的临时根下，好断言"用完确实删了"并收得干净
      mkdtemp: (prefix) => fs.mkdtempSync(path.join(TMP, prefix)),
    },
  });

/** 建一场会 + 出席者。cliPath 传 null 的走 cliPathOf 兜底 */
function newCouncil(id, floors, { maxRounds = 2, threshold = 'unanimous', cliPath = null } = {}) {
  repo.createCouncil({ id, topic: `议题 ${id}`, threshold, maxRounds, createdAt: now() });
  for (const f of floors) repo.insertParticipant({ councilId: id, floorId: f, agent: 'x', cliPath });
  return id;
}

const waitFor = async (cond, ms = 3_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

(async () => {
  // ============================================================ 谈成了
  head('全员同意：一轮达成，结论就是桌上那份提案原文');
  {
    const h = makeHarness();
    h.all(OK(says('agree', { reason: '可行' })));
    const id = newCouncil('cA', ['1F', '4F', '7F'], { maxRounds: 3 });
    const orch = mkOrchestrator(h);
    const row = await orch.start(id);

    ok('verdict=consensus', row.verdict === 'consensus', String(row.verdict));
    ok('status=done', row.status === 'done', row.status);
    ok('verdict_round=1（第一轮就谈成了）', row.verdict_round === 1, String(row.verdict_round));
    ok('round_current 停在 1', row.round_current === 1, String(row.round_current));

    const rounds = repo.listRounds(id);
    ok('两轮：第 0 轮议题陈述 + 第 1 轮讨论', rounds.length === 2 && rounds[0].round_no === 0 && rounds[1].round_no === 1, JSON.stringify(rounds.map((r) => r.round_no)));
    ok('第 0 轮 kind=brief（服务端陈述，不调模型）', rounds[0].kind === 'brief');
    ok('第 1 轮 3 票同意、0 反对、0 未表态', rounds[1].agree === 3 && rounds[1].disagree === 0 && rounds[1].invalid === 0, JSON.stringify(rounds[1]));
    ok('第 1 轮记了 consensus=1', rounds[1].consensus === 1);
    ok('结论 = 本轮桌上那份提案**原文**（服务端不合成、不改写）', rounds[1].proposal_text === '议题 cA', String(rounds[1].proposal_text));

    const utts = repo.listUtterances(id);
    ok('发言：1 条主席陈述 + 3 条参与者', utts.length === 4, String(utts.length));
    ok('主席那条是 round 0 / role=chair', utts[0].round_no === 0 && utts[0].role === 'chair');
    ok('三条参与者发言都落库了票', utts.filter((u) => u.round_no === 1).every((u) => u.vote === 'agree' && u.status === 'ok'));

    ok('谈成了就不再往下问（只问了 3 次）', h.seen.length === 3, String(h.seen.length));
    ok('出席者状态都成了 ok', repo.listParticipants(id).every((p) => p.status === 'ok'), JSON.stringify(repo.listParticipants(id).map((p) => p.status)));

    ok('参与者跑在一次性临时目录里（前缀好认）', h.seen[0].cwd.includes(TMP_PREFIX), h.seen[0].cwd);
    ok('散会就把目录删了', fs.existsSync(h.seen[0].cwd) === false, h.seen[0].cwd);
    ok('跑完不在在飞表里', orch.activeIds().length === 0, JSON.stringify(orch.activeIds()));

    ok('广播走的是 council.update 事件', broadcasts.length > 0 && broadcasts.every((b) => b.type === WS_EVENTS.COUNCIL));
    ok('广播是全局的（议事厅不挂工程，project=null）', broadcasts.every((b) => b.project === null));
    ok('收尾那条广播带上了 verdict', broadcasts.at(-1).payload.verdict === 'consensus', JSON.stringify(broadcasts.at(-1).payload));
  }

  // ============================================================ 谈不成 → 换提案 → 下一轮
  head('有人反对：拿附议最多的修订案上桌，下一轮继续');
  {
    const h = makeHarness();
    h.set('1F', OK(says('agree')));
    h.set('4F', ({ round }) => (round === 1 ? OK(says('disagree', { reason: '风险没兜底', proposal: '改成 B 方案' })) : OK(says('agree'))));
    // 7F 自己提了 C 方案，但明确附议 4F 的 —— 4F 应赢
    h.set('7F', ({ round }) => (round === 1 ? OK(says('disagree', { reason: '我也觉得要改', proposal: '改成 C 方案', second: '4F' })) : OK(says('agree'))));
    h.set('8F', ({ round }) => (round === 1 ? OK(says('disagree', { reason: '附议 4F', second: '4F' })) : OK(says('agree'))));

    const id = newCouncil('cB', ['1F', '4F', '7F', '8F'], { maxRounds: 3 });
    const orch = mkOrchestrator(h);
    const row = await orch.start(id);

    ok('第二轮才谈成', row.verdict === 'consensus' && row.verdict_round === 2, `${row.verdict}/${row.verdict_round}`);

    const rounds = repo.listRounds(id);
    const r1 = rounds.find((r) => r.round_no === 1);
    const r2 = rounds.find((r) => r.round_no === 2);
    ok('第 1 轮 1 同意 3 反对 → 不成立', r1.agree === 1 && r1.disagree === 3 && r1.consensus === 0, JSON.stringify(r1));
    ok('第 2 轮桌上是 4F 的修订案', r2.proposal_text === '改成 B 方案', String(r2.proposal_text));
    ok('并记着它是谁提的（界面要能说"这是 4F 的修订"）', r2.proposal_from === '4F', String(r2.proposal_from));
    ok('第 2 轮提案**不是**附议少的那份（7F 的 C 方案落选）', r2.proposal_text !== '改成 C 方案');
    ok('每一轮的提案都单独存档（第 1 轮还是议题原文，可回溯）', r1.proposal_text === '议题 cB' && r1.proposal_from === 'chair');

    const p2 = h.seen.find((s) => s.round === 2);
    ok('第二轮提示词里带着上一轮的发言（多轮互见）', p2.prompt.includes('第 1 轮'), '提示词里没有第 1 轮');
    ok('并点明这是对 4F 提出的修订', p2.prompt.includes('对 4F 提出的修订'));
    ok('上一轮各人的立场传下去了', p2.prompt.includes('［同意］') && p2.prompt.includes('［反对］'));
    ok('楼层用名字称呼（不是光甩个编号）', p2.prompt.includes('Claude Code'), '提示词里没有楼层名');
    ok('反对方给的修订案也传给了下一轮', p2.prompt.includes('改成 B 方案') && p2.prompt.includes('改成 C 方案'));
  }

  // ============================================================ 谈不拢
  head('到轮数上限仍分歧：如实报"未达成"，不硬凑一个结论');
  {
    const h = makeHarness();
    let n = 0;
    h.all(() => {
      n += 1;
      return OK(says('disagree', { reason: `我还是不同意（第 ${n} 次）`, proposal: `第 ${n} 版修订` }));
    });
    const id = newCouncil('cC', ['1F', '4F'], { maxRounds: 2 });
    const orch = mkOrchestrator(h);
    const row = await orch.start(id);

    ok('verdict=no_consensus', row.verdict === 'no_consensus', String(row.verdict));
    ok('status=done —— 谈不拢是**正常收场**，不是出错', row.status === 'done', row.status);
    ok('error 留空（没坏，只是没谈成）', row.error === null, String(row.error));
    ok('verdict_round 留空（没有任何一轮谈成过）', row.verdict_round === null, String(row.verdict_round));
    ok('问满两轮才收手', h.seen.length === 4, String(h.seen.length));

    const debate = repo.listRounds(id).filter((r) => r.kind === 'debate');
    ok('两轮都存档了各自的提案与票型', debate.length === 2 && debate.every((r) => r.proposal_text && r.agree === 0 && r.disagree === 2));
    ok('库里没有任何"结论"字段被硬塞内容（决议就是 no_consensus 本身）', row.verdict === 'no_consensus');
  }

  // ============================================================ 有人挂了
  head('有人没答话：那一轮就是不算数，票留空、错误原文留住');
  {
    const h = makeHarness();
    h.set('1F', OK(says('agree')));
    h.set('4F', OK(says('agree')));
    h.set('7F', { status: 'failed', text: '', tokens: null, error: 'kilo 崩了：段错误', durationMs: 9, exitCode: 139 });

    const id = newCouncil('cD', ['1F', '4F', '7F'], { maxRounds: 1 });
    const orch = mkOrchestrator(h);
    const row = await orch.start(id);

    const r1 = repo.listRounds(id).find((r) => r.round_no === 1);
    ok('两个人同意、一个人没答话 → 本轮不成立', r1.agree === 2 && r1.invalid === 1 && r1.consensus === 0, JSON.stringify(r1));
    ok('不来的人**不算**成同意（3 票里 2 票同意也不给过）', row.verdict === 'no_consensus', String(row.verdict));

    const u = repo.listUtterances(id).find((x) => x.floor_id === '7F' && x.round_no === 1);
    ok('失败的发言 vote 留 NULL（绝不替它补一个立场）', u.vote === null, String(u.vote));
    ok('正文也不编，留空', u.content === null, String(u.content));
    ok('status=failed', u.status === 'failed', u.status);
    ok('错误原文原样落库（界面要直接显示给用户）', u.error === 'kilo 崩了：段错误', String(u.error));
    ok('出席者那一行也标了 failed', repo.listParticipants(id).find((p) => p.floor_id === '7F').status === 'failed');
    ok('没答话就没有词元（NULL，不是 0）', u.input_tokens === null && u.output_tokens === null);
  }

  // ============================================================ 说了话但没表态
  head('说了话但没按格式表态：跟"没跑成"分开记（unparsed）');
  {
    const h = makeHarness();
    h.set('1F', OK(says('agree')));
    h.set('4F', OK(says('agree')));
    h.set('8F', OK('我觉得都行，看你们吧。（没有附投票块）'));

    const id = newCouncil('cE', ['1F', '4F', '8F'], { maxRounds: 1 });
    const orch = mkOrchestrator(h);
    await orch.start(id);

    const u = repo.listUtterances(id).find((x) => x.floor_id === '8F');
    ok('status=unparsed（不是 failed：它确实答话了）', u.status === 'unparsed', u.status);
    ok('正文留着（它说了什么要让人看得到）', String(u.content).includes('我觉得都行'), String(u.content));
    ok('但票留空 —— 不按语气猜一个立场出来', u.vote === null, String(u.vote));
    ok('未表态计入 invalid，本轮不成立', repo.listRounds(id).find((r) => r.round_no === 1).invalid === 1);
  }

  // ============================================================ 取消
  head('取消：不再往下推进，票不记，收尾干净');
  {
    const h = makeHarness();
    h.all(OK(says('agree')));
    const id = newCouncil('cF', ['1F', '4F', '7F'], { maxRounds: 3 });
    const orch = mkOrchestrator(h);

    h.startHolding();
    const pending = orch.start(id);
    await waitFor(() => h.held.length === 3);
    ok('三个参与者都起来了', h.held.length === 3, String(h.held.length));
    ok('在飞表里能看到这场会', orch.activeIds().includes(id));
    const dir = h.seen[0].cwd;

    ok('取消返回 true', orch.cancel(id) === true);
    ok('取消一场没在跑的会返回 false（不抛）', orch.cancel('根本不存在') === false);

    h.release(); // 进程被杀 → 调用返回
    const row = await pending;

    ok('verdict=cancelled', row.verdict === 'cancelled', String(row.verdict));
    ok('status=cancelled（跟 failed 分开：这是被打断的，不是它坏了）', row.status === 'cancelled', row.status);
    ok('取消之后一条发言都不记（挂在半路的那些算没发生）', repo.listUtterances(id).filter((u) => u.round_no === 1).length === 0);
    const r1 = repo.listRounds(id).find((r) => r.round_no === 1);
    ok('中断的那一轮不补一个假的结束时间（它确实没跑完）', r1 && r1.ended_at === null, JSON.stringify(r1 && r1.ended_at));
    ok('临时目录照样清掉', fs.existsSync(dir) === false, dir);
    ok('不在在飞表里了', orch.activeIds().length === 0);
  }

  // ============================================================ 幂等 / 兜底
  head('重复 start 与没有出席者的会');
  {
    const h = makeHarness();
    h.all(OK(says('agree')));
    const id = newCouncil('cH', ['1F', '4F', '7F'], { maxRounds: 3 });
    const orch = mkOrchestrator(h);
    const first = await orch.start(id);
    const before = h.seen.length;
    ok('先正常跑完一场', first.verdict === 'consensus', String(first.verdict));

    ok('start 一场不存在的会：安静返回 null，不抛（路由是 fire-and-forget 调的）', (await orch.start('查无此会')) === null);
    const again = await orch.start(id);
    ok('已结束的会再 start：不会被拉回起点重跑', again.status === 'done' && again.verdict === 'consensus', `${again.status}/${again.verdict}`);
    ok('也确实没有再问任何人', h.seen.length === before, `${h.seen.length} vs ${before}`);

    const empty = newCouncil('cEmpty', [], { maxRounds: 2 });
    const rowEmpty = await orch.start(empty);
    ok('一个人都没请的会：报 failed + 说清原因', rowEmpty.status === 'failed' && rowEmpty.error === '这场会没有出席者', `${rowEmpty.status}/${rowEmpty.error}`);
    ok('而不是走完两轮再报"未达成"（那看起来像讨论过）', repo.listRounds(empty).filter((r) => r.kind === 'debate').length === 0);
  }

  // ============================================================ 关服
  head('关服：在飞的会给个明确结局，上次崩溃留下的 running 如实标掉');
  {
    const h = makeHarness();
    h.all(OK(says('agree')));
    const id = newCouncil('cG', ['1F', '4F'], { maxRounds: 3 });
    const orch = mkOrchestrator(h);

    h.startHolding();
    const pending = orch.start(id);
    await waitFor(() => h.held.length === 2);

    // 一场"上一个进程被硬杀时"留下的 running —— 直接写库，不经编排器（它没有内存里的 ctx）
    repo.createCouncil({ id: 'cG-stale', topic: '上次没跑完的', threshold: 'unanimous', maxRounds: 2, createdAt: now() });
    repo.markCouncilRunning('cG-stale', now());

    const swept = orch.shutdown();
    h.release();
    const row = await pending;

    ok('在飞的会标成 cancelled，并写明是关服打断的', row.status === 'cancelled' && /服务已关闭/.test(String(row.error)), `${row.status}/${row.error}`);
    ok('关服后活跃表清空', orch.activeIds().length === 0);
    ok('扫尾只扫到那一场无主的（在飞的那场我们自己收的）', swept === 1, String(swept));

    const stale = repo.getCouncil('cG-stale');
    ok('上次崩溃留下的 running 如实标成 failed（不假装还在讨论）', stale.status === 'failed' && stale.verdict === 'failed', `${stale.status}/${stale.verdict}`);
    ok('并记下为什么', /服务已关闭/.test(String(stale.error)), String(stale.error));
    ok('那个没跑完的会没有凭空多出结论轮次', repo.listRounds('cG-stale').length === 0);
  }

  // ============================================================ 分析模式
  head('分析模式：不判票、跑满轮数、如实呈报');
  {
    const h = makeHarness();
    const orch = mkOrchestrator(h);
    h.all(() => OK('我的分析：这个改法可以，但要盯住并发。\n```json\n' +
      JSON.stringify({ stance: 'support', points: ['改法可行'], risks: ['并发下可能重复写'], questions: ['有没有测试覆盖'] }) +
      '\n```'));
    repo.createCouncil({ id: 'cA1', topic: '这个 bug fix 会不会引入回归', mode: 'analysis', threshold: 'unanimous', maxRounds: 2, createdAt: now() });
    for (const f of ['1F', '4F', '7F']) repo.insertParticipant({ councilId: 'cA1', floorId: f, agent: 'x', cliPath: null });

    const row = await orch.start('cA1');
    ok('跑满就是正常收场：verdict=reported', row.verdict === 'reported', String(row.verdict));
    ok('status=done（不是 failed）', row.status === 'done', String(row.status));
    ok('跑到第 2 轮（没有被"达成一致"提前截断）', row.round_current === 2, String(row.round_current));

    const us = repo.listUtterances('cA1').filter((u) => u.role !== 'chair');
    ok('三个楼层 × 两轮都发了言', us.length === 6, String(us.length));
    ok('每条都落了立场', us.every((u) => u.stance === 'support'), us.map((u) => u.stance).join(','));
    ok('结构化要点原样落库（JSON 文本）',
      us.every((u) => /"risks":\["并发下可能重复写"\]/.test(String(u.findings_json))), String(us[0].findings_json));
    ok('分析模式不数票：三个票型列全是 0',
      repo.listRounds('cA1').filter((r) => r.round_no > 0).every((r) => r.agree === 0 && r.disagree === 0 && r.abstain === 0));
    ok('那一轮里没人给立场的人数和其它模式同一个口径',
      repo.listRounds('cA1').filter((r) => r.round_no > 0).every((r) => r.invalid === 0));
    ok('没有"桌上那份提案"（不能把议题冒充成被人表决过的提案）',
      repo.listRounds('cA1').filter((r) => r.round_no > 0).every((r) => r.proposal_text == null));

    const prompt = h.seen[0].prompt;
    ok('提示词里没有"现在要表决的提案"那一段', !/现在要表决的提案/.test(prompt));
    ok('提示词里换成了分析模式的输出协议', /"stance":"support"/.test(prompt));
    ok('提示词里写明第几轮', /第 1\/2 轮/.test(prompt));
    ok('最后一轮明说要给最终判断', h.seen.filter((s) => s.round === 2).every((s) => /这是最后一轮/.test(s.prompt)));
  }

  head('分析模式：认不出立场就是未表态，不按语气猜');
  {
    const h = makeHarness();
    const orch = mkOrchestrator(h);
    // 头两轮说了话但没给尾块 —— 正文照存，立场留空，status=unparsed
    h.all(() => OK('我觉得还行吧，大概。'));
    repo.createCouncil({ id: 'cA2', topic: '没给尾块会怎样', mode: 'analysis', threshold: 'unanimous', maxRounds: 1, createdAt: now() });
    for (const f of ['1F', '4F']) repo.insertParticipant({ councilId: 'cA2', floorId: f, agent: 'x', cliPath: null });

    const row = await orch.start('cA2');
    ok('照样收场成 reported（一句话没解析出来不该把整场会判成失败）', row.verdict === 'reported', String(row.verdict));
    const us = repo.listUtterances('cA2').filter((u) => u.role !== 'chair');
    ok('正文留着（它确实说了话）', us.every((u) => /我觉得还行吧/.test(String(u.content))));
    ok('立场留空 —— 绝不按语气猜成 support', us.every((u) => u.stance === null), us.map((u) => u.stance).join(','));
    ok('要点留空（不是空对象：那是"没说"，不是"说没有"）', us.every((u) => u.findings_json === null), String(us[0].findings_json));
    ok('status 记成 unparsed（"没按约定表态"与"没跑成"要分得开）', us.every((u) => u.status === 'unparsed'), us.map((u) => u.status).join(','));
  }

  // ============================================================ 工程模式
  head('工程模式：在用户的目录里谈，收尾时**绝不**碰那个目录');
  {
    // 这次注入的 removeDir / isDir 是**替身**，不碰真文件系统 —— 要断言的就是
    // "收尾路径到底有没有走到删目录那一步"。真删一个用户目录的代价太大，不能用真件试。
    const dirs = [];
    const removed = [];
    const h = makeHarness();
    const wsDir = path.join(TMP, 'user-project');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'IMPORTANT.txt'), 'user data');
    const orch = createCouncilOrchestrator({
      repo,
      broadcast: (project, type, payload) => broadcasts.push({ project, type, payload }),
      deps: {
        runTurn: h.runTurn,
        now,
        cliPathOf: (floorId) => `/fake/${floorId}`,
        mkdtemp: (prefix) => { const d = fs.mkdtempSync(path.join(TMP, prefix)); dirs.push(d); return d; },
        removeDir: (d) => { removed.push(d); fs.rmSync(d, { recursive: true, force: true }); },
        isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
      },
    });
    h.all(() => OK(says('agree')));
    repo.createCouncil({ id: 'cW1', topic: '看真实代码表决', workspacePath: wsDir, threshold: 'unanimous', maxRounds: 1, createdAt: now() });
    for (const f of ['1F', '4F']) repo.insertParticipant({ councilId: 'cW1', floorId: f, agent: 'x', cliPath: null });

    const row = await orch.start('cW1');
    ok('在用户给的目录里跑', h.seen.every((s) => s.cwd === wsDir), h.seen.map((s) => s.cwd).join(','));
    ok('**没有**建临时目录（工程模式不建一次性目录）', dirs.length === 0, dirs.join(','));
    ok('**没有**调过 removeDir —— 这是本次改动最危险的一处，钉死它', removed.length === 0, removed.join(','));
    ok('用户的工程目录原封不动还在', fs.existsSync(path.join(wsDir, 'IMPORTANT.txt')));
    ok('正常收场', row.verdict === 'consensus', String(row.verdict));
    ok('提示词里写明了工作目录', h.seen.every((s) => s.prompt.includes(wsDir)));
    ok('提示词里说了它只能只读地翻代码', h.seen.every((s) => /不能修改任何文件/.test(s.prompt)));
  }

  head('工程模式：目录在发起与开跑之间没了 → 如实 failed，不空转四轮');
  {
    const removed = [];
    const h = makeHarness();
    const orch = createCouncilOrchestrator({
      repo,
      broadcast: (project, type, payload) => broadcasts.push({ project, type, payload }),
      deps: {
        runTurn: h.runTurn,
        now,
        cliPathOf: (floorId) => `/fake/${floorId}`,
        mkdtemp: (prefix) => fs.mkdtempSync(path.join(TMP, prefix)),
        removeDir: (d) => removed.push(d),
        isDir: () => false,
      },
    });
    h.all(() => OK(says('agree')));
    repo.createCouncil({ id: 'cW2', topic: '目录没了', workspacePath: path.join(TMP, 'not-there'), threshold: 'unanimous', maxRounds: 2, createdAt: now() });
    for (const f of ['1F', '4F']) repo.insertParticipant({ councilId: 'cW2', floorId: f, agent: 'x', cliPath: null });

    const row = await orch.start('cW2');
    ok('verdict=failed', row.verdict === 'failed', String(row.verdict));
    ok('一句话没问（不空转四轮再报"谁都没表态"）', h.seen.length === 0, String(h.seen.length));
    ok('错误原文里带着那个路径，用户一眼看得出是写错了', String(row.error).includes('not-there'), String(row.error));
    ok('也没去删那个不存在的目录', removed.length === 0, removed.join(','));
  }

  // ============================================================ 隔离
  // 这一组是"隔离，只在议事厅看"这条口径的**机器证据**：前面十几场会（含失败、取消、
  // 关服）跑完之后，被监控那侧的三张表必须一条都不多 —— 参与者不是楼层成员，
  // 也不该在办公室或任务记录页露脸。上面每条断言都是"议事厅里发生了什么"，
  // 只有这一条管"议事厅**没**弄脏别处"。
  head('隔离：跑了这么多场会，被监控那侧一张表都不许多');
  {
    const count = (t) => repo.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    for (const t of ['members', 'tasks', 'task_runs', 'messages', 'file_activity']) {
      ok(`${t} 是空的（议事厅没往里写过一个字）`, count(t) === 0, String(count(t)));
    }
    ok('议事厅自己的表有东西（上一条不是因为库是空的才成立）',
      repo.listCouncils({ limit: 100 }).length > 0, String(repo.listCouncils({ limit: 100 }).length));
  }

  close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${fail ? '✗' : '✓'} council-orchestrator: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
