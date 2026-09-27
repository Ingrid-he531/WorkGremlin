'use strict';

/**
 * SQLite 数据访问层。
 *
 * 安全基线（M0 强制，leader/main 已定，不得自行关闭）：
 *   1. 每个连接打开即 `PRAGMA secure_delete = ON` —— 该 PRAGMA **不持久化**，必须每连接设置。
 *      作用：删除/更新时用 0 覆写旧内容，避免明文残留在 freelist 页里被 grep 出来。
 *   2. WAL checkpoint 策略：
 *      - `wal_autocheckpoint = 512` 页（约 2MB）自动 checkpoint；
 *      - 每 30s 由定时器主动 `PRAGMA wal_checkpoint(PASSIVE)`；
 *      - 关闭时 / 执行删除-归档后执行 `PRAGMA wal_checkpoint(TRUNCATE)`（否则旧页仍留在 -wal 文件里）；
 *   3. db / -wal / -shm 文件权限 0600。
 *   4. `synchronous = NORMAL`（WAL 模式下安全且更快）。
 *
 * 真正的防线是**脱敏在入库与建 FTS 索引之前**完成；DB 内不应出现明文。
 * 若发现明文落库 —— 按 P0 缺陷立即上报，不要自行修改脱敏逻辑。
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DEFAULTS } = require('@workgremlin/shared');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function chmod600(file) {
  try {
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  } catch {
    /* 非 POSIX 忽略 */
  }
}

/** @param {import('better-sqlite3').Database} db */
function tableExists(db, name) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

/** @param {import('better-sqlite3').Database} db */
function hasColumn(db, table, column) {
  if (!tableExists(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

/**
 * 增量补列：schema.sql 只管"建新库"，老库要补的列在这里加。
 * SQLite 没有 ADD COLUMN IF NOT EXISTS，所以先查 table_info 再决定。
 * @param {import('better-sqlite3').Database} db
 */
function ensureColumn(db, table, column, ddl) {
  if (hasColumn(db, table, column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

/** @param {import('better-sqlite3').Database} db */
function migrate(db) {
  ensureColumn(db, 'members', 'ephemeral', 'ephemeral INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'members', 'project_label', 'project_label TEXT');
  ensureColumn(db, 'members', 'client', 'client TEXT');
  ensureColumn(db, 'subagent_runs', 'files_json', 'files_json TEXT');
  ensureColumn(db, 'task_runs', 'baseline_commit', 'baseline_commit TEXT');
  // 轴 2（会话）：老库里没有这两列，补上；老行留 NULL（不是"没有会话"，是"当时还没记"）
  ensureColumn(db, 'task_runs', 'session_id', 'session_id TEXT');
  ensureColumn(db, 'messages', 'session_id', 'session_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_runs_session ON task_runs(project_id, session_id, started_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(project_id, session_id, ts_ms DESC)');
  ensureAgentStatusThinking(db);
}

/**
 * 老库的 agent_status.state 带旧 CHECK 约束（不含 thinking），
 * 而 CREATE TABLE IF NOT EXISTS 不会改已有表的约束。
 * 运行时状态表，内容可丢（下个上报/心跳会补齐），所以重建该表放宽为包含 thinking。
 * @param {import('better-sqlite3').Database} db
 */
function ensureAgentStatusThinking(db) {
  let sql = '';
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_status'").get();
    sql = (row && row.sql) || '';
  } catch {
    return;
  }
  if (!sql || /thinking/.test(sql)) return; // 已是新约束或表不存在
  db.exec(`
    ALTER TABLE agent_status RENAME TO _agent_status_old;
    CREATE TABLE agent_status (
      member_id          TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
      state              TEXT NOT NULL CHECK (state IN ('online', 'busy', 'idle', 'blocked', 'offline', 'thinking')),
      state_since        INTEGER NOT NULL,
      task_id            TEXT,
      progress           REAL,
      current_files      TEXT,
      last_heartbeat_at  INTEGER,
      degraded           INTEGER NOT NULL DEFAULT 0,
      source             TEXT NOT NULL DEFAULT 'report' CHECK (source IN ('report', 'watch', 'timeout')),
      updated_at         INTEGER NOT NULL
    );
    INSERT INTO agent_status
      (member_id, state, state_since, task_id, progress, current_files, last_heartbeat_at, degraded, source, updated_at)
    SELECT member_id, state, state_since, task_id, progress, current_files, last_heartbeat_at, degraded, source, updated_at
    FROM _agent_status_old;
    DROP TABLE _agent_status_old;
    CREATE INDEX IF NOT EXISTS idx_status_state ON agent_status(state);
  `);
}

/** 带 team_id 的老表（projec改成 project 之前的那一版 schema） */
const LEGACY_TEAM_TABLES = ['members', 'tasks', 'messages', 'events'];

/** 迁移前留一份全量备份，万一迁移出来的结果不对还能回滚 */
function backupLegacyDatabase(db, dbPath) {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    const dest = `${dbPath}.legacy-team-${Date.now()}`;
    fs.copyFileSync(dbPath, dest);
    chmod600(dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * team 时代 → project 时代的一次性迁移。
 *
 * 必须抢在 exec(schema.sql) 之前跑：schema.sql 里有一批 `CREATE INDEX ...(project_id, ...)`，
 * 老表（members / tasks / messages / events）只有 team_id，db.exec 会当场挂在
 * "no such column: project_id"，服务端起不来且不知道为什么。
 *
 * 做法：老行读进内存 → 丢掉老表（schema.sql 随后按最新定义重建）→ 建完回填，
 * 顺手把 team_id 写成 project_id、members.project 写成 project_label。
 * 全程 foreign_keys=OFF（连默认值就是这样），免得 DROP 时级联把 agent_status / 历史一起带走。
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Record<string, any[]> | null} 需要回填的老行；null = 这个库不用迁
 */
function migrateLegacyTeamSchema(db) {
  // 判据只看「还有表挂着 team_id」：teams 表本身允许留着（里面是历史工程），
  // 只看它会导致每次启动都误判成待迁移、白备份一遍库。
  const legacyTables = LEGACY_TEAM_TABLES.filter((t) => hasColumn(db, t, 'team_id'));
  if (!legacyTables.length) return null;

  // teams 就是当年的 projects：抄过去，IGNORE 保证重复启动不会重写
  if (tableExists(db, 'teams') && tableExists(db, 'projects')) {
    db.exec(`
      INSERT OR IGNORE INTO projects (id, name, workspace_path, main_conversation_id, source, created_at)
      SELECT id, name, workspace_path, main_conversation_id, source, created_at FROM teams
    `);
  }

  const snap = {};
  for (const t of legacyTables) {
    snap[t] = db.prepare(`SELECT * FROM ${t}`).all();
    if (t === 'messages') {
      // messages_fts 是 external content 虚表（content='messages'），必须跟着一起拆，
      // 留给 schema.sql 重建；回填完再 rebuild 索引。
      db.exec(`
        DROP TRIGGER IF EXISTS messages_ai;
        DROP TRIGGER IF EXISTS messages_ad;
        DROP TRIGGER IF EXISTS messages_au;
        DROP TABLE IF EXISTS messages_fts;
      `);
    }
    db.exec(`DROP TABLE ${t}`);
  }
  return snap;
}

/**
 * schema.sql 把表按最新定义建好之后，回填迁移前捞出来的老行。
 * 落不进去的（引用了不存在的工程）跳过并计数 —— 宁可少几条历史，也不让 server 起不来。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, any[]> | null} snap
 */
function restoreLegacyRows(db, snap) {
  if (!snap) return 0;
  const known = new Set(db.prepare('SELECT id FROM projects').all().map((r) => r.id));
  if (!known.size) return 0;
  const now = Date.now();
  let restored = 0;

  const members = db.prepare(`
    INSERT OR IGNORE INTO members
      (id, project_id, name, role, session_id, reported, created_at, last_seen_at, ephemeral, project_label, client)
    VALUES
      (@id, @projectId, @name, @role, @sessionId, @reported, @createdAt, @lastSeenAt, @ephemeral, @projectLabel, @client)
  `);
  const tasks = db.prepare(`
    INSERT OR IGNORE INTO tasks
      (id, project_id, member_id, parent_task_id, title, state, progress, started_at, ended_at)
    VALUES
      (@id, @projectId, @memberId, @parentTaskId, @title, @state, @progress, @startedAt, @endedAt)
  `);
  const messages = db.prepare(`
    INSERT OR IGNORE INTO messages
      (dedupe_key, project_id, ts_ms, from_member, to_member, type, subject, content, task_id, session_id, source, raw_json, archived_at, content_truncated)
    VALUES
      (@dedupeKey, @projectId, @tsMs, @fromMember, @toMember, @type, @subject, @content, @taskId, NULL, @source, @rawJson, @archivedAt, @contentTruncated)
  `);
  const events = db.prepare(
    `INSERT OR IGNORE INTO events (project_id, ts_ms, kind, payload_json) VALUES (@projectId, @tsMs, @kind, @payloadJson)`
  );

  const put = (fn, row) => {
    try {
      fn(row);
      restored += 1;
    } catch {
      /* 单行失败不影响其余：历史数据少一条，好过服务起不来 */
    }
  };

  for (const r of snap.members || []) {
    if (!known.has(r.team_id)) continue;
    put(members.run.bind(members), {
      id: r.id,
      projectId: r.team_id,
      name: r.name,
      role: r.role ?? null,
      sessionId: r.session_id ?? null,
      reported: r.reported ?? 0,
      createdAt: r.created_at ?? now,
      lastSeenAt: r.last_seen_at ?? null,
      ephemeral: r.ephemeral ?? 0,
      // 老库的 members.project（临时成员所属项目名）改名叫 project_label 了
      projectLabel: r.project ?? null,
      client: null,
    });
  }
  for (const r of snap.tasks || []) {
    if (!known.has(r.team_id)) continue;
    put(tasks.run.bind(tasks), {
      id: r.id,
      projectId: r.team_id,
      memberId: r.member_id,
      parentTaskId: r.parent_task_id ?? null,
      title: r.title,
      state: r.state,
      progress: r.progress ?? null,
      startedAt: r.started_at ?? null,
      endedAt: r.ended_at ?? null,
    });
  }
  for (const r of snap.messages || []) {
    if (!known.has(r.team_id)) continue;
    put(messages.run.bind(messages), {
      dedupeKey: r.dedupe_key ?? null,
      projectId: r.team_id,
      tsMs: r.ts_ms,
      fromMember: r.from_member,
      toMember: r.to_member ?? null,
      type: r.type,
      subject: r.subject ?? null,
      content: r.content ?? null,
      taskId: r.task_id ?? null,
      source: r.source ?? 'report',
      rawJson: r.raw_json ?? null,
      archivedAt: r.archived_at ?? null,
      contentTruncated: r.content_truncated ?? 0,
    });
  }
  for (const r of snap.events || []) {
    if (!known.has(r.team_id)) continue;
    put(events.run.bind(events), {
      projectId: r.team_id,
      tsMs: r.ts_ms,
      kind: r.kind,
      payloadJson: r.payload_json ?? null,
    });
  }

  if (snap.messages && snap.messages.length) {
    try {
      db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
    } catch {
      /* FTS 重建失败不影响主流程：搜索退化为不可用，历史消息照常可读 */
    }
  }
  return restored;
}

function applyPragmas(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('secure_delete = ON');
  db.pragma(`wal_autocheckpoint = ${DEFAULTS.WAL_AUTOCHECKPOINT_PAGES}`);
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
}

/**
 * 打开（并初始化）数据库。
 * @param {string} dbPath
 * @returns {{ db: import('better-sqlite3').Database, repo: ReturnType<typeof createRepo>, checkpoint: (mode?: string) => any, startCheckpointLoop: () => NodeJS.Timeout, close: () => void }}
 */
function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });

  const db = new Database(dbPath);

  // team 时代的老库先迁到 project 时代 —— 必须早于 applyPragmas（foreign_keys=ON）与 schema，
  // 否则 exec(schema.sql) 里那几条 (project_id, ...) 索引会直接 "no such column" 把启动掐死。
  db.pragma('foreign_keys = OFF');
  const legacy = migrateLegacyTeamSchema(db);
  if (legacy) {
    const backup = backupLegacyDatabase(db, dbPath);
    console.warn(
      `[workgremlin] 检测到 team 时代的老库，已迁移到 project 时代${backup ? `（备份：${backup}）` : ''}`
    );
  }

  applyPragmas(db);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  const restored = restoreLegacyRows(db, legacy);
  if (restored) console.warn(`[workgremlin] 老库迁移完成，回填 ${restored} 行历史数据`);

  chmod600(dbPath);
  chmod600(`${dbPath}-wal`);
  chmod600(`${dbPath}-shm`);

  const repo = createRepo(db);

  /**
   * @param {'PASSIVE'|'FULL'|'RESTART'|'TRUNCATE'} [mode]
   */
  function checkpoint(mode = 'PASSIVE') {
    const res = db.pragma(`wal_checkpoint(${mode})`);
    chmod600(dbPath);
    chmod600(`${dbPath}-wal`);
    chmod600(`${dbPath}-shm`);
    return res;
  }

  function startCheckpointLoop() {
    const timer = setInterval(() => {
      try {
        checkpoint('PASSIVE');
      } catch {
        /* 忽略：checkpoint 失败不影响可用性，下一轮重试 */
      }
    }, DEFAULTS.WAL_CHECKPOINT_INTERVAL_MS);
    if (timer.unref) timer.unref();
    return timer;
  }

  function close() {
    try {
      checkpoint('TRUNCATE');
    } catch {
      /* ignore */
    }
    db.close();
  }

  return { db, repo, checkpoint, startCheckpointLoop, close };
}

/**
 * 预编译语句集合。所有写入方法都不允许编造数据：未知字段一律写 NULL。
 * @param {import('better-sqlite3').Database} db
 */
function createRepo(db) {
  const stmt = {
    upsertProject: db.prepare(`
      INSERT INTO projects (id, name, workspace_path, main_conversation_id, source, created_at)
      VALUES (@id, @name, @workspacePath, @mainConversationId, @source, @createdAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        workspace_path = excluded.workspace_path,
        main_conversation_id = excluded.main_conversation_id
    `),
    listProjects: db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`),
    getProject: db.prepare(`SELECT * FROM projects WHERE id = ?`),
    getProjectByWorkspace: db.prepare(`SELECT * FROM projects WHERE workspace_path = ?`),

    upsertMember: db.prepare(`
      INSERT INTO members (id, project_id, name, role, session_id, reported, created_at, last_seen_at, ephemeral, project_label, client)
      VALUES (@id, @projectId, @name, @role, @sessionId, @reported, @createdAt, @lastSeenAt, @ephemeral, @projectLabel, @client)
      ON CONFLICT(id) DO UPDATE SET
        role = COALESCE(excluded.role, members.role),
        session_id = COALESCE(excluded.session_id, members.session_id),
        reported = MAX(members.reported, excluded.reported),
        last_seen_at = MAX(COALESCE(members.last_seen_at, 0), COALESCE(excluded.last_seen_at, 0)),
        ephemeral = MAX(members.ephemeral, excluded.ephemeral),
        project_label = COALESCE(excluded.project_label, members.project_label),
        -- 来源客户端已知就覆盖（老库是 NULL，第一次上报/名册心跳会补上）
        client = COALESCE(excluded.client, members.client)
    `),
    tagMemberClient: db.prepare(`
      UPDATE members SET client = @client
      WHERE id = @id AND (client IS NULL OR client <> @client)
    `),
    getMember: db.prepare(`SELECT * FROM members WHERE id = ?`),
    listMembers: db.prepare(`SELECT * FROM members WHERE project_id = ? ORDER BY name`),
    listEphemeral: db.prepare(`SELECT * FROM members WHERE project_id = ? AND ephemeral = 1`),
    touchMember: db.prepare(`UPDATE members SET last_seen_at = ? WHERE id = ?`),

    upsertStatus: db.prepare(`
      INSERT INTO agent_status
        (member_id, state, state_since, task_id, progress, current_files, last_heartbeat_at, degraded, source, updated_at)
      VALUES
        (@memberId, @state, @stateSince, @taskId, @progress, @currentFiles, @lastHeartbeatAt, @degraded, @source, @updatedAt)
      ON CONFLICT(member_id) DO UPDATE SET
        state = excluded.state,
        state_since = CASE WHEN agent_status.state = excluded.state THEN agent_status.state_since ELSE excluded.state_since END,
        task_id = COALESCE(excluded.task_id, agent_status.task_id),
        progress = COALESCE(excluded.progress, agent_status.progress),
        current_files = COALESCE(excluded.current_files, agent_status.current_files),
        last_heartbeat_at = COALESCE(excluded.last_heartbeat_at, agent_status.last_heartbeat_at),
        degraded = excluded.degraded,
        source = excluded.source,
        updated_at = excluded.updated_at
    `),
    getStatus: db.prepare(`SELECT * FROM agent_status WHERE member_id = ?`),
    listStatuses: db.prepare(`
      SELECT s.* FROM agent_status s
      JOIN members m ON m.id = s.member_id
      WHERE m.project_id = ?
    `),
    insertStatusHistory: db.prepare(`
      INSERT INTO agent_status_history (member_id, state, ts_ms, reason, source) VALUES (?, ?, ?, ?, ?)
    `),

    insertTask: db.prepare(`
      INSERT INTO tasks (id, project_id, member_id, parent_task_id, title, state, progress, started_at, ended_at)
      VALUES (@id, @projectId, @memberId, @parentTaskId, @title, @state, @progress, @startedAt, @endedAt)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, state = excluded.state,
        progress = COALESCE(excluded.progress, tasks.progress),
        started_at = COALESCE(tasks.started_at, excluded.started_at)
    `),
    updateTask: db.prepare(`
      UPDATE tasks SET
        state = COALESCE(@state, state),
        progress = COALESCE(@progress, progress),
        ended_at = COALESCE(@endedAt, ended_at)
      WHERE id = @id
    `),
    getTask: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
    listTasks: db.prepare(`SELECT * FROM tasks WHERE project_id = ? ORDER BY started_at DESC`),

    insertMessage: db.prepare(`
      INSERT INTO messages (dedupe_key, project_id, ts_ms, from_member, to_member, type, subject, content, task_id, session_id, source, raw_json)
      VALUES (@dedupeKey, @projectId, @tsMs, @fromMember, @toMember, @type, @subject, @content, @taskId, @sessionId, @source, @rawJson)
      ON CONFLICT(dedupe_key) DO NOTHING
    `),
    getMessage: db.prepare(`SELECT * FROM messages WHERE id = ?`),
    countMessages: db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE project_id = ?`),
    countMessagesFor: db.prepare(
      `SELECT COUNT(*) AS c FROM messages WHERE project_id = ? AND (from_member = ? OR to_member = ?)`
    ),

    insertFileActivity: db.prepare(`
      INSERT INTO file_activity (member_id, path, op, ts_ms) VALUES (?, ?, ?, ?)
    `),
    listFileActivity: db.prepare(
      `SELECT * FROM file_activity WHERE member_id = ? ORDER BY ts_ms DESC LIMIT ?`
    ),
    trimFileActivity: db.prepare(`
      DELETE FROM file_activity WHERE member_id = ? AND id NOT IN (
        SELECT id FROM file_activity WHERE member_id = ? ORDER BY ts_ms DESC LIMIT ?
      )
    `),

    insertArtifact: db.prepare(`
      INSERT INTO artifacts (member_id, task_id, kind, title, path, ts_ms) VALUES (?, ?, ?, ?, ?, ?)
    `),
    listArtifacts: db.prepare(`SELECT * FROM artifacts WHERE member_id = ? ORDER BY ts_ms DESC LIMIT ?`),

    /** 最近一条已结束的任务：给「本轮改动文件」当时间窗边界（started_at..ended_at） */
    latestEndedTask: db.prepare(`
      SELECT * FROM tasks WHERE member_id = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1
    `),
    /* ---- 台账（报表用）：一轮用户任务 + 它召唤出去的 subagent 实例 ---- */
    upsertTaskRun: db.prepare(`
      INSERT INTO task_runs (id, project_id, member_id, client, session_id, model, title, started_at, baseline_commit)
      VALUES (@id, @projectId, @memberId, @client, @sessionId, @model, @title, @startedAt, @baselineCommit)
      ON CONFLICT(id) DO UPDATE SET
        client     = COALESCE(excluded.client, task_runs.client),
        session_id = COALESCE(excluded.session_id, task_runs.session_id),
        model      = COALESCE(excluded.model, task_runs.model),
        title      = COALESCE(excluded.title, task_runs.title),
        started_at = COALESCE(task_runs.started_at, excluded.started_at),
        baseline_commit = COALESCE(task_runs.baseline_commit, excluded.baseline_commit)
    `),
    endTaskRun: db.prepare(`
      UPDATE task_runs SET
        title       = COALESCE(@title, title),
        model       = COALESCE(@model, model),
        result      = COALESCE(@result, result),
        file_count  = COALESCE(@fileCount, file_count),
        files_json  = COALESCE(@filesJson, files_json),
        ended_at    = COALESCE(@endedAt, ended_at),
        duration_ms = COALESCE(@durationMs, duration_ms)
      WHERE id = @id
    `),
    listTaskRuns: db.prepare(`
      SELECT * FROM task_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?
    `),
    getTaskRun: db.prepare(`SELECT * FROM task_runs WHERE id = ?`),
    insertSubagentRun: db.prepare(`
      INSERT INTO subagent_runs
        (project_id, parent_task_id, task_id, member_id, name, client, model, title, started_at)
      VALUES
        (@projectId, @parentTaskId, @taskId, @memberId, @name, @client, @model, @title, @startedAt)
    `),
    endSubagentRun: db.prepare(`
      UPDATE subagent_runs SET
        model    = COALESCE(@model, model),
        result   = COALESCE(@result, result),
        files_json = COALESCE(@filesJson, files_json),
        ended_at = COALESCE(@endedAt, ended_at),
        duration_ms = CASE
          WHEN @endedAt IS NOT NULL AND started_at IS NOT NULL THEN @endedAt - started_at
          ELSE duration_ms
        END
      WHERE id = @id
    `),
    listSubagentRuns: db.prepare(`
      SELECT * FROM subagent_runs WHERE parent_task_id = ? ORDER BY started_at, id
    `),
    countSubagentRuns: db.prepare(`SELECT COUNT(*) AS c FROM subagent_runs WHERE parent_task_id = ?`),
    /** 删除：按顶层任务（及其 subagent 子任务）整条清掉，含台账/消息/产出 */
    selectChildTaskIds: db.prepare(`SELECT id FROM tasks WHERE parent_task_id IN (SELECT value FROM json_each(?))`),
    deleteTasksById: db.prepare(`DELETE FROM tasks WHERE id IN (SELECT value FROM json_each(?))`),
    deleteTaskRunsById: db.prepare(`DELETE FROM task_runs WHERE id IN (SELECT value FROM json_each(?))`),
    deleteSubagentRunsByParent: db.prepare(`DELETE FROM subagent_runs WHERE parent_task_id IN (SELECT value FROM json_each(?))`),
    deleteMessagesByTask: db.prepare(`DELETE FROM messages WHERE task_id IN (SELECT value FROM json_each(?))`),
    deleteArtifactsByTask: db.prepare(`DELETE FROM artifacts WHERE task_id IN (SELECT value FROM json_each(?))`),
    /**
     * 顶层任务 id 选择器：复用任务记录页的一级检索（工程 + 楼层），可选"早于某时刻"（保留最近 N 天）。
     * @client 是 ",a,b," 形式的 client 集合（合并楼层 1F CodeBuddy = CLI + Plugin 两个 client），
     * 用 instr 做成员判定 —— 单值走同一条路（",codebuddy," 也能命中 codebuddy）。
     */
    selectTopTaskIds: db.prepare(`
      SELECT t.id FROM tasks t
      LEFT JOIN task_runs tr ON tr.id = t.id
      LEFT JOIN members m ON m.id = t.member_id
      WHERE t.parent_task_id IS NULL
        AND (@project IS NULL OR t.project_id = @project)
        AND (@client IS NULL OR instr(@client, ',' || COALESCE(tr.client, m.client) || ',') > 0)
        AND (@before IS NULL OR t.started_at < @before)
    `),
    /**
     * 当前工程里**主 agent**（role='agent'，hook 上报的那位）正在跑的任务。
     * 召唤关系拿不到时（老 hook 写的清单没有 parent 字段）用它兜底认父：
     * 幽灵是主 agent 派出去的，它活着的时候主 agent 必然在跑某个用户任务。
     */
    mainRunningTask: db.prepare(`
      SELECT s.task_id AS taskId
      FROM agent_status s JOIN members m ON m.id = s.member_id
      WHERE m.project_id = ? AND m.role = 'agent' AND s.task_id IS NOT NULL
      ORDER BY COALESCE(s.last_heartbeat_at, s.updated_at) DESC
      LIMIT 1
    `),
    /**
     * 某成员当前进行中的任务（可能多条：同产品的不同会话各占一条）。
     * hook 的本地 taskId 被并发覆盖冲掉时，Stop 靠它回捞本轮任务（bug 3 兜底）。
     * 按会话挑哪一条由上层 currentTaskFor 决定，这里只负责把候选捞出来。
     */
    // 会话标识在报表层 task_runs（tasks 表本身没有 session_id 列），所以这里 JOIN 取。
    runningTaskForMember: db.prepare(`
      SELECT t.id AS taskId, t.title AS title, tr.session_id AS sessionId, t.started_at AS startedAt
      FROM tasks t
      LEFT JOIN task_runs tr ON tr.id = t.id
      WHERE t.member_id = ? AND t.state = 'running'
      ORDER BY t.started_at DESC
      LIMIT 5
    `),
    /**
     * 时间窗内该成员改动过的文件：按路径去重（同一文件反复改只算一个产出），取最近一次的时间。
     * op 一并带出来（收工兜底要它，见 bus.endTask）：SQLite 的 min/max 聚合规则里，
     * 裸列取的是**聚合命中那一行**（也就是时间最近的那次）的值，所以这里的 op 是"最后一次操作"。
     */
    listActivityInWindow: db.prepare(`
      SELECT path, op, MAX(ts_ms) AS ts_ms FROM file_activity
      WHERE member_id = ? AND ts_ms >= ? AND ts_ms <= ?
      GROUP BY path ORDER BY ts_ms DESC LIMIT ?
    `),

    insertEvent: db.prepare(`INSERT INTO events (project_id, ts_ms, kind, payload_json) VALUES (?, ?, ?, ?)`),
  };

  /**
   * 消息查询：按成员 / 类型 / 时间过滤 + 关键字搜索 + 游标分页。
   * M0 用 LIKE；M2 切换到 FTS5 trigram（<3 字查询自动降级为 LIKE，见 README 说明）。
   * @param {string} projectId
   * @param {{members?: string[], types?: string[], session?: string, since?: number, until?: number, keyword?: string, direction?: string, beforeId?: number, afterId?: number, limit?: number}} f
   *   session：只取某一条会话的消息（轴 2）。不传 = 所有会话（老行为）。
   */
  function listMessages(projectId, f = {}) {
    const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 1000);
    const where = ['project_id = @projectId'];
    const params = { projectId, limit };

    // 会话过滤：只认**精确等于**这条会话的。老消息（session_id IS NULL）不并入 ——
    // 「没带会话标识」跟「属于这条会话」是两回事，混进来就分不清了。
    if (f.session) {
      where.push('session_id = @session');
      params.session = String(f.session);
    }
    if (f.members && f.members.length) {
      const ph = f.members.map((_, i) => `@m${i}`);
      f.members.forEach((m, i) => {
        params[`m${i}`] = m;
      });
      where.push(`(from_member IN (${ph.join(',')}) OR to_member IN (${ph.join(',')}))`);
    }
    if (f.types && f.types.length) {
      const ph = f.types.map((_, i) => `@t${i}`);
      f.types.forEach((t, i) => {
        params[`t${i}`] = t;
      });
      where.push(`type IN (${ph.join(',')})`);
    }
    if (Number.isFinite(f.since)) {
      where.push('ts_ms >= @since');
      params.since = Number(f.since);
    }
    if (Number.isFinite(f.until)) {
      where.push('ts_ms <= @until');
      params.until = Number(f.until);
    }
    if (f.keyword) {
      where.push('(content LIKE @kw OR subject LIKE @kw)');
      params.kw = `%${f.keyword}%`;
    }
    if (Number.isFinite(f.beforeId)) {
      where.push('id < @beforeId');
      params.beforeId = Number(f.beforeId);
    }
    if (Number.isFinite(f.afterId)) {
      where.push('id > @afterId');
      params.afterId = Number(f.afterId);
    }

    const order = f.direction === 'asc' ? 'ASC' : 'DESC';
    return db
      .prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY ts_ms ${order}, id ${order} LIMIT @limit`)
      .all(params);
  }

  /**
   * 删除（归档）某个工程的全部数据 —— 演示 secure_delete + TRUNCATE 的完整链路。
   * 真实归档/保留策略在 M2 落地；此处保证"删了就真的抹掉"。
   * @param {string} projectId
   */
  function purgeProject(projectId) {
    const tx = db.transaction((id) => {
      db.prepare('DELETE FROM messages WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM file_activity WHERE member_id IN (SELECT id FROM members WHERE project_id = ?)').run(id);
      db.prepare('DELETE FROM artifacts WHERE member_id IN (SELECT id FROM members WHERE project_id = ?)').run(id);
      db.prepare('DELETE FROM agent_status WHERE member_id IN (SELECT id FROM members WHERE project_id = ?)').run(id);
      db.prepare('DELETE FROM agent_status_history WHERE member_id IN (SELECT id FROM members WHERE project_id = ?)').run(
        id
      );
      db.prepare('DELETE FROM members WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM events WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
    tx(projectId);
    // secure_delete 只保证 freelist 页被覆写；WAL 里的旧页要靠 TRUNCATE 清掉
    db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /**
   * 删掉一个成员及其附属行 —— 临时成员（幽灵）消失时用。
   *
   * 两类"发生过什么"的历史不删：
   *   · messages —— 一直如此；
   *   · **幽灵的 tasks / artifacts**（keepHistory）—— 一次召唤的"干了什么 / 产出是什么 /
   *     花了多久"全在这两行里，而 tasks.member_id 与 artifacts.member_id 都没有外键约束，
   *     成员行删了它们照样站得住。
   *     以前连它们一起删，于是：有小怪物的（susan）产出随幽灵蒸发；没小怪物的
   *     （code-explorer / 内置专家直接 spawn 的实例）更是**查都没处查** ——
   *     「这次用户任务用了几个 subagent」这条线就断在这儿。
   *     产出留在产出者名下（不再过户），"谁干的"不被改写；小怪物卡片靠
   *     bus.ghostArtifacts 借同名幽灵的产出来显示。
   *
   * @param {string} memberId
   * @param {{ keepHistory?: boolean }} [opts]
   */
  function purgeMember(memberId, opts = {}) {
    const keepHistory = Boolean(opts.keepHistory);
    const tx = db.transaction((id, keep) => {
      db.prepare('DELETE FROM file_activity WHERE member_id = ?').run(id);
      if (!keep) {
        db.prepare('DELETE FROM artifacts WHERE member_id = ?').run(id);
        db.prepare('DELETE FROM tasks WHERE member_id = ?').run(id);
      }
      db.prepare('DELETE FROM agent_status_history WHERE member_id = ?').run(id);
      db.prepare('DELETE FROM agent_status WHERE member_id = ?').run(id);
      db.prepare('DELETE FROM members WHERE id = ?').run(id);
    });
    tx(memberId, keepHistory);
  }

  /**
   * 整条删掉一组顶层任务（含其 subagent 子任务），以及对应的台账/消息/产出。
   * @param {string[]} topIds 顶层任务 id 列表
   * @returns {number} 删除的顶层任务条数
   */
  function deleteByTopIds(topIds) {
    if (!topIds.length) return 0;
    const topJson = JSON.stringify(topIds);
    const childRows = stmt.selectChildTaskIds.all(topJson);
    const allJson = JSON.stringify([...topIds, ...childRows.map((r) => r.id)]);
    const tx = db.transaction(() => {
      stmt.deleteMessagesByTask.run(allJson);
      stmt.deleteArtifactsByTask.run(allJson);
      stmt.deleteSubagentRunsByParent.run(topJson);
      stmt.deleteTaskRunsById.run(topJson);
      stmt.deleteTasksById.run(allJson);
    });
    tx();
    db.pragma('wal_checkpoint(TRUNCATE)');
    return topIds.length;
  }

  /**
   * 删单条任务记录（二次确认在客户端做；这里只负责真删）。
   * @param {string} id 顶层任务 id
   */
  function deleteTaskRun(id) {
    return deleteByTopIds([id]);
  }

  /**
   * 按一级检索（工程 + 楼层）删除；beforeTs 给定时只删早于该时刻的（保留最近 N 天）。
   * @param {{ project?: string, client?: string, beforeTs?: number }} opt
   *        client 可以是逗号分隔的一串（合并楼层 1F CodeBuddy = CLI + Plugin）
   * @returns {number} 删除的顶层任务条数
   */
  function deleteTaskRunsByFilter(opt = {}) {
    const projectArg = opt.project && opt.project !== 'all' ? opt.project : null;
    // client 可以是逗号分隔的一串（合并楼层一次删两路），也可以是一个值。
    // 统一包成 ",a,b," 交给 selectTopTaskIds 的 instr 判定（单值 = ",a,"，命中口径不变）。
    const clients = String(opt.client || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && s !== 'all');
    const clientArg = clients.length ? `,${clients.join(',')},` : null;
    const beforeArg = opt.beforeTs != null ? opt.beforeTs : null;
    const topIds = stmt.selectTopTaskIds
      .all({ project: projectArg, client: clientArg, before: beforeArg })
      .map((r) => r.id);
    return deleteByTopIds(topIds);
  }

  const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSettingStmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  /** 读设置项（字符串），不存在返回 null */
  function getSetting(key) {
    const row = getSettingStmt.get(key);
    return row ? row.value : null;
  }
  /** 写设置项（值一律转字符串存） */
  function setSetting(key, value) {
    setSettingStmt.run(key, String(value));
  }
  /**
   * 记录保留天数（天）：缺省 30；前端改过则优先用落库值，并夹在 1~3650。
   * 服务端自动清理任务记录以它为准（见 server/src/index.js 的 runRetentionCleanup）。
   */
  function getRetentionDays() {
    const raw = getSetting('retentionDays');
    const n = raw != null ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n < 1) return 30;
    return Math.min(n, 3650);
  }

  return { ...stmt, listMessages, purgeProject, purgeMember, deleteTaskRun, deleteTaskRunsByFilter, getSetting, setSetting, getRetentionDays, raw: db };
}

module.exports = { openDatabase, createRepo, applyPragmas, migrate, SCHEMA_PATH };
