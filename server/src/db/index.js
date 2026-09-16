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

/**
 * 增量补列：schema.sql 只管"建新库"，老库要补的列在这里加。
 * SQLite 没有 ADD COLUMN IF NOT EXISTS，所以先查 table_info 再决定。
 * @param {import('better-sqlite3').Database} db
 */
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

/** @param {import('better-sqlite3').Database} db */
function migrate(db) {
  ensureColumn(db, 'members', 'ephemeral', 'ephemeral INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'members', 'project', 'project TEXT');
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
  applyPragmas(db);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);

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
    upsertTeam: db.prepare(`
      INSERT INTO teams (id, name, workspace_path, main_conversation_id, source, created_at)
      VALUES (@id, @name, @workspacePath, @mainConversationId, @source, @createdAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        workspace_path = excluded.workspace_path,
        main_conversation_id = excluded.main_conversation_id
    `),
    listTeams: db.prepare(`SELECT * FROM teams ORDER BY created_at DESC`),
    getTeam: db.prepare(`SELECT * FROM teams WHERE id = ?`),
    getTeamByWorkspace: db.prepare(`SELECT * FROM teams WHERE workspace_path = ?`),

    upsertMember: db.prepare(`
      INSERT INTO members (id, team_id, name, role, session_id, reported, created_at, last_seen_at, ephemeral, project)
      VALUES (@id, @teamId, @name, @role, @sessionId, @reported, @createdAt, @lastSeenAt, @ephemeral, @project)
      ON CONFLICT(id) DO UPDATE SET
        role = COALESCE(excluded.role, members.role),
        session_id = COALESCE(excluded.session_id, members.session_id),
        reported = MAX(members.reported, excluded.reported),
        last_seen_at = MAX(COALESCE(members.last_seen_at, 0), COALESCE(excluded.last_seen_at, 0)),
        ephemeral = MAX(members.ephemeral, excluded.ephemeral),
        project = COALESCE(excluded.project, members.project)
    `),
    getMember: db.prepare(`SELECT * FROM members WHERE id = ?`),
    listMembers: db.prepare(`SELECT * FROM members WHERE team_id = ? ORDER BY name`),
    listEphemeral: db.prepare(`SELECT * FROM members WHERE team_id = ? AND ephemeral = 1`),
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
      WHERE m.team_id = ?
    `),
    insertStatusHistory: db.prepare(`
      INSERT INTO agent_status_history (member_id, state, ts_ms, reason, source) VALUES (?, ?, ?, ?, ?)
    `),

    insertTask: db.prepare(`
      INSERT INTO tasks (id, team_id, member_id, parent_task_id, title, state, progress, started_at, ended_at)
      VALUES (@id, @teamId, @memberId, @parentTaskId, @title, @state, @progress, @startedAt, @endedAt)
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
    listTasks: db.prepare(`SELECT * FROM tasks WHERE team_id = ? ORDER BY started_at DESC`),

    insertMessage: db.prepare(`
      INSERT INTO messages (dedupe_key, team_id, ts_ms, from_member, to_member, type, subject, content, task_id, source, raw_json)
      VALUES (@dedupeKey, @teamId, @tsMs, @fromMember, @toMember, @type, @subject, @content, @taskId, @source, @rawJson)
      ON CONFLICT(dedupe_key) DO NOTHING
    `),
    getMessage: db.prepare(`SELECT * FROM messages WHERE id = ?`),
    countMessages: db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE team_id = ?`),
    countMessagesFor: db.prepare(
      `SELECT COUNT(*) AS c FROM messages WHERE team_id = ? AND (from_member = ? OR to_member = ?)`
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

    insertEvent: db.prepare(`INSERT INTO events (team_id, ts_ms, kind, payload_json) VALUES (?, ?, ?, ?)`),
  };

  /**
   * 消息查询：按成员 / 类型 / 时间过滤 + 关键字搜索 + 游标分页。
   * M0 用 LIKE；M2 切换到 FTS5 trigram（<3 字查询自动降级为 LIKE，见 README 说明）。
   * @param {string} teamId
   * @param {{members?: string[], types?: string[], since?: number, until?: number, keyword?: string, direction?: string, beforeId?: number, afterId?: number, limit?: number}} f
   */
  function listMessages(teamId, f = {}) {
    const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 1000);
    const where = ['team_id = @teamId'];
    const params = { teamId, limit };

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
   * 删除（归档）某个团队的全部数据 —— 演示 secure_delete + TRUNCATE 的完整链路。
   * 真实归档/保留策略在 M2 落地；此处保证"删了就真的抹掉"。
   * @param {string} teamId
   */
  function purgeTeam(teamId) {
    const tx = db.transaction((id) => {
      db.prepare('DELETE FROM messages WHERE team_id = ?').run(id);
      db.prepare('DELETE FROM tasks WHERE team_id = ?').run(id);
      db.prepare('DELETE FROM file_activity WHERE member_id IN (SELECT id FROM members WHERE team_id = ?)').run(id);
      db.prepare('DELETE FROM artifacts WHERE member_id IN (SELECT id FROM members WHERE team_id = ?)').run(id);
      db.prepare('DELETE FROM agent_status WHERE member_id IN (SELECT id FROM members WHERE team_id = ?)').run(id);
      db.prepare('DELETE FROM agent_status_history WHERE member_id IN (SELECT id FROM members WHERE team_id = ?)').run(
        id
      );
      db.prepare('DELETE FROM members WHERE team_id = ?').run(id);
      db.prepare('DELETE FROM events WHERE team_id = ?').run(id);
      db.prepare('DELETE FROM teams WHERE id = ?').run(id);
    });
    tx(teamId);
    // secure_delete 只保证 freelist 页被覆写；WAL 里的旧页要靠 TRUNCATE 清掉
    db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /**
   * 删掉一个成员及其所有附属行 —— 临时成员（幽灵）消失时用。
   * messages 不删：它是"发生过什么"的历史，不是成员的属性。
   * @param {string} memberId
   */
  function purgeMember(memberId) {
    const tx = db.transaction((id) => {
      db.prepare('DELETE FROM file_activity WHERE member_id = ?').run(id);
      db.prepare('DELETE FROM artifacts WHERE member_id = ?').run(id);
      db.prepare('DELETE FROM agent_status_history WHERE member_id = ?').run(id);
      db.prepare('DELETE FROM agent_status WHERE member_id = ?').run(id);
      db.prepare('DELETE FROM tasks WHERE member_id = ?').run(id);
      db.prepare('DELETE FROM members WHERE id = ?').run(id);
    });
    tx(memberId);
  }

  return { ...stmt, listMessages, purgeTeam, purgeMember, raw: db };
}

module.exports = { openDatabase, createRepo, applyPragmas, migrate, SCHEMA_PATH };
