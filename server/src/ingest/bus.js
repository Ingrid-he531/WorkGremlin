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

/** 来源客户端白名单（办公室按楼层的客户端过滤；不认识的值一律当"不知道"= NULL） */
const CLIENTS = new Set(['codebuddy', 'workbuddy', 'codex', 'claude']);
function normClient(v) {
  const c = String(v || '').trim().toLowerCase();
  return CLIENTS.has(c) ? c : null;
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
    hub.broadcast(project, WS_EVENTS.TASK_UPDATE, repo.getTask.get(p.taskId));
    hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, buildMemberCard(member.id));
    return { ok: true };
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

  /** @param {string} memberId */
  function buildMemberCard(memberId) {
    const m = repo.getMember.get(memberId);
    if (!m) return null;
    const s = repo.getStatus.get(memberId);
    const files = s && s.current_files ? safeJson(s.current_files, []) : [];
    const task = s && s.task_id ? repo.getTask.get(s.task_id) : null;
    const artifacts = repo.listArtifacts.all(memberId, 3).map((a) => ({
      id: a.id,
      memberId: a.member_id,
      taskId: a.task_id,
      kind: a.kind,
      title: a.title,
      path: a.path,
      tsMs: a.ts_ms,
    }));
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
    repo.purgeMember(member.id);
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
