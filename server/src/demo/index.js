'use strict';

const { createDemoSeeder } = require('./seeder');
const { createDemoCleaner } = require('./cleanup');
const { createDemoTickerManager } = require('./ticker');
const config = require('../config');

/**
 * 演示逻辑聚合：把播种 / 残留清理 / 推进器起停收拢到 demo/ 目录，
 * 让 server/index.js 只负责接线。对外暴露两个生命周期参与点：
 *   - onSwitch(cur, agentRoster)：切工程钩子里调用（清真实工程残留 + 按演示与否起停推进器）
 *   - stop()：关闭钩子里调用（停推进器）
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
