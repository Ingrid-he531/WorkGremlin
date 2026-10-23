'use strict';

/**
 * The council room's HTTP API — start / view / cancel / delete / read the report.
 *
 * Every check here is "do not fabricate" expressed at the API layer:
 *   · A floor not on the whitelist, or without its CLI → **reject**, no downgrading;
 *   · A material file that cannot be read / is binary → **reject the whole request and name the
 *     files**, no silent skipping;
 *   · A running meeting cannot be deleted (cancel first) — deleting it lets in-flight turns write into
 *     a council that no longer exists;
 *   · Roles are validated here: exactly one moderator, exactly one main, at least one reviewer, and
 *     the same floor cannot hold two roles.
 *
 * The start endpoint does **not await the whole meeting**: meetings take minutes, HTTP returns first.
 * Progress goes out over WS (WS_EVENTS.COUNCIL); on reconnect the frontend pulls `GET /councils/:id`.
 */

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULTS } = require('@workgremlin/shared');

const { listCouncilFloors, isCouncilFloor, probeFloors } = require('../../council/floors');
const { readMaterials } = require('../../council/materials');
const { roundResultOf } = require('../../council/orchestrator');

/** A meeting's id. Not auto-increment: these tables may be deleted wholesale, so keep order out of ids */
const newId = () => `c_${crypto.randomBytes(12).toString('hex')}`;

/**
 * Validation of the working directory. **Absolute paths only** — a relative path resolved against the
 * server's cwd is often not the directory the user had in mind.
 *
 * A leading `~` is expanded, then the path **must exist and be a directory**: letting a nonexistent
 * path through would make every participant fail once and finally report "nobody could review",
 * hiding the real cause.
 *
 * @param {unknown} raw workspacePath from the request body
 * @returns {{path:string}|{error:string}} an empty path = no workspace (the server uses a temp dir)
 */
function resolveWorkspaceDir(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return { path: '' };
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(s === '~' ? 1 : 2));
  if (!path.isAbsolute(s)) return { error: `工作目录要写绝对路径（留空则用一个临时目录）：${s}` };
  const resolved = path.resolve(s);
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    return { error: `工作目录不存在：${resolved}` };
  }
  if (!st.isDirectory()) return { error: `工作目录不是目录：${resolved}` };
  return { path: resolved };
}

const bad = (res, message) => res.status(400).json({ ok: false, error: { code: 'bad_payload', message } });
const notFound = (res) => res.status(404).json({ ok: false, error: { code: 'not_found', message: '没有这场会' } });

/**
 * "The browser went away" → stop working.
 *
 * Preflight runs **before** anything is persisted and can take a minute per floor, so it is the one
 * phase where cancel is free: aborting the request must kill the slow CLI and must never fall through
 * to `createCouncil`. Without this, a user who presses cancel would still get a meeting started in the
 * background — the response is simply lost.
 *
 * `stop()` detaches the listener before the normal response is written, so a completed request is not
 * mistaken for an aborted one ('close' also fires after a response is sent).
 */
function clientGoneGuard(res) {
  const ac = new AbortController();
  let listening = true;
  const onClose = () => {
    if (listening) ac.abort();
  };
  res.on('close', onClose);
  return {
    signal: ac.signal,
    stop() {
      listening = false;
      res.off('close', onClose);
    },
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

/**
 * @param {{repo:object, orchestrator:object, deps?:object}} arg
 *   deps.listFloors is injectable (tests swap out the real CLI detection)
 */
function createCouncilRouter({ repo, orchestrator, deps = {} }) {
  const router = express.Router();
  const listFloors = deps.listFloors || (() => listCouncilFloors());
  const probe = deps.probeFloors || probeFloors;

  const floorsById = () => new Map(listFloors().map((f) => [f.floorId, f]));

  /**
   * Optional per-seat model map: `{ "1F": "deepseek-v4.1-flash" }`. Only selected floors are kept;
   * a blank value means "use that CLI's own default". The length cap keeps a pasted log line from
   * becoming argv.
   */
  function modelsOf(raw, floorIds) {
    if (raw == null) return { models: {} };
    if (typeof raw !== 'object' || Array.isArray(raw)) return { error: '模型要写成 {楼层: 模型名} 的对象' };
    const models = {};
    for (const floorId of floorIds) {
      const value = raw[floorId];
      if (value == null) continue;
      const model = String(value).trim();
      if (!model) continue;
      if (model.length > 200) return { error: `${floorId} 的模型名太长了（最多 200 个字符）` };
      models[floorId] = model;
    }
    return { models };
  }

  const describeProbe = (r) => `${r.floorId}（${r.error || '说不了话'}）`;

  /* ------------------------------------------------------------------ Available floors */
  router.get('/councils/floors', (req, res) => {
    res.json({
      ok: true,
      floors: listFloors(),
      defaults: {
        maxRounds: DEFAULTS.COUNCIL_ROUNDS_DEFAULT,
        maxRoundsLimit: DEFAULTS.COUNCIL_ROUNDS_MAX,
        roles: [...DEFAULTS.COUNCIL_ROLES],
        severities: [...DEFAULTS.COUNCIL_SEVERITIES],
        stances: [...DEFAULTS.COUNCIL_STANCES],
        dimensions: [...DEFAULTS.COUNCIL_DIMENSIONS],
        severityWeights: { ...DEFAULTS.COUNCIL_SEVERITY_WEIGHTS },
        conflictWeight: DEFAULTS.COUNCIL_CONFLICT_WEIGHT,
        scoreMax: DEFAULTS.COUNCIL_SCORE_MAX,
        turnTimeoutMs: DEFAULTS.COUNCIL_TURN_TIMEOUT_MS,
        workspaceTurnTimeoutMs: DEFAULTS.COUNCIL_WORKSPACE_TURN_TIMEOUT_MS,
        preflightTimeoutMs: DEFAULTS.COUNCIL_PREFLIGHT_TIMEOUT_MS,
        meetingTimeoutMs: DEFAULTS.COUNCIL_MEETING_TIMEOUT_MS,
        turnRetries: DEFAULTS.COUNCIL_TURN_RETRIES,
        materialMaxBytes: DEFAULTS.COUNCIL_MATERIAL_MAX_BYTES,
        materialTotalMaxBytes: DEFAULTS.COUNCIL_MATERIAL_TOTAL_MAX_BYTES,
      },
    });
  });

  /* ------------------------------------------------------------------ Preflight */
  /**
   * "Can these floors actually speak right now?" — one tiny model call per selected floor.
   *
   * The executable check in `listCouncilFloors` is necessary but not sufficient: a CLI can be installed
   * and still be unable to answer (retired default model, expired login, unreachable provider). This
   * endpoint gives the UI a "试麦" button and lets `POST /councils` refuse before creating a meeting
   * that is guaranteed to die on round 0.
   */
  router.post('/councils/preflight', async (req, res) => {
    const body = req.body || {};
    const floors = Array.isArray(body.floors)
      ? [...new Set(body.floors.map((x) => String(x || '').trim()).filter(Boolean))]
      : [];
    if (!floors.length) return bad(res, '先选楼层再试麦');
    const unknown = floors.filter((f) => !isCouncilFloor(f));
    if (unknown.length) return bad(res, `这几个楼层议事厅请不了：${unknown.join('、')}`);

    const known = floorsById();
    const asleep = floors.filter((f) => !(known.get(f) || {}).ready);
    if (asleep.length) {
      const why = asleep.map((f) => `${f}：${(known.get(f) || {}).reason || '不可用'}`).join('；');
      return bad(res, `这些楼层现在请不动 —— ${why}`);
    }

    const parsed = modelsOf(body.models, floors);
    if (parsed.error) return bad(res, parsed.error);

    const guard = clientGoneGuard(res);
    try {
      const results = await probe(floors, {
        models: parsed.models,
        cliPathOf: (floorId) => (known.get(floorId) || {}).cliPath || null,
        signal: guard.signal,
      });
      if (guard.signal.aborted) return;
      res.json({ ok: results.every((r) => r.ok), results });
    } catch (err) {
      if (guard.signal.aborted) return;
      res.status(500).json({
        ok: false,
        error: { code: 'preflight_failed', message: `试麦失败：${(err && err.message) || '未知原因'}` },
      });
    } finally {
      guard.stop();
    }
  });

  /* ------------------------------------------------------------------ Start */
  router.post('/councils', async (req, res) => {
    const body = req.body || {};
    const topic = String(body.topic == null ? '' : body.topic).trim();
    if (!topic) return bad(res, '议题不能是空的');

    const ws = resolveWorkspaceDir(body.workspacePath);
    if (ws.error) return bad(res, ws.error);

    const moderator = String(body.moderator == null ? '' : body.moderator).trim();
    const main = String(body.main == null ? '' : body.main).trim();
    const reviewers = Array.isArray(body.reviewers)
      ? [...new Set(body.reviewers.map((x) => String(x == null ? '' : x).trim()).filter(Boolean))]
      : [];

    if (!moderator) return bad(res, '必须指定主持人');
    if (!main) return bad(res, '必须指定主答');
    if (!reviewers.length) return bad(res, '至少需要一位评审');
    if (moderator === main) return bad(res, '主持人和主答不能是同一个楼层');
    if (reviewers.includes(moderator)) return bad(res, '主持人不能再兼任评审');
    if (reviewers.includes(main)) return bad(res, '主答不能再兼任评审');

    const all = [moderator, main, ...reviewers];
    const known = floorsById();
    const unknown = all.filter((f) => !isCouncilFloor(f));
    if (unknown.length) return bad(res, `这几个楼层议事厅请不了：${unknown.join('、')}`);
    const asleep = all.filter((f) => !(known.get(f) || {}).ready);
    if (asleep.length) {
      const why = asleep.map((f) => `${f}：${(known.get(f) || {}).reason || '不可用'}`).join('；');
      return bad(res, `这些楼层现在请不动 —— ${why}`);
    }

    const parsedModels = modelsOf(body.models, all);
    if (parsedModels.error) return bad(res, parsedModels.error);

    // Gate: a floor that cannot answer one short sentence will not suddenly answer a full plan.
    // Doing this before `createCouncil` means a dead floor leaves no half-built meeting behind.
    const guard = clientGoneGuard(res);
    try {
      const probes = await probe(all, {
        models: parsedModels.models,
        cliPathOf: (floorId) => (known.get(floorId) || {}).cliPath || null,
        signal: guard.signal,
      });
      // Cancelled while probing: nothing was persisted, so there is nothing to clean up — and no
      // meeting may be created now that the user is gone.
      if (guard.signal.aborted) return;
      const broken = probes.filter((r) => !r.ok);
      if (broken.length) {
        return bad(res, `这些楼层现在说不了话 —— ${broken.map(describeProbe).join('；')}`);
      }
    } catch (err) {
      if (guard.signal.aborted) return;
      res.status(500).json({
        ok: false,
        error: { code: 'preflight_failed', message: `会前试麦失败：${(err && err.message) || '未知原因'}` },
      });
      return;
    } finally {
      guard.stop();
    }

    const wantedRounds = Number(body.maxRounds);
    const maxRounds =
      Number.isFinite(wantedRounds) && wantedRounds > 0
        ? Math.min(Math.floor(wantedRounds), DEFAULTS.COUNCIL_ROUNDS_MAX)
        : DEFAULTS.COUNCIL_ROUNDS_DEFAULT;

    const files = Array.isArray(body.files) ? body.files.map((f) => String(f || '')).filter(Boolean) : [];
    const materials = readMaterials(files);
    const broken = materials.filter((m) => m.error);
    if (broken.length) {
      return bad(res, `这些文件没能读进来：${broken.map((m) => `${m.path}（${m.error}）`).join('；')}`);
    }

    const id = newId();
    const createdAt = Date.now();
    const floorOf = (f) => known.get(f) || {};
    try {
      repo.createCouncil({ id, topic, workspacePath: ws.path || null, maxRounds, createdAt });
      for (const [floorId, role] of [
        [moderator, 'moderator'],
        [main, 'main'],
        ...reviewers.map((f) => [f, 'reviewer']),
      ]) {
        repo.insertParticipant({
          councilId: id,
          floorId,
          role,
          agent: floorOf(floorId).agent || '',
          cliPath: floorOf(floorId).cliPath || null,
          model: parsedModels.models[floorId] || null,
        });
      }
      materials.forEach((m, ord) => {
        repo.insertMaterial({
          councilId: id,
          ord,
          path: m.path,
          bytesTotal: m.bytesTotal,
          bytesIncluded: m.bytesIncluded,
          truncated: m.truncated,
          content: m.content,
        });
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: { code: 'internal', message: `建这场会失败：${(err && err.message) || '未知原因'}` },
      });
    }

    // Start only once persisted. **No await**: progress goes out over WS. start() never throws.
    orchestrator.start(id);

    res.status(201).json({ ok: true, council: repo.getCouncil(id) });
  });

  /* ------------------------------------------------------------------ List */
  router.get('/councils', (req, res) => {
    res.json({ ok: true, councils: repo.listCouncils(Number(req.query.limit) || 50) });
  });

  /* ------------------------------------------------------------------ Report */
  router.get('/councils/:id/report', (req, res) => {
    const council = repo.getCouncil(req.params.id);
    if (!council) return notFound(res);
    const row = repo.getReport(council.id);
    if (!row) return res.status(404).json({ ok: false, error: { code: 'not_found', message: '这场会还没有报告' } });
    res.json({
      ok: true,
      report: parseJson(row.report_json, null),
      adjudication: parseJson(row.adjudication_json, null),
      finalDraft: row.final_draft_text,
      changeNotes: row.change_notes,
      files: parseJson(row.files_json, []),
      createdAt: row.created_at,
    });
  });

  /* ------------------------------------------------------------------ Detail */
  router.get('/councils/:id', (req, res) => {
    const council = repo.getCouncil(req.params.id);
    if (!council) return notFound(res);

    const rounds = repo.listRounds(council.id);
    const reviews = repo.listReviews(council.id);
    const reportRow = repo.getReport(council.id);
    const reviewsByRound = new Map();
    for (const r of reviews) {
      if (!reviewsByRound.has(r.round_no)) reviewsByRound.set(r.round_no, []);
      reviewsByRound.get(r.round_no).push(r);
    }
    const roundResults = rounds
      .filter((r) => r.kind === 'debate')
      .map((r) => roundResultOf(r, reviewsByRound.get(r.round_no)));
    const planRow = rounds.find((r) => r.kind === 'plan');

    res.json({
      ok: true,
      council,
      participants: repo.listParticipants(council.id),
      materials: repo.listMaterials(council.id),
      // Every spoken turn, with model and token columns. The store derives the timeline and the
      // per-role token summary from these, so a page reload must get them here — WS only covers
      // live updates.
      utterances: repo.listUtterances(council.id),
      // Raw archive rows stay available for troubleshooting.
      rounds,
      reviews,
      // Assembled RoundResults are what the UI renders.
      roundResults,
      plan: planRow ? parseJson(planRow.moderator_json, null) : null,
      report: reportRow ? parseJson(reportRow.report_json, null) : null,
      reportFiles: reportRow ? parseJson(reportRow.files_json, []) : [],
      live: orchestrator.activeIds().includes(council.id),
      // Who is working on which phase right now; null when nothing is in flight. This is what lets
      // a freshly opened page show the working indicator during a long turn.
      progress: orchestrator.progressOf(council.id),
    });
  });

  /* ------------------------------------------------------------------ Cancel */
  router.post('/councils/:id/cancel', (req, res) => {
    const council = repo.getCouncil(req.params.id);
    if (!council) return notFound(res);
    const cancelled = orchestrator.cancel(council.id);
    res.json({ ok: true, cancelled, council: repo.getCouncil(council.id) });
  });

  /* ------------------------------------------------------------------ Delete */
  router.delete('/councils/:id', (req, res) => {
    const council = repo.getCouncil(req.params.id);
    if (!council) return notFound(res);
    if (orchestrator.activeIds().includes(council.id)) {
      return res.status(409).json({
        ok: false,
        error: { code: 'conflict', message: '这场会还在讨论，先取消再删' },
      });
    }
    repo.deleteCouncil(council.id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createCouncilRouter, resolveWorkspaceDir };
