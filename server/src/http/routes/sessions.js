'use strict';

const express = require('express');
const { reporterMainPhase } = require('../../sessions');

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

  // 主控制台快轮询：直接返回 reporter hook 的上报相位（已映射成 UI 字段），
  // 渲染层 1.5s 拉一次，比 /sessions 的 10s 轮询新鲜，专供主 Agent 控制台的"操作"实时显示。
  router.get('/reporter-phase', (req, res) => {
    const cur = workspace && workspace.current ? workspace.current() : {};
    const rp = reporterMainPhase(cur.workspacePath || '');
    res.json(rp ? { ok: true, ...rp } : { ok: true, phase: null, action: '', target: '', context: [] });
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
