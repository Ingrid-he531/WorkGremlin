'use strict';

const express = require('express');

function createHealthRouter({ version = '0.1.0', project = '' } = {}) {
  const router = express.Router();
  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      version,
      // 当前工程名（package.json name > 目录名）；dev 模式下前端也能拿到
      project,
      uptime: process.uptime(),
      pid: process.pid,
      ts: Date.now(),
    });
  });
  return router;
}

module.exports = { createHealthRouter };
