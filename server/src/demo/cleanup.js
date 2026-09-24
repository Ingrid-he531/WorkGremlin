'use strict';

const { DEMO_MEMBER_NAMES } = require('../mock/generator');
const config = require('../config');

/**
 * 演示残留清理（两类）：
 *   - purgeLeftovers：清混进【当前真实工程】的演示种子成员（旧版演示 project 叫 workgremlin，撞名真实工程 slug）。
 *     只清演示种子名单里的名字，且跳过已被 agentRoster 管理的"已定义 subagent"（如 coder —— 真实成员，由名册持续心跳，不能误删）。
 *   - purgeStragglers：清演示工程里名册不再定义的 subagent 残留（名册摘人靠进程内记账，重启即空，按名册口径对账最可靠）。
 */
function createDemoCleaner({ repo, bus }) {
  function purgeLeftovers(cur, agentRoster) {
    if (!cur.workspacePath || cur.demo || !cur.project || cur.project === config.DEMO_PROJECT) return 0;
    let n = 0;
    for (const m of repo.listMembers.all(cur.project) || []) {
      const name = m.name || String(m.id || '').split('@')[0];
      if (!DEMO_MEMBER_NAMES.has(name)) continue;
      if (agentRoster && agentRoster.isDefined(name)) continue;
      try {
        bus.removeMember({ project: cur.project, memberId: m.id });
        n += 1;
      } catch {
        /* 单个清不掉不影响别的 */
      }
    }
    if (n) console.log(`[workgremlin] 已清理 ${n} 个混进工程「${cur.projectName || cur.project}」的演示残留成员`);
    return n;
  }

  function purgeStragglers(agentRoster) {
    // 名册没起来时 isDefined 不可信（会把用户级小怪物一起误摘），宁可不做
    if (!agentRoster) return 0;
    const project = config.DEMO_PROJECT;
    let n = 0;
    for (const m of repo.listMembers.all(project) || []) {
      if (m.ephemeral) continue;
      if (String(m.role || '') !== 'subagent') continue;
      const name = m.name || String(m.id || '').split('@')[0];
      if (DEMO_MEMBER_NAMES.has(name)) continue;
      if (agentRoster.isDefined(name)) continue;
      try {
        bus.removeMember({ project, memberId: m.id });
        n += 1;
      } catch {
        /* 单个清不掉不影响别的 */
      }
    }
    if (n) console.log(`[workgremlin] 已清理 ${n} 个不属于演示工程的小怪物（名册残留）`);
    return n;
  }

  return { purgeLeftovers, purgeStragglers };
}

module.exports = { createDemoCleaner };
