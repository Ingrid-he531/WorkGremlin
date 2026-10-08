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
const { detectLevel, agentDescription } = require('./agentLevel');
// 成员状态降级前的守卫：别的会话还在跑就别压成空闲/离线（见 keepStateForOtherSession）。
// 只单向依赖（sessions.js 不 require ingest/），没有循环。
const { hasOtherLiveSession, sessionModel } = require('../sessions');

function projectIdOf(name) {
  return name;
}

function memberIdOf(project, name) {
  return String(name).includes('@') ? name : `${name}@${project}`;
}

/**
 * 来源客户端白名单（办公室按楼层的客户端过滤；不认识的值一律当"不知道"= NULL）。
 * 合同见 hook 的 eventClient：非 plugin 直接返回 agent（codebuddy / codex / trae / …），
 * plugin 返回 agent + '-plugin'（codebuddy-plugin / codex-plugin / trae-plugin）。
 * 因此白名单同时认 base 与 base-plugin 两种形态；新加的产品补进 CLIENT_BASES 即可。
 *
 * **漏一个产品 = 它的成员 client 变 NULL，而"空 client 视作通用、哪层都显示"**
 * （见 renderer/src/lib/clientMatch.js 的 floorAcceptsClient）—— 于是这个产品的成员会
 * 出现在**每一个**楼层里。实测 2026-09-27：6F Qoder / 7F Kilo / 8F OpenCode 都不在名单里，
 * qoder 那一行于是飘进了 1F 的工位卡片（members 表实测 client IS NULL）。
 * 加楼层（products.js）时**必须**同步这里，别只改一半。
 */
const CLIENT_BASES = ['codebuddy', 'workbuddy', 'codex', 'claude', 'trae', 'qoder', 'kilo', 'opencode', 'copilot', 'opencode-plugin'];
const CLIENTS = new Set([...CLIENT_BASES, ...CLIENT_BASES.map((b) => `${b}-plugin`)]);
function normClient(v) {
  const c = String(v || '').trim().toLowerCase();
  return CLIENTS.has(c) ? c : null;
}

/**
 * 这一轮走的**形态**：'cli' / 'plugin'（IDE 扩展）。
 * 分不出的产品（Claude / Qoder…）与老数据留 NULL —— 任务列表退回只写产品名（如 "Codex"）。
 */
function normForm(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'cli' || s === 'plugin' ? s : null;
}

/** 模型名：拿不到就是 NULL（绝不猜），超长截断 */
function normModel(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, 64) : null;
}

/**
 * 会话 id（轴 2）：hook 的 payload `session_id` / 插件会话 id。
 * 拿不到就是 NULL —— 「没带会话标识」和「会话叫空串」是两回事，前者是合法的老数据形态。
 * 超长截断（128）纯属防御：真值是 UUID，插件侧可能是别的形式。
 */
function normSession(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, 128) : null;
}

/** 任务 id：拿不到就是 NULL（同 normSession 的口径，绝不猜） */
function normTaskId(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, 128) : null;
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

/** 一个 token 计数：非负整数才认（浮点四舍五入、负数与非有限值一律当"没报"） */
function normCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * 收工带上来的 token（`{input, output, cacheRead, cacheWrite}`，语义见 schema.sql 的注释）。
 * 整块没带 / 某一项读不出 → 该项 NULL：报表留空显示 "—"，**不拿 0 冒充**"消耗为零"。
 * 取不到的楼层（5F TraeCode 无 usage、6F Qoder transcript 里没有、9F Copilot 没接）
 * 本来就整块不发，反正留空。
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
   * 这一条上报该归到哪个**工程**（id）。
   *
   * 上报里的 `project` 历史上取的是"办公室**当前打开**的那个工程"（hook 的 resolveCtx 从
   * `/api/v1/workspace` 拿），而 `workspacePath` 是上报方**自己真实所在的目录**。
   * "办公室开着 A、我在 B 里跑 CLI"的时候两者对不上：任务被归到 A。
   * 实测 2026-09-29：在 /home/yinghui/work/stb-insight 里跑的 codex 任务，任务列表里挂在
   * workgremlin 名下（办公室视图里那条会话的工程名却是对的 —— 会话走的是 rollout 的 cwd）。
   *
   * 所以**以 workspacePath 为准**：
   *   1) 按这个路径能找到已有工程 → 用它的 id（与办公室"打开工程"落的行是同一行）；
   *   2) 找不到 → 按这个目录算名字（package.json name > 目录名，与 server/src/project.js 同口径）
   *      并建一条；
   *   3) 没带 workspacePath（老上报 / 手工脚本）→ 退回 `project` 字段，行为不变。
   * @param {string} reportedProject 上报里的 project（办公室当前工程名，仅作兜底）
   * @param {string} workspacePath 上报方真实所在目录
   * @returns {string} 工程 id（空串 = 两边都没给，调用方按 missing project 处理）
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
    /**
     * 这条会话**自己**还没收工的那条任务（没有 → null）。
     *
     * 心跳是"这条会话还活着"最直接的证据，而槽位（`agent_status.task_id`）是**一行一成员、
     * 只有一个**：同产品的两条会话同时在跑时，槽位归"最后一个 `/task/start` 的会话"。先收工的
     * 那条会话 `/task/end` 时，因为"别的会话还活着"整块跳过这次状态写入（见
     * keepStateForOtherSession）—— 槽位就停在**它自己已经结束的**任务上，**还在跑**的那条在
     * `/task-runs` 的存活判定里找不到匹配行，于是显示「已取消」。实测 2026-09-30 14:03 的
     * Kilo CLI（两条会话：13:58 那条一直显示已取消，槽位指着 14:03 那条已经结束的）。
     *
     * 所以心跳顺带**认领**槽位：带 taskId 的上报仍以 taskId 为准（优先级 1，见 nextTaskSlot），
     * 没带就写自己这条在飞的任务。它也是这套判定的自愈口 —— 槽位因为任何原因指歪了，
     * 下一次心跳就掰回来，不必等新任务开始。
     */
    const mine = liveTaskOf(project, id, p.sessionId);
    const state = AGENT_STATES.includes(p.state)
      ? p.state
      : // 认领到在飞任务、槽位却挂在 idle/offline 上 = "任务在跑、成员空闲"，存活判定照样
        // 看不见它（判据要求 busy/thinking/blocked）→ 一起抬成 busy。只抬这两种，别的照旧。
        mine && prev && (prev.state === 'idle' || prev.state === 'offline')
        ? 'busy'
        : prev
          ? prev.state
          : 'online';

    repo.upsertStatus.run({
      memberId: id,
      state,
      stateSince: ts,
      taskId: p.taskId ?? mine ?? (prev ? prev.task_id : null),
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
   * 这条会话要把成员状态往下压（空闲 / 离线）时，同产品的**别的会话**是不是还在跑。
   *
   * `agent_status` 是按成员一行存的，没有会话维度：同一个 Claude Code 开着 A / B 两条会话，
   * A 收工（Stop → idle）或退出（SessionEnd → offline）会去写那唯一一行，B 还在干活却显示「离线」。
   * 所以降级前先问 sessions.js 的 hasOtherLiveSession：还有别的会话活着就**整块跳过这次状态写入**
   * （连 taskId / currentFiles 一起留着 —— 那是还在跑的那条会话的，清掉等于把它的卡也擦干净）。
   *
   * 不拦**升级**（busy / thinking / blocked / online）：那不会造成"还在干活却显示离线"。
   * 也不拦没有会话标识的上报（老 hook / 别的产品）→ 行为与改动前完全一致。
   * @param {string} state 本次想写的状态
   * @param {any} member 服务端的成员行（client 从它取）
   * @param {any} p 上报体
   */
  function keepStateForOtherSession(state, member, p) {
    if (state !== 'idle' && state !== 'offline') return false;
    if (!p.sessionId) return false;
    try {
      return hasOtherLiveSession({
        workspacePath: p.workspacePath || '',
        client: member.client || normClient(p.client) || '',
        session: String(p.sessionId),
      });
    } catch {
      return false; // 读盘失败就当没有 —— 宁可降级，也不要因为守卫报错把状态卡死
    }
  }

  /**
   * 成员行上挂的那个 task，是不是**本次上报这条会话**的（轴 2）。
   *
   * 为什么需要判：`agent_status` 是**一行一成员**、只有一个 task_id 槽位，同产品的多条会话
   * 共用它。不判的话，槽位归"最后调 startTask 的那条会话"占着 —— 实测的后果是状态**正好反了**：
   * 已退出的那条会话的任务在报表里显示「进行中」（成员行的 task_id 指着它、心跳又由活着的
   * 那条会话刷着，`/task-runs` 的存活判定就认为它还在跑），而**正在干活**的那条显示「已取消」
   * （成员行的 task_id 不指向它，存活判定找不到匹配行）。
   *
   * 归属靠 `task_runs.session_id`（轴 2 新加的列）。
   * @returns {boolean|null} true=是它的 / false=不是它的 / null=判不了（查不到这一行，或两边有一边没会话标识）
   */
  function taskOwnedBy(taskId, sessionId) {
    const sid = normSession(sessionId);
    if (!taskId || !sid) return null;
    try {
      const run = repo.getTaskRun.get(taskId);
      const owner = run && normSession(run.session_id);
      if (!owner) return null; // 老数据（加 session_id 之前的任务）→ 判不了，维持老行为
      return owner === sid;
    } catch {
      return null;
    }
  }

  /**
   * 决定这次 `/status` 之后，成员行的 task_id 槽位该写谁。
   *
   * 优先级：
   *   1. 上报体**带了个真 taskId**（新 hook 干活时每次都带）→ 以它为准。
   *      这条会话就此认领槽位，报表的存活判定才能把**它自己**的任务认成在跑。
   *   2. **显式 null**（新 hook 收工时带）= "我这边没任务了" → 只清**自己**占的槽位：
   *      槽位是空的、或本来就是我的、或归属判不出来 → 清掉；
   *      槽位被**别的会话**占着 → 留着，别把人家还在跑的任务擦掉（A 收工不能把 B 的任务抹了）。
   *   3. 没带这个字段（老 hook / mock / 别的产品）→ 沿用 prev；但**若 prev 的 task 属于别的
   *      会话**就清空 —— 那条会话已经不往这儿写状态了，还把它挂在成员行上，会让一个早已结束的
   *      任务因为"心跳不断"而被判成「进行中」。
   *   4. 归属判不了（加 session_id 之前的老数据）→ 沿用 prev，与改动前完全一致。
   *
   * 注意判的是 `hasOwnProperty` 而不是真值：省略与显式 `null` 是两件事。
   * @param {any} prev agent_status 里现有那一行（可能不存在）
   * @param {any} p 上报体
   * @returns {string|null}
   */
  /**
   * 台账里**还没收工**的那条任务是哪条 —— 心跳与收工据此决定成员行的 task_id 槽位。
   *
   * 给了 `sessionId` 就只看这条会话名下的（心跳用：会话自己的在飞任务最准，见 heartbeat）；
   * 没给就看本成员最新的那条（收工往外交接用，见 endTask）。查不到 / 读库报错都回 null：
   * 宁可不动槽位，也不能让上报因为这里报错被打挂。
   */
  function liveTaskOf(project, memberId, sessionId) {
    try {
      const args = { projectId: project, memberId };
      const sid = normSession(sessionId);
      const row = sid ? repo.liveTaskOfSession.get({ ...args, sessionId: sid }) : repo.liveTaskOfMember.get(args);
      return row ? row.id : null;
    } catch {
      return null;
    }
  }

  function nextTaskSlot(prev, p) {
    const prevTask = prev ? prev.task_id : null;
    const own = prevTask ? taskOwnedBy(prevTask, p.sessionId) : null;
    if (!Object.prototype.hasOwnProperty.call(p, 'taskId')) {
      return own === false ? null : prevTask;
    }
    const want = normTaskId(p.taskId);
    if (want) return want;
    if (!prevTask) return null;
    return own === false ? prevTask : null;
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
    // 别的会话还在跑 → 别把成员整体压成空闲/离线
    if (keepStateForOtherSession(state, member, p)) {
      return { ok: true, skipped: 'other_session_live', card: buildMemberCard(id) };
    }

    repo.upsertStatus.run({
      memberId: id,
      state,
      stateSince: ts,
      taskId: nextTaskSlot(prev, p),
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
      const client0 = member.client || normClient(p.client) || null;
      repo.upsertTaskRun.run({
        id,
        projectId: project,
        memberId: member.id,
        client: client0,
        sessionId: normSession(p.sessionId),
        form: normForm(p.form),
        // hook payload 里没有模型字段的产品（TraeCode 六个事件都不带、Claude Code 除
        // SessionStart 外也都不带），为空时按会话去**各自的落盘**里取当前模型
        // （见 sessions.sessionModel：traeModels / claudeModels 两个适配器）。
        // 取不到就是空 —— 报表的"模型"列留空，不拿默认模型冒充。
        model: normModel(p.model) || sessionModel(client0, p.sessionId) || null,
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
    const prev = repo.getStatus.get(member.id);
    // 收工要把成员压回 idle；但同产品的别的会话还在跑时不能压（否则 B 干着活、卡片显示空闲，
    // 而且 taskId / currentFiles 会被清空、把 B 的任务卡一起擦掉）。见 keepStateForOtherSession。
    if (!keepStateForOtherSession('idle', member, p)) {
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
    } else {
      /**
       * 还有别的会话在跑 → 不压 idle，但槽位**不能就这么留着**。
       *
       * 槽位只有一个、归"最后一个 `/task/start` 的会话"：这次收工的会话如果正是那个（同产品两条
       * 会话同时在跑时就是如此），槽位会停在**它自己已经结束的**任务上 —— 还在跑的那条在
       * `/task-runs` 的存活判定里找不到匹配行，显示「已取消」（实测 2026-09-30 14:03 Kilo CLI：
       * 13:58 起的那条整轮显示已取消，槽位指着 14:03 那条刚结束的）。原来的写法整块跳过这次写入
       * （本意是保住"还在跑的那条会话"的 taskId/currentFiles），但那个前提不成立：槽位里的
       * taskId 是**收工这条**的，不是还在跑那条的。
       *
       * 所以按台账把槽位**交接**给本成员还没收工的最新那条任务；台账里一条都没有（别的会话只在
       * hook 状态文件里活着、还没写台账）→ 清空槽位，宁可空着也不要指错。
       *
       * state 一般保持原样（那条会话的相位由它自己的心跳写，这里不越权改）；只有交接成功、
       * 而槽位挂在 idle/offline 上时才抬成 busy —— 与 heartbeat 的认领同一条理由：
       * "任务在跑、成员空闲"在 `/task-runs` 的存活判定里照样看不见。
       */
      const next = liveTaskOf(project, member.id, '');
      repo.upsertStatus.run({
        memberId: member.id,
        state: next && prev && (prev.state === 'idle' || prev.state === 'offline') ? 'busy' : prev ? prev.state : 'busy',
        stateSince: prev ? prev.state_since : ts,
        taskId: next,
        progress: prev ? prev.progress : null,
        currentFiles: prev ? prev.current_files : null,
        lastHeartbeatAt: ts,
        degraded: 0,
        source: 'report',
        updatedAt: ts,
      });
    }
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
      // 模型靠**落盘**取的产品（Claude Code / TraeCode）在这儿补一刀：开轮时 transcript 里还
      // 没有本轮的 assistant 行，读到的是上一轮的模型（会话第一轮则一条都没有、直接为空），
      // 收尾时再按会话取一次就能拿到本轮真实的那个。见 sessions.sessionModel。
      const endClient = (run && run.client) || member.client || normClient(p.client) || null;
      const endSession = (run && run.session_id) || normSession(p.sessionId);
      // 但**只在行上还没有模型时才回填**：endTaskRun 是 `model = COALESCE(@model, model)`，
      // COALESCE 挡的是 null、不挡非空值 —— 无脑回填会把别的楼层开轮时取到的模型改写成
      // 收尾时重取的另一个值（轮中途换过模型的话就是两个值），那是偷偷改别人楼层的历史。
      const refill = !run || !run.model ? normModel(sessionModel(endClient, endSession)) : null;
      const endModel = normModel(p.model) || refill;
      if (!run) {
        // 老 hook 或中途接上的：起点未知就别编，started_at 留 NULL、duration 也算不出来
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
        });
      }
      const startedAt = run ? Number(run.started_at) || null : null;
      const wsRow = repo.getProject.get(project);
      let reportedFiles = Array.isArray(p.files) ? p.files : [];
      // 兜底（bug 3）：hook 的状态文件被并发覆盖时 roundFiles 会变空 ——"修改的文件"整列空着。
      // file_activity 里本来就有本轮每一条 file/touch 的真值，用任务窗口回捞一次补上。
      if (!reportedFiles.length && startedAt) {
        const act = repo.listActivityInWindow.all(member.id, startedAt, ts, 50);
        // op 照 file_activity 里记的填（本库实测只有 'write'）。不认得的值留 null，
        // 绝不统一编造成 'edit' —— 那是把"新增"说成"改动"，正踩「绝不编造」那条纪律。
        // 删除类文件根本不进这张表，所以回捞这条路本来就拿不到删除项，认了就是。
        if (act.length) reportedFiles = act.map((f) => ({ path: f.path, op: f.op === 'write' ? 'write' : null }));
      }
      const filesJson = enrichFiles(wsRow ? wsRow.workspace_path : '', reportedFiles);
      const fileCount = reportedFiles.length
        ? reportedFiles.length
        : Number.isFinite(Number(p.fileCount))
          ? Number(p.fileCount)
          : null;
      // 标题兜底：开轮时 prompt 没取到（CLI 这个客户端有时不带上 prompt 文本），
      // startTask 会落成「(未命名任务)」。收工时若还是这个默认值 / 空，就用本轮改动的文件
      // 派生一个有意义、不编造的标题（取首个改动文件的路径），至少能跟别轮区分开。
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
        endedAt: ts,
        durationMs: startedAt && ts > startedAt ? ts - startedAt : null,
      });
      /* 本轮消耗的 token：hook / 插件从会话落盘里读出来的真值
         （见 reporter/src/usage.js 与 plugin/index.js）。
         取不到就是 NULL —— 这一列空着表示"这个楼层报不出来"，与"消耗为 0"是两回事。

         **整块没带就不动这一行已有的值**（不是写 NULL）：同一个 taskId 可能被收工两次
         （Stop 之后再来一刀 SessionEnd / 打断路径），后一刀读不出 usage 时若照着 NULL 写，
         会把前一刀落的真值擦掉 —— "没报"只该表示"这次没带数"，不该抹掉已经记下的数。
         全新的一行本来就是 NULL，所以"不动"与"留空"在这里是同一个结果。 */
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
    hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, buildMemberCard(member.id));
    // 幽灵收工时顺手刷同名常驻小怪物的卡：它这一轮的产出会被那张卡借去显示（见 ghostArtifacts）
    const heir = heirOf(member);
    if (heir) hub.broadcast(project, WS_EVENTS.MEMBER_STATUS, buildMemberCard(heir));
    return { ok: true };
  }

  /**
   * 收工**之后**补报这一轮的 token（只写 token 四列，别的字段一个都不动）。
   *
   * 为什么要单开这一条、而不是再调一次 endTask：endTask 会重写 result / files / ended_at
   * （`COALESCE` 挡不住显式的空字符串），补报时手上只有 token，一刀下去会把收工时落的
   * 产出摘要和文件清单抹掉。
   *
   * 为什么要补：CodeBuddy **插件**形态（VS Code 扩展）那条 request 的 usage 落盘比 Stop
   * 晚得多 —— 收工那一刻（甚至等 1.2s 之后）index.json 里它还是 `{state:'running'}`，
   * 没有 startedAt 也没有 usage（本机实测：0c1f… 会话第一轮 Stop 于 14:12:41，
   * 那条 request 直到第二轮开始之后才补上 usage）。所以收工时读不到真值不是"没数"，
   * 是"数还没落到盘上" —— 等它落了再补一刀才是真值。
   *
   * 定位不到（会话里没有"收工了但没数"的行 / 起点对不上）就原样返回 ok，
   * 一行都不写 —— 与"没数就是没数"同一条纪律：绝不写到别的轮次头上。
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
   * 回捞：某成员当前进行中的任务（bug 3 兜底）。
   *
   * 场景：hook 的状态文件是"读-改-写"的，CLI 同一毫秒并行触发多个 hook 进程时会互相覆盖，
   * taskId 被冲掉 → Stop 不发 task/end → 产出摘要 / 改动文件 / 结束时间整块丢，任务永远挂
   * running（实测 2026-09-27 的 13:14 / 13:18 / 13:29 三条 codebuddy 任务全部如此）。
   * 这里让 hook 按"本成员 + 本会话"回来问一次 —— 服务端 agent_status / tasks 里有真值。
   *
   * 保守口径：优先认**本会话**的那条；本会话对不上时，只有"全表只有一条且它没有会话标识"
   * （老数据 / 无会话上报）才认 —— 绝不把另一条会话正在跑的任务误收掉。
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
   * 这一轮任务里某个工具用了一次（任务详情里的「工具使用」）。
   *
   * 上报方（hook / 插件）每调用一次工具报一条，这里按 `(task_id, tool)` 累加计数 ——
   * 不给每次调用落一行（一轮里 Bash 能跑上百次，逐行落盘只会把库撑大）。
   *
   * 三条纪律：
   *   1) **没有 taskId 就不记**：任务详情是按任务看的，把"没任务的调用"挂到别人的
   *      任务头上属于编造归因；宁可少记。
   *   2) 没有工具名也不记（老版本 payload / 手工脚本）—— 一个空名计数没有意义。
   *   3) 幂等由上报方负责（同一支工具调一次报一次）；服务端只管累加，不猜、不折算。
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
      client: member.client || normClient(p.client) || null,
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

  /** 成员所属工程的落盘路径（项目级 agent 定义文件在这里找）；读不到回空串，只按用户级目录找 */
  function projectWorkspacePath(projectId) {
    const p = repo.getProject.get(projectId);
    return (p && p.workspace_path) || '';
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
    // 上一个任务在多久以前：最近一条**已收工**任务的收工时刻（渲染层的「最近活跃」用它）。
    // 不能拿 lastSeenAt 顶替 —— 那是心跳时刻，成员只要在线就一直刷新，永远显示"刚刚活跃"。
    const lastEnd = repo.lastTaskEndOfMember.get(memberId);

    return {
      memberId: m.id,
      name: m.name,
      role: m.role,
      // 没接上报且没状态行 -> offline；有状态行但 degraded -> 保持状态并标注推断
      state: s ? s.state : 'offline',
      stateSince: s ? s.state_since : m.created_at,
      // ended_at / state 一起带上：渲染层据此区分"当前任务"（还没收工）与"上一个任务"（已收工，
      // 槽位 agent_status.task_id 不会随收工清空，不区分就会在空闲时挂着旧任务 + 旧任务的已耗时）
      task: task
        ? {
            id: task.id,
            title: task.title,
            progress: task.progress,
            startedAt: task.started_at,
            endedAt: task.ended_at ?? null,
            state: task.state,
          }
        : null,
      currentFiles: files,
      artifacts,
      lastSeenAt: m.last_seen_at ?? m.created_at,
      lastTaskAt: lastEnd ? lastEnd.at : null,
      degraded: s ? Boolean(s.degraded) : true,
      reported: Boolean(m.reported),
      messageCount: cnt ? cnt.c : 0,
      // 临时成员（无工位 → 场景里飘着的幽灵）+ 所属项目名
      ephemeral: Boolean(m.ephemeral),
      projectLabel: m.project_label ?? null,
      // 所属工程 id：客户端据此把"别的工程的成员卡"挡在门外。
      // WS 订阅不带 project 时（渲染层就是这样，因为它只显示"当前打开的工程"），
      // 服务端会把**所有**工程的广播都送过来 —— 退出演示后 __demo__ 那批成员的心跳
      // 超时扫描仍会推它们的成员卡，客户端照单全收就会让演示小怪物在真实工程里闪回来
      // （2026-10-01 用户实测）。渲染层照这张卡上的 project 过滤，见 renderer/src/lib/projectScope.js。
      project: m.project_id,
      // 来源客户端：办公室据此按楼层过滤（NULL = 不知道，哪层都显示）
      client: m.client || null,
      // subagent 级别（用户级 / 项目级）：驱动小怪物脖子上的工牌配色
      level: levels.get(memberId) || null,
      // 常驻 subagent 的**功能描述**（agent 定义文件里的静态数据）：卡片上显示"它是干什么的"，
      // 不是状态。取不到回空串，由渲染层隐藏那一栏 —— 不拿"项目子代理 · 空闲"顶替。
      description: String(m.role || '').startsWith('subagent') ? agentDescription(m.name, projectWorkspacePath(m.project_id)) : '',
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
    projectForReport,
    currentMainTaskId,
    currentTaskFor,
    startSubagentRun,
    endSubagentRun,
    heartbeat,
    setStatus,
    startTask,
    taskProgress,
    endTask,
    backfillTaskTokens,
    recordMessage,
    fileTouch,
    toolUse,
    buildMemberCard,
    buildSnapshot,
    listProjectSummaries,
    sweepDegraded,
    toMessage,
  };
}

module.exports = { createIngestBus, projectIdOf, memberIdOf };
