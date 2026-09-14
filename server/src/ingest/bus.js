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

const { AGENT_STATES, MESSAGE_TYPES, DEFAULTS, WS_EVENTS, dedupeKey } = require('@workgremlin/shared');
const clock = require('../clock');

function teamIdOf(name) {
  return name;
}

function memberIdOf(team, name) {
  return String(name).includes('@') ? name : `${name}@${team}`;
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
 * @param {{ repo: any, hub: any }} ctx
 */
function createIngestBus({ repo, hub }) {
  const now = () => clock.now();

  function ensureTeam(name, workspacePath = '', mainConversationId = null, source = 'report') {
    const id = teamIdOf(name);
    repo.upsertTeam.run({
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
   * @param {{team: string, memberId?: string, name: string, role?: string, sessionId?: string, workspacePath?: string}} p
   */
  function registerMember(p) {
    const team = teamIdOf(p.team);
    ensureTeam(p.team, p.workspacePath || '', null, 'report');
    const id = memberIdOf(team, p.memberId || p.name);
    const existing = repo.getMember.get(id);
    repo.upsertMember.run({
      id,
      teamId: team,
      name: p.name || id.split('@')[0],
      role: p.role ?? null,
      sessionId: p.sessionId ?? null,
      // reported=0 表示"仅被动观测"（A 路线发现的成员），不主动上报真值
      reported: p.reported === 0 ? 0 : 1,
      createdAt: existing ? existing.created_at : now(),
      lastSeenAt: now(),
    });
    hub.broadcast(team, WS_EVENTS.MEMBER_STATUS, buildMemberCard(id));
    return id;
  }

  function requireMember(team, memberId) {
    const id = memberIdOf(team, memberId);
    const m = repo.getMember.get(id);
    if (!m) return null;
    return m;
  }

  /**
   * 心跳 / 轻量状态更新。
   * @param {{team: string, memberId: string, state?: string, progress?: number, taskId?: string, files?: string[], ts?: number}} p
   */
  function heartbeat(p) {
    const team = teamIdOf(p.team);
    const member = requireMember(team, p.memberId);
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
    hub.broadcast(team, WS_EVENTS.MEMBER_STATUS, card);
    return { ok: true, card };
  }

  /**
   * 显式状态切换（含 blocked + 原因）。
   */
  function setStatus(p) {
    const team = teamIdOf(p.team);
    const member = requireMember(team, p.memberId);
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
    hub.broadcast(team, WS_EVENTS.MEMBER_STATUS, card);
    return { ok: true, card };
  }

  function startTask(p) {
    const team = teamIdOf(p.team);
    const member = requireMember(team, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const ts = Number(p.ts) || now();
    const id = p.taskId || `t_${ts.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    repo.insertTask.run({
      id,
      teamId: team,
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
    hub.broadcast(team, WS_EVENTS.TASK_UPDATE, repo.getTask.get(id));
    hub.broadcast(team, WS_EVENTS.MEMBER_STATUS, buildMemberCard(member.id));
    return { ok: true, taskId: id };
  }

  function taskProgress(p) {
    const team = teamIdOf(p.team);
    const member = requireMember(team, p.memberId);
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
    hub.broadcast(team, WS_EVENTS.TASK_UPDATE, repo.getTask.get(p.taskId));
    hub.broadcast(team, WS_EVENTS.MEMBER_STATUS, buildMemberCard(member.id));
    return { ok: true };
  }

  function endTask(p) {
    const team = teamIdOf(p.team);
    const member = requireMember(team, p.memberId);
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
      hub.broadcast(team, WS_EVENTS.ARTIFACT_NEW, {
        memberId: member.id,
        taskId: p.taskId ?? null,
        kind: a.kind || 'file',
        title: a.title || a.path || '(产出)',
        path: a.path ?? null,
        tsMs: ts,
      });
    }
    hub.broadcast(team, WS_EVENTS.TASK_UPDATE, repo.getTask.get(p.taskId));
    hub.broadcast(team, WS_EVENTS.MEMBER_STATUS, buildMemberCard(member.id));
    return { ok: true };
  }

  /**
   * 记录一条消息。source='report' 为上报真值；source='watch' 为目录监听兜底。
   */
  function recordMessage(p) {
    const team = teamIdOf(p.team);
    const ts = Number(p.ts) || now();
    const from = memberIdOf(team, p.from);
    const to = p.to ? memberIdOf(team, p.to) : null;
    const type = MESSAGE_TYPES.includes(p.type) ? p.type : p.type || 'system';
    const key = p.dedupeKey || dedupeKey({ team, from, to, ts, content: p.content || '' });

    const info = repo.insertMessage.run({
      dedupeKey: key,
      teamId: team,
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
    hub.broadcast(team, WS_EVENTS.MESSAGE_NEW, toMessage(row));
    return { ok: true, id: row.id };
  }

  function fileTouch(p) {
    const team = teamIdOf(p.team);
    const member = requireMember(team, p.memberId);
    if (!member) return { ok: false, error: 'unknown_member' };
    const ts = Number(p.ts) || now();
    const op = p.op === 'read' ? 'read' : 'write';
    const files = Array.isArray(p.files) ? p.files : p.path ? [p.path] : [];
    for (const f of files) repo.insertFileActivity.run(member.id, f, op, ts);
    repo.trimFileActivity.run(member.id, member.id, 200);
    for (const f of files) {
      hub.broadcast(team, WS_EVENTS.FILE_ACTIVITY, { memberId: member.id, path: f, op, tsMs: ts });
    }
    return { ok: true };
  }

  /** @param {any} row */
  function toMessage(row) {
    return {
      id: row.id,
      teamId: row.team_id,
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
    const cnt = repo.countMessagesFor.get(m.team_id, memberId, memberId);

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
    };
  }

  function safeJson(str, fallback) {
    try {
      const v = JSON.parse(str);
      return Array.isArray(v) ? v : fallback;
    } catch {
      return fallback;
    }
  }

  /** 首屏快照 */
  function buildSnapshot(teamName) {
    const teams = repo.listTeams.all();
    const teamRow = teamName ? repo.getTeam.get(teamIdOf(teamName)) : teams[0];
    if (!teamRow) {
      return { team: null, teams, members: [], recentMessages: [], serverTime: now(), serverVersion: '0.1.0' };
    }
    const members = repo.listMembers.all(teamRow.id).map((m) => buildMemberCard(m.id)).filter(Boolean);
    const recentMessages = repo.listMessages(teamRow.id, { limit: DEFAULTS.MESSAGE_WINDOW, direction: 'desc' })
      .slice()
      .reverse()
      .map(toMessage);
    return {
      team: {
        id: teamRow.id,
        name: teamRow.name,
        workspacePath: teamRow.workspace_path,
        mainConversationId: teamRow.main_conversation_id,
        source: teamRow.source,
        createdAt: teamRow.created_at,
      },
      teams,
      members,
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
      if (m) hub.broadcast(m.team_id, WS_EVENTS.MEMBER_STATUS, buildMemberCard(s.member_id));
    }
    return rows.length;
  }

  return {
    teamIdOf,
    memberIdOf,
    ensureTeam,
    registerMember,
    heartbeat,
    setStatus,
    startTask,
    taskProgress,
    endTask,
    recordMessage,
    fileTouch,
    buildMemberCard,
    buildSnapshot,
    sweepDegraded,
    toMessage,
  };
}

module.exports = { createIngestBus, teamIdOf, memberIdOf };
