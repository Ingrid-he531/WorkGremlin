-- WorkGremlin schema v1
-- Conventions:
--   * All times are UTC milliseconds INTEGER
--   * Enums use TEXT + CHECK
--   * JSON fields are stored as TEXT
--   * Security baseline: PRAGMA secure_delete=ON is set by db/index.js when **each connection** opens
--     (that PRAGMA is not persistent)
--
-- Domain model: the **project** is the only ownership unit — one projects row per project directory,
-- and members / tasks / messages / events all hang off project_id. Demo data is one independent "demo
-- project" row, sitting alongside real projects (there is no longer a team concept).
--
-- Security note: the real line of defense is that **redaction happens before persisting and before building
-- the FTS index**; content / raw_json in this schema may only ever hold already-redacted content.

CREATE TABLE IF NOT EXISTS projects (
  id                    TEXT PRIMARY KEY,   -- Project identifier (slug derived from the directory name)
  name                  TEXT NOT NULL,
  workspace_path        TEXT NOT NULL,
  main_conversation_id  TEXT,
  source                TEXT NOT NULL DEFAULT 'report' CHECK (source IN ('report', 'watch')),
  created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_ws ON projects(workspace_path);

CREATE TABLE IF NOT EXISTS members (
  id             TEXT PRIMARY KEY,          -- "leader@my-project"
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  role           TEXT,
  session_id     TEXT,
  reported       INTEGER NOT NULL DEFAULT 0, -- 1 = connected to active reporting (route B)
  created_at     INTEGER NOT NULL,
  -- Ephemeral member (no station; a ghost in the scene): members who "team up temporarily per project",
  -- such as subagents
  ephemeral      INTEGER NOT NULL DEFAULT 0,
  -- The project name the ephemeral member belongs to (the UI falls back to role when absent)
  project_label  TEXT,
  -- Source client: codebuddy / cline / codex / claude; NULL = unknown (demo data, manual scripts).
  -- This is what the office filters on by "the current floor's client" (NULL counts as generic, shown on
  -- every floor).
  client         TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_project ON members(project_id, name);

-- Explicit non-task state. Busy here is only the resident gremlin's borrowed state while a summon runs;
-- idle is represented by no row. Main-agent busy is always derived from tasks.state.
CREATE TABLE IF NOT EXISTS agent_status (
  member_id          TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  state              TEXT NOT NULL CHECK (state = 'busy'),
  state_since        INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_state ON agent_status(state);

-- Explicit authorization waits. A row exists only while that session is blocked.
CREATE TABLE IF NOT EXISTS session_status (
  member_id          TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  session_id         TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state = 'blocked'),
  state_since        INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (member_id, session_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_id       TEXT NOT NULL,
  parent_task_id  TEXT,
  title           TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  progress        REAL,
  started_at      INTEGER,
  ended_at        INTEGER,
  -- Internal reason for a cancellation that should not be replayed by the live task feed.
  cancel_reason   TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_member_state ON tasks(member_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_project_started ON tasks(project_id, started_at);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,  -- Cursor / virtual scrolling
  dedupe_key   TEXT UNIQUE,                        -- A/B dedupe
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ts_ms        INTEGER NOT NULL,
  from_member  TEXT NOT NULL,
  to_member    TEXT,                               -- NULL = broadcast
  type         TEXT NOT NULL,
  subject      TEXT,
  content      TEXT,
  task_id      TEXT,
  -- Axis 2 (session): which session this message came from (the hook payload's session_id / plugin session id).
  -- One member (the same agent on the same floor) can have several sessions open at once; this tells them apart.
  -- NULL = old data or a report carrying no session identifier (demo data, manual scripts/subagents.js).
  session_id   TEXT,
  source       TEXT NOT NULL DEFAULT 'report',
  raw_json     TEXT,
  -- Archiving (logic implemented in M1; M0 only creates the column and index)
  archived_at  INTEGER,
  -- 1 = the body was stored truncated (only a summary is kept past the threshold); the UI must show
  -- "content truncated"
  content_truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_project_ts   ON messages(project_id, ts_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_from         ON messages(project_id, from_member, ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to           ON messages(project_id, to_member, ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_messages_type         ON messages(project_id, type, ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_messages_archived     ON messages(project_id, archived_at);
-- Note: the index on session_id is created in migrate(), not here — schema.sql runs before migrate(), and an
-- old db does not yet have the session_id column, so creating the index here would fail with "no such column".
-- See migrate() in db/index.js.

-- Chinese search: trigram is mandatory (unicode61 treats a whole Chinese paragraph as one token, making
-- Chinese search unusable)
-- Note: trigram recall is poor for queries shorter than 3 characters; M2 must downgrade 1~2 character
-- queries at the search layer to a LIKE scan limited to a time range.
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

-- **How many times each tool was used** in one turn of user work (task records → the task details' "tool
-- usage").
-- The shape is "one accumulated row per (task_id, tool)", not one row per call: Bash can run hundreds of
-- times in a turn, and logging each call only bloats the db while queries still need a GROUP BY. The reporter
-- increments the count by 1 per call (see bus.toolUse).
-- task_id is tasks.id / task_runs.id (that turn of user work); calls with no task id are not recorded
-- (task details are viewed per task, so a record with no task has nowhere to hang — never misattribute it to
-- another task).
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

-- The ledger of one turn of **user work** (the report's main table).
-- The primary key is tasks.id (that turn's task of the main agent); no separate id space — the turn's start
-- and end, its input (the user's words) and its output all live in tasks / artifacts, and this table only adds
-- the few columns "the report needs to compute".
-- Without truth, leave NULL; never fabricate.
--
-- The **uniform semantics** of the four token columns (each floor's raw rule differs; normalized before
-- persisting, see reporter/src/usage.js):
--   input_tokens       = the part of this turn's input that **missed the cache**
--   cache_read_tokens  = this turn's input that hit the cache
--   cache_write_tokens = this turn's input written into the cache
--   output_tokens      = what the model produced this turn (**including thinking**)
-- It always holds that input + cache_read + cache_write = the total prompt length of every request this turn.
-- Why normalization is needed: Claude / Kilo / OpenCode's raw `input` never included the cache, while Codex
-- and CodeBuddy's relayed reports have `input_tokens` (prompt_tokens) **including** cache hits (measured on
-- this machine: hit+miss==prompt held in 142/142 rows).
-- Without normalization, the same column records the whole context on 1F/3F and only the small cache-missing
-- part on 4F/7F/8F.
-- Turn granularity: **every API request** inside one turn of user work counts (the billing rule), not "the
-- last request's context".
CREATE TABLE IF NOT EXISTS task_runs (
  id                  TEXT PRIMARY KEY,   -- = tasks.id
  project_id          TEXT NOT NULL,
  member_id           TEXT NOT NULL,      -- main agent: codebuddy@<project> / codex@<project>
  client              TEXT,               -- codebuddy / cline / codex / claude
  -- Axis 2 (session): which session this turn of user work belongs to. When one agent has two sessions open at
  -- once, the report must be able to tell "which session made these changes". NULL = old data / a report with
  -- no session identifier.
  session_id          TEXT,
  -- The **form** this turn ran as: 'cli' / 'plugin' (IDE extension).
  -- When both forms of one product share the same disk state and the same client (3F Codex: the CLI and the
  -- VS Code extension share ~/.codex and both report client codex), the task list uses this to label
  -- "Codex CLI / Codex Plugin".
  -- Products that cannot tell them apart (Claude / Qoder…) and old data leave NULL — display falls back to
  -- writing just the product name.
  form                TEXT,
  model               TEXT,               -- Model used (reported by the hook; NULL = not reported)
  title               TEXT,               -- Input: the user's words
  result              TEXT,               -- Output: closing summary / completion summary
  file_count          INTEGER,            -- Files changed this turn (NULL = unknown)
  files_json          TEXT,               -- List of files changed this turn (JSON array, at most 8 entries)
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER,
  started_at          INTEGER,
  ended_at            INTEGER,
  duration_ms         INTEGER             -- Elapsed time = ended_at - started_at
);
CREATE INDEX IF NOT EXISTS idx_task_runs_project_started ON task_runs(project_id, started_at DESC);
-- As above: idx_task_runs_session is created in migrate().

-- One row per **subagent instance summoned** this turn (ghosts).
-- Not deleted when a ghost disperses (purgeMember): this is the only ledger of "how many subagents this turn
-- used" — whether they have a small station (susan) or are station-less instances spawned directly by a
-- built-in expert (code-explorer), all are recorded.
CREATE TABLE IF NOT EXISTS subagent_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT NOT NULL,
  parent_task_id TEXT,                    -- The turn of user work that summoned it = task_runs.id
  task_id        TEXT,                    -- The ghost's own tasks.id (used to fetch its output artifacts)
  member_id      TEXT NOT NULL,           -- subagent-<name>@<project>
  name           TEXT NOT NULL,           -- Type: susan / simmon / code-explorer / general-purpose…
  client         TEXT,
  model          TEXT,
  title          TEXT,                    -- Its task for this job
  agent_id       TEXT,                    -- Product-reported child identity (Claude/Codex agent_id)
  session_id     TEXT,                    -- Session scope used to restore and revive a ghost
  call_id        TEXT,                    -- Per-call identity that opened the ghost (tool_use_id / call id)
  background     INTEGER,                 -- 1 = asynchronous child that may outlive its parent turn
  result         TEXT,                    -- Closing summary (output)
  files_json     TEXT,                    -- Files changed this turn (JSON array of {path,added,removed}, at most 10 entries)
  started_at     INTEGER,
  ended_at       INTEGER,
  duration_ms    INTEGER,                 -- Elapsed time
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

-- Server-persisted settings key-value table (currently only records the retention days, retentionDays).
-- Written by the server only; the frontend reads / modifies it through /api/v1/settings/retention.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============================ Council Chamber ============================
--
-- A moderated review loop over one topic. This is the only place in the repo where **the server spawns
-- external agent processes** (everywhere else the user starts the agent process themselves), so this group
-- of tables is deliberately kept separate from the office set:
--   · No project_id, and nothing is written into members / tasks / task_runs — participants do not enter the
--     office, do not occupy a station, and are not counted in the task ledger or the token totals; they are
--     visible only on the council page.
--   · Participants are **read-only** in every phase: no write/edit tool is enabled (see
--     server/src/council/agents.js). The server writes the final report only into the WorkGremlin home
--     directory — never into the user's workspace, even when one was supplied for the participants.
--   · The same iron rule applies: if a process crashes / times out / its output cannot be parsed, record the
--     real status and keep the raw error — **never supply an opinion on its behalf**.
--
-- Flow:
--   round 0            kind='plan'    moderator: topic decomposition + review assignment
--   round 1..N         kind='debate'  proposal -> independent reviews -> moderator convergence (a RoundResult)
--   final phase        moderator adjudication -> main answerer final draft + change notes -> report files
--
-- There is no vote, no vote tally, no threshold, and no consensus-by-vote. Rounds run to max_rounds, but a
-- failed / timed-out / unparseable required turn stops the meeting immediately (fail-fast), as does cancel.

-- One meeting.
CREATE TABLE IF NOT EXISTS councils (
  id            TEXT PRIMARY KEY,          -- c_<timestamp>_<random>
  topic         TEXT NOT NULL,             -- Topic body (the text the user pasted)
  -- The participants' working directory (absolute path, validated on creation to exist and be a directory).
  -- NULL = no workspace given: the server creates a one-off temp directory and deletes it when done.
  -- When it is not NULL that directory belongs to the user and is never written to or deleted by a meeting.
  workspace_path TEXT,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','running','done','failed','cancelled')),
  max_rounds    INTEGER NOT NULL,          -- Upper bound on debate rounds (excluding round 0, the plan)
  round_current INTEGER NOT NULL DEFAULT 0,-- Highest round reached; 0 = only the plan has run
  -- completed  — adjudication and final draft were both produced
  -- partial    — the flow stopped after at least one round, but some final-phase turn failed
  -- needs_clarification — the moderator stopped before review to ask for a precise topic/path/material
  -- cancelled  — the user cancelled
  -- failed     — nothing usable was produced
  verdict       TEXT
                CHECK (verdict IS NULL OR verdict IN ('completed','partial','needs_clarification','cancelled','failed')),
  error         TEXT,                      -- Meeting-level failure reason (per-turn failures live in utterances)
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_councils_created ON councils(created_at DESC);

-- Attendees = one seat per floor selected at creation. Exactly one row has role='moderator' and exactly one
-- has role='main'; every other seat is role='reviewer'. cli_path is the detected absolute executable path.
CREATE TABLE IF NOT EXISTS council_participants (
  council_id TEXT NOT NULL,
  floor_id   TEXT NOT NULL,                -- '1F' / '4F' / '7F' / '8F'
  role       TEXT NOT NULL
             CHECK (role IN ('moderator','main','reviewer')),
  agent      TEXT NOT NULL,                -- codebuddy / claude / kilo / opencode
  cli_path   TEXT,                         -- cliInstallPath; NULL = not detected at the time
  model      TEXT,                         -- optional per-seat --model; NULL = the CLI's own default
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','running','ok','failed','unparsed','needs_clarification','skipped','cancelled')),
  error      TEXT,
  PRIMARY KEY (council_id, floor_id)
);

-- Inlined background material. content holds **the text that was actually sent** (already truncated to the
-- limit); bytes_total is the file's original size (NULL when unreadable, not 0).
CREATE TABLE IF NOT EXISTS council_materials (
  council_id     TEXT NOT NULL,
  ord            INTEGER NOT NULL,
  path           TEXT NOT NULL,
  bytes_total    INTEGER,
  bytes_included INTEGER,
  truncated      INTEGER NOT NULL DEFAULT 0,
  content        TEXT,
  PRIMARY KEY (council_id, ord)
);

-- One row per round. round_no = 0 is the moderator's plan (kind='plan'); 1..N are debate rounds
-- (kind='debate'). Every debate row is a complete RoundResult:
--   proposal_*    — the proposal under review this round (version, verbatim text, diff from the previous one)
--   moderator_json — the moderator's convergence result: consensus / openIssues / conflicts /
--                    revisionDirectives. The convergence score is **not** stored here: it is computed by the
--                    server from the reviews and the conflict list (council/convergence.js), so a model
--                    cannot inflate it.
--   stats_json    — server-computed review counts and score breakdown for this round.
CREATE TABLE IF NOT EXISTS council_rounds (
  council_id    TEXT NOT NULL,
  round_no      INTEGER NOT NULL,          -- 0 = plan
  kind          TEXT NOT NULL CHECK (kind IN ('plan','debate')),
  version       TEXT,                      -- 'v1', 'v2', ... only for debate rounds
  proposal_text TEXT,                      -- Verbatim proposal under review
  diff_from_prev TEXT,                     -- What changed versus the previous round (NULL for v1)
  proposal_from TEXT,                      -- Floor id of the main answerer
  moderator_json TEXT,                     -- Plan JSON (round 0) or convergence JSON (debate rounds)
  stats_json    TEXT,                      -- Server-computed counts + score breakdown
  started_at    INTEGER,
  ended_at      INTEGER,
  PRIMARY KEY (council_id, round_no)
);

-- One row per ReviewPoint. Reviewers submit structured points, not free text.
CREATE TABLE IF NOT EXISTS council_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  council_id  TEXT NOT NULL,
  round_no    INTEGER NOT NULL,
  reviewer    TEXT NOT NULL,               -- Reviewer floor id
  severity    TEXT NOT NULL
              CHECK (severity IN ('blocker','major','minor','nit')),
  dimension   TEXT NOT NULL,               -- e.g. 架构 / 性能 / 安全; free-form but normalized server-side
  issue       TEXT NOT NULL,
  evidence    TEXT,                        -- Quoted proposal text / code line / material
  suggestion  TEXT NOT NULL,
  stance      TEXT NOT NULL
              CHECK (stance IN ('reject','revise','accept')),
  ord         INTEGER NOT NULL DEFAULT 0,  -- Preserves the order the reviewer submitted them
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_council_reviews ON council_reviews(council_id, round_no, reviewer, ord);

-- One row per spoken turn, including the system-rendered topic statement. This is the raw audit trail: the
-- parsed structured blocks also live in council_rounds / council_reviews, but the original text is kept here.
--
-- **status='unparsed' means the turn produced text but no usable structured block.** That is different from
-- `parse_dropped` (how many malformed review items were discarded) and from a failed process. The UI shows
-- the real reason and the raw error; it never treats missing output as acceptance.
CREATE TABLE IF NOT EXISTS council_utterances (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  council_id    TEXT NOT NULL,
  round_no      INTEGER NOT NULL,
  floor_id      TEXT NOT NULL,             -- 'system' for the topic statement
  phase         TEXT NOT NULL
                CHECK (phase IN ('brief','plan','proposal','review','moderation','adjudication','final')),
  content       TEXT,
  model         TEXT,                      -- Best-effort model id parsed from CLI output; NULL = unknown
  status        TEXT NOT NULL DEFAULT 'ok'
                CHECK (status IN ('ok','failed','timeout','unparsed')),
  error         TEXT,
  error_kind    TEXT,                      -- auth / model / network / quota / timeout / protocol / ...
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  parse_dropped INTEGER NOT NULL DEFAULT 0,
  started_at    INTEGER,
  ended_at      INTEGER,
  duration_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_council_utt ON council_utterances(council_id, round_no, floor_id);
CREATE INDEX IF NOT EXISTS idx_council_utt_floor ON council_utterances(council_id, floor_id);

-- Final output of a meeting. Written once when the run ends (or fails part-way, with whatever exists).
-- report_json is the complete machine-readable archive; files_json lists where the exported files landed.
CREATE TABLE IF NOT EXISTS council_reports (
  council_id         TEXT PRIMARY KEY,
  adjudication_json  TEXT,                 -- Moderator's final adjudication
  adjudication_text  TEXT,
  final_draft_text   TEXT,                 -- Main answerer's final draft
  change_notes       TEXT,                 -- What changed from the last debated proposal
  report_json        TEXT,
  files_json         TEXT,
  created_at         INTEGER NOT NULL
);
