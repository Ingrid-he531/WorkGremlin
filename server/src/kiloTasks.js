'use strict';

/**
 * 7F Kilo Code 的任务同步器。
 *
 * 和 copilotTasks.js / opencodeTasks.js 同理：Kilo 没有 reporter hook，不会往 WorkGremlin 的
 * tasks 表写东西 → 任务列表（TaskRecordsView，走 /api/v1/task-runs）看不到 7F 的任务。
 * 这个同步器周期性轮询 Kilo 自己的 kilo.db（会话清单由 kilo.js 的 listKiloSessions 读、
 * 逐轮清单由 readKiloRounds 读），把**每一轮用户任务**写成一条 task + task_run。
 *
 * 这是**兜底**，不是唯一来源：装了 WorkGremlin 插件时，plugin 那一路上报的才是真值
 * （每一轮用户任务一条），这类会话轮询这一路会让位（见下面循环里的说明）——
 * 但让位只在插件**还在报**时成立：它的通道断了（服务端重启换 token、老进程里那份插件哑了）
 * 就得把这条会话收回来，不然用户跑的轮次会一条不剩地消失（见 yieldsOf）。
 *
 * Kilo 比 Copilot 多的东西：session 表里有 model 字段（真实值，不是推断）、
 * message 表能读出每一轮的边界与收工 finish。
 * Kilo 比 Copilot 少的东西：session 表里没有 summary 列，但有 title 列。
 *
 * ---- 为什么是"每一轮一条"（2026-09-30 修的） ----
 * 早先这里是**一条会话一行**（id 固定 `kilo:<会话id>`，没有轮序号），两个后果实测都不可接受：
 *
 *   1) **时间戳钉死**：`repo.insertTask` 的 upsert 写的是
 *      `started_at = COALESCE(tasks.started_at, excluded.started_at)` —— 只认第一次写进去的
 *      值；而 `state` / `ended_at` 每次都会刷新。于是在一条**老会话**里跑新任务时，
 *      那一行被翻回 'running'、心跳也是新的，`started_at` 却永远停在第一次见到它的那一刻。
 *      实测：`kilo:ses_f196292a6ffeYJgna2s9DxcVIU` 显示运行中、时间却是 9-28 15:30，
 *      而那一轮其实是 9-30 10:04 起的 —— 任务列表按 started_at 倒序，它就压在底部上不来。
 *   2) **每一轮的起止都是假的**：`started_at == ended_at`、`duration_ms` 恒为 0，
 *      历史轮次互相覆盖，一轮都留不下。
 *
 * 所以改成和 8F / 9F 同口径：**id = `kilo:<会话id>:<轮序号>`，一轮一条**。
 * 轮的起点取 `message.time_created`（不可变），所以 9F 那条"起点被 COALESCE 钉住、
 * 只好删行重建"的补丁 7F 不需要。
 *
 * ---- 取舍：只记**当前这一轮**，不回溯历史 ----
 * 轮询这一路只 materialize 每条会话**最后一轮**（正在飞的那轮，或收工后留下的那轮），
 * 不把历史轮次补进台账。理由：这是兜底路径，列表要保持干净；插件那一路才是每轮真值。
 * 代价是同一会话此前的轮次永远补不回来 —— 这一轮收工、下一轮开始时，由下面第 ③ 步
 * 把它定稿（不然它会永远停在 'running'，被 query.js 的 CASE 判成「已取消」，
 * 而它其实是干完了的）。
 *
 * 唯一例外是第 ②b 步：从**断线插件**手里收回来的会话，会把插件断线期间漏掉的那几轮补上
 * （判据是"比插件最新一行还新"）。那几轮不是"历史"，是"本该有行却一直没等到"。
 */

const path = require('path');
const { listKiloSessions, readKiloRounds } = require('./kilo');

const SYNC_INTERVAL_MS = 5_000;

/**
 * 插件那一路"还活着"的两个时间参数（见下面的 yieldsOf / coveredBy）。
 *
 * PLUGIN_GRACE_MS —— 一轮刚起的头几秒先不抢：插件收到用户消息就写台账（本地回环，实测
 *   30~90 毫秒就落库），所以"这一轮已经跑了几秒、插件还没为它写行"基本就等于它哑了。
 *   这个值**必须短**，因为它量的是"插件还没写上来"这段窗口，而这段窗口里轮询是**不写**的
 *   —— 窗口多长，用户的这一轮就在列表里消失多久。实测（2026-09-30 13:42）：一条 8 秒的
 *   任务（13:42:44 → 13:42:52），按 60 秒算的时候整轮都落在宽限期里，用户看着它跑完、
 *   又等了 52 秒才在列表里看到那行（报的是"输入 Prompt 后没看到任务，任务结束后一会才
 *   看到"）。3 秒是本地回环的宽裕余量，同时把消失窗口压到一次轮询（5s）以内。
 * PLUGIN_COVER_MS —— 判"这一轮插件报过没有"时，插件那行的 started_at 与轮次起点允许差
 *   多少。两边记的是同一个事件的两端：插件记它**看到消息**的时刻，轮次表记消息**落库**
 *   的时刻，实测差在 ±90ms 内且方向不定（+34 / -87 / -14ms 三例）。判漏了会与插件的行
 *   并排多写一条（孪生行，而且它自己好不了）；判重了会把"两秒内连开两轮"当成同一轮。
 */
const PLUGIN_GRACE_MS = 3_000;
const PLUGIN_COVER_MS = 2_000;

/** task id 前缀，避免跟 reporter hook 写的 task 撞 id */
const TASK_ID_PREFIX = 'kilo:';

/** 这一层的上报身份：轮询这一路（7F 由 sources 反推得到 ["kilo","kilo-plugin"]，前者是它） */
const CLIENT = 'kilo';

/** 这个工程名（工程 id）—— 成员 / 台账都按它归组 */
function projectIdOf(s) {
  const projectPath = s.projectPath || '';
  return s.project || (projectPath ? path.basename(projectPath) : 'Kilo Code');
}

/**
 * 写一条台账（tasks + task_runs 两行）。7F 是**每一轮一条**，口径照抄 opencodeTasks.js 的同名函数
 * （它接受显式 state 与 result —— Kilo 两样都要：分辨 done / cancelled，以及这一轮的收尾自述）。
 * @returns {string|null} 这条记录的 files_json（心跳里的 current_files 直接复用）
 */
function writeTurnRun(repo, { id, projectId, memberId, sessionId, model, title, startedAt, endedAt, state, files, result, tokens }) {
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
    // 产出摘要：这一轮最后一条 assistant 说的话（见 kilo.js 的 readKiloRounds）；
    // 还没收工的那轮先不写（半截话不算产出），收工时再补。
    result: result || null,
    fileCount: files ? files.length : 0,
    filesJson,
    endedAt: endedAt || null,
    durationMs: endedAt && startedAt ? endedAt - startedAt : null,
  });
  /* 本轮消耗的 token（readKiloRounds 从 message.data.tokens 折出来，语义见 kilo.js）。
     这条语句是**覆盖写**而不是 COALESCE：这一轮还在跑时每次轮询都会重算，数值是长出来的，
     用 COALESCE 会把第一次读到的那个偏小的值钉死。tokens 为 null 时如实写 NULL。 */
  repo.setTaskRunTokens.run({
    id,
    inputTokens: tokens ? tokens.input : null,
    outputTokens: tokens ? tokens.output : null,
    cacheReadTokens: tokens ? tokens.cacheRead : null,
    cacheWriteTokens: tokens ? tokens.cacheWrite : null,
  });
  return filesJson;
}

/** 台账 id 里的轮序号（`kilo:<会话id>:<序号>`）；不是这个形状就回 null */
function roundIndexOf(taskId, prefix) {
  const id = String(taskId || '');
  if (!id.startsWith(`${prefix}:`)) return null;
  const n = Number(id.slice(prefix.length + 1));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * @param {{bus: any, repo: any, now?: () => number}} ctx
 * @returns {number} 本次同步写/改了几条任务
 */
function syncKiloTasks({ bus, repo, now: nowFn = Date.now }) {
  const sessions = listKiloSessions();
  if (!sessions.length) return 0;

  const now = nowFn();
  let count = 0;

  // 每条会话的逐轮清单**和**它现有的台账行各只读一次：让位判定、owner 选择、写台账三处都复用
  // （逐轮清单要扫 message/part 表，别读两遍）。
  // "这一层现在算不算在跑"也直接由它推出（有没有 outcome==='running' 的轮）——
  // 收工窗口只留在 kilo.js 一处（ROUND_IDLE_MS），这里不再自己算时间窗。
  const roundsOf = new Map();
  const runsOf = new Map();
  for (const s of sessions) {
    roundsOf.set(s.id, readKiloRounds(s.id));
    runsOf.set(s.id, repo.taskRunsOfSession.all(s.id || ''));
  }
  const isActiveOf = (s) => (roundsOf.get(s.id) || []).some((r) => r.outcome === 'running');

  /** 插件给这条会话写的那些行（服务端发的 `k_*`）各自报的轮次起点；没写过 → [] */
  const pluginStartsOf = (s) =>
    runsOf.get(s.id).filter((r) => !String(r.id).startsWith(TASK_ID_PREFIX)).map((r) => Number(r.started_at || 0));

  /** 插件**为这一轮**写过行没有：按轮次起点对齐（容许 PLUGIN_COVER_MS 的误差，理由见常量） */
  const coveredBy = (starts, at) => starts.some((p) => Math.abs(p - Number(at || 0)) <= PLUGIN_COVER_MS);

  /**
   * 这条会话是不是已经有**插件写的**行了（插件写的是服务端发的 `k_*`，轮询写的是 `kilo:*`）——
   * 有就整条让位。判据用 id 前缀而不是 client，因为这里要问的是"这行是不是我写的"（见下面循环）。
   *
   * **让位只在插件还在报的时候成立**（2026-09-30 修：用户实测一轮任务在列表里凭空消失）。
   * "这条会话有插件行"只证明它**曾经**在报 —— 插件跟着 agent 进程活，通道断了它自己不知道，
   * 也什么都发不出去。实测那一回：Kilo CLI 进程 11:00 起（那个进程里的插件还没有"重读
   * server.json"那版），WorkGremlin 11:29 重启换了随机 token（server/src/config.js 每次启动
   * 随机生成）→ 从那以后这个进程的每条上报都 401，而且**完全无声**：状态文件照写
   * （所以相位/状态正常显示）、台账一条不来。于是 12:46 与 12:48 用户跑的两轮，
   * 插件写不了、轮询又整条让位 → **两条任务都查不到**（用户报的"状态有，但看不到任务"）。
   *
   * 所以让位的判据改成"插件**这一轮**也写了没有"：它最新那一行落在源里最新这一轮起点之后
   * （容许 PLUGIN_COVER_MS 的误差）→ 让位；否则这一轮刚起就再等 PLUGIN_GRACE_MS（本地回环，
   * 正常 1 秒内落库），过了还不见它的行 → 认定通道断了，把这条会话收回来（补记见 ②b）。
   * 插件活着时每轮开跑就写一条，所以正常情况下这条永远不命中；万一它只是慢了（注册重试中），
   * 等它写上来那一刻让位又成立 —— 轮询自己写的行会被收掉（见下面循环里的让位分支），自愈。
   * 宽限期**从这一轮的起点算**（不是"插件沉默多久"）：插件两轮之间本来就不写东西，沉默是常态。
   */
  const yieldsOf = (s) => {
    const starts = pluginStartsOf(s);
    if (!starts.length) return false;
    const rounds = roundsOf.get(s.id) || [];
    const last = rounds[rounds.length - 1];
    const roundStart = last ? Number(last.startedAt || 0) : 0;
    // 比的是"最新那行是否落在这一轮起点之后"：插件那行可能比轮次起点早几十毫秒（实测 -87ms），
    // 也可能晚（它自己取 Date.now()，agent 忙的时候迟一会儿）—— 两边都要容，所以减一个 COVER。
    const newestTheirs = starts.reduce((m, p) => Math.max(m, p), 0);
    if (newestTheirs >= roundStart - PLUGIN_COVER_MS) return true;
    return now - roundStart <= PLUGIN_GRACE_MS;
  };

  /**
   * 让位给插件的那条会话，插件是不是**冒我们这个身份、而且现在正跑着**？
   * CLI 形态的插件（`kilo run`，没有 VS Code 环境变量）报的就是裸 `kilo` —— 同一个成员
   * `kilo@<工程>`，见 plugin/index.js 的 resolveClient；只有 VS Code 扩展起的才是 `kilo-plugin`。
   * 是的话这条工程的成员状态就先归插件写：轮询这一路连心跳都不碰 —— 否则 5s 一次轮询会把
   * 插件刚写的相位覆盖成轮询视角下的旧状态（agent_status 谁最后写谁赢），现场就是相位来回跳。
   * 只在那轮**还没收工**时让位（isActiveOf）：插件那条停下来了就把这一栏交回轮询，
   * 否则同工程另一条（没装插件的老会话）真在跑时永远拿不到心跳，被判成「已取消」。
   */
  const pluginOwnsMember = new Set();
  for (const s of sessions) {
    if (!yieldsOf(s) || !isActiveOf(s)) continue;
    if (runsOf.get(s.id).some((r) => String(r.client) === CLIENT)) pluginOwnsMember.add(projectIdOf(s));
  }

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
    // 让位的会话**不参与** owner 选择：它这一路根本不写心跳（见下面那个 continue），
    // 把它算进来就会让同工程另一条真在跑的会话永远选不上 owner ——
    // 那条任务在 agent_status 里找不到心跳，又被 query.js 的 CASE 判成「已取消」。
    // 实测 2026-09-30：插件那条会话一出现（它比老会话新），老会话的状态就冻在上一次
    // 写下的那一行上再也不刷新（成员卡心跳过期灰显、老会话里再开一轮就显示「已取消」）。
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

    // 装了 WorkGremlin 插件时，plugin 那一路上报的是**真值**：每轮用户任务一条，
    // 带 taskTitle（用户那句话）、form（形态）、result（收尾自述）、收工时间。
    // 轮询这一路只是"没装插件"时的兜底，不能跟它抢同一条会话 —— 抢的结果是同一个
    // 会话在任务列表里出现两行（轮询的会话级 + 插件的任务级），而且轮询那行每 5s
    // 还会把插件写的相位/成员状态覆盖回 thinking（收工了还显示"思考中"）。
    // 所以：这条会话已经有 plugin 行 → 整条跳过；自己上一轮抢在 plugin 前面写下的
    // 兜底行 → 收掉（只删自己前缀的 id，插件的行一根汗毛都不动）。
    // 判据是"这个会话已经有插件写的行了"，不是"有没有 client === kilo-plugin 的行"。
    // 插件写的 id 是 `k_*`，轮询写的是 `kilo:*` —— 用 id 前缀认，比认身份稳：
    // 身份是插件**上报**的，而这里要问的是"这行是不是我写的"。早先按 client 判，
    // 而插件那份的身份在修好之前根本不是 kilo-plugin（判出的是 kilo）→ 从不让位 →
    // 同一个会话轮询与插件各写各的，同一轮在任务列表里出现两行（2026-09-30 实测）。
    // runsOf 是上面读的那一份（那时还没写这一轮，所以下面 ③ 定稿不会误伤 lastId）
    const sessionRuns = runsOf.get(s.id);
    if (yieldsOf(s)) {
      for (const r of sessionRuns) if (String(r.id).startsWith(TASK_ID_PREFIX)) repo.deleteTaskRun(r.id);
      continue;
    }

    // ① 过渡期清扫：早先是"一条会话一行"，id 就是 `kilo:<会话id>`（没有轮序号）。
    // 让位那条路在上面自己就把这类行删了（它也带 `kilo:` 前缀）；走到这里的是没让位的会话，
    // 所以这一步必须在这里做 —— 否则那些没有用户轮的会话（Kilo 一启动就落一条空会话）
    // 会把自己那条旧台账永远留在列表里。
    if (repo.getTaskRun.get(prefix)) repo.deleteTaskRun(prefix);

    const rounds = roundsOf.get(s.id) || [];
    if (!rounds.length) continue; // 没有用户轮（一句话都没说过）的会话不算任务，不落台账
    // 轮序号 → 那一轮。**认 index 而不是数组下标**：id 里的序号是 kilo.js 落下的 `r.index`，
    // 两者平时相等，但拿 index 问"源里还有没有这一轮"才是准的（见下面 ③b）。
    const byIndex = new Map(rounds.map((r) => [r.index, r]));

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
      client: CLIENT,
    });

    // 改动文件：Kilo 存的是绝对路径，统一转工程相对；工程外的（`..`）不进这一栏
    const relFiles = (list) =>
      (list || [])
        .map((abs) => {
          const p = String(abs || '');
          if (!p || !projectPath) return p;
          const r = path.relative(projectPath, p);
          return r && !r.startsWith('..') ? r : '';
        })
        .filter(Boolean);

    // ② 只写**最后一轮**：正在飞的那轮（state=running、ended_at=null），
    // 或它收工后留下的那轮。标题优先用**这一轮用户说的话**（和其它楼层「标题 = 用户那句话」
    // 同一口径）；取不到才退回会话标题 —— Kilo 的会话标题只在一轮开始时定一次，
    // 同一会话里再跑任务不会变，拿它当标题用户会以为"新任务没记上"。
    const last = rounds[rounds.length - 1];
    const running = last.outcome === 'running';
    const lastId = `${prefix}:${last.index}`;
    const filesJson = writeTurnRun(repo, {
      id: lastId,
      projectId,
      memberId,
      sessionId: s.id || null,
      model: s.model || '',
      title: last.prompt || s.title || '(Kilo 会话)',
      startedAt: last.startedAt || now,
      endedAt: last.endedAt || null,
      state: last.outcome,
      files: relFiles(last.files),
      result: last.endedAt ? last.result || '' : '',
      tokens: last.tokens,
    });
    count += 1;

    // ②b 从插件手里收回来时（它的通道断了，见 yieldsOf），把它断线期间漏掉的轮次补上：
    // 判据是"这一轮插件没报过"（按轮次起点对齐，见 coveredBy）—— 它报过的轮次轮询不回溯
    // （见文件头"只记当前这一轮"）；只有这里补，因为这是"本该有行、却一直没等到"的那几轮。
    // 已经写过行的（含上面刚写的最后一轮、以及插件亲手写的那几行）不动一根汗毛。
    const starts = pluginStartsOf(s);
    if (starts.length) {
      for (const r of rounds.slice(0, -1)) {
        if (coveredBy(starts, r.startedAt)) continue;
        const rid = `${prefix}:${r.index}`;
        if (sessionRuns.some((x) => String(x.id) === rid)) continue;
        writeTurnRun(repo, {
          id: rid,
          projectId,
          memberId,
          sessionId: s.id || null,
          model: s.model || '',
          title: r.prompt || s.title || '(Kilo 会话)',
          startedAt: r.startedAt || now,
          endedAt: r.endedAt || null,
          state: r.outcome,
          files: relFiles(r.files),
          result: r.endedAt ? r.result || '' : '',
          tokens: r.tokens,
        });
        count += 1;
      }
    }

    // ③ 定稿上一轮：上一轮在我们这儿是 running，现在后面已经开了新的一轮 ——
    // 用它的真实收工时刻/结果把那一行补成 done / cancelled。
    // 不做这一步，它会永远停在 'running'，被 query.js 的 CASE 判成「已取消」。
    // sessionRuns 是上面写最后一条**之前**读的，所以不含 lastId，不会误伤。
    for (const r of sessionRuns) {
      const idx = roundIndexOf(r.id, prefix);
      if (idx === null || idx >= last.index) continue;
      const old = byIndex.get(idx);
      if (!old) continue;
      writeTurnRun(repo, {
        id: r.id,
        projectId,
        memberId,
        sessionId: s.id || null,
        model: s.model || '',
        title: old.prompt || s.title || '(Kilo 会话)',
        startedAt: old.startedAt || now,
        endedAt: old.endedAt || null,
        state: old.outcome,
        files: relFiles(old.files),
        result: old.endedAt ? old.result || '' : '',
        tokens: old.tokens,
      });
      count += 1;
    }

    // ③b 收掉"源里已经没有"的那几轮：轮次表缩短时（Kilo 清了消息 / 压过上下文），
    // 那几行永远等不到自己的轮 —— 一直挂着 'running'，被 query.js 的 CASE 判成「已取消」，
    // 在列表里当一条假任务躺着（老口径"一条会话一行"自己会盖掉，改成一轮一条之后不会了）。
    // 判据是**这一轮还在不在源里**（byIndex），不是"序号比最后一轮小"—— 中间那几轮被删掉时
    // 序号照样对得上，只有按 index 问才问得准。
    // `rounds` 整个读空的情况上面已经 continue 了（不在这里删）：库改版读不出来时
    // （见 kiloFloor 的 D1 用例）宁可留旧行，也不拿"读不出来"当"源里没有"把历史删掉。
    for (const r of sessionRuns) {
      const idx = roundIndexOf(r.id, prefix);
      if (idx === null || byIndex.has(idx)) continue;
      repo.deleteTaskRun(r.id);
    }

    // ④ 心跳：活跃 → thinking，停下 → idle；task_id 必须指向**最后一轮**那条，
    // 否则 query.js 的 CASE 找不到心跳，会把正在跑的那条判成「已取消」。
    // 和 copilotTasks 同理：只在活跃时写 thinking，会话停掉后旧值会一直挂在库里，
    // 成员卡永远「思考中」。非活跃时补一条 idle，让状态跟着会话走。
    // 另外：**只由这个工程选中的那条会话写**（见上面 activeByProject 的说明），
    // 否则同工程别的会话会把心跳指到自己的任务上，运行中的那条被判成「已取消」。
    // 插件正冒我们这个身份在报、且那轮还没收工 → 这一栏整个让给它（见 pluginOwnsMember）。
    const owner = pluginOwnsMember.has(projectId)
      ? null
      : activeByProject.get(projectId) || newestByProject.get(projectId);
    if (owner === s) {
      repo.upsertStatus.run({
        memberId,
        state: running ? 'thinking' : 'idle',
        stateSince: running ? last.startedAt || now : now,
        taskId: lastId,
        progress: null,
        currentFiles: filesJson,
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
