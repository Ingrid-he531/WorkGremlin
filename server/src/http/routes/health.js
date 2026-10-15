'use strict';

const express = require('express');

function createHealthRouter({ version = '0.1.0', projectName = '' } = {}) {
  const router = express.Router();
  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      version,
      // Current project name (package.json name > directory name); the frontend gets it too in dev mode
      projectName,
      uptime: process.uptime(),
      pid: process.pid,
      ts: Date.now(),
    });
  });
  return router;
}

module.exports = { createHealthRouter };
