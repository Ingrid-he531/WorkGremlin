'use strict';

const express = require('express');
const { reporterMainPhase, freshestReporterWs } = require('../../sessions');

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
    // 跟随 reporter 真实活动的最新工程，而不是 office 手工"打开工程"记的那个
    const ws = freshestReporterWs(cur.workspacePath || '');
    const rp = reporterMainPhase(ws);
    // 带上这条相位所属的工程路径（workspacePath）：渲染层据此只在"选中会话正好属于这个工程"时
    // 才叠加实时相位，避免旧会话（它自己工程已不活跃）被新工程的相位串味、短暂闪一下"思考中"。
    res.json(rp ? { ok: true, workspacePath: ws, ...rp } : { ok: true, workspacePath: ws, phase: null, action: '', target: '', context: [] });
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
