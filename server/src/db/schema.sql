-- WorkGremlin schema v1
-- 约定：
--   * 所有时间为 UTC 毫秒 INTEGER
--   * 枚举用 TEXT + CHECK
--   * JSON 字段用 TEXT 存储
--   * 安全基线：PRAGMA secure_delete=ON 在 **每个连接** 打开时由 db/index.js 设置（该 PRAGMA 不持久化）
--
-- 安全说明：真正的防线是 **脱敏在入库与建 FTS 索引之前** 完成；
-- 本 schema 里的 content / raw_json 只允许存放已脱敏内容。

CREATE TABLE IF NOT EXISTS teams (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  workspace_path        TEXT NOT NULL,
  main_conversation_id  TEXT,
  source                TEXT NOT NULL DEFAULT 'report' CHECK (source IN ('report', 'watch', 'timeout')),
  created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_ws ON teams(workspace_path);

CREATE TABLE IF NOT EXISTS members (
  id             TEXT PRIMARY KEY,          -- "leader@workgremlin"
  team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  role           TEXT,
  session_id     TEXT,
  reported       INTEGER NOT NULL DEFAULT 0, -- 1 = 接入了主动上报（B 路线）
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER,
  -- 临时成员（无工位，场景里是幽灵）：subagent 这类"随项目临时组队"的成员
  ephemeral      INTEGER NOT NULL DEFAULT 0,
  -- 临时成员所属项目名（缺省时 UI 回落到 role）
  project        TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_team ON members(team_id, name);

-- 每个成员一行最新状态（UPSERT）。B 路线为唯一真值；A 路线/超时只写 degraded=1
CREATE TABLE IF NOT EXISTS agent_status (
  member_id          TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  state              TEXT NOT NULL CHECK (state IN ('online', 'busy', 'idle', 'blocked', 'offline')),
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
  team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_id       TEXT NOT NULL,
  parent_task_id  TEXT,
  title           TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  progress        REAL,
  started_at      INTEGER,
  ended_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_member_state ON tasks(member_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_team_started ON tasks(team_id, started_at);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,  -- 游标 / 虚拟滚动
  dedupe_key   TEXT UNIQUE,                        -- A/B 去重
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  ts_ms        INTEGER NOT NULL,
  from_member  TEXT NOT NULL,
  to_member    TEXT,                               -- NULL = 广播
  type         TEXT NOT NULL,
  subject      TEXT,
  content      TEXT,
  task_id      TEXT,
  source       TEXT NOT NULL DEFAULT 'report',
  raw_json     TEXT,
  -- 归档（M1 实现逻辑，M0 只落字段与索引）
  archived_at  INTEGER,
  -- 1 = 正文被截断存储（原始长度超过阈值时只留摘要），UI 需显示"内容已截断"
  content_truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_team_ts   ON messages(team_id, ts_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_from      ON messages(team_id, from_member, ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to        ON messages(team_id, to_member, ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_messages_type      ON messages(team_id, type, ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_messages_archived  ON messages(team_id, archived_at);

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

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id  TEXT,
  ts_ms    INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_team_ts ON events(team_id, ts_ms DESC);
