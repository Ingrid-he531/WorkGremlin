'use strict';

/**
 * 9F GitHub Copilot 的任务同步器。
 *
 * Copilot 没有 reporter hook，不会往 WorkGremlin 的 tasks 表写东西 → 任务列表（TaskRecordsView，
 * 走 /api/v1/task-runs）永远看不到 9F 的任务。这个同步器周期性轮询 Copilot 自己的
 * session-store.db（已在 sessions.readSqliteSessionRows 里读好：sessions + turns + session_files），
 * 加上 VS Code 的会话日志（chatSessions/<会话>.jsonl，见 sessions.readCopilotLiveRequest），
 * 把**每一轮用户任务**写成一条 task + task_run，让任务列表能显示 9F。
 *
 * 设计：
 * - 幂等：task id = `copilot:<session_id>:<轮序号>`，每次重跑是 upsert，不会重复插。
 * - 安静：不广播 WS 事件（2s 会话扫盘 loop 会自然拾取变化并推给前端）。
 * - 只写 task_runs 有的列（client/session_id/file_count/files_json/title/started_at/ended_at），
 *   不编造 model/result（Copilot 的库里没有模型字段）。
 * - 状态：这一轮还在飞 → state=running、ended_at=null；收工 → state=done、ended_at=收工时刻。
 *   "在飞"听 VS Code 的两份旁证（state.vscdb 的 chat 索引 / 会话日志的完成标记），
 *   都不认识才退回时间窗 —— Copilot 自己的库整轮写完才落盘，只看时间窗必然判反。
 */

const path = require('path');
const { listSessions, copilotCurrentModel } = require('./sessions');

const IDLE_MS = 10 * 60_000;
/** Copilot 相位新鲜窗口：2 分钟内有活动 = running，超了 = done。
 *  和 sessions.js 的 COPILOT_PHASE_MS 一致，比 IDLE_MS 短 —— IDLE_MS 管"活不活"，
 *  这个管"正在不在跑"。 */
const PHASE_MS = 2 * 60_000;
const SYNC_INTERVAL_MS = 5_000;

/** task id 前缀，避免跟 reporter hook 写的 task 撞 id */
const TASK_ID_PREFIX = 'copilot:';

/**
 * 这一层写进台账 / 成员表的**上报身份**。
 *
 * 必须用 'copilot-plugin'，不能想当然写 'copilot'：9F 的 clients 由 products.js 的
 * sources 反推（9F 只有插件一个形态），只有 ['copilot-plugin']；而任务列表是按楼层
 * clients **精确**过滤的（query.js 的 `instr(@client, ',' || COALESCE(tr.client, m.client) || ',')`）。
 * 写成 'copilot' 的记录会被静默挡在 9F 的筛选之外 —— 库里有行、页面上一条都看不到。
 */
const CLIENT = 'copilot-plugin';

/**
 * @param {{bus: any, repo: any, now?: () => number}} ctx
 * @returns {number} 本次同步写/改了几条任务
 */
/** 这个工程名（工程 id）—— 成员 / 台账都按它归组 */
function projectIdOf(s) {
  const projectPath = s.projectPath || '';
  return s.project || (projectPath ? path.basename(projectPath) : 'GitHub Copilot');
}

/**
 * 这条会话现在算不算"正在跑"。
 *
 * 优先听会话行上的 `inFlight`（VS Code chat 索引给的"这一轮在不在飞"，见 sessions.js 的
 * readCopilotChatIndex）—— Copilot 自己的库整轮写完才落盘，只看时间窗会出现
 * "跑着显示待命、跑完显示思考中"。拿不到旁证（老版本 / 库被占用，inFlight === null）
 * 才退回 PHASE_MS(2 分钟) 新鲜度窗口。
 *
 * 用 2 分钟而不是 IDLE_MS(10 分钟)：10 分钟太长，任务跑完后还显示 running 10 分钟。
 */
function isSessionActive(s, now) {
  if (typeof s.inFlight === 'boolean') return s.inFlight;
  return Boolean(s.lastUpdated && now - s.lastUpdated < PHASE_MS);
}

/**
 * 写一条台账（tasks + task_runs 两行）。9F 是**每一轮一条**，见 syncCopilotTasks 的说明。
 * @returns {string|null} 这条记录的 files_json（心跳里的 current_files 直接复用）
 */
function writeTurnRun(repo, { id, projectId, memberId, sessionId, model, title, startedAt, endedAt, files }) {
  const running = !endedAt;
  repo.insertTask.run({
    id,
    projectId,
    memberId,
    parentTaskId: null,
    title,
    state: running ? 'running' : 'done',
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
  // 补 file_count / files_json / ended_at / duration_ms（upsertTaskRun 不写这些列）
  repo.endTaskRun.run({
    id,
    title,
    model: model || null,
    form: null,
    result: null,
    fileCount: files ? files.length : 0,
    filesJson,
    endedAt: endedAt || null,
    durationMs: endedAt && startedAt ? endedAt - startedAt : null,
  });
  return filesJson;
}

function syncCopilotTasks({ bus, repo, now: nowFn = Date.now }) {
  const snap = listSessions({ force: true, client: 'copilot-plugin' });
  const sessions = (snap && snap.sessions) || [];
  if (!sessions.length) return 0;

  const now = nowFn();
  // Copilot 的模型存在 VS Code 的 state.vscdb（chat.currentLanguageModel.editor），
  // 不是 per-session 的 —— 全局一份，所有会话共用。取不到留空，不拿默认模型冒充。
  const model = copilotCurrentModel();
  let count = 0;

  /**
   * 一个工程只写**一条**成员状态（agent_status 主键就是 member_id）。
   * 同工程开了多条会话时，谁最后写谁赢 —— 结果是"正在跑的那条任务在 agent_status 里
   * 找不到对应心跳"，任务列表按 query.js 的 CASE 把它算成「已取消」，运行中的任务就不显示了。
   * 所以先选出这个工程该报的那条：活跃里最新的；都不活跃就报最新那条（卡片挂住最后一条任务）。
   */
  const activeByProject = new Map();
  const newestByProject = new Map();
  for (const s of sessions) {
    const pid = projectIdOf(s);
    const prevNew = newestByProject.get(pid);
    if (!prevNew || Number(s.lastUpdated || 0) > Number(prevNew.lastUpdated || 0)) newestByProject.set(pid, s);
    if (!isSessionActive(s, now)) continue;
    const prevAct = activeByProject.get(pid);
    if (!prevAct || Number(s.lastUpdated || 0) > Number(prevAct.lastUpdated || 0)) activeByProject.set(pid, s);
  }

  for (const s of sessions) {
    const projectPath = s.projectPath || '';
    const projectName = s.project || (projectPath ? path.basename(projectPath) : 'GitHub Copilot');
    const projectId = projectName;

    // 确保工程 & 成员存在（安静写入，不广播）
    bus.ensureProject(projectId, projectPath, null, 'report');
    const memberId = `copilot@${projectId}`;
    const existing = repo.getMember.get(memberId);
    repo.upsertMember.run({
      id: memberId,
      projectId,
      name: 'GitHub Copilot',
      role: 'agent',
      sessionId: s.id || null,
      reported: existing ? existing.reported : 1,
      createdAt: existing ? existing.created_at : now,
      lastSeenAt: now,
      ephemeral: 0,
      projectLabel: null,
      client: CLIENT,
    });

    /*
     * 台账口径：**每一轮用户任务一条**（和其它楼层一样），不是"一条会话一条"。
     * 标题 = 那一轮用户说的话；起止 = 那一轮的起止（会话日志里能算准的轮就用准的，
     * 算不出来（老轮，日志已滚出尾部）就用 Copilot 自己落这条 turn 的时刻，不编造）。
     * 正在飞的那一轮同样先落一条 running —— Copilot 的库要等整轮写完才写 turns 行，
     * 只等它的话，用户跑任务时列表里会一直没有"运行中"这条。
     */
    const isActive = isSessionActive(s, now);
    const turns = Array.isArray(s.copilotTurns) ? s.copilotTurns : [];
    const changedByIndex = new Map(
      (Array.isArray(s.liveChanged) ? s.liveChanged : []).map((c) => [Number(c.index), c.files || []])
    );
    /**
     * 这一条记录该挂哪些文件：**只认会话日志里"写"工具碰过的**（copilot_replaceString /
     * copilot_multiReplaceString …），read_file / findTextInFiles 不算改动。
     * 为什么不用 session_files 那张表：实测它整张表都是 read_file（Copilot 只记"读过"），
     * 拿它当改动文件，用户没让它改文件也会报出几十个（用户实测抓出来的就是这个）。
     * 日志窗口已经滚出去的轮就留空，不拿"读过的文件"顶替。
     */
    const filesFor = (idx) => {
      const own = changedByIndex.get(idx) || [];
      const rel = own
        .map((abs) => {
          const p = String(abs || '');
          if (!p || !projectPath) return p;
          const r = path.relative(projectPath, p);
          return r && !r.startsWith('..') ? r : ''; // 工程外的文件不进这一栏
        })
        .filter(Boolean);
      return rel.length ? [...new Set(rel)] : null;
    };
    const liveReqByIndex = new Map(
      (Array.isArray(s.liveReqs) ? s.liveReqs : []).map((r) => [r.index, r])
    );

    let hbId = '';
    let hbFilesJson = null;

    // ① 每一轮已收工的：一条记录（标题就是那一轮用户原话）
    for (const t of turns) {
      const id = `${TASK_ID_PREFIX}${s.id}:${t.index}`;
      const title = t.userMessage || s.doneTitle || s.prompt || '(Copilot 会话)';
      const known = liveReqByIndex.get(t.index);
      const startedAt = (known && known.startedAt) || t.at || s.lastUpdated || now;
      const endedAt = (known && known.endedAt) || t.at || startedAt;
      // 先说"不知道起点"、后来从会话日志里算准了 → 把这条派生记录重建一次。
      // 不然 tasks.started_at 会被 insertTask 的 COALESCE 留住旧值，而 duration 按新值算，
      // 出现"started_at 比 ended_at 还晚"的怪值（实测 17:17:45 → 17:17:44）。
      const prev = repo.getTask.get(id);
      if (prev && known && known.startedAt && prev.started_at !== startedAt) repo.deleteTaskRun(id);
      hbFilesJson = writeTurnRun(repo, {
        id,
        projectId,
        memberId,
        sessionId: s.id || null,
        model,
        title,
        startedAt,
        endedAt,
        files: filesFor(t.index),
      });
      hbId = id;
      count += 1;
    }

    // ② 正在飞的那一轮：一条 running（用户原话来自 VS Code 会话日志 —— Copilot 的库此时还没有）
    let runningId = '';
    if (isActive) {
      // 轮序号 = 会话日志里的那一轮；日志还没写全时按"上一轮 + 1"兜底。
      // 一定要大于已收工的最大轮序号 —— 否则会把上一轮那条 done 记录改回 running。
      const lastDone = turns.length ? turns[turns.length - 1].index : -1;
      const logIdx = Number.isFinite(Number(s.liveIndex)) && s.liveIndex != null ? Number(s.liveIndex) : -1;
      const idx = Math.max(logIdx, lastDone + 1);
      runningId = `${TASK_ID_PREFIX}${s.id}:${idx}`;
      const title = s.livePrompt || s.prompt || s.doneTitle || '(Copilot 会话)';
      hbFilesJson = writeTurnRun(repo, {
        id: runningId,
        projectId,
        memberId,
        sessionId: s.id || null,
        model,
        title,
        startedAt: s.liveStartedAt || now,
        endedAt: null,
        files: filesFor(idx),
      });
      hbId = runningId;
      count += 1;
    }

    // ③ 收掉过渡期那条"一条会话一条"的旧记录（id 不带轮序号；只删自己前缀的）
    const legacyId = `${TASK_ID_PREFIX}${s.id}`;
    if (repo.getTaskRun.get(legacyId)) repo.deleteTaskRun(legacyId);

    // 心跳：活跃 → thinking，停下 → idle。
    // **不活跃时也必须写**：只写 thinking 的话，会话停下来之后这条 agent_status 就一直
    // 挂在库里，成员卡永远显示「思考中」（实测 9F 就是这个症状：会话早停了，工位上还在思考中）。
    // 如实回落成 idle，而不是让旧值烂在那里。
    // 心跳只由这个工程选中的那条会话写（见上面 activeByProject 的说明）
    const owner = activeByProject.get(projectId) || newestByProject.get(projectId);
    if (owner === s && hbId) {
      repo.upsertStatus.run({
        memberId,
        state: isActive ? 'thinking' : 'idle',
        stateSince: isActive ? (s.liveStartedAt || now) : now,
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
function startCopilotTaskSyncer(ctx) {
  const tick = () => {
    try {
      syncCopilotTasks(ctx);
    } catch {
      /* Copilot 没装 / 库被占 → 这轮跳过 */
    }
  };
  tick();
  const timer = setInterval(tick, SYNC_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { syncCopilotTasks, startCopilotTaskSyncer, SYNC_INTERVAL_MS };
