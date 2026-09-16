export type AgentState = 'online' | 'busy' | 'idle' | 'blocked' | 'offline' | 'thinking';
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
  team: string;
  actor: string;
  payload: T;
}

export interface Member {
  id: string;
  teamId: string;
  name: string;
  role: string | null;
  sessionId: string | null;
  /** 是否接入了主动上报（B 路线）。false = 仅被动观测（A 路线） */
  reported: boolean;
  createdAt: number;
  lastSeenAt: number;
}

export interface MemberTaskRef {
  id: string;
  title: string;
  progress: number | null;
  startedAt: number;
}

export interface Artifact {
  id?: number;
  memberId: string;
  taskId: string | null;
  kind: 'file' | 'doc' | 'pr' | 'text';
  title: string;
  path: string | null;
  tsMs: number;
}

/** 工位视图直接绑定的数据结构 */
export interface MemberCard {
  memberId: string;
  name: string;
  role: string | null;
  state: AgentState;
  /** 进入当前状态的时刻，用于计算"已耗时" */
  stateSince: number;
  task: MemberTaskRef | null;
  currentFiles: string[];
  artifacts: Artifact[];
  lastSeenAt: number;
  /** true = 状态为推断值（A 路线兜底 / 心跳超时），非上报真值 */
  degraded: boolean;
  reported: boolean;
  messageCount: number;
  /** 临时组队成员（无工位，场景里以幽灵形态飘在空中） */
  ephemeral?: boolean;
  /** 临时成员所属项目名，缺省用 role */
  project?: string | null;
}

export interface Message {
  id: number;
  teamId: string;
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

export interface Team {
  id: string;
  name: string;
  workspacePath: string;
  mainConversationId: string | null;
  source: Source | string;
  createdAt: number;
  /** 所属工程名（package.json name > 目录名）；拿不到为空串 */
  project?: string;
}

export interface Snapshot {
  team: Team | null;
  teams: Team[];
  members: MemberCard[];
  /** 当前工程名（package.json name > 目录名），拿不到为空串 */
  project?: string;
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
};
export declare const WS_EVENTS: Record<string, string>;
export declare const CLIENT_EVENTS: Record<string, string>;
export declare const HTTP_ROUTES: Record<string, string>;
export declare const ERROR_CODES: Record<string, string>;
export declare const STATE_LABELS: Record<AgentState, string>;
export declare const STATE_COLORS: Record<AgentState, string>;


export declare function envelope<T>(type: string, team: string, actor: string, payload: T, ts?: number): Envelope<T>;
export declare function dedupeKey(m: {
  team: string;
  from: string;
  to?: string | null;
  ts: number;
  content?: string;
}): string;
export declare function fnv1a32(str: string): string;
export declare function formatDuration(ms: number): string;
