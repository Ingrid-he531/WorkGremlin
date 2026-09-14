'use strict';

/**
 * WorkGremlin 共享常量 / 协议 / 类型（运行时部分）。
 * 本文件必须保持**零运行时依赖**，同时被 Node（server/desktop）与浏览器（renderer）引用。
 * 类型声明见同目录 index.d.ts。
 */

const PROTOCOL_VERSION = 1;

/** @type {ReadonlyArray<'online'|'busy'|'idle'|'blocked'|'offline'>} */
const AGENT_STATES = Object.freeze(['online', 'busy', 'idle', 'blocked', 'offline']);

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
});

/** 服务端 -> 客户端 */
const WS_EVENTS = Object.freeze({
  SNAPSHOT: 'snapshot',
  MEMBER_STATUS: 'member.status',
  TASK_UPDATE: 'task.update',
  MESSAGE_NEW: 'message.new',
  MESSAGES_PAGE: 'messages.page',
  FILE_ACTIVITY: 'file.activity',
  ARTIFACT_NEW: 'artifact.new',
  CONNECTION: 'connection',
  ERROR: 'error',
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
  TEAMS: '/api/v1/teams',
  REGISTER: '/api/v1/register',
  HEARTBEAT: '/api/v1/heartbeat',
  TASK_START: '/api/v1/task/start',
  TASK_PROGRESS: '/api/v1/task/progress',
  TASK_END: '/api/v1/task/end',
  STATUS: '/api/v1/status',
  MESSAGE: '/api/v1/message',
  FILE_TOUCH: '/api/v1/file/touch',
});

const ERROR_CODES = Object.freeze({
  BAD_PAYLOAD: 'bad_payload',
  BAD_TOKEN: 'bad_token',
  UNKNOWN_MEMBER: 'unknown_member',
  UNKNOWN_TEAM: 'unknown_team',
  DUPLICATE: 'duplicate',
  INTERNAL: 'internal',
});

/**
 * 构造协议信封。
 * @param {string} type
 * @param {string} team
 * @param {string} actor
 * @param {unknown} payload
 * @param {number} [ts]
 */
function envelope(type, team, actor, payload, ts = Date.now()) {
  return { v: PROTOCOL_VERSION, type, ts, team, actor, payload };
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
 * @param {{team: string, from: string, to?: string|null, ts: number, content?: string}} m
 * @returns {string}
 */
function dedupeKey(m) {
  const base = [m.team, m.from, m.to ?? '', String(m.ts ?? ''), m.content ?? ''].join('\u0001');
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

module.exports = {
  PROTOCOL_VERSION,
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
};
