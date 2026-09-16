'use strict';

const express = require('express');

/**
 * 会话：全局活跃会话表（按楼层分组）。
 * 数据源是各智能体自己的落盘，跟当前打开的工程无关 —— 换工程的入口在
 * /api/v1/workspace，这里只负责"列出 / 选中哪个会话"。
 */
function createSessionsRouter({ workspace }) {
  const router = express.Router();

  router.get('/sessions', (req, res) => {
    const cur = workspace && workspace.current ? workspace.current() : {};
    res.json(
      snapshotSafe({
        workspacePath: cur.workspacePath || '',
        force: req.query.refresh === '1',
      })
    );
  });

  return router;
}

/** 扫盘失败也不能把服务拖垮：返回空表 + reason */
function snapshotSafe(o) {
  try {
    const { snapshot } = require('../../sessionRegistry');
    return snapshot(o);
  } catch (e) {
    return {
      ok: true,
      floors: [],
      sessions: [],
      defaultFloor: '1F',
      workspacePath: o.workspacePath || '',
      timeoutMs: 60 * 60_000,
      updatedAt: Date.now(),
      reason: 'no-storage',
      error: String((e && e.message) || e),
    };
  }
}

module.exports = { createSessionsRouter };
