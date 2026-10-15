'use strict';

/**
 * Which floors the council room may invite — a **whitelist**, not "installed means eligible".
 *
 * Why a whitelist: the council needs agents that "can be launched headlessly from the command
 * line and can have all their tools turned off". Only four of the nine floors were verified
 * for these two properties (see the notes on each recipe in server/src/council/agents.js):
 *   1F CodeBuddy / 4F Claude Code —— `--tools ""`
 *   7F Kilo Code  / 8F OpenCode   —— inject a permission config that denies everything
 * The remaining floors (2F WorkBuddy, 3F Codex, 5F TraeCode, 6F Qoder, 9F Copilot) either lack
 * a usable headless entry point on this machine or cannot have their tools disabled — so they
 * **do not appear in the council room**, rather than being invited first and excused later.
 * Whether read-only is achievable is the **threshold** for entering this whitelist, not a
 * bonus you can add afterwards.
 *
 * `ready` here looks only at "does the executable exist" (the cliInstallPath found by products
 * detection). Note that `installed` must not be used: for a merged floor (1F) that has the IDE
 * plugin but no CLI, `installed` is still true, while the council needs to launch an
 * **executable** — the plugin form cannot run.
 */

const { detectProducts } = require('../floors');
const { RECIPES } = require('./agents');

/** The four floors available in the first version. Order = the order they appear in the UI */
const COUNCIL_FLOORS = Object.freeze(['1F', '4F', '7F', '8F']);

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
