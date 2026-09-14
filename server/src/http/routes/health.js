'use strict';

const express = require('express');

function createHealthRouter({ version = '0.1.0' } = {}) {
  const router = express.Router();
  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      version,
      uptime: process.uptime(),
      pid: process.pid,
      ts: Date.now(),
    });
  });
  return router;
}

module.exports = { createHealthRouter };
