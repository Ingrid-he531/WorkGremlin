'use strict';

const { seedDemoData } = require('../mock/generator');

/**
 * 演示数据播种：演示工程一条消息都没有时才播，已有数据就沿用
 * （反复进出演示不会把消息越堆越多）。
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
          // 演示数据是一条独立的「演示工程」：绑到某个目录的话，打开这个目录就会看到这 8 个模拟成员，
          // 还以为"打开工程没生效"。演示工程只通过"切到演示工程"进入。
          workspacePath: '',
        });
      } catch (err) {
        // 播种失败不能拖垮切换本身（切工程照旧发生，只是屋里空着）
        console.warn('[workgremlin] 演示数据播种失败（不影响真实数据）：', err && err.message);
      }
    },
  };
}

module.exports = { createDemoSeeder };
