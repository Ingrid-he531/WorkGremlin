-- WorkGremlin schema v1
-- 约定：
--   * 所有时间为 UTC 毫秒 INTEGER
--   * 枚举用 TEXT + CHECK
--   * JSON 字段用 TEXT 存储
--   * 安全基线：PRAGMA secure_delete=ON 在 **每个连接** 打开时由 db/index.js 设置（该 PRAGMA 不持久化）
--
-- 领域模型：**工程（project）** 是唯一的归属单位 —— 一个工程目录一条 projects 记录，
-- 成员 / 任务 / 消息 / 事件都挂在 project_id 上。演示数据是一条独立的"演示工程"记录，
-- 和真实工程并列（不再有 team 概念）。
--
-- 安全说明：真正的防线是 **脱敏在入库与建 FTS 索引之前** 完成；
-- 本 schema 里的 content / raw_json 只允许存放已脱敏内容。

CREATE TABLE IF NOT EXISTS projects (
  id                    TEXT PRIMARY KEY,   -- 工程标识（由目录名 slug 而来）
  name                  TEXT NOT NULL,
  workspace_path        TEXT NOT NULL,
  main_conversation_id  TEXT,
  source                TEXT NOT NULL DEFAULT 'report' CHECK (source IN ('report', 'watch', 'timeout')),
  created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_ws ON projects(workspace_path);

CREATE TABLE IF NOT EXISTS members (
  id             TEXT PRIMARY KEY,          -- "leader@my-project"
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  role           TEXT,
  session_id     TEXT,
  reported       INTEGER NOT NULL DEFAULT 0, -- 1 = 接入了主动上报（B 路线）
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER,
  -- 临时成员（无工位，场景里是幽灵）：subagent 这类"随项目临时组队"的成员
  ephemeral      INTEGER NOT NULL DEFAULT 0,
  -- 临时成员所属项目名（缺省时 UI 回落到 role）
  project_label  TEXT,
  -- 来源客户端：codebuddy / workbuddy / codex / claude；NULL = 不知道（演示数据、手工脚本）。
  -- 办公室按"当前楼层的客户端"过滤就是靠它（NULL 视作通用，哪层都显示）。
  client         TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_project ON members(project_id, name);

-- 每个成员一行最新状态（UPSERT）。B 路线为唯一真值；A 路线/超时只写 degraded=1
CREATE TABLE IF NOT EXISTS agent_status (
  member_id          TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  state              TEXT NOT NULL CHECK (state IN ('online', 'busy', 'idle', 'blocked', 'offline', 'thinking')),
  state_since        INTEGER NOT NULL,
  task_id            TEXT,
  progress           REAL,                   -- 0~1，NULL = 未知（绝不编造）
  current_files      TEXT,                   -- JSON array
  last_heartbeat_at  INTEGER,
  degraded           INTEGER NOT NULL DEFAULT 0,
  source             TEXT NOT NULL DEFAULT 'report' CHECK (source IN ('report', 'watch', 'timeout')),
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_state ON agent_status(state);

CREATE TABLE IF NOT EXISTS agent_status_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  TEXT NOT NULL,
  state      TEXT NOT NULL,
  ts_ms      INTEGER NOT NULL,
  reason     TEXT,
  source     TEXT NOT NULL DEFAULT 'report'
);
CREATE INDEX IF NOT EXISTS idx_status_hist_member_ts ON agent_status_history(member_id, ts_ms);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_id       TEXT NOT NULL,
  parent_task_id  TEXT,
  title           TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  progress        REAL,
  started_at      INTEGER,
  ended_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_member_state ON tasks(member_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_project_started ON tasks(project_id, started_at);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,  -- 游标 / 虚拟滚动
  dedupe_key   TEXT UNIQUE,                        -- A/B 去重
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ts_ms        INTEGER NOT NULL,
  from_member  TEXT NOT NULL,
  to_member    TEXT,                               -- NULL = 广播
  type         TEXT NOT NULL,
  subject      TEXT,
  content      TEXT,
  task_id      TEXT,
  -- 轴 2（会话）：这条消息出自哪个会话（hook payload 的 session_id / 插件会话 id）。
  -- 同一个成员（同一层楼的同一个 agent）可以同时开多条会话，靠它分。
  -- NULL = 老数据或没带会话标识的上报（演示数据、手工 scripts/subagents.js）。
  session_id   TEXT,
  source       TEXT NOT NULL DEFAULT 'report',
  raw_json     TEXT,
  -- 归档（M1 实现逻辑，M0 只落字段与索引）
  archived_at  INTEGER,
  -- 1 = 正文被截断存储（原始长度超过阈值时只留摘要），UI 需显示"内容已截断"
  content_truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_project_ts   ON messages(project_id, ts_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_from         ON messages(project_id, from_member, ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to           ON messages(project_id, to_member, ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_messages_type         ON messages(project_id, type, ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_messages_archived     ON messages(project_id, archived_at);
-- 注意：session_id 上的索引建在 migrate() 里，不在这里 —— schema.sql 先于 migrate() 执行，
-- 老库这时还没有 session_id 列，在这里建索引会 "no such column"。见 db/index.js 的 migrate()。

-- 中文搜索：必须用 trigram（unicode61 会把整段中文当成一个 token，中文搜索不可用）
-- 注意：trigram 对 <3 字的查询召回差，M2 需在搜索层把 1~2 字查询降级为 LIKE 扫描并限定时间范围。
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(subject, content, content='messages', content_rowid='id', tokenize='trigram');

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, content) VALUES (new.id, new.subject, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, content)
    VALUES ('delete', old.id, old.subject, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, content)
    VALUES ('delete', old.id, old.subject, old.content);
  INSERT INTO messages_fts(rowid, subject, content) VALUES (new.id, new.subject, new.content);
END;

CREATE TABLE IF NOT EXISTS file_activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  TEXT NOT NULL,
  path       TEXT NOT NULL,
  op         TEXT NOT NULL CHECK (op IN ('read', 'write')),
  ts_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_member_ts ON file_activity(member_id, ts_ms DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  TEXT NOT NULL,
  task_id    TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('file', 'doc', 'pr', 'text')),
  title      TEXT NOT NULL,
  path       TEXT,
  ts_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_member_ts ON artifacts(member_id, ts_ms DESC);

-- 一轮**用户任务**的台账（报表主表）。
-- 主键就是 tasks.id（主 agent 那一轮的任务），不另起一套 id —— 用户任务的起止、
-- 输入（用户原话）、产出都在 tasks / artifacts 里，这里只补"报表要算"的那几列。
-- 没有真值就留 NULL（token 尤其如此）：本环境 hook 不报 usage、插件也没落盘，绝不编造。
CREATE TABLE IF NOT EXISTS task_runs (
  id                  TEXT PRIMARY KEY,   -- = tasks.id
  project_id          TEXT NOT NULL,
  member_id           TEXT NOT NULL,      -- 主 agent：codebuddy@<工程> / codex@<工程>
  client              TEXT,               -- codebuddy / workbuddy / codex / claude
  -- 轴 2（会话）：这轮用户任务属于哪条会话。同一个 agent 同时开两条会话时，
  -- 报表要能分清"这轮改动是哪条会话干的"。NULL = 老数据 / 无会话标识的上报。
  session_id          TEXT,
  model               TEXT,               -- 使用的模型（hook 上报；NULL = 没报）
  title               TEXT,               -- 输入：用户原话
  result              TEXT,               -- 产出：收尾自述 / 完成摘要
  file_count          INTEGER,            -- 本轮改动文件数（NULL = 不知道）
  files_json          TEXT,               -- 本轮改动文件清单（JSON array，最多 8 条）
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER,
  started_at          INTEGER,
  ended_at            INTEGER,
  duration_ms         INTEGER             -- 花费时间 = ended_at - started_at
);
CREATE INDEX IF NOT EXISTS idx_task_runs_project_started ON task_runs(project_id, started_at DESC);
-- 同上：idx_task_runs_session 建在 migrate() 里。

-- 这一轮**召唤出去的 subagent 实例**（幽灵）各一行。
-- 幽灵散掉（purgeMember）也不删：它是"这轮用了几个 subagent"的唯一账本 ——
-- 有小工位的（susan）也好、内置专家直接 spawn 的没工位的实例（code-explorer）也好，都记。
CREATE TABLE IF NOT EXISTS subagent_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT NOT NULL,
  parent_task_id TEXT,                    -- 召唤它的那轮用户任务 = task_runs.id
  task_id        TEXT,                    -- 幽灵自己的 tasks.id（拿它的产出 artifacts 用）
  member_id      TEXT NOT NULL,           -- subagent-<名字>@<工程>
  name           TEXT NOT NULL,           -- 类型：susan / simmon / code-explorer / general-purpose…
  client         TEXT,
  model          TEXT,
  title          TEXT,                    -- 它这一单的任务
  result         TEXT,                    -- 收工摘要（产出）
  files_json     TEXT,                    -- 本轮改动文件清单（JSON array of {path,added,removed}，最多 10 条）
  started_at     INTEGER,
  ended_at       INTEGER,
  duration_ms    INTEGER,                 -- 花费时间
  input_tokens   INTEGER,
  output_tokens  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs(parent_task_id, started_at);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  ts_ms    INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_project_ts ON events(project_id, ts_ms DESC);

-- 服务端可持久化的设置键值表（目前仅记录保留天数 retentionDays）。
-- 仅服务端写，前端通过 /api/v1/settings/retention 读取 / 修改。
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
