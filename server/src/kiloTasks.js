'use strict';

/**
 * 7F Kilo Code 的任务同步器。
 *
 * 和 copilotTasks.js 同理：Kilo 没有 reporter hook，不会往 WorkGremlin 的 tasks 表
 * 写东西 → 任务列表（TaskRecordsView，走 /api/v1/task-runs）看不到 7F 的任务。
 * 这个同步器周期性轮询 Kilo 自己的 kilo.db（已由 kilo.js 的 listKiloSessions 读好），
 * 把每条 Kilo 会话写成一条 task + task_run，让任务列表能显示 7F。
 *
 * 这是**兜底**，不是唯一来源：装了 WorkGremlin 插件时，plugin 那一路上报的才是真值
 * （每一轮用户任务一条），这类会话轮询这一路会让位（见下面循环里的说明）。
 *
 * Kilo 比 Copilot 多的东西：session 表里有 model 字段（真实值，不是推断）。
 * Kilo 比 Copilot 少的东西：session 表里没有 summary 列，但有 title 列。
 */

const path = require('path');
const { listKiloSessions, readKiloFiles, readRoundPrompt } = require('./kilo');

const IDLE_MS = 10 * 60_000;
const SYNC_INTERVAL_MS = 5_000;

/** task id 前缀，避免跟 reporter hook 写的 task 撞 id */
const TASK_ID_PREFIX = 'kilo:';

/** 插件那一路上报身份（products.js 里 7F 的第二路来源就是这个） */
const PLUGIN_CLIENT = 'kilo-plugin';

/**
 * @param {{bus: any, repo: any, now?: () => number}} ctx
 * @returns {number} 本次同步写/改了几条任务
 */
function syncKiloTasks({ bus, repo, now: nowFn = Date.now }) {
  const sessions = listKiloSessions();
  if (!sessions.length) return 0;

  const now = nowFn();
  let count = 0;

  const projectIdOf = (s) => s.project || (s.projectPath ? path.basename(s.projectPath) : 'Kilo Code');
  const isActiveOf = (s) => Boolean(s.lastEventAt && now - s.lastEventAt < IDLE_MS);

  /**
   * 一个工程只写**一条**成员状态（agent_status 主键就是 member_id）。
   * 同工程有多条会话时（Kilo 的工作树会话、历史会话都在），谁最后写谁赢 —— 结果是
   * "正在跑的那条任务在 agent_status 里找不到对应心跳"，任务列表按 query.js 的 CASE
   * 把它算成「已取消」，运行中的任务就不显示了（实测 2026-09-28 就是这个症状）。
   * 所以先选出这个工程该报的那条：活跃里最新的；都不活跃就报最新那条（卡片挂住最后一条任务）。
   */
  const activeByProject = new Map();
  const newestByProject = new Map();
  for (const s of sessions) {
    const pid = projectIdOf(s);
    const prevNew = newestByProject.get(pid);
    if (!prevNew || Number(s.lastEventAt || 0) > Number(prevNew.lastEventAt || 0)) newestByProject.set(pid, s);
    if (!isActiveOf(s)) continue;
    const prevAct = activeByProject.get(pid);
    if (!prevAct || Number(s.lastEventAt || 0) > Number(prevAct.lastEventAt || 0)) activeByProject.set(pid, s);
  }

  for (const s of sessions) {
    const projectPath = s.projectPath || '';
    const projectName = s.project || (projectPath ? path.basename(projectPath) : 'Kilo Code');
    const projectId = projectName;
    const taskId = `${TASK_ID_PREFIX}${s.id}`;

    // 装了 WorkGremlin 插件时，plugin 那一路上报的是**真值**：每轮用户任务一条，
    // 带 taskTitle（用户那句话）、form（形态）、result（收尾自述）、收工时间。
    // 轮询这一路只是"没装插件"时的兜底，不能跟它抢同一条会话 —— 抢的结果是同一个
    // 会话在任务列表里出现两行（轮询的会话级 + 插件的任务级），而且轮询那行每 5s
    // 还会把插件写的相位/成员状态覆盖回 thinking（收工了还显示"思考中"）。
    // 所以：这条会话已经有 plugin 行 → 整条跳过；自己上一轮抢在 plugin 前面写下的
    // 兜底行 → 收掉（只删自己前缀的 id，插件的行一根汗毛都不动）。
    const sessionRuns = repo.taskRunsOfSession.all(s.id || '');
    if (sessionRuns.some((r) => r.client === PLUGIN_CLIENT)) {
      if (sessionRuns.some((r) => r.id === taskId)) repo.deleteTaskRun(taskId);
      continue;
    }

    // 确保工程 & 成员存在（安静写入，不广播）
    bus.ensureProject(projectId, projectPath, null, 'report');
    const memberId = `kilo@${projectId}`;
    const existing = repo.getMember.get(memberId);
    repo.upsertMember.run({
      id: memberId,
      projectId,
      name: 'Kilo Code',
      role: 'agent',
      sessionId: s.id || null,
      reported: existing ? existing.reported : 1,
      createdAt: existing ? existing.created_at : now,
      lastSeenAt: now,
      ephemeral: 0,
      projectLabel: null,
      client: 'kilo',
    });

    // 判定任务状态：会话新鲜度在 IDLE_MS(10 分钟)内 = running，超了 = done。
    const isActive = Boolean(s.lastEventAt && now - s.lastEventAt < IDLE_MS);
    // 标题优先用**这一轮用户说的话**（和其它楼层「标题 = 用户那句话」同一口径）：
    // Kilo 的会话标题只在一轮开始时定一次，同一会话里再跑任务不会变 —— 拿它当标题，
    // 用户看到的就是一条永远不变的老标题，以为"新任务没记上"。取不到用户原话才退回会话标题。
    const roundPrompt = s.id ? readRoundPrompt(s.id) : '';
    const title = roundPrompt || s.title || '(Kilo 会话)';
    const startedAt = s.lastEventAt || now;
    const endedAt = isActive ? null : (s.lastEventAt || null);
    // Kilo 的 session 表有 model 字段（JSON），kilo.js 的 modelIdOf 已解出 id
    const model = s.model || null;

    repo.insertTask.run({
      id: taskId,
      projectId,
      memberId,
      parentTaskId: null,
      title,
      state: isActive ? 'running' : 'done',
      progress: isActive ? null : 1,
      startedAt,
      endedAt,
    });

    // 文件路径（从 event 表的 patch/tool 事件提取，去重）
    // Kilo 存的可能是绝对路径，统一转成相对路径（和其他 agent 一致）
    const rawFiles = readKiloFiles(s.id);
    const files = rawFiles.map((fp) =>
      projectPath && fp ? path.relative(projectPath, fp) || fp : fp
    );
    const fileCount = files.length || s.fileCount || 0;
    const filesJson = files.length ? JSON.stringify(files) : null;

    repo.upsertTaskRun.run({
      id: taskId,
      projectId,
      memberId,
      client: 'kilo',
      sessionId: s.id || null,
      form: null,
      model,
      title,
      startedAt,
      baselineCommit: null,
    });

    repo.endTaskRun.run({
      id: taskId,
      title,
      model,
      form: null,
      result: null,
      fileCount,
      filesJson,
      endedAt,
      durationMs: endedAt && startedAt ? endedAt - startedAt : null,
    });

    // 心跳：活跃 → thinking，停下 → idle。
    // 和 copilotTasks 同理：只在活跃时写 thinking，会话停掉后旧值会一直挂在库里，
    // 成员卡永远「思考中」。非活跃时补一条 idle，让状态跟着会话走。
    // 另外：**只由这个工程选中的那条会话写**（见上面 activeByProject 的说明），
    // 否则同工程别的会话会把心跳指到自己的任务上，运行中的那条被判成「已取消」。
    const owner = activeByProject.get(projectId) || newestByProject.get(projectId);
    if (owner === s) {
      repo.upsertStatus.run({
        memberId,
        state: isActive ? 'thinking' : 'idle',
        stateSince: isActive ? startedAt : now,
        taskId,
        progress: null,
        currentFiles: filesJson,
        lastHeartbeatAt: now,
        degraded: 0,
        source: 'report',
        updatedAt: now,
      });
    }

    count += 1;
  }

  return count;
}

/** 适合 setInterval 的包装：吞异常、不阻断主循环 */
function startKiloTaskSyncer(ctx) {
  const tick = () => {
    try {
      syncKiloTasks(ctx);
    } catch {
      /* Kilo 没装 / 库被占 → 这轮跳过 */
    }
  };
  tick();
  const timer = setInterval(tick, SYNC_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { syncKiloTasks, startKiloTaskSyncer, SYNC_INTERVAL_MS };
