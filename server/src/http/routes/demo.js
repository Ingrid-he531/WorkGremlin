'use strict';

/**
 * Virtual demo session endpoints.
 *
 *   POST   /api/v1/demo/session { floor }   start the single in-memory demo on a floor
 *                                           (starting elsewhere replaces the previous demo)
 *   GET    /api/v1/demo/session?floor=&session=   live phase / member state, no DB access
 *   DELETE /api/v1/demo/session?floor=      drop the in-memory demo when it owns that floor
 *
 * The session row is installed in the ordinary sessions table by the renderer. Demo members are
 * consumed only by the office / workstation views; the real project store stays untouched.
 */

const express = require('express');
const { ERROR_CODES } = require('@workgremlin/shared');

function bad(res, message) {
  return res.status(400).json({
    ok: false,
    error: { code: ERROR_CODES.BAD_PAYLOAD, message },
  });
}

/** @param {{demo: ReturnType<typeof import('../../demo/provider').createDemoProvider>}} ctx */
function createDemoRouter({ demo }) {
  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));

  router.post('/demo/session', (req, res) => {
    const floor = String((req.body && req.body.floor) || '').trim();
    if (!floor) return bad(res, 'missing floor');
    try {
      const { session, snapshot } = demo.start(floor);
      return res.json({ ok: true, session, snapshot });
    } catch (err) {
      return bad(res, String((err && err.message) || 'cannot start demo'));
    }
  });

  router.get('/demo/session', (req, res) => {
    const floor = String(req.query.floor || '').trim();
    if (!floor) return bad(res, 'missing floor');
    const live = demo.get(floor, String(req.query.session || ''));
    if (!live) {
      return res.status(404).json({
        ok: false,
        error: { code: 'demo_not_active', message: 'demo session is not active on this floor' },
      });
    }
    return res.json({ ok: true, ...live });
  });

  router.delete('/demo/session', (req, res) => {
    const floor = String(req.query.floor || '').trim();
    if (!floor) return bad(res, 'missing floor');
    return res.json({ ok: true, stopped: demo.stop(floor) });
  });

  return router;
}

module.exports = { createDemoRouter };
