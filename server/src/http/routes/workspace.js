'use strict';

/**
 * Project (workspace) query and switch.
 *   GET  /api/v1/workspace          current project + recently opened + subagent manifest path
 *   POST /api/v1/workspace {path}   open a project directory; an empty path or 'demo' means
 *                                   switching back to the demo data
 */

const express = require('express');
const { ERROR_CODES } = require('@workgremlin/shared');

/**
 * @param {{workspace: ReturnType<typeof import('../../project').createWorkspaceManager>}} ctx
 */
function createWorkspaceRouter({ workspace }) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  const view = (cur) => ({ ok: true, ...cur, recent: workspace.recent() });

  router.get('/workspace', (req, res) => {
    res.json(view(workspace.current()));
  });

  router.post('/workspace', (req, res) => {
    const raw = req.body && (req.body.path ?? req.body.workspacePath);
    try {
      const cur = raw === undefined || raw === null || String(raw).trim() === '' || raw === 'demo'
        ? workspace.openDemo()
        : workspace.open(raw);
      res.json(view(cur));
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: { code: ERROR_CODES.BAD_PAYLOAD, message: String(err && err.message) },
      });
    }
  });

  return router;
}

module.exports = { createWorkspaceRouter };
