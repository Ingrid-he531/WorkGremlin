'use strict';

/**
 * The council room's state machine — turns one HTTP request into a moderated review loop that runs to
 * completion with nobody watching.
 *
 *   draft ──start()──▶ running
 *     round 0          moderator: topic decomposition + review assignment
 *     round 1..N       proposal → independent reviews → moderator convergence
 *                      (every round is persisted as a RoundResult)
 *     final phase      moderator adjudication → main answerer final draft + change notes
 *     wrap-up          write report files → persist verdict → clean a temp dir we own → broadcast
 *
 * There is **no vote, no vote tally, and no threshold**. A high convergence score never ends a
 * meeting early; a **failed turn does** — see `abortOnTurnFailure`. Otherwise rounds run to
 * `max_rounds`, and the user's cancel can stop one at any point.
 *
 * Four invariants:
 *   1. **Never fabricate**. A timed-out / crashed / unparseable turn is recorded with its real status
 *      and raw error; its contribution stays empty. No opinion is supplied on its behalf.
 *   2. **The convergence score is server-computed** from the reviews and the moderator's conflict list
 *      (see convergence.js). A model-reported score is never read, let alone trusted.
 *   3. **Isolation**. Participants are read-only. A user-supplied workspace is never written to and
 *      never deleted; only a temp directory this orchestrator created is removed at wrap-up. Report
 *      files go only into `~/.workgremlin/councils/<id>/`.
 *   4. **Processes are reaped**. In-flight children are kept in `ctx.children`; cancel and shutdown
 *      kill each process group.
 *
 * Dependencies are injectable (`runTurn` / `cliPathOf` / `mkdtemp` / `now`), so the flow can be tested
 * end-to-end with fake participants.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULTS, WS_EVENTS } = require('@workgremlin/shared');

const { runOnce, killTree } = require('./runner');
const { RECIPES } = require('./agents');
const {
  buildPlanPrompt,
  buildProposalPrompt,
  buildReviewPrompt,
  buildModerationPrompt,
  buildAdjudicationPrompt,
  buildFinalDraftPrompt,
  buildBriefText,
} = require('./prompt');
const {
  parsePlanBlock,
  parseProposalBlock,
  parseReviewBlock,
  parseModerationBlock,
  parseAdjudicationBlock,
  parseFinalBlock,
} = require('./parse');
const { computeStats, consistencyWarnings, finalWarnings } = require('./convergence');
const { buildReportJson, writeCouncilReports } = require('./report');
const { cliPathOf } = require('./floors');

/** Temp directory prefix: recognizable at a glance in the process list as left by the council room */
const TMP_PREFIX = 'wg-council-';

/** Phase names used in error messages (the UI has its own translations; this is for the stored text) */
const PHASE_ZH = {
  brief: '议题陈述',
  plan: '议题拆解',
  proposal: '主答提案',
  review: '评审',
  moderation: '主持人汇总',
  adjudication: '最终裁决',
  final: '最终交付',
};

/** Human-readable label for a normalized failure class (the raw CLI text is always shown separately). */
const ERROR_KIND_ZH = {
  auth: '账号未登录或无权限',
  model: '模型不可用',
  network: '网络不通',
  quota: '额度或限流',
  timeout: '超时',
  meeting_timeout: '整场超时',
  protocol: '输出格式不符',
  spawn: '命令起不来',
  exit: '进程异常退出',
  output_limit: '输出过大',
  provider: '命令行报错',
  unknown: '未归类失败',
};

/** A transient failure is worth one more attempt; auth/model/quota/protocol failures are not. */
const TRANSIENT_KINDS = new Set(['timeout', 'network']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** DB snake_case → camelCase used by prompts */
function materialOf(row) {
  return {
    path: row.path,
    content: row.content,
    bytesTotal: row.bytes_total,
    bytesIncluded: row.bytes_included,
    truncated: Boolean(row.truncated),
  };
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Assemble the RoundResult exposed to the API/prompts from a council_rounds row + review rows. */
function roundResultOf(row, reviewRows) {
  const moderator = parseJson(row.moderator_json, null);
  const stats = parseJson(row.stats_json, null);
  return {
    round: row.round_no,
    proposal: {
      version: row.version != null ? row.version : null,
      content: row.proposal_text != null ? row.proposal_text : '',
      diffFromPrev: row.diff_from_prev != null ? row.diff_from_prev : null,
    },
    reviews: (reviewRows || []).map((r) => ({
      reviewer: r.reviewer,
      severity: r.severity,
      dimension: r.dimension,
      issue: r.issue,
      evidence: r.evidence != null ? r.evidence : undefined,
      suggestion: r.suggestion,
      stance: r.stance,
    })),
    moderator: {
      consensus: (moderator && moderator.consensus) || [],
      openIssues: (moderator && moderator.openIssues) || [],
      conflicts: (moderator && moderator.conflicts) || [],
      revisionDirectives: (moderator && moderator.revisionDirectives) || [],
      convergenceScore: stats && typeof stats.score === 'number' ? stats.score : null,
    },
    stats,
    warnings: (moderator && moderator.warnings) || [],
  };
}

/**
 * @param {{repo:object, broadcast?:Function, deps?:object}} arg
 *   broadcast(project, type, payload) — the council room is independent of projects, so project is null.
 */
function createCouncilOrchestrator({ repo, broadcast, deps = {} }) {
  const runTurn = deps.runTurn || runOnce;
  const now = deps.now || (() => Date.now());
  const mkdtemp = deps.mkdtemp || ((prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const timeoutMs = deps.timeoutMs || DEFAULTS.COUNCIL_TURN_TIMEOUT_MS;
  const workspaceTimeoutMs = deps.workspaceTimeoutMs || DEFAULTS.COUNCIL_WORKSPACE_TURN_TIMEOUT_MS;
  const meetingTimeoutMs = deps.meetingTimeoutMs || DEFAULTS.COUNCIL_MEETING_TIMEOUT_MS;
  const turnRetries =
    deps.turnRetries != null ? Math.max(0, Number(deps.turnRetries) || 0) : DEFAULTS.COUNCIL_TURN_RETRIES;
  const removeDir = deps.removeDir || ((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  const isDir =
    deps.isDir ||
    ((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  const cliPath = deps.cliPathOf || ((floorId) => cliPathOf(floorId));

  /** In-flight meetings: councilId → { cancelled, closed, children, tmpDir, ownsTmpDir, workDir } */
  const active = new Map();

  const emit = (payload) => {
    if (typeof broadcast !== 'function') return;
    try {
      broadcast(null, WS_EVENTS.COUNCIL, payload);
    } catch {
      /* a failed broadcast must not affect the meeting — the frontend polls to catch up */
    }
  };

  function floorName(floorId) {
    const r = RECIPES[floorId];
    return (r && r.name) || floorId;
  }

  /**
   * Mark and broadcast "who is working on what right now".
   *
   * A turn can take minutes and produces no utterance until it ends, so without this the page has
   * nothing to show after creation. It is also kept on the active context so a page reload can
   * recover it (`progressOf`) — broadcast alone would only cover clients that were already open.
   */
  function markProgress(ctx, roundNo, phase, floors) {
    ctx.progress = {
      roundNo,
      phase,
      floors: Array.isArray(floors) ? floors : [],
      startedAt: now(),
    };
    emit({ councilId: ctx.councilId, status: 'running', ...ctx.progress });
  }

  /**
   * Run one participant once and return its raw output. Parsing is deliberately **not** done here:
   * each phase has its own parser, and "spoke but did not follow the protocol" must stay distinct from
   * "did not speak at all".
   */
  async function askOne({ ctx, floor, prompt, perTurnMs }) {
    const startedAt = now();
    const recipe = RECIPES[floor.floor_id];
    const bin = floor.cli_path || cliPath(floor.floor_id);

    if (ctx.cancelled || ctx.closed) {
      return {
        floorId: floor.floor_id,
        status: 'skipped',
        content: null,
        model: null,
        error: '这一轮还没发问，这场会就已经在收尾了',
        errorKind: null,
        raw: '',
        tokens: null,
        startedAt,
        endedAt: now(),
        durationMs: 0,
      };
    }

    // Whole-meeting budget: a retry or a slow turn must not push the meeting past its wall-clock cap.
    const remainingMs = ctx.deadline ? ctx.deadline - now() : Number.POSITIVE_INFINITY;
    if (remainingMs <= 0) {
      const at = now();
      return {
        floorId: floor.floor_id,
        status: 'timeout',
        content: null,
        model: null,
        error: `整场会议已超过 ${Math.round(meetingTimeoutMs / 60_000)} 分钟预算，这一轮没有开始`,
        errorKind: 'meeting_timeout',
        raw: '',
        tokens: null,
        startedAt: at,
        endedAt: at,
        durationMs: 0,
      };
    }
    const turnMs = Number.isFinite(remainingMs) ? Math.max(1, Math.min(perTurnMs, remainingMs)) : perTurnMs;
    if (!recipe || !bin) {
      return {
        floorId: floor.floor_id,
        status: 'failed',
        content: null,
        model: null,
        error: recipe ? '没有可用的命令行可执行文件' : `议事厅不支持 ${floor.floor_id} 这一层`,
        errorKind: 'spawn',
        raw: '',
        tokens: null,
        startedAt,
        endedAt: now(),
        durationMs: 0,
      };
    }

    const inv = recipe.build({ bin, prompt, model: floor.model || null, cwd: ctx.workDir });
    const r = await runTurn({
      ...inv,
      cwd: ctx.workDir,
      timeoutMs: turnMs,
      agent: recipe.agent,
      onChild: (child) => {
        if (ctx.cancelled || ctx.closed) {
          killTree(child);
          return;
        }
        ctx.children.add(child);
        child.once('close', () => ctx.children.delete(child));
      },
    });

    return {
      floorId: floor.floor_id,
      status: r.status, // ok / failed / timeout / unparsed
      content: r.status === 'ok' ? r.text : null,
      model: r.model || null,
      tokens: r.tokens || null,
      error: r.error || null,
      errorKind: r.errorKind || null,
      raw: r.raw || '',
      attempts: 1,
      startedAt,
      endedAt: now(),
      durationMs: r.durationMs,
    };
  }

  /**
   * A participant blowing up must not take the whole meeting down; record it honestly instead.
   *
   * One retry for transient failures only. A network hiccup or a process that timed out once is worth
   * another shot; an expired login, a retired model, a quota error or a protocol violation will say the
   * same thing again and only burn the meeting's time budget.
   */
  async function askOneSafe(arg) {
    let last = null;
    const attempts = 1 + Math.max(0, Number(turnRetries) || 0);
    for (let i = 0; i < attempts; i += 1) {
      try {
        last = await askOne(arg);
      } catch (err) {
        const at = now();
        last = {
          floorId: arg.floor.floor_id,
          status: 'failed',
          content: null,
          model: null,
          tokens: null,
          error: `调用参与者时出错：${err && err.message}`,
          errorKind: 'unknown',
          raw: '',
          attempts: i + 1,
          startedAt: at,
          endedAt: at,
          durationMs: 0,
        };
      }
      last.attempts = i + 1;
      const retryable = TRANSIENT_KINDS.has(last.errorKind) && last.status !== 'ok';
      if (!retryable || i === attempts - 1 || arg.ctx.cancelled || arg.ctx.closed) break;
      // Short backoff: the automations that fail this way usually recover in a second or two.
      await sleep(2_000 * (i + 1));
    }
    return last;
  }

  /**
   * Persist one turn and broadcast it.
   *
   * @param {string} councilId
   * @param {number} roundNo
   * @param {string} floorId
   * @param {string} phase
   * @param {{status:string, content:string|null, model:string|null, tokens:object|null,
   *          error:string|null, raw:string, startedAt:number, endedAt:number,
   *          durationMs:number}} turn
   * @param {{status?:string, content?:string|null, parseDropped?:number}} [override]
   */
  function recordUtterance(councilId, roundNo, floorId, phase, turn, override = {}) {
    const status = override.status || turn.status || 'ok';
    const content = override.content !== undefined ? override.content : turn.content;
    const attemptNote = turn.attempts > 1 ? `（已重试 ${turn.attempts - 1} 次）` : '';
    const error =
      status === 'unparsed' && turn.raw
        ? `${turn.error || '输出解析不出内容'}${attemptNote}\n\n原始输出尾部：\n${turn.raw}`
        : turn.error
          ? `${turn.error}${attemptNote}`
          : null;
    repo.insertUtterance({
      councilId,
      roundNo,
      floorId,
      phase,
      content,
      model: turn.model,
      status,
      error,
      errorKind: turn.errorKind || null,
      inputTokens: turn.tokens ? turn.tokens.input : null,
      outputTokens: turn.tokens ? turn.tokens.output : null,
      cacheReadTokens: turn.tokens ? turn.tokens.cacheRead : null,
      cacheWriteTokens: turn.tokens ? turn.tokens.cacheWrite : null,
      parseDropped: override.parseDropped != null ? override.parseDropped : 0,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      durationMs: turn.durationMs,
    });
    emit({
      councilId,
      roundNo,
      phase,
      utterance: {
        roundNo,
        floorId,
        phase,
        content,
        model: turn.model || null,
        status,
        error: error || null,
        errorKind: turn.errorKind || null,
        durationMs: turn.durationMs,
      },
    });
  }

  function markParticipant(councilId, floorId, status, error) {
    const normalized = status === true ? 'ok' : status === false ? 'failed' : String(status || 'failed');
    try {
      repo.setParticipantStatus(councilId, floorId, normalized, error || null);
    } catch {
      /* participant status is display-only; a write failure must not abort the meeting */
    }
  }

  /**
   * Give every participant a terminal status before the report is built.
   *
   * Pending roles never got their turn, while an in-flight role either lost the meeting to a
   * cancellation or to an earlier failure. Terminal statuses are evidence and are never overwritten.
   */
  function settleParticipants(ctx, verdict, error = null) {
    for (const p of repo.listParticipants(ctx.councilId)) {
      if (p.status === 'pending') {
        repo.setParticipantStatus(ctx.councilId, p.floor_id, 'skipped', '这一角色没有轮到发言');
      } else if (p.status === 'running') {
        repo.setParticipantStatus(
          ctx.councilId,
          p.floor_id,
          verdict === 'cancelled' ? 'cancelled' : 'failed',
          error || (verdict === 'cancelled' ? '会议已取消' : '会议提前结束')
        );
      }
    }
  }

  /**
   * Wrap-up: persist verdict, write the report archive, clean a temp dir we own, broadcast.
   *
   * `report` is optional. When present it is already the built report model; writing it is best-effort
   * but every failure is recorded, never swallowed silently.
   */
  function closeCouncil(ctx, { verdict, error = null, report = null, reportFiles = null }) {
    if (ctx.closed) return repo.getCouncil(ctx.councilId);
    ctx.closed = true;
    ctx.progress = null;
    for (const child of ctx.children) killTree(child);
    ctx.children.clear();

    try {
      settleParticipants(ctx, verdict, error);
    } catch {
      /* participant status is display-only; never let it block the close */
    }

    let c = repo.getCouncil(ctx.councilId);
    try {
      c = repo.finishCouncil(ctx.councilId, { verdict, error, endedAt: now() });
    } catch (err) {
      /* finish must not throw out of the fire-and-forget start(); the startup sweep is the fallback */
      if (!c) throw err;
    }

    // Delete **only** the temp directory this orchestrator created. A user workspace is never touched.
    if (ctx.ownsTmpDir && ctx.tmpDir) {
      try {
        removeDir(ctx.tmpDir);
      } catch {
        /* a cleanup failure must not mark the meeting failed */
      }
    }
    active.delete(ctx.councilId);
    emit({
      councilId: ctx.councilId,
      status: c ? c.status : verdict === 'cancelled' ? 'cancelled' : verdict === 'failed' ? 'failed' : 'done',
      verdict,
      error,
      reportFiles,
    });
    return c;
  }

  /**
   * Decide the final verdict from what the final phase actually produced.
   *   completed — adjudication parsed and the final draft exists
   *   partial   — at least one round ran, but a final-phase turn is missing
   *   failed    — no usable round at all
   */
  function finalVerdict(rounds, adjudication, finalDraft) {
    if (!rounds.length) return 'failed';
    if (adjudication && adjudication.parsed && adjudication.decision && finalDraft && finalDraft.content.trim()) {
      return 'completed';
    }
    return 'partial';
  }

  /** Same mapping repo.finishCouncil applies, so the archived report agrees with the row. */
  function statusOfVerdict(verdict) {
    if (verdict === 'completed' || verdict === 'partial' || verdict === 'needs_clarification') return 'done';
    if (verdict === 'cancelled') return 'cancelled';
    return 'failed';
  }

  /**
   * Build, write and persist the report. Shared by the normal wrap-up and by the early/failure
   * paths so an interrupted meeting still leaves whatever evidence exists on disk.
   *
   * Every step is best-effort but never silent: a failure is appended to `warnings`, which the
   * report itself carries.
   *
   * @returns {{report:object|null, files:string[]}}
   */
  function archiveReport(arg) {
    const warnings = Array.isArray(arg.warnings) ? arg.warnings : [];
    let reportModel;
    try {
      try {
        settleParticipants(
          { councilId: arg.councilId },
          arg.verdict,
          arg.error || (arg.warnings && arg.warnings.length ? arg.warnings[0].message : null)
        );
      } catch {
        /* participant status is display-only; the archive must still be written */
      }
      const councilRow = repo.getCouncil(arg.councilId) || {};
      reportModel = buildReportJson({
        // The archive is built before closeCouncil writes the verdict, so stamp the outcome here.
        // Otherwise report.json would forever say status=running / verdict=null.
        council: {
          ...councilRow,
          status: arg.verdict ? statusOfVerdict(arg.verdict) : councilRow.status,
          verdict: arg.verdict != null ? arg.verdict : councilRow.verdict,
          ended_at: now(),
        },
        participants: repo.listParticipants(arg.councilId),
        utterances: arg.utterances || repo.listUtterances(arg.councilId),
        rounds: arg.rounds || [],
        reviews: repo.listReviews(arg.councilId),
        plan: arg.plan ? { ...arg.plan, text: arg.planText } : null,
        adjudication: arg.adjudication
          ? { ...arg.adjudication, text: arg.adjudicationText }
          : arg.adjudicationText
            ? { parsed: false, text: arg.adjudicationText }
            : null,
        finalDraft: arg.finalDraft || null,
        finalScore: arg.finalScore || null,
        warnings,
      });
    } catch (err) {
      warnings.push({
        code: 'report_build_failed',
        message: `生成报告失败：${err && err.message ? err.message : String(err)}`,
      });
      return { report: null, files: [] };
    }

    let written = { files: [] };
    try {
      written = writeCouncilReports({ councilId: arg.councilId, report: reportModel });
    } catch (err) {
      warnings.push({
        code: 'report_write_failed',
        message: `写入报告失败：${err && err.message ? err.message : String(err)}`,
      });
    }

    const allFiles = written.files;
    reportModel.files = allFiles;
    reportModel.summary.warnings = warnings;

    try {
      repo.insertReport({
        councilId: arg.councilId,
        adjudicationJson: arg.adjudication ? JSON.stringify(arg.adjudication) : null,
        adjudicationText: arg.adjudicationText || null,
        finalDraftText: arg.finalDraft ? arg.finalDraft.content : null,
        changeNotes: arg.finalDraft ? arg.finalDraft.changeNotes : null,
        reportJson: JSON.stringify(reportModel),
        filesJson: JSON.stringify(allFiles),
        createdAt: now(),
      });
    } catch (err) {
      warnings.push({
        code: 'report_persist_failed',
        message: `保存报告记录失败：${err && err.message ? err.message : String(err)}`,
      });
    }
    return { report: reportModel, files: allFiles };
  }

  /**
   * Start a meeting. It resolves only when the whole meeting has run. The route calls it
   * fire-and-forget, so it **throws nothing**: a throw would become an unhandled rejection and take
   * the service down.
   */
  async function start(councilId) {
    const council = repo.getCouncil(councilId);
    if (!council) return null;
    if (!repo.markCouncilRunning(councilId, now())) return repo.getCouncil(councilId);

    const workspace = council.workspace_path ? String(council.workspace_path) : '';
    const perTurnMs = workspace ? workspaceTimeoutMs : timeoutMs;

    let tmpDir = null;
    let workDir = workspace;
    if (workspace) {
      if (!isDir(workspace)) {
        return repo.finishCouncil(councilId, {
          verdict: 'failed',
          error: `工作目录不存在或不是目录：${workspace}`,
          endedAt: now(),
        });
      }
    } else {
      try {
        tmpDir = mkdtemp(TMP_PREFIX);
      } catch (err) {
        return repo.finishCouncil(councilId, {
          verdict: 'failed',
          error: `建不出隔离目录：${err && err.message}`,
          endedAt: now(),
        });
      }
      workDir = tmpDir;
    }

    const ctx = {
      councilId,
      cancelled: false,
      closed: false,
      children: new Set(),
      tmpDir,
      ownsTmpDir: Boolean(tmpDir),
      workDir,
      workspaceProvided: Boolean(workspace),
      deadline: now() + meetingTimeoutMs,
    };
    active.set(councilId, ctx);
    emit({ councilId, status: 'running', workspace: workspace || null });
    markProgress(ctx, 0, 'brief', []);

    const rounds = [];
    let plan = null;
    let planText = null;
    let adjudication = null;
    let adjudicationText = null;
    let finalDraft = null;
    const globalWarnings = [];
    // Declared outside the try so the catch-all path can still archive attendance when something
    // unexpected interrupts the meeting.
    let participants = [];

    try {
      participants = repo.listParticipants(councilId);
      const moderator = participants.find((p) => p.role === 'moderator');
      const main = participants.find((p) => p.role === 'main');
      const reviewers = participants.filter((p) => p.role === 'reviewer');

      const missingRole = !moderator
        ? '缺少主持人'
        : !main
          ? '缺少主答'
          : !reviewers.length
            ? '至少需要一位评审'
            : null;
      if (missingRole) {
        return closeCouncil(ctx, { verdict: 'failed', error: `出席角色不完整：${missingRole}` });
      }

      const materials = repo.listMaterials(councilId).map(materialOf);
      const maxRounds = Math.max(
        1,
        Math.min(
          Number(council.max_rounds) || DEFAULTS.COUNCIL_ROUNDS_DEFAULT,
          DEFAULTS.COUNCIL_ROUNDS_MAX
        )
      );

      /**
       * Fail fast. One participant not answering ends the meeting right here instead of running
       * minutes of later turns that can no longer produce a usable round. Whatever was already
       * produced is archived and the real reason is kept.
       */
      function abortOnTurnFailure({ turn, floor, phase, roundNo, message, code = 'turn_failed' }) {
        const detail = turn.error || (turn.status === 'ok' ? '输出无法解析' : turn.status);
        const statusText =
          turn.status === 'unparsed'
            ? '输出未能解析（unparsed）'
            : turn.status === 'timeout'
              ? '超时（timeout）'
              : turn.status === 'failed'
                ? '调用失败（failed）'
                : turn.status;
        // The normalized class is what makes "model retired" distinguishable from "network down" in
        // the report header, before the user expands the raw turn.
        const kindLabel = turn.errorKind && ERROR_KIND_ZH[turn.errorKind] ? ` [${ERROR_KIND_ZH[turn.errorKind]}]` : '';
        const reasonBase =
          message ||
          `第 ${roundNo} 轮${PHASE_ZH[phase] || phase}（${floor.floor_id} ${floorName(
            floor.floor_id
          )}）${statusText}：${detail}`;
        const reason = `${reasonBase}${kindLabel}`;
        globalWarnings.push({ code, message: reason, round: roundNo });
        const verdict = rounds.length ? 'partial' : 'failed';
        const archived = archiveReport({
          councilId,
          workspace,
          participants,
          rounds,
          plan,
          planText,
          adjudication,
          adjudicationText,
          finalDraft,
          finalScore: rounds.length ? rounds[rounds.length - 1].stats : null,
          warnings: globalWarnings,
          verdict,
        });
        return closeCouncil(ctx, {
          verdict,
          error: reason,
          report: archived.report,
          reportFiles: archived.files,
        });
      }

      // ---- Round 0: the server puts the topic on the table (no model call), then the moderator plans.
      repo.setCouncilRound(councilId, 0);
      const briefText = buildBriefText(council.topic, materials);
      const briefAt = now();
      repo.insertUtterance({
        councilId,
        roundNo: 0,
        floorId: 'system',
        phase: 'brief',
        content: briefText,
        status: 'ok',
        startedAt: briefAt,
        endedAt: briefAt,
        durationMs: 0,
      });
      emit({
        councilId,
        roundNo: 0,
        phase: 'brief',
        utterance: { roundNo: 0, floorId: 'system', phase: 'brief', content: briefText, status: 'ok' },
      });

      const planStarted = now();
      markProgress(ctx, 0, 'plan', [moderator.floor_id]);
      const planTurn = await askOneSafe({
        ctx,
        floor: moderator,
        perTurnMs,
        prompt: buildPlanPrompt({
          topic: council.topic,
          materials,
          workspace: ctx.workDir || null,
          workspaceProvided: ctx.workspaceProvided,
          floorId: moderator.floor_id,
          floorName: floorName(moderator.floor_id),
          reviewers: reviewers.map((r) => ({
            floorId: r.floor_id,
            floorName: floorName(r.floor_id),
          })),
        }),
      });

      if (ctx.cancelled) return closeCouncil(ctx, { verdict: 'cancelled' });

      if (planTurn.status === 'ok') {
        plan = parsePlanBlock(planTurn.content);
        planText = planTurn.content;
      }
      recordUtterance(councilId, 0, moderator.floor_id, 'plan', planTurn, {
        status: planTurn.status === 'ok' ? (plan && plan.parsed ? 'ok' : 'unparsed') : planTurn.status,
      });
      const planStatus =
        planTurn.status === 'ok'
          ? plan && plan.parsed
            ? plan.needsClarification.length
              ? 'needs_clarification'
              : 'ok'
            : 'unparsed'
          : planTurn.status;
      markParticipant(councilId, moderator.floor_id, planStatus, planTurn.error);
      // No warning here: an unusable plan aborts below, and abortOnTurnFailure records the reason
      // (with code 'plan_unparsed' for a reply that parsed to nothing).
      repo.upsertRound({
        councilId,
        roundNo: 0,
        kind: 'plan',
        version: null,
        proposalText: null,
        diffFromPrev: null,
        proposalFrom: moderator.floor_id,
        moderatorJson: plan ? JSON.stringify(plan) : JSON.stringify({ parsed: false }),
        statsJson: null,
        startedAt: planStarted,
        endedAt: now(),
      });
      emit({
        councilId,
        roundNo: 0,
        phase: 'plan',
        plan,
        status: planTurn.status,
      });

      if (planTurn.status !== 'ok' || !plan || !plan.parsed) {
        return abortOnTurnFailure({
          turn: planTurn,
          floor: moderator,
          phase: 'plan',
          roundNo: 0,
          code: planTurn.status === 'ok' ? 'plan_unparsed' : 'turn_failed',
        });
      }

      if (plan.needsClarification.length) {
        const verdict = 'needs_clarification';
        const archived = archiveReport({
          councilId,
          workspace,
          participants,
          rounds,
          plan,
          planText,
          adjudication,
          adjudicationText,
          finalDraft,
          finalScore: null,
          warnings: globalWarnings,
          verdict,
        });
        return closeCouncil(ctx, {
          verdict,
          error: `主持人需要补充信息：${plan.needsClarification.join('；')}`,
          report: archived.report,
          reportFiles: archived.files,
        });
      }

      let previousProposal = null;
      let previousDirectives = [];

      for (let roundNo = 1; roundNo <= maxRounds; roundNo += 1) {
        if (ctx.cancelled) break;
        repo.setCouncilRound(councilId, roundNo);

        // ---------- proposal ----------
        markProgress(ctx, roundNo, 'proposal', [main.floor_id]);
        const proposalTurn = await askOneSafe({
          ctx,
          floor: main,
          perTurnMs,
          prompt: buildProposalPrompt({
            topic: council.topic,
            materials,
            workspace: ctx.workDir || null,
            workspaceProvided: ctx.workspaceProvided,
            floorId: main.floor_id,
            floorName: floorName(main.floor_id),
            roundNo,
            maxRounds,
            plan,
            previousRounds: rounds,
            directives: previousDirectives,
            priorProposal: previousProposal,
          }),
        });
        if (ctx.cancelled) return closeCouncil(ctx, { verdict: 'cancelled' });

        const proposalParsed =
          proposalTurn.status === 'ok' ? parseProposalBlock(proposalTurn.content) : null;
        const proposalContent = proposalParsed ? proposalParsed.content.trim() : '';
        const proposalOk = proposalTurn.status === 'ok' && Boolean(proposalContent);
        const proposalStatus = !proposalOk
          ? proposalTurn.status === 'ok'
            ? 'unparsed'
            : proposalTurn.status
          : proposalParsed.parsed
            ? 'ok'
            : 'unparsed';

        recordUtterance(councilId, roundNo, main.floor_id, 'proposal', proposalTurn, {
          status: proposalStatus,
          parseDropped: proposalParsed ? proposalParsed.dropped : 0,
        });
        markParticipant(councilId, main.floor_id, proposalStatus, proposalTurn.error);

        if (!proposalOk) {
          // No proposal = nothing to review. Do not recycle the previous version as if it were new.
          return abortOnTurnFailure({
            turn: proposalTurn,
            floor: main,
            phase: 'proposal',
            roundNo,
            message: `第 ${roundNo} 轮主答没有产出可用方案（${proposalStatus}）`,
            code: 'proposal_missing',
          });
        }

        const version = `v${roundNo}`;
        const diffFromPrev =
          roundNo === 1
            ? null
            : proposalParsed.diffFromPrev
              ? proposalParsed.diffFromPrev
              : null;
        if (roundNo > 1 && !diffFromPrev) {
          globalWarnings.push({
            code: 'missing_diff',
            message: `第 ${roundNo} 轮主答没有给出 diffFromPrev，无法核对相对上一版改了什么`,
          });
        }
        if (proposalParsed.parsed === false) {
          globalWarnings.push({
            code: 'proposal_unparsed',
            message: `第 ${roundNo} 轮主答没有给出可解析的提案 JSON 尾块`,
          });
        }

        const proposal = {
          version,
          content: proposalContent,
          diffFromPrev,
          addressed: proposalParsed.addressed,
        };
        repo.upsertRound({
          councilId,
          roundNo,
          kind: 'debate',
          version,
          proposalText: proposal.content,
          diffFromPrev,
          proposalFrom: main.floor_id,
          moderatorJson: null,
          statsJson: null,
          startedAt: now(),
          endedAt: null,
        });
        emit({ councilId, roundNo, phase: 'proposal', proposal });

        // ---------- reviews (parallel, independent) ----------
        repo.delReviewsFromRound(councilId, roundNo);
        for (const r of reviewers) repo.setParticipantStatus(councilId, r.floor_id, 'running', null);
        markProgress(
          ctx,
          roundNo,
          'review',
          reviewers.map((r) => r.floor_id)
        );

        const reviewTurns = await Promise.all(
          reviewers.map((r) =>
            askOneSafe({
              ctx,
              floor: r,
              perTurnMs,
              prompt: buildReviewPrompt({
                topic: council.topic,
                materials,
                workspace: ctx.workDir || null,
                workspaceProvided: ctx.workspaceProvided,
                floorId: r.floor_id,
                floorName: floorName(r.floor_id),
                roundNo,
                maxRounds,
                plan,
                proposal,
                previousDirectives,
                previousProposal,
              }),
            })
          )
        );
        if (ctx.cancelled) return closeCouncil(ctx, { verdict: 'cancelled' });

        const reviews = [];
        const submittedReviewers = [];
        for (let i = 0; i < reviewers.length; i += 1) {
          const reviewer = reviewers[i];
          const turn = reviewTurns[i];
          const parsed = turn.status === 'ok' ? parseReviewBlock(turn.content) : null;
          const mine = parsed ? parsed.reviews : [];
          const status = turn.status === 'ok' ? (parsed && parsed.parsed ? 'ok' : 'unparsed') : turn.status;
          recordUtterance(councilId, roundNo, reviewer.floor_id, 'review', turn, {
            status,
            parseDropped: parsed ? parsed.dropped : 0,
          });
          // A reviewer that produced a valid block (even with zero items) counts as submitted.
          if (status === 'ok') submittedReviewers.push(reviewer.floor_id);
          markParticipant(councilId, reviewer.floor_id, status, turn.error);
          for (const rv of mine) reviews.push({ ...rv, reviewer: reviewer.floor_id });
          emit({
            councilId,
            roundNo,
            phase: 'review',
            reviewer: reviewer.floor_id,
            reviews: mine,
            status,
            parseDropped: parsed ? parsed.dropped : 0,
          });
        }
        // Persist the points themselves (not just the raw utterance): the report, the CSV export,
        // and a reloaded page all read from council_reviews.
        repo.insertReviews(councilId, roundNo, reviews, now());

        // Every reviewer is required: an unanswered or unparseable one leaves the round without the
        // independent opinions the score depends on, so the meeting stops instead of pretending.
        const failedReviewers = reviewers.filter((r) => !submittedReviewers.includes(r.floor_id));
        if (failedReviewers.length) {
          const first = failedReviewers[0];
          const firstTurn = reviewTurns[reviewers.indexOf(first)];
          const detailOf = (turn) =>
            turn.error || (turn.status === 'ok' ? '输出无法解析' : turn.status);
          return abortOnTurnFailure({
            turn: firstTurn,
            floor: first,
            phase: 'review',
            roundNo,
            message: `第 ${roundNo} 轮评审没有答上来：${failedReviewers
              .map((r) => `${r.floor_id} ${floorName(r.floor_id)}（${detailOf(reviewTurns[reviewers.indexOf(r)])}）`)
              .join('、')}`,
            code: 'turn_failed',
          });
        }

        // ---------- moderator convergence ----------
        markProgress(ctx, roundNo, 'moderation', [moderator.floor_id]);
        repo.setParticipantStatus(councilId, moderator.floor_id, 'running', null);
        const moderationTurn = await askOneSafe({
          ctx,
          floor: moderator,
          perTurnMs,
          prompt: buildModerationPrompt({
            topic: council.topic,
            materials,
            workspace: ctx.workDir || null,
            workspaceProvided: ctx.workspaceProvided,
            floorId: moderator.floor_id,
            floorName: floorName(moderator.floor_id),
            roundNo,
            maxRounds,
            plan,
            proposal,
            reviews,
            previousDirectives,
          }),
        });
        if (ctx.cancelled) return closeCouncil(ctx, { verdict: 'cancelled' });

        const moderation =
          moderationTurn.status === 'ok' ? parseModerationBlock(moderationTurn.content) : null;
        const moderationStatus =
          moderationTurn.status === 'ok'
            ? moderation && moderation.parsed
              ? 'ok'
              : 'unparsed'
            : moderationTurn.status;
        recordUtterance(councilId, roundNo, moderator.floor_id, 'moderation', moderationTurn, {
          status: moderationStatus,
          parseDropped: moderation ? moderation.dropped : 0,
        });
        markParticipant(councilId, moderator.floor_id, moderationStatus, moderationTurn.error);

        if (moderationTurn.status !== 'ok' || !moderation || !moderation.parsed) {
          return abortOnTurnFailure({
            turn: moderationTurn,
            floor: moderator,
            phase: 'moderation',
            roundNo,
            code: moderationTurn.status === 'ok' ? 'moderation_unparsed' : 'turn_failed',
          });
        }

        const moderatorResult = {
          consensus: moderation ? moderation.consensus : [],
          openIssues: moderation ? moderation.openIssues : [],
          conflicts: moderation ? moderation.conflicts : [],
          revisionDirectives: moderation ? moderation.revisionDirectives : [],
        };
        const stats = computeStats(reviews, moderatorResult.conflicts);
        const warnings = consistencyWarnings({
          round: roundNo,
          reviews,
          moderator: moderatorResult,
          expectedReviewers: reviewers.map((r) => r.floor_id),
          submittedReviewers,
        });
        for (const w of warnings) globalWarnings.push({ ...w, round: roundNo });

        // The RoundResult contract includes convergenceScore on the moderator; the value is the
        // **server-computed** score, never the model's own number.
        moderatorResult.convergenceScore = stats.score;
        const moderatorStored = {
          ...moderatorResult,
          warnings,
        };
        const roundResult = {
          round: roundNo,
          proposal: {
            version,
            content: proposal.content,
            diffFromPrev,
          },
          reviews,
          moderator: moderatorResult,
          stats,
          warnings,
        };
        rounds.push(roundResult);

        repo.upsertRound({
          councilId,
          roundNo,
          kind: 'debate',
          version,
          proposalText: proposal.content,
          diffFromPrev,
          proposalFrom: main.floor_id,
          moderatorJson: JSON.stringify(moderatorStored),
          statsJson: JSON.stringify(stats),
          startedAt: null,
          endedAt: now(),
        });
        emit({ councilId, roundNo, phase: 'moderation', round: roundResult });

        previousProposal = { version, content: proposal.content, diffFromPrev };
        previousDirectives = moderatorResult.revisionDirectives;
      }

      if (ctx.cancelled) return closeCouncil(ctx, { verdict: 'cancelled' });

      if (!rounds.length) {
        return closeCouncil(ctx, { verdict: 'failed', error: '没有完成任何一轮评审' });
      }

      // ---- Final phase: adjudication → final draft ----
      const lastRound = rounds[rounds.length - 1];
      const lastReviews = lastRound.reviews;

      markProgress(ctx, lastRound.round, 'adjudication', [moderator.floor_id]);
      repo.setParticipantStatus(councilId, moderator.floor_id, 'running', null);
      const adjudicationTurn = await askOneSafe({
        ctx,
        floor: moderator,
        perTurnMs,
        prompt: buildAdjudicationPrompt({
          topic: council.topic,
          materials,
          workspace: ctx.workDir || null,
          workspaceProvided: ctx.workspaceProvided,
          floorId: moderator.floor_id,
          floorName: floorName(moderator.floor_id),
          maxRounds,
          rounds,
          proposal: lastRound.proposal,
          reviews: lastReviews,
          lastModeration: lastRound.moderator,
        }),
      });
      if (ctx.cancelled) return closeCouncil(ctx, { verdict: 'cancelled' });
      adjudication =
        adjudicationTurn.status === 'ok' ? parseAdjudicationBlock(adjudicationTurn.content) : null;
      adjudicationText = adjudicationTurn.content;
      recordUtterance(councilId, lastRound.round, moderator.floor_id, 'adjudication', adjudicationTurn, {
        status:
          adjudicationTurn.status === 'ok'
            ? adjudication && adjudication.parsed
              ? 'ok'
              : 'unparsed'
            : adjudicationTurn.status,
      });
      markParticipant(
        councilId,
        moderator.floor_id,
        adjudicationTurn.status === 'ok'
          ? adjudication && adjudication.parsed
            ? 'ok'
            : 'unparsed'
          : adjudicationTurn.status,
        adjudicationTurn.error
      );
      for (const w of finalWarnings({
        decision: adjudication ? adjudication.decision : null,
        lastRoundReviews: lastReviews,
      })) {
        globalWarnings.push(w);
      }
      emit({
        councilId,
        roundNo: lastRound.round,
        phase: 'adjudication',
        adjudication,
        status: adjudicationTurn.status,
      });

      if (adjudicationTurn.status !== 'ok' || !adjudication || !adjudication.parsed) {
        return abortOnTurnFailure({
          turn: adjudicationTurn,
          floor: moderator,
          phase: 'adjudication',
          roundNo: lastRound.round,
          message: '主持人最终裁决没有给出可解析的 JSON，报告按部分完成记录',
          code: 'adjudication_unparsed',
        });
      }

      markProgress(ctx, lastRound.round, 'final', [main.floor_id]);
      repo.setParticipantStatus(councilId, main.floor_id, 'running', null);
      const finalTurn = await askOneSafe({
        ctx,
        floor: main,
        perTurnMs,
        prompt: buildFinalDraftPrompt({
          topic: council.topic,
          materials,
          workspace: ctx.workDir || null,
          workspaceProvided: ctx.workspaceProvided,
          floorId: main.floor_id,
          floorName: floorName(main.floor_id),
          proposal: lastRound.proposal,
          adjudication,
          lastReviews,
          rounds,
        }),
      });
      if (ctx.cancelled) return closeCouncil(ctx, { verdict: 'cancelled' });
      const finalParsed = finalTurn.status === 'ok' ? parseFinalBlock(finalTurn.content) : null;
      const finalContent = finalParsed ? finalParsed.content.trim() : '';
      finalDraft = finalContent
        ? {
            content: finalContent,
            changeNotes: finalParsed.changeNotes,
            addressed: finalParsed.addressed,
          }
        : null;
      recordUtterance(councilId, lastRound.round, main.floor_id, 'final', finalTurn, {
        status:
          finalTurn.status === 'ok'
            ? finalContent
              ? finalParsed.parsed
                ? 'ok'
                : 'unparsed'
              : 'unparsed'
            : finalTurn.status,
        parseDropped: finalParsed ? finalParsed.dropped : 0,
      });
      markParticipant(
        councilId,
        main.floor_id,
        finalTurn.status === 'ok'
          ? finalContent
            ? finalParsed.parsed
              ? 'ok'
              : 'unparsed'
            : 'unparsed'
          : finalTurn.status,
        finalTurn.error
      );
      emit({
        councilId,
        roundNo: lastRound.round,
        phase: 'final',
        finalDraft,
        status: finalTurn.status,
      });

      if (finalTurn.status !== 'ok' || !finalContent || !finalParsed || !finalParsed.parsed) {
        return abortOnTurnFailure({
          turn: finalTurn,
          floor: main,
          phase: 'final',
          roundNo: lastRound.round,
          message: '主答没有产出最终交付稿，报告按部分完成记录',
          code: 'final_draft_missing',
        });
      }

      const verdict = finalVerdict(rounds, adjudication, finalDraft);
      if (verdict === 'partial') {
        globalWarnings.push({
          code: 'partial_run',
          message: '评审轮次已完成，但最终裁决或最终交付稿缺失',
        });
      }

      // ---- archive ----
      const archived = archiveReport({
        councilId,
        workspace,
        participants,
        rounds,
        plan,
        planText,
        adjudication,
        adjudicationText,
        finalDraft,
        finalScore: lastRound.stats,
        warnings: globalWarnings,
        verdict,
      });

      return closeCouncil(ctx, {
        verdict,
        error: verdict === 'partial' ? '最终阶段未完整完成，报告按部分完成保存' : null,
        report: archived.report,
        reportFiles: archived.files,
      });
    } catch (err) {
      // A meeting-level surprise: record it honestly, keep whatever was produced, and archive what
      // we can. This path must never throw — start() is called fire-and-forget.
      let archived = { report: null, files: [] };
      try {
        archived = archiveReport({
          councilId,
          workspace,
          participants,
          rounds,
          plan,
          planText,
          adjudication,
          adjudicationText,
          finalDraft,
          finalScore: rounds.length ? rounds[rounds.length - 1].stats : null,
          warnings: globalWarnings,
          verdict: 'failed',
        });
      } catch {
        /* archiving is best-effort here; the meeting outcome below must still be recorded */
      }
      return closeCouncil(ctx, {
        verdict: 'failed',
        error: `议事中断：${err && err.message}`,
        report: archived.report,
        reportFiles: archived.files,
      });
    }
  }

  /**
   * Cancel a running meeting: kill every in-flight process and let the main loop wrap up at its next
   * checkpoint.
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
   * Wrap up our own meetings first, then sweep rows left by a previous crash.
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

  const activeIds = () => [...active.keys()];

  /**
   * What a running meeting is doing right now. The detail endpoint returns it so a page reload still
   * shows the working indicator; `null` means nothing is in flight.
   */
  function progressOf(councilId) {
    const ctx = active.get(councilId);
    return ctx && ctx.progress ? { ...ctx.progress } : null;
  }

  return { start, cancel, shutdown, activeIds, progressOf };
}

module.exports = { createCouncilOrchestrator, materialOf, roundResultOf, TMP_PREFIX };
