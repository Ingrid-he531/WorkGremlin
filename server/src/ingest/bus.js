'use strict';

/**
 * Ingest 事件总线：A/B 两条来源统一落在这里 -> 写库 -> 广播。
 *
 * 原则（leader/main 已批准，不得违反）：
 *   - B（agent 主动上报）是唯一真值来源；
 *   - A（目录监听）只兜底 roster 与消息，状态一律标记 degraded=1；
 *   - 心跳超时 60s -> degraded=1、state 不编造（保持最后一次上报值，仅打 degraded 标记）；
 *   - 进度/文件/耗时拿不到就是 NULL，绝不用 0 或随机值填充。
 */

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { AGENT_STATES, MESSAGE_TYPES, DEFAULTS, WS_EVENTS, dedupeKey } = require('@workgremlin/shared');
const clock = require('../clock');
const config = require('../config');
const { resolveProjectName } = require('../project');
const { detectLevel } = require('./agentLevel');

function projectIdOf(name) {
  return name;
}

function memberIdOf(project, name) {
  return String(name).includes('@') ? name : `${name}@${project}`;
}

/** 来源客户端白名单（办公室按楼层的客户端过滤；不认识的值一律当"不知道"= NULL）
 *  codebuddy-cli = CodeBuddy CLI（与 CodeBuddy Plugin 共用 ~/.codebuddy，靠 hook payload 的 client 字段区分） */
const CLIENTS = new Set(['codebuddy', 'codebuddy-cli', 'workbuddy', 'codex', 'claude']);
function normClient(v) {
  const c = String(v || '').trim().toLowerCase();
  return CLIENTS.has(c) ? c : null;
}

/** 模型名：拿不到就是 NULL（绝不猜），超长截断 */
function normModel(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, 64) : null;
}

/** 台账"产出"全文上限：AI 回复按 hook 侧 RESULT_MAX(4000) 送上来，这里必须 >= 它，否则会被砍掉 */
const RUN_RESULT_MAX = 4_000;

/** 台账里的文本字段：压空白 + 截断；空串一律当"没有"（NULL） */
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

/**
 * 当前 HEAD 的 commit sha（工作区不是 git 仓库 / 没装 git 时返回 null）。
 * 用于"任务开始时"打基线，任务结束时再 diff 基线..HEAD 拿全量改动（含已提交部分）。
 * @param {string} ws 工程工作区绝对路径
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
 * 单个文件当前体积（字节）：按工作区路径 stat；文件不存在 / 非文件 -> null（绝不编造）。
 * 删除类文件在 enrichFiles 里直接置 null，不调本函数。
 * @param {string} ws 工程工作区绝对路径
 * @param {string} rel 工作区相对路径
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
 * 把上报的文件清单补全为 [{path, op, size}]：
 *   - op 来自 hook（write=新增 / edit=改动 / delete=删除；老数据无 op 一律按改动计）；
 *   - size 由服务端按工作区路径 stat 当前文件体积（字节）；删除文件 / 不存在 -> null。
 * 同一文件多次出现时，"最后一次出现"的 op 为准（后者覆盖，决定最终归类）。
 * 最多保留前 50 条。空清单返回 null（落库时 files_json 置 NULL）。
 * @param {string} ws 工程工作区绝对路径
 * @param {Array<string|{path:string,op?:string}>} reportedFiles 上报侧给的文件
 */
function enrichFiles(ws, reportedFiles) {
  const reported = Array.isArray(reportedFiles) ? reportedFiles : [];
  const seen = new Map();
  const sizeOf = new Map(); // hook 已算好的大小（按路径），优先于服务端 stat
  for (const it of reported) {
    const p = typeof it === 'string' ? it : (it && it.path);
    if (!p) continue;
    const op = typeof it === 'string' ? null : (it && it.op) || null;
    seen.set(p, op); // 同一文件多次出现：后者覆盖（最后一次操作决定归类）
    // 上报侧带了真实大小（hook 在收工那一刻按其真实工作区 stat 出来的）就记下，
    // 服务端工程 workspace_path 对不上时也能正确显示文件大小。
    if (typeof it !== 'string' && it && typeof it.size === 'number') sizeOf.set(p, it.size);
  }
  if (!seen.size) return null;
  const list = [...seen.entries()].map(([p, op]) => {
    let size;
    // 优先用 hook 给的大小；没有（老数据 / subagent 上报）再按服务端 workspace_path 兜底 stat。
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
  /** 会随"打开工程"变化的东西：当前工程名 + 工程路径 + 当前工程（屋里显示谁的工位） */
  const context = { projectName, project: project || null, workspacePath: '' };
  /** memberId -> 'user' | 'project'：注册时按 subagent 目录判定一次 */
  const levels = new Map();
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
   * @param {{project: string, memberId?: string, name: string, role?: string, sessionId?: string, workspacePath?: string,
   *          ephemeral?: boolean, projectLabel?: string|null}} p
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
      // reported=0 表示"仅被动观测"（A 路线发现的成员），不主动上报真值
      reported: p.reported === 0 ? 0 : 1,
      createdAt: existing ? existing.created_at : now(),
      lastSeenAt: now(),
      // 临时成员（无工位 / 场景里是幽灵）。老成员的 ephemeral 只升不降（见 upsertMember 的 MAX）
      ephemeral: p.ephemeral ? 1 : 0,
      projectLabel: p.projectLabel ?? null,
      // 来源客户端（演示/手工数据没有，就是 NULL）
      client: normClient(p.client),
    });
    // subagent 级别（用户级 / 项目级）：按名字扫 agent 目录判定，记进内存 map
    const lvl = detectLevel(p.name || p.memberId || '', p.workspacePath || '');
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

  /**
   * 心跳 / 轻量状态更新。
   * @param {{project: string, memberId: string, state?: string, progress?: number, taskId?: string, files?: string[], ts?: number}} p
   */
  function heartbeat(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const id = member.id;
    const ts = Number(p.ts) || now();

    const prev = repo.getStatus.get(id);
    const state = AGENT_STATES.includes(p.state) ? p.state : prev ? prev.state : 'online';

    repo.upsertStatus.run({
      memberId: id,
      state,
      stateSince: ts,
      taskId: p.taskId ?? (prev ? prev.task_id : null),
      progress: Number.isFinite(p.progress) ? p.progress : prev ? prev.progress : null,
      currentFiles: p.files ? jsonOrNull(p.files) : prev ? prev.current_files : null,
      lastHeartbeatAt: ts,
      degraded: 0,
      source: 'report',
      updatedAt: ts,
    });
    repo.touchMember.run(ts, id);
    if (!prev || prev.state !== state) {
      repo.insertStatusHistory.run(id, state, ts, 'heartbeat', 'report');
    }

    if (p.files && p.files.length) {
      for (const f of p.files) repo.insertFileActivity.run(id, f, 'write', ts);
      repo.trimFileActivity.run(id, id, 200);
    }

    const card = buildMemberCard(id);
    hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, card);
    return { ok: true, card };
  }

  /**
   * 显式状态切换（含 blocked + 原因）。
   */
  function setStatus(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const id = member.id;
    const ts = Number(p.ts) || now();
    const state = AGENT_STATES.includes(p.state) ? p.state : 'idle';
    const prev = repo.getStatus.get(id);

    repo.upsertStatus.run({
      memberId: id,
      state,
      stateSince: ts,
      taskId: prev ? prev.task_id : null,
      progress: prev ? prev.progress : null,
      currentFiles: prev ? prev.current_files : null,
      lastHeartbeatAt: ts,
      degraded: 0,
      source: 'report',
      updatedAt: ts,
    });
    repo.insertStatusHistory.run(id, state, ts, p.reason ?? null, 'report');
    const card = buildMemberCard(id);
    hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, card);
    return { ok: true, card };
  }

  function startTask(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const ts = Number(p.ts) || now();
    const id = p.taskId || `t_${ts.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

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
    repo.upsertStatus.run({
      memberId: member.id,
      state: 'busy',
      stateSince: ts,
      taskId: id,
      progress: Number.isFinite(p.progress) ? p.progress : 0,
      currentFiles: p.files ? jsonOrNull(p.files) : null,
      lastHeartbeatAt: ts,
      degraded: 0,
      source: 'report',
      updatedAt: ts,
    });
    // 台账：**主 agent** 的一轮任务 = 一次用户任务（输入就是用户原话）。
    // subagent 实例不走这条（它们记 subagent_runs），所以判据是"上报者是不是主 agent"。
    if (String(member.role || '') === 'agent') {
      const wsRow0 = repo.getProject.get(project);
      const baseline = wsRow0 && wsRow0.workspace_path ? gitHead(wsRow0.workspace_path) : null;
      repo.upsertTaskRun.run({
        id,
        projectId: project,
        memberId: member.id,
        client: member.client || normClient(p.client) || null,
        model: normModel(p.model),
        title: p.title || '(未命名任务)',
        startedAt: ts,
        baselineCommit: baseline,
      });
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
    repo.upsertStatus.run({
      memberId: member.id,
      state: 'busy',
      stateSince: ts,
      taskId: p.taskId ?? null,
      progress: Number.isFinite(p.progress) ? p.progress : null,
      currentFiles: p.files ? jsonOrNull(p.files) : null,
      lastHeartbeatAt: ts,
      degraded: 0,
      source: 'report',
      updatedAt: ts,
    });
    if (p.files && p.files.length) {
      for (const f of p.files) repo.insertFileActivity.run(member.id, f, 'write', ts);
      repo.trimFileActivity.run(member.id, member.id, 200);
    }
    hub.broadcast(project, WS_EVENTS.TASK_UPDATE, repo.getTask.get(p.taskId));
    hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, buildMemberCard(member.id));
    return { ok: true };
  }

  function endTask(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const ts = Number(p.ts) || now();
    const state = ['done', 'failed', 'cancelled'].includes(p.state) ? p.state : 'done';

    repo.updateTask.run({ id: p.taskId, state, progress: p.progress ?? 1, endedAt: ts });
    repo.upsertStatus.run({
      memberId: member.id,
      state: 'idle',
      stateSince: ts,
      taskId: null,
      progress: null,
      currentFiles: null,
      lastHeartbeatAt: ts,
      degraded: 0,
      source: 'report',
      updatedAt: ts,
    });
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
    // 台账收尾：结束时间 / 花费时间 / 产出（收尾自述）/ 本轮改动文件
    if (String(member.role || '') === 'agent') {
      const run = repo.getTaskRun.get(p.taskId);
      if (!run) {
        // 老 hook 或中途接上的：起点未知就别编，started_at 留 NULL、duration 也算不出来
        repo.upsertTaskRun.run({
          id: p.taskId,
          projectId: project,
          memberId: member.id,
          client: member.client || normClient(p.client) || null,
          model: normModel(p.model),
          title: null,
          startedAt: null,
        });
      }
      const startedAt = run ? Number(run.started_at) || null : null;
      const wsRow = repo.getProject.get(project);
      const reportedFiles = Array.isArray(p.files) ? p.files : [];
      const filesJson = enrichFiles(wsRow ? wsRow.workspace_path : '', reportedFiles);
      repo.endTaskRun.run({
        id: p.taskId,
        model: normModel(p.model),
        result: normText(p.result, RUN_RESULT_MAX),
        fileCount: Number.isFinite(Number(p.fileCount)) ? Number(p.fileCount) : null,
        filesJson: filesJson ? JSON.stringify(filesJson) : null,
        endedAt: ts,
        durationMs: startedAt && ts > startedAt ? ts - startedAt : null,
      });
    }
    hub.broadcast(project, WS_EVENTS.TASK_UPDATE, repo.getTask.get(p.taskId));
    hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, buildMemberCard(member.id));
    // 幽灵收工时顺手刷同名常驻小怪物的卡：它这一轮的产出会被那张卡借去显示（见 ghostArtifacts）
    const heir = heirOf(member);
    if (heir) hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, buildMemberCard(heir));
    return { ok: true };
  }

  /**
   * 台账：记一次召唤（subagent 实例）的开场。
   * 有小工位的（susan）和没工位的（code-explorer / 内置专家直接 spawn 的）都记 ——
   * 「这一轮用了几个 subagent」这条账就是靠它。
   * @returns {number|null} 台账行 id（收工时交给 endSubagentRun）
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
      // 召唤时没给任务行的话，开始时刻就是"不知道" —— 留 NULL（耗时也算不出来），不拿现在冒充填
      startedAt: p.startedAt === null ? null : Number(p.startedAt) || now(),
    });
    return r && r.lastInsertRowid ? Number(r.lastInsertRowid) : null;
  }

  /**
   * 台账：subagent 实例收工 —— 补产出（收工摘要）、结束时间与花费时间。
   * @param {{id: number|null, result?: string, model?: string, endedAt?: number}} p
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

  /**
   * 当前工程里**主 agent**（role='agent'）正在跑的任务 id。
   * 召唤关系拿不到时（老 hook 写的清单没有 parent 字段）用它兜底认父。
   * @param {string} project
   */
  function currentMainTaskId(project) {
    const r = repo.mainRunningTask.get(projectIdOf(project));
    return r && r.taskId ? r.taskId : null;
  }

  /**
   * 记录一条消息。source='report' 为上报真值；source='watch' 为目录监听兜底。
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
      source: row.source,
      rawJson: row.raw_json,
    };
  }

  /**
   * 卡片上的「最近产出」。
   *
   * 真值在 artifacts 表，但它**只有 /task/end 带了 artifacts 时才写**（endTask）；
   * 而唯一的生产调用方 —— reporter hook 的 Stop —— 只发 `{taskId, state:'done'}`，从不带 artifacts
   * （实测：全库 artifacts 0 行）。所以「最近产出」不是"写了没查出来"，而是**根本没有数据源**。
   *
   * 真值为空时用**本轮任务真实改动过的文件**兜底（file_activity 的上报行），并标 derived=true，
   * 由渲染层标出「改动」—— 这是落库的真事实，但它是推导出来的产出，绝不当成上报真值。
   * @param {string} memberId
   * @param {any|null} runningTask 当前进行中的任务行（snake_case），没有就是 null
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
    // 时间窗候选：先本轮进行中的任务（截至当下），再最近一条已结束的任务（产出已定型）
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
   * 幽灵（召唤实例）的产出。**常驻小怪物自己没有产出时**才借它的：
   * 真正被召唤出去干活的是 subagent-<名字> 那个实例，它的收工摘要
   * （subagentFeed 收工时按 kind='text' 落的产出）就是这位小怪物这一轮的产出。
   * @param {any} member 常驻成员行（ephemeral=0）
   */
  function ghostArtifacts(member) {
    if (!member || member.ephemeral || !member.name) return [];
    const ghostId = memberIdOf(member.project_id, `subagent-${member.name}`);
    if (ghostId === member.id) return [];
    return repo.listArtifacts.all(ghostId, 3).map((a) => ({
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
   * 幽灵散掉时产出的继承人：同名常驻小怪物（没有就 NULL，产出随幽灵一起抹掉）。
   * @param {any} member 幽灵成员行
   */
  function heirOf(member) {
    if (!member || !member.ephemeral || !member.name) return null;
    const id = memberIdOf(member.project_id, member.name);
    if (id === member.id) return null;
    const host = repo.getMember.get(id);
    return host && !host.ephemeral ? id : null;
  }

  /** @param {string} memberId */
  function buildMemberCard(memberId) {
    const m = repo.getMember.get(memberId);
    if (!m) return null;
    const s = repo.getStatus.get(memberId);
    const files = s && s.current_files ? safeJson(s.current_files, []) : [];
    const task = s && s.task_id ? repo.getTask.get(s.task_id) : null;
    let artifacts = recentArtifacts(memberId, task);
    // 常驻小怪物自己没产出 -> 借同名幽灵实例的（幽灵还活着时借用；散掉时由 removeMember 过继）
    if (!artifacts.length) artifacts = ghostArtifacts(m);
    const cnt = repo.countMessagesFor.get(m.project_id, memberId, memberId);

    return {
      memberId: m.id,
      name: m.name,
      role: m.role,
      // 没接上报且没状态行 -> offline；有状态行但 degraded -> 保持状态并标注推断
      state: s ? s.state : 'offline',
      stateSince: s ? s.state_since : m.created_at,
      task: task ? { id: task.id, title: task.title, progress: task.progress, startedAt: task.started_at } : null,
      currentFiles: files,
      artifacts,
      lastSeenAt: m.last_seen_at ?? m.created_at,
      degraded: s ? Boolean(s.degraded) : true,
      reported: Boolean(m.reported),
      messageCount: cnt ? cnt.c : 0,
      // 临时成员（无工位 → 场景里飘着的幽灵）+ 所属项目名
      ephemeral: Boolean(m.ephemeral),
      projectLabel: m.project_label ?? null,
      // 来源客户端：办公室据此按楼层过滤（NULL = 不知道，哪层都显示）
      client: m.client || null,
      // subagent 级别（用户级 / 项目级）：驱动小怪物脖子上的工牌配色
      level: levels.get(memberId) || null,
    };
  }

  /**
   * 补写来源客户端（老库的行是 NULL）。名册与清单每轮同步调一次，只在缺失/不一致时写。
   * @param {{project: string, memberId: string, client: string}} p
   */
  function tagMemberClient(project, memberId, client) {
    const c = normClient(client);
    if (!c) return 0;
    return repo.tagMemberClient.run({ id: memberIdOf(project, memberId), client: c }).changes;
  }

  /**
   * 删除成员（临时成员退场：subagent 结束、幽灵散掉）。
   * @param {{project: string, memberId: string}} p
   */
  function removeMember(p) {
    const project = projectIdOf(p.project);
    const member = requireMember(project, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    // 幽灵散掉：**成员行删掉，这一轮召唤的账留着**（tasks / artifacts，见 repo.purgeMember）。
    // 产出发给谁都不改写 —— 有小工位的由那张卡借去显示（见 ghostArtifacts），
    // 没工位的（code-explorer 这类）产出在库里照样查得到，台账 subagent_runs 也还指着它。
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
   * 切换当前工程 / 团队（见 server/src/workspace.js）。
   * @param {{project?: string, project?: string|null}} next
   */
  function setContext(next = {}) {
    if (typeof next.projectName === 'string') context.projectName = next.projectName;
    if (next.project !== undefined) context.project = next.project || null;
    if (typeof next.workspacePath === 'string') context.workspacePath = next.workspacePath;
    return { ...context };
  }

  /**
   * 团队列表。project 的 name 是内部 slug，界面上要显示的是它所属工程的名字，
   * 所以这里按 workspace_path 反解出 project（package.json name > 目录名）一起带出去。
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
      // 演示工程没有目录，显示名固定为「演示工程」（和真实工程并列展示）
      projectName: t.workspace_path ? resolveProjectName(t.workspace_path) : config.DEMO_PROJECT_NAME,
    }));
  }

  /**
   * 首屏快照。没指定 project 时用"当前打开的工程"对应的团队。
   *
   * 注意：**绝不回落到 projects[0]**。projects 是按创建时间倒序的，第一条可能是演示 data
   * 或被污染的 project，拿它当"当前"会让办公室显示错的成员（甚至挂着几十小时前的演示残留）。
   * 找不到对应 project 时按当前工程路径再匹配一次；还是找不到就返回空成员，由客户端显式
   * 切成正确工程（POST /api/v1/workspace）。
   */
  function buildSnapshot(projectId) {
    const projects = listProjectSummaries();
    const want = projectId || context.project;
    let projectRow = want ? projects.find((t) => t.id === projectIdOf(want)) : null;
    if (!projectRow && context.workspacePath) {
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
    const members = repo.listMembers.all(projectRow.id).map((m) => buildMemberCard(m.id)).filter(Boolean);
    const recentMessages = repo.listMessages(projectRow.id, { limit: DEFAULTS.MESSAGE_WINDOW, direction: 'desc' })
      .slice()
      .reverse()
      .map(toMessage);
    return {
      project: projectRow,
      projects,
      members,
      projectName: context.projectName,
      recentMessages,
      serverTime: now(),
      serverVersion: '0.1.0',
    };
  }

  /**
   * 心跳超时扫描：超过 HEARTBEAT_TIMEOUT_MS 未上报 -> degraded=1（不改动 state，不编造）。
   */
  function sweepDegraded() {
    const cutoff = now() - DEFAULTS.HEARTBEAT_TIMEOUT_MS;
    const rows = repo.raw
      .prepare('SELECT * FROM agent_status WHERE degraded = 0 AND last_heartbeat_at < ?')
      .all(cutoff);
    for (const s of rows) {
      repo.raw.prepare('UPDATE agent_status SET degraded = 1, source = ?, updated_at = ? WHERE member_id = ?').run(
        'timeout',
        now(),
        s.member_id
      );
      const m = repo.getMember.get(s.member_id);
      if (m) hub.broadcast(m.project_id, WS_EVENTS.MEMBER_STATUS, buildMemberCard(s.member_id));
    }
    return rows.length;
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
    currentMainTaskId,
    startSubagentRun,
    endSubagentRun,
    heartbeat,
    setStatus,
    startTask,
    taskProgress,
    endTask,
    recordMessage,
    fileTouch,
    buildMemberCard,
    buildSnapshot,
    listProjectSummaries,
    sweepDegraded,
    toMessage,
  };
}

module.exports = { createIngestBus, projectIdOf, memberIdOf };
