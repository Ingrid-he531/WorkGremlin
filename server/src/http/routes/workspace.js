'use strict';

/**
 * Project (workspace) query and switch.
 *   GET  /api/v1/workspace          current project + recently opened + subagent manifest path
 *   POST /api/v1/workspace {path}   open a real project directory.
 *
 * Demo mode is not a workspace switch: it is a virtual session exposed by /api/v1/demo/session,
 * so empty / 'demo' paths are rejected rather than seeding a demo project into the real tables.
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
      const target = String(raw ?? '').trim();
      if (!target || target === 'demo') {
        return res.status(400).json({
          ok: false,
          error: { code: ERROR_CODES.BAD_PAYLOAD, message: 'a real workspace path is required' },
        });
      }
      const cur = workspace.open(target);
      return res.json(view(cur));
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
