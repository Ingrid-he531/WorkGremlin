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
 *   **让位只在插件还在报的时候成立** —— 它的上报通道断了（服务端重启换了随机 token，
 *   老进程里那份插件就哑了、而且完全无声）就得把会话收回来，不然用户跑的轮次会一条不剩地
 *   消失。这一条与 kiloTasks.js 的 yieldsOf / owner 选择 / ③b 收尾同一口径，说明见那边。
 * - 安静：不广播 WS 事件（2s 会话扫盘 loop 会自然拾取变化并推给前端）。
 */

const path = require('path');
const { listOpencodeSessions, readOpencodeTurns } = require('./opencode');

const SYNC_INTERVAL_MS = 5_000;

/**
 * 插件那一路"还活着"的两个时间参数（与 kiloTasks.js 同名同值，理由见那边的常量注释）。
 *
 * PLUGIN_GRACE_MS —— 一轮刚起的头几秒先不抢（插件本地回环，正常 1 秒内就落库）。
 *   短是必须的：它量的是"插件还没写上来"这段窗口，窗口多长用户那一轮就在列表里消失多久
 *   （实测 60 秒时，一条 8 秒的任务整轮都看不见）。
 * PLUGIN_COVER_MS —— 判"这一轮插件报过没有"时，插件那行的 started_at 与轮次起点允许的差
 *   （实测 ±90ms 内、方向不定；判漏了会多写一条孪生行，判重了会把两秒内连开两轮当同一轮）。
 */
const PLUGIN_GRACE_MS = 3_000;
const PLUGIN_COVER_MS = 2_000;

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

/** 台账 id 里的轮序号（`opencode:<会话id>:<序号>`）；不是这个形状就回 null（同 kiloTasks.js） */
function turnIndexOf(taskId, prefix) {
  const id = String(taskId || '');
  if (!id.startsWith(`${prefix}:`)) return null;
  const n = Number(id.slice(prefix.length + 1));
  return Number.isInteger(n) && n >= 0 ? n : null;
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

  // 每条会话的逐轮清单**和**它现有的台账行各只读一次：让位判定、owner 选择、写台账三处复用
  const turnsOf = new Map();
  const runsOf = new Map();
  for (const s of sessions) {
    turnsOf.set(s.id, readOpencodeTurns(s.id));
    runsOf.set(s.id, repo.taskRunsOfSession.all(s.id || ''));
  }
  /** 这条会话现在算不算在跑（还有一轮没收工） */
  const isActiveOf = (s) => (turnsOf.get(s.id) || []).some((t) => !t.endedAt);

  /** 插件给这条会话写的那些行（服务端发的 `k_*`）各自报的轮次起点；没写过 → [] */
  const pluginStartsOf = (s) =>
    runsOf.get(s.id).filter((r) => !String(r.id).startsWith(TASK_ID_PREFIX)).map((r) => Number(r.started_at || 0));

  /** 插件**为这一轮**写过行没有：按轮次起点对齐（容许 PLUGIN_COVER_MS 的误差，理由见常量） */
  const coveredBy = (starts, at) => starts.some((p) => Math.abs(p - Number(at || 0)) <= PLUGIN_COVER_MS);

  /**
   * 这条会话是不是已经有**插件写的**行了（插件写的是服务端发的 `k_*`，轮询写的是 `opencode:*`）——
   * 有就整条让位。判据按 id 前缀而不是 client（理由见 kiloTasks.js 同名函数）。
   *
   * **让位只在插件还在报的时候成立**（2026-09-30 起，与 kiloTasks.js 同口径）：插件写的行只
   * 证明它**曾经**在报 —— 它跟着 agent 进程活，通道断了（服务端重启换了随机 token，老进程里
   * 那份插件从此每条上报都 401 且完全无声）时，两路都不写，用户跑的轮次就凭空消失。
   * 判据因此是"插件**这一轮**也写了没有"：它最新那一行落在源里最新这一轮起点之后
   * （容许 PLUGIN_COVER_MS 的误差）→ 让位；这一轮刚起就再等 PLUGIN_GRACE_MS，过了还不见
   * 它的行 → 收回这条会话。插件活着时每轮开跑 1 秒内就写一条，正常永不命中；它只是慢了
   * （注册重试中）就先照旧让位，等它写上来让位重新成立、轮询自己的行被收掉（自愈）。
   * 宽限期**从这一轮的起点算**（不是"插件沉默多久"）：插件两轮之间本来就不写东西，沉默是常态。
   */
  const yieldsOf = (s) => {
    const starts = pluginStartsOf(s);
    if (!starts.length) return false;
    const turns = turnsOf.get(s.id) || [];
    const last = turns[turns.length - 1];
    const turnStart = last ? Number(last.startedAt || 0) : 0;
    const newestTheirs = starts.reduce((m, p) => Math.max(m, p), 0);
    if (newestTheirs >= turnStart - PLUGIN_COVER_MS) return true;
    return now - turnStart <= PLUGIN_GRACE_MS;
  };

  /**
   * 让位给插件的那条会话，插件是不是**冒我们这个身份、而且现在正跑着**？
   * CLI 形态的插件（没有 VS Code 环境变量）报的就是裸 `opencode` —— 同一个成员
   * `opencode@<工程>`，见 plugin/index.js 的 resolveClient。是的话这条工程的成员状态先归
   * 插件写：轮询这一路连心跳都不碰，否则 5s 一次轮询会把插件刚写的相位覆盖成轮询视角下的
   * 旧状态（agent_status 谁最后写谁赢）。收工后交回轮询（与 kiloTasks.js 同款）。
   */
  const pluginOwnsMember = new Set();
  for (const s of sessions) {
    if (!yieldsOf(s) || !isActiveOf(s)) continue;
    if (runsOf.get(s.id).some((r) => String(r.client) === CLIENT)) pluginOwnsMember.add(projectIdOf(s));
  }

  /**
   * 一个工程只写**一条**成员状态（agent_status 主键就是 member_id）。
   * 同工程多条会话时，谁最后写谁赢 —— 会让"正在跑的那条任务"在 agent_status 里找不到心跳，
   * 任务列表按 query.js 的 CASE 把它算成「已取消」。所以先选出这个工程该报的那条：
   * 活跃里最新的；都不活跃就报最新那条（卡片挂住最后一条任务）—— 与 kiloTasks.js 同款。
   */
  const activeByProject = new Map();
  const newestByProject = new Map();
  for (const s of sessions) {
    // 让位的会话**不参与** owner 选择：它这一路根本不写心跳，把它算进来就会让同工程另一条
    // 真在跑的会话永远选不上 owner —— 那条任务在 agent_status 里找不到心跳，被判成「已取消」。
    if (yieldsOf(s)) continue;
    const pid = projectIdOf(s);
    const prevNew = newestByProject.get(pid);
    if (!prevNew || Number(s.lastEventAt || 0) > Number(prevNew.lastEventAt || 0)) newestByProject.set(pid, s);
    if (!isActiveOf(s)) continue;
    const prevAct = activeByProject.get(pid);
    if (!prevAct || Number(s.lastEventAt || 0) > Number(prevAct.lastEventAt || 0)) activeByProject.set(pid, s);
  }

  for (const s of sessions) {
    const projectPath = s.projectPath || '';
    const projectId = projectIdOf(s);
    const prefix = `${TASK_ID_PREFIX}${s.id}`;

    // 装了插件就让位（和 kiloTasks.js 同一口径）：插件那一路上报的是每一轮真值，判据是
    // "这个会话有没有插件写的行"（插件写的 id 是 `k_*`，按 id 认而不是按 client 认 ——
    // 7F 那个同款判据按 client 判时从来没命中过，见 kiloTasks.js 的说明）。
    // 但让位只在插件**还在报**时成立（yieldsOf）：通道断了就把会话收回来，
    // 自己上一轮抢写的兜底行同样收掉（只删自己前缀的 id，插件的行一根汗毛都不动）。
    const sessionRuns = runsOf.get(s.id);
    if (yieldsOf(s)) {
      for (const r of sessionRuns) if (String(r.id).startsWith(TASK_ID_PREFIX)) repo.deleteTaskRun(r.id);
      continue;
    }
    const turns = turnsOf.get(s.id) || [];
    if (!turns.length) continue;
    // 从断线插件手里收回来的会话：**插件报过的轮次它自己管**（那些行是 `k_*`），
    // 只补它断线之后的（判据"这一轮插件没报过"，与 kiloTasks.js 的 ②b 同一口径）。
    const starts = pluginStartsOf(s);

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
      if (coveredBy(starts, t.startedAt)) continue; // 插件报过的轮次不重复写
      const id = `${prefix}:${t.index}`;
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

    // 收掉"源里已经没有"的那几轮（与 kiloTasks.js 的 ③b 同一口径）：轮次表缩短时
    // （OpenCode 清了消息 / 压过上下文），那几行永远等不到自己的轮 —— 一直挂在 'running'，
    // 被 query.js 的 CASE 判成「已取消」，在列表里当一条假任务躺着。
    // 判据是"这一轮还在不在源里"（byIndex），不认数组下标。turns 整个读空时上面已经
    // continue 了（不在这里删）：读不出来 ≠ 源里没有。
    const byIndex = new Set(turns.map((t) => t.index));
    for (const r of sessionRuns) {
      const idx = turnIndexOf(r.id, prefix);
      if (idx === null || byIndex.has(idx)) continue;
      repo.deleteTaskRun(r.id);
    }

    // 心跳：只在跑 = thinking，收工 = idle；指向正在跑的那条（没有就最新那条）。
    // **只由这个工程选中的那条会话写**（见上面 activeByProject 的说明）；
    // 插件正冒我们这个身份在报、且那轮还没收工 → 这一栏整个让给它（见 pluginOwnsMember）。
    const owner = pluginOwnsMember.has(projectId)
      ? null
      : activeByProject.get(projectId) || newestByProject.get(projectId);
    if (owner === s && hbId) {
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
