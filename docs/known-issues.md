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

### 2.2 TraeCode IDE: Subagent Ghosts Not Shown in Real-Time

**Status:** ⚠️ Known Limitation

**Description:**  
TraeCode IDE does not send `Task` or `Agent` tool names through its hook system, nor does it emit `SubagentStart` / `SubagentStop` hook events. The hook `PreToolUse` matcher is empty (matches all tools), but the actual tool names reported are limited to: `RunCommand`, `Read`, `Edit`, `Grep`, `TodoWrite`, `Glob`, `Write`, `LS`, `Delete`, `AskUserQuestion`, `WebSearch`, `WebFetch`, `StopCommand`. None of these match `isSubagentTool` (which recognizes `task|agent|spawn_agent|collaborationspawn_agent`), so the ghost lifecycle (`addGhost` on PreToolUse, `finishGhostServer` on PostToolUse/SubagentStop) never triggers.

The only subagent signal available is `IdeSubagentContribution` in `renderer.log`, which fires **after** the subagent has completed its work and its code contribution has been accepted — not when the subagent starts. This makes real-time ghost display impossible.

**Impact:**  
- The office view will not show small ghosties (小幽灵) when TraeCode IDE summons experts/subagents
- Subagent activity is still recorded post-completion from `renderer.log` and appears in task details (see `subagent_runs` table and `/api/v1/task-runs/:id/subagents` endpoint)
- This is a **data source limitation**: TraeCode's hook system does not expose subagent lifecycle events

**Why This Happens:**  
TraeCode's internal subagent mechanism (`IdeSubagentContribution`) is a post-completion reporting system, not a lifecycle event system. The hook infrastructure only reports tool calls, not subagent dispatch/return. Without a "subagent started" signal, there is no trigger to create a real-time ghost entry.

**Workaround:**  
- **Post-completion recording**: Subagent contributions are parsed from `renderer.log`'s `IdeSubagentContribution` events (with `source=ide_subagent`) and stored in the `subagent_runs` table, visible in task details
- **Real-time ghosts**: Not available until TraeCode adds `Task`/`Agent` tool name reporting or `SubagentStart`/`SubagentStop` hook events

**Technical Details:**  
- Hook events source: `~/.workgremlin/hooks/events.log`
- Subagent contribution source: `<globalStorage>/Trae CN/logs/<launch>/window1/renderer.log`
- Relevant code: `server/src/floorTrae.js` (renderer.log parsing), `server/src/ingest/hookCommon.js` (`isSubagentTool`, `addGhost`, `finishGhostServer`)
- Key event pattern in renderer.log: `[tooling] [IdeSubagentContribution] downstream SDK report started: source=ide_subagent, sessionId=..., operationId=..., documentUri=..., acceptCodeLength=...`

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
| Trae | IDE | ✅ Supported | ⚠️ Credits only | No token breakdown; no real-time subagent ghosts (post-completion only) |
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

**Last Updated:** 2026-10-13  
**Document Version:** 1.0  
**Maintained By:** WorkGremlin Team
