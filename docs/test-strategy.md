# WorkGremlin Test Strategy

| Item | Content |
| --- | --- |
| Version | **v0.5** (2026-10-21) — rewritten against the three-state workstation model and the current plain-Node test stack |
| Author | tester |
| Product | WorkGremlin — desktop visualization / monitoring app for multi-agent teams |
| Tech baseline | Electron 38 (main / preload) + Vue 3 + Vite + Pinia renderer; Express + `ws` + better-sqlite3 server; SQLite on disk under `~/.workgremlin/` |
| Milestones | coder main numbering **M0–M4**, see §0 |
| Status | Strategy and conventions only. Automated coverage today is **73 plain-Node suites**; sections marked **Planned / Not implemented** are design only and must not be reported as passing |

## Implementation alignment (2026-10-21)

- Commit `e2ad323` ("refactor: simplify workstation state to busy idle blocked") replaced the previous model. A workstation now has exactly three mutually exclusive states: `busy`, `idle`, `blocked`. State is **derived**, never polled: busy comes from a running task, blocked from an explicit per-session authorization wait, idle from the absence of both.
- The liveness machinery is gone. No timer, lease, ping or elapsed time can change a workstation state. The transport-level WebSocket ping and the HTTP polling fallback only keep the connection alive; they are not state signals.
- The repository now has an automated suite: `npm run test:all` runs every `test:*` script serially through `scripts/run-tests.js`; the latest full run on this checkout was **73/73 suites passed in ~58 s**. Suites are plain Node scripts (`server/test/*.test.js`, `renderer/test/*.test.mjs`). There is no Vitest, no Playwright, no browser E2E and no Electron packaging E2E.
- Several features described in earlier versions are still not implemented and are marked as such throughout: the A-route directory watcher (chokidar), message redaction, FTS query wiring, virtual scrolling, system notifications, compact mode, reverse control, and CI pipelines.
- **Retired concepts (explicitly removed, do not reintroduce):** the five-state model, `offline` / `online` / `error` as workstation states, the `degraded` flag, heartbeat timeouts, TTL / lease expiry, `lastSeenAt`, `last_heartbeat_at`, `agent_status_history`, the 5×5 transition matrix and the "10 combinations" display matrix.

### v0.5 change summary

| # | Change | Affected sections |
| --- | --- | --- |
| 1 | State model replaced by **`busy` / `idle` / `blocked`**, derived from tasks and `session_status`; the transition matrix and the illegal-transition rules are deleted | §3.2, §6-M1, Appendix A |
| 2 | All liveness test cases and thresholds removed; time, ping and reconnect are asserted **not** to change state | §3.1, §3.2, §3.11, Appendix A |
| 3 | Test layers rewritten around the real stack (plain Node, serial runner, `ok()` helper, Chinese summary line); Vitest / Playwright listed as planned | §2, §5, §9 |
| 4 | Retention corrected to **N days (default 90)** with no message-count cap; JSONL archive export is planned, not implemented | §3.3, §3.4 |
| 5 | Progress section rewritten: the progress bar is gone; `tasks.progress` is optional report data and the UI does not fabricate a value | §3.10, §7.18 |
| 6 | Notifications: not implemented; the only candidate S1 state is `blocked`, and the trigger must be redesigned before M3 | §3.11, §11 |
| 7 | Unimplemented features marked **Planned**: A-route watcher, redaction, FTS query wiring, virtual scrolling, Electron E2E, compact mode, reverse control | §3.6, §3.9, §3.12–§3.15 |
| 8 | Demo mode corrected: it is a UI action creating an isolated demo project, **not** a `--demo` / `MOCK=1` flag | §3.7 |
| 9 | Added a migration case for the liveness-era SQLite schema (drops `task_id`, `last_heartbeat_at`, `degraded`, `source`, `members.last_seen_at`; rewrites `source='timeout'` to `'watch'`) | §3.4 DB-16 |
| 10 | CI corrected to "local gate today, pipeline planned"; no workflow files exist in the repository | §9 |

> Case IDs (`SC-`, `MS-`, `DB-`, `DS-`, `FW-`, `RT-`, `DEMO-`, `SPIKE-`, `PRG-`, `NOT-`, `SEC-`, `RW-`, `CPT-`, `CTRL-`, `COUNCIL-`) are stable and are referenced from `docs/implementation-status.md` and the release checklist.

---

## 0. Milestone numbering (single main sequence)

| Main ID (coder; use everywhere) | tester v0.1 old ID | Content |
| --- | --- | --- |
| **M0** | M0 | Skeleton + testability baseline + demo project + native-module build |
| **M1** | M1 | Workstation / office state + message integrity + progress honesty |
| **M2** | M2 + M3 | Task records and conversation data + persistence and recovery |
| **M3** | M4 | Packaging and release (three platforms, x64) |
| **M4 (optional)** | M5 | Directory-watch productionization + WSL / clock-jump evaluation |

> The mapping follows `docs/roadmap.md §0`. Case IDs do not change; only the "applicable milestone" column uses the main numbering.

### Platform scope (M0–M3)

- **Supported target:** Linux x64 (development, Ubuntu 22.04/24.04), Windows x64 (10/11), macOS x64 (13+).
- **Not built:** ARM (Apple Silicon / Windows ARM). Packaging scripts must still be architecture-parameterized; no hardcoded arch (DS-14).
- **Not supported (M0–M2):** network drives and WSL scenarios; evaluation is deferred to M4 (FW-09/FW-10).

---

## 1. Objects under test and quality goals

### 1.1 Core surfaces

| Surface | Key behavior | Quality goal |
| --- | --- | --- |
| **Office** (isometric 2.5D canvas) | Nine floors, elevator, resident gremlins at desks, ephemeral ghosts, main-agent console | State **accurate**, updates **fast**, no jitter or frame drops under high event rates |
| **Workstation / Desk cards** | Per member: one of `busy` / `idle` / `blocked`, current task, files touched, artifacts, start or last-active time | Correct state for the **selected session**; no leakage between sessions; missing data never invented |
| **Task records** | Task list, summary, daily Gantt, per-round client / model / tokens / files / result | Nothing lost or duplicated; deterministic ordering; honest empty values |
| **Council** | Fixed-role, multi-round review with a server-computed convergence score | Read-only participants, no office pollution, faithful reporting of failures |

### 1.2 Global quality goals (measurable)

1. **Real-time:** one report → visible card change, P95 ≤ 300 ms on loopback.
2. **Stability:** 1,000 events/s for 60 s (with a 5,000 events/s × 5 s burst) without freeze, white screen, or frame rate below 30 fps.
3. **Correctness:** message loss and duplication are zero; the workstation state is exactly the derivation in §3.2 for every member and session.
4. **Recoverability:** after `kill -9` or a crash, the loss window is ≤ 1 s or ≤ 500 messages, and state is rebuilt from persisted tasks and `session_status`.
5. **Cross-platform:** Windows 10/11 x64, macOS 13+ x64 and Ubuntu 22.04/24.04 x64 behave identically.
6. **Demonstrability:** demo mode needs no real agent, renders both office and records surfaces, and is deterministic under a fixed seed.

### 1.3 Non-goals (this phase)

- Agent intelligence and output quality (leader / researcher / coder / tester) are not tested.
- No multi-machine distributed load testing; only local multi-agent processes.
- No ARM build or verification (M0–M3).
- No full accessibility audit; only keyboard reachability and semantic labels (S3-level).
- Reverse control (Q7: dispatch / interrupt) is not tested before M4 (§3.15).
- No assertion on installer size (Q6: ~100 MB accepted); record the measured value only.
- No claim that unimplemented features pass. Sections that describe planned features are specifications for future work.

---

## 2. Test layers and toolchain

Strategy: **many pure-logic tests + a medium number of route/contract tests + a small number of end-to-end tests + targeted non-functional checks**. The current implementation is deliberately headless-testable: the server is a plain Express app over a temporary SQLite file, and renderer logic that matters for state lives in pure ES modules under `renderer/src/lib/`.

Status legend used in this document:

- **Automated** — covered by an existing suite listed in §2.3.
- **Specified** — behavior exists, but has no dedicated automated case yet.
- **Planned** — the feature or the tooling does not exist; the case is design only.

| Layer | Name | Scope | Current tooling | Runs in | Share target |
| --- | --- | --- | --- | --- | --- |
| L0 | Static and type checks | Syntax, build, security config, packaging config, native ABI | `npm run build` (Vite), `npm run rebuild:native`, ad-hoc `node --check`; **no lint or type-check gate exists today** | Local / CI (planned) | Gate |
| L1 | Unit tests | State derivation, session scoping, message dedupe/order, time formatting, floor parsing, task-shape normalization | **Plain Node scripts** with a local `ok(label, cond)` helper | Node, no UI | ~60% |
| L2 | Component / renderer logic | Three-state badges, per-session task selection, borrowed summon busy, Gantt/time math, i18n coverage, render smoke | **Plain Node ESM scripts** importing `renderer/src/lib/*` and Vue SFC source assertions | Node, no browser | ~25% |
| L3 | Integration / contract | Real Express routes + real SQLite temp DB, hook dispatch, WS envelopes, reconnect, council API | **Plain Node scripts**, temporary `WORKGREMLIN_HOME` | Node, no window | ~10% |
| L4 | Desktop E2E | Real Electron launch, window lifecycle, real IPC, real SQLite, packaging | **Planned** — Playwright `_electron` is not present | xvfb / headed (planned) | ~5% |
| L5 | Non-functional | Latency, long-run memory, platform matrix, sleep/reconnect, watcher robustness, native modules | Manual + Node scripts + planned CI matrix | Local / CI | Gate |

### 2.1 Why L4 is planned rather than implemented

There is no browser automation in the repository today. `renderer/test/renderSmoke.test.mjs` is a **source-level render smoke test**, not an E2E test: it asserts component structure and selector presence without launching Electron. Real E2E arrives with the packaging milestone; when it does, Playwright `_electron` remains the chosen tool because `electronApp.evaluate()` can reach the main process and `firstWindow()` can drive the renderer with the same `data-testid` selectors used by L2/L3.

### 2.2 Architecture and the testability boundary

```text
shared/      protocol source of truth (CJS, zero dependencies, Node + browser)
server/      Express + ws + better-sqlite3; headless, embedded in Electron or standalone
desktop/     Electron main process, preload bridge, window, menu, single-instance lock
renderer/    Vue 3 + Vite + Pinia; pure state/task rules in renderer/src/lib/
packages/    reporter SDK + CLI + hooks (agent side)
```

Rules that keep the suite cheap:

- **State logic is a pure function of rows.** `buildMemberCard` in `server/src/ingest/bus.js` and `memberForSession` in `renderer/src/lib/memberTask.js` can be exercised without a window or a timer.
- **Business code uses the clock abstraction** (`server/src/clock.js`) rather than bare `Date.now()` for timeouts and elapsed-time decisions.
- **Renderer pure modules never import Electron.** `renderer/src/lib/memberTask.js` imports only i18n and the ephemeral helper, so Node can import it directly.
- **No browser is required** for the current 73 suites; that is why `npm run test:all` finishes in about a minute.

### 2.3 Directories and commands (actual)

```text
server/test/       *.test.js    # 57 CJS files (56 wired): routes, db, ingest, hooks, floors, council
renderer/test/     *.test.mjs   # 17 ESM suites: pure renderer logic + render smoke
                                # pluginReply.test.js exists but has no test:* alias, so 73 suites run
scripts/run-tests.js            # serial runner: every test:* script, summary table
scripts/postinstall.js          # electron-rebuild for better-sqlite3
```

```bash
npm run test:all                  # all 73 suites, serial
node scripts/run-tests.js qoder   # run suites whose names contain "qoder"
node scripts/run-tests.js --fail-fast
npm run test:member-task          # a single suite (state/session rules)
npm run test:agent-roster         # borrowed busy for resident gremlins
npm run db:check                  # server CLI self-test: create tables, write, read, checkpoint
```

Suite conventions:

- A suite is a plain script. It prints `✓` / `✗` per assertion and ends with the literal summary line `结果：N 通过 / M 失败`; a non-zero exit code means failure.
- Suites are **serial by design**. Many change `HOME` / `WORKGREMLIN_HOME` or create temp on-disk data, so parallel execution causes unreproducible failures.
- Assertions use `ok(label, condition, extra)`. Labels are English in new suites; legacy Chinese labels are acceptable where the suite already ships them.
- Planned: `tests/unit`, `tests/component`, `tests/integration`, `tests/e2e` with Vitest / Vue Test Utils / Playwright. Do not describe these as existing.

---

## 3. Key test areas

> Suffix meaning: **[M0]** required for that milestone exit; **[M4]** deferred to the optional milestone; no suffix means required within the owning feature milestone.

### 3.1 Real-time behavior

| ID | Case | Assertion | Status |
| --- | --- | --- | --- |
| RT-01 | Single report end-to-end latency | P50 ≤ 120 ms, **P95 ≤ 300 ms**, P99 ≤ 800 ms (loopback, 4 idle members) | Specified |
| RT-02 | Segmented latency | ingest→bus ≤ 30 ms; bus→WS fanout ≤ 50 ms; WS→store ≤ 50 ms; store→paint ≤ 1 frame (16.7 ms, worst 50 ms) | Planned (needs metrics) |
| RT-03 | Sustained load: 1,000 events/s × 60 s | No main-thread task > 50 ms; average frame rate ≥ 50 fps; DOM updates merged per window | Planned |
| RT-04 | Burst: 5,000 events/s × 5 s | No crash or OOM; `member.status` merge window collapses redundant cards; convergence to the latest state ≤ 1 s | Planned |
| RT-05 | No UI jitter | No progress bar exists to jump; task text and badges do not reflow on repeated updates | Specified |
| RT-06 | Auto-refresh throttle | Repeated identical `member.status` payloads do not trigger re-render (shallow compare / card identity) | Specified |
| RT-07 | Background throttling | Unfocused window lowers refresh rate; refocus restores the latest state ≤ 300 ms | Specified |
| RT-08 | Badge update does not remount the card | A state change updates only the badge and task area; the card component instance and its displayed timestamp are preserved | Specified |

**Measurement method:** the ingest request carries its own `ts`; the server records the broadcast time; the renderer records `paintTs` in a `requestAnimationFrame` callback, all on the same `performance.now()` base. E2E reads the built-in histogram once the metrics contract (§7.8) exists.

### 3.2 State correctness — three states: `busy`, `idle`, `blocked`

#### 3.2.1 Model definition

| State | Meaning | Derived from | Visual |
| --- | --- | --- | --- |
| `busy` | Working on a task | At least one task of that member/session has `tasks.state = 'running'` | Blue (`--state-busy`), label `忙碌` |
| `blocked` | Explicitly waiting for authorization | A `session_status` row with `state = 'blocked'` for that session | Orange (`--state-blocked`), label `阻塞` |
| `idle` | Neither of the above | No running task and no blocked row | Green (`--state-idle`), label `空闲` |

There is no fourth state and no orthogonal flag. There is no `offline`, `online`, `error`, `thinking`, `unknown` or `degraded` value. Unknown values arriving from old data or a bad client normalize to `idle` in the renderer (`normalizeState`).

`busy` includes "thinking / waiting for the model" while a task is running: no progress event is required, and the absence of events for any length of time does not end the task.

`blocked` is an **authorization wait only**. The hook layer sets it on `PermissionRequest` or a permission `Notification`, with the conceptual reason `awaiting_permission`. The database row stores only `state_since` / `updated_at`; the reason is not a column and must not be invented by the UI. Waiting for a human reply, a sub-task, or a slow tool is **not** `blocked`.

#### 3.2.2 Derivation rules

Server, `buildMemberCard` (per member):

1. Start with no candidate.
2. Every `session_status` row contributes `blocked` with its `state_since`.
3. A borrowed `agent_status` row contributes `busy` with its `state_since` (resident gremlin only; see §3.2.3).
4. Every running task contributes `busy` with `started_at`.
5. Pick the highest priority: **`blocked` > `busy` > `idle`**. On equal priority, the **earliest `stateSince`** wins.
6. If no candidate exists, the state is `idle`; `stateSince` falls back to `members.created_at`.

Renderer, `memberForSession` (for the selected session):

1. `blocked` for the same session wins over everything.
2. Otherwise a running task for the same session → `busy`.
3. Otherwise a **borrowed summon task** for that session → `busy`.
4. Otherwise `idle`.
5. With no selected session (demo / a floor without an active session), the server card state is shown as-is.

`stateSince` is the reference timestamp for the status line: blocked uses the blocked row's `state_since`, busy uses the task's `started_at`, idle uses the member's creation time. The card renders an absolute `MM-DD HH:mm` (task start when busy, last active when idle), never a fabricated duration. There is no separate "last seen" timestamp.

#### 3.2.3 Scoping and the borrowed-busy exception

- **Blocked is session-scoped.** Its primary key is `(member_id, session_id)`. A blocked row in session B never makes session A blocked, and a member card with several sessions can be blocked in one and busy in another.
- **Tasks are session-scoped.** A running task in session A does not make session B busy. The member card aggregates across sessions for the office overview; the renderer chooses the selected session's task.
- **Pending is not busy.** A task with `state = 'pending'` is work that has not started. Only `running` counts.
- **Borrowed busy is a display state.** A resident gremlin (no session of its own) may borrow `busy` from a same-named ephemeral ghost while that ghost has a running task. `agent_status` is the **only** table that can hold this borrowed `busy` (its `CHECK` constraint allows nothing else). It is not task liveness; the task itself belongs to the ghost.
- **State only changes on data changes.** No timeout, age, ping, reconnect, poll, sleep/wake or server restart changes a state by itself.

#### 3.2.4 Cases

| ID | Case | Assertion | Nearest suite |
| --- | --- | --- | --- |
| **SC-01** | Task start → busy | `POST /api/v1/task/start` creates a `running` task; card `state='busy'`, `stateSince = started_at` | `taskSync`, `taskRunsRoute` |
| **SC-02** | Pending is not busy | A `pending` task without a running task → member `idle`; negative: must not render `busy` or claim a current task | `taskRunsRoute` (shape) |
| **SC-03** | Task end → idle | `POST /api/v1/task/end` with `done` / `failed` / `cancelled` → `idle` when no other running task exists in that session | `taskSync`, `finalStop` |
| **SC-04** | Several running tasks in one session | Member stays `busy` until the **last** running task ends; ending one does not flip the card to idle | `taskSync` |
| **SC-05** | Thinking / waiting for the model stays busy | A task that emits no progress for 10+ minutes is still `running` → `busy`; negative: no timeout-driven `idle` | Specified |
| **SC-06** | Authorization wait → blocked | Permission hook writes a `blocked` row (`awaiting_permission`); card `state='blocked'`, `stateSince` = first blocked timestamp | `hookDispatch` |
| **SC-07** | Blocked does not leak between sessions | Member has session A `blocked` and session B with a running task: A renders `blocked`, B renders `busy`, C renders `idle` | `memberTask` |
| **SC-08** | Blocked is per member as well | Two members with the same name in different projects keep independent blocked rows; no card cross-contamination | Specified |
| **SC-09** | Repeated blocked is idempotent | A second permission event for the same session does not move `stateSince` and emits no duplicate card update | `hookDispatch` |
| **SC-10** | Blocked clears on task progress | `POST /api/v1/task/progress` deletes only that session's blocked row; state falls back to the running task (`busy`) or `idle` | `taskSync` |
| **SC-11** | Blocked clears on task end | `POST /api/v1/task/end` clears the session's blocked row before deriving the new state | `taskSync` |
| **SC-12** | Blocked clears on session end | `SessionEnd` hook clears that session's blocked row; other sessions are untouched | `hookRuntime` |
| **SC-13** | Blocked clears on idle notification | A permission-resolved / idle notification clears the row; the card updates once | `hookDispatch` |
| **SC-14** | Clearing one session leaves the other blocked | Clearing session A keeps session B `blocked`; negative: a global clear is a bug | `memberTask` |
| **SC-15** | Status timestamp comes from `stateSince` / task start | Busy card shows the absolute task start (`MM-DD HH:mm`); idle card shows the absolute last-active time (`—` when absent); no fabricated duration | `memberTask` |
| **SC-16** | Age never changes state | A 6-hour running task is still `busy`; a 6-hour blocked row is still `blocked`; no sweep, no lease, no expiry | Specified |
| **SC-17** | WS ping / reconnect does not change state | Drop the socket, let the ping timeout fire, reconnect, fall back to polling: only `connection` events change; `state` and `stateSince` are stable | `wsReconnect` |
| **SC-18** | Server restart preserves derived state | Restart with the same DB: running tasks still yield `busy`, blocked rows still yield `blocked`, finished tasks yield `idle`; no synthetic transition event | `taskRecover` |
| **SC-19** | Borrowed busy for a resident gremlin | A resident gremlin with a same-named ghost working in the same session renders `busy`; in the borrowed case its own card carries no task row | `agentRoster`, `memberTask` |
| **SC-20** | Borrowed busy is display-only and scoped | Ghost finishing clears borrowed busy; another session does not borrow it; resident's own task wins over a borrowed one; idle resident does not borrow | `agentRoster`, `memberTask` |
| **SC-21** | Last active = latest task start/end | `lastTaskAt` = max over the member's tasks; `lastTaskAtBySession` is per session; no task → `null`, UI shows `—` | `memberTask` |
| **SC-22** | Vanished sessions are reconciled | `pruneSessionStatuses` closes running tasks of removed sessions as `cancelled`, removes their blocked rows, broadcasts one card | `sessionCompact`, floor suites |
| **SC-23** | Multi-member isolation | 16 members with mixed states update concurrently; each card keeps its own state and timestamp | Specified |
| **SC-24** | Legacy / unknown state strings normalize | `online`, `paused`, `weird` all render as `idle`; label, tone and test id agree | `memberTask` |
| **SC-25** | Missing task title is not invented | Empty title renders `(未命名任务)` (records) or the idle label on a card; never the previous task's title | `doneShape` |
| **SC-26** | Missing data is shown as missing | No progress percentage, no file, no artifact → `—` / "no file"; negative: no `0%`, no fabricated filename | `memberTask` |
| **SC-27** | Update merge window | Several reports within 200 ms produce one `member.status` carrying the final card, not a burst of intermediate states | Specified |
| **SC-28** | Repeated progress does not move `stateSince` | Progress on the same running task keeps `stateSince = started_at`; no state churn | `taskSync` |
| **SC-29** | Selected session chooses the task | `currentTaskOf` returns the running task of the requested session; an unknown session returns none; no session returns the newest (demo path) | `memberTask` |
| **SC-30** | Per-session renderer precedence | `blocked` beats a running task in the same session; a running task beats a borrowed summon; otherwise idle | `memberTask` |
| **SC-31** | Three states are distinguishable without color | Label + shape/icon + text all differ; color is not the only channel | Specified |
| **SC-32** | No fourth state exists in the contract | `AGENT_STATES` is exactly `['busy','idle','blocked']`; no code path writes another value | `agentRoster` |

"Nearest suite" names the suite that covers at least the core of the case. `Specified` means the behavior exists but has no dedicated automated case yet; add one before the milestone exit.

#### 3.2.5 Explicitly removed behavior (do not test as a feature)

The following were deleted with the old model. A test that exercises them is a bug in the test:

- Transition matrices between five states and "illegal transition" correction rules.
- Liveness timeout constants (`HEARTBEAT_INTERVAL`, `HEARTBEAT_TIMEOUT`, `A_SILENT_TIMEOUT`, `BLOCK_GRACE`, `ERROR_WINDOW`, `CLOCK_SKEW_TOL`) and their boundary sampling.
- The `degraded` flag (D1–D5), the "9 visible combinations + 1 normalized" display matrix, and degraded-specific visual assertions.
- "Offline after N seconds" and "task still running after ping loss → degraded" cases.
- `agent_status_history` replay and synthetic intermediate states.

### 3.3 Message integrity

Current reality: messages are stored in SQLite with a `dedupe_key`; ordering is `ts_ms` with `id` as a deterministic tiebreaker. The FTS5 trigram table and triggers exist, but the query layer still uses `LIKE`. There is **no virtual scrolling** and no client-side streaming message reassembly yet.

**Message retention and archival are not implemented.** The only automatic cleanup is **task-record retention** (§3.4): deleting a task record older than the configured number of days also deletes the messages, artifacts and tool-usage rows tied to that task id. There is no message-count cap and no JSONL export; `archived_at` exists but is never populated.

| ID | Case | Assertion | Status |
| --- | --- | --- | --- |
| MS-01 | No loss | Inject 10,000 unique messages; count of unique `msgId` = 10,000 | Specified |
| MS-02 | No duplication | The same `dedupe_key` delivered 3 times (including across reconnect) yields 1 row; unique index holds | Automated (`pluginIngest`) |
| MS-03 | Out-of-order timeline | Within a ±5 s window, sort by `occurredAt`; equal timestamps break ties by message id, so repeated runs are identical | Specified |
| MS-04 | Streaming message | Token merge and a terminal `stream_end`; a missing terminal event must not leave a permanent "typing" state | Planned |
| MS-05 | 100k virtual scrolling | DOM ≤ 80 nodes, first render ≤ 500 ms, ≥ 55 fps, memory delta ≤ 200 MB | **Planned** — no virtual list exists |
| MS-06 | Auto-follow | At the bottom, new messages scroll into view; after the user scrolls up, follow pauses and a jump control appears; returning to the bottom resumes | Specified |
| MS-07 | Filter by member | Single / multiple / all members produce the exact set difference expected | Automated (`taskFilter`, `projectScope`) |
| MS-08 | Filter by time | Boundary semantics are documented (half-open recommended); UTC storage, local display | Automated (`timeRange`) |
| MS-09 | Keyword search | Matches content / sender / recipient, case-insensitive; regex metacharacters do not throw; Chinese substring works; 100k messages ≤ 300 ms | Specified (LIKE path) |
| MS-10 | Filter + search + live insert | A new message enters the current filtered view without destroying the scroll position | Specified |
| MS-11 | 1 MB single message | Renders without freezing; collapse/truncate with a copy path; no storage cap today | Planned |
| MS-12 | Legacy message schema | An old row renders or is clearly marked "unrecognized type"; no crash | Specified |
| MS-13 | Messages follow their task record | When task-record retention deletes a task, its messages disappear with it by task id; this targeted cascade is expected, not message loss | Automated (`retention` partial) |
| MS-14 | Retained messages are untouched | A message whose task is newer than the cutoff survives the sweep; the sweep never deletes unrelated messages | Specified |
| MS-15 | No message archive | `messages.archived_at` stays `NULL`; there is no "archived N messages" notice or export. Negative: do not claim an archive exists | Specified |
| MS-16 | 64 KB truncation | `content_truncated` column exists; no truncation logic is implemented yet. When added: boundary 65536 / 65537 and search must not match the removed tail | **Planned** (column only) |

> Task-record retention is destructive and uses wall-clock time. Tests must create rows relative to the real `Date.now()`, never a fixed absolute timestamp.

### 3.4 Persistence and crash recovery (SQLite)

Current reality: WAL, `secure_delete = ON`, `synchronous = NORMAL`, one writer connection, automatic retention cleanup, schema migration in `server/src/db/index.js`, single-instance lock in the Electron main process.

| ID | Case | Assertion |
| --- | --- | --- |
| DB-01 | Basic read/write | WAL enabled; batch writes in a transaction; reads do not block writes |
| DB-02 | Schema migration | Migrations are idempotent, forward-only, and preserve data; a failed migration aborts, it does not half-apply |
| DB-03 | `kill -9` | After restart, loss ≤ 1 s or ≤ 500 messages; `PRAGMA integrity_check` = ok |
| DB-04 | Renderer crash | Main process survives, recreates the window, state restored from DB ≤ 2 s |
| DB-05 | Main-process crash | Cold start rebuilds a consistent state from tables; no half-written row |
| DB-06 | Disk full / read-only | Clear error, no corruption; recovery after space is freed |
| DB-07 | Multiple instances | Single-instance lock; the second launch focuses the existing window instead of opening a second writer |
| DB-08 | Task-record retention | Default 90 days (clamp 1–3650); a settings change cleans immediately; a daily sweep follows; deleting a top-level task removes its child tasks, messages, artifacts, tool usage and subagent rows, while newer records stay intact |
| DB-09 | Concurrent read/write | High-frequency writes do not block UI queries beyond the latency budget |
| DB-10 | State recovery consistency | After restart, the card state equals the derivation from `tasks` + `session_status`; no replay of a liveness signal is required |
| DB-11 | Archive fields present | `messages.archived_at` column and index exist; `content_truncated` exists; new rows default to `NULL` / `0` |
| DB-12 | Archive export | **Planned** — a future archive path that exports JSONL before deletion, importable and count-verified. It does not exist today; current retention deletes task records without an export |
| DB-13 | `secure_delete` / WAL checkpoint cost | At 1,000 events/s, throughput ≥ 1,000 events/s and P95 ≤ 300 ms; record the comparison with `secure_delete=OFF` and `ON + checkpoint(TRUNCATE)`. If P95 degrades by > 20%, escalate |
| DB-14 | Dual-connection contingency | **Not implemented.** If adopted: writer with `secure_delete=OFF`, delete path with `ON + TRUNCATE`, no deadlock, no lost write |
| DB-15 | Reverse validation of security assertions | Deliberately disable a protection and confirm the assertion **fails**; an assertion that passes with the protection off has no detection power |
| **DB-16** | **Liveness-era schema migration** | A legacy DB with `agent_status` / `session_status` columns `task_id`, `last_heartbeat_at`, `degraded`, `source` and `members.last_seen_at` migrates in place: those columns are dropped, `agent_status` keeps only borrowed `busy`, `session_status` keeps only `blocked`, `projects.source='timeout'` becomes `'watch'`, and members / tasks / messages survive |
| DB-17 | Project attribution | Reports resolve the project from `workspacePath` first, then fall back to the request's `project`; two agents in different directories never write into the same project by accident |
| DB-18 | Identity normalization | `client` is the floor base name (`codebuddy`, `kilo`, `opencode`, `claude`, …); `form` is `vscode` / `cli` / `ide` or `null`; `agentBase` strips only `@project` and lowercases; `isPluginClient(form)` and `formToSource(form)` are the only source of plugin/cli/ide |

### 3.5 Desktop-specific behavior

| ID | Case | Assertion | Status |
| --- | --- | --- | --- |
| DS-01 | Cold start | First window visible ≤ 3 s (warm) / ≤ 5 s (cold) | Specified |
| DS-02 | Install | Silent install on all three platforms; first launch succeeds | Planned (packaging) |
| DS-03 | Upgrade | Config, DB, window position preserved; migration succeeds; rollback path exists | Planned |
| DS-04 | Code signing / notarization | macOS notarization or documented ad-hoc path; Windows SmartScreen behavior recorded | Planned |
| DS-05 | Cross-platform consistency | Same L4 suite on all platforms; path separators, watcher backend, tray, menu, shortcuts differ correctly | Planned |
| DS-06 | Architecture scope | x64 only; `--arch` accepted without error; no ARM artifact | Planned |
| DS-07 | Focus / minimize | Background throttling (RT-07); refocus syncs immediately | Specified |
| DS-08 | Sleep / lock screen | After 30 min sleep, reconnect ≤ 5 s with backoff and jitter; missed messages backfill without duplicates; workstation state does not change just because time passed | Automated (`wsReconnect` partial) |
| DS-09 | Network switch | 60 s without network → reconnect; the UI distinguishes disconnected / reconnecting / connected; no silent failure | Automated (`wsReconnect`) |
| DS-10 | Multi-monitor / DPI | 150% / 200% scaling keeps layout intact; window position remembered per display | Specified |
| DS-11 | High contrast / dark mode | Readable after theme switch (contrast ≥ 4.5:1) | Specified |
| DS-12 | Security configuration | `contextIsolation: true`, `nodeIntegration: false`, restricted preload bridge; `webSecurity` is not disabled | Specified |
| DS-13 | Uninstall | User-data policy documented; reinstall is not blocked by leftovers | Planned |
| DS-14 | No hardcoded architecture | Packaging config, CI and scripts must not contain literal `x64` / `ia32` / `arm64` / `universal`; arch comes from CLI/env. `electron-builder.yml` passes `--x64` today; a static check script is **planned** | Specified |
| DS-15 | Package size | Not a gate; record measured size in release notes; > 200 MB raises an S4 note | Planned |

### 3.6 Data-source robustness (floors, hooks, watchers)

**Status of the A-route watcher:** not implemented. There is no chokidar-based directory watcher. Data arrives through three paths:

1. **Hooks** (`/api/v1/hook`) — authoritative for task start/end, permission waits, session end.
2. **Floor readers** (`server/src/floor*.js`, `server/src/sessions.js`) — poll product data directories and parse session/transcript files. File mtimes and idle windows describe a **session's** activity phase; they are not a workstation state.
3. **Subagent manifest** (`.workgremlin/subagents.json`) — polled plus `fs.watch`, debounced.

The old "poll as a fallback" path, which also set a separate trust flag, does not exist. Polling is the normal path for floor scanners and never changes a workstation state.

| ID | Case | Assertion |
| --- | --- | --- |
| FW-01 | Partial write | A half-written JSON/JSONL file is skipped; the last good state is kept and retried; no dirty state, no crash |
| FW-02 | Atomic write | Producer writes tmp then renames; the reader sees either the old or the new complete file |
| FW-03 | Directory removed | `ENOENT` → no crash; scanner backs off (1→2→4→…→30 s with jitter); existing workstation state is untouched |
| FW-04 | Directory recreated | Next poll picks the directory up; changes during the gap are reconciled |
| FW-05 | Permission change | `EACCES` / `EPERM` skips the file, keeps other products working; recovery is automatic |
| FW-06 | Many files / deep trees | 10,000 files do not cause `EMFILE`; the first paint is not blocked by the scan |
| FW-07 | Event flood | 10,000 changes in 1 s are coalesced (50–100 ms trailing window injectable); CPU stays bounded; the manifest watcher does not emit per-file cards |
| FW-08 | Poll cadence | The scanner interval is configurable; a long interval does not make a working task idle — tasks end only on an explicit end / cancel / session reconciliation |
| FW-09 | Network drive **[M4]** | NFS/SMB behavior evaluated; no support claim before M4 |
| FW-10 | WSL **[M4]** | WSL1/2 path and watch semantics evaluated; not in M0–M2 exit |
| FW-11 | Symlinks / case conflicts | Symlink loops terminate; case-insensitive filesystems normalize to one path |
| FW-12 | Long paths / special characters | Spaces, Chinese, emoji and Windows paths > 260 chars parse without failure |
| FW-13 | Resource leak | Switching watched directories 100 times does not grow handles (`lsof` count) |
| FW-14 | Coexistence with hooks | The same task reported by hook and discovered by a floor scan does not create two tasks; superseded rounds are closed exactly once |
| FW-15 | Sleep / clock jump | After a suspend or a clock jump, the next poll runs immediately; no phantom disconnection, no mass task cancellation, no state change from elapsed time |

### 3.7 Demo mode

Demo mode is a **UI action**, not a CLI flag. The HUD "演示模式" button calls `POST /api/v1/demo/session {floor}`; the server returns a normal snapshot for the virtual project `__demo__` and session `__demo__:session`, built entirely in memory. The renderer injects that session into the ordinary floor/session table, merges it back after every `/sessions` refresh, and polls `GET /api/v1/demo/session` for the server-owned phase / member state. Switching floors or selecting a real session exits; there is no demo row in any office table.

| ID | Case | Assertion |
| --- | --- | --- |
| DEMO-01 | Single entry point | Demo starts only from the HUD action / `POST /api/v1/demo/session`. Negative: empty / `'demo'` workspace paths are rejected, and there is no `--demo`, `MOCK=1` or `WORKGREMLIN_DEMO=1` startup switch |
| DEMO-02 | Zero external dependencies | No real agent, network or watched directory is required; office and cards render within 3 s |
| DEMO-03 | Deterministic content / live phase | Roster, tasks and 220 messages come from static demo data; the phase timeline is owned by the server provider. A browser poll must not invent a phase locally |
| DEMO-04 | Isolation | Starting demo writes zero rows to `projects` / `members` / `tasks` / `messages` / `task_runs`; `GET /snapshot` remains the real project; the renderer keeps the real project / members / task records / conversation in the project store, with only the office views reading the demo member list; exit restores the previous session |
| DEMO-05 | Same components | Demo member cards carry the normal project / client / session fields, so the ordinary floor + session filters, workstation cards and sprites are used without demo branches |
| DEMO-06 | Coverage | Demo data covers `busy` / `idle` / `blocked`, includes ephemeral ghosts, and ≥ 200 messages |
| DEMO-07 | Clear labeling / lifecycle | The dropdown shows a normal translated `演示工程 · 演示会话` entry; the ticker adds one frontend-only `HH:mm floor 演示会话(phase)` line; switching floors or selecting a real session exits; a `/sessions` refresh cannot evict the virtual session; a server restart (404) exits cleanly |
| DEMO-08 | Real tasks untouched | `/task-feed` and real task rows remain unchanged; demo adds no task record and no ended-task ticker announcement |

### 3.8 Native-module build verification (electron-rebuild / better-sqlite3) — M0 highest risk

> **Hard constraint:** on failure, do **not** silently fall back to `node:sqlite`, `sql.js` or an in-memory store. Any fallback requires written leader approval and a matching update to §3.4 and the persistence design.

#### 3.8.1 Verification matrix

| # | Platform | Arch | Target Electron | Milestone | Priority |
| --- | --- | --- | --- | --- | --- |
| N1 | **Linux x64** (Ubuntu 22.04 / 24.04, dev machine) | x64 | version pinned by `package.json` | **M0 exit** | P0 |
| N2 | Windows x64 (10/11) | x64 | same as N1 | **M3 matrix** (early smoke in M1 recommended) | P1 |
| N3 | macOS x64 (13+) | x64 | same as N1 | **M3 matrix** (early smoke in M1 recommended) | P1 |

> ARM is out of scope (§0). Extending the matrix later does not change the process.

#### 3.8.2 Commands (actual scripts)

```bash
# 1) Baseline
node -v && npx electron --version

# 2) Rebuild better-sqlite3 against the installed Electron ABI
npm run rebuild:native          # scripts/postinstall.js -> electron-rebuild -w better-sqlite3 -v <electron>

# 3) Verify inside Electron, not plain Node
node -e "console.log(process.versions.modules)"      # ABI
#   in the Electron main process: require('better-sqlite3') succeeds and new Database() works

# 4) Packaged artifact (asar scenario); arch comes from the CLI, not the config
npm run build
npx electron-builder --linux AppImage --x64

# 5) Storage smoke test
npm run db:check                # create tables / write 10k / read back / integrity_check
```

#### 3.8.3 Success criteria (all required)

1. `require('better-sqlite3')` succeeds **in the packaged Electron main process**, not only in Node.
2. `process.versions.modules` matches the compiled target; no "compiled against a different Node.js version" error.
3. Storage smoke passes: create → write 10,000 → read back the same count → `PRAGMA integrity_check` = ok.
4. The `electron-builder --dir` artifact starts with a usable DB (`asarUnpack` correctly unpacks `.node`).
5. No error-level native-module log on cold start; DB-01 passes in both L3 and L4 contexts.

#### 3.8.4 Failure escalation (in order; do not skip to a fallback)

| Step | Action | Note |
| --- | --- | --- |
| 1 | `npm run rebuild:native` | Most failures are an ABI mismatch |
| 2 | Retry with a `prebuild-install` mirror; `--build-from-source` as a fallback | Common on CI networks |
| 3 | Align `better-sqlite3` with a version that supports the Electron major | Record the constraint in `package.json` |
| 4 | Pin the Node / Electron pair in CI and `.nvmrc` | Prevent drift |
| 5 | **Escalate to leader for written approval** before `node:sqlite` or `sql.js` | Silent fallback is forbidden; approval implies updating §3.4 |

#### 3.8.5 Gates

- `npm run rebuild:native` must exit 0 after install; `WORKGREMLIN_SKIP_REBUILD=1` is an explicit, reported exception, not a silent pass.
- `npm run db:check` is the current storage gate.
- **Planned:** a `native:check` script that requires native modules inside the Electron main process and prints ABI/versions, and a `check:arch-param` static script. Neither exists today; do not report them as green.

### 3.9 Spikes

#### 3.9.1 Round A — 100k-message virtual list (**M1 kickoff; not implemented**)

**Purpose:** choose a virtual-list approach before the record view grows. There is no virtual list today; `MessageList.vue` renders every row.

| ID | Minimal case | Gate |
| --- | --- | --- |
| SPIKE-01 | First render of 100k rows | ≤ 500 ms |
| SPIKE-02 | Continuous scrolling | avg ≥ 55 fps, min ≥ 40 fps |
| SPIKE-03 | DOM node count | ≤ 80 (visible + buffer) |
| SPIKE-04 | Memory delta | ≤ 200 MB; no growth after 5 min of scrolling |
| SPIKE-05 | Live append (100/s at the tail) | ≥ 50 fps; auto-follow correct |
| SPIKE-06 | Keyword search over 100k | ≤ 300 ms |
| SPIKE-07 | Filter switch (member / time) | ≤ 200 ms; scroll position and view correct |
| SPIKE-08 | 1 MB single message | No freeze; collapse/truncate works (MS-11) |

**Deliverables:** fixed vs variable row height, library vs custom, recycling/buffer policy; baseline numbers for CI comparison (20% regression warns); updated MS-05 thresholds if a gate is not met.

#### 3.9.2 Round B — Chinese FTS5 tokenization (**M2 kickoff; partially available**)

**Status:** the messages table has an FTS5 trigram table and triggers. **The query layer still uses `LIKE`**, and the tokenizer is not configurable. Cases below are design; only the raw FTS table can be measured today.

| ID | Option | Gate (Chinese corpus, 100k) |
| --- | --- | --- |
| SPIKE-09 | FTS5 `unicode61` + custom bigram | < 200 ms; recall ≥ 95% for 2+ character Chinese terms |
| SPIKE-10 | FTS5 `trigram` | < 200 ms; recall ≥ 95%; record index size |
| SPIKE-11 | `LIKE '%kw%'` fallback | Measure; baseline if A/B fail |
| SPIKE-12 | Index maintenance cost | Build ≤ 30 s for 100k; 100 appends/s do not block writes; index growth ≤ 50% of DB |

Interactions that decide the M2 search contract:

- **Redaction × search:** a credential's plaintext must return 0 hits (SEC-12). When redaction lands, the UI must say "some content is redacted and may not be searchable" rather than returning a silent empty result.
- **Ordering:** FTS hits still obey MS-03's deterministic timeline.
- **Case / width:** Chinese keywords ignore full-width/half-width differences; English is case-insensitive.

**Deliverables:** chosen option (A/B/C), measured Chinese latency and recall, index size/build time; update MS-09 from "≤ 300 ms" to the measured contract.

### 3.10 Progress display (honest, optional data)

**Current reality:** the progress bar was removed from the workstation card, the office monitor and the task-detail row on 2026-09-29. Observed `tasks.progress` values across the local store were only `0` (start) and `1` (finish), so any bar showed a fake empty/full state. The server still accepts `progress` (0..1) from `/api/v1/task/progress` and stores it; at task end it defaults the stored value to `1` when the caller omits it.

`ProgressBar.vue` still exists and renders a missing value as the `progress.unknown` label (`进度未知（未上报）`), but it is not mounted on any card. Restoring it requires a real per-round progress source, which does not exist.

There is **no** `progress_source` field, no `reported | derived | unknown` tri-state, no subtask-derived percentage, and no "unknown" animation on a card. Progress never changes a workstation state; a progress event only clears that session's blocked row.

The app-wide rule for unavailable data is `—` or an explicit "unreported" label (tokens `—`, last active `—`, files `未上报文件`), never `0`. The unused `ProgressBar` follows the same rule with its `progress.unknown` label.

| ID | Case | Assertion |
| --- | --- | --- |
| PRG-01 | No fabricated bar | Workstation card, office monitor and task detail contain **no progress bar and no visible task-percentage text** for a running task (Gantt position styles are not progress) |
| PRG-02 | Missing progress is not zero | A task with `progress = null` never renders `0%`; where `ProgressBar` is used in a harness, null renders the `progress.unknown` label (`进度未知（未上报）`), not a number |
| PRG-03 | Real zero is preserved | A reported `0` stays `0` in the API and record data; it is not replaced by 100 and not dropped |
| PRG-04 | Real value round-trips | `POST /api/v1/task/progress {progress:0.42}` returns `progress=0.42` from `/task-runs`; the UI does not invent a different number |
| PRG-05 | Progress does not create busy | A progress event for an unknown task id does not create a task and does not make the member busy; on a running task it keeps `busy` and clears that session's blocked row |
| PRG-06 | Completion is not a bar | Ending a task is conveyed by task state and end time, not by a bar reaching 100%; the stored default of 1 at end must not be rendered as a visual percentage |
| PRG-07 | No derivation | No percentage is computed from subtasks, file counts or elapsed time |
| PRG-08 | No backfill | A later `null` does not resurrect an earlier value; a missing value stays missing end-to-end |

**Testability requirement:** when real progress returns, the value must be a structured object `{ value: number|null }` (and, if sources return, a `source` field). A bare number cannot distinguish "really 0%" from "unknown".

### 3.11 Notifications

**Status: not implemented.** There is no `Notifier` interface, no system-notification bridge and no notification settings. Nothing in this section may be reported as passing.

The former trigger (`blocked` / `error` / `offline > 60 s`) is void because two of those states no longer exist. With three states, the **only candidate S1 state is `blocked`**. Whether a notification fires on entry, after a duration, at most once per row, or per session is a product decision that must be made before M3. Until then, NOT-01 is blocked on that decision; NOT-02..NOT-15 are specifications for the implementation.

| ID | Case | Assertion |
| --- | --- | --- |
| NOT-01 | **Candidate S1 trigger** | **Planned / trigger not yet defined** — entering `blocked` is the only candidate. `error` and `offline` were removed as workstation states; a test that asserts them is invalid |
| NOT-02 | Lower-priority events do not notify | Notification count = 0 for: `idle`↔`busy` changes, task start/end, new messages, progress updates, blocked clearing, WS reconnect, session switch. Assert each independently |
| NOT-03 | No duration-based state trigger | The old "offline after 60 s" trigger was removed with the state; waiting any number of minutes does not change current state, so no such notification can exist. A blocked-duration trigger, if adopted, must be defined by product |
| NOT-04 | Defaults | Fresh data directory: system notifications **on**, sound **off**; defaults are readable in settings, not only visible in UI |
| NOT-05 | Content | Member name, event type, local time; no sensitive value (see SEC-13) |
| NOT-06 | Do-not-disturb active | S1 events inside the window do not pop |
| NOT-07 | DND midnight boundary | 21:59:59 pops, 22:00:00 does not, 07:59:59 does not, 08:00:00 pops; a cross-midnight window is not parsed as an inverted range |
| NOT-08 | DND time zone | Window follows local time; switching from UTC+8 to UTC−5 keeps the boundary correct |
| NOT-09 | DND sleep/wake | Sleeping during the window and waking after it does not replay missed popups |
| NOT-10 | No replay after DND | Events are recorded in the log and unread count; after the window they appear in the UI only, never as retroactive popups |
| NOT-11 | Per-member mute | A muted member's S1 event produces no notification, but the office state still refreshes (notification and state are decoupled) |
| NOT-12 | Mute × DND | A muted member stays silent outside DND; unmuting restores; mute persists across restart |
| NOT-13 | Flood control | Many S1 events in a short window are aggregated; no notification storm |
| NOT-14 | Permission denied | OS notification permission denied → in-app notice with guidance; no crash, no repeated permission prompts |
| NOT-15 | No removed-state assertions | A test must fail if it references `error` / `offline` / `degraded` notification triggers; three-state vocabulary only |

**Rate-limit proposal (for the future implementation)**

| Dimension | Proposed value | Rationale |
| --- | --- | --- |
| Same member + same event type | At most 1 per 60 s (aggregate window 60 s) | Avoids repeated alerts for one persistent wait |
| Global | At most 5 per 60 s; excess merged | Single aggregate message |
| Burst | > 20 S1 events in 60 s → 1 summary + HUD badge | Prevents a storm when many sessions block at once |
| Recovery | No "recovered" notification when blocked clears | UI state change is enough; optional setting later |

### 3.12 Message redaction (Q5, P0 security baseline)

**Status: not implemented.** No redactor exists, no message is rewritten before insert, and the three-layer verification below has never run. Until a `Redactor` module exists, SEC-01..SEC-17 are design requirements. Do not claim "plaintext never lands on disk" as a current property.

**Hard constraint for the future implementation:** plaintext credentials must not appear in the database file, indexes, FTS shadow tables, WAL, archive JSONL or logs.

#### 3.12.1 Three-layer verification (all required)

| Layer | Method | Assertion |
| --- | --- | --- |
| L1 API | Read the message back through the repository | `content` contains a mask (e.g. `sk-***MASKED***`) and `redacted: true` |
| L2 SQLite | Bypass the app; `SELECT` every table, index and FTS shadow table (`*_content`, `*_data`, `*_idx`, `*_docsize`) | 0 plaintext hits |
| L3 Binary | `cat` / `strings` / `grep -a` on `.db`, `-wal`, `-shm`, backups, archive JSONL | 0 plaintext hits |

L3 pitfalls:

- SQLite may leave deleted/updated bytes in **freelist** pages → `PRAGMA secure_delete = ON` (already set) and re-check after `VACUUM`.
- The WAL may hold uncheckpointed plaintext → scan the WAL **before** checkpoint, then scan the main DB after `wal_checkpoint(TRUNCATE)`.
- Archive export (DB-12) and debug logs are part of the scan surface.
- Temporary in-memory caches and crash reports must not print plaintext.

#### 3.12.2 Seven rule classes

Each class needs **at least 2 positive cases + boundary cases**: one character short, case change, line wrap, inside a code fence, inside a JSON-escaped string.

| ID | Class | Positive / boundary notes |
| --- | --- | --- |
| SEC-01 | `sk-` prefix key (OpenAI-style) | Standard length hits; one character short does not; `SK-` uppercase hits; inside a code fence hits; JSON escape hits; line-wrapped token not missed |
| SEC-02 | `AKIA` (AWS access key ID) | Standard 20 chars hits; 19 does not; lowercase `akia` decision must be explicit; URL query hits |
| SEC-03 | `ghp_` (GitHub token) | Standard 36 chars hits; one-char boundary; correct truncation before Chinese / newline / quote |
| SEC-04 | JWT (`eyJ...`) | Three segments hit; **two segments do not**; wrapped JWT hits; > 2 KB JWT does not hang |
| SEC-05 | PEM `PRIVATE KEY` block | Whole block hits; **multi-line PEM must be masked as a block**, not only the first line; missing header must not leave the body |
| SEC-06 | Key-value `password` / `token` / `secret` / `api_key` | `password: "x"`, `"token"="x"`, `apiKey=x`, `PASSWORD=` hit; `passwords`, `tokenizer`, `secretary` must not be harmed; empty value behavior defined |
| SEC-07 | Credentials in URL (`https://user:pass@host`) | Hits; credential-free URL untouched; IPv6, port and IDN handled |

#### 3.12.3 False-positive baseline and switch

| ID | Case | Assertion |
| --- | --- | --- |
| SEC-08 | False-positive rate | Fixed 200-item clean corpus (source, logs, Markdown, Base64, UUID, paths, SQL, CI output); rate = rewritten / 200; **≤ 0.5% (≤ 1 item)**; above that is S2 |
| SEC-09 | Reproducible corpus | Clean samples live in `tests/fixtures/redaction/clean-*.txt` (planned path) and run on every rule change |
| SEC-10 | Disable switch | Config / `--no-redact`: on (default) redacts; off stores plaintext with a visible warning; both directions tested |
| SEC-11 | Archive and export | Archive JSONL, metrics export and log export contain no plaintext |
| SEC-12 | Search interaction | Searching the plaintext returns 0 hits; the UI says "some content is redacted and may not be searchable"; the FTS index stores only redacted content |
| SEC-13 | Notifications | Title and body never contain pre-redaction text |
| SEC-14 | Logs and diagnostics | Debug/trace logs, crash reports and metrics labels contain no plaintext; scan `--export-metrics` output |
| SEC-15 | Performance | 10k credential-bearing messages add ≤ 30% to write time; a 1 MB message redacts in ≤ 50 ms |
| SEC-16 | Ordering and dedupe | Redaction happens after uniqueness is decided (or is independent of it): `msgId`, order and dedupe are unchanged |
| SEC-17 | Mask stability | The same input always produces the same mask; the mask keeps a type hint (e.g. `[REDACTED:OPENAI_KEY]`) |

> **Priority when implementation starts:** SEC-01..07, SEC-12 and the L1–L3 verification are M1 hard blockers (P0); the rest are P1.

### 3.13 Read/write distinction (Q1)

Current reality: `/api/v1/file/touch` records `op: 'read' | 'write'`; task detail maps `write` to "added". Workstation cards show a flat `currentFiles` list (paths only), taken from the selected task. There is no per-file read/write icon on the card today.

| ID | Case | Assertion |
| --- | --- | --- |
| RW-01 | Read/write distinction in records | Task detail shows write vs read with a non-color channel (icon + label / text), testable via `data-op` if a per-file selector is added |
| RW-02 | Same file read then written | The record reflects the later write; no stale "read only" entry |
| RW-03 | Concurrent read and write | Displayed as "read + write" or by last event; semantics documented and no flicker |
| RW-04 | Path normalization | `./a.ts`, `a.ts`, `/abs/a.ts`, symlinks and case variants collapse to one entry |
| RW-05 | High-frequency debounce | Rapid file events do not churn the card (200 ms window suggested) |
| RW-06 | List length | More than N (suggested 5) files collapse to "+M files", expandable; no layout break |
| RW-07 | Missing data | No file info shows `未上报文件` / no tile, never a fabricated filename or the previous task's file |
| RW-08 | Long path / special characters | Spaces, Chinese, emoji and long paths use middle ellipsis with a full-path tooltip |

### 3.14 Compact mode (Q3)

**Status: not implemented.** There is no threshold, no automatic switch and no density setting. The cases below are a specification for when it is built; the suggested threshold (more than 8 members) is unconfirmed.

| ID | Case | Assertion |
| --- | --- | --- |
| CPT-01 | Threshold boundary | 8 members do not switch, 9 do (configurable); one sample on each side |
| CPT-02 | Manual override | Manual toggle overrides auto and persists across restart |
| CPT-03 | No loss of key information | State, current task, timestamp remain visible in compact mode (collapsible / tooltip); not avatar-only |
| CPT-04 | Trigger dimension | Confirm member count vs available width; if width, add resize breakpoint tests (**open question**) |
| CPT-05 | Large layout | 64 members do not overlap or break; scrolling ≥ 50 fps |
| CPT-06 | No remount | Auto/manual switches do not recreate cards; badges and timestamps are preserved |

### 3.15 Reverse control (Q7: dispatch / interrupt) — **M4, not tested before**

Scope: dispatch a task and interrupt a run; each action requires confirmation and an event-log entry. **Status: not implemented.**

| ID | Case | Assertion |
| --- | --- | --- |
| CTRL-01 | Confirmation required | Both actions open a confirmation with target member and action summary |
| CTRL-02 | Cancel does nothing | Cancel / Esc sends no command (fake source asserts nothing was emitted) |
| CTRL-03 | State after interrupt | After a successful interrupt the target follows the three-state derivation: running task ends → `idle` (or `blocked` if a blocked row remains); negative: never invent a fourth state |
| CTRL-04 | Event log | Operator, time (UTC + local), target, action, confirmation result, execution result; auditable and replayable |
| CTRL-05 | Unavailable target | A member with no live session / no workstation cannot be targeted; the action is disabled or requires extra confirmation |
| CTRL-06 | No side effects | Double clicks do not send duplicate commands; failure gives clear feedback and does not fake a local state change |

The Council (§3.16) is out of scope here: it never sends commands to a monitored session; participants are one-shot processes started by the server and have their own `COUNCIL-*` cases.

### 3.16 Council (`COUNCIL-*`)

Scope and capability boundary: `requirements.md` §15; implementation shape: `implementation-status.md` §4.2.

Unlike the rest of this document, council tests **are already plain Node scripts**, attached to the root `package.json` as `test:council-*` (an `ok(label, condition)` counter; non-zero exit on failure). Twelve council suites exist: `council-parse`, `council-convergence`, `council-report`, `council-store`, `council-agents`, `council-runner`, `council-orchestrator`, `council-materials`, `council-api`, `council-quiet-plugin`, `council-timeline`, `council-ui-store`. This matches the repository convention: zero dependencies, `node file` directly, same runner locally and in CI.

#### 3.16.1 Required assertions (ordered by real-world damage if wrong)

| ID | Case | Assertion | Suite |
| --- | --- | --- | --- |
| **COUNCIL-01** | **Read-only guarantee** | 1F/4F `--tools` is `Read,Grep,Glob`, `--allowedTools` is the same list, and 4F's `--permission-prompts none` precedes the variadic args; 7F/8F inject only `read/glob/grep/list`, denying `bash/edit/write/webfetch` and `external_directory`; 7F's `plugin` is emptied | `test:council-agents` |
| **COUNCIL-02** | **Isolation** | No recipe `env` contains `HOME` (dropping HOME drops login credentials); a prompt sent over stdin never appears in `argv` (**2F Cline is the exception**: its JSON mode does not read stdin, so the prompt is a positional argument) | `test:council-agents` |
| **COUNCIL-03** | **Role validation** | Exactly one `moderator`, one `main`, at least one `reviewer`; no floor holds two roles: missing role / moderator also main / reviewer on the moderator's or main's floor → 400 and no process starts; duplicate reviewers collapse; missing floor → 400 with the original reason | `test:council-api` |
| **COUNCIL-04** | **Real wire formats** | Using captured real output (OpenCode's two-line event stream, CodeBuddy's five-record array, Cline's `run_result`, Codex's `agent_message`): body extracted, **question text and snapshot/reasoning excluded**, answer appears once, tokens readable; empty stdout / bad JSON / status-only events → `ok=false`, no invented body | `test:council-agents` |
| **COUNCIL-05** | **Structured parse (ReviewPoint)** | Use the **last** fenced JSON block (examples mid-text do not count); braces inside strings do not truncate; no block → `parsed=false` but the body is still stored (never lost); an item missing `suggestion` is dropped and counted (`parse_dropped`), not patched; missing `dimension` → "other", missing `evidence` → NULL; per-item `stance` inherits the turn stance, both missing → item unusable (never default `accept`); `reviews: []` is a valid result (`parsed=true`) distinct from parse failure; reviewer identity is assigned by the server, never self-reported | `test:council-parse` |
| **COUNCIL-06** | **Explainable convergence** | `raw = 100 − (blocker×25 + major×8 + minor×2 + nit×0 + conflict×10)`, clamped 0..100; every deduction and weight returned with the score; a model-reported `convergenceScore` never enters the parsed result (server value wins); unknown severity counts in the total but no severity bucket; `nit` deducts nothing; a missing conflict list is treated as empty | `test:council-convergence`, `test:council-orchestrator` |
| **COUNCIL-07** | **Moderator hard instructions and consistency** | Missing "must" / acceptance criteria / hedging words (suggest / consider / maybe) → warning; a blocker without a matching instruction or `openIssues` entry → warning; a `reject` stance without a registered conflict → warning; a reviewer with no opinion is named; final `approve` with a blocker in the last round → warning. Warnings **do not change flow or verdict**, only display | `test:council-convergence`, `test:council-orchestrator`, `test:council-report` |
| **COUNCIL-08** | Single call | A `#!/bin/sh` stub in a temp dir: JSON parse, **timeout kills the process group**, non-zero exit recorded as an error, unparseable body not invented | `test:council-runner` |
| **COUNCIL-09** | Orchestration | End-to-end with stub participants: round 0 planning runs once; rounds 1..N each store a `RoundResult` (proposal, diff, reviews, moderation); **a high score does not stop early**; verdict and final draft each once; `verdict='completed'`, `status='done'`; WS events carry `project=null`; **temp dir cleaned** | `test:council-orchestrator` |
| **COUNCIL-10** | API | Real Express + real repo + temp DB: create / list / detail / cancel / delete; `/floors` publishes weights, roles, severities, stances and round defaults (the UI must not copy them); detail returns `roundResults` / `utterances` / `materials` / `participants` / `report`; **409 (still running) is not success** and the server's message is passed through | `test:council-api`, `test:council-ui-store` |
| **COUNCIL-11** | Material truncation | Oversized files are truncated to the limit; `bytes_total` / `bytes_included` are true values; UI says "original N bytes, only first M embedded"; unreadable / directory / binary file → **the whole request 400s and names the file** (never silently skipped); `bytes_total` NULL (not 0) when unavailable | `test:council-materials`, `test:render-smoke`, `test:council-api` |
| **COUNCIL-12** | UI data merge | HTTP detail (snapshot) and WS increment (latest) are chosen by **round number**; an increment never wipes an existing body; different phases on one floor do not overwrite each other; a final push with only a summary must **re-fetch detail**, otherwise the page stays at "finished" without a conclusion | `test:council-ui-store` |
| **COUNCIL-13** | Not in the office | After a meeting, `members` / `task_runs` gain **nothing**; office and task records show no trace (in project mode also check the 2F/6F/7F/8F session lists, see COUNCIL-17) | `test:council-orchestrator` (assertion table unchanged) |

**Cases added by the 2026-10-02 project-directory work and the 2026-10-19 role refactor:**

| ID | Case | Assertion | Suite |
| --- | --- | --- | --- |
| **COUNCIL-14** | **Project directory untouched** | With injected `removeDir` / `isDir` stubs: project mode neither creates nor removes temp dirs, and the user's directory is not deleted; the prompt names the project path and "do not modify any file"; if the directory disappears after start → `verdict='failed'` with the original message, **no process starts** | `test:council-orchestrator` |
| **COUNCIL-15** | Input validation | `workspacePath` relative / missing / a file → 400 naming the path; `~` expands to home before validation; `maxRounds` above the limit is clamped, illegal values fall back to the default (**not 0**); duplicate reviewers collapse; empty/blank topic → 400 | `test:council-api` |
| **COUNCIL-16** | **Two isolation locks in project mode** | ① Every recipe `env` carries `WORKGREMLIN_DISABLE=1`; the hook exits immediately (no server connection, no status file, exit 0) and both plugin entry points recognize it (return shape unchanged, otherwise 7F reports "plugin load failed"); ② `--title` for 7F/8F and `--name` for 6F equal the title filtered by the session list; 2F has no title switch and stores the prompt as the title, so the prompt starts with `COUNCIL_PROMPT_MARKER` — user sessions still list normally, only participants are hidden | `test:council-agents`, `test:claude-hook`, `test:council-quiet-plugin`, `test:kilo`, `test:opencode`, `test:cline` |
| **COUNCIL-17** | **Report files** | After completion, **only** `report.json` / `reviews.csv` / `rounds.csv` / `report.md` under `~/.workgremlin/councils/<id>/`; even with a project path, **nothing is written into the project** (read-only); CSV has a UTF-8 BOM, CSV-escaped commas/quotes/newlines, CRLF; existing files are never overwritten (timestamp suffix); fixed schema (plan / per-round `RoundResult` / verdict / final draft / changelog / warnings / files); missing tokens `—`, partial `≥ N`, **never 0** | `test:council-report`, `test:council-orchestrator` |
| **COUNCIL-18** | **New schema and no voting** | Seven `council_*` tables on a fresh DB; `verdict` CHECK accepts `completed/partial/needs_clarification/cancelled/failed`; **no** `mode` / `threshold` / `vote` / vote-count columns; `completed`, `partial`, `needs_clarification` → `done`, `cancelled` → `cancelled`, others → `failed`; an old CHECK is fixed by rebuilding only that table, preserving history and `AUTOINCREMENT`; delete removes all child rows; deleting a running council returns 409 | `test:council-store`, `test:council-api` |
| **COUNCIL-19** | **Failure, recovery and the "working" marker** | Round 0 moderator has no usable output (exit 0, unparseable) → `unparsed`, meeting `failed` immediately, **no proposal/review**, error names round/phase/floor and the output tail, report still archived, no participant left `running`; a transcript truncated after the last complete `result`/assistant event → recover body and usage from the complete prefix, not a failure; moderator returns concrete `needsClarification` → `needs_clarification` / `done`, only round 0, other roles `skipped`, report archived; reviewer failure/unparsed → excluded from moderation, `turn_failed` in report; failure after a completed round → `partial`; `progressOf` returns `{roundNo, phase, floors}` while running and `null` after; detail API returns `progress` too | `test:council-parse`, `test:council-agents`, `test:council-runner`, `test:council-orchestrator`, `test:council-api`, `test:council-ui-store`, `test:render-smoke` |
| **COUNCIL-20** | **Right panel shows summary only** | Convergence uses the **last round's** server score and shows the formula; n opinions / n blockers / n conflicts; three roles each show floor, model, tokens (missing → `—`); clarification questions listed individually; **no voting trace anywhere** | `test:render-smoke`, `test:council-timeline` |
| **COUNCIL-21** | **Collapsible full process + per-round diff** | Process area is `<details>` and **collapsed by default** (no `open`); round 0 shows planning and roles; the first proposal has no diff and says so explicitly, later rounds diff against the previous version; each review (severity + stance + evidence + suggestion) and moderation (consensus / open / conflict sides / hard instructions / warnings) is transcribed; failures show the original text and reason, **never a fabricated opinion**; **every round (including 0) keeps all raw utterances** (floor / phase / state / duration / error); after a fail-fast abort, rounds without a `RoundResult` are marked "incomplete" and list utterances that did happen, while the verdict / delivery round must **not** be marked incomplete; `partial` has no verdict block and no report-file block but shows who failed; running shows a live marker and available summary | `test:render-smoke` |

#### 3.16.2 Manual smoke tests (what automation cannot cover)

Real CLI output formats can only be learned by running them. The 2026-10-01 smoke test caught two bugs that all unit tests missed: OpenCode's body lives in `part.text`, not `parts`; CodeBuddy returns the whole conversation array and treated the question text as its own answer. Both are recorded in `implementation-status.md` §4.2.

| Item | How | Expected |
| --- | --- | --- |
| Each floor's command | Run a small meeting (main + moderator + one reviewer) with `WORKGREMLIN_HOME` pointing at a temp dir; **never touch the user's DB** | Body extracted, structured review parsed, model and tokens attributed to the right role |
| Tools actually disabled | Put a marker file in the temp dir and ask it to read | Cannot read (8F: without the lock it can, with the lock the tool call is rejected; 2F: writing rejected, `read_files` still works) |
| No orphan processes | `ps` for the CLIs after the meeting ends or is cancelled | None left; the temp directory is removed |
| Missing means missing | Check 8F tokens | `—`, not 0 (OpenCode really does not emit usage) |
| Did it really read the code? (project mode) | Start on a real project and ask something only the code can answer ("where is this function called?") | Real file names / symbols, not a paraphrase of the material |
| Project directory untouched (project mode) | Check the directory after the meeting | `git status` clean, no new files, directory still there (verify manually before merging) |
| Office still clean (project mode) | Check office, task records and 2F/6F/7F/8F session lists | No participants visible (the CLIs' own UI keeps those "council participant" entries — that is the CLI's history; we only read). **6F still needs a machine with Qoder CLI installed** to confirm `--name` reaches the transcript |

**Sampling discipline:** raw stdout from a smoke test must be stored verbatim in the unit suite (see COUNCIL-04). Guessing the wire format is how those two bugs survived.

---

## 4. Defect severity

### 4.1 Severity

| Level | Name | Criteria (any one) | Response |
| --- | --- | --- | --- |
| **S1** | Blocker | App cannot start / install / upgrade; main or renderer crash without self-recovery; core function unavailable; message loss or a long-lived wrong state; data corruption (`integrity_check` fails); security config bypassed; native module unavailable on a target platform and silently replaced by a fallback implementation; **plaintext credentials on disk (redaction fails any layer)** | Stop testing; fix or provide a workaround within 24 h |
| **S2** | Critical | Core flow wrong but bypassable; **state derivation wrong** (blocked leaking across sessions, pending counted as busy, a timer changing state, borrowed busy outliving its ghost); message loss/duplication > 0.1%; retention cleanup losing live data; **fabricated progress value**; a lower-priority event triggering a notification; notification rate-limit / DND failure; redaction false-positive rate > 0.5%; P95 > 2× target; < 30 fps or > 500 ms freeze under load; crash recovery losing > 1 s; a core path broken on a supported platform | Fix in this iteration |
| **S3** | Major | Minor function wrong; UI layout / display error; filter or search boundary wrong; missing "source unavailable" hint; P95 between 1× and 2× target; high memory without OOM; demo mode missing its label | Next iteration |
| **S4** | Minor | Copy / typo / icon; style detail; missing a11y hint; unfriendly log; slight performance miss | Backlog |

### 4.2 Priority

| Level | Meaning |
| --- | --- |
| **P0** | Release blocker |
| **P1** | Must fix before this release unless the leader signs a waiver |
| **P2** | Should fix this iteration if possible |
| **P3** | Wish list |

### 4.3 Defect workflow

1. Every report includes: environment (OS / version / build / Electron / ABI), reproduction steps, minimal replayable event JSONL or request sequence, expected vs actual, screenshot/video, metrics export, debug logs.
2. A replayable defect attaches `tests/fixtures/bugs/<BUG-ID>.jsonl` (planned) and joins the regression set after the fix.
3. Flaky tests are marked individually (no permanent `test.fails`), reviewed weekly; three consecutive flakes without a fix are treated as S2.

---

## 5. Regression scope

| Level | Trigger | Scope | Budget |
| --- | --- | --- | --- |
| **R0 Smoke** | Every push / PR | `npm run test:all` (73 suites) + `npm run db:check`; renderer build | ~2 min |
| **R1 Incremental** | Before merge | R0 + the changed module's dedicated suites + affected route / hook suites | ≤ 15 min |
| **R2 Full functional** | Nightly + milestone exit | R0 + all state / message / DB / council suites + a manual office pass on demo data + platform smoke (Linux + Windows) | ≤ 60 min |
| **R3 Release** | Before release | R2 + packaging matrix, 8 h soak, sleep/reconnect, watcher robustness, native modules on three platforms, macOS signing/notarization path | As needed (includes 8 h) |

**Change → regression map**

| Change location | Minimum level |
| --- | --- |
| `shared/index.js` `AGENT_STATES`, labels, `agentBase`, `formToSource` | R1 + SC-24/SC-32 + DB-18 + all renderer suites |
| `server/src/ingest/bus.js` member-card derivation / `session_status` | R1 + SC-01–SC-30 + `test:task-sync`, `test:task-runs-route` |
| `renderer/src/lib/memberTask.js` | R1 + SC-07, SC-14, SC-19–SC-21, SC-29–SC-30 + `test:member-task` |
| `server/src/ingest/hookCommon.js` blocked / task transitions | R1 + SC-06, SC-09–SC-13 + `test:hook-dispatch`, `test:hook-runtime` |
| IPC / preload bridge | R1 + DS-12 + R0 manual launch |
| Floor reader / poller | R1 + FW-01–FW-08, FW-14 (Linux + Windows) |
| Message list / record view | R1 + SPIKE-01–08 (when implemented) + MS-03/05/06 + RT-03 |
| SQLite schema / migration / retention | R2 + DB-01–DB-16 on all platforms |
| Electron version / native module / packaging config | R3 + native matrix + `npm run db:check` in the packaged app |
| Demo provider / fixture | R1 + DEMO-01–08 + `test:demo`, `test:demo-lifecycle` |
| Docs / style only | R0 |

---

## 6. Definition of Done (main numbering)

> Checkboxes are acceptance criteria, not a status report. Features marked **Planned** remain unchecked until implemented.

### Common DoD (every milestone)

1. In-scope L1 line coverage ≥ 80%; core modules (state derivation, message dedupe/order, floor parsing) branch coverage ≥ 90% once coverage tooling exists.
2. Relevant L2 coverage: normal, empty, loading, error and boundary states.
3. No S1; S2 cleared or waived in writing; S3 ≤ 3 with a plan.
4. New settings have defaults and a test that reads them; every threshold is recorded in metrics, not only in prose.
5. Repeated runs (5×) produce identical results; flaky rate = 0.
6. Docs updated; new HTTP/WS contracts have a test.

### M0 — Skeleton + testability baseline + demo + native modules

- [ ] `npm run dev` starts on Linux x64; macOS/Windows x64 verified at least once.
- [ ] `AGENT_STATES` frozen as exactly `['busy','idle','blocked']`; no other value is written anywhere.
- [ ] `Clock` abstraction exists (`server/src/clock.js`) and business code uses it.
- [ ] `WORKGREMLIN_HOME` / data-directory override works; single-instance lock works.
- [ ] Demo project seeds on demand, covers three states, and is deterministic per seed.
- [ ] Native modules: N1 (Linux x64) passes all success criteria; `npm run rebuild:native` exits 0.
- [ ] `npm run db:check` passes.
- [ ] `messages.archived_at` and `content_truncated` columns and indexes exist.
- [ ] Office and records surfaces render on demo data.
- [ ] `npm run test:all` is green (baseline: 73/73).

### M1 — Office state + message integrity + honest progress

- [ ] All SC-01–SC-32 pass, including session scoping, blocked clearing, borrowed busy, last-active and "age never changes state".
- [ ] The old liveness model has no residue: no state timeout, no TTL, no `degraded`, no `lastSeenAt`, no `agent_status_history` usage.
- [ ] RT-01 target met (P95 ≤ 300 ms); RT-03/04/06/08 measured, with before/after evidence.
- [ ] MS-01–MS-03, MS-06–MS-10 pass; message ordering is deterministic under repeated runs.
- [ ] PRG-01–PRG-08 pass; **no progress bar and no fabricated percentage** in card, office or detail.
- [ ] DS-08/DS-09 reconnect cases pass; state does not change on ping loss.
- [ ] Notifications remain off: trigger design is not final (NOT-01 blocked), so no notification exit criterion is claimed.
- [ ] Redaction remains off: SEC-* cannot be claimed until a `Redactor` exists.
- [ ] L4 is still manual: at least one real launch checks state refresh on demo data.

### M2 — Task records, conversation data, persistence and recovery

- [ ] MS-04, MS-05, MS-11, MS-12 pass, or MS-05 is explicitly deferred with a spike result.
- [ ] Filter/search combinations match the documented boundary semantics.
- [ ] FTS5 trigram table is consistent with the message table; if the query layer moves off `LIKE`, SPIKE-09–12 results are recorded and MS-09 is updated.
- [ ] Task-record retention (90-day default, 1–3650 clamp) passes DB-08 and MS-13/MS-14; no message-count cap is claimed.
- [ ] DB-01–DB-10 pass; `kill -9` loss window ≤ 1 s.
- [ ] Crash recovery has an automated case, not only a manual step.
- [ ] Migration from the liveness-era schema (DB-16) is automated and idempotent.
- [ ] Virtual scrolling is either adopted (MS-05) or explicitly deferred; no claim of smooth 100k rendering until then.

### M3 — Packaging and release (three platforms, x64)

- [ ] DS-01–DS-05, DS-07–DS-13 pass; three-platform matrix green.
- [ ] DS-06 / DS-14: x64 only, no hardcoded arch; `check:arch-param` exists and passes (currently planned).
- [ ] Native modules N2 (Windows x64) and N3 (macOS x64) pass.
- [ ] Silent install / upgrade / uninstall automated; DS-15 size recorded, not gated.
- [ ] macOS signing path: notarization or the documented ad-hoc path, verified on a clean machine.
- [ ] 8 h soak: RSS growth < 20%, no handle leak, no crash.
- [ ] **If and only if notifications are implemented and the trigger is defined:** one real S1 (`blocked`) notification per platform.
- [ ] Electron packaging E2E (planned) is either implemented or the manual release checklist is signed.

### M4 (optional) — Watch productionization + reverse control

- [ ] FW-01–FW-08, FW-11–FW-14 pass (FW-01/03/05/08 on all three platforms).
- [ ] FW-09, FW-10, FW-15 produce a decision on network drives, WSL and clock jumps.
- [ ] The poll/scanner path has a UI "source unavailable" hint and automated verification.
- [ ] CTRL-01–CTRL-06 pass (confirmation, event log, unavailable targets, double-click protection).

---

## 7. Testability contract

**M0 blocker** = required for the M0 exit; ○ = needed by the milestone that owns the feature.

| # | Requirement | Purpose | M0 blocker | Affected cases | Status |
| --- | --- | --- | --- | --- | --- |
| 7.1 | **Injectable clock:** `Clock` with `now()` / `monotonic()`; tests swap it via `__setClock` | Deterministic elapsed-time and timeout behavior | **✅** | SC-15, SC-16, MS-03, DS-08 | Implemented |
| 7.2 | **Injectable event source:** a formal interface plus `FakeEventSource` (`emit` / `emitBurst` / `emitOutOfOrder`) | Precise timing and flood control; reuse for synthetic scenarios | ○ | SC / RT / DEMO | **Planned** — suites call bus routes directly |
| 7.3 | **Replayable messages:** append-only event JSONL + `replay(file, speed)` | Minimal defect reproduction and cross-check of recovery | ○ | DB-10, regression set | **Planned** |
| 7.4 | **Deterministic IDs and idempotency:** `dedupe_key` unique index, message id tiebreak, WS envelope `seq` | Dedupe and ordering assertions | **✅** | MS-01–03, SC-27 | Implemented (dedupe key + id ordering) |
| 7.5 | **Monotonic vs wall clock:** monotonic for elapsed, wall clock for display | Avoid sleep / clock-jump misjudgment | **✅** (merged into 7.1) | SC-15, DS-08 | Implemented |
| 7.6 | **Headless core:** pure state/task rules in `shared/` and `renderer/src/lib/`, no Electron imports | L1/L2 run in Node | **✅** | all L1/L2, DEMO-02 | Implemented in practice |
| 7.7 | **Test factory `createTestApp(overrides)`:** fake source + temp repo + fake clock, exposing `emit()` / `advance()` / `snapshot()` | Lower integration cost | ○ | all L3 | **Planned** |
| 7.8 | **Built-in metrics:** ingest→bus→WS→store→paint histograms, state counts, frame rate, queue length, dropped count; `getMetrics()` + debug HUD | Real-time claims are measurable | ○ | RT-01–05, defect triage | **Planned** |
| 7.9 | **Stable selectors:** `seat-card-<id>`, `seat-status-<id>`, `msg-row-<id>`, `conv-list`, `filter-agent`, `search-input` | Tests survive styling changes | **✅** | all L2/L4, DEMO-05 | Implemented (subset; the removed status, progress and banner selectors are absent) |
| 7.10 | **Repository abstraction:** SQL centralized in `server/src/db/index.js`; tests open a temp DB per suite | DB logic testable | ○ | DB-01/02/09 | Implemented (single SQLite implementation, temp DB) |
| 7.11 | **Configurable render merge:** `member.status` 200 ms merge window; renderer update strategy configurable | Jitter and load comparison | ○ | RT-03/05/06, SC-27 | Partial (server merge implemented) |
| 7.12 | **Fault injection switches:** `--simulate-crash`, `--simulate-slow-fs`, `--simulate-clock-skew`, `--simulate-disk-full`, `--simulate-watch-error` | Automate failure paths | ○ | DB-03–06, FW-01/03/05 | **Planned** |
| 7.13 | **Versioned event schema:** `schemaVersion` + migration functions + old fixtures | Backward compatibility | ○ | MS-12, DB-02 | Partial (`PROTOCOL_VERSION = 2`; no fixture versioning) |
| 7.14 | **Shared IPC contract:** typed channel definitions used by preload / main / renderer | Contract tests | ○ | L3, DS-12 | **Planned** (bridge exists, no types) |
| 7.15 | **Overridable data directory:** `WORKGREMLIN_HOME` + data-dir option | Isolated E2E and parallel suites | ○ (strongly recommended for M0) | DS-07, DB-07, DEMO-04, CI | Implemented (`shared/paths.js`) |
| 7.16 | **Standalone redactor:** pure `Redactor` function, injectable rules, disable switch, runs before insert and before FTS indexing | SEC-* automation | ○ (required before M1 redaction work) | SEC-01–17 | **Not implemented** |
| 7.17 | **Injectable notifier:** `Notifier` + fake that records calls; injectable window focus; notification decoupled from state updates | NOT-* including negatives and aggregation | ○ (required before notification work) | NOT-01–15 | **Not implemented** |
| 7.18 | **Structured progress:** `{ value: number\|null, source? }` | Distinguish "0%" from "unknown" | ○ | PRG-01–08 | **Not implemented** (`number\|null` only) |
| 7.19 | **Switchable FTS tokenizer:** tokenizer configurable per index | Spike comparison and migration | ○ (end of M1) | SPIKE-09–12 | **Partial** (trigram table fixed; query uses LIKE) |
| 7.20 | **Observable security PRAGMAs:** expose `secure_delete` / `journal_mode` and connection purpose | Support DB-13/14 assertions | ○ (before M1 security work) | DB-13, DB-14 | Partial (`secure_delete=ON` fixed; not queryable) |

> M0 blockers actually in place: 7.1, 7.4, 7.6, 7.9. 7.2, 7.7 and 7.8 are **planned**; do not claim M0 completeness until they exist or are explicitly waived.

---

## 8. Test data and mock strategy

1. **Synthetic team generator:** default 4 members (leader / researcher / coder / tester), scalable to 16 / 64 for layout and pressure tests. The demo provider already supplies a fixed roster plus two ephemeral ghosts (`ghost-*`).
2. **Demo data:** the read-only provider (`server/src/demo/provider.js`) builds the virtual project / session / members / messages in memory on every request; nothing is seeded into the database. Roster and task data are static, messages use a fixed PRNG seed, and the session phase follows a fixed server-owned timeline. Demo data covers `busy` / `idle` / `blocked`, at least one ghost and ≥ 200 messages.
3. **Event-stream generator:** parameterized `{ rate, duration, outOfOrderRatio, duplicateRatio, dropRatio, burst, seed }`, emitting JSONL for L3/L5 — **planned**; today suites construct rows and requests inline.
4. **Golden snapshots:** DOM snapshots of the office and message list under a fixed event stream; they require deterministic ordering (MS-03), a fake clock and a demo seed, otherwise they are flaky.
5. **WS mock:** supports disconnect, half-frame, out-of-order and replay for DS-08/DS-09; currently tests use the real server on a random port plus forced socket close.
6. **Do not mock:** real SQLite (temp file), real Express routes, real hook dispatch, real `fs` where the risk is the filesystem. These are the highest-risk areas.

---

## 9. CI pipeline

**Current reality:** there is no CI configuration in the repository (`.github/workflows` does not exist). The local gate is:

```bash
npm run build          # renderer must compile
npm run test:all       # 73 suites, serial, ~58 s
npm run db:check       # SQLite self-test
```

**Planned pipeline** (when CI exists):

| Stage | Content | Gate |
| --- | --- | --- |
| stage-1 | L0: syntax / lint / security config / `check:arch-param` (planned) / native check (planned) | Stop on failure |
| stage-2 | `npm run test:all` on Linux x64 with a pinned Node version | 73/73 green |
| stage-3 | Build the renderer; Electron packaging smoke (planned) | Green |
| stage-4 | Platform matrix: Windows x64 + macOS x64 | Green on main and release branches |
| stage-5 (nightly) | Load / 8 h soak / watcher robustness / three-platform native modules | Threshold gate, warn on regression |

PRs run stage-1–2; main adds stage-3; release triggers stage-4–5. Until the pipeline exists, a release candidate requires a signed local run of the commands above.

---

## 10. Risks and open items

| # | Risk | Impact | Mitigation | Status |
| --- | --- | --- | --- | --- |
| R1 | Electron E2E is inherently flaky (window / focus / timing) | L4 instability | Fake clock + event-driven waits (no `waitForTimeout`); retry 2×; weekly flake review | Open |
| R2 | Floor readers differ across Windows / network drives | FW-* may only be green on Linux | M0–M2 keep only the polling path; network drives / WSL deferred to M4 | Contained |
| R3 | 100k-message performance requires a rewrite | M2 rework | Virtual-list spike at M1 kickoff (§3.9.1) | Open (not started) |
| R4 | Sleep / clock-jump tests are unreliable in CI | DS-08 / SC-16 flaky | Fake clock + an injectable skew switch (planned 7.12); real sleep manual only | Open |
| R5 | Native module ABI mismatch (better-sqlite3 × Electron) | M0 blocker; all DB work unavailable | §3.8 matrix + `npm run rebuild:native` + explicit escalation; no silent fallback | **Highest priority** |
| R6 | Demo data not deterministic | L2 snapshots flaky | DEMO-03: static roster/tasks + fixed message seed + server-owned phase timeline in the virtual provider | Mitigated |
| R7 | macOS / Windows runners are expensive | Cross-platform issues found late | Run the matrix at least nightly; mandatory before release | Open |
| R8 | Redaction misses a secret (false negative) | Plaintext on disk = S1 | Three-layer verification + rule regression + ≥ 2 positives per class; feature not implemented yet | **P0, blocked** |
| R9 | Redaction harms normal code/logs (false positive) | Usability damage | SEC-08 fixed 200-item clean corpus, ≤ 0.5% gate; feature not implemented yet | **P0, blocked** |
| R10 | Chinese tokenization not validated early | FTS index rebuild in M2 | Minimal Chinese corpus at end of M1; FTS is currently unwired | Open |
| R11 | Notifications fire for lower-priority events | Noise disaster; users disable notifications | NOT-02 per-event negative assertions; feature not implemented | **P1, blocked** |
| R12 | `secure_delete=ON` + WAL checkpoint hurts write throughput | 1,000 events/s target missed | DB-13 measurement; dual-connection contingency (DB-14) | Open |
| R13 | Window-focus notification behavior cannot be automated | NOT-* partly manual | `--simulate-focus=` (7.17, planned); otherwise a manual checklist | Open |
| R14 | Blocked rows accumulate or leak across sessions | Wrong state, phantom orange cards | Session-scoped PK + prune on session reconciliation (SC-07/SC-14/SC-22) + `test:session-compact` | Mitigated |
| R15 | Borrowed busy sticks after a ghost disappears | Resident gremlin permanently busy | `agent_status` is the only writer; ghost finish/disperse clears it (SC-19/SC-20, `test:agent-roster`) | Mitigated |

**Closed items from earlier versions:** the five-state model and its transition matrix (removed by `e2ad323`); liveness timeouts and the degraded flag (removed); the 100,000-message cap and automatic JSONL archive (never implemented; retention is days-based).

**Open small questions (non-blocking; adjust cases after confirmation):**

1. Should a future notification trigger use blocked duration, or entry only? (§3.11; must be decided before M3.)
2. Retention export: location and naming of a future JSONL archive (affects MS-15/SEC-11).
3. CPT-04: compact mode triggered by member count or available width.
4. SEC-02: explicit decision on lowercase `akia`.
5. Q9 encrypted channel / Q10 short-term search semantics: waiting on researcher; may affect SEC-* and search cases.
6. Project-mode 6F: whether `--name` reaches the Qoder transcript (needs a machine with Qoder CLI installed).

---

## 11. Q8: notification default proposals

> Status: notification delivery is **not implemented**. These values are proposals to settle before implementation; the "default value assertion" (NOT-04) cannot run until settings exist.

| Setting | Proposed default | Reason |
| --- | --- | --- |
| **Do not disturb** | **Off** (no window) | The candidate trigger scope is narrow (only `blocked`); default silence would read as "not monitoring", which is worse than an occasional alert |
| Window template | `22:00–08:00`, **disabled by default** | Lowers configuration cost; enabling it is itself a test case (NOT-06/07/08) |
| Time-zone semantics | **Local time** (system zone; `--simulate-tz=` for tests) | Matches user expectation; cross-zone case NOT-08 |
| **Per-member mute** | **All unmuted** | Mute is a user action, not a preset |
| System notifications | **On** | The product's value is "you do not have to watch the screen" |
| Notification sound | **Off** | Office environments; visual is enough |
| Aggregation window | Same member + same event type, **5 min (300 s)** → 1 notification | A typical wait lasts under 5 min; a longer window hides recurrence, a shorter one loses aggregation |
| Global rate limit | ≤ 5 per 60 s; > 20 → one summary | Prevents a storm when many sessions block together |
| Recovery notification | **None** when blocked clears | Less noise; an opt-in setting can come later |
| Permission prompt | Request on the **first S1 event**, not on cold start | Users have no context on cold start and tend to deny permanently |
| Events during DND | Event log + unread count, **no retroactive popup** | Avoids a notification flood after wake (NOT-09/10) |

---

## Appendix A: Threshold quick reference (v0.5)

| Metric | Value |
| --- | --- |
| Workstation states | **3** (`busy` / `idle` / `blocked`); no orthogonal flag |
| State derivation precedence | `blocked` > `busy` > `idle`; ties by earliest `stateSince` |
| Renderer per-session rule | blocked (same session) > running task (same session) > borrowed summon busy > idle |
| Report → render end-to-end | P95 ≤ 300 ms / P99 ≤ 800 ms |
| ingest→bus / bus→fanout / fanout→store | ≤ 30 ms / ≤ 50 ms / ≤ 50 ms |
| store→paint | ≤ 16.7 ms (worst 50 ms) |
| Sustained load | 1,000 events/s × 60 s, ≥ 50 fps, no task > 50 ms |
| Burst | 5,000 events/s × 5 s, convergence ≤ 1 s |
| State update merge window | 200 ms (`member.status`) |
| WS keepalive | ping every 30 s, 60 s pong timeout — **transport only**, never a state signal |
| Task-record retention | default **90 days** (clamp 1–3650); deleting a task record also deletes its messages; no message-count cap |
| Message truncation | `content_truncated` column exists; 64 KB logic **planned** |
| Message capacity | 100,000 messages, DOM ≤ 80 nodes, ≥ 55 fps, memory ≤ 200 MB — **virtual list planned** |
| Search response (100k) | ≤ 300 ms target (current query uses `LIKE`) |
| Crash recovery loss | ≤ 1 s or ≤ 500 messages |
| Reconnect | ≤ 5 s (exponential backoff + jitter, cap 30 s) |
| Scanner / poll | configurable interval; **not** a fallback mode, never changes state |
| Notification aggregation | 300 s per member + event type (proposal) |
| Notification global limit | ≤ 5 per 60 s; > 20 → one summary (proposal) |
| Notification defaults | system on / sound off / DND off / all unmuted (proposal) |
| Redaction false-positive rate | ≤ 0.5% over 200 clean samples |
| Redaction plaintext residue | 0 hits (messages / indexes / FTS shadow tables / `.db` / `-wal` / archive / logs) |
| Chinese search response | < 200 ms (100k, Chinese corpus ≥ 70%) — target |
| Cold start | ≤ 3 s warm / ≤ 5 s cold |
| 8 h soak | RSS growth < 20%, no handle leak, no crash |

## Appendix B: M0 minimum landing list

| Priority | Item |
| --- | --- |
| P0 | `shared/index.js` is the protocol source of truth; `AGENT_STATES` is exactly three values |
| P0 | `Clock` abstraction with `__setClock` (monotonic / wall time) |
| P0 | Deterministic `dedupe_key` + message ordering (`ts_ms`, id) |
| P0 | Native modules: `require('better-sqlite3')` works inside the Electron main process (Linux x64) |
| P0 | `npm run rebuild:native` exits 0; `npm run db:check` passes |
| P0 | Data-directory override (`WORKGREMLIN_HOME`) + single-instance lock |
| P0 | Stable selectors: `seat-card-*`, `seat-status-*`, `msg-row-*`, `conv-list`, `filter-agent`, `search-input` |
| P0 | Demo project seeds on demand with deterministic data (three states + ghost + 200 messages) |
| P1 | `messages.archived_at` + index + `content_truncated` column |
| P1 | Architecture-parameterized packaging (no hardcoded arch), `check:arch-param` script |
| P2 | Event JSONL persistence + `replay()` |
| P2 | Latency metrics + `getMetrics()` |
| P2 | Fault-injection switches |

## Appendix C: Testability to add before feature work

| Priority | Item | Reason |
| --- | --- | --- |
| P0 | `Redactor` pure module + injectable rules + disable switch | Without it, SEC-* cannot be automated |
| P0 | Redaction runs before insert and before FTS indexing | Otherwise L2/L3 will always find plaintext |
| P0 | `Notifier` interface + fake that records calls | NOT-02 negatives cannot be verified by watching the screen |
| P0 | Notification decoupled from state updates | Muting must not freeze the office state (NOT-11) |
| P1 | `--simulate-focus=lost\|gained` | Window-focus notification behavior becomes testable |
| P1 | Structured progress `{ value, source? }` if progress returns | Distinguish "0%" from "unknown" |
| P1 | Configurable FTS tokenizer | SPIKE-09–12 comparison and migration |
| P1 | Expose connection purpose and `secure_delete` (7.20) | Support DB-13/DB-14 assertions |
