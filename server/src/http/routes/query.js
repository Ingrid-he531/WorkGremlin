'use strict';

/** Read-only query endpoints. When WS drops, the frontend falls back to polling /api/v1/snapshot, which also lands here. */

const express = require('express');
const { DEFAULTS, formToSource, clientLabel } = require('@workgremlin/shared');
const { cachedDirSize } = require('../../dirSize');
const { resolveProjectName } = require('../../project');
const { resolveSessionTitle, sessionFirstPrompts } = require('../../sessions');

/**
 * Grace window (ms) during which a task counts as "still running": during pure thinking (the model
 * is generating and has not called a tool yet) the agent emits no hook event and therefore no
 * heartbeat, so the heartbeat expires after 10 minutes and misjudges the task as cancelled → the
 * main console / ticker drops back to "standby" at random during long thinking stretches. Give tasks
 * "whose last state is still active" a longer grace: as long as the latest active state (state_since)
 * is no older than this window, it still counts as running. Long thinking is continuous thinking, so
 * state_since is never stale; only a genuinely dead process (an active state stuck way in the past)
 * exceeds the grace and gets judged dead normally.
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
 *  An active heartbeat inside the heartbeat window (@cutoff, 10min) = really running; but the
 *  heartbeat expires during pure thinking, so tasks "whose last state is still active" get a longer
 *  grace: state_since no older than @grace_cutoff still counts as alive. */
function taskAliveSql() {
  return `(
    EXISTS (
      SELECT 1 FROM session_status ss
       WHERE ss.member_id = t.member_id AND ss.session_id = tr.session_id
         AND ss.task_id = t.id
         AND (ss.last_heartbeat_at > @cutoff
              OR (ss.state IN ('busy', 'blocked') AND ss.state_since > @grace_cutoff))
    ) OR (
      (tr.session_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM session_status ss
         WHERE ss.member_id = t.member_id AND ss.session_id = tr.session_id
      )) AND EXISTS (
        SELECT 1 FROM agent_status s
         WHERE s.task_id = t.id
           AND (s.last_heartbeat_at > @cutoff
                OR (s.state IN ('busy', 'blocked') AND s.state_since > @grace_cutoff))
      )
    )
  )`;
}

/**
 * Project directory → display name (`package.json name > directory name`, the same criterion as
 * resolveProjectName in `server/src/project.js` used by "open project").
 *
 * Why compute it live from the directory instead of using projects.name directly: when two
 * directories share a name, the office appends a collision suffix to the new project's id / name
 * (measured: `/home/yinghui/work/stb-insight`'s package.json name is `stb-dashboard`, but that id was
 * already taken by a row of historical dirty data back on 09-20, so the new project is called
 * `stb-dashboard-2`). The directory name / package name is what the user actually recognizes.
 *
 * Cached 60 seconds: `/task-runs` returns up to 2000 rows but there are only a handful of projects ——
 * without caching that means reading package.json once per row. Falls back to the name in the DB when
 * the directory cannot be read (project deleted / moved) or there is no package.json.
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
   * Total size (bytes) of each project directory, excluding hidden files / hidden directories.
   * Shown when roll-up reports aggregate "by project". Directory size is computed live on the server
   * (not persisted, not fabricated), cached 30s by workspace_path. Takes a project id string and
   * returns { id: bytes|null }. The demo project has no directory → null (the UI shows "—").
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
        // Axis 2: take only this session's messages. Absent = all sessions (old behavior)
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

    // Always LEFT JOIN the report layer and members to complete client / model / files / output, and
    // filter by client
    const rows = repo.raw
      .prepare(
        `SELECT
           t.id, t.project_id, t.member_id, t.parent_task_id, t.title,
           t.progress, t.started_at, t.ended_at,
           COALESCE(tr.client, m.client) AS client,
           -- Axis 2 (session): which session this round belongs to. The same floor can have several
           -- sessions open at once; reports use this to tell same-client sessions apart;
           -- NULL = an old task / a report that carried no session identifier
           tr.session_id AS session_id,
           tr.form AS form,
           m.name AS member_name,
           -- The project name this round is attributed to (shown in the "project" field of task details).
           -- projects.name is the name persisted when "opening a project" from
           -- package.json name > directory name; when it cannot be read (old data / project rows
           -- cleaned) the frontend falls back to project_id.
           p.name AS project_name,
           -- Project directory: the name shown in the "project" field of task details is computed
           -- live from it (see projectLabelOf) —— a project id / name can carry a collision suffix
           -- (same name, different directory: stb-dashboard-2), while "what this directory is called
           -- now" is the name the user actually recognizes.
           p.workspace_path AS project_workspace_path,
           tr.model AS model,
           tr.file_count AS file_count,
           tr.files_json AS files_json,
           tr.result AS result,
           -- Tokens consumed by this round (stored in four separate columns; semantics per the notes
           -- in db/schema.sql: input_tokens is only the part that **missed the cache**). NULL when
           -- unavailable is honest —— the frontend shows "—", **not 0** (0 means "consumption really
           -- was zero", which is not the same as "could not be read").
           tr.input_tokens AS input_tokens,
           tr.output_tokens AS output_tokens,
           tr.cache_read_tokens AS cache_read_tokens,
           tr.cache_write_tokens AS cache_write_tokens,
           -- The amount for this round (CNY). Only the Trae client has it —— Trae's
           -- ai-agent/database.db cannot be decrypted and renderer.log does not emit an
           -- input/output_tokens breakdown, only the amount. Non-Trae floors have NULL here and the
           -- frontend shows "—" (same criterion as the token columns).
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

    // Fallback session titles (the user's first message of the session): look up this batch's
    // session_id once up front instead of opening a query per row inside map (2000 rows × one query
    // would drag this endpoint down).
    const firstPrompts = sessionFirstPrompts(repo.raw, rows.map((r) => r.session_id));

    const items = rows.map((r) => ({
      ...r,
      // Hand over the final display string ready-made; the frontend no longer assembles it from form
      //   client_label → what shows on the "client" line of task details / lists, e.g. "TraeCode IDE"
      //   source       → normalized form identifier (plugin/cli/ide), used by the frontend session
      //                   dropdown to add a prefix
      client_label: clientLabel(r.client || r.member_id, r.form),
      source: formToSource(r.form),
      // Registration identity (agent base name, e.g. codebuddy / kilo) —— the frontend groups floors by it
      memberId: r.member_id,
      duration_ms: r.ended_at && r.started_at ? r.ended_at - r.started_at : null,
      subagentCount: repo.countSubagentRuns.get(r.id).c,
      /**
       * Session title: a **session-level** name, every task with the same session_id gets the same
       * value —— that is how multiple rounds of one session are recognized (one row of task per
       * round, each round with a different title).
       * Resolution order:
       *   1. The floor's own SQLite session title (7F Kilo / 8F OpenCode / 6F Qoder, a summary the
       *      agent produced);
       *   2. Fallback = the user's first message of that session (other floors: the title at session
       *      start is the user's own words).
       * When neither is available (no session_id / no such round in the store) it is always the empty
       * string, never fabricated —— the frontend simply hides that line then.
       */
      session_title: resolveSessionTitle(r.session_id, r.client) || firstPrompts.get(String(r.session_id || '').trim()) || '',
      /**
       * The name shown in the "project" field of task details: computed live from the project
       * **directory** (`package.json name > directory name`, same criterion as "open project"), and
       * only falls back to projects.name from the DB when the directory is missing / the name cannot
       * be read.
       * Why not projects.name: with two directories sharing a name the office appends a collision
       * suffix to the id / name (measured: stb-insight's package.json name is stb-dashboard, but that
       * id was already taken by dirty historical data, so the new project is called stb-dashboard-2)
       * —— the directory name is the one the user recognizes.
       * The directory → name resolution is cached per directory (one project can have dozens or
       * hundreds of task rows; do not read package.json once per row).
       */
      project_label: projectLabelOf(r),
      /**
       * Tools used in this round with their counts (the "tool usage" block in task details).
       * The real source is the tool_usage table (the reporter +1s it on every tool call, see
       * bus.toolUse); no records means an empty array and that whole block is hidden —— never convert
       * circumstantial evidence like "file activity" into tool counts.
       */
      tools: repo.listTaskTools.all(r.id).map((x) => ({ tool: x.tool, count: Number(x.count) || 0 })),
    }));
    return res.json({ ok: true, items });
  });

  /**
   * Task feed for the lintel ticker (TaskTicker.vue in the renderer): current tasks from **all
   * floors** (no floor filter), plus those that wrapped up within the last `minutes` minutes.
   *
   * Division of labor with /task-runs: that one is the ledger for "digging through old records"
   * (2000 rows by default, newest start time first, for the task records page); this one is about
   * "what is happening right now", so:
   *   · It only takes **still running** ones (blocked-awaiting-permission included) and **just
   *     wrapped up** ones, so the count is naturally small;
   *   · It is not affected by the limit cut-off —— a task that has run for three hours does not get
   *     pushed off screen by hundreds of new tasks in between;
   *   · Order: running first (by ascending start time), then finished (by ascending end time), and
   *     the frontend just scrolls in the order it receives.
   *
   * State normalization follows the same criterion as /task-runs (legacy running tasks are judged by
   * heartbeat; when there is no heartbeat during pure thinking the TASK_ALIVE_GRACE_MS state_since
   * grace catches it, so long thinking is not misjudged as cancelled) —— otherwise a task that is
   * "forever in progress" would scroll by as a zombie.
   */
  router.get('/task-feed', (req, res) => {
    const minutes = Math.min(Math.max(Number(req.query.minutes) || 5, 1), 120);
    const since = Date.now() - minutes * 60_000;
    // "Still going" window: only an active state with a heartbeat within the last 10 minutes counts as
    // really running (with no heartbeat during pure thinking, the TASK_ALIVE_GRACE_MS state_since
    // grace catches it, see taskAliveSql)
    const cutoff = Date.now() - 10 * 60_000;
    const graceCutoff = Date.now() - TASK_ALIVE_GRACE_MS;
    const project = req.query.project;

    // Task records look up session state by task_runs.session_id; agent_status is only a fallback for
    // legacy data.
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
   * subagent instances summoned by a single user task (subagent_runs).
   * parent is required; its value is a task_runs.id.
   */
  router.get('/subagent-runs', (req, res) => {
    const parent = req.query.parent;
    if (!parent) return res.status(400).json({ ok: false, error: { code: 'bad_payload', message: 'missing parent' } });
    const items = repo.listSubagentRuns.all(parent).map((r) => ({
      ...r,
      // There is no form column in subagent_runs; clientLabel falls back to the base name when given
      // no form
      client_label: clientLabel(r.client || r.member_id, r.form),
    }));
    return res.json({ ok: true, items });
  });

  /**
   * Delete a single task record (with its subagent children, ledger entries, messages and outputs).
   * The second confirmation happens client-side; this only does the actual deletion.
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

  // ---- Record retention days (this is what automatic server-side cleanup follows) ----
  router.get('/settings/retention', (req, res) => {
    res.json({ ok: true, days: repo.getRetentionDays() });
  });
  router.put('/settings/retention', (req, res) => {
    // No days given / unreadable → fall back to the default (same source as getRetentionDays' default)
    const days = Math.max(1, Math.min(Number(req.query.days) || DEFAULTS.RETENTION_DAYS, 3650));
    repo.setSetting('retentionDays', days);
    // Clean once immediately under the new retention period so the change takes effect right away
    // (the daily timer keeps handling rolling cleanup afterwards)
    let cleaned = 0;
    try {
      cleaned = repo.deleteTaskRunsByFilter({ beforeTs: Date.now() - days * 24 * 60 * 60 * 1000 });
    } catch {
      /* a failed cleanup does not affect saving */
    }
    res.json({ ok: true, days, cleaned });
  });

  return router;
}

module.exports = { createQueryRouter };
