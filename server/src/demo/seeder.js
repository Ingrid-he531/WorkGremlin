'use strict';

const log = require('../log');
const { seedDemoData } = require('../mock/generator');

/**
 * Demo data seeding: seeds only when the demo project has not a single message; existing data
 * is kept as-is (repeatedly entering and leaving the demo does not pile up more messages).
 */
function createDemoSeeder({ bus, repo }) {
  return {
    ensure(projectId) {
      const existing = repo.countMessages.get(projectId);
      if (existing && existing.c > 0) return;
      try {
        seedDemoData({
          bus,
          seed: 1,
          project: projectId,
          // Demo data is a standalone "demo project": binding it to a directory would make opening
          // that directory show these 8 mock members and suggest that "opening the project did not
          // take effect". The demo project is entered only through "switch to demo project".
          workspacePath: '',
        });
      } catch (err) {
        // A failed seed must not bring down the switch itself (the switch still happens, the room is just empty)
        log.warn('[workgremlin] 演示数据播种失败（不影响真实数据）：', err && err.message);
      }
    },
  };
}

module.exports = { createDemoSeeder };
