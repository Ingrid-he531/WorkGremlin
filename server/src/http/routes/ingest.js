'use strict';

/**
 * Agent 上报接口（B 路线，唯一真值来源）。
 * 全部为 POST + JSON，幂等（消息按 dedupe_key 去重）。
 */

const express = require('express');
const { ERROR_CODES } = require('@workgremlin/shared');

/**
 * @param {{bus: any}} ctx
 */
function createIngestRouter({ bus }) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

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

  const teamFirst = (fn) =>
    wrap((body) => {
      const team = body.team || body.teamId;
      if (!team) return { ok: false, error: 'missing team' };
      bus.ensureTeam(team, body.workspacePath || '', body.mainConversationId || null, 'report');
      return fn({ ...body, team });
    });

  router.post('/register', teamFirst((b) => ({ ok: true, memberId: bus.registerMember(b) })));

  router.post(
    '/heartbeat',
    teamFirst((b) =>
      b.memberId
        ? bus.heartbeat(b)
        : { ok: false, error: 'missing memberId' }
    )
  );

  router.post('/status', teamFirst((b) => (b.memberId ? bus.setStatus(b) : { ok: false, error: 'missing memberId' })));

  router.post('/task/start', teamFirst((b) => (b.memberId ? bus.startTask(b) : { ok: false, error: 'missing memberId' })));

  router.post(
    '/task/progress',
    teamFirst((b) => (b.memberId && b.taskId ? bus.taskProgress(b) : { ok: false, error: 'missing memberId/taskId' }))
  );

  router.post(
    '/task/end',
    teamFirst((b) => (b.memberId && b.taskId ? bus.endTask(b) : { ok: false, error: 'missing memberId/taskId' }))
  );

  router.post('/message', teamFirst((b) => (b.from ? bus.recordMessage({ ...b, source: 'report' }) : { ok: false, error: 'missing from' })));

  router.post('/file/touch', teamFirst((b) => (b.memberId ? bus.fileTouch(b) : { ok: false, error: 'missing memberId' })));

  return router;
}

module.exports = { createIngestRouter };
