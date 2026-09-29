'use strict';

/** 只读查询接口。WS 断线时前端降级轮询 /api/v1/snapshot 也会走这里。 */

const express = require('express');
const { DEFAULTS } = require('@workgremlin/shared');
const { cachedDirSize } = require('../../dirSize');
const { resolveProjectName } = require('../../project');

/**
 * 楼层筛选参数 → client 列表。
 * 可以是单个 client（'codebuddy'），也可以是逗号分隔的一串（'codebuddy,codebuddy-plugin'，
 * 合并楼层用）；'all' / 空 = 不过滤。
 * @param {unknown} raw
 * @returns {string[]}
 */
function clientFilter(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== 'all');
}

/**
 * 工程目录 → 显示名（`package.json name > 目录名`，与"打开工程"用的
 * `server/src/project.js` 的 resolveProjectName 同一口径）。
 *
 * 为什么按目录现算、而不是直接用 projects.name：同名不同目录时，办公室会给新工程的
 * id / name 加冲突后缀（实测：`/home/yinghui/work/stb-insight` 的 package.json name 是
 * `stb-dashboard`，但那个 id 早在 09-20 就被一行历史脏数据占了，于是新工程叫 `stb-dashboard-2`）。
 * 目录名 / 包名才是用户认得出的名字。
 *
 * 缓存 60 秒：`/task-runs` 一次最多 2000 行，工程却只有几个 —— 不缓存就是每行读一次 package.json。
 * 读不到目录（工程被删 / 挪走）或没有 package.json 时退回库里的 name。
 * @param {{project_workspace_path?:string, project_name?:string, project_id?:string}} row
 */
const _projectLabelCache = new Map();
function projectLabelOf(row) {
  const ws = String((row && row.project_workspace_path) || '').trim();
  const fallback = String((row && row.project_name) || (row && row.project_id) || '');
  if (!ws) return fallback;
  const now = Date.now();
  const hit = _projectLabelCache.get(ws);
  if (hit && now - hit.at < 60_000) return hit.label || fallback;
  const label = resolveProjectName(ws) || fallback;
  _projectLabelCache.set(ws, { at: now, label });
  return label;
}

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

  /**
   * 各工程目录的总大小（字节），排除隐藏文件 / 隐藏目录。
   * 汇总报表「按工程」聚合时展示。目录大小服务端现算（不落库、不编造），
   * 按 workspace_path 缓存 30s。给出工程 id 串，返回 { id: bytes|null }。
   * 演示工程没有目录 → null（界面显示"—"）。
   */
  router.get('/project-sizes', (req, res) => {
    const ids = String(req.query.projects || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const out = {};
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = repo.raw.prepare(`SELECT id, workspace_path FROM projects WHERE id IN (${placeholders})`).all(...ids);
      for (const r of rows) out[r.id] = r.workspace_path ? cachedDirSize(r.workspace_path) : null;
    }
    return res.json({ ok: true, sizes: out });
  });

  router.get('/messages', (req, res) => {
    const project = req.query.project;
    if (!project) return res.status(400).json({ ok: false, error: { code: 'bad_payload', message: 'missing project' } });
    const q = req.query;
    const items = repo
      .listMessages(project, {
        members: q.members ? String(q.members).split(',').filter(Boolean) : undefined,
        types: q.types ? String(q.types).split(',').filter(Boolean) : undefined,
        // 轴 2：只取这条会话的消息。不传 = 所有会话（老行为）
        session: q.session ? String(q.session) : undefined,
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
   *              可为逗号分隔的一串（合并楼层 1F CodeBuddy = codebuddy + codebuddy-plugin）；
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
    // 楼层筛选：client 可以是**逗号分隔的一串** —— 合并楼层（1F CodeBuddy = CLI + Plugin）
    // 一个楼层对应两种成员 client，选它要一次把两路都取回来（口径见 products.js 的 clients）。
    const clients = clientFilter(req.query.client);
    const limit = Math.min(Math.max(Number(req.query.limit) || 2000, 1), 5000);
    // "还在进行"的判定窗口：10 分钟内还有心跳的 active 状态才算真在跑
    const cutoff = Date.now() - 10 * 60 * 1000;

    const conds = ['t.parent_task_id IS NULL'];
    const args = { limit, cutoff };
    if (project && project !== 'all') {
      conds.push('t.project_id = @project');
      args.project = project;
    }
    if (clients.length) {
      // 命中口径与报表分组一致（COALESCE(tr.client, m.client)），用 instr 做集合成员判定：
      // @client 是 ",a,b," 形式，单个 client 也走同一条（1F 之外行为不变）。
      conds.push("instr(@client, ',' || COALESCE(tr.client, m.client) || ',') > 0");
      args.client = `,${clients.join(',')},`;
    }

    // 始终 LEFT JOIN 报表层与成员，补全 client/model/文件/产出，并按 client 过滤
    const rows = repo.raw
      .prepare(
        `SELECT
           t.id, t.project_id, t.member_id, t.parent_task_id, t.title,
           t.progress, t.started_at, t.ended_at,
           COALESCE(tr.client, m.client) AS client,
           -- 轴 2（会话）：这一轮属于哪条会话。同一楼层可以同时开多条会话，
           -- 报表据此把同 client 的会话分开；NULL = 老任务 / 上报没带会话标识
           tr.session_id AS session_id,
           tr.form AS form,
           m.name AS member_name,
           -- 这一轮归属的工程名（任务详情里「工程」那一栏显示它）。
           -- projects.name 是"打开工程"时按 package.json name > 目录名 落的名字；
           -- 取不到（老数据 / 工程行被清过）时前端退回 project_id。
           p.name AS project_name,
           -- 工程目录：任务详情「工程」显示的名字按它现算（见 projectLabelOf）——
           -- 工程 id / name 可能带冲突后缀（同名不同目录：stb-dashboard-2），
           -- 而"这个目录现在叫什么名字"才是用户认得出的那个名字。
           p.workspace_path AS project_workspace_path,
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
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE ${conds.join(' AND ')}
         ORDER BY t.started_at DESC
         LIMIT @limit`
      )
      .all(args);

    const items = rows.map((r) => ({
      ...r,
      duration_ms: r.ended_at && r.started_at ? r.ended_at - r.started_at : null,
      subagentCount: repo.countSubagentRuns.get(r.id).c,
      /**
       * 任务详情「工程」显示的名字：按工程**目录**现算（`package.json name > 目录名`，
       * 与"打开工程"同一口径），拿不到目录/读不到 name 才退回库里那行 projects.name。
       * 为什么不用 projects.name：同名不同目录时办公室会给 id / name 加冲突后缀
       * （实测：stb-insight 的 package.json name 是 stb-dashboard，但 id 已被一行历史脏数据占了，
       * 于是新工程叫 stb-dashboard-2）—— 目录名才是用户认得出的那个名字。
       * 目录 → 名字的解析结果按目录缓存（同一工程几十上百条任务，别每条都去读 package.json）。
       */
      project_label: projectLabelOf(r),
      /**
       * 这一轮用过的工具 + 次数（任务详情里的「工具使用」）。
       * 真源是 tool_usage 表（上报方每调用一次工具 +1，见 bus.toolUse）；没有记录就是空数组，
       * 任务详情那一段整块不显示 —— 绝不拿"文件活动"之类的旁证折算成工具次数。
       */
      tools: repo.listTaskTools.all(r.id).map((x) => ({ tool: x.tool, count: Number(x.count) || 0 })),
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
    // 同 GET：client 可以是逗号分隔的一串（合并楼层一次删两路）
    const client = clientFilter(req.query.client).join(',') || null;
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
