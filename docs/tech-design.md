# WorkGremlin — Technical Design

| Item | Value |
| --- | --- |
| Status | Living design document (v0.2) |
| Last aligned with code | 2026-10-21 · `HEAD = e2ad323` |
| Audience | Engineers working on the server, reporter/hooks, Electron shell and renderer |
| Baseline | `docs/requirements.md` (what the product must do), `docs/implementation-status.md` (what the code actually does) |

> **2026-10-21 state-model refactor.** Workstation state is now only **`busy` / `idle` / `blocked`**.
> The business heartbeat, heartbeat timeouts, per-member TTL/lease renewal, the `offline` state, the
> `error` state and the orthogonal `degraded` flag were removed. Busy comes from a running task;
> blocked comes from an explicit per-session authorization wait; idle means neither. "Last active" is
> derived from task start/end timestamps. The WebSocket ping is transport-only and never changes a
> workstation state. Sections below describe the current design; older heartbeat-era text has been
> removed rather than kept for history.

---

## 0. Context: what agent-side data can and cannot provide

WorkGremlin observes coding-agent products that already run on the user's machine. No agent has to be
modified by WorkGremlin, but the amount of truth available differs by product.

A typical multi-agent on-disk layout (measured in September 2026) looks like this:

```text
{workspace}/.codebuddy/teams/{mainConversationId}/{team_name}/
├── config.json      # roster: member names, roles, session ids
├── leader.json      # that member's mailbox (currently only received messages)
├── researcher.json
├── coder.json
└── tester.json
```

The important conclusions still hold:

| Fact | Consequence |
| --- | --- |
| The team directory contains a roster and inboxes, but **no state fields** | Watching it alone can never produce `busy` / `blocked`, the current task, files or elapsed time |
| The path embeds a private, undocumented `mainConversationId` hash | A watcher would need multi-root scanning and would break on format changes |
| Mailboxes are append-only **receiving** arrays | Only the recipient side of a conversation is visible; the sender side is missing |
| Many products do not use this layout at all | A single `.codebuddy/teams` reader cannot cover the nine supported floors |
| We can control how hooks/reporters are installed | Active reporting (route B) is feasible and is the only source of semantic truth |

**Design consequence.** Route B (active reporting plus the server-side hook dispatcher) is the only
truth source for workstation state and tasks. Per-floor on-disk readers are a *supplement* for data a
report cannot carry (tokens, transcripts, session lists, phases) and for products that expose no hook.
The old route A (`chokidar` over `.codebuddy/teams`) was designed but **never implemented**; nothing in
the current server depends on it.

---

## 1. Data sources

### 1.1 Route B — active reporting (implemented, truth)

```text
agent hook / reporter ──POST /api/v1/*──▶ ingest bus ──▶ SQLite ──▶ WS hub ──▶ renderer (Pinia)
                                             │
                                             └──▶ buildMemberCard() / buildSnapshot()
```

- `packages/reporter` is a zero-dependency (Node `fetch`) SDK and CLI. Hooks forward raw product events
  to `/api/v1/hook`; the server dispatches them per floor and writes tasks, files, tool usage, ghosts
  and blocked state.
- Advantages: fields are semantically exact (task start/end, per-session identity, token usage, files,
  output); the design is extensible (new fields do not change the protocol shape); a task row is the
  single source of truth for "busy" and "last active".
- Cost: each floor needs an adapter; a product with no hook/report shows less data; the app must manage
  a local port and a server lifecycle.

### 1.2 On-disk floor readers (implemented, supplementary)

Nine floors are monitored: CodeBuddy, Cline, Codex, Claude Code, TraeCode, Qoder, Kilo Code,
OpenCode and GitHub Copilot. Each floor module reads its own product's data directory (SQLite,
JSONL/rollout files, checkpoint databases, transcripts and session indexes) and normalizes that into
sessions, task runs, token counts and phases.

These readers are **not** a workstation-state authority. They may infer a *session phase* (for example
"no file activity for 10 minutes" on a floor with no hook). A phase is shown on the main-agent console;
it is not a member state and does not imply `offline`.

### 1.3 Rules for combining sources

1. **Members.** Registration comes from reports/hooks, the agent roster
   (`.codebuddy/agents/*.md` at project and user level), ghost records for summoned subagents, and
   floor session scans. A member that never reports is marked `reported = false` and shown as
   "passively observed"; unavailable fields stay empty.
2. **Messages.** Reported messages use `source='report'`. A legacy directory-derived message uses
   `source='watch'`. `dedupe_key` makes replay and mixed sources idempotent; report wins.
3. **Workstation state.** Only `busy` / `idle` / `blocked` (see §4.3). Busy comes from
   `tasks.state='running'`; blocked comes from a per-session `session_status` row; no row means idle.
   There is no heartbeat or TTL to renew.
4. **Progress / files / elapsed / artifacts.** Only reports and floor readers provide them. When they
   are unavailable the UI shows `—`; it never fabricates a number.

### 1.4 Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A product changes its private on-disk format | Each floor module is isolated; a parse failure logs a warning and returns empty data, and never crashes the server or other floors |
| A native SQLite module does not match Electron's ABI | `better-sqlite3` is rebuilt for Electron by `postinstall`; `npm run db:check` verifies open → write → read → checkpoint |
| Local port already in use / multiple instances | Probe ports 21800–21820; write `port`/`token`/`pid` to `~/.workgremlin/server.json`; verify the recorded pid is alive before reusing |
| Another local process abuses the API | A token is generated on the first start, persisted in `server.json` (`0600`) and reused on later starts; HTTP and WS require it; the server binds `127.0.0.1` only |
| A floor has no hook → data gaps | Floor readers supply sessions/tasks/tokens; the UI labels passive members and empty fields honestly |
| A running task's process dies | No timeout/TTL heuristic guesses. A running task stays running until an explicit end/reconciliation event; liveness is not fabricated |

---

## 2. Technology choices

| Area | Choice | Rationale |
| --- | --- | --- |
| Desktop shell | **Electron 38** | Strong Node ecosystem (SQLite, `ws`, child processes for councils), one bundled Chromium across targets. Package size (~100 MB) is accepted for an internal desktop tool |
| Server | **Node.js + Express 4 + `ws` 8** | Same process as Electron by default, standalone with `npm run server` for headless/debug/tests |
| Language | **CommonJS JavaScript** (`jsconfig.json` for editor checks) | The repository is JS today; the earlier TypeScript plan was not executed. `shared/index.d.ts` still publishes types to consumers |
| UI | **Vue 3 `<script setup>` + Pinia + plain CSS variables** | The office is a custom canvas scene; a component library would not help. CSS variables carry the theme |
| Storage | **better-sqlite3 13**, one database at `~/.workgremlin/workgremlin.db` | WAL, synchronous writes, prepared statements, no extra service. In-memory snapshot only for the first paint |
| Realtime | **WebSocket** (`ws`) with HTTP polling fallback | One multiplexed connection for status, tasks, messages and ghosts. A dropped WS falls back to polling; reconnects use exponential backoff |
| On-disk readers | Per-floor modules (`server/src/floor*.js`), one unified poller | One timer loop instead of a timer per floor; short SQLite open timeouts so a locked product DB cannot stall the server |
| Tests | Plain Node scripts (`server/test/*.test.js`, `renderer/test/*.test.mjs`) driven by `scripts/run-tests.js` | Zero test-framework dependency and deterministic sandbox tests. Vitest/Playwright remain possible future upgrades, not current tooling |
| Packaging | `electron-builder` (x64 Linux/Windows/macOS) | AppImage/deb, NSIS, dmg; macOS is ad-hoc signed (no notarization account) |

**Security baseline.** SQLite connections use `secure_delete=ON`, WAL auto-checkpointing, `synchronous=NORMAL`,
`foreign_keys=ON` and file mode `0600`. The server binds loopback only and requires a persisted token.
Message redaction is **not implemented yet**; when it lands it must happen before persistence and before
FTS indexing, so plaintext never enters the database.

---

## 3. Directory layout (actual)

```text
WorkGremlin/
├── package.json                  # npm workspaces + scripts (dev/build/test/server)
├── jsconfig.json                 # editor/type hints for CommonJS JS
├── shared/                       # zero-runtime-dependency protocol + shared paths + types
│   ├── index.js                  # constants, envelope, state labels/colors, dedupeKey
│   ├── index.d.ts                # public types (AgentState, MemberCard, ...)
│   └── paths.js                  # ~/.workgremlin paths, state file, server.json, pid checks
├── server/
│   ├── src/
│   │   ├── index.js              # createServer(): DB + bus + hub + routers + poller + demo
│   │   ├── cli.js                # standalone server + --self-test
│   │   ├── config.js             # port probe, persisted token, server.json
│   │   ├── clock.js              # injectable clock
│   │   ├── db/{schema.sql,index.js}   # schema, migrations, prepared statements
│   │   ├── ingest/
│   │   │   ├── bus.js            # the single write path → SQLite → broadcast → cards
│   │   │   ├── agentRoster.js    # resident gremlins from agent definition files
│   │   │   ├── agentLevel.js     # project/user level + description
│   │   │   ├── hookDispatch.js   # raw hook event → floor adapter
│   │   │   └── hookCommon.js     # shared hook state machine (tasks, ghosts, blocked, files)
│   │   ├── floor*.js             # per-floor on-disk readers
│   │   ├── floors.js             # floor registry, identity normalization, labels
│   │   ├── poller.js             # one polling loop for all floors
│   │   ├── sessionRegistry.js    # global live-session index
│   │   ├── sessions.js           # plugin on-disk session parsing
│   │   ├── http/routes/          # health, query, ingest, workspace, floors, sessions, council
│   │   ├── ws/hub.js             # connections, filters, broadcasts
│   │   ├── council/              # moderator/reviewer orchestration and reporting
│   │   └── demo/                 # deterministic demo project and ticker
│   └── test/                     # 57 regression suites
├── desktop/src/                  # Electron main, launcher, preload, window, menu
├── renderer/
│   ├── src/
│   │   ├── iso/                  # hand-written isometric canvas engine, map, sprites, console
│   │   ├── components/           # cards, badges, elevator, sprites, message list
│   │   ├── views/                # Office, Desk, Task records, Council, Workstation
│   │   ├── stores/               # project, sessions, tasks, messages, mainAgent, council
│   │   ├── lib/                  # memberTask, projectScope, timeRange, dayBoard, ...
│   │   └── i18n/                 # zh/en UI strings
│   └── test/                     # 17 regression suites
├── packages/reporter/src/        # SDK, CLI, hook, Kilo/OpenCode plugin
├── scripts/                      # dev/build/postinstall/install-hooks/run-tests
└── docs/                         # requirements, tech design, status, test strategy, roadmap, runbook
```

The server runs in the Electron main process in production (`createServer()` + `start()`), and as a
standalone Node process for headless use and tests. The renderer never hardcodes the port: it discovers
the server through the preload bridge or `~/.workgremlin/server.json`.

---

## 4. Data model (SQLite)

Conventions: all timestamps are UTC milliseconds (`INTEGER`); enums are `TEXT + CHECK`; JSON fields are
`TEXT`. The ownership unit is the **project**, not a team.

### 4.1 `projects`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | Slug derived from the project directory (collision suffix when needed) |
| `name` | TEXT NOT NULL | Display name (`package.json name` > directory name) |
| `workspace_path` | TEXT NOT NULL | Absolute project directory |
| `main_conversation_id` | TEXT | Product-specific conversation hash when known |
| `source` | TEXT | `report` or `watch` (the retired `timeout` value is migrated to `watch`) |
| `created_at` | INTEGER | |

Index: `idx_projects_ws(workspace_path)`.

### 4.2 `members`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | `<name>@<project>` |
| `project_id` | TEXT FK | |
| `name` | TEXT | Member name |
| `role` | TEXT | Static role description |
| `session_id` | TEXT | Primary session, when known |
| `reported` | INTEGER | `1` = active reporting has been seen |
| `created_at` | INTEGER | |
| `ephemeral` | INTEGER | `1` = summoned ghost, no station |
| `project_label` | TEXT | Project label carried by a ghost |
| `client` | TEXT | Product base name (`codebuddy`, `codex`, ...); `NULL` = generic |

Index: `idx_members_project(project_id, name)`. There is **no `last_seen_at`** column.

### 4.3 State tables

`agent_status` — the only explicit member-level state, and only for the **borrowed busy** of a resident
gremlin while a same-named ghost works:

| Column | Type | Notes |
| --- | --- | --- |
| `member_id` | TEXT PK FK | |
| `state` | TEXT NOT NULL, CHECK = `'busy'` | Fixed; no other value is legal |
| `state_since` | INTEGER | When the borrow started |
| `updated_at` | INTEGER | |

No row means idle on this axis. The main agent's busy state is never stored here; it is always derived
from `tasks.state`.

`session_status` — explicit authorization waits, one row per blocked session:

| Column | Type | Notes |
| --- | --- | --- |
| `member_id` | TEXT FK | |
| `session_id` | TEXT | |
| `state` | TEXT CHECK = `'blocked'` | Fixed |
| `state_since` | INTEGER | When the wait started |
| `updated_at` | INTEGER | |
| PRIMARY KEY | `(member_id, session_id)` | Different sessions never share a block |

No row means that session is not blocked. Blocked rows are written for permission requests
(`awaiting_permission`) and cleared by task progress, task end, session end or an idle notification.

There is **no `agent_status_history` table**; the old heartbeat-era columns (`task_id`,
`last_heartbeat_at`, `degraded`, `source`) were removed by a migration that rebuilds both tables.

**State derivation (`buildMemberCard`).** A member card merges three candidate sources:
`session_status` rows (blocked), the borrowed busy row (busy), and running tasks (busy). Priority is
`blocked > busy > idle`; within the same priority the earliest `stateSince` wins. For a selected
session the renderer applies `blocked (same session) > running task (same session) > borrowed busy >
idle`. Unknown values normalize to idle.

### 4.4 `tasks`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | `t_<timestamp>_<random>` |
| `project_id`, `member_id` | TEXT NOT NULL | |
| `parent_task_id` | TEXT NULL | Subagent/child work |
| `title` | TEXT NOT NULL | The user's request or the subagent's assignment |
| `state` | TEXT | `pending / running / done / failed / cancelled` |
| `progress` | REAL | `NULL` = unknown (never fabricated) |
| `started_at`, `ended_at` | INTEGER | |

Indexes: `idx_tasks_member_state(member_id, state)`, `idx_tasks_project_started(project_id, started_at)`.

A task is running **exactly while its row says `running`**. There is no elapsed-time, heartbeat or TTL
inference. "Last active" for a member/session is `MAX(started_at, ended_at)` over its tasks. Task
start/end is sufficient; no additional business heartbeat is needed.

### 4.5 `messages`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | Monotonic cursor for pagination |
| `dedupe_key` | TEXT UNIQUE | Idempotency across replay/sources |
| `project_id` | TEXT NOT NULL | |
| `ts_ms` | INTEGER NOT NULL | |
| `from_member` | TEXT NOT NULL | Member id or `system` / `user` |
| `to_member` | TEXT | `NULL` = broadcast |
| `type` | TEXT | `task_assign / task_update / result / question / block / review / error / shutdown / system` |
| `subject`, `content` | TEXT | Short title / body |
| `task_id` | TEXT | Related task |
| `session_id` | TEXT | Session that produced the message |
| `source` | TEXT | `report` / `watch` |
| `raw_json` | TEXT | Original payload for debugging/migration |
| `archived_at` | INTEGER | Archive marker (archive logic not implemented) |
| `content_truncated` | INTEGER | `1` = body was stored truncated |

Indexes cover `(project_id, ts_ms, id)`, sender, recipient and type. `messages_fts` is an FTS5 table with
`tokenize='trigram'` and insert/update/delete triggers; the query layer currently still uses `LIKE`, so
FTS search wiring remains future work. The message type `heartbeat` was removed from the enum.

### 4.6 Other reporting tables

- `task_runs` — one row per user-work turn: client, form, model, title, result, changed files, four token
  columns, duration, session. Token semantics are normalized per floor: `input_tokens` is the part that
  missed the cache; `cache_read_tokens` and `cache_write_tokens` are separate; `output_tokens` includes
  thinking. Unavailable values stay `NULL` (shown as `—`, not 0).
- `subagent_runs` — one row per summoned ghost: parent task, name, client/model, title, agent/call id,
  background flag, result, files, duration, tokens.
- `file_activity` — `id, member_id, path, op('read'|'write'), ts_ms`; keeps the latest 200 rows per member.
- `tool_usage` — accumulated count per `(task_id, tool)` with project/member/client/session and first/last
  timestamps.
- `artifacts` — `id, member_id, task_id, kind('file'|'doc'|'pr'|'text'), title, path, ts_ms`.
- `events` — generic audit/event row (`project_id, ts_ms, kind, payload_json`).
- `settings` — key/value server-persisted settings (currently retention days).

Council tables (`councils`, `council_participants`, `council_materials`, `council_rounds`,
`council_utterances`) are deliberately separate from the office tables: council participants never enter
the office, task ledger or token totals.

---

## 5. Protocol (v2)

### 5.1 Envelope

`PROTOCOL_VERSION = 2`. The envelope field is `project` (the old `team` field was renamed).

```ts
export interface Envelope<T = unknown> {
  v: 2;
  type: string;
  ts: number;
  seq?: number;
  project: string;
  actor: string;
  payload: T;
}
```

Authentication: HTTP uses `Authorization: Bearer <token>`; WebSocket uses `?token=` and/or a `hello`
frame. The token is read from `~/.workgremlin/server.json`.

### 5.2 Reporting API (HTTP, `POST /api/v1/...`)

| Path | Payload | Semantics |
| --- | --- | --- |
| `/register` | `{memberId, name, role?, sessionId?, client?, workspacePath?}` | Register/update a member; `reported=1` |
| `/task/start` | `{memberId, taskId?, title, sessionId?, parentTaskId?, workspacePath?}` | Create a task; the session becomes busy |
| `/task/progress` | `{memberId, taskId, progress, note?, files?, sessionId?}` | 0–1 progress; also clears that session's blocked row |
| `/task/end` | `{memberId, taskId, state:'done'\|'failed'\|'cancelled', artifacts?, sessionId?}` | Finish and write artifacts; idle if no other running task in the session |
| `/task/tokens` | `{memberId, taskId, tokens}` | Backfill only the four token columns; safe to retry |
| `/task/current` | `{memberId, sessionId?}` | Wrap-up fallback: find the member's current task |
| `/message` | `{from, to?, type, subject?, content, taskId?, ts?}` | Record one message |
| `/file/touch` | `{memberId, files\|path, op:'read'\|'write'}` | File read/write activity |
| `/tool/use` | `{memberId, taskId, tool, sessionId?}` | Increment tool-usage count |
| `/ghost` | `{action:'spawn'\|'finish'\|'sweep', ...}` | Summon/retire/clear ephemeral subagent ghosts |
| `/hook` | Raw product hook event + `workspacePath` | Server-side dispatch; the floor reads disk and writes the ledger |

There is **no `/heartbeat` endpoint** and **no `/status` endpoint**. Blocked state is produced by the hook
dispatcher, not by a client-side status call.

Ownership: `projectFirst` resolves the project from `workspacePath` (the reporter's actual cwd), falling
back to the request's `project`. This prevents "office shows project A, CLI runs in project B" from
recording B's work under A.

Responses: `{ok:true, ...}` or `{ok:false, error:{code,message}}` with
`400 bad_payload / 401 bad_token / 404 unknown_member / 500 internal`.

**Reporter SDK.**

```js
const { createReporter } = require('@workgremlin/reporter');
const rep = await createReporter({ project: 'workgremlin', member: 'coder' });
const task = rep.task('implement the desk cards');   // start is implicit
await task.progress(0.4, { files: ['renderer/src/components/WorkstationCard.vue'] });
await task.end('done', { artifacts: [{ kind: 'file', title: 'WorkstationCard.vue', path: '...' }] });
rep.close();
```

There is no heartbeat method: the SDK reports task lifecycle and messages only. The CLI exposes
`--project --member --task --progress --file --task-end --artifact --message --to --type --subject
--content`; it has no `--state` flag.

### 5.3 WebSocket protocol

Connection: `ws://127.0.0.1:<port>/ws?token=<token>`.

Client → server: `hello`, `subscribe`, `ping`, `backfill`.

Server → client:

```ts
{ type: 'snapshot',      ts, payload: { project, members: MemberCard[], recentMessages: Message[], serverTime } }
{ type: 'member.status', ts, payload: MemberCard }
{ type: 'task.update',   ts, payload: Task }
{ type: 'message.new',   ts, payload: Message }
{ type: 'messages.page', ts, payload: { beforeId, items: Message[], hasMore } }
{ type: 'file.activity', ts, payload: { memberId, path, op, tsMs } }
{ type: 'artifact.new',  ts, payload: Artifact }
{ type: 'connection',    ts, payload: { state: 'open'|'closed', source: 'ws'|'poll' } }
{ type: 'error',         ts, payload: { code, message } }
{ type: 'pong',          ts, payload: { ts } }
```

`MemberCard` (bound directly by desk cards and the office):

```ts
interface MemberCard {
  memberId: string;
  name: string;
  role: string;
  /** busy | idle | blocked */
  state: 'busy' | 'idle' | 'blocked';
  stateSince: number;
  /** Borrowed display state for a resident gremlin: busy when a same-named ghost works, otherwise idle */
  agentState?: 'busy' | 'idle';
  agentStateSince?: number | null;
  /** Every running task; the UI selects one by session id */
  tasks: Array<{
    id: string; title: string; progress: number | null;
    startedAt: number | null; endedAt: number | null;
    state?: TaskState; sessionId?: string | null; files?: string[];
  }>;
  /** Explicit authorization waits, scoped by session */
  sessionStatuses: Array<{ sessionId: string; state: 'blocked'; stateSince: number }>;
  currentFiles: string[];
  artifacts: Artifact[];
  /** Latest task start or end across the member */
  lastTaskAt: number | null;
  /** Latest task start or end per session */
  lastTaskAtBySession?: Array<{ sessionId: string | null; at: number | null }>;
  reported: boolean;
  messageCount: number;
  ephemeral: boolean;
  projectLabel: string | null;
  project: string;
  client: string | null;
  sessionId?: string | null;
  /** Subagent level (user / project); drives the neck badge color */
  level?: string | null;
  /** Static function description; empty string when unavailable */
  description?: string;
}
```

Broadcast policy: `member.status` is merged over a 200 ms window per member; `message.new` is sent
immediately; a slow client degrades rather than blocking the hub. The WS ping interval (30 s, with a 60 s
transport timeout) only detects a dead socket — it is not a member or task signal.

---

## 6. State model (authoritative summary)

```
busy    := the selected session has a task with state='running'
           (thinking / waiting for the model inside a running task is still busy)
blocked := the selected session has an explicit session_status row (state='blocked')
           reason: awaiting permission
idle    := neither of the above
precedence: blocked > busy > idle
```

- A `pending` task is **not** busy.
- A `failed` / `cancelled` / `done` task is not busy.
- A session ending clears its blocked row; it does not touch another session.
- A resident gremlin borrowing a ghost's work shows busy while the ghost runs; when the ghost disperses the
  borrow ends.
- Server restarts reconstruct the same state from `tasks` and `session_status`; there is no lease to expire.
- Supported states are exactly three. `offline`, `online`, `error`, `thinking`, `unknown` and `degraded`
  are not states and must not be added without a design change.

---

## 7. Milestones and current status

The product has shipped beyond the original M0–M3 outline. The current shape:

| Area | Status |
| --- | --- |
| Electron shell + embedded/standalone server + SQLite + WS | Done |
| Reporting SDK/CLI, hooks for CodeBuddy/Codex/Claude/Qoder/Kilo/OpenCode/Copilot | Done |
| Nine floors with on-disk session/task/token readers | Done |
| Isometric office, elevator, main console, desk cards, ghosts | Done |
| Task records: list, summary aggregates, daily Gantt, retention, CSV export | Done |
| Council chamber: fixed roles, multi-round review, convergence, reports | Done |
| Three-state workstation model, no heartbeat/TTL | Done (2026-10-21) |
| Message redaction, FTS query wiring, virtual scrolling | Not implemented |
| A-route `.codebuddy/teams` watcher | Not implemented (not required by the current design) |
| System notifications / do-not-disturb | Not implemented |
| TypeScript migration, Playwright E2E, packaging CI | Not implemented |

Detailed divergence tracking lives in `docs/implementation-status.md`.

---

## 8. Open questions

1. **Notifications.** With only three states, the old "blocked / error / offline > 60 s" trigger set no
   longer applies. The only candidate S1 event is `blocked` (authorization wait). Its urgency, aggregation
   window and default on/off behavior must be redesigned before notifications ship.
2. **Search.** `messages_fts` exists but queries still use `LIKE`. Decide when to wire FTS and how to handle
   1–2 character queries (trigram recall is poor; use a time-bounded `LIKE` fallback).
3. **Redaction.** Not implemented. The hard requirement remains: redact before the row and its FTS index are
   written; plaintext must never reach the database.
4. **Retention/archiving.** The retention setting and task deletion paths exist; message archiving to JSONL
   is not implemented.
5. **Multi-workspace.** One open project at a time; multi-workspace observation remains an architectural
   reservation, not a feature.
6. **Renderer test tooling.** Plain Node suites cover logic; a browser/Electron E2E layer is still missing.
