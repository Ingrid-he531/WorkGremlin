'use strict';

/**
 * Server-side default workspace (not a user-facing project switch).
 *
 *   GET  /api/v1/workspace          the default workspace used for legacy attribution / polling
 *   POST /api/v1/workspace {path}   explicitly override that default (legacy callers and tests)
 *
 * The UI does not call this router to choose a project: the office follows the selected session and
 * loads its project through GET /api/v1/snapshot?project=<id|path>. The reporter plugins still read
 * GET /workspace to resolve a project name when an event carries none.
 *
 * Demo mode is not a workspace: it is a virtual session exposed by /api/v1/demo/session, so empty /
 * 'demo' paths are rejected rather than seeding a demo project into the real tables.
 */

const express = require('express');
const { ERROR_CODES } = require('@workgremlin/shared');

/**
 * @param {{workspace: ReturnType<typeof import('../../project').createWorkspaceContext>}} ctx
 */
function createWorkspaceRouter({ workspace }) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  const view = (cur) => ({ ok: true, ...cur });

  router.get('/workspace', (req, res) => {
    res.json(view(workspace.get()));
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
      const cur = workspace.setDefault(target);
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
