'use strict';

/**
 * Agent reporting API (route B, the single source of truth).
 * Everything is POST + JSON, idempotent (messages are deduped by dedupe_key).
 */

const express = require('express');
const { ERROR_CODES } = require('@workgremlin/shared');

const log = require('../../log');
const { createHookDispatch } = require('../../ingest/hookDispatch');
const { addGhost, retireGhost, sweepGhosts } = require('../../ingest/hookCommon');

/**
 * @param {{bus: any, repo?: any}} ctx
 */
function createIngestRouter({ bus, repo }) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  // Server-side hook event dispatch: once the CLI hook was reduced to an event forwarder, on-disk
  // parsing / session state / ledger writes all live here.
  const hookDispatch = createHookDispatch();

  const wrap = (fn) => (req, res) => {
    try {
      const result = fn(req.body || {}, req);
      if (result && result.ok === false) {
        const code = result.error === 'unknown_member' ? ERROR_CODES.UNKNOWN_MEMBER : ERROR_CODES.BAD_PAYLOAD;
        return res.status(code === ERROR_CODES.UNKNOWN_MEMBER ? 404 : 400).json({ ok: false, error: { code, message: result.error } });
      }
      return res.json({ ok: true, ...(result || {}) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: { code: ERROR_CODES.INTERNAL, message: String(err && err.message) } });
    }
  };

  const projectFirst = (fn) =>
    wrap((body) => {
      /* Ownership follows **the directory the reporter is actually in** (see the notes on
         bus.projectForReport): with "the office showing A while I run the CLI inside B",
         body.project is A (the office's current project) and body.workspacePath is the real B ——
         taking A as the destination used to record the task under another project.
         Old reports that carry no workspacePath fall back to body.project, behavior unchanged. */
      const project = bus.projectForReport(body.project || body.projectId || '', body.workspacePath || '');
      if (!project) return { ok: false, error: 'missing project' };
      bus.ensureProject(project, body.workspacePath || '', body.mainConversationId || null, 'report');
      return fn({ ...body, project });
    });

  router.post('/register', projectFirst((b) => ({ ok: true, memberId: bus.registerMember(b) })));

  router.post(
    '/heartbeat',
    projectFirst((b) =>
      b.memberId
        ? bus.heartbeat(b)
        : { ok: false, error: 'missing memberId' }
    )
  );

  router.post('/status', projectFirst((b) => (b.memberId ? bus.setStatus(b) : { ok: false, error: 'missing memberId' })));

  router.post('/task/start', projectFirst((b) => (b.memberId ? bus.startTask(b) : { ok: false, error: 'missing memberId' })));

  router.post(
    '/task/progress',
    projectFirst((b) => (b.memberId && b.taskId ? bus.taskProgress(b) : { ok: false, error: 'missing memberId/taskId' }))
  );

  router.post(
    '/task/end',
    projectFirst((b) => (b.memberId && b.taskId ? bus.endTask(b) : { ok: false, error: 'missing memberId/taskId' }))
  );

  /* Backfilling tokens after wrap-up: some floors persist usage later than Stop (measured on the
     CodeBuddy plugin form), so the truth cannot be read at the moment of wrap-up —— once it lands
     on disk, use this endpoint to patch it in, touching only the four token columns (see
     bus.backfillTaskTokens). When the row to patch cannot be located, the server returns ok as-is
     (writes nothing), so this endpoint can be retried safely. */
  router.post(
    '/task/tokens',
    projectFirst((b) =>
      b.memberId && b.tokens ? bus.backfillTaskTokens(b) : { ok: false, error: 'missing memberId/tokens' }
    )
  );

  // Wrap-up fallback (bug 3): when the taskId was lost to a concurrent overwrite of the state file,
  // the hook uses this to fish the current task back out and wrap it up.
  router.post(
    '/task/current',
    projectFirst((b) => (b.memberId ? bus.currentTaskFor(b.project, b.memberId, b.sessionId || '') : { ok: false, error: 'missing memberId' }))
  );

  router.post('/message', projectFirst((b) => (b.from ? bus.recordMessage({ ...b, source: 'report' }) : { ok: false, error: 'missing from' })));

  router.post('/file/touch', projectFirst((b) => (b.memberId ? bus.fileTouch(b) : { ok: false, error: 'missing memberId' })));

  // Tool usage: a tool was used once more within a round (the "tool usage" panel in task details
  // accumulates by (taskId, tool))
  router.post('/tool/use', projectFirst((b) => (b.memberId ? bus.toolUse(b) : { ok: false, error: 'missing memberId' })));

  /* subagent ghost (ephemeral member) writes: funnelled into server-side hookCommon (the same
     implementation as the CLI hook path). No manifest file anymore — it writes straight to the DB as
     an ephemeral member + subagent_runs. Actions: spawn (summon a ghost) / finish (retire it) /
     sweep (clear this session's ghosts). Ownership follows workspacePath; client is used to claim /
     isolate. */
  router.post('/ghost', projectFirst((b) => {
    const ws = String(b.workspacePath || '');
    const client = String(b.client || '');
    const session = String(b.sessionId || b.session || '');
    const action = String(b.action || '');
    if (action === 'spawn') {
      addGhost(bus, b.project, ws, String(b.name || 'subagent'), String(b.task || ''), String(b.id || ''), String(b.parent || ''), String(b.model || ''), client, session);
      return { ok: true, action: 'spawn' };
    }
    if (action === 'finish') {
      retireGhost(
        bus,
        b.project,
        String(b.name || ''),
        String(b.id || ''),
        String(b.result || ''),
        client,
        session,
        String(b.agentId || b.agent_id || '')
      );
      return { ok: true, action: 'finish' };
    }
    if (action === 'sweep') {
      sweepGhosts(bus, b.project, client, { all: b.all === true }, session);
      return { ok: true, action: 'sweep' };
    }
    return { ok: false, error: 'unknown_action' };
  }));

  /* Raw events forwarded by the CLI hook: no longer split into semantic routes, they are handed
     straight to the server-side dispatcher, and that floor's handleHookEvent reads the disk and
     writes the ledger. Ownership is settled by workspacePath (cwd); with no project attached it
     falls back to "the project currently open in the office". */
  router.post('/hook', async (req, res) => {
    try {
      const body = req.body || {};
      const ws = body.workspacePath || '';
      // Diagnostics: log one line per hook event received (info level, persisted by default) so it
      // is plain to see "did the server actually get it, and what do the fields look like"
      log.info('[ghost-debug] /hook recv', JSON.stringify({ event: body.hook_event_name, agent: body.agent, client: body.client, tool: body.tool_name || body.tool, ws, session: body.session_id || '' }));
      const project = bus.projectForReport(body.project || '', ws);
      if (!project) {
        log.warn('hook 没有归属工程，忽略', body.hook_event_name, body.agent, ws);
        return res.status(400).json({ ok: false, error: { code: ERROR_CODES.BAD_PAYLOAD, message: 'missing project' } });
      }
      bus.ensureProject(project, ws, body.mainConversationId || null, 'report');
      const result = await hookDispatch.dispatch({ ...body }, { project, workspacePath: ws, bus, repo });
      return res.json({ ok: true, ...(result || {}) });
    } catch (err) {
      log.error('hook 处理失败：', err);
      return res.status(500).json({ ok: false, error: { code: ERROR_CODES.INTERNAL, message: String((err && err.message) || err) } });
    }
  });

  return router;
}

module.exports = { createIngestRouter };
