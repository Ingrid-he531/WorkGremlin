'use strict';

/**
 * WorkGremlin shared constants / protocol / types (runtime part).
 * This file must stay **zero-runtime-dependency** and is referenced by both Node (server/desktop) and
 * the browser (renderer). Type declarations are in index.d.ts in the same dir.
 */

/** v2: unified the team concept into project (envelope field team -> project). */
const PROTOCOL_VERSION = 2;

/**
 * Member states. "Thinking / waiting for the model" is **not** a separate state — it is part of `busy`
 * (see requirements §5.5: "thinking / waiting for the LLM → busy"); the main console's finer
 * "thinking vs calling a tool" distinction lives on the **phase** axis (sessionPhase.phase), not here.
 * @type {ReadonlyArray<'online'|'busy'|'idle'|'blocked'|'offline'>}
 */
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

/** Data source: report = the agent reports it (truth); watch = dir-watch fallback (inferred); timeout = heartbeat timeout (inferred) */
const SOURCES = Object.freeze(['report', 'watch', 'timeout']);

const DEFAULTS = Object.freeze({
  PORT_START: 21800,
  PORT_END: 21820,
  /** No reported heartbeat for longer than this -> degraded (greyed out + marked "inferred") */
  HEARTBEAT_TIMEOUT_MS: 60_000,
  /** HTTP poll interval after the WS drops */
  DEGRADED_POLL_MS: 2_000,
  /** member.status broadcast merge window */
  STATUS_MERGE_MS: 200,
  /** M0 message window cap (M2 swaps in virtual scrolling) */
  MESSAGE_WINDOW: 500,
  /** WAL auto-checkpoint pages (~2MB) */
  WAL_AUTOCHECKPOINT_PAGES: 512,
  /** Active checkpoint interval */
  WAL_CHECKPOINT_INTERVAL_MS: 30_000,
  /**
   * Default task-record retention days ("auto-keep the last N days"; the user asked for 90 on 2026-10-01).
   * Just the **default**: if the user changed it in the UI, the stored settings.retentionDays wins (1~3650).
   * One source shared by server/frontend — this number used to be in three places (server fallback, the PUT
   * fallback, the frontend ref's initial value), and changing one but forgetting another produced mismatches
   * like "the UI says 30, the cleanup uses 90".
   */
  RETENTION_DAYS: 90,

  /**
   * Council Chamber — pick agents from several floors to discuss one topic to agreement.
   *
   * Only **global defaults** live here; each council's own settings (rounds / decision rule) are stored on
   * the councils row, filled from these defaults at launch and not affected by later global changes (a
   * council that already ran should not have its rule changed).
   */
  /**
   * The council's two modes (councils.mode):
   *   'vote'     — several rounds of voting on one proposal; the server mechanically counts votes (see council/consensus.js)
   *   'analysis' — no voting, no consensus: free analysis each round, then a grouped briefing after the full round count
   * Orthogonal to "where to talk" (whether councils.workspace_path has a value) — two independent switches.
   */
  COUNCIL_MODE_DEFAULT: 'vote',
  /** Default discussion-round cap (excluding round 0, the topic statement) */
  COUNCIL_ROUNDS_DEFAULT: 3,
  /** Hard cap on discussion rounds (the user cannot raise it in the UI) */
  COUNCIL_ROUNDS_MAX: 8,
  /**
   * Default decision rule. Values in server/src/council/consensus.js THRESHOLDS:
   *   'unanimous' — no objections + majority yes (default, most conservative: any single objection means no agreement)
   *   'majority'  — simple majority (yes > no)
   * Both require **no one abstaining**: we do not know an absent member's stance, and treating unknown as
   * tacit consent is inventing.
   */
  COUNCIL_THRESHOLD_DEFAULT: 'unanimous',
  /**
   * Timeout for a single participant's turn. On expiry we **kill the process** and record "no stance"
   * honestly — the timeout here is not "wait a bit longer", it is "we definitely cannot get this vote". So
   * it leaves ample margin for the slowest floor (one answer runs a whole model call).
   */
  COUNCIL_TURN_TIMEOUT_MS: 120_000,
  /**
   * Timeout for a single participant's turn in **workspace mode** (councils.workspace_path has a value).
   *
   * Much wider than isolated mode: an isolated-mode participant just "talks", whereas a workspace-mode
   * participant uses read-only tools to dig through the code round after round (read a file → search
   * references → read again), so one answer may contain dozens of tool calls. 120s is a normal timeout for
   * it, not an anomaly — using it would misrecord "it is still reading" as "it gave no stance".
   */
  COUNCIL_WORKSPACE_TURN_TIMEOUT_MS: 300_000,
  /**
   * The session title (`--title`) for 7F Kilo / 8F OpenCode participants — **also the lock that keeps them
   * out of the office**.
   *
   * Why this marker is required: these two lack 1F/4F's `--no-session-persistence`, so sessions are always
   * recorded in the **global** SQLite (`session.directory` = the cwd at the time). In isolated mode the cwd
   * is a throwaway dir in /tmp, so the office's per-project filter cannot see them; **in workspace mode the
   * cwd is the user's project** — without the marker, participants immediately become an extra "session" on
   * 7F/8F in the office, violating requirements.md §15.2 "after a council ends, those two pages show no trace".
   *
   * The data dir cannot be moved either: measured, `XDG_DATA_HOME` does move these databases (Kilo's kilo.db
   * lands in the new dir), but **the login state goes with it** (after moving, Kilo returns 401 "You need to
   * sign in" and OpenCode hangs outright), so participants cannot even speak. So instead it is "persist as
   * usual + stamp a fixed title", and server/src/floorKilo.js and server/src/floorOpencode.js **skip this
   * title when listing sessions**.
   *
   * The title contains WorkGremlin so the user can tell, in Kilo / OpenCode's own session history, who left it.
   */
  COUNCIL_SESSION_TITLE: '议事厅参与者（WorkGremlin）',
  /** Byte cap for a single inlined material file; the excess is truncated and the UI marks it "truncated" */
  COUNCIL_MATERIAL_MAX_BYTES: 64 * 1024,
  /** Byte cap for all inlined material (the prompt must fit into argv / stdin; it cannot grow without bound) */
  COUNCIL_MATERIAL_TOTAL_MAX_BYTES: 200 * 1024,
});

/** server -> client */
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
  /** Global active-session table changed (open/close project·session): the server pushes on change, the client refreshes immediately */
  SESSIONS: 'sessions',
  /**
   * Council incremental update (a council's status / someone's utterance / this round's votes / the closing conclusion).
   * The council is unrelated to "current project" / "current floor" (it is an independently launched meeting), so
   * project is null on broadcast. The payload is an **increment**; the client places it by councilId, see
   * server/src/council/orchestrator.js.
   */
  COUNCIL: 'council.update',
});

/** client -> server */
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
  // Round-end fallback (bug 3): when a concurrent overwrite of the state file loses taskId, the hook re-fetches
  // "the task currently running" by session
  TASK_CURRENT: '/api/v1/task/current',
  // Post-round token backfill: some floors (CodeBuddy plugin form, measured) persist usage much later than Stop,
  // so it is unreadable at round end → wait for it to land and backfill, writing only the four token columns and
  // not touching any other field of the row.
  TASK_TOKENS: '/api/v1/task/tokens',
  STATUS: '/api/v1/status',
  MESSAGE: '/api/v1/message',
  FILE_TOUCH: '/api/v1/file/touch',
  // Tool-usage count: a tool was used again within a task round (task detail's "tool usage")
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
 * Build a protocol envelope.
 * @param {string} type
 * @param {string} project project id
 * @param {string} actor
 * @param {unknown} payload
 * @param {number} [ts]
 */
function envelope(type, project, actor, payload, ts = Date.now()) {
  return { v: PROTOCOL_VERSION, type, ts, project, actor, payload };
}

/**
 * 32-bit FNV-1a (isomorphic, to avoid depending on node:crypto in the browser).
 * @param {string} str
 * @returns {string} 8 hex digits
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
 * Message dedupe key. Used for idempotency when two sources A/B write into the same table.
 * @param {{project: string, from: string, to?: string|null, ts: number, content?: string}} m
 * @returns {string}
 */
function dedupeKey(m) {
  const base = [m.project, m.from, m.to ?? '', String(m.ts ?? ''), m.content ?? ''].join('\u0001');
  return `${fnv1a32(base)}${fnv1a32(`${base}\u0002`)}`;
}

/**
 * Human-readable form of a millisecond duration (for "elapsed").
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
 * Absolute time `MM-DD HH:mm` (for points in time like "started / last active").
 *
 * Why not a relative duration ("53m ago"): that requires the UI to recompute every second, and once that
 * recompute breaks you get two behaviors on one screen — "1F's last-active frozen while 3F's elapsed keeps
 * climbing" (user-measured 2026-09-30). A fixed point in time needs no timer and cannot suffer "someone
 * didn't refresh". No seconds — those are for relative durations.
 * @param {number} ms
 */
function formatClock(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** State -> label (user-facing UI text, kept in Chinese) */
const STATE_LABELS = Object.freeze({
  online: '在线',
  busy: '忙碌',
  idle: '空闲',
  blocked: '阻塞',
  offline: '离线',
});

/** State -> theme color (kept in sync with renderer/src/styles/theme.css) */
const STATE_COLORS = Object.freeze({
  online: 'var(--state-online)',
  busy: 'var(--state-busy)',
  idle: 'var(--state-idle)',
  blocked: 'var(--state-blocked)',
  offline: 'var(--state-offline)',
});

/**
 * Character avatars (SVG Gremlin): body/horn colors + a held prop.
 * key is the member name (leader / researcher / coder / tester ...); a miss falls back to AVATAR_FALLBACK.
 * (label values are user-facing UI text, kept in Chinese.)
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
 * Get a member's avatar config. memberId looks like `coder@workgremlin`; match by the name before `@`.
 * @param {string} name
 */
function avatarOf(name) {
  const key = String(name || '')
    .split('@')[0]
    .toLowerCase();
  return AVATARS[key] || AVATAR_FALLBACK;
}

/* ------------------------------------------------------------------ *
 * Temporary members (ghosts)
 *
 * The expert team are resident members, one desk each; members pulled in for a temporary team on some
 * project have no desk and float in the scene as "ghosts".
 *
 * The deciding rule belongs to the presentation layer (see renderer/src/lib/ephemeral.js):
 *   ephemeral === true > memberId prefix ghost- / tmp- > role === 'ghost'.
 * Here we only declare the data-contract field, for the server to send directly later.
 * ------------------------------------------------------------------ */


/** Main process <-> renderer IPC channels (same convention as WS_EVENTS; centralized to avoid a typo silently breaking the link) */
const IPC_EVENTS = Object.freeze({
  GET_SERVER_INFO: 'workgremlin:get-server-info',
  GET_APP_VERSION: 'workgremlin:get-app-version',
  CHOOSE_WORKSPACE: 'workgremlin:choose-workspace',
  SET_FULL_SCREEN: 'workgremlin:set-full-screen',
  IS_FULL_SCREEN: 'workgremlin:is-full-screen',
  FULL_SCREEN_EVENT: 'workgremlin:full-screen',
  EVENT: 'workgremlin:event',
  QUIT: 'workgremlin:quit',
  OPEN_EXTERNAL: 'workgremlin:open-external',
  GET_BUILD_INFO: 'workgremlin:get-build-info',
});

/**
 * Whether a **form** means "plugin" (IDE extension). Decided by the form the hook event reports
 * (ev.client): vscode-family IDEs count as plugin today; add jetbrains / cursor … to this list later.
 *
 * This is the **only** place that decides plugin-vs-not. Identity (agent / client) is always the
 * bare floor base name, never a synthesized `agent + '-plugin'` string.
 * @param {string} form form (vscode / cli / ide …)
 */
const PLUGIN_FORMS = ['vscode'];
function isPluginClient(form) {
  return PLUGIN_FORMS.includes(String(form || '').toLowerCase());
}

/**
 * form → source derivation: one rule for the three forms.
 *   isPluginClient(form) → 'plugin' (vscode-family IDE extensions)
 *   form === 'ide'        → 'ide' (standalone IDE products, e.g. TraeCode IDE)
 *   form === 'cli'        → 'cli'
 *   other (empty / unknown) → 'cli' (fallback: if the form can't be told, treat it as CLI)
 *
 * Both frontend and backend use this function, so the form→source mapping exists in exactly one place.
 * @param {string} form form
 * @returns {'plugin'|'cli'|'ide'}
 */
function formToSource(form) {
  const f = String(form || '').toLowerCase();
  if (isPluginClient(f)) return 'plugin';
  if (f === 'ide') return 'ide';
  return 'cli';
}

/**
 * agent base name → product display name table. One copy shared by frontend and backend (see clientLabel).
 * Register a new floor here, don't scatter it across call sites.
 */
const AGENT_LABELS = {
  codebuddy: 'CodeBuddy',
  workbuddy: 'WorkBuddy',
  codex: 'Codex',
  claude: 'Claude Code',
  trae: 'TraeCode',
  kilo: 'Kilo Code',
  qoder: 'Qoder',
  opencode: 'OpenCode',
  copilot: 'GitHub Copilot',
};

/**
 * Identity → agent base name: strip the `@<project>` suffix (memberId is `name@project`) and
 * lowercase. Identity is always the floor base name now — there is no synthesized `-plugin`
 * suffix to strip (plugin-vs-not is decided by `form`, see isPluginClient).
 * Shared by both frontend and backend (clientLabel, renderer matching, sessionRegistry).
 * @param {string} id memberId / name / client
 */
function agentBase(id) {
  return String(id || '')
    .split('@')[0]
    .toLowerCase();
}

/**
 * Final display name from agent + form. The single source shared by frontend and backend; the API returns
 * the already-computed string, so the frontend no longer assembles it from form itself.
 *
 * Rules:
 *   isPluginClient(form)      → `${base} Plugin`
 *   form === 'cli'             → `${base} CLI` (not appended if base already contains CLI/IDE)
 *   form === 'ide'             → `${base} IDE` (same)
 *   other (empty / form already carries the form) → base name
 *
 * @param {string} agent floor identity (client / memberId etc.)
 * @param {string} form  form (vscode / cli / ide / '')
 * @returns {string} display name, e.g. "TraeCode IDE" / "CodeBuddy Plugin" / "Kilo Code CLI" / "Codex"
 */
function clientLabel(agent, form) {
  const a = agentBase(agent);
  const base = AGENT_LABELS[a] || a || '—';
  const f = String(form || '').toLowerCase();
  if (isPluginClient(f)) return `${base} Plugin`;
  if (f === 'cli' && !/(?:^|\s)(?:CLI|IDE)$/i.test(base)) return `${base} CLI`;
  if (f === 'ide' && !/(?:^|\s)(?:CLI|IDE)$/i.test(base)) return `${base} IDE`;
  return base;
}

/**
 * WorkGremlin home dir: default ~/.workgremlin, overridable with WORKGREMLIN_HOME.
 * Lazily requires node:os / node:path — this module is referenced by both Node and the browser (renderer), so
 * it must not require Node built-ins at the top level, or the renderer bundle breaks. home() is only called
 * on the Node side; the renderer never triggers the require inside.
 */
function home() {
  const os = require('node:os');
  const path = require('node:path');
  return process.env.WORKGREMLIN_HOME || path.join(os.homedir(), '.workgremlin');
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
  isPluginClient,
  formToSource,
  clientLabel,
  agentBase,
  AGENT_LABELS,
  home,
};
