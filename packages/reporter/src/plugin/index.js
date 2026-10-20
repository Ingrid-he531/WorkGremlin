/**
 * WorkGremlin plugin for OpenCode / Kilo Code — reports the **true phase** to 8F OpenCode
 * (and any sibling product).
 *
 * ## Why it exists
 *
 * Floors like 7F/8F poll the product's SQLite on disk to infer the phase (see
 * server/src/floorOpencode.js): zero install, works out of the box, but the phase always
 * carries `inferred: true` and the UI greys it out. For OpenCode, polling also has a hole it
 * cannot fill:
 *
 *   Measured on OpenCode 2.0.18: across 114 assistant messages in the whole DB, a tool
 *   block's `state.status` only ever showed **completed / error / running** — never `pending`.
 *   So "this tool is waiting for user approval" is **never persisted**, and polling can never
 *   derive "awaiting permission". OpenCode models approval as separate events
 *   (`permission.asked` / `permission.replied`), pushed only on the in-memory event stream.
 *
 * This plugin subscribes to that stream and writes the phase / completion markers into the
 * reporter state file, so:
 *   · the phase is a **reported truth** (the server does not mark it inferred, the UI does not grey it);
 *   · "awaiting permission" can be shown (the phase polling cannot produce);
 *   · the completion marker can carry the **changed-file list** (taken from `session.diff`,
 *     filtered to this round; polling only has a single `session.summary_files` count).
 *
 * It works without the plugin too — 8F falls back to polling, just with a greyed-out phase, no
 * "awaiting permission", and no file list on the completion marker.
 *
 * ## Event contract — **two generations** (both handled; the event sets are disjoint)
 *
 * ### Kilo / OpenCode v1 (measured 2026-09-27, Kilo 7.8.1, via an in-plugin probe)
 *
 * The envelope is `{ id, type, properties }` (Kilo) — OpenCode's v2 envelope is in the section below.
 * Only these 10 event types are emitted; other vocabularies were measured and never appear here.
 *
 *   session.created        info.directory=workspace path · info.model.id=model
 *   session.updated        info.title · info.model.id (the model often appears only here)
 *   message.updated        info.role · info.finish · info.time.completed · info.path.cwd
 *   message.part.updated   part{type:text|tool|reasoning|step-start|step-finish|patch,
 *                           text, tool, callID, state{status,input}, messageID}
 *   message.part.delta     token-level delta — ignored
 *   session.status         status.type = busy | idle
 *   session.idle           this round has fully ended
 *   session.drained        queue drained
 *   session.diff           diff[] = delta against the **session** snapshot (not "this round", see steppedOf)
 *   session.next.tool.input.delta  tool-input delta — ignored
 *
 * ### OpenCode v2 (measured 2026-10-16, OpenCode 2.0.30, via an in-plugin probe)
 *
 * The envelope is `{ id, created, type, location, data }` and the vocabulary is `session.*` — the v1
 * names above (`message.updated`, `message.part.updated`, `session.idle`, …) are **never emitted**.
 * That is why a plugin that only knew v1 did **nothing at all** on OpenCode v2: no state file, no
 * ledger, no tool usage (it silently fell through every event). The names handled for v2 are:
 *
 *   session.created / session.renamed        workspace path (location.directory) / title
 *   session.inbox.enqueued                    item.type=user · item.payload.text → the user's sentence
 *   session.execution.started/succeeded/failed/interrupted    round lifecycle
 *   session.step.started/ended/failed         model · finish · tokens · files (this step's changed files)
 *   session.reasoning.started/delta/ended     reasoning (→ thinking)
 *   session.text.started/delta/ended          assistant text (→ thinking; `ended` keeps the summary)
 *   session.tool.input.started                tool name (call id → name; `called`/`success` carry no name)
 *   session.tool.called/success/failed        tool running / done / error (name from the map above)
 *   session.usage.updated                     session-level usage (ignored: step tokens are per-round)
 *   permission.asked / permission.replied     awaiting permission (the phase polling cannot produce)
 *
 * Subagent summons (v2): a `task` / `subagent` tool call runs the subagent in a **child session** —
 * `session.created` carries `parentID` (the caller), `agent` (the subagent type) and `title` (the task
 * description). That child session is floated as a **ghost** keyed by the child session id (spawn on
 * `session.created`, retire on `session.execution.succeeded/failed/interrupted` / `session.idle` /
 * `session.deleted`), and **none** of its events open a ledger task or move the main agent's phase. It is
 * therefore never listed as an independent task (measured 2026-10-16: the tool is `subagent` on the
 * OpenCode host and it created a child session). This replaces the old "float a ghost off the `task` tool
 * call" for v2 — keeping both would double the ghost. (v1 / Kilo has no child sessions in the measured DB
 * and keeps the tool-call ghost.)
 *
 * Derivation rules are in the long comment above `handle()` (a task starts at a role=user text part /
 * `inbox.enqueued(user)`; it ends at finish=stop / `execution.succeeded`; awaiting permission is tool
 * state.status==='pending' / `permission.asked`).
 */

/* Node built-ins; the plugin runtime provides them, no extra dependency. */
import fs from "node:fs"
import path from "node:path"

/**
 * CJS interop from ESM: pull in the shared path/file helpers. WorkGremlin's own storage
 * locations and the logic-free state-file I/O have a single source of truth there
 * (see shared/paths.js) so the server and the plugin never drift to different dirs.
 */
import { createRequire } from "node:module"
const require_ = createRequire(import.meta.url)
const { statePath, writeState, readServerInfo, isPidAlive } = require_('@workgremlin/shared/paths')
const { DEFAULTS } = require_('@workgremlin/shared')

/**
 * Council participants' sessions carry this fixed title (set via `--title`, see
 * server/src/council/agents.js SESSION_TITLE). Such a session is never reported —— see the guard at the
 * top of handle() for why the title, not just WORKGREMLIN_DISABLE, has to be the backstop.
 */
const COUNCIL_SESSION_TITLE = String((DEFAULTS && DEFAULTS.COUNCIL_SESSION_TITLE) || "")

/* ------------------------------ Report identity ------------------------------ */

/**
 * The "was this process started inside an editor?" signal — **listed per product**.
 * Mixing the two pollutes each other: a Kilo CLI process has no KILO_* at all (measured
 * 2026-09-30: `/proc/<pid>/environ` only had KILO_TREE_SITTER_WASM_DIR left by the install
 * shim), while `kilo serve` started by the VS Code extension has all three
 * (KILO_CLIENT=vscode / KILOCODE_FEATURE=vscode-extension / KILO_PLATFORM=vscode).
 *
 * OpenCode is deliberately **absent**: its VS Code extension is only a UI that drives the same
 * `opencode` binary against the same data root (~/.local/share/opencode) — the extension even
 * requires the CLI to be installed. There is no second product and no second on-disk layout, so
 * there is no "editor form" to tell apart: OpenCode always reports form=cli (see resolveForm).
 */
const VSCODE_ENV = {
  kilo: [
    ["KILO_CLIENT", "vscode"],
    ["KILOCODE_FEATURE", "vscode-extension"],
    ["KILO_PLATFORM", "vscode"],
  ],
}

/**
 * Report identity has **two separate axes** — the floor base name (client) and the form:
 *
 *   · **client** (kilo / opencode): the floor's product base name, which the server keys
 *     everything on (state-file naming, `clientHit` matching, ledger ownership). It comes from
 *     the entry point (`setup` → opencode, `server` → kilo); an explicit `options.client` also
 *     names the product. The plugin never synthesizes or strips a `-plugin` suffix — the server
 *     no longer uses `codebuddy` / `codebuddy-plugin` style identities, so the floor name is
 *     taken as-is.
 *   · **form** (cli / vscode): whether this instance was started inside an editor. The same
 *     binary in a terminal and in the editor emits an identical event stream (see the file
 *     header); only env vars tell them apart — see VSCODE_ENV. On the server,
 *     `isPluginClient(form)` decides plugin-vs-not and `formToSource(form)` maps it to the
 *     frontend `source` (plugin / cli / ide). OpenCode has no editor form — its VS Code
 *     extension drives the same CLI (see VSCODE_ENV) — so OpenCode is always cli.
 *
 * The explicit `client` option names the **product** only, never the form: that config is read by
 * both the CLI and the editor extension (Kilo ships the same binary and reads the same
 * ~/.config/kilo/kilo.jsonc), so hardcoding `-plugin` in the option would be wrong in the terminal
 * and vice versa. The environment is the only signal for "who started this instance".
 */
function resolveClient(options, base = "opencode") {
  // The explicit option already names the floor base name; fall back to the entry point's base name.
  const explicit = String((options && options.client) || "").trim().toLowerCase()
  return explicit || base
}

/**
 * The **form** (cli / vscode) from the environment: the only signal that distinguishes the same
 * binary started in a terminal from one started by the editor extension. See VSCODE_ENV.
 */
function resolveForm(client) {
  const env = (typeof process !== "undefined" && process.env) || {}
  const vscode = (VSCODE_ENV[client] || []).some(([k, v]) => env[k] === v)
  return vscode ? "vscode" : "cli"
}

/* ------------------------------ Ledger reporting (HTTP) ------------------------------ */

/**
 * Besides the phase, the plugin also reports to WorkGremlin's **ledger**: members, tasks,
 * conversations, file activity.
 *
 * Writing only the state file left 7F/8F with "a phase but no ledger": no gremlin in the office
 * (no row with client=kilo in `members`), and the task list / conversation records were empty.
 * The polling path **cannot** fill this hole — it only reads SQLite, and a monitoring side
 * fabricating reports would violate "never invent". Only this plugin (running inside the agent
 * process, holding the true-phase event stream) can.
 *
 * All of it posts to the same ingest routes as the hook path (`shared`'s HTTP_ROUTES), with the
 * same field shapes:
 *   register    member registration (**must carry role:'agent'** — bus.endTask only writes
 *               task_runs for role=agent members; omit it and the task opens but no ledger row)
 *   task/start  a new user turn = a task; the title is the user's sentence
 *   task/end    round end (succeeded→done / failed·interrupted→cancelled), with result and files
 *   message     this round's closing summary into the conversation (type=result)
 *   file/touch  files touched by write-class tools ("what is being edited")
 *
 * Three disciplines, same as the hook path:
 *   1) server down / no context / report failed — always silent, **never block the agent**;
 *   2) don't report what you don't have (title, result, files may be absent); the server shows
 *      "unknown", never invent;
 *   3) always fire-and-forget (never await in event handling); the event stream must not be held
 *      up by HTTP.
 */

/** Timeout for a single HTTP call; on timeout treat it as unsent, don't retry into the agent's way */
const HTTP_TIMEOUT_MS = 2_000

/** server.json re-read interval: a few hundred bytes; 5s is enough to catch "app just started / changed port" */
const SERVER_INFO_TTL_MS = 5_000

/**
 * Build a ledger reporter.
 * @param {string} client floor base name (kilo / opencode) — also the memberId
 */
function createIngest(client) {
  /**
   * Connection info is **lazily re-read**, not fixed at construction time.
   *
   * The plugin lives as long as the agent's server process: the Kilo VS Code extension might start
   * its server at 09:04 while WorkGremlin starts at 10:42 — if `base` were read once and `enabled()`
   * were `Boolean(base)`, that instance's `post()` / `resolveProject()` would return forever (the
   * state file is still written to disk, but not a single ledger row arrives, completely silently).
   * The TTL re-read means a late app start / a restart on a new port is picked up by the next event.
   *
   * It also adds the liveness check the plugin was missing (`isPidAlive`): otherwise a server.json
   * left behind by a crashed run would be treated as a valid connection and every call would hit a
   * dead port.
   */
  let conn = null
  let connAt = 0
  function connect() {
    const now = Date.now()
    // Cache hit: port/token unchanged and not expired — high-frequency events (part updates are dense)
    // must not read the disk on every one
    if (conn && now - connAt < SERVER_INFO_TTL_MS) return conn
    connAt = now
    const info = readServerInfo()
    if (!info || !info.port || !isPidAlive(info.pid)) {
      conn = null
      return null
    }
    conn = {
      base: `http://127.0.0.1:${info.port}`,
      token: info.token || "",
      headers: { "content-type": "application/json", ...(info.token ? { authorization: `Bearer ${info.token}` } : {}) },
    }
    return conn
  }

  /** WorkGremlin not running / not installed → don't send, never hit a known-dead port */
  const enabled = () => Boolean(connect())

  /**
   * Record one ledger entry. **Callers never await** — event handling must not be held up by HTTP;
   * but the response **is returned** so "did this one actually go out" becomes decidable:
   * `ensureRegistered` relies on it to decide "did registration succeed, retry or not".
   *
   * `project` is **injected here**, not left to each call site: the ingest `projectFirst` middleware
   * requires `project` in the body and otherwise returns 400 (`missing project`) — and a 400 is
   * **silent** (fire-and-forget, nobody reads the response), so one missed spot shows up as "this
   * product's ledger is always empty" and is very hard to trace. The SDK
   * (packages/reporter/src/index.js `post`) adds it the same way (`{ project, ...body }`).
   *
   * @returns {Promise<Response|null>} null when not connected / not sent
   */
  function post(route, body) {
    const c = connect()
    if (!c) return Promise.resolve(null)
    try {
      return fetch(`${c.base}/api/v1${route}`, {
        method: "POST",
        headers: c.headers,
        body: JSON.stringify({ project: projectCache, ...body }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      }).catch(() => null)
    } catch {
      /* can't send → skip */
      return Promise.resolve(null)
    }
  }

  /**
   * The workspace this report belongs to: follows the server's "currently open workspace", same as
   * the hook path. Leave it empty when the server is unreachable — `post()` still sends the empty
   * project and the server 400s it; better to not report than to write into another workspace.
   */
  let projectCache = ""
  let projectPromise = null
  function resolveProject() {
    const c = connect()
    if (!c) return Promise.resolve("")
    if (projectPromise) return projectPromise
    projectPromise = (async () => {
      try {
        const res = await fetch(`${c.base}/api/v1/workspace`, { headers: c.headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
        const j = res.ok ? await res.json() : null
        const p = String((j && j.project) || "")
        if (p) {
          projectCache = p
          return p
        }
        // Don't cache a missing workspace — retry next call; otherwise a late server start would never
        // get a workspace and register / task/start / task/end would all be silently skipped by
        // `if (!project) return`
        projectPromise = null
        return ""
      } catch {
        // A network failure is not cached either; retry next time
        projectPromise = null
        return ""
      }
    })()
    return projectPromise
  }

  return { post, resolveProject, enabled }
}

/* ------------------------------ Tool input ------------------------------ */

/** Human-readable command in the tool input (OpenCode's shell tool input is `command`) */
function commandOf(input) {
  const s = input && typeof input === "object" ? input : {}
  const c = String(s.command || "")
  if (c) return c.replace(/\s+/g, " ").trim().slice(0, 120)
  const d = String(s.description || "")
  return d.replace(/\s+/g, " ").trim().slice(0, 120)
}

/** Target file in the tool input (field names differ per product; accept them all) */
function fileOf(input) {
  const s = input && typeof input === "object" ? input : {}
  const p = s.file || s.filePath || s.file_path || s.path || s.target_file || ""
  return typeof p === "string" ? p : ""
}

/**
 * The **read/write** classification of a tool — decides whether to send file/touch
 * ("what is being read/edited").
 *
 * Only write-class tools count: they actually change files; read-class tools (read/grep/glob…)
 * leave no "change" trace, so reporting them would just fill the "editing" column with noise.
 * When undecidable, treat it as **read** (don't report) — better to under-report than to call
 * "read a file" an edit (that would be inventing).
 * Same rule as the hook path's WRITE_TOOLS / opOf (case-insensitive here, exact names there).
 */
function opOfTool(name) {
  const t = String(name || "").trim().toLowerCase()
  if (!t) return "read"
  if (/\b(delete|remove|rm|unlink|trash)\b/.test(t)) return "write"
  if (/\b(write|edit|patch|create|insert|update|replace|apply|rename|move|mkdir|save|apply_patch|multiedit|notebookedit)\b/.test(t)) {
    return "write"
  }
  return "read"
}

/** Strip the outer JSON quotes: measured, `part.text` is `'"run echo hi with bash"'` (one quote layer) */
function unquote(text) {
  const s = String(text == null ? "" : text)
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s))
    } catch {
      return s.slice(1, -1)
    }
  }
  return s
}

/** Tool name for summoning a subagent (Kilo / OpenCode use `task`; Codex style is a spawn_agent suffix) */
function isSubagentTool(name) {
  const t = String(name || "").trim().toLowerCase()
  return t === "task" || t === "agent" || t.endsWith("spawn_agent")
}

/** Name and task description in a subagent tool input (field names differ per version; accept them all; fall back when absent) */
function subagentOf(input) {
  const s = input && typeof input === "object" ? input : {}
  const name = s.subagent_type || s.subagent_name || s.task_name || s.agent || s.name || ""
  const task = s.description || s.prompt || s.message || ""
  return { name: String(name || "").trim() || "subagent", task: String(task).replace(/\s+/g, " ").trim().slice(0, 80) }
}

/* ------------------------------ Plugin ------------------------------ */

/**
 * Core: build one reporting instance and return `handle(event)` plus `dispose()` to tear the
 * subscription down.
 *
 * **Two products, two plugin APIs, but the same events fed in**:
 *   · 8F OpenCode: `setup(ctx)` + `ctx.event.subscribe()` for the event stream
 *   · 7F Kilo: `server(input)` returns an `{ event }` hook; Kilo calls it once per event
 * So event handling (phase / ledger / ghost) is written once, and the two entry points just wire it up.
 *
 * @param {any} options the plugin entry's options from config (directory-registered ones have none → undefined)
 * @param {{location?: any, base?: string}} ctx `base` = product base name, **given by the entry point** (see resolveClient)
 */
function createIngestPlugin(options, { location, base } = {}) {
  // Floor base name (client) + form (cli / vscode), decided separately (see resolveClient / resolveForm).
  // **client is always the floor's product base name** (kilo / opencode) — same as hookCommon's
  // `client = ev.agent`, and what readReporterPhase's clientHit matches on. The form ('cli' /
  // 'vscode') is a separate axis and is never mixed into the identity.
  const client = resolveClient(options, base)
  // Form lands in the state file's form / task_runs.form; the server maps it to
  // source = formToSource(form) (plugin / cli / ide) for display.
  const form = resolveForm(client)
  /** session id → workspace path (session.created gives the authoritative value; the envelope's location.directory is a fallback) */
  const dirs = new Map()
  /**
   * session id → file list from the latest `session.diff`.
   * **Session-scoped** (against the session's own snapshot baseline), not "this round's changes" —
   * always filter through steppedOf by this round's window; don't read it directly (reading it
   * directly would count files another agent changed in the same workspace as this round's).
   */
  const lastFiles = new Map()
  /** session id → session title */
  const titles = new Map()
  /** session id → model (session.created carries data.model; the ledger needs it, and kilo is not in MODEL_SOURCES) */
  const models = new Map()
  /** messageID → role (user / assistant). A part only carries messageID; the role comes from message.updated */
  const msgRoles = new Map()
  /** messageID → the user's sentence (in case a text part arrives before message.updated, park it here until the role is known) */
  const pendingUserText = new Map()
  /** session id → this round's last assistant text (closing summary; measured, each part update carries the full text, not a delta) */
  const assistantText = new Map()
  /** session id → this round's task id (ledger; used by task/end and message) */
  const taskIds = new Map()
  /** session id → files touched this round (accumulated by file/touch, merged into task/end's files at the end) */
  const roundFiles = new Map()
  /** session id → this round's start time (set by startTask). Used to draw the "this round" line for the session-scoped diff (see steppedOf) */
  const roundStartAt = new Map()
  /**
   * session id → this round's per-message assistant tokens (messageID → that message's usage).
   *
   * Why per message instead of "add one on every event": `message.updated` fires **repeatedly** for
   * the same message (streaming updates), so adding its usage each time would double-count. Each
   * message keeps only the **last** value seen; the sum across messages happens at round end —
   * matching the DB's `message.data.tokens` ("this message's usage").
   *
   * This plugin's phase and ledger are **reported truth**, so tokens are taken in place: with the
   * plugin installed, 7F/8F's ledger rows are written by the plugin (polling yields to it), and the
   * polling path cannot reach these rows.
   */
  const roundMsgTokens = new Map()
  /**
   * session id → the last "interrupted" time.
   * On ESC / stop, Kilo / OpenCode emit only a `session.idle` (no `finish=stop`) — the round is
   * closed as **cancelled** and a `done.cancelled` marker is written. But a late assistant
   * `finish=stop` message sometimes follows; don't let it turn the red "task cancelled" into a green
   * "task done" (same as the hook path's justCancelled).
   */
  const cancelledAt = new Map()
  /**
   * Tool call ids already counted for "tool usage" (Kilo / OpenCode's `part.callID`).
   * A tool's part updates repeatedly (pending → running → completed); counting every one would double
   * the count, so a callID is counted once. Cleared wholesale once it grows — it is only "calls seen by
   * this process", no need to keep long.
   */
  let toolCallSeen = new Set()
  /**
   * call id → tool name. OpenCode 2.x's `session.tool.called` carries `{id, input}` but **no name**:
   * the name arrives earlier on `session.tool.input.started`. Kilo (v1) puts it in the part, so this
   * map is only used by the v2 branch.
   */
  const toolNames = new Map()
  const ingest = createIngest(client)
  /** This plugin instance's own workspace (the event stream is **whole-server**, not just this workspace — see wsOf below) */
  const ownDir = String((location && location.directory) || "")

  /* ------------------------------ Member registration ------------------------------ */

  /** Whether this client's member has been created (once created, don't re-add) */
  let registered = false
  /** The in-flight registration (events are dense; don't send a register on every one) */
  let registering = null

  /**
   * Make sure "this identity's member" exists on the server, returning a Promise:
   * created → true; WorkGremlin unreachable / no workspace / server rejected → false (**retry next time**).
   *
   * ## Why this function is required, and why it retries
   *
   * Every server bus ingest entry point starts with `requireMember(...)` and 404s the whole request
   * (`unknown_member`) when it can't find the member — while this side is fire-and-forget, so a **404
   * is completely silent**. That is: if the member was never created, **every ledger entry** this
   * process reports sinks without a trace, leaving only the local state file.
   *
   * Registration **retries until it succeeds** (on failure clear the in-flight marker and try on the
   * next event), and all ledger reporting below waits for it — which also guarantees ordering
   * (otherwise register and task/start race and task/start could arrive first as a 404).
   */
  function ensureRegistered() {
    if (registered) return Promise.resolve(true)
    if (!ingest.enabled()) return Promise.resolve(false)
    if (!registering) {
      registering = ingest
        .resolveProject()
        .then(async (project) => {
          // No workspace (app started late / just changed port) → don't send; retry on the next event
          if (!project) {
            registering = null
            return false
          }
          const res = await ingest.post("/register", {
            memberId: base,
            name: base,
            client,
            role: "agent",
            workspacePath: ownDir,
            sessionId: "",
          })
          if (res && res.ok) {
            registered = true
            return true
          }
          registering = null
          return false
        })
        .catch(() => {
          registering = null
          return false
        })
    }
    return registering
  }

  /**
   * The single entry point for ledger reporting: **ensure the member is registered first, then send**
   * (see ensureRegistered). `/register` itself goes through `ingest.post` — routing it here would recurse.
   */
  const post = (route, body) => ensureRegistered().then((ok) => (ok ? ingest.post(route, body) : null))

  /** This session's workspace path; fall back to this instance's workspace when unknown */
  const wsOf = (event) => {
    // Two envelope generations coexist: Kilo 7.8.1 uses `properties`, OpenCode 2.x uses `data`. Accept both.
    const p = (event && (event.properties || event.data)) || {}
    const sid = String(p.sessionID || "")
    const known = sid ? dirs.get(sid) : ""
    const fromEvent = String(
      (event && event.location && event.location.directory) ||
        (p.info && p.info.directory) ||
        (p.info && p.info.path && p.info.path.cwd) ||
        "",
    )
    return known || fromEvent || ownDir
  }

  /**
   * Write the phase.
   * Keys in `phaseFields` go into sessionPhase; `done` goes into the separate done field (the state
   * file keeps them as two fields; done should not be nested inside the phase object).
   *
   * `hb.pid` identifies the process that owns this state file. `hb.lastEventAt` records the last
   * event written to it; neither value is a workstation state or task-liveness input.
   */
  const report = (event, phase, { done = null, ...phaseFields } = {}) => {
    try {
      // Two envelope generations coexist: Kilo 7.8.1 uses `properties`, OpenCode 2.x uses `data`
      const sid = String((((event && (event.properties || event.data)) || {}).sessionID) || "")
      if (!sid) return
      const ws = wsOf(event)
      const now = Date.now()
      const patch = {
        client: client,
        form: form,
        sessionId: sid,
        hb: { pid: process.pid, lastEventAt: now },
        sessionPhase: { phase, ts: now, workspacePath: ws, ...phaseFields },
      }
      if (done) patch.done = done
      writeState(statePath(client, ws, sid), patch)
    } catch {
      /* a failed report must not affect the agent */
    }
  }

  /* ------------------------------ Subagent ghosts (child sessions) ------------------------------ */

  /**
   * Child (subagent) sessions, keyed by the child session id → `{ parentSid, name }`.
   *
   * A subagent summoned on OpenCode v2 runs in its **own session** the server created for it:
   * `session.created` carries `parentID` (the caller's session), `agent` (the subagent type) and
   * `title` (the task description). Measured 2026-10-16: the tool is `subagent` on this host and it
   * spawned a child session with `parentID` set (`agent: "explore"`, `title` = the `description`).
   *
   * Such a session is a **ghost**, not a task: the office floats it above the summoned gremlin and it
   * must not take a card slot in the task list. So `handle()` treats every event of a child session as
   * ghost lifecycle (spawn on `session.created`, retire on the round's end) and **never** opens a
   * ledger task or moves the main agent's phase for it.
   *
   * Kilo's v1 envelope has no top-level `parentID` and no child sessions in the measured DB (25/25 rows
   * have `parent_id = NULL`), so this only fires for OpenCode v2; the v1 path keeps floating its ghost
   * off the `task` tool call (see `message.part.updated`).
   */
  const childSessions = new Map()
  /** Child session id → its latest assistant text (used as the ghost's finish report) */
  const childText = new Map()

  /**
   * Float a ghost for a summoned subagent's child session. The ghost id **is** the child session id,
   * so spawn/retire always pair up (two same-type subagents running at once never collide).
   * `sessionId` stays the **parent** session: the parent round's ghost sweep also clears a child that
   * never reported its end.
   */
  function spawnChildGhost(event, childSid, parentSid, info) {
    const name = String((info && info.agent) || "").trim() || "subagent"
    const task = String((info && info.title) || "").replace(/\s+/g, " ").trim().slice(0, 80)
    childSessions.set(childSid, { parentSid, name })
    post("/ghost", {
      action: "spawn",
      workspacePath: wsOf(event),
      name,
      task,
      id: childSid,
      parent: taskIds.get(parentSid) || "",
      model: "",
      client,
      sessionId: parentSid,
    })
  }

  /** The subagent's child session ended → its ghost disperses (result = what the child last said). */
  function retireChildGhost(event, childSid) {
    const rec = childSessions.get(childSid)
    if (!rec) return
    childSessions.delete(childSid)
    const result = String(childText.get(childSid) || "").replace(/\s+/g, " ").trim().slice(0, 200)
    childText.delete(childSid)
    post("/ghost", {
      action: "finish",
      workspacePath: wsOf(event),
      name: rec.name,
      id: childSid,
      result,
      client,
      sessionId: rec.parentSid,
    })
  }

  /* ---- The three small ledger actions (none await; never hold up the event stream) ---- */

  /**
   * Files **actually changed** this round: Kilo's `session.diff` filtered by mtime to this round's window.
   *
   * Why not trust `session.diff` directly: it is not "this round's changes" but a **session-scoped**
   * diff (against the session's own snapshot baseline), so files another agent changed in the same
   * workspace while the session was open get listed too. So filter by **mtime within this round's
   * window** (>= the roundStartAt set by startTask): keep what was written this round (including
   * changes made in bash — real work this round that the write-tool column can't see, only the diff
   * can), drop what others changed in the session and what earlier rounds changed.
   * If stat fails (file deleted / no permission) → keep it: a delete is a change too.
   * If this round's start is unknown (session started before the plugin) → don't filter, keep as-is.
   */
  function steppedOf(sid, ws) {
    const since = Number(roundStartAt.get(sid) || 0)
    const list = sid ? lastFiles.get(sid) || [] : []
    return list.map(String).filter((f) => {
      if (!since) return true
      try {
        return fs.statSync(path.resolve(ws || ownDir, f)).mtimeMs >= since
      } catch {
        return true
      }
    })
  }

  /**
   * Open a task. Title = **the user's sentence**, taken by the caller from the role=user text part
   * (measured, the user's sentence is in `message.part.updated`'s `part.type==='text'`; the envelope
   * has no prompt field, so fall back to the session title / a placeholder rather than invent).
   * @param {any} event the triggering event (for workspace path / form)
   * @param {string} sid session id
   * @param {string} prompt the user's sentence (may be empty)
   */
  function startTask(event, sid, prompt = "") {
    const said = String(prompt || "").replace(/\s+/g, " ").trim()
    const title = said || titles.get(sid) || "(未命名任务)"
    const taskId = `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    taskIds.set(sid, taskId)
    roundFiles.set(sid, new Set())
    roundMsgTokens.set(sid, new Map())
    // This round's time line: session.diff is session-scoped; this is how we know which files changed **this round** (see steppedOf)
    roundStartAt.set(sid, Date.now())
    // New round: the previous "interrupted" marker is void (a late old done must not suppress this round's completion)
    cancelledAt.delete(sid)
    // **Clear the previous round's "task done" marker when a new round starts.** The state file is
    // merge-written, so an old done would otherwise linger while the new task runs. Set done to null
    // rather than delete the key: the merge only knows values, and null is enough for the server's
    // readReporterDone to read "none".
    //
    // The same patch carries **taskTitle = the user's sentence**: the server's readReporterPhase reads
    // it as `prompt`, which the main console shows while "thinking". Only write `said` (the user's
    // sentence, untruncated — same as the hook path), **not the session title**: the session title
    // defaults to an uninformative "New session - <timestamp>". If the sentence is unknown, write an
    // empty string rather than keep the previous round's prompt.
    try {
      writeState(statePath(client, wsOf(event), sid), { done: null, taskTitle: said })
    } catch {
      /* failing to clear is fine: readReporterDone has a TTL, it will just show a bit longer */
    }
    // The form marker is computed once in createIngestPlugin and used directly here.
    // The workspace is guaranteed resolved by ensureRegistered inside post() (if not, the whole report is skipped).
    post("/task/start", {
      memberId: base,
      taskId,
      title,
      sessionId: sid,
      client,
      form,
      // The model was recorded from session.created (models map). **Must carry it ourselves**: the
      // server-side fallback (MODEL_SOURCES in sessions.js) does not cover kilo/opencode, so
      // task_runs.model would stay null (a missing column in the task list).
      ...(models.get(sid) ? { model: models.get(sid) } : {}),
      workspacePath: wsOf(event),
    })
    return taskId
  }

  /**
   * Files touched by write-class tools → ledger file/touch ("what is being edited").
   * **Called only for write-class tools**: read-class tools are not reported (they leave no change trace).
   */
  function touchFile(sid, file, ws = "") {
    if (!file) return
    const set = roundFiles.get(sid)
    if (set) set.add(file)
    post("/file/touch", { memberId: base, files: [file], op: "write", sessionId: sid, client, workspacePath: ws })
  }

  /**
   * Close a round: task/end (with result and this round's changed files) + the closing summary into
   * the conversation.
   * @param {"done"|"failed"|"cancelled"} state
   */
  function endTask(event, sid, state, result) {
    const taskId = taskIds.get(sid)
    if (!taskId) return
    taskIds.delete(sid)
    const touched = [...(roundFiles.get(sid) || new Set())]
    roundFiles.delete(sid)
    // This round's tokens: **sum** each assistant message's usage (multiple updates to one message
    // count once, see roundMsgTokens). All four zero = no message with tokens this round (older Kilo
    // doesn't write it) → don't report, the server keeps NULL and shows "—" not 0.
    const tk = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const one of (roundMsgTokens.get(sid) || new Map()).values()) {
      tk.input += one.input
      tk.output += one.output
      tk.cacheRead += one.cacheRead
      tk.cacheWrite += one.cacheWrite
    }
    roundMsgTokens.delete(sid)
    const tokens = tk.input + tk.output + tk.cacheRead + tk.cacheWrite > 0 ? tk : null
    // Compute this round's changed files first, then drop the start time — steppedOf needs it for the window
    const stepped = steppedOf(sid, wsOf(event))
    roundStartAt.delete(sid)
    // **The same file gets recorded twice**: `session.diff` gives workspace-relative paths (a.ts) while
    // file/touch records the tool input verbatim (possibly absolute). Merging directly would list the
    // same file twice in file_count and the files list. So normalize to workspace-relative first, then
    // dedupe — "how many files this round" on the ledger must be real.
    const ws = wsOf(event)
    const rel = (f) => {
      const s = String(f || "")
      if (!s) return ""
      try {
        return path.relative(ws, path.resolve(ws, s)) || s
      } catch {
        return s
      }
    }
    const all = [...new Set([...stepped, ...touched].map(rel).filter(Boolean))]
    // The form marker is computed once in createIngestPlugin and used directly here
    post("/task/end", {
      memberId: base,
      taskId,
      state,
      result: String(result || "").slice(0, 4_000) || undefined,
      files: all,
      sessionId: sid,
      client,
      form,
      ...(models.get(sid) ? { model: models.get(sid) } : {}),
      // Omit the whole block when absent (the server treats it as "not reported"); don't send an empty one implying 0
      ...(tokens ? { tokens } : {}),
      workspacePath: ws,
    })
    // The closing summary also goes into the conversation (type=result); no summary → don't write (don't pad with the file list)
    const said = String(result || "").trim()
    if (said) {
      post("/message", {
        memberId: base,
        from: base,
        to: null,
        type: "result",
        subject: null,
        content: said.slice(0, 8_000),
        taskId,
        sessionId: sid,
        client,
        workspacePath: ws,
        ts: Date.now(),
      })
    }
  }

  // No subscription here: where events come from is up to the entry point (OpenCode uses the subscribe
  // stream, Kilo uses the server event hook); the factory only handles "given one event, what to do".
  /**
   * Handle one event.
   *
   * ## Event contract — two generations (see the file header; the sets are disjoint)
   *
   * **Kilo / OpenCode v1** (measured 2026-09-27, Kilo 7.8.1): envelope `{ id, type, properties }`.
   * `kilo run` for two rounds emits only the 10 names below, so the workspace comes from
   * `session.created`'s `info.directory` (or `message.updated`'s `info.path.cwd`).
   *
   * **OpenCode v2** (measured 2026-10-16, 2.0.30): envelope `{ id, created, type, location, data }`,
   * vocabulary `session.*` (handled further down). The workspace is `location.directory`, and the
   * user's sentence is `session.inbox.enqueued`'s `item.payload.text`.
   *
   *   session.created        info.directory=workspace path · info.model.id=model
   *   session.updated        info.title (session renamed)
   *   message.updated        info.role / info.finish / info.time.completed / info.path.cwd
   *   message.part.updated   part{type:text|tool|reasoning|step-start|step-finish|patch,
   *                           text, tool, callID, state{status,input}, messageID}
   *   message.part.delta     token-level delta — ignored (one per token; writing per token would thrash)
   *   session.status         status.type = busy | idle
   *   session.idle           this round has fully ended
   *   session.drained        queue drained (closing signal)
   *   session.diff           diff[] = delta against the **session** snapshot (not "this round", see steppedOf)
   *   session.next.tool.input.delta  tool-input delta — ignored (part updates already carry the full input)
   *
   * ## Rules derived from it
   *
   * · **Task start = a role=user text part.** The user's sentence is in `part.type==='text'`'s
   *   `part.text` (measured value carries one JSON quote layer; strip it). `message.updated` gives
   *   that messageID's role; if a part arrives first (the order shouldn't change, but don't gamble),
   *   park the text on the messageID and open the task when the role=user message.updated arrives.
   * · **Task end = a role=assistant message.updated with `finish` + `time.completed`**.
   *   `finish==='stop'` means "finished speaking" (= ledger done, and "task done");
   *   `finish==='tool-calls'` means **this message** broke at a tool call, **the round is not over**.
   *   (same as reading `message.finish` from SQLite in floorKilo.js)
   * · **Closing summary = this round's assistant text part** (attributed by messageID, the last complete one).
   * · **Awaiting permission = a tool part with `state.status==='pending'`**. Kilo's tool status is
   *   measured as pending / running / completed / error — pending means not yet released. SQLite also
   *   persists this pending (polling derives "awaiting permission" from it); the plugin path is the **truth**.
   */
  function handle(event) {
    const type = String((event && event.type) || "")
    // Two envelope generations coexist: Kilo 7.8.1 uses `properties`, OpenCode 2.x uses `data`. Accept both.
    const p = (event && (event.properties || event.data)) || {}
    const sid = String(p.sessionID || "")
    // Workspace path: the envelope has no location (Kilo side), fall back to ownDir
    const dirOf = () => String((p.info && p.info.directory) || (p.info && p.info.path && p.info.path.cwd) || "")

    // Learn the session title as early as possible. OpenCode v2's session.created already carries it (and a
    // rename arrives as session.updated/renamed); the council guard right below must fire on a participant's
    // very first event, or a task/phase would open before the title is known.
    if ((type === "session.created" || type === "session.updated" || type === "session.renamed") && sid) {
      const t = String((p.info && p.info.title) || p.title || "")
      if (t) titles.set(sid, t)
    }
    /**
     * Council participants are never reported into the office (see server/src/council/agents.js). The
     * intended switch is WORKGREMLIN_DISABLE=1 on the participant child, but 8F's `opencode run` normally
     * talks to a **long-lived shared server** (`opencode serve`) that loaded this plugin with the user's
     * own env long before the council started —— the flag never reaches it, so participants leak in as
     * regular 8F sessions / tasks / phases (measured 2026-10-18, fixing exactly that). The fixed session
     * title is set at creation, so it is the reliable signal here regardless of which server loaded us.
     */
    if (sid && titles.get(sid) === COUNCIL_SESSION_TITLE) return

    // Member registration: **ensure on every event**, not only on `session.created`. Must: reopening the
    // Kilo VS Code window restarts kilo serve while the session already exists, so a new process never
    // sees session.created and would never register if only that branch did. Once registered this is a
    // boolean check, cheap even for the high-frequency `*.delta`.
    void ensureRegistered()

    /* A subagent's child session (OpenCode v2) is a ghost, not an independent task: none of its events
       may open a ledger task or move the main agent's phase. `session.created` below is what registers
       the child and floats its ghost; after that only the round's end matters — it retires the ghost. */
    if (sid && childSessions.has(sid)) {
      if (type === "session.text.ended") childText.set(sid, unquote(p.text))
      else if (
        type === "session.execution.succeeded" ||
        type === "session.execution.failed" ||
        type === "session.execution.interrupted" ||
        type === "session.idle" ||
        type === "session.deleted"
      ) {
        retireChildGhost(event, sid)
      }
      return
    }

    switch (type) {
      /* ---- Session created: the authoritative source of workspace path and model ---- */
      case "session.created": {
        const info = p.info || {}
        // v2 carries the workspace in `location.directory` (the envelope); v1/Kilo in `info.directory`
        const ws = dirOf() || String((event.location && event.location.directory) || "") || ownDir
        if (sid) dirs.set(sid, ws)
        /* OpenCode v2: a summoned subagent gets its own session with `parentID` set — that is a ghost
           (see the child-session note above `handle`), not an independent session. Floating the ghost
           here (not off the `subagent`/`task` tool call) keys it to the child's real lifecycle. */
        const parentSid = String(p.parentID || "")
        if (sid && parentSid && !p.info) {
          spawnChildGhost(event, sid, parentSid, p)
          break
        }
        const model = String((info.model && (info.model.id || info.model.modelID)) || info.modelID || "")
        if (sid && model) {
          models.set(sid, model)
          // The main console shows the model; polling can read it from the DB too, but with the plugin we use the truth
          writeState(statePath(client, ws, sid), { model })
        }
        break
      }

      /* ---- Session renamed: the title was already captured at the top of handle() (used as the task title
         fallback at round end); only the model is taken here ---- */
      case "session.updated":
      case "session.renamed": {
        const info = p.info || {}
        // The model **often is not present at session.created** (measured: created's info has no model,
        // it comes with the immediately following session.updated) — so accept it in both places;
        // missing one shows as "the main console shows no model".
        const model = String((info.model && (info.model.id || info.model.modelID)) || info.modelID || "")
        if (sid && model) {
          models.set(sid, model)
          writeState(statePath(client, dirOf() || wsOf(event), sid), { model })
        }
        break
      }

      /* ---- Message: role / finish / time.completed are the three task-ledger criteria ---- */
      case "message.updated": {
        const info = p.info || {}
        const mid = String(info.id || "")
        const role = String(info.role || "")
        if (mid) msgRoles.set(mid, role)
        /* This round's tokens: an assistant message's `info.tokens` (shape `{input,output,reasoning,cache:{read,write}}`,
           the same as the DB's message.data.tokens). **Stored per message, overwriting** — this event fires
           repeatedly for the same message, so adding each time would double-count (see roundMsgTokens). */
        if (sid && role === "assistant" && mid && info.tokens && typeof info.tokens === "object") {
          const t = info.tokens
          const cache = (t.cache && typeof t.cache === "object") ? t.cache : {}
          const pos = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
          const bucket = roundMsgTokens.get(sid) || new Map()
          bucket.set(mid, {
            input: pos(t.input),
            // reasoning is folded into output: Claude / Codex output already includes thinking; without
            // folding, the same column would be short on 7F/8F
            output: pos(t.output) + pos(t.reasoning),
            cacheRead: pos(cache.read),
            cacheWrite: pos(cache.write),
          })
          roundMsgTokens.set(sid, bucket)
        }
        // user message: if its text part arrived first, open the task here (the normal order is part-last; this is a fallback)
        if (role === "user" && sid && !taskIds.has(sid)) {
          const early = pendingUserText.get(mid)
          if (early) {
            pendingUserText.delete(mid)
            startTask(event, sid, early)
          }
        }
        // assistant message end: finish + completed means "this message is done"
        if (role === "assistant" && info.finish && info.time && info.time.completed) {
          // finish=tool-calls means "broke at a tool call", the round is not over — don't close
          if (info.finish === "tool-calls") break
          /* A round just marked "interrupted" by session.idle must not be overwritten by a "done":
             ① the cancel marker was just written (within 60s); ② this round has no task running (taskId
             cleared by endTask). After an interrupt, a new task sets a new taskId and startTask clears
             cancelledAt, so completion still lands normally. */
          if (sid && cancelledAt.has(sid) && !taskIds.has(sid) && Date.now() - Number(cancelledAt.get(sid) || 0) < 60_000) {
            assistantText.delete(sid)
            break
          }
          const result = String(assistantText.get(sid) || "")
          assistantText.delete(sid)
          const ws = wsOf(event)
          // Filter by this round's window too (see steppedOf): this feeds the main console's "changed files"
          // column; the session-scoped diff would count files others changed in the same workspace.
          const files = steppedOf(sid, ws)
          endTask(event, sid, "done", result || titles.get(sid) || "")
          // Sweep on round end: "pending report" entries with a result are kept for the server's report animation
          post("/ghost", { action: "sweep", all: false, workspacePath: ws, client: client, sessionId: sid })
          report(event, "done", {
            action: "",
            done: {
              at: Number(info.time.completed) || Date.now(),
              // Title prefers **this round's own closing summary** (what the agent actually said), falling
              // back to the session title — which is an uninformative default like "New session - <timestamp>"
              title: result || titles.get(sid) || "",
              fileCount: files.length,
              files: files.slice(0, 20).map((f) => ({ path: f, size: null })),
              workspacePath: ws,
              sessionId: sid,
              cancelled: false,
            },
          })
        }
        break
      }

      /* ---- Parts: the source of the phase and "what changed this round" ---- */
      case "message.part.updated": {
        const part = p.part || {}
        const mid = String(part.messageID || "")
        const role = msgRoles.get(mid) || String(part.role || "")
        const kind = String(part.type || "")

        if (kind === "text") {
          // Measured: part.text carries one JSON quote layer ('"run echo hi with bash"'); strip it
          const text = unquote(part.text)
          if (role === "user") {
            // The user's sentence = the task title. Without the plugin this path doesn't exist, so the Kilo ledger has no record.
            if (sid && !taskIds.has(sid)) startTask(event, sid, text)
            else if (mid) pendingUserText.set(mid, text)
            report(event, "thinking")
          } else {
            // assistant text is this round's closing summary; measured, each part update carries the **current full text**, not a delta
            if (sid) assistantText.set(sid, text)
            // **Report thinking, not idle** (idle was wrong): Kilo emits assistant text **multiple times within one round**
            // (before/after each tool call). Reporting idle would flash the main agent back to "idle" between tool calls and
            // then back to "tool" on the next tool event, while the task is clearly still running. Other floors fall back to
            // "thinking" in that gap (the hook path: after a tool finishes → sessionPhase thinking); 7F/8F follow the same rule.
            //
            // "This round ended" has its own criteria, not this one: message.updated with finish + time.completed
            // (and not tool-calls) → done (branch above); session.idle / session.status=idle → idle. So reporting
            // thinking here won't leave the phase stuck.
            report(event, "thinking")
          }
          break
        }

        if (kind === "tool") {
          const status = String((part.state && part.state.status) || "")
          const input = (part.state && part.state.input) || {}
          const target = fileOf(input)
          /* Tool-usage count (task detail "tool usage"): count each callID once (the part updates repeatedly
             pending/running/completed; counting each would double it). pending doesn't count as "used" (not
             released yet); any other status counts as "called it". */
          const callId = String(part.callID || part.id || "")
          if (sid && callId && status && status !== "pending" && !toolCallSeen.has(callId)) {
            toolCallSeen.add(callId)
            // Only "calls seen by this process"; drop wholesale once too large (the next call of the same tool is still counted)
            if (toolCallSeen.size > 500) toolCallSeen = new Set([callId])
            const toolName = String(part.tool || "")
            const taskId = taskIds.get(sid) || ""
            if (toolName && taskId) {
              post("/tool/use", {
                memberId: base,
                taskId,
                tool: toolName,
                sessionId: sid,
                client,
                workspacePath: wsOf(event),
                form,
              })
            }
          }
          if (sid && opOfTool(part.tool) === "write" && status !== "pending") touchFile(sid, target, wsOf(event))
          // Summon a subagent (task tool) → float a ghost (goes through the server /ghost; hookCommon writes the list)
          if (sid && isSubagentTool(part.tool) && status !== "pending") {
            const sa = subagentOf(input)
            post("/ghost", {
              action: "spawn",
              workspacePath: wsOf(event),
              name: sa.name,
              task: sa.task,
              id: String(part.callID || ""),
              parent: taskIds.get(sid) || "",
              model: "",
              client: client,
              sessionId: sid,
            })
          }
          if (status === "pending") {
            // Kilo's tool status is measured to include pending — this is "awaiting permission", the phase the
            // polling path cannot produce (polling can derive it from disk too, but the plugin is the reported truth)
            report(event, "await", {
              tool: part.tool || "",
              target,
              action: part.tool ? `申请执行 ${part.tool}` : "等待用户授权",
            })
          } else if (status === "running") {
            report(event, "tool", { tool: part.tool || "", cmd: commandOf(input), file: target })
          } else if (status === "error") {
            report(event, "tool", { tool: part.tool || "", cmd: commandOf(input), file: target, action: `调用 ${part.tool || "工具"} 报错` })
          }
          // completed: don't roll the phase back (this branch finished; the next part advances it)
          break
        }

        if (kind === "reasoning") {
          report(event, "thinking")
          break
        }
        if (kind === "patch") {
          const f = String(part.file || part.path || "")
          report(event, "tool", { action: f ? `改 ${f}` : "落盘改动", target: f, file: f, tool: "patch" })
          break
        }
        // step-start / step-finish are **not phases**: measured 300+ each per session, they are "step" boundary
        // bookkeeping. Mapping them to "planning / summarizing" would leave the console stuck on "summarizing"
        // after every tool run (see the same note in floorKilo.js).
        break
      }

      /* ---- This round's changed files: measured as a diff array ---- */
      case "session.diff": {
        const arr = Array.isArray(p.diff) ? p.diff : []
        if (sid && arr.length) {
          lastFiles.set(sid, arr.map((d) => (typeof d === "string" ? d : String((d && (d.file || d.path)) || ""))).filter(Boolean))
        }
        break
      }

      /* ---- Busy / idle ---- */
      case "session.status": {
        const st = String((p.status && p.status.type) || "")
        if (st === "idle") report(event, "idle")
        break
      }
      case "session.idle": {
        /* Fallback: we truly got "this round ended" but no assistant message with finish=stop (e.g. the user
           pressed ESC / stop) — close the round as **cancelled**, don't light "task done". On interrupt
           Kilo / OpenCode don't emit finish=stop, only this session.idle. This writes a done marker (same shape
           as the hook path's Interrupt, plus cancelled:true):
             ① ledger task/end(state=cancelled) (inside endTask);
             ② state file done.cancelled=true → passed through by /reporter-phase and /sessions → the main
                console lights the red "task cancelled", with "changed files" or "no output" as usual. */
        if (sid && taskIds.has(sid)) {
          // Count files touched this round: steppedOf (from session.diff, filtered) ∪ roundFiles (from write-class tools)
          const files = [...new Set([...steppedOf(sid, wsOf(event)), ...((roundFiles.get(sid)) || [])].map(String).filter(Boolean))]
          // Text already emitted this round is collected too (same as the message.updated done branch): cancel
          // means "didn't finish", not "no output" — the ledger summary / conversation record are still written.
          const result = String(assistantText.get(sid) || "")
          const ws = wsOf(event)
          cancelledAt.set(sid, Date.now())
          endTask(event, sid, "cancelled", result)
          assistantText.delete(sid)
          post("/ghost", { action: "sweep", all: true, workspacePath: ws, client: client, sessionId: sid })
          report(event, "idle", {
            done: {
              at: Date.now(),
              title: result || titles.get(sid) || "",
              fileCount: files.length,
              files: files.slice(0, 20).map((f) => ({ path: f, size: null })),
              workspacePath: ws,
              sessionId: sid,
              // Text already emitted this round is recorded as usual (record if present, empty if not — same as "task done")
              said: result.replace(/\s+/g, " ").trim().slice(0, 160),
              cancelled: true,
            },
          })
          // Clear taskId in the state file: otherwise the server's fallback would synthesize a cancel marker
          // ≥TASK_RUN_MS later (a duplicate), and the task slot would stay occupied with the phase stuck on "tool".
          // Same as the hook path's Interrupt (which also nulls taskId).
          try { writeState(statePath(client, ws, sid), { taskId: null, taskWorkspacePath: '', taskStartedAt: 0 }) } catch {}
          break
        }
        report(event, "idle")
        break
      }

      /* ================= OpenCode 2.x vocabulary (measured 2026-10-16, OpenCode 2.0.30) =================
         v2 renamed the whole event stream: `message.updated` / `message.part.updated` are gone and the
         stream is `session.*` (see the file header). The types are **disjoint** from v1/Kilo's, so both
         branches coexist. Envelope: `{ id, created, type, location, data }` (already flattened into `p`).
         Mapping: session.created→workspace · session.renamed→title · session.inbox.enqueued(user)→task start ·
         session.execution.*→round lifecycle · session.step.*→model/finish/tokens/files ·
         session.reasoning.* (thinking) · session.text.* (thinking) · session.tool.* → tool phase + usage ·
         permission.*→awaiting permission. */

      /* Task start: v2 has no role=user text part; the user's sentence is item.payload.text */
      case "session.inbox.enqueued": {
        const item = p.item || {}
        if (String(item.type || "") === "user") {
          const text = unquote((item.payload && item.payload.text) || "")
          if (sid && !taskIds.has(sid)) startTask(event, sid, text)
        }
        break
      }

      /* Round lifecycle: started → thinking; succeeded/failed → done; interrupted → cancelled */
      case "session.execution.started": {
        report(event, "thinking")
        break
      }
      case "session.execution.succeeded":
      case "session.execution.failed": {
        if (sid && taskIds.has(sid)) {
          const result = String(assistantText.get(sid) || "")
          const files = steppedOf(sid, wsOf(event))
          endTask(event, sid, "done", result)
          assistantText.delete(sid)
          post("/ghost", { action: "sweep", all: false, workspacePath: wsOf(event), client: client, sessionId: sid })
          report(event, "idle", {
            done: {
              at: Date.now(),
              title: result || titles.get(sid) || "",
              fileCount: files.length,
              files: files.slice(0, 20).map((f) => ({ path: f, size: null })),
              workspacePath: wsOf(event),
              sessionId: sid,
              cancelled: false,
            },
          })
          break
        }
        report(event, "idle")
        break
      }
      case "session.execution.interrupted": {
        // Same shape as v1's session.idle cancel branch: interrupted rounds are cancelled, never "done"
        if (sid && taskIds.has(sid)) {
          const files = [...new Set([...steppedOf(sid, wsOf(event)), ...((roundFiles.get(sid)) || [])].map(String).filter(Boolean))]
          const result = String(assistantText.get(sid) || "")
          const ws = wsOf(event)
          cancelledAt.set(sid, Date.now())
          endTask(event, sid, "cancelled", result)
          assistantText.delete(sid)
          post("/ghost", { action: "sweep", all: true, workspacePath: ws, client: client, sessionId: sid })
          report(event, "idle", {
            done: {
              at: Date.now(),
              title: result || titles.get(sid) || "",
              fileCount: files.length,
              files: files.slice(0, 20).map((f) => ({ path: f, size: null })),
              workspacePath: ws,
              sessionId: sid,
              said: result.replace(/\s+/g, " ").trim().slice(0, 160),
              cancelled: true,
            },
          })
          try { writeState(statePath(client, ws, sid), { taskId: null, taskWorkspacePath: '', taskStartedAt: 0 }) } catch {}
          break
        }
        report(event, "idle")
        break
      }

      /* One assistant "step" (LLM call): model / finish / tokens / changed files */
      case "session.step.started": {
        const model = String((p.model && (p.model.id || p.model.modelID)) || "")
        if (sid && model) {
          models.set(sid, model)
          writeState(statePath(client, wsOf(event), sid), { model })
        }
        break
      }
      case "session.step.ended":
      case "session.step.failed": {
        if (sid) {
          // Per-message usage (reported once per step); `reasoning` is folded into `output` like the other
          // floors, and all-zero means "nothing read" (do not report 0 — the server shows "—").
          const mid = String(p.assistantMessageID || "")
          if (mid && p.tokens && typeof p.tokens === "object") {
            const t = p.tokens
            const cache = (t.cache && typeof t.cache === "object") ? t.cache : {}
            const pos = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
            const bucket = roundMsgTokens.get(sid) || new Map()
            bucket.set(mid, {
              input: pos(t.input),
              output: pos(t.output) + pos(t.reasoning),
              cacheRead: pos(cache.read),
              cacheWrite: pos(cache.write),
            })
            roundMsgTokens.set(sid, bucket)
          }
          // This step's changed files (v2 gives them directly; v1's session.diff is gone). Union within
          // the round — steppedOf filters by the round window, so older rounds drop out.
          const files = Array.isArray(p.files) ? p.files.map(String).filter(Boolean) : []
          if (files.length) lastFiles.set(sid, [...new Set([...(lastFiles.get(sid) || []), ...files])])
        }
        break
      }

      /* Reasoning / text: **thinking**, not idle — avoids the "flash idle between steps" trap (v1 note) */
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended":
      case "session.text.started":
      case "session.text.delta": {
        report(event, "thinking")
        break
      }
      case "session.text.ended": {
        // The current full text is the round's closing summary (v2 sends the whole text, not a delta)
        if (sid) assistantText.set(sid, unquote(p.text))
        report(event, "thinking")
        break
      }

      /* Tools */
      case "session.tool.input.started": {
        // The name is only here; session.tool.called has just {id, input}
        const cid = String(p.id || "")
        const name = String(p.name || "")
        if (cid && name) toolNames.set(cid, name)
        break
      }
      case "session.tool.called": {
        const cid = String(p.id || "")
        const name = String(toolNames.get(cid) || "")
        const input = p.input && typeof p.input === "object" ? p.input : {}
        // Tool usage ("task detail"): count each call id once (the event may repeat)
        if (sid && cid && !toolCallSeen.has(cid)) {
          toolCallSeen.add(cid)
          if (toolCallSeen.size > 500) toolCallSeen = new Set([cid])
          const taskId = taskIds.get(sid) || ""
          if (name && taskId) {
            post("/tool/use", { memberId: base, taskId, tool: name, sessionId: sid, client, workspacePath: wsOf(event), form })
          }
        }
        if (sid && name && opOfTool(name) === "write") touchFile(sid, fileOf(input), wsOf(event))
        /* Summoning a subagent (`task` / `subagent`) is **not** floated here: the child session's own
           `session.created` (with `parentID`) is the accurate start, and its round end retires the ghost
           (see the child-session note above `handle`). Floating here too would double the ghost. */
        report(event, "tool", { tool: name, cmd: commandOf(input), file: fileOf(input) })
        break
      }
      case "session.tool.success": {
        // Don't roll the phase back — the next reasoning/text/tool advances it (same as v1's completed tool)
        break
      }
      case "session.tool.failed": {
        const name = String(toolNames.get(String(p.id || "")) || "")
        report(event, "tool", { tool: name, action: name ? `调用 ${name} 报错` : "调用工具报错" })
        break
      }

      /* Awaiting permission: the phase polling cannot produce (v2 keeps it as its own event) */
      case "permission.asked": {
        const tool = String(p.tool || p.name || "")
        report(event, "await", { tool, action: tool ? `申请执行 ${tool}` : "等待用户授权" })
        break
      }
      case "permission.replied": {
        report(event, "thinking")
        break
      }

      default:
        // Other events (including the high-frequency *.delta stream) are never written: the phase is already
        // set on the relevant part/status; writing per token would thrash the disk and the renderer.
        break
    }
  }

  return { handle, dispose: () => {} }
}

/**
 * Module default export — **two entry points, Kilo and OpenCode, fed the same events**.
 *
 * The two plugin APIs are completely different (measured 2026-09-27, Kilo 7.8.1):
 *   · 8F OpenCode: `setup(ctx)` returns a teardown function; events come from `ctx.event.subscribe()`
 *   · 7F Kilo: **`server(input, options)`** returns a `Hooks` object; Kilo calls `hooks.event({ event })`
 *     per event. Kilo validates: "Plugin must default export an object with server()" — with only
 *     setup() **Kilo refuses to load** (an ERROR in the log, showing as "the plugin looks installed but
 *     no state file / ledger ever arrives"). Also a local `file://` plugin **must export `id`**.
 *   The two **cannot both** export `server` and `tui` (Kilo throws "either server() or tui(), not both");
 *   `setup` and `server` coexisting is fine (validation only looks at the latter two).
 *
 * Why 7F deserves its own entry point: the Kilo path is the **only** source for the CLI task ledger
 * (server polling is read-only; a monitoring side must not fabricate reports), so a wrong entry point
 * means this record never appears.
 */
export default {
  id: "workgremlin",

  /** 8F OpenCode — going through this entry point says it is OpenCode; the product base name needs no guessing */
  async setup(ctx) {
    // Council participants must not be reported (see server/src/council/agents.js QUIET_ENV): in workspace
    // mode their cwd is the user's real workspace, so reporting would make them a member of your workspace.
    // Return an empty teardown function — OpenCode still loads, it just subscribes to nothing.
    if (process.env.WORKGREMLIN_DISABLE === "1") return () => {}
    const inst = createIngestPlugin(ctx && ctx.options, { location: ctx && ctx.location, base: "opencode" })
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          inst.handle(event)
        }
      } catch {
        /* subscription dropped → fall back to polling */
      }
    })()
    return () => {
      controller.abort()
      inst.dispose()
    }
  },

  /** 7F Kilo — contract in packages/plugin/src/index.ts `PluginModule` */
  async server(input, options) {
    // Same as above (7F Kilo): council participants are not reported. Return an empty Hooks object rather
    // than undefined — Kilo validates the shape of server()'s return value, and undefined may look like a load failure.
    if (process.env.WORKGREMLIN_DISABLE === "1") return {}
    // `base: "kilo"`: going through server() says it is Kilo (setup() is OpenCode); no guessing.
    // Pass `options || {}` (directory registration has no options) so an explicit client in config can
    // name the product without a fake default shadowing the entry point's base name.
    const inst = createIngestPlugin(options || {}, {
      location: { directory: String((input && input.directory) || (input && input.worktree) || "") },
      base: "kilo",
    })
    return {
      /** Every Kilo event goes through here (including `*.delta`; handle's switch only takes the ones it needs) */
      async event({ event } = {}) {
        if (event) inst.handle(event)
      },
    }
  },
}
