'use strict';

/**
 * Ingest event bus: reports and directory-watch data land here, are persisted, then broadcast.
 *
 * Workstation state is only busy / idle / blocked. Task liveness comes from tasks.state, current
 * files from the running task's task_runs row, and recent activity from task start / end times.
 * Progress, files and duration stay NULL when unavailable; they are never fabricated.
 */

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { MESSAGE_TYPES, DEFAULTS, WS_EVENTS, dedupeKey, isPluginClient, agentNameKey } = require('@workgremlin/shared');
const clock = require('../clock');
const config = require('../config');
const { resolveProjectName } = require('../project');
const { detectLevel, agentDescription } = require('../floors');
const { sessionModel } = require('../sessions');

function projectIdOf(name) {
  return name;
}

function memberIdOf(project, name) {
  return String(name).includes('@') ? name : `${name}@${project}`;
}

/**
 * Member client normalization: trim / lowercase only, empty becomes null.
 *
 * Convention (consistent with the floor / client model): **client is the floor's product base name**
 * (codebuddy / codex ...); the form (CLI / plugin) goes into `form`, not into identity. This **does not validate**
 * "is it a known floor": a wrong value (a form string like cli/vscode, or a misspelled base name) simply
 * matches no floor's filter, the frontend won't show it, no need to block it here.
 */
function normClient(v) {
  const c = String(v || '').trim().toLowerCase();
  return c || null;
}

/**
 * The **form** of this run: 'cli' / 'vscode' (IDE extension) / 'ide' / 'desktop' (a desktop app).
 * Products that can't be distinguished (Claude / Qoder...) and old data stay NULL -- the task list falls back to the product name only (e.g. "Codex").
 */
function normForm(v) {
  const s = String(v || '').trim().toLowerCase();
  // form stores the **form** (cli / vscode / ide / desktop). Old data / some reports pass the "source name" plugin as form;
  // normalize it to its corresponding form vscode -- otherwise isPluginClient won't recognize it and the task list's "... Plugin" label is lost.
  if (s === 'plugin') return 'vscode';
  if (s === 'cli' || s === 'ide' || s === 'desktop' || isPluginClient(s)) return s;
  return null;
}

/** Model name: NULL when unavailable (never guessed), truncated when too long */
function normModel(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, 64) : null;
}

/**
 * Session id (axis 2): the hook payload's `session_id` / the plugin session id.
 * NULL when unavailable -- "no session identifier" and "the session is an empty string" are two different things; the former is a legitimate legacy data shape.
 * Truncation (128) is purely defensive: the real value is a UUID, the plugin side may use another form.
 */
function normSession(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, 128) : null;
}

/** Task id: NULL when unavailable (same rule as normSession, never guessed) */
function normTaskId(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, 128) : null;
}

/** Ledger "output" full-text cap: AI replies arrive with the hook-side RESULT_MAX(4000), this must be >= it or they get cut off */
const RUN_RESULT_MAX = 4_000;

/** Text fields in the ledger: collapse whitespace + truncate; an empty string always counts as "none" (NULL) */
function normText(v, max) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function jsonOrNull(v) {
  if (v === undefined || v === null) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

/** A single token count: only non-negative integers accepted (floats rounded, negatives and non-finite values all count as "not reported") */
function normCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * Tokens reported on finish (`{input, output, cacheRead, cacheWrite}`; see the comments in schema.sql for semantics).
 * Whole block missing / one field unreadable -> that field NULL: the report shows a blank "—", **never faking a 0** as "zero consumption".
 * Floors that can't provide it (5F TraeCode has no usage, 6F Qoder has none in its transcript, 9F Copilot isn't wired up)
 * don't send the block at all, so it just stays blank.
 * @returns {{input: number|null, output: number|null, cacheRead: number|null, cacheWrite: number|null}}
 */
function normTokens(t) {
  const o = t && typeof t === 'object' ? t : {};
  return {
    input: normCount(o.input),
    output: normCount(o.output),
    cacheRead: normCount(o.cacheRead),
    cacheWrite: normCount(o.cacheWrite),
  };
}

/**
 * The current HEAD commit sha (returns null when the workspace is not a git repo / git isn't installed).
 * Used to take a baseline at "task start"; at task end we diff baseline..HEAD for the full change set (including committed parts).
 * @param {string} ws absolute path of the project workspace
 * @returns {string|null}
 */
function gitHead(ws) {
  if (!ws) return null;
  try {
    return execFileSync('git', ['-C', ws, 'rev-parse', 'HEAD'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Current size of a single file (bytes): stat by workspace path; missing file / not a file -> null (never fabricated).
 * Deleted files are set to null directly in enrichFiles; this function isn't called for them.
 * @param {string} ws absolute path of the project workspace
 * @param {string} rel path relative to the workspace
 * @returns {number|null}
 */
function fileSize(ws, rel) {
  if (!ws) return null;
  try {
    const st = fs.statSync(path.resolve(ws, rel));
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * Complete the reported file list into [{path, op, size}]:
 *   - op comes from the hook (write=added / edit=modified / delete=deleted; old data without op always counts as modified);
 *   - size is the current file size (bytes) stat'ed server-side by workspace path; deleted / missing files -> null.
 * When the same file appears multiple times, the op of the "last occurrence" wins (later overwrites earlier, deciding the final classification).
 * Keeps at most the first 50 entries. An empty list returns null (files_json is set to NULL when stored).
 * @param {string} ws absolute path of the project workspace
 * @param {Array<string|{path:string,op?:string}>} reportedFiles files given by the reporting side
 */
function enrichFiles(ws, reportedFiles) {
  const reported = Array.isArray(reportedFiles) ? reportedFiles : [];
  const seen = new Map();
  const sizeOf = new Map(); // sizes already computed by the hook (by path), take priority over the server-side stat
  for (const it of reported) {
    const p = typeof it === 'string' ? it : (it && it.path);
    if (!p) continue;
    const op = typeof it === 'string' ? null : (it && it.op) || null;
    seen.set(p, op); // same file appearing multiple times: later overwrites (the last operation decides the classification)
    // Record it when the reporting side carried the real size (stat'ed by the hook against its real
    // workspace at the moment of finish), so the file size still shows correctly when the server-side
    // project workspace_path doesn't match.
    if (typeof it !== 'string' && it && typeof it.size === 'number') sizeOf.set(p, it.size);
  }
  if (!seen.size) return null;
  const list = [...seen.entries()].map(([p, op]) => {
    let size;
    // Prefer the size given by the hook; when absent (old data / subagent reports) fall back to stat by the server-side workspace_path.
    if (sizeOf.has(p)) size = sizeOf.get(p);
    else size = op === 'delete' ? null : fileSize(ws, p);
    return { path: p, op: op || 'edit', size };
  });
  const capped = list.slice(0, 50);
  return capped.length ? capped : null;
}

/**
 * @param {{ repo: any, hub: any, projectName?: string, project?: string|null }} ctx
 */
function createIngestBus({ repo, hub, projectName = '', project = null }) {
  /** Server-side **default workspace fallback** (legacy attribution / polling), not a UI project selection. */
  const context = { projectName, project: project || null, workspacePath: '' };
  /** memberId -> 'user' | 'project': decided once at registration from the subagent directory */
  const levels = new Map();

  /**
   * Live ghost records (subagent summons), keyed by `project|client|session|idOrName`.
   *
   * The hook is a pure forwarder now, so summon / retire / sweep all run server-side and write
   * straight into the DB (an ephemeral member + a subagent_run, tied to the session and the parent
   * task) instead of a manifest file that a separate poller read back. gcGhosts() (driven by the
   * unified poller) disperses any record whose parent task ended or that outlived the orphan TTL.
   *
   * Each **instance** gets its own ephemeral member (its id carries a per-call suffix, see
   * ghostSpawn): the office draws one sprite per member, so N concurrent same-name subagents must be
   * N members — a shared `subagent-<name>` id collapsed them into a single sprite.
   */
  const ghosts = new Map();
  /** Fallback counter for a ghost instance whose floor reported no per-call id (see ghostSpawn) */
  let ghostSeq = 0;
  /** Orphan TTL: a summon with no end signal is treated as gone after this long. */
  const GHOST_ORPHAN_MS = 5 * 60_000;
  /** Background subagents outlive their parent round by design, so they get their own longer TTL. */
  const GHOST_BACKGROUND_ORPHAN_MS = 60 * 60_000;
  /**
   * Where the finish summary lands: artifacts.kind is limited to file/doc/pr/text (CHECK), so the
   * summary is stored as kind='text' plus this path marker, which the renderer reads as the "report".
   */
  const GHOST_SUMMARY_PATH = 'workgremlin:summary';
  /** Agent roster (injected by index.js once it exists); a summoned gremlin shows busy. Optional. */
  let ghostRoster = null;
  const now = () => clock.now();

  function ensureProject(name, workspacePath = '', mainConversationId = null, source = 'report') {
    const id = projectIdOf(name);
    repo.upsertProject.run({
      id,
      name,
      workspacePath,
      mainConversationId,
      source,
      createdAt: now(),
    });
    return id;
  }

  /**
   * Which **project** (id) this report should land under.
   *
   * The `project` in older reports was the server's default workspace name (historically called the
   * "open project"), while `workspacePath` is the directory the reporter **is actually in**. When
   * those disagree, the task must belong to the real directory, not the default.
   * Measured 2026-09-29: a codex task run in /home/yinghui/work/stb-insight showed up in the task list
   * under workgremlin (the project name of that session in the office view was correct -- sessions follow the rollout's cwd).
   *
   * So **workspacePath wins**:
   *   1) an existing project is found by this path -> use its id;
   *   2) not found -> derive a name from this directory (package.json name > directory name, same rule as server/src/project.js)
   *      and create one;
   *   3) no workspacePath given (old reports / hand-written scripts) -> fall back to the `project` field, behavior unchanged.
   * @param {string} reportedProject fallback project name (legacy reports only)
   * @param {string} workspacePath the directory the reporter is actually in
   * @returns {string} project id (empty string = neither side given it, the caller treats it as missing project)
   */
  function projectForReport(reportedProject, workspacePath = '') {
    const ws = String(workspacePath || '').trim();
    if (!ws) return reportedProject ? projectIdOf(reportedProject) : '';
    let abs = '';
    try {
      abs = path.resolve(ws);
    } catch {
      return reportedProject ? projectIdOf(reportedProject) : '';
    }
    const row = repo.getProjectByWorkspace.get(abs);
    if (row && row.id) return row.id;
    const name = resolveProjectName(abs) || path.basename(abs);
    if (!name) return reportedProject ? projectIdOf(reportedProject) : '';
    ensureProject(name, abs, null, 'report');
    return projectIdOf(name);
  }

  /**
   * Register a member (gremlin / main agent / ghost).
   *
   * Contract: **client is required and is the floor's product base name** (codebuddy / codex ...). The
   * caller is already in some floor's context and must pass its own floor; a wrong value (a form string or
   * a misspelled base name) simply won't match any floor filter on the frontend, and isn't validated here.
   * memberId is the member's **name** (with the project suffix, e.g. peter@workgremlin) and is a different
   * thing from client -- don't mix them up: floors compare client, memberId is only the primary key.
   *
   * @param {{project: string, memberId?: string, name: string, role?: string, sessionId?: string, workspacePath?: string,
   *          ephemeral?: boolean, projectLabel?: string|null, client: string, reported?: number}} p
   */
  function registerMember(p) {
    const project = projectIdOf(p.project);
    ensureProject(p.project, p.workspacePath || '', null, 'report');
    const id = memberIdOf(project, p.memberId || p.name);
    const existing = repo.getMember.get(id);
    repo.upsertMember.run({
      id,
      projectId: project,
      name: p.name || id.split('@')[0],
      role: p.role ?? null,
      sessionId: p.sessionId ?? null,
      // reported=0 means "passively observed only" (a member discovered by route A), it does not actively report truth
      reported: p.reported === 0 ? 0 : 1,
      createdAt: existing ? existing.created_at : now(),
      // Ephemeral member (no workstation / a ghost in the scene). An existing member's ephemeral only goes up, never down (see upsertMember's MAX)
      ephemeral: p.ephemeral ? 1 : 0,
      projectLabel: p.projectLabel ?? null,
      // Source client (absent for demo/hand-made data, i.e. NULL)
      client: normClient(p.client),
    });
    // subagent level (user / project): the caller may pass it (floors detect their own agents);
    // otherwise scan the agent dirs by name. Stored in the in-memory map.
    const lvl = p.level || detectLevel(p.name || p.memberId || '', p.workspacePath || '', p.client);
    if (lvl) levels.set(id, lvl);
    else levels.delete(id);
    hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, buildMemberCard(id));
    return id;
  }

  function requireMember(project, memberId) {
    const id = memberIdOf(project, memberId);
    const m = repo.getMember.get(id);
    if (!m) return null;
    return m;
  }

  /** Clear only the explicit blocked row for one session. Task activity never touches borrowed busy. */
  function clearSessionBlocked(memberId, sessionId = null) {
    const sid = normSession(sessionId);
    if (!sid) return 0;
    return repo.deleteSessionStatus.run({ memberId, sessionId: sid }).changes;
  }

  /**
   * Clear only this session's explicit authorization wait. A session ending or finishing a round must
   * never affect another session's blocked state or running task.
   */
  function clearBlocked(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const sessionId = normSession(p.sessionId);
    if (!sessionId) return { ok: true, card: buildMemberCard(member.id) };
    const before = buildMemberCard(member.id);
    repo.deleteSessionStatus.run({ memberId: member.id, sessionId });
    const card = buildMemberCard(member.id);
    if (!cardsEqual(before, card)) hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, card);
    return { ok: true, card };
  }

  function cardsEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * Reconcile sessions that no longer exist in the polling source.
   * Explicit blocked rows are removed and running tasks from vanished sessions are closed as cancelled.
   * The card is rebuilt once after all changes so a sweep cannot emit a burst of intermediate states.
   */
  function pruneSessionStatuses(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const sessionIds = [...new Set((Array.isArray(p.sessionIds) ? p.sessionIds : [])
      .map((v) => normSession(v))
      .filter(Boolean))];
    const ts = Number(p.ts) || now();
    const before = buildMemberCard(member.id);
    const running = typeof repo.listRunningTaskRunsForMember?.all === 'function'
      ? repo.listRunningTaskRunsForMember.all({ memberId: member.id })
      : [];
    const live = new Set(sessionIds);
    let ended = 0;
    for (const task of running) {
      if (live.has(normSession(task.session_id))) continue;
      endTask(
        {
          project,
          memberId: member.id,
          taskId: task.id,
          sessionId: task.session_id,
          state: 'cancelled',
          ts,
        },
        { broadcastCard: false }
      );
      ended += 1;
    }
    const result = repo.pruneSessionStatuses.run({
      memberId: member.id,
      sessionIds: JSON.stringify(sessionIds),
    });
    if (!result.changes && !ended) return { ok: true, removed: 0, ended: 0 };
    const card = buildMemberCard(member.id);
    if (!cardsEqual(before, card)) hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, card);
    return { ok: true, removed: result.changes, ended, card };
  }

  /**
   * Close top-level running tasks whose session is no longer active.
   *
   * Session identity is the only liveness key: project, floor and client are deliberately ignored.
   * The grace period bridges the short window between a task start report and the next session scan.
   * Member cards are rebuilt once per affected member after the sweep, so several cancellations do
   * not emit a burst of intermediate states.
   *
   * @param {{activeSessionIds?: Iterable<string>, now?: number, graceMs?: number}} [p]
   * @returns {{ok: boolean, checked: number, ended: number, error?: string}}
   */
  function reconcileRunningTasksWithActiveSessions({ activeSessionIds, now: nowMs, graceMs = 30_000 } = {}) {
    if (activeSessionIds == null) {
      return { ok: false, checked: 0, ended: 0, error: 'missing_active_sessions' };
    }
    const active = new Set(
      [...activeSessionIds]
        .map((sessionId) => normSession(sessionId))
        .filter(Boolean)
    );
    const rows = typeof repo.listRunningTasksForSessionReconcile?.all === 'function'
      ? repo.listRunningTasksForSessionReconcile.all()
      : [];
    const ts = Number(nowMs) || now();
    const grace = Math.max(0, Number(graceMs) || 0);
    const affected = new Map();
    let ended = 0;

    for (const row of rows) {
      const sessionId = normSession(row.sessionId);
      if (sessionId && active.has(sessionId)) continue;
      const startedAt = Number(row.startedAt) || 0;
      if (startedAt && ts - startedAt < grace) continue;

      const project = projectIdOf(row.projectId);
      const member = requireMember(project, row.memberId);
      if (!member) continue;

      const key = `${project}\n${member.id}`;
      if (!affected.has(key)) {
        affected.set(key, { project, memberId: member.id, before: buildMemberCard(member.id) });
      }
      const result = endTask(
        {
          project,
          memberId: member.id,
          taskId: row.id,
          sessionId,
          state: 'cancelled',
          cancelReason: 'orphan_session',
          ts,
          // The sweep time is when we noticed, not when the task stopped (it may have been dead for
          // days/weeks). Leave the end unknown rather than stretching the task to this moment.
          endedAt: null,
        },
        { broadcastCard: false }
      );
      if (result.ok) ended += 1;
    }

    for (const { project, memberId, before } of affected.values()) {
      const card = buildMemberCard(memberId);
      if (!cardsEqual(before, card)) hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, card);
    }
    return { ok: true, checked: rows.length, ended };
  }

  /**
   * Record an explicit authorization wait for one session. Blocked is session-scoped and has no
   * standalone member-level row; a live task always remains the busy source of truth.
   */
  function setBlocked(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const id = member.id;
    const ts = Number(p.ts) || now();
    const sessionId = normSession(p.sessionId);
    if (!sessionId) return { ok: false, error: 'missing_session' };
    const before = buildMemberCard(id);
    const current = repo.getSessionStatus.get({ memberId: id, sessionId });
    if (!current || current.state !== 'blocked') {
      repo.upsertSessionStatus.run({ memberId: id, sessionId, state: 'blocked', stateSince: ts, updatedAt: ts });
    }
    const card = buildMemberCard(id);
    if (!cardsEqual(before, card)) hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, card);
    return { ok: true, card };
  }

  /**
   * Mark a resident gremlin busy because a same-name ghost is working. This is the only writer of
   * agent_status; it is a borrowed display state, not task liveness.
   */
  function setBorrowedBusy(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const id = member.id;
    const ts = Number(p.ts) || now();
    const before = buildMemberCard(id);
    const current = repo.getStatus.get(id);
    if (!current || current.state !== 'busy') {
      repo.upsertStatus.run({ memberId: id, state: 'busy', stateSince: ts, updatedAt: ts });
    }
    const card = buildMemberCard(id);
    if (!cardsEqual(before, card)) hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, card);
    return { ok: true, card };
  }

  /** Clear a resident gremlin's borrowed busy state. Idempotent: no row means already idle. */
  function clearBorrowedBusy(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const id = member.id;
    const before = buildMemberCard(id);
    repo.deleteStatus.run(id);
    const card = buildMemberCard(id);
    if (!cardsEqual(before, card)) hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, card);
    return { ok: true, card };
  }

  function startTask(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const ts = Number(p.ts) || now();
    const id = p.taskId || `t_${ts.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // Before opening a new round, close out the previous one (a session can't run two rounds at once), see endStaleTasksOfSession.
    // Passes client: a new CLI round only collects the old tasks of the same CLI session, and won't cut off tasks the IDE plugin is still running.
    endStaleTasksOfSession({
      project,
      sessionId: p.sessionId,
      ts,
      excludeTaskId: id,
      client: normClient(p.client),
    });

    repo.insertTask.run({
      id,
      projectId: project,
      memberId: member.id,
      parentTaskId: p.parentTaskId ?? null,
      title: p.title || '(未命名任务)',
      state: 'running',
      progress: Number.isFinite(p.progress) ? p.progress : 0,
      startedAt: ts,
      endedAt: null,
    });
    // The running task is the busy source of truth.
    clearSessionBlocked(member.id, p.sessionId);
    // Ledger: one round of tasks for the **main agent** = one user task (the input is the user's own words).
    // subagent instances don't take this path (they record subagent_runs), so the criterion is "is the reporter a main agent".
    if (String(member.role || '') === 'agent') {
      const wsRow0 = repo.getProject.get(project);
      const baseline = wsRow0 && wsRow0.workspace_path ? gitHead(wsRow0.workspace_path) : null;
      const client0 = member.client || null;
      repo.upsertTaskRun.run({
        id,
        projectId: project,
        memberId: member.id,
        client: client0,
        sessionId: normSession(p.sessionId),
        form: normForm(p.form),
        // Products whose hook payload carries no model field (TraeCode omits it in all six events, Claude Code
        // omits it everywhere except SessionStart): when empty, fetch the current model from each session's
        // **own on-disk files** (see sessions.sessionModel: the trae / claude adapters).
        // Empty when unavailable -- the report's "model" column stays blank, never faked with a default model.
        model: normModel(p.model) || sessionModel(p.memberId, p.sessionId) || null,
        title: p.title || '(未命名任务)',
        startedAt: ts,
        baselineCommit: baseline,
      });
      if (p.files && p.files.length) {
        repo.setTaskRunFiles.run({ id, fileCount: p.files.length, filesJson: jsonOrNull(p.files) });
      }
    }
    hub.broadcast(project, WS_EVENTS.TASK_UPDATE, repo.getTask.get(id));
    hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, buildMemberCard(member.id));
    return { ok: true, taskId: id };
  }

  function taskProgress(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const ts = Number(p.ts) || now();
    repo.updateTask.run({ id: p.taskId, state: 'running', progress: p.progress ?? null, endedAt: null });
    // Progress proves the task is active, so any prior blocked state for this session is no longer current.
    clearSessionBlocked(member.id, p.sessionId);
    if (Array.isArray(p.files) && p.files.length) {
      repo.setTaskRunFiles.run({
        id: p.taskId,
        fileCount: p.files.length,
        filesJson: jsonOrNull(p.files),
      });
    }
    if (p.files && p.files.length) {
      for (const f of p.files) repo.insertFileActivity.run(member.id, f, 'write', ts);
      repo.trimFileActivity.run(member.id, member.id, 200);
    }
    hub.broadcast(project, WS_EVENTS.TASK_UPDATE, repo.getTask.get(p.taskId));
    hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, buildMemberCard(member.id));
    return { ok: true };
  }

  /**
   * Close tasks in the same session that **started earlier and still haven't wrapped up** -- i.e. the
   * previous round that this round superseded.
   *
   * The criterion is hard: **a session cannot run two rounds at once**. Once the new round has started,
   * the previous round must already be over; it only still shows running in the ledger because its end
   * event can never arrive.
   *
   * Why the server must do this itself: the CodeBuddy **plugin** (IDE form) sends **no hook event at all**
   * on stop (the CLI's FinalStop never comes in the IDE form), and the hook's state file is **one per
   * session** -- the new round's /task/start overwrites taskId / taskStartedAt wholesale, so the previous
   * round is thereafter out of reach even for the fallback scan (readReporterDones -> codebuddy.cancelAt),
   * and that row stays stuck at "in progress" forever: what the user sees is "I cancelled the task, the
   * screen still says in progress, but the main console is already idle".
   *
   * The state used is cancelled: products that finish normally send Stop / FinalStop (that would be done);
   * reaching here means this round had no end event at all -- it was not a normal finish. Only collect
   * within the **same sessionId**, and never touch other sessions (one member running two windows is
   * legitimate parallelism, they must not cut each other off).
   * @returns {number} how many were closed
   */
  function endStaleTasksOfSession({ project: p0, sessionId, ts: ts0, excludeTaskId = '', client: client0 } = {}) {
    const project = projectIdOf(p0);
    const sid = normSession(sessionId);
    if (!sid || !repo.listStaleRunningBySession) return 0;
    const ts = Number(ts0) || now();
    // Only collect old tasks of "the same form (CLI / plugin)". CodeBuddy's CLI and Plugin are both on 1F and
    // may even share one session_id (the same conversation can be reported by a terminal command or by an
    // IDE extension), but they run their own tasks -- a new CLI round must never cancel a task the IDE
    // plugin is still running (this was the earlier "running the CLI killed the plugin's task" bug).
    // When want is empty (the report carried no client, old data), fall back to filtering by session only, keeping the old behavior.
    const want = normClient(client0);
    let n = 0;
    for (const old of repo.listStaleRunningBySession.all(project, sid)) {
      if (!old.id || old.id === excludeTaskId) continue;
      // **A task that started at the same instant is this round itself**, not the superseded previous round: the
      // new round's started_at and the taskStartedAt the registry scan reads from the state file are the same
      // value (from the same hook report), and the caller here (sessionRegistry.flushSupersededTasks) cannot
      // pass excludeTaskId -- an earlier `>` boundary test made every new task get cut as the "previous round"
      // and written as cancelled the instant it started (the ticker rolled "cancelled" from the start, and the
      // task record / member card were both wrong until the real finish rewrote them). Measured 2026-10-09.
      if (Number(old.startedAt) && Number(old.startedAt) >= ts) continue;
      const oc = normClient(old.client);
      if (want && oc && oc !== want) continue; // different forms never cut each other off
      endTask({ project, memberId: old.memberId, taskId: old.id, sessionId: sid, state: 'cancelled', ts });
      n += 1;
    }
    return n;
  }

  function endTask(p, options = {}) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const ts = Number(p.ts) || now();
    const state = ['done', 'failed', 'cancelled'].includes(p.state) ? p.state : 'done';
    /**
     * `ts` is "when this end was reported", which is not always "when the task stopped": orphan
     * reconciliation only notices that a session is gone, possibly weeks after its last event. Passing
     * `endedAt: null` records the honest "unknown" instead of a fabricated interval; normal callers
     * omit it and keep `ts`.
     */
    const endedAt = p.endedAt === undefined ? ts : (p.endedAt === null ? null : Number(p.endedAt) || ts);

    const cancelReason = state === 'cancelled' ? normText(p.cancelReason, 64) : null;
    if (cancelReason && repo.cancelTaskWithReason) {
      repo.cancelTaskWithReason.run({ id: p.taskId, progress: p.progress ?? 1, endedAt, cancelReason });
    } else {
      repo.updateTask.run({ id: p.taskId, state, progress: p.progress ?? 1, endedAt });
    }
    const sessionId = normSession(p.sessionId);
    // A finished task supplies history only. Remaining running tasks (if any) keep the member busy.
    clearSessionBlocked(member.id, sessionId);
    for (const a of p.artifacts || []) {
      repo.insertArtifact.run(member.id, p.taskId ?? null, a.kind || 'file', a.title || a.path || '(产出)', a.path ?? null, ts);
      hub.broadcast(project, WS_EVENTS.ARTIFACT_NEW, {
        memberId: member.id,
        taskId: p.taskId ?? null,
        kind: a.kind || 'file',
        title: a.title || a.path || '(产出)',
        path: a.path ?? null,
        tsMs: ts,
      });
    }
    // Ledger wrap-up: end time / elapsed time / output (the finish summary) / files changed this round
    if (String(member.role || '') === 'agent') {
      const run = repo.getTaskRun.get(p.taskId);
      // Products that get their model from **on-disk files** (Claude Code / TraeCode) get another pass here: at
      // round start the transcript has no assistant line for this round yet, so what was read was the previous
      // round's model (or nothing at all for a session's first round, hence empty); reading once more by session
      // at finish gets this round's real one. See sessions.sessionModel.
      const endClient = (run && run.client) || member.client || null;
      const endSession = (run && run.session_id) || normSession(p.sessionId);
      // But **only backfill when the row has no model yet**: endTaskRun is `model = COALESCE(@model, model)`,
      // and COALESCE only blocks null, not non-empty values -- blind backfilling would rewrite the model another
      // floor fetched at round start into the different value re-fetched at finish (two values if the model was
      // switched mid-round), which is silently editing another floor's history.
      const refill = !run || !run.model ? normModel(sessionModel(endClient, endSession)) : null;
      const endModel = normModel(p.model) || refill;
      if (!run) {
        // An old hook or one attached mid-round: the start is unknown, so don't fabricate it -- leave started_at NULL and duration cannot be computed either
        repo.upsertTaskRun.run({
          id: p.taskId,
          projectId: project,
          memberId: member.id,
          client: endClient,
          sessionId: endSession,
          form: normForm(p.form),
          model: endModel,
          title: null,
          startedAt: null,
          baselineCommit: null,
        });
      }
      const startedAt = run ? Number(run.started_at) || null : null;
      const wsRow = repo.getProject.get(project);
      let reportedFiles = Array.isArray(p.files) ? p.files : [];
      // Fallback (bug 3): when the hook's state file is overwritten concurrently, roundFiles becomes empty -- the whole "files modified" column is blank.
      // file_activity already holds the truth of every file/touch in this round, so scoop it back once using the task window.
      if (!reportedFiles.length && startedAt) {
        const act = repo.listActivityInWindow.all(member.id, startedAt, ts, 50);
        // Fill in op as recorded in file_activity (this DB only ever has 'write'). Unrecognized values stay null,
        // and never fabricate them all as 'edit' -- that would call an "added" file "modified", stepping right on the "never fabricate" discipline.
        // Deleted files never enter this table at all, so this scoop path can't get deletions anyway; accept that.
        if (act.length) reportedFiles = act.map((f) => ({ path: f.path, op: f.op === 'write' ? 'write' : null }));
      }
      const filesJson = enrichFiles(wsRow ? wsRow.workspace_path : '', reportedFiles);
      const fileCount = reportedFiles.length
        ? reportedFiles.length
        : Number.isFinite(Number(p.fileCount))
          ? Number(p.fileCount)
          : null;
      // Title fallback: when the prompt wasn't available at round start (this CLI client sometimes doesn't send the prompt text),
      // startTask lands on "(未命名任务)". If it's still that default / empty at finish, derive a meaningful, non-fabricated title
      // from the files changed this round (take the first changed file's path), so at least rounds can be told apart.
      const UNNAMED = new Set(['', '(未命名任务)', '（未命名任务）']);
      const haveTitle = run && run.title && !UNNAMED.has(String(run.title));
      let finalTitle = haveTitle ? run.title : null;
      if (!finalTitle) {
        const firstPath =
          (filesJson && filesJson[0] && filesJson[0].path) ||
          (reportedFiles[0] && (reportedFiles[0].path || reportedFiles[0]));
        finalTitle = firstPath ? `改动 ${firstPath}` : 'CodeBuddy 会话任务';
      }
      repo.endTaskRun.run({
        id: p.taskId,
        title: finalTitle,
        model: endModel,
        form: normForm(p.form),
        result: normText(p.result, RUN_RESULT_MAX),
        fileCount,
        filesJson: filesJson ? JSON.stringify(filesJson) : null,
        endedAt,
        durationMs: startedAt && endedAt && endedAt > startedAt ? endedAt - startedAt : null,
      });
      /* Tokens consumed this round: the truth read by the hook / plugin from the session's on-disk files
         (see reporter/src/usage.js and plugin/index.js).
         NULL when unavailable -- a blank in this column means "this floor can't report it", which is different from "zero consumption".

         **When the whole block is missing, leave the row's existing value untouched** (do not write NULL): the same taskId may be
         finished twice (a second pass with SessionEnd / the interrupt path after Stop); if the second pass wrote NULL when it
         couldn't read usage, it would erase the truth written by the first -- "not reported" should only mean "no number this
         time", not wipe out an already-recorded number. A brand-new row is NULL anyway, so "leave untouched" and "stay blank" are the same result here. */
      if (p.tokens && typeof p.tokens === 'object') {
        const tk = normTokens(p.tokens);
        repo.setTaskRunTokens.run({
          id: p.taskId,
          inputTokens: tk.input,
          outputTokens: tk.output,
          cacheReadTokens: tk.cacheRead,
          cacheWriteTokens: tk.cacheWrite,
        });
      }
    }
    hub.broadcast(project, WS_EVENTS.TASK_UPDATE, repo.getTask.get(p.taskId));
    if (options.broadcastCard !== false) {
      hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, buildMemberCard(member.id));
      // On a ghost's finish, also refresh the same-named resident gremlin's card: its output this round is borrowed for display on that card (see ghostArtifacts)
      const heir = heirOf(member);
      if (heir) hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, buildMemberCard(heir));
    }
    return { ok: true };
  }

  /**
   * Report this round's tokens **after** finishing (writes only the four token columns, nothing else).
   *
   * Why a separate entry instead of calling endTask again: endTask rewrites result / files / ended_at
   * (`COALESCE` can't block an explicit empty string), and on a backfill we only have the token, so one
   * pass would wipe the output summary and file list written at finish.
   *
   * Why backfill at all: for the CodeBuddy **plugin** form (the VS Code extension), that request's usage
   * lands on disk much later than Stop -- at the moment of finish (even 1.2s later) it is still
   * `{state:'running'}` in index.json, with no startedAt and no usage (measured locally: the 0c1f... session's
   * first round stopped at 14:12:41, and that request only got usage after the second round had begun). So
   * failing to read the truth at finish doesn't mean "there is no number", it means "the number hasn't landed
   * on disk yet" -- waiting for it to land and then writing it again is the truth.
   *
   * When it can't be located (no "finished but without numbers" row in the session / the start doesn't match),
   * return ok as is and write nothing -- same discipline as "no number means no number": never write onto another round's head.
   */
  function backfillTaskTokens(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const tk = normTokens(p.tokens);
    if (tk.input == null && tk.output == null && tk.cacheRead == null && tk.cacheWrite == null) {
      return { ok: true, skipped: 'no_tokens' };
    }
    const row = repo.runAwaitingTokens.get(project, normSession(p.sessionId), Number(p.startedAt) || 0);
    if (!row) return { ok: true, skipped: 'no_run' };
    repo.setTaskRunTokens.run({
      id: row.id,
      inputTokens: tk.input,
      outputTokens: tk.output,
      cacheReadTokens: tk.cacheRead,
      cacheWriteTokens: tk.cacheWrite,
    });
    hub.broadcast(project, WS_EVENTS.TASK_UPDATE, repo.getTask.get(row.id));
    return { ok: true, taskId: row.id };
  }

  /**
   * Ledger: record the opening of one summon (a subagent instance).
   * Records both those with a workstation (susan) and those without (code-explorer / directly spawned built-in experts) --
   * the "how many subagents did this round use" account relies on it.
   * @returns {number|null} the ledger row id (handed to endSubagentRun on finish)
   */
  function startSubagentRun(p) {
    const project = projectIdOf(p.project);
    const r = repo.insertSubagentRun.run({
      projectId: project,
      parentTaskId: p.parentTaskId ?? null,
      taskId: p.taskId ?? null,
      memberId: p.memberId,
      name: normText(p.name, 64) || 'subagent',
      client: normClient(p.client),
      model: normModel(p.model),
      title: normText(p.title, 200),
      agentId: normText(p.agentId, 200) || null,
      sessionId: normSession(p.sessionId),
      callId: normText(p.callId, 200) || null,
      background: p.background === undefined ? null : p.background ? 1 : 0,
      // If no task row was given at summon time, the start moment is "unknown" -- leave NULL (elapsed time can't be computed either), never filled with "now" as a stand-in
      startedAt: p.startedAt === null ? null : Number(p.startedAt) || now(),
    });
    return r && r.lastInsertRowid ? Number(r.lastInsertRowid) : null;
  }

  /**
   * Ledger: a subagent instance finished -- fill in output (the finish summary), end time and elapsed time.
   * @param {{id: number|null, project?: string, result?: string, model?: string, files?: string[], endedAt?: number}} p
   */
  function endSubagentRun(p) {
    if (!p || !p.id) return 0;
    const project = p.project ? projectIdOf(p.project) : null;
    const wsRow = project ? repo.getProject.get(project) : null;
    const reportedFiles = Array.isArray(p.files) ? p.files : [];
    const filesJson = enrichFiles(wsRow ? wsRow.workspace_path : '', reportedFiles);
    return repo.endSubagentRun.run({
      id: p.id,
      model: normModel(p.model),
      result: normText(p.result, RUN_RESULT_MAX),
      filesJson: filesJson ? JSON.stringify(filesJson) : null,
      endedAt: Number(p.endedAt) || now(),
    }).changes;
  }

  /* ------------------------------ ghosts (subagent summons) ------------------------------ */

  /** ghost key: one record per (project, floor, session, per-call id or name) */
  function ghostKey(project, client, sessionId, idOrName) {
    return [project, client || '', sessionId || '', String(idOrName || '')].join('|');
  }

  /** Concurrent same-name summons each own their member now; drop a member only when its instance is gone. */
  function removeGhostMemberIfUnused(rec) {
    for (const r of ghosts.values()) if (r.memberId === rec.memberId) return;
    try {
      removeMember({ project: rec.project, memberId: rec.memberName });
    } catch {
      /* ignore */
    }
    // A roster "defined subagent": summon ended → its workstation goes back to idle. Each instance now
    // has its own member, so "is a same-name instance still running" must be judged by **name**, not by
    // the member instance —— otherwise the first of several concurrent summons would mark it idle.
    // Names are compared case-insensitively: the workstation is named after the definition file stem
    // (`simmon`) while the summon reports the frontmatter name (`Simmon`).
    for (const r of ghosts.values()) if (r.project === rec.project && agentNameKey(r.name) === agentNameKey(rec.name)) return;
    if (ghostRoster && rec.project === context.project && typeof ghostRoster.isDefined === 'function' && ghostRoster.isDefined(rec.name)) {
      try {
        ghostRoster.markIdle(rec.name);
      } catch {
        /* ignore */
      }
    }
  }

  /** Restore the display/member name from the persisted full member id. */
  function ghostMemberNameOfRun(row) {
    const memberId = String(row.member_id || '');
    const at = memberId.lastIndexOf('@');
    if (at > 0) return memberId.slice(0, at);
    const name = normText(row.name, 64) || 'subagent';
    return `subagent-${name}-${row.id}`;
  }

  function markGhostActive(project, name) {
    if (ghostRoster && project === context.project && typeof ghostRoster.isDefined === 'function' && ghostRoster.isDefined(name)) {
      try {
        ghostRoster.markActive(name);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Rebuild one in-memory ghost from its persisted run without inserting a second ledger row.
   * The original task is reused when possible; a finished or missing task is reopened under the
   * same id, preserving its original started_at through repo.insertTask's conflict update.
   */
  function attachPersistedGhost(row, at = null) {
    if (!row) return null;
    const project = projectIdOf(row.project_id);
    const client = normClient(row.client);
    const sessionId = normSession(row.session_id);
    if (!sessionId) return null;
    const name = normText(row.name, 64) || 'subagent';
    const callId = normText(row.call_id, 200) || '';
    const key = ghostKey(project, client, sessionId, callId || name);
    const existing = ghosts.get(key);
    if (existing && !existing.endedAt) return existing.runId === Number(row.id) ? existing : null;

    const memberName = ghostMemberNameOfRun(row);
    const memberId = memberIdOf(project, memberName);
    const projectRow = repo.getProject.get(project);
    registerMember({
      project,
      memberId: memberName,
      name,
      role: 'subagent',
      sessionId,
      ephemeral: true,
      workspacePath: projectRow ? projectRow.workspace_path || '' : '',
      client,
    });

    let taskId = normTaskId(row.task_id);
    const task = taskId ? repo.getTask.get(taskId) : null;
    if (!task || task.state !== 'running' || task.ended_at) {
      const taskRes = startTask({
        project,
        memberId: memberName,
        taskId: taskId || undefined,
        title: row.title || '',
        parentTaskId: row.parent_task_id ?? null,
        ts: Number(row.started_at) || now(),
      });
      taskId = taskRes && taskRes.taskId ? taskRes.taskId : taskId;
    }

    const rec = {
      key,
      project,
      memberId,
      memberName,
      name,
      client,
      sessionId,
      id: callId,
      agentId: String(row.agent_id || ''),
      background: Boolean(row.background),
      taskId,
      runId: Number(row.id),
      parentTaskId: row.parent_task_id || null,
      endedAt: 0,
      at: Number(at) || Number(row.started_at) || now(),
    };
    ghosts.set(key, rec);
    markGhostActive(project, name);
    return rec;
  }

  /**
   * Rehydrate open ghosts after a server restart. Only runs with the identity columns added for
   * restart recovery are eligible; historical rows without a session remain untouched.
   * @returns {number} how many ghosts were restored
   */
  function restoreGhosts() {
    let restored = 0;
    for (const row of repo.listRestorableSubagentRuns.all()) {
      const before = ghosts.size;
      attachPersistedGhost(row, Number(row.started_at) || now());
      if (ghosts.size > before) restored += 1;
    }
    return restored;
  }

  /**
   * Pick a live record by an exact instance identity, then by name only when the event carries no
   * identity at all. Guessing by name after a supplied id failed would retire another same-name summon.
   */
  function pickGhost(project, client, sessionId, name, id, agentId) {
    const list = [...ghosts.values()];
    const inScope = (r) =>
      r.project === project &&
      (!client || r.client === client) &&
      (!sessionId || !r.sessionId || r.sessionId === sessionId);
    if (id) {
      const byId = list.find((r) => inScope(r) && r.id && r.id === id);
      if (byId) return byId;
    }
    if (agentId) {
      const byAgent = list.find((r) => inScope(r) && r.agentId && r.agentId === agentId);
      if (byAgent) return byAgent;
    }
    if (id || agentId) return null;
    return list.find((r) => inScope(r) && (!name || r.name === name)) || null;
  }

  /** Close a ghost: end its own task + its subagent run (result is only given on the finish path) */
  function closeGhost(rec, p = {}) {
    if (rec.endedAt) return;
    if (rec.taskId) {
      try {
        endTask({
          project: rec.project,
          memberId: rec.memberName,
          taskId: rec.taskId,
          state: ['done', 'failed', 'cancelled'].includes(p.state) ? p.state : 'done',
          artifacts: p.result ? [{ kind: 'text', title: p.result, path: GHOST_SUMMARY_PATH }] : undefined,
        });
      } catch {
        /* ignore */
      }
    }
    endSubagentRun({ id: rec.runId, project: rec.project, result: p.result, model: p.model, files: p.files });
    rec.endedAt = now();
  }

  /**
   * The main agent summoned a subagent: create its ephemeral ghost member + open a subagent_run,
   * tied to the **session and the parent (user) task**. A repeated hook fire for the same record
   * reuses the still-open run instead of double-booking.
   * @param {{project:string, workspacePath?:string, client:string, sessionId?:string, name:string,
   *          task?:string, id?:string, parentTaskId?:string, taskId?:string, model?:string,
   *          agentId?:string, background?:boolean, progress?:number, files?:string[], startedAt?:number}} p
   * @returns {{memberId:string, runId:number|null}}
   */
  function ghostSpawn(p) {
    const project = projectIdOf(p.project);
    const name = normText(p.name, 64) || 'subagent';
    const client = normClient(p.client);
    const sessionId = normSession(p.sessionId);
    // One ephemeral member **per summoned instance**: the office draws one sprite per member, so a
    // shared `subagent-<name>` id made N concurrent same-name subagents collapse into a single ghost.
    // The display name stays the bare subagent name; the suffix only makes the primary key unique. The
    // per-call id is the natural suffix, with a counter for floors that report no id (string content is
    // whitelisted so it never smuggles an '@', which memberIdOf would read as "already qualified").
    const inst = String(p.id || '').trim().replace(/[^A-Za-z0-9_-]/g, '') || `${now().toString(36)}${(ghostSeq += 1)}`;
    const memberName = `subagent-${name}-${inst}`;
    const memberId = memberIdOf(project, memberName);
    const key = ghostKey(project, client, sessionId, p.id || name);
    const existing = ghosts.get(key);
    if (existing && !existing.endedAt) {
      return { memberId, runId: existing.runId };
    }
    registerMember({
      project,
      memberId: memberName,
      name,
      role: 'subagent',
      sessionId,
      ephemeral: true,
      projectLabel: '',
      workspacePath: p.workspacePath || '',
      client,
    });
    const parentTaskId = p.parentTaskId || currentMainTaskId(project) || null;
    // This ghost's own task row (office shows it as "current task"; the finish report hangs on it)
    const taskRes = startTask({
      project,
      memberId: memberName,
      title: p.task || '',
      progress: Number.isFinite(p.progress) ? p.progress : 0,
      files: p.files,
      parentTaskId,
    });
    const taskId = taskRes && taskRes.taskId ? taskRes.taskId : null;
    const runId = startSubagentRun({
      project,
      memberId,
      name,
      client,
      model: p.model,
      title: p.task || '',
      parentTaskId,
      taskId,
      agentId: p.agentId,
      sessionId,
      callId: p.id || null,
      background: p.background,
      startedAt: Number.isFinite(Number(p.startedAt)) ? Number(p.startedAt) : now(),
    });
    ghosts.set(key, {
      key,
      project,
      memberId,
      memberName,
      name,
      client,
      sessionId,
      id: p.id || '',
      agentId: String(p.agentId || ''),
      background: Boolean(p.background),
      taskId,
      runId,
      parentTaskId,
      endedAt: 0,
      at: now(),
    });
    markGhostActive(project, name);
    return { memberId, runId };
  }

  /**
   * Fill in the child identity once an asynchronous launch receipt arrives. The ghost was opened by
   * the spawning call id, so this only attaches metadata; it deliberately does not close the run.
   * @param {{project:string, client?:string, sessionId?:string, name?:string, id?:string,
   *          agentId?:string, background?:boolean}} p
   * @returns {boolean} whether a live ghost was found
   */
  function ghostBindIdentity(p) {
    if (!p) return false;
    const project = projectIdOf(p.project);
    const agentId = String(p.agentId || '').trim();
    const rec = pickGhost(
      project,
      normClient(p.client),
      normSession(p.sessionId),
      p.name,
      p.id,
      agentId
    );
    if (!rec) return false;
    if (agentId) {
      rec.agentId = agentId;
    }
    if (p.background !== undefined) rec.background = Boolean(p.background);
    if (rec.runId) {
      repo.bindSubagentRunIdentity.run({
        id: rec.runId,
        agentId: agentId || null,
        background: p.background === undefined ? null : rec.background ? 1 : 0,
      });
    }
    return true;
  }

  /** A later stop for the same background agent means it was woken and finished another phase. */
  function reviveRetiredGhost(p, project, client, sessionId) {
    const agentId = normText(p.agentId, 200);
    if (!agentId || !client || !sessionId) return false;
    const row = repo.latestEndedBackgroundSubagentRun.get({
      projectId: project,
      client,
      sessionId,
      agentId,
      since: now() - GHOST_BACKGROUND_ORPHAN_MS,
    });
    if (!row) return false;
    if (row.parent_task_id) {
      const parent = repo.getTask.get(row.parent_task_id);
      if (parent && (parent.state === 'cancelled' || parent.state === 'failed')) return false;
    }
    const changed = repo.reopenSubagentRun.run({ id: row.id }).changes;
    if (!changed) return false;
    const fresh = repo.getSubagentRun.get(row.id);
    const rec = attachPersistedGhost(fresh, now());
    if (rec) return true;
    endSubagentRun({ id: row.id, project, endedAt: now() });
    return false;
  }

  /**
   * A subagent finished: close its run; the ghost **disperses immediately** (no report-animation
   * linger for now).
   * @param {{project:string, client?:string, sessionId?:string, name?:string, id?:string, agentId?:string,
   *          result?:string, model?:string, files?:string[]}} p
   */
  function ghostRetire(p) {
    const project = projectIdOf(p.project);
    const client = normClient(p.client);
    const sessionId = normSession(p.sessionId);
    const rec = pickGhost(project, client, sessionId, p.name, p.id, p.agentId);
    if (!rec) return reviveRetiredGhost(p, project, client, sessionId);
    closeGhost(rec, { result: p.result, model: p.model, files: p.files });
    ghosts.delete(rec.key);
    removeGhostMemberIfUnused(rec);
    return true;
  }

  /**
   * Sweep one session's (or one floor's) ghosts (Stop / SessionEnd / UserPromptSubmit, or the
   * task-ended fallback).
   * @param {{project:string, client?:string, sessionId?:string, all?:boolean, state?:string}} p
   * @returns {number} how many were dispersed
   */
  function ghostSweep(p) {
    const project = projectIdOf(p.project);
    const client = normClient(p.client);
    const sessionId = normSession(p.sessionId);
    let n = 0;
    for (const rec of [...ghosts.values()]) {
      if (rec.project !== project) continue;
      if (client && rec.client !== client) continue;
      if (sessionId && rec.sessionId !== sessionId) continue;
      if (!p.all && (rec.endedAt || rec.background)) continue;
      closeGhost(rec, { state: p.state });
      ghosts.delete(rec.key);
      removeGhostMemberIfUnused(rec);
      n += 1;
    }
    return n;
  }

  /**
   * Whether a summoned instance with this name is still alive in the project.
   * @param {{project?: string, name?: string}} p
   * @returns {boolean}
   */
  function isGhostAlive(p = {}) {
    const project = projectIdOf(p.project);
    const name = normText(p.name, 64);
    if (!name) return false;
    const key = agentNameKey(name);
    for (const rec of ghosts.values()) {
      if (rec.project !== project) continue;
      if (rec.endedAt) continue;
      // Case-insensitive: the roster names a resident after the definition file stem, the summon
      // reports the frontmatter name (see agentNameKey).
      if (agentNameKey(rec.name) === key) return true;
    }
    return false;
  }

  /**
   * Ghost fallback (driven by the unified poller): disperse any summon whose parent task ended or
   * that outlived the orphan TTL — no longer depends on any hook event arriving. The parent truth
   * comes from tasks.state; the summon link from the record's parentTaskId.
   *
   * The orphan TTL is only a fallback for a summon **no running parent vouches for**: a parent task that
   * is still running is positive evidence the round (and its subagent) is still active, so it must not be
   * reaped by the TTL. A subagent can legitimately run longer than the TTL — its real end signal
   * (PostToolUse(Task/Agent) / SubagentStop) only arrives when it actually finishes. Measured 2026-10-15:
   * a CodeBuddy `Task` subagent still working at the 5-minute mark was force-closed by the TTL (ghost
   * dispersed, its task marked done) while its parent task was still running — the user saw a live
   * subagent vanish and read as completed. The genuine end event closes it later, as designed.
   * @returns {number} how many were dispersed
   */
  function gcGhosts() {
    const t = now();
    let n = 0;
    for (const rec of [...ghosts.values()]) {
      let drop = false;
      let closeState = 'done';
      // A running parent keeps the ghost alive regardless of the TTL (see the JSDoc above).
      let parentRunning = false;
      if (rec.parentTaskId) {
        const task = repo.getTask.get(rec.parentTaskId);
        // Only disperse when the parent **ended after this summon started**: a parent that was already
        // done/cancelled before the summon (e.g. a superseded twin task, or a stale parentTaskId) must
        // not kill a ghost whose own end signal (PostToolUse / SubagentStop) hasn't arrived yet.
        if (task && task.state) {
          if (task.state === 'running') {
            parentRunning = true;
          } else {
            const endAt = Number(task.ended_at) || 0;
            const endedAfterSpawn = !endAt || endAt >= Number(rec.at || 0);
            if (endedAfterSpawn && !rec.background) {
              drop = true;
              closeState = task.state === 'cancelled' || task.state === 'failed' ? task.state : 'done';
            }
          }
        }
      }
      if (!drop && !parentRunning && rec.at) {
        const ttl = rec.background ? GHOST_BACKGROUND_ORPHAN_MS : GHOST_ORPHAN_MS;
        if (t - rec.at > ttl) drop = true;
      }
      if (drop) {
        closeGhost(rec, { state: closeState });
        ghosts.delete(rec.key);
        removeGhostMemberIfUnused(rec);
        n += 1;
      }
    }
    return n;
  }

  /** Inject the roster (index.js calls this once it exists) so a summoned gremlin shows busy */
  function setGhostRoster(roster) {
    ghostRoster = roster || null;
  }

  /**
   * The task id currently being run by the **main agent** (role='agent') in the given project.
   * Used as a fallback to identify the parent when the summon relationship is unavailable (old hooks write lists with no parent field).
   * @param {string} project
   */
  function currentMainTaskId(project) {
    const r = repo.mainRunningTask.get(projectIdOf(project));
    return r && r.taskId ? r.taskId : null;
  }

  /**
   * Scoop-back: a member's currently running task (bug 3 fallback).
   *
   * Scenario: the hook's state file is "read-modify-write", so when the CLI fires several hook processes in
   * the same millisecond they overwrite each other, taskId gets flushed out -> Stop sends no task/end ->
   * the output summary / changed files / end time are all lost, and the task stays running forever (measured
   * 2026-09-27: all three codebuddy tasks at 13:14 / 13:18 / 13:29 were like this). This lets the hook come
   * back and ask once by "this member + this session" -- task truth is in the server's tasks table.
   *
   * Conservative rule: prefer **this session's** one; when this session doesn't match, only accept when
   * "the whole table has exactly one row and it has no session identifier" (old data / session-less reports)
   * -- never mistakenly claim a task another session is running.
   */
  function currentTaskFor(project, memberId, sessionId = '') {
    const member = requireMember(projectIdOf(project), memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const rows = repo.runningTaskForMember.all(member.id);
    if (!rows.length) return { ok: true, taskId: null };
    const want = normSession(sessionId);
    let hit = want ? rows.find((r) => normSession(r.sessionId) === want) : null;
    if (!hit && rows.length === 1 && (!want || !normSession(rows[0].sessionId))) hit = rows[0];
    if (!hit) return { ok: true, taskId: null };
    return {
      ok: true,
      taskId: hit.taskId,
      title: hit.title || '',
      sessionId: hit.sessionId || '',
      startedAt: Number(hit.startedAt) || 0,
    };
  }

  /**
   * Resolve a Claude background handback by the child identity it names.
   * The handback can arrive just before SubagentStop, so both open and ended runs are valid.
   */
  function backgroundSubagentFor(p = {}) {
    const project = projectIdOf(p.project);
    const client = normClient(p.client);
    const sessionId = normSession(p.sessionId);
    const agentId = normText(p.agentId, 200);
    if (!client || !sessionId || !agentId) return null;
    const row = repo.backgroundSubagentRunByAgent.get({
      projectId: project,
      client,
      sessionId,
      agentId,
    });
    if (!row) return null;
    return {
      runId: Number(row.id),
      name: row.name || 'subagent',
      agentId: row.agent_id,
      parentTaskId: row.parent_task_id || null,
      taskId: row.task_id || null,
      endedAt: row.ended_at == null ? null : Number(row.ended_at),
    };
  }

  /**
   * Record a message. source='report' is reported truth; source='watch' is the directory-watch fallback.
   */
  function recordMessage(p) {
    const project = projectIdOf(p.project);
    const ts = Number(p.ts) || now();
    const from = memberIdOf(project, p.from);
    const to = p.to ? memberIdOf(project, p.to) : null;
    const type = MESSAGE_TYPES.includes(p.type) ? p.type : p.type || 'system';
    const key = p.dedupeKey || dedupeKey({ project, from, to, ts, content: p.content || '' });

    const info = repo.insertMessage.run({
      dedupeKey: key,
      projectId: project,
      tsMs: ts,
      fromMember: from,
      toMember: to,
      type,
      subject: p.subject ?? null,
      content: p.content ?? '',
      taskId: p.taskId ?? null,
      sessionId: normSession(p.sessionId),
      source: p.source || 'report',
      rawJson: jsonOrNull(p.raw ?? null),
    });

    if (info.changes === 0) return { ok: true, duplicate: true };

    const row = repo.raw
      .prepare('SELECT * FROM messages WHERE dedupe_key = ?')
      .get(key);
    hub.broadcast(project, WS_EVENTS.MESSAGE_NEW, toMessage(row));
    return { ok: true, id: row.id };
  }

  function fileTouch(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const ts = Number(p.ts) || now();
    const op = p.op === 'read' ? 'read' : 'write';
    const files = Array.isArray(p.files) ? p.files : p.path ? [p.path] : [];
    for (const f of files) repo.insertFileActivity.run(member.id, f, op, ts);
    repo.trimFileActivity.run(member.id, member.id, 200);
    for (const f of files) {
      hub.broadcast(project, WS_EVENTS.FILE_ACTIVITY, { memberId: member.id, path: f, op, tsMs: ts });
    }
    return { ok: true };
  }

  /**
   * A tool was used once in this round's task (the "tool usage" in the task details).
   *
   * The reporter (hook / plugin) reports one entry per tool invocation, and here the count is accumulated
   * by `(task_id, tool)` -- no row per invocation (Bash can run hundreds of times in a round, and writing
   * row by row would just bloat the DB).
   *
   * Three disciplines:
   *   1) **No taskId, no record**: task details are viewed per task, and hanging a "call with no task" on
   *      someone else's task is fabricated attribution; better to record less.
   *   2) No tool name, no record either (old payload versions / hand-written scripts) -- a count with an empty name is meaningless.
   *   3) Idempotency is the reporter's responsibility (one report per invocation of the same tool); the server only accumulates, never guessing or converting.
   * @param {{project:string, memberId:string, taskId?:string, tool?:string, sessionId?:string, client?:string, ts?:number}} p
   */
  function toolUse(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const taskId = String(p.taskId || '').trim();
    const tool = String(p.tool || '').trim();
    if (!taskId || !tool) return { ok: true, skipped: true };
    const ts = Number(p.ts) || now();
    repo.bumpToolUsage.run({
      taskId,
      tool,
      projectId: project,
      memberId: member.id,
      client: member.client || null,
      sessionId: p.sessionId ? String(p.sessionId) : null,
      ts,
    });
    return { ok: true };
  }

  /** @param {any} row */
  function toMessage(row) {
    return {
      id: row.id,
      projectId: row.project_id,
      tsMs: row.ts_ms,
      fromMember: row.from_member,
      toMember: row.to_member,
      type: row.type,
      subject: row.subject,
      content: row.content,
      taskId: row.task_id,
      sessionId: row.session_id,
      source: row.source,
      rawJson: row.raw_json,
    };
  }

  /**
   * The "recent output" on the card.
   *
   * The truth lives in the artifacts table, but it is **only written when /task/end carries artifacts**
   * (endTask); and the only producing caller -- the reporter hook's Stop -- only ever sends
   * `{taskId, state:'done'}`, never artifacts (measured: 0 rows in artifacts across the whole DB). So the
   * "recent output" isn't "written but not queried out", there is simply **no data source at all**.
   *
   * When the truth is empty, fall back to **the files this round's task actually changed** (the reported rows in
   * file_activity) and mark derived=true, with the renderer labeling them "changed" -- this is real stored
   * fact, but it is derived output and is never treated as reported truth.
   * @param {string} memberId
   * @param {any|null} runningTask the currently running task row (snake_case), or null when there is none
   */
  function recentArtifacts(memberId, runningTask) {
    const rows = repo.listArtifacts.all(memberId, 3);
    if (rows.length) {
      return rows.map((a) => ({
        id: a.id,
        memberId: a.member_id,
        taskId: a.task_id,
        kind: a.kind,
        title: a.title,
        path: a.path,
        tsMs: a.ts_ms,
      }));
    }
    // Time-window candidates: first the running task of this round (up to now), then the most recently finished task (its output is finalized)
    const windows = [];
    if (runningTask && runningTask.state === 'running') {
      windows.push({ taskId: runningTask.id, from: runningTask.started_at, to: now() });
    }
    const last = repo.latestEndedTask.get(memberId);
    if (last) windows.push({ taskId: last.id, from: last.started_at, to: last.ended_at });
    for (const w of windows) {
      const files = repo.listActivityInWindow.all(memberId, w.from, w.to, 3);
      if (!files.length) continue;
      return files.map((f) => ({
        id: null,
        memberId,
        taskId: w.taskId,
        kind: 'file',
        title: f.path,
        path: f.path,
        tsMs: f.ts_ms,
        derived: true,
      }));
    }
    return [];
  }

  /**
   * Output of a ghost (a summon instance). Borrowed by a resident gremlin only when it has **no
   * output of its own**: the one actually summoned to work is the `subagent-<name>-<call>` instance,
   * and its finish summary (the kind='text' output the ghost writes when it retires) is that
   * gremlin's output for this run.
   *
   * Looked up **by name through subagent_runs**, not by a member-id formula: each instance has its own
   * member id (see ghostSpawn) and the member row is deleted once it disperses, while the run and its
   * artifacts stay behind (purgeMember's keepHistory).
   * @param {any} member resident member row (ephemeral=0)
   */
  function ghostArtifacts(member) {
    if (!member || member.ephemeral || !member.name) return [];
    return repo.listGhostArtifactsByName
      .all({ projectId: member.project_id, name: member.name, limit: 3 })
      .map((a) => ({
        id: a.id,
        memberId: a.member_id,
        taskId: a.task_id,
        kind: a.kind,
        title: a.title,
        path: a.path,
        tsMs: a.ts_ms,
      }));
  }

  /**
   * The heir to the output when a ghost disperses: the same-named resident gremlin (NULL when there is none, and the output is wiped along with the ghost).
   * @param {any} member the ghost member row
   */
  function heirOf(member) {
    if (!member || !member.ephemeral || !member.name) return null;
    // Case-insensitive: the resident is named after the definition file stem (`simmon`), the summon
    // carries the frontmatter name (`Simmon`). The old member-id formula matched neither spelling.
    const host = repo.getResidentByName.get({ projectId: member.project_id, name: member.name });
    if (!host || host.id === member.id) return null;
    return host.id;
  }

  /** The on-disk path of the member's project (project-level agent definition files are looked up here); an empty string when unreadable, so only the user-level directory is searched */
  function projectWorkspacePath(projectId) {
    const p = repo.getProject.get(projectId);
    return (p && p.workspace_path) || '';
  }

  /** @param {string} memberId */
  function buildMemberCard(memberId) {
    const m = repo.getMember.get(memberId);
    if (!m) return null;
    const sessionStatuses = repo.listSessionStatuses.all(memberId);
    const currentTasks = repo.currentTasksOfMember.all(memberId);
    const tasks = currentTasks.map((task) => ({
      id: task.id,
      title: task.title,
      progress: task.progress,
      startedAt: task.started_at,
      endedAt: task.ended_at ?? null,
      state: task.state,
      // Ephemeral tasks do not have task_runs rows, so their member session is the session fallback.
      sessionId: task.session_id || (m.ephemeral ? m.session_id : null),
      files: task.files_json ? safeJson(task.files_json, []) : [],
    }));
    const priorities = { blocked: 2, busy: 1 };
    const candidates = sessionStatuses.map((row) => ({
      state: 'blocked',
      stateSince: Number(row.state_since) || m.created_at,
    }));
    const agentStatus = repo.getStatus.get(memberId);
    const agentState = agentStatus && agentStatus.state === 'busy' ? 'busy' : 'idle';
    if (agentState === 'busy') {
      candidates.push({ state: agentState, stateSince: Number(agentStatus.state_since) || m.created_at });
    }
    for (const task of tasks) {
      candidates.push({ state: 'busy', stateSince: Number(task.startedAt) || m.created_at });
    }
    const active = candidates.reduce((best, row) => {
      if (!best) return row;
      const diff = priorities[row.state] - priorities[best.state];
      if (diff > 0) return row;
      if (diff === 0 && row.stateSince < best.stateSince) return row;
      return best;
    }, null);
    const state = active ? active.state : 'idle';
    const stateSince = active ? active.stateSince : m.created_at;
    const latestTask = tasks[0] || null;
    const files = latestTask ? latestTask.files : [];
    let artifacts = recentArtifacts(memberId, currentTasks[0]);
    // A resident gremlin with no output of its own -> borrow from the same-named ghost instance (borrowed while the ghost is alive; on dispersion, inherited via removeMember)
    if (!artifacts.length) artifacts = ghostArtifacts(m);
    const cnt = repo.countMessagesFor.get(m.project_id, memberId, memberId);
    const lastTaskBySession = repo.lastTaskAtOfMemberBySession.all(memberId);
    const lastTaskAt = lastTaskBySession.reduce((max, row) => Math.max(max, Number(row.at) || 0), 0) || null;

    return {
      memberId: m.id,
      name: m.name,
      role: m.role,
      state,
      stateSince,
      agentState,
      agentStateSince: agentStatus ? Number(agentStatus.state_since) || m.created_at : null,
      tasks,
      sessionStatuses: sessionStatuses.map((row) => ({
        sessionId: row.session_id,
        state: 'blocked',
        stateSince: Number(row.state_since) || m.created_at,
      })),
      currentFiles: files,
      artifacts,
      lastTaskAt,
      lastTaskAtBySession: lastTaskBySession.map((row) => ({
        sessionId: row.session_id ?? null,
        at: Number(row.at) || null,
      })),
      reported: Boolean(m.reported),
      messageCount: cnt ? cnt.c : 0,
      // Ephemeral member (no workstation -> a ghost drifting in the scene) + the project name it belongs to
      ephemeral: Boolean(m.ephemeral),
      projectLabel: m.project_label ?? null,
      // The project id it belongs to: the client uses it to keep "member cards of other projects" out.
      // The renderer filters member cards by this project id so broadcasts from other projects cannot
      // leak into the room this client is viewing.
      project: m.project_id,
      // Source client: the office filters by floor accordingly (NULL = unknown, shown on every floor)
      client: m.client || null,
      // Session this member belongs to (ghosts carry their parent session's id; resident gremlins
      // have none). The renderer uses it to keep another session's ghosts out of the selected
      // session's scene / "waiting for subagents" phase.
      sessionId: m.session_id || null,
      // subagent level (user-level / project-level): drives the badge color on the gremlin's neck
      level: levels.get(memberId) || null,
      // The **function description** of a resident subagent (static data from the agent definition file): shown on the card as "what it does",
      // not a state. An empty string when unavailable, with the renderer hiding that field -- never standing in with "项目子代理 · 空闲".
      description: String(m.role || '').startsWith('subagent') ? agentDescription(m.name, projectWorkspacePath(m.project_id), m.client || '') : '',
    };
  }

  /**
   * Backfill the source client (rows in the old DB are NULL). The roster and list call this once per sync round, writing only when missing or inconsistent.
   * @param {{project: string, memberId: string, client: string}} p
   */
  function tagMemberClient(project, memberId, client) {
    const c = normClient(client);
    if (!c) return 0;
    return repo.tagMemberClient.run({ id: memberIdOf(project, memberId), client: c }).changes;
  }

  /**
   * Remove a member (an ephemeral member leaving the stage: subagent finished, ghost dispersed).
   * @param {{project: string, memberId: string}} p
   */
  function removeMember(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    // A ghost disperses: **the member row is deleted, this round's summon account stays** (tasks / artifacts, see repo.purgeMember).
    // The output is never rewritten no matter who it goes to -- those with a workstation have it borrowed for display by that card (see ghostArtifacts),
    // and those without one (like code-explorer) still have their output queryable in the DB, with the ledger's subagent_runs still pointing at it.
    repo.purgeMember(member.id, { keepHistory: Boolean(member.ephemeral) });
    levels.delete(member.id);
    hub.broadcast(project, WS_EVENTS.MEMBER_REMOVE, { memberId: member.id });
    return { ok: true };
  }

  function safeJson(str, fallback) {
    try {
      const v = JSON.parse(str);
      return Array.isArray(v) ? v : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Set the server-side default workspace fallback (attribution / polling). This is not a UI
   * project switch: clients show the project of their selected session.
   * @param {{projectName?: string, project?: string|null, workspacePath?: string}} next
   */
  function setContext(next = {}) {
    if (typeof next.projectName === 'string') context.projectName = next.projectName;
    if (next.project !== undefined) context.project = next.project || null;
    if (typeof next.workspacePath === 'string') context.workspacePath = next.workspacePath;
    return { ...context };
  }

  /**
   * The team list. A project's name is an internal slug, while the UI should show the name of the project it belongs to,
   * so the project is reverse-resolved here from workspace_path (package.json name > directory name) and sent along.
   * @returns {Array<any>}
   */
  function listProjectSummaries() {
    return repo.listProjects.all().map((t) => ({
      id: t.id,
      name: t.name,
      workspacePath: t.workspace_path || '',
      mainConversationId: t.main_conversation_id || null,
      source: t.source,
      createdAt: t.created_at,
      // A project without a directory has no resolvable package/directory name; fall back to its
      // stored slug. (The virtual demo project is not in this table at all.)
      projectName: t.workspace_path ? resolveProjectName(t.workspace_path) : t.name || '',
    }));
  }

  /**
   * The first-screen snapshot for one project. A client passes the project of its selected session
   * (id or workspace path); when omitted, use the server's default workspace fallback.
   *
   * Note: **never fall back to projects[0]**. projects is ordered by creation time descending, so the first entry
   * may be demo data or a polluted project. When an explicitly requested project isn't found, return
   * an empty member list instead of silently showing a different project.
   */
  function buildSnapshot(projectId) {
    const projects = listProjectSummaries();
    const want = projectId || context.project;
    let projectRow = want ? projects.find((t) => t.id === projectIdOf(want)) : null;
    // A caller may pass the workspace path instead of the project id (the renderer follows the
    // selected session's projectPath). Resolve that against the project rows as well.
    if (!projectRow && want) {
      let wantPath = '';
      try {
        wantPath = path.resolve(String(want));
      } catch {
        wantPath = '';
      }
      if (wantPath) {
        projectRow =
          projects.find((t) => t.workspacePath && path.resolve(t.workspacePath) === wantPath) || null;
      }
    }
    // Only fall back to the server's default workspace when the caller did not ask for a specific
    // project — otherwise a requested project that has no row yet would silently show another.
    if (!projectRow && !projectId && context.workspacePath) {
      const ws = path.resolve(context.workspacePath);
      projectRow = projects.find((t) => t.workspacePath && path.resolve(t.workspacePath) === ws) || null;
    }
    if (!projectRow) {
      return {
        project: null,
        projects,
        members: [],
        recentMessages: [],
        projectName: context.projectName,
        serverTime: now(),
        serverVersion: '0.1.0',
      };
    }
    const localCards = repo.listMembers.all(projectRow.id).map((m) => buildMemberCard(m.id)).filter(Boolean);
    // User-level gremlins are not project-scoped: they are defined in the user's agent directory and
    // must exist without a project (and on every project's office). Project-level gremlins stay local.
    const members = localCards.map((card) =>
      card.role === 'subagent:user' ? { ...card, project: null } : card
    );
    const seenUserNames = new Set(
      members.filter((m) => m.role === 'subagent:user').map((m) => String(m.name || '').toLowerCase())
    );
    for (const p of projects) {
      if (!p || !p.id) continue;
      for (const row of repo.listMembers.all(p.id)) {
        if (row.role !== 'subagent:user') continue;
        const key = String(row.name || '').toLowerCase();
        if (seenUserNames.has(key)) continue;
        const card = buildMemberCard(row.id);
        if (!card) continue;
        members.push({ ...card, project: null });
        seenUserNames.add(key);
      }
    }
    const recentMessages = repo.listMessages(projectRow.id, { limit: DEFAULTS.MESSAGE_WINDOW, direction: 'desc' })
      .slice()
      .reverse()
      .map(toMessage);
    return {
      project: projectRow,
      projects,
      members,
      projectName: projectRow.projectName || context.projectName,
      recentMessages,
      serverTime: now(),
      serverVersion: '0.1.0',
    };
  }

  return {
    projectIdOf,
    memberIdOf,
    ensureProject,
    setContext,
    getContext: () => ({ ...context }),
    registerMember,
    tagMemberClient,
    removeMember,
    projectForReport,
    currentMainTaskId,
    currentTaskFor,
    backgroundSubagentFor,
    startSubagentRun,
    endSubagentRun,
    ghostSpawn,
    ghostBindIdentity,
    ghostRetire,
    ghostSweep,
    restoreGhosts,
    isGhostAlive,
    gcGhosts,
    setGhostRoster,
    setBlocked,
    setBorrowedBusy,
    clearBorrowedBusy,
    clearBlocked,
    pruneSessionStatuses,
    reconcileRunningTasksWithActiveSessions,
    startTask,
    taskProgress,
    endTask,
    endStaleTasksOfSession,
    backfillTaskTokens,
    recordMessage,
    fileTouch,
    toolUse,
    buildMemberCard,
    buildSnapshot,
    listProjectSummaries,
    toMessage,
  };
}

module.exports = { createIngestBus, projectIdOf, memberIdOf };
