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

const { detectProducts } = require('../floors');
const { RECIPES } = require('./agents');

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

module.exports = { COUNCIL_FLOORS, listCouncilFloors, cliPathOf, isCouncilFloor };
