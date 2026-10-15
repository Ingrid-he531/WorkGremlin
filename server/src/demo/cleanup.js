'use strict';

const log = require('../log');
const { DEMO_MEMBER_NAMES } = require('../mock/generator');
const config = require('../config');

/**
 * Demo leftover cleanup (two kinds):
 *   - purgeLeftovers: purge demo seed members that leaked into the [current real project]
 *     (the old demo project was named workgremlin, which collided with a real project slug).
 *     Only names on the demo seed list are purged, skipping "defined subagents" already managed
 *     by agentRoster (e.g. coder — a real member, kept alive by the roster, must not be removed).
 *   - purgeStragglers: purge subagent leftovers in the demo project that the roster no longer
 *     defines (roster removal is tracked in-process and wiped on restart, so reconciling by
 *     roster criteria is the most reliable way).
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
        /* failing to remove one does not affect the others */
      }
    }
    if (n) log.info(`[workgremlin] 已清理 ${n} 个混进工程「${cur.projectName || cur.project}」的演示残留成员`);
    return n;
  }

  function purgeStragglers(agentRoster) {
    // When the roster is not up yet, isDefined cannot be trusted (it would remove user-level
    // gremlins too) — better to do nothing at all
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
        /* failing to remove one does not affect the others */
      }
    }
    if (n) log.info(`[workgremlin] 已清理 ${n} 个不属于演示工程的小怪物（名册残留）`);
    return n;
  }

  return { purgeLeftovers, purgeStragglers };
}

module.exports = { createDemoCleaner };
