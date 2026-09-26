'use strict';

const express = require('express');
const { reporterMainPhase, freshestReporterWs, reporterStateMeta, readReporterDone } = require('../../sessions');

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
    // 按楼层（客户端）取相位：同一工程里 Codex 与 CodeBuddy 同时跑时不能互相串味
    // client 可以是**逗号分隔的一串** —— 合并楼层（1F CodeBuddy = CLI + Plugin）一次要认两路
    // 上报身份，串里任意一个命中就算本层（匹配见 sessions.js 的 clientHit）。
    const client = String(req.query.client || '').trim().toLowerCase();
    // 轴 2（会话）：`?session=<session_id>` 只取那一条会话的相位/完成标记。
    // 一个楼层可以同时开多条会话（同一个 claude 开两个终端 / CLI + 插件混着跑），
    // 不给 session 就是老行为——同 client 里"谁最新显示谁"，多会话下会串味。
    const session = String(req.query.session || '').trim();
    // 跟随 reporter 真实活动的最新工程，而不是 office 手工"打开工程"记的那个
    const ws = freshestReporterWs(cur.workspacePath || '', client, session);
    const rp = reporterMainPhase(ws, client, session);
    // 这个工程有没有接 hook（接了但当前没动作 → 渲染层显示"待命"，而不是按文件时间瞎猜）
    // 有没有接 hook + 那份状态文件属于哪条会话（渲染层据此判断"你正在看的这条会话在上报吗"）
    const meta = reporterStateMeta(ws, client, session);
    const instrumented = meta.instrumented;
    // 上一轮的完成标记（含 Codex 的收尾自述）：CLI 楼层靠它亮「任务完成」
    const done = readReporterDone(ws, client, session);
    // 带上这条相位所属的工程路径（workspacePath）：渲染层据此只在"选中会话正好属于这个工程"时
    // 才叠加实时相位，避免旧会话（它自己工程已不活跃）被新工程的相位串味、短暂闪一下"思考中"。
    // session 一并回显：调用方可能没传（老行为），拿这个字段确认到底是谁的相位。
    const body = {
      ok: true,
      workspacePath: ws,
      instrumented,
      // 请求指定了会话就回显它；没指定就回"实际取到的那条"（meta.sessionId）
      session: session || meta.sessionId || '',
      sessionId: meta.sessionId,
      done,
    };
    res.json(
      rp
        ? { ...body, ...rp }
        : { ...body, phase: null, action: '', target: '', context: [] }
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
