'use strict';

/**
 * Sessions (conversations) — the conversations a monitored product has open under each project.
 *
 * The CLI and Plugin paths of the same floor write **different** on-disk state, each with its own way of
 * reading it, but both produce the same kind of session row:
 *   · The plugin path (1F CodeBuddy's plugin form): the structured on-disk layout described below in this
 *     file (genie-history / todos / message-queue / file-changes), which exposes the running state;
 *     TraeCode's plugin form has no such layout (measured: only runtime files), so its two on-disk
 *     locations (~/.trae-cn, ~/.marscode) are display-only and do not enter the session sources
 *     (see trae.js).
 *   · The CLI path (1F CodeBuddy, 2F, 3F, 4F): sessions live in each product's session jsonl; only file
 *     times are reliable.
 *   · The hook path (5F TraeCode, the fallback of 1F CodeBuddy CLI): when there is not even a jsonl, the
 *     session source is the reporter state file (listReporterSessions).
 *
 * The true source is the plugin's own on-disk state (written continuously, with or without our consent);
 * four directories index each other:
 *   genie-history/{base64(project dir)}/conversations/{session id}/   project ↔ session roster (dir itself empty)
 *   genie-history/{base64(project dir)}/current.json                   { conversationId, lastUpdated } that project's current session
 *   todos/{session id}.json                                            { conversationId, todos:[{id,status,content}] }
 *   message-queue/*.json                                               per session runtime:{activated,paused,awaitingSessionIdle} + queued messages
 *   file-changes/{session id}/*.json                                   changed files (added/removed lines + diff)
 *
 * The dropdown wants **the sessions active in every project** (not only the currently opened one), so this
 * walks each project dir under genie-history; when there is not a single active session →
 * reason: 'no-open-project'.
 *
 * Discipline (aligned with docs/requirements.md §P0-6 "never fabricate"):
 *   - Sessions have **no** role / progress / elapsed fields; not one is filled in — unreachable means
 *     unreachable;
 *   - The main agent's phase is **inferred** from runtime + todos + file changes; every result carries
 *     `inferred: true`, and the UI must present it as inferred (greyed + labelled), never as reported truth.
 *
 * Scanning the disk is cheap (a few dozen files); a 5-second cache is enough.
 */

const fs = require('node:fs');
const path = require('path');
// WorkGremlin's own storage locations (the state-file dir) come from shared/paths.js.
const { agentBase } = require('@workgremlin/shared');
const { hooksDir } = require('@workgremlin/shared/paths');
// Generic on-disk scanning infrastructure (dir conventions + tolerant file reads); readJson / readDir come
// from roots so they are not redefined everywhere. findPluginStorage finds a product's plugin storage root.
const { readJson, readDir, findPluginStorage } = require('./roots');
// Floor module registry (floors.js): needed when dispatching session titles by client to the registry's
// sessionTitle
const { floors: floorRegistry, floorByAgent } = require('./floors');
// Floor capability modules (module group): every floor (trae / claude / codebuddy / copilot) implements the
// same "session capability" interface, and sessions.js always reaches it as `floor.capability`. Adding a
// floor = one require line in FLOORS + implementing whichever capabilities that floor module needs; call
// sites stay untouched.
//   selectedModelOf(sessionId, agentType)  current model (only floors whose hook payload has no model field)
//   cancelAt(sessionId, sinceTs)           when this turn was cancelled (0 = not cancelled)
//   allCancels()                           full cancel scan → { [sessionId]: time }
//   allDoneHandlers()                      DoneHandler terminal state (trae only)
//   interruptOf(j, startedAt)              interrupt detection (claude / qoder)
//   interruptTail(path, sinceTs)
//   sessionStatus(sessionId)
const trae = require('./floorTrae');
const claude = require('./floorClaude');
const codebuddy = require('./floorCodebuddy');
const copilot = require('./floorCopilot');
// Plugin structured on-disk readers (genie-history / todos / message-queue / file-changes / Copilot SQLite):
// every plugin-kind read is dispatched to a floor module's pluginStore; this file only combines that on-disk
// state with the reporter state files into session rows and never meddles with a plugin's internal dir
// layout. Locating a product's plugin storage root is generic (roots.js's findPluginStorage).

// qoder and claude share the same transcript interrupt detection (see claude.synthMarks), so alias it
// straight to the claude module and the generic dispatcher needs no special case for it.
const qoder = claude;
const FLOORS = { trae, claude, codebuddy, copilot, qoder };

// The flush-window constants (aligned with the CLI floors) live in floors.js and are shared with the
// plugin-kind floors so they are not defined twice.
const { IDLE_MS, BUSY_MS, FRESH_MS, LISTED_MS, DONE_TTL_MS } = require('./floors');

/**
 * Find a floor module by client (floor base name). A floor's "plugin structured readers / disk markers" hang
 * off the floor module (see floorCodebuddy's pluginStore); this file only dispatches by client and knows no
 * product's internal dir layout.
 */
function floorModuleOf(client) {
  return FLOORS[String(client || '').trim().toLowerCase()] || null;
}

/** Empty reader: used when a floor has no pluginStore (e.g. 9F Copilot reads its own SQLite); everything
 *  reads as "none" */
const EMPTY_PLUGIN_STORE = {
  readTodos: () => ({ total: 0, done: 0, doing: '', items: [], at: 0 }),
  readFileChanges: () => ({ count: 0, recent: [], lastAt: 0 }),
  readRuntime: () => ({ runtime: { activated: false, paused: false, awaitingSessionIdle: false }, pending: 0, hasRuntime: false, updatedAt: 0 }),
  collectProjects: () => [],
};

/** This path's (client's) plugin structured reader; a floor without one falls back to the empty reader
 *  (unreadable means unreadable) */
function pluginStoreOf(client) {
  const mod = floorModuleOf(client);
  return (mod && mod.pluginStore) || EMPTY_PLUGIN_STORE;
}


/**
 * The source client of the plugin on-disk path: **passed in per floor**, never hardcoded.
 * The reporter writes its state files per client (CodeBuddy / Codex / Claude … each has its own inside the
 * same project), and every plugin floor (1F CodeBuddy's plugin path, 5F TraeCode-Plugin, a future
 * Codex-Plugin …) recognizes only its own path — otherwise switching to one floor would show the commands
 * another floor is typing, and pop another floor's "task done" at closing time.
 * Callers (sessionRegistry) pass the **floor base name** ('codebuddy' / 'trae' …) — character for character
 * the `client` in the reported state file (see hookCommon's `client = ev.agent`). The form (CLI / plugin)
 * travels as `form` and is not part of the identity, so this is a plain **equality comparison**
 * (case-normalized): no `-plugin` suffix is recognized, and it is not a list.
 */

function clientHit(want, got) {
  if (!want) return true;
  return String(want).trim().toLowerCase() === String(got || '').trim().toLowerCase();
}

/** Cache: listing scans the disk + reads a dozen small json files; 5 seconds is enough */
const TTL = 5_000;
let cache = { at: 0, key: '', value: null };

/**
 * The start moment of this process (server) — the origin of the "epoch".
 * The reporter writes phases into local state files and never deletes them on its own; a phase left behind
 * by the previous run (especially after a kill/crash without SessionEnd) is re-read after a restart and shows
 * up as "a closed project lights up thinking again". So only phases written **after this process started**
 * are trusted: after a restart everything goes back to idle first and lights up again on the next new event.
 * Comparing timestamps instead of "delete the file on exit" because deletion depends on a clean exit, and
 * kill -9 / a crash never reaches it.
 */
const SERVER_STARTED_AT = Date.now();

// The flush-window constants (IDLE_MS / BUSY_MS / FRESH_MS / LISTED_MS / DONE_TTL_MS) are defined centrally
// in floors.js, so sessions.js / copilot.js do not each write their own copy. They are imported above.

/* ------------------------------ Session data ------------------------------ */
/** Each session's todos / changed files / message-queue runtime are dispatched by client to the floor's
 *  pluginStore (see floorCodebuddy.js). */

const REPORTER_WS_FRESH_MS = 5 * 60_000;
/**
 * The window that decides whether a task "is still running": only a **recent hook event**
 * (UserPromptSubmit / PreToolUse / PostToolUse / Notification …) means this turn is generating.
 * Reporter-state metadata (`hb.lastEventAt`) only proves that the session wrote state; it is not task liveness.
 *
 * Why it is needed: pressing ESC in CodeBuddy IDE while it is "thinking / calling a tool" cancels the turn
 * and sends neither Stop nor Interrupt (measured: no such event in events.log), yet the IDE session stays open
 * and its state file remains present, so taskId stays occupied and sessionPhase freezes on its last value
 * (tool / thinking). The old logic used hb.lastEventAt as freshness, so inWindow / sessionPhase could never
 * fall back → the main console kept showing "calling a tool / thinking" although that turn had long been cut.
 * Now only hook event times count: after a cancel there are no new events, so past this window the turn counts
 * as ended and falls back to idle. The window matches inferPhase's FRESH_MS (2 minutes) — the project's
 * uniform rule: "no activity in the last 2 minutes means it is not busy".
 *
 * Known trade-off: a long-running intermediate tool with no hook events at all (say a Bash build taking >2
 * minutes, with only a PreToolUse at the start and a PostToolUse at the end and nothing in between) is
 * misjudged as "ended" and briefly falls back to idle until the PostToolUse restores the phase. That is an
 * acceptable small jitter, no worse than "stuck on thinking forever after a cancel".
 */
const TASK_RUN_MS = 2 * 60_000;
/**
 * Tolerance between the "interrupt marker" and "the last hook event" (see the invalidation in
 * readReporterPhase): the marker's ts is written by the CLI itself while the phase's ts is written by the hook
 * process, and the two can differ by a few milliseconds — the user pressed stop exactly while the last tool's
 * hook was still being written. So a marker is considered newer unless it is "older than the phase by 1s".
 * Cost: when a new turn is sent immediately afterwards (<1s), the new phase is suppressed for a moment; the
 * gain is "once stop is pressed, it never bounces back".
 */
const INTERRUPT_PHASE_SLACK_MS = 1_000;

/**
 * Command-type tools (Bash / execute_command …): **the server always reports them as "calling a tool" with
 * no specialization**.
 *
 * Why Bash is not marked await (awaiting authorization) or given different wording here:
 * In this environment, CodeBuddy Plugin sends neither an "awaiting authorization" notification nor an
 * "authorization finished" one, and command-type tools send no PostToolUse either — so "is it actually waiting
 * for authorization" has no true signal at all. Marking await purely because "the tool is Bash" meant nothing
 * could clear it after run was clicked, and the main console stayed stuck on "awaiting authorization".
 *
 * Now the server only reports honestly: phase tool (calling a tool) + tool name + the real command.
 * The display layer always writes "calling a tool" (no longer swapping wording per tool name), so changing the
 * display rule does not require touching the server. When a real authorization signal (Notification) does
 * arrive, it still takes the `rp.phase === 'await'` truth branch below — that logic is kept as is.
 */

/**
 * Which model this session is using.
 * Every product's model field is read differently, so each product gets an adapter that digs into **its own
 * on-disk state**: TraeCode in trae.selectedModelOf, Claude Code in claude.selectedModelOf. Both exist only
 * because the hook payload has no model field at all. The other products (CodeBuddy / Codex) carry it in the
 * payload and need no adapter; when it truly cannot be read it stays empty (never fabricated).
 * This function only does "dispatch the adapter by client", keeping any product's private storage format out
 * of the generic reader and staying consistent with products.js's table-driven extension convention (adding a
 * product = hanging one entry on MODEL_SOURCES, no change to this function).
 * @param {string} client floor client (base name: 'trae' / 'claude' / 'codex' …)
 * @param {string} sessionId the hook payload's session_id
 * @param {string} agentType the hook payload's agent_type (already persisted)
 */
/** client (floor base name) → adapter that reads "the model of this session"; auto-assembled from each
 *  floor's selectedModelOf (see FLOORS). Floors without selectedModelOf (codebuddy / copilot) naturally fall
 *  through and stay unreadable, as before. */
const MODEL_SOURCES = {};
for (const [key, mod] of Object.entries(FLOORS)) {
  if (typeof mod.selectedModelOf === 'function') MODEL_SOURCES[key] = mod.selectedModelOf;
}
function sessionModel(client, sessionId, agentType = '') {
  const fn = MODEL_SOURCES[String(client || '').toLowerCase()];
  return fn ? fn(sessionId, agentType) || '' : '';
}

function readReporterPhase(workspacePath, client = '', session = '') {
  // A phase **must be tied to a session**: no session, no phase. There is no longer a "take the newest one for
  // this client" fallback — that fallback made the main console show **another session's** phase on the same
  // floor ("nothing selected above, yet some phase is lit below"), which is exactly what scrambled the state.
  // Callers that want a phase must name the session.
  if (!session) return null;
  const dir = hooksDir();
  let win = null;
  let winPending = null;
  let winPrompt = '';
  let winClient = '';
  let winModel = '';
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!sameSession(j, session)) continue;
    // Filter by client. Old state files (written before this change) have no client field — back then there
    // was only CodeBuddy, so attribute them to codebuddy rather than "matches everyone" (otherwise, right
    // after a restart while Codex has not written a state file yet, 3F would briefly borrow 1F's phase).
    if (!clientHit(client, j.client)) continue;
    const sp = j.sessionPhase;
    // Phase freshness no longer expires by "the last hook event time" (the old first gate): that gate made
    // phases fall back too early on long tasks with no intermediate events, or when the IDE cut the turn off
    // with no Stop. "Still busy or not" now belongs to the render side (floorTaskActive: a task still running
    // in the ledger shows thinking) plus cancel detection as a fallback. Here we only check that the phase
    // itself exists and has a write time; it no longer expires by hook event time.
    if (!sp || !sp.ts) continue;
    // A phase older than this process's start is residue from the previous run (a closed project); do not
    // trust it — after a restart wait for a new event before lighting up
    if (sp.ts < SERVER_STARTED_AT) continue;
    // IDE / plugin form: the state-file owner pid is dead = the project / window was closed (no Stop, phase frozen
    // on its last breath). Use this reliable "the process is gone" signal to void the phase, so the main
    // console does not stay stuck on thinking / calling a tool after a window closes abruptly.
    // Only use pid death to judge "gone", never a live pid to judge "busy". A cancelled turn is voided by
    // phaseSuperseded / done.cancelled instead (see below).
    if (j.hb && Number.isInteger(j.hb.pid) && !pidAlive(j.hb.pid)) continue;
    if (workspacePath && sp.workspacePath && path.resolve(sp.workspacePath) !== path.resolve(workspacePath)) continue;
    // Is this "running" phase voided by that floor's cancel / interrupt marker: interrupt detection is floor
    // private knowledge (Claude/Qoder look at the transcript tail, CodeBuddy at message-queue's pauseReason,
    // Trae at DoneHandler), judged by each floor's own phaseSuperseded; the generic phase reader only
    // dispatches (see each floor module).
    if (j.taskId) {
      const floorMod = FLOORS[String(client || '').trim().toLowerCase()];
      if (floorMod && typeof floorMod.phaseSuperseded === 'function' && floorMod.phaseSuperseded(j, sp, INTERRUPT_PHASE_SLACK_MS)) continue;
    }
    // The session was cancelled by the user (CLI pressing ESC to stop: the reporter's Stop writes
    // done.cancelled): a phase frozen on "awaiting authorization / calling a tool" is no longer live and must
    // be voided, otherwise the main console stays lit as "awaiting authorization" after the cancel.
    // The same voiding for the plugin form goes through phaseSuperseded's message-queue signal above; this
    // adds the CLI form (readReporterDones writes done.cancelled into bySession and the task list lights
    // "cancelled" from it — voiding it here on the phase layer is what makes the main console switch to the
    // red "task cancelled" light instead of sitting on "awaiting authorization"). Only a finish not older than
    // the phase (tolerance INTERRUPT_PHASE_SLACK_MS) punctures it, so a normal "calling a tool → finishing"
    // is not wrongly covered by a stale phase.
    if (j.done && j.done.cancelled && j.done.at && Number(j.done.at) + INTERRUPT_PHASE_SLACK_MS >= Number(sp.ts || 0)) continue;
    if (!win || sp.ts > win.ts) {
      win = sp;
      winClient = String(j.client || '');
      // pending from the same state file: written by PreToolUse, cleared by PostToolUse; not cleared for a
      // long time = the tool is blocked by a permission dialog
      winPending = j.pending || null;
      // taskTitle from the same state file = the user's sentence (title); shown front and center while thinking
      winPrompt = j.taskTitle || '';
      // The model is not in this state file (most products' hook payloads do not carry it); read it from
      // TraeCode's own disk state per session. But Kilo / OpenCode plugins
      // (packages/reporter/src/plugin/) **write the model straight into the state file** (their
      // session.created event carries data.model, and the polling path can read it from the db anyway) —
      // so trust that value first and fall back to the disk adapter only when it is missing.
      winModel = String(j.model || "") || sessionModel(winClient, j.sessionId, j.agentType);
    }
  }
  // Copilot 9F has no reporter hook, so its phase is not in this state file — 9F supplies its own readPhase
  // (see reporterTruthPhase dispatching to floorByAgent[base].readPhase: copilot.readPhase =
  // readCopilotPhaseFromSqlite). This function only covers products with hooks; unreadable → return null
  // honestly, never fabricate a fallback.
  if (!win) return null;
  return {
    // Which client wrote this phase (Codex has an explicit PermissionRequest and needs no pending inference)
    client: String(winClient || ''),
    phase: String(win.phase || 'thinking'),
    tool: String(win.tool || ''),
    file: String(win.file || ''),
    // The readable "actual call" the hook wrote at PreToolUse (Read src/main.js / grep ... / Bash ...), shown
    // as the "tool" in the main console tips — more intuitive than the bare tool name
    cmd: String(win.cmd || ''),
    // The user's sentence (the third layer of the main console screen while thinking; the UI uses it only in
    // the thinking phase)
    prompt: String(winPrompt || ''),
    // Which model this session uses (only TraeCode can read it; other floors leave it empty). Unreadable
    // means empty string, never guessed.
    model: String(winModel || ''),
    // When this phase was written: the render layer compares it with the "finish marker" — only a live phase
    // **newer than the finish** counts as "the user sent another turn"; the stale thinking / tool breath
    // before the cancel must not cover the red "task cancelled" light again.
    ts: Number(win.ts) || 0,
    pending: winPending
      ? { tool: String(winPending.tool || ''), file: String(winPending.file || ''), cmd: String(winPending.cmd || ''), at: Number(winPending.at) || 0 }
      : null,
  };
}

/** The "this project" part of a state file name: `@<absolute project path>` sanitized as a whole. */
function stateFileWs(ws) {
  return `@${path.resolve(ws)}`.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Session filter (axis 2): was this state file written by the `session` session?
 *
 * `session` empty → **no filter** (keeps the old behavior: take the newest one among the same client).
 * When a session is specified, old state files (no sessionId field) never count — they belong to the era
 * "before the session concept existed", and hard-attributing them to some session would make "looking at
 * session A" read session B's data.
 */
function sameSession(j, session) {
  return !session || String((j && j.sessionId) || '') === String(session);
}

/** Is the process still alive (signal 0 = probe only, no delivery). Insufficient permission counts as alive. */
function pidAlive(pid) {
  const n = Number(pid);
  if (!n || n < 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists but is not ours; ESRCH = truly gone
    return Boolean(e && e.code === 'EPERM');
  }
}

/** The canonical shape of a session id: a UUID (measured, that is what Claude Code uses). */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * State file name → which session it belongs to (`''` = old naming, no session).
 * An unrecognized name (not this project's state file / not a state file at all) → `null`.
 *
 * The name is decided by the hook's statePath(): `<agent>@<absolute project path>[@<session>]` sanitized as a
 * whole into `[A-Za-z0-9._-]`. **Adding the session appends one more `_<session>` segment to the name**, so the
 * old `endsWith('@<project>.json')` matches nothing — both call sites (hasReporterState / reporterStateMeta)
 * go through here; do not fall back to endsWith.
 *
 * **This encoding is lossy** (`_` is both a separator and a legal character), so from the name alone one
 * cannot tell "project `/a/b` + session `sub`" from "project `/a/b/sub` + no session" — the latter is an
 * old-naming file and would be misread by the former as its own session. So the tail is recognized in two
 * steps:
 *   1. Is it a UUID → accept directly (Claude Code's canonical shape; the vast majority of cases take this
 *      path without reading the file);
 *   2. Not a UUID → read the file content back; **the `sessionId` inside is authoritative** (the hook wrote it
 *      verbatim, unsanitized). A mismatch means reject — so the `/a/b/sub` old file above is correctly
 *      excluded.
 * @param {string} name file name
 * @param {string} wsPart the result of stateFileWs()
 * @param {string} dir the hooks dir (used to read content back in step 2)
 * @returns {string|null} session id (may be '')
 */
function stateFileSession(name, wsPart, dir) {
  if (!/\.json$/i.test(name)) return null;
  const base = name.slice(0, -5);
  if (base.endsWith(wsPart)) return '';
  const i = base.lastIndexOf(wsPart);
  if (i < 0) return null;
  const tail = base.slice(i + wsPart.length);
  // The session tail is one `_<id>` segment. **`_` itself must be allowed inside the id** — Kilo / OpenCode
  // session ids look like `ses_f22614607ffeQV…` (OpenCode is the same), and while the id contains no `_`,
  // **test fixtures and any future id with an underscore** would be filtered out here: that state file would
  // be treated as "unrecognized" and skipped, so `hasReporterState` / `reporterStateMeta` always return false
  // → the UI keeps showing "not reported" instead of "hook connected, nothing happening right now".
  // This used to be `[A-Za-z0-9.-]` (only UUIDs passed).
  //
  // Loosening introduces no ambiguity: this encoding is lossy anyway (`_` is both a separator and a legal
  // character), and the very next step settles it by **reading the sessionId from the file content** — a
  // mismatch still means reject.
  if (!/^_[A-Za-z0-9._-]+$/.test(tail)) return null;
  const cand = tail.slice(1);
  if (SESSION_UUID_RE.test(cand)) return cand;
  const j = readJson(path.join(dir, name));
  return j && String(j.sessionId || '') === cand ? cand : null;
}

/**
 * Has this project ever had a hook (i.e. does it have a matching hook state file)?
 *
 * This is different from "is there a fresh phase": after a session ends the hook clears sessionPhase
 * (correct behavior), but then the CLI floor must not fall back to "guessing from the jsonl mtime" (that
 * would keep 3F showing "calling a tool / editing xxx.jsonl"); it should show "idle". The render layer uses
 * this field to tell "no hook" from "hook connected but nothing happening right now".
 *
 * The state file name is generated by the hook's statePath(): `<member>@<absolute project path>[@<session>]`,
 * with anything outside [A-Za-z0-9._-] replaced by `_`.
 * @param {string} workspacePath
 * @param {string} [client] source client; empty means no filter
 */
function hasReporterState(workspacePath, client = '') {
  const ws = String(workspacePath || '').trim();
  if (!ws) return false;
  const m = stateFileWs(ws);
  const dir = hooksDir();
  for (const name of readDir(dir)) {
    // Note: test for null, not for falsy — old-naming files (no session) return an empty string, and those
    // are **this project's** state files too
    if (stateFileSession(name, m, dir) === null) continue;
    if (!client) return true;
    const j = readJson(path.join(dir, name));
    // Old files record no client → attribute to codebuddy (as above)
    if (clientHit(client, j && j.client)) return true;
  }
  return false;
}

/**
 * Has this project ever had a hook, and **which session** does that state file belong to?
 *
 * Why the session id matters: hooks are loaded per session (installed at session start, and config changes
 * afterwards do not affect it), so "a state file exists in the project" does not mean "the session you are
 * looking at is reporting" — measured: an old session opened at 13:40 had no hook, but `codex exec` had run
 * in the same project, so the state file existed and the UI showed this session as "idle", looking like
 * "the whole conversation had no state change".
 * @returns {{instrumented: boolean, sessionId: string}}
 */
function reporterStateMeta(workspacePath, client = '', session = '') {
  const ws = String(workspacePath || '').trim();
  if (!ws) return { instrumented: false, sessionId: '' };
  const m = stateFileWs(ws);
  const dir = hooksDir();
  let best = null;
  let bestTs = -1;
  for (const name of readDir(dir)) {
    const fileSession = stateFileSession(name, m, dir);
    if (fileSession === null) continue;
    // With a session specified, only that one counts: the session in the file name was written by the hook and
    // is the most trustworthy; old-naming files (no session) never count when a session is specified —
    // otherwise "looking at session B" would borrow session A's old file.
    if (session && fileSession !== session) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    // Old state files record no client → attribute to codebuddy (same rule as the phase reader)
    if (!clientHit(client, j.client)) continue;
    const ts = (j.sessionPhase && j.sessionPhase.ts) || j.taskStartedAt || (j.hb && j.hb.lastEventAt) || 0;
    if (ts >= bestTs) {
      bestTs = ts;
      best = j;
    }
  }
  if (!best) return { instrumented: false, sessionId: '' };
  return { instrumented: true, sessionId: String(best.sessionId || '') };
}

/**
 * The floor's primary phase source. Reporter-backed floors read the state file; floors without a reporter
 * may override `readPhase` (for example 9F Copilot reads its own SQLite store).
 *
 * This deliberately does **not** consult `readPhaseFallback`: callers that need to know whether the reporter
 * actually reported a phase must not mistake polling-derived data for reported truth.
 *
 * @param {string} [client] floor base name or memberId; normalized with agentBase() before dispatch
 */
function reporterTruthPhase(workspacePath, client = '', session = '') {
  // A phase must be tied to a session (see readReporterPhase): no session named / no session id available → no phase.
  if (!session) return null;
  const base = agentBase(client);
  const floor = floorByAgent[base] || null;
  const readPhase = floor && typeof floor.readPhase === 'function' ? floor.readPhase : readReporterPhase;
  const rp = readPhase(workspacePath, base, session);
  if (!rp || !rp.phase) return null;

  let body;
  // Every branch below **builds its own object** instead of spreading rp — whatever needs to be carried out
  // must be added in each branch; missing one silently drops it (that is how model was lost once).
  if (rp.phase === 'await') {
    body = {
      phase: 'await',
      action: rp.tool ? `申请执行 ${rp.tool}` : '等待用户授权',
      target: rp.file || rp.target || '',
      context: ['等待用户授权后继续', rp.tool && `工具：${rp.tool}`, (rp.file || rp.target) && `目标：${rp.file || rp.target}`].filter(Boolean),
      tool: rp.tool || '',
      prompt: rp.prompt || '',
      model: rp.model || '',
      // When the phase was written: the render layer compares it with the finish marker
      // (see IsoOfficeView's consoleLive guard)
      ts: Number(rp.ts) || 0,
    };
  } else if (rp.phase === 'tool') {
    // Prefer the full command reported by the hook (Read src/main.js / grep ... / Bash npm run build), and
    // fall back to the generic "calling Xxx" wording when there is none.
    const file = rp.file || rp.target || '';
    const cmd = rp.cmd || rp.action || (rp.tool ? `调用 ${rp.tool}` : '调用工具');
    body = {
      phase: 'tool',
      action: cmd,
      tool: rp.tool || '',
      target: file,
      context: Array.isArray(rp.context) && rp.context.length ? rp.context : file ? [`目标：${file}`] : [],
      prompt: rp.prompt || '',
      model: rp.model || '',
      ts: Number(rp.ts) || 0,
    };
  } else {
    // Every other phase is passed through verbatim. Idle / done must not be squashed into thinking.
    body = {
      phase: rp.phase,
      action: rp.action || '',
      target: rp.target || rp.file || '',
      context: Array.isArray(rp.context) ? rp.context : [],
      tool: rp.tool || '',
      prompt: rp.prompt || '',
      model: rp.model || '',
      ts: Number(rp.ts) || 0,
    };
  }

  return {
    sessionId: String(rp.sessionId || session || ''),
    inferred: rp.inferred === true,
    ...body,
  };
}

/**
 * The main-console phase for a floor/session.
 *
 * Order is fixed: primary/reported phase first, then the floor's polling fallback. Only floors that declare
 * `readPhaseFallback` participate (Cline / Qoder / Kilo / OpenCode); all product-specific polling stays in its floor
 * module, while this central function owns the precedence rule.
 */
function reporterMainPhase(workspacePath, client = '', session = '') {
  const truth = reporterTruthPhase(workspacePath, client, session);
  if (truth) return truth;

  const floor = floorByAgent[agentBase(client)] || null;
  if (!session || !floor || typeof floor.readPhaseFallback !== 'function') return null;
  const rp = floor.readPhaseFallback(workspacePath, session);
  if (!rp || !rp.phase) return null;
  return {
    sessionId: String(rp.sessionId || session || ''),
    inferred: true,
    phase: String(rp.phase),
    action: String(rp.action || ''),
    target: String(rp.target || ''),
    context: Array.isArray(rp.context) ? rp.context : [],
    tool: String(rp.tool || ''),
    prompt: String(rp.prompt || ''),
    model: String(rp.model || ''),
    ts: Number(rp.ts) || 0,
  };
}

/**
 * Snapshot backfill (rolling ticker's phase): CLI / Hook session rows are listed with
 * `phase: 'unreported'` because that path never fabricates a phase (see sessionRegistry.handleCliHook,
 * the "never fabricate" discipline). The reporter state file, however, holds the live phase of **every**
 * session — one file per session, see shared/paths.statePath — it is just that nothing read it for a
 * **non-selected** session (the main console asks /reporter-phase for the selected one only).
 *
 * Resolve it here through reporterTruthPhase, so the session
 * snapshot — and everything that reads it, e.g. the ticker's phase suffix — gets the reported truth
 * too (including "awaiting authorization", which a hook floor produces but a phase-less row never showed).
 *
 * Floors that already carry their own phase in the snapshot row through a primary `readPhase` (9F Copilot
 * reads its own SQLite) are left untouched — their handler already wrote that inferred phase.
 *
 * @returns {object|null} a reporterMainPhase-shaped phase, or null when there is nothing to fill
 */
function reporterSnapshotPhase(workspacePath, client, session) {
  if (!session) return null;
  const base = agentBase(client);
  const floor = floorByAgent[base] || null;
  if (floor && typeof floor.readPhase === 'function') return null;
  return reporterTruthPhase(workspacePath, client, session);
}

/**
 * The reporter hook's "active window": UserPromptSubmit sets taskId, Stop clears it.
 * Only inside this window (the user submitted a task and the agent has not finished) does it count as "alive";
 * a session that exists but has no events is always idle — the main console uses this to decide whether to
 * show an active state.
 *
 * It also checks "whether this state file itself is still alive": leftover / exited sessions leave dead files
 * in the hooks dir whose taskId never updates (e.g. old-naming files from before the switch to "one file per
 * station + project"). Without that check, a single dead file whose taskId matches the current project pins
 * inWindow to true forever, so after Stop it still infers "thinking" from "still working".
 * @param {string} workspacePath currently opened project; empty means no project filter
 * @param {string} [client] source client; empty means no client filter
 * @returns {boolean}
 */
function readReporterActiveTask(workspacePath, client = '', session = '') {
  // Same reasoning: the active window is judged **per session** — without naming a session there is no
  // "is this session running" to speak of.
  if (!session) return false;
  const dir = hooksDir();
  const now = Date.now();
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j || !j.taskId) continue;
    if (!sameSession(j, session)) continue;
    // Filter by client (same rule as readReporterPhase: old state files record no client → codebuddy):
    // when another product is running in the same project, do not count its task as this floor's active window
    if (!clientHit(client, j.client)) continue;
    const ws = j.taskWorkspacePath || '';
    if (workspacePath && ws && path.resolve(ws) !== path.resolve(workspacePath)) continue;
    // Only hook event times count. `hb.lastEventAt` identifies state-file metadata, not task liveness.
    // After a cancel there are no new events, so past TASK_RUN_MS the turn falls back to idle.
    const lastAt = Math.max(
      Number(j.taskStartedAt) || 0,
      Number(j.sessionPhase && j.sessionPhase.ts) || 0
    );
    if (!lastAt || now - lastAt > TASK_RUN_MS) continue;
    // TraeCode cancel fallback: a cancel already confirmed in renderer.log (the cancel time is newer than this
    // turn's start) → not active (TraeCode sends no Stop hook event on cancel and keeps taskId occupied
    // forever, so we puncture it manually here).
    if (String(client || '').trim().toLowerCase() === 'trae') {
      const atT = trae.cancelAt(j.sessionId, Number(j.taskStartedAt) || 0);
      if (atT) continue;
    }
    return true;
  }
  return false;
}

/**
 * The "done" marker the reporter hook writes at Stop (carrying the project path), read back in **one disk
 * scan per project + client**. Returns { latest, bySession }: latest = the newest one in that
 * (project, client); bySession = session id -> that session's newest one.
 *
 * Why it is split into "one disk read" and "take by session": a session-table scan can turn up hundreds of
 * historical session files, and calling readReporterDone once per row would scan the hooks dir hundreds of
 * times (see the doneScans cache keyed by (project, client) in sessionRegistry).
 */
/**
 * The state file's `roundFiles` (`{path,op,abs}`) → the done marker's `files` shape (with size).
 * On cancel it fills in "which files were already touched before the cancel" (same rule as hook.js's
 * collectRoundFiles): dedupe, deletions get no size, unstattable gets none (never fabricated).
 * @param {{roundFiles?: Array<any>}} j state file content
 */
function roundFilesOf(j) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(j && j.roundFiles) ? j.roundFiles : []) {
    const p = typeof x === 'string' ? x : x && x.path;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    let size = null;
    const abs = x && typeof x === 'object' ? x.abs : '';
    if (abs && !(x && x.op === 'delete')) {
      try {
        const s = fs.statSync(abs);
        if (s.isFile()) size = s.size;
      } catch {
        /* File deleted / moved: no size, the path is still recorded */
      }
    }
    out.push(size == null ? { path: p } : { path: p, size });
  }
  return out;
}

function readReporterDones(workspacePath, client = '') {
  const dir = hooksDir();
  const now = Date.now();
  /** sessionId -> that session's newest one */
  const bySession = new Map();
  /** The newest one in this project + client (floors that cannot get a session id fall back to it) */
  let latest = null;
  /** Among the synthesized fallback "cancel" markers, those for which the server must re-issue task/end
   *  (cancelled) (see sessionRegistry's flush). These products (Claude / Qoder pressing stop, CodeBuddy
   *  plugin pressing stop) send **not a single hook event** on cancel, so the server can only recognize it
   *  from disk (see claude.interruptOf / codebuddy.cancelAt) and then have sessionRegistry de-duplicate and
   *  re-issue one task/end on refresh — otherwise that ledger row hangs on "in progress" forever. */
  const cancels = [];
  /**
   * The "current turn" found by the scan: session id + this turn's start time.
   * Handed to sessionRegistry to close **the previous turn pushed out by this one** (those that never
   * received an end event for this session and still hang as running in the ledger) — one session cannot run
   * two turns at once, see bus.endStaleTasksOfSession.
   */
  const rounds = [];
  /**
   * Synthesize one cancel marker: both the per-session copy for the console (bySession, the red light depends
   * on it) and a copy listed in cancels so the ledger gets its cut. Both signals share it; do not write it twice.
   */
  const synthCancel = ({ id, j, ws, at, files = [], said = '', result = '', consoleMark = true, taskId }) => {
    if (!at) return;
    const tid = taskId !== undefined ? taskId : (j ? j.taskId : '');
    const mark = {
      at,
      title: j.taskTitle || '',
      workspacePath: ws,
      sessionId: id,
      cancelled: true,
      files: files.slice(0, 8),
      fileCount: files.length,
      said,
    };
    if (consoleMark) {
      if (id && (!bySession.get(id) || Number(mark.at) > Number(bySession.get(id).at))) bySession.set(id, mark);
      if (!latest || Number(mark.at) > Number(latest.at)) latest = mark;
    }
    cancels.push({
      sessionId: id,
      taskId: tid,
      client: j.client,
      workspacePath: ws,
      at,
      title: j.taskTitle || '',
      form: j.form || '',
      files,
      fileCount: files.length,
      result,
    });
  };
  /** A real completion (a "normal finish" marker supplied by the floor, cancelled:false): overwrites only
   *  when it is newer than (or equal to) the existing mark, so DoneHandler's completed can cover an
   *  earlier synthesized cancelled:true. Produces no cancels row. */
  const synthDone = ({ id, ws, at, title = '', files = [] }) => {
    if (!at) return;
    const existing = bySession.get(id);
    if (!existing || Number(at) >= Number(existing.at || 0)) {
      const mark = {
        at,
        title: title || '',
        workspacePath: ws,
        sessionId: id,
        cancelled: false,
        files: files.slice(0, 8),
        fileCount: files.length,
        said: '',
      };
      bySession.set(id, mark);
      if (!latest || Number(mark.at) > Number(latest.at)) latest = mark;
    }
  };
  /** Hook state files merged by sessionId (each floor's own cancel/completion probe takes workspacePath /
   *  roundFiles / the client filter from here) */
  const hookBySid = new Map();
  /** All hook state files (not deduped by sessionId): Claude/Qoder's cancel probe scans file by file, same
   *  rule as the main loop */
  const allFiles = [];
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    allFiles.push(j);
    if (j.sessionId) hookBySid.set(String(j.sessionId), { j });
    if (!clientHit(client, j.client)) continue;
    const ws = (j.done && j.done.workspacePath) || j.taskWorkspacePath || '';
    if (workspacePath && ws && path.resolve(ws) !== path.resolve(workspacePath)) continue;
    const id = String(j.sessionId || '');
    // The real done marker (written by Stop): keep the newest one per session
    if (j.done && j.done.at && now - Number(j.done.at) <= DONE_TTL_MS) {
      const done = j.done;
      const prev = id ? bySession.get(id) : null;
      if (id && (!prev || Number(done.at) > Number(prev.at))) bySession.set(id, done);
      if (!latest || Number(done.at) > Number(latest.at)) latest = done;
      // CLI-form cancel (ESC to stop): the reporter's own authoritative marker is the done.cancelled Stop
      // writes; it is floor-agnostic.
      // Besides going into bySession (the main console lights red from it), it must also be synthesized into
      // cancels — otherwise sessionRegistry's flushSynthesizedCancels never sees it and task_runs stays on the
      // done the CLI itself reported (result still being that "interrupted by user" sentence), so the ticker /
      // task status shows "completed" and does not match the main console's red light.
      // The plugin form's cancel goes through each floor's synthMarks (it has the message-queue signal the CLI
      // lacks); this adds the CLI case.
      // result uses done.said verbatim: a cancel still carries the output summary ("did not finish" is not
      // "produced nothing").
      if (done.cancelled) {
        const cancelledAt = Number(done.at) || 0;
        // Only accept a cancel "after this turn started": an old cancel (previous turn) must not be charged
        // to the new turn (same sinceTs rule as synthMarks).
        const sinceTs = Number(j.taskStartedAt) || 0;
        if (!sinceTs || cancelledAt >= sinceTs) {
          const doneFiles = Array.isArray(done.files) ? done.files : [];
          cancels.push({
            sessionId: id,
            taskId: j.taskId,
            client: j.client,
            workspacePath: ws,
            at: cancelledAt,
            title: j.taskTitle || '',
            form: j.form || '',
            files: doneFiles,
            fileCount: Number.isFinite(Number(done.fileCount)) ? Number(done.fileCount) : doneFiles.length,
            result: String(done.said || ''),
          });
        }
      }
    }
    /* The floor-specific "cancel" marker synthesis (Claude/Qoder's transcript signal, Trae's renderer.log,
       CodeBuddy plugin's message-queue) is funneled into each floor module's synthMarks (dispatched by
       FLOORS at the bottom of this file); no product-specific logic is written here. The historical
       fallback "task slot stuck + last transcript turn state='running' ⇒ judged interrupted" was removed on
       2026-09-29: it cannot tell "still thinking slowly" from "interrupted", so turns that go a long time
       without calling a tool were misjudged as cancelled and the console popped a red "task cancelled" and
       then jumped back to "thinking" — better to stay on the old phase and wait for the freshness window to
       fall back to idle than to falsely report a cancel. */
    if (j.taskId) {
      const startedAtJ = Number(j.taskStartedAt) || 0;
      // Carry taskId too: sessionRegistry's "previous turn pushed out" cleanup uses it to explicitly exclude
      // the current turn itself (judging the boundary by startedAt >= ts alone is not intuitive enough; belt
      // and braces), see bus.endStaleTasksOfSession.
      if (id && startedAtJ) rounds.push({ sessionId: id, taskId: j.taskId, taskStartedAt: startedAtJ, client: j.client });
    }
    // The floor-specific cancel probes for "the user pressed stop but not one hook event was sent" are handed
    // to each floor module (see synthMarks dispatched by FLOORS at the bottom); the generic code only collects
    // the "current turn" start and hardcodes nothing product-specific.
  }
  /* --- TraeCode scans its cancel signal independently ---
     The data source is Trae's own renderer.log (DoneHandler status:"canceled" / StreamDomainService
     cancelReason:"stop_button" / NotificationPort stopType:"cancel" / stream-diagnostics
     transformedStatus:"canceled" — all four carry a sessionId), parsed by trae.allCancels()
     (cached by mtime+size, same rule as traeModels.js).

     Why it is **not** done inside the hook state file scan loop above:
       · On a Trae cancel the **Stop hook never fires** (Stop is configured in hooks.json, yet
         execCommandHook is never called again), so renderer.log is the only authoritative signal.
       · Hook state files are "one per session": starting a new turn overwrites the old taskId /
         taskStartedAt / sessionPhase — if cancel detection were tied to `if (j.taskId)` + `j.taskStartedAt`'s
         sinceTs filter, then once the window "previous turn cancelled → new turn starts immediately" passes,
         the previous turn's cancel signal is filtered out by the new startedAtJ and the done marker can never
         be synthesized.

     Why it is **not** done in the hook state file scan loop, and why there is **no** sinceTs/smart judgment
     either:
       · On a Trae cancel the Stop hook never fires; renderer.log is the only authoritative signal.
       · Hook state files are "one per session": starting a new turn overwrites the old taskId / taskStartedAt.
         If cancel detection were tied to `startedAtJ`, then once the window "previous turn cancelled → new
         turn starts immediately" passes, the old cancel signal is filtered out by the new startedAtJ and the
         done marker can never be synthesized.
       · The render layer itself decides what to show by "which is newer, phase.ts or done.at": done.at older
         but phase.ts newer → the new turn is running normally and covers the cancelled state
         (L459-470 IsoOfficeView.vue), so **no false red light**. Hence no smart filtering is needed. */
  // Floor-specific cancel/done marker synthesis: each floor implements synthMarks (see each floor module);
  // the generic code only dispatches. With client empty (no product specified) scan every floor; otherwise
  // run only the named one. qoder is already aliased to the claude module in FLOORS, so no special case here.
  const bases = client
    ? [String(client).trim().toLowerCase()].filter(Boolean)
    : Object.keys(FLOORS);
  const seen = new Set();
  for (const base of bases) {
    const floor = FLOORS[base] || null;
    if (!floor || seen.has(floor) || typeof floor.synthMarks !== 'function') continue;
    seen.add(floor);
      floor.synthMarks({
        workspacePath,
        client,
        hookBySid,
        allFiles,
        clientHit,
        roundFilesOf,
        synthCancel,
        synthDone,
        bySession,
        now,
      });
  }

  return { latest, bySession, cancels, rounds };
}

/** The single source of truth for "task done": take the done marker of **one session** (never guess from the
 *  phase falling back to idle, which would pop mid-turn). Several sessions may exist under one
 *  (project, client) and each is read separately; floors whose session id is unavailable (Codex's rollout
 *  file names carry no session_id) fall back to "the newest one for that client" — not a guess, just relaxed
 *  that far. */
function readReporterDone(workspacePath, client = '', session = '') {
  // The done marker likewise **must be tied to a session**: without a session there is no "this turn finished".
  // (Previously an empty `session` fell back to "the newest one for that client" — that charged another
  // session's finish on the same floor to you.)
  if (!session) return null;
  const { bySession } = readReporterDones(workspacePath, client);
  const hit = bySession.get(String(session)) || null;
  if (hit) return hit;
  // 9F GitHub Copilot has no hook: the state-file path is always empty, so its done marker must come from its
  // own session log (completedAt of the newest request, see readCopilotLiveRequest) — otherwise 9F never gets
  // that "task done" moment (measured 2026-09-28: 7F/8F both had it, 9F stayed empty).
  if (String(client || '').trim().toLowerCase() === 'copilot') {
    const d = copilot.readCopilotDone(session);
    if (d) return d;
  }
  return hit;
}



/**
 * The session list reported by the hook — the session source for "hook-only" floors (see products.js's
 * hookSource).
 *
 * TraeCode IDE has no scannable session disk state (`~/.trae-cn/memory/*.jsonl` is its own memory file, not a
 * conversation; using it as a session would be fabrication), so its session table is built directly from the
 * reporter state files: sessionId is the hook payload's `session_id`, and the project path comes from the
 * workspacePath recorded in the phase / task — both measured values, never guessed. Old-naming files (no
 * sessionId) have no session dimension and do not count.
 * @param {string} client client identity (the client of **this source path**, e.g. trae / codebuddy); empty means no filter
 * @param {{includeEnded?: boolean}} options by default sessions that got a SessionEnd are omitted; the CLI JSONL cleanup needs the full state
 * @returns {Array<{sessionId: string, workspacePath: string, lastEventAt: number, endedAt: number}>}
 */
function listReporterSessions(client = '', { includeEnded = false } = {}) {
  const dir = hooksDir();
  const byId = new Map();
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!clientHit(client, j.client)) continue;
    const sessionId = String(j.sessionId || '').trim();
    if (!sessionId) continue;
    const sp = j.sessionPhase || {};
    const endedAt = Number(j.sessionEndedAt) || 0;
    const lastEventAt = Math.max(
      Number(j.hb && j.hb.lastEventAt) || 0,
      Number(sp.ts) || 0,
      Number(j.taskStartedAt) || 0
    );
    if (!lastEventAt) continue;
    const prev = byId.get(sessionId);
    const recordAt = Math.max(lastEventAt, endedAt);
    // One session may have several state files (project changed / old-naming residue): take the newest one's
    // project
    if (!prev || recordAt > prev.recordAt) {
      byId.set(sessionId, {
        sessionId,
        workspacePath: String(sp.workspacePath || j.sessionWorkspacePath || j.taskWorkspacePath || ''),
        form: String(j.form || ''),
        lastEventAt,
        endedAt,
        currentProcess: Number(j.hb && j.hb.pid) === process.pid,
        recordAt,
      });
    }
  }
  return [...byId.values()].filter((s) => includeEnded || !s.endedAt);
}

/**
 * The project currently "really being worked on": take the project path the reporter hook last wrote a phase /
 * task into. The reporter stamps phases on REAL_WS (the project it actually runs in), not on whatever office
 * manually recorded as "opened project", so this judges by the newest activity, avoiding phases being
 * attributed to the old project when a new one is opened directly in the IDE (the main console would not match
 * the dropdown). Past the freshness window (REPORTER_WS_FRESH_MS) it counts as stale and falls back to the passed-in
 * fallback (usually office's currently opened project).
 * @param {string} fallback fallback value
 * @returns {string}
 */
function freshestReporterWs(fallback, client = '', session = '') {
  const dir = hooksDir();
  const now = Date.now();
  let best = '';
  let bestTs = 0;
  for (const name of readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (!sameSession(j, session)) continue;
    if (!clientHit(client, j.client)) continue;
    const sp = j.sessionPhase;
    const ts = (sp && sp.ts) || (j.taskId ? j.taskStartedAt || 0 : 0);
    const ws = (sp && sp.workspacePath) || j.taskWorkspacePath || '';
    if (!ws || !ts || now - ts > REPORTER_WS_FRESH_MS) continue;
    // As above: only trust phases written after this process started, so residue from the previous run does
    // not decide "the current project"
    if (ts < SERVER_STARTED_AT) continue;
    if (ts > bestTs) {
      bestTs = ts;
      best = ws;
    }
  }
  return best ? path.resolve(best) : fallback ? path.resolve(fallback) : '';
}

/**
 * The main agent's phase: sessions have no "phase" field on disk, so it can only be inferred.
 * Hence every return value carries inferred: true and the UI presents it as inferred.
 */
function inferPhase({ todos, files, runtime, pending, lastUpdated, now, inWindow }) {
  // Active window = the reporter hook's UserPromptSubmit..Stop (the local state file's taskId is non-empty).
  // Outside the window → always idle: the session exists but has no events, so never show an active state out
  // of thin air.
  if (!inWindow) {
    return { phase: 'idle', action: '', inferred: true };
  }
  // No clue at all (no todos, no changed files, no runtime) → idle
  if (!todos.total && !files.count && !runtime.activated) {
    return { phase: 'idle', action: '', inferred: true };
  }
  // Restart epoch: the time evidence used for inference (file changes / todos / runtime writes) must likewise
  // be **after this process started**. Otherwise "the last file change left by the previous run" (still inside
  // the BUSY_MS window) is judged "calling a tool" the instant we restart, contradicting "idle first after a
  // restart, wait for the next new event". Same yardstick as readReporterPhase.
  const afterRestart = (ts) => Number(ts) >= SERVER_STARTED_AT;
  // Explicit states are trusted only when "there really was recent movement", so a runtime left behind after
  // the IDE closes does not hang around
  if (runtime.paused && afterRestart(lastUpdated) && now - lastUpdated < IDLE_MS) {
    return { phase: 'idle', action: '会话已暂停', inferred: true };
  }
  // "Wrap up once the session is idle": the plugin queued messages to be sent after this turn ends; nobody is
  // working — report idle and put the reason in action. This used to report summarize ("summarizing"), but
  // that phase never occurs on a real machine (only the old demo script produced it), and keeping it made
  // "not working" look like "summarizing" (removed 2026-10-01, see renderer/src/iso/mainConsole.js).
  if (runtime.awaitingSessionIdle && afterRestart(lastUpdated) && now - lastUpdated < IDLE_MS) {
    return { phase: 'idle', action: '等会话空闲后收尾', inferred: true };
  }

  // Working: the evidence must be "fresh", otherwise leftover in_progress todos / file changes after the IDE
  // closes keep showing "tool"
  if (todos.doing && afterRestart(todos.at) && now - todos.at < IDLE_MS) {
    return { phase: 'tool', action: todos.doing, inferred: true };
  }
  if (afterRestart(files.lastAt) && now - files.lastAt < BUSY_MS) {
    const f = files.recent[0];
    return { phase: 'tool', action: `改 ${f.name}（+${f.added}/-${f.removed}）`, inferred: true };
  }
  // The runtime is very fresh (the plugin wrote to disk recently) → this turn of conversation really is
  // advancing (covers pure reasoning, read-only tools, and other cases with no file/todo evidence).
  // There is no hard evidence of "calling a tool right now", only that it is moving, so file it under
  // "thinking" — never show "calling a tool" out of thin air.
  if (afterRestart(lastUpdated) && now - lastUpdated < FRESH_MS) {
    return { phase: 'thinking', action: '', inferred: true };
  }

  // Messages queued to be sent (and not ancient residue) → idle + the queued count.
  // This used to report plan ("planning"), but queued messages do not mean the agent is planning — same demo
  // state, removed together on 2026-10-01.
  if (pending > 0 && afterRestart(lastUpdated) && now - lastUpdated < IDLE_MS) {
    return { phase: 'idle', action: `${pending} 条待发消息排队中`, inferred: true };
  }

  // Nothing new: the IDE is probably closed / waiting for the user. Fall back to idle; do not show an active
  // phase just because "it was activated once"
  return { phase: 'idle', action: '会话空闲', inferred: true };
}

/** Full information for one session */
function sessionInfo(storage, id, { current = false, now = Date.now(), workspacePath = '', inWindow = false, client = '' } = {}) {
  // Reading the structured disk state (todos / file-changes / message-queue) is dispatched by client to that
  // floor's pluginStore (1F CodeBuddy's genie-history layout belongs to floorCodebuddy.js; this file only
  // combines and knows no product's dir layout).
  const store = pluginStoreOf(client);
  const todos = store.readTodos(storage, id);
  const files = store.readFileChanges(storage, id);
  const mq = store.readRuntime(storage, id);
  const lastUpdated = Math.max(todos.at, files.lastAt, mq.updatedAt) || null;
  // Active = the current session with recent movement / a fresh runtime / a file changed just now.
  // Key point: after the IDE closes the plugin stops writing, but current.json still points at it and
  // runtime.activated stays true, so activity cannot be judged from current / activated alone — "recent writes"
  // must confirm it is really alive, otherwise a session whose window was closed stays stuck in the list with
  // its phase frozen on some active state.
  const active = Boolean(
    (current && lastUpdated && now - lastUpdated < IDLE_MS) ||
      (mq.runtime.activated && lastUpdated && now - lastUpdated < IDLE_MS) ||
      (files.lastAt && now - files.lastAt < BUSY_MS)
  );
  // Still listed (wide window, 60 minutes); `active` remains the "hot window" and only affects phase inference
  const listed = Boolean(lastUpdated && now - lastUpdated < LISTED_MS);
  const inferred = inferPhase({ todos, files, runtime: mq.runtime, pending: mq.pending, lastUpdated, now, inWindow });

  /** Third layer of the hover screen: the task list (status marked with symbols, not translated) */
  const mark = { completed: '✓', in_progress: '▶', pending: '·' };
  let phase = inferred.phase;
  let action = inferred.action;
  let target = '';
  let tool = '';
  let context = todos.items.map((t) => `${mark[t.status] || '·'} ${t.content}`);

  // Reported truth: the reporter hook writes the phase of every event (thinking / calling a tool / awaiting
  // authorization) into a local state file. It outranks a phase inferred from genie-history and takes effect
  // only on the "current session" (the phase necessarily belongs to this agent).
  let reported = false;
  let prompt = '';
  if (current && inWindow) {
    // **This session's id must be passed (axis 2)**: state files are one per session, so without the session
    // you get the newest one on the same floor — with several sessions open on one floor (CLI + Plugin / two
    // plugin sessions), an idle session borrows another's running "thinking" and the main console sticks on
    // thinking forever (this function is one of three missed filters; see also inWindow / done).
    const rp = reporterTruthPhase(workspacePath, client, id);
    if (rp) {
      reported = true;
      phase = rp.phase;
      action = rp.action;
      target = rp.target;
      context = rp.context;
      tool = rp.tool || '';
      prompt = rp.prompt || '';
    }
  }

  // Done marker: the reporter writes it only at Stop (distinguished by project + client) and it is the single
  // source of truth for "task done"; more reliable than "the phase fell back to idle" — if a task goes idle
  // mid-run because of a poll gap or cross-project bleed, it must never pose as done.
  // Also taken by **this session's id**: without the session it falls back to the newest one on the same floor
  // and moves another session's "done / cancelled" onto this one.
  const done = readReporterDone(workspacePath, client, id) || null;
  const doneAt = done ? done.at : 0;
  const doneTitle = done ? done.title || '' : '';
  // Only keep files changed "after this turn's task started": file-changes accumulates for the whole session,
  // and not filtering would present a previous turn's (or older) changes as "this completion" — typical: this
  // turn was only a push, yet it shows how many files the previous turn changed.
  // When done.startedAt is missing (old data) do not filter; fall back to the old "take the newest few".
  const doneStartedAt = done ? Number(done.startedAt) || 0 : 0;
  const doneAll = done && done.cancelled
    ? [] // An interrupted turn often changed nothing: do not count the whole session's file changes as "this completion"
    : (done
      ? (Array.isArray(files.recent) ? files.recent.filter((f) => !doneStartedAt || Number(f.at) >= doneStartedAt) : [])
      : []);

  return {
    id,
    current,
    active,
    listed,
    // Having a runtime means the plugin still recognizes this session; without one it is a historical session
    // (only fossils of todos / changes remain)
    live: Boolean(mq.hasRuntime),
    lastUpdated,
    runtime: mq.runtime,
    pending: mq.pending,
    todos: { total: todos.total, done: todos.done, doing: todos.doing, items: todos.items },
    files: { count: files.count, recent: files.recent, lastAt: files.lastAt || null },
    phase,
    action,
    target,
    tool,
    context,
    prompt,
    doneAt,
    doneTitle,
    doneCount: doneAll.length, // Files changed by this turn's task (counted before slicing)
    doneFiles: doneAll.slice(0, 6),
    // This turn was cut short (the reporter writes done.cancelled at Interrupt): the render layer lights the
    // red "task cancelled" from this, not "task done".
    doneCancelled: Boolean(done && done.cancelled),
    inferred: !reported, // Reported truth (reporter hook) does not count as inference
  };
}

/* ------------------------------ Public: listing sessions ------------------------------ */

/** Project path completion and genie-history project collection come from the floor's pluginStore
 *  (see collectProjects in floorCodebuddy.js). */

/**
 * List the active sessions in **all projects** (not limited to the currently opened one).
 * @param {{workspacePath?: string, force?: boolean, client?: string, pluginRe?: RegExp[], currentOnly?: boolean, activeSessions?: object[]}} o
 * @returns {{ok: true, sessions: Array, current: string, workspacePath: string,
 *            storage: string, reason?: string}}
 *   reason: 'no-storage' no plugin disk state found / 'no-open-project' not a single active session
 */
function listSessions({ workspacePath = '', force = false, client = '', pluginRe = null, currentOnly = false, activeSessions = [] } = {}) {
  // This path's floor: the disk dir regex / disk markers / structured readers are all taken from it (default
  // falls back to the floor's own meta.pluginRe). No union of "all plugin products" is built in here — that
  // would let one floor scan another floor's disk state (see taskSync.test [8]).
  const mod = floorModuleOf(client);
  const re = pluginRe || (mod && mod.meta && mod.meta.pluginRe) || [];
  const storageMarks = (mod && mod.meta && mod.meta.pluginStorageMarks) || [];
  // The "current project" used for session ownership follows the reporter's newest real activity project,
  // not the one office manually recorded as "opened project" (the two drift apart when a new project is
  // opened directly inside the IDE).
  // Only this passed-in client's path counts: this listing belongs to one plugin floor, and another floor's
  // (another product's / the same product's CLI) activity in another project must not decide this floor's
  // "current project" — otherwise mine / current / fresh all get dragged off.
  const ws = freshestReporterWs(workspacePath, client);
  const now = Date.now();
  // The cache key must cover client / pluginRe / project, otherwise different plugin floors in the same
  // project, or the CLI/Plugin views, reuse the previous result (e.g. in A5 the plugin path read a previously
  // written window value and thought it was still in the global table).
  const activeKey = activeSessions.map((s) => `${s.sessionId}:${s.lastEventAt}`).sort().join(',');
  const key = `${client}@@${ws}@@${currentOnly ? 'current-only' : 'all'}@@${activeKey}@@${String(Array.isArray(re) ? re.map((r) => (r && r.source) || String(r)).join('|') : re instanceof RegExp ? re.source : String(re || ''))}`;
  if (!force && cache.value && cache.key === key && now - cache.at < TTL) return cache.value;

  // 9F has two independent stores (CLI ~/.copilot and the VS Code extension under globalStorage): the
  // plugin locator only finds the latter. When the client is Copilot, accept either, and read both below.
  const isCopilotClient = String(client || '').trim().toLowerCase() === 'copilot';
  const pluginStorage = findPluginStorage(re, storageMarks);
  const copilotRoots = isCopilotClient ? copilot.copilotStorages() : [];
  const storage = pluginStorage || copilotRoots[0] || '';
  if (!storage) {
    cache = {
      at: now,
      key,
      value: { ok: true, sessions: [], current: '', workspacePath: ws, storage: '', reason: 'no-storage' },
    };
    return cache.value;
  }

  /** session id -> ownership (project name / project path). Each project's own "current session" is recorded
   *  separately rather than as one global value — that way, with several projects, each project's active
   *  session gets its own reporter's live phase, and the main console follows the one selected in the
   *  dropdown instead of being overwritten by the global "last reporter". */
  const meta = new Map();
  const perProjectCurrent = new Map(); // project path -> the session id that project's current.json points at
  let currentId = '';
  // candidates passes "the real activity project + the project being queried"; the order is the priority (ws
  // first): a genie-history dir name may be truncated by the extension, so these two complete the half path
  // back into a full one (preferring a dir that really exists on disk), otherwise the project name shows as a
  // truncated tail and currentId comes up empty — see completeTruncatedWorkspace
  for (const p of pluginStoreOf(client).collectProjects(storage, [ws, workspacePath])) {
    const cur = readJson(path.join(p.dir, 'current.json')) || {};
    const cid = cur && cur.conversationId ? String(cur.conversationId) : '';
    if (cid) {
      perProjectCurrent.set(p.path, cid);
      // The globally unique "current session" still recognizes the one in the real activity project (ws), used
      // for default selection / highlighting
      if (p.path === ws) currentId = currentId || cid;
    }
    for (const id of readDir(path.join(p.dir, 'conversations'))) {
      if (id) {
        meta.set(id, { project: p.project, projectPath: p.path, guessed: p.guessed, ambiguous: p.ambiguous });
      }
    }
    if (cid && !meta.has(cid)) {
      meta.set(cid, { project: p.project, projectPath: p.path, guessed: p.guessed, ambiguous: p.ambiguous });
    }
  }

  // Real plugin disk state like GitHub Copilot uses the SQLite `session-store.db`, not `genie-history`:
  // merge those into the same session table here, otherwise 9F is forever swallowed by the old Tencent dir and
  // the UI never lights up.
  // The whole Copilot SQLite read + enrich lives in copilot.js's readCopilotSessions. 9F merges both forms,
  // so read every Copilot store (CLI + extension); other floors have no Copilot store to read.
  const sqliteRows = isCopilotClient ? copilot.readCopilotAllSessions({ ws, now }) : [];
  const sqliteById = new Map();
  for (const row of sqliteRows) {
    if (!row || !row.id) continue;
    sqliteById.set(row.id, row);
    meta.set(row.id, { project: row.project, projectPath: row.projectPath });
    if (row.projectPath && row.projectPath === ws) currentId = currentId || row.id;
  }

  // Fallback: newer plugin versions may not write genie-history, so a session shows up only in todos / the
  // message queue. Such sessions have no project ownership (project stays empty), but they are "the one that
  // is running", and leaving them out is worse.
  for (const name of readDir(path.join(storage, 'todos'))) {
    const id = name.replace(/\.json$/i, '');
    if (id && !meta.has(id)) meta.set(id, { project: '', projectPath: '' });
  }

  const activeById = new Map();
  for (const session of activeSessions) {
    const id = String(session && session.sessionId || '').trim();
    if (!id) continue;
    activeById.set(id, session);
    if (!meta.has(id)) {
      const projectPath = String(session.workspacePath || '');
      meta.set(id, {
        project: projectPath ? resolveProjectName(projectPath) || path.basename(projectPath) : '',
        projectPath,
      });
    }
  }

  const sessions = [];
  for (const [id, m] of meta) {
    const sqliteRow = sqliteById.get(id);
    const isProjectCurrent = id === (perProjectCurrent.get(m.projectPath) || '');
    const activeSession = activeById.get(id) || null;
    if (currentOnly && !isProjectCurrent && !activeSession) continue;
    // Copilot has no reporter hook, so readReporterActiveTask is always empty and the phase can only be
    // inferred (inferred):
    //   ① With VS Code's chat index saying "is this turn in flight" → trust it directly (running = thinking,
    //      finished = idle); that is the only side evidence that can see "a turn is in progress", see
    //      readCopilotChatIndex;
    //   ② Only without evidence (old version / db locked) fall back to updated_at's COPILOT_PHASE_MS
    //      (2 minutes) window.
    // hasPendingTurn (a turn with an empty assistant_response) is not used on its own — Copilot writes in
    // batches, so abandoned / cancelled turns also leave an empty response; an empty turn older than 2 minutes
    // is discarded, not running.
    // The active window is also judged by **this session's id**: without the session, any session running on
    // the same floor pins inWindow to true, and an idle session is then inferred as "thinking" (the same
    // missed filter as in sessionInfo). See [A2c].
    const reporterInWindow = readReporterActiveTask(m.projectPath, client, id);
    let info;
    if (sqliteRow) {
      // The whole enrich is already done in copilot.readCopilotSessions (phase / inFlight / doneAt / the live*
      // family); here we only layer the reporter's inWindow on top and unify the "current project" rule
      // (isProjectCurrent || projectPath===ws).
      info = { ...sqliteRow, inWindow: reporterInWindow || sqliteRow.inWindow };
      info.current = Boolean(isProjectCurrent || (sqliteRow.projectPath && sqliteRow.projectPath === ws));
    } else {
      info = sessionInfo(storage, id, {
        current: isProjectCurrent,
        now,
        workspacePath: m.projectPath,
        inWindow: reporterInWindow,
        client,
      });
    }
    if (!info.listed && !currentOnly && !activeSession) continue;
    if (currentOnly && isProjectCurrent) info.listed = true;
    if (activeSession) {
      info.listed = true;
      info.active = now - Number(activeSession.lastEventAt || 0) < IDLE_MS;
      info.live = true;
      info.lastUpdated = Math.max(Number(info.lastUpdated) || 0, Number(activeSession.lastEventAt) || 0);
    }
    sessions.push({
      ...info,
      project: m.project,
      projectPath: m.projectPath,
      // projectPath was reconstructed from a truncated genie-history dir name (a guess, not a
      // fact); when ambiguous is true several known projects shared the truncated prefix.
      projectPathGuessed: Boolean(m.guessed),
      projectPathAmbiguous: Boolean(m.ambiguous),
      mine: Boolean(ws) && m.projectPath === ws,
    });
  }
  sessions.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    return (b.lastUpdated || 0) - (a.lastUpdated || 0);
  });

  cache = {
    at: now,
    key,
    value: {
      ok: true,
      sessions,
      current: currentId,
      workspacePath: ws,
      storage,
      ...(sessions.length ? {} : { reason: 'no-open-project' }),
    },
  };
  return cache.value;
}

/* ============================================================== Session titles (from the old sessionTitle.js, moved in from floors.js) */

/**
 * Session title: give "which session this turn belongs to" a **session-level** name — every task with the
 * same session_id gets the same value, which is how several turns of one session are recognized as such
 * (one turn = one task row, and a session usually has several turns; each turn's own title differs, only the
 * session title is shared).
 *
 * Two sources, in order:
 *   1. Each floor's own session title (a summary the agent generated, different from the user's words):
 *        7F Kilo Code → SQLite session.title
 *        8F OpenCode  → SQLite session.title
 *        6F Qoder     → SQLite chat_session.session_title
 *      Those functions (kiloTitleOf / opencodeTitleOf / lingmaTitleOf) have moved into their own floor files
 *      (kilo.js / opencode.js / qoder.js); here the dispatch table is built dynamically from the floor registry.
 *   2. **Fallback (all floors)**: the user's words from that session's first turn.
 *      The title at the start of a session is the user's own words — 1F/2F/3F/4F/5F/9F have no summary column
 *      like source 1, but each of their turns' prompts is in tasks.title, so take **the earliest turn** with
 *      the same session_id (see sessionFirstPrompts()).
 *
 * Discipline: if any layer cannot find it, return an empty string; never bubble, never fabricate.
 */

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The dispatch table is **built lazily and cached**: any floor module exporting sessionTitle is registered by
 * its client. Building is deferred to the first call so no floor exports are read (for a sessionTitle that
 * does not exist) during module loading, avoiding Node's circular-dependency warning.
 * @returns {Array<{match: RegExp, fn: Function}>}
 */
let _routers = null;
function routers() {
  if (_routers) return _routers;
  const mods = /** @type {any[]} */ (Object.values(floorRegistry));
  _routers = mods
    .filter((mod) => typeof mod.sessionTitle === 'function' && mod.client)
    .map((mod) => ({ match: new RegExp('^' + escapeRegExp(mod.client) + '$', 'i'), fn: mod.sessionTitle }));
  return _routers;
}

/**
 * Placeholder title: Kilo writes "New session - <ISO timestamp>" by default when it opens a session (its own
 * placeholder, not a summary). Listing that as "has a title" adds a line of timestamp to the details — pure
 * noise — so treat it as absent.
 */
const PLACEHOLDER_TITLE = /^new session\b/i;

/**
 * Dispatch by client to the matching floor to look up the title. Not found / db missing / schema changed /
 * the result is a placeholder → empty string.
 * @param {string|null|undefined} sessionId
 * @param {string|null|undefined} client
 * @returns {string}
 */
function resolveSessionTitle(sessionId, client) {
  const sid = String(sessionId || '').trim();
  if (!sid) return '';
  const c = String(client || '').trim();
  if (!c) return '';
  for (const r of routers()) {
    if (!r.match.test(c)) continue;
    const title = r.fn(sid);
    return title && !PLACEHOLDER_TITLE.test(title) ? title : '';
  }
  return '';
}

/* ------------------------------ Fallback: the user's words from the session's first turn ------------------------------ */

/**
 * Old data (before the hook was fixed) stored the whole IDE-injected context block as the title —
 * `# Context from my IDE setup: ## Active file: …`. The rule matches the frontend's promptOf() and the hook
 * side's userRequestText: only when that context block really appears do we split on "My request:" and take
 * what follows.
 */
const IDE_INJECTED = [/^[ \t]*#{0,6}[ \t]*Context from my IDE setup\b/im, /^[ \t]*#{1,6}[ \t]*(?:Active file|Open tabs)\b/im];
const REQUEST_SPLIT = /^[ \t]*#{0,6}[ \t]*(?:My request|User request|Request|我的请求|用户请求)[ \t]*[:：][ \t]*$/im;

/** One tasks.title → the user's words (the first line, enough for a title; truncated when too long so the
 *  details row does not blow up) */
function userRequestOf(raw) {
  const s = String(raw || '').replace(/\r\n?/g, '\n');
  if (!s.trim()) return '';
  const text = IDE_INJECTED.some((re) => re.test(s)) ? (s.split(REQUEST_SPLIT).slice(1).join('\n') || '') : s;
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
  return first.length > 120 ? `${first.slice(0, 120)}…` : first;
}

/**
 * "What was said in the first turn" (the user's words) for a batch of sessions.
 *
 * One query only: group by session_id and take the turn with the smallest started_at — SQLite's rule is that
 * when `MIN()` is used together with a bare column, the bare column comes from the row MIN hit, so t.title is
 * the earliest turn's title.
 *
 * @param {import('better-sqlite3').Database|null} raw main db (read-only use)
 * @param {string[]} sessionIds
 * @returns {Map<string, string>} sessions not found are absent from the map (callers treat that as "none")
 */
function sessionFirstPrompts(raw, sessionIds) {
  const out = new Map();
  const ids = [...new Set(sessionIds.map((s) => String(s || '').trim()).filter(Boolean))];
  if (!raw || !ids.length) return out;
  // Do not stuff too many placeholders at once (SQLite's default limit is 999): query in chunks
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const holes = chunk.map(() => '?').join(',');
    try {
      const rows = /** @type {Array<{ sid: string, title: string }>} */ (
        raw
          .prepare(
            `SELECT tr.session_id AS sid, t.title AS title, MIN(t.started_at) AS started_at
               FROM tasks t
               JOIN task_runs tr ON tr.id = t.id
              WHERE tr.session_id IN (${holes})
              GROUP BY tr.session_id`
          )
          .all(...chunk)
      );
      for (const r of rows) {
        const title = userRequestOf(r.title);
        if (title) out.set(String(r.sid), title);
      }
    } catch {
      /* Schema changed / db locked: this chunk has none; callers treat it as "no session title" and fabricate
         nothing */
    }
  }
  return out;
}

module.exports = {
  resolveSessionTitle, // Session title: dispatched by client to the floor module (kilo/opencode/qoder's SQLite title)
  sessionFirstPrompts, // Fallback: each session's first-turn user words (taken from the tasks table, earliest turn)
  hasReporterState,
  reporterStateMeta,
  readReporterDone,   // Done marker (including Codex's closing summary): CLI floors light "task done" from it
  readReporterDones,  // Same, but fetches every session under that (project, client) at once — for the session-table scan
  listReporterSessions, // Floors whose sessions can only come from hooks (5F TraeCode / 1F CodeBuddy CLI)
  sessionModel,       // Which model this session uses (TraeCode reads globalStorage; others stay empty)
  listSessions,
  reporterMainPhase,
  reporterTruthPhase,
  reporterSnapshotPhase,
  freshestReporterWs,
  readReporterPhase, // The live phase on the main console (the invalidation-after-interrupt logic lives here; regression tests watch it directly)
};
