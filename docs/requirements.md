# WorkGremlin — Requirements Specification

| Item | Value |
| --- | --- |
| Product | WorkGremlin — a visual, local desktop app for observing multi-agent coding work (workstation view + conversation record) |
| Version | **v0.4** (state model refactor) |
| Owner | Product / research |
| Related | `docs/requirements-outline.md` (feature numbering), `docs/tech-design.md`, `docs/test-strategy.md`, `docs/implementation-status.md`, `docs/roadmap.md` |
| Working directory | `/home/yinghui/work/WorkGremlin` |

> **2026-10-21 — workstation state refactor.** The product now has exactly three workstation states:
> **`busy` / `idle` / `blocked`**. The business heartbeat, heartbeat timeout, per-member TTL/lease,
> `offline`, `error` and the orthogonal `degraded` flag were removed. Busy comes from a running task;
> blocked comes from an explicit per-session authorization wait; idle means neither. "Last active" is
> derived from task start/end timestamps. The WebSocket ping is transport-only. This document uses that
> model everywhere; older 5-state text is obsolete.

> **Numbering authority.** Feature IDs follow `requirements-outline.md` (`P0-1 … P0-7`, `P1-1 … P1-6`,
> `P2-1 … P2-6`); open questions keep `Q1 … Q11`. This document does not invent a second numbering scheme.

> **Scope note.** This is a requirements document, not a status report. Where a requirement is not yet
> implemented, the text says so. `docs/implementation-status.md` is the authoritative description of what
> the code does today.

---

## 1. Product positioning and boundaries

A local, single-machine, **read-mostly** desktop app that turns the work of multiple coding agents into:

1. **A visible office** — who is busy, on which session, on which floor, and what is currently running.
2. **A searchable conversation record** — the full message stream, filterable, searchable, traceable and exportable.

| It is | It is not |
| --- | --- |
| A local read-only monitoring terminal | A cloud SaaS or multi-user collaboration platform |
| A dashboard for work in progress | An agent scheduler or orchestration engine · **the council chamber (§15) is the single exception** |
| An observer plus a reporting endpoint for existing agent products | A replacement for any product's own team/session mechanism |
| A tool for the person running several agents | A tool for the agents themselves |

**The iron rule: never fabricate.** Any field that cannot be observed is shown as a placeholder (`—`),
never as 0%, a guess, or a stale value pretending to be current.

---

## 2. Users and scenarios

P1 is the only design target. P2/P3 needs are satisfied only when they do not add complexity for P1.

| Persona | Traits | Primary need | Key scenario |
| --- | --- | --- | --- |
| **P1: AI-team operator** (developer / tech lead running a real project with several agents) | 3–8 agents in parallel; also writes code; hates switching windows to read logs | "See at a glance who is working, who is blocked, and where" | Watch a parallel run; intervene when an agent has been blocked for 10 minutes |
| P2: Agent-workflow tuner (prompt/workflow optimization) | Runs the same batch repeatedly; cares about duration and message round-trips | "Review one collaboration: who waited how long, how many messages, where the output is" | Replay the timeline after a run to find bottlenecks |
| P3: Team lead / observer | Does not operate the agents; wants to know where time goes | "Report progress without reading logs" | Put the workstation view on a meeting screen; export a session summary |

### 2.1 Six acceptance-level scenarios for P1

| ID | Scenario | Description | Success criterion |
| --- | --- | --- | --- |
| **SC-A Watch while working** | Dispatch work, then write your own code with the app on a second screen | Decide within 3 seconds who is busy, who is idle and who is blocked, **without clicking anything** |
| **SC-B Long-task watch** | An agent is doing a 10-minute refactor | Know whether it is working; if it exceeds 1.5× the historical median for similar tasks, show a "slower than expected" badge without changing the state color |
| **SC-C Blocked investigation** | A tester has waited 5 minutes for an artifact | **One click** to find the blocked member, the reason/awaiting object when known, when the block started, and the member's recent messages |
| **SC-D Failure review** | An agent just failed | Filter the conversation by `type=error` and the task list by `failed`, then walk the full error chain |
| **SC-E Cold-start takeover** | The user opens the app after the team has run for 20 minutes | Restore current states and recent messages within 10 seconds; never show an empty panel and never fake freshness |
| **SC-F Demo / E2E** | Demonstrate the product or run deterministic automated tests | The demo project produces deterministic data and is visually isolated from real projects |

---

## 3. Scope and data coordinates

| Dimension | Decision |
| --- | --- |
| workspace | **One workspace** (the open project). Multi-workspace is an architectural reservation only |
| ~~team~~ → **project** | The code has no team concept. `project_id` is the ownership key for `members`, `tasks`, `messages`, `file_activity`, `artifacts` and `task_runs`. Switching is via the floor list, the session dropdown and "Open project" |
| Workstation states | **Exactly three: `busy` / `idle` / `blocked`.** No `offline`, `online`, `error`, `thinking`, `unknown` or `degraded` |
| Liveness | **No business heartbeat and no TTL.** A task is running exactly while `tasks.state='running'`; no elapsed-time or heartbeat heuristic may change a state |
| Member scale | Target 16 members. Compact mode (≥5 members) and pagination (>16) are **not implemented**; the target remains a requirement |
| Floors | Nine monitored products: 1F CodeBuddy, 2F Cline, 3F Codex, 4F Claude Code, 5F TraeCode, 6F Qoder, 7F Kilo Code, 8F OpenCode, 9F GitHub Copilot |
| Platform | x64 only (Linux AppImage/deb, Windows NSIS, macOS-x64 dmg). ARM is not shipped; packaging scripts are parameterized rather than hardcoding an architecture |
| Network drives / WSL | Not supported. Floor readers use short SQLite timeouts and degrade to empty data on lock/EMFILE; there is no `degraded` flag and no state change |
| Demo | A UI action that switches to an isolated demo project. The old `--demo` / `MOCK=1` startup flags are retired |
| Reverse control | Not implemented. The council chamber (§15) is not reverse control: it starts its own one-off processes |
| Notifications | Not implemented. With only three states, the old trigger set (`blocked / error / offline > 60 s`) is obsolete; the only candidate event is `blocked` |

---

## 4. Data sources and fusion

### 4.1 Route B — active reporting (implemented, truth source)

Agent hooks and the `packages/reporter` SDK/CLI report to the local server (`POST /api/v1/...`).
Reports are persisted in SQLite and pushed to the renderer over WebSocket.

| Report | Purpose |
| --- | --- |
| `register` | Create/update a member and mark `reported=1` |
| `task/start`, `task/progress`, `task/end` | Task lifecycle; the only source of `busy` |
| `task/tokens`, `task/current` | Token backfill and wrap-up fallback |
| `message` | Message stream |
| `file/touch` | File read/write activity |
| `tool/use` | Tool-usage counters |
| `ghost` | Summoned subagent lifecycle |
| `hook` | Raw product hook event; the server dispatches it to a floor adapter |

There is **no `/heartbeat` endpoint** and **no `/status` endpoint**. `blocked` is produced by the hook
dispatcher when a product asks for permission (`PermissionRequest` / permission `Notification`).

### 4.2 On-disk floor readers (implemented, supplementary)

Each floor module reads its product's local store (SQLite, JSONL/rollout files, checkpoints, session
indexes) and normalizes sessions, task runs, tokens and phases. These readers supply data a hook cannot
carry; they are **not** a workstation-state authority.

The old route A (a `chokidar` watcher over `.codebuddy/teams`) was designed but **never implemented**.
Nothing in the current server depends on it.

### 4.3 Fusion rules

1. **Members.** Reports/hooks register members; the agent roster (`.codebuddy/agents/*.md` at project and
   user level) registers resident gremlins; ghost records represent summoned subagents; floor scans add
   sessions. A member with no active reporting has `reported=false` and is shown as "passively observed".
2. **Messages.** `source='report'` for reported messages, `source='watch'` for legacy directory-derived
   messages. `dedupe_key` makes replay idempotent; report wins.
3. **State.** Only `busy` / `idle` / `blocked` (see §5). No heartbeat or inferred liveness participates.
4. **Fields.** Progress, files, elapsed time and artifacts come only from reports/floor readers. When
   unavailable the UI shows `—`; it never invents a value.

### 4.4 Three non-negotiable constraints

- **Read-only:** WorkGremlin never modifies an observed product's data or source files.
- **No fabrication:** unobservable fields are placeholders; no historical value may impersonate a live one.
- **Idempotent:** every write is deduplicated or keyed, so replay, restart and mixed sources cannot create
  duplicate messages or tasks.

---

## 5. Workstation state semantics

### 5.1 Model overview

```
Any moment: each member has exactly one state: busy | idle | blocked

busy    := the selected session has a running task
blocked := the selected session has an explicit authorization wait
idle    := neither of the above
```

- **`busy`** includes tool calls, file reads/writes, patch generation, tests, **and "thinking / waiting
  for the model"** inside a running task.
- **`blocked`** is an explicit wait on an external actor. Today the hook dispatcher writes it only for
  permission/authorization requests (`reason = awaiting_permission`).
- **`idle`** means no running task and no explicit wait. It does not mean "the process is alive"; liveness
  is not modeled.

**States that do not exist:** `offline`, `online`, `error`, `thinking`, `unknown`, `degraded`.
Adding one requires a design change, not a local tweak.

### 5.2 Inputs

| Source | Fields | What it provides |
| --- | --- | --- |
| `register` | `memberId, name, role?, sessionId?, client?` | Existence and identity |
| `task/start` | `memberId, taskId?, title, sessionId?, parentTaskId?` | Opens a running task → busy for that session |
| `task/progress` | `memberId, taskId, progress, files?, sessionId?` | Keeps the task running; clears that session's blocked row |
| `task/end` | `memberId, taskId, state: done \| failed \| cancelled` | Ends the task; idle when no other task runs in that session |
| `message` | `from, to?, type, subject?, content` | Conversation stream; **not** a state input |
| `file/touch` | `memberId, path, op: read \| write` | File activity for the task details/office tooltip |
| `hook` | Raw product event | Tasks, files, tool usage, ghosts, blocked/unblocked |
| Floor readers | Sessions, transcripts, tokens, phase | Supplementary detail; not a workstation state |

`task.progress` is optional data. Reporting it does not gate or prolong any state; not reporting it is
normal.

### 5.3 Derivation algorithm

```
input: member, selected session, tasks, session_status

if session_status[member, session].state == 'blocked':
    return BLOCKED with state_since = session_status.state_since
if exists task in session with task.state == 'running':
    return BUSY with state_since = task.started_at
return IDLE with state_since = member.created_at
```

- **`pending` tasks are not running** and therefore do not make a member busy.
- **`done` / `failed` / `cancelled` tasks** do not make a member busy.
- **`failed` is a task outcome, not a workstation state.** The task record shows it; the member simply
  returns to idle/busy based on remaining running tasks.
- **Priority on the member card** (`buildMemberCard`): `blocked > busy > idle`; within the same priority
  the earliest `stateSince` wins. A card is an aggregate across sessions.
- **Renderer priority for the selected session**: `blocked (same session) > running task (same session) >
  borrowed summon busy > idle`. State never leaks between sessions.
- **Borrowed busy**: a resident gremlin may borrow busy from a same-named ephemeral ghost while that
  ghost works. This is a display state stored in `agent_status`, not task liveness.

**No timeout is a state input.** There is no elapsed-time threshold, no heartbeat timeout, no TTL and no
automatic offline/error transition. A running task remains busy until an explicit end event or an explicit
session reconciliation closes it.

### 5.4 State definitions

#### `idle`

- **Derivation:** no running task and no blocked row for the selected session.
- **Entered:** after `task/end`; after registration with no task; after a blocked row is cleared with no
  running task.
- **Exited:** a task starts running, or an authorization wait is recorded.
- **Card text:** `Idle`; when a task just finished, the footer shows "last active MM-DD HH:mm".
- **Color:** green (`#22C55E`); icon `○`; static status bar.

#### `busy`

- **Derivation:** a task in the selected session has `state='running'`.
- **Entered:** `task/start`, or a `task/progress` for a running task.
- **Exited:** `task/end` with `done` / `failed` / `cancelled`; if either result leaves no other running
  task in the session, the member returns to idle.
- **Includes:** thinking and waiting for the model, tool gaps, long tool runs with no events.
- **Card text:** `Busy · {current action}` when an action is known, otherwise `Busy`.
- **Color:** blue (`#3B82F6`); icon `◐`; animated left status bar when motion is allowed.

#### `blocked`

- **Derivation:** a `session_status` row with `state='blocked'` for the selected session.
- **Entered:** the hook dispatcher sees a permission/authorization request
  (`PermissionRequest` / permission `Notification`), with `state_since` set at that moment.
- **Exited (cleared):** task progress; task end; session end; idle notification. Clearing affects **only
  that session**.
- **Scope:** per session. Another session of the same member continues busy/idle independently.
- **Card text:** `Blocked`; when the hook phase reports the awaiting tool/file, the office tooltip may show
  it. If no reason is known, show `Blocked` and **do not invent a reason**.
- **Color:** amber (`#F59E0B`); icon `⚠`; amber card edge while blocked.

### 5.5 Boundary decisions

| Scenario | Decision | Reason |
| --- | --- | --- |
| Task dispatched but not started (`pending`) | **idle** | Nothing is producing yet |
| Task running, model thinking / waiting for an LLM reply | **busy** | Thinking is part of the running task |
| Gap between two tool calls | **busy** | The task is still running; no flicker to idle |
| No tool calls for a long time, task still running | **busy** | The task row is the truth; this is not evidence of blocking |
| Waiting for permission / hook confirmation | **blocked** (`awaiting_permission`) | A real external actor must act |
| Running a tool while also waiting for a reply | **busy** | Production has priority; the wait is secondary |
| No events for 60 s / 5 min / 1 h | **state unchanged** | There is no heartbeat or TTL; silence is not a state transition |
| A member's task process died | **state unchanged until an explicit end/reconciliation** | No timeout-based inference and no fabricated `offline` |
| Member never reported | **idle** + passive-observation badge | `reported=false`; fields that are unavailable stay empty |

### 5.6 `blocked`: establishment and clearing

**Establishment.** Blocked is explicit and session-scoped. The hook dispatcher writes it when a product
asks for permission (for example Claude/Codex permission requests, Kilo pending tool states). It is not
inferred from "no activity".

**Reason.** `reason` is not persisted: `session_status` stores only `state`, `state_since` and
`updated_at`. The only conceptual reason today is `awaiting_permission`; the UI may show the awaiting
tool or file from the hook phase. If it is unknown, show no reason rather than guessing.

**Clearing (any of):**

1. `task/progress` for that session (progress proves the task is active again);
2. `task/end` for that session's task;
3. session end / session-list reconciliation;
4. an idle notification from the product.

**Rules:**

- Clearing a session's block never changes another session's block or running task.
- There is no state stack. After clearing, the derivation simply re-evaluates: running task → busy,
  otherwise idle.
- There is no "manual unblock" button; that would be reverse control (P2-1).
- No duration-based auto-clear exists. A long block stays blocked until an explicit event clears it.
- Deadlocks between members are display-only; the app does not intervene.

### 5.7 Retired axes

The following concepts were removed and must not appear in UI, protocol or tests:

| Retired | Why / replacement |
| --- | --- |
| Business heartbeat (`/heartbeat`, `last_heartbeat_at`) | Task start/end is enough for state and last-active. No lease to renew |
| Heartbeat timeout / liveness gate | Silence cannot distinguish thinking, a dead process and a long tool run. No timeout may change state |
| Member TTL / lease renewal | Same reason; state is derived from persisted task rows |
| `offline` | The server is expected to be running while it observes; members are idle or busy. A member that disappears from a session list has its running tasks explicitly closed as cancelled by reconciliation |
| `online` | Redundant with idle |
| `error` as a member state | A failed task is `tasks.state='failed'`; the member returns to idle/busy. Errors remain visible in task records and messages |
| `unknown` | Unavailable data is an empty field, not a state |
| `degraded` flag / grey inferred state | Passive members are marked `reported=false`; unavailable fields stay empty. There is no inferred state to warn about |
| `source='timeout'` | Data source is only `report` or `watch` |
| Message type `heartbeat` | Removed from the enum; no heartbeat messages are stored |

**Consequence for "the agent died".** If a process dies without reporting an end, the task row remains
`running` until the product or the session reconciliation ends it. WorkGremlin deliberately does not guess.
This is the price of never fabricating a state.

### 5.8 Transitions

Because states are derived, every transition is just a re-evaluation after an event:

| From \ To | idle | busy | blocked |
| --- | --- | --- | --- |
| **idle** | no-op | `task/start` | authorization wait recorded |
| **busy** | `task/end` with no other running task | no-op (another task starts) | authorization wait recorded; the task stays running |
| **blocked** | block cleared, no running task | block cleared, running task exists / task starts | no-op |

- Any state may move to any other state; there are no "illegal transitions" and no synthetic intermediate
  states.
- `X → X` does not change `state_since`.
- Multiple events in one tick produce one UI push with the final derived state.
- The renderer may batch updates in a 100–200 ms window, but end-to-end P95 must stay ≤ 300 ms.

### 5.9 Progress display

- The workstation card **does not draw a progress bar**. `task.progress` usually only holds 0 at start and
  1 at end, so a bar would invent a middle that does not exist.
- Progress values may still be stored and shown in task details when a real value exists. A missing value
  is shown as `—` or omitted, never as 0%/100%.
- The card never animates an indeterminate progress bar.

### 5.10 Display matrix

| State | Color | Icon | Text template | Missing data |
| --- | --- | --- | --- | --- |
| `idle` | `#22C55E` | `○` | `Idle`; footer: last active | Task → not shown; time → `—` |
| `busy` | `#3B82F6` | `◐` | `Busy` / `Busy · action` | Task title missing → `(unnamed task)`; time → `—` |
| `blocked` | `#F59E0B` | `⚠` | `Blocked` | Reason unknown → no invented reason |

**Auxiliary badges (not states):** `Passive observation` (`reported=false`) · `Slower than expected` ·
`Long block`.
**Accessibility:** state is distinguishable by color, icon shape and text. Provide color-blind palettes,
high contrast and reduced motion. When motion is reduced, spinning/flowing effects become static.

### 5.11 FAQ

**Q: What makes a member busy, and when does it return to idle?**
Busy means a running task in the selected session. The only path back to idle is the end of the last
running task (or a session reconciliation closing it). There is no "silent for N seconds → idle" rule.

**Q: Who clears blocked?**
An explicit event: progress, task end, session end, or an idle notification. The UI never offers a manual
unblock.

**Q: What if a process dies?**
The state does not change by itself. The task row stays running until an explicit end/reconciliation; no
timeout guesses. This is intentional.

**Q: Where did `error` / `offline` / `degraded` go?**
They were removed with the heartbeat model. A failed task is a task outcome; a vanished member is a member
whose tasks were explicitly closed; passive observation is marked by `reported=false`. Nothing is inferred.

---

## 6. Workstation view

### 6.1 Card fields

| Field | Source | Missing behavior |
| --- | --- | --- |
| Name / role | roster + `register` | Fall back to the member id; role `—` |
| State badge | derived (§5.3) | Always one of busy/idle/blocked |
| Current task | `task.title` of the selected session's running task | `Idle` |
| Description (subagents) | Agent definition file | Hidden |
| Time | Running: task start ("Started MM-DD HH:mm"); idle: latest task start/end ("Last active MM-DD HH:mm") | `—` |
| Passive badge | `reported=false` | Hidden |

Ghosts do not take a card slot; only resident members are listed.

### 6.2 File activity semantics

`file_activity.op` has two values: **`read`** and **`write`**. (The planned `edit` value was not
implemented; do not document or expect it.)

| op | Meaning | UI |
| --- | --- | --- |
| `read` | A read-only access | Muted grey icon |
| `write` | A create, edit or full overwrite | Highlighted accent bar |

Rules: one tool call yields one record; a create counts as `write`; a missing `op` from a writer defaults to
`write` (never `read`); repeated same-path operations within a short window collapse to one row; delete is
not reported. File activity is retention-limited to the latest 200 rows per member.

### 6.3 Auto-refresh

- State/task changes are pushed over WebSocket; `member.status` is merged over a 200 ms window.
- Target: P95 ≤ 300 ms from ingest receipt to DOM update; P99 ≤ 800 ms.
- Show "last updated N s ago" in the connection bar. A stale connection is shown as a connection problem,
  never as a changed member state.
- There is no manual refresh button.

### 6.4 Member scale and layout

| Condition | Layout |
| --- | --- |
| ≤ 4 | Comfortable grid, all fields visible |
| ≥ 5 | Compact cards (name, state, single-line task, time) — **planned, not implemented** |
| ≤ 16 | Single page, responsive grid |
| > 16 | Pagination / collapse by project — **planned, not implemented** |

Sorting: `blocked > busy > idle`, then by `stateSince` ascending, so blocked members are always visible first.

### 6.5 Acceptance checklist

| ID | Acceptance |
| --- | --- |
| AC-W1 | With 16 concurrent members, every `data-testid=seat-card-{memberId}` field belongs to that member (no cross-talk) |
| AC-W2 | A member with no task shows `Idle`; a member with a running task shows `Busy`; no state changes when no event arrives |
| AC-W3 | A member that never reports shows the passive badge and `—`/empty fields, never guessed numbers |
| AC-W4 | Passing another member's session does not leak its task or blocked state (session-scoped selection) |
| AC-W5 | A permission wait shows `Blocked`; clearing it with progress or task end returns to busy/idle immediately |
| AC-W6 | 5 members trigger compact mode (when implemented), preserving name/state/task/time |
| AC-W7 | No progress bar or fake percentage is rendered on a card |

---

## 7. Conversation view

### 7.1 Message fields (current schema)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | yes | Monotonic cursor for pagination |
| `dedupe_key` | TEXT UNIQUE | yes | Idempotency; `watch` uses `sha1(memberId|ts|from|sha1(content))` |
| `project_id` | TEXT | yes | Ownership key |
| `ts_ms` | INTEGER | yes | Event time from the reporting side |
| `from_member` | TEXT | yes | Member id, `system` or `user` |
| `to_member` | TEXT | no | `NULL` = broadcast |
| `type` | TEXT | yes | See §7.2 |
| `subject` | TEXT | no | Short title / summary |
| `content` | TEXT | no | Body (redaction is planned, see §8) |
| `task_id` | TEXT | no | Related task |
| `session_id` | TEXT | no | Session that produced the message |
| `source` | TEXT | yes | `report` / `watch` |
| `raw_json` | TEXT | no | Original payload (also subject to redaction when implemented) |
| `archived_at` | INTEGER | no | Archive marker (archive logic not implemented) |
| `content_truncated` | INTEGER | yes | 1 = body stored truncated |

**Not present today:** `ingested_at_ms`, `reply_to`, `redacted`, `redaction_version`, `redaction_hits`,
`hit_count`. These belong to planned work (§8, §13), not to the current schema.

Display order: `(ts_ms ASC, id ASC)`. If a clock jump makes `ts_ms` go backwards, keep insertion
order as the tiebreaker and mark the row as a time anomaly.

### 7.2 Message types

| type | Meaning | UI label | In stream | Default visible |
| --- | --- | --- | --- | --- |
| `task_assign` | Assignment / task request | Assign (blue) | yes | yes |
| `task_update` | Progress update / partial output | Progress (light blue) | yes | yes |
| `result` | Result / delivered output | Result (green) | yes | yes |
| `question` | Question / request for information | Question (purple) | yes | yes |
| `review` | Review feedback | Review (teal) | yes | yes |
| `block` | Declared block / unmet dependency | Blocked (amber) | yes | yes |
| `error` | Error / failure report | Error (red) | yes | yes |
| `shutdown` | Stop/exit signal | Stop (grey) | yes | yes |
| `system` | System/tool/environment message | System (grey) | yes | no (toggle) |

`heartbeat` is **not** a message type. There is no heartbeat row to filter.

### 7.3 "No loss, no duplicates" acceptance

| ID | Acceptance |
| --- | --- |
| AC-M1 | The same batch of 1000 messages delivered twice (including both sources with the same key) yields `COUNT(*) = COUNT(DISTINCT dedupe_key) = 1000` |
| AC-M2 | A message first stored from `watch` then reported from `report` keeps one row, `source='report'`, with non-empty fields filled |
| AC-M3 | After `kill -9` and restart, replaying the same data creates no duplicate; no half-written row |
| AC-M4 | A truncated/rotated source file triggers a full rescan; dedupe prevents duplicates and an event is recorded |
| AC-M5 | 100,000 messages display in strict `(ts_ms, id)` order |
| AC-M6 | Out-of-order arrivals are stored by ingestion order and displayed by `ts_ms`; an out-of-order event is recorded |

### 7.4 Filter semantics

- **Member filter:** multi-select is OR over "involved" (sender or recipient). Provide direction:
  all / sent only / received only. Broadcast messages count when the sender matches; a "include broadcast"
  toggle defaults on.
- **Time range:** closed interval `[start, end]`, millisecond precision. Relative presets are fixed at the
  moment the view opens; a refresh button re-evaluates. Filtering uses `ts_ms` (fallback to ingestion order
  only for a flagged clock anomaly).
- **Type filter:** multi-select OR. `system` is excluded by default with a "show system messages" toggle.
- **Combination:** member AND type AND time AND keyword.

### 7.5 Search

| Item | Rule |
| --- | --- |
| Case | Case-insensitive |
| Scope | `content` + `subject`; task title and file paths are planned. Member names are not searched (use the member filter) |
| Multi-word | Space-separated = AND; quoted phrase = exact |
| Minimum length | Any non-empty query; short queries use a different path |
| Debounce | 200 ms |
| Highlight | `<mark>`; cap highlights per row to avoid jank |
| Count | Show `matched / baseline` |
| Sort | Newest first by default, with an ascending toggle when supported |
| Tokenizer | FTS5 `trigram` is planned. **Current query layer uses `LIKE`; FTS is not wired** |
| Short queries | 1–2 characters must use a time-bounded `LIKE` scan when FTS is enabled; otherwise use `LIKE` for all lengths |

**Current status:** only `LIKE %q%` is implemented. The `messages_fts` table and triggers exist, but no query
uses them. The short-query fallback, ranking toggle and prompt copy described below are requirements for the
search work, not shipped behavior.

When search is implemented:

- 1–2 characters: automatic `LIKE`, newest first, never a fake relevance score.
- ≥ 3 characters: FTS trigram with optional relevance (`bm25`) / time sort.
- Results must state the active mode ("contains-match mode", "by time").
- `LIKE` must be bounded by a `LIMIT` and a default 7-day window unless the user explicitly widens it.
- A query taking > 800 ms aborts with "query timed out, partial results shown" and records an event.
- An empty result shows "No messages match" plus a "clear filters" action, never a blank panel.

### 7.6 Scrolling

- Auto-follow the newest message while the view is at the bottom.
- Scrolling up more than one screen pauses follow and shows `N new messages ↓`.
- Clicking the badge returns to the bottom and resumes follow.
- AC-S1: appended messages keep the viewport pinned; after scrolling up two screens no automatic jump occurs;
  clicking the badge restores follow.

### 7.7 Capacity and retention

| Layer | Rule |
| --- | --- |
| Rendering | A 500-message in-memory window today; virtual scrolling is planned |
| AC-P1 | With 100,000 stored messages, DOM message nodes ≤ 80, scroll ≥ 55 fps, memory growth ≤ 200 MB |
| AC-P2 | With 10,000 messages, any filter/search combination responds in < 200 ms |
| Message retention | 90 days or 100,000 messages per project (first threshold wins) — archive logic is not implemented |
| Over-limit | Export JSONL → verify row counts → delete; never delete first |
| Backpressure | A burst > 1000 messages is batched and pushed with a 100 ms throttle; show "catching up +N" |
| Truncation | A body > 800 characters is stored truncated (`content_truncated=1`) and can be expanded |

### 7.8 Pin / detail / export (planned, P1)

- Pin messages to a top area with a local note; pinned items are exempt from retention/hiding; export includes
  them by default.
- Detail drawer: full body, redacted raw JSON, meta (tool/duration/tokens), clickable related files.
- Export: current filtered result only; dialog states count, range and active filters; Markdown / JSONL;
  limit 50,000 rows per export.

---

## 8. Message redaction (P0-7, **not implemented**)

> This section is a requirement, not a description of current behavior. Today messages are stored as
> reported; there is no `redact()` step, no redaction columns and no "view original" channel.

**Definition.** Redaction is an irreversible transformation **before** the row and its FTS index are
written. Original text must never enter `content`, `subject` or `raw_json`.

### 8.1 Rules (replace with `***`)

| # | Rule | Regex sketch | Priority |
| --- | --- | --- | --- |
| 1 | OpenAI / generic `sk-` key | `sk-[A-Za-z0-9_-]{16,}` | high |
| 2 | AWS access key id | `AKIA[0-9A-Z]{16}` | high |
| 3 | GitHub token | `gh[pousr]_[A-Za-z0-9]{16,}` | high |
| 4 | JWT | `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` | high |
| 5 | Private key block | `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----` | highest (run first) |
| 6 | Key/value leak | `(password\|passwd\|pwd\|token\|secret\|api_key\|apikey\|access_key\|authorization)\s*[:=]\s*["']?\S+["']?` | medium (replace the value, keep the key name) |
| 7 | URL credentials | `\w+://[^/\s:@]+:[^/\s@]+@` | medium (replace `user:pass@`, keep host) |

Execution order: private key → key/token rules → URL credentials → key/value. A fragment matched by several
rules is replaced once. Hit metadata is stored separately (`redaction_hits`), never in the body.

### 8.2 False positives

Prefer over-redaction to leakage, but make it discoverable and reversible via an allowlist. A rule must
never empty the whole message (content retention ≥ 20%; otherwise skip that rule and warn), never rewrite
code identifiers on the left side of `=`, and never redact the bare word `token` without a separator.
Every redacted message carries a visible marker; rule versions support a one-way rescan.

### 8.3 Search on redacted text

Search matches only the redacted text. Searching for a secret returns nothing (and the UI explains why);
searching surrounding context still works; searching `***` finds redacted messages. Exempted messages are
searched as stored. Tests must assert against redacted text, not the original report.

### 8.4 Display and count

- List row: shield/star badge when `redacted=1`.
- Drawer: banner `Redacted · N hits`.
- Export: each row header `[redacted N]`.
- `redacted=0`: no badge.
- Show the hit count, never the matching rule names (avoid leaking the rule set); rule details go to the local
  audit event log.

### 8.5 "View original" channel (planned, M3)

- Default **off**: no original is stored; the entry is disabled with an explanation; never render a
  half-mask such as `sk-***abc`.
- Enabling takes three steps: risk dialog (leak paths: screenshots, clipboard, screen sharing/OCR,
  logs/issues), two explicit checkboxes, and typing `Enable original channel` exactly.
- Key handling: OS keychain first, passphrase-derived key as fallback; the passphrase never touches disk or
  the network. Unlock is required on every app cold start and after 15 idle minutes.
- Viewing uses a mask that reveals only while the mouse is held or space is pressed; re-mask on release,
  drawer close, window blur, lock/sleep, 60 s temporary pin, or 5 s in background.
- Copy defaults to redacted text; copying the original needs a separate confirmation and clears the clipboard
  after ~30 s when possible.
- Every reveal/copy/export/unlock/enable/disable writes an audit event without content. Audit retention: 30 days.

### 8.6 Acceptance summary

| ID | Assertion |
| --- | --- |
| AC-R0 | A 1000-character log with one key keeps ≥ 980 characters and changes only the key |
| AC-R1 | After storing all seven rule samples, a file-level `grep -F` on the DB finds no original secret |
| AC-R2 | Allowlisted fragments stay unchanged and the row has `redacted=0` |
| AC-R3 | A rule-version rescan is idempotent |
| AC-R4 | Multiple matching rules replace one fragment once and record the rule list |
| AC-R5 | Row badge, drawer count and export marker all appear; `redacted=0` has none |
| AC-R6–R10 | The view-original flow follows §8.5 (default off, three-step enable, re-unlock, keyboard-only, ESC levels) |
| AC-RS1–RS4 | Search semantics in §8.3 |

---

## 9. Feature list and acceptance

### 9.1 P0

| ID | Feature | Acceptance |
| --- | --- | --- |
| **P0-1** | Workstation view | Three states, automatic refresh, no manual refresh button, 16-member no-cross-talk target; see §6.5 |
| **P0-2** | Conversation view | Full message stream (not one member's inbox); time / sender → recipient / type / content; see AC-M1–M6, AC-S1, AC-P1 |
| **P0-3** | Ingest and persistence | Route B reporting + floor readers; SQLite; 90-day / 100k retention target. No heartbeat and no liveness inference |
| **P0-4** | Project scope | `project_id` in every core table; switching shows only that project's data, with zero cross-project leakage |
| **P0-5** | Connection and self-explanation | WS status and polling fallback; last sync time; exponential reconnect. A connection problem never changes a member state |
| **P0-6** | Demo mode | A UI action creates an isolated demo project with deterministic data, visually marked as demo |
| **P0-7** | Message redaction | Requirements in §8; **not implemented** |

### 9.2 P1 (M3)

| ID | Feature | Acceptance |
| --- | --- | --- |
| P1-1 | Desktop packaging (AppImage/deb/NSIS/dmg, x64 only) | Install/launch on all three platforms; parameterized scripts; automated install/upgrade/uninstall where practical |
| P1-2 | Timeline and throughput charts | Task distribution, member throughput, message volume; first paint < 2 s at 100k messages |
| P1-3 | Session export (Markdown / JSONL) | Export the current filter; dialog states scope; Markdown contains participants, timeline and related tasks |
| P1-4 | Archiving and retention | Export JSONL, verify counts, then delete; abort on any failure |
| P1-5 | Dark theme | Follows the system; meets the contrast requirements |
| P1-6 | Read-only light actions | Mark read, export, copy redacted text, pin. Copying original follows §8.5.6. **No commands are sent to agents** |

### 9.3 P2 (deferred)

| ID | Feature | Note |
| --- | --- | --- |
| P2-1 | Reverse control (assign/interrupt/retry) | Not in this stage; requires a runner capability review; no dead UI entry points |
| P2-2 | Multiple workspaces | Architectural reservation only |
| P2-3 | Crash replay / event time travel | Depends on a fully populated `events` table |
| P2-4 | Tauri migration evaluation | Electron ~100 MB is accepted for now |
| P2-5 | Network drive / WSL production support | Readers degrade to empty data; no degraded flag |
| P2-6 | Alerting rules | Requires a notification design; see §9.4 |

### 9.4 Notifications (not implemented)

| Item | Requirement |
| --- | --- |
| Form | System notifications only; never sound. App-internal badges when unfocused is unavailable |
| Default | Off (`notifications.enabled=false`); user opts in |
| Quiet hours | Off by default; no preset period; offer a `22:00–08:00` template that is disabled until enabled |
| Trigger set | With three states, the old `error` / `offline > 60 s` triggers are invalid. The only candidate event is **`blocked` lasting longer than 10 minutes**. The final trigger policy must be redesigned before implementation |
| Aggregation | Per member + event type, at most one notification per 5 minutes; no repeats while unfocused beyond the window |
| Popup | Only when the window is unfocused; otherwise use an in-app banner. Request OS permission once, never repeatedly |
| Click | Focus the window and scroll to the member card |
| AC-N1 | With notifications on and the window unfocused, three blocks within 5 minutes yield exactly one notification |
| AC-N2 | The old "offline period" aggregation is retired with the offline state |
| AC-N3 | When focused, no system notification is shown; an in-app banner is used |
| AC-N4 | Quiet hours suppress popups while still updating the unread badge |

---

## 10. Non-functional requirements

| ID | Requirement | Metric / acceptance |
| --- | --- | --- |
| **NF-1** | Real-time | State change from ingest to DOM: P95 ≤ 300 ms, P99 ≤ 800 ms |
| **NF-2** | 16 members without cross-talk | 16 concurrent same-named fields map one-to-one per `data-testid` |
| **NF-3** | 100k messages | DOM ≤ 80 nodes, ≥ 55 fps, memory growth ≤ 200 MB; 10k-message filter/search < 200 ms |
| NF-4 | Cold start | Restore state and recent 200 messages/member within 10 s |
| NF-5 | Local-first / privacy | All data local; no outbound requests; telemetry off by default |
| NF-6 | Data safety | DB file permissions limited to the current user; export audits kept 30 days; redaction per §8 |
| NF-7 | Offline usable | With no network and disconnected sources, history remains browsable/searchable/exportable in read-only mode |
| NF-8 | Robustness | Malformed input (truncated JSON, invalid UTF-8, a 10 MB line, deep nesting) is skipped and counted, never crashes; survives 10 `kill -9` cycles without half-written rows |
| NF-9 | Resource use | Idle CPU ≤ 2% average, RSS ≤ 300 MB; under load ≤ 400 MB |
| NF-10 | Cross-platform | x64 only; platform-native shortcuts (Ctrl/Cmd) |
| NF-11 | Testability | Injectable clock, `createServer()` factory, core independent of Electron, stable `data-testid`s, deterministic IDs |
| NF-12 | Self-explanation | Empty-state guidance ("no data source detected? configure a path"), hover legends, understandable without docs within 3 minutes |

---

## 11. Competitor reference

| Product | Observation | What we borrow | What we deliberately do not do |
| --- | --- | --- | --- |
| Claude Code Agent Monitor | Hook → HTTP → SQLite → WS; state machine; history import; periodic orphan sweep | Event-driven push, explicit state machine, cold-start backfill, operational cleanup | Session-based 5-column Kanban; cost/billing |
| claude-view, AgentMonitor | Lightweight local process; instance lifecycle view | Compact situational view; distinguish "never appeared" from "was active" | Terminal-style presentation; starting agents (P2-1) |
| n8n | Execution list, node I/O drill-down, PIN data, retry | Message drawer, pin semantics, task chaining | Workflow canvas |
| Node-RED | Status dots with custom text, debug sidebar | Color + text status pattern; high information density | Flow programming UI |
| Dify | Per-step duration and tokens, tracing timeline | Duration meta, "slower than expected" badge, timeline lanes | Cloud collaboration and accounts |
| tmux | One-line summary, silence alerts | Silence is visible, but **not** a state transition (no heartbeat/TTL) | Terminal UI |

**Differentiation:** resident workstation cards with an unambiguous three-state model, plus a traceable
message and task record. We do not do billing, orchestration of monitored teams, cloud, terminal UI or
reverse control. The council chamber (§15) is the only capacity exception, and it orchestrates its own
one-off read-only processes.

---

## 12. Open questions

| # | Question | Status | Conclusion |
| --- | --- | --- | --- |
| **Q1** | Distinguish read/write file operations? | Decided | `op ∈ {read, write}`. The planned `edit` value was not implemented and is retired. Read is muted, write is highlighted (§6.2) |
| **Q2** | Progress from reports or derivation? | Decided | The workstation card has **no progress bar**. Store progress when reported; show `—` when missing; never fabricate |
| **Q3** | Member limit and compact mode? | Decided / planned | Target 16; compact ≥ 5 and pagination > 16 are requirements not yet implemented (§6.4) |
| Q3-1 | What compact mode keeps | Specified | Name, role, state, single-line task, time; blocked reason when known |
| Q3-2 | Sorting alternative | Open | Default abnormality-first; a "role order" setting is possible |
| **Q4** | Sound / system notifications? | Revised | Not implemented. Only `blocked` is a plausible trigger; no sound; default off; see §9.4 |
| Q4-1 | Trigger set and aggregation | Revised | Old `error` / `offline` triggers removed. Redesign around `blocked` before implementation |
| **Q5** | Redaction / encryption at rest? | Decided | Redact before persistence (§8); not implemented. Do not encrypt SQLite (planned); use file permissions |
| Q5-1 | Encrypt the SQLite file? | Open | Recommendation: no; local trusted environment, FTS and debugging matter. Revisit SQLCipher if requested |
| **Q6** | Accept a ~100 MB Electron package? | Accepted | Yes; revisit Tauri after M3 |
| **Q7** | Reverse control? | Decided: no | Architectural reservation only; no dead UI |
| Q7-1 | Local strong auth later? | Deferred | Token + confirmation + audit if reverse control happens |
| **Q8** | Quiet hours default? | Decided | Off by default; `22:00–08:00` template prefilled but disabled |
| **Q9** | Store originals behind an encrypted channel? | Decided / planned | Default off; three-step enable; OS keychain; re-unlock per session; audit (§8.5) |
| **Q10** | Chinese FTS tokenizer and short queries? | Decided / planned | FTS5 trigram; 1–2 characters fall back to time-bounded `LIKE`; never mix rankings |
| **Q11** | macOS notarization? | Decided | Ad-hoc signing plus four explicit "not notarized" notices |

---

## 13. Alignment checklist with the implementation

This table records what the documents promise versus what the code does **now**. It replaces the old
"team vs project / heartbeat" delta list.

| # | Area | Current code | Requirement | Status |
| --- | --- | --- | --- | --- |
| 1 | Workstation states | `busy / idle / blocked` | Same | **Aligned (2026-10-21)** |
| 2 | Liveness | `tasks.state` only; WS ping is transport-only | No heartbeat/TTL | **Aligned** |
| 3 | `agent_status` | Only borrowed busy; `state='busy'` CHECK | Display-only borrowed busy | **Aligned** |
| 4 | `session_status` | Only blocked; per session | Per-session authorization wait | **Aligned** |
| 5 | `members.last_seen_at` | Dropped by migration | No last-seen | **Aligned** |
| 6 | `agent_status_history` | Dropped | No history table | **Aligned** |
| 7 | `source` | `report / watch` | No `timeout` | **Aligned** |
| 8 | `/heartbeat`, `/status` | Removed | No business heartbeat | **Aligned** |
| 9 | Message type `heartbeat` | Removed | Not a message type | **Aligned** |
| 10 | `file_activity.op` | `read / write` | `read / write` | **Aligned** |
| 11 | Progress bar on cards | Removed | No fabricated progress | **Aligned** |
| 12 | Redaction | Not implemented | §8 required | **Gap** |
| 13 | FTS query wiring | Table/triggers exist; queries use `LIKE` | Trigram + short-query fallback | **Gap** |
| 14 | A-route watcher | Not implemented | Optional; not a current dependency | **Not planned** |
| 15 | Virtual scrolling | 500-row window | 100k smooth scroll | **Gap** |
| 16 | Message archiving | Columns exist; no archive job | Export-then-delete | **Gap** |
| 17 | Notifications | Not implemented | Redesign around `blocked` | **Gap** |
| 18 | Compact mode / pagination | Not implemented | §6.4 | **Gap** |
| 19 | `reply_to`, `ingested_at_ms`, redaction columns | Absent | Planned | **Gap** |
| 20 | Playwright / Electron E2E | Not present | Optional future layer | **Gap** |

---

## 14. Change log

| Version | Date | Changes |
| --- | --- | --- |
| v0.1 | 2026-09-14 | Initial draft: personas, P0/P1/P2, state semantics, message fields, non-functional requirements, competitors, 14 open questions |
| v0.2 | 2026-09-14 | Aligned with the outline and four decisions; introduced the old 5-state + degraded model (now retired) |
| v0.3 | 2026-09-14 | Finalized the old state machine, progress tiers, file op values, redaction requirements and short-query semantics |
| v0.4 | 2026-09-20 | Implementation alignment: `team` → `project`; A route marked unimplemented; protocol v2 |
| v0.5–v0.10 | 2026-10-01 – 2026-10-19 | Council chamber added and iterated: fixed roles, no voting, fail-fast, workspace mode, truncation recovery, `needs_clarification` |
| **v0.11** | **2026-10-21** | **Workstation state refactor: only `busy / idle / blocked`; heartbeat, TTL, `offline`, `error`, `degraded`, `lastSeenAt`, `/heartbeat`, `/status` and the `heartbeat` message type removed. Busy from running tasks; blocked from per-session authorization waits; last-active from task start/end. Requirements updated throughout, including tests, notifications, progress and the alignment checklist** |

---

## 15. Council chamber — the only capacity exception

> This is the boundary-limited exception to the "not an orchestrator" rule in §1. No other "we do not do
> this" conclusion is relaxed.

### 15.1 What it is

Select agents from several floors and hold a meeting on one topic. Roles are fixed: one **moderator**
(decomposes the topic, assigns review focus, writes convergence summaries and hard directives, adjudicates),
one **main answerer** (proposal, revisions, final draft) and one or more **reviewers** (independent structured
reviews). There is **no voting** at any point: no tally, no threshold, no "majority agrees". The configured
rounds run; then the moderator adjudicates and the main answerer delivers the final draft; the report is
archived.

The user sees a summary (convergence score, opinion/blocker/conflict counts, each role's floor/model/tokens)
and a collapsed full record (round 0 plan, every proposal and its diff, every review, the moderator's
directives, adjudication and final draft).

**Where the meeting runs** (orthogonal to roles):

| Switch | Value | Decides |
| --- | --- | --- |
| `workspace_path` | absolute path / `NULL` | The user's real project directory + read-only tools, or a one-off temp directory + read-only tools |

### 15.2 Difference from reverse control (P2-1)

| | P2-1 reverse control | Council |
| --- | --- | --- |
| Target | The **monitored sessions** | A brand-new one-off process started by the council |
| Action | Inject messages, interrupt, retry | Ask a question, collect text |
| This stage | Not done | Implemented (this section) |

The council touches **none** of the monitored sessions: it writes no `members`, `tasks`, `task_runs`,
`messages` or `file_activity` rows. Its data lives in its own tables and is visible only on the council page.
The office and task records remain truth-only; after a meeting they show no trace.

### 15.3 Capability boundary

The council is **always read-only**: participants get read tools, can inspect code, but cannot modify files,
run commands or access the network. `workspace_path` only selects which directory is readable.

| Item | Rule |
| --- | --- |
| Working directory | An absolute path means the user's project (the server never modifies or deletes it); empty means a one-off temp directory that is deleted afterwards. The prompt states that a temp directory is not the user's project and cannot be used as project evidence |
| Tools | Read-only. 1F/4F use `--tools Read,Grep,Glob`; 7F/8F get an injected permission config allowing only `read/glob/grep/list`; 2F uses Cline's `--plan`; 3F uses `codex exec --sandbox read-only`; 6F uses headless `-p` (confirmation-required actions are denied) |
| Files | Read-only. Participants may read code; write tools stay denied |
| Commands / network | Not allowed. 1F/4F expose no execution tool; 7F/8F deny `bash`; the 3F sandbox blocks writes and network. **Honest limitation:** 2F `--plan` and the 3F sandbox may still run read-only commands |
| Background material | Read by the server and inlined verbatim into the prompt; when the directory is empty, the participants rely on this material |
| Environment | Inherited as-is (login state lives in each CLI's home). Isolation relies on cwd + read-only mode, not on moving `HOME`. All recipes inject `WORKGREMLIN_DISABLE=1` |
| Model | Optional per-seat model, stored in `council_participants.model` and passed through that product's own flag (`--model` / `-m`). Blank means the CLI's own default. Because a retired default is invisible to an executable check, every selected floor must pass a one-sentence **preflight** before the meeting is created; a failing floor blocks creation and names its raw reason. Probes run one at a time (parallel cold starts produced false timeouts), 60s each; successes are cached 5 min, failures 1 min |
| Eligible floors | 1F CodeBuddy / 2F Cline / 3F Codex / 4F Claude Code / 6F Qoder / 7F Kilo Code / 8F OpenCode. Other floors do not appear even if their CLI is installed |

**Known imperfections (accepted):**

1. A `kill -9` or hard `process.exit()` can leave a temp directory and in-flight CLI processes until they
   finish their one-off call. Normal `shutdown()` reclaims everything.
2. Participating CLIs may record their own session history. 1F/4F use `--no-session-persistence`; 3F uses
   `--ephemeral`. 2F/6F/7F/8F have no such switch, so records remain in their own history. Moving their data
   directory also moves login state, so it is not an option.
3. 3F/6F/7F/8F "read-only" is each CLI's native mode, not the 1F/4F tool whitelist. It is effective but
   weaker: 3F's sandbox and 2F's plan mode still allow read-only commands.
4. Because cwd may be the real project, isolation must explicitly disable our own reporting
   (`WORKGREMLIN_DISABLE=1`). Otherwise participants would appear as members of the user's project.
5. Council sessions may remain in the products' own history under the user's project. A fixed marker and a
   session-list skip keep them out of the office: 7F/8F use `--title`, 2F stores the prompt as the title and
   is filtered by `COUNCIL_PROMPT_MARKER`, 6F uses `--name` (not yet verified on a machine with the CLI).
   Kilo/OpenCode/Cline/Qoder's own UIs may still show the sessions; we do not delete another product's history.

### 15.4 Flow (fixed roles, no voting)

| Role | Count | Responsibility |
| --- | --- | --- |
| `moderator` | 1 | Round 0 decomposition and assignment; per-round convergence and hard directives; final adjudication |
| `main` | 1 | Round 1 proposal; revisions; final draft and change notes |
| `reviewer` | ≥ 1 | Independent structured review each round (reviewers do not see each other) |

0. **Preflight — can these floors speak?** Before a council row exists, each selected floor answers one short
   sentence using its configured model. A failure is reported as a 400 naming the floor and the raw CLI text
   (auth / model / network / timeout / quota / protocol); no half-built meeting is left behind. This is a gate,
   not a model test: it exists because "the executable exists" and "this floor can answer right now" are
   different facts.
1. **Round 0 — plan.** The moderator decomposes the topic, assigns review focus, and returns
   `{"needsClarification":[...]}` if essential information is missing. The server then ends normally with
   `verdict='needs_clarification'` / `status='done'`, marks later roles `skipped`, and archives the report.
   A pure-text topic is not asked for a path.
2. **Round 1 — proposal.** The main answerer writes the first proposal; later rounds revise it and provide
   `diffFromPrev`.
3. **Review.** Each reviewer returns `ReviewPoint`s:

   ```ts
   interface ReviewPoint {
     reviewer: string;      // written by the server from the seat, never trusted from the model
     severity: "blocker" | "major" | "minor" | "nit";
     dimension: string;
     issue: string;
     evidence?: string;
     suggestion: string;
     stance: "reject" | "revise" | "accept";
   }
   ```

4. **Moderation.** The moderator produces `consensus[]`, `openIssues[]`, `conflicts[]` and
   `revisionDirectives[]`. Directives must be actionable:
   `[issue] must <change>; acceptance: <checkable condition>`. Vague wording is rejected. The server checks
   for missing directives, missing acceptance criteria, unrecorded conflicts, and a final approval that still
   has blockers; it shows consistency warnings without changing the flow or `verdict`.
5. **No early stop for a high score.** Rounds run to `max_rounds` (default 3, hard cap 8). Each round stores a
   `RoundResult`:

   ```ts
   interface RoundResult {
     round: number;
     proposal: { version: string; content: string; diffFromPrev?: string };
     reviews: ReviewPoint[];
     moderator: {
       consensus: string[];
       openIssues: string[];
       conflicts: { topic: string; sides: { reviewer: string; view: string }[] }[];
       revisionDirectives: string[];
       convergenceScore: number;   // server-computed
     };
   }
   ```

6. **Adjudication.** The moderator gives a decision (`approve` / `approve_with_changes` / `reject`), reasons,
   `remainingRisks[]` and `finalDirectives[]`.
7. **Final delivery.** The main answerer delivers the final text and change notes. The report is written under
   `~/.workgremlin/councils/<id>/` (`report.json`, `reviews.csv`, `rounds.csv`, `report.md`; UTF-8 with BOM;
   atomic writes; never overwrite an existing file). **Only there** — never into the user's project.
8. **Verdict:** `completed` / `partial` / `needs_clarification` / `cancelled` / `failed`. `partial` and
   `needs_clarification` are legitimate outcomes, not errors.
9. **Fail-fast.** If any required turn returns `failed` / `timeout`, has no usable event, or cannot be parsed,
   the server stops immediately. Produced rounds, raw failures and the report are still archived; one completed
   round → `partial`, none → `failed`; `council.error` names the round, phase, floor and raw CLI error.
   In-flight participants are marked `failed`; the "working" indicator disappears. A missing role fails before
   any model call. A truncated transcript with a complete prefix is recovered rather than treated as a failure.
   **One retry** is made for a transient `timeout` / `network` failure; `auth` / `model` / `quota` / `protocol` /
   `spawn` failures are never retried (they would repeat the same sentence and waste the budget). The whole
   meeting has a 90-minute wall-clock cap. Every failed turn stores a normalized `council_utterances.error_kind`
   next to the raw text, so "the model is retired" is distinguishable from "the network is down".

**Convergence (server-computed; model-reported scores are ignored):**

```
raw = 100 − (blocker × 25 + major × 8 + minor × 2 + nit × 0 + conflicts × 10)
score = clamp(raw, 0, 100)
```

Weights come from shared constants. `nit` carries no weight; the conflict count is the length of the
moderator's `conflicts`. The score must be explainable: the UI shows the formula and per-severity counts.
With no completed round, show `—`, never 100.

**UI:**

- The right panel holds the summary: score and formula, opinion/blocker/conflict counts, each role's
  floor/model/tokens, ordered by seat.
- The full record is collapsed by default: plan, every proposal and diff, every review (severity, dimension,
  evidence, suggestion, stance), the moderator's summary and directives, adjudication and final draft. A round
  with no diff says so explicitly.
- Every round's raw output remains viewable after the meeting, including floor, phase, status and duration.
  Failed/timeout/unparsed turns show the raw error and an explicit "no text" rather than a blank. Rounds with
  no `RoundResult` (fail-fast/cancel) are shown as "incomplete" with the utterances that did happen.
- The "working" indicator appears immediately: pulsing dot, `Working`, active floors, phase (plan / proposal /
  review / moderation / adjudication / final) and round number. A turn may be silent for minutes; the UI must
  still show that it is running. The server stores and pushes it; a refresh restores it. It disappears on
  complete/failed/cancel.

### 15.5 How the iron rule applies

| Situation | Stored | UI |
| --- | --- | --- |
| Timeout / crash / unparseable output | Real status + raw error; no review is invented; the meeting stops immediately and produced rounds are archived | The role is marked red with the raw error; the working indicator disappears; the round/phase/floor are named |
| Moderator needs more information | `verdict='needs_clarification'`, `status='done'`; the role records it, later roles are `skipped`; the report is archived | Shows "more information needed" and each question; no fake adjudication |
| Truncated transcript with a complete prefix | Recover from the last complete `result`/assistant event; keep the raw tail | Show the recovered utterance, not a false failure |
| Only some review points parse | Store only parsed points; record `parse_dropped` | Never fill in missing severity or stance |
| Model-reported `convergenceScore` | Ignored; `council_rounds.stats_json.score` holds only the server value | Show the server score only |
| Tokens / duration unavailable | `NULL`, not 0 | Show `—`; a partially reported role shows `≥ N` |
| A round has no diff | `diff_from_prev = NULL` | Say "no diff was provided", do not imply nothing changed |
| Material truncated | Store `bytes_total` and `bytes_included` | State the original and inlined byte counts |
| Final round failed | `verdict='partial'`; completed rounds and the report are archived | Mark "partially completed"; do not fabricate a final draft |

### 15.6 Acceptance points

1. Floors without a CLI are greyed out with a reason; when none is available, the entry is disabled.
1a. **Preflight:** a floor whose executable exists but cannot answer (retired model, expired login, broken
    network) is refused at creation with the floor and the raw provider reason; no meeting row is created.
    A per-seat model is passed to the probe and stored on the participant; a blank model uses the CLI default.
2. **Role validation:** missing moderator / missing main / no reviewer / one floor in two roles / a floor
   outside the allowlist / a floor without a CLI → the whole request is rejected with a reason; no silent
   degradation and no half-started meeting.
3. Round 0 plan is visible; round 1 is the main answerer's proposal; every round has reviews and a moderator
   summary.
4. **Convergence** equals `clamp(100 − (25b + 8m + 2n + 10c), 0, 100)`; a model-reported high score has no
   effect (pin this with a 98 vs 99 test). The formula is shown; no completed round shows `—`.
5. **No voting:** no `threshold` or `vote` columns, no vote/agree counts, and no early stop for "nobody
   objected".
6. Directives are hard: issue + concrete change + acceptance criterion; vague wording or missing acceptance
   produces a consistency warning.
7. After the configured rounds there is an adjudication and final delivery (or an explicit `partial`); the
   report is written only under `~/.workgremlin/councils/<id>/`, never overwriting and never copying into the
   working directory.
8. When `diffFromPrev` exists the UI shows the diff; when absent it says so.
9. Participant failures show the raw error; no fake reviews; missing tokens show `—`, partial tokens `≥ N`.
9a. **Fail-fast:** if round 0 cannot be answered, the meeting ends immediately (`failed`) without starting
    proposals/reviews; if one round completed, `partial` and the report is archived; in-flight participants
    are no longer `running`.
9b. **Working indicator:** visible between the start and the first utterance, survives a refresh, disappears
    when the meeting ends.
9c. **Needs-more-information is not failure:** a round-0 clarification request ends with
    `needs_clarification` / `done`; the moderator shows "more information needed", other roles show "not
    reached", and the report is archived. Setting a workspace later does not rerun or rewrite a finished
    meeting.
9d. **Retry, deadline and error kind:** a transient `timeout` / `network` turn is attempted once more; an
    `auth` / `model` / `quota` / `protocol` failure is not. A meeting cannot outlive its 90-minute budget.
    Failed turns store `error_kind`; the UI/report can label "model unavailable" separately from "network
    down" without hiding the raw CLI text.
10. Material truncation is labelled.
11. On server shutdown all child processes are reaped (no orphans) and temp directories are removed.
12. The office and task records show **no trace** of a council.
13. **Real-project mode:** a question that requires reading code (for example "where is this function
    called?") produces real file names/symbols, proving the participant read the project.
14. **The working directory is never modified:** after a project-mode run, `git status` is clean and files are
    untouched. The server deletes only its own temp directories.
15. **The office stays clean in project mode:** after a run, the office, task records and the 7F/8F session
    lists show no participant.
