'use strict';

/**
 * WorkGremlin 共享常量 / 协议 / 类型（运行时部分）。
 * 本文件必须保持**零运行时依赖**，同时被 Node（server/desktop）与浏览器（renderer）引用。
 * 类型声明见同目录 index.d.ts。
 */

/** v2：把 team 概念统一为 project（信封字段 team -> project）。 */
const PROTOCOL_VERSION = 2;

/** @type {ReadonlyArray<'online'|'busy'|'idle'|'blocked'|'offline'|'thinking'>} */
const AGENT_STATES = Object.freeze(['online', 'busy', 'idle', 'blocked', 'offline', 'thinking']);

/** @type {ReadonlyArray<'pending'|'running'|'done'|'failed'|'cancelled'>} */
const TASK_STATES = Object.freeze(['pending', 'running', 'done', 'failed', 'cancelled']);

/** @type {ReadonlyArray<string>} */
const MESSAGE_TYPES = Object.freeze([
  'task_assign',
  'task_update',
  'result',
  'question',
  'block',
  'review',
  'error',
  'shutdown',
  'heartbeat',
  'system',
]);

/** 数据来源：report=agent 主动上报（真值）；watch=目录监听兜底（推断）；timeout=心跳超时（推断） */
const SOURCES = Object.freeze(['report', 'watch', 'timeout']);

const DEFAULTS = Object.freeze({
  PORT_START: 21800,
  PORT_END: 21820,
  /** 超过该时长未收到上报心跳 -> degraded（灰显 + 标注"推断"） */
  HEARTBEAT_TIMEOUT_MS: 60_000,
  /** WS 断线后的 HTTP 轮询间隔 */
  DEGRADED_POLL_MS: 2_000,
  /** member.status 广播合并窗口 */
  STATUS_MERGE_MS: 200,
  /** M0 消息窗口上限（M2 换成虚拟滚动） */
  MESSAGE_WINDOW: 500,
  /** WAL 自动 checkpoint 页数（约 2MB） */
  WAL_AUTOCHECKPOINT_PAGES: 512,
  /** 主动 checkpoint 间隔 */
  WAL_CHECKPOINT_INTERVAL_MS: 30_000,
  /**
   * 任务记录默认保留天数（「自动保留最近 N 天」，用户 2026-10-01 要求 90）。
   * 只是**缺省值**：用户在界面上改过就以落库的 settings.retentionDays 为准（1~3650）。
   * 服务端/前端共用一个源 —— 这个数以前散在三处（服务端 fallback、PUT 的兜底、前端 ref
   * 的初值），改一处忘一处就会出现"界面显示 30、实际按 90 清"这种对不上的情况。
   */
  RETENTION_DAYS: 90,

  /**
   * 议事厅（Council Chamber）—— 选定几个楼层的 agent 讨论一个问题并达成一致。
   *
   * 这里只放**全局缺省**；每场会自己的设置（轮数 / 判定口径）落在 councils 行上，
   * 发起时按这里的缺省填，之后不随全局改动而变（一场已经开过的会不该被改口径）。
   */
  /**
   * 议事厅的两种形态（councils.mode）：
   *   'vote'     —— 就一份提案多轮表决，服务端机械计票判共识（见 council/consensus.js）
   *   'analysis' —— 不投票、不判共识：各轮自由分析，跑满轮数后出一份分组简报
   * 与「在哪儿谈」（councils.workspace_path 有没有值）是**两个正交的开关**。
   */
  COUNCIL_MODE_DEFAULT: 'vote',
  /** 讨论轮上限的缺省值（不含第 0 轮议题陈述） */
  COUNCIL_ROUNDS_DEFAULT: 3,
  /** 讨论轮上限的硬顶（用户在界面上调不上去） */
  COUNCIL_ROUNDS_MAX: 8,
  /**
   * 判定口径缺省值。取值见 server/src/council/consensus.js 的 THRESHOLDS：
   *   'unanimous' —— 无反对票 + 同意票过半（缺省，最保守：任何一个人不同意就不算谈成）
   *   'majority'  —— 少数服从多数（同意 > 反对）
   * 两种口径都要求**无人未表态**：缺席者的立场我们不知道，把不知道当默许就是编。
   */
  COUNCIL_THRESHOLD_DEFAULT: 'unanimous',
  /**
   * 单个参与者一轮的超时。到点**杀进程**并按「未表态」如实记 —— 这里的超时不是"再等等"，
   * 而是"这一票我们确定拿不到"。所以它按最慢的一层留足余量（一次回答要跑完一整个模型调用）。
   */
  COUNCIL_TURN_TIMEOUT_MS: 120_000,
  /**
   * **工程模式**（councils.workspace_path 有值）下单个参与者一轮的超时。
   *
   * 比隔离模式宽得多：隔离模式的参与者只是"动嘴"，而工程模式的参与者要自己用只读工具
   * 一轮轮翻代码（读文件 → 搜引用 → 再读），一次回答里可能夹着几十次工具调用。
   * 120s 对它是常态超时，不是异常 —— 那会把"它还在读"误记成"它没表态"。
   */
  COUNCIL_WORKSPACE_TURN_TIMEOUT_MS: 300_000,
  /**
   * 7F Kilo / 8F OpenCode 参与者的会话标题（`--title`），**也就是把它们挡在办公室外面的那把锁**。
   *
   * 为什么非有这么一个标记不可：这两家没有 1F/4F 那种 `--no-session-persistence`，
   * 会话一律记进**全局** SQLite（`session.directory` = 当时的 cwd）。隔离模式下 cwd 是
   * /tmp 里的一次性目录，办公室按工程过滤看不见它们；**工程模式下 cwd 就是用户的工程** ——
   * 不标记的话，参与者当场变成办公室 7F/8F 上多出来的一个"会话"，违反 requirements.md
   * §15.2「一场会开完，那两页看不出任何痕迹」。
   *
   * 数据目录也不能挪：实测 `XDG_DATA_HOME` 确实能把这些库挪走（Kilo 的 kilo.db 会落在新目录下），
   * 但**登录态跟着一起没了**（挪完再跑，Kilo 回 401「You need to sign in」、OpenCode 直接挂住），
   * 参与者会连话都说不出来。所以改成"照常落盘 + 打上固定标题"，
   * 由 server/src/kilo.js 与 server/src/opencode.js 在**列出会话时跳过这个标题**。
   *
   * 标题里带 WorkGremlin，是为了让用户在 Kilo / OpenCode 自己的会话历史里认得出这是谁留下的。
   */
  COUNCIL_SESSION_TITLE: '议事厅参与者（WorkGremlin）',
  /** 单个内联材料文件的字节上限；超出的部分截断，并在界面标注「已截断」 */
  COUNCIL_MATERIAL_MAX_BYTES: 64 * 1024,
  /** 全部内联材料的字节上限（提示词要塞进 argv / stdin，不能无限长） */
  COUNCIL_MATERIAL_TOTAL_MAX_BYTES: 200 * 1024,
});

/** 服务端 -> 客户端 */
const WS_EVENTS = Object.freeze({
  SNAPSHOT: 'snapshot',
  MEMBER_STATUS: 'member.status',
  MEMBER_REMOVE: 'member.remove',
  TASK_UPDATE: 'task.update',
  MESSAGE_NEW: 'message.new',
  MESSAGES_PAGE: 'messages.page',
  FILE_ACTIVITY: 'file.activity',
  ARTIFACT_NEW: 'artifact.new',
  CONNECTION: 'connection',
  ERROR: 'error',
  /** 全局活跃会话表变化（开/关工程·会话）：服务端按变化实时推送，客户端即时刷新 */
  SESSIONS: 'sessions',
  /**
   * 议事厅的增量更新（一场会的状态 / 某人的发言 / 本轮票型 / 收尾结论）。
   * 议事厅与「当前工程」「当前楼层」都无关（它是一场独立发起的会），所以广播时 project 传 null。
   * payload 是**增量**，客户端按 councilId 归位，见 server/src/council/orchestrator.js。
   */
  COUNCIL: 'council.update',
});

/** 客户端 -> 服务端 */
const CLIENT_EVENTS = Object.freeze({
  HELLO: 'hello',
  SUBSCRIBE: 'subscribe',
  PING: 'ping',
  BACKFILL: 'backfill',
});

const HTTP_ROUTES = Object.freeze({
  HEALTH: '/api/v1/health',
  SNAPSHOT: '/api/v1/snapshot',
  MESSAGES: '/api/v1/messages',
  PROJECTS: '/api/v1/projects',
  REGISTER: '/api/v1/register',
  HEARTBEAT: '/api/v1/heartbeat',
  TASK_START: '/api/v1/task/start',
  TASK_PROGRESS: '/api/v1/task/progress',
  TASK_END: '/api/v1/task/end',
  // 收工兜底（bug 3）：状态文件被并发覆盖丢了 taskId 时，hook 按会话回捞"当前在跑的任务"
  TASK_CURRENT: '/api/v1/task/current',
  STATUS: '/api/v1/status',
  MESSAGE: '/api/v1/message',
  FILE_TOUCH: '/api/v1/file/touch',
  // 工具使用计数：一轮任务里某个工具又用了一次（任务详情的「工具使用」）
  TOOL_USE: '/api/v1/tool/use',
});

const ERROR_CODES = Object.freeze({
  BAD_PAYLOAD: 'bad_payload',
  BAD_TOKEN: 'bad_token',
  UNKNOWN_MEMBER: 'unknown_member',
  UNKNOWN_PROJECT: 'unknown_project',
  DUPLICATE: 'duplicate',
  INTERNAL: 'internal',
});

/**
 * 构造协议信封。
 * @param {string} type
 * @param {string} project 工程标识
 * @param {string} actor
 * @param {unknown} payload
 * @param {number} [ts]
 */
function envelope(type, project, actor, payload, ts = Date.now()) {
  return { v: PROTOCOL_VERSION, type, ts, project, actor, payload };
}

/**
 * 32 位 FNV-1a（同构实现，避免在浏览器里依赖 node:crypto）。
 * @param {string} str
 * @returns {string} 8 位十六进制
 */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 消息去重键。A/B 两条来源写入同一张表时用它做幂等。
 * @param {{project: string, from: string, to?: string|null, ts: number, content?: string}} m
 * @returns {string}
 */
function dedupeKey(m) {
  const base = [m.project, m.from, m.to ?? '', String(m.ts ?? ''), m.content ?? ''].join('\u0001');
  return `${fnv1a32(base)}${fnv1a32(`${base}\u0002`)}`;
}

/**
 * 毫秒时长的人类可读形式（用于"已耗时"）。
 * @param {number} ms
 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * 绝对时刻 `MM-DD HH:mm`（用于「开始 / 最近活跃」这类时间点）。
 *
 * 为什么不用相对时长（"53m前"）：那要求界面每秒重算，而重算一旦断了，就会出现
 * "1F 的最近活跃不动、3F 的已耗时还在涨"这种同一屏两种行为（用户 2026-09-30 实测）。
 * 时间点写死不动，既不需要定时器，也不会有"谁没刷新"的问题。秒级不要 —— 那是给相对时长看的。
 * @param {number} ms
 */
function formatClock(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 状态 -> 中文标签 */
const STATE_LABELS = Object.freeze({
  online: '在线',
  busy: '忙碌',
  idle: '空闲',
  blocked: '阻塞',
  offline: '离线',
});

/** 状态 -> 主题色（与 renderer/src/styles/theme.css 保持一致） */
const STATE_COLORS = Object.freeze({
  online: 'var(--state-online)',
  busy: 'var(--state-busy)',
  idle: 'var(--state-idle)',
  blocked: 'var(--state-blocked)',
  offline: 'var(--state-offline)',
});

/**
 * 角色形象（SVG Gremlin）：身体/角配色 + 手持配饰。
 * key 用成员名（leader / researcher / coder / tester ...），未命中走 AVATAR_FALLBACK。
 */
const AVATARS = Object.freeze({
  leader: { label: '队长', body: '#f2a33c', horn: '#ffd27a', prop: 'megaphone' },
  researcher: { label: '研究员', body: '#4aa3ff', horn: '#a8d3ff', prop: 'magnifier' },
  coder: { label: '工程师', body: '#2fbf71', horn: '#9be7bd', prop: 'keyboard' },
  tester: { label: '测试员', body: '#a97bff', horn: '#d5c2ff', prop: 'shield' },
  reviewer: { label: '评审员', body: '#ff7ab6', horn: '#ffc4de', prop: 'clipboard' },
  ops: { label: '运维', body: '#7f8c9b', horn: '#c2cad6', prop: 'wrench' },
  system: { label: '系统', body: '#5c6675', horn: '#9aa3b2', prop: 'none' },
});

const AVATAR_FALLBACK = Object.freeze({
  label: '成员',
  body: '#6f8fb5',
  horn: '#bcd0e6',
  prop: 'none',
});

/**
 * 取成员形象配置。memberId 形如 `coder@workgremlin`，按 `@` 前的名字匹配。
 * @param {string} name
 */
function avatarOf(name) {
  const key = String(name || '')
    .split('@')[0]
    .toLowerCase();
  return AVATARS[key] || AVATAR_FALLBACK;
}

/* ------------------------------------------------------------------ *
 * 临时成员（幽灵）
 *
 * 专家团队是常驻成员，一人一个工位；为某个项目临时组队拉进来的成员
 * 没有工位，在场景里以"幽灵"形态飘在空中。
 *
 * 判定规则属于展示层（见 renderer/src/lib/ephemeral.js）：
 *   ephemeral === true > memberId 前缀 ghost- / tmp- > role === 'ghost'。
 * 这里只声明数据契约字段，供将来 server 直接下发。
 * ------------------------------------------------------------------ */


/** 主进程 <-> 渲染层 IPC 通道（与 WS_EVENTS 同款约定，集中管理避免拼写漂移导致静默断链） */
const IPC_EVENTS = Object.freeze({
  GET_SERVER_INFO: 'workgremlin:get-server-info',
  GET_APP_VERSION: 'workgremlin:get-app-version',
  CHOOSE_WORKSPACE: 'workgremlin:choose-workspace',
  SET_FULL_SCREEN: 'workgremlin:set-full-screen',
  IS_FULL_SCREEN: 'workgremlin:is-full-screen',
  FULL_SCREEN_EVENT: 'workgremlin:full-screen',
  EVENT: 'workgremlin:event',
});

/**
 * 智能体（agent）与客户端（client）的关系：client = agent，或 agent + '-plugin'。
 * 这是全局唯一合同（hook 的 eventClient 据此产出 client 字段，server/前端据此归层）。
 *   - agent（基名）：codebuddy / workbuddy / codex / claude / trae / qoder / kilo …
 *                  （见 server/src/products.js 的楼层定义）
 *   - client（上报身份）：非 plugin 直接是 agent；plugin 是 agent + '-plugin'。
 * 合同只有这两条形状，**这里不写"哪个 client 在哪层"**：楼层编号、哪两个形态合成一层，都是
 * server/src/products.js 的事（前端读 /api/v1/sessions 的 floors[].clients，不自己推）。
 * 一个楼层可以接纳多个 client —— 例如 CodeBuddy 的 CLI（codebuddy）与 Plugin
 * （codebuddy-plugin）同属一个楼层，TraeCode 的 IDE（trae）与插件（trae-plugin）也是；
 * 也可以只有一个：**claude 没有 plugin 形态**（client=claude），它的 CLI 与 IDE 插件共用
 * 同一份 ~/.claude 配置、同一套 hook、同一个落盘目录，事件 payload 里也没有能区分二者的字段（实测 2.1）。
 *
 * 但"一个楼层"不等于"一条会话"：同一层里可以同时开着多条会话（两个终端 / 终端 + IDE 混着跑）。
 * 那一条轴是 **session_id**（hook payload 字段，也是 transcript 的文件名），
 * 跟 client 正交：client 决定**楼层**，session_id 决定**楼层里的哪条会话**。
 * 以后再加别产品/变体，只需在 products.js 改一条楼层（sources 里挂几路、clients 就收几种身份）。
 */

/** 去 '-plugin' 后缀，拿到产品基名（小写）；非法/空输入返回 '' */
function clientBase(client) {
  return String(client || '').replace(/-plugin$/i, '').toLowerCase();
}

/** 是否 plugin 形态（带 -plugin 后缀） */
function isPluginClient(client) {
  return /-plugin$/i.test(String(client || ''));
}

/** 由 agent 基名 + 是否 plugin 拼出 client 字符串 */
function clientOf(agent, plugin) {
  const a = String(agent || '').toLowerCase();
  return plugin ? `${a}-plugin` : a;
}

/** client 反推 agent 基名（= clientBase） */
function agentOf(client) {
  return clientBase(client);
}

module.exports = {
  PROTOCOL_VERSION,
  IPC_EVENTS,
  AGENT_STATES,
  TASK_STATES,
  MESSAGE_TYPES,
  SOURCES,
  DEFAULTS,
  WS_EVENTS,
  CLIENT_EVENTS,
  HTTP_ROUTES,
  ERROR_CODES,
  STATE_LABELS,
  STATE_COLORS,
  AVATARS,
  AVATAR_FALLBACK,
  avatarOf,
  envelope,
  dedupeKey,
  fnv1a32,
  formatDuration,
  formatClock,
  clientBase,
  isPluginClient,
  clientOf,
  agentOf,
};
