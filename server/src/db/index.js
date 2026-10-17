'use strict';

/**
 * SQLite data access layer.
 *
 * Security baseline (mandatory for M0, decided by leader/main, must not be turned off on your own):
 *   1. Every connection sets `PRAGMA secure_delete = ON` as soon as it opens —— that PRAGMA is **not
 *      persisted**, it has to be set per connection.
 *      Effect: deletions / updates overwrite the old content with 0s, so no plaintext lingers in
 *      freelist pages for someone to grep out.
 *   2. WAL checkpoint strategy:
 *      - `wal_autocheckpoint = 512` pages (~2MB) autocheckpoint;
 *      - every 30s a timer actively runs `PRAGMA wal_checkpoint(PASSIVE)`;
 *      - on close / after delete-archive run `PRAGMA wal_checkpoint(TRUNCATE)` (otherwise old pages
 *        stay in the -wal file);
 *   3. db / -wal / -shm file permissions 0600.
 *   4. `synchronous = NORMAL` (safe and faster in WAL mode).
 *
 * The real line of defense is that **masking happens before writes to the DB and before building the
 * FTS index**; no plaintext should appear in the DB.
 * If plaintext does land in the DB —— report it immediately as a P0 defect, do not change the masking
 * logic yourself.
 */

const fs = require('node:fs');
const path = require('node:path');
const log = require('../log');
const Database = require('better-sqlite3');
const { DEFAULTS } = require('@workgremlin/shared');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function chmod600(file) {
  try {
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  } catch {
    /* non-POSIX: ignore */
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
 * Incremental column additions: schema.sql only handles "create a new DB", columns an old DB needs
 * are added here.
 * SQLite has no ADD COLUMN IF NOT EXISTS, so table_info is checked first and then it decides.
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
  // Axis 2 (session): old DBs lack these two columns, add them; old rows keep NULL (that is not "no
  // session", it is "nothing was recorded back then")
  ensureColumn(db, 'task_runs', 'session_id', 'session_id TEXT');
  ensureColumn(db, 'task_runs', 'form', 'form TEXT');
  // Trae's cn_session_usage_tail only has the amount (CNY), no token breakdown. It gets its own
  // column, and is not stuffed into input_tokens / output_tokens —— those are for products that
  // really do have a token breakdown.
  ensureColumn(db, 'task_runs', 'usage_yuan', 'usage_yuan REAL');
  ensureColumn(db, 'messages', 'session_id', 'session_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_runs_session ON task_runs(project_id, session_id, started_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(project_id, session_id, ts_ms DESC)');
  // Council room: expanding from "voting only" to "vote / analysis × isolated directory / project
  // directory".
  // After an old DB gets the columns, behavior is **verbatim identical** to before the change:
  // mode='vote', workspace_path=NULL (= temp directory + no tools).
  ensureColumn(db, 'councils', 'mode', "mode TEXT NOT NULL DEFAULT 'vote'");
  ensureColumn(db, 'councils', 'workspace_path', 'workspace_path TEXT');
  ensureColumn(db, 'council_utterances', 'stance', 'stance TEXT');
  ensureColumn(db, 'council_utterances', 'findings_json', 'findings_json TEXT');
  normalizeThinkingState(db);
  ensureCouncilVerdictReported(db);
  // Backfill: products once missing from CLIENT_BASES have their main agent member's client written as
  // NULL, and an empty client is treated on the frontend as "generic, show it on every floor" —— so
  // that product's members drift into every floor (measured: the qoder main agent row drifted into
  // 1F's workstation card exactly this way). Backfill by "the name equals a known product base name":
  // demo members' generic NULLs (names are not base names) are unaffected. New members are already
  // normalized correctly by normClient; this clears historical residue.
  const BASES = ['codebuddy', 'cline', 'codex', 'claude', 'trae', 'qoder', 'kilo', 'opencode'];
  const tagBase = db.prepare(`UPDATE members SET client = ? WHERE client IS NULL AND name = ?`);
  for (const b of BASES) tagBase.run(b, b);
}

/**
 * One-time data cleanup: member state `thinking` was folded back into `busy` (it is part of busy — see
 * AGENT_STATES in shared). Rewrite any leftover rows so the liveness checks (which no longer list
 * `thinking`) keep seeing them. The tables' CHECK constraints still permit `busy`, so this is a plain
 * UPDATE (no table rebuild).
 * @param {import('better-sqlite3').Database} db
 */
function normalizeThinkingState(db) {
  for (const table of ['agent_status', 'session_status']) {
    try {
      db.exec(`UPDATE ${table} SET state = 'busy' WHERE state = 'thinking'`);
    } catch {
      /* table missing on a very old db: nothing to clean */
    }
  }
}

/**
 * An old DB's councils.verdict carries the old CHECK (no analysis mode's 'reported'),
 * and CREATE TABLE IF NOT EXISTS does not change an existing table's constraints.
 *
 * Unlike the agent_status case, the council room's **history must not be lost** (those are meetings
 * the user actually held), so rows are carried over as-is rather than rebuilding an empty table. Two
 * preconditions make that safe, and both hold:
 *   · These council tables **deliberately have no foreign keys** in schema.sql (reconciliation relies
 *     on deleteCouncil's manual cascade), so RENAME drags no other table with it;
 *   · councils is only **referenced by** child tables like council_rounds / council_utterances (also
 *     without foreign keys), so rows of the child tables stay keyed by council_id during the rebuild
 *     and are still queryable once the same-named table reappears.
 *
 * Note the CREATE must spell out **every column of the current schema** (including the mode /
 * workspace_path just added by ensureColumn) and that idx_councils_created —— missing one column means
 * one migration silently deletes a newly added column.
 * @param {import('better-sqlite3').Database} db
 */
function ensureCouncilVerdictReported(db) {
  let sql = '';
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='councils'").get();
    sql = (row && row.sql) || '';
  } catch {
    return;
  }
  if (!sql || /reported/.test(sql)) return; // already the new constraint, or the table does not exist
  db.exec(`
    ALTER TABLE councils RENAME TO _councils_old;
    CREATE TABLE councils (
      id            TEXT PRIMARY KEY,
      topic         TEXT NOT NULL,
      mode          TEXT NOT NULL DEFAULT 'vote'
                    CHECK (mode IN ('vote','analysis')),
      workspace_path TEXT,
      status        TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','running','done','failed','cancelled')),
      threshold     TEXT NOT NULL DEFAULT 'unanimous'
                    CHECK (threshold IN ('unanimous','majority')),
      max_rounds    INTEGER NOT NULL,
      round_current INTEGER NOT NULL DEFAULT 0,
      verdict       TEXT
                    CHECK (verdict IS NULL OR verdict IN ('consensus','no_consensus','reported','cancelled','failed')),
      verdict_round INTEGER,
      error         TEXT,
      created_at    INTEGER NOT NULL,
      started_at    INTEGER,
      ended_at      INTEGER
    );
    INSERT INTO councils
      (id, topic, mode, workspace_path, status, threshold, max_rounds, round_current,
       verdict, verdict_round, error, created_at, started_at, ended_at)
    SELECT id, topic, mode, workspace_path, status, threshold, max_rounds, round_current,
           verdict, verdict_round, error, created_at, started_at, ended_at
    FROM _councils_old;
    DROP TABLE _councils_old;
    CREATE INDEX IF NOT EXISTS idx_councils_created ON councils(created_at DESC);
  `);
}

/** Old tables carrying team_id (the schema version from before project was renamed from project) */
const LEGACY_TEAM_TABLES = ['members', 'tasks', 'messages', 'events'];

/** Keep one full backup before migrating, so there is something to roll back to if the result is wrong */
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
 * One-off migration from the team era to the project era.
 *
 * It must run **before** exec(schema.sql): schema.sql has a batch of `CREATE INDEX ...(project_id, ...)`
 * while the old tables (members / tasks / messages / events) only have team_id, so db.exec would die
 * right there on "no such column: project_id", the server would not start and nobody would know why.
 *
 * Approach: read old rows into memory → drop the old tables (schema.sql then rebuilds them per the
 * latest definition) → after creation, backfill, and while at it write team_id as project_id and
 * members.project as project_label.
 * foreign_keys=OFF throughout (that is the default anyway), so DROP does not cascade agent_status /
 * history away with it.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Record<string, any[]> | null} the old rows to backfill; null = this DB needs no migration
 */
function migrateLegacyTeamSchema(db) {
  // The criterion is only "is there still a table carrying team_id": the teams table itself is allowed
  // to stay (it holds historical projects), and looking at it alone would misjudge every start as
  // pending migration and back up the DB for nothing.
  const legacyTables = LEGACY_TEAM_TABLES.filter((t) => hasColumn(db, t, 'team_id'));
  if (!legacyTables.length) return null;

  // teams is what projects was back then: copy it over, IGNORE keeps repeated starts from rewriting
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
      // messages_fts is an external content virtual table (content='messages'), it has to be torn down
      // along with it, left for schema.sql to rebuild; the index is rebuilt again after backfilling.
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
 * After schema.sql has created the tables per the latest definition, backfill the old rows fished out
 * before the migration.
 * Rows that cannot land (referencing a project that does not exist) are skipped and counted —— better
 * to lose a few history rows than to stop the server from starting.
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
      /* one row failing does not affect the rest: one less history row beats a server that cannot start */
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
      // The old DB's members.project (the project name a temporary member belongs to) was renamed to project_label
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
      /* a failed FTS rebuild does not affect the main flow: search degrades to unusable, history messages are still readable */
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
 * Open (and initialize) the database.
 * @param {string} dbPath
 * @returns {{ db: import('better-sqlite3').Database, repo: ReturnType<typeof createRepo>, checkpoint: (mode?: string) => any, startCheckpointLoop: () => NodeJS.Timeout, close: () => void }}
 */
function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });

  const db = new Database(dbPath);

  // An old team-era DB must migrate to the project era first —— before applyPragmas (foreign_keys=ON)
  // and before the schema, otherwise those few (project_id, ...) indexes in exec(schema.sql) kill
  // startup outright with "no such column".
  db.pragma('foreign_keys = OFF');
  const legacy = migrateLegacyTeamSchema(db);
  if (legacy) {
    const backup = backupLegacyDatabase(db, dbPath);
    log.warn(
      `[workgremlin] 检测到 team 时代的老库，已迁移到 project 时代${backup ? `（备份：${backup}）` : ''}`
    );
  }

  applyPragmas(db);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  const restored = restoreLegacyRows(db, legacy);
  if (restored) log.warn(`[workgremlin] 老库迁移完成，回填 ${restored} 行历史数据`);

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
        /* ignore: a failed checkpoint does not affect availability, the next round retries */
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
 * The set of prepared statements. No write method may fabricate data: unknown fields are always written as NULL.
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
        -- overwrite when the source client is known (old DBs are NULL, filled in by the first report / roster heartbeat)
        client = COALESCE(excluded.client, members.client)
    `),
    tagMemberClient: db.prepare(`
      UPDATE members SET client = @client
      WHERE id = @id AND (client IS NULL OR client <> @client)
    `),
    getMember: db.prepare(`SELECT * FROM members WHERE id = ?`),
    listMembers: db.prepare(`SELECT * FROM members WHERE project_id = ? ORDER BY name`),
    /** Members by reporting identity (9F's synchronizer wraps up with it: even with no session it has to put the status back to idle, see copilot.js) */
    listMembersByClient: db.prepare(`SELECT * FROM members WHERE client = ? ORDER BY name`),
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
    upsertSessionStatus: db.prepare(`
      INSERT INTO session_status
        (member_id, session_id, state, state_since, task_id, last_heartbeat_at, updated_at)
      VALUES
        (@memberId, @sessionId, @state, @stateSince, @taskId, @lastHeartbeatAt, @updatedAt)
      ON CONFLICT(member_id, session_id) DO UPDATE SET
        state = excluded.state,
        state_since = CASE WHEN session_status.state = excluded.state THEN session_status.state_since ELSE excluded.state_since END,
        task_id = excluded.task_id,
        last_heartbeat_at = excluded.last_heartbeat_at,
        updated_at = excluded.updated_at
    `),
    getSessionStatus: db.prepare(`SELECT * FROM session_status WHERE member_id = @memberId AND session_id = @sessionId`),
    /**
     * Clear the task slot in the member status (upsertStatus's task_id is COALESCE, passing null cannot clear it).
     * Used when 9F wraps up: the session is gone, so the task in that slot (which may no longer exist) should not hang there either.
     */
    clearStatusTask: db.prepare(`UPDATE agent_status SET task_id = NULL, progress = NULL, current_files = NULL WHERE member_id = ?`),
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
        started_at = COALESCE(tasks.started_at, excluded.started_at),
        ended_at = excluded.ended_at
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
    /**
     * The finish time of a member's most recent **finished** task (the workstation card's "last active" uses it: how long ago the previous task was).
     * Looked up by the member's own id (tasks.member_id is the full "name@project" id), hitting idx_tasks_member_state.
     */
    lastTaskEndOfMember: db.prepare(`SELECT MAX(ended_at) AS at FROM tasks WHERE member_id = ? AND ended_at IS NOT NULL`),

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

    /* ---- Tool usage ("tool usage: tool name + count" in task details) ---- */
    /** +1 for one tool in this round's task (UPSERT accumulates by (task_id, tool), see the notes in schema.sql) */
    bumpToolUsage: db.prepare(`
      INSERT INTO tool_usage (task_id, tool, project_id, member_id, client, session_id, count, first_at, last_at)
      VALUES (@taskId, @tool, @projectId, @memberId, @client, @sessionId, 1, @ts, @ts)
      ON CONFLICT(task_id, tool) DO UPDATE SET
        count      = tool_usage.count + 1,
        last_at    = excluded.last_at,
        member_id  = COALESCE(excluded.member_id, tool_usage.member_id),
        client     = COALESCE(excluded.client, tool_usage.client),
        session_id = COALESCE(excluded.session_id, tool_usage.session_id)
    `),
    /** The tool usage list for one round's task: highest count first */
    listTaskTools: db.prepare(`
      SELECT tool, count, last_at FROM tool_usage WHERE task_id = ? ORDER BY count DESC, tool ASC
    `),

    insertArtifact: db.prepare(`
      INSERT INTO artifacts (member_id, task_id, kind, title, path, ts_ms) VALUES (?, ?, ?, ?, ?, ?)
    `),
    listArtifacts: db.prepare(`SELECT * FROM artifacts WHERE member_id = ? ORDER BY ts_ms DESC LIMIT ?`),
    /**
     * Output a resident gremlin borrows from its same-named summoned instances (see bus.ghostArtifacts).
     * Ghost member rows are deleted when they disperse while their runs/artifacts stay (purgeMember's
     * keepHistory), so the link goes through subagent_runs by name rather than by member id.
     */
    listGhostArtifactsByName: db.prepare(`
      SELECT a.* FROM artifacts a
        JOIN subagent_runs r ON r.task_id = a.task_id
       WHERE r.project_id = @projectId AND r.name = @name
       ORDER BY a.ts_ms DESC LIMIT @limit
    `),

    /** The most recent finished task: gives the "files changed this round" window its boundaries (started_at..ended_at) */
    latestEndedTask: db.prepare(`
      SELECT * FROM tasks WHERE member_id = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1
    `),
    /* ---- Ledger (for reports): one round of user task + the subagent instances it summoned ---- */
    upsertTaskRun: db.prepare(`
      INSERT INTO task_runs (id, project_id, member_id, client, session_id, form, model, title, started_at, baseline_commit)
      VALUES (@id, @projectId, @memberId, @client, @sessionId, @form, @model, @title, @startedAt, @baselineCommit)
      ON CONFLICT(id) DO UPDATE SET
        client     = excluded.client,
        session_id = COALESCE(excluded.session_id, task_runs.session_id),
        form       = COALESCE(excluded.form, task_runs.form),
        model      = COALESCE(excluded.model, task_runs.model),
        title      = COALESCE(excluded.title, task_runs.title),
        started_at = COALESCE(task_runs.started_at, excluded.started_at),
        baseline_commit = COALESCE(task_runs.baseline_commit, excluded.baseline_commit)
    `),
    endTaskRun: db.prepare(`
      UPDATE task_runs SET
        title       = COALESCE(@title, title),
        model       = COALESCE(@model, model),
        form        = COALESCE(@form, form),
        result      = COALESCE(@result, result),
        file_count  = COALESCE(@fileCount, file_count),
        files_json  = COALESCE(@filesJson, files_json),
        ended_at    = @endedAt,
        duration_ms = COALESCE(@durationMs, duration_ms)
      WHERE id = @id
    `),
    /**
     * Clear a run's changed-file info (both columns to NULL). For a floor that cannot read which files a
     * turn changed (2F Cline): endTaskRun's COALESCE treats NULL as "not reported, keep the old value",
     * so an explicit clear is needed to avoid pinning a previously-written guess. NULL = unknown.
     */
    clearTaskRunFiles: db.prepare(`UPDATE task_runs SET file_count = NULL, files_json = NULL WHERE id = ?`),
    /**
     * The tokens consumed by one round (four columns, semantics in the comments of schema.sql).
     *
     * Why a separate statement rather than folding it into endTaskRun: every field of endTaskRun is
     * `COALESCE(@x, x)` —— "not reported means do not touch". Tokens are exactly the opposite: **what
     * was read is the newest and must overwrite** —— 7F/8F poll every 1.5s and write the same row
     * repeatedly, and the tokens of a running round **grow** (the first poll only reads part of them),
     * so COALESCE would nail the too-small value down permanently.
     * Each floor's real write timing is also just once (at wrap-up / each poll), so there is no such
     * thing as "the old value should be kept".
     *
     * When no true value can be read, the caller passes null —— then NULL is written honestly, the
     * report shows "—", and neither 0 nor an old value poses as the answer.
     */
    setTaskRunTokens: db.prepare(`
      UPDATE task_runs SET
        input_tokens       = @inputTokens,
        output_tokens      = @outputTokens,
        cache_read_tokens  = @cacheReadTokens,
        cache_write_tokens = @cacheWriteTokens
      WHERE id = @id
    `),
    /** Trae's cn_session_usage_tail = task end signal + amount.
     *  Written atomically: set usage_yuan. state lives in the tasks table, handled by bus.endTask inside flushTraeYuan. */
    setTaskRunYuan: db.prepare(`
      UPDATE task_runs SET usage_yuan = @usageYuan
      WHERE id = @id
    `),
    /**
     * The row awaiting tokens —— used for late token backfill after wrap-up (see bus.backfillTaskTokens).
     *
     * Claiming clue: "session + near the start + all four columns empty", take the most recently started round.
     *
     * Why claim by "session + near the start" rather than by taskId: at the moment of backfill the hook
     * has no taskId in hand (the state file cleared it at wrap-up), only "where the previous round
     * started". And task_runs.started_at is written by the server while the hook's copy is its own
     * record; the two differ by one HTTP round trip (a few ms to tens of ms), so an exact equality match
     * **necessarily** fails —— hence ±10s.
     *
     * Why **not** require ended_at IS NOT NULL (a restriction in earlier versions): for a cancelled /
     * interrupted round, the wrap-up flow may not have completed because the taskId was cleared
     * concurrently (real case: a codebuddy CLI task on 10-08 13:40 with ended_at permanently empty and
     * all tokens empty), and on this "session + start + four empty columns" clue it is no different from
     * any other backfillable row —— cancelled ≠ consumed no tokens, such rows need filling too.
     * The constraint can be left to call timing: backfill is only initiated after Stop (already wrapped
     * up) or the next UserPromptSubmit (the previous round's context has ended), so it never misfires on
     * a genuinely running task. Not recognized (no such row in the session / start does not match)
     * means no backfill: better to leave "—" than to write it onto another round's head.
     */
    /**
     * Tasks in the same session that **started earlier and are still unfinished** (used to give the
     * previous round a wrap-up when a new round starts).
     * One session cannot run two rounds at once —— if there are rows here, the previous round's end
     * event simply never arrived (the CodeBuddy plugin emits not one hook event when stopping, see the
     * notes in bus.startTask).
     */
    listStaleRunningBySession: db.prepare(`
      SELECT r.id AS id, r.member_id AS memberId, r.started_at AS startedAt, r.client AS client
      FROM task_runs r JOIN tasks t ON t.id = r.id
      WHERE r.project_id = ? AND r.session_id = ? AND t.state = 'running'
      ORDER BY r.started_at ASC
    `),

    /**
     * All "still running" top-level tasks in a project (projectId, pass 0 for any project), returning their client.
     * The **single criterion** for the lintel ticker / main console judging "this floor has a task running",
     * grouped by agent base name in JS (stripping -plugin / @project suffixes) —— same criterion as the
     * frontend's floorAcceptsClient, avoiding a miss where a plugin session's client is codebuddy-plugin
     * while the ledger's task_runs.client is bare codebuddy ("same base name, different string").
     *
     * "Running" = tasks.state='running' and (a heartbeat is alive OR it was newly started recently).
     * **Key point**: 1F CodeBuddy plugin tasks never write a session_status / agent_status heartbeat
     * (handlePlugin's comments confirm task_runs stays running), so a heartbeat-only ALIVE judgment
     * misses them entirely → the ticker shows nothing while running and pops up only after cancellation.
     * So besides the heartbeat, a fallback of "started_at within the @fresh window" is added —— plugin
     * tasks claim themselves through it; CLI / Codex and others that have heartbeats go through ALIVE as
     * before. @fresh is generous (3h by default) only to keep out zombies whose "process died long ago
     * but the ledger stays running"; normal tasks never exceed it.
     */
    activeRunningByProject: db.prepare(`
      SELECT COALESCE(r.client, m.client) AS client, r.session_id AS sessionId, t.title AS title, t.started_at AS startedAt FROM tasks t
      LEFT JOIN task_runs r ON r.id = t.id
      LEFT JOIN members m ON m.id = t.member_id
      WHERE t.parent_task_id IS NULL AND t.state = 'running'
        AND (@projectId = 0 OR t.project_id = @projectId)
        AND (
          t.started_at > @fresh
          OR EXISTS (
            SELECT 1 FROM session_status ss
             WHERE ss.member_id = t.member_id AND ss.session_id = r.session_id AND ss.task_id = t.id
               AND (ss.last_heartbeat_at > @cutoff
                    OR (ss.state IN ('busy', 'blocked') AND ss.state_since > @grace))
          ) OR EXISTS (
            SELECT 1 FROM agent_status s
             WHERE s.task_id = t.id
               AND (s.last_heartbeat_at > @cutoff
                    OR (s.state IN ('busy', 'blocked') AND s.state_since > @grace))
          )
        )
    `),
    runAwaitingTokens: db.prepare(`
      SELECT id FROM task_runs
      WHERE project_id = ? AND session_id = ?
        AND input_tokens IS NULL AND output_tokens IS NULL
        AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL
        AND ABS(COALESCE(started_at, 0) - ?) < 10000
      ORDER BY started_at DESC LIMIT 1
    `),
    /** Trae's cn_session_usage_tail has only the amount. Matched by ended_at:
     *  the usage event is Trae writing renderer.log after the task ends (27~120 seconds later), so
     *  ended_at <= usage.ts always holds; ORDER BY ended_at DESC LIMIT 1 takes
     *  "the row whose ended_at is closest to usage.ts and before it" with an empty usage_yuan ——
     *  that is the round task that produced this usage. started_at is unreliable (the task start time
     *  reported by the Trae hook can be later than the usage time in renderer.log). */
    runAwaitingYuan: db.prepare(`
      SELECT id FROM task_runs
      WHERE project_id = ? AND session_id = ?
        AND usage_yuan IS NULL
        AND ended_at IS NOT NULL
        AND ended_at <= ?
      ORDER BY ended_at DESC LIMIT 1
    `),
    listTaskRuns: db.prepare(`
      SELECT * FROM task_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?
    `),
    getTaskRun: db.prepare(`SELECT * FROM task_runs WHERE id = ?`),
    /** All ledger rows under a session (7F's polling fallback judges from this whether "the plugin already reported the true value", see kilo.js) */
    // started_at is needed too: kiloTasks uses it to judge "did the plugin write this round" (see yieldsOf there)
    taskRunsOfSession: db.prepare(`SELECT id, client, started_at FROM task_runs WHERE session_id = ?`),
    /**
     * Ledger rows under a client that **have not wrapped up** (9F Copilot uses this to retire "misattributed"
     * in-flight rows: sessions of other products mistakenly written in as Copilot, see
     * copilot.js's pruneForeignRunningRuns).
     * Only running rows are taken: such wrong rows are written solely by the synchronizer and never get
     * a wrap-up; done historical rows are not on this path.
     */
    liveTaskRunsOfClient: db.prepare(`
      SELECT tr.id AS id, tr.session_id AS session_id FROM task_runs tr
        JOIN tasks t ON t.id = tr.id
       WHERE tr.client = ? AND t.state = 'running' AND t.ended_at IS NULL
    `),
    /**
     * The one task in the ledger that **has not wrapped up** (`tasks.state = 'running'` and no ended_at).
     *
     * There is exactly one use: who `agent_status.task_id` (one row per member, one slot only) should
     * point at —— see bus.js's heartbeat (claimed by session) and endTask (handing the slot over at
     * wrap-up). `ended_at IS NULL` is a redundant criterion, written here to guard against old data
     * where "state was changed back to running elsewhere"; both go by project + member through the
     * idx_task_runs_session prefix, and the session one adds session_id.
     */
    liveTaskOfSession: db.prepare(`
      SELECT t.id AS id FROM task_runs tr JOIN tasks t ON t.id = tr.id
       WHERE tr.project_id = @projectId AND tr.member_id = @memberId AND tr.session_id = @sessionId
         AND t.state = 'running' AND t.ended_at IS NULL
       ORDER BY tr.started_at DESC LIMIT 1
    `),
    /** Same as above, without a session: this member's **newest** in-flight task (for handing the slot over at wrap-up) */
    liveTaskOfMember: db.prepare(`
      SELECT t.id AS id FROM task_runs tr JOIN tasks t ON t.id = tr.id
       WHERE tr.project_id = @projectId AND tr.member_id = @memberId
         AND t.state = 'running' AND t.ended_at IS NULL
       ORDER BY tr.started_at DESC LIMIT 1
    `),
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
    /** Find the task a session was running at a given moment —— for Trae subagent contribution backfill.
     *  Tasks under the same sessionId run serially (no overlap), so the newest one with started_at <= at
     *  is the task running when the contribution event happened; at=0 (time cannot be parsed) degrades
     *  to taking the newest with no time bound. */
    latestTaskBySession: db.prepare(`
      SELECT r.id AS id, r.member_id AS memberId, r.started_at AS startedAt
      FROM task_runs r JOIN tasks t ON t.id = r.id
      WHERE r.project_id = ? AND r.session_id = ?
        AND (? = 0 OR r.started_at <= ?)
      ORDER BY r.started_at DESC LIMIT 1
    `),
    /** Dedup check: the same operationId (stored in the name column) under the same parent task is not backfilled twice */
    hasSubagentByName: db.prepare(
      `SELECT COUNT(*) AS c FROM subagent_runs WHERE parent_task_id = ? AND name = ?`
    ),
    /** One-shot write of a Trae subagent contribution (including result / files_json / ended_at, not in two steps) */
    insertSubagentContribution: db.prepare(`
      INSERT INTO subagent_runs
        (project_id, parent_task_id, member_id, name, client, title, result, files_json, started_at, ended_at)
      VALUES
        (@projectId, @parentTaskId, @memberId, @name, @client, @title, @result, @filesJson, @startedAt, @endedAt)
    `),
    /** Deletion: clear a whole top-level task (and its subagent child tasks), including ledger / messages / outputs */
    selectChildTaskIds: db.prepare(`SELECT id FROM tasks WHERE parent_task_id IN (SELECT value FROM json_each(?))`),
    deleteTasksById: db.prepare(`DELETE FROM tasks WHERE id IN (SELECT value FROM json_each(?))`),
    deleteTaskRunsById: db.prepare(`DELETE FROM task_runs WHERE id IN (SELECT value FROM json_each(?))`),
    deleteSubagentRunsByParent: db.prepare(`DELETE FROM subagent_runs WHERE parent_task_id IN (SELECT value FROM json_each(?))`),
    deleteMessagesByTask: db.prepare(`DELETE FROM messages WHERE task_id IN (SELECT value FROM json_each(?))`),
    deleteArtifactsByTask: db.prepare(`DELETE FROM artifacts WHERE task_id IN (SELECT value FROM json_each(?))`),
    deleteToolUsageByTask: db.prepare(`DELETE FROM tool_usage WHERE task_id IN (SELECT value FROM json_each(?))`),
    /**
     * Top-level task id selector: reuses the task-records page top filters (project + floor), plus an
     * optional "older than" cutoff (keep the last N days).
     * @project is a ",a,b," delimited project id set and @client is a ",a,b," delimited client set
     * (a merged floor 1F CodeBuddy = the two clients CLI + Plugin); instr does set-membership —
     * a single value takes the same path (",codebuddy," matches codebuddy).
     */
    selectTopTaskIds: db.prepare(`
      SELECT t.id FROM tasks t
      LEFT JOIN task_runs tr ON tr.id = t.id
      LEFT JOIN members m ON m.id = t.member_id
      WHERE t.parent_task_id IS NULL
        AND (@project IS NULL OR instr(@project, ',' || t.project_id || ',') > 0)
        AND (@client IS NULL OR instr(@client, ',' || COALESCE(tr.client, m.client) || ',') > 0)
        AND (@before IS NULL OR t.started_at < @before)
    `),
    /**
     * The task the **main agent** (role='agent', the one reported by the hook) in the current project is running.
     * Used to recognize the parent as a fallback when the summoning relation cannot be had (old hook
     * written lists have no parent field): a ghost was dispatched by the main agent, so while it is alive
     * the main agent must be running some user task.
     */
    mainRunningTask: db.prepare(`
      SELECT s.task_id AS taskId
      FROM agent_status s JOIN members m ON m.id = s.member_id
      WHERE m.project_id = ? AND m.role = 'agent' AND s.task_id IS NOT NULL
      ORDER BY COALESCE(s.last_heartbeat_at, s.updated_at) DESC
      LIMIT 1
    `),
    /**
     * A member's currently in-progress tasks (there can be several: different sessions of the same product each hold one).
     * When the hook's local taskId is lost to a concurrent overwrite, Stop uses this to fish the current round's task back out (bug 3 fallback).
     * Which one to pick by session is decided by the upper layer's currentTaskFor; this only fishes out the candidates.
     */
    // The session identifier lives in the report layer task_runs (the tasks table itself has no session_id column), so it is JOINed here.
    runningTaskForMember: db.prepare(`
      SELECT t.id AS taskId, t.title AS title, tr.session_id AS sessionId, t.started_at AS startedAt
      FROM tasks t
      LEFT JOIN task_runs tr ON tr.id = t.id
      WHERE t.member_id = ? AND t.state = 'running'
      ORDER BY t.started_at DESC
      LIMIT 5
    `),
    /**
     * Files changed by this member within the time window: deduped by path (repeated changes to the same file count as one output), taking the latest time.
     * op comes along too (the wrap-up fallback needs it, see bus.endTask): in SQLite's min/max aggregation rules,
     * a bare column takes the value from **the row the aggregate hit** (i.e. the most recent time), so op here is "the last operation".
     */
    listActivityInWindow: db.prepare(`
      SELECT path, op, MAX(ts_ms) AS ts_ms FROM file_activity
      WHERE member_id = ? AND ts_ms >= ? AND ts_ms <= ?
      GROUP BY path ORDER BY ts_ms DESC LIMIT ?
    `),

    insertEvent: db.prepare(`INSERT INTO events (project_id, ts_ms, kind, payload_json) VALUES (?, ?, ?, ?)`),
  };

  /**
   * Message query: filter by member / type / time + keyword search + cursor pagination.
   * M0 uses LIKE; M2 switches to FTS5 trigram (<3 character queries degrade to LIKE automatically, see the README notes).
   * @param {string} projectId
   * @param {{members?: string[], types?: string[], session?: string, since?: number, until?: number, keyword?: string, direction?: string, beforeId?: number, afterId?: number, limit?: number}} f
   *   session: take only one session's messages (axis 2). Omitted = all sessions (old behavior).
   */
  function listMessages(projectId, f = {}) {
    const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 1000);
    const where = ['project_id = @projectId'];
    const params = { projectId, limit };

    // Session filter: only **exactly equal** to this session counts. Old messages (session_id IS NULL)
    // are not folded in —— "carrying no session identifier" and "belonging to this session" are two
    // different things, and mixing them makes them indistinguishable.
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
   * Delete (archive) all data of a project —— demonstrates the full secure_delete + TRUNCATE chain.
   * The real archiving / retention policy lands in M2; here it is guaranteed that "deleted means really wiped".
   * @param {string} projectId
   */
  function purgeProject(projectId) {
    const tx = db.transaction((id) => {
      db.prepare('DELETE FROM messages WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM file_activity WHERE member_id IN (SELECT id FROM members WHERE project_id = ?)').run(id);
      db.prepare('DELETE FROM tool_usage WHERE project_id = ?').run(id);
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
    // secure_delete only guarantees freelist pages are overwritten; old pages in the WAL have to be cleared by TRUNCATE
    db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /**
   * Delete a member and its dependent rows —— used when a temporary member (ghost) disappears.
   *
   * Two kinds of "what happened" history are **not** deleted:
   *   · messages —— always been this way;
   *   · **the ghost's tasks / artifacts** (keepHistory) —— "what it did / what it produced / how long it
   *     took" for one summoning all lives in those two rows, and neither tasks.member_id nor
   *     artifacts.member_id has a foreign key constraint, so they stand on their own once the member row
   *     is gone.
   *     They used to be deleted along with it, and so: the output of a summoning with a gremlin (susan)
   *     evaporated together with the ghost; one without a gremlin (code-explorer / built-in experts
   *     spawned directly) could not even be **queried anywhere** —— the thread "how many subagents did
   *     this user task use" broke right there.
   *     Output stays under the producer's name (no transfer of ownership), "who did it" is not
   *     rewritten; the gremlin card shows it by borrowing the same-named ghost's output through
   *     bus.ghostArtifacts.
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
   * Delete a whole set of top-level tasks (with their subagent child tasks), and the corresponding ledger / messages / outputs.
   * @param {string[]} topIds list of top-level task ids
   * @returns {number} how many top-level tasks were deleted
   */
  function deleteByTopIds(topIds) {
    if (!topIds.length) return 0;
    const topJson = JSON.stringify(topIds);
    const childRows = stmt.selectChildTaskIds.all(topJson);
    const allJson = JSON.stringify([...topIds, ...childRows.map((r) => r.id)]);
    const tx = db.transaction(() => {
      stmt.deleteMessagesByTask.run(allJson);
      stmt.deleteArtifactsByTask.run(allJson);
      stmt.deleteToolUsageByTask.run(allJson);
      stmt.deleteSubagentRunsByParent.run(topJson);
      stmt.deleteTaskRunsById.run(topJson);
      stmt.deleteTasksById.run(allJson);
    });
    tx();
    db.pragma('wal_checkpoint(TRUNCATE)');
    return topIds.length;
  }

  /**
   * Delete a single task record (the second confirmation happens client-side; this only does the actual deletion).
   * @param {string} id top-level task id
   */
  function deleteTaskRun(id) {
    return deleteByTopIds([id]);
  }

  /**
   * Delete by the top-level filters (project + floor); when beforeTs is given, only delete older than that (keep the last N days).
   * @param {{ project?: string, client?: string, beforeTs?: number }} opt
   *        client may be a comma-separated list (merged floor 1F CodeBuddy = CLI + Plugin)
   * @returns {number} how many top-level tasks were deleted
   */
  function deleteTaskRunsByFilter(opt = {}) {
    // project / client may each be a comma-separated list (multi-select); normalize each to a
    // ",a,b," delimited set and hand it to selectTopTaskIds' instr membership test
    // (a single value = ",p1," — the match is unchanged).
    const projects = String(opt.project || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== 'all');
    const projectArg = projects.length ? `,${projects.join(',')},` : null;
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

  /** Read a setting (string); null when it does not exist */
  function getSetting(key) {
    const row = getSettingStmt.get(key);
    return row ? row.value : null;
  }
  /** Write a setting (values are always stored as strings) */
  function setSetting(key, value) {
    setSettingStmt.run(key, String(value));
  }
  /**
   * Record retention days: defaults to DEFAULTS.RETENTION_DAYS (90); if the frontend changed it the
   * stored value wins, clamped to 1~3650. Server-side automatic cleanup of task records follows this
   * (see runRetentionCleanup in server/src/index.js) —— the moment this number shrinks, the next cleanup
   * **really deletes** older records.
   */
  function getRetentionDays() {
    const raw = getSetting('retentionDays');
    const n = raw != null ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n < 1) return DEFAULTS.RETENTION_DAYS;
    return Math.min(n, 3650);
  }

  /* ============================ Council Chamber ============================
   *
   * A self-contained set, not mixed into that big stmt table above: the council tables share no foreign
   * keys and no queries with the office ones (members / tasks / task_runs / messages), and mixing them
   * would only make both harder to read.
   * Reads always go **by council_id**, with no "by project / by floor" entry point —— that is where the
   * isolation requirement lands: council data cannot leave the council page.
   *
   * The write order is the orchestrator's (see server/src/council/orchestrator.js):
   *   create → record attendance / materials → upsertRound per round → insertUtterance per participant
   *   → finishCouncil at wrap-up.
   * Everything here is a thin flat wrapper with no business judgment (vote judging is in
   * council/consensus.js, running processes is in council/runner.js).
   */
  const councilStmt = {
    insert: db.prepare(`
      INSERT INTO councils (id, topic, mode, workspace_path, status, threshold, max_rounds, created_at)
      VALUES (@id, @topic, @mode, @workspacePath, 'draft', @threshold, @maxRounds, @createdAt)
    `),
    get: db.prepare(`SELECT * FROM councils WHERE id = ?`),
    /** History list: newest first by start time. Attendance is not included; the list page fetches it separately if needed */
    list: db.prepare(`SELECT * FROM councils ORDER BY created_at DESC LIMIT ?`),
    markRunning: db.prepare(`UPDATE councils SET status = 'running', started_at = ? WHERE id = ? AND status = 'draft'`),
    setRound: db.prepare(`UPDATE councils SET round_current = ? WHERE id = ?`),
    finish: db.prepare(`
      UPDATE councils
         SET status = @status, verdict = @verdict, verdict_round = @verdictRound,
             error = @error, ended_at = @endedAt
       WHERE id = @id
    `),
    /** Startup reconciliation: `running` rows left behind when the last process was hard-killed —— mark them failed honestly, do not pretend they are still running */
    failStaleRunning: db.prepare(`
      UPDATE councils SET status = 'failed', verdict = 'failed', error = @error, ended_at = @at
       WHERE status = 'running'
    `),
    del: db.prepare(`DELETE FROM councils WHERE id = ?`),

    insertParticipant: db.prepare(`
      INSERT INTO council_participants (council_id, floor_id, agent, cli_path, status)
      VALUES (@councilId, @floorId, @agent, @cliPath, 'pending')
    `),
    setParticipantStatus: db.prepare(`
      UPDATE council_participants SET status = @status, error = @error
       WHERE council_id = @councilId AND floor_id = @floorId
    `),
    listParticipants: db.prepare(`SELECT * FROM council_participants WHERE council_id = ? ORDER BY floor_id`),

    insertMaterial: db.prepare(`
      INSERT INTO council_materials (council_id, ord, path, bytes_total, bytes_included, truncated, content)
      VALUES (@councilId, @ord, @path, @bytesTotal, @bytesIncluded, @truncated, @content)
    `),
    listMaterials: db.prepare(`SELECT * FROM council_materials WHERE council_id = ? ORDER BY ord`),

    upsertRound: db.prepare(`
      INSERT INTO council_rounds
        (council_id, round_no, kind, proposal_text, proposal_from, agree, disagree, abstain, invalid, consensus, started_at, ended_at)
      VALUES
        (@councilId, @roundNo, @kind, @proposalText, @proposalFrom, @agree, @disagree, @abstain, @invalid, @consensus, @startedAt, @endedAt)
      ON CONFLICT(council_id, round_no) DO UPDATE SET
        proposal_text = excluded.proposal_text, proposal_from = excluded.proposal_from,
        agree = excluded.agree, disagree = excluded.disagree, abstain = excluded.abstain,
        invalid = excluded.invalid, consensus = excluded.consensus,
        started_at = COALESCE(council_rounds.started_at, excluded.started_at),
        ended_at = excluded.ended_at
    `),
    listRounds: db.prepare(`SELECT * FROM council_rounds WHERE council_id = ? ORDER BY round_no`),

    insertUtterance: db.prepare(`
      INSERT INTO council_utterances
        (council_id, round_no, floor_id, role, content, vote, vote_reason, proposal_text, second_floor,
         stance, findings_json,
         status, error, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         started_at, ended_at, duration_ms)
      VALUES
        (@councilId, @roundNo, @floorId, @role, @content, @vote, @voteReason, @proposalText, @secondFloor,
         @stance, @findingsJson,
         @status, @error, @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
         @startedAt, @endedAt, @durationMs)
    `),
    listUtterances: db.prepare(`SELECT * FROM council_utterances WHERE council_id = ? ORDER BY round_no, floor_id`),
  };

  /** Cascade delete of those child tables (no foreign keys in schema.sql, so the delete order is visible right here) */
  const councilChildDeletes = [
    'DELETE FROM council_utterances WHERE council_id = ?',
    'DELETE FROM council_rounds WHERE council_id = ?',
    'DELETE FROM council_materials WHERE council_id = ?',
    'DELETE FROM council_participants WHERE council_id = ?',
  ].map((sql) => db.prepare(sql));

  /**
   * @param {{id:string, topic:string, threshold:string, maxRounds:number, createdAt:number,
   *          mode?:string, workspacePath?:string|null}} arg
   *   mode / workspacePath defaulting is the old behavior: voting + a one-off temp directory. The caller
   *   (the route) already validated both; this only falls back to the defaults, it makes no value
   *   judgment —— that is the route's job.
   */
  function createCouncil(arg) {
    councilStmt.insert.run({
      id: arg.id,
      topic: arg.topic,
      mode: arg.mode != null && arg.mode !== '' ? arg.mode : 'vote',
      workspacePath: arg.workspacePath != null && arg.workspacePath !== '' ? arg.workspacePath : null,
      threshold: arg.threshold,
      maxRounds: arg.maxRounds,
      createdAt: arg.createdAt,
    });
    return councilStmt.get.get(arg.id);
  }
  const getCouncil = (id) => councilStmt.get.get(id) || null;
  /** @param {number} limit */
  const listCouncils = (limit) => councilStmt.list.all(Math.max(1, Math.min(Number(limit) || 50, 500)));
  /** Put a meeting into running; one already running (or finished) is left alone, returns whether it really flipped */
  const markCouncilRunning = (id, at) => councilStmt.markRunning.run(at, id).changes > 0;
  const setCouncilRound = (id, roundNo) => councilStmt.setRound.run(roundNo, id);
  /** @param {{verdict:string, verdictRound?:number|null, error?:string|null, status?:string}} arg */
  function finishCouncil(id, arg) {
    const verdict = arg.verdict;
    // verdict → status mapping (each of the three endings goes its own way, do not mix "cancelled" into
    // "failed"):
    //   consensus / no_consensus / reported → done (**failing to agree, and analysis mode's "ran
    //                                          through", are both normal endings**, not errors)
    //   cancelled                          → cancelled
    //   anything else (failed)             → failed
    const status =
      arg.status ||
      (verdict === 'consensus' || verdict === 'no_consensus' || verdict === 'reported'
        ? 'done'
        : verdict === 'cancelled'
          ? 'cancelled'
          : 'failed');
    councilStmt.finish.run({
      id,
      status,
      verdict,
      verdictRound: arg.verdictRound != null ? arg.verdictRound : null,
      error: arg.error != null ? arg.error : null,
      endedAt: arg.endedAt != null ? arg.endedAt : Date.now(),
    });
    return councilStmt.get.get(id);
  }
  /** Delete a meeting: its own child tables go with it. **Returns whether anything was deleted**, the route distinguishes 404 from 200 on that */
  function deleteCouncil(id) {
    const del = db.transaction((cid) => {
      for (const st of councilChildDeletes) st.run(cid);
      return councilStmt.del.run(cid).changes;
    });
    const n = del(id);
    if (n > 0) db.pragma('wal_checkpoint(TRUNCATE)');
    return n > 0;
  }
  /**
   * Reconciliation at server start: when the last process was hard-killed (or crashed), the DB keeps
   * meetings with status='running' whose participant processes are long gone. **Mark them failed
   * honestly** and state the reason —— do not leave them there pretending they are still discussing.
   * @returns {number} how many rows were marked
   */
  function failStaleCouncils(reason, at) {
    return councilStmt.failStaleRunning.run({ error: reason, at: at != null ? at : Date.now() }).changes;
  }

  const insertParticipant = (p) => councilStmt.insertParticipant.run(p);
  const setParticipantStatus = (councilId, floorId, status, error) =>
    councilStmt.setParticipantStatus.run({ councilId, floorId, status, error: error != null ? error : null });
  const listParticipants = (councilId) => councilStmt.listParticipants.all(councilId);

  const insertMaterial = (m) => councilStmt.insertMaterial.run(m);
  const listMaterials = (councilId) => councilStmt.listMaterials.all(councilId);

  const upsertRound = (r) => councilStmt.upsertRound.run(r);
  const listRounds = (councilId) => councilStmt.listRounds.all(councilId);

  /** One speech / one vote. Any field that cannot be read is given null, never 0 or an empty string (0 tokens and "tokens could not be read" are not the same thing) */
  function insertUtterance(u) {
    councilStmt.insertUtterance.run({
      councilId: u.councilId,
      roundNo: u.roundNo,
      floorId: u.floorId,
      role: u.role || 'speaker',
      content: u.content != null ? u.content : null,
      vote: u.vote != null ? u.vote : null,
      voteReason: u.voteReason != null ? u.voteReason : null,
      proposalText: u.proposalText != null ? u.proposalText : null,
      secondFloor: u.secondFloor != null ? u.secondFloor : null,
      // Those two analysis-mode columns: **nothing parsed means null**, not '{}' —— "gave no points" and
      // "gave points but all three are empty" display differently (see the notes on findings_json in
      // schema.sql)
      stance: u.stance != null ? u.stance : null,
      findingsJson: u.findingsJson != null ? u.findingsJson : null,
      status: u.status || 'ok',
      error: u.error != null ? u.error : null,
      inputTokens: u.inputTokens != null ? u.inputTokens : null,
      outputTokens: u.outputTokens != null ? u.outputTokens : null,
      cacheReadTokens: u.cacheReadTokens != null ? u.cacheReadTokens : null,
      cacheWriteTokens: u.cacheWriteTokens != null ? u.cacheWriteTokens : null,
      startedAt: u.startedAt != null ? u.startedAt : null,
      endedAt: u.endedAt != null ? u.endedAt : null,
      durationMs: u.durationMs != null ? u.durationMs : null,
    });
  }
  const listUtterances = (councilId) => councilStmt.listUtterances.all(councilId);

  return {
    ...stmt,
    listMessages, purgeProject, purgeMember, deleteTaskRun, deleteTaskRunsByFilter,
    getSetting, setSetting, getRetentionDays,
    createCouncil, getCouncil, listCouncils, markCouncilRunning, setCouncilRound, finishCouncil,
    deleteCouncil, failStaleCouncils,
    insertParticipant, setParticipantStatus, listParticipants,
    insertMaterial, listMaterials,
    upsertRound, listRounds,
    insertUtterance, listUtterances,
    raw: db,
  };
}

module.exports = { openDatabase, createRepo, applyPragmas, migrate, SCHEMA_PATH };
