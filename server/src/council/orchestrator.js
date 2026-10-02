'use strict';

/**
 * 议事厅的状态机 —— 把"开一场会"从一次 HTTP 请求变成一串没人盯着也要跑完的动作。
 *
 *   draft ──start()──▶ running ──┬─ 第 0 轮 议题陈述（服务端把题目摆上桌，不调模型）
 *                                ├─ 第 1..N 轮：并发问所有人 → 收齐（或超时）
 *                                │    · 表决模式：机械计票。达成 → consensus（用**那一轮桌上
 *                                │      那份提案原文**当结论）；没达成 → 拿反对者的修订案当
 *                                │      下一轮的提案，继续；到上限 → no_consensus（合法结果）
 *                                │    · 分析模式：不判票、不换提案，跑满 N 轮 → reported
 *                                └─ 收尾（落 verdict、清临时目录、广播）
 *
 * 两个正交的开关（都读 councils 行，起跑时定死，中途不变）：
 *   · mode            —— 'vote' 表决 / 'analysis' 分析
 *   · workspace_path  —— 有值 = 工程模式（cwd = 用户的真实工程 + 只读工具）；
 *                        NULL = 隔离模式（cwd = 现建的一次性临时目录 + 工具全关）
 *
 * 三条贯穿始终的规矩：
 *   1. **绝不编造**。某个人超时 / 崩了 / 输出解析不出 → 如实记 status + 错误原文，
 *      立场留 NULL。缺席的那一票**不参与**共识判定（见 consensus.js：有未表态就不算数）。
 *      谈不拢就是谈不拢 —— 不为了给个交代而合成一个"结论"。
 *   2. **隔离**。隔离模式跑在一次性临时目录里、工具全关；工程模式的 cwd 是**用户的**目录、
 *      只给只读工具，并靠 WORKGREMLIN_DISABLE 关掉上报（见 agents.js）。两种模式下
 *      它们的数据都只进议事厅自己的表，不碰 members / tasks。
 *      **工程模式的目录不是我们的，收尾时绝不删** —— 见 closeCouncil 里那两道锁。
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
const { RECIPES, parseVoteBlock, parseAnalysisBlock } = require('./agents');
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
  /** 工程模式的单轮超时：参与者要自己翻代码，比"动嘴"那种宽得多（见 shared/index.js） */
  const workspaceTimeoutMs = deps.workspaceTimeoutMs || DEFAULTS.COUNCIL_WORKSPACE_TURN_TIMEOUT_MS;
  const removeDir = deps.removeDir || ((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  /** 目录还在不在（工程模式起跑前要再确认一次，可注入） */
  const isDir = deps.isDir || ((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
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
   *
   * @param {{ctx:object, floor:object, prompt:string, allow:'none'|'read',
   *          mode:'vote'|'analysis', timeoutMs:number}} arg
   * @returns {Promise<{floorId:string, status:string, content:string|null, vote:string|null,
   *   voteReason:string|null, proposal:string|null, second:string|null,
   *   stance:string|null, findings:object|null, error:string|null,
   *   tokens:object|null, startedAt:number, endedAt:number, durationMs:number}>}
   */
  async function askOne({ ctx, floor, prompt, allow, mode, timeoutMs: perTurnMs }) {
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
        stance: null, findings: null,
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
        stance: null, findings: null,
        error: recipe ? '没有可用的命令行可执行文件' : `议事厅不支持 ${floor.floor_id} 这一层`,
        tokens: null, startedAt, endedAt: now(), durationMs: 0,
      };
    }

    const inv = recipe.build({ bin, prompt, allow });
    const r = await runTurn({
      ...inv,
      cwd: ctx.workDir,
      timeoutMs: perTurnMs,
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
      stance: null, findings: null,
      tokens: r.tokens || null, startedAt, endedAt, durationMs: r.durationMs,
      error: r.error || null,
      status: r.status === 'ok' ? 'ok' : r.status,
    };
    if (r.status !== 'ok') return base; // 失败 / 超时：正文和尾块都留空

    // 跑通了但**没给出可解析的尾块** —— 这跟"没跑成"要分开：它是说了话的，
    // 只是没按约定表态。正文照存，立场留空，status 记 'unparsed'。
    // 两种模式各解析各的（表决认 vote，分析认 stance），**认不出就不认**，绝不按语气猜。
    if (mode === 'analysis') {
      const a = parseAnalysisBlock(r.text);
      return {
        ...base,
        content: r.text,
        stance: a.stance,
        findings: a.findings,
        status: a.stance ? 'ok' : 'unparsed',
      };
    }
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
        stance: null, findings: null,
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
      stance: u.stance,
      // 结构化要点落库时**序列化**成文本：DB 那一列是 TEXT，查询/复现要看的是当时的原文，
      // 不给它建表（这三条是展示用的，不参与任何判定）。null 照旧是 null，不写成 '{}'。
      findingsJson: u.findings ? JSON.stringify(u.findings) : null,
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
        // 分析模式那两个字段走 WS 时是**已解析的对象**（HTTP 那条路给的是 TEXT）——
        // 前端归一函数两种都要吃，见 renderer/src/lib/councilTimeline.js 的 normFindings
        stance: u.stance, findings: u.findings,
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
    // **只删我们自己建的那个临时目录。**
    // 工程模式下 cwd 是用户的真实工程（ctx.tmpDir 为 null、ownsTmpDir 为 false）——
    // 这两道锁缺一条，这里就变成 `rm -rf 用户的工程`。`ownsTmpDir` 看起来冗余
    // （tmpDir 非空本来就等于"我们建的"），它是给以后的人看的：改这块代码时先读懂这条。
    if (ctx.ownsTmpDir && ctx.tmpDir) {
      try {
        removeDir(ctx.tmpDir);
      } catch {
        /* 删不掉就留着，不要因为清理失败把整场会判成失败 */
      }
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

    // 在哪儿谈（与怎么谈正交，见 schema.sql 里 councils 的注释）：
    //   · 工程模式 —— 用**用户的**目录。注意 ctx.tmpDir 保持 null：收尾时那个"删目录"
    //     的分支因此不会碰到它（见 closeCouncil 里那两道锁）。
    //   · 隔离模式 —— 现建一个一次性临时目录，收尾即删。与改动前逐字相同。
    const workspace = council.workspace_path ? String(council.workspace_path) : '';
    const mode = council.mode === 'analysis' ? 'analysis' : 'vote';
    const allow = workspace ? 'read' : 'none';
    const perTurnMs = workspace ? workspaceTimeoutMs : timeoutMs;

    let tmpDir = null;
    let workDir = workspace;
    if (workspace) {
      // 发起时校验过一次，但用户可能在这两步之间把它删了 —— 起跑前再确认一次。
      // 不确认的话，四个参与者会各自失败一次，最后报一个"谁都没表态"的会，看不出真因。
      if (!isDir(workspace)) {
        return repo.finishCouncil(councilId, {
          verdict: 'failed', error: `工作目录不存在或不是目录：${workspace}`, endedAt: now(),
        });
      }
    } else {
      // 临时目录建不出来就到此为止 —— 已经标成 running 了，必须给它一个结局，
      // 否则库里会留一场谁也取消不掉的僵尸会（只有下次启动的对账才会收拾）
      try {
        tmpDir = mkdtemp(TMP_PREFIX);
      } catch (err) {
        return repo.finishCouncil(councilId, {
          verdict: 'failed', error: `建不出隔离目录：${err && err.message}`, endedAt: now(),
        });
      }
      workDir = tmpDir;
    }

    const ctx = {
      councilId, cancelled: false, closed: false, children: new Set(),
      tmpDir, ownsTmpDir: Boolean(tmpDir), workDir,
    };
    active.set(councilId, ctx);
    emit(WS_EVENTS.COUNCIL, { councilId, status: 'running', mode, workspace: workspace || null });

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
      const analysis = mode === 'analysis';
      let proposal = council.topic;
      let proposalFrom = 'chair';
      let history = [];
      let verdict = null;
      let verdictRound = null;

      for (let roundNo = 1; roundNo <= maxRounds; roundNo += 1) {
        if (ctx.cancelled) break;

        repo.setCouncilRound(councilId, roundNo);
        // 分析模式没有"桌上那份提案"——proposal_* 留空，别把议题冒充成一份被人表决过的提案
        repo.upsertRound({
          councilId, roundNo, kind: 'debate',
          proposalText: analysis ? null : proposal,
          proposalFrom: analysis ? null : proposalFrom,
          agree: 0, disagree: 0, abstain: 0, invalid: 0, consensus: 0, startedAt: now(), endedAt: null,
        });
        emit(WS_EVENTS.COUNCIL, {
          councilId, roundNo, phase: 'debate', mode,
          proposal: analysis ? null : proposal,
          proposalFrom: analysis ? null : proposalFrom,
        });

        // 并发问所有人 —— 一轮里几个人是各自独立的，串行只会白白多等几倍时间
        const prompts = participants.map((floor) => ({
          floor,
          prompt: buildSpeechPrompt({
            topic: council.topic, materials,
            proposal: analysis ? '' : proposal,
            proposalFrom: analysis ? '' : proposalFrom,
            roundNo, maxRounds, history,
            floorId: floor.floor_id, floorName: floorName(floor.floor_id),
            mode, workspace: workspace || null,
          }),
        }));
        for (const floor of participants) repo.setParticipantStatus(councilId, floor.floor_id, 'running', null);
        const answers = await Promise.all(
          prompts.map((p) => askOneSafe({ ctx, ...p, allow, mode, timeoutMs: perTurnMs }))
        );

        if (ctx.cancelled) break;

        for (const a of answers) {
          recordUtterance(councilId, roundNo, a);
          // 出席者的总状态 = 它**最近一轮**的结果（每一轮的细节在 utterances 里，不在这儿糊）
          repo.setParticipantStatus(councilId, a.floorId, a.status === 'ok' ? 'ok' : 'failed', a.error);
        }

        // 进历史的发言要带轮次和楼层名 —— renderHistory 按轮次分组、按名字称呼，
        // answers 里只有 floorId
        history = [
          ...history,
          ...answers.map((a) => ({ ...a, roundNo, floorName: floorName(a.floorId) })),
        ];

        if (analysis) {
          // 分析模式**不判票、不换提案、没有提前结束**：跑满设定轮数。
          // 三个票型列记 0（这一场确实没人投票，不是"投了 0 票"），只把"这轮没能
          // 给出立场的人数"记进 invalid —— 那个口径两种模式是同一个意思。
          const invalid = answers.filter((a) => a.status !== 'ok').length;
          repo.upsertRound({
            councilId, roundNo, kind: 'debate', proposalText: null, proposalFrom: null,
            agree: 0, disagree: 0, abstain: 0, invalid, consensus: 0,
            startedAt: null, endedAt: now(),
          });
          emit(WS_EVENTS.COUNCIL, { councilId, roundNo, mode, round: { agree: 0, disagree: 0, abstain: 0, invalid, consensus: 0 } });
          continue;
        }

        const decision = decideRound({ utterances: answers, threshold, maxRounds, roundNo });
        repo.upsertRound({
          councilId, roundNo, kind: 'debate', proposalText: proposal, proposalFrom,
          agree: decision.tally.agree, disagree: decision.tally.disagree,
          abstain: decision.tally.abstain, invalid: decision.tally.invalid,
          consensus: decision.consensus ? 1 : 0, startedAt: null, endedAt: now(),
        });
        emit(WS_EVENTS.COUNCIL, { councilId, roundNo, mode, round: { ...decision.tally, consensus: decision.consensus } });

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

      // 分析模式跑满轮数就是正常收场：**没有"谈成没谈成"这回事**，所以 verdict 是
      // 'reported'（已呈报），不是一个判定 —— 界面照这份记录出简报，不合成结论。
      // 表决模式兜底：循环跑满都没 break（理论上不会，最后一轮 decision.done 必为 true）
      if (!verdict) verdict = analysis ? 'reported' : 'no_consensus';
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
