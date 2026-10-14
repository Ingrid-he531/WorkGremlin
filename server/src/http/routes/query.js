'use strict';

/** 只读查询接口。WS 断线时前端降级轮询 /api/v1/snapshot 也会走这里。 */

const express = require('express');
const { DEFAULTS, formToSource, clientLabel } = require('@workgremlin/shared');
const { cachedDirSize } = require('../../dirSize');
const { resolveProjectName } = require('../../project');
const { resolveSessionTitle, sessionFirstPrompts } = require('../../sessions');

/**
 * 任务"还在跑"的宽限窗口（ms）：纯思考（模型在生成、还没调工具）期间 agent 不会发任何 hook
 * 事件、也就没有心跳，心跳会在 10 分钟后过期把任务误判成取消 → 主控制台 / 滚动屏在长思考时
 * 随机掉回「待命」。给"最后状态还是 active"的任务一个更长的宽限：只要最近一次 active 状态
 * （state_since）不早于这个窗口，就仍然算在跑。长思考是连续的 thinking，state_since 不会太旧；
 * 真死的进程（active 状态卡在很久以前）才会超出宽限被正常判死。
 */
const TASK_ALIVE_GRACE_MS = 30 * 60 * 1000;

/**
 * Floor filter param → client list.
 * A single client ('codebuddy') or a comma-separated string ('codebuddy,codebuddy-plugin', used by
 * merged floors); 'all' / empty = no filter.
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
 * Project filter param → id list.
 * A single project id or a comma-separated list (the multi-select frontend joins them with commas);
 * 'all' / empty = no filter.
 * @param {unknown} raw
 * @returns {string[]}
 */
function projectFilter(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'all');
}

/** Prefer exact session activity; retain member-slot fallback for legacy and untracked rows.
 *  心跳窗口（@cutoff，10min）内还有 active 心跳 = 真在跑；但纯思考期间没有心跳会过期，
 *  所以再给"最后状态仍是 active"的任务一个更长宽限：state_since 不早于 @grace_cutoff 仍算活。 */
function taskAliveSql() {
  return `(
    EXISTS (
      SELECT 1 FROM session_status ss
       WHERE ss.member_id = t.member_id AND ss.session_id = tr.session_id
         AND ss.task_id = t.id
         AND (ss.last_heartbeat_at > @cutoff
              OR (ss.state IN ('busy', 'thinking', 'blocked') AND ss.state_since > @grace_cutoff))
    ) OR (
      (tr.session_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM session_status ss
         WHERE ss.member_id = t.member_id AND ss.session_id = tr.session_id
      )) AND EXISTS (
        SELECT 1 FROM agent_status s
         WHERE s.task_id = t.id
           AND (s.last_heartbeat_at > @cutoff
                OR (s.state IN ('busy', 'thinking', 'blocked') AND s.state_since > @grace_cutoff))
      )
    )
  )`;
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
   * Task records: one row per user task, with the tasks table as the single source of truth (history
   * across all projects and floors). Only top-level user tasks (parent_task_id IS NULL); subagent
   * child rows come from /subagent-runs.
   *
   * Top-level filters (server-side):
   *   - project: a project id, or a comma-separated list of ids (multi-select); absent / 'all' = all projects.
   *   - client : floor = the member client that ran the task (codebuddy/codex/workbuddy/claude…);
   *              may be a comma-separated string (merged floor 1F CodeBuddy = codebuddy + codebuddy-plugin);
   *              absent / 'all' = all floors.
   * The second-level filter (state) is applied by the frontend on the fetched rows (see the state
   * segment in TaskRecordsView).
   *
   * Field completion (the tasks table itself only has skeleton columns):
   *   - client / model / file_count / files_json / result come from the report layer task_runs
   *     (LEFT JOIN, may be empty); client falls back to members.client so old tasks still show a floor.
   *   - duration_ms = ended_at - started_at (computed); subagentCount = subagent_runs count.
   *   - state normalization: stale 'running' tasks (process no longer alive) are treated as
   *     'cancelled'; when session_status is present, liveness is judged by that session's task_id /
   *     heartbeat; only old records fall back to the member-level agent_status. Note blocked must
   *     count as "still running": while waiting for permission the hook reports blocked
   *     (awaiting_permission), and dropping it would show the task as "cancelled" the moment a
   *     permission dialog appears and jump back to "running" after approval — a pure false alarm.
   */
  router.get('/task-runs', (req, res) => {
    const projects = projectFilter(req.query.project);
    // Floor filter: client may be a **comma-separated string** — a merged floor (1F CodeBuddy =
    // CLI + Plugin) maps to two member clients, and selecting it must fetch both (see products.js).
    const clients = clientFilter(req.query.client);
    const limit = Math.min(Math.max(Number(req.query.limit) || 2000, 1), 5000);
    // Liveness window: only active states with a heartbeat in the last 10 minutes count as really
    // running (during pure thinking there is no heartbeat, so the TASK_ALIVE_GRACE_MS state_since
    // grace below covers it — see taskAliveSql)
    const cutoff = Date.now() - 10 * 60 * 1000;
    const graceCutoff = Date.now() - TASK_ALIVE_GRACE_MS;
    const ALIVE = taskAliveSql();

    const conds = ['t.parent_task_id IS NULL'];
    const args = { limit, cutoff, grace_cutoff: graceCutoff };
    if (projects.length) {
      const names = projects.map((_, i) => `@proj${i}`);
      conds.push(`t.project_id IN (${names.join(', ')})`);
      projects.forEach((id, i) => { args[`proj${i}`] = id; });
    }
    if (clients.length) {
      // Same match as report grouping (COALESCE(tr.client, m.client)); instr does set-membership:
      // @client is ",a,b," and a single client takes the same path (",codebuddy," matches codebuddy).
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
           -- 这一轮消耗的 token（四列分列存，语义见 db/schema.sql 的注释：input_tokens
           -- 只是**没命中缓存**的那部分）。取不到时如实是 NULL —— 前端显示 "—"，
           -- **不是 0**（0 是"确实消耗为零"，跟"没读到"不是一回事）。
           tr.input_tokens AS input_tokens,
           tr.output_tokens AS output_tokens,
           tr.cache_read_tokens AS cache_read_tokens,
           tr.cache_write_tokens AS cache_write_tokens,
           -- 这一轮的金额（元）。只有 Trae 客户端有 —— Trae 的 ai-agent/database.db
           -- 加密解不开、renderer.log 也不下发 input/output_tokens 分项，只给金额。
           -- 非 Trae 楼层这列是 NULL，前端显示 "—"（与 token 列同口径）。
           tr.usage_yuan AS usage_yuan,
           CASE
             WHEN t.state = 'running'
                  AND NOT ${ALIVE}
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

    // 兜底的会话标题（会话第一轮的用户原话）：先按这批任务的 session_id 一次查完，
    // 别在 map 里逐条开查询（2000 条 × 一次查询 = 拖垮这个接口）。
    const firstPrompts = sessionFirstPrompts(repo.raw, rows.map((r) => r.session_id));

    const items = rows.map((r) => ({
      ...r,
      // 直接给最终显示字符串，前端不再自己按 form 拼
      //   client_label → 任务详情/列表里「客户端」那行显示的字，如 "TraeCode IDE"
      //   source       → 归一形态标识（plugin/cli/ide），前端会话下拉加前缀用
      client_label: clientLabel(r.client || r.member_id, r.form),
      source: formToSource(r.form),
      // 注册身份（agent 基名，如 codebuddy / kilo）—— 前端按它归楼层
      memberId: r.member_id,
      duration_ms: r.ended_at && r.started_at ? r.ended_at - r.started_at : null,
      subagentCount: repo.countSubagentRuns.get(r.id).c,
      /**
       * 会话标题：**会话级**的名字，同一 session_id 的所有任务拿到同一个值 ——
       * 凭它把同一会话的多轮任务认出来（一轮一行任务，各轮标题互不相同）。
       * 取值顺序：
       *   1. 楼层自己的 SQLite 会话标题（7F Kilo / 8F OpenCode / 6F Qoder，agent 起的摘要）；
       *   2. 兜底 = 这条会话**第一轮**的用户原话（其余楼层：会话开始时的标题就是用户原话）。
       * 两者都拿不到（没有 session_id / 库里没那一轮）一律空串，绝不编造 ——
       * 前端这时不显示那一行。
       */
      session_title: resolveSessionTitle(r.session_id, r.client) || firstPrompts.get(String(r.session_id || '').trim()) || '',
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
   * 门楣滚动屏的任务流（renderer 的 TaskTicker.vue）：**所有楼层**（不按楼层过滤）
   * 的当前任务，加最近 `minutes` 分钟内收工的那几条。
   *
   * 与 /task-runs 的分工：那个是"翻旧账"的台账（默认 2000 行、按开始时刻倒序，给任务记录页用）；
   * 这里要的是"现在正在发生什么"，所以：
   *   · 只取**还在跑**的（含等权限的 blocked）与**刚收工**的，条数天然很小；
   *   · 不受 limit 截断影响 —— 一条跑了三小时的任务不会因为中间插进几百条新任务就滚不出屏；
   *   · 排序：在跑的在前（按开工时刻升序），收工的在后（按收工时刻升序），
   *     前端拿到就直接按这个顺序依次滚动。
   *
   * state 归一与 /task-runs 同一口径（遗留 running 任务按心跳判定；纯思考无心跳时再靠
   * TASK_ALIVE_GRACE_MS 的 state_since 宽限兜底，免得长思考时任务被误判成 cancelled），
   * 免得屏上滚出一条"永远在进行中"的僵尸任务。
   */
  router.get('/task-feed', (req, res) => {
    const minutes = Math.min(Math.max(Number(req.query.minutes) || 5, 1), 120);
    const since = Date.now() - minutes * 60_000;
    // "还在进行"的判定窗口：10 分钟内还有心跳的 active 状态才算真在跑（纯思考无心跳时，
    // 再靠 TASK_ALIVE_GRACE_MS 的 state_since 宽限兜底，见 taskAliveSql）
    const cutoff = Date.now() - 10 * 60_000;
    const graceCutoff = Date.now() - TASK_ALIVE_GRACE_MS;
    const project = req.query.project;

    // 任务记录按 task_runs.session_id 查会话状态；agent_status 仅为老数据兜底。
    const ALIVE = taskAliveSql();

    const conds = [
      't.parent_task_id IS NULL',
      `((t.state = 'running' AND ${ALIVE}) OR (t.state IN ('done', 'failed', 'cancelled') AND t.ended_at >= @since))`,
    ];
    const args = { since, cutoff, grace_cutoff: graceCutoff, limit: 100 };
    if (project && project !== 'all') {
      conds.push('t.project_id = @project');
      args.project = project;
    }

    const items = repo.raw
      .prepare(
        `SELECT t.id, t.project_id, t.member_id AS memberId, t.title, t.started_at, t.ended_at,
                COALESCE(tr.client, m.client) AS client,
                CASE WHEN t.state = 'running' AND NOT ${ALIVE} THEN 'cancelled' ELSE t.state END AS state
           FROM tasks t
           LEFT JOIN task_runs tr ON tr.id = t.id
           LEFT JOIN members m ON m.id = t.member_id
          WHERE ${conds.join(' AND ')}
          ORDER BY CASE WHEN t.state = 'running' AND ${ALIVE} THEN 0 ELSE 1 END,
                   COALESCE(t.ended_at, t.started_at) ASC
          LIMIT @limit`
      )
      .all(args);
    return res.json({ ok: true, items });
  });

  /**
   * 单个用户任务召唤出去的 subagent 实例（subagent_runs）。
   * parent 必填，值为 task_runs.id。
   */
  router.get('/subagent-runs', (req, res) => {
    const parent = req.query.parent;
    if (!parent) return res.status(400).json({ ok: false, error: { code: 'bad_payload', message: 'missing parent' } });
    const items = repo.listSubagentRuns.all(parent).map((r) => ({
      ...r,
      // subagent_runs 表里没 form 字段,clientLabel 不传 form 时按基名返回
      client_label: clientLabel(r.client || r.member_id, r.form),
    }));
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
   * Bulk delete by the top-level filters (project + floor):
   *   - mode=all    : delete every record matching the filters;
   *   - mode=recent : keep only the last days (defaults to DEFAULTS.RETENTION_DAYS, 1~3650) and delete older ones.
   * Both are destructive, so the frontend shows a confirmation with the affected count first.
   */
  router.delete('/task-runs', (req, res) => {
    // Same as GET: project / client may each be a comma-separated list (multi-select, and a merged
    // floor deletes both of its clients at once).
    const project = projectFilter(req.query.project).join(',') || null;
    const client = clientFilter(req.query.client).join(',') || null;
    const mode = req.query.mode || 'all';
    let beforeTs = null;
    if (mode === 'recent') {
      // Without days, read it as the "retention period" and take the same default as the setting (the current UI only sends mode=all)
      const days = Math.max(1, Math.min(Number(req.query.days) || DEFAULTS.RETENTION_DAYS, 3650));
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
    // 没带 days / 带了个读不出数 → 回缺省值（跟 getRetentionDays 的缺省同一个源）
    const days = Math.max(1, Math.min(Number(req.query.days) || DEFAULTS.RETENTION_DAYS, 3650));
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