'use strict';

/** 只读查询接口。WS 断线时前端降级轮询 /api/v1/snapshot 也会走这里。 */

const express = require('express');
const { DEFAULTS } = require('@workgremlin/shared');

/**
 * @param {{bus: any, repo: any}} ctx
 */
function createQueryRouter({ bus, repo }) {
  const router = express.Router();

  router.get('/projects', (req, res) => {
    res.json({ ok: true, projects: bus.listProjectSummaries() });
  });

  router.get('/snapshot', (req, res) => {
    res.json({ ok: true, snapshot: bus.buildSnapshot(req.query.project || null) });
  });

  router.get('/messages', (req, res) => {
    const project = req.query.project;
    if (!project) return res.status(400).json({ ok: false, error: { code: 'bad_payload', message: 'missing project' } });
    const q = req.query;
    const items = repo
      .listMessages(project, {
        members: q.members ? String(q.members).split(',').filter(Boolean) : undefined,
        types: q.types ? String(q.types).split(',').filter(Boolean) : undefined,
        since: q.since ? Number(q.since) : undefined,
        until: q.until ? Number(q.until) : undefined,
        keyword: q.keyword ? String(q.keyword) : undefined,
        beforeId: q.beforeId ? Number(q.beforeId) : undefined,
        limit: q.limit ? Number(q.limit) : DEFAULTS.MESSAGE_WINDOW,
        direction: q.direction === 'asc' ? 'asc' : 'desc',
      })
      .map(bus.toMessage);
    return res.json({ ok: true, items, hasMore: items.length >= (Number(q.limit) || DEFAULTS.MESSAGE_WINDOW) });
  });

  /**
   * 任务记录：一轮用户任务一行，以 tasks 表为唯一真值（含全部工程、全部楼层的历史任务）。
   * 只取顶层用户任务（parent_task_id IS NULL）；subagent 子行走 /subagent-runs。
   *
   * 一级检索（服务端过滤）：
   *   - project：工程 id；缺省 / 'all' = 所有工程。
   *   - client ：楼层 = 执行该任务的成员 client（codebuddy/codex/workbuddy/claude…）；
   *              缺省 / 'all' = 所有楼层。
   * 二级检索（状态）由前端在已拉取结果上按 state 再筛（见 TaskRecordsView 的状态分段）。
   *
   * 字段补全（tasks 表本身只有骨架列）：
   *   - client / model / file_count / files_json / result 来自报表层 task_runs（LEFT JOIN，可能为空）；
   *     client 再回落到 members.client，保证老任务也能标出所属楼层。
   *   - duration_ms = ended_at - started_at（现算）；subagentCount = subagent_runs 计数。
   *   - state 归一：堆积的遗留 'running' 任务（进程已不在跑）一律视作 'cancelled'；
   *     只有确实在当前有活跃心跳（agent_status 近期 busy/thinking/**blocked** 且 task_id 匹配）的才保留 'running'。
   *     注意 blocked 必须算"还在跑"：等权限时 hook 上报的就是 blocked（awaiting_permission），
   *     漏掉它会让任务在弹权限框的那一刻显示成「已取消」，批准后又跳回「进行中」——纯属误报。
   */
  router.get('/task-runs', (req, res) => {
    const project = req.query.project;
    const client = req.query.client;
    const limit = Math.min(Math.max(Number(req.query.limit) || 2000, 1), 5000);
    // "还在进行"的判定窗口：10 分钟内还有心跳的 active 状态才算真在跑
    const cutoff = Date.now() - 10 * 60 * 1000;

    const conds = ['t.parent_task_id IS NULL'];
    const args = { limit, cutoff };
    if (project && project !== 'all') {
      conds.push('t.project_id = @project');
      args.project = project;
    }
    if (client && client !== 'all') {
      conds.push('m.client = @client');
      args.client = client;
    }

    // 始终 LEFT JOIN 报表层与成员，补全 client/model/文件/产出，并按 client 过滤
    const rows = repo.raw
      .prepare(
        `SELECT
           t.id, t.project_id, t.member_id, t.parent_task_id, t.title,
           t.progress, t.started_at, t.ended_at,
           COALESCE(tr.client, m.client) AS client,
           m.name AS member_name,
           tr.model AS model,
           tr.file_count AS file_count,
           tr.files_json AS files_json,
           tr.result AS result,
           CASE
             WHEN t.state = 'running'
                  AND NOT EXISTS (
                    SELECT 1 FROM agent_status s
                    WHERE s.task_id = t.id
                      AND s.last_heartbeat_at > @cutoff
                      -- blocked = 等权限，仍然是"这一轮在飞"，不能算已取消
                      AND s.state IN ('busy', 'thinking', 'blocked')
                  )
             THEN 'cancelled'
             ELSE t.state
           END AS state
         FROM tasks t
         LEFT JOIN task_runs tr ON tr.id = t.id
         LEFT JOIN members m ON m.id = t.member_id
         WHERE ${conds.join(' AND ')}
         ORDER BY t.started_at DESC
         LIMIT @limit`
      )
      .all(args);

    const items = rows.map((r) => ({
      ...r,
      duration_ms: r.ended_at && r.started_at ? r.ended_at - r.started_at : null,
      subagentCount: repo.countSubagentRuns.get(r.id).c,
    }));
    return res.json({ ok: true, items });
  });

  /**
   * 单个用户任务召唤出去的 subagent 实例（subagent_runs）。
   * parent 必填，值为 task_runs.id。
   */
  router.get('/subagent-runs', (req, res) => {
    const parent = req.query.parent;
    if (!parent) return res.status(400).json({ ok: false, error: { code: 'bad_payload', message: 'missing parent' } });
    const items = repo.listSubagentRuns.all(parent);
    return res.json({ ok: true, items });
  });

  /**
   * 删单条任务记录（含其 subagent 子任务、台账、消息、产出）。
   * 二次确认在客户端完成，这里只负责真删。
   */
  router.delete('/task-runs/:id', (req, res) => {
    const id = req.params.id;
    if (!id) return res.status(400).json({ ok: false, error: { code: 'bad_payload', message: 'missing id' } });
    const n = repo.deleteTaskRun(id);
    return res.json({ ok: true, deleted: n });
  });

  /**
   * 按一级检索（工程 + 楼层）批量删除：
   *   - mode=all    ：删掉筛选条件下的全部记录；
   *   - mode=recent ：仅保留最近 days 天（默认 30，可配 1~3650），删更早的。
   * 这两条都是破坏性操作，前端会先弹确认框展示影响条数。
   */
  router.delete('/task-runs', (req, res) => {
    const project = req.query.project;
    const client = req.query.client;
    const mode = req.query.mode || 'all';
    let beforeTs = null;
    if (mode === 'recent') {
      const days = Math.max(1, Math.min(Number(req.query.days) || 30, 3650));
      beforeTs = Date.now() - days * 24 * 60 * 60 * 1000;
    }
    const n = repo.deleteTaskRunsByFilter({ project, client, beforeTs });
    return res.json({ ok: true, deleted: n });
  });

  // ---- 记录保留天数（服务端自动清理以它为准）----
  router.get('/settings/retention', (req, res) => {
    res.json({ ok: true, days: repo.getRetentionDays() });
  });
  router.put('/settings/retention', (req, res) => {
    const days = Math.max(1, Math.min(Number(req.query.days) || 30, 3650));
    repo.setSetting('retentionDays', days);
    // 立即按新保留期清一次更早的记录，让改动即时生效（每日定时器仍负责后续滚动清理）
    let cleaned = 0;
    try {
      cleaned = repo.deleteTaskRunsByFilter({ beforeTs: Date.now() - days * 24 * 60 * 60 * 1000 });
    } catch {
      /* 清理失败不影响保存 */
    }
    res.json({ ok: true, days, cleaned });
  });

  return router;
}

module.exports = { createQueryRouter };
