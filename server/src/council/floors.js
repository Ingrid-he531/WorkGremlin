'use strict';

/**
 * 议事厅能请哪几层 —— **白名单**，不是"装了就能来"。
 *
 * 为什么要有白名单：议事厅要请的是"能被命令行无头拉起、并且能关掉全部工具"的 agent。
 * 九个楼层里只有四层验过这两条（见 server/src/council/agents.js 每个配方上的说明）：
 *   1F CodeBuddy / 4F Claude Code —— `--tools ""`
 *   7F Kilo Code  / 8F OpenCode   —— 注一份 permission 全 deny 的配置
 * 其余楼层（2F WorkBuddy、3F Codex、5F TraeCode、6F Qoder、9F Copilot）本机没有可用的
 * 无头入口，或者关不掉工具 —— 那就**不出现在议事厅里**，而不是请进来再说。
 * 做不做得到"只读"，是能不能进这张白名单的**门槛**，不是可以事后补的加分项。
 *
 * 这里的 ready 只看**可执行文件在不在**（products 探测出的 cliInstallPath）。
 * 注意不能拿 `installed` 判：合并楼层（1F）装了 IDE 插件但没有 CLI 时 installed 也是 true，
 * 而议事厅要拉起的是一个**可执行文件**，插件形态跑不了。
 */

const { detectProducts } = require('../products');
const { RECIPES } = require('./agents');

/** 首版可用的四层。顺序 = 界面上出现的顺序 */
const COUNCIL_FLOORS = Object.freeze(['1F', '4F', '7F', '8F']);

/**
 * 每层现在的可用状态。给界面选人用。
 *
 * @param {{detect?: () => Array}} [deps] 探测函数可注入（测试用）
 * @returns {Array<{floorId:string,name:string,agent:string,ready:boolean,cliPath:string|null,reason:string}>}
 *   ready=false 时 reason 必须说清**为什么**（"没装"和"装了但不支持"要分得开）。
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
 * 取某一层的可执行文件路径（发起一场会时用）。
 * @returns {string|null} 没装 / 不支持都是 null —— 调用方据此拒绝这场会，别硬跑
 */
function cliPathOf(floorId, deps = {}) {
  const found = listCouncilFloors(deps).find((f) => f.floorId === floorId);
  return found && found.ready ? found.cliPath : null;
}

/** 这个楼层号在白名单里吗 */
const isCouncilFloor = (floorId) => COUNCIL_FLOORS.includes(String(floorId));

module.exports = { COUNCIL_FLOORS, listCouncilFloors, cliPathOf, isCouncilFloor };
