# WorkGremlin Roadmap and Responsibility Matrix (v0.2)

- Maintainer: leader
- Version: v0.2 (2026-10-21); previous version v0.1 (2026-09-14)
- Related documents: `docs/requirements.md` (requirements), `docs/tech-design.md` (technical design), `docs/test-strategy.md` (test strategy), `docs/implementation-status.md` (code reality and document drift)

> **2026-10-21 — workstation state model simplified (commit `e2ad323`).**
> The old model of five primary states plus a liveness flag is gone. A workstation now has exactly
> **three** mutually exclusive states: `busy`, `idle`, `blocked`.
>
> - `busy`: a task belonging to that member/session has `tasks.state = 'running'`. "Thinking" or
>   "waiting for the model" inside a running task is still busy. A `pending` task is **not** busy.
> - `blocked`: an explicit authorization wait for one session, stored in `session_status`
>   (`state = 'blocked'`, `reason = 'awaiting_permission'`). It is written from `PermissionRequest` /
>   permission `Notification` hook events and cleared by task progress, task end, session end, or an idle
>   notification. It is session-scoped: two sessions of the same member do not affect each other.
> - `idle`: no running task and no blocked row for that session. Absence of a row means idle.
>
> Removed in the same refactor, and no longer part of the product: the business heartbeat and its
> `/api/v1/heartbeat` + `/api/v1/status` endpoints; `offline` / `online` / `error` / `thinking` as
> workstation states; the `degraded` flag; TTL / lease renewal and timeout inference; `source = 'timeout'`;
> `members.last_seen_at`; and the `agent_status_history` table. "Last active" now comes only from task
> start/end timestamps (`lastTaskAt`, `lastTaskAtBySession`). The WebSocket ping (30 s interval, 60 s
> timeout) is transport-only and never changes a workstation state.
>
> Consequences for this document: the M1 deliverables and acceptance criteria were rewritten around the
> three-state model; every acceptance item for heartbeat, degraded, offline and error was deleted; the
> council section no longer references them. This file was also fully rewritten in English, preserving the
> original milestone structure, responsibility matrix and dependency chain.

---

## 0. Milestone numbering alignment

The coder and tester documents used different milestone numbers. This document uses the **coder's M0–M3 as
the primary numbering**, except that reverse control and watcher productionization were split out as **M4**.
The mapping is:

| Primary number (this document) | coder `tech-design.md` | tester `test-strategy.md` | Goal |
| --- | --- | --- | --- |
| **M0** | M0 | M0 | Skeleton + testability foundation + demo mode |
| **M1** | M1 | M1 | Real state ingestion, workstation view online |
| **M2** | M2 | M2 + **M3** (persistence and recovery) | Conversation window + persistence and recovery |
| **M3** | M3 | **M4** (desktop packaging and release) | Packaging, distribution, enhancements |
| **M4** | optional M4 (reverse control) | **M5** (watcher productionization) | Reverse control (**decided: dispatch + interrupt only**) / watcher productionization |

---

## 0.1 Actual progress (aligned 2026-10-21)

> Where the code actually stands. The detailed per-item drift log is in `docs/implementation-status.md` §5;
> this table is the schedule-level summary. "Delivered" means it ships and is used; "not delivered" means
> the code does not exist yet, not merely that it is untested.

| Milestone | Delivered | Not delivered |
| --- | --- | --- |
| **M0** ✅ substantially met | npm workspaces monorepo; Electron window (Vite in dev, `renderer/dist` in prod); `better-sqlite3` + `@electron/rebuild` (verified by `npm run db:check`); demo mode as an isolated demo project opened from the UI action bar; reporter SDK + CLI; WS push and reconnect. **73 test suites** run via `npm run test:all` (57 server test files + 17 renderer test files; 73 `test:*` scripts, `pluginReply.test.js` has no alias), all plain Node scripts with a local `ok()` helper — **not Vitest or Playwright**. | Most of the six testability contracts: only the injectable clock (`server/src/clock.js`) and a partial fake source landed; `packages/core` was never split out; no lint-enforced core/Electron boundary; `data-testid` covers only part of the UI; no IPC contract tests. The original "repository has no test files" claim is obsolete and corrected here. |
| **M1** 🟡 partially met | hook ingest chain (CodeBuddy plugin/CLI, Cline, Codex, Claude Code, Qoder); project switching; resident roster + ephemeral ghost list; floor/session tables; **three-state model** `busy / idle / blocked` with session-scoped blocked; member-card aggregation; last-active from task start/end. | **A-route (`chokidar`) watcher: zero code** (`chokidar` is declared in `server/package.json` but referenced nowhere in source); **message redaction: zero code**, no interception point; dual-connection storage (currently one connection with `secure_delete=ON`); `file_activity.op` has only `read` / `write` (`edit` retired); in-app alerts; layout thresholds (compact at ≥5, pagination at >16); automatic archive before delete. |
| **M2** 🟡 partially met | Message persistence with `dedupe_key` idempotency; filtering by member/type/time + keyword (`LIKE`); conversation page. | **FTS5 query and the 1–2 character `LIKE` fallback are not wired** (virtual table and triggers exist; `listMessages` always uses `LIKE`); virtual scrolling; automatic archive/retention-to-JSONL flow (only a retention-days setting and manual `purgeProject` exist); the `events` table exists but has **no writer callers** (only a prepared statement), so audit/replay is not live. |
| **M3** ❌ not started | An `electron-builder.yml` exists, but no packaging pipeline or release artifact is produced. | electron-builder packaging, timeline charts, session export, dark theme, system notifications and do-not-disturb, encrypted original-text channel. |
| **M4** ❌ not started | — | Dispatch / interrupt, watcher productionization. |
| **Council** ✅ delivered (outside the original schedule, see §5.1) | Fixed roles (one moderator, one main answerer, one or more reviewers) + multiple review rounds + server-computed convergence + seven-floor recipes + dedicated page and tables; on-machine runs completed on 1F / 2F / 4F / 8F; **workspace-directory mode (2026-10-02)**; **voting removed in favour of the role-based flow (2026-10-19)**; fail-fast on a failed turn; live "working" strip. | 3F / 6F / 7F have not completed a full meeting on a real machine (3F parameters verified, model call limited by local login state; 6F/7F not run); round limits are initial values; workspace-mode on-machine acceptance still pending. |

**Delivered beyond the original plan** (not scheduled in v0.1): the isometric Canvas office engine and main-agent console (`renderer/src/iso/`), floor/product installation detection (1F–9F), the global active-session table (60-minute eviction window), project-level and user-level subagent rosters, the elevator-transition design in `docs/design-elevator-transition.md`, and the **council (§5.1)**.

**Language stack**: the TypeScript migration decided in §7 risk 7 **has not been executed**. The code is
still CommonJS JavaScript checked by `jsconfig.json`. The hard prerequisite (get V1 green first) was met long
ago; the migration itself never started.

**State-model status**: the three-state model is implemented end to end (shared constants, DB schema,
aggregation, renderer). The migration in `server/src/db/index.js` rebuilds the pre-refactor
`agent_status` / `session_status` tables and drops `members.last_seen_at`, so existing databases are
upgraded in place.

---

## 1. M0 — Skeleton, testability foundation, demo mode

**Goal**: the project starts with one command, both core screens render statically from mock data, and every
high-risk technical item (native module build) is proven before UI work expands.

| Item | Content |
| --- | --- |
| **Owner** | coder (primary), tester (contract acceptance + smoke), leader (schedule and blocker escalation) |
| **Dependency** | none (starting milestone) |
| **Deliverables** | 1. npm workspaces monorepo skeleton: `shared/` `server/` `desktop/` `renderer/` `packages/reporter/` `scripts/dev.sh`<br>2. Electron shell opens a window (dev via Vite 5173, prod via `renderer/dist`)<br>3. **Workstation view** rendered statically from mock data (4 cards with state badge, task, progress, files, artifacts, elapsed time)<br>4. **Conversation window** rendered statically from mock data (20 messages + filter UI + search box UI)<br>5. `better-sqlite3` + `@electron/rebuild` working (**the highest-risk M0 item; prove it before writing more UI**)<br>6. `packages/reporter` CLI with a manually callable reporting example<br>7. **Demo mode**: a deterministic fake data source. Since 2026-09-21 it is a **UI action**, not a `--demo` / `MOCK=1` startup flag: it opens an isolated demo project and restores the previous project on exit. It doubles as the fixture source for component tests and manual walkthroughs<br>8. Six testability contracts landed (see §1.1)<br>9. WS connectivity (echo) + reconnect skeleton<br>10. **Schema placeholders for later milestones (no logic this phase)**: `file_activity.op` (the planned `edit` value was later retired; only `read`/`write` shipped), `tasks.progress`, a replaceable `redact(content)` middleware point, `archived_at` and `content_truncated` with indexes, the `events` audit table<br>11. **Dual-connection storage plan (security and throughput without a trade-off)**: a **write connection** with `secure_delete=OFF` for the steady-state event load, and a **delete/archive connection** with `secure_delete=ON` for archive and manual deletion. `secure_delete` is per connection, so two connections are required. WAL with an explicit `wal_autocheckpoint`, `wal_checkpoint(TRUNCATE)` after deletion, and `0600` permissions on `.db` / `.db-wal` / `.db-shm`. **Never disable `secure_delete` for throughput.** Status: planned, not implemented (today is a single connection with `secure_delete=ON`)<br>12. **FTS5 table created directly with `tokenize='trigram'`** (decision Q10, avoiding a later index rebuild). Status: table and triggers exist; the query layer is not wired |
| **Explicitly not doing** | A real watcher, SQLite business writes beyond the self-test, FTS5 query logic, virtual scrolling, ECharts, installers, full reporter, archive logic, redaction implementation (hook point only), system notifications (configuration placeholder only), encrypted original-text channel (M3) |

### 1.1 Six testability contracts that must land in M0 (hard block)

> Numbering follows `test-strategy.md` §7. Tester v0.3 promoted 7.2 to a hard blocker (demo mode is the
> `FakeEventSource`) and merged 7.5 into 7.1.

| # | Contract | Notes |
| --- | --- | --- |
| 7.1 | **Injectable time source** (Clock interface + FakeClock, with monotonic and wall-clock separated) | Elapsed-time, timeout and recovery cases can assert deterministically. Implemented as `server/src/clock.js` |
| 7.2 | **EventSource + fake implementation** | Demo mode is the `FakeEventSource` plus fixtures; required by M0 |
| 7.4 | **Deterministic IDs** (`msgId` / `seq` / unique indexes injectable) | Makes E2E repeatable |
| 7.6 | **Core decoupled from Electron** (`packages/core` pure implementation, dependency-injected source/repository/clock) + lint enforcement | L1/L2 headless runs; demo reuses it. Not delivered: no `packages/core` |
| 7.7 | **`createTestApp()` factory** | Inject an event and assert store state within one second |
| 7.9 | **Stable `data-testid` selectors** | Naming: `seat-card-<agentId>`, `seat-status-<agentId>`, `msg-row-<msgId>`, `conv-list`, `filter-agent`, `search-input`, `archive-notice`. The old `seat-degraded-<agentId>`, `seat-progress-<agentId>` and `watcher-banner` selectors are retired |

> 7.15 (`--user-data-dir=` / `WORKGREMLIN_HOME` data-directory override) is a **strong M0 recommendation**
> for isolated E2E runs and isolated demo projects. `WORKGREMLIN_HOME` and `WORKGREMLIN_DB` exist.

### 1.2 Definition of Done (aligned with `test-strategy.md` v0.3 §6 M0)

- [x] `npm run dev` starts with one command (verified on Linux).
- [ ] **All six testability contracts landed** (7.1 / 7.2 / 7.4 / 7.6 / 7.7 / 7.9). Partial only.
- [x] **Demo mode delivered**: deterministic isolated demo project, 6 resident experts + 2 temporary members, ≥200 messages. The seed covers `busy / idle / blocked` and **does not fabricate any other state**.
- [x] **Native module check `N1` (Linux x64)**: dependencies installed, `@electron/rebuild` succeeds, and `npm run db:check` creates tables and reads/writes back. The "require from the packaged app" criterion is **not covered by an automated test** (there is no packaging test yet; see M3).
- [ ] `check:arch-param` static check (no hard-coded architecture in packaging config). Not delivered.
- [x] `archived_at` and `content_truncated` fields and indexes exist (archive logic is still M2 work).
- [ ] IPC contract test skeleton (≥1 passing). Not delivered.
- [ ] General DoD (tester document §6): L1 line coverage ≥80%, no S1, repeatable 5× with flaky=0. Not measurable yet: there is no coverage-instrumented runner.

### 1.3 Verification checkpoints after coder starts (report to main with command and result)

| # | Checkpoint | How to verify | Status 2026-10-21 |
| --- | --- | --- | --- |
| V1 | Dependencies installed + **electron-rebuild native module build succeeds** | After `npm i`, `npx @electron/rebuild` succeeds; Node-side `require('better-sqlite3')` creates a table, inserts and queries | ✅ passed |
| V2 | Electron window opens | `npm run dev` shows the main window | ✅ passed |
| V3 | Both screens render from mock data | Screenshot/assertion: 4 desk cards + 20 messages render correctly | ✅ passed (desk cards and conversation view ship) |
| V4 | DB read/write succeeds | Write one message via the server API and read it back | ✅ passed |
| V5 | Demo mode | Demo project opens from the UI action bar, data is deterministic and matches the fixtures | ✅ passed |
| V6 | WS push updates the UI | Push one `member.status` frame; the card state changes | ✅ passed |

> Any checkpoint that blocks (especially V1) must be escalated to main immediately. **Silent degradation of
> the plan is forbidden.**

---

## 2. M1 — Real state ingestion, workstation view online

| Item | Content |
| --- | --- |
| **Owner** | coder (primary), tester (real-time and state-correctness focus), researcher (state-semantics acceptance criteria), leader (integration) |
| **Dependency** | M0 complete; researcher's state-semantics definition signed off (blocking rules for `busy` / `blocked`) |
| **Deliverables** | See §2.2. The state contract is in §2.1 |

### 2.1 The three-state contract (implemented)

`AGENT_STATES = ['busy', 'idle', 'blocked']` in `shared/index.js` and `shared/index.d.ts`.

| State | Source of truth | Cleared by |
| --- | --- | --- |
| `busy` | a task for that member/session has `tasks.state = 'running'` | task end (`done` / `failed` / `cancelled`), or session reconciliation closing an orphaned running task as `cancelled` |
| `blocked` | a row in `session_status` with `state = 'blocked'` (explicit authorization wait) | task progress, task end, session end, or an idle notification |
| `idle` | no running task and no blocked row for that session (no row at all) | — |

Derivation and display rules, as implemented:

1. A `pending` task does not make anyone busy. A member with only pending work is `idle`.
2. "Thinking" and "waiting for the model" are part of a running task; there is no separate state for them.
3. Member-card aggregation in `buildMemberCard` uses priority `blocked > busy > idle`; for equal priority the
   earliest `stateSince` wins. `stateSince` drives the elapsed-time display.
4. The renderer (`renderer/src/lib/memberTask.js`, `memberForSession`) follows a session-scoped rule for the
   selected session: `blocked (same session) > running task (same session) > borrowed summon busy > idle`.
   Unknown state values normalize to `idle`.
5. A resident gremlin may borrow `busy` from a same-named ephemeral ghost while that ghost is working. This is
   the **only** row allowed in `agent_status` (`state CHECK = 'busy'`). It is a display state, not task
   liveness.
6. Blocked is session-scoped: a blocked session does not block the member's other sessions.
7. "Last active" comes from task start/end timestamps: `lastTaskAt` is the latest `MAX(started_at, ended_at)`
   for the member; `lastTaskAtBySession` holds the per-session values. There is no heartbeat-based
   "last seen".
8. The server does **not** infer or cancel tasks from elapsed time, heartbeat loss or TTL. The only cleanup is
   an explicit session-list reconciliation (`pruneSessionStatuses` closes running tasks of sessions that no
   longer exist as `cancelled`).
9. The WebSocket ping (30 s interval, `DEFAULTS.WS_HEARTBEAT_TIMEOUT_MS = 60 s`) is **transport-only**. HTTP
   polling after a WS drop is a connection fallback and likewise not a state signal.
10. On-disk floor readers may use file mtimes and idle windows (e.g. `IDLE_MS = 10 min` in
    `server/src/floors.js`) to describe a **session's** activity phase on the main console. That is inferred
    session activity, not a workstation state and not a member heartbeat.

### 2.2 Deliverables and honest status

1. **A-route**: `chokidar` watcher + parser (roster + mailbox). **Not implemented** — zero source references;
   `chokidar` is only declared as a dependency.
2. **B-route**: HTTP ingest + `packages/reporter` SDK/CLI. **Implemented**: `/api/v1/register`, `task/start`,
   `task/progress`, `task/end`, `task/tokens`, `task/current`, `message`, `file/touch`, `tool/use`, `ghost`,
   `hook`. There is no heartbeat or status endpoint, by design.
3. **SQLite persistence** (members / agent_status / session_status / tasks / messages / file_activity /
   artifacts). **Implemented.** `agent_status` and `session_status` are deliberately narrow: busy-only and
   blocked-only respectively.
4. **`snapshot` + `member.status` WebSocket push** (200 ms merge window). **Implemented**; the envelope is
   protocol v2 with a `project` field.
5. **Three-state shared types and DB schema** — `busy / idle / blocked` only. **Implemented**, including the
   in-place migration that rebuilds legacy tables and drops `members.last_seen_at`.
6. **State derivation + aggregation** (session-scoped blocked, priority, `stateSince`, borrowed busy).
   **Implemented** and covered by state-related suites (`renderer/test/memberTask.test.mjs`,
   `server/test/agentRoster.test.js`, `server/test/sessionCompact.test.js`, among others).
7. **Connection strip** distinguishing transport source (`ws` vs `poll`) and per-field provenance
   (reported / inferred / demo). **Implemented**; there is no third "degraded" value to display.
8. **Archive retention** (90 days / 100k messages per project, export to JSONL before deleting).
   **Not implemented**; only a retention-days setting and manual purge exist.
9. **Message redaction**: regex redaction to `***` before insert, with the original never stored (7 rule
   classes, requirements §P0-7), and a "this message was redacted" UI marker. **Not implemented**; no
   interception point exists, so messages are stored in plain text today.
10. **Progress honesty**: `tasks.progress` is stored and returned, but no progress bar is rendered. The old
    three-layer derivation (reported → subtask-derived → striped indeterminate bar) was **dropped**, matching
    the product decision that no fake progress is allowed.
11. **File read/write distinction**: `file_activity.op` supports `read` and `write` only; the planned `edit`
    value was retired. UI icons/colour bars for `read`/`write` exist.
12. **Layout thresholds**: automatic compact mode at ≥5 members, pagination/collapse at >16 members,
    overridable thresholds. **Not implemented**.
13. **In-app alerts**: not implemented. Any acceptance wording that tied alerts to the removed states is
    deleted with them.

### 2.3 Acceptance criteria

- **State rendering**: only `busy / idle / blocked` render; unknown values normalize to `idle`; no fifth
  state, no synthetic secondary flag. The desk card labels map to "忙碌" / "空闲" / "阻塞".
- **Busy correctness**: busy appears only when a task in that session is `running`; a `pending` task leaves the
  member idle; "thinking" does not produce a separate state.
- **Blocked correctness**: blocked appears only for an explicit authorization wait in the same session, and
  clears on progress, task end, session end or an idle notification.
- **Session isolation**: 16 concurrent members/sessions with no cross-talk (SC-07 / SC-23); switching the top-bar
  session changes the console phase without bleeding into another session.
- **Aggregation**: priority `blocked > busy > idle`; ties broken by earliest `stateSince`.
- **Borrowed busy**: only a same-named ephemeral ghost can lend `busy`; the resident returns to idle when the
  ghost finishes.
- **Last active**: derived from task start/end only; no heartbeat-driven value anywhere in cards or APIs.
- **Real-time**: RT-01 propagation P95 ≤ 300 ms; RT-03 / RT-04 pass; RT-05 high-frequency jitter has a
  before/after comparison.
- **Tests**: DB-01–DB-10 pass; `kill -9` recovery loses at most 1 s; the state suites above stay green under
  `npm run test:all` (73/73 suites, ~58 s).
- **Redaction (blocked until implemented; three layers, UI hiding does not count)**:
  a) no plaintext exists on the **write connection** path — construct a secret-bearing message and grep the
  table, `.db` and `.db-wal`;
  b) after deleting through the **delete connection**, grep again — no recognizable fragment may remain in
  the freelist or WAL;
  c) throughput and latency still hold under load, proving the dual-connection design;
  d) **negative control**: deliberately turn `secure_delete` off and confirm step (b) fails, proving the
  assertion has detection power. SEC-01–SEC-07 and SEC-12 must pass when this lands.
- **Virtual-list spike** (`SPIKE-01–08`, first week of M1): DOM ≤ 80 nodes, scroll ≥ 55 fps with a 40 fps
  floor, first render ≤ 500 ms, memory growth ≤ 200 MB, 100 appends/s at the tail still ≥ 50 fps, 100k-row
  search ≤ 300 ms, filter switch ≤ 200 ms, a 1 MB message does not freeze the UI. **Not started.**
- **Chinese tokenization spike** (`SPIKE-09–12`, end of M1): trigram conclusion recorded, Chinese corpus
  search < 200 ms, 1–2 character fallback to `LIKE` behaves correctly, and the FTS tokenizer is configurable
  (contract 7.19). **Not started**; FTS is not wired at all.
- **Manual smoke** (there is no Playwright E2E): with a real agent running, state refresh is visible and
  matches the desk card.

### 2.4 Risks

1. Reporter instrumentation needs cooperation from the agent side; if an agent cannot be changed, its
   progress/files/elapsed time remain placeholders.
2. High-frequency state flapping can cause UI flicker and performance problems (mitigated by the 200 ms
   merge window; still a tester focus).
3. Redaction regexes may damage normal code/logs (needs a false-positive baseline and an off switch).
4. Session-scoped state is correct only if every hook carries a session id; a missing session id collapses
   several sessions into one display slot.

---

## 3. M2 — Conversation window + persistence and recovery

| Item | Content |
| --- | --- |
| **Owner** | coder (primary), tester (message integrity + 100k-row load test), leader (integration) |
| **Dependency** | M1 complete |
| **Deliverables** | 1. Full message persistence and incremental push (`dedupe_key` idempotency, no loss, no duplication). **Implemented**<br>2. Filtering: member multi-select + time range + message type. **Implemented**<br>3. Keyword search via SQLite **FTS5 + `trigram`** tokenizer, with **1–2 character queries falling back to `LIKE`** limited to a time range. **Not implemented** (virtual table exists; `listMessages` always uses `LIKE`)<br>4. Virtual scrolling + pull-up history. **Not implemented**<br>5. Auto-follow scrolling + pause on manual scroll-up + "N new messages" notice. **Partially implemented** (conversation view exists; explicit pause/notice behaviour unverified)<br>6. Message detail and raw JSON view. **Implemented**<br>7. `events` table live (audit/replay foundation). **Table exists, no writer callers**<br>8. **M2 spike (at milestone start)**: trigram Chinese recall measurement + 100k-row virtual-scroll load test; evaluate jieba pre-tokenization only if recall is insufficient. **Not started** |
| **Acceptance** | - MS-01–MS-04, MS-06–MS-12 pass (MS-05 under the virtual-scroll scope below)<br>- **MS-05: at 100k rows, DOM ≤ 80 nodes, scroll ≥ 55 fps, memory growth ≤ 200 MB**<br>- Filter/search combinations match the specification (boundary semantics documented)<br>- Filter/search response < 200 ms at 10k rows<br>- Real send/receive smoke of 1000 messages with no loss and no duplicates (manual, no Playwright)<br>- DB-01–DB-10 pass; crash recovery has an automated test; migration scripts have forward-compatibility tests<br>- Retention: the days setting and manual deletion work; the export-to-JSONL-before-delete archive flow is still open |
| **Risks** | Virtual scrolling and Chinese FTS5 tokenization (may fall back to `LIKE` or bigram); message volume growth without automatic archiving |

---

## 4. M3 — Packaging, distribution and enhancements

| Item | Content |
| --- | --- |
| **Owner** | coder (primary), tester (three-platform matrix + long-run stability), leader (integration) |
| **Dependency** | M2 complete |
| **Deliverables** | 1. `electron-builder`: Linux **AppImage/deb**, Windows **nsis**, macOS **dmg** (**x64 only**, script parameters without hard-coded architecture). **Not integrated**: `electron-builder.yml` exists, but `npm run build` only builds the renderer<br>2. Multi-project switching within one workspace. **Implemented ahead of schedule** (project is the domain unit; recent projects persisted)<br>3. ECharts project timeline and throughput charts. **Not implemented**<br>4. Session export to Markdown / JSONL. **Not implemented**<br>5. Dark theme. **Not implemented**<br>6. Lightweight actions: mark read, export, copy original text. **Not implemented**<br>7. **System notifications and do-not-disturb**: S1-level events only; system notifications on by default, sound off by default; **do-not-disturb off by default** + a `22:00–08:00` template; aggregate same-member + same-fault-type events into one notification per 5 minutes; events that occurred while the app was not running are merged into "N events while you were away"; **notify only when unfocused, in-app only when focused**. **Not implemented**<br>8. **Redacted original-text viewing channel (off by default)**: OS keychain (`keytar`) holds the data key, with passphrase-derived (scrypt/argon2) fallback; original and body **in separate tables with independent encryption**; **re-authorize every session, never remember unlock state**; views are recorded in the event log. **Not implemented** |
| **Acceptance** | - DS-01–DS-13 pass; three-platform x64 matrix green<br>- Silent install/upgrade/uninstall automation covered<br>- **macOS: written waiver Q11 accepted** — reduced to **ad-hoc signing**; the release page / README / release notes / in-app "About" page all state "not notarized; on first launch right-click → Open / System Settings → Privacy & Security → Open Anyway". A written waiver record is enough to ship<br>- **8-hour stability run**: RSS growth < 20%, no handle leaks, no crashes<br>- Release checklist signed |
| **Risks** | ~~macOS notarization needs a developer account~~ → **Q11 written waiver, not blocking**; residual risk is first-launch friction, covered by the four disclosure locations. Notification acceptance must not reintroduce removed state triggers: only real faults and prolonged `blocked` waits are eligible, never a liveness timeout. |

---

## 5. M4 — Reverse control (conservative) and watcher productionization

> Decided: **do it, but only the most conservative layer**.

**Reverse-control scope (two items only)**

1. **Deliver a task message** to a specified member (dispatch);
2. **Interrupt the current task** (send an interrupt signal).

**Explicitly not doing**: code-level intervention, breakpoints/prompt rewriting, retry policy, direct
manipulation of user files.

**Constraints**: every reverse operation requires **UI confirmation** and is recorded in the event log
(`events` table; the table exists but no writer is wired yet). Not implemented in M0–M3; the architecture
reserves a command channel (bidirectional WS is already in place).

**Remaining content**

- **Watcher productionization**: `FW-01–FW-12` pass (run FW-01/03/05/08 on Linux + Windows + macOS); the
  polling fallback has a UI notice and automated verification. Depends on the A-route watcher, which has zero
  code today.
- **Multi-workspace**: architecture reserved, not scheduled.

---

## 5.1 Council — a delivered **independent slice** (2026-10-01)

> **It is not the first slice of M4.** It is placed here only because it also involves "the server starts
> processes", which makes it easy to file under M4 by mistake — and a wrong home would later hold it to M4's
> acceptance criteria. The capability boundary is defined by `requirements.md` §15.

**What it is**: pick a few floors and run a multi-round **review** of one topic. Roles are fixed: one
moderator, one main answerer, and one or more reviewers (a floor cannot play two roles). Round 0 has the
moderator break down the topic and assign focus; round 1 has the main answerer propose; after that each round
is "main answerer revises → reviewers give independent structured opinions → moderator summarises and issues
hard revision directives". After the configured rounds the moderator adjudicates and the main answerer
delivers the final draft. **No voting, no threshold, no majority agreement**; the convergence score is
computed mechanically by the server from severity and conflict counts, and model-reported scores are ignored.

| | Council | M4 / P2-1 reverse control |
| --- | --- | --- |
| Target | New, one-off processes (**read-only tools only**) | **Sessions being monitored** (your Codex / Claude sessions) |
| Action | Discuss only, produce text | Dispatch / interrupt sessions people are using |
| Status | ✅ Delivered (verified on-machine: 1F / 2F / 4F / 8F; 3F parameters verified, model call limited by local login state; 6F / 7F pending) | ❌ Not started; §5 scope unchanged |

**Deliverables**: `server/src/council/` (`agents.js` seven-floor command recipes / `floors.js` optional floor
detection / `runner.js` single call and timeout / `parse.js` structured-output parsing / `convergence.js`
convergence and consistency checks / `prompt.js` prompt assembly / `materials.js` inline materials /
`report.js` report plus CSV/Markdown / `orchestrator.js` state machine) + `http/routes/council.js`, `renderer/src/views/CouncilView.vue` + `stores/council.js` + `lib/councilTimeline.js`, seven `council_*` tables, and 12 `test:council-*` scripts (parsing / convergence / report / storage / recipes / single call / orchestration / materials / routes / plugin silence / timeline / UI store). Implementation details and on-machine observations are in `implementation-status.md` §4.2.

**2026-10-02 addition — "where to talk"** (outside the original schedule; the user asked to discuss inside
the same project directory): `workspace_path` (isolated temp directory / **real project directory + read-only
tools**). Boundaries, the two isolation locks, and on-machine verification results are in
`requirements.md` §15.3 and `implementation-status.md` §4.2; cases are in `test-strategy.md` §3.16.

**2026-10-19 refactor**: the user asked to remove voting and move to a moderator / main answerer / reviewer
flow. The old `mode` (`vote` / `analysis`), vote counting and thresholds were deleted; old council tables are
not migrated and are rebuilt at startup. Convergence became
`clamp(100 − (25b + 8m + 2n + 10c), 0, 100)`, each round stores one `RoundResult`, and reports are written as
JSON / CSV / Markdown. After an on-machine failure in the same round (1F round 0 CLI truncated output), two
things were added: **any required turn that cannot answer ends the meeting immediately** (later rounds are
not burned; what was produced is archived), and a **"working" indicator** visible right after start (floor /
phase / round, over WS + the detail endpoint, surviving refresh).

**2026-10-21 note**: the council's "working" strip is **not** a workstation state. Council participants are
one-off read-only processes and never appear in the office, member cards or task records; the council is
unaffected by the three-state refactor. The live strip keeps its own floor/phase/round fields.

**Open items (non-blocking; decide after a few real meetings)**

- `max_rounds` (default 3, hard cap 8) is an initial value; whether each reviewer must produce at least N
  comments **has no lower bound yet** (only "no comments at all" is recorded as a warning) — deliberately
  loose for now.
- Council tokens **do not enter the `task_runs` token totals** (they live only in council tables); whether
  they should count is undecided.
- 7F Kilo Code / 6F Qoder have not run **a full meeting** on a real machine (1F / 2F / 4F / 8F have; 3F
  parameters were aligned with the local `codex --help`, but the model step did not complete because the
  machine's Codex login state was invalid). 6F's CLI is not installed on this machine; its recipe follows the
  official documentation. In workspace mode, 6F's office isolation (whether the `--name` title also enters
  the transcript) must be confirmed on a machine with the CLI installed.
- **Workspace-mode on-machine acceptance is still pending** (the three checks "real file names appear in the
  answer", "`git status` is clean afterwards", "participants are invisible in the office" are in
  `test-strategy.md` §3.16.2).

---

## 6. Responsibility matrix

| Milestone | coder | tester | researcher | leader |
| --- | --- | --- | --- | --- |
| M0 | Primary (full skeleton + demo + six contracts) | Contract acceptance, smoke, L1 skeleton | State semantics sign-off (M1 dependency, can run in parallel) | Schedule, blocker escalation, integration reporting |
| M1 | Primary (B-route ingest + SQLite + push + three-state derivation) | Real-time, state correctness, DB recovery focus | Acceptance criteria and state-semantics acceptance | Integration plan |
| M2 | Primary (full messages + filter/search + virtual scrolling) | Message integrity, 100k-row load test | Filter/search semantics acceptance | Integration plan |
| M3 | Primary (packaging + enhancements) | Three-platform matrix, long-run stability | — | Release coordination |
| M4 | Primary (dispatch/interrupt + watcher productionization) | Reverse-operation safety and audit checks | — | Scope control: keep it to the conservative layer |
| Council (delivered) | Primary (server orchestration + UI) | Recipe/parse/convergence/timeline cases | Review-quality rubric | Kept out of M4 sequencing |

---

## 7. Dependency chain

```
researcher state-semantics definition ──┐
                                        ├──> coder M1 (three-state model + DB schema)
M0 electron-rebuild green ──────────────┘         │
                                                  v
                                        tester M1 real-time/state-correctness focus
                                                  │
                                                  v
                                        coder M2 conversation records ──> tester M2 load test
                                                  │
                                                  v
                                        coder M3 packaging ──> tester M3 three-platform matrix
```

The M1 state contract is already implemented and is the base every later milestone reads from. M2 and M3 do
not depend on the unfinished A-route watcher; M4 watcher productionization does.

**Highest risks (by priority)**

1. **`better-sqlite3` + `@electron/rebuild` build failure (M0-V1) — closed.** V1 passed and the shipped app
   uses the native module; `npm run db:check` is the regression check. The documented fallbacks (`node:sqlite`,
   or moving the server out of the Electron main process) remain as contingency only and are not active
   blockers.
2. Reporter instrumentation needs agent-side cooperation; without it, "progress / current files / elapsed
   time" degrade to placeholders (affects M1's core value). Existing hooks cover CodeBuddy, Cline, Codex,
   Claude Code and Qoder; other floors rely on on-disk readers.
3. Virtual scrolling at 100k rows; Chinese FTS5 with `trigram` has **poor short-query recall (1–2 characters)**
   and needs the `LIKE` fallback (M2, validate in a spike first).
4. ~~macOS notarization~~ → **Q11 written waiver, risk closed**.
5. ~~`secure_delete` killing write throughput~~ → **decided: dual-connection design, neither metric relaxed**
   (write connection OFF / delete-archive connection ON). Status: not implemented; today there is a single
   connection with `secure_delete=ON`. Residual risk: frequent archive deletes plus a `TRUNCATE` checkpoint can
   cause a momentary stall — batch and lower the frequency of archiving rather than weakening security.
6. Redaction regexes may damage normal code/logs (M1, needs a false-positive baseline and an off switch).
   Currently not implemented at all.
7. **Language-stack deviation — decided: option A (move back to TypeScript), with a hard prerequisite and a
   safety valve** (main, 2026-09-14). The code is still CommonJS **JavaScript** (`jsconfig.json`); the decision
   stands but the migration was never executed.
   - **Rationale** (three substantive reasons, not sunk cost): ① this project is **protocol-heavy** (envelope,
     a dozen message types, agent reporting API, renderer subscription shapes); a wrong field name is only
     found at runtime, and such bugs are very hard to reproduce in a live state stream — typed contracts pay
     off as the codebase grows; ② the migration is cheapest now, and "the code already looks like this" must
     not dictate the decision; ③ tester estimates ~80% of cases are language-agnostic, so nearly all cost sits
     on the coder side.
   - **Hard prerequisite: language-stack work ranks strictly below V1.** That prerequisite is now satisfied,
     but no migration budget has been spent.
   - **Safety valve: total migration time cap of 1 day** (`tsconfig` + Vite config + converting files +
     typed contracts). If exceeded, or if the TS toolchain conflicts with `electron-rebuild`, escalate
     immediately and switch to option B.
   - **Conditions for switching to B**: the coder estimates > 1 day, or the TS toolchain conflicts with
     `electron-rebuild`. Option B requires three tester prerequisites: `checkJs: true` with at least
     `strictNullChecks`; a runtime schema-validation library for IPC contracts; eslint rules for `no-undef`,
     `eqeqeq` and async correctness.
   - Either way, **the hard floor is unchanged: language work must never block M0 for more than one day.**

**Tracking items (main-assigned)**

| ID | Item | Owner | Closure condition | Status |
| --- | --- | --- | --- | --- |
| **T-01** | `server/src/db/index.js` was 0 bytes (content apparently missing) | coder | Real implementation written and V1 (`better-sqlite3` + `electron-rebuild`) green on the local machine | ✅ Closed — file is ~76 KB and `npm run db:check` passes |
| **T-02** | A-route `chokidar` watcher has zero code; floors without hooks are invisible | coder | Watcher + parser run and feed roster/mailbox without a reporter | Open |
| **T-03** | Message redaction (P0-7) has zero code; messages are stored in plain text | coder | 7 rule classes pass the three-layer assertions in §2.3, with an off switch | Open |
| **T-04** | FTS5 query is not wired; `listMessages` always uses `LIKE` | coder | Trigram query wired with the 1–2 character `LIKE` fallback, measured < 200 ms | Open |
