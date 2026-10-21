# Known Issues and Limitations

This document describes known limitations and unsupported configurations in WorkGremlin. These issues are typically due to constraints in third-party tools or data sources that are beyond WorkGremlin's control.

---

## 1. Unsupported Integrations

### 1.1 TraeCode Plugin (Not Supported)

**Status:** ❌ Not Supported

**Description:**  
WorkGremlin does not currently support the TraeCode plugin. While Trae IDE integration is available, the TraeCode plugin variant is not compatible with WorkGremlin's monitoring infrastructure.

**Impact:**  
Users cannot monitor TraeCode plugin sessions through WorkGremlin. Attempting to use this integration will result in no data being captured or displayed.

**Workaround:**  
None available. Please use supported Trae integration paths instead.

---

### 1.2 GitHub Copilot CLI (Not Supported)

**Status:** ❌ Not Supported

**Description:**  
WorkGremlin does not support GitHub Copilot CLI. The monitoring infrastructure is designed for IDE-integrated agents and cannot capture Copilot CLI sessions.

**Impact:**  
GitHub Copilot CLI usage will not be tracked, and no task records or status information will be available in WorkGremlin.

**Workaround:**  
None available. For Copilot integration, please use the GitHub Copilot IDE extension instead.

---

## 2. Data Limitations

### 2.1 Qoder Plugin: Token Statistics Unavailable

**Status:** ⚠️ Known Limitation

**Description:**  
The Qoder CN extension (Lingma plugin) does not expose token usage data in its local SQLite database (`~/.lingma/vscode/sharedClientCache/cache/db/local.db`). The `chat_record` table only contains:

- `request_id`
- `extra` (contains `originalContent` and `modelConfig.key` only)
- `summary`
- `gmt_create`
- `gmt_modified`

**Critical Missing Fields:**  
No token usage information is available:
- ❌ Input tokens
- ❌ Output tokens
- ❌ Cache read tokens
- ❌ Cache write tokens

**Impact:**  
- Task details for Qoder Plugin sessions will display **"—"** for token statistics instead of actual values
- This is a **data source limitation**, not a WorkGremlin bug
- The UI correctly shows empty values rather than misleading zeros

**Why This Happens:**  
Qoder's design intentionally does not expose token consumption data in its local cache. WorkGremlin can only display data that is actually written to disk by the monitored agent.

**Workaround:**  
None available. Token statistics will remain unavailable until Qoder's extension adds usage tracking to its local database.

**Technical Details:**  
- Data source: `~/.lingma/vscode/sharedClientCache/cache/db/local.db`
- Table: `chat_record`
- Relevant code: `server/src/floorQoder.js` (see `readLingmaRounds` and `writeTurnRun` functions)

### 2.1.1 Qoder Plugin: Current-Round Output and Liveness Are Limited

**Status:** ⚠️ Known Limitation

**Description:**
`chat_record.summary` is context generated for a future Qoder turn, not the answer for the current task. WorkGremlin therefore does not use it as task output or as the session's completion message. Qoder does not expose a trustworthy plaintext current-round answer in `local.db`, so the task output remains empty instead of showing unrelated summary text.

Qoder also does not expose a reliable "round finished" field (`finish_status` remains `0`). WorkGremlin infers completion from request-scoped disk activity after a 90-second silence. If a shell command hangs without writing any new `chat_message` rows, the source cannot distinguish it from a finished round. When the user presses Stop, Qoder writes a terminal tool result containing `toolCallStatus: "CANCELLED"` or `errorCode: 40441`; WorkGremlin uses that explicit signal to change the task to `cancelled` and prevent later session timestamps from restoring it to `running`.

**Impact:**
- A hung command may be shown as completed by inference until Qoder records explicit cancellation.
- Qoder Plugin task output may be empty even when the plugin displayed an answer in the IDE.
- Task status updates depend on Qoder writing the cancellation result to disk.

**Workaround:**
Press Stop in Qoder after terminating a hung command so the explicit cancellation signal is persisted. Avoid interactive commands that wait for input or open a pager (for example, use `git --no-pager log`).

### 2.2 TraeCode IDE: No Subagent Visibility (No Real-Time Ghosts, No Call Traces)

**Status:** ⚠️ Known Limitation

**Description:**  
TraeCode IDE does not send `Task` or `Agent` tool names through its hook system, nor does it emit `SubagentStart` / `SubagentStop` hook events. The hook `PreToolUse` matcher is empty (matches all tools), but the actual tool names reported are limited to: `RunCommand`, `Read`, `Edit`, `Grep`, `TodoWrite`, `Glob`, `Write`, `LS`, `Delete`, `AskUserQuestion`, `WebSearch`, `WebFetch`, `StopCommand`. None of these match `isSubagentTool` (which recognizes `task|agent|spawn_agent|collaborationspawn_agent`), so the ghost lifecycle (`addGhost` on PreToolUse, `finishGhostServer` on PostToolUse/SubagentStop) never triggers.

The only subagent-related signal in `renderer.log` is `IdeSubagentContribution`, but it is **not an invocation record**. It reports that a subagent's generated code was accepted into an editor buffer (`documentUri`, `acceptCodeLength`, `line`). Records with `source=ide_subagent` appear only when the subagent actually writes code; a read-only subagent (analysis, review, retrieval) never produces one. `source=ide_agent` refers to the main agent itself and is deliberately ignored.

**Impact:**  
- The office view will not show small ghosties (小幽灵) when TraeCode IDE summons experts/subagents
- Task details show **no subagent call traces at all** for current TraeCode versions. The `subagent_runs` backfill path exists but has nothing to consume, because the signal it depends on is not emitted
- This is a **data source limitation**: neither the hook stream nor the local logs expose subagent dispatch/return or invocation events

**Why This Happens:**  
TraeCode's hook system only reports tool calls. In a full agent turn the observed `tool_name` values are limited to `RunCommand`, `Read`, `Edit`, `Grep`, `TodoWrite`, `Glob`, `Write`, `LS`, `Delete`, `AskUserQuestion`, `WebSearch`, `WebFetch`, `StopCommand` — no `Task`/`Agent` dispatch tool, and no `SubagentStart`/`SubagentStop` events. A subagent invocation therefore leaves no local trace: it is absent from the hook stream, from `renderer.log`, and from the agent service logs.

**Workaround:**  
- **Real-time ghosts**: Not available until TraeCode adds `Task`/`Agent` tool name reporting or `SubagentStart`/`SubagentStop` hook events
- **Post-completion recording**: Only partially works, and only for code-writing subagents. `flushTraeSubagents` backfills `IdeSubagentContribution` entries with `source=ide_subagent` into `subagent_runs`, but each row has zero duration (`started_at == ended_at`) and no invocation timestamp
- Do not rely on task details to confirm that a subagent ran (for example, to verify that a custom agent such as a user-level agent in `~/.trae-cn/agents/` was actually called)

**Verification (2026-10-21):**  
- `source=ide_subagent` occurrences: **0** in the 2026-10-21 log tree; 88 historical occurrences, all from a single 2026-10-13 session
- Historical rows in `subagent_runs` for `client='trae'`: 88, all attached to one task, all with `started_at == ended_at`
- A read-only subagent run produced 0 `IdeSubagentContribution` records of either source
- The hook log for the same run contained no `Task`/`Agent`/`SubagentStart` entry

**Technical Details:**  
- Hook events source: `~/.workgremlin/hooks/events.log`; Trae-side hook transcript: `<logs>/<launch>/window<N>/agent-hooks.log`
- Subagent contribution source: `<dataRoot>/Trae CN/logs/<launch>/window<N>/renderer.log` (`<dataRoot>` is `~/.config` or `~/.local/share` on Linux)
- Relevant code: `server/src/floorTrae.js` (`allSubagentContribs`, `flushTraeSubagents`), `server/src/ingest/hookCommon.js` (`isSubagentTool`, `addGhost`, `finishGhostServer`)
- Task-detail endpoint: `GET /api/v1/subagent-runs?parent=<task_runs.id>`
- Key event pattern in renderer.log: `[tooling] [IdeSubagentContribution] downstream SDK report started: source=ide_subagent, sessionId=..., operationId=..., documentUri=..., acceptCodeLength=..., line=...`

---

## 3. General Guidelines

### Understanding Data Availability

WorkGremlin follows a **strict data integrity policy**:

✅ **Display only what is actually reported**  
❌ **Never fabricate or assume missing values**  
❌ **Never display 0 when data is unavailable**

When a monitored agent does not provide certain metrics, WorkGremlin displays **"—"** to indicate "data unavailable" rather than misleading placeholders.

### Reporting New Issues

If you encounter limitations not documented here, please:

1. Verify the issue is reproducible
2. Check that your agent version is supported
3. Review agent-specific documentation for known constraints
4. File an issue with:
   - Agent name and version
   - WorkGremlin version
   - Expected vs. actual behavior
   - Sample data files (if available)

---

## 4. Compatibility Matrix

| Agent | Platform | Status | Token Data | Notes |
|-------|----------|--------|------------|-------|
| CodeBuddy | CLI | ✅ Supported | ✅ Yes | Full functionality |
| CodeBuddy | Plugin | ✅ Supported | ✅ Yes | Full functionality |
| Claude | CLI | ✅ Supported | ✅ Yes | Full functionality |
| Copilot | IDE | ✅ Supported | ✅ Yes | Full functionality |
| Trae | IDE | ✅ Supported | ⚠️ Credits only | No token breakdown; no real-time subagent ghosts and no subagent call traces |
| Qoder | CLI | ✅ Supported | ✅ Yes | Full functionality |
| Qoder | Plugin | ✅ Supported | ❌ No | Token data unavailable from source |
| Kilo | CLI | ✅ Supported | ✅ Yes | Full functionality |
| OpenCode | CLI | ✅ Supported | ✅ Yes | Full functionality |
| Cline | CLI/Plugin | ✅ Supported | ✅ Yes | Full functionality (phase inferred by polling the on-disk store) |
| TraeCode | Plugin | ❌ Not Supported | N/A | Integration not available |
| GitHub Copilot | CLI | ❌ Not Supported | N/A | Integration not available |

---

## 5. Future Considerations

### Planned Investigations

- **Qoder Plugin Token Tracking**: Monitor future Qoder releases for token usage exposure
- **TraeCode Plugin Support**: Evaluate feasibility as Qoder's architecture evolves
- **GitHub Copilot CLI**: Assess integration possibilities if Copilot adds local data persistence

### How You Can Help

If you have access to the development teams of these tools, please encourage them to:

1. **Expose usage data** in local caches (Qoder, TraeCode)
2. **Provide hook/event APIs** for external monitoring (GitHub Copilot CLI)
3. **Document their data formats** for third-party integration

---

## 6. Related Documentation

- [Requirements Specification](requirements.md) - System requirements and constraints
- [Implementation Status](implementation-status.md) - Current feature implementation status
- [Roadmap](roadmap.md) - Planned features and improvements

---

**Last Updated:** 2026-10-21  
**Document Version:** 1.1  
**Maintained By:** WorkGremlin Team
