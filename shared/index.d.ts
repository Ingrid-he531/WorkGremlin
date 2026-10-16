export type AgentState = 'online' | 'busy' | 'idle' | 'blocked' | 'offline';
export type TaskState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type MessageType =
  | 'task_assign'
  | 'task_update'
  | 'result'
  | 'question'
  | 'block'
  | 'shutdown'
  | 'heartbeat'
  | 'system';
export type Source = 'report' | 'watch' | 'timeout';

export interface Envelope<T = unknown> {
  v: number;
  type: string;
  ts: number;
  /** project id */
  project: string;
  actor: string;
  payload: T;
}

export interface Member {
  id: string;
  projectId: string;
  name: string;
  role: string | null;
  sessionId: string | null;
  /** Whether it does active reporting (route B). false = passively observed only (route A) */
  reported: boolean;
  createdAt: number;
  lastSeenAt: number;
}

export interface MemberTaskRef {
  id: string;
  title: string;
  progress: number | null;
  startedAt: number;
  /** End time; null = still running. The card uses this to tell "current task" from "previous task" (the slot is not cleared on finish) */
  endedAt?: number | null;
  state?: TaskState;
}

export interface Artifact {
  id?: number;
  memberId: string;
  taskId: string | null;
  kind: 'file' | 'doc' | 'pr' | 'text';
  title: string;
  path: string | null;
  tsMs: number;
  /** true = output derived from "this round's changed files" (fallback when the artifacts table has no truth), not reported truth */
  derived?: boolean;
}

/** The data structure the workstation view binds to directly */
export interface MemberCard {
  memberId: string;
  name: string;
  role: string | null;
  state: AgentState;
  /** When it entered the current state, for computing "elapsed" */
  stateSince: number;
  task: MemberTaskRef | null;
  currentFiles: string[];
  artifacts: Artifact[];
  lastSeenAt: number;
  /** End time of the most recent **finished** task: "last active" = how long ago (not the last heartbeat) */
  lastTaskAt?: number | null;
  /** true = the state is inferred (route-A fallback / heartbeat timeout), not reported truth */
  degraded: boolean;
  reported: boolean;
  messageCount: number;
  /** The resident subagent's functional description (static data from the agent definition file, not runtime state); empty string if none */
  description?: string | null;
  /** Temporary-team member (no desk; floats in the scene as a ghost) */
  ephemeral?: boolean;
  /** Project name a temporary member belongs to; defaults to role */
  projectLabel?: string | null;
}

export interface Message {
  id: number;
  projectId: string;
  tsMs: number;
  fromMember: string;
  toMember: string | null;
  type: MessageType | string;
  subject: string | null;
  content: string;
  taskId: string | null;
  source: Source | string;
  rawJson: string | null;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string;
  mainConversationId: string | null;
  source: Source | string;
  createdAt: number;
  /** Project display name (package.json name > dir name); the demo project has a fixed name */
  projectName: string;
}

export interface Snapshot {
  /** current project */
  project: Project | null;
  /** all projects (including the demo project) */
  projects: Project[];
  members: MemberCard[];
  /** current project display name (package.json name > dir name) */
  projectName?: string;
  recentMessages: Message[];
  serverTime: number;
  serverVersion: string;
}

export interface MessageFilters {
  members?: string[];
  types?: string[];
  since?: number;
  until?: number;
  keyword?: string;
  beforeId?: number;
  limit?: number;
}

export declare const PROTOCOL_VERSION: number;
export declare const AGENT_STATES: readonly AgentState[];
export declare const TASK_STATES: readonly TaskState[];
export declare const MESSAGE_TYPES: readonly string[];
export declare const SOURCES: readonly Source[];
export declare const DEFAULTS: {
  readonly PORT_START: number;
  readonly PORT_END: number;
  readonly HEARTBEAT_TIMEOUT_MS: number;
  readonly DEGRADED_POLL_MS: number;
  readonly STATUS_MERGE_MS: number;
  readonly MESSAGE_WINDOW: number;
  readonly WAL_AUTOCHECKPOINT_PAGES: number;
  readonly WAL_CHECKPOINT_INTERVAL_MS: number;
  readonly RETENTION_DAYS: number;
  /** Council: default round cap / hard cap / turn timeout / material byte caps (see shared/index.js for the comments) */
  /** 'vote' (voting; the server counts votes for consensus) or 'analysis' (analysis; no voting, a briefing after the full rounds) */
  readonly COUNCIL_MODE_DEFAULT: string;
  readonly COUNCIL_ROUNDS_DEFAULT: number;
  readonly COUNCIL_ROUNDS_MAX: number;
  /** 'unanimous' (no objections + majority) or 'majority' (simple majority) */
  readonly COUNCIL_THRESHOLD_DEFAULT: string;
  readonly COUNCIL_TURN_TIMEOUT_MS: number;
  /** Turn timeout in workspace mode (participants use read-only tools to dig through code themselves), wider than the one above */
  readonly COUNCIL_WORKSPACE_TURN_TIMEOUT_MS: number;
  /** Fixed title for 7F/8F participant sessions: floorKilo.js / floorOpencode.js use it to keep participants off the floor */
  readonly COUNCIL_SESSION_TITLE: string;
  readonly COUNCIL_MATERIAL_MAX_BYTES: number;
  readonly COUNCIL_MATERIAL_TOTAL_MAX_BYTES: number;
};
export declare const WS_EVENTS: Record<string, string>;
export declare const IPC_EVENTS: Record<string, string>;
export declare const CLIENT_EVENTS: Record<string, string>;
export declare const HTTP_ROUTES: Record<string, string>;
export declare const ERROR_CODES: Record<string, string>;
export declare const STATE_LABELS: Record<AgentState, string>;
export declare const STATE_COLORS: Record<AgentState, string>;
/** Gremlin avatar config keyed by member name (leader / coder / …); unmatched falls back to AVATAR_FALLBACK. */
export declare const AVATARS: Record<string, { label: string; body: string; horn: string; prop: string }>;
export declare const AVATAR_FALLBACK: { label: string; body: string; horn: string; prop: string };


export declare function envelope<T>(type: string, project: string, actor: string, payload: T, ts?: number): Envelope<T>;
export declare function dedupeKey(m: {
  project: string;
  from: string;
  to?: string | null;
  ts: number;
  content?: string;
}): string;
export declare function fnv1a32(str: string): string;
export declare function formatDuration(ms: number): string;
/** Absolute time `MM-DD HH:mm` (points in time like "started / last active"; fixed, no timer recompute) */
export declare function formatClock(ms: number): string;
/** Member avatar config by name (before `@`); unmatched → AVATAR_FALLBACK. */
export declare function avatarOf(name: string): { label: string; body: string; horn: string; prop: string };
/** form → source: vscode-like → 'plugin', 'ide' → 'ide', everything else → 'cli'. */
export declare function formToSource(form: string): 'plugin' | 'cli' | 'ide';
/** agent base name → product display name table. */
export declare const AGENT_LABELS: Record<string, string>;
/** Identity → agent base name (strips an `@<project>` suffix; plugin-vs-not is decided by `form`). */
export declare function agentBase(id: string): string;
/** Final display name from agent + form (e.g. "Kilo Code CLI" / "CodeBuddy Plugin"). */
export declare function clientLabel(agent: string, form: string): string;
/** WorkGremlin home dir: default ~/.workgremlin, overridable with WORKGREMLIN_HOME. */
export declare function home(): string;

/**
 * Whether a form means "plugin" (IDE extension) — the only plugin-vs-not decision. Identity is
 * always the bare floor base name (never a synthesized `agent + '-plugin'`).
 */
export declare function isPluginClient(form: string): boolean;
