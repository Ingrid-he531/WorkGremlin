'use strict';

/**
 * Remote dispatch API (reverse control, conservative): **sessions**, not one-shot requests.
 *
 *   GET    /api/v1/dispatch                          policy + floor availability + session list
 *   GET    /api/v1/dispatch/models?floor=8F          model catalog for the per-turn picker
 *   POST   /api/v1/dispatch/sessions                 create a session {floor, workspacePath, model?}
 *   GET    /api/v1/dispatch/sessions/:id             full transcript (turns + output tails)
 *   DELETE /api/v1/dispatch/sessions/:id             close a session (kills a running turn)
 *   POST   /api/v1/dispatch/sessions/:id/turns       send a prompt {prompt, model?}
 *   POST   /api/v1/dispatch/turns/:id/decision       {approve}   (loopback only)
 *   DELETE /api/v1/dispatch/turns/:id                cancel a pending/running turn
 *
 * The policy is **not** editable over HTTP: it lives in ~/.workgremlin/config.json on the server
 * (see control/config.js), so a client cannot promote itself to `auto`. Approval is **loopback-only**:
 * a remote client must not be able to approve its own request. The service never writes the task
 * ledger; the spawned CLI is a normal session, so the office/ledger come from the product itself.
 */

const express = require('express');

/** Express's req.ip is `::ffff:127.0.0.1` for IPv4 loopback; normalize before comparing. */
function isLoopback(req) {
  const raw = String((req && req.ip) || (req && req.socket && req.socket.remoteAddress) || '').trim();
  const ip = raw.replace(/^::ffff:/i, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

/**
 * @param {{service: ReturnType<typeof import('../control/service').createDispatchService>}} ctx
 */
function createDispatchRouter({ service }) {
  const router = express.Router();

  function bad(res, err) {
    return res.status((err && err.status) || 400).json({
      ok: false,
      error: { code: (err && err.code) || 'error', message: (err && err.message) || String(err) },
    });
  }

  function overview(req) {
    const loopback = isLoopback(req);
    return {
      ok: true,
      mode: service.mode(),
      floors: service.floors(),
      // The server only shows the approval dialog on its own machine; this is that verdict.
      canApprove: loopback,
      // Where the policy lives — only told to the machine that may edit it.
      ...(loopback ? { configFile: service.policy().file } : {}),
      sessions: service.list(),
    };
  }

  router.get('/dispatch', (req, res) => {
    res.json(overview(req));
  });

  router.get('/dispatch/models', async (req, res) => {
    try {
      // No client-controlled refresh: the catalog is cached server-side (see listModels), so a
      // remote caller cannot turn the picker into an endless "spawn a CLI" loop.
      const out = await service.listModels(String(req.query.floor || '8F'));
      return res.json({ ok: true, ...out });
    } catch (err) {
      return bad(res, err);
    }
  });

  router.post('/dispatch/sessions', (req, res) => {
    try {
      const session = service.createSession(req.body || {});
      return res.status(201).json({ ok: true, session });
    } catch (err) {
      return bad(res, err);
    }
  });

  router.get('/dispatch/sessions/:id', (req, res) => {
    try {
      return res.json({ ok: true, session: service.getSession(req.params.id) });
    } catch (err) {
      return bad(res, err);
    }
  });

  router.delete('/dispatch/sessions/:id', (req, res) => {
    try {
      return res.json(service.deleteSession(req.params.id));
    } catch (err) {
      return bad(res, err);
    }
  });

  router.post('/dispatch/sessions/:id/turns', (req, res) => {
    try {
      const turn = service.sendTurn(req.params.id, req.body || {});
      // 202: parked until the server machine approves; 200: already running.
      return res.status(turn.state === 'pending' ? 202 : 200).json({ ok: true, turn });
    } catch (err) {
      return bad(res, err);
    }
  });

  router.post('/dispatch/turns/:id/decision', (req, res) => {
    if (!isLoopback(req)) {
      return res.status(403).json({
        ok: false,
        error: { code: 'loopback_only', message: '只能在服务器端确认或取消' },
      });
    }
    const approve = Boolean(req.body && req.body.approve);
    try {
      return res.json({ ok: true, turn: service.decide(req.params.id, approve) });
    } catch (err) {
      return bad(res, err);
    }
  });

  router.delete('/dispatch/turns/:id', (req, res) => {
    try {
      return res.json({ ok: true, turn: service.cancel(req.params.id) });
    } catch (err) {
      return bad(res, err);
    }
  });

  return router;
}

module.exports = { createDispatchRouter, isLoopback };
