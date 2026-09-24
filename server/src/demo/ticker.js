'use strict';

const { createDemoTicker } = require('../mock/generator');

/**
 * 演示推进器随「当前工程是不是演示工程」起停。
 *   - 进演示：先按名册口径对账清残留（purgeStragglers），再按需播种，最后起推进器；
 *     没有推进器的话，60s 后所有成员都因心跳超时变 degraded，界面一片灰，而演示恰恰要看"活着"的样子。
 *   - 离开演示：停掉推进器，别对着演示工程空转（真实工程的成员由 hook / roster 驱动）。
 */
function createDemoTickerManager({ bus, repo, projectId, seeder, cleaner, getRoster }) {
  let demoTicker = null;

  function sync(on) {
    if (!on) {
      if (demoTicker) {
        demoTicker.stop();
        demoTicker = null;
      }
      return;
    }
    // 每次进演示都对一次账：名册摘人靠**进程内记账**，服务一重启那笔账就空了，
    // 只有按"名册自己的口径"对账才清得掉上一轮留下的成员（见 cleanup.purgeStragglers）。
    cleaner.purgeStragglers(getRoster());
    if (demoTicker) return;
    seeder.ensure(projectId);
    demoTicker = createDemoTicker({ bus, repo, project: projectId, seed: 1 });
    demoTicker.start();
  }

  function stop() {
    if (demoTicker) {
      demoTicker.stop();
      demoTicker = null;
    }
  }

  return { sync, stop };
}

module.exports = { createDemoTickerManager };
