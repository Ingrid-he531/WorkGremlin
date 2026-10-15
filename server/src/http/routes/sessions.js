'use strict';

const express = require('express');
const { reporterMainPhase, freshestReporterWs, reporterStateMeta, readReporterDone } = require('../../sessions');
// 7F Kilo Code: Kilo has no hook state file, so phase / done markers are derived from its own SQLite
const { kiloMainPhase, readKiloDone, kiloInstrumented } = require('../../floorKilo');
// 8F OpenCode: **two paths** —— with the WorkGremlin plugin installed the true phase comes from the
// reporter state file; without it (or before it ever wrote) we fall back to deriving it by polling
// opencode.db. The shape differs from 7F, see the notes below.
const { opencodeMainPhase, readOpencodeDone, opencodeInstrumented } = require('../../floorOpencode');


/**
 * Done markers are normalized into the **reporter shape** (`{ at, title, fileCount, files, sessionId }`).
 *
 * Why translating is mandatory: each product's reader (`read*Done` in `kilo.js` / `opencode.js`)
 * returns the **session table** shape `{ doneAt, doneTitle, doneCount, doneFiles }` (that is what
 * `sessionRegistry` spreads out when building session rows), while the render layer reads the
 * **fast-polling** done marker through `fpDone.at` and `fpDone.sessionId` (see `fastDoneAt` /
 * `sameSession` in `IsoOfficeView.vue`). The two sets of field names do not line up: handing the session
 * table shape through unchanged leaves `fpDone.at` permanently undefined —— so the fast-polled
 * "task finished" never fires (the session table copy still does, hence the symptom "only lights up
 * after switching floors / waiting 10 seconds", easy to mistake for flakiness). This function is the
 * single conversion point between those two shapes.
 *
 * @param {{doneAt?:number,doneTitle?:string,doneCount?:number,doneFiles?:Array,doneCancelled?:boolean,doneSaid?:string}|null} done
 * @param {string} sessionId which session this marker belongs to (the render layer matches on it
 *   exactly, no cross-contamination)
 * @param {string} [workspacePath]
 * @returns {{at:number,title:string,fileCount:number,files:Array,sessionId:string,workspacePath:string,cancelled:boolean,said:string}|null}
 */
function toReporterDone(done, sessionId, workspacePath = '') {
  if (!done || !done.doneAt) return null;
  return {
    at: Number(done.doneAt) || 0,
    title: done.doneTitle || '',
    fileCount: Number(done.doneCount) || 0,
    files: Array.isArray(done.doneFiles) ? done.doneFiles : [],
    sessionId: String(sessionId || ''),
    workspacePath,
    // This round was cut short by the user (ESC / stop) → the main console lights up red "task
    // cancelled" instead of "task finished". The polling branch of 7F/8F (readKiloDone /
    // readOpencodeDone) relies on this to carry "cancelled" up from the store.
    cancelled: Boolean(done.doneCancelled),
    // The text this round spat out (the wrap-up summary) —— carried even when cancelled ("did not
    // finish" is not "produced nothing"); the render layer's `fpDone.said` is this value, and only
    // falls back to the sign-off copy / "no output" when absent.
    said: String(done.doneSaid || ''),
  };
}

/** Is the client in the request **this path** (identity is always the floor base name, compared for equality). */
function clientListHas(client, base) {
  return String(client || '').trim().toLowerCase() === String(base || '').toLowerCase();
}

/**
 * Sessions: the global active session table (grouped by floor).
 * The data source is each agent's own on-disk data and has nothing to do with the currently open
 * project —— the entry point for changing project is /api/v1/workspace; this only "lists / picks
 * which session".
 */
function createSessionsRouter({ workspace }) {
  const router = express.Router();

  router.get('/sessions', (req, res) => {
    const cur = workspace && workspace.current ? workspace.current() : {};
    res.json(
      snapshotSafe({
        workspacePath: cur.workspacePath || '',
        force: req.query.refresh === '1',
      })
    );
  });

  // Main console fast polling: returns the reporter hook's reported phase straight away (already
  // mapped to UI fields); the render layer pulls it every 1.5s, fresher than /sessions' 10s polling,
  // and dedicated to showing the main Agent console's "action" in real time.
  router.get('/reporter-phase', (req, res) => {
    const cur = workspace && workspace.current ? workspace.current() : {};
    // Take the phase per floor (client): Codex and CodeBuddy running in the same project must not
    // contaminate each other
    // client may be a **comma-separated list** —— a merged floor (1F CodeBuddy = CLI + Plugin) has to
    // recognize two reporting identities at once; any hit in the list counts as this floor (matching
    // is clientHit in sessions.js).
    const client = String(req.query.client || '').trim().toLowerCase();
    // Axis 2 (session): `?session=<session_id>` takes only that session's phase / done marker.
    // A floor can have several sessions open at once (one claude in two terminals / a mix of CLI and
    // plugin); omitting session keeps the old behavior —— "whoever is newest under the same client
    // wins", which cross-contaminates when there are multiple sessions.
    const session = String(req.query.session || '').trim();
    // Follow the freshest project the reporter is actually active in, rather than the one recorded
    // by manually "opening a project" in the office
    const ws = freshestReporterWs(cur.workspacePath || '', client, session);

    // ---- 7F Kilo Code: two paths, split by client ----
    //   · kilo-plugin (VS Code extension with the WorkGremlin plugin installed): **true phase first,
    //     polling as fallback** (same pattern as 8F OpenCode: the plugin writes phase / done markers
    //     into the reporter state file, which is reported truth, never flagged inferred, and it alone
    //     can give "awaiting permission" —— measured Kilo tool states likewise only have completed /
    //     error / running with no pending, so polling cannot derive it either).
    //   · kilo (CLI / TUI without the plugin): pure polling, derived from its own SQLite (always
    //     flagged inferred).
    // Both paths respond in exactly the same shape; the render layer cannot and need not tell them apart.
    if (clientListHas(client, 'kilo')) {
      const fallbackWs = ws || cur.workspacePath || '';
      // ---- Ask the true phase first: the state file written by the plugin (the same thing the
      // generic path reads) ----
      //
      // **Both kilo and kilo-plugin have to be asked**, not just the latter: when the plugin is
      // installed on the CLI / TUI, resolveClient() decides `kilo` from the environment variables
      // (only the extension's three variables mean kilo-plugin), and the CLI writes state files just
      // the same and has "awaiting permission" too. Recognizing only kilo-plugin would ignore the
      // true phase for the "CLI with plugin installed" combination entirely and show the polling
      // derived phase instead —— installing the plugin would make things worse.
      const rpTruth = reporterMainPhase(ws, client, session);
      const metaTruth = reporterStateMeta(ws, client, session);
      const useTruth = Boolean(rpTruth && rpTruth.phase);
      // ---- Fallback: derive it by polling kilo.db ----
      const rpPoll = useTruth ? null : kiloMainPhase(fallbackWs, session);
      const rp = rpTruth && rpTruth.phase ? rpTruth : rpPoll;
      const phaseSessionId = String((rp && rp.sessionId) || metaTruth.sessionId || session || '');

      // Same for the done marker: the plugin's copy carries the changed-file list, polling only has
      // a count —— prefer the plugin's when there is one.
      const doneTruth = readReporterDone(ws, client, phaseSessionId);
      const done = doneTruth && doneTruth.at
        ? doneTruth
        : toReporterDone(phaseSessionId ? readKiloDone(phaseSessionId, { title: '', fileCount: 0 }) : null, phaseSessionId, fallbackWs);
      // "Is it hooked up": the plugin is installed (state file exists) **or** this session is in the
      // store —— either one counts as true.
      const instrumented = Boolean(metaTruth.instrumented || kiloInstrumented(phaseSessionId));
      return res.json({
        ok: true,
        workspacePath: useTruth ? ws || fallbackWs : fallbackWs,
        instrumented,
        session: session || phaseSessionId,
        sessionId: phaseSessionId,
        done: done || null,
        ...(rp || { phase: null, action: '', target: '', context: [], tool: '', prompt: '', model: '' }),
      });
    }

    // ---- 8F OpenCode: **true phase first, polling as fallback** (differs from 7F, see below) ----
    // 7F short-circuits straight to kilo.js because Kilo has no hook state file at all, leaving
    // reporterMainPhase permanently empty for it. 8F is different: OpenCode **does** have a plugin
    // mechanism, and the WorkGremlin plugin writes phase / done markers into the reporter state file
    // —— that is **reported truth** (no inferred flag, no graying out in the UI), and it alone can
    // give "awaiting permission" (measured OpenCode tool states only have completed/error/running;
    // the permission signal exists in the in-memory event stream only and polling cannot derive it).
    // Hence the order: read the reporter the generic way first (hit when the plugin is installed) →
    // fall back to polling when nothing is there.
    // Both paths respond in exactly the same shape; the render layer cannot and need not tell them apart.
    if (clientListHas(client, 'opencode')) {
      const fallbackWs = ws || cur.workspacePath || '';
      // ---- True phase: the state file written by the plugin (the same thing the generic path below reads) ----
      const rpTruth = reporterMainPhase(ws, client, session);
      const metaTruth = reporterStateMeta(ws, client, session);
      // ---- Fallback: derive it by polling opencode.db ----
      const rpPoll = opencodeMainPhase(fallbackWs, session);
      const useTruth = Boolean(rpTruth && rpTruth.phase);
      const rp = useTruth ? rpTruth : rpPoll;
      // Which session this phase belongs to (the render layer uses it to confirm "is the session I
      // am looking at this one")
      const phaseSessionId = String((rp && rp.sessionId) || metaTruth.sessionId || session || '');

      // Same for the done marker: the plugin's copy carries the **changed-file list** (measured from
      // the data.files of session.step.ended events), polling only has a count —— prefer the plugin's
      // when there is one. Both are funneled through toReporterDone into the same shape (the plugin's
      // copy is already in reporter shape, so translating is idempotent).
      const doneTruth = readReporterDone(ws, client, phaseSessionId);
      const done = doneTruth && doneTruth.at
        ? doneTruth
        : toReporterDone(phaseSessionId ? readOpencodeDone(phaseSessionId, { title: '', fileCount: 0 }) : null, phaseSessionId, fallbackWs);
      // "Is it hooked up": the plugin is installed (state file exists) **or** this session is in the
      // store —— either one counts as true. The render layer uses it to tell "this product is not
      // running at all" from "running but idle right now".
      const instrumented = Boolean(metaTruth.instrumented || opencodeInstrumented(phaseSessionId));
      return res.json({
        ok: true,
        workspacePath: useTruth ? ws || fallbackWs : fallbackWs,
        instrumented,
        session: session || phaseSessionId,
        sessionId: phaseSessionId,
        done: done || null,
        ...(rp || { phase: null, action: '', target: '', context: [], tool: '', prompt: '', model: '' }),
      });
    }

    const rp = reporterMainPhase(ws, client, session);
    // Whether this project has a hook attached (attached but idle right now → the render layer shows
    // "standby" instead of guessing from file times)
    // Whether a hook is attached + which session that state file belongs to (the render layer uses it
    // to judge "is the session you are watching actually reporting")
    const meta = reporterStateMeta(ws, client, session);
    const instrumented = meta.instrumented;
    // The previous round's done marker (including Codex's wrap-up self-report): CLI floors light up
    // "task finished" thanks to it
    const done = readReporterDone(ws, client, session);
    // Carry the project path (workspacePath) this phase belongs to: the render layer only overlays
    // the live phase when "the selected session belongs to exactly this project", so an old session
    // (whose own project is no longer active) is not contaminated by another project's phase and
    // flashes "thinking" briefly. The session is echoed back too: callers may not pass it (old
    // behavior), so use this field to confirm whose phase it really is.
    const body = {
      ok: true,
      workspacePath: ws,
      instrumented,
      // Echo the session back when the request specified one; otherwise echo "the one actually read"
      // (meta.sessionId)
      session: session || meta.sessionId || '',
      sessionId: meta.sessionId,
      done,
    };
    res.json(
      rp
        ? { ...body, ...rp }
        : { ...body, phase: null, action: '', target: '', context: [] }
    );
  });

  return router;
}

/** A rescan failure must not take the service down either: return an empty table + reason */
function snapshotSafe(o) {
  try {
    const { snapshot } = require('../../sessionRegistry');
    return snapshot(o);
  } catch (e) {
    return {
      ok: true,
      floors: [],
      sessions: [],
      defaultFloor: '1F',
      workspacePath: o.workspacePath || '',
      timeoutMs: 60 * 60_000,
      updatedAt: Date.now(),
      reason: 'no-storage',
      error: String((e && e.message) || e),
    };
  }
}

module.exports = { createSessionsRouter };
