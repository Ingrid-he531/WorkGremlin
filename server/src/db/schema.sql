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

-- Each member/session pair tracks its own task; agent_status remains the member-card aggregate.
CREATE TABLE IF NOT EXISTS session_status (
  member_id          TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  session_id         TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('online', 'busy', 'idle', 'blocked', 'offline', 'thinking')),
  state_since        INTEGER NOT NULL,
  task_id            TEXT,
  last_heartbeat_at  INTEGER,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (member_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_session_status_task ON session_status(task_id, last_heartbeat_at);

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

-- 一轮用户任务里**每个工具用了几次**（任务记录 → 任务详情的「工具使用」）。
-- 形状是"按 (task_id, tool) 累加一行"，不是每次调用落一行：一轮里 Bash 能跑上百次，
-- 逐次落盘只会把库撑大、查的时候还得 GROUP BY。计数由上报方逐次 +1（见 bus.toolUse）。
-- task_id 就是 tasks.id / task_runs.id（那一轮用户任务）；拿不到任务 id 的调用不记
-- （任务详情是按任务看的，没任务的记录无处可挂 —— 不瞎归因到别的任务上）。
CREATE TABLE IF NOT EXISTS tool_usage (
  task_id    TEXT NOT NULL,
  tool       TEXT NOT NULL,
  project_id TEXT,
  member_id  TEXT,
  client     TEXT,
  session_id TEXT,
  count      INTEGER NOT NULL DEFAULT 0,
  first_at   INTEGER,
  last_at    INTEGER,
  PRIMARY KEY (task_id, tool)
);
CREATE INDEX IF NOT EXISTS idx_tool_usage_task ON tool_usage(task_id);
CREATE INDEX IF NOT EXISTS idx_tool_usage_project ON tool_usage(project_id, last_at DESC);

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
-- 没有真值就留 NULL，绝不编造。
--
-- 四列 token 的**统一语义**（各楼层的原始口径不同，落库前已归一，见 reporter/src/usage.js）：
--   input_tokens       = 本轮**没命中缓存**的那部分输入
--   cache_read_tokens  = 本轮命中缓存的输入
--   cache_write_tokens = 本轮写入缓存的输入
--   output_tokens      = 本轮模型吐出的（**含思考**）
-- 恒有 input + cache_read + cache_write = 这一轮所有请求的 prompt 总长。之所以要归一：
-- Claude / Kilo / OpenCode 的原始 `input` 本来就不含缓存，而 Codex 与 CodeBuddy 的中转上报里
-- `input_tokens`(prompt_tokens) **含**缓存命中（本机实测 hit+miss==prompt，142/142 条成立）。
-- 不归一，同一列在 1F/3F 记的是整段上下文、在 4F/7F/8F 只记没命中缓存的那一小截。
-- 轮的粒度：一轮用户任务里的**每一次 API 请求**都算（计费口径），不是"最后一次请求的上下文"。
CREATE TABLE IF NOT EXISTS task_runs (
  id                  TEXT PRIMARY KEY,   -- = tasks.id
  project_id          TEXT NOT NULL,
  member_id           TEXT NOT NULL,      -- 主 agent：codebuddy@<工程> / codex@<工程>
  client              TEXT,               -- codebuddy / workbuddy / codex / claude
  -- 轴 2（会话）：这轮用户任务属于哪条会话。同一个 agent 同时开两条会话时，
  -- 报表要能分清"这轮改动是哪条会话干的"。NULL = 老数据 / 无会话标识的上报。
  session_id          TEXT,
  -- 这一轮走的**形态**：'cli' / 'plugin'（IDE 扩展）。
  -- 同一产品的两种形态共用一份落盘、client 也相同时（3F Codex：CLI 与 VS Code 扩展
  -- 共用 ~/.codex，client 都是 codex），任务列表靠它标出「Codex CLI / Codex Plugin」。
  -- 分不出的产品（Claude / Qoder…）与老数据留 NULL —— 显示时退回只写产品名。
  form                TEXT,
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

-- ============================ 议事厅（Council Chamber） ============================
--
-- 选定几个楼层的 agent，就一个问题开一场会，讨论到达成一致。这是仓库里唯一一处
-- **由服务端拉起外部 agent 进程**的地方（别处的 agent 进程都是用户自己起的），所以这一组表
-- 刻意与办公室那套完全隔离：
--   · 不挂 project_id、不写 members / tasks / task_runs —— 参与者不进办公室、不占工位、
--     不计入任务台账与词元汇总；它们只在议事厅页面看得到。
--   · 参与者跑在服务端建的一次性临时目录里，且**关掉了全部工具**（见 server/src/council/agents.js），
--     所以它们碰不到工作区。
--   · 铁律同样适用：进程崩了 / 超时 / 输出解析不出，一律如实记 status='failed'/'timeout'/'unparsed'
--     并把错误原文留下，**绝不替它补一个立场**（见 council_utterances.vote 的注释）。

-- 一场会。结论**不是一个新生成的摘要**，而是「达成一致的那一轮桌上那份提案原文」——
-- 所以这里只记 verdict 与 verdict_round，正文去 council_rounds 里按 round_no 取。
--
-- 两个**正交**的开关（四种组合都成立）：
--   · mode          —— 怎么收场：'vote' 数票判共识 / 'analysis' 不判共识、跑满轮数出简报
--   · workspace_path —— 在哪儿谈：有值 = 参与者以它为工作目录、给只读工具；
--                       NULL = 今天那样跑在一次性临时目录里、没有工具
CREATE TABLE IF NOT EXISTS councils (
  id            TEXT PRIMARY KEY,          -- c_<时间戳>_<随机>
  topic         TEXT NOT NULL,             -- 议题正文（用户粘贴的原文）
  -- 'vote'（缺省，服务端机械计票）/ 'analysis'（不投票：见 council/prompt.js 的 ANALYSIS_PROTOCOL）
  mode          TEXT NOT NULL DEFAULT 'vote'
                CHECK (mode IN ('vote','analysis')),
  -- 参与者的工作目录（绝对路径，发起时校验过存在且是目录）。
  -- NULL = 隔离模式：服务端现建一次性临时目录，收尾即删（见 council/orchestrator.js）。
  -- **非 NULL 时那个目录是用户的，收尾绝不许删** —— 编排器里有测试钉着这条。
  workspace_path TEXT,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','running','done','failed','cancelled')),
  -- 判定口径：unanimous（缺省，无反对且同意够半数）/ majority（同意>反对）。见 council/consensus.js
  threshold     TEXT NOT NULL DEFAULT 'unanimous'
                CHECK (threshold IN ('unanimous','majority')),
  max_rounds    INTEGER NOT NULL,          -- 讨论轮上限（不含第 0 轮议题陈述）
  round_current INTEGER NOT NULL DEFAULT 0,-- 当前推进到第几轮（0 = 只有议题陈述轮）
  -- 收尾：consensus / no_consensus / cancelled / failed，外加分析模式的 reported。
  -- **no_consensus 是合法结果**，不是错误 —— 谈不拢就如实说谈不拢，不硬凑一个结论。
  -- **reported 也是合法结果**：分析模式压根没有"谈成没谈成"这件事，它只保证"每人都跑完了、
  -- 发言都在库里"，所以这里记的是"已呈报"，不是一个判定（见 councils.mode）。
  verdict       TEXT
                CHECK (verdict IS NULL OR verdict IN ('consensus','no_consensus','reported','cancelled','failed')),
  verdict_round INTEGER,                   -- 达成一致的是第几轮（NO CONCENSUS 时留 NULL）
  error         TEXT,                      -- 整场级别的失败原因（单人的失败记在 participants/utterances）
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_councils_created ON councils(created_at DESC);

-- 出席者 = 发起时选定的楼层各一个座位。cli_path 是探测到的可执行文件绝对路径
-- （探测不到就不会被选中，见 council/floors.js），失败时也留着真值便于排查。
CREATE TABLE IF NOT EXISTS council_participants (
  council_id TEXT NOT NULL,
  floor_id   TEXT NOT NULL,                -- '1F' / '4F' / '7F' / '8F'
  agent      TEXT NOT NULL,                -- codebuddy / claude / kilo / opencode
  cli_path   TEXT,                         -- cliInstallPath；NULL = 当时没探到
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','running','ok','failed')),
  error      TEXT,
  PRIMARY KEY (council_id, floor_id)
);

-- 内联的背景材料。content 存的是**实际发出去的那段文本**（已按上限截断），
-- 留着是为了复现"当时到底给它看了什么"；bytes_total 是文件原始大小（读不到 = NULL，不是 0）。
CREATE TABLE IF NOT EXISTS council_materials (
  council_id     TEXT NOT NULL,
  ord            INTEGER NOT NULL,         -- 第几个文件（决定拼进提示词的顺序）
  path           TEXT NOT NULL,            -- 用户给的绝对路径
  bytes_total    INTEGER,                  -- 原文件大小；读不到留 NULL
  bytes_included INTEGER,                  -- 实际内联进去的字节数
  truncated      INTEGER NOT NULL DEFAULT 0,
  content        TEXT,                     -- 原样内容（截断后）
  PRIMARY KEY (council_id, ord)
);

-- 每一轮一行。round_no = 0 是**议题陈述轮**（服务端把议题 + 材料摆上桌，不投票）；
-- 1..N 是讨论轮。proposal_* 是**这一轮投票针对的那份提案**，逐轮存档 → 全程可追溯
-- （"第 3 轮的结论是拿第 2 轮谁提的那版投出来的"要能复盘）。
-- 票数由 council/consensus.js 现算后落库，不是模型自报。
CREATE TABLE IF NOT EXISTS council_rounds (
  council_id     TEXT NOT NULL,
  round_no       INTEGER NOT NULL,         -- 0 = 议题陈述轮
  kind           TEXT NOT NULL CHECK (kind IN ('brief','debate')),
  proposal_text  TEXT,                     -- 本轮桌上那份提案原文
  proposal_from  TEXT,                     -- 谁提的：楼层号；'chair' = 服务端拿议题做初始提案
  agree          INTEGER NOT NULL DEFAULT 0,
  disagree       INTEGER NOT NULL DEFAULT 0,
  abstain        INTEGER NOT NULL DEFAULT 0,
  invalid        INTEGER NOT NULL DEFAULT 0,  -- 没表态的人数（超时/崩/解析不出）
  consensus      INTEGER NOT NULL DEFAULT 0,
  started_at     INTEGER,
  ended_at       INTEGER,
  PRIMARY KEY (council_id, round_no)
);

-- 每人每轮一行：发言 + 结构化尾块。
--
-- 表决模式用 vote/vote_reason/proposal_text/second_floor；分析模式用 stance/findings_json。
-- 两套字段**互不覆盖**，各写各的（同一行不会两套都有，但表结构上不加约束 —— 一场会的 mode
-- 是行级事实，靠 councils.mode 判断该读哪一套）。
--
-- **留 NULL = 未表态**（进程超时 / 崩了 / 输出解析不出）：这时 status 记真实原因，
-- 界面写「未表态」并显示 error 原文 —— 绝不能因为"没回话"就默认它同意、弃权或"没意见"。
CREATE TABLE IF NOT EXISTS council_utterances (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  council_id    TEXT NOT NULL,
  round_no      INTEGER NOT NULL,
  floor_id      TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'speaker'
                CHECK (role IN ('chair','speaker')),  -- chair = 服务端的议题陈述
  content       TEXT,                      -- 发言正文
  vote          TEXT CHECK (vote IS NULL OR vote IN ('agree','disagree','abstain')),
  vote_reason   TEXT,                      -- 一句话理由
  proposal_text TEXT,                      -- 投反对者提交的修订案（下轮的候选）
  second_floor  TEXT,                      -- 附议了哪个楼层的提案（选下一轮提案用）
  -- 分析模式的立场（councils.mode='analysis' 时才有值）。NULL = 未表态，不猜。
  stance        TEXT CHECK (stance IS NULL OR stance IN ('support','oppose','unsure')),
  -- 分析模式的结构化要点：{"points":[…],"risks":[…],"questions":[…]}。
  -- **NULL = 整个尾块没解析出来，不是"三条都空"**（后者是 {"points":[],"risks":[],"questions":[]}）——
  -- 这两件事在界面上显示得不一样（「没按约定给要点」vs「给了，是空的」）。
  findings_json TEXT,
  status        TEXT NOT NULL DEFAULT 'ok'
                CHECK (status IN ('ok','failed','timeout','unparsed')),
  error         TEXT,                      -- 失败原文（stderr 摘要 / 超时说明）
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  started_at    INTEGER,
  ended_at      INTEGER,
  duration_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_council_utt ON council_utterances(council_id, round_no, floor_id);
