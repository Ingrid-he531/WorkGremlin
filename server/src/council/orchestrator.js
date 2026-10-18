'use strict';

/**
 * The council room's state machine —— turns "hold a meeting" from one HTTP request into a sequence of
 * actions that has to run to completion with nobody watching.
 *
 *   draft ──start()──▶ running ──┬─ round 0: topic presentation (the server puts the question on the
 *                                │  table, no model call)
 *                                ├─ rounds 1..N: ask everyone concurrently → collect (or time out)
 *                                │    · vote mode: mechanical vote counting. Reached → consensus (with
 *                                │      **the verbatim proposal text that was on the table that round**
 *                                │      as the conclusion); not reached → take an objector's revision
 *                                │      as next round's proposal, continue; hitting the cap →
 *                                │      no_consensus (a legitimate outcome)
 *                                │    · analysis mode: no vote judging, no proposal swapping, run all
 *                                │      N rounds → reported
 *                                └─ wrap-up (persist verdict, clean the temp directory, broadcast)
 *
 * Two orthogonal switches (both read from the councils row, fixed at kick-off, never changed midway):
 *   · mode            —— 'vote' / 'analysis'
 *   · workspace_path  —— which directory the participants read. A value = the user's real project;
 *                        NULL = a freshly created throwaway temp directory (read-only either way)
 *
 * Three rules running all the way through:
 *   1. **Never fabricate**. Somebody timing out / crashing / producing unparseable output → record the
 *      status and the raw error honestly, leave the position NULL. The absent vote **does not
 *      participate** in consensus judging (see consensus.js: any non-position voids the round).
 *      Failure to agree is failure to agree —— do not synthesize a "conclusion" just to have something
 *      to show.
 *   2. **Isolation**. Isolated mode runs in a throwaway temp directory with all tools disabled; in
 *      project mode cwd is **the user's** directory with read-only tools only, and reporting is turned
 *      off via WORKGREMLIN_DISABLE (see agents.js). In both modes their data goes only into the
 *      council room's own tables and never touches members / tasks.
 *      **The project-mode directory is not ours; never delete it during wrap-up** —— see the two locks
 *      in closeCouncil.
 *   3. **Processes must be reaped cleanly**. In-flight child processes are registered in active —— both
 *      "cancel" and "shutdown" kill them together with their own children, leaving no orphans.
 *
 *      This only holds **when going through the shutdown flow** (`lifecycle.onClose` → `shutdown()`).
 *      When the process is taken away by `kill -9` or `process.exit()` directly, no code gets a chance
 *      to kill them and those few in-flight CLIs live until they finish answering the current round
 *      (they are one-shot invocations and exit by themselves afterwards). The cost is bounded but
 *      real —— **do not** wrap things up with process.exit on the server, that skips shutdown.
 *
 * Every dependency is injectable (runTurn / detect / mkdtemp / now), so the state machine can be run
 * end-to-end with **fake participants** without really calling models (see
 * server/test/councilOrchestrator.test.js).
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

/** Temp directory prefix: recognizable at a glance in the process list as left by the council room */
const TMP_PREFIX = 'wg-council-';

/** DB snake_case → camelCase used by prompts / decisions. Only converts fields of the council room's own tables */
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
 *   broadcast(project, type, payload) —— the council room has nothing to do with projects, pass null.
 *   deps is injectable: runTurn / detect / mkdtemp / now / timeoutMs, for tests.
 */
function createCouncilOrchestrator({ repo, broadcast, deps = {} }) {
  const runTurn = deps.runTurn || runOnce;
  const now = deps.now || (() => Date.now());
  /** Takes a **prefix**, returns a directory path (same semantics as fs.mkdtempSync, easy to swap in tests) */
  const mkdtemp = deps.mkdtemp || ((prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const timeoutMs = deps.timeoutMs || DEFAULTS.COUNCIL_TURN_TIMEOUT_MS;
  /** Per-round timeout in project mode: participants dig through code themselves, much wider than the
   *  "just talking" kind (see shared/index.js) */
  const workspaceTimeoutMs = deps.workspaceTimeoutMs || DEFAULTS.COUNCIL_WORKSPACE_TURN_TIMEOUT_MS;
  const removeDir = deps.removeDir || ((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  /** Whether the directory still exists (confirmed once more before kick-off in project mode, injectable) */
  const isDir = deps.isDir || ((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  /** Floor → executable path. Defaults to products detection; tests inject fakes */
  const cliPath = deps.cliPathOf || ((floorId) => cliPathOf(floorId));

  /** In-flight meetings: councilId → { cancelled:boolean, children:Set, tmpDir:string } */
  const active = new Map();

  const emit = (type, payload) => {
    if (typeof broadcast !== 'function') return;
    try {
      broadcast(null, type, payload);
    } catch {
      /* a failed broadcast must not affect the meeting —— the frontend polls to catch up anyway */
    }
  };

  /** Display name of a floor (the prompt needs it, so it knows whom it is facing) */
  function floorName(floorId) {
    const r = RECIPES[floorId];
    return (r && r.name) || floorId;
  }

  /**
   * Run one participant's round.
   *
   * @param {{ctx:object, floor:object, prompt:string,
   *          mode:'vote'|'analysis', timeoutMs:number}} arg
   * @returns {Promise<{floorId:string, status:string, content:string|null, vote:string|null,
   *   voteReason:string|null, proposal:string|null, second:string|null,
   *   stance:string|null, findings:object|null, error:string|null,
   *   tokens:object|null, startedAt:number, endedAt:number, durationMs:number}>}
   */
  async function askOne({ ctx, floor, prompt, mode, timeoutMs: perTurnMs }) {
    const startedAt = now();
    const recipe = RECIPES[floor.floor_id];
    const bin = floor.cli_path || cliPath(floor.floor_id);

    // Spawn nothing for calls that surface after wrap-up. **Nothing can get here today**: spawning and
    // registering the handle happen inside the same synchronous stretch (this function runs
    // synchronously all the way to `await runTurn`, and spawn inside runOnce is synchronous), so a
    // shutdown cannot slip in. It stays as an **invariant** ("never spawn during wrap-up") so that if
    // an await is ever added ahead of runTurn, this cannot quietly leak a CLI nobody kills.
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

    // Not installed (or not detected at the time) —— no guessing, no skipping, record it honestly
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

    const inv = recipe.build({ bin, prompt });
    const r = await runTurn({
      ...inv,
      cwd: ctx.workDir,
      timeoutMs: perTurnMs,
      agent: recipe.agent,
      onChild: (child) => {
        // Kill a late handle outright instead of hanging it on a registry nobody will walk again
        // (same reason as above, unreachable today)
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
    if (r.status !== 'ok') return base; // failed / timed out: both the body and the tail block stay empty

    // Ran fine but **no parseable tail block** —— kept apart from "did not run": it did speak, it just
    // did not take a position as agreed. The body is stored as-is, the position stays empty, and the
    // status records 'unparsed'.
    // Each mode parses its own (vote recognizes vote, analysis recognizes stance), and **unrecognized
    // means unrecognized** —— never guess from tone.
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
   * A wrapper around askOne: one participant blowing itself up must not take the **whole meeting**
   * down with it. Record it as "no position expressed this round" (that invalid vote) and let everyone
   * else be counted normally —— an absence voids the round, which is exactly what we want: one vote
   * short is one vote short, do not pass three people's opinions off as a four-person consensus.
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

  /** Persist one round's results + broadcast */
  function recordUtterance(councilId, roundNo, u) {
    repo.insertUtterance({
      councilId, roundNo, floorId: u.floorId, role: 'speaker',
      content: u.content, vote: u.vote, voteReason: u.voteReason,
      proposalText: u.proposal, secondFloor: u.second,
      stance: u.stance,
      // Structured points are **serialized** to text when persisted: that DB column is TEXT, and
      // querying / reproducing needs the verbatim original, so no table is built for them (these three
      // are display-only and take part in no decision). null stays null rather than becoming '{}'.
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
        // Those two analysis-mode fields travel over WS as an **already parsed object** (the HTTP path
        // hands back TEXT) —— the frontend's normalizer has to accept both, see normFindings in
        // renderer/src/lib/councilTimeline.js
        stance: u.stance, findings: u.findings,
        status: u.status, error: u.error, durationMs: u.durationMs,
      },
    });
  }

  /**
   * Wrap-up: persist verdict, clean the temp directory, broadcast, drop it from the in-flight table.
   *
   * Note that it does **not patch up** a round interrupted halfway: when cancelled, the last round
   * row's ended_at stays NULL and is left that way —— that round genuinely did not finish, and adding
   * an end time would be fabrication. Which round it stopped on is recorded by
   * councils.round_current, and the UI states plainly "cancelled while discussing round N".
   */
  function closeCouncil(ctx, { verdict, verdictRound = null, error = null }) {
    // Idempotent: on the shutdown path shutdown() already wrapped it up; writing again here would
    // overwrite its conclusion
    if (ctx.closed) return repo.getCouncil(ctx.councilId);
    ctx.closed = true;
    // Reap anything still in flight (normally empty on the clean-wrap-up path; only the cancel /
    // exception paths have any)
    for (const child of ctx.children) killTree(child);
    ctx.children.clear();
    const c = repo.finishCouncil(ctx.councilId, { verdict, verdictRound, error, endedAt: now() });
    // **Only delete the temp directory we created ourselves.**
    // In project mode cwd is the user's real project (ctx.tmpDir is null, ownsTmpDir is false) ——
    // missing either lock turns this into `rm -rf the user's project`. `ownsTmpDir` looks redundant
    // (a non-empty tmpDir already means "we created it"); it is there for whoever comes next: read this
    // note before changing this code.
    if (ctx.ownsTmpDir && ctx.tmpDir) {
      try {
        removeDir(ctx.tmpDir);
      } catch {
        /* leave it if it cannot be removed; never call the whole meeting failed over a cleanup failure */
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
   * Start a meeting. It only resolves once the whole meeting has run —— the route does **not await**
   * it (the start endpoint must return immediately), so this **throws nothing**: the route calls it
   * fire-and-forget, and a throw would become an unhandled rejection nobody catches (Node's default
   * behavior takes the whole service down). Missing meetings / wrong states return quietly.
   * @returns {Promise<object|null>} the councils row after wrap-up
   */
  async function start(councilId) {
    const council = repo.getCouncil(councilId);
    if (!council) return null;
    if (!repo.markCouncilRunning(councilId, now())) {
      // Not in draft (already running / already finished) —— do nothing, do not drag a running meeting
      // back to the starting line
      return repo.getCouncil(councilId);
    }

    // Where to talk (orthogonal to how, see the notes on councils in schema.sql). The council is always
    // **read-only**, so it always needs a directory to read:
    //   · user gave a workspace —— use **the user's** directory. Note ctx.tmpDir stays null: that is why
    //     the "delete directory" branch during wrap-up never touches it (see the two locks in closeCouncil).
    //   · no workspace —— create a throwaway temp directory now, delete it at wrap-up, and treat it just
    //     like a workspace directory (read-only tools; it is empty, so the participant really does go by
    //     the material on the table).
    const workspace = council.workspace_path ? String(council.workspace_path) : '';
    const mode = council.mode === 'analysis' ? 'analysis' : 'vote';
    const perTurnMs = workspace ? workspaceTimeoutMs : timeoutMs;

    let tmpDir = null;
    let workDir = workspace;
    if (workspace) {
      // It was validated once at creation, but the user may have deleted it between those two steps ——
      // confirm once more before kick-off. Without confirming, the four participants each fail once and
      // the meeting ends up reported as "nobody expressed a position", hiding the real cause.
      if (!isDir(workspace)) {
        return repo.finishCouncil(councilId, {
          verdict: 'failed', error: `工作目录不存在或不是目录：${workspace}`, endedAt: now(),
        });
      }
    } else {
      // Stop right here if the temp directory cannot be created —— it is already marked running, so it
      // must be given an ending, otherwise a zombie meeting nobody can cancel stays in the DB (only
      // next startup's reconciliation would clean it up)
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
      // A meeting with nobody in it is not "failed to agree", it never started —— do not let it run
      // N rounds and report no_consensus, that looks like it discussed something. The route validates
      // once more (at least two floors); this is the fallback.
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

      // ---- Round 0: topic presentation. No model call: put the topic + materials on the table and
      //      record it as a chair speech, so the timeline starts from "what the question is" rather
      //      than popping into existence at round 1.
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

      // ---- Rounds 1..N
      const analysis = mode === 'analysis';
      let proposal = council.topic;
      let proposalFrom = 'chair';
      let history = [];
      let verdict = null;
      let verdictRound = null;

      for (let roundNo = 1; roundNo <= maxRounds; roundNo += 1) {
        if (ctx.cancelled) break;

        repo.setCouncilRound(councilId, roundNo);
        // Analysis mode has no "proposal on the table" —— leave proposal_* empty rather than passing the
        // topic off as a proposal somebody voted on
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

        // Ask everyone concurrently —— participants in a round are independent of each other; going
        // serial only multiplies the waiting for nothing
        const prompts = participants.map((floor) => ({
          floor,
          prompt: buildSpeechPrompt({
            topic: council.topic, materials,
            proposal: analysis ? '' : proposal,
            proposalFrom: analysis ? '' : proposalFrom,
            roundNo, maxRounds, history,
            floorId: floor.floor_id, floorName: floorName(floor.floor_id),
            // The directory the participant actually reads: the user's workspace, or the throwaway temp
            // directory when none was given (both get the read-only role block).
            mode, workspace: ctx.workDir || null,
          }),
        }));
        for (const floor of participants) repo.setParticipantStatus(councilId, floor.floor_id, 'running', null);
        const answers = await Promise.all(
          prompts.map((p) => askOneSafe({ ctx, ...p, mode, timeoutMs: perTurnMs }))
        );

        if (ctx.cancelled) break;

        for (const a of answers) {
          recordUtterance(councilId, roundNo, a);
          // A participant's overall state = its **latest round's** result (per-round detail lives in
          // utterances, do not smear it in here)
          repo.setParticipantStatus(councilId, a.floorId, a.status === 'ok' ? 'ok' : 'failed', a.error);
        }

        // Speeches entering the history carry round and floor name —— renderHistory groups by round and
        // addresses by name, while answers only hold floorId
        history = [
          ...history,
          ...answers.map((a) => ({ ...a, roundNo, floorName: floorName(a.floorId) })),
        ];

        if (analysis) {
          // Analysis mode does **no vote judging, no proposal swapping, no early stop**: it runs the
          // configured number of rounds. The three vote-type columns record 0 (this meeting really had
          // nobody voting, not "0 votes were cast"), and only "how many failed to give a position this
          // round" goes into invalid —— that criterion means the same thing in both modes.
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
        // Next round: swap the proposal on the table for an objector's revision; with no revision
        // submitted, keep this one (this is not "the server picking a better one" —— that would mean
        // writing proposals for the participants, see the notes in consensus.js)
        if (decision.nextProposal) {
          proposal = decision.nextProposal.text;
          proposalFrom = decision.nextProposal.floorId;
        }
      }

      if (ctx.cancelled) return closeCouncil(ctx, { verdict: 'cancelled' });

      // Running all rounds in analysis mode is a normal ending: there is **no "reached agreement or
      // not"**, so the verdict is 'reported' (reported), not a judgment —— the UI draws a briefing from
      // this record and synthesizes no conclusion. Fallback for vote mode: the loop ran out without
      // breaking (theoretically impossible, the last round's decision.done is always true)
      if (!verdict) verdict = analysis ? 'reported' : 'no_consensus';
      return closeCouncil(ctx, { verdict, verdictRound });
    } catch (err) {
      // A meeting-level surprise (a failed persist, etc.) —— record failed honestly and keep the raw error
      return closeCouncil(ctx, { verdict: 'failed', error: `议事中断：${err && err.message}` });
    }
  }

  /**
   * Cancel a running meeting: kill every in-flight participant process and wrap up.
   * Processes run inside awaits; the ctx.cancelled flag makes the main loop exit at its next checkpoint.
   * @returns {boolean} whether a running meeting was really cancelled
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
   * Server shutdown: kill every in-flight participant and give each in-flight meeting a definite ending.
   *
   * The order matters —— **wrap up our own first, then sweep the rest**:
   *   · Meetings we handled ourselves get "interrupted by shutdown" = cancelled (with a reason), which
   *     is more accurate than a blanket failed;
   *   · The sweep step (failStaleCouncils) is left for `running` rows left behind by **another process's
   *     previous crash** —— their processes are long gone, so they can only honestly be marked failed.
   *     This is the same method startup reconciliation uses.
   * Reversing it (sweeping first, wrapping up after) lets the start() coroutine that wakes up later
   * rewrite the conclusion —— last writer wins.
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

  /** In-flight meetings (for tests and troubleshooting) */
  const activeIds = () => [...active.keys()];

  return { start, cancel, shutdown, activeIds };
}

module.exports = { createCouncilOrchestrator, materialOf, TMP_PREFIX };
