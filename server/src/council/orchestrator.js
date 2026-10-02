'use strict';

/**
 * 议事厅的状态机 —— 把"开一场会"从一次 HTTP 请求变成一串没人盯着也要跑完的动作。
 *
 *   draft ──start()──▶ running ──┬─ 第 0 轮 议题陈述（服务端把题目摆上桌，不调模型）
 *                                ├─ 第 1..N 轮：并发问所有人 → 收齐（或超时）→ 机械计票
 *                                │    · 达成 → consensus，用**那一轮桌上那份提案原文**当结论
 *                                │    · 没达成 → 拿反对者的修订案当下一轮的提案，继续
 *                                └─ 到上限还没谈成 → no_consensus（合法结果，如实说）
 *
 * 三条贯穿始终的规矩：
 *   1. **绝不编造**。某个人超时 / 崩了 / 输出解析不出 → 如实记 status + 错误原文，
 *      vote 留 NULL。缺席的那一票**不参与**共识判定（见 consensus.js：有未表态就不算数）。
 *      谈不拢就是谈不拢 —— 不为了给个交代而合成一个"结论"。
 *   2. **隔离**。参与者跑在一次性临时目录里（cwd），工具全关（见 agents.js），
 *      cwd 用完就删；它们的数据只进议事厅自己的表，不碰 members / tasks。
 *   3. **进程必须收得干净**。在飞的子进程登记在 active 里 ——「取消」和「关服」都要
 *      把它们连同各自的子进程一起杀掉，不能留孤儿。
 *
 *      这条只在**走关服流程**时有效（`lifecycle.onClose` → `shutdown()`）。进程被 `kill -9`
 *      或 `process.exit()` 直接带走时，没有任何代码有机会去杀它们，在飞的那几个 CLI 会
 *      活到把这一轮答完（它们是一次性调用，答完自己退出）。代价有界，但确实存在 ——
 *      **不要**在服务端用 process.exit 收场，那会跳过 shutdown。
 *
 * 依赖全部可注入（runTurn / detect / mkdtemp / now），所以状态机能用**假参与者**整条跑通，
 * 不必真的调模型（见 server/test/councilOrchestrator.test.js）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULTS, WS_EVENTS } = require('@workgremlin/shared');

const { runOnce, killTree } = require('./runner');
const { RECIPES, parseVoteBlock } = require('./agents');
const { buildSpeechPrompt, buildBriefText } = require('./prompt');
const { decideRound } = require('./consensus');
const { cliPathOf } = require('./floors');

/** 临时目录前缀：进程列表里一眼认得出是议事厅留下的 */
const TMP_PREFIX = 'wg-council-';

/** DB 的 snake_case → 提示词 / 判定用的 camelCase。只转议事厅自己那几张表的字段 */
function materialOf(row) {
  return {
    path: row.path,
    content: row.content,
    bytesTotal: row.bytes_total,
    bytesIncluded: row.bytes_included,
    truncated: Boolean(row.truncated),
  };
}

/**
 * @param {{repo:object, broadcast?:Function, deps?:object}} arg
 *   broadcast(project, type, payload) —— 议事厅与工程无关，project 传 null。
 *   deps 可注入：runTurn / detect / mkdtemp / now / timeoutMs，测试用。
 */
function createCouncilOrchestrator({ repo, broadcast, deps = {} }) {
  const runTurn = deps.runTurn || runOnce;
  const now = deps.now || (() => Date.now());
  /** 收**前缀**、返回目录路径（跟 fs.mkdtempSync 同一个语义，测试好替换） */
  const mkdtemp = deps.mkdtemp || ((prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const timeoutMs = deps.timeoutMs || DEFAULTS.COUNCIL_TURN_TIMEOUT_MS;
  const removeDir = deps.removeDir || ((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  /** 楼层 → 可执行文件路径。缺省走 products 探测；测试注入假的 */
  const cliPath = deps.cliPathOf || ((floorId) => cliPathOf(floorId));

  /** 在飞的会：councilId → { cancelled:boolean, children:Set, tmpDir:string } */
  const active = new Map();

  const emit = (type, payload) => {
    if (typeof broadcast !== 'function') return;
    try {
      broadcast(null, type, payload);
    } catch {
      /* 广播失败不该影响这场会 —— 前端还会轮询补拉 */
    }
  };

  /** 某个楼层的显示名（提示词里要用，让它知道对面是谁） */
  function floorName(floorId) {
    const r = RECIPES[floorId];
    return (r && r.name) || floorId;
  }

  /**
   * 跑一个人的一轮。
   * @returns {Promise<{floorId:string, status:string, content:string|null, vote:string|null,
   *   voteReason:string|null, proposal:string|null, second:string|null, error:string|null,
   *   tokens:object|null, startedAt:number, endedAt:number, durationMs:number}>}
   */
  async function askOne({ ctx, floor, prompt }) {
    const startedAt = now();
    const recipe = RECIPES[floor.floor_id];
    const bin = floor.cli_path || cliPath(floor.floor_id);

    // 收尾之后再冒出来的调用一律不起进程。**今天到不了这里**：起进程与登记句柄在同一个
    // 同步段内完成（本函数一路同步跑到 `await runTurn`，而 runOnce 里 spawn 是同步的），
    // 关服插不进这个缝。留着是把它写成一条**不变量**（"收尾中不起新进程"），
    // 免得以后 runTurn 前面多出一个 await 时，这里悄悄漏掉一个没人杀的 CLI。
    if (ctx.cancelled || ctx.closed) {
      return {
        floorId: floor.floor_id,
        status: 'failed',
        content: null, vote: null, voteReason: null, proposal: null, second: null,
        error: '这一轮还没发问，这场会就已经在收尾了',
        tokens: null, startedAt, endedAt: now(), durationMs: 0,
      };
    }

    // 没装（或当时没探到）——不猜、不跳过、如实记
    if (!recipe || !bin) {
      return {
        floorId: floor.floor_id,
        status: 'failed',
        content: null, vote: null, voteReason: null, proposal: null, second: null,
        error: recipe ? '没有可用的命令行可执行文件' : `议事厅不支持 ${floor.floor_id} 这一层`,
        tokens: null, startedAt, endedAt: now(), durationMs: 0,
      };
    }

    const inv = recipe.build({ bin, prompt });
    const r = await runTurn({
      ...inv,
      cwd: ctx.tmpDir,
      timeoutMs,
      agent: recipe.agent,
      onChild: (child) => {
        // 迟到的句柄直接杀掉，不挂进一个已经不会再被遍历的登记表（理由同上，今天到不了）
        if (ctx.cancelled || ctx.closed) {
          killTree(child);
          return;
        }
        ctx.children.add(child);
        child.once('close', () => ctx.children.delete(child));
      },
    });

    const endedAt = now();
    const base = {
      floorId: floor.floor_id,
      content: null, vote: null, voteReason: null, proposal: null, second: null,
      tokens: r.tokens || null, startedAt, endedAt, durationMs: r.durationMs,
      error: r.error || null,
      status: r.status === 'ok' ? 'ok' : r.status,
    };
    if (r.status !== 'ok') return base; // 失败 / 超时：正文和票都留空

    // 跑通了但**没给出可解析的投票** —— 这跟"没跑成"要分开：它是说了话的，
    // 只是没按约定表态。正文照存，vote 留空，status 记 'unparsed'。
    const vote = parseVoteBlock(r.text);
    return {
      ...base,
      content: r.text,
      vote: vote.vote,
      voteReason: vote.reason,
      proposal: vote.proposal,
      second: vote.second,
      status: vote.vote ? 'ok' : 'unparsed',
    };
  }

  /**
   * askOne 外面包一层：某一个参与者把自己搞崩了，不该把**整场会**带下去。
   * 记成"它这一轮未表态"（invalid 那一票），其余人照常计票 —— 缺席会导致本轮不成立，
   * 这正是我们想要的：少一票就是少一票，不拿三个人的意见冒充四个人的共识。
   */
  async function askOneSafe(arg) {
    try {
      return await askOne(arg);
    } catch (err) {
      const at = now();
      return {
        floorId: arg.floor.floor_id,
        status: 'failed',
        content: null, vote: null, voteReason: null, proposal: null, second: null,
        tokens: null, error: `调用参与者时出错：${err && err.message}`,
        startedAt: at, endedAt: at, durationMs: 0,
      };
    }
  }

  /** 把一轮的结果落库 + 广播 */
  function recordUtterance(councilId, roundNo, u) {
    repo.insertUtterance({
      councilId, roundNo, floorId: u.floorId, role: 'speaker',
      content: u.content, vote: u.vote, voteReason: u.voteReason,
      proposalText: u.proposal, secondFloor: u.second,
      status: u.status, error: u.error,
      inputTokens: u.tokens ? u.tokens.input : null,
      outputTokens: u.tokens ? u.tokens.output : null,
      cacheReadTokens: u.tokens ? u.tokens.cacheRead : null,
      cacheWriteTokens: u.tokens ? u.tokens.cacheWrite : null,
      startedAt: u.startedAt, endedAt: u.endedAt, durationMs: u.durationMs,
    });
    emit(WS_EVENTS.COUNCIL, {
      councilId,
      utterance: {
        roundNo, floorId: u.floorId, content: u.content, vote: u.vote,
        voteReason: u.voteReason, proposal: u.proposal, second: u.second,
        status: u.status, error: u.error, durationMs: u.durationMs,
      },
    });
  }

  /**
   * 收尾：落 verdict、清临时目录、广播、从在飞表里摘掉。
   *
   * 注意**不修补半途中断的那一轮**：被取消时最后那个 round 行的 ended_at 就是 NULL，
   * 照原样留着 —— 那一轮确实没跑完，补一个结束时间反而是编。它停在第几轮由
   * councils.round_current 记着，界面照实说"讨论到第 N 轮时被取消"。
   */
  function closeCouncil(ctx, { verdict, verdictRound = null, error = null }) {
    // 幂等：关服路径上 shutdown() 已经收过一次尾了，这里不能再写一遍把它的结论盖掉
    if (ctx.closed) return repo.getCouncil(ctx.councilId);
    ctx.closed = true;
    // 还在飞的进程先收掉（正常收尾时一般已经空了，取消 / 异常路径上才有）
    for (const child of ctx.children) killTree(child);
    ctx.children.clear();
    const c = repo.finishCouncil(ctx.councilId, { verdict, verdictRound, error, endedAt: now() });
    try {
      removeDir(ctx.tmpDir);
    } catch {
      /* 删不掉就留着，不要因为清理失败把整场会判成失败 */
    }
    active.delete(ctx.councilId);
    emit(WS_EVENTS.COUNCIL, {
      councilId: ctx.councilId,
      status: c ? c.status : 'done',
      verdict,
      verdictRound,
      error,
    });
    return c;
  }

  /**
   * 开一场会。整场跑完才 resolve —— 路由**不 await** 它（发起接口要立即返回），
   * 所以这里**不抛异常**：路由是 fire-and-forget 调的，抛出去就成了一枚没人接的
   * unhandled rejection（Node 默认会把整个服务带下去）。找不到会 / 状态不对都安静返回。
   * @returns {Promise<object|null>} 收尾后的 councils 行
   */
  async function start(councilId) {
    const council = repo.getCouncil(councilId);
    if (!council) return null;
    if (!repo.markCouncilRunning(councilId, now())) {
      // 不在 draft（已经在跑 / 已经结束）—— 什么都不做，别把一场跑着的会拉回起点
      return repo.getCouncil(councilId);
    }

    // 隔离目录建不出来就到此为止 —— 已经标成 running 了，必须给它一个结局，
    // 否则库里会留一场谁也取消不掉的僵尸会（只有下次启动的对账才会收拾）
    let tmpDir;
    try {
      tmpDir = mkdtemp(TMP_PREFIX);
    } catch (err) {
      return repo.finishCouncil(councilId, {
        verdict: 'failed', error: `建不出隔离目录：${err && err.message}`, endedAt: now(),
      });
    }

    const ctx = { councilId, cancelled: false, closed: false, children: new Set(), tmpDir };
    active.set(councilId, ctx);
    emit(WS_EVENTS.COUNCIL, { councilId, status: 'running' });

    try {
      const participants = repo.listParticipants(councilId);
      // 一个人都没有的会不是"没谈成"，是根本没开起来 —— 别让它走完 N 轮再报 no_consensus，
      // 那看起来像讨论过。路由那边还会再校验一次（至少两层），这里是兜底。
      if (!participants.length) {
        return closeCouncil(ctx, { verdict: 'failed', error: '这场会没有出席者' });
      }

      const materials = repo.listMaterials(councilId).map(materialOf);
      const threshold = council.threshold;
      const maxRounds = Math.max(
        1,
        Math.min(
          Number(council.max_rounds) || DEFAULTS.COUNCIL_ROUNDS_DEFAULT,
          DEFAULTS.COUNCIL_ROUNDS_MAX
        )
      );

      // ---- 第 0 轮：议题陈述。不调模型：把议题 + 材料摆上桌，落成一条 chair 发言，
      //      好让时间线从"题目是什么"开始，而不是凭空从第 1 轮开始。
      const briefText = buildBriefText(council.topic, materials);
      repo.upsertRound({
        councilId, roundNo: 0, kind: 'brief', proposalText: council.topic,
        proposalFrom: 'chair', agree: 0, disagree: 0, abstain: 0, invalid: 0, consensus: 0,
        startedAt: now(), endedAt: now(),
      });
      repo.insertUtterance({
        councilId, roundNo: 0, floorId: 'chair', role: 'chair',
        content: briefText, status: 'ok', startedAt: now(), endedAt: now(), durationMs: 0,
      });
      emit(WS_EVENTS.COUNCIL, {
        councilId, roundNo: 0, phase: 'brief',
        utterance: { roundNo: 0, floorId: 'chair', role: 'chair', content: briefText, status: 'ok' },
      });

      // ---- 第 1..N 轮
      let proposal = council.topic;
      let proposalFrom = 'chair';
      let history = [];
      let verdict = null;
      let verdictRound = null;

      for (let roundNo = 1; roundNo <= maxRounds; roundNo += 1) {
        if (ctx.cancelled) break;

        repo.setCouncilRound(councilId, roundNo);
        repo.upsertRound({
          councilId, roundNo, kind: 'debate', proposalText: proposal, proposalFrom,
          agree: 0, disagree: 0, abstain: 0, invalid: 0, consensus: 0, startedAt: now(), endedAt: null,
        });
        emit(WS_EVENTS.COUNCIL, { councilId, roundNo, phase: 'debate', proposal, proposalFrom });

        // 并发问所有人 —— 一轮里几个人是各自独立的，串行只会白白多等几倍时间
        const prompts = participants.map((floor) => ({
          floor,
          prompt: buildSpeechPrompt({
            topic: council.topic, materials, proposal, proposalFrom,
            roundNo, maxRounds, history,
            floorId: floor.floor_id, floorName: floorName(floor.floor_id),
          }),
        }));
        for (const floor of participants) repo.setParticipantStatus(councilId, floor.floor_id, 'running', null);
        const answers = await Promise.all(prompts.map((p) => askOneSafe({ ctx, ...p })));

        if (ctx.cancelled) break;

        for (const a of answers) {
          recordUtterance(councilId, roundNo, a);
          // 出席者的总状态 = 它**最近一轮**的结果（每一轮的细节在 utterances 里，不在这儿糊）
          repo.setParticipantStatus(councilId, a.floorId, a.status === 'ok' ? 'ok' : 'failed', a.error);
        }

        const decision = decideRound({ utterances: answers, threshold, maxRounds, roundNo });
        repo.upsertRound({
          councilId, roundNo, kind: 'debate', proposalText: proposal, proposalFrom,
          agree: decision.tally.agree, disagree: decision.tally.disagree,
          abstain: decision.tally.abstain, invalid: decision.tally.invalid,
          consensus: decision.consensus ? 1 : 0, startedAt: null, endedAt: now(),
        });
        emit(WS_EVENTS.COUNCIL, { councilId, roundNo, round: { ...decision.tally, consensus: decision.consensus } });

        // 进历史的发言要带轮次和楼层名 —— renderHistory 按轮次分组、按名字称呼，
        // answers 里只有 floorId
        history = [
          ...history,
          ...answers.map((a) => ({ ...a, roundNo, floorName: floorName(a.floorId) })),
        ];

        if (decision.done) {
          verdict = decision.outcome;
          verdictRound = decision.consensus ? roundNo : null;
          break;
        }
        // 下一轮：拿反对者的修订案换掉桌上的提案；没人提修订案就继续用这份
        // （不是"服务端挑一份更好的" —— 那等于替参与者写提案，见 consensus.js 的说明）
        if (decision.nextProposal) {
          proposal = decision.nextProposal.text;
          proposalFrom = decision.nextProposal.floorId;
        }
      }

      if (ctx.cancelled) return closeCouncil(ctx, { verdict: 'cancelled' });

      // 循环跑满都没 break（理论上不会：最后一轮 decision.done 必为 true，这里只是兜底）
      if (!verdict) verdict = 'no_consensus';
      return closeCouncil(ctx, { verdict, verdictRound });
    } catch (err) {
      // 整场级别的意外（落库失败之类）—— 如实记 failed，把错误原文留住
      return closeCouncil(ctx, { verdict: 'failed', error: `议事中断：${err && err.message}` });
    }
  }

  /**
   * 取消一场在跑的会：杀掉所有在飞的参与者进程并收尾。
   * 进程是在 await 里跑的，靠 ctx.cancelled 标记让主循环在下一个检查点退出。
   * @returns {boolean} 是否真的取消了一场在跑的会
   */
  function cancel(councilId) {
    const ctx = active.get(councilId);
    if (!ctx) return false;
    ctx.cancelled = true;
    for (const child of ctx.children) killTree(child);
    ctx.children.clear();
    return true;
  }

  /**
   * 服务关闭：杀掉所有在飞的参与者，给每场在飞的会落一个明确的结局。
   *
   * 顺序有讲究 —— **先自己收尾，再扫剩下的**：
   *   · 自己经手的这些会，结论是「被关服打断」= cancelled（带着原因），比一句笼统的 failed 准；
   *   · 扫尾那一步（failStaleCouncils）留给**别的进程上次崩溃时**留下的 running 行 ——
   *     它们对应的进程早就不在了，只能如实标 failed。这也是启动对账用的同一个方法。
   * 反过来先扫再收尾的话，会被随后醒来的 start() 协程把结论改写一遍，谁最后写谁赢。
   */
  function shutdown() {
    for (const ctx of [...active.values()]) {
      ctx.cancelled = true;
      closeCouncil(ctx, { verdict: 'cancelled', error: '服务已关闭，这场会没有跑完' });
    }
    active.clear();
    try {
      return repo.failStaleCouncils('服务已关闭，这场会没有跑完', now());
    } catch {
      return 0;
    }
  }

  /** 在飞的会（测试与排障用） */
  const activeIds = () => [...active.keys()];

  return { start, cancel, shutdown, activeIds };
}

module.exports = { createCouncilOrchestrator, materialOf, TMP_PREFIX };
