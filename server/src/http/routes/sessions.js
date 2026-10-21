'use strict';

const express = require('express');
const { reporterMainPhase, freshestReporterWs, reporterStateMeta, readReporterDone } = require('../../sessions');
const { floorByAgent } = require('../../floors');
const { agentBase } = require('@workgremlin/shared');


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
    // cancelled" instead of "task finished". Polling floors carry this flag from their store reader.
    cancelled: Boolean(done.doneCancelled),
    // The text this round spat out (the wrap-up summary) —— carried even when cancelled ("did not
    // finish" is not "produced nothing"); the render layer's `fpDone.said` is this value, and only
    // falls back to the sign-off copy / "no output" when absent.
    said: String(done.doneSaid || ''),
  };
}

/** Resolve a floor by its base client name. Product-specific capabilities stay on the floor module. */
function floorForClient(client) {
  const base = agentBase(client);
  return base ? floorByAgent[base] || null : null;
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
    // Client identity is always the bare floor base name. Resolve it through agentBase() so a member-style
    // id can never accidentally become a separate phase identity.
    const client = agentBase(req.query.client || '');
    // Axis 2 (session): `?session=<session_id>` takes only that session's phase / done marker.
    // A floor can have several sessions open at once (one claude in two terminals / a mix of CLI and
    // plugin), so a missing session deliberately yields no phase instead of borrowing another session's.
    const session = String(req.query.session || '').trim();
    // Follow the freshest project the reporter is actually active in, rather than the one recorded
    // by manually "opening a project" in the office
    const ws = freshestReporterWs(cur.workspacePath || '', client, session);

    // Phase dispatch is floor-driven: sessions.js tries the floor's primary/reported source first and only
    // then its declared polling fallback. This route stays product-agnostic and normalizes the shared response
    // shape (phase, done marker, instrumentation, workspace/session identity).
    const floor = floorForClient(client);
    const fallbackWs = ws || cur.workspacePath || '';
    const rp = reporterMainPhase(ws, client, session);
    const meta = reporterStateMeta(ws, client, session);
    const phaseSessionId = String((rp && rp.sessionId) || meta.sessionId || session || '');

    // Prefer the reporter's done marker (it may carry the exact changed-file list); polling floors supply
    // their own store-shaped marker through the matching capability and the route converts it once here.
    const doneTruth = readReporterDone(ws, client, phaseSessionId);
    const done = doneTruth && doneTruth.at
      ? doneTruth
      : phaseSessionId && floor && typeof floor.readDoneFallback === 'function'
        ? toReporterDone(floor.readDoneFallback(phaseSessionId, { title: '', fileCount: 0 }), phaseSessionId, fallbackWs)
        : null;

    // A hook/plugin state file or a live store row both mean "this product is present"; the UI uses this to
    // distinguish "not running" from "running but idle".
    const instrumented = Boolean(
      meta.instrumented || (floor && typeof floor.instrumented === 'function' && floor.instrumented(phaseSessionId))
    );

    // A polling fallback carries inferred=true. Keep the requested workspace for reported phases and the
    // current workspace for inferred ones (the same workspace/session guard the renderer uses).
    const usingFallback = Boolean(rp && rp.inferred);
    const body = {
      ok: true,
      workspacePath: usingFallback ? fallbackWs : rp ? ws || fallbackWs : ws,
      instrumented,
      session: session || phaseSessionId,
      sessionId: phaseSessionId,
      done: done || null,
    };
    res.json(
      rp
        ? { ...body, ...rp }
        : { ...body, phase: null, action: '', target: '', context: [], tool: '', prompt: '', model: '' }
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
