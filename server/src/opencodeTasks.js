'use strict';

/**
 * 8F OpenCode 的任务同步器。
 *
 * 和 7F Kilo / 9F Copilot 同一个道理：OpenCode 没有 hook 子系统时不会往 WorkGremlin 的
 * tasks 表写东西 → 任务列表（TaskRecordsView，走 /api/v1/task-runs）看不到 8F 的任务。
 * 这个同步器周期性轮询 OpenCode 自己的 opencode.db（由 opencode.js 的 readOpencodeTurns 读好），
 * 把**每一轮用户任务**写成一条 task + task_run。
 *
 * 设计（与 copilotTasks.js / kiloTasks.js 对齐）：
 * - 幂等：task id = `opencode:<会话>:<轮序号>`，每次重跑是 upsert，不会重复插。
 * - 台账口径：每一轮一条（标题 = 那一轮用户说的话，改动文件 = 那一轮 edit 工具碰过的文件，
 *   起止 = 那一轮的起止；还在飞的那轮 state=running、ended_at=null）。
 * - 装了 WorkGremlin 插件时让位：插件那一路上报的是真值（每一轮一条，带 form/result），
 *   这类会话轮询这一路整条跳过，并把自己上一轮抢写的兜底行收掉。
 * - 安静：不广播 WS 事件（2s 会话扫盘 loop 会自然拾取变化并推给前端）。
 */

const path = require('path');
const { listOpencodeSessions, readOpencodeTurns } = require('./opencode');

const SYNC_INTERVAL_MS = 5_000;
/** task id 前缀，避免跟 reporter hook 写的 task 撞 id */
const TASK_ID_PREFIX = 'opencode:';
/** 这一层的上报身份：8F 由 sources 反推得到 ["opencode","opencode-plugin"]，轮询这一路是前者 */
const CLIENT = 'opencode';

/** 这个工程名（工程 id）—— 成员 / 台账都按它归组 */
function projectIdOf(s) {
  const projectPath = s.projectPath || '';
  return s.project || (projectPath ? path.basename(projectPath) : 'OpenCode');
}

/**
 * 写一条台账（tasks + task_runs 两行）。8F 是**每一轮一条**。
 * @returns {string|null} 这条记录的 files_json（心跳里的 current_files 直接复用）
 */
function writeTurnRun(repo, { id, projectId, memberId, sessionId, model, title, startedAt, endedAt, state, files, result }) {
  const st = state || (endedAt ? 'done' : 'running');
  const running = st === 'running';
  repo.insertTask.run({
    id,
    projectId,
    memberId,
    parentTaskId: null,
    title,
    state: st,
    progress: running ? null : 1,
    startedAt,
    endedAt: endedAt || null,
  });
  repo.upsertTaskRun.run({
    id,
    projectId,
    memberId,
    client: CLIENT,
    sessionId,
    form: null,
    model: model || null,
    title,
    startedAt,
    baselineCommit: null,
  });
  const filesJson = files && files.length ? JSON.stringify(files) : null;
  repo.endTaskRun.run({
    id,
    title,
    model: model || null,
    form: null,
    // 产出摘要：OpenCode 那一轮最后说的话（见 opencode.js 的 readOpencodeTurns）；
    // 还没收工的那轮先不写（半截话不算产出），收工时再补。
    result: result || null,
    fileCount: files ? files.length : 0,
    filesJson,
    endedAt: endedAt || null,
    durationMs: endedAt && startedAt ? endedAt - startedAt : null,
  });
  return filesJson;
}

/**
 * @param {{bus: any, repo: any, now?: () => number}} ctx
 * @returns {number} 本次同步写/改了几条任务
 */
function syncOpencodeTasks({ bus, repo, now: nowFn = Date.now }) {
  const sessions = listOpencodeSessions();
  if (!sessions.length) return 0;

  const now = nowFn();
  let count = 0;

  /**
   * 一个工程只写**一条**成员状态（agent_status 主键就是 member_id）。
   * 同工程多条会话时，谁最后写谁赢 —— 会让"正在跑的那条任务"在 agent_status 里找不到心跳，
   * 任务列表按 query.js 的 CASE 把它算成「已取消」。所以只由"最新那条会话"写（见 kiloTasks.js 同款说明）。
   */
  const newestByProject = new Map();
  for (const s of sessions) {
    const pid = projectIdOf(s);
    const prev = newestByProject.get(pid);
    if (!prev || Number(s.lastEventAt || 0) > Number(prev.lastEventAt || 0)) newestByProject.set(pid, s);
  }

  for (const s of sessions) {
    const projectPath = s.projectPath || '';
    const projectId = projectIdOf(s);
    const turns = readOpencodeTurns(s.id);

    // 装了插件就让位（和 kiloTasks.js 同一口径）：插件那一路上报的是每一轮真值。
    // 判据是"有没有不是 `opencode:` 前缀的行"（插件写的 id 是 `k_*`）—— 按 id 认而不是按
    // client 认，因为 7F 那个同款判据按 client 判时从来没命中过（见 kiloTasks.js 的说明）。
    const sessionRuns = repo.taskRunsOfSession.all(s.id);
    if (sessionRuns.some((r) => !String(r.id).startsWith(TASK_ID_PREFIX))) {
      for (const r of sessionRuns) if (String(r.id).startsWith(TASK_ID_PREFIX)) repo.deleteTaskRun(r.id);
      continue;
    }
    if (!turns.length) continue;

    // 确保工程 & 成员存在（安静写入，不广播）
    bus.ensureProject(projectId, projectPath, null, 'report');
    const memberId = `opencode@${projectId}`;
    const existing = repo.getMember.get(memberId);
    repo.upsertMember.run({
      id: memberId,
      projectId,
      name: 'OpenCode',
      role: 'agent',
      sessionId: s.id || null,
      reported: existing ? existing.reported : 1,
      createdAt: existing ? existing.created_at : now,
      lastSeenAt: now,
      ephemeral: 0,
      projectLabel: null,
      client: CLIENT,
    });

    let hbId = '';
    let hbFilesJson = null;
    let running = false;
    for (const t of turns) {
      const id = `${TASK_ID_PREFIX}${s.id}:${t.index}`;
      // 改动文件：只认写工具（edit）碰过的；OpenCode 的输入是绝对路径，统一转工程相对
      const files = (t.files || [])
        .map((abs) => {
          const p = String(abs || '');
          if (!p || !projectPath) return p;
          const r = path.relative(projectPath, p);
          return r && !r.startsWith('..') ? r : '';
        })
        .filter(Boolean);
      const title = t.prompt || s.title || '(OpenCode 会话)';
      // 收工方式：OpenCode 的 idle 行写 succeeded / interrupted —— 被打断的那轮记「已取消」，
      // 不记「完成」（实测 2026-09-28：用户终止了一轮，台账却报完成）。
      const state = t.endedAt ? (t.outcome === 'interrupted' ? 'cancelled' : 'done') : 'running';
      hbFilesJson = writeTurnRun(repo, {
        id,
        projectId,
        memberId,
        sessionId: s.id || null,
        model: s.model || '',
        title,
        startedAt: t.startedAt || now,
        endedAt: t.endedAt || null,
        state,
        files,
        result: t.endedAt ? t.result || '' : '',
      });
      hbId = id;
      running = !t.endedAt;
      count += 1;
    }

    // 心跳：只在跑 = thinking，收工 = idle；指向正在跑的那条（没有就最新那条）
    if (newestByProject.get(projectId) === s && hbId) {
      const last = turns[turns.length - 1] || {};
      repo.upsertStatus.run({
        memberId,
        state: running ? 'thinking' : 'idle',
        stateSince: running ? last.startedAt || now : now,
        taskId: hbId,
        progress: null,
        currentFiles: hbFilesJson,
        lastHeartbeatAt: now,
        degraded: 0,
        source: 'report',
        updatedAt: now,
      });
    }
  }

  return count;
}

/** 适合 setInterval 的包装：吞异常、不阻断主循环 */
function startOpencodeTaskSyncer(ctx) {
  const tick = () => {
    try {
      syncOpencodeTasks(ctx);
    } catch {
      /* OpenCode 没装 / 库被占 → 这轮跳过 */
    }
  };
  tick();
  const timer = setInterval(tick, SYNC_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { syncOpencodeTasks, startOpencodeTaskSyncer, SYNC_INTERVAL_MS };
