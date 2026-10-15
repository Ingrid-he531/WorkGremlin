'use strict';

const { createDemoSeeder } = require('./seeder');
const { createDemoCleaner } = require('./cleanup');
const { createDemoTickerManager } = require('./ticker');
const config = require('../config');

/**
 * Demo logic aggregation: seeding / leftover cleanup / ticker start-and-stop are all gathered
 * under demo/, so server/index.js only has to wire things up. Two lifecycle participation
 * points are exposed:
 *   - onSwitch(cur, agentRoster): called from the project-switch hook (clear real-project
 *     leftovers + start/stop the ticker depending on whether it is the demo)
 *   - stop(): called from the close hook (stop the ticker)
 * @param {{ bus: any, repo: any, getRoster: () => any }} deps
 */
function createDemo({ bus, repo, getRoster }) {
  const seeder = createDemoSeeder({ bus, repo });
  const cleaner = createDemoCleaner({ repo, bus });
  const ticker = createDemoTickerManager({
    bus,
    repo,
    projectId: config.DEMO_PROJECT,
    seeder,
    cleaner,
    getRoster,
  });

  return {
    onSwitch(cur, agentRoster) {
      cleaner.purgeLeftovers(cur, agentRoster);
      ticker.sync(Boolean(cur.demo));
    },
    stop() {
      ticker.stop();
    },
  };
}

module.exports = { createDemo };
