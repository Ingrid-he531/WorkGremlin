'use strict';

/**
 * 6F Qoder **插件形态**（VS Code / Trae CN 里的「Qoder CN (Formerly Lingma)」扩展）的任务同步器。
 *
 * 与 7F Kilo / 8F OpenCode / 9F Copilot 同一个道理，但原因更硬：这个扩展**没有 hook 子系统**
 * （extension.js 里连 SessionStart / PreToolUse 这些字样都没有，实测 2026-09-30），
 * 它不读 ~/.qoder-cn/settings.json，所以 CLI 那条 hook 路对它完全无效 —— 重启应用、
 * 重新编译都不会让它上报。只能由服务端轮询它自己的落盘（见 lingma.js）。
 *
 * 口径与其它轮询楼层对齐（kiloTasks.js / opencodeTasks.js）：
 *   · **每一轮一条**：task id = `qoder-plugin:<会话id>:<轮序号>`，标题 = 用户原话
 *     （lingma.js 从 chat_record.extra.originalContent 取，明文）；
 *   · 产出摘要用扩展自己写的 `summary`（明文）；逐字回复是密文，取不到就留空，不猜；
 *   · 改动文件从聊天快照取（挂得上的轮次才记，见 lingma.js 的 filesByRecord）；
 *   · 幂等：每轮都是 upsert，重跑不会插重；源里已经消失的轮次把自己写的行收掉。
 *
 * ## 与 CLI 那一路的关系
 *
 * products.js 的 6F 是"CLI 与插件合并单楼层"（同一个 client `qoder`），成员也是同一个
 * （`qoder@<工程>`）。所以这一路**让位**：这个成员此刻正被 hook 那一路占着（CLI 在跑、
 * 最近有心跳）时，台账照写、**状态栏一个字都不动** —— agent_status 一行一成员、只有一个
 * task_id 槽位，硬写会把 CLI 刚上报的相位压成插件视角下的旧状态。
 *
 * ⚠️ 已知取舍：两路**同时**在跑时，槽位只能挂一条，另一条在任务记录里会显示「已取消」
 * （query.js 的存活判定：state='running' 却没有任何在飞的心跳指着它）。这是"一行一成员
 * 一个槽位"的结构性限制，与 7F 那次「已取消」同源；插件这一路的相位本身就是推断出来的，
 * 不值得为它去动那条判定。
 *
 * ## 相位是推断，不是上报
 *
 * 源里**没有**"这一轮跑完了没有"的真值（finish_status 常驻 0，answer 是密文），
 * 只有"最后一次更新"的时间。所以"还在跑"= 这是本会话最后一轮、且 90 秒内还有落盘
 * （见 LIVE_MS），并且**必须**当推断看 —— 与 7F/8F 的轮询相位同等待遇，不冒充实报真值。
 */

const path = require('path');
// LIVE_MS（"这一轮还在跑"的判据）与会话表那一支共用同一把尺子，定义在 lingma.js ——
// 两边对"这一轮还在不在跑"必须给同一个答案，否则主控制台与任务记录会互相打架。
const { listLingmaSessions, readLingmaRounds, LIVE_MS } = require('./lingma');
const { resolveProjectName } = require('./project');

const SYNC_INTERVAL_MS = 5_000;

/** task id 前缀：认人用（我们自己写的行都是这个前缀，hook 那一路是 `t_*`），也避免撞 id */
const TASK_ID_PREFIX = 'qoder-plugin:';
/** 这一路的 client：与 6F 的 CLI 同一个（products.js：CLI 与插件合并单楼层） */
const CLIENT = 'qoder';
/** 形态列：插件那一路（任务列表里显示 "Qoder Plugin" 而不是 "Qoder CLI"） */
const FORM = 'plugin';
/** 产出摘要的长度上限（与 hook.js 的 RESULT_MAX 同量级） */
const RESULT_MAX = 4_000;
/** hook（CLI）那一路的心跳多久算"还活着"—— 活着就让位，不碰状态栏 */
const HOOK_FRESH_MS = 60_000;

/** 工程名（工程 id）：与 CLI 那一路用同一条解析（hook 报的是 package.json 里的名字，
 *  实测 `qoder@workgremlin`），否则插件与 CLI 会各自建一个成员、同一层里两个工位 */
function projectIdOf(s) {
  const projectPath = s.projectPath || '';
  if (!projectPath) return '';
  return resolveProjectName(projectPath) || path.basename(projectPath);
}

/**
 * 写一条台账（tasks + task_runs 两行）。6F 插件这一路是**每一轮一条**。
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
    form: FORM,
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
    form: FORM,
    // 产出摘要：扩展自己写的 summary（明文）。还在飞的那轮先不写（半截话不算产出），
    // 收工时由下一次同步补上 —— 与 7F/8F 同款。
    result: result || null,
    fileCount: files ? files.length : 0,
    filesJson,
    endedAt: endedAt || null,
    durationMs: endedAt && startedAt ? endedAt - startedAt : null,
  });
  return filesJson;
}

/** 台账 id 里的轮序号（`qoder-plugin:<会话id>:<序号>`）；不是这个形状就回 null */
function turnIndexOf(taskId, prefix) {
  const id = String(taskId || '');
  if (!id.startsWith(`${prefix}:`)) return null;
  const n = Number(id.slice(prefix.length + 1));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** hook（CLI）那一路此刻是不是正占着这个成员：状态栏挂在一条**不是我们写的**任务上、且心跳新鲜 */
function hookOwnsMember(repo, memberId, now) {
  try {
    const st = repo.getStatus.get(memberId);
    if (!st || !st.task_id) return false;
    if (String(st.task_id).startsWith(TASK_ID_PREFIX)) return false;
    return now - Number(st.last_heartbeat_at || 0) <= HOOK_FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * @param {{bus: any, repo: any, now?: () => number}} ctx
 * @returns {number} 本次同步写/改了几条任务
 */
function syncQoderPluginTasks({ bus, repo, now: nowFn = Date.now }) {
  const sessions = listLingmaSessions();
  if (!sessions.length) return 0;

  const now = nowFn();
  let count = 0;

  const roundsOf = new Map();
  const runsOf = new Map();
  for (const s of sessions) {
    roundsOf.set(s.id, readLingmaRounds(s.id));
    runsOf.set(s.id, repo.taskRunsOfSession.all(s.id || ''));
  }

  /** 这一轮是不是"还在跑"（本会话最后一轮 + 90 秒内还有落盘；判据与理由见 LIVE_MS） */
  const isLive = (s, round) => {
    const rounds = roundsOf.get(s.id) || [];
    if (!rounds.length || rounds[rounds.length - 1] !== round) return false;
    return now - Math.max(Number(round.updatedAt || 0), Number(s.lastEventAt || 0)) <= LIVE_MS;
  };

  /**
   * 一个工程只写**一条**成员状态（agent_status 主键就是 member_id）。
   * 同工程多条插件会话时谁最后写谁赢，所以先选出"该由哪条会话代表这个工程上报"：
   * 活跃里最新的；都不活跃就报最新那条（卡片挂住最后一条任务）。与 7F/8F 同款。
   */
  const activeByProject = new Map();
  const newestByProject = new Map();
  for (const s of sessions) {
    if (!(roundsOf.get(s.id) || []).length) continue;
    const pid = projectIdOf(s);
    if (!pid) continue;
    const prevNew = newestByProject.get(pid);
    if (!prevNew || Number(s.lastEventAt || 0) > Number(prevNew.lastEventAt || 0)) newestByProject.set(pid, s);
    const live = (roundsOf.get(s.id) || []).some((r) => isLive(s, r));
    if (!live) continue;
    const prevAct = activeByProject.get(pid);
    if (!prevAct || Number(s.lastEventAt || 0) > Number(prevAct.lastEventAt || 0)) activeByProject.set(pid, s);
  }

  for (const s of sessions) {
    const projectPath = s.projectPath || '';
    const projectId = projectIdOf(s);
    if (!projectId) continue;
    const rounds = roundsOf.get(s.id) || [];
    const prefix = `${TASK_ID_PREFIX}${s.id}`;
    // 工程里没有可写的轮次（只在插件里开了个会话、一句话没说）：不建工程也不建成员，
    // 免得 6F 的工位上凭空多出一个空工位
    if (!rounds.length) continue;

    // 确保工程 & 成员存在（安静写入，不广播；工程名与 CLI 那一路同一条解析）
    bus.ensureProject(projectId, projectPath, null, 'report');
    const memberId = `${CLIENT}@${projectId}`;
    const existing = repo.getMember.get(memberId);
    repo.upsertMember.run({
      id: memberId,
      projectId,
      // 名字只在**新建**成员时生效（repo.upsertMember 的 ON CONFLICT 不更新 name，见 db/index.js
      // 那一句"名字由第一次落库的那一路定"）。CLI 那一路先来的话它叫 'qoder'（hook 上报没带
      // 名字，bus 按 memberId 前缀落），这里不会把它改名。
      name: 'Qoder',
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
    for (const t of rounds) {
      const id = `${prefix}:${t.index}`;
      // 改动文件：扩展记的是绝对路径，统一转工程相对（与 7F/8F 同款）
      const files = (t.files || [])
        .map((abs) => {
          const p = String(abs || '');
          if (!p) return '';
          if (!projectPath) return p;
          const rel = path.relative(projectPath, p);
          return rel && !rel.startsWith('..') ? rel : '';
        })
        .filter(Boolean);
      const live = isLive(s, t);
      const title = t.prompt.replace(/\s+/g, ' ').trim() || s.title || '(Qoder 插件会话)';
      hbFilesJson = writeTurnRun(repo, {
        id,
        projectId,
        memberId,
        sessionId: s.id || null,
        model: t.model || '',
        title,
        startedAt: t.startedAt || now,
        // 收工时间 = 这一轮最后一次落盘的时刻（源里没有更准的收工信号，见文件头）
        endedAt: live ? null : t.updatedAt || t.startedAt || now,
        state: live ? 'running' : 'done',
        files,
        // 还在飞的那轮不写产出（下一轮开始时它已经在源里定稿，那个时候再补）
        result: live ? '' : String(t.summary || '').slice(0, RESULT_MAX),
      });
      hbId = id;
      running = live;
      count += 1;
    }

    // 收掉"源里已经没有"的轮次（插件里删了会话/清过记录）：那几行永远等不到自己的轮，
    // 会一直挂在 'running' 被 query.js 判成「已取消」。判据是"这一轮还在不在源里"（byIndex）。
    const byIndex = new Set(rounds.map((t) => t.index));
    for (const r of runsOf.get(s.id)) {
      const idx = turnIndexOf(r.id, prefix);
      if (idx === null || byIndex.has(idx)) continue;
      repo.deleteTaskRun(r.id);
    }

    // 状态栏：只在"这个工程该由本条会话上报"、且 CLI 那一路没占着的时候写。
    // 在跑 = thinking（推断），收工 = idle；槽位指向正在跑的那条（没有就最新那条）。
    const owner = activeByProject.get(projectId) || newestByProject.get(projectId);
    bus.setSessionStatus({
      project: projectId,
      memberId: CLIENT,
      sessionId: s.id,
      state: running ? 'thinking' : 'idle',
      taskId: running ? hbId : null,
      ts: now,
    });
    if (owner === s && hbId && !hookOwnsMember(repo, memberId, now)) {
      repo.upsertStatus.run({
        memberId,
        state: running ? 'thinking' : 'idle',
        stateSince: running ? rounds[rounds.length - 1].startedAt || now : now,
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
function startQoderPluginTaskSyncer(ctx) {
  const tick = () => {
    try {
      syncQoderPluginTasks(ctx);
    } catch {
      /* 插件界面没开过 / 库被占 / 原生模块缺失 → 这轮跳过，其余楼层照常 */
    }
  };
  tick();
  const timer = setInterval(tick, SYNC_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { syncQoderPluginTasks, startQoderPluginTaskSyncer, SYNC_INTERVAL_MS, LIVE_MS, TASK_ID_PREFIX };
