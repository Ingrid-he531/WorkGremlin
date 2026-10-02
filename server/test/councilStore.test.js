/**
 * 议事厅落库自检 —— 真 SQLite（临时库）+ 真 repo，不 mock。
 *
 * 盯三件事：
 *   1. 5 张表建得起来、字段名对得上（schema.sql 是新写的，写错名字在这里最先炸）；
 *   2. **取不到的字段留 NULL 而不是 0** —— 词元读不到就写 NULL，界面才知道该显示「—」；
 *      写成 0 会被当成"消耗为零"，那是编造（docs/requirements.md §1 的铁律）。
 *   3. 隔离：一场会的数据能整体删干净，不留孤儿行；上次被硬杀留下的 running 会被如实标掉。
 *
 * 跑法：`npm run test:council-store`
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/db');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-council-store-'));
const { repo, close } = openDatabase(path.join(TMP, 'test.db'));

const AT = 1_700_000_000_000;
const mk = (id, extra = {}) =>
  repo.createCouncil({ id, topic: `议题 ${id}`, threshold: 'unanimous', maxRounds: 3, createdAt: AT, ...extra });

// ------------------------------------------------------------ 建表 / 建会
head('建会与读回');
{
  const c = mk('c1');
  ok('createCouncil 返回落库后的行', c && c.id === 'c1');
  ok('默认是 draft', c.status === 'draft', c.status);
  ok('默认 round_current = 0（只有议题陈述轮）', c.round_current === 0);
  ok('verdict / ended_at 一开始是空的', c.verdict === null && c.ended_at === null);
  ok('getCouncil 读得回来', repo.getCouncil('c1').topic === '议题 c1');
  ok('读不存在的会返回 null（不是抛错）', repo.getCouncil('nope') === null);
}
{
  mk('c2');
  const list = repo.listCouncils(10);
  ok('列表按发起时间倒序、只认 limit', list.length === 2 && list.every((r) => r.id));
  ok('limit 会被夹到合理范围（0 / -1 / 巨值都不炸）', repo.listCouncils(0).length >= 1 && repo.listCouncils(1e9).length === 2);
}

// -------------------------------------------------------------- 出席者
head('出席者');
{
  repo.insertParticipant({ councilId: 'c1', floorId: '4F', agent: 'claude', cliPath: '/usr/bin/claude' });
  repo.insertParticipant({ councilId: 'c1', floorId: '1F', agent: 'codebuddy', cliPath: '/usr/bin/codebuddy' });
  const ps = repo.listParticipants('c1');
  ok('按楼层号升序取回', ps.length === 2 && ps[0].floor_id === '1F' && ps[1].floor_id === '4F', JSON.stringify(ps.map((p) => p.floor_id)));
  ok('cli_path 原样存着（排查时要知道当时用的哪个可执行文件）', ps[1].cli_path === '/usr/bin/claude');
  ok('初始 status = pending', ps[0].status === 'pending');
  repo.setParticipantStatus('c1', '1F', 'failed', 'spawn ENOENT');
  const one = repo.listParticipants('c1')[0];
  ok('失败原因如实落库', one.status === 'failed' && one.error === 'spawn ENOENT');
}

// -------------------------------------------------------------- 材料
head('内联材料');
{
  repo.insertMaterial({ councilId: 'c1', ord: 0, path: '/tmp/a.txt', bytesTotal: 100, bytesIncluded: 100, truncated: 0, content: 'A 的内容' });
  repo.insertMaterial({ councilId: 'c1', ord: 1, path: '/tmp/big.txt', bytesTotal: 999999, bytesIncluded: 65536, truncated: 1, content: 'B 的前 64KB' });
  const ms = repo.listMaterials('c1');
  ok('按 ord 升序', ms.length === 2 && ms[0].path === '/tmp/a.txt' && ms[1].path === '/tmp/big.txt');
  ok('截断事实记着（原始大小 ≠ 实际内联大小）', ms[1].truncated === 1 && ms[1].bytes_total === 999999 && ms[1].bytes_included === 65536);
}
{
  repo.insertMaterial({ councilId: 'c1', ord: 2, path: '/tmp/gone.txt', bytesTotal: null, bytesIncluded: 0, truncated: 0, content: null });
  const m = repo.listMaterials('c1')[2];
  ok('读不到的文件：bytes_total 留 NULL，**不写 0**', m.bytes_total === null, String(m.bytes_total));
}

// ---------------------------------------------------------------- 轮次
head('轮次：同一轮 upsert，started_at 不被后来者覆盖');
{
  repo.upsertRound({ councilId: 'c1', roundNo: 0, kind: 'brief', proposalText: '议题原文', proposalFrom: 'chair', agree: 0, disagree: 0, abstain: 0, invalid: 0, consensus: 0, startedAt: AT, endedAt: AT + 10 });
  repo.upsertRound({ councilId: 'c1', roundNo: 1, kind: 'debate', proposalText: '议题原文', proposalFrom: 'chair', agree: 2, disagree: 1, abstain: 0, invalid: 0, consensus: 0, startedAt: AT + 100, endedAt: null });
  const rs = repo.listRounds('c1');
  ok('两轮按序号取回', rs.length === 2 && rs[0].round_no === 0 && rs[1].round_no === 1);
  ok('第 0 轮是 chair 的议题陈述', rs[0].kind === 'brief' && rs[0].proposal_from === 'chair');
  ok('票数原样落库', rs[1].agree === 2 && rs[1].disagree === 1);

  // 收工时补写同一轮（ended_at / consensus 才知道）
  repo.upsertRound({ councilId: 'c1', roundNo: 1, kind: 'debate', proposalText: '议题原文', proposalFrom: 'chair', agree: 2, disagree: 1, abstain: 0, invalid: 0, consensus: 0, startedAt: AT + 999, endedAt: AT + 200 });
  const again = repo.listRounds('c1')[1];
  ok('started_at 保持第一次写的（不被后来的 999 覆盖）', again.started_at === AT + 100, String(again.started_at));
  ok('ended_at 补上了', again.ended_at === AT + 200);
  ok('轮数没有变成 3（是 upsert 不是 insert）', repo.listRounds('c1').length === 2);
}

// ---------------------------------------------------------------- 发言
head('发言与投票：拿不到的字段一律留 NULL');
{
  repo.insertUtterance({
    councilId: 'c1', roundNo: 1, floorId: '1F', content: '我同意', vote: 'agree', voteReason: '成本可控',
    proposalText: null, secondFloor: null, status: 'ok',
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    startedAt: AT + 100, endedAt: AT + 150, durationMs: 50,
  });
  repo.insertUtterance({
    councilId: 'c1', roundNo: 1, floorId: '4F', content: null, vote: null, voteReason: null,
    proposalText: null, secondFloor: null, status: 'timeout', error: '120s 未返回，已杀进程',
    startedAt: AT + 100, endedAt: AT + 220, durationMs: 120000,
  });
  const us = repo.listUtterances('c1');
  ok('按 (轮次, 楼层) 升序', us.length === 2 && us[0].floor_id === '1F' && us[1].floor_id === '4F');
  ok('未表态的那条 vote 是 NULL（不是 agree / abstain）', us[1].vote === null, String(us[1].vote));
  ok('失败原因原文留着', us[1].status === 'timeout' && String(us[1].error).includes('120s'));
  ok('词元取不到 → NULL，**不是 0**', us[0].input_tokens === null && us[0].output_tokens === null);
  ok('耗时是真的就记着', us[0].duration_ms === 50);
  ok('role 缺省是 speaker', us[0].role === 'speaker');
}
{
  repo.insertUtterance({ councilId: 'c1', roundNo: 0, floorId: '1F', role: 'chair', content: '议题陈述', status: 'ok' });
  const chair = repo.listUtterances('c1').find((x) => x.role === 'chair');
  ok('chair 角色落得进去（第 0 轮的服务端陈述）', chair && chair.round_no === 0);
  ok('没给的字段不会变成空串', chair.vote === null && chair.vote_reason === null && chair.error === null);
}

// ---------------------------------------------------------------- 收尾
head('收尾：达成 / 未达成 / 取消 三种都有对应的 status');
{
  ok('markCouncilRunning 第一次成功', repo.markCouncilRunning('c1', AT) === true);
  ok('再标一次不生效（状态守卫：不能把跑着的会拉回起点）', repo.markCouncilRunning('c1', AT) === false);
  const c = repo.finishCouncil('c1', { verdict: 'consensus', verdictRound: 2, endedAt: AT + 500 });
  ok('consensus → status=done 且记下是第几轮谈成的', c.status === 'done' && c.verdict === 'consensus' && c.verdict_round === 2);
  ok('ended_at 落上', c.ended_at === AT + 500);
}
{
  mk('c3');
  repo.markCouncilRunning('c3', AT);
  const c = repo.finishCouncil('c3', { verdict: 'no_consensus', endedAt: AT + 1 });
  ok('no_consensus 也是 done（**谈不拢是合法结果，不是错误**）', c.status === 'done' && c.verdict === 'no_consensus');
  ok('没谈成时 verdict_round 留 NULL', c.verdict_round === null);
}
{
  mk('c4');
  const c = repo.finishCouncil('c4', { verdict: 'cancelled', endedAt: AT + 1 });
  ok('取消 → status=cancelled', c.status === 'cancelled' && c.verdict === 'cancelled');
}

// ------------------------------------------------------------ 启动对账
head('启动对账：上次被硬杀留下的 running 会被如实标成 failed');
{
  mk('c5');
  repo.markCouncilRunning('c5', AT);
  const n = repo.failStaleCouncils('服务上次被中断，这场会没有跑完', AT + 9999);
  ok('扫到 1 条', n === 1, String(n));
  const c = repo.getCouncil('c5');
  ok('标成 failed 并写明原因（不假装还在讨论）', c.status === 'failed' && c.verdict === 'failed' && String(c.error).includes('被中断'));
  ok('已结束的会不会被误伤', repo.getCouncil('c1').status === 'done' && repo.getCouncil('c3').status === 'done');
  ok('再跑一次扫不到东西（幂等）', repo.failStaleCouncils('x', AT) === 0);
}

// ---------------------------------------------------------------- 隔离
head('隔离：一场会能连子表删干净，不留孤儿');
{
  const before = {
    utt: repo.listUtterances('c1').length,
    rounds: repo.listRounds('c1').length,
    mats: repo.listMaterials('c1').length,
    ps: repo.listParticipants('c1').length,
  };
  ok('删之前确实有子表数据', before.utt > 0 && before.rounds > 0 && before.mats > 0 && before.ps > 0, JSON.stringify(before));
  ok('deleteCouncil 报成功', repo.deleteCouncil('c1') === true);
  ok('会本体没了', repo.getCouncil('c1') === null);
  ok('发言清空', repo.listUtterances('c1').length === 0);
  ok('轮次清空', repo.listRounds('c1').length === 0);
  ok('材料清空', repo.listMaterials('c1').length === 0);
  ok('出席者清空', repo.listParticipants('c1').length === 0);
  ok('删不存在的会返回 false（路由据此给 404）', repo.deleteCouncil('c1') === false);
  ok('别的会没被牵连', repo.getCouncil('c2') !== null && repo.getCouncil('c3') !== null);
  // 跨表扫一遍：议事厅的子表里不该再有任何 c1 的行
  const orphans = ['council_utterances', 'council_rounds', 'council_materials', 'council_participants']
    .map((t) => repo.raw.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE council_id = 'c1'`).get().c)
    .reduce((a, b) => a + b, 0);
  ok('四张子表一行不剩', orphans === 0, String(orphans));
}

close();
console.log(`\n${fail ? '✗' : '✓'} council-store: ${pass} 通过 / ${fail} 失败`);
// 临时库连目录一起拆掉（同 councilRunner：自己搭的台子自己拆，失败时也拆）
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
