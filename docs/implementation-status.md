# WorkGremlin Implementation Status (doc ↔ code alignment record)

| Item | Content |
| --- | --- |
| Generated | 2026-10-21 |
| Baseline | Workspace `HEAD = e2ad323` ("refactor: simplify workstation state to busy idle blocked"), clean tree |
| State-model baseline | 2026-10-21: the workstation state machine was reduced to **busy / idle / blocked**. The heartbeat, `offline`, task liveness inference, retention windows on state, and the `degraded` flag were removed. See §5 row 22. |
| Purpose | Record **what the code actually does**, and where it differs from `requirements*.md` / `tech-design.md` / `roadmap.md` / `test-strategy.md` / `runbook.md` |
| Maintenance | When a change to the domain model / data sources / API lands, update this file. Requirement changes go to `requirements.md`. **This file describes implemented facts only; it expresses no product preference and is not a specification.** |

> The specification is `docs/requirements.md`. This document answers "where do the spec and the implementation disagree", one line per difference, so nobody has to infer current behavior from stale prose.

---

## 0. One-line status

The product positioning is unchanged (a local, read-only visual terminal for multi-agent collaboration), but the implementation has left the v0.1 design:

- The domain unit is a **project**, not a **team** (commit `def3fee`).
- The UI grew from "workstation view + conversation log, two tabs" into **floors (1F–9F, one per monitored product) + an isometric Canvas office + a main-agent console**.
- Members come from **hook reporting / the `.codebuddy/agents` roster / the ghost lifecycle / on-disk scanning**, not from a `config.json` roster plus an A-route directory watcher.
- A **council chamber** exists: pick floors (one moderator, one main answerer, several reviewers), give it one topic, and it runs a multi-round review. There is no vote and no threshold; every round stores one `RoundResult`, and the server computes convergence mechanically from severities and conflicts. Participants are one-off, read-only processes started by the server, running in a temp directory or a supplied project directory; **they never enter the office or the task ledger** (§4.2).
- The promised **A route (`chokidar`), message redaction, FTS5 query wiring, dual-connection storage, TypeScript migration, and Playwright E2E** are still missing. Automated tests do exist now, but they are **73 plain Node suites**, not the Vitest + Playwright setup the test strategy describes.
- A workstation has exactly three states: **`busy` / `idle` / `blocked`**. State is derived from running tasks, explicit authorization waits, and borrowed summon busy — **never from a heartbeat, elapsed time, or message silence**.

---

## 1. Layering and directory responsibilities

```
shared/                  protocol source of truth (CJS, zero dependencies, Node + browser isomorphic)
  index.js               constants / envelope / dedupeKey / state + role colors   ← PROTOCOL_VERSION = 2
                         AGENT_STATES = ['busy','idle','blocked']; WS_HEARTBEAT_TIMEOUT_MS is transport-only
  index.d.ts             type declarations
server/                  Express + ws + better-sqlite3; embeddable in Electron or standalone
  src/index.js           createServer(): DB / bus / hub / routes / project management / roster
  src/cli.js             standalone start + --self-test (create tables → write → read back → checkpoint)
  src/config.js          port probe (21800-21820), random token per start, ~/.workgremlin/server.json
  src/clock.js           clock abstraction (test contract 7.1)
  src/db/{schema.sql,index.js}   tables + prepared statements + PRAGMA + migrations
  src/ingest/bus.js      the single write entry: persist → broadcast → build member card / snapshot
  src/ingest/agentRoster.js     .codebuddy/agents roster → resident gremlins (seated, with a badge)
  src/ingest/agentLevel.js      user-level / project-level decision (badge color) + description (static)
  src/ingest/hookCommon.js      shared hook-event semantics: registration, tasks, file activity,
                                tool usage, ghost lifecycle, blocked / clear-blocked
  src/ingest/hookDispatch.js    raw hook event → the owning floor's handleHookEvent
  src/project.js         project name resolution (package.json name > directory name)
  src/workspace.js       "open project": switch + persist workspaces.json + recent 8
  src/products.js        floors = monitored products (install location + on-disk detection)
  src/floors.js          floor registry + generic session/disk readers + per-floor dispatch
  src/sessions.js        structured on-disk plugin parsing (genie-history / todos / message-queue /
                         file-changes) + the reporter phase reader
  src/sessionRegistry.js global active-session table (sessions with no event for 60 min are dropped)
  src/ws/hub.js          WS connection management, subscription filters, broadcast
  src/http/routes/*      health / query / ingest / workspace / floors (products) / sessions / council
  src/council/*          orchestrator, agents (spawn recipes), parse, convergence, report
desktop/                 Electron main process (embeds the server, single-instance lock), preload, window, menu
renderer/                Vue 3 + Vite + Pinia
  src/iso/               hand-written Canvas isometric office engine (engine, officeMap, sprites, mainConsole)
  src/views/             IsoOfficeView (main) / OfficeSceneView (old 2D, kept for comparison) / Workstation /
                         Conversation / DeskLab / TaskRecordsView / CouncilView
  src/stores/            project (members + connection) / sessions (floors + sessions) / messages / mainAgent
  src/lib/memberTask.js  the renderer's single state rule (blocked > busy > idle, session-scoped)
packages/reporter/       agent-side reporting SDK + CLI + hook (CodeBuddy plugin/CLI, Codex / Claude Code /
                         Qoder CLI) + the OpenCode/Kilo plugin
scripts/                 dev / build / postinstall(electron-rebuild) / install-hooks
docs/                    requirements, tech design, roadmap, test strategy, runbook, floor design, this file
```

The 60-minute window in `sessionRegistry` is **session-list activity**, not a member state and not a liveness signal. A running task is the only task-liveness signal.

---

## 2. Runtime data flow

```
CodeBuddy plugin/CLI, Codex / Claude Code / Qoder hooks ─┐
reporter SDK / CLI (workgremlin-report) ────────────────┤ POST /api/v1/{register,
                                                        │   task/start|progress|end|tokens|current,
                                                        │   message, file/touch, tool/use, ghost, hook}
.codebuddy/agents/*.md (roster) ────────────────────────┤        │
product on-disk session stores ─────────────────────────┘        v
                                                          ingest bus ──> SQLite + WS Hub ──> renderer (Pinia)
                                                                 │
                                                                 └─> buildMemberCard() / buildSnapshot()
```

There is **no** `/api/v1/heartbeat` and **no** `/api/v1/status`. The real ingest surface is listed below.

| Method | Route | Body (abridged) | Effect |
| --- | --- | --- | --- |
| POST | `/api/v1/register` | `{memberId,name,role?,sessionId?,client?,workspacePath?}` | Register/update a member, `reported=1` |
| POST | `/api/v1/task/start` | `{memberId,taskId?,title,sessionId?,parentTaskId?,workspacePath?}` | Create a task; that session becomes busy |
| POST | `/api/v1/task/progress` | `{memberId,taskId,progress,note?,files?,sessionId?}` | Store 0..1 progress; also clears that session's blocked |
| POST | `/api/v1/task/end` | `{memberId,taskId,state:'done'\|'failed'\|'cancelled',artifacts?,sessionId?}` | Finish the task; idle unless another task in that session is running |
| POST | `/api/v1/task/tokens` | `{memberId,tokens}` | Backfill the four token columns only; retry-safe |
| POST | `/api/v1/task/current` | `{memberId,sessionId?}` | Wrap-up fallback: find the member's current task |
| POST | `/api/v1/message` | `{from,to?,type,subject?,content,taskId?,ts?}` | Message stream (deduped by `dedupe_key`) |
| POST | `/api/v1/file/touch` | `{memberId,files\|path,op:'read'\|'write'}` | File activity |
| POST | `/api/v1/tool/use` | `{memberId,taskId,tool,...}` | Increment the tool-usage counter for a task |
| POST | `/api/v1/ghost` | `{action:'spawn'\|'finish'\|'sweep',...}` | Ephemeral subagent ghost lifecycle |
| POST | `/api/v1/hook` | raw hook event + `workspacePath` | Forwarded to the server-side hook dispatcher; the floor reads disk and writes the ledger |

Query routes: `GET /api/v1/snapshot`, `projects`, `project-sizes`, `messages`, `task-runs`, `task-feed`,
`subagent-runs`, `sessions`, `reporter-phase`, `workspace`, `products`, `settings/retention`, `health`;
`DELETE /api/v1/task-runs/:id`, `DELETE /api/v1/task-runs`, `PUT /api/v1/settings/retention`; council routes
under `/api/v1/councils`. `/task-runs` and `/task-feed` return `tasks.state` directly — there is no
heartbeat-based or elapsed-time normalization, and `blocked` is not a task state.

### 2.1 The five member/data sources (all implemented)

| Source | Trigger | Output | Evidence |
| --- | --- | --- | --- |
| Hook reporting | CodeBuddy-family hooks send `SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Notification / PermissionRequest / Stop / SessionEnd` (plus family-specific events) | Member registration, task start/progress/end, file activity, tool usage, ghost spawn/finish/sweep, and **blocked only when that session is waiting for authorization** (`reason='awaiting_permission'`), cleared by task progress, task end, session end, or an idle notification. No heartbeat, no periodic state write. | `packages/reporter/src/hook.js`, `server/src/ingest/hookCommon.js`, `server/src/ingest/hookDispatch.js` |
| Resident roster | Scans `<workspace>/.codebuddy/agents/*.md` and `~/.codebuddy/agents/*.md` | Seated gremlins with `role=subagent`, `ephemeral=false`. Their own state is idle unless a same-named ghost is working, in which case the server records **borrowed busy** in `agent_status` (display only, not task liveness). Resident↔ghost name matching is **case-insensitive** (`shared.agentNameKey`): a resident is named after the definition file stem (`simmon.md` → `simmon`) while a summon reports the frontmatter `name` (`Simmon`). | `server/src/ingest/agentRoster.js` |
| Ghost feed | `POST /api/v1/ghost` from hook/plugin events; open ghosts are rehydrated from `subagent_runs` after a restart | `ephemeral=true` members that hover above the floor, each with its own task and `subagent_runs` row; the ghost disperses when the parent task ends or the orphan cleanup window passes. There is no manifest file and no feed poller anymore. | `server/src/ingest/bus.js` (`ghostSpawn` / `restoreGhosts` / `gcGhosts`), `server/src/ingest/hookCommon.js` |
| Disk scan | Polls each product's data directory | Floor sessions, todos, changed files, completion marker, and a session activity phase marked `inferred` | `server/src/products.js`, `server/src/sessions.js`, per-floor modules (`floorCline.js`, `floorKilo.js`, `floorOpenCode.js`, `floorCopilot.js`, `lingma.js`, …) |
| Codex CLI hook | Codex native hooks (`~/.codex/hooks.json`, 10 events) | Member registration, tasks, file activity, phase, subagent ghosts — same pipeline as CodeBuddy | `packages/reporter/src/hook.js` (`WORKGREMLIN_CLIENT=codex`), `scripts/install-hooks.js` |

### 2.2 Discipline: if it cannot be read, it stays empty

- No running task means **idle**, not "offline" or "stale". There is no timeout that flips a member's state.
- A `pending` task is not busy. A task is running exactly while `tasks.state = 'running'`.
- Progress that was never reported renders "进度未知（未上报）" (`progress.unknown`), never 0%.
- File counts, token counts, model names, and durations stay `NULL` when the floor cannot provide them; the UI shows "—".
- A session's activity phase may be inferred from file mtimes (for example `IDLE_MS = 10 min` in `server/src/floors.js`), and the UI greys it as inferred. That is a **session phase**, not a workstation state.

### 2.3 Report ownership follows `workspacePath`, not the office's open project

Fixed on 2026-09-29. The hook used to take `workspacePath` from `/api/v1/workspace` (the project open in the
office) and the server used `body.project` as the destination, so "office is showing A while I run the CLI in B"
recorded the task / member / file activity under A. Now `resolveCtx` always reports `REAL_WS` (the cwd where the
agent started the hook), and `projectFirst` in `server/src/http/routes/ingest.js` calls
`bus.projectForReport()` to resolve the project **by `workspacePath`**: match `projects.workspace_path`, otherwise
create one using `package.json name > directory name`. Old reports with no `workspacePath` fall back to
`body.project`, unchanged. Regression: `npm run test:project-attribution`.

The "project" shown in task details is computed **from the directory at read time**
(`/task-runs.project_label = resolveProjectName(project.workspace_path)`), not the stored `projects.name`. When two
different directories share a name, the office suffixes the new project's id/name to avoid a collision (measured:
`/home/yinghui/work/stb-insight` has `package.json name = stb-dashboard`, but that id was already taken by a stale
row, so the database row is `stb-dashboard-2`). Display uses the directory-derived name and only falls back to
`projects.name` when the directory cannot be read.

### 2.4 IDE-form pitfalls (fixed 2026-09-27)

1. **The submitted prompt is composed.** The IDE injects `# Context from my IDE setup:` / `## Active file:` /
   `## Open tabs:` before the user's sentence, which sits after `## My request:`. The hook's `userRequestText()`
   keeps only the request body; otherwise task titles are all IDE context and the user's words never appear. Old
   data is stripped again in the renderer by `TaskRecordsView.vue`'s `promptOf()`.
2. **Changed files come from three routes.** (a) `PostToolUse` parses the `apply_patch` patch text from
   `tool_input` (both `command` and `input` keys are accepted); (b) at wrap-up, the authoritative list in the
   transcript (`Success. Updated the following files:` + `M/A/D <path>`) is replayed from the start of the turn,
   because the IDE form often sends no patch text in `PostToolUse`; (c) a fallback scans `git ls-files` (tracked +
   untracked-but-not-ignored) for files with an mtime after the turn started, catching shell edits (`sed -i`,
   `patch`, python writes, redirection). Ignored build output such as `dist/` is skipped, and non-git projects
   return empty. Self-test: `npm run test:ide-hook`.
3. **Client vs form.** CLI and IDE extension of Codex (3F) and Claude Code (4F) share one on-disk store and one
   `client` (`codex` / `claude`), so `client` alone cannot show "Codex CLI" vs "Codex Plugin". The hook derives
   the **form** from that session's own records (`form = 'cli' | 'vscode' | 'ide' | 'desktop'`), reports it with
   the task, and it lands in `task_runs.form`; the task list labels "product + form". Codex reads the rollout's
   `session_meta` (`source` / `originator`, `codexForm()`; the desktop app is `source=vscode` +
   `originator='Codex Desktop'`, checked before the VS Code extension so it is not mislabeled as Plugin). Claude
   reads the `entrypoint` in lines 3–5 of the transcript (`cli` terminal / `claude-vscode` extension,
   `claudeForm()`), using the same rule at both call sites (turn start and wrap-up). Anything unrecognized (old
   version without the field, another form such as `sdk-cli`, unreadable disk) stays empty — never guessed. Labels
   that already carry a form (CodeBuddy CLI / Plugin) are not appended twice. Self-tests:
   `npm run test:task-client` (`renderer/test/taskClientLabel.test.mjs`), `npm run test:ide-hook` section [7]
   (Codex), `npm run test:claude-hook` (`server/test/claudeHook.test.js`).

---

## 3. Domain model (`server/src/db/schema.sql` is authoritative)

The ownership unit is the **project** (`projects`). There is no `team` table and no `agent_status_history`.

| Entity | Key fields | Difference from the docs |
| --- | --- | --- |
| `projects` | `id`, `name`, `workspace_path`, `main_conversation_id`, `source CHECK IN ('report','watch')` | Formerly `teams`; the virtual demo project uses the reserved id `__demo__` but is never stored in this table; retired `source='timeout'` values are migrated to `'watch'` |
| `members` | `id`, `project_id`, `name`, `role`, `session_id`, `reported`, `created_at`, `ephemeral`, `project_label`, **`client`** | **No `last_seen_at`** (dropped by migration). Adds ephemeral ghosts and their project label. Badge level is not stored (computed at runtime). `client` is the product base name (`codebuddy` / `cline` / `codex` / `claude`, NULL = generic); the office filters by the current floor's client |
| `agent_status` | `member_id` PK, `state CHECK (state = 'busy')`, `state_since`, `updated_at` | **Only borrowed busy** for a resident gremlin whose same-named ghost is working. Idle is "no row". Main-agent busy is always derived from `tasks.state`. No `progress`, `current_files`, `task_id`, `last_heartbeat_at`, `degraded`, or `source` |
| `session_status` | `member_id`, `session_id`, `state CHECK (state = 'blocked')`, `state_since`, `updated_at`, PK `(member_id, session_id)` | **Only explicit authorization waits.** No row = not blocked. Blocked is session-scoped: two sessions of one member do not affect each other. Cleared by task progress / task end / session end / idle notification |
| `tasks` | `id`, `project_id`, `member_id`, `parent_task_id`, `title`, `state CHECK IN ('pending','running','done','failed','cancelled')`, `progress`, `started_at`, `ended_at` | **No** `progress_source` / `blocked_reason` / `waiting_on` / `error_type`. A task is live exactly while `state='running'`; there is no timeout that cancels it. Stale cleanup only happens on explicit session reconciliation (`pruneSessionStatuses` closes running tasks of vanished sessions as `cancelled`) |
| `messages` | `dedupe_key` unique, `archived_at`, `content_truncated`, `session_id`, `source` | **No** `redacted` / `redaction_hits` / `ingested_at_ms` / `reply_to` |
| `messages_fts` | FTS5 `tokenize='trigram'` + three sync triggers | Table exists, but **queries do not use it** (see §5) |
| `file_activity` | `op CHECK IN ('read','write')` | `edit` was retired, not a gap |
| `tool_usage` | PK `(task_id, tool)`, `count`, `first_at` / `last_at`, plus project/member/client/session | **New table** (task detail → "tool usage"): accumulates one row per (task, tool) instead of one row per call. Written by `POST /api/v1/tool/use`; `/task-runs` returns `tools: [{tool,count}]`; cleared with `deleteByTopIds` |
| `artifacts` | `member_id`, `task_id`, `kind CHECK IN ('file','doc','pr','text')`, `title`, `path` | Output artifacts |
| `task_runs` | PK `tasks.id`; `client`, `form`, `model`, `title`, `result`, `file_count`, `files_json`, four token columns, `started_at` / `ended_at` / `duration_ms` | The per-turn user-work ledger; the four token semantics are normalized (input excludes cache, output includes thinking). Peer turns count every API request, not the last request's context |
| `subagent_runs` | `parent_task_id`, `task_id`, `member_id`, `name`, `agent_id`, `call_id`, `background`, `result`, `files_json`, tokens | One row per summoned ghost instance; kept after dispersal as the ledger of "how many subagents this turn used" |
| `councils` + `council_participants` / `council_materials` / `council_rounds` / `council_reviews` / `council_utterances` / `council_reports` | Seven council tables (see §4.2) | **New tables**, absent from the spec. No intersection with `members` / `task_runs`: participants are not floor members and never enter the office or task records |
| `events` | `project_id`, `ts_ms`, `kind`, `payload_json` | Table exists but **has no writer** |
| `settings` | key/value (currently retention days) | Server-written; read/written through `/api/v1/settings/retention` |

**Migration (`server/src/db/index.js`).** A migration rebuilds legacy heartbeat-era `agent_status` and
`session_status` tables (dropping `task_id`, `last_heartbeat_at`, `degraded`, `source`), drops
`members.last_seen_at`, drops `agent_status_history`, and rewrites retired `projects.source='timeout'` to
`'watch'`. Old council tables with `mode` / `threshold` / vote columns are dropped and rebuilt.

---

## 4. Floors and session model (concepts absent from the spec)

The left-hand "floors" are monitored agent products. A floor counts as `installed` only when an **install
location** is found; an on-disk data directory alone is not evidence (otherwise a hand-written `settings.json`
could fool the detector).

| Floor | Product | On-disk form and notable behavior |
| --- | --- | --- |
| 1F | CodeBuddy (**CLI and Plugin merged into one floor**) | CLI: `*.jsonl` under `~/.codebuddy` + the reporter state file. Plugin: structured directories in the editor's globalStorage (genie-history / todos / message-queue / file-changes — the only route that yields runtime state). Both forms open at once are **two sessions** in this floor (separated by `session_id`), not two floors. |
| 2F | Cline (**CLI and VS Code extension merged**) | Data root `~/.cline/data` (`$CLINE_DATA_DIR` → `$CLINE_DIR/data` → `~/.cline/data`); extension and CLI **share one store**. The VS Code `globalStorage/saoudrizwan.claude-dev` layout is pre-migration legacy (`LegacyStateReader`). Session index = `db/sessions.db` (`session_id` / `source` (`vscode` / `cli`) / `model` / `cwd` / `workspace_root` / `updated_at` / `metadata_json`); conversation = `sessions/<id>/<id>.messages.json`; metadata = `sessions/<id>/<id>.json`. Cline has a hook subsystem but it is opt-in and **not wired**, so 2F is a **polling floor**: phase is inferred from the message tail (assistant `tool_use` → tool, `thinking` → thinking, `text` → idle; user `tool_result` / prompt → thinking), always `inferred:true`. The form comes from the session row's `source`. Subagent rows (`is_subagent=1`) are not listed separately. **Changed files are always unknown**: the conversation keeps tool calls but not "which files were edited" (`read_files` / `search_codebase` are reads), so `file_count` / `files_json` stay `NULL`. Output = the closing assistant text of the turn (`attempt_completion`, markdown preserved, 4000-char cap). A **terminal session is reclaimed immediately** when Cline wrote `ended_at` / a terminal `status` (`completed` / `cancelled` / `failed` / `error`); 7F/8F have no terminal concept and keep the time window. The task ledger is unaffected (`syncTasks` still writes every turn), so "任务取消" still appears in task records. Self-test: `npm run test:cline` section [H]. |
| 3F | Codex CLI | `~/.codex/sessions/YYYY/MM/DD/*.jsonl`; `cwd` is in the first line's `payload.cwd`. |
| 4F | Claude Code CLI | `~/.claude/projects/<project-dir>/*.jsonl`; `cwd` starts at the line-3 `user` record (the first line has none; see `sessionRegistry.js` `cwdOfHead`). Several sessions on this floor are distinguished by `session_id`; the form (terminal / VS Code extension) is on the same `user` record (`entrypoint`, see §2.4 item 3). |
| 5F | TraeCode (**IDE and Plugin merged into one floor**) | Session source is the reporter state file (`sessionId` / `workspacePath` are measured hook payload values). Neither form has a scannable **session** store: the IDE's `~/.trae-cn/memory/projects/<project>/<date>/session_memory_<session>.jsonl` and `project_memory.md` are memory files (the name contains a session id, but there is no conversation or project path); the plugin's `~/.marscode` holds an encrypted ai-chat binary, logs, `ai-agent/database.db`, and `snapshot/<chain-id>/v2/.git` snapshots (the first is encrypted, not readable SQLite; the second is a per-turn git snapshot) — so **the plugin form does not support session records today**. Both directories are listed in the floor capsule tooltip (two lines, no `sources[].note`, only directory + on-disk stats). The form is distinguished by the reported identity (`client`); the task list uses `CLIENT_LABELS` to show **TraeCode IDE** / **TraeCode Plugin**, with no floor-specific branch. |
| 6F | Qoder (**CLI and plugin merged**, same rationale as 4F) | Three session routes: (1) transcript `<CLI root>/projects/<project-dir>/<session>.jsonl` — both the international `~/.qoder` and China `~/.qoder-cn` roots are scanned and deduped by `session_id`; the format matches Claude Code (file name = `session_id`, each line carries `cwd`, resolved by `sessionRegistry.js` `SUBTREE` / `sessionIdOfFile` / `cwdOfHead`); (2) reporter state file as a fallback when the JSONL has not been written or read yet; (3) the **plugin form** (VS Code / Trae CN "Qoder CN (Formerly Lingma)") has no hook subsystem and does not write `~/.qoder` transcripts, so its sessions and phase come from polling its own `local.db` (`chat_session` / `chat_record`, `server/src/lingma.js`). Without that route, plugin tasks appear in task records while the main console has no session (the console strictly follows the selected session). The three routes dedupe by `session_id` (a live CLI session retires the hook row; plugin `chat_session.session_id` cannot collide with transcript names, so both forms can coexist as two sessions). The `~/.qoder` route is display-only (file count / size / last write). Hooks are installed into `~/.qoder/settings.json` (same shape as Claude / CodeBuddy) via `--agent qoder`; the event table defaults to the widest Claude-style set (`QODER_EVENTS`) until the real names are confirmed. **Qoder only emits `SessionStart` / `SessionEnd`, with no fine-grained events**, so `hook.js` adds coarse "thinking / done" phases; 6F never stays "未上报", but phase precision is lower than Claude (it will improve automatically if Qoder ships finer events). |
| 7F | Kilo Code (**polling + plugin**) | Kilo has **no hook subsystem** (measured on 7.8.1: no hook subcommand, no `hooks.json`, no event points), so there is no hook reporting and no session JSONL. 7F is polled from Kilo's **event-sourced SQLite** (`~/.local/share/kilo/kilo.db`, WAL mode, opened read-only so Kilo's daemon is not blocked): `session` (id / directory / title / agent / model / time_updated / summary_*), `event` (append-only, `aggregate_id` = session, monotonic `seq`, `part.type ∈ tool\|text\|reasoning\|step-start\|step-finish\|patch`, `part.state.status ∈ running\|pending\|completed\|error`), `message` (role, `path.cwd`, `finish ∈ stop\|tool-calls\|length\|content-filter`). Phase is derived from the **latest event** (tool+running → tool, tool+pending → awaiting authorization, reasoning → thinking), not guessed from file times. **`text` does not mean idle**: within one turn Kilo emits assistant text several times, so the rule joins `part.messageID` back to `message`: only `finish=stop` with `time.completed` means the turn is over → idle; `finish=tool-calls` or no finish yet → thinking. The plugin route fixed the same issue (assistant text used to report idle; now thinking, with `message.updated` finish / `session.idle` still closing the turn). **"Thinking" must carry content**: polling used to hard-code `prompt:''`; `readRoundPrompt()` now takes the current turn's `role=user` text part (strips outer JSON quotes, 80-char cap) and passes it through `sessionRegistry`; the plugin route writes the user's words into `taskTitle`, which `readReporterPhase` reads as `prompt`. Completion marker = the assistant message with `finish=stop` (`tool-calls` / `length` / `content-filter` do not count). The data root follows XDG (`kiloHome()`), **not** `~/.kilo` (that directory only holds an install-time `bin/`). There is a single `kind:'kilo'` source (SQLite, wholly different from scanning JSONL). Because it is polling, phase is always `inferred:true`. Self-tests: `npm run test:kilo` and `npm run test:task-sync`. **Task ledger exists on both routes**: polling is read-only plus per-turn sync; the plugin writes live. |
| 8F | OpenCode (**polling + plugin**) | Same origin as 7F (Kilo Code CLI is an OpenCode fork: data root `{kilo,opencode}.db` + `storage/session_diff/` + `repos/` + `shell/` + `snapshot/`), but the **V2 schema has diverged; copying 7F's readers yields empty data**: measured Kilo 7.8.1 has 2288 rows in `event`, OpenCode 2.0.18 has **0** (events are streamed in memory, not persisted). So 8F reads `session_v2` (id / directory / title / agent / model / time_updated / summary_*) + `session_message` (`type ∈ assistant\|user\|idle\|synthetic`; `data.content[]` with `part.type ∈ tool\|reasoning\|text`; tool blocks are `{type:'tool',name,state:{status,input}}`). Phase comes from the latest message's `content[]` (tool+running → tool, tool+error → tool with error, reasoning → thinking, `type:'idle'` row → idle), always `inferred:true`; the completion marker is the row with `finish=stop` and `time.completed` (`tool-calls` / `error` do not count). Table and column names are **probed** (`session_v2` → `session`, `pragma table_info` intersection), so an OpenCode rename cannot break the endpoint. **Key capability gap: polling cannot express "awaiting authorization"** — across 114 assistant messages, `tool.state.status` only ever held `completed / error / running`, never `pending` (Kilo has pending); authorization is a separate `permission.asked` event that only exists in the memory stream. 8F therefore adds a `kind:'hook'` route: with the WorkGremlin plugin installed (`packages/reporter/src/plugin/`, implementing OpenCode/Kilo's `ctx.event.subscribe`; state-file format identical to `hook.js`, zero server changes), phase is **reported truth** (not inferred, not greyed), "awaiting authorization" appears, and the completion marker carries a **changed-file list** (`session.step.ended` `data.files`). Without the plugin it falls back to polling. **2026-10-16 (v2 vocabulary)**: OpenCode 2.0.30 changed the event set — no `message.updated` / `message.part.updated`; instead `session.inbox.enqueued` (user words), `session.tool.called` (tool name in `session.tool.input.started`), `session.execution.*` (turn start/end), `session.step.ended` (finish + tokens + `files`), `permission.asked`; the envelope changed from `{properties}` to `{id,created,type,location,data}` (`location.directory` = project path). The old plugin only understood v1, so on v2 it wrote nothing (no state file / ledger / tool usage, leaving only polling). The plugin now understands both generations; on v2 it produces a state file, `k_*` ledger rows, and tool counts (self-test `test:plugin-ingest` section [F]). Data root follows XDG (`opencodeHome()`); the `opencode` binary is at `~/.opencode/bin` and **not on PATH**, so `CLI_BIN_DIRS` explicitly includes it. Self-test: `npm run test:opencode`. Identity follows the 7F rules: the base name from the `setup(ctx)` entry is always `opencode`, and the form is always `cli` unless the desktop app is detected. |
| 9F | GitHub Copilot (**CLI and VS Code extension merged**) | No hook and no reporter, so tasks can only come from polling. The two forms keep independent stores, merged by session id: **CLI** (`~/.copilot`) has `session-store.db` (`sessions` / `turns` / `session_files`, same schema as the extension) plus `session-state/<session>/events.jsonl` (live user prompt / `turn_start`-`turn_end` / model / errors); **VS Code extension** (`globalStorage/github.copilot-chat`) has its own `session-store.db`, `state.vscdb` chat index, and `chatSessions/<session>.jsonl`. `copilotCliLiveRequest` and `readCopilotLiveRequest` share one shape (index / prompt / model / startedAt / completed / reqs), so `copilotInFlight` / `copilotDoneAt` work unchanged on either store; `readCopilotAllSessions` enumerates both for phase, done marker, and the task ledger. Phase is inferred (`readCopilotPhaseFromSqlite`, `inferred:true`); neither form exposes an "interrupted" signal, so cancellation is never reported. What the CLI store adds over the extension: the per-turn model (`assistant.message.model`) and a reliable in-flight marker. Self-test: `npm run test:copilot-cli`. |

Merged floors declare their `sources` in `products.js` (1F is `['cli','plugin','hook']`, 5F is two `dir` sources +
`hook`, 7F is one `kilo` source with its own data-root stats, 8F is one `opencode` source with its own data root
plus `hook` for plugin truth). A floor can consume several on-disk routes, but all routes share the floor's
bare client base name (`codebuddy` / `trae`); `form` distinguishes CLI, IDE, and plugin. Phase / completion
are accepted per session.

An entry is `{ kind, label?, client?, dirs?, note? }`:

- `kind: 'dir'` = display-only on-disk stats, no sessions (`sessions: false`); two `dir` entries use `label` to
  distinguish IDE / plugin in the tooltip. 5F's two routes deliberately carry no `note`.
- `label` also supplies display names for floors where one route covers two forms — 3F/4F/6F/7F are labeled
  `CLI/Plugin` (CLI and IDE plugin share one store and cannot be told apart), 8F is labeled `CLI/Desktop`.
- `kind: 'kilo'` = 7F only (reads Kilo's SQLite; a separate kind from `kind:'cli'` JSONL scanning).
- `kind: 'opencode'` = 8F only (reads OpenCode's SQLite; distinct from `kind:'kilo'` because it reads
  `session_message` while Kilo reads `event`).
- `kind: 'hook'` on 8F is **layered on top of** polling, not a replacement: when the plugin is installed it
  supplies truth; otherwise it stays empty and polling covers. Both dedupe by `session_id` in
  `sessionRegistry.claim`.

The floor capsule tooltip lists only **directory + file count / size / last write** for on-disk routes, with no
explanatory prose. Continuity tests: `server/test/mergedFloors.test.js` (`npm run test:floors`) and
`server/test/kiloFloor.test.js` (`npm run test:kilo`).

The selected session decides the main console's phase (ghosts follow it); the office layout is unaffected.
Selecting a floor with no active session clears the room.

**Session dropdown** (`renderer/src/stores/sessions.js` + `server/src/sessionRegistry.js`) is a flat list of the
current floor's active sessions, each shown as `CLI-<project> <short id>`. Two rules:

- **Reclaim**: default is "drop after 60 minutes without an event"; a polling floor that can express a terminal
  state reclaims immediately — currently only 2F Cline (it writes `ended_at` / a terminal `status`). 7F/8F have
  no terminal concept and keep the time window.
- **Short ids must be unique**: the short id is the shortest unique prefix **within that floor** (not a fixed 8
  characters). Cline ids are `<ms timestamp>_<random>`, so two sessions created in the same second share the
  first 8 characters; the dropdown used to render two identical `CLI-wg-cx 17923740` rows. Self-test:
  `npm run test:session-options`.

### 4.1 "Task cancelled" per floor (red "任务取消", not green "任务完成")

At wrap-up the main console asks one question: **did this turn finish, or was it stopped by the user?** The only
source of truth is the completion marker written by the reporter / each product's on-disk record (`done`);
`done.cancelled = true` turns the marker red. The third layer then shows "changed files / no output". The
renderer reads two paths: (1) `done.cancelled` from the fast `/reporter-phase` poll; (2) `doneCancelled` from the
`/sessions` snapshot; it ORs them (`IsoOfficeView.vue`).

The "was stopped" signal differs per floor. The rule: **if we know it was interrupted, show red; if we cannot
know, report no cancellation — never invent one.**

| Floor | Product | Cancellation signal (on-disk truth) | Where it lands |
| --- | --- | --- | --- |
| 1F | CodeBuddy (CLI + Plugin) | (1) CLI uses `Interrupt` when present. (2) **`FinalStop`** (the family's "end of turn" event): `final_stop_reason ∈ completed \| cancelled \| failed \| interrupted`; cancelled/interrupted closes as cancelled (`hook.js` `finishCancelled`), completed/failed is left to `Stop`. The installer writes `CODEBUDDY_EVENTS` into `~/.codebuddy/settings.json` (Trae is not merged in). (3) **Plugin (IDE extension)** emits no hook event on cancel (the extension log only has `AgentState.cancelled`, no `HookExecutor`); the server reads its own `message-queue/*.json` store: `conversations[<session>].runtime` with `paused:true + pauseReason:'cancel'` and `updatedAt ≥` turn start synthesizes a cancellation (`sessions.js` `codebuddyPauseCancelAt`). (4) An older fallback ("taskId present + idle longer than `TASK_RUN_MS` + transcript last turn still `running` ⇒ interrupted") was **removed on 2026-09-29** because it could not distinguish "still thinking" from "interrupted". | `hook.js` (`--agent codebuddy`) + `scripts/install-hooks.js` + `sessions.js`; regressions `test:final-stop` (11 cases), `test:codebuddy-cancel` (12 cases) |
| 2F | Cline | None (Cline's hooks are not wired) → no "任务取消"; the turn closes as "任务完成" | — |
| 3F | Codex | (1) Explicit `Interrupt`; (2) interactive sessions often do **not** send `Interrupt`, so `Stop` falls back to `event_msg/turn_aborted` (`reason=interrupted`) in the rollout | `hook.js` `runInterrupted` / `turnInterrupted`; regression `test:stop-interrupt` |
| 4F | Claude Code | Claude sends no `Interrupt`, and on 2026-09-29 it was measured to send **no hook event at all** after pressing stop (no `Stop` / `SessionEnd` / `Notification`), so the server polls instead, with two signals: (1) the transcript tail line `[Request interrupted by user]` (interrupt while the model was speaking or a tool was running); (2) **early interrupt** (ESC before the model emits a token; the CLI writes no transcript line), detected from Claude's own session state file `<claudeHome>/sessions/<pid>.json` with `status='idle'` + `statusUpdatedAt` (an **undocumented internal file**, used with explicit user consent; 3-second grace at turn start and the idle timestamp must be later than turn start to avoid false positives on a normal turn) | `sessions.js` `claudeInterruptTail` / `claudeSessionStatus` / `claudeInterruptOf` (+ `hook.js` `turnInterrupted`); regressions `test:claude-cancel`, `test:stop-interrupt` |
| 5F | TraeCode | **No readable cancellation signal** (no transcript, hooks only `Stop`/`SessionEnd`) → no "任务取消"; closes as "任务完成" | — |
| 6F | Qoder | Same as 4F (Claude transcript format): the server polls the transcript tail for the interrupt marker, recognizing both `claude` / `qoder` client base names. Qoder currently emits only coarse events, so this is often unavailable; the early-interrupt fallback (session state file) matches by `sessionId` and works if Qoder writes the same file | `sessions.js` `claudeInterruptTail` / `claudeInterruptOf` |
| 7F | Kilo Code | (1) With the plugin: if a turn is still open at `session.idle`, write `done.cancelled` (same shape as `hook.js` `Interrupt`) + a ledger `task/end(state=cancelled)`. In the VS Code extension this only works now: the reported identity comes from the environment (`KILO_CLIENT=vscode` → `kilo-plugin`), and the state file matches the one the server reads (`sessions.js` `clientHit` matches the `client` in the file content); before the fix the instance reported bare `kilo` and the HTTP layer stalled permanently because `server.json` was written late, so no cancellation marker reached disk. (2) **Pure polling cannot read "the user pressed stop"** (`message.finish` has no `interrupted`) → the red marker is not invented. The ledger still records unfinished turns as `cancelled` (only a terminal `finish` counts as `done`; `length` / `content-filter` also count as cancelled) — that means "this turn did not finish", not "the user cancelled" | `packages/reporter/src/plugin/index.js` (`session.idle` branch), `server/src/kilo.js` `readKiloRounds` |
| 8F | OpenCode | (1) Plugin route same as 7F (`session.idle`); (2) polling reads `session_message.type='idle'` / `data.outcome='interrupted'` | `plugin/index.js`, `server/src/opencode.js` `readOpencodeDone` |
| 9F | GitHub Copilot | **No readable cancellation signal** on either form (no hook; neither VS Code's chat log nor CLI's `events.jsonl` has an "interrupted" field — an aborted turn simply never gets its `turn_end`) → no "任务取消" | — |

Server passthrough: CLI / hook floors pass the reporter's `done.cancelled` straight through the fast poll; 7F/8F go
through `toReporterDone` (mapping the session-row shape's `doneCancelled` back to `done.cancelled`). The session
snapshot sends `sessionInfo.doneCancelled` / the row's `doneCancelled`; the 7F/8F branches used to spread the raw
`done` into the session row with mismatched field names, and now all go through `doneFieldsFromReporter`.

**Cancellation detection is structural, never a full-text string search** (`hook.js` `isInterruptLine`). Agent tool
output and reasoning frequently contain `turn_aborted` / `Request interrupted by user` (measured: running
`rg 'turn_aborted'`, or discussing interrupt logic, writes those words into the rollout). A text match would mark
an uninterrupted turn as cancelled, paint the console red, and wipe the result summary. The hook therefore parses
each line and only accepts Codex's `event_msg/turn_aborted` event line and the body text of a Claude-family `user`
message; tool results, thinking, and ordinary messages carrying the same strings do not count. Regression:
`npm run test:stop-interrupt` section [4].

**Wrap-up must also clear the live phase** (`hook.js` `Stop` / `Interrupt`). It used to clear only `taskId` and
leave `sessionPhase` (`thinking` / `tool`, with its timestamp frozen at the last event), while the server's
freshness window (about 5 minutes even after `taskId` was gone) kept treating it as fresh. The symptom: after
"任务完成 / 任务取消" flashed, the console stayed on "思考中", and the renderer guard ("a freshly lit wrap-up marker
must not be overwritten by a live phase") failed because `fastPhase.phase` was non-empty. Both wrap-up branches
now set `sessionPhase = null` (meaning: this turn is genuinely not moving), and the console shows idle for "hook
connected, nothing happening now".

**`Notification idle_prompt` must not clear `done`.** CodeBuddy CLI emits an `idle_prompt` about 60 seconds after
each turn (measured in `events.log`). That branch used to run `clearAwait()`, which also wrote `done = null`; since
`done` is the only evidence for "任务完成 / 任务取消", both the marker and the console's live state disappeared. Now
`idle_prompt` only clears `await` / `pending` and the phase, preserving `done` (a new `UserPromptSubmit` still
clears it normally). Regression: `npm run test:stop-interrupt` sections [1]/[5].

**The wrap-up guard compares timestamps, not "is there a live phase?"** (`IsoOfficeView.vue` consoleLive guard +
`readReporterPhase` returning `ts`). With Claude's server-synthesized cancellation plus a stale phase that nobody
cleared, `fastPhase.phase` stayed "思考中" and the old test (`!fastPhase.phase`) was useless: the red marker was
immediately overwritten. Now the marker may only be overwritten when the phase timestamp is **later than** the
wrap-up marker (a new `UserPromptSubmit` phase); paths without a timestamp (7F/8F polling) keep the old behavior.

**Cancellation is recorded like completion: cancelled means "did not finish", not "produced nothing".** Text already
emitted in the interrupted turn (`task_runs.result` + conversation `type=result`) and changed files
(`task/end.files`) are still recorded. The console's third layer picks "changed files → what it said → no output",
and only writes "没有输出" when there really is nothing. (Earlier code cleared `said` / `result` on cancellation to
avoid passing off the previous turn; now `turnReplies` starts from the current turn's user message and skips the
`[Request interrupted by user]` marker, so the current output cannot bleed into the previous turn.)

---

### 4.2 The council chamber: a second process shape (2026-10-01)

Everything in §4 monitors sessions **someone else** started: your terminal or editor runs the agent, and we only
read the traces it leaves on disk. The council is the opposite — **we** spawn an external CLI, host it to
completion, and leave nothing behind.

| | Monitored sessions (§4) | Council participants (this section) |
| --- | --- | --- |
| Who starts the process | The user / editor plugin | **The server** (`child_process.spawn`) |
| Enters the session registry | Yes (`sessionRegistry`, visible on floors and the main console) | **No.** Lives only in the seven `council_*` tables |
| Tools | Yes, per each CLI's own config | **Always read-only**: 1F/4F get `Read,Grep,Glob`; 7F/8F allow only `read/glob/grep/list`; 2F uses `--plan`; 3F uses `--sandbox read-only`. No file writes, no network |
| Working directory | The user's own project | **Depends on `workspace_path`**: NULL means a one-off directory under `/tmp`, created per meeting and deleted at the end; an absolute path means that directory, which **we never modify and never delete** |
| Writes the ledger | Yes (`task_runs` / `messages` / `file_activity`) | **No.** Nothing appears in the office or task records |
| Phase | Reported or inferred by polling | No phase concept (it is not a working agent; it is a participant speaking) |

**The only switch is `councils.workspace_path`** (NULL = isolated / absolute path = project). From 2026-10-02 to
2026-10-19 a `mode` (`vote` / `analysis`) existed orthogonally; the 2026-10-19 refactor deleted `mode`, vote
tallying, thresholds, and `consensus.js`. The flow is now fixed roles and identical in both working-directory
modes.

| | Isolated (`workspace_path` NULL, default) | Project (absolute path) |
| --- | --- | --- |
| Working directory | One-off `/tmp` directory, deleted at the end | The user's project directory, not deleted, contents untouched |
| What it can see | Only the topic and materials inlined into the prompt | **Real code** (read-only tools can inspect it) |
| Flow | Plan → proposal → reviews → moderator convergence, run to max rounds, then adjudicate | **Identical** |

Tools are read-only everywhere: 1F/4F get `--tools Read,Grep,Glob` (the same list is passed to `--allowedTools`,
otherwise `-p` with nobody to answer the permission prompt refuses outright; 4F additionally gets
`--permission-prompts none`); 2F uses `--plan`; 3F uses `codex exec --sandbox read-only` (OS sandbox); 6F uses
headless `-p` (operations needing confirmation are denied by default); 7F/8F inject a config that replaces the
all-deny permission table with `read/glob/grep/list`, while `bash/edit/write/webfetch` and **`external_directory`**
stay denied (the last one is critical: allowing it lets a participant read everything under `~`).

This is the first long-lived, server-hosted child process in the repository, so five hard constraints are
documented in `server/src/council/agents.js`:

1. **Disabling tools is a precondition, not an option.** 1F CodeBuddy / 4F Claude Code use `--tools ""` (both
   help texts say `Use "" to disable all tools`); 7F Kilo / 8F OpenCode have no tool switch (`kilo --pure` only
   disables external plugins — a misleading name), so a fully denied `permission` config is injected
   (`KILO_CONFIG_CONTENT` / `OPENCODE_CONFIG_CONTENT`); 2F Cline uses `--plan` (read-only plan mode; writes are
   rejected but read-only commands still run); 3F Codex uses `--sandbox read-only` (writes and network blocked,
   read-only commands allowed); 6F Qoder uses headless `-p`. Self-test: `npm run test:council-agents`.
2. **Environment variables are additive, not replaced.** Login credentials live in `~/.claude` / `~/.codebuddy`
   and are found through `HOME`; blocking `HOME` means blocking login. Isolation relies only on **cwd (a one-off
   temp directory) + disabled tools**, never on env changes (`agents.js` does not set `HOME`, and a test pins
   this).
3. **7F must remove WorkGremlin's own reporting plugin** (`plugin: []`). Kilo's global config points at
   `packages/reporter/src/plugin/index.js`; leaving it in would report council participants into the office,
   violating "isolated, visible only in the council".
4. **In project mode, "no reporting" cannot rely on cwd; it must be explicit** (added 2026-10-02). Constraints 3
   and "one-off temp directory" both assume cwd is the temp directory, so the reported project name is the temp
   directory and the office filters it out. In project mode both fail: cwd is your project, and the reporting hooks
   installed in `~/.claude/settings.json` / `~/.codebuddy/settings.json` report the **real project path**, turning
   a participant into a member of your project. Therefore **every** recipe injects `WORKGREMLIN_DISABLE=1`, and
   **our own code** exits immediately when it sees it (`packages/reporter/src/hook.js` at the top of `main()`, and
   both entry points of `packages/reporter/src/plugin/index.js`). It lives in our code rather than someone's config
   because we do not control every CLI's config precedence, while these two points we can always turn off.
   Self-tests: `npm run test:claude-hook` (hook route) + `npm run test:council-quiet-plugin` (7F/8F plugin entry
   points).
5. **The session store of 2F/6F/7F/8F cannot be prevented; it can only be tagged** (7F/8F 2026-10-02, verified on
   real machines; 2F/6F 2026-10-19). These products have no `--no-session-persistence`, so sessions are always
   written to a **global** store and `session.directory` / `cwd` records the current cwd — in project mode that is
   your project name, and the office's project filter would show "a session working" on the floor, while
   requirement §15.2 says those two pages must show no trace. The data directory cannot be moved either: measured,
   `XDG_DATA_HOME` does move the database (Kilo's `kilo.db` lands in the new directory), but **the login state
   moves with it** (Kilo returns 401 "You need to sign in", OpenCode hangs; Cline with `--data-dir` returns
   `Unauthorized`), leaving participants unable to speak. The fallback is "write as usual + tag":
   - 7F/8F: `--title '议事厅参与者（WorkGremlin）'` (`DEFAULTS.COUNCIL_SESSION_TITLE`); `floorKilo.js` /
     `floorOpencode.js` skip this title when listing sessions.
   - 2F Cline: it has no title switch and stores **the prompt itself** as the title, so council prompts start with
     `DEFAULTS.COUNCIL_PROMPT_MARKER` and `floorCline.js` skips titles containing it.
   - 6F Qoder: `--name` uses the same title; whether its CLI transcript carries the name has **not been verified on
     a real machine**.
   - 3F Codex needs no marker: `--ephemeral` writes no session at all.
   - Self-tests: `npm run test:kilo` / `test:opencode` / `test:cline` each assert "a user session in the same
     database and project is still listed; only the participant row is hidden"; `test:council-agents` pins "the
     marker in the recipe equals the marker used for filtering" (mismatch means the filter is useless).

**Two deviations from the implementation plan** (the plan lives in `~/.claude/plans/`, outside the repo, recorded
here so nobody looks for tables that do not exist):

- The planned `council_events` table was **not created**. The timeline is assembled on the fly from
  `council_rounds` (one row per round) + `council_utterances` (one row per speaker per round); a separate
  append-only event table would duplicate the ledger.
- Planned field names do not match what was stored: `councils.topic_text` → **`topic`**, `materials_json` →
  the **`council_materials` table** (each material records `bytes_total` / `bytes_included`; a JSON column cannot
  be queried), `outcome` → **`verdict`**; participant columns are `floor_id` / `agent` (not `floor` / `client`).
  Two additions the plan did not mention: `round_current` (which round is current) and `error` (meeting-level
  failure; per-speaker failures live on the participant / utterance row). The planned `threshold` was deleted with
  voting. `schema.sql` is authoritative.

**The 2026-10-19 shape (role-based flow).** Orchestration lives in `orchestrator.js`. A meeting runs
`plan → (proposal → review → moderation) × max_rounds → adjudication → final` and **does not stop early on a high
score**. However, **any required turn returning `failed` / `timeout` / `unparsed`, or output that cannot be parsed
into a structured result, ends the meeting immediately** (fail-fast): no later rounds run; completed rounds and the
report are still archived; at least one completed round → `partial`, none → `failed`; `error` records the round /
phase / floor and the CLI's raw text; `closeCouncil` closes still-`running` / `pending` participants as cancelled /
failed, and roles that never ran as `skipped`. The exception is a moderator returning `needsClarification` in round
0: that is a normal ending with `verdict='needs_clarification'` / `status='done'`, the moderator recorded as
`needs_clarification`, other roles `skipped`, and the report archived as usual. Each round stores one
`RoundResult` in `council_rounds` (`proposal_text` / `diff_from_prev` / `moderator_json` / `stats_json`), and each
review point stores one `council_reviews` row.

Model output is parsed by `parse.js`: only the **last** fenced JSON block is taken, entries missing fields are
dropped and counted, and if parsing fails the raw text is still stored (`status='unparsed'`) — **never invent a
review point for it**. Convergence is recomputed by `convergence.js` from reviews and conflicts (weights from
`shared`); model-reported scores are ignored. The same module emits consistency warnings ("are hard directives
executable / does every blocker have a directive / is a stance split registered as a conflict"). `report.js`
assembles the report and writes JSON + CSV + Markdown (atomic, never overwriting), then writes the file list back
to `council_reports.files_json`. There is no compatibility with old council tables: `db/index.js` detects old
`mode` / `threshold` / `vote` columns and drops/rebuilds the whole group.

**"Working" indicator (2026-10-19).** A single call can run for minutes with no output, leaving the page blank.
`markProgress(ctx, roundNo, phase, floors)` records progress at each phase and pushes it over WS (`status='running'`
+ `roundNo` / `phase` / `floors` / `startedAt`); the detail endpoint returns the same data through
`orchestrator.progressOf(id)`, so a refresh keeps the indicator. The frontend store's `working` getter reads it,
and `CouncilView` shows "正在工作中 · floor · phase · round N" at the top; `closeCouncil` clears progress and the
indicator disappears as soon as the terminal event arrives. The review phase lists every reviewer floor at once.

**Raw output per round (2026-10-19).** After a meeting ends or fail-fast aborts, `roundResults` can only describe
**successfully parsed** rounds; failed / timed-out / unparsed turns had nowhere to appear. `CouncilRawTurns.vue`
shows the `council_utterances` text by round (floor, phase, status, duration; raw `error` on failure), and
`CouncilView` mounts one block after round 0 and after each completed round. Rounds that have utterances (plan,
proposal, review, moderation) but no `RoundResult` appear separately as "incomplete" (`DEBATE_PHASES` excludes
adjudication / final). All data comes from stored utterance rows; nothing is inferred or backfilled.

**P0 robustness (2026-10-22): from "never completed" to one real completed meeting.** Five real meetings
existed, all created on 2026-10-19/22: **0 `completed`**, 1 `partial`, 4 failed at round 0. The failures were
structural, not one bug:

- `c_3c18…` — 1F CodeBuddy exited **0** with an empty stdout and a 400 on stderr: its default model
  (`copilot/gemini-3.8-flash`) had been retired. The runner called that "unparsed", which sent the user looking
  for a parser bug.
- `c_f257…` — the moderator had been changed to 3F Codex, but `codex exec` was stuck in
  `Reconnecting... request timed out`; 120s was not enough and the meeting died at round 0.
- `c_d1c9…` — 1F CodeBuddy hit the 120s timeout.
- `c_2393…` — `partial`; one round took ~20 minutes, and round 2's main turn timed out at 300s.

`floors.js` reported **all seven floors `ready`** because it only checked that the executable existed. That is
the readiness bug: a retired model, an expired login or a broken provider are invisible to an `fs` check.

The P0 changes (implemented in this tree):

1. **Preflight ("试麦").** `probeFloors()` asks each selected floor one short sentence with its configured
   model before `POST /councils` persists anything. A failure returns 400 naming the floor and the raw provider
   text; no half-built meeting. Probes run **sequentially** (measured: OpenCode took 29s alone but 73s parallel
   with Claude Code + Qoder), 60s each. A success is cached 5 minutes, a failure 1 minute (a user who fixes a
   login should not have to restart the app). `POST /councils/preflight` exposes the same check to the UI.
2. **Per-seat model pass-through.** `council_participants.model` stores an optional model; each recipe maps it to
   the product's own flag (`--model` / `-m`). Blank means the CLI's own default. The create form has one model
   input per occupied seat.
3. **Failure classification.** `council_utterances.error_kind` stores `auth` / `model` / `network` / `quota` /
   `timeout` / `meeting_timeout` / `protocol` / `spawn` / `exit` / `output_limit` / `provider`. `runner.js`
   treats **exit 0 + empty stdout** as a provider failure (`failed`), not `unparsed`; stderr is kept verbatim.
4. **Timeouts and retry.** Single-turn timeouts are 240s (isolated) / 600s (workspace); the whole meeting has a
   90-minute budget. A transient `timeout` / `network` turn gets **one** retry; auth/model/quota/protocol never
   do. The error text notes a retry, and the meeting-level reason shows the normalized label.
5. **Feedback lives with the meeting.** The left column is only the compose form (and its own validation); the
   right column shows the preflight view, the preflight/create error, the meeting-level failure reason, and the
   final result. A failed start never disappears just because `current` is still empty.

**Real validation (2026-10-22, separate server, temp DB).** `4F` moderator / `8F` main / `6F` reviewer, one
round, no workspace: `POST /councils` → preflight all ok (4F 37s, 8F 27s, 6F 6s, sequential) → meeting
`completed` / `done` in **1018s**. All six turns were `ok` with `error_kind=NULL`:
plan 37s, proposal 171s, review 135s, moderation 165s, adjudication 47s, final 222s. The report and four files
were archived under `~/.workgremlin/councils/c_58fbdef8fed8009184216969/`; the final draft contains the
adjudication's changes. It is still a long meeting (~17 min) — P0 made it **survive and finish**, not fast.

Still true on this machine (2026-10-23): 1F works only with an explicit `--model`; 3F works when the user's Codex
provider config is honoured (see the 2026-10-23 entry below); 7F is not signed in. The preflight now says so in
seconds instead of killing a meeting. Remaining P1 work (server-generated plan fallback, allow reviewer absence,
quick mode, resume) is not implemented.

**3F could not speak when Codex used a custom endpoint (2026-10-23, located and fixed).** The reported symptom was
`3F 60s 内没有返回` at preflight — no meeting row was ever created, so this was a refusal, not a dead meeting. Cause:
the 3F recipe passed `--ignore-user-config`, which drops the **whole** `config.toml`, including `model_provider` /
`base_url`. On a machine whose Codex reaches its model through a local proxy (`model_provider = "magpie"`,
`base_url = http://127.0.0.1:3425/v1` here), Codex fell back to `api.openai.com` and printed
`Reconnecting... (request timed out)` until the 60s probe killed it. Reproduced with the exact recipe: with the flag
it never answered in 75s; without it, 12s and `OK`. The older note "3F's network is broken" was therefore wrong.

The flag existed to keep MCP servers out (they can reach the network, which the council forbids), so the fix keeps
that guarantee but stops throwing the endpoint away: `codex mcp list --json` (the CLI's own parser) enumerates the
configured servers and each enabled one gets `-c mcp_servers.<name>.enabled=false`; `-c notify=[]` clears a
configured notify command (it would run outside the sandbox). Two near-misses were measured and rejected:
`-c mcp_servers={}` does not clear the table (Codex merges it; the server still started), and a quoted key
(`mcp_servers."name".enabled=false`) is rejected as `invalid transport`. If the list cannot be read, or a server
name is not a bare TOML key, the recipe falls back to `--ignore-user-config`. Measured: the control run starts
`metabase-mcp` at 3.1s, the override does not start it, and the probe answers in 12s. `--sandbox read-only`,
`--ephemeral` and `web_search="disabled"` are unchanged. `test:council-agents` pins both halves (override by name,
fallback when unreadable) and `docs/requirements.md` §15.3 gained an MCP row.

**Council header and preflight layout (2026-10-23).** Two UI facts changed in `renderer/src/views/CouncilView.vue`:

- The verdict badge (including "部分完成" / "partially completed") no longer appears above a finished meeting.
  The topic header is identical in every state; the summary, `cv-council-error` and result blocks carry the
  outcome. The `.who` / `.v-*` styles and `verdictKey()` were removed with it.
- Preflight renders exactly like the start of round 0: the submitted topic, the cancel button and the live
  strip (`.working`, `data-testid="cv-preflight"`). The probe status and the floors being probed are the strip's
  content. Cancel calls `store.cancelSubmit()`, which aborts the fetch; the server's `clientGoneGuard` reacts to
  the closed response by aborting `probeFloors`, killing the in-flight CLI and skipping `createCouncil` — so a
  cancelled probe leaves no meeting behind. `probeFloors` stops before the next floor and records no verdict for
  the killed turn; `test:council-preflight` and `test:council-api` pin both halves.
- The compose form no longer clears itself after a start (it used to blank the topic). Selecting a history
  record calls `selectCouncil()`, which opens the meeting and maps it back through `store.composeDraft()`:
  topic, roles, max rounds, workspace, material paths and per-seat models. The advanced section opens when the
  record used files, a workspace or models. The moderator/main selects and the reviewer list always iterate
  over **all** floors; a floor without its CLI is `disabled` instead of being filtered out, so an old record
  never loses a seat and no extra "not ready" text is needed (the disabled state says it; the reason is a
  hover tooltip). The former separate list of unavailable floors was removed, and a floor already chosen by
  the record can still be unchecked (reviewer) or replaced (single-role seats).
  `test:council-ui-store` pins the mapping and `test:render-smoke` pins the complete, disabled-when-unavailable
  floor list.

**Real-machine failure (2026-10-19, 1F round 0, located and fixed).** Historical meeting
`c_f66f8f9f86185744a29a16c0` was not a timeout. 1F CodeBuddy exited with code **0** in about **297 s** (under the
300 s cap), wrote **146176 bytes** to stdout and nothing to stderr, but the transcript array was missing its final
`]`. The old parser parsed the whole stdout as one JSON array, failed on that single character, and recorded the
meeting as `failed` / "no answer". In fact the last complete `result` event was still in the array and could
recover the text and usage. `agents.js` now recovers events from the longest complete object prefix and
`parseOutput()` returns `truncated`; `runner.js` only records `unparsed` when there is no usable body at all, and
keeps the tail of the raw output in `error` for diagnosis. A moderator missing required information may also
return `needsClarification`, which the server treats as a normal ending; when no workspace is given, the prompt
states explicitly that the temp directory is not the user's project and must not be used as project evidence.

Setting a workspace does not rerun or rewrite a finished meeting: `workspace_path` is an input captured at start,
and historical utterances, status, and reports are evidence from that time — **intentionally unchanged**. Fixes
only affect new meetings; create a new one to observe new behavior.

**Real-machine smoke test (2026-10-01, 1F / 4F / 8F passed, 7F not run).** This step caught two bugs that unit
tests missed, both from the same root cause:

- **8F OpenCode was judged "no parseable output" every round** even though the answer was fine.
  `opencode run --format json` puts the body in `part.text` (**singular** `part`, not `parts`), and `textOf`'s
  candidate keys only had the guessed `parts`.
- **1F CodeBuddy's body had 16397 characters**, including the CLI's own `<system-reminder data-role="memory">`
  preamble + the question + the answer, with the answer appearing twice. `codebuddy -p --output-format json`
  returns **one array** (a complete conversation: `user → file-history-snapshot → reasoning → assistant →
  result`); concatenating every `content` would read the question as its speech. Now only the closing `result`
  event is used (falling back to the last assistant message), giving a clean 849-character body with tokens read
  (6677/985/512/6165).
- **Lesson (now in comments in `agents.js` and `councilAgents.test.js`):** both bugs had green unit tests because
  the tests were written against the same guessed wire format. Verbatim real-machine output is now pinned in
  `councilAgents.test.js` (two OpenCode event-stream lines, a five-record CodeBuddy group); do not go back to
  guesses.

**Real-machine smoke test (2026-10-19, new 2F / 3F / 6F recipes):**

- **2F Cline passed end to end** (CLI 4.1.25, free `cline` provider): `cline --plan --json <prompt>` really read a
  marker file in the temp directory, the body and structured review block parsed, and tokens were attributed
  (20307 / 81 / cache 0 / 0). Two real-machine conclusions are pinned in the recipe: JSON mode **does not read
  stdin** (prompt must be a positional argument), and it stores **the prompt itself** as the session title — which
  is the basis for `COUNCIL_PROMPT_MARKER` (after a meeting, the participant is not visible in 2F's session list).
  It was also measured that `--plan` still runs **read-only** commands (`whoami`) while writes are rejected; this
  is recorded in §15.3 of the requirements.
- **3F Codex was verified only at the argument layer:** the real `codex` accepted
  `codex exec --json --sandbox read-only --ephemeral --skip-git-repo-check --ignore-user-config
  -c web_search="disabled" -` and entered `turn.started`, but the model step did not finish because the local
  Codex login was invalid (`plan type is required`). The event-stream shape (`item.completed` / `agent_message` /
  `turn.completed.usage` field names) is aligned with the JSONL it printed.
- **6F Qoder was not verified on a real machine:** the Qoder CLI is not installed here; the recipe follows the
  official docs (`-p --output-format json --name`).

Two more observations recorded as-is:

- **8F OpenCode provides no usage**: its event stream has only `step_start` / `text`, no usage — so 8F tokens are
  always `NULL` and the UI shows "—". This is **the server not having the data, not a parser gap**, consistent with
  "leave empty, never fill in 0".
- **CodeBuddy registers one-off directories as projects**: every meeting leaves a directory under
  `~/.codebuddy/projects/tmp-wg-council-*/` (one session `.jsonl`). That is the CLI's own behavior; we did not touch
  it and do not clean it up — **deleting someone else's history is more dangerous than leaving it**. Delete it
  yourself if you want it gone. (Since 2026-10-02, 1F/4F pass `--no-session-persistence`, so new meetings no longer
  produce these; older ones remain.)

**Real-machine verification (2026-10-02, added for project mode).** Unit tests being green is not enough, for the
same reason as above:

- **In project mode a participant's cwd is your project, but the project directory was not written to**: after
  running `kilo run` with the council env in a temporary project directory, `find` showed only the directory
  itself — no `.workgremlin/`, no new files. `.workgremlin/subagents.json` is written by **WorkGremlin's own
  plugin**, which `plugin: []` removes; Kilo writes nothing into cwd. (This only verified "it starts": the call
  itself was rejected by the model because there was no login state, see below.)
- **`--title` really lands in the database**: after
  `kilo run ... --title '议事厅参与者（WorkGremlin）'`, the `title` column in `kilo.db`'s `session` table is the
  verbatim string and `directory` is the cwd. Constraint 5's filter depends on this fact.
- **`XDG_DATA_HOME` does not work (it moves the login too)**: see constraint 5. This is a **failure note**,
  written down so nobody tries it again: the data-directory route looks cleanest, but it turns participants into
  "can run but cannot speak".

---

### 4.3 Live phase sources and how the ticker reads phase (2026-10-17)

**Separate the two axes.** `sources[].kind` (`cli` / `hook` / `plugin` / `dir` / `kilo` / `opencode` / `lingma`)
says where a session is **listed** and has nothing to do with phase; phase goes through `reporterMainPhase`.

The unified entry is `reporterMainPhase(workspacePath, client, session)` (`server/src/sessions.js`)
= `floorByAgent[agentBase(client)].readPhase || readReporterPhase`, followed by the floor's optional
`readPhaseFallback` when no reported truth exists. Who supplies real phase:

| Floor | Product | Live phase source | Write / read path |
| --- | --- | --- | --- |
| 1F | CodeBuddy | **hook** | `hook.js` writes the state file, `readReporterPhase` reads it |
| 2F | Cline | **on-disk fallback** | `floorByAgent.cline.readPhaseFallback = clineMainPhase` (reads `~/.cline/data` `sessions.db` + session JSON, `inferred`) |
| 3F | Codex | **hook** | Same as 1F |
| 4F | Claude Code | **hook** | Same as 1F |
| 5F | TraeCode | **hook** | Same (sessions themselves also come only from the state file) |
| 6F | Qoder | **hook, then on-disk fallback** | Hook state file is reported truth (coarse); `floorByAgent.qoder.readPhaseFallback = qoderMainPhase` polls Lingma `local.db` only when no hook truth exists (`inferred`) |
| 7F | Kilo Code | **plugin** | Plugin installed → state file (truth, includes "awaiting authorization"); otherwise `readPhaseFallback = kiloMainPhase` polls `kilo.db` (`inferred`) |
| 8F | OpenCode | **plugin** | Plugin installed → state file (truth, includes "awaiting authorization"); otherwise `readPhaseFallback = opencodeMainPhase` polls `session_message` (`inferred`) |
| 9F | GitHub Copilot | **on-disk** | `floorByAgent.copilot.readPhase = readCopilotPhaseFromSqlite` (`inferred`); reads both stores — CLI `events.jsonl` and the extension's `session-store.db` / chat log |

Hook and plugin write the **same** state file `~/.workgremlin/hooks/<client>@<project>@<session>.json`
(`shared/paths.js` `statePath`), **one per session** — so every session on disk has a live phase, none missing.

`readPhase` is the floor's primary/reported source. Product-store polling is a separate
`readPhaseFallback` capability, so a polled value can never outrank a plugin-reported phase (including
`await`). `reporterMainPhase` owns that precedence and the `/reporter-phase` route stays product-agnostic.

Who can read it:

| Channel | Granularity | Who gets it |
| --- | --- | --- |
| `GET /api/v1/reporter-phase` (1.5 s fast poll) | **one session per call** | Only "selected floor + selected session": the frontend sends only `?client=<floor-base>&session=` (`IsoOfficeView.vue`); the server does `if (!session) return null` and keeps only the named file (`sameSession`) — deliberately, because an earlier "latest for the client" showed another session's phase |
| `GET /api/v1/sessions` (snapshot, 5 s) | every session has a `phase` | `cli` / `hook` rows stay `'unreported'` (that path does not invent phase); plugin rows are written by their handler (the current session overlays reporter truth, others are inferred from disk) |

The scrolling ticker uses the second channel: `/api/v1/task-feed` returns `client` + `sessionId` per row
(`server/src/http/routes/query.js`), and the ticker joins `sessionId` against the snapshot's `phase`
(`TaskTicker.vue` `phaseOfTask`). That is why hook floors' ticker suffix could only fall back to "思考中"
(`runningPhaseOfTask`) — **the root cause of "Codex's console shows awaiting authorization but the ticker does
not"**.

**Plan A (landed): backfill real phase while building the session snapshot.** The data is already in the state
files; nobody read it for **non-selected** sessions. In `sessionRegistry.js` `snapshot()`, for rows with
`phase === 'unreported'`, call `reporterSnapshotPhase(ws, client, sessionId)` (`sessions.js`, internally
`reporterTruthPhase`); only for floors **without their own primary `readPhase`** (hook / plugin floors;
9F rows already carry inferred phase from their handler and are left alone). On a hit, overwrite
`phase / action / target / context / tool / prompt` and set `inferred = false`. Scope and trade-offs:

- The ticker changes **not at all**: it already joins the snapshot, so it reads the truth (including "awaiting
  authorization") after the backfill.
- `/reporter-phase` keeps its "must name the session" anti-crosstalk design, unchanged.
- Extra cost per snapshot = "one or two state-file directory scans per unreported session" (`hooksDir` holds only
  a few files).
- If unavailable (no hook installed / phase stale / session has no id), it stays `unreported` and the ticker falls
  back to "思考中" — never invented.

Self-test: `npm run test:floors` section [A7] (backfills `await` with action and `inferred=false`; no truth stays
`unreported`).

---

## 5. Document ↔ implementation differences

| # | Item | What the docs say | What the code does | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Protocol version and envelope | `PROTOCOL_VERSION = 1`, envelope field `team` | **v2**, envelope field `project` | `shared/index.js` |
| 2 | Domain model | `team` is a first-class field; UI supports switching teams | **Project** is first-class; no team | `def3fee`, `schema.sql` |
| 3 | Data source A (directory watch) | `chokidar` watches `.codebuddy/teams/**`, implemented in M1 | **Not implemented**; `chokidar` is declared in `server/package.json` but has zero references in source | `server/package.json` |
| 4 | Member sources | `config.json` roster + reporting | Hook / `.codebuddy/agents` roster / ghost lifecycle / disk scan | §2.1 |
| 5 | Workstation state enum | 5 main states `offline/idle/busy/blocked/error` + a `degraded` flag | **3 states: `busy` / `idle` / `blocked`**. No `online`, `offline`, `error`, `thinking`, `unknown`, and no `degraded`. Unknown values normalize to `idle` | `shared/index.js`, `renderer/src/lib/memberTask.js` |
| 6 | Message types | 10 types including `review` / `error` | `MESSAGE_TYPES` has **9**: `task_assign`, `task_update`, `result`, `question`, `block`, `review`, `error`, `shutdown`, `system` | `shared/index.js` |
| 7 | Workstation state derivation | Heartbeat every 15 s, 60 s timeout, degraded after loss, task liveness inferred from heartbeat/TTL | **Derived only from data**: `busy` = a running task (or borrowed busy for a resident gremlin while a same-named ghost works); `blocked` = a `session_status` row for that session (authorization wait only); `idle` = neither. Priority `blocked > busy > idle`, earliest `stateSince` wins at equal priority. Last active = latest task start/end (`lastTaskAt`, `lastTaskAtBySession`), not a heartbeat | `server/src/ingest/bus.js` `buildMemberCard`, `hookCommon.js`, `schema.sql` |
| 8 | Message redaction (P0-7) | Regex-replace with `***` before persisting; raw text never stored | **Not implemented** (no `redact` code); plaintext can land in the database | No hits repository-wide |
| 9 | Chinese search | FTS5 `trigram`, 1–2 character queries downgraded to `LIKE`, FTS/LIKE not mixed | Virtual table and triggers exist; `listMessages` **always uses `LIKE`**; FTS and the downgrade branch are not wired | `schema.sql`, `server/src/db/index.js` |
| 10 | Storage security baseline | Dual connection (write `secure_delete=OFF` / deletion-archive `ON`) | **Single connection**, `secure_delete=ON` everywhere | `server/src/db/index.js` |
| 11 | File activity values | `read` / `write`; older drafts also listed `edit` | CHECK allows `read` / `write` only; `edit` was never implemented and is retired | `schema.sql` |
| 12 | Archive retention | 90 days / 100k messages per project, export JSONL when exceeded | Only `archived_at` / `content_truncated` columns and manual `purgeProject`; **no automatic archive**; retention days are a setting | `server/src/db/index.js` |
| 13 | Progress three-level fallback | Reported → sub-task inference → striped indeterminate bar | Only "reported value" and "unknown text"; no striped animation, no inference | `renderer/src/components/ProgressBar.vue` |
| 14 | Alerts and notifications | In-app S1 notice (M1) + system notifications (M3) | **Not implemented** | No hits repository-wide |
| 15 | Language stack | TypeScript (decision with a one-day cap and a switch-to-B trigger) | **CommonJS JavaScript** + `jsconfig.json` | `package.json` |
| 16 | Tests | Vitest + Playwright, 15 testability contracts, L1 coverage ≥ 80% | **73 suites**, all plain Node scripts with a local `ok()` helper: 57 server test files + 17 renderer test files (73 `test:*` scripts; `pluginReply.test.js` has no alias). No Playwright E2E, no coverage gate; only a few contracts (clock abstraction, etc.) landed. `renderer/test/renderSmoke.test.mjs` is a render smoke test, not E2E | Repository, `scripts/run-tests.js` |
| 17 | UI | Workstation view + conversation log, two tabs | **Office (isometric Canvas, default) / desk cards / conversation log / task records / council**, plus `?tab=flat`, `?tab=lab` | `renderer/src/App.vue`, `views/CouncilView.vue` |
| 18 | Reverse control (M4) | Assign work + interrupt, with confirmation | Not implemented (the office's "gather for a meeting / everyone back to the desk" is a local animation, not a command to an agent) | `renderer/src/iso/engine.js` |
| 19 | Packaging | electron-builder, x64 on three platforms | Not wired (`build` only builds the renderer) | `package.json`, `scripts/build.js` |
| 20 | Orchestration | The "not doing" list says no agent scheduler / orchestration engine | **The council is the single exception** (requirements §15): the server does spawn external CLIs — but always brand-new, one-off, tool-less processes that touch no monitored session and write no `members` / `task_runs`. The difference note now reads "orchestrating the **monitored team** is out of scope"; the P2-1 text is unchanged | `requirements.md` §15, `server/src/council/` |
| 21 | Reverse control (M4) | Assign work to / interrupt a monitored session | Still **not done**. The council is out of scope: it never injects speech into an existing session, and there is no channel between participants and monitored sessions (see §4.2) | `requirements.md` §15.2 |
| 22 | Workstation state model | Older docs and older code: heartbeat-driven state, `offline`, `degraded`, task liveness inferred from elapsed time / heartbeat loss, `/heartbeat` and `/status` endpoints, per-member last-seen timestamps | **Refactored in `e2ad323` (2026-10-21)**: the heartbeat was removed entirely (no `/api/v1/heartbeat`, no `/api/v1/status`, no `members.last_seen_at`, no `agent_status_history`); `agent_status` can only hold borrowed `busy`; `session_status` can only hold `blocked`; a task is live only while `tasks.state='running'`; last active comes from task start/end; WS ping (60 s timeout, ping every 30 s) is transport-only and never changes state | `shared/index.js`, `schema.sql`, `db/index.js` migration, `server/src/ingest/bus.js`, `renderer/src/lib/memberTask.js` |
| 23 | Message window / virtual scrolling | Virtual scrolling in M2 | Capped at `DEFAULTS.MESSAGE_WINDOW = 500`; no virtual scroller | `shared/index.js`, renderer message list |

---

## 6. "Promised but not implemented" list (ordered by product impact)

1. **Message redaction (P0-7)** — the only item the docs label a hard requirement / P0 defect while nothing is
   written, and there is no interception point: content is stored in plaintext.
2. **A-route fallback (directory watcher)** — without it, agents that have no hook and no reporter are invisible;
   reporter integration is the only entry point.
3. **FTS5 query wiring and short-query downgrade** — `LIKE %kw%` becomes linear in message count as data grows.
4. **Virtual scrolling** — the message window is a hard 500-row cap, not a scrolling implementation.
5. **Automatic archive and retention enforcement** — the database grows without bound; only manual purge exists.
6. **System notifications** — no in-app alert pipeline and no OS notification integration.
7. **TypeScript migration** — protocol-heavy code still relies on comments and reviewers for field correctness.
8. **Playwright E2E and packaging tests** — no browser E2E and no automated Electron packaging test; the 73 suites
   are unit/integration scripts only.

---

## 7. Documentation maintenance rules

| If you want to change… | Change… |
| --- | --- |
| What the product should do, acceptance criteria, state semantics | `docs/requirements.md` (numbering authority: `requirements-outline.md`) |
| Technology choices, data structures, protocol | `docs/tech-design.md` |
| Milestones and ownership | `docs/roadmap.md` |
| Test-case design | `docs/test-strategy.md` |
| Running it / troubleshooting | `docs/runbook.md` |
| **What the code actually looks like now, and how it differs from the docs above** | **This file** |

When a code change touches any fact in §1–§5, update the corresponding row here. Add new differences to the §5
table rather than scattering them elsewhere.

---

## 8. Codex CLI support matrix (2026-09-20, measured on Codex 0.151.0)

Protocol: Codex has a native hook subsystem (`hooks` is a stable, default-on feature). The file is
`$CODEX_HOME/hooks.json`, with the **same shape** as CodeBuddy / Claude Code (`{matcher, hooks:[{type:'command',…}]}`).
**Hooks need trust**: approve once with `/hooks` in the TUI for interactive sessions, or use
`--dangerously-bypass-hook-trust` for automation. `~/.codex/agents` does not exist yet; named agent definitions on
the Codex side still need verification.

| Capability | Status | Notes |
| --- | --- | --- |
| Member registration / state (`busy` · `idle` · `blocked`) | ✅ Measured | `SessionStart` / Pre·PostToolUse / `Stop` / `SessionEnd`; no heartbeat. `blocked` comes only from an explicit `PermissionRequest` authorization wait |
| Task start / end / completion marker | ✅ Measured | `UserPromptSubmit` → `task/start`; `Stop` → `task/end(done)` |
| Phase (thinking / tool / awaiting authorization / idle) | ✅ Measured | Pre/PostToolUse → tool/thinking; idle when nothing happens; no fallback to "guess from jsonl timestamps" |
| File activity (reading / writing now) | ✅ Measured | `apply_patch` has no `file_path`; paths are parsed from the patch text's `*** Update/Add/Delete File:` lines |
| Subagent ghosts (appear / report back) | ✅ Measured | `SubagentStart`/`Stop`; the name comes from `spawn_agent`'s `task_name`, the report text from `last_assistant_message` |
| Interrupt wrap-up (dispersing orphan ghosts) | 🟡 Verified without a live session | The `Interrupt` event is wired, but has not occurred in a real session yet |
| Interrupt → console "任务取消" (red, not green) | 🟡 Verified without a live session | `Interrupt` writes `done.cancelled` (same shape as `Stop`'s done); `Stop` also falls back to `turn_aborted` in the rollout (interactive sessions do not always send `Interrupt`); regressions `npm run test:cancel`, `npm run test:stop-interrupt` |
| Awaiting authorization (`blocked` · `awaiting_permission`) | 🟡 Verified without a live session | This machine runs `permission_mode=bypassPermissions` and never shows a permission dialog; Codex uses an explicit `PermissionRequest` (no longer inferred from CodeBuddy's pending state) |
| Seated gremlin roster (Codex-side agent definitions) | 🟡 Not verified | Scans `.md` / `.toml` under `$CODEX_HOME/agents` and `<project>/.codex/agents`; this machine has no such files yet |
| Floor / session list (3F) | ✅ Exists | `products.js` detects the codex executable; `sessionRegistry.js` scans `~/.codex/sessions/**/rollout-*.jsonl` and uses `cwdOfHead` to read `payload.cwd` from the first lines |
| Client isolation (3F does not show CodeBuddy members or phases) | ✅ Measured | `members.client` + `/api/v1/reporter-phase?client=` (the renderer passes one bare floor base name; CLI and plugin forms share it) |
| PreCompact / PostCompact | ❌ Unhandled | Same as CodeBuddy (no UI semantics) |
| `Stop.last_assistant_message` | ❌ Unused | The completion summary still comes from "files changed this turn" |
| `turn_id` / `agent_id` attribution | ❌ Unused | A subagent's tool calls carry `agent_id`, which could attribute file activity to that ghost (currently still credited to the main member) |
| Tool name normalization | ✅ Measured | Codex reports `Bash` (not shell), `apply_patch`, `collaborationspawn_agent` (prefix stripped for display) |

## 9. Known workspace clutter (not project structure)

| Path | Symptom | Explanation |
| --- | --- | --- |
| `work/WorkGremlin/` | ~~An untracked nested copy~~ | **Deleted on 2026-09-21** (verified as test residue from hook state files, not project code) |
| `.workgremlin/workspaces.json` | Contains hook phase state (`lastTool` / `sessionPhase`) instead of the `{current, recent}` that project management writes | This directory should only ever hold ghost working data. The old `subagents.json` manifest was removed with the ghost feed; `workspaces.json` belongs in `~/.workgremlin/`. The stray file is likely a historical mis-write |

## 10. Demo mode: entry moved from a launch flag to a UI button (2026-09-21)

> **2026-10-21 — superseded by the virtual demo session.** Demo mode is now a read-only, in-memory
> virtual project + session (`__demo__` / `__demo__:session`) exposed by `server/src/demo/provider.js`
> through `/api/v1/demo/session`. It is selected on the current floor like a real session; it never
> writes `projects` / `members` / `tasks` / `messages` / `task_runs`. The old seeded-project path,
> `workspace.openDemo()`, seeder, cleanup, ticker and the in-browser `SCRIPT` were removed. The
> historical notes below are kept for context only.

**The requirement did not change** (still "one deterministic fake dataset, isolated from real data"); only **how
you enter it** changed:

| Item | Before | Now |
| --- | --- | --- |
| Entry | `npm run dev -- --demo` / `--demo-seed N` / `WORKGREMLIN_DEMO=1` / `MOCK=1` | The "演示模式" button on the office HUD (left of "集合开会") → `POST /api/v1/demo/session { floor }` |
| Data | Seed rows written into the real tables | Built in memory on every request by `server/src/demo/provider.js`; no project / member / task / message rows are written |
| Ticker | Started by `isDemoMode()` at startup and ran for the life of the process | One frontend-only pseudo line in `TaskTicker.vue`; it never enters `/task-feed` or the ended-task announcement logic |
| Exit | Restart without `--demo` | Click the button again ("退出演示"), switch floors, or select a real session → `DELETE /api/v1/demo/session` |
| Startup restore | `WORKGREMLIN_NO_DEMO=1` existed solely to "not take me back to the demo project" | Never restored: the in-memory demo disappears with the server process |

Removed with it: the seeded `__demo__` project path, `workspace.openDemo()`, seeder / cleanup / ticker modules,
`server/src/mock/generator.js`, `WORKGREMLIN_DEMO_FIXED_TS`, `syncDemo`, and the in-browser demo `SCRIPT`.
Kept: the fixed `DEMO_PROJECT` / `DEMO_PROJECT_ID` identity (`__demo__`, never overridden by
`WORKGREMLIN_PROJECT`) and the frontend-only ticker line.

The former seeded-project demo had five frontend special cases (all removed with the virtual session):

1. `sceneMembers` lets the demo override floor/session filtering (`floorEmpty` does not clear the room,
   `sessions.live` does not grey out members).
2. The session dropdown's "follow new sessions" does not switch projects during the demo (otherwise one real
   session would drag the view away).
3. On exit, the script is stopped with `mainAgent.enterIdle()` (**not** `stop()`, which would show "已暂停" and
   leave a demo flavor on real data); the real session phase takes over immediately.
4. **The console belongs to the demo script**: the `consoleLive` watch returns early during the demo and ensures
   the script is running; starting uses `mainAgent.startDemo()` (clears `live` / `hookLive` before `start()`).
   Without clearing, a real session in the dropdown feeds its "待命中" every 1.5 s, so the script never starts or
   is overwritten after one step — the symptom was "I clicked demo mode and the main agent does not move".
5. The top bar and status badge stay in sync: the project badge shows "演示工程 · 演示模式" (it used to follow the
   selected session and show the real project name), the dropdown shows the single "演示工程 · 演示会话" entry
   (switching is ignored during the demo), and the phase source is labeled "演示脚本" (`ConnectionBar`'s
   `source='demo'`, colored separately from reported truth / inferred value).

> Note: the `startDemoScript()` guard changed from "do not start if `live` / `hookLive` is true" to "do not start
> twice if `auto` is true" — the old guard was always true in the demo (a real session always fed a phase), so the
> script never started.

**Only user-level gremlins remain in the demo project** (2026-09-21): `createAgentRoster`'s `getWorkspacePath` no
longer falls back to "the project resolved at server start" and only accepts the current project path. The demo
project has no directory (`workspacePath === ''`), so `listDefinedAgents('')` lists only user-level agents
(`~/.codebuddy/agents`, `$CODEX_HOME/agents`). Project-level gremlins (`<project>/.codebuddy/agents`, such as this
repo's leo / susan) are therefore removed from the demo project by `sync()` and re-added when switching back;
user-level ones (such as simmon) stay. Measured: real project 3 (leo:project / simmon:user / susan:project) → demo
project 9 (8 demo members + simmon:user, no leo/susan) → back to 3.

**Roster reconciliation cleanup** (2026-09-21, immediately after the above): changing `getWorkspacePath` was not
enough. Roster removal relies on **in-process bookkeeping** (`registered` / `mine`), which is empty after a server
restart, so project-level members registered into the demo project in a previous round (leo / susan) were
unclaimed and never reconciled. The old code swept them as `degraded` after 60 seconds, leaving "still there but
grey". The current fix is `createDemoCleaner(...).purgeStragglers(agentRoster)` (`server/src/demo/cleanup.js`): on
entering the demo (including "the persisted project at startup is the demo"), reconcile by the roster's own
criteria — remove members in the demo project with `role='subagent'` for which `agentRoster.isDefined(name)` is
false. Three kinds are left alone: demo seed members (leader / coder …), main-agent members (`role='agent'`,
reported by hooks), and ephemeral members. `purgeStragglers` is called from the demo ticker manager after the
roster starts (`if (!agentRoster) return 0` guards the case where the roster is not up, because `isDefined` would
be false for everything and remove user-level gremlins too). Measured: manually inserting a `role='subagent'` leo
into `__demo__` (reproducing the "grey leftover") → switching out and back clears it while simmon stays; inserting
susan and **restarting the server** (persisted project still the demo) clears it at startup too. With the state
model refactor there is no `degraded` sample in demo data anymore; `ops` is simply an idle member.

**Two demo-mode fixes** (2026-10-01, from user testing):

1. **Remove the "规划中 (plan)" / "汇总中 (summarize)" phases.** They existed only in the demo script and never
   occur on real machines: reporter hooks write only `await/idle/thinking/tool/done`; Kilo / OpenCode explicitly do
   not map `step-start` / `step-finish` to them (step boundaries are too frequent — every finished tool would stick
   at "汇总中", see `kilo.js`); the server's `inferPhase` branches for them (IDE-plugin `awaitingSessionIdle` /
   queued messages) have no measured samples. Changes: `iso/mainConsole.js` `PHASES` lost both entries; the demo
   `SCRIPT` lost the plan stop; `mainAgent.enterPause()` (used by `stop()` to show "已暂停") now means "idle + an
   action line saying paused" and no longer borrows summarize; the two `sessions.inferPhase` branches also fall
   back to `idle + action` (the information is kept, it just no longer pretends to be a work phase).
2. **Demo gremlins "flashed back" into the real project after exiting the demo.** The root cause was **events
   crossing projects**, not a render frame: the renderer's WS subscription carries no `project` (it shows "the
   project the server currently has open"), so the server sent `member.status` for **all** projects, and
   `upsertMember` looked only at the event type, not the project. Under the heartbeat model, the 8 demo members
   stopped heartbeating, and the periodic degradation sweep broadcast each member card as it marked them degraded;
   the client accepted all of them, so 8 gremlins flashed back until the next full-snapshot reconciliation. The
   heartbeat and that sweep are gone, but the fix is still required because foreign-project cards can be broadcast
   for other reasons: the member card carries `project` (`bus.buildMemberCard`), and the renderer filters with
   `lib/projectScope.js` `memberBelongsToProject()` in `applyWorkspace` / `applySnapshot` / `upsertMember` (a
   missing field passes, so old servers / old events are unaffected). `applyWorkspace` also immediately removes the
   previous project's members during "project switched, new snapshot not yet arrived". Regression:
   `npm run test:project-scope` (predicate) plus a real-server reproduction script.

**Ghosts always float in through the door** (2026-10-01): the demo's two ephemeral members and the subagent
instances summoned in real scenarios use the same path (`engine.js` `makeGhost` / `stepGhosts`). Ghosts used to
appear out of thin air at their hover point; now: (1) they wait outside the door (`gx < 0`, not drawn at all —
under isometric projection a body outside the wall leaks through the closed door); (2) once **all gremlins are
inside** (`entering` / `atDoor` cleared, the gate time recorded in `ghostGateAt`), they leave one by one
(`GHOST_ENTRY_STAGGER` 420 ms, order taken from the batch index); (3) they float from outside toward their hover
point at the faster `GHOST_ENTRY_SPEED`, clipped at the doorway like gremlins while `gx < 0`, so it reads as
"floating in through the door"; `atDoor` keeps the door open while they cross. Fallback: `GHOST_ENTRY_WAIT_MAX`
(5 s) — a summon can interrupt a gremlin's entrance (it sits immediately / is called to the console), and a ghost
must not be locked outside forever because someone never sat down; `setMembers` closes the gate one notch again
whenever a **new** gremlin arrives (`if (enterSlot) ghostGateAt = 0`), without affecting ghosts already floating
inside. Measured (headless engine, the demo's 6 members + 2 ghosts): gremlins entered from 676 ms to 3092 ms, and
the two ghosts appeared at the door at 4254 ms / 4466 ms.
