'use strict';

/**
 * 工程（workspace）查询与切换。
 *   GET  /api/v1/workspace          当前工程 + 最近打开 + subagent 清单路径
 *   POST /api/v1/workspace {path}   打开某个工程目录；path 为空或 'demo' 表示切回演示数据
 */

const express = require('express');
const { ERROR_CODES } = require('@workgremlin/shared');

/**
 * @param {{workspace: ReturnType<typeof import('../workspace').createWorkspaceManager>}} ctx
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
