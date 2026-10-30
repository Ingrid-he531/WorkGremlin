'use strict';

/**
 * Server-side default workspace (not a user-facing project switch).
 *
 *   GET  /api/v1/workspace          the default workspace used for legacy attribution / polling
 *
 * The UI does not use this endpoint to choose a project: the office follows the selected session and
 * loads its project through GET /api/v1/snapshot?project=<id|path>. The reporter plugins still read
 * GET /workspace to resolve a project name when an event carries none. The default is established at
 * startup (WORKGREMLIN_WORKSPACE / --workspace / cwd) and restored from the previous run.
 */

const express = require('express');

/**
 * @param {{workspace: ReturnType<typeof import('../../project').createWorkspaceContext>}} ctx
 */
function createWorkspaceRouter({ workspace }) {
  const router = express.Router();

  router.get('/workspace', (req, res) => {
    res.json({ ok: true, ...workspace.get() });
  });

  return router;
}

module.exports = { createWorkspaceRouter };
