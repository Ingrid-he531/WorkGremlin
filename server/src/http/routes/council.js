'use strict';

/**
 * The council room's HTTP API —— start / view / cancel / delete.
 *
 * Every check here is "do not fabricate" expressed at the API layer:
 *   · A floor not on the whitelist, or without its CLI → **reject**, no downgrading (holding the
 *     meeting one participant short should not be quietly accepted);
 *   · A material file that cannot be read / is binary → **reject the whole request and name the
 *     files**, no silent skipping (if a file the user picked did not make it in, he has to know,
 *     otherwise he will believe the participants read it);
 *   · A running meeting cannot be deleted (cancel first) —— deleting it lets in-flight speeches keep
 *     writing into a meeting that no longer exists, and with no foreign keys on these tables those
 *     rows become orphans;
 *   · Both the mode (vote / analysis) and the working directory (project mode) are validated
 *     **here**: an unrecognized mode is rejected, and the directory must exist, be readable and be
 *     **absolute**. Letting it through means the mistake only surfaces after all four participants
 *     have each failed once.
 *
 * The start endpoint does **not await the whole meeting**: a meeting takes minutes to run, HTTP
 * should have returned long before that. `POST /councils` persists it and returns immediately,
 * progress goes out over WS (WS_EVENTS.COUNCIL), and on reconnect the frontend pulls
 * `GET /councils/:id` to catch up.
 */

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULTS } = require('@workgremlin/shared');

const { listCouncilFloors, isCouncilFloor } = require('../../council/floors');
const { readMaterials } = require('../../council/materials');
const { THRESHOLDS } = require('../../council/consensus');

/** Default decision criterion: honor the global default, falling back to the most conservative one */
const defaultThreshold = () =>
  Object.values(THRESHOLDS).includes(DEFAULTS.COUNCIL_THRESHOLD_DEFAULT)
    ? DEFAULTS.COUNCIL_THRESHOLD_DEFAULT
    : THRESHOLDS.UNANIMOUS;

/** A meeting's id. Not auto-increment: these tables have to be deletable wholesale, so keep order information out of ids */
const newId = () => `c_${crypto.randomBytes(12).toString('hex')}`;

/** The two ways of talking. See COUNCIL_MODE_DEFAULT in shared and the branches in council/orchestrator.js */
const MODES = Object.freeze(['vote', 'analysis']);

/**
 * Validation of the working directory (project mode). **Absolute paths only** —— a relative path
 * resolved against the server's cwd is often not the directory the user had in mind; rather than
 * guessing for him, make him write it out in full.
 *
 * A leading `~` is expanded (that is what users type most in the input box), and then it **must
 * exist and be a directory**: letting a nonexistent path through would make the four participants
 * each fail once and finally report a meeting where "nobody expressed a position", hiding the real
 * cause (a mistyped directory).
 *
 * @param {unknown} raw workspacePath from the request body
 * @returns {{path:string}|{error:string}} an empty path = the user left it blank (isolated mode)
 */
function resolveWorkspaceDir(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return { path: '' };
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(s === '~' ? 1 : 2));
  if (!path.isAbsolute(s)) return { error: `工作目录要写绝对路径（留空 = 隔离模式）：${s}` };
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
 * @param {{repo:object, orchestrator:object, deps?:object}} arg
 *   deps.listFloors is injectable (tests swap out the real CLI detection)
 */
function createCouncilRouter({ repo, orchestrator, deps = {} }) {
  const router = express.Router();
  const listFloors = deps.listFloors || (() => listCouncilFloors());

  /** Can this floor be invited right now (only counts when its CLI is installed) */
  const floorsById = () => new Map(listFloors().map((f) => [f.floorId, f]));

  /* ------------------------------------------------------------------ Available floors */
  // Note: this route goes before /councils/:id, otherwise 'floors' would be taken as an id
  router.get('/councils/floors', (req, res) => {
    res.json({
      ok: true,
      floors: listFloors(),
      // The UI shows "at most how many rounds"; defaults and the hard cap come from here, do not
      // hardcode a second copy on the frontend
      defaults: {
        maxRounds: DEFAULTS.COUNCIL_ROUNDS_DEFAULT,
        maxRoundsLimit: DEFAULTS.COUNCIL_ROUNDS_MAX,
        threshold: defaultThreshold(),
        modes: [...MODES],
        mode: DEFAULTS.COUNCIL_MODE_DEFAULT,
        turnTimeoutMs: DEFAULTS.COUNCIL_TURN_TIMEOUT_MS,
        // Per-round timeout in project mode (participants dig through code themselves, so it is
        // wider than the one above) —— the UI has to state "how long at most"
        workspaceTurnTimeoutMs: DEFAULTS.COUNCIL_WORKSPACE_TURN_TIMEOUT_MS,
        materialMaxBytes: DEFAULTS.COUNCIL_MATERIAL_MAX_BYTES,
        materialTotalMaxBytes: DEFAULTS.COUNCIL_MATERIAL_TOTAL_MAX_BYTES,
      },
    });
  });

  /* ------------------------------------------------------------------ Start */
  router.post('/councils', (req, res) => {
    const body = req.body || {};
    const topic = String(body.topic == null ? '' : body.topic).trim();
    if (!topic) return bad(res, '议题不能是空的');

    // How to talk: reject an unrecognized value rather than silently downgrading to vote (the user
    // picking "analysis" and getting it run as "vote" is the worst kind of mistake)
    const mode = body.mode == null || body.mode === '' ? DEFAULTS.COUNCIL_MODE_DEFAULT : String(body.mode);
    if (!MODES.includes(mode)) return bad(res, `模式只能是 ${MODES.join(' / ')}：${mode}`);

    // Where to talk: blank = isolated mode (verbatim as before the change); if filled in it must be
    // an existing, readable directory
    const ws = resolveWorkspaceDir(body.workspacePath);
    if (ws.error) return bad(res, ws.error);

    const wanted = Array.isArray(body.floors) ? [...new Set(body.floors.map((f) => String(f)))] : [];
    if (wanted.length < 2) return bad(res, '至少要请两个楼层 —— 一个人不叫讨论');

    const known = floorsById();
    const unknown = wanted.filter((f) => !isCouncilFloor(f));
    if (unknown.length) return bad(res, `这几个楼层议事厅请不了：${unknown.join('、')}`);
    const asleep = wanted.filter((f) => !(known.get(f) || {}).ready);
    if (asleep.length) {
      // Spell out why each floor is unavailable —— with the plugin installed but no CLI, the user
      // has to know exactly what is missing
      const why = asleep.map((f) => `${f}：${(known.get(f) || {}).reason || '不可用'}`).join('；');
      return bad(res, `这些楼层现在请不动 —— ${why}`);
    }

    const wantedRounds = Number(body.maxRounds);
    const maxRounds = Number.isFinite(wantedRounds) && wantedRounds > 0
      ? Math.min(Math.floor(wantedRounds), DEFAULTS.COUNCIL_ROUNDS_MAX)
      : DEFAULTS.COUNCIL_ROUNDS_DEFAULT;

    const threshold = Object.values(THRESHOLDS).includes(body.threshold) ? body.threshold : defaultThreshold();

    // Materials: reject the whole request and name the files when one cannot be read (no silent
    // skipping)
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
      repo.createCouncil({ id, topic, mode, workspacePath: ws.path || null, threshold, maxRounds, createdAt });
      for (const f of wanted) {
        repo.insertParticipant({ councilId: id, floorId: f, agent: floorOf(f).agent || '', cliPath: floorOf(f).cliPath || null });
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
      return res.status(500).json({ ok: false, error: { code: 'internal', message: `建这场会失败：${(err && err.message) || '未知原因'}` } });
    }

    // Start running only once it is persisted. **No await**: the start endpoint returns immediately,
    // progress goes out over WS. start() guarantees it never throws (see orchestrator.js), so no
    // catch is needed here.
    orchestrator.start(id);

    res.status(201).json({ ok: true, council: repo.getCouncil(id) });
  });

  /* ------------------------------------------------------------------ List */
  router.get('/councils', (req, res) => {
    res.json({ ok: true, councils: repo.listCouncils(Number(req.query.limit) || 50) });
  });

  /* ------------------------------------------------------------------ Detail */
  router.get('/councils/:id', (req, res) => {
    const council = repo.getCouncil(req.params.id);
    if (!council) return notFound(res);
    res.json({
      ok: true,
      council,
      participants: repo.listParticipants(council.id),
      // Materials come with their content: the UI has to let people verify "what was actually fed
      // in", which is part of traceability
      materials: repo.listMaterials(council.id),
      rounds: repo.listRounds(council.id),
      utterances: repo.listUtterances(council.id),
      // Still running? (only the server knows whether the process is alive; the status in the DB may
      // have just been marked but not pushed out yet)
      live: orchestrator.activeIds().includes(council.id),
    });
  });

  /* ------------------------------------------------------------------ Cancel */
  router.post('/councils/:id/cancel', (req, res) => {
    const council = repo.getCouncil(req.params.id);
    if (!council) return notFound(res);
    // cancel only works on meetings "still running in the server's memory"; a finished one cannot be
    // cancelled, and that comes back as false, honestly
    const cancelled = orchestrator.cancel(council.id);
    res.json({ ok: true, cancelled, council: repo.getCouncil(council.id) });
  });

  /* ------------------------------------------------------------------ Delete */
  router.delete('/councils/:id', (req, res) => {
    const council = repo.getCouncil(req.params.id);
    if (!council) return notFound(res);
    if (orchestrator.activeIds().includes(council.id)) {
      // Cancel a running meeting before deleting it: deleting outright leaves in-flight speeches
      // writing into a meeting that no longer exists, and with no foreign keys on these tables those
      // rows linger as orphans
      return res.status(409).json({ ok: false, error: { code: 'conflict', message: '这场会还在讨论，先取消再删' } });
    }
    repo.deleteCouncil(council.id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createCouncilRouter, resolveWorkspaceDir };
