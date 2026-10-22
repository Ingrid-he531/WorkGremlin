'use strict';

/**
 * Which floors the council room may invite — a **whitelist** of floors we have a verified recipe for,
 * not "installed means eligible".
 *
 * The council is **always read-only** (see agents.js): the participant gets read-type tools only, and
 * when no workspace is given it is pointed at a throwaway temp directory. So a floor qualifies when it
 * can be launched headlessly from the command line **and** narrowed to read-type tools. The seven below
 * qualify (see the notes on each recipe in server/src/council/agents.js; 6F Qoder is written from its
 * official docs but not yet verified on a real device):
 *   1F CodeBuddy / 4F Claude Code —— `--tools Read,Grep,Glob`
 *   2F Cline                      —— `--plan` (its own read-only plan mode)
 *   3F Codex                      —— `codex exec --sandbox read-only`
 *   6F Qoder                      —— headless `--print` (anything needing confirmation is denied)
 *   7F Kilo Code  / 8F OpenCode   —— a permission config that allows only read-type tools
 * Other floors are simply **not wired up yet** (no recipe written); that is a scope decision, not a
 * claim that they can never qualify. Floors we have no recipe for do not appear in the council room at
 * all, rather than being invited first and excused later.
 *
 * `ready` here looks only at "does the executable exist" (the cliInstallPath found by products
 * detection). Note that `installed` must not be used: for a merged floor (1F) that has the IDE
 * plugin but no CLI, `installed` is still true, while the council needs to launch an
 * **executable** — the plugin form cannot run.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULTS } = require('@workgremlin/shared');

const { detectProducts } = require('../floors');
const { RECIPES } = require('./agents');
const { runOnce } = require('./runner');

/** The floors available in the council. Order = the order they appear in the UI */
const COUNCIL_FLOORS = Object.freeze(['1F', '2F', '3F', '4F', '6F', '7F', '8F']);

/**
 * Current availability of each floor. Used by the UI to pick participants.
 *
 * @param {{detect?: () => Array}} [deps] The detection function can be injected (for tests)
 * @returns {Array<{floorId:string,name:string,agent:string,ready:boolean,cliPath:string|null,reason:string}>}
 *   When ready=false, reason must make clear **why** ("not installed" and "installed but
 *   unsupported" have to be distinguishable).
 */
function listCouncilFloors(deps = {}) {
  const detect = deps.detect || detectProducts;
  const products = detect() || [];
  const byId = new Map(products.map((p) => [String(p.id), p]));

  return COUNCIL_FLOORS.map((floorId) => {
    const recipe = RECIPES[floorId];
    const p = byId.get(floorId);
    const cliPath = (p && p.cliInstallPath) || '';
    let reason = '';
    if (!p) reason = '未探测到这个楼层';
    else if (!cliPath) reason = '没找到命令行可执行文件（只装了 IDE 插件的话，议事厅请不了）';
    return {
      floorId,
      name: (p && p.name) || recipe.name,
      agent: recipe.agent,
      ready: Boolean(cliPath),
      cliPath: cliPath || null,
      reason,
    };
  });
}

/**
 * Path of a floor's executable (used when starting a council run).
 * @returns {string|null} both "not installed" and "unsupported" are null — the caller refuses
 *   the run based on that instead of forcing it
 */
function cliPathOf(floorId, deps = {}) {
  const found = listCouncilFloors(deps).find((f) => f.floorId === floorId);
  return found && found.ready ? found.cliPath : null;
}

/** Is this floor id on the whitelist? */
const isCouncilFloor = (floorId) => COUNCIL_FLOORS.includes(String(floorId));

/* ---------------------------------- Preflight ("试麦") ---------------------------------- */

/**
 * One short, harmless sentence every product can answer. Multi-word on purpose: Cline's CLI treats a
 * single-word prompt as an unknown command. It asks for no tools and names no project, so a probe
 * never reads the user's code and never writes anything.
 */
const PROBE_PROMPT = 'This is a one-line health check. Reply with exactly one word: OK';

/** floorId + executable + model -> last probe. A different model must not reuse another one's verdict. */
const probeCache = new Map();

const probeKey = (floorId, cliPath, model) => `${floorId}|${cliPath || ''}|${model || ''}`;

/**
 * Ask each selected floor one tiny question, before a meeting is created.
 *
 * Why this exists: "the executable exists" and "this floor can speak" are different facts. On the dev
 * machine `kilo` is installed but returns 401, `codex` is installed but its model request reconnects
 * until it times out, and CodeBuddy's default model had been retired. All three showed up as ready
 * floors in the UI, and every meeting died on round 0. A probe turns that into a precise refusal
 * ("1F: model not supported") instead of a dead meeting.
 *
 * Results are cached so repeated creations do not spawn every CLI again: successes for `cacheMs`,
 * failures for the shorter `failureCacheMs`. A broken login may be fixed a minute later, and forcing a
 * full app restart just to clear a cached "no" is worse than one extra probe.
 *
 * @param {string[]} floorIds
 * @param {{models?:Object<string,string>, timeoutMs?:number, cacheMs?:number, failureCacheMs?:number,
 *          cwd?:string, now?:()=>number, cliPathOf?:(floorId:string)=>string|null,
 *          runTurn?:Function, mkdtemp?:(prefix:string)=>string, removeDir?:(dir:string)=>void}} [opts]
 * @returns {Promise<Array<{floorId:string, ok:boolean, model:string|null, cliPath:string|null,
 *   status:string, error:string|null, errorKind:string|null, durationMs:number, cached:boolean}>>}
 */
async function probeFloors(floorIds, opts = {}) {
  const ids = [...new Set((floorIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!ids.length) return [];

  const models = opts.models || {};
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULTS.COUNCIL_PREFLIGHT_TIMEOUT_MS;
  const cacheMs =
    opts.cacheMs != null && Number(opts.cacheMs) >= 0 ? Number(opts.cacheMs) : DEFAULTS.COUNCIL_PROBE_CACHE_MS;
  const failureCacheMs =
    opts.failureCacheMs != null && Number(opts.failureCacheMs) >= 0
      ? Number(opts.failureCacheMs)
      : DEFAULTS.COUNCIL_PROBE_FAILURE_CACHE_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const runTurn = typeof opts.runTurn === 'function' ? opts.runTurn : runOnce;
  const cliPathOfFn = typeof opts.cliPathOf === 'function' ? opts.cliPathOf : (floorId) => cliPathOf(floorId);
  const mkdtemp = typeof opts.mkdtemp === 'function' ? opts.mkdtemp : (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const removeDir = typeof opts.removeDir === 'function' ? opts.removeDir : (dir) => fs.rmSync(dir, { recursive: true, force: true });

  let cwd = opts.cwd || null;
  let ownsCwd = false;
  if (!cwd) {
    cwd = mkdtemp('wg-council-probe-');
    ownsCwd = true;
  }

  try {
    // Sequential on purpose. Measured 2026-10-22: OpenCode answered in 29s alone but 73s when it
    // was probed in parallel with Claude Code and Qoder — the private server each CLI starts
    // contends for the same CPU. A false "cannot speak" blocks a meeting that would have worked,
    // so accuracy beats the few seconds parallel probing saves on three seats.
    const results = [];
    for (const floorId of ids) {
      const recipe = RECIPES[floorId];
      const cliPath = recipe ? cliPathOfFn(floorId) : null;
      const model = models[floorId] ? String(models[floorId]).trim() : null;
      const key = probeKey(floorId, cliPath, model);

      const hit = probeCache.get(key);
      const ttl = hit && hit.result && hit.result.ok ? cacheMs : failureCacheMs;
      if (hit && ttl > 0 && now() - hit.at < ttl) {
        results.push({ ...hit.result, cached: true });
        continue;
      }

      if (!recipe) {
        const result = {
          floorId,
          ok: false,
          model,
          cliPath: null,
          status: 'failed',
          error: `议事厅不支持 ${floorId} 这一层`,
          errorKind: 'unknown',
          durationMs: 0,
          cached: false,
        };
        probeCache.set(key, { at: now(), result });
        results.push(result);
        continue;
      }
      if (!cliPath) {
        const result = {
          floorId,
          ok: false,
          model,
          cliPath: null,
          status: 'failed',
          error: '没找到命令行可执行文件（只装了 IDE 插件的话，议事厅请不了）',
          errorKind: 'spawn',
          durationMs: 0,
          cached: false,
        };
        probeCache.set(key, { at: now(), result });
        results.push(result);
        continue;
      }

      const inv = recipe.build({ bin: cliPath, prompt: PROBE_PROMPT, model });
      const turn = await runTurn({
        ...inv,
        cwd,
        timeoutMs,
        agent: recipe.agent,
      });
      const ok = turn.status === 'ok' && Boolean(String(turn.text || '').trim());
      const result = {
        floorId,
        ok,
        model,
        cliPath,
        status: turn.status,
        error: ok ? null : turn.error || (turn.status === 'unparsed' ? '输出解析不出内容' : '没有返回内容'),
        errorKind: ok ? null : turn.errorKind || 'unknown',
        durationMs: turn.durationMs || 0,
        cached: false,
      };
      probeCache.set(key, { at: now(), result });
      results.push(result);
    }
    return results;
  } finally {
    if (ownsCwd) {
      try {
        removeDir(cwd);
      } catch {
        /* a probe's temp dir is not worth failing the request over */
      }
    }
  }
}

/** Test/manual escape hatch: forget cached probe verdicts. */
function clearProbeCache() {
  probeCache.clear();
}

module.exports = {
  COUNCIL_FLOORS,
  listCouncilFloors,
  cliPathOf,
  isCouncilFloor,
  probeFloors,
  clearProbeCache,
  PROBE_PROMPT,
};
